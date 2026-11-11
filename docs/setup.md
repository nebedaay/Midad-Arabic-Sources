# Setup

**Midad Arabic Sources** brings classical Arabic texts into your Obsidian vault and turns them into a linkable, searchable part of your notes. This page covers installing it, the folders it uses and writes to, and the first run.

The plugin is **desktop only**: it runs local Python scripts and reads files outside the vault.

## Requirements

- **Obsidian 1.13 or later.** The settings use Obsidian’s declarative settings API.
- **Python 3** and a few packages, for transcription, translation, and the transliteration engine — see [Dependencies](./dependencies.md).

## Recommended

- A **Gemini API key** in an LLM configuration used to transcribe scanned PDFs and translate and transcribe Arabic text.
- **[Zotero](https://www.zotero.org/)** (optional), for an automated pipeline to transcribe and translate Zotero attachments, and to send imported works to your library — see [Zotero export](./zotero.md).
- **[ScholarWeft](https://community.obsidian.md/plugins/scholar-weft)** or **[ZotLit](https://github.com/aidenlx/zotlit)** to create the `@citekey` Zotero literature notes used by the automatic transcription/translation route. Neither is required for importing texts or for **Transcribe a PDF…**.

## Install

### Community plugins (recommended)

1. Open **Settings → Community plugins** and turn off **Restricted Mode**.
2. Choose **Browse**, search for **Midad Arabic Sources**, then **Install** and **Enable**.

If the listing is not visible yet — the plugin is submitted for review — use BRAT below.

### Alternative: BRAT (latest beta)

1. In Obsidian, enable **Community plugins** (turn off Restricted Mode), then install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT’s settings, add `nebedaay/Midad-Arabic-Sources` to the **Beta plugin list**.
3. Enable **Midad Arabic Sources** in **Settings → Community plugins**. BRAT keeps it up to date from each release.

### Manually

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nebedaay/Midad-Arabic-Sources/releases) and copy them into your plugin folder — `<config folder>/plugins/midad-arabic-sources/`, where `<config folder>` is the one set in **Settings → Files and links → Override config folder** — then enable the plugin. The plugin extracts its Python scripts and import templates into the same folder on load, so nothing else needs copying.

## What ships inside the plugin

Everything the plugin needs is compiled into `main.js` and unpacked into the plugin folder (`<config folder>/plugins/midad-arabic-sources/`) on startup:

- `scripts/` — the Python pipeline, the catalog-driven importer, and the transliteration service.
- `midad-arabic-sources-import-templates/` — the default ETA templates the importer renders notes with.

A plugin update therefore carries the new scripts and templates, which is what lets a template change trigger a re-render. See [Templates](./templates.md).

## Fonts

The plugin **downloads no fonts and embeds none** — Obsidian's review rules forbid external resources, and bundling the Arabic faces would add several megabytes to `main.js`. It asks for the faces it was designed with and falls back through fonts that ship with the operating system, so Arabic, transliteration, and Qur'ānic text always render. For the intended typography, install these (all free):

| Face | Used for | Where |
| --- | --- | --- |
| **Noto Serif** | Latin text and transliteration | Google Fonts (SIL OFL) |
| **Scheherazade New** | Arabic text | Google Fonts (SIL OFL) |
| **Noto Naskh Arabic** | Arabic fallback | Google Fonts (SIL OFL) |
| **Amiri Quran** | Qur'ānic text | Google Fonts (SIL OFL) |
| **KFGQPC Uthmanic Script HAFS** | Qur'ānic text (preferred) | King Fahd Complex (free download) |

The stacks are defined once in `styles.css`:

- `--latin-font`: Noto Serif, then Charter, Georgia, Times New Roman, Liberation Serif.
- `--arabic-font`: Scheherazade New, Noto Naskh Arabic, Amiri, then the system faces (Traditional Arabic, Arabic Typesetting, Simplified Arabic, Sakkal Majalla on Windows; Al Bayan, Geeza Pro, Baghdad on macOS).
- `--quran-font`: KFGQPC Uthmanic Script HAFS, Amiri Quran, then the Arabic stack. The ۝ end-of-āya glyph comes from the same face.

If a face is missing, rendering continues with the next one; nothing breaks. To use a different typeface, override these variables in a CSS snippet:

```css
:root {
  --arabic-font: "My Arabic Face";
  --quran-font: "My Quran Face";
}
```

## First run

1. **Open the settings** (Settings → Community plugins → Midad Arabic Sources). The pages are **General**, **LLM**, **Transliteration**, **Transcription and translation**, **Source import from repository**, **Annotations**, **Zotero**, and **Documentation**. General sets the source folder; LLM holds the reusable model/API-key configurations.
2. Start the transliteration server if you will romanize Arabic: run **Transliteration server…** from the command palette; it shows whether the service is running and gives one **Start** / **Stop** button. Restarting is only needed when the engine code changes — see [Transliteration](./transliteration.md).
3. **Install some texts**: run **Manage text sources…** and pick works from a repository. See [Document import](./document-import.md).
4. **Set the sources folder** under **General** if `Midad Arabic Sources` is not where you want the corpus. Every installed work goes into `<sources folder>/Installed Sources`.
5. **Set the literature notes folder** under **Transcription and translation** if your `@citekey` notes are not in ScholarWeft’s folder. Leave it blank to use ScholarWeft’s own setting; with neither, the pipeline finds an `@citekey` note by name anywhere in the vault.

## The folder layout

The plugin keeps everything under one **sources folder** (`Midad Arabic Sources` for a new install; existing vaults keep their current folder, e.g. `_7 Sources`):

```text
<sources folder>/
  Installed Sources/
    Tafsīr al-Ṭabarī (tafsir_api)/
      Tafsīr al-Ṭabarī (tafsir_api).md  ← the work hub (table of contents)
      001 Al-Fatihah.md                 ← one note per sūra / chapter / root
      002 Al-Baqarah.md
      …
    Quran/                             ← the canonical Qur’ān notes
  Transcriptions/                      ← PDF transcriptions
  Translations/                        ← their translations
  Annotation Notes/                    ← generated per-work annotation notes
  Midad topic - Tafsīr.md              ← a topic MOC
  Midad topic - Ḥadīth.md
  Midad Arabic Sources - Topics.md     ← the topic index
  Midad Arabic Sources - Repositories.md      ← the repository index
  Midad Arabic Sources - My Midad Content.md  ← transcriptions, translations, annotations
```

Existing installations are migrated once automatically on the first launch after the update. Changing **General → Sources folder** asks for confirmation when files exist, then moves the folders and rewrites explicit links in Markdown notes as well as the adopted-annotation registry. The MOCs stay at the source root. The parent **Midad Arabic Sources** note is the existing top-level note (or is created in the source root if missing).

**Resource index.** **Midad Arabic Sources** is the parent note and the distinctive index for everything MAS manages. Its managed block groups the resources into **Topics** (`Midad Arabic Sources - Topics`, the genre/type MOCs), **Repositories** (`Midad Arabic Sources - Repositories`, the repository MOCs), and **My Midad Content** (`Midad Arabic Sources - My Midad Content`, listing My Transcriptions, My Translations, and Annotations). Each entry on the parent note carries the number of sources under it. The same three categories, with cached counts, are what the sidebar’s Navigation tab shows when no Midad note is in context: both are rendered from `.midad-arabic-sources/resource-model.json`, and the parent note is only the fallback if that file is missing. Repository MOCs list their works and are keyed by the acquisition repository (`repo_name`), not by the upstream text provider. A work’s `source:` property records that provider when it differs, so a Qurʾān translation fetched from `quran-api` but digitized from Tanzil appears under **Quran API** while its hub also carries `source: tanzil.net`; when the two are the same, `source:` is omitted. The transcription/translation MOCs are split into works from literature notes and works transcribed/translated directly from PDFs. A transcription or translation is filed under a topic by adding that topic MOC to its `topics:` property.

**Source identity.** MAS-created and adopted notes carry a single `midad-id`; kind, work, and unit are parsed from it. The grammar is `repo/<collection>/<work-id>` for a repository hub, `zotero/<zotero-id>/<transcription|translation>[/<unit>]` or `pdf/<pdf-key>/<transcription|translation>[/<unit>]` for a transcription/translation, and `adopted/<uuid>` for an arbitrary adopted note. A missing trailing unit is the whole work; `vol.<n>` or a slug is a unit. The retired `midad-kind`, `midad-work`, and `midad-unit` properties are read as a fallback for older notes but are no longer written. Repository works are identified at the hub and tracked internally by work, so their individual sūra/chapter/root notes do not need their own ids. YAML values use `/` rather than `:` so Obsidian does not mistake them for URL schemes; the internal model and registry keys keep their `:` form. Zotero literature notes are indexed by their stable `sw-zotero-id`; a transcription or translation associated with a Zotero item keeps the `@<citekey>` filename, while a standalone PDF with no Zotero citekey uses a `mas-` filename. `.midad-arabic-sources/sources.json` is the unified index of every source kind.

- **A work hub** carries the bibliographic properties and links every note in the work.
- **A content note** is one sūra, ḥadīth chapter, book chapter, or dictionary root.
- **A category MOC** lists every installed work of one kind (`Midad topic - Tafsīr`, `Midad topic - Ḥadīth`, …). The plugin rebuilds the list inside a managed region, so entries never duplicate.
- **The parent note** (setting **Sources parent note**) is reused if a note with that name already exists anywhere in the vault; the plugin writes only its own managed region. Top-level source notes carry `[[Midad Arabic Sources]]` in their `midad-up`; individual unit notes link to their hub or MOC instead, so the parent backlink list stays useful.

File names are unique across the whole vault, so a work note carries its work name (`Tafsīr al-Ṭabarī (tafsir_api) - 002 Al-Baqarah`) while its `title:` and the hub’s link text stay clean (`2 Al-Baqarah`). A work whose folder name would collide can carry a **repository qualifier** in parentheses so two editions of the same work sit side by side. See [Document import](./document-import.md).

## Where state lives

The plugin keeps its cache and bookkeeping in `.midad-arabic-sources/` at the vault root:

| Path | Holds |
| --- | --- |
| `cache/text-sources/` | The raw source JSON downloaded from each repository. |
| `source-models/<collection>/<id>.json` | The language-neutral **render model** each work is rendered from. |
| `source-archives/<collection>/<id>.zip` | The archived work: its render model plus the rendered markdown notes. Legacy `.json.gz` model-only archives are still readable. |
| `annotations/<collection>/<id>/` | The sharded annotation store and its derived indexes. |
| `annotations/adopted.json` | The registry of automatically adopted transcriptions, translations, and known notes. |
| `source-imports.json` | The manifest: every work and its status (`installed`, `deleting`, `archived`). |
| `source-catalog.json` | The cached catalogue of available works (7-day TTL). |
| `source-stats.json` | Measured sizes and the per-template render watermarks. |
| `template-history.json` | The content-hash timeline that decides whether a template change affects notes. |
| `note-hashes.json` | Managed-region baseline hashes and saved-version hashes. See [Versions, removal, and cleanup](./versions.md). |
| `version-archives/<work>-<hash>.zip` | Per-work saved-version metadata and snapshot notes. |
| `archive/` | Archived transcription batches. |
| `jobs/` | The persisted state of running pipeline jobs. |

Deleting a work from the plugin removes its cached model and generated notes; notes with user-written text outside the managed region are kept by default, and a full-deletion option is offered. Its source JSON stays cached, so re-installing is quick. The model can also be deleted separately while keeping notes and saved versions. Archiving instead writes a zip containing the model and the rendered markdown, removes the live notes, and keeps the annotations; restore unzips the notes directly when the template hashes still match, and otherwise re-renders from the model without downloading.

## Updating and state

Restart Obsidian after a plugin update — the plugin loads `main.js` only at startup. On the next run it unpacks the new scripts and templates, re-measures what changed, and re-renders only the notes whose templates moved. Your edits are preserved: generated content sits inside a managed region, and only template-declared frontmatter properties are reconciled. See [Templates](./templates.md).

If a source changes upstream, **Check for source updates** asks each repository whether the text moved and re-downloads only what did. See [Document import](./document-import.md).
