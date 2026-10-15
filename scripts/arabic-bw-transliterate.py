#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys

from camel_tools.tokenizers.word import simple_word_tokenize
from camel_tools.utils.charmap import CharMapper
#from camel_tools.ner import NERecognizer


# Arabic-script letter variants → their standard Arabic equivalents. These
# denote the same letter/sound (Persian/Urdu/Pashto/Sindhi/Kurdish/Ajami
# renderings), so normalizing loses nothing. Non-Arabic sounds (p, ch, zh, g,
# v, ng, ñ) are NOT here — they need their own romanization.
_VARIANT_TABLE = {
    # hamza / alef carriers
    0x0672: 0x0623, 0x0675: 0x0623,          # alef w/ wavy or high hamza → أ
    0x0673: 0x0625,                          # alef w/ wavy hamza below → إ
    0x0674: 0x0621,                          # high hamza → ء
    0x0676: 0x0624, 0x0677: 0x0624,          # high hamza waw → ؤ
    0x0678: 0x0626,                          # high hamza yeh → ئ
    # dotless
    0x066E: 0x0628, 0x066F: 0x0642,          # dotless beh/qaf → ب/ق
    # teh / beh variants
    0x0679: 0x062A, 0x067A: 0x062A, 0x067C: 0x062A, 0x067D: 0x062A,
    0x067F: 0x062A,
    0x067B: 0x0628, 0x0680: 0x0628,
    # hah / jeh variants
    0x0681: 0x062D, 0x0682: 0x062D, 0x0685: 0x062D,
    0x0683: 0x062C, 0x0684: 0x062C,
    # dal / reh variants
    0x0688: 0x062F, 0x0689: 0x062F, 0x068A: 0x062F, 0x068B: 0x062F,
    0x068C: 0x062F, 0x068D: 0x062F, 0x068E: 0x062F, 0x068F: 0x062F,
    0x0690: 0x062F,
    0x0691: 0x0631, 0x0692: 0x0631, 0x0693: 0x0631, 0x0694: 0x0631,
    0x0695: 0x0631, 0x0696: 0x0631, 0x0697: 0x0631, 0x0699: 0x0631,
    # seen / sad / tah / ain variants
    0x069A: 0x0633, 0x069B: 0x0633, 0x069C: 0x0633,
    0x069D: 0x0635, 0x069E: 0x0635,
    0x069F: 0x0637,
    0x06A0: 0x0639,
    # feh / qaf / kaf variants
    0x06A1: 0x0641, 0x06A2: 0x0641, 0x06A3: 0x0641,
    0x06A7: 0x0642, 0x06A8: 0x0642,
    0x06A9: 0x0643, 0x06AA: 0x0643, 0x06AC: 0x0643, 0x06AE: 0x0643,
    # lam / noon / meem variants
    0x06B5: 0x0644, 0x06B6: 0x0644, 0x06B7: 0x0644, 0x06B8: 0x0644,
    0x06B9: 0x0646, 0x06BA: 0x0646, 0x06BB: 0x0646, 0x06BC: 0x0646,
    0x06BD: 0x0646, 0x06FE: 0x0645,
    # heh variants (incl. heh goal / doachashmee)
    0x06BE: 0x0647, 0x06BF: 0x0647, 0x06C0: 0x0647, 0x06C1: 0x0647,
    0x06C2: 0x0647, 0x06D5: 0x0647, 0x06FF: 0x0647,
    0x06C3: 0x0629,                          # teh marbuta goal → ة
    # waw variants (vowel w/o/u flavors → waw)
    0x06C4: 0x0648, 0x06C5: 0x0648, 0x06C6: 0x0648, 0x06C7: 0x0648,
    0x06C8: 0x0648, 0x06C9: 0x0648, 0x06CA: 0x0648, 0x06CF: 0x0648,
    # yeh variants (incl. yeh barree, e, yeh with tail)
    0x06CC: 0x064A, 0x06CD: 0x064A, 0x06CE: 0x064A, 0x06D0: 0x064A,
    0x06D1: 0x064A, 0x06D2: 0x064A, 0x06D3: 0x064A,
    # shin / dad / ghain variants
    0x06FA: 0x0634, 0x06FB: 0x0636, 0x06FC: 0x063A,
}

# Terms the user has confirmed, checked before the built-in LEXICON.
LEXICON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            'transliteration-lexicon.json')
try:
    with open(LEXICON_PATH, encoding='utf-8') as _lex_file:
        USER_LEXICON = {key.translate(_VARIANT_TABLE): value
                        for key, value in json.load(_lex_file).items()}
except Exception:
    USER_LEXICON = {}

# Arabic tokens the engine could not diacritize (candidates for the user lexicon).
_UNKNOWN = set()

# Non-Arabic consonants (Persian/Urdu/Ajami) and their romanization. ar2bw maps
# some to Buckwalter P/J/G/V; the rest pass through as Arabic glyphs.
T_MARK = '\uE000'   # internal marker for tāʾ marbūṭa → t (not 'P', which is پ)
NON_ARABIC_BW = {'P': 'p', 'J': 'ch', 'G': 'g', 'V': 'v'}
NON_ARABIC_AR = {
    '\u067e': 'p', '\u0686': 'ch', '\u0698': 'zh', '\u06a4': 'v',
    '\u06a5': 'v', '\u06cb': 'v', '\u06b4': 'ñ', '\u06ad': 'ng',
    '\u06b1': 'ng', '\u0687': 'ch', '\u06a6': 'p', '\u06b0': 'g',
    '\u06b2': 'g', '\u06b3': 'g', '\u06af': 'g',
}


def save_user_lexicon():
    with open(LEXICON_PATH, 'w', encoding='utf-8') as lex_file:
        json.dump(USER_LEXICON, lex_file, ensure_ascii=False, indent=2, sort_keys=True)


_PROCLITIC_ROMAN = {'و': 'wa', 'ف': 'fa', 'ب': 'bi', 'ل': 'li', 'ك': 'ka'}


def lexicon_stem(tok):
    """The lexicon key for a token: tashkīl and any article/proclitic removed."""
    key = strip_harakat(tok)
    match = re.match(r'^[وفبلك]?ال(.+)$', key)
    return match.group(1) if match else key


def _stem_lookup(key, table):
    """Look up a stem in `table`, reconstructing al-/proclitics."""
    if key in table:
        return table[key]
    match = re.match(r'^([وفبلك])ال(.+)$', key)
    if match and match.group(2) in table:
        pro = _PROCLITIC_ROMAN[match.group(1)]
        prefix = 'lil-' if pro == 'li' else pro + '-l-'
        return prefix + table[match.group(2)]
    if key.startswith('ال') and key[2:] in table:
        return 'al-' + table[key[2:]]
    match = re.match(r'^([وفبلك])(.+)$', key)
    if match and len(match.group(2)) > 2 and match.group(2) in table:
        return _PROCLITIC_ROMAN[match.group(1)] + '-' + table[match.group(2)]
    return None


def lexicon_lookup(key):
    """Look up a token in the user lexicon or the built-in stems, reconstructing
    al-/proclitics (و+بعض → wa-baʿḍ)."""
    return _stem_lookup(key, USER_LEXICON) or _stem_lookup(key, LEXICON_STEMS)


# -----------------------------
# Initialization
# -----------------------------

bw_map = CharMapper.builtin_mapper('ar2bw')


