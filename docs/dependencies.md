# Dependencies

Midad Arabic Sources runs external Python for three of its four functions. Nothing has to be installed for the importer alone — it uses only Python’s standard library — but the transliteration service, transcription, and translation each need packages.

The plugin finds a usable Python on its own (it probes common paths and virtual-environments), and you can pin one under **Transcription and translation → Python executable**.

## Python 3

Any reasonably recent Python 3 works. The plugin probes, in order: your configured interpreter, `python3`/`python`, a ScholarWeft virtualenv if present, the versioned `python3.13`/`3.12`/`3.11` names, Homebrew and system paths (`/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/usr/bin/python3`), conda, and pyenv.

If auto-detection picks the wrong one, set the full path in **Python executable**.

## Translations and transcription: Gemini

Scanned-PDF transcription and all translation call the **Gemini API**. You need an API key, from [Google AI Studio](https://aistudio.google.com/apikey), stored in an LLM configuration under **LLM → Configurations** and assigned to transcription and translation there. It is passed to the pipeline as `GEMINI_API_KEY`; if you would rather not store it in the vault, launch Obsidian from a shell that already exports `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) instead.

Packages:

```shell
pip install google-genai pymupdf requests
```

- `google-genai` — the Gemini client used for OCR and translation.
- `pymupdf` (imported as `fitz`) — bursts a scanned PDF into page PDFs and reads page counts.
- `requests` — used by the pipeline’s helper scripts.

## Transliteration: CAMeL Tools

The rule-based romanizer uses **CAMeL Tools**. The heavy model loads once into the resident server, so Obsidian does not pay for it on every call.

Install the recommended engine, **BERT**:

```shell
pip install camel-tools transformers
camel_data -i disambig-bert-unfactored-msa
camel_data -i morphology-db-msa-r13
```

MLE is an optional, lighter alternative — install it **instead of** the bert package if you want it:

```shell
pip install camel-tools
camel_data -i disambig-mle-calima-msa-r13
camel_data -i morphology-db-msa-r13
```

- `camel-tools` — the disambiguators and the morphological analyzer.
- `transformers` — needed by the BERT engine to load its model. The model weights ship **inside** the `disambig-bert-unfactored-msa` package (`pytorch_model.bin`), so there is no separate download from Hugging Face.
- `morphology-db-msa-r13` — the shared morphology database the romanizer's analyzer reads; both engines need it.
- The `camel_data` package a machine lacks is the reason its engine will not load; the **Transliteration server…** dialog reports which engines are actually loaded.

### Which engine

| | BERT (default, recommended) | MLE (optional) |
| --- | --- | --- |
| Quality on unvocalized classical text | Best — it reads context, so it resolves ambiguous diacritization | Rougher; a lexical/statistical model with no context |
| Download | ~0.4 GB for the MSA model (the package here also carries the egy/glf/lev variants, ~1.7 GB total) | ~85 MB (`calima-msa`; ~110 MB for the whole package) |
| Shared data | ~160 MB morphology DB | ~160 MB morphology DB |
| Load into the server | ~16 s | ~2 s |

BERT is the default and what the plugin's tuning targets; pick MLE under **Transliteration → Engine** only if you specifically prefer it. Nothing preloads or selects MLE for you, and if BERT cannot load the script falls back to MLE automatically and tells you (an Obsidian alert, or stderr at the CLI).

Start the service from the plugin (**Transliteration server…**) or by hand:

```shell
python3 scripts/transliterate-server.py --port 8756
```

It loads `bert` at startup by default; do not pass `--preload mle` unless you have deliberately chosen MLE. `none` bypasses CAMeL entirely and only works on fully vocalized input. See [Transliteration](./transliteration.md).

## LLM romanization (optional)

If you prefer an LLM over the rule engine for individual calls, the transliteration service can call **Gemini**, **DeepSeek**, or an OpenAI-compatible endpoint. Add the endpoint under **LLM → Configurations**, then choose it for **LLM → Transliteration**, or export `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY` for the server process. The provider SDKs are imported lazily, so a missing one only matters when you choose that provider.

## Zotero (optional)

Sending imported works to Zotero needs either a running local Zotero (started and reachable on `127.0.0.1:23119`) or a Zotero web API key. No Python packages are involved. See [Zotero export](./zotero.md).

## Troubleshooting

- **“No usable Python found”** — the plugin could not import `fitz`, `requests`, and `google.genai` from any candidate. Install them into the interpreter you want, then set its full path in **Python executable**.
- **The BERT engine will not load** — install `transformers` and run `camel_data -i disambig-bert-unfactored-msa`; the first load also downloads the model and needs network access.
- **Everything works, but the engine is out of date** — the resident server serves the code it loaded at startup. Restart it after any change to `arabic-bw-transliterate.py`. See [Troubleshooting](./troubleshooting.md).
