import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	SuggestModal,
	addIcon,
	TFile,
	normalizePath,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	annotationEditorExtension,
	applyEditorAnnotations,
	clearEditorAnnotations,
	resolveForEditor,
	selectionWatcher,
} from "./editor";
import { AdoptedNotesRegistry, newAdoptedNoteKey } from "./adopted";
import { AnnotationPopup, ConfirmModal, type AnnotationDraft, type PopupAnchor } from "./modal";
import { AnnotationTrashModal } from "./trashModal";
import { ANNOTATION_EVENTS, type AnnotationEventDetail } from "./events";
import {
	annotationMocPath,
	renderAnnotationMoc,
	renderAnnotationNote,
} from "./note";
import { refreshReadingViews, registerReadingAnnotations } from "./reading";
import { reanchorAnnotation } from "./reanchor";
import { annotationLabel, resolveAnnotations, visibleSegments } from "./resolve";
import { AnnotationSidebarView, ANNOTATION_SIDEBAR_VIEW, type AnnotationSidebarData } from "./sidebar";
import { AnnotationStore, annotationNow, newAnnotationId, type AnnotationTrashBatch } from "./store";
import { AnnotationTargetResolver } from "./target";
import { AnnotationTooltip } from "./tooltip";
import {
	bodyBounds,
	cleanQuoteMarkdown,
	crossesHeading,
	managedBounds,
	markdownToText,
	occurrencesBefore,
	sectionAt,
} from "./text";
import { MANAGED_CLOSE, MANAGED_OPEN, joinNote, splitNote } from "../sourceImport/merge";
import type {
	AnnotationColor,
	AnnotationSettings,
	AnnotationTarget,
	ResolvedAnnotation,
	SourceAnnotation,
} from "./types";
import { applyReadingAnnotations } from "./wrap";

const MIDAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4Z"/><path d="M8 14c0-2.2 1.5-4 3.5-4s3.5 1.8 3.5 4c0 1.9-1.4 3.2-3.2 3.2h-1.3v2.3"/></svg>`;

export interface AnnotationHost {
	app: App;
	plugin: Plugin;
	settings: AnnotationSettings;
	refreshParent: () => Promise<void>;
}

function cmOf(view: MarkdownView): EditorView | null {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	return cm ?? null;
}

function markdownViews(app: App): MarkdownView[] {
	return app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view)
		.filter((view): view is MarkdownView => view instanceof MarkdownView);
}

/** The active Markdown view, or the most recent one when the sidebar has focus. */
function activeMarkdownView(app: App): MarkdownView | null {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active) return active;
	const recent = app.workspace.getMostRecentLeaf();
	if (recent?.view instanceof MarkdownView) return recent.view;
	return markdownViews(app).find((view) => !!view.file) ?? null;
}

function isSourceFrontmatter(frontmatter: Record<string, unknown> | undefined): boolean {
	if (!frontmatter) return false;
	const rawType = frontmatter["document-type"];
	const type = typeof rawType === "string" ? rawType : "";
	// Annotation notes and MOCs also carry mas-up; only text-source notes are
	// annotatable. `mas-key` covers older hubs that predate document-type.
	return type.includes("text-source") || !!frontmatter["mas-key"] || !!frontmatter["mas-work"];
}

/**
 * Phase 1 annotation service: the sharded store, the creation/edit dialog,
 * highlight rendering, the annotation note and MOC, and deletion to the trash.
 */
export class AnnotationService {
	private readonly app: App;
	private readonly plugin: Plugin;
	private readonly settings: AnnotationSettings;
	private readonly host: AnnotationHost;
	private readonly store: AnnotationStore;
	private readonly adoption: AdoptedNotesRegistry;
	private readonly resolver: AnnotationTargetResolver;
	private readonly tooltip: AnnotationTooltip;
	private readonly pathAnnotations = new Map<string, SourceAnnotation[]>();
	private readonly verifyTimers = new Map<string, number>();
	private readonly autoTimers = new WeakMap<EditorView, number>();
	private tooltipHoverTimer = 0;
	private tooltipHideTimer = 0;
	private suppressAutoUntil = 0;
	private suppressAutoSignature = "";
	private dialogOpen = false;
	private disposed = false;
	private lastSidebarPath = "";

	constructor(host: AnnotationHost) {
		this.host = host;
		this.app = host.app;
		this.plugin = host.plugin;
		this.settings = host.settings;
		this.store = new AnnotationStore(host.app);
		this.adoption = new AdoptedNotesRegistry(host.app);
		this.resolver = new AnnotationTargetResolver(host.app, host.settings, this.adoption);
		this.tooltip = new AnnotationTooltip(this.app, {
			onEdit: (annotation, target, anchor) => {
				this.tooltip.hide();
				const rect = anchor.getBoundingClientRect();
				void this.openEditAnnotation(target, annotation, {
					left: rect.left,
					top: rect.top,
					bottom: rect.bottom,
				});
			},
			onDelete: (annotation, target) => {
				this.tooltip.hide();
				this.confirmDeleteAnnotation(target, annotation);
			},
			onOpenNote: (target) => {
				this.tooltip.hide();
				void this.openAnnotationNoteForTarget(target);
			},
			onEnter: () => this.cancelTooltipHide(),
			onLeave: () => this.scheduleTooltipHide(),
		});
	}

	async start(): Promise<void> {
		await this.store.load();
		await this.adoption.load();
		try {
			await this.adoption.scanKnownNotes();
		} catch (error) {
			console.error("[midad-arabic-sources] adoption scan", error);
		}
		const migrated = await this.store.migrateSpike((workKey, notePath) => this.migrationMeta(workKey, notePath));
		try {
			await this.syncStartup(migrated);
		} catch (error) {
			console.error("[midad-arabic-sources] annotation startup", error);
		}
		this.plugin.registerEditorExtension([
			annotationEditorExtension,
			selectionWatcher((view) => this.onEditorSelection(view)),
		]);
		registerReadingAnnotations(this.plugin, (path) => this.pathAnnotations.get(normalizePath(path)) ?? null);
		addIcon("midad", MIDAD_ICON);
		this.plugin.registerView(
			ANNOTATION_SIDEBAR_VIEW,
			(leaf) => new AnnotationSidebarView(leaf, this)
		);
		this.plugin.addRibbonIcon("midad", "Open Midad sidebar", () => { void this.openSidebar(); });
		this.registerCommands();
		this.registerEvents();
		window.setTimeout(() => {
			void this.refreshViews();
			refreshReadingViews(this.app);
		}, 900);
		window.setTimeout(() => { void this.purgeTrash(); }, 4000);
		this.plugin.registerInterval(window.setInterval(() => { void this.purgeTrash(); }, 24 * 60 * 60 * 1000));
	}

	dispose(): void {
		this.disposed = true;
		this.cancelTooltipTimers();
		this.tooltip.hide();
		for (const timer of this.verifyTimers.values()) window.clearTimeout(timer);
		this.verifyTimers.clear();
	}

