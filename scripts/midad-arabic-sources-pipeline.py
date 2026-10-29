#!/usr/bin/env python3
"""
Midad Arabic Sources pipeline orchestrator.

Driven by the Midad Arabic Sources Obsidian plugin (and usable from the shell). Every
line written to stdout is a JSON object so the plugin can show live progress:

    {"event":"log","message":"..."}
    {"event":"step","name":"submit","status":"start"|"done"|"error","detail":"..."}
    {"event":"result","result":{...}}
    {"event":"error","message":"..."}

Subcommands:
    list-pdfs <note.md>
    list-transcriptions <note.md>
    list-archive
    default-prompts
    migrate-archive
    transcribe --citekey CK [--pdf PATH ...] [--volume N] [--pages N] [--prompt-file PATH]
    translate  --citekey CK [--source PATH ...] [--volume N] [--prompt-file PATH]
    reprocess  --zip PATH

PDF resolution order (per the vault's ScholarWeft integration):
  2. Zotero local API (http://127.0.0.1:23119) children of the item
  1. .scholar-weft/zlinks.json "pdfs" cache
  3. ~/Zotero/storage/<ATTACHMENT_KEY>/<filename>
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from importlib.machinery import SourceFileLoader
from pathlib import Path
from urllib.parse import unquote, urlparse

def _find_vault() -> Path:
    """Vault root: the OBSIDIAN_VAULT env var, else the nearest ancestor with Midad state."""
    env = os.environ.get("OBSIDIAN_VAULT")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        if (parent / ".midad-arabic-sources").is_dir():
            return parent
    return here.parent.parent


VAULT = _find_vault()
# The plugin's scripts live together, wherever they are deployed.
SCRIPTS = Path(__file__).resolve().parent
BIB = VAULT / "_2 Bibliographic notes"
TRANSC_DIR = VAULT / os.environ.get("MIDAD_TRANSCRIPTIONS_DIR", "_2 Bibliographic notes/Arabic transcriptions")
TRANS_DIR = VAULT / os.environ.get("MIDAD_TRANSLATIONS_DIR", "_2 Bibliographic notes/Arabic translations")
CACHE = VAULT / ".midad-arabic-sources"
ARCHIVE_DIR = CACHE / "archive"
OLD_ARCHIVE = VAULT / "AI OS/Arabic Transcriptions/Arabic OCR archive"
ZOTERO_PORT = "23119"
ZOTERO_DATA_DIR = Path.home() / "Zotero"

# How often the batch scripts re-check the Gemini job. A status GET is cheap;
# the batch itself has no per-page progress to report.
POLL_SECONDS = 30

WORK_DIR = CACHE / "work"
JOBS_DIR = CACHE / "jobs"

_LOG_PATH = None
_STATE_PATH = None
_PROMPT_PATH = None


def set_log(path):
    global _LOG_PATH
    if path:
        _LOG_PATH = Path(path)
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


def set_state(path):
    global _STATE_PATH
    if path:
        _STATE_PATH = Path(path)
        _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)


def set_prompt(path):
    global _PROMPT_PATH
    if path:
        _PROMPT_PATH = Path(path)


def save_state(**fields):
    """Persist job state so it can be shown/resumed after a plugin reload."""
    if not _STATE_PATH:
        return
    try:
        data = {}
        if _STATE_PATH.exists():
            data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
        data.update(fields)
        data["updated"] = datetime.now().isoformat(timespec="seconds")
        _STATE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass


def _slug(s):
    return re.sub(r'[^\w.-]+', '_', str(s))


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def _cleanup_job_files():
    """Remove this job's log/state/prompt file once it has completed successfully."""
    for p in (_LOG_PATH, _STATE_PATH, _PROMPT_PATH):
        if p:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:
                pass


# ── JSON output ──────────────────────────────────────────────────────────────

