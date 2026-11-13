# 0.2.8

Footnote rendering and superscript fixes.

### Footnote normalization

- New shared `normalize_arabic_footnotes` pass, used by the raw transcription formatter and the Level 2 Markdown-update layer.
- Each page is reduced to one `arabic-footnotes` callout.
- All footnote paragraphs are written as `> - ...`.
- Continuation paragraphs under the same footnote, or under no number, receive a `>` separator.
- A paragraph following a footnote callout on the same page is folded into the callout.
- Existing correct callouts are preserved; the pass is idempotent.

### Footnote anchors

- Increased the CSS specificity of the superscript rule so Obsidian’s core default and the Qur'ān `inline-block` rule cannot override it.
- Arabic footnote anchors are now 75% of the surrounding text.

### Documentation

- Documented the one-callout-per-page footnote convention in the Transcription guide.