	private async migrationMeta(
		workKey: string,
		notePath: string
	): Promise<{ title: string; dir: string; note: string } | null> {
		const meta = await this.resolver.metaForWork(workKey, notePath);
		if (!meta) return null;
		const folder = this.settings.annotationNoteFolder.trim() ||
			`${this.settings.sourceImportRoot.trim() || "_7 Sources"}/Notes`;
		const note = normalizePath(`${folder}/${meta.dir.replace(/[\\/:*?"<>|#^]/g, "-").trim() || "Annotations"} - Annotations.md`);
		return { ...meta, note };
	}

	private async syncStartup(migrated: boolean): Promise<void> {
		for (const key of Object.keys(this.store.getIndex().works)) {
			const work = await this.store.getWork(key);
			if (!work) continue;
			const exists = work.note
				? await this.app.vault.adapter.exists(normalizePath(work.note))
				: false;
			if (migrated || !work.note || !exists) {
				await renderAnnotationNote(this.app, this.store, this.settings, key);
			}
		}
		await renderAnnotationMoc(this.app, this.store, this.settings);
		await this.refreshParent();
	}

	private async adoptNote(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		if (this.adoption.has(file.path)) {
			new Notice("This note is already in the annotation system.");
			return;
		}
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const rawType = frontmatter?.["document-type"];
		const type = typeof rawType === "string" ? rawType : "";
		if (type.includes("source-annotation") || isSourceFrontmatter(frontmatter)) {
			new Notice("This note is already managed by Midad.");
			return;
		}
		const key = newAdoptedNoteKey();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm["mas-work"] = key;
			if (!fm["mas-unit"]) fm["mas-unit"] = "note";
			if (!fm["title"]) fm["title"] = file.basename;
		});
		const text = await this.app.vault.adapter.read(normalizePath(file.path));
		if (!managedBounds(text)) {
			const prior = splitNote(text);
			const body = prior.body.replace(/^\n+|\n+$/g, "");
			if (!body.trim()) {
				new Notice("This note has no body to adopt.");
				return;
			}
			const wrapped = `${MANAGED_OPEN}\n${body}\n${MANAGED_CLOSE}\n`;
			await this.app.vault.adapter.write(
				normalizePath(file.path),
				joinNote(prior.frontmatter ?? "", wrapped)
			);
		}
		this.resolver.invalidate();
		new Notice("Note adopted. Select text to annotate it.");
		window.setTimeout(() => {
			void this.refreshViews();
			refreshReadingViews(this.app);
		}, 150);
	}

	private async onAdoptedNoteRenamed(file: TFile, oldPath: string): Promise<void> {
		const changed = await this.adoption.rename(oldPath, file.path);
		const stored = this.store.findTarget(oldPath);
		if (stored) {
			const work = await this.store.getWork(stored.workKey);
			if (work?.sourceStatus === "adopted") {
				const oldBase = oldPath.split("/").pop()?.replace(/\.md$/i, "") ?? work.dir;
				const nextDir = work.dir === oldBase ? file.basename : work.dir;
				await this.store.updatePaths(
					stored.workKey,
					nextDir,
					work.note,
					new Map([[stored.unitKey, normalizePath(file.path)]])
				);
				await this.syncArtifacts(stored.workKey);
			}
		}
		if (changed || stored) await this.refreshViews();
	}

	private async onAdoptedNoteDeleted(path: string): Promise<void> {
		const stored = this.store.findTarget(path);
		if (!stored) return;
		const work = await this.store.getWork(stored.workKey);
		if (work?.sourceStatus !== "adopted") return;
		await this.setSourceStatus(stored.workKey, "removed");
	}

	private registerCommands(): void {
		this.plugin.addCommand({
			id: "annotate-selection",
			name: "Annotate the selected text",
			editorCheckCallback: (checking, editor, view) => {
				const draft = this.draftFromEditor(editor, view.file);
				if (!draft) return false;
				if (!checking) void this.openAnnotate(editor, view.file);
				return true;
			},
		});

		this.plugin.addCommand({
			id: "edit-annotation-at-cursor",
			name: "Edit annotation",
			editorCheckCallback: (checking, editor, view) => {
				if (!view.file || !this.store.findTarget(view.file.path)) return false;
				if (!checking) void this.openEditAtCursor(editor, view.file);
				return true;
			},
		});

		this.plugin.addCommand({
			id: "delete-annotation-at-cursor",
			name: "Delete annotation",
			editorCheckCallback: (checking, editor, view) => {
				if (!view.file || !this.store.findTarget(view.file.path)) return false;
				if (!checking) void this.confirmDeleteAtCursor(editor, view.file);
				return true;
			},
		});

		this.plugin.addCommand({
			id: "reanchor-orphaned-annotation",
			name: "Re-anchor orphaned annotation…",
			editorCheckCallback: (checking, editor, view) => {
				if (!view.file || !this.store.findTarget(view.file.path)) return false;
				const draft = this.draftFromEditor(editor, view.file);
				if (!draft) return false;
				if (!checking) void this.reanchorOrphaned(view.file, draft);
				return true;
			},
		});

		this.plugin.addCommand({
			id: "delete-source-annotations",
			name: "Delete annotations for this source…",
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) {
					new Notice("No active note.");
					return;
				}
				await this.confirmTrashWork(view.file.path);
			},
		});

		this.plugin.addCommand({
			id: "open-source-annotation-note",
			name: "Open source annotations",
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return;
				const target = await this.targetForPath(view.file.path);
				if (!target) {
					new Notice("This note is not part of an imported source.");
					return;
				}
				await this.openAnnotationNoteForTarget(target);
			},
		});

		this.plugin.addCommand({
			id: "open-annotation-trash",
			name: "Open annotation trash",
			callback: () => {
				new AnnotationTrashModal(this.app, this).open();
			},
		});

		this.plugin.addCommand({
			id: "open-source-annotation-moc",
			name: "Open source annotations",
			callback: async () => {
				const path = await renderAnnotationMoc(this.app, this.store, this.settings);
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
			},
		});

		this.plugin.addCommand({
			id: "open-annotation-sidebar",
			name: "Open Midad sidebar",
			callback: () => { void this.openSidebar(); },
		});

		this.plugin.addCommand({
			id: "copy-source-with-annotations",
			name: "Copy source with annotations",
			callback: async () => { await this.copySourceWithAnnotations(); },
		});

		this.plugin.addCommand({
			id: "adopt-note-for-annotations",
			name: "Adopt note for annotations",
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file) await this.adoptNote(view.file);
				else new Notice("Open a Markdown note first.");
			},
		});

		this.plugin.addCommand({
			id: "reload-annotations",
			name: "Reload annotations",
			callback: async () => {
				this.resolver.invalidate();
				await this.store.load();
				await this.refreshViews();
				refreshReadingViews(this.app);
				new Notice("Annotations reloaded.");
			},
		});

		this.plugin.addCommand({
			id: "annotation-status",
			name: "Show annotation status",
			callback: () => {
				const works = Object.values(this.store.getIndex().works);
				const count = works.reduce((sum, work) => sum + work.count, 0);
				new Notice(`${works.length} annotated source(s), ${count} annotation(s).`);
			},
		});
	}

	private registerEvents(): void {
		this.plugin.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (this.adoption.has(file.path)) return;
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const rawType = frontmatter?.["document-type"];
			const type = typeof rawType === "string" ? rawType : "";
			if (type.includes("source-annotation") || isSourceFrontmatter(frontmatter)) return;
			menu.addItem((item) => item
				.setTitle("Adopt note for annotations")
				.setIcon("highlighter")
				.onClick(() => { void this.adoptNote(file); }));
		}));
		this.plugin.registerEvent(this.app.vault.on("create", (file) => {
			if (!(file instanceof TFile)) return;
			void this.adoption.registerNewFile(file).then((changed) => {
				if (changed) void this.refreshViews();
			});
		}));
		this.plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			void this.onAdoptedNoteRenamed(file, oldPath);
		}));
		this.plugin.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile) void this.onAdoptedNoteDeleted(file.path);
		}));
		this.plugin.registerDomEvent(document, "keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
				this.suppressAutoUntil = Date.now() + 1500;
			}
		}, true);
		this.plugin.registerDomEvent(document, "copy", () => {
			this.suppressAutoUntil = Date.now() + 1500;
		});

		this.plugin.registerDomEvent(document, ANNOTATION_EVENTS.hover, (event) => {
			this.onAnnotationHover(event);
		});
		this.plugin.registerDomEvent(document, ANNOTATION_EVENTS.leave, () => {
			this.scheduleTooltipHide();
		});
		this.plugin.registerDomEvent(document, ANNOTATION_EVENTS.open, (event) => {
			this.onAnnotationOpen(event);
		});

		this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			window.setTimeout(() => {
				if (!this.disposed) void this.refreshViews();
			}, 150);
		}));

		this.plugin.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
			this.suppressAutoUntil = Date.now() + 2000;
			const draft = this.draftFromEditor(editor, view.file);
			if (draft) {
				menu.addItem((item) => item
					.setTitle("Annotate selection")
					.setIcon("highlighter")
					.onClick(() => { void this.openAnnotate(editor, view.file); }));
			}
			const file = view.file;
			if (!file || !this.store.findTarget(file.path)) return;
			// Show the actions on every annotated source note; the click handler
			// reports when the cursor is not actually inside a highlight.
			menu.addItem((item) => item
				.setTitle("Edit annotation")
				.setIcon("pencil")
				.onClick(() => { void this.openEditAtCursor(editor, file); }));
			menu.addItem((item) => item
				.setTitle("Delete annotation")
				.setIcon("trash-2")
				.onClick(() => { void this.confirmDeleteAtCursor(editor, file); }));
		}));

		this.plugin.registerEvent(this.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile)) return;
			if (!this.store.findTarget(file.path)) return;
			this.scheduleVerify(file.path);
		}));
	}

	private scheduleVerify(path: string): void {
		if (this.disposed) return;
		const existing = this.verifyTimers.get(path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.verifyTimers.delete(path);
			void this.verify(path);
		}, 1800);
		this.verifyTimers.set(path, timer);
	}

	private async verify(path: string): Promise<void> {
		const stored = this.store.findTarget(path);
		if (!stored) return;
		const work = await this.store.getWork(stored.workKey);
		if (!work) return;
		const target: AnnotationTarget = {
			workKey: stored.workKey,
			unitKey: stored.unitKey,
			notePath: normalizePath(path),
			workTitle: work.title,
			workDir: work.dir,
			sourceStatus: work.sourceStatus,
		};
		const unit = await this.store.getUnit(target.workKey, target.unitKey);
		if (!unit) return;
		let text = "";
		try {
			text = await this.app.vault.adapter.read(normalizePath(path));
		} catch {
			return;
		}
		const bounds = managedBounds(text) ?? (work.sourceStatus === "adopted" ? bodyBounds(text) : null);
		if (!bounds) return;
		let changed = false;
		let artifactChanged = false;
		const annotations = unit.annotations.map((annotation) => {
			// The source note on disk is raw markdown: use the raw quote first,
			// then fall back to the rendered-text quote for older/migrated records.
			const match = reanchorAnnotation(text, annotation, {
				bodyStart: bounds.bodyStart,
				contentStart: bounds.contentStart,
				contentEnd: bounds.contentEnd,
			});
			if (!match) {
				if (annotation.anchorStatus !== "orphaned") {
					changed = true;
					artifactChanged = true;
					return { ...annotation, anchorStatus: "orphaned" as const, anchored: annotationNow() };
				}
				return annotation;
			}
			const quote = text.slice(match.start, match.end);
			const quoteText = markdownToText(quote);
			const quoteMarkdown = cleanQuoteMarkdown(quote);
			const prefix = text.slice(Math.max(bounds.contentStart, match.start - 80), match.start);
			const suffix = text.slice(match.end, Math.min(bounds.contentEnd, match.end + 80));
			const section = sectionAt(text, match.start);
			const ordinal = occurrencesBefore(text, match.start, quote);
			const position = {
				start: match.start - bounds.bodyStart,
				end: match.end - bounds.bodyStart,
			};
			const segments = visibleSegments(text, match.start, match.end)
				.map((range) => [range.start - bounds.bodyStart, range.end - bounds.bodyStart] as [number, number]);
			const quoteChanged = quote !== annotation.quote;
			const previousQuotes = quoteChanged
				? [...(annotation.previousQuotes ?? []), annotation.quote].filter(Boolean).slice(-5)
				: annotation.previousQuotes ?? [];
			const next: SourceAnnotation = {
				...annotation,
				quote,
				quoteText,
				quoteMarkdown,
				prefix,
				suffix,
				section,
				ordinal,
				position,
				segments,
				anchored: annotationNow(),
				anchorStatus: "ok",
				quoteChanged,
				previousQuotes,
			};
			const artifactChangedNow =
				quoteChanged ||
				section !== annotation.section ||
				annotation.anchorStatus !== "ok" ||
				quoteMarkdown !== annotation.quoteMarkdown;
			if (artifactChangedNow) artifactChanged = true;
			if (
				artifactChangedNow ||
				quote !== annotation.quote ||
				quoteText !== annotation.quoteText ||
				prefix !== annotation.prefix ||
				suffix !== annotation.suffix ||
				ordinal !== annotation.ordinal ||
				!annotation.position ||
				annotation.position.start !== position.start ||
				annotation.position.end !== position.end ||
				JSON.stringify(annotation.segments) !== JSON.stringify(segments) ||
				annotation.quoteChanged !== quoteChanged
			) {
				changed = true;
			}
			return next;
		});
		if (!changed) return;
		await this.store.saveUnit(target, annotations);
		if (artifactChanged) await this.syncArtifacts(target.workKey);
		await this.refreshViews();
	}

	private anyModalOpen(): boolean {
		const container = document.querySelector(".modal-container");
		return !!container && !!container.querySelector(".modal");
	}

	private cancelTooltipHide(): void {
		if (this.tooltipHideTimer) {
			window.clearTimeout(this.tooltipHideTimer);
			this.tooltipHideTimer = 0;
		}
	}

	private cancelTooltipTimers(): void {
		if (this.tooltipHoverTimer) {
			window.clearTimeout(this.tooltipHoverTimer);
			this.tooltipHoverTimer = 0;
		}
		this.cancelTooltipHide();
	}

	private scheduleTooltipShow(anchor: HTMLElement, ids: string[]): void {
		this.cancelTooltipTimers();
		this.tooltipHoverTimer = window.setTimeout(() => {
			this.tooltipHoverTimer = 0;
			void this.showTooltip(anchor, ids);
		}, 220);
	}

	private scheduleTooltipHide(): void {
		this.cancelTooltipTimers();
		this.tooltipHideTimer = window.setTimeout(() => {
			this.tooltipHideTimer = 0;
			this.tooltip.hide();
		}, 260);
	}

	private onAnnotationHover(event: CustomEvent<AnnotationEventDetail>): void {
		if (this.dialogOpen || this.anyModalOpen()) return;
		const anchor = event.target as HTMLElement | null;
		const ids = event.detail?.ids ?? [];
		if (!anchor || !ids.length) return;
		this.scheduleTooltipShow(anchor, ids);
	}

	private onAnnotationOpen(event: CustomEvent<AnnotationEventDetail>): void {
		if (this.dialogOpen || this.anyModalOpen()) return;
		const anchor = event.target as HTMLElement | null;
		const ids = event.detail?.ids ?? [];
		if (!anchor || !ids.length) return;
		this.cancelTooltipTimers();
		void this.showTooltip(anchor, ids);
	}

	private async showTooltip(anchor: HTMLElement, ids: string[]): Promise<void> {
		if (this.dialogOpen || this.anyModalOpen()) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		const target = await this.targetForPath(view.file.path);
		if (!target) return;
		const annotations = (await this.annotationsFor(target)).filter((annotation) => ids.includes(annotation.id));
		if (!annotations.length) return;
		await this.tooltip.show(anchor, annotations, target);
	}

	private onEditorSelection(view: EditorView): void {
		if (this.disposed) return;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!active?.file || cmOf(active) !== view) return;
		const existing = this.autoTimers.get(view);
		if (existing) {
			window.clearTimeout(existing);
			this.autoTimers.delete(view);
		}
		const selection = view.state.selection.main;
		if (selection.from === selection.to) {
			this.suppressAutoSignature = "";
			return;
		}
		if (!this.settings.annotateOnSelection) return;
		if (this.dialogOpen || this.anyModalOpen()) return;
		if (Date.now() < this.suppressAutoUntil) return;
		const signature = `${selection.from}:${selection.to}`;
		if (this.suppressAutoSignature && this.suppressAutoSignature !== signature) {
			this.suppressAutoSignature = "";
		}
		if (this.suppressAutoSignature === signature) return;
		const from = selection.from;
		const to = selection.to;
		const timer = window.setTimeout(() => {
			this.autoTimers.delete(view);
			if (this.disposed || !this.settings.annotateOnSelection) return;
			if (this.dialogOpen || this.anyModalOpen()) return;
			if (Date.now() < this.suppressAutoUntil) return;
			const current = view.state.selection.main;
			if (current.from !== from || current.to !== to) return;
			const activeNow = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeNow?.file || cmOf(activeNow) !== view) return;
			const draft = this.draftFromEditor(activeNow.editor, activeNow.file);
			if (!draft) return;
			void this.openAnnotate(activeNow.editor, activeNow.file, signature);
		}, 420);
		this.autoTimers.set(view, timer);
	}

	private draftFromEditor(editor: Editor, file: TFile | null): AnnotationDraft | null {
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
		const adopted = !!frontmatter?.["mas-work"] || this.adoption.has(file.path);
		if (!adopted && !isSourceFrontmatter(frontmatter)) return null;
		const value = editor.getValue();
		const bounds = managedBounds(value) ?? (adopted ? bodyBounds(value) : null);
		if (!bounds) return null;
		let from = editor.posToOffset(editor.getCursor("from"));
		let to = editor.posToOffset(editor.getCursor("to"));
		if (from > to) [from, to] = [to, from];
		if (from < bounds.contentStart || to > bounds.contentEnd) return null;
		while (from < to && /\s/.test(value.charAt(from))) from++;
		while (to > from && /\s/.test(value.charAt(to - 1))) to--;
		if (from >= to) return null;
		if (crossesHeading(value, from, to)) return null;
		const raw = value.slice(from, to);
		const quoteText = markdownToText(raw);
		if (!quoteText.trim()) return null;
		const segments = visibleSegments(value, from, to)
			.map((range) => [range.start - bounds.bodyStart, range.end - bounds.bodyStart] as [number, number]);
		return {
			quote: raw,
			quoteText,
			quoteMarkdown: cleanQuoteMarkdown(raw),
			prefix: value.slice(Math.max(bounds.contentStart, from - 80), from),
			suffix: value.slice(to, Math.min(bounds.contentEnd, to + 80)),
			section: sectionAt(value, from),
			ordinal: occurrencesBefore(value, from, raw),
			position: { start: from - bounds.bodyStart, end: to - bounds.bodyStart },
			segments,
		};
	}

	private selectionSignatureForEditor(editor: Editor): string {
		const cm = (editor as unknown as { cm?: EditorView }).cm;
		if (cm) {
			const selection = cm.state.selection.main;
			return `${selection.from}:${selection.to}`;
		}
		const from = editor.posToOffset(editor.getCursor("from"));
		const to = editor.posToOffset(editor.getCursor("to"));
		return `${from}:${to}`;
	}

	private anchorForEditor(editor: Editor): PopupAnchor | undefined {
		const cm = (editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return undefined;
		const to = editor.posToOffset(editor.getCursor("to"));
		const coords = cm.coordsAtPos(to);
		if (coords) return { left: coords.left, top: coords.top, bottom: coords.bottom };
		const rect = cm.dom.getBoundingClientRect();
		return { left: rect.left + 20, top: rect.top + 20, bottom: rect.top + 40 };
	}

	private async openAnnotate(editor: Editor, file: TFile | null, autoSignature?: string): Promise<void> {
		if (!file) return;
		const draft = this.draftFromEditor(editor, file);
		if (!draft) {
			new Notice("Select text inside a source note’s managed region.");
			return;
		}
		const signature = autoSignature ?? this.selectionSignatureForEditor(editor);
		const target = await this.targetForPath(file.path);
		if (!target) {
			new Notice("Could not identify the source work. Re-render the source and try again.");
			return;
		}
		const bounds = managedBounds(editor.getValue());
		if (bounds) {
			const expectedFrom = bounds.bodyStart + draft.position.start;
			const expectedTo = bounds.bodyStart + draft.position.end;
			if (
				editor.posToOffset(editor.getCursor("from")) !== expectedFrom ||
				editor.posToOffset(editor.getCursor("to")) !== expectedTo
			) {
				return;
			}
		}
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const anchor = this.anchorForEditor(editor);
		this.cancelTooltipTimers();
		this.tooltip.hide();
		this.dialogOpen = true;
		new AnnotationPopup(this.app, {
			draft,
			defaultColor: this.settings.annotationDefaultColor,
			onSubmit: async (color, comment) => {
				await this.createAnnotation(target, draft, color, comment);
				this.suppressAutoSignature = signature;
				editor.focus();
				editor.setSelection(from, to);
			},
			onCancel: (reason) => {
				this.suppressAutoSignature = signature;
				if (reason !== "outside") {
					editor.focus();
					editor.setSelection(from, to);
				}
			},
			onClosed: () => {
				this.dialogOpen = false;
			},
		}).open(anchor);
	}

	private async createAnnotation(
		target: AnnotationTarget,
		draft: AnnotationDraft,
		color: AnnotationColor,
		comment: string
	): Promise<void> {
		const annotations = await this.annotationsFor(target);
		const now = annotationNow();
		annotations.push({
			id: newAnnotationId(),
			color,
			quote: draft.quote,
			quoteText: draft.quoteText,
			quoteMarkdown: draft.quoteMarkdown,
			prefix: draft.prefix,
			suffix: draft.suffix,
			comment: comment || undefined,
			ordinal: draft.ordinal,
			position: draft.position,
			segments: draft.segments,
			section: draft.section,
			created: now,
			modified: now,
			anchored: now,
			anchorStatus: "ok",
			quoteChanged: false,
			previousQuotes: [],
			tags: [],
		});
		await this.store.saveUnit(target, annotations);
		this.pathAnnotations.set(normalizePath(target.notePath), annotations);
		await this.syncArtifacts(target.workKey);
		await this.refreshViews();
		new Notice("Annotation added.");
	}

	private async reanchorOrphaned(file: TFile, draft: AnnotationDraft): Promise<void> {
		const target = await this.targetForPath(file.path);
		if (!target) {
			new Notice("Could not identify the source work.");
			return;
		}
		const annotations = await this.annotationsFor(target);
		const orphans = annotations.filter((annotation) => annotation.anchorStatus === "orphaned");
		if (!orphans.length) {
			new Notice("There are no unanchored annotations for this source.");
			return;
		}
		const apply = async (orphan: SourceAnnotation): Promise<void> => {
			const now = annotationNow();
			const quoteChanged = draft.quote !== orphan.quote;
			const current = await this.annotationsFor(target);
			const updated = current.map((annotation) => annotation.id === orphan.id
				? {
					...annotation,
					quote: draft.quote,
					quoteText: draft.quoteText,
					quoteMarkdown: draft.quoteMarkdown,
					prefix: draft.prefix,
					suffix: draft.suffix,
					section: draft.section,
					ordinal: draft.ordinal,
					position: draft.position,
					segments: draft.segments,
					anchored: now,
					anchorStatus: "ok" as const,
					quoteChanged,
					previousQuotes: quoteChanged
						? [...(annotation.previousQuotes ?? []), annotation.quote].filter(Boolean).slice(-5)
						: annotation.previousQuotes ?? [],
				}
				: annotation);
			await this.store.saveUnit(target, updated);
			this.pathAnnotations.set(normalizePath(target.notePath), updated);
			await this.syncArtifacts(target.workKey);
			await this.refreshViews();
			new Notice("Annotation re-anchored.");
		};
		if (orphans.length === 1) {
			await apply(orphans[0]);
			return;
		}
		new OrphanPicker(this.app, orphans, (orphan) => { void apply(orphan); }).open();
	}

	private annotationAtOffset(
		text: string,
		annotations: SourceAnnotation[],
		offset: number
	): ResolvedAnnotation | null {
		return resolveAnnotations(text, annotations, false)
			.filter((annotation) => annotation.ranges.some((range) => offset >= range.start && offset <= range.end))
			.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
	}

	private async openEditAtCursor(editor: Editor, file: TFile): Promise<void> {
		const target = await this.targetForPath(file.path);
		if (!target) return;
		const annotations = await this.annotationsFor(target);
		const value = editor.getValue();
		const offset = editor.posToOffset(editor.getCursor("from"));
		const hit = this.annotationAtOffset(value, annotations, offset);
		if (!hit) {
			new Notice("No annotation here.");
			return;
		}
		await this.openEditAnnotation(target, hit, this.anchorForEditor(editor));
	}

	private viewForTarget(target: AnnotationTarget): MarkdownView | null {
		const targetPath = normalizePath(target.notePath);
		const found = markdownViews(this.app).find((view) =>
			view.file && normalizePath(view.file.path) === targetPath
		);
		return found ?? this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	async editAnnotation(target: AnnotationTarget, annotation: SourceAnnotation): Promise<void> {
		await this.revealAnnotation(target, annotation);
		await this.openEditAnnotation(target, annotation);
	}

	async openEditAnnotation(
		target: AnnotationTarget,
		annotation: SourceAnnotation,
		anchor?: PopupAnchor
	): Promise<void> {
		let view = this.viewForTarget(target);
		if (!view?.file || normalizePath(view.file.path) !== normalizePath(target.notePath)) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(target.notePath));
			if (!(file instanceof TFile)) {
				new Notice("The source note is not available.");
				return;
			}
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			view = leaf.view instanceof MarkdownView ? leaf.view : null;
		}
		if (!view?.file) {
			new Notice("Open the source note first.");
			return;
		}
		const editor = view.editor;
		const annotations = await this.annotationsFor(target);
		const current = annotations.find((item) => item.id === annotation.id) ?? annotation;
		const draft: AnnotationDraft = {
			annotation: current,
			quote: current.quote,
			quoteText: current.quoteText,
			quoteMarkdown: current.quoteMarkdown,
			prefix: current.prefix ?? "",
			suffix: current.suffix ?? "",
			section: current.section,
			ordinal: current.ordinal,
			position: current.position ?? { start: 0, end: 0 },
			segments: current.segments ?? [],
		};
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const signature = this.selectionSignatureForEditor(editor);
		const popupAnchor = anchor ?? this.anchorForEditor(editor);
		const restore = (): void => {
			if (view.getMode() !== "preview") {
				editor.focus();
				editor.setSelection(from, to);
			}
		};
		this.cancelTooltipTimers();
		this.tooltip.hide();
		this.dialogOpen = true;
		new AnnotationPopup(this.app, {
			draft,
			defaultColor: current.color,
			onSubmit: async (color, comment) => {
				const list = await this.annotationsFor(target);
				const updated = list.map((item) => item.id === current.id
					? { ...item, color, comment: comment || undefined, modified: annotationNow() }
					: item);
				await this.store.saveUnit(target, updated);
				this.pathAnnotations.set(normalizePath(target.notePath), updated);
				await this.syncArtifacts(target.workKey);
				await this.refreshViews();
				this.suppressAutoSignature = signature;
				restore();
				new Notice("Annotation updated.");
			},
			onDelete: async () => {
				const list = await this.annotationsFor(target);
				const kept = list.filter((item) => item.id !== current.id);
				await this.store.saveUnit(target, kept);
				this.pathAnnotations.set(normalizePath(target.notePath), kept);
				await this.syncArtifacts(target.workKey);
				await this.refreshViews();
				this.suppressAutoSignature = signature;
				restore();
				new Notice("Annotation deleted.");
			},
			onCancel: (reason) => {
				this.suppressAutoSignature = signature;
				if (reason !== "outside") restore();
			},
			onClosed: () => {
				this.dialogOpen = false;
			},
		}).open(popupAnchor);
	}

	private async confirmDeleteAtCursor(editor: Editor, file: TFile): Promise<void> {
		const target = await this.targetForPath(file.path);
		if (!target) return;
		const annotations = await this.annotationsFor(target);
		const value = editor.getValue();
		const offset = editor.posToOffset(editor.getCursor("from"));
		const hit = this.annotationAtOffset(value, annotations, offset);
		if (!hit) {
			new Notice("No annotation here.");
			return;
		}
		this.confirmDeleteAnnotation(target, hit);
	}

	confirmDeleteAnnotation(target: AnnotationTarget, annotation: SourceAnnotation): void {
		this.tooltip.hide();
		new ConfirmModal(this.app, {
			title: "Delete annotation",
			message: "Delete this annotation? The quote and comment will be removed from this source’s annotation note.",
			confirmText: "Delete",
			onConfirm: async () => {
				const list = await this.annotationsFor(target);
				const kept = list.filter((item) => item.id !== annotation.id);
				await this.store.saveUnit(target, kept);
				this.pathAnnotations.set(normalizePath(target.notePath), kept);
				await this.syncArtifacts(target.workKey);
				await this.refreshViews();
				new Notice("Annotation deleted.");
			},
		}).open();
	}

	private async confirmTrashWork(path: string): Promise<void> {
		const target = await this.targetForPath(path);
		if (!target) {
			new Notice("This note is not part of an imported source.");
			return;
		}
		const work = await this.store.getWork(target.workKey);
		if (!work) {
			new Notice("No annotations for this source.");
			return;
		}
		const count = Object.values(work.units).reduce((sum, unit) => sum + unit.count, 0);
		if (!count) {
			new Notice("No annotations for this source.");
			return;
		}
		new ConfirmModal(this.app, {
			title: "Delete annotations for this source",
			message: `Move ${count} annotation(s) and the annotation note to the annotation trash? The source itself is not affected.`,
			confirmText: "Move to trash",
			onConfirm: async () => {
				await this.store.trashWork(target.workKey);
				this.pathAnnotations.delete(normalizePath(target.notePath));
				await renderAnnotationMoc(this.app, this.store, this.settings);
				await this.refreshParent();
				await this.refreshViews();
				refreshReadingViews(this.app);
				new Notice("Annotations moved to the annotation trash.");
			},
		}).open();
	}

	private async annotationsFor(target: AnnotationTarget): Promise<SourceAnnotation[]> {
		const unit = await this.store.getUnit(target.workKey, target.unitKey);
		return unit ? [...unit.annotations] : [];
	}

	async openAnnotationNoteForTarget(target: AnnotationTarget): Promise<void> {
		const path = await renderAnnotationNote(this.app, this.store, this.settings, target.workKey);
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
	}

	private async targetForPath(path: string): Promise<AnnotationTarget | null> {
		const stored = this.store.findTarget(path);
		if (stored) {
			const work = await this.store.getWork(stored.workKey);
			if (work) {
				if (work.sourceStatus !== "installed" && work.sourceStatus !== "adopted" && this.app.vault.getAbstractFileByPath(normalizePath(path))) {
					const restoredStatus = work.key.startsWith("adopted:") || work.key.startsWith("note:")
						? "adopted"
						: "installed";
					await this.store.setSourceStatus(stored.workKey, restoredStatus);
					work.sourceStatus = restoredStatus;
					await renderAnnotationNote(this.app, this.store, this.settings, stored.workKey);
					await renderAnnotationMoc(this.app, this.store, this.settings);
					await this.refreshParent();
				}
				return {
					workKey: stored.workKey,
					unitKey: stored.unitKey,
					notePath: normalizePath(path),
					workTitle: work.title,
					workDir: work.dir,
					sourceStatus: work.sourceStatus,
				};
			}
		}
		const target = await this.resolver.resolve(path);
		if (!target) return null;
		const work = await this.store.getWork(target.workKey);
		if (!work) return target;
		return {
			...target,
			workTitle: work.title,
			workDir: work.dir,
			sourceStatus: work.sourceStatus,
		};
	}

	private async syncArtifacts(workKey: string): Promise<void> {
		await renderAnnotationNote(this.app, this.store, this.settings, workKey);
		await renderAnnotationMoc(this.app, this.store, this.settings);
		await this.refreshParent();
	}

	private async refreshParent(): Promise<void> {
		try {
			await this.host.refreshParent();
		} catch (error) {
			console.error("[midad-arabic-sources] annotation parent refresh", error);
		}
	}

	async refreshViews(): Promise<void> {
		if (this.disposed) return;
		this.cancelTooltipTimers();
		this.tooltip.hide();
		for (const view of markdownViews(this.app)) {
			if (!view.file) continue;
			const path = view.file.path;
			const target = await this.targetForPath(path);
			const annotations = target ? await this.annotationsFor(target) : [];
			if (target) this.pathAnnotations.set(normalizePath(path), annotations);
			else this.pathAnnotations.delete(normalizePath(path));
			const cm = cmOf(view);
			if (cm) {
				if (annotations.length) applyEditorAnnotations(cm, resolveForEditor(view.editor.getValue(), annotations));
				else clearEditorAnnotations(cm);
			}
			const sizer = view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer");
			if (sizer) applyReadingAnnotations(sizer, annotations);
		}
		this.refreshSidebar();
	}

	private async setSourceStatus(workKey: string, status: "installed" | "archived" | "removed"): Promise<void> {
		const work = await this.store.getWork(workKey);
		if (!work) return;
		await this.store.setSourceStatus(workKey, status);
		await renderAnnotationNote(this.app, this.store, this.settings, workKey);
		await renderAnnotationMoc(this.app, this.store, this.settings);
		await this.refreshParent();
		await this.refreshViews();
	}

	async onSourceRemoved(workKey: string): Promise<void> {
		await this.setSourceStatus(workKey, "removed");
	}

	async onSourceArchived(workKey: string): Promise<void> {
		await this.setSourceStatus(workKey, "archived");
	}

	async onSourceRestored(workKey: string): Promise<void> {
		await this.setSourceStatus(workKey, "installed");
	}

	async onSourceRenamed(workKey: string, oldDir: string, newDir: string): Promise<void> {
		const work = await this.store.getWork(workKey);
		if (!work) return;
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const unitNotes = new Map<string, string>();
		for (const [unitKey, entry] of Object.entries(work.units)) {
			const oldHub = normalizePath(`${outRoot}/${oldDir}.md`);
			const oldPrefix = normalizePath(`${outRoot}/${oldDir}/`);
			unitNotes.set(
				unitKey,
				entry.note === oldHub
					? normalizePath(`${outRoot}/${newDir}.md`)
					: entry.note.startsWith(oldPrefix)
						? normalizePath(`${outRoot}/${newDir}/${entry.note.slice(oldPrefix.length)}`)
						: entry.note
			);
		}
		const folder = this.settings.annotationNoteFolder.trim() ||
			`${outRoot}/Notes`;
		const newNote = normalizePath(`${folder}/${newDir.replace(/[\\/:*?"<>|#^]/g, "-").trim() || "Annotations"} - Annotations.md`);
		const oldNote = work.note;
		if (oldNote && oldNote !== newNote && await this.app.vault.adapter.exists(normalizePath(oldNote))) {
			const parent = newNote.split("/").slice(0, -1).join("/");
			if (parent && !(await this.app.vault.adapter.exists(normalizePath(parent)))) {
				await this.app.vault.adapter.mkdir(normalizePath(parent));
			}
			try {
				await this.app.vault.adapter.rename(normalizePath(oldNote), newNote);
			} catch { /* leave the file if the move fails */ }
		}
		await this.store.updatePaths(workKey, newDir, newNote, unitNotes);
		this.resolver.invalidate();
		await this.syncArtifacts(workKey);
		await this.refreshViews();
	}

	annotationSummary(): Record<string, { count: number; orphanCount: number }> {
		const out: Record<string, { count: number; orphanCount: number }> = {};
		for (const entry of Object.values(this.store.getIndex().works)) {
			out[entry.key] = { count: entry.count, orphanCount: entry.orphanCount };
		}
		return out;
	}

	annotationCount(workKey: string): number {
		return this.store.getIndex().works[workKey]?.count ?? 0;
	}

	async listTrash(): Promise<AnnotationTrashBatch[]> {
		return this.store.listTrash();
	}

	async restoreTrashBatch(batchPath: string): Promise<void> {
		const key = await this.store.restoreTrash(batchPath);
		if (!key) return;
		await this.syncArtifacts(key);
		await this.refreshViews();
		refreshReadingViews(this.app);
		new Notice("Annotations restored.");
	}

	async emptyTrash(batchPath?: string): Promise<void> {
		const count = await this.store.emptyTrash(batchPath);
		new Notice(count ? "Annotation trash emptied." : "Nothing to delete.");
	}

	async purgeTrash(): Promise<void> {
		try {
			await this.store.purgeTrash(this.settings.annotationTrashDays);
		} catch (error) {
			console.error("[midad-arabic-sources] purge annotation trash", error);
		}
	}

	async trashAnnotationsForWork(workKey: string): Promise<void> {
		await this.store.trashWork(workKey);
		await renderAnnotationMoc(this.app, this.store, this.settings);
		await this.refreshParent();
		await this.refreshViews();
		refreshReadingViews(this.app);
		this.tooltip.hide();
	}

	async confirmDeleteAnnotations(workKey: string): Promise<void> {
		const work = await this.store.getWork(workKey);
		if (!work) return;
		const count = Object.values(work.units).reduce((sum, unit) => sum + unit.count, 0);
		if (!count) {
			new Notice("No annotations for this source.");
			return;
		}
		new ConfirmModal(this.app, {
			title: "Delete annotations for this source",
			message: `Move ${count} annotation(s) and the annotation note to the annotation trash? The source itself is not affected.`,
			confirmText: "Move to trash",
			onConfirm: async () => {
				await this.trashAnnotationsForWork(workKey);
				new Notice("Annotations moved to the annotation trash.");
			},
		}).open();
	}

	private annotationClipboardBlock(annotation: SourceAnnotation): string {
		const label = annotationLabel(annotation.color);
		const orphan = annotation.anchorStatus === "orphaned" ? " · unanchored" : "";
		const lines = [`> [!mas-annotation-${annotation.color}] ${label}${orphan}`];
		const quote = cleanQuoteMarkdown(annotation.quoteMarkdown || annotation.quote);
		for (const line of quote.split("\n")) lines.push(line ? `> > ${line}` : ">");
		if (annotation.comment?.trim()) {
			lines.push(">");
			for (const line of annotation.comment.trim().split("\n")) lines.push(`> ${line}`);
		}
		return lines.join("\n");
	}

	async copySourceWithAnnotations(target?: AnnotationTarget): Promise<void> {
		let resolved = target;
		if (!resolved) {
			const view = activeMarkdownView(this.app);
			if (!view?.file) {
				new Notice("Open a source note first.");
				return;
			}
			resolved = await this.targetForPath(view.file.path);
		}
		if (!resolved) {
			new Notice("That note is not part of an imported source.");
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(normalizePath(resolved.notePath));
		if (!(file instanceof TFile)) {
			new Notice("The source note is not available.");
			return;
		}
		const text = await this.app.vault.adapter.read(file.path);
		const bounds = managedBounds(text);
		const source = (bounds ? text.slice(bounds.contentStart, bounds.contentEnd) : text).trim();
		const annotations = await this.annotationsFor(resolved);
		annotations.sort((a, b) => {
			const orphan = (a.anchorStatus === "orphaned" ? 1 : 0) - (b.anchorStatus === "orphaned" ? 1 : 0);
			if (orphan) return orphan;
			return (a.position?.start ?? Number.MAX_SAFE_INTEGER) - (b.position?.start ?? Number.MAX_SAFE_INTEGER);
		});
		const lines = [source, "", "---", "", "## Annotations", ""];
		if (!annotations.length) {
			lines.push("*No annotations on this source.*", "");
		} else {
			for (const annotation of annotations) {
				lines.push(this.annotationClipboardBlock(annotation), "");
			}
		}
		try {
			await navigator.clipboard.writeText(lines.join("\n"));
			new Notice(`Copied the source with ${annotations.length} annotation(s).`);
		} catch (e) {
			new Notice(`Could not copy: ${e instanceof Error ? e.message : e}`);
		}
	}

	async sidebarData(): Promise<AnnotationSidebarData | null> {
		const candidates: MarkdownView[] = [];
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) candidates.push(active);
		const last = this.lastSidebarPath
			? markdownViews(this.app).find((view) =>
				view.file && normalizePath(view.file.path) === normalizePath(this.lastSidebarPath)
			)
			: null;
		if (last) candidates.push(last);
		const fallback = activeMarkdownView(this.app);
		if (fallback) candidates.push(fallback);

		const seen = new Set<string>();
		for (const view of candidates) {
			if (!view.file) continue;
			const path = normalizePath(view.file.path);
			if (seen.has(path)) continue;
			seen.add(path);
			const target = await this.targetForPath(path);
			if (!target) continue;
			this.lastSidebarPath = path;
			const annotations = await this.annotationsFor(target);
			annotations.sort((a, b) => {
				const orphan = (a.anchorStatus === "orphaned" ? 1 : 0) - (b.anchorStatus === "orphaned" ? 1 : 0);
				if (orphan) return orphan;
				return (a.position?.start ?? Number.MAX_SAFE_INTEGER) - (b.position?.start ?? Number.MAX_SAFE_INTEGER);
			});
			const work = await this.store.getWork(target.workKey);
			return {
				notePath: target.notePath,
				noteName: view.file.basename,
				workTitle: work?.title || target.workTitle,
				target,
				annotations,
			};
		}
		return null;
	}

	async openSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW)[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			if (existing.view instanceof AnnotationSidebarView) await existing.view.refresh();
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (!leaf) return;
		await leaf.setViewState({ type: ANNOTATION_SIDEBAR_VIEW, active: true });
		void this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof AnnotationSidebarView) await leaf.view.refresh();
	}

	private refreshSidebar(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW)) {
			if (leaf.view instanceof AnnotationSidebarView) void leaf.view.refresh();
		}
	}

	async revealAnnotation(target: AnnotationTarget, annotation: SourceAnnotation): Promise<void> {
		let view = markdownViews(this.app).find((candidate) =>
			candidate.file && normalizePath(candidate.file.path) === normalizePath(target.notePath)
		);
		if (!view) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(target.notePath));
			if (!(file instanceof TFile)) {
				new Notice("The source note is not available.");
				return;
			}
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			await new Promise((resolve) => window.setTimeout(resolve, 160));
			view = leaf.view instanceof MarkdownView
				? leaf.view
				: markdownViews(this.app).find((candidate) =>
					candidate.file && normalizePath(candidate.file.path) === normalizePath(target.notePath)
				);
		}
		if (!view) return;
		void this.app.workspace.revealLeaf(view.leaf);

		if (view.getMode() === "preview") {
			const sizer = view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer");
			if (sizer) {
				applyReadingAnnotations(sizer, await this.annotationsFor(target));
			}
			const mark = view.containerEl.querySelector<HTMLElement>(
				`.mas-annotation[data-ann-id="${CSS.escape(annotation.id)}"]`
			);
			if (mark) {
				mark.scrollIntoView({ block: "center", behavior: "smooth" });
				this.flashMarks(view.containerEl, annotation.id);
			} else {
				new Notice("This annotation is not visible in the current reading view.");
			}
			return;
		}

		const text = view.editor.getValue();
		const resolved = resolveAnnotations(text, [annotation], false)[0];
		if (!resolved && annotation.anchorStatus === "orphaned") {
			new Notice("This annotation is unanchored. Open the annotation note to see the preserved quote.");
			return;
		}
		const bounds = managedBounds(text) ?? (target.sourceStatus === "adopted" ? bodyBounds(text) : null);
		const fallback = annotation.position && bounds
			? bounds.bodyStart + annotation.position.start
			: undefined;
		const offset = resolved?.start ?? fallback;
		if (offset === undefined) {
			new Notice("This annotation could not be located in the source note.");
			return;
		}
		const cm = cmOf(view);
		if (!cm) {
			view.editor.setCursor(view.editor.offsetToPos(offset));
			return;
		}
		const at = Math.max(0, Math.min(cm.state.doc.length, offset));
		cm.dispatch({
			selection: { anchor: at, head: at },
			effects: EditorView.scrollIntoView(at, { y: "center" }),
		});
		cm.focus();
		this.flashMarks(view.containerEl, annotation.id, 100);
	}

	private flashMarks(container: HTMLElement, id: string, delay = 0): void {
		const run = (): boolean => {
			const marks = container.querySelectorAll<HTMLElement>(
				`.mas-annotation[data-ann-id="${CSS.escape(id)}"]`
			);
			if (!marks.length) return false;
			marks.forEach((mark) => mark.addClass("mas-ann-flash"));
			window.setTimeout(() => marks.forEach((mark) => mark.removeClass("mas-ann-flash")), 1400);
			return true;
		};
		if (!run()) window.setTimeout(run, Math.max(60, delay));
	}

	async openNamedNote(names: string[]): Promise<void> {
		for (const name of names) {
			const file = this.app.metadataCache.getFirstLinkpathDest(name, "");
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
				return;
			}
		}
		new Notice(`Could not find ${names[0]}.`);
	}

	openManageSources(): void {
		const plugin = this.plugin as unknown as { openManageSources?: () => void };
		plugin.openManageSources?.();
	}

	async openMoc(): Promise<void> {
		const path = await renderAnnotationMoc(this.app, this.store, this.settings);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
	}

	openTrash(): void {
		new AnnotationTrashModal(this.app, this).open();
	}

	mocPath(): string {
		return annotationMocPath(this.settings);
	}

	hasAnnotatedWorks(): boolean {
		return Object.values(this.store.getIndex().works).some((entry) => entry.count > 0);
	}

	mocExists(): boolean {
		return !!this.app.vault.getAbstractFileByPath(this.mocPath());
	}
}

