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

# The built-in prompt lives in midad_prompts.py so the plugin can seed and refresh
# its "Default prompt" from the same text, and the general rules stay hardcoded.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from midad_prompts import build_transcription_prompt  # noqa: E402

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
# Fix non-ASCII characters that sometimes creep into API keys (e.g. non-breaking hyphen)
API_KEY = API_KEY.replace("\u2011", "-").encode("ascii", errors="replace").decode("ascii")

SYSTEM_PROMPT = build_transcription_prompt()


def read_prompt(path: str | None) -> str | None:
    """The selected text-specific prompt, or None to use the built-in default."""
    if path:
        try:
            text = Path(path).read_text(encoding="utf-8").strip()
            if text:
                return text
            print(f"WARNING: prompt file is empty: {path}; using the built-in prompt.")
        except Exception as e:
            print(f"WARNING: could not read prompt file {path}: {e}; using the built-in prompt.")
    return None


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


def build_jsonl(uploaded: list, jsonl_path: Path, system_prompt: str = SYSTEM_PROMPT):
    """Build the batch request JSONL."""
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for item in uploaded:
            payload = {
                "key": item["local_name"],
                "request": {
                    "model": "models/gemini-2.5-flash",
                    "system_instruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"file_data": {"file_uri": item["uri"], "mime_type": item["mime_type"]}},
                            {"text": "OCR this PDF document page and output it as structural Markdown."}
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
        model="models/gemini-2.5-flash",
        src=config_upload.name,
        config=types.CreateBatchJobConfig(display_name=f"{safe_stem}_batch")
    )
    
    shutil.rmtree(tmp_dir, ignore_errors=True)
    print(f"  Batch submitted: {batch.name}")
    return batch.name


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcription-batch-submit.py input.pdf [--work-dir DIR] [--prompt-file PATH] [--metadata]")
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

    prompt_file = None
    if "--prompt-file" in sys.argv:
        idx = sys.argv.index("--prompt-file")
        if idx + 1 < len(sys.argv):
            prompt_file = sys.argv[idx + 1]
    system_prompt = build_transcription_prompt(read_prompt(prompt_file), metadata="--metadata" in sys.argv)

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
    build_jsonl(uploaded, jsonl_path, system_prompt)
    
    # 4. Submit batch
    print(f"\nSubmitting batch job...")
    job_name = submit_batch(jsonl_path, client, stem)
    
    # 5. Save job name
    with open(batch_file, "w") as f:
        f.write(job_name)
    
    print(f"\nDone! Batch job: {job_name}")
    print(f"Job name saved to: {batch_file}")
    print(f"\nRun 'scripts/gemini-batch-process.py {batch_file}' to check status and download results.")
