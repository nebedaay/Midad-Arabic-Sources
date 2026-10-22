#!/usr/bin/env python3
"""
Unified post-processing script for Gemini Batch OCR output.
Applies all formatting fixes in one pass for any volume of Fi riyad al-tafsir.

Usage: python3 scripts/postprocess-gemini-batch.py <input.md>
Output: <input>.formatted.md with timestamp

Fixes applied:
1. Quran formatting: *﴿...﴾{.quran-quote}* with proper placement
2. Footnotes: *** divider → >[!arabic-footnotes] callouts  
3. Poetry: '§§§' / legacy '*' markers and '%%' hemistich separators → >[!arabic-poetry] callouts with sublists
4. Sura name normalization to match vault file names
5. TOC: - text [[####p. N|N]] → >[!TOC] with proper entries
6. Spacing: exactly one blank line between all block elements
7. Page separators: collapse doubles, ensure \n\n---\n\n
8. Page footers: remove - N - lines
9. Paragraph joining: join broken lines within prose blocks
10. Remove running headers (في رياض التفسير)
11. Heading detection: **فصل : title** or plain → ### فصل : title (same for باب، الباب، الفصل)
"""
import re
import sys
from pathlib import Path
from datetime import datetime

LQ = '\uFD3F'
LQE = '\uFD3E'
NBSP = '\u202f'

# The line marker for poetry. A rare, non-Markdown character avoids the
# ambiguity between a leading '*' and italics.
POETRY_MARK_RE = re.compile(r'^(?:§{2,}|\${3,})\s*')
ARABIC_RE = re.compile(r'[\u0600-\u06FF]')


def is_poetry_line(line: str) -> bool:
    """True for a line Gemini marked as poetry, including malformed markers.

    Accepts the current '§§§' marker, the legacy '* h1%%h2' form, a line with
    a '%%' hemistich separator, and the common failure where Gemini attaches
    the asterisk directly to the first Arabic word. A closed '*italic*' span is
    left as prose; a Qur'an quote is never poetry.
    """
    s = line.strip()
    if not s:
        return False
    if "%%" in s or POETRY_MARK_RE.match(s):
        return True
    if s.startswith("*") and not s.startswith("**"):
        if LQ in s or LQE in s:
            return False
        if s.startswith("* ") and " * " in s[2:]:
            return True
        if s.count("*") >= 2:
            return False
        return bool(ARABIC_RE.search(s))
    return False

# Page-block markers added by transcription-process-raw.py (NBSP distinguishes
# the pipeline's PDF-index heading from the model's printed-page heading).
PAGE_MARKER = re.compile(r'^(#### p\.\u202f\d+[ \t]*)$', re.M)
MODEL_PAGE = re.compile(r'^####\s*p\.?\s*\*?\s*(\d+)\s*$', re.M)
MODEL_UNKNOWN = re.compile(r'^####\s+p\.\s*\?\s*$', re.M)
MODEL_UNNUM = re.compile(r'^####\s+(Cover|Title page|Copyright page|Contents|Table of contents|Index)\s*$', re.M | re.I)


def _assign_page_numbers(pairs):
    """Reconstruct printed page numbers from (pdf_index, printed_or_None).

    The printed number normally equals pdf_index minus a constant offset that
    can change between a few continuous ranges. We find runs of consecutive
    pages sharing the same offset (the reliable anchors), then give every page
    the offset of the nearest anchor."""
    trusted = [(i, i - p) for i, p in pairs if p is not None]

    segments = []
    cur = []
    for i, d in trusted:
        if cur and d == cur[-1][1] and i - cur[-1][0] <= 5:
            cur.append((i, d))
        else:
            if cur:
                segments.append(cur)
            cur = [(i, d)]
    if cur:
        segments.append(cur)

    reliable = [s for s in segments if len(s) >= 2]
    if not reliable:
        if trusted:
            from collections import Counter
            d = Counter(x[1] for x in trusted).most_common(1)[0][0]
            return {i: max(1, i - d) for i, _ in pairs}
        return {i: i for i, _ in pairs}

    out = {}
    for i, _ in pairs:
        best, best_dist = None, None
        for s in reliable:
            lo, hi = s[0][0], s[-1][0]
            dist = 0 if lo <= i <= hi else min(abs(i - lo), abs(i - hi))
            if best_dist is None or dist < best_dist or (dist == best_dist and len(s) > len(best)):
                best, best_dist = s, dist
        out[i] = max(1, i - best[0][1])
    return out


