import { Plugin } from "obsidian";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const QUOTE_CLASS = "mas-quran-quote";

/** Invisible boundaries: a quote can start or end without a visible mark. */
const MARK_OPEN = "~﴿~";
const MARK_CLOSE = "~﴾~";
const OPEN = "﴿";
const CLOSE = "﴾";

interface Span {
	/** Start of the styled text (after an invisible opener). */
	start: number;
	/** End of the styled text (before an invisible closer). */
	end: number;
	/** Invisible markers inside this span, to hide. */
	hidden: Array<[number, number]>;
}

/** The earliest opener at or after `from`, with its length. */
function nextOpen(text: string, from: number): { at: number; len: number } | null {
	const visible = text.indexOf(OPEN, from);
	const hidden = text.indexOf(MARK_OPEN, from);
	if (visible < 0 && hidden < 0) return null;
	if (hidden >= 0 && (visible < 0 || hidden < visible)) return { at: hidden, len: MARK_OPEN.length };
	return { at: visible, len: OPEN.length };
}

/** The earliest closer at or after `from`. */
function nextClose(text: string, from: number): { at: number; len: number } | null {
	const visible = text.indexOf(CLOSE, from);
	const hidden = text.indexOf(MARK_CLOSE, from);
	if (visible < 0 && hidden < 0) return null;
	if (hidden >= 0 && (visible < 0 || hidden < visible)) return { at: hidden, len: MARK_CLOSE.length };
	return { at: visible, len: CLOSE.length };
}

/**
 * Split a chunk of text into styled spans.
 *
 * A span opens with `﴿` or `~﴿~` and closes with `﴾` or `~﴾~`. An opener with
 * no closer styles the rest of the chunk (the quote continues on the next
 * page), and a closer with no opener styles from the chunk start (it began on
 * the previous page). That is what lets a quote cross a page break: each half
 * is styled on its own, with the visible parens only where they belong.
 *
 * In a left-to-right chunk the pair is written the other way round — `﴾…﴿` —
 * because the marks are mirrored there. Read by their Arabic meaning, the first
 * `﴾` styles all the prose before it and the `﴿` styles all the prose after,
 * gilding everything *except* the quotation. The chunk's own first mark says
 * which way it writes them, and swapping the two characters is enough: the
 * swap is one character for one character, so every offset still points at the
 * same place in the original text.
 */
export function findSpans(raw: string, ltr = false): Span[] {
	const text = ltr && firstOrnate(raw) === CLOSE ? swapOrnate(raw) : raw;
	const spans: Span[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const open = nextOpen(text, cursor);
		const close = nextClose(text, cursor);
		if (!open && !close) break;
		if (close && (!open || close.at < open.at)) {
			// Continuation half: style from here to the closer.
			const hidden: Array<[number, number]> = [];
			if (text.startsWith(MARK_CLOSE, close.at)) hidden.push([close.at, close.at + close.len]);
			spans.push({ start: cursor, end: close.at + close.len, hidden });
			cursor = close.at + close.len;
			continue;
		}
		if (!open) break;
		const afterOpen = open.at + open.len;
		const hidden: Array<[number, number]> = [];
		const invisibleOpen = text.startsWith(MARK_OPEN, open.at);
		if (invisibleOpen) hidden.push([open.at, afterOpen]);
		const end = nextClose(text, afterOpen);
		if (!end) {
			spans.push({ start: invisibleOpen ? afterOpen : open.at, end: text.length, hidden });
			break;
		}
		if (text.startsWith(MARK_CLOSE, end.at)) hidden.push([end.at, end.at + end.len]);
		spans.push({ start: invisibleOpen ? afterOpen : open.at, end: end.at + end.len, hidden });
		cursor = end.at + end.len;
	}
	return spans;
}

/** `text` with the two ornate parens exchanged, position for position. */
function swapOrnate(text: string): string {
	return text.replace(/[\ufd3f\ufd3e]/g, (char) => (char === OPEN ? CLOSE : OPEN));
}

/** The first *visible* ornate paren in `text`, or "" if there is none. */
function firstOrnate(text: string): string {
	const open = text.indexOf(OPEN);
	const close = text.indexOf(CLOSE);
	if (open < 0) return close < 0 ? "" : CLOSE;
	if (close < 0) return OPEN;
	return open < close ? OPEN : CLOSE;
}

