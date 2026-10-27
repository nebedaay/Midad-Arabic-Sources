# Document import (text sources)

The importer pulls born-digital Arabic texts from public repositories into your vault, one note per sūra, chapter, or dictionary root, with full frontmatter and links back to the Qurʾān text. It is catalog-driven, so more repositories and genres can be wired in over time.

## Manage text sources

**Manage text sources…** opens a two-pane dialogue with two tabs.

Under the tabs sit the collection description and a top bar: a **Show** filter (All / Installed / Not installed / Archived / Annotated), a **filter box**, a **language** select sorted by language name, a ↻ reload button, and **Add by URL…**. On the left are **Kinds of sources** (toggle buttons, one per genre — Tafsīr, Ḥadīth, Fiqh, Uṣūl al-Fiqh, Doctrine (ʿaqīda), Tārīkh, Biography (rijāl), Language (lugha), Lexicography, Grammar (naḥw and ṣarf), Rhetoric, Adab, Dictionaries, and more; none selected means all) and **Repositories** (a selectable list). A work can sit in more than one kind (e.g. a ḥadīth commentary is both Ḥadīth and Ḥadīth commentary). The right pane lists one clickable row per work — Language, Author, Title (with its subtitle beneath), Kind, Repository, Size, State — and the row is highlighted when selected, with no checkboxes. A row with annotations carries a highlighter icon and count. Archiving turns the row a muted gray and labels it **Archiving** while the progress notice runs; once complete it reads **Archived**. Right-clicking offers annotation deletion and, for installed works, **Archive source…**; archived rows offer **Restore from archive** and **Remove archived source…** (which deletes the compressed model but keeps annotations). The language filter is sorted by display name, so English appears before German. The modal is capped to the window and the footer stays reachable; the table scrolls inside its pane when the window is narrow.

- In the **install/uninstall** tab, installed works start selected; deselecting one marks it for removal. Archived works start unselected; selecting one and applying restores it from its compressed model. There is no Select All, because there are far too many works to act on at once.
- In the **Send references to Zotero** tab, a single **Select All/None** toggle selects, then clears, the visible installed works. See [Zotero export](./zotero.md).

The catalogue of available works is cached: per session and on disk (`.midad-arabic-sources/source-catalog.json`, 7 days). Opening the dialogue serves the cache immediately and refreshes it in the background when it is stale; the ↻ button forces a fresh listing.

## Adding a work by URL

Turath has far more books than any catalogue can list. **Add by URL** (a tab in the manage dialog, or the **Add Turath work by URL…** command) takes a link such as `https://app.turath.io/book/95864` (or just the numeric id), reads the book's metadata from Turath's API, and offers a **provisional romanization** in two editable fields — **Title (romanized)** and **Author (romanized)**. The title is sentence-cased for a non-English work (first word and proper nouns capitalised); review it before adding. **Add to list** stores the entry in `.midad-arabic-sources/turath-custom-works.json`; the tab lists everything you have added, with a **Remove** button, and keeps your current selections while you are in it. The entry stays in the Add by URL tab with **Install** and **Remove from list** buttons. **Install** runs the normal acquisition and render with corner notices; switching to the main tab refreshes the source list. **Remove from list** drops a built-in override but leaves the built-in work installed; for a custom-only work that is installed, it confirms and uninstalls the source, deleting its generated notes and keeping annotations. Adding a work that already exists asks whether to override the existing catalogue entry. A custom entry overrides the built-in title, author, genres, and subtitle for the same Turath id. Added works then appear in the catalogue like any other — choose their kinds, install them, re-render them. Search matches the title, Arabic title, aliases, author, subtitle, id, and repository. The JSON entry carries the id, Roman title, Arabic title, author, type, genres, and URL; edit it directly if you want a different title or kind.

## Collections

