import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { annotationTint } from "./colors";
import { annotationClass, bandClass, resolveAnnotations, visibleSegments } from "./resolve";
import { ANNOTATION_EVENTS, type AnnotationEventDetail } from "./events";
import {
	bodyBounds,
	crossesHeading,
	expandWikilinkSelection,
	managedBounds,
	selectionExclusion,
} from "./text";
import type { ResolvedAnnotation, SourceAnnotation } from "./types";
import { splitNote } from "../sourceImport/merge";

/** Annotations resolved against the current editor document. */
export const setEditorAnnotations = StateEffect.define<ResolvedAnnotation[]>();

/** Pin an annotation so its resize handles remain visible outside the cursor. */
export const setActiveEditorAnnotation = StateEffect.define<string | null>();

interface PlannedDecoration {
	from: number;
	to: number;
	value: Decoration;
}

export function buildDecorations(annotations: ResolvedAnnotation[], docLength: number): DecorationSet {
	const planned: PlannedDecoration[] = [];
	const boundaries = new Set<number>();
	for (const annotation of annotations) {
		for (const range of annotation.ranges) {
			boundaries.add(range.start);
			boundaries.add(range.end);
		}
	}
	const sorted = Array.from(boundaries).sort((a, b) => a - b);
	for (let i = 0; i < sorted.length - 1; i++) {
		const from = Math.max(0, Math.min(docLength, sorted[i]));
		const to = Math.max(from, Math.min(docLength, sorted[i + 1]));
		if (to <= from) continue;
		const active = annotations.filter((annotation) =>
			annotation.ranges.some((range) => range.start <= from && range.end >= to)
		);
		if (!active.length) continue;
		const allIds = active.map((annotation) => annotation.id).join(" ");
		const allStart = active.every((annotation) =>
			annotation.ranges.some((range) => range.start === from)
		);
		const allEnd = active.every((annotation) =>
			annotation.ranges.some((range) => range.end === to)
		);
		for (let i = 0; i < active.length; i++) {
			const annotation = active[i];
			const classes = ["mas-annotation", annotationClass(annotation.color)];
			if (active.length > 1) {
				classes.push("mas-annotation-multi", "mas-band");
				const band = bandClass(active.length, i);
				if (band) classes.push(band);
			}
			if (allStart) classes.push("mas-seg-start");
			if (allEnd) classes.push("mas-seg-end");
			planned.push({
				from,
				to,
				value: Decoration.mark({
					class: classes.join(" "),
					attributes: {
						"data-ann-id": annotation.id,
						"data-ann-ids": allIds,
					},
				}),
			});
		}
	}
	const ranges: Range<Decoration>[] = planned.map((deco) => deco.value.range(deco.from, deco.to));
	return Decoration.set(ranges, true);
}

export const annotationField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setEditorAnnotations)) {
				return buildDecorations(effect.value, transaction.state.doc.length);
			}
		}
		return decorations.map(transaction.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** The resolved annotation list, for the right-hand margin rail. */
const editorAnnotationsField = StateField.define<ResolvedAnnotation[]>({
	create: () => [],
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setEditorAnnotations)) return effect.value;
		}
		return value;
	},
});

const activeAnnotationField = StateField.define<string | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setActiveEditorAnnotation)) return effect.value;
		}
		return value;
	},
});

/** Show, or clear, the resize handles for an annotation in this editor. */
export function pinEditorAnnotation(view: EditorView, id: string | null): void {
	view.dispatch({ effects: setActiveEditorAnnotation.of(id) });
}

interface ResizeHooks {
	onResize?: (view: EditorView, id: string, from: number, to: number) => void;
}

interface DragState {
	id: string;
	edge: "start" | "end";
	base: ResolvedAnnotation[];
	from: number;
	to: number;
	moved: boolean;
}

function fire(el: HTMLElement, type: string, ids: string[]): void {
	el.dispatchEvent(new CustomEvent<AnnotationEventDetail>(type, {
		bubbles: true,
		detail: { ids },
	}));
}

class AnnotationRail {
	private readonly view: EditorView;
	private readonly hooks: ResizeHooks;
	private rail: HTMLElement | null = null;
	private destroyed = false;
	private scheduled = false;
	private timer = 0;
	private drag: DragState | null = null;
	private moveHandler: ((event: PointerEvent) => void) | null = null;
	private endHandler: ((event: PointerEvent) => void) | null = null;
	private cancelHandler: (() => void) | null = null;
	private readonly onScroll = (): void => this.schedule();

