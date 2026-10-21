import type { AnnotationColor, ResolvedAnnotation, SourceAnnotation } from "./types";

/** Normalise whitespace while keeping a map back to the original offsets. */
export function normalizeWhitespaceWithMap(text: string): { text: string; map: number[] } {
	const out: string[] = [];
	const map: number[] = [];
	let inSpace = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (/\s/.test(ch)) {
			if (!inSpace) {
				out.push(" ");
				map.push(i);
				inSpace = true;
			}
		} else {
			out.push(ch);
			map.push(i);
			inSpace = false;
		}
	}
	return { text: out.join(""), map };
}

/**
 * Find the nth occurrence of `needle` in `haystack`, comparing whitespace-folded
 * text, and return offsets in the ORIGINAL haystack. `ordinal` is zero-based.
 */
export function findNormalized(
	haystack: string,
	needle: string,
	ordinal = 0
): { start: number; end: number } | null {
	const trimmed = needle.trim();
	if (!trimmed) return null;
	const h = normalizeWhitespaceWithMap(haystack);
	const n = normalizeWhitespaceWithMap(trimmed);
	if (!n.text) return null;
	let at = 0;
	let found = -1;
	for (let i = 0; i <= ordinal; i++) {
		found = h.text.indexOf(n.text, at);
		if (found < 0) return null;
		at = found + n.text.length;
	}
	const start = h.map[found];
	const end = h.map[found + n.text.length - 1] + 1;
	if (start === undefined || end === undefined) return null;
	return { start, end };
}

const LINE_PREFIX = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ xX]\]\s*)?(?:#{1,6}\s+)?/;

/**
 * The visible parts of a raw selection inside one section: split by line and
 * trim indentation, blockquote markers, list markers, task boxes, and heading
 * marks. A selection that starts mid-line keeps its starting point; only a line
 * whose start is inside the selection is trimmed.
 */
export function visibleSegments(text: string, start: number, end: number): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	if (end <= start) return ranges;
	let lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	let cursor = start;
	while (cursor <= end) {
		const nl = text.indexOf("\n", cursor);
		const lineEnd = nl === -1 ? text.length : nl;
		const segStart = Math.max(cursor, lineStart);
		const segEnd = Math.min(end, lineEnd);
		if (segEnd > segStart) {
			let visibleStart = segStart;
			if (segStart === lineStart) {
				const match = LINE_PREFIX.exec(text.slice(lineStart, lineEnd));
				if (match) visibleStart = Math.min(lineStart + match[0].length, segEnd);
			}
			if (segEnd > visibleStart && text.slice(visibleStart, segEnd).trim()) {
				ranges.push({ start: visibleStart, end: segEnd });
			}
		}
		if (nl === -1) break;
		lineStart = nl + 1;
		cursor = lineStart;
	}
	return ranges;
}

/**
 * Resolve every annotation against a text. `useQuoteText` selects the clean
 * rendered text (Reading view) instead of the raw markdown (editor).
 */
export function resolveAnnotations(
	text: string,
	annotations: SourceAnnotation[],
	useQuoteText: boolean
): ResolvedAnnotation[] {
	const out: ResolvedAnnotation[] = [];
	for (const annotation of annotations) {
		const needle = (useQuoteText ? annotation.quoteText : annotation.quote) ||
			annotation.quote ||
			annotation.quoteText ||
			"";
		if (!needle) continue;
		const found = findNormalized(text, needle, annotation.ordinal ?? 0);
		if (!found) continue;
		const ranges = useQuoteText
			? [{ start: found.start, end: found.end }]
			: visibleSegments(text, found.start, found.end);
		if (!ranges.length) continue;
		out.push({ ...annotation, start: found.start, end: found.end, ranges });
	}
	return out;
}

const COLOR_LABELS: Record<AnnotationColor, string> = {
	yellow: "Yellow highlight",
	orange: "Orange highlight",
	red: "Red highlight",
	purple: "Purple highlight",
	magenta: "Magenta highlight",
	blue: "Blue highlight",
	green: "Green highlight",
	gray: "Gray highlight",
};

export function annotationClass(color: AnnotationColor): string {
	return `mas-color-${color}`;
}

/**
 * The CSS band slot for annotation `index` of `count` active annotations.
 * Band classes paint only their own vertical slice, so nested marks do not
 * cover one another. Up to five simultaneous annotations are styled; beyond
 * that the mark falls back to its first-colour gradient.
 */
export function bandClass(count: number, index: number): string {
	if (count < 2 || count > 5 || index < 0 || index >= count) return "";
	return `mas-band-${count}-${index}`;
}

export function annotationLabel(color: AnnotationColor): string {
	return COLOR_LABELS[color] ?? "Highlight";
}
