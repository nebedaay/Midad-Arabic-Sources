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


#: The line markers a transcription may put on a poetry line (`§§§`, `$$$`).
POETRY_MARK_RE = re.compile(r"^(?:§{2,}|\${3,})\s*")
#: Longest hemistich run that is still a couplet rather than a prose paragraph.
MAX_HEMISTICH_RUN = 82


def poetry_parts(line: str) -> list[str] | None:
    """The hemistiches of a poetry line, in whichever shape it arrived.

    This is the *only* place the shapes are defined, because two processes read
    them: the formatter, while a transcription is being built, and the Markdown
    update, for a note that was rendered before a shape was known. A shape added
    here is recognised by both.

    - `a%%b` (also after a `§§§` line marker) — the canonical separator, and the
      only one that may carry more than one couplet on a line;
    - `a ** b` — Gemini's bare double asterisk;
    - `*a *b` — the legacy couplet with a star glued before each hemistich.

    A bold run (`**word**`) has no spaces inside its stars and is not a couplet.
    """
    s = line.strip()
    if not s or "\ufd3f" in s or "\ufd3e" in s:
        return None
    if "%%" in s or POETRY_MARK_RE.match(s):
        inner = POETRY_MARK_RE.sub("", s).strip()
        parts = [p.strip().strip("*").strip() for p in inner.split("%%")]
        parts = [p for p in parts if p]
        return parts if len(parts) >= 2 else None
    if s.count("*") == 2 and " ** " in s and not s.startswith("*") and not s.endswith("*"):
        first, second = (part.strip() for part in s.split(" ** ", 1))
        if first and second and _rendered_length(s) <= MAX_HEMISTICH_RUN:
            return [first, second]
        return None
    if s.count("*") == 2 and s.startswith("*") and not s.endswith("*") and " *" in s[1:]:
        first, second = s[1:].split(" *", 1)
        if first.strip() and second.strip() and _rendered_length(s) <= MAX_HEMISTICH_RUN:
            return [first.strip(), second.strip()]
    return None


def _rendered_length(text: str) -> int:
    """Length without inline markup, for the "short enough to be verse" test."""
    return len(re.sub(r"[*_~`]", "", text))


def format_poetry_couplets(text: str) -> tuple[str, int]:
    """Turn a run of poetry lines into an Arabic-poetry callout.

    Reads the shapes through `poetry_parts`, so it converts the same lines the
    formatter does — including a note written before a shape was recognised.
    A line already inside a callout (`>`) is never touched.
    """
    lines = text.split("\n")
    out: list[str] = []
    made = 0
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.lstrip().startswith(">"):
            out.append(line)
            index += 1
            continue
        parts = poetry_parts(line)
        if not parts:
            out.append(line)
            index += 1
            continue
        out.append(">[!arabic-poetry]")
        made += 1
        while index < len(lines) and not lines[index].lstrip().startswith(">"):
            parts = poetry_parts(lines[index])
            if not parts:
                break
            for start in range(0, len(parts), 2):
                out.append(">-")
                out.append(f">\t- {parts[start]}")
                if start + 1 < len(parts):
                    out.append(f">\t- {parts[start + 1]}")
            index += 1
    return "\n".join(out), made


_POETRY_CALLOUT = re.compile(r"(?m)^>\[!arabic-poetry\][^\n]*(?:\n>[^\n]*)*")
_TASHKIL_MARKS = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")


def _rendered_length(line: str) -> int:
    """A line's length as it is read: diacritics take no space."""
    return len(_TASHKIL_MARKS.sub("", line))


def _poetry_content(line: str) -> str:
    """The text of one callout line, without the callout's own markers."""
    text = line[1:] if line.startswith(">") else line
    text = text.lstrip("\t ")
    if text.startswith("-"):
        text = text[1:].lstrip()
    return text.rstrip()


def demote_long_poetry(text: str, limit: int = 82) -> tuple[str, int]:
    """Turn a callout that cannot be poetry into a block quote.

    Gemini sometimes formats a verse or a paragraph as a hemistich. A couplet's
    half-line is short; a hundred-character line with no break is prose, or a
    quotation, and reading it as verse both looks wrong and hides it from the
    Qur'ān passes. The callout is rewritten as a plain block quote: the words,
    their order and the paragraph break survive, and every later pass treats the
    text as the prose it is.
    """
    demoted = 0

    def rewrite(m: re.Match) -> str:
        nonlocal demoted
        lines = m.group(0).split("\n")
        content = [_poetry_content(line) for line in lines[1:]]
        content = [line for line in content if line]
        if not content:
            return m.group(0)
        if max(_rendered_length(line) for line in content) <= limit:
            return m.group(0)
        demoted += 1
        return "\n".join(f"> {line}" for line in content)

    return _POETRY_CALLOUT.sub(rewrite, text), demoted


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
        # Drop any blanks and rules already in front of the heading, repeated,
        # so `---`, `---\n\n---` and a hand-written stack all become one.
        while True:
            if out and not out[-1].strip():
                out.pop()
            elif out and out[-1].strip() == "---":
                out.pop()
            else:
                break
        if out:
            out.append("")
            out.append("---")
        out.append("")
        out.append(line.strip())
        out.append("")
    # A rule that does not introduce a page is debris: the page break is the only
    # thing a separator is for, and a stray one inside a page splits a passage the
    # reader sees as continuous.
    settled: list[str] = []
    for index, line in enumerate(out):
        if line.strip() == "---":
            following = next((item for item in out[index + 1:] if item.strip()), "")
            if not _PAGE_HEADING_TITLE.match(following.strip()):
                settled.append("")
                continue
        settled.append(line)
    collapsed: list[str] = []
    for line in settled:
        if not line.strip() and collapsed and not collapsed[-1].strip():
            continue
        collapsed.append(line)
    return "\n".join(collapsed)


#: A paragraph that is nothing but a Qur'ān quotation — one ornate span or a run
#: of them, a citation before or after, and the debris a model leaves round it
#: (a stray `*`, the source's own parentheses, a closing `.` or `۝`).
_QURAN_BLOCK = re.compile(
    r"^\s*(?:\(?\s*\[\[[^\]\n]*\]\]\s*\)?\s*)?"      # a margin marker, if any
    # One or more quotations — including a *half* of one, which is how a
    # quotation that spans a page break is written: the page it opens on has
    # `﴿…` with no closer, the next page has `…﴾` with no opener. Each page's
    # paragraph is a callout in its own right. A stray italic star is the shape
    # the half was marked with, so it sits outside the parentheses here.
    r"(?:(?:\*?\s*~?\ufd3f[^\ufd3e\n]*\ufd3e~?\*?"
    r"|~?\ufd3f[^\ufd3e\n]*?\*?"
    r"|\*?~?[^\ufd3f\n]*\ufd3e\*?)\s*)+"
    r"(?:\(?\s*\[\[[^\]\n]*\]\]\s*\)?\s*)*"          # their citations
    r"(?:<sup>[^<\n]*</sup>\s*)?"                   # the page's verse number
    r"(?:[\(\[]?[\u0660-\u0669\d]{1,4}[\)\]]?\s*)?"  # … or set as text (`(٥)`)
    r"[\.\u06dd\)\]]*\s*$"                          # and a closing mark
)


