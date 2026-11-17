/**
 * The 114 sūras, in the three forms a citation may need.
 *
 * `arabic` is the name as the vault's canonical Qur'ān notes carry it.
 * `common` is the transliteration the notes are named with (quran-json's),
 * which is also what an existing `[[024 An-Nur#10|النور : ١٠]]` link shows.
 * `strict` follows the vault's own romanization conventions (see
 * `AI OS/Arabic transliteration guidelines.md`): the article is always `al-`
 * with a hyphen — never assimilated to a sun letter — tāʾ marbūṭa is dropped
 * after a short *a* but kept as `h` after *ā*, ʿayn is `ʿ`, hamzat qaṭʿ is `ʾ`
 * (initial hamza, including after the article, is not written), and the
 * spelled-out letters are Ṭā Hā, Yā Sīn, Ṣād, Qāf.
 *
 * This table is static on purpose. A citation is formatted from the link's own
 * target, so no note, no frontmatter, and no metadata cache is consulted while
 * rendering — a 3,500-citation volume costs a lookup and a string join.
 */

export interface Surah {
	/** 1–114. */
	number: number;
	/** Arabic name as the canonical Qur'ān notes carry it. */
	arabic: string;
	/** Common (quran-json) romanization: `An-Nur`. */
	common: string;
	/** Strict romanization per the vault's conventions: `al-Nūr`. */
	strict: string;
}

type Row = [number, string, string, string];

