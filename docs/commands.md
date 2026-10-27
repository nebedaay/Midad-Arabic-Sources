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
