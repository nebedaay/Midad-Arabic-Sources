import topicData from "../midad-arabic-sources-import-templates/topics.json";

interface TopicData {
	topics: string[];
	aliases: Record<string, string>;
	legacyGenreAliases: Record<string, string>;
	genres: Record<string, string>;
	turathTypes: Record<string, string>;
	turathCategories: Record<string, string[]>;
	turathCatGenres: Record<string, string[]>;
}

export const TOPIC_PAGE_PREFIX = "Midad topic - ";

const DATA = topicData as TopicData;

export const BUILTIN_TOPICS: string[] = DATA.topics;
export const TOPIC_ALIASES: Record<string, string> = DATA.aliases;
export const GENRE_TOPICS: Record<string, string> = DATA.genres;
export const GENRE_ALIASES: Record<string, string> = DATA.legacyGenreAliases;

/** Case- and diacritic-insensitive key used to match topic aliases. */
function topicKey(value: unknown): string {
	let text = typeof value === "string" ? value.trim() : "";
	if (text.startsWith("[[") && text.endsWith("]]")) {
		text = text.slice(2, -2).split("|", 1)[0];
	}
	while (text.startsWith(TOPIC_PAGE_PREFIX)) text = text.slice(TOPIC_PAGE_PREFIX.length);
	while (text.endsWith(" Sources")) text = text.slice(0, -" Sources".length);
	text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u064B-\u065F\u0670]/g, "");
	text = text.replace(/[ʿʾ'’`]/g, "").toLowerCase();
	return text.replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
}

const ALIAS_BY_KEY = new Map(Object.entries(TOPIC_ALIASES).map(([key, value]) => [topicKey(key), value]));
const CANONICAL_BY_KEY = new Map(BUILTIN_TOPICS.map((value) => [topicKey(value), value]));

/** Normalize a source genre key to its canonical key. */
export function normalizeGenre(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	return GENRE_ALIASES[text] ?? text;
}

/** The topic label for a source genre. */
export function genreTopic(value: unknown): string {
	return GENRE_TOPICS[normalizeGenre(value)] || "Other";
}

/** The genre keys a Turath category contributes, or the broad type. */
export function turathGenres(category: number, fallback: string): string[] {
	return DATA.turathCatGenres[String(category)] ?? [fallback];
}

/** The topics a Turath category contributes. */
export function turathTopics(category: number): string[] {
	return DATA.turathCategories[String(category)] ?? [];
}

export function turathTypeTopic(type: string): string {
	return DATA.turathTypes[type] ?? genreTopic(type);
}


function plainTopicValue(value: unknown): string {
	let text = typeof value === "string" ? value.trim() : "";
	if (text.startsWith("[[") && text.endsWith("]]")) {
		text = text.slice(2, -2);
		const pipe = text.indexOf("|");
		if (pipe >= 0) text = text.slice(0, pipe);
	}
	text = text.trim();
	const key = topicKey(text);
	return ALIAS_BY_KEY.get(key) ?? CANONICAL_BY_KEY.get(key) ?? text;
}

export function topicLabel(value: unknown): string {
	return plainTopicValue(value);
}

export function topicNoteName(value: unknown): string {
	return `${TOPIC_PAGE_PREFIX}${topicLabel(value)}`;
}

export function topicLink(value: unknown): string {
	const label = topicLabel(value);
	return `[[${TOPIC_PAGE_PREFIX}${label}|${label}]]`;
}

/** The link target alone, for duplicate detection. */
export function topicLinkTarget(value: unknown): string {
	return `[[${topicNoteName(value)}]]`;
}

/** Normalize a frontmatter `topics:` value (string or list) into short labels. */
export function topicsFromValue(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const out: string[] = [];
	for (const item of values) {
		const label = topicLabel(item);
		if (label && !out.includes(label)) out.push(label);
	}
	return out;
}
