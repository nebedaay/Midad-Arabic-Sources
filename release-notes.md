# 0.1.4

This release adds the optional **Arabic Fields Romanizer** Zotero companion to the repository and documents it, and includes the literature-notes-folder and command-line fixes from 0.1.3.

### Midad Arabic Transliteration

- The Zotero 7 companion now lives under `midad-arabic-transliteration/` with its source, `build.sh`, update manifest, and built `.xpi`. It is **not** bundled into `main.js` or the Obsidian plugin's release assets.
- The new [Midad Arabic Transliteration](https://github.com/nebedaay/Midad-Arabic-Sources/blob/main/docs/midad-arabic-transliteration.md) guide covers installation, the server requirement, the **Midad: Create romanized copy** action, Zotero Config Editor preferences, and updates.
- It uses the same resident transliteration server (`/transliterate`, `/place`, `/lexicon`) as the plugin, so start **Transliteration server…** first.

### Literature notes and CLI

- **Transcription and translation → Literature notes folder** makes the `@citekey` location configurable. Blank uses ScholarWeft’s `literatureNoteFolder`; otherwise the note is found by name anywhere in the vault. No personal folder name is assumed.
- The **Commands** guide has a **From the command line** section for transliteration, transcription, translation, listing, reprocessing, and text-source import, with the required environment variables.
- Installation docs use **Community plugins** as the default route and **BRAT** as the beta alternative.

### Also in 0.1.2 / 0.1.3

`quran-ar` / `quran-en` presentation and the English translation layout; local-only fonts; the note-following Midad sidebar with the last right-sidebar tab remembered across reloads; retired `midad-source` / `midad-key`; the separate translation template and the template auto-update repair; and the Obsidian review fixes (no remote font URLs, no `!important` / `:has()` in the plugin CSS, `Vault.configDir`, and no `builtin-modules` dependency).