def emit(event: str, **kw):
    line = json.dumps({"event": event, **kw}, ensure_ascii=False)
    if _LOG_PATH:
        try:
            with open(_LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass
    try:
        print(line, flush=True)
    except (BrokenPipeError, OSError):
        # The observer (plugin) went away; keep running from the log file.
        pass


def log(message: str):
    emit("log", message=str(message))


def step(name: str, status: str, detail: str = ""):
    emit("step", name=name, status=status, detail=str(detail))


def fail(message: str):
    emit("error", message=str(message))


def load_module(name: str):
    return SourceFileLoader(name, str(SCRIPTS / name)).load_module()


# ── Running the pipeline scripts ─────────────────────────────────────────────

def run_script(name: str, args: list) -> int:
    cmd = [sys.executable, str(SCRIPTS / name)] + [str(a) for a in args]
    log("$ " + name + " " + " ".join(str(a) for a in args))
    env = dict(os.environ, OBSIDIAN_VAULT=str(VAULT), PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, cwd=str(VAULT), env=env)
    if proc.stdout:
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line:
                log(line)
    proc.wait()
    return proc.returncode


# ── PDF resolution ───────────────────────────────────────────────────────────

def parse_note(note_path) -> tuple[str, str | None, list]:
    text = Path(note_path).read_text(encoding="utf-8")
    citekey = Path(note_path).stem.lstrip("@")
    zkey = None
    m = re.search(r'^zotero-key:\s*"?([^"\n]+?)"?\s*$', text, re.M)
    if m:
        zkey = m.group(1).strip()
    attachments = []
    block = re.search(r'^attachments:[ \t]*\n((?:[ \t]+-[ \t]*.+\n?)*)', text, re.M)
    if block:
        for am in re.finditer(r'\[([^\]]+)\]\(zotero://open/(?:library|groups/\d+)/items/([A-Za-z0-9]+)\)', block.group(1)):
            attachments.append({"filename": am.group(1), "key": am.group(2)})
    return citekey, zkey, attachments


def _file_url_to_path(href: str) -> str:
    if href.startswith("file://"):
        return unquote(urlparse(href).path)
    return href


def infer_volume(name: str):
    """Guess a volume number from a filename (e.g. 'roohub-07.pdf' -> 7)."""
    stem = Path(name).stem
    m = re.search(r'(?:vol(?:ume)?|juz|جزء|ج)\s*[._-]?\s*(\d+)', stem, re.I)
    if m:
        return int(m.group(1))
    nums = re.findall(r'\d+', stem)
    return int(nums[-1]) if nums else None


def infer_explicit_volume(name: str):
    """Volume only when the filename says so, for standalone PDFs.

    An arbitrary user-chosen PDF may have a year or an edition number in its
    name; treating the last number as a volume would be wrong.
    """
    stem = Path(name).stem
    m = re.search(r'(?:vol(?:ume)?|juz|جزء|ج)\s*[._-]?\s*(\d+)', stem, re.I)
    return int(m.group(1)) if m else None


def _zotero_item(key: str):
    """One Zotero item (attachment) via the local API; None if Zotero is down."""
    try:
        import requests
        r = requests.get(f"http://127.0.0.1:{ZOTERO_PORT}/api/users/0/items/{key}?format=json", timeout=4)
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, dict) else None
    except Exception:
        pass
    return None


def _zotero_children(item_key: str):
    try:
        import requests
        url = (f"http://127.0.0.1:{ZOTERO_PORT}/api/users/0/items/{item_key}"
               f"/children?format=json&itemType=attachment")
        r = requests.get(url, timeout=4)
        if r.status_code == 200 and isinstance(r.json(), list):
            return r.json()
    except Exception:
        pass
    return None


def _attachment_path(item):
    """Absolute on-disk path for a Zotero attachment item, or None."""
    data = item.get("data", {}) or {}
    key = item.get("key") or data.get("key") or ""
    href = ((item.get("links") or {}).get("enclosure") or {}).get("href")
    if href:
        return _file_url_to_path(href)
    p = str(data.get("path") or "")
    if p.startswith("storage:"):
        return str(ZOTERO_DATA_DIR / "storage" / key / p.split(":", 1)[1])
    if p.startswith("attachments:"):
        rel = p.split(":", 1)[1]
        for base in (ZOTERO_DATA_DIR, ZOTERO_DATA_DIR / "attachments"):
            cand = base / rel
            if cand.exists():
                return str(cand)
        return str(ZOTERO_DATA_DIR / rel)
    if p.startswith("~"):
        return str(Path(p).expanduser())
    if p.startswith("/") or re.match(r'^[A-Za-z]:[\\/]', p):
        return p
    fn = data.get("filename")
    if fn:
        return str(ZOTERO_DATA_DIR / "storage" / key / fn)
    return None