def load_disambiguator(engine):
    """Load the diacritization engine. Heavy imports happen here, not at import time."""
    if engine == 'mle':
        from camel_tools.disambig.mle import MLEDisambiguator
        return MLEDisambiguator.pretrained('calima-msa-r13')

    from camel_tools.disambig.bert import BERTUnfactoredDisambiguator
    from transformers import logging as tlog
    tlog.set_verbosity_error()
    return BERTUnfactoredDisambiguator.pretrained()


_ANALYZER = None


def get_analyzer():
    """Lazy raw morphological analyzer, used to resolve alif maqṣūra readings."""
    global _ANALYZER
    if _ANALYZER is None:
        from camel_tools.morphology.database import MorphologyDB
        from camel_tools.morphology.analyzer import Analyzer
        _ANALYZER = Analyzer(MorphologyDB.builtin_db())
    return _ANALYZER


SUN_LETTERS = set("tnṯdḏrzsšṣḍṭẓln")  # transliteration-level set

ROMAN_LETTER = re.compile(r'[A-Za-zĀāĪīŪūḤḥṢṣḌḍṬṭẒẓ]')

BW_FIXES = {
    'mE': 'maEa',
    'mn': 'mina',
    'fy': 'fī',
    'ElY': 'ʿalā',   # or BW form first if you prefer
    'huw': 'huwa',
    'hiy': 'hiya',
}

# Buckwalter → target transliteration
BW2LAT = {
    'A': '',        # word-initial alif (hamzat waṣl); internal alif is marked '`'
    '`': 'ā',
    'Y': 'ā',
    'b': 'b',
    't': 't',
    'v': 'th',
    'j': 'j',
    'H': 'ḥ',
    'x': 'kh',
    'd': 'd',
    '*': 'dh',
    'r': 'r',
    'z': 'z',
    's': 's',
    '$': 'sh',
    'S': 'ṣ',
    'D': 'ḍ',
    'T': 'ṭ',
    'Z': 'ẓ',
    'E': 'ʿ',
    'g': 'gh',
    'f': 'f',
    'q': 'q',
    'k': 'k',
    'l': 'l',
    'm': 'm',
    'n': 'n',
    'h': 'h',
    'w': 'w',
    'y': 'y',
    '\'': 'ʾ',
    '>': 'ʾ',
    '<': 'ʾ',
    '&': 'ʾ',
    '}': 'ʾ',
    '|': 'ʾā',
    '{': '’',     # alif al-waṣla
    '~': '',      # handled separately
    'o': '',      # sukūn
    'F': 'an',      # an tanwīn
    'N': '',      # un tanwīn
    'K': '',      # in tanwīn
    'a': 'a',
    'u': 'u',
    'i': 'i',
    '_': '',
}

# -----------------------------
# Helpers
# -----------------------------

def normalize_bw(bw):
    return BW_FIXES.get(bw, bw)

def normalize_alif_bw(bw):
    # delete final alif after a wāw bearing ḍamma (plural verbs, e.g. qālū)
    bw = re.sub(r'(?<=u)wo?A$', 'w', bw)

    # Remove the alif of tanwīn (both ـًا and ـاً orderings; and ًى in hudan)
    bw = re.sub(r'AF', 'F', bw)
    bw = re.sub(r'FA', 'F', bw)
    bw = re.sub(r'FY', 'F', bw)

    # Silent wāw: Uthmani wāw before dagger alif has no vowel of its own and
    # cannot be pronounced (صَلَوٰة → ṣalāh, الزَّكَوٰة → zakāh)
    bw = re.sub(r'([ai])w`', r'\1`', bw)

    # mark internal alif
    bw = re.sub(r'(?<!^)A', '`', bw)

    return bw

def strip_case_bw(bw):
    return re.sub(r'[aiuFNKo]+$', '', bw)

def is_noun(a):
    return a['pos'] in {'noun', 'adj'}

def is_genitive(a):
    return a.get('case') == 'gen'

def capitalize_roman_initial(s):
    """
    Capitalize the first roman letter in a string,
    skipping characters like ʿ ʾ.
    """
    for i, ch in enumerate(s):
        if ROMAN_LETTER.match(ch):
            return s[:i] + ch.upper() + s[i+1:]
    return s

def capitalize_name(lat):
    """Capitalize the name part, leaving the article/prefix lowercase."""
    cut = lat.rfind('-')
    return lat[:cut+1] + capitalize_roman_initial(lat[cut+1:])


def looks_proper(gloss):
    """True when every sense of a CAMeL gloss is a proper name.

    CAMeL tags some common nouns as ``noun_prop`` (آية = 'Quranic_verse;miracle;
    sign;wonder'), but a genuine name's senses are all capitalised (Muhammad;
    Mohamed, Mecca, Moses). Backoff glosses (NO_ANALYSIS) are never names.
    """
    core = (gloss or '').split('+[')[0]
    if not core or 'NO_ANALYSIS' in core:
        return False
    senses = [s for s in core.split(';') if s.strip()]
    return bool(senses) and all(s[:1].isupper() for s in senses)

_NAME_NOCAP = {'b.', 'bt.', 'wuld', 'bn', 'bint'}


def capitalize_name_words(text):
    """Name-field capitalization: capitalize every substantive word; keep
    al- lowercase unless it opens the field, and never capitalize b./bt./wuld."""
    out = []
    for i, word in enumerate(text.split(' ')):
        if not word or word in _NAME_NOCAP:
            out.append(word)
        elif word.startswith('al-'):
            stem = capitalize_roman_initial(word[3:])
            out.append(('Al-' if i == 0 else 'al-') + stem)
        else:
            out.append(capitalize_roman_initial(word))
    return ' '.join(out)

def capitalize_sentences(text):
    letter = ROMAN_LETTER.pattern

    def repl(match):
        prefix = match.group(1)
        return prefix + match.group(2).upper()

    # Start of string
    text = re.sub(r'^([^\w]*?)(' + letter + r')', repl, text)

    # After sentence-ending punctuation
    text = re.sub(r'([.!?]\s*[^\w]*?)(' + letter + r')', repl, text)

    return text

SUN_LETTERS_BW = set('tvd*rzs$SDTZln')  # ت ث د ذ ر ز س ش ص ض ط ظ ل ن
HARAKAT = set('ًٌٍَُِّْٰ')

# Qur'anic marks that carry no transliteration value. Wasla alif normalizes to
# alef; annotation signs, small high letters and tatweel are dropped.
_QURAN_TABLE = {c: None for c in (
    set(range(0x0653, 0x0660)) | set(range(0x06D6, 0x06EE)) | set(range(0x08E3, 0x0900)) | {0x0640}
)}
# Qur'anic small zero/sukun marks → standard sukun (keeps segmentation working)
for _c in (0x06DF, 0x06E0, 0x06E1):
    _QURAN_TABLE[_c] = 0x0652
_QURAN_TABLE[0x0671] = 0x0627   # alef wasla → alef


def normalize_arabic(text):
    # Uthmani "آء": the madda's hamza and the following hamza are one (nisāʾ)
    text = text.replace('\u0622\u0621', '\u0627\u0621')
    text = text.translate(_VARIANT_TABLE)
    return text.translate(_QURAN_TABLE)
BN_BT = {'بن': 'b.', 'بنت': 'bt.'}

# Particles used in personal names (name mode only): Mauritanian ولد = wuld
NAME_PARTS = {'ولد': 'wuld'}

