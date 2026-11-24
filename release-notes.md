Install/update via BRAT.

### 0.3.0

Citations that open and read correctly, saved versions that answer at once, and a translation pipeline that keeps every footnote on its own page.

### Citations

- A citation is a two-line cartouche: a sūra **name** above its numbers (`الفاتحة` / `٤`, `Q An-Nur` / `10`), or — when the style prints the sūra as a number — the prefix above the whole locator (`Q` / `2:24`), with the separator between them honoured. A number is the first half of the reference, not a label, so it is never split across the two lines.
- The format follows the note without a language property: an explicit `quran-citation-language`, then `language`, then the genre Midad itself wrote (`tafsir-en` / `tafsir`, an `[[Arabic translations]]` entry), then the folder. A paragraph that is clearly in the other language overrides its note, so a bilingual volume cites each paragraph in its own language.
- A paragraph's direction comes from its **first strong character**, not from whether it contains Arabic: an English paragraph that quotes two Arabic words is still English.
- A Latin cartouche is sized as 60% of the note's own text size, so it sits inside an English line instead of opening up its leading.
- A citation opens on the press, as it should: the editor no longer takes the press for itself, which is what used to reveal `[[…]]` instead of opening the sūra. Ordinary links are left to Obsidian.

### Saved versions

- The version store reads and writes **one work's archive at a time**. Opening the manager unzips that note's archive and nothing else; a change rewrites that one archive. It used to unzip all 701 archives (260 MB) on open and re-compress every one of them on every click — the reason the dialog took a minute to answer and twenty seconds to apply.
- Version matching trusts the recorded hash and only decompresses a snapshot that has none, the note is read once per refresh, and the manifest index is cached.
- A progress line says what is running and makes the list inert while it does, so a slow re-render no longer looks like a dead click.

### Translation

- **One page per request.** Two pages in one context let the model attach one page's footnotes to the next page's section; it cannot do that now. The split is at the page heading alone — a `## Lesson` or `### Sūrat …` is content, not a boundary — and a response that comes back without its heading has it restored.
- **Footnotes.** One `>[!footnotes]` per page, always. Every label the model writes becomes it and then goes: `Footnotes:`, `> Footnotes:`, `**Arabic Footnotes**`, `#### arabic-footnotes`, and a literal `<arabic-footnotes> … </arabic-footnotes>` wrapper. A rule that introduces number-led paragraphs — `---`, `***`, `___`, a bare `<br>` — is the section's edge, not a page break. Definitions written as bare paragraphs (`¹ …`, `<sup>1</sup> …`, `^(1)^ – …`, `[^1]: …`, `[^talhah-bio]: …`, `1 - …`) become `> - 1 – …` items, named markdown footnotes are numbered in order, and their anchors become `<sup>N</sup>` references.
- A block the model put one page late is moved back to the page whose text refers to its numbers — one page, never two, because two pages were all it ever saw.
- A verse is cited **once per run** in a translated tafsīr: the first and last quotation of a verse in a paragraph keep the link, the glosses between them lose it. The margin's `|:` marker is not a citation and is untouched.
- Backticks the model uses for emphasis become ‘…’, and the footnote rule hangs from the correct edge (`arabic-footnotes` right, `footnotes` left).

### The Qur'ān work

- Two links to the same verse in a row are one citation, including the old aliased form beside the new one.
- A quotation that opens with the basmala is the opening of the sūra being read, not a citation of al-Fātiḥa: the page's `سورة …` heading decides, and without one the following quotation does (`﴿ٱلَّذِىٓ أَنزَلَ عَلَىٰ عَبْدِهِ ٱلْكِتَٰبَ﴾` is al-Kahf). The marginal marker is realigned with the citation.
- A short quotation whose words are the next words of the verse just cited is cited in that verse — a commentary glosses word by word.
- A quotation span never reaches across a paragraph break or a page heading. An unbalanced ornate mark used to make one span from a heading to the next paragraph, and the verse-number stripping inside a span ate the page number and the line break with it, gluing `#### p. 235` to the text that followed.