def _quotation_probe(block: str) -> str:
    """The block with the debris a model leaves round a quotation removed."""
    probe = re.sub(r"^[\*\s]+", "", block.strip())
    probe = re.sub(r"^(?:\((?!\[)|\[(?!\[))\s*", "", probe)
    # Trailing debris: a closing mark, the source's own parenthesis, or a
    # bracket that is not the `]]` of a citation.
    probe = re.sub(r"[\s\.\u06dd\)]+$", "", probe)
    if probe.endswith("]") and not probe.endswith("]]"):
        probe = re.sub(r"[\s\]]+$", "", probe)
    return probe


def _drop_quote_stars(text: str) -> str:
    """Remove the asterisks that were only marks round a quotation.

    A quotation that crosses a page break is written `*…﴾` on one page and
    `*﴿…` on the other, and a margin marker may sit between the star and the
    words (`[[Q022#5|:]]*لِكَيْلَا`). Inside a `mas-quran` callout nothing is
    emphasised, so those stars are debris — left in place, the lone one opens an
    italic run that never closes.
    """
    text = re.sub(r"(?<=\]\])\*+", "", text)
    text = re.sub(r"\*+(?=\[\[)", "", text)
    text = re.sub(r"\*+(?=[\ufd3f\ufd3e])", "", text)
    text = re.sub(r"(?<=[\ufd3f\ufd3e])\*+", "", text)
    text = re.sub(r"(?m)^\*+(?=\S)", "", text)
    return re.sub(r"\*+[ \t]*$", "", text)


def _callout_body(block: str) -> str:
    """The quotation alone: the model's debris out, a numeral parenthesis kept.

    `_quotation_probe` strips a trailing `)` because it is usually the source's
    own bracket round the quotation, but the same character closes a verse
    numeral (`(٥)`) that belongs to the page. So the body is trimmed here, where
    a `)` is only removed when a `(` was removed at the front to match it.
    """
    text = re.sub(r"^[\*\s]+", "", block.strip())
    opened = False
    match = re.match(r"^(?:\((?!\[)|\[(?!\[))\s*", text)
    if match:
        text = text[match.end():]
        opened = True
    text = re.sub(r"\s*[\.\u06dd]+\s*$", "", text)
    if opened:
        text = re.sub(r"\s*\)\s*$", "", text)
    if text.endswith("]") and not text.endswith("]]"):
        text = re.sub(r"[\s\]]+$", "", text)
    return text


#: A verse number the source printed as text instead of an emblem: `(٥)`, `[٥]`,
#: or the superscript the formatter makes of it (`<sup>(٥)</sup>`). Only the
#: *bracketed* shapes are candidates: `<sup>٥</sup>` with no bracket inside is
#: the vault's footnote-anchor form and is never touched, and a bare number is
#: prose.
_VERSE_NUMBER_TAIL = re.compile(
    r"[ \t]*(?:<sup>[ \t]*[\(\[]([\u0660-\u0669\d]{1,4})[\)\]][ \t]*</sup>"
    r"|[\(\[]([\u0660-\u0669\d]{1,4})[\)\]])[ \t]*$")


def _strip_verse_number(block: str, defined: set[str]) -> str:
    """Drop a page's verse number from the end of a quotation-only paragraph.

    The muṣḥaf marks each āya with an emblem, and an OCR pass often sets the
    number as text instead — `… بَهِيجٍ (٥)`. Inside a paragraph that holds
    nothing but the quotation there is nothing for a number to annotate: it is
    the page's own verse number, and it belongs in the margin, not the note.

    A footnote is the one thing such a number could really be, so a number the
    page *defines* as a footnote is kept, and only the bracketed shapes are
    candidates at all. The page's definitions are read from its
    `arabic-footnotes` callout; a page with none has nothing to protect.
    """
    match = _VERSE_NUMBER_TAIL.search(block)
    if not match:
        return block
    number = _western_digits(match.group(1) or match.group(2))
    if number in defined:
        return block
    return block[:match.start()].rstrip()


#: Where one page ends and the next begins, so footnote definitions can be read
#: per page rather than for the whole note.
_PAGE_SPLIT = re.compile(r"(?m)(?=####[ \t]+p\.)")

#: A Qur'ān callout, whichever of the two names a note was written with.
_QURAN_CALLOUT = re.compile(r">\[![\w-]*quran")


def blockquote_full_paragraphs(content: str) -> tuple[str, int]:
    """Set a paragraph that is *only* a Qur'ān quotation as a masked callout.

    A commentary quotes a whole passage on a line of its own, and the model
    marks it however it happens to — ornate parentheses, an italic span, or a
    stray leading `*` before a parenthesised quotation. What makes it a callout
    is that the paragraph contains nothing else: one word of prose round the
    quotation keeps it a paragraph.

    The callout type is `mas-quran`, so the plugin styles a Qur'ān quotation
    wherever it appears — in a tafsīr, a book, a translation — instead of each
    genre deciding. A block that is already a callout of another type (poetry,
    footnotes) is left alone, and a plain block quote holding only a quotation
    gains the header rather than being re-wrapped.

    The stray `*`, the source's own parentheses and the page's verse number are
    dropped when the block is quoted, because they are the shape the quotation
    was *marked* with, not part of it.
    """
    pages = _PAGE_SPLIT.split(content)
    changed = 0
    for page_index, page in enumerate(pages):
        if not page:
            continue
        defined = _defined_footnote_numbers(page.splitlines())
        blocks = re.split(r"(\n[ \t]*\n)", page)
        for index in range(0, len(blocks), 2):
            block = blocks[index]
            stripped = block.strip()
            if not stripped:
                continue
            if stripped.startswith(">[!"):
                # A Qur'ān callout written by an earlier pass: the quotation is
                # already set, and only its trailing verse number is cleaned —
                # which is what makes an update of the note reach a number the
                # formatter had already wrapped as a superscript.
                if not _QURAN_CALLOUT.match(stripped):
                    continue
                lines = stripped.rsplit("\n", 1)
                cleaned = _strip_verse_number(lines[-1], defined)
                if cleaned != lines[-1]:
                    blocks[index] = "\n".join([*lines[:-1], cleaned])
                continue
            if stripped.startswith(("|", "#", "-", "\t")):
                continue
            quoted = stripped.startswith(">")
            body = re.sub(r"(?m)^>\s?", "", stripped) if quoted else stripped
            # The stars that only marked the quotation are removed before the
            # test, not after: a marker between the star and the words
            # (`[[…#5|:]]*﴿…`) is invisible to a pattern expecting the marker
            # first.
            body = _drop_quote_stars(body)
            probe = _quotation_probe(body)
            if not _QURAN_BLOCK.match(probe):
                continue
            if quoted:
                blocks[index] = ">[!mas-quran]\n" + _drop_quote_stars(stripped)
            else:
                blocks[index] = (">[!mas-quran]\n> "
                                 + _callout_body(body).replace("\n", "\n> "))
            blocks[index] = _strip_verse_number(blocks[index], defined)
            changed += 1
        pages[page_index] = "".join(blocks)
    return "".join(pages), changed



