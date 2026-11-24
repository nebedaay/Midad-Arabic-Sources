#!/usr/bin/env python3
"""Rename the Qur'ān sūra notes to their citation names.

A citation is written `[[Q024#10]]`, and Obsidian resolves a link by the note's
**bare file name**, so the canonical Ḥafṣ notes become `Q001.md … Q114.md` and
each riwāya's become `QW001.md …` (Warsh), `QQ001.md …` (Qālūn), and so on. The
letter comes from `VERSE_PREFIXES` in `text-source-import.py`, which mirrors
`RIWAYA_PREFIXES` in `src/quran/citationFormat.ts`.

Two things change beyond the file name:

* **The model's unit `base`**, because that is what the renderer writes as the
  note name and links to. Rewriting it here means a later re-render reproduces
  the new names instead of the old ones.
* **Every link to a sūra**, in the models and in the rendered notes, is
  retargeted: `[[024 An-Nur#10|النور : ١٠]]` becomes `[[Q024#10|النور : ١٠]]`.
  The display text stays — the plugin computes it from the reader's settings now,
  so an alias only matters to a reader without the plugin, and some aliases carry
  meaning that must survive (a riwāya's bold `**[[Q001#7|Ḥafṣ 7]]**` correspondence
  marker). Retargeting the notes directly, rather than re-rendering 877 files, is
  what makes the migration quick.

Nothing is written until `--apply`. With `--apply` the notes are first copied to
`.midad-arabic-sources/backups/quran-rename-<timestamp>/`, so the whole rename
can be undone by copying them back and renaming in reverse.

    python3 scripts/migrate-quran-note-names.py            # report only
    python3 scripts/migrate-quran-note-names.py --apply    # do it
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from pathlib import Path

VAULT = Path(__file__).resolve().parents[3]
STATE = VAULT / ".midad-arabic-sources"

# Kept in step with `VERSE_PREFIXES` in `text-source-import.py`.
VERSE_PREFIXES = {
    "hafs": "Q", "warsh": "QW", "qalun": "QQ", "hamza": "QH",
    "ibnkathir": "QI", "abuamr": "QA", "kisai": "QK", "khalaf": "QX",
    "duri": "QD", "shubah": "QS", "susi": "QU",
}

# A sūra note before the rename: `024 An-Nur.md` (canonical) or
# `Qurʾān (riwāyat Warsh) (quran-json) - 024 An-Nur.md` (a riwāya).
LEGACY_CANONICAL = re.compile(r"^(\d{3})\s+\S.*$")
LEGACY_PREFIXED = re.compile(r"^.+?\s-\s(\d{3})\s+\S.*$")

# Folders whose notes are searched for links to sūras. The plugin's own scripts
# and the synced docs are excluded: those are source files, not notes.
NOTE_FOLDERS = [
    "_7 Sources", "_1 General", "_2 Bibliographic notes", "_3 Work",
    "_4 Projects", "_5 Research Materials", "_6 Personal", "_8 Daily Notes",
    "_9 IAFR", "AI OS", "Authors", "Clippings",
]
ROOT_NOTES = True


def canonical_folder() -> Path:
    """The canonical Ḥafṣ sūra folder, as the importer finds it."""
    for candidate in (
        "_7 Sources/Installed Sources/Quran",
        "Midad Arabic Sources/Installed Sources/Quran",
        "_7 Sources/Quran",
    ):
        if (VAULT / candidate).is_dir():
            return VAULT / candidate
    return VAULT / "_7 Sources/Installed Sources/Quran"


def riwaya_prefix(folder: Path, work_id: str = "") -> str | None:
    """The sūra prefix of a riwāya folder, or None when it is not one."""
    key = (work_id or folder.name).lower()
    for name, prefix in VERSE_PREFIXES.items():
        if name != "hafs" and name in key:
            return prefix
    return None


def work_ids() -> dict[str, str]:
    """Folder path → work id, from the manifest."""
    try:
        manifest = json.loads((STATE / "source-imports.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    works = manifest.get("works") if isinstance(manifest, dict) else manifest
    out: dict[str, str] = {}
    for entry in works or []:
        if isinstance(entry, dict) and entry.get("dir"):
            out[str(entry["dir"])] = str(entry.get("id") or "")
    return out


def plan_renames() -> tuple[dict[str, str], list[tuple[Path, Path]]]:
    """old stem → new stem, and the files to move."""
    ids = work_ids()
    renames: dict[str, str] = {}
    moves: list[tuple[Path, Path]] = []

    canonical = canonical_folder()
    if canonical.is_dir():
        for path in sorted(canonical.glob("*.md")):
            m = LEGACY_CANONICAL.match(path.stem)
            if not m:
                continue
            number = int(m.group(1))
            if not 1 <= number <= 114:
                continue
            new = f"Q{number:03d}"
            renames[path.stem] = new
            moves.append((path, path.with_name(f"{new}.md")))

    installed = canonical.parent
    if installed.is_dir():
        for folder in sorted(installed.iterdir()):
            if not folder.is_dir():
                continue
            prefix = riwaya_prefix(folder, ids.get(folder.name, ""))
            if not prefix:
                continue
            for path in sorted(folder.glob("*.md")):
                m = LEGACY_PREFIXED.match(path.stem)
                if not m:
                    continue
                number = int(m.group(1))
                if not 1 <= number <= 114:
                    continue
                new = f"{prefix}{number:03d}"
                renames[path.stem] = new
                moves.append((path, path.with_name(f"{new}.md")))
    return renames, moves


def rewrite_links(text: str, renames: dict[str, str]) -> tuple[str, int]:
    """Point every link at its new note, keeping any display text.

    The display text is deliberately left alone. It is now supplied by the
    plugin at render time, so a baked alias is only a fallback for a reader
    without the plugin — and some aliases carry meaning that must survive
    (`**[[Q001#7|Ḥafṣ 7]]**` marks a riwāya's correspondence verse, and the
    emphasis is what keeps it out of the text flow).
    """
    total = 0
    for old, new in renames.items():
        text, n = re.subn(r"\[\[" + re.escape(old) + r"#", "[[" + new + "#", text)
        total += n
    return text, total


def note_files() -> list[Path]:
    files: list[Path] = []
    for folder in NOTE_FOLDERS:
        root = VAULT / folder
        if root.is_dir():
            files.extend(root.rglob("*.md"))
    if ROOT_NOTES:
        files.extend(VAULT.glob("*.md"))
    return files


def model_files() -> list[Path]:
    """Every render model: the citations live in the tafsīr models, and a
    re-render must not put the old link shape back."""
    return sorted((STATE / "source-models").rglob("*.json"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()

    renames, moves = plan_renames()
    if not renames:
        print("No legacy sūra notes found — nothing to rename.")
        return 0

    print(f"{len(moves)} sūra notes to rename:")
    by_prefix: dict[str, list[str]] = {}
    for old, new in sorted(renames.items()):
        by_prefix.setdefault(new.rstrip("0123456789"), []).append(new)
    for prefix, names in sorted(by_prefix.items()):
        print(f"  {prefix:<3} {len(names):>3}  {names[0]} … {names[-1]}")
    for path, new in moves[:3]:
        print(f"  {path.name}  →  {new.name}")
    print("  …")

    # Links, in the models and in the notes.
    model_hits = 0
    for path in model_files():
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for unit in data.get("units") or []:
            old_base = str(unit.get("base") or "")
            if old_base in renames:
                unit["base"] = renames[old_base]
                changed = True
            for block in unit.get("blocks") or []:
                body = block.get("body")
                if not isinstance(body, str):
                    continue
                body, n = rewrite_links(body, renames)
                if n:
                    block["body"] = body
                    model_hits += n
                    changed = True
        if args.apply and changed:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    note_hits = 0
    touched: list[Path] = []
    for path in note_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not any(old in text for old in renames):
            continue
        new_text, n = rewrite_links(text, renames)
        if n:
            note_hits += n
            touched.append(path)
            if args.apply:
                path.write_text(new_text, encoding="utf-8")

    print(f"\n{model_hits} links in {len(model_files())} models, {note_hits} links in {len(touched)} notes.")

    if not args.apply:
        print("\nReport only. Re-run with --apply to rename and rewrite.")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = STATE / "backups" / f"quran-rename-{stamp}"
    for path, _ in moves:
        dest = backup / path.parent.name
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest / path.name)
    touched_notes = STATE / "backups" / f"quran-rename-{stamp}" / "_notes"
    for path in touched:
        if path.parent == VAULT or any(str(path).startswith(str(VAULT / f)) for f in NOTE_FOLDERS):
            dest = touched_notes / path.relative_to(VAULT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
    print(f"Backup: {backup.relative_to(VAULT)}")

    for path, new in moves:
        if new.exists():
            print(f"  ! {new.name} already exists — skipped {path.name}")
            continue
        path.rename(new)
    print(f"Renamed {len(moves)} notes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
