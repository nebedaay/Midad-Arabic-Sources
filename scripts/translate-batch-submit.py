#!/usr/bin/env python3
"""
Submit a translation batch job to Gemini.
Splits a markdown transcription into 2-page chunks and sends them
with the translation prompt via Gemini Batch API.

Usage: python3 scripts/translate-batch-submit.py <transcription.md>
"""
import json
import os
import re
import sys
from pathlib import Path

# The built-in prompt lives in midad_prompts.py so the plugin can seed and refresh
# its "Default prompt" from the same text, and the general rules stay hardcoded.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from midad_prompts import build_translation_prompt  # noqa: E402

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))

API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
API_KEY = API_KEY.replace("\u2011", "-")

PAGES_PER_BATCH = 2

# Single source of truth for the model. The Gemini Batch API runs the model
# given to batches.create(); the per-request "model" field is ignored, so both
# are set from here.
MODEL = "models/gemini-3.5-flash-lite"

# ornate brackets used for Qur'an quotes: U+FD3E open, U+FD3F close
_QO = "\uFD3E"
_QC = "\uFD3F"

TRANSLATION_PROMPT = build_translation_prompt()


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

def split_pages(content: str) -> list[str]:
    """Split markdown into page chunks at #### headers, preserving order."""
    # Find all #### headers
    pattern = re.compile(r'^(#{2,4}\s+.+)$', re.MULTILINE)
    splits = list(pattern.finditer(content))
    
    if not splits:
        return [content]
    
    pages = []
    for i, m in enumerate(splits):
        start = m.start()
        end = splits[i + 1].start() if i + 1 < len(splits) else len(content)
        pages.append(content[start:end].strip())
    
    return pages

def main():
    argv = list(sys.argv[1:])
    prompt_file = None
    if "--prompt-file" in argv:
        idx = argv.index("--prompt-file")
        if idx + 1 < len(argv):
            prompt_file = argv[idx + 1]
        del argv[idx:idx + 2]

    if not argv:
        print("Usage: python3 translate-batch-submit.py <transcription.md> [--prompt-file PATH]")
        sys.exit(1)
    
    filepath = Path(argv[0]).resolve()
    if not filepath.exists():
        print(f"ERROR: {filepath} not found"); sys.exit(1)

    system_prompt = build_translation_prompt(read_prompt(prompt_file))
    
    content = filepath.read_text(encoding="utf-8")
    
    # Strip YAML frontmatter
    if content.startswith("---"):
        end = content.find("---", 3)
        content = content[end + 3:].strip() if end > 0 else content
    
    pages = split_pages(content)
    print(f"Pages: {len(pages)}")

    # split_pages cuts at the heading, which leaves a page's preceding '---'
    # at the end of the previous chunk. Move it onto the following page so
    # every chunk (and therefore every batch) opens with its own separator,
    # matching the prompt and reducing dropped separators from the model.
    for k in range(len(pages) - 1):
        lines = pages[k].rstrip().split("\n")
        if lines and lines[-1].strip() == "---":
            pages[k] = "\n".join(lines[:-1]).rstrip()
            pages[k + 1] = "---\n\n" + pages[k + 1]

    # Group into batches
    batches = []
    for i in range(0, len(pages), PAGES_PER_BATCH):
        batch_text = "\n\n".join(pages[i:i + PAGES_PER_BATCH])
        batches.append(batch_text)
    
    print(f"Batches: {len(batches)} (max {PAGES_PER_BATCH} pages each)")
    
    # Build JSONL — each line is one batch request
    stem = filepath.stem
    jsonl_path = filepath.parent / f"{stem}.translate.jsonl"
    
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for bi, batch_text in enumerate(batches):
            key = f"batch_{bi + 1:04d}"
            payload = {
                "key": key,
                "request": {
                    "model": MODEL,
                    "system_instruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{
                        "role": "user",
                        "parts": [{"text": batch_text}]
                    }]
                }
            }
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    
    print(f"JSONL: {jsonl_path}")
    
    # Upload JSONL and submit batch
    import google.genai as genai
    import google.genai.types as types
    
    client = genai.Client(api_key=API_KEY)
    
    # ASCII-safe stem for display names
    safe_stem = stem.encode("ascii", errors="ignore").decode("ascii") or "translate"
    
    # Copy JSONL to temp ASCII path for upload
    import tempfile, shutil
    tmp_dir = Path(tempfile.mkdtemp(prefix="gemini_trans_"))
    tmp_jsonl = tmp_dir / f"{safe_stem}.jsonl"
    shutil.copy2(jsonl_path, tmp_jsonl)
    
    config_upload = client.files.upload(
        file=str(tmp_jsonl),
        config=types.UploadFileConfig(display_name=f"{safe_stem}_trans_config", mime_type="text/plain")
    )
    
    batch = client.batches.create(
        model=MODEL,
        src=config_upload.name,
        config=types.CreateBatchJobConfig(display_name=f"{safe_stem}_trans_batch")
    )
    
    shutil.rmtree(tmp_dir, ignore_errors=True)
    
    print(f"Batch submitted: {batch.name}")
    
    # Save batch name
    batch_file = filepath.parent / f"{stem}.translate.txt"
    batch_file.write_text(batch.name)
    print(f"Job name saved to: {batch_file.name}")
    print(f"\nRun 'translate-batch-process.py {batch_file}' when ready.")

if __name__ == "__main__":
    main()
