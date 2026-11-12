import { App, Modal, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as fs from "fs";
import { hashString } from "./sourceImport/history";
import { ensureFolder, safeFileSegment } from "./sourcePaths";
import { NoteHashStore, managedHash } from "./noteHashes";
import { ensureManagedRegion, findManagedRegion, joinNote, normalizeManagedMarkerSpacing, splitNote } from "./sourceImport/merge";

export interface SavedVersion {
	id: string;
	label: string;
	kind: "source" | "user";
	savedAt: string;
	file: string;
	selected: boolean;
	archived: boolean;
}

export interface NoteVersionEntry {
	key: string;
	path: string;
	title: string;
	defaultId: string;
	virtualOriginal?: boolean;
	virtualSelected?: boolean;
	workKey?: string;
	renderHash?: string;
	versions: SavedVersion[];
}

interface VersionManifest {
	schema: 1;
	notes: Record<string, NoteVersionEntry>;
}

const EMPTY: VersionManifest = { schema: 1, notes: {} };
const LEGACY_STORE_REL = ".midad-arabic-sources/source-versions.zip";
const ARCHIVE_DIR = ".midad-arabic-sources/version-archives";

function versionNumber(id: string): number {
	const match = /^v(\d+)$/i.exec(id);
	return match ? Number(match[1]) : -1;
}

function versionLabel(version: SavedVersion): string {
	return version.label || `Version ${Math.max(0, versionNumber(version.id))}`;
}

function normalizedHash(text: string): string {
	// Versions track note content, not YAML changes. Use the managed region when
	// present; otherwise the whole body after frontmatter.
	return managedHash(text);
}



function noteKeyFromText(file: TFile, text: string): string {
	const match = /^midad-id:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(text);
	const id = match?.[1]?.trim() ?? "";
	return id ? `id:${id}` : `path:${file.path}`;
}

function workKeyFromKey(key: string): string {
	const raw = key.replace(/^(?:id|path):/, "");
	const match = /^(.*?\/(?:transcription|translation))(?=\/|$)/.exec(raw);
	return match ? match[1] : raw;
}

function workKeyFromText(file: TFile, text: string): string {
	const match = /^midad-id:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(text);
	return match ? workKeyFromKey(`id:${match[1].trim()}`) : `path:${file.path}`;
}

function workArchivePath(vaultPath: string, workKey: string): string {
	const name = `${safeFileSegment(workKey, "work", 80)}-${hashString(workKey)}.zip`;
	return `${vaultPath}/${ARCHIVE_DIR}/${name}`;
}

function versionFile(key: string, id: string): string {
	const hash = hashString(key);
	const folder = safeFileSegment(key.replace(/^[^:]+:/, ""), "note", 60);
	return `versions/${folder}-${hash}/${id}.md`;
}

function versionNotePath(entry: NoteVersionEntry, version: SavedVersion): string {
	const path = entry.path;
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	const stem = path.split("/").pop()?.replace(/\.md$/i, "") ?? entry.title;
	return normalizePath(`${folder}/${stem}.Version${versionNumber(version.id)}.md`);
}

function versionZeroNotePath(entry: NoteVersionEntry): string {
	return versionNotePath(entry, { id: "v0", label: "Original source", kind: "source", savedAt: "", file: "", selected: true, archived: false });
}

function versionLink(entry: NoteVersionEntry, version: SavedVersion): string {
	const path = version.id === entry.defaultId ? entry.path : versionNotePath(entry, version);
	const label = version.id === entry.defaultId ? "Default version" : versionLabel(version);
	return `[[${path.replace(/\.md$/, "")}|${label}]]`;
}

function versionReference(entry: NoteVersionEntry, version: SavedVersion): string {
	if (version.id === entry.defaultId || version.selected) {
		return versionLink(entry, version);
	}
	return versionLabel(version);
}

function otherVersionReferences(entry: NoteVersionEntry, excludeId?: string): string[] {
	const refs = entry.versions
		.filter((v) => v.id !== excludeId)
		.sort((a, b) => a.id === entry.defaultId ? -1 : b.id === entry.defaultId ? 1 : versionNumber(a.id) - versionNumber(b.id))
		.map((v) => versionReference(entry, v));
	if (entry.virtualOriginal && excludeId !== "v0" && !entry.versions.some((v) => v.id === "v0")) {
		refs.unshift(entry.virtualSelected
			? `[[${versionZeroNotePath(entry).replace(/\.md$/, "")}|Original source]]`
			: "Original source");
	}
	return refs;
}

function addUpLink(content: string, link: string): string {
	const match = /^midad-up:[ \t]*\n((?:[ \t]+-[^\n]*\n)*)/m.exec(content);
	if (!match) return content;
	if (match[1].includes(link)) return content;
	const insert = (match.index ?? 0) + match[0].length;
	return `${content.slice(0, insert)}  - "${link}"\n${content.slice(insert)}`;
}

function removeFrontmatterProperty(content: string, key: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return content;
	const front = content.slice(0, end);
	const body = content.slice(end);
	const re = new RegExp(`^${key}:[^\\n]*\\n(?:[ \\t]+-[^\\n]*\\n)*`, "gm");
	return front.replace(re, "") + body;
}

function stripVersionProperties(content: string): string {
	return removeFrontmatterProperty(removeFrontmatterProperty(content, "midad-version"), "midad-version-name");
}

function setFrontmatterProperty(content: string, key: string, value: string): string {
	const clean = removeFrontmatterProperty(content, key);
	const line = `${key}: ${value}`;
	if (clean.startsWith("---")) {
		const end = clean.indexOf("\n---", 3);
		if (end >= 0) return `${clean.slice(0, end + 1)}${line}\n${clean.slice(end + 1)}`;
	}
	return `---\n${line}\n---\n\n${clean}`;
}

function setFrontmatterList(content: string, key: string, values: string[]): string {
	const prior = splitNote(content);
	const lines = (prior.frontmatter ?? "").split("\n");
	const out: string[] = [];
	let skip = false;
	for (const line of lines) {
		const property = /^([A-Za-z][\w-]*):/.exec(line);
		if (property) {
			skip = property[1] === key;
			if (!skip) out.push(line);
			continue;
		}
		if (skip && /^\s/.test(line)) continue;
		out.push(line);
	}
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	if (values.length) {
		out.push(`${key}:`);
		for (const value of values) out.push(`  - "${value.replace(/"/g, '\\"')}"`);
	}
	return normalizeManagedMarkerSpacing(ensureManagedRegion(joinNote(out.join("\n"), prior.body)));
}

function sanitizeFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return content;
	const front = content.slice(0, end).split("\n");
	const body = content.slice(end);
	const out: string[] = [];
	let key = "";
	let seen = new Set<string>();
	const seenProperties = new Set<string>();
	for (const line of front) {
		const property = /^([A-Za-z][\w-]*):/.exec(line);
		if (property) {
			key = property[1];
			if ((key === "midad-version" || key === "midad-version-name") && seenProperties.has(key)) continue;
			seenProperties.add(key);
			seen = new Set<string>();
			out.push(line);
			continue;
		}
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && key === "midad-version") continue;
		if (item && (key === "aliases" || key === "topics")) {
			const value = item[1].trim();
			// Version links belong in other-versions/midad-up, never aliases or
			// topics. Duplicate aliases are also invalid in Obsidian.
			if (/\.Version\d+/i.test(value) || /\|V\d+\]\]/.test(value)) continue;
			if (key === "aliases" && seen.has(value)) continue;
			seen.add(value);
		}
		out.push(line);
	}
	return out.join("\n") + body;
}

