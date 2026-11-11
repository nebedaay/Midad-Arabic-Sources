# 0.2.3

Documentation cleanup and clarification.

### Automatic transcription/translation recognition

- Documented the exact filename forms Midad recognizes automatically:
  - `@citekey - transcription` / `translation`
  - `mas-citekey - transcription` / `translation`
  - optional `- vol. N` and final variant suffix
- Explained that `@citekey` means a Zotero/ScholarWeft literature note and `mas-` means a standalone PDF.
- Clarified that recognition is filename-based, not dependent on a special YAML property, and that the title comes from `title:` frontmatter when present.

### Documentation cleanup

- Removed obsolete legacy-marker, retired-property, and migration notes from the guides.
- Consolidated Unadopt under **Managed regions, identity, and adoption** instead of repeating it in the versions guide.
- Updated links so version lifecycle and identity/cleanup have distinct homes.

### Documentation workflow

- `Midad Docs/` in the vault is the source of truth. `npm run sync-docs` copies it into the development repo, and local builds run the sync automatically.