#: A ۝ verse emblem, with the number it may carry. In the muṣḥaf it is a
#: marker holding the āya number; in a quotation the number comes from the
#: margin, so an emblem left inside the parentheses prints an empty ornament.
_VERSE_EMBLEM = re.compile(r"[ \t]*\u06DD[\u0660-\u0669]*[ \t]*")
_QUOTATION_OPEN = "\ufd3f"
_QUOTATION_CLOSE = "\ufd3e"


def _quotation_spans(text: str) -> list[tuple[int, int]]:
    """The inside of every ornate pair, found without guessing the direction.

    An Arabic note writes `﴿quote﴾` and a translation writes the pair mirrored,
    `﴾quote﴿` — and one text can hold both, because a translation may quote the
    Arabic of a verse inside its English. So the direction is not a property of
    the note at all: each mark is paired with the *nearest mark of the other
    kind*, which is the only rule that is right either way round. It is also
    what keeps one quotation's closer from pairing with the next quotation's
    opener, a span that would swallow the prose (and any citation link) between
    two quotations.
    """
    spans: list[tuple[int, int]] = []
    cursor = 0
    length = len(text)
    while cursor < length:
        opening = text.find(_QUOTATION_OPEN, cursor)
        closing = text.find(_QUOTATION_CLOSE, cursor)
        if opening < 0 and closing < 0:
            break
        if closing < 0 or (0 <= opening < closing):
            start, other = opening, _QUOTATION_CLOSE
        else:
            start, other = closing, _QUOTATION_OPEN
        finish = text.find(other, start + 1)
        if finish < 0:
            # A lone mark is half of a quotation whose other half is elsewhere
            # (a page break): there is no span here to clean.
            break
        # A quotation does not cross a paragraph break, so a pairing that does
        # is a mis-pairing from an unbalanced mark — and a span that reaches
        # across a page heading lets the verse-number stripping eat the page
        # number and the line break with it (`#### p. 235` + the next paragraph).
        between = text[start:finish]
        if "\n\n" in between or re.search(r"(?m)^#{1,6}[ \t]", between):
            cursor = start + 1
            continue
        spans.append((start + 1, finish))
        cursor = finish + 1
    return spans


def strip_quote_emblems(text: str) -> str:
    """Drop a ۝ emblem and any stray markup from inside a quotation.

    Applied to the finished note as well as to the processing form, because a
    quotation written by an older pass still carries one. Only a span with
    Arabic in it is touched: a `﴿…﴾` pair around Latin text is not a muṣḥaf
    quotation, and stripping its digits would eat a date or an address.
    """
    def cleaned(body: str) -> str:
        if "[[" in body or "]]" in body:
            # A link is not quotation text: whatever this span is, it is not one
            # quotation, and its contents must be left alone.
            return body
        # `۞` is the muṣḥaf's own divider, not a word of the verse: a
        # translated quotation that opens with it prints a decoration inside
        # the gilding.
        body = body.replace("\u06de", " ")
        body = _VERSE_EMBLEM.sub(" ", body)
        # Quotation text is never emphasised: the gilding is the styling, so an
        # asterisk inside the marks is markup debris, and one left behind opens
        # an italic run across whatever follows.
        body = body.replace("*", "")
        if re.search(r"[\u0600-\u06FF]", body):
            # A verse number set as text — `(٤٩)` — is a citation the source
            # left in the quotation; the muṣḥaf contains no digits. Only a
            # span with Arabic in it can be a muṣḥaf quotation: stripping
            # digits from `﴿B.P. N° 1﴾` would eat an address.
            body = re.sub(r"\s*[\(\[]?\s*[\u0660-\u0669\d]+\s*[\)\]]?\s*", " ", body)
        return re.sub(r"[ \t]{2,}", " ", body).strip()

    out: list[str] = []
    cursor = 0
    for start, finish in _quotation_spans(text):
        out.append(text[cursor:start])
        out.append(cleaned(text[start:finish]))
        cursor = finish
    out.append(text[cursor:])
    return re.sub(r"[ \t]{2,}", " ", "".join(out))


_QURAN_WRAPPED = re.compile(r"(?<!\*)\*?﴿([^﴾\n]+)﴾\*?\{\.quran-quote[^}]*\}\*?")
_QURAN_CLASS = re.compile(r"\{\.quran-quote[^}]*\}\*?")


#: A translation's own citation, written after the quotation: `﴿…﴿ (001:4)`.
#: The ornate marks are reversed in a left-to-right line, so either one may
#: carry it. Only this shape is converted — the parenthesis has to touch a
#: quotation — which is what keeps a time like `(2:30)` and other bracketed
#: numbers out of it.
_BARE_REF = re.compile(
    # The processing scaffold sits between the paren and the citation until the
    # note is finished — `God﴿{.quran-quote}* (4:69)` — so it is allowed for
    # here. Without it no translated citation ever matched, which is why a
    # translation arrived with its references still as plain parentheses.
    r"([\ufd3f\ufd3e])(?:\{\.quran-quote[^}]*\}\*?|\*)?\s*"
    r"\(\s*(\d{1,3})\s*:\s*(\d{1,3})"
    r"(?:\s*[-\u2013\u2014]\s*(\d{1,3}))?\s*\)")


#: The same citation after a quotation mark rather than an ornate paren. A
#: translation sets its quotations with `"…"`, `“…”`, `’…’`, `«…»` or italics,
#: and puts the reference after the closing mark; without this its citations
#: stayed as plain parentheses while only the ornate ones became links.
_BARE_REF_QUOTED = re.compile(
    r"([\"\u201d\u2019\u00bb]|\*)\s*\(\s*(\d{1,3})\s*:\s*(\d{1,3})"
    r"(?:\s*[-\u2013\u2014]\s*(\d{1,3}))?\s*\)")


def link_bare_refs(text: str) -> tuple[str, int]:
    """Turn a translation's `(sūra:verse)` into the vault's citation link.

    A translation of a tafsīr carries the source's verse references as text —
    `(001:4)` after the quotation — because the model had no link syntax for
    them. They are regular enough to convert: a parenthesis directly after an
    ornate paren, two numbers round a colon, a sūra that exists and a verse that
    could. Applied across the vault this would be a guess (users write times and
    ratios that look the same); applied to a translation it is the source's own
    apparatus, so only the translation path calls it.
    """
    changed = 0

    def repl(match: re.Match) -> str:
        nonlocal changed
        surah, start = int(match.group(2)), int(match.group(3))
        end = int(match.group(4)) if match.group(4) else start
        if not (1 <= surah <= 114 and 1 <= start <= 286 and end >= start):
            return match.group(0)
        changed += 1
        link = f"[[Q{surah:03d}#{start}" + (f"|{end}]]" if end > start else "]]")
        return f"{match.group(1)} {link}"

    text = _BARE_REF.sub(repl, text)
    text = _BARE_REF_QUOTED.sub(repl, text)
    return text, changed


#: A footnote callout header, either name.
_FN_HEADER = re.compile(r"^\s*>?\s*\[!\s*(?:arabic[- ]?)?footnotes\s*\]\s*$", re.I)
#: A footnote item with its number but no text (`> - 1 –`), which Gemini leaves
#: behind when it splits a footnote list.
_FN_EMPTY_ITEM = re.compile(r"^\s*>\s*(?:-\s*[\d\u0660-\u0669]+\s*[-–—:]\s*)?$")


