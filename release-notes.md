This release refreshes the documentation and release notes that ship with **Midad Arabic Sources**. Plugin behavior is unchanged from 0.1.0; the bundled in-app documentation and repository guides now match the current sidebar, annotation, navigation, and annotation-note behavior.

### Documentation

- The README and the Annotations, Commands, and Templates guides now describe the Navigation/Annotations sidebar tabs, compact annotation counts, foldable child lists, Live Preview resize handles, atomic wikilink selections, and the white-page quote layout in annotation notes.
- The release notes now cover the annotation-note presentation and the current navigation model.
- The bundled documentation embedded in `main.js` has been rebuilt from the revised pages.

### 0.1.0 feature set

- **Text-source import:** catalog-driven acquisition and rendering for tafsīr, Qurʾān translations and riwāyāt, ḥadīth collections, Hans Wehr, Lane, and Turath.io books. Generated content lives in a managed region, so re-rendering preserves your edits.
- **Hierarchy and MOCs:** Arabic-first source MOCs, topic and repository indexes, a configurable source root, and a sidebar Navigation tab built from `midad-up` parents, siblings, sections, and child notes.
- **Annotations:** select text in Live Preview or Reading view, choose a colour and comment, and keep annotations separate from the generated source. Margin icons, comment tooltips, annotation notes, source-annotation MOCs, orphan detection and re-anchoring, archive/restore, and copy-with-annotations are included.
- **Annotation editing:** caret/context-menu commands, selection-based resizing, and draggable oval handles in Live Preview. Wikilinks are treated as atomic selections, and legacy partial-link annotations are widened automatically.
- **Sidebar:** annotation cards with rendered Markdown quotes and links, `midad-up` navigation for every note, Navigation and Annotations tabs, per-note annotation counts with comment icons, and a foldable current-note child list.
- **Annotation notes:** light blue callouts with the comment first in a colour-gradient inset, each quote on a white inset page with highlighted text, plus dates, a valid block ID, and a user-maintained notes area.
- **Transcription and translation:** Gemini OCR for Zotero PDFs or standalone PDFs, page-separated Arabic output, poetry and Qurʾān post-processing, reusable prompts, and translation of finished transcriptions.
- **Transliteration:** CAMeL-backed selection and note romanization through a resident local service, with optional LLM configurations.
- **Zotero export:** Local API, Web API, or CSL-JSON export with update-in-place support.

### Install or update

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `nebedaay/Midad-Arabic-Sources`, or download `main.js`, `manifest.json`, and `styles.css` from this release and place them in `.obsidian/plugins/midad-arabic-sources/`.

The plugin is desktop-only and requires Obsidian 1.13 or later. Python 3 is required for local import, transcription, and transliteration support; CAMeL Tools and a Gemini API key are needed only for those features.

See the [README](https://github.com/nebedaay/Midad-Arabic-Sources#readme) and the bundled documentation for setup details.
