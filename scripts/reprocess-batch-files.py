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


def existing_metadata(mv, citekey: str, doc_type: str, volume):
    """Title/author from an existing note, for a standalone reprocess."""
    path = mv.dest_path(citekey, doc_type, volume)
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
        citekey, volume = tbp.citekey_and_volume(archive_stem)

        if doc_type == "translation":
            jsonl = base / f"{stem}.translate-output.jsonl"
            if not jsonl.exists():
                print(f"ERROR: {jsonl.name} not found in the archive")
                sys.exit(1)
            result = tbp.read_output_jsonl(jsonl)
            result = tbp.postprocess_translation(result)
            if out_override:
                out_override.write_text(tbp.build_translation(stem, result), encoding="utf-8")
                dest = out_override
            else:
                dest = mv.write_note(result, citekey, "translation", volume=volume)
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
            # A standalone PDF has no literature note; only then does the
            # post-processor extract TITLE:/AUTHOR: markers.
            standalone = mv.find_zotero(citekey) is None
            tpp = load("transcription-postprocess.py")
            tpp.run(raw_path, out_path=processed, metadata=standalone)

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
                title, authors = (None, None)
                if standalone:
                    title, authors = existing_metadata(mv, citekey, "transcription", volume)
                    # The existing note is authoritative: the user may have
                    # verified/edited its romanized title and author. Use the
                    # fresh sidecar only to fill a missing value.
                    if not title or not authors:
                        meta_path = processed.with_suffix(processed.suffix + ".meta.json")
                        if meta_path.exists():
                            try:
                                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                                title = title or meta.get("title") or None
                                author = meta.get("author")
                                if not authors and author:
                                    authors = [a.strip() for a in author.split(";") if a.strip()]
                            except Exception:
                                pass
                dest = mv.write_note(body, citekey, "transcription", volume=volume,
                                     standalone=standalone, title=title, authors=authors)

        print(f"\nReprocessed -> {dest}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
