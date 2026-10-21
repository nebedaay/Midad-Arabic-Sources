/**
 * Relocate annotations after a source note is rewritten.
 *
 * The generated source text is not a stable coordinate space: a re-render can
 * change a word in a quote, move a paragraph, or replace a note wholesale. The
 * exact quote is always tried first. If it is gone, the stored prefix/suffix
 * context brackets the replacement and a conservative fuzzy match is used. A
 * quote that cannot be found with enough confidence stays orphaned; the store
 * never silently points at unrelated text.
 */

import { markdownToText } from "./text";
import { normalizeWhitespaceWithMap } from "./resolve";
import type { SourceAnnotation } from "./types";

export interface ReanchorMatch {
	start: number;
	end: number;
	method: "exact" | "fuzzy";
	/** Higher is safer; mostly useful for diagnostics and tests. */
	score: number;
}

export interface ReanchorOptions {
	/** Offset of the note body (after frontmatter) in `text`. */
	bodyStart?: number;
	/** First character the user may annotate. */
	contentStart?: number;
	/** One past the last character the user may annotate. */
	contentEnd?: number;
}

interface Range {
	start: number;
	end: number;
	index: number;
}

interface Candidate extends Range {
	method: "exact" | "fuzzy";
	score: number;
}

const MAX_CANDIDATES = 40;
const CONTEXT_CHARS = 120;
const ANCHOR_CHARS = 80;
const MIN_ANCHOR_CHARS = 8;

function normalized(text: string): string {
	return normalizeWhitespaceWithMap(text).text;
}

function plain(text: string): string {
	return normalized(markdownToText(text));
}

interface IndexedText {
	text: string;
	map: number[];
}

function findAllIn(haystack: IndexedText, needle: string): Range[] {
	const target = normalizeWhitespaceWithMap(needle.trim());
	if (!target.text) return [];
	const out: Range[] = [];
	let at = 0;
	while (out.length < MAX_CANDIDATES) {
		const found = haystack.text.indexOf(target.text, at);
		if (found < 0) break;
		const start = haystack.map[found];
		const end = haystack.map[found + target.text.length - 1] + 1;
		if (start !== undefined && end !== undefined) {
			out.push({ start, end, index: out.length });
		}
		at = found + target.text.length;
	}
	return out;
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charAt(i) === b.charAt(i)) i++;
	return i;
}

function commonSuffixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)) i++;
	return i;
}

function contextScore(
	text: string,
	start: number,
	end: number,
	annotation: SourceAnnotation
): { before: number; after: number } {
	const before = normalized(text.slice(Math.max(0, start - CONTEXT_CHARS), start));
	const after = normalized(text.slice(end, Math.min(text.length, end + CONTEXT_CHARS)));
	const prefix = normalized(annotation.prefix ?? "").slice(-ANCHOR_CHARS);
	const suffix = normalized(annotation.suffix ?? "").slice(0, ANCHOR_CHARS);
	return {
		before: prefix ? commonSuffixLength(before, prefix) / prefix.length : 0,
		after: suffix ? commonPrefixLength(after, suffix) / suffix.length : 0,
	};
}

function positionScore(start: number, annotation: SourceAnnotation, bodyStart: number): number {
	if (!annotation.position) return 0;
	const expected = bodyStart + annotation.position.start;
	return Math.max(0, 1 - Math.abs(start - expected) / 2000);
}

function scoreExact(
	text: string,
	candidate: Range,
	annotation: SourceAnnotation,
	bodyStart: number
): number {
	const context = contextScore(text, candidate.start, candidate.end, annotation);
	const rawEqual = text.slice(candidate.start, candidate.end) === annotation.quote ? 1 : 0;
	const ordinal = candidate.index === annotation.ordinal ? 1 : 0;
	return (
		context.before * 3 +
		context.after * 3 +
		positionScore(candidate.start, annotation, bodyStart) * 1.5 +
		rawEqual * 0.2 +
		ordinal * 0.3
	);
}

function levenshtein(a: string, b: string): number {
	const width = b.length + 1;
	let previous = new Array<number>(width);
	for (let j = 0; j < width; j++) previous[j] = j;
	for (let i = 1; i <= a.length; i++) {
		const current = new Array<number>(width);
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + cost
			);
		}
		previous = current;
	}
	return previous[b.length];
}

function similarity(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a === b) return 1;
	// Keep the fallback bounded: a very long paragraph should not freeze the
	// editor's file-change handler. Comparing character bigrams is enough to
	// decide whether the candidate is the same passage.
	if (Math.max(a.length, b.length) > 1200) {
		const grams = (value: string): Set<string> => {
			const out = new Set<string>();
			for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2));
			return out;
		};
		const ga = grams(a);
		const gb = grams(b);
		let shared = 0;
		for (const gram of ga) if (gb.has(gram)) shared++;
		return (2 * shared) / Math.max(1, ga.size + gb.size);
	}
	return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function tailAnchor(value: string): string {
	const text = normalized(value);
	if (!text) return "";
	const words = text.split(" ");
	let anchor = words.slice(-8).join(" ");
	if (anchor.length < MIN_ANCHOR_CHARS) anchor = text;
	return anchor.slice(-ANCHOR_CHARS);
}

