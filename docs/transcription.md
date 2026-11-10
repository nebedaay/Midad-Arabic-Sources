# Transcription (scanned PDFs)

**Transcribe this item’s PDF file(s)** turns a literature item’s scanned PDFs into page-separated Arabic markdown, using a Gemini OCR pipeline with local post-processing. Run it from a `@citekey` note (the command reads that note’s Zotero attachments). For best results, import Zotero items using **[ScholarWeft](https://community.obsidian.md/plugins/scholar-weft)**, which creates the necessary properties.

**Transcribe a PDF…** does the same for any PDF you choose, with no Zotero item or literature note.

## Literature notes and Zotero

The automated item route assumes a **literature note** for the Zotero item: a Markdown note named `@<citekey>`, carrying the item’s `citekey`/`zotero-key` and its `attachments:` (or a cached Zotero path). Midad looks for it in the folder set under **Transcription and translation → Literature notes folder**; when that setting is blank it uses ScholarWeft’s own `literatureNoteFolder`, and if neither is available it finds the `@<citekey>` note by name anywhere in the vault. Normally **[ScholarWeft](https://community.obsidian.md/plugins/scholar-weft)** or **[ZotLit](https://github.com/aidenlx/zotlit)** creates it from Zotero. ScholarWeft’s default template creates exactly the metadata the plugin needs. Midad does not import references or create these notes itself, and it does not create a Zotero item for a PDF; it only finds the PDFs described by an existing note.

PDF resolution for that route tries the Zotero local API, the ScholarWeft `zlinks` cache, and `~/Zotero/storage` in that order. If you have no literature note (or no Zotero), use **Transcribe a PDF…**, which needs no citekey and writes a `mas-` note instead.

## What happens

The OCR and translation models are chosen on the plugin's **LLM** settings page. Add one or more configurations there, then assign one to **Transcription** and one to **Translation**. Each configuration carries its own provider, model, and API key, so the same model can use a free key for transliteration and a paid key for the PDF pipeline. The pipeline currently requires a Gemini configuration for transcription and translation. The default is Gemini 3.5 Flash Lite.

For each PDF the pipeline:

1. **Bursts** the PDF into one PDF per page.
2. **Submits** a Gemini batch job over the pages using the model assigned to transcription (batch mode is cheaper and handles a whole book at once).
3. **Collects** the raw OCR output and re-OCRs any page the model flagged as a hallucination.
4. **Post-processes** locally.

The intermediates live under `.midad-arabic-sources/work/` and are removed once the vault note is written; the batch archive under `.midad-arabic-sources/archive/` is kept, and it is what **Reprocess from archive…** re-runs without resubmitting.

Arabic metadata is kept in `title-ar`, `shorttitle-ar`, `authors-ar`, and `editors-ar`; an Arabic work carries `title-ar` even when the cover did not supply it, with an empty value the user can fill later. The **Include Arabic aliases** setting (on by default) adds the Arabic-script alias when an Arabic title and author are known; each note gets at most one romanized and one Arabic alias. A `topics:` entry (for example `Tafsīr`) is also added to the note's `midad-up` as `[[Midad topic - Tafsīr|Tafsīr]]`.

The finished note is written to `<Sources>/Transcriptions/` as `@<citekey> - transcription.md` when it belongs to a Zotero item, with one `#### p. N` heading per page. A standalone PDF, with no Zotero citekey, uses `mas-<slug> - transcription.md`. Transcriptions and translations are automatically made annotatable; multi-volume series share one annotation note. A multi-volume item gets `@<citekey> - transcription - vol. N.md` (or the `mas-` form for a standalone series), and the volume number is inferred from the PDF filename when the dialog does not supply one.

A PDF whose title is not a volume is treated as a **unit** of the work — a chapter, introduction, conclusion, or a named partial file. It is written as `@<citekey> - transcription - <Zotero title>.md`; its single `midad-id` is `zotero/<zotero-id>/transcription/<slug>`, from which the work (`zotero/<zotero-id>/transcription`) and unit (`<slug>`) are derived. The alias is `Author - year - Short title (transcription) - <title>`, with the Arabic counterpart using the same literal unit title. The unit title is taken from the Zotero attachment title; when only a filename is available it is the filename stem. A title matching the work title and no volume marker is still a full transcription, not a unit.

## Standalone PDFs (no Zotero item)

**Transcribe a PDF…** opens a dialog with a file picker and an editable path, so it works for a PDF anywhere on disk. The citekey is generated from the filename (`pdf-<name>`) and can be changed before starting; it determines the note name, and the dialog refuses to overwrite an existing transcription with the same citekey.

The first page of every transcription also receives a **cover metadata** supplement. When that page visibly contains a title page, cover, copyright page, or the opening of the work, Gemini returns one fenced YAML block before the transcription with `title`, `shorttitle`, `authors`, `editors`, and their Arabic-script counterparts (`title-ar`, `shorttitle-ar`, `authors-ar`, `editors-ar`). Post-processing removes the block from the body and saves it as a sidecar; the pipeline uses the romanized values for a standalone PDF and the Arabic values to populate `title-ar`, `shorttitle-ar`, `authors-ar`, and `editors-ar` even when Zotero supplied the romanized bibliography. The supplement is attached only to the first page, so later pages cannot repeat it. Older archives may instead carry `TITLE:`/`AUTHOR:` lines; those are still recognized and removed.

A standalone PDF has no Zotero record to supply its bibliography, so the romanized title, short title, authors, and editors from the cover block become its `title:`, `shorttitle:`, `authors:`, and `editors:` fields. A second dialog lets you verify them before saving.

When the note is written, a second dialog shows the guessed title and author for verification. Correct them and choose **Save** (or **Save and open**); **Skip** keeps the guess and the note can be edited later. The resulting YAML carries the same bibliographic fields as a Zotero-derived transcription, except that there is no `[[@citekey]]` literature-note link in `midad-up:` because no such note exists.

## Post-processing

Local scripts run after OCR and never call Gemini:

- **Qurʾān quotes** — `﴿ … ﴾` spans and Arabic text inside straight or curly double quotes, guillemets, and parentheses are checked against the canonical Qurʾān; matches get tashkīl and a citation. A quotation spanning consecutive verses gets a range link, and old links whose alias is the canonical work title are rewritten to the sūra name. Every quotation — full, beginning, or end — goes through the same renderer: canonical tashkīl, `*…{.quran-quote}*`, the ornate opening only on the beginning/full segment, the ornate closing only on the end/full segment, and the usual link after each segment. A quote opened at the end of one page and closed at the start of the next therefore has exactly one opening and one closing; the original quotation marks are replaced by that pair, not duplicated. An open fragment with no closing mark is treated as the start of a quote when the next page’s body begins with a recognised continuation.
- **Citation normalization** — before discarding a source citation, an adjacent `[النساء 4:105]` / `(النساء: ١٠٥)`-style citation is parsed and used as a **verified first search hint**: the quote is accepted only if its text is actually present in that verse or range, otherwise the normal text search runs. Once the plugin adds its own link, any remaining source citation that names a Qurʾānic verse is removed, so it cannot sit alongside the generated one. Every Qurʾān link display is normalized to the sūra name and Arabic-Indic numerals; western digits left by older renders are rewritten. Ordinary hadith/editorial references are not touched.
- **Poetry** — verse is wrapped in the `>[!arabic-poetry]` callout, one hemistich per `>- ` line. The OCR prompt asks for a `§§§` line marker and `%%` between hemistiches; post-processing also accepts the older `*` forms, including a marker stuck to the first word, and splits multiple couplets that were returned on one line.
- **Footnotes** — the source’s footnote markers and bodies are reconstructed as markdown footnotes.
- **Literal brackets** — a lone `[` in source prose is escaped as `\[`, while wikilinks, Markdown links, callout markers, and footnote refs are preserved. The same shared pass is used by imported sources and translations.
- **TOC** — a fihris/contents page (recognized by a `فهرس`/`محتويات` heading or a `صحيفة` column header) is kept one entry per line and formatted as a `>[!TOC]` callout with `>-` list items. `#### Title page` is renamed `#### TOC` when the page’s content is a table of contents.
- **Tashkīl** — the transcription’s vocalization is normalised (for example the waṣla alif and dagger alif), matching the transliteration engine’s conventions.

`transcription-format.py` and `transcription-quran.py` are the two scripts behind this step; the orchestrator runs them in order.

A transcription made by an older version of the plugin (or before it) may have no archive. **Post-process this transcription/translation** runs the same current scripts over the note body in place, without Gemini. It writes a backup under `.midad-arabic-sources/backups/`, rebuilds the native YAML and volume parent, and adds the note to the literature note’s `transcriptions:`/`translations:` list. The previous text is left in the backup if the result needs to be compared or restored.

**Assign topic and post-process this transcription…** writes a topic to the parent note. A parent topic containing “tafsīr” enables commentary mode: short quote fragments are checked first against the verse under discussion and the nearest previous match, rather than only against the whole Qur’ān. This is the right setting for a tafsīr such as Fī Riyāḍ al-Tafsīr; a general work leaves it off.

In commentary mode, consecutive segments of the same verse form one citation run. The first and last segments keep the link; intermediate segments keep the quote formatting but omit the repeated link. A switch to another verse or range starts a new run, so the first quote after the switch is cited. Quote runs inside footnote callouts are left alone.

If a same-named legacy/adopted parent exists elsewhere, the native parent absorbs its author-created YAML fields and body, fixes a clearly broken volume link, backs up both notes, and removes the duplicate. Native identity and citation fields win; author fields such as `up`, `shorttitle`, `related`, and aliases are merged. If the legacy parent is referenced by annotations, or if more than one candidate exists, it is left untouched rather than guessed at.

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
- **Re-render this source** — re-run post-processing for the active transcription/translation from its archived JSON. On a volume note, choose only that volume or all volumes. If there is no archive, it falls back to in-place post-processing.
- **Post-process this transcription/translation** — run the current local post-processing scripts over the open note, without an archive or Gemini.
- **Commit edits to archived transcription/translation** — save the current note’s page bodies as corrections for its archived batch; a later re-render from the archive reapplies them.
- **Re-render transcriptions of this item’s attachments** — from a literature note, re-render all of its transcription/translation notes, using archives where present and in-place post-processing for legacy notes.
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

See [Dependencies](./dependencies.md) for the install lines, [Translation](./translation.md) for translating a finished transcription, and [Commands → From the command line](./commands.md#from-the-command-line) to run the pipeline from a terminal.
