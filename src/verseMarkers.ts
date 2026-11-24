import { Plugin, editorInfoField, editorLivePreviewField } from "obsidian";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { DEFAULT_ARABIC_STYLE, formatCitation, formatMarker, parseQuranLink } from "./quran/citationFormat";
import { documentLanguage, isolateQuranText, type QuranCitationHost } from "./quran/citationRender";
import { openQuranCitation, paneForClick } from "./quran/openCitation";
import { textDirection } from "./quranQuote";

/**
 * A tafsīr marks the start of a new verse inline:
 *
 *     **[[004 An-Nisa#86|4:86]]**
 *     **[[006 Al-An'am#29|6:29]]–[[006 Al-An'am#30|6:30]]**
 *
 * The bold is structural, not decorative: a bare wikilink becomes an editor
 * widget that CSS cannot move, while the emphasis keeps the alias as ordinary
 * text. The plugin takes the marker out of the text flow and places it in the
 * gutter — left for an RTL text, right for an LTR one — beside the line where
 * the verse changes. It is never rendered bold, so a verse may change in the
 * middle of a sentence without breaking the paragraph.
 */

// Both aliases are recognised: today's `:`/`:12` and the older `22:5`, so a
// note rendered by the previous build still gets its line direction and size.
// A cheap prefilter. What a marker *is*, and what it prints, comes from the
// same two functions the reading view uses — `parseQuranLink` and
// `formatMarker` — so the two views cannot drift apart.
const MARKER = /\[\[((?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+)(?:\|([^\]]*))?\]\]/g;
const MARKER_TEXT = /^\d+:\d+(?:[–-]\d+:\d+)?$/;
const MARKER_CLASS = "mas-verse-marker";

/** Does this note cite the Qur'ān at all? The band is a property of the note,
 *  not of the paragraphs that happen to carry a marginal link: a tafsīr's pages
 *  must share one text column even where no verse begins, and a page with
 *  citations but no marker used to get no band at all — the text filled the
 *  width, and a re-render that found a citation added the class for a moment.
 *  Any verse link in the document is the evidence, asked once. */
