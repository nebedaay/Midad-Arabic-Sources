#!/usr/bin/env python3
"""Migrate topic MOCs and topic links to the `Midad topic - <label>` scheme.

- Renames every topic MOC (`Tafsīr Sources.md`, `Dictionaries.md`, …) to
  `Midad topic - <label>.md`.
- Normalizes links to `[[Midad topic - <label>|<label>]]`.
- Normalizes `topics:` values to the short label.
- Adds the corresponding topic MOC to `midad-up` on every note that has a
  `topics:` property.

Every changed note is backed up under
`.midad-arabic-sources/backups/topic-migration-<timestamp>/`.

Usage: python3 scripts/migrate-topic-mocs.py [--dry-run]
"""
from __future__ import annotations

import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

VAULT = Path(__file__).resolve().parents[3]
SOURCE_ROOT = VAULT / "_7 Sources"
TOPICS_NOTE = "Midad Arabic Sources - Topics"
PREFIX = "Midad topic - "


def label(value: str) -> str:
    text = value.strip().strip('"').strip("'")
    if text.startswith("[[") and text.endswith("]]"):
        text = text[2:-2].split("|", 1)[0]
    if text.startswith(PREFIX):
        text = text[len(PREFIX):]
    if text == "Qurʾān (text)" or text == "Qurʾān Translations":
        text = "Qurʾān text and translations"
    if text.endswith(" Sources"):
        text = text[:-len(" Sources")]
    return text.strip()


def frontmatter_end(text: str) -> int:
    return text.find("\n---", 3) if text.startswith("---") else -1


def field_block(fm: str, key: str) -> tuple[int, int] | None:
    match = re.search(rf"^{re.escape(key)}:[ \t]*\n((?:[ \t]+-[ \t]*.*\n?)*)", fm, re.M)
    return (match.start(), match.end()) if match else None


def topic_values(fm: str) -> list[str]:
    block = field_block(fm, "topics")
    if not block:
        single = re.search(r"^topics:\s*(.+)$", fm, re.M)
        value = single.group(1).strip() if single else ""
        if not value or value in ("[]", '""', "''"):
            return []
        return [label(value)]
    values = []
    for line in fm[block[0]:block[1]].splitlines()[1:]:
        item = re.match(r"^[ \t]+-[ \t]*(.*)$", line)
        if item:
            value = label(item.group(1))
            if value and value not in values:
                values.append(value)
    return values


def add_up_topics(fm: str, topics: list[str]) -> str:
    if not topics:
        return fm
    block = field_block(fm, "midad-up")
    if not block:
        return fm
    existing = fm[block[0]:block[1]]
    additions = []
    for topic in topics:
        target = f"[[{PREFIX}{topic}]]"
        if target in existing:
            continue
        additions.append(f'  - "[[{PREFIX}{topic}|{topic}]]"')
    if not additions:
        return fm
    return fm[:block[1]] + "\n".join(additions) + "\n" + fm[block[1]:]


def replace_links(text: str) -> str:
    # Every Midad-topic link displays only the short label.
    def fix(match: re.Match) -> str:
        target = match.group(1)
        short = label(target)
        return f"[[{target}|{short}]]"

    text = re.sub(r"\[\[(" + re.escape(PREFIX) + r"[^\]|]+)(?:\|[^\]]*)?\]\]", fix, text)
    return text


def main() -> int:
    dry = "--dry-run" in sys.argv
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backups = VAULT / ".midad-arabic-sources" / "backups" / f"topic-migration-{stamp}"

    # 1. Find topic MOCs by their parent link.
    topic_files: list[Path] = []
    for path in sorted(SOURCE_ROOT.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        end = frontmatter_end(text)
        if end == -1:
            continue
        fm = text[:end]
        if re.search(rf"^  - \"?\[\[{re.escape(TOPICS_NOTE)}\]\]\"?\s*$", fm, re.M):
            topic_files.append(path)

    renames: dict[str, str] = {}
    for path in topic_files:
        old = path.stem
        new = f"{PREFIX}{label(old)}"
        if old != new:
            renames[old] = new

    if dry:
        for old, new in renames.items():
            print(f"DRY rename {old}.md -> {new}.md")
    else:
        for old, new in renames.items():
            source = SOURCE_ROOT / f"{old}.md"
            target = SOURCE_ROOT / f"{new}.md"
            if source.exists() and not target.exists():
                source.rename(target)

    # Keep the old page name and the short topic label as aliases on the new
    # topic MOC, so existing links and Obsidian autocomplete stay useful.
    for old, new in renames.items():
        if dry:
            continue
        path = SOURCE_ROOT / f"{new}.md"
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        end = frontmatter_end(text)
        if end == -1:
            continue
        fm, body = text[:end], text[end:]
        block = field_block(fm, "aliases")
        wanted = [label(old), old]
        if block:
            existing = fm[block[0]:block[1]]
            additions = [f'  - "{value}"' for value in wanted if value and f'"{value}"' not in existing]
            if additions:
                fm = fm[:block[1]] + "\n".join(additions) + "\n" + fm[block[1]:]
        else:
            fm = fm.rstrip("\n") + "\naliases:\n" + "".join(f'  - "{v}"\n' for v in wanted if v)
        path.write_text(fm + body, encoding="utf-8")

    # 2. Build link maps for old and new targets.
    link_map: dict[str, str] = {}
    for old, new in renames.items():
        link_map[old] = new
    for path in topic_files:
        old = path.stem
        if old in renames:
            continue
        new = f"{PREFIX}{label(old)}"
        if new != old:
            link_map[old] = new

    changed = 0
    for path in sorted(VAULT.rglob("*.md")):
        rel = path.relative_to(VAULT)
        if any(part.startswith(".") for part in rel.parts) or rel.parts[0] in ("tmp", "src", "AI OS"):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (FileNotFoundError, UnicodeDecodeError):
            continue
        if not text.startswith("---"):
            continue
        end = frontmatter_end(text)
        if end == -1:
            continue
        fm, body = text[:end], text[end:]
        original = text

        # Rename topic links, with or without an alias.
        for old, new in link_map.items():
            if old.startswith(PREFIX):
                continue
            short = label(old)
            replacement = f"[[{new}|{short}]]"
            fm = re.sub(rf"\[\[{re.escape(old)}(?:\|[^\]]*)?\]\]", replacement, fm)
            body = re.sub(rf"\[\[{re.escape(old)}(?:\|[^\]]*)?\]\]", replacement, body)
        fm = replace_links(fm)
        body = replace_links(body)

        # Normalize topics: values and the midad-up links.
        topics = topic_values(fm)
        block = field_block(fm, "topics")
        if block and topics:
            replacement = "topics:\n" + "".join(f'  - "{topic}"\n' for topic in topics)
            fm = fm[:block[0]] + replacement + fm[block[1]:]
        elif not block and topics:
            fm = re.sub(
                r"^topics:\s*.+$",
                "topics:\n" + "".join(f'  - "{v}"\n' for v in topics).rstrip("\n"),
                fm, count=1, flags=re.M,
            )
        fm = add_up_topics(fm, topics)

        new_text = fm + body
        if new_text != original:
            changed += 1
            if not dry:
                target = backups / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(original, encoding="utf-8")
                path.write_text(new_text, encoding="utf-8")
            print(f"{'DRY ' if dry else ''}{rel}")

    print(f"\n{'Would change' if dry else 'Changed'} {changed} note(s); renamed {len(renames)} topic MOC(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
