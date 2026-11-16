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

    # A marker that starts its own paragraph is still holding a break the old
    # heading made. Join it back to the paragraph above, so the marker sits
    # inside the sentence where the verse actually changes.
    merged: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        marker = _VERSE_MARKER.match(stripped)
        if marker and merged:
            k = len(merged) - 1
            while k >= 0 and not merged[k].strip():
                k -= 1
            previous = merged[k].strip() if k >= 0 else ""
            joinable = bool(previous) and not previous.startswith((">", "#", "<")) and previous != "---"
            if joinable:
                del merged[k + 1:]
                merged[k] = (merged[k].rstrip() + " "
                             + stripped[:marker.end()] + stripped[marker.end():])
                continue
        merged.append(line)
    lines = merged
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
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence or stripped.startswith((">", "|", "#")):
            continue
        for match in _VERSE_QUOTE_REF.finditer(line):
            surah = int(match.group(1))
            verse = int(match.group(2))
            end = int(match.group(4)) if match.group(4) else verse
            if quotes and quotes[-1][2:] == (surah, verse, end):
                continue
            quotes.append((index, match.start(), surah, verse, end))

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
    numbered: set[int] = set()
    current = start_current if linear else None
    for i, (_line_index, _offset, surah, verse, end) in enumerate(quotes):
        if current is None:
            moved = True
        elif linear:
            if surah != current[0]:
                moved = False
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
        if moved and verse in numbered:
            # The commentary returns to a verse it has already taken up: the
            # margin has its marker, so repeat citations are not numbered.
            moved = False
        if moved:
            kinds[i] = 1
            numbered.update(range(verse, end + 1))
            current = (surah, end)
    return kinds


def _choose_verse_markers(quotes: list[tuple[int, int, int, int, int]],
                          linear: bool,
                          start_current: tuple[int, int] | None) -> list[int]:
    """Number the passage, then give every remaining verse one marker.

    A verse the commentary cites but never takes up in order still belongs in
    the margin — otherwise the reader cannot find it at all — so its first
    mention is numbered. That marker does not move the passage: a lone
    cross-reference is not the start of a discussion.
    """
    kinds = _place_verse_markers(quotes, linear, start_current)
    numbered: set[int] = set()
    for i, kind in enumerate(kinds):
        if kind:
            numbered.update(range(quotes[i][3], quotes[i][4] + 1))
    for i, (_line_index, _offset, _surah, verse, end) in enumerate(quotes):
        if kinds[i] or verse in numbered:
            continue
        kinds[i] = 2
        numbered.update(range(verse, end + 1))
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
    parsed = [re.match(r"\*\*\[\[([^#\]]+)#(\d+)\|(\d+):(\d+)", text)
              for _off, text, _is_mark in items]
    close = all(parsed) and all(
        int(parsed[k + 1].group(4)) - int(parsed[k].group(4)) <= 3
        for k in range(len(parsed) - 1))
    if (close
            and len({p.group(1) for p in parsed}) == 1
            and len({p.group(3) for p in parsed}) == 1):
        surah_num = int(parsed[0].group(3))
        first_verse = int(parsed[0].group(4))
        last_verse = int(parsed[-1].group(4))
        if last_verse > first_verse:
            return [(items[0][0],
                     _verse_marker(parsed[0].group(1), surah_num,
                                   first_verse, last_verse),
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
                                  linear, start_current)
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
    return pages[0], inserted


def tafsir_passes(content: str, *, hint_surah: int = 0, hint_verse: int = 0,
                  skip_leading: bool = False,
                  start_current: tuple[int, int] | None = None) -> tuple[str, dict]:
    """The tafsīr rules, in one place.

    One function so a scanned tafsīr and a corpus tafsīr cannot drift apart:
    link the quotes (seeded with the verse under discussion when the caller
    knows it), resolve the short fragments that quote it word by word, keep one
    citation per verse, drop false quotations, and put a marginal marker at
    every verse shift.
    """
    stats: dict[str, int] = {}
    content, n = add_missing_refs(
        content, hint_surah=hint_surah, hint_verse=hint_verse)
    stats["refs_added"] = n
    content, n = link_open_fragments(content, tafsir=True)
    stats["open_fragments"] = n
    content, n = mark_short_fragments(content)
    stats["short_fragments"] = n
    content, n = keep_first_verse_link(content)
    stats["repeated_links"] = n
    content, n = strip_false_quran(content)
    stats["false_quran"] = n
    # A citation the muṣḥaf does not support is corrected first, so the verse
    # that is wrapped, numbered and displayed is the one the words belong to.
    content, _fixes, _notes = quran.repair_citations(content)
    # Links added by the later passes still need their quotation wrapped.
    content = quran.wrap_cited_quotes(content)[0]
    content, n = insert_verse_headings(
        content, skip_leading=skip_leading, focus_surah=hint_surah,
        linear=bool(hint_surah), start_current=start_current)
    stats["markers"] = n
    content = strip_orphan_quote_classes(content)
    content, n = strip_raw_quran_citations(content)
    stats["raw_citations"] = n
    content, n = strip_redundant_raw_citations(content)
    stats["redundant_citations"] = n
    content, n = normalize_quran_link_display(content)
    stats["displays"] = n
    content, n = keep_first_verse_link(content)
    stats["repeats"] = n
    return content, stats


def keep_first_verse_link(content: str) -> tuple[str, int]:
    """In a commentary, cite a verse once, not on every repetition.

    The link is kept on the first quotation of a verse and on the first one
    after a cross-reference to a different verse; the repeats in between lose
    their link but keep the quote. This is what keeps a tafsīr readable when it
    returns to the same words again and again.
    """
    pattern = re.compile(
        r"﴿([^﴾\n]{1,400})﴾"
        r"(?:~)?(\s*)\(\[\[(\d{3})[^#\]]*#(\d+)\|[^\]]*\]\]\)"
    )
    edits: list[tuple[int, int]] = []
    previous: tuple[int, int] | None = None
    for match in pattern.finditer(content):
        target = (int(match.group(3)), int(match.group(4)))
        if target == previous:
            edits.append((match.start(2), match.end()))
        previous = target
    for start, end in reversed(edits):
        content = content[:start] + content[end:]
    return content, len(edits)




