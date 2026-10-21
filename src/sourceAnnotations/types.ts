/** Shared types for the annotation spike and the eventual annotation layer. */

export type AnnotationColor =
	| "yellow"
	| "orange"
	| "red"
	| "purple"
	| "magenta"
	| "blue"
	| "green"
	| "gray";

/** One annotation as stored on disk. */
export interface SourceAnnotation {
	id: string;
	color: AnnotationColor;
	/** Exact raw selection, used for editor anchoring. */
	quote: string;
	/** Clean rendered text, used for Reading-view anchoring. */
	quoteText?: string;
	/** Sanitized markdown for the annotation note. */
	quoteMarkdown?: string;
	comment?: string;
	/** Occurrence index when the same quote appears more than once. */
	ordinal?: number;
	position?: { start: number; end: number };
	segments?: Array<[number, number]>;
}

/** One sharded unit file under `.midad-arabic-sources/annotations/`. */
export interface AnnotationUnitFile {
	schema: number;
	unitKey: string;
	note: string;
	annotations: SourceAnnotation[];
}

/** Spike-only index: note path → sharded unit file. */
export interface SpikeAnnotationIndex {
	notes: Record<string, { work: string; unit: string; file: string }>;
}

/** A resolved annotation with offsets into a particular text. */
export interface ResolvedAnnotation extends SourceAnnotation {
	start: number;
	end: number;
	/** Visible sub-ranges, after trimming list and blockquote markers. */
	ranges: Array<{ start: number; end: number }>;
}
