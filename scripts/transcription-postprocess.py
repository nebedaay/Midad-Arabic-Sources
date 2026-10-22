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


def _clean_meta(value: str) -> str:
    return value.strip().strip('"').strip("'").strip("*").strip()


def extract_metadata(body: str) -> tuple[str, dict[str, str]]:
    """Remove TITLE:/AUTHOR: lines anywhere and keep the first values.

    Gemini sometimes puts the markers on every page, and sometimes puts
    TITLE and AUTHOR on one line because there is no blank line between them.
    Both forms are removed; only the first title and author are kept.
    """
    meta: dict[str, str] = {}
    keep: list[str] = []
    removed = False
    for line in body.splitlines():
        pair = META_PAIR.match(line)
        single = None if pair else META_SINGLE.match(line)
        if pair:
            title, author = _clean_meta(pair.group(1)), _clean_meta(pair.group(2))
            if title and "title" not in meta:
                meta["title"] = title
            if author and "author" not in meta:
                meta["author"] = author
            removed = True
            continue
        if single:
            key = single.group(1).lower()
            value = _clean_meta(single.group(2))
            if value and key not in meta:
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


def run(input_path, out_path=None, metadata=False):
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
    
    content, discovered = tfq.discover_and_mark_quotes(content)
    print(f"  Discovered: {len(discovered)}")

    # Discard Gemini's own citations; every verse is located locally.
    content, refs_stripped = tfq.strip_gemini_refs(content)
    print(f"  Gemini refs discarded: {refs_stripped}")

    content, refs_added = tfq.add_missing_refs(content)
    print(f"  Refs added: {refs_added}")

    content, links_fixed = tfq.fix_wikilinks(content)
    print(f"  Links fixed: {links_fixed}")

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
    run(sys.argv[1], out, metadata="--metadata" in sys.argv)


if __name__ == "__main__":
    main()
