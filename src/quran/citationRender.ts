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
import { CitationStyle, formatCitation, formatMarker, parseQuranLink } from "./citationFormat";
import { textDirection } from "../quranQuote";

export interface QuranCitationHost {
	app: App;
	/** The style for a document language. */
	styleFor(language: "ar" | "en"): CitationStyle;
	/** The language of a note that does not say. */
	defaultLanguage(): "ar" | "en";
	/**
	 * The folders the pipeline writes translations and transcriptions to, when
	 * the host knows them. A translation is an English document and a
	 * transcription an Arabic one, so the folder is a genre statement for notes
	 * that carry no other sign.
	 */
	translationsFolder?(): string;
	transcriptionsFolder?(): string;
}

const ARABIC = /[\u0600-\u06FF]/;

/**
 * Frontmatter keys that decide a note's citation language, in order. The first
 * is the explicit override; `language` is the property every Midad note already
 * carries, which is why most notes need no extra key.
 */
const LANGUAGE_KEYS = ["quran-citation-language", "quran-citations"] as const;

/** The genre MOCs and note classes the renderer writes for its own documents. */
const TRANSLATION_MOC = "arabic translations";
const TRANSCRIPTION_MOC = "arabic transcriptions";

let languageCache = new Map<string, "ar" | "en" | null>();
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

/** A property value as a list of strings, whether it was written as one or not. */
function asList(value: unknown): string[] {
	if (value == null) return [];
	return (Array.isArray(value) ? value : [value]).map((entry) => String(entry));
}

/** A frontmatter link as a bare lowercase name: `[[Arabic stories]]` → `arabic stories`. */
function bareName(value: unknown): string {
	const text = String(value ?? "").trim().replace(/^\[\[|\]\]$/g, "");
	return (text.split("|")[0] ?? "").trim().toLowerCase();
}

/**
 * The language a note declares by *being* a translation or a transcription.
 *
 * A Midad translation is an English document and a transcription an Arabic one,
 * and the renderer already writes that fact twice: as the genre link in
 * `midad-up` (`[[Arabic translations]]`, `[[@citekey - translation]]`) and, for
 * a tafsīr, as the gutter class (`tafsir-en` / `tafsir`). Both are structural —
 * the pipeline wrote them from the document's own type — so they are read
 * before any guess at the text. The folder is the last of these: it covers a
 * note the pipeline did not make, filed where the user keeps translations.
 */
