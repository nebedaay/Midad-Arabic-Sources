#!/usr/bin/env python3
"""Turn the Hans Wehr FODT into the dictionary JSON the plugin should read.

The app's SQLite threw away two things the book prints — Wehr's **homonym
number** (before the Arabic term) and the **diptote marker** (a superscript after
the romanization) — and it also rebuilt the text with markup. This converter
keeps what the FODT actually encodes:

  * one record per `text:p`, in the book's order, `id` = the paragraph index;
  * `level` = `fo:margin-left` + `fo:text-indent` (0.0 is unindented = a root);
  * `is_root` = `level == 0.0` — what the book shows, not a correction;
  * `homonym` = the superscript number before the Arabic term;
  * the diptote stays where it is printed, as `<sup>2</sup>` after the term;
  * `root_id` = the root the entry is filed under. Usually the nearest
    unindented paragraph before it, but `_REPARENT` (translated from the app's
    ids through the content alignment) undoes the digitisation's splits.

The 62 entries the FODT lost are carried over from the app's SQLite and marked
`source: "app-supplement"`. Their parentage follows the book's own divisions,
not the app's adjacency: page 466 has one root (`šarufa`), entries under شرع
before it, and the شرق root after it (the app had nested the مشرق group under
شرف by adjacency).

    python3 scripts/hanswehr-fodt-json.py --out ../../tmp/hanswehr-fodt
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hfa = _load("hanswehr_fodt_align", "hanswehr-fodt-align.py")
tsi = hfa.tsi

# The style sets are discovered by `read_fodt` (T71/T72/T74 are superscript in
# this document; T83 is the cyan highlight around the printed page numbers).
# `SUPPLEMENT_ID_BASE` keeps the hand-restored rows out of the FODT's id range.
SUPPLEMENT_ID_BASE = 100_000


def supplement_id(app_id: int) -> int:
    return SUPPLEMENT_ID_BASE + app_id

WORK = {
    "id": "hanswehr-fodt",
    "title": "Hans Wehr Dictionary (FODT)",
    "arabic": "معجم هانس ڤير",
    "author": "Hans Wehr",
    "editor": "J Milton Cowan",
    "source": "https://github.com/muhammad-abdurrahman/hans-wehr-fodt-parser",
    "note_prefix": "HWF",
    "body": "grid",
    "convention": "wehr",
    "unique": True,
    "license_attribution": "Text: Hans Wehr, A Dictionary of Modern Written Arabic, "
                           "ed. J Milton Cowan. Digitisation: muhammad-abdurrahman/"
                           "hans-wehr-fodt-parser (MIT, code only).",
}

# ── Print-only entries, absent from both digitizations ──────────────────────
#
# A word the OCR missed is missing from the FODT *and* from the app's SQLite
# (both descend from the same scan). These are curated from the print. A
# suffixed id (`26a`) keeps the parent association and gives the entry its own
# bookmark target (`^26a`) without shifting any FODT paragraph id; `order` puts
# it where the print has it (`26.5` sorts between 26 and 27).
PRINT_SUPPLEMENTS: list[dict] = [
    {
        "id": "26a",
        "root_id": 26,
        "word": "ابريزي",
        "definition": "ابريزي ibrīzī golden, of pure gold",
        "order": 26.5,
        "note": "print p. 1, after ابريز ibrīz",
    },
]

# ── The manual supplement, parented by the book's divisions ─────────────────
#
# The FODT lost a block around the page-467 mark. The app restored 62 entries by
# hand in 2021; its `parent_id` follows the *row order* in places (the مشرق
# group ended up under شرف). These overrides settle the roots the book shows:
# entries under شرع before šarufa (page 466), šarufa its own root, and the شرق
# root (page 467) taking شروق and the مشرق group.
_SUPPLEMENT_PARENT: dict[int, int] = {}
for _rid in range(11273, 11294):      # شرعى … مشترع, under شرع 11271
    _SUPPLEMENT_PARENT[_rid] = 11271
for _rid in range(11295, 11312):      # شرف … مستشرف, under šarufa 11294
    _SUPPLEMENT_PARENT[_rid] = 11294
for _rid in range(11313, 11328):      # شرق … مستشرق, under شرق 11312
    _SUPPLEMENT_PARENT[_rid] = 11312
for _rid in range(22462, 22469):      # نقيرة … ناقرة, under نقر 22453
    _SUPPLEMENT_PARENT[_rid] = 22453
for _rid in range(22565, 22569):      # نقى … منتق, under نقو 22561
    _SUPPLEMENT_PARENT[_rid] = 22561
for _rid in range(22571, 22572):      # نكب (noun), under نكب 22570
    _SUPPLEMENT_PARENT[_rid] = 22570
for _rid in range(5283, 5293):        # حمو … حام, under حمي 5282
    _SUPPLEMENT_PARENT[_rid] = 5282
for _rid in range(19204, 19208):      # كنية … مكنى, under كنو 19203
    _SUPPLEMENT_PARENT[_rid] = 19203
for _rid in range(19757, 19760):      # ملاشاة … متلاش, under لشى 19756
    _SUPPLEMENT_PARENT[_rid] = 19756


def _is_digits(text: str) -> bool:
    return bool(text.strip()) and text.strip().isascii() and text.strip().isdigit()


def clean_definition(paragraph: dict) -> str:
    """The paragraph as the app would carry it, but with the book's numbers kept.

    The leading homonym is removed (it becomes the `homonym` field) and the
    printed page numbers (cyan highlight) are dropped; every superscript digit
    after a Latin word becomes `<sup>N</sup>`, where it stands.
    """
    out: list[str] = []
    seen_text = False
    after_latin = False
    for text, style in paragraph["runs"]:
        if style in hfa.PAGE_STYLES:
            continue
        if style in hfa.SUP_STYLES and _is_digits(text):
            if not seen_text and paragraph["homonym"] is not None:
                continue                      # the leading homonym number
            if after_latin:
                out.append(f"<sup>{text.strip()}</sup>")
                after_latin = False
                continue
        out.append(text)
        stripped = text.rstrip()
        if stripped:
            seen_text = True
            after_latin = bool(re.search(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff]$", stripped))
    text = re.sub(r"[ \t]+", " ", "".join(out)).strip()
    return text


def _nearest_root(paragraphs: list[dict]) -> dict[int, int]:
    """Each paragraph's containing root by the book's indentation alone."""
    root_of: dict[int, int] = {}
    current = 0
    for para in paragraphs:
        if para["root"]:
            current = para["id"]
        root_of[para["id"]] = current or para["id"]
    return root_of


def _app_root(app_by_id: dict[int, dict], rid: int) -> int:
    seen: set[int] = set()
    while rid in app_by_id and rid not in seen:
        seen.add(rid)
        row = app_by_id[rid]
        if row["is_root"] or row["parent_id"] == rid:
            return rid
        rid = row["parent_id"]
    return rid


def build_entries() -> tuple[list[dict], dict, list[dict]]:
    fodt = hfa.read_fodt()
    app = hfa.read_app()
    app_by_id = {row["id"]: row for row in app}
    mapping, stats = hfa.align(app, fodt)

    # The app's two correction tables, translated to FODT paragraph ids.
    reparent = {mapping[a]: mapping[p] for a, p in tsi._REPARENT["hanswehr"].items()
                if a in mapping and p in mapping}
    eyeball = {mapping[r]: pair for r, pair in tsi._EYEBALL["hanswehr"].items()
               if r in mapping}

    # The style sum is the book's indentation, but the conversion sometimes
    # indents a root (شرع on p. 467) or flattens a derivative; the app's later
    # root corrections are the better hierarchy. Keep both: `is_root` is what
    # the FODT says, `app_root` what the corrected app says, and `root_id` is
    # resolved from the latter. (The 296 promotions and 31 demotions are a
    # correction table to extract once the FODT pipeline no longer reads the app.)
    app_root = {xid: app_by_id[rid]["is_root"] for rid, xid in mapping.items()}
    rootish: dict[int, bool] = {}
    for para in fodt:
        rootish[para["id"]] = app_root.get(para["id"], para["root"])
    base_root: dict[int, int] = {}
    current = 0
    for para in fodt:
        rid = para["id"]
        if rootish[rid]:
            current = rid
        base_root[rid] = current or rid

    entries: list[dict] = []
    for para in fodt:
        rid = para["id"]
        definition = clean_definition(para)
        if rid in eyeball:
            old, new = eyeball[rid]
            definition = definition.replace(old, new)
        root_id = base_root[rid]
        if rid in reparent:
            root_id = reparent[rid]      # the digitisation split; Wehr files it here
        entries.append({
            "id": rid,
            "word": hfa.headword(definition),
            "root_id": root_id,
            "is_root": para["root"],
            "app_root": app_root.get(rid),
            "level": para["level"],
            "homonym": para["homonym"],
            "definition": definition,
            "source": "fodt",
        })

    # ── The 62 rows the FODT lost, under the roots the book gives them ──────
    by_id = {e["id"]: e for e in entries}
    supplement_ids = stats["app_unmatched"]
    supplement_roots: set[int] = set()
    for rid in supplement_ids:
        aroot = _SUPPLEMENT_PARENT.get(rid) or _app_root(app_by_id, rid)
        if aroot in supplement_roots:
            continue
        if aroot in mapping:
            # The root itself is in the FODT (شرع, نقر, نقو …): attach to it.
            continue
        supplement_roots.add(aroot)

    # Move FODT paragraphs the app files under a restored root (شروق under شرق).
    moved = 0
    for rid, xid in mapping.items():
        aroot = _SUPPLEMENT_PARENT.get(rid) or _app_root(app_by_id, rid)
        if aroot in supplement_roots and xid in by_id:
            by_id[xid]["root_id"] = supplement_id(aroot)
            moved += 1

    for rid in supplement_ids:
        aroot = _SUPPLEMENT_PARENT.get(rid) or _app_root(app_by_id, rid)
        root_id = mapping.get(aroot, supplement_id(aroot))
        row = app_by_id[rid]
        entries.append({
            "id": supplement_id(rid),
            "app_id": rid,
            "word": hfa.headword(row["definition"]),
            "root_id": root_id,
            "is_root": row["is_root"],
            "level": 0.0 if row["is_root"] else 1.0,
            "homonym": None,
            "definition": row["definition"],
            "source": "app-supplement",
        })

    for item in PRINT_SUPPLEMENTS:
        entries.append({
            "id": item["id"],
            "root_id": item["root_id"],
            "word": item["word"],
            "is_root": False,
            "app_root": None,
            "level": 1.0,
            "homonym": None,
            "definition": item["definition"],
            "source": "print-supplement",
            "order": item["order"],
            "note": item.get("note", ""),
        })

    meta = {
        "fodt_sha256": hashlib.sha256(hfa.FODT_PATH.read_bytes()).hexdigest(),
        "fodt_paragraphs": len(fodt),
        "app_rows": len(app),
        "aligned": stats["matched"],
        "supplement_rows": len(supplement_ids),
        "supplement_roots": sorted(supplement_roots),
        "moved_under_supplement": moved,
        "reparented": len(reparent),
        "print_supplement_rows": len(PRINT_SUPPLEMENTS),
    }
    return entries, meta, app, mapping


def _book_order(entries: list[dict], mapping: dict[int, int]) -> dict[int | str, float]:
    """A single order for FODT and supplement rows, in the book's sequence.

    A print supplement carries an explicit `order` (`26.5`, between 26 and 27);
    an app supplement keeps its app id; an FODT row takes its aligned app id when
    it has one, so `شروق` (FODT 11342, app 11316) sorts after the app's شرق rows
    rather than after all the FODT ids.
    """
    reverse = {xid: rid for rid, xid in mapping.items()}
    out: dict[int | str, float] = {}
    for e in entries:
        if "order" in e:
            out[e["id"]] = float(e["order"])
        elif e["source"] == "app-supplement":
            out[e["id"]] = float(e["app_id"])
        else:
            out[e["id"]] = float(reverse.get(e["id"], e["id"]))
    return out


def build_units(entries: list[dict], mapping: dict[int, int],
                work: dict | None = None) -> list[dict]:
    """The plugin's dictionary units, built with the existing `_hw_*` machinery."""
    cfg = work or WORK
    order = _book_order(entries, mapping)
    by_root: dict[int, list[dict]] = defaultdict(list)
    for entry in entries:
        by_root[entry["root_id"]].append(entry)
    roots = sorted((e for e in entries if e["root_id"] == e["id"]),
                   key=lambda e: order[e["id"]])
    convention = cfg.get("convention", WORK["convention"])
    prefix = cfg.get("note_prefix", WORK["note_prefix"])
    title = cfg.get("dir") or cfg.get("title") or WORK["title"]

    groups: list[list[dict]] = []
    for root in roots:
        if (groups and groups[-1][0]["word"] == root["word"]
                and groups[-1][0]["homonym"] == root["homonym"]
                and not tsi._hw_starts_new_root(root["definition"])):
            groups[-1].append(root)
        else:
            groups.append([root])

    units: list[dict] = []
    for n, group in enumerate(groups):
        if n and n % 500 == 0:
            print(f"  roots {n}/{len(groups)}", file=sys.stderr, flush=True)
        root_ids = {r["id"] for r in group}
        derived = sorted((e for rid in root_ids for e in by_root.get(rid, [])
                          if e["id"] != e["root_id"]),
                         key=lambda e: order[e["id"]])
        derived_rows = [(e["id"], e["word"], e["definition"]) for e in derived]
        root = None
        sections: list[dict] = []
        for record in group:
            entry = tsi._hw_root_entry(record["id"], record["word"], record["definition"],
                                       derived_rows, prose=False, convention=convention)
            if entry is None:
                continue
            entry.update(homonym=record["homonym"], level=record["level"],
                         source=record["source"], book_root=record["is_root"])
            if root is None:
                root = entry
            else:
                sections.append(entry)
        if root is None:
            continue
        entries_out = list(sections)
        for record in derived:
            entry = tsi._hw_derived_entry(record["id"], record["word"],
                                          record["definition"], prose=False,
                                          convention=convention)
            if entry is None:
                continue
            entry.update(homonym=record["homonym"], level=record["level"],
                         source=record["source"], book_root=record["is_root"])
            entries_out.append(entry)
        if not entries_out and not root.get("bullets"):
            continue
        base_id = root["id"]
        if root.get("source") == "app-supplement" and base_id >= SUPPLEMENT_ID_BASE:
            base_id = f"S{base_id - SUPPLEMENT_ID_BASE}"
        units.append({
            "kind": "dict",
            "id": root["id"],
            "base": tsi._hw_note_base({**root, "id": base_id}, prefix),
            "title": f"{root['arabic']} {root['roman']}",
            "section_page": None,   # filled after the letter pages exist
            "root": root,
            "entries": entries_out,
        })

    indexed = tsi._hw_letter_index(units, convention)
    stem = {u["id"]: f"{title} - {u['base']}" for u in indexed}
    for unit in units:
        letter = tsi._hw_letter_of(unit["root"]["arabic"])
        unit["section_page"] = stem.get(letter, "")
    return indexed + units


