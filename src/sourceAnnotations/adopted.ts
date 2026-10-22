import { App, TFile, normalizePath } from "obsidian";

export const ADOPTED_REGISTRY = ".midad-arabic-sources/annotations/adopted.json";
export const ADOPTED_BIBLIOGRAPHIC_ROOT = "_2 Bibliographic notes/";

export type AdoptedKind = "transcription" | "translation" | "note";

export interface AdoptedEntry {
	path: string;
	workKey: string;
	unitKey: string;
	workTitle: string;
	/** A real note basename used for the annotation note's `mas-up` link. */
	workDir: string;
	unitTitle: string;
	ord: number;
	kind: AdoptedKind;
	sourceKey: string;
}

interface AdoptedFile {
	schema: 1;
	notes: Record<string, AdoptedEntry>;
}

function safeSegment(value: string): string {
	return value.replace(/[\\/:*?"<>|#^]/g, "-").replace(/\s+/g, " ").trim() || "note";
}

function uuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID().replace(/-/g, "");
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function newAdoptedNoteKey(): string {
	return `note:${uuid()}`;
}

function baseName(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

/** `@citekey - transcription - v. 4 - Gemini` → its parts. */
function parseKnownNote(path: string, title?: string): {
	kind: AdoptedKind;
	sourceKey: string;
	unitKey: string;
	unitTitle: string;
	ord: number;
	workTitle: string;
	hasTitle: boolean;
} | null {
	const name = baseName(path);
	const match = /^(@[^ ]+)\s+-\s+(transcription|translation)(?:\s+-\s+(?:v(?:ol)?\.?|volume)\s*(\d+))?(?:\s+-\s+(.+))?$/i.exec(name);
	if (!match) return null;
	const cite = match[1];
	const kind = match[2].toLowerCase() as "transcription" | "translation";
	const volume = match[3] ? Number(match[3]) : 0;
	const variant = (match[4] ?? "").trim();
	const label = kind === "translation" ? "Translation" : "Transcription";
	const baseTitle = (title && title.trim()) || cite.replace(/^@/, "");
	const unitKey = volume
		? `volume:${volume}${variant ? `:${safeSegment(variant)}` : ""}`
		: variant ? `note:${safeSegment(variant)}` : "note";
	const unitTitle = volume
		? `Volume ${volume}${variant ? ` — ${variant}` : ""}`
		: variant || "Note";
	return {
		kind,
		sourceKey: `${kind}:${cite}`,
		unitKey,
		unitTitle,
		ord: volume,
		workTitle: `${label} - ${baseTitle}`,
		hasTitle: !!title,
	};
}

/**
 * The hidden registry of notes known to have been produced by Midad's
 * transcription/translation pipeline. It deliberately lives outside the notes:
 * no filename or YAML changes are needed, and a stable work key survives a
 * rename. A missing registry can be rebuilt from the known path patterns.
 */
export class AdoptedNotesRegistry {
	private readonly app: App;
	private entries = new Map<string, AdoptedEntry>();
	private loaded = false;

	constructor(app: App) {
		this.app = app;
	}

	async load(): Promise<void> {
		this.entries.clear();
		try {
			const path = normalizePath(ADOPTED_REGISTRY);
			if (await this.app.vault.adapter.exists(path)) {
				const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as AdoptedFile;
				for (const [key, entry] of Object.entries(parsed.notes ?? {})) {
					if (!entry || !entry.workKey || !entry.unitKey) continue;
					this.entries.set(normalizePath(key), { ...entry, path: normalizePath(key) });
				}
			}
		} catch { /* rebuild below */ }
		this.loaded = true;
	}

	async save(): Promise<void> {
		const path = normalizePath(ADOPTED_REGISTRY);
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent && !(await this.app.vault.adapter.exists(parent))) {
			await this.app.vault.adapter.mkdir(parent);
		}
		const notes: Record<string, AdoptedEntry> = {};
		for (const [key, entry] of this.entries) notes[key] = { ...entry, path: key };
		await this.app.vault.adapter.write(path, JSON.stringify({ schema: 1, notes }, null, 2) + "\n");
	}

	has(path: string): boolean {
		return this.entries.has(normalizePath(path));
	}

	get(path: string): AdoptedEntry | null {
		return this.entries.get(normalizePath(path)) ?? null;
	}

	all(): AdoptedEntry[] {
		return [...this.entries.values()];
	}

	private workFor(sourceKey: string, workTitle = ""): AdoptedEntry | null {
		const bySource = [...this.entries.values()].find((entry) => entry.sourceKey === sourceKey);
		if (bySource) return bySource;
		return workTitle
			? [...this.entries.values()].find((entry) => !entry.sourceKey && entry.workTitle === workTitle) ?? null
			: null;
	}

	private async registerFile(file: TFile): Promise<boolean> {
		const path = normalizePath(file.path);
		if (this.entries.has(path)) return false;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const title = typeof frontmatter?.title === "string" ? frontmatter.title : "";
		const parsed = parseKnownNote(path, title);
		if (!parsed) return false;
		const existing = this.workFor(parsed.sourceKey, parsed.workTitle);
		// A note renamed while the plugin was closed leaves its old path entry
		// behind; replace it instead of creating a second unit for the same volume.
		const duplicate = [...this.entries.values()].find((entry) =>
			entry.sourceKey === parsed.sourceKey && entry.unitKey === parsed.unitKey
		);
		if (duplicate) {
			const oldPath = duplicate.path;
			this.entries.delete(oldPath);
			duplicate.path = path;
			if (duplicate.workDir === baseName(oldPath)) duplicate.workDir = baseName(path);
			this.entries.set(path, duplicate);
			return true;
		}
		const workKey = existing?.workKey ?? `adopted:${uuid()}`;
		// A hub note carries the book title; a volume scanned first only has the
		// citekey. Prefer the title-bearing note and use the hub as the mas-up link.
		const isHub = !parsed.unitKey.startsWith("volume:");
		const workTitle = existing && !parsed.hasTitle ? existing.workTitle : parsed.workTitle;
		const workDir = existing
			? (isHub && parsed.hasTitle ? baseName(path) : existing.workDir)
			: baseName(path);
		if (existing) {
			for (const entry of this.entries.values()) {
				if (entry.workKey !== workKey) continue;
				entry.workTitle = workTitle;
				if (isHub && parsed.hasTitle) entry.workDir = workDir;
			}
		}
		const entry: AdoptedEntry = {
			path,
			workKey,
			unitKey: parsed.unitKey,
			workTitle,
			workDir,
			unitTitle: parsed.unitTitle,
			ord: parsed.ord,
			kind: parsed.kind,
			sourceKey: parsed.sourceKey,
		};
		this.entries.set(path, entry);
		return true;
	}

	/** Rebuild registry entries for already-annotated works when the file is lost. */
	async restoreFromStore(
		workKey: string,
		workTitle: string,
		workDir: string,
		units: Array<{ path: string; unitKey: string; ord: number }>
	): Promise<boolean> {
		let changed = false;
		for (const unit of units) {
			const path = normalizePath(unit.path);
			if (!path || this.entries.has(path)) continue;
			this.entries.set(path, {
				path,
				workKey,
				unitKey: unit.unitKey,
				workTitle,
				workDir,
				unitTitle: unit.unitKey,
				ord: unit.ord,
				kind: "note",
				sourceKey: "",
			});
			changed = true;
		}
		return changed;
	}

	/** Register all transcription/translation notes Midad already produced. */
	async scanKnownNotes(): Promise<boolean> {
		if (!this.loaded) await this.load();
		let changed = false;
		for (const file of this.app.vault.getMarkdownFiles()) {
			// Scan the whole vault, not only the pipeline's usual folder, so a note
			// moved while Obsidian was closed is still recognised by its filename.
			try {
				if (await this.registerFile(file)) changed = true;
			} catch { /* skip unreadable notes */ }
		}
		if (changed) await this.save();
		return changed;
	}

	async registerNewFile(file: TFile): Promise<boolean> {
		const changed = await this.registerFile(file);
		if (changed) await this.save();
		return changed;
	}

	async rename(oldPath: string, newPath: string): Promise<boolean> {
		const oldKey = normalizePath(oldPath);
		const entry = this.entries.get(oldKey);
		if (!entry) return false;
		this.entries.delete(oldKey);
		const next = normalizePath(newPath);
		entry.path = next;
		if (entry.workDir === baseName(oldPath)) entry.workDir = baseName(next);
		this.entries.set(next, entry);
		await this.save();
		return true;
	}

	async remove(path: string): Promise<boolean> {
		const key = normalizePath(path);
		if (!this.entries.has(key)) return false;
		this.entries.delete(key);
		await this.save();
		return true;
	}
}