- **Qurʾān commentaries (tafsīr)** — `spa5k/tafsir_api` (a mirror of quran.com / altafsir.com): about 60 Arabic and 13 English commentaries (al-Jalālayn, al-Ṭabarī, al-Qurṭubī, al-Baghawī, Ibn Kathīr, al-Saʿdī, al-Muyassar, al-Kashshāf, and more).
- **Qurʾān commentaries (QUL)** — the Qurʾānic Universal Library (`qul.tarteel.ai`): 111 further tafsīrs across Arabic and 30+ languages. Keyless, fetched one sūra at a time; shares the **Tafsīr Sources** MOC with the spa5k collection.
- **Qurʾān translations** — `fawazahmed0/quran-api`: 50+ English translations.
- **Ḥadīth collections** — `AhmedBaset/hadith-json`: 17 collections (Bukhārī, Muslim, Abū Dāwūd, Tirmidhī, Nasāʾī, Ibn Mājah, Mālik, Aḥmad, and the forties), Arabic and English.
- **Qurʾān texts (riwāyāt)** — `risan/quran-json`: Warsh, Qālūn, al-Dūrī, Shuʿbah, al-Sūsī, plus canonical Ḥafṣ.
- **Dictionaries** — Hans Wehr’s *Dictionary of Modern Written Arabic* and Lane’s *An Arabic-English Lexicon*, both read from their SQLite editions (one note per root).
- **Classical texts (Turath.io)** — the public API covering ~8,500 books across fiqh, uṣūl, ʿaqīda, ḥadīth commentary, tārīkh, adab, and language. One note per table-of-contents heading, with the source’s pages preserved as `#### p. N` markers.

## Commands