const ROWS: Row[] = [
	[1, "الفاتحة", "Al-Fatihah", "al-Fātiḥa"],
	[2, "البقرة", "Al-Baqarah", "al-Baqara"],
	[3, "آل عمران", "Al 'Imran", "Āl ʿImrān"],
	[4, "النساء", "An-Nisa", "al-Nisāʾ"],
	[5, "المائدة", "Al-Ma'idah", "al-Māʾida"],
	[6, "الأنعام", "Al-An'am", "al-Anʿām"],
	[7, "الأعراف", "Al-A'raf", "al-Aʿrāf"],
	[8, "الأنفال", "Al-Anfal", "al-Anfāl"],
	[9, "التوبة", "At-Tawbah", "al-Tawba"],
	[10, "يونس", "Yunus", "Yūnus"],
	[11, "هود", "Hud", "Hūd"],
	[12, "يوسف", "Yusuf", "Yūsuf"],
	[13, "الرعد", "Ar-Ra'd", "al-Raʿd"],
	[14, "إبراهيم", "Ibrahim", "Ibrāhīm"],
	[15, "الحجر", "Al-Hijr", "al-Ḥijr"],
	[16, "النحل", "An-Nahl", "al-Naḥl"],
	[17, "الإسراء", "Al-Isra", "al-Isrāʾ"],
	[18, "الكهف", "Al-Kahf", "al-Kahf"],
	[19, "مريم", "Maryam", "Maryam"],
	[20, "طه", "Taha", "Ṭā Hā"],
	[21, "الأنبياء", "Al-Anbya", "al-Anbiyāʾ"],
	[22, "الحج", "Al-Hajj", "al-Ḥajj"],
	[23, "المؤمنون", "Al-Mu'minun", "al-Muʾminūn"],
	[24, "النور", "An-Nur", "al-Nūr"],
	[25, "الفرقان", "Al-Furqan", "al-Furqān"],
	[26, "الشعراء", "Ash-Shu'ara", "al-Shuʿarāʾ"],
	[27, "النمل", "An-Naml", "al-Naml"],
	[28, "القصص", "Al-Qasas", "al-Qaṣaṣ"],
	[29, "العنكبوت", "Al-'Ankabut", "al-ʿAnkabūt"],
	[30, "الروم", "Ar-Rum", "al-Rūm"],
	[31, "لقمان", "Luqman", "Luqmān"],
	[32, "السجدة", "As-Sajdah", "al-Sajda"],
	[33, "الأحزاب", "Al-Ahzab", "al-Aḥzāb"],
	[34, "سبأ", "Saba", "Sabaʾ"],
	[35, "فاطر", "Fatir", "Fāṭir"],
	[36, "يس", "Ya-Sin", "Yā Sīn"],
	[37, "الصافات", "As-Saffat", "al-Ṣāffāt"],
	[38, "ص", "Sad", "Ṣād"],
	[39, "الزمر", "Az-Zumar", "al-Zumar"],
	[40, "غافر", "Ghafir", "Ghāfir"],
	[41, "فصلت", "Fussilat", "Fuṣṣilat"],
	[42, "الشورى", "Ash-Shuraa", "al-Shūrā"],
	[43, "الزخرف", "Az-Zukhruf", "al-Zukhruf"],
	[44, "الدخان", "Ad-Dukhan", "al-Dukhān"],
	[45, "الجاثية", "Al-Jathiyah", "al-Jāthiya"],
	[46, "الأحقاف", "Al-Ahqaf", "al-Aḥqāf"],
	[47, "محمد", "Muhammad", "Muḥammad"],
	[48, "الفتح", "Al-Fath", "al-Fatḥ"],
	[49, "الحجرات", "Al-Hujurat", "al-Ḥujurāt"],
	[50, "ق", "Qaf", "Qāf"],
	[51, "الذاريات", "Adh-Dhariyat", "al-Dhāriyāt"],
	[52, "الطور", "At-Tur", "al-Ṭūr"],
	[53, "النجم", "An-Najm", "al-Najm"],
	[54, "القمر", "Al-Qamar", "al-Qamar"],
	[55, "الرحمن", "Ar-Rahman", "al-Raḥmān"],
	[56, "الواقعة", "Al-Waqi'ah", "al-Wāqiʿa"],
	[57, "الحديد", "Al-Hadid", "al-Ḥadīd"],
	[58, "المجادلة", "Al-Mujadila", "al-Mujādala"],
	[59, "الحشر", "Al-Hashr", "al-Ḥashr"],
	[60, "الممتحنة", "Al-Mumtahanah", "al-Mumtaḥana"],
	[61, "الصف", "As-Saf", "al-Ṣaff"],
	[62, "الجمعة", "Al-Jumu'ah", "al-Jumuʿa"],
	[63, "المنافقون", "Al-Munafiqun", "al-Munāfiqūn"],
	[64, "التغابن", "At-Taghabun", "al-Taghābun"],
	[65, "الطلاق", "At-Talaq", "al-Ṭalāq"],
	[66, "التحريم", "At-Tahrim", "al-Taḥrīm"],
	[67, "الملك", "Al-Mulk", "al-Mulk"],
	[68, "القلم", "Al-Qalam", "al-Qalam"],
	[69, "الحاقة", "Al-Haqqah", "al-Ḥāqqa"],
	[70, "المعارج", "Al-Ma'arij", "al-Maʿārij"],
	[71, "نوح", "Nuh", "Nūḥ"],
	[72, "الجن", "Al-Jinn", "al-Jinn"],
	[73, "المزمل", "Al-Muzzammil", "al-Muzzammil"],
	[74, "المدثر", "Al-Muddaththir", "al-Muddaththir"],
	[75, "القيامة", "Al-Qiyamah", "al-Qiyāma"],
	[76, "الإنسان", "Al-Insan", "al-Insān"],
	[77, "المرسلات", "Al-Mursalat", "al-Mursalāt"],
	[78, "النبأ", "An-Naba", "al-Nabaʾ"],
	[79, "النازعات", "An-Nazi'at", "al-Nāziʿāt"],
	[80, "عبس", "'Abasa", "ʿAbasa"],
	[81, "التكوير", "At-Takwir", "al-Takwīr"],
	[82, "الانفطار", "Al-Infitar", "al-Infiṭār"],
	[83, "المطففين", "Al-Mutaffifin", "al-Muṭaffifīn"],
	[84, "الانشقاق", "Al-Inshiqaq", "al-Inshiqāq"],
	[85, "البروج", "Al-Buruj", "al-Burūj"],
	[86, "الطارق", "At-Tariq", "al-Ṭāriq"],
	[87, "الأعلى", "Al-A'la", "al-Aʿlā"],
	[88, "الغاشية", "Al-Ghashiyah", "al-Ghāshiya"],
	[89, "الفجر", "Al-Fajr", "al-Fajr"],
	[90, "البلد", "Al-Balad", "al-Balad"],
	[91, "الشمس", "Ash-Shams", "al-Shams"],
	[92, "الليل", "Al-Layl", "al-Layl"],
	[93, "الضحى", "Ad-Duhaa", "al-Ḍuḥā"],
	[94, "الشرح", "Ash-Sharh", "al-Sharḥ"],
	[95, "التين", "At-Tin", "al-Tīn"],
	[96, "العلق", "Al-'Alaq", "al-ʿAlaq"],
	[97, "القدر", "Al-Qadr", "al-Qadr"],
	[98, "البينة", "Al-Bayyinah", "al-Bayyina"],
	[99, "الزلزلة", "Az-Zalzalah", "al-Zalzala"],
	[100, "العاديات", "Al-'Adiyat", "al-ʿĀdiyāt"],
	[101, "القارعة", "Al-Qari'ah", "al-Qāriʿa"],
	[102, "التكاثر", "At-Takathur", "al-Takāthur"],
	[103, "العصر", "Al-'Asr", "al-ʿAṣr"],
	[104, "الهمزة", "Al-Humazah", "al-Humaza"],
	[105, "الفيل", "Al-Fil", "al-Fīl"],
	[106, "قريش", "Quraysh", "Quraysh"],
	[107, "الماعون", "Al-Ma'un", "al-Māʿūn"],
	[108, "الكوثر", "Al-Kawthar", "al-Kawthar"],
	[109, "الكافرون", "Al-Kafirun", "al-Kāfirūn"],
	[110, "النصر", "An-Nasr", "al-Naṣr"],
	[111, "المسد", "Al-Masad", "al-Masad"],
	[112, "الإخلاص", "Al-Ikhlas", "al-Ikhlāṣ"],
	[113, "الفلق", "Al-Falaq", "al-Falaq"],
	[114, "الناس", "An-Nas", "al-Nās"],
];

export const SURAHS: Surah[] = ROWS.map(([number, arabic, common, strict]) => ({ number, arabic, common, strict }));

const BY_NUMBER = new Map<number, Surah>(SURAHS.map((surah) => [surah.number, surah]));

/** The sūra with this number, or `null` outside 1–114. */
export function surah(n: number): Surah | null {
	return BY_NUMBER.get(n) ?? null;
}

/** `024` / `24` / `٢٤` → 24 (or `null` when not a sūra number). */
export function parseSurahNumber(value: string | number): number | null {
	const n = typeof value === "number" ? value : Number(value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
	if (!Number.isInteger(n) || n < 1 || n > SURAHS.length) return null;
	return n;
}
