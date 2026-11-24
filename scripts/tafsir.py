"""The tafsīr rules — the corpus-wide ones, independent of where a text came from.

A tafsīr is a commentary that moves through the muṣḥaf: quotations are matched
word by word, a quotation carries the canonical text, punctuation ends it and a
gloss interrupts it, and the margin numbers the verses in order. None of that is
specific to a scanned PDF, a repository or a Turath book; the importers only
normalise their own source structure and then call in here.
"""
from __future__ import annotations

import re
import unicodedata

import quran
from quran import (
    _DAMAGED_MARKER,
    _EMPTY_VERSE_HEADING,
    _VERSE_HEADING,
    _VERSE_MARKER,
    _VERSE_QUOTE_REF,
    _surah_continues,
    _verse_marker,
    add_missing_refs,
    get_surah_name,
    link_open_fragments,
    mark_short_fragments,
    dedupe_verse_markers,
    is_marker_display,
    strip_inline_verse_links,
    normalize_quran_link_display,
    strip_false_quran,
    strip_orphan_quote_classes,
    strip_raw_quran_citations,
    strip_redundant_raw_citations,
)

def _prepare_lines(content: str) -> list[str]:
    """Legacy headings become inline markers, and old markers are dropped.

    A ``#####`` block heading split the paragraph it was placed in, so the two
    halves are rejoined and the marker is left inside the sentence where the
    verse actually changes. Markers from a previous run are removed: they are
    re-derived from the links every time.
    """
    lines = content.split("\n")
    rejoined: list[str] = []
    in_fence = False
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            rejoined.append(lines[i])
            i += 1
            continue
        heading = None if in_fence else _VERSE_HEADING.match(stripped)
        empty = None if in_fence else _EMPTY_VERSE_HEADING.match(stripped)
        if heading or empty:
            marker = "**" + stripped[5:].strip() + "**" if heading else ""
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines):
                # The heading was inserted mid-paragraph, so the break it made
                # is removed: the marker goes between the two halves, and the
                # paragraph is rejoined. Only a heading after a callout, page
                # rule, or another heading cannot be joined backwards.
                previous = ""
                for line in reversed(rejoined):
                    if line.strip():
                        previous = line.strip()
                        break
                joinable = bool(previous) and not previous.startswith((">", "#")) and previous != "---"
                if joinable:
                    while rejoined and not rejoined[-1].strip():
                        rejoined.pop()
                    rejoined[-1] = rejoined[-1].rstrip() + " " + marker + lines[j].lstrip()
                else:
                    lines[j] = marker + lines[j]
                    rejoined.append(lines[j])
                i = j + 1
                continue
            i += 1
            continue
        rejoined.append(lines[i])
        i += 1
    lines = rejoined

    # A marker the old raw-citation pass broke (`**\[]`) is debris too.
    return [_DAMAGED_MARKER.sub("", _VERSE_MARKER.sub("", line)) for line in lines]