# Arabic city stems -> accepted English names (place-of-publication fields).
PLACES = {
    'قاهرة': 'Cairo', 'اسكندرية': 'Alexandria', 'جيزة': 'Giza', 'بورسعيد': 'Port Said',
    'سويس': 'Suez', 'منصورة': 'Mansoura', 'طنطا': 'Tanta', 'اسيوط': 'Asyut',
    'اقصر': 'Luxor', 'اسوان': 'Aswan', 'دمياط': 'Damietta',
    'بيروت': 'Beirut', 'طرابلس': 'Tripoli', 'دمشق': 'Damascus', 'حلب': 'Aleppo',
    'حمص': 'Homs', 'حماة': 'Hama', 'اللاذقية': 'Latakia', 'حماه': 'Hama',
    'بغداد': 'Baghdad', 'بصرة': 'Basra', 'موصل': 'Mosul', 'كوفة': 'Kufa',
    'نجف': 'Najaf', 'كربلاء': 'Karbala', 'سامراء': 'Samarra',
    'مكة': 'Mecca', 'مكة المكرمة': 'Mecca', 'مدينة': 'Medina', 'مدينة المنورة': 'Medina',
    'جدة': 'Jeddah', 'رياض': 'Riyadh', 'طائف': 'Taif', 'أبها': 'Abha',
    'عمان': 'Amman', 'قدس': 'Jerusalem', 'بيت المقدس': 'Jerusalem', 'غزة': 'Gaza',
    'خليل': 'Hebron', 'نابلس': 'Nablus', 'رام الله': 'Ramallah', 'بيت لحم': 'Bethlehem',
    'صنعاء': 'Sanaa', 'عدن': 'Aden', 'تعز': 'Taiz', 'حديدة': 'Hodeidah',
    'مسقط': 'Muscat', 'صلالة': 'Salalah', 'دبي': 'Dubai', 'أبو ظبي': 'Abu Dhabi',
    'ابو ظبي': 'Abu Dhabi', 'شارقة': 'Sharjah', 'دوحة': 'Doha', 'كويت': 'Kuwait',
    'منامة': 'Manama', 'طهران': 'Tehran', 'أصفهان': 'Isfahan', 'اصفهان': 'Isfahan',
    'قم': 'Qom', 'مشهد': 'Mashhad', 'تبريز': 'Tabriz', 'شيراز': 'Shiraz',
    'اسطنبول': 'Istanbul', 'أنقرة': 'Ankara', 'انقرة': 'Ankara', 'قونية': 'Konya',
    'بورصة': 'Bursa', 'ازمير': 'Izmir', 'أدرنة': 'Edirne', 'ادرنة': 'Edirne',
    'كابل': 'Kabul', 'قندهار': 'Kandahar', 'هرات': 'Herat', 'مزار شريف': 'Mazar-i-Sharif',
    'لاهور': 'Lahore', 'كراتشي': 'Karachi', 'اسلام آباد': 'Islamabad', 'بيشاور': 'Peshawar',
    'كويتة': 'Quetta', 'دلهي': 'Delhi', 'حيدر آباد': 'Hyderabad', 'دكا': 'Dhaka',
    'جاكرتا': 'Jakarta', 'سورابايا': 'Surabaya', 'باندونغ': 'Bandung',
    'كوالالمبور': 'Kuala Lumpur', 'سنغافورة': 'Singapore', 'طشقند': 'Tashkent',
    'سمرقند': 'Samarkand', 'بخارى': 'Bukhara', 'باكو': 'Baku', 'عشق آباد': 'Ashgabat',
    'بيشكيك': 'Bishkek', 'دوشنبه': 'Dushanbe', 'أستانا': 'Astana', 'استانا': 'Astana',
    'ألماتي': 'Almaty', 'الماتي': 'Almaty',
    'تونس': 'Tunis', 'جزائر': 'Algiers', 'وهران': 'Oran', 'قسنطينة': 'Constantine',
    'فاس': 'Fez', 'مراكش': 'Marrakesh', 'رباط': 'Rabat', 'دار البيضاء': 'Casablanca',
    'طنجة': 'Tangier', 'مكناس': 'Meknes', 'أغادير': 'Agadir', 'اغادير': 'Agadir',
    'وجدة': 'Oujda', 'قيروان': 'Kairouan', 'صفاقس': 'Sfax', 'سوسة': 'Sousse',
    'نواكشوط': 'Nouakchott', 'نواذيبو': 'Nouadhibou', 'روصو': 'Rosso', 'كيفة': 'Kiffa',
    'داكار': 'Dakar', 'سان لويس': 'Saint-Louis', 'توبى': 'Touba', 'تمبكتو': 'Timbuktu',
    'باماكو': 'Bamako', 'موبتي': 'Mopti', 'غاو': 'Gao', 'نيامي': 'Niamey',
    'أغاديز': 'Agadez', 'اغاديز': 'Agadez', 'كانو': 'Kano', 'سوكوتو': 'Sokoto',
    'كادونا': 'Kaduna', 'زاريا': 'Zaria', 'مايدوغوري': 'Maiduguri', 'إبادان': 'Ibadan',
    'ابادان': 'Ibadan', 'لاغوس': 'Lagos',
    'خرطوم': 'Khartoum', 'أم درمان': 'Omdurman', 'ام درمان': 'Omdurman',
    'بورتسودان': 'Port Sudan', 'كسلا': 'Kassala', 'سواكن': 'Suakin',
    'مقديشو': 'Mogadishu', 'هرجيسا': 'Hargeisa', 'بوصاصو': 'Bosaso', 'كيسمايو': 'Kismayo',
    'زنجبار': 'Zanzibar', 'دار السلام': 'Dar es Salaam', 'ممباسا': 'Mombasa',
    'لامو': 'Lamu', 'ماليندي': 'Malindi', 'موروني': 'Moroni', 'جيبوتي': 'Djibouti',
    'أسمرة': 'Asmara', 'اسمرة': 'Asmara', 'مصوع': 'Massawa', 'هرر': 'Harar',
    'أديس أبابا': 'Addis Ababa', 'اديس ابابا': 'Addis Ababa',
    'سراييفو': 'Sarajevo', 'برشتينا': 'Pristina', 'تيرانا': 'Tirana',
    'قرطبة': 'Córdoba', 'غرناطة': 'Granada', 'إشبيلية': 'Seville', 'اشبيلية': 'Seville',
    'طليطلة': 'Toledo', 'مرسية': 'Murcia',
}


def place_name(value):
    """English name for a place value, or None if it isn't a known city."""
    return PLACES.get(lexicon_stem(value))

# Word-level overrides (keys are stripped of tashkīl). Grow as needed.
LEXICON = {
    'الله': 'Allāh',
    'بالله': 'billāh',
    'لله': 'lillāh',
    'عبدالله': 'ʿAbdallāh',
    'اللهم': 'Allāhumma',
    'تبارك': 'tabāraka',
    'تعالى': 'taʿālā',
    'وتعالى': 'wa-taʿālā',
    'بسم': 'bismi',
    'أولا': 'awwalan',
    'الرحمن': 'al-raḥmān',
    'مع': 'maʿa',
    'بد': 'budda',
    'ثم': 'thumma',
    'ذكر': 'dhikr',
    'الذكر': 'al-dhikr',
    'ذكره': 'dhikrihi',
    # ʿĀʾisha: CAMeL mis-segments the tāʾ marbūṭa as the pronoun -hu
    # (`عائش_+هُ` → *ʿĀʾishhu), so pin the name rather than trust the engine.
    'عائشة': 'ʿĀʾisha',
    'عايشة': 'ʿĀʾisha',
}

