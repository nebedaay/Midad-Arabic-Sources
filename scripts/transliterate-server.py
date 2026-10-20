#!/usr/bin/env python3
"""Resident Arabic transliteration service.

Loads the CAMeL engine once and answers HTTP requests, so Obsidian and Zotero
clients do not pay the model load on every call. Reuses the rule-based engine in
``arabic-bw-transliterate.py`` rather than duplicating it.

Endpoints
---------
GET  /health
    -> {"status": "ok", "engines_loaded": ["mle", ...]}

POST /transliterate
    body: {"text": "...", "engine": "bert"|"mle"|"none",
           "sun_letters": false, "keep_case": false, "dotless_ya": "maqsura",
           "name": false}
    -> {"romanized": "...", "unknown": [...]} | {"error": "..."}

POST /romanize
    body: {"text": "...", "provider": "gemini"|"deepseek"|"openai", "translate": false,
           "keep_case": false, "name": false, "model": "<optional override>",
           "base_url": "<openai only, optional>", "api_key": "<optional>"}
    -> {"romanized": "...", "translation": "..."} | {"error": "..."}
    Keys come from the server's environment: GEMINI_API_KEY (or GOOGLE_API_KEY),
    DEEPSEEK_API_KEY, or OPENAI_API_KEY, or from a per-request api_key. "openai"
    is any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, a local server):
    set OPENAI_BASE_URL / OPENAI_MODEL, or pass base_url / model per request. The
    provider SDKs are imported lazily.

GET  /lexicon   -> {"lexicon": {...}}
POST /lexicon   body: {"term": "...", "romanization": "..."} or {"entries": {...}}
                -> {"ok": true, "count": N}
POST /place     body: {"text": "بيروت"} -> {"place": "Beirut"}

Usage
-----
    python3 scripts/transliterate-server.py [--port 8756] [--preload bert]

CAMeL calls are not reentrant, so engine calls serialize behind a lock; this is
fine for single-user use.
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load_engine_module():
    path = os.path.join(_HERE, 'arabic-bw-transliterate.py')
    spec = importlib.util.spec_from_file_location('arabic_bw_transliterate', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bw = _load_engine_module()

_ENGINES = {}                    # engine name -> disambiguator (None for 'none')
_ACTUAL = {}                     # requested engine -> engine actually loaded
_ENGINE_LOCK = threading.Lock()  # guards _ENGINES while loading
_CALL_LOCK = threading.Lock()    # serializes CAMeL calls


def get_engine(name):
    if name not in ('bert', 'mle', 'none'):
        raise ValueError(f'unknown engine: {name}')
    with _ENGINE_LOCK:
        if name not in _ENGINES:
            print(f'Loading {name} engine…', file=sys.stderr)
            if name == 'none':
                _ENGINES[name] = None
                _ACTUAL[name] = 'none'
            else:
                # `bert` may resolve to `mle` if it cannot load; record what was
                # actually loaded so the client can tell the user.
                dis, actual = bw.load_disambiguator_result(name)
                _ENGINES[name] = dis
                _ACTUAL[name] = actual
        return _ENGINES[name]


def request_args(payload):
    return SimpleNamespace(
        engine=payload.get('engine', 'bert'),
        sun_letters=bool(payload.get('sun_letters', False)),
        keep_case=bool(payload.get('keep_case', False)),
        dotless_ya=payload.get('dotless_ya', 'maqsura'),
        name=bool(payload.get('name', False)),
        # `citation` reads each word as a headword: a verb keeps its final
        # inflection, a noun loses its case ending, even when the source is fully
        # vocalised (which would otherwise preserve it).
        citation=bool(payload.get('citation', False)),
        debug=False,
    )


def transliterate_payload(payload):
    text = payload.get('text', '')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('field "text" is required')
    requested = payload.get('engine', 'bert')
    disambiguator = get_engine(requested)
    args = request_args(payload)
    # `standalone` reads the text as a word on its own (a citation form) rather
    # than an excerpt, so its last word is not given the pausal form.
    standalone = bool(payload.get('standalone', False))
    with _CALL_LOCK:
        romanized = bw.transliterate_document(text, disambiguator, args, final_pausal=not standalone)
        terms = sorted(bw._UNKNOWN)
        unknown = [{'term': t, 'guess': bw.transliterate_document(t, disambiguator, args)}
                   for t in terms]
    return {'romanized': romanized, 'unknown': unknown,
            'engine': _ACTUAL.get(requested, requested)}


def lexicon_payload(payload):
    entries = payload.get('entries')
    if entries is None:
        term = payload.get('term')
        romanization = payload.get('romanization')
        if not term or romanization is None:
            raise ValueError('provide {term, romanization} or {entries}')
        entries = {term: romanization}
    for term, romanization in entries.items():
        if not isinstance(term, str) or not isinstance(romanization, str):
            raise ValueError('entries must map strings to strings')
        bw.USER_LEXICON[term] = romanization
    with _CALL_LOCK:
        bw.save_user_lexicon()
    return {'ok': True, 'count': len(bw.USER_LEXICON)}


def place_payload(payload):
    text = payload.get('text', '')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('field "text" is required')
    english = bw.place_name(text)
    if english:
        return {'place': english}
    disambiguator = get_engine(payload.get('engine', 'bert'))
    with _CALL_LOCK:
        return {'place': bw.transliterate_document(text, disambiguator, request_args(payload))}


GEMINI_DEFAULT_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.5-flash-lite')
DEEPSEEK_BASE_URL = os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
DEEPSEEK_DEFAULT_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
# Any OpenAI-compatible endpoint (OpenAI itself, OpenRouter, Groq, a local
# llama.cpp/Ollama/vLLM server, …): base URL and model are configurable.
OPENAI_DEFAULT_BASE_URL = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1')
OPENAI_DEFAULT_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')

ROMANIZE_SYSTEM = (
    "You romanize Arabic into Latin script following Islamic Africa's IAFR "
    "conventions, and optionally translate. Use exactly these mappings:\n"
    "- Consonants: ب b, ت t, ث th, ج j, ح ḥ, خ kh, د d, ذ dh, ر r, ز z, ش sh, "
    "ص ṣ, ض ḍ, ط ṭ, ظ ẓ, ع ʿ, غ gh, ف f, ق q, ك k, ل l, م m, ن n, ه h, و w, ي y, ء ʾ.\n"
    "- NEVER use the scientific letters š, č, ž, ǧ, ḵ, ḏ, ṯ, ḫ, ḡ, ḳ; always write "
    "sh, ch, zh, j, kh, dh, th, kh, gh, q.\n"
    "- Short vowels a i u; long vowels ā ī ū (macrons).\n"
    "- Definite article is al-, hyphenated and invariant before sun letters; elision "
    "wa-l-, bi-l-, fa-l-, lil-.\n"
    "- Tāʾ marbūṭa: -a after a short fatḥa, -h after ā, -t in iḍāfa.\n"
    "- Feminine nisba -iyya; masculine nisba -ī.\n"
    "- Madda: word-initial آ → ā; otherwise ʾā.\n"
    "- Alif maqṣūra ى → ā; a dotless final yāʾ after a kasra is ī.\n"
    "- Tanwīn: -an kept; -un/-in dropped; defective-root indefinite nouns keep -in.\n"
    "- Noun/adjective case endings dropped; verb inflections and pronominal-suffix vowels retained.\n"
    "- Hamza ʾ and ʿayn ʿ; drop only a word-initial hamza (including after a prefix "
    "or the article). Keep internal and final hamza: جاء → jāʾa, عائشة → ʿĀʾisha, "
    "مسؤول → masʾūl, Qurʾān.\n"
    "- ʿAbdallāh compounds as one word; b./bt. for ibn/bint; Allāh/billāh/lillāh.\n"
    "- Non-Arabic consonants: پ p, چ ch, ژ zh, گ g, ڤ/ڥ/ۋ v, ڴ ñ, ڭ/ڱ ng.\n"
    "Examples:\n"
    "  المدرسة الإسلامية → al-madrasa al-islāmiyya\n"
    "  شيوخ → shuyūkh\n"
    "  عبد الرحمن → ʿAbd al-Raḥmān\n"
    "  ذو الفقار → Dhū l-faqār\n"
    "  عشر رضعات معلومات → ʿashr raḍaʿāt maʿlūmāt\n"
    "  ﴿إِنَّ اللَّهَ غَفُورٌ رَحِيمٌ﴾ → ﴾inna Allāh ghafūrun raḥīm﴿\n"
    "For Qur'an passages between ﴿ and ﴾, fully vocalize the transliteration and use "
    "pausal endings at the end of the passage (final short vowels and tanwīn dropped; "
    "-an becomes ā). Ornate parentheses are REVERSED in the romanized output: ﴿ … ﴾ "
    "becomes ﴾ … ﴿ (the glyphs are RTL). Preserve the input's markdown "
    "structure exactly (headings, page separators, callouts, lists, poetry, italics) "
    "and add no commentary. Return strict JSON: {\"romanized\": \"...\"} and, only when "
    "translation is requested, also {\"translation\": \"...\"}."
)

_LLM_CLIENTS = {}
_LLM_LOCK = threading.Lock()


def provider_available(name):
    if name == 'gemini':
        return bool(os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY'))
    if name == 'deepseek':
        return bool(os.environ.get('DEEPSEEK_API_KEY'))
    if name == 'openai':
        return bool(os.environ.get('OPENAI_API_KEY'))
    return False


def gemini_client(api_key=None):
    with _LLM_LOCK:
        key = api_key or os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY')
        if not key:
            raise ValueError('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set for the server process, and no key was supplied')
        cache_key = 'gemini:' + key
        if cache_key not in _LLM_CLIENTS:
            from google import genai
            _LLM_CLIENTS[cache_key] = genai.Client(api_key=key)
        return _LLM_CLIENTS[cache_key]


def deepseek_client(api_key=None):
    with _LLM_LOCK:
        key = api_key or os.environ.get('DEEPSEEK_API_KEY')
        if not key:
            raise ValueError('DEEPSEEK_API_KEY is not set for the server process, and no key was supplied')
        cache_key = 'deepseek:' + key
        if cache_key not in _LLM_CLIENTS:
            from openai import OpenAI
            _LLM_CLIENTS[cache_key] = OpenAI(api_key=key, base_url=DEEPSEEK_BASE_URL)
        return _LLM_CLIENTS[cache_key]


def openai_client(api_key=None, base_url=None):
    """A client for any OpenAI-compatible API (OpenAI, OpenRouter, Groq, local …)."""
    with _LLM_LOCK:
        key = api_key or os.environ.get('OPENAI_API_KEY')
        if not key:
            raise ValueError('OPENAI_API_KEY is not set for the server process, and no key was supplied')
        base = (base_url or OPENAI_DEFAULT_BASE_URL).rstrip('/')
        cache_key = 'openai:' + base + ':' + key
        if cache_key not in _LLM_CLIENTS:
            from openai import OpenAI
            _LLM_CLIENTS[cache_key] = OpenAI(api_key=key, base_url=base)
        return _LLM_CLIENTS[cache_key]


def parse_llm_json(text):
    cleaned = re.sub(r'^```(?:json)?\s*', '', (text or '').strip())
    cleaned = re.sub(r'\s*```$', '', cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        return {'romanized': cleaned}


# Gemini often emits the "scientific" transliteration; convert it to IAFR.
_LLM_LATIN_FIXES = {
    'š': 'sh', 'Š': 'Sh', 'č': 'ch', 'Č': 'Ch', 'ž': 'zh', 'Ž': 'Zh',
    'ǧ': 'j', 'Ǧ': 'J', 'ǰ': 'j',
    'ḵ': 'kh', 'Ḵ': 'Kh', 'ḫ': 'kh', 'Ḫ': 'Kh', 'ẖ': 'kh',
    'ḏ': 'dh', 'Ḏ': 'Dh', 'ṯ': 'th', 'Ṯ': 'Th',
    'ġ': 'gh', 'Ġ': 'Gh', 'ḡ': 'gh', 'Ḡ': 'Gh', 'ḳ': 'q', 'Ḳ': 'Q',
}


def normalize_llm_romanization(text):
    """Convert non-IAFR Latin letters to ours, and drop word-initial hamza."""
    for src, dst in _LLM_LATIN_FIXES.items():
        text = text.replace(src, dst)
    # IAFR drops initial hamza: ʾ at a word start (not after a letter/digit)
    text = re.sub(r'(?<!\w)ʾ', '', text)
    return text


def romanize_payload(payload):
    text = payload.get('text', '')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('field "text" is required')
    provider = payload.get('provider', 'gemini')
    translate = bool(payload.get('translate', False))
    full = bool(payload.get('keep_case', payload.get('full_vocalization', False)))
    name = bool(payload.get('name', False))
    api_key = payload.get('api_key') or None
    instruction = ('Also produce an English translation.' if translate
                   else 'Do not translate.')
    user = (f'Romanize the Arabic. {instruction}\n'
            f'Translation requested: {"yes" if translate else "no"}\n\n'
            f'---BEGIN---\n{text}\n---END---')
    if full:
        user += ('\nKeep full vocalization: retain all case endings and tanwīn, '
                 'except pausal shortening at the end of a passage.')
    if name:
        user += ('\nThis is a personal-name field: capitalize every substantive word, '
                 'keep al- lowercase unless it opens the field, and keep b./bt./wuld lowercase.')

    if provider == 'gemini':
        from google.genai import types
        config = types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=int(payload.get('max_output_tokens', 8192)),
            response_mime_type='application/json',
            system_instruction=ROMANIZE_SYSTEM,
        )
        response = gemini_client(api_key).models.generate_content(
            model=payload.get('model') or GEMINI_DEFAULT_MODEL, contents=user, config=config)
        result = parse_llm_json(response.text)
    elif provider in ('deepseek', 'openai'):
        if provider == 'deepseek':
            client = deepseek_client(api_key)
            model = payload.get('model') or DEEPSEEK_DEFAULT_MODEL
        else:
            client = openai_client(api_key, payload.get('base_url'))
            model = payload.get('model') or OPENAI_DEFAULT_MODEL
        response = client.chat.completions.create(
            model=model,
            temperature=0,
            response_format={'type': 'json_object'},
            messages=[
                {'role': 'system', 'content': ROMANIZE_SYSTEM},
                {'role': 'user', 'content': user},
            ],
        )
        result = parse_llm_json(response.choices[0].message.content)
    else:
        raise ValueError(f'unknown provider: {provider}')

    if isinstance(result.get('romanized'), str):
        result['romanized'] = normalize_llm_romanization(result['romanized'])
    return result


PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arabic Transliteration</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, system-ui, sans-serif; }
  #app { display: flex; gap: 12px; height: 100vh; padding: 12px; }
  #left, #right { flex: 1 1 50%; display: flex; flex-direction: column; min-width: 0; }
  h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; }
  textarea, #output { flex: 1 1 auto; width: 100%; margin: 0; padding: 10px; border: 1px solid #8884; border-radius: 8px; font: inherit; overflow: auto; }
  #input { direction: rtl; text-align: right; font-size: 18px; resize: none; }
  #output { white-space: pre-wrap; word-wrap: break-word; font-size: 16px; }
  fieldset { border: 1px solid #8884; border-radius: 8px; margin: 8px 0 0; padding: 8px 10px; }
  legend { padding: 0 4px; font-size: 12px; opacity: .65; }
  label { margin-right: 14px; white-space: nowrap; }
  .row { margin-top: 8px; }
  button { padding: 8px 16px; border-radius: 8px; border: 1px solid #8884; cursor: pointer; font: inherit; }
  #go { font-weight: 600; }
  #status { min-height: 18px; font-size: 12px; opacity: .7; margin-top: 6px; }
  #unknown { margin-top: 6px; }
  #unknown h3 { margin: 0 0 4px; font-size: 12px; color: #c00; }
  .urow { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .urow .uterm { min-width: 5em; color: #c00; }
  .urow input { flex: 1 1 auto; min-width: 0; padding: 3px 6px; border: 1px solid #8884; border-radius: 6px; font: inherit; }
  .urow button { padding: 3px 10px; }
  .llm-only { display: none; }
  body.llm .llm-only { display: block; }
  body.llm .engine-only { display: none; }
  input[type=text], input[type=password], select { padding: 4px 6px; border-radius: 6px; border: 1px solid #8884; font: inherit; }
</style>
</head>
<body>
<div id="app">
  <div id="left">
    <h2>Result</h2>
    <div id="output"></div>
    <div id="unknown"></div>
    <div class="row"><button id="copy">Copy</button></div>
    <div id="status"></div>
  </div>
  <div id="right">
    <h2>Arabic input</h2>
    <textarea id="input" dir="rtl" placeholder="Paste or type Arabic here…"></textarea>
    <fieldset>
      <legend>Route</legend>
      <label><input type="radio" name="route" value="engine" checked> Rule engine</label>
      <label><input type="radio" name="route" value="llm"> LLM</label>
    </fieldset>
    <fieldset class="engine-only">
      <legend>Engine</legend>
      <label><input type="radio" name="engine" value="bert" checked> bert</label>
      <label><input type="radio" name="engine" value="mle"> mle</label>
      <label><input type="radio" name="engine" value="none"> none</label>
    </fieldset>
    <fieldset>
      <legend>Options</legend>
      <label><input type="checkbox" id="full"> Full vocalization</label>
      <label><input type="checkbox" id="name"> Name mode</label>
      <span class="engine-only">
        <label><input type="checkbox" id="sun"> Sun-letter assimilation</label>
        <span>final dotless yāʾ:
          <label><input type="radio" name="ya" value="maqsura" checked> alif maqṣūra (ā)</label>
          <label><input type="radio" name="ya" value="ya"> let analysis choose</label>
        </span>
      </span>
    </fieldset>
    <fieldset class="llm-only">
      <legend>LLM</legend>
      <div class="row">
        <label>Provider
          <select id="provider">
            <option value="gemini">Gemini</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <label>Model <input type="text" id="model" value="gemini-3.5-flash-lite" size="22"></label>
      </div>
      <div class="row"><label>Base URL <input type="text" id="baseurl" size="30" placeholder="OpenAI-compatible only; else OPENAI_BASE_URL"></label></div>
      <div class="row"><label><input type="checkbox" id="translate"> Also translate to English</label></div>
      <div class="row"><label>API key <input type="password" id="apikey" size="30" placeholder="(optional; else server env)"></label></div>
    </fieldset>
    <div class="row"><button id="go">Transliterate</button></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const route = () => document.querySelector('input[name=route]:checked').value;
function sync() { document.body.classList.toggle('llm', route() === 'llm'); }
document.querySelectorAll('input[name=route]').forEach((r) => r.addEventListener('change', sync));
async function run(opts) {
  opts = opts || {};
  const text = $('input').value;
  const useLlm = route() === 'llm';
  const body = { text };
  let path = '/transliterate';
  if (useLlm) {
    path = '/romanize';
    body.provider = $('provider').value;
    body.model = $('model').value;
    body.keep_case = $('full').checked;
    body.name = $('name').checked;
    body.translate = $('translate').checked;
    if ($('baseurl').value) body.base_url = $('baseurl').value;
    if ($('apikey').value) body.api_key = $('apikey').value;
  } else {
    body.engine = document.querySelector('input[name=engine]:checked').value;
    body.sun_letters = $('sun').checked;
    body.keep_case = $('full').checked;
    body.dotless_ya = document.querySelector('input[name=ya]:checked').value;
    body.name = $('name').checked;
  }
  $('status').textContent = 'Working…';
  if (!opts.keepUnknown) $('unknown').textContent = '';
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) { $('status').textContent = 'Error: ' + data.error; return; }
    let out = data.romanized || '';
    if (data.translation) out += '\\n\\n' + data.translation;
    $('output').textContent = out;
    if (!opts.keepUnknown) renderUnknown(data.unknown);
    $('status').textContent = '';
  } catch (e) {
    $('status').textContent = 'Request failed: ' + e;
  }
}
function renderUnknown(list) {
  const box = $('unknown');
  box.textContent = '';
  if (!Array.isArray(list) || !list.length) return;
  const h = document.createElement('h3');
  h.textContent = 'Unknown terms — add to lexicon:';
  box.appendChild(h);
  list.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'urow';
    const term = document.createElement('span');
    term.className = 'uterm';
    term.textContent = u.term;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.dir = 'ltr';
    inp.value = u.guess || '';
    const btn = document.createElement('button');
    btn.textContent = 'Add';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await fetch('/lexicon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term: u.term, romanization: inp.value }) });
        const d = await r.json();
        if (d.error) { $('status').textContent = 'Error: ' + d.error; btn.disabled = false; return; }
        btn.textContent = '✓ added';
        inp.disabled = true;
        run({ keepUnknown: true });
      } catch (e) {
        $('status').textContent = 'Request failed: ' + e;
        btn.disabled = false;
      }
    });
    row.appendChild(term);
    row.appendChild(inp);
    row.appendChild(btn);
    box.appendChild(row);
  });
}
$('go').addEventListener('click', run);
$('copy').addEventListener('click', () => navigator.clipboard.writeText($('output').textContent));
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });
sync();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = 'ArabicTranslitServer/0.1'

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path in ('/', '/ui'):
            body = PAGE_HTML.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == '/health':
            with _ENGINE_LOCK:
                loaded = sorted(_ENGINES)
                actual = dict(_ACTUAL)
            self._send(200, {
                'status': 'ok',
                'pid': os.getpid(),
                'engines_loaded': loaded,
                # What each requested engine actually resolved to (bert → mle on
                # a machine without transformers/model data).
                'engines_actual': actual,
                'providers': {
                    'gemini': provider_available('gemini'),
                    'deepseek': provider_available('deepseek'),
                    'openai': provider_available('openai'),
                },
            })
        elif self.path == '/lexicon':
            self._send(200, {'lexicon': bw.USER_LEXICON})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'{}'
            payload = json.loads(raw.decode('utf-8'))
            if self.path == '/transliterate':
                self._send(200, transliterate_payload(payload))
            elif self.path == '/romanize':
                self._send(200, romanize_payload(payload))
            elif self.path == '/lexicon':
                self._send(200, lexicon_payload(payload))
            elif self.path == '/place':
                self._send(200, place_payload(payload))
            else:
                self._send(404, {'error': 'not found'})
        except Exception as exc:                       # noqa: BLE001 - report to client
            self._send(400, {'error': str(exc)})

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description='Resident Arabic transliteration service')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8756)
    parser.add_argument('--preload', action='append', default=None, choices=('bert', 'mle', 'none'),
                        help='engine to load at startup (repeatable; defaults to bert). '
                             'Preload mle only if you have chosen it: it is opt-in, '
                             'not the default.')
    args = parser.parse_args()

    for engine in (args.preload if args.preload is not None else ['bert']):
        get_engine(engine)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Transliteration server on http://{args.host}:{args.port}', file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
