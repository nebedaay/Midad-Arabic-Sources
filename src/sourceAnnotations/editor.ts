import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { Extension, Range, StateEffect, StateField } from "@codemirror/state";
import { annotationClass, annotationLabel, bandClass, resolveAnnotations } from "./resolve";
import type { ResolvedAnnotation, SourceAnnotation } from "./types";

/** Annotations resolved against the current editor document. */
export const setEditorAnnotations = StateEffect.define<ResolvedAnnotation[]>();

class CommentWidget extends WidgetType {
	private readonly ids: string;
	private readonly label: string;
	private readonly count: number;

	constructor(annotations: ResolvedAnnotation[]) {
		super();
		this.ids = annotations.map((annotation) => annotation.id).join(" ");
		const comments = annotations
			.map((annotation) => annotation.comment)
			.filter((comment): comment is string => !!comment);
		this.label = comments.length ? comments.join(" · ") : annotationLabel(annotations[0].color);
		this.count = annotations.length;
	}

	eq(other: CommentWidget): boolean {
		return other.ids === this.ids && other.label === this.label && other.count === this.count;
	}

	toDOM(view: EditorView): HTMLElement {
		const el = createSpan({
			cls: "mas-ann-icon",
			text: "💬",
			attr: { title: this.label },
		});
		el.dataset.annIds = this.ids;
		if (this.count > 1) {
			el.appendChild(createSpan({ cls: "mas-ann-count", text: String(this.count) }));
		}
		return el;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

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
			const attributes: Record<string, string> = {
				"data-ann-id": annotation.id,
				"data-ann-ids": allIds,
			};
			if (annotation.comment) attributes.title = annotation.comment;
			planned.push({
				from,
				to,
				value: Decoration.mark({ class: classes.join(" "), attributes }),
			});
		}
	}
	const commentGroups = new Map<number, ResolvedAnnotation[]>();
	for (const annotation of annotations) {
		if (!annotation.comment) continue;
		const group = commentGroups.get(annotation.end) ?? [];
		group.push(annotation);
		commentGroups.set(annotation.end, group);
	}
	for (const group of commentGroups.values()) {
		const lastAnnotation = group[group.length - 1];
		const last = lastAnnotation.ranges[lastAnnotation.ranges.length - 1];
		if (!last) continue;
		const at = Math.max(0, Math.min(docLength, last.end));
		planned.push({
			from: at,
			to: at,
			value: Decoration.widget({ widget: new CommentWidget(group), side: 1 }),
		});
	}
	// Decoration.set (rather than RangeSetBuilder) accepts point and mark
	// ranges in any order; the elementary intervals above are already disjoint.
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

export const annotationEditorExtension: Extension = [annotationField];

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
