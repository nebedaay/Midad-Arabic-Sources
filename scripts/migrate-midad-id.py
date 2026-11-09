#!/usr/bin/env python3
"""Fold the retired midad-kind/work/unit properties into a comprehensive midad-id.

The id grammar is documented in `src/sourceIds.ts`:

  repo/<collection>/<work-id>
  zotero/<zotero-id>/<transcription|translation>[/<unit>]
  pdf/<pdf-key>/<transcription|translation>[/<unit>]
  adopted/<uuid>

This is a one-time vault migration. Every changed note is copied under
`.midad-arabic-sources/backups/id-migration-<timestamp>/` first.

Usage:
  python3 scripts/migrate-midad-id.py [--dry-run]
"""
from __future__ import annotations

import shutil
import sys
from datetime import datetime
from pathlib import Path

VAULT = Path(__file__).resolve().parents[3]
BACKUPS = VAULT / ".midad-arabic-sources" / "backups"
RETIRED = ("midad-kind", "midad-work", "midad-unit")


def frontmatter_end(text: str) -> int:
    if not text.startswith("---"):
        return -1
    return text.find("\n---", 3)


def scalar(fm: str, key: str) -> str:
    import re
    match = re.search(rf'^{re.escape(key)}:\s*"?(.*?)"?\s*$', fm, re.M)
    return match.group(1).strip() if match else ""


def comprehensive_id(fm: str) -> str:
    current = scalar(fm, "midad-id").replace(":", "/").strip("/")
    kind = scalar(fm, "midad-kind").strip()
    work = scalar(fm, "midad-work").replace(":", "/").strip("/")
    unit = scalar(fm, "midad-unit").strip()
    if kind in ("transcription", "translation") and work:
        base = work
        if unit and unit != "note" and not base.endswith("/" + unit):
            return f"{base}/{unit}"
        return current or base
    if kind == "adopted" and not current:
        return work or "adopted/unknown"
    if kind == "repo-work" and not current and work:
        return f"repo/{work}"
    return current


def rewrite(path: Path, dry: bool, stamp: str) -> bool:
    text = path.read_text(encoding="utf-8")
    end = frontmatter_end(text)
    if end == -1:
        return False
    fm, body = text[:end], text[end:]
    import re
    retired = any(re.search(rf'^{key}:', fm, re.M) for key in RETIRED)
    current = scalar(fm, "midad-id")
    if not retired and (not current or ":" not in current):
        return False
    new_id = comprehensive_id(fm)
    if not new_id:
        print(f"SKIP (no derivable id): {path.relative_to(VAULT)}")
        return False
    lines = fm.splitlines()
    out = []
    replaced = False
    for line in lines:
        key = re.match(r'^([A-Za-z][\w-]*):', line)
        name = key.group(1) if key else ""
        if name == "midad-id":
            out.append(f'midad-id: "{new_id}"')
            replaced = True
        elif name in RETIRED:
            continue
        else:
            out.append(line)
    if not replaced:
        # Put the id with the other generated identity properties, after midad-up
        # when it has a block, otherwise at the top.
        index = 0
        for i, line in enumerate(out):
            if line.startswith("midad-up:"):
                i += 1
                while i < len(out) and out[i].startswith((" ", "\t")):
                    i += 1
                index = i
                break
        out.insert(index, f'midad-id: "{new_id}"')
    new_text = "\n".join(out) + body
    if not dry:
        target = BACKUPS / f"id-migration-{stamp}" / path.relative_to(VAULT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        path.write_text(new_text, encoding="utf-8")
    print(f"{'DRY ' if dry else ''}{path.relative_to(VAULT)} -> {new_id}")
    return True


def main() -> int:
    dry = "--dry-run" in sys.argv
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    changed = 0
    for path in sorted(VAULT.rglob("*.md")):
        rel = path.relative_to(VAULT)
        if any(part.startswith(".") for part in rel.parts):
            continue
        try:
            if rewrite(path, dry, stamp):
                changed += 1
        except FileNotFoundError:
            continue
        except Exception as error:
            print(f"ERROR {rel}: {error}")
    print(f"\n{'Would change' if dry else 'Changed'} {changed} note(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
