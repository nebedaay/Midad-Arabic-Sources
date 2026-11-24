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
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

# Page separators are owned by the shared postprocessor; import the pass
# directly so a missing definition fails loudly instead of silently skipping
# the normalisation.
from text_postprocess import (demote_long_poetry, normalize_page_separators,
                              unwrap_quran_quotes)

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

def run(input_path, out_path=None, metadata=False, tafsir=False, raw_ocr=True,
        discover=False):
    """Format and Qur'an-process a transcription body. Returns the output Path.

    `raw_ocr=True` when the text is unprocessed OCR rather than a rendered note
    (its own citations are
    stripped). `raw_ocr=False` for a note that is already rendered: its links
    are Midad's, and only simple source citations are removed. `discover` looks
    for quotations again, which raw OCR needs and a rendered note does not
    unless the reader asks.
    """
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
    # Keep the `*﴿…﴾{.quran-quote}*` scaffold: the Qur'ān passes in step 2 look
    # for a span in that form, and the formatter used to unwrap it here, which
    # left every marked quotation invisible to every linking pass.
    result = pp.process(str(tmp), gemini=raw_ocr, unwrap=False)
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
    tfq = SourceFileLoader("tfq", str(SCRIPTS / "quran.py")).load_module()
    tfs = SourceFileLoader("tfs", str(SCRIPTS / "tafsir.py")).load_module()
    LF = '\ufd3f'; LE = '\ufd3e'

    # A line too long for a hemistich is not poetry: demote the callout to a
    # block quote first, so the Qur'ān passes below see prose and may cite it.
    content, demoted = demote_long_poetry(content)
    print(f"  Poetry callouts demoted to block quotes: {demoted}")

    # What is left really is verse, and a verse is never cited: parked for the
    # whole Qur'ān section and restored below.
    content, poetry_blocks = tfq.mask_poetry(content)

    # One sequence for every genre. Everything between here and the render is
    # the shared Qur'ān pipeline; this function's only job is to hand it the
    # inputs that are properties of *this* source — whether it is a commentary,
    # which delimiters its own text uses for quotations, and whether the text is
    # unreviewed OCR. A repository importer supplies the same inputs and runs
    # the same stages.
    delims = tfq.detect_quote_delims(content)
    if delims:
        print(f"  Quote delimiters: {', '.join(delims)}")
    content, stats = tfs.process_quran(
        content,
        mode="tafsir" if tafsir else "default",
        delims=delims,
        discover=discover,
        raw_ocr=raw_ocr,
    )
    print(f"  Damaged citations repaired: {stats['damaged_links']}")
    print(f"  Cross-page quoted continuations: {stats['cross_page_guillemets']}")
    print(f"  Discovered: {stats.get('discovered', 0)}")
    print(f"  Refs added: {stats['refs_added']}")
    print(f"  Gemini refs discarded: {stats.get('gemini_refs', 0)}")
    print(f"  Links fixed: {stats['links_fixed']}")
    print(f"  Open-fragment links: {stats['open_fragments']}")
    if tafsir:
        print(f"  Short verse fragments: {stats.get('short_fragments', 0)}")
    print(f"  False Qur'an stripped: {stats['false_quran']}")
    if tafsir:
        print(f"  Repeated verse links removed: {stats['repeated_links']}")
    print(f"  Tashkīl updates: {stats['tashkil']}")
    print(f"  Total markers: {len(re.findall(r'\{\.quran-quote\}', content))}")
    if stats["unbalanced_parens"]:
        print(f"  Unpaired ornate parens repaired: {stats['unbalanced_parens']}")
    if tafsir:
        print(f"  Verse headings: {stats['markers']}")
        print(f"  Inline verse links dropped: {stats['inline_links']}, "
              f"duplicate markers: {stats['duplicate_markers']}")
    print(f"  Raw Qur'an citations removed: {stats['raw_citations']}")
    print(f"  Redundant raw citations removed: {stats['redundant_citations']}")
    print(f"  Qur'an link displays normalised: {stats['displays']}")
    print(f"  Repeated same-verse links removed: {stats['repeated_links']}")

    # Final repair of page headings, in case the Qur'an/tashkīl steps touched
    # one (e.g. "#### p * 310", or a heading glued onto a preceding line).
    content = re.sub(r'([^\n])(####\s+p\.?\s*\*?\s*\d+\s*)$', r'\1\n\n\2', content, flags=re.M)
    content = re.sub(r'^####\s+p\.?\s*\*?\s*(\d+)\s*$', r'#### p. \1', content, flags=re.M)

    # Enforce one blank line between all blocks (fixes "text\n---" setext
    # headings) and collapse any excess.
    content = pp.normalize_spacing(content)
    # A citation link is inserted with a space on each side; the surrounding
    # text usually supplies one too, leaving a double space that the *next*
    # update would collapse. Collapsing it here makes an update of an already
    # updated note byte-identical, which is what keeps the "changed since the
    # last render" review from firing on notes nobody touched.
    content = re.sub(r'([\]\)])[ \t]{2,}', r'\1 ', content)
    # Two cosmetic leftovers used to need a *second* run to be fixed: a stray
    # bracket after a link, and a styled span missing one of its stars. Tidying
    # them here makes the update path settle in one pass, so the next update of
    # the same note is byte-identical and no "changed since the last render"
    # review is raised for a note nobody touched.
    content, _ = tfq.repair_damaged_links(content)
    content = re.sub(r'(?<!\*)(\ufd3f[^\ufd3e\n]+\ufd3e\{\.quran-quote\})',
                     r'*\1', content)
    content = re.sub(r'\*{2,}(\ufd3f)', r'*\1', content)
    content = normalize_page_separators(content)
    # The shared sequence is finished. What remains is the settling pass that
    # makes a second render byte-identical: the repairs just above can expose
    # debris the citation tidies could not see the first time, so they run once
    # more and report a single total rather than a second stage list.
    content = tfq.strip_orphan_quote_classes(content)
    settled = 0
    content, n = tfq.strip_raw_quran_citations(content)
    settled += n
    content, n = tfq.strip_redundant_raw_citations(content)
    settled += n
    content, n = tfq.normalize_quran_link_display(content)
    settled += n
    if tafsir:
        content, n = tfs.keep_first_verse_link(content)
    else:
        content, n = tfq.dedupe_same_verse_links(content)
    settled += n
    print(f"  Settled in one pass: {settled}")

    # The processing form (`*﴿…﴾{.quran-quote}*`) is a scaffold the linking
    # passes read. The note keeps only the ornate parentheses, with `~` where
    # a boundary must not print — no custom-class Markdown, no italics.
    content = unwrap_quran_quotes(content)
    content = tfq.unmask_poetry(content, poetry_blocks)
    # Escape source citations last, after every citation/link pass has run.
    content = pp.escape_literal_brackets(content)
    
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
    run(sys.argv[1], out, metadata="--metadata" in sys.argv, tafsir="--tafsir" in sys.argv,
        discover="--discover" in sys.argv)


if __name__ == "__main__":
    main()