def _collect_verse_quotes(lines: list[str], focus_surah: int, linear: bool
                          ) -> list[tuple[int, int, int, int, int]]:
    """The quoted verses, in document order, restricted to the focus sūra.

    A quotation is a styled span followed by its citation; the span is what
    makes it a quotation, so a bare citation never numbers the margin.
    """
    quotes: list[tuple[int, int, int, int, int]] = []
    in_fence = False
    #: A `mas-quran` callout holds a quotation, so its body is read like any
    #: other paragraph. Any other callout (poetry, footnotes) and a plain block
    #: quote are not the pipeline's to number.
    in_quran_callout = False
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if stripped.startswith(">["):
            in_quran_callout = bool(re.match(r">\[![\w-]*quran", stripped))
            continue
        if stripped.startswith(">"):
            if not in_quran_callout:
                continue
        elif stripped.startswith(("|", "#")):
            continue
        else:
            in_quran_callout = False
        # A callout body carries a `> ` prefix that is not part of the
        # quotation; match against the body and put the offset back, or the
        # marker is written before the prefix and the quote loses its block.
        body = re.sub(r"^>\s?", "", line, count=1)
        offset_base = len(line) - len(body)
        for match in _VERSE_QUOTE_REF.finditer(body):
            surah = int(match.group(1))
            verse = int(match.group(2))
            # A range is either a digits-only alias on one link or two links
            # round a dash; both mean the same thing to the margin.
            end = int(match.group(3) or match.group(5) or verse)
            if quotes and quotes[-1][2:] == (surah, verse, end):
                continue
            quotes.append((index, match.start() + offset_base, surah, verse, end))

    if not focus_surah:
        return quotes
    # The file's own sūra is the default; a different sūra that the text keeps
    # returning to wins, since a file name does not always match the passage a
    # work actually discusses.
    per_surah: dict[int, int] = {}
    for _index, _offset, quote_surah, _quote_verse, _quote_end in quotes:
        per_surah[quote_surah] = per_surah.get(quote_surah, 0) + 1
    dominant = max(per_surah, key=per_surah.get) if per_surah else 0
    named = per_surah.get(focus_surah, 0)
    order: list[int] = []
    for _index, _offset, quote_surah, quote_verse, _quote_end in quotes:
        if quote_surah == dominant and quote_verse not in order:
            order.append(quote_verse)
    sequential = (len(order) >= 2
                  and all(b >= a for a, b in zip(order, order[1:])))
    if linear:
        # A tafsīr's markers are a linear guide to its own sūra: no other sūra
        # is ever numbered, however often it is quoted.
        focus = focus_surah
    elif (dominant and dominant != focus_surah and sequential
            and per_surah[dominant] >= 3 and per_surah[dominant] > named):
        focus = dominant
    else:
        focus = focus_surah
    return [q for q in quotes if q[2] == focus]


def _place_verse_markers(quotes: list[tuple[int, int, int, int, int]],
                         linear: bool,
                         start_current: tuple[int, int] | None) -> list[int]:
    """Where the passage moves: 1 for the verse the commentary turns to now.

    A tafsīr works forward. A short step is the next verse; a longer jump is
    genuine unless the text soon returns near where it was — that is a
    digression, a cross-reference, and it must not move the margin. A new
    passage may also start at a lower verse, after a long detour.
    """
    kinds = [0] * len(quotes)
    # Keyed by (sūra, verse): a block never changes sūra, so a bare verse was
    # enough there — but a *volume* does, and `verse 1` of the next sūra was
    # then already "numbered" by the first sūra's verse 1. That single detail
    # is why sūras 24–29 of a transcribed tafsīr had no margin at all.
    numbered: set[tuple[int, int]] = set()
    current = start_current if linear else None
    for i, (_line_index, _offset, surah, verse, end) in enumerate(quotes):
        if current is None:
            moved = True
        elif linear:
            if surah != current[0]:
                # A quotation from another sūra opens a new passage only when the
                # commentary settles there: the very next quotation, and more
                # after it, are from that sūra. A lone citation — or a cluster of
                # cross-references — is not a new focal sūra and does not move the
                # margin.
                moved = (i + 1 < len(quotes) and quotes[i + 1][2] == surah
                         and sum(1 for q in quotes[i + 1:i + 5] if q[2] == surah) >= 2)
            else:
                delta = verse - current[1]
                if 1 <= delta <= 3:
                    moved = True
                elif -3 <= delta <= 0:
                    # The passage being discussed, quoted again a verse or two
                    # back: not a new verse, and not a shift of the margin.
                    moved = False
                else:
                    returns = any(
                        later_s == surah
                        and abs(later_v - current[1]) <= 3
                        for _li, _off, later_s, later_v, _le in quotes[i + 1:i + 7]
                    )
                    moved = not returns
        else:
            current_surah, current_verse = current
            if surah == current_surah and 1 <= verse - current_verse <= 3:
                # The discussion runs forwards; a verse or two may be skipped.
                # A bigger forward jump is a passing cross-reference.
                moved = True
            elif verse <= 10 and surah > current_surah and _surah_continues(
                    quotes, i + 1, surah, 6, 3):
                moved = True
            else:
                # Earlier verse or another sūra: a passing cross-reference.
                moved = False
        if moved and any((surah, v) in numbered for v in range(verse, end + 1)):
            # The commentary returns to a verse it has already taken up: the
            # margin has its marker, so repeat citations are not numbered.
            moved = False
        if moved:
            kinds[i] = 1
            numbered.update((surah, v) for v in range(verse, end + 1))
            current = (surah, end)
    return kinds


