# 0.2.4

Code-quality and documentation sync release.

### Lint and review cleanup

- Reduced lint output from 36 warnings to one deliberate `JsonObject` `any` in the render-model type.
- Fixed floating promises, unnecessary assertions, unused imports, unsafe JSON assignments, and sentence-case warnings.
- Switched version-note deletion to `FileManager.trashFile()` so the user’s file-deletion preference is respected.
- Corrected the annotation-sidebar version notice and version-manager labels to sentence case.

### Documentation

- Synced the latest vault `Midad Docs` README and Zotero guide into the repository.
- Kept `Midad Docs/` as the documentation source of truth; local builds sync it automatically.

The remaining `JsonObject` `any` is intentional: the acquisition render model is template-driven and loosely typed.
