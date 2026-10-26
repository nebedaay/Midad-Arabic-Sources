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
