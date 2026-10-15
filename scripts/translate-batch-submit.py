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

TRANSLATION_PROMPT = (
    "Translate the Arabic text below into scholarly, nuanced, and complete English, "
    "making the output markdown as complete and as close as possible to the original in "
    "format, structure, and meaning. Output only the English translation, not the Arabic. "
    "If the text contains quotes from other languages such as Persian, translate those as well. \n\n"
    "STRUCTURE (critical):\n"
    "- Keep every heading (#, ##, ###, ####) exactly where it is in the input.\n"
    "- The input uses '---' on its own line as a page separator, always immediately "
    "before a '#### p. N' heading. Keep every '---' exactly; never drop, move, merge, "
    "or invent one.\n"
    "- Put exactly one blank line between every block element (headings, paragraphs, "
    "callouts, and '---' separators).\n\n"
    "POETRY: in the input document, poetry is in '>[!arabic-poetry]' callouts, with two hemistiches "
    "per stanza. Do not reproduce the callout. Output each couplet on one line as "
    "'* hemistich1%%hemistich2', and a single hemistich as '* hemistich'. The leading "
    "'*' must be followed by a space, and '%%' separates the two hemistiches. Never use "
    "these detached markers for ordinary italics or any other purpose.\n\n"
    "FOOTNOTES: preserve footnote callouts exactly as they appear in the input, including "
    "the label '>[!arabic-footnotes]' and the '>-' list structure. Do not rename them.\n\n"
    f"QUR'AN QUOTES: wrap each quote as *{_QO}translated text{_QC}{{.quran-quote}}* (sura:verse), "
    f"adding '(sura:verse)' only if known. Use exactly these brackets: open with {_QO} and close "
    f"with {_QC} — do not copy or mirror the bracket orientation from the Arabic input. The ornate "
    "brackets and the {.quran-quote} class must both be inside the italic asterisks, and the class "
    "must never be placed after the closing '*'.\n\n"
    "INTERPOLATIONS: use (parentheses), never [square brackets].\n\n"
    "ITALICS: use *asterisks*, never underscores. QUOTES: use curly single and double "
    "quotes/apostrophes, never straight quotes.\n\n"
    "TRANSLITERATION (IJMES): macrons for long vowels (ā, ū, ī); dots under emphatics "
    "(ḥ, ṣ, ḍ, ṭ, ẓ); ʿ for ʿayn; ʾ for hamza; no initial hamza (al-Islām); no final 'h' "
    "for tāʾ marbūṭa; ẓ = ظ, ṣ = ص, ḍ = ض, ḥ = ح, ṭ = ط, th = ث, j = ج, sh = ش, kh = خ.\n\n"
    "Do not hard-wrap lines: every paragraph and every footnote is a single line."
)

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
    if len(sys.argv) < 2:
        print("Usage: python3 translate-batch-submit.py <transcription.md>")
        sys.exit(1)
    
    filepath = Path(sys.argv[1]).resolve()
    if not filepath.exists():
        print(f"ERROR: {filepath} not found"); sys.exit(1)
    
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
                    "system_instruction": {"parts": [{"text": TRANSLATION_PROMPT}]},
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
