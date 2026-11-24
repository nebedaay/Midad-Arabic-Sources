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
 * The riwāya codes that follow `Q` in a sūra note's name.
 *
 * Ḥafṣ is the bare `Q`, because it is what most published sources quote and
 * what a plain `2:189` means. Each other reading has its own letter, so a sūra
 * note is never ambiguous: `Q024` is Ḥafṣ, `QW024` Warsh, `QQ024` Qālūn. The
 * letter is a file name, not a display decision — it is what makes
 * `[[Q024#10]]` resolve at all.
 */
export const RIWAYAS: Record<string, { en: string; ar: string }> = {
	"": { en: "", ar: "" },
	W: { en: "Warsh", ar: "ورش" },
	Q: { en: "Qālūn", ar: "قالون" },
	H: { en: "Ḥamza", ar: "حمزة" },
	I: { en: "Ibn Kathīr", ar: "ابن كثير" },
	A: { en: "Abū ʿAmr", ar: "أبو عمرو" },
	K: { en: "al-Kisāʾī", ar: "الكسائي" },
	X: { en: "Khalaf", ar: "خلف" },
	D: { en: "al-Dūrī", ar: "الدوري" },
	S: { en: "Shuʿbah", ar: "شعبة" },
	U: { en: "al-Sūsī", ar: "السوسي" },
};

/**
 * The sūra-note prefix for each riwāya work id, which is what the importer
 * writes into the model (`verse_prefix`). The keys are the ids the works are
 * installed under; `""` stands for the canonical Ḥafṣ notes, whose prefix is
 * the whole name.
 */
export const RIWAYA_PREFIXES: Record<string, string> = {
	"": "Q",
	hafs: "Q",
	warsh: "QW",
	qalun: "QQ",
	hamza: "QH",
	ibnkathir: "QI",
	abuamr: "QA",
	kisai: "QK",
	khalaf: "QX",
	duri: "QD",
	shubah: "QS",
	susi: "QU",
};

/** `warsh` → `QW`, `hafs` → `Q`. An unknown id gets `Q` plus its first two letters. */
export function versePrefixFor(workId: string): string {
	const key = String(workId || "").toLowerCase().replace(/[^a-z]/g, "");
	if (Object.prototype.hasOwnProperty.call(RIWAYA_PREFIXES, key)) return RIWAYA_PREFIXES[key];
	return `Q${key.slice(0, 2).toUpperCase()}`;
}

export interface QuranLinkTarget {
	/** 1–114. */
	surah: number;
	/** "" for the canonical Ḥafṣ notes, else the riwāya code (`W`, `N`, …). */
	riwaya: string;
	/** First āya in the link's subpath. */
	start: number;
	/** Last āya, equal to `start` for a single verse. */
	end: number;
	/** A marginal verse reference (`|:`), not a citation in the prose. */
	marker?: boolean;
}

/** A link alias that names a range's second verse: `12`, `-12`, `–12`. */
const RANGE_ALIAS = /^[\u2013\u2014-]?(\d{1,3})$/;

/**
 * A link alias that marks a *marginal* verses reference: `:` alone, or `:12`
 * for the second verse of a range.
 *
 * A marker is not a citation in prose — it is the reference drawn beside the
 * line where the discussion moves to a new verse. The alias is how the two are
 * told apart without relying on the emphasis that used to wrap a marker, so a
 * marker needs no `**…**` and therefore no zero-width separator after it.
 */
const MARKER_ALIAS = /^:(\d{1,3})?(?:\s*[\u2013\u2014-]\s*\d{1,3})?$/;

/**
 * Read a link target and its display text as a Qur'ān citation.
 *
 * A range has two spellings. The subpath may carry it (`[[Q024#10-12]]`), which
 * is unambiguous but points at a heading that does not exist; or the alias may
 * be just the second number — `[[Q024#10|12]]` — which is what the importer and
 * the insert command write, because both links then resolve and the alias is
 * the one place a second number can travel.
 *
 * Accepts `Q024` and `QW024`, and tolerates a path before the file name
 * (`Quran/Q024`) since a link may be written either way. Returns `null` for
 * anything else — including the pre-migration `024 An-Nur` names, whose links
 * already carry their own display text.
 */
