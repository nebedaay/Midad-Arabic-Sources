import { Plugin } from "obsidian";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * A tafsīr imported from a corpus numbers each verse with an H1, exactly as a
 * Qur'ān page numbers its āyāt:
 *
 *     # 12
 *
 *     **[[002 Al-Baqarah#12|2:12]]**…
 *
 * On a Qur'ān page that heading becomes the gold emblem in the gutter. A tafsīr
 * keeps it as an ordinary heading unless it is told otherwise, so this marks a
 * *numeric* heading only — a tafsīr's own `# title` (a transcribed print edition
 * has one) stays a heading. The styling itself lives in `styles.css`.
 */

const NUMBER_HEADING = /^#[ \t]+[0-9\u0660-\u0669]+(?:[\u2013\u2014-][0-9\u0660-\u0669]+)?[ \t]*$/;
const LINE_CLASS = "mas-verse-number";

/**
 * Reading view: tag a numeric `<h1>`.
 *
 * The genre is deliberately *not* tested here: a markdown postprocessor
 * receives a detached fragment, so no ancestor is reachable yet. The class is
 * harmless on another genre, and `styles.css` scopes every rule to `.tafsir`,
 * where the ancestor is available at style time.
 */
function decorateReadingElement(root: HTMLElement): void {
	const headings = root.matches("h1") ? [root] : Array.from(root.querySelectorAll("h1"));
	for (const heading of headings) {
		if (!/^[0-9\u0660-\u0669]+(?:[\u2013\u2014-][0-9\u0660-\u0669]+)?$/.test((heading.textContent ?? "").trim())) continue;
		heading.addClass(LINE_CLASS);
	}
}

function buildNumberDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const last = view.state.doc.lines;
	for (const range of view.visibleRanges) {
		let line = view.state.doc.lineAt(range.from);
		while (line.number <= last) {
			if (NUMBER_HEADING.test(line.text)) {
				builder.add(line.from, line.from, Decoration.line({ class: LINE_CLASS }));
			}
			if (line.to >= range.to || line.number === last) break;
			line = view.state.doc.line(line.number + 1);
		}
	}
	return builder.finish();
}

const verseNumberExtension = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildNumberDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildNumberDecorations(update.view);
			}
		}
	},
	{ decorations: (value) => value.decorations }
);

/** Style a tafsīr's numeric verse headings like a Qur'ān verse emblem. */
export function registerVerseNumberHeadings(plugin: Plugin): void {
	plugin.registerEditorExtension(verseNumberExtension);
	plugin.registerMarkdownPostProcessor((el) => {
		decorateReadingElement(el);
	});
}
