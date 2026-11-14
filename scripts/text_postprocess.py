#!/usr/bin/env python3
"""Shared text post-processing helpers.

Source-specific acquisition handles the idiosyncrasies of each repository.
After that point, markdown text should go through the same helpers here so
text sources, transcriptions, and translations render consistently.
"""

from __future__ import annotations

import re


def escape_literal_brackets(text: str) -> str:
    """Escape lone source square brackets without touching actual links.

    Obsidian treats a bare ``[`` as a link opener, but a single bracket pair is
    not Markdown link syntax. Escape those lone openings while preserving
    ``[[wikilinks]]``, Markdown ``[text](url)`` and ``[text][ref]`` links,
    callout markers (``[!note]``), and footnote references (``[^1]``).
    """
    def repl(match: re.Match) -> str:
        token = match.group(0)
        if token.startswith("[["):
            return token
        following = text[match.end():match.end() + 1]
        if following in ("!", "^"):
            return token
        close = text.find("]", match.end())
        if close >= 0 and text[close + 1:close + 2] in ("(", "["):
            return token
        return "\\["

    return re.sub(r"\[\[[^\]]*\]\]|(?<!\\)\[", repl, text)


def _split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[:end + 4], text[end + 4:]
    return "", text


def _migrate_markdown(path, backup_dir=None) -> bool:
    """Escape literal brackets in one Markdown note, preserving YAML/code fences."""
    from pathlib import Path
    import json
    import sys
    from datetime import datetime

    file = Path(path)
    text = file.read_text(encoding="utf-8")
    yaml, body = _split_frontmatter(text)

    # Keep fenced code blocks as-is; brackets there are literal code, not prose.
    code: list[str] = []
    def park(match: re.Match) -> str:
        code.append(match.group(0))
        return f"\x10{len(code) - 1}\x11"
    body = re.sub(r"(?ms)^(```|~~~).*?^\1[ \t]*$", park, body)
    body = escape_literal_brackets(body)
    for i, block in enumerate(code):
        body = body.replace(f"\x10{i}\x11", block)
    next_text = yaml + body
    if next_text == text:
        return False

    if backup_dir:
        # Preserve the vault-relative path beneath the backup root when possible.
        parents = list(file.resolve().parents)
        vault = next((p for p in parents if (p / ".midad-arabic-sources").is_dir()), None)
        try:
            rel = file.resolve().relative_to(vault) if vault else Path(file.name)
        except ValueError:
            rel = Path(file.name)
        target = Path(backup_dir) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    file.write_text(next_text, encoding="utf-8")
    return True