def resolve_pdfs(note_path):
    """Return (citekey, [ {key, filename, path, exists, volume} ]).

    Resolution order: Zotero local API (queried per attachment key, which
    exposes linked-file absolute paths) -> ScholarWeft .scholar-weft/zlinks.json
    -> ~/Zotero/storage/<key>/<filename>."""
    citekey, zkey, attachments = parse_note(note_path)
    found = {}

    # (2) Zotero local API — ask each attachment key directly.
    for a in attachments:
        item = _zotero_item(a["key"])
        if not item:
            continue
        data = item.get("data", {}) or {}
        ct = data.get("contentType")
        if ct and ct != "application/pdf":
            continue
        path = _attachment_path(item)
        if path:
            fn = data.get("filename") or a["filename"]
            found[a["key"]] = {"key": a["key"], "filename": fn, "path": path,
                               "exists": Path(path).exists(), "volume": infer_volume(fn)}

    # The parent's children (covers attachments the note does not list).
    if zkey:
        for c in _zotero_children(zkey) or []:
            data = c.get("data", {}) or {}
            key = c.get("key") or data.get("key") or ""
            if key in found or (data.get("contentType") and data.get("contentType") != "application/pdf"):
                continue
            path = _attachment_path(c)
            if path:
                fn = data.get("filename") or Path(path).name
                found[key or path] = {"key": key, "filename": fn, "path": path,
                                      "exists": Path(path).exists(), "volume": infer_volume(fn)}

    # (1) ScholarWeft zlinks cache
    zlinks = VAULT / ".scholar-weft" / "zlinks.json"
    if zlinks.exists():
        try:
            pdfs = json.loads(zlinks.read_text(encoding="utf-8")).get("pdfs", {}).get(citekey, [])
            for p in pdfs:
                if not any(v["path"] == p for v in found.values()):
                    found["zlinks:" + p] = {"key": "", "filename": Path(p).name, "path": p,
                                            "exists": Path(p).exists(), "volume": infer_volume(p)}
        except Exception:
            pass

    # (3) storage layout from the note's attachment keys
    for a in attachments:
        if a["key"] in found:
            continue
        p = ZOTERO_DATA_DIR / "storage" / a["key"] / a["filename"]
        found.setdefault(a["key"], {"key": a["key"], "filename": a["filename"], "path": str(p),
                                    "exists": p.exists(), "volume": infer_volume(a["filename"])})

    items = list(found.values())
    items.sort(key=lambda v: (not v["exists"], v["filename"].lower()))
    return citekey, items


# ── Vault lookups ────────────────────────────────────────────────────────────

def list_vault_notes(citekey: str):
    out = []
    for folder, typ in ((TRANSC_DIR, "transcription"), (TRANS_DIR, "translation")):
        if not folder.exists():
            continue
        seen = set()
        for pattern in (f"mas-{citekey}* - {typ}*.md", f"@{citekey}* - {typ}*.md"):
            for p in sorted(folder.glob(pattern)):
                if p in seen:
                    continue
                seen.add(p)
                vm = re.search(r'vol\.\s*(\d+)', p.stem)
                out.append({"path": str(p), "name": p.stem, "type": typ,
                            "volume": int(vm.group(1)) if vm else None})
    return out


def list_transcriptions(citekey: str):
    return [n for n in list_vault_notes(citekey) if n["type"] == "transcription"]


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_list_pdfs(args) -> int:
    note = Path(args.note)
    if not note.exists():
        fail(f"Note not found: {note}")
        return 1
    citekey, items = resolve_pdfs(note)
    emit("result", result={"citekey": citekey, "pdfs": items})
    return 0


def cmd_list_transcriptions(args) -> int:
    note = Path(args.note)
    if not note.exists():
        fail(f"Note not found: {note}")
        return 1
    citekey = re.sub(r"^(?:@|mas-)", "", note.stem).split(" - ")[0]
    emit("result", result={"citekey": citekey, "notes": list_vault_notes(citekey)})
    return 0


def cmd_list_archive(args) -> int:
    zips = []
    for d in (ARCHIVE_DIR, OLD_ARCHIVE):
        if d.exists():
            for p in sorted(d.glob("*.zip")):
                zips.append({"path": str(p), "name": p.name})
    emit("result", result={"zips": zips})
    return 0


