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
- **Re-render this source** — regenerate one work (also on the note’s right-click menu).
- **Apply template changes to imported sources** — apply a detected template change on demand.
- **Re-download imported sources (rebuild models)** — re-fetch the source JSON and rebuild every model.
- **Migrate imported sources to the current naming scheme** — one-off rename to the repository-qualifier convention.
- **Check imported sources** — find works whose notes or cached model are missing.
- **Check for source updates** — ask each repository whether a text changed upstream.
- **Archive this source…** — compress a work's model, remove its notes, and keep its annotations.

## Annotations

See [Document import](./document-import.md#annotations).

- **Annotate the selected text** — open the colour/comment popup for a managed-region selection.
- **Edit annotation** / **Delete annotation** — act on the annotation under the cursor.
- **Re-anchor orphaned annotation…** — use the current selection as the new anchor for an unanchored annotation.
- **Delete annotations for this source…** — move a work's annotation store and note to the plugin trash.
- **Open annotation sidebar** — reveal the active source's annotation cards.
- **Copy source with annotations** — copy the managed source text plus a colour-callout annotation section.
- **Open source annotations** — open the generated per-work annotation note.
- **Open annotation trash** — restore or permanently delete annotation batches.
- **Reload annotations** — reload the store and repaint open source notes.

## Zotero

See [Zotero export](./zotero.md).

- **Send all installed sources to Zotero**
- **Send selected sources to Zotero…**
- **Send this source to Zotero**
