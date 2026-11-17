/**
 * Qur'ān citations: one link, many renderings.
 *
 * A citation is written as a bare link to a sūra note:
 *
 *     [[Q024#10]]          Ḥafṣ, sūra 24 (al-Nūr), āya 10
 *     [[Q024#10-12]]       a range          (see `parseQuranTarget`)
 *     [[QW024#10]]         the Warsh riwāya's sūra 24
 *
 * The link carries no display text. What appears on screen is decided here, at
 * render time, from the reader's settings and the note's language — so changing
 * the format never re-renders a note.
 *
 * Everything in this file is pure: no Obsidian API, no note lookup. A volume
 * with 3,500 citations formats from a 114-row table and a string join, which is
 * the whole reason the pass is cheap.
 */

import { parseSurahNumber, surah } from "./surahs";

/** Which name form a sūra is printed with. */
export type SurahNameForm = "arabic" | "common" | "strict";

/** Whether a citation names its sūra, numbers it, or omits it. */
export type SurahForm = "name" | "number" | "none";

export type NumeralStyle = "western" | "indic";

export type BracketStyle = "paren" | "square" | "none";

/** How one citation is printed. One of these per document language. */
export interface CitationStyle {
	/** Text before the reference: "", "ق", "Q". */
	prefix: string;
	/** Name the sūra, number it, or leave it out. */
	surah: SurahForm;
	/** Which name form, when `surah` is `name`. */
	names: SurahNameForm;
	numerals: NumeralStyle;
	/** Between the sūra and the āya: " " for a name, ":" for a number. */
	separator: string;
	bracket: BracketStyle;
	/** Between the ends of a verse range. */
	rangeDash: string;
	/** Name the riwāya when the link is not the canonical Ḥafṣ. */
	showRiwaya: boolean;
}

/** Arabic, the default: `(النور ١٠)`. */
export const DEFAULT_ARABIC_STYLE: CitationStyle = {
	prefix: "",
	surah: "name",
	names: "arabic",
	numerals: "indic",
	separator: " ",
	bracket: "paren",
	rangeDash: "–",
	showRiwaya: true,
};

/** English: `(Q 24:10)`. */
export const DEFAULT_LATIN_STYLE: CitationStyle = {
	prefix: "Q",
	surah: "number",
	names: "common",
	numerals: "western",
	separator: ":",
	bracket: "paren",
	rangeDash: "–",
	showRiwaya: true,
};

export function cloneStyle(style: CitationStyle): CitationStyle {
	return { ...style };
}

/** Merge a stored (possibly partial or older) style over its default. */
export function resolveStyle(stored: Partial<CitationStyle> | null | undefined, base: CitationStyle): CitationStyle {
	if (!stored) return cloneStyle(base);
	return {
		prefix: typeof stored.prefix === "string" ? stored.prefix : base.prefix,
		surah: stored.surah === "name" || stored.surah === "number" || stored.surah === "none" ? stored.surah : base.surah,
		names: stored.names === "arabic" || stored.names === "common" || stored.names === "strict" ? stored.names : base.names,
		numerals: stored.numerals === "indic" || stored.numerals === "western" ? stored.numerals : base.numerals,
		separator: typeof stored.separator === "string" ? stored.separator : base.separator,
		bracket: stored.bracket === "paren" || stored.bracket === "square" || stored.bracket === "none" ? stored.bracket : base.bracket,
		rangeDash: typeof stored.rangeDash === "string" && stored.rangeDash ? stored.rangeDash : base.rangeDash,
		showRiwaya: typeof stored.showRiwaya === "boolean" ? stored.showRiwaya : base.showRiwaya,
	};
}

const INDIC = "٠١٢٣٤٥٦٧٨٩";

/** Western digits → Arabic-Indic, digit for digit. */
export function toIndic(value: string | number): string {
	return String(value).replace(/[0-9]/g, (d) => INDIC[Number(d)]);
}

const BRACKETS: Record<BracketStyle, [string, string]> = {
	paren: ["(", ")"],
	square: ["[", "]"],
	none: ["", ""],
};

/**
 * The riwāya codes that follow `Q` in a sūra note's name. Ḥafṣ is the bare `Q`,
 * because it is what most published sources quote and what a plain
 * `2:189` means; the others carry their own letter. A code is only ever a file
 * name and a display label, so an awkward one is fixable per work.
 */
export const RIWAYAS: Record<string, { en: string; ar: string }> = {
	"": { en: "", ar: "" },
	W: { en: "Warsh", ar: "ورش" },
	N: { en: "Qālūn", ar: "قالون" },
	D: { en: "al-Dūrī", ar: "الدوري" },
	S: { en: "Shuʿbah", ar: "شعبة" },
	U: { en: "al-Sūsī", ar: "السوسي" },
};

