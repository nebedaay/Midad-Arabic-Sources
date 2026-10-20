#!/usr/bin/env python3
"""Align the app's Hans-Wehr SQLite rows to the FODT paragraphs they came from.

The plugin reads `GibreelAbdullah/HansWehrDictionary`'s SQLite, but Wehr's text
originates in `muhammad-abdurrahman/hans-wehr-fodt-parser`'s `hanswehr.xml`
(MIT), which keeps what the app conversion dropped: the **homonym number** Wehr
prints before the Arabic term (`2بنك` beside `3مبنك`) and the **diptote marker**
he prints as a superscript after the romanization (`makka2`). To build a
FODT-derived model and still reuse the corrections keyed by the app's row ids
(`_EYEBALL`, `_REPARENT`), the two have to be joined **by content** — their ids
are different spaces (`مل` 179 agrees early; by `بنك` the app's 2188 is the
XML's 2225).

The two files are *almost* in the same order — a root is occasionally listed
differently (`داس` sits after `دار` in the FODT, before it in the app) — and the
join is exact once the app's markup is normalised away:

  * the app strips the leading homonym digit and the diptote superscript, so
    digits are ignored;
  * the app rebuilds the print's form labels as `<b>III</b>` and adds generated
    vocalised parentheticals (`III (حَارَبَ)`) that the FODT does not carry;
  * the two digitisation runs disagree on curly vs straight quotes.

Everything else — harakat, tatweel, whitespace — is folded too, because the two
runs of the same scan dotted their letters differently.

Usage
-----
    python3 scripts/hanswehr-fodt-align.py                 # summary + proof table
    python3 scripts/hanswehr-fodt-align.py --drift         # the unmatched rows
    python3 scripts/hanswehr-fodt-align.py --json          # full id map
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "text_source_import", str(Path(__file__).resolve().parent / "text-source-import.py")
)
tsi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tsi)

FODT_URL = (
    "https://raw.githubusercontent.com/muhammad-abdurrahman/"
    "hans-wehr-fodt-parser/master/hanswehr.xml"
)
APP_DB_URL = (
    "https://github.com/GibreelAbdullah/HansWehrDictionary/releases/latest/download/"
    "hanswehr.sqlite"
)


def _cache_path(url: str) -> Path:
    return tsi.CACHE_DIR / re.sub(r"[^\w.-]+", "_", url)[-180:]


FODT_PATH = _cache_path(FODT_URL)
APP_DB_PATH = _cache_path(APP_DB_URL)

# Namespaces of the FODT (OpenDocument flat XML).
_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
}
_T = "{%s}" % _NS["text"]
_S = "{%s}" % _NS["style"]
_FO = "{%s}" % _NS["fo"]

# ── Normalisation (the content key the two runs of the scan agree on) ─────────

_HARAKAT = re.compile(r"[\u064b-\u0652\u0670\u0640]")  # tanwīn, short vowels, tatweel
_QUOTES = {
    0x2018: "'", 0x2019: "'", 0x201B: "'", 0x02BC: "'", 0x0060: "'", 0x00B4: "'",
    0x201C: '"', 0x201D: '"',
}
_DIGITS = re.compile(r"[0-9\u0660-\u0669]+")
# The app's generated vocalised form after a roman-numeral label (`III (حَارَبَ)`),
# which the FODT does not carry.
_VOCALISED = re.compile(r"\b([IVX]+)\s*\([\u0600-\u06ff\u0750-\u077f\u064b-\u0652\s]+\)")


def norm_text(text: str, *, app: bool = False) -> str:
    """The fold both sides reduce to, so the same paragraph reads the same."""
    text = re.sub(r"<[^>]+>", "", text)
    if app:
        text = _VOCALISED.sub(r"\1", text)
    text = unicodedata.normalize("NFC", text)
    text = _HARAKAT.sub("", text)
    text = text.translate(_QUOTES)
    text = _DIGITS.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


# ── Reading the FODT ─────────────────────────────────────────────────────────

def _style_levels(root) -> dict[str, float]:
    """Paragraph style → its indentation, `fo:margin-left` + `fo:text-indent`.

    That sum is the whole of the app's `is_root` rule: `0.0` is unindented (a
    root), anything above it is a continuation.
    """
    levels: dict[str, float] = {}
    for style in root.iter(_S + "style"):
        props = style.find(_S + "paragraph-properties")
        if props is None:
            continue
        margin = props.get(_FO + "margin-left")
        indent = props.get(_FO + "text-indent")
        if margin is None:
            continue

        def inches(value: str | None) -> float:
            return float((value or "0").replace("in", "")) if value else 0.0

        levels[style.get(_S + "name")] = round(inches(margin) + inches(indent), 4)
    return levels


def _superscript_styles(root) -> set[str]:
    sup: set[str] = set()
    for style in root.iter(_S + "style"):
        props = style.find(_S + "text-properties")
        if props is not None and props.get(_S + "text-position", "").startswith("super"):
            sup.add(style.get(_S + "name"))
    return sup


def _highlight_styles(root) -> set[str]:
    """Styles carrying a background colour — the conversion's printed page numbers.

    LibreOffice writes the colour as `fo:background-color`, not
    `style:background-color`; testing only the latter left every page number in
    the text (`ابريز pure gold 1`).
    """
    marked: set[str] = set()
    for style in root.iter(_S + "style"):
        props = style.find(_S + "text-properties")
        if props is not None and (props.get(_S + "background-color")
                                  or props.get(_FO + "background-color")):
            marked.add(style.get(_S + "name"))
    return marked


# Filled by `read_fodt`, so consumers do not have to re-parse the document.
SUP_STYLES: set[str] = set()
PAGE_STYLES: set[str] = set()


def _runs(paragraph) -> list[tuple[str, str | None]]:
    """The paragraph's text as (text, style-name) runs, in document order."""
    out: list[tuple[str, str | None]] = []

    def walk(el, style: str | None = None) -> None:
        if el.tag == _T + "span":
            style = el.get(_T + "style-name")
        if el.text:
            out.append((el.text, style))
        for child in el:
            walk(child, style)
            if child.tail:
                out.append((child.tail, style))

    walk(paragraph)
    return out


