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


def normalize_managed_marker_spacing(text: str) -> str:
    """Keep mas-managed marker lines on their own blank-line-separated block."""
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
    return "\n".join(out)


MANAGED_OPEN = '<span class="mas-managed">mas-managed</span>'
MANAGED_CLOSE = '<span class="mas-managed">/mas-managed</span>'
LEGACY_MANAGED_OPEN = "%%mas-managed%%"
LEGACY_MANAGED_CLOSE = "%%/mas-managed%%"


def wrap_managed_body(body: str) -> str:
    """The one canonical wrapper for generated managed content."""
    return f"{MANAGED_OPEN}\n\n{body.strip()}\n\n{MANAGED_CLOSE}"
