#!/usr/bin/env python3
"""
Move a transcription/translation to its vault destination with proper YAML.

Also importable:

    write_note(body, citekey, doc_type, related=None, volume=None) -> Path

builds the YAML and writes the finished note in one step. Used by
translate-batch-process.py and reprocess-batch-files.py so that generated notes
land directly in the vault with the same YAML/aliases as moved ones.

Usage:
    python3 transcription-translation-move-to-vault.py <file.md> --citekey KEY \
        [--type translation] [--related "[[Topic]]" ...]
"""
import os
import re
import sys
from pathlib import Path
from datetime import datetime

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
BIB = VAULT / "_2 Bibliographic notes"

# Destination folder for each document type.
DEST_FOLDERS = {
    "transcription": os.environ.get("MIDAD_TRANSCRIPTIONS_DIR", "_2 Bibliographic notes/Arabic transcriptions"),
    "translation": os.environ.get("MIDAD_TRANSLATIONS_DIR", "_2 Bibliographic notes/Arabic translations"),
}

# A trailing "(transcription...)" / "(translation...)" or "- transcription".
TYPE_SUFFIX = re.compile(
    r'\s*[\(\[][^()\[\]]*\b(?:transcription|translation)\b[^()\[\]]*[\)\]]\s*$'
    r'|\s*[-–—]\s*(?:transcription|translation)\s*$',
    re.I,
)


def find_zotero(citekey: str) -> Path | None:
    """Find the Zotero import note for a citekey."""
    for f in BIB.glob("*.md"):
        if not f.name.startswith("@"):
            continue
        c = f.read_text(encoding="utf-8")
        # Check filename match or citekey in YAML (quoted or bare)
        if f.stem == f"@{citekey}" or re.search(rf'^citekey:\s*"?{re.escape(citekey)}"?\s*$', c, re.M):
            return f
    # Try partial match
    for f in BIB.glob(f"@{citekey}*.md"):
        return f
    return None


def extract_zotero_field(text: str, field: str) -> str | None:
    """Extract a YAML field value from Zotero import text."""
    # Single line: field: value
    m = re.search(rf'^{field}:\s*(.+)$', text, re.MULTILINE)
    if m:
        return m.group(1).strip().strip('"').lstrip('- ')
    # Multi-line: field on one line, value indented on next
    m = re.search(rf'^{field}:\s*$\n^\s+(.+)$', text, re.MULTILINE)
    if m:
        val = m.group(1).strip().strip('"').lstrip('- ')
        return val.strip()
    return None


def extract_aliases(text: str) -> list[str]:
    """Return a note's aliases, without surrounding quotes."""
    m = re.search(r'^aliases:[ \t]*$\n((?:[ \t]+-[ \t]*.+\n?)+)', text, re.M)
    if not m:
        return []
    out = []
    for line in m.group(1).rstrip("\n").split("\n"):
        mm = re.match(r'^[ \t]+-[ \t]*(.*)$', line)
        if not mm:
            continue
        v = mm.group(1).strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        out.append(v)
    return out


def _strip_type_suffix(alias: str) -> str:
    return TYPE_SUFFIX.sub('', alias).strip()


def _transcription_note(citekey: str, volume: int | None) -> Path:
    folder = VAULT / DEST_FOLDERS["transcription"]
    if volume:
        return folder / f"mas-{citekey} - transcription - vol. {volume}.md"
    return folder / f"mas-{citekey} - transcription.md"


def compute_aliases(citekey: str, doc_type: str, volume: int = None) -> list[str]:
    """Aliases for a note, each with '(type[, vol. N])' appended.

    A translation mirrors the corresponding transcription note's aliases (so the
    pair is consistent and searchable); transcriptions derive theirs from the
    Zotero reference.
    """
    suffix = doc_type if not volume else f"{doc_type}, vol. {volume}"

    if doc_type == "translation":
        trans = _transcription_note(citekey, volume)
        if trans.exists():
            return [
                f"{_strip_type_suffix(a)} ({suffix})"
                for a in extract_aliases(trans.read_text(encoding="utf-8"))
            ]

    ref = find_zotero(citekey)
    if not ref:
        return []
    aliases = []
    for a in extract_aliases(ref.read_text(encoding="utf-8")):
        if 'zotero://' in a or a.endswith('.pdf'):
            continue
        aliases.append(f"{_strip_type_suffix(a)} ({suffix})")
    return aliases


