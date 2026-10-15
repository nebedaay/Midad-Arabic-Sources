#!/usr/bin/env python3
"""Acquire born-digital Arabic / English text corpora for the Obsidian vault.

This script does **acquisition only**. It downloads a work's source JSON (cached
under ``.midad-arabic-sources/``), normalises it into a language-neutral **render
model**, and writes that model to
``.midad-arabic-sources/source-models/<collection>/<id>.json``. The Midad Arabic Sources
plugin turns the model into markdown with editable ETA templates.

Collections currently configured:

  tafsir  Qur'ān commentaries (Arabic originals + English translations)
          catalog: spa5k/tafsir_api, mirroring quran.com / altafsir.com
  quran   Qur'ān translations (English)
          catalog: fawazahmed0/quran-api
  hadith  Ḥadīth collections (Arabic + English, bundled)
          catalog: AhmedBaset/hadith-json

Usage
-----
    python3 text-source-import.py list [--collection tafsir] [--language ar] [--json]
    python3 text-source-import.py fetch --key tafsir:ar-tafsir-al-jalalayn
    python3 text-source-import.py fetch --key hadith:bukhari
    python3 text-source-import.py fetch --key tafsir:ar-tafsir-al-jalalayn --surahs 1,112

The script prints JSON-lines events (``{"event": "..."}``) so the plugin can
stream progress. Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import time
import types
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path


# ── Paths ────────────────────────────────────────────────────────────────────

def _find_vault() -> Path:
    """Locate the vault root (env override, else nearest ancestor with .obsidian)."""
    env = os.environ.get("OBSIDIAN_VAULT")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        if (parent / ".obsidian").is_dir():
            return parent
    return here.parent.parent


VAULT = _find_vault()
CACHE_DIR = VAULT / ".midad-arabic-sources" / "cache" / "text-sources"
MODEL_DIR = VAULT / ".midad-arabic-sources" / "source-models"
QURAN_DIR = VAULT / "_7 Sources" / "Quran"

# Optional per-work title/author/dir overrides, keyed by "<collection>:<id>".
OVERRIDES_FILE = VAULT / ".midad-arabic-sources" / "text-source-titles.json"

DEFAULT_LAYOUT = "stacked"  # "stacked" | "table" (facing-page cells)

# ── Collections ──────────────────────────────────────────────────────────────
#
# Each collection declares:
#   label        human-readable name for the modal / CLI
#   catalog      URL of the catalog JSON
#   data         URL template for one sūrah ({id} = work id, {surah} = number)
#   kind         "tafsir" (list catalog) or "translation" (dict catalog)
#   languages    map of our codes ("ar"/"en") to catalog language strings
#   shape        how a downloaded file is structured:
#                  "ayah-list"  → [{text, ayah, surah}, …] or {"ayahs": […]}
#                  "chapter"    → {"chapter": [{chapter, verse, text}, …]}

COLLECTIONS: dict[str, dict] = {
    "tafsir": {
        "label": "Qurʾān commentaries (tafsīr)",
        "genre": "tafsir",
        "repo_label": "spa5k/tafsir_api",
        "catalog": "https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/editions.json",
        "data": "https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/{id}/{surah}.json",
        "kind": "tafsir",
        "languages": {"ar": "arabic", "en": "english"},
        "shape": "ayah-list",
        "moc": "Tafsīr Sources",
        "cssclass": "tafsir",
    },
    "tafsir-qul": {
        "label": "Qurʾān commentaries (QUL)",
        "genre": "tafsir",
        "repo_label": "Qurʾānic Universal Library",
        "catalog": "https://qul.tarteel.ai/api/v1/resources/tafsirs",
        # One request per sūrah: {id} is the QUL resource id, {surah} the chapter,
        # {count} its āya count. QUL expands a passage to every āya it covers, so
        # the usual consecutive-dedupe folds a shared passage into a ranged block.
        "data": "https://qul.tarteel.ai/api/v1/tafsirs/{id}/by_range?from={surah}:1&to={surah}:{count}",
        "kind": "qul-tafsir",
        "languages": {"ar": "arabic", "en": "english"},
        "shape": "qul-tafsir",
        "moc": "Tafsīr Sources",
        "cssclass": "tafsir",
    },
    "quran": {
        "label": "Qurʾān translations",
        "genre": "quran",
        "repo_label": "fawazahmed0/quran-api",
        "catalog": "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.min.json",
        "data": "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/{id}/{surah}.json",
        "kind": "translation",
        "languages": {"en": "english"},
        "shape": "chapter",
        "moc": "Qurʾān Translations",
        "cssclass": "quran",
    },
    "hadith": {
        "label": "Ḥadīth collections",
        "genre": "hadith",
        "repo_label": "AhmedBaset/hadith-json",
        "catalog": None,  # static list below
        "data": "https://cdn.jsdelivr.net/gh/AhmedBaset/hadith-json@v1.2.0/db/by_book/{group}/{id}.json",
        "kind": "hadith",
        "languages": {"ar": "arabic", "en": "english"},
        "shape": "hadith-book",
        "moc": "Ḥadīth Sources",
        "cssclass": "hadith",
    },
    "quran-text": {
        "label": "Qurʾān texts (riwāyāt)",
        "genre": "quran-text",
        "repo_label": "risan/quran-json",
        "catalog": None,  # static list below
        "data": "https://quran-json.risanb.com/text/{id}/chapters/{surah}.json",
        "kind": "quran-text",
        "languages": {"ar": "arabic"},
        "shape": "risan",
        "moc": "Qurʾān (text)",
        "cssclass": "quran",
    },
    "dictionary": {
        "label": "Dictionaries",
        "genre": "dictionary",
        "repo_label": "GibreelAbdullah/HansWehrDictionary",
        "catalog": None,  # static list below
        "data": "https://github.com/GibreelAbdullah/HansWehrDictionary/releases/latest/download/hanswehr.sqlite",
        "kind": "dictionary",
        "languages": {"ar": "arabic"},
        "shape": "sqlite",
        "moc": "Dictionaries",
        "cssclass": "dictionary",
        # Entries whose source gives no transliteration are named by romanizing
        # the bare root — that needs the transliteration service, so the plugin
        # asks the user before rendering a collection that declares this.
        "needs_transliteration": True,
    },
}

# Static catalogue for lexicons distributed as SQLite. The importer downloads
# the file and reads it with Python's own sqlite3 — no scraping, no JSON needed.
DICTIONARIES: list[dict] = [
    {
        "id": "hanswehr",
        "title": "Hans Wehr Dictionary",
        "arabic": "معجم هانس ڤير",
        "author": "Hans Wehr",
        "editor": "J Milton Cowan",
        "source": "https://github.com/GibreelAbdullah/HansWehrDictionary",
        "db": "https://github.com/GibreelAbdullah/HansWehrDictionary/releases/latest/download/hanswehr.sqlite",
        "db_path": "assets/hanswehr.sqlite",
        # `grid` = Wehr's label/content senses (a two-column callout); `prose` =
        # Lane's English paragraphs. `note_prefix` labels a root note's file name
        # and its `aliases:` — one per dictionary, so the two never collide.
        "body": "grid",
        "note_prefix": "HW",
        # Wehr's own transliteration — the European Orientalist system its text
        # uses (š, ṯ, ḵ, …) — so an engine reading still matches the note's text.
        "convention": "wehr",
    },
    {
        "id": "lanelexicon",
        "title": "Lane's Lexicon",
        "arabic": "معجم لين",
        "author": "Edward William Lane",
        "editor": "",
        "source": "https://github.com/GibreelAbdullah/LaneLexicon",
        "db": "https://github.com/GibreelAbdullah/LaneLexicon/releases/latest/download/lanelexicon.sqlite",
        "db_path": "assets/lanelexicon.sqlite",
        # Lane's definitions are English prose (with <i>/<h3>/<center> markup) and
        # carry no Latin transliteration, so the body renders as paragraphs and the
        # names come from the transliteration service.
        "body": "prose",
        "note_prefix": "LL",
        # Lane transliterates nothing itself, so its names follow the vault's own
        # convention (no case endings, verb/pronoun/preposition endings kept, the
        # two tanwīn exceptions).
        "convention": "vault",
        # The database folds the Supplement (Book II) into the Lexicon as one
        # work: its rows are a suffix block in the scan's own numbering, from this
        # id on (3,034 of 52,914 rows, 609 of them roots), attached under the
        # corresponding Lexicon roots. A root note marks where they begin.
        "supplement_from": 49881,
    },
]

# Āya counts (1..114), used to bound a QUL per-sūrah request. The standard
# Kūfan count; an over-run is harmless (records group by their surah key), an
# under-run would drop the tail, so a wrong entry is easy to spot and fix.
SURAH_AYAHS: list[int] = [
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128,
    111, 110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73,
    54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60,
    49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52,
    44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19,
    26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3,
    6, 3, 5, 4, 5, 6,
]

# Static catalogue for the AhmedBaset/hadith-json repository (17 collections).
# Titles are romanized to vault style; the Arabic titles are used in headings.
HADITH_BOOKS: list[dict] = [
    {"group": "the_9_books", "id": "bukhari", "title": "Ṣaḥīḥ al-Bukhārī", "arabic": "صحيح البخاري", "author": "Muḥammad b. Ismāʿīl al-Bukhārī"},
    {"group": "the_9_books", "id": "muslim", "title": "Ṣaḥīḥ Muslim", "arabic": "صحيح مسلم", "author": "Muslim b. al-Ḥajjāj"},
    {"group": "the_9_books", "id": "abudawud", "title": "Sunan Abī Dāwūd", "arabic": "سنن أبي داود", "author": "Abū Dāwūd al-Sijistānī"},
    {"group": "the_9_books", "id": "tirmidhi", "title": "Jāmiʿ al-Tirmidhī", "arabic": "جامع الترمذي", "author": "Abū ʿĪsā al-Tirmidhī"},
    {"group": "the_9_books", "id": "nasai", "title": "Sunan al-Nasāʾī", "arabic": "سنن النسائي", "author": "Aḥmad b. Shuʿayb al-Nasāʾī"},
    {"group": "the_9_books", "id": "ibnmajah", "title": "Sunan Ibn Mājah", "arabic": "سنن ابن ماجه", "author": "Ibn Mājah al-Qazwīnī"},
    {"group": "the_9_books", "id": "malik", "title": "Muwaṭṭaʾ Mālik", "arabic": "موطأ مالك", "author": "Mālik b. Anas"},
    {"group": "the_9_books", "id": "ahmed", "title": "Musnad Aḥmad", "arabic": "مسند أحمد", "author": "Aḥmad b. Ḥanbal"},
    {"group": "the_9_books", "id": "darimi", "title": "Sunan al-Dārimī", "arabic": "سنن الدارمي", "author": "al-Dārimī"},
    {"group": "other_books", "id": "riyad_assalihin", "title": "Riyāḍ al-Ṣāliḥīn", "arabic": "رياض الصالحين", "author": "Yaḥyā al-Nawawī"},
    {"group": "other_books", "id": "shamail_muhammadiyah", "title": "al-Shamāʾil al-Muḥammadiyya", "arabic": "الشمائل المحمدية", "author": "Abū ʿĪsā al-Tirmidhī"},
    {"group": "other_books", "id": "bulugh_almaram", "title": "Bulūgh al-Marām", "arabic": "بلوغ المرام", "author": "Ibn Ḥajar al-ʿAsqalānī"},
    {"group": "other_books", "id": "aladab_almufrad", "title": "al-Adab al-Mufrad", "arabic": "الأدب المفرد", "author": "Muḥammad b. Ismāʿīl al-Bukhārī"},
    {"group": "other_books", "id": "mishkat_almasabih", "title": "Mishkāt al-Maṣābīḥ", "arabic": "مشكاة المصابيح", "author": "Muḥammad b. ʿAbdallāh al-Khaṭīb al-Tibrīzī"},
    {"group": "forties", "id": "nawawi40", "title": "al-Arbaʿūn al-Nawawiyya", "arabic": "الأربعون النووية", "author": "Yaḥyā al-Nawawī"},
    {"group": "forties", "id": "qudsi40", "title": "al-Arbaʿūn al-Qudsiyya", "arabic": "الأربعون القدسية", "author": ""},
    {"group": "forties", "id": "shahwaliullah40", "title": "Arbaʿūn Shāh Walī Allāh", "arabic": "أربعون الشاه ولي الله", "author": "Shāh Walī Allāh al-Dihlawī"},
]

# Static catalogue for the risan/quran-json riwāya texts. `source_id` is the
# script id in that repository. The plugin decides which riwāya is canonical
# (its sūra notes are unprefixed); the others get prefixed notes.
QURAN_TEXTS: list[dict] = [
    {"id": "hafs", "source_id": "uthmani", "title": "Qurʾān (riwāyat Ḥafṣ)", "riwaya_ar": "رواية حفص"},
    {"id": "warsh", "source_id": "warsh", "title": "Qurʾān (riwāyat Warsh)", "riwaya_ar": "رواية ورش"},
    {"id": "qalun", "source_id": "qalun", "title": "Qurʾān (riwāyat Qālūn)", "riwaya_ar": "رواية قالون"},
    {"id": "duri", "source_id": "duri", "title": "Qurʾān (riwāyat al-Dūrī)", "riwaya_ar": "رواية الدوري"},
    {"id": "shubah", "source_id": "shubah", "title": "Qurʾān (riwāyat Shuʿbah)", "riwaya_ar": "رواية شعبة"},
    {"id": "susi", "source_id": "susi", "title": "Qurʾān (riwāyat al-Sūsī)", "riwaya_ar": "رواية السوسي"},
]

# Language code → English name. Extend freely; the importer derives the code
# from a catalogue's language string and renders the English name in the vault.
LANGUAGE_NAMES: dict[str, str] = {
    "ar": "Arabic", "en": "English", "fr": "French", "fa": "Persian", "ur": "Urdu",
    "tr": "Turkish", "id": "Indonesian", "ms": "Malay", "bn": "Bengali", "ru": "Russian",
    "es": "Spanish", "de": "German", "it": "Italian", "nl": "Dutch", "pt": "Portuguese",
    "sq": "Albanian", "bs": "Bosnian", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
    "hi": "Hindi", "sw": "Swahili", "ha": "Hausa", "ff": "Fulah", "so": "Somali",
    "th": "Thai", "vi": "Vietnamese", "ku": "Kurdish", "ps": "Pashto", "az": "Azerbaijani",
    "uz": "Uzbek", "tt": "Tatar", "kk": "Kazakh", "ky": "Kyrgyz", "tg": "Tajik",
    "sd": "Sindhi", "pa": "Punjabi", "ml": "Malayalam", "ta": "Tamil", "te": "Telugu",
    "kn": "Kannada", "mr": "Marathi", "gu": "Gujarati", "ne": "Nepali", "si": "Sinhala",
    "my": "Burmese", "km": "Khmer", "dv": "Divehi", "am": "Amharic", "he": "Hebrew",
    "yo": "Yoruba", "zu": "Zulu", "xh": "Xhosa", "st": "Sotho", "sn": "Shona",
    "ny": "Chichewa", "rw": "Kinyarwanda", "rn": "Rundi", "lg": "Ganda", "ln": "Lingala",
    "bm": "Bambara", "tw": "Twi", "om": "Oromo", "aa": "Afar", "af": "Afrikaans",
    "hy": "Armenian", "as": "Assamese", "ace": "Achinese", "ber": "Berber",
    "bg": "Bulgarian", "ca": "Catalan", "hr": "Croatian", "cs": "Czech", "da": "Danish",
    "eo": "Esperanto", "et": "Estonian", "fil": "Filipino", "fi": "Finnish",
    "gl": "Galician", "ka": "Georgian", "el": "Greek", "hu": "Hungarian",
    "is": "Icelandic", "ga": "Irish", "jv": "Javanese", "la": "Latin", "lv": "Latvian",
    "lt": "Lithuanian", "mk": "Macedonian", "mt": "Maltese", "mn": "Mongolian",
    "no": "Norwegian", "pl": "Polish", "ro": "Romanian", "sk": "Slovak",
    "sl": "Slovenian", "sv": "Swedish", "tl": "Tagalog", "uk": "Ukrainian",
    "ug": "Uyghur", "cy": "Welsh", "yi": "Yiddish", "dag": "Dagbani", "ill": "Iranun",
    "knx": "Kendayan", "mrw": "Maranao", "luy": "Luyia", "yau": "Yau", "prs": "Dari",
}

# Catalogue spellings that differ from the canonical English name above.
_LANGUAGE_ALIASES: dict[str, str] = {
    "azeri": "az", "central khmer": "km", "chinese(simplified)": "zh",
    "chinese(traditional)": "zh", "kirghiz": "ky", "kyrgyz": "ky", "pushto": "ps",
    "panjabi": "pa", "tagalog": "tl", "uighur": "ug", "divehi": "dv", "sinhala": "si",
    "fulah": "ff", "filipino": "fil", "iranun": "ill", "kendayan": "knx",
    "maranao": "mrw", "luyia": "luy", "yau": "yau", "twi": "tw", "ganda": "lg",
    "rundi": "rn", "sotho": "st", "shona": "sn", "chichewa": "ny", "dagbani": "dag",
    "kinyarwanda": "rw", "kurmanji": "ku", "dari": "prs",
}
_LANGUAGE_NAME_TO_CODE = {name.lower(): code for code, name in LANGUAGE_NAMES.items()}
_LANGUAGE_NAME_TO_CODE.update(_LANGUAGE_ALIASES)


def normalise_language(name: str) -> str | None:
    """Map a catalogue language string to a code (unknown → a slug)."""
    key = (name or "").strip().lower()
    if not key:
        return None
    if key in _LANGUAGE_NAME_TO_CODE:
        return _LANGUAGE_NAME_TO_CODE[key]
    return re.sub(r"[^a-z]+", "-", key).strip("-")


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code) or (code or "").title()


def moc_section(code: str) -> str:
    """Category-MOC heading for a language (e.g. ``Arabic Texts``)."""
    return f"{language_name(code)} Texts"

# Default overrides for well-known works. Merged with OVERRIDES_FILE if present.
BUILTIN_OVERRIDES: dict[str, dict] = {
    "tafsir:ar-tafsir-al-jalalayn": {
        "title": "Tafsīr al-Jalālayn",
        "short": "al-Jalālayn",
        "title_ar": "تفسير الجلالين",
        "short_ar": "الجلالين",
        "dir": "Tafsīr al-Jalālayn",
        "authors": ["Jalāl al-Dīn al-Maḥallī", "Jalāl al-Dīn al-Suyūṭī"],
    },
    "tafsir:en-al-jalalayn": {
        "title": "Tafsīr al-Jalālayn (English)",
        "short": "al-Jalālayn (English)",
        "title_ar": "تفسير الجلالين",
        "short_ar": "الجلالين",
        "dir": "Tafsīr al-Jalālayn (English)",
        "authors": [
            "Jalāl al-Dīn al-Maḥallī",
            "Jalāl al-Dīn al-Suyūṭī",
        ],
        "translators": ["Feras Hamza"],
    },
}

# ── Small helpers ────────────────────────────────────────────────────────────

ARABIC_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")

# Sūrah names as they appear in the vault's _7 Sources/Quran folder, with the
# Arabic name used for headings and reference display text. Kept as a fallback
# for when the Qur'ān folder cannot be read.
SURAH_NAMES: list[tuple[str, str]] = [
    ("Al-Fatihah", "الفاتحة"), ("Al-Baqarah", "البقرة"), ("Al 'Imran", "آل عمران"),
    ("An-Nisa", "النساء"), ("Al-Ma'idah", "المائدة"), ("Al-An'am", "الأنعام"),
    ("Al-A'raf", "الأعراف"), ("Al-Anfal", "الأنفال"), ("At-Tawbah", "التوبة"),
    ("Yunus", "يونس"), ("Hud", "هود"), ("Yusuf", "يوسف"),
    ("Ar-Ra'd", "الرعد"), ("Ibrahim", "إبراهيم"), ("Al-Hijr", "الحجر"),
    ("An-Nahl", "النحل"), ("Al-Isra", "الإسراء"), ("Al-Kahf", "الكهف"),
    ("Maryam", "مريم"), ("Taha", "طه"), ("Al-Anbya", "الأنبياء"),
    ("Al-Hajj", "الحج"), ("Al-Mu'minun", "المؤمنون"), ("An-Nur", "النور"),
    ("Al-Furqan", "الفرقان"), ("Ash-Shu'ara", "الشعراء"), ("An-Naml", "النمل"),
    ("Al-Qasas", "القصص"), ("Al-'Ankabut", "العنكبوت"), ("Ar-Rum", "الروم"),
    ("Luqman", "لقمان"), ("As-Sajdah", "السجدة"), ("Al-Ahzab", "الأحزاب"),
    ("Saba", "سبأ"), ("Fatir", "فاطر"), ("Ya-Sin", "يس"),
    ("As-Saffat", "الصافات"), ("Sad", "ص"), ("Az-Zumar", "الزمر"),
    ("Ghafir", "غافر"), ("Fussilat", "فصلت"), ("Ash-Shuraa", "الشورى"),
    ("Az-Zukhruf", "الزخرف"), ("Ad-Dukhan", "الدخان"), ("Al-Jathiyah", "الجاثية"),
    ("Al-Ahqaf", "الأحقاف"), ("Muhammad", "محمد"), ("Al-Fath", "الفتح"),
    ("Al-Hujurat", "الحجرات"), ("Qaf", "ق"), ("Adh-Dhariyat", "الذاريات"),
    ("At-Tur", "الطور"), ("An-Najm", "النجم"), ("Al-Qamar", "القمر"),
    ("Ar-Rahman", "الرحمن"), ("Al-Waqi'ah", "الواقعة"), ("Al-Hadid", "الحديد"),
    ("Al-Mujadila", "المجادلة"), ("Al-Hashr", "الحشر"), ("Al-Mumtahanah", "الممتحنة"),
    ("As-Saf", "الصف"), ("Al-Jumu'ah", "الجمعة"), ("Al-Munafiqun", "المنافقون"),
    ("At-Taghabun", "التغابن"), ("At-Talaq", "الطلاق"), ("At-Tahrim", "التحريم"),
    ("Al-Mulk", "الملك"), ("Al-Qalam", "القلم"), ("Al-Haqqah", "الحاقة"),
    ("Al-Ma'arij", "المعارج"), ("Nuh", "نوح"), ("Al-Jinn", "الجن"),
    ("Al-Muzzammil", "المزمل"), ("Al-Muddaththir", "المدثر"), ("Al-Qiyamah", "القيامة"),
    ("Al-Insan", "الإنسان"), ("Al-Mursalat", "المرسلات"), ("An-Naba", "النبأ"),
    ("An-Nazi'at", "النازعات"), ("'Abasa", "عبس"), ("At-Takwir", "التكوير"),
    ("Al-Infitar", "الانفطار"), ("Al-Mutaffifin", "المطففين"), ("Al-Inshiqaq", "الانشقاق"),
    ("Al-Buruj", "البروج"), ("At-Tariq", "الطارق"), ("Al-A'la", "الأعلى"),
    ("Al-Ghashiyah", "الغاشية"), ("Al-Fajr", "الفجر"), ("Al-Balad", "البلد"),
    ("Ash-Shams", "الشمس"), ("Al-Layl", "الليل"), ("Ad-Duhaa", "الضحى"),
    ("Ash-Sharh", "الشرح"), ("At-Tin", "التين"), ("Al-'Alaq", "العلق"),
    ("Al-Qadr", "القدر"), ("Al-Bayyinah", "البينة"), ("Az-Zalzalah", "الزلزلة"),
    ("Al-'Adiyat", "العاديات"), ("Al-Qari'ah", "القارعة"), ("At-Takathur", "التكاثر"),
    ("Al-'Asr", "العصر"), ("Al-Humazah", "الهمزة"), ("Al-Fil", "الفيل"),
    ("Quraysh", "قريش"), ("Al-Ma'un", "الماعون"), ("Al-Kawthar", "الكوثر"),
    ("Al-Kafirun", "الكافرون"), ("An-Nasr", "النصر"), ("Al-Masad", "المسد"),
    ("Al-Ikhlas", "الإخلاص"), ("Al-Falaq", "الفلق"), ("An-Nas", "الناس"),
]


def emit(event: str, **fields) -> None:
    """Print a JSON-lines event for the plugin, and nothing else."""
    payload = {"event": event}
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log(message: str) -> None:
    emit("log", message=message)


def arabic_numeral(n: int) -> str:
    return str(n).translate(ARABIC_DIGITS)


def slug_to_dir(value: str) -> str:
    """Sanitize a value for use as a folder/file name."""
    value = re.sub(r'[<>:"/\\|?*]', "", value)
    return re.sub(r"\s+", " ", value).strip()


# Romanization → searchable form: drop diacritics, map ʿ/ʾ to a straight apostrophe.
_DIACRITICS = str.maketrans({
    "ā": "a", "ī": "i", "ū": "u", "á": "a", "í": "i", "ú": "u",
    "ḥ": "h", "ṣ": "s", "ḍ": "d", "ṭ": "t", "ẓ": "z", "ḏ": "d", "ṯ": "t",
    "ġ": "g", "ḫ": "kh", "š": "sh", "ž": "zh", "ñ": "n",
    "Ā": "A", "Ī": "I", "Ū": "U", "Ḥ": "H", "Ṣ": "S", "Ḍ": "D", "Ṭ": "T", "Ẓ": "Z",
    "ʿ": "'", "ʾ": "'", "ʹ": "'", "ʻ": "'", "ʼ": "'",
})


def strip_diacritics(text: str) -> str:
    return (text or "").translate(_DIACRITICS)


# ── Qur'ān citation linking ──────────────────────────────────────────────────
# Arabic tafsīrs cite *other* verses inline in square brackets, e.g.
#   ﴿وَمَا يُؤْمِنُ أَكْثَرُهُمْ...﴾ [يُوسُفَ: ١٠٦]
# Those citations are replaced with links to the vault's canonical Qur'ān notes.
# A quote of the verse being commented carries no bracket citation (its `## [[…]]`
# heading already covers it), so it is left alone.

_ARABIC_TO_WESTERN = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_WESTERN_TO_ARABIC = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
# Citations come in several shapes across the tafsīr repositories:
#   [يُوسُفَ: ١٠٣]      Arabic sūra name, Arabic numerals  (Ibn Kathīr)
#   [ الأعراف : 3 ]      spaced, Western numerals          (Tanwīr al-Miqbās)
#   [٥٠: ٣٨]            sūra number : āya                  (al-Qurṭubī)
#   (القصص: ٥)          parenthesised                      (al-Mukhtaṣar)
# A number of editions (Muyassar, Saʿdī, Wasīṭ, Iʿrāb …) carry no citations at
# all, and editorial refs like `[تفسير ابن كثير: ٢ / ١٣٥]` never match a sūra.
_VerseCitation = re.compile(
    r"(?P<open>[\[(])\s*(?P<name>[^\[\]()]{1,40}?)\s*:\s*"
    r"(?P<ayah>[\u0660-\u0669\d]{1,4}(?:\s*[-\u2013\u060C,]\s*[\u0660-\u0669\d]{1,4})*)\s*(?P<close>[\])])"
)

_SURAH_NAME_INDEX: dict[str, dict] | None = None
_SURAH_ROWS: list[dict] | None = None

# Citations are matched against the canonical Qur'ān notes, so they only make
# sense for Ḥafṣ — the reading the vast majority of source texts quote. Set from
# `fetch --canonical`; any other riwāya disables the linking entirely.
_CANONICAL_RIWAYA = "hafs"


def _normalize_ayah_name(name: str) -> str:
    """Fold an Arabic sūra name to a comparable key (no tashkīl, unified alef)."""
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.category(c).startswith("Mn"))
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"),
                 ("ى", "ي"), ("ة", "ه"), ("ؤ", "و"), ("ئ", "ي")):
        name = name.replace(a, b)
    return re.sub(r"[^\u0600-\u06FF]", "", name)


def _surah_rows() -> list[dict]:
    """The sūra table, read from the vault once per run."""
    global _SURAH_ROWS
    if _SURAH_ROWS is None:
        _SURAH_ROWS = surah_table()
    return _SURAH_ROWS


def surah_name_index() -> dict[str, dict]:
    """Normalized sūra name → its table row (built once, from the vault notes)."""
    global _SURAH_NAME_INDEX
    if _SURAH_NAME_INDEX is None:
        _SURAH_NAME_INDEX = {}
        for row in _surah_rows():
            for name in (row.get("arabic"), row.get("translit")):
                if not name:
                    continue
                for key in (_normalize_ayah_name(name), re.sub(r"[^a-z]", "", name.lower())):
                    if key:
                        _SURAH_NAME_INDEX.setdefault(key, row)
    return _SURAH_NAME_INDEX


def _ar_numeral(n: int) -> str:
    """Western integer → Arabic-Indic numeral (as the vault's notes use)."""
    return str(n).translate(_WESTERN_TO_ARABIC)


def _lookup_surah(name: str) -> dict | None:
    """Resolve a citation's sūra from its name (Arabic or transliterated) or number."""
    key = re.sub(r"^سوره", "", _normalize_ayah_name(name))  # tolerate a leading "سورة"
    row = surah_name_index().get(key) or surah_name_index().get(re.sub(r"[^a-z]", "", name.lower()))
    if row:
        return row
    digits = name.strip().translate(_ARABIC_TO_WESTERN)
    if digits.isdigit() and 1 <= int(digits) <= len(_surah_rows()):
        return _surah_rows()[int(digits) - 1]
    return None


def link_verse_citations(text: str, *, skip: tuple[int, int] | None = None) -> str:
    """Replace `Sūrah: āya` citations with links to the vault's Qur'ān notes.

    Handles the shapes the repositories actually use (see `_VerseCitation`). `skip`
    is the (sūra, āya) of the verse being commented, so a citation of that very
    verse is left as written.
    """
    if not text or ":" not in text or _CANONICAL_RIWAYA != "hafs":
        return text

    def repl(m: re.Match) -> str:
        if (m.group("open") == "[") != (m.group("close") == "]"):
            return m.group(0)  # mismatched delimiters — not a citation
        name = m.group("name")
        row = _lookup_surah(name)
        if row is None and skip:
            # "[الآية: ١٢٣]" cites the current sūra (the one being commented).
            bare = re.sub(r"^ال", "", re.sub(r"^سوره", "", _normalize_ayah_name(name)))
            if bare in ("ايه", "ايت") and 1 <= skip[0] <= len(_surah_rows()):
                row = _surah_rows()[skip[0] - 1]
        if not row:
            return m.group(0)
        nums = [int(x.translate(_ARABIC_TO_WESTERN))
                for x in re.findall(r"[\u0660-\u0669\d]{1,4}", m.group("ayah"))]
        if not nums:
            return m.group(0)
        first, last = nums[0], nums[-1]
        if skip and (row["number"], first) == skip:
            return m.group(0)
        if last != first:
            # A range or list (`٢٤-٢٧`, `١٧٢، ١٧٣`) links its two ends.
            return (f"([[{row['base']}#{first}|{row['arabic']} : {_ar_numeral(first)}]]"
                    f"–[[{row['base']}#{last}|{_ar_numeral(last)}]])")
        return f"([[{row['base']}#{first}|{row['arabic']} : {_ar_numeral(first)}]])"

    return _VerseCitation.sub(repl, text)


_QURAN_MODULE = None
# Quotes already carrying the vault's marker, plus the other delimiters a tafsīr
# may use for a Qur'ān quote instead of `﴿…﴾`: guillemets, curly quotes, parens.
# (Digitised tafsīrs rarely mix them, but a few use only one of these.)
_QuoteMark = re.compile(r"\*﴿(.+?)﴾\{\.quran-quote\}\*(?!\s*\(\[\[)")
_ExtraDelims = {
    "«»": re.compile(r"«([^«»]{1,400}?)»"),
    "“”": re.compile(r"“([^“”]{1,400}?)”"),
    "()": re.compile(r"\(([^()\[\]]{1,400}?)\)"),
}


def _quran_module():
    """Load transcription-quran.py lazily — it exposes the Qur'ān verse matcher."""
    global _QURAN_MODULE
    if _QURAN_MODULE is None:
        from importlib.machinery import SourceFileLoader
        mod = SourceFileLoader("transcription_quran", str(Path(__file__).with_name("transcription-quran.py"))).load_module()
        mod.QURAN_DIR = QURAN_DIR  # match the importer's canonical Qur'ān folder
        _QURAN_MODULE = mod
    return _QURAN_MODULE


def detect_quote_delims(text: str) -> tuple[str, ...]:
    """Which non-`﴿﴾` delimiters this text actually uses for Qur'ān quotes.

    A work follows one standard throughout, so a handful of resolved spans is
    enough to enable a delimiter for the whole work; a delimiter whose spans never
    resolve (guillemets around ḥadīth, parens around prose) is left off, so the
    matcher is not run over hundreds of non-Qur'ānic spans.
    """
    if _CANONICAL_RIWAYA != "hafs":
        return ()
    tfq = _quran_module()
    enabled: list[str] = []
    for name, rx in _ExtraDelims.items():
        spans = [s.strip() for s in rx.findall(text) if len(s.split()) >= 3]
        hits = 0
        for s in spans[:40]:
            try:
                if tfq.find_verse_in_text(s):
                    hits += 1
            except Exception:  # noqa: BLE001
                pass
            if hits >= 3:
                enabled.append(name)
                break
    return tuple(enabled)


def link_quote_citations(text: str, *, surah: int, ayah: int, delims: tuple[str, ...] = ()) -> str:
    """Cite every Qur'ān quote that resolves to a verse other than this one.

    Quotes come from the vault-marked `﴿…﴾` spans and, when the work uses them
    (`delims`), from guillemets / curly quotes / parentheses. Each is matched
    against the canonical notes with the transcription matcher, walking forward —
    the quotes of the commented verse come in order — and a quote of the commented
    verse itself is left uncited. One- or two-word quotes are never cited: nobody
    quotes a word or two from a *different* verse, and matching them (﴿الم﴾,
    ﴿ذَلِك﴾ …) would only produce false positives.
    """
    if not text or _CANONICAL_RIWAYA != "hafs":
        return text
    if "﴿" not in text and not any(d in text for d in ("«", "“", "(")):
        return text
    tfq = _quran_module()
    state = {"s": surah, "v": ayah}

    def cite(quote: str) -> str:
        """The citation for a quote, or '' when it needs none."""
        # A quote may span verses (`﴿A * B﴾`, the editor's separator). Cite the
        # first segment that resolves; a multi-verse span never matches on its own.
        segments = [s.strip() for s in quote.split("*") if s.strip()]
        res = None
        for seg in segments:
            if len(seg.split()) <= 2:
                continue
            try:
                res = tfq.find_verse_in_text(seg, hint_surah=state["s"], hint_verse=state["v"])
            except Exception:  # noqa: BLE001
                res = None
            if res:
                break
        if not res:
            return ""
        s, v = res[0][0], res[0][1]
        state["s"], state["v"] = s, v
        if (s, v) == (surah, ayah):
            return ""
        row = _surah_rows()[s - 1]
        numeral = str(v).translate(_WESTERN_TO_ARABIC)
        return f" ([[{row['base']}#{v}|{row['arabic']} : {numeral}]])"

    text = _QuoteMark.sub(lambda m: m.group(0) + cite(m.group(1).strip()), text)
    for name in delims:
        text = _ExtraDelims[name].sub(lambda m: m.group(0) + cite(m.group(1).strip()), text)
    return text


def canonical_aliases(work: dict) -> list[str]:
    """Parent aliases: full + short romanized, their Arabic forms, and a plain form."""
    out: list[str] = []

    def add(value: str | None) -> None:
        value = (value or "").strip()
        if value and value not in out:
            out.append(value)

    add(work.get("title"))
    add(work.get("short"))
    add(work.get("title_ar"))
    add(work.get("short_ar"))
    add(strip_diacritics(work.get("title", "")))
    return out


def repository_name(url: str) -> str:
    """A short, human name for a source URL (used in the `repository:` property)."""
    if not url:
        return ""
    m = re.match(r"https?://([^/]+)(/.*)?$", url)
    if not m:
        return url
    host = m.group(1).replace("www.", "")
    path = (m.group(2) or "").strip("/")
    if host == "github.com" and path:
        return "github.com/" + "/".join(path.split("/")[:2])
    return host


def _github_last_commit(owner: str, repo: str, path: str | None = None) -> str:
    """YYYY-MM-DD of the last commit touching `path` (or the repo). Best effort."""
    url = f"https://api.github.com/repos/{owner}/{repo}/commits?per_page=1"
    if path:
        url += f"&path={path}"
    try:
        data = fetch_json(url, cache=False)
        if isinstance(data, list) and data:
            return (data[0].get("commit", {}).get("committer", {}).get("date", "") or "")[:10]
    except Exception:  # noqa: BLE001
        pass
    return ""


# Last-update source per collection that is not backed by a dated catalogue.
_REPO_COMMITS = {
    "tafsir": lambda w: _github_last_commit("spa5k", "tafsir_api", f"tafsir/{w['id']}"),
    "quran": lambda w: _github_last_commit("fawazahmed0", "quran-api", f"editions/{w['id']}.json"),
    "hadith": lambda w: _github_last_commit("AhmedBaset", "hadith-json", f"db/by_book/{w.get('group', '')}/{w['id']}.json"),
    "dictionary": lambda w: _github_last_commit(*_github_slug(w), w.get("db_path") or "assets/hanswehr.sqlite")
    if _github_slug(w) else "",
}


def repo_updated(work: dict) -> str:
    """Best-effort date (YYYY-MM-DD) of the source repository's last update for a work."""
    coll = work.get("collection")
    if coll == "tafsir-qul":
        ts = work.get("qul_updated") or 0
        try:
            return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d") if ts else ""
        except (ValueError, OverflowError, OSError):
            return ""
    if coll == "quran-text":
        try:
            man = fetch_json("https://quran-json.risanb.com/manifest.json", cache=True)
            for s in man.get("scripts", []):
                if s.get("id") == work.get("source_id"):
                    version = (s.get("license") or {}).get("version")
                    if version:
                        return version
            version = ((man.get("license") or {}).get("text") or {}).get("version")
            if version:
                return version
        except Exception:  # noqa: BLE001
            pass
        return _github_last_commit("risan", "quran-json")
    fn = _REPO_COMMITS.get(coll)
    return fn(work) if fn else ""


# The repository path holding each work's actual text.
_REPO_PATHS = {
    "tafsir": lambda w: f"tafsir/{w['id']}",
    "quran": lambda w: f"editions/{w['id']}.json",
    "hadith": lambda w: f"db/by_book/{w.get('group', '')}/{w['id']}.json",
    "dictionary": lambda w: w.get("db_path") or "assets/hanswehr.sqlite",
}
_REPO_SLUGS = {
    "tafsir": ("spa5k", "tafsir_api"),
    "tafsir-qul": ("TarteelAI", "quranic-universal-library"),
    "quran": ("fawazahmed0", "quran-api"),
    "hadith": ("AhmedBaset", "hadith-json"),
    "quran-text": ("risan", "quran-json"),
    "dictionary": ("GibreelAbdullah", "HansWehrDictionary"),
}


def _github_slug(work: dict) -> tuple[str, str] | None:
    """The (owner, repo) a work's text comes from.

    Dictionaries are per-work: the collection holds two of them, from different
    repositories, so the slug is parsed from the work's own `source` URL.
    """
    if work.get("collection") == "dictionary":
        m = re.match(r"https?://github\.com/([^/]+)/([^/?#]+)", str(work.get("source") or ""))
        return (m.group(1), m.group(2)) if m else None
    return _REPO_SLUGS.get(work.get("collection"))


def repo_url(work: dict) -> str:
    """The repository the work's text is drawn from (for the `repository:` property)."""
    slug = _github_slug(work)
    return f"https://github.com/{slug[0]}/{slug[1]}" if slug else ""


def repo_license_attribution(work: dict) -> str:
    """Attribution the source licence requires (currently the riwāyāt, from Tanzil)."""
    if work.get("collection") != "quran-text":
        return ""
    try:
        man = fetch_json("https://quran-json.risanb.com/manifest.json", cache=True)
        for s in man.get("scripts", []):
            if s.get("id") == work.get("source_id"):
                return str((s.get("license") or {}).get("attribution") or "").strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _github_content_hash(owner: str, repo: str, path: str) -> str:
    """A short hash of a path's blob SHAs (a file's, or a directory's file set)."""
    try:
        data = fetch_json(f"https://api.github.com/repos/{owner}/{repo}/contents/{path}", cache=False)
    except Exception:  # noqa: BLE001
        return ""
    if isinstance(data, list):
        shas = sorted(f"{x.get('name')}:{x.get('sha')}" for x in data if x.get("sha"))
        return hashlib.sha1("\n".join(shas).encode("utf-8")).hexdigest()[:12]
    if isinstance(data, dict) and data.get("sha"):
        return str(data["sha"])[:12]
    return ""


def repo_hash(work: dict) -> str:
    """A hash of the work's actual text in the repository.

    Changes when the text changes, regardless of unrelated commits. For the
    dated risan catalogue the per-script version is already text-specific.
    """
    coll = work.get("collection")
    if coll == "tafsir-qul":
        # The catalogue's per-resource `updated_at` is the best text-change signal.
        return str(work.get("qul_updated") or "")
    if coll == "quran-text":
        return repo_updated(work)
    path_fn = _REPO_PATHS.get(coll)
    slug = _github_slug(work)
    if not path_fn or not slug:
        return ""
    return _github_content_hash(slug[0], slug[1], path_fn(work))


def smart_quotes(text: str) -> str:
    """Curly quotes whose direction is decided by position, not by a running toggle.

    Two hazards in these corpora: some sources ship already-reversed quotes, and a
    single unmatched straight quote flips a toggle for the rest of the note. Both
    are handled by deciding from the neighbouring character; already-curly quotes
    are normalised the same way. A grave accent stands for ʿayn in some sources
    (e.g. the translated ḥadīth) and is unsafe in Obsidian, so it becomes ‘ — a
    quote mark, not the ʿayn character used for full transliteration.
    """
    text = text.replace("`", "‘")
    # Mark openings: at the start, or after space / an opening bracket / a dash.
    text = re.sub(r'(?:^|(?<=[\s(\[{<\-–—]))["“”]', "\x01", text)
    text = re.sub(r"(?:^|(?<=[\s(\[{<\-–—]))['‘’]", "\x02", text)
    # Everything else — straight or curly — closes.
    text = (text.replace('"', "”").replace("“", "”")
                .replace("'", "’").replace("‘", "’"))
    return text.replace("\x01", "“").replace("\x02", "‘")


# ── Fetching ─────────────────────────────────────────────────────────────────

def _url_candidates(url: str):
    """Yield the URL and any mirror that serves the same file.

    jsDelivr occasionally rejects individual files with HTTP 403; the backing
    raw.githubusercontent.com copy almost always still works.
    """
    yield url
    m = re.match(r"https://cdn\.jsdelivr\.net/gh/([^/]+)/([^/]+)@([^/]+)/(.*)$", url)
    if m:
        yield f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}/{m.group(4)}"