AR_DIGITS = str.maketrans('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669', '0123456789')
BARE_PAGE = re.compile(r'^\s*([\u0660-\u0669\d]{1,4})\s*$')
RUNNING_SURA = re.compile(r'^\s*([\u0660-\u0669\d]{1,4})?\s*[-\u2013\u2014]?\s*(سورة\s+\S.*|الجزء\s+\S.*|جزء\s+\S.*)\s*$')
HEADER_PREFIX = re.compile(r'^\s*([\u0660-\u0669\d]{1,4})\s+(?:[\u0660-\u0669\d]{1,3}\s+)?(?:سورة\s+\S+\s+)?')


def _strip_running_header(block):
    """Remove a page's leading running header (printed number and/or a
    'N سورة …' line) so it is not joined into the first paragraph.

    Returns (cleaned_block, printed_number_or_None)."""
    lines = block.split("\n")
    k = 0
    while k < len(lines) and lines[k].strip() == "":
        k += 1
    printed = None

    if k < len(lines):
        m = BARE_PAGE.match(lines[k])
        if m:
            printed = int(m.group(1).translate(AR_DIGITS))
            lines.pop(k)

    if k < len(lines):
        m = RUNNING_SURA.match(lines[k])
        if m:
            if printed is None and m.group(1):
                printed = int(m.group(1).translate(AR_DIGITS))
            lines.pop(k)

    # A running header glued to the first paragraph: "٦٠ ٢ سورة البقرة بر …"
    if k < len(lines):
        m = HEADER_PREFIX.match(lines[k])
        if m and (printed is not None or 'سورة' in lines[k][:40]) and len(lines[k].strip()) > m.end():
            if printed is None:
                printed = int(m.group(1).translate(AR_DIGITS))
            lines[k] = lines[k][m.end():]

    return "\n".join(lines), printed


def reconstruct_page_numbers(text):
    """Rebuild the model's printed-page headings from PDF order + continuous runs."""
    parts = re.split(r'^(#### p\.\u202f\d+[ \t]*)$', text, flags=re.M)
    if len(parts) < 3:
        return text

    info = []
    for k in range(1, len(parts), 2):
        marker = parts[k]
        block = parts[k + 1] if k + 1 < len(parts) else ""
        mm = re.search(r'p\.\u202f(\d+)', marker)
        idx = int(mm.group(1)) if mm else None
        cleaned, hdr_num = _strip_running_header(block)
        mp = MODEL_PAGE.search(cleaned)
        info.append((marker, cleaned, idx, int(mp.group(1)) if mp else hdr_num))

    numbers = _assign_page_numbers([(i, p) for _, _, i, p in info])

    out = [parts[0]]
    fixed = 0
    for marker, block, idx, _ in info:
        n = numbers.get(idx)
        if MODEL_UNNUM.search(block):
            # cover / unnumbered page: keep its heading as-is
            new = block
        else:
            # Drop every page heading the model emitted (it can repeat them)
            # and put exactly one reconstructed heading at the top.
            stripped = re.sub(r'^####\s*p\.?\s*\*?\s*\d+\s*$', '', block, flags=re.M)
            stripped = MODEL_UNKNOWN.sub('', stripped)
            new = "\n\n" + f'#### p. {n}\n\n' + stripped.lstrip('\n')
        if new != block:
            fixed += 1
        out.append(marker)
        out.append(new)
    print(f"  Page numbers reconstructed: {fixed} block(s) adjusted")
    return "".join(out)

# Sura name fixes: Gemini romanization → vault file name
SURA_FIX = {
    '001 Al-Fatiha': '001 Al-Fatihah',
    '003 Al-Imran': "003 Ali 'Imran",
    '010 Yunus': '010 Yunus',
    '010 Yūnus': '010 Yunus',
    '029 Al-Ankabut': "029 Al-'Ankabut",
    '034 Saba': '034 Saba',
    "034 Saba'": '034 Saba',
    '035 Fatir': '035 Fatir',
    '035 Fāṭir': '035 Fatir',
    '036 Yasin': '036 Ya-Sin',
    '036 Yā-Sīn': '036 Ya-Sin',
    '042 Ash-Shura': '042 Ash-Shuraa',
}


def _strip_arabic_marks(text: str) -> str:
    return re.sub(r'[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]', '', text)


def _is_toc_heading(line: str) -> bool:
    s = _strip_arabic_marks(line.strip())
    return bool(re.match(r'^#{1,6}\s+.*(?:فهرس|محتويات|contents?|toc)\b', s, re.I))


def _is_toc_signal(line: str) -> bool:
    s = _strip_arabic_marks(line.strip())
    return s in ('صحيفة', 'صفحة', 'page', 'الصفحة')


def _is_page_number_cell(cell: str) -> bool:
    return bool(re.fullmatch(r'[\u0660-\u0669\d]{1,4}', cell.strip()))


