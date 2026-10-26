#!/usr/bin/env python3
"""Migrate MAS source notes to the unified midad-id naming and registry identity.

- Zotero literature notes (`_2 Bibliographic notes/@*.md`) get a stable
  `midad-id: zotero:<sw-zotero-id>` (falling back to `zotero:@<citekey>`).
- Transcriptions/translations get a `midad-id`, `midad-kind`, `midad-source`,
  `midad-work`, and `midad-unit`. A Zotero-associated note keeps its
  `@<citekey>` filename; only a standalone note with no Zotero reference
  (a `pdf:` source) changes from `@<citekey>` to `mas-<citekey>`.
- Repository hubs get `midad-id: repo:<collection>:<id>`.
- Adopted arbitrary notes get a `midad-id` when they have a `midad-work`.
- Explicit wikilinks, the adopted-annotation registry, the annotation store,
  and the Source Annotations MOC are updated.

Usage:
    python3 scripts/migrate-mas-ids.py --dry-run
    python3 scripts/migrate-mas-ids.py
"""
import argparse
import json
import os
import re
from pathlib import Path

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
BIB = VAULT / "_2 Bibliographic notes"
MANIFEST = VAULT / ".midad-arabic-sources/source-imports.json"
ADOPTED = VAULT / ".midad-arabic-sources/annotations/adopted.json"
ANNOTATIONS = VAULT / ".midad-arabic-sources/annotations"
TRANS_RE = re.compile(r"^@(.+?) - (.+)$", re.I)