# Built-in stem overrides that behave like user-lexicon entries: the article and
# proclitics are reconstructed on lookup (و+بعض → wa-baʿḍ, البعض → al-baʿḍ).
LEXICON_STEMS = {
    'بعض': 'baʿḍ',            # MLE picked بِعَضّ "by biting" instead of "some"
    'ليس': 'laysa',           # MLE picked لَيِسَ "be valiant" instead of "is not"
}

# Relative pronouns: a closed paradigm, handled automatically bare or with a
# proclitic. After وَ/فَ/بِ/كَ the hamzat al-waṣl elides (وَالَّذِي → wa-lladhī),
# and لِ + الَّذِي contracts to لِلَّذِي (li-lladhī). CAMeL otherwise splits them
# as al- + أذي/أتي/أذين.
RELATIVE_PRONOUNS = {
    'الذي': 'alladhī', 'التي': 'allatī', 'الذين': 'alladhīna',
    'اللذان': 'alladhāni', 'اللتان': 'allatāni',
    'اللاتي': 'allātī', 'اللواتي': 'allawātī', 'اللائي': 'allāʾī',
}
_RP_ALT = '|'.join(RELATIVE_PRONOUNS)


def relative_pronoun(key):
    """Romanization for a relative pronoun, bare or with a proclitic."""
    if key in RELATIVE_PRONOUNS:
        return RELATIVE_PRONOUNS[key]
    m = re.match(r'^([وفبك])(' + _RP_ALT + r')$', key)
    if m:
        return _PROCLITIC_ROMAN[m.group(1)] + '-' + RELATIVE_PRONOUNS[m.group(2)][1:]
    if key.startswith('ل') and ('ا' + key[1:]) in RELATIVE_PRONOUNS:
        return 'li-' + RELATIVE_PRONOUNS['ا' + key[1:]][1:]
    return None

# Names habitually capitalized even when the engine tags them as common nouns.
PROPER_NAMES = {
    'شيطان',
}

# Multi-word proper names: capitalized only when the words appear TOGETHER,
# because each word alone is an ordinary common noun (`صحيح` = ṣaḥīḥ [sound],
# `مسلم` = muslim). Keys are the tashkīl-stripped token forms, in order.
PROPER_PHRASES = (
    ('صحيح', 'مسلم'),      # Ṣaḥīḥ Muslim (the hadith collection)
    ('صحيح', 'البخاري'),   # Ṣaḥīḥ al-Bukhārī
)


def strip_harakat(s):
    return ''.join(c for c in s if c not in HARAKAT)


# Short vowel of a token's final haraka, for restoring iʿrāb in verse/keep-case.
# Tanwīn is included because `with_case` only runs when keep_case is on, and
# full vocalization keeps -an/-un/-in.
_CASE_VOWELS = {
    '\u064E': 'a', '\u064F': 'u', '\u0650': 'i',
    '\u064B': 'an', '\u064C': 'un', '\u064D': 'in',
}
_LATIN_VOWEL_END = set('aeiouāēīōūĀĒĪŌŪʾʿ')


def final_case_vowel(tok):
    """Latin short vowel (or tanwīn) for a token's final haraka, or ''."""
    if not tok:
        return ''
    # Tanwīn fatḥa is usually written over a silent alif: بَعْضًا
    if len(tok) >= 2 and tok[-1] == '\u0627' and tok[-2] == '\u064B':
        return 'an'
    return _CASE_VOWELS.get(tok[-1], '')


def with_case(value, tok, keep_case):
    """Append the source's final short vowel to a lexicon value in verse.

    Guideline 6 keeps noun/adjective inflections in verse; the lexicon stores the
    citation form, so 'اللَّهَ' must come back as Allāha, not Allāh.
    """
    if not keep_case or not value:
        return value
    vowel = final_case_vowel(tok)
    if vowel and value[-1] not in _LATIN_VOWEL_END:
        return value + vowel
    return value


def has_tashkil(s):
    return any(c in HARAKAT for c in s)


_LONG_VOWEL_LETTERS = set('اوىيٱ')
_ARABIC_PUNCT = set('٠١٢٣٤٥٦٧٨٩،؛؟٫٬٭')


def _is_arabic_letter(ch):
    o = ord(ch)
    if not (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or 0x08A0 <= o <= 0x08FF
            or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF):
        return False
    return ch not in HARAKAT and ch not in _ARABIC_PUNCT


def is_fully_vocalized(tok):
    """True when every consonant carries a ḥaraka, so the source tashkīl is
    complete and must not be replaced by the engine's guess."""
    for i, ch in enumerate(tok):
        if ch in HARAKAT or not _is_arabic_letter(ch):
            continue
        if ch in _LONG_VOWEL_LETTERS:
            continue
        if i + 1 < len(tok) and tok[i + 1] in HARAKAT:
            continue
        # the definite article's lam (after alef) may lack a ḥaraka
        if ch == 'ل' and i > 0 and tok[i - 1] in 'اٱ':
            continue
        # a letter before an assimilated (shadda'd) letter may lack a ḥaraka
        if i + 1 < len(tok) and _is_arabic_letter(tok[i + 1]) and '\u0651' in tok[i + 1:i + 4]:
            continue
        return False
    return True


def case_ending_stripped(a):
    """True if a final case marker should be removed from this word."""
    pos = a.get('pos', '')
    if a.get('enc0') not in (None, '', '0', 0):   # real pronominal suffix
        return False
    if pos.startswith(('verb', 'pron')):
        return False
    if pos == 'adv':             # adverbial tanwīn is retained
        return False
    return pos in {'noun', 'adj', 'noun_prop'}


def is_defective_indefinite(a):
    """Defective-root indefinite nouns keep their tanwīn (qāḍin, ṭāghin, dāʿin)."""
    lex = a.get('lex', '')
    diac = a.get('diac', '').rstrip('ّْ')
    return lex.endswith(('ي', 'و')) and diac[-1:] in ('ً', 'ٌ', 'ٍ')


def split_harakat(s):
    """Split into (letter, harakat) pairs, attaching ḥarakāt to their letter."""
    out = []
    for ch in s:
        if ch in HARAKAT:
            if out:
                out[-1] = (out[-1][0], out[-1][1] + ch)
            else:
                out.append(('', ch))
        else:
            out.append((ch, ''))
    return out


def _norm_letter(ch):
    return {'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه'}.get(ch, ch)


def split_leading_article(seg):
    """Split a leading definite article (with its ḥarakāt) off a segment."""
    if not seg.startswith('ا'):
        return None
    i = 1
    while i < len(seg) and seg[i] in HARAKAT:
        i += 1
    if i >= len(seg) or seg[i] != 'ل':
        return None
    i += 1
    while i < len(seg) and seg[i] in HARAKAT:
        i += 1
    return seg[:i], seg[i:]