def _toc_entries(body_lines: list[str]) -> list[str]:
    """Turn TOC lines or a TOC table into flat ``page + title`` entries."""
    entries: list[str] = []
    table_rows: list[list[tuple[str, str]]] = []
    started = False
    for raw in body_lines:
        s = raw.strip()
        if not s or s == '---' or _is_toc_signal(s):
            continue
        if s.startswith('#'):
            continue

        # A markdown table: the old 3.5 output used two page/text column pairs
        # per row. Pull out each page-number + following-text pair.
        if '|' in s:
            if re.fullmatch(r'[\s|:\-–—]+', s):
                continue
            cells = [c.strip() for c in s.strip().strip('|').split('|')]
            cells = [c for c in cells if c]
            if cells and all(_is_toc_signal(c) for c in cells):
                continue
            row: list[tuple[str, str]] = []
            i = 0
            while i < len(cells):
                if _is_page_number_cell(cells[i]) and i + 1 < len(cells) and not _is_page_number_cell(cells[i + 1]):
                    row.append((cells[i], cells[i + 1]))
                    started = True
                    i += 2
                else:
                    i += 1
            if row:
                table_rows.append(row)
            continue

        m = re.match(r'^([\u0660-\u0669\d]{1,4})\s+(.+)$', s)
        if m:
            entries.append(f'{m.group(1)} {m.group(2).strip()}')
            started = True
        elif started and entries and not table_rows:
            # A wrapped continuation of the previous entry.
            entries[-1] += ' ' + s

    if table_rows:
        columns = max(len(row) for row in table_rows)
        if columns > 1:
            # The old table reads right-to-left: the rightmost page/text pair
            # comes first, then the next column to its left.
            for col in range(columns - 1, -1, -1):
                for row in table_rows:
                    if col < len(row):
                        entries.append(f'{row[col][0]} {row[col][1]}')
        else:
            for row in table_rows:
                entries.extend(f'{page} {title}' for page, title in row)
    return entries


def format_toc_blocks(text: str) -> str:
    """Format fihris pages as a [!TOC] callout, one entry per list item.

    A TOC may be introduced by a heading (فهرس / محتويات / Contents) or by a
    'صحيفة' column header. Entries are page-number-plus-title lines, or a
    markdown table with page/title column pairs. Only blocks with at least
    three entries are changed, to avoid treating ordinary numbered prose as a
    TOC. Page headings such as '#### Title page' are renamed to '#### TOC'
    when the page's content is a TOC.
    """
    lines = text.split('\n')
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        signal_start = _is_toc_signal(s)
        heading_start = _is_toc_heading(s)
        if not heading_start and not signal_start:
            out.append(lines[i])
            i += 1
            continue

        # The TOC starts after its heading, or at the signal line itself.
        body_start = i + 1 if heading_start else i
        j = body_start
        while j < n:
            t = lines[j].strip()
            if t.startswith('#### ') or t == '---':
                break
            if j > body_start and re.match(r'^#{1,3}\s+', t):
                break
            j += 1

        entries = _toc_entries(lines[body_start:j])
        if len(entries) < 3:
            out.append(lines[i])
            i += 1
            continue

        # Rename an obviously misidentified cover/title page.
        if heading_start:
            for k in range(len(out) - 1, -1, -1):
                if re.match(r'^####\s+', out[k].strip()):
                    if re.match(r'^####\s+(?:Cover|Title page|Cover page)\s*$', out[k].strip(), re.I):
                        out[k] = '#### TOC'
                    break
            out.append(lines[i])
        out.append('')
        out.append('>[!TOC]')
        out.extend(f'>- {entry}' for entry in entries)
        out.append('')
        i = j

    return '\n'.join(out)


def normalize_spacing(text):
    """
    Ensure EXACTLY one blank line between all block-level elements.
    Collapses multiple blank lines. Fixes double --- separators.
    Does NOT affect *** markers (unhandled Gemini footnotes).
    
    Call this after EVERY change to the document text.
    """
    lines = text.split('\n')
    out = []
    prev_blank = False
    
    for i, line in enumerate(lines):
        s = line.strip()
        
        # Preserve *** markers (unhandled footnotes)
        if s == '***':
            if not prev_blank and out and out[-1] != '':
                out.append('')
            out.append(line)
            out.append('')
            prev_blank = True
            continue
        
        is_heading = s.startswith('#')
        is_callout_header = bool(re.match(r'>\[!', s))
        is_callout_body = s.startswith('>')
        is_separator = (s == '---')
        is_blank = (s == '')
        
        # Block start: add blank line separator from previous content
        if (is_heading or is_callout_header or is_separator) and i > 0:
            while out and out[-1] == '':
                out.pop()
            if out and out[-1] != '':
                out.append('')
        
        if is_heading:
            out.append(line)
            # Ensure blank line after heading
            out.append('')
            prev_blank = True
            continue
            out.append(line)
            prev_blank = False
            continue
        
        if is_blank:
            if not prev_blank:
                out.append(line)
            prev_blank = True
            continue
        
        out.append(line)
        prev_blank = False
    
    result = '\n'.join(out)
    
    # A callout header must open its own block: force a blank line before it,
    # even if it was inserted mid-line (e.g. a footnote/poetry marker that
    # landed inside a paragraph).
    result = re.sub(r'([^\n])(>\[!)', r'\1\n\n\2', result)
    
    # Force blank line after every callout: lines ending callout blocks
    result = re.sub(r'(^>.+\n)(?![\n>])', r'\1\n', result, flags=re.MULTILINE)
    
    # Collapse remaining excess blanks
    result = re.sub(r'\n{3,}', '\n\n', result)
    
    # Fix page separators: collapse ANY --- whitespace --- into single ---
    result = re.sub(r'---\s*\n+\s*---', '---', result)
    
    # Clean up trailing blanks after fix
    result = re.sub(r'\n{3,}', '\n\n', result)
    
    return result


