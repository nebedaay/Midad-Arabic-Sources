import { App, Component } from "obsidian";
import { renderAnnotationCard } from "./cards";
import type { AnnotationTarget, SourceAnnotation } from "./types";

export interface AnnotationTooltipOptions {
	onEdit: (annotation: SourceAnnotation, target: AnnotationTarget, anchor: HTMLElement) => void;
	onDelete: (annotation: SourceAnnotation, target: AnnotationTarget) => void;
	onOpenNote: (target: AnnotationTarget) => void;
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
			await renderAnnotationCard(el, {
				app: this.app,
				annotation,
				target,
				component,
				variant: "compact",
				onEdit: () => {
					this.hide();
					this.options.onEdit(annotation, target, anchor);
				},
				onOpenNote: () => {
					this.hide();
					this.options.onOpenNote(target);
				},
				onDelete: () => {
					this.hide();
					this.options.onDelete(annotation, target);
				},
			});
		}

		if (this.el !== el) return;
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