#: A paragraph that is one bold span and nothing else. Gemini sees one page at a
#: time and cannot know the document's structure, so it marks a section title by
#: bolding it; a heading level is the honest reading, and a third level is the
#: default because a section is what a bold line inside a page is.
_BOLD_PARAGRAPH = re.compile(r"(?m)^\*\*([^*\n]{2,90})\*\*[ \t]*$")


def bold_paragraphs_to_headings(text: str) -> tuple[str, int]:
    """Turn a short bold paragraph into a section heading.

    A bold line is not prose: leaving it as a paragraph risks it being combined
    with the paragraph after it (which loses both the emphasis and the break),
    and it is a title the model had no heading syntax for. A bold span that is a
    link, a quotation, or a long sentence keeps its paragraph — the first two are
    markup, the last is emphasis.
    """
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        inner = match.group(1).strip()
        if not inner or "[[" in inner or "\ufd3f" in inner or inner.endswith((".", ":", "\u061f")):
            return match.group(0)
        count += 1
        return f"### {inner}"

    return _BOLD_PARAGRAPH.sub(repl, text), count


#: A page heading with text swallowed onto the same line: `#### p. 12 والثالث…
#: معرفة الدنيا`. The pattern `p. N` is deliberate and the heading is meant to
#: be that and nothing else, so anything appended to it is a missing break.
#: The text may follow the number with no space at all (`#### p. 235﴾then…`),
#: which is what the model does when it drops the paragraph break.
_HEADING_PAGE = re.compile(
    r"(?m)^(#{1,6}[ \t]*p\.[ \t]*[0-9\u0660-\u0669]+)"
    r"(?![0-9\u0660-\u0669])([ \t]*)(\S.*)$")

#: A page heading the model wrote with a star where the dot belongs:
#: `#### p * 135`.
_MALFORMED_PAGE_HEADING = re.compile(
    r"(?m)^(#{1,6}[ \t]*)p\.?[ \t]*\*[ \t]*([0-9\u0660-\u0669]+)[ \t]*$")


def split_page_headings(text: str) -> tuple[str, int]:
    """Give a page heading's swallowed text its own paragraph back."""
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        count += 1
        # The model separates the page from what follows with a dash when it
        # writes them on one line (`#### p. 12 - سورة يوسف`); the dash belongs to
        # the missing break, not to the text.
        rest = re.sub(r"^[\u2013\u2014-][ \t]*", "", match.group(3))
        return f"{match.group(1)}\n\n{rest}"

    text, broken = _MALFORMED_PAGE_HEADING.subn(
        lambda match: f"{match.group(1)}p. {match.group(2)}", text)
    return _HEADING_PAGE.sub(repl, text), count + broken


#: A heading. A real one is a label; a paragraph of prose that happens to begin
#: with `###` is the model's mistake, and it loses its paragraphs when it is
#: styled as a heading.
_ATX_HEADING = re.compile(r"(?m)^(#{1,6})[ \t]+(.+)$")
_VERSE_LINK_IN_TEXT = re.compile(r"\[\[(?:Q[A-Z]{0,2})?\d{3}[^#\]]*#\d+")


def demote_prose_headings(text: str, limit: int = 90) -> tuple[str, int]:
    """Turn a heading that is really prose back into a paragraph.

    Two things give it away: it is long (a section label is not), or it carries a
    verse citation (a heading does not cite the Qur'ān; a quotation and its
    reference are a passage). The markers are dropped and the text keeps its
    paragraph, where the quotation and citation passes can see it.
    """
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        body = match.group(2)
        rendered = re.sub(r"[*_~`\[\]]", "", body)
        if len(rendered) <= limit and not _VERSE_LINK_IN_TEXT.search(body):
            return match.group(0)
        count += 1
        return body

    return _ATX_HEADING.sub(repl, text), count


#: Three or more of the same ornate paren in a row is debris, not notation: a
#: quotation has one mark per side, and two quotations are separated by words.
_ORNATE_RUN = re.compile(r"([\ufd3f\ufd3e])\1{2,}")


def collapse_ornate_runs(text: str) -> tuple[str, int]:
    """Collapse a run of ornate parentheses left by an interrupted render."""
    count = len(_ORNATE_RUN.findall(text))
    return _ORNATE_RUN.sub(r"\1", text), count


#: A fenced code block: a backtick inside one is code, not emphasis.
_FENCED_BLOCK = re.compile(r"(?ms)^[ \t]*(```|~~~)[^\n]*\n.*?^[ \t]*\1[^\n]*$")


def backticks_to_quotes(text: str) -> tuple[str, int]:
    """Turn the model's backtick emphasis into the vault's ‘…’ quotes.

    The translation model marks a term — or a whole couplet — with backticks,
    and Markdown then sets it in code type: a monospaced Latin run in the middle
    of the page, which is not a quotation at all. The vault quotes with the
    single curly pair, so an opening backtick becomes ‘ and a closing one ’.
    A fenced block is code and is left alone; an unmatched backtick still
    becomes a mark, because a stray one is what leaves the rest of the page
    monospaced.
    """
    count = text.count("`")
    if not count:
        return text, 0

    opening = True

    def convert(segment: str) -> str:
        nonlocal opening
        out: list[str] = []
        for char in segment:
            if char == "`":
                out.append("\u2018" if opening else "\u2019")
                opening = not opening
            else:
                out.append(char)
        return "".join(out)

    pieces: list[str] = []
    cursor = 0
    for match in _FENCED_BLOCK.finditer(text):
        pieces.append(convert(text[cursor:match.start()]))
        pieces.append(match.group(0))
        cursor = match.end()
    pieces.append(convert(text[cursor:]))
    return "".join(pieces), count