export function parseQuranLink(target: string, alias = ""): QuranLinkTarget | null {
	const verse = parseQuranTarget(target);
	if (!verse) return null;
	const trimmed = alias.trim();
	// The marker signal is the *leading* colon and nothing else: `:` or `:12`.
	// A colon anywhere in the alias is not a marker — an old-style citation
	// writes its display text that way (`[[Q001#1|الفاتحة : ١]]`), and reading it
	// as a marker drew a prose citation in the margin, which is what an English
	// translation showed on every old link.
	const marker = MARKER_ALIAS.exec(trimmed);
	// The older marker alias carried the locator itself (`22:15`, `22:3–22:4`).
	// It is still a marker — but only in that digits-and-colon shape: an
	// old-style citation names its sūra (`الفاتحة : ١`), and that is prose.
	const legacy = /^\d{1,3}\s*:\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3}\s*:\s*\d{1,3})?$/.test(trimmed);
	if (marker || legacy) {
		const numbers = trimmed.match(/\d{1,3}/g);
		const end = numbers ? Number(numbers[numbers.length - 1]) : verse.start;
		return { ...verse, marker: true, end: end > verse.start ? end : verse.start };
	}
	if (verse.start === verse.end) {
		const span = RANGE_ALIAS.exec(trimmed);
		if (span) {
			const end = Number(span[1]);
			if (end > verse.start) return { ...verse, end };
		}
	}
	return verse;
}

const SURA_TARGET = /^Q([A-Za-z]{0,2})([0-9]{1,3})$/;

/**
 * Read a link target as a Qur'ān citation, ignoring any alias.
 *
 * Accepts `Q024` and `QW024`, and tolerates a path before the file name
 * (`Quran/Q024`) since a link may be written either way. Returns `null` for
 * anything else — including the pre-migration `024 An-Nur` names, whose links
 * already carry their own display text.
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
	/**
	 * Draw the citation as a two-line label instead of a bracketed one — the box
	 * around it is the cartouche — with no brackets of its own. Which part goes
	 * on which line follows what the sūra part *is*: a sūra name is a label, so
	 * it takes the first line with the prefix (`الفاتحة` / `٤`, `Q An-Nur` /
	 * `10`); a sūra number is the first half of the locator, so it stays with
	 * the verse on the second line (`Q` / `2:24`).
	 *
	 * The renderer's spans are `textContent`, so a newline is what produces the
	 * break in both views (`white-space: pre-line` in the stylesheet); it is a
	 * plain string so a citation copied out of the note stays readable.
	 */
	lines?: boolean;
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

	const prefix = style.prefix.trim();
	if (options.lines) {
		// Two lines, and which part goes on which is decided by what the sūra
		// part *is*. A sūra **name** is a label: it belongs on the first line,
		// with the prefix, and the verse numbers below it (`الفاتحة` / `٤`). A
		// sūra **number** is not a label but the first half of the locator, so
		// it stays whole with the verse — `Q` above, `2:24` below. Putting the
		// number on the first line split one reference (`2:24`) across the
		// cartouche and read as a mangled version of the Arabic form.
		const named = style.surah === "name" && surahPart !== "";
		const head = named ? [prefix, surahPart].filter(Boolean).join(" ") : prefix;
		let tail = named ? verses : (surahPart ? `${surahPart}${style.separator}${verses}` : verses);
		const label = RIWAYAS[riwaya];
		if (riwaya && label && style.showRiwaya) {
			tail = `${tail}${arabic ? "،" : ","} ${arabic ? label.ar : label.en}`;
		}
		return head ? `${head}\n${tail}` : tail;
	}

	let body = surahPart ? `${surahPart}${style.separator}${verses}` : verses;

	const label = RIWAYAS[riwaya];
	if (riwaya && label && style.showRiwaya) {
		body = `${body}${arabic ? "،" : ","} ${arabic ? label.ar : label.en}`;
	}

	if (prefix) body = `${prefix} ${body}`;

	const [open, close] = BRACKETS[style.bracket];
	return `${open}${body}${close}`;
}

/**
 * The text a marginal reference should show: `24:10`, or `24:10–12` for a range.
 *
 * A marker prints the sūra and āya in Latin digits whatever the prose style
 * says — it is a locator in a narrow gutter, not a citation in a sentence, and
 * it has been that way in every riwāya. No brackets: the margin is the frame.
 */
export function formatMarker(verse: QuranLinkTarget, style: CitationStyle): string {
	const surah = String(verse.surah);
	if (verse.start === verse.end) return `${surah}:${verse.start}`;
	// The margin's slot is narrow: the second end is a verse number in the same
	// sūra, so the sūra is not repeated (`22:3–4`).
	return `${surah}:${verse.start}${style.rangeDash}${verse.end}`;
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