def _yaml_quote(value: str) -> str:
    """Escape a value for a double-quoted YAML scalar."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def _source_id(citekey: str, ref: Path | None) -> str:
    """Stable source identity: the Zotero item id when available, else the PDF key."""
    if ref:
        text = ref.read_text(encoding="utf-8")
        zid = extract_zotero_field(text, "sw-zotero-id")
        return f"zotero:{zid.strip()}" if zid else f"zotero:@{citekey}"
    return f"pdf:{citekey}"


def build_yaml(citekey: str, doc_type: str, related: list[str], volume: int = None,
               standalone: bool = False, title: str | None = None,
               authors: list[str] | None = None) -> str:
    """Build YAML frontmatter from the Zotero reference and the aliases.

    A standalone transcription (a PDF the user chose directly, with no Zotero
    record) instead takes its title/authors from the metadata guessed during
    transcription. It deliberately has no `[[@citekey]]` up link, because no
    literature note exists.
    """
    ref = None if standalone else find_zotero(citekey)
    title_base = (title or "").strip() or "Untitled"
    short_base = title_base
    raw_authors = [authors] if isinstance(authors, str) else (authors or [])
    author_list = [a.strip() for a in raw_authors if a and a.strip()]

    if ref:
        text = ref.read_text(encoding="utf-8")
        title_base = extract_zotero_field(text, "title") or "Untitled"
        short_base = extract_zotero_field(text, "shorttitle") or title_base
        author_field = extract_zotero_field(text, "authors")
        if author_field:
            author_list = [author_field.lstrip('- ').strip().strip('"')]

    title = f"{title_base} ({doc_type})"
    shorttitle = f"{short_base} ({doc_type})" if short_base != title_base else ""
    up_category = "Arabic transcriptions" if doc_type == "transcription" else "Translations"

    up_items = [
        f'  - "[[{up_category}]]"',
        f'  - "[[AI gen]]"',
    ]
    if not standalone:
        up_items.append(f'  - "[[@{citekey}]]"')
        if volume:
            up_items.append(f'  - "[[mas-{citekey} - {doc_type}]]"')

    yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d %H:%M')}
up:
{chr(10).join(up_items)}
title: "{_yaml_quote(title)}"
"""
    if shorttitle:
        yaml += f'shorttitle: "{_yaml_quote(shorttitle)}"\n'
    if volume:
        yaml += f'volume: {volume}\n'
    source_id = _source_id(citekey, ref)
    mas_work = f"{source_id}:{doc_type}"
    mas_id = f"{mas_work}:vol.{volume}" if volume else mas_work
    yaml += f'mas-id: "{_yaml_quote(mas_id)}"\n'
    yaml += f'mas-kind: "{doc_type}"\n'
    yaml += f'mas-source: "{_yaml_quote(source_id)}"\n'
    yaml += f'mas-work: "{_yaml_quote(mas_work)}"\n'
    yaml += f'mas-unit: "{("vol." + str(volume)) if volume else "note"}"\n'
    if author_list:
        yaml += "authors:\n"
        for a in author_list:
            yaml += f'  - "{_yaml_quote(a)}"\n'

    if standalone:
        aliases = []
        suffix = doc_type if not volume else f"{doc_type}, vol. {volume}"
        if title_base != "Untitled":
            aliases.append(f"{title_base} ({suffix})")
            if author_list:
                aliases.append(f"{author_list[0]} - {title_base} ({suffix})")
    else:
        aliases = compute_aliases(citekey, doc_type, volume)
    if aliases:
        yaml += "aliases:\n"
        for a in aliases:
            yaml += f'  - "{_yaml_quote(a)}"\n'
    if related:
        yaml += "related:\n"
        for r in related:
            yaml += f'  - "{_yaml_quote(r)}"\n'

    yaml += "---\n"
    return yaml


def detect_volume(filename: str) -> int | None:
    """Detect volume number from the filename, e.g. '... - vol. 3.md'.

    Only an explicit 'vol. N' / 'v. N' marker counts, so digits inside a
    citekey (years, etc.) are not mistaken for a volume."""
    # Strip timestamp: .YYYY-MM-DD_HH-MM-SS
    stem = re.sub(r'\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*$', '', filename)
    m = re.search(r'\b(?:vol|v)\.\s*(\d+)\b', stem, re.I)
    return int(m.group(1)) if m else None


def dest_path(citekey: str, doc_type: str, volume: int = None) -> Path:
    """Vault destination path for a note."""
    dest_dir = VAULT / DEST_FOLDERS[doc_type]
    dest_dir.mkdir(parents=True, exist_ok=True)
    if volume:
        return dest_dir / f"mas-{citekey} - {doc_type} - vol. {volume}.md"
    return dest_dir / f"mas-{citekey} - {doc_type}.md"


def ensure_parent(citekey: str, doc_type: str, related: list[str], volume: int):
    """Create/update the multivolume parent note and its volume list."""
    if not volume:
        return None
    parent = dest_path(citekey, doc_type, None)
    if not parent.exists():
        parent.write_text(build_yaml(citekey, doc_type, related) + "\n", encoding="utf-8")
        print(f"Created parent: {parent.name}")

    content = parent.read_text(encoding="utf-8")
    entry = f"[[mas-{citekey} - {doc_type} - vol. {volume}]]"
    if entry not in content:
        new_lines = []
        inserted = False
        for line in content.split("\n"):
            if not inserted and line.strip().startswith("- [["):
                v_match = re.search(r'vol\.\s*(\d+)', line)
                if v_match and int(v_match.group(1)) > volume:
                    new_lines.append(f"- {entry}")
                    inserted = True
            new_lines.append(line)
        if not inserted:
            new_lines.append(f"- {entry}")
        parent.write_text("\n".join(new_lines), encoding="utf-8")
        print(f"Updated parent with vol. {volume}")
    return parent