### Fixes

- `#### p. 235﴾then…` (text glued to a page number) and `#### p * 135` are repaired instead of printed.
- A citation's trailing space goes with it when the link is removed, so a gloss is not left with a gap before its punctuation.

### 0.2.12


One Qur'ān engine for every text, a margin that numbers the whole chapter, and citations that are corrected from the words they quote.

### One Qur'ān engine

- The Qur'ān work is now two modules instead of one mixed file: `quran.py` holds the general work (verse access, quote discovery and matching, cross-page quotes, span matching, citation hygiene, canonical replacement), and `tafsir.py` holds the tafsīr mode only (focal verse, marginal markers, linear progression, cross-reference rules).
- `transcription-quran.py` is gone. A scanned transcription, a repository tafsīr and a Turath book now call the same functions, so a rule cannot exist for one source and not for another.
- The riwāya is detected from the text — Warsh from its own mark set — or declared per work; matching, replacement and every generated link follow it, and an `other` reading is matched without replacing the author's text.

### The margin numbers the whole chapter

- Marginal verse markers are decided for the **whole note**, not page by page: a chapter written one page at a time is collected first, because whether a verse is discussed in order is a fact about the chapter.
- A verse the commentary takes up in order is numbered where the discussion reaches it; a verse it only mentions in passing is numbered at that mention, and that marker does not move the cursor. Every cited verse therefore gets exactly **one** marker — Aḍwāʾ al-bayān's Sūrat al-Naḥl went from 9 markers to 78, and al-Qurṭubī's from a handful to 116 (16:1 … 16:128).
- A jump — forward or backward — is a genuine skip unless the text soon returns to near where it was: a return is a digression, a cross-reference, and it does not move the margin. A new passage may start at a lower verse after a long detour.
- A verse is numbered once in a note; the commentary's constant returns no longer repeat it in the margin. Verses introduced together on one line still become one range marker, but only when they are within a few verses of each other.

### A citation is evidence of a quotation

- `wrap_cited_quotes` now runs for **every Arabic text with citations**, not only tafsīrs: a link never appears without its Qur'ān formatting. The quotation is the longest suffix of the words before the citation that occurs contiguously in the cited verse, so a phrase from the middle of a verse is found, prose before it stays outside, and a lead-in is only a boundary hint (and the sole signal for an uncited quotation).
- A one-word quotation is formatted when it verifies (`شَيْئًا` → 16:73), a word quoted inside guillemets is wrapped inside them (`وَ«مُسَخَّرَاتٌ»` → 16:12, the conjunction left outside), and a closing quote mark, an ellipsis or `الآية` between the quotation and its citation stays outside the boundary.
- Two citations can no longer claim the same words. An overlapping span is skipped rather than nested, which is what used to split a word in two (`~﴿~وَهُ~﴿~…يًّا`).

### Citation repair

- A citation the muṣḥaf does not support is corrected from the words that follow it, before anything is wrapped, numbered or displayed. The number is the clue, so the nearest reading of it wins: an adjacent verse in the same sūra (`24:31` → `24:30`), the same āya number in another sūra (`16:136` → `6:136`, `95:7` → `59:7`), another verse of the same sūra (`7:124` → `7:142`), then a single match anywhere (`16:78` → `16:87`).
- At least three words must agree, because two words occur in dozens of verses; an impossible verse number with no quotation is corrected only when one transposition of its digits exists (`16:221` → `16:122`, the duplicate absorbed); anything ambiguous is left exactly as the source wrote it.
- A text whose quotations disagree wholesale is the wrong edition or riwāya, not a text of typos: once two thirds of a page's quotations fail to verify, that page is left untouched and the reason is logged. On a clean text the corrections are occasional — about 2% of Aḍwāʾ al-bayān's citations, with the offsets of a transposed or dropped digit while 97% verify as printed.