def split_proclitic_article(tok):
    """Split proclitic + definite article from the source orthography: the
    article's lām has sukūn, or the next letter is assimilated (shadda). This
    rejects false positives such as وَالِدَيْن (wālidayn)."""
    if len(tok) < 4 or tok[0] not in PROCLITICS_AR:
        return None
    i = 1
    while i < len(tok) and tok[i] in HARAKAT:
        i += 1
    alef = i
    if alef >= len(tok) or tok[alef] not in 'اأإآٱ':
        return None
    i = alef + 1
    while i < len(tok) and tok[i] in HARAKAT:
        i += 1
    if i >= len(tok) or tok[i] != 'ل':
        return None
    lam = i
    j = lam + 1
    lam_har = ''
    while j < len(tok) and tok[j] in HARAKAT:
        lam_har += tok[j]
        j += 1
    genuine = 'ْ' in lam_har
    if not genuine and j < len(tok):
        k = j + 1
        while k < len(tok) and tok[k] in HARAKAT:
            if tok[k] == 'ّ':
                genuine = True
                break
            k += 1
    if not genuine or j >= len(tok):
        return None
    return [tok[:alef], tok[alef:j], tok[j:]]


def tashkil_compatible(diac, tok):
    """True if diac does not contradict any haraka explicitly written in tok."""
    c, t = split_harakat(diac), split_harakat(tok)
    if len(c) != len(t):
        return False
    for (cl, ch), (tl, th) in zip(c, t):
        if _norm_letter(cl) != _norm_letter(tl):
            return False
        if any(h not in ch for h in th):
            return False
    return True


def match_tashkil(tok, a):
    """Best morphological reading consistent with the provided tashkīl, or None."""
    cands = get_analyzer().analyze(strip_harakat(tok))
    good = [c for c in cands if tashkil_compatible(c.get('diac', ''), tok)]
    if not good:
        return None
    lex = a.get('lex')
    pool = [c for c in good if c.get('lex') == lex] or good
    best = max(pool, key=lambda c: c.get('pos_lex_logprob') or -99)
    return best.get('diac')


def analysis_credible(a):
    """False when the engine is only backing off (no real lexical entry)."""
    if a.get('gloss') in (None, '', 'NO_ANALYSIS', 'NOAN'):
        return False
    if a.get('pattern') in ('backoff', 'FOREIGN'):
        return False
    if a.get('root') in ('O', 'FOREIGN'):
        return False
    if a.get('pos') == 'foreign':
        return False
    return True


def _hamza_carriers(s):
    return [c for c in strip_harakat(s) if c in 'أإآٱ']


def hamza_carriers_match(diac, tok):
    """The source's hamza carrier constrains the vowel: إ ⇒ i, أ ⇒ a/u."""
    return _hamza_carriers(diac) == _hamza_carriers(tok)


def match_hamza(tok, a):
    """Best raw-analyzer reading whose hamza carriers match the source."""
    base = strip_harakat(tok)
    if not any(c in 'أإآ' for c in base):
        return None
    good = [c for c in get_analyzer().analyze(base) if hamza_carriers_match(c.get('diac', ''), tok)]
    if not good:
        return None
    lex = a.get('lex')
    pool = [c for c in good if c.get('lex') == lex] or good
    return max(pool, key=lambda c: c.get('pos_lex_logprob') or -99).get('diac')


def analyze_fallback(tok):
    """For unvocalized OOV tokens, try the raw analyzer: the whole token, then
    the article-stripped stem. Only nominal readings are trusted, so we don't
    replace a name with a spurious verb form."""
    analyzer = get_analyzer()

    def pick(cands):
        for c in cands:
            if c.get('pos', '').startswith(('noun', 'adj')):
                return c.get('diac', '')
        return ''

    cands = analyzer.analyze(tok)
    if cands:
        chosen = pick(cands)
        if chosen:
            return chosen
    match = re.match(r'^ال(.+)$', tok)
    if match:
        cands = analyzer.analyze(match.group(1))
        if cands:
            chosen = pick(cands)
            if chosen:
                return 'ال' + chosen
    return ''


def split_by_segments(tok, d3seg):
    """Split a vocalized token at the engine's proclitic/enclitic boundaries,
    keeping the source's own vocalization."""
    segs = re.split(r'\+_|_\+', d3seg)
    counts = [len(strip_harakat(s)) for s in segs]
    if sum(counts) != len(strip_harakat(tok)):
        return None
    parts, idx = [], 0
    for n in counts:
        buf, letters = '', 0
        while idx < len(tok) and letters < n:
            ch = tok[idx]
            buf += ch
            if ch not in HARAKAT:
                letters += 1
            idx += 1
        while idx < len(tok) and tok[idx] in HARAKAT:
            buf += tok[idx]
            idx += 1
        parts.append(buf)
    return parts


def split_at_proclitic_hamza(tok):
    """Split proclitic + hamza-initial stem (وَأَقِيمُوا → wa-aqīmū); the engine
    often misses this. A sukūn on the hamza (وَأْد) blocks the split."""
    if len(tok) < 3 or tok[0] not in PROCLITICS_AR:
        return None
    j = 1
    while j < len(tok) and tok[j] in HARAKAT:
        j += 1
    if j >= len(tok) or tok[j] not in 'أإآٱء':
        return None
    k, har = j + 1, ''
    while k < len(tok) and tok[k] in HARAKAT:
        har += tok[k]
        k += 1
    if not any(h in har for h in 'َُِ'):
        return None
    return [tok[:j], tok[j:]]


def split_proclitic_hamza_seg(seg):
    """Split a diacritized segment proclitic + hamza-initial stem (وَإِنَّ)."""
    if not seg or seg[0] not in PROCLITICS_AR:
        return None
    i = 1
    while i < len(seg) and seg[i] in HARAKAT:
        i += 1
    if i < len(seg) and seg[i] in 'أإآٱء':
        return [seg[:i], seg[i:]]
    return None


def pausalizable(a):
    """Words whose final inflection is dropped in pause."""
    return a.get('pos', '').startswith(('verb', 'noun', 'adj'))


def pausalize(bw):
    """Pausal form: drop the final ending; tanwīn fathatan becomes long ā."""
    m = re.search(r'(?:A?F|FA?)$', bw)
    if m:
        return bw[:m.start()] + 'A'
    return re.sub(r'[aiuNK]+$', '', bw)


def smart_join(parts):
    """Join tokens, keeping punctuation and ornate brackets snug."""
    no_space_before = set('،؛.,;:!?)]}»”﴾')
    no_space_after = set('([{«“﴿')
    s = ''
    for p in parts:
        if not p:
            continue
        if not s:
            s = p
        elif s[-1] in no_space_after or p[0] in no_space_before:
            s += p
        else:
            s += ' ' + p
    return s


def detect_idafa(disambig, i):
    if i + 1 >= len(disambig):
        return False
    if disambig[i] is None or disambig[i+1] is None:
        return False

    a1 = disambig[i].analyses[0].analysis if disambig[i].analyses else {}
    a2 = disambig[i+1].analyses[0].analysis if disambig[i+1].analyses else {}

    # the muḍāf must be an indefinite noun (not prefixed by the article)
    if a1.get('pos') != 'noun':
        return False
    segs = re.split(r'\+_|_\+', a1.get('d3seg', ''))
    if 'ال' in segs or a1.get('diac', '').startswith('ال'):
        return False

    # the muḍāf ilayh must be genitive
    if a2.get('cas') != 'g':
        return False

    return a2.get('pos') in {'noun', 'adj'}

def normalize_segmentation(bw):
    """
    Replace proclitic +_ with hyphen,
    remove enclitic +_.
    """
    parts = bw.split('+_')
    if len(parts) == 1:
        return bw
    # assume first +_ is proclitic boundary
    return parts[0] + '-' + ''.join(parts[1:])