def _collection_notes(citekey: str, doc_type: str):
    """(parent_name, [volume_names sorted numerically]) for a citekey."""
    folder = VAULT / DEST_FOLDERS[doc_type]
    parent = f"mas-{citekey} - {doc_type}"
    vols = []
    if folder.exists():
        for p in folder.glob(f"mas-{citekey} - {doc_type} - vol. *.md"):
            if "modified" in p.stem:
                continue
            m = re.search(r'vol\.\s*(\d+)', p.stem)
            if m:
                vols.append((int(m.group(1)), p.stem))
    vols.sort(key=lambda t: t[0])
    return parent, [name for _, name in vols]


def _write_list_property(citekey: str, prop: str, items: list) -> bool:
    """Replace the `prop:` YAML list on @citekey.md with `items`."""
    ref = BIB / f"@{citekey}.md"
    if not ref.exists():
        return False
    text = ref.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return False
    end = text.find("\n---", 3)
    if end == -1:
        return False
    fm, body = text[:end], text[end:]
    block = f"{prop}:\n" + "".join(f'  - "[[{it}]]"\n' for it in items)

    m = re.search(rf'^{re.escape(prop)}:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)*)', fm, re.M)
    if m:
        fm = fm[:m.start()] + block + fm[m.end():]
    else:
        fm = fm.rstrip("\n") + "\n" + block
    ref.write_text(fm + body, encoding="utf-8")
    return True


def sync_collection_property(citekey: str, doc_type: str) -> bool:
    """Keep @citekey.md's transcriptions/translations list ordered:
    the parent note first, then the volumes in numerical order."""
    prop = "transcriptions" if doc_type == "transcription" else "translations"
    parent, vols = _collection_notes(citekey, doc_type)
    items = [parent] + vols if vols else [parent]
    return _write_list_property(citekey, prop, items)


def write_note(body: str, citekey: str, doc_type: str, related: list[str] = None,
               volume: int = None, standalone: bool = False,
               title: str | None = None, authors: list[str] | None = None) -> Path:
    """Build the YAML and write the finished note. Returns its path."""
    related = related or []
    if not standalone:
        ensure_parent(citekey, doc_type, related, volume)
    dest = dest_path(citekey, doc_type, volume)
    yaml = build_yaml(citekey, doc_type, related, volume=volume, standalone=standalone,
                      title=title, authors=authors)
    dest.write_text(yaml + "\n" + body.strip() + "\n", encoding="utf-8")
    # Record/refresh the ordered transcriptions/translations list on the
    # literature note: parent note first, then volumes in numerical order.
    if not standalone and sync_collection_property(citekey, doc_type):
        print(f"Updated {doc_type} list on @{citekey}")
    return dest


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcription-translation-move-to-vault.py <file.md> --citekey KEY [--type translation] [--related Topic ...]")
        sys.exit(1)

    filepath = Path(sys.argv[1])
    if not filepath.exists():
        print(f"ERROR: {filepath} not found"); sys.exit(1)

    citekey = None
    doc_type = "transcription"
    related = []

    i = 2
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--citekey" and i + 1 < len(sys.argv):
            citekey = sys.argv[i + 1]; i += 2
        elif arg == "--type" and i + 1 < len(sys.argv):
            doc_type = sys.argv[i + 1]; i += 2
        elif arg == "--related" and i + 1 < len(sys.argv):
            related.append(sys.argv[i + 1]); i += 2
        else:
            i += 1

    if not citekey:
        # Try to extract from file's YAML
        c = filepath.read_text(encoding="utf-8")
        m = re.search(r'@([a-zA-Z0-9]+)\]\]', c)
        if m:
            citekey = m.group(1)
            print(f"Auto-detected citekey: {citekey}")
        else:
            print("ERROR: --citekey required or citekey not found in file"); sys.exit(1)

    # Normalize document type.
    doc_type = doc_type.strip().lower()
    if doc_type in ("translations", "trans"):
        doc_type = "translation"
    if doc_type not in DEST_FOLDERS:
        print(f"ERROR: unknown --type {doc_type!r}; expected 'transcription' or 'translation'")
        sys.exit(1)

    # Read source, strip existing YAML.
    content = filepath.read_text(encoding="utf-8")
    if content.startswith("---"):
        end = content.find("---", 3)
        if end > 0:
            content = content[end + 3:].strip()

    volume = detect_volume(filepath.name)
    dest = write_note(content, citekey, doc_type, related, volume)

    print(f"Moved: {dest.relative_to(VAULT)}")
    vol_info = f", vol. {volume}" if volume else ""
    print(f"Type: {doc_type}{vol_info}, Citekey: @{citekey}")


if __name__ == "__main__":
    main()