### Turath and templates

- A Turath tafsīr now carries the `tafsir` class, quotes inside invisible boundaries with the canonical text, and the same marginal markers as a transcribed tafsīr. A stray `toc` anchor inside a citation bracket is unwrapped instead of becoming a heading.
- Same-line source and recognition ranges stack in the margin (`data-marker-index`), one above the other, instead of overlapping.
- A tafsīr's `# N` emblem is read from a numeric or range heading, so the verse the block covers is the verse it shows.

### Fixes

- Overlapping quotation edits can no longer nest the ornate boundaries or split a word; both wrapper passes reject an edit that would overlap one already planned.
- A citation link is no longer left unformatted because the wrapping pass ran before the link was added: it is re-run at the end of the tafsīr pass.
- Updating the plugin now removes scripts and templates it no longer ships, so a retired module cannot linger in the installed copy.

### Documentation

- The template and transcription guides describe the chapter-wide margin, the one-off marker, the citation-is-evidence rule and the citation-repair ladder.

### 0.2.11

One verse marker for every source, and Arabic typography that no longer depends on the view.

### One verse marker

- Every source now writes its correspondence to the canonical Qurʾān as `**[[002 Al-Baqarah#3|2:3]]**`: tafsīr, every riwāya (replacing the old `Ḥafṣ N` heading), and translations.
- The marker sits in the **left** gutter of an RTL text and in the **right** gutter of an LTR one, from the same class and the same code path.
- The `# N` emblem is unchanged: it is the page's own verse number, so it keeps the side where the verse begins (right for Arabic, left for a translation). A riwāya page therefore reserves both bands, exactly as before.
- The marker's emphasis is structural, not decorative: a bare wikilink becomes an editor widget that CSS cannot position. It is never drawn bold.
- A marker now ends with an invisible U+FEFF, so the closing `**` is not followed directly by an Arabic letter — an emphasis that cannot close is shown as literal stars by the editor.

### Typography

- Reading view no longer substitutes the general Arabic face for the Qur'ān one. Three rules were out-ranking the class-scoped verse rules (the generic RTL rule, a marker paragraph hook, and a quote-span hook); the face is now declared with the view class for both views, and `--quran-warsh-font` (Harmattan) is honoured throughout a Warsh page.
- Qur'ān passages inside other notes — a tafsīr, a ḥadīth commentary — keep the Qur'ān face in Reading view as well as in Live Preview.
- The Warsh page and the Ḥafṣ page are laid out identically; only the face differs.

### Transcription and post-processing

- `strip_raw_quran_citations` no longer mistakes a wikilink's inner brackets for a source citation, which had deleted every marker link and left `**\[]` debris across a re-processed note.
- `normalize_quran_link_display` leaves an `S:V` display in Latin digits; only citations are converted to Arabic-Indic numerals.
- `link_open_fragments` no longer reads an HTML attribute (`class="mas-managed">`) as an opening quotation mark and wraps the managed-region marker.
- `insert_verse_headings` removes the `**\[]` debris an older run left, so re-processing repairs a note instead of carrying it forward.
- Page separators are imported from the shared post-processor and always applied; a run of `---` rules separated by blank lines now collapses to one.

### Fixes

- `quranFile`/`quranWorks` accept canonical and prefixed filenames; the callout and reference commands list every installed riwāya and translation.
- Scoped re-renders refresh the note baselines.
- The `tafsir` class is no longer added to notes that are not tafsīr.
- `midad-up` topic repair is add-only, so it no longer removes template-supplied topics.

### Documentation

- Transcription and template guides describe the single marker form, the gutter sides, and why the emphasis and the U+FEFF separator are required.
- Qur'ān, tafsīr and translation notes are documented as reading-view first; the Live Preview marker layout remains parked.
