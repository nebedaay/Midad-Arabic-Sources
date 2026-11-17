/**
 * Paint Qur'ān citation links with the text their settings ask for.
 *
 * Only Reading view is handled here: a link's *source* stays
 * `[[Q024#10]]`, which is what makes the format changeable without a
 * re-render. Live preview keeps showing the raw link until the editor
 * extension lands (see the roadmap entry in the plugin skill).
 *
 * The pass is one `querySelectorAll` per rendered chunk plus a parse and a
 * string join per anchor — no note lookup, no metadata read per citation. On a
 * 2.5 MB volume with 3,573 citations that measures at ~50 ms in a stubbed DOM;
 * the language is resolved once per note and cached.
 */

import type { App, Plugin, MarkdownPostProcessorContext, TFile } from "obsidian";
import { CitationStyle, formatCitation, parseQuranTarget } from "./citationFormat";

export interface QuranCitationHost {
	app: App;
	/** The style for a document language. */
	styleFor(language: "ar" | "en"): CitationStyle;
	/** The language of a note that does not say. */
	defaultLanguage(): "ar" | "en";
}

const ARABIC = /[\u0600-\u06FF]/;

/**
 * Frontmatter keys that decide a note's citation language, in order. The first
 * is the explicit override; `language` is the property every Midad note already
 * carries, which is why most notes need no extra key.
 */
const LANGUAGE_KEYS = ["quran-citation-language", "quran-citations"] as const;

let languageCache = new Map<string, "ar" | "en">();
let cacheGeneration = 0;

/** Drop the per-note language cache. Called when the settings change. */
export function invalidateQuranCitationCache(): void {
	cacheGeneration++;
	languageCache = new Map();
}

/**
 * A frontmatter language as a citation language.
 *
 * A declared language that is not Arabic still means the Latin style — a French
 * or Turkish note cites `(Q 24:10)`, not `(النور ١٠)`. Only a note that declares
 * nothing falls through to the plugin default.
 */
function asLanguage(value: unknown): "ar" | "en" | null {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase().replace(/^\[\[|\]\]$/g, "");
	if (!text) return null;
	if (text === "ar" || text === "arabic" || ARABIC.test(text)) return "ar";
	return "en";
}

/** The citation language of the note at `sourcePath`. */
export function documentLanguage(app: App, host: QuranCitationHost, sourcePath: string): "ar" | "en" {
	const key = `${cacheGeneration}:${sourcePath}`;
	const cached = languageCache.get(key);
	if (cached) return cached;
	let language: "ar" | "en" | null = null;
	const file = app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
	if (file) {
		const frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		for (const name of LANGUAGE_KEYS) {
			language = asLanguage(frontmatter[name]);
			if (language) break;
		}
		if (!language) {
			const value = frontmatter["language"];
			const list = Array.isArray(value) ? value : [value];
			for (const entry of list) {
				language = asLanguage(entry);
				if (language) break;
			}
		}
	}
	const resolved = language ?? host.defaultLanguage();
	languageCache.set(key, resolved);
	return resolved;
}

/** The minimum an anchor has to offer, so the pass is testable without a DOM. */
interface CitationAnchor {
	getAttribute(name: string): string | null;
	closest(selector: string): unknown;
	textContent: string | null;
	classList: { add(token: string): void };
}

/**
 * Rewrite the citation anchors inside one rendered fragment.
 *
 * Exported for the regression tests, which hand in fake anchors.
 */
export function paintCitations(root: ParentNode, style: CitationStyle): number {
	const anchors = Array.from(root.querySelectorAll("a.internal-link")) as unknown as CitationAnchor[];
	let painted = 0;
	for (const anchor of anchors) {
		if (anchor.closest("code, pre")) continue;
		const target = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
		const verse = parseQuranTarget(target);
		if (!verse) continue;
		const text = formatCitation(verse, style);
		anchor.classList.add("mas-quran-citation");
		if (anchor.textContent === text) continue;
		anchor.textContent = text;
		painted++;
	}
	return painted;
}

/** Repaint every open Reading view (after a settings change). */
export function refreshQuranCitations(app: App): void {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as unknown as { previewMode?: { rerender?: (full: boolean) => void } };
		view.previewMode?.rerender?.(true);
	}
}

/** Reading-view postprocessor. */
export function registerQuranCitations(plugin: Plugin, host: QuranCitationHost): void {
	plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		if (!el.querySelector("a.internal-link")) return;
		paintCitations(el, host.styleFor(documentLanguage(host.app, host, ctx.sourcePath)));
	});
}
