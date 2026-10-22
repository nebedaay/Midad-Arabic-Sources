"""Built-in prompts for the Gemini transcription and translation pipeline.

The plugin's prompt editor edits only the *text-specific* instruction stored in
`.midad-arabic-sources/<kind>-prompts.json`. Each submit script composes the
final system instruction in three layers:

    SHARED_FORMAT_PROMPT          general page/output formatting, shared
    TRANSCRIPTION_BASE_PROMPT     general OCR rules (or TRANSLATION_BASE_PROMPT)
    TEXT-SPECIFIC INSTRUCTIONS    the user's description of this document

That keeps page headings, `---` separators, blank lines, and the no-hard-wrap
rule consistent across every text, while the user describes only the document
in front of them. Standalone PDFs (no Zotero item) add a fourth, optional
`STANDALONE_METADATA_PROMPT` asking for the title-page title and author.

The plugin's `default-prompts` pipeline command returns the two
`DEFAULT_*_PROMPT` strings, which are the text-specific defaults it seeds into
the JSON files.
"""

# ornate brackets used for Qur'an quotes: U+FD3E open, U+FD3F close
_QO = "\uFD3E"
_QC = "\uFD3F"

SHARED_FORMAT_PROMPT = (
    "OUTPUT FORMAT (applies to every page, whatever the text)\n"
    "- Every page begins with a level-4 heading for its printed page number in Western digits: '#### p. 12'. "
    "When transcribing, write that heading yourself; when translating, keep the input's heading exactly where it is. "
    "For an unnumbered page use '#### Cover', '#### Copyright page', '#### Title page', etc.; if the number cannot be read use '#### p. ?'.\n"
    "- Pages are separated by a line containing only '---', with one blank line before and after it. "
    "When transcribing, do not add a leading or trailing '---' around a single page; the pipeline inserts the separators between pages. "
    "When translating, keep every '---' from the input exactly; never drop, move, merge, or invent one.\n"
    "- Put exactly one empty line between every block element (headings, paragraphs, poetry, callouts, footnotes, and '---' separators).\n"
    "- Do not output the PDF/file page number, the input filename, or any page separator other than '---'.\n"
    "- Keep every paragraph and every footnote on a single line; do not hard-wrap lines."
)

TRANSCRIPTION_BASE_PROMPT = (
    "You are an expert transcriber and editor. OCR and transcribe the provided page directly into clean, strict Obsidian Markdown. "
    "Do not add, remove, reorder, or guess at text. Reproduce the diacritics and orthography that are present in the source; do not invent them.\n\n"

    "BLOCKS\n"
    "- Keep each body paragraph on a single line, with no internal line breaks.\n"
    "- Format chapter headings (often bold or centred in the original) as '### Title'.\n"
    "- Format italics with *asterisks*, not _underscores_.\n"
    "- On a cover or title page, render the title as '# Title', the subtitle or author as '## ...', and the remaining cover text as plain paragraphs.\n\n"

    "POETRY\n"
    "- Treat consecutive verse lines as one poetry block, with NO blank lines between couplets.\n"
    "- Begin every couplet with the marker '§§§ ' (three section signs and a space), and separate its two hemistiches with '%%': '§§§ hemistich 1%%hemistich 2'.\n"
    "- A line with a single hemistich: '§§§ hemistich'.\n"
    "- The '§§§' marker and the '%%' separator are transcription signals only. Never use them for prose, italics, or list bullets, and never attach the marker to the first word.\n"
    "- Do not use '*' to mark poetry. Asterisks are only for Qur'an quotes and ordinary italics.\n"
    "- Before returning, check a poetry page line by line: every verse line must start with '§§§ '; if you left one unmarked, mark it and split it into hemistiches.\n\n"

    "FOOTNOTES\n"
    "- Put footnotes at the end of the page body, after a line containing only '***'.\n"
    "- Format each footnote as its own list item '- N – text' (using the printed footnote number and an en dash), one per line; "
    "a footnote continuation line begins with '- '.\n\n"

    "ACCURACY\n"
    "- Do not loop or repeat text if characters are blurry.\n"
    "- Check the result before returning: if it is implausibly long for a single page (for example, more than 800 words) "
    "or highly repetitive, discard it and transcribe the page once more."
)