def main(argv=None) -> int:
    import argparse
    import json
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Escape literal square brackets in Markdown files.")
    parser.add_argument("--backup-dir", default=None)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args(argv)
    changed: list[str] = []
    for name in args.files:
        if Path(name).suffix.lower() != ".md":
            continue
        try:
            if _migrate_markdown(name, args.backup_dir):
                changed.append(name)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"event": "log", "message": f"{name}: {exc}"}), flush=True)
    print(json.dumps({"event": "result", "result": {"notes": changed}}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def normalize_whitespace(text: str) -> str:
    """Final whitespace pass: one blank line, one internal space per run."""
    yaml, body = _split_frontmatter(text)
    lines = body.split("\n")
    trailing_blank = len(lines) >= 2 and not lines[-1].strip() and not lines[-2].strip()
    out: list[str] = []
    in_fence = False
    fence = ""
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence = marker
            elif marker == fence:
                in_fence = False
        if in_fence:
            out.append(line)
            continue
        if not stripped:
            if out and out[-1] != "":
                out.append("")
            continue
        leading = re.match(r"^[ \t]*", line).group(0)
        rest = re.sub(r"[ \t]{2,}", " ", line[len(leading):]).rstrip()
        out.append(leading + rest)
    if trailing_blank and out:
        out.append("")
    content = "\n".join(out)
    return yaml + "\n\n" + content if yaml else content


def _collapse_managed_regions(text: str) -> str:
    """Keep the first opening and last closing marker, removing nested markers."""
    yaml, body = _split_frontmatter(text)
    lines = body.split("\n")
    first_open = -1
    last_close = -1
    in_fence = False
    fence = ""
    for i, line in enumerate(lines):
        trimmed = line.strip()
        if trimmed.startswith(("```", "~~~")):
            marker = trimmed[:3]
            if not in_fence:
                in_fence = True
                fence = marker
            elif marker == fence:
                in_fence = False
            continue
        if in_fence:
            continue
        is_open = trimmed in (MANAGED_OPEN, LEGACY_MANAGED_OPEN) or (
            trimmed.startswith('<span class="mas-managed') and "/mas-managed" not in trimmed
        )
        is_close = trimmed in (MANAGED_CLOSE, LEGACY_MANAGED_CLOSE) or (
            "/mas-managed</span>" in trimmed or "%%/mas-managed%%" in trimmed
        )
        if is_open and first_open < 0:
            first_open = i
        if is_close and first_open >= 0:
            last_close = i
    if first_open < 0 or last_close <= first_open:
        return text
    out = list(lines[:first_open])
    out.append(MANAGED_OPEN)
    for line in lines[first_open + 1:last_close]:
        trimmed = line.strip()
        marker = trimmed in (MANAGED_OPEN, LEGACY_MANAGED_OPEN, MANAGED_CLOSE, LEGACY_MANAGED_CLOSE) or (
            trimmed.startswith('<span class="mas-managed') and "/mas-managed" in trimmed
        )
        if not marker:
            out.append(line)
    out.append(MANAGED_CLOSE)
    out.extend(lines[last_close + 1:])
    return yaml + "\n".join(out)


def normalize_managed_marker_spacing(text: str) -> str:
    """Keep mas-managed marker lines on their own blank-line-separated block."""
    text = _collapse_managed_regions(text)
    markers = {
        '<span class="mas-managed">mas-managed</span>',
        '<span class="mas-managed">/mas-managed</span>',
        "%%mas-managed%%",
        "%%/mas-managed%%",
    }
    lines = text.split("\n")
    out: list[str] = []
    in_fence = False
    fence = ""
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence = marker
            elif marker == fence:
                in_fence = False
        if not in_fence and stripped in markers:
            while out and out[-1].strip() == "":
                out.pop()
            if out:
                out.append("")
            out.append(stripped)
            i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            if i < len(lines):
                out.append("")
            else:
                out.extend(["", ""])
            continue
        out.append(lines[i])
        i += 1
    return normalize_whitespace("\n".join(out))


MANAGED_OPEN = '<span class="mas-managed">mas-managed</span>'
MANAGED_CLOSE = '<span class="mas-managed">/mas-managed</span>'
LEGACY_MANAGED_OPEN = "%%mas-managed%%"
LEGACY_MANAGED_CLOSE = "%%/mas-managed%%"


def wrap_managed_body(body: str) -> str:
    """The one canonical wrapper for generated managed content."""
    return f"{MANAGED_OPEN}\n\n{body.strip()}\n\n{MANAGED_CLOSE}"


_FOOTNOTE_HEADER = re.compile(r"^\s*(?:>\s*)?\[!arabic-footnotes\]\s*$", re.I)
_PAGE_HEADING = re.compile(r"^####\s+p\.")
_PAGE_NUMBER = re.compile(r"^\s*(?:[0-9٠-٩]+)\s*$")
_FOOTNOTE_NUMBER = re.compile(r"^\(?([0-9٠-٩]+)\)?\s*[-–—:]\s*")
_FOOTNOTE_SEPARATOR = re.compile(r"^\s*>\s*$")


def _footnote_paragraphs(page: list[str]) -> tuple[list[tuple[str, bool]], int]:
    """Collect paragraphs from every footnote callout on one page.

    Returns (paragraph, separator-before) pairs and the first line after the
    callout block. Only callout lines belong to the footnotes: a plain
    paragraph after the callout is page body and is never folded in, because a
    page's footnotes must not swallow the next passage.
    """
    first = next((i for i, line in enumerate(page) if _FOOTNOTE_HEADER.match(line)), None)
    if first is None:
        return [], len(page)
    paragraphs: list[tuple[str, bool]] = []
    seen: set[str] = set()
    pending_separator = False
    i = first + 1
    while i < len(page):
        line = page[i]
        stripped = line.strip()
        if _PAGE_HEADING.match(line):
            break
        if stripped == "---":
            break
        if not stripped or _FOOTNOTE_SEPARATOR.match(line):
            pending_separator = True
            i += 1
            continue
        if _PAGE_NUMBER.match(stripped):
            break
        if _FOOTNOTE_HEADER.match(line):
            i += 1
            continue
        if not line.lstrip().startswith(">"):
            break
        content = re.sub(r"^\s*>\s?", "", line).strip()
        if content.startswith("- "):
            content = content[2:].strip()
        elif content.startswith("-"):
            content = content[1:].strip()
        # A footnote definition numbered with a superscript is still a
        # definition: `<sup>2</sup> text` becomes `2 – text`.
        content = re.sub(r"^<sup>\s*([0-9٠-٩]+)\s*</sup>\s*(?:[–-]\s*)?", r"\1 – ", content).strip()
        if content and content not in seen:
            seen.add(content)
            paragraphs.append((content, pending_separator))
            pending_separator = False
        i += 1
    return paragraphs, i


_SUP_DEF = re.compile(r"^\s*<sup>\s*([0-9٠-٩]+)\s*</sup>\s*(.*)$")
_NUMBERED_ITEM = re.compile(r"^\s*(?:>\s*)?(?:[-*]\s*)?\(?([0-9٠-٩]+)\)?\s*[-–—.:]\s+(.+)$")
_SUP_ANCHOR = re.compile(r"<sup>\s*([0-9٠-٩]+)\s*</sup>")


def _western_digits(value: str) -> str:
    return value.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))


