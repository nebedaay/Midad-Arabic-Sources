import * as fs from "fs";
import { strFromU8, unzipSync } from "fflate";
import { normalizePath } from "obsidian";
import { hashString } from "./sourceImport/history";
import { findManagedRegion, splitNote } from "./sourceImport/merge";

const HASHES_REL = ".midad-arabic-sources/note-hashes.json";
const OLD_BASELINES_REL = ".midad-arabic-sources/note-baselines.json";
const VERSIONS_REL = ".midad-arabic-sources/source-versions.zip";

export interface NoteHashRecord {
	baseline?: string;
	versions?: Record<string, string>;
}

interface NoteHashIndex {
	schema: 1;
	notes: Record<string, NoteHashRecord>;
}

/** Hash only the managed region, falling back to the body for unmanaged notes. */
export function managedHash(text: string): string {
	const prior = splitNote(text);
	const region = findManagedRegion(prior.body);
	return hashString(region ? prior.body.slice(region.start, region.end) : prior.body);
}

/**
 * The single authority for baseline and saved-version hashes. Snapshot blobs
 * stay in the version ZIP; only hashes and their note associations live here.
 */
export class NoteHashStore {
	private static readonly instances = new Map<string, NoteHashStore>();
	private readonly vaultPath: string;
	private index: NoteHashIndex | null = null;

	constructor(vaultPath: string) {
		this.vaultPath = vaultPath;
	}

	static forVault(vaultPath: string): NoteHashStore {
		const key = `${vaultPath}`;
		let store = NoteHashStore.instances.get(key);
		if (!store) {
			store = new NoteHashStore(vaultPath);
			NoteHashStore.instances.set(key, store);
		}
		return store;
	}

	private filePath(): string {
		return `${this.vaultPath}/${HASHES_REL}`;
	}

	private load(): NoteHashIndex {
		if (this.index) return this.index;
		try {
			const raw = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as NoteHashIndex;
			this.index = { schema: 1, notes: raw.notes ?? {} };
		} catch {
			this.index = this.migrate();
		}
		return this.index;
	}

	private migrate(): NoteHashIndex {
		const notes: Record<string, NoteHashRecord> = {};
		try {
			const raw = JSON.parse(fs.readFileSync(`${this.vaultPath}/${OLD_BASELINES_REL}`, "utf8")) as {
				notes?: Record<string, string>;
			};
			for (const [path, hash] of Object.entries(raw.notes ?? {})) {
				const key = normalizePath(path);
				notes[key] = { ...(notes[key] ?? {}), baseline: hash };
			}
		} catch { /* no legacy baselines */ }
		try {
			const raw = fs.readFileSync(`${this.vaultPath}/${VERSIONS_REL}`);
			const files = unzipSync(new Uint8Array(raw));
			const manifest = files["manifest.json"];
			if (manifest) {
				const parsed = JSON.parse(strFromU8(manifest)) as {
					notes?: Record<string, { path?: string; versions?: Array<{ id?: string; hash?: string }> }>;
				};
				for (const entry of Object.values(parsed.notes ?? {})) {
					if (!entry.path) continue;
					const key = normalizePath(entry.path);
					const versions: Record<string, string> = { ...(notes[key]?.versions ?? {}) };
					for (const version of entry.versions ?? []) {
						if (version.id && version.hash) versions[version.id] = version.hash;
					}
					notes[key] = { ...(notes[key] ?? {}), versions };
				}
			}
		} catch { /* no legacy version store */ }
		const index: NoteHashIndex = { schema: 1, notes };
		this.index = index;
		this.save();
		return index;
	}

	private save(): void {
		const index = this.load();
		const file = this.filePath();
		const dir = file.slice(0, file.lastIndexOf("/"));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(index, null, 1)}\n`);
	}

	private record(path: string, create = false): NoteHashRecord | null {
		const index = this.load();
		const key = normalizePath(path);
		let value = index.notes[key];
		if (!value && create) {
			value = {};
			index.notes[key] = value;
		}
		return value ?? null;
	}

	baseline(path: string): string | undefined {
		return this.record(path)?.baseline;
	}

	setBaseline(path: string, hash: string): void {
		const value = this.record(path, true);
		if (!value || value.baseline === hash) return;
		value.baseline = hash;
		this.save();
	}

	setBaselines(values: Record<string, string>): void {
		const index = this.load();
		let changed = false;
		for (const [path, hash] of Object.entries(values)) {
			const key = normalizePath(path);
			const record = index.notes[key] ?? (index.notes[key] = {});
			if (record.baseline !== hash) {
				record.baseline = hash;
				changed = true;
			}
		}
		if (changed) this.save();
	}

	versionHash(path: string, id: string): string | undefined {
		return this.record(path)?.versions?.[id];
	}

	setVersionHash(path: string, id: string, hash: string): void {
		const index = this.load();
		const key = normalizePath(path);
		const record = index.notes[key] ?? (index.notes[key] = {});
		record.versions ??= {};
		if (record.versions[id] === hash) return;
		record.versions[id] = hash;
		this.save();
	}

	deleteNote(path: string): void {
		const index = this.load();
		const key = normalizePath(path);
		if (!(key in index.notes)) return;
		delete index.notes[key];
		this.save();
	}

	deleteVersionHash(path: string, id: string): void {
		const index = this.load();
		const key = normalizePath(path);
		const record = index.notes[key];
		if (!record?.versions || !(id in record.versions)) return;
		delete record.versions[id];
		this.save();
	}

	renamePath(from: string, to: string): void {
		const index = this.load();
		const oldKey = normalizePath(from);
		const newKey = normalizePath(to);
		if (oldKey === newKey || !index.notes[oldKey]) return;
		index.notes[newKey] = { ...(index.notes[newKey] ?? {}), ...index.notes[oldKey] };
		delete index.notes[oldKey];
		this.save();
	}

	/** Drop records whose notes no longer exist and have no saved versions. */
	pruneMissing(keep: Set<string>): number {
		const index = this.load();
		let removed = 0;
		for (const path of Object.keys(index.notes)) {
			if (keep.has(normalizePath(path))) continue;
			delete index.notes[path];
			removed += 1;
		}
		if (removed) this.save();
		return removed;
	}

	allBaselines(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [path, record] of Object.entries(this.load().notes)) {
			if (record.baseline) out[path] = record.baseline;
		}
		return out;
	}
}
