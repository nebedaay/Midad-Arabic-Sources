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
_LITERATURE_DIR = os.environ.get("MIDAD_LITERATURE_DIR", "").strip()
BIB = VAULT / _LITERATURE_DIR if _LITERATURE_DIR else None

# Destination folder for each document type.
DEST_FOLDERS = {
    "transcription": os.environ.get("MIDAD_TRANSCRIPTIONS_DIR", "Transcriptions"),
    "translation": os.environ.get("MIDAD_TRANSLATIONS_DIR", "Translations"),
}

# A trailing "(transcription...)" / "(translation...)" or "- transcription".
TYPE_SUFFIX = re.compile(
    r'\s*[\(\[][^()\[\]]*\b(?:transcription|translation)\b[^()\[\]]*[\)\]]\s*$'
    r'|\s*[-–—]\s*(?:transcription|translation)\s*$',
    re.I,
)


def _literature_notes():
    """Candidate @notes: the configured folder, else a vault-wide search."""
    if BIB and BIB.exists():
        yield from BIB.glob("*.md")
        return
    for f in VAULT.rglob("@*.md"):
        if any(part.startswith(".") for part in f.relative_to(VAULT).parts):
            continue
        yield f


def find_zotero(citekey: str) -> Path | None:
    """Find the Zotero import note for a citekey."""
    candidates = list(_literature_notes())
    for f in candidates:
        if not f.name.startswith("@"):
            continue
        c = f.read_text(encoding="utf-8")
        # Check filename match or citekey in YAML (quoted or bare)
        if f.stem == f"@{citekey}" or re.search(rf'^citekey:\s*"?{re.escape(citekey)}"?\s*$', c, re.M):
            return f
    # Try partial match
    for f in candidates:
        if f.stem.startswith(f"@{citekey}"):
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


def _note_prefix(standalone: bool) -> str:
    """Zotero-associated notes keep the @citekey; standalone PDFs use mas-."""
    return "mas-" if standalone else "@"


def _unit_slug(value: str | None) -> str:
    """A stable midad-unit / midad-id slug for a partial transcription."""
    text = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return text


def _plain_name(value) -> str:
    """Display text from a plain name or a wikilink.

    Author names can themselves contain brackets (`[[Kanūn [Ganūn], …]]`), so
    strip the outer `[[…]]` rather than stopping at the first `]`.
    """
    text = str(value or "").strip().strip('"').strip("'")
    if text.startswith("[[") and text.endswith("]]"):
        text = text[2:-2]
        if "|" in text:
            text = text.split("|", 1)[1]
    return text.strip()


def _author_label(authors: list[str] | None) -> str:
    """Last/single-name label used in a citation alias."""
    for value in authors or []:
        name = _plain_name(value)
        if not name:
            continue
        if "," in name:
            name = name.split(",", 1)[0]
        return name.strip()
    return ""


def _cover_scalar(cover: dict | None, key: str) -> str:
    value = (cover or {}).get(key)
    return str(value).strip() if isinstance(value, (str, int, float)) else ""


def _cover_list(cover: dict | None, key: str) -> list[str]:
    value = (cover or {}).get(key)
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(";") if item.strip()]
    return []


def _year_label(ref: Path | None) -> str:
    if not ref:
        return ""
    value = extract_zotero_field(ref.read_text(encoding="utf-8"), "year") or ""
    value = re.sub(r"^\[\[|\]\]$", "", value.strip())
    return value


def _alias_label(parts: list[str], suffix: str) -> str:
    body = " - ".join(part for part in (p.strip() for p in parts) if part)
    return f"{body} ({suffix})" if body else ""


