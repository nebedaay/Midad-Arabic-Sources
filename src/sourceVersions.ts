import { App, Menu, Modal, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as fs from "fs";
import { hashString } from "./sourceImport/history";
import { ensureFolder, safeFileSegment } from "./sourcePaths";

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

function noteKey(file: TFile, frontmatter: Record<string, unknown> | undefined): string {
	const id = typeof frontmatter?.["midad-id"] === "string" ? frontmatter["midad-id"].trim() : "";
	return id ? `id:${id}` : `path:${file.path}`;
}

function versionFile(key: string, id: string): string {
	const hash = hashString(key);
	const folder = safeFileSegment(key.replace(/^[^:]+:/, ""), "note", 60);
	return `versions/${folder}-${hash}/${id}.md`;
}

function versionNotePath(file: TFile, version: SavedVersion): string {
	const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
	const stem = file.basename;
	return normalizePath(`${folder}/${stem}.Version${versionNumber(version.id)}.md`);
}

function addVersionFrontmatter(content: string, id: string): string {
	const line = `midad-version: "${id}"`;
	if (content.startsWith("---")) {
		const end = content.indexOf("\n---", 3);
		if (end >= 0) {
			return `${content.slice(0, end + 1)}${line}\n${content.slice(end + 1)}`;
		}
	}
	return `---\n${line}\n---\n\n${content}`;
}

function hasVersionFrontmatter(content: string, id: string): boolean {
	return new RegExp(`^midad-version:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(content);
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
		const key = noteKey(file, this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined);
		return manifest.notes[key] ?? null;
	}

	async saveVersion(file: TFile, overwrite: boolean): Promise<NoteVersionEntry> {
		const manifest = this.load();
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const key = noteKey(file, frontmatter);
		const text = await this.app.vault.read(file);
		const hash = hashString(text);
		let entry = manifest.notes[key];
		if (!entry) {
			entry = {
				key,
				path: file.path,
				title: file.basename,
				defaultId: "v0",
				versions: [],
			};
			manifest.notes[key] = entry;
		}
		entry.path = file.path;
		entry.title = file.basename;
		let version: SavedVersion;
		if (overwrite && entry.versions.length) {
			version = [...entry.versions].sort((a, b) => versionNumber(a.id) - versionNumber(b.id)).at(-1) as SavedVersion;
			version.savedAt = new Date().toISOString();
			version.hash = hash;
			version.kind = "user";
			version.label = version.label || "User version";
		} else {
			const highest = entry.versions.reduce((n, v) => Math.max(n, versionNumber(v.id)), -1);
			const id = `v${highest + 1}`;
			version = {
				id,
				label: `Version ${highest + 1}`,
				kind: "user",
				savedAt: new Date().toISOString(),
				hash,
				file: versionFile(key, id),
				selected: true,
				archived: false,
			};
			entry.versions.push(version);
			if (!entry.defaultId) entry.defaultId = id;
		}
		this.files[version.file] = strToU8(text);
		this.save();
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

	async deleteVersion(entry: NoteVersionEntry, id: string): Promise<void> {
		if (entry.defaultId === id) {
			new Notice("Choose another default version before deleting this one.");
			return;
		}
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return;
		delete this.files[version.file];
		entry.versions = entry.versions.filter((v) => v.id !== id);
		this.save();
	}

	async versionText(entry: NoteVersionEntry, id: string): Promise<string | null> {
		const version = entry.versions.find((v) => v.id === id);
		if (!version) return null;
		const content = this.files[version.file];
		return content ? strFromU8(content) : null;
	}

	async apply(file: TFile, entry: NoteVersionEntry): Promise<number> {
		const defaultVersion = entry.versions.find((v) => v.id === entry.defaultId);
		if (!defaultVersion) return 0;
		const defaultText = await this.versionText(entry, defaultVersion.id);
		if (!defaultText) return 0;
		await this.writeLive(file.path, defaultText);
		let written = 1;
		for (const version of entry.versions) {
			if (!version.selected || version.id === entry.defaultId) continue;
			const text = await this.versionText(entry, version.id);
			if (!text) continue;
			const path = versionNotePath(file, version);
			await this.writeLive(path, addVersionFrontmatter(text, version.id));
			written += 1;
		}
		return written;
	}

	private async writeLive(path: string, text: string): Promise<void> {
		const normalized = normalizePath(path);
		const folder = normalized.slice(0, normalized.lastIndexOf("/"));
		if (folder) await ensureFolder(this.app, folder);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) await this.app.vault.modify(existing, text);
		else await this.app.vault.create(normalized, text);
	}
}

interface VersionModalOptions {
	app: App;
	file: TFile;
	store: VersionStore;
	onChanged?: () => void;
}

export class ManageVersionsModal extends Modal {
	private readonly options: VersionModalOptions;
	private entry: NoteVersionEntry | null = null;
	private currentHash = "";

	constructor(options: VersionModalOptions) {
		super(options.app);
		this.options = options;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mas-versions-modal");
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		this.entry = await this.options.store.entryFor(this.options.file);
		this.currentHash = hashString(await this.options.app.vault.read(this.options.file));
		this.render();
	}

	private hasChanges(): boolean {
		if (!this.entry) return true;
		const version = this.entry.versions.find((v) => v.id === this.entry?.defaultId);
		return !version || version.hash !== this.currentHash;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Manage versions" });
		contentEl.createEl("p", {
			cls: "mas-versions-desc",
			text: `Saved versions for ${this.options.file.basename}. The default version supplies the canonical note.`,
		});

		const top = contentEl.createDiv({ cls: "mas-versions-actions" });
		if (this.hasChanges() || !this.entry?.versions.length) {
			const save = top.createEl("button", { text: "Save new version", cls: "mod-cta" });
			save.onclick = async () => {
				await this.options.store.saveVersion(this.options.file, false);
				await this.refresh();
				this.options.onChanged?.();
			};
		}
		if (this.entry?.versions.length && this.hasChanges()) {
			const overwrite = top.createEl("button", { text: "Overwrite last version" });
			overwrite.onclick = async () => {
				await this.options.store.saveVersion(this.options.file, true);
				await this.refresh();
				this.options.onChanged?.();
			};
		}
		const apply = top.createEl("button", { text: "Apply" });
		apply.onclick = () => { void this.apply(); };

		const list = contentEl.createDiv({ cls: "mas-versions-list" });
		if (!this.entry?.versions.length) {
			list.createDiv({ cls: "mas-versions-empty", text: "No saved versions yet." });
			return;
		}
		for (const version of [...this.entry.versions].sort((a, b) => versionNumber(a.id) - versionNumber(b.id))) {
			const row = list.createDiv({ cls: "mas-versions-row" });
			if (version.selected) row.addClass("is-selected");
			if (version.id === this.entry.defaultId) row.addClass("is-default");
			const check = row.createEl("input", { type: "checkbox" });
			check.checked = version.selected;
			check.onchange = async () => {
				await this.options.store.setSelected(this.entry!, version.id, check.checked);
				await this.refresh();
			};
			const main = row.createDiv({ cls: "mas-versions-main" });
			main.createDiv({ cls: "mas-versions-name", text: version.id.toUpperCase() });
			main.createDiv({ cls: "mas-versions-label", text: version.label || "User version" });
			main.createDiv({ cls: "mas-versions-date", text: new Date(version.savedAt).toLocaleString() });
			if (version.id === this.entry.defaultId) {
				row.createSpan({ cls: "mas-versions-default", text: "Default" });
			}
			row.oncontextmenu = (event) => {
				event.preventDefault();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Set as default").setIcon("star").onClick(async () => {
					await this.options.store.setDefault(this.entry!, version.id);
					await this.refresh();
				}));
				menu.addItem((item) => item.setTitle("Delete version").setIcon("trash-2").onClick(async () => {
					await this.options.store.deleteVersion(this.entry!, version.id);
					await this.refresh();
				}));
				menu.showAtMouseEvent(event);
			};
		}
	}

	private async apply(): Promise<void> {
		if (!this.entry) {
			new Notice("There are no saved versions to apply.");
			return;
		}
		if (this.hasChanges()) {
			new UnsavedVersionModal(this.app, {
				onDiscard: async () => {
					await this.options.store.apply(this.options.file, this.entry!);
					this.close();
				},
				onSaveNew: async () => {
					await this.options.store.saveVersion(this.options.file, false);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry!);
					this.close();
				},
				onOverwrite: async () => {
					await this.options.store.saveVersion(this.options.file, true);
					await this.refresh();
					await this.options.store.apply(this.options.file, this.entry!);
					this.close();
				},
				onCancel: () => undefined,
			}).open();
			return;
		}
		await this.options.store.apply(this.options.file, this.entry);
		this.close();
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
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Unsaved changes" });
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