def build_model(entries: list[dict], meta: dict, mapping: dict[int, int]) -> dict:
    units = build_units(entries, mapping)
    work = {
        "key": f"dictionary:{WORK['id']}",
        "collection": "dictionary",
        "collection_label": "Dictionaries",
        "id": WORK["id"],
        "name": WORK["title"],
        "title": WORK["title"],
        "dir": WORK["title"],
        "short": "",
        "title_ar": WORK["arabic"],
        "short_ar": "",
        "authors": [WORK["author"]],
        "translators": [],
        "aliases": [WORK["title"], WORK["arabic"]],
        "language": "ar",
        "languages": ["ar"],
        "language_links": ["Arabic"],
        "cssclass": "dictionary",
        "moc": "Dictionaries",
        "moc_sections": ["Arabic Texts"],
        "up": ["[[Dictionaries]]"],
        "source": WORK["source"],
        "license_attribution": WORK["license_attribution"],
        "repository_updated": "2017-03-30",
        "source_hash": meta["fodt_sha256"][:12],
        "author": WORK["author"],
        "body": WORK["body"],
        "note_prefix": WORK["note_prefix"],
        "supplement_from": 0,
        "convention": WORK["convention"],
        "volumes": 1,
        "section_level": 1,
        "date_built": 0,
        "mocs": ["Dictionaries"],
    }
    return tsi.work_model(work, units, tsi.datetime.now().strftime("%Y-%m-%d"), "stacked")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True, help="directory for dictionary.json")
    ap.add_argument("--transliteration-server", default="http://127.0.0.1:8756",
                    help="resident transliteration service (the model names roots that "
                         "lack a source transliteration)")
    ap.add_argument("--no-transliteration", action="store_true",
                    help="never call the service; name such roots from their radicals")
    args = ap.parse_args()

    tsi._TRANS_SERVER = args.transliteration_server
    tsi._TRANS_OFF = args.no_transliteration
    entries, meta, _app, mapping = build_entries()
    payload = {
        "schema": 1,
        "work": WORK,
        "source": meta,
        "entries": entries,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / "dictionary.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    model = build_model(entries, meta, mapping)
    model_path = args.out / "hanswehr-fodt.model.json"
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")

    roots = sum(1 for e in entries if e["is_root"])
    homonyms = sum(1 for e in entries if e["homonym"] is not None)
    diptotes = sum(1 for e in entries if "<sup>" in e["definition"])
    print(f"entries              {len(entries):,}")
    print(f"roots (level 0.0)    {roots:,}")
    print(f"homonym numbers      {homonyms:,}")
    print(f"definitions with <sup> {diptotes:,}")
    print(f"supplement rows      {meta['supplement_rows']:,} "
          f"({len(meta['supplement_roots'])} restored roots)")
    print(f"FODT rows re-parented {meta['moved_under_supplement']:,}"
          f" (under a restored root; plus {meta['reparented']} `_REPARENT`)")
    print(f"model units          {len(model['units']):,} "
          f"({sum(1 for u in model['units'] if u['kind'] == 'dict'):,} roots)")
    print(f"wrote {path}  ({path.stat().st_size / 1e6:.1f} MB)")
    print(f"wrote {model_path}  ({model_path.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