def cmd_default_prompts(args) -> int:
    """Emit the built-in prompts so the plugin can seed/refresh its prompt JSON."""
    try:
        sys.path.insert(0, str(SCRIPTS))
        from midad_prompts import DEFAULT_TRANSCRIPTION_PROMPT, DEFAULT_TRANSLATION_PROMPT
        emit("result", result={
            "transcription": DEFAULT_TRANSCRIPTION_PROMPT,
            "translation": DEFAULT_TRANSLATION_PROMPT,
        })
        return 0
    except Exception as e:
        fail(f"Could not read the built-in prompts: {e}")
        return 1


def cmd_migrate_archive(args) -> int:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    if OLD_ARCHIVE.exists():
        for p in OLD_ARCHIVE.glob("*.zip"):
            dest = ARCHIVE_DIR / p.name
            if not dest.exists():
                shutil.move(str(p), str(dest))
                moved += 1
    log(f"Migrated {moved} archive(s) to {ARCHIVE_DIR}")
    emit("result", result={"moved": moved})
    return 0


def _strip_yaml(text: str) -> str:
    if text.startswith("---"):
        end = text.find("---", 3)
        if end > 0:
            return text[end + 3:].strip()
    return text


def _archive(batch_txt: Path, citekey: str, doc_type: str, volume):
    args = [str(batch_txt), "--citekey", citekey]
    if volume:
        args += ["--volume", str(volume)]
    return run_script("archive-batch-files.py", args)


def _parse_pdf_arg(value: str):
    """'path' or 'path::volume'."""
    if "::" in value:
        path, vol = value.rsplit("::", 1)
        vol = vol.strip()
        return path, (int(vol) if vol.isdigit() else None)
    return value, None


def _read_note_metadata(processed: Path) -> tuple[str | None, list[str] | None]:
    """Read the title/author sidecar written by transcription-postprocess.py."""
    sidecar = processed.with_suffix(processed.suffix + ".meta.json")
    if not sidecar.exists():
        return None, None
    try:
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception:
        return None, None
    title = meta.get("title") if isinstance(meta.get("title"), str) else None
    author = meta.get("author") if isinstance(meta.get("author"), str) else None
    authors = [a.strip() for a in author.split(";") if a.strip()] if author else None
    return title, authors


def cmd_transcribe(args) -> int:
    citekey = args.citekey
    standalone = bool(getattr(args, "standalone", False))
    model = getattr(args, "model", None) or ""
    specs = [_parse_pdf_arg(v) for v in (args.pdf or [])]

    if not specs:
        if standalone:
            fail("No PDF file supplied for standalone transcription.")
            return 1
        note = BIB / f"@{citekey}.md"
        if not note.exists():
            fail(f"Literature note not found: {note}")
            return 1
        _, items = resolve_pdfs(note)
        specs = [(i["path"], i.get("volume")) for i in items if i["exists"]]
    if not specs:
        fail("No PDF file found for this item.")
        return 1

    mv = load_module("transcription-translation-move-to-vault.py")
    results = []
    for pdf_path, vol in specs:
        pdf = Path(pdf_path)
        volume = vol
        if volume is None:
            if args.volume is not None:
                volume = args.volume
            elif standalone:
                volume = infer_explicit_volume(pdf.name)
            else:
                volume = infer_volume(pdf.name)
        stem = pdf.stem
        # Keep all intermediates inside the plugin cache, not beside the source PDF.
        work = WORK_DIR / f"{_slug(citekey)}-{_slug(stem)}"
        work.mkdir(parents=True, exist_ok=True)
        batch_txt = work / f"{stem}.batch.txt"
        raw = work / f"{stem}-raw.md"
        processed = work / f"{stem}.processed.md"

        save_state(stage="submitting", status="running", doc_type="transcription",
                   pid=os.getpid(), citekey=citekey, pdf=str(pdf), volume=volume,
                   standalone=standalone, model=model,
                   work_dir=str(work), log=str(_LOG_PATH) if _LOG_PATH else "",
                   prompt_file=str(args.prompt_file) if getattr(args, "prompt_file", None) else "")
        step("transcribe", "start", f"{pdf.name}" + (f" (vol. {volume})" if volume else ""))
        submit_args = [str(pdf), "--work-dir", str(work)]
        if getattr(args, "prompt_file", None):
            submit_args += ["--prompt-file", str(args.prompt_file)]
        if standalone:
            submit_args.append("--metadata")
        if model:
            submit_args += ["--model", model]
        if run_script("transcription-batch-submit.py", submit_args):
            save_state(stage="error", status="error")
            step("transcribe", "error", pdf.name); continue

        save_state(stage="submitted", status="running", batch_txt=str(batch_txt))
        run_script("transcription-process-raw.py", [str(batch_txt), "--poll", str(POLL_SECONDS)])
        if not raw.exists():
            step("hallucinations", "start", "re-OCRing flagged pages")
            fix_args = [str(batch_txt), "--fix"]
            if getattr(args, "prompt_file", None):
                fix_args += ["--prompt-file", str(args.prompt_file)]
            if standalone:
                fix_args.append("--metadata")
            if model:
                fix_args += ["--model", model]
            run_script("transcription-process-raw.py", fix_args)

        if not processed.exists() or processed.stat().st_mtime < raw.stat().st_mtime:
            post_args = [str(raw), str(processed)]
            if standalone:
                post_args.append("--metadata")
            run_script("transcription-postprocess.py", post_args)

        save_state(stage="writing", status="running")
        title, authors = _read_note_metadata(processed)
        dest = mv.write_note(_strip_yaml(processed.read_text(encoding="utf-8")), citekey,
                             "transcription", volume=volume, standalone=standalone,
                             title=title, authors=authors)
        _archive(batch_txt, citekey, "transcription", volume)
        # Only the vault note and the txt/json archive survive.
        shutil.rmtree(work, ignore_errors=True)
        save_state(stage="done", status="done", note=str(dest))
        step("transcribe", "done", dest.name)
        results.append(str(dest))

    emit("result", result={"notes": results})
    return 0 if results else 1


