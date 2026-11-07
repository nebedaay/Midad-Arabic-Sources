#!/usr/bin/env python3
"""Retrieve Quran verses with tashkīl. For tashkīl restoration and quote matching."""

import os
import re
import unicodedata
import sqlite3
from pathlib import Path

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
QURAN_DIR = VAULT / os.environ.get("MIDAD_CANONICAL_QURAN_DIR", "_7 Sources/Quran")
SQLITE_DB = QURAN_DIR / ".quran.sqlite"

def load_verse(surah_num: int, verse: int) -> str | None:
    """Load a single verse with tashkīl from the sura file."""
    prefix = f"{surah_num:03d} "
    matches = [f for f in QURAN_DIR.glob(f"{prefix}*.md")]
    if not matches:
        return None
    text = matches[0].read_text(encoding="utf-8")
    m = re.search(rf'^# {verse}\s*$(.+?)(?=^# |\Z)', text, re.MULTILINE | re.DOTALL)
    return m.group(1).strip() if m else None


def build_wikilink(surah: int, verse: int | str, end_verse: int = None, ar_verse: str = None, ar_end: str = None) -> str:
    """Build a wikilink. Single: ([[003 Al 'Imran#37|آل عمران : ٣٧]]).
    Range: ([[003 Al 'Imran#37|٣٧]]–[[003 Al 'Imran#39|٣٩]]).
    
    Args:
        surah, verse: start verse (int or range string like "26-27")
        end_verse: if provided, produce range with en-dash
        ar_verse, ar_end: optional pre-formatted Arabic numerals
    """
    w_to_a = str.maketrans('0123456789', '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')
    stem, arabic = get_surah_name(surah)
    
    if end_verse is not None:
        ar1 = ar_verse or str(verse).translate(w_to_a)
        ar2 = ar_end or str(end_verse).translate(w_to_a)
        return f" ([[{stem}#{verse}|{arabic} : {ar1}]]\u2013[[{stem}#{end_verse}|{ar2}]]) "
    
    verse_str = str(verse)
    ar = ar_verse or verse_str.translate(w_to_a)
    return f" ([[{stem}#{verse_str}|{arabic} : {ar}]]) "


def fix_wikilinks(content: str) -> tuple[str, int]:
    """Fix [[NNN SurahName#N|ref]] links, including a stale display alias."""
    pattern = re.compile(r'\[\[(\d{3})\s+([^#\]]+)#(\d+(?:-\d+)?)\|([^\]]+)\]\]')
    fixed = 0
    new_content = content
    w_to_a = str.maketrans('0123456789', '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')
    for m in reversed(list(pattern.finditer(content))):
        surah_num = int(m.group(1))
        verse_part = m.group(3)
        display = m.group(4)
        stem, arabic = get_surah_name(surah_num)
        # Older notes recorded the canonical work title as the link alias
        # (`Qurʾān (riwāyat Ḥafṣ) - 004 An-Nisa : ١٠٥`). The sūra name is the
        # stable display; keep the numeral the source had.
        if re.match(r'^Qurʾān\b', display):
            stamp = display.rsplit(" : ", 1)[-1].strip()
            if not re.fullmatch(r'[\u0660-\u0669]+', stamp):
                stamp = verse_part.split("-")[0].translate(w_to_a)
            display = f"{arabic} : {stamp}"
        correct = f"[[{stem}#{verse_part}|{display}]]"
        if m.group(0) != correct:
            new_content = new_content[:m.start()] + correct + new_content[m.end():]
            fixed += 1
    return new_content, fixed


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
        try:
            surah_num = int(f.stem[:3])
        except ValueError:
            continue
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
    """Load a single verse with tashkīl from the sura file."""
    # Find matching file by number prefix
    prefix = f"{surah_num:03d} "
    matches = [f for f in QURAN_DIR.glob(f"{prefix}*.md")]
    if not matches:
        return None
    path = matches[0]
    text = path.read_text(encoding="utf-8")
    pattern = rf'^# {verse}\s*$(.+?)(?=^# |\Z)'
    m = re.search(pattern, text, re.MULTILINE | re.DOTALL)
    if m:
        return m.group(1).strip()
    return None

