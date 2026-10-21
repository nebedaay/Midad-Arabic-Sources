/** Shared types for the annotation store and renderer. */

export type AnnotationColor =
	| "yellow"
	| "orange"
	| "red"
	| "purple"
	| "magenta"
	| "blue"
	| "green"
	| "gray";

export type SourceStatus = "installed" | "adopted" | "archived" | "removed";
export type AnchorStatus = "ok" | "orphaned";

/** One annotation as stored on disk. */
export interface SourceAnnotation {
	id: string;
	color: AnnotationColor;
	/** Exact raw selection, used for editor anchoring. */
	quote: string;
	/** Clean rendered text, used for Reading-view anchoring. */
	quoteText: string;
	/** Sanitized markdown for the annotation note. */
	quoteMarkdown: string;
	/** Raw context immediately before the quote, used for fuzzy re-anchoring. */
	prefix?: string;
	/** Raw context immediately after the quote, used for fuzzy re-anchoring. */
	suffix?: string;
	comment?: string;
	/** Occurrence index when the same quote appears more than once. */
	ordinal: number;
	/** Hint offsets inside the note body (after frontmatter). */
	position?: { start: number; end: number };
	/** Visible sub-ranges after trimming list and blockquote markers. */
	segments?: Array<[number, number]>;
	section: string;
	created: string;
	modified: string;
	anchored: string;
	anchorStatus: AnchorStatus;
	quoteChanged: boolean;
	previousQuotes?: string[];
	tags?: string[];
}

/** One sharded unit file under `.midad-arabic-sources/annotations/<work>/`. */
export interface AnnotationUnitFile {
	schema: number;
	unitKey: string;
	note: string;
	annotations: SourceAnnotation[];
}

export interface AnnotationUnitEntry {
	unitKey: string;
	note: string;
	file: string;
	count: number;
	orphanCount: number;
	ord: number;
}

/** `work.json`: authoritative per-work metadata plus unit pointers. */
export interface AnnotationWorkFile {
	schema: number;
	key: string;
	title: string;
	dir: string;
	/** The generated annotation note path, when one exists. */
	note: string;
	sourceStatus: SourceStatus;
	created: string;
	updated: string;
	units: Record<string, AnnotationUnitEntry>;
}

/** `index.json`: derived global index used by the modal, MOC, and sidebar. */
export interface AnnotationIndexEntry {
	key: string;
	title: string;
	dir: string;
	note: string;
	count: number;
	orphanCount: number;
	sourceStatus: SourceStatus;
	updated: string;
}

export interface AnnotationIndexFile {
	schema: number;
	works: Record<string, AnnotationIndexEntry>;
}

/** A resolved annotation with offsets into a particular text. */
export interface ResolvedAnnotation extends SourceAnnotation {
	start: number;
	end: number;
	/** Visible sub-ranges, after trimming list and blockquote markers. */
	ranges: Array<{ start: number; end: number }>;
}

/** Settings the annotation layer reads; the plugin's settings are a superset. */
export interface AnnotationSettings {
	sourceImportRoot: string;
	canonicalQuranFolder: string;
	canonicalQuranRiwāya: string;
	sourceMocParent: string;
	annotationNoteFolder: string;
	annotationDefaultColor: AnnotationColor;
	annotationTrashDays: number;
	annotateOnSelection: boolean;
}

/** Where a source note belongs in the annotation store. */
export interface AnnotationTarget {
	workKey: string;
	unitKey: string;
	notePath: string;
	workTitle: string;
	workDir: string;
	sourceStatus: SourceStatus;
}
