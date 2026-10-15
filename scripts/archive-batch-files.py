#!/usr/bin/env python3
"""
Archive the intermediate .txt/.json files for one volume into a single zip.

Usage:
  python3 scripts/archive-batch-files.py <batch.txt> [--dest DIR] [--remove]

<batch.txt> is either "<stem>.batch.txt" (a transcription) or
"<stem>.translate.txt" (a translation).  The archive is named
  <citekey> - transcription - vol. N files.zip
  <citekey> - translation   - vol. N files.zip
(or without " - vol. N" for a single-volume work) and written to the dedicated
archive folder, by default:
  AI OS/Arabic Transcriptions/Arabic OCR archive

Only the txt/json intermediates are archived (not the page PDFs, raw.md or the
finished note).  --remove deletes the loose originals after zipping.
"""
import re
import sys
import zipfile
from pathlib import Path

VAULT = Path("/Users/josephhill/Documents/Obsidian Vault")
ARCHIVE_DIR = VAULT / ".midad-arabic-sources" / "archive"

# Intermediate files per document type (page PDFs deliberately excluded).
INTERMEDIATES = {
    "transcription": ["{stem}.batch.txt", "{stem}.batch.jsonl", "{stem}-output.jsonl"],
    "translation": ["{stem}.translate.txt", "{stem}.translate.jsonl", "{stem}.translate-output.jsonl"],
}


def vault_stem(stem: str):
    """Return (citekey, volume) parsed from a batch stem."""
    m = re.match(r'(@\S+)', stem)
    citekey = m.group(1) if m else stem
    vm = re.search(r'\b(?:vol|v)\.\s*(\d+)\b', stem, re.I)
    return citekey, (int(vm.group(1)) if vm else None)


def archive_name(stem: str, doc_type: str, citekey: str = None, volume: int = None) -> str:
    if citekey is None or volume is None:
        ck, vol = vault_stem(stem)
        citekey = citekey or ck
        volume = volume if volume is not None else vol
    if volume:
        return f"{citekey} - {doc_type} - vol. {volume} files.zip"
    return f"{citekey} - {doc_type} files.zip"


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/archive-batch-files.py <batch.txt> [--dest DIR] [--remove]")
        sys.exit(1)

    batch_file = Path(sys.argv[1]).resolve()
    if not batch_file.exists():
        print(f"ERROR: {batch_file} not found")
        sys.exit(1)

    name = batch_file.name
    if name.endswith(".batch.txt"):
        doc_type, stem = "transcription", name[:-len(".batch.txt")]
    elif name.endswith(".translate.txt"):
        doc_type, stem = "translation", name[:-len(".translate.txt")]
    else:
        print("ERROR: expected <stem>.batch.txt or <stem>.translate.txt")
        sys.exit(1)

    dest_dir = ARCHIVE_DIR
    if "--dest" in sys.argv:
        idx = sys.argv.index("--dest")
        if idx + 1 < len(sys.argv):
            dest_dir = Path(sys.argv[idx + 1]).expanduser()
    dest_dir.mkdir(parents=True, exist_ok=True)

    citekey = None
    if "--citekey" in sys.argv:
        idx = sys.argv.index("--citekey")
        if idx + 1 < len(sys.argv):
            citekey = sys.argv[idx + 1]
    volume = None
    if "--volume" in sys.argv:
        idx = sys.argv.index("--volume")
        if idx + 1 < len(sys.argv):
            volume = int(sys.argv[idx + 1])

    files = [batch_file.parent / pat.format(stem=stem) for pat in INTERMEDIATES[doc_type]]
    files = [f for f in files if f.exists()]
    if not files:
        print(f"ERROR: no intermediate files found next to {batch_file.name}")
        sys.exit(1)

    zip_path = dest_dir / archive_name(stem, doc_type, citekey, volume)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, arcname=f.name)

    print(f"Archived {len(files)} file(s) -> {zip_path}")
    for f in files:
        print(f"  {f.name}")

    if "--remove" in sys.argv:
        for f in files:
            f.unlink()
        print(f"Removed {len(files)} original file(s)")


if __name__ == "__main__":
    main()
