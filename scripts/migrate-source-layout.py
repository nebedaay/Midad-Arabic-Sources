#!/usr/bin/env python3
"""Move Midad's vault folders to the source-root layout.

The target layout is:

    <source root>/
        Installed Sources/      (repository works and the canonical Qur'an)
        Transcriptions/
        Translations/
        Annotation Notes/

Usage:
    python3 scripts/migrate-source-layout.py --source-root "_7 Sources" \
        --old-installed-root "_7 Sources" \
        --old-annotation-notes "_7 Sources/Notes"

Existing files are moved, not copied. If a destination already exists, a
directory is merged child by child and an existing file is left untouched.
"""
import argparse
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
DEFAULT_MANIFEST = ".midad-arabic-sources/source-imports.json"
DEFAULT_ADOPTED = ".midad-arabic-sources/annotations/adopted.json"
# No vault-specific layout is assumed; the previous paths come from the CLI
# (the plugin passes them from its saved settings).
OLD_TRANSCRIPTIONS = ""
OLD_TRANSLATIONS = ""


def norm(value: str) -> str:
    return value.replace("\\", "/").strip("/")


def move_path(old: Path, new: Path, dry: bool) -> None:
    if not old.exists():
        return
    try:
        if old.resolve() == new.resolve():
            return
    except FileNotFoundError:
        pass
    if new.exists():
        if old.is_dir() and new.is_dir():
            for child in list(old.iterdir()):
                move_path(child, new / child.name, dry)
            if not dry:
                try:
                    old.rmdir()
                except OSError:
                    pass
            return
        print(f"  skip (destination exists): {old} -> {new}")
        return
    print(f"  move: {old} -> {new}")
    if dry:
        return
    new.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old), str(new))


def move_work(work: dict, old_root: Path, new_root: Path, dry: bool) -> None:
    directory = str(work.get("dir") or "").strip()
    if not directory:
        return
    move_path(old_root / f"{directory}.md", new_root / f"{directory}.md", dry)
    move_path(old_root / directory, new_root / directory, dry)


def update_adopted(source_root: str, old_transcriptions: str, old_translations: str, dry: bool) -> None:
    path = VAULT / DEFAULT_ADOPTED
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  WARNING: could not read adopted registry: {e}")
        return
    old_pairs = []
    if old_transcriptions:
        old_pairs += [
            (f"{old_transcriptions}/", f"{source_root}/Transcriptions/"),
            (f"{norm(old_transcriptions)}/", f"{source_root}/Transcriptions/"),
        ]
    if old_translations:
        old_pairs += [
            (f"{old_translations}/", f"{source_root}/Translations/"),
            (f"{norm(old_translations)}/", f"{source_root}/Translations/"),
        ]
    notes = data.get("notes")
    if not isinstance(notes, dict):
        return
    updated = {}
    changed = 0
    for key, entry in notes.items():
        new_key = key
        for old, new in old_pairs:
            if old in new_key:
                new_key = new_key.replace(old, new)
                break
        if isinstance(entry, dict):
            entry["path"] = new_key
        if new_key != key:
            changed += 1
        updated[new_key] = entry
    data["notes"] = updated
    if changed:
        print(f"  adopted registry: {changed} path(s) updated")
        if not dry:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def update_annotation_store(source_root: str, old_annotation: str, old_transcriptions: str,
                            old_translations: str, dry: bool) -> None:
    root = VAULT / ".midad-arabic-sources" / "annotations"
    if not root.exists():
        return
    pairs = [(f"{norm(old_annotation)}/", f"{source_root}/Annotation Notes/")]
    if old_transcriptions:
        pairs.append((f"{norm(old_transcriptions)}/", f"{source_root}/Transcriptions/"))
    if old_translations:
        pairs.append((f"{norm(old_translations)}/", f"{source_root}/Translations/"))
    changed = 0
    for path in root.rglob("*.json"):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        updated = text
        for old, new in pairs:
            updated = updated.replace(old, new)
        if updated != text:
            changed += 1
            if not dry:
                path.write_text(updated, encoding="utf-8")
    if changed:
        print(f"  annotation store: {changed} JSON file(s) updated")