def normalize_translation_footnotes(text: str) -> tuple[str, int]:
    """Make a translation's footnotes the ordinary kind, once.

    A translation is not an Arabic note, but Gemini sometimes writes both
    callouts on one page — an empty `footnotes` and the content in
    `arabic-footnotes`, which is styled right-to-left because of its name. The
    text is English, so the Arabic callout is a mislabel: it is renamed, adjacent
    footnote callouts are merged into one, and repeated items (the model often
    writes the same note into both) are dropped.

    Only translations call this. An Arabic note's footnotes really are Arabic and
    keep their callout.
    """
    changed = 0

    def previous_is_header(out: list[str]) -> bool:
        for line in reversed(out):
            if not line.strip():
                continue
            return bool(_FN_HEADER.match(line))
        return False

    def next_block(start: int) -> int:
        index = start + 1
        while index < len(page_lines) and not page_lines[index].strip():
            index += 1
        return index

    # A page label for the list — `Footnotes:`, `> Footnotes:`, `**Footnotes**`
    # — is not prose: the callout is the container, and a label left standing
    # above one reads as a second, empty section. Three shapes have to be told
    # apart, and the difference matters:
    #
    #   * inside a callout that already has its header, the label is redundant
    #     and goes (with the blank lines that separated it);
    #   * inside a plain blockquote of items, the blockquote *is* the footnotes,
    #     so the label becomes the callout header — dropping it left the items
    #     as an unlabelled quote, which is exactly the "Footnotes: but no
    #     callout heading" page;
    #   * as its own paragraph, it becomes the header when items follow and is
    #     dropped otherwise.
    lines: list[str] = []
    index = 0
    page_lines = text.split("\n")
    while index < len(page_lines):
        tag = _FOOTNOTE_TAG.match(page_lines[index])
        if tag:
            # The page's footnotes written as literal tags around bare numbered
            # paragraphs. The wrapper is a callout the model spelled as XML: the
            # opening tag becomes the callout, the definitions become its items,
            # and the closing tag goes.
            changed += 1
            index += 1
            if tag.group("close"):
                continue
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(">[!footnotes]")
            while index < len(page_lines):
                line = page_lines[index]
                if _FOOTNOTE_TAG.match(line):
                    index += 1
                    break
                if line.strip() == "---" or line.lstrip().startswith("#"):
                    break          # an unclosed wrapper must not eat the page
                if not line.strip():
                    # Stop before the blank that ends the wrapper, so the page
                    # rule after it keeps the blank line it needs.
                    ahead = index
                    while ahead < len(page_lines) and not page_lines[ahead].strip():
                        ahead += 1
                    if (ahead >= len(page_lines) or _FOOTNOTE_TAG.match(page_lines[ahead])
                        or page_lines[ahead].strip() == "---"
                        or page_lines[ahead].lstrip().startswith("#")):
                        break
                    index = ahead
                    continue
                mark = _FOOTNOTE_DEFINITION.match(line)
                if mark:
                    number = _definition_number(mark)
                    lines.append(f"> - {number} – {line[mark.end():]}")
                else:
                    lines.append(f"> {line}")
                index += 1
            continue
        label = _FOOTNOTE_LABEL.match(page_lines[index])
        heading = _FOOTNOTE_HEADING.match(page_lines[index])
        if not label and not heading:
            lines.append(page_lines[index])
            index += 1
            continue
        following = next_block(index)
        if heading:
            # A `Footnotes` heading is the model's label, never a section: in
            # this corpus the source page has no heading there at all — the
            # footnotes are the page's apparatus, not a titled division (a book
            # with endnotes would call them that, and prints a list under them).
            # So it goes, and what follows becomes the page's callout either way.
            changed += 1
            if following < len(page_lines) and _FN_HEADER.match(page_lines[following]):
                if lines and lines[-1].strip():
                    lines.append("")
                index = following
                continue
            # Definitions written as ordinary numbered paragraphs.
            position = index + 1
            blocks: list[list[str]] = []
            while True:
                scan = position
                while scan < len(page_lines) and not page_lines[scan].strip():
                    scan += 1
                if scan >= len(page_lines) or not _FOOTNOTE_DEFINITION.match(page_lines[scan]):
                    break
                block: list[str] = []
                cursor = scan
                while cursor < len(page_lines) and page_lines[cursor].strip():
                    block.append(page_lines[cursor])
                    cursor += 1
                blocks.append(block)
                position = cursor
            if not blocks:
                # Nothing under it: the label goes and the page keeps its text.
                index = following
                continue
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(">[!footnotes]")
            for block in blocks:
                mark = _FOOTNOTE_DEFINITION.match(block[0])
                number = _definition_number(mark)
                lines.append(f"> - {number} – {block[0][mark.end():]}")
                for extra in block[1:]:
                    lines.append(f"> {extra}")
            index = position
            continue
        changed += 1
        if label and label.group("quote"):
            if previous_is_header(lines):
                while lines and not lines[-1].strip():
                    lines.pop()
                index += 1
            else:
                lines.append(">[!footnotes]")
                index += 1
            continue
        if following < len(page_lines) and _FN_HEADER.match(page_lines[following]):
            # The callout follows; the label only duplicated its header.
            if lines and lines[-1].strip():
                lines.append("")
            index = following
        elif following < len(page_lines) and page_lines[following].lstrip().startswith(">"):
            # Items with no callout at all: the label is the only sign of one.
            lines.append(">[!footnotes]")
            index = following
        else:
            index += 1
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))

    lines, _definitions, _md_keys = _definitions_to_callout(lines)
    changed += _definitions
    md_keys: dict[str, int] = dict(_md_keys)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))

    # A page whose footnote list never became a callout: the model writes the
    # items as a plain blockquote — `>1 – …` — with no header and often no
    # label, so the page renders as an unlabelled quote. The page's `<sup>`
    # anchors are the evidence: a run of numbered items whose numbers are
    # exactly the anchors nothing else defines is that page's footnote list,
    # never a guess. A partial match is left alone.
    recovered: list[str] = []
    page_above: list[str] = []
    index = 0
    source = text.split("\n")
    while index < len(source):
        line = source[index]
        item = _FN_ITEM.match(line)
        after_quote = bool(recovered and recovered[-1].lstrip().startswith(">"))
        if item and not after_quote:
            items, end = _footnote_run(source, index)
            unique = list(dict.fromkeys(items))
            numbers: set[int] = {number for number, _ in unique}
            anchors = {
                int(found) for found in re.findall(
                    r"<sup>\s*(\d{1,3})\s*</sup>", "\n".join(page_above))
            }
            # A list that ends the page is the page's footnotes even when the
            # body's `<sup>` anchors are missing — the model does omit them. The
            # numbers have to start at 1 and run consecutively, and the page has
            # to carry no anchors at all: a page whose anchors disagree is a
            # different question and is left alone rather than guessed at.
            tail = end
            while tail < len(source) and not source[tail].strip():
                tail += 1
            ends_page = tail >= len(source) or source[tail].strip() == "---"
            ordered = [number for number, _ in unique]
            # A restart at 1 is two lists that belong together (the model merges
            # a page's notes now and then); a *gap* is what marks a list that is
            # not a footnote list at all.
            consecutive = bool(ordered) and ordered[0] == 1 and numbers == set(range(1, max(numbers) + 1))
            covered = anchors <= numbers
            if numbers and (numbers == anchors or (ends_page and consecutive and covered)):
                changed += 1
                if recovered and recovered[-1].strip():
                    recovered.append("")
                recovered.append(">[!footnotes]")
        recovered.append(line)
        if line.strip() == "---":
            page_above = []
        else:
            page_above.append(line)
        index += 1
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(recovered))

    if re.search(r"\[!\s*(?:arabic[- ]?)?footnotes\s*\]", text, re.I):
        changed += len(re.findall(r"\[!\s*arabic[- ]?footnotes\s*\]", text, re.I))
        text = re.sub(r"\[!\s*(?:arabic[- ]?)?footnotes\s*\]", "[!footnotes]", text, flags=re.I)
    lines = text.split("\n")
    out: list[str] = []
    index = 0
    while index < len(lines):
        if not _FN_HEADER.match(lines[index]):
            out.append(lines[index])
            index += 1
            continue
        body: list[str] = []
        index += 1
        while index < len(lines):
            if _FN_HEADER.match(lines[index]):
                changed += 1
                index += 1
                continue
            if not lines[index].strip():
                # Another callout after the blank line is the same page's list.
                following = index
                while following < len(lines) and not lines[following].strip():
                    following += 1
                if following < len(lines) and _FN_HEADER.match(lines[following]):
                    changed += 1
                    index = following + 1
                    continue
                break
            if not lines[index].lstrip().startswith(">"):
                break
            if _FN_EMPTY_ITEM.match(lines[index]):
                index += 1
                continue
            anchor = _MD_ANCHOR_ITEM.match(lines[index])
            if anchor:
                # `> [^fn1]: 1 – …` — a markdown definition the model put inside
                # the callout it wrote for the same notes.
                digits = anchor.group("num") or re.sub(r"\D", "", anchor.group("key"))
                if digits:
                    canonical = f"> - {int(digits)} – {lines[index][anchor.end():]}"
                    if canonical != lines[index]:
                        changed += 1
                        lines[index] = canonical
                    md_keys.setdefault(anchor.group("key"), int(digits))
                    body.append(lines[index])
                    index += 1
                    continue
            item = _FN_ITEM.match(lines[index])
            number = _item_number(item) if item else None
            if number is not None:
                # Every item becomes the callout's list form (`> - 1 – …`): the
                # model writes `>1 – …`, `> ¹ – …` and `> *   1 – …`, and the
                # conversion has to settle, so an item already in the form is
                # left alone rather than counted as a change.
                canonical = f"> - {number} – {lines[index][item.end():]}"
                if canonical != lines[index]:
                    changed += 1
                    lines[index] = canonical
            body.append(lines[index])
            index += 1
        seen: set[str] = set()
        kept: list[str] = []
        for line in body:
            key = line.strip()
            if key in seen:
                changed += 1
                continue
            seen.add(key)
            kept.append(line)
        if kept:
            out.append(">[!footnotes]")
            out.extend(kept)
    # Dropping a duplicated header can leave the blank line that separated it
    # from the text above next to the one below; collapse at the end, so the
    # pass settles in one run (the second run must change nothing).
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out))
    if md_keys:
        # `[^3]` in the body pointed at a markdown footnote; the note's footnotes
        # are a callout now, so it becomes a plain superscript reference.
        def _anchor(match: re.Match) -> str:
            number = md_keys.get(match.group(1))
            return f"<sup>{number}</sup>" if number else match.group(0)

        text = re.sub(r"\[\^([^\]\s]+)\]", _anchor, text)
    return text, changed