def _choose_verse_markers(quotes: list[tuple[int, int, int, int, int]],
                          linear: bool,
                          start_current: tuple[int, int] | None,
                          focus_surah: int = 0) -> list[int]:
    """Number the passage, then give every remaining verse one marker.

    A verse the commentary cites but never takes up in order still belongs in
    the margin — otherwise the reader cannot find it at all — so its first
    mention is numbered. That marker does not move the passage: a lone
    cross-reference is not the start of a discussion.
    """
    kinds = _place_verse_markers(quotes, linear, start_current)
    numbered: set[tuple[int, int]] = set()
    for i, kind in enumerate(kinds):
        if kind:
            numbered.update((quotes[i][2], v) for v in range(quotes[i][3], quotes[i][4] + 1))
    # A one-off verse is numbered only in the sūra the commentary is actually
    # discussing. A passing citation of another sūra is a cross-reference: it
    # gets no marginal link, however often it is quoted.
    focal = focus_surah or (quotes[0][2] if quotes else 0)
    for i, (_line_index, _offset, surah, verse, end) in enumerate(quotes):
        if kinds[i] == 1:
            focal = surah
            continue
        if kinds[i] or any((surah, v) in numbered for v in range(verse, end + 1)):
            continue
        # A passing quotation of another sūra is a cross-reference and is not
        # numbered: the margin follows the passage. `focal` moves with the
        # passage (it is set by every marker `_place_verse_markers` chose), so a
        # volume that has moved on to the next sūra numbers that one's verses —
        # and a lone citation of a third sūra still gets nothing.
        if surah != focal:
            continue
        kinds[i] = 2
        numbered.update((surah, v) for v in range(verse, end + 1))
    return kinds


# How close two markers must be to risk landing on the same rendered line.
_MARKER_REACH = 75


def _rendered_gap(line: str, start: int, end: int) -> int:
    """Approximate how much rendered text separates two offsets.

    Diacritics take no horizontal space and the markers themselves are drawn in
    the margin, so the count is of the characters a reader sees between the two
    anchors.
    """
    if end <= start:
        return 0
    return sum(1 for ch in line[start:end]
               if not unicodedata.category(ch).startswith("Mn"))


def _merge_marker_group(items: list[tuple[int, str, bool]]) -> list[tuple[int, str, bool]]:
    """One marker for verses introduced together, or the first of them.

    A group is markers close enough to collide. They become a range marker —
    the link points at the first verse and the alias says where it ends — when
    they are the same sūra and within a couple of verses; otherwise the first
    keeps the place and the rest are dropped, because one margin slot can hold
    only one link.
    """
    if len(items) == 1:
        return items
    # A one-off cross-reference cannot share a margin slot with the passage's
    # own marker; the passage wins that slot.
    if not all(is_mark for _off, _text, is_mark in items):
        items = [item for item in items if item[2]][:1]
        if len(items) == 1:
            return items
    parsed = [re.match(r"\[\[([^#\]]+)#(\d+)\|:(\d*)", text)
              for _off, text, _is_mark in items]

    def ends_at(match) -> int:
        return int(match.group(3)) if match.group(3) else int(match.group(2))

    close = all(parsed) and all(
        int(parsed[k + 1].group(2)) - ends_at(parsed[k]) <= 3
        for k in range(len(parsed) - 1))
    if (close
            and len({p.group(1) for p in parsed}) == 1):
        # Group 1 is the *stem* (`Q023`), not a sūra number: the marker's target
        # names the file. `_verse_marker` builds the alias from the verses, so
        # the sūra argument is only kept for its signature.
        stem = parsed[0].group(1)
        surah_num = int(stem[-3:]) if stem[-3:].isdigit() else 0
        first_verse = int(parsed[0].group(2))
        last_verse = ends_at(parsed[-1])
        if last_verse > first_verse:
            return [(items[0][0],
                     _verse_marker(stem, surah_num, first_verse, last_verse),
                     True)]
    # Not a range (another sūra, or too far apart in verse numbers): they still
    # collide, so the stylesheet stacks them in the margin. Three is the depth
    # the gutter can hold without reaching the next line.
    return items[:3]


