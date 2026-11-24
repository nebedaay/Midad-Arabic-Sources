"""Display and clean-up of Qur'ān citation links — no discovery.

This module answers two questions: what does this link look like, and is this
leftover markup? It never searches the muṣḥaf, so a change here cannot turn up
a new citation — it only re-letters the ones a work already has. That is the
distinction a render schedule needs: a work known to contain no Qur'ān
references can ignore a change to this file, while a change to `quran.py`,
where discovery lives, is treated as possibly finding new ones.

Nothing here imports `quran`; the module is a leaf, so `quran` imports *from*
it without a cycle and every existing caller keeps working through `quran`.
"""

import re


#: A marker's alias: `:`/`:12` today, and the older `22:5`/`22:3–22:4`.
#: The legacy form has to be recognised while a note still carries it, or
#: the display normaliser strips the alias as if it were a citation and the
#: marker can no longer be stripped when the note is re-rendered.
_MARKER_DISPLAY = re.compile(
    r"^(?::[0-9]*(?:[\u2013\u2014-][0-9]+)?"
    r"|[0-9]+:[0-9]+(?:[\u2013\u2014-][0-9]+:[0-9]+)?)$")


_MARKER_AT = re.compile(
    r"(\*{0,2}\[\[((?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+)\|:[0-9]*\]\]\*{0,2}\ufeff?)")


_RANGE_ALIAS = re.compile(r"^[\u2013\u2014-]?([0-9\u0660-\u0669]{1,3})$")


_TO_WESTERN = str.maketrans("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669",
                            "0123456789")


_LINK_ANY = re.compile(
    r"[ \t]*(\(?)(\[\[(?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+(?:\|[^\]]*)?\]\])(\)?)")


_VERSE_HEADING_LINE = re.compile(r"(?m)^#\s+[0-9\u0660-\u0669]+\s*$")


def fix_wikilinks(content: str) -> tuple[str, int]:
    """Rewrite a citation link to its bare form, keeping a range alias.

    An older note carries `[[024 An-Nur#10|النور : ١٠]]`; the plugin supplies the
    display now, so the alias goes. Two things survive: a verse *marker*'s
    `S:V` display (it is what the margin shows) and a range's second number,
    which travels as the alias (`[[Q024#10|12]]`).
    """
    pattern = re.compile(r'\[\[([^#\]\n]+)#(\d+(?:-\d+)?)\|([^\]\n]+)\]\]')
    fixed = 0

    def repl(m: re.Match) -> str:
        nonlocal fixed
        stem, verse_part, display = m.group(1), m.group(2), m.group(3)
        if _MARKER_DISPLAY.match(display):
            return m.group(0)
        start, _, end = verse_part.partition("-")
        # A bare number in the alias is a range's second verse, not display
        # text: it is the one value a range has to keep.
        span = _RANGE_ALIAS.match(display.strip())
        if span:
            kept = f"[[{stem}#{start}|{span.group(1).translate(_TO_WESTERN)}]]"
            if kept != m.group(0):
                fixed += 1
            return kept
        fixed += 1
        return f"[[{stem}#{start}|{end}]]" if end else f"[[{stem}#{start}]]"

    return pattern.sub(repl, content), fixed


def strip_redundant_raw_citations(content: str) -> tuple[str, int]:
    """Remove a source citation still sitting after our own quote link."""
    pattern = re.compile(
        r'(\*[^*\n]*\{\.quran-quote\}\*\s*'
        r'\(?\[\[[^\]]+\]\](?:[\u2013-]\[\[[^\]]+\]\])?\)?)'
        r'\s*([\[\(][^\[\]\(\)\n]*[\d\u0660-\u0669][^\[\]\(\)\n]*[\]\)])'
    )
    stripped = 0
    while True:
        content, count = pattern.subn(r'\1', content)
        stripped += count
        if not count:
            break
    return content, stripped


