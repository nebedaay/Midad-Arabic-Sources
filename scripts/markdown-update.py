#!/usr/bin/env python3
"""Update formatting in an already-rendered Markdown note.

This is the Markdown layer, separate from acquisition/rendering. It receives
final Markdown, not raw OCR or a JSON render model. Existing links, TOC anchors,
callouts, and code fences are treated as already correct; only safe updates are
applied.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from importlib.machinery import SourceFileLoader
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from text_postprocess import escape_literal_brackets


def _load(name: str):
    path = SCRIPTS / name
    return SourceFileLoader(path.stem, str(path)).load_module()


def _split_frontmatter(text: str) -> tuple[str, str]:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[:end + 4], text[end + 4:]
    return "", text


def _protect_fences(text: str) -> tuple[str, list[str]]:
    fences: list[str] = []

    def park(match: re.Match) -> str:
        fences.append(match.group(0))
        return f"\x10{len(fences) - 1}\x11"

    text = re.sub(r"(?ms)^(```|~~~).*?^\1[ \t]*$", park, text)
    return text, fences


def _restore_fences(text: str, fences: list[str]) -> str:
    for i, fence in enumerate(fences):
        text = text.replace(f"\x10{i}\x11", fence)
    return text


def update_markdown(text: str, *, quran: bool = True, tafsir: bool = False) -> str:
    """Apply the guarded Markdown-update layer."""
    body, fences = _protect_fences(text)
    if quran:
        tfq = _load("transcription-quran.py")
        body, _ = tfq.discover_and_mark_quotes(body, tafsir=tafsir)
        body, _ = tfq.add_missing_refs(body)
        body, _ = tfq.fix_wikilinks(body)
    body = escape_literal_brackets(body)
    # The source formatter's spacing rules are block-level and idempotent; the
    # raw-only page-number, OCR-heading, poetry, footnote, and TOC conversions
    # deliberately do not run here.
    fmt = _load("transcription-format.py")
    body = fmt.normalize_spacing(body)
    body = _restore_fences(body, fences)
    return body


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Update formatting in an existing Markdown note.")
    parser.add_argument("note")
    parser.add_argument("--in-place", action="store_true")
    parser.add_argument("--no-quran", action="store_true")
    parser.add_argument("--tafsir", action="store_true")
    parser.add_argument("--backup-dir", default=None)
    args = parser.parse_args(argv)

    note = Path(args.note).resolve()
    original = note.read_text(encoding="utf-8")
    yaml, body = _split_frontmatter(original)
    updated = update_markdown(body, quran=not args.no_quran, tafsir=args.tafsir)
    result = yaml + updated
    changed = result != original
    if changed:
        if args.backup_dir:
            backup = Path(args.backup_dir)
            backup.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            shutil.copy2(note, backup / f"{stamp}-{note.name}")
        note.write_text(result, encoding="utf-8")
    print(json.dumps({"event": "result", "result": {"notes": [str(note)] if changed else []}}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
