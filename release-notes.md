# 0.2.5

Community-scorecard cleanup.

### CSS review warnings

- Removed `!important` from the poetry, Qurʾān, footnote, TOC, and version-manager rules, using more specific selectors where needed.
- Replaced the flagged `column-gap` with the `gap` shorthand.
- Removed a duplicate `margin-block` declaration.
- Replaced the flagged `text-indent` hanging indent with padding/margin spacing.

### Code review warnings from 0.2.4

- Floating promises, unnecessary assertions, unused imports, unsafe JSON assignment, and file-deletion preference warnings are fixed.
- Lint now reports one deliberate warning: the template-driven `JsonObject` uses `any`.

### Remaining disclosures

These are intentional and documented in the README rather than code warnings:

- Direct filesystem access for PDFs and pipeline files outside the vault.
- Shell execution for the local Python pipeline.
- Clipboard access for transliteration.
- Vault enumeration for indexing.
- Network access for imports, Zotero, and LLM services.
- GPL-3.0 copyleft licensing.
