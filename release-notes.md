This is the first tagged release of **Midad Arabic Sources**, a desktop plugin for bringing classical Arabic texts into Obsidian as linkable, searchable, annotatable notes.

### Highlights

- **Text-source import:** catalog-driven acquisition and rendering for tafsīr, Qurʾān translations and riwāyāt, ḥadīth collections, Hans Wehr, Lane, and Turath.io books. Generated content lives in a managed region, so re-rendering preserves your edits.
- **Hierarchy and MOCs:** Arabic-first source MOCs, topic and repository indexes, a configurable source root, and a sidebar Navigation tab built from `midad-up` parents, siblings, sections, and child notes.
- **Annotations:** select text in Live Preview or Reading view, choose a colour and comment, and keep annotations separate from the generated source. Margin icons, comment tooltips, annotation notes, source-annotation MOCs, orphan detection and re-anchoring, archive/restore, and copy-with-annotations are included.
- **Annotation editing:** caret/context-menu commands, selection-based resizing, and draggable oval handles in Live Preview. Wikilinks are treated as atomic selections, and legacy partial-link annotations are widened automatically.
- **Sidebar:** annotation cards with rendered Markdown quotes and links, Navigation and Annotations tabs, annotation counts with comment icons, and a foldable current-note child list.
- **Transcription and translation:** Gemini OCR for Zotero PDFs or standalone PDFs, page-separated Arabic output, poetry and Qurʾān post-processing, reusable prompts, and translation of finished transcriptions.
- **Transliteration:** CAMeL-backed selection and note romanization through a resident local service, with optional LLM configurations.
- **Zotero export:** Local API, Web API, or CSL-JSON export with update-in-place support.

### Install or update

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `nebedaay/Midad-Arabic-Sources`, or download `main.js`, `manifest.json`, and `styles.css` from this release and place them in `.obsidian/plugins/midad-arabic-sources/`.

The plugin is desktop-only and requires Obsidian 1.13 or later. Python 3 is required for local import, transcription, and transliteration support; CAMeL Tools and a Gemini API key are needed only for those features.

See the [README](https://github.com/nebedaay/Midad-Arabic-Sources#readme) and the bundled documentation for setup details.
