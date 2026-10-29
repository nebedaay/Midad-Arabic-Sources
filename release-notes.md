# 0.1.3

This patch makes the Zotero literature-notes folder configurable instead of assuming a vault-specific path, and adds a command-line guide for transcription, translation, transliteration, and text-source import. It supersedes 0.1.2; install it the same way.

### Literature notes folder

- **Transcription and translation → Literature notes folder** sets where the item route looks for `@citekey` notes.
- Leave it blank and Midad uses **ScholarWeft’s `literatureNoteFolder`**. If that is unavailable, it finds the `@<citekey>` note by name anywhere in the vault instead of falling back to a hard-coded folder.
- The pipeline scripts accept `MIDAD_LITERATURE_DIR` and no longer assume `_2 Bibliographic notes`. The transcription and translation guides now describe the setting rather than a personal folder.
- **Transcribe this item’s PDF file(s)** and **Translate this item’s transcription(s)** still require a literature note; **Transcribe a PDF…** remains the route without Zotero.

### Command line

The **Commands** guide now has a **From the command line** section covering:

- transliteration (`arabic-bw-transliterate.py`, the server, and the browser interface);
- transcription (`midad-arabic-sources-pipeline.py transcribe`, item and standalone);
- translation (`… translate`);
- listing, reprocessing, resuming, prompt inspection, and text-source import.

It lists the required `OBSIDIAN_VAULT`, `GEMINI_API_KEY`, and optional `MIDAD_LITERATURE_DIR` environment variables.

### Documentation and installation

- Installation in the README and Setup guide now presents **Settings → Community plugins → Browse** as the default route, with **BRAT** as the alternative for the latest beta and manual installation last.
- The transcription and translation guides explain that the automatic route expects a ScholarWeft or ZotLit `@citekey` literature note; Midad does not create those notes.
- The Zotero guide gains a short **Literature notes** section, and the release notes and in-app documentation were rebuilt.

### Also in 0.1.2

- `quran-ar` / `quran-en` styling, the English translation layout, the shared gilded fill, local-only fonts, and the verse-marker controls.
- The note-following Midad sidebar, with the last right-sidebar tab remembered across reloads.
- Retired `midad-source` / `midad-key`, the separate translation template, and the template auto-update repair.
- The Obsidian review fixes: no remote font URLs, no `!important` / `:has()` in the plugin CSS, `Vault.configDir` for the plugin folder, and no `builtin-modules` dependency.
