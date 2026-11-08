#!/usr/bin/env python3
"""
Post-process a raw transcription: formatting + YAML + Qur'an tashkīl.
Usage: python3 scripts/transcription-postprocess.py <raw.md>
Output: <raw>.processed.<timestamp>.md
"""
import re, sys, os, json
from pathlib import Path
from datetime import datetime
from importlib.machinery import SourceFileLoader

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
SCRIPTS = Path(__file__).resolve().parent

# Metadata lines the standalone-PDF prompt asks Gemini to put above the first
# page. They are not part of the transcription, so remove them before
# formatting and hand them to the pipeline as a sidecar. Gemini often repeats
# them on later pages, sometimes with TITLE and AUTHOR on the same line, so the
# removal is global rather than limited to the title page.
META_PAIR = re.compile(
    r'^\s*(?:\*\*)?TITLE(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s+'
    r'(?:\*\*)?AUTHOR(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$',
    re.I,
)
META_SINGLE = re.compile(
    r'^\s*(?:\*\*)?(TITLE|AUTHOR)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$',
    re.I,
)


def _clean_meta(value) -> str:
    return str(value or "").strip().strip('"').strip("'").strip("*").strip()


def _clean_list(value) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        text = _clean_meta(value)
        raw = re.split(r"[;\n]", text) if text else []
    return [_clean_meta(item) for item in raw if _clean_meta(item)]


def _simple_yaml(block: str) -> dict:
    """A tiny fallback for the small, flat cover block we ask the model for."""
    data: dict = {}
    current = ""
    for raw in block.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"^\s*-\s*(.*)$", line)
        if item and current:
            if not isinstance(data.get(current), list):
                data[current] = []
            data[current].append(_clean_meta(item.group(1)))
            continue
        field = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", line)
        if field:
            current = field.group(1)
            value = _clean_meta(field.group(2))
            if value:
                data[current] = value
            else:
                data[current] = []
    return data


COVER_KEYS = {
    "title", "shorttitle", "title-ar", "shorttitle-ar",
    "authors", "editors", "authors-ar", "editors-ar",
}


def _cover_metadata(block: str) -> dict:
    try:
        import yaml
        parsed = yaml.safe_load(block)
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        parsed = _simple_yaml(block)
    meta: dict = {}
    for key, value in parsed.items():
        if key not in COVER_KEYS:
            continue
        if key in ("authors", "editors", "authors-ar", "editors-ar"):
            values = _clean_list(value)
            if values:
                meta[key] = values
        else:
            value = _clean_meta(value)
            if value:
                meta[key] = value
    return meta


def _take_cover_block(body: str) -> tuple[str, dict]:
    """Remove a leading fenced (or `---` delimited) YAML cover block."""
    fence = re.match(r"^\s*```(?:ya?ml)?[ \t]*\n(.*?)\n```[ \t]*(?:\n|$)", body, re.S | re.I)
    if not fence:
        fence = re.match(r"^\s*---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)", body, re.S)
    if not fence:
        return body, {}
    meta = _cover_metadata(fence.group(1))
    if not meta:
        return body, {}
    rest = body[fence.end():]
    while rest.startswith("\n"):
        rest = rest[1:]
    return rest, meta


def extract_metadata(body: str) -> tuple[str, dict]:
    """Remove the first-page cover block and legacy TITLE:/AUTHOR: lines.

    The current prompt asks for a fenced YAML block only on the first page.
    Older archives and standalone runs may instead carry TITLE:/AUTHOR: lines,
    sometimes on every page and sometimes on one line; those are also removed,
    with the first value winning.
    """
    body, meta = _take_cover_block(body)
    keep: list[str] = []
    removed = bool(meta)
    for line in body.splitlines():
        pair = META_PAIR.match(line)
        single = None if pair else META_SINGLE.match(line)
        if pair:
            title, author = _clean_meta(pair.group(1)), _clean_meta(pair.group(2))
            if title and "title" not in meta:
                meta["title"] = title
            if author and "authors" not in meta:
                meta["authors"] = [author]
            removed = True
            continue
        if single:
            key = single.group(1).lower()
            value = _clean_meta(single.group(2))
            if value:
                if key == "author":
                    if "authors" not in meta:
                        meta["authors"] = [value]
                elif key not in meta:
                    meta[key] = value
            removed = True
            continue
        keep.append(line)
    if not removed:
        return body, {}
    # Drop blank lines left at the very top by the removed markers.
    while keep and not keep[0].strip():
        keep.pop(0)
    return "\n".join(keep), meta

