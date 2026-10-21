import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { annotationTint } from "./colors";
import type { AnnotationTarget, SourceAnnotation } from "./types";

export interface AnnotationTooltipOptions {
	onEdit: (annotation: SourceAnnotation, target: AnnotationTarget, anchor: HTMLElement) => void;
	onDelete: (annotation: SourceAnnotation, target: AnnotationTarget) => void;
	onEnter?: () => void;
	onLeave?: () => void;
}

/**
 * Compact, comment-only tooltip for a margin icon. It deliberately omits the
 * quote: the icon sits next to the highlighted text, and the quote lives in the
 * annotation note.
 */
export class AnnotationTooltip {
	private readonly app: App;
	private readonly options: AnnotationTooltipOptions;
	private el: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private component: Component | null = null;
	private outside: ((event: PointerEvent) => void) | null = null;
	private scroll: ((event: Event) => void) | null = null;
	private resize: (() => void) | null = null;
	private key: ((event: KeyboardEvent) => void) | null = null;

	constructor(app: App, options: AnnotationTooltipOptions) {
		this.app = app;
		this.options = options;
	}

	async show(anchor: HTMLElement, annotations: SourceAnnotation[], target: AnnotationTarget): Promise<void> {
		this.hide();
		if (!annotations.length) return;
		const doc = anchor.ownerDocument;
		const win = doc.defaultView ?? window;
		const el = doc.body.createDiv({ cls: "mas-ann-tooltip" });
		this.el = el;
		this.anchor = anchor;
		const component = new Component();
		component.load();
		this.component = component;

		for (const annotation of annotations) {
			const card = el.createDiv({ cls: "mas-ann-card" });
			card.setCssStyles({ background: annotationTint(annotation.color, 92, 0.55) });
			const dot = card.createSpan({ cls: "mas-ann-card-dot" });
			dot.setCssStyles({ background: annotationTint(annotation.color, 62, 0.9) });
			const body = card.createDiv({ cls: "mas-ann-card-body" });
			const comment = body.createDiv({ cls: "mas-ann-card-comment" });
			if (annotation.comment?.trim()) {
				await MarkdownRenderer.render(this.app, annotation.comment, comment, target.notePath, component);
			} else {
				comment.addClass("is-empty");
				comment.setText("No comment");
			}
			const actions = body.createDiv({ cls: "mas-ann-card-actions" });
			const edit = actions.createEl("button", {
				cls: "clickable-icon mas-ann-card-action",
				attr: { type: "button", "aria-label": "Edit annotation" },
			});
			setIcon(edit, "pencil");
			edit.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
				this.options.onEdit(annotation, target, anchor);
			});
			const remove = actions.createEl("button", {
				cls: "clickable-icon mas-ann-card-action",
				attr: { type: "button", "aria-label": "Delete annotation" },
			});
			setIcon(remove, "trash-2");
			remove.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
				this.options.onDelete(annotation, target);
			});
		}

		if (this.el !== el) return;
		el.addEventListener("click", (event) => {
			const node = event.target as HTMLElement | null;
			const link = node?.closest("a");
			if (!link) return;
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (!href) return;
			event.preventDefault();
			event.stopPropagation();
			this.hide();
			if (link.hasAttribute("data-href") || link.classList.contains("internal-link")) {
				const newLeaf = event.metaKey || event.ctrlKey;
				void this.app.workspace.openLinkText(href, target.notePath, newLeaf);
			} else {
				window.open(href, "_blank");
			}
		});
		this.position(anchor, el, win);
		this.outside = (event: PointerEvent) => {
			const targetNode = event.target as Node | null;
			if (targetNode && (el.contains(targetNode) || anchor.contains(targetNode))) return;
			this.hide();
		};
		doc.addEventListener("pointerdown", this.outside, true);
		this.scroll = (event: Event) => {
			const targetNode = event.target as Node | null;
			if (targetNode && el.contains(targetNode)) return;
			this.hide();
		};
		win.addEventListener("scroll", this.scroll, true);
		this.resize = () => this.hide();
		win.addEventListener("resize", this.resize);
		this.key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.hide();
			}
		};
		doc.addEventListener("keydown", this.key, true);
		el.addEventListener("pointerenter", () => this.options.onEnter?.());
		el.addEventListener("pointerleave", () => this.options.onLeave?.());
	}

	private position(anchor: HTMLElement, el: HTMLElement, win: Window): void {
		const margin = 8;
		const anchorRect = anchor.getBoundingClientRect();
		const rect = el.getBoundingClientRect();
		let left = anchorRect.right + 8;
		let top = anchorRect.top;
		if (left + rect.width + margin > win.innerWidth) left = anchorRect.left - rect.width - 8;
		if (top + rect.height + margin > win.innerHeight) top = win.innerHeight - rect.height - margin;
		left = Math.max(margin, left);
		top = Math.max(margin, top);
		el.setCssStyles({ left: `${left}px`, top: `${top}px` });
	}

	hide(): void {
		if (this.el) {
			const doc = this.el.ownerDocument;
			const win = doc.defaultView ?? window;
			if (this.outside) doc.removeEventListener("pointerdown", this.outside, true);
			if (this.scroll) win.removeEventListener("scroll", this.scroll, true);
			if (this.resize) win.removeEventListener("resize", this.resize);
			if (this.key) doc.removeEventListener("keydown", this.key, true);
			this.el.remove();
		}
		this.outside = null;
		this.scroll = null;
		this.resize = null;
		this.key = null;
		this.el = null;
		this.anchor = null;
		this.component?.unload();
		this.component = null;
	}

	contains(node: Node | null): boolean {
		return !!node && !!this.el?.contains(node);
	}
}
