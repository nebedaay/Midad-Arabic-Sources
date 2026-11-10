import { App, Menu, Modal, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as fs from "fs";
import { hashString } from "./sourceImport/history";
import { ensureFolder, safeFileSegment } from "./sourcePaths";
import { findManagedRegion, joinNote, splitNote } from "./sourceImport/merge";

export interface SavedVersion {
	id: string;
	label: string;
	kind: "source" | "user";
	savedAt: string;
	hash: string;
	file: string;
	selected: boolean;
	archived: boolean;
}

export interface NoteVersionEntry {
	key: string;
	path: string;
	title: string;
	defaultId: string;
	renderHash?: string;
	versions: SavedVersion[];
}

interface VersionManifest {
	schema: 1;
	notes: Record<string, NoteVersionEntry>;
}

const EMPTY: VersionManifest = { schema: 1, notes: {} };
const STORE_REL = ".midad-arabic-sources/source-versions.zip";

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

function managedHash(text: string): string {
	const prior = splitNote(text);
	const region = findManagedRegion(prior.body);
	if (region) return hashString(prior.body.slice(region.start, region.end));
	return hashString(prior.body);
}

function noteKey(file: TFile, frontmatter: Record<string, unknown> | undefined): string {
	const id = typeof frontmatter?.["midad-id"] === "string" ? frontmatter["midad-id"].trim() : "";
	return id ? `id:${id}` : `path:${file.path}`;
}

function noteKeyFromText(file: TFile, text: string): string {
	const match = /^midad-id:[ \t]*["']?([^"'\n]+)["']?[ \t]*$/m.exec(text);
	const id = match?.[1]?.trim() ?? "";
	return id ? `id:${id}` : `path:${file.path}`;
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

function versionLink(file: TFile, entry: NoteVersionEntry, version: SavedVersion): string {
	const path = version.id === entry.defaultId ? entry.path : versionNotePath(entry, version);
	const label = version.id === entry.defaultId ? "Default version" : versionLabel(version);
	return `[[${path.replace(/\.md$/, "")}|${label}]]`;
}

function versionReference(file: TFile, entry: NoteVersionEntry, version: SavedVersion): string {
	if (version.id === entry.defaultId || version.selected) {
		return versionLink(file, entry, version);
	}
	return versionLabel(version);
}

function otherVersionReferences(file: TFile, entry: NoteVersionEntry, excludeId?: string): string[] {
	return entry.versions
		.filter((v) => v.id !== excludeId)
		.sort((a, b) => a.id === entry.defaultId ? -1 : b.id === entry.defaultId ? 1 : versionNumber(a.id) - versionNumber(b.id))
		.map((v) => versionReference(file, entry, v));
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
	const re = new RegExp(`^${key}:[^\\n]*\\n(?:[ \\t]+-[^\\n]*\\n)*`, "m");
	return front.replace(re, "") + body;
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
	const clean = removeFrontmatterProperty(content, key);
	if (!values.length) return clean;
	const block = `${key}:\n${values.map((value) => `  - "${value.replace(/"/g, '\\"')}"`).join("\n")}\n`;
	if (clean.startsWith("---")) {
		const end = clean.indexOf("\n---", 3);
		if (end >= 0) return `${clean.slice(0, end + 1)}${block}${clean.slice(end + 1)}`;
	}
	return `---\n${block}---\n\n${clean}`;
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
			if (key === "midad-version" && seenProperties.has(key)) continue;
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

function addVersionFrontmatter(content: string, id: string, otherLinks: string[]): string {
	const prior = splitNote(content);
	const lines = (prior.frontmatter ?? "").split("\n");
	const out: string[] = [];
	let skip = false;
	for (const line of lines) {
		const property = /^([A-Za-z][\w-]*):/.exec(line);
		if (property) {
			skip = property[1] === "midad-version" || property[1] === "other-versions";
			if (!skip) out.push(line);
			continue;
		}
		if (skip && /^\s/.test(line)) continue;
		out.push(line);
	}
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	out.push(`midad-version: "${id}"`);
	if (otherLinks.length) {
		out.push("other-versions:");
		for (const link of otherLinks) out.push(`  - "${link.replace(/"/g, '\\"')}"`);
	}
	return joinNote(out.join("\n"), prior.body);
}


export class VersionStore {
	private readonly app: App;
	private readonly vaultPath: string;
	private manifest: VersionManifest | null = null;
	private files: Record<string, Uint8Array> = {};

	constructor(app: App, vaultPath: string) {
		this.app = app;
		this.vaultPath = vaultPath;
	}

	private zipPath(): string {
		return `${this.vaultPath}/${STORE_REL}`;
	}

	private load(): VersionManifest {
		if (this.manifest) return this.manifest;
		try {
			const raw = fs.readFileSync(this.zipPath());
			this.files = unzipSync(new Uint8Array(raw));
			const text = this.files["manifest.json"];
			this.manifest = text ? JSON.parse(strFromU8(text)) as VersionManifest : { ...EMPTY, notes: {} };
		} catch {
			this.manifest = { schema: 1, notes: {} };
			this.files = {};
		}
		return this.manifest;
	}

	private save(): void {
		const manifest = this.load();
		this.files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 1) + "\n");
		const dir = this.zipPath().slice(0, this.zipPath().lastIndexOf("/"));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.zipPath(), Buffer.from(zipSync(this.files, { level: 6 })));
	}

	async entryFor(file: TFile): Promise<NoteVersionEntry | null> {
		const manifest = this.load();
		const key = noteKeyFromText(file, await this.app.vault.read(file));
		return manifest.notes[key] ?? null;
	}

	async saveVersion(file: TFile, overwrite: boolean, renderHash?: string, options: {
		activeVersionId?: string;
		label?: string;
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
			version.hash = hash;
			version.kind = "user";
		} else if (overwrite && entry.versions.length) {
			// The default context overwrites the current default version, not the
			// highest-numbered branch from another lineage.
			version = entry.versions.find((v) => v.id === entry.defaultId)
				?? [...entry.versions].sort((a, b) => versionNumber(a.id) - versionNumber(b.id)).at(-1) as SavedVersion;
			version.savedAt = new Date().toISOString();
			version.hash = hash;
			version.kind = "user";
		} else {
			const highest = entry.versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), -1);
			const id = `v${highest + 1}`;
			version = {
				id,
				label: options.label?.trim() || `Version ${highest + 1}`,
				kind: "user",
				savedAt: new Date().toISOString(),
				hash,
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
			for (const other of entry.versions) {
				if (other.id !== version.id) {
					other.selected = false;
					other.archived = true;
				}
			}
			version.selected = true;
			version.archived = false;
			entry.defaultId = version.id;
		} else {
			version.selected = true;
			version.archived = false;
		}
		this.files[version.file] = strToU8(cleanText);
		this.save();
		if (options.activeVersionId) {
			const live = await this.app.vault.read(file);
			const links = otherVersionReferences(file, entry, version.id);
			await this.writeLive(file.path, addVersionFrontmatter(live, version.id, links));
		}
		return entry;
	}

	async setDefault(entry: NoteVersionEntry, id: string): Promise<void> {
		entry.defaultId = id;
		const version = entry.versions.find((v) => v.id === id);
		if (version) {
			version.selected = true;
			version.archived = false;
		}
		this.save();
	}

	async renameVersion(entry: NoteVersionEntry, id: string, label: string): Promise<boolean> {
		const version = entry.versions.find((v) => v.id === id);
		const value = label.trim();
		if (!version || !value) return false;
		if (entry.versions.some((v) => v.id !== id && versionLabel(v).toLowerCase() === value.toLowerCase())) {
			new Notice("That version name is already in use.");
			return false;
		}
		version.label = value;
		this.save();
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
			new Notice("This is the original source version. Its source model must be removed from Manage Sources.");
			return;
		}
		if (entry.defaultId === id) {
			new Notice("Choose another default version before deleting this one.");
			return;
		}
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return;
		delete this.files[version.file];
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
			if (version.hash === hash) return true;
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
		const saved = await this.versionText(entry, id);
		return !saved || managedHash(live) !== managedHash(saved);
	}

	async entriesForPaths(paths: string[]): Promise<NoteVersionEntry[]> {
		const wanted = new Set(paths.map((path) => normalizePath(path)));
		return Object.values(this.load().notes).filter((entry) => wanted.has(normalizePath(entry.path)));
	}

	async apply(file: TFile, entry: NoteVersionEntry): Promise<number> {
		const defaultVersion = entry.versions.find((v) => v.id === entry.defaultId);
		if (!defaultVersion) return 0;
		const selected = entry.versions.filter((v) => v.selected);
		const otherLinks = otherVersionReferences(file, entry, defaultVersion.id);
		const defaultText = await this.versionText(entry, defaultVersion.id);
		if (!defaultText) return 0;
		const defaultBody = setFrontmatterList(sanitizeFrontmatter(defaultText), "other-versions", otherLinks);
		let written = (await this.writeLive(file.path, defaultBody)) ? 1 : 0;
		const defaultLink = versionLink(file, entry, defaultVersion);
		for (const version of entry.versions) {
			const path = versionNotePath(entry, version);
			if (!version.selected || version.id === entry.defaultId) {
				await this.deleteVersionNote(path, version.id);
				continue;
			}
			const text = await this.versionText(entry, version.id);
			if (!text) continue;
			const links = otherVersionReferences(file, entry, version.id);
			const withVersion = addVersionFrontmatter(text, version.id, links);
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
				await this.app.vault.delete(existing);
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
}

export class ManageVersionsModal extends Modal {
	private readonly options: VersionModalOptions;
	private entry: NoteVersionEntry | null = null;
	private currentHash = "";
	private renderFingerprint = "";
	private fingerprintLoaded = false;
	private renderChanged = false;
	private matchesSaved = false;
	private outsideContent = "";
	private activeVersionId: string | undefined;
	private selectionDirty = false;

	constructor(options: VersionModalOptions) {
		super(options.app);
		this.options = options;
		this.activeVersionId = options.activeVersionId;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mas-versions-modal");
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		this.entry = await this.options.store.entryFor(this.options.file);
		const liveText = await this.options.app.vault.read(this.options.file);
		if (!this.activeVersionId) {
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
		this.render();
		if (!this.fingerprintLoaded) {
			this.renderFingerprint = this.options.getFingerprint ? await this.options.getFingerprint() : "";
			this.fingerprintLoaded = true;
			this.renderChanged = !!this.entry?.renderHash && this.entry.renderHash !== this.renderFingerprint;
			this.render();
		}
	}

	private hasChanges(): boolean {
		return !this.entry?.versions.length || !this.matchesSaved;
	}

	private hasUnsavedChanges(): boolean {
		return !this.matchesSaved;
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
				text: "Selected versions are rendered as markdown; deselect a version to archive it. Click ‘Set as default’ to render a version on the main note without a version suffix. Click the trash icon to delete a version.",
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
		if (changed || !hasVersions) {
			const save = top.createEl("button", { text: "Save new version" });
			save.onclick = () => { this.promptNewVersion(); };
		}

		if (!changed && hasVersions) {
			contentEl.createEl("p", { cls: "mas-versions-nochanges", text: "No changes to save." });
		}

		if (!this.activeVersionId) {
			const list = contentEl.createDiv({ cls: "mas-versions-list" });
			if (!this.entry?.versions.length) {
				list.createDiv({ cls: "mas-versions-empty", text: "No saved versions yet." });
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
						if (await this.options.store.renameVersion(this.entry!, version.id, name)) await this.refresh();
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
						await this.options.store.setDefault(this.entry!, version.id);
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
			apply.disabled = !this.entry?.versions.length;
			apply.onclick = () => { void this.apply(); };
		}
	}

	private async setSelectedWithPrompt(version: SavedVersion, selected: boolean): Promise<void> {
		if (selected) {
			await this.options.store.setSelected(this.entry!, version.id, true);
			await this.refresh();
			return;
		}
		if (version.id === this.entry?.defaultId) return;
		const modified = await this.options.store.versionModified(this.options.file, this.entry!, version.id);
		if (!modified) {
			await this.options.store.setSelected(this.entry!, version.id, false);
			await this.refresh();
			return;
		}
		new ManagedVersionChangesModal(this.app, {
			onSaveNew: async () => {
				await this.saveVersionNote(version, false);
				await this.options.store.setSelected(this.entry!, version.id, false);
				await this.refresh();
			},
			onOverwrite: async () => {
				await this.saveVersionNote(version, true);
				await this.options.store.setSelected(this.entry!, version.id, false);
				await this.refresh();
			},
			onDiscard: async () => {
				await this.options.store.setSelected(this.entry!, version.id, false);
				await this.refresh();
			},
		}).open();
	}

	private async deleteWithPrompt(version: SavedVersion): Promise<void> {
		if (version.id === this.entry?.defaultId) {
			new Notice("Choose another default version before deleting this one.");
			return;
		}
		const modified = await this.options.store.versionModified(this.options.file, this.entry!, version.id);
		if (!modified) {
			await this.options.store.deleteVersion(this.entry!, version.id, this.options.file);
			await this.refresh();
			return;
		}
		new ManagedVersionChangesModal(this.app, {
			onSaveNew: async () => {
				await this.saveVersionNote(version, false);
				await this.options.store.deleteVersion(this.entry!, version.id, this.options.file);
				await this.refresh();
			},
			onDiscard: async () => {
				await this.options.store.deleteVersion(this.entry!, version.id, this.options.file);
				await this.refresh();
			},
		}).open();
	}

	private async saveVersionNote(version: SavedVersion, overwrite: boolean): Promise<void> {
		const path = versionNotePath(this.entry!, version);
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

	private promptNewVersion(): void {
		const versions = this.entry?.versions ?? [];
		const highest = versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), -1);
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
			});
			this.selectionDirty = false;
			await this.refresh();
			this.options.onChanged?.();
		}).open();
	}

	private async apply(): Promise<void> {
		if (!this.entry?.versions.length) {
			new Notice("There are no saved versions to apply.");
			return;
		}
		if (this.hasUnsavedChanges()) {
			new UnsavedVersionModal(this.app, {
				onDiscard: async () => {
					await this.options.store.apply(this.options.file, this.entry!);
					this.close();
				},
				onSaveNew: async () => {
					await this.options.store.saveVersion(this.options.file, false, this.renderFingerprint);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry!);
					this.close();
				},
				onOverwrite: async () => {
					await this.options.store.saveVersion(this.options.file, true, this.renderFingerprint);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry!);
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