def read_fodt(path: Path | None = None) -> list[dict]:
    """One entry per `text:p`, in the book's order, id = 1-based paragraph index."""
    path = path or FODT_PATH
    try:
        from lxml import etree  # type: ignore
        root = etree.parse(str(path), etree.XMLParser(recover=True, huge_tree=True)).getroot()
        paragraphs = root.xpath("//text:p", namespaces={"text": _NS["text"]})
    except ImportError:  # the stdlib parser recovers the same malformed tags
        import xml.etree.ElementTree as ET
        root = ET.parse(str(path)).getroot()
        paragraphs = list(root.iter(_T + "p"))
    global SUP_STYLES, PAGE_STYLES
    levels = _style_levels(root)
    sup = _superscript_styles(root)
    SUP_STYLES = sup
    PAGE_STYLES = _highlight_styles(root)
    out: list[dict] = []
    for i, paragraph in enumerate(paragraphs, start=1):
        style = paragraph.get(_T + "style-name")
        level = levels.get(style, 0.0)
        runs = _runs(paragraph)
        text = "".join(t for t, _ in runs)
        out.append({
            "id": i,
            "style": style,
            "level": level,
            "root": level == 0.0,
            "text": text,
            "runs": runs,
            "homonym": _homonym(runs, sup),
            "diptotes": _diptotes(runs, sup),
        })
    return out


def _digit_run(text: str) -> int | None:
    stripped = text.strip()
    return int(stripped) if stripped.isdigit() and stripped.isascii() else None


def _homonym(runs: list[tuple[str, str | None]], sup: set[str]) -> int | None:
    """Wehr's small number *before* the Arabic term, separating homonyms.

    Normally a superscript run (`1 خار`, `2بنك`); a bare one occurs too, so a
    leading digit is accepted when it directly precedes the Arabic — never a
    sense enumeration (`2. from …`) or the conversion's `1` for `l`.
    """
    for text, style in runs:
        if not text.strip():
            continue
        if style in sup and (value := _digit_run(text)) is not None:
            return value
        break  # the first real run is not a superscript number
    match = re.match(r"^\s*(\d+)(?=\s*[\u0600-\u06ff])", "".join(t for t, _ in runs))
    return int(match.group(1)) if match else None