def normalize_quran_link_display(content: str) -> tuple[str, int]:
    """Bring every citation link to the bare single form.

    The display text is the plugin's job now, so a citation's baked alias is
    removed and the literal parentheses around it go too (the plugin prints its
    own brackets; leaving the source's would show them twice). A two-link range
    collapses to one link carrying its second number — `[[Q024#10|12]]` — which
    is the one thing a range genuinely has to keep. A verse marker's `S:V`
    display is the exception throughout: it is Latin digits on every page, in
    every riwāya, and stays as written.
    """
    changed = 0

    # A link written before the sūra notes were renamed — `[[004 An-Nisa#29]]`
    # — points at a file that no longer exists, so Obsidian draws it as an
    # unresolved link. The number in its name is the sūra; the canonical note
    # is `Q004`, and the plugin paints its display text from there.
    legacy = re.compile(r"\[\[(\d{3})\s+[^#\]\n]+#")

    def canonical(match: re.Match) -> str:
        nonlocal changed
        surah = int(match.group(1))
        if not (1 <= surah <= 114):
            return match.group(0)
        changed += 1
        return f"[[Q{surah:03d}#"

    content = legacy.sub(canonical, content)

    # Two links to the same verse in a row are one citation: the source's own
    # reference converted to a link beside the one the pipeline added, or a note
    # rendered twice. The first is kept — it may carry a range's second verse —
    # and the second goes, with the punctuation that separated them.
    doubled = re.compile(
        r"(\[\[([^\]|#]+#[^\]|]+)(?:\|[^\]]*)?\]\])"
        r"[ \t]*(?:[,;]?[ \t]*)?"
        r"\[\[\2(?:\|[^\]]*)?\]\]")

    def collapse(match: re.Match) -> str:
        nonlocal changed
        changed += 1
        return match.group(1)

    content = doubled.sub(collapse, content)

    # A range written as two links, with or without wrapping parentheses. The
    # first member's alias may already be gone (an earlier pass strips it), so
    # it is optional here; the second number is what has to survive.
    pair = re.compile(
        r"\(?\[\[([^#\]\n]+)#(\d+)(?:\|[^\]\n]+)?\]\]"
        r"[\u2013\u2014-]"
        r"\[\[\1#(\d+)(?:\|[^\]\n]+)?\]\]\)?"
    )

    def join_range(m: re.Match) -> str:
        nonlocal changed
        changed += 1
        return f"[[{m.group(1)}#{m.group(2)}|{m.group(3)}]]"

    # A single link with an alias.
    single = re.compile(r"\[\[([^#\]\n]+)#(\d+(?:-\d+)?)\|([^\]\n]+)\]\]")

    def strip_alias(m: re.Match) -> str:
        nonlocal changed
        stem, verse_part, display = m.group(1), m.group(2), m.group(3)
        if _MARKER_DISPLAY.match(display):
            return m.group(0)
        start, _, end = verse_part.partition("-")
        # A bare number in the alias is the range's second verse, not display
        # text: `[[Q024#10|12]]` is the range 10–12.
        span = _RANGE_ALIAS.match(display.strip())
        if span:
            kept = f"[[{stem}#{start}|{span.group(1).translate(_TO_WESTERN)}]]"
            if kept != m.group(0):
                changed += 1
            return kept
        bare = f"[[{stem}#{start}|{end}]]" if end else f"[[{stem}#{start}]]"
        if bare != m.group(0):
            changed += 1
        return bare

    # Parentheses that serve only to enclose a citation.
    parens = re.compile(r"\(\[\[([^#\]\n]+)#(\d+(?:-\d+)?)(?:\|([^\]\n]+))?\]\]\)")

    def drop_parens(m: re.Match) -> str:
        nonlocal changed
        alias = m.group(3)
        if alias and _MARKER_DISPLAY.match(alias):
            return m.group(0)
        bare = f"[[{m.group(1)}#{m.group(2)}|{alias}]]" if alias else f"[[{m.group(1)}#{m.group(2)}]]"
        if bare != m.group(0):
            changed += 1
        return bare

    # Verse headings carry a `S:V` display that must stay as written.
    lines = content.split("\n")
    for index, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        line = pair.sub(join_range, line)
        line = single.sub(strip_alias, line)
        lines[index] = parens.sub(drop_parens, line)
    # Again, now that the source's parentheses and aliases are gone: the pair
    # `([[Q018#1|الكهف : ١]]) [[Q018#1]]` becomes two bare links only here.
    text = doubled.sub(collapse, "\n".join(lines))
    return text, changed


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
        r'(\(?\[\[[^\]]+\]\](?:[\u2013-]\[\[[^\]]+\]\])?\)?)?'
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


#: A quotation in a rendered note — either write order, `﴿…﴾` or `﴾…﴿` — and
#: the link that follows it.
_RUN_QUOTE = re.compile(
    r'([\ufd3f\ufd3e][^\ufd3f\ufd3e\n]*?[\ufd3f\ufd3e])'
    r'[ \t]*(?:\{\.[^}\n]*\}[ \t*]*)?'
    r'(\[\[(?:Q[A-Z]{0,2})?\d{3}#\d+(?:\|([^\]]*))?\]\])?')

_RUN_TARGET = re.compile(r"\[\[([^\]|]+)")


def dedupe_run_links(content: str) -> tuple[str, int]:
    """Cite a verse once per run of its quotations in a rendered note.

    A translation of a tafsīr glosses a verse word by word, and every gloss used
    to carry its own link. A run is consecutive quotations of the *same* verse:
    the first and the last keep their citation and the ones between lose it, so
    the reader is told once where the passage is and once where it ends — the
    same rule the Arabic commentary follows.

    A marker (`|:` or `|:12`) is the margin's reference, not a citation, and is
    left alone; a quotation inside a callout belongs to the apparatus
    (footnotes, poetry), not to the running commentary, and is skipped.
    """
    spans = []
    for match in _RUN_QUOTE.finditer(content):
        link = match.group(2)
        if not link:
            continue
        alias = match.group(3) or ""
        if alias.startswith(":"):
            continue
        start_of_line = content.rfind("\n", 0, match.start()) + 1
        if content[start_of_line:match.start()].lstrip().startswith(">"):
            continue
        target = _RUN_TARGET.match(link)
        if not target:
            continue
        spans.append((match, target.group(1)))

    edits: list[tuple[int, int, str]] = []
    index = 0
    while index < len(spans):
        target = spans[index][1]
        end = index
        while end + 1 < len(spans) and spans[end + 1][1] == target:
            # A run is one passage: a blank line ends it. Without this bound a
            # verse quoted again a page later would lose its citation, which is
            # the reader's only way back to it.
            gap = content[spans[end][0].end():spans[end + 1][0].start()]
            if "\n\n" in gap or "\n\r\n" in gap:
                break
            end += 1
        for middle in range(index + 1, end):
            match = spans[middle][0]
            # Take the space in front of the link with it, or the quotation is
            # left with a gap before its punctuation (`﴿ , from Allāh`).
            start = match.start(2)
            while start > 0 and content[start - 1] in " \t":
                start -= 1
            edits.append((start, match.end(2), ""))
        index = end + 1
    for start, end, replacement in sorted(edits, key=lambda edit: edit[0], reverse=True):
        content = content[:start] + replacement + content[end:]
    return content, len(edits)


