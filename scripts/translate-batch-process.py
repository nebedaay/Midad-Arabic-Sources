#!/usr/bin/env python3
"""
Check translation batch status, download results, post-process.

Usage:
  python3 scripts/translate-batch-process.py <batch.txt> [--poll N]
  python3 scripts/translate-batch-process.py <batch.txt> --from-output
        Re-run post-processing on the already-downloaded
        "<stem>.translate-output.jsonl" without touching the API.
  python3 scripts/translate-batch-process.py <batch.txt> --out <path>
        Write the post-processed translation somewhere other than the
        default "<stem>.translation.md".

Post-processing passes (in order):
  1. Qur'an-quote class: move {.quran-quote} inside the italic markers.
  2. Poetry: %% / "* hemistich" lines -> >[!poetry] callout.
  3. Footnotes: normalise callout headers to >[!footnotes]; repair bodies
     that lost their ">" prefix; wrap orphan footnote runs (with guards so
     ordinary numbered body lists are left alone).
  4. Page breaks: ensure "---" immediately precedes every "#### p. N".
  5. Interpolations: [square brackets] -> (parentheses), leaving callout
     markers, wikilinks, images and footnote refs untouched.
  6. Blank lines: one blank line between block elements (vault convention).
"""
import json
import os
import re
import sys
import time
from pathlib import Path
from datetime import datetime
from importlib.machinery import SourceFileLoader

VAULT = Path(os.environ.get("OBSIDIAN_VAULT", os.path.expanduser("~/Documents/Obsidian Vault")))
SCRIPTS = Path(__file__).resolve().parent

API_KEY = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
API_KEY = API_KEY.replace("\u2011", "-")


# --------------------------------------------------------------------------
# Batch helpers
# --------------------------------------------------------------------------

def check_status(job_name: str) -> dict:
    """Check batch job status."""
    import requests
    url = f"https://generativelanguage.googleapis.com/v1beta/{job_name}"
    r = requests.get(url, headers={"x-goog-api-key": API_KEY})
    r.raise_for_status()
    return r.json()