def _resume_transcription(st: dict) -> int:
    citekey = st.get("citekey")
    pdf = st.get("pdf")
    volume = st.get("volume")
    standalone = bool(st.get("standalone"))
    model = st.get("model") or ""
    stem = Path(pdf).stem
    work = Path(st.get("work_dir") or Path(pdf).parent)
    batch_txt = work / f"{stem}.batch.txt"
    if not batch_txt.exists():
        return cmd_transcribe(argparse.Namespace(citekey=citekey, pdf=[pdf], volume=volume,
                                                pages=None, standalone=standalone, model=model,
                                                prompt_file=st.get("prompt_file") or None))

    mv = load_module("transcription-translation-move-to-vault.py")
    raw = work / f"{stem}-raw.md"
    processed = work / f"{stem}.processed.md"
    save_state(stage="resuming", status="running")
    run_script("transcription-process-raw.py", [str(batch_txt), "--poll", str(POLL_SECONDS)])
    if not raw.exists():
        fix_args = [str(batch_txt), "--fix"]
        if st.get("prompt_file"):
            fix_args += ["--prompt-file", str(st["prompt_file"])]
        if standalone:
            fix_args.append("--metadata")
        if model:
            fix_args += ["--model", model]
        run_script("transcription-process-raw.py", fix_args)
    if not processed.exists() or processed.stat().st_mtime < raw.stat().st_mtime:
        post_args = [str(raw), str(processed)]
        if standalone:
            post_args.append("--metadata")
        run_script("transcription-postprocess.py", post_args)
    title, authors = _read_note_metadata(processed)
    dest = mv.write_note(_strip_yaml(processed.read_text(encoding="utf-8")), citekey,
                         "transcription", volume=volume, standalone=standalone,
                         title=title, authors=authors)
    _archive(batch_txt, citekey, "transcription", volume)
    shutil.rmtree(work, ignore_errors=True)
    save_state(stage="done", status="done", note=str(dest))
    emit("result", result={"notes": [str(dest)]})
    return 0