function managedRegionText(content: string): string {
	const prior = splitNote(content);
	const region = findManagedRegion(prior.body);
	const raw = region ? prior.body.slice(region.start, region.end) : prior.body.trim();
	return normalizeManagedMarkerSpacing(ensureManagedRegion(raw));
}

function outsideBody(content: string): string {
	const prior = splitNote(content);
	const region = findManagedRegion(prior.body);
	if (!region) return "";
	return `${prior.body.slice(0, region.start)}${prior.body.slice(region.end)}`;
}

function addVersionFrontmatter(content: string, id: string, otherLinks: string[], label: string): string {
	const prior = splitNote(content);
	const lines = (prior.frontmatter ?? "").split("\n");
	const out: string[] = [];
	let skip = false;
	for (const line of lines) {
		const property = /^([A-Za-z][\w-]*):/.exec(line);
		if (property) {
			skip = property[1] === "midad-version" || property[1] === "midad-version-name" || property[1] === "other-versions";
			if (!skip) out.push(line);
			continue;
		}
		if (skip && /^\s/.test(line)) continue;
		out.push(line);
	}
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	out.push(`midad-version: "${id}"`);
	out.push(`midad-version-name: "${label.replace(/"/g, '\\"')}"`);
	if (otherLinks.length) {
		out.push("other-versions:");
		for (const link of otherLinks) out.push(`  - "${link.replace(/"/g, '\\"')}"`);
	}
	return joinNote(out.join("\n"), prior.body);
}


export class VersionStore {
	private readonly app: App;
	private readonly vaultPath: string;
	private readonly hashes: NoteHashStore;
	private manifest: VersionManifest | null = null;
	private files: Record<string, Uint8Array> = {};

	constructor(app: App, vaultPath: string) {
		this.app = app;
		this.vaultPath = vaultPath;
		this.hashes = NoteHashStore.forVault(vaultPath);
	}

	private archiveDir(): string {
		return `${this.vaultPath}/${ARCHIVE_DIR}`;
	}

	private load(): VersionManifest {
		if (this.manifest) return this.manifest;
		const dir = this.archiveDir();
		let found = false;
		try {
			for (const name of fs.readdirSync(dir)) {
				if (!name.endsWith(".zip")) continue;
				try {
					const files = unzipSync(new Uint8Array(fs.readFileSync(`${dir}/${name}`)));
					const text = files["manifest.json"];
					if (!text) continue;
					const archive = JSON.parse(strFromU8(text)) as VersionManifest;
					for (const [key, entry] of Object.entries(archive.notes ?? {})) {
						entry.workKey ??= workKeyFromKey(key);
						for (const version of entry.versions) delete (version as unknown as { hash?: string }).hash;
						this.manifest ??= { schema: 1, notes: {} };
						this.manifest.notes[key] = entry;
					}
					for (const [name2, bytes] of Object.entries(files)) {
						if (name2 !== "manifest.json") this.files[name2] = bytes;
					}
					found = true;
				} catch { /* ignore an unreadable archive */ }
			}
		} catch { /* no archive directory yet */ }
		if (!found) {
			try {
				const raw = fs.readFileSync(`${this.vaultPath}/${LEGACY_STORE_REL}`);
				this.files = unzipSync(new Uint8Array(raw));
				const text = this.files["manifest.json"];
				this.manifest = text ? JSON.parse(strFromU8(text)) as VersionManifest : { ...EMPTY, notes: {} };
				delete this.files["manifest.json"];
				for (const [key, entry] of Object.entries(this.manifest.notes)) {
					entry.workKey ??= workKeyFromKey(key);
					for (const version of entry.versions) delete (version as unknown as { hash?: string }).hash;
				}
				this.save();
				const backup = `${this.vaultPath}/.midad-arabic-sources/backups/source-versions-migrated.zip`;
				fs.mkdirSync(backup.slice(0, backup.lastIndexOf("/")), { recursive: true });
				try { fs.renameSync(`${this.vaultPath}/${LEGACY_STORE_REL}`, backup); } catch { /* already moved */ }
			} catch {
				this.manifest = { schema: 1, notes: {} };
				this.files = {};
			}
		}
		this.manifest ??= { schema: 1, notes: {} };
		return this.manifest;
	}

	private save(): void {
		const manifest = this.load();
		const dir = this.archiveDir();
		fs.mkdirSync(dir, { recursive: true });
		const groups = new Map<string, VersionManifest>();
		for (const [key, entry] of Object.entries(manifest.notes)) {
			const workKey = entry.workKey ?? workKeyFromKey(key);
			entry.workKey = workKey;
			let group = groups.get(workKey);
			if (!group) {
				group = { schema: 1, notes: {} };
				groups.set(workKey, group);
			}
			group.notes[key] = entry;
		}
		const expected = new Set<string>();
		for (const [workKey, group] of groups) {
			const archive = workArchivePath(this.vaultPath, workKey);
			expected.add(archive.slice(archive.lastIndexOf("/") + 1));
			const entries: Record<string, Uint8Array> = {
				"manifest.json": strToU8(JSON.stringify(group, null, 1) + "\n"),
			};
			for (const entry of Object.values(group.notes)) {
				for (const version of entry.versions) {
					const bytes = this.files[version.file];
					if (bytes) entries[version.file] = bytes;
				}
			}
			fs.writeFileSync(archive, Buffer.from(zipSync(entries, { level: 6 })));
		}
		try {
			for (const name of fs.readdirSync(dir)) {
				if (name.endsWith(".zip") && !expected.has(name)) fs.unlinkSync(`${dir}/${name}`);
			}
		} catch { /* ignore cleanup errors */ }
	}