def download_results(job_name: str, jsonl_path: Path) -> bool:
    """Download batch results to JSONL."""
    import requests
    data = check_status(job_name)
    response_file = data.get("metadata", {}).get("output", {}).get("responsesFile", "")
    if not response_file:
        response_file = data.get("response", {}).get("responsesFile", "")
    if not response_file:
        print("  Could not find output file reference")
        return False

    file_id = response_file.replace("files/", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/files/{file_id}:download?alt=media"
    r = requests.get(url, headers={"x-goog-api-key": API_KEY}, allow_redirects=True)
    if r.status_code != 200:
        print(f"  Download failed: {r.status_code}")
        return False
    jsonl_path.write_bytes(r.content)
    return True


def _arabic_ratio(text: str) -> float:
    """Fraction of letters in the text that are Arabic-script."""
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return 0.0
    arabic = sum(1 for ch in letters if '\u0600' <= ch <= '\u06FF')
    return arabic / len(letters)


def _requests_path(jsonl_path: Path):
    name = Path(jsonl_path).name
    if name.endswith(".translate-output.jsonl"):
        return Path(jsonl_path).with_name(name.replace(".translate-output.jsonl", ".translate.jsonl"))
    return None


def _resubmit_untranslated(pages, requests_path: Path, min_ratio: float = 0.5):
    """Re-run batches that came back as the Arabic original rather than English."""
    if not API_KEY or not requests_path.exists():
        return pages
    reqs = {}
    for line in open(requests_path, encoding="utf-8"):
        if line.strip():
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            reqs[d.get("key")] = d.get("request")

    tbs = SourceFileLoader("tbs", str(SCRIPTS / "translate-batch-submit.py")).load_module()
    client = None
    fixed = 0
    out = []
    for key, text in pages:
        if _arabic_ratio(text) < min_ratio or key not in reqs:
            out.append((key, text))
            continue
        request = reqs[key]
        system = (request.get("system_instruction", {}).get("parts", [{}])[0].get("text", "")
                  or tbs.TRANSLATION_PROMPT)
        contents = request.get("contents", [])
        try:
            if client is None:
                import google.genai as genai
                import google.genai.types as types
                client = genai.Client(api_key=API_KEY)
                _types = types
            print(f"  {key}: looks untranslated ({_arabic_ratio(text):.0%} Arabic); resubmitting…", flush=True)
            resp = client.models.generate_content(
                model=tbs.MODEL,
                contents=contents,
                config=_types.GenerateContentConfig(system_instruction=system),
            )
            new_text = getattr(resp, "text", "") or ""
            if new_text and _arabic_ratio(new_text) < min_ratio:
                out.append((key, new_text))
                fixed += 1
                continue
            print(f"    still {_arabic_ratio(new_text):.0%} Arabic; keeping original")
        except Exception as e:
            print(f"    ERROR: {e}")
        out.append((key, text))
    if fixed:
        print(f"  Re-translated {fixed} batch(es)")
    return out


def read_output_jsonl(jsonl_path: Path, fix_untranslated: bool = True) -> str:
    """Concatenate the translated text of every batch in an output JSONL.

    Batches whose result is still mostly Arabic (the model echoed the source)
    are re-submitted once when a matching request file is available."""
    pages = []
    failed = 0
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = data.get("key", "")
            resp = data.get("response", {}) or {}
            if "error" in resp:
                failed += 1
                print(f"  ! {key}: {resp['error'].get('message', 'error')[:120]}")
                continue
            try:
                text = resp["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError, TypeError):
                failed += 1
                continue
            pages.append((key, text))

    pages.sort(key=lambda x: x[0])
    if failed:
        print(f"  {failed} batch(es) with no usable text")
    if fix_untranslated:
        req_path = _requests_path(Path(jsonl_path))
        if req_path and req_path.exists():
            pages = _resubmit_untranslated(pages, req_path)
    return "\n\n".join(text for _, text in pages)


# --------------------------------------------------------------------------
# Post-processing
# --------------------------------------------------------------------------

QURAN_CLASS = "{.quran-quote}"

FN_HEADER = re.compile(r'^>\s*\[!(?:arabic-|english-|translated-)?footnotes?\]\s*$', re.I)
FN_HEADER_INLINE = re.compile(r'>\s*\[!(?:arabic-|english-|translated-)?footnotes?\]', re.I)
FN_LABEL = re.compile(r'^[*_#>\s-]*(?:arabic\s+|english\s+|translated\s+)?footnotes?\s*[*_:.]*\s*$', re.I)
FN_DASH = re.compile(r'^(?:[-*]\s+)?(\d+)\s*[\u2013\u2014]\s+(.*)$')
FN_DOT = re.compile(r'^(\d+)[.)]\s+(.*)$')
FN_BARE = re.compile(r'^(\d+)\s+([A-Z"\'(\u2018\u201c].*)$')
FN_QUOTED = re.compile(r'^>\s*(?:[-*]\s*)?\d+\s*[\u2013\u2014]\s+\S')
PAGE_HEADER = re.compile(r'^#{1,6}\s+p\.\s*\d+\s*$')
BRACKET = re.compile(r'(?<!\[)\[([^\[\]\n]+)\](?!\])')


def normalize_quran_quotes(text: str) -> str:
    """Put the {.quran-quote} class inside the italic markers.

    Gemini emits several shapes:
        *﴿text﴾{.quran-quote}*        (correct)
        *﴿text﴾*{.quran-quote}        (class after the closing *)
        *﴿text﴾{.quran-quote}         (no closing *)
        *﴿text﴾* (2:203){.quran-quote} (class stranded after the reference)
        *﴿text﴾*                      (class missing entirely)
    """
    # 0. Add the class to quotes that lost it: *﴾text﴿* -> *﴾text﴿{.quran-quote}*
    # Applies to either ornate bracket (Gemini sometimes swaps the pair).
    # An ornate immediately followed by '*' whose '*' starts a word is an
    # opening bracket introducing inner italics (e.g. *﴾*word*﴿{...}*), so skip.
    def add_missing_class(m):
        following = m.string[m.end():m.end() + 1]
        if following.isalpha():
            return m.group(0)
        return m.group(1) + QURAN_CLASS + "*"

    text = re.sub(r'([\uFD3E\uFD3F])\*', add_missing_class, text)

    # 0b. Fallback for a quote whose closing ornate is missing/cut: a simple
    #     italic span that opens with an ornate and has no class gets one
    #     before its closing star.  Spans with inner italics are skipped.
    def add_trailing_class(m):
        inner = m.group(1)
        if QURAN_CLASS in inner:
            return m.group(0)
        return f"*{inner}{QURAN_CLASS}*"

    text = re.sub(r'\*([\uFD3E\uFD3F](?!\*)[^*\n]*?)\*', add_trailing_class, text)

    # 1. Class stranded after "*quote* (reference)".
    text = re.sub(
        r'\*([^*\n]+)\*\s*(\([^)\n]*\))\s*' + re.escape(QURAN_CLASS),
        lambda m: f"*{m.group(1).strip()}{QURAN_CLASS}* {m.group(2)}",
        text,
    )
    # 2. Drop a stray star sitting immediately before the class.
    text = text.replace(f"*{QURAN_CLASS}", QURAN_CLASS)
    # 3. Make sure exactly one closing star follows the class.
    text = re.sub(re.escape(QURAN_CLASS) + r'(?!\*)', QURAN_CLASS + '*', text)
    return text


def normalize_poetry(text: str) -> str:
    """Force all poetry into the canonical >[!poetry] callout form:

        >[!poetry]
        >- first hemistich
        >\\t- second hemistich

    Accepts whatever Gemini emits: '* h1%%h2', '* h1 * h2', single
    '* hemistich' lines, or an '>[!arabic-poetry]' / '>[!poetry]' callout with
    '>-' items."""
    # 1. Flatten any poetry callout into simple "* ..." lines.
    pre = []
    in_poetry = False
    for ln in text.split("\n"):
        s = ln.strip()
        if ">[!arabic-poetry]" in s or s == ">[!poetry]":
            in_poetry = True
            continue
        if in_poetry:
            if s == "":
                continue
            if not s.startswith(">"):
                in_poetry = False
                pre.append(ln)
                continue
            inner = re.sub(r'^[-*\s]+', '', s.lstrip(">")).strip().strip("*").strip()
            if inner:
                pre.append("* " + inner)
            continue
        pre.append(ln)
    lines = pre

    def split_hemis(content: str):
        content = content.strip().strip("*").strip()
        if "%%" in content:
            parts = [p.strip() for p in content.split("%%")]
            return parts[0], (parts[1] if len(parts) > 1 else "")
        if " * " in content:
            parts = [p.strip() for p in content.split(" * ")]
            return parts[0], " ".join(parts[1:]).strip()
        return content, None

    out = []
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if s.startswith("* ") and len(s) > 2:
            content = []
            j = i
            while j < n:
                ls = lines[j].strip()
                if ls.startswith("* ") and len(ls) > 2:
                    content.append(ls[2:])
                    j += 1
                elif ls == "":
                    j += 1
                else:
                    break
            if content:
                out.append(">[!poetry]")
                pending = None
                for c in content:
                    h1, h2 = split_hemis(c)
                    if h2 is not None:
                        if pending is not None:
                            out.append(f">- {pending}")
                            pending = None
                        out.append(f">- {h1}")
                        if h2:
                            out.append(f">\t- {h2}")
                    elif pending is None:
                        pending = h1
                    else:
                        out.append(f">- {pending}")
                        out.append(f">\t- {h1}")
                        pending = None
                if pending is not None:
                    out.append(f">- {pending}")
                out.append("")
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _fn_item(line: str):
    """Return (number, body) if the line looks like a footnote definition."""
    s = line.strip()
    m = FN_DASH.match(s)
    if m:
        return m.group(1), m.group(2)
    m = FN_DOT.match(s)
    if m:
        return m.group(1), m.group(2)
    m = FN_BARE.match(s)
    if m:
        return m.group(1), m.group(2)
    return None


def hoist_poetry_footnotes(text: str) -> str:
    """Move footnote definitions Gemini nested at the top of a poetry callout
    into their own >[!footnotes] callout placed just before the poetry."""
    lines = text.split("\n")
    out = []
    i, n = 0, len(lines)
    while i < n:
        s = lines[i].strip()
        if s in (">[!poetry]", ">[!arabic-poetry]"):
            k = i + 1
            while k < n and lines[k].strip() == "":
                k += 1
            fn = []
            while k < n and FN_QUOTED.match(lines[k].strip()):
                body = re.sub(r'^>\s*', '', lines[k].strip())
                body = re.sub(r'^(?:[-*]\s*)', '', body)
                fn.append(body)
                k += 1
            if fn:
                out.append(">[!footnotes]")
                for f in fn:
                    out.append(">- " + f)
                out.append("")
                if not (k < n and lines[k].strip() in (">[!poetry]", ">[!arabic-poetry]")):
                    out.append(">[!poetry]")
                i = k
                continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def normalize_footnotes(text: str) -> str:
    """Normalise footnote callouts and repair lost callout structure."""
    text = hoist_poetry_footnotes(text)
    # Rename every footnote-ish callout header to >[!footnotes].
    text = FN_HEADER_INLINE.sub('>[!footnotes]', text)

    lines = text.split("\n")
    out = []
    i, n = 0, len(lines)

    def prev_nonblank(idx: int) -> str:
        k = idx - 1
        while k >= 0 and lines[k].strip() == "":
            k -= 1
        return lines[k].strip() if k >= 0 else ""

    def is_block_start(s: str) -> bool:
        return s.startswith("#") or s.startswith(">[") or s == "---"

    def is_continuation(raw: str) -> bool:
        return raw[:1] in (" ", "\t")

    def collect_items(start: int):
        """Collect footnote definitions from `start` (unquoted lines).

        Returns (items, next_index).  Indented continuation lines are merged
        into the preceding item so a wrapped footnote stays one entry.
        """
        items = []
        j = start
        while j < n:
            raw = lines[j]
            cs = raw.strip()
            if cs == "" or cs.startswith(">") or is_block_start(cs):
                break
            it = _fn_item(cs)
            if it:
                items.append(re.sub(r'^(?:[-*]\s+)', '', cs))
                j += 1
                continue
            if items and is_continuation(raw):
                items[-1] = items[-1] + " " + cs
                j += 1
                continue
            break
        return items, j

    while i < n:
        s = lines[i].strip()

        # (a) Existing callout: repair any body line that lost its ">".
        if FN_HEADER.match(s):
            out.append(">[!footnotes]")
            i += 1
            while i < n:
                raw = lines[i]
                cs = raw.strip()
                if cs == "" or is_block_start(cs):
                    break
                if cs.startswith(">"):
                    out.append(raw)
                elif _fn_item(cs):
                    out.append(">- " + re.sub(r'^(?:[-*]\s+)', '', cs))
                elif is_continuation(raw) and out and out[-1].startswith(">- "):
                    out[-1] = out[-1] + " " + cs
                else:
                    out.append("> " + cs)
                i += 1
            continue

        # (b) A "Footnotes:" label / heading followed by footnote items.
        if FN_LABEL.match(s) and not PAGE_HEADER.match(s):
            j = i + 1
            while j < n and lines[j].strip() == "":
                j += 1
            if j < n and _fn_item(lines[j]):
                out.append(">[!footnotes]")
                i = j
                continue

        # (c) Orphan run of footnote definitions with no header.
        if _fn_item(s) and not s.startswith(">"):
            items, j = collect_items(i)
            prev = prev_nonblank(i)
            if FN_DASH.match(s):
                convert = True
            elif FN_LABEL.match(prev):
                convert = True
            elif prev.startswith("#") or prev.rstrip("*_ ").endswith(":"):
                convert = False
            else:
                convert = True

            if convert:
                out.append(">[!footnotes]")
                for it in items:
                    out.append(">- " + it)
            else:
                out.extend(lines[i:j])
            i = j
            continue

        out.append(lines[i])
        i += 1

    # Drop any >[!footnotes] header left with no body.
    cleaned = []
    for idx, ln in enumerate(out):
        if ln.strip() == ">[!footnotes]" and (idx + 1 >= len(out) or not out[idx + 1].lstrip().startswith(">")):
            continue
        cleaned.append(ln)
    return "\n".join(cleaned)


def normalize_page_breaks(text: str) -> str:
    """Ensure a '---' separator precedes every '#### p. N' heading."""
    lines = text.split("\n")
    out = []
    for ln in lines:
        if PAGE_HEADER.match(ln.strip()):
            while out and out[-1].strip() == "":
                out.pop()
            if not (out and out[-1].strip() == "---"):
                out.append("")
                out.append("---")
            out.append("")
            out.append(ln)
            continue
        out.append(ln)
    return "\n".join(out)


def normalize_brackets(text: str) -> str:
    """Convert [interpolations] to (parentheses).

    Leaves callout markers ([!poetry]), wikilinks ([[..]]), images,
    markdown links and footnote refs ([^1]) untouched.
    """
    def repl(m):
        inner = m.group(1)
        if inner.startswith("!"):        # callout marker
            return m.group(0)
        if inner.startswith("^"):        # footnote reference
            return m.group(0)
        if m.string[m.end():m.end() + 1] == "(":   # markdown link
            return m.group(0)
        return f"({inner})"

    return BRACKET.sub(repl, text)


def normalize_blank_lines(text: str) -> str:
    """One blank line between block elements (vault convention)."""
    lines = text.split("\n")
    out = []
    for ln in lines:
        s = ln.strip()
        if s == "---":
            if out and out[-1].strip() != "":
                out.append("")
            out.append(ln)
            out.append("")
            continue
        if (re.match(r'^#{1,6} ', s) or s.startswith(">[!")) and out and out[-1].strip() != "":
            out.append("")
        out.append(ln)
    text = "\n".join(out)
    return re.sub(r'\n{3,}', '\n\n', text)


def normalize_ornate_direction(text: str) -> str:
    """Force the English Qur'an-quote brackets: open U+FD3E (﴾), close U+FD3F (﴿).

    Gemini often mirrors the Arabic input's orientation, producing *﴿…﴾* or
    *﴿…﴿*; this normalises the first ornate of each quote to the opening and the
    last to the closing bracket."""
    OPEN, CLOSE = "\uFD3E", "\uFD3F"

    def fix(m):
        inner = m.group(1)
        body = inner[:-len("{.quran-quote}")]
        # Force the leading ornate (if any) to the opening bracket and the
        # trailing ornate (if any) to the closing one. This also handles
        # open-only / close-only page-break spans, which have just one.
        if body and body[0] in (OPEN, CLOSE):
            body = OPEN + body[1:]
        if body and body[-1] in (OPEN, CLOSE):
            body = body[:-1] + CLOSE
        return "*" + body + "{.quran-quote}*"

    return re.sub(r'\*([^*\n]*\{\.quran-quote\})\*', fix, text)


def postprocess_translation(text: str) -> str:
    """Run every post-processing pass on a freshly translated document."""
    before = {
        "quran class outside italics": text.count(f"*{QURAN_CLASS}"),
        "arabic-footnotes headers": len(FN_HEADER_INLINE.findall(text)),
        "page headers missing ---": 0,
        "square-bracket interpolations": len(BRACKET.findall(text)),
    }
    text = normalize_quran_quotes(text)
    text = normalize_ornate_direction(text)
    text = normalize_poetry(text)
    text = normalize_footnotes(text)
    text = normalize_page_breaks(text)
    text = normalize_brackets(text)
    text = normalize_blank_lines(text)
    return text


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def translation_filename(stem: str) -> str:
    """Vault file name for a translation.

    '@citekey - translation.md' for a single-volume work (or the master note),
    '@citekey - translation - vol. N.md' for an individual volume.  'vol.' is
    used rather than 'v.' because Pandoc reads 'v.' as 'verse'.
    """
    m = re.match(r'(@\S+)', stem)
    citekey = m.group(1) if m else stem
    vm = re.search(r'\b(?:vol|v)\.\s*(\d+)\b', stem, re.I)
    if vm:
        return f"{citekey} - translation - vol. {int(vm.group(1))}.md"
    return f"{citekey} - translation.md"


def citekey_and_volume(stem: str):
    """(citekey, volume) from a batch stem such as '@ck - transcription - vol. 2'."""
    m = re.match(r'@?(\S+)', stem)
    citekey = m.group(1) if m else stem
    vm = re.search(r'\b(?:vol|v)\.\s*(\d+)\b', stem, re.I)
    return citekey, (int(vm.group(1)) if vm else None)


def build_translation(stem: str, result: str) -> str:
    yaml = (
        "---\n"
        f"created: {datetime.now().strftime('%Y-%m-%d')}\n"
        "up:\n"
        '  - "[[Translations]]"\n'
        '  - "[[AI gen]]"\n'
        f'title: "Translation of {stem}"\n'
        "---\n\n"
    )
    return yaml + result


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 translate-batch-process.py <batch.txt> [--poll N] [--from-output] [--out PATH]")
        sys.exit(1)

    batch_file = Path(sys.argv[1])
    if not batch_file.exists():
        print(f"ERROR: {batch_file} not found")
        sys.exit(1)

    stem = batch_file.stem.replace(".translate", "")
    parent = batch_file.parent
    jsonl_path = parent / f"{stem}.translate-output.jsonl"

    out_path = None
    if "--out" in sys.argv:
        idx = sys.argv.index("--out")
        if idx + 1 < len(sys.argv):
            out_path = Path(sys.argv[idx + 1])
            if not out_path.is_absolute():
                out_path = parent / out_path

    from_output = "--from-output" in sys.argv

    poll_seconds = None
    if "--poll" in sys.argv:
        idx = sys.argv.index("--poll")
        if idx + 1 < len(sys.argv):
            poll_seconds = int(sys.argv[idx + 1])

    if from_output:
        if not jsonl_path.exists():
            print(f"ERROR: {jsonl_path} not found (nothing to re-process)")
            sys.exit(1)
        print(f"Reading existing output: {jsonl_path.name}")
    else:
        job_name = batch_file.read_text().strip()
        while True:
            status = check_status(job_name)
            state = status.get("metadata", {}).get("state", status.get("state", "UNKNOWN"))
            done = status.get("done", False)

            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] State: {state} | Done: {done}")

            if done and state == "BATCH_STATE_SUCCEEDED":
                stats = status.get("metadata", {}).get("batchStats", {})
                print(f"  Requests: {stats.get('requestCount')}, Succeeded: {stats.get('successfulRequestCount')}")
                print("\nDownloading results...")
                if not download_results(job_name, jsonl_path):
                    return
                break

            if "FAILED" in state:
                print(f"Batch failed: {status}")
                return

            if poll_seconds:
                print(f"  Polling again in {poll_seconds}s...")
                time.sleep(poll_seconds)
            else:
                return

    result = read_output_jsonl(jsonl_path)
    print(f"\nPost-processing {len(result):,} chars...")
    result = postprocess_translation(result)

    if out_path is not None:
        out_path.write_text(build_translation(stem, result), encoding="utf-8")
        print(f"\nSaved: {out_path}")
    else:
        # Write the finished note straight into the vault, with the same YAML
        # and aliases as the move-to-vault step.
        mv = SourceFileLoader("mv", str(SCRIPTS / "transcription-translation-move-to-vault.py")).load_module()
        citekey, volume = citekey_and_volume(stem)
        dest = mv.write_note(result, citekey, "translation", volume=volume)
        print(f"\nSaved: {dest}")


if __name__ == "__main__":
    main()