def fetch(url: str, *, cache: bool = False, retries: int = 3) -> bytes:
    """Fetch a URL, optionally caching to disk, with mirror fallback + retries."""
    if cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        key = re.sub(r"[^\w.-]+", "_", url)[-180:]
        cached = CACHE_DIR / key
        if cached.exists():
            return cached.read_bytes()
    last_err: Exception | None = None
    for attempt in range(retries):
        for candidate in _url_candidates(url):
            try:
                req = urllib.request.Request(candidate, headers={"User-Agent": "obsidian-text-source-import/1.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read()
                if cache:
                    cached.write_bytes(data)
                return data
            except Exception as exc:  # noqa: BLE001 - try mirror, then retry
                last_err = exc
        # A 404 is definitive; anything else (403/429/network) is worth retrying.
        if isinstance(last_err, urllib.error.HTTPError) and last_err.code == 404:
            break
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Could not fetch {url}: {last_err}")



def fetch_json(url: str, *, cache: bool = False):
    return json.loads(fetch(url, cache=cache).decode("utf-8"))


def _cache_files() -> list[tuple[str, int]]:
    """Every cached source file as (name, bytes) — read once per `list`."""
    out: list[tuple[str, int]] = []
    if CACHE_DIR.is_dir():
        for f in CACHE_DIR.iterdir():
            if f.is_file():
                try:
                    out.append((f.name, f.stat().st_size))
                except OSError:
                    pass
    return out


def cached_bytes(work: dict, files: list[tuple[str, int]]) -> int:
    """How many bytes of this work's source are already downloaded (0 if none).

    Cache names are the sanitised URL, so the work's id appears as a token
    between underscores (or before `.json` for a single-file work).
    """
    needle = re.compile(rf"_{re.escape(str(work.get('source_id') or work['id']))}(?:_|\.(?:json|sqlite)$)")
    return sum(size for name, size in files if needle.search(name))


# ── Catalogues ───────────────────────────────────────────────────────────────

def load_catalog(collection: str, *, use_cache: bool = True) -> list[dict]:
    """Return a normalized list of works for a collection."""
    spec = COLLECTIONS[collection]
    works: list[dict] = []
    if spec["kind"] == "hadith":
        for b in HADITH_BOOKS:
            works.append({
                "collection": collection,
                "id": b["id"],
                "group": b["group"],
                "name": b["title"],
                "arabic": b["arabic"],
                "author": b.get("author", ""),
                "language": "ar",
                "language_name": "arabic",
                "source": "https://github.com/AhmedBaset/hadith-json",
            })
    elif spec["kind"] == "quran-text":
        for b in QURAN_TEXTS:
            works.append({
                "collection": collection,
                "id": b["id"],
                "source_id": b.get("source_id", b["id"]),
                "name": b["title"],
                "riwaya_ar": b.get("riwaya_ar", ""),
                "author": "",
                "language": "ar",
                "language_name": "arabic",
                "source": "https://quran-json.risanb.com",
            })
    elif spec["kind"] == "dictionary":
        for b in DICTIONARIES:
            works.append({
                "collection": collection,
                "id": b["id"],
                "name": b["title"],
                "arabic": b.get("arabic", ""),
                "author": b.get("author", ""),
                "source": b["source"],
                "db_url": b["db"],
                "db_path": b.get("db_path", ""),
                # `grid` = Wehr's label/content senses; `prose` = Lane's paragraphs.
                "body": b.get("body", "grid"),
                "note_prefix": b.get("note_prefix", "HW"),
                # The id at which this work's source stops being one book and
                # starts being its Supplement (0 = no such split).
                "supplement_from": int(b.get("supplement_from", 0)),
                # Which named romanization path its names follow.
                "convention": b.get("convention", DEFAULT_ROMANIZATION),
                "language": "ar",
                "language_name": "arabic",
            })
    else:
        raw = fetch_json(spec["catalog"], cache=use_cache)
        if spec["kind"] == "tafsir":
            for item in raw:
                code = normalise_language(item.get("language_name"))
                if not code:
                    continue
                works.append({
                    "collection": collection,
                    "id": item["slug"],
                    "name": item.get("name", item["slug"]),
                    "author": item.get("author_name", ""),
                    "language": code,
                    "language_name": item.get("language_name", ""),
                    "source": item.get("source", ""),
                })
        elif spec["kind"] == "qul-tafsir":
            # QUL's catalogue is `{"tafsirs": [{id, name, language_name,
            # author_name, records_count, updated_at, slug}]}`; skip the empty
            # stubs some resources carry.
            for item in (raw.get("tafsirs", []) if isinstance(raw, dict) else []):
                if int(item.get("records_count") or 0) <= 0:
                    continue
                code = normalise_language(item.get("language_name"))
                if not code:
                    continue
                rid = item.get("id")
                records = int(item.get("records_count") or 0)
                works.append({
                    "collection": collection,
                    "id": str(rid),
                    "name": item.get("name", str(rid)),
                    "author": item.get("author_name") or "",
                    "language": code,
                    "language_name": item.get("language_name", ""),
                    "source": f"https://qul.tarteel.ai/resources/tafsir/{rid}",
                    "qul_updated": item.get("updated_at") or 0,
                    # A rough footprint (source + model + notes) for a work not yet
                    # downloaded, so the modal can show an "≈" estimate.
                    "est_bytes": records * 2200,
                })
        elif spec["kind"] == "translation":
            for _key, item in raw.items():
                code = normalise_language(item.get("language"))
                if not code:
                    continue
                ident = item.get("name") or _key
                works.append({
                    "collection": collection,
                    "id": ident,
                    "name": item.get("name", ident),
                    "author": item.get("author", ""),
                    "language": code,
                    "language_name": item.get("language", ""),
                    "source": item.get("source") or "https://github.com/fawazahmed0/quran-api",
                })
        else:  # pragma: no cover - guarded by the registry
            raise ValueError(f"Unknown catalog kind {spec['kind']!r}")
    for w in works:
        w["key"] = f"{collection}:{w['id']}"
        w["type"] = collection
        w["collection_label"] = spec["label"]
        w["genre"] = spec.get("genre", collection)
        # A collection normally has one repository, but the dictionary collection
        # holds two dictionaries from different ones, so each work names its own.
        if collection == "dictionary":
            w["repository"] = repository_name(w.get("source", "")).removeprefix("github.com/")
        else:
            w["repository"] = spec.get("repo_label", "")
        w["needs_transliteration"] = bool(spec.get("needs_transliteration"))
    return works


def load_overrides() -> dict[str, dict]:
    overrides = json.loads(json.dumps(BUILTIN_OVERRIDES))
    if OVERRIDES_FILE.exists():
        try:
            external = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
            for k, v in external.items():
                overrides.setdefault(k, {}).update(v)
        except Exception as exc:  # noqa: BLE001
            emit("error", message=f"Could not read {OVERRIDES_FILE.name}: {exc}")
    return overrides


def edition_variant(work_id: str) -> str:
    """A short qualifier for script variants of a translation edition.

    The quran-api catalogue gives a romanised edition a `-la` suffix and its
    vocalised form a `-lad` suffix; the base, `-la` and `-lad` editions share
    their author and title, so without this they collapse onto one folder.
    """
    if work_id.endswith("-lad"):
        return "Latin diacritics"
    if work_id.endswith("-la"):
        return "Latin"
    return ""


def apply_overrides(work: dict, overrides: dict[str, dict]) -> dict:
    merged = dict(work)
    merged["title_ar"] = ""
    merged["short_ar"] = ""
    if work["collection"] == "quran":
        # Qur'ān translation editions are identified by their translator; a
        # romanised edition carries a -la/-lad suffix, which must qualify the
        # title or the editions collapse onto one folder.
        label = work.get("author") or work["name"]
        variant = edition_variant(work["id"])
        title = f"Qurʾān - {label}" + (f" ({variant})" if variant else "")
        merged["title"] = title
        merged["dir"] = slug_to_dir(title)
        merged["title_ar"] = "القرآن الكريم"
    elif work["collection"] == "hadith":
        merged["title"] = work["name"]
        merged["dir"] = slug_to_dir(work["name"])
        merged["title_ar"] = work.get("arabic", "")
    elif work["collection"] == "quran-text":
        merged["title"] = work["name"]
        merged["dir"] = slug_to_dir(work["name"])
        # Qualify the Arabic alias with its riwāya, so a bare "القرآن الكريم"
        # never points ambiguously at one riwāya among several.
        riwaya_ar = work.get("riwaya_ar", "")
        merged["title_ar"] = f"القرآن الكريم - {riwaya_ar}" if riwaya_ar else "القرآن الكريم"
    elif work["collection"] == "dictionary":
        merged["title"] = work["name"]
        merged["dir"] = slug_to_dir(work["name"])
        merged["title_ar"] = work.get("arabic", "")
    else:
        merged["title"] = work["name"]
        merged["dir"] = slug_to_dir(work["name"])
    merged["authors"] = []
    merged["translators"] = []
    if work["collection"] == "hadith":
        if work.get("author"):
            merged["authors"] = [work["author"]]
    elif work["collection"] == "dictionary":
        if work.get("author"):
            merged["authors"] = [work["author"]]
    elif work["collection"] == "quran":
        if work.get("author"):
            merged["translators"] = [work["author"]]
    spec = COLLECTIONS[work["collection"]]
    merged["up"] = [f"[[{spec['moc']}]]"]
    merged["cssclass"] = spec["cssclass"]
    merged["moc"] = spec["moc"]
    # Languages the work actually contains (ḥadīth are bilingual).
    merged["languages"] = ["ar", "en"] if work["collection"] == "hadith" else [work["language"]]
    o = overrides.get(work["key"])
    if o:
        merged.update({k: v for k, v in o.items() if v is not None})
    merged["dir"] = slug_to_dir(merged["dir"])
    merged["language_label"] = language_name(merged["language"])
    merged["language_links"] = [language_name(l) for l in merged["languages"]]
    merged["moc_sections"] = [moc_section(l) for l in merged["languages"]]
    merged["aliases"] = canonical_aliases(merged)
    return merged


def _installed_work_dirs() -> dict[str, str]:
    """key → folder for every work already recorded in the manifest (installed)."""
    try:
        data = json.loads((VAULT / ".midad-arabic-sources" / "source-imports.json").read_text(encoding="utf-8"))
        return {
            str(w["key"]): str(w["dir"])
            for w in data.get("works", [])
            if w.get("key") and w.get("dir")
        }
    except Exception:  # noqa: BLE001
        return {}


def with_unique_dirs(works: list[dict]) -> None:
    """Give every work a stable, unique output folder (mutates in place).

    The folder comes from the title, but two editions can share a title — one
    translator into several languages, or the romanised `-la`/`-lad` variants of
    one edition. Qualify the later ones with their language, then their id.

    The result depends only on the catalogue order, never on which works are
    being fetched, so `list`, `fetch` and `check-updates` always agree on a
    work's folder. (A request-scoped rule breaks: a reinstall then lands in a
    folder the plugin is not checking, and repeats forever.)

    A work already in the manifest keeps **the folder it has** — renaming an
    installed work orphans its notes and leaves a stale folder behind — and that
    folder is reserved, so a colliding newcomer is qualified instead.
    """
    installed = _installed_work_dirs()
    seen: set[str] = set(installed.values())
    for w in works:
        key = str(w.get("key"))
        if key in installed:
            w["dir"] = installed[key]
            continue
        base = w["dir"]
        if base not in seen:
            seen.add(base)
            continue
        qualifiers = [
            w.get("language_label") or w.get("language"),
            edition_variant(w["id"]),
            w["id"],
        ]
        unique = base
        for label in qualifiers:
            if not label:
                continue
            candidate = slug_to_dir(f"{base} ({label})")
            if candidate not in seen:
                unique = candidate
                break
        else:
            n = 2
            while unique in seen:
                unique = slug_to_dir(f"{base} ({n})")
                n += 1
        w["dir"] = unique
        seen.add(unique)


def all_works(overrides: dict[str, dict]) -> dict[str, dict]:
    """Every catalogue work, merged and given a stable unique folder, by key."""
    works: list[dict] = []
    for coll in COLLECTIONS:
        for w in load_catalog(coll, use_cache=True):
            works.append(apply_overrides(w, overrides))
    with_unique_dirs(works)
    return {w["key"]: w for w in works}


# ── Sūrah table ──────────────────────────────────────────────────────────────

def surah_table() -> list[dict]:
    """Return [{number, base, translit, arabic}] for the 114 sūrahs.

    Prefers the vault's _7 Sources/Quran folder so links match real note names;
    falls back to the built-in table.
    """
    table: list[dict] = []
    for i, (translit, arabic) in enumerate(SURAH_NAMES, start=1):
        table.append({"number": i, "base": f"{i:03d} {translit}", "translit": translit, "arabic": arabic})
    if QURAN_DIR.is_dir():
        for f in sorted(QURAN_DIR.glob("*.md")):
            m = re.match(r"^(\d{1,3})\s+(.+)$", f.stem)
            if not m:
                continue
            num = int(m.group(1))
            if not 1 <= num <= 114:
                continue
            arabic = _arabic_alias_from_note(f) or table[num - 1]["arabic"]
            table[num - 1] = {"number": num, "base": f.stem, "translit": m.group(2), "arabic": arabic}
    return table


def _arabic_alias_from_note(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None
    in_aliases = False
    for line in m.group(1).splitlines():
        if re.match(r"^aliases:\s*$", line):
            in_aliases = True
            continue
        if in_aliases:
            item = re.match(r"^\s*-\s*(.+?)\s*$", line)
            if not item:
                if line and not line.startswith((" ", "\t")):
                    break
                continue
            value = item.group(1).strip().strip('"\'')
            if value and re.fullmatch(r"[\u0600-\u06FF\s]+", value):
                return value
    return None


# ── Text cleaning ────────────────────────────────────────────────────────────

_LIST_MARK = re.compile(r"\s-?(\d{1,2})\.\s")


def number_list_items(text: str) -> str:
    """Rebuild an inline numbered list the source hard-wrapped.

    The sources wrap prose at ~100 characters, but start each list item with
    `-N.` (e.g. the "five things given to no one before me" ḥadīth). Once the
    wraps are folded away the markers read as ` -1. … -2. …`; if at least two
    are present, separate them into a real ordered list (and put the run-in
    intro on its own paragraph, as Markdown requires).
    """
    marks = list(_LIST_MARK.finditer(text))
    if len(marks) < 2:
        return text
    intro = text[: marks[0].start()].strip()
    items: list[str] = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        chunk = text[m.end():end].strip()
        if chunk:
            items.append(chunk)
    body = "\n".join(f"{n}. {t}" for n, t in enumerate(items, 1))
    return f"{intro}\n\n{body}" if intro else body


def clean_text(raw: str, *, english: bool) -> str:
    """HTML-strip and normalise a commentary/translation string."""
    if not raw:
        return ""
    text = html.unescape(raw)
    # Turn block-level HTML into paragraph breaks, then drop any remaining tags.
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p\s*>", "\n\n", text)
    text = re.sub(r"(?i)<p[^>]*>", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    # The editor sometimes inserts apparatus *inside* a verse quote
    # (`﴿… \[…\] …﴾`), which would otherwise become part of the verse text. Pull
    # it out so the quote stays the canonical verse, and re-emit it after the quote
    # (the `[[…]]` → <sup> step below then handles it).
    def _pull_apparatus(m: re.Match) -> str:
        inner = m.group(1)
        apparatus: list[str] = []
        inner = re.sub(r"\[\[(.+?)\]\]", lambda mm: (apparatus.append(f"[[{mm.group(1)}]]"), "")[1], inner)
        inner = re.sub(r"\[(.+?)\]", lambda mm: (apparatus.append(f"[{mm.group(1)}]"), "")[1], inner)
        quote = f"﴿{inner.strip()}﴾"
        return quote + (" " + " ".join(apparatus) if apparatus else "")

    text = re.sub(r"﴿(.+?)﴾", _pull_apparatus, text, flags=re.DOTALL)
    # Mark Qur'ān spans with the vault's quran-quote classes.
    text = re.sub(r"﴿(.+?)﴾", lambda m: f"*﴿{m.group(1)}﴾{{.quran-quote}}*", text, flags=re.DOTALL)
    # Collapse each paragraph onto one line, keep one blank line between them.
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", text)]
    paragraphs = [p for p in paragraphs if p]
    body = "\n\n".join(paragraphs)
    # The vault always uses curly quotes, in Arabic and English alike.
    body = smart_quotes(body)
    # Then rebuild any hard-wrapped inline numbered list ("… me. -1. … -2. …").
    body = number_list_items(body)
    # The source's editorial apparatus — manuscript variants (`زيادة من د.`,
    # `في هـ: "…"`) and bibliographic refs (`صحيح`, `رواه`, `انظر:`) — is marked
    # `[[…]]`, which Obsidian would read as a wikilink. Render it as a muted
    # superscript aside instead. A bare <sup> is used deliberately: a tooltip
    # (<span title=…>) made notes with ~1000 of these hang Obsidian's renderer.
    # Done AFTER smart_quotes (which would otherwise curl attribute quotes);
    # links we add ourselves come later and are not touched.
    body = re.sub(
        r"\[\[(.+?)\]\]",
        lambda m: f'<sup class="mas-src-note">({html.escape(m.group(1))})</sup>',
        body,
    )
    # Added words in single brackets (`[قَوْلُهُ]`, `[وَاصْبِرْ]`) become round
    # brackets: square brackets are avoided entirely, because Obsidian's renderer
    # mishandles them — they read as links, and they break a preceding
    # `{.quran-quote}`. Our own `[[…]]` links are added later, after this runs.
    body = re.sub(r"\[(.+?)\]", lambda m: f"({m.group(1)})", body)
    # A stray, unpaired bracket is rare but does occur; nothing in the vault text
    # should carry a square bracket, so fold any that remain into round brackets.
    body = body.replace("[", "(").replace("]", ")")
    return body


def parse_work_file(data, shape: str) -> list[tuple[int, str]]:
    """Return [(ayah_number, raw_text)] from a downloaded work file."""
    records: list[dict] = []
    if shape == "chapter":
        records = data.get("chapter", []) if isinstance(data, dict) else data
    elif shape == "ayah-list":
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict):
            records = data.get("ayahs") or data.get("verses") or []
            if not records and all(str(k).isdigit() for k in data):
                records = [{"ayah": int(k), "text": v} for k, v in data.items()]
    out: list[tuple[int, str]] = []
    for rec in records:
        ayah = rec.get("ayah", rec.get("verse"))
        text = rec.get("text", "")
        if ayah is None:
            continue
        out.append((int(ayah), text))
    out.sort(key=lambda t: t[0])
    return out


# ── Render models (the contract consumed by the plugin's ETA templates) ──────
#
# A model is {"schema", "generated", "work", "units"}. The full field reference
# lives in the plugin docs. Acquisition never renders markdown.
#
# `MODEL_SCHEMA` is the version at which each collection's *acquisition* last
# changed — the plugin re-fetches a cached model older than its collection's
# entry, because a re-render only replays the model and cannot apply an
# acquisition change. Bump the affected entry whenever this file's output for a
# collection changes, and mirror it in the plugin's `COLLECTION_MODEL_SCHEMA`.
MODEL_SCHEMA: dict[str, int] = {"dictionary": 4}
BASE_MODEL_SCHEMA = 1


def display_title(base: str) -> str:
    """A unit's title as it should read, e.g. `2 Al-Baqarah`, not `002 Al-Baqarah`.

    A title is for viewing, so the numeric prefix loses its leading zeros. The
    *file name* keeps them (it is what makes sūra notes sort correctly), and the
    hub links to the file, so the two never drift.
    """
    return re.sub(r"^0+(\d)", r"\1", base)


def _ayah_blocks(surah: dict, records: list[tuple[int, str]], english: bool,
                 delims: tuple[str, ...] = ()) -> list[dict]:
    # The source repeats one section verbatim across a range of āyāt (2:26–27,
    # 2:31–33 … are the same text). Merge such runs *on the raw source text*, so
    # the heading reads `# 31–33` rather than repeating the section per verse.
    # (Dedupe on the raw text, not the processed body: processing depends on the
    # verse context — `skip`, matcher hints — so the outputs differ.)
    groups: list[dict] = []
    for ayah_no, raw in records:
        if groups and raw == groups[-1]["raw"]:
            groups[-1]["end"] = ayah_no
            continue
        groups.append({"start": ayah_no, "end": ayah_no, "raw": raw})

    out: list[dict] = []
    for g in groups:
        start, end = g["start"], g["end"]
        body = clean_text(g["raw"], english=english)
        # Link citations of *other* verses; the commented verse's own quotes stay.
        body = link_verse_citations(body, skip=(surah["number"], start))
        body = link_quote_citations(body, surah=surah["number"], ayah=start, delims=delims)
        if not body:
            continue
        if end == start:
            out.append({
                "number": start,
                "ref": f"[[{surah['base']}#{start}|{surah['arabic']} : {arabic_numeral(start)}]]",
                "body": body,
            })
        else:
            out.append({
                "number": f"{start}–{end}",
                "ref": (f"[[{surah['base']}#{start}|{surah['arabic']} : {arabic_numeral(start)}]]"
                        f"–[[{surah['base']}#{end}|{arabic_numeral(end)}]]"),
                "body": body,
            })
    return out


def build_surah_units(work: dict, table: list[dict], wanted: set[int] | None,
                      args: argparse.Namespace) -> list[dict]:
    """One unit per sūrah, each with āya blocks."""
    english = work["language"] == "en"
    units: list[dict] = []
    for surah in table:
        if wanted and surah["number"] not in wanted:
            continue
        url = COLLECTIONS[work["collection"]]["data"].format(id=work["id"], surah=surah["number"])
        try:
            data = fetch_json(url, cache=not args.no_cache)
        except Exception as exc:  # noqa: BLE001
            emit("log", message=f"  skipped {surah['base']}: {exc}")
            continue
        records = parse_work_file(data, COLLECTIONS[work["collection"]]["shape"])
        units.append({
            "kind": "surah",
            "id": surah["number"],
            "base": surah["base"],
            "title": display_title(surah["base"]),
            "translit": surah["translit"],
            "arabic": surah["arabic"],
            "blocks": _ayah_blocks(
                surah, records, english,
                detect_quote_delims("\n".join(t for _, t in records))),
        })
        if len(units) % 10 == 0:
            emit("step", name=work["title"], status="parsing", detail=f"{len(units)} sūrahs")
    return units


def build_qul_units(work: dict, table: list[dict], wanted: set[int] | None,
                    args: argparse.Namespace) -> list[dict]:
    """One unit per sūrah from the Qurʾānic Universal Library API.

    QUL serves a passage per sūrah range (`by_range`), each record naming the
    āyāt it covers; it expands a shared passage to every covered āya, so the
    usual consecutive-dedupe in `_ayah_blocks` folds it into a ranged block.
    """
    english = work["language"] == "en"
    template = COLLECTIONS["tafsir-qul"]["data"]
    units: list[dict] = []
    for surah in table:
        num = surah["number"]
        if wanted and num not in wanted:
            continue
        url = template.format(id=work["id"], surah=num, count=SURAH_AYAHS[num - 1])
        try:
            data = fetch_json(url, cache=not args.no_cache)
        except Exception as exc:  # noqa: BLE001
            emit("log", message=f"  skipped {surah['base']}: {exc}")
            continue
        records: list[tuple[int, str]] = []
        for rec in (data.get("tafsirs", []) if isinstance(data, dict) else []):
            keys = rec.get("verses") or []
            if isinstance(keys, str):
                keys = [keys]
            text = rec.get("text", "")
            for k in keys:
                try:
                    s, a = (int(x) for x in str(k).split(":", 1))
                except ValueError:
                    continue
                if s == num:
                    records.append((a, text))
        if not records:
            continue
        records.sort(key=lambda t: t[0])
        units.append({
            "kind": "surah",
            "id": num,
            "base": surah["base"],
            "title": display_title(surah["base"]),
            "translit": surah["translit"],
            "arabic": surah["arabic"],
            "blocks": _ayah_blocks(
                surah, records, english,
                detect_quote_delims("\n".join(t for _, t in records))),
        })
        if len(units) % 10 == 0:
            emit("step", name=work["title"], status="parsing", detail=f"{len(units)} sūrahs")
    return units


def parse_hadith_book(data: dict) -> list[dict]:
    """Group a whole-book ḥadīth file into chapters, each with its hadiths."""
    by_chapter: dict = {}
    for h in data.get("hadiths", []):
        by_chapter.setdefault(h.get("chapterId"), []).append(h)
    units = []
    for c in data.get("chapters", []):
        units.append({
            "id": c.get("id"),
            "arabic": c.get("arabic", ""),
            "english": c.get("english", ""),
            "hadiths": sorted(by_chapter.get(c.get("id"), []),
                              key=lambda h: h.get("idInBook", h.get("id", 0))),
        })
    return units


def hadith_chapter_label(chapter: dict) -> str:
    label = f'{chapter["id"]} {chapter.get("english") or chapter.get("arabic")}'.strip()
    # Chapter titles carry the same backtick-for-ʿayn and straight quotes as the
    # text (e.g. "26 `Umrah"), so normalise them too.
    return smart_quotes(label)


def build_hadith_units(work: dict, args: argparse.Namespace) -> list[dict]:
    """One unit per chapter (kitāb), each with its hadiths (Arabic + English)."""
    url = COLLECTIONS["hadith"]["data"].format(group=work["group"], id=work["id"])
    emit("step", name=work["title"], status="downloading", detail="whole book")
    data = fetch_json(url, cache=not args.no_cache)
    units: list[dict] = []
    for chapter in parse_hadith_book(data):
        label = hadith_chapter_label(chapter)
        hadiths = []
        for h in chapter["hadiths"]:
            en = h.get("english") or {}
            hadiths.append({
                "number": h.get("idInBook", h.get("id")),
                "narrator": clean_text(en.get("narrator", ""), english=True),
                "english": link_verse_citations(clean_text(en.get("text", ""), english=True)),
                "arabic": link_quote_citations(
                    link_verse_citations(clean_text(h.get("arabic", ""), english=False)),
                    surah=0, ayah=0),
            })
        units.append({
            "kind": "hadith",
            "id": chapter["id"],
            "base": slug_to_dir(label),
            "title": display_title(label),
            "label": label,
            "arabic": smart_quotes(chapter.get("arabic", "")),
            "english": smart_quotes(chapter.get("english", "")),
            "hadiths": hadiths,
        })
        if len(units) % 10 == 0:
            emit("step", name=work["title"], status="parsing", detail=f"{len(units)} chapters")
    return units


def build_quran_text_units(work: dict, table: list[dict], wanted: set[int] | None,
                           args: argparse.Namespace) -> list[dict]:
    """One unit per sūrah of a riwāya. Ḥafṣ generates the work note only."""
    units: list[dict] = []
    for surah in table:
        if wanted and surah["number"] not in wanted:
            continue
        url = COLLECTIONS["quran-text"]["data"].format(id=work["source_id"], surah=surah["number"])
        try:
            data = fetch_json(url, cache=not args.no_cache)
        except Exception as exc:  # noqa: BLE001
            emit("log", message=f"  skipped {surah['base']}: {exc}")
            continue
        blocks: list[dict] = []
        for v in data.get("verses", []):
            text = clean_text(v.get("text", ""), english=False)
            if text:
                blocks.append({
                    "number": v.get("id"),
                    "body": text,
                    "hafs": v.get("number_in_hafs", []),
                })
        units.append({
            "kind": "quran",
            "id": surah["number"],
            "base": surah["base"],
            "title": display_title(surah["base"]),
            "translit": surah["translit"],
            "arabic": surah["arabic"],
            "blocks": blocks,
        })
        if len(units) % 10 == 0:
            emit("step", name=work["title"], status="parsing", detail=f"{len(units)} sūrahs")
    return units


# ── Dictionaries (SQLite lexicons) ───────────────────────────────────────────
#
# The lexicons ship as SQLite, not JSON. A work is one row group: a root entry
# (`is_root`) plus the derived entries that point at it (`parent_id`); one note
# per root, which is how the vault already keeps Hans Wehr. The transformation
# reproduces that note format exactly — an H1 for the root, an H2 per derived
# entry, each followed by a `mas-dictionary-definition` callout rendered as an
# alternating label/content list (the two-column grid).
#
# Two subtleties, both learned the hard way:
#   * The definitions carry HTML tags (`<b>II</b>`); tags must be stripped
#     *before* the transliteration is scanned, or `<b>` supplies a stray "b"
#     that passes for the romanisation (e.g. ابن → "b").
#   * Many roots have no transliteration of their own: their definition *starts*
#     with a verb-form marker (`<b>II</b> …`). For those the transliteration is
#     taken from the first derived entry that is not itself a verb form, and only
#     if that fails is a character-by-character transliteration of the root used.

_HW_ARABIC = r"\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF"
_HW_HEAD_RE = re.compile(rf"^[{_HW_ARABIC}0-9]+(?:[\s,]+[{_HW_ARABIC}0-9]+)*")
_HW_ARABIC_RE = re.compile(rf"[{_HW_ARABIC}]")
# Words that open an etymology parenthetical rather than the transliteration:
# language abbreviations and grammatical pointers. Wehr writes loanwords as
# `جراج (Fr.) garāž` and `برغى (Turk. بورغى burğų) burgī`, where the
# transliteration follows the parenthetical.
_HW_PAREN_STOP = {
    "also", "and", "or", "pl", "sg", "du", "variant", "see", "of", "cf", "esp",
    "f", "m", "n", "invar", "vb", "adj", "adv", "coll", "prov", "eg",
    "engl", "fr", "it", "gr", "lat", "pers", "syr", "leb", "jord", "ir",
    "turk", "ger", "sp", "port", "npers", "aram", "hebr", "copt", "for",
}
# Wehr's transliteration alphabet. A character set, not a regex: ‘ ’ ` ' are
# mapped positionally to ʿ (ʿayn) and ʾ (hamza) as they are scanned.
_HW_VALID_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "āēīūōĀĒĪŪŌéèêäëïöüÄËÏÖÜçÇşŞčČšŠḥḤḳḲṣṢḍḌṭṬẓẒḏḎṯṮḫḪġĠžŽ-"
    "ʿʾɔʔ"
)
_HW_SKIP_RE = (
    re.compile(r"^look up alphabetically"),
    re.compile(r"^see\s+\w+"),
    re.compile(r"^\s*$"),
    re.compile(r"look up alphabetically"),
    re.compile(r"^[0-9]+$"),
)
_HW_RADICALS = {
    "ا": "ā", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "ḥ", "خ": "kh",
    "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "ṣ",
    "ض": "ḍ", "ط": "ṭ", "ظ": "ẓ", "ع": "ʿ", "غ": "gh", "ف": "f", "ق": "q",
    "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y",
    # A hamza-bearing alif is never a long ā: it is an initial ʾa/ʾu or an
    # internal ʾa/ʾu, or an unvowelled ʾ. Writing ā here (as this table once did)
    # turned نأت into `nāt`.
    "ء": "ʾ", "ة": "h", "ى": "ā", "ؤ": "ʾ", "ئ": "ʾ", "ـ": "",
    "آ": "ʾā", "أ": "ʾa", "إ": "ʾi", "ٱ": "a",
}
_HW_NUMBER_RE = re.compile(r"(?<!\d)(\d+)\.\s+")
_HW_ROMAN_RE = re.compile(r"(?:<b>)?([IVXLCDM]+)(?:</b>)?\s+")
# ── Romanization conventions ────────────────────────────────────────────────
#
# Named transliteration paths, so a work *declares* which one it follows instead
# of letters being swapped ad hoc. The engine (`arabic-bw-transliterate.py`)
# emits the vault's own convention, so every other path is a recast of that:
#
#   vault  the house convention — no case endings, but a verb's inflection, a
#          pronominal or prepositional ending and the two tanwīn exceptions are
#          kept (`baḥr`, `kataba`, `minka`, `qāḍin`, `ṭabʿan`). Lane uses this.
#   wehr   Hans Wehr's own — the European Orientalist system of the printed
#          dictionary (`š`, `ṯ`, `ḵ`, `ḏ`, `ġ`, `ḳ`, `č`, `ž`). Wehr uses it, so
#          a name the engine produced still matches the transliterations the
#          note's own text carries.
#   full   fully vocalised, every case ending written. That is the service's
#          `keep_case` mode — it changes how a reading is *produced*, not how its
#          letters are written — and is what the vault uses for Qur'ān passages.
#
ROMANIZATION_CONVENTIONS = ("vault", "wehr", "full")
DEFAULT_ROMANIZATION = "vault"

_WEHR_LETTERS: tuple[tuple[str, str], ...] = (
    ("sh", "š"), ("th", "ṯ"), ("kh", "ḵ"), ("dh", "ḏ"), ("gh", "ġ"),
    ("ch", "č"), ("zh", "ž"), ("q", "ḳ"),
)


def _hw_romanize(reading: str, convention: str = DEFAULT_ROMANIZATION) -> str:
    """Recast a reading in the vault's convention as `convention` (idempotent).

    `full` needs no recasting: it is a mode of *producing* a reading, not of
    writing its letters.
    """
    if convention == "wehr":
        for plain, wehr in _WEHR_LETTERS:
            reading = reading.replace(plain, wehr)
    return reading
# A prose work's headword is a bare run of Arabic — no transliteration follows it,
# and Lane puts the verb-form numeral *after* a space (`حَرَبَهُ 1 ,`), so unlike
# `_HW_HEAD_RE` this one must stop at the digit.
_HW_PROSE_HEAD_RE = re.compile(rf"^[{_HW_ARABIC}]+(?:[\s,]+[{_HW_ARABIC}]+)*")
# Every Arabic run in a definition (used to hunt for a word that carries a root's
# radicals); the runs are then split on whitespace.
_HW_ARABIC_WORD_RE = re.compile(rf"[{_HW_ARABIC}]+")
# Lane writes an aorist vowel as a presentation-form mark standing alone after
# "aor." (`aor. ﹹ`). The isolated mark renders as a floating dot, so write the
# vowel itself.
_HW_MEDIAL_VOWELS = {"\ufe77": "a", "\ufe7b": "i", "\ufe79": "u"}
# The callout a Lane verse becomes — the same shape the transcription pipeline
# emits. It must survive the square-bracket rule, so it is written from one
# constant (see `_hw_prose`).
_HW_POETRY_CALLOUT = ">[!arabic-poetry]"
_HW_VOWELS = "aeiouāēīōū"
# The hamza in any of its seats. A bare alef counts: a root cannot begin with a
# long vowel, so an alef in a root is a hamza seat (`اثف` is `athf`, `ثأف` is
# `thʾf`) — never a madd.
_HW_HAMZA = "ءأإآؤئٱا"
# The vowel marks and other combining signs. Their presence means a word is
# *vocalised* — a real written form, not a bare root cluster.
_HW_HARAKAT = (
    "\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652\u0653\u0654\u0655"
    "\u0670\u06d6\u06d7\u06d8\u06d9\u06da\u06db\u06dc\u06df\u06e0\u06e1\u06e2"
    "\u06e3\u06e4\u06e7\u06e8\u06ea\u06eb\u06ec\u06ed"
)
# The short vowels that can end a fully vocalised word, and the Latin to restore.
# No tanwīn on a name (`baḥr`, not `baḥrun`), but `-an` is kept, as the guidelines
# require — so dammatan and kasratan are absent here on purpose.
_HW_FINAL_VOWELS = {
    "\u064e": "a", "\u064f": "u", "\u0650": "i",
    "\u064b": "an",
}


def _hw_should_skip(text: str, *, pointers: bool = False) -> bool:
    if not text:
        return True
    t = text.strip().lower()
    if any(p.search(t) for p in _HW_SKIP_RE):
        return True
    if not pointers:
        return False
    # A pointer row: the headword followed by nothing but a cross-reference
    # (`حكيمباشي see`). The patterns above catch the bare `see …` form, which is
    # what a Wehr row carries when the scan lost its Arabic. Lane's cross-references
    # are the entry itself (`إِحْتَرَبَ 8 see 6.`, `هَبَرَ 1, &c.: see Supplement.`),
    # so this applies to the grid work only — and the headword is stripped without
    # its digits, so a form-numbered pointer is never caught even there.
    rest = _HW_PROSE_HEAD_RE.sub("", t, count=1).strip().strip(".")
    return bool(rest) and re.fullmatch(r"see(\s+\S+)?", rest) is not None


def _hw_strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "")


def _hw_headword(text: str) -> str | None:
    m = _HW_HEAD_RE.search(text.strip())
    return m.group(0).strip() if m else None


def _hw_is_verb_form(text: str) -> bool:
    """True when a definition starts with a verb-form marker (`<b>II</b> …`)."""
    if not text:
        return False
    cleaned = _hw_strip_tags(text)
    m = _HW_HEAD_RE.search(cleaned)
    if not m:
        return False
    return bool(re.match(r"^[IVXLCDM]+\s", cleaned[m.end():].lstrip()))


def _hw_extract_romanization(text: str) -> str | None:
    """The transliteration after the headword (one word per Arabic headword word).

    A leading parenthetical is usually an etymology note that *precedes* the
    transliteration — `(اوب)`, `(also اورطة)`, `(Fr.)`, `(pl. of الى ilan)`. But
    for noun roots Wehr puts the transliteration *inside* it:
    `حرب (ḥarb f., pl. حروب ḥurūb …)`. Keep the parenthetical only when it
    contains Arabic *and* opens with the transliteration itself; otherwise skip
    it. (Skipping unconditionally cost the noun roots their real name — `حرب`
    came out as `ahlīya`, the first gloss word inside the definition.)
    """
    if not text:
        return None
    cleaned = unicodedata.normalize("NFC", _hw_strip_tags(text).strip())
    m = _HW_HEAD_RE.search(cleaned)
    if not m:
        return None
    count = len(re.sub(r",", " ", m.group(0)).split())
    rest = cleaned[m.end():].lstrip()
    if rest.startswith("("):
        close = rest.find(")")
        paren = rest[1:close] if close != -1 else rest[1:]
        lm = re.match(r"[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]+", paren)
        first = lm.group(0).lower() if lm else ""
        # The transliteration must stand alone: in "(ḥarb …)" it is followed by a
        # space, whereas OCR rubble like "(ḥiعلى)" glues it to an Arabic word.
        well_formed = bool(lm) and (
            lm.end() >= len(paren) or not _HW_ARABIC_RE.match(paren[lm.end():])
        )
        if not (well_formed and _HW_ARABIC_RE.search(paren) and first not in _HW_PAREN_STOP):
            rest = re.sub(r"^\([^)]+\)\s*", "", rest)
    after = rest
    words: list[str] = []
    current: list[str] = []
    for ch in after:
        if ch in _HW_VALID_CHARS:
            current.append(ch)
        elif ch == "\u2018":  # ‘ left curly quote = ʿayn
            current.append("ʿ")
        elif ch == "\u2019":  # ’ right curly quote = hamza
            current.append("ʾ")
        elif ch == "`":
            current.append("ʿ")
        elif ch == "'":
            current.append("ʾ")
        elif ch.isspace() and current:
            words.append("".join(current))
            current = []
            if len(words) >= count:
                break
        elif current and not ch.isspace() and ch not in _HW_VALID_CHARS:
            words.append("".join(current))
            current = []
            if len(words) >= count:
                break
    if current and len(words) < count:
        words.append("".join(current))
    if not words:
        return None
    roman = " ".join(words[:count])
    # A bare verb-form numeral is not a name ("V"), and neither is nothing at all.
    if re.fullmatch(r"[IVXLCDM]+", roman):
        return None
    return roman


def _hw_radical_romanization(word: str) -> str:
    """Letter-by-letter, the last resort when no reading can be found at all.

    A hamza is never a long ā in any position, and it is a hamza seat rather than a
    consonant: an *initial* one is read as the vowel it carries — `اثف` → `athf`,
    and the bare root `ا` → `a` — while anywhere else it is `ʾ` (`ثأف` → `thʾf`).
    (A letter page's own label is a different matter and still reads `ا ā`.)
    """
    out: list[str] = []
    for i, ch in enumerate(word):
        if ch in _HW_HAMZA:
            out.append("a" if i == 0 else "ʾ")
        else:
            out.append(_HW_RADICALS.get(ch, ch))
    return "".join(out)


# ── The plugin's transliteration engine, for entries with no transliteration ──
#
# A letter-for-letter radical is the last resort; before that we ask the plugin's
# own romanizer (`arabic-bw-transliterate.py`, the same engine behind the
# "transliterate" commands). It is occasionally idiosyncratic, but a real
# reading beats `ʿbrwd`. We ask it under every engine it offers and accept a
# result only when the analysis behind it is a **single morpheme** — the engine
# marks proclitic/enclitic boundaries with `+_`/`_+`, and a bare radical guessed
# as a prefixed or suffixed word is a mis-analysis, so it is rejected.

_TRANS_MODULE = None
_TRANS_LOADED = False
_TRANS_ENGINES: dict[str, object] = {}
# Set from the CLI: the transliteration service to use, or "" to use the engine
# in-process (standalone runs). `_TRANS_OFF` skips transliteration entirely.
_TRANS_SERVER = ""
_TRANS_OFF = False


def _load_transliterator():
    """Import `arabic-bw-transliterate.py` (dashes, so by path), once."""
    global _TRANS_MODULE, _TRANS_LOADED
    if _TRANS_LOADED:
        return _TRANS_MODULE
    _TRANS_LOADED = True
    try:
        import importlib.util
        path = Path(__file__).with_name("arabic-bw-transliterate.py")
        spec = importlib.util.spec_from_file_location("arabic_bw_transliterate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        _TRANS_MODULE = module
    except Exception as exc:  # noqa: BLE001 - the engine is optional
        emit("log", message=f"  transliteration engine unavailable: {exc}")
        _TRANS_MODULE = None
    return _TRANS_MODULE


def _hw_single_morpheme(analysis: dict) -> bool:
    """True when the analysis carries no proclitic/enclitic boundary."""
    seg = f"{analysis.get('d3seg') or ''}{analysis.get('diac') or ''}"
    return "+_" not in seg and "_+" not in seg


def _hw_skeleton(text: str) -> str:
    """The consonant skeleton of a transliteration: vowels and punctuation dropped,
    digraphs folded, so `battak` and `bakhtara` can be compared with a root.

    Variants of the same letter are folded too, because the sources use them for
    loanwords and the scans confuse them: a jīm written `g` or `ǧ` (`ātešgī`),
    and a qāf written `ḳ` (Wehr's own letter) or a khāʾ written `ḵ`.
    """
    t = text.lower()
    for digraph, one in (("sh", "š"), ("th", "ṯ"), ("kh", "ḫ"), ("dh", "ḏ"),
                         ("gh", "ġ"), ("ch", "č")):
        t = t.replace(digraph, one)
    for variant, one in (("ǧ", "j"), ("g", "j"), ("ḳ", "q"), ("ḵ", "ḫ")):
        t = t.replace(variant, one)
    return "".join(
        ch for ch in t
        if ch not in "aeiouāēīōū" and not ch.isspace() and ch not in "-'’‘`.,;:()[]"
    )


def _hw_root_skeleton(arabic: str) -> str:
    """The consonant skeleton of an Arabic root (alif, alif maqṣūra and tāʾ marbūṭa
    are vocalic in transliteration, so they carry no consonant)."""
    letters: list[str] = []
    for ch in arabic:
        if ch in "اأإآٱىة":
            continue
        letters.append(_HW_RADICALS.get(ch, ""))
    return _hw_skeleton("".join(letters))


def _hw_is_bare_root(arabic: str, roman: str) -> bool:
    """True when `roman` is the root itself — not a conjugation or a derivative.

    Wehr defines the root, so an inflected reading (`katabtu`, `battak`) or one
    with an affixed pronoun is not a name for the entry.
    """
    return _hw_bare_root_reading(arabic, roman) is not None


def _hw_collapse_gemination(skeleton: str) -> tuple[str, bool]:
    """Collapse one doubled consonant; report whether one was collapsed."""
    out: list[str] = []
    collapsed = False
    i = 0
    while i < len(skeleton):
        if not collapsed and i + 1 < len(skeleton) and skeleton[i] == skeleton[i + 1]:
            out.append(skeleton[i])
            collapsed = True
            i += 2
        else:
            out.append(skeleton[i])
            i += 1
    return "".join(out), collapsed


def _hw_bare_root_reading(arabic: str, roman: str) -> str | None:
    """The reading to use for `roman`, or None if it is not the root.

    A doubled consonant is not an added morpheme: it marks the intensive verb form
    (II, `faʿʿala`), whose dictionary form is the perfect `battaka` — the engine
    renders the bare pausal `battak`, so the final vowel is restored from the form
    itself. Any *other* added consonant is an affix (a conjugation, a pronoun), and
    such a reading is not a name for the root.
    """
    # The comparison uses the shared skeletons: gemination collapsed, the hamza
    # ignored and the weak letters dropped on both sides — the root's column writes
    # `نات` where the reading spells the carrier, and a weak letter (و/ي) is as
    # often a vowel in the reading as a consonant (`ابريز` → `ibrīz`). A headword of
    # no letters at all (the root `ا`) has nothing to contradict, so anything stands
    # — judged on the raw letters, so a root that is all weak letters (`وا`) does
    # not get the same licence.
    skeleton = _hw_skeletons(arabic)
    if not _hw_root_skeleton(arabic).replace("ʾ", ""):
        return roman
    # Tanwīn's *n* is not a root consonant, so the comparison ignores it — but the
    # reading itself is returned untouched, because the guidelines keep tanwīn in
    # the two cases that matter here: indefinite defective-root nouns (qāḍin) and
    # adverbials (ṭabʿan). Everywhere else the engine's citation form already has
    # no ending (baḥr, per "noun/adjective final inflections not represented").
    probe = roman
    if probe.endswith(("un", "an", "in")):
        probe = probe[:-2]
    collapsed = _hw_translit_skeleton(probe)
    if collapsed != skeleton:
        return None
    # A doubled consonant is not an added morpheme: it marks the intensive form
    # (II, faʿʿala), and the engine renders the bare pausal faʿʿal (battak), so the
    # completion below needs to know whether one was collapsed.
    _, geminated = _hw_collapse_gemination(_hw_skeleton(probe))
    if not geminated:
        return roman
    # A doubled consonant is not an added morpheme: it marks the intensive form
    # (II, faʿʿala), and the engine renders the bare pausal faʿʿal (battak). A
    # verb's final inflection is retained (guideline 5), so complete it as the
    # perfect battaka. A u/i stem is instead an imperfect or passive (aṣudd,
    # ahubb) — a conjugation, not a name for the root.
    if any(v in probe for v in "uūiīoō"):
        return None
    return probe if probe.endswith(("a", "ā")) else probe + "a"


def _hw_server_reading(arabic: str, *, prose: bool = False) -> str | None:
    """A reading of the bare root, from the transliteration service.

    `standalone` tells the service this is a word on its own, not an excerpt, so
    it is not read in pausal form. Case endings are off, which is what the
    guidelines want for a headword: the citation form has no tanwīn (`baḥr`, not
    `baḥrun`), while a verb's final inflection is kept (`kataba`) and a suffixed
    word keeps its vowel (`minka`).
    """
    request = urllib.request.Request(
        _TRANS_SERVER.rstrip("/") + "/transliterate",
        data=json.dumps({"text": arabic, "engine": "bert", "keep_case": False,
                         "standalone": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    candidate = str(payload.get("romanized") or "").strip().lower()
    # A hyphen or space marks a proclitic/enclitic reading (more than one morpheme).
    if not candidate or not re.fullmatch(r"[A-Za-z\u00C0-\u024F\u1E00-\u1EFFʿʾ]+", candidate):
        return None
    return _hw_bare_root_reading(arabic, candidate)


def _hw_local_reading(arabic: str) -> str | None:
    """The same, using the engine in-process (for standalone runs)."""
    mod = _load_transliterator()
    if mod is None:
        return None
    for engine in ("bert", "mle", "none"):
        try:
            if engine not in _TRANS_ENGINES:
                _TRANS_ENGINES[engine] = None if engine == "none" else mod.load_disambiguator(engine)
            dis = _TRANS_ENGINES[engine]
        except Exception:  # noqa: BLE001 - that engine is unavailable here
            continue
        args = types.SimpleNamespace(
            engine=engine, sun_letters=False, keep_case=False,
            dotless_ya="maqsura", name=False, debug=False,
        )
        try:
            if dis is not None:
                # Ask for all its possibilities; the top analysis is the one the
                # engine will render, so it is the one that must qualify.
                analyses = getattr(dis.disambiguate([arabic])[0], "analyses", None) or []
                if not analyses or not _hw_single_morpheme(analyses[0].analysis):
                    continue
            candidate = mod.transliterate(arabic, dis, args, capitalize=False, end_pausal=False)
        except Exception:  # noqa: BLE001
            continue
        if not candidate or not re.fullmatch(r"[A-Za-z\u00C0-\u024F\u1E00-\u1EFFʿʾ]+", candidate):
            continue
        reading = _hw_bare_root_reading(arabic, candidate.lower())
        if reading:
            return reading
    return None


def _hw_engine_romanization(arabic: str) -> str | None:
    """A single-morpheme reading of a word, or None.

    The citation form is used (`baḥr`, not `baḥrun`): our conventions write no
    tanwīn, and a perfect verb's final `-a` is restored from the form itself
    (`battaka`). See `_hw_bare_root_reading`.

    A short or vowel-less result (`th`, `khr`) is a guess, not a word: it is
    rejected here so the caller can try the entry's own terms, and only then the
    letter-by-letter fallback.
    """
    if _TRANS_OFF or not arabic:
        return None
    ask = _hw_server_reading if _TRANS_SERVER else _hw_local_reading
    reading = ask(arabic)
    if reading and not _hw_plausible_reading(reading):
        return None
    return reading


def _hw_plausible_reading(reading: str) -> bool:
    """A reading is a plausible name only if it is a word, not a consonant stub.

    A vowel is the test, not a length: a one- or two-letter root has only a short
    reading (`وا` → `wa`, `ا` → `a`), while the stub the engine returns for a bare
    cluster (`th`, `khr`) has none. Whether a reading really is the root is decided
    by the skeleton comparison, not here.
    """
    return any(v in reading.lower() for v in _HW_VOWELS)


def _hw_word_romanization(arabic: str, convention: str = DEFAULT_ROMANIZATION) -> str:
    """Name a single word: the engine, normalised to the citation form, else letters.

    Used for a derived entry's headword when the source gives no transliteration
    for it — by either dictionary. The result is written in `convention`.
    """
    reading = _hw_engine_romanization(arabic)
    if reading:
        return _hw_romanize(_hw_normalize_citation(reading, arabic, arabic), convention)
    return _hw_romanize(_hw_radical_romanization(arabic), convention)


def _hw_prose_terms(definition: str) -> list[str]:
    """Every Arabic word in an entry, in order.

    Lane gives the term first, with its subject or object after it (`أَثَفَ
    القِدْرَ`), and examples follow — so the first word is the term, but a word
    carrying the radicals may appear anywhere in the article, and usually does.
    """
    return [w for run in _HW_ARABIC_WORD_RE.findall(definition or "") for w in run.split()]


def _hw_skeletons(arabic: str) -> str:
    """A word's skeleton, for comparing it with a root.

    Gemination is collapsed and the hamza ignored; the weak letters are dropped
    too, because they are interchangeable and often do not survive derivation —
    `آدى` still matches the root `ادو`, whose و the derived verb loses.
    """
    skeleton = _hw_root_skeleton(arabic).replace("ʾ", "")
    return _hw_collapse_gemination(skeleton.replace("w", "").replace("y", ""))[0]


def _hw_is_root(arabic: str, root: str) -> bool:
    """True when a word *is* the root — not a derivative or a suffixed form.

    Equality, not containment, is what keeps a suffixed reading out: `أَبَضَهُ` is
    not a name for `بض`, while `ظَلَّ` is for `ظل`.
    """
    return bool(_hw_skeletons(root)) and _hw_skeletons(arabic) == _hw_skeletons(root)


def _hw_contains_root(arabic: str, root: str) -> bool:
    """True when a word contains the root's radicals, in order.

    A conjugation may carry the radicals with extra letters and still be the only
    form the entry gives (`أَتْأَرْتُ` for `تأر`), which the conventions allow as a
    last resort before the letter-by-letter fallback. A one-letter skeleton would
    match almost anything, so it is refused.
    """
    root_skeleton = _hw_skeletons(root)
    if len(root_skeleton) < 2:
        return False
    letters = iter(_hw_skeletons(arabic))
    return all(ch in letters for ch in root_skeleton)


def _hw_normalize_citation(reading: str, arabic: str, root: str) -> str:
    """Bring an engine reading of a vocalised word to the vault's citation form.

    Three adjustments. The guidelines write no tanwīn on a name (`baḥr`, not
    `baḥrun`), but the engine returns one for a noun (`أَتْمٌ` → `atmun`) — except
    for a defective root, where an indefinite keeps it (`قَاضٍ` → `qāḍin`), and
    `-an` is always kept. And a verb's final inflection is retained (`battaka`),
    while the engine reads a citation form as pausal and drops it — `نَأَتَ` comes
    back `naʾat` though the vowel is right there in the source.
    """
    defective = _hw_root_skeleton(root).rstrip().endswith(("w", "y"))
    if reading.endswith("un") or (reading.endswith("in") and not defective):
        reading = reading[:-2]
    for ch in reversed(arabic or ""):
        if ch in _HW_HARAKAT:
            vowel = _HW_FINAL_VOWELS.get(ch, "")
            if vowel and not reading.endswith(vowel):
                return reading + vowel
            return reading
        if not ch.isspace():
            break
    return reading


def _hw_terms_romanization(arabic: str, derived: list[tuple]) -> str:
    """The reading of a term from the root's own entries — either dictionary.

    Two passes over the entry's Arabic words, in order. First a word that *is* the
    root — `أَثَفَ` for `اثف`, fully vocalised, giving `athafa`. Then, since many
    entries never give the plain term at all (`أَتْأَرْتُ إِلَيْهِ النَّظَرَ` for
    `تأر`), a word that merely contains the radicals — a conjugated verb is
    acceptable here, as the conventions allow when nothing clearer exists. The
    engine's dropped final short vowel is restored from the source.
    """
    terms: list[str] = []
    for _entry_id, _word, definition in derived[:3]:
        terms.extend(_hw_prose_terms(definition))
    for matcher in (_hw_is_root, _hw_contains_root):
        for term in terms[:400]:
            if not matcher(term, arabic):
                continue
            reading = _hw_engine_romanization(term)
            if reading:
                return _hw_normalize_citation(reading, term, arabic)
    return ""


def _hw_root_romanization(arabic: str, derived: list[tuple],
                          convention: str = DEFAULT_ROMANIZATION) -> str:
    """The best reading of a root — shared by both dictionaries.

    Neither source transliterates every root: Lane's gives none at all, and Wehr's
    gives them in the definition but not always. Both file the root as a bare,
    unvocalised cluster, so both need the same order here: the root itself, then
    the root's own entries, then — only if nothing was found — letter by letter.
    Anything the engine produces is written in `convention`; a transliteration the
    source's own text carries is left exactly as it is, which the callers try
    first.

    A root carrying a hamza tries the entries *first*: the engine cannot know which
    vowel a bare hamza has, and reads `نأت` as the vowel-less `nʾat` (the bare
    cluster `نات`, its hamza dropped in the source's word column, is worse still —
    `nāt`), whereas `نَأَتَ` gives `naʾata`.
    """
    from_entries = _hw_terms_romanization(arabic, derived)
    if from_entries and any(ch in _HW_HAMZA for ch in arabic):
        return _hw_romanize(from_entries, convention)
    reading = _hw_engine_romanization(arabic)
    if reading:
        return _hw_romanize(_hw_normalize_citation(reading, arabic, arabic), convention)
    return _hw_romanize(from_entries or _hw_radical_romanization(arabic), convention)


def _hw_translit_skeleton(roman: str) -> str:
    """A Latin transliteration's skeleton, normalised exactly as an Arabic word's.

    `_hw_skeletons` folds digraphs, drops the vowels, ignores the hamza and drops
    the weak letters; this does the same to the Latin side so the two compare.
    """
    return _hw_collapse_gemination(
        _hw_skeleton(roman).replace("ʾ", "").replace("w", "").replace("y", "")
    )[0]


def _hw_reads_arabic(roman: str, arabic: str) -> bool:
    """Whether a transliteration found in the text really reads that Arabic.

    A definition also carries Roman numerals, OCR rubble and cross-references, so
    an extraction is usable only when its skeleton is the headword's — `حقب VITI …`
    (a numeral the scan turned into `VITI`) and `حكيمباشي see` both fail, and the
    entry's own transliterations, or the shared machinery, name it instead. The
    skeleton test is enough here: the source's own value is already the form it
    wants, so the engine's completion rules do not apply to it. A headword with no
    letters at all (the root `ا`) has nothing to contradict, so anything stands —
    judged on the raw letters, so a root that is all weak letters (`وا`) does not
    get the same licence.
    """
    if not roman:
        return False
    if not _hw_root_skeleton(arabic).replace("ʾ", ""):
        return True
    return _hw_translit_skeleton(roman) == _hw_skeletons(arabic)


def _hw_reads_root(roman: str, root: str) -> bool:
    """Whether a transliteration reads a word that carries the root's radicals.

    Used for a candidate taken from one of the root's *entries*: a derived form's
    own transliteration is usable as the root's name only if it contains the root's
    consonants in order — `ḥuqb` for `حقب`, `ḥurūb` for `حرب` — and not, say,
    `toll`, which is a fine reading of a derived `تول` but says nothing about `وا`.
    """
    if not roman:
        return False
    if not _hw_root_skeleton(root).replace("ʾ", ""):
        return True
    letters = iter(_hw_translit_skeleton(roman))
    return all(ch in letters for ch in _hw_skeletons(root))


def _hw_find_first_valid_romanization(derived: list[tuple], root: str = "") -> str | None:
    """The first derived entry that is not a verb form and has a transliteration.

    With `root`, the transliteration must also read a word carrying the root's
    radicals — the entry's own transliteration is only a name for the root if it
    does.
    """
    for _entry_id, _word, definition in derived:
        if _hw_is_verb_form(definition):
            continue
        roman = _hw_extract_romanization(definition)
        if not roman:
            continue
        if root and not _hw_reads_root(roman, root):
            continue
        if _hw_reads_arabic(roman, _hw_headword(definition) or _word):
            return roman
    return None


def _hw_split_segments(def_text: str) -> list[tuple[str | None, str]]:
    """Split a definition on its sense numbers (`1.`) and Roman numerals (`<b>II</b>`)."""
    if not def_text:
        return []
    bounds: list[tuple[int, int, str]] = []
    for m in _HW_NUMBER_RE.finditer(def_text):
        bounds.append((m.start(), m.end(), m.group(1)))
    for m in _HW_ROMAN_RE.finditer(def_text):
        bounds.append((m.start(), m.end(), m.group(1)))
    bounds.sort(key=lambda b: b[0])
    merged: list[tuple[int, int, str]] = []
    skip = False
    for i, b in enumerate(bounds):
        if skip:
            skip = False
            continue
        if i + 1 < len(bounds) and "=" in def_text[b[1]:bounds[i + 1][0]]:
            # "II = II V" — one label, not two segments.
            merged.append((b[0], bounds[i + 1][1], f"{b[2]} = {bounds[i + 1][2]}"))
            skip = True
            continue
        merged.append(b)
    if not merged:
        return [(None, def_text.strip())]
    segments: list[tuple[str | None, str]] = []
    if merged[0][0] > 0:
        first = def_text[:merged[0][0]].strip()
        if first:
            segments.append((None, first))
    for i, b in enumerate(merged):
        end = merged[i + 1][0] if i + 1 < len(merged) else len(def_text)
        segments.append((b[2], def_text[b[1]:end].strip()))
    return segments


def _hw_grid_bullets(arabic: str, definition: str, roman: str | None) -> list[str]:
    """The callout body as alternating bullets: label (odd), content (even)."""
    def_text = re.sub(r"\s+", " ", definition or "").strip()
    def_text = _HW_HEAD_RE.sub("", def_text, count=1).lstrip()
    if roman and roman != "unknown":
        # The printed superscript diptote marker (mamnūʿ min al-ṣarf) came out of
        # the OCR as a literal digit glued to the transliteration ("aḥmad2",
        # "makka2"). Take the first occurrence of the term, italicise it, and put
        # a glued digit back into a real superscript. A plain `\b…\b` match would
        # fail here: there is no word boundary between "d" and "2".
        pattern = re.compile(r"(?<!\w)" + re.escape(roman) + r"(\d)?(?![^\W\d])")
        def_text = pattern.sub(
            lambda m: f"*{roman}*" + (f"<sup>{m.group(1)}</sup>" if m.group(1) else ""),
            def_text, count=1,
        )
    segments = _hw_split_segments(def_text)
    bullets: list[str] = [arabic]
    if not segments:
        bullets.append(def_text)
    else:
        first_label, first_content = segments[0]
        if first_label is None:
            bullets.append(first_content)
            remaining = segments[1:]
        else:
            bullets.append("")
            remaining = segments
        for label, content in remaining:
            bullets.append(label)
            bullets.append(content or "")
    # Pad to an even count so the two-column grid stays aligned.
    if len(bullets) % 2 != 0:
        bullets.append("")
    # Our conventions bold with markdown / CSS, never HTML: drop any `<b>` the
    # source leaves behind. (The sense markers were already turned into grid
    # labels, and the callout CSS bolds the label column.) The `<sup>` marker
    # added above is ours and is kept.
    return [re.sub(r"</?b[^>]*>", "", b, flags=re.IGNORECASE) for b in bullets]


def _hw_prose_headword(text: str) -> str | None:
    """The leading Arabic run of a prose definition — the entry's headword."""
    m = _HW_PROSE_HEAD_RE.match((text or "").strip())
    return m.group(0).strip() if m else None


def _hw_is_bare_arabic(text: str) -> bool:
    """True when a string is nothing but Arabic — a bare root, not a definition."""
    return bool(text) and not re.search(rf"[^{_HW_ARABIC}\s]", text)


def _hw_prose_quotes(text: str) -> str:
    """Curly quotes for a source that already has them.

    Lane's text is already correctly quoted, but `smart_quotes` re-decides every
    mark from its neighbours and so reverses a closing quote that follows a space
    (`... war ”]` → `... war “]`). Leave the curly marks alone and turn only the
    rare straight one, by the same positional rule; a grave accent, which stands
    for ʿayn in some sources, becomes ‘.
    """
    text = text.replace("`", "‘")
    text = re.sub(r'(?:^|(?<=[\s(\[{<\-–—]))"', "\x01", text)
    text = re.sub(r"(?:^|(?<=[\s(\[{<\-–—]))'", "\x02", text)
    text = text.replace('"', "”").replace("'", "’")
    return text.replace("\x01", "“").replace("\x02", "‘")


def _hw_prose(definition: str) -> list[str]:
    """Lane's definition as markdown paragraphs.

    The text is English prose with a little markup: `<i>` for the glosses, a
    `<center>` holding a verse or a heading, `<h3>` for its lines, and the rare
    `<table>`. Keep what Obsidian renders, turn the source's own dividers (`===`,
    `___`) into paragraph breaks, and drop the rest. Square brackets — Lane's
    editorial additions — become round ones, per the vault's rule.
    """
    text = definition or ""

    def _centre(m: re.Match) -> str:
        """A `<center>` block is a verse.

        Lane sets poetry as centred hemistichs — one `<h3>` per hemistich, often
        several bayts — and 2,159 of the 2,160 blocks in the corpus are Arabic
        alone. Emit the vault's poetry callout, the same shape the transcription
        pipeline produces for a hemistich line. (Lane's print marks each hemistich
        with an asterisk; it carries no meaning for us, so it is stripped.)
        """
        inner = re.sub(r"(?is)</?h3[^>]*>", "\n", m.group(1))
        lines = [re.sub(r"\s+", " ", ln).strip().strip("*").strip() for ln in inner.split("\n")]
        lines = [ln for ln in lines if ln]
        if not lines:
            return "\n\n"
        return "\n\n" + "\n".join([_HW_POETRY_CALLOUT] + [f">- {ln}" for ln in lines]) + "\n\n"

    text = re.sub(r"(?is)<center[^>]*>(.*?)</center>", _centre, text)
    # Lane uses `*` as a mark of its own — a separator inside a reference list
    # (`(S, * M, A, K;)`, `(IAar, K *.)`). Obsidian has no working escape for it,
    # so it pairs with another `*` somewhere and italicises everything between
    # them. A `*` with a space on either side can neither open nor close emphasis,
    # so pad every run. Done here, before any markdown marker of our own is
    # written, so those are left untouched.
    text = re.sub(r"\*+", " * ", text)
    text = re.sub(r"(?is)<h3[^>]*>(.*?)</h3>", lambda m: f"\n\n**{m.group(1).strip()}**\n\n", text)
    # A table (six entries in the whole lexicon) is flattened: one line per row,
    # cells separated by a tab so the columns stay legible in the source.
    text = re.sub(r"(?is)</t[dh]\s*>", "\t", text)
    text = re.sub(r"(?is)<t[dh][^>]*>", "", text)
    text = re.sub(r"(?is)</tr\s*>", "\n", text)
    text = re.sub(r"(?is)</?(?:table|tbody|tr)[^>]*>", "", text)
    text = re.sub(r"(?is)<br\s*/?>", " ", text)
    text = re.sub(r"(?is)<i>(.*?)</i>", lambda m: f"*{m.group(1).strip()}*", text)
    text = re.sub(r"<[^>]+>", "", text)
    # `===` and `___` divide senses; the barb arrow and `↓` point at another
    # entry. (The daggers that mark post-classical usage are kept — they are
    # meaningful, and render as ordinary text.)
    text = re.sub(r"\s*={3,}\s*", "\n\n", text)
    text = re.sub(r"\s*_{3,}\s*", "\n\n", text)
    text = text.replace("\U0001f87b", "↓").replace("\u2193", "↓")
    for mark, vowel in _HW_MEDIAL_VOWELS.items():
        text = text.replace(mark, vowel)
    text = text.replace("\u200e", "")

    def _collapse(paragraph: str) -> str:
        # A verse block keeps its line breaks; everything else is one line.
        if paragraph.lstrip().startswith(">"):
            return "\n".join(re.sub(r"\s+", " ", ln).strip()
                             for ln in paragraph.split("\n") if ln.strip())
        return re.sub(r"\s+", " ", paragraph).strip()

    paragraphs = [_collapse(p) for p in re.split(r"\n\s*\n", text)]
    paragraphs = [p for p in paragraphs if p]
    # The vault uses curly quotes, and never a square bracket.
    paragraphs = [_hw_prose_quotes(p) for p in paragraphs]
    # ...except the poetry callout's own `[!type]`, which the bracket rule below
    # would otherwise turn into `(!type)` and destroy the callout. Park it.
    paragraphs = [p.replace(_HW_POETRY_CALLOUT, "\x03") for p in paragraphs]
    paragraphs = [p.replace("[[", "(").replace("]]", ")") for p in paragraphs]
    paragraphs = [re.sub(r"\[(.+?)\]", r"(\1)", p) for p in paragraphs]
    paragraphs = [p.replace("[", "(").replace("]", ")") for p in paragraphs]
    paragraphs = [p.replace("\x03", _HW_POETRY_CALLOUT) for p in paragraphs]
    # Mark the headword so the callout CSS can size it as Arabic, not as prose.
    if paragraphs:
        paragraphs[0] = _HW_PROSE_HEAD_RE.sub(
            lambda m: f'<span class="mas-hw">{m.group(0).strip()}</span>',
            paragraphs[0], count=1,
        )
    return paragraphs


def _hw_root_entry(entry_id: int, word: str, definition: str, derived: list[tuple],
                   *, prose: bool = False, convention: str = DEFAULT_ROMANIZATION) -> dict | None:
    """A root entry: its transliteration comes from a derived entry when it is a verb form."""
    definition = (definition or "").strip()
    if _hw_should_skip(definition, pointers=not prose):
        return None
    if prose:
        # Lane gives no transliteration, so the name is read from the root itself
        # by the transliteration service — and, if that reading is rejected, from
        # the root's own entries (see `_hw_root_romanization`).
        arabic = _hw_prose_headword(definition) or (word or "").strip()
        if not arabic:
            return None
        paragraphs = _hw_prose(definition)
        if len(paragraphs) == 1 and _hw_is_bare_arabic(_hw_strip_tags(paragraphs[0])):
            # The row is the bare root with no entry of its own; the derived rows
            # below carry the text.
            paragraphs = []
        return {
            "id": entry_id, "arabic": arabic, "roman": _hw_root_romanization(arabic, derived, convention),
            "verb_form": False, "paragraphs": paragraphs,
        }
    arabic = _hw_headword(definition) or (word or "").strip()
    if not arabic:
        return None
    verb = _hw_is_verb_form(definition)
    if verb:
        roman = _hw_find_first_valid_romanization(derived, arabic)
        if not roman:
            for _eid, _w, d in derived:
                candidate = _hw_extract_romanization(d)
                if candidate and _hw_reads_arabic(candidate, _hw_headword(d) or _w):
                    roman = candidate
                    break
        if not roman:
            roman = _hw_root_romanization(arabic, derived, convention)
    else:
        # The source's own transliteration first — but only if it really reads the
        # headword (the text also carries numerals and cross-references) — then any
        # the entries carry, then the same shared machinery Lane uses. A value the
        # source wrote is kept exactly as written; only an engine reading is recast
        # into the work's convention, inside `_hw_root_romanization`.
        extracted = _hw_extract_romanization(definition)
        roman = ((extracted if extracted and _hw_reads_arabic(extracted, arabic) else None)
                 or _hw_find_first_valid_romanization(derived, arabic)
                 or _hw_root_romanization(arabic, derived, convention))
    # A verb-form root's own callout is never italicised, though its heading uses
    # the transliteration found above.
    return {
        "id": entry_id, "arabic": arabic, "roman": roman, "verb_form": verb,
        "bullets": _hw_grid_bullets(arabic, definition, None if verb else roman),
    }


def _hw_derived_entry(entry_id: int, word: str, definition: str,
                      *, prose: bool = False, convention: str = DEFAULT_ROMANIZATION) -> dict | None:
    """A derived entry; a verb form carries no transliteration in its heading."""
    definition = (definition or "").strip()
    if _hw_should_skip(definition, pointers=not prose):
        return None
    if prose:
        # The headword is already fully vocalized, and a derived form is not the
        # root — so it is shown in Arabic only, with no transliterated heading.
        arabic = _hw_prose_headword(definition) or (word or "").strip()
        if not arabic:
            return None
        return {
            "id": entry_id, "arabic": arabic, "roman": None,
            "verb_form": False, "paragraphs": _hw_prose(definition),
        }
    arabic = _hw_headword(definition) or (word or "").strip()
    if not arabic:
        return None
    if _hw_is_verb_form(definition):
        return {
            "id": entry_id, "arabic": arabic, "roman": None, "verb_form": True,
            "bullets": _hw_grid_bullets(arabic, definition, None),
        }
    extracted = _hw_extract_romanization(definition)
    roman = ((extracted if extracted and _hw_reads_arabic(extracted, arabic) else None)
             or _hw_word_romanization(arabic, convention))
    return {
        "id": entry_id, "arabic": arabic, "roman": roman, "verb_form": False,
        "bullets": _hw_grid_bullets(arabic, definition, roman),
    }


_HW_LETTER_ORDER = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي"
# Fold the alef/hamza variants onto their base letter, so "آب" is filed under ا.
_HW_LETTER_FOLD = {"آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه"}


def _hw_note_base(entry: dict, prefix: str = "HW") -> str:
    safe_ar = re.sub(r'[<>:"/\\|?*]', "", entry["arabic"])
    safe_rom = re.sub(r'[<>:"/\\|?*]', "", entry["roman"] or "")
    return re.sub(r"\s+", " ", f"{prefix} {entry['id']} {safe_ar} {safe_rom}").strip()


def _hw_letter_of(arabic: str) -> str:
    """The letter a root is filed under (alef variants folded onto ا)."""
    first = (arabic or "?")[0]
    return _HW_LETTER_FOLD.get(first, first)


def _hw_letter_page(letter: str, convention: str = DEFAULT_ROMANIZATION) -> str:
    """A letter page's label: the letter and its romanized equivalent (`ز z`).

    The label follows the work's own convention, so in the Wehr work it reads
    `ث ṯ` — matching the transliterations of the notes it indexes.
    """
    return f"{letter} {_hw_romanize(_HW_RADICALS.get(letter, ''), convention)}".strip()


def _hw_letter_index(units: list[dict], convention: str = DEFAULT_ROMANIZATION) -> list[dict]:
    """One index unit per first letter, so a work's hub lists letters, not roots.

    A dictionary has thousands of roots — far too many to list on one page — so
    the work note points at one *letter* page, and each letter page lists the
    roots that start with it.
    """
    groups: dict[str, list[dict]] = {}
    for u in units:
        groups.setdefault(_hw_letter_of(u["root"]["arabic"]), []).append(u)

    def order(letter: str) -> tuple[int, int]:
        i = _HW_LETTER_ORDER.find(letter)
        return (0, i) if i >= 0 else (1, ord(letter))

    out: list[dict] = []
    for letter in sorted(groups, key=order):
        roots = sorted(groups[letter], key=lambda u: u["root"]["arabic"])
        out.append({
            "kind": "dict-index",
            "id": letter,
            "base": _hw_letter_page(letter, convention),
            "title": _hw_letter_page(letter, convention),
            "letter": letter,
            "roman": _hw_romanize(_HW_RADICALS.get(letter, ""), convention),
            "roots": [
                {"base": u["base"], "arabic": u["root"]["arabic"], "roman": u["root"]["roman"]}
                for u in roots
            ],
        })
    return out


def build_dictionary_units(work: dict, args: argparse.Namespace) -> list[dict]:
    """One unit (note) per dictionary root, carrying its derived entries."""
    url = work.get("db_url") or COLLECTIONS["dictionary"]["data"]
    emit("step", name=work["title"], status="downloading", detail="sqlite")
    data = fetch(url, cache=not args.no_cache)
    key = re.sub(r"[^\w.-]+", "_", url)[-180:]
    db_path = CACHE_DIR / key
    if not db_path.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)
        db_path.write_bytes(data)
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        names = {str(r[0]).lower() for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
        table = "entries" if "entries" in names else "dictionary"
        rows = list(cur.execute(f"SELECT ID, WORD, DEFINITION, IS_ROOT, PARENT_ID FROM {table}"))
    finally:
        conn.close()
    by_id: dict[int, tuple[str, str]] = {}
    parent_of: dict[int, int] = {}
    root_rows: list[int] = []
    for rid, word, definition, is_root, parent in rows:
        by_id[rid] = (word or "", definition or "")
        parent_of[rid] = parent
        if is_root:
            root_rows.append(rid)
    root_set = set(root_rows)

    def nearest_root(rid: int) -> int | None:
        """Walk up to the root a row belongs to — the database is not always flat:
        `شرف` → `مشرف` → `مشرق`, so a row's parent may itself be a derived row."""
        seen: set[int] = set()
        cur = parent_of.get(rid)
        while cur is not None and cur not in seen:
            if cur in root_set:
                return cur
            seen.add(cur)
            cur = parent_of.get(cur)
        return None

    derived: dict[int, list[int]] = {}
    orphaned = 0
    for rid in by_id:
        if rid in root_set:
            continue
        owner = nearest_root(rid)
        if owner is None:
            orphaned += 1
            continue
        derived.setdefault(owner, []).append(rid)
    if orphaned:
        emit("log", message=f"  {orphaned} entr(ies) had no root ancestor and were skipped")
    # The database splits a root into more than one `is_root` row (548 roots) —
    # حرب is both ḥariba the verb (4457) and ḥarb the noun (4458). In print they
    # are one entry, so group the root rows by the root word and merge each group:
    # the first row is the note, the rest join it, and every derived form of the
    # group is nested beneath. (The rows are in the app's own order.)
    groups: dict[str, list[int]] = {}
    for rid in sorted(root_rows):
        groups.setdefault(by_id[rid][0], []).append(rid)
    emit("step", name=work["title"], status="parsing", detail=f"{len(groups)} roots")
    prose = work.get("body") == "prose"
    prefix = work.get("note_prefix") or "HW"
    convention = work.get("convention") or DEFAULT_ROMANIZATION
    units: list[dict] = []
    for n, (word, group) in enumerate(groups.items()):
        derived_ids = [d for rid in group for d in derived.get(rid, [])]
        derived_rows = [(d, by_id[d][0], by_id[d][1]) for d in derived_ids]
        # The group's first row with real content is the note; the others join it
        # as further sections. The database pairs a pointer row with the row that
        # carries the entry — ابيب has id 6 ("look up alphabetically") and id 60
        # ("abīb the eleventh month…") — so the pointer must not become the note.
        root: dict | None = None
        entries: list[dict] = []
        for rid in group:
            entry = _hw_root_entry(rid, by_id[rid][0], by_id[rid][1], derived_rows,
                                   prose=prose, convention=convention)
            if entry is None:
                continue
            if root is None:
                root = entry
            else:
                entries.append(entry)
        if root is None and derived_rows:
            # Every row is a pointer, but the derived forms still carry content:
            # keep the note, with the root as a bare headword rather than the
            # pointer text. The id and word stay the root's, so the note is not
            # named after a derived term.
            main = group[0]
            word_ar = (_hw_prose_headword if prose else _hw_headword)(by_id[main][1]) or by_id[main][0]
            roman = _hw_root_romanization(word_ar, derived_rows, convention)
            root = {"id": main, "arabic": word_ar, "roman": roman, "verb_form": False}
            if prose:
                root["paragraphs"] = []
            else:
                root["bullets"] = [word_ar, f"*{roman}*"]
        if root is None:
            continue
        entries += [e for e in (_hw_derived_entry(eid, w, d, prose=prose, convention=convention) for eid, w, d in derived_rows) if e]
        # Where the source stops being the Lexicon and starts being its
        # Supplement: the note marks it so the two books stay distinguishable
        # inside one root's page. (A Supplement-only root marks from the top.)
        if work.get("supplement_from"):
            boundary = work["supplement_from"]
            if root["id"] >= boundary:
                root["supplement"] = True
            for entry in entries:
                if entry["id"] >= boundary:
                    entry["supplement"] = True
        # A bare root with neither an entry of its own nor any derived form carries
        # nothing, and a note with only a heading is noise. The database has one
        # such row — 12893, itself a child of another root, contradicting its own
        # `IS_ROOT` flag — and its definition is just the headword.
        if not entries and not (root.get("paragraphs") or root.get("bullets")):
            continue
        units.append({
            "kind": "dict",
            "id": root["id"],
            "base": _hw_note_base(root, prefix),
            "title": f"{root['arabic']} {root['roman']}",
            # A two-level work: the bottom page names its letter page first in
            # `mas-up`, so you can step to the adjacent entries of the same letter.
            "section_page": f"{work['dir']} - {_hw_letter_page(_hw_letter_of(root['arabic']), convention)}",
            "root": root,
            "entries": entries,
        })
        if (n + 1) % 500 == 0:
            emit("step", name=work["title"], status="parsing", detail=f"{len(units)} roots")
    # The letter index units come first, so the hub lists letters, not 7,000 roots.
    return _hw_letter_index(units, convention) + units


def work_model(work: dict, units: list[dict], created: str, layout: str) -> dict:
    """Assemble the render model handed to the plugin's templates."""
    is_hadith = work["collection"] == "hadith"
    return {
        "schema": MODEL_SCHEMA.get(work["collection"], BASE_MODEL_SCHEMA),
        "generated": created,
        "work": {
            "key": work["key"],
            "collection": work["collection"],
            "collection_label": work.get("collection_label", ""),
            "id": work["id"],
            "name": work["name"],
            "title": work["title"],
            "dir": work["dir"],
            "short": work.get("short", ""),
            "title_ar": work.get("title_ar", ""),
            "short_ar": work.get("short_ar", ""),
            "title_plain": strip_diacritics(work["title"]),
            "authors": work["authors"],
            "translators": work["translators"],
            "aliases": work["aliases"],
            "language": work["language"],
            "languages": work["languages"],
            "language_links": work["language_links"],
            "cssclass": work["cssclass"],
            "moc": work["moc"],
            "moc_sections": work["moc_sections"],
            "up": work["up"],
            "source": work.get("source", ""),
            "repository_name": repository_name(work.get("source", "")),
            "repo": repo_url(work),
            "repo_name": repository_name(repo_url(work)),
            "source_name": repository_name(work.get("source", "")),
            "license_attribution": work.get("license_attribution", ""),
            "repository_updated": work.get("repository_updated", ""),
            "source_hash": work.get("source_hash", ""),
            "author": work.get("author", ""),
            "kind": ("dict" if work["collection"] == "dictionary"
                     else "hadith" if is_hadith
                     else "quran" if work["collection"] == "quran-text"
                     else "surah"),
            # A dictionary's body shape (`grid` senses or `prose` paragraphs) and
            # the prefix its root notes carry (`HW …`, `LL …`), plus the id at
            # which its source stops being one book and starts being a second
            # (Lane's Supplement; 0 = no such split).
            "body": work.get("body", "grid"),
            "note_prefix": work.get("note_prefix", ""),
            "supplement_from": work.get("supplement_from", 0),
            # The named romanization path this work's names follow (`vault`,
            # `wehr`, `full`) — so a note records which convention it is in.
            "convention": work.get("convention", DEFAULT_ROMANIZATION),
            "unit_label": ("Roots" if work["collection"] == "dictionary"
                           else "Chapters" if is_hadith
                           else "Sūrahs"),
            "layout": layout,
        },
        "units": units,
    }


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_list(args: argparse.Namespace) -> int:
    overrides = load_overrides()
    works = list(all_works(overrides).values())
    if args.collection:
        works = [w for w in works if w["collection"] == args.collection]
    if args.language:
        works = [w for w in works if w["language"] == args.language]
    cache_files = _cache_files()
    for w in works:
        w["cache_bytes"] = cached_bytes(w, cache_files)
    works.sort(key=lambda w: (w["collection"], w["language"], w["name"].lower()))
    if args.json:
        emit("works", works=works)
        return 0
    current = None
    for w in works:
        if w["collection"] != current:
            current = w["collection"]
            print(f"\n== {w['collection_label']} ==")
        lang = w["language_label"].upper() if len(w["language_label"]) <= 3 else w["language_label"]
        print(f"  [{lang}] {w['key']:<45} {w['name']}  — {w['author']}")
    print()
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    """Download each work's source JSON and write its render model."""
    global _CANONICAL_RIWAYA, _TRANS_SERVER, _TRANS_OFF
    _CANONICAL_RIWAYA = (getattr(args, "canonical", None) or "hafs").strip() or "hafs"
    # Entries with no transliteration in their source are named by romanizing the
    # bare root. Prefer the transliteration service when one is given; otherwise
    # use the engine in-process (standalone runs). `--no-transliteration` skips
    # it, which is what "proceed without transliteration" does.
    _TRANS_SERVER = (getattr(args, "transliteration_server", "") or "").strip()
    _TRANS_OFF = bool(getattr(args, "no_transliteration", False))
    overrides = load_overrides()
    created = args.created or datetime.now().strftime("%Y-%m-%d")
    layout = getattr(args, "layout", None) or DEFAULT_LAYOUT
    wanted_surahs = None
    if getattr(args, "surahs", None):
        wanted_surahs = {int(x) for x in re.split(r"[,\s]+", args.surahs.strip()) if x}

    by_key = all_works(overrides)

    keys = args.key or []
    unknown = [k for k in keys if k not in by_key]
    if unknown:
        emit("error", message=f"Unknown work key(s): {', '.join(unknown)}")
        return 1
    if not keys:
        emit("error", message="Nothing to fetch. Pass --key <collection:id>.")
        return 1

    table = surah_table()
    models: list[str] = []
    for key in keys:
        work = by_key[key]
        emit("step", name=work["title"], status="starting", detail=work["language"])
        if work["collection"] == "hadith":
            units = build_hadith_units(work, args)
        elif work["collection"] == "quran-text":
            units = build_quran_text_units(work, table, wanted_surahs, args)
        elif work["collection"] == "tafsir-qul":
            units = build_qul_units(work, table, wanted_surahs, args)
        elif work["collection"] == "dictionary":
            units = build_dictionary_units(work, args)
        else:
            units = build_surah_units(work, table, wanted_surahs, args)
        work["repository_updated"] = repo_updated(work)
        work["source_hash"] = repo_hash(work)
        work["license_attribution"] = repo_license_attribution(work)
        model = work_model(work, units, created, layout)
        model_path = MODEL_DIR / work["collection"] / f"{slug_to_dir(work['id'])}.json"
        model_path.parent.mkdir(parents=True, exist_ok=True)
        model_path.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
        models.append(str(model_path))
        emit("step", name=work["title"], status="finished", detail=f"{len(units)} units")

    emit("result", result={"models": models})
    return 0


def _update_model_metadata(model_path: Path, date: str, source_hash: str) -> None:
    """Record a new repository date (text unchanged) without re-downloading."""
    try:
        data = json.loads(model_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return
    work = data.setdefault("work", {})
    if date:
        work["repository_updated"] = date
    if source_hash:
        work["source_hash"] = source_hash
    model_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def cmd_check_updates(args: argparse.Namespace) -> int:
    """Two-stage update check: repository date first, then the text hash.

    Emits keys whose *text* changed (``changed``) and model paths whose
    repository date moved but whose text did not (``date_only``).
    """
    overrides = load_overrides()
    by_key = all_works(overrides)
    changed: list[str] = []
    date_only: list[str] = []
    for key in (args.key or []):
        work = by_key.get(key)
        if not work:
            continue
        model_path = MODEL_DIR / work["collection"] / f"{slug_to_dir(work['id'])}.json"
        stored_hash = stored_date = ""
        if model_path.exists():
            try:
                stored_work = json.loads(model_path.read_text(encoding="utf-8"))["work"]
                stored_hash = stored_work.get("source_hash", "")
                stored_date = stored_work.get("repository_updated", "")
            except Exception:  # noqa: BLE001
                pass
        current_date = repo_updated(work)
        # Stage 1: the repository's own date. Unchanged ⇒ nothing to do.
        if current_date and stored_date and current_date == stored_date:
            emit("step", name=work["title"], status="current", detail=current_date)
            continue
        # Stage 2: compare the text hash, but only against a known baseline.
        # A model with no stored hash (imported before this feature) is adopted
        # rather than re-downloaded — assume it was current when installed.
        current_hash = repo_hash(work)
        if stored_hash and current_hash and current_hash != stored_hash:
            emit("step", name=work["title"], status="text-changed",
                 detail=f"{stored_date or '?'} -> {current_date or '?'}")
            changed.append(key)
        else:
            # Repository changed (or baseline unknown), text the same: record it.
            emit("step", name=work["title"], status="date-only",
                 detail=f"{stored_date or '?'} -> {current_date or '?'}")
            _update_model_metadata(model_path, current_date, current_hash)
            date_only.append(str(model_path))
    emit("result", result={"changed": changed, "date_only": date_only})
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Acquire text corpora and emit render models for the vault.")
    sub = p.add_subparsers(dest="command", required=True)

    lp = sub.add_parser("list", help="List available works.")
    lp.add_argument("--collection", choices=list(COLLECTIONS))
    lp.add_argument("--language", default=None, help="Filter by language code (e.g. ar, en, fr, fa).")
    lp.add_argument("--json", action="store_true", help="Emit JSON instead of a table.")
    lp.set_defaults(func=cmd_list)

    fp = sub.add_parser("fetch", help="Download a work and write its render model JSON.")
    fp.add_argument("--key", action="append", help="<collection>:<id> (repeatable).")
    fp.add_argument("--surahs", default=None, help="Comma-separated sūrah numbers to limit to.")
    fp.add_argument("--layout", default=DEFAULT_LAYOUT, choices=["stacked", "table"],
                    help="Bilingual layout recorded in the model (used by ḥadīth templates).")
    fp.add_argument("--created", default=None, help="Override the model's generated date.")
    fp.add_argument("--no-cache", action="store_true", help="Bypass the download cache.")
    fp.add_argument("--canonical", default="hafs",
                    help="Canonical riwāya id. Qur'ān citation links are added only "
                         "when this is 'hafs' (the reading almost all sources quote).")
    fp.add_argument("--transliteration-server", default="",
                    help="Transliteration service to use for entries whose source gives "
                         "no transliteration (e.g. the dictionary roots).")
    fp.add_argument("--no-transliteration", action="store_true",
                    help="Skip transliteration; name such entries from their radicals.")
    fp.set_defaults(func=cmd_fetch)

    cp = sub.add_parser("check-updates", help="Report works whose source repository has changed.")
    cp.add_argument("--key", action="append", help="<collection>:<id> (repeatable).")
    cp.set_defaults(func=cmd_check_updates)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        emit("error", message="Interrupted.")
        return 130
    except Exception as exc:  # noqa: BLE001
        emit("error", message=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