def handle_al(bw, sun_letters=False):
    if bw.startswith('Al-'):
        next_char = bw[3:4]
        if sun_letters and next_char in SUN_LETTERS:
            return 'a' + next_char + bw[4:]
        return 'al-' + bw[3:]
    return bw

def collapse_long_vowels(s):
    s = re.sub(r'uw(?![waeiouāīū])', 'ū', s)
    s = re.sub(r'iyy$', 'ī', s)
    s = re.sub(r'iy(?![yaeiouāīū])', 'ī', s)
    s = re.sub(r'aā', 'ā', s)
    s = re.sub(r'aa', 'ā', s)
    return s

def transliterate_bw(bw, keep_tanwin=False):
    mapping = BW2LAT
    if keep_tanwin:
        mapping = dict(BW2LAT)
        mapping.update(F='an', N='un', K='in')
    out = []
    for i, ch in enumerate(bw):
        if ch == '~':
            if out:
                out.append(out[-1])
            continue
        if ch == '|':
            # madda: word-initial → ā, otherwise hamza + alif → ʾā
            out.append('ā' if i == 0 else 'ʾā')
            continue
        if ch == 'Y':
            # alif maqṣūra after a kasra is really a defective yāʾ (zidnī)
            if out and out[-1] == 'i':
                out[-1] = 'ī'
            else:
                out.append('ā')
            continue
        if i == 0 and ch in "<>&}'":
            continue  # initial hamza (incl. after the article/prefix) is not represented
        if ch in NON_ARABIC_BW:
            out.append(NON_ARABIC_BW[ch])
            continue
        if ch in NON_ARABIC_AR:
            out.append(NON_ARABIC_AR[ch])
            continue
        out.append(mapping.get(ch, ch))
    return ''.join(out)

# -----------------------------
# Main
# -----------------------------

def server_transliterate(text, args):
    """Send to the resident server; return the romanized text, or None if unreachable."""
    import urllib.error
    import urllib.request
    payload = {
        'text': text,
        'engine': args.engine,
        'sun_letters': args.sun_letters,
        'keep_case': args.keep_case,
        'dotless_ya': args.dotless_ya,
        'name': args.name,
    }
    request = urllib.request.Request(
        args.server_url.rstrip('/') + '/transliterate',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=args.server_timeout) as response:
            data = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        try:
            data = json.loads(error.read().decode('utf-8'))
        except Exception:
            return None
        return data.get('romanized')
    except Exception:
        return None
    return data.get('romanized')


def server_romanize(text, args):
    """Send to the resident server's LLM endpoint; return its JSON dict or None."""
    import urllib.error
    import urllib.request
    payload = {
        'text': text,
        'provider': args.provider,
        'translate': args.translate,
        'keep_case': args.keep_case,
        'name': args.name,
    }
    if args.model:
        payload['model'] = args.model
    if args.api_key:
        payload['api_key'] = args.api_key
    request = urllib.request.Request(
        args.server_url.rstrip('/') + '/romanize',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=args.server_timeout) as response:
            data = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode('utf-8'))
        except Exception:
            return None
    except Exception:
        return None
    return data


def print_llm(data, translate):
    print(data.get('romanized', ''))
    if translate and data.get('translation'):
        print(data['translation'])


def read_block():
    """Read a Ctrl-D-terminated block with no canonical line-length limit."""
    try:
        import termios
        fd = sys.stdin.fileno()
        attrs = termios.tcgetattr(fd)
    except Exception:
        return sys.stdin.read()   # not a TTY (pipe/file): read to EOF
    new = termios.tcgetattr(fd)
    new[3] &= ~termios.ICANON     # keep ECHO and ISIG; disable line buffering
    new[6][termios.VMIN] = 1
    new[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, new)
    chars = []
    try:
        while True:
            ch = sys.stdin.read(1)
            if ch == '' or ch == '\x04':   # EOF or Ctrl-D
                break
            chars.append(ch)
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    return ''.join(chars)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-text', help='Arabic text (if omitted, read interactively)')
    ap.add_argument('--engine', choices=('bert', 'mle', 'none'), default='bert',
                    help='diacritization engine: bert (default), mle (faster startup), '
                         'none (skip CAMeL; fully vocalized input only)')
    ap.add_argument('--sun-letters', action='store_true')
    ap.add_argument('--debug', action='store_true')
    ap.add_argument('--keep-case', action='store_true', help='Keep case endings')
    ap.add_argument('--dotless-ya', choices=('maqsura', 'ya'), default='maqsura',
                    help='final dotless yāʾ (ى): maqsura → force ā (default); ya → let the analysis choose')
    ap.add_argument('--name', action='store_true',
                    help='name mode: capitalize each substantive word (al- lowercase unless first)')
    ap.add_argument('--server-url', default='http://127.0.0.1:8756',
                    help='resident server URL (used unless --local)')
    ap.add_argument('--server-timeout', type=float, default=120.0)
    ap.add_argument('--local', action='store_true',
                    help='ignore the server and run the engine in this process')
    ap.add_argument('--llm', action='store_true',
                    help='romanize with the LLM endpoint (server) instead of the rule engine')
    ap.add_argument('--provider', choices=('gemini', 'deepseek'), default='gemini')
    ap.add_argument('--model', default=None, help='LLM model (server default if omitted)')
    ap.add_argument('--translate', action='store_true', help='also print an English translation')
    ap.add_argument('--api-key', default=None, help='API key for the LLM (else the server environment)')
    args = ap.parse_args()

    if args.text is not None:
        if args.llm:
            data = server_romanize(args.text, args)
            if data is None:
                print('(LLM romanization requires the running server)', file=sys.stderr)
                return
            if data.get('error'):
                print(f'LLM error: {data["error"]}', file=sys.stderr)
                return
            print_llm(data, args.translate)
            return
        if not args.local:
            out = server_transliterate(args.text, args)
            if out is not None:
                print(out)
                return
            print('(server not reachable; running the engine locally)', file=sys.stderr)
        disambiguator = None if args.engine == 'none' else load_disambiguator(args.engine)
        print(transliterate_document(args.text, disambiguator, args))
        return

    disambiguator = None
    local_loaded = False
    last_text = None
    session_route = 'llm' if args.llm else 'engine'
    print('Paste Arabic text, then press Ctrl-D to submit. Ctrl-D on an empty line (or '
          '"q" + Ctrl-D) quits. Default route: '
          f'{"the LLM" if session_route == "llm" else "the rule engine"}. '
          'Prefix a block with <llm> or <engine> for that block only; "llm mode"/"engine mode" '
          'change the default; a block of just llm/engine re-runs the previous request.',
          file=sys.stderr)
    while True:
        try:
            block = read_block()
        except KeyboardInterrupt:
            print()
            continue
        if block == '':
            break
        lines = block.split('\n')
        while lines and lines[-1] == '':
            lines.pop()
        if not lines:
            continue
        first = lines[0].strip()
        low = first.lower()
        if low in ('q', 'quit', 'exit'):
            break
        if low in ('llm mode', 'engine mode'):
            session_route = low.split()[0]
            print(f'Default route: {"the LLM" if session_route == "llm" else "the rule engine"}.', file=sys.stderr)
            continue
        if low == 'mode':
            print(f'Default route: {"the LLM" if session_route == "llm" else "the rule engine"}.', file=sys.stderr)
            continue
        route = session_route
        if low.startswith('<llm>'):
            route, lines[0] = 'llm', first[5:].strip()
        elif low.startswith('<engine>'):
            route, lines[0] = 'engine', first[8:].strip()
        text = '\n'.join(lines).strip()
        if text.lower() in ('llm', 'engine') and last_text is not None:
            route, text = text.lower(), last_text
        if not text:
            print('(no text)', file=sys.stderr)
            continue
        last_text = text
        if route == 'llm':
            data = server_romanize(text, args)
            if data is None:
                print('(LLM romanization requires the running server)', file=sys.stderr)
            elif data.get('error'):
                print(f'LLM error: {data["error"]}', file=sys.stderr)
            else:
                print_llm(data, args.translate)
            continue
        if not args.local:
            out = server_transliterate(text, args)
            if out is not None:
                print(out)
                continue
        if not local_loaded:
            print('(server not reachable; running the engine locally)', file=sys.stderr)
            disambiguator = None if args.engine == 'none' else load_disambiguator(args.engine)
            local_loaded = True
        print(transliterate_document(text, disambiguator, args))