def yaml_value(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def add_frontmatter_fields(text: str, fields: list[tuple[str, str]]) -> str:
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    if end < 0:
        return text
    fm = text[:end]
    rest = text[end:]
    for key, value in fields:
        if re.search(rf'^{re.escape(key)}:', fm, re.M):
            continue
        fm = fm.replace("---\n", f"---\n{key}: {yaml_value(value)}\n", 1)
    return fm + rest


def zotero_source_id(citekey: str) -> tuple[str, str]:
    ref = BIB / f"@{citekey}.md"
    if ref.exists():
        text = ref.read_text(encoding="utf-8")
        m = re.search(r'^sw-zotero-id:\s*"?([^"\n]+)"?\s*$', text, re.M)
        if m:
            sid = m.group(1).strip()
            return f"zotero:{sid}", f"zotero:@{citekey}"
        return f"zotero:@{citekey}", f"zotero:@{citekey}"
    return f"pdf:{citekey}", f"pdf:{citekey}"


def update_json_paths(path: Path, replacements: dict[str, str], dry: bool) -> None:
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
        updated = text
        for old, new in replacements.items():
            updated = updated.replace(old, new)
        if updated != text:
            print(f"  update: {path.relative_to(VAULT)}")
            if not dry:
                path.write_text(updated, encoding="utf-8")
    except Exception as e:
        print(f"  WARNING: {path}: {e}")


def add_fields_to_note(path: Path, fields: list[tuple[str, str]], dry: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    updated = add_frontmatter_fields(text, fields)
    if updated == text:
        return False
    if not dry:
        path.write_text(updated, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate MAS source notes to midad-id naming.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    dry = args.dry_run

    data_path = VAULT / ".obsidian/plugins/midad-arabic-sources/data.json"
    data = json.loads(data_path.read_text(encoding="utf-8")) if data_path.exists() else {}
    root = Path(data.get("sourceRoot") or "_7 Sources")
    trans_dir = VAULT / root / "Transcriptions"
    transl_dir = VAULT / root / "Translations"
    installed = VAULT / root / "Installed Sources"

    # 1. Zotero literature notes are indexed by their stable sw-zotero-id;
    # they are not rewritten, since ScholarWeft owns their frontmatter.

    # 2. Transcriptions and translations: add fields and rename away from @.
    renames: dict[str, str] = {}
    for folder, doc_type in ((trans_dir, "transcription"), (transl_dir, "translation")):
        if not folder.exists():
            continue
        for note in sorted(folder.glob("*.md")):
            m = TRANS_RE.match(note.stem)
            if not m:
                continue
            citekey = m.group(1)
            suffix = m.group(2)
            low = suffix.lower()
            typ = "translation" if "translation" in low else "transcription" if "transcription" in low else ""
            if not typ:
                continue
            vm = re.search(r'\b(?:vol|v)\.\s*(\d+)', suffix, re.I)
            volume = int(vm.group(1)) if vm else None
            variant = re.sub(r'\b(?:translation|transcription)\b', '', suffix, flags=re.I)
            variant = re.sub(r'\b(?:vol|v)\.\s*\d+', '', variant, flags=re.I).strip(" ,-–—()")
            variant = re.sub(r'[^A-Za-z0-9]+', '-', variant).strip('-').lower()
            source_id, _ = zotero_source_id(citekey)
            work = f"{source_id}:{typ}"
            unit = f"vol.{volume}" if volume else ""
            if variant:
                unit = f"{unit}:{variant}" if unit else variant
            unit = unit or "note"
            mas_id = f"{work}:{unit}"
            fields = [
                ("midad-id", mas_id),
                ("midad-kind", typ),
                ("midad-source", source_id),
                ("midad-work", work),
                ("midad-unit", unit),
            ]
            if add_fields_to_note(note, fields, dry):
                print(f"  source fields: {note.name} -> {mas_id}")
            if source_id.startswith("pdf:"):
                new_name = f"mas-{note.stem[1:]}.md"
                target = note.with_name(new_name)
                if target.exists():
                    print(f"  skip rename (exists): {target.name}")
                    continue
                renames[str(note)] = str(target)
                print(f"  rename: {note.name} -> {target.name}")
                if not dry:
                    note.rename(target)
            else:
                print(f"  keep Zotero filename: {note.name}")

    # 3. Repository hubs already in the manifest.
    works = []
    if MANIFEST.exists():
        try:
            works = json.loads(MANIFEST.read_text(encoding="utf-8")).get("works", [])
        except Exception:
            works = []
    for work in works:
        key = str(work.get("key") or "")
        directory = str(work.get("dir") or "")
        if not key or not directory:
            continue
        hub = installed / f"{directory}.md"
        if hub.exists():
            add_fields_to_note(hub, [
                ("midad-id", f"repo:{key}"),
                ("midad-kind", "repo-work"),
                ("midad-source", f"repo:{key}"),
            ], dry)

    # 4. Adopted arbitrary notes.
    if ADOPTED.exists():
        try:
            adopted = json.loads(ADOPTED.read_text(encoding="utf-8")).get("notes", {})
        except Exception:
            adopted = {}
        for path, entry in adopted.items():
            note = VAULT / path
            if not note.exists():
                continue
            mas_work = entry.get("workKey") or ""
            if mas_work:
                add_fields_to_note(note, [
                    ("midad-id", mas_work),
                    ("midad-kind", "adopted"),
                    ("midad-source", "adopted"),
                ], dry)

    # 5. Explicit links, adopted registry, annotation store and MOC.
    replacements: dict[str, str] = {}
    for old, new in renames.items():
        old_path = Path(old)
        new_path = Path(new)
        old_stem = old_path.stem
        new_stem = new_path.stem
        old_rel = old_path.relative_to(VAULT).as_posix()
        new_rel = new_path.relative_to(VAULT).as_posix()
        replacements[f"[[{old_stem}"] = f"[[{new_stem}"
        replacements[f"[[{old_rel}"] = f"[[{new_rel}"
        replacements[f"{old_path.name}"] = new_path.name
        replacements[old_rel] = new_rel
        replacements[old_stem] = new_stem
    for md in VAULT.rglob("*.md"):
        rel = md.relative_to(VAULT).as_posix()
        if rel.startswith((".obsidian/", ".midad-arabic-sources/", "tmp/", "src/", "AI OS/")):
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except Exception:
            continue
        updated = text
        for old, new in replacements.items():
            updated = updated.replace(old, new)
        if updated != text:
            print(f"  links: {rel}")
            if not dry:
                md.write_text(updated, encoding="utf-8")
    for path in [ADOPTED, *ANNOTATIONS.rglob("*.json")]:
        update_json_paths(path, replacements, dry)

    # A rename can make the running annotation service mark a work "removed"
    # before it sees the new path. If its note exists, restore the status.
    for work_file in ANNOTATIONS.rglob("work.json"):
        try:
            data = json.loads(work_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        note = data.get("note")
        if data.get("sourceStatus") == "removed" and note and (VAULT / note).exists():
            data["sourceStatus"] = "installed"
            if not dry:
                work_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"  restore status: {work_file}")

    print("Dry run complete." if dry else "Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