def _trailing_numbered_definitions(
    page: list[str], stop: int, defined: set[str]
) -> tuple[int, list[tuple[str, bool]]]:
    """A trailing numbered list that defines the page's unmatched anchors.

    A tafsīr page ends with its footnotes. When the body carries ``<sup>N</sup>``
    anchors that no callout defines, and the page's last block is a numbered
    list with exactly those numbers, the list is a footnote list rather than an
    ordered list. Numbers must match, so an ordinary numbered list is left
    alone.
    """
    body = "\n".join(page[:stop])
    anchors = {
        _western_digits(m.group(1)) for m in _SUP_ANCHOR.finditer(body)
    }
    unmatched = anchors - {_western_digits(n) for n in defined}
    if not unmatched:
        return stop, []
    end = stop
    while end > 0 and not page[end - 1].strip():
        end -= 1
    if end == 0:
        return stop, []
    if page[end - 1].strip() == "---":
        end -= 1
        while end > 0 and not page[end - 1].strip():
            end -= 1
        if end == 0:
            return stop, []
    start = end
    while start > 0 and page[start - 1].strip() and _NUMBERED_ITEM.match(page[start - 1]):
        start -= 1
    if start == end:
        return stop, []
    items = [page[i] for i in range(start, end)]
    numbers = [_western_digits(_NUMBERED_ITEM.match(item).group(1)) for item in items]
    if len(numbers) != len(set(numbers)) or set(numbers) != unmatched:
        return stop, []
    paragraphs = [
        (f"{_NUMBERED_ITEM.match(item).group(1)} – {_NUMBERED_ITEM.match(item).group(2).strip()}", False)
        for item in items
    ]
    return start, paragraphs