def cmd_resume(args) -> int:
    state_path = Path(args.state)
    if not state_path.exists():
        fail(f"State file not found: {state_path}")
        return 1
    st = json.loads(state_path.read_text(encoding="utf-8"))
    set_state(state_path)
    if st.get("log"):
        set_log(st["log"])
    if st.get("prompt_file"):
        set_prompt(st["prompt_file"])
    if st.get("pid") and _pid_alive(st["pid"]):
        fail(f"Job is still running (pid {st['pid']}).")
        return 1
    if st.get("doc_type") == "transcription" and st.get("pdf"):
        step("resume", "start", Path(st["pdf"]).name)
        rc = _resume_transcription(st)
        step("resume", "done" if rc == 0 else "error", Path(st["pdf"]).name)
        return rc
    fail("This job type cannot be resumed automatically.")
    return 1


def cmd_translate(args) -> int:
    citekey = args.citekey
    sources = list(args.source or [])
    if not sources:
        sources = [n["path"] for n in list_transcriptions(citekey)]
    if not sources:
        fail(f"No transcription found for @{citekey}. Transcribe it first.")
        return 1

    mv = load_module("transcription-translation-move-to-vault.py")
    results = []
    for src in sources:
        src = Path(src)
        step("translate", "start", src.name)
        submit_args = [str(src)]
        if getattr(args, "prompt_file", None):
            submit_args += ["--prompt-file", str(args.prompt_file)]
        if getattr(args, "model", None):
            submit_args += ["--model", str(args.model)]
        if run_script("translate-batch-submit.py", submit_args):
            step("translate", "error", src.name); continue
        txt = src.parent / f"{src.stem}.translate.txt"
        run_script("translate-batch-process.py", [str(txt), "--poll", str(POLL_SECONDS)])
        _archive(txt, citekey, "translation", args.volume)
        vm = re.search(r'vol\.\s*(\d+)', src.stem)
        vol = int(vm.group(1)) if vm else None
        dest = mv.dest_path(citekey, "translation", args.volume if args.volume is not None else vol)
        step("translate", "done", dest.name)
        results.append(str(dest))

    emit("result", result={"notes": results})
    return 0 if results else 1


def cmd_reprocess(args) -> int:
    step("reprocess", "start", Path(args.zip).name)
    rc = run_script("reprocess-batch-files.py", [args.zip])
    step("reprocess", "done" if rc == 0 else "error", Path(args.zip).name)
    emit("result", result={"zip": args.zip, "ok": rc == 0})
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(prog="midad-arabic-sources-pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list-pdfs"); p.add_argument("note"); p.set_defaults(func=cmd_list_pdfs)
    p = sub.add_parser("list-transcriptions"); p.add_argument("note"); p.set_defaults(func=cmd_list_transcriptions)
    sub.add_parser("list-archive").set_defaults(func=cmd_list_archive)
    sub.add_parser("default-prompts").set_defaults(func=cmd_default_prompts)
    sub.add_parser("migrate-archive").set_defaults(func=cmd_migrate_archive)

    p = sub.add_parser("transcribe")
    p.add_argument("--citekey", required=True)
    p.add_argument("--pdf", action="append")
    p.add_argument("--volume", type=int)
    p.add_argument("--pages", type=int)
    p.add_argument("--standalone", action="store_true")
    p.add_argument("--model")
    p.add_argument("--prompt-file")
    p.add_argument("--log")
    p.add_argument("--state")
    p.set_defaults(func=cmd_transcribe)

    p = sub.add_parser("translate")
    p.add_argument("--citekey", required=True)
    p.add_argument("--source", action="append")
    p.add_argument("--volume", type=int)
    p.add_argument("--model")
    p.add_argument("--prompt-file")
    p.set_defaults(func=cmd_translate)

    p = sub.add_parser("reprocess"); p.add_argument("--zip", required=True); p.set_defaults(func=cmd_reprocess)

    p = sub.add_parser("resume"); p.add_argument("--state", required=True); p.set_defaults(func=cmd_resume)

    args = parser.parse_args()
    if getattr(args, "log", None):
        set_log(args.log)
    if getattr(args, "state", None):
        set_state(args.state)
    if getattr(args, "prompt_file", None):
        set_prompt(args.prompt_file)
    try:
        rc = args.func(args)
    except KeyboardInterrupt:
        fail("Cancelled.")
        rc = 130
    except Exception as e:
        fail(f"{type(e).__name__}: {e}")
        rc = 1
    if rc == 0 and args.command in ("transcribe", "resume", "translate", "reprocess"):
        _cleanup_job_files()
    return rc


if __name__ == "__main__":
    sys.exit(main())
