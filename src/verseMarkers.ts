import { Plugin } from "obsidian";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * A tafsīr marks the start of a new verse inline:
 *
 *     **[[004 An-Nisa#86|4:86]]**
 *     **[[006 Al-An'am#29|6:29]]–[[006 Al-An'am#30|6:30]]**
 *
 * The bold is only a signal: the plugin takes the marker out of the text flow
 * and places the reference in the note's right margin, beside the line where
 * the verse changes. It is never rendered bold, so a verse may change in the
 * middle of a sentence without breaking the paragraph.
 */

const MARKER = /\*\*\[\[(\d{3}[^#\]]*#\d+)\|(\d+:\d+(?:[–-]\d+:\d+)?)\]\]\*\*/g;
const MARKER_TEXT = /^\d+:\d+(?:[–-]\d+:\d+)?$/;
const MARKER_CLASS = "mas-verse-marker";
/** `## [[004 An-Nisa#153|Ḥafṣ 153]]` — a riwāya correspondence link. */
const RIWAYA_LINK = /^##\s+\[\[(\d{3}[^#\]]*#\d+)\|([^\]]+)\]\]/m;

function isMarkerLink(text: string): boolean {
	const clean = text.replace(/[\u200e\u200f\u202a-\u202e\s]/g, "");
	return MARKER_TEXT.test(clean);
}

/** Reading view: tag the <strong> that wraps a marker link. */
function decorateReadingElement(root: HTMLElement): void {
	let found = false;
	for (const strong of Array.from(root.querySelectorAll("strong"))) {
		if (!isMarkerLink(strong.textContent ?? "")) continue;
		// Obsidian may wrap the link in the bold (`<strong><a>`) or the bold in
		// the link (`<a><strong>`), depending on the parser; accept either.
		const link = (strong.querySelector("a.internal-link")
			?? strong.closest("a.internal-link"));
		if (!link) continue;
		strong.addClass(MARKER_CLASS);
		link.addClass("mas-verse-marker-link");
		const paragraph = strong.closest("p, li, div.el-p") as HTMLElement | null;
		if (paragraph) paragraph.addClass("mas-verse-paragraph");
		found = true;
	}
	if (found) {
		tagContainer(root, ".markdown-preview-view");
		const section = root.closest(".markdown-preview-section");
		if (section.instanceOf(HTMLElement)) section.addClass("mas-verse-section");
	}
}

/** The note's own `cssclasses` may be absent; tag the view so the margin rules
 *  apply. */
function tagContainer(el: HTMLElement, selector: string): void {
	const container = el.closest(selector);
	if (container.instanceOf(HTMLElement)) container.classList.add("tafsir");
}

interface Placed {
	from: number;
	to: number;
	value: Decoration;
}

function buildMarkerDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const placed: Placed[] = [];
	for (const range of view.visibleRanges) {
		const text = view.state.doc.sliceString(range.from, range.to);
		MARKER.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = MARKER.exec(text)) !== null) {
			const markerStart = range.from + match.index;
			const markerEnd = markerStart + match[0].length;
			const bar = match[0].indexOf("|");
			const aliasStart = markerStart + bar + 1;
			const aliasEnd = aliasStart + (match[2]?.length ?? 0);
			// Hide only the `**`; the link text itself gets the marker class,
			// which is a real text range (unlike the link syntax around it).
			placed.push({ from: markerStart, to: markerStart + 2, value: Decoration.replace({}) });
			placed.push({ from: markerEnd - 2, to: markerEnd, value: Decoration.replace({}) });
			const line = view.state.doc.lineAt(markerStart);
			placed.push({
				from: line.from,
				to: line.from,
				value: Decoration.line({
					attributes: {
						dir: "rtl",
						style: "position: relative;"
							+ "font-family: var(--latin-font), var(--arabic-font), serif;"
							+ "font-size: var(--arabic-font-size);"
							+ "line-height: var(--arabic-line-height);",
					},
				}),
			});
			placed.push({
				from: aliasStart,
				to: aliasEnd,
				value: Decoration.mark({
					class: MARKER_CLASS,
					attributes: {
						"data-href": match[1],
						style: "position:absolute;left:calc(100% + 7px);right:auto;top:auto;margin:0;padding:0;width:auto;"
							+ "font-family:var(--latin-font),serif;font-size:12px;font-weight:normal;line-height:1.1;"
							+ "color:var(--link-color);white-space:nowrap;direction:ltr;text-align:left;z-index:2;"
							+ "font-style:normal;text-decoration:none;",
					},
				}),
			});
		}
		const link = RIWAYA_LINK.exec(text);
		if (link) {
			const lineStart = view.state.doc.lineAt(range.from + link.index).from;
			const bar = link[0].indexOf("|");
			const close = link[0].lastIndexOf("]]");
			const aliasStart = lineStart + bar + 1;
			const aliasEnd = lineStart + close;
			placed.push({
				from: aliasStart,
				to: aliasEnd,
				value: Decoration.mark({
					class: "mas-riwaya-link",
					attributes: { "data-href": link[1] },
				}),
			});
		}
	}
	placed.sort((a, b) => a.from - b.from || a.to - b.to);
	for (const item of placed) builder.add(item.from, item.to, item.value);
	return builder.finish();
}

let app: import("obsidian").App | null = null;

/** A positioned marker sits outside the line's hit-testing, so CodeMirror does
 *  not follow it; open the link ourselves. */
function handleMarkerClick(event: MouseEvent): void {
	const target = event.target as HTMLElement | null;
	const marker = target?.closest("[data-href]") as HTMLElement | null;
	const href = marker?.dataset.href;
	if (!href || !app) return;
	event.preventDefault();
	event.stopPropagation();
	void app.workspace.openLinkText(href, "", false);
}

const verseMarkerExtension = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildMarkerDecorations(view);
			if (this.decorations.size) {
				tagContainer(view.dom, ".markdown-source-view");
				if (!(view.dom).dataset.masVerseClick) {
					(view.dom).dataset.masVerseClick = "1";
					view.dom.addEventListener("mousedown", handleMarkerClick, true);
				}
			}
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildMarkerDecorations(update.view);
				if (this.decorations.size) tagContainer(update.view.dom, ".markdown-source-view");
			}
		}
	},
	{ decorations: (value) => value.decorations }
);

/** Render inline tafsīr verse markers in the note's right margin. */
export function registerVerseMarkers(plugin: Plugin): void {
	app = plugin.app;
	plugin.registerEditorExtension(verseMarkerExtension);
	plugin.registerMarkdownPostProcessor((el) => {
		decorateReadingElement(el);
	});
}
