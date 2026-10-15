# Midad Arabic Sources — text source import templates

These are the default ETA templates the **Midad Arabic Sources** plugin uses to turn acquired text corpora (tafsīrs, Qur'ān translations, ḥadīth collections, dictionaries) into Obsidian notes. They are bundled with the plugin and can be copied into your vault and edited; the plugin re-renders every imported work from its cached model whenever you ask it to.

## The two-stage design

1. **Acquisition** (Python, `scripts/text-source-import.py`): downloads a work's source JSON, caches it under `.midad-arabic-sources/cache/`, and writes a language-neutral **render model** to `.midad-arabic-sources/source-models/<collection>/<id>.json`.
2. **Rendering** (this plugin, ETA): reads a model and writes one note per unit, plus a per-work hub note and a category MOC entry.

Because the model is cached, editing a template and running **"Re-render imported sources"** regenerates every affected note without re-downloading anything.

## How to edit the templates

1. In Midad Arabic Sources settings, set a **Template folder** (for example `Templates`).
2. Run the command **"Copy import templates to vault"**. This copies these files into `<Template folder>/midad-arabic-sources-import-templates/`:
   - `source-note.eta.md` — one note per sūrah (tafsīr, Qur'ān translations)
   - `hadith-note.eta.md` — one note per chapter (kitāb) of a ḥadīth collection
   - `quran-note.eta.md` — one note per sūrah of a Qur'ān riwāya (Qur'ān text)
   - `dictionary-note.eta.md` — one note per dictionary root (lexicons)
   - `dictionary-index.eta.md` — one index note per first letter (a dictionary's roots)
   - `hub.eta.md` — the per-work hub note that lists all units
   - `moc.eta.md` — the skeleton for a category MOC (e.g. `Tafsīr Sources`)
   - `sources.eta.md` — the managed region of the top-level parent note (e.g. `Sources`)
3. Edit the copies, then run **"Re-render imported sources"**.

The plugin reads your copies first and falls back to the bundled defaults.

Each work's entry in its category MOC is just `- [[Work]]` — the work hub note, which carries the `repository:` property for provenance. The category MOC's generated region is also a managed region: it is rebuilt from the full set of imported works on every render, so entries never duplicate, and a language heading (`# Arabic Texts`, `# English Texts`) appears only when it has content.

Every category MOC points up to one **parent note** (the setting **"Sources parent note"**, default `Sources`). The plugin reuses whatever note already has that name — wherever it lives in the vault — or creates one. It writes only its own managed region there (an `>[!mas-sources-list]` callout listing the category MOCs that have content) and its `merge: keep` properties, so your hand-written content above and below the region is never touched. The callout type and its styling are the plugin's own (`mas-sources-list` in `styles.css`), so nothing depends on a callout defined elsewhere in your vault.

Every plugin-generated page carries `[[Midad Arabic Sources]]` as an `up` link, so the whole imported corpus is traceable back to the plugin that made it.

A work with a single unit — for example a one-chapter ḥadīth book such as al-Arbaʿūn al-Nawawiyya — keeps its content in the work note itself rather than a hub that links to one child note.

## Heading convention

- **A numbered unit is an H1.** A Qur'ān verse or a ḥadīth number is always `# <number>` — in sūrah notes, riwāya notes, and the single-unit hub alike.
- **The link to the canonical Qur'ān is an H2.** Sūrah notes use `## [[002 Al-Baqarah#2|البقرة : ٢]]`; riwāya notes use the Ḥafṣ correspondence `## [[002 Al-Baqarah#3|Ḥafṣ 3]]`.
- **A content note's `title` is its own title, not its file name.** A file name must be unique across the vault, so it carries the work (`Hans Wehr Dictionary - ز z`, `Tafsīr al-Jalālayn - 002 Al-Baqarah`); the work is already named by `mas-up`, so `title` is what a table of contents would print — the chapter (`title: ز z`, `title: 2 Al-Baqarah`, `title: 1 Revelation`), never `<work> - <unit>`. A title is for viewing, so a numeric prefix drops its leading zeros (`2 Al-Baqarah`); the *file name* keeps them, because that is what makes the sūra notes sort. A letter-index page is labelled with the letter and its romanized equivalent (`ز z`), the same way a definition page carries both.
- **A content note carries no title/chapter heading.** The work (or ḥadīth chapter) name lives in the `title` property, the file name, and `mas-up` — so it is not repeated as an H1. Ḥadīth chapter notes therefore title as just the chapter (`title: 1 Revelation`) and their `#` headings are the ḥadīth numbers.
- A **multi-unit hub** keeps `# <work title>` as its own heading, since it holds an index rather than numbered content.

This keeps every H1 a targetable unit number and every canonical link a targetable H2.

## Qur'ān citations in source text

Arabic tafsīrs cite *other* verses inline. Acquisition rewrites those citations into links to the canonical Qur'ān notes, in whatever shape the repository uses: `[يُوسُفَ: ١٠٣]`, `[ الأعراف : 3 ]`, `[٥٠: ٣٨]` (sūra:āya, al-Qurṭubī), `(القصص: ٥)`, and `[الآية: ١٢٣]` (a verse of the sūra being commented). A quote of the commented verse itself carries no citation and is left alone; editorial refs like `[تفسير ابن كثير: ٢ / ١٣٥]` never match a sūra and are untouched.

This requires **Ḥafṣ** to be the canonical riwāya, because the matcher reads the canonical sūra notes and almost every source quotes the Ḥafṣ reading — the setting says so. If a different riwāya is canonical, no citation linking is done.

## Variables available in a template

Every template receives a data object. The engine destructures it for you, so you can use these names directly:

| Name | Meaning |
| --- | --- |
| `work` | the work metadata (see the table below) |
| `unit` | the current sūrah or chapter (see unit fields) |
| `units` | every unit in the work (used by the hub template) |
| `bilingual` | `work.layout` — `"stacked"` or `"table"` (used by ḥadīth) |
| `generated` | the model's generation date (`YYYY-MM-DD`) |
| `mocs` | the category MOC names (parent-note template) |
| `parent` | the parent note name (MOC template) |

### `work` fields

| Field | Example | Notes |
| --- | --- | --- |
| `key` | `tafsir:ar-tafsir-al-jalalayn` | `<collection>:<id>` — also written to the hub as `mas-key` |
| `collection` | `tafsir` | `tafsir`, `tafsir-qul`, `quran`, `hadith`, `quran-text`, `dictionary` |
| `collection_label` | `Qurʾān commentaries (tafsīr)` | for the import modal |
| `id` | `ar-tafsir-al-jalalayn` | source id/slug |
| `name` | `Tafsir Jalalayn` | source name (ASCII) |
| `title` | `Tafsīr al-Jalālayn` | romanized, vault style |
| `dir` | `Tafsīr al-Jalālayn` | output folder (unique) |
| `short` | `al-Jalālayn` | short title, if any |
| `title_ar` | `تفسير الجلالين` | native Arabic title |
| `short_ar` | `الجلالين` | native short title, if any |
| `title_plain` | `Tafsir al-Jalalayn` | diacritic-less romanized (for search) |
| `authors` | `["Jalāl al-Dīn al-Maḥallī", …]` | romanized author names |
| `translators` | `["Feras Hamza"]` | rendered as `translators:` under `authors:` (overridden by `publication.translators`) |
| `publication` | `{ publisher: "Darussalam", …, mas_note: "…" }` | *injected by the plugin* from `publication-map.json`; adds `item-type`, `editors`, `publisher`, `place`, `year`, `edition`, `mas-note` to the hub YAML. A name may be a string, or `{first, last}` where the last-word split is wrong. `mas_note` is the map's `note` plus the provisional caveat — the same text the Zotero `extra` carries. |
| `aliases` | `["Tafsīr al-Jalālayn", "al-Jalālayn", "تفسير الجلالين", "الجلالين", "Tafsir al-Jalalayn"]` | the parent alias set |
| `language` | `ar` | primary language code |
| `languages` | `["ar", "en"]` | every language the work contains (ḥadīth are bilingual) |
| `language_links` | `["Arabic", "English"]` | the `language:` property (`[[Arabic]]` alone, or a list) |
| `cssclass` | `tafsir` | drives CSS (`quran`, `tafsir`, `hadith`, …) |
| `moc` | `Tafsīr Sources` | category MOC note name |
| `moc_sections` | `["Arabic Texts", …]` | MOC headings, derived from `languages` |
| `up` | `["[[Tafsīr Sources]]"]` | parent links |
| `source` | `https://qul.tarteel.ai/…` | provenance URL |
| `repository_name` | `qul.tarteel.ai` | short name for the `repository:` property |
| `repository_updated` | `2026-06-04` | the repository's own last-updated date for this item |
| `author` | `Muḥammad b. Ismāʿīl al-Bukhārī` | author line (hub) |
| `kind` | `surah`, `hadith`, `quran`, or `dict` | selects the note template |
| `unit_label` | `Sūrahs` or `Chapters` | hub section heading |
| `no_notes` | `true` | generate only the work note (canonical Ḥafṣ riwāya) |
| `unit_prefix` | `Qurʾān (riwāyat Warsh)` | fallback prefix for unit links (`note_stem` supersedes it) |
| `layout` | `stacked` or `table` | bilingual layout |
| `body` | `grid` or `prose` | a dictionary's body shape: Wehr's label/content senses, or Lane's paragraphs |
| `note_prefix` | `HW` or `LL` | a dictionary's root-note prefix (file name, `aliases:`, and the `<prefix>-id` property) |
| `convention` | `vault`, `wehr` or `full` | the named romanization path the work's names follow (see below) |
| `supplement_from` | `49881` or `0` | the id at which the source stops being one book and starts being a second (Lane's Supplement) |

### Romanization conventions

A work **declares** which transliteration path it follows, rather than letters being swapped ad hoc. The engine (`arabic-bw-transliterate.py`) emits the vault's own convention, so every other path is a recast of that:

- **`vault`** — the house convention: no case endings, but a verb's inflection, a pronominal or prepositional ending and the two tanwīn exceptions are kept (`baḥr`, `kataba`, `minka`, `qāḍin`, `ṭabʿan`). Lane uses this: it transliterates nothing itself, so its names are ours.
- **`wehr`** — Hans Wehr's own, the European Orientalist system of the printed dictionary (`š`, `ṯ`, `ḵ`, `ḏ`, `ġ`, `ḳ`, `č`, `ž`). Wehr uses it so that a name the engine produced still matches the transliterations the note's own text carries — and a transliteration the *source* wrote is kept exactly as written, never recast.
- **`full`** — fully vocalised, every case ending written. That is the service's `keep_case` mode (it changes how a reading is *produced*, not how its letters are written) and is what the vault uses for Qur'ān passages.

The convention is declared per work in `DICTIONARIES` (`scripts/text-source-import.py`), travels to the model as `work.convention`, and is applied by one function, `_hw_romanize`, everywhere a name is produced — including the letter-page labels, so `ث ṯ` in Wehr and `ث th` in Lane.

Languages are derived from the source catalogue: each work gets a code and its English name (e.g. `fr` → `French`), and its MOC section follows (`French Texts`). To add a language, extend `LANGUAGE_NAMES` in `scripts/text-source-import.py`.

### Sūrah unit fields (`unit.kind === "surah"`)

| Field | Example |
| --- | --- |
| `id` | `2` |
| `base` | `002 Al-Baqarah` (matches the `_7 Sources/Quran` note name) |
| `translit` | `Al-Baqarah` |
| `arabic` | `البقرة` |
| `blocks[]` | one per āya: `{ number, ref, body }` |
| `note_stem` | `Tafsīr al-Jalālayn - 002 Al-Baqarah` |

`note_stem` is added at render time and is the **authoritative name of the unit's note** — the same value is used for the file and for the hub's link to it, so a link can never name a note that was not written. (For the canonical riwāya it is the bare `base`, since its sūra notes are unprefixed in `canonical_root`.)

`blocks[].ref` is a ready-made link such as `[[002 Al-Baqarah#2|البقرة : ٢]]`, so `[[Tafsīr al-Jalālayn - 002 Al-Baqarah#2]]` parallels `[[002 Al-Baqarah#2]]`. `blocks[].body` already has Qur'ān spans marked as `*﴿…﴾{.quran-quote}*`.

### Ḥadīth unit fields (`unit.kind === "hadith"`)

| Field | Example |
| --- | --- |
| `id` | `1` |
| `base` | `1 Revelation` |
| `label` | `1 Revelation` |
| `arabic` | `كتاب بدء الوحى` |
| `english` | `Revelation` |
| `hadiths[]` | one per hadith: `{ number, narrator, english, arabic }` |

### Dictionary unit fields (`unit.kind === "dict"`)

One unit per dictionary **root**; the note is named `<prefix> <id> <arabic> <roman>` (unprefixed, as the vault already keeps these). The prefix is per-work — `HW` for Hans Wehr, `LL` for Lane's Lexicon — so the two dictionaries never collide, and a re-render prunes only its own work's stale names. It is also the property prefix (`hw-id` / `ll-id`) and the `aliases:` prefix (`HW حرب` / `LL حرب`).

| Field | Example |
| --- | --- |
| `id` | `24102` (the root's `ID`) |
| `base` | `HW 24102 وسخ wasaka` |
| `root` | the root entry `{ id, arabic, roman, verb_form, bullets[] }` (grid) or `{ id, arabic, roman, verb_form, paragraphs[] }` (prose) |
| `entries[]` | the derived entries, same shape |

`bullets[]` are the definition's bullets: the rendered template emits the entry's `arabic` as the first `> - …`, then each of `bullets`. The source marks sense numbers with `<b>II</b>`; a `<b>`/`</b>` pair becomes a line, and a fully-vocalised Arabic parenthetical (`(وَسَّخَ)`) is dropped while a Latin one (`(هـ s.th.)`) is kept.

`paragraphs[]` are the same thing for a **prose** work: the source's own paragraphs, in markdown. A note whose source folds a second book into the first — Lane's database carries the Supplement (Book II) as a suffix block in the scan's own numbering, from id 49,881 on — marks the boundary: the first unit at or above that id is preceded by a `# Supplement` heading, once per note, so the two books stay distinguishable inside one root's page. The id is the work's `supplement_from` in the acquisition config, and is also written to the model's `work` (0 = no such split, as for Wehr). `work.body` selects which the template renders (`grid` or `prose`), and a prose note also carries the `mas-prose` class in `cssclasses` — Obsidian resolves a paragraph that starts with Arabic to RTL (and to the Arabic size and leading), which is wrong for Lane's English prose, so the CSS needs a hook to reset it. Lane's definitions are English prose with `<i>`/`<h3>`/`<center>` markup and no Latin transliteration at all: `<i>…</i>` becomes `*…*`, a `<center>` block becomes the vault's poetry callout (`>[!arabic-poetry]`, one `>- ` hemistich per line — 2,159 of the 2,160 blocks are Arabic verse), the source's dividers (`===`, `___`) become paragraph breaks, the cross-reference arrow (`🡻`) becomes `↓`, a lone aorist vowel mark (`aor. ﹹ`) becomes the vowel itself (`aor. u`), the rare `<table>` is flattened, and the remaining tags are dropped. Lane's own `*` — a separator inside a reference list, `(S, * M, A, K;)` — is padded with spaces on both sides, because Obsidian has no working escape for it and an unpadded `*` pairs with another one and italicises everything between them; a `*` with a space on either side can neither open nor close emphasis. Lane's square brackets — editorial additions — become round ones, and the leading headword is wrapped in `<span class="mas-hw">` so the CSS can size it as Arabic while the prose stays at text size. The source's quotes are already correct curly ones, so a prose body turns only the stray straight quote (`smart_quotes` re-decides every mark and would reverse a closing quote that follows a space: `… war ”]` → `… war “]`).

The definition callout is `[!mas-dictionary-definition]` (renamed from `hans-wehr-definition`, which is still accepted as a CSS alias so un-rerendered notes keep their styling).

The **transliteration** (`term`, the heading, and the note name) is taken from the definition after HTML tags are stripped. The only tag in the corpus is `<b>` — the verb-form sense marker — and stripping it is essential: otherwise `<b>` supplies a stray `b` that passes for the romanisation (`ابن` → `b`). The scan is character by character over a transliteration alphabet that includes the dotted consonants and the hyphen, so `al-yūnān` survives whole rather than truncating to `al`. A leading parenthetical is skipped when it is an etymology pointer — no Arabic inside (`(Fr.)`), or opening with a language/grammar abbreviation (`(Turk. بورغى burğų)`, `(pl. of …)`, `(also …)`) — but **kept** when it holds the transliteration itself, as Wehr does for noun roots: `حرب (ḥarb f., pl. حروب ḥurūb …)` → `ḥarb`.

When a root's own definition is itself a verb form — it *starts* with a sense marker, e.g. `ابن <b>II</b> … …` — there is no transliteration to take, so it comes from the first **derived** entry that is not itself a verb form (`ابن` → `ubna`, `اخو` → `aḳ`).

Only if that fails too is the entry named by transliterating the bare root. That is done with the plugin's own engine (`arabic-bw-transliterate.py`, the one behind the *Transliterate* commands) rather than letter by letter — a real reading beats `ʿbrwd`. It is asked **`standalone`** (a word on its own, not an excerpt's final word, so it is not read in pausal form) and **without case endings**, i.e. the citation form, which is what `AI OS/Arabic transliteration guidelines.md` wants for a headword: no tanwīn on nouns (`baḥr`, not `baḥrun`) — guideline 4's defective-root and adverbial exceptions (`qāḍin`, `ṭabʿan`) come from the lexicon — while a verb's final inflection is kept (`kataba`, guideline 5) and a suffixed word keeps its vowel (`minka`).

That last step — and everything that follows it — is the **same machinery both dictionaries use** (`_hw_root_romanization`). The two differ only in what comes before: Wehr's definitions and entries carry transliterations, so those are taken first; Lane's carry none, so it goes straight to the shared reading. Either way the order is the root itself, then the root's own entries (a term that *is* the root, then one that merely contains its radicals), then — only if nothing was found — letter by letter. A bare cluster carrying a hamza tries the entries first, since the engine cannot know a bare hamza's vowel; the gates key off the *input* being an unvocalised cluster, not off which dictionary it came from. The Lane paragraph below spells the rules out.

A reading is accepted only when it **is the root itself**: the analysis behind it must be a single morpheme (the engine marks proclitic/enclitic boundaries with `+_`/`_+`), and its consonant skeleton — a case ending aside — must equal the root's. So `bajjana`, `aṣudd` and `wabaytuhu` are rejected rather than named. A doubled consonant is the one exception, because it is not an added morpheme: it marks the intensive form (II, `faʿʿala`), so the engine's bare `battak` is completed to the perfect `battaka` (`شد` → `shadda`, `مد` → `madda`). Only when nothing qualifies does the character-by-character radical transliteration stand in. A printed diptote marker (mamnūʿ min al-ṣarf) arrived as a literal digit glued to the transliteration and is re-emitted as a superscript: `احمد aḥmad2 …` → `*aḥmad*<sup>2</sup> …`.

For a **prose** work the engine is the *primary* name source, not a fallback — Lane's definitions carry no transliteration at all — and there it is reading a bare, unvocalised cluster, so a short or vowel-less result (`th`, `khr`) is a guess rather than a word and is rejected (`اث` → `āth`). And a bare root that yields nothing is named from the root's own entries, in two passes over the Arabic words of the entry in order — the term Lane gives first, with its subject or object after it (`أَثَفَ القِدْرَ`), then the examples that follow, so a word carrying the radicals may be found anywhere in the article. The first pass takes a word that **is** the root: an equality test on the skeleton, with gemination collapsed, the hamza ignored and the weak letters dropped (`أَثَفَ` for `اثف` → `athafa`, `ظَلَّ` for `ظل` → `ẓalla`, `نَأَتَ` for `نأت` → `naʾata`, and `آدى` for `ادو`, whose و the derived verb loses). The second pass, since many entries never give the plain term at all (`أَتْأَرْتُ إِلَيْهِ النَّظَرَ` for `تأر`), accepts a word that merely **contains** the radicals — a conjugated verb, which the conventions allow as a last resort before the letter-by-letter fallback; a one-letter skeleton is refused, since it would match almost anything. The reading is then brought to the vault's citation form: no tanwīn (`أَتْمٌ` → `atmun` → `atm`), except `-an` and a defective root's indefinite (`قَاضٍ` → `qāḍin`), and the short vowel the engine drops from a citation form is restored from the source (`نَأَتَ` → `naʾat` → `naʾata`, per the guideline keeping a verb's final inflection). Two things make that work for Lane's hamza roots. The validation ignores the hamza on both sides, because a vocalised word writes it (`نَأَتَ`) while Lane's bare root drops the carrier (`نات`) and the engine spells it (`naʾat`). And a root carrying a hamza tries the entries *first*: the engine cannot know a bare hamza's vowel, reading `نأت` as the vowel-less `nʾat` (or, from the carrier-less `نات`, as `nāt`). The letter-by-letter fallback — reached only when no reading exists at all — writes a hamza as `ʾ` (`ثأف` → `thʾf`, never `ā`) and reads an *initial* one as the vowel it carries (`اثف` → `athf`, the bare root `ا` → `a`), since a hamza is a seat rather than a consonant and a root cannot begin with a long vowel. (A letter page's own label is a different matter and still reads `ا ā`.) The comparison that decides all of this folds the variants the sources use and the scans confuse: a jīm written `g` or `ǧ` (`ātešgī` is accepted for `آتشجي`), a qāf written `ḳ`, a khāʾ written `ḵ` — and a wāw or yāʾ written as the vowel it sounds (`ibrīz`, `ḳōl`, `bēt`), since the weak letters are dropped from both sides of the comparison. A **derived** entry is a derivative, not the root, so it is shown in the vocalised Arabic alone; no transliterated heading is invented for it (that would need one engine call per derived row — 47,000 of them — and the conventions bar a derivative from standing as a name anyway).

A dictionary also carries one `dict-index` unit per first letter (Arabic order, alef variants folded), listed by the hub; each index note links the roots filed under that letter. These notes are **prefixed** (`<work dir> - <letter>`), unlike the roots. The bottom page names its letter page **first** in `mas-up` (`[[Hans Wehr Dictionary - ح ḥ]]`, then the work, then the plugin), so you can step to the adjacent entries of the same letter.

The source database is not one row per root: 548 root words have several `IS_ROOT` rows (the verb and the noun — `حرب` is both `ḥariba` 4457 and `ḥarb` 4458), 246 rows are pointers ("look up alphabetically") paired with the row carrying the entry, and a few rows sit three levels deep. Acquisition **merges** a root's rows into the one note that print has — the first row with real content is the note, the rest join it as sections, and every derived form of the group nests beneath — so nothing with content is dropped and no root is split across pages.

## Helper functions

Exposed as bare globals (the same pattern as ScholarWeft):

| Helper | Purpose |
| --- | --- |
| `start_YAML()` | begins a frontmatter block |
| `add_property(key, value, opts?)` | adds a YAML property; `value` may be a string or a list |
| `end_YAML()` | returns the assembled frontmatter block (including `---` fences) |
| `wikilink(target, alias?)` | `[[target]]` or `[[target|alias]]` |
| `heading(level, text)` | a `#`…`######` heading |
| `escape_md(text)` | escapes markdown metacharacters |
| `updated()` / `import_date()` | local timestamp / date |

`add_property` options: `quote` (`"auto"` | `"always"` | `"never"`) and `force` (emit even when empty). Lists render as `key:` plus two-space `- item` lines.

## Re-rendering and merging

Re-rendering is non-destructive:

- **Managed region.** The generated body is wrapped in `<span class="mas-managed">mas-managed</span>` … `<span class="mas-managed">/mas-managed</span>`. A re-render replaces exactly that span; anything you write above or below it is preserved.
- **Frontmatter merge.** Only the properties the template declares are touched. Every other property — including anything you add by hand — is preserved verbatim and in place.
- **`related:`** is declared with `merge: 'keep'`: the template inserts it once (empty), then your value always wins. Use it for topics you want linked.
- **`updated:`** is the volatile render timestamp; it is ignored when deciding whether a re-render actually changed anything.

Per-property merge strategies: `replace` (default — the template wins), `append` (union with your list), `keep` (write once, then never touch), and `subtract` (migration only).

## Auto-update when a template changes

The plugin keeps a template-hash timeline in `.midad-arabic-sources/template-history.json`. Each note records when it was rendered (`updated:`), so the plugin can tell which notes predate the current template.

When you edit a template, the plugin offers to re-render the affected notes (the setting **"Update notes when templates change"** controls *Ask* / *Always* / *Never*). You can always re-render manually with **"Re-render imported sources"**.

## Upstream changes

Each work records the repository's own `repository-updated` date. **"Check for source updates"** runs a two-stage check: it first asks the repository for that date, and only if it moved does it fetch the item's **content hash** (a git blob SHA returned by the server — no download). If the hash changed the text changed and it re-downloads and re-renders; if only the date moved (schema/metadata churn) it just records the new date. The check runs at most every **"Check repositories every … days"** (default 7; 0 = command only).

## Annotations (planned)

A future version may scrape your highlights (Obsidian's colored `==highlight==`) and markdown footnotes from an imported note and reapply them after a re-render, giving a Zotero-annotation-like workflow. For now, put your own commentary below the managed region and it will survive.

## Layouts

`work.layout` is set at acquisition time (`fetch --layout stacked|table`). The bundled ḥadīth template renders the Arabic and English of each hadith as separate paragraphs by default (`stacked`), or as facing-page table cells when set to `table`. Edit `hadith-note.eta.md` to try grids/flexboxes; the genre is exposed as `cssclasses` so your CSS can target it.

## Source JSON shapes (for reference)

| Collection | Source | Shape |
| --- | --- | --- |
| `tafsir` | spa5k/tafsir_api (quran.com mirror) | per-sūrah JSON: `[{ text, ayah, surah }]` or `{ ayahs: [...] }` |
| `quran` | fawazahmed0/quran-api | per-chapter JSON: `{ chapter: [{ chapter, verse, text }] }` |
| `hadith` | AhmedBaset/hadith-json | per-book JSON: `{ metadata, chapters[], hadiths[] }` |
| `quran-text` | risan/quran-json | per-sūra JSON: `{ id, verses: [{ id, text, number_in_hafs }] }` |

The acquisition script hides these differences; templates only ever see the normalized model.