#: A page label for the footnotes, in the shapes the model writes it: a bare
#: paragraph (`Footnotes:`), inside the blockquote that holds the items
#: (`> Footnotes:`, `>* Footnotes:`), with emphasis (`**Footnotes**`), or
#: naming the source language (`**Arabic Footnotes**`). The whole line has to be
#: the label — a sentence that mentions footnotes is prose.
_FOOTNOTE_LABEL = re.compile(
    r"(?mi)^[ \t]*(?P<quote>>[ \t]*)?\**[ \t]*(?:arabic[-_ \t]+)?footnotes?"
    r"[ \t]*\\?\[?\d{0,3}\]?[ \t]*:?[ \t]*\**[ \t]*$")

#: The same label set as a heading (`### Footnotes`).
_FOOTNOTE_HEADING = re.compile(
    r"(?mi)^[ \t]*>?[ \t]*#{1,6}[ \t]+\**[ \t]*(?:arabic[-_ \t]+)?footnotes?"
    r"[ \t]*:?[ \t]*\**$")

#: The number a definition starts with, in every form the model writes it:
#: `<sup>1</sup>`, `^(1)^`, `^(1)`, `1`, `¹`, `١` — and whether a dash follows.
_LEADING_NUMBER = re.compile(
    r"^[ \t]*(?:<sup>[ \t]*(?P<sup_tag>\d{1,3})[ \t]*</sup>"
    r"|\^\((?P<caret>\d{1,3})\)\^?"
    r"|(?P<digits>\d{1,3})"
    r"|(?P<super>[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+)"
    r"|(?P<arabic>[\u0660-\u0669]+))"
    r"[ \t]*(?P<dash>[\u2013\u2014-])?[ \t]*")

#: A markdown footnote definition: `[^1]: …`, `[^talhah-bio]: …`.
_MD_DEFINITION = re.compile(r"^[ \t]*\[\^(?P<key>[^\]\s]+)\]:[ \t]*")

#: The same, already inside a callout: `> [^fn1]: 1 – …`.
_MD_ANCHOR_ITEM = re.compile(
    r"^>[ \t]*\[\^(?P<key>[^\]\s]+)\]:[ \t]*(?:(?P<num>\d{1,3})[ \t]*[–—-][ \t]*)?")

#: The same, as it was: a marker and an optional dash.
_FOOTNOTE_DEFINITION = _LEADING_NUMBER

#: Superscript digits, as the model writes a footnote number.
_SUPERSCRIPT = {c: str(i) for i, c in enumerate("\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079")}

#: Arabic-Indic digits, which the model also uses for a footnote number.
_ARABIC_DIGITS = {c: str(i) for i, c in enumerate("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669")}


def _digits_to_int(digits: str) -> int | None:
    """A run of superscript or Arabic-Indic digits as a number."""
    mapped = "".join(_SUPERSCRIPT.get(char) or _ARABIC_DIGITS.get(char) or "" for char in digits)
    return int(mapped) if mapped else None

#: The model sometimes wraps the page's footnotes in literal tags instead of a
#: callout: `<arabic-footnotes>` … `</arabic-footnotes>`.
_FOOTNOTE_TAG = re.compile(
    r"(?mi)^[ \t]*<[ \t]*(?P<close>/)?[ \t]*(?:arabic[-_ ]*)?footnotes?[ \t]*>[ \t]*$")

#: An item the model wrote without its bullet: `>1 – …`.
_FN_NUMBER = r"(?:(\d{1,3})|([\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+)|([\u0660-\u0669]+))"

#: An item the model wrote without its bullet: `>1 – …`, `>1. – …`, `>¹ – …`.
_FN_PLAIN_ITEM = re.compile(r"^>[ \t]*" + _FN_NUMBER + r"(?:[ \t]*[–—-][ \t]*|\.[ \t]+)")

#: An item either way, for the page whose list never became a callout. The
#: bullet may be a star (`> *   1 – …`), which the model also writes.
_FN_ITEM = re.compile(
    r"^>[ \t]*(?:[-*+][ \t]*)?"
    r"(?:(\d{1,3})|([\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+)|([\u0660-\u0669]+))"
    r"(?:[ \t]*[–—-][ \t]*|\.[ \t]+)")


def _item_number(match: re.Match) -> int | None:
    """The number of a list item, whichever numeral form it was written in."""
    if match.group(1):
        return int(match.group(1))
    for group in (2, 3):
        digits = match.group(group) if (match.lastindex or 0) >= group else None
        if digits:
            return _digits_to_int(digits)
    return None


#: A blank line inside the blockquote, which separates two items of one list.
_FN_QUOTE_BLANK = re.compile(r"^>[ \t]*$")