def get_surah_name(surah_num: int) -> tuple[str, str]:
    """Return (wikilink_stem, arabic_name) matching the actual sura filename."""
    prefix = f"{surah_num:03d} "
    matches = [f for f in QURAN_DIR.glob(f"{prefix}*.md")]
    if not matches:
        return (f"Surah {surah_num}", f"{surah_num}")
    path = matches[0]
    # Use exact filename stem (minus .md) for the wikilink — no guessing
    stem = path.stem  # e.g. "003 Al 'Imran"
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
    return (stem, arabic)

def strip_raw_quran_citations(content: str) -> tuple[str, int]:
    """Remove every remaining source citation that names a Qur'ānic verse.

    Our own quote links are authoritative; keeping the source's square or
    parenthetical citation alongside them duplicates and mixes numbering styles.
    Wikilinks, markdown links, footnote marks, and ordinary numbered prose are
    not citations and are left alone.
    """
    lookup = _build_surah_lookup()
    pattern = re.compile(r'\[[^\[\]\n]{1,120}\]|\([^()\n]{1,120}\)')
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

    return pattern.sub(repl, content), removed


def strip_redundant_raw_citations(content: str) -> tuple[str, int]:
    """Remove a source citation still sitting after our own quote link."""
    pattern = re.compile(
        r'(\*[^*\n]*\{\.quran-quote\}\*\s*'
        r'\(\[\[[^\]]+\]\](?:[–-]\[\[[^\]]+\]\])?\))'
        r'\s*([\[\(][^\]\)\n]*[\d\u0660-\u0669][^\]\)\n]*[\]\)])'
    )
    stripped = 0
    while True:
        content, count = pattern.subn(r'\1', content)
        stripped += count
        if not count:
            break
    return content, stripped


def normalize_quran_link_display(content: str) -> tuple[str, int]:
    """Use the sūra name and Arabic-Indic numerals in every Qur'ān link."""
    w_to_a = str.maketrans('0123456789', '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')
    pattern = re.compile(r'\[\[(\d{3})\s+([^#\]]+)#(\d+)(?:-(\d+))?\|([^\]]+)\]\]')
    changed = 0

    def repl(m: re.Match) -> str:
        nonlocal changed
        surah = int(m.group(1))
        verse = m.group(3)
        end_verse = m.group(4)
        display = m.group(5)
        stem, arabic = get_surah_name(surah)
        verse_label = str(verse).translate(w_to_a)
        if end_verse:
            display = f"{arabic} : {verse_label}–{str(end_verse).translate(w_to_a)}"
        elif re.match(r'^Qurʾān\b', display) or re.match(r'^[^:]+ - \d{3}\s', display):
            display = f"{arabic} : {verse_label}"
        else:
            normalized = display.translate(w_to_a)
            if normalized != display:
                display = normalized
        suffix = f"-{end_verse}" if end_verse else ""
        replacement = f"[[{stem}#{verse}{suffix}|{display}]]"
        if replacement != m.group(0):
            changed += 1
        return replacement

    return pattern.sub(repl, content), changed


def dedupe_same_verse_links(content: str) -> tuple[str, int]:
    """Keep a citation only on the first and last quote of a same-verse run.

    All segments still carry the quote formatting. In a commentary a verse is
    quoted repeatedly; a link on every fragment is noise. A group is a run of
    adjacent quote spans with the same link; first and last keep the link, the
    middle links are removed. A change of link starts a new group, so the first
    quote after a switch is always cited.
    """
    quote = re.compile(
        r'(\*[^*\n]*\{\.quran-quote\}\*)'
        r'([ \t]*)'
        r'(\(\[\[[^\]]+\]\](?:[–-]\[\[[^\]]+\]\])?\))?'
    )
    matches = []
    for found in quote.finditer(content):
        line_start = content.rfind('\n', 0, found.start()) + 1
        if content[line_start:found.start()].lstrip().startswith('>'):
            continue  # footnote/poetry callout, not the running commentary
        matches.append(found)
    edits: list[tuple[int, int, str]] = []
    index = 0
    while index < len(matches):
        link = matches[index].group(3)
        if not link:
            index += 1
            continue
        end = index
        while end + 1 < len(matches) and matches[end + 1].group(3) == link:
            end += 1
        for middle in range(index + 1, end):
            edits.append((matches[middle].start(3), matches[middle].end(3), ""))
        index = end + 1
    for start, end, replacement in sorted(edits, key=lambda edit: edit[0], reverse=True):
        content = content[:start] + replacement + content[end:]
    return content, len(edits)