const HAS_VERSE_LINK = /\[\[(?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+/;

/** Rendered characters within which two markers can share one line. */
const MARKER_REACH = 75;

/** Approximate the rendered text between two offsets (diacritics take no space). */
function renderedGap(text: string, start: number, end: number): number {
	if (end <= start) return 0;
	let count = 0;
	for (const ch of text.slice(start, end)) {
		if (!/\p{Mn}/u.test(ch)) count += 1;
	}
	return count;
}

function isMarkerLink(text: string): boolean {
	const clean = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]/g, "");
	// `22:5` is the painted locator; `:` or `:30` is the raw `|:` alias, which is
	// what an anchor shows before the citation painter has run. Accepting both
	// makes the margin independent of which post-processor goes first.
	return MARKER_TEXT.test(clean) || /^:[0-9]*$/.test(clean);
}

/**
 * Reading view: position every marker.
 *
 * A marker is now signalled by its `|:` alias, so `paintCitations` has already
 * tagged the anchor `mas-quran-marker` and painted its text. A note rendered by
 * an older build still carries the bold form, so the `<strong>` is accepted
 * too — that is the only reason the emphasis test survives here.
 */
function decorateReadingElement(root: HTMLElement): void {
	const placed = new Map<Element, HTMLElement[]>();
	const markers: HTMLElement[] = [];
	for (const strong of Array.from(root.querySelectorAll("strong"))) {
		if (!isMarkerLink(strong.textContent ?? "")) continue;
		// Obsidian may wrap the link in the bold (`<strong><a>`) or the bold in
		// the link (`<a><strong>`), depending on the parser; accept either.
		const link = (strong.querySelector("a.internal-link")
			?? strong.closest("a.internal-link"));
		if (!link) continue;
		strong.addClass(MARKER_CLASS);
		link.addClass("mas-verse-marker-link");
		markers.push(strong);
	}
	for (const anchor of Array.from(root.querySelectorAll("a.mas-quran-marker, a.internal-link"))) {
		if (!anchor.classList.contains("mas-quran-marker")
			&& !isMarkerLink(anchor.textContent ?? "")) continue;
		if (anchor.closest("strong")) continue;   // already collected above
		anchor.addClass(MARKER_CLASS);
		markers.push(anchor as HTMLElement);
	}
	// A marker is drawn beside its own anchor, so whether two collide is a
	// question about the *rendered* lines — answered here by measuring, once
	// the paragraphs have been laid out.
	const preview = root.closest(".markdown-preview-view");
	const english = preview instanceof HTMLElement
		&& /(^|\s)quran-en(\s|$)/.test(preview.className);
	for (const marker of markers) {
		const scope = marker.closest("p, li, div.el-p, .markdown-preview-section") ?? root;
		const list = placed.get(scope) ?? [];
		list.push(marker);
		placed.set(scope, list);
		// An English translation keeps its own face and direction; only an
		// Arabic paragraph needs the RTL paragraph class.
		if (!english) {
			const paragraph = marker.closest("p, li, div.el-p") as HTMLElement | null;
			if (paragraph) paragraph.addClass("mas-verse-paragraph");
		}
	}
	// Stack only the markers that actually share a rendered line. Two markers a
	// paragraph apart keep their own anchors and their own positions. The
	// measurement waits one frame, so the paragraph has its real layout (and
	// styles); an unlaid-out paragraph would make every marker look coincident.
	window.requestAnimationFrame(() => {
		for (const list of placed.values()) {
			const paragraph = list[0]?.closest("p, li, div.el-p") as HTMLElement | null;
			if (!paragraph || paragraph.getBoundingClientRect().height <= 0) continue;
			let previousTop: number | null = null;
			let ordinal = 0;
			for (const marker of list) {
				const top = marker.getBoundingClientRect().top;
				ordinal = previousTop != null && Math.abs(top - previousTop) < 8 ? ordinal + 1 : 0;
				if (ordinal > 0) marker.dataset.markerIndex = String(ordinal);
				else delete marker.dataset.markerIndex;
				previousTop = top;
			}
		}
	});
	for (const link of Array.from(root.querySelectorAll("a.internal-link"))) {
		const text = (link.textContent ?? "").trim();
		if (/^\d+:\d+(?:[–-]\d+:\d+)?$/.test(text)) link.addClass(MARKER_CLASS);
	}

}


interface Placed {
	from: number;
	to: number;
	value: Decoration;
}

/** A prose citation in Live Preview: the reading view's text, drawn inline.
 *  Exported for the regression tests, which pin the press behaviour. */
export class CitationWidget extends WidgetType {
	constructor(
		private readonly text: string,
		private readonly target: string,
		/** The citation is printed in Latin (`Q` over `2:24`), not Arabic. */
		private readonly latin = false,
	) {
		super();
	}

	// Obsidian 1.13.x / CM: when `eq()` compares equal, RangeSet.compare treats
	// the decoration as unchanged and CodeMirror skips rebuilding its DOM — so a
	// widget built before the note's style or the viewport settled stays
	// invisible until some later transaction (a cursor move or a scroll) forces
	// a re-render. Returning false makes CM treat it as changed on every
	// recompute and (re)create the element. Same fix ScholarWeft applies to its
	// Zotero citation widget.
	eq(): boolean {
		return false;
	}

	/**
	 * Keep the editor's hands off the widget — and read the name carefully,
	 * because it is inverted: `ignoreEvent` returning `true` means the editor
	 * *ignores* the event, so it is not also a selection gesture.
	 *
	 * Returning `false` (what this used to do) told CodeMirror to handle the
	 * press itself: it moved the cursor into the citation's range, Live Preview
	 * immediately drew that link as source, and the widget was destroyed before
	 * `click` arrived. The first click therefore revealed `[[…]]` instead of
	 * opening the sūra, and the second landed inside the visible alias, whose
	 * only behaviour is to be edited — the link turned into text. The widget has
	 * to survive the press for the click to reach the opener below.
	 */
	ignoreEvent(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = this.latin ? "mas-quran-citation is-latin" : "mas-quran-citation";
		span.dataset.href = this.target;
		span.textContent = this.text;
		return span;
	}
}

/** The margin's link in Live Preview: the locator, drawn in the gutter.
 *  Exported for the regression tests, which pin the press behaviour. */
export class MarkerWidget extends WidgetType {
	constructor(
		private readonly text: string,
		private readonly target: string,
		private readonly index: number,
	) {
		super();
	}

	// Obsidian 1.13.x / CM: when `eq()` compares equal, RangeSet.compare treats
	// the decoration as unchanged and CodeMirror skips rebuilding its DOM — so a
	// widget built before the note's style or the viewport settled stays
	// invisible until some later transaction (a cursor move or a scroll) forces
	// a re-render. Returning false makes CM treat it as changed on every
	// recompute and (re)create the element. Same fix ScholarWeft applies to its
	// Zotero citation widget.
	eq(): boolean {
		return false;
	}

	/** As the citation widget: the press is ours, not the editor's. A press the
	 *  editor handled would move the cursor into the marker's link and destroy
	 *  the widget before the click that opens the verse. */
	ignoreEvent(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = MARKER_CLASS;
		span.dataset.href = this.target;
		if (this.index > 0) span.dataset.markerIndex = String(this.index);
		span.textContent = this.text;
		return span;
	}
}

/** The citation style of the note this editor shows. */
function styleForView(view: EditorView) {
	if (!citationHost) return DEFAULT_ARABIC_STYLE;
	const info = view.state.field(editorInfoField, false);
	const path = info?.file?.path ?? "";
	const language = path
		? documentLanguage(citationHost.app, citationHost, path)
		: citationHost.defaultLanguage();
	return citationHost.styleFor(language);
}

function buildMarkerDecorations(view: EditorView): DecorationSet {
	const style = styleForView(view);
	const builder = new RangeSetBuilder<Decoration>();
	const decoratedLines = new Set<number>();
	const placed: Placed[] = [];
	// At construction the editor has no layout yet, so `visibleRanges` is empty
	// and the first pass would decorate nothing — leaving the note bare until
	// something else forced an update. Falling back to the whole document on
	// that one pass is what makes a freshly opened note render immediately.
	const ranges = view.visibleRanges.length
		? view.visibleRanges
		: [{ from: 0, to: view.state.doc.length }];
	for (const range of ranges) {
		const text = view.state.doc.sliceString(range.from, range.to);
		MARKER.lastIndex = 0;
		let match: RegExpExecArray | null;
		let ordinal = 0;
		let lastMarkerEnd = -1;
		while ((match = MARKER.exec(text)) !== null) {
			const markerStart = range.from + match.index;
			// Source when the cursor is inside, rendered when it leaves — the
			// ScholarWeft behaviour for a citation. The decoration is simply not
			// built for a range the selection touches, so the note's own text is
			// what the editor shows there.
			const matchEnd = markerStart + match[0].length;
			// Keep the citation rendered unless the selection is genuinely inside
			// it: a cursor resting *beside* the link must not suppress it, which a
			// containment-only test gets wrong in both directions.
			const inside = view.state.selection.ranges.some(
				(r) => r.from > markerStart && r.to < matchEnd);
			if (inside) continue;
			const bar = match[0].indexOf("|");
			const aliasStart = markerStart + bar + 1;
			const aliasEnd = aliasStart + (match[2]?.length ?? 0);
			// CodeMirror already hides the emphasis markers; decorating only the
			// link text avoids overlapping its own replacements.
			const line = view.state.doc.lineAt(markerStart);
			if (!decoratedLines.has(line.from)) {
				decoratedLines.add(line.from);
			// The `dir` attribute is only a hint, and CodeMirror/Obsidian set
			// their own on the line widget — the one that wins is the attribute,
			// not ours, which is why an Arabic line with a leading LTR link was
			// laid out left-to-right and the reader met the prose before the
			// quotations. `direction` in the inline style is the property that
			// actually orders the runs, so it is set there, per line, from the
			// line's own text.
			// The line's *reading* direction, not whether it contains any
			// Arabic: an English paragraph that quotes two Arabic words is an
			// English paragraph, and asking whether the line contained Arabic at
			// all laid it out right-to-left.
			const rtl = textDirection(line.text) === "rtl";
			placed.push({
				from: line.from,
				to: line.from,
				value: Decoration.line({
					attributes: {
						dir: rtl ? "rtl" : "ltr",
						style: "position: relative;"
							+ `direction: ${rtl ? "rtl" : "ltr"};`
							+ "font-family: var(--latin-font), var(--arabic-font), serif;"
							+ "font-size: var(--arabic-font-size);"
							+ "line-height: var(--arabic-line-height);"
					},
				}),
			});
			}
			// Markers are drawn beside their own anchor, so two only collide when
			// they would land on the same rendered line. Nothing knows where the
			// wrap falls; anchors this close are the ones at risk, and farther apart
			// they are ordinary separate links (the pipeline keeps those unmerged).
			// Measure from the previous marker's end, so the marker's own source text
			// is not counted as text between them.
			// The shared parser decides: an alias containing `:` is a marker,
			// whether it is today's `:`/`:12` or the older `22:15`.
			const verse = parseQuranLink(match[1], match[2] ?? "");
			if (!verse) continue;
			if (!verse.marker) {
				// A citation in the prose: same parse, same formatter, same
				// isolate as Reading view — only the element it is drawn into
				// differs.
				// Replace the link's inner text, not the whole `[[…]]`.
				//
				// A replace covering the entire wikilink is dropped a moment after
				// it paints: Obsidian re-renders its own link decoration for the
				// same range and takes the range over. The evidence is in this
				// same pass — markers survive because they decorate the alias
				// *inside* the link, while citations, replacing the link itself,
				// flash and vanish. The brackets are hidden by Obsidian anyway, so
				// the inner text is the whole of what a reader sees.
				// Whatever the link shows is what must be replaced: an alias if it
				// has one (`[[Q022#20|21]]` shows `21`), otherwise the target text.
				// Replacing only the target left the alias visible, which is how a
				// range printed as a bare `21`.
				const visibleStart = match[2] ? markerStart + 2 + match[1].length + 1 : markerStart + 2;
				const visibleLength = match[2] ? match[2].length : match[1].length;
				placed.push({
					from: visibleStart,
					to: visibleStart + visibleLength,
					value: Decoration.replace({
						widget: new CitationWidget(
							isolateQuranText(formatCitation(verse, style, { lines: true })),
							match[1],
							style.names !== "arabic"),
					}),
				});
				continue;
			}
			const gap = lastMarkerEnd < 0 ? Infinity : renderedGap(text, lastMarkerEnd, match.index);
			ordinal = gap <= MARKER_REACH ? ordinal + 1 : 0;
			lastMarkerEnd = match.index + match[0].length;
			// The alias is the *signal*, not the label: `:` and `:12` say "this is
			// the margin", and `formatMarker` prints the locator — the very call the
			// reading view makes, so a named sūra or Indic digits apply in both.
			const label = formatMarker(verse, style);
			placed.push({
				from: aliasStart,
				to: aliasEnd,
				value: Decoration.replace({
					widget: new MarkerWidget(label, match[1], ordinal),
				}),
			});
		}
	}
	if (placed.length) {
		// The band is a property of the note: every line reserves it, exactly as
		// every paragraph does in Reading view, so the text column is one width
		// whether or not a line carries a marker.
		view.dom.classList.add("mas-verse-margin");
	}
	placed.sort((a, b) => a.from - b.from || a.to - b.to);
	for (const item of placed) builder.add(item.from, item.to, item.value);
	return builder.finish();
}

let app: import("obsidian").App | null = null;
let citationHost: QuranCitationHost | null = null;

/** A positioned marker sits outside the line's hit-testing, so CodeMirror does
 *  not follow it; open the link ourselves.
 *
 *  A citation widget carries `data-href` too, and so does the source link that
 *  replaces it once the cursor is inside — the two are the same target in two
 *  states. Clicking a widget, though, can *cause* that replacement: CodeMirror
 *  handles `pointerdown`, moves the cursor into the link, and rebuilds the line
 *  before `click` arrives, so the element under the pointer at click time is no
 *  longer the one that was clicked. The href is therefore remembered at
 *  pointerdown and used at click, which is what makes the first click work.
 *
 *  Suppressing the pointerdown instead was tried and is wrong: it is CodeMirror's
 *  own selection gesture, and the event that opens the link has to be the one
 *  the reader finished with.
 */
let pendingHref: string | null = null;
let pendingAt = 0;

/** The two elements whose clicks this module owns. A plain `[data-href]` is
 *  Obsidian's: routing every link in every note through the citation opener
 *  made this plugin the handler for links that have nothing to do with the
 *  Qur'ān. */
const OWN_WIDGET = ".mas-quran-citation, .mas-verse-marker";

function rememberCitation(event: MouseEvent): void {
	if (event.button !== 0) return;
	const target = event.target as HTMLElement | null;
	const marker = target?.closest(OWN_WIDGET) as HTMLElement | null;
	const href = marker?.dataset.href;
	if (!href) {
		pendingHref = null;
		return;
	}
	pendingHref = href;
	pendingAt = Date.now();
}

function handleMarkerClick(event: MouseEvent): void {
	if (event.button !== 0) return;
	const target = event.target as HTMLElement | null;
	const marker = target?.closest(OWN_WIDGET) as HTMLElement | null;
	const remembered = pendingHref && Date.now() - pendingAt < 1500 ? pendingHref : null;
	const href = marker?.dataset.href ?? remembered;
	pendingHref = null;
	if (!href || !app) return;
	// Obsidian's link layer reads `data-href` on the editor's DOM too, and it
	// would open the same file again in this tab after us.
	event.preventDefault();
	event.stopImmediatePropagation();
	const editor = marker?.closest(".cm-editor") as HTMLElement | null;
	const view = editor ? EditorView.findFromDOM(editor) : null;
	const sourcePath = view?.state.field(editorInfoField, false)?.file?.path ?? "";
	void openQuranCitation(app, href, sourcePath, paneForClick(event));
}

/**
 * Put the band on the note's view, where the stylesheet looks for it.
 *
 * The rules name `.markdown-source-view` / `.markdown-preview-view`, because
 * that is the element whose width is the note's text column, and the editor's
 * own `.cm-editor` as well, because that is the element that survives while the
 * view mounts and re-mounts. Both are classed.
 *
 * The verdict is cached against the document object: `Text` is immutable and
 * compares by identity, so the document is scanned once per version — not on
 * every keystroke and cursor move, which would be an O(note) test each time.
 */
let bandedDoc: import("@codemirror/state").Text | null = null;
let banded = false;

function bandDocument(dom: HTMLElement, doc: import("@codemirror/state").Text): void {
	if (bandedDoc !== doc) {
		bandedDoc = doc;
		banded = HAS_VERSE_LINK.test(doc.toString());
	}
	if (!banded) return;
	const view = dom.closest(".markdown-source-view");
	if (view) view.classList.add("mas-verse-margin");
	dom.classList.add("mas-verse-margin");
}

const verseMarkerExtension = ViewPlugin.fromClass(
	class {
		constructor(readonly view: EditorView) {
			const dom = view.dom as HTMLElement;
			bandDocument(dom, view.state.doc);
			if (!dom.dataset.masVerseClick) {
				dom.dataset.masVerseClick = "1";
				// Remember the href while it is still under the pointer, and act
				// on the click. `pointerdown` is CodeMirror's selection gesture,
				// so it is observed, never prevented.
				dom.addEventListener("pointerdown", rememberCitation, true);
				dom.addEventListener("click", handleMarkerClick, true);
			}
		}

		/**
		 * Computed on demand by the decorations facet, never cached in `update()`.
		 *
		 * Obsidian 1.13.x / CM reads the decorations facet (ViewState.update →
		 * updateDeco) *before* it runs plugin `update()` methods. A set cached
		 * there is one render stale: the replace-widgets land a transaction late
		 * and CodeMirror sees no change, so nothing is drawn until another
		 * transaction (a cursor move) forces a re-render — and the set handed back
		 * is the previous state's, which is why a widget could vanish again as
		 * soon as the cursor left it. Computing here means the facet always
		 * reflects the current document and selection. Same fix ScholarWeft uses
		 * for its Zotero citation widgets.
		 */
		mkDeco(): DecorationSet {
			// The band is the note's, and this runs on every recompute: the note
			// may have been mounted before its text was in the state, so the
			// construction-time verdict can be the wrong one.
			bandDocument(this.view.dom as HTMLElement, this.view.state.doc);
			// Decorate only while the editor is in Live Preview, as ScholarWeft
			// does. In source view the note must show its own text, and a
			// replacement decoration still in flight from the previous mode is one
			// of the ways a citation can flash and then vanish.
			if (!this.view.state.field(editorLivePreviewField, false)) {
				return new RangeSetBuilder<Decoration>().finish();
			}
			return buildMarkerDecorations(this.view);
		}

		update(update: ViewUpdate): void {
			/* nothing cached; the facet calls `mkDeco()`. A note that gains its
			   first marker keeps the band from then on. */
			bandDocument(update.view.dom, update.view.state.doc);
		}
	},
	{ decorations: (plugin) => plugin.mkDeco() }
);

/** Render inline tafsīr verse markers in the note's right margin. */
export function registerVerseMarkers(plugin: Plugin, host?: QuranCitationHost): void {
	app = plugin.app;
	citationHost = host ?? null;
	plugin.registerEditorExtension(verseMarkerExtension);
	plugin.registerMarkdownPostProcessor((el) => {
		decorateReadingElement(el);
	});
}
