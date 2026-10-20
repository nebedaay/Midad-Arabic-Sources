#!/usr/bin/env python3
"""List Wehr rows the digitisation marks as roots but that belong under another root.

Wehr files a derived form under its root, and the digitisation's `IS_ROOT` flag
usually agrees — but not always: `متأخر` (مُتَأَخِّر) is marked as a root of its own,
parented to itself, while the rest of the family (آخر, تأخير, مؤخر …) hangs off
`اخر`. The letters cannot tell us that: the distinction is morphological (`متأخر` is
م + ت + أخر), so a containment test matches thousands of legitimate roots.

What *is* precise is a participle or noun of place/instrument marked as a root: a
word that is `م` + another root's own word, whose transliteration begins `ma`/`mi`/
`mu`. Those are proposed here for review; the confirmed ones go in `_REPARENT` in
`text-source-import.py`, keyed by the source row id.

    python3 scripts/audit-parents.py            # list candidates
    python3 scripts/audit-parents.py --json     # machine-readable
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "text_source_import", str(Path(__file__).resolve().parent / "text-source-import.py")
)
tsi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tsi)

DB = (
    tsi.CACHE_DIR
    / "https_github.com_GibreelAbdullah_HansWehrDictionary_releases_latest_download_hanswehr.sqlite"
)
# A transliteration of a participle or a noun of place/instrument begins with `m`
# and a short vowel, which is what distinguishes it from a root that merely starts
# with a م (`ملك` to possess, `مال` wealth).
_MA_ROMAN = re.compile(r"^m[aiu]")
# A root entry lists the root's own forms (`<b>II</b> (اَخَّرَ) to delay`, `IV`, …);
# a derived form is a single entry with no form marker. That is the content signal
# that separates `اخر` (a root, whatever its word looks like) from `متأخر`.
# Derivational prefixes: a form-V participle (مت), a form-X maṣdar (است), a participle
# or noun of place (م), a form-II/V verb (ت).
_PREFIXES = ("مست", "مت", "است", "ان", "م", "ت")
_FORM_MARKER = re.compile(r"<b>\s*(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\s*</b>", re.I)


def candidates() -> list[dict]:
    """Rows a term was inadvertently split from the entry before them.

    The condition is adjacency *and* direction. Wehr lists a root and then its
    derivatives, and the digitisation usually follows; when it slips, the split row
    is marked as a root of its own, parented to itself, and sits immediately after
    the entry it belongs to — 179 `متاخر` right after 167 `اخر` and its children
    (168–178). So: the row is a root, and its word is the word of the root listed
    just before it plus a derivational prefix.

    That rules out the two ways the morphological test went wrong: `مراب -> راب`
    (the "parent" comes *later* than its child) and `مارش -> ارش` (20,000 ids apart
    and unrelated). What it cannot rule out is a root that genuinely begins with a
    prefix-like letter, which is why the definition is reported alongside — a root
    entry lists the root's own forms (`<b>II</b> …`), a split-off derivative does
    not.
    """
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        rows = list(conn.execute("SELECT id, word, definition, is_root, parent_id FROM DICTIONARY"))
    finally:
        conn.close()
    roots = [(rid, word) for rid, word, _d, is_root, _p in rows if is_root]
    previous: dict[int, tuple[int, str]] = {}
    for (a, wa), (b, _wb) in zip(roots, roots[1:]):
        previous[b] = (a, wa)
    out: list[dict] = []
    for rid, word, definition, is_root, _p in rows:
        if not is_root or rid not in previous:
            continue
        pid, pword = previous[rid]
        if not pword:
            continue
        prefix = next((pre for pre in _PREFIXES if word == pre + pword), None)
        if not prefix:
            continue
        out.append(
            {
                "id": rid,
                "word": word,
                "under": pword,
                "under_id": pid,
                "prefix": prefix,
                "lists_root_forms": bool(_FORM_MARKER.search(definition or "")),
                "roman": tsi._hw_extract_romanization(definition or ""),
                "definition": (definition or "")[:70],
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = ap.parse_args()
    found = candidates()
    if args.json:
        print(json.dumps(found, ensure_ascii=False, indent=1))
        return 0
    print(f"{len(found)} candidate(s): a term split from the entry before it\n")
    for c in found:
        warn = "  <-- definition lists root forms, review" if c["lists_root_forms"] else ""
        print(f"  {c['id']:>6}  {c['word']:<11} = {c['prefix']} + {c['under']:<8} ({c['under_id']}){warn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
