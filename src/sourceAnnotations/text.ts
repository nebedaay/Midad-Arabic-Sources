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
	const target = notePath.replace(/\.md$/i, "");
	const base = notePath.split("/").pop()?.replace(/\.md$/i, "") ?? notePath;
	if (!heading) return `[[${target}|${label || base}]]`;
	const display = label || heading;
	return `[[${target}#${heading}|${display}]]`;
}

export type SelectionExclusion = "fenced-code" | "inline-code" | "table" | null;

interface LineSpan {
	start: number;
	end: number;
}

function noteLines(text: string): LineSpan[] {
	const out: LineSpan[] = [];
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charAt(i) === "\n") {
			out.push({ start, end: i });
			start = i + 1;
		}
	}
	return out;
}

function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart < bEnd && aEnd > bStart;
}

function fencedCodeRanges(text: string, lines: LineSpan[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = text.slice(lines[i].start, lines[i].end);
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (!open) continue;
		const start = lines[i].start;
		const marker = open[1];
		const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
		let end = text.length;
		let closed = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (close.test(text.slice(lines[j].start, lines[j].end))) {
				end = lines[j].end;
				i = j;
				closed = true;
				break;
			}
		}
		if (!closed) i = lines.length;
		ranges.push([start, end]);
	}
	return ranges;
}

/** C0/CommonMark-ish inline code spans, ignoring fenced blocks. */
function inlineCodeRanges(text: string, fenced: Array<[number, number]>): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const inFence = (offset: number): boolean => fenced.some(([start, end]) => offset >= start && offset < end);
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) !== "`" || inFence(i)) continue;
		let run = 1;
		while (text.charAt(i + run) === "`") run++;
		let close = -1;
		for (let j = i + run; j < text.length; j++) {
			if (text.charAt(j) !== "`" || inFence(j)) continue;
			let length = 1;
			while (text.charAt(j + length) === "`") length++;
			if (length === run) {
				close = j;
				break;
			}
			j += length - 1;
		}
		if (close === -1) {
			i += run - 1;
			continue;
		}
		ranges.push([i, close + run]);
		i = close + run - 1;
	}
	return ranges;
}

const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;

function tableRanges(text: string, lines: LineSpan[], fenced: Array<[number, number]>): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const inFence = (offset: number): boolean => fenced.some(([start, end]) => offset >= start && offset < end);
	for (let i = 0; i + 1 < lines.length; i++) {
		if (inFence(lines[i].start)) continue;
		const header = text.slice(lines[i].start, lines[i].end);
		const delimiter = text.slice(lines[i + 1].start, lines[i + 1].end);
		if (!header.includes("|") || !TABLE_DELIMITER.test(delimiter)) continue;
		let last = i + 1;
		while (last + 1 < lines.length && !inFence(lines[last + 1].start) &&
			text.slice(lines[last + 1].start, lines[last + 1].end).includes("|")) {
			last++;
		}
		ranges.push([lines[i].start, lines[last].end]);
		i = last;
	}
	return ranges;
}

/**
 * The annotation v1 exclusions: fenced code, inline code, and Markdown tables.
 * Returns the first exclusion intersecting the range, or null.
 */
export function selectionExclusion(text: string, start: number, end: number): SelectionExclusion {
	if (end <= start) return null;
	const lines = noteLines(text);
	const fenced = fencedCodeRanges(text, lines);
	if (fenced.some(([a, b]) => intersects(start, end, a, b))) return "fenced-code";
	if (tableRanges(text, lines, fenced).some(([a, b]) => intersects(start, end, a, b))) return "table";
	if (inlineCodeRanges(text, fenced).some(([a, b]) => intersects(start, end, a, b))) return "inline-code";
	return null;
}

/**
 * Selecting rendered wikilinks can expose only a fragment of their source. When
 * the touched lines are a list of links, expand to complete lines.
 */
export function expandLinkListSelection(
	text: string,
	from: number,
	to: number
): { from: number; to: number } {
	const lineStart = (offset: number): number => text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const lineEnd = (offset: number): number => {
		const nl = text.indexOf("\n", offset);
		return nl === -1 ? text.length : nl;
	};
	const start = lineStart(from);
	const end = lineEnd(to);
	const lines = text.slice(start, end).split("\n");
	if (!lines.length || !lines.every((line) => !line.trim() || /^\s*[-*+]\s+\[\[/.test(line))) {
		return { from, to };
	}
	return { from: start, to: end };
}

interface VisibleChar {
	char: string;
	index: number;
}

/**
 * A lightweight rendered-text projection with raw offsets, used to map a
 * Reading-view selection back into the Markdown source when the selection
 * crosses links or inline formatting.
 */
export function renderedTextProjection(markdown: string): { text: string; map: number[] } {
	const visible: VisibleChar[] = [];
	let lineStart = true;
	let i = 0;
	const push = (char: string, index: number): void => {
		visible.push({ char, index });
	};
	while (i < markdown.length) {
		if (lineStart) {
			const end = markdown.indexOf("\n", i);
			const line = markdown.slice(i, end === -1 ? markdown.length : end);
			const prefix = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ xX]\]\s*)?(?:#{1,6}\s+)?/.exec(line);
			if (prefix) i += prefix[0].length;
			lineStart = false;
		}
		const char = markdown.charAt(i);
		if (char === "\n") {
			push(" ", i);
			lineStart = true;
			i++;
			continue;
		}
		if (char === "[" && markdown.startsWith("[[", i)) {
			const close = markdown.indexOf("]]", i + 2);
			if (close !== -1) {
				const inner = markdown.slice(i + 2, close);
				const bar = inner.lastIndexOf("|");
				const label = bar >= 0 ? inner.slice(bar + 1) : inner;
				const labelStart = i + 2 + (bar >= 0 ? bar + 1 : 0);
				for (let j = 0; j < label.length; j++) push(label.charAt(j), labelStart + j);
				i = close + 2;
				continue;
			}
		}
		if (char === "[") {
			const link = /^\[([^\]]*)\]\([^)]*\)/.exec(markdown.slice(i));
			if (link) {
				for (let j = 0; j < link[1].length; j++) push(link[1].charAt(j), i + 1 + j);
				i += link[0].length;
				continue;
			}
		}
		if (char === "<") {
			const tag = /^<[^>]+>/.exec(markdown.slice(i));
			if (tag) {
				i += tag[0].length;
				continue;
			}
		}
		if ("*_~`".includes(char)) {
			i++;
			continue;
		}
		push(char, i);
		i++;
	}
	const out: string[] = [];
	const map: number[] = [];
	let lastSpace = false;
	for (const item of visible) {
		if (/\s/.test(item.char)) {
			if (lastSpace) continue;
			out.push(" ");
			map.push(item.index);
			lastSpace = true;
		} else {
			out.push(item.char);
			map.push(item.index);
			lastSpace = false;
		}
	}
	return { text: out.join(""), map };
}

/** Locate rendered text in raw Markdown, returning raw offsets. */
export function findRenderedText(markdown: string, rendered: string): { start: number; end: number } | null {
	const needle = normalizeWhitespaceWithMap(rendered).text.trim();
	if (!needle) return null;
	const projection = renderedTextProjection(markdown);
	const at = projection.text.indexOf(needle);
	if (at < 0) return null;
	const start = projection.map[at];
	const end = projection.map[at + needle.length - 1];
	if (start === undefined || end === undefined) return null;
	return { start, end: end + 1 };
}
