import { Component, ItemView, WorkspaceLeaf } from "obsidian";
import { renderAnnotationCard } from "./cards";
import type { AnnotationService } from "./service";
import type { AnnotationTarget, SourceAnnotation } from "./types";

export const ANNOTATION_SIDEBAR_VIEW = "midad-annotation-sidebar";

export interface AnnotationSidebarData {
	notePath: string;
	noteName: string;
	workTitle: string;
	target: AnnotationTarget;
	annotations: SourceAnnotation[];
}

/**
 * Right-side list of the active source note's annotations. The cards share the
 * tooltip's renderer but add the quote excerpt and click-to-scroll.
 */
export class AnnotationSidebarView extends ItemView {
	private readonly service: AnnotationService;
	private component: Component | null = null;
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, service: AnnotationService) {
		super(leaf);
		this.service = service;
	}

	getViewType(): string {
		return ANNOTATION_SIDEBAR_VIEW;
	}

	getDisplayText(): string {
		return "Source annotations";
	}

	getIcon(): string {
		return "highlighter";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("mas-ann-sidebar");
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			if (this.leaf.view === this) void this.refresh();
		}));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.component?.unload();
		this.component = null;
	}

	async refresh(): Promise<void> {
		const token = ++this.renderToken;
		const data = await this.service.sidebarData();
		if (token !== this.renderToken) return;
		this.component?.unload();
		const component = new Component();
		component.load();
		this.component = component;

		const root = this.contentEl;
		root.empty();
		const head = root.createDiv({ cls: "mas-ann-sidebar__head" });
		if (!data) {
			head.createDiv({ cls: "mas-ann-sidebar__empty", text: "Open a source note to see its annotations." });
		} else {
			head.createDiv({ cls: "mas-ann-sidebar__title", text: data.noteName });
			const count = data.annotations.length;
			const orphans = data.annotations.filter((annotation) => annotation.anchorStatus === "orphaned").length;
			const plural = count === 1 ? "annotation" : "annotations";
			const extra = orphans ? ` · ${orphans} unanchored` : "";
			head.createDiv({
				cls: "mas-ann-sidebar__sub",
				text: `${data.workTitle} · ${count} ${plural}${extra}`,
			});
			if (!count) {
				root.createDiv({ cls: "mas-ann-sidebar__empty", text: "No annotations on this note yet. Select text in the source to add one." });
			} else {
				const list = root.createDiv({ cls: "mas-ann-sidebar__list" });
				for (const annotation of data.annotations) {
					await renderAnnotationCard(list, {
						app: this.app,
						annotation,
						target: data.target,
						component,
						variant: "sidebar",
						onActivate: () => { void this.service.revealAnnotation(data.target, annotation); },
						onEdit: () => { void this.service.editAnnotation(data.target, annotation); },
						onDelete: () => { this.service.confirmDeleteAnnotation(data.target, annotation); },
						onOpenNote: () => { void this.service.openAnnotationNoteForTarget(data.target); },
					});
					if (token !== this.renderToken) return;
				}
			}
		}

		const actions = root.createDiv({ cls: "mas-ann-sidebar__actions" });
		if (data && data.annotations.length) {
			const note = actions.createEl("button", { text: "Annotation note" });
			note.onclick = () => { void this.service.openAnnotationNoteForTarget(data.target); };
		}
		if (data) {
			const copy = actions.createEl("button", { text: "Copy with annotations" });
			copy.onclick = () => { void this.service.copySourceWithAnnotations(data.target); };
		}
		const moc = actions.createEl("button", { text: "Source annotations MOC" });
		moc.onclick = () => { void this.service.openMoc(); };
		const trash = actions.createEl("button", { text: "Annotation trash" });
		trash.onclick = () => { this.service.openTrash(); };
	}
}
