#!/usr/bin/env python3
"""Migrate the old short topic labels to the expanded taxonomy.

Old → new:
  ʿAqīda      → Doctrine (ʿaqīda)
  Tārīkh      → History (Tārīkh)
  Language    → Language (lugha)
  Dictionaries → Dictionaries and Lexicons
  Adab/al-Adab → Adab & adhkār

Renames the topic MOC pages, rewrites topic links and `topics:` values, and
adds backward-compatible aliases. Backups go under
`.midad-arabic-sources/backups/topic-taxonomy-<timestamp>/`.

Usage: python3 scripts/migrate-topic-taxonomy.py [--dry-run]
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VAULT = REPO.parents[1]
SOURCE_ROOT = VAULT / "_7 Sources"
TOPIC_DATA_PATH = REPO / "midad-arabic-sources-import-templates" / "topics.json"
PREFIX = "Midad topic - "
ALIASES = json.loads(TOPIC_DATA_PATH.read_text(encoding="utf-8"))["aliases"]


def label(value: str) -> str:
    text = value.strip().strip('"').strip("'")
    if text.startswith(PREFIX):
        text = text[len(PREFIX):]
    if text.endswith(" Sources"):
        text = text[:-len(" Sources")]
    text = text.strip()
    return ALIASES.get(text, text)


def frontmatter_end(text: str) -> int:
    return text.find("\n---", 3) if text.startswith("---") else -1


def field_block(fm: str, key: str) -> tuple[int, int] | None:
    m = re.search(rf"^{re.escape(key)}:[ \t]*\n((?:[ \t]+-[ \t]*.*\n?)*)", fm, re.M)
    return (m.start(), m.end()) if m else None


def main() -> int:
    dry = "--dry-run" in sys.argv
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = VAULT / ".midad-arabic-sources" / "backups" / f"topic-taxonomy-{stamp}"
    changed = 0

    # 1. Rename topic pages.
    for path in sorted(SOURCE_ROOT.glob(f"{PREFIX}*.md")):
        old = path.stem
        new_label = label(old)
        new = f"{PREFIX}{new_label}"
        if new == old:
            continue
        target = SOURCE_ROOT / f"{new}.md"
        if target.exists():
            # Keep user content; otherwise the generated duplicate can go.
            text = path.read_text(encoding="utf-8")
            managed = re.search(r'<span class="mas-managed">mas-managed</span>[\s\S]*?<span class="mas-managed">/mas-managed</span>', text)
            outside = text.replace(managed.group(0), "") if managed else text
            if outside.startswith("---"):
                end = outside.find("\n---", 3)
                if end >= 0:
                    outside = outside[end + 4:]
            if outside.strip():
                print(f"KEEP user content: {path.name}")
                continue
            if not dry:
                path.unlink()
            print(f"{'DRY ' if dry else ''}delete old duplicate {path.name}")
        else:
            if not dry:
                path.rename(target)
            print(f"{'DRY ' if dry else ''}rename {path.name} -> {target.name}")
        if not dry:
            text = target.read_text(encoding="utf-8") if target.exists() else ""
            end = frontmatter_end(text)
            if end >= 0:
                fm, body = text[:end], text[end:]
                block = field_block(fm, "aliases")
                wanted = [new_label, old, old[len(PREFIX):]]
                if block:
                    existing = fm[block[0]:block[1]]
                    additions = [f'  - "{v}"' for v in wanted if v and f'"{v}"' not in existing]
                    if additions:
                        fm = fm[:block[1]].rstrip("\n") + "\n" + "\n".join(additions) + "\n" + fm[block[1]:]
                else:
                    fm = fm.rstrip("\n") + "\naliases:\n" + "".join(f'  - "{v}"\n' for v in wanted if v)
                target.write_text(fm + body, encoding="utf-8")

    # 2. Rewrite links, aliases, and topics values.
    for path in sorted(VAULT.rglob("*.md")):
        rel = path.relative_to(VAULT)
        if any(part.startswith(".") for part in rel.parts) or rel.parts[0] != "_7 Sources":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (FileNotFoundError, UnicodeDecodeError):
            continue
        original = text
        text = re.sub(
            rf"\[\[{re.escape(PREFIX)}([^\]|]+)(?:\|[^\]]*)?\]\]",
            lambda m: f"[[{PREFIX}{label(m.group(1))}|{label(m.group(1))}]]",
            text,
        )
        text = re.sub(
            rf"\[\[({re.escape('ʿAqīda')}|{re.escape('Tārīkh')}|{re.escape('Language')}|{re.escape('Dictionaries')}|Adab|al-Adab)(?:\|[^\]]*)?\]\]",
            lambda m: f"[[{PREFIX}{label(m.group(1))}|{label(m.group(1))}]]",
            text,
        )
        end = frontmatter_end(text)
        if end >= 0:
            fm, body = text[:end], text[end:]
            block = field_block(fm, "topics")
            if block:
                raw_values = []
                values = []
                for line in fm[block[0]:block[1]].splitlines()[1:]:
                    item = re.match(r'^[ \t]+-[ \t]*(.*)$', line)
                    if item:
                        raw = item.group(1).strip().strip('"').strip("'")
                        if raw and raw not in raw_values:
                            raw_values.append(raw)
                        value = label(raw)
                        if value and value not in values:
                            values.append(value)
                if values != raw_values:
                    fm = fm[:block[0]] + "topics:\n" + "".join(f'  - "{v}"\n' for v in values) + fm[block[1]:]
            text = fm + body
        if text != original:
            changed += 1
            if not dry:
                dest = backup / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(original, encoding="utf-8")
                path.write_text(text, encoding="utf-8")
            print(f"{'DRY ' if dry else ''}{rel}")

    print(f"\n{'Would change' if dry else 'Changed'} {changed} note(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
