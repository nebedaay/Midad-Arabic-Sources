# Transcription (scanned PDFs)

**Transcribe this item’s PDF file(s)** turns a literature item’s scanned PDFs into page-separated Arabic markdown, using a Gemini OCR pipeline with local post-processing. Run it from a `@citekey` note (the command reads that note’s Zotero attachments).

## What happens

For each PDF the pipeline:

1. **Bursts** the PDF into one PDF per page.
2. **Submits** a Gemini batch job over the pages (batch mode is cheaper and handles a whole book at once).
3. **Collects** the raw OCR output and re-OCRs any page the model flagged as a hallucination.
4. **Post-processes** locally.

The intermediates live under `.midad-arabic-sources/work/` and are removed once the vault note is written; the batch archive under `.midad-arabic-sources/archive/` is kept, and it is what **Reprocess from archive…** re-runs without resubmitting.

The finished note is written to `_2 Bibliographic notes/Arabic transcriptions/` as `@<citekey> - transcription.md`, with one `#### p. N` heading per page. Transcriptions and translations are automatically made annotatable; multi-volume series share one annotation note. A multi-volume item gets `@<citekey> - transcription vol. N.md`, and the volume number is inferred from the PDF filename when the dialog does not supply one.

## Post-processing

Local scripts run after OCR and never call Gemini:

- **Qurʾān quotes** — `﴿ … ﴾` spans are detected and rendered as the vault’s `quran-quote` callout, with tashkīl reconciled against the canonical Qurʾān notes.
- **Poetry** — verse is wrapped in the `>[!arabic-poetry]` callout, one hemistich per `>- ` line.
- **Footnotes** — the source’s footnote markers and bodies are reconstructed as markdown footnotes.
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
- **Check transcription pipeline** — list the archived batches on disk.
- **Show pipeline status** — reveal the live status panel while a job runs, resume a job that was interrupted, or open the last log when nothing is running.
- **Open last pipeline log** — open the most recent job log.
- **Reprocess from archive…** — pick an archived batch and re-run post-processing only (no Gemini resubmission). Use this after a change to the post-processing scripts, or to recover an interrupted job.

## Progress and logs

A running job shows a **non-modal status panel** pinned to the corner of the window: one line per pipeline event, with `step/steps` progress. It stays until you close it, and it is what **Show pipeline status** reveals.

Each job writes a log and a state file under `.midad-arabic-sources/jobs/`. The state file is removed on success and kept on failure, which is how the plugin offers to **resume** a job after a reload or a crash — it will not resume a job whose recorded process is still alive.

## Requirements

- A **Gemini API key** (setting or `GEMINI_API_KEY`/`GOOGLE_API_KEY`).
- Python 3 with `pymupdf`, `requests`, and `google-genai`.
- The PDFs themselves, resolved from the item’s Zotero attachments (the local Zotero API, the ScholarWeft `zlinks` cache, or the Zotero storage folder, in that order).

See [Dependencies](./dependencies.md) for the install lines, and [Translation](./translation.md) for translating a finished transcription.