def _marker_groups(line: str,
                   items: list[tuple[int, str, bool]]
                   ) -> list[list[tuple[int, str, bool]]]:
    """Markers grouped by whether they can collide in the margin."""
    groups: list[list[tuple[int, str, bool]]] = []
    for entry in items:
        if groups and _rendered_gap(line, groups[-1][-1][0], entry[0]) <= _MARKER_REACH:
            groups[-1].append(entry)
        else:
            groups.append([entry])
    return [_merge_marker_group(group) for group in groups]


def _write_verse_markers(lines: list[str],
                         quotes: list[tuple[int, int, int, int, int]],
                         kinds: list[int], skip_leading: bool) -> tuple[str, int]:
    """Insert the markers from the end of each line backwards, so offsets hold."""
    marks: dict[int, list[tuple[int, str]]] = {}
    spares: dict[int, list[tuple[int, str]]] = {}
    stems: dict[int, str] = {}
    for kind, (line_index, offset, surah, verse, end) in zip(kinds, quotes):
        if not kind:
            continue
        if surah not in stems:
            stems[surah] = get_surah_name(surah)[0]
        marker = _verse_marker(stems[surah], surah, verse, end)
        (marks if kind == 1 else spares).setdefault(line_index, []).append(
            (offset, marker))

    inserted = 0
    out: list[str] = []
    for index, line in enumerate(lines):
        items = sorted(
            [(off, text, True) for off, text in marks.get(index, ())]
            + [(off, text, False) for off, text in spares.get(index, ())])
        if skip_leading and index == 0:
            # The template has already written the block's own marker at the
            # start of the body — which is that line.
            items = []
        else:
            # A marker is taken out of the text flow and put in the margin at
            # its own vertical position, so two markers only collide when their
            # anchors would land on the same *rendered* line — not merely in the
            # same paragraph. Nothing knows where the wrap falls, but anchors
            # within `_MARKER_REACH` rendered characters are close enough to
            # collide; farther apart they are separate links, which is what a
            # page of long paragraphs needs.
            items = [m for group in _marker_groups(line, items) for m in group]
        inserted += len(items)
        for offset, text, _is_mark in reversed(items):
            line = line[:offset] + text + line[offset:]
        out.append(line)
    return "\n".join(out), inserted


#: A quotation that opens on this page and continues on the next: the span
#: carries the processing class but no citation, because its citation is where
#: the quotation *ends*. The class is gone by the time the note is written, and
#: the half may already be wrapped in a callout, so only the unclosed `﴿` is
#: required — a line ending with an ornate *closer* cannot match, which is what
#: keeps this to a quotation that genuinely continues.
_OPEN_QUOTE_TAIL = re.compile(
    r"(?:>\s*)?\*?\ufd3f[^\ufd3e\n]*?\{\.quran-quote\}\*?[ \t]*$"
    r"|(?:>\s*)?\*?\ufd3f[^\ufd3e\n]*?[ \t]*$")


