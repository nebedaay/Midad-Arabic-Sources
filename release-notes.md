Install/update via BRAT.

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