class OrphanPicker extends SuggestModal<SourceAnnotation> {
	private readonly orphans: SourceAnnotation[];
	private readonly choose: (annotation: SourceAnnotation) => void;

	constructor(app: App, orphans: SourceAnnotation[], choose: (annotation: SourceAnnotation) => void) {
		super(app);
		this.orphans = orphans;
		this.choose = choose;
		this.setPlaceholder("Choose an unanchored annotation…");
	}

	getSuggestions(query: string): SourceAnnotation[] {
		const needle = query.trim().toLowerCase();
		if (!needle) return this.orphans;
		return this.orphans.filter((annotation) =>
			`${annotation.quoteText} ${annotation.quote} ${annotation.comment ?? ""}`.toLowerCase().includes(needle)
		);
	}

	renderSuggestion(annotation: SourceAnnotation, el: HTMLElement): void {
		const quote = (annotation.quoteText || annotation.quote || "").replace(/\s+/g, " ").trim();
		el.createDiv({ text: quote.length > 160 ? `${quote.slice(0, 157)}…` : quote });
		if (annotation.comment?.trim()) {
			el.createDiv({ cls: "mas-orphan-picker-comment", text: annotation.comment.trim() });
		}
	}

	onChooseSuggestion(annotation: SourceAnnotation): void {
		this.choose(annotation);
	}
}

export async function registerAnnotations(host: AnnotationHost): Promise<AnnotationService> {
	const service = new AnnotationService(host);
	await service.start();
	return service;
}