def strip_orphan_quote_classes(content: str) -> str:
    """Delete `{.quran-quote}` markers that are not the class of an italic span."""
    return re.sub(r'\{\.quran-quote\}(?!\*)', '', content)


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


def normalize_arabic(text: str) -> str:
    """Strip tashkīl and normalize Unicode for matching."""
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
    text = text.replace("\u0649", "\u064A")  # ى → ي
    text = text.replace("\u06CC", "\u064A")  # ی → ي
    # Strip isolated * (space on both sides) — Gemini's verse separators
    text = re.sub(r'\s*\*\s*', ' ', text)
    text = re.sub(r'\s+', '', text)
    # Strip everything except Arabic letters
    text = re.sub(r'[^\u0621-\u064A\u067E\u0686\u0698\u06A9\u06AF]', '', text)
    return text

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
            # Filter out short common phrases that match many verses
            if not skip_filter and nlen < 12 and len(sql_results) >= 3:
                return []
            return [(s, v, t, 1.0) for s, v, t in sql_results[:5]]
    except Exception:
        pass

    # 4. Orthographic variant: source editions often write a final alef where
    # the canonical text has alif maqṣūra (`أراك` / `أرىك`). Try the two
    # directions only after the exact search fails.
    for variant in (arabic_text.replace("ا", "ى"), arabic_text.replace("ى", "ا")):
        variant_norm = normalize_arabic(variant)
        if not variant_norm or variant_norm == normalized_input:
            continue
        try:
            sql_results = _search_sqlite(variant_norm)
            if sql_results:
                return [(s, v, t, 1.0) for s, v, t in sql_results[:5]]
        except Exception:
            pass

    # 5. Loose yāʾ-insensitive fallback, again only after exact attempts.
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
    search the rest of that verse and the next few verses. Returns
    (verse, end_offset) or None.

    In a tafsīr the next quote is almost always the words that follow the
    previous one, so this is tried before any full-text search."""
    vtext = load_verse(surah, verse)
    if vtext is not None:
        vn = normalize_arabic(vtext)
        idx = vn.find(normalized, offset)
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
    return None


def get_tashkil_fragment(quote_text: str, surah_num: int, verse_num: int) -> str | None:
    """Given a quote and its (surah, verse), find the matching fragment with tashkīl."""
    verse = load_verse(surah_num, verse_num)
    if not verse:
        return None
    # Strip الآية from end
    quote_text = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', quote_text).strip()
    normalized_quote = normalize_arabic(quote_text)
    normalized_quote = normalized_quote.replace('.', '')
    normalized_verse = normalize_arabic(verse)
    idx = normalized_verse.find(normalized_quote)
    if idx < 0 and '.' in quote_text:
        segments = quote_text.replace('.', '%%').split('%%')
        tashkil_parts = []
        for seg in segments:
            seg = seg.strip()
            if len(seg) < 10:
                tashkil_parts.append(seg); continue
            nseg = normalize_arabic(seg)
            sidx = normalized_verse.find(nseg)
            if sidx >= 0:
                frag = _extract_tashkil_by_index(verse, sidx, len(nseg), normalized_verse)
                tashkil_parts.append(frag if frag else seg)
            else:
                tashkil_parts.append(seg)
        return ' * '.join(tashkil_parts)
    if idx < 0:
        # Loose spelling fallback (see `find_verse_in_text`): treat yāʾ as
        # optional so ano/orthographic variants like أراك / أرىك still get the
        # canonical tashkīl.
        loose_quote = normalize_arabic(quote_text).replace("ي", "")
        loose_verse = normalized_verse.replace("ي", "")
        lidx = loose_verse.find(loose_quote)
        if lidx < 0:
            return None
        return _extract_tashkil_by_index(
            verse, lidx, len(loose_quote), loose_verse,
            lambda value: normalize_arabic(value).replace("ي", ""))
    return _extract_tashkil_by_index(verse, idx, len(normalized_quote), normalized_verse)


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
        nv = normalize_arabic(v)
        combined += nv
        if nq in combined:
            return (start_verse, current)
        current += 1
        if current - start_verse > 20:  # safety limit
            break
    return None
    """Given a quote and its (surah, verse), find the matching fragment with tashkīl.
    
    Returns the tashkīl fragment only if the normalized quote is found as a substring
    of the normalized verse. Otherwise returns None (don't modify the quote)."""
    verse = load_verse(surah_num, verse_num)
    if not verse:
        return None
    
    normalized_quote = normalize_arabic(quote_text)
    # Clean Gemini artifacts (periods between concatenated verses)
    normalized_quote = normalized_quote.replace('.', '')
    normalized_verse = normalize_arabic(verse)
    
    # Find the quote within the verse by normalized substring match
    idx = normalized_verse.find(normalized_quote)
    
    # If combined text doesn't match (periods from concatenated verses),
    # try each segment separately and reconstruct with tashkīl for matched parts
    if idx < 0 and '.' in quote_text:
        segments = quote_text.replace('.', '%%').split('%%')
        tashkil_parts = []
        for seg in segments:
            seg = seg.strip()
            if len(seg) < 10:
                tashkil_parts.append(seg)
                continue
            nseg = normalize_arabic(seg)
            sidx = normalized_verse.find(nseg)
            if sidx >= 0:
                frag = _extract_tashkil_by_index(verse, sidx, len(nseg), normalized_verse)
                tashkil_parts.append(frag if frag else seg)
            else:
                tashkil_parts.append(seg)
        return ' * '.join(tashkil_parts)
    
    if idx < 0:
        return None
    
    # Extract the tashkīl fragment corresponding to the match
    return _extract_tashkil_by_index(verse, idx, len(normalized_quote), normalized_verse)

def _extract_tashkil_by_index(
    verse: str, norm_idx: int, norm_len: int, normalized_verse: str,
    norm_func=None,
) -> str:
    """Extract the tashkīl text from verse given a position in the normalized text.

    `norm_func` lets the loose (yāʾ-insensitive) fallback use the same mapping
    machinery as the exact matcher.
    """
    norm_func = norm_func or normalize_arabic
    # Build mapping: for each verse char, how many normalized chars it contributes
    contrib = []
    for ch in verse:
        nc = norm_func(ch)
        contrib.append(len(nc) if nc else 0)
    
    # Find start: verse position where cumulative contribution reaches norm_idx
    cum = 0
    start_vi = len(verse)
    for i, c in enumerate(contrib):
        if c > 0 and cum == norm_idx:
            start_vi = i
            break
        cum += c
    
    if start_vi == len(verse):
        return verse[:10]  # fallback
    
    # Walk back to include diacritics/alefs preceding the start
    while start_vi > 0:
        if contrib[start_vi - 1] > 0:
            break
        if verse[start_vi - 1] in " \t\n\r":
            break
        start_vi -= 1
    
    # Collect characters until we've covered norm_len normalized chars
    result = []
    vi = start_vi
    collected = 0
    while vi < len(verse) and collected < norm_len:
        result.append(verse[vi])
        collected += contrib[vi]
        vi += 1
    
    # Walk forward to include trailing diacritics/alefs
    while vi < len(verse):
        if contrib[vi] > 0:
            break
        if verse[vi] in " \t\n\r":
            break
        result.append(verse[vi])
        vi += 1
    
    fragment = "".join(result)
    
    # Verify: if normalized output doesn't match expected, try ±2 offset
    expected_norm = normalized_verse[norm_idx:norm_idx + norm_len]
    if norm_func(fragment) != expected_norm:
        for offset in [1, -1, 2, -2]:
            adj_start = start_vi + offset
            if adj_start < 0 or adj_start >= len(verse):
                continue
            # Recollect from adjusted position
            adj_result = [verse[adj_start]]
            vi2 = adj_start + 1
            col2 = contrib[adj_start] if adj_start < len(contrib) else 0
            while vi2 < len(verse) and col2 < norm_len:
                adj_result.append(verse[vi2])
                col2 += contrib[vi2] if vi2 < len(contrib) else 0
                vi2 += 1
            adj_frag = "".join(adj_result)
            if norm_func(adj_frag) == expected_norm:
                return adj_frag
    
    return fragment

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
        r'\s*\(\[\[(\d{3})\s+[^#\]]+#(\d+)\|[^\]]+\]\]\)'
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
        
        hint = citation_hint(text_clean, new_content, adj_start, adj_end)
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
            # In a commentary a very short fragment is usually the next words
            # of the verse already under discussion.
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
        match = re.search(r'(?<![*﴿])([«“"])([^»”"\n]{1,40})\s*$', line)
        if not match:
            continue
        fragment = match.group(2).strip()
        if len(fragment) < 2 or len(fragment.split()) > 4:
            continue
        before = "\n".join(lines[:index]) + "\n" + line[:match.start()]
        prior = None
        for found in re.finditer(
            r'\*﴿[^﴾]+﴾\{\.quran-quote\}\*\s*'
            r'\(\[\[(\d{3})\s+[^#\]]+#(\d+)\|', before):
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


def add_missing_refs(content: str) -> tuple[str, int]:
    """Add wikilinks to *LF...LE{quran-quote}* quotes that lack them.
    
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

    def _end_offset(s, v, norm):
        vn = normalize_arabic(load_verse(s, v) or "")
        i = vn.find(norm)
        return (i + len(norm)) if i >= 0 else 0

    for m in pattern.finditer(new_content):
        parts.append(new_content[pos:m.start()])
        pos = m.end()
        full_match = m.group(1)
        end = m.end()
        keep = new_content[m.start():end]
        after = new_content[end:end+30].lstrip()
        if re.search(r'\[\[\d', after[:12]):
            lm = re.match(r'\[\[(\d{3})[^#]*#(\d+)', after)
            if lm:
                ls, lv = int(lm.group(1)), int(lm.group(2))
                lt = full_match[full_match.index(LF)+1:full_match.index(LE)]
                _bump(ls, lv, _end_offset(ls, lv, normalize_arabic(lt)))
            parts.append(keep); continue

        text = full_match[full_match.index(LF)+1:full_match.index(LE)]
        text_clean = re.sub(r'\s*\.\s*', ' ', text).strip()
        text_clean = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', text_clean).strip()
        hint = citation_hint(text_clean, new_content, m.start(), m.end())
        if hint:
            hint_s, hint_v, hint_end = hint
            wikilink = build_wikilink(hint_s, hint_v, end_verse=hint_end)
            parts.append(keep + wikilink)
            _bump(hint_s, hint_v, _end_offset(hint_s, hint_v, normalize_arabic(text_clean)))
            added += 1
            continue
        if normalize_arabic(text_clean) in BLACKLISTED_PHRASES:
            parts.append(keep); continue
        if re.match(r'\s*[\[\(][^\]\)]*\d', after):
            parts.append(keep); continue

        norm = normalize_arabic(text_clean)
        fs, fv = _focus()
        # (a) The next quote is almost always the same words or the words right
        # after the verse currently under discussion — the dominant surah's
        # most recent verse — even if a stray reference intervened.
        if fs is not None:
            r = find_verse_after(norm, fs, fv, verse_off.get((fs, fv), 0))
            if r:
                v, off = r
                parts.append(keep + build_wikilink(fs, v))
                _bump(fs, v, off)
                added += 1
                continue

        results = find_verse_in_text(text_clean, hint_surah=fs, hint_verse=fv)
        verse_range = None
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
                _bump(segment_matches[-1][3], segment_matches[-1][4],
                      _end_offset(segment_matches[-1][3], segment_matches[-1][4], norm))
                continue

        matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
        if not matches:
            parts.append(keep); continue
        surah, verse_num, _, _ = matches[0]
        wikilink = (build_wikilink(surah, verse_num, end_verse=verse_range[1])
                    if verse_range else build_wikilink(surah, verse_num))
        parts.append(keep + wikilink)
        _bump(surah, verse_num, _end_offset(surah, verse_num, norm))
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
        if re.search(r'\[\[\d', after[:12]):
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
        if re.search(r'\[\[\d', after[:12]):
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


# ── Cross-page Qur'an quotes ────────────────────────────────────────────────

def _norm_char(c: str) -> str:
    """Per-character equivalent of normalize_arabic (for index mapping)."""
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


_PAGE_HEAD_RE = re.compile(
    r'^(?:[ \t]*\n'
    r'|#{1,6}[^\n]*\n'
    r'|[ \t]*[\u0660-\u0669\d]{1,4}[ \t]*[-\u2013\u2014]?[ \t]*(?:سورة[^\n]*)?\n)*'
)


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
        if not m:
            continue
        partial = m.group(2).strip().replace('{.quran-quote}', '').strip()
        pn = normalize_arabic(partial)
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
        vn = normalize_arabic(verse_text)
        idx = vn.find(pn)
        if idx < 0:
            continue
        rem_norm = vn[idx + len(pn):]
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
        blocks[i] = body[:m.start()] + render_quran_quote(partial, "begin", surah, verse)
        blocks[i + 1] = (nxt[:cont_start] + render_quran_quote(cont_raw, "end", surah, verse)
                         + rest)
        count += 1
    return '\n\n---\n\n'.join(blocks), count


def _normalize_eng_name(name: str) -> str:
    """Normalize an English/transliterated surah name for lookup.
    Strips diacritics (ḥ→h, ā→a), punctuation, spaces. Returns lowercase."""
    # Decompose combined characters, strip combining marks (diacritics)
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.category(c).startswith("M"))
    # Keep only letters and digits
    name = re.sub(r"[^a-z0-9]", "", name.lower())
    return name


def _build_surah_lookup() -> dict:
    """Build combined {normalized_name: surah_num} for English, Arabic, and numeric names.
    English names: from filenames and YAML aliases, normalized via _normalize_eng_name.
    Arabic names: from YAML aliases, normalized via normalize_arabic.
    Cached in module-level _SURAH_LOOKUP."""
    global _SURAH_LOOKUP
    if _SURAH_LOOKUP is not None:
        return _SURAH_LOOKUP
    
    lookup = {}
    for f in QURAN_DIR.glob("*.md"):
        try: sn = int(f.stem[:3])
        except: continue
        # English name from filename: "033 Al-Ahzab" → "Al-Ahzab"
        eng_name = f.stem[4:]
        lookup[_normalize_eng_name(eng_name)] = sn
        # Also "Al Ahzab" without hyphen
        no_hyphen = eng_name.replace("-", " ")
        lookup[_normalize_eng_name(no_hyphen)] = sn
        
        # Parse YAML frontmatter for aliases
        text = f.read_text(encoding="utf-8")
        if text.startswith("---"):
            end = text.find("---", 3)
            yaml_text = text[3:end] if end > 0 else ""
            for line in yaml_text.split("\n"):
                line = line.strip()
                if line.startswith("- "):
                    alias = line[2:].strip().strip('"').strip("'")
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
                        lookup[_normalize_eng_name(alias)] = sn
        # Numeric name: "33"
        lookup[str(sn)] = sn
        lookup[f"{sn:03d}"] = sn
    
    _SURAH_LOOKUP = lookup
    return lookup

_SURAH_LOOKUP = None


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
    has_colon_after_first = (
        len(values) > 1
        and ':' in inner_w[nums[0].end():nums[1].start()]
    )
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
        if ':' in sep:
            return (v1, remaining[0], remaining[1] if len(remaining) > 1 else None)
        # Bare number list with no surah name ("33، 34") — ambiguous (could be
        # verses 33-34 or surah 33 verse 34); don't guess.
        return None
    
    # Strip punctuation and delimiters to isolate surah name/number
    surah_clean = re.sub(r'[:\-–—،,]+', ' ', surah_part).strip()
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


def _span_text(span: str) -> str:
    """Text between the ornate parentheses of a *LF...LE* span."""
    m = re.search(r'\uFD3F([^\uFD3E]*)\uFD3E', span)
    return m.group(1) if m else span


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
        
        # Skip if already has a wikilink
        if re.search(r'\[\[\d', after.lstrip()[:12]):
            continue
        
        # Extract citation text — find the parenthesized/bracketed reference
        cm = re.match(r'\s*([\[\(][^\]\)\n]+[\]\)])', after)
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


def citation_hint(text: str, content: str, start: int, end: int) -> tuple[int, int, int | None] | None:
    """A verified citation adjacent to a quote, used as a first search hint.

    The source citation is never trusted on its own: the quoted text must be
    found in the named verse (or range). If verification fails, callers fall
    back to ordinary text matching.
    """
    lookup = _build_surah_lookup()
    candidates: list[str] = []
    after = content[end:end + 100]
    match = re.match(r'\s*([\[\(][^\]\)\n]+[\]\)])', after)
    if match:
        candidates.append(match.group(1))
    before = content[max(0, start - 100):start]
    match = re.search(r'([\[\(][^\]\)\n]+[\]\)])\s*$', before)
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


def strip_gemini_refs(content: str) -> tuple[str, int]:
    """Discard Gemini's own verse citations after quote spans.

    The pipeline locates every verse itself (add_missing_refs), so Gemini's
    citations — inconsistent in format and ~17% wrong — are removed rather than
    trusted. Only reference-looking parentheticals are removed, so ordinary
    commentary is left alone. Returns (new_content, stripped_count)."""
    LF, LE = '\ufd3f', '\ufd3e'
    quote_end = re.compile(r'\*?' + LF + r'[^' + LE + LF + r']*' + LE + r'\{\.quran-quote\}\*')
    lk = _build_surah_lookup()
    stripped = 0
    new_content = content
    for qm in reversed(list(quote_end.finditer(new_content))):
        end = qm.end()
        after = new_content[end:end + 60]
        if re.search(r'\[\[\d', after.lstrip()[:12]):
            continue  # already linked
        cm = re.match(r'\s*([\[\(][^\]\)\n]+[\]\)])', after)
        if not cm:
            continue
        citation = cm.group(1)
        inner = citation.strip('[]()').strip()
        looks_ref = (re.search(r'[\d\u0660-\u0669]', inner)
                     or inner.startswith('سورة')
                     or _normalize_surah_name(inner) in lk)
        if not looks_ref:
            continue
        leading = len(after) - len(after.lstrip())
        new_content = new_content[:end] + new_content[end + leading + len(citation):]
        stripped += 1
    return new_content, stripped


def strip_false_quran(content: str) -> tuple[str, int]:
    """Convert *LF...LE{quran-quote}* that have no wikilink back to (text).
    Run this AFTER add_missing_refs and convert_gemini_refs."""
    LF = '\ufd3f'; LE = '\ufd3e'
    stripped = 0
    new_content = content
    
    # Match: *LF...LE{.quran-quote}* or LF...LE{.quran-quote}* (missing opening *)
    pattern = re.compile(
        r'\*?' + LF + r'([^' + LE + LF + r']+)' + LE + r'\{\.quran-quote\}\*'
    )
    
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
        if re.search(r'\[\[\d', after[:12]):
            continue  # has wikilink — keep it
        stripped += 1
        new_content = new_content[:m.start()] + f'({text})' + new_content[end:]
    
    return new_content, stripped
    """Fix all [[NNN SurahName#N|ref]] wikilinks to match actual sura filenames.
    
    Returns (new_content, fixed_count)."""
    # Pattern: [[NNN anything#N(-N)|display]] — handles verse ranges like 26-27
    pattern = re.compile(r'\[\[(\d{3})\s+([^#\]]+)#(\d+(?:-\d+)?)\|([^\]]+)\]\]')
    
    fixed = 0
    new_content = content
    
    for m in reversed(list(pattern.finditer(content))):
        surah_num = int(m.group(1))
        verse_part = m.group(3)  # may be "26" or "26-27"
        display = m.group(4)
        
        # Get actual filename
        stem, _ = get_surah_name(surah_num)
        
        correct = f"[[{stem}#{verse_part}|{display}]]"
        current = m.group(0)
        
        if current != correct:
            new_content = new_content[:m.start()] + correct + new_content[m.end():]
            fixed += 1
    
    return new_content, fixed


if __name__ == "__main__":
    import sys
    from datetime import datetime
    from _timestamp import stamped
    if len(sys.argv) < 2:
        print("Usage: python3 quran_tashkil.py <file.md> [--dry] [--marker]")
        print("  --marker  Only process quotes wrapped in ((...))")
        sys.exit(1)
    
    filepath = sys.argv[1]
    dry_run = "--dry" in sys.argv
    marker_mode = "--marker" in sys.argv
    content = Path(filepath).read_text(encoding="utf-8")

    content, _cross = fix_cross_page_quotes(content)
    if _cross:
        print(f"  Cross-page quotes: {_cross}", flush=True)

    import time
    print(f"Source: {Path(filepath).name}", flush=True)
    
    t_start = time.time()
    
    if marker_mode:
        LF = '\ufd3f'; LE = '\ufd3e'
        found = 0
        for m in reversed(list(re.finditer(r'\(\((.+?)\)\)', content))):
            text = m.group(1).strip()
            text = re.sub(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', '', text).strip()
            results = find_verse_in_text(text)
            matches = [(s, v, t, sc) for s, v, t, sc in results if sc > 0.7]
            if not matches: continue
            s, v, _, _ = matches[0]
            frag = get_tashkil_fragment(text, s, v)
            if not frag: continue
            wl = build_wikilink(s, v)
            replacement = render_quran_quote(frag, "full", s, v)
            content = content[:m.start()] + replacement + content[m.end():]
            found += 1
            print(f"  ({s}:{v}) {text[:60]}", flush=True)
        out = stamped(Path(filepath), "marked")
        out.write_text(content, encoding="utf-8")
        print(f"Marked: {found}, Saved: {out.name} ({time.time()-t_start:.1f}s)", flush=True)
        sys.exit(0)
    
    # Step 1: Discover and mark unmarked quotes
    t0 = time.time()
    print(f"Step 1: Discovering unmarked quotes...", flush=True, end=" ")
    # Fast path: if 50+ quotes already have wikilinks, skip bare paren scanning
    existing_linked = len(re.findall(r'\{\.quran-quote\}\*\s*\(\[\[', content))
    content, discovered = discover_and_mark_quotes(content)
    print(f"{len(discovered)} found ({time.time()-t0:.1f}s)", flush=True)
    
    # Step 2: Add missing wikilinks
    t0 = time.time()
    print(f"Step 2: Adding missing refs...", flush=True, end=" ")
    content, refs_added = add_missing_refs(content)
    print(f"{refs_added} added ({time.time()-t0:.1f}s)", flush=True)
    
    # Step 3: Convert Gemini refs
    t0 = time.time()
    print(f"Step 3: Converting Gemini refs...", flush=True, end=" ")
    content, gemini_converted = convert_gemini_refs(content)
    print(f"{gemini_converted} converted ({time.time()-t0:.1f}s)", flush=True)
    
    # Step 4: Fix wikilinks
    t0 = time.time()
    print(f"Step 4: Fixing wikilinks...", flush=True, end=" ")
    content, links_fixed = fix_wikilinks(content)
    print(f"{links_fixed} fixed ({time.time()-t0:.1f}s)", flush=True)
    
    # Step 5: Strip false Qur'an
    t0 = time.time()
    print(f"Step 5: Stripping false Qur'an...", flush=True, end=" ")
    content, stripped = strip_false_quran(content)
    print(f"{stripped} stripped ({time.time()-t0:.1f}s)", flush=True)
    
    content = content.replace('\uFD3F\uFD3F', '\uFD3F')
    content = content.replace('\uFD3E\uFD3E', '\uFD3E')
    # Strip ( before *LF and ) after LE*
    LF = '\ufd3f'; LE = '\ufd3e'
    content = re.sub(r'\(\s*(\*' + LF + r'[^' + LE + r']*' + LE + r'\{\.quran-quote\}\*)\s*\)', r'\1', content)
    # Collapse double asterisks
    content = re.sub(r'\*\{\.quran-quote\}\*\*', r'*{.quran-quote}*', content)
    
    # Step 6: Update tashkīl
    t0 = time.time()
    print(f"Step 6: Updating tashkīl...", flush=True, end=" ")
    updated = 0
    LF = '\ufd3f'; LE = '\ufd3e'
    pattern = re.compile(
        r'(\*' + LF + r')([^' + LE + r']+)(' + LE + r'\{\.quran-quote\}\*\s*'
        r'\(\[\[(\d{3})\s+[^#\]]+#(\d+)\|[^\]]+\]\]\))'
    )
    total_quotes = 0
    for m in reversed(list(pattern.finditer(content))):
        total_quotes += 1
        prefix = m.group(1)
        old_text = m.group(2).strip()
        suffix = m.group(3)
        surah = int(m.group(4))
        verse_num = int(m.group(5))
        
        # Skip if already has tashkīl (contains diacritics)
        if any('\u064B' <= c <= '\u0652' for c in old_text):
            continue
        
        fragment = get_tashkil_fragment(old_text, surah, verse_num)
        if fragment and fragment != old_text:
            # Re-append الآية if original had it
            aya_match = re.search(r'\s*[-–—]?\s*ال?[اآ]?ية\s*$', old_text)
            if aya_match:
                fragment = fragment + aya_match.group(0)
            content = content[:m.start()] + prefix + fragment + suffix + content[m.end():]
            updated += 1
        if total_quotes % 25 == 0:
            print(f"\n    ... {total_quotes} quotes checked, {updated} updated", flush=True, end="")
    print(f" {updated} updated, {total_quotes} checked ({time.time()-t0:.1f}s)", flush=True)
    
    markers = len(re.findall(r'\{\.quran-quote\}', content))
    print(f"Total markers: {markers}", flush=True)
    
    if not dry_run:
        out = stamped(Path(filepath), "processed")
        out.write_text(content, encoding="utf-8")
        print(f"Saved: {out.name} ({time.time()-t_start:.1f}s total)", flush=True)
