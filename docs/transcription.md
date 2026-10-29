# Transcription (scanned PDFs)

**Transcribe this item’s PDF file(s)** turns a literature item’s scanned PDFs into page-separated Arabic markdown, using a Gemini OCR pipeline with local post-processing. Run it from a `@citekey` note (the command reads that note’s Zotero attachments). . **Transcribe a PDF…** does the same for any PDF you choose, with no Zotero item or literature note.

## Literature notes and Zotero

The automated item route assumes a **literature note** for the Zotero item: a Markdown note named `@<citekey>` in `_2 Bibliographic notes`, carrying the item’s `citekey`/`zotero-key` and its `attachments:` (or a cached Zotero path). Normally **[ScholarWeft](https://community.obsidian.md/plugins/scholar-weft)** or **[ZotLit](https://github.com/aidenlx/zotlit)** creates it from Zotero. Midad does not import references or create these notes itself, and it does not create a Zotero item for a PDF; it only finds the PDFs described by an existing note.

PDF resolution for that route tries the Zotero local API, the ScholarWeft `zlinks` cache, and `~/Zotero/storage` in that order. If you have no literature note (or no Zotero), use **Transcribe a PDF…**, which needs no citekey and writes a `mas-` note instead.

## What happens

The OCR and translation models are chosen on the plugin's **LLM** settings page. Add one or more configurations there, then assign one to **Transcription** and one to **Translation**. Each configuration carries its own provider, model, and API key, so the same model can use a free key for transliteration and a paid key for the PDF pipeline. The pipeline currently requires a Gemini configuration for transcription and translation. The default is Gemini 3.5 Flash Lite.

For each PDF the pipeline:

1. **Bursts** the PDF into one PDF per page.
2. **Submits** a Gemini batch job over the pages using the model assigned to transcription (batch mode is cheaper and handles a whole book at once).
3. **Collects** the raw OCR output and re-OCRs any page the model flagged as a hallucination.
4. **Post-processes** locally.

The intermediates live under `.midad-arabic-sources/work/` and are removed once the vault note is written; the batch archive under `.midad-arabic-sources/archive/` is kept, and it is what **Reprocess from archive…** re-runs without resubmitting.

The finished note is written to `<Sources>/Transcriptions/` as `@<citekey> - transcription.md` when it belongs to a Zotero item, with one `#### p. N` heading per page. A standalone PDF, with no Zotero citekey, uses `mas-<slug> - transcription.md`. Transcriptions and translations are automatically made annotatable; multi-volume series share one annotation note. A multi-volume item gets `@<citekey> - transcription - vol. N.md` (or the `mas-` form for a standalone series), and the volume number is inferred from the PDF filename when the dialog does not supply one.

## Standalone PDFs (no Zotero item)

**Transcribe a PDF…** opens a dialog with a file picker and an editable path, so it works for a PDF anywhere on disk. The citekey is generated from the filename (`pdf-<name>`) and can be changed before starting; it determines the note name, and the dialog refuses to overwrite an existing transcription with the same citekey.

A standalone PDF has no Zotero record to supply its bibliography, so the transcription prompt adds a short title-page instruction: Gemini writes the printed title and author as `TITLE:` and `AUTHOR:` lines above the first page. Post-processing removes those lines from the body and saves them as a sidecar beside the processed text. The pipeline then writes them into the note’s `title:` and `authors:` fields. This instruction is passed only for standalone PDFs; literature-note transcriptions do not receive it.

When the note is written, a second dialog shows the guessed title and author for verification. Correct them and choose **Save** (or **Save and open**); **Skip** keeps the guess and the note can be edited later. The resulting YAML carries the same bibliographic fields as a Zotero-derived transcription, except that there is no `[[@citekey]]` literature-note link in `midad-up:` because no such note exists.

## Post-processing

Local scripts run after OCR and never call Gemini:

- **Qurʾān quotes** — `﴿ … ﴾` spans are detected and rendered as the vault’s `quran-quote` callout, with tashkīl reconciled against the canonical Qurʾān notes.
- **Poetry** — verse is wrapped in the `>[!arabic-poetry]` callout, one hemistich per `>- ` line. The OCR prompt asks for a `§§§` line marker and `%%` between hemistiches; post-processing also accepts the older `*` forms, including a marker stuck to the first word, and splits multiple couplets that were returned on one line.
- **Footnotes** — the source’s footnote markers and bodies are reconstructed as markdown footnotes.
- **TOC** — a fihris/contents page (recognized by a `فهرس`/`محتويات` heading or a `صحيفة` column header) is kept one entry per line and formatted as a `>[!TOC]` callout with `>-` list items. `#### Title page` is renamed `#### TOC` when the page’s content is a table of contents.
- **Tashkīl** — the transcription’s vocalization is normalised (for example the waṣla alif and dagger alif), matching the transliteration engine’s conventions.

`transcription-format.py` and `transcription-quran.py` are the two scripts behind this step; the orchestrator runs them in order.

## Prompts

The dialog has a **Prompt** dropdown to the left of **Select all** / **Select none**, listing the available transcription prompts. **Default prompt** is the built-in OCR instruction; it can be edited but not deleted.

- **Modify selected** opens the editor for the chosen prompt. **Save** replaces it; **Save as** adds a copy under a new name.
- **Create a new prompt from selected** starts a copy of the chosen prompt, which is useful for adapting the pipeline to a different language, script, or page layout.
- **Delete selected prompt** removes a custom prompt; it is disabled for **Default prompt**.

The prompts live in `.midad-arabic-sources/transcription-prompts.json`. An unmodified **Default prompt** is refreshed from the plugin's built-in text after an update; once you edit it, your version is kept. The selected prompt is passed to the batch job as its system instruction.

The editor holds only the **text-specific** part. The pipeline appends it to a shared, hardcoded format contract (page headings such as `#### p. N`, `---` page separators, one blank line between blocks, no hard wrapping) and the general transcription rules (accuracy, poetry, footnotes). Those general parts stay consistent across every text; the editable part describes the document in front of you.

## Commands

- **Transcribe this item’s PDF file(s)** — the full pipeline above.
- **Transcribe a PDF…** — choose any PDF on disk, with no Zotero item, then verify the guessed title and author.
- **Re-render this source** — re-run post-processing for the active transcription/translation from its archived JSON. On a volume note, choose only that volume or all volumes.
- **Check transcription pipeline** — list the archived batches on disk.
- **Show pipeline status** — reveal the live status panel while a job runs, resume a job that was interrupted, or open the last log when nothing is running.
- **Open last pipeline log** — open the most recent job log.
- **Reprocess from archive…** — pick an archived batch and re-run post-processing only (no Gemini resubmission). Use this after a change to the post-processing scripts, or to recover an interrupted job.

## Progress and logs

A running job shows a **non-modal status panel** pinned to the corner of the window: one line per pipeline event, with `step/steps` progress. It stays until you close it, and it is what **Show pipeline status** reveals.

Each job writes a log and a state file under `.midad-arabic-sources/jobs/`. The state file is removed on success and kept on failure, which is how the plugin offers to **resume** a job after a reload or a crash — it will not resume a job whose recorded process is still alive.

## Requirements

- A **Gemini API key** in the LLM configuration assigned to transcription and translation (or `GEMINI_API_KEY`/`GOOGLE_API_KEY` in the pipeline's environment).
- Python 3 with `pymupdf`, `requests`, and `google-genai`.
- The PDFs themselves: for **Transcribe this item’s PDF file(s)**, a `@citekey` literature note (from ScholarWeft or ZotLit) and the item’s Zotero attachments, resolved via the local Zotero API, the ScholarWeft `zlinks` cache, or the Zotero storage folder; for **Transcribe a PDF…**, a PDF chosen directly from disk.

See [Dependencies](./dependencies.md) for the install lines, and [Translation](./translation.md) for translating a finished transcription.