def insert_verse_headings_chapter(contents: list[str], skip_leading: bool = False,
                                  focus_surah: int = 0, linear: bool = False,
                                  start_current: tuple[int, int] | None = None
                                  ) -> tuple[list[str], int]:
    """Number the margin for a whole chapter written as several pages.

    A chapter is written one page at a time, but the passage it follows is not
    contained in a page: the cursor runs across the pages, and whether a verse
    is discussed in order is a fact about the chapter. The pages are therefore
    collected first and decided once.
    """
    prepared = [_prepare_lines(content or "") for content in contents]
    per_page = [_collect_verse_quotes(lines, focus_surah, linear)
                for lines in prepared]
    kinds = _choose_verse_markers([q for quotes in per_page for q in quotes],
                                  linear, start_current, focus_surah)
    out: list[str] = []
    inserted = 0
    at = 0
    for lines, quotes in zip(prepared, per_page):
        page, n = _write_verse_markers(
            lines, quotes, kinds[at:at + len(quotes)], skip_leading)
        out.append(page)
        inserted += n
        at += len(quotes)
    return out, inserted


#: A marginal marker, in the processing form written before the render.
_MARKER_TEXT = re.compile(r"\*{0,2}\[\[[^\]\n]*#\d+\|\s*:[0-9]*\s*\]\]\*{0,2}")


def relocate_cross_page_markers(text: str) -> tuple[str, int]:
    """Move a page-spanning quotation's marker to where the quotation opens.

    A quotation that crosses a page break is *cited* on the page where it ends,
    because that is where the citation is written. Its marker, though, is a
    guide to the verse being discussed, and that verse starts being discussed
    where the quotation opens — on the page before. A marker that begins a page
    whose previous page ends with an unclosed quotation is therefore carried
    back to that quotation; the citation is left where it is.
    """
    lines = text.split("\n")
    moved = 0
    for index, line in enumerate(lines):
        match = _MARKER_TEXT.search(line)
        if not match:
            continue
        # Walk up to the last content line of the page before, passing every
        # separator in between: a blank line, a page rule, a page heading — and
        # the callout headers a rendered page is made of, since a quotation that
        # spans a page is a `mas-quran` callout on each page. A page can carry
        # more than one rule (a transcription's own `#### p. N` arrives with a
        # rule of ours before it), which is why this skips a *run* of them
        # rather than stopping at the first.
        previous = index - 1
        crossed = False
        while previous >= 0:
            text_line = lines[previous].strip()
            if re.match(r"^---\s*$", text_line):
                crossed = True
                previous -= 1
                continue
            # A callout *header* opens the block that follows it, so it is part
            # of the page's furniture rather than its text; a callout *body* is
            # content and stops the walk.
            if not text_line or text_line.startswith("#") or re.match(r"^>\[!", text_line):
                previous -= 1
                continue
            break
        if not crossed or previous < 0:
            continue
        if not _OPEN_QUOTE_TAIL.search(lines[previous].strip()):
            continue
        opening = lines[previous].find("\ufd3f")
        if opening < 0:
            continue
        lines[index] = line[:match.start()] + line[match.end():]
        lines[previous] = (lines[previous][:opening] + match.group(0)
                           + lines[previous][opening:])
        moved += 1
    return "\n".join(lines), moved


def insert_verse_headings(content: str, skip_leading: bool = False,
                          focus_surah: int = 0,
                          linear: bool = False,
                          start_current: tuple[int, int] | None = None
                          ) -> tuple[str, int]:
    """Mark each newly introduced verse inline, at the point it is quoted.

    The marker is written inline as ``**[[004 An-Nisa#26|4:26]]**`` and the
    plugin moves it into the note's margin, so a verse may change mid-sentence
    without breaking the paragraph. A range gets a range marker.

    ``focus_surah`` is the sūra the file itself names; a quotation of another
    sūra is a cross-reference and gets no marker, so the margin numbers the
    commentary's own verses. With ``skip_leading`` a marker at the very start of
    the text is not written, because a corpus tafsīr's template has already put
    the block's own link there.
    """
    pages, inserted = insert_verse_headings_chapter(
        [content], skip_leading=skip_leading, focus_surah=focus_surah,
        linear=linear, start_current=start_current)
    marked, _moved = relocate_cross_page_markers(pages[0])
    return marked, inserted


