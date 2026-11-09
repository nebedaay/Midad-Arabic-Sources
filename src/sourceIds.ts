/** YAML-facing source keys use `/` so Obsidian does not treat `repo:`,
 * hadith:`, and similar internal identifiers as URL protocols. Code-facing
 * keys keep `:`. */
function textValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export function sourceIdFromYaml(value: unknown): string {
	return textValue(value).trim().replace(/\//g, ":");
}

export function sourceIdToYaml(value: unknown): string {
	return textValue(value).trim().replace(/:/g, "/");
}

export type MidadKind =
	| "repo-work"
	| "repo-unit"
	| "zotero-item"
	| "transcription"
	| "translation"
	| "adopted"
	| "note";

/** A midad-id parsed into the parts the plugin used to store separately.
 *
 * The id is the single source of truth. Its grammar is:
 *
 *   repo/<collection>/<work-id>                         repository work hub
 *   zotero/<zotero-id>/<transcription|translation>[/<unit>]
 *   pdf/<pdf-key>/<transcription|translation>[/<unit>]
 *   adopted/<uuid>                                      arbitrary adopted note
 *
 * For a transcription/translation the work is the id through the document
 * type; a missing trailing segment is the whole work (`unit = note`), and
 * `vol.<n>` or a slug is a unit. Repository content notes may eventually carry
 * `repo/<collection>/<work-id>/<unit-kind>/<slug>`; the parser accepts it as a
 * `repo-unit` without changing any current notes.
 */
export interface MidadIdentity {
	/** YAML form, all `/`. */
	yamlId: string;
	/** Internal form, all `:`. */
	id: string;
	kind: MidadKind;
	/** Internal work key (the part before the unit). */
	work: string;
	/** `note`, `vol.<n>`, or a unit slug. */
	unit: string;
	/** The source a note belongs to: repo work, Zotero/PDF key, or `adopted`. */
	source: string;
}

export function parseMidadId(value: unknown): MidadIdentity | null {
	const raw = textValue(value).trim();
	if (!raw) return null;
	const yamlId = raw.replace(/:/g, "/").replace(/^\/+|\/+$/g, "");
	if (!yamlId) return null;
	const parts = yamlId.split("/").filter(Boolean);
	if (!parts.length) return null;
	const id = yamlId.replace(/\//g, ":");
	let kind: MidadKind = "note";
	let work = id;
	let unit = "note";

	if (parts[0] === "repo") {
		// The hub is `repo/<collection>/<work-id>`. A fourth part begins a
		// repository unit; current rendered source units have no midad-id.
		kind = parts.length > 3 ? "repo-unit" : "repo-work";
		// The annotation layer and manifest key a repo work by `collection:id`
		// (without the `repo/` prefix).
		work = parts.slice(1, 3).join(":");
		unit = parts.length > 3 ? parts.slice(3).join("/") : "";
	} else if (parts[0] === "zotero" || parts[0] === "pdf") {
		const index = parts.findIndex((part, i) => i > 0 && (part === "transcription" || part === "translation"));
		if (index > 0) {
			kind = parts[index] as "transcription" | "translation";
			work = parts.slice(0, index + 1).join("/").replace(/\//g, ":");
			unit = parts.slice(index + 1).join("/") || "note";
		} else {
			kind = parts[0] === "zotero" ? "zotero-item" : "note";
		}
	} else if (parts[0] === "adopted" || parts[0] === "note") {
		kind = "adopted";
	}

	const source = kind === "repo-work" || kind === "repo-unit" || kind === "zotero-item" || kind === "note"
		? id
		: kind === "adopted"
			? "adopted"
			: work.slice(0, -(`:${kind}`.length));
	return { yamlId, id, kind, work, unit, source };
}

/** Identity from frontmatter, with the retired separate keys as a fallback for
 * notes written before the id became comprehensive. */
export function identityOfFrontmatter(frontmatter: Record<string, unknown> | undefined): MidadIdentity | null {
	const parsed = parseMidadId(frontmatter?.["midad-id"]);
	const legacyKind = textValue(frontmatter?.["midad-kind"]).trim();
	const legacyWork = textValue(frontmatter?.["midad-work"]).replace(/\//g, ":").trim();
	const legacyUnit = textValue(frontmatter?.["midad-unit"]).trim();
	if (!parsed) return null;
	if (parsed.kind === "note" && legacyKind) {
		parsed.kind = legacyKind === "repo-work" || legacyKind === "repo-unit" || legacyKind === "zotero-item"
			|| legacyKind === "transcription" || legacyKind === "translation" || legacyKind === "adopted"
			? legacyKind
			: "note";
	}
	if (!parsed.work && legacyWork) parsed.work = legacyWork;
	if (parsed.unit === "note" && legacyUnit && legacyUnit !== "note") {
		parsed.unit = legacyUnit;
		parsed.yamlId = `${parsed.yamlId}/${legacyUnit}`;
		parsed.id = parsed.yamlId.replace(/\//g, ":");
	}
	return parsed;
}

/**
 * The source a note belongs to, for the registry and the index lists.
 *
 * `midad-source` is no longer written to YAML. A repo work is its own source,
 * a transcription/translation's source is its work without the trailing
 * document type, and an adopted note's source is "adopted". Notes rendered
 * before the change still carry the retired keys, which are honoured as a
 * fallback.
 */
export function sourceOfFrontmatter(frontmatter: Record<string, unknown> | undefined): string {
	const explicit = sourceIdFromYaml(frontmatter?.["midad-source"]);
	if (explicit) return explicit;
	const identity = identityOfFrontmatter(frontmatter);
	if (identity) return identity.source;
	const kind = textValue(frontmatter?.["midad-kind"]).trim();
	const work = sourceIdFromYaml(frontmatter?.["midad-work"]);
	const id = sourceIdFromYaml(frontmatter?.["midad-id"]);
	if (kind === "repo-work") return id;
	if (kind === "adopted") return "adopted";
	if (!work) return id;
	const suffix = kind ? `:${kind}` : "";
	return suffix && work.endsWith(suffix) ? work.slice(0, -suffix.length) : work;
}