function genreLanguage(
	frontmatter: Record<string, unknown>,
	sourcePath: string,
	host: QuranCitationHost
): "ar" | "en" | null {
	// The gutter class is the most specific statement: the renderer writes
	// `tafsir-en` for a translated tafsīr and `tafsir` for an Arabic one.
	for (const entry of asList(frontmatter["cssclasses"])) {
		const name = bareName(entry);
		if (name === "tafsir-en" || name === "translation-en") return "en";
		if (name === "tafsir") return "ar";
	}
	for (const entry of asList(frontmatter["midad-up"])) {
		const name = bareName(entry);
		if (name === TRANSLATION_MOC || name.includes(" - translation")) return "en";
	}
	for (const entry of asList(frontmatter["midad-up"])) {
		const name = bareName(entry);
		if (name === TRANSCRIPTION_MOC || name.includes(" - transcription")) return "ar";
	}
	const path = sourcePath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
	for (const [folder, language] of [
		[host.translationsFolder?.(), "en"],
		[host.transcriptionsFolder?.(), "ar"],
	] as const) {
		const root = (folder ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		if (root && (path === root || path.startsWith(`${root}/`))) return language;
	}
	return null;
}

/** The language a note declares, or `null` when it declares none. */
export function declaredLanguage(app: App, host: QuranCitationHost, sourcePath: string): "ar" | "en" | null {
	const key = `${cacheGeneration}:${sourcePath}`;
	if (languageCache.has(key)) return languageCache.get(key) ?? null;
	let language: "ar" | "en" | null = null;
	const file = app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
	let frontmatter: Record<string, unknown> = {};
	if (file) {
		frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		for (const name of LANGUAGE_KEYS) {
			language = asLanguage(frontmatter[name]);
			if (language) break;
		}
		if (!language) {
			for (const entry of asList(frontmatter["language"])) {
				language = asLanguage(entry);
				if (language) break;
			}
		}
		if (!language) language = genreLanguage(frontmatter, sourcePath, host);
	}
	languageCache.set(key, language);
	return language;
}

/** The citation language of the note at `sourcePath`. */
export function documentLanguage(app: App, host: QuranCitationHost, sourcePath: string): "ar" | "en" {
	return declaredLanguage(app, host, sourcePath) ?? host.defaultLanguage();
}

/**
 * The language one rendered paragraph declares by what it actually says.
 *
 * The note decides, but a bilingual book puts both languages on the page: an
 * Arabic tafsīr quoting a whole English passage, a ḥadīth collection with the
 * translation beside the text. A citation must read in the language of the
 * sentence it stands in, so the paragraph is read first and the note's declared
 * language is the fallback for a paragraph that does not clearly say.
 *
 * Only a clear majority decides. A transliterated term inside Arabic prose
 * (`*tawḥīd*`) must not make the paragraph English, and an Arabic quotation
 * inside English prose must not make it Arabic — so the counts have to differ
 * threefold, and an evenly mixed paragraph returns `null`.
 */
export function fragmentLanguage(text: string): "ar" | "en" | null {
	// A citation link is not prose, and its sūra name (`Q024`) is Latin whatever
	// the sentence is written in.
	const stripped = text.replace(/\[\[[^\]]*\]\]/g, " ");
	const arabic = (stripped.match(/[\u0600-\u06FF]/g) ?? []).length;
	const latin = (stripped.match(/[A-Za-z]/g) ?? []).length;
	if (!arabic && !latin) return null;
	if (!arabic) return "en";
	if (!latin) return "ar";
	if (latin >= arabic * 3) return "en";
	if (arabic >= latin * 3) return "ar";
	// Evenly mixed prose still writes its quotations one way round, and that is
	// the note's own convention: the left-to-right pair is `﴾quote﴿`. A lone
	// mark is a continuation half (the other half is on the previous page) and
	// says nothing about direction.
	const open = stripped.indexOf("\ufd3f");
	const close = stripped.indexOf("\ufd3e");
	if (close >= 0 && open > close) return "en";
	if (open >= 0 && close > open) return "ar";
	return null;
}

/** The minimum an anchor has to offer, so the pass is testable without a DOM. */
interface CitationAnchor {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	closest(selector: string): unknown;
	textContent: string | null;
	classList: { add(token: string): void };
}

/**
 * Rewrite the citation anchors inside one rendered fragment.
 *
 * A range is written in the link's *alias* (`[[Q024#10|12]]`), so the alias is
 * read before the text is replaced and remembered on the element: the painted
 * text no longer contains it, and a re-render must not lose the range.
 *
 * Exported for the regression tests, which hand in fake anchors.
 */
/**
 * Wrap rendered Qur'ān text so the paragraph's direction cannot reorder it.
 *
 * The isolate is chosen from the text itself: Arabic → RLI, otherwise LRI — so
 * a citation in an English note stays LTR while one in an Arabic note reads as
 * a unit. Reading view and Live Preview both draw through this, so the two
 * cannot disagree about bidi.
 */
export function isolateQuranText(text: string): string {
	return /[\u0600-\u06FF]/.test(text)
		? `\u2067${text}\u2069`
		: `\u2066${text}\u2069`;
}

/**
 * What a fragment needs to choose its own citation style: the host, and the
 * language the note declared (or `null` when it declared none).
 */
export interface FragmentContext {
	host: QuranCitationHost;
	declared: "ar" | "en" | null;
}

