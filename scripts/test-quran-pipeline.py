#!/usr/bin/env python3
"""Assertions for the Qur'ān pipeline's behaviour.

Run with the interpreter the plugin resolves (the one that has `camel_tools` and
`fitz`); the pipeline's own imports are used, so the file under test is the one
that ships:

    /Users/josephhill/miniconda3/bin/python scripts/test-quran-pipeline.py

These cover the places that have silently broken during refactors: moving code
between modules (a lost constant raised inside a try/except and every link
quietly disappeared), poetry detection (an italic paragraph became a callout),
page numbering (a page without a heading merged into its neighbour), and the
orthographic fold (a modern spelling failed to match the muṣḥaf).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

failures: list[str] = []


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"ok    {label}")
    else:
        failures.append(label)
        print(f"FAIL  {label}{(' — ' + detail) if detail else ''}")


# The pipeline resolves its folders from the environment the plugin sets; without
# it every path points at a folder that does not exist and the tafsīr mode comes
# back False for reasons that have nothing to do with the note.
import os
os.environ.setdefault("MIDAD_TRANSCRIPTIONS_DIR", "_7 Sources/Transcriptions")
os.environ.setdefault("MIDAD_TRANSLATIONS_DIR", "_7 Sources/Translations")

quran = load("quran", "quran.py")
submit = load("translate_submit", "translate-batch-submit.py")
mover = load("mover", "transcription-translation-move-to-vault.py")
fmt = load("transcription_format", "transcription-format.py")
tafsir = load("tafsir", "tafsir.py")
src = load("source_import", "text-source-import.py")
post = load("text_postprocess", "text_postprocess.py")
render = load("quran_render", "quran_render.py")

# ── The long-ā fold ──────────────────────────────────────────────────────────
# The Uthmani rasm writes these with wāw; ordinary typography writes alif.
check("rasm: ٱلْحَيَوٰة folds to الحياة",
      quran.normalize_arabic("ٱلْحَيَوٰة") == quran.normalize_arabic("الحياة"),
      f"{quran.normalize_arabic('ٱلْحَيَوٰة')} != {quran.normalize_arabic('الحياة')}")
check("rasm: ٱلصَّلَوٰة folds to الصلاة",
      quran.normalize_arabic("ٱلصَّلَوٰة") == quran.normalize_arabic("الصلاة"))

# ── Discovery ────────────────────────────────────────────────────────────────
# A quotation the source marked with parentheses is wrapped and cited.
quoted = "قال: (وَلَوْلَا فَضْلُ ٱللَّهِ عَلَيْكُمْ وَرَحْمَتُهُۥ وَأَنَّ ٱللَّهَ تَوَّابٌ حَكِيمٌ) ثم"
out, found = quran.discover_and_mark_quotes(quoted, tafsir=True)
check("discovery finds 24:10 in a parenthetical",
      any(item.get("surah") == 24 and item.get("verse") == 10 for item in found), str(found)[:120])
check("discovery cites what it found", "[[Q024#10" in out, out[:120])

# An already-ornate quotation needs no discovery.
ornate = "﴿وَلَوْلَا فَضْلُ ٱللَّهِ عَلَيْكُمْ وَرَحْمَتُهُۥ﴾"
check("discovery leaves an already-ornate span alone",
      quran.discover_and_mark_quotes(ornate, tafsir=True)[0] == ornate)

# ── Tafsīr mode ─────────────────────────────────────────────────────────────
# Topics are additive: a parent marked tafsīr carries to its volumes.
check("tafsir mode: a volume inherits its parent's Tafsīr topic",
      mover.tafsir_mode("alburusawiRuhAlbayan2018", "transcription", 6, None, False) is True,
      str(mover.dest_path("alburusawiRuhAlbayan2018", "transcription", None, False)))

# ── Poetry detection ────────────────────────────────────────────────────────
check("poetry: *h1 *h2 is a couplet", fmt.is_poetry_line("*قفا نبك من ذكرى *حبيب ومنزل"))
check("poetry: a closed *span* is italics", not fmt.is_poetry_line("*يا أيها الناس اتقوا ربكم*"))
check("poetry: %% marks a couplet", fmt.is_poetry_line("§§§ h1%%h2"))
check("poetry: a 90-character couplet is prose",
      not fmt.is_poetry_line("*" + "ا" * 50 + " *" + "ب" * 40))

# ── Page numbering ──────────────────────────────────────────────────────────
check("pages: a blank before 4 is 3",
      fmt._extrapolate_page_numbers([None, 4]) == [3, 4],
      str(fmt._extrapolate_page_numbers([None, 4])))
check("pages: a gap of three is filled",
      fmt._extrapolate_page_numbers([None, 7, None, None, None, 11]) == [6, 7, 8, 9, 10, 11])
check("pages: no anchor stays unknown", fmt._extrapolate_page_numbers([None, None]) == [None, None])

# ── Separators ──────────────────────────────────────────────────────────────
check("separator: stray rule dropped, blank kept",
      post.normalize_page_separators("a\n\n\n---\n\n\nb\n") == "a\n\nb\n")
check("separator: page rule kept",
      "---\n\n#### p. 7" in post.normalize_page_separators("a\n---\n#### p. 7"))
check("separator: inline rule untouched",
      post.normalize_page_separators("a --- b\n") == "a --- b\n")

# ── A marked quotation is a candidate, whatever marked it ───────────────────
# The fault that cost a whole volume its citations: the ornate spans were
# visible, marked and plentiful, and no pass offered them to the matcher.
CITED = "وَلَوْلَا فَضْلُ ٱللَّهِ عَلَيْكُمْ وَرَحْمَتُهُۥ"

# A phrase that occurs in several verses needs the focal verse to resolve it,
# which is exactly why the citation-as-first-guess input exists.
bare = quran.link_quote_citations(f"قال ﴿{CITED}﴾", surah=24, ayah=10, linear=True,
                                  ornate=True)
check("bare ornate span: cited", "[[Q024#10" in bare, bare)

italic_only = quran.link_quote_citations(f"قال *{CITED}* ثم",
                                         delims=("*",), ornate=False)
check("italic span: marked as a quotation", "{.quran-quote}" in italic_only, italic_only)

# Emphasis that is not a verse is left exactly as it was.
prose = "قال في *«التأويلات النجمية»* ثم"
check("italic prose: untouched",
      quran.link_quote_citations(prose, delims=("*",), ornate=False) == prose)

# A gloss inside parentheses is not a quotation even though its letters can be
# found inside a verse once the spaces are gone: `أي من الخوف` normalises to
# `ايمنالخوف`, which lands across `…شَيْءٍ مِّنَ ٱلْخَوْفِ` in 2:155.
check("words: an alignment is word by word",
      not quran.words_in_sequence(
          "وَلَنَبْلُوَنَّكُم بِشَىْءٍ مِّنَ ٱلْخَوْفِ وَٱلْجُوعِ", "أي من الخوف"))
gloss = "قال: (أي من الخوف) ثم"
check("gloss: a parenthesis of prose is not marked",
      quran.link_quote_citations(gloss, delims=("()",), ornate=False) == gloss)
check("fragment: a gloss gets no canonical text",
      quran.get_tashkil_fragment("أي من الخوف", 2, 155) is None)

# ── Cross-page continuation ─────────────────────────────────────────────────
# p. 6 of Rūḥ al-Bayān opens a verse with an italic span and never closes it;
# p. 7 continues the same verse. One quotation, one closing paren, one link.
page1 = ("#### p. 6\n\n*يَا أَيُّهَا النَّاسُ إِن كُنتُمْ فِي رَيْبٍ مِّنَ الْبَعْثِ "
         "فَإِنَّا خَلَقْنَاكُم مِّن تُرَابٍ ثُمَّ مِن نُّطْفَةٍ ثُمَّ مِنْ عَلَقَةٍ ثُمَّ "
         "مِن مُّضْغَةٍ مُّلَّخَّقَةٍ وَغَيْرِ مُخَلَّقَةٍ لِّنُبَيِّنَ لَكُمْ ۚ وَنُقِرُّ فِي "
         "الْأَرْحَامِ مَا نَشَاءُ إِلَىٰ أَجَلٍ مُّسَمًّى ثُمَّ نُخْرِجُكُمْ طِفْلًا ثُمَّ "
         "لِتَبْلُغُوا أَشُدَّكُمْ ۖ وَمِنكُم مَّن يُتَوَفَّىٰ وَمِنكُم مَّن يُرَدُّ إِلَىٰ "
         "أَرْذَلِ الْعُمُرِ")
page2 = ("#### p. 7\n\nلِكَيْلا يَعْلَمَ مِنْ بَعْدِ عِلْمٍ شَيْئاً وَتَرَى الْأَرْضَ "
         "هامِدَةً فَإِذَا أَنزَلْنَا عَلَيْهَا الْمَاءَ اهْتَزَّتْ وَرَبَتْ وَأَنبَتَتْ "
         "مِن كُلِّ زَوْجٍ بَهِيجٍ *(٥)*")
joined, count = quran.fix_cross_page_quotes(page1 + "\n\n---\n\n" + page2)
check("cross-page: the two halves become one quotation", count == 1, joined[-160:])
check("cross-page: the opening paren is on the first page",
      "﴿" in joined.split("---")[0] and "﴾" not in joined.split("---")[0], joined[:200])
check("cross-page: the closing paren and citation are on the second",
      "﴾" in joined.split("---")[1] and "[[Q022#5" in joined.split("---")[1],
      joined.split("---")[1][:200])
note = post.unwrap_quran_quotes(joined)
check("cross-page: the page's verse number does not print",
      note.rstrip().endswith("﴾ [[Q022#5]]") and "(٥)" not in note, note[-120:])

# ── A page's running header is not the first paragraph ──────────────────────
block = "#### p. 6\n\n۲۲ - سورة الحج\n٦\nفشأن الشيطان أن يضل من تولاه عن طريق الحق."
cleaned, printed = fmt._strip_running_header(block)
check("headers: the sura line and printed number go", "سورة الحج" not in cleaned
      and not cleaned.strip().startswith("٦"), cleaned)
check("headers: the first paragraph stays", "فشأن الشيطان" in cleaned, cleaned)

# ── One sequence for every genre (the architecture rule) ────────────────────
# The same text, handed to the repository front end and to the transcription
# front end, must come out byte-identical. A genre may contribute *inputs*
# (its delimiters, its focal verse, whether it is a commentary); it may not
# contribute a second sequence. If this check fails, two genres have begun to
# drift and the difference is a bug, not a feature.
fixture = (
    f"قال تعالى: ﴿{CITED}﴾ ثم قال: *{CITED}* "
    "وقال أيضاً: (يَٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱتَّقُوا۟ ٱللَّهَ) "
    "ثم ﴿إِنَّ ٱللَّهَ مَعَ ٱلَّذِينَ ٱتَّقَوا۟﴾."
)
conformance_delims = ("*", "()")
repo = src.link_source_content(
    fixture, surah=24, ayah=1, linear=True, skip_current=False,
    delims=conformance_delims, unwrap=False)
repo, _ = tafsir.process_quran(repo, mode="tafsir", surah=24, ayah=1,
                               source_citations=True)
repo = post.unwrap_quran_quotes(repo)
transcribed, _ = tafsir.process_quran(
    fixture, mode="tafsir", surah=24, ayah=1, delims=conformance_delims)
transcribed = post.unwrap_quran_quotes(transcribed)
check("conformance: repository and transcription agree", repo == transcribed,
      f"repo={repo!r} trans={transcribed!r}")

# ── One citation per quotation, a range per multi-verse quotation ───────────
# A run is a run *in the text*: the only thing between two citations is the
# quotation they follow. Anything else is the commentary quoting the verse
# again, and each quotation keeps its own citation.
run_of_three = "﴿A﴾ [[Q024#10]] ﴿B﴾ [[Q024#10]] ﴿C﴾ [[Q024#10]]"
collapsed, removed = tafsir.keep_first_verse_link(run_of_three)
check("citation run: one link for the run",
      removed == 2 and collapsed.count("[[Q024#10]]") == 1, collapsed)
# A string of quotations from one verse is named once; a different verse breaks
# the run, and a return to the first gets its citation back. The margin is the
# only thing that never repeats.
twice = "﴿A﴾ [[Q024#10]] commentary text ﴿B﴾ [[Q024#10]]"
out, _ = tafsir.process_quran(twice, mode="tafsir", surah=24, ayah=10)
check("inline citations: a run of one verse keeps one link",
      out.count("[[Q024#10]]") == 1, out)
back = "﴿A﴾ [[Q024#10]] ﴿B﴾ [[Q024#11]] ﴿C﴾ [[Q024#10]]"
out2, removed2 = tafsir.keep_first_verse_link(back)
check("inline citations: a return to the verse is cited again",
      removed2 == 0 and out2.count("[[Q024#10]]") == 2, out2)

TWO_VERSES = ("وَمِنَ ٱلنَّاسِ مَن يُجَٰدِلُ فِى ٱللَّهِ بِغَيْرِ عِلْمٍ وَيَتَّبِعُ كُلَّ "
              "شَيْطَٰنٍ مَّرِيدٍ كُتِبَ عَلَيْهِ أَنَّهُۥ مَن تَوَلَّاهُ فَأَنَّهُۥ يُضِلُّهُۥ "
              "وَيَهْدِيهِ إِلَىٰ عَذَابِ ٱلسَّعِيرِ")
check("range: a two-verse quotation spans both verses",
      quran.find_verse_range(TWO_VERSES, 22, 3) == (3, 4),
      str(quran.find_verse_range(TWO_VERSES, 22, 3)))
check("range: it is cited as one range, not two links",
      "[[Q022#3|4]]" in quran.link_quote_citations(f"﴿{TWO_VERSES}﴾", ornate=True))

# A whole verse, then the same verse glossed term by term. The glossed terms are
# quotations of the verse under discussion, and a one-word fragment can only be
# recognised from that verse — never from a whole-muṣḥaf search. The short
# branch of the lookup matched the verse and then `break`-ed out of its loop,
# falling through to `return None`, so a fragment that demonstrably was the
# verse's words was silently discarded.
p16 = ("﴿وَكَذَلِكَ أَنزَلْنَاهُ آيَاتٍ بَيِّنَاتٍ وَأَنَّ اللَّهَ يَهْدِي مَن يُرِيدُ﴾\n\n"
       "*وكذلك* أي مثل ذلك الإنزال. *أنزلناه* أي القرآن الكريم كله. "
       "*آيات بينات* واضحات الدلالة.")
out3, _ = tafsir.process_quran(p16, mode="tafsir", delims=("*",))
check("cursor: an ornate quotation names the verse for the fragments that follow",
      out3.count("{.quran-quote}") == 4, out3)

# A one-word quotation is marked exactly like a parenthesised one: ornate
# parens, and the citation the run rule decides on. Nothing in the pipeline is
# allowed to skip it for being short.
out4, _ = tafsir.process_quran(p16, mode="tafsir", delims=("*",))
check("short fragment: a one-word gloss is an ornate quotation",
      "﴿وَكَذَٰلِكَ﴾{.quran-quote}" in out4, out4)

# ── Adjacent quotations are one quotation ───────────────────────────────────
# A typesetter sets a verse word by word in italics and a model marks it word by
# word inside the ornate parens. When the joined words are the verse's, in
# order and contiguous, they are one quotation with one citation after it —
# which is also what stops a range link landing between the two halves.
V20, V21, V22 = (quran.load_verse(22, n) for n in (20, 21, 22))
adjacent = f"﴿{V20} {V21}﴾﴿{V22}﴾ ثم"
joined_out, _ = tafsir.process_quran(adjacent, mode="tafsir", delims=("*",))
check("spans: adjacent quotations become one range",
      joined_out.count("{.quran-quote}") == 1 and "[[Q022#20|22]]" in joined_out,
      joined_out)
# An author who omits a word on purpose keeps two quotations: 22:18 reads
# `وَكَثِيرٌ مِّنَ ٱلنَّاسِ وَكَثِيرٌ حَقَّ عَلَيْهِ ٱلْعَذَابُ`, and the joined
# text is not contiguous in the verse, so it must not be joined.
elided = "قوله ﴿وَكَثِيرٌ مِّنَ ٱلنَّاسِ﴾﴿حَقَّ عَلَيْهِ الْعَذَابُ﴾ ثم"
elided_out, _ = tafsir.process_quran(elided, mode="tafsir", delims=("*",))
check("spans: a deliberate gap keeps two quotations",
      elided_out.count("{.quran-quote}") == 2, elided_out)

# ── A citation must be word-aligned ─────────────────────────────────────────
# `وهو كرا` normalises to `وهوكر`, a prefix of 2:216's `وهو كره`, so a substring
# search matches as if ا had been read as ه. It stops inside the word, so it is
# not that verse's words — and a one- or two-word span is never looked for
# outside the sūra under discussion in any case.
V18 = quran.load_verse(22, 18)
spurious = f"﴿{V18}﴾\n\nقليل إذا عدوا. ﴿وهو كرا﴾ ثم"
spurious_out, _ = tafsir.process_quran(spurious, mode="tafsir", delims=("*",))
check("citation: a span that ends inside a word is not cited",
      "[[Q002#216]]" not in spurious_out, spurious_out)
check("citation: a one- or two-word span is not searched across the muṣḥaf",
      quran._matches_cited_verses(2, 216, "وهو كرا") is False)


# ── Plain text between two quotations is not an italic span ─────────────────
# A `*` that sits against an ornate mark belongs to that quotation, so the star
# closing one span and the star opening the next do not make a pair. Gemini
# marked `وكثير` and `حق` and left `من الناس` plain — a gloss, because the verse
# repeats those words — and reading the gap as italics promoted it to a
# quotation of 22:18.
GLOSS_LINE = ("درنكر در سجود *﴿وكثير﴾* من الناس *﴿حق﴾* ثبت "
              "*﴿عليه العذاب﴾* بسبب كفره.")
gloss_out = quran.link_quote_citations(GLOSS_LINE, delims=("()", "*"),
                                       linear=True, ornate=False)
check("italics: plain text between two quotations is not a span",
      quran.QUOTE_DELIMS["*"].findall("*﴿وكثير﴾* من الناس *﴿حق﴾*") == [])
check("italics: the gloss between two quotations stays plain",
      "﴿مِّنَ ٱلنَّاسِ﴾" not in gloss_out and "من الناس" in gloss_out, gloss_out)
check("italics: a genuine italic span is still found",
      quran.QUOTE_DELIMS["*"].findall("قال في *«التأويلات»* ثم") == ["«التأويلات»"])


check("italics: a star that does not touch its words is not emphasis",
      quran.QUOTE_DELIMS["*"].findall("* هذا نص *") == []
      and quran.QUOTE_DELIMS["*"].findall("قال *نص* ثم") == ["نص"])
check("blockquote: a citation followed by a full stop keeps its closing brackets",
      post.blockquote_full_paragraphs(" [[Q022#21|:]]﴿نص﴾ [[Q022#21]] .")[0]
      == ">[!mas-quran]\n> [[Q022#21|:]]﴿نص﴾ [[Q022#21]]")


# ── A citation is repeated only after the same single-verse citation ────────
# A run of quotations from one verse is named once. A range is a different
# citation, so neither it nor the citation after it is a repeat.
for label, text, removed, links in (
        ("single then single", "﴿أ﴾ [[Q022#5]] ﴿ب﴾ [[Q022#5]]", 1, 1),
        ("single then range", "﴿أ﴾ [[Q022#5]] ﴿ب﴾ [[Q022#5|6]]", 0, 2),
        ("range then single", "﴿أ﴾ [[Q022#5|6]] ﴿ب﴾ [[Q022#5]]", 0, 2),
        ("range then range", "﴿أ﴾ [[Q022#5|6]] ﴿ب﴾ [[Q022#5|6]]", 0, 2)):
    out_run, n_run = tafsir.keep_first_verse_link(text)
    check(f"run: {label}", n_run == removed and out_run.count("[[Q022#") == links,
          f"{n_run} removed, {out_run}")

# ── A page-spanning quotation is marked where it opens ──────────────────────
PAGE1 = "#### p. 6\n\nقال: *\ufd3fوَيَوْمَ نُسَيِّرُ ٱلْجِبَالَ{.quran-quote}*"
PAGE2 = ("#### p. 7\n\nفَإِذَآ أَنزَلْنَا عَلَيْهَا ٱلْمَآءَ"
         "\ufd3e{.quran-quote}* [[Q022#5]] أي كذا.")
spanning, n_span = tafsir.insert_verse_headings(PAGE1 + "\n\n---\n\n" + PAGE2,
                                                linear=True, focus_surah=22)
check("page span: one marker", n_span == 1, spanning)
check("page span: the marker is on the page where the quotation opens",
      "قال: *[[Q022#5|:]]" in spanning, spanning)
check("page span: the citation stays where the quotation ends",
      spanning.split("---")[1].count("[[Q022#5]]") == 1, spanning)

# ── Gemini's other poetry shape: `a ** b` couplets ──────────────────────────
COUPLETS = ("كلام.\n\nألا يا صبا نجد متى هجت من نجد ** لقد زادني مسراك وجدا على وجد\n"
            "متى تذكريني يا ابنة الحي إنني ** وهبتك من بعد الرحيل يدي ودي\n\nبعد.")
couplet_out, n_couplets = post.format_poetry_couplets(COUPLETS)
check("poetry: a `**` couplet becomes a callout", n_couplets == 1, couplet_out)
check("poetry: both hemistiches of both lines are kept",
      couplet_out.count(">\t- ") == 4, couplet_out)
check("poetry: a bold run is not a couplet",
      post.format_poetry_couplets("**كلام عادي**")[1] == 0)

# ── A citation is the link alone ────────────────────────────────────────────
# The parentheses a reader sees are the renderer's cartouche. A literal pair in
# the note printed *around* that box, which is not a citation style.
check("citation: literal parentheses around a link are removed",
      quran.strip_citation_parentheses("قال ([[Q022#49|50]]) ثم")[0]
      == "قال [[Q022#49|50]] ثم")
check("citation: the older sūra-style link is treated the same",
      quran.strip_citation_parentheses("([[Surah 14#5|14 : ٥]])")[0]
      == "[[Surah 14#5|14 : ٥]]")
check("citation: prose parentheses are untouched",
      quran.strip_citation_parentheses("قال (وكذا) ثم")[0] == "قال (وكذا) ثم")
paren_out, _ = tafsir.process_quran("قوله: ([[Q022#49|50]]) ثم كلام.", mode="tafsir")
check("citation: the processed note carries the link alone",
      paren_out.startswith("قوله: [[Q022#49|50]]"), paren_out)

# ── The ۝ emblem does not belong inside a quotation ─────────────────────────
# In the muṣḥaf it is a marker holding the āya number; in a quotation the
# number is the margin's job, so an emblem left in prints an empty ornament.
check("emblems: a ۝ is removed from inside a quotation",
      post.strip_quote_emblems("﴿أ ۝ ب﴾") == "﴿أ ب﴾",
      post.strip_quote_emblems("﴿أ ۝ ب﴾"))
check("emblems: the number it carries goes with it",
      post.strip_quote_emblems("﴿أ ۝١٢ ب﴾") == "﴿أ ب﴾",
      post.strip_quote_emblems("﴿أ ۝١٢ ب﴾"))
check("emblems: an emblem outside a quotation is left alone",
      post.strip_quote_emblems("۝ ثم كلام") == "۝ ثم كلام")
E12, E13 = quran.load_verse(22, 12), quran.load_verse(22, 13)
emblem_out, _ = tafsir.process_quran(f"({E12} ۝ {E13} ۝)", mode="tafsir",
                                     delims=("()",))
check("emblems: a two-verse quotation joins without one",
      "۝" not in emblem_out and "[[Q022#12|13]]" in emblem_out, emblem_out)

# ── Tolerance for a letter or two in a long passage ─────────────────────────
# 22:27–28 as a transcription wrote it: `وذكروا` where the muṣḥaf has
# `ويذكروا` — one letter in 110, and exact matching rejected the passage whole.
LONG = ("وأذن في الناس بالحج يأتوك رجالا وعلى كل ضامر يأتين من كل فج عميق ۝ "
        "ليشهدوا منافع لهم وذكروا اسم الله في أيام معلومات على ما رزقهم من بهيمة "
        "الأنعام فكلوا منها وأطعموا البائس الفقير")
check("tolerance: a dropped letter in a long passage still matches",
      quran._matches_cited_verses(22, 27, LONG))
check("tolerance: the passage is cited as the range it covers",
      quran.find_verse_range(LONG, 22, 27) == (27, 28),
      str(quran.find_verse_range(LONG, 22, 27)))
# A different passage is not a 5% difference.
ALTERED = LONG.replace("على ما رزقهم من بهيمة الأنعام", "وما أكل السبع من شيء ولحم الخنزير")
check("tolerance: a different passage is not accepted",
      not quran._matches_cited_verses(22, 27, ALTERED))
# Below the length floor exactness is still required: three words that are
# almost right could equally be a different verse.
SHORT_TYPO = "ومن الناس من يقوك"
check("tolerance: a short span stays exact",
      not quran._matches_cited_verses(22, 11, SHORT_TYPO))

# A commentary sets a whole passage on a line of its own, marked however the
# source marked it — ornate parens, an italic span, or a stray leading `*` round
# a parenthesised quotation. The paragraph is quoted only when it holds nothing
# else; one word of prose keeps it a paragraph.
check("blockquote: a paragraph that is only a quotation",
      post.blockquote_full_paragraphs("﴿نص﴾ [[Q022#20|22]]")[0]
      == ">[!mas-quran]\n> ﴿نص﴾ [[Q022#20|22]]")
check("blockquote: the stray star and the source's parens are dropped",
      post.blockquote_full_paragraphs("* (﴿نص ۝﴾) .")[0]
      == ">[!mas-quran]\n> ﴿نص ۝﴾")
check("blockquote: prose round the quotation keeps it a paragraph",
      post.blockquote_full_paragraphs("كلام ﴿نص﴾ كلام")[0] == "كلام ﴿نص﴾ كلام")
check("blockquote: a plain block quote gains the callout header",
      post.blockquote_full_paragraphs("> ﴿نص﴾")[0] == ">[!mas-quran]\n> ﴿نص﴾")
check("blockquote: a marker and its citation both survive inside it",
      post.blockquote_full_paragraphs("[[Q022#20|:22]]﴿نص﴾ [[Q022#20|22]]")[0]
      == ">[!mas-quran]\n> [[Q022#20|:22]]﴿نص﴾ [[Q022#20|22]]")
check("blockquote: a poetry callout is not a Qur'ān callout",
      post.blockquote_full_paragraphs(">[!arabic-poetry]\n> نص")[0]
      == ">[!arabic-poetry]\n> نص")

# A page's verse number, set as text: the emblem was OCR'd as `(٥)`, and the
# formatter wrapped it as a superscript. Inside a paragraph that is only the
# quotation there is nothing for it to annotate, so it goes — unless the page
# defines that footnote, and unless the anchor shape (`<sup>5</sup>`, no
# bracket) carries it.
VERSE_NUMBER_QUOTE = ">[!mas-quran]\n> بَهِيجٍ﴾ [[Q022#5]]<sup>(٥)</sup>"
check("verse number: a trailing verse number leaves a quoted paragraph",
      post.blockquote_full_paragraphs(
          "#### p. 7\n\n" + VERSE_NUMBER_QUOTE + "\n")[0]
      == "#### p. 7\n\n>[!mas-quran]\n> بَهِيجٍ﴾ [[Q022#5]]")
check("verse number: a footnote the page defines is kept",
      "<sup>(٥)</sup>" in post.blockquote_full_paragraphs(
          "#### p. 7\n\n>[!arabic-footnotes]\n> - (٥) - حاشية\n\n"
          + VERSE_NUMBER_QUOTE + "\n")[0])
check("verse number: the anchor shape is never taken for one",
      "<sup>5</sup>" in post.blockquote_full_paragraphs(
          "#### p. 7\n\n>[!mas-quran]\n> بَهِيجٍ﴾ [[Q022#5]]<sup>5</sup>\n")[0])
check("verse number: prose round the quotation keeps it the paragraph",
      post.blockquote_full_paragraphs(
          "#### p. 7\n\n﴿بَهِيجٍ﴾ [[Q022#5]](٥) أي كذا.\n")[0]
      == "#### p. 7\n\n﴿بَهِيجٍ﴾ [[Q022#5]](٥) أي كذا.\n")

# One hook for every genre: the shared quotation finisher applies it, so a
# repository note, a transcription and a translation all present it the same way.
check("blockquote: unwrap_quran_quotes applies it",
      post.unwrap_quran_quotes("﴿نص﴾ [[Q022#20|22]]").startswith(">[!mas-quran]"))


# ── A Farsi yeh is a yāʾ, and a two-word opening can anchor a page ──────────
# A Persian-influenced OCR writes the yāʾ as U+06CC, which the Uthmanic faces
# have no glyph for (`﴿خیر﴾` renders as a missing character). It is a yāʾ, not
# an alif, so it folds like one — and a quotation carrying it is then written in
# the muṣḥaf's own letters.
check("farsi yeh: folds to the Arabic yāʾ",
      quran.normalize_arabic("خیر") == quran.normalize_arabic("خَيْرٌ"))
OPENING = "﴿فَإِنْ أَصَابَهُۥ﴾ (پيس اگر برسد اورا) (خیر) أي ديني من الصحة."
opening_out, _ = tafsir.process_quran(OPENING, mode="tafsir", delims=("()", "*"))
check("two words: a two-word opening anchors the page",
      "[[Q022#11" in opening_out, opening_out)
check("farsi yeh: the quotation is written in the muṣḥaf's letters",
      "﴿خَيْرٌ﴾{.quran-quote}" in opening_out, opening_out)
check("farsi yeh: the Farsi spelling is not left inside the quotation",
      "﴿خیر﴾" not in opening_out, opening_out)


# ── A sūra heading is a constraint, not a verse ─────────────────────────────
# When nothing on the page has been located, the last heading that names a sūra
# narrows the search to that sūra, from its first verse. The heading *level* is
# ignored — a transcription's levels are not consistent — and a line whose name
# the notes do not carry is not a heading at all.
HEAD_DOC = "## سورة الحاقة\n\n*وَمَا أَدْرَاكَ مَا* أي يوم القيامة."
check("heading: a sūra name is read from the heading, whatever its level",
      quran.surah_headings(HEAD_DOC) == [(0, 69)],
      str(quran.surah_headings(HEAD_DOC)))
check("heading: a name that is not a sūra is not a heading",
      quran.surah_headings("## سورة الحمد لله رب\n") == [])
# This span is three words and occurs in several sūras, so the whole-Qur'ān
# search rejects it as too common; only the heading can place it.
check("heading: without it the span does not resolve",
      quran.find_verse_in_text("وَمَا أَدْرَاكَ مَا") == [])
head_out, _ = tafsir.process_quran(HEAD_DOC, mode="tafsir", delims=("*",))
check("heading: the sūra places the quotation and it is cited",
      "[[Q069#3]]" in head_out and "{.quran-quote}" in head_out, head_out)
# A sūra is a much weaker hint than a verse: a short phrase would resolve to the
# first verse in that sūra that happens to contain it, so it is not allowed to
# use it.
SHORT_HEAD = "## سورة البقرة\n\n*الحمد لله* ثم"
check("heading: a short phrase does not use the sūra hint",
      quran.link_quote_citations(SHORT_HEAD, delims=("*",), linear=True,
                                 ornate=False) == SHORT_HEAD)
# Alif maqṣūra is a long ā, not a yāʾ — the muṣḥaf's `أَدْرَىٰكَ` against a
# modern `أدراك`, and `أراك`/`أرىك`, are the same word written two ways.
check("rasm: alif maqṣūra is a long ā",
      quran.normalize_arabic("أدراك") == quran.normalize_arabic("أَدْرَىٰكَ"))
check("rasm: a final yāʾ and alif maqṣūra agree (فى / في)",
      quran.normalize_arabic("فى") == quran.normalize_arabic("في"))
# The rasm wāw is the one variation that is a real letter, not a notation:
# `الحياة` writes alif where the muṣḥaf writes wāw. The fold is a short list of
# word endings, because a blanket rule would also rewrite `وجوه`, `قوة` and
# `فكذبوه` (232 word forms) and merge forms that are genuinely different.
for modern, uthmani in (("الحياة", "ٱلْحَيَوٰةِ"), ("الصلاة", "ٱلصَّلَوٰةَ"),
                        ("الزكاة", "ٱلزَّكَوٰةَ"), ("المشكاة", "ٱلْمِشْكَوٰةِ"),
                        ("النجاة", "ٱلنَّجَوٰةَ"), ("الغداة", "ٱلْغَدَوٰةَ"),
                        ("الربا", "ٱلرِّبَوٰا")):
    check(f"rasm wāw: {modern} matches the muṣḥaf",
          quran.normalize_arabic(modern) == quran.normalize_arabic(uthmani),
          f"{quran.normalize_arabic(modern)} / {quran.normalize_arabic(uthmani)}")


# A page that opens in the middle of a commentary: the verse itself is quoted on
# the *next* page, so nothing in the leading glosses can be located when they
# are read. They are recovered once that quotation resolves, through the same
# rules, against the verse it names.
RECOVER_VERSE = quran.load_verse(22, 16)
recover = ("#### p. 6\n\n*وكذلك* أي مثل ذلك. *أنزلناه* أي القرآن.\n\n---\n\n"
           f"#### p. 7\n\n﴿{RECOVER_VERSE}﴾")
recovered = quran.link_quote_citations(recover, delims=("*",), linear=True,
                                       ornate=False)
check("rewind: glosses before the page's quotation are recovered",
      recovered.count("{.quran-quote}") == 3, recovered)
unrelated = ("#### p. 6\n\n*الكلام* أي لفظ مركب. *الاسم* أي ما دل على معنى.\n\n"
             "---\n\n" f"#### p. 7\n\n﴿{RECOVER_VERSE}﴾")
check("rewind: unrelated glosses stay prose",
      quran.link_quote_citations(unrelated, delims=("*",), linear=True,
                                  ornate=False).count("{.quran-quote}") == 1)


# A one- or two-letter word (`من`, `ثم`, `لا`) cannot be located by its letters
# at all, and must never be sent to a whole-muṣḥaf search. It is still a
# quotation when the commentary is *at* it: the word its glossing has reached,
# or the first word of a verse it has quoted in full. Position is the evidence.
V4 = quran.load_verse(22, 4)
sequential = f"﴿{V4}﴾\n\n*كتب* عليهم، *أنه* أي الشأن، *من* أي بعض."
seq_out = quran.link_quote_citations(sequential, delims=("*",), linear=True, ornate=False)
check("short word: the first word of a full verse is the next quotation",
      f"﴿{V4.split()[0]}﴾{{.quran-quote}}" in seq_out, seq_out)
check("short word: a gloss may skip the words it does not discuss",
      f"﴿{V4.split()[2]}﴾{{.quran-quote}}" in seq_out
      and f"﴿{V4.split()[3]}﴾{{.quran-quote}}" in seq_out, seq_out)
backwards = f"﴿{V4}﴾\n\n*السعير* أي النار، *من* هنا ليست مقصودة."
back_out = quran.link_quote_citations(backwards, delims=("*",), linear=True, ornate=False)
check("short word: never taken from a word already passed",
      f"﴿{V4.split()[3]}﴾" not in back_out, back_out)

# The tashkīl of a word identified by position is the *verse's* word, not the
# first word that happens to share its letters: 2:8 has `وَمِنَ … مَن`, and the
# gloss runs through them in order.
V28 = quran.load_verse(2, 8)
ordered = f"﴿{V28}﴾\n\n*ومن* أي وبعض، *الناس* أي الكفار، *من* أي بعضهم."
ordered_out = quran.link_quote_citations(ordered, delims=("*",), linear=True, ornate=False)
check("short word: tashkīl comes from the matched slot (مَن not مِن)",
      f"﴿{V28.split()[2]}﴾{{.quran-quote}}" in ordered_out, ordered_out)


# Each of these resolved and was then rejected by the word-boundary gate,
# because the muṣḥaf writes a doubled letter where modern typography writes one
# (or the article's lām merged under a shadda). The fold is in the normaliser,
# applied to both sides; the query is never respelled after the fact.
for label, quote, surah, verse in (
        ("a doubled letter (أيام / أَيَّىٰم)", "وَذَكِّرْهُمْ بِأَيَّامِ اللَّهِ", 14, 5),
        ("a merged article lām (الليل / ٱلَّيْلَ)", "الليل والنهار خلفة", 25, 62),
        ("the plural wāw (جاؤوا / جَآءُو)", "إن الذين جاؤوا بالإفك", 24, 11)):
    check(f"rasm: {label}",
          quran.words_in_sequence(quran.load_verse(surah, verse), quote))

# A doubled letter must not be folded into a *different* word: the pair below
# differs in a real consonant, and stays distinct.
check("rasm: the fold does not merge different words",
      quran.normalize_arabic("قل") != quran.normalize_arabic("كل"))

# …and the run-squeeze has to cross a *word boundary* too. A transcription
# writes `يا أيها` for the muṣḥaf's single `يَٰٓأَيُّهَا`; squeezing each word on
# its own left `ييهلنس` against the verse's `يهلنس`, so the phrase resolved
# nowhere and was never marked.
check("rasm: a run that crosses a word boundary is squeezed",
      quran.normalize_arabic("يا أيها الناس") == quran.normalize_arabic("يَٰٓأَيُّهَا ٱلنَّاسُ"))
check("rasm: `يا أيها الناس` is 22:5's words",
      quran.words_in_sequence(quran.load_verse(22, 5), "يا أيها الناس"))


# A short phrase that recurs in several verses is still found when the caller
# knows the verse under discussion — the run rule, not the phrase's length, is
# what stops a second citation.
RECURRING = "وَمِمَّا رَزَقْنَاهُمْ يُنفِقُونَ"
check("short phrase: no length filter when the verse is known",
      bool(quran.find_verse_in_text(RECURRING, hint_surah=2, hint_verse=3)))

# ── The source's own citations are removed, not left beside ours ────────────
for shape in (r"قال: \[النمل: ٨] وكانت",
              "قال ﴿أُو۟لَٰٓئِكَ﴾ [[Q023#10]] *\\[المؤمنون: ١٠]* ولما"):
    cleaned, n = quran.strip_gemini_refs(shape)
    check(f"gemini ref: removed ({shape[:18]}…)", n == 1 and ": ٨" not in cleaned
          and ": ١٠" not in cleaned, cleaned)
check("gemini ref: an editorial aside is not a citation",
      quran.strip_gemini_refs("قال في [غافل شود وفراموش كند] أي")[1] == 0)
check("gemini ref: a wikilink is never touched",
      quran.strip_gemini_refs("وقال: [[Q022#36]] ثم")[1] == 0)

# ── A closing half is part of the run too ───────────────────────────────────
# The page-spanning quotation is cited where it ends, and the paragraph after it
# quotes the same verse again. The dedupe has to see the closing half or the
# verse is cited twice in a row.
SPAN_RUN = ("قد قيل كلام.\n\n"
            "فَإِذَآ أَنزَلْنَا عَلَيْهَا ٱلْمَآءَ﴾{.quran-quote}* [[Q022#5]]\n\n"
            "*﴿يَٰٓأَيُّهَا ٱلنَّاسُ﴾{.quran-quote}* [[Q022#5]] يا أهل مكة.")
span_run_out, n_span_run = tafsir.keep_first_verse_link(SPAN_RUN)
check("page span: the citation after a closing half is not repeated",
      n_span_run == 1 and span_run_out.count("[[Q022#5]]") == 1, span_run_out)

# ── An opening half takes the muṣḥaf's vocalisation and its callout ─────────
# The half is long, and one OCR slip in it (`مُلَّخَّقَة` for `مُّخَلَّقَة`) makes
# the span fail verification as a whole — which used to leave the source's own
# `يَا أَيّهَا` (with a space the muṣḥaf does not have) inside the quotation.
OPENING_HALF = (
    "يَا أَيّهَا النَّاسُ إِن كُنتُمْ فِي رَيْبٍ مِّنَ الْبَعْثِ فَإِنَّا خَلَقْنَاكُم مِّن تُرَابٍ "
    "ثُمَّ مِن نُّطْفَةٍ ثُمَّ مِنْ عَلَقَةٍ ثُمَّ مِن مُّضْغَةٍ مُّلَّخَّقَةٍ وَغَيْرِ مُخَلَّقَةٍ "
    "لِّنُبَيِّنَ لَكُمْ ۚ وَنُقِرُّ فِي الْأَرْحَامِ مَا نَشَاءُ إِلَىٰ أَجَلٍ مُّسَمًّى ثُمَّ "
    "نُخْرِجُكُمْ طِفْلًا ثُمَّ لِتَبْلُغُوا أَشُدَّكُمْ ۖ وَمِنكُم مَّن يُتَوَفَّىٰ وَمِنكُم مَّن "
    "يُرَدُّ إِلَىٰ أَرْذَلِ الْعُمُرِ")
canonical_half = quran.canonical_open_words(OPENING_HALF, 22, 5) or ""
check("opening half: the muṣḥaf's letters replace the OCR's",
      "يَا أَيّهَا" not in canonical_half
      and quran.words_in_sequence(quran.load_verse(22, 5),
                                  " ".join(canonical_half.split()[:8])),
      canonical_half[:80])
check("opening half: an OCR slip inside the span is corrected too",
      "مُّلَّخَّقَةٍ" not in canonical_half, canonical_half)

# The page-7 half is a paragraph of pure quotation: marker, a stray star from
# the split, the citation and the page's own verse number. Each half of a
# page-spanning quotation is a callout in its own right.
CLOSING_HALF = ("[[Q022#5|:]]*لِكَيْلَا يَعْلَمَ مِنۢ بَعْدِ عِلْمٍ شَيْـًٔا وَتَرَى ٱلْأَرْضَ "
                "هَامِدَةً بَهِيجٍ﴾ [[Q022#5]]<sup>(٥)</sup>")
half_out, n_half = post.blockquote_full_paragraphs(CLOSING_HALF)
check("page span: the closing half is its own callout", n_half == 1
      and half_out.startswith(">[!mas-quran]\n> [[Q022#5|:]]لِكَيْلَا"), half_out)
check("page span: one word of prose keeps it a paragraph",
      post.blockquote_full_paragraphs(
          "[[Q022#5|:]]*بَهِيجٍ﴾ [[Q022#5]] أي كذا.")[1] == 0)

# A re-render reads the callouts it wrote last time: the marker belongs at the
# opening of the quotation, on the page before, and must settle there.
RENDERED_PAGES = (
    "#### p. 6\n\n>[!mas-quran]\n> [[Q022#5|:]]﴿يَٰٓأَيُّهَا ٱلنَّاسُ إِن كُنتُمْ\n\n"
    "---\n\n#### p. 7\n\n>[!mas-quran]\n> لِكَيْلَا يَعْلَمَ بَهِيجٍ﴾ [[Q022#5]]\n")
settled, n_settled = tafsir.insert_verse_headings(RENDERED_PAGES, linear=True,
                                                  focus_surah=22)
check("re-render: the marker stays at the opening half inside its callout",
      n_settled == 1 and "> [[Q022#5|:]]﴿يَٰٓأَيُّهَا" in settled, settled)
check("re-render: a second pass changes nothing",
      tafsir.insert_verse_headings(settled, linear=True, focus_surah=22)[0] == settled)

# ── A translation's own verse references become citations ───────────────────
# A translation of a tafsīr carries the source's references as text — `(001:4)`
# after the quotation — because the model had no link syntax. The parenthesis
# has to touch a quotation, so a time in prose is never taken for a citation.
for label, text, links in (
        ("after the quotation", "﴿Master of the Day﴿ (001:4) and more", 1),
        ("a range", "…﴿ (002:80–82) after", 1),
        ("a time in prose", "he arrived at (2:30) in the afternoon", 0),
        ("no such sūra", "…﴿ (115:4) after", 0)):
    out_refs, n_refs = post.link_bare_refs(text)
    check(f"translation refs: {label}", n_refs == links and out_refs.count("[[Q") == links,
          out_refs)
check("translation refs: the range keeps its end",
      "[[Q002#80|82]]" in post.link_bare_refs("…﴿ (002:80–82) after")[0])

# ── A translation's footnotes are the ordinary kind, once ───────────────────
# Gemini sometimes writes an empty `footnotes` callout and the content under
# `arabic-footnotes`, which is styled right-to-left although the text is
# English. The Arabic name is a mislabel in a translation.
FOOTNOTES = (
    "Text.\n\n>[!footnotes]\n\n>[!arabic-footnotes]\n> - 1 – A note.\n\n"
    "---\n\n#### p. 31\n\nMore.\n\n>[!footnotes]\n>- 1 – A note.\n"
    ">- 2 – Another.\n> - 1 –\n\nAfter.\n")
notes_out, n_notes = post.normalize_translation_footnotes(FOOTNOTES)
check("translation footnotes: no arabic callout survives",
      "[!arabic-footnotes]" not in notes_out, notes_out)
check("translation footnotes: each page has one callout",
      notes_out.count(">[!footnotes]") == 2, notes_out)
check("translation footnotes: the repeated note is written once",
      notes_out.count("A note.") == 2, notes_out)
check("translation footnotes: an empty item is dropped",
      "> - 1 –\n" not in notes_out.replace(">- 1 – A note.", ""), notes_out)
check("translation footnotes: an Arabic note is left alone",
      post.normalize_translation_footnotes(">[!arabic-footnotes]\n> - 1 – نص")[1] > 0)

# ── A page heading that swallowed its page's first paragraph ────────────────
# Gemini sometimes omits the break after `#### p. N`, and the text joins the
# heading, where it is styled as a heading and loses its paragraph.
swallowed, n_swallowed = post.split_page_headings("#### p. 12 والثالث: معرفة الدنيا")
check("page heading: the swallowed text becomes a paragraph",
      n_swallowed == 1 and swallowed == "#### p. 12\n\nوالثالث: معرفة الدنيا", swallowed)
# `p. N` is deliberate and means the heading is the page and nothing else, so
# anything after it is a missing break — including a sūra name.
check("page heading: a sūra name after the number is split off",
      post.split_page_headings("#### p. 13 سورة الفاتحة")[0]
      == "#### p. 13\n\nسورة الفاتحة")
check("page heading: Latin text after the number is split off",
      post.split_page_headings("#### p. 14 Sūrat al-Fātiḥa")[0]
      == "#### p. 14\n\nSūrat al-Fātiḥa")

# A run of ornate parentheses is what an interrupted render leaves behind; one
# mark is all a quotation has.
check("ornate run: a run of closers collapses to one",
      post.collapse_ornate_runs("﴾" * 67 + " نص")[0] == "﴾ نص")

# ── A heading that is really prose ──────────────────────────────────────────
# Gemini sometimes sets a passage as a section heading: the commentary loses its
# paragraphs, and the quotation inside it is styled as a label.
PROSE_HEADING = ("### يا أيها الناس ضرب مثل أي: بين لكم حالة مستغربة أو قصة بديعة "
                 "حقيقة بأن تسمى مثلاً وتصير في الأمصار والأعصار. "
                 "﴿فَٱسْتَمِعُوا۟ لَهُۥٓ﴾ [[Q022#73]] أي: للمثل استماع تدبر وتفكر.")
demoted, n_demoted = post.demote_prose_headings(PROSE_HEADING)
check("heading: a passage set as a heading becomes a paragraph",
      n_demoted == 1 and not demoted.startswith("#"), demoted[:60])
check("heading: a short label stays a heading",
      post.demote_prose_headings("## A Short Heading")[1] == 0)
check("heading: a heading carrying a verse citation is demoted",
      post.demote_prose_headings("## See ﴿نص﴾ [[Q002#255]]")[1] == 1)

# ── A short bold paragraph is a heading ─────────────────────────────────────
# Gemini sees one page at a time and cannot know the document's structure, so it
# marks a section title by bolding it. As a paragraph it can be combined with the
# paragraph after it, which loses both the emphasis and the break.
check("bold paragraph: a short bold line becomes a section heading",
      post.bold_paragraphs_to_headings("**Methodology**")[0] == "### Methodology")
check("bold paragraph: a bold line inside a callout is left alone",
      post.bold_paragraphs_to_headings("> **In a callout**")[1] == 0)
check("bold paragraph: emphasis inside prose is left alone",
      post.bold_paragraphs_to_headings("A **bold** word in prose.")[1] == 0)
check("bold paragraph: a long bolded sentence is emphasis, not a title",
      post.bold_paragraphs_to_headings("**" + "كلمة " * 30 + "**")[1] == 0)
check("bold paragraph: a bold link is markup, not a heading",
      post.bold_paragraphs_to_headings("**[[Q022#5|:]]**")[1] == 0)
check("bold paragraph: the paragraph after it is untouched",
      post.bold_paragraphs_to_headings("**Methodology**\n\nAfter these two epistles.")[0]
      == "### Methodology\n\nAfter these two epistles.")

# ── Balancing ornate parens respects the note's direction ───────────────────
# A translation writes `﴾quote﴿`; balancing by the Arabic convention deleted every
# closer and appended one per surviving opener at the end of the note, which is
# the long `﴾` run that appeared after a note body was re-processed.
check("balance: an Arabic pair is left alone",
      quran.balance_ornate_parens("﴿نص﴾ كلام") == ("﴿نص﴾ كلام", 0))
reversed_note = "﴾a quote﴿ and ﴾another﴿"
check("balance: a reversed (translated) note is left alone",
      quran.balance_ornate_parens(reversed_note) == (reversed_note, 0))
check("balance: a stray closer in an Arabic note is still dropped",
      quran.balance_ornate_parens("كلام ﴾ ثم")[0] == "كلام ثم")

# ── Emblem stripping reads the pair the way the note writes it ──────────────
# In a translation the pair is reversed, so pairing a closer with the next
# opener made one "quotation" of everything between two quotes — and the
# citation link inside it lost its digits (`[[Q001#2]]` → `[[Q # ]`).
TRANSLATED_QUOTES = "﴾Lord of all worlds﴿ [[Q001#2]] is tawḥīd. ﴾The Most Gracious﴿ [[Q001#3]] is waʿd."
check("emblems: a reversed note keeps its links intact",
      "[[Q001#2]]" in post.strip_quote_emblems(TRANSLATED_QUOTES)
      and "[[Q # ]" not in post.strip_quote_emblems(TRANSLATED_QUOTES),
      post.strip_quote_emblems(TRANSLATED_QUOTES))
check("emblems: an Arabic pair still loses its emblem",
      post.strip_quote_emblems("﴿نص ۝﴾") == "﴿نص﴾")
# An asterisk inside a quotation is markup debris: quotation text is gilded, not
# emphasised, and a star left behind opens an italic run over the next prose.
check("emblems: a star inside a quotation is removed",
      post.strip_quote_emblems("﴾their protectors are al-ṭāghūt*, who lead them﴿")
      == "﴾their protectors are al-ṭāghūt, who lead them﴿")
check("emblems: a star inside an Arabic quotation is removed",
      post.strip_quote_emblems("﴿نص * غريب﴾") == "﴿نص غريب﴾")

# ── The ornate pair is read mark by mark, not by the note's direction ───────
# One text can hold both conventions: a translation writes `﴾quote﴿`, and an
# Arabic verse quoted inside it is written `﴿quote﴾`. Pairing each mark with the
# next mark of the other kind is right either way round, and never pairs one
# quotation's closer with the next quotation's opener — a span that swallowed
# the prose and the citation links between them.
MIXED_PAIRS = "﴿بِسْمِ ٱللَّهِ﴾ [[Q001#1]] and then ﴾Lord of all worlds﴿ [[Q001#2]]"
check("emblems: a forward pair and a reversed pair both keep their links",
      post.strip_quote_emblems(MIXED_PAIRS) == MIXED_PAIRS,
      post.strip_quote_emblems(MIXED_PAIRS))
check("emblems: a Latin pair loses no digit",
      post.strip_quote_emblems("﴿SENEGAL B.P. N° 1﴾") == "﴿SENEGAL B.P. N° 1﴾")
check("emblems: a verse number set as text is removed from an Arabic quotation",
      post.strip_quote_emblems("﴿نص عربي (٤٩) هنا﴾") == "﴿نص عربي هنا﴾")

# ── The model's backticks are the vault's quotes ────────────────────────────
# They arrive as emphasis and Markdown sets them in code type; the vault quotes
# with the single curly pair.
check("backticks: an inline term becomes ‘…’",
      post.backticks_to_quotes("named himself `Raḥmān al-Yamāmah` (the")[0]
      == "named himself ‘Raḥmān al-Yamāmah’ (the")
check("backticks: a couplet's marks become ‘…’ across its two lines",
      post.backticks_to_quotes(">- `We desire that He accompany us\n>\t- by remembrance`")[0]
      == ">- ‘We desire that He accompany us\n>\t- by remembrance’")
FENCED = "```\ncode `x` here\n```"
check("backticks: a fenced block is left alone",
      post.backticks_to_quotes(FENCED)[0] == FENCED)

# ── One footnotes callout, named `footnotes`, and no page label ─────────────
check("footnotes: a page label before the callout is dropped",
      post.normalize_translation_footnotes("Prose.\n\nFootnotes:\n\n>[!arabic-footnotes]\n> - 1 – a note.")[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – a note.")
check("footnotes: a label with no callout becomes one",
      post.normalize_translation_footnotes("Prose.\n\n**Footnotes:**\n\n> - 1 – a note.")[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – a note.")
check("footnotes: an empty callout beside the Arabic one is merged away",
      post.normalize_translation_footnotes("Prose.\n\n>[!footnotes]\n\n>[!arabic-footnotes]\n> - 1 – a note.")[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – a note.")
check("footnotes: a label standing alone is simply dropped",
      post.normalize_translation_footnotes("Prose.\n\nFootnotes:\n\nMore prose.")[0]
      == "Prose.\n\nMore prose.")

# ── A citation the model wrote in the vault's old sūra names ────────────────
# `([[004 An-Nisa#29|al-Nisāʾ: 29]])` names a note that was renamed, so the
# link is unresolved and its alias is the model's own. The number in the name
# is the sūra; the canonical note is `Q004`, and the plugin paints the text.
check("legacy: an old sūra name becomes the canonical note",
      render.normalize_quran_link_display("there. ([[004 An-Nisa#29|al-Nisāʾ: 29]]) in")[0]
      == "there. [[Q004#29]] in")
check("legacy: an Arabic alias goes with it",
      render.normalize_quran_link_display("([[006 Al-An'am#63|الأنعام : ٦٣]])")[0]
      == "[[Q006#63]]")
check("legacy: a canonical link is untouched",
      render.normalize_quran_link_display("[[Q004#29]] stays")[0] == "[[Q004#29]] stays")

# ── The muṣḥaf's divider is not a word of the quotation ─────────────────────
check("emblems: a translated quotation does not print ۞",
      post.strip_quote_emblems("﴾۞That﴿ [[Q022#60]]") == "﴾That﴿ [[Q022#60]]")

# ── The page label the model puts above the footnotes ───────────────────────
# It writes `Footnotes:` in four shapes, and a page can end up as a bare
# blockquote of items with the label above them — no callout at all, which is
# what the reader saw as "Footnotes: still there, the heading gone".
LABELLED = "Prose.\n\n> Footnotes:\n> - 1 – It is narrated from Abū Hurayrah."
check("footnotes: a label inside the items' blockquote becomes the callout",
      post.normalize_translation_footnotes(LABELLED)[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – It is narrated from Abū Hurayrah.")
check("footnotes: a label inside a callout is dropped",
      post.normalize_translation_footnotes(">[!footnotes]\n>Footnotes:\n> - 1 – A.")[0]
      == ">[!footnotes]\n> - 1 – A.")
check("footnotes: the source-language label is the same label",
      post.normalize_translation_footnotes("> **Arabic Footnotes**\n> 1 – A.")[0]
      == ">[!footnotes]\n> - 1 – A.")
check("footnotes: an item written without its bullet becomes a list item",
      post.normalize_translation_footnotes(">[!footnotes]\n>Footnotes:\n>1 – One.")[0]
      == ">[!footnotes]\n> - 1 – One.")
# A `Footnotes` heading is the model's label, never a section title: on every
# page of this corpus that has one, the source page has no heading at all.
check("footnotes: a Footnotes heading over prose is a label and goes",
      post.normalize_translation_footnotes("### Footnotes\n\nText.")[0] == "Text.")
check("footnotes: definitions written as numbered paragraphs become the callout",
      post.normalize_translation_footnotes(
          "Prose.\n\n### Footnotes\n\n<sup>1</sup> First note.\n\n<sup>2</sup> Second note.\n\n---")[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – First note.\n> - 2 – Second note.\n\n---")
check("footnotes: the model's own `arabic-footnotes` heading is the same label",
      post.normalize_translation_footnotes(
          "---\n\n#### arabic-footnotes\n\n<sup>1</sup> First note.\n\n<sup>2</sup> Second note.\n\n---")[0]
      == "---\n\n>[!footnotes]\n> - 1 – First note.\n> - 2 – Second note.\n\n---")
check("footnotes: superscript-digit definitions become the callout",
      post.normalize_translation_footnotes("Prose.\n\n##### Footnotes\n\n¹ A note.\n\n---")[0]
      == "Prose.\n\n>[!footnotes]\n> - 1 – A note.\n\n---")
check("footnotes: a Footnotes heading over the callout goes",
      post.normalize_translation_footnotes("#### Footnotes\n\n>[!footnotes]\n> - 1 – A.")[0]
      == ">[!footnotes]\n> - 1 – A.")
_clean = post.normalize_translation_footnotes(LABELLED)[0]
check("footnotes: the pass is idempotent",
      post.normalize_translation_footnotes(_clean) == (_clean, 0))

# A page whose list never became a callout at all: the items are a plain
# blockquote, with no header and no label. The page's own <sup> anchors are the
# evidence, and the numbers have to agree — a partial match is left alone.
UNLABELLED = "Body text. <sup>1</sup>\n\n>1 – The ḥadīth of al-Mubāhala.\n\n---\n\nNext."
check("footnotes: an unlabelled list that answers the page's anchor gets a callout",
      post.normalize_translation_footnotes(UNLABELLED)[0]
      == "Body text. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – The ḥadīth of al-Mubāhala.\n\n---\n\nNext.")
MISMATCHED = "Body text. <sup>2</sup>\n\n>1 – Something else.\n\n---\n\nNext."
check("footnotes: a list that does not match the anchors is left alone",
      post.normalize_translation_footnotes(MISMATCHED)[0] == MISMATCHED)
# The model often omits the body's `<sup>` anchors entirely. A numbered list
# that ends the page is still that page's footnotes: it starts at 1, runs
# consecutively, and the page has no anchors to disagree with.
PAGE_END = "Body text.\n\n>1 – First note.\n> 2 – Second note.\n\n---\n\nNext."
check("footnotes: a list ending the page needs no anchors",
      post.normalize_translation_footnotes(PAGE_END)[0]
      == "Body text.\n\n>[!footnotes]\n> - 1 – First note.\n> - 2 – Second note.\n\n---\n\nNext.")
MID_PAGE = ">1 – One.\n> 2 – Two.\n\nMore prose.\n\n---"
check("footnotes: the same list mid-page is not a footnote list",
      post.normalize_translation_footnotes(MID_PAGE)[0] == MID_PAGE)
# The model also drops *some* anchors: the list may cover more verses than the
# body marks. What it may never do is leave an anchor out of the list.
PARTIAL = "Body. <sup>1</sup>\n\n> 1 – One.\n>\n> 2 – Two.\n\n---\n\nNext."
check("footnotes: a list that covers the page's anchors is enough",
      post.normalize_translation_footnotes(PARTIAL)[0]
      == "Body. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---\n\nNext.")
# A list that restarts at 1 is two lists the model merged (a page's notes and
# a translated one); they belong to the same callout. A *gap* is the signal that
# the block is not a footnote list at all.
TWO_LISTS = "Body.\n\n>1 – One.\n>2 – Two.\n>1 – Other.\n>2 – Other two.\n\n---"
check("footnotes: a list that restarts at 1 is one callout",
      post.normalize_translation_footnotes(TWO_LISTS)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n> - 1 – Other.\n> - 2 – Other two.\n\n---")
GAPPED = "Body.\n\n>1 – One.\n>3 – Three.\n\n---"
check("footnotes: a gap in the numbering is not a footnote list",
      post.normalize_translation_footnotes(GAPPED)[0] == GAPPED)
PERIODS = "Body.\n\n>1. Aḥmad transmitted.\n>2. Mālik transmitted.\n\n---"
check("footnotes: items numbered with a period are items",
      post.normalize_translation_footnotes(PERIODS)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – Aḥmad transmitted.\n> - 2 – Mālik transmitted.\n\n---")
REPEATED = "Body.\n\n>1 – One.\n>2 – Two.\n>2 – Two.\n\n---"
check("footnotes: a verbatim repeated item is one item",
      post.normalize_translation_footnotes(REPEATED)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---")
NOT_FROM_ONE = "Body.\n\n>2 – Two.\n>3 – Three.\n\n---"
check("footnotes: a list that does not start at 1 is left alone",
      post.normalize_translation_footnotes(NOT_FROM_ONE)[0] == NOT_FROM_ONE)

# The model sometimes spells the callout as tags around bare definitions.
TAGGED = ("Body. <sup>1</sup>\n\n<arabic-footnotes>\n¹ – One.\n² – Two.\n"
          "</arabic-footnotes>\n\n---\n\nNext.")
check("footnotes: a tag-shaped wrapper becomes the callout",
      post.normalize_translation_footnotes(TAGGED)[0]
      == "Body. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---\n\nNext.")
UNCLOSED = "Body.\n\n<footnotes>\n¹ – One.\n\n---\n\nNext."
check("footnotes: an unclosed wrapper stops at the page rule",
      post.normalize_translation_footnotes(UNCLOSED)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n\n---\n\nNext.")

# The model's own spellings of the container, and a list glued to the prose
# above it (no blank line), which used to leave the header inside the paragraph.
GLUED = "Body text ends.\n> 1 – One.\n> 2 – Two.\n\n---"
check("footnotes: a list glued to the prose gets its own block",
      post.normalize_translation_footnotes(GLUED)[0]
      == "Body text ends.\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---")
check("footnotes: `[!Arabic Footnotes]` is the same callout",
      post.normalize_translation_footnotes("Body. <sup>1</sup>\n\n>[!Arabic Footnotes]\n> 1 – One.\n\n---")[0]
      == "Body. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – One.\n\n---")
check("footnotes: a `> ### Footnotes` heading is a label too",
      post.normalize_translation_footnotes("Body.\n\n> ### Footnotes\n> 1 – One.\n\n---")[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n\n---")

# Two numeral forms and a star bullet the model also writes; each becomes the
# callout's list form, and the pass settles in one run.
SUPER = "Body.\n\n> - ¹ – One.\n> - ² – Two.\n\n---"
check("footnotes: superscript-numbered items are items",
      post.normalize_translation_footnotes(SUPER)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---")
STARRED = "Body.\n\n> *   1 – First.\n> *   2 – Second.\n\n---"
check("footnotes: a starred bullet is a list marker",
      post.normalize_translation_footnotes(STARRED)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – First.\n> - 2 – Second.\n\n---")
NORMAL = post.normalize_translation_footnotes(SUPER)[0]
check("footnotes: normalising the items settles",
      post.normalize_translation_footnotes(NORMAL) == (NORMAL, 0))

# ── Translation: one page per request ───────────────────────────────────────
# A page's own headings are content, not boundaries. Splitting at `##`/`###` cut
# a page into pieces that travelled as separate requests with no page heading,
# and two pages in one context let the model attach one page's footnotes to the
# next page's section.
TWO_PAGES = ("#### p.\u202f40\n\nBody of forty.\n\n---\n\n"
             "#### p.\u202f41\n\n## Lesson Thirty-Two\n\nBody of forty-one.\n\n"
             "### Sūrat Maryam\n\nMore of forty-one.\n\n---\n\n"
             "#### p.\u202f42\n\nBody of forty-two.\n")
split = submit.split_pages(TWO_PAGES)
check("translation: a page's own headings do not split it", len(split) == 3, str(len(split)))
check("translation: a page keeps its subheadings", "## Lesson Thirty-Two" in split[1])
check("translation: the split is at the page headings", split[0].startswith("#### p.\u202f40"))
check("translation: one page per request", submit.PAGES_PER_BATCH == 1, str(submit.PAGES_PER_BATCH))

# A response that lost its page heading gets the request's own heading back, so
# the page cannot vanish from the note.
import json as _json
import tempfile as _tempfile
_proc = load("translate_process", "translate-batch-process.py")
with _tempfile.TemporaryDirectory() as _d:
    _req = Path(_d) / "x.translate.jsonl"
    _out = Path(_d) / "x.translate-output.jsonl"
    _req.write_text(_json.dumps({"key": "batch_0001", "request": {"contents": [
        {"parts": [{"text": "#### p.\u202f41\n\nBody."}]}]}}) + "\n", encoding="utf-8")
    _out.write_text(_json.dumps({"key": "batch_0001", "response": {"candidates": [
        {"content": {"parts": [{"text": "Translated body."}]}}]}}) + "\n", encoding="utf-8")
    _text = _proc.read_output_jsonl(_out, fix_untranslated=False)
check("translation: a response without its page heading gets one",
      _text.startswith("#### p.\u202f41"), _text[:40])

# ── A footnote block the model put on the next page ─────────────────────────
# Translation was requested two pages at a time, so a mislaid block can only be
# one page late. The page above must refer to its numbers and have no block of
# its own; anything less clear-cut stays where the model put it.
MISLAID = ("#### p. 40\n\nBody with a mark.\u00b9 and another.\u00b2\n\n---\n\n"
           "#### p. 41\n\nBody of forty-one.\n\n---\n\n"
           ">[!footnotes]\n> - 1 – First note.\n> - 2 – Second note.\n\n---\n\n"
           "#### p. 42\n\nBody of forty-two.\n")
_fixed, _moved = post.reassociate_footnotes(post.normalize_translation_footnotes(MISLAID)[0])
check("footnotes: a block the model put a page late comes back",
      _moved == 1 and _fixed.index(">[!footnotes]") < _fixed.index("#### p. 41"),
      _fixed[:120])
check("footnotes: it lands before the page rule it belongs to",
      _fixed.index("> - 2 – Second note.") < _fixed.index("---\n\n#### p. 41"), _fixed[:200])
check("footnotes: the move settles", post.reassociate_footnotes(_fixed) == (_fixed, 0))

PLACED = ("#### p. 40\n\nBody.\u00b9\n\n---\n\n#### p. 41\n\nBody of forty-one.\u00b9\n\n---\n\n"
          ">[!footnotes]\n> - 1 – The note.\n\n---\n")
check("footnotes: a block its own page refers to stays",
      post.reassociate_footnotes(PLACED)[1] == 0)
OWNED = ("#### p. 40\n\nBody.\u00b9\n\n---\n\n>[!footnotes]\n> - 1 – Already there.\n\n---\n\n"
         "#### p. 41\n\nBody.\n\n---\n\n>[!footnotes]\n> - 1 – Second.\n\n---\n")
check("footnotes: a page that already has its notes is not given more",
      post.reassociate_footnotes(OWNED)[1] == 0)
FAR = ("#### p. 40\n\nBody.\u00b9\n\n---\n\n#### p. 41\n\nNothing.\n\n---\n\n"
       "#### p. 42\n\nBody.\n\n---\n\n>[!footnotes]\n> - 1 – The note.\n\n---\n")
check("footnotes: nothing moves two pages",
      post.reassociate_footnotes(FAR)[1] == 0)

# Arabic-Indic numerals are a footnote number form like the other two.
check("footnotes: Arabic-Indic items are items",
      post.normalize_translation_footnotes("Body.\n\n> - \u0661 – One.\n> - \u0662 – Two.\n\n---")[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – One.\n> - 2 – Two.\n\n---")

# ── The footnote section the model wrote as a page separator ────────────────
# `---` then bare superscript-numbered paragraphs is the model's way of opening
# a footnote section, not a page break: pages are delimited by their headings, so
# a rule inside one belongs to the notes, and the notes become the callout.
IN_PAGE = ("#### p. 49\n\nBody of forty-nine.\n\n---\n\n"
           "\u00b9 *Al-Jalālayn*, vol. 3, p. 33.\n"
           "\u00b2 On the authority of Ibn ʿAbbās.\n"
           "\u00b3 Al-Qurṭubī said.\n\n---\n\n#### p. 50\n\nBody of fifty.\n")
_fixed, _count = post.normalize_translation_footnotes(IN_PAGE)
check("footnotes: a separator before the notes is not a page break",
      _count >= 1 and _fixed.count("\n---\n") == 1, _fixed)
check("footnotes: the notes become the page's callout",
      ">[!footnotes]\n> - 1 – *Al-Jalālayn*, vol. 3, p. 33.\n"
      "> - 2 – On the authority of Ibn ʿAbbās.\n> - 3 – Al-Qurṭubī said." in _fixed, _fixed)
check("footnotes: the section settles",
      post.normalize_translation_footnotes(_fixed) == (_fixed, 0))
LONE = "#### p. 49\n\nBody.\n\n\u00b9 A lone line.\n\nMore body.\n\n---\n"
check("footnotes: a lone numbered line mid-page is not a section",
      post.normalize_translation_footnotes(LONE)[0] == LONE)
# A page whose notes continue the previous page's is written `⁴ ⁵ ⁶`; the number
# at the start of the line is the signal, not where the count begins.
NOT_ONE = "#### p. 49\n\nBody.\n\n---\n\n\u2074 Fourth note.\n\u2075 Fifth note.\n\n---\n"
check("footnotes: notes numbered from 4 are still the section",
      post.normalize_translation_footnotes(NOT_ONE)[0]
      == "#### p. 49\n\nBody.\n\n>[!footnotes]\n> - 4 – Fourth note.\n> - 5 – Fifth note.\n\n---\n")

# The section is sometimes fenced with `***` or `<br>` instead of `---`, and the
# page rule after it keeps its blank line.
ASTERISKS = "Body.\n\n***\n\u00b9 Al-Qurṭubī said.\n***\n\nBody continues.\n\n---"
check("footnotes: `***` fences the section, not the page",
      post.normalize_translation_footnotes(ASTERISKS)[0]
      == "Body.\n\n>[!footnotes]\n> - 1 – Al-Qurṭubī said.\n\nBody continues.\n\n---")
BR = ("Body. <sup>1</sup>\n\n<br>\n\u00b9 Muslim reported.\n<br>\n\n"
      ">[!footnotes]\n> - 1 – Already here.\n\n---")
check("footnotes: `<br>` around the section goes with it",
      post.normalize_translation_footnotes(BR)[0]
      == "Body. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – Muslim reported.\n> - 1 – Already here.\n\n---")
RULE_AFTER = "Body.\n\n---\n\n\u00b9 First.\n\u00b2 Second.\n\n---\n\n#### p. 50\n"
check("footnotes: the page rule after the notes keeps its blank line",
      "> - 2 – Second.\n\n---\n\n#### p. 50" in post.normalize_translation_footnotes(RULE_AFTER)[0],
      post.normalize_translation_footnotes(RULE_AFTER)[0])

# ── The other shapes a footnote definition is written in ────────────────────
# `^(1)^ – …`, `[^1]: …` and a named `[^talhah-bio]: …` are all the same
# section, and a markdown footnote's anchor becomes a superscript reference,
# because a callout item is not a footnote Obsidian can link to.
CARET = ("#### p. 4\n\nBody with a reference.^(1)^\n\n"
         "^(1)^ – The two verses were cited by al-Ṣāwī.\n^(2)^ – On the authority of Abū Saʿīd.\n\n"
         "---\n\n#### p. 5\n")
check("footnotes: `^(N)^ – …` definitions are definitions",
      ">[!footnotes]\n> - 1 – The two verses were cited by al-Ṣāwī.\n> - 2 – On the authority of Abū Saʿīd."
      in post.normalize_translation_footnotes(CARET)[0])
MD = ("#### p. 30\n\nBody text.[^1] More.[^2]\n\n"
      "[^1]: *Lubāb al-Nuqūl*, p. 186.\n[^2]: Ibn Ḥajar mentioned it.\n\n---\n\n#### p. 31\n")
_md, _ = post.normalize_translation_footnotes(MD)
check("footnotes: `[^N]:` definitions are definitions",
      ">[!footnotes]\n> - 1 – *Lubāb al-Nuqūl*, p. 186.\n> - 2 – Ibn Ḥajar mentioned it." in _md, _md)
check("footnotes: a markdown footnote's anchor becomes a superscript",
      "Body text.<sup>1</sup> More.<sup>2</sup>" in _md, _md)
NAMED = ("Body. [^talhah-bio] and [^talhah-expiation]\n\n"
         "[^talhah-bio]: Ṭalḥah ibn ʿUbayd Allāh.\n[^talhah-expiation]: Al-Qurṭubī reported.\n\n---\n")
_named, _ = post.normalize_translation_footnotes(NAMED)
check("footnotes: named markdown footnotes are numbered in order",
      "> - 1 – Ṭalḥah ibn ʿUbayd Allāh.\n> - 2 – Al-Qurṭubī reported." in _named, _named)
check("footnotes: their anchors are renumbered",
      "Body. <sup>1</sup> and <sup>2</sup>" in _named, _named)
DASH = "Body text here.\n\n1 - This is the first hemistich of a verse.\n\nMore text.\n"
_dash, _ = post.normalize_translation_footnotes(DASH)
check("footnotes: a mid-page `1 - …` is a definition",
      ">[!footnotes]\n> - 1 – This is the first hemistich of a verse." in _dash, _dash)
LIST = "Body text:\n\n1. A *kāfir* as the opposite of a believer.\n2. Another item.\n\n---\n"
check("footnotes: a numbered body list is not a footnote section",
      post.normalize_translation_footnotes(LIST)[0] == LIST)
check("footnotes: a markdown definition inside a callout becomes an item",
      post.normalize_translation_footnotes(
          "Body. <sup>1</sup>\n\n>[!footnotes]\n> [^fn1]: 1 – It is narrated.\n> [^fn2]: 2 – Another.\n\n---")[0]
      == "Body. <sup>1</sup>\n\n>[!footnotes]\n> - 1 – It is narrated.\n> - 2 – Another.\n\n---")
# The model sometimes sets a definition as a heading; the heading passes demote
# it, and the footnotes are normalised after them so it is seen as a definition.
HEADED = ("Body.\n\n## 1 - This is the first hemistich of a verse, and its second hemistich is: "
          "...and the key to the gates of guidance and goodness.\n\nAnd it is from a piece.\n")
_demoted, _demoted_count = post.demote_prose_headings(HEADED)
check("footnotes: a long heading is demoted to a paragraph", _demoted_count == 1, _demoted)
check("footnotes: a definition set as a heading is seen once demoted",
      ">[!footnotes]\n> - 1 – This is the first hemistich" in post.normalize_translation_footnotes(_demoted)[0],
      post.normalize_translation_footnotes(_demoted)[0])
check("footnotes: every new shape settles",
      post.normalize_translation_footnotes(post.normalize_translation_footnotes(CARET)[0])[0]
      == post.normalize_translation_footnotes(CARET)[0])

# ── A citation is written once, and in the sūra the page discusses ──────────
# Two links to the same verse in a row are one citation: the source's own
# reference converted to a link beside the one the pipeline added.
DOUBLE = "﴿نص﴾ [[Q018#1]] [[Q018#1]] وصف"
check("links: a duplicated citation collapses",
      render.normalize_quran_link_display(DOUBLE)[0] == "﴿نص﴾ [[Q018#1]] وصف")
OLD_STYLE = "﴿نص﴾ ([[Q018#1|الكهف : ١]]) [[Q018#1]] ثم"
check("links: the source's own reference and the added one are one",
      render.normalize_quran_link_display(OLD_STYLE)[0] == "﴿نص﴾ [[Q018#1]] ثم")
DISTINCT = "﴿نص﴾ [[Q018#1]] [[Q018#2]] ثم"
check("links: two different verses both stay",
      render.normalize_quran_link_display(DISTINCT)[0] == DISTINCT)

# The basmala followed by الحمد opens al-Fātiḥa and al-Kahf alike; the page's
# own heading says which one the commentary is reading.
LF = "\ufd3f"; LE = "\ufd3e"
BASMALA = ("### سورة الكهف\n\nآيات أو خمس عشرة آية [[Q001#1|:2]]"
           + LF + "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ الْحَمْدُ" + LE + " [[Q001#1|2]] هو الوصف\n")
_fixed, _n = quran.realign_local_surah_links(BASMALA)
check("links: an ambiguous quotation is cited in the sūra the page names",
      "[[Q018#1|:]]" + LF in _fixed and "[[Q018#1]] هو الوصف" in _fixed, _fixed)
check("links: realigning settles", quran.realign_local_surah_links(_fixed)[1] == 0)
# A cross-reference is cited as written: only a basmala-led span is realigned,
# because the basmala is a verse in al-Fātiḥa alone.
CROSS = ("### سورة الكهف\n\n" + LF + "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ يَٰٓأَيُّهَا ٱلنَّاسُ" + LE
         + " [[Q004#1]] يا أهل مكة\n")
# A commentary glosses a verse word by word: the next quotation is the next
# word of the verse just cited, so it is cited there and not wherever else the
# word happens to occur.
GLOSS = ("[[Q018#1|:]]" + LF + "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ٱلْحَمْدُ" + LE
         + " [[Q018#1]] هو الوصف ثابت " + LF + "لِلَّهِ" + LE + " [[Q001#1]] الحمد لله.")
_gloss, _gn = quran.realign_continuation_links(GLOSS)
check("links: a gloss follows the verse it continues",
      "﴿لِلَّهِ﴾ [[Q018#1]]" in _gloss, _gloss)
check("links: the continuation pass settles",
      quran.realign_continuation_links(_gloss)[1] == 0)
# With no heading at all, the quotation that *follows* says where the page is:
# `﴿ٱلَّذِىٓ أَنزَلَ عَلَىٰ عَبْدِهِ ٱلْكِتَٰبَ﴾` is al-Kahf and nothing else, so the
# basmala before it is al-Kahf's opening too.
NO_HEADING = ("[[Q001#1|:2]]" + LF + "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ٱلْحَمْدُ" + LE
              + " [[Q001#1|2]] هو الوصف الجميل ثابت "
              + LF + "ٱلَّذِىٓ أَنزَلَ عَلَىٰ عَبْدِهِ ٱلْكِتَٰبَ" + LE + " وصف نفسه")
_follow, _fn = quran.realign_local_surah_links(NO_HEADING)
check("links: with no heading, the following quotation names the sūra",
      "[[Q018#1|:]]" in _follow and "[[Q018#1]] هو الوصف" in _follow, _follow)
check("links: a cross-reference is not moved to the page's sūra",
      quran.realign_local_surah_links(CROSS)[1] == 0)

# ── A verse is cited once per run in a translated tafsīr too ────────────────
# A translation glosses a verse word by word, and every gloss used to carry its
# own link. The Arabic commentary cites the run's first and last quotation; the
# translation now does the same, without needing the cursor (which English has
# no equivalent of): the link's own target is the evidence.
GLOSSES = ("﴾severe chastisement﴿ [[Q018#2]] – torment – ﴾from Him﴿ [[Q018#2]], from Allāh. "
           "﴾and a warning﴿ [[Q018#2]] – a warning to the disbelievers. ﴾forever﴿ [[Q018#3]] which is")
_glossed, _gcount = render.dedupe_run_links(GLOSSES)
check("runs: only the first and last citation of a verse run stay",
      _glossed.count("[[Q018#2]]") == 2 and _glossed.count("[[Q018#3]]") == 1, _glossed)
check("runs: removing a link takes its space with it",
      "from Him﴿, from Allāh" in _glossed, _glossed)
check("runs: the pass settles", render.dedupe_run_links(_glossed)[1] == 0)
MARKED = "﴾one﴿ [[Q018#9|:]] ﴾two﴿ [[Q018#9|:]] ﴾three﴿ [[Q018#9]]"
check("runs: the margin's marker is not a citation",
      render.dedupe_run_links(MARKED)[1] == 0, MARKED)
PARAGRAPHS = "﴾one﴿ [[Q018#2]] then\n\n﴾two﴿ [[Q018#2]] then"
check("runs: a blank line ends the run",
      render.dedupe_run_links(PARAGRAPHS)[1] == 0, PARAGRAPHS)

# ── Page headings the model spoils ──────────────────────────────────────────
# The paragraph break after a page heading is sometimes missing altogether, and
# sometimes the dot is a star.
GLUED_HEAD = "#### p. 235﴾then a heavy rainstorm struck it﴿ [[Q002#264]] – heavy rain."
_split, _sh = post.split_page_headings(GLUED_HEAD)
check("headings: text glued to a page number gets its paragraph back",
      _split.startswith("#### p. 235\n\n﴾then") and _sh == 1, _split)
check("headings: `#### p * 135` is a page heading",
      post.split_page_headings("#### p * 135")[0] == "#### p. 135")
# An unbalanced mark must not make a "quotation" span a page heading: the
# verse-number stripping inside a span ate the page number and the line break
# with it, gluing the heading to the paragraph below.
BROKEN = "para ﴿open\n\n#### p. 235\n\n﴾of the verse﴿ [[Q002#264]] tail"
check("headings: a span never reaches across a page heading",
      "#### p. 235\n\n" in post.strip_quote_emblems(BROKEN), post.strip_quote_emblems(BROKEN))
check("headings: a heading alone is not split",
      post.split_page_headings("#### p. 12")[0] == "#### p. 12")

# ── A basmala on its own is prose, not a quotation ──────────────────────────
# It is the formula a sūra opens with, and the muṣḥaf numbers it only in
# al-Fātiḥa, where it is 1:1. So it is un-marked everywhere else — and cited
# there.
BASMALA = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"
KAHF = "### سورة الكهف\n\nقال: *" + LF + BASMALA + LE + "{.quran-quote}* ثم قال."
_kahf, _kh = quran.strip_bare_basmala(KAHF)
check("basmala: one inside a sentence is prose on another sūra's page",
      _kh == 1 and LE + "{.quran-quote}" not in _kahf and BASMALA in _kahf, _kahf)
# On a line of its own it is the sūra's opening as the muṣḥaf writes it, so the
# author's brackets stay even though it is not a verse there.
OPENING = "### سورة الكهف\n\n*" + LF + BASMALA + LE + "{.quran-quote}*\n\nالحمد لله."
check("basmala: a sūra-opening one keeps its marks",
      quran.strip_bare_basmala(OPENING)[1] == 0)
FATIHA = "### سورة الفاتحة\n\n*" + LF + BASMALA + LE + "{.quran-quote}*\n\nالحمد لله."
check("basmala: it is a quotation in al-Fātiḥa", quran.strip_bare_basmala(FATIHA)[1] == 0)
ENGLISH = "### Sūrat al-Fātiḥa\n\n*" + LE + BASMALA + LF + "{.quran-quote}*\n\nPraise."
check("basmala: an English al-Fātiḥa heading counts", quran.strip_bare_basmala(ENGLISH)[1] == 0)
check("basmala: un-marking settles", quran.strip_bare_basmala(_kahf)[1] == 0)
# The invisible page-edge pair puts its tilde between the mark and the words;
# left behind, the two tildes would print the phrase struck through.
EDGE = "### سورة التوبة\n\nقال: ~" + LF + "~" + BASMALA + "~" + LE + "~، ثم.\n"
_edged, _eh = quran.strip_bare_basmala(EDGE)
check("basmala: the invisible pair goes with the marks",
      _eh == 1 and "~" not in _edged and "، ثم" in _edged, _edged)
# An author may quote the basmala *as* 1:1 in a book that is not al-Fātiḥa's:
# `﴿بسم الله الرحمن الرحيم﴾ (الفاتحة : ١)`. The citation beside it keeps it.
CITED = ("### سورة مريم\n\nقال مفتتحا بـ " + LF + BASMALA + LE
         + " ([[Q001#1|الفاتحة : ١]]) ثم قال.\n")
check("basmala: a citation beside it keeps the marks", quran.strip_bare_basmala(CITED)[1] == 0)
check("basmala: a citation for an earlier verse does not",
      quran.strip_bare_basmala("### سورة مريم\n\n﴿إِنَّ ٱللَّهَ﴾ [[Q001#1]]\n\nقال: "
                               + LF + BASMALA + LE + " ثم قال.")[1] == 1)

# In al-Fātiḥa the basmala *is* 1:1, so a span that runs on is the range 1:1–2
# and is cited: the formula is not blacklisted there.
FATIHA_SPAN = "### سورة الفاتحة\n\n" + LF + BASMALA + " ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ" + LE + "\n"
_ranged, _stats = tafsir.process_quran(FATIHA_SPAN, mode="tafsir")
check("basmala: in al-Fātiḥa the whole span is cited from 1:1",
      "[[Q001#1|2]]" in _ranged, _ranged)

# ── A transcription's citations are the model's, not the author's ────────────
# They may only settle what our own search leaves open, and a wrong one must not
# stop the quotation from being cited at all. A repository's citation stands.
TIE = "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ"      # 2:255 and 3:2
ONE = "يَخْرُجُ مِن بَيْنِ ٱلصُّلْبِ وَٱلتَّرَآئِبِ"          # 86:7 alone
check("citations: a phrase in two sūras leaves a tie to break", quran._hint_may_decide(TIE))
check("citations: a phrase in one sūra leaves none", not quran._hint_may_decide(ONE))

CITED_WRONGLY = ("### سورة الكهف\n\n*" + LF
                 + "ٱلْحَمْدُ لِلَّهِ ٱلَّذِىٓ أَنزَلَ عَلَىٰ عَبْدِهِ ٱلْكِتَٰبَ" + LE
                 + "{.quran-quote}* (البقرة: ٢٥٥)\n")
_kept, _kn = quran.add_missing_refs(CITED_WRONGLY)
_tied, _tn = quran.add_missing_refs(CITED_WRONGLY, trust_citations=False)
check("citations: in a repository the source's citation stands alone", _kn == 0, _kept)
check("citations: in a transcription a wrong one still gets our link",
      _tn == 1 and "[[Q018#1]]" in _tied, _tied)
_cited, _stats = tafsir.process_quran(CITED_WRONGLY, mode="tafsir", raw_ocr=True)
check("citations: the model's bracket is replaced, not kept beside ours",
      "[[Q018#1]]" in _cited and "البقرة" not in _cited, _cited)

# ── Still to implement ──────────────────────────────────────────────────────
#
# The one rule from 2026-11-19 that is not in place: a fully vocalised paragraph
# is a candidate even with no delimiter at all. Tashkīl density separates
# Qur'ānic text from prose, and it is the only route to a quotation that neither
# italics nor ornate marks nor a page break marks.
#
print()
if failures:
    print(f"{len(failures)} failure(s): {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")