	constructor(view: EditorView, hooks: ResizeHooks) {
		this.view = view;
		this.hooks = hooks;
		this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
		this.schedule();
	}

	update(update: ViewUpdate): void {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged ||
			update.selectionSet ||
			update.transactions.some((tr) => tr.effects.some((effect) =>
				effect.is(setEditorAnnotations) || effect.is(setActiveEditorAnnotation)
			))
		) {
			this.schedule();
		}
	}

	destroy(): void {
		this.destroyed = true;
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = 0;
		this.cancelDrag(false);
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		this.rail?.remove();
		this.rail = null;
		this.view.scrollDOM.classList.remove("mas-ann-scroller");
		this.view.dom.classList.remove("mas-has-annotations");
	}

	/** coordsAtPos cannot run inside an update; measure on the next frame. */
	private schedule(): void {
		if (this.destroyed || this.scheduled) return;
		this.scheduled = true;
		this.timer = window.setTimeout(() => {
			this.scheduled = false;
			this.timer = 0;
			if (!this.destroyed) this.rebuild();
		}, 0);
	}

	private activeAnnotation(annotations: ResolvedAnnotation[]): ResolvedAnnotation | null {
		if (this.drag) {
			const dragged = annotations.find((annotation) => annotation.id === this.drag?.id);
			if (dragged) return dragged;
		}
		const pinned = this.view.state.field(activeAnnotationField, false);
		if (pinned) {
			const found = annotations.find((annotation) => annotation.id === pinned);
			if (found) return found;
		}
		const selection = this.view.state.selection.main;
		if (!selection.empty) return null;
		return annotations
			.filter((annotation) =>
				annotation.ranges.some((range) => selection.head >= range.start && selection.head < range.end)
			)
			.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
	}

	private edges(annotation: ResolvedAnnotation): { start: number; end: number } {
		const first = annotation.ranges[0];
		const last = annotation.ranges[annotation.ranges.length - 1];
		return {
			start: first?.start ?? annotation.start,
			end: last?.end ?? annotation.end,
		};
	}

	private addHandles(rail: HTMLElement, annotation: ResolvedAnnotation): void {
		const { start, end } = this.edges(annotation);
		if (end <= start) return;
		const scroller = this.view.scrollDOM;
		const scrollerRect = scroller.getBoundingClientRect();
		for (const edge of ["start", "end"] as const) {
			const coords = edge === "start"
				? this.view.coordsAtPos(start)
				: this.view.coordsAtPos(Math.max(start, end - 1));
			if (!coords) continue;
			const handle = rail.createDiv({
				cls: "mas-ann-handle",
				attr: {
					role: "presentation",
					"aria-label": edge === "start" ? "Drag annotation start" : "Drag annotation end",
				},
			});
			const height = Math.max(10, Math.min(18, coords.bottom - coords.top));
			handle.dataset.annId = annotation.id;
			handle.dataset.edge = edge;
			handle.setCssStyles({
				left: `${(edge === "start" ? coords.left : coords.right) - scrollerRect.left + scroller.scrollLeft}px`,
				top: `${(coords.top + coords.bottom) / 2 - scrollerRect.top + scroller.scrollTop}px`,
				height: `${height}px`,
				background: annotationTint(annotation.color, 56, 0.94),
			});
			handle.addEventListener("pointerdown", (event) => {
				this.beginDrag(event, annotation.id, edge);
			});
			rail.appendChild(handle);
		}
	}

	private beginDrag(event: PointerEvent, id: string, edge: "start" | "end"): void {
		if (event.button !== 0 || this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		const base = [...this.view.state.field(editorAnnotationsField)];
		const annotation = base.find((candidate) => candidate.id === id);
		if (!annotation) return;
		const { start, end } = this.edges(annotation);
		this.drag = { id, edge, base, from: start, to: end, moved: false };
		this.view.dom.classList.add("mas-ann-resizing");
		document.body.classList.add("mas-ann-resizing");
		pinEditorAnnotation(this.view, id);
		const move = (moveEvent: PointerEvent): void => this.moveDrag(moveEvent);
		const up = (upEvent: PointerEvent): void => this.finishDrag(upEvent);
		const cancel = (): void => this.cancelDrag();
		this.moveHandler = move;
		this.endHandler = up;
		this.cancelHandler = cancel;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
	}

	private dragRange(drag: DragState, position: number): { from: number; to: number } | null {
		const doc = this.view.state.doc.toString();
		const bounds = managedBounds(doc) ?? bodyBounds(doc);
		if (!bounds) return null;
		const at = Math.max(bounds.contentStart, Math.min(bounds.contentEnd, position));
		let from = drag.edge === "start" ? at : drag.from;
		let to = drag.edge === "end" ? at : drag.to;
		if (from >= to) return null;
		const widened = expandWikilinkSelection(doc, from, to);
		from = widened.from;
		to = widened.to;
		if (from < bounds.contentStart || to > bounds.contentEnd || from >= to) return null;
		if (crossesHeading(doc, from, to) || selectionExclusion(doc, from, to)) return null;
		return { from, to };
	}

	private moveDrag(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag) return;
		const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
		if (position === null) return;
		const range = this.dragRange(drag, position);
		if (!range || (range.from === drag.from && range.to === drag.to)) return;
		const doc = this.view.state.doc.toString();
		const ranges = visibleSegments(doc, range.from, range.to);
		if (!ranges.length) return;
		drag.from = range.from;
		drag.to = range.to;
		drag.moved = true;
		const next = drag.base.map((annotation) => annotation.id === drag.id
			? { ...annotation, start: range.from, end: range.to, ranges }
			: annotation);
		this.view.dispatch({ effects: setEditorAnnotations.of(next) });
	}

	private finishDrag(_event: PointerEvent): void {
		const drag = this.drag;
		this.clearDragListeners();
		if (!drag) return;
		this.drag = null;
		this.view.dom.classList.remove("mas-ann-resizing");
		document.body.classList.remove("mas-ann-resizing");
		if (!drag.moved || drag.from >= drag.to) {
			this.view.dispatch({ effects: setEditorAnnotations.of(drag.base) });
			return;
		}
		if (this.hooks.onResize) this.hooks.onResize(this.view, drag.id, drag.from, drag.to);
		else this.view.dispatch({ effects: setEditorAnnotations.of(drag.base) });
		this.schedule();
	}

	private cancelDrag(restore = true): void {
		const drag = this.drag;
		this.clearDragListeners();
		this.drag = null;
		this.view.dom.classList.remove("mas-ann-resizing");
		document.body.classList.remove("mas-ann-resizing");
		if (restore && drag?.moved && !this.destroyed) {
			this.view.dispatch({ effects: setEditorAnnotations.of(drag.base) });
		}
	}

	private clearDragListeners(): void {
		if (this.moveHandler) window.removeEventListener("pointermove", this.moveHandler);
		if (this.endHandler) window.removeEventListener("pointerup", this.endHandler);
		if (this.cancelHandler) window.removeEventListener("pointercancel", this.cancelHandler);
		this.moveHandler = null;
		this.endHandler = null;
		this.cancelHandler = null;
	}

	private rebuild(): void {
		this.rail?.remove();
		this.rail = null;
		const annotations = [...this.view.state.field(editorAnnotationsField)]
			.sort((a, b) => a.start - b.start);
		const scroller = this.view.scrollDOM;
		if (!annotations.length) {
			scroller.classList.remove("mas-ann-scroller");
			this.view.dom.classList.remove("mas-has-annotations");
			return;
		}
		scroller.classList.add("mas-ann-scroller");
		this.view.dom.classList.add("mas-has-annotations");
		const scrollerRect = scroller.getBoundingClientRect();
		const contentRect = this.view.contentDOM.getBoundingClientRect();
		const paddingRight =
			Number.parseFloat(getComputedStyle(this.view.contentDOM).paddingRight) || 0;
		const contentRight = contentRect.right - scrollerRect.left + scroller.scrollLeft;
		const textRight = contentRight - paddingRight;
		const style = getComputedStyle(scroller);
		const gap = Number.parseFloat(style.getPropertyValue("--mas-ann-icon-gap")) || 8;
		const step = Number.parseFloat(style.getPropertyValue("--mas-ann-stack-step")) || 12;
		const records: Array<{ annotation: ResolvedAnnotation; top: number; left: number }> = [];
		for (const annotation of annotations) {
			if (!annotation.ranges.length) continue;
			const start = this.view.coordsAtPos(annotation.start);
			if (!start) continue;
			records.push({
				annotation,
				top: start.top - scrollerRect.top + scroller.scrollTop,
				left: textRight,
			});
		}
		if (!records.length) {
			scroller.classList.remove("mas-ann-scroller");
			this.view.dom.classList.remove("mas-has-annotations");
			return;
		}
		const rail = scroller.createDiv({ cls: "mas-ann-rail" });
		this.rail = rail;

		const groups: Array<typeof records> = [];
		for (const record of [...records].sort((a, b) => a.top - b.top)) {
			const group = groups.find((existing) => Math.abs(existing[0].top - record.top) <= 4);
			if (group) group.push(record);
			else groups.push([record]);
		}
		for (const group of groups) {
			group.sort((a, b) => a.annotation.start - b.annotation.start);
			group.forEach((record, index) => {
				const left = Math.max(6, Math.min(record.left + gap + index * step, contentRight - 26));
				const top = record.top + index * step;
				const icon = createEl("button", {
					cls: "mas-ann-margin",
					attr: { type: "button", "aria-label": "Annotation" },
				});
				icon.dataset.annIds = record.annotation.id;
				icon.setCssStyles({
					color: annotationTint(record.annotation.color, 65, 0.95),
					top: `${top}px`,
					left: `${left}px`,
				});
				icon.addEventListener("mouseenter", () => {
					fire(icon, ANNOTATION_EVENTS.hover, [record.annotation.id]);
				});
				icon.addEventListener("mouseleave", () => {
					fire(icon, ANNOTATION_EVENTS.leave, [record.annotation.id]);
				});
				icon.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					fire(icon, ANNOTATION_EVENTS.open, [record.annotation.id]);
				});
				icon.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						event.stopPropagation();
						fire(icon, ANNOTATION_EVENTS.open, [record.annotation.id]);
					}
				});
				rail.appendChild(icon);
			});
		}
		const active = this.activeAnnotation(annotations);
		if (active) this.addHandles(rail, active);
	}
}

