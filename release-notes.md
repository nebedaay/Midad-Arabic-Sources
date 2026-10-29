# 0.1.2

**Midad Arabic Sources** is now submitted for the Obsidian community directory. Install it from **Settings → Community plugins → Browse** once the listing is live; **BRAT** remains the beta channel while the submission is reviewed.

### Install

- **Community plugins (recommended):** Settings → Community plugins → Browse → search **Midad Arabic Sources** → Install → Enable.
- **BRAT (latest beta):** add `nebedaay/Midad-Arabic-Sources` to BRAT’s beta plugin list.
- **Manual:** download `main.js`, `manifest.json`, and `styles.css` from this release into `<config folder>/plugins/midad-arabic-sources/`.

The plugin is desktop-only and requires Obsidian 1.13 or later. Python 3 is needed for importing, transcription, translation, and transliteration; CAMeL Tools and a Gemini key are needed only for those features. The automatic transcription/translation route expects a `@citekey` Zotero literature note created by **ScholarWeft** or **ZotLit**; **Transcribe a PDF…** works without one.

### Qur'ān presentation

- Qur'ān notes now use two explicit classes, **`quran-ar`** (Arabic, RTL) and **`quran-en`** (translations, LTR). Direction, face, size, and leading no longer leak between them.
- English translations have their own template and layout: the emblem is on the left, the Arabic reference sits under it without the extra heading or “ : ”, and the translation runs beside it at normal English size. Single-line verses reserve just enough height for the link.
- The gilded fill is shared by Arabic verses, English translations, and `.quran-quote` spans; only RTL quotes get the larger Qur'ān size and leading.
- The verse marker is one fixed box per verse, with the number and ۝ emblem flex-centred. `--quran-number-size`, `--quran-ar-marker-shift`, `--quran-en-marker-shift`, and `--quran-number-shift` control size and vertical alignment. Heading fold chevrons and aliased-link indicators are suppressed in Qur'ān notes.
- Fonts are **local-only**, with per-platform fallback chains (Noto Serif, Scheherazade New / Noto Naskh Arabic, KFGQPC HAFS / Amiri Quran). No font is downloaded.

### Sidebar

- The Midad sidebar follows the active note: a Midad note selects its tab; any other note restores the last non-Midad right-sidebar tab — remembered across plugin reloads — or another open right tab.
- The right split is collapsed only when this plugin expanded it and there is no other tab. An already-open sidebar is never collapsed, and a manually opened Midad sidebar stays until the next Midad note.
- Switching tabs no longer steals editor focus, and same-tab note navigation (`file-open`) is handled as well as tab changes.

### Sources and templates

- `midad-source` and `midad-key` are retired; a note’s source is derived from `midad-id` / `midad-kind` / `midad-work`, and a new `remove` merge strategy deletes the old properties on re-render.
- Qur'ān translations use a new `translation-note.eta.md`; `source-note.eta.md` remains the tafsīr template, so editing one no longer re-renders the other.
- Template auto-update is fixed: the translation template is hashed and attributed to the correct unit kind (`surah`), so a reload applies changes without a manual re-render. Registry/MOC rebuilds and the adopted-note scan were moved off the startup hot path.

### Review and maintenance

- Cleared the directory review’s high-severity findings (remote font URLs) and its `!important`, `:has()`, hard-coded config-folder, and `builtin-modules` warnings; the remaining warnings are the deliberate `JsonObject` `any` and the desktop pipeline’s filesystem/shell access.
- Annotation fixes carried in this release include comment/callout colour and radius treatment, block IDs, and sidebar navigation/index refresh.