def _diptotes(runs: list[tuple[str, str | None]], sup: set[str]) -> list[dict]:
    """The superscript numbers *after* a romanization — the diptote marker."""
    out: list[dict] = []
    previous = ""
    for text, style in runs:
        if style in sup and (value := _digit_run(text)) is not None:
            if previous and previous[-1].isascii() and previous[-1].isalpha():
                out.append({"value": value, "after": previous[-24:]})
        if text.strip():
            previous = text
    return out


# ── Reading the app SQLite ───────────────────────────────────────────────────

def read_app(path: Path | None = None) -> list[dict]:
    path = path or APP_DB_PATH
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        table = "entries"
        names = {str(r[0]).lower() for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
        if "entries" not in names:
            table = "dictionary"
        rows = conn.execute(
            f"SELECT id, word, definition, is_root, parent_id FROM {table} ORDER BY id")
        return [
            {"id": rid, "word": word or "", "definition": definition or "",
             "is_root": bool(is_root), "parent_id": parent}
            for rid, word, definition, is_root, parent in rows
        ]
    finally:
        conn.close()


# ── The join ─────────────────────────────────────────────────────────────────

_ARABIC = re.compile(r"[\u0600-\u06ff]+")
# Folded away when matching headwords: the hamza seat (`أ` `إ` `آ` → `ا`), the
# tāʾ marbūṭa, and the hollow roots the app writes with their wāw/yāʾ (`اود` for
# `آد`), which the two runs spell differently.
_SEATS = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ة": "ه",
                        "ى": "ي", "ئ": "ي", "ؤ": "و"})


def headword(text: str) -> str:
    """The entry's first Arabic run, after the homonym number and any root aside.

    Wehr's hollow roots print the root in parentheses — `آب (اوب) āba u …` in the
    app, and with the aside moved to the front in the FODT (`1(اوب) آب āba u …`)
    — so a parenthesised group cannot be mistaken for the headword.
    """
    plain = re.sub(r"\([^)]*\)", " ", _DIGITS.sub(" ", text))
    match = _ARABIC.search(plain)
    return match.group(0) if match else ""


def folded_head(text: str) -> str:
    head = headword(text)
    return _HARAKAT.sub("", head).translate(_SEATS)


def weakless_head(text: str) -> str:
    """The headword with its weak letters dropped — a root's own radicals.

    `نيل` and `نال` (the same root listed under two spellings) both reduce to
    `nl`, while `نكب` and `نخب` stay apart, so this is the guard that keeps an
    identical romanization (`nakaba`) from joining two different roots.
    """
    return folded_head(text).translate(str.maketrans("", "", "اويء"))