	async entryFor(file: TFile): Promise<NoteVersionEntry | null> {
		const manifest = this.load();
		const key = noteKeyFromText(file, await this.app.vault.read(file));
		return manifest.notes[key] ?? null;
	}

	async virtualEntry(file: TFile): Promise<NoteVersionEntry> {
		const text = await this.app.vault.read(file);
		return {
			key: noteKeyFromText(file, text),
			path: file.path,
			title: file.basename,
			defaultId: "v0",
			virtualOriginal: true,
			workKey: workKeyFromText(file, text),
			versions: [],
		};
	}

	/** Mark a source-backed entry as having a virtual Version 0, migrating a legacy saved v0 to the first user slot. */
	async ensureVirtualOriginal(file: TFile, entry: NoteVersionEntry): Promise<NoteVersionEntry> {
		if (entry.virtualOriginal) return entry;
		entry.virtualOriginal = true;
		const legacy = entry.versions.find((v) => v.id === "v0" && v.kind === "user");
		if (legacy) {
			let next = 1;
			while (entry.versions.some((v) => v.id === `v${next}`)) next++;
			const oldPath = versionNotePath(entry, { ...legacy, id: "v0" });
			const oldId = legacy.id;
			legacy.id = `v${next}`;
			const oldHash = this.hashes.versionHash(entry.path, oldId);
			if (oldHash) {
				this.hashes.setVersionHash(entry.path, legacy.id, oldHash);
				this.hashes.deleteVersionHash(entry.path, oldId);
			}
			if (/^v?0$/i.test(legacy.label.trim())) legacy.label = `Version ${next}`;
			if (entry.defaultId === oldId) entry.defaultId = legacy.id;
			const newPath = versionNotePath(entry, legacy);
			const oldFile = this.app.vault.getAbstractFileByPath(normalizePath(oldPath));
			if (oldFile instanceof TFile && !this.app.vault.getAbstractFileByPath(normalizePath(newPath))) {
				await this.app.fileManager.renameFile(oldFile, normalizePath(newPath));
				await this.app.fileManager.processFrontMatter(oldFile, (fm: Record<string, unknown>) => {
					fm["midad-version"] = legacy.id;
				});
			}
		}
		this.save();
		return entry;
	}

	versionZeroPath(entry: NoteVersionEntry): string {
		return versionZeroNotePath(entry);
	}

	/** Write the separately rendered Version 0 note without archiving a snapshot. */
	async writeVersionZeroNote(file: TFile, entry: NoteVersionEntry, rendered: string): Promise<void> {
		const prior = splitNote(rendered);
		const current = await this.app.vault.read(file);
		const frontmatter = prior.frontmatter ?? splitNote(current).frontmatter ?? "";
		const region = managedRegionText(rendered);
		const links = otherVersionReferences(entry, "v0");
		const withVersion = addVersionFrontmatter(joinNote(frontmatter, region), "v0", links, "Original source");
		const defaultLink = `[[${entry.path.replace(/\.md$/, "")}|Default version]]`;
		await this.writeLive(versionZeroNotePath(entry), addUpLink(withVersion, defaultLink));
		entry.virtualSelected = true;
		this.save();
	}