def _footnote_run(lines: list[str], start: int) -> tuple[list[tuple[int, str]], int]:
    """The items of a blockquote list from `start`, and where it ends.

    A list's items are often separated by a bare `>` line, so those are part of
    the run rather than its end. Each item keeps its own line, because the model
    sometimes repeats one verbatim — a duplicate is not a second list.
    """
    items: list[tuple[int, str]] = []
    index = start
    while index < len(lines):
        match = _FN_ITEM.match(lines[index])
        number = _item_number(match) if match else None
        if number is not None:
            items.append((number, lines[index].strip()))
            index += 1
            continue
        if _FN_QUOTE_BLANK.match(lines[index]):
            index += 1
            continue
        break
    return items, index


#: A page heading: `#### p. 40`.
_PAGE_HEADING = re.compile(r"(?m)^#{4}\s*p\.?\s*\d+\s*$")

#: A footnote reference the page's text prints: `<sup>1</sup>`, `¹`, `١`.
_FOOTNOTE_MARK = re.compile(
    r"<sup>\s*(\d{1,3})\s*</sup>|([\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+)|([\u0660-\u0669]+)")


def _footnote_marks(text: str) -> set[int]:
    """The footnote numbers a page's own text refers to."""
    numbers: set[int] = set()
    for match in _FOOTNOTE_MARK.finditer(text):
        for group in (1, 2, 3):
            value = match.group(group)
            if not value:
                continue
            number = int(value) if group == 1 else _digits_to_int(value)
            # A footnote number, not a page number or a date.
            if number is not None and 1 <= number <= 50:
                numbers.add(number)
            break
    return numbers


def _page_footnote_block(lines: list[str], start: int, end: int):
    """The footnote callout inside a page, as (start, end, numbers)."""
    index = start
    while index < end:
        if _FN_HEADER.match(lines[index]):
            block_start = index
            index += 1
            numbers: set[int] = set()
            while index < end and lines[index].lstrip().startswith(">"):
                match = _FN_ITEM.match(lines[index])
                number = _item_number(match) if match else None
                if number is not None:
                    numbers.add(number)
                index += 1
            return block_start, index, numbers
        index += 1
    return None


def reassociate_footnotes(text: str) -> tuple[str, int]:
    """Move a footnote block back to the page whose text refers to it.

    A translation was requested two pages at a time, so when the model mislaid a
    page's footnote block it could only put it in the **next** page's section —
    never two pages away. The repair therefore looks exactly one page back, and
    only when the evidence is unambiguous:

      * the block's numbers are referred to in the page **above**, in its own
        text (`¹`, `<sup>1</sup>`, `١`);
      * the page holding the block does **not** refer to them itself;
      * the page above has no footnote block of its own — if it had, its notes
        would be there already.

    Anything less clear-cut is left exactly where the model put it.
    """
    moved = 0
    for _ in range(50):          # a note has a handful of these at most
        text, one = _move_one_footnote_block(text)
        if not one:
            break
        moved += one
    return text, moved


def _move_one_footnote_block(text: str) -> tuple[str, int]:
    lines = text.split("\n")
    heads = [index for index, line in enumerate(lines) if _PAGE_HEADING.match(line)]
    for position in range(1, len(heads)):
        start = heads[position]
        end = heads[position + 1] if position + 1 < len(heads) else len(lines)
        found = _page_footnote_block(lines, start, end)
        if not found:
            continue
        block_start, block_end, numbers = found
        if not numbers:
            continue
        if _footnote_marks("\n".join(lines[start:block_start])) & numbers:
            continue                                   # this page cites them
        previous = heads[position - 1]
        if _page_footnote_block(lines, previous, start):
            continue                                   # the page above has its own
        if not numbers <= _footnote_marks("\n".join(lines[previous:start])):
            continue
        block = lines[block_start:block_end]
        del lines[block_start:block_end]
        # The page above ends at its own page rule; the block goes just before it.
        rule = start - 1
        while rule > previous and not lines[rule].strip():
            rule -= 1
        insert_at = rule if lines[rule].strip() == "---" else start
        piece = list(block)
        if insert_at > 0 and lines[insert_at - 1].strip():
            piece.insert(0, "")
        lines[insert_at:insert_at] = piece + [""]
        joined = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
        # Taking the block out of the page it was in can leave that page's rule
        # next to the next page's: two rules in a row is one page boundary.
        joined = re.sub(r"(?m)^---[ \t]*\n(?:[ \t]*\n)*---[ \t]*$", "---", joined)
        return joined, 1
    return text, 0


def _definition_number(match: re.Match) -> int:
    """The number a definition starts with, in any of its forms."""
    groups = match.groupdict()
    if groups.get("sup_tag") or groups.get("caret") or groups.get("digits"):
        return int(groups["sup_tag"] or groups["caret"] or groups["digits"])
    return _digits_to_int(groups.get("super") or groups.get("arabic") or "") or 0


#: A horizontal rule in any of its spellings, and the `<br>` the model sprinkles
#: around a section it is marking off. `---` is the page rule and is kept;
#: `***`, `___` and `<br>` are the model's own separators and go with the notes.
_RULE_LINE = re.compile(r"^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$")
_PAGE_RULE = re.compile(r"^[ \t]*-{3,}[ \t]*$")
_BR_LINE = re.compile(r"(?i)^[ \t]*<br[ \t/]*>[ \t]*$")
_SOFT_SEPARATOR = re.compile(r"^[ \t]*(?:\*{3,}|_{3,})[ \t]*$")


def _is_separator(line: str) -> bool:
    return bool(_RULE_LINE.match(line)) or bool(_BR_LINE.match(line))


def _is_soft(line: str) -> bool:
    return bool(_SOFT_SEPARATOR.match(line)) or bool(_BR_LINE.match(line))


def _last_non_blank(lines: list[str]) -> str:
    for line in reversed(lines):
        if line.strip() and not _BR_LINE.match(line):
            return line.strip()
    return ""


def _definition_start(line: str):
    """(number, key, end offset, certain) when the line starts a definition.

    A markdown footnote (`[^3]: …`) and a number followed by a dash
    (`^(3)^ – …`, `3 - …`, `³ – …`) are definitions wherever they stand. A bare
    marker (`³ Al-Jalālayn`) only counts inside a fenced or final section, where
    the section itself is the evidence.
    """
    markdown = _MD_DEFINITION.match(line)
    if markdown:
        return None, markdown.group("key"), markdown.end(), True
    number = _LEADING_NUMBER.match(line)
    if number:
        dashed = bool(number.group("dash"))
        marker = bool(number.group("sup_tag") or number.group("super") or number.group("arabic"))
        if dashed or marker:
            return _definition_number(number), None, number.end(), dashed
    return None