/** Does this chunk read left to right? Decided by its first strong character,
 *  with links and their aliases removed first: a line that begins with a verse
 *  link (`[[Q022#5|:]]لِكَيْلَا…`) is Arabic, and its `Q022` must not make the
 *  chunk look Latin. The computed `direction` is not usable here — a `mas-quran`
 *  callout is deliberately laid out LTR so a theme's border stays on the left,
 *  and its Arabic paragraphs would then be read as reversed. */
export function isLtrText(text: string): boolean {
	return textDirection(text) === "ltr";
}

/**
 * The base direction a line should be laid out with, or `null` when it holds no
 * strong character at all.
 *
 * The *first* strong character decides, which is what a bidirectional layout
 * does: an English paragraph that happens to quote two Arabic words is still an
 * English paragraph, and asking whether a line "contains Arabic" turned such a
 * paragraph right-to-left. Links are stripped first, because a citation's sūra
 * name (`Q024`) is Latin whatever the sentence is written in — that is what kept
 * an Arabic line led by a verse link from being laid out left-to-right.
 */
export function textDirection(text: string): "ltr" | "rtl" | null {
	const stripped = text.replace(/\[\[[^\]]*\]\]/g, " ").replace(/[*_~`]/g, "");
	for (const char of stripped) {
		if (/[A-Za-z]/.test(char)) return "ltr";
		if (/[\u0600-\u06FF]/.test(char)) return "rtl";
	}
	return null;
}

/** `text` with the invisible markers removed. */
function withoutMarks(text: string): string {
	return text.split(MARK_OPEN).join("").split(MARK_CLOSE).join("");
}

function decorateReadingElement(root: HTMLElement): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		const value = node.nodeValue ?? "";
		// A *closing* half contains no opener: `… بَهِيجٍ﴾` is the second page of
		// a quotation whose `﴿` is on the first, and it is still a quotation.
		// Collecting only nodes with an opener left every such half plain while
		// its partner was gilded.
		if (value.includes(OPEN) || value.includes(CLOSE)
			|| value.includes(MARK_OPEN) || value.includes(MARK_CLOSE)) nodes.push(node);
	}
	for (const node of nodes) {
		const parent = node.parentElement;
		if (!parent || parent.closest(`code, pre, a, .${QUOTE_CLASS}, .quran-quote`)) continue;
		const text = node.nodeValue ?? "";
		const spans = findSpans(text, isLtrText(parent.textContent ?? text));
		if (!spans.length) continue;
		const fragment = createFragment();
		let cursor = 0;
		for (const span of spans) {
			if (span.start > cursor) fragment.append(withoutMarks(text.slice(cursor, span.start)));
			const span_text = text.slice(span.start, span.end);
			const element = createSpan({ cls: QUOTE_CLASS });
			element.textContent = withoutMarks(span_text);
			fragment.append(element);
			cursor = span.end;
		}
		if (cursor < text.length) fragment.append(withoutMarks(text.slice(cursor)));
		node.replaceWith(fragment);
	}
}

interface Placed {
	from: number;
	to: number;
	value: Decoration;
}

function buildQuoteDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const placed: Placed[] = [];
	for (const range of view.visibleRanges) {
		let line = view.state.doc.lineAt(range.from);
		while (line.from <= range.to) {
			const text = line.text;
			const spans = findSpans(text, isLtrText(text));
			for (const span of spans) {
				if (span.end > span.start) {
					placed.push({
						from: line.from + span.start,
						to: line.from + span.end,
						value: Decoration.mark({ class: QUOTE_CLASS }),
					});
				}
				for (const [start, end] of span.hidden) {
					placed.push({
						from: line.from + start,
						to: line.from + end,
						value: Decoration.replace({}),
					});
				}
			}
			if (line.to >= range.to) break;
			line = view.state.doc.line(line.number + 1);
		}
	}
	placed.sort((a, b) => a.from - b.from || a.to - b.to);
	for (const item of placed) builder.add(item.from, item.to, item.value);
	return builder.finish();
}

const quranQuoteExtension = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildQuoteDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildQuoteDecorations(update.view);
			}
		}
	},
	{ decorations: (value) => value.decorations }
);

/** Render bare ﴿ … ﴾ spans like the old Markdown-Attributes quran-quote class. */
export function registerQuranQuoteRendering(plugin: Plugin): void {
	plugin.registerEditorExtension(quranQuoteExtension);
	plugin.registerMarkdownPostProcessor((el) => {
		decorateReadingElement(el);
	});
}