def strip_orphan_quote_classes(content: str) -> str:
    """Delete `{.quran-quote}` markers that are not the class of an italic span."""
    return re.sub(r'\{\.quran-quote\}(?!\*)', '', content)


def strip_inline_verse_links(content: str, *, headings: bool = False) -> tuple[str, int]:
    """Drop the in-text citations a verse-heading note does not need.

    A tafsīr that heads every verse with `# 12` already says which verse is under
    discussion, so a `[[Q057#12]]` after every quoted fragment only repeats it in
    the line. The quotation keeps its ornate parentheses.

    A bold `**[[Q057#12|57:12]]**` marker is *not* removed: that is the marginal
    link, and a heading supplies only a verse number, not a reference. `headings`
    is for a caller that knows the rendered note carries per-verse headings even
    though the body it holds does not.
    """
    if not headings and len(_VERSE_HEADING_LINE.findall(content)) < 3:
        return content, 0
    dropped = 0

    def repl(m: re.Match) -> str:
        nonlocal dropped
        start, end = m.start(2), m.end(2)
        if "|:" in m.group(2):
            return m.group(0)   # a marginal marker, not a citation
        if "**" in content[max(0, start - 2):start] or "**" in content[end:end + 2]:
            return m.group(0)
        dropped += 1
        return ""

    return _LINK_ANY.sub(repl, content), dropped


def dedupe_verse_markers(content: str) -> tuple[str, int]:
    """Keep one marker per verse in a paragraph.

    The margin has one slot per rendered line, so two markers naming the same
    verse in one paragraph print the same reference twice beside it. Different
    verses keep their own markers — a long paragraph may genuinely start two.
    """
    dropped = 0
    out: list[str] = []
    for line in content.split("\n"):
        seen: set[str] = set()

        def repl(m: re.Match) -> str:
            nonlocal dropped
            key = m.group(2)
            if key in seen:
                dropped += 1
                return ""
            seen.add(key)
            return m.group(0)

        out.append(_MARKER_AT.sub(repl, line))
    return "\n".join(out), dropped


def is_marker_display(text: str) -> bool:
    """True when a link alias is a verse marker's `S:V` display, not a citation."""
    return bool(_MARKER_DISPLAY.match((text or "").strip()))


def balance_ornate_parens(content: str) -> tuple[str, int]:
    """Drop ornate parentheses that have no partner.

    A transcription that breaks a quotation over a page can leave a stray `﴾`
    behind, and a multi-verse span sometimes loses its opener. Neither is text:
    the brackets are notation, so an unpaired one is debris and is removed. An
    opener still unclosed at the end of the note is closed instead — a quotation
    that was never closed is still a quotation, and the mark is the evidence.
    """
    if "﴿" not in content and "﴾" not in content:
        return content, 0
    # A translation writes the pair the other way round (`﴾quote﴿`), because the
    # marks are mirrored in a left-to-right line. Balancing by the Arabic
    # convention would delete every mark that note has and append one closer per
    # surviving opener at the end of the note — which is where the long run came
    # from. Nothing in such a note is unpaired in the sense this function means.
    first_open = content.find("﴿")
    first_close = content.find("﴾")
    latin = len(re.findall(r"[A-Za-z]", content))
    arabic = len(re.findall(r"[\u0600-\u06FF]", content))
    if (latin > arabic and first_close >= 0
            and (first_open < 0 or first_close < first_open)):
        return content, 0
    # No space sits between the last word and the closing mark: the inside of
    # `﴿…﴾` is canonical text, and a trailing space there is the model's, not
    # the muṣḥaf's. Normalising it here is also what lets a first render and a
    # re-render agree byte for byte.
    content = re.sub(r"[ \t]+(﴾)", r"\1", content)
    out: list[str] = []
    depth = 0
    fixed = 0
    for char in content:
        if char == "﴿":
            depth += 1
            out.append(char)
        elif char == "﴾":
            if depth == 0:
                fixed += 1
                continue
            depth -= 1
            out.append(char)
        else:
            out.append(char)
    if depth:
        out.append("﴾" * depth)
        fixed += depth
    return "".join(out), fixed
