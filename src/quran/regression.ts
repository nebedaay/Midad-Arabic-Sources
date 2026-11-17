/**
 * Regression tests for the Qur'ān citation layer.
 *
 * Run with `npm run test:quran`. Like the annotation suite, this bundles to a
 * Node script with an `obsidian` stub, so it exercises the same code the plugin
 * ships rather than a copy of it.
 */

import type { App } from "obsidian";
import {
	DEFAULT_ARABIC_STYLE,
	DEFAULT_LATIN_STYLE,
	formatCitation,
	parseQuranTarget,
	parseVerseRange,
	quranLink,
	resolveStyle,
	surahName,
	toIndic,
} from "./citationFormat";
import { SURAHS, parseSurahNumber, surah } from "./surahs";
import { documentLanguage, invalidateQuranCitationCache, paintCitations, QuranCitationHost } from "./citationRender";

export interface RegressionResult {
	passed: number;
	failed: number;
	lines: string[];
}

export function runQuranCitationTests(): RegressionResult {
	const lines: string[] = [];
	let passed = 0;
	let failed = 0;

	const check = (name: string, ok: boolean, detail = ""): void => {
		if (ok) {
			passed++;
			return;
		}
		failed++;
		lines.push(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	};

	const eq = (name: string, actual: unknown, expected: unknown): void => {
		check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
	};

	// ── The sūra table ───────────────────────────────────────────────────────
	eq("114 sūras", SURAHS.length, 114);
	check("numbers run 1–114 in order", SURAHS.every((row, i) => row.number === i + 1));
	check("every row has all three forms", SURAHS.every((row) => row.arabic && row.common && row.strict));
	check("every strict name is distinct", new Set(SURAHS.map((row) => row.strict)).size === 114);
	check("every common name is distinct", new Set(SURAHS.map((row) => row.common)).size === 114);
	check("strict names never assimilate the article",
		SURAHS.every((row) => !/^(ar|as|at|ad|az|ash|ath|adh|an|al-[a-z])-/.test(row.strict) || row.strict.startsWith("al-")),
		SURAHS.filter((row) => /^(ar|as|at|ad|az|ash|an)-/.test(row.strict)).map((row) => row.strict).join(", "));

	eq("al-Nūr", surahName(24, "strict"), "al-Nūr");
	eq("An-Nur", surahName(24, "common"), "An-Nur");
	eq("النور", surahName(24, "arabic"), "النور");
	eq("tāʾ marbūṭa drops after a short a — al-Baqara", surahName(2, "strict"), "al-Baqara");
	eq("tāʾ marbūṭa drops after a short a — al-Sajda", surahName(32, "strict"), "al-Sajda");
	eq("no assimilated article — al-Raḥmān", surahName(55, "strict"), "al-Raḥmān");
	eq("no assimilated article — al-Shams", surahName(91, "strict"), "al-Shams");
	eq("spelled-out letters — Ṭā Hā", surahName(20, "strict"), "Ṭā Hā");
	eq("spelled-out letters — Yā Sīn", surahName(36, "strict"), "Yā Sīn");
	eq("madda — Āl ʿImrān", surahName(3, "strict"), "Āl ʿImrān");
	eq("initial hamza is not written — Ibrāhīm", surahName(14, "strict"), "Ibrāhīm");
	eq("medial hamza keeps ʾ — al-Māʾida", surahName(5, "strict"), "al-Māʾida");
	eq("ʿayn — al-ʿAnkabūt", surahName(29, "strict"), "al-ʿAnkabūt");

	eq("surah(24) is An-Nur", surah(24)?.common, "An-Nur");
	eq("surah(0) is null", surah(0), null);
	eq("surah(115) is null", surah(115), null);
	eq("parseSurahNumber('٢٤')", parseSurahNumber("٢٤"), 24);
	eq("parseSurahNumber('24')", parseSurahNumber("24"), 24);
	eq("parseSurahNumber('0')", parseSurahNumber("0"), null);

	// ── Link targets ─────────────────────────────────────────────────────────
	eq("plain link", parseQuranTarget("Q024#10"), { surah: 24, riwaya: "", start: 10, end: 10 });
	eq("riwāya link", parseQuranTarget("QW024#10"), { surah: 24, riwaya: "W", start: 10, end: 10 });
	eq("hyphen range", parseQuranTarget("Q024#10-12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("en-dash range", parseQuranTarget("Q024#10–12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("em-dash range", parseQuranTarget("Q024#10—12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("path-prefixed link", parseQuranTarget("Quran/Q024#10"), { surah: 24, riwaya: "", start: 10, end: 10 });
	eq("no subpath is not a citation", parseQuranTarget("Q024"), null);
	eq("legacy name is left alone", parseQuranTarget("024 An-Nur#10"), null);
	eq("out-of-range sūra", parseQuranTarget("Q999#10"), null);
	eq("āya 0 is invalid", parseQuranTarget("Q024#0"), null);
	eq("backwards range is invalid", parseQuranTarget("Q024#12-10"), null);
	eq("non-numeric subpath", parseQuranTarget("Q024#Ten"), null);
	eq("another plugin's link", parseQuranTarget("@smith2005"), null);

	eq("verse range single", parseVerseRange("10"), { start: 10, end: 10 });
	eq("verse range spaced", parseVerseRange("10 - 12"), { start: 10, end: 12 });

	// ── Formatting ───────────────────────────────────────────────────────────
	const arabic = DEFAULT_ARABIC_STYLE;
	const latin = DEFAULT_LATIN_STYLE;
	const verse = { surah: 24, riwaya: "", start: 10, end: 10 };

	eq("Arabic default", formatCitation(verse, arabic), "(النور ١٠)");
	eq("Latin default", formatCitation(verse, latin), "(Q 24:10)");
	eq("Arabic, numbered sūra and Western digits",
		formatCitation(verse, { ...arabic, prefix: "ق", surah: "number", numerals: "western", separator: ":" }),
		"(ق 24:10)");
	eq("Arabic range", formatCitation({ ...verse, end: 12 }, arabic), "(النور ١٠–١٢)");
	eq("Latin range", formatCitation({ ...verse, end: 12 }, latin), "(Q 24:10–12)");
	eq("sūra omitted", formatCitation(verse, { ...arabic, surah: "none" }), "(١٠)");
	eq("square brackets", formatCitation(verse, { ...latin, bracket: "square" }), "[Q 24:10]");
	eq("no brackets", formatCitation(verse, { ...latin, bracket: "none" }), "Q 24:10");
	eq("no prefix", formatCitation(verse, { ...latin, prefix: "" }), "(24:10)");
	eq("strict name in a Latin style", formatCitation(verse, { ...latin, prefix: "", surah: "name", names: "strict", numerals: "western", separator: " " }), "(al-Nūr 10)");
	eq("common name with Arabic digits", formatCitation(verse, { ...arabic, names: "common" }), "(An-Nur ١٠)");
	eq("Warsh, Arabic", formatCitation({ ...verse, riwaya: "W" }, arabic), "(النور ١٠، ورش)");
	eq("Warsh, Latin", formatCitation({ ...verse, riwaya: "W" }, latin), "(Q 24:10, Warsh)");
	eq("riwāya hidden when the style says so",
		formatCitation({ ...verse, riwaya: "W" }, { ...latin, showRiwaya: false }), "(Q 24:10)");
	eq("toIndic", toIndic(2410), "٢٤١٠");

	eq("quranLink single", quranLink("Q", 24, 10, 10), "[[Q024#10]]");
	eq("quranLink range", quranLink("Q", 24, 10, 12), "[[Q024#10-12]]");
	eq("quranLink riwāya", quranLink("QW", 1, 7, 7), "[[QW001#7]]");
	eq("quranLink pads the sūra", quranLink("Q", 3, 7, 7), "[[Q003#7]]");

	// ── Stored styles ────────────────────────────────────────────────────────
	eq("empty stored style is the default", resolveStyle(undefined, latin), latin);
	eq("partial stored style fills the rest", resolveStyle({ prefix: "Qurʾān" }, latin), { ...latin, prefix: "Qurʾān" });
	eq("an unknown enum falls back", resolveStyle({ surah: "bogus" as never }, latin).surah, latin.surah);
	eq("an empty range dash falls back", resolveStyle({ rangeDash: "" }, latin).rangeDash, latin.rangeDash);

	// ── Painting a rendered fragment ─────────────────────────────────────────
	interface FakeAnchor {
		attrs: Record<string, string>;
		textContent: string;
		classes: string[];
		getAttribute(name: string): string | null;
		closest(): unknown;
		classList: { add(token: string): void };
	}
	const anchor = (target: string, text: string): FakeAnchor => {
		const item: FakeAnchor = {
			attrs: { "data-href": target },
			textContent: text,
			classes: [],
			getAttribute(name) { return item.attrs[name] ?? null; },
			closest() { return null; },
			classList: { add(token) { item.classes.push(token); } },
		};
		return item;
	};

	const a = anchor("Q024#10", "Q024 > 10");
	const b = anchor("@smith2005", "Smith 2005");
	const c = anchor("024 An-Nur#10", "النور : ١٠");
	const root = { querySelectorAll: () => [a, b, c] } as unknown as ParentNode;
	const painted = paintCitations(root, arabic);
	eq("only the citation anchor is painted", painted, 1);
	eq("the citation shows its Arabic form", a.textContent, "(النور ١٠)");
	eq("the citation is marked", a.classes, ["mas-quran-citation"]);
	eq("a literature link is untouched", b.textContent, "Smith 2005");
	eq("a legacy sūra link keeps its own text", c.textContent, "النور : ١٠");

	// ── Document language ────────────────────────────────────────────────────
	const fakeApp = (frontmatter: Record<string, unknown>) => ({
		vault: { getAbstractFileByPath: (path: string) => ({ path }) },
		metadataCache: { getFileCache: () => ({ frontmatter }) },
	} as unknown as App);
	/** The host's own `app` is never read: `documentLanguage` gets the fake one. */
	const NO_APP = null as unknown as App;
	const host = (fallback: "ar" | "en"): QuranCitationHost => ({
		app: NO_APP,
		styleFor: (language: "ar" | "en") => (language === "ar" ? arabic : latin),
		defaultLanguage: () => fallback,
	});
	const languageOf = (frontmatter: Record<string, unknown>, path: string, fallback: "ar" | "en" = "ar"): string =>
		documentLanguage(fakeApp(frontmatter), host(fallback), path);

	invalidateQuranCitationCache();
	eq("Arabic note", languageOf({ language: "[[Arabic]]" }, "a.md"), "ar");
	eq("English note", languageOf({ language: "[[English]]" }, "b.md"), "en");
	eq("bilingual note reads Arabic", languageOf({ language: ["[[Arabic]]", "[[English]]"] }, "c.md"), "ar");
	eq("explicit override wins", languageOf({ language: "[[Arabic]]", "quran-citations": "en" }, "d.md"), "en");
	eq("explicit override, Arabic", languageOf({ language: "[[English]]", "quran-citation-language": "ar" }, "e.md"), "ar");
	eq("a French note uses the Latin style", languageOf({ language: "[[French]]" }, "f.md"), "en");
	eq("no language property takes the default", languageOf({}, "g.md", "ar"), "ar");
	eq("no language property takes the default (en)", languageOf({}, "h.md", "en"), "en");

	return { passed, failed, lines };
}