def restore_quote_tashkil(content: str) -> tuple[str, int]:
    """Put the canonical tashkīl back inside a cited quotation.

    The words of a quotation are the muṣḥaf's; a transcription's vocalisation
    is the model's best guess. Where a quoted span and its citation are visible
    together, the span is replaced by the canonical fragment for its verse, so
    the note prints the text as the muṣḥaf has it and a later re-render is
    byte-identical.
    """
    LF, LE = '\ufd3f', '\ufd3e'
    pattern = re.compile(
        r'(\*' + LF + r')([^' + LE + LF + r'\n]+)(' + LE + r'\{\.quran-quote\}\*\s*'
        r'\(?\[\[Q?(\d{3})[^#\]]*#(\d+))'
    )
    updated = 0
    for m in reversed(list(pattern.finditer(content))):
        old_text = m.group(2).strip()
        fragment = quran.get_tashkil_fragment(old_text, int(m.group(4)), int(m.group(5)))
        if fragment and fragment != old_text:
            content = content[:m.start(2)] + fragment + content[m.end(2):]
            updated += 1
    return content, updated


def process_quran(content: str, *, mode: str = "default", surah: int = 0,
                  ayah: int = 0, delims: tuple[str, ...] = (),
                  discover: bool = False, raw_ocr: bool = False,
                  source_citations: bool = False,
                  skip_leading: bool = False,
                  start_current: tuple[int, int] | None = None
                  ) -> tuple[str, dict]:
    """The one Qur'ān sequence, whatever the text's origin.

    Every stage between "this is text" and "this is a note" runs here, in one
    order, for a scanned tafsīr, a repository tafsīr, a book and a translation
    alike. A genre supplies **inputs only**:

    - `mode` — `"tafsir"` when the work is a commentary (its quotations follow
      the verse under discussion, a verse is cited once per run, and the margin
      is numbered); `"default"` for every other work.
    - `surah` / `ayah` — the passage the text comments on, when it has one.
    - `delims` — the delimiters this particular text uses for a quotation
      (`detect_quote_delims`), because that is a fact about the source.
    - `discover` / `raw_ocr` — whether this is unreviewed OCR whose quotation
      markings must still be found, and whose own citations must be discarded.
    - `source_citations` — whether the source wrote its citations in a bracket
      syntax that was already normalised into links (`link_verse_citations`),
      in which case a mis-numbered one is corrected from its own words.

    Nothing here branches on which repository a text came from: a Turath or
    Shamela importer's only job is to hand its raw text to this function.
    """
    tafsir = mode == "tafsir"
    stats: dict[str, int] = {}

    content, n = quran.repair_damaged_links(content)
    stats["damaged_links"] = n
    content, n = quran.fix_cross_page_guillemets(content)
    stats["cross_page_guillemets"] = n

    # Define what counts as a quotation once: the vault's ornate spans plus
    # whatever delimiters this text actually uses. Marking a quotation and
    # citing it are separate questions, and in a tafsīr the citation is placed
    # by `add_missing_refs` below, once per verse run.
    content = quran.link_quote_citations(
        content, surah=surah, ayah=ayah, delims=delims, linear=tafsir,
        ornate=not tafsir)

    if discover or raw_ocr:
        # Finding quotations in unreviewed text is not idempotent — run on our
        # own output it keeps discovering "quotes" inside parentheses — so it is
        # off for a note that is already rendered, unless the reader asks.
        content, found = quran.discover_and_mark_quotes(content, tafsir=tafsir)
        stats["discovered"] = len(found)

    # A citation is the link alone: the brackets are the renderer's, so a literal
    # `([[Q022#5]])` prints them around the cartouche. Stripped before the
    # citation passes, which then see one link shape everywhere.
    content, n = quran.strip_citation_parentheses(content)
    stats["citation_parens"] = n

    # Add links before discarding the source's citations: a verified adjacent
    # citation is a cheap first search hint.
    # A transcription's citations are the OCR model's, not the author's, so they
    # only break a tie in the search; a repository's are the source's own.
    content, n = quran.add_missing_refs(
        content, hint_surah=surah, hint_verse=ayah,
        trust_citations=not (raw_ocr or discover))
    stats["refs_added"] = n
    # A quotation whose words also stand in the sūra the page names is cited
    # there: the heading is what the page is discussing.
    content, n = quran.realign_local_surah_links(content)
    stats["links_realigned"] = n
    # A short quotation whose words are the next words of the verse just cited
    # belongs to that verse: a commentary glosses a verse word by word, so the
    # citation follows the cursor rather than a whole-muṣḥaf search.
    content, n = quran.realign_continuation_links(content)
    stats["continuations"] = n

    if source_citations:
        # The source numbered a verse wrongly; the words are the evidence, so
        # the citation is corrected before anything is wrapped or numbered.
        content, fixes, _notes = quran.repair_citations(content)
        stats["citations_corrected"] = len(fixes)
        content = quran.wrap_cited_quotes(content)[0]

    # Two quotations with nothing between them are one quotation: the model
    # marks a continuous passage verse by verse, and the reader should see one
    # range citation and one range marker, not two of each. It runs here
    # because the proof is in the citations the halves now carry.
    content, n = quran.merge_adjacent_quotes(content)
    stats["merged_quotes"] = n

    if raw_ocr:
        content, n = quran.strip_gemini_refs(content)
        stats["gemini_refs"] = n

    content, n = quran.fix_wikilinks(content)
    stats["links_fixed"] = n
    content, n = quran.link_open_fragments(content, tafsir=tafsir)
    stats["open_fragments"] = n

    if tafsir:
        if raw_ocr or discover:
            # The short-fragment pass links bare parentheticals; on a rendered
            # note it would keep turning ordinary glosses into quotations.
            content, n = quran.mark_short_fragments(content)
            stats["short_fragments"] = n
    # A basmala standing alone is the sūra's opening formula, not a verse — the
    # muṣḥaf numbers it only in al-Fātiḥa. It is un-marked here, before the
    # false-quote pass, which would keep it for verifying as 1:1.
    content, n = quran.strip_bare_basmala(content)
    stats["bare_basmala"] = n

    # Un-mark before collapsing repeats: a quote whose citation is dropped as a
    # repeat is still a quotation, and must keep its ornate parentheses. The
    # strip asks "did this span resolve to a verse", which is a different
    # question from "does this citation survive the dedupe".
    content, n = quran.strip_false_quran(content)
    stats["false_quran"] = n

    # Canonical tashkīl is restored *before* any repeat is collapsed: the
    # restoration reads the citation that follows a quotation, so a link removed
    # first means the quotation keeps the model's guess forever. The order is
    # the difference between "most verses are canonical" and "the first verse of
    # each run is".
    content, n = restore_quote_tashkil(content)
    stats["tashkil"] = n

    if tafsir:
        content, n = keep_first_verse_link(content)
        stats["repeated_links"] = n


    content = content.replace('\uFD3F\uFD3F', '\uFD3F')
    content = content.replace('\uFD3E\uFD3E', '\uFD3E')
    content = quran.strip_orphan_quote_classes(content)
    content, n = quran.strip_raw_quran_citations(content)
    stats["raw_citations"] = n
    content, n = quran.strip_redundant_raw_citations(content)
    stats["redundant_citations"] = n
    content, n = quran.normalize_quran_link_display(content)
    stats["displays"] = n
    if tafsir:
        content, n = keep_first_verse_link(content)
        stats["repeats"] = n

    # An ornate paren with no partner is notation debris, not text.
    content, n = quran.balance_ornate_parens(content)
    stats["unbalanced_parens"] = n

    if tafsir:
        # A tafsīr moves through the muṣḥaf in order, across sūras as its volume
        # does, so the margin follows the passage rather than paragraph order.
        # `linear` is the tafsīr assumption, not a property of knowing the
        # sūra: a commentary moves through the muṣḥaf in order, and a
        # transcribed *volume* runs across sūras exactly as its pages do. The
        # non-linear rule is for a single block with no passage, so passing it
        # here left a 500-page volume with a margin marker on seven verses.
        content, n = insert_verse_headings(
            content, skip_leading=skip_leading, focus_surah=surah,
            linear=True, start_current=start_current)
        stats["markers"] = n
        content, n = quran.strip_inline_verse_links(content)
        stats["inline_links"] = n
        content, n = quran.dedupe_verse_markers(content)
        stats["duplicate_markers"] = n
    else:
        content, n = quran.dedupe_same_verse_links(content)
        stats["repeated_links"] = n
    return content, stats


