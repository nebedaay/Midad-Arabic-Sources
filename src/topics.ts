/**
 * Topic MOC naming.
 *
 * A topic's display name is the short scholarly label (`Ḥadīth`, `Tafsīr`,
 * `Sufism (taṣawwuf)`). Its note is `Midad topic - <label>` so a topic page never
 * collides with a user note on the same subject. Links carry the short label as
 * their alias: `[[Midad topic - Ḥadīth|Ḥadīth]]`.
 *
 * Older vaults named pages `<label> Sources` (`Tafsīr Sources`, `Ḥadīth Sources`,
 * …). `topicLabel` maps both shapes to the same short label, so generated notes
 * and user-added topics can coexist during the migration.
 */
export const TOPIC_PAGE_PREFIX = "Midad topic - ";

/** Topics the built-in repositories can classify a work under. */
export const BUILTIN_TOPICS = [
	"Tafsīr",
	"Ḥadīth",
	"Fiqh",
	"Uṣūl al-Fiqh",
	"ʿAqīda",
	"Tārīkh",
	"Language",
	"ʿUlūm al-Qurʾān",
	"Dictionaries",
	"Qurʾān text and translations",
];

function plainTopicValue(value: unknown): string {
	let text = typeof value === "string" ? value.trim() : "";
	if (text.startsWith("[[") && text.endsWith("]]")) {
		text = text.slice(2, -2);
		const pipe = text.indexOf("|");
		if (pipe >= 0) text = text.slice(0, pipe);
	}
	if (text.startsWith(TOPIC_PAGE_PREFIX)) text = text.slice(TOPIC_PAGE_PREFIX.length);
	if (text === "Qurʾān (text)" || text === "Qurʾān Translations") return "Qurʾān text and translations";
	if (text.endsWith(" Sources")) text = text.slice(0, -" Sources".length);
	return text.trim();
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