def _definitions_to_callout(lines: list[str]) -> tuple[list[str], int, dict[str, int]]:
    """Collect a page's footnote definitions into its callout.

    The definitions are written in several shapes — `¹ *Al-Jalālayn*`,
    `^(1)^ – …`, `[^1]: …`, `[^talhah-bio]: …` — sometimes behind a `---` that
    looks like a page break, sometimes with no heading at all. They all become
    the page's `>[!footnotes]` items, and a markdown footnote's anchors are
    turned into superscript references, since a callout item is not a footnote
    Obsidian can link to.
    """
    changed = 0
    numbers_by_key: dict[str, int] = {}
    used: set[int] = set()

    def number_for(key: str | None, number: int | None) -> int:
        if key is None:
            if number:
                used.add(number)
            return number or 0
        if key in numbers_by_key:
            return numbers_by_key[key]
        if key.isdigit():
            value = int(key)
        else:
            value = 1
            while value in used:
                value += 1
        numbers_by_key[key] = value
        used.add(value)
        return value

    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        start = _definition_start(line) if line.strip() else None
        if not start:
            out.append(line)
            index += 1
            continue
        run: list[tuple[int, list[str]]] = []
        position = index
        while position < len(lines):
            scan = position
            while scan < len(lines) and (not lines[scan].strip() or _is_soft(lines[scan])):
                scan += 1
            if scan >= len(lines):
                break
            found = _definition_start(lines[scan])
            if not found:
                break
            paragraph: list[str] = []
            cursor = scan + 1
            while cursor < len(lines) and lines[cursor].strip():
                if _definition_start(lines[cursor]) or _is_separator(lines[cursor]):
                    break
                paragraph.append(lines[cursor])
                cursor += 1
            run.append((number_for(found[1], found[0]), paragraph))
            # The first line carries the number; the rest is its text.
            first = lines[scan][found[2]:]
            run[-1] = (run[-1][0], [first] + paragraph)
            position = cursor
        if not run:
            out.append(line)
            index += 1
            continue
        after = position
        while after < len(lines) and (not lines[after].strip() or _BR_LINE.match(lines[after])):
            after += 1
        ends_page = (after >= len(lines)
                     or bool(_RULE_LINE.match(lines[after]))
                     or lines[after].lstrip().startswith("#")
                     or bool(_FN_HEADER.match(lines[after])))
        follows_rule = _is_separator(_last_non_blank(out))
        certain = start[3]
        if not (certain or follows_rule or ends_page):
            out.append(line)
            index += 1
            continue
        # The model's own separators around the section go with it, and so does
        # a rule in front of it — that is the section's edge, not a page break.
        while out and (not out[-1].strip() or _is_soft(out[-1])):
            out.pop()
        if follows_rule and out and _RULE_LINE.match(out[-1]):
            out.pop()
            while out and (not out[-1].strip() or _is_soft(out[-1])):
                out.pop()
        if out and out[-1].strip():
            out.append("")
        out.append(">[!footnotes]")
        for number, paragraph in run:
            text = paragraph[0].strip()
            for extra in paragraph[1:]:
                text = f"{text}\n> {extra}" if text else extra
            out.append(f"> - {number} – {text}")
        tail = position
        while tail < len(lines) and (not lines[tail].strip() or _is_soft(lines[tail])):
            tail += 1
        if tail > position:
            position = tail
            if out and out[-1].strip():
                out.append("")
        index = position
        changed += 1
    return out, changed, numbers_by_key


#: A verse link with no verse in it — `[[Q # ]]`, `[[Q022#]]`. Nothing can be
#: read from it, and it renders as a broken citation, so it is dropped.
_MALFORMED_VERSE_LINK = re.compile(
    r"\[\[\s*(?:Q[A-Z]{0,2})?\d{0,3}\s*#(?![^\]]*\d)[^\]]*\]\]")


def strip_malformed_verse_links(text: str) -> tuple[str, int]:
    count = len(_MALFORMED_VERSE_LINK.findall(text))
    return _MALFORMED_VERSE_LINK.sub("", text), count


def unwrap_quran_quotes(text: str) -> str:
    """Remove Markdown Attributes wrappers from ornate Qur'ān parentheses.

    The note keeps only ``﴿ ... ﴾``; the plugin decorates those ranges in Live
    Preview and Reading view. Existing citation links after the parentheses are
    left in place. A quote that crosses a page break carries only one of the two
    marks, and its legacy ``*`` wrapper is removed on that side too, so each
    half is styled by the plugin's open/close rule.
    """
    text, _malformed = strip_malformed_verse_links(text)
    # A star touching an ornate paren is quotation markup in either write order:
    # in a translated line the pair is reversed, and a star on the *other* side
    # of the paren was left behind — which is what opened italics across the
    # following prose.
    text = re.sub(r"\*+(?=[\ufd3f\ufd3e])", "", text)
    text = re.sub(r"(?<=[\ufd3f\ufd3e])\*+", "", text)
    text = _QURAN_WRAPPED.sub(lambda m: f"﴿{m.group(1)}﴾", text)
    text = _QURAN_CLASS.sub("", text)
    # A half whose link was already added sometimes keeps a stray closing mark
    # glued to the citation: `([[…#86|…]])آ﴾`.
    text = re.sub(r"(\]\]\))([^\s﴿]{1,4}﴾)", r"\1", text)
    # A page's printed verse number after the citation — `[[Q022#5]](٥)` — is
    # the source's own numeration: the link already says which verse it is.
    # (This used to be swallowed by the quotation span, which is why a citation
    # could lose its digits; the span no longer reaches a link.)
    text = re.sub(
        r"(\[\[[^\]\n]*#\d+[^\]\n]*\]\])\s*[\(\[]\s*[\u0660-\u0669\d]+\s*[\)\]]",
        r"\1", text)
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
    text = re.sub(r"(?<=﴾)\*+", "", text)
    # A paragraph that is only a quotation becomes a `mas-quran` callout. This
    # runs here, in the one function every genre calls to finish its quotations,
    # so a tafsīr, a book and a translation present Qur'ān quotations the same
    # way and the plugin has one callout type to style.
    text = strip_quote_emblems(text)
    # `([[Q022#5]])` → `[[Q022#5]]`: the link is the citation, the box is drawn
    # around it, so literal parentheses would print outside the box.
    text = re.sub(r"\(\s*(\[\[[^\]\n]*#\d+[^\]\n]*\]\])\s*\)", r"\1", text)
    text, _callouts = blockquote_full_paragraphs(text)
    return text


_QURAN_LINK = r"\[\[Q?\d{3}[^\]\n]*\]\]"


def cleanup_quran_citations(text: str) -> str:
    """Remove duplicated wikilinks and bracket debris after Qur'ān citations."""
    pattern = re.compile(rf"({_QURAN_LINK})(?:\s*[\(\)\]]*\s*\(?\s*)\1")
    while True:
        next_text = pattern.sub(r"\1", text)
        if next_text == text:
            break
        text = next_text
    # A source citation that repeats the one already there: `[[Q003#152]]
    # (3:152)`. The link is authoritative, so the parenthesis adds nothing.
    text = re.sub(
        rf"({_QURAN_LINK})\s*\(\s*\d{{1,3}}\s*:\s*\d{{1,3}}\s*\)",
        r"\1", text)
    text = re.sub(rf"({_QURAN_LINK}\))[\)\]]{{2,}}", r"\1", text)
    text = re.sub(rf"({_QURAN_LINK}\))\s+[\)\]]+", r"\1", text)
    text = re.sub(r"–\\\[\]\)?", "", text)
    # Brackets crowded after a link are the source's citation wrapper:
    # `[[Q003#152]]]` is one link and one stray bracket. This runs last, because
    # dropping the parenthetical citation is what exposes the bracket.
    text = re.sub(rf"({_QURAN_LINK})\]+", r"\1", text)
    return re.sub(r"(﴾)\s*[\]\)–\\\[]+(?=\s|$)", r"\1", text)





