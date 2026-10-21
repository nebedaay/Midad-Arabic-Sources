import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
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
import { AnnotationPopup, ConfirmModal, type AnnotationDraft, type PopupAnchor } from "./modal";
import {
	annotationMocPath,
	renderAnnotationMoc,
	renderAnnotationNote,
} from "./note";
import { refreshReadingViews, registerReadingAnnotations } from "./reading";
import { findNormalized, resolveAnnotations, visibleSegments } from "./resolve";
import { AnnotationStore, annotationNow, newAnnotationId } from "./store";
import { AnnotationTargetResolver } from "./target";
import {
	cleanQuoteMarkdown,
	crossesHeading,
	managedBounds,
	markdownToText,
	occurrencesBefore,
	sectionAt,
} from "./text";
import type {
	AnnotationColor,
	AnnotationSettings,
	AnnotationTarget,
	ResolvedAnnotation,
	SourceAnnotation,
} from "./types";
import { applyReadingAnnotations } from "./wrap";

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

function isSourceFrontmatter(frontmatter: Record<string, unknown> | undefined): boolean {
	if (!frontmatter) return false;
	const rawType = frontmatter["document-type"];
	const type = typeof rawType === "string" ? rawType : "";
	// Annotation notes and MOCs also carry mas-up; only text-source notes are
	// annotatable. `mas-key` covers older hubs that predate document-type.
	return type.includes("text-source") || !!frontmatter["mas-key"];
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
	private readonly resolver: AnnotationTargetResolver;
	private readonly pathAnnotations = new Map<string, SourceAnnotation[]>();
	private readonly verifyTimers = new Map<string, number>();
	private readonly autoTimers = new WeakMap<EditorView, number>();
	private suppressAutoUntil = 0;
	private suppressAutoSignature = "";
	private dialogOpen = false;
	private disposed = false;

	constructor(host: AnnotationHost) {
		this.host = host;
		this.app = host.app;
		this.plugin = host.plugin;
		this.settings = host.settings;
		this.store = new AnnotationStore(host.app);
		this.resolver = new AnnotationTargetResolver(host.app, host.settings);
	}

	async start(): Promise<void> {
		await this.store.load();
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
		this.registerCommands();
		this.registerEvents();
		window.setTimeout(() => {
			void this.refreshViews();
			refreshReadingViews(this.app);
		}, 900);
	}

	dispose(): void {
		this.disposed = true;
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
				const path = await renderAnnotationNote(this.app, this.store, this.settings, target.workKey);
				if (!path) return;
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
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
		this.plugin.registerDomEvent(document, "keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
				this.suppressAutoUntil = Date.now() + 1500;
			}
		}, true);
		this.plugin.registerDomEvent(document, "copy", () => {
			this.suppressAutoUntil = Date.now() + 1500;
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
		const bounds = managedBounds(text);
		if (!bounds) return;
		let changed = false;
		let orphanChanged = false;
		const annotations = unit.annotations.map((annotation) => {
			// The source note on disk is raw markdown: use the raw quote first,
			// then fall back to the rendered-text quote for older/migrated records.
			const found = findNormalized(text, annotation.quote || annotation.quoteText, annotation.ordinal);
			if (!found) {
				if (annotation.anchorStatus !== "orphaned") {
					changed = true;
					orphanChanged = true;
					return { ...annotation, anchorStatus: "orphaned" as const, anchored: annotationNow() };
				}
				return annotation;
			}
			const segments = visibleSegments(text, found.start, found.end)
				.map((range) => [range.start - bounds.bodyStart, range.end - bounds.bodyStart] as [number, number]);
			const next: SourceAnnotation = {
				...annotation,
				position: { start: found.start - bounds.bodyStart, end: found.end - bounds.bodyStart },
				segments,
				anchored: annotationNow(),
				anchorStatus: "ok",
				quoteChanged: text.slice(found.start, found.end) !== annotation.quote,
			};
			if (
				!annotation.position ||
				annotation.position.start !== next.position?.start ||
				annotation.position.end !== next.position?.end ||
				annotation.anchorStatus !== "ok" ||
				annotation.quoteChanged !== next.quoteChanged
			) {
				changed = true;
				if (annotation.anchorStatus !== "ok") orphanChanged = true;
			}
			return next;
		});
		if (!changed) return;
		await this.store.saveUnit(target, annotations);
		if (orphanChanged) await this.syncArtifacts(target.workKey);
		await this.refreshViews();
	}

	private anyModalOpen(): boolean {
		const container = document.querySelector(".modal-container");
		return !!container && !!container.querySelector(".modal");
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
		if (!isSourceFrontmatter(cache?.frontmatter)) return null;
		const value = editor.getValue();
		const bounds = managedBounds(value);
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
		const draft: AnnotationDraft = {
			annotation: hit,
			quote: hit.quote,
			quoteText: hit.quoteText,
			quoteMarkdown: hit.quoteMarkdown,
			section: hit.section,
			ordinal: hit.ordinal,
			position: hit.position ?? { start: 0, end: 0 },
			segments: hit.segments ?? [],
		};
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const signature = this.selectionSignatureForEditor(editor);
		const anchor = this.anchorForEditor(editor);
		this.dialogOpen = true;
		new AnnotationPopup(this.app, {
			draft,
			defaultColor: hit.color,
			onSubmit: async (color, comment) => {
				const updated = annotations.map((annotation) => annotation.id === hit.id
					? { ...annotation, color, comment: comment || undefined, modified: annotationNow() }
					: annotation);
				await this.store.saveUnit(target, updated);
				this.pathAnnotations.set(normalizePath(target.notePath), updated);
				await this.syncArtifacts(target.workKey);
				await this.refreshViews();
				this.suppressAutoSignature = signature;
				editor.focus();
				editor.setSelection(from, to);
				new Notice("Annotation updated.");
			},
			onDelete: async () => {
				const kept = annotations.filter((annotation) => annotation.id !== hit.id);
				await this.store.saveUnit(target, kept);
				this.pathAnnotations.set(normalizePath(target.notePath), kept);
				await this.syncArtifacts(target.workKey);
				await this.refreshViews();
				this.suppressAutoSignature = signature;
				editor.focus();
				editor.setSelection(from, to);
				new Notice("Annotation deleted.");
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
		new ConfirmModal(this.app, {
			title: "Delete annotation",
			message: "Delete this annotation? The quote and comment will be removed from this source’s annotation note.",
			confirmText: "Delete",
			onConfirm: async () => {
				const kept = annotations.filter((annotation) => annotation.id !== hit.id);
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

	private async targetForPath(path: string): Promise<AnnotationTarget | null> {
		const stored = this.store.findTarget(path);
		if (stored) {
			const work = await this.store.getWork(stored.workKey);
			if (work) {
				if (work.sourceStatus !== "installed" && this.app.vault.getAbstractFileByPath(normalizePath(path))) {
					await this.store.setSourceStatus(stored.workKey, "installed");
					work.sourceStatus = "installed";
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
	}

	async onSourceRemoved(workKey: string): Promise<void> {
		const work = await this.store.getWork(workKey);
		if (!work) return;
		await this.store.setSourceStatus(workKey, "removed");
		await renderAnnotationNote(this.app, this.store, this.settings, workKey);
		await renderAnnotationMoc(this.app, this.store, this.settings);
		await this.refreshParent();
		await this.refreshViews();
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

export async function registerAnnotations(host: AnnotationHost): Promise<AnnotationService> {
	const service = new AnnotationService(host);
	await service.start();
	return service;
}
