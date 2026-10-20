# Setup

**Midad Arabic Sources** brings classical Arabic texts into your Obsidian vault and turns them into a linkable, searchable part of your notes. This page covers installing it, the folders it uses and writes to, and the first run.

The plugin is **desktop only**: it runs local Python scripts and reads files outside the vault.

## Requirements

- **Obsidian 1.13 or later.** The settings use Obsidian’s declarative settings API.
- **Python 3** and a few packages, for transcription, translation, and the transliteration engine — see [Dependencies](./dependencies.md).
- A **Gemini API key**, if you want to transcribe or translate scanned PDFs.
- **Zotero** (optional), if you want to send imported works to your library — see [Zotero export](./zotero.md).

## Install

The plugin is not yet in the community directory.

### Via BRAT

1. In Obsidian, enable **Community plugins** (turn off Restricted Mode), then install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT’s settings, add `nebedaay/Midad-Arabic-Sources` to the **Beta plugin list**.
3. Enable **Midad Arabic Sources** in **Settings → Community plugins**. BRAT keeps it up to date from each release.

### Manually

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nebedaay/Midad-Arabic-Sources/releases) and copy them into `.obsidian/plugins/midad-arabic-sources/`, then enable the plugin. The plugin extracts its Python scripts and import templates into the same folder on load, so nothing else needs copying.

## What ships inside the plugin

Everything the plugin needs is compiled into `main.js` and unpacked into `.obsidian/plugins/midad-arabic-sources/` on startup:

- `scripts/` — the Python pipeline, the catalog-driven importer, and the transliteration service.
- `midad-arabic-sources-import-templates/` — the default ETA templates the importer renders notes with.

A plugin update therefore carries the new scripts and templates, which is what lets a template change trigger a re-render. See [Templates](./templates.md).

## First run

1. **Open the settings** (Settings → Community plugins → Midad Arabic Sources) and skim the five sections: Transliteration, Transcription and translation, Document import, Zotero, and Documentation. Each points to its guide here.
2. Start the transliteration server if you will romanize Arabic: run **Transliteration server…** from the command palette; it shows whether the service is running and gives one **Start** / **Stop** button. Restarting is only needed when the engine code changes — see [Transliteration](./transliteration.md).
3. **Install some texts**: run **Manage text sources…** and pick works from a repository. See [Document import](./document-import.md).
4. **Set your import destination** under **Document import** if `_7 Sources` is not where you want the corpus. Every work gets its own subfolder there.

## The folder layout

Notes the plugin generates live under the **import destination** (`_7 Sources` by default), one folder per work:

```text
_7 Sources/
  Tafsīr al-Ṭabarī (tafsir_api)/
    Tafsīr al-Ṭabarī (tafsir_api).md    ← the work hub (table of contents)
    001 Al-Fatihah.md                   ← one note per sūra / chapter / root
    002 Al-Baqarah.md
    …
  Tafsīr Sources.md                     ← a category MOC
  Ḥadīth Sources.md
  Sources.md                            ← the parent note the MOCs point up to
```

- **A work hub** carries the bibliographic properties and links every note in the work.
- **A content note** is one sūra, ḥadīth chapter, book chapter, or dictionary root.
- **A category MOC** lists every installed work of one kind (Tafsīr Sources, Ḥadīth Sources, …). The plugin rebuilds the list inside a managed region, so entries never duplicate.
- **The parent note** (setting **Sources parent note**) is reused if a note with that name already exists anywhere in the vault; the plugin writes only its own managed region. Every generated page carries `[[Midad Arabic Sources]]` in its `up`.

File names are unique across the whole vault, so a work note carries its work name (`Tafsīr al-Ṭabarī (tafsir_api) - 002 Al-Baqarah`) while its `title:` and the hub’s link text stay clean (`2 Al-Baqarah`). A work whose folder name would collide can carry a **repository qualifier** in parentheses so two editions of the same work sit side by side. See [Document import](./document-import.md).

## Where state lives

The plugin keeps its cache and bookkeeping in `.midad-arabic-sources/` at the vault root:

| Path | Holds |
| --- | --- |
| `cache/text-sources/` | The raw source JSON downloaded from each repository. |
| `source-models/<collection>/<id>.json` | The language-neutral **render model** each work is rendered from. |
| `source-imports.json` | The manifest: every installed work and its status. |
| `source-catalog.json` | The cached catalogue of available works (7-day TTL). |
| `source-stats.json` | Measured sizes and the per-template render watermarks. |
| `template-history.json` | The content-hash timeline that decides whether a template change affects notes. |
| `archive/` | Archived transcription batches. |
| `jobs/` | The persisted state of running pipeline jobs. |

Deleting a work from the plugin removes its cached model and its notes (a hard delete, not a trash move); its source JSON stays cached, so re-installing is quick.

## Updating and state

Restart Obsidian after a plugin update — the plugin loads `main.js` only at startup. On the next run it unpacks the new scripts and templates, re-measures what changed, and re-renders only the notes whose templates moved. Your edits are preserved: generated content sits inside a managed region, and only template-declared frontmatter properties are reconciled. See [Templates](./templates.md).

If a source changes upstream, **Check for source updates** asks each repository whether the text moved and re-downloads only what did. See [Document import](./document-import.md).