def _unmarked_sup_footnotes(page: list[str], stop: int) -> tuple[int, list[tuple[str, bool]]]:
    """Find trailing <sup>N</sup> definition paragraphs before a callout/page end.

    This is deliberately anchored to superscript definitions and matching body
    anchors; a plain numbered list is not converted.
    """
    body = "\n".join(page[:stop])
    anchors = {m.group(1) for m in re.finditer(r"<sup>\s*([0-9٠-٩]+)\s*</sup>", body)}
    if not anchors:
        return stop, []
    candidates = [i for i in range(stop) if (m := _SUP_DEF.match(page[i])) and m.group(1) in anchors]
    if not candidates:
        return stop, []
    start = candidates[0]
    paragraphs: list[tuple[str, bool]] = []
    pending_separator = False
    i = start
    while i < stop:
        line = page[i]
        stripped = line.strip()
        if not stripped:
            pending_separator = True
            i += 1
            continue
        match = _SUP_DEF.match(line)
        if match:
            body = match.group(2).strip()
            text = f"{match.group(1)} – {body}" if body else f"{match.group(1)} –"
            paragraphs.append((text, pending_separator))
            pending_separator = False
            i += 1
            continue
        if stripped.startswith(">") and paragraphs:
            continuation = re.sub(r"^\s*>\s?", "", line).strip()
            if continuation:
                old, sep = paragraphs[-1]
                paragraphs[-1] = (f"{old} {continuation}" if not old.endswith("–") else f"{old} {continuation}", sep)
            i += 1
            continue
        break
    return start, paragraphs


_SUP_CHARS = "⁰¹²³⁴⁵⁶⁷⁸⁹"
_SUP_MAP = str.maketrans(_SUP_CHARS, "0123456789")
_SUP_RUN = re.compile("[" + _SUP_CHARS + "]+")


def _defined_footnote_numbers(page: list[str]) -> set[str]:
    defined: set[str] = set()
    for line in page:
        content = re.sub(r"^\s*>\s?", "", line).strip()
        if content.startswith("- "):
            content = content[2:].strip()
        match = _FOOTNOTE_NUMBER.match(content)
        if match:
            defined.add(_western_digits(match.group(1)))
    return defined


def _normalize_anchor_marks(page: list[str]) -> list[str]:
    """Write every footnote anchor on the page as ``<sup>N</sup>``.

    Gemini leaves anchors in three shapes: a proper ``<sup>N</sup>``, a Unicode
    superscript (``¹``, ``²``), and a bare number glued to a closing parenthesis
    (``(…)1``). The last two are converted only when the page defines that
    footnote number, so ordinary numbers in prose are never touched.
    """
    defined = _defined_footnote_numbers(page)
    out: list[str] = []
    for line in page:
        if line.lstrip().startswith(">"):
            out.append(line)
            continue
        text = re.sub(r"<sup>\s*([" + _SUP_CHARS + r"]+)\s*</sup>",
                      lambda m: f"<sup>{m.group(1).translate(_SUP_MAP)}</sup>", line)
        # A Unicode superscript is an anchor on its own; it is never prose in an
        # Arabic tafsīr, so it does not need a definition on the same page.
        text = _SUP_RUN.sub(
            lambda m: f"<sup>{m.group(0).translate(_SUP_MAP)}</sup>", text)

        def _paren(match: re.Match) -> str:
            number = _western_digits(match.group(1))
            if number in defined:
                return f")<sup>{number}</sup>"
            return match.group(0)

        text = re.sub(r"\)\s*([0-9٠-٩]{1,2})(?![0-9٠-٩])", _paren, text)
        out.append(text)

    # A definition that still has no anchor leaves a bare number in the body
    # (`مات عن أخوات 1`). Only then is a standalone number treated as the
    # anchor, so ordinary numbers in prose stay digits.
    for number in sorted(defined, key=lambda value: int(value)):
        if any(re.search(rf"<sup>\s*{re.escape(number)}\s*</sup>", line) for line in out):
            continue
        pattern = re.compile(
            rf"(?<![\d٠-٩.:]){re.escape(number)}(?![\d٠-٩.:])")
        converted = False
        for index, line in enumerate(out):
            if converted:
                break
            if line.lstrip().startswith(("#", ">")):
                continue
            links = [(m.start(), m.end()) for m in re.finditer(r"\[\[[^\]]*\]\]", line)]
            for match in pattern.finditer(line):
                if any(start <= match.start() < end for start, end in links):
                    continue
                out[index] = line[:match.start()] + f"<sup>{number}</sup>" + line[match.end():]
                converted = True
                break
    return out


