#!/usr/bin/env python3
"""
Script 2: Check Gemini batch status, download results, and post-process.

Usage: python3 scripts/postprocess-gemini-batch-process.py <batch.txt>

Reads the batch job name from a .batch.txt file, checks its status,
downloads results when complete, and runs post-processing.

If a timer frequency is given, polls every N seconds until complete:
  python3 scripts/gemini-batch-process.py <batch.txt> --poll 600
"""
import json
import os
import re
import sys
import time
from pathlib import Path
from datetime import datetime
from importlib.machinery import SourceFileLoader

import requests

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
SCRIPTS = Path(__file__).resolve().parent
BIB_DIR = VAULT / "_2 Bibliographic notes"

def _build_yaml(stem: str) -> str:
    """Build YAML frontmatter for a transcription file.
    
    If a matching Zotero reference exists (by stem keyword match), 
    derives metadata from it. Otherwise falls back to a minimal template.
    """
    import re as _re
    
    # Try to find a Zotero reference matching the stem keywords
    keywords = _re.sub(r'[-_]', ' ', stem).lower().split()
    keywords = [k for k in keywords if len(k) > 3]  # skip short words
    
    ref_file = None
    for f in BIB_DIR.glob("*.md"):
        if f.name.startswith("@"):
            f_text = f.read_text(encoding="utf-8")
            f_lower = f_text.lower()
            # Check if this reference is for the same work
            matches = sum(1 for k in keywords if k in f_lower)
            if matches >= 2:
                ref_file = f
                break
    
    if ref_file:
        return _yaml_from_zotero(ref_file)
    
    # Fallback: minimal template
    return f"""---
created: {datetime.now().strftime('%Y-%m-%d')}
up:
  - "[[Arabic transcriptions]]"
  - "[[AI gen]]"
---

"""

def _yaml_from_zotero(ref_file: Path) -> str:
    """Build YAML frontmatter from a Zotero reference file."""
    import re as _re
    text = ref_file.read_text(encoding="utf-8")
    
    # Parse existing YAML from the reference file (between --- markers)
    yaml_match = _re.search(r'^---\s*$(.+?)^---\s*$', text, _re.MULTILINE | _re.DOTALL)
    if not yaml_match:
        return _build_yaml("")  # fallback
    
    raw_yaml = yaml_match.group(1)
    
    # Extract fields
    def get_field(key):
        m = _re.search(rf'^{key}:\s*(.+)', raw_yaml, _re.MULTILINE)
        return m.group(1).strip().strip('"') if m else None
    
    title = get_field('title') or "Untitled"
    shorttitle = get_field('shorttitle') or title
    citekey = ref_file.stem.lstrip('@')
    authors = get_field('authors')
    year = get_field('year')
    
    # Build up list from the reference
    up_lines = [
        '  - "[[Arabic transcriptions]]"',
        '  - "[[AI gen]]"',
        f'  - "[[@{citekey}]]"',
    ]
    
    yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d')}
