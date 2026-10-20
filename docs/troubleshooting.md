# Troubleshooting

## Transliteration

### “Transliteration server not reachable”

The service is not running, or it is on another port. Run **Transliteration server…** and press **Start**, or start it by hand (`python3 scripts/transliterate-server.py --port 8756`). If you changed the port under **Transliteration → Server URL**, the setting and the running process must agree.

### Readings lose their final short vowels and tanwīn

The resident server keeps serving the code it loaded at startup, so an older `arabic-bw-transliterate.py` can still be running while the file on disk is new. Open **Transliteration server…** and press **Stop**, then **Start**. The dialog reports only the *loaded* engines, so it cannot by itself detect a stale one.

### The BERT engine will not load

The `bert` engine needs `transformers` and its model data. Install them and fetch the data (`camel_data -i disambig-bert-unfactored-msa`); the model ships inside that package, so there is no separate download. If BERT still cannot load, the server falls back to `mle` and tells you; or choose **Engine** `mle` (faster, rougher) or `none` (fully vocalized input only). See [Dependencies](./dependencies.md).

### “The transliteration server did not start” / “No module named camel_tools”

The plugin spawns the server with the same Python resolution it uses elsewhere: the **Transliteration → Python path** setting first, then PATH, the installer venv, conda/anaconda, pyenv, Homebrew and the distro interpreters, probing for `camel_tools`. A GUI-launched Obsidian has a much smaller PATH than your terminal, so it can miss a conda install that `python3` finds in the shell. Set **Transliteration → Python path** to the interpreter where `camel_tools` is installed (e.g. `~/miniconda3/bin/python3`); the failure notice prints the last lines of the server log, including the missing module.

### “No usable Python found”

The plugin could not import `fitz`, `requests`, and `google.genai` from any candidate interpreter. Install them into the Python you want and set its full path under **Transcription and translation → Python executable**.

### A word is romanized wrongly every time

Add it to the user lexicon: after a note transliteration, a dialog lists the terms the engine had no analysis for, with an editable romanization per row. Words the engine *does* misread can be pinned there too. See [Transliteration](./transliteration.md).

## Transcription and translation

### “Gemini API key required”

Set a key under **Transcription and translation → Gemini API key**, or launch Obsidian from a shell that exports `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).

### “No PDF attachments found for this item”

The command ran on something other than a `@citekey` note, or the item has no PDF. The pipeline resolves PDFs from the Zotero local API, the ScholarWeft `zlinks` cache, and the Zotero storage folder, in that order; a linked file whose absolute path is known only to a running Zotero may be missing when Zotero is closed.

### A job seems frozen

A Gemini batch has no per-page progress; the panel updates only when a page or step completes. **Show pipeline status** reveals the panel and offers to resume a job that stopped.

### A job stopped, or Obsidian reloaded mid-run

The job’s state file survives under `.midad-arabic-sources/jobs/`. **Show pipeline status** offers to resume it; the plugin refuses if the recorded process is still alive. To recover a finished batch without resubmitting, use **Reprocess from archive…**.

### Post-processing changed but the note did not

Re-run **Reprocess from archive…** on the batch to regenerate the note from the archived OCR, without paying for Gemini again.

## Document import

### “This source requires transliteration to render, but the transliteration server is not running”

The dictionaries name entries by romanizing the bare root, which needs the service. Start it and **Try again**, or choose **Proceed without transliteration** (the entries are then named from their radicals).

### A work’s notes or cached model are missing

Run **Check imported sources**. It compares the manifest against the vault and the model cache and offers to restore anything missing. An `installed` work is restored if any file is absent; a work mid-removal is never restored.

### A template edit does not take effect

The bundled templates live in `.obsidian`, which Obsidian’s file watcher ignores, and the plugin polls for changes only every 45 seconds (and only when **Update notes when templates change** is on). Run **Apply template changes to imported sources** to apply it at once. Remember the edit must be in the *user* template folder (`Copy import templates to vault`) or in the bundled copy that `npm run deploy` writes; editing the deployed copy is overwritten by the next deploy.

### Editing a template re-rendered far more than expected

Re-renders are scoped to the unit kinds whose template changed. A change to the dictionary note template still rewrites every root, because every root uses it; use **Re-render this source** to limit it to one work.

### “Check for source updates” re-rendered a work unexpectedly

A changed upstream **content hash** (not just a moved date) triggers a re-download and re-render. A date-only move records the new date and changes nothing.

### The plugin was updated but the old behaviour persists

Restart Obsidian. The plugin loads `main.js` only at startup, and it unpacks the new scripts and templates on the next load.

## Zotero

### “No local Zotero found on port 23119”

Start Zotero, or choose the **Web API** method and enter a key and library ID. The **Detect** button only fills the library ID from a *running* local Zotero.

### Items duplicate instead of updating

Update-in-place relies on the stored item key and version. If you deleted the item in Zotero, it is recreated only when **Create Zotero items for all sources** is on; otherwise re-send it by hand.

### A template re-render sent nothing

That is correct. Sends are decided by the content hash of the work model and the publication map, not the rendered note, so a pure template change needs no update.

### Bibliographic details look wrong

They come from `publication-map.json` and are marked `verified: false` until checked. Edit your vault copy of the map, then re-send. See [Zotero export](./zotero.md).