def _normalize_footnote_page(page: list[str]) -> list[str]:
    page = _normalize_anchor_marks(page)
    first = next((i for i, line in enumerate(page) if _FOOTNOTE_HEADER.match(line)), len(page))
    if first < len(page):
        callout_paragraphs, tail = _footnote_paragraphs(page)
    else:
        callout_paragraphs, tail = [], len(page)
    defined: set[str] = set()
    for text, _ in callout_paragraphs:
        match = _FOOTNOTE_NUMBER.match(text)
        if match:
            defined.add(match.group(1))
    sup_start, sup_paragraphs = _unmarked_sup_footnotes(page, first)
    for text, _ in sup_paragraphs:
        match = _FOOTNOTE_NUMBER.match(text)
        if match:
            defined.add(match.group(1))
    list_start, list_paragraphs = _trailing_numbered_definitions(page, sup_start, defined)
    if first == len(page) and not sup_paragraphs and not list_paragraphs:
        return page
    paragraphs = list_paragraphs + sup_paragraphs + callout_paragraphs
    if list_paragraphs and callout_paragraphs:
        # The numbered list sits above the callout on the page; restore numeric
        # order once both are one callout.
        def _order(item: tuple[str, bool]) -> tuple[int, int]:
            match = _FOOTNOTE_NUMBER.match(item[0])
            return (int(_western_digits(match.group(1))) if match else 10**6, 0)

        numbered = [(index, item) for index, item in enumerate(paragraphs) if _FOOTNOTE_NUMBER.match(item[0])]
        if len(numbered) == len(paragraphs):
            paragraphs = [item for _, item in sorted(numbered, key=lambda pair: _order(pair[1]))]
    start = min(
        list_start if list_paragraphs else len(page),
        sup_start if sup_paragraphs else len(page),
        first,
    )
    if not paragraphs:
        return page[:start] + page[tail:]
    rendered = [">[!arabic-footnotes]"]
    previous_number: str | None = None
    for index, (text, had_separator) in enumerate(paragraphs):
        match = _FOOTNOTE_NUMBER.match(text)
        number = match.group(1) if match else previous_number
        same_footnote = index > 0 and number == previous_number
        if index > 0 and (had_separator or same_footnote):
            rendered.append(">")
        rendered.append(f"> - {text}")
        previous_number = number
    if tail < len(page) and page[tail].strip():
        rendered.append("")
    result = page[:start] + rendered + page[tail:]
    if page and not page[-1].strip() and result and result[-1].strip():
        result.append("")
    return result


def normalize_arabic_footnotes(text: str) -> str:
    """Make one arabic-footnotes callout per page and normalize its paragraphs.

    Only pages with a footnote callout are touched. Callout lines become
    ``> - ...``; continuation paragraphs under the same footnote get a ``>``
    separator. Existing separators are preserved, so an already-correct callout
    is unchanged. A paragraph after a callout is folded into it.
    """
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        if _PAGE_HEADING.match(lines[i]):
            j = i + 1
            while j < len(lines) and not _PAGE_HEADING.match(lines[j]):
                j += 1
            out.extend(_normalize_footnote_page(lines[i:j]))
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


_PAGE_HEADING_TITLE = re.compile(r"^####\s+p\.\s*[0-9:]+\s*$")


def normalize_page_separators(text: str) -> str:
    """Exactly one ``---`` before every ``#### p. N`` page heading.

    A page heading is a section break, so it always opens with one horizontal
    rule and one blank line on either side of it. Runs of rules (from a
    re-render or a hand edit) collapse to one, and a missing rule is added.
    """
    lines = text.split("\n")
    out: list[str] = []
    for line in lines:
        if not _PAGE_HEADING_TITLE.match(line.strip()):
            out.append(line)
            continue
        while out and not out[-1].strip():
            out.pop()
        while out and out[-1].strip() == "---":
            out.pop()
        while out and not out[-1].strip():
            out.pop()
        if out:
            out.append("")
            out.append("---")
        out.append("")
        out.append(line.strip())
        out.append("")
    collapsed: list[str] = []
    for line in out:
        if not line.strip() and collapsed and not collapsed[-1].strip():
            continue
        collapsed.append(line)
    return "\n".join(collapsed)