def canonical_citation_aliases(
    *, title: str, shorttitle: str, authors: list[str] | None,
    authors_ar: list[str] | None, title_ar: str, shorttitle_ar: str,
    year: str, doc_type: str, volume: int | None = None,
    unit: str = "", include_arabic: bool = True,
) -> list[str]:
    """The two standard aliases for a generated document."""
    suffix = doc_type
    if volume:
        suffix += f", vol. {volume}"
    base_title = _strip_type_suffix(shorttitle or title).strip() or "Untitled"
    authors_plain = [_plain_name(a) for a in (authors or []) if _plain_name(a)]
    aliases: list[str] = []
    roman_author = _author_label(authors_plain)
    if roman_author:
        roman = _alias_label([roman_author, year, base_title], suffix)
        if unit:
            roman += f" - {unit}" if roman else unit
        if roman:
            aliases.append(roman)
    if include_arabic and (title_ar or shorttitle_ar):
        authors_ar_plain = [_plain_name(a) for a in (authors_ar or []) if _plain_name(a)]
        arabic_author = _author_label(authors_ar_plain)
        if arabic_author:
            arabic_title = (shorttitle_ar or title_ar).strip()
            arabic = _alias_label([arabic_author, year, arabic_title], suffix)
            if unit:
                arabic += f" - {unit}" if arabic else unit
            if arabic and arabic not in aliases:
                aliases.append(arabic)
    return aliases[:2]


def _transcription_note(citekey: str, volume: int | None, standalone: bool = False) -> Path:
    folder = VAULT / DEST_FOLDERS["transcription"]
    prefix = _note_prefix(standalone)
    if volume:
        return folder / f"{prefix}{citekey} - transcription - vol. {volume}.md"
    return folder / f"{prefix}{citekey} - transcription.md"


def compute_aliases(citekey: str, doc_type: str, volume: int = None, standalone: bool = False) -> list[str]:
    """Aliases for a note, each with '(type[, vol. N])' appended.

    A translation mirrors the corresponding transcription note's aliases (so the
    pair is consistent and searchable); transcriptions derive theirs from the
    Zotero reference.
    """
    suffix = doc_type if not volume else f"{doc_type}, vol. {volume}"

    if doc_type == "translation":
        trans = _transcription_note(citekey, volume, standalone)
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


def _yaml_id(value: str) -> str:
    """YAML-facing IDs avoid `scheme:` so Obsidian does not treat them as URLs."""
    return str(value).replace(":", "/")


def _source_id(citekey: str, ref: Path | None) -> str:
    """Stable source identity: the Zotero item id when available, else the PDF key."""
    if ref:
        text = ref.read_text(encoding="utf-8")
        zid = extract_zotero_field(text, "sw-zotero-id")
        return f"zotero:{zid.strip()}" if zid else f"zotero:@{citekey}"
    return f"pdf:{citekey}"


def _frontmatter_end(text: str) -> int:
    """Index of the newline before the closing `---`, or -1."""
    if not text.startswith("---"):
        return -1
    return text.find("\n---", 3)


def _existing_list(path: Path, key: str) -> list[str]:
    """A YAML list already on a note, preserved across a re-transcription."""
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    end = _frontmatter_end(text)
    if end == -1:
        return []
    match = re.search(rf"^{re.escape(key)}:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)*)", text[:end], re.M)
    if not match:
        return []
    out = []
    for line in match.group(1).splitlines():
        value = line.strip().lstrip("- ").strip().strip('"').strip("'")
        if value:
            out.append(value)
    return out