- **Manage text sources…** — install, uninstall, or send to Zotero.
- **Copy import templates to vault** — copy the editable ETA templates into your vault so you can change how notes render. See [Templates](./templates.md).
- **Re-render imported sources** — regenerate every note from its cached model; a prompt asks first when a template change is involved.
- **Re-render this source** — the same for one work, from its note or its right-click menu.
- **Apply template changes to imported sources** — apply any detected template change on demand (the plugin also polls for changes when auto-update is on).
- **Re-download imported sources (rebuild models)** — fetch the source JSON again and rebuild every model, for when a repository changes its format.
- **Migrate imported sources to the current naming scheme** — one-off; moves works that predate the repository-qualifier convention to the current folder and file names.
- **Check imported sources** — find works whose notes or cached model are missing and offer to restore them.
- **Check for source updates** — ask each repository whether a text changed upstream (also on the **Check repositories every … days** cadence, default 7).
- **Archive this source…** — compress the work's model to `.midad-arabic-sources/source-archives/<collection>/<id>.json.gz`, remove its notes, and keep its annotations and a restorable manifest entry.
- **Annotate the selected text**, **Edit annotation**, **Delete annotation**, **Re-anchor orphaned annotation…**, **Open Midad sidebar**, and **Copy source with annotations** — the annotation commands. See [Annotations](#annotations).

## Re-rendering and your edits

Regenerating a note never overwrites your work. Generated content lives inside a managed region (`<span class="mas-managed">…</span>`), and only template-declared frontmatter properties are reconciled. Everything else — including a `related:` property you edited — is preserved. See [Templates](./templates.md) for how the merge strategies work.

## Annotations

Annotations are painted over the generated text, never written into it. Select text inside a work's managed region to open the colour/comment popup; selections covering fenced code, inline code, or Markdown tables are rejected, and a selection that touches a wikilink is widened to the complete link; legacy stored partial-link ranges are widened on startup. In Live Preview, the active annotation exposes small oval drag handles at its start and end; clicking its sidebar card or margin comment icon also activates those handles. The **Annotate the selected text** command and editor menu are fallbacks. An animated margin icon opens a compact comment tooltip, and the automatically opened **Midad sidebar** (also available from its ribbon icon or command) has **Navigation** on the left and, on notes that support annotations, **Annotations (N)** beside it; other notes show only Navigation. The annotations tab lists the active note's annotations with the comment first and a two-line quote excerpt beneath, click-to-scroll, the same edit/annotation-note/delete icon actions. The navigation tab keeps the current note's `midad-up` parents fixed under up-arrow icons, then scrolls through siblings in parent order, showing the current note near the top with its headings (content note) or child notes (MOC/container); note titles carry a comment icon and annotation count, and the current note's child list can be folded with its chevron. The footer links to the Source Annotations, Transcriptions, Translations, and Sources MOCs plus Manage sources. Each work gets one generated annotation note and the shared `source-annotation` MOC; each MOC entry links the annotation note as `<Work> Annotations` and the source notes that contain annotations. Re-rendering or updating a source re-anchors quotes by exact text and then by surrounding context; unmatched annotations stay in the note's **Unanchored** section. When the current note has unanchored annotations, the selection popup offers **Re-anchor** (or **Re-anchor…** to choose among several), using the selected text as the new anchor. The **Re-anchor orphaned annotation…** command remains available. **Copy source with annotations** copies the source plus a callout section for use elsewhere, and **Archive source…** preserves the annotation store while its notes are removed.

Known Midad transcriptions and translations are registered automatically in `.midad-arabic-sources/annotations/adopted.json`; no filenames or YAML change. One annotation note covers all volumes of a series, with each volume as a unit. For any other note, use **Adopt note for annotations** (command palette or file context menu): it adds a stable `midad-work`/`midad-unit` identity and a managed region around the body, after which manual corrections re-anchor like a source note.

## Naming and provenance

Every classical work’s folder and hub use `Author - Title (repository)` — for example `ʿAbd al-Qādir al-Baghdādī - Khizānat al-adab (turath.io)` or `Aḥmad b. Ḥanbal - Musnad Aḥmad (hadith-json)` — so multiple works by one author and similar titles stay distinct. The repository qualifier is deliberately short (`tafsir_api`, `qul`, `hadith-json`, `quran-api`, `quran-json`, `turath.io`). If author, title, and repository still coincide, the next copy gets a language or edition qualifier; if those also coincide, it gets `(2)`, `(3)`, and so on, with installed names reserved. A folder component longer than 110 UTF-8 bytes is truncated at a word boundary and given a short stable hash suffix, so long author/title combinations stay within filesystem limits without colliding; the repository suffix is always preserved. The established nickname dictionaries (`Hans Wehr Dictionary`, `Lane's Lexicon`) and the Qur'ān editions keep their familiar titles; a work known to exist only once across the imported repositories is flagged `unique` and omits the repository qualifier. `title:` and the MOC/hub link aliases stay clean. Existing installs keep their old folders until **Migrate imported sources to the current naming scheme** is run.

Every generated page carries `repository`, `license-attribution`, and `repository-updated` properties, and `[[Midad Arabic Sources]]` in its `midad-up`, so the whole corpus is traceable to its source and to the plugin that imported it.

## Model JSON namespace

The hidden source models are deliberately named by identity rather than by title: `source-models/<collection>/<id>.json`. A collection is normally **repository-scoped** (the dictionary collection is the exception, with distinct ids for Wehr and Lane), and `(collection, id)` is the work's stable key. That makes the simple leaf names safe:

- A Muwaṭṭaʾ from the ḥadīth-json repository is `hadith/malik.json`; the Turath Muwaṭṭaʾ is a different collection and a numeric id under `turath/`.
- A second repository for the same genre gets its own collection (as `tafsir` and `tafsir-qul` already do), so its `malik` cannot collide with `hadith/malik`.
- Two versions in one repository must have distinct catalogue ids; they then become `hadith/malik.json` and `hadith/malik-v2.json`.
- Two grammar works by one author have different repository ids, e.g. `turath/123.json` and `turath/456.json`; the author and title distinguish their visible notes, not their internal models.

The importer rejects duplicate `(collection, id)` keys and any two ids that sanitize to the same model path, rather than overwriting one model with another. The embedded `work.key` is authoritative, and `fetch` also refuses to replace a model that declares a different key. All 834 catalogue works currently map to 834 distinct model paths.

## Where things go

- **Notes**: under `<Sources>/Installed Sources`, one folder per work.
- **Cached source JSON**: `.midad-arabic-sources/cache/text-sources/`.
- **Render models**: `.midad-arabic-sources/source-models/<collection>/<id>.json`. The collection folder is the namespace: `hadith/malik.json` is the model for `hadith:malik`, while another collection with the same leaf lives in its own folder. The embedded `work.key` is authoritative; a fetch refuses to overwrite a model that declares a different key. All 834 catalogue works currently map to 834 distinct model paths.
- **Archived models**: `.midad-arabic-sources/source-archives/<collection>/<id>.json.gz`.
- **Annotations**: `.midad-arabic-sources/annotations/<collection>/<id>/`, with the generated note under the configured annotation-note folder.
- **Manifest**: `.midad-arabic-sources/source-imports.json` — the authoritative list of works and their status (`installed`, `deleting`, `archived`).

Removing a work is a **hard delete** of its cached model and notes (not a trash move); the source JSON stays cached, so re-installing is quick. Archiving is different: it keeps a compressed model and the annotations, and can be restored without downloading again.
