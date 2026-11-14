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
 */
function findSpans(text: string): Span[] {
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
		if (value.includes(OPEN) || value.includes(MARK_OPEN)) nodes.push(node);
	}
	for (const node of nodes) {
		const parent = node.parentElement;
		if (!parent || parent.closest(`code, pre, a, .${QUOTE_CLASS}, .quran-quote`)) continue;
		const text = node.nodeValue ?? "";
		const spans = findSpans(text);
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
			const spans = findSpans(text);
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
