/** YAML-facing source keys use `/` so Obsidian does not treat `repo:`, `hadith:`,
 * and similar internal identifiers as URL protocols. Code-facing keys keep `:`. */
function textValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export function sourceIdFromYaml(value: unknown): string {
	return textValue(value).replace(/\//g, ":");
}

export function sourceIdToYaml(value: unknown): string {
	return textValue(value).replace(/:/g, "/");
}

/**
 * The source a note belongs to, for the registry and the index lists.
 *
 * `midad-source` is no longer written to YAML: on a repo hub it was identical to
 * `midad-id`, and on a transcription it was the prefix of `midad-work`. Derive
 * it instead — a repo work is its own source, a transcription/translation's
 * source is its `midad-work` without the trailing `:<kind>`, and an adopted
 * note's source is "adopted". Notes rendered before the change still carry the
 * property, which wins. The result keeps the code-facing `:` form.
 */
export function sourceOfFrontmatter(frontmatter: Record<string, unknown> | undefined): string {
	const explicit = sourceIdFromYaml(frontmatter?.["midad-source"]);
	if (explicit) return explicit;
	const kind = textValue(frontmatter?.["midad-kind"]).trim();
	const id = sourceIdFromYaml(frontmatter?.["midad-id"]);
	if (kind === "repo-work") return id;
	if (kind === "adopted") return "adopted";
	const work = sourceIdFromYaml(frontmatter?.["midad-work"]);
	if (!work) return id;
	const suffix = kind ? `:${kind}` : "";
	return suffix && work.endsWith(suffix) ? work.slice(0, -suffix.length) : work;
}
