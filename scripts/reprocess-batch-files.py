#!/usr/bin/env python3
"""
Reprocess a transcription or translation from its archived batch zip (or the
loose batch files) after a change to post-processing -- using the saved JSON
output, with no Gemini resubmission and no manual unzipping.

Usage:
  python3 scripts/reprocess-batch-files.py <archive.zip> [--out PATH]
  python3 scripts/reprocess-batch-files.py <stem>.batch.txt [--out PATH]
  python3 scripts/reprocess-batch-files.py <stem>.translate.txt [--out PATH]

The zip is expected to contain the files written by archive-batch-files.py:
  transcription: <stem>.batch.txt, <stem>.batch.jsonl, <stem>-output.jsonl
  translation:   <stem>.translate.txt, <stem>.translate.jsonl,
                 <stem>.translate-output.jsonl

The result is written next to the input as
  @citekey - transcription|translation - vol. N.md
(or without " - vol. N" for a single-volume work), or to --out.
"""
import re
import json
import shutil
import sys
import tempfile
import zipfile
from importlib.machinery import SourceFileLoader
from pathlib import Path

VAULT = Path("/Users/josephhill/Documents/Obsidian Vault")
SCRIPTS = Path(__file__).resolve().parent


def load(name: str):
    path = SCRIPTS / name
    return SourceFileLoader(path.stem, str(path)).load_module()


PAGE_HEADER = re.compile(r"^####\s+p\.\s*([0-9:]+)\s*$")


def corrections_path(src: Path) -> Path:
    return Path(str(src) + ".corrections.json")


def load_corrections(src: Path) -> dict:
    p = corrections_path(src)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def apply_page_corrections(content: str, corrections: dict) -> str:
    """Replace processed page bodies with the user's committed corrections.

    Pages are matched by their order in the note, not by printed page number, so
    a corrected page number survives a reprocess. Separators and all unmatched
    prose are left as the postprocessor wrote them.
    """
    pages = corrections.get("pages") if isinstance(corrections, dict) else None
    if not isinstance(pages, list) or not pages:
        return content
    lines = content.split("\n")
    out: list[str] = []
    page_index = 0
    i = 0
    while i < len(lines):
        match = PAGE_HEADER.match(lines[i])
        if not match:
            out.append(lines[i])
            i += 1
            continue
        correction = pages[page_index] if page_index < len(pages) else None
        page_index += 1
        if not isinstance(correction, dict):
            out.append(lines[i])
            i += 1
            continue
        number = str(correction.get("number") or match.group(1)).strip()
        out.append(f"#### p. {number}")
        out.append("")
        # Find the original page body; keep the separator that follows it.
        j = i + 1
        while j < len(lines) and not PAGE_HEADER.match(lines[j]) and lines[j].strip() != "---":
            j += 1
        body = str(correction.get("body") or "").strip("\n")
        if body:
            out.extend(body.split("\n"))
        if j < len(lines) and lines[j].strip() == "---":
            out.append("")
        i = j
    return "\n".join(out)

def vault_name(stem: str, doc_type: str) -> str:
    m = re.match(r'(@\S+)', stem)
    citekey = m.group(1) if m else stem
    vm = re.search(r'\b(?:vol|v)\.\s*(\d+)\b', stem, re.I)
    if vm:
        return f"{citekey} - {doc_type} - vol. {int(vm.group(1))}.md"
    return f"{citekey} - {doc_type}.md"


def resolve(src: Path, workdir: Path):
    """Return (doc_type, stem, base_dir). Unzips src if needed."""
    if src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            z.extractall(workdir)
        files = [workdir / n for n in z.namelist()]
        base = workdir
    else:
        files = [src]
        base = src.parent

    for f in files:
        if f.name.endswith(".batch.txt"):
            return "transcription", f.name[:-len(".batch.txt")], base
    for f in files:
        if f.name.endswith(".translate.txt"):
            return "translation", f.name[:-len(".translate.txt")], base
    for f in files:
        if f.name.endswith(".translate-output.jsonl"):
            return "translation", f.name[:-len(".translate-output.jsonl")], base
        if f.name.endswith("-output.jsonl"):
            return "transcription", f.name[:-len("-output.jsonl")], base
    raise SystemExit("ERROR: could not determine batch type/stem from the input")


