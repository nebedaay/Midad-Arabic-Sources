#!/usr/bin/env python3
"""Retrieve Quran verses with tashkīl. For tashkīl restoration and quote matching."""

import os
import itertools
import re
import unicodedata
import sqlite3
from difflib import SequenceMatcher
from pathlib import Path

# Display and clean-up live in their own module: it never searches the
# muṣḥaf, so a change there cannot discover a new citation. Imported here so
# every existing caller keeps using `quran` as before.
from quran_render import (
    balance_ornate_parens,
    dedupe_run_links,
    dedupe_same_verse_links,
    dedupe_verse_markers,
    fix_wikilinks,
    is_marker_display,
    normalize_quran_link_display,
    strip_inline_verse_links,
    strip_orphan_quote_classes,
    strip_redundant_raw_citations,
    _LINK_ANY,
    _MARKER_AT,
    _MARKER_DISPLAY,
    _RANGE_ALIAS,
    _TO_WESTERN,
    _VERSE_HEADING_LINE,
)

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
QURAN_DIR = VAULT / os.environ.get("MIDAD_CANONICAL_QURAN_DIR", "")
if not os.environ.get("MIDAD_CANONICAL_QURAN_DIR"):
    for _candidate in (
        "_7 Sources/Installed Sources/Quran",
        "Midad Arabic Sources/Installed Sources/Quran",
        "_7 Sources/Quran",
    ):
        if (VAULT / _candidate).is_dir():
            QURAN_DIR = VAULT / _candidate
            break
    else:
        QURAN_DIR = VAULT / "_7 Sources/Installed Sources/Quran"
# NOTE: bump the version whenever `normalize_arabic` changes. The index's
# `norm` column is written once, from whatever the normaliser was at build
# time; a stale index keeps serving the old spelling and the whole-Qur'ān
# search then misses every verse the change affected (the rasm fold left 144
# verses with a stored `حَيَوٰة` its caller can no longer spell). Versioning the
# file makes the rebuild automatic.
#
# v4 — `_fold_rasm_word` squeezes a run of one letter and drops a final yāʾ.
# v5 — alif maqṣūra is stripped as the long ā it is, not folded to yāʾ, so
#      `أدراك`/`أَدْرَىٰكَ` and `أراك`/`أرىك` agree.
# v6 — the Farsi yeh (U+06CC) folds to ي instead of being dropped: it is a
#      yāʾ, and dropping it made `خیر` (`خر`) miss `خَيْرٌ` (`خير`).
# v7 — the vocative particle is joined to the word it calls (`يا أيها` →
#      `يَٰٓأَيُّهَا`'s single word), before alif-stripping cuts `يا` to `ي`. No
#      verse is affected — the muṣḥaf never writes `يا` as its own token — so
#      the stored text is the same; the query is what changes.
SQLITE_DB = QURAN_DIR / ".quran-v7.sqlite"

# A sūra note is named for its citation: `Q024` (Ḥafṣ) or `QW024` (a riwāya).
# The old `024 An-Nur.md` names are still recognised so a half-migrated vault
# keeps working, but nothing writes them.
SURA_NOTE = re.compile(r"^Q[A-Z]{0,2}(\d{3})$")


def surah_note(surah_num: int, folder: Path | None = None) -> tuple[str, Path] | None:
    """The sūra note for a number: its stem (`Q024`) and its path."""
    where = folder or QURAN_DIR
    want = f"{surah_num:03d}"
    for path in where.glob(f"Q*{want}.md"):
        match = SURA_NOTE.match(path.stem)
        if match and match.group(1) == want:
            return path.stem, path
    for pattern in (f"{want} *.md", f"* - {want} *.md"):
        for path in where.glob(pattern):
            return path.stem, path
    return None


def load_verse(surah_num: int, verse: int) -> str | None:
    """Load a single verse with tashkīl from the sura file."""
    found = surah_note(surah_num)
    if not found:
        return None
    path = found[1]
    text = path.read_text(encoding="utf-8")
    m = re.search(rf'^# {verse}\s*$(.+?)(?=^# |\Z)', text, re.MULTILINE | re.DOTALL)
    if not m:
        return None
    body = m.group(1).strip()
    # A non-canonical edition writes its correspondence marker at the start of
    # every verse; the verse text itself begins after it.
    body = re.sub(r"^\*\*\[\[[^\]]+\]\]\*\*\ufeff?", "", body).strip()
    return body or None


#: A citation link wrapped in literal parentheses: `([[Q022#5]])`, or the older
#: `([[Surah 14#5|14 : ٥]])`. The link is the citation; the parentheses were the
#: vault's way of setting it off before the renderer drew a box around it.
_PARENTHESISED_CITATION = re.compile(r"\(\s*(\[\[[^\]\n]*#\d+[^\]\n]*\]\])\s*\)")


def strip_citation_parentheses(content: str) -> tuple[str, int]:
    """`([[Q022#5]])` → `[[Q022#5]]`.

    A citation in the note is the link and, where needed, its alias — nothing
    else. The brackets a reader sees are drawn by the renderer (the cartouche),
    so a literal pair in the text prints *around* that box, which is not a
    citation style.
    """
    return _PARENTHESISED_CITATION.subn(r"\1", content)


def build_wikilink(surah: int, verse: int | str, end_verse: int = None, ar_verse: str = None, ar_end: str = None) -> str:
    """Build a bare citation link. Single: `[[Q003#37]]`.
    Range: `[[Q003#37|39]]` — the alias is the range's second verse.

    The link carries no display text on purpose: the plugin renders each
    citation from the reader's settings (sūra name or number, Arabic-Indic or
    Western digits, brackets), so baking an alias here would only duplicate
    work. A range keeps its second number in the alias — the one place a value
    genuinely has to travel with the link.

    Args:
        surah, verse: start verse (int or range string like "26-27")
        end_verse: if provided, produce a range
        ar_verse, ar_end: ignored, kept so callers need no change
    """
    _w_to_a = str.maketrans('0123456789', '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')
    _to_w = str.maketrans('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669',
                          '0123456789')
    stem, _arabic = get_surah_name(surah)

    start = str(verse).translate(_to_w)
    if end_verse is not None:
        end = str(end_verse).translate(_to_w)
        # A "range" whose ends are the same verse is just that verse.
        if end == start:
            end_verse = None
    if end_verse is not None:
        return f" [[{stem}#{start}|{end}]]"
    return f" [[{stem}#{start}]]"




# ── Cached Qur'an index for fast matching ──────────────────────

# ── SQLite-based search (parallel, faster fallback) ────────────