function headAnchor(value: string): string {
	const text = normalized(value);
	if (!text) return "";
	const words = text.split(" ");
	let anchor = words.slice(0, 8).join(" ");
	if (anchor.length < MIN_ANCHOR_CHARS) anchor = text;
	return anchor.slice(0, ANCHOR_CHARS);
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
	while (start < end && /\s/.test(text.charAt(start))) start++;
	while (end > start && /\s/.test(text.charAt(end - 1))) end--;
	return { start, end };
}

function within(start: number, end: number, options: ReanchorOptions): boolean {
	const contentStart = options.contentStart ?? 0;
	const contentEnd = options.contentEnd ?? Number.MAX_SAFE_INTEGER;
	return start >= contentStart && end <= contentEnd && end > start;
}

/**
 * Find the best place for `annotation` in `text`. Returns null when neither the
 * quote nor its surrounding context survives with enough confidence.
 */
export function reanchorAnnotation(
	text: string,
	annotation: SourceAnnotation,
	options: ReanchorOptions = {}
): ReanchorMatch | null {
	const bodyStart = options.bodyStart ?? 0;
	const quote = annotation.quote || annotation.quoteText || "";
	const oldPlain = plain(annotation.quoteText || quote);
	if (!normalized(quote)) return null;
	const haystack = normalizeWhitespaceWithMap(text);

	// 1. Exact (whitespace-folded) occurrences. Context and the old position
	// choose between repeated quotes; a unique occurrence needs no context.
	const exact: Candidate[] = [];
	const seen = new Set<string>();
	for (const needle of [annotation.quote, annotation.quoteText]) {
		if (!needle) continue;
		for (const found of findAllIn(haystack, needle)) {
			const key = `${found.start}:${found.end}`;
			if (seen.has(key) || !within(found.start, found.end, options)) continue;
			seen.add(key);
			exact.push({
				...found,
				method: "exact",
				score: scoreExact(text, found, annotation, bodyStart),
			});
		}
	}
	if (exact.length) {
		exact.sort((a, b) => b.score - a.score);
		return {
			start: exact[0].start,
			end: exact[0].end,
			method: "exact",
			score: exact[0].score,
		};
	}

	// Short quotes are too easy to match by accident; only exact matching is
	// safe for them.
	if (oldPlain.length < 12) return null;

	const candidates: Candidate[] = [];
	const seenCandidates = new Set<string>();
	const push = (start: number, end: number): void => {
		if (candidates.length >= MAX_CANDIDATES) return;
		const trimmed = trimRange(text, start, end);
		if (!within(trimmed.start, trimmed.end, options)) return;
		const key = `${trimmed.start}:${trimmed.end}`;
		if (seenCandidates.has(key)) return;
		seenCandidates.add(key);
		if (trimmed.end - trimmed.start > Math.max(400, quote.length * 2 + 200)) return;
		const candidatePlain = plain(text.slice(trimmed.start, trimmed.end));
		const sim = similarity(candidatePlain, oldPlain);
		if (!sim) return;
		const context = contextScore(text, trimmed.start, trimmed.end, annotation);
		const bracketed = context.before >= 0.6 && context.after >= 0.6;
		const required = bracketed
			? oldPlain.length < 40
				? 0.6
				: oldPlain.length < 120
					? 0.55
					: 0.5
			: oldPlain.length < 40
				? 0.82
				: oldPlain.length < 120
					? 0.74
					: 0.68;
		if (sim < required) return;
		const length = Math.max(1, oldPlain.length, candidatePlain.length);
		const lengthScore = Math.max(0, 1 - Math.abs(candidatePlain.length - oldPlain.length) / length);
		candidates.push({
			start: trimmed.start,
			end: trimmed.end,
			index: candidates.length,
			method: "fuzzy",
			score:
				sim * 10 +
				context.before * 2 +
				context.after * 2 +
				positionScore(trimmed.start, annotation, bodyStart) +
				lengthScore * 2,
		});
	};

	// 2. Context brackets. The stored prefix ends where the quote begins and the
	// suffix starts where it ends, so a changed quote is the text between them.
	const prefix = tailAnchor(annotation.prefix ?? "");
	const suffix = headAnchor(annotation.suffix ?? "");
	if (prefix.length >= MIN_ANCHOR_CHARS && suffix.length >= MIN_ANCHOR_CHARS) {
		const before = findAllIn(haystack, prefix).slice(0, 8);
		const after = findAllIn(haystack, suffix).slice(0, 8);
		for (const left of before) {
			for (const right of after) {
				if (right.start > left.end) push(left.end, right.start);
			}
		}
	}

	// 3. Quote-edge anchors. This is the fallback for annotations created before
	// prefix/suffix were stored, or for a document whose surrounding context was
	// rewritten along with the quote.
	const words = normalized(quote).split(" ");
	if (words.length >= 6) {
		const startAnchor = words.slice(0, 4).join(" ");
		const endAnchor = words.slice(-4).join(" ");
		if (startAnchor.length >= MIN_ANCHOR_CHARS && endAnchor.length >= MIN_ANCHOR_CHARS) {
			const starts = findAllIn(haystack, startAnchor).slice(0, 8);
			const ends = findAllIn(haystack, endAnchor).slice(0, 8);
			for (const left of starts) {
				for (const right of ends) {
					if (right.end > left.start) push(left.start, right.end);
				}
			}
		}
	}

	if (!candidates.length) return null;
	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0];
	// A weak best match should not displace a clear orphan. Exact matches are
	// handled above, so this only guards the fuzzy path.
	if (best.score < 6) return null;
	return { start: best.start, end: best.end, method: "fuzzy", score: best.score };
}
