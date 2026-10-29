# 0.1.5

A small cleanup release: it clears the last avoidable community-directory warning and carries the final documentation and Zotero-companion naming updates from `main`.

### Review cleanup

- Replaced the two `column-gap` declarations in the Manage sources grid with the equivalent `gap: 8px` shorthand. This clears the directory scanner’s **“multicolumn”** warning (2 occurrences) without changing layout or behaviour.
- The only warnings left are the deliberate `JsonObject` `any` and the desktop plugin’s filesystem/shell disclosures.

### Zotero companion

- Renamed **Arabic Fields Romanizer** to **Midad Arabic Transliteration**:
  - Zotero ID `midad-arabic-transliteration@nebedaay.github.io`
  - `.xpi` at `midad-arabic-transliteration/midad-arabic-transliteration.xpi`
  - preferences `extensions.midadArabicTransliteration.*`
  - menu action **Midad: Create romanized copy**
  - update manifest under `midad-arabic-transliteration/updates.json`
- The companion remains separate from the Obsidian plugin bundle and release assets; there is a new in-app **Midad Arabic Transliteration** guide covering installation, the transliteration server, preferences, and updates.
- Anyone with the old `arabic-fields-romanizer@example.com` build must reinstall it once because the ID changed.

### Documentation

- Installation uses **Community plugins** as the default and **BRAT** as the beta alternative.
- The transcription and translation guides point to the **Literature notes folder** setting; blank uses ScholarWeft’s `literatureNoteFolder`, then a vault-wide `@citekey` search.
- The Commands guide includes the **From the command line** section for transliteration, transcription, translation, inspection, and text-source import.

Install or update from the community directory when listed, via BRAT (`nebedaay/Midad-Arabic-Sources`), or manually from this release.