def _existing_scalar(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    end = _frontmatter_end(text)
    if end == -1:
        return ""
    match = re.search(rf'^{re.escape(key)}:[ \t]*"?(.*?)"?[ \t]*$', text[:end], re.M)
    return match.group(1).strip() if match else ""


def _existing_topics(path: Path) -> list[str]:
    return _existing_list(path, "topics")


ARABIC_SCRIPT = re.compile(r"[\u0600-\u06FF]")
ARABIC_TITLE_LINE = re.compile(r"^#\s+(.+?)\s*$", re.M)
ARABIC_AUTHOR_HEAD = re.compile(
    r"^#{2,4}\s*(?:تأليف|المؤلف|المؤلفون|Author|By)\s*:?\s*$", re.M | re.I)


def extract_arabic_metadata(body: str) -> tuple[str, list[str]]:
    """The work's Arabic title and author from a transcription's title page.

    The OCR keeps the title page's `# <title>` and `## تأليف` / `## Author`
    headings, so the first Arabic level-1 heading and the line beneath an author
    heading are the source's own forms. Both are best-effort: a missing value
    leaves the property out, and the user can add it to the MOC.
    """
    text = body or ""
    title = ""
    for match in ARABIC_TITLE_LINE.finditer(text):
        candidate = re.sub(r"\s+\^[\w-]+\s*$", "", match.group(1).strip())
        if ARABIC_SCRIPT.search(candidate):
            title = candidate
            break
    author = ""
    for head in ARABIC_AUTHOR_HEAD.finditer(text):
        for line in text[head.end():].splitlines():
            value = line.strip()
            if not value:
                continue
            if value.startswith("#"):
                # Many covers put the author on the next heading
                # (`### تأليف:` followed by `### الشيخ …`).
                value = value.lstrip("#").strip()
                if not value:
                    continue
            if ARABIC_SCRIPT.search(value):
                author = value
            break
        if author:
            break
    if author:
        # Strip title-page honorifics and the death-date clause, so the citation
        # author is the name rather than "الإمام الشيخ … المتوفى … رحمه الله".
        author = re.sub(
            r"^(?:(?:الإمام|الشيخ|العلامة|الحافظ|المحدِّث|المحدث|القاضي|الفقيه|الأستاذ|الدكتور)\s+)+",
            "", author).strip()
        author = re.sub(r"\s+(?:المتوفى|المتوفية|المتوفّى|توفي|ت\.)\b.*$", "", author).strip()
        author = re.sub(r"\s+رحمه\s+الله.*$", "", author).strip()
    return title, ([author] if author else [])


def _ensure_yaml_properties(path: Path, title_ar: str, authors_ar: list[str]) -> None:
    """Add the Arabic metadata to the parent MOC if the user has not set it.

    `authors-ar` is the one standard for Arabic names — a list, even for a
    single author. The old singular `author-ar` is retired and removed here;
    its value is recovered into the list when no list exists yet.
    """
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    end = _frontmatter_end(text)
    if end == -1:
        return
    frontmatter = text[:end]
    if not authors_ar and not re.search(r"^authors-ar:", frontmatter, re.M):
        existing = _existing_scalar(path, "author-ar")
        if existing:
            authors_ar = [existing]
    # Retire the singular property wherever it survived from an earlier render.
    new_frontmatter = re.sub(r"^author-ar:.*\n?", "", frontmatter, flags=re.M)
    additions = ""
    if title_ar and not re.search(r"^title-ar:", new_frontmatter, re.M):
        additions += f'title-ar: "{_yaml_quote(title_ar)}"\n'
    if authors_ar and not re.search(r"^authors-ar:", new_frontmatter, re.M):
        additions += "authors-ar:\n" + "".join(
            f'  - "{_yaml_quote(a)}"\n' for a in authors_ar)
    if not additions and new_frontmatter == frontmatter:
        return
    suffix = ("\n" + additions.rstrip("\n")) if additions else ""
    path.write_text(new_frontmatter + suffix + text[end:], encoding="utf-8")


def _transcription_metadata(citekey: str, standalone: bool,
                            unit: str | None = None) -> tuple[str, list[str]]:
    """A translation takes the Arabic title/author from its transcription."""
    parent = dest_path(citekey, "transcription", None, standalone,
                       unit=unit)
    return _existing_scalar(parent, "title-ar"), _existing_list(parent, "authors-ar")


# The bibliographic properties ScholarWeft uses on a literature note, in the
# order they should appear on the MOC. `volume` is deliberately absent: on a
# transcription note it is the transcription's own volume number, not the
# source's bibliographic volume.
CITATION_KEYS = (
    "item-type", "title", "shorttitle", "authors", "authors-ar",
    "editors", "translators", "contributors", "publisher", "place", "year",
    "edition", "series", "series-number", "volumes", "number", "issue", "pages",
    "doi", "isbn", "url", "language", "genre", "section", "citekey",
    "zotero-link",
)


def _frontmatter_blocks(text: str, keys: tuple[str, ...] | None = None) -> list[list[str]]:
    """Raw YAML property blocks (key line plus indented continuation lines)."""
    end = _frontmatter_end(text)
    if end == -1:
        return []
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for line in text[3:end].splitlines():
        match = re.match(r"^([A-Za-z][\w-]*):(.*)$", line)
        if match:
            if current:
                blocks.append(current)
            current = [line]
        elif current is not None and (line.startswith(" ") or line.startswith("\t")):
            current.append(line)
        else:
            if current:
                blocks.append(current)
            current = None
    if current:
        blocks.append(current)
    if keys:
        wanted = set(keys)
        blocks = [block for block in blocks
                  if re.match(r"^([A-Za-z][\w-]*):", block[0]).group(1) in wanted]
    return blocks


def _copy_bibliography(note_path: Path, ref_path: Path) -> None:
    """Copy ScholarWeft's citation properties from a literature note to a MOC.

    The source's `title`, `authors`, `authors-ar`, `shorttitle` and publication
    fields replace the generated descriptive versions; the note's own `midad-*`,
    `created`, `volume`, `topics`, `title-ar` and aliases are left alone.
    """
    if not note_path.exists() or not ref_path.exists():
        return
    source_blocks = _frontmatter_blocks(ref_path.read_text(encoding="utf-8"), CITATION_KEYS)
    if not source_blocks:
        return
    source: dict[str, list[str]] = {}
    for block in source_blocks:
        key = re.match(r"^([A-Za-z][\w-]*):", block[0]).group(1)
        source[key] = block
    text = note_path.read_text(encoding="utf-8")
    end = _frontmatter_end(text)
    if end == -1:
        return
    seen: set[str] = set()
    out: list[list[str]] = []
    for block in _frontmatter_blocks(text):
        key = re.match(r"^([A-Za-z][\w-]*):", block[0]).group(1)
        if key in source:
            out.append(source[key])
            seen.add(key)
        else:
            out.append(block)
    for key, block in source.items():
        if key not in seen:
            out.append(block)
    frontmatter = "\n".join(line for block in out for line in block)
    note_path.write_text("---\n" + frontmatter + "\n" + text[end:], encoding="utf-8")


def build_yaml(citekey: str, doc_type: str, related: list[str], volume: int = None,
               standalone: bool = False, title: str | None = None,
               shorttitle: str | None = None,
               authors: list[str] | None = None, editors: list[str] | None = None,
               topics: list[str] | None = None,
               title_ar: str = "", authors_ar: list[str] | None = None,
               shorttitle_ar: str = "", editors_ar: list[str] | None = None,
               unit: str | None = None,
               up: list[str] | None = None, arabic: bool = False) -> str:
    """Build YAML frontmatter from the Zotero reference and the aliases.

    A standalone transcription (a PDF the user chose directly, with no Zotero
    record) instead takes its title/authors from the metadata guessed during
    transcription. It deliberately has no `[[@citekey]]` midad-up link, because no
    literature note exists. Generated relationships go in `midad-up`; `up` stays
    user-managed.
    """
    ref = None if standalone else find_zotero(citekey)
    title_base = (title or "").strip() or "Untitled"
    short_base = (shorttitle or "").strip() or title_base
    raw_authors = [authors] if isinstance(authors, str) else (authors or [])
    author_list = [a.strip() for a in raw_authors if a and a.strip()]
    editor_list = [a.strip() for a in (editors or []) if a and a.strip()]

    if ref:
        text = ref.read_text(encoding="utf-8")
        title_base = extract_zotero_field(text, "title") or "Untitled"
        short_base = extract_zotero_field(text, "shorttitle") or (shorttitle or "").strip() or title_base
        author_field = extract_zotero_field(text, "authors")
        if author_field:
            author_list = [author_field.lstrip('- ').strip().strip('"')]
        editor_field = extract_zotero_field(text, "editors") or extract_zotero_field(text, "editor")
        if editor_field:
            editor_list = [editor_field.lstrip('- ').strip().strip('"')]

    unit_label = (unit or "").strip()
    title_suffix = doc_type
    if volume:
        title_suffix += f", vol. {volume}"
    title = f"{title_base} ({title_suffix})"
    shorttitle = f"{short_base} ({title_suffix})" if short_base != title_base else ""
    if unit_label:
        title += f" - {unit_label}"
        shorttitle += f" - {unit_label}" if shorttitle else ""
    up_category = "Arabic transcriptions" if doc_type == "transcription" else "Arabic translations"

    mas_up_items = [f'  - "[[{up_category}]]"']
    if not standalone:
        mas_up_items.append(f'  - "[[@{citekey}]]"')
        if volume:
            prefix = _note_prefix(standalone)
            mas_up_items.append(f'  - "[[{prefix}{citekey} - {doc_type}]]"')
    if not volume:
        mas_up_items.append('  - "[[Midad Arabic Sources]]"')

    source_id = _source_id(citekey, ref)
    mas_work = f"{source_id}:{doc_type}"
    unit_id = _unit_slug(unit_label) if unit_label else (f"vol.{volume}" if volume else "note")
    mas_id = f"{mas_work}:{unit_id}" if unit_id != "note" else mas_work

    yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d %H:%M')}
midad-up:
{chr(10).join(mas_up_items)}
midad-id: "{_yaml_id(mas_id)}"
midad-kind: "{doc_type}"
midad-work: "{_yaml_id(mas_work)}"
midad-unit: "{unit_id}"
title: "{_yaml_quote(title)}"
"""
    if not shorttitle_ar and title_ar:
        shorttitle_ar = re.split(r"[:،]", title_ar, maxsplit=1)[0].strip()
    if arabic:
        yaml += f'title-ar: "{_yaml_quote(title_ar)}"\n'
        yaml += f'shorttitle-ar: "{_yaml_quote(shorttitle_ar)}"\n'
    elif title_ar:
        yaml += f'title-ar: "{_yaml_quote(title_ar)}"\n'
    if shorttitle:
        yaml += f'shorttitle: "{_yaml_quote(shorttitle)}"\n'
    if volume:
        yaml += f'volume: {volume}\n'
    if author_list:
        yaml += "authors:\n"
        for a in author_list:
            yaml += f'  - "{_yaml_quote(a)}"\n'
    if authors_ar or arabic:
        # One standard: the list, even for a single author. The old singular
        # `author-ar` is not written and is removed from older notes.
        yaml += "authors-ar:\n" if authors_ar else "authors-ar: []\n"
        for a in authors_ar or []:
            yaml += f'  - "{_yaml_quote(a)}"\n'
    if editor_list:
        yaml += "editors:\n"
        for e in editor_list:
            yaml += f'  - "{_yaml_quote(e)}"\n'
    if editors_ar:
        yaml += "editors-ar:\n"
        for e in editors_ar:
            yaml += f'  - "{_yaml_quote(e)}"\n'

    year = _year_label(ref)
    aliases = canonical_citation_aliases(
        title=title_base, shorttitle=short_base, authors=author_list,
        authors_ar=authors_ar, title_ar=title_ar, shorttitle_ar=shorttitle_ar,
        year=year, doc_type=doc_type, volume=volume, unit=unit_label,
        include_arabic=os.environ.get("MIDAD_INCLUDE_ARABIC_ALIAS", "1") != "0",
    )
    if aliases:
        yaml += "aliases:\n"
        for a in aliases:
            yaml += f'  - "{_yaml_quote(a)}"\n'
    if related:
        yaml += "related:\n"
        for r in related:
            yaml += f'  - "{_yaml_quote(r)}"\n'
    if up:
        yaml += "up:\n"
        for value in up:
            yaml += f'  - "{_yaml_quote(value)}"\n'

    # Topics are user-assigned: the resource model counts this note under each
    # topic MOC named here, and the topic MOC lists it. A re-transcription keeps
    # the existing list.
    if topics:
        yaml += "topics:\n"
        for topic in topics:
            yaml += f'  - "{_yaml_quote(topic)}"\n'
    else:
        yaml += "topics: []\n"

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


def dest_path(citekey: str, doc_type: str, volume: int = None,
              standalone: bool = False, unit: str | None = None) -> Path:
    """Vault destination path for a note."""
    dest_dir = VAULT / DEST_FOLDERS[doc_type]
    dest_dir.mkdir(parents=True, exist_ok=True)
    prefix = _note_prefix(standalone)
    if volume:
        return dest_dir / f"{prefix}{citekey} - {doc_type} - vol. {volume}.md"
    if unit:
        legacy = dest_dir / f"{prefix}{citekey} - {doc_type}, {unit.strip()}.md"
        if legacy.exists():
            return legacy
        return dest_dir / f"{prefix}{citekey} - {doc_type} - {unit.strip()}.md"
    return dest_dir / f"{prefix}{citekey} - {doc_type}.md"


def ensure_parent(citekey: str, doc_type: str, related: list[str], volume: int,
                  standalone: bool = False, title_ar: str = "",
                  authors_ar: list[str] | None = None):
    """Create/update the multivolume parent note and its volume list."""
    if not volume:
        return None
    parent = dest_path(citekey, doc_type, None, standalone)
    if not parent.exists():
        parent.write_text(
            build_yaml(citekey, doc_type, related, standalone=standalone,
                       title_ar=title_ar, authors_ar=authors_ar) + "\n",
            encoding="utf-8")
        print(f"Created parent: {parent.name}")

    content = parent.read_text(encoding="utf-8")
    prefix = _note_prefix(standalone)
    target = f"{prefix}{citekey} - {doc_type} - vol. {volume}"
    link = re.compile(r"\[\[\s*" + re.escape(target) + r"\s*(?:[|#][^\]]*)?\]\]")
    # Keep the first link to this volume, whether or not it has a display
    # alias, and drop any duplicate that an older parent accumulated.
    lines = content.split("\n")
    seen = False
    deduped: list[str] = []
    for line in lines:
        if link.search(line):
            if seen:
                continue
            seen = True
        deduped.append(line)
    if seen:
        content = "\n".join(deduped)
        parent.write_text(content, encoding="utf-8")
    else:
        entry = f"[[{target}]]"
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
    _ensure_yaml_properties(parent, title_ar, authors_ar or [])
    return parent


def _collection_notes(citekey: str, doc_type: str, standalone: bool = False):
    """(parent_name, volume_names, partial_names) for a citekey."""
    folder = VAULT / DEST_FOLDERS[doc_type]
    prefix = _note_prefix(standalone)
    parent = f"{prefix}{citekey} - {doc_type}"
    vols = []
    partials = []
    if folder.exists():
        for pattern in (f"{prefix}{citekey} - {doc_type} - *.md",
                        f"{prefix}{citekey} - {doc_type}, *.md"):
            for p in folder.glob(pattern):
                if "modified" in p.stem:
                    continue
                m = re.search(r'vol\.\s*(\d+)', p.stem)
                if m:
                    vols.append((int(m.group(1)), p.stem))
                elif p.stem not in partials:
                    partials.append(p.stem)
    vols.sort(key=lambda t: t[0])
    return parent, [name for _, name in vols], sorted(partials)


def _write_list_property(citekey: str, prop: str, items: list) -> bool:
    """Replace the `prop:` YAML list on @citekey.md with `items`."""
    ref = find_zotero(citekey)
    if ref is None:
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


def sync_collection_property(citekey: str, doc_type: str, standalone: bool = False) -> bool:
    """Keep @citekey.md's transcriptions/translations list ordered:
    the parent note first, then the volumes in numerical order."""
    prop = "transcriptions" if doc_type == "transcription" else "translations"
    parent, vols, partials = _collection_notes(citekey, doc_type, standalone)
    folder = VAULT / DEST_FOLDERS[doc_type]
    items = []
    if (folder / f"{parent}.md").exists():
        items.append(parent)
    items.extend(vols)
    items.extend(partials)
    return _write_list_property(citekey, prop, items)


def write_note(body: str, citekey: str, doc_type: str, related: list[str] = None,
               volume: int = None, standalone: bool = False,
               title: str | None = None, authors: list[str] | None = None,
               unit: str | None = None, cover: dict | None = None) -> Path:
    """Build the YAML and write the finished note. Returns its path."""
    related = related or []
    cover = cover or {}
    editors = _cover_list(cover, "editors")
    editors_ar = _cover_list(cover, "editors-ar")
    if doc_type == "transcription":
        title_ar, authors_ar = extract_arabic_metadata(body)
        title_ar = _cover_scalar(cover, "title-ar") or title_ar
        authors_ar = _cover_list(cover, "authors-ar") or authors_ar
        shorttitle_ar = _cover_scalar(cover, "shorttitle-ar")
        if not title:
            title = _cover_scalar(cover, "title") or None
        if not authors:
            authors = _cover_list(cover, "authors") or None
        cover_shorttitle = _cover_scalar(cover, "shorttitle") or None
    else:
        title_ar, authors_ar = _transcription_metadata(citekey, standalone, unit)
        shorttitle_ar = ""
        cover_shorttitle = None
    if not standalone and volume:
        ensure_parent(citekey, doc_type, related, volume, standalone, title_ar, authors_ar)
    dest = dest_path(citekey, doc_type, volume, standalone, unit=unit)
    # A user's own Arabic metadata and editors win, exactly like `topics`.
    title_ar = _existing_scalar(dest, "title-ar") or title_ar
    authors_ar = _existing_list(dest, "authors-ar") or authors_ar
    shorttitle_ar = _existing_scalar(dest, "shorttitle-ar") or shorttitle_ar
    editors = _existing_list(dest, "editors") or editors
    editors_ar = _existing_list(dest, "editors-ar") or editors_ar
    is_arabic = bool(ARABIC_SCRIPT.search(body)) if doc_type == "transcription" else bool(title_ar or authors_ar)
    yaml = build_yaml(citekey, doc_type, related, volume=volume, standalone=standalone,
                      title=title, shorttitle=cover_shorttitle,
                      authors=authors, editors=editors, topics=_existing_topics(dest),
                      title_ar=title_ar, authors_ar=authors_ar,
                      shorttitle_ar=shorttitle_ar, editors_ar=editors_ar,
                      unit=unit, up=_existing_list(dest, "up"), arabic=is_arabic)
    dest.write_text(yaml + "\n" + body.strip() + "\n", encoding="utf-8")
    if not standalone and not unit:
        parent = dest_path(citekey, doc_type, None, standalone)
        _ensure_yaml_properties(parent, title_ar, authors_ar)
        ref = find_zotero(citekey)
        if ref:
            _copy_bibliography(parent, ref)
    # Record/refresh the ordered transcriptions/translations list on the
    # literature note: parent note first, then volumes in numerical order.
    if not standalone and sync_collection_property(citekey, doc_type, standalone):
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
    standalone = False

    i = 2
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--citekey" and i + 1 < len(sys.argv):
            citekey = sys.argv[i + 1]; i += 2
        elif arg == "--type" and i + 1 < len(sys.argv):
            doc_type = sys.argv[i + 1]; i += 2
        elif arg == "--related" and i + 1 < len(sys.argv):
            related.append(sys.argv[i + 1]); i += 2
        elif arg == "--standalone":
            standalone = True; i += 1
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
    dest = write_note(content, citekey, doc_type, related, volume, standalone=standalone)

    print(f"Moved: {dest.relative_to(VAULT)}")
    vol_info = f", vol. {volume}" if volume else ""
    print(f"Type: {doc_type}{vol_info}, Citekey: @{citekey}")


if __name__ == "__main__":
    main()
