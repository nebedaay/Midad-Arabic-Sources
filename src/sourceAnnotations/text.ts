import {
	LEGACY_MANAGED_CLOSE,
	LEGACY_MANAGED_OPEN,
	MANAGED_CLOSE,
	MANAGED_OPEN,
	findManagedRegion,
	splitNote,
} from "../sourceImport/merge";
import { normalizeWhitespaceWithMap } from "./resolve";

export interface ManagedBounds {
	/** Offset of the body (after frontmatter) in the full note. */
	bodyStart: number;
	/** First character the user may annotate (inside the managed markers). */
	contentStart: number;
	/** One past the last character the user may annotate. */
	contentEnd: number;
}

/** Locate the managed region in a full note, in full-note offsets. */
export function managedBounds(content: string): ManagedBounds | null {
	const prior = splitNote(content);
	const bodyStart = content.length - prior.body.length;
	const region = findManagedRegion(prior.body);
	if (!region) return null;
	let open = 0;
	let close = 0;
	for (const [o, c] of [
		[MANAGED_OPEN, MANAGED_CLOSE],
		[LEGACY_MANAGED_OPEN, LEGACY_MANAGED_CLOSE],
	] as const) {
		if (prior.body.startsWith(o, region.start)) {
			open = o.length;
			close = c.length;
			break;
		}
	}
	if (!open) return null;
	return {
		bodyStart,
		contentStart: bodyStart + region.start + open,
		contentEnd: bodyStart + region.end - close,
	};
}

/** The whole body after frontmatter, for adopted notes without managed spans. */
export function bodyBounds(content: string): ManagedBounds | null {
	const prior = splitNote(content);
	const bodyStart = content.length - prior.body.length;
	if (!prior.body.trim()) return null;
	return { bodyStart, contentStart: bodyStart, contentEnd: bodyStart + prior.body.length };
}

/** Remove callout/blockquote markers and trailing spaces. */
export function cleanQuoteMarkdown(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/^(?:>\s?)+/, "").replace(/\s+$/, ""))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

/** Strip markdown down to the text a reader sees, preserving line breaks. */
export function markdownToText(markdown: string): string {
	let text = cleanQuoteMarkdown(markdown);
	text = text
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
		.replace(/^\s*\[[ xX]\]\s*/gm, "")
		.replace(/^\s*#{1,6}\s+/gm, "")
		.replace(/(\*\*|__|\*|_|`|~~)/g, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/^\n+|\n+$/g, "");
	return text;
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\n") starts.push(i + 1);
	}
	return starts;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** The heading that owns `offset`, or an empty string before the first heading. */
export function sectionAt(text: string, offset: number): string {
	let section = "";
	for (const start of lineStarts(text)) {
		if (start >= offset) break;
		const end = text.indexOf("\n", start);
		const line = text.slice(start, end === -1 ? text.length : end);
		const match = HEADING_RE.exec(line);
		if (match) section = match[2].trim();
	}
	return section;
}

/**
 * A selection is valid only if it does not start on a heading and no heading
 * line begins inside it. This keeps every annotation within one section.
 */
export function crossesHeading(text: string, start: number, end: number): boolean {
	for (const lineStart of lineStarts(text)) {
		if (lineStart < start) continue;
		if (lineStart >= end) break;
		const lineEnd = text.indexOf("\n", lineStart);
		const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
		if (HEADING_RE.test(line)) return true;
	}
	// Reject a selection that starts inside a heading line.
	const startLine = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const startEnd = text.indexOf("\n", startLine);
	if (HEADING_RE.test(text.slice(startLine, startEnd === -1 ? text.length : startEnd))) return true;
	return false;
}

/** How many times `needle` occurs before `offset`, used for the ordinal hint. */
export function occurrencesBefore(text: string, offset: number, needle: string): number {
	const trimmed = needle.trim();
	if (!trimmed) return 0;
	const haystack = normalizeWhitespaceWithMap(text.slice(0, offset));
	const target = normalizeWhitespaceWithMap(trimmed);
	if (!target.text) return 0;
	let count = 0;
	let at = 0;
	while (true) {
		const found = haystack.text.indexOf(target.text, at);
		if (found < 0) return count;
		count += 1;
		at = found + target.text.length;
	}
}

/** Markdown link to a note and, when known, a heading inside it. */
export function noteHeadingLink(notePath: string, heading: string, label?: string): string {
	const base = notePath.split("/").pop()?.replace(/\.md$/i, "") ?? notePath;
	if (!heading) return `[[${base}]]`;
	const display = label || heading;
	return `[[${base}#${heading}|${display}]]`;
}
