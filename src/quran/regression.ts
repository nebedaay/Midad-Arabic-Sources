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
	formatMarker,
	parseQuranLink,
	parseQuranTarget,
	parseVerseRange,
	quranLink,
	resolveStyle,
	surahName,
	toIndic,
	versePrefixFor,
	RIWAYA_PREFIXES,
	RIWAYAS,
} from "./citationFormat";
import { SURAHS, parseSurahNumber, surah } from "./surahs";
import { declaredLanguage, documentLanguage, fragmentLanguage, invalidateQuranCitationCache, paintCitations, QuranCitationHost } from "./citationRender";
import { findSpans, isLtrText, textDirection } from "../quranQuote";
import { CitationWidget, MarkerWidget } from "../verseMarkers";

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

	/** What a reader sees: the bidi isolates that keep a citation one unit
	 *  are invisible, so a comparison of rendered text drops them. */
	const plainText = (value: unknown): unknown =>
		typeof value === "string" ? value.replace(/[\u2066-\u2069]/g, "") : value;
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
	eq("range from an alias", parseQuranLink("Q024#10", "12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("range from a hyphenated alias", parseQuranLink("Q024#10", "-12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("range from an en-dashed alias", parseQuranLink("Q024#10", "–12"), { surah: 24, riwaya: "", start: 10, end: 12 });
	eq("a subpath range wins over the alias", parseQuranLink("Q024#10-14", "12"), { surah: 24, riwaya: "", start: 10, end: 14 });
	eq("a backwards alias is not a range", parseQuranLink("Q024#10", "9"), { surah: 24, riwaya: "", start: 10, end: 10 });
	eq("an equal alias is not a range", parseQuranLink("Q024#10", "10"), { surah: 24, riwaya: "", start: 10, end: 10 });
	// An alias with a colon in it is the marginal-link signal, however it is
	// written: the pipeline pins citations to a bare link, so a coloned alias
	// can only be a marker.
	eq("a coloned alias is a marker", parseQuranLink("Q024#10", "24:10"), { surah: 24, riwaya: "", start: 10, end: 10, marker: true });
	eq("an Arabic-Indic alias is not a range", parseQuranLink("Q024#10", "١٢"), { surah: 24, riwaya: "", start: 10, end: 10 });
	eq("an empty alias is not a range", parseQuranLink("Q024#10", ""), { surah: 24, riwaya: "", start: 10, end: 10 });
	eq("a marker alias", parseQuranLink("Q024#10", ":"), { surah: 24, riwaya: "", start: 10, end: 10, marker: true });
	eq("a marker range alias", parseQuranLink("Q006#29", ":30"), { surah: 6, riwaya: "", start: 29, end: 30, marker: true });
	eq("a legacy marker alias is still a marker", parseQuranLink("Q022#15", "22:15"), { surah: 22, riwaya: "", start: 15, end: 15, marker: true });
	eq("a written-out range alias parses like the short form",
		parseQuranLink("Q022#3", "22:3–22:4"), parseQuranLink("Q022#3", ":4"));
	eq("an en-dash range after a colon keeps its last number",
		parseQuranLink("Q022#3", ":3–4"), { surah: 22, riwaya: "", start: 3, end: 4, marker: true });
	eq("a backwards marker is a single verse", parseQuranLink("Q006#30", ":29"), { surah: 6, riwaya: "", start: 30, end: 30, marker: true });
	eq("a marker prints no brackets", formatMarker({ surah: 24, riwaya: "", start: 10, end: 10 }, DEFAULT_LATIN_STYLE), "24:10");
	eq("a marker range abbreviates the second sūra", formatMarker({ surah: 6, riwaya: "", start: 29, end: 30 }, DEFAULT_LATIN_STYLE), "6:29–30");
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
	eq("Qālūn, Latin", formatCitation({ ...verse, riwaya: "Q" }, latin), "(Q 24:10, Qālūn)");
	eq("Ibn Kathīr, Latin", formatCitation({ ...verse, riwaya: "I" }, latin), "(Q 24:10, Ibn Kathīr)");
	eq("Abū ʿAmr, Arabic", formatCitation({ ...verse, riwaya: "A" }, arabic), "(النور ١٠، أبو عمرو)");
	eq("Khalaf, Latin", formatCitation({ ...verse, riwaya: "X" }, latin), "(Q 24:10, Khalaf)");
	eq("riwāya hidden when the style says so",
		formatCitation({ ...verse, riwaya: "W" }, { ...latin, showRiwaya: false }), "(Q 24:10)");

	// The cartouche is two lines, and what goes on which is decided by what the
	// sūra part *is*: a name is a label above, a number is the first half of the
	// locator below. Splitting `2:24` across the two lines read as a mangled
	// version of the Arabic form.
	eq("Arabic cartouche: name above, numbers below",
		formatCitation(verse, arabic, { lines: true }), "النور\n١٠");
	eq("Latin cartouche: Q above, sūra:verse below",
		formatCitation(verse, latin, { lines: true }), "Q\n24:10");
	eq("Latin cartouche keeps the separator setting",
		formatCitation(verse, { ...latin, separator: "." }, { lines: true }), "Q\n24.10");
	eq("Latin cartouche: a range stays whole below",
		formatCitation({ ...verse, end: 12 }, latin, { lines: true }), "Q\n24:10–12");
	eq("Latin cartouche: the riwāya joins the second line",
		formatCitation({ ...verse, riwaya: "W" }, latin, { lines: true }), "Q\n24:10, Warsh");
	eq("Latin cartouche with no sūra",
		formatCitation(verse, { ...latin, surah: "none" }, { lines: true }), "Q\n10");
	eq("Latin cartouche with a named sūra keeps the name above",
		formatCitation(verse, { ...latin, surah: "name" }, { lines: true }), "Q An-Nur\n10");
	eq("Arabic cartouche with no prefix",
		formatCitation(verse, { ...arabic, prefix: "ق" }, { lines: true }), "ق النور\n١٠");
	eq("toIndic", toIndic(2410), "٢٤١٠");

	eq("Qālūn link parses", parseQuranTarget("QQ024#5"), { surah: 24, riwaya: "Q", start: 5, end: 5 });
	eq("Ḥamza link parses", parseQuranTarget("QH001#1"), { surah: 1, riwaya: "H", start: 1, end: 1 });
	eq("Ibn Kathīr link parses", parseQuranTarget("QI002#255"), { surah: 2, riwaya: "I", start: 255, end: 255 });
	eq("Abū ʿAmr link parses", parseQuranTarget("QA003#7"), { surah: 3, riwaya: "A", start: 7, end: 7 });
	eq("Kisāʾī link parses", parseQuranTarget("QK004#1"), { surah: 4, riwaya: "K", start: 1, end: 1 });
	eq("Khalaf link parses", parseQuranTarget("QX005#1"), { surah: 5, riwaya: "X", start: 1, end: 1 });

	eq("prefix — Ḥafṣ", versePrefixFor("hafs"), "Q");
	eq("prefix — Warsh", versePrefixFor("warsh"), "QW");
	eq("prefix — Qālūn", versePrefixFor("qalun"), "QQ");
	eq("prefix — Ḥamza", versePrefixFor("hamza"), "QH");
	eq("prefix — Ibn Kathīr", versePrefixFor("ibnkathir"), "QI");
	eq("prefix — Abū ʿAmr", versePrefixFor("abuamr"), "QA");
	eq("prefix — Kisāʾī", versePrefixFor("kisai"), "QK");
	eq("prefix — Khalaf", versePrefixFor("khalaf"), "QX");
	eq("prefix — al-Dūrī", versePrefixFor("duri"), "QD");
	eq("prefix — Shuʿbah", versePrefixFor("shubah"), "QS");
	eq("prefix — al-Sūsī", versePrefixFor("susi"), "QU");
	eq("prefix — an unknown id still gets one", versePrefixFor("jubburi"), "QJU");
	check("every prefix names a known riwāya",
		Object.values(RIWAYA_PREFIXES).every((prefix) => RIWAYAS[prefix.slice(1)] !== undefined),
		Object.values(RIWAYA_PREFIXES).filter((prefix) => RIWAYAS[prefix.slice(1)] === undefined).join(", "));
	check("the canonical id and the empty id agree", RIWAYA_PREFIXES[""] === RIWAYA_PREFIXES.hafs);
	check("no two riwāyas share a prefix",
		new Set(Object.entries(RIWAYA_PREFIXES).filter(([id]) => id !== "").map(([, prefix]) => prefix)).size === 11);

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
		bold: boolean;
		getAttribute(name: string): string | null;
		setAttribute(name: string, value: string): void;
		closest(selector: string): unknown;
		classList: { add(token: string): void };
	}
	const anchor = (target: string, text: string, bold = false): FakeAnchor => {
		const item: FakeAnchor = {
			attrs: { "data-href": target },
			textContent: text,
			classes: [],
			bold,
			getAttribute(name) { return item.attrs[name] ?? null; },
			setAttribute(name, value) { item.attrs[name] = value; },
			closest(selector) { return bold && selector.includes("strong") ? {} : null; },
			classList: { add(token) { item.classes.push(token); } },
		};
		return item;
	};

	const a = anchor("Q024#10", "Q024 > 10");
	const b = anchor("@smith2005", "Smith 2005");
	const c = anchor("024 An-Nur#10", "النور : ١٠");
	const d = anchor("Q024#10", "12");
	const e = anchor("Q001#3", "1:3", true);
	const f = anchor("Q024#10", ":");
	const root = { querySelectorAll: () => [a, b, c, d, e, f] } as unknown as ParentNode;
	const painted = paintCitations(root, arabic);
	eq("only the citations are painted", painted, 3);
	// The rendered citation is a two-line cartouche: sūra above, numbers below.
	eq("the citation shows its Arabic form", plainText(a.textContent), "النور\n١٠");
	eq("the citation is marked", a.classes, ["mas-quran-citation"]);
	eq("a literature link is untouched", b.textContent, "Smith 2005");
	eq("a legacy sūra link keeps its own text", c.textContent, "النور : ١٠");
	eq("a range alias becomes a range", plainText(d.textContent), "النور\n١٠–١٢");
	eq("a bold marker is left alone", e.textContent, "1:3");
	eq("a marker alias prints a locator", plainText(f.textContent), "24:10");
	eq("a marker is marked as one", f.classes, ["mas-quran-marker"]);
	eq("the range alias is remembered", d.attrs["data-mas-quran-alias"], "12");

	// A repaint must not lose the range: the alias is now only on the element.
	const again = paintCitations(root, arabic);
	eq("a repaint changes nothing", again, 0);
	eq("a repaint keeps the range", plainText(d.textContent), "النور\n١٠–١٢");

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

	// ── A translation is an English document without saying so ───────────────
	// Asking every English note to carry `language` would be one more property
	// to keep true. The pipeline already writes the fact twice — as the genre
	// in `midad-up` and, for a tafsīr, as the gutter class — so those are read
	// in place of it, and the folder covers a note the pipeline did not make.
	invalidateQuranCitationCache();
	eq("a translation MOC makes it English",
		languageOf({ "midad-up": ["[[Arabic translations]]", "[[@x]]"] }, "t1.md"), "en");
	eq("a translation parent link makes it English",
		languageOf({ "midad-up": ["[[Arabic transcriptions]]", "[[@x - translation]]"] }, "t2.md"), "en");
	eq("a transcription parent link makes it Arabic",
		languageOf({ "midad-up": ["[[@x - transcription]]"] }, "t3.md"), "ar");
	eq("the translated gutter class makes it English",
		languageOf({ cssclasses: ["tafsir-en"] }, "t4.md"), "en");
	eq("the Arabic gutter class makes it Arabic",
		languageOf({ cssclasses: ["tafsir"] }, "t5.md"), "ar");
	eq("a declared language still wins over the genre",
		languageOf({ "midad-up": ["[[Arabic translations]]"], language: "[[Arabic]]" }, "t6.md"), "ar");
	const foldedHost = (): QuranCitationHost => ({
		...host("ar"),
		translationsFolder: () => "_7 Sources/Translations",
		transcriptionsFolder: () => "_7 Sources/Transcriptions",
	});
	eq("the translations folder makes it English",
		documentLanguage(fakeApp({}), foldedHost(), "_7 Sources/Translations/x.md"), "en");
	eq("the transcriptions folder makes it Arabic",
		documentLanguage(fakeApp({ "midad-up": [] }), foldedHost(), "_7 Sources/Transcriptions/x.md"), "ar");
	eq("a folder is matched by whole path, not by prefix",
		documentLanguage(fakeApp({}), foldedHost(), "_7 Sources/Translations extra/x.md"), "ar");
	eq("an undeclared note declares nothing",
		declaredLanguage(fakeApp({}), host("ar"), "t7.md"), null);

	// ── A paragraph of the other language says so for itself ─────────────────
	// A bilingual book puts both languages on the page; the citation must read
	// in the language of the sentence it stands in. Only a clear majority
	// decides, so a transliterated term in Arabic prose and an Arabic quotation
	// in English prose both leave the paragraph to the note.
	eq("English prose", fragmentLanguage("And His saying: the Master of the Day"), "en");
	eq("Arabic prose", fragmentLanguage("قال الله تعالى في كتابه الكريم"), "ar");
	eq("a transliterated term in Arabic prose is still Arabic",
		fragmentLanguage("وقد ورد في *tawḥīd* عند القوم معنى التوحيد والإفراد"), "ar");
	eq("an Arabic quotation in English prose is still English",
		fragmentLanguage("He said: ﴾الحمد لله رب العالمين﴿ and then the verse continues here"), "en");
	eq("a citation link is not prose", fragmentLanguage("[[Q024#10]]"), null);
	eq("an even mix is undecided",
		fragmentLanguage("قال: كلام and then praise here"), null);
	eq("an even mix reads its quotation's pair, reversed", fragmentLanguage("﴾quote﴿ نص"), "en");
	eq("an even mix reads its quotation's pair, Arabic", fragmentLanguage("﴿نص﴾ quote"), "ar");
	eq("a lone continuation mark decides nothing", fragmentLanguage("word نص﴾"), null);

	// The painter takes the note's language and lets a clear paragraph override
	// it: this is the bilingual case, and it must not need a property per block.
	const contextual = (text: string, declared: "ar" | "en" | null): FakeAnchor => {
		const item = anchor("Q001#4", "");
		const root = { querySelectorAll: () => [item], textContent: text } as unknown as ParentNode;
		paintCitations(root, arabic, { host: host(declared ?? "ar"), declared });
		return item;
	};
	invalidateQuranCitationCache();
	const englishPassage = "He said: ﴾the Master of the Day﴿ [[Q001#4]] and more of the same";
	const arabicPassage = "وقال في كتابه الكريم [[Q001#4]] وأكثر من ذلك في المعنى";
	eq("an English paragraph cites the English way", plainText(contextual(englishPassage, "ar").textContent), "Q\n1:4");
	eq("an Arabic paragraph cites the Arabic way", plainText(contextual(arabicPassage, "ar").textContent), "الفاتحة\n٤");

	// ── Quotation spans, in a paragraph of either direction ──────────────────
	// What the spans cover is what the reader sees gilded. A left-to-right
	// paragraph writes the ornate pair the other way round, and reading the two
	// marks by their Arabic meaning gilded the prose and left the quotation
	// plain.
	const covered = (text: string, ltr: boolean): string[] =>
		findSpans(text, ltr).map((span) => text.slice(span.start, span.end));
	eq("an Arabic pair covers the quotation", covered("قال: ﴿نص﴾ ثم", false), ["﴿نص﴾"]);
	eq("an Arabic closing half covers what precedes it", covered("نص﴾ ثم", false), ["نص﴾"]);
	eq("an Arabic opening half covers what follows it", covered("قال: ﴿نص", false), ["﴿نص"]);
	eq("a reversed pair covers the quotation, not the prose",
		covered("So: ﴾quote﴿ and more", true), ["﴾quote﴿"]);
	eq("a forward pair in an LTR paragraph still covers the quotation",
		covered("So: ﴿quote﴾ and more", true), ["﴿quote﴾"]);
	eq("two reversed pairs are both covered",
		covered("﴾one﴿ and ﴾two﴿", true), ["﴾one﴿", "﴾two﴿"]);

	// A callout is laid out left-to-right on purpose (so a theme's border stays
	// on the left), so the computed direction of its paragraphs is not the
	// direction of the text. A line that opens with a verse link is Arabic, and
	// its closing half must be read as a continuation, not as a reversed pair.
	const LINKED_HALF = "[[Q022#5|:]]لِكَيْلَا يَعْلَمَ بَهِيجٍ﴾";
	check("a line led by a verse link is Arabic", isLtrText(LINKED_HALF) === false);
	eq("its closing half covers the whole line",
		covered(LINKED_HALF, isLtrText(LINKED_HALF)), [LINKED_HALF]);
	check("Latin prose is left to right",
		isLtrText("And His saying: ﴾Master of the Day﴿ (001:4)") === true);

	// ── A press on a citation is not a cursor gesture ────────────────────────
	// `ignoreEvent` is inverted: `true` means the editor *ignores* the event.
	// `false` let CodeMirror move the cursor into the citation on press, so Live
	// Preview redrew the link as source and destroyed the widget before the
	// click arrived — the first click showed `[[…]]`, the second edited the
	// alias, and the sūra was never opened.
	check("a citation widget keeps its press",
		new CitationWidget("Q\n24:10", "Q024#10").ignoreEvent() === true);
	check("a marker widget keeps its press",
		new MarkerWidget("24:10", "Q024#10", 0).ignoreEvent() === true);

	// ── A paragraph is laid out by its first strong character ────────────────
	// The Live Preview line decoration used to ask whether the whole line
	// *contained* Arabic, so an English paragraph quoting two Arabic words was
	// laid out right-to-left — the reader saw the prose start at the wrong edge.
	// The direction is the same question the quotation spans already ask, and
	// links are stripped first so a leading `[[Q022#5|:]]` does not make an
	// Arabic line look Latin.
	const englishWithArabic = "Engrossed in his permissible desires, ʿUmar said: ﴾آتِيًا﴿ and more English after it";
	eq("an English line quoting Arabic stays left-to-right", textDirection(englishWithArabic), "ltr");
	eq("an Arabic line is right-to-left", textDirection("قال تعالى: ﴿نص عربي﴾"), "rtl");
	eq("a line led by a verse link is Arabic", textDirection("[[Q022#5|:]]لِكَيْلَا يَعْلَمَ بَهِيجٍ"), "rtl");
	eq("a line with no strong character decides nothing", textDirection("[[Q024#10]]"), null);
	check("isLtrText still agrees with it",
		isLtrText(englishWithArabic) === true && isLtrText("قال تعالى") === false);

	return { passed, failed, lines };
}