def _build_sqlite_db():
    """Build/load SQLite database for fast Qur'an searching."""
    if SQLITE_DB.exists():
        return sqlite3.connect(str(SQLITE_DB))
    
    conn = sqlite3.connect(str(SQLITE_DB))
    conn.execute("CREATE TABLE verses (surah INT, verse INT, norm TEXT, tashkil TEXT)")
    conn.execute("CREATE INDEX idx_norm ON verses(norm)")
    
    rows = []
    for f in sorted(QURAN_DIR.glob("*.md")):
        match = SURA_NOTE.match(f.stem)
        if not match:
            continue
        surah_num = int(match.group(1))
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r'^# (\d+)\s*$(.+?)(?=^# |\Z)', text, re.MULTILINE | re.DOTALL):
            verse_num = int(m.group(1))
            tashkil = m.group(2).strip()
            norm = normalize_arabic(tashkil)
            rows.append((surah_num, verse_num, norm, tashkil))
    
    conn.executemany("INSERT INTO verses VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    return conn


def _search_sqlite(normalized_text: str, surah: int = None) -> list[tuple[int, int, str]]:
    """Search SQLite for a normalized text substring. Returns [(surah, verse, tashkil), ...].
    If `surah` is given, restrict to that surah."""
    conn = _build_sqlite_db()
    results = []
    if surah is not None:
        rows = conn.execute(
            "SELECT surah, verse, tashkil FROM verses WHERE surah = ? AND norm LIKE ? LIMIT 10",
            (surah, f"%{normalized_text}%")
        )
    else:
        rows = conn.execute(
            "SELECT surah, verse, tashkil FROM verses WHERE norm LIKE ? LIMIT 5",
            (f"%{normalized_text}%",)
        )
    for row in rows:
        results.append((row[0], row[1], row[2]))
    return results


def _search_sqlite_loose(loose_text: str, surah: int = None) -> list[tuple[int, int, str]]:
    """Search with yāʾ removed from both sides.

    Source orthography can differ from the canonical text by a final alif /
    alif maqṣūra / yāʾ (`أراك` vs `أرىك`). This is a fallback after the exact
    search, so the looser comparison cannot displace a real match.
    """
    conn = _build_sqlite_db()
    results = []
    if surah is not None:
        rows = conn.execute(
            "SELECT surah, verse, tashkil FROM verses "
            "WHERE surah = ? AND REPLACE(norm, 'ي', '') LIKE ? LIMIT 10",
            (surah, f"%{loose_text}%")
        )
    else:
        rows = conn.execute(
            "SELECT surah, verse, tashkil FROM verses "
            "WHERE REPLACE(norm, 'ي', '') LIKE ? LIMIT 5",
            (f"%{loose_text}%",)
        )
    for row in rows:
        results.append((row[0], row[1], row[2]))
    return results

_CANONICAL_QURAN_DIR = QURAN_DIR


def get_surah_name(surah_num: int) -> tuple[str, str]:
    """Return (wikilink_stem, arabic_name) matching the actual sura filename."""
    found = surah_note(surah_num)
    if not found:
        return (f"Surah {surah_num}", f"{surah_num}")
    stem, path = found
    # Get the Arabic name from the aliases property, not every YAML list item
    # (`tags`, `midad-up`, and other properties also use `  -`).
    text = path.read_text(encoding="utf-8")
    block = re.search(r'^aliases:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)+)', text, re.M)
    aliases: list[str] = []
    if block:
        for line in block.group(1).splitlines():
            value = line.strip()
            if value.startswith("- "):
                value = value[2:].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if value:
                aliases.append(value)
    # Aliases: [romanized, short romanized, Arabic, padded Arabic] in the
    # canonical notes; index 2 is the Arabic form.
    arabic = aliases[2] if len(aliases) > 2 else str(surah_num)
    if arabic == str(surah_num) and QURAN_DIR != _CANONICAL_QURAN_DIR:
        # A riwāya's notes carry no Arabic alias of their own; the canonical
        # edition names the sūra.
        found = surah_note(surah_num, _CANONICAL_QURAN_DIR)
        if found:
            text = found[1].read_text(encoding="utf-8")
            block = re.search(r'^aliases:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)+)', text, re.M)
            if block:
                values = [line.strip()[2:].strip().strip("\"'")
                          for line in block.group(1).splitlines()
                          if line.strip().startswith("- ")]
                if len(values) > 2:
                    arabic = values[2]
    return (stem, arabic)













def strip_verse_emblems(text: str) -> str:
    """Remove a ۝ verse emblem — and any number it carries — from a quotation.

    The emblem is a *marker*: in the muṣḥaf it holds the āya number, and in this
    vault the number is supplied by the margin instead. An emblem left inside a
    quotation therefore prints an empty ornament, which reads as an error. A
    quotation that spans two verses keeps the two verses' words, separated by a
    space, exactly as a joined quotation is written elsewhere.
    """
    # The emblem, with or without a number: `۝`, `۝٤٩`.
    text = re.sub(r"\s*\u06DD[\u0660-\u0669\d]*\s*", " ", text)
    # A verse number the OCR set as text: `(٤٩)`, `(50)`, `[ ٤٩ ]`. The muṣḥaf
    # itself contains no digits, so inside a quotation a number is always a
    # citation left behind by the source, never a word.
    text = re.sub(r"\s*[\(\[]?\s*[\u0660-\u0669\d]+\s*[\)\]]?\s*", " ", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def render_quran_quote(text: str, position: str, surah: int, verse: int,
                       end_verse: int | str | None = None) -> str:
    """The one renderer for every Qur'ān quotation.

    `position` is `begin`, `full`, or `end`. All three use the same italic +
    `.quran-quote` wrapper and the same citation link. Only the ornate opening
    (`begin`/`full`) and closing (`full`/`end`) parentheses vary, so a quote
    split across a page has exactly one opening and one closing.
    """
    body = text.strip()
    fragment = get_tashkil_fragment(body, surah, verse)
    if fragment:
        body = fragment
    opening = "\ufd3f" if position in ("begin", "full") else ""
    closing = "\ufd3e" if position in ("end", "full") else ""
    link = build_wikilink(surah, verse, end_verse=end_verse).strip()
    return f"*{opening}{body}{closing}{{.quran-quote}}* {link}"


# The Uthmani rasm writes the long ā of a handful of everyday words with wāw,
# where modern typography writes alif: ٱلْحَيَوٰة is الحياة, ٱلصَّلَوٰة is الصلاة,
# ٱلرِّبَوٰا is الربا. `normalize_arabic` strips alif, so the two spellings land
# one letter apart (`لحيوه` against `لحيه`) — enough to stop a quotation matching
# the verse it quotes, which is exactly what happened to a transcription whose
# OCR spelled حياة the way a modern typesetter would.
#
# Keys are the shape the word takes *after* alif and tashkīl are stripped, and
# the match is by word ending so an article or prefix does not defeat it
# (`لحيوه` ends with `حيوه`).
_RASM_WAW = {
    "حيوه": "حيه",    # حيوة → حياة
    "صلوه": "صله",    # صلوة → صلاة
    "زكوه": "زكه",    # زكوة → زكاة
    "مشكوه": "مشكه",  # مشكوة → مشكاة
    "نجوه": "نجه",    # نجوة → نجاة
    "غدوه": "غده",    # غدوة → غداة
    # `ٱلرِّبَوٰا` is the one where the wāw *is* the third radical. The keys are
    # the shape a word has *after* the alifs are gone, so this is `ربو`, not
    # `ربوا` — the old key was never reached at all, and its value re-introduced
    # an alif the modern `الربا` had already lost.
    "ربو": "رب",      # ربو → ربا
}


def _fold_rasm_word(word: str) -> str:
    """Respell an Uthmani word the modern way, for matching only.

    Two folds, both of which have to be applied to *both* sides of a
    comparison, and both of which the rasm itself requires:

    - the long-ā wāw (`_RASM_WAW`): ٱلْحَيَوٰة is written الحياة;
    - a run of one letter written twice. The muṣḥaf merges the article's lām
      with a root lām under a shadda, so `ٱلَّيْلَ` gives `ليل` once the mark is
      stripped while a modern typesetter writes `الليل`, `لليل`; `أَيَّىٰمِ`
      gives `ييم` where `أيام` gives `يم`; `جَآءُو` gives `جو` where `جاؤوا`
      gives `جوو`. Squeezing a run to one letter makes every pair agree
      (`ليل`, `يم`, `جو`), where expanding the shadda would not — it would give
      `للله` for `ٱللَّه` against `لله` for `الله`.

    A final yāʾ is dropped for the same reason: the rasm writes the long ā with
    `ى`, a transcription may write it either way, and `أراك`/`أرىك` are one
    word. Dropping it on both sides makes them equal instead of substituting
    one spelling for the other *after* normalisation, which is what the old
    `find_verse_in_text` fallback did (and got wrong: `أراك` normalised to
    `رك` while its "variant" normalised to `ريك`, so only the variant could
    ever match).
    """
    for rasm, plain in _RASM_WAW.items():
        if word.endswith(rasm):
            word = word[: -len(rasm)] + plain
            break
    squeezed = re.sub(r"(.)\1+", r"\1", word)
    if len(squeezed) > 1 and squeezed.endswith("\u064A"):
        squeezed = squeezed[:-1]
    return squeezed


_POETRY_BLOCK = re.compile(r"(?m)^>\[!arabic-poetry\][^\n]*(?:\n>[^\n]*)*")
_POETRY_QURAN = re.compile(
    r"\*{0,2}\[\[[^\]\n]*\]\]\*{0,2}|~?\ufd3f~?|~?\ufd3e~?")


def mask_poetry(content: str) -> tuple[str, list[str]]:
    """Set poetry callouts aside while quotations are discovered.

    A poetry volume runs to hundreds of pages with a handful of quotations in its
    preface, and a line of verse is exactly the shape the matcher studies
    hardest — ornate parens, short fragments, no prose around them. Nothing
    inside a `>[!arabic-poetry]` callout needs a citation, so the whole block is
    parked, with any Qur'ān marking already in it removed (the words stay), and
    restored after the passes have run.
    """
    blocks: list[str] = []

    def park(m: re.Match) -> str:
        blocks.append(_POETRY_QURAN.sub("", m.group(0)))
        return f"\x10POETRY{len(blocks) - 1}\x11"

    return _POETRY_BLOCK.sub(park, content), blocks


def unmask_poetry(content: str, blocks: list[str]) -> str:
    for index, block in enumerate(blocks):
        content = content.replace(f"\x10POETRY{index}\x11", block)
    return content


#: The vocative particle as a separate word, with whatever marks it carries.
_VOCATIVE = re.compile(r"(?<![\u0621-\u064A])((?:ي|ى)[\u064B-\u0652\u0670\u0674]*ا"
                       r"[\u064B-\u0652]*)[ \t\u00a0]+")


def _join_vocative(text: str) -> str:
    """Attach a separate `يا` to the word it calls, as the muṣḥaf writes it.

    `يَٰٓأَيُّهَا`, `يَٰقَوْمِ`, `يَٰبَنِىٓ` are one word in the muṣḥaf and two in
    every modern typesetter's hands (`يا أيها`, `يا قوم`). No verse has `يا` as
    a token of its own, so removing that space can only move a transcription
    towards the muṣḥaf. It has to happen before the alif-stripping in
    `normalize_arabic`, which cuts a bare `يا` down to `ي`: `يا أيها` then
    became `ي` + `يه` = `ييهلنس` where the verse gives `يهلنس`, and the phrase
    resolved nowhere.
    """
    return _VOCATIVE.sub(r"\1", text)


def normalize_arabic(text: str) -> str:
    """Strip tashkīl and normalize Unicode for matching."""
    text = _join_vocative(text)
    # Aggressively normalizes away orthographic variants common in
    # non-Quranic Arabic typography vs Quranic orthography
    text = text.replace("\u06E5", "").replace("\u06E6", "")  # small waw/yeh
    text = text.replace("\u0670", "").replace("\u0674", "")  # dagger alef, high hamza
    text = text.replace("\u0621", "").replace("\u0626", "")  # standalone hamza, yeh-hamza
    text = text.replace("\u0640", "")  # tatweel (keep waw — initial waw is consequential)
    # Alef variants: strip all (handles rasm variation like ذلك/ذالك, الكتب/الكتاب)
    for ch in "\u0623\u0625\u0622\u0671\u0627":
        text = text.replace(ch, "")
    # Diacritics
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.category(c).startswith("Mn"))
    # Remaining normalization
    text = text.replace("\u0629", "\u0647")  # ة → ه
    # Alif maqṣūra is a long-ā marker, not a yāʾ, and it is *final in the word it
    # belongs to*: what looks medial is a suffix attached to it (`أَدْرَىٰ` + `كَ`
    # is written `أَدْرَىٰكَ` where modern typography writes `أدراك`; likewise
    # `هَوَىٰهُ`, `مَوْلَىٰكُمْ`, `هَدَىٰنَا`). Folding it to ي left those one
    # letter apart (`ومدريك` against `ومدرك`), and the "try the other spelling"
    # step in the matcher existed only to paper over that. Treated as what it is
    # — a long ā, like the dagger alif — it disappears on both sides.
    text = text.replace("\u0649", "")                        # ى: long ā
    # Farsi yeh is a *yāʾ*, not an alif: a Persian-influenced OCR writes `خیر`
    # where the muṣḥaf writes `خَيْرٌ`, and dropping the letter made the two
    # spellings diverge (`خر` against `خير`). It is folded to ي like any other.
    text = text.replace("\u06CC", "\u064A")                  # ی → ي
    # Strip isolated * (space on both sides) — Gemini's verse separators
    text = re.sub(r'\s*\*\s*', ' ', text)
    # Fold word by word, so the rasm spelling is caught wherever the word sits in
    # the verse and an article cannot hide it, then join without spaces.
    words = []
    for word in text.split():
        word = re.sub(r'[^\u0621-\u064A\u067E\u0686\u0698\u06A9\u06AF]', '', word)
        words.append(_fold_rasm_word(word))
    return "".join(words)

def _normalize_surah_name(s: str) -> str:
    """Normalize a surah name for lookup while KEEPING the letters that
    distinguish names. `normalize_arabic` strips alef/hamza, which collapses
    e.g. النساء (4) and الناس (114) to the same key; this does not."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.category(c).startswith("Mn"))
    for a, b in (("\u0623", "\u0627"), ("\u0625", "\u0627"), ("\u0622", "\u0627"),
                 ("\u0671", "\u0627"), ("\u0649", "\u064A"), ("\u0629", "\u0647"),
                 ("\u0624", "\u0648"), ("\u0626", "\u064A")):
        s = s.replace(a, b)
    s = re.sub(r'[^\u0600-\u06FF]', '', s)
    return s

# Characters stripped by normalize_arabic — kept in sync with _is_normalized_char
STRIPPED_CHARS = frozenset(
    "\u0640\u0670\u06E5\u06E6\u0627\u0623\u0625\u0622\u0671\u0621\u0674\u0626"
)

# Formulaic phrases that are almost never Quranic quotations
_BLACKLIST_RAW = [
    "وَٱللَّهُ أَعۡلَمُ",
    "وَٱللَّهُ أَعْلَم",
    "صَدَقَ ٱللَّهُ ٱلۡعَظِيمُ",
    "بِسۡمِ ٱللَّهِ",
    "بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ",
    "سُبۡحَٰنَ ٱللَّهِ",
    "ٱلۡحَمۡدُ لِلَّهِ",
    "ٱلۡحَمۡدُ لِلَّهِ رَبِّ ٱلۡعَٰلَمِينَ",
]
BLACKLISTED_PHRASES = frozenset(normalize_arabic(p) for p in _BLACKLIST_RAW)

def find_verse_in_text(arabic_text: str, possible_suras: list[int] = None,
                        hint_surah: int = None, hint_verse: int = None,
                        skip_filter: bool = False) -> list[tuple[int, int, str, float]]:
    """Find Qur'an verses matching a snippet.

    Search cascade (tafsīr context matters — a short phrase belongs to the verse
    under discussion even if it occurs elsewhere):
      1. the last cited verse, then ±5 around it;
      2. the rest of the last cited surah;
      3. the whole Qur'an.
    """
    normalized_input = normalize_arabic(arabic_text)
    # A short fragment is still resolvable inside the verse a commentary is
    # discussing; only a whole-Qur'ān search needs the longer minimum.
    if len(normalized_input) < 5:
        return []

    # 1. Guided: last cited verse, then ±5 around it.
    if hint_surah and hint_verse:
        for offset in [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]:
            v = load_verse(hint_surah, hint_verse + offset)
            if v and normalized_input in normalize_arabic(v):
                return [(hint_surah, hint_verse + offset, v, 1.0)]

    # 2. Rest of the last cited surah (nearest verse first).
    if hint_surah:
        try:
            su = _search_sqlite(normalized_input, surah=hint_surah)
            if su:
                su = sorted(su, key=lambda r: abs(r[1] - (hint_verse or r[1])))
                return [(s, v, t, 1.0) for s, v, t in su[:5]]
        except Exception:
            pass

    # 3. Whole Qur'an.
    try:
        sql_results = _search_sqlite(normalized_input)
        if sql_results:
            nlen = len(normalized_input)
            # A short phrase that occurs in several verses is not evidence of a
            # quotation *on its own*, which is why an unhinted search keeps the
            # filter: `الحمد لله` would otherwise be cited in every paragraph.
            # When the caller knows the verse under discussion — a tafsīr's
            # hint, or the verse just quoted — the phrase is being read inside
            # it, and neither its length nor its frequency should override that.
            # What stops a *sequence* of short quotations from one verse being
            # cited twice is the run rule (`keep_first_verse_link`), which is a
            # question about the run, not about the quotation's length.
            if not skip_filter and not hint_surah and nlen < 12 and len(sql_results) >= 3:
                return []
            return [(s, v, t, 1.0) for s, v, t in sql_results[:5]]
    except Exception:
        pass

    # 4. There is deliberately no "try the other spelling" step here. Writing
    # the quote's alif as alif maqṣūra (or the reverse) and searching again
    # assumed the two were interchangeable *after* normalisation, which they
    # are not — and it was done in the wrong direction: it rewrote the query
    # instead of teaching the normaliser the equivalence. `_fold_rasm_word`
    # drops a final yāʾ on both sides, which is the same fact applied once, in
    # the normaliser, where the index sees it too.

    # 5. Loose yāʾ-insensitive fallback, again only after exact attempts.
    #    Guarded like step 3: a short fragment is not evidence of a citation, and
    #    deleting yāʾ makes it weaker evidence still. Alif maqṣūra is already
    #    folded to yāʾ on both sides in `normalize_arabic`, so this step exists
    #    only for an OCR slip inside a real quotation — which needs a phrase, not
    #    a word. Without this guard a five-letter word can land inside an
    #    unrelated verse (`بيروت` inside `بِٱلْبِرِّ وَتَ`).
    if not skip_filter and len(normalized_input) < 12:
        return []
    loose_input = normalized_input.replace("ي", "")
    if loose_input:
        try:
            loose = _search_sqlite_loose(loose_input, surah=hint_surah)
            if loose:
                return [(s, v, t, 1.0) for s, v, t in loose[:5]]
            loose = _search_sqlite_loose(loose_input)
            if loose:
                return [(s, v, t, 1.0) for s, v, t in loose[:5]]
        except Exception:
            pass

    return []

def find_verse_after(normalized: str, surah: int, verse: int, offset: int,
                     max_next: int = 8):
    """Given a normalized quote and the position just after the previous quote,
    search this verse and its neighbours, nearest first.

    This is the order a commentary is read in, nearest first:

      1. the words that follow the last quotation in the same verse;
      2. words *earlier* in the same verse — a tafsīr returns to what it has
         already quoted far more often than it moves on, and a phrase that is
         not the next word is still usually this verse's;
      3. the next verses;
      4. the verses just before, for a passage that steps back;
      5. only then the whole-muṣḥaf search the caller falls back to.

    Returns (verse, end_offset) or None.
    """
    vtext = load_verse(surah, verse)
    if vtext is not None:
        vn = normalize_arabic(vtext)
        idx = vn.find(normalized, offset)
        if idx >= 0:
            return (verse, idx + len(normalized))
        # Not the next words, but possibly words already quoted in this verse.
        idx = vn.find(normalized)
        if idx >= 0:
            return (verse, idx + len(normalized))
    for v in range(verse + 1, verse + 1 + max_next):
        vtext = load_verse(surah, v)
        if not vtext:
            break
        vn = normalize_arabic(vtext)
        idx = vn.find(normalized)
        if idx >= 0:
            return (v, idx + len(normalized))
    for v in range(verse - 1, max(0, verse - 1 - max_next), -1):
        vtext = load_verse(surah, v)
        if not vtext:
            break
        vn = normalize_arabic(vtext)
        idx = vn.find(normalized)
        if idx >= 0:
            return (v, idx + len(normalized))
    return None


def _normalized_with_word_bounds(text: str) -> tuple[str, set[int], set[int]]:
    """The text with spaces gone, and where its words begin and end."""
    parts: list[str] = []
    starts: set[int] = set()
    ends: set[int] = set()
    length = 0
    for word in _join_vocative(text).split():
        normal = normalize_arabic(word)
        if not normal:
            continue
        starts.add(length)
        parts.append(normal)
        length += len(normal)
        ends.add(length)
    return "".join(parts), starts, ends


def words_in_sequence(verse_text: str, quote_text: str) -> bool:
    """True when the quote is the verse's words, on the verse's word boundaries.

    `normalize_arabic` drops the spaces, so a plain substring test can begin or
    end inside a word: `أي من الخوف` becomes `ايمنالخوف`, which lands across
    `…شَيْءٍ مِّنَ ٱلْخَوْفِ` in 2:155 and once turned a three-word gloss into a
    Qur'ān quotation whose "restored" text was `ىْءٍ مِّنَ ٱلْخَوْفِ`.

    Comparing *tokens* would be too strict the other way: a transcription
    writes `يَا أَيُّهَا` where the muṣḥaf writes `يَٰٓأَيُّهَا`, and every such
    split would hide a real quotation. So the verse is normalised with its word
    boundaries recorded, the quote is normalised whole, and the match has to
    start and end on one of those boundaries.
    """
    verse_norm, starts, ends = _normalized_with_word_bounds(verse_text)
    quote_norm = normalize_arabic(quote_text)
    if not verse_norm or not quote_norm:
        return False
    position = verse_norm.find(quote_norm)
    while position >= 0:
        if position in starts and (position + len(quote_norm)) in ends:
            return True
        position = verse_norm.find(quote_norm, position + 1)
    return False


#: How far after the cursor a one- or two-letter word may sit and still be the
#: quotation being glossed. A tafsīr glosses in order but skips the words it
#: does not discuss, so the next short quotation is usually the very next word
#: and often a few words further on — `الحمد` then `لله`, not `الحمد` then
#: `رب`. It is not, in practice, a word the commentary has already passed.
_SHORT_GLOSS_WINDOW = 6


def _verse_words(verse_text: str) -> list[tuple[int, int, str]]:
    """`(start, end, normalised)` for each word of a verse, in order."""
    words: list[tuple[int, int, str]] = []
    for match in re.finditer(r"\S+", verse_text):
        norm = normalize_arabic(match.group(0))
        if norm:
            words.append((match.start(), match.end(), norm))
    return words


def _word_index_after(verse_text: str, quote_text: str,
                      start_word: int = 0) -> int | None:
    """The word a commentary's glossing resumes at, after `quote_text`.

    A word index, not an offset into the normalised text: the folds change that
    text's length, and the index is what identifies *which* word was matched —
    which is the whole point when the words are one or two letters and several
    of them share a normalised form (`مَن` / `مِن`).

    A quotation that is the verse — or runs past it — returns 0: the commentary
    holds the whole āya and goes back to gloss it term by term, starting again
    at its first word.

    `start_word` prefers the occurrence at or after the cursor, so a repeated
    phrase does not send the cursor back to the verse's opening words; a genuine
    backward reference falls back to the first occurrence.
    """
    needle = normalize_arabic(quote_text)
    words = _verse_words(verse_text)
    if not needle or not words:
        return None
    joined = "".join(word[2] for word in words)
    if needle == joined or joined in needle:
        return 0
    for begin in (start_word, 0):
        if begin >= len(words):
            continue
        for start in range(begin, len(words)):
            accumulated = ""
            for end in range(start, len(words)):
                accumulated += words[end][2]
                if accumulated == needle:
                    return end + 1
                if not needle.startswith(accumulated):
                    break
        if begin == 0:
            break
    return None


#: A long passage may differ from the muṣḥaf by a letter or two — an OCR slip,
#: a dropped yāʾ, a doubled consonant — and no rule about *which* letter is as
#: reliable as the proportion of letters that agree. A 95% match across a long
#: span is not a coincidence; across three words it could be. Short spans
#: therefore keep exact matching, and this is consulted only after it fails.
_FUZZY_MIN_CHARS = 30
_FUZZY_RATIO = 0.95


def _fuzzy_span_in_text(text: str, quote_text: str) -> bool:
    """True when the quote occupies a word-aligned window of `text` at ≥95%.

    The window must begin and end on a word boundary, so a quotation still
    cannot match the inside of a word — what is tolerated is a letter or two
    *within* the passage. Windows are only considered at 90–110% of the quote's
    length, which keeps this to a handful of comparisons per word start.
    """
    quote_norm = normalize_arabic(quote_text)
    if len(quote_norm) < _FUZZY_MIN_CHARS:
        return False
    verse_norm, starts, ends = _normalized_with_word_bounds(text)
    if not verse_norm:
        return False
    size = len(quote_norm)
    low, high = size * 0.9, size * 1.1
    ends_sorted = sorted(ends)
    for start in sorted(starts):
        for end in ends_sorted:
            width = end - start
            if width < low:
                continue
            if width > high:
                break
            window = verse_norm[start:end]
            if SequenceMatcher(None, window, quote_norm).ratio() >= _FUZZY_RATIO:
                return True
    return False


#: A quotation may begin in one verse and run into the next; up to three
#: consecutive verses are considered before a span is called unverifiable.
_QUOTE_VERSE_SPAN = 3


def _matches_cited_verses(surah: int, verse: int, quote_text: str) -> bool:
    """True when the quote's words are the muṣḥaf's, from this verse onwards."""
    joined = ""
    for offset in range(_QUOTE_VERSE_SPAN):
        try:
            text = load_verse(surah, verse + offset) or ""
        except Exception:  # noqa: BLE001
            return False
        if not text:
            break
        joined = text if offset == 0 else joined + " " + text
        if words_in_sequence(joined, quote_text):
            return True
    # A long passage with a letter or two wrong (an OCR slip, a dropped yāʾ) is
    # still this verse, and `_fuzzy_span_in_text` says so only for spans long
    # enough that 95% cannot be a coincidence. One comparison, over the whole
    # passage: the union of the verses contains a single-verse quotation too.
    return bool(joined) and _fuzzy_span_in_text(joined, quote_text)


def canonical_quote_body(surah_no: int, start: int, end: int,
                         quote_text: str) -> str | None:
    """The muṣḥaf's own words for the passage a quotation covers.

    A quotation is written out from our canonical text, not from the OCR: the
    source's spelling, its verse numbers, and anything else the model left
    inside the parentheses are all replaced by the āya itself. A multi-verse
    passage is one span here, so a range gets the same treatment as a single
    verse — the words are contiguous across the verse boundary.
    """
    try:
        parts = [load_verse(surah_no, v) or "" for v in range(start, end + 1)]
    except Exception:  # noqa: BLE001
        return None
    joined = " ".join(part for part in parts if part)
    if not joined:
        return None
    span = _word_span_for(joined, normalize_arabic(quote_text))
    return joined[span[0]:span[1]] if span else None


def _word_span_for(verse_text: str, target_norm: str,
                   start_word: int = 0) -> tuple[int, int] | None:
    """The character span of `verse_text` whose normalised form is `target_norm`.

    Boundaries are found by walking *words*, not by an offset into the
    normalised string, because the normaliser folds at word level (a squeezed
    run, a dropped final yāʾ) and those folds change the length — so an offset
    into the normalised text does not point at the same place in the original,
    and using one as if it did produced a "restored" fragment that began in the
    middle of a word. Extending word by word keeps the span exact by
    construction, and still tolerates a source that splits one muṣḥaf word into
    two (`يَا أَيُّهَا` against `يَٰٓأَيُّهَا`): the two words are accumulated
    before the comparison is made.

    `start_word` asks for the occurrence at or after the commentary's cursor. A
    repeated phrase (`وَمَا أَدْرَاكَ`) is glossed where it stands, and taking
    the verse's first occurrence instead would move the cursor backwards and
    put every following fragment in the wrong place. A backward reference still
    resolves: if there is no occurrence at or after the cursor, the search
    falls back to the verse's first.
    """
    spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", verse_text)]
    for begin in (start_word, 0):
        if begin >= len(spans):
            continue
        for i in range(begin, len(spans)):
            for j in range(i, len(spans)):
                acc = normalize_arabic(verse_text[spans[i][0]:spans[j][1]])
                if acc == target_norm:
                    return (spans[i][0], spans[j][1])
                if not target_norm.startswith(acc):
                    break
        if begin == 0:
            break
    return None


def get_tashkil_fragment(quote_text: str, surah_num: int, verse_num: int) -> str | None:
    """Given a quote and its (surah, verse), find the matching fragment with tashkīl."""
    verse = load_verse(surah_num, verse_num)
    if not verse:
        return None
    # A word of one or two letters is not restorable: several share one
    # normalised form (`مَن` / `مِن`), so the first occurrence in the verse is
    # not necessarily the one quoted, and the author's own vocalisation is
    # better than a confident guess.
    if len(normalize_arabic(quote_text)) < 3:
        return None
    # Strip الآية from end
    quote_text = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', quote_text).strip()
    # The words must be this verse's words, in order. Without this the index
    # arithmetic below can return the inside of an unrelated word — the origin
    # of a "restored" quotation that read `ىْءٍ مِّنَ ٱلْخَوْفِ`.
    if not words_in_sequence(verse, quote_text):
        return None
    target = normalize_arabic(quote_text)
    span = _word_span_for(verse, target)
    if span is None and '.' in quote_text:
        segments = quote_text.replace('.', '%%').split('%%')
        tashkil_parts = []
        for seg in segments:
            seg = seg.strip()
            if len(seg) < 10:
                tashkil_parts.append(seg); continue
            seg_span = _word_span_for(verse, normalize_arabic(seg))
            if seg_span:
                tashkil_parts.append(verse[seg_span[0]:seg_span[1]])
            else:
                tashkil_parts.append(seg)
        return ' * '.join(tashkil_parts)
    if span is None:
        # A spelling difference (alif maqṣūra, rasm wāw, a doubled letter) is
        # folded by `normalize_arabic` on both sides, which is why the words can
        # still be in sequence here. What is *not* done — here or anywhere — is
        # deleting a letter to force a match, and the span is never guessed from
        # an offset: failing to place it means keeping the source's spelling.
        return None
    return verse[span[0]:span[1]]


def find_verse_range(quote_text: str, surah: int, start_verse: int) -> tuple[int, int] | None:
    """Find the verse range a quote spans by walking consecutive verses.
    Returns (start_verse, end_verse) or None."""
    nq = normalize_arabic(quote_text)
    combined = ""
    current = start_verse
    while True:
        v = load_verse(surah, current)
        if not v:
            break
        combined = v if not combined else f"{combined} {v}"
        if nq in normalize_arabic(combined) or _fuzzy_span_in_text(combined, quote_text):
            return (start_verse, current)
        current += 1
        if current - start_verse > 20:  # safety limit
            break
    return None


def _is_normalized_char(ch: str) -> bool:
    """Check if a character would be kept in normalize_arabic output."""
    if ch in STRIPPED_CHARS:
        return False
    if unicodedata.category(ch).startswith("Mn"):
        return False
    return len(ch.strip()) > 0

def process_markdown_file(filepath: str, dry_run: bool = False) -> dict:
    """Process a markdown file, replacing Quran quotes with tashkīl versions.
    
    Returns stats dict."""
    path = Path(filepath)
    content = path.read_text(encoding="utf-8")
    original = content
    
    LF = '\ufd3f'; LE = '\ufd3e'
    # Pattern: *﴿text﴾{.quran-quote}* ([[NNN Surah#N|ref]])
    pattern = re.compile(
        r'\*' + LF + r'([^' + LE + r']+)' + LE + r'\{\.quran-quote\}\*'
        r'\s*\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})\s+[^#\]]+#(\d+)\|[^\]]+\]\]\)'
    )
    
    replaced = 0
    not_found = 0
    no_ref = 0
    
    def replace_match(m):
        nonlocal replaced, not_found, no_ref
        quote_text = m.group(1).strip()
        surah_num = int(m.group(2))
        verse_num = int(m.group(3))
        
        if not surah_num or not verse_num:
            no_ref += 1
            return m.group(0)
        
        tashkil = get_tashkil_fragment(quote_text, surah_num, verse_num)
        if not tashkil:
            not_found += 1
            return m.group(0)
        
        replaced += 1
        # Preserve the full structure but replace the quote text
        return m.group(0).replace(quote_text, tashkil, 1)
    
    new_content = pattern.sub(replace_match, content)
    
    if not dry_run and new_content != original:
        path.write_text(new_content, encoding="utf-8")
    
    return {
        "file": str(filepath),
        "quotes_total": len(list(pattern.finditer(content))),
        "replaced": replaced,
        "not_found": not_found,
        "dry_run": dry_run,
    }


_VERSE_NORM_CACHE: dict[tuple[int, int], str] = {}
_VERSE_TOKEN_CACHE: dict[tuple[int, int], list[str]] = {}
_VERSE_WORD_CACHE: dict[tuple[int, int], list[str]] = {}


def clear_caches() -> None:
    """Drop the verse caches (after switching to another riwāya)."""
    _VERSE_NORM_CACHE.clear()
    _VERSE_TOKEN_CACHE.clear()
    _VERSE_WORD_CACHE.clear()


def verse_norm(surah: int, verse: int) -> str:
    """A verse's normalized text, cached."""
    key = (surah, verse)
    if key not in _VERSE_NORM_CACHE:
        _VERSE_NORM_CACHE[key] = normalize_arabic(load_verse(surah, verse) or "")
    return _VERSE_NORM_CACHE[key]


def verse_words(surah: int, verse: int) -> list[str]:
    """A verse's words with their tashkīl, cached."""
    key = (surah, verse)
    if key not in _VERSE_WORD_CACHE:
        _VERSE_WORD_CACHE[key] = (load_verse(surah, verse) or "").split()
    return _VERSE_WORD_CACHE[key]


def verse_tokens(surah: int, verse: int) -> list[str]:
    """A verse as normalized words (normalize_arabic removes spaces)."""
    key = (surah, verse)
    if key not in _VERSE_TOKEN_CACHE:
        _VERSE_TOKEN_CACHE[key] = [normalize_arabic(w) for w in verse_words(surah, verse)]
    return _VERSE_TOKEN_CACHE[key]


def match_verse_spans(text: str, verse_tokens_: list[str]) -> list[tuple[int, int, int, int]]:
    """The runs of `text` that are consecutive words of one verse.

    Punctuation is not in the muṣḥaf, so it ends a quotation; a dash-delimited
    gloss closes the run and the verse resumes after it. Each run is returned as
    (start, end, first verse word, last verse word). This is a principle of the
    corpus, not of one repository: every tafsīr uses it.
    """
    words = list(re.finditer(r"\S+", text))
    vt = verse_tokens_
    if not words or not vt:
        return []
    trail = _WORD_TRAIL
    enders = ("،", ",", "؛", ";", ".", ":", "!")
    spans: list[tuple[int, int, int, int]] = []
    current: int | None = None
    started_at = 0
    i = vpos = 0

    def resume(at: int, verse_index: int) -> int | None:
        fallback = None
        for k in range(at, min(len(words), at + 12)):
            if normalize_arabic(words[k].group(0).strip(trail)) != vt[verse_index]:
                continue
            if fallback is None:
                fallback = k
            if (verse_index + 1 >= len(vt) or
                    (k + 1 < len(words) and
                     normalize_arabic(words[k + 1].group(0).strip(trail)) == vt[verse_index + 1])):
                return k
        return fallback

    while i < len(words) and vpos < len(vt):
        raw = words[i].group(0)
        token = normalize_arabic(raw.strip(trail))
        if token == vt[vpos]:
            if current is None:
                current = i
                started_at = vpos
            i += 1
            vpos += 1
            ends = raw.endswith(enders) or (
                i < len(words) and words[i].group(0).startswith(enders))
            if ends:
                if current is not None:
                    spans.append((current, i - 1, started_at, vpos - 1))
                    current = None
                break
            continue
        if current is not None and i - current >= 1:
            spans.append((current, i - 1, started_at, vpos - 1))
            current = None
        if vpos >= len(vt):
            break
        resumed = resume(i, vpos)
        if resumed is None:
            break
        current = resumed
        started_at = vpos
        i = resumed + 1
        vpos += 1

    if current is not None and i - current >= 1:
        spans.append((current, i - 1, started_at, vpos - 1))

    out: list[tuple[int, int, int, int]] = []
    for first, last, vfirst, vlast in spans:
        begin = words[first].start()
        end = words[last].start() + len(words[last].group(0).rstrip(trail))
        if end > begin:
            out.append((begin, end, vfirst, vlast))
    return out


_CITE_LINK = re.compile(r"\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\||\]\])")


def _quotation_words(text: str) -> list[tuple[int, int, str]]:
    """Each word of `text` as (start, end, token) — the part that can be quoted.

    A word may be wrapped in quotation marks (`وَ«مُسَخَّرَاتٌ»`): what is quoted
    is the inside, and the prose stays outside the boundary. Punctuation around
    a word is likewise not part of it.
    """
    out: list[tuple[int, int, str]] = []
    for m in re.finditer(r"\S+", text):
        begin = m.start()
        end = m.start() + len(m.group(0).rstrip(_WORD_TRAIL))
        inner = re.search(r"[«\"“]([^«»\"“”]*)[»\"”]", m.group(0))
        if inner and inner.group(1).strip(_WORD_TRAIL):
            begin = m.start() + inner.start(1)
            end = m.start() + inner.end(1)
        out.append((begin, end, normalize_arabic(text[begin:end].strip(_WORD_TRAIL))))
    return out


def find_verse_fragment(text: str, verse_tokens: list[str]):
    """A whole span of `text` that is consecutive words of the verse.

    A quotation may be a phrase from the middle of the verse (`لَحْمًا طَرِيًّا`
    from 16:14), which the running matcher — which starts at the verse's first
    word — cannot reach. Returns (start, end, first word, last word) or None.
    """
    words = _quotation_words(text)
    if not words:
        return None
    tokens = [w[2] for w in words]
    # The window may still carry prose before the quotation (no lead-in, no
    # delimiter): try the longest suffix first, so the commentary is left out.
    for start in range(len(tokens)):
        piece = tokens[start:]
        while piece and not piece[-1]:
            piece.pop()
        if not piece or len(piece) > len(verse_tokens):
            continue
        for at in range(len(verse_tokens) - len(piece) + 1):
            if verse_tokens[at:at + len(piece)] == piece:
                return (words[start][0], words[start + len(piece) - 1][1],
                        at, at + len(piece) - 1)
    return None


def _quotation_window(content: str, position: int) -> tuple[str, int]:
    """The words before a citation that can belong to it.

    Never reaches back past a quotation already styled, a lead-in, or the
    previous link: the quotation is the words between that boundary and the
    citation. Returns (window, absolute start of the window).
    """
    before = content[:position]
    start = max(0, len(before) - 500)
    window = before[start:]
    cut = max(window.rfind("\n"), window.rfind("]]"),
              window.rfind("~﴾~"), window.rfind("﴾"),
              window.rfind(":"), window.rfind("："))
    if cut >= 0:
        window = window[cut + 1:]
        start += cut + 1
    abbr = re.search(r"\s*(?:الْآيَةَ|الْآيَةِ|الآية|الْايَة|الايه)\s*$", window)
    if abbr:
        window = window[:abbr.start()]
    return window, start


# The muṣḥaf as `token -> [(surah, verse), …]`, built once per run. A quotation
# is looked up by its rarest word, so finding where a mis-cited verse really
# comes from costs a handful of verse comparisons.
_MUSHAF_INDEX: dict[str, list[tuple[int, int]]] | None = None
_SURAH_VERSES: dict[int, list[tuple[int, list[str]]]] = {}


def _surah_verses(surah: int) -> list[tuple[int, list[str]]]:
    """Every verse of a sūra with its tokens, reading the note once."""
    if surah not in _SURAH_VERSES:
        verses: list[tuple[int, list[str]]] = []
        verse = 1
        while True:
            words = verse_words(surah, verse)
            if not words:
                break
            verses.append((verse, [normalize_arabic(w.strip(_WORD_TRAIL))
                                   for w in words]))
            verse += 1
            if verse > 300:
                break
        _SURAH_VERSES[surah] = verses
    return _SURAH_VERSES[surah]


def _mushaf_index() -> dict[str, list[tuple[int, int]]]:
    global _MUSHAF_INDEX
    if _MUSHAF_INDEX is None:
        index: dict[str, list[tuple[int, int]]] = {}
        for surah in range(1, 115):
            for verse, tokens in _surah_verses(surah):
                for token in set(tokens):
                    index.setdefault(token, []).append((surah, verse))
        _MUSHAF_INDEX = index
    return _MUSHAF_INDEX


def verse_exists(surah: int, verse: int) -> bool:
    """Whether the muṣḥaf the vault holds actually has this verse.

    Sūrat al-Naḥl has 128 verses, so a source citing `16:136` is naming a verse
    that does not exist — which is a fact about the citation, not about the
    commentary.
    """
    return any(v == verse for v, _tokens in _surah_verses(surah))


def _index_lookup(index: dict[str, list[tuple[int, int]]],
                  piece: list[str]) -> list[tuple[int, int]]:
    """Verses containing `piece` as a contiguous run."""
    if len(piece) < 3:
        return []
    rare = min(piece, key=lambda t: len(index.get(t, ())))
    hits: list[tuple[int, int]] = []
    for surah, verse in index.get(rare, ()):
        tokens = next((t for v, t in _surah_verses(surah) if v == verse), [])
        for at in range(len(tokens) - len(piece) + 1):
            if tokens[at:at + len(piece)] == piece:
                hits.append((surah, verse))
                break
    return hits


def _prefix_run(tokens: list[str], verse_tokens: list[str], minimum: int = 2) -> int:
    """The longest opening run of `tokens` that occurs in the verse."""
    top = min(len(tokens), len(verse_tokens))
    for k in range(top, minimum - 1, -1):
        piece = tokens[:k]
        for at in range(len(verse_tokens) - k + 1):
            if verse_tokens[at:at + k] == piece:
                return k
    return 0


def search_quoted_verse(words: list[str], *, trim: int = 6) -> list[tuple[int, int]]:
    """Every verse the quotation could belong to, from the longest agreement.

    Two readings of the window are tried. A citation normally names the verse
    where the quotation *begins*, so the opening words are looked up first; and
    since the window may still carry prose (no lead-in, no delimiter), the words
    that *reach* the citation are looked up too. The longer agreement wins,
    because it is the more specific evidence.
    """
    words = [w for w in words if w]
    if len(words) < 3:
        # Two words are too little to identify a verse: `وَاعْبُدُوا اللَّهَ`
        # opens dozens of them.
        return []
    index = _mushaf_index()
    best: list[tuple[int, int]] = []
    best_len = 2
    for k in range(len(words), 2, -1):
        hits = _index_lookup(index, words[:k])
        if hits:
            best, best_len = hits, k
            break
    for start in range(min(trim, len(words) - 2)):
        piece = words[start:]
        if len(piece) < 3:
            break
        hits = _index_lookup(index, piece)
        if hits:
            if len(piece) > best_len:
                best, best_len = hits, len(piece)
            break
    return best


def _verse_permutations(surah: int, verse: int) -> list[int]:
    """Verse numbers an author could have meant by transposing the digits."""
    digits = str(verse)
    seen: set[int] = set()
    for perm in itertools.permutations(digits):
        if perm[0] == "0":
            continue
        number = int("".join(perm))
        if number != verse and number not in seen and verse_exists(surah, number):
            seen.add(number)
    return sorted(seen)


def _quotation_is_verse(window: str, surah: int, verse: int) -> bool:
    """Whether the quotation in front of a citation belongs to that verse.

    A quotation may begin inside the verse (the window still carries prose) or
    open it and run on into the next verse, so both the opening words and the
    words that reach the citation are accepted.
    """
    tokens = verse_tokens(surah, verse)
    if not tokens:
        return False
    fragment = find_verse_fragment(window, tokens)
    if fragment and fragment[3] - fragment[2] + 1 >= 3:
        return True
    words = [w[2] for w in _quotation_words(window) if w[2]]
    return bool(words) and _prefix_run(words, tokens) >= 3


def _following_window(content: str, end: int) -> str:
    """The text after a citation, up to the next citation or the line's end.

    Some sources put the citation *before* the words it names
    (`قال تعالى [[2:5]]: …`), so the quotation is not always in front of it.
    """
    tail = content[end:end + 400]
    cut = tail.find("([[")
    if cut > 0:
        tail = tail[:cut]
    return tail.split("\n")[0]


def _intended_verse(surah: int, verse: int,
                    words: list[str]) -> tuple[int, int] | None:
    """The verse a citation probably meant, or None when it cannot be told.

    The number is the clue, so the nearest reading of it wins: an adjacent verse
    in the same sūra (`24:31` → `24:30`), then the same āya number in another
    sūra (`95:7` → `59:7`), then another verse of the same sūra (`7:124` →
    `7:142`), and only then a single match anywhere (`16:78` → `16:87`). With no
    quotation to go on, a citation naming a verse the sūra does not have is
    corrected only when one transposition of its digits does exist (`16:221` →
    `16:122`). Anything ambiguous is left exactly as the source wrote it.
    """
    hits = search_quoted_verse(words)
    if hits:
        for step in (1, -1):
            adjacent = (surah, verse + step)
            if adjacent in hits:
                return adjacent
        same_verse = [h for h in hits if h[1] == verse]
        if len(same_verse) == 1:
            return same_verse[0]
        same_surah = [h for h in hits if h[0] == surah]
        if len(same_surah) == 1:
            return same_surah[0]
        if len(hits) == 1:
            return hits[0]
        return None
    if not verse_exists(surah, verse):
        alternatives = _verse_permutations(surah, verse)
        if len(alternatives) == 1:
            return (surah, alternatives[0])
    return None


_AR_DIGITS = str.maketrans("0123456789", "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669")
_FULL_CITE_LINK = re.compile(r"\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})([^#\]]*)#(\d+)(?:\|([^\]]*))?\]\]\)?")
_REDUNDANT_CITATION = re.compile(
    r"^[\s\u00a0،,.;:]*"
    r"(?:الْآيَةَ|الْآيَةِ|الآية|الآيةِ|الْايَة|الايه)?"
    r"[\s\u00a0،,.;:]*$")


def _citation_verdict(content: str, m: re.Match) -> tuple[str, list[str], bool]:
    """The words before a citation, and whether they verify it.

    `(window, words, failing)`. A citation with no quotation in front of it is a
    reference rather than a misquotation, so it only fails when its verse does
    not exist. A quotation that the cited verse does not contain — whether the
    verse is in front of or after the citation — is a failure.
    """
    surah, verse = int(m.group(1)), int(m.group(3))
    window, _start = _quotation_window(content, m.start())
    words = [w[2] for w in _quotation_words(window)] if window.strip() else []
    words = [w for w in words if w]
    if not words:
        return window, words, not verse_exists(surah, verse)
    if _quotation_is_verse(window, surah, verse):
        return window, words, False
    if _quotation_is_verse(_following_window(content, m.end()), surah, verse):
        return window, words, False
    return window, words, True






#: Letters a Persian-influenced OCR uses where an Arabic font — and the
#: Uthmanic faces in particular — has no glyph: Farsi yeh shows as a missing
#: character inside a quotation. They are folded to their Arabic counterparts
#: only in text the pipeline *writes* as a Qur'ān quotation, never in the
#: surrounding prose, where a Persian word may legitimately use them.
_DISPLAY_FOLD = str.maketrans({"\u06CC": "\u064A", "\u06A9": "\u0643",
                               "\u06C1": "\u0647", "\u06BE": "\u0647"})


def _display(text: str) -> str:
    """The Arabic letters a quotation should be printed with."""
    return text.translate(_DISPLAY_FOLD)


def wrap_verse_spans(text: str, spans, surah: int, verse: int, *,
                     invisible: bool = True, replace: bool = True) -> str:
    """Wrap matched runs, optionally with the canonical words inside them."""
    canon_words = verse_words(surah, verse)
    edits: list[tuple[int, int, str]] = []
    for first, last, vfirst, vlast in spans:
        quote = text[first:last]
        if len(normalize_arabic(quote)) < 3:
            continue
        canon = " ".join(canon_words[vfirst:vlast + 1]) if canon_words else ""
        shown = _display((canon or quote) if replace else quote)
        marker = ("~﴿~" + shown + "~﴾~") if invisible else ("﴿" + shown + "﴾")
        edits.append((first, last, marker))
    for first, last, marker in reversed(edits):
        text = text[:first] + marker + text[last:]
    return text



def strip_raw_quran_citations(content: str) -> tuple[str, int]:
    """Remove every remaining source citation that names a Qur'ānic verse.

    Our own quote links are authoritative; keeping the source's square or
    parenthetical citation alongside them duplicates and mixes numbering styles.
    Wikilinks, markdown links, footnote marks, and ordinary numbered prose are
    not citations and are left alone.
    """
    lookup = _build_surah_lookup()
    # A citation is a *single* bracket span. The lookarounds keep the pattern
    # out of a wikilink's inner brackets (`[[stem#V|S:V]]` would otherwise look
    # like `[stem#V|S:V]` and the marker would be deleted), and out of an
    # already-escaped `\[…\]`.
    pattern = re.compile(r'(?<!\[)\[[^\[\]\n]{1,120}\](?!\])|\([^()\n]{1,120}\)')
    removed = 0

    def repl(m: re.Match) -> str:
        nonlocal removed
        value = m.group(0)
        inner = value[1:-1].strip()
        if not inner or '[[' in value or ']]' in value or '(' in inner or ')' in inner:
            return value
        if parse_gemini_ref(value, lookup):
            removed += 1
            return ''
        return value

    # A heading's own link is navigation, not a source citation: never strip it.
    lines = content.split("\n")
    for index, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        lines[index] = pattern.sub(repl, line)
    return "\n".join(lines), removed


def repair_citations(content: str) -> tuple[str, list[tuple[int, int, int, int]], list[str]]:
    """Correct a citation the muṣḥaf does not support, and report each fix.

    The quotation is the evidence: a source mis-numbers a verse by a transposed
    or dropped digit, and the words it printed belong to one verse. The link is
    rewritten in place, keeping the source's display style, so the corrected
    verse is the one that gets quoted, numbered and formatted. A citation that
    already verifies is never touched, and when the evidence points at more than
    one verse the source's own number is left alone.

    A text whose citations disagree wholesale is not a text with typos — it is
    the wrong edition or riwāya — so once two thirds of a page's quotations fail
    to verify, nothing on that page is rewritten and a warning is returned
    instead. Occasional errors are corrected; a systematic mismatch is reported.
    A page needs at least four quotations before its failures can be called
    systematic at all: three citations are as easily three coincidences.
    """
    matches = list(_FULL_CITE_LINK.finditer(content))
    verdicts = [(m, *_citation_verdict(content, m)) for m in matches]
    quoted = sum(1 for _m, _w, words, _f in verdicts if words)
    failing = sum(1 for _m, _w, words, bad in verdicts if words and bad)
    if quoted >= 4 and failing * 3 > quoted * 2:
        return content, [], [
            f"{failing} of {quoted} quotations do not verify — the edition or "
            "riwāya may differ; left as the source wrote them"]

    corrections: list[tuple[int, int, int, int]] = []
    edits: list[tuple[int, int, str]] = []
    previous: tuple[int, int, int] | None = None  # (surah, verse, end offset)
    for m, window, words, bad in verdicts:
        surah, verse = int(m.group(1)), int(m.group(3))
        if (content[:m.start()].rstrip().endswith(("﴾", "~﴾~"))
                or (words and not bad)):
            previous = (surah, verse, m.end())
            continue
        target = _intended_verse(surah, verse, words)
        if not target or target == (surah, verse):
            previous = (surah, verse, m.end())
            continue
        new_surah, new_verse = target
        stem, arabic = get_surah_name(new_surah)
        if (previous is not None
                and previous[:2] == (new_surah, new_verse)
                and _REDUNDANT_CITATION.match(content[previous[2]:m.start()])):
            # The corrected verse is the one just cited, with nothing but
            # `الآية` between: the second link says the same thing twice.
            edits.append((m.start(), m.end(), ""))
        else:
            edits.append((m.start(), m.end(), f" [[{stem}#{new_verse}]]"))
        corrections.append((surah, verse, new_surah, new_verse))
        previous = (new_surah, new_verse, m.end())
    for first, last, replacement in reversed(edits):
        content = content[:first] + replacement + content[last:]
    return content, corrections, []


def wrap_cited_quotes(content: str) -> tuple[str, int]:
    """Give every verse citation the quotation that belongs to it.

    A source often writes `… وَتَسْتَخْرِجُوا مِنْهُ حِلْيَةً [١٦ \\ ١٤]` with no
    delimiter: the citation identifies the verse, and the words before it are
    the quotation. They are matched against the cited verse and wrapped
    (canonical text inside, invisible boundaries), so identification and
    formatting always arrive together.
    """
    edits: list[tuple[int, int, str]] = []
    for m in _CITE_LINK.finditer(content):
        try:
            surah, verse = int(m.group(1)), int(m.group(2))
        except ValueError:
            continue
        before = content[:m.start()]
        if before.rstrip().endswith(("﴾", "~﴾~")):
            continue  # already styled
        start = max(0, len(before) - 500)
        window = before[start:]
        # Never reach back past a quotation already styled, a lead-in, or the
        # previous link: the quotation is the words between that boundary and
        # the citation.
        cut = max(window.rfind("\n"), window.rfind("]]"),
                  window.rfind("~﴾~"), window.rfind("﴾"),
                  window.rfind(":"), window.rfind("："))
        if cut >= 0:
            window = window[cut + 1:]
            start += cut + 1
        abbr = re.search(r"\s*(?:الْآيَةَ|الْآيَةِ|الآية|الْايَة|الايه)\s*$", window)
        if abbr:
            window = window[:abbr.start()]
        if not window.strip():
            continue
        spans = match_verse_spans(window, verse_tokens(surah, verse))
        if not spans:
            fragment = find_verse_fragment(window, verse_tokens(surah, verse))
            if fragment:
                first, last, vfirst, vlast = fragment
            else:
                continue
        else:
            first, last, vfirst, vlast = spans[-1]
        if window[last:].strip(_WORD_TRAIL):
            continue  # the quotation must reach the citation
        quote = window[first:last]
        if len(normalize_arabic(quote)) < 2:
            # A single particle is not a quotation; a real one-word quotation
            # (`شَيْئًا`, `لَحْمًا`) is, and must be formatted when it verifies.
            continue
        canon_words = verse_words(surah, verse)
        canon = " ".join(canon_words[vfirst:vlast + 1]) if canon_words else ""
        edit = (start + first, start + last, "~﴿~" + (canon or quote) + "~﴾~")
        # Two citations must never claim overlapping words (that is what
        # produced nested boundaries and split words).
        if any(edit[0] < e[1] and e[0] < edit[1] for e in edits):
            continue
        edits.append(edit)
    for first, last, marker in reversed(edits):
        content = content[:first] + marker + content[last:]
    return content, len(edits)


def discover_and_mark_quotes(content: str, tafsir: bool = False) -> tuple[str, list[dict]]:
    """Discover unmarked Quran quotes and mark them with *﴿...﴾{quran}* ([[ref]]).

    In `tafsir` mode, a short quotation is looked up first against the verse
    under discussion/nearest to the previous match, matching the continuity
    assumption of a commentary. `add_missing_refs` already uses the same focus
    for marked spans.

    Returns (new_content, found_list)."""
    HADITH_FLAGS = ["صلى الله", "رضي الله", "اخرجه", "رواه", "\ufdfa",
                    "رسول الله", "النبي", "عليه السلام",
                    "قال \ufdfa", "بحيي", "وجوههم"]
    
    LF = '\ufd3f'; LE = '\ufd3e'
    
    # Pre-compute spans of already-marked quotes
    marked_spans = []
    for m in re.finditer(r'\*' + LF + r'.+?' + LE + r'\{\.quran-quote\}', content):
        marked_spans.append((m.start(), m.end()))
    
    def is_inside_marked(pos):
        return any(start <= pos <= end for start, end in marked_spans)
    
    # Citation patterns (use DOTALL for multi-line parenthesized text)
    citation_patterns = [
        r"وقال\s*\((.+?)\)",
        r"قال\s*\((.+?)\)",           # قال without و
        r"قال\s+تعالى\s*\((.+?)\)",
        r"قوله\s*\((.+?)\)",          # قوله without تعالى
        r"قوله\s+تعالى\s*\((.+?)\)",
        r"في\s+قوله\s*\((.+?)\)",
        r"قرأ\s+هذه\s+الآية\s*\((.+?)\)",
        r"فقوله\s+تعالى\s*\((.+?)\)",
        r"كقوله\s+تعالى\s*\((.+?)\)",
    ]
    
    # Collect all matches, deduplicate by position
    all_matches = []
    seen_parens = set()
    
    # Also find - text - patterns (try every gap between consecutive dashes)
    dash_positions = [m.start() for m in re.finditer(r'(?<=\s)-(?=\s)', content)]
    for i in range(len(dash_positions) - 1):
        d1 = dash_positions[i]
        d2 = dash_positions[i + 1]
        text = content[d1+2:d2].strip()
        if len(text) < 10: continue
        text_clean = re.sub(r'\s+', ' ', text)
        text_clean = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', text_clean).strip()
        if is_inside_marked(d1): continue
        if any(w in text_clean for w in HADITH_FLAGS): continue
        # Dashes are punctuation, not quotation — require 3+ words
        if len(text_clean.split()) < 3: continue
        all_matches.append((d1, d2 + 1, text_clean))
    
    # Citation patterns
    for pat in citation_patterns:
        for m in re.finditer(pat, content, re.DOTALL):
            text = m.group(1)
            text_clean = re.sub(r'\s+', ' ', text).strip()
            full_match_text = m.group(0)
            
            # Find the start of the quoted text
            if '(' in full_match_text[:2]:
                paren_start = m.start() + full_match_text.index('(')
            elif '-' in full_match_text[:2]:
                paren_start = m.start() + full_match_text.index('-')
            else:
                paren_start = m.start()
            paren_end = m.end()
            
            if len(text_clean) < 10:
                continue
            if any(w in full_match_text[:20] for w in ["النبي", "رسول", "\ufdfa"]):
                continue
            if any(w in text_clean for w in HADITH_FLAGS):
                continue
            if is_inside_marked(paren_start):
                continue
            if (paren_start, paren_end) in seen_parens:
                continue
            seen_parens.add((paren_start, paren_end))
            all_matches.append((paren_start, paren_end, text_clean))
    
    # Sort by position and process in reverse
    all_matches.sort(key=lambda x: x[0])
    
    found = []
    new_content = content
    offset = 0
    checked = 0
    focus_s = focus_v = None
    
    for paren_start, paren_end, text_clean in all_matches:
        checked += 1
        if checked % 50 == 0:
            print(f"\n    ... {checked} checked, {len(found)} found", flush=True, end="")
        
        adj_start = paren_start + offset
        adj_end = paren_end + offset
        
        # Discovery only ever runs over unreviewed OCR, so its citations may
        # only break a tie as well.
        hint = citation_hint(text_clean, new_content, adj_start, adj_end,
                             tie_break=True)
        hint_range = (hint[1], hint[2]) if hint and hint[2] else None
        if hint:
            results = [(hint[0], hint[1], load_verse(hint[0], hint[1]) or "", 1.0)]
        else:
            results = find_verse_in_text(
                text_clean,
                hint_surah=focus_s if tafsir else None,
                hint_verse=focus_v if tafsir else None,
            )
        if not results and not hint and tafsir and focus_s and len(text_clean.split()) <= 4:
            after = find_verse_after(normalize_arabic(text_clean), focus_s, focus_v, 0)
            if after:
                verse_no = after[0]
                verse_text = load_verse(focus_s, verse_no) or ""
                results = [(focus_s, verse_no, verse_text, 1.0)]
        matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
        if not matches:
            continue
        
        surah, verse_num, _, score = matches[0]
        focus_s, focus_v = surah, verse_num
        print(f"\n    ({surah}:{verse_num}) {text_clean[:60]}", flush=True, end="")
        fragment = get_tashkil_fragment(text_clean, surah, verse_num)
        verse_range = hint_range
        if not fragment:
            # A quotation can span two or more consecutive verses. Keep the
            # source text and cite the range rather than dropping the quote.
            if not verse_range:
                verse_range = find_verse_range(text_clean, surah, verse_num)
            if verse_range:
                fragment = text_clean
            elif len(text_clean.split()) <= 12:
                # The spelling-variant match found the verse even though the
                # source text cannot be mapped back to its tashkīl. Keep the
                # source wording rather than dropping an identified quote.
                fragment = text_clean
            else:
                continue

        english, arabic = get_surah_name(surah)
        surah_ref = f"{surah:03d} {english}#{verse_num}"
        display_ref = f"{arabic} : {verse_num}"
        wikilink = (build_wikilink(surah, verse_range[0], end_verse=verse_range[1])
                    if verse_range else build_wikilink(surah, verse_num))
        
        # Replace only the (text) portion — preserve citation prefix
        replacement = render_quran_quote(
            fragment, "full", surah, verse_num,
            verse_range[1] if verse_range else None)
        new_content = new_content[:adj_start] + replacement + new_content[adj_end:]
        offset += len(replacement) - (adj_end - adj_start)
        
        found.append({
            "surah": surah, "verse": verse_num, "score": score,
            "original_text": text_clean[:80],
            "tashkil_text": fragment[:80],
        })
    
    # Fallback: bare quoted Arabic. Sources use straight quotes, curly quotes,
    # guillemets, and parentheses interchangeably; check all of them for a
    # Qur'ānic match even when no `قال`/`قوله` cue precedes the span.
    bare_patterns = [
        re.compile(r'"([^"\n]{15,})"'),
        re.compile(r'“([^”\n]{15,})”'),
        re.compile(r'«([^»\n]{15,})»'),
        re.compile(r'\(([^()\n]{15,})\)'),
    ]
    
    for pat in bare_patterns:
        for m in reversed(list(pat.finditer(new_content))):
                text = m.group(1).strip()
                text_clean = re.sub(r'\s+', ' ', text)
                pos = m.start()
                if len(text_clean.split()) < 3 or re.search(r'\d', text_clean):
                    continue
                
                if m.group(0).startswith(text[0]):
                    if pos > 0 and re.match(r'[\u0600-\u06FF]', new_content[pos-1]): continue
                
                if any(w in text_clean for w in HADITH_FLAGS): continue
                if is_inside_marked(pos): continue
                
                results = find_verse_in_text(text_clean)
                verse_range = None
                if not results and len(text_clean) > 20:
                    norm = normalize_arabic(text_clean)
                    for frac in [16, 12, 10, 8, 6, 5, 4, 3, 2]:
                        r = find_verse_in_text(norm[:max(5, len(norm)//frac)], skip_filter=True)
                        if r: break
                    else:
                        r = []
                    if r:
                        s, v, _, _ = r[0]
                        vr = find_verse_range(text_clean, s, v)
                        if vr:
                            results = [(s, vr[0], load_verse(s, vr[0]) or '', 1.0)]
                            verse_range = vr
                matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
                if not matches: continue
                
                surah, verse_num, _, score = matches[0]
                fragment = get_tashkil_fragment(text_clean, surah, verse_num)
                verse_range = None
                if not fragment:
                    verse_range = find_verse_range(text_clean, surah, verse_num)
                    if verse_range:
                        fragment = text_clean
                    elif len(text_clean.split()) <= 12:
                        fragment = text_clean
                    else:
                        continue
                wikilink = (build_wikilink(surah, verse_range[0], end_verse=verse_range[1])
                            if verse_range else build_wikilink(surah, verse_num))
                
                replacement = render_quran_quote(
            fragment, "full", surah, verse_num,
            verse_range[1] if verse_range else None)
                new_content = new_content[:m.start()] + replacement + new_content[m.end():]
                
                found.append({
                    "surah": surah, "verse": verse_num, "score": score,
                    "original_text": text_clean[:80],
                    "tashkil_text": fragment[:80],
                })
    return new_content, found


def fix_cross_page_guillemets(content: str) -> tuple[str, int]:
    """Complete a quote opened on one page and closed at the start of the next.

    The fragments go through `render_quran_quote` as `begin` and `end`, so they
    use the same tashkīl, ornate brackets, and link as every other quote.
    """
    LF = '\ufd3f'
    opens = list(re.finditer(r'([«“"])([^»”"\n]{1,80})[ \t]*$', content, re.M))
    edits: list[tuple[int, int, str]] = []
    seen_closes: set[int] = set()
    for m in opens:
        if '{.quran-quote}' in content[m.start():m.end()] or LF in content[m.start():m.end()]:
            continue
        partial = m.group(2).strip()
        if not partial:
            continue
        sep = re.search(r'\n\n---\n\n', content[m.end():])
        if not sep:
            continue
        page_start = m.end() + sep.end()
        raw_page = content[page_start:]
        head = re.match(r'^\s*####\s+p\.[^\n]*\n+', raw_page)
        page_offset = len(head.group(0)) if head else 0
        page = raw_page[page_offset:]
        cont = re.match(r'\s*([^»”"\n]{1,200})([»”"])', page)
        if not cont:
            continue
        continuation = cont.group(1).strip()
        if not continuation:
            continue
        result = (find_verse_in_text(partial + ' ' + continuation)
                  or find_verse_in_text(continuation))
        if not result:
            continue
        surah, verse, _, _ = result[0]
        close_start = page_start + page_offset + cont.start(1)
        close_end = page_start + page_offset + cont.end()
        if close_start in seen_closes:
            continue
        seen_closes.add(close_start)
        begin = render_quran_quote(partial, "begin", surah, verse)
        end_text = render_quran_quote(continuation, "end", surah, verse)
        edits.append((close_start, close_end, end_text))
        edits.append((m.start(1), m.end(), begin))
    for start, end, replacement in sorted(edits, key=lambda edit: edit[0], reverse=True):
        content = content[:start] + replacement + content[end:]
    return content, len(seen_closes)


def link_open_fragments(content: str, tafsir: bool = False) -> tuple[str, int]:
    """In tafsīr mode, link a short open-ended quotation at a line end.

    A quote can be split by a page/footnote boundary, leaving only its opening
    words on the first page (`… وحي «ولا`). If the preceding marked quote names
    the verse, the open fragment is checked as the next words of that verse.
    """
    if not tafsir:
        return content, 0
    lines = content.split("\n")
    added = 0
    for index, line in enumerate(lines):
        if '.quran-quote' in line:
            continue
        # A generated span is not prose: `class="mas-managed">` ends with a
        # quotation mark and would otherwise read as an open quotation.
        if re.search(r'</?[A-Za-z][\w-]*\b', line):
            continue
        match = re.search(r'(?<![=*﴿])([«“"])([^»”"\n]{1,40})\s*$', line)
        if not match:
            continue
        fragment = match.group(2).strip()
        if len(fragment) < 2 or len(fragment.split()) > 4:
            continue
        if re.search(r'[<>]', fragment):
            continue
        before = "\n".join(lines[:index]) + "\n" + line[:match.start()]
        prior = None
        for found in re.finditer(
            r'\*﴿[^﴾]+﴾\{\.quran-quote\}\*\s*'
            r'\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})\s+[^#\]]+#(\d+)\|', before):
            prior = (int(found.group(1)), int(found.group(2)))
        if not prior:
            continue
        after = find_verse_after(normalize_arabic(fragment), prior[0], prior[1], 0)
        if not after:
            continue
        verse_no = after[0]
        replacement = render_quran_quote(fragment, "begin", prior[0], verse_no)
        lines[index] = line[:match.start(1)] + replacement + line[match.end(2):]
        added += 1
    return "\n".join(lines), added


#: `بسم الله الرحمن الرحيم` in the form the normaliser produces, which is what
#: a quotation's text is compared against.
_BASMALA_NORM = normalize_arabic("بسم الله الرحمن الرحيم")


#: The class an older render left on a quotation, removed with the marks.
_QURAN_CLASS = "{.quran-quote}"


def _latin_key(value: str) -> str:
    """A Latin transliteration reduced to bare letters (`Sūrat al-Fātiḥa` →
    `sratalfatiha`), with the diacritics folded rather than deleted — deleting
    them breaks the word (`fātiḥa` would become `ftia`)."""
    decomposed = unicodedata.normalize("NFKD", value.lower())
    return re.sub(r"[^a-z]", "",
                  "".join(char for char in decomposed if not unicodedata.combining(char)))


def _names_fatiha(label: str) -> bool:
    """Does this heading name Sūrat al-Fātiḥa?"""
    if "\u0641\u0627\u062a\u062d" in label:
        return True
    return "fatiha" in _latin_key(label)


def _page_surah(content: str, at: int, headings) -> int:
    """The sūra the page at `at` is in, Arabic heading first, then English.

    A translation names its sūra in English (`### Sūrat al-Kahf`), which the
    Arabic heading scan cannot read; only al-Fātiḥa matters here, so only that
    name is looked for.
    """
    number = 0
    for position, value in headings:
        if position < at:
            number = value
        else:
            break
    if number:
        return number
    for match in re.finditer(r"(?m)^#{1,6}[ \t]*(.+)$", content[:at]):
        if _names_fatiha(match.group(1)):
            return 1
    return 0


def _ornate_pairs(text: str):
    """(start, end) of every ornate pair, each mark paired with the next of the
    other kind — right in either write order."""
    LF, LE = "\ufd3f", "\ufd3e"
    pairs = []
    index = 0
    while index < len(text):
        opening, closing = text.find(LF, index), text.find(LE, index)
        if opening < 0 and closing < 0:
            break
        if closing < 0 or (0 <= opening < closing):
            start, other = opening, LE
        else:
            start, other = closing, LF
        end = text.find(other, start + 1)
        if end < 0:
            break
        pairs.append((start, end))
        index = end + 1
    return pairs


def _heads_a_line(content: str, start: int) -> bool:
    """Does the span begin its own line, with nothing but markup before it?"""
    line_start = content.rfind("\n", 0, start) + 1
    return not content[line_start:start].strip(" \t*~")



#: A citation to 1:1 that the author wrote beside a basmala.
_FATIHA_CITATION = re.compile(r"\[\[Q001#1\b")


def _cited_beside(content: str, start: int, end: int) -> bool:
    """Did the author cite this basmala as al-Fātiḥa 1:1?

    The citation sits beside the span (`﴿…﴾ (الفاتحة : ١)`), or — in a passage
    that writes the phrase twice — elsewhere in the same paragraph, and a book
    that cites it is quoting 1:1 rather than opening a sūra with the formula.
    """
    para_start = content.rfind("\n\n", 0, start) + 2
    para_end = content.find("\n\n", end)
    if para_end < 0:
        para_end = len(content)
    return bool(_FATIHA_CITATION.search(content[para_start:para_end]))


def strip_bare_basmala(content: str) -> tuple[str, int]:
    """Un-mark a basmala that stands alone: it is prose, not a quotation.

    `﴿بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ﴾` on its own is the formula a sūra
    opens with, not a verse — the muṣḥaf numbers it only in al-Fātiḥa, where it
    is 1:1. So the marks and the class go and the words stay as text, except on
    an al-Fātiḥa page, where the span really is a quotation — or where the
    author cites it as one, which is what `﴿بسم الله الرحمن الرحيم﴾ (الفاتحة : ١)`
    does in a book that is not al-Fātiḥa's.

    Only a basmala *inside a sentence* is prose: one that heads its own line is
    the sūra's opening as the muṣḥaf writes it, and the brackets are the
    author's way of saying so.
    """
    changed = 0
    headings = surah_headings(content)
    for start, end in reversed(_ornate_pairs(content)):
        body = content[start + 1:end]
        if normalize_arabic(body) != _BASMALA_NORM:
            continue
        if _page_surah(content, start, headings) == 1:
            continue
        if _cited_beside(content, start, end):
            continue
        if _heads_a_line(content, start):
            # A sūra's basmala is written on its own line before the first
            # verse; an author who sets it in ornate brackets there is quoting
            # the muṣḥaf's own opening, so the marks stay.
            continue
        # `~﴿~` and `~﴾~` are the invisible page-edge form, so the inner tilde
        # sits between the mark and the words rather than outside the pair.
        body = body.strip()
        if body.startswith("~"):
            body = body[1:].lstrip()
        if body.endswith("~"):
            body = body[:-1].rstrip()
        left, right = start, end + 1
        if content.startswith(_QURAN_CLASS, right):
            right += len(_QURAN_CLASS)
        # The marks carry their markup with them: an emphasis star, and the
        # tilde of the invisible page-edge pair (`~﴿~ … ~﴾~`) — left behind, the
        # two tildes would print the words struck through.
        while left > 0 and content[left - 1] in "*~":
            left -= 1
        while right < len(content) and content[right] in "*~":
            right += 1
        content = content[:left] + body + content[right:]
        changed += 1
    return content, changed


def _split_basmala(text_clean: str) -> tuple[str, bool]:
    """(the words after an opening basmala, whether there was one)."""
    if not normalize_arabic(text_clean).startswith(_BASMALA_NORM):
        return text_clean, False
    words = text_clean.split()
    if len(words) <= 4:
        return "", True
    return " ".join(words[4:]), True


def _verse_end_offset(surah: int, verse: int, normalized: str) -> int:
    """How far into the verse a quotation reached (0 when it is not there)."""
    vn = normalize_arabic(load_verse(surah, verse) or "")
    position = vn.find(normalized) if normalized else -1
    if position < 0:
        return 0
    end = position + len(normalized)
    return 0 if end >= len(vn) else end


def realign_continuation_links(content: str) -> tuple[str, int]:
    """Cite a short quotation in the verse it continues.

    A commentary quotes a verse word by word: after
    `﴿بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ٱلْحَمْدُ﴾` (18:1) the next quotation is
    `﴿لِلَّهِ﴾` — the very next word of that verse. When a short quotation's words
    stand in the verse the previous quotation was cited in, at or after the point
    that quotation reached, that verse is the quotation's own, and a link naming
    another verse is corrected to it.

    A cross-reference is untouched: its words are not in the cursor verse at all,
    so nothing matches and nothing moves. Only quotations of three words or fewer
    are considered — a longer span is a passage in its own right, and its own
    citation is the better evidence.
    """
    LF = '\ufd3f'; LE = '\ufd3e'
    # The processing form carries a scaffold between the quotation and its link
    # (`*﴿…﴾{.quran-quote}*`), so the gap is everything that is not text.
    pair = re.compile(
        r'(?P<quote>' + LF + r'[^' + LE + LF + r']*' + LE + r')'
        r'(?P<gap>(?:[ \t*]|\{[^}\n]*\})*)'
        r'(?:\[\[(?:Q[A-Z]{0,2})?(?P<ls>\d{3})#(?P<lv>\d+)'
        r'(?:\|(?P<alias>[^\]]*))?\]\])?')
    changed = 0
    cursor: tuple[int, int, int] | None = None
    pieces: list[str] = []
    last = 0
    for match in pair.finditer(content):
        pieces.append(content[last:match.start()])
        last = match.end()
        quote = match.group("quote")[1:-1]
        surah = int(match.group("ls") or 0)
        verse = int(match.group("lv") or 0)
        alias = match.group("alias") or ""
        body, _had_basmala = _split_basmala(quote)
        search = body if body.strip() else quote
        norm = normalize_arabic(search)
        # A marker (`|:`) is the margin's reference for the *next* quotation.
        is_citation = bool(surah) and not alias.startswith(":")
        link = f"[[Q{surah:03d}#{verse}" + (f"|{alias}]]" if alias else "]]") if is_citation else ""
        if cursor and is_citation and len(search.split()) <= 3 and norm:
            found = find_verse_after(norm, cursor[0], cursor[1], cursor[2])
            if found and _matches_cited_verses(cursor[0], found[0], search):
                new_surah, new_verse = cursor[0], found[0]
                if (surah, verse) != (new_surah, new_verse):
                    changed += 1
                    link = f"[[Q{new_surah:03d}#{new_verse}]]"
                cursor = (new_surah, new_verse, found[1])
                pieces.append(f"{match.group('quote')}{match.group('gap')}{link}")
                continue
        pieces.append(match.group(0))
        if is_citation:
            cursor = (surah, verse, _verse_end_offset(surah, verse, norm))
    pieces.append(content[last:])
    return "".join(pieces), changed


def realign_local_surah_links(content: str) -> tuple[str, int]:
    """Point a quotation and its margin marker at the sūra the page names.

    A page of a tafsīr names the sūra it is discussing in a heading
    (`### سورة الكهف`), and the words of its first quotation may also stand in
    another sūra: the basmala followed by الحمد opens al-Fātiḥa and al-Kahf
    alike. The heading — and the commentary that follows it — say which one is
    being read, so a citation and its marker are corrected to the page's own sūra
    when the words really stand there. Only the *local* sūra is searched, so
    nothing moves on a guess.
    """
    LF = '\ufd3f'; LE = '\ufd3e'
    changed = 0
    headings = surah_headings(content)

    def local_surah(at: int) -> int:
        number = 0
        for position, value in headings:
            if position < at:
                number = value
            else:
                break
        return number

    # The processing form carries a scaffold between the quotation and its link
    # (`*﴿…﴾{.quran-quote}*`), and a marker may be followed by a star: the gap
    # is everything that is not text.
    gap = r'(?:[ \t*]|\{[^}\n]*\})*'
    unit = re.compile(
        r'(?:\[\[(?:Q[A-Z]{0,2})?(?P<ms>\d{3})#(?P<mv>\d+)(?:\|(?P<ma>:[^\]]*))?\]\]' + gap + r')?'
        r'(?P<quote>' + LF + r'[^' + LE + LF + r']*' + LE + r')'
        r'(?P<gap>' + gap + r')'
        r'(?:\[\[(?:Q[A-Z]{0,2})?(?P<ls>\d{3})#(?P<lv>\d+)(?:\|[^\]]*)?\]\])?')

    following = re.compile(LF + r'[^' + LE + LF + r']*' + LE)

    def following_surah(at: int) -> int:
        """The sūra of the next quotation, when that quotation can name one.

        A page without a heading still shows where it is: the next quotation is
        `﴿ٱلَّذِىٓ أَنزَلَ عَلَىٰ عَبْدِهِ ٱلْكِتَٰبَ﴾`, which belongs to al-Kahf and
        nothing else. Only a quotation distinctive enough to name a verse is
        used, so a short ambiguous fragment cannot pull the cursor.
        """
        found = following.search(content, at)
        if not found:
            return 0
        text = found.group(0)[1:-1]
        if len(text.split()) < 3 and len(normalize_arabic(text)) < 12:
            return 0
        hits = find_verse_in_text(text)
        return hits[0][0] if hits else 0

    def repl(match: re.Match) -> str:
        nonlocal changed
        quote = match.group("quote")[1:-1]
        marker_surah = int(match.group("ms") or 0)
        link_surah = int(match.group("ls") or 0)
        named = link_surah or marker_surah
        # Only a basmala-led span is realigned, so only it needs the page's sūra:
        # the heading when there is one, else the quotation that follows.
        body, had_basmala = _split_basmala(quote)
        if not had_basmala:
            return match.group(0)
        local = local_surah(match.start()) or following_surah(match.end())
        if not local or local == named:
            return match.group(0)
        # The basmala is not a verse outside al-Fātiḥa, so it is dropped and the
        # words after it are matched inside the sūra the page reads.
        if not body.strip():
            return match.group(0)
        search = body
        # The sūra is searched directly, because the words after the basmala may
        # be a single word (`الحمد`), and a whole-muṣḥaf search refuses anything
        # that short.
        try:
            candidates = _search_sqlite(normalize_arabic(search), surah=local)
        except Exception:
            return match.group(0)
        if not candidates:
            return match.group(0)
        verse = sorted(candidates, key=lambda row: row[1])[0][1]
        if not _matches_cited_verses(local, verse, search):
            return match.group(0)
        end = verse
        if local == 1 and had_basmala:
            # In al-Fātiḥa the basmala *is* 1:1, so a span that opens with it and
            # runs on is the range 1:1–(the verse it reaches).
            end = max(verse, 1)
            verse = 1
        span = find_verse_range(search, local, verse)
        if span:
            end = max(span)
        marker = ""
        if marker_surah:
            marker = f"[[Q{local:03d}#{verse}|:{'' if end == verse else end}]]"
        link = ""
        if link_surah:
            link = f"[[Q{local:03d}#{verse}" + (f"|{end}]]" if end > verse else "]]")
        changed += 1
        return f"{marker}{match.group('quote')}{match.group('gap')}{link}"

    return unit.sub(repl, content), changed


def add_missing_refs(content: str, hint_surah: int = 0,
                     hint_verse: int = 0,
                     trust_citations: bool = True) -> tuple[str, int]:
    """Add wikilinks to *LF...LE{quran-quote}* quotes that lack them.

    `hint_surah`/`hint_verse` are the passage the body comments on (one block
    of a corpus tafsīr): the sūra is the file's own, the verse is where its
    commentary starts. They anchor the focus to that sūra, so a cross-reference
    — Sūrat Maryam opens with a quotation of 5:82 — is cited but never becomes
    the verse under discussion. The verse itself is not bounded: no two tafsīrs
    group āyāt the same way, and a work whose file name names one verse may
    discuss another. Without them the focus drifts
    with the recency weighting, which is what a text with no stated passage
    (a scanned page) has to fall back on.

    `trust_citations` is False for a transcription: its citations are the
    OCR model's, so `citation_hint` only breaks a tie (`tie_break`).

    Returns (new_content, added_count)."""
    LF = '\ufd3f'; LE = '\ufd3e'
    added = 0
    new_content = content
    
    # Match closed quotes: *LF text LE{quran-quote}*
    pattern = re.compile(
        r'(\*' + LF + r'[^' + LE + LF + r']*' + LE + r'\{\.quran-quote\}\*)'
    )
    
    # Process spans in document order, carrying a recency-weighted "focus" on
    # the verse(s) under discussion. A tafsīr returns to the same verse many
    # times with stray mentions elsewhere, so the focus is the most-mentioned
    # recent verse, not merely the last one.
    parts = []
    pos = 0
    surah_w = {}
    last_v = {}
    verse_off = {}
    FOCUS_DECAY = 0.6

    def _bump(s, v, off=0):
        for k in list(surah_w):
            surah_w[k] *= FOCUS_DECAY
            if surah_w[k] < 0.05:
                del surah_w[k]
        surah_w[s] = surah_w.get(s, 0.0) + 1.0
        last_v[s] = v
        verse_off[(s, v)] = off

    def _focus():
        if not surah_w:
            return (None, None)
        s = max(surah_w, key=surah_w.get)
        return (s, last_v.get(s))

    # An anchored focus: the passage's own sūra and verse range, and the verse
    # inside it that the discussion has reached.
    anchored = bool(hint_surah and hint_verse)
    main_v = hint_verse
    main_off = 0

    # A heading is the only structure a page carries when the text is read page
    # by page: where a sūra is named, a quotation that cannot be placed on its
    # own may be placed inside it. Without this the marking pass would mark such
    # a span and this pass would fail to cite it, leaving the quotation to be
    # stripped again as unverified.
    headings = surah_headings(content)

    def local_surah(at: int) -> int:
        number = 0
        for position, value in headings:
            if position < at:
                number = value
            else:
                break
        return number

    def distinctive(text: str) -> bool:
        return len(text.split()) >= 3 or len(normalize_arabic(text)) >= 12

    def commit(s: int, v: int, off: int = 0) -> None:
        nonlocal main_v, main_off
        if not anchored:
            _bump(s, v, off)
            return
        if s == hint_surah and v >= main_v:
            main_v, main_off = v, off

    if anchored:
        pass  # main_v is the seed; nothing else to set up
    elif hint_surah and hint_verse:
        _bump(hint_surah, hint_verse)

    def focus_pair():
        return (hint_surah, main_v) if anchored else _focus()

    def _end_offset(s, v, norm):
        """How far into the verse a quotation reached.

        A quotation that runs to the *end* of its verse returns 0, so the next
        short fragment is looked for from the beginning of that same verse. In a
        tafsīr a verse quoted whole is followed by commentary on it — `﴿مَن كَانَ
        يَظُنُّ … مَا يَغِيظُ﴾` (all of 22:15), then `﴿مَن﴾`, which is the opening
        word of 15 and not the first word of 16. Advancing past the verse in
        that case puts the fragment in the wrong āya.
        """
        vn = normalize_arabic(load_verse(s, v) or "")
        i = vn.find(norm)
        if i < 0:
            return 0
        end = i + len(norm)
        return 0 if end >= len(vn) else end

    for m in pattern.finditer(new_content):
        parts.append(new_content[pos:m.start()])
        pos = m.end()
        full_match = m.group(1)
        end = m.end()
        keep = new_content[m.start():end]
        after = new_content[end:end+30].lstrip()
        if re.search(r'\[\[Q?\d{3}', after[:16]):
            lm = re.match(r'\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#]*#(\d+)', after)
            if lm:
                ls, lv = int(lm.group(1)), int(lm.group(2))
                lt = full_match[full_match.index(LF)+1:full_match.index(LE)]
                commit(ls, lv, _end_offset(ls, lv, normalize_arabic(lt)))
            parts.append(keep); continue

        text = full_match[full_match.index(LF)+1:full_match.index(LE)]
        text_clean = re.sub(r'\s*\.\s*', ' ', text).strip()
        text_clean = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', text_clean).strip()
        hint = citation_hint(text_clean, new_content, m.start(), m.end(),
                             tie_break=not trust_citations)
        if hint:
            hint_s, hint_v, hint_end = hint
            wikilink = build_wikilink(hint_s, hint_v, end_verse=hint_end)
            parts.append(keep + wikilink)
            commit(hint_s, hint_v, _end_offset(hint_s, hint_v, normalize_arabic(text_clean)))
            added += 1
            continue
        if (normalize_arabic(text_clean) in BLACKLISTED_PHRASES
                and _page_surah(new_content, m.start(), headings) != 1):
            # A formulaic phrase is not a quotation — except the basmala on an
            # al-Fātiḥa page, where the muṣḥaf numbers it as 1:1.
            parts.append(keep); continue
        if trust_citations and re.match(r'\s*[\[\(][^\]\)]*\d', after):
            # The source's own citation stands where ours would go. In a
            # transcription there is no source citation — only the model's — and
            # a wrong one must not stop the quotation from being cited: it is
            # dropped below, and our link is the citation.
            parts.append(keep); continue

        norm = normalize_arabic(text_clean)
        short_span = len(text_clean.split()) <= 2
        fs, fv = focus_pair()
        local = local_surah(m.start())
        allowed = {value for value in (fs, local) if value}

        def aligned(surah_no: int, verse_no: int) -> bool:
            """Is the span word-aligned with this verse?

            The same gate the marking pass uses. Without it a search can end in
            the middle of a word: `وهو كرا` normalises to `وهوكر`, which is a
            prefix of 2:216's `وهو كره` — and `LIKE '%وهوكر%'` happily matches,
            as if ا had been read as ه. It is not a spelling variant; the span
            simply stops inside the word, so it is not this verse's words.

            A one- or two-word span is also confined to the sūra under
            discussion: it carries too little evidence to be looked up across
            the muṣḥaf, and a stray particle would otherwise be cited wherever
            its two letters happen to occur.
            """
            if short_span and allowed and surah_no not in allowed:
                return False
            return _matches_cited_verses(surah_no, verse_no, text_clean)

        # (a) The next quote is almost always the same words or the words right
        # after the verse currently under discussion — the dominant surah's
        # most recent verse — even if a stray reference intervened.
        if fs is not None:
            r = find_verse_after(norm, fs, fv,
                                 main_off if anchored else verse_off.get((fs, fv), 0))
            if r and aligned(fs, r[0]):
                v, off = r
                parts.append(keep + build_wikilink(fs, v))
                commit(fs, v, off)
                added += 1
                continue

        results = find_verse_in_text(text_clean, hint_surah=fs, hint_verse=fv)
        if local and local != fs and distinctive(text_clean):
            # The page names the sūra it is discussing in a heading, and the
            # words occur in it: the basmala followed by الحمد opens al-Kahf
            # just as it opens al-Fātiḥa, and the focus carried over from the
            # sūra before would otherwise cite al-Fātiḥa in the middle of a
            # commentary on al-Kahf. What follows the quotation — the rest of
            # the page — is the continuation of that sūra, which is why the
            # heading is the better reading of an ambiguous span.
            in_local = find_verse_in_text(text_clean, hint_surah=local)
            if in_local:
                results = in_local
        if not results:
            # No focus yet — nothing has been placed — so the page's heading is
            # what is left to go on. A sūra is a weak constraint, so only a span
            # distinctive enough to name one verse may use it.
            if local and distinctive(text_clean):
                results = find_verse_in_text(text_clean, hint_surah=local)
        verse_range = None
        if results:
            # A quotation may run past the verse it starts in. `find_verse_range`
            # walks the consecutive verses until the whole quotation is covered,
            # so a two-verse quotation is cited once, as a range (`[[Q022#3|4]]`),
            # rather than twice — which is what it used to do before the range
            # detection was left only on the fallback path.
            span = find_verse_range(text_clean, results[0][0], results[0][1])
            if span and span[1] > span[0]:
                verse_range = span
                results = [(span[0], span[0], load_verse(span[0], span[0]) or "", 1.0)]
        if not results and len(text_clean) > 20:
            norm = normalize_arabic(text_clean)
            # Try progressively shorter prefixes, longest (most specific) first,
            # and accept the first whose verse range actually contains the quote.
            for frac in [2, 3, 4, 5, 6, 8, 10, 12, 16]:
                r = find_verse_in_text(norm[:max(5, len(norm)//frac)], skip_filter=True,
                                       hint_surah=fs, hint_verse=fv)
                if not r:
                    continue
                s, v, _, _ = r[0]
                vr = find_verse_range(text_clean, s, v)
                if vr:
                    results = [(s, vr[0], load_verse(s, vr[0]) or '', 1.0)]
                    verse_range = vr
                    break

        # If no match for combined text, try each segment (split on periods or *)
        if not results and ('.' in text_clean or ' * ' in text):
            segments = [s.strip() for s in re.split(r'\s*[\.\*]\s*', text_clean) if len(s.strip()) > 10]
            segment_matches = []
            for seg in segments:
                r = find_verse_in_text(seg, hint_surah=fs, hint_verse=fv)
                if r:
                    s, v, t, sc = r[0]
                    if sc > 0.7:
                        frag = get_tashkil_fragment(seg, s, v)
                        wl = build_wikilink(s, v)
                        segment_matches.append((seg, frag, wl, s, v))
            if segment_matches:
                verses = [(sm[3], sm[4]) for sm in segment_matches]
                if (len(verses) >= 2
                        and all(vs[0] == verses[0][0] for vs in verses)
                        and all(verses[i][1] == verses[0][1] + i for i in range(len(verses)))):
                    # Same surah, consecutive — use a range link
                    surah = verses[0][0]
                    v_start, v_end = verses[0][1], verses[-1][1]
                    range_wl = build_wikilink(surah, v_start, end_verse=v_end)
                    body = ' * '.join(
                        render_quran_quote(sm[1] or sm[0], "full", sm[3], sm[4])
                        for sm in segment_matches)
                    parts.append(body)
                    added += len(segment_matches)
                else:
                    body = ' * '.join(
                        render_quran_quote(sm[1] or sm[0], "full", sm[3], sm[4])
                        for sm in segment_matches)
                    parts.append(body)
                    added += len(segment_matches)
                commit(segment_matches[-1][3], segment_matches[-1][4],
                       _end_offset(segment_matches[-1][3], segment_matches[-1][4], norm))
                continue

        matches = [(s, v, t, sc) for s, v, t, sc in results
                   if sc > 0.7 and aligned(s, v)]
        if not matches:
            parts.append(keep); continue
        surah, verse_num, _, _ = matches[0]
        wikilink = (build_wikilink(surah, verse_num, end_verse=verse_range[1])
                    if verse_range else build_wikilink(surah, verse_num))
        parts.append(keep + wikilink)
        commit(surah, verse_num, _end_offset(surah, verse_num, norm))
        added += 1
    parts.append(new_content[pos:])
    new_content = ''.join(parts)
    
    # Also handle right-bracket-only quotes: *text LE* (page continuation)
    # These are quotes that started on the previous page without *LF
    rb_pattern = re.compile(r'(?<!\ufd3f)\*([^*\n{}]{15,})\ufd3e\{\.quran-quote\}\*')
    for m in reversed(list(rb_pattern.finditer(new_content))):
        text = m.group(1).strip()
        end = m.end()
        after = new_content[end:end+30].lstrip()
        if re.search(r'\[\[Q?\d{3}', after[:16]):
            continue
        # Skip if this is actually a closed quote (*LF...LE*), not a continuation
        if '\ufd3f' in m.group(0):
            continue
        
        results = find_verse_in_text(text)
        if not results:
            segments = [s.strip() for s in re.split(r'\s*\.\s*', text) if len(s.strip()) > 10]
            for seg in segments:
                r = find_verse_in_text(seg)
                if r: results = r; break
        
        matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
        if not matches:
            continue
        
        surah, verse_num, _, _ = matches[0]
        stem, arabic = get_surah_name(surah)
        wikilink = build_wikilink(surah, verse_num)
        
        # A closing-only fragment is the end of a quote.
        replacement = render_quran_quote(text, "end", surah, verse_num)
        new_content = new_content[:m.start()] + replacement + new_content[end:]
        added += 1
    
    # Handle left-bracket-only: *LF text* (no right bracket, page end)
    lb_pattern = re.compile(r'\*\ufd3f([^*\ufd3e\n{}]{15,})\*(?!\{\.quran-quote\})')
    for m in reversed(list(lb_pattern.finditer(new_content))):
        text = m.group(1).strip()
        end = m.end()
        after = new_content[end:end+30].lstrip()
        if re.search(r'\[\[Q?\d{3}', after[:16]):
            continue
        
        results = find_verse_in_text(text)
        if not results:
            segments = [s.strip() for s in re.split(r'\s*\.\s*', text) if len(s.strip()) > 10]
            for seg in segments:
                r = find_verse_in_text(seg)
                if r: results = r; break
        
        matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
        if not matches:
            continue
        
        surah, verse_num, _, _ = matches[0]
        stem, arabic = get_surah_name(surah)
        wikilink = build_wikilink(surah, verse_num)
        
        # An opening-only fragment is the beginning of a quote.
        replacement = render_quran_quote(text, "begin", surah, verse_num)
        new_content = new_content[:m.start()] + replacement + new_content[end:]
        added += 1
    
    return new_content, added


# ── Citing the quotations a text already marks ──────────────────────────────
#
# A work marks its Qur'ān quotations in whatever way its author or scribe used:
# the vault's ornate parentheses, guillemets, curly quotes, parentheses, or
# italics. The shape is an *input* to one shared citation pass, never a reason
# for a genre to run its own. A transcribed tafsīr, a repository tafsīr and a
# book all reach `link_quote_citations` with the delimiter set their own text
# uses, and everything downstream is identical.

#: The reading the canonical notes carry. Ḥafṣ is the vault's riwāya; a work in
#: another reading is not matched against it, because the words genuinely differ.
CANONICAL_RIWAYA = "hafs"

#: The vault's own quotation form while the passes run.
ORNATE_QUOTE = re.compile(r"\*﴿(.+?)﴾\{\.quran-quote\}\*(?!\s*\(\[\[)")
#: A bare ornate span: the marks without the processing class. It is how a
#: repository or a transcription writes a quotation before the passes run, and
#: it is a candidate exactly like the classed form — that is the shape that had
#: thousands of spans and no citations.
BARE_ORNATE = re.compile(r"(?<!~)﴿([^﴿﴾\n]{1,400})﴾(?!~|\{\.quran-quote\})(?!\s*\(?\[\[)")
#: Ornate boundaries that must not print.
INVISIBLE_QUOTE = re.compile(r"~﴿~(.+?)~﴾~(?!\s*\(\[\[)")

#: Every other way a work can mark a quotation. Enable one only when the work
#: actually uses it for Qur'ān (`detect_quote_delims`): parentheses around a
#: manuscript aside are not a quotation, and running the matcher over them only
#: invites a false positive.
QUOTE_DELIMS = {
    "«»": re.compile(r"«([^«»]{1,400}?)»"),
    "“”": re.compile(r"“([^“”]{1,400}?)”"),
    "()": re.compile(r"\(([^()\[\]]{1,400}?)\)"),
    # Italics, on one line, without the ornate marks inside: `*whole verse*` is
    # how a transcription often renders a quotation, and a closed span is
    # emphasis — poetry is masked before this pass, so a hemistich pair never
    # reaches it.
    #
    # The star has to *touch* what it emphasises. `* this *` is not italics: a
    # star with a space after it is a footnote/debris mark or a list bullet, not
    # an opening delimiter. The same is true at the boundary — a `*` sitting
    # against an ornate mark belongs to that quotation (`*﴿…﴾*`), so the star
    # closing one span and the star opening the next do not make a pair. Without
    # both rules, plain text between two quotations — `*﴿وكثير﴾* من الناس
    # *﴿حق﴾*` — was read as an italic span, and in a commentary that text is a
    # gloss, not a quotation: it was promoted to ornate parens, and cited.
    "*": re.compile(r"(?<![*\w\ufd3e])\*(?=\S)([^*\ufd3f\ufd3e\n{]{2,400}?)"
                    r"(?<=\S)\*(?![\w*\ufd3f])"),
}


def detect_quote_delims(text: str, minimum: int = 3) -> tuple[str, ...]:
    """Which non-ornate delimiters this text actually uses for Qur'ān quotes.

    A work follows one standard throughout, so a handful of resolved spans is
    enough to enable a delimiter for the whole work; a delimiter whose spans
    never resolve (guillemets around ḥadīth, parens around prose) is left off, so
    the matcher is not run over hundreds of non-Qur'ānic spans.
    """
    if CANONICAL_RIWAYA != "hafs":
        return ()
    enabled: list[str] = []
    for name, rx in QUOTE_DELIMS.items():
        spans = [s.strip() for s in rx.findall(text) if len(s.split()) >= 3]
        hits = 0
        for s in spans[:40]:
            try:
                if find_verse_in_text(s):
                    hits += 1
            except Exception:  # noqa: BLE001
                pass
            if hits >= minimum:
                enabled.append(name)
                break
    return tuple(enabled)


def link_quote_citations(
    text: str, *, surah: int = 0, ayah: int = 0, delims: tuple[str, ...] = (),
    linear: bool = False, cite_current: bool = True, ornate: bool = True,
) -> str:
    """Cite every marked Qur'ān quote that resolves to a verse.

    Quotes come from the vault-marked `﴿…﴾` spans and, when the work uses them
    (`delims`), from guillemets / curly quotes / parentheses / italics. Each is
    matched against the canonical notes with the shared matcher.

    `linear` is the tafsīr assumption: the quotes in a commentary run in the
    order of the verse being discussed, so each lookup is hinted by the verse
    under discussion and by the previous match. In a general work (a dictionary,
    a book, ḥadīth) quotes are not necessarily in Qur'ānic order, so callers pass
    `linear=False` and every quote is looked up independently.

    `ornate=False` adds no citation of its own: a quotation found in another
    delimiter is rewritten into the vault's `*﴿…﴾{.quran-quote}*` form and the
    shared citation passes then cite it. That is the tafsīr order, where a
    citation is placed once per verse run and a marginal marker follows it.
    """
    if not text or CANONICAL_RIWAYA != "hafs":
        return text
    state = {"s": surah, "v": ayah, "end": ayah, "pos": 0 if (surah and ayah) else None,
             "matched": None}

    def set_cursor(quote_text: str, surah_no: int, verse_no: int,
                   end_verse: int | None = None) -> None:
        """Record where this quotation leaves the commentary in the verse, and
        which of the verse's words it was.

        `matched` is the verse's *own* text for the stretch that was quoted, so
        a fragment identified by position can be written with the muṣḥaf's
        tashkīl instead of the source's bare letters — without having to search
        the verse again and risk returning `مِن` for `مَن`.
        """
        try:
            verse_text = load_verse(surah_no, verse_no) or ""
        except Exception:  # noqa: BLE001
            verse_text = ""
        state["pos"] = _word_index_after(verse_text, quote_text)
        needle = normalize_arabic(quote_text)
        if not needle:
            state["matched"] = None
            return
        last = end_verse if end_verse and end_verse > verse_no else verse_no
        state["matched"] = (canonical_quote_body(surah_no, verse_no, last, quote_text)
                            if last > verse_no
                            else (lambda span: verse_text[span[0]:span[1]] if span else None)(
                                _word_span_for(verse_text, needle)))

    def focus(inner: str) -> None:
        """Make `inner` the passage under discussion, without citing it.

        A tafsīr's verse is named by its quotation, and in this mode the ornate
        spans are those quotations — the citation is placed later, by
        `add_missing_refs`. They still have to move the linear cursor, because
        the short fragments that follow are only recognisable inside the verse
        they gloss. The passage may be a range, so the end is kept as well: a
        commentary glosses the second verse of `22:16–17` as readily as the
        first.
        """
        hit = lookup(inner)
        if not hit:
            return
        span = find_verse_range(inner, hit[0], hit[1])
        end = span[1] if span and span[1] > hit[1] else hit[1]
        state["s"], state["v"], state["end"] = hit[0], hit[1], end
        set_cursor(inner, hit[0], hit[1], end)

    def lookup(quote: str) -> tuple[int, int] | None:
        """The verse a quote resolves to, or None. Moves the linear focus."""
        # A quote may span verses (`﴿A * B﴾`, the editor's separator). Resolve
        # the first segment that resolves; a multi-verse span never matches on
        # its own.
        state["matched"] = None
        segments = [s.strip() for s in quote.split("*") if s.strip()]
        for seg in segments:
            if len(seg.split()) <= 2:
                # A one- or two-word span is a verse quote only when it is part
                # of the verse under discussion (`كهيعص`, `الم`, a divine name)
                # or is distinctive enough to locate itself.
                needle = normalize_arabic(seg)
                if not needle or not linear:
                    continue
                if len(needle) < 3:
                    # A word of one or two letters (`من`, `ثم`, `لا`) is far too
                    # common to locate by its letters, and a whole-muṣḥaf search
                    # for it would be meaningless. It is still a quotation when
                    # the commentary is *at* it: the word the glossing has
                    # reached, or one soon after it — a commentary skips the
                    # words it does not discuss, so `الحمد` is followed by
                    # `لله` and not by `رب`. The position is the evidence, not
                    # the spelling: `(من) بدل من كذا` a page later is not a
                    # quote. Never backwards, and never a whole-Qur'ān search.
                    if not state["v"]:
                        continue
                    try:
                        verse_text = load_verse(state["s"], state["v"]) or ""
                    except Exception:  # noqa: BLE001
                        verse_text = ""
                    start = state["pos"]
                    if start is not None:
                        words = _verse_words(verse_text)
                        for index in range(start, min(start + _SHORT_GLOSS_WINDOW,
                                                      len(words))):
                            raw_start, raw_end, norm = words[index]
                            if norm != needle:
                                continue
                            # The verse's own spelling of that word, for the mark.
                            state["matched"] = verse_text[raw_start:raw_end]
                            state["pos"] = index + 1
                            return (state["s"], state["v"])
                    continue
                if state["v"]:
                    # Any verse of the passage under discussion, not just its
                    # first: a gloss on the second verse of a quoted range is the
                    # common case, and the range is what the commentary is
                    # discussing.
                    last = state["end"] if state["end"] >= state["v"] else state["v"]
                    for verse_no in range(state["v"], last + 1):
                        try:
                            verse_text = load_verse(state["s"], verse_no) or ""
                        except Exception:  # noqa: BLE001
                            verse_text = ""
                        if needle in normalize_arabic(verse_text):
                            # Report the verse rather than leaving the loop: a
                            # `break` here used to fall through to `return None`,
                            # so a fragment that demonstrably was the verse's
                            # words was discarded and never discovered.
                            cursor = (state["pos"] or 0) if verse_no == state["v"] else 0
                            state["v"] = verse_no
                            span = _word_span_for(verse_text, needle, cursor)
                            state["matched"] = (verse_text[span[0]:span[1]]
                                                if span else None)
                            state["pos"] = _word_index_after(verse_text, needle, cursor)
                            return (state["s"], verse_no)
                    continue
                # Nothing is located yet, and this is the first quotation on the
                # page — it has to be able to establish the passage itself, or
                # every fragment after it stays blind. Only a *two-word* span may
                # do this, and only when the common-phrase filter leaves one
                # verse: `فَإِنْ أَصَابَهُۥ` names 22:11 by itself, while
                # `الحمد لله` occurs in five verses and must not become a
                # quotation every time it is emphasised. A single word never
                # anchors: `وكذلك` occurs everywhere.
                if len(seg.split()) < 2 or len(needle) < 5:
                    continue
                try:
                    found = find_verse_in_text(seg)
                except Exception:  # noqa: BLE001
                    found = None
                aligned = [(s_no, v_no) for s_no, v_no, _t, _sc in (found or [])
                           if _matches_cited_verses(s_no, v_no, seg)]
                if len(aligned) != 1:
                    continue
                surah_no, verse_no = aligned[0]
                try:
                    verse_text = load_verse(surah_no, verse_no) or ""
                except Exception:  # noqa: BLE001
                    verse_text = ""
                state["s"], state["v"], state["end"] = surah_no, verse_no, verse_no
                span = _word_span_for(verse_text, needle)
                state["matched"] = (verse_text[span[0]:span[1]]
                                    if span else None)
                state["pos"] = _word_index_after(verse_text, needle)
                return (surah_no, verse_no)
                continue
            # A sūra with no verse is a far weaker hint than a verse: it narrows
            # the muṣḥaf to one sūra, so only a span long enough to be
            # distinctive may use it. A short phrase inside a sūra would
            # otherwise resolve to the first verse that happens to contain it.
            hint_surah = state["s"] if linear else None
            if hint_surah and not state["v"]:
                distinctive = (len(seg.split()) >= 3
                               or len(normalize_arabic(seg)) >= 12)
                if not distinctive:
                    hint_surah = None
            try:
                found = find_verse_in_text(
                    seg,
                    hint_surah=hint_surah,
                    hint_verse=state["v"] if linear else None,
                )
            except Exception:  # noqa: BLE001
                found = None
            if not found and len(seg.split()) > 4:
                # A quotation that runs past the verse it starts in cannot match
                # a single verse, and a transcription's OCR may slip late in it.
                # Its opening is enough to locate it; `find_verse_range` then
                # extends the citation to the verses it actually covers.
                #
                # Three probes, not one per word: a failing span is the common
                # case on a page of short fragments, and each probe is a search
                # of the whole muṣḥaf. Trying every prefix length turned the
                # whole-volume pass into an hour of SQLite queries.
                words = seg.split()
                for size in (len(words) - 1, max(4, len(words) // 2), 4):
                    if size >= len(words) or size < 4:
                        continue
                    try:
                        found = find_verse_in_text(
                            " ".join(words[:size]), skip_filter=True,
                            hint_surah=state["s"] if linear else None,
                            hint_verse=state["v"] if linear else None,
                        )
                    except Exception:  # noqa: BLE001
                        found = None
                    if found:
                        break
            if found:
                s, v = found[0][0], found[0][1]
                if linear:
                    state["s"], state["v"], state["end"] = s, v, v
                    set_cursor(seg, s, v)
                return (s, v)
        return None

    def cite(quote: str) -> str:
        """The citation for a quote, or '' when it needs none."""
        hit = lookup(quote)
        if not hit:
            return ""
        s, v = hit
        if linear:
            state["s"], state["v"] = s, v
        if not cite_current and surah and ayah and (s, v) == (surah, ayah):
            return ""
        # One quotation that covers two verses is one range, not two links.
        span = find_verse_range(quote, s, v)
        end = span[1] if span and span[1] > v else None
        return " " + build_wikilink(s, v, end_verse=end)

    text = INVISIBLE_QUOTE.sub(lambda m: m.group(0) + cite(m.group(1).strip()), text)

    def mark(m: re.Match) -> str:
        """Give a bare ornate span the processing form the passes read."""
        return f"*\ufd3f{m.group(1)}\ufd3e{{.quran-quote}}*"

    if ornate:
        text = ORNATE_QUOTE.sub(lambda m: m.group(0) + cite(m.group(1).strip()), text)
        # A bare span is marked and cited in one step: the citation belongs to
        # the quotation, and there is no later pass to add it here.
        text = BARE_ORNATE.sub(lambda m: mark(m) + cite(m.group(1).strip()), text)
        for name in delims:
            text = QUOTE_DELIMS[name].sub(
                lambda m: m.group(0) + cite(m.group(1).strip()), text)
        return text

    # A quotation found in another delimiter is *marked* as Qur'ān whether or
    # not it needs a citation — the marking and the citation are different
    # questions, and a quote of the verse under discussion still has to reach
    # the shared passes in the vault's form.
    def wrap(inner: str) -> str | None:
        """The marked form of a quotation, or None when it is not the muṣḥaf's."""
        hit = lookup(inner)
        if not hit:
            return None
        # Marking is a claim that these words are the muṣḥaf's. A parenthesis
        # full of prose can contain a substring that lands inside a verse word,
        # and `أي من الخوف` is a gloss, not 2:155. The words must be the
        # verse's words, in order, as whole words — and a quotation may run on
        # into the next verse, so the check spans up to three of them.
        if not _matches_cited_verses(hit[0], hit[1], inner):
            return None
        # The verse's own text for the stretch that was matched, when the pass
        # knows exactly where it was. A source without tashkīl is common, and
        # the tashkīl belongs to the word that was matched — searching the verse
        # again for `من` would be as likely to return `مِن` as the `مَن` the
        # commentary glossed. `lookup` records the exact span, so it is used.
        body = state.get("matched")
        if not body:
            span = find_verse_range(inner, hit[0], hit[1])
            end = span[1] if span and span[1] > hit[1] else hit[1]
            body = canonical_quote_body(hit[0], hit[1], end, inner)
        body = strip_verse_emblems(_display(body or inner))
        return f"*\ufd3f{body}\ufd3e{{.quran-quote}}*"

    # One pass in document order, over every shape that can quote a verse.
    #
    # Scanning each delimiter in turn (ornate, then italics, then parentheses)
    # is what kept the tafsīr's discovery blind: the cursor is a *position* in
    # the text, and a pattern-by-pattern sweep visits page 300 before page 3.
    # Here the candidates are sorted by position, so an ornate quotation moves
    # the focus for exactly the fragments that follow it, and a run of
    # quotations from one verse advances through the verses as it is read.
    candidates: list[tuple[int, int, str, str]] = []
    for match in ORNATE_QUOTE.finditer(text):
        candidates.append((match.start(), match.end(), "focus", match.group(1)))
    for match in BARE_ORNATE.finditer(text):
        candidates.append((match.start(), match.end(), "bare", match.group(1)))
    for name in delims:
        for match in QUOTE_DELIMS[name].finditer(text):
            candidates.append((match.start(), match.end(), "quote", match.group(1)))
    # At one position the ornate span wins: it is the quotation whose form is
    # already known, and the fragment around it is the gloss of it.
    candidates.sort(key=lambda c: (c[0], 0 if c[2] != "quote" else 1, -c[1]))

    edits: list[tuple[int, int, str]] = []
    edited: list[tuple[int, int]] = []

    def overlaps(start: int, end: int) -> bool:
        return any(start < e and end > s for s, e in edited)

    # The first candidate that names a verse, and whether we started with one.
    # A document handed a focal verse needs no recovery; one being read page by
    # page does.
    seeded = bool(ayah)
    anchor: tuple[int, int, int, int] | None = None
    # A heading that names a sūra is the one piece of structure a page can be
    # trusted about when nothing has been located. It is registered as the pass
    # reaches it: the last one named stands, whatever its level.
    headings = surah_headings(text) if linear else []
    heading_at = 0

    #: Nothing but space — or a citation left by an earlier pass — between two
    #: quotation spans. Anything else is prose, and prose is what separates one
    #: quotation from the next.
    _GAP = re.compile(r"\s*(?:\(?\[\[[^\]\n]*\]\]\)?\s*)?")

    def joinable(gap: str) -> bool:
        return _GAP.fullmatch(gap) is not None

    index = 0
    while index < len(candidates):
        start, end, kind, inner = candidates[index]
        inner = inner.strip()
        if not inner:
            index += 1
            continue
        while heading_at < len(headings) and headings[heading_at][0] < start:
            number = headings[heading_at][1]
            # A new sūra makes the verse we were on irrelevant, and gives the
            # search something better than nothing: this sūra, from its first
            # verse. No verse, so no short fragments until one resolves.
            state["s"], state["v"], state["end"] = number, 0, 0
            state["pos"] = None
            heading_at += 1
        had_verse = state["v"]

        # ── A run of adjacent spans is one quotation ────────────────────────
        # A typesetter sets a verse word by word in italics, and a model marks
        # it word by word inside the ornate parens. The muṣḥaf keeps its words
        # together, so the run is joined — but only when the joined words are
        # the verse's, contiguous and in order. An author who omits a word on
        # purpose keeps two quotations, because the joined text is not
        # contiguous in the verse: `وَكَثِيرٌ مِّنَ ٱلنَّاسِ` … `حَقَّ عَلَيْهِ
        # ٱلْعَذَابُ`, skipping the second `وَكَثِيرٌ` he is contrasting.
        run = [index]
        probe = index + 1
        while probe < len(candidates):
            nstart, _nend, nkind, _ninner = candidates[probe]
            if (nkind == "quote") != (kind == "quote"):
                break
            if not joinable(text[candidates[run[-1]][1]:nstart]):
                break
            run.append(probe)
            probe += 1

        if len(run) > 1:
            joined = None
            for length in range(len(run), 1, -1):
                first = candidates[run[0]]
                last = candidates[run[length - 1]]
                if overlaps(first[0], last[1]):
                    continue
                combined = " ".join(candidates[k][3].strip() for k in run[:length])
                body = wrap(combined)
                if body:
                    joined = (length, body, first[0], last[1])
                    break
            if joined:
                length, body, from_pos, to_pos = joined
                edits.append((from_pos, to_pos, body))
                edited.append((from_pos, to_pos))
                if (anchor is None and not seeded and not had_verse
                        and state["v"] and from_pos):
                    anchor = (from_pos, state["s"], state["v"], state["end"])
                index = run[length - 1] + 1
                continue

        index += 1
        if kind == "focus":
            # Already in the processing form; it names the verse under
            # discussion and its citation is placed later.
            focus(inner)
            if anchor is None and not seeded and state["v"] and start:
                anchor = (start, state["s"], state["v"], state["end"])
            continue
        marked = f"*\ufd3f{inner}\ufd3e{{.quran-quote}}*"
        if kind == "bare":
            # The focal quotation itself: it must reach the citation passes in
            # the vault's form, and it is what the fragments below gloss.
            focus(inner)
            if anchor is None and not seeded and state["v"] and start:
                anchor = (start, state["s"], state["v"], state["end"])
            if not overlaps(start, end):
                # The verse's own text when the quotation was placed in it: an
                # OCR `خیر` written with a Farsi yeh becomes `خَيْرٌ`, which the
                # Uthmanic faces can render — and the tashkīl comes with it.
                body = strip_verse_emblems(_display(state.get("matched") or inner))
                marked = f"*\ufd3f{body}\ufd3e{{.quran-quote}}*"
                edits.append((start, end, marked))
                edited.append((start, end))
            continue
        if overlaps(start, end):
            continue
        replacement = wrap(inner)
        if replacement:
            edits.append((start, end, replacement))
            edited.append((start, end))
        if anchor is None and not seeded and not had_verse and state["v"] and start:
            anchor = (start, state["s"], state["v"], state["end"])

    # ── The glosses before the first anchor ────────────────────────────────
    #
    # A page can open in the middle of a commentary: the verse was quoted on the
    # page before, and these words gloss it term by term. Nothing in them can be
    # located on its own — a one- or two-letter word is only ever recognised
    # against a verse already known — so the scan above leaves them alone. Once
    # this page's first real quotation resolves, that verse is by far the best
    # answer for them, so the *same* rules are run again over the page, seeded
    # with it. Only that page is reconsidered, and only from its start: if these
    # words are not that verse's, nothing is marked, which is the safe direction.
    if anchor and not seeded:
        page_break = "\n\n---\n\n"
        # The page the anchor is on, plus the one before it: a commentary's
        # verse is quoted at the top of its page and glossed under it, or the
        # quotation closed the page before. Never further back, and never more
        # than a couple of pages' worth of text.
        cutoff = anchor[0]
        previous = text.rfind(page_break, 0, cutoff)
        if previous >= 0:
            earlier = text.rfind(page_break, 0, previous)
            cutoff = earlier + len(page_break) if earlier >= 0 else 0
        else:
            cutoff = 0
        region_start = max(cutoff, anchor[0] - 8000, 0)
        leading = [(s, e, body) for (s, e, kind, body) in candidates
                   if kind == "quote" and region_start <= s < anchor[0]]
        saved = dict(state)
        state["s"], state["v"], state["end"] = anchor[1], anchor[2], anchor[3]
        state["pos"] = 0
        for start, end, inner in leading:
            if overlaps(start, end):
                continue
            replacement = wrap(inner.strip())
            if replacement:
                edits.append((start, end, replacement))
                edited.append((start, end))
        state.update(saved)

    # Applying in descending position keeps every earlier offset valid; the
    # recovery pass above appends earlier ranges, so the order is not the one
    # they were found in.
    for start, end, replacement in sorted(edits, key=lambda edit: edit[0], reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def merge_adjacent_quotes(content: str) -> tuple[str, int]:
    r"""Join two quotations that nothing separates into one.

    A model marks a continuous passage verse by verse:

        *﴿ذَلِكَ بِأَنَّ ٱللَّهَ … قَدِيرٌ﴾* [[Q022#6]] *﴿وَأَنَّ ٱلسَّاعَةَ …﴾* [[Q022#7]]

    Nothing sits between the two spans, so it is one quotation and should carry
    one range citation and one range marker, not two of each. The halves are
    joined only when their citations name consecutive verses of one sūra — the
    evidence that the model split one passage rather than quoting twice — which
    is also why this runs after the citations exist.
    """
    LF, LE = '\ufd3f', '\ufd3e'
    span = (LF + r'([^' + LF + LE + r'\n]+)' + LE
            + r'(?:\{\.quran-quote\})?\*?[ \t]*')
    link = (r'\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\|(\d+))?\]\]\)?')
    pair = re.compile(r'(\*?' + span + link + r')([ \t]*\*?[ \t]*)' + span + link)
    joined = 0

    def repl(m: re.Match) -> str:
        nonlocal joined
        first_surah, first_verse = int(m.group(3)), int(m.group(4))
        first_end = int(m.group(5)) if m.group(5) else first_verse
        second_surah = int(m.group(8))
        second_verse = int(m.group(9))
        if second_surah != first_surah or second_verse != first_end + 1:
            return m.group(0)
        joined += 1
        body = f"{m.group(2)} {m.group(7)}"
        return (f"*\ufd3f{body}\ufd3e{{.quran-quote}}* "
                + build_wikilink(first_surah, first_verse, end_verse=second_verse))

    return pair.sub(repl, content), joined


def _fragment_span(verse_text: str, fragment: str) -> bool:
    """True when `fragment` sits on whole words inside the canonical verse.

    A match that begins or ends in the middle of a word is almost certainly a
    coincidental alignment (the normalizer drops whitespace and alefs), so the
    caller keeps the author's spelling instead.
    """
    position = verse_text.find(fragment)
    if position < 0:
        return False
    if position > 0:
        before = verse_text[position - 1]
        if before.isalpha() or unicodedata.category(before).startswith("Mn"):
            return False
    end = position + len(fragment)
    if end < len(verse_text):
        after = verse_text[end]
        if after.isalpha() or unicodedata.category(after).startswith("Mn"):
            return False
    return True


def canonicalize_quran_quotes(content: str) -> tuple[str, int]:
    """Rewrite bare ``﴿…﴾`` quotes as the canonical tashkīl of the cited verse.

    Matching runs through `normalize_arabic`, which drops whitespace and
    diacritics, so OCR spacing slips such as ``فَ إِنَّ`` are repaired to the
    canonical ``فَإِنَّ`` instead of being preserved. Only quotes that already
    carry a single-verse citation are touched: cross-verse ranges, quotes
    assembled from several fragments, and quotes that do not match their verse
    are left exactly as they are.

    This is the final safety net for already-rendered notes, where the quote
    text arrived from OCR and the citation link was added later.
    """
    changed = 0

    def _replace(match: re.Match) -> str:
        nonlocal changed
        quote = match.group(1)
        if " * " in quote or "\ufd3f" in quote or "\ufd3e" in quote:
            return match.group(0)
        surah, verse = int(match.group(3)), int(match.group(4))
        fragment = get_tashkil_fragment(quote, surah, verse)
        if not fragment:
            return match.group(0)
        fragment = _strip_leading_marks(fragment).rstrip()
        if not fragment or fragment == quote.strip():
            return match.group(0)
        verse_text = load_verse(surah, verse) or ""
        if not _fragment_span(verse_text, fragment):
            # The match begins or ends inside a canonical word: a coincidental
            # alignment (the normalizer drops spaces and alefs). Keep the
            # author's spelling instead of emitting a broken fragment.
            return match.group(0)
        changed += 1
        return f"\ufd3f{fragment}\ufd3e{match.group(2)}"

    return BARE_QUOTE_REF.sub(_replace, content), changed


def mark_short_fragments(content: str) -> tuple[str, int]:
    """Mark a bare parenthetical that quotes the verse under discussion.

    A tafsīr quotes a verse word by word — `(أَنْ تَبْتَغُوا) …` — and a
    whole-Qur'ān search cannot resolve one or two words. In a commentary the
    phrase is unambiguous when it follows the verse just quoted:

      1. the next words of that verse, tracked with a cursor so the excerpts
         advance through the āya in order (this is what makes even one word
         safe);
      2. elsewhere in the same verse, when it is a multi-word phrase;
      3. the opening words of the next verse, when the previous quotation
         reached the end of its verse.

    "قال" is not required: a bare parenthetical is a candidate on its own.
    """
    verse_ref = re.compile(r"\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\|[^\]]*)?\]\]\)?")
    paren = re.compile(r"\(([^()\n]{2,160})\)")
    edits: list[tuple[int, int, str]] = []
    cursor: tuple[int, int, int] | None = None
    for match in paren.finditer(content):
        inner = match.group(1)
        if not re.search(r"[\u0621-\u064A]", inner):
            continue
        if "[[" in inner or "]]" in inner or "|" in inner:
            continue  # a citation link's display, not a quotation
        before = content[:match.start()]
        if before.rstrip().endswith(("\ufdfa", "\ufdf3")):
            continue
        if "﴿" in before[-200:] and "﴾" not in before[before.rfind("﴿"):]:
            continue  # inside an open quote
        refs = list(verse_ref.finditer(before))
        if not refs:
            continue
        surah, verse = int(refs[-1].group(1)), int(refs[-1].group(2))
        norm = normalize_arabic(inner)
        if len(norm) < 2:
            continue

        found: tuple[int, int, str] | None = None
        verse_text = load_verse(surah, verse) or ""

        def place(text: str) -> tuple[int, int] | None:
            """Where these words sit in `text`, on its word boundaries."""
            return _word_span_for(text, normalize_arabic(inner))

        # 1. Continue from the cursor in this verse. The cursor is the raw
        # character offset where the preceding quotation ends, so a gloss word
        # that merely appears somewhere in the verse cannot match.
        start_at = 0
        if cursor and cursor[0] == surah and cursor[1] == verse:
            start_at = cursor[2]
        quotes_before = list(re.finditer(r"﴿([^﴾]{1,120})﴾", before))
        if quotes_before:
            quote_span = _word_span_for(verse_text, normalize_arabic(quotes_before[-1].group(1)))
            if quote_span and quote_span[1] >= start_at:
                start_at = quote_span[1]
        span = place(verse_text)
        if span and span[0] == start_at:
            found = (surah, verse, verse_text[span[0]:span[1]])
            cursor = (surah, verse, span[1])

        # 2. A multi-word phrase may sit anywhere in the verse.
        if found is None and len(inner.split()) >= 2:
            span = place(verse_text)
            if span:
                found = (surah, verse, verse_text[span[0]:span[1]])
                cursor = (surah, verse, span[1])

        # 3. The opening words of the next verse.
        if found is None:
            following = load_verse(surah, verse + 1)
            if following:
                span = place(following)
                if span and span[0] < len(following.split()[0]) + 1:
                    found = (surah, verse + 1, following[span[0]:span[1]])
                    cursor = (surah, verse + 1, span[1])

        if not found:
            continue
        edits.append((match.start(), match.end(),
                      render_quran_quote(found[2], "full", found[0], found[1])))

    for start, end, replacement in reversed(edits):
        content = content[:start] + replacement + content[end:]
    return content, len(edits)


def fix_cross_page_quotes(content: str) -> tuple[str, int]:
    """A Qur'an quote that crosses a page break gets ONE set of ornate parens
    and ONE link: the first page keeps the opening paren (open span), and the
    next page carries the closing paren plus the link, looked up from the
    reconstructed whole quote.

    First page: *LF<partial>{.quran-quote}*
    Next page:  *<continuation>LE{.quran-quote}*<wikilink>

    Returns (content, count)."""
    LF, LE = '\ufd3f', '\ufd3e'
    blocks = re.split(r'\n\n---\n\n', content)
    count = 0
    for i in range(len(blocks) - 1):
        body = blocks[i].rstrip()
        nxt = blocks[i + 1]
        # A Qur'an span at the very end of this page: either open-only
        # (*LF<text>) or already closed by Gemini (*LF<text>LE{.quran-quote}*
        # optionally followed by a link).
        m = re.search(
            r'(\*' + LF + r')([^*' + LE + r'\n]+?)'
            r'(?:' + LE + r'\{\.quran-quote\}\*)?'
            r'(?:[ \t]*\(\[\[[^\]\n]*\]\]\))?'
            r'[ \t]*$',
            body,
        )
        if m:
            partial_raw, span_start = m.group(2), m.start()
        else:
            # A transcription often opens a verse with a plain italic span
            # instead of an ornate paren, and leaves it unclosed across the
            # page break. An italic opener at the end of a page is an open
            # quotation exactly as an ornate `*﴿…` is, so the ornate opening is
            # supplied here. The verse check below is what makes this safe: a
            # closed italic cannot match this pattern, and an unclosed one that
            # does not resolve is left alone.
            bare = re.search(
                r'(?<![*\w])\*([^*' + LF + LE + r'\n]{6,})[ \t]*$', body)
            if not bare:
                continue
            partial_raw, span_start = bare.group(1), bare.start()
        partial = partial_raw.strip().replace('{.quran-quote}', '').strip()
        # Character-for-character normalisation, not `normalize_arabic`: this
        # function maps between a normalised string and offsets in the original
        # text, and the word-level folds (a squeezed run, a dropped final yāʾ)
        # change the length, which would put every offset after them one or
        # more characters out. `_norm_char` keeps the mapping 1:1.
        pn = _per_char_norm(partial)
        if len(pn) < 2:
            continue
        # Locate the continuation at the start of the next page.
        head = _PAGE_HEAD_RE.match(nxt)
        cont_start = head.end() if head else 0
        nb = nxt[cont_start:]
        # Look up the verse from the partial, or (if it is short) from the
        # partial plus the first few words of the continuation.
        results = find_verse_in_text(partial)
        if not results:
            # An OCR slip late in the quotation (`مُلَّخَّقَة` for `مُّخَلَّقَة`)
            # makes the whole fragment unmatched even though its opening is
            # exact. The opening is all a continuation needs, so fall back to
            # progressively shorter prefixes.
            words = partial.split()
            for k in range(len(words) - 2, 2, -1):
                results = find_verse_in_text(' '.join(words[:k]), skip_filter=True)
                if results:
                    break
        if not results:
            words = nb.split()
            for k in range(1, min(10, len(words)) + 1):
                results = find_verse_in_text(partial + ' ' + ' '.join(words[:k]),
                                             skip_filter=True)
                if results:
                    break
        if not results:
            continue
        surah, verse, _, _ = results[0]
        verse_text = load_verse(surah, verse)
        if not verse_text:
            continue
        vn = _per_char_norm(verse_text)
        # Locate the end of this page's quotation by its longest suffix that the
        # verse contains. Matching the whole fragment would require every letter
        # to agree, and one OCR slip (`مُلَّخَّقَة` for `مُّخَلَّقَة`) is enough
        # to lose a continuation that is otherwise exact.
        idx, tail = -1, 0
        for size in range(min(len(pn), 80), 11, -4):
            found = vn.find(pn[-size:])
            if found >= 0:
                idx, tail = found, size
                break
        if idx < 0:
            continue
        rem_norm = vn[idx + tail:]
        if len(rem_norm) < 2:
            continue
        # The continuation is the longest prefix of the verse remainder found
        # at the start of the next page (Gemini may stop the quote early).
        end = _norm_prefix_end(nxt, cont_start, rem_norm)
        if end < 0:
            continue
        # Include trailing combining marks (tanwīn etc.) in the span.
        while end < len(nxt) and unicodedata.category(nxt[end]).startswith("Mn"):
            end += 1
        cont_raw = nxt[cont_start:end].strip()
        if len(normalize_arabic(cont_raw)) < 2:
            continue
        rest = nxt[end:]
        # Drop Gemini's stray verse-number marker or closing asterisk, but do
        # NOT eat the opener of the next quote (*LF...).
        rest = re.sub(r'^[ \t]*\*' + LF + r'[\d\u0660-\u0669]*' + LE + r'\*', '', rest)
        rest = re.sub(r'^[ \t]*\*(?!' + LF + r')', '', rest, count=1)
        rest = re.sub(r'^[ \t]*' + LE, '', rest, count=1)
        blocks[i] = body[:span_start] + _open_half(
            canonical_open_words(partial, surah, verse) or partial, surah, verse)
        blocks[i + 1] = (nxt[:cont_start] + render_quran_quote(cont_raw, "end", surah, verse)
                         + rest)
        count += 1
    return '\n\n---\n\n'.join(blocks), count


def canonical_open_words(quote_text: str, surah: int, verse: int) -> str | None:
    """The verse's own vocalisation for the opening half of a split quotation.

    A quotation that crosses a page break is written in two halves, and the
    first half is opened on one page and closed on the next. It is a long span,
    so one OCR slip in it (`مُلَّخَّقَة` for `مُّخَلَّقَة`) fails verification as
    a whole — and then the half keeps the source's spelling, including
    `يَا أَيّهَا` where the muṣḥaf writes `يَٰٓأَيُّهَا`.

    The words are therefore walked in order against the verse from its first
    word: a word that matches takes the verse's vocalisation, and a word that is
    only a *near* miss (an OCR slip inside an otherwise identical word) takes it
    too. A word that is genuinely different keeps the author's spelling, and the
    walk carries on, so the divergence costs one word rather than the rest of the
    half. Nothing is invented that does not sit at the same position.
    """
    verse_text = load_verse(surah, verse)
    if not verse_text:
        return None
    # The vocative has to be joined first: the source writes `يا أيها` where the
    # verse writes one word, and an unjoined pair cannot align at all.
    words = _join_vocative(quote_text).split()
    verse_words = _verse_words(verse_text)
    if not words or not verse_words:
        return None
    out: list[str] = []
    for position, word in enumerate(words):
        norm = normalize_arabic(word)
        if position >= len(verse_words):
            out.append(word)
            continue
        start, end, verse_norm = verse_words[position]
        if norm == verse_norm:
            out.append(verse_text[start:end])
        elif _near_miss(norm, verse_norm):
            out.append(verse_text[start:end])
        else:
            out.append(word)
    # The half has to be the verse's *opening*; a quotation that starts
    # mid-verse is left alone rather than aligned against the wrong words. One
    # word is not evidence — `و` or `يا` can begin any verse — so the guard is
    # the first few words together.
    lead = min(3, len(words))
    if len(words) < lead or any(
            not _near_miss(normalize_arabic(words[i]), verse_words[i][2])
            for i in range(lead)):
        return None
    return " ".join(out)


def _near_miss(left: str, right: str) -> bool:
    """True when two words differ only as an OCR slip would make them differ."""
    if not left or not right:
        return False
    if left == right:
        return True
    if abs(len(left) - len(right)) > 2:
        return False
    return SequenceMatcher(None, left, right).ratio() >= 0.7


def _open_half(text: str, surah: int, verse: int) -> str:
    """The first page's half of a quote split across a page break.

    It carries the opening ornate paren and no citation: the closing half on the
    next page carries the citation, so one quotation is cited once.
    """
    begin = render_quran_quote(text, "begin", surah, verse)
    return re.sub(r"\s*\[\[[^\]\n]*\]\]\s*$", "", begin)


def convert_gemini_refs(content: str) -> tuple[str, int]:
    """Convert Gemini verse references to proper wikilinks.
    
    Handles all formats via parse_gemini_ref():
      (33:41), (33:41-43)              — Western surah + Western verses
      (الذاريات: 22-23), (الذاريات: 56)  — Arabic name + Western verses
      (إبراهيم : ٣٥ ، ٣٦)               — Arabic name + Arabic digits
      [Ahzab 2-5], (Al-Ahzab 3)        — English name, brackets
    Returns (new_content, converted_count)."""
    LF = '\ufd3f'; LE = '\ufd3e'
    
    converted = 0
    new_content = content
    surah_lookup = _build_surah_lookup()
    
    # Match citations after *LF...LE{quran-quote}* or LF...LE{quran-quote}*
    quote_end_pattern = re.compile(
        r'\*?' + LF + r'[^' + LE + r']*' + LE + r'\{\.quran-quote\}\*'
    )
    
    for qm in reversed(list(quote_end_pattern.finditer(new_content))):
        end = qm.end()
        after = new_content[end:end+60]
        
        # Skip if already has a wikilink (possibly inside source parentheses)
        if _ALREADY_LINKED.match(after):
            continue
        
        # Extract citation text — find the parenthesized/bracketed reference
        cm = _CITATION_SPAN.match(after)
        if not cm:
            continue
        
        citation = cm.group(1)
        leading = len(after) - len(after.lstrip())
        result = parse_gemini_ref(citation, surah_lookup)
        if not result:
            if not re.search(r'\d', citation):
                # Name-only citation (e.g. "سورة العصر") — strip it.
                new_content = new_content[:end] + new_content[end + leading + len(citation):]
                continue
            # Ambiguous numeric citation with no surah name — discard it and
            # identify the quote from its own text.
            ident = _identify_quote_range(_span_text(qm.group(0)))
            if not ident:
                new_content = new_content[:end] + new_content[end + leading + len(citation):]
                continue
            surah_num, v1, v2 = ident
            wikilink = build_wikilink(surah_num, v1, end_verse=v2)
            new_content = new_content[:end] + wikilink + new_content[end + leading + len(citation):]
            converted += 1
            continue

        surah_num, v1, v2 = result
        wikilink = build_wikilink(surah_num, v1, end_verse=v2)
        new_content = new_content[:end] + wikilink + new_content[end + leading + len(citation):]
        converted += 1
    
    return new_content, converted


def repair_damaged_links(content: str) -> tuple[str, int]:
    """Repair a citation an earlier run ate into debris.

    A link stripper that could reach inside ``([[stem#V|display]])`` used to
    consume everything up to the first ``]``, leaving ``]–[[…]])`` (the first
    half of a range) or ``]])])`` (a trailing bracket). Neither is a citation,
    and both hide the quotation from the linking passes, so they are restored to
    a valid single link — the surviving half names the verse — and the linking
    passes then re-verify or replace it.
    """
    repaired = 0
    # `]–[[stem#V|d]])` → ` ([[stem#V|d]])`: the range's first half is gone, so
    # the surviving half becomes the citation.
    def half(m: re.Match) -> str:
        nonlocal repaired
        repaired += 1
        return f" ({m.group(1)})"

    content = re.sub(r"(?<!\])\]\s*[–—-]\s*(\[\[(?:Q[A-Z]{0,2})?\d{3}[^\]]*\]\])\)",
                     half, content)
    # `([[…]])])` / `([[…]]) ])` → `([[…]])`: debris after a whole link, with
    # or without the space a link insertion leaves.
    content, n = re.subn(r"(\(?\[\[(?:Q[A-Z]{0,2})?\d{3}[^\]]*\]\]\))\s*\]\)", r"\1", content)
    repaired += n
    content, n = re.subn(r"(\[\[(?:Q[A-Z]{0,2})?\d{3}[^\]]*\]\])\]", r"\1", content)
    repaired += n
    return content, repaired


def strip_gemini_refs(content: str) -> tuple[str, int]:
    r"""Discard the source model's own verse citations, wherever they sit.

    Gemini writes `[المائدة: ٥١]`, and by the time this runs the formatter has
    escaped it to `\[المائدة: ٥١]`; it also wraps one in italics
    (`*\[المؤمنون: ١٠]*`) and often repeats it *after* the citation we added.
    The old pass only looked at a bracket immediately after a classed ornate
    span, so every one of those shapes survived into the note.

    The pipeline locates every verse itself, and the hint these refs were good
    for has already been taken by `add_missing_refs` and
    `discover_and_mark_quotes`, which run first. What is removed is only a
    *reference-looking* bracket — a name that is a sūra (or `سورة …`) with a
    number, or two numbers round a colon — so an editorial aside in brackets,
    or the Persian gloss `[غافل شود …]`, is left alone. A wikilink is never
    touched: its inner text is `Q022#1`, which is not a reference.

    Returns (new_content, stripped_count).
    """
    lookup = _build_surah_lookup()

    def looks_ref(inner: str) -> bool:
        inner = inner.strip()
        if not re.search(r"[\d\u0660-\u0669]", inner):
            return inner.startswith("سورة")
        if ":" in inner or "\uff1a" in inner:
            return True
        head = re.split(r"[\s,،]+", inner)[0]
        return head.startswith("سورة") or _normalize_surah_name(head) in lookup

    stripped = 0
    ref = re.compile(r"(?<!\[)\\?\[\s*([^\[\]\n]{2,40}?)\s*\\?\]")
    wrapped = re.compile(r"\*[ \t]*(\\?\[[^\[\]\n]{2,40}?\\?\])[ \t]*\*")
    brackets = re.compile(r"\\?\[|\\?\]")

    def drop_wrapped(m: re.Match) -> str:
        nonlocal stripped
        if not looks_ref(brackets.sub("", m.group(1))):
            return m.group(0)
        stripped += 1
        return ""

    def drop(m: re.Match) -> str:
        nonlocal stripped
        if not looks_ref(m.group(1)):
            return m.group(0)
        stripped += 1
        return ""

    content = wrapped.sub(drop_wrapped, content)
    content = ref.sub(drop, content)
    return content, stripped


def strip_false_quran(content: str) -> tuple[str, int]:
    """Convert *LF...LE{quran-quote}* that are not a verse's words to (text).

    The question is not "does this span carry a link" but "are these words the
    muṣḥaf's". A tafsīr cites a verse once per run and marks the margin, so a
    marked span without a link is the normal case — the second and third
    quotation of 22:16 in a paragraph carry no link of their own. Un-marking
    those turned a quotation back into prose, and because the words themselves
    are the evidence, the next pass marked them again: a re-render then kept
    finding one more gloss per run, and never settled.

    So a span is kept when its words are a verse's, in order, on word
    boundaries — checked against the verse named by the nearest citation before
    it, which is the passage being discussed. A span that verifies nowhere is
    the model's false quotation, and is returned to `(text)`.

    Run this AFTER add_missing_refs and convert_gemini_refs.
    """
    LF = '\ufd3f'; LE = '\ufd3e'
    stripped = 0
    new_content = content

    # Match: *LF...LE{.quran-quote}* or LF...LE{.quran-quote}* (missing opening *)
    pattern = re.compile(
        r'\*?' + LF + r'([^' + LE + LF + r']+)' + LE + r'\{\.quran-quote\}\*'
    )
    link_before = re.compile(
        r"\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\|(\d+))?[^\]]*\]\]")

    def verifies(text: str, before: str, local: int = 0) -> bool:
        """True when these are a verse's words, in order, on its boundaries."""
        segments = [s.strip() for s in text.split("*") if s.strip()]
        # A short fragment cannot be verified on its own, so it is measured
        # against the verse the nearest preceding citation names — the passage
        # the commentary is discussing. That is the same evidence the marking
        # pass used, which is what makes the two agree.
        refs = list(link_before.finditer(before))
        if refs:
            surah, verse = int(refs[-1].group(1)), int(refs[-1].group(2))
            end = refs[-1].group(3)
            last = int(end) if end and int(end) > verse else verse
            for offset in range(0, last - verse + 1):
                try:
                    verse_text = load_verse(surah, verse + offset) or ""
                except Exception:  # noqa: BLE001
                    verse_text = ""
                for seg in segments:
                    if verse_text and words_in_sequence(verse_text, seg):
                        return True
        for seg in segments:
            if len(seg.split()) <= 2:
                continue
            # With no citation to lean on, the page's heading is the last
            # evidence there is — and only for a span distinctive enough to
            # name one verse inside that sūra.
            hint = local if (local and (len(seg.split()) >= 3
                                        or len(normalize_arabic(seg)) >= 12)) else 0
            try:
                hit = find_verse_in_text(seg, hint_surah=hint or None)
            except Exception:  # noqa: BLE001
                hit = None
            if hit and _matches_cited_verses(hit[0][0], hit[0][1], seg):
                return True
        return False

    headings = surah_headings(content)

    def local_surah(at: int) -> int:
        number = 0
        for position, value in headings:
            if position < at:
                number = value
            else:
                break
        return number

    for m in reversed(list(pattern.finditer(new_content))):
        end = m.end()
        text = m.group(1).strip()
        # A pure verse-number marker (\uFD3F\u0661\u0661\u0664\uFD3E) is not a Qur'an quote.
        if not re.search(r'[\u0621-\u064A]', text):
            after = new_content[end:end + 60]
            lm = re.match(r'\s*\(\[\[[^\]]*\]\]\)', after)
            cut = end + (lm.end() if lm else 0)
            new_content = new_content[:m.start()] + f'({text})' + new_content[cut:]
            stripped += 1
            continue
        after = new_content[end:end+20].lstrip()
        if re.search(r'\[\[Q?\d{3}', after[:16]):
            continue  # has wikilink — keep it
        if verifies(text, new_content[:m.start()], local_surah(m.start())):
            continue  # the muṣḥaf's words; its citation is the margin marker
        stripped += 1
        new_content = new_content[:m.start()] + f'({text})' + new_content[end:]

    return new_content, stripped


BARE_QUOTE_REF = re.compile(
    "\ufd3f([^\ufd3e\n]{1,400})\ufd3e"          # ﴿ quote ﴾ on one line
    r"(\s*\(\[\[(\d{3})\s+[^#\]]+#(\d+)\|[^\]]*\]\])"  # ([[004 An-Nisa#129|…]])
)


_ALREADY_LINKED = re.compile(r"\s*\(?\s*\[\[Q?\d{3}")


_CITATION_SPAN = re.compile(r"\s*([\[\(][^\[\]\(\)\n]{1,120}[\]\)])")


_DAMAGED_MARKER = re.compile(r"\*\*\\\[\]\*{0,2}")


_EMPTY_VERSE_HEADING = re.compile(r"^#####[ \t]*(?:\\?\[\])*[ \t]*$")


_LEGACY_VERSE_LINK = (
    r"\[\[\s*\d{3}[^#\]]*#\d+\|\d+:\d+\]\]"
    r"(?:[ \t]*[\u2013\u2014-][ \t]*\[\[\s*\d{3}[^#\]]*#\d+\|\d+:\d+\]\])?"
)


_PAGE_HEAD_RE = re.compile(
    r'^(?:[ \t]*\n'
    r'|#{1,6}[^\n]*\n'
    r'|[ \t]*[\u0660-\u0669\d]{1,4}[ \t]*[-\u2013\u2014]?[ \t]*(?:سورة[^\n]*)?\n)*'
)


_SURAH_LOOKUP = None


_VERSE_HEADING = re.compile(r"^#####[ \t]+" + _LEGACY_VERSE_LINK + r"[ \t]*$")


#: A citation or marker, in either the bare shape the vault writes now
#: (`[[Q022#5]]`, `[[Q022#5|22:5]]`, `[[Q022#5|27]]` for a range) or the legacy
#: `[[024 An-Nur#10|24:10]]`. One definition, because every pass that looks for
#: a link must recognise both or it will treat a cited span as uncited.
_VERSE_LINK = (
    r"\[\[\s*(?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+"
    r"(?:\|[^\]\n]*)?\]\]"
)


#: A marginal marker, not a citation. What distinguishes them is the display
#: alias: a marker prints `S:V`, a citation's alias is a range's second verse
#: (`[[Q003#37|39]]`) or nothing at all (`[[Q022#5]]`). Nothing may strip a link
#: merely because it points at a verse.
#: A marginal marker, in either form: today's `|:` (or `|:12`) and the older
#: bold `|22:5`. A note rendered before the change still carries the old one, and
#: a re-render must strip it before writing the new one or the margin doubles.
_VERSE_MARKER = re.compile(
    r"(?:\*\*)?\[\[\s*(?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+"
    r"\|\s*(?::[0-9]*|\d+\s*:\s*\d+(?:\s*[\u2013\u2014-]\s*\d+\s*:\s*\d+)?)\s*\]\]"
    # Only its *own* emphasis may be removed. A single `*` after the marker is
    # the opening star of the quotation that follows it, and eating it left the
    # quotation unstyled on every pass — the marker is re-inserted before the
    # quotation, so the star was stripped again each time.
    r"(?:\*\*)?\ufeff?"
)


_VERSE_QUOTE_REF = re.compile(
    # Either a whole span on this line, or only the closing half of one that
    # opened on the page before (`…رَبَتْ﴾{.quran-quote}* [[Q022#5]]`). The
    # second shape is how a quotation split across a page break reaches the
    # citation, and without it the verse was never numbered at all.
    r"(?:~)?(?:\*)?(?:\ufd3f[^\ufd3e\n]{1,400}\ufd3e|[^\ufd3f\n]{0,400}\ufd3e)"
    r"(?:~)?(?:\{\.quran-quote\})?\*?"
    # A quotation may be cut short before its citation: `… فَكَذَّبُوهُ. . .
    # الْآيَةَ ([[…]])`. The elision and `الآية` are still the same quotation.
    r"[ \t]*[»\"”’\)\]]*[ \t]*"
    r"(?:[.\u2026][ \t]*)*"
    r"(?:(?:الْآيَةَ|الْآيَةِ|الآية|الآيةِ|الْايَة|الايه)[ \t]*)?"
    # The link is either bare or wrapped in parentheses, and a range is either
    # a digits-only alias (`[[Q003#37|39]]`) or two links round a dash.
    r"\(?\[\[\s*(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\|(\d+))?\]\]\)?"
    r"(?:[ \t]*[\u2013\u2014-][ \t]*"
    r"\(?\[\[\s*(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)(?:\|\d+)?\]\]\)?)?"
)


_WORD_TRAIL = " \u00a0،,؛;:.؟!\"'«»“”‘’()[]…\u061f"


_SURA_HEADING = re.compile(
    r"(?m)^[ \t]*(?:#{1,6}[ \t]*)?"                            # a heading, if any
    r"(?:[\u0660-\u0669\d]{1,4}[ \t]*[-\u2013\u2014]?[ \t]*)?"  # printed number
    r"(?:سُورَة|سورة)[ \t]*[:،]?[ \t]*"                        # the word itself
    r"([^\n|]{2,40})"                                          # then a name
)


def surah_headings(text: str) -> list[tuple[int, int]]:
    """`(position, surah)` for every heading that names a sūra.

    The heading *level* is deliberately ignored: a transcription's levels are
    not consistent enough to mean anything, and a sūra name in the line is the
    evidence. A line whose name the vault's own notes do not carry is not a
    sūra heading, and is dropped.

    This is the only piece of structure a page can be trusted about. It is used
    when nothing else has told the pass which verse it is reading: a sūra and no
    verse narrows the muṣḥaf to one sūra, searched from its first verse.
    """
    lookup = _build_surah_lookup()
    found: list[tuple[int, int]] = []
    for match in _SURA_HEADING.finditer(text):
        name = re.split(r"[\s|:،\-\u2013\u2014]+", match.group(1).strip())[0]
        if not name:
            continue
        number = (lookup.get(_normalize_surah_name(name))
                  or lookup.get(normalize_arabic(name)))
        if number:
            found.append((match.start(), number))
    return found


def _build_surah_lookup() -> dict:
    """Build combined {normalized_name: surah_num} for English, Arabic, and numeric names.

    The notes are named for their citation (`Q022`), so the number comes from
    `SURA_NOTE` and the names come from the `aliases:` block — the file name no
    longer carries one. (Reading `f.stem[:3]` as an integer kept returning
    nothing once the notes were renamed, which silently disabled every sūra
    *name* in the vault: a reference written `[المائدة: ٥١]` was matched only
    because it happened to contain a colon.)

    Cached in module-level `_SURAH_LOOKUP`.
    """
    global _SURAH_LOOKUP
    if _SURAH_LOOKUP is not None:
        return _SURAH_LOOKUP

    lookup = {}
    for f in QURAN_DIR.glob("*.md"):
        stem = SURA_NOTE.match(f.stem)
        if not stem:
            continue
        sn = int(stem.group(1))
        # Only the aliases: the other frontmatter lists (`midad-up`, `related`)
        # repeat the same entries in every note, so reading them would map one
        # junk key to whichever sūra was read last.
        text = f.read_text(encoding="utf-8")
        block = re.search(r'^aliases:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)+)', text, re.M)
        for line in (block.group(1).splitlines() if block else []):
            line = line.strip()
            if not line.startswith("- "):
                continue
            alias = line[2:].strip().strip('"').strip("'")
            if not alias:
                continue
            if any('\u0600' <= c <= '\u06FF' for c in alias):
                # Arabic name
                clean = re.sub(r'^\d+\s*', '', alias).strip()
                # Letter-preserving key first (distinguishes النساء/الناس)
                k2 = _normalize_surah_name(clean)
                if k2:
                    lookup.setdefault(k2, sn)
                key = normalize_arabic(clean)
                if key:
                    lookup.setdefault(key, sn)
                lookup.setdefault(normalize_arabic(alias.strip()), sn)
            else:
                # English/transliterated name
                for name in (alias, alias.replace("-", " ")):
                    key = _normalize_eng_name(name)
                    if key:
                        lookup.setdefault(key, sn)
        # Numeric name: "33"
        lookup[str(sn)] = sn
        lookup[f"{sn:03d}"] = sn
    
    _SURAH_LOOKUP = lookup
    return lookup


def _identify_quote_range(quote_text: str):
    """Best-effort (surah, start_verse, end_verse) for a quote span, or None.
    Tries the longest prefix first so the most specific match wins."""
    norm = normalize_arabic(quote_text)
    if len(norm) < 5:
        return None
    for length in range(len(norm), 4, -3):
        r = find_verse_in_text(norm[:length], skip_filter=True)
        if r:
            s, v = r[0][0], r[0][1]
            vr = find_verse_range(quote_text, s, v)
            if vr:
                return (s, vr[0], vr[1])
            return (s, v, None)
    return None


def _norm_char(c: str) -> str:
    """Per-character fold, for mapping between normalised text and offsets.

    Deliberately *not* `normalize_arabic`: the word-level folds there (a
    squeezed run of one letter, a dropped final yāʾ) change the length of the
    string, so a normalised offset could no longer be read back as an offset in
    the original text. This one maps each character to at most one character.
    """
    if c in "\u06E5\u06E6\u0670\u0674\u0621\u0626\u0640\u0623\u0625\u0622\u0671\u0627":
        return ""
    d = unicodedata.normalize("NFKD", c)
    out = []
    for ch in d:
        if unicodedata.category(ch).startswith("Mn"):
            continue
        if ch == "\u0629":
            out.append("\u0647")
        elif ch in ("\u0649", "\u06CC"):
            out.append("\u064A")
        elif ("\u0621" <= ch <= "\u064A") or ch in "\u067E\u0686\u0698\u06A9\u06AF":
            out.append(ch)
    return "".join(out)


def _per_char_norm(text: str) -> str:
    """`_norm_char` over a whole string: the normalised form that keeps offsets."""
    return "".join(_norm_char(c) for c in text)


def _norm_prefix_end(text: str, start: int, target_norm: str) -> int:
    """Index in text of the longest prefix of target_norm present at `start`.
    Returns -1 if nothing matches."""
    acc = []
    last = -1
    for i in range(start, len(text)):
        nc = _norm_char(text[i])
        if not nc:
            continue
        acc.append(nc)
        cur = "".join(acc)
        if target_norm.startswith(cur):
            last = i + 1
            if cur == target_norm:
                return i + 1
        else:
            break
    return last


#: A sūra-name citation as a translation writes it: `(al-Baqarah: 255)`,
#: `(An-Nisāʾ: 19)`, `(Āl ʿImrān: 187)`. The name is looked up through the
#: vault's own aliases, so the strict romanisation, the common one and the Arabic
#: all resolve; an empty or impossible number is left as text.
_NAMED_REF = re.compile(
    r"\(\s*([^()\n]{2,40}?)\s*[:\u060c]\s*"
    r"([0-9\u0660-\u0669]{1,3}(?:\s*[-\u2013\u2014]\s*[0-9\u0660-\u0669]{1,3})?)"
    r"\s*\)")
_ARABIC_DIGITS = str.maketrans(
    "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669",
    "0123456789")


#: `(Q. 51:18)` — the prefix marks a citation outright.
_Q_REF = re.compile(
    r"\(\s*Q\.?\s*(\d{1,3})\s*:\s*(\d{1,3})"
    r"(?:\s*[-\u2013\u2014]\s*(\d{1,3}))?\s*\)")
#: `(Sūrat Āl ʿImrān 3:18)` — a named sūra and then its verse.
_SURAT_REF = re.compile(
    r"\(\s*(?:S[uū]rat|Surat)\s+([^()\n:]{2,40}?)\s+(\d{1,3})\s*:\s*(\d{1,3})"
    r"(?:\s*[-\u2013\u2014]\s*(\d{1,3}))?\s*\)")


def _skeleton(name: str) -> str:
    """A sūra name reduced to what the transliterations vary.

    The article (`al-`, `an-`, `ash-` …), a final `h`, a doubled vowel and the
    `y`/`i` spelling are the four things that differ between the common
    romanisations and the repositories' own (`al-Nisāʾ`/`An-Nisāʾ`,
    `al-Baqara`/`al-Baqarah`, `al-Shūrā`/`Ash-Shuraa`, `al-Anbiyāʾ`/`Al-Anbya`).
    Folding all four makes those agree; a name that then reaches more than one
    sūra is refused by the caller rather than guessed at.
    """
    value = _normalize_eng_name(name)
    for article in ("ash", "ath", "adh", "al", "an", "as", "at", "ad", "ar", "az"):
        if value.startswith(article) and len(value) > len(article) + 2:
            value = value[len(article):]
            break
    if value.endswith("h"):
        value = value[:-1]
    value = re.sub(r"(.)\1+", r"\1", value)
    # `y` and `i` are the same sound here, and folding them can produce a
    # doubled vowel that was not there before (`biya` → `biia`), so the run is
    # collapsed again afterwards.
    return re.sub(r"(.)\1+", r"\1", value.replace("y", "i"))


def _consonant_skeleton(name: str) -> str:
    """The last reduction: the consonants alone.

    A translator may move a vowel (`al-Mumtaḥina` against the repository's
    `Al-Mumtahana`), which the syllable skeleton still sees. Dropping the vowels
    as well absorbs it. This is tried last, and only for a consonant skeleton
    that names one sūra, so it can never override an exact or syllable match.
    """
    return re.sub(r"[aeiou]", "", _skeleton(name))


_SKELETONS = None
_CONSONANTS = None


def _consonant_lookup() -> dict[str, set[int]]:
    global _CONSONANTS
    if _CONSONANTS is None:
        found: dict[str, set[int]] = {}
        for key, surah in _build_surah_lookup().items():
            if not key or not key[0].isalpha() or not key.isascii():
                continue
            found.setdefault(_consonant_skeleton(key), set()).add(surah)
        _CONSONANTS = found
    return _CONSONANTS


def _skeleton_lookup() -> dict[str, set[int]]:
    """Every skeleton that names exactly one sūra (built once)."""
    global _SKELETONS
    if _SKELETONS is None:
        found: dict[str, set[int]] = {}
        for key, surah in _build_surah_lookup().items():
            if not key or not key[0].isalpha() or not key.isascii():
                continue
            found.setdefault(_skeleton(key), set()).add(surah)
        _SKELETONS = found
    return _SKELETONS


def link_named_refs(text: str) -> tuple[str, int]:
    """Turn `(al-Baqarah: 255)` into `[[Q002#255]]`.

    A translated tafsīr cites its verses by name rather than by link, and the
    name is what is recognisable without a quotation to compare it against: the
    vault's sūra aliases carry the strict romanisation, the common one and the
    Arabic. Only a name that resolves is converted, and only with a verse number
    — the model sometimes writes `(al-Baqarah: ])`, which names no verse and is
    left alone.
    """
    lookup = _build_surah_lookup()
    skeletons = _skeleton_lookup()

    def number_for(name: str) -> int | None:
        if re.search(r"[0-9]", name):
            return None
        exact = (lookup.get(_normalize_surah_name(name))
                 or lookup.get(_normalize_eng_name(name))
                 or lookup.get(normalize_arabic(name)))
        if exact:
            return exact
        # A translation spells the name its own way: `al-Nisāʾ` for An-Nisāʾ,
        # `al-Baqara` for al-Baqarah. The article and a final h are the two
        # things that vary, and a name that still reaches more than one sūra is
        # left alone rather than guessed at.
        candidates = skeletons.get(_skeleton(name))
        if candidates and len(candidates) == 1:
            return next(iter(candidates))
        consonants = _consonant_lookup().get(_consonant_skeleton(name))
        if consonants and len(consonants) == 1:
            return next(iter(consonants))
        return None

    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        surah = number_for(match.group(1).strip())
        if not surah:
            return match.group(0)
        numbers = [int(n.translate(_ARABIC_DIGITS))
                   for n in re.findall(r"[0-9\u0660-\u0669]{1,3}", match.group(2))]
        if not numbers:
            return match.group(0)
        start = numbers[0]
        end = numbers[1] if len(numbers) > 1 else start
        if not (1 <= start <= 286) or end < start:
            return match.group(0)
        count += 1
        return f"[[Q{surah:03d}#{start}" + (f"|{end}]]" if end > start else "]]")

    text = _NAMED_REF.sub(repl, text)

    # `(Q. 51:18)`: the prefix makes it a citation on its own.
    def repl_q(match: re.Match) -> str:
        nonlocal count
        surah, verse = int(match.group(1)), int(match.group(2))
        end = int(match.group(3)) if match.group(3) else verse
        if not (1 <= surah <= 114) or not (1 <= verse <= 286) or end < verse:
            return match.group(0)
        count += 1
        return f"[[Q{surah:03d}#{verse}" + (f"|{end}]]" if end > verse else "]]")

    text = _Q_REF.sub(repl_q, text)

    # `(Sūrat Āl ʿImrān 3:18)`: a name and then the reference.
    def repl_surat(match: re.Match) -> str:
        nonlocal count
        named = number_for(match.group(1).strip())
        surah = int(match.group(2))
        verse = int(match.group(3))
        end = int(match.group(4)) if match.group(4) else verse
        # The form is `Sūrat <name> <sūra>:<verse>`: the first number is the
        # sūra, the second the verse. A name that resolves to another sūra
        # contradicts the number, so nothing is converted.
        if named and named != surah:
            return match.group(0)
        if not (1 <= surah <= 114) or not (1 <= verse <= 286) or end < verse:
            return match.group(0)
        count += 1
        return f"[[Q{surah:03d}#{verse}" + (f"|{end}]]" if end > verse else "]]")

    text = _SURAT_REF.sub(repl_surat, text)
    return text, count


def _normalize_eng_name(name: str) -> str:
    """Normalize an English/transliterated surah name for lookup.
    Strips diacritics (ḥ→h, ā→a), punctuation, spaces. Returns lowercase."""
    # Decompose combined characters, strip combining marks (diacritics)
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.category(c).startswith("M"))
    # Keep only letters and digits
    name = re.sub(r"[^a-z0-9]", "", name.lower())
    return name


def _span_text(span: str) -> str:
    """Text between the ornate parentheses of a *LF...LE* span."""
    m = re.search(r'\uFD3F([^\uFD3E]*)\uFD3E', span)
    return m.group(1) if m else span


def _strip_leading_marks(text: str) -> str:
    """Drop combining marks that belong to the word before a fragment."""
    text = text.lstrip()
    index = 0
    while index < len(text) and unicodedata.category(text[index]).startswith("Mn"):
        index += 1
    return text[index:]


def _surah_continues(quotes, start: int, surah: int, window: int, least: int) -> bool:
    return sum(1 for q in quotes[start:start + window] if q[2] == surah) >= least


def _verse_heading(stem: str, surah: int, start: int, end: int | None) -> str:
    if end and end != start:
        return (
            f"##### [[{stem}#{start}|{surah}:{start}]]"
            f"\u2013[[{stem}#{end}|{surah}:{end}]]"
        )
    return f"##### [[{stem}#{start}|{surah}:{start}]]"


def _verse_marker(stem: str, surah: int, start: int, end: int | None) -> str:
    """One link carries the marker; a range is the link's display text.

    Keeping the whole marker a single wikilink means the editor renders it as
    one link, and the plugin can style that link's text directly.
    """
    # A marginal reference is signalled by the alias, not by emphasis: `:` for
    # one verse, `:12` for a range that ends there. Bold was the old signal, and
    # it also forced the FEFF that closed the emphasis; neither is needed.
    alias = ":" if not end or end == start else f":{end}"
    return f"[[{stem}#{start}|{alias}]]"


def _hint_may_decide(text: str) -> bool:
    """Can our own search settle this quotation, or is a tie the only truth?

    A transcription's citation is the model's, not the author's, so it may only
    settle what the words leave open: they occur in more than one sūra, or the
    search finds nothing at all (an awkward fragment, which is exactly where a
    verified citation is the one piece of evidence there is).
    """
    found = find_verse_in_text(text)
    suras = {row[0] for row in found}
    return not suras or len(suras) > 1


def citation_hint(text: str, content: str, start: int, end: int,
                  tie_break: bool = False) -> tuple[int, int, int | None] | None:
    """A verified citation adjacent to a quote, used as a first search hint.

    The source citation is never trusted on its own: the quoted text must be
    found in the named verse (or range). If verification fails, callers fall
    back to ordinary text matching.

    `tie_break` is for a transcription, whose citations are the model's: there
    the citation may only decide what our own search leaves open, so a
    fabricated reference cannot steer a link. A repository's citation is the
    author's and is used as it stands.
    """
    if tie_break and not _hint_may_decide(text):
        return None
    lookup = _build_surah_lookup()
    candidates: list[str] = []
    after = content[end:end + 100]
    match = _CITATION_SPAN.match(after)
    if match:
        candidates.append(match.group(1))
    before = content[max(0, start - 100):start]
    match = re.search(r'([\[\(][^\[\]\(\)\n]{1,120}[\]\)])\s*$', before)
    if match:
        candidates.append(match.group(1))
    for citation in candidates:
        if '[[' in citation or ']]' in citation:
            continue
        parsed = parse_gemini_ref(citation, lookup)
        if not parsed:
            continue
        surah, verse, end_verse = parsed
        if end_verse:
            if find_verse_range(text, surah, verse):
                return (surah, verse, end_verse)
        if get_tashkil_fragment(text, surah, verse):
            return (surah, verse, None)
    return None


def parse_gemini_ref(citation: str, surah_lookup: dict = None) -> tuple[int, int, int | None] | None:
    """Parse any citation format. Returns (surah_num, verse_start, verse_end_or_None) or None.
    
    Handles:
      (33:41-43), (51:56)               — Western surah
      (الذاريات: 22-23)                 — Arabic name + Western digits
      (إبراهيم : ٣٥ ، ٣٦)               — Arabic name + Arabic digits
      [Ahzab 2-5], (Al-Ahzab 3)        — English name, brackets
      (Aḥzāb 2 – 5)                    — Transliterated w/ diacritics
    
    Flexible: normalizes delimiters, ignores punctuation inside parentheses.
    """
    citation = citation.strip()
    
    # Strip outer delimiters: ( ) or [ ]
    inner = re.sub(r'^[\[\(]|[\]\)]$', '', citation).strip()
    
    # Convert Arabic digits → Western for number extraction
    a_to_w = str.maketrans('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669', '0123456789')
    inner_w = inner.translate(a_to_w)
    
    # Find all numbers (Western digits), keeping their positions.
    nums = list(re.finditer(r'\d+', inner_w))
    if not nums:
        return None

    values = [int(m.group(0)) for m in nums]
    # A source may write both the sūra name and a redundant `sūra:āya`
    # (`[النساء 4:105]`). The first number is then the sūra, not the verse.
    first_num_pos = nums[0].start()
    has_surah_name = bool(inner_w[:first_num_pos].strip())
    # `sūra:āya` is also written `sūra \ āya` or `sūra / āya` (the Turath
    # edition of Aḍwāʾ al-bayān uses the backslash), so any of them separates.
    separator_after_first = inner_w[nums[0].end():nums[1].start()] if len(values) > 1 else ""
    has_colon_after_first = bool(re.search(r"[:\\/]", separator_after_first))
    # If there are more than two numbers and the first looks like a surah,
    # drop it and treat the remainder as verse numbers.
    start = 1 if (len(values) > 2 and values[0] <= 114) else 0
    if has_surah_name and has_colon_after_first and values[0] <= 114:
        start = 1

    v1 = values[start]
    v2 = values[start + 1] if len(values) > start + 1 else None

    # Extract surah identifier: everything before the first verse number.
    first_num_pos = nums[start].start()
    surah_part = inner_w[:first_num_pos].strip()

    # If there is no text before the first number, it is either a
    # "surah:verse" pair (colon) or a bare verse list with no surah name
    # ("33، 34" / "33, 34"). Only the colon form names a surah.
    if not surah_part and 1 <= v1 <= 114:
        remaining = values[start + 1:]
        if not remaining:
            return None
        sep = inner_w[nums[start].end():nums[start + 1].start()]
        if re.search(r"[:\\/]", sep):
            return (v1, remaining[0], remaining[1] if len(remaining) > 1 else None)
        # Bare number list with no surah name ("33، 34") — ambiguous (could be
        # verses 33-34 or surah 33 verse 34); don't guess.
        return None
    
    # Strip punctuation and delimiters to isolate surah name/number
    surah_clean = re.sub(r'[:\\/\-–—،,]+', ' ', surah_part).strip()
    surah_clean = re.sub(r'^سورة\s+', '', surah_clean).strip()
    
    # Try parsing as a number
    surah_nums = re.findall(r'\d+', surah_clean)
    if surah_nums:
        sn = int(surah_nums[0])
        if 1 <= sn <= 114:
            return (sn, v1, v2)
    
    if not surah_lookup:
        return None
    
    # Try lookup by name
    # 1. English normalization
    eng_norm = _normalize_eng_name(surah_clean)
    if eng_norm in surah_lookup:
        return (surah_lookup[eng_norm], v1, v2)
    
    # 2. Arabic name — prefer the letter-preserving key so that النساء (4) is
    #    not confused with الناس (114).
    if any('\u0600' <= c <= '\u06FF' for c in surah_clean):
        ar_key = _normalize_surah_name(surah_clean)
        if ar_key in surah_lookup:
            return (surah_lookup[ar_key], v1, v2)
        ar_norm = normalize_arabic(surah_clean)
        if ar_norm in surah_lookup:
            return (surah_lookup[ar_norm], v1, v2)
    
    # 3. Substring match
    for name, sn in surah_lookup.items():
        if 'a' <= name[0] <= 'z':
            if eng_norm and eng_norm in name:
                return (sn, v1, v2)
        else:
            ar_norm = normalize_arabic(surah_clean) if any('\u0600' <= c <= '\u06FF' for c in surah_clean) else ''
            if ar_norm and ar_norm in name:
                return (sn, v1, v2)
    
    return None