PROCLITICS_AR = {'و', 'ف', 'ب', 'ل', 'ك', 'س', 'أ'}


def latin_of_proclitic(seg_ar):
    bw = normalize_alif_bw(bw_map.map_string(seg_ar))
    bw = bw.replace('~', '')   # shadda here is article assimilation, not gemination
    return transliterate_bw(bw)


def latin_of_clitic(seg_ar, pausal=False):
    """Render an enclitic (suffix); pausal stripping applies at the word's end."""
    bw = normalize_alif_bw(bw_map.map_string(seg_ar))
    bw = bw.replace('~', '')
    if pausal:
        bw = pausalize(bw)
    return collapse_long_vowels(transliterate_bw(bw))


def transliterate_stem(seg_ar, a, disambig, i, args, has_article, vocalized, force_maqsura, keep_case, defective, pausal):
    if force_maqsura and not vocalized:
        raw = strip_harakat(seg_ar)
        if raw.endswith('ي'):
            # The source wrote ى (alif maqṣūra); re-read the stem as such
            cands = get_analyzer().analyze(raw[:-1] + 'ى')
            maq = [c for c in cands if strip_harakat(c.get('diac', '')).endswith('ى')]
            if maq:
                seg_ar = maq[0].get('diac', seg_ar)
    bw = bw_map.map_string(seg_ar)
    # A word-initial shadda is idghām with the previous word, never part of the word
    bw = re.sub(r'^([^aiuFNKo~])([aiuFNKo]*)~', r'\1\2', bw)
    if not keep_case and not defective and case_ending_stripped(a):
        # drop the final case vowel and -un/-in; keep -an (fathatan) by default
        bw = re.sub(r'[aiuNKo]+$', '', bw)
    if re.search(r'p[aiuFNKo]*$', bw):
        if keep_case:
            bw = re.sub(r'p', T_MARK, bw)
        elif detect_idafa(disambig, i):
            bw = re.sub(r'p([aiuFNKo]*)$', T_MARK + r'\1', bw)
        elif re.search(r'A[aiuFNKo]*p[aiuFNKo]*$', bw):
            bw = re.sub(r'p([aiuFNKo]*)$', r'h\1', bw)
        else:
            bw = re.sub(r'p([aiuNKo]*)$', '', bw)
            bw = re.sub(r'pF$', 'tF', bw)
    if pausal:
        bw = pausalize(bw)
    bw = normalize_bw(bw)
    bw = normalize_alif_bw(bw)
    bw = re.sub(r'([^aiuFNKo~])([aiuFNKo]*)~', r'\1~\2', bw)   # shadda sits on its consonant
    lat = transliterate_bw(bw, keep_tanwin=(keep_case or defective))
    lat = lat.replace(T_MARK, 't')
    return collapse_long_vowels(lat)


def transliterate_word(tok, a, disambig, i, args, keep_case, pausal, direct):
    vocalized = has_tashkil(tok)
    # Complete tashkīl: use it directly (CAMeL only for segmentation, never diacritics)
    direct = direct or (vocalized and is_fully_vocalized(tok))
    force_maqsura = (args.engine != 'none' and args.dotless_ya == 'maqsura'
                     and strip_harakat(tok).endswith('ى'))
    defective = is_defective_indefinite(a)
    d3seg = a.get('d3seg') or ''
    if 'NOAN' in d3seg:
        d3seg = ''
    if not d3seg and not vocalized:
        d3seg = analyze_fallback(tok)
    diac = a.get('diac') or ''
    if 'NOAN' in diac:
        diac = ''
    seg = d3seg or diac or tok
    if vocalized:
        # Verified Qur'an: transliterate the given vocalization directly
        seg = tok if direct else (match_tashkil(tok, a) or tok)
    # Reject a guess that adds a madda the source doesn't have (التجاني → *اِلْتَجَآنِي)
    if '\u0622' in seg and '\u0622' not in tok:
        seg = tok
    # The source's hamza carrier constrains the vowel (إن ⇒ in/inna, never anna)
    if not vocalized and not hamza_carriers_match(seg, tok):
        matched = match_hamza(tok, a)
        if matched:
            seg = matched
            sp = split_proclitic_hamza_seg(seg)
            if sp:
                seg = '+_'.join(sp)
    if not vocalized and any('\u0621' <= c <= '\u064A' for c in tok):
        if not analysis_credible(a):
            _UNKNOWN.add(lexicon_stem(tok))
    parts = re.split(r'\+_|_\+', seg)
    d3 = d3seg
    if (direct or vocalized) and ('+_' in d3 or '_+' in d3):
        split = split_by_segments(seg, d3)
        if split:
            parts = split
    if direct and len(parts) == 1:
        fallback = split_at_proclitic_hamza(tok)
        if fallback:
            parts = fallback
    plain = [strip_harakat(p) for p in parts]

    # A bare trailing yāʾ is the engine misreading an alif maqṣūra
    if force_maqsura and len(parts) >= 2 and plain[-1] == 'ي':
        parts[-2] += parts[-1]
        parts = parts[:-1]
        plain = [strip_harakat(p) for p in parts]

    # Trust the source orthography for proclitic + article; the engine both
    # misses (dagger alif) and over-splits (والدين → wa-l-dīn).
    if direct or vocalized:
        pa = split_proclitic_article(tok)
        if pa:
            parts = pa
            plain = [strip_harakat(p) for p in parts]
        elif len(parts) >= 2 and plain[0] in PROCLITICS_AR and plain[1] in ('ال', 'ل'):
            parts = [tok]
            plain = [strip_harakat(p) for p in parts]

    # A definite article merged with a following segment (وَ+_الْخَاتِم) is split out
    if len(parts) >= 2 and plain[0] in PROCLITICS_AR:
        art = split_leading_article(parts[1])
        if art and art[1]:
            parts[1:2] = [art[0], art[1]]
            plain = [strip_harakat(p) for p in parts]

    prefix = ''
    has_article = False
    idx = 0

    if len(parts) >= 2 and plain[0] in PROCLITICS_AR:
        pro = latin_of_proclitic(parts[0])
        idx = 1
        if plain[1] in ('ال', 'ل'):   # 'ل' = article lam with elided alif after a prefix
            prefix = 'lil-' if pro == 'li' else pro + '-l-'
            has_article = True
            idx = 2
        else:
            prefix = pro + '-'
    elif plain[0] == 'ال':
        prefix = 'al-'
        has_article = True
        idx = 1
    elif plain[0].startswith('ال') and len(plain[0]) > 2:
        prefix = 'al-'
        has_article = True
        parts = [re.sub(r'^ال', '', parts[0])] + parts[1:]

    # Sun-letter assimilation (optional; invariant al- is the default)
    if has_article and args.sun_letters:
        stem_bw = bw_map.map_string(parts[idx])
        first = stem_bw[1:2] if stem_bw.startswith('~') else stem_bw[:1]
        if first in SUN_LETTERS_BW:
            c = transliterate_bw(first)
            if prefix == 'al-':
                prefix = 'a' + c + '-'
            elif prefix == 'lil-':
                prefix = 'li' + c + '-'
            else:
                prefix = prefix[:-3] + '-' + c + '-'

    stem = transliterate_stem(parts[idx], a, disambig, i, args, has_article, vocalized, force_maqsura, keep_case, defective, pausal and idx + 1 >= len(parts))
    tail = ''.join(latin_of_clitic(p, pausal) for p in parts[idx+1:])
    return prefix + stem + tail


