#!/usr/bin/env python3
"""
Script 1: Submit a PDF for Gemini Batch OCR.

Usage: python3 scripts/gemini-batch-submit.py input.pdf

Steps:
1. Burst the PDF into individual page PDFs in input-pages/
2. Upload each page to Google's File API
3. Build a JSONL with batch requests
4. Submit the batch job and save the job name to input.pdf.batch.txt
"""
import fitz  # PyMuPDF
import json
import os
import sys
import time
from pathlib import Path
from google import genai
from google.genai import types

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
# Fix non-ASCII characters that sometimes creep into API keys (e.g. non-breaking hyphen)
API_KEY = API_KEY.replace("\u2011", "-").encode("ascii", errors="replace").decode("ascii")

SYSTEM_PROMPT = (
    "You are an expert editor specializing in classical Arabic literature. "
    "OCR and transcribe the provided page of an Arabic book directly into clean, strict Obsidian Markdown. "
    "Do not add, remove, reorder, or guess at text. Reproduce the tashkīl that is present in the source; do not invent tashkīl.\n\n"

    "PAGE HEADING\n"
    "- Begin the page with the PRINTED page number as a level-4 heading, in Western digits: '#### p. 12'. "
    "For an unnumbered page use '#### Cover', '#### Copyright page', '#### Title page', etc.; if the number cannot be read use '#### p. ?'.\n"
    "- Do NOT output the PDF/file page number, the input filename, or a '---' separator; the pipeline adds those.\n"
    "- On a cover or title page, render the title as '# Title', the subtitle or author as '## ...', and the remaining cover text as plain paragraphs.\n\n"

    "BLOCKS\n"
    "- Put exactly one empty line between every block element (page heading, headings, paragraphs, poetry, footnotes).\n"
    "- Keep each body paragraph on a single line, with no internal line breaks.\n"
    "- Format chapter headings (often bold or centred in the original) as '### Title'.\n"
    "- Format italics with *asterisks*, not _underscores_.\n\n"

    "POETRY\n"
    "- Treat consecutive poetry lines as one block, with NO blank lines between them.\n"
    "- Format each couplet on one line exactly as '* hemistich 1%%hemistich 2' (leading asterisk and space, the two hemistiches joined by '%%').\n"
    "- A line with a single hemistich: '* hemistich'.\n"
    "- The leading '* ' and the '%%' marker are used ONLY for poetry, never for italics or list bullets.\n\n"

    "QUR'AN QUOTES\n"
    "- Put every Qur'an verse or fragment between ornate parentheses wrapped in asterisks, like this: '*\uFD3Fverse text\uFD3E*'.\n"
    "- Mark a quote even when it is only a word or two, and even when the source does not set it off with quotation marks.\n"
    "- Do NOT add sura:verse references or wikilinks, and do not add tashkīl to Qur'an quotes; "
    "post-processing adds the reference, the wikilink, and the tashkīl.\n"
    "- If the page ends mid-quote (opening bracket but no closing bracket), end the span with '*' and no closing bracket. "
    "If the page begins with a quote continuation (closing bracket but no opening bracket), start the span with '*' and no opening bracket.\n"
    "- Do NOT use ornate parentheses for hadith or other non-Qur'anic quotations; use regular parentheses or the quotation marks used in the source.\n\n"

    "FOOTNOTES\n"
    "- Put footnotes at the end of the page body, after a line containing only '***'.\n"
    "- Format each footnote as its own list item '- N – text' (using the printed footnote number and an en dash), one per line; "
    "a footnote continuation line begins with '- '.\n\n"

    "ACCURACY\n"
    "- Do not loop or repeat text if characters are blurry.\n"
    "- Check the result before returning: if it is implausibly long for a single page (for example, more than 800 words) "
    "or highly repetitive, discard it and transcribe the page once more."
)


def burst_pdf(pdf_path: Path, pages_dir: Path):
    """Split a PDF into individual page PDFs. Cleans existing directory first."""
    # Clean existing pages to avoid mixing with previous runs
    if pages_dir.exists():
        import shutil
        shutil.rmtree(pages_dir)
    pages_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf_path))
    total = len(doc)
    print(f"Bursting {total} pages from {pdf_path.name}...")
    
    for i in range(total):
        new_doc = fitz.open()
        new_doc.insert_pdf(doc, from_page=i, to_page=i)
        out_path = pages_dir / f"pg_{i+1:04d}.pdf"
        new_doc.save(str(out_path))
        new_doc.close()
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{total} pages...")
    
    doc.close()
    print(f"  Done. {total} pages in {pages_dir}")


import unicodedata

def ascii_safe(s: str) -> str:
    """Strip diacritics and non-ASCII chars for HTTP header safety."""
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')


