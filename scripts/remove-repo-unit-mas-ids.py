#!/usr/bin/env python3
"""Remove per-unit mas-id properties from repository notes.

Repository works are tracked by their hub (`repo:<collection>:<id>`); the
individual sūra/chapter/root notes do not need identities of their own. This
cleans up the properties added during the initial mas-id rollout.
"""
import argparse
import os
import re
from pathlib import Path

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
PROPS = ("mas-id", "mas-kind", "mas-work", "mas-unit")


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove per-unit mas-id properties from repository notes.")
    parser.add_argument("--source-root", default="_7 Sources")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = VAULT / args.source_root / "Installed Sources"
    changed = 0
    for note in root.rglob("*.md"):
        try:
            text = note.read_text(encoding="utf-8")
        except Exception:
            continue
        if not text.startswith("---"):
            continue
        end = text.find("\n---", 3)
        if end < 0:
            continue
        fm = text[:end]
        if not re.search(r'^mas-kind:\s*"?repo-unit"?\s*$', fm, re.M):
            continue
        lines = [line for line in fm.splitlines() if not any(re.match(rf'^{re.escape(p)}:', line) for p in PROPS)]
        updated = "\n".join(lines) + text[end:]
        if updated != text:
            changed += 1
            print(f"  clean: {note.relative_to(VAULT)}")
            if not args.dry_run:
                note.write_text(updated, encoding="utf-8")
    print(f"{'Would clean' if args.dry_run else 'Cleaned'} {changed} note(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