function annotationRailPlugin(hooks: ResizeHooks): Extension {
	return ViewPlugin.fromClass(class {
		private readonly rail: AnnotationRail;

		constructor(view: EditorView) {
			this.rail = new AnnotationRail(view, hooks);
		}

		update(update: ViewUpdate): void {
			this.rail.update(update);
		}

		destroy(): void {
			this.rail.destroy();
		}
	});
}

export function annotationEditorExtension(hooks: ResizeHooks = {}): Extension {
	return [
		annotationField,
		editorAnnotationsField,
		activeAnnotationField,
		annotationRailPlugin(hooks),
	];
}

/** Report selection changes so the service can offer the creation dialog. */
export function selectionWatcher(
	onSelection: (view: EditorView) => void,
	onPointerDown?: (view: EditorView) => void,
	onDomSelection?: (view: EditorView) => void
): Extension {
	return [
		EditorView.updateListener.of((update) => {
			if (update.selectionSet || update.docChanged) onSelection(update.view);
		}),
		EditorView.domEventHandlers({
			mousedown: (_event, view) => {
				onPointerDown?.(view);
				return false;
			},
			mouseup: (_event, view) => {
				onSelection(view);
				onDomSelection?.(view);
				return false;
			},
			keyup: (event, view) => {
				if (event.shiftKey) onDomSelection?.(view);
				return false;
			},
		}),
	];
}