def existing_metadata(mv, citekey: str, doc_type: str, volume, unit: str | None = None):
    """Title/author from an existing note, for a standalone reprocess."""
    path = mv.dest_path(citekey, doc_type, volume, unit=unit)
    if not path.exists():
        return None, None
    text = path.read_text(encoding="utf-8")
    title = mv.extract_zotero_field(text, "title")
    if title:
        title = re.sub(
            r'\s*\((?:transcription|translation)(?:,\s*vol\.\s*\d+)?\)\s*$',
            '', title, flags=re.I,
        ).strip()
    author = mv.extract_zotero_field(text, "authors")
    authors = []
    if author:
        authors = [author.lstrip('- ').strip().strip('"')]
    m = re.search(r'^authors:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)+)', text, re.M)
    if m:
        authors = []
        for line in m.group(1).rstrip("\n").split("\n"):
            mm = re.match(r'^[ \t]+-[ \t]*(.*)$', line)
            if mm:
                value = mm.group(1).strip()
                if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                    value = value[1:-1]
                if value:
                    authors.append(value)
    return title or None, (authors or None)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/reprocess-batch-files.py <archive.zip|batch.txt> [--out PATH]")
        sys.exit(1)

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"ERROR: {src} not found")
        sys.exit(1)

    out_override = None
    if "--out" in sys.argv:
        idx = sys.argv.index("--out")
        if idx + 1 < len(sys.argv):
            out_override = Path(sys.argv[idx + 1]).expanduser()

    workdir = Path(tempfile.mkdtemp(prefix="reprocess_"))
    try:
        doc_type, stem, base = resolve(src, workdir)
        if not base.exists():
            base.mkdir(parents=True, exist_ok=True)

        mv = load("transcription-translation-move-to-vault.py")
        tbp = load("translate-batch-process.py")
        # The batch stem is the PDF filename, which need not match the
        # citekey. The archive's own name carries the citekey (and volume), so
        # prefer it when it follows the archive naming pattern; a loose or
        # renamed batch file uses its stem.
        archive_stem = stem
        if src.suffix.lower() == ".zip" and re.search(
            r'\s+-\s+(?:transcription|translation)\b', src.stem, re.I
        ):
            archive_stem = src.stem
        unit = None
        archive_match = re.match(
            r'(@?\S+)\s+-\s+(?:transcription|translation)'
            r'(?:\s+-\s+(?:vol|v)\.\s*(\d+))?'
            r'(?:\s+-\s+(.+?))?\s+files$',
            archive_stem, re.I)
        if archive_match:
            citekey = archive_match.group(1)
            volume = int(archive_match.group(2)) if archive_match.group(2) else None
            unit = (archive_match.group(3) or "").strip() or None
        else:
            citekey, volume = tbp.citekey_and_volume(archive_stem)

        if doc_type == "translation":
            jsonl = base / f"{stem}.translate-output.jsonl"
            if not jsonl.exists():
                print(f"ERROR: {jsonl.name} not found in the archive")
                sys.exit(1)
            result = tbp.read_output_jsonl(jsonl)
            result = tbp.postprocess_translation(result)
            result = apply_page_corrections(result, load_corrections(src))
            if out_override:
                out_override.write_text(tbp.build_translation(stem, result), encoding="utf-8")
                dest = out_override
            else:
                dest = mv.write_note(result, citekey, "translation", volume=volume, unit=unit)
        else:
            jsonl = base / f"{stem}-output.jsonl"
            if not jsonl.exists():
                print(f"ERROR: {jsonl.name} not found in the archive")
                sys.exit(1)
            tpr = load("transcription-process-raw.py")
            raw_path = workdir / f"{stem}-raw.md"
            tpr.concatenate(jsonl, raw_path)
            yaml = tpr._build_yaml(stem)
            raw_text = raw_path.read_text(encoding="utf-8")
            raw_path.write_text(yaml.rstrip("\n") + "\n\n" + raw_text.lstrip("\n"), encoding="utf-8")

            processed = workdir / "processed.md"
            # Cover metadata is extracted for every transcription: it supplies
            # the Arabic title/author fields even when Zotero supplies the
            # romanized bibliography.
            standalone = mv.find_zotero(citekey) is None
            tpp = load("transcription-postprocess.py")
            tpp.run(raw_path, out_path=processed, metadata=True)
            processed.write_text(
                apply_page_corrections(processed.read_text(encoding="utf-8"), load_corrections(src)),
                encoding="utf-8",
            )

            if out_override:
                out_override.write_text(processed.read_text(encoding="utf-8"), encoding="utf-8")
                dest = out_override
            else:
                body = processed.read_text(encoding="utf-8")
                if body.startswith("---"):
                    end = body.find("---", 3)
                    if end > 0:
                        body = body[end + 3:].strip()
                # A standalone PDF has no literature note. Preserve the
                # existing note's verified title/author, fill any gap from the
                # fresh sidecar, and do not add a [[@citekey]] up link.
                meta_path = processed.with_suffix(processed.suffix + ".meta.json")
                cover = {}
                if meta_path.exists():
                    try:
                        parsed = json.loads(meta_path.read_text(encoding="utf-8"))
                        if isinstance(parsed, dict):
                            cover = parsed
                    except Exception:
                        cover = {}
                title, authors = (None, None)
                if standalone:
                    title, authors = existing_metadata(mv, citekey, "transcription", volume, unit)
                    # The existing note is authoritative: the user may have
                    # verified/edited its romanized title and author. Use the
                    # fresh sidecar only to fill a missing value.
                    if not title:
                        title = cover.get("title") if isinstance(cover.get("title"), str) else None
                    if not authors:
                        if isinstance(cover.get("authors"), list):
                            authors = [str(a).strip() for a in cover["authors"] if str(a).strip()] or None
                        elif isinstance(cover.get("author"), str):
                            authors = [a.strip() for a in cover["author"].split(";") if a.strip()] or None
                dest = mv.write_note(body, citekey, "transcription", volume=volume,
                                     standalone=standalone, title=title, authors=authors,
                                     unit=unit, cover=cover)

        print(f"\nReprocessed -> {dest}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