def tafsir_passes(content: str, *, hint_surah: int = 0, hint_verse: int = 0,
                  skip_leading: bool = False,
                  start_current: tuple[int, int] | None = None) -> tuple[str, dict]:
    """The tafsīr rules, in one place.

    Kept as the named entry point for a corpus tafsīr: it is the shared
    sequence in `process_quran` with `mode="tafsir"`, so a scanned tafsīr and a
    repository tafsīr cannot drift apart.
    """
    return process_quran(
        content, mode="tafsir", surah=hint_surah, ayah=hint_verse,
        source_citations=True, skip_leading=skip_leading,
        start_current=start_current)


def _only_a_quotation_between(content: str, start: int, end: int) -> bool:
    """True when two citations are separated by nothing but a quotation.

    `﴿A﴾ [[Q24#10]] ﴿B﴾ [[Q24#10]]` is one run: the reader sees two quoted
    fragments of the same verse. `﴿A﴾ [[Q24#10]] … three lines of commentary …
    ﴿B﴾ [[Q24#10]]` is not — that is the commentary quoting the verse again, and
    each quotation keeps its own citation.
    """
    gap = re.sub(r"﴿[^﴿﴾\n]*﴾", "", content[start:end])
    return not re.search(r"[^\s\W\d_]", gap)