up:
{chr(10).join(up_lines)}
title: "{title}"
shorttitle: "{shorttitle}"
"""
    if authors:
        yaml += f"authors:\n{authors}\"\n"
    if year:
        yaml += f"year: \"{year}\"\n"
    
    yaml += "---\n"
    return yaml
API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
API_KEY = API_KEY.replace("\u2011", "-").encode("ascii", errors="replace").decode("ascii")


def _model_name(value: str | None) -> str:
    value = (value or "").strip()
    if not value:
        value = "gemini-3.5-flash-lite"
    return value if value.startswith("models/") else f"models/{value}"
NBSP = '\u202f'
LQ = '\uFD3F'


def check_status(job_name: str) -> dict:
    """Check batch job status via Gemini API."""
    url = f"https://generativelanguage.googleapis.com/v1beta/{job_name}"
    resp = requests.get(url, headers={"x-goog-api-key": API_KEY})
    return resp.json()


def download_results(job_name: str, output_path: Path):
    """Download batch results JSONL."""
    data = check_status(job_name)
    if not data.get("done"):
        return None
    
    response_file = data.get("metadata", {}).get("output", {}).get("responsesFile", "")
    if not response_file:
        response_file = data.get("response", {}).get("responsesFile", "")
    
    if not response_file:
        print("Could not find output file reference.")
        return None
    
    file_id = response_file.replace("files/", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}:download?alt=media"
    
    resp = requests.get(url, headers={"x-goog-api-key": API_KEY}, allow_redirects=True)
    
    if resp.status_code == 200:
        with open(output_path, 'wb') as f:
            f.write(resp.content)
        return str(output_path)
    
    print(f"Download failed: {resp.status_code}")
    return None


def concatenate(jsonl_path: Path, output_path: Path):
    """Concatenate JSONL batch results into raw markdown."""
    pages = []
    with open(jsonl_path, encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            data = json.loads(line)
            key = data.get("key", "")
            text = data.get("response", {}).get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            pages.append((key, text))
    
    pages.sort(key=lambda x: x[0])
    
    parts = []
    for i, (key, text) in enumerate(pages):
        hdr = f"#### p.{NBSP}{key.split('_')[1]}"
        parts.append(f"{hdr}\n\n{text}")
    
    output = '\n\n---\n\n'.join(parts)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(output)
    
    return len(pages)


def _page_is_blank(path: Path, dpi: int = 50, ink_threshold: float = 0.002) -> bool:
    """True when a page image is essentially blank (little ink, little variation)."""
    try:
        import fitz
        doc = fitz.open(str(path))
        pix = doc[0].get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        samples = pix.samples
        doc.close()
        n = len(samples)
        if n == 0:
            return False
        dark = sum(1 for b in samples if b < 200)
        return (dark / n) < ink_threshold
    except Exception:
        return False


def find_problems(jsonl_path: Path, parent: Path, stem: str) -> dict:
    """Map page key -> reason for every page missing, empty, overlong, or blank.

    Compared against the *input* batch JSONL, so pages Gemini never returned
    are caught as well as pages it returned empty. A page whose image is blank
    is reported as 'blank' (not a problem to fix)."""
    texts = {}
    for line in open(jsonl_path, encoding='utf-8'):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            text = data['response']['candidates'][0]['content']['parts'][0]['text']
        except (KeyError, IndexError, TypeError):
            text = ''
        texts[data.get('key')] = text

    in_path = parent / f"{stem}.batch.jsonl"
    keys = []
    if in_path.exists():
        for line in open(in_path, encoding='utf-8'):
            if line.strip():
                try:
                    keys.append(json.loads(line).get('key'))
                except json.JSONDecodeError:
                    pass
    if not keys:
        keys = list(texts.keys())

    pages_dir = parent / f"{stem}-pages"
    problems = {}
    for k in keys:
        if k not in texts or not texts[k].strip():
            pdf = pages_dir / f"{k}.pdf"
            if pdf.exists() and _page_is_blank(pdf):
                problems[k] = 'blank'
            elif k not in texts:
                problems[k] = 'missing'
            else:
                problems[k] = 'empty'
        elif len(texts[k]) > 10000:
            problems[k] = 'overlong'
    return problems


def postprocess(input_path: Path) -> str:
    """Apply all post-processing fixes. Returns processed text."""
    # Try to import from the unified script
    pp_path = SCRIPTS / "transcription-format.py"
    if pp_path.exists():
        loader = SourceFileLoader("postprocess", str(pp_path))
        pp = loader.load_module()
        return pp.process(str(input_path))
    
    # Fallback: inline processing
    c = open(input_path, encoding='utf-8').read()
    
    # Basic Quran formatting
    c = re.sub(r'(\*' + LQ + r'[^' + LQE + r']+' + LQE + r')\*\{\.quran-quote\}',
               r'\1{.quran-quote}*', c)
    c = re.sub(r'(?<!\*)' + LQ + r'([^' + LQE + r']+)' + LQE + r'(?!\{\.quran-quote\})',
               r'*' + LQ + r'\1' + LQE + r'{.quran-quote}*', c)
    c = re.sub(r'\*\*' + LQ, r'*' + LQ, c)
    
    # Sura names
    for old, new in SURA_FIX.items():
        c = c.replace(f'[[{old}#', f'[[{new}#')
        c = c.replace(f'|{old} :', f'|{new} :')
    
    # Final cleanup
    c = re.sub(r'---\n\n---', '---', c)
    c = re.sub(r'\n{3,}', '\n\n', c)
    
    return c


def process_batch(batch_file: Path, poll: bool = False, interval: int = 600):
    """Main processing loop."""
    # Read job name
    with open(batch_file) as f:
        job_name = f.read().strip()
    
    stem = batch_file.stem.replace(".batch", "")
    parent = batch_file.parent
    
    jsonl_path = parent / f"{stem}-output.jsonl"
    raw_path = parent / f"{stem}-raw.md"
    final_path = parent / f"{stem}-transcribed.md"
    
    while True:
        status = check_status(job_name)
        state = status.get("metadata", {}).get("state", status.get("state", "UNKNOWN"))
        done = status.get("done", False)
        
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] State: {state} | Done: {done}")
        
        if done and state == "BATCH_STATE_SUCCEEDED":
            stats = status.get("metadata", {}).get("batchStats", {})
            print(f"  Requests: {stats.get('requestCount')}, Succeeded: {stats.get('successfulRequestCount')}")
            
            print(f"\nDownloading results...")
            if download_results(job_name, jsonl_path):
                print(f"  Downloaded: {jsonl_path.name}")
                
                problems = find_problems(jsonl_path, parent, stem)
                to_fix = {k: v for k, v in problems.items() if v != 'blank'}
                blanks = [k for k, v in problems.items() if v == 'blank']
                if to_fix:
                    by_reason = {}
                    for k, why in to_fix.items():
                        by_reason.setdefault(why, []).append(k)
                    print(f"  Found {len(to_fix)} page(s) needing attention:")
                    for why, keys in by_reason.items():
                        print(f"    {why}: {len(keys)} page(s), e.g. {', '.join(keys[:5])}")
                    print(f"\n  Re-OCR these pages with --fix (auto), or edit the JSONL and --rebuild.")
                else:
                    if blanks:
                        print(f"  {len(blanks)} blank page(s) (no text expected).")
                    print(f"  Clean — producing raw...")
                    n_pages = concatenate(jsonl_path, raw_path)
                    yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d %H:%M')}
up:
  - "[[Arabic transcriptions]]"
  - "[[AI gen]]"
---
"""
                    raw_text = open(raw_path, encoding='utf-8').read()
                    with open(raw_path, 'w', encoding='utf-8') as f:
                        f.write(yaml + "\n" + raw_text)
                    print(f"  {n_pages} pages → {raw_path.name}")
                    print(f"  Ready to postprocess")
                final_path = raw_path
            break
        
        if "FAILED" in state:
            print(f"Batch failed: {status}")
            break
        
        if not poll:
            print("\nBatch not yet complete. Re-run with --poll N to wait.")
            break
        
        print(f"Waiting {interval}s...")
        time.sleep(interval)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcription-gemini-process-raw.py <batch.txt> [--poll N] [--rebuild]")
        print("  --rebuild  Re-concatenate raw.md from JSONL (after manual fixes)")
        sys.exit(1)
    
    batch_file = Path(sys.argv[1])

    if "--model" in sys.argv:
        idx = sys.argv.index("--model")
        if idx + 1 < len(sys.argv):
            os.environ["GEMINI_MODEL"] = sys.argv[idx + 1]

    if "--rebuild" in sys.argv:
        stem = batch_file.stem.replace(".batch", "")
        parent = batch_file.parent
        jsonl_path = parent / f"{stem}-output.jsonl"
        raw_path = parent / f"{stem}-raw.md"
        if not jsonl_path.exists():
            print(f"ERROR: {jsonl_path} not found"); sys.exit(1)
        print(f"Rebuilding {raw_path.name} from {jsonl_path.name}...")
        n = concatenate(jsonl_path, raw_path)
        yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d %H:%M')}