def remove_pdf_headings(text):
    """Remove #### p. 0*, ##### PDF, and pg_*.pdf headings.

    Keeps the deliberate review marker '#### p. ?' (see the skill's page-heading
    rules); only garbage headings that contain '?' along with other text go."""
    # The pipeline's own PDF-index markers use a narrow no-break space; strip
    # them so they never leak into the output.
    text = re.sub(r'#+\s*p\.\u202f\d+\s*', '', text)
    text = re.sub(r'^#### p\.\s*0+\d*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^#{3,5}\s*PDF\s*\d*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^#### p\.(?!\s*\?\s*$).*\?.*$', '', text, flags=re.MULTILINE)
    # Strip any heading containing pg_ or .pdf (Gemini diagnostic headers)
    text = re.sub(r'^#+\s*.*(?:pg_|\.pdf).*$', '', text, flags=re.MULTILINE)
    return text


def process(input_path):
    """Apply all post-processing fixes to a Gemini batch output file."""
    path = Path(input_path)
    c = open(path, encoding='utf-8').read()
    print(f"Processing: {path.name} ({len(c)/1e3:.0f} KB, {c.count('#### ')} pages)")

    # ── 0. Reconstruct printed page numbers from PDF order ─────
    c = reconstruct_page_numbers(c)

    # ── 0b. Remove PDF page headings (the pipeline markers) ────
    c = remove_pdf_headings(c)
    c = normalize_spacing(c)

    # ── 0c. Cross-page Qur'an quotes ───────────────────────────
    # Reconstruct a quote split across a page break: keep the opening ornate
    # paren on the first page, and the closing paren + single link on the next.
    try:
        from importlib.machinery import SourceFileLoader
        _tfq = SourceFileLoader(
            "tfq_cross", str(Path(__file__).with_name("transcription-quran.py"))
        ).load_module()
        c, _cross = _tfq.fix_cross_page_quotes(c)
        if _cross:
            print(f"  Cross-page quotes: {_cross}")
    except Exception as _e:
        print(f"  Cross-page quotes: skipped ({_e})")
    
    # ── 0b. Detect short heading paragraphs (before joining) ────
    # Convert lines like '**فصل : (title)**' or 'فصل : (title)' → '### فصل : (title)'
    # Same for باب، الباب، الفصل — only for short paragraphs (≤250 chars)
    heading_words = r'(?:فصل|باب|الباب|الفصل)\b'
    _lines = c.split('\n')
    for _i in range(len(_lines)):
        _s = _lines[_i].strip()
        _m = re.match(r'^(?:\*{1,2})?\s*(' + heading_words + r'.*?)(?:\*{1,2})?\s*$', _s)
        if not _m:
            continue
        _inner = re.sub(r'\*+', '', _m.group(1)).strip()
        # Only a SHORT line that stands on its own (blank lines around it) is a
        # heading. A long line merely beginning with باب/فصل is prose.
        if len(_inner) > 60:
            continue
        _prev_blank = (_i == 0 or _lines[_i - 1].strip() == '')
        _next_blank = (_i == len(_lines) - 1 or _lines[_i + 1].strip() == '')
        if _prev_blank and _next_blank:
            _lines[_i] = f'### {_inner}'
    c = '\n'.join(_lines)

    # ── 0d. TOC pages ──────────────────────────────────────────
    # Do this before paragraph joining: TOC lines are one entry per line but
    # have no blank lines between them.
    c = format_toc_blocks(c)
    print(f"  TOC: {c.count('>[!TOC]')} callouts")
    
    # Gemini sometimes writes a hemistich pair as "h1 *** h2" (using *** as
    # the separator) instead of the required "* h1%%h2". Normalize it here,
    # before the footnote pass treats the *** as a footnote divider.
    c = re.sub(r'^([^\n*#>-][^\n]*?) \*\*\* ([^\n]+)$',
               lambda m: f'* {m.group(1).strip()}%%{m.group(2).strip()}', c, flags=re.M)

    # Join broken paragraphs: single \n between prose lines → join
    lines = c.split('\n')
    out = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        # Skip empty lines, headings, callout lines, and poetry markers. A
        # '%%' line has no leading marker in some Gemini output; do not join
        # it into the surrounding prose before the poetry pass sees it.
        if not s or s.startswith('#') or s.startswith('>') or s.startswith('*') or s == '---' or is_poetry_line(s):
            out.append(lines[i]); i += 1; continue
        
        # Collect consecutive prose lines (single \n between them)
        buf = [lines[i]]
        j = i + 1
        while j < len(lines):
            ns = lines[j].strip()
            if not ns or ns.startswith('#') or ns.startswith('>') or ns.startswith('*') or ns == '---' or is_poetry_line(ns):
                break
            if j > i + 1 and lines[j-1].strip() == '':
                break  # blank line between → new paragraph
            buf.append(lines[j])
            j += 1
        
        out.append(' '.join(buf))
        i = j
    
    c = '\n'.join(out)
    
    # ── 1. Quran formatting ────────────────────────────────────
    # Normalize ALL LF...LE spans: strip inner *, wrap as *LF...LE*
    def _normalize_quran_span(m):
        inner = m.group(1)
        inner = re.sub(r'\s*\*\s*', ' ', inner).strip()  # strip all * inside
        return f'*{LQ}{inner}{LQE}*'
    # Match any LF...LE that doesn't already have {.quran-quote} and isn't
    # inside an already-formatted *LF...LE* span
    c = re.sub(r'(?<!\*)' + LQ + r'([^' + LQE + r']+)' + LQE + r'(?!\{\.quran-quote\})',
               _normalize_quran_span, c)
    # Strip Gemini's Western-style citations: *LF...LE* [ref] or (ref) with digits
    # Keep Arabic citations (contain Arabic letters) for convert_gemini_refs
    c = re.sub(
        r'(\*' + LQ + r'[^' + LQE + r']+' + LQE + r'\*)'
        r'\s*[\[\(](?![\u0600-\u06FF])[^\]\)\n]*[\d][^\]\)\n]*[\]\)]',
        r'\1', c
    )
    # Fix (*LF...LE*) double-wrapping: strip outer parens, keep inner brackets
    c = re.sub(r'\(\s*(\*' + LQ + r'[^' + LQE + r']+' + LQE + r'\*)\s*\)', r'\1', c)
    # Same for guillemets: « *LF...LE* » Gemini puts quotes inside fancy quotes
    c = re.sub(r'«\s*(\*' + LQ + r'[^' + LQE + r']+' + LQE + r'\*)\s*»', r'\1', c)
    # Strip verse numbers inside brackets: *LF text (verse) LE* → *LF text LE*
    # Convert (LF...LE) with digits to just the text inside (no deletion)
    c = re.sub(
        r'\(' + LQ + r'([^' + LQE + r']*[\d\u0660-\u0669]+[^' + LQE + r']*)' + LQE + r'\)',
        r'(\1)', c
    )
    # Fix misplaced {.quran-quote} outside asterisks
    c = re.sub(r'(\*' + LQ + r'[^' + LQE + r']+' + LQE + r')\*\{\.quran-quote\}',
               r'\1{.quran-quote}*', c)
    # Add {.quran-quote} to *LF...LE* (Gemini's default format)
    c = re.sub(r'(\*' + LQ + r'[^' + LQE + r']+' + LQE + r')\*(?!\{\.quran-quote\})',
               r'\1{.quran-quote}*', c)
    # Handle partial quotes (page breaks): *LF text* or *text LE*
    c = re.sub(r'\*' + LQ + r'([^*' + LQE + r'\n{}]+)\*(?!\{\.quran-quote\})',
               r'*' + LQ + r'\1' + LQE + r'{.quran-quote}*', c)
    c = re.sub(r'\*([^*' + LQ + r'\n{}]+)' + LQE + r'\*(?!\{\.quran-quote\})',
               r'*' + LQ + r'\1' + LQE + r'{.quran-quote}*', c)
    # Fix double stars and missing open/close
    c = re.sub(r'\*\*' + LQ, r'*' + LQ, c)
    c = re.sub(r'(\*' + LQ + r'[^' + LQE + r']+' + LQE + r'\{\.quran-quote\})(?!\*)',
               r'\1*', c)
    print(f"  Quran: {c.count('{.quran-quote}')} spans")

    # A Qur'an quote is never a heading — Gemini sometimes bolds one as a
    # heading. Demote any heading whose content begins with a quote span.
    c = re.sub(r'^#{1,6}[ \t]*(?=\*?' + LQ + r')', '', c, flags=re.M)

    # A heading that is only a page number (### \u0663) is a running header.
    c = re.sub(r'^#{1,6}[ \t]*[\d\u0660-\u0669]+[ \t]*\n', '', c, flags=re.M)

    # ── 3. Poetry: %% lines → >[!arabic-poetry] callouts ──
    # Lines containing %% are poetry hemistiches. Group consecutive ones.
    lines = c.split('\n')
    out = []
    in_poetry = False
    
    for i, line in enumerate(lines):
        s = line.strip()
        is_poetry = is_poetry_line(s)

        # Legacy '* text * text' form: two hemistiches separated by a bare
        # asterisk. Convert it to the canonical '%%' form before parsing.
        if s.startswith('* ') and ' * ' in s[2:] and len(s) < 250:
            inner = s[2:]
            parts = inner.rsplit(' * ', 1)
            if len(parts) == 2 and len(parts[0].strip()) > 3 and len(parts[1].strip()) > 3:
                s = f"§§§ {parts[0].strip()}%%{parts[1].strip()}"
                is_poetry = True

        if is_poetry:
            # Remove the line marker, then any legacy '*' or '-' marker.
            inner = POETRY_MARK_RE.sub('', s).strip()
            inner = re.sub(r'^[\*\-]\s*', '', inner).strip()
            parts = [
                p.strip().strip('*').strip()
                for p in inner.split('%%')
                if p.strip().strip('*').strip()
            ]
            if not parts:
                continue
            if not in_poetry:
                out.append('>[!arabic-poetry]')
                in_poetry = True
            # A line may carry more than one couplet when Gemini ignored the
            # no-line-breaks instruction. Pair the hemistiches in order.
            for k in range(0, len(parts), 2):
                out.append('>-')
                out.append(f'>\t- {parts[k]}')
                if k + 1 < len(parts):
                    out.append(f'>\t- {parts[k + 1]}')
            continue
        
        if in_poetry:
            if s == '':
                j = i + 1
                while j < len(lines) and lines[j].strip() == '': j += 1
                if j < len(lines) and is_poetry_line(lines[j]):
                    continue
            in_poetry = False
            out.append(line)
            continue
        
        out.append(line)
    
    c = '\n'.join(out)
    print(f"  Poetry: {c.count('>[!arabic-poetry]')} callouts")
    
    # ── 3b. Footnotes: (N) paragraphs → callouts, inline (N) → <sup>(N)</sup> ──
    lines = c.split('\n')
    
    # Pass 1: Detect footnote paragraphs (start with (N))
    fn_starts = set()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if re.match(r'^\([\u0660-\u0669]\)', s):
            fn_starts.add(i)
            j = i + 1
            while j < len(lines) and (re.match(r'^\([\u0660-\u0669]\)', lines[j].strip()) or lines[j].strip() == ''):
                if re.match(r'^\([\u0660-\u0669]\)', lines[j].strip()):
                    fn_starts.add(j)
                j += 1
        i += 1
    
    # Pass 2: Apply <sup> to inline (N) NOT at paragraph start
    for idx in range(len(lines)):
        if idx in fn_starts:
            continue
        s = lines[idx].strip()
        if s and not s.startswith('>[!') and not s.startswith('#'):
            lines[idx] = re.sub(r'\(([\u0660-\u0669])\)', r'<sup>(\1)</sup>', lines[idx])
    
    # Pass 3: Group footnote paragraphs into callouts
    out = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if i in fn_starts:
            fn_lines = []
            j = i
            while j < len(lines) and (j in fn_starts or lines[j].strip() == ''):
                if j in fn_starts:
                    fn_lines.append(lines[j].strip())
                j += 1
            out.append('>[!arabic-footnotes]')
            for fn in fn_lines:
                out.append(f'>- {fn}')
            out.append('')
            i = j
            continue
        out.append(lines[i])
        i += 1
    c = '\n'.join(out)
    print(f"  Footnotes (N): {c.count('>[!arabic-footnotes]')} callouts")
    
    # ── 4. Footnotes: *** divider → callouts ───────────────────
    def fix_footnotes(m):
        block = m.group(0)
        lines = block.split('\n')
        result = ['>[!arabic-footnotes]']
        for line in lines:
            s = line.strip()
            if s in ('***', '---', ''): continue
            # Skip invented/summary entries that start with *
            if re.match(r'-\s*\*', s): continue
            if re.match(r'-\s*\d+\s*[-–]', s): result.append('>' + s)
            elif s.startswith('- '): result.append('>' + s.lstrip('- '))
            elif s.startswith('-'): result.append('>-' + s[1:])
            else: result.append(f'>- {s}')
        # If all entries were invented, return empty (will be cleaned later)
        return '\n'.join(result) if len(result) > 1 else ''
    c = re.sub(r'(?m)^\*\*\*[ \t]*$[\s\S]*?(?=\n\n(?:####|#|$))', fix_footnotes, c)
    # Remove invented footnote entries: >- * text
    c = re.sub(r'>- \* .+\n?', '', c)
    # Remove now-empty callout headers
    c = re.sub(r'>\[!arabic-footnotes\]\n(?!>)', '', c)
    c = re.sub(r'>\[!arabic-footnotes\]\n\n', '', c)
    print(f"  Footnotes (***): {c.count('>[!arabic-footnotes]')} callouts")

    # ── 5. TOC formatting ─────────────────────────────────────
    c = re.sub(r'-\s+(.+?)\s+\[\[####\s*p\.\s+(\d+)\|(\d+)\]\]',
               lambda m: f'>- {m.group(1).strip()} [[#p.{NBSP}{m.group(2)}|{m.group(2)}]]', c)
    # Wrap consecutive TOC entries with header and >- prefix
    lines = c.split('\n')
    out = []
    in_toc = False
    for line in lines:
        s = line.strip()
        if s.startswith('>- ') and '[[#p.' in s:
            if not in_toc: out.append('>[!TOC]'); in_toc = True
            out.append(line); continue
        # Unnumbered continuation paragraphs in TOC — still need >- prefix
        if in_toc and s and not s.startswith('>') and not s.startswith('#'):
            out.append(f'>- {s}'); continue
        in_toc = False
        out.append(line)
    c = '\n'.join(out)
    # Ensure blank line between فهرس heading and [!TOC]
    c = re.sub(r'(#+ .*?[فف]هر[سست][^\n]*)\n(>\[!TOC\])', r'\1\n\n\2', c)
    print(f"  TOC: {c.count('>[!TOC]')} callouts")

    # ── 6. Remove page footers (- N -) ─────────────────────────
    c = re.sub(r'^[-–—]\s*\d+\s*[-–—]\s*$', '', c, flags=re.MULTILINE)

    # ── 7. Remove running headers ──────────────────────────────
    pages = re.split(r'\n(?=#### )', c)
    fixed = []
    for pg in pages:
        lines = pg.split('\n')
        cleaned = []
        header_done = False
        for i, line in enumerate(lines):
            s = line.strip()
            if not header_done:
                # Book title header
                if re.match(r'^#\s+في\s+رياض\s+التفسير', s): continue
                # A bare page-number heading / line (a running number)
                if re.match(r'^(?:#{1,6}\s*)?[\u0660-\u0669\d]{1,4}\s*$', s): continue
                # Sura running headers: plain, '## sura', or '### ٢ - سورة البقرة'
                m = re.match(
                    r'^(?:#{1,6}\s*)?(?:[\u0660-\u0669\d]{1,4}\s*[-\u2013\u2014]?\s*)?'
                    r'(سورة\s+.+?)(\s+في\s+رياض\s+التفسير)?\s*$', s)
                if m:
                    is_real = False
                    for j in range(i+1, min(i+5, len(lines))):
                        ns = lines[j].strip()
                        if ns.startswith(('مكية', 'مدنية')) or 'مكية' in ns or 'مدنية' in ns:
                            is_real = True; break
                    if not is_real: continue
                header_done = True
            cleaned.append(line)
        stripped = '\n'.join(cleaned)
        stripped = re.sub(r'\n*---\n*$', '', stripped).rstrip()
        fixed.append(stripped)
    c = '\n\n---\n\n'.join(fixed)

    # Remove sura running headers that sit in the first few lines after a page
    # heading (e.g. "### ٢ - سورة البقرة"), unless it is a real sura heading
    # (followed by مكية/مدنية). Scoped to page starts so it cannot touch body text.
    _out = []
    _lines = c.split('\n')
    _after_page = 0
    for _i, _line in enumerate(_lines):
        _s = _line.strip()
        if re.match(r'^#{1,6}\s*p\.', _s):
            _after_page = 3
            _out.append(_line)
            continue
        if _after_page > 0:
            _after_page -= 1
            if _s:
                _m = re.match(
                    r'^(?:#{1,6}\s*)?(?:[\u0660-\u0669\d]{1,4}\s*[-\u2013\u2014]?\s*)?'
                    r'(سورة\s+.+?)(\s+في\s+رياض\s+التفسير)?\s*$', _s)
                if _m:
                    _is_real = False
                    for _j in range(_i + 1, min(_i + 5, len(_lines))):
                        _ns = _lines[_j].strip()
                        if _ns.startswith(('مكية', 'مدنية')) or 'مكية' in _ns or 'مدنية' in _ns:
                            _is_real = True; break
                    if not _is_real:
                        continue
        _out.append(_line)
    c = '\n'.join(_out)

    # ── 8. Paragraph separation ────────────────────────────────
    # Rule: every line break IS a paragraph boundary.
    # Add blank lines between consecutive non-heading, non-callout, non-poetry prose lines.
    # IMPORTANT: This must run AFTER poetry conversion (step 4) so poetry lines are already in callouts.
    # Never join — only separate.
    lines = c.split('\n')
    out = []
    prev_prose = False
    in_callout = False
    for line in lines:
        s = line.strip()
        if s.startswith('>['): in_callout = True
        if in_callout and not s.startswith('>'): in_callout = False
        
        is_prose = (s and not s.startswith('#') and not s.startswith('>') 
                    and s != '---' and s != '***' and not in_callout)
        
        if is_prose and prev_prose:
            out.append('')  # Add blank line between paragraphs
        out.append(line)
        prev_prose = is_prose
    c = '\n'.join(out)
    
    # ── Non-Qur'an LF quotes → regular parentheses ──
    # Strip LF markers from hadith (صلى الله, ﷺ, النبي, etc.)
    # Quotes inside *LF...LE* that lack {.quran-quote} → (text)
    hadith_flags = ['صلى الله', 'رضي الله', '\ufdfa', 'النبي', 'رسول الله', 'عليه السلام', 'اللهم']
    
    def fix_false_quran(m):
        text = m.group(1)
        # Check text AND preceding context for hadith indicators
        full = m.group(0)  # entire match
        start = m.start()
        before = c[max(0, start-30):start]  # 30 chars before the quote
        if any(w in text for w in hadith_flags) or any(w in before for w in hadith_flags):
            return f'({text.strip()})'
        if '\u0648\u0641\u064a \u0627\u0644\u062d\u062f\u064a\u062b' in before:  # وفي الحديث
            return f'({text.strip()})'
        return m.group(0)
    
    c = re.sub(
        r'\*' + LQ + r'([^' + LQE + r']*)' + LQE + r'\*(?!\{\.quran-quote\})',
        fix_false_quran, c
    )
    # Also handle quotes that already have {.quran-quote} but contain hadith
    c = re.sub(
        r'\*' + LQ + r'([^' + LQE + r']*)' + LQE + r'\{\.quran-quote\}\*',
        fix_false_quran, c
    )
    
    # ── Strip LF markers from inside poetry callouts ──
    # Gemini sometimes marks Qur'an-like phrases in poetry — remove markers, keep text
    lines = c.split('\n')
    out = []
    in_poetry = False
    for line in lines:
        s = line.strip()
        if s == '>[!arabic-poetry]':
            in_poetry = True
        elif s == '':
            in_poetry = False
        if in_poetry and (LQ in line or LQE in line):
            line = line.replace(LQ, '').replace(LQE, '').replace('{.quran-quote}', '')
            line = re.sub(r'\*(?=\S)', '', line)  # strip * before text
            line = re.sub(r'(?<=\S)\*', '', line)  # strip * after text
        out.append(line)
    c = '\n'.join(out)
    
    # ── 9. Spacing normalization ─────────────────────────────
    c = normalize_spacing(c)

    # ── Repair page headings, last, in case any pass touched them ──
    c = re.sub(r'([^\n])(####\s+p\.?\s*\*?\s*\d+\s*)$', r'\1\n\n\2', c, flags=re.M)
    c = re.sub(r'^####\s+p\.?\s*\*?\s*(\d+)\s*$', r'#### p. \1', c, flags=re.M)
    print(f"  Spacing normalized")

    return c


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 postprocess-gemini-batch.py <input.md>")
        sys.exit(1)

    result = process(sys.argv[1])
    
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    stem = Path(sys.argv[1]).stem
    outname = f"{stem}.formatted.{ts}.md"
    outpath = Path(sys.argv[1]).parent / outname
    
    with open(outpath, 'w', encoding='utf-8') as f:
        f.write(result)
    
    print(f"\nWritten: {outname}")
    print(f"Pages: {result.count('#### ')}")
    print(f"Quran spans: {result.count('{.quran-quote}')}")
    print(f"Wikilinks: {len(re.findall(r'\(\[\[', result))}")
    print(f"Footnotes: {result.count('>[!arabic-footnotes]')} / Poetry: {result.count('>[!arabic-poetry]')} / TOC: {result.count('>[!TOC]')}")
    print(f"Double ---: {len(re.findall(r'\n\n---\n\n---\n\n', result))}")