function expandLinkRange(text: string, start: number, end: number): { start: number; end: number } {
	const open = text.lastIndexOf("[[", Math.max(0, end - 1));
	if (open < 0) return { start, end };
	const close = text.indexOf("]]", open + 2);
	if (close < 0) return { start, end };
	if (start > close + 2 || end < open) return { start, end };
	return { start: Math.min(start, open), end: Math.max(end, close + 2) };
}

export function resolveForEditor(doc: string, annotations: SourceAnnotation[]): ResolvedAnnotation[] {
	const prior = splitNote(doc);
	const bodyStart = doc.length - prior.body.length;
	const out: ResolvedAnnotation[] = [];
	for (const annotation of annotations) {
		// Stored positions are authoritative on the source document. This is what
		// keeps a second overlapping annotation visible when its selected quote is
		// truncated inside a rendered link.
		if (annotation.position) {
			const start = bodyStart + annotation.position.start;
			const end = bodyStart + annotation.position.end;
			if (start >= bodyStart && end <= doc.length && end > start) {
				const expanded = expandLinkRange(doc, start, end);
				const ranges = visibleSegments(doc, expanded.start, expanded.end);
				if (ranges.length) {
					out.push({ ...annotation, start: expanded.start, end: expanded.end, ranges });
					continue;
				}
			}
		}
		const fallback = resolveAnnotations(doc, [annotation], false)[0];
		if (fallback) out.push(fallback);
	}
	return out;
}

export function applyEditorAnnotations(view: EditorView, annotations: ResolvedAnnotation[]): void {
	view.dispatch({ effects: setEditorAnnotations.of(annotations) });
}

export function clearEditorAnnotations(view: EditorView): void {
	view.dispatch({ effects: setEditorAnnotations.of([]) });
}
