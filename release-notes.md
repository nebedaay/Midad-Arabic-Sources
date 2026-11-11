# 0.2.0

This release completes the source/version lifecycle work: safer removal, per-work version archives, a unified hash index, automatic correction consolidation, and cleanup tools.

### Versions and managed notes

- **Version 0 is virtual for installed and generated sources.** It represents the installed model or archived transcription/translation and creates no snapshot. Saved user versions are Version 1 and later.
- Version 0 can be selected, rendered as a separate `.Version0.md` note, or made the default independently of the other versions.
- Saved versions are stored in **per-work archives** under `.midad-arabic-sources/version-archives/`; the old global `source-versions.zip` is migrated automatically.
- Reinstalling or restoring a source automatically reapplies its saved versions.
- Managed-region baselines and saved-version hashes now live in one index, `.midad-arabic-sources/note-hashes.json`.
- Managed-region markers are normalized consistently on every write, including a blank line after the closing marker at the end of a note.
- The version manager reports template/render-fingerprint changes without rewriting historical snapshots.

### Safer source removal

- Removing a source now keeps notes containing user-written text outside the managed region, stripping only the generated region.
- The removal dialog offers **Remove, keep my notes** or **Remove everything**.
- **Delete cached model only** keeps notes and versions while removing the model.
- **Re-download source/model** re-fetches a source while preserving user content.
- Source removal and model deletion require explicit confirmation.

### Corrections and cleanup

- Legacy `*.corrections.json` sidecars are consolidated automatically into saved versions named **Committed corrections**, with backups, and then retired.
- **Unadopt this note…** removes Midad identity, managed tags, saved versions, and adopted-note registration while keeping the note content.
- **Clean up orphaned Midad data…** prunes hash and adopted-registry records whose notes no longer exist.
- Saved-version and annotation content is preserved when notes are removed.

### Documentation

- Updated the README and guides for version management, per-work archives, safe removal, re-download/model deletion, correction consolidation, Unadopt, and cleanup.
- Documented the new `.midad-arabic-sources/note-hashes.json` and `version-archives/` state.