def keep_first_verse_link(content: str) -> tuple[str, int]:
    """Cite a verse once per run of quotations.

    The rule, as it has always been: a *string of quotations from one verse* is
    named once. Quote 24:10 three times in a row and the first carries the link;
    a different verse breaks the run, and when the commentary returns to 24:10
    it gets a citation again. It is not a global dedupe — that removed the
    reference from quotations that needed it.

    A citation is a link that follows a quotation, so the match is anchored on
    the ornate span. It is the citation *hit order* that defines the run, which
    is why commentary between two quotations of one verse does not break it.

    The margin is a separate rule: a verse is marked once in a note and never
    again, which `insert_verse_headings` enforces through its numbered set.
    """
    pattern = re.compile(
        # Either a whole span on this line, or only the closing half of one that
        # opened on the page before. A page-spanning quotation is written that
        # way, and the citation sits on the closing half — where the run rule
        # has to see it, or the same verse is cited twice in a row.
        r"(?:\ufd3f[^\ufd3e\n]{1,400}\ufd3e|[^\ufd3f\n]{0,400}\ufd3e)"
        r"(?:~)?(?:\{\.quran-quote\})?\*?"
        r"([ \t]*)\(?\[\[(?:Q[A-Z]{0,2})?(\d{3})[^#\]]*#(\d+)"
        r"(?:\|(\d*))?\]\]\)?"
    )
    edits: list[tuple[int, int]] = []
    #: `(surah, verse, range_end)`. A digits-only alias is a range's second
    #: verse; anything else (nothing, or a marker's `:`) is a single verse.
    #:
    #: Only a *single-verse* citation is identical to the single-verse citation
    #: before it, so only that pair collapses. A range is a different citation,
    #: and neither the range nor the citation that follows it is a repeat: the
    #: words, and the reference, are not the same ones.
    previous: tuple[int, int, int | None] | None = None
    for match in pattern.finditer(content):
        alias = match.group(4) or ""
        end = int(alias) if alias.isdigit() and alias else None
        target = (int(match.group(2)), int(match.group(3)), end)
        if target == previous and end is None:
            edits.append((match.start(1), match.end()))
        previous = target
    for start_at, end_at in reversed(edits):
        content = content[:start_at] + content[end_at:]
    return content, len(edits)