	async saveVersion(file: TFile, overwrite: boolean, renderHash?: string, options: {
		activeVersionId?: string;
		label?: string;
		startAt?: number;
		virtualOriginal?: boolean;
		makeDefault?: boolean;
	} = {}): Promise<NoteVersionEntry> {
		const manifest = this.load();
		const text = await this.app.vault.read(file);
		const cleanText = sanitizeFrontmatter(text);
		const key = noteKeyFromText(file, text);
		const hash = normalizedHash(cleanText);
		let entry = manifest.notes[key];
		if (!entry) {
			entry = {
				key,
				path: file.path,
				title: file.basename.replace(/\.Version\d+$/i, ""),
				defaultId: "v0",
				virtualOriginal: !!options.virtualOriginal,
				workKey: workKeyFromText(file, text),
				versions: [],
			};
			manifest.notes[key] = entry;
		}
		if (!options.activeVersionId) {
			entry.path = file.path;
			entry.title = file.basename;
		}
		if (renderHash) entry.renderHash = renderHash;
		const active = options.activeVersionId
			? entry.versions.find((v) => v.id === options.activeVersionId)
			: null;
		if (overwrite && !active && !entry.versions.length) return entry;
		let version: SavedVersion;
		if (overwrite && active) {
			version = active;
			version.savedAt = new Date().toISOString();
			version.kind = "user";
		} else if (overwrite && entry.versions.length) {
			// The default context overwrites the current default version, not the
			// highest-numbered branch from another lineage.
			version = entry.versions.find((v) => v.id === entry.defaultId)
				?? [...entry.versions].sort((a, b) => versionNumber(a.id) - versionNumber(b.id)).at(-1);
			version.savedAt = new Date().toISOString();
			version.kind = "user";
		} else {
			const highest = entry.versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), (options.startAt ?? 0) - 1);
			const id = `v${highest + 1}`;
			version = {
				id,
				label: options.label?.trim() || `Version ${highest + 1}`,
				kind: "user",
				savedAt: new Date().toISOString(),
				file: versionFile(key, id),
				selected: true,
				archived: false,
			};
			entry.versions.push(version);
		}
		if (options.activeVersionId) {
			// Editing a subsidiary version does not move the default or silently
			// supersede the latest saved version.
			version.selected = true;
			version.archived = false;
		} else if (!overwrite) {
			if (options.makeDefault !== false) {
				for (const other of entry.versions) {
					if (other.id !== version.id) {
						other.selected = false;
						other.archived = true;
					}
				}
				entry.defaultId = version.id;
			}
			version.selected = true;
			version.archived = false;
		} else {
			version.selected = true;
			version.archived = false;
		}
		this.files[version.file] = strToU8(cleanText);
		this.hashes.setVersionHash(entry.path, version.id, hash);
		this.save();
		if (!options.activeVersionId && entry.defaultId === version.id) {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm["midad-version-name"] = version.label;
			});
			// processFrontMatter can leave a pre-existing duplicate scalar behind;
			// sanitize the live note so the same property is never written twice.
			const live = await this.app.vault.read(file);
			const clean = sanitizeFrontmatter(live);
			if (clean !== live) await this.writeLive(file.path, clean);
		}
		if (options.activeVersionId) {
			const live = await this.app.vault.read(file);
			const links = otherVersionReferences(entry, version.id);
			await this.writeLive(file.path, addVersionFrontmatter(live, version.id, links, versionLabel(version)));
		}
		return entry;
	}

	async setDefault(entry: NoteVersionEntry, id: string): Promise<void> {
		const manifest = this.load();
		if (!manifest.notes[entry.key]) manifest.notes[entry.key] = entry;
		entry.defaultId = id;
		const version = entry.versions.find((v) => v.id === id);
		if (version) {
			version.selected = true;
			version.archived = false;
		}
		this.save();
	}

	async setVirtualSelected(entry: NoteVersionEntry, selected: boolean, file?: TFile): Promise<void> {
		const manifest = this.load();
		if (!manifest.notes[entry.key]) manifest.notes[entry.key] = entry;
		entry.virtualSelected = selected;
		this.save();
		if (!selected && file) await this.deleteVersionNote(versionZeroNotePath(entry), "v0");
	}

	/** Add the Version 0 link to the default note without touching its managed body. */
	async syncDefaultVersionLinks(file: TFile, entry: NoteVersionEntry): Promise<void> {
		const current = await this.app.vault.read(file);
		const next = setFrontmatterList(current, "other-versions", otherVersionReferences(entry, entry.defaultId));
		await this.writeLive(file.path, next);
	}

	async renameVersion(entry: NoteVersionEntry, id: string, label: string): Promise<boolean> {
		const version = entry.versions.find((v) => v.id === id);
		const value = label.trim();
		if (!version || !value) return false;
		if (version.label === value) return true;
		if (entry.versions.some((v) => v.id !== id && versionLabel(v).toLowerCase() === value.toLowerCase())) {
			new Notice("That version name is already in use.");
			return false;
		}
		const oldLabel = version.label;
		version.label = value;
		this.save();

		const targetPath = version.id === entry.defaultId ? entry.path : versionNotePath(entry, version);
		const targetLink = versionLink(entry, version);
		const paths = [entry.path, ...entry.versions.filter((v) => v.selected && v.id !== entry.defaultId).map((v) => versionNotePath(entry, v))];
		for (const path of new Set(paths)) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (normalizePath(file.path) === normalizePath(targetPath)) fm["midad-version-name"] = value;
				const current = Array.isArray(fm["other-versions"]) ? fm["other-versions"] as unknown[] : [];
				const next = current.map((item) => {
					const text = typeof item === "string" ? item : "";
					if (text === oldLabel) return value;
					if (text.includes(targetPath.replace(/\.md$/, "")) || text.includes(targetPath)) {
						return targetLink;
					}
					return text;
				});
				if (next.length) fm["other-versions"] = next;
			});
		}
		return true;
	}

	async setSelected(entry: NoteVersionEntry, id: string, selected: boolean): Promise<void> {
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return;
		if (!selected && entry.defaultId === id) {
			new Notice("The default version must remain selected.");
			return;
		}
		version.selected = selected;
		version.archived = !selected;
		this.save();
	}

	async deleteVersion(entry: NoteVersionEntry, id: string, file?: TFile): Promise<void> {
		const target = entry.versions.find((v) => v.id === id);
		if (target?.kind === "source") {
			new Notice("This is the original source version. Its source model must be removed from Manage sources.");
			return;
		}
		if (entry.defaultId === id) {
			new Notice("Choose another default version before deleting this one.");
			return;
		}
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return;
		delete this.files[version.file];
		this.hashes.deleteVersionHash(entry.path, id);
		if (file && id !== entry.defaultId) await this.deleteVersionNote(versionNotePath(entry, version), id);
		entry.versions = entry.versions.filter((v) => v.id !== id);
		this.save();
	}

	async versionText(entry: NoteVersionEntry, id: string): Promise<string | null> {
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return null;
		const content = this.files[version.file];
		return content ? strFromU8(content) : null;
	}

	/** Match content against saved snapshots; tolerates older raw-hash records. */
	async matchesSavedVersion(entry: NoteVersionEntry, hash: string): Promise<boolean> {
		for (const version of entry.versions) {
			if (this.hashes.versionHash(entry.path, version.id) === hash) return true;
			const text = await this.versionText(entry, version.id);
			if (text && normalizedHash(text) === hash) return true;
		}
		return false;
	}

	async versionModified(file: TFile, entry: NoteVersionEntry, id: string): Promise<boolean> {
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return false;
		const path = versionNotePath(entry, version);
		const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(existing instanceof TFile)) return false;
		const live = await this.app.vault.read(existing);
		const recorded = this.hashes.versionHash(entry.path, id);
		if (recorded) return managedHash(live) !== recorded;
		const saved = await this.versionText(entry, id);
		return !saved || managedHash(live) !== managedHash(saved);
	}

	/** Remove a note's version entries, snapshots, and version notes. */
	async deleteEntry(entry: NoteVersionEntry): Promise<void> {
		for (const version of entry.versions) {
			delete this.files[version.file];
			this.hashes.deleteVersionHash(entry.path, version.id);
			await this.deleteVersionNote(versionNotePath(entry, version), version.id);
		}
		this.hashes.deleteNote(entry.path);
		delete this.load().notes[entry.key];
		this.save();
	}

	async syncVersionName(file: TFile): Promise<boolean> {
		const text = await this.app.vault.read(file);
		const versionMatch = /^midad-version:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(text);
		const nameMatch = /^midad-version-name:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(text);
		if (!versionMatch || !nameMatch) return false;
		const key = noteKeyFromText(file, text);
		const entry = this.load().notes[key];
		const version = entry?.versions.find((v) => v.id === versionMatch[1].trim());
		const label = nameMatch[1].trim();
		if (!version || !label || version.label === label) return false;
		version.label = label;
		this.save();
		return true;
	}

	async allEntries(): Promise<NoteVersionEntry[]> {
		return Object.values(this.load().notes);
	}

	async entriesForPaths(paths: string[]): Promise<NoteVersionEntry[]> {
		const wanted = new Set(paths.map((path) => normalizePath(path)));
		return Object.values(this.load().notes).filter((entry) => wanted.has(normalizePath(entry.path)));
	}

	async apply(file: TFile, entry: NoteVersionEntry): Promise<number> {
		const defaultVersion = entry.versions.find((v) => v.id === entry.defaultId);
		const virtualDefault = !defaultVersion && entry.virtualOriginal && entry.defaultId === "v0";
		if (!defaultVersion && !virtualDefault) return 0;
		const current = await this.app.vault.read(file);
		const currentPrior = splitNote(current);
		const outside = outsideBody(current);
		const frontmatter = currentPrior.frontmatter ?? (defaultVersion ? splitNote(await this.versionText(entry, defaultVersion.id) ?? "").frontmatter ?? "" : "");
		const defaultText = defaultVersion ? await this.versionText(entry, defaultVersion.id) : current;
		if (!defaultText) return 0;
		const otherLinks = otherVersionReferences(entry, defaultVersion?.id ?? "v0");
		let written = 0;
		if (defaultVersion) {
			const changeDefault = () => {
				const body = normalizeManagedMarkerSpacing(`${outside}${managedRegionText(defaultText)}`);
				const clean = stripVersionProperties(joinNote(frontmatter, body));
				const withName = setFrontmatterProperty(clean, "midad-version-name", `"${versionLabel(defaultVersion).replace(/"/g, '\\"')}"`);
				return setFrontmatterList(withName, "other-versions", otherLinks);
			};
			if (await this.writeLive(file.path, changeDefault())) written += 1;
		} else {
			const clean = stripVersionProperties(current);
			const withName = setFrontmatterProperty(clean, "midad-version-name", `"Original source"`);
			if (await this.writeLive(file.path, setFrontmatterList(withName, "other-versions", otherLinks))) written += 1;
		}
		const defaultLink = defaultVersion ? versionLink(entry, defaultVersion) : `[[${entry.path.replace(/\.md$/, "")}|Default version]]`;
		for (const version of entry.versions) {
			const path = versionNotePath(entry, version);
			if (!version.selected || version.id === entry.defaultId) {
				await this.deleteVersionNote(path, version.id);
				continue;
			}
			const text = await this.versionText(entry, version.id);
			if (!text) continue;
			const links = otherVersionReferences(entry, version.id);
			const region = managedRegionText(text);
			const versionBody = normalizeManagedMarkerSpacing(region);
			const withVersion = addVersionFrontmatter(joinNote(frontmatter, versionBody), version.id, links, versionLabel(version));
			if (await this.writeLive(path, addUpLink(withVersion, defaultLink))) written += 1;
		}
		return written;
	}

	private async deleteVersionNote(path: string, id: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (!(existing instanceof TFile)) return;
		try {
			const text = await this.app.vault.read(existing);
			if (new RegExp(`^midad-version:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(text)) {
				await this.app.fileManager.trashFile(existing);
			}
		} catch { /* leave a note we cannot verify */ }
	}

	private async writeLive(path: string, text: string): Promise<boolean> {
		const normalized = normalizePath(path);
		const folder = normalized.slice(0, normalized.lastIndexOf("/"));
		if (folder) await ensureFolder(this.app, folder);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			if (await this.app.vault.read(existing) === text) return false;
			await this.app.vault.modify(existing, text);
			return true;
		}
		await this.app.vault.create(normalized, text);
		return true;
	}
}

interface VersionModalOptions {
	app: App;
	file: TFile;
	store: VersionStore;
	onChanged?: () => void;
	getFingerprint?: () => Promise<string>;
	activeVersionId?: string;
	isSourceBacked?: () => Promise<boolean>;
	renderOriginal?: () => Promise<void>;
	renderVersionZero?: () => Promise<void>;
	matchesOriginal?: () => Promise<boolean | null>;
	updateBaseline?: () => Promise<void>;
}

export class ManageVersionsModal extends Modal {
	private static current: ManageVersionsModal | null = null;
	private readonly options: VersionModalOptions;
	private entry: NoteVersionEntry | null = null;
	private currentHash = "";
	private renderFingerprint = "";
	private fingerprintLoaded = false;
	private renderChanged = false;
	private matchesSaved = false;
	private originalMatches: boolean | null = null;
	private outsideContent = "";
	private activeVersionId: string | undefined;
	private selectionDirty = false;

	constructor(options: VersionModalOptions) {
		super(options.app);
		this.options = options;
		this.activeVersionId = options.activeVersionId;
	}

	async onOpen(): Promise<void> {
		if (ManageVersionsModal.current && ManageVersionsModal.current !== this) {
			ManageVersionsModal.current.close();
		}
		document.querySelectorAll<HTMLElement>(".modal.mas-versions-modal").forEach((el) => {
			if (el !== this.modalEl) el.querySelector<HTMLButtonElement>(".modal-close-button")?.click();
		});
		ManageVersionsModal.current = this;
		this.modalEl.addClass("mas-versions-modal");
		this.titleEl.setText("Manage versions");
		await this.refresh();
	}

	onClose(): void {
		if (ManageVersionsModal.current === this) ManageVersionsModal.current = null;
		this.contentEl.empty();
	}

	private async refresh(): Promise<void> {
		this.entry = await this.options.store.entryFor(this.options.file);
		const sourceBacked = this.options.isSourceBacked ? await this.options.isSourceBacked() : false;
		if (!this.entry && sourceBacked) {
			this.entry = await this.options.store.virtualEntry(this.options.file);
		} else if (this.entry && sourceBacked) {
			this.entry = await this.options.store.ensureVirtualOriginal(this.options.file, this.entry);
		}
		const liveText = await this.options.app.vault.read(this.options.file);
		if (!this.activeVersionId && /\.Version\d+\.md$/i.test(this.options.file.path)) {
			const versionMatch = /^midad-version:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(liveText);
			if (versionMatch) this.activeVersionId = versionMatch[1].trim();
		}
		this.currentHash = normalizedHash(liveText);
		const prior = splitNote(liveText);
		const region = findManagedRegion(prior.body);
		this.outsideContent = region
			? `${prior.body.slice(0, region.start)}${prior.body.slice(region.end)}`.trim()
			: "";
		this.matchesSaved = this.entry ? await this.options.store.matchesSavedVersion(this.entry, this.currentHash) : false;
		this.originalMatches = this.options.matchesOriginal ? await this.options.matchesOriginal() : null;
		this.render();
		if (!this.fingerprintLoaded) {
			this.renderFingerprint = this.options.getFingerprint ? await this.options.getFingerprint() : "";
			this.fingerprintLoaded = true;
			this.renderChanged = !!this.entry?.renderHash && this.entry.renderHash !== this.renderFingerprint;
			this.render();
		}
	}

	private hasChanges(): boolean {
		if (this.entry?.virtualOriginal && this.entry.defaultId === "v0") {
			if (this.originalMatches === true) return false;
			if (this.originalMatches === false) return true;
			return this.entry.versions.length ? !this.matchesSaved : true;
		}
		return !this.entry?.versions.length || !this.matchesSaved;
	}

	private hasUnsavedChanges(): boolean {
		if (this.entry?.virtualOriginal && this.entry.defaultId === "v0") {
			if (this.originalMatches === true) return false;
			if (this.originalMatches === false) return true;
			// No baseline is available: don't claim Version 0 is unchanged.
			return this.entry.versions.length ? !this.matchesSaved : true;
		}
		return !!this.entry?.versions.length && !this.matchesSaved;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "mas-versions-desc",
			text: `Saved versions for ${this.entry?.title || this.options.file.basename}. The default version supplies the main note.`,
		});
		if (this.activeVersionId) {
			contentEl.createEl("p", {
				cls: "mas-versions-help",
				text: `This is not the default version (${this.activeVersionId.toUpperCase()}). Saving here will not update or replace the main note. To manage versions, run this command from the default version.`,
			});
			if (this.outsideContent) {
				const detach = contentEl.createEl("button", {
					cls: "mas-versions-detach",
					text: "Detach user-written content into a separate note…",
				});
				detach.onclick = () => { this.detach(); };
			}
		}
		if (!this.activeVersionId) {
			contentEl.createEl("p", {
				cls: "mas-versions-help",
				text: "Selected versions are rendered as Markdown; deselect a version to archive it. Click ‘set as default’ to render a version on the main note without a version suffix. Click the trash icon to delete a version.",
			});
		}
		if (this.renderChanged) {
			contentEl.createEl("p", {
				cls: "mas-versions-help",
				text: "These saved versions were created with an older template/render fingerprint. Their snapshots are preserved; Version 0 re-renders with the current templates.",
			});
		}

		const top = contentEl.createDiv({ cls: "mas-versions-actions" });
		const changed = this.hasChanges();
		const hasVersions = !!this.entry?.versions.length;
		if (changed && hasVersions) {
			const overwrite = top.createEl("button", { text: "Save the current version" });
			overwrite.onclick = async () => {
				await this.options.store.saveVersion(this.options.file, true, this.renderFingerprint, { activeVersionId: this.activeVersionId });
				this.selectionDirty = false;
				await this.refresh();
				this.options.onChanged?.();
			};
		}
		if (changed) {
			const save = top.createEl("button", { text: "Save new version" });
			save.onclick = () => { this.promptNewVersion(); };
		}

		if (!changed) {
			contentEl.createEl("p", { cls: "mas-versions-nochanges", text: "No changes to save." });
		}

		if (!this.activeVersionId) {
			const list = contentEl.createDiv({ cls: "mas-versions-list" });
			if (this.entry?.virtualOriginal && !this.entry.versions.some((v) => v.id === "v0")) {
				const row = list.createDiv({ cls: "mas-versions-row" });
				const virtualSelected = this.entry.defaultId === "v0" || this.entry.virtualSelected === true;
				if (this.entry.defaultId === "v0") row.addClass("is-default");
				if (virtualSelected) row.addClass("is-selected");
				row.onclick = async () => {
					if (this.entry?.defaultId === "v0") {
						new Notice("The default version must remain selected.");
						return;
					}
					await this.options.store.setVirtualSelected(this.entry, !this.entry.virtualSelected, this.options.file);
					this.selectionDirty = true;
					await this.refresh();
				};
				const main = row.createDiv({ cls: "mas-versions-main" });
				main.createDiv({ cls: "mas-versions-label-line" }).createSpan({ cls: "mas-versions-label", text: "Version 0 — Original source" });
				main.createDiv({ cls: "mas-versions-date", text: "Rendered from the source; no stored snapshot." });
				const status = row.createDiv({ cls: "mas-versions-status" });
				if (this.entry.defaultId === "v0") {
					status.createSpan({ cls: "mas-versions-default", text: "Default" });
				} else {
					const setDefault = status.createEl("button", { cls: "mas-versions-default-button", text: "Set as default" });
					setDefault.onclick = async (event) => {
						event.stopPropagation();
						await this.options.store.setDefault(this.entry, "v0");
						this.selectionDirty = true;
						await this.refresh();
					};
				}
			}
			if (!this.entry?.versions.length) {
				if (!this.entry?.virtualOriginal) list.createDiv({ cls: "mas-versions-empty", text: "No saved versions yet." });
			} else {
				for (const version of [...this.entry.versions].sort((a, b) => versionNumber(a.id) - versionNumber(b.id))) {
				const row = list.createDiv({ cls: "mas-versions-row" });
				if (version.selected) row.addClass("is-selected");
				if (version.id === this.entry.defaultId) row.addClass("is-default");
				row.onclick = async (event) => {
					if ((event.target as HTMLElement).closest("button")) return;
					if (version.id === this.entry?.defaultId && version.selected) {
						new Notice("The default version must remain selected.");
						return;
					}
					await this.setSelectedWithPrompt(version, !version.selected);
					this.selectionDirty = true;
				};
				const rename = row.createEl("button", { cls: "mas-versions-rename", attr: { "aria-label": "Rename version" } });
				setIcon(rename, "pencil");
				rename.onclick = (event) => {
					event.stopPropagation();
					new RenameVersionModal(this.app, versionLabel(version), async (name) => {
						if (await this.options.store.renameVersion(this.entry, version.id, name)) await this.refresh();
					}).open();
				};
				const main = row.createDiv({ cls: "mas-versions-main" });
				const labelLine = main.createDiv({ cls: "mas-versions-label-line" });
				labelLine.createSpan({ cls: "mas-versions-label", text: versionLabel(version) });
				main.createDiv({ cls: "mas-versions-date", text: new Date(version.savedAt).toLocaleString() });
				const status = row.createDiv({ cls: "mas-versions-status" });
				if (version.id === this.entry.defaultId) {
					status.createSpan({ cls: "mas-versions-default", text: "Default" });
				} else {
					const setDefault = status.createEl("button", { cls: "mas-versions-default-button", text: "Set as default" });
					setDefault.onclick = async () => {
						await this.options.store.setDefault(this.entry, version.id);
						this.selectionDirty = true;
						await this.refresh();
					};
				}
				const trash = status.createEl("button", { cls: "mas-versions-trash", attr: { "aria-label": "Delete version" } });
				setIcon(trash, "trash-2");
				trash.onclick = async (event) => {
					event.stopPropagation();
					await this.deleteWithPrompt(version);
					this.selectionDirty = true;
				};
				}
			}
		}

		if (!this.activeVersionId) {
			const applyWrap = contentEl.createDiv({ cls: "mas-versions-apply" });
			const apply = applyWrap.createEl("button", { text: "Apply default and re-render notes" });
			apply.disabled = !this.entry?.versions.length && !this.entry?.virtualOriginal;
			apply.onclick = () => { void this.apply(); };
		}
	}

	private async setSelectedWithPrompt(version: SavedVersion, selected: boolean): Promise<void> {
		if (selected) {
			await this.options.store.setSelected(this.entry, version.id, true);
			await this.refresh();
			return;
		}
		if (version.id === this.entry?.defaultId) return;
		const modified = await this.options.store.versionModified(this.options.file, this.entry, version.id);
		if (!modified) {
			await this.options.store.setSelected(this.entry, version.id, false);
			await this.refresh();
			return;
		}
		new ManagedVersionChangesModal(this.app, {
			onSaveNew: async () => {
				await this.saveVersionNote(version, false);
				await this.options.store.setSelected(this.entry, version.id, false);
				await this.refresh();
			},
			onOverwrite: async () => {
				await this.saveVersionNote(version, true);
				await this.options.store.setSelected(this.entry, version.id, false);
				await this.refresh();
			},
			onDiscard: async () => {
				await this.options.store.setSelected(this.entry, version.id, false);
				await this.refresh();
			},
		}).open();
	}

	private async deleteWithPrompt(version: SavedVersion): Promise<void> {
		if (version.id === this.entry?.defaultId) {
			new Notice("Choose another default version before deleting this one.");
			return;
		}
		const modified = await this.options.store.versionModified(this.options.file, this.entry, version.id);
		if (!modified) {
			await this.options.store.deleteVersion(this.entry, version.id, this.options.file);
			await this.refresh();
			return;
		}
		new ManagedVersionChangesModal(this.app, {
			onSaveNew: async () => {
				await this.saveVersionNote(version, false);
				await this.options.store.deleteVersion(this.entry, version.id, this.options.file);
				await this.refresh();
			},
			onDiscard: async () => {
				await this.options.store.deleteVersion(this.entry, version.id, this.options.file);
				await this.refresh();
			},
		}).open();
	}

	private async saveVersionNote(version: SavedVersion, overwrite: boolean): Promise<void> {
		const path = versionNotePath(this.entry, version);
		const note = this.options.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(note instanceof TFile)) return;
		await this.options.store.saveVersion(note, overwrite, this.renderFingerprint, { activeVersionId: version.id });
	}

	private detach(): void {
		if (!this.outsideContent) return;
		new DetachVersionModal(this.app, {
			defaultName: `${this.options.file.basename.replace(/\.Version\d+$/i, "")} - detached notes`,
			onSubmit: async (name) => {
				const text = await this.options.app.vault.read(this.options.file);
				const prior = splitNote(text);
				const region = findManagedRegion(prior.body);
				if (!region) return;
				const frontmatter = prior.frontmatter ?? ""
					.replace(/^midad-id:[^\n]*\n/gm, "")
					.replace(/^midad-version:[^\n]*\n/gm, "")
					.replace(/^other-versions:[^\n]*\n(?:[ \t]+-[^\n]*\n)*/gm, "");
				const folder = this.options.file.path.includes("/")
					? this.options.file.path.slice(0, this.options.file.path.lastIndexOf("/"))
					: "";
				const target = normalizePath(`${folder}/${name.trim().replace(/\.md$/i, "")}.md`);
				if (this.options.app.vault.getAbstractFileByPath(target)) {
					new Notice("A note with that name already exists.");
					return;
				}
				await this.options.app.vault.create(target, joinNote(frontmatter, `\n${this.outsideContent.trim()}\n`));
				// Remove the detached text from the version note, leaving its managed
				// region as the generated-version body.
				await this.options.app.vault.modify(
					this.options.file,
					joinNote(prior.frontmatter ?? "", `\n${prior.body.slice(region.start, region.end).trim()}\n`)
				);
				new Notice(`Detached user content to ${target}.`);
				await this.refresh();
			},
		}).open();
	}

	private async renderVirtualZeroAsVersion(): Promise<void> {
		if (!this.options.renderVersionZero) return;
		await this.options.renderVersionZero();
		await this.refresh();
		this.options.onChanged?.();
	}

	private promptNewVersion(): void {
		const versions = this.entry?.versions ?? [];
		const highest = versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), this.entry?.virtualOriginal ? 0 : -1);
		const active = this.activeVersionId ? versions.find((v) => v.id === this.activeVersionId) : null;
		let suggestion = active ? `${versionLabel(active)}.1` : `Version ${highest + 1}`;
		let suffix = 2;
		while (versions.some((v) => versionLabel(v).toLowerCase() === suggestion.toLowerCase())) {
			suggestion = active ? `${versionLabel(active)}.${suffix++}` : `Version ${highest + suffix++}`;
		}
		new VersionNameModal(this.app, suggestion, async (name) => {
			await this.options.store.saveVersion(this.options.file, false, this.renderFingerprint, {
				activeVersionId: this.activeVersionId,
				label: name,
				startAt: this.entry?.virtualOriginal ? 1 : 0,
				virtualOriginal: !!this.entry?.virtualOriginal,
			});
			this.selectionDirty = false;
			await this.refresh();
			this.options.onChanged?.();
		}).open();
	}

	private async apply(): Promise<void> {
		if (this.entry?.virtualOriginal && this.entry.virtualSelected && this.entry.defaultId !== "v0" && this.options.renderOriginal) {
			await this.renderVirtualZeroAsVersion();
			return;
		}
		if (this.entry?.virtualOriginal && this.entry.defaultId === "v0" && this.options.renderOriginal) {
			const renderOriginal = async () => {
				await this.options.renderOriginal();
				this.close();
			};
			if (this.hasUnsavedChanges()) {
				new UnsavedVersionModal(this.app, {
					onDiscard: renderOriginal,
					onSaveNew: async () => {
						const versions = this.entry?.versions ?? [];
						const highest = versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), 0);
						const next = highest + 1;
						await this.options.store.saveVersion(this.options.file, false, this.renderFingerprint, {
							startAt: next,
							virtualOriginal: true,
							makeDefault: false,
							label: `Version ${next}`,
						});
						await renderOriginal();
					},
					onOverwrite: renderOriginal,
					onCancel: () => undefined,
				}).open();
				return;
			}
			await renderOriginal();
			return;
		}
		if (!this.entry?.versions.length) {
			new Notice("There are no saved versions to apply.");
			return;
		}
		if (this.hasUnsavedChanges()) {
			new UnsavedVersionModal(this.app, {
				onDiscard: async () => {
					await this.options.store.apply(this.options.file, this.entry);
					this.close();
				},
				onSaveNew: async () => {
					await this.options.store.saveVersion(this.options.file, false, this.renderFingerprint);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry);
					this.close();
				},
				onOverwrite: async () => {
					await this.options.store.saveVersion(this.options.file, true, this.renderFingerprint);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry);
					this.close();
				},
				onCancel: () => undefined,
			}).open();
			return;
		}
		const written = await this.options.store.apply(this.options.file, this.entry);
		this.selectionDirty = false;
		if (!written) new Notice("No changes to apply.");
		this.close();
	}
}

class ManagedVersionChangesModal extends Modal {
	private readonly options: {
		onSaveNew: () => Promise<void>;
		onOverwrite?: () => Promise<void>;
		onDiscard: () => Promise<void>;
	};

	constructor(app: App, options: ManagedVersionChangesModal["options"]) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.titleEl.setText("This version has changed");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "This version has been modified from its saved content. Would you like to save these changes?" });
		const buttons = contentEl.createDiv({ cls: "mas-versions-conflict-actions" });
		const add = (text: string, action: () => Promise<void>, primary = false): void => {
			const button = buttons.createEl("button", { text, cls: primary ? "mod-cta" : undefined });
			button.onclick = async () => { await action(); this.close(); };
		};
		add("Save as new version", this.options.onSaveNew, true);
		if (this.options.onOverwrite) add("Overwrite this version", this.options.onOverwrite);
		add("Discard changes", this.options.onDiscard);
		add("Cancel", async () => undefined);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class VersionNameModal extends Modal {
	private readonly suggestion: string;
	private readonly onSubmit: (name: string) => Promise<void>;

	constructor(app: App, suggestion: string, onSubmit: (name: string) => Promise<void>) {
		super(app);
		this.suggestion = suggestion;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.titleEl.setText("Name new version");
		const { contentEl } = this;
		let name = this.suggestion;
		let inputEl: HTMLInputElement | null = null;
		new Setting(contentEl).setName("Version name").addText((text) => {
			inputEl = text.inputEl;
			text.setValue(name).onChange((value) => { name = value; });
		});
		const buttons = contentEl.createDiv({ cls: "mas-versions-conflict-actions" });
		const save = buttons.createEl("button", { text: "Save new version", cls: "mod-cta" });
		save.onclick = async () => {
			if (!name.trim()) {
				new Notice("Enter a version name.");
				return;
			}
			await this.onSubmit(name);
			this.close();
		};
		inputEl?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				save.click();
			}
		});
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
	}

	onClose(): void { this.contentEl.empty(); }
}

class RenameVersionModal extends Modal {
	private readonly current: string;
	private readonly onSubmit: (name: string) => Promise<void>;

	constructor(app: App, current: string, onSubmit: (name: string) => Promise<void>) {
		super(app);
		this.current = current;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.titleEl.setText("Rename version");
		const { contentEl } = this;
		let name = this.current;
		let inputEl: HTMLInputElement | null = null;
		new Setting(contentEl).setName("Version name").addText((text) => {
			inputEl = text.inputEl;
			text.setValue(name).onChange((value) => { name = value; });
		});
		const buttons = contentEl.createDiv({ cls: "mas-versions-conflict-actions" });
		const save = buttons.createEl("button", { text: "Rename", cls: "mod-cta" });
		save.onclick = async () => {
			if (!name.trim()) {
				new Notice("Enter a version name.");
				return;
			}
			await this.onSubmit(name);
			this.close();
		};
		inputEl?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				save.click();
			}
		});
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DetachVersionModal extends Modal {
	private readonly options: { defaultName: string; onSubmit: (name: string) => Promise<void> };

	constructor(app: App, options: DetachVersionModal["options"]) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.titleEl.setText("Detach user content");
		const { contentEl } = this;
		contentEl.createEl("p", { text: "Save the text outside the managed region as a separate note. It will be removed from this version note." });
		let name = this.options.defaultName;
		let inputEl: HTMLInputElement | null = null;
		new Setting(contentEl).setName("Note name").addText((text) => {
			inputEl = text.inputEl;
			text.setValue(name).onChange((value) => { name = value; });
		});
		const buttons = contentEl.createDiv({ cls: "mas-versions-conflict-actions" });
		const save = buttons.createEl("button", { text: "Detach", cls: "mod-cta" });
		save.onclick = async () => {
			if (!name.trim()) {
				new Notice("Enter a note name.");
				return;
			}
			await this.options.onSubmit(name);
			this.close();
		};
		inputEl?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				save.click();
			}
		});
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class UnsavedVersionModal extends Modal {
	private readonly options: {
		onDiscard: () => void | Promise<void>;
		onSaveNew: () => void | Promise<void>;
		onOverwrite: () => void | Promise<void>;
		onCancel: () => void | Promise<void>;
	};

	constructor(app: App, options: UnsavedVersionModal["options"]) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.titleEl.setText("Unsaved changes");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "The current note has unsaved changes. What do you want to do with your changes?",
		});
		const buttons = contentEl.createDiv({ cls: "mas-versions-conflict-actions" });
		const add = (text: string, action: () => void | Promise<void>): void => {
			const button = buttons.createEl("button", { text });
			button.onclick = async () => {
				await action();
				this.close();
			};
		};
		add("Discard these changes", this.options.onDiscard);
		add("Save as new version", this.options.onSaveNew);
		add("Overwrite last version", this.options.onOverwrite);
		add("Cancel", this.options.onCancel);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