def transliterate(text, disambiguator, args, capitalize=True, end_pausal=False):
    text = normalize_arabic(text)
    tokens = simple_word_tokenize(text)
    if disambiguator is None:
        disambig = [None] * len(tokens)
    else:
        disambig = disambiguator.disambiguate(tokens)

    output = []
    in_quran = False
    prev_key = ''
    no_engine = disambiguator is None

    # Tokens covered by a PROPER_PHRASE are force-capitalized when the whole
    # phrase is present, even though each word alone is a common noun.
    tok_keys = [strip_harakat(t) for t in tokens]
    forced_caps = set()
    for j in range(len(tok_keys)):
        for phrase in PROPER_PHRASES:
            if tuple(tok_keys[j:j + len(phrase)]) == phrase:
                forced_caps.update(range(j, j + len(phrase)))

    for i, tok in enumerate(tokens):
        d = disambig[i]
        a = d.analyses[0].analysis if (d is not None and d.analyses) else {}
        key = strip_harakat(tok)

        if tok == '﴿':
            in_quran = True
        elif tok == '﴾':
            in_quran = False

        # Fully vocalized (classical) text and Qur'an spans keep iʿrāb endings
        keep_case = args.keep_case or in_quran or is_fully_vocalized(tok)

        # Pausal form before a waqf/comma/period or at the end of a passage
        next_tok = tokens[i + 1] if i + 1 < len(tokens) else ''
        at_end = next_tok in ('﴾', '.', '!', '?', '»', '”', ',', '،', '؛', ';') \
            or (next_tok == '' and end_pausal)
        pausal = keep_case and at_end and (no_engine or pausalizable(a))

        # Relative pronouns (الذي …), bare or with a proclitic (والذي → wa-lladhī)
        rp = relative_pronoun(key)
        if rp is not None:
            output.append(rp)
            prev_key = key
            continue

        # Word-level overrides and name conventions. A tanwīn fatḥa written over
        # a silent alif (بَعْضًا) still maps to the stem (بعض), so try the key
        # without that alif too.
        key_alt = key[:-1] if (len(key) >= 2 and tok[-1] == '\u0627'
                               and tok[-2] == '\u064B') else key
        hit = lexicon_lookup(key)
        if hit is None and key_alt != key:
            hit = lexicon_lookup(key_alt)
        if hit is not None:
            output.append(with_case(hit, tok, keep_case))
            prev_key = key
            continue
        if key in LEXICON:
            output.append(with_case(LEXICON[key], tok, keep_case))
            prev_key = key
            continue
        if key_alt != key and key_alt in LEXICON:
            output.append(with_case(LEXICON[key_alt], tok, keep_case))
            prev_key = key
            continue
        if getattr(args, 'name', False) and key in NAME_PARTS:
            output.append(with_case(NAME_PARTS[key], tok, keep_case))
            prev_key = key
            continue
        if key in BN_BT:
            output.append(BN_BT[key])
            prev_key = key
            continue

        # Context: "lā budda an" takes the subjunctive particle an, not anna
        if key == 'أن' and prev_key == 'بد':
            output.append('an')
            prev_key = key
            continue
        # "إن" before a verb is the conditional in, not inna (incl. و/ف + إن)
        m_in = re.match(r'^([وف]?)إن$', key)
        if m_in and i + 1 < len(tokens):
            nxt = disambig[i + 1]
            npos = nxt.analyses[0].analysis.get('pos', '') if (nxt is not None and nxt.analyses) else ''
            if npos.startswith('verb'):
                pro = 'wa-' if m_in.group(1) == 'و' else 'fa-' if m_in.group(1) == 'ف' else ''
                output.append(pro + 'in')
                prev_key = key
                continue

        lat = transliterate_word(tok, a, disambig, i, args, keep_case, pausal, in_quran or no_engine)
        key_base = re.sub(r'^(?:[وفبلك]?ال)', '', key)
        if key_base in PROPER_NAMES or i in forced_caps:
            lat = capitalize_name(lat)
        elif (a.get('pos') == 'noun_prop' and analysis_credible(a)
              and looks_proper(a.get('gloss') or '')
              and not re.match(r'^(wa|fa|bi|li|ka|sa|lil)-', lat)):
            lat = capitalize_name(lat)
        output.append(lat)
        prev_key = key

        if args.debug:
            print('---')
            print('TOKEN:', tok)
            print('DIAC:', a.get('diac'))
            print('D3SEG:', a.get('d3seg'))
            print('LAT :', output[-1])
            print('POS :', a.get('pos'))
            print('LEX :', a.get('lex'))

    text_out = smart_join(output)
    if getattr(args, 'name', False):
        text_out = capitalize_name_words(text_out)
    elif capitalize:
        text_out = capitalize_sentences(text_out)
    text_out = text_out.replace('ʿAbd Allāh', 'ʿAbdallāh')
    # Romanized output is LTR: swap the RTL ornate parentheses so they read left-to-right
    text_out = text_out.replace('\uFD3F', '\x00').replace('\uFD3E', '\uFD3F').replace('\x00', '\uFD3E')
    return text_out


# Arabic-script runs (letters, marks, digits, punctuation, ornate brackets),
# allowing intra-run spaces but never newlines, so markdown structure survives.
_ARABIC_RUN_RE = re.compile(
    r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+'
    r'(?:[^\S\n]+[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*'
)


def _starts_sentence(prefix):
    stripped = prefix.rstrip(' \t')
    if not stripped:
        return True
    if stripped[-1] in '.!?…؟':
        return True
    line = stripped.rsplit('\n', 1)[-1].lstrip()
    return line[:1] in ('#', '>', '-', '*')


def transliterate_document(text, disambiguator, args, final_pausal=True):
    """Transliterate only the Arabic runs; leave all other characters as-is.

    `final_pausal` controls whether the last run counts as passage-final (and so
    is read in pausal form, losing its final short vowel). Pass False to treat the
    text as a **word on its own** — a citation form — rather than an excerpt.
    """
    _UNKNOWN.clear()
    out = []
    last = 0
    for match in _ARABIC_RUN_RE.finditer(text):
        out.append(text[last:match.start()])
        after = text[match.end():].lstrip(' ')
        end_pausal = final_pausal and (after == '' or after[0] in '.!?،؛,»”')
        out.append(transliterate(match.group(0), disambiguator, args,
                                 capitalize=_starts_sentence(text[:match.start()]),
                                 end_pausal=end_pausal))
        last = match.end()
    out.append(text[last:])
    return ''.join(out)


if __name__ == '__main__':
    main()