def upload_pages(pages_dir: Path, client: genai.Client) -> list:
    """Upload all page PDFs to Gemini File API. Returns list of {local_name, uri, mime_type}."""
    import tempfile, shutil
    
    pdf_files = sorted(pages_dir.glob("pg_*.pdf"))
    if not pdf_files:
        return []
    
    # Copy to ASCII-safe temp dir (HTTP headers can't have non-ASCII chars in file paths)
    tmp_dir = Path(tempfile.mkdtemp(prefix="gemini_pages_"))
    tmp_files = []
    for path in pdf_files:
        dest = tmp_dir / path.name
        shutil.copy2(path, dest)
        tmp_files.append((path.stem, dest))
    
    uploaded = []
    for i, (name, path) in enumerate(tmp_files):
        print(f"  [{i+1}/{len(tmp_files)}] Uploading {name}...", flush=True)
        try:
            file = client.files.upload(
                file=str(path),
                config=types.UploadFileConfig(
                    display_name=name,  # pg_0001 is already ASCII-safe
                    mime_type="application/pdf"
                )
            )
            uploaded.append({
                "local_name": name,
                "uri": file.uri,
                "mime_type": file.mime_type
            })
        except Exception as e:
            print(f"    ERROR: {e}", flush=True)
    
    # Clean up temp dir
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return uploaded


def build_jsonl(uploaded: list, jsonl_path: Path):
    """Build the batch request JSONL."""
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for item in uploaded:
            payload = {
                "key": item["local_name"],
                "request": {
                    "model": "models/gemini-3.5-flash-lite",
                    "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"file_data": {"file_uri": item["uri"], "mime_type": item["mime_type"]}},
                            {"text": "OCR this Arabic PDF document page and output it as structural Markdown."}
                        ]
                    }]
                }
            }
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"  JSONL: {jsonl_path}")


def submit_batch(jsonl_path: Path, client: genai.Client, pdf_stem: str) -> str:
    """Upload JSONL and submit batch job. Returns batch job name."""
    import tempfile, shutil
    
    # Copy JSONL to ASCII-safe temp file for upload
    safe_stem = ascii_safe(pdf_stem)
    tmp_dir = Path(tempfile.mkdtemp(prefix="gemini_batch_"))
    tmp_jsonl = tmp_dir / f"{safe_stem}.jsonl"
    shutil.copy2(jsonl_path, tmp_jsonl)
    
    config_upload = client.files.upload(
        file=str(tmp_jsonl),
        config=types.UploadFileConfig(display_name=f"{safe_stem}_config", mime_type="text/plain")
    )
    
    batch = client.batches.create(
        model="models/gemini-3.5-flash-lite",
        src=config_upload.name,
        config=types.CreateBatchJobConfig(display_name=f"{safe_stem}_batch")
    )
    
    shutil.rmtree(tmp_dir, ignore_errors=True)
    print(f"  Batch submitted: {batch.name}")
    return batch.name


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 gemini-batch-submit.py input.pdf")
        sys.exit(1)
    
    pdf_path = Path(sys.argv[1]).resolve()
    if not pdf_path.exists():
        print(f"ERROR: {pdf_path} not found")
        sys.exit(1)
    
    work_dir = pdf_path.parent
    if "--work-dir" in sys.argv:
        idx = sys.argv.index("--work-dir")
        if idx + 1 < len(sys.argv):
            work_dir = Path(sys.argv[idx + 1]).expanduser()
    work_dir.mkdir(parents=True, exist_ok=True)

    stem = pdf_path.stem
    pages_dir = work_dir / f"{stem}-pages"
    jsonl_path = work_dir / f"{stem}.batch.jsonl"
    batch_file = work_dir / f"{stem}.batch.txt"
    
    if not API_KEY:
        print("ERROR: No API key found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.")
        sys.exit(1)
    
    client = genai.Client(api_key=API_KEY)
    
    # 1. Burst PDF
    burst_pdf(pdf_path, pages_dir)
    
    # 2. Upload pages
    print(f"\nUploading pages to Gemini File API...")
    uploaded = upload_pages(pages_dir, client)
    print(f"  Uploaded {len(uploaded)} pages")
    
    # 3. Build JSONL
    print(f"\nBuilding batch JSONL...")
    build_jsonl(uploaded, jsonl_path)
    
    # 4. Submit batch
    print(f"\nSubmitting batch job...")
    job_name = submit_batch(jsonl_path, client, stem)
    
    # 5. Save job name
    with open(batch_file, "w") as f:
        f.write(job_name)
    
    print(f"\nDone! Batch job: {job_name}")
    print(f"Job name saved to: {batch_file}")
    print(f"\nRun 'scripts/gemini-batch-process.py {batch_file}' to check status and download results.")
