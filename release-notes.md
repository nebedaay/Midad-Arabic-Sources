Install/update via BRAT.

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
