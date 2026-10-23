import { App, normalizePath, TFile } from "obsidian";

export const SOURCE_REGISTRY = ".midad-arabic-sources/sources.json";

export type SourceRegistryKind =
	| "repo-work"
	| "repo-unit"
	| "zotero-item"
	| "transcription"
	| "translation"
	| "adopted"
	| "note";

export interface SourceRegistryEntry {
	masId: string;
	kind: SourceRegistryKind;
	title: string;
	path: string;
	source: string;
	workKey?: string;
	unitKey?: string;
	status?: string;
}

export interface SourceRegistryFile {
	schema: 1;
	sources: Record<string, SourceRegistryEntry>;
}

export interface RegistryPaths {
	installedRoot: string;
	transcriptions: string;
	translations: string;
	manifest: string;
	adopted: string;
}

interface ManifestWork {
	key?: string;
	dir?: string;
	title?: string;
	name?: string;
	status?: string;
}

interface AdoptedEntry {
	path?: string;
	workKey?: string;
	unitKey?: string;
	workTitle?: string;
	unitTitle?: string;
	sourceKey?: string;
	kind?: string;
}

function stringField(frontmatter: Record<string, unknown> | undefined, key: string): string {
	const value = frontmatter?.[key];
	return typeof value === "string" ? value.trim() : "";
}

function sourceKind(value: string): SourceRegistryKind {
	return value === "repo-work" || value === "repo-unit" || value === "zotero-item" || value === "transcription"
		|| value === "translation" || value === "adopted" || value === "note"
		? value
		: "note";
}

/** Build one index over every source kind the plugin manages. */
export async function buildSourceRegistry(app: App, paths: RegistryPaths): Promise<SourceRegistryFile> {
	const entries = new Map<string, SourceRegistryEntry>();
	const add = (entry: SourceRegistryEntry): void => {
		if (!entry.masId || !entry.path) return;
		const existing = entries.get(entry.masId);
		if (!existing || existing.kind === "note") entries.set(entry.masId, entry);
	};

	const indexed = (path: string) => !path.startsWith(`${app.vault.configDir}/`)
		&& !path.startsWith(".midad-arabic-sources/")
		&& !path.startsWith("tmp/")
		&& !path.startsWith("src/")
		&& !path.startsWith("AI OS/");

	// Notes that already carry a mas-id (repo hubs, new transcriptions,
	// translations, adopted notes, and any user note adopted into the system).
	for (const file of app.vault.getMarkdownFiles().filter((f) => indexed(f.path))) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const masId = stringField(frontmatter, "mas-id");
		if (!masId) continue;
		add({
			masId,
			kind: sourceKind(stringField(frontmatter, "mas-kind")),
			title: stringField(frontmatter, "title") || file.basename,
			path: file.path,
			source: stringField(frontmatter, "mas-source"),
			workKey: stringField(frontmatter, "mas-work") || undefined,
			unitKey: stringField(frontmatter, "mas-unit") || undefined,
			status: stringField(frontmatter, "status") || undefined,
		});
	}

	// Repository works: the manifest remains the acquisition record, while the
	// registry gives every work a type-independent identity.
	try {
		const manifest = JSON.parse(await app.vault.adapter.read(normalizePath(paths.manifest))) as { works?: ManifestWork[] };
		for (const work of manifest.works ?? []) {
			const key = String(work.key ?? "").trim();
			const dir = String(work.dir ?? "").trim();
			if (!key || !dir) continue;
			add({
				masId: `repo:${key}`,
				kind: "repo-work",
				title: String(work.title ?? work.name ?? dir),
				path: normalizePath(`${paths.installedRoot}/${dir}.md`),
				source: `repo:${key}`,
				workKey: key,
				unitKey: "hub",
				status: String(work.status ?? "installed"),
			});
		}
	} catch { /* no manifest yet */ }

	// Zotero literature notes: the stable Zotero item id is the natural mas-id.
	for (const file of app.vault.getMarkdownFiles().filter((f) => indexed(f.path))) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const zoteroId = stringField(frontmatter, "sw-zotero-id");
		if (!zoteroId) continue;
		const citekey = file.basename.startsWith("@") ? file.basename.slice(1) : file.basename;
		add({
			masId: `zotero:${zoteroId}`,
			kind: "zotero-item",
			title: stringField(frontmatter, "title") || file.basename,
			path: file.path,
			source: `zotero:@${citekey}`,
			workKey: `zotero:${zoteroId}`,
			unitKey: "note",
			status: "installed",
		});
	}

	// Adopted-note registry: older entries may predate the mas-id property.
	try {
		const adopted = JSON.parse(await app.vault.adapter.read(normalizePath(paths.adopted))) as { notes?: Record<string, AdoptedEntry> };
		for (const [path, entry] of Object.entries(adopted.notes ?? {})) {
			const file = app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) continue;
			const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const masId = stringField(frontmatter, "mas-id") || `note:${entry.workKey || path}`;
			add({
				masId,
				kind: sourceKind(stringField(frontmatter, "mas-kind") || String(entry.kind ?? "adopted")),
				title: String(entry.workTitle ?? entry.unitTitle ?? file.basename),
				path: file.path,
				source: String(entry.sourceKey ?? "adopted"),
				workKey: entry.workKey,
				unitKey: entry.unitKey,
			});
		}
	} catch { /* no adopted registry yet */ }

	const sources: Record<string, SourceRegistryEntry> = {};
	for (const key of [...entries.keys()].sort((a, b) => a.localeCompare(b))) {
		const entry = entries.get(key);
		if (entry) sources[key] = entry;
	}
	return { schema: 1, sources };
}

export async function writeSourceRegistry(app: App, registry: SourceRegistryFile): Promise<void> {
	const path = normalizePath(SOURCE_REGISTRY);
	const parent = path.split("/").slice(0, -1).join("/");
	if (parent && !(await app.vault.adapter.exists(parent))) await app.vault.adapter.mkdir(parent);
	await app.vault.adapter.write(path, JSON.stringify(registry, null, 2) + "\n");
}
