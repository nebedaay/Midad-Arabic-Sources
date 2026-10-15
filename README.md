# Midad Arabic Sources

**Midad Arabic Sources** brings classical Arabic texts into your Obsidian vault and turns them into a linkable, searchable, annotated part of your notes. It removes the manual labour between *there is an Arabic text I want to study* and *it is in my vault*: it locates and imports born-digital texts, transcribes scanned PDFs, transliterates Arabic, and keeps every generated note current as templates and upstream sources change.

The plugin was built for research on Islam and Sufism — Qurʾān commentaries, ḥadīth, the Qurʾān in its riwāyāt, and the classical dictionaries — but the importer is catalog-driven, so more repositories can be wired in over time.

> [!note]
> This plugin is **desktop only**. It runs local Python scripts and reads files outside the vault.

## What it does

### Transliteration

The rule-based/LLM romanizer talks to a resident Python service (CAMeL), so Obsidian and Zotero do not reload the model on every call.

- **Transliterate selection to clipboard** — romanize the selection (or current line) to the clipboard.
- **Transliterate note to new note** — romanize a whole note or selection into a sibling note.
- **Check transliteration server** — report loaded engines and available LLM providers.
- **Start transliteration server** / **Stop transliteration server** — launch or stop `transliterate-server.py` without the CLI.

Settings cover the server URL and script, the engine (`bert` / `mle` / `none`), sun-letter assimilation, case endings, name mode, final dotless yāʾ, and an LLM provider (Gemini / DeepSeek) with an optional per-request key.

### Transcription and translation (scanned PDFs)

A Gemini pipeline turns a literature item’s PDFs into page-separated Arabic markdown (and translations), with local post-processing for Qur’ān quotes, poetry callouts, footnotes, and tashkīl. Run it from a `@citekey` note.

- **Transcribe this item's PDF file(s)** — burst to page PDFs, OCR via Gemini batch mode, post-process.
- **Translate this item's transcription(s)** — translate an existing transcription.
- **Reprocess from archive…** — re-run post-processing from an archived batch without resubmitting.
- **Check transcription pipeline**, **Show pipeline status**, **Open last pipeline log** — status and diagnostics (non-modal corner panel).

### Text sources (born-digital corpora)

A catalog-driven importer pulls classical texts from public repositories into your vault, one note per sūra or chapter, with full frontmatter and links back to the Qur’ān text.

- **Manage text sources…** — a two-pane dialogue (install/uninstall, or send references to Zotero) with a genre sidebar, a repository list, and one clickable row per work.
- **Copy import templates to vault** — copy the editable ETA templates into your vault.
- **Re-render imported sources** — regenerate every note from its cached model.
- **Check imported sources** — find works whose notes or cached model are missing.
- **Check for source updates** — ask the repositories whether a text changed upstream.

Collections currently wired in: Qurʾān commentaries (tafsīr) from `spa5k/tafsir_api` and the Qurʾānic Universal Library; Qurʾān translations from `fawazahmed0/quran-api`; ḥadīth collections from `AhmedBaset/hadith-json`; the Qurʾān in its riwāyāt from `risan/quran-json`; and two dictionaries, Hans Wehr’s *Dictionary of Modern Written Arabic* and Lane’s *An Arabic-English Lexicon* (both read from their SQLite editions, one note per root). Imports are cached, and re-rendering never overwrites your edits: generated content sits in a managed region and only template-declared frontmatter properties are reconciled.

### Zotero export

Installed works can be sent to Zotero as `book` items, each tagged **Midad Arabic Sources** and filed in a collection of that name. Settings choose the method — **Local API** (the Zotero running on `:23119`), **Web API** (key + library id), or **CSL-JSON** (writes a file for a manual File → Import). Already-exported items are updated in place rather than duplicated.

## Install

The plugin is not yet in the community directory. Install it with **BRAT**, or by hand.

### Via BRAT

1. Disable Restricted Mode, then install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Community Plugins list.
2. In BRAT’s settings, add `nebedaay/Midad-Arabic-Sources` to the **Beta plugin list**.
3. Enable **Midad Arabic Sources** in Community Plugins. BRAT keeps it updated.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nebedaay/Midad-Arabic-Sources/releases) and copy them into `.obsidian/plugins/midad-arabic-sources/` in your vault, then enable the plugin in **Settings → Community plugins**.

## Requirements

- **Python 3** with `PyMuPDF` (`fitz`), `requests`, and `google-genai`. The plugin finds a usable interpreter automatically and lets you pin one in settings.
- A **Gemini API key** for transcription, translation, and optional LLM romanization. Set it in the plugin settings (it is passed to the pipeline) or in your shell environment.
- **Zotero** (optional) for sending imported works to your library.
- The transliteration service downloads its model on first use and needs network access to do so.

## Network use and file access

Core importing and rendering use only the repositories you import from. The following features contact services; nothing is sent anywhere else, and the plugin collects **no telemetry**.

| Feature | Contacts | Why |
| --- | --- | --- |
| Text source import | The public repositories listed above (GitHub, `qul.tarteel.ai`) | Downloads the source texts you choose to import. |
| Transliteration | `transliterate-server.py` on `127.0.0.1` | Romanizes Arabic. Optionally calls Gemini or DeepSeek when LLM mode is on. |
| Transcription / translation | The Gemini API | OCRs and translates scanned PDFs you submit. |
| Zotero export | Your local Zotero (`127.0.0.1:23119`) or `api.zotero.org` | Reads and writes the bibliographic items you export. |
| Fonts | `cdn.jsdelivr.net` (Fontsource) | Loads the Arabic and Latin typefaces the generated notes expect. |

**Files outside your vault:** the transcription pipeline runs external programs and reads and writes the source PDFs and output files you choose, including absolute paths. This is required to OCR and translate documents.

## How it works

The importer is **acquisition only**: it downloads a work’s source, normalises it into a language-neutral *render model*, and renders that model into notes with **ETA templates** — the same template language used by [ScholarWeft](https://github.com/nebedaay/ScholarWeft). Regenerating a note never overwrites your edits. A content-hash timeline decides whether a template change affects notes, and a two-stage check asks each repository whether a text changed upstream.

The plugin ships its Python scripts, ETA templates, and CSS under `midad-arabic-sources-import-templates/` and `scripts/`, so it is self-contained.

## Building from source

```bash
npm install
npm run check-types   # tsc --noemit
npm run lint          # eslint (Obsidian community-plugin rules)
npm run build         # esbuild → main.js
```

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/midad-arabic-sources/`, or run `npm run deploy` from inside a vault. Restart Obsidian after every build — the plugin loads `main.js` only at startup.

## Credits

Midad Arabic Sources’ ETA templating, managed-region merge, and note conventions follow **[ScholarWeft](https://github.com/nebedaay/ScholarWeft)**, which pioneered them. The importer draws on the public corpora of [spa5k/tafsir_api](https://github.com/spa5k/tafsir_api), the [Qurʾānic Universal Library](https://qul.tarteel.ai/), [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api), [AhmedBaset/hadith-json](https://github.com/AhmedBaset/hadith-json), [risan/quran-json](https://github.com/risan/quran-json), and GibreelAbdullah’s [Hans Wehr](https://github.com/GibreelAbdullah/HansWehrDictionary) and [Lane](https://github.com/GibreelAbdullah/LaneLexicon) dictionary editions. Transliteration uses [CAMeL Tools](https://github.com/CAMeL-Lab/camel_tools).

## License

[GPL-3.0-or-later](./LICENSE).
