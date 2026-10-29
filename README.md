# Midad Arabic Sources

**Midad Arabic Sources** brings classical Arabic texts into your Obsidian vault and turns them into a linkable, searchable, annotated part of your notes. It removes the manual labour between *there is an Arabic text I want to study* and *it is integrated into my vault*: it **locates and imports** already digitized texts, **transcribes** (OCRs) scanned PDFs, translates those transcriptions into English, transliterates Arabic passages for integration into English writing, and keeps every generated note current as templates and upstream sources change.

The plugin was built for research on Islam and Arabic — Qurʾān commentaries, ḥadīth, the Qurʾān in its riwāyāt, and the classical dictionaries — but the importer is catalog-driven, so more repositories on any topic can be wired in over time.

Midad is optimized for integration with [Zotero](https://www.zotero.org/) using the [ScholarWeft](https://github.com/nebedaay/ScholarWeft) plugin, although these two are not required.

> [!note]
> This plugin is **desktop only**. It runs local Python scripts and reads files outside the vault.

## Documentation

The full guides are in [`docs/`](./docs/); this README is a summary. Every page is also bundled into the plugin and readable in-app with the command **Open documentation** (or from **Settings → Midad Arabic Sources → Documentation**).

- [Setup](./docs/setup.md) — install, first run, the folder layout, and where state lives.
- [Dependencies](./docs/dependencies.md) — Python, CAMeL Tools, a Gemini key, and the resident transliteration server.
- [Transliteration](./docs/transliteration.md) — commands, engines, the romanization options, the lexicon, and LLM romanization.
- [Transcription](./docs/transcription.md) — the Gemini OCR pipeline, post-processing, status, and reprocessing.
- [Translation](./docs/translation.md) — translating a finished transcription.
- [Document import](./docs/document-import.md) — collections, the Manage text sources dialogue, naming, and updates.
- [Templates](./docs/templates.md) — the ETA templates and the render-model variable reference.
- [Zotero](./docs/zotero.md) — Local / Web / CSL-JSON export, update-in-place, and auto-sync.
- [Midad Arabic Transliteration](./docs/midad-arabic-transliteration.md) — the optional Zotero 7 companion that romanizes an item's Arabic fields through the same server.
- [Commands](./docs/commands.md) — every command, grouped by function.
- [Troubleshooting](./docs/troubleshooting.md) — the common errors and how to fix them.

## What it does

### Transliteration

The rule-based/LLM romanizer talks to a resident Python service (CAMeL), so Obsidian and Zotero do not reload the model on every call.

- **Transliterate selection to clipboard** — romanize the selection (or current line) to the clipboard.
- **Transliterate note to new note** — romanize a whole note or selection into a sibling note.
- **Check transliteration server** — report loaded engines and available LLM providers.
- **Start transliteration server** / **Stop transliteration server** — launch or stop the service without a terminal.

Settings cover the server URL and script, the engine (`bert` / `mle` / `none`), sun-letter assimilation, case endings, name mode, final dotless yāʾ, and the LLM configuration assigned to transliteration. See [Transliteration](./docs/transliteration.md).

### Transcription and translation (scanned PDFs)

A Gemini pipeline turns a literature item’s PDFs into page-separated Arabic markdown (and translations), with local post-processing for Qurʾān quotes, poetry callouts, footnotes, and tashkīl. The Zotero route assumes a `@citekey` literature note with the item’s `zotero-key` and attachments, normally created by **[ScholarWeft](https://github.com/nebedaay/ScholarWeft)** or **[ZotLit](https://github.com/aidenlx/zotlit)**; Midad does not create those notes. Without one, use **Transcribe a PDF…**.

- **Transcribe this item’s PDF file(s)** — burst to page PDFs, OCR via Gemini batch mode, post-process.
- **Transcribe a PDF…** — pick any PDF on disk; Gemini guesses the title and author from the title page, and a verification dialog saves them into the new transcription’s bibliography.
- **Translate this item’s transcription(s)** — translate an existing transcription.
- **Prompt dropdown** in the transcription and translation dialogs — choose a named prompt, or edit, copy, and delete prompts for texts the built-in one does not suit.
- **Reprocess from archive…** — re-run post-processing from an archived batch without resubmitting.
- **Check transcription pipeline**, **Show pipeline status**, **Open last pipeline log** — status and diagnostics (non-modal corner panel).

See [Transcription](./docs/transcription.md) and [Translation](./docs/translation.md).

### Text sources (born-digital corpora)

A catalog-driven importer pulls classical texts from public repositories into your vault, one note per sūra, chapter, or dictionary root, with full frontmatter and links back to the Qurʾān text.

- **Manage text sources…** — a two-pane dialogue (install/uninstall, or send references to Zotero) with a genre sidebar, a repository list, and one clickable row per work.
- **Copy import templates to vault** — copy the editable ETA templates into your vault.
- **Re-render imported sources** — regenerate every note from its cached model.
- **Check imported sources** — find works whose notes or cached model are missing.
- **Check for source updates** — ask the repositories whether a text changed upstream.
- **Archive this source…** — compress a work's model, remove its notes, and preserve its annotations; restore it from Manage text sources.

Collections currently wired in: Qurʾān commentaries (tafsīr) from `spa5k/tafsir_api` and the Qurʾānic Universal Library; Qurʾān translations from `fawazahmed0/quran-api`; ḥadīth collections from `AhmedBaset/hadith-json`; the Qurʾān in its riwāyāt from `risan/quran-json`; two dictionaries, Hans Wehr’s *Dictionary of Modern Written Arabic* and Lane’s *An Arabic-English Lexicon* (both read from their SQLite editions, one note per root); and classical books from [Turath.io](https://app.turath.io) (one note per TOC chapter, a volume index per volume, two category MOCs — `Turath` and the work type). Folders and hub files use `Author - Title (repository)` (for example `Aḥmad b. Ḥanbal - Musnad Aḥmad (hadith-json)`); the dictionaries and Qur'ān editions keep their established titles. Imports are cached, and re-rendering never overwrites your edits: generated content sits in a managed region and only template-declared frontmatter properties are reconciled. See [Document import](./docs/document-import.md) and [Templates](./docs/templates.md).

### Annotations

Select text inside an imported source to annotate it without changing the generated note. Annotations are stored separately, painted in Live Preview and Reading view, shown through margin icons and a comment tooltip, and listed in the unified Midad sidebar. The sidebar has a Navigation tab for every note — `midad-up` parents, siblings, sections, and child notes — and, on annotatable notes, an Annotations tab with click-to-scroll cards. In Live Preview, the active annotation shows oval resize handles and links are treated as atomic selections. Each work gets a generated annotation note and the shared **Source Annotations** MOC; the note uses a light blue annotation callout; comments come first on a gradient inset, and each quote follows as highlighted text on a white inset page. Re-renders relocate quotes by exact text and context; unresolved quotes stay in the note's **Unanchored** section and can be recovered from a new selection. **Copy source with annotations** copies the source plus a colour-callout annotation section. Archiving a source keeps its annotations. Known transcriptions and translations are adopted automatically; **Adopt note for annotations** covers other Markdown notes, and multi-volume series share one annotation note.

### Zotero export

Installed works can be sent to Zotero as `book` items, each tagged **Midad Arabic Sources** and filed in a collection of that name. Settings choose the method — **Local API** (the Zotero running on `:23119`), **Web API** (key + library id), or **CSL-JSON** (writes a file for a manual File → Import). Already-exported items are updated in place rather than duplicated. See [Zotero](./docs/zotero.md).

## Requirements

- **Obsidian 1.13** or later.
- **Python 3** with `PyMuPDF` (`fitz`), `requests`, and `google-genai`. The plugin finds a usable interpreter automatically and lets you pin one in settings.
- **CAMeL Tools** for the transliteration engine, with its model data.
- A **Gemini API key** in the LLM configuration assigned to transcription and translation, plus optional LLM configurations for romanization.
- **Zotero** (optional) for sending imported works to your library.

See [Dependencies](./docs/dependencies.md) for the exact install lines.

## Fonts

The plugin **downloads no fonts** and embeds none. It requests the faces it was designed with, then falls back through fonts that ship with macOS, Windows, and Linux, so Arabic, transliteration, and Qur'ānic text always render. For the intended typography, install these (all free):

| Face | Used for | Licence |
| --- | --- | --- |
| **Noto Serif** | Latin text and transliteration | SIL OFL |
| **Scheherazade New** | Arabic text | SIL OFL |
| **Noto Naskh Arabic** | Arabic fallback | SIL OFL |
| **Amiri Quran** | Qur'ānic text | SIL OFL |
| **KFGQPC Uthmanic Script HAFS** | Qur'ānic text (preferred) | Free from the King Fahd Complex |

The stacks live in `styles.css` as `--latin-font`, `--arabic-font`, and `--quran-font`; override those variables in a CSS snippet to use different faces. The fallback chains are documented in [Setup](./docs/setup.md#fonts).

## Install

### Community plugins (recommended)

1. Open **Settings → Community plugins** and turn off **Restricted Mode**.
2. Choose **Browse**, search for **Midad Arabic Sources**, then **Install** and **Enable**.

If the listing is not visible yet — the plugin is submitted for review — use BRAT below.

### BRAT (alternative, latest beta)

1. Disable Restricted Mode, then install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Community Plugins list.
2. In BRAT’s settings, add `nebedaay/Midad-Arabic-Sources` to the **Beta plugin list**.
3. Enable **Midad Arabic Sources** in Community Plugins. BRAT keeps it updated.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nebedaay/Midad-Arabic-Sources/releases) and copy them into your plugin folder (`<config folder>/plugins/midad-arabic-sources/`; see **Settings → Files and links → Override config folder**) and then enable the plugin in **Settings → Community plugins**. The plugin extracts its Python scripts and import templates into that folder on load.

## Network use and file access

Core importing and rendering use only the repositories you import from. The following features contact services; nothing is sent anywhere else, and the plugin collects **no telemetry**.

| Feature | Contacts | Why |
| --- | --- | --- |
| Text source import | The public repositories listed above (GitHub, `qul.tarteel.ai`, `turath.io`) | Downloads the source texts you choose to import. |
| Transliteration | `transliterate-server.py` on `127.0.0.1` | Romanizes Arabic. Optionally calls Gemini, DeepSeek, or an OpenAI-compatible endpoint when LLM mode is on. |
| Transcription / translation | The Gemini API | OCRs and translates scanned PDFs you submit. |
| Zotero export | Your local Zotero (`127.0.0.1:23119`) or `api.zotero.org` | Reads and writes the bibliographic items you export. |
| Midad Arabic Transliteration (optional Zotero companion) | The local transliteration server (`127.0.0.1:8756`) | Romanizes the Arabic fields of a Zotero item. |

Fonts are **not** fetched: the plugin uses locally installed faces with system fallbacks (see [Fonts](#fonts)).

**Files outside your vault:** the transcription pipeline runs external programs and reads and writes the source PDFs and output files you choose, including absolute paths. This is required to OCR and translate documents.

## How it works

The importer is **acquisition only**: it downloads a work’s source, normalises it into a language-neutral *render model*, and renders that model into notes with **ETA templates** — the same template language used by [ScholarWeft](https://github.com/nebedaay/ScholarWeft). Regenerating a note never overwrites your edits. A content-hash timeline decides whether a template change affects notes, and a two-stage check asks each repository whether a text changed upstream. The plugin ships its Python scripts, ETA templates, and CSS inside `main.js`, so a release is self-contained.

## Building from source

```bash
npm install
npm run check-types   # tsc --noemit
npm run lint          # eslint (Obsidian community-plugin rules)
npm run build         # esbuild → main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` into your plugin folder (`<config folder>/plugins/midad-arabic-sources/`), or run `npm run deploy` from inside a vault. Restart Obsidian after every build — the plugin loads `main.js` only at startup.

## Credits

Midad Arabic Sources’ ETA templating, managed-region merge, and note conventions follow **[ScholarWeft](https://github.com/nebedaay/ScholarWeft)**, which pioneered them. The importer draws on the public corpora of [spa5k/tafsir_api](https://github.com/spa5k/tafsir_api), the [Qurʾānic Universal Library](https://qul.tarteel.ai/), [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api), [AhmedBaset/hadith-json](https://github.com/AhmedBaset/hadith-json), [risan/quran-json](https://github.com/risan/quran-json), [Turath.io](https://app.turath.io), and GibreelAbdullah’s [Hans Wehr](https://github.com/GibreelAbdullah/HansWehrDictionary) and [Lane](https://github.com/GibreelAbdullah/LaneLexicon) dictionary editions. Transliteration uses [CAMeL Tools](https://github.com/CAMeL-Lab/camel_tools).

## License

[GPL-3.0-or-later](./LICENSE).