/** The style one fragment is painted with: its own reading, else the note's. */
function styleForFragment(root: ParentNode, context: FragmentContext): CitationStyle {
	const text = (root as { textContent?: string | null }).textContent ?? "";
	const language = fragmentLanguage(text) ?? context.declared ?? context.host.defaultLanguage();
	return context.host.styleFor(language);
}

export function paintCitations(root: ParentNode, style: CitationStyle, context?: FragmentContext): number {
	const paintedStyle = context ? styleForFragment(root, context) : style;
	const anchors = Array.from(root.querySelectorAll("a.internal-link")) as unknown as CitationAnchor[];
	let painted = 0;
	for (const anchor of anchors) {
		// `code`/`pre` are not links in prose. Emphasis is a different question:
		// the vault's verse *markers* used to be bold for a reason (the emphasis
		// kept the alias out of the text flow so the margin could position it),
		// but a *citation* can end up inside an italic run through no fault of
		// its own — an unclosed quotation star, an author's emphasis — and
		// skipping it left a citation at paragraph size with no cartouche, which
		// is what "the link is enormous" described. So the emphasis is only a
		// reason to skip once the link is known to be a marker.
		if (anchor.closest("code, pre")) continue;
		const target = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
		const remembered = anchor.getAttribute("data-mas-quran-alias");
		const alias = remembered ?? anchor.textContent ?? "";
		const verse = parseQuranLink(target, alias);
		if (!verse) continue;
		if (verse.marker && anchor.closest("strong")) continue;
		if (remembered === null) anchor.setAttribute("data-mas-quran-alias", alias);
		// A marker is the marginal reference, not a citation in the prose: it
		// prints `24:10` with no brackets, and the margin positions it.
		const text = verse.marker
			? formatMarker(verse, paintedStyle)
			: formatCitation(verse, paintedStyle, { lines: true });
		anchor.classList.add(verse.marker ? "mas-quran-marker" : "mas-quran-citation");
		// A Latin citation is the same box with less type in it: its text is two
		// short Latin lines ("Q" over "2:24"), and at the Arabic cartouche's size
		// it opens the English line box up. The class lets the stylesheet size it
		// for the language it is actually in.
		if (!verse.marker && paintedStyle.names !== "arabic") anchor.classList.add("is-latin");
		if (verse.marker) {
			// A marker is the *first* inline element of its paragraph, and its
			// link text is LTR. A block takes its base direction from its first
			// strong character, so without this the whole paragraph is laid out
			// left-to-right and the reader sees the prose first, the quotations
			// after it. The margin band is a property of the note, not of the
			// paragraph: every paragraph reserves it so the column stays even.
			const host = anchor.closest("p, li, div.el-p") as HTMLElement | null;
			const preview = anchor.closest(".markdown-preview-view") as HTMLElement | null;
			preview?.classList.add("mas-verse-margin");
			if (host) {
				host.classList.add("mas-verse-paragraph");
				// The paragraph's first strong character, not "contains Arabic":
				// a commentary paragraph that quotes an English gloss must not
				// turn right-to-left for it.
				if (textDirection(host.textContent ?? "") === "rtl") host.setAttribute("dir", "rtl");
			}
		}
		// A citation is one unit, not a sequence the paragraph's direction may
		// reorder. Without an isolate, an LTR run (` 24:10`, or a bare alias
		// before painting) inside an RTL line makes the editor place the ornate
		// parentheses — and sometimes the neighbouring quotation — on the wrong
		// side. The isolate is chosen from the text itself: Arabic citation →
		// RLI, otherwise LRI, so it is right in an English note too.
		const isolated = isolateQuranText(text);
		if (anchor.textContent === isolated) continue;
		anchor.textContent = isolated;
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
		// The note says its language, and a paragraph of the other one says
		// otherwise for itself: see `fragmentLanguage`.
		const declared = declaredLanguage(host.app, host, ctx.sourcePath);
		paintCitations(el, host.styleFor(declared ?? host.defaultLanguage()), { host, declared });
	});
}