_ROMAN = re.compile(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff\u02bc\u02bf\u2018\u2019\u02be']+")


def roman_head(text: str) -> str:
    """The entry's romanization — the first Latin run after the Arabic headword.

    Two paragraphs that share both headword and romanization are the same entry
    even when the conversion mangled one body, so this settles the match where
    the text alone cannot.
    """
    match = _ROMAN.search(re.sub(r"\([^)]*\)", " ", _DIGITS.sub(" ", text)))
    return match.group(0).translate(_QUOTES).lower() if match else ""


_SIM_WINDOW = 400  # compare the head of a paragraph; entries differ early, not late


def _similarity(left: str, right: str) -> float:
    """How alike two folded paragraphs are.

    Also scored **prefix-wise**, because the two digitisation runs do not agree
    on where an entry ends: the FODT sometimes keeps the entry after it in the
    same paragraph (`معترف به … authorized ه 'ariqa …`), which the app split into
    two rows, so the app's row is only the head of the FODT paragraph.
    """
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    a, b = left[:_SIM_WINDOW], right[:_SIM_WINDOW]
    best = difflib.SequenceMatcher(None, a, b).ratio()
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    # A one-line letter heading (`ا`) must not score 1.0 as the prefix of a long
    # entry, so the prefix comparison needs a real entry's worth of text.
    if len(short) >= 16 and len(long_) > len(short) + 8:
        best = max(best, difflib.SequenceMatcher(None, short, long_[:len(short)]).ratio())
    return best


def align(app: list[dict], fodt: list[dict]) -> tuple[dict[int, int], dict]:
    """Map each app row id to its FODT paragraph id, by content.

    Exact folded-text hits are taken in the two files' shared order, but the
    order is **not** assumed globally: the two runs of the scan occasionally
    order a root differently (`داس` sits after `دار` in the FODT, before it in
    the app), so when no later paragraph carries the key the nearest one does.
    The rows left over (a few hundred, where the runs spell the text
    differently) are matched by headword, then by similarity in a local window.
    """
    app_keys = [norm_text(row["definition"], app=True) for row in app]
    fodt_keys = [norm_text(p["text"]) for p in fodt]
    positions: dict[str, list[int]] = defaultdict(list)
    head_index: dict[str, list[int]] = defaultdict(list)
    roman_index: dict[str, list[int]] = defaultdict(list)
    for i, para in enumerate(fodt, start=1):
        if fodt_keys[i - 1]:
            positions[fodt_keys[i - 1]].append(i)
        head = folded_head(para["text"])
        if head:
            head_index[head].append(i)
        roman = roman_head(para["text"])
        if roman:
            roman_index[roman].append(i)

    matched: dict[int, int] = {}
    last = 0
    for i, row in enumerate(app):
        key = app_keys[i]
        choices = positions.get(key)
        if choices:
            later = [x for x in choices if x > last]
            x = later[0] if later else min(choices, key=lambda c: abs(c - last))
            matched[i] = x
            last = x
            continue
        head = folded_head(row["definition"])
        roman = roman_head(row["definition"])
        near = set(head_index.get(head, ()))
        # A one- or two-letter romanization (`see`, `al`, `b`) is a function word,
        # not a headword, and would match half the book.
        if len(roman) >= 4:
            near |= set(roman_index.get(roman, ()))
        if near:
            candidates = {x + d for x in near for d in (-2, -1, 0, 1, 2)
                          if 1 <= x + d <= len(fodt)}
        else:
            candidates = set(range(max(1, last - 120), min(len(fodt), last + 320) + 1))
        best, best_score = None, 0.0
        for x in candidates:
            score = _similarity(fodt_keys[x - 1], key)
            para = fodt[x - 1]
            # The same romanization (and headword) is the same entry even when
            # one run mangled the body — the app's row is then the readable copy.
            same_radicals = weakless_head(para["text"]) == weakless_head(row["definition"])
            if len(roman) >= 4 and roman_head(para["text"]) == roman and same_radicals:
                score = max(score, 0.9)
            elif head and folded_head(para["text"]) == head:
                score = max(score, 0.5)
            if score > best_score:
                best, best_score = x, score
        # Near candidates carry a headword or romanization, so a weaker score
        # suffices; a blind window match must look like the same text.
        floor = 0.5 if near else 0.8
        if best is not None and best_score > floor:
            matched[i] = best
            last = best

    used = {x - 1 for x in matched.values()}
    xs = [matched[i] for i in sorted(matched)]
    stats = {
        "app_rows": len(app),
        "fodt_paragraphs": len(fodt),
        "matched": len(matched),
        "app_unmatched": [app[i]["id"] for i in range(len(app)) if i not in matched],
        "fodt_unmatched": [p["id"] for i, p in enumerate(fodt) if i not in used],
        "monotonic": all(a < b for a, b in zip(xs, xs[1:])),
    }
    return {app[i]["id"]: x for i, x in matched.items()}, stats


# ── Reporting ────────────────────────────────────────────────────────────────

PROOF_IDS = (179, 951, 2188, 2189, 2190, 4457, 4458, 7024, 7031, 7631, 7701)


def _first_word(text: str) -> str:
    plain = _DIGITS.sub(" ", text).strip()
    return (plain.split(" ", 1)[0] if plain else "")[:14]


def _proof(app: list[dict], fodt: list[dict], mapping: dict[int, int]) -> None:
    by_id = {row["id"]: row for row in app}
    print(f"{'app id':>6} {'fodt id':>7}  {'app word':<9} {'FODT headword':<15} "
          f"{'hom':>3} {'dip':>3} {'lvl':>5}  app-root")
    for rid in PROOF_IDS:
        row = by_id.get(rid)
        if row is None:
            continue
        xid = mapping.get(rid)
        if xid is None:
            print(f"{rid:>6} {'—':>7}  {row['word']:<9}  -- no FODT match --")
            continue
        para = fodt[xid - 1]
        hom = str(para["homonym"]) if para["homonym"] is not None else "·"
        dip = ",".join(str(d["value"]) for d in para["diptotes"]) or "·"
        print(f"{rid:>6} {xid:>7}  {row['word']:<9} {_first_word(para['text']):<15} "
              f"{hom:>3} {dip:>3} {para['level']:>5}  "
              f"{'root' if row['is_root'] else '-'}")


def _cell(text: str) -> str:
    return re.sub(r"\s+", " ", text).replace("\t", " ").strip()


def export(out: Path, app: list[dict], fodt: list[dict],
           mapping: dict[int, int], stats: dict) -> None:
    """Write the artefacts a person can open: the map, both sides, and the drift."""
    out.mkdir(parents=True, exist_ok=True)
    by_id = {row["id"]: row for row in app}

    (out / "app-fodt-map.json").write_text(
        json.dumps({str(k): v for k, v in sorted(mapping.items())},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")

    with (out / "alignment.tsv").open("w", encoding="utf-8") as fh:
        fh.write("app_id\tfodt_id\tapp_word\tfodt_headword\thomonym\tdiptote\t"
                 "level\tfodt_root\tapp_root\tsimilarity\tapp_definition_head\n")
        for rid, xid in sorted(mapping.items()):
            row, para = by_id[rid], fodt[xid - 1]
            dip = ",".join(str(d["value"]) for d in para["diptotes"])
            sim = _similarity(norm_text(row["definition"], app=True),
                              norm_text(para["text"]))
            fh.write("\t".join([
                str(rid), str(xid), _cell(row["word"]), _cell(headword(para["text"])),
                "" if para["homonym"] is None else str(para["homonym"]), dip,
                str(para["level"]), "1" if para["root"] else "0",
                "1" if row["is_root"] else "0", f"{sim:.3f}",
                _cell(row["definition"])[:120],
            ]) + "\n")

    with (out / "fodt-paragraphs.tsv").open("w", encoding="utf-8") as fh:
        fh.write("fodt_id\tlevel\troot\thomonym\tdiptote\ttext\n")
        for para in fodt:
            dip = ",".join(str(d["value"]) for d in para["diptotes"])
            fh.write("\t".join([
                str(para["id"]), str(para["level"]), "1" if para["root"] else "0",
                "" if para["homonym"] is None else str(para["homonym"]), dip,
                _cell(para["text"]),
            ]) + "\n")

    with (out / "app-rows-without-fodt.tsv").open("w", encoding="utf-8") as fh:
        fh.write("app_id\tword\tis_root\tparent_id\tdefinition\n")
        for rid in stats["app_unmatched"]:
            row = by_id[rid]
            fh.write("\t".join([str(rid), _cell(row["word"]), "1" if row["is_root"] else "0",
                                str(row["parent_id"]), _cell(row["definition"])]) + "\n")

    used = set(mapping.values())
    with (out / "fodt-paragraphs-without-app.tsv").open("w", encoding="utf-8") as fh:
        fh.write("fodt_id\tlevel\troot\theadword\ttext\n")
        for para in fodt:
            if para["id"] in used:
                continue
            fh.write("\t".join([str(para["id"]), str(para["level"]),
                                "1" if para["root"] else "0", _cell(headword(para["text"])),
                                _cell(para["text"])]) + "\n")

    (out / "README.md").write_text(
        "---\n"
        "created: 2026-10-19\n"
        "up:\n"
        '  - "[[AI gen]]"\n'
        "aliases:\n"
        "---\n\n"
        "# Hans Wehr FODT alignment artefacts\n\n"
        "Generated by `src/midad-arabic-sources/scripts/hanswehr-fodt-align.py --export`.\n\n"
        "The FODT itself is cached at\n"
        "`.midad-arabic-sources/cache/text-sources/https_raw.githubusercontent.com_muhammad-abdurrahman_hans-wehr-fodt-parser_master_hanswehr.xml`.\n\n"
        "- `app-fodt-map.json` — app SQLite row id → FODT paragraph id.\n"
        "- `alignment.tsv` — one row per joined entry, with the recovered homonym and diptote numbers, the indentation level, and a similarity score.\n"
        "- `fodt-paragraphs.tsv` — every FODT paragraph (25,069), level 0.0 marked as a root, with its numbers and full text.\n"
        "- `app-rows-without-fodt.tsv` — the 62 SQLite rows the FODT does not contain.\n"
        "- `fodt-paragraphs-without-app.tsv` — FODT paragraphs no SQLite row maps to (blanks, letter headings, continuation fragments and reordered roots).\n",
        encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="print the full app→fodt id map")
    ap.add_argument("--drift", action="store_true", help="list rows with no FODT match")
    ap.add_argument("--export", metavar="DIR", type=Path,
                    help="write the map and both sides as TSV/JSON to DIR")
    args = ap.parse_args()

    for path, url in ((FODT_PATH, FODT_URL), (APP_DB_PATH, APP_DB_URL)):
        if not path.exists():
            print(f"missing cache file: {path}\n  fetch {url}", file=sys.stderr)
            return 1

    fodt = read_fodt()
    app = read_app()
    mapping, stats = align(app, fodt)

    print(f"FODT paragraphs        {stats['fodt_paragraphs']:,}  (hanswehr.xml)")
    print(f"app SQLite rows        {stats['app_rows']:,}  (hanswehr.sqlite)")
    print(f"joined                 {stats['matched']:,} "
          f"({stats['matched'] / stats['app_rows'] * 100:.2f}% of app rows)")
    print(f"app rows with no FODT  {len(stats['app_unmatched']):,}")
    def _starts_arabic(text: str) -> bool:
        return bool(text.strip()) and "\u0600" <= text.strip()[0] <= "\u06ff"

    unused = [fodt[x - 1] for x in stats["fodt_unmatched"]]
    blank = sum(1 for p in unused if not p["text"].strip())
    fragments = sum(1 for p in unused if p["text"].strip() and not _starts_arabic(p["text"]))
    letters = sum(1 for p in unused
                  if _starts_arabic(p["text"]) and len(headword(p["text"])) == 1)
    print(f"FODT paragraphs not in app  {len(unused):,}"
          f"  ({blank} blank, {letters} letter headings, {fragments} continuation fragments)")
    print(f"order preserved        {stats.get('monotonic', True)}")
    if not stats.get("monotonic"):
        print("  (a few roots are listed in a different order in each file)")
    roots = sum(1 for p in fodt if p["root"])
    homo = sum(1 for p in fodt if p["homonym"] is not None)
    dipt = sum(1 for p in fodt if p["diptotes"])
    print(f"FODT level 0.0 (roots) {roots:,}   leading homonym number {homo:,}   diptote marker {dipt:,}")
    print()
    _proof(app, fodt, mapping)

    if args.export:
        export(args.export, app, fodt, mapping, stats)
        print(f"\nwrote artefacts to {args.export}")
    if args.drift:
        by_id = {row["id"]: row for row in app}
        print("\napp rows with no FODT paragraph:")
        for rid in stats["app_unmatched"]:
            print(f"  {rid:>6}  {by_id[rid]['definition'][:88]}")
    if args.json:
        print(json.dumps({str(k): v for k, v in sorted(mapping.items())},
                         ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