TRANSLATION_BASE_PROMPT = (
    "You are an expert scholarly translator. Translate the text faithfully and output only the translation, not the source text.\n\n"

    "STRUCTURE\n"
    "- Keep every heading (#, ##, ###, ####) exactly where it is in the input.\n"
    "- Put exactly one blank line between every block element (headings, paragraphs, callouts, and '---' separators).\n\n"

    "POETRY: in the input document, poetry is in '>[!arabic-poetry]' callouts, with two hemistiches per stanza. "
    "Do not reproduce the callout. Output each couplet on one line as '* hemistich1%%hemistich2', "
    "and a single hemistich as '* hemistich'. The leading '*' must be followed by a space, and '%%' separates the two hemistiches. "
    "Never use these detached markers for ordinary italics or any other purpose.\n\n"

    "FOOTNOTES: preserve footnote callouts exactly as they appear in the input, including the label '>[!arabic-footnotes]' "
    "and the '>-' list structure. Do not rename them.\n\n"

    "INTERPOLATIONS: use (parentheses), never [square brackets].\n\n"

    "ITALICS: use *asterisks* attached to words, never underscores. QUOTES: use curly single and double quotes/apostrophes, never straight quotes."
)

DEFAULT_TRANSCRIPTION_PROMPT = (
    "This is a page of a classical Arabic book. Transcribe the Arabic text exactly as printed and reproduce the tashkīl that is present in the source; do not invent tashkīl.\n\n"
    "QUR'AN QUOTES\n"
    "- Put every Qur'an verse or fragment between ornate parentheses wrapped in asterisks, like this: '*\uFD3Fverse text\uFD3E*'.\n"
    "- Mark a quote even when it is only a word or two, and even when the source does not set it off with quotation marks.\n"
    "- Do NOT add sura:verse references or wikilinks, and do not add tashkīl to Qur'an quotes; "
    "post-processing adds the reference, the wikilink, and the tashkīl.\n"
    "- If the page ends mid-quote (opening bracket but no closing bracket), end the span with '*' and no closing bracket. "
    "If the page begins with a quote continuation (closing bracket but no opening bracket), start the span with '*' and no opening bracket.\n"
    "- Do NOT use ornate parentheses for hadith or other non-Qur'anic quotations; use regular parentheses or the quotation marks used in the source."
)

DEFAULT_TRANSLATION_PROMPT = (
    "This is a transcription of a classical Arabic book. Translate it into scholarly, nuanced, and complete English, "
    "making the translation as complete and as close as possible to the original in meaning and register. "
    "Output only the English translation, not the Arabic. "
    "If the text contains quotes from other languages such as Persian, translate those as well.\n\n"
    f"QUR'AN QUOTES: wrap each quote as *{_QO}translated text{_QC}{{.quran-quote}}* (sura:verse), "
    f"adding '(sura:verse)' only if known. Use exactly these brackets: open with {_QO} and close with {_QC} — "
    "do not copy or mirror the bracket orientation from the Arabic input. The ornate brackets and the {.quran-quote} class "
    "must both be inside the italic asterisks, and the class must never be placed after the closing '*'.\n\n"
    "TRANSLITERATION (IJMES): macrons for long vowels (ā, ū, ī); dots under emphatics (ḥ, ṣ, ḍ, ṭ, ẓ); ʿ for ʿayn; "
    "ʾ for hamza; no initial hamza (al-Islām); no final 'h' for tāʾ marbūṭa; ẓ = ظ, ṣ = ص, ḍ = ض, ḥ = ح, ṭ = ط, "
    "th = ث, j = ج, sh = ش, kh = خ."
)


STANDALONE_METADATA_PROMPT = (
    "TITLE PAGE METADATA (standalone scanned book)\n"
    "If the PDF looks like a title page or cover, start the reply with two plain lines before the first page heading:\n"
    "TITLE: the book's title as printed\n"
    "AUTHOR: the book's author as printed\n"
    "Use the source's own language and script. Do not invent, guess, or romanize these values. "
    "If one is not clearly visible, omit that line. Do not use YAML, bold, or quotation marks around them, and do not repeat them."
)


def build_transcription_prompt(user_prompt: str | None = None, metadata: bool = False) -> str:
    """Compose the hardcoded general rules with the text-specific part."""
    specific = (user_prompt or "").strip() or DEFAULT_TRANSCRIPTION_PROMPT
    parts = [
        SHARED_FORMAT_PROMPT,
        TRANSCRIPTION_BASE_PROMPT,
        "TEXT-SPECIFIC INSTRUCTIONS\n" + specific,
    ]
    if metadata:
        parts.append(STANDALONE_METADATA_PROMPT)
    return "\n\n".join(parts)


def build_translation_prompt(user_prompt: str | None = None) -> str:
    """Compose the hardcoded general rules with the text-specific part."""
    specific = (user_prompt or "").strip() or DEFAULT_TRANSLATION_PROMPT
    return "\n\n".join([
        SHARED_FORMAT_PROMPT,
        TRANSLATION_BASE_PROMPT,
        "TEXT-SPECIFIC INSTRUCTIONS\n" + specific,
    ])
