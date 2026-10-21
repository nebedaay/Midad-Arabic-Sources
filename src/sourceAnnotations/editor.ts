import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { annotationTint } from "./colors";
import { annotationClass, bandClass, resolveAnnotations } from "./resolve";
import { ANNOTATION_EVENTS, type AnnotationEventDetail } from "./events";
import type { ResolvedAnnotation, SourceAnnotation } from "./types";

/** Annotations resolved against the current editor document. */
export const setEditorAnnotations = StateEffect.define<ResolvedAnnotation[]>();

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

function fire(el: HTMLElement, type: string, ids: string[]): void {
	el.dispatchEvent(new CustomEvent<AnnotationEventDetail>(type, {
		bubbles: true,
		detail: { ids },
	}));
}

class AnnotationRail {
	private readonly view: EditorView;
	private rail: HTMLElement | null = null;
	private destroyed = false;
	private scheduled = false;
	private timer = 0;

	constructor(view: EditorView) {
		this.view = view;
		this.schedule();
	}

	update(update: ViewUpdate): void {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged ||
			update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setEditorAnnotations)))
		) {
			this.schedule();
		}
	}

	destroy(): void {
		this.destroyed = true;
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = 0;
		this.rail?.remove();
		this.rail = null;
		this.view.scrollDOM.classList.remove("mas-ann-scroller");
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

	private rebuild(): void {
		this.rail?.remove();
		this.rail = null;
		const annotations = [...this.view.state.field(editorAnnotationsField)]
			.sort((a, b) => a.start - b.start);
		const scroller = this.view.scrollDOM;
		if (!annotations.length) {
			scroller.classList.remove("mas-ann-scroller");
			return;
		}
		const scrollerRect = scroller.getBoundingClientRect();
		const records: Array<{ annotation: ResolvedAnnotation; top: number; left: number }> = [];
		for (const annotation of annotations) {
			const last = annotation.ranges[annotation.ranges.length - 1];
			if (!last) continue;
			const line = this.view.state.doc.lineAt(last.end);
			const coords = this.view.coordsAtPos(line.to);
			if (!coords) continue;
			records.push({
				annotation,
				top: coords.top - scrollerRect.top + scroller.scrollTop,
				left: coords.right - scrollerRect.left + scroller.scrollLeft,
			});
		}
		if (!records.length) {
			scroller.classList.remove("mas-ann-scroller");
			return;
		}
		scroller.classList.add("mas-ann-scroller");
		const rail = scroller.createDiv({ cls: "mas-ann-rail" });
		this.rail = rail;

		const groups = new Map<number, typeof records>();
		for (const record of records) {
			const key = Math.round(record.top);
			const group = groups.get(key) ?? [];
			group.push(record);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			group.sort((a, b) => a.annotation.start - b.annotation.start);
			group.forEach((record, index) => {
				const icon = createEl("button", {
					cls: "mas-ann-margin",
					attr: { type: "button", "aria-label": "Annotation" },
				});
				icon.dataset.annIds = record.annotation.id;
				icon.setCssStyles({
					color: annotationTint(record.annotation.color, 65, 0.95),
					top: `${Math.max(0, record.top - index * 18)}px`,
					left: `${Math.max(6, Math.min(record.left + 6 + index * 5.6, scroller.scrollWidth - 26))}px`,
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
	}
}

const annotationRailPlugin = ViewPlugin.fromClass(AnnotationRail);

export const annotationEditorExtension: Extension = [
	annotationField,
	editorAnnotationsField,
	annotationRailPlugin,
];

/** Report selection changes so the service can offer the creation dialog. */
export function selectionWatcher(onSelection: (view: EditorView) => void): Extension {
	return EditorView.updateListener.of((update) => {
		if (update.selectionSet || update.docChanged) onSelection(update.view);
	});
}

export function resolveForEditor(doc: string, annotations: SourceAnnotation[]): ResolvedAnnotation[] {
	return resolveAnnotations(doc, annotations, false);
}

export function applyEditorAnnotations(view: EditorView, annotations: ResolvedAnnotation[]): void {
	view.dispatch({ effects: setEditorAnnotations.of(annotations) });
}

export function clearEditorAnnotations(view: EditorView): void {
	view.dispatch({ effects: setEditorAnnotations.of([]) });
}