def run(input_path, out_path=None, metadata=False, tafsir=False):
    """Format and Qur'an-process a raw transcription. Returns the output Path."""
    filepath = Path(input_path)
    if not filepath.exists():
        raise FileNotFoundError(filepath)

    print(f"Source: {filepath.name}")
    
    # Preserve existing YAML from input file
    raw_content = filepath.read_text(encoding="utf-8")
    if raw_content.startswith("---"):
        end = raw_content.find("---", 3)
        yaml = raw_content[:end + 3] if end > 0 else ""
        body = raw_content[end + 3:].strip() if end > 0 else raw_content
    else:
        yaml = ""
        body = raw_content

    # Standalone PDFs can carry a title/author guess at the top. Pull those
    # lines out before formatting and save them beside the processed note for
    # the pipeline to put into YAML.
    body, metadata_values = extract_metadata(body) if metadata else (body, {})

    import tempfile
    tmp = Path(tempfile.mktemp(suffix=".md"))
    tmp.write_text(body, encoding="utf-8")
    
    # Step 1: Formatting
    print("Step 1: Formatting...")
    pp = SourceFileLoader("pp", str(SCRIPTS / "transcription-format.py")).load_module()
    result = pp.process(str(tmp))
    # Exactly one blank line between the frontmatter and the page contents.
    if yaml:
        content = yaml.rstrip("\n") + "\n\n" + result.lstrip("\n")
    else:
        content = result.lstrip("\n")
    print(f"  Pages: {result.count('#### ')}")

    # Complete a citation split across a page break, e.g.
    #   [القلم: ١٠-   ---  #### p. 61   ٢ - سورة البقرة   ١٣]  أَي...
    # -> [القلم: ١٠-١٣]  ---  #### p. 61   ٢ - سورة البقرة   أَي...
    # (the citation tail is moved up; the page break/heading stay put)
    content = re.sub(
        r'\[([\u0600-\u06FF][^\]\n]*?[-\u2013\u2014])\s*'
        r'(\n+---\n+#{1,6}\s*p\.[^\n]*\n+)'
        r'(?:([^\n]*)\n+)?'
        r'([\u0660-\u0669\d][^\n\]]*?)\]',
        lambda m: '[' + m.group(1).strip() + m.group(4).strip() + ']'
                  + m.group(2)
                  + ((m.group(3) + '\n\n') if m.group(3) else ''),
        content,
    )
    
    # Step 2: Qur'an tashkīl + wikilinks
    print("Step 2: Qur'an tashkīl...")
    tfq = SourceFileLoader("tfq", str(SCRIPTS / "transcription-quran.py")).load_module()
    LF = '\ufd3f'; LE = '\ufd3e'

    content, cross_guillemets = tfq.fix_cross_page_guillemets(content)
    print(f"  Cross-page quoted continuations: {cross_guillemets}")

    content, discovered = tfq.discover_and_mark_quotes(content, tafsir=tafsir)
    print(f"  Discovered: {len(discovered)}")

    # Add links before discarding the source citations: a verified adjacent
    # citation is a cheap first search hint.
    content, refs_added = tfq.add_missing_refs(content)
    print(f"  Refs added: {refs_added}")

    content, refs_stripped = tfq.strip_gemini_refs(content)
    print(f"  Gemini refs discarded: {refs_stripped}")

    content, links_fixed = tfq.fix_wikilinks(content)
    print(f"  Links fixed: {links_fixed}")

    content, open_links = tfq.link_open_fragments(content, tafsir=tafsir)
    print(f"  Open-fragment links: {open_links}")

    content, stripped = tfq.strip_false_quran(content)
    print(f"  False Qur'an stripped: {stripped}")
    
    content = content.replace('\uFD3F\uFD3F', '\uFD3F')
    content = content.replace('\uFD3E\uFD3E', '\uFD3E')
    
    # Update tashkīl
    updated = 0
    pattern = re.compile(
        r'(\*' + LF + r')([^' + LE + LF + r'\n]+)(' + LE + r'\{\.quran-quote\}\*\s*'
        r'\(\[\[(\d{3})\s+[^#\]]+#(\d+)\|[^\]]+\]\]\))'
    )
    for m in reversed(list(pattern.finditer(content))):
        prefix = m.group(1)
        old_text = m.group(2).strip()
        suffix = m.group(3)
        surah = int(m.group(4))
        verse_num = int(m.group(5))
        fragment = tfq.get_tashkil_fragment(old_text, surah, verse_num)
        if fragment and fragment != old_text:
            content = content[:m.start()] + prefix + fragment + suffix + content[m.end():]
            updated += 1
    print(f"  Tashkīl updates: {updated}")
    
    markers = len(re.findall(r'\{\.quran-quote\}', content))
    print(f"  Total markers: {markers}")

    # Final repair of page headings, in case the Qur'an/tashkīl steps touched
    # one (e.g. "#### p * 310", or a heading glued onto a preceding line).
    content = re.sub(r'([^\n])(####\s+p\.?\s*\*?\s*\d+\s*)$', r'\1\n\n\2', content, flags=re.M)
    content = re.sub(r'^####\s+p\.?\s*\*?\s*(\d+)\s*$', r'#### p. \1', content, flags=re.M)

    # Enforce one blank line between all blocks (fixes "text\n---" setext
    # headings) and collapse any excess.
    content = pp.normalize_spacing(content)
    content = tfq.strip_orphan_quote_classes(content)
    content, raw_citations = tfq.strip_raw_quran_citations(content)
    print(f"  Raw Qur'an citations removed: {raw_citations}")
    content, redundant_citations = tfq.strip_redundant_raw_citations(content)
    print(f"  Redundant raw citations removed: {redundant_citations}")
    content, display_fixed = tfq.normalize_quran_link_display(content)
    print(f"  Qur'an link displays normalised: {display_fixed}")
    content, repeated_links = tfq.dedupe_same_verse_links(content)
    print(f"  Repeated same-verse links removed: {repeated_links}")
    
    # Save
    if out_path is None:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        out_path = filepath.parent / f"{filepath.stem}.processed.{ts}.md"
    out = Path(out_path)
    out.write_text(content, encoding="utf-8")
    meta_path = out.with_suffix(out.suffix + ".meta.json")
    if metadata_values:
        meta_path.write_text(json.dumps(metadata_values, ensure_ascii=False, indent=1), encoding="utf-8")
    elif meta_path.exists():
        meta_path.unlink()
    print(f"\nSaved: {out.name}")
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcription-postprocess.py <raw.md> [out.md] [--metadata]")
        sys.exit(1)
    out = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
    run(sys.argv[1], out, metadata="--metadata" in sys.argv, tafsir="--tafsir" in sys.argv)


if __name__ == "__main__":
    main()