_QURAN_WRAPPED = re.compile(r"\*?﴿([^﴾\n]+)﴾\*?\{\.quran-quote[^}]*\}\*?")
_QURAN_CLASS = re.compile(r"\{\.quran-quote[^}]*\}\*?")


def unwrap_quran_quotes(text: str) -> str:
    """Remove Markdown Attributes wrappers from ornate Qur'ān parentheses.

    The note keeps only ``﴿ ... ﴾``; the plugin decorates those ranges in Live
    Preview and Reading view. Existing citation links after the parentheses are
    left in place. A quote that crosses a page break carries only one of the two
    marks, and its legacy ``*`` wrapper is removed on that side too, so each
    half is styled by the plugin's open/close rule.
    """
    text = _QURAN_WRAPPED.sub(lambda m: f"﴿{m.group(1)}﴾", text)
    text = _QURAN_CLASS.sub("", text)
    # A half whose link was already added sometimes keeps a stray closing mark
    # glued to the citation: `([[…#86|…]])آ﴾`.
    text = re.sub(r"(\]\]\))([^\s﴿]{1,4}﴾)", r"\1", text)
    # A legacy italic star can also land inside the half, before the citation:
    # `﴿…حُيِّيتُم* ([[…]])`.
    text = re.sub(r"(﴿[^*\n(]*?)\*(?=\s*\()", r"\1", text)
    # Legacy italic halves: `*…﴾` and `…﴾*` (the opening/closing asterisk of a
    # cross-page quote that only carries one ornate paren).
    text = re.sub(r"(?m)^\*(?=[^*\n]*﴾)", "", text)
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if "﴾" in line and line.rstrip().endswith("*") and not line.rstrip().endswith("**"):
            line = line.rstrip()[:-1].rstrip()
        if "﴿" in line or "﴾" in line:
            line = re.sub(r"[ \t]{2,}", " ", line)
        lines[index] = line
    # A leftover italic star alone on its line, or trailing a paragraph, is
    # markup debris rather than emphasis.
    cleaned: list[str] = []
    for line in lines:
        if line.strip() == "*":
            continue
        if line.count("*") == 1 and line.rstrip().endswith("*"):
            line = line.rstrip()[:-1].rstrip()
        cleaned.append(line)
    lines = cleaned
    text = "\n".join(lines)
    # Legacy italic stars sit directly before/after an ornate paren. The two
    # that close a verse marker (`]]**﴿`) are not quote markup.
    text = re.sub(r"(\]\])\*{3}(?=﴿)", r"\1**", text)
    text = re.sub(r"(?<!\*)(?<!\]\])\*+(?=﴿)", "", text)
    return re.sub(r"(?<=﴾)\*+", "", text)


_QURAN_LINK = r"\[\[\d{3}[^\]\n]+\]\]"


def cleanup_quran_citations(text: str) -> str:
    """Remove duplicated wikilinks and bracket debris after Qur'ān citations."""
    pattern = re.compile(rf"({_QURAN_LINK})(?:\s*[\(\)\]]*\s*\(?\s*)\1")
    while True:
        next_text = pattern.sub(r"\1", text)
        if next_text == text:
            break
        text = next_text
    text = re.sub(rf"({_QURAN_LINK}\))[\)\]]{{2,}}", r"\1", text)
    text = re.sub(rf"({_QURAN_LINK}\))\s+[\)\]]+", r"\1", text)
    text = re.sub(r"–\\\[\]\)?", "", text)
    return re.sub(r"(﴾)\s*[\]\)–\\\[]+(?=\s|$)", r"\1", text)


_QURAN_BARE = re.compile(r"﴿([^﴾\n]+)﴾")


def wrap_quran_quotes_for_processing(text: str) -> str:
    """Temporarily add the legacy class so the citation pass can see a quote."""
    return _QURAN_BARE.sub(lambda m: f"*﴿{m.group(1)}﴾{{.quran-quote}}*", text)