up:
  - "[[Arabic transcriptions]]"
  - "[[AI gen]]"
---
"""
        raw_text = open(raw_path, encoding='utf-8').read()
        with open(raw_path, 'w', encoding='utf-8') as f:
            f.write(yaml + "\n" + raw_text)
        print(f"  {n} pages → {raw_path.name}")
        sys.exit(0)
    
    if "--fix" in sys.argv:
        stem = batch_file.stem.replace(".batch", "")
        parent = batch_file.parent
        jsonl_path = parent / f"{stem}-output.jsonl"
        raw_path = parent / f"{stem}-raw.md"
        pages_dir = parent / f"{stem}-pages"
        if not jsonl_path.exists():
            print(f"ERROR: {jsonl_path} not found"); sys.exit(1)
        
        import json, google.genai as genai, google.genai.types as types
        client = genai.Client(api_key=API_KEY)
        lines = [l for l in open(jsonl_path) if l.strip()]

        # The same selected prompt the batch used, so a re-OCR'd page keeps the
        # custom format instead of falling back to the built-in assumptions.
        # The prompt file holds only the text-specific part; the shared format
        # and OCR rules are composed in midad_prompts.py.
        user_prompt = None
        if "--prompt-file" in sys.argv:
            idx = sys.argv.index("--prompt-file")
            if idx + 1 < len(sys.argv):
                try:
                    user_prompt = Path(sys.argv[idx + 1]).read_text(encoding="utf-8").strip() or None
                except Exception as e:
                    print(f"  WARNING: could not read prompt file: {e}")
        sys.path.insert(0, str(SCRIPTS))
        from midad_prompts import build_transcription_prompt
        system_prompt = build_transcription_prompt(user_prompt, metadata="--metadata" in sys.argv)
        
        # Find previous JSONL (same stem without " - try X" suffix)
        prev_jsonl = None
        base_stem = re.sub(r'\s*-\s*try\s+[A-Za-z]$', '', stem)
        if base_stem != stem:
            prev_path = parent / f"{base_stem}-output.jsonl"
            if prev_path.exists():
                prev_jsonl = prev_path
                print(f"Found previous: {prev_jsonl.name}")
        
        # Collect problem entries (missing from output, empty, or hallucinated)
        # and try to copy each from a previous run.
        input_keys = []
        in_path = parent / f"{stem}.batch.jsonl"
        if in_path.exists():
            for ln in open(in_path, encoding='utf-8'):
                if ln.strip():
                    try:
                        input_keys.append(json.loads(ln).get('key'))
                    except json.JSONDecodeError:
                        pass

        def _text_of(data):
            try:
                return data['response']['candidates'][0]['content']['parts'][0]['text']
            except (KeyError, IndexError, TypeError):
                return ''

        present = {}
        for i, line in enumerate(lines):
            try:
                present[json.loads(line).get('key')] = i
            except json.JSONDecodeError:
                pass
        if not input_keys:
            input_keys = list(present.keys())

        # Add any missing page as a new (empty) entry so it can be re-OCR'd.
        import copy
        template = json.loads(lines[0]) if lines else {}
        for k in input_keys:
            if k not in present:
                d = copy.deepcopy(template)
                d['key'] = k
                try:
                    d['response']['candidates'][0]['content']['parts'][0]['text'] = ''
                except (KeyError, IndexError, TypeError):
                    pass
                lines.append(json.dumps(d, ensure_ascii=False) + '\n')
                present[k] = len(lines) - 1

        problems = find_problems(jsonl_path, parent, stem)
        to_fix = []
        for key in input_keys:
            if problems.get(key) == 'blank':
                continue
            i = present[key]
            data = json.loads(lines[i])
            text = _text_of(data)
            if text.strip() and len(text) <= 10000:
                continue
            copied = False
            if prev_jsonl:
                with open(prev_jsonl) as pf:
                    for pline in pf:
                        if not pline.strip():
                            continue
                        pdata = json.loads(pline)
                        if pdata.get('key') == key:
                            ptext = _text_of(pdata)
                            if ptext.strip() and len(ptext) < 10000:
                                data['response']['candidates'][0]['content']['parts'][0]['text'] = ptext
                                lines[i] = json.dumps(data, ensure_ascii=False) + '\n'
                                copied = True
                                print(f"  {key}: copied from previous ({len(ptext)} chars)")
                            break
            if not copied:
                to_fix.append((i, key, data, lines))
        
        # Re-OCR remaining pages
        if to_fix:
            print(f"\nRe-OCRing {len(to_fix)} pages...")
            for i, key, data, _ in to_fix:
                pdf_path = pages_dir / f"{key}.pdf"
                if not pdf_path.exists():
                    print(f"  {key}: PDF not found, skipping"); continue
                print(f"  {key}...", flush=True)
                try:
                    file = client.files.upload(file=str(pdf_path), config=types.UploadFileConfig(display_name=key, mime_type='application/pdf'))
                    # Sync re-OCR of a single page. Kept deliberately short to
                    # discourage reordering; 2.5 Flash is used because Flash-Lite
                    # is not always available for synchronous calls. The selected
                    # prompt, when one was supplied, is used as the system
                    # instruction so a custom format survives the retry.
                    sync_prompt = (
                        "OCR this page and output clean markdown. Transcribe every word in "
                        "EXACT order, left to right, top to bottom. DO NOT reorder, add, omit, or "
                        "guess at text. Keep each paragraph on one line."
                    )
                    kwargs = {
                        "model": _model_name(os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")),
                        "contents": [sync_prompt, types.Part.from_uri(file_uri=file.uri, mime_type="application/pdf")],
                    }
                    if system_prompt:
                        kwargs["config"] = types.GenerateContentConfig(system_instruction=system_prompt)
                    response = client.models.generate_content(**kwargs)
                    new_text = getattr(response, 'text', '') or ''
                    data.setdefault('response', {})
                    data['response']['candidates'] = [{'content': {'parts': [{'text': new_text}]}}]
                    lines[i] = json.dumps(data, ensure_ascii=False) + '\n'
                    print(f"    → {len(new_text)} chars", flush=True)
                except Exception as e:
                    print(f"    ERROR: {e}")
        
        # Save fixed JSONL and rebuild raw
        open(jsonl_path, 'w').writelines([l for l in lines if l])
        print(f"\nRebuilding raw...")
        n = concatenate(jsonl_path, raw_path)
        yaml = f"""---
created: {datetime.now().strftime('%Y-%m-%d %H:%M')}
up:
  - "[[Arabic transcriptions]]"
  - "[[AI gen]]"
---
"""
        raw_text = open(raw_path, encoding='utf-8').read()
        with open(raw_path, 'w', encoding='utf-8') as f:
            f.write(yaml + "\n" + raw_text)
        print(f"  {n} pages → {raw_path.name}")
        sys.exit(0)
    
    if not batch_file.exists():
        print(f"ERROR: {batch_file} not found")
        sys.exit(1)
    
    poll = "--poll" in sys.argv
    interval = 600
    if poll:
        try:
            idx = sys.argv.index("--poll")
            interval = int(sys.argv[idx + 1])
        except:
            pass
    
    process_batch(batch_file, poll=poll, interval=interval)
