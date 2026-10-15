#!/usr/bin/env python3
"""
Post-process a raw transcription: formatting + YAML + Qur'an tashkīl.
Usage: python3 scripts/transcription-postprocess.py <raw.md>
Output: <raw>.processed.<timestamp>.md
"""
import re, sys, os
from pathlib import Path
from datetime import datetime
from importlib.machinery import SourceFileLoader

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
SCRIPTS = Path(__file__).resolve().parent

def run(input_path, out_path=None):
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
    print(f"\nSaved: {out.name}")
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcription-postprocess.py <raw.md> [out.md]")
        sys.exit(1)
    out = sys.argv[2] if len(sys.argv) > 2 else None
    run(sys.argv[1], out)


if __name__ == "__main__":
    main()