def update_markdown_links(source_root: str, old_source_root: str, old_installed: str,
                          old_annotation: str, old_transcriptions: str,
                          old_translations: str, work_names: list[str],
                          moc_names: set[str], dry: bool) -> None:
    """Rewrite explicit vault links after a move, without touching prose."""
    if not old_source_root:
        old_source_root = old_installed
    new_installed = f"{source_root}/Installed Sources"
    new_annotation = f"{source_root}/Annotation Notes"
    new_transcriptions = f"{source_root}/Transcriptions"
    new_translations = f"{source_root}/Translations"
    pairs = [
        (old_transcriptions, new_transcriptions),
        (old_translations, new_translations),
        (old_annotation, new_annotation),
    ]
    for name in work_names:
        pairs.append((f"{old_installed}/{name}", f"{new_installed}/{name}"))
    for name in moc_names:
        pairs.append((f"{old_source_root}/{name}.md", f"{source_root}/{name}.md"))
    pairs = [(norm(old), norm(new)) for old, new in pairs if norm(old) != norm(new)]
    if not pairs:
        return
    changed = 0
    for path in VAULT.rglob("*.md"):
        rel = path.relative_to(VAULT).as_posix()
        # Skip every dot-folder (Obsidian's config folder can have any name)
        # and the vault's own working folders.
        first = rel.split("/", 1)[0]
        if first.startswith(".") or first in {"tmp", "src", "AI OS"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        updated = text
        for old, new in pairs:
            old_key = f"[[{old}"
            if old_key in updated:
                updated = updated.replace(old_key, f"[[{new}")
        if updated != text:
            changed += 1
            if not dry:
                path.write_text(updated, encoding="utf-8")
    if changed:
        print(f"  links updated in {changed} Markdown file(s)")


def update_settings(data_path: str, source_root: str, dry: bool) -> None:
    if not data_path:
        return
    path = Path(data_path)
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  WARNING: could not read plugin settings: {e}")
        return
    data["sourceRoot"] = source_root
    data["sourceImportRoot"] = f"{source_root}/Installed Sources"
    data["annotationNoteFolder"] = f"{source_root}/Annotation Notes"
    data["canonicalQuranFolder"] = f"{source_root}/Installed Sources/Quran"
    data["sourceLayoutMigrated"] = True
    if not dry:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  settings updated: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Move Midad source folders to the current layout.")
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--old-installed-root", required=True)
    parser.add_argument("--old-source-root", default="")
    parser.add_argument("--old-annotation-notes", required=True)
    parser.add_argument("--old-transcriptions", default="")
    parser.add_argument("--old-translations", default="")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--update-settings", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source_root = norm(args.source_root)
    old_root = VAULT / norm(args.old_installed_root)
    new_root = VAULT / source_root / "Installed Sources"
    new_transcriptions = VAULT / source_root / "Transcriptions"
    new_translations = VAULT / source_root / "Translations"
    new_annotation = VAULT / source_root / "Annotation Notes"
    dry = args.dry_run

    print(f"Source layout: {source_root}")
    print(f"  installed: {old_root} -> {new_root}")

    manifest_path = VAULT / args.manifest
    works = []
    if manifest_path.exists():
        try:
            parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
            works = parsed.get("works", []) if isinstance(parsed, dict) else []
        except Exception as e:
            print(f"  WARNING: could not read manifest: {e}")

    work_names = [str(w.get("dir")) for w in works if w.get("dir")]
    work_names.append("Quran")
    moc_names = set()
    for work in works:
        raw = work.get("mocs")
        if isinstance(raw, list):
            moc_names.update(str(x) for x in raw if x)
        elif work.get("moc"):
            moc_names.add(str(work["moc"]))
    moc_names.update({"source-annotation", "Sources"})

    canonical_root = VAULT / source_root / "Installed Sources" / "Quran"
    for work in works:
        move_work(work, old_root, new_root, dry)
    # The canonical Qur'an folder is a repository work too, but older manifests
    # may not contain it.
    move_path(old_root / "Quran", canonical_root, dry)
    move_path(old_root / "Quran.md", canonical_root.with_suffix(".md"), dry)

    old_source_root = VAULT / norm(args.old_source_root) if args.old_source_root else None
    if old_source_root and old_source_root.resolve() != (VAULT / source_root).resolve():
        for name in sorted(moc_names):
            move_path(old_source_root / f"{name}.md", VAULT / source_root / f"{name}.md", dry)
        move_path(old_source_root / "zotero-export.csl.json", VAULT / source_root / "zotero-export.csl.json", dry)

    print(f"  transcriptions: {VAULT / args.old_transcriptions} -> {new_transcriptions}")
    move_path(VAULT / args.old_transcriptions, new_transcriptions, dry)
    print(f"  translations: {VAULT / args.old_translations} -> {new_translations}")
    move_path(VAULT / args.old_translations, new_translations, dry)
    print(f"  annotation notes: {VAULT / args.old_annotation_notes} -> {new_annotation}")
    move_path(VAULT / args.old_annotation_notes, new_annotation, dry)

    update_adopted(source_root, args.old_transcriptions, args.old_translations, dry)
    update_annotation_store(source_root, args.old_annotation_notes,
                            args.old_transcriptions, args.old_translations, dry)
    update_markdown_links(source_root, args.old_source_root, args.old_installed_root,
                          args.old_annotation_notes, args.old_transcriptions,
                          args.old_translations, work_names, moc_names, dry)
    update_settings(args.update_settings, source_root, dry)

    print("Done." if not dry else "Dry run complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
