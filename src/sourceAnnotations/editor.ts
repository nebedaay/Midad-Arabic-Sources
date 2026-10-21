import {
	Decoration,
	DecorationSet,
	EditorView,
	GutterMarker,
	gutter,
} from "@codemirror/view";
import {
	Extension,
	Range,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
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

interface AnnotationMarkerRow {
	line: number;
	ids: string[];
}

function buildMarkerRows(
	annotations: ResolvedAnnotation[],
	doc: { lineAt(position: number): { number: number } }
): AnnotationMarkerRow[] {
	const rows = new Map<number, string[]>();
	for (const annotation of annotations) {
		const last = annotation.ranges[annotation.ranges.length - 1];
		if (!last) continue;
		const line = doc.lineAt(last.end).number;
		const ids = rows.get(line) ?? [];
		if (!ids.includes(annotation.id)) ids.push(annotation.id);
		rows.set(line, ids);
	}
	return [...rows.entries()]
		.map(([line, ids]) => ({ line, ids }))
		.sort((a, b) => a.line - b.line);
}

/** One marker per line where annotations end. */
export const annotationMarkerField = StateField.define<AnnotationMarkerRow[]>({
	create: () => [],
	update(rows, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setEditorAnnotations)) {
				return buildMarkerRows(effect.value, transaction.state.doc);
			}
		}
		return rows;
	},
});

function dispatchMarker(el: HTMLElement, type: string, ids: string[]): void {
	el.dispatchEvent(new CustomEvent<AnnotationEventDetail>(type, {
		bubbles: true,
		detail: { ids },
	}));
}

class AnnotationGutterMarker extends GutterMarker {
	readonly ids: string[];

	constructor(ids: string[]) {
		super();
		this.ids = ids;
	}

	eq(other: GutterMarker): boolean {
		return other instanceof AnnotationGutterMarker && other.ids.join("|") === this.ids.join("|");
	}

	toDOM(): HTMLElement {
		const label = this.ids.length === 1 ? "1 annotation" : `${this.ids.length} annotations`;
		const el = createSpan({
			cls: "mas-ann-margin",
			attr: { role: "button", tabindex: "0", "aria-label": label },
		});
		el.createSpan({ cls: "mas-ann-margin-glyph", text: "💬" });
		if (this.ids.length > 1) {
			el.createSpan({ cls: "mas-ann-margin-count", text: String(this.ids.length) });
		}
		el.addEventListener("mouseenter", () => dispatchMarker(el, ANNOTATION_EVENTS.hover, this.ids));
		el.addEventListener("mouseleave", () => dispatchMarker(el, ANNOTATION_EVENTS.leave, this.ids));
		el.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			dispatchMarker(el, ANNOTATION_EVENTS.open, this.ids);
		});
		el.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				dispatchMarker(el, ANNOTATION_EVENTS.open, this.ids);
			}
		});
		return el;
	}
}

export const annotationGutter = gutter({
	class: "mas-ann-gutter",
	markers: (view) => {
		const rows = view.state.field(annotationMarkerField);
		const builder = new RangeSetBuilder<GutterMarker>();
		for (const row of rows) {
			const line = view.state.doc.line(row.line);
			builder.add(line.from, line.from, new AnnotationGutterMarker(row.ids));
		}
		return builder.finish();
	},
	lineMarkerChange: (update) =>
		update.state.field(annotationMarkerField) !== update.startState.field(annotationMarkerField),
});

export const annotationEditorExtension: Extension = [
	annotationField,
	annotationMarkerField,
	annotationGutter,
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
