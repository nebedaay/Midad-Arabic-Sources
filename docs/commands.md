# Commands

Every command is in the command palette under **Midad Arabic Sources**, grouped here by function. The guide for each group is linked from its heading.

## Documentation

- **Open documentation** — open the in-app guide (this collection of pages).

## Transliteration

See [Transliteration](./transliteration.md).

- **Transliterate selection to clipboard** — romanize the selection (or current line) to the clipboard.
- **Transliterate note to new note** — romanize a whole note or selection into a sibling note.
- **Transliteration server…** — a dialog showing whether the service is running, which engines are loaded (and which is actually used), and the LLM providers, with one **Start** / **Stop** button.

## Transcription and translation

See [Transcription](./transcription.md) and [Translation](./translation.md).

- **Transcribe this item’s PDF file(s)** — burst, OCR, and post-process.
- **Transcribe a PDF…** — choose any PDF on disk, without a Zotero item, and verify Gemini’s title/author guess afterwards.
- **Translate this item’s transcription(s)** — translate an existing transcription.
- **Reprocess from archive…** — re-run post-processing from an archived batch, without resubmitting.
- **Check transcription pipeline** — list archived batches.
- **Show pipeline status** — reveal the status panel, resume an interrupted job, or open the last log.
- **Open last pipeline log** — open the newest job log.

## Document import

See [Document import](./document-import.md) and [Templates](./templates.md).

- **Manage text sources…** — install, uninstall, or send works to Zotero.
- **Add Turath work by URL…** — add a Turath book to your personal list (see [Adding a work by URL](./document-import.md#adding-a-work-by-url)).
- **Copy import templates to vault** — copy the editable ETA templates into your vault.
- **Re-render imported sources** — regenerate every note from its cached model.
- **Re-render this source** — regenerate an imported work, or re-run a transcription/translation from its archived JSON (also on the note’s right-click menu). On a volume transcription, choose only that volume or all volumes.
- **Apply template changes to imported sources** — apply a detected template change on demand.
- **Re-download imported sources (rebuild models)** — re-fetch the source JSON and rebuild every model.
- **Migrate imported sources to the current naming scheme** — rename installed works to `Author - Title (repository)`, updating notes, models, MOCs, and annotation paths.
- **Check imported sources** — find works whose notes or cached model are missing.
- **Check for source updates** — ask each repository whether a text changed upstream.
- **Archive this source…** — compress a work's model, remove its notes, and keep its annotations.

## Annotations

See [Document import](./document-import.md#annotations).

- **Annotate the selected text** — open the colour/comment popup for a managed-region selection.
- **Edit annotation** / **Delete annotation** — act on the annotation under the cursor.
- **Resize annotation to selection** — replace an existing highlight with the selected span; the editor context menu offers the same action.
- **Re-anchor orphaned annotation…** — use the current selection as the new anchor for an unanchored annotation. The selection popup also offers Re-anchor when the current note has orphans.
- **Re-anchor orphaned annotations in this source** — scan every unit in the active work and retry automatic recovery for all orphans.
- **Delete annotations for this source…** — move a work's annotation store and note to the plugin trash.
- **Open Midad sidebar** — open the Midad sidebar. Navigation is available for every note; annotatable notes also show the Annotations tab, MOC links, and Manage sources.
- **Copy source with annotations** — copy the managed source text plus a colour-callout annotation section.
- **Adopt note for annotations** — make an arbitrary Markdown note annotatable by adding a stable work/unit identity and a managed body region. Known Midad transcriptions/translations are adopted automatically.
- **Open source annotations** — open the generated per-work annotation note.
- **Open annotation trash** — restore or permanently delete annotation batches.
- **Reload annotations** — reload the store and repaint open source notes.

## Zotero

See [Zotero export](./zotero.md).

- **Send all installed sources to Zotero**
- **Send selected sources to Zotero…**
- **Send this source to Zotero**

## From the command line

The Python scripts behind the plugin can be run from a terminal — useful for batch work, a machine without Obsidian, or debugging a pipeline. Run them with the Python that has the dependencies (see [Dependencies](./dependencies.md)), either from the repository or from the deployed plugin folder:

```shell
cd "<vault>/<config folder>/plugins/midad-arabic-sources"
export OBSIDIAN_VAULT="<vault>"
export GEMINI_API_KEY="…"                 # transcription and translation
export MIDAD_LITERATURE_DIR="<folder>"    # optional; otherwise ScholarWeft's folder, then a vault-wide @citekey search
```

`OBSIDIAN_VAULT` is only needed when the scripts are not inside the vault. Every command accepts `--help` for its full options.

### Transliteration

```shell
python3 scripts/arabic-bw-transliterate.py -text "بسم الله الرحمن الرحيم" --engine bert
python3 scripts/arabic-bw-transliterate.py -text "…" --engine bert --keep-case --name --sun-letters
python3 scripts/arabic-bw-transliterate.py --llm --provider gemini --model gemini-3.5-flash-lite
```

`-text` takes the passage; omit it to read interactively. `--engine` is `bert` (default), `mle`, or `none`; `--keep-case`, `--name`, `--sun-letters`, and `--dotless-ya maqsura|ya` match the settings. `--llm` uses a provider directly (`gemini`, `deepseek`, or `openai`, with `--model`, `--base-url`, `--api-key`), or the resident server with `--server-url`. The resident service and its browser interface are started with `python3 scripts/transliterate-server.py --port 8756`.

### Transcription

```shell
python3 scripts/midad-arabic-sources-pipeline.py transcribe --citekey KEY
python3 scripts/midad-arabic-sources-pipeline.py transcribe --citekey pdf-my-book --standalone --pdf "/path/to/book.pdf"
python3 scripts/midad-arabic-sources-pipeline.py transcribe --citekey KEY --pdf "/path/to/vol2.pdf::2" --volume 2
```

The first form resolves the item’s PDFs through the `@KEY` literature note, in the same way as **Transcribe this item’s PDF file(s)**. `--standalone` skips Zotero and takes `--pdf`; repeat `--pdf` for more files, and append `::N` to a path to mark its volume. `--model` overrides the Gemini model and `--prompt-file` a text-specific prompt.

### Translation

```shell
python3 scripts/midad-arabic-sources-pipeline.py translate --citekey KEY
python3 scripts/midad-arabic-sources-pipeline.py translate --citekey KEY --source "…/@KEY - transcription - vol. 2.md" --volume 2
```

With no `--source`, it translates the transcriptions it finds for the citekey. `--volume`, `--model`, and `--prompt-file` behave as in the dialog.

### Inspection and reprocessing

```shell
python3 scripts/midad-arabic-sources-pipeline.py list-pdfs "…/@KEY.md"
python3 scripts/midad-arabic-sources-pipeline.py list-transcriptions "…/@KEY.md"
python3 scripts/midad-arabic-sources-pipeline.py list-archive
python3 scripts/midad-arabic-sources-pipeline.py default-prompts
python3 scripts/midad-arabic-sources-pipeline.py reprocess --zip "…/archive/@KEY - transcription files.zip"
python3 scripts/midad-arabic-sources-pipeline.py resume --state ".midad-arabic-sources/jobs/….json"
```

### Text-source import

```shell
python3 scripts/text-source-import.py list
python3 scripts/text-source-import.py fetch --key tafsir:ar-tafsir-al-jalalayn
python3 scripts/text-source-import.py list --collection turath --language ar
```

`fetch` downloads the work and writes its render model under `.midad-arabic-sources/source-models/`; open Obsidian and run **Re-render imported sources** (or **Manage text sources…**) to render the notes.