export interface QuranLinkTarget {
	/** 1–114. */
	surah: number;
	/** "" for the canonical Ḥafṣ notes, else the riwāya code (`W`, `N`, …). */
	riwaya: string;
	/** First āya in the link's subpath. */
	start: number;
	/** Last āya, equal to `start` for a single verse. */
	end: number;
}

const SURA_TARGET = /^Q([A-Za-z]{0,2})([0-9]{1,3})$/;

/**
 * Read a link target as a Qur'ān citation.
 *
 * Accepts `Q024` and `QW024`, and tolerates a path before the file name
 * (`Quran/Q024`) since a link may be written either way. Returns `null` for
 * anything else — including the pre-migration `024 An-Nur` names, whose links
 * already carry their own display text and so need no help.
 */
export function parseQuranTarget(target: string): QuranLinkTarget | null {
	const base = target.split("/").pop() ?? target;
	const hash = base.indexOf("#");
	if (hash < 0) return null;
	const name = base.slice(0, hash);
	const subpath = base.slice(hash + 1).trim();
	const m = SURA_TARGET.exec(name);
	if (!m) return null;
	const number = parseSurahNumber(m[2]);
	if (number == null) return null;
	const verses = parseVerseRange(subpath);
	if (!verses) return null;
	return { surah: number, riwaya: m[1], start: verses.start, end: verses.end };
}

/** `10` → 10–10; `10-12`, `10–12`, `10—12` → 10–12. */
export function parseVerseRange(subpath: string): { start: number; end: number } | null {
	const m = /^([0-9]{1,3})(?:\s*[-\u2013\u2014]\s*([0-9]{1,3}))?$/.exec(subpath);
	if (!m) return null;
	const start = Number(m[1]);
	const end = m[2] ? Number(m[2]) : start;
	if (!Number.isInteger(start) || start < 1) return null;
	if (!Number.isInteger(end) || end < start) return null;
	return { start, end };
}

/** The sūra's name in the form a style asks for. */
export function surahName(number: number, form: SurahNameForm): string {
	const row = surah(number);
	if (!row) return String(number);
	if (form === "arabic") return row.arabic;
	if (form === "strict") return row.strict;
	return row.common;
}

function numerals(value: number, style: CitationStyle): string {
	const text = String(value);
	return style.numerals === "indic" ? toIndic(text) : text;
}

export interface FormatOptions {
	/** Render as if the link belonged to this riwāya (`W`, `N`, …). */
	riwaya?: string;
	/** Force the Arabic/Indic reading of a blank riwāya name. */
	arabic?: boolean;
}

/**
 * The text a citation link should show.
 *
 * `(النور ١٠)` for the Arabic default, `(Q 24:10)` for the Latin one, and
 * `(Q 24:10–12)` for a range. A non-canonical riwāya is named inside the
 * bracket unless the style turns that off.
 */
export function formatCitation(verse: QuranLinkTarget, style: CitationStyle, options: FormatOptions = {}): string {
	const riwaya = options.riwaya ?? verse.riwaya;
	const arabic = options.arabic ?? style.names === "arabic";

	let surahPart = "";
	if (style.surah === "name") surahPart = surahName(verse.surah, style.names);
	else if (style.surah === "number") surahPart = numerals(verse.surah, style);

	const verses = verse.start === verse.end
		? numerals(verse.start, style)
		: `${numerals(verse.start, style)}${style.rangeDash}${numerals(verse.end, style)}`;

	let body = surahPart ? `${surahPart}${style.separator}${verses}` : verses;

	const label = RIWAYAS[riwaya];
	if (riwaya && label && style.showRiwaya) {
		body = `${body}${arabic ? "،" : ","} ${arabic ? label.ar : label.en}`;
	}

	const prefix = style.prefix.trim();
	if (prefix) body = `${prefix} ${body}`;

	const [open, close] = BRACKETS[style.bracket];
	return `${open}${body}${close}`;
}

/**
 * The link to write for a verse: `[[Q024#10]]`, or `[[Q024#10-12]]` for a range.
 * `prefix` is the sūra note's own name prefix (`Q` for Ḥafṣ, `QW` for Warsh).
 */
export function quranLink(prefix: string, surahNumber: number, start: number, end: number): string {
	const file = `${prefix}${String(surahNumber).padStart(3, "0")}`;
	const subpath = start === end ? String(start) : `${start}-${end}`;
	return `[[${file}#${subpath}]]`;
}
