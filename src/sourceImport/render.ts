import { App, TFile, normalizePath } from "obsidian";
import { makeEngine, SourceTemplateEngine } from "./engine";
import { YamlFieldSpec } from "./yaml";
import { joinNote, mergeFrontmatter, mergeNote, splitNote, substantiveContentDiffers } from "./merge";
import { ensureFolder } from "../sourcePaths";

/** Loosely-typed JSON data: importer work/unit models (fields are template-driven). */
export type JsonObject = Record<string, any>;

/**
 * Turns an acquisition render-model (produced by
 * src/midad-arabic-sources/scripts/text-source-import.py) into Obsidian notes using
 * editable ETA templates, merging into existing notes so user edits survive.
 */

export interface SourceModel {
	schema: number;
	generated: string;
	work: JsonObject;
	units: Array<JsonObject>;
}

export interface TemplateSet {
	source: string;
	hadith: string;
	quran: string;
	dictionary: string;
	dictionaryIndex: string;
	book: string;
	bookVolume: string;
	hub: string;
	moc: string;
	sources: string;
}

export interface RenderOutput {
	content: string;
	specs: YamlFieldSpec[];
}

export interface RenderProgress {
	/** 0-based index of the work being rendered. */
	index: number;
	/** How many works are in this batch. */
	total: number;
	/** Human label of the work currently being rendered. */
	work: string;
	/** Steps finished within the current work (its units, then its hub). */
	step: number;
	/** Steps in the current work. */
	steps: number;
}

export interface MocSection {
	name: string;
	works: Array<JsonObject>;
}

export const TEMPLATE_FILES: Record<keyof TemplateSet, string> = {
	source: "source-note.eta.md",
	hadith: "hadith-note.eta.md",
	quran: "quran-note.eta.md",
	dictionary: "dictionary-note.eta.md",
	dictionaryIndex: "dictionary-index.eta.md",
	book: "book-note.eta.md",
	bookVolume: "book-volume.eta.md",
	hub: "hub.eta.md",
	moc: "moc.eta.md",
	sources: "sources.eta.md",
};

export const TEMPLATE_FOLDER = "midad-arabic-sources-import-templates";

export function vaultRelative(vaultPath: string, abs: string): string {
	if (vaultPath && abs.startsWith(vaultPath)) {
		return normalizePath(abs.slice(vaultPath.length + 1));
	}
	return normalizePath(abs);
}

async function readVaultFile(app: App, path: string): Promise<string | null> {
	try {
		const p = normalizePath(path);
		if (await app.vault.adapter.exists(p)) return await app.vault.adapter.read(p);
	} catch {
		/* ignore */
	}
	return null;
}

/** Read the four templates: user folder first, then the bundled defaults. */
export async function loadTemplates(app: App, bundledDir: string, userDir: string | null): Promise<TemplateSet> {
	const out: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, file] of Object.entries(TEMPLATE_FILES)) {
		let text: string | null = null;
		if (userDir) text = await readVaultFile(app, `${userDir}/${TEMPLATE_FOLDER}/${file}`);
		if (text == null || text.trim() === "") text = await readVaultFile(app, `${bundledDir}/${file}`);
		if (text == null || text.trim() === "") missing.push(file);
		out[key] = text ?? "";
	}
	if (missing.length) {
		throw new Error(`Import template(s) not found: ${missing.join(", ")} (looked in ${bundledDir}).`);
	}
	return out as unknown as TemplateSet;
}

function renderTemplate(engine: SourceTemplateEngine, tpl: string, data: Record<string, unknown>): RenderOutput {
	const content = engine.renderString(tpl, data);
	const specs = (data.__yamlSpecs as YamlFieldSpec[]) ?? [];
	return { content, specs };
}

export function renderUnit(engine: SourceTemplateEngine, templates: TemplateSet, model: SourceModel, unit: JsonObject): RenderOutput {
	const tpl = unit.kind === "hadith" ? templates.hadith
		: unit.kind === "quran" ? templates.quran
		: unit.kind === "dict" ? templates.dictionary
		: unit.kind === "dict-index" ? templates.dictionaryIndex
		: unit.kind === "book" ? templates.book
		: unit.kind === "book-volume" ? templates.bookVolume
		: templates.source;
	return renderTemplate(engine, tpl, {
		work: model.work,
		unit,
		units: model.units,
		layout: model.work.layout,
		generated: model.generated,
	});
}

export function renderHub(engine: SourceTemplateEngine, templates: TemplateSet, model: SourceModel, singleUnit?: JsonObject): RenderOutput {
	return renderTemplate(engine, templates.hub, {
		work: model.work,
		units: model.units,
		unit: singleUnit,
		layout: model.work.layout,
		generated: model.generated,
	});
}

/** Render only a template's YAML-building block, through end_YAML(). */
function renderYamlTemplate(engine: SourceTemplateEngine, tpl: string, data: Record<string, unknown>): RenderOutput {
	const marker = "end_YAML()";
	const idx = tpl.lastIndexOf(marker);
	if (idx < 0) return renderTemplate(engine, tpl, data);
	const close = tpl.indexOf("%>", idx);
	const end = close < 0 ? tpl.length : close + 2;
	return renderTemplate(engine, tpl.slice(0, end), data);
}

export function renderUnitYaml(engine: SourceTemplateEngine, templates: TemplateSet, model: SourceModel, unit: JsonObject): RenderOutput {
	const tpl = unit.kind === "hadith" ? templates.hadith
		: unit.kind === "quran" ? templates.quran
		: unit.kind === "dict" ? templates.dictionary
		: unit.kind === "dict-index" ? templates.dictionaryIndex
		: unit.kind === "book" ? templates.book
		: unit.kind === "book-volume" ? templates.bookVolume
		: templates.source;
	return renderYamlTemplate(engine, tpl, {
		work: model.work,
		unit,
		units: model.units,
		layout: model.work.layout,
		generated: model.generated,
	});
}

export function renderHubYaml(engine: SourceTemplateEngine, templates: TemplateSet, model: SourceModel, singleUnit?: JsonObject): RenderOutput {
	return renderYamlTemplate(engine, templates.hub, {
		work: model.work,
		units: model.units,
		unit: singleUnit,
		layout: model.work.layout,
		generated: model.generated,
	});
}

/** The note paths a model is expected to occupy (its hub plus its unit notes). */
export function expectedNotePaths(
	model: SourceModel,
	outRoot: string,
	canonicalRoot: string,
	canonicalId: string
): string[] {
	const dir = model.work.dir as string;
	const isQuranText = model.work.collection === "quran-text";
	const isCanonical = isQuranText && String(model.work.id) === canonicalId;
	// Dictionary *root* notes keep unprefixed names (the vault already names them
	// `HW …`); a dictionary's letter-index notes are prefixed like any other unit.
	const unprefixed = (unit: JsonObject) =>
		isCanonical || (model.work.collection === "dictionary" && unit.kind === "dict");
	const paths = [`${outRoot}/${dir}.md`];
	const singleUnit = model.units.length === 1 ? model.units[0] : undefined;
	if (singleUnit && !isQuranText) return paths;
	for (const unit of model.units) {
		const path = isCanonical && canonicalRoot
			? `${canonicalRoot}/${unit.base}.md`
			: unprefixed(unit)
				? `${outRoot}/${dir}/${unit.base}.md`
				: `${outRoot}/${dir}/${dir} - ${unit.base}.md`;
		paths.push(path);
	}
	return paths;
}

/** Group works into their MOC sections, dropping sections with no works. */
/** Collapse the two Qurʾān category MOCs into one. */
export function canonicalMocName(name: string): string {
	if (name === "Qurʾān (text)" || name === "Qurʾān Translations") return "Qurʾān text and translations";
	return name;
}

/** Rewrite old Qurʾān MOC links in generated `up` lists. */
export function canonicalMocLink(value: string): string {
	return value.replace(/\[\[(Qurʾān \(text\)|Qurʾān Translations)(?=\]\||\]\])/g, "[[Qurʾān text and translations");
}

export function buildMocSections(works: Array<JsonObject>): MocSection[] {
	const order: string[] = [];
	const map = new Map<string, Array<JsonObject>>();
	for (const w of works) {
		for (const s of (w.moc_sections as string[]) ?? []) {
			let arr = map.get(s);
			if (!arr) {
				arr = [];
				map.set(s, arr);
				order.push(s);
			}
			arr.push(w);
		}
	}
	const rank = (name: string): number => {
		const lower = name.toLocaleLowerCase();
		if (lower.includes("arabic")) return 0;
		if (lower.includes("english")) return 2;
		return 1;
	};
	return order
		.slice()
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
		.map((name) => ({
			name,
			works: (map.get(name) ?? []).slice().sort((a, b) => String(a.title).localeCompare(String(b.title))),
		}));
}

export async function writeNote(app: App, path: string, content: string): Promise<void> {
	const p = normalizePath(path);
	const existing = app.vault.getAbstractFileByPath(p);
	if (existing instanceof TFile) await app.vault.modify(existing, content);
	else await app.vault.create(p, content);
}

/** Every markdown file directly inside a folder (adapter paths). */
async function listMarkdown(app: App, folder: string): Promise<string[]> {
	try {
		const res = await (app.vault.adapter as unknown as { list(p: string): Promise<{ files?: string[] }> }).list(normalizePath(folder));
		return (res.files ?? []).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
}

/** Delete a note if it exists (used to remove orphaned single-unit notes). */
export async function deleteNote(app: App, path: string): Promise<void> {
	const p = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(p);
	if (file instanceof TFile) await app.fileManager.trashFile(file);
}

/** Write a rendered note, merging into an existing one so edits survive. */
export async function writeMerged(app: App, path: string, out: RenderOutput, force = false, replaceUnmanaged = true): Promise<void> {
	// Never blank a note: an empty render means a template failed to load.
	if (!out.content.trim()) return;
	const existing = await readVaultFile(app, path);
	if (existing == null || existing.trim() === "") {
		// New (or previously blanked) note: write the full render.
		await writeNote(app, path, out.content);
		return;
	}
	const merged = mergeNote(existing, out.content, out.specs, { managesRegion: true, replaceUnmanaged });
	if (force || substantiveContentDiffers(existing, merged)) await writeNote(app, path, merged);
}

/**
 * Update only a note's frontmatter from a YAML-only render. Returns false when
 * the note does not exist (the caller must do a full render to create it).
 */
async function writeFrontmatterOnly(app: App, path: string, out: RenderOutput): Promise<boolean> {
	const existing = await readVaultFile(app, path);
	if (existing == null || existing.trim() === "") return false;
	const prior = splitNote(existing);
	const frontmatter = mergeFrontmatter(prior.frontmatter, out.specs);
	const merged = joinNote(frontmatter, prior.body);
	if (substantiveContentDiffers(existing, merged)) await writeNote(app, path, merged);
	return true;
}

/**
 * A hash of a rendered note, ignoring the one property that changes every time.
 *
 * `updated` is rewritten on every render, so counting it would make every note look
 * changed. Everything else in the render is a function of the model and the
 * templates, which is exactly what we want to compare.
 */
export function contentHash(content: string): string {
	const stable = content.replace(/^updated:.*$/gm, "");
	let h = 0x811c9dc5;
	for (let i = 0; i < stable.length; i++) {
		h ^= stable.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * Render one model's units and hub (the category MOCs are handled separately).
 * When `onlyKinds` is set, only units of those kinds are rewritten — a change to
 * the dictionary letter-index template, say, no longer rewrites the 50,000 root
 * notes. The hub is always rewritten: its `updated` is the work's staleness
 * watermark, so a scoped render must still bump it.
 */
export async function renderModelToVault(
	app: App,
	templates: TemplateSet,
	model: SourceModel,
	outRoot: string,
	force = false,
	onStep?: (done: number, total: number) => void,
	onlyKinds?: Set<string>,
	/** Note path → hash of the content last rendered there, updated in place. */
	seen?: Map<string, string>,
	/** Checked before every note, so a long dictionary render can be stopped. */
	shouldCancel?: () => boolean,
	/** Update only YAML frontmatter; bodies are preserved. */
	yamlOnly = false
): Promise<string[]> {
	const engine = makeEngine();
	if (Array.isArray(model.work.up)) {
		model.work.up = (model.work.up as string[]).map(canonicalMocLink);
	}
	const dir = model.work.dir as string;
	const folder = `${outRoot}/${dir}`;
	const isQuranText = model.work.collection === "quran-text";
	const isCanonical = isQuranText && model.work.canonical === true;
	const canonicalRoot = typeof model.work.canonical_root === "string" ? model.work.canonical_root : "";
	const written: string[] = [];
	const singleUnit = model.units.length === 1 ? model.units[0] : undefined;
	const todo = onlyKinds ? model.units.filter((u) => onlyKinds.has(String(u.kind))) : model.units;
	const steps = singleUnit && !isQuranText ? 1 : todo.length + 1;
	let done = 0;
	const tick = () => onStep?.(++done, steps);
	if (shouldCancel?.()) throw new Error("Source render cancelled");

	// One source of truth for each unit's note name: the same `note_stem` is used
	// for the file AND for every link to it (the hub lists `unit.note_stem`), so a
	// link can never name a note that was not written. Only the canonical riwāya
	// has unprefixed sūra notes, and they live in `canonical_root`. Every unit's
	// stem is set even for a scoped render, because the hub links to all of them.
	for (const unit of model.units) {
		const dictRoot = model.work.collection === "dictionary" && unit.kind === "dict";
		const base = String(unit.base);
		unit.note_stem = (isCanonical || dictRoot) ? base : `${dir} - ${base}`;
		unit.note_folder = isCanonical && canonicalRoot ? canonicalRoot : folder;
		// A book volume note lists its chapters; give each the same authoritative
		// stem the chapter note itself is written under.
		for (const ch of (unit.chapters as Array<JsonObject> | undefined) ?? []) {
			ch.note_stem = `${dir} - ${String(ch.base)}`;
		}
	}

	if (singleUnit && !isQuranText) {
		// A one-unit non-Qur'ān work keeps its content in the work note.
		await deleteNote(app, `${folder}/${dir} - ${singleUnit.base}.md`);
	} else {
		if (!(isCanonical && canonicalRoot)) await ensureFolder(app, folder);
		if (isCanonical && canonicalRoot) await ensureFolder(app, canonicalRoot);
		for (const unit of todo) {
			if (shouldCancel?.()) throw new Error("Source render cancelled");
			const path = `${unit.note_folder}/${unit.note_stem}.md`;
			if (yamlOnly) {
				const yaml = renderUnitYaml(engine, templates, model, unit);
				const existing = await writeFrontmatterOnly(app, path, yaml);
				if (!existing) {
					// A missing note needs a body; create it with the full template.
					const full = renderUnit(engine, templates, model, unit);
					await writeMerged(app, path, full, force);
					seen?.set(path, contentHash(full.content));
					written.push(path);
				}
				tick();
				continue;
			}
			const content = renderUnit(engine, templates, model, unit);
			const hash = contentHash(content.content);
			// Unchanged since we last rendered it: `writeMerged` would read the note,
			// merge it and find nothing substantive to change. Skipping the read as
			// well is what makes a re-render of a 7,000-note work take seconds
			// rather than the better part of an hour.
			if (!force && seen?.get(path) === hash) {
				tick();
				continue;
			}
			await writeMerged(app, path, content, force);
			seen?.set(path, hash);
			written.push(path);
			// Remove the opposite naming variant so switching canonical is clean.
			if (isQuranText) {
				const alt = isCanonical ? `${folder}/${dir} - ${unit.base}.md` : `${folder}/${unit.base}.md`;
				await deleteNote(app, alt);
			}
			tick();
		}
		// A dictionary's root note name encodes its transliteration, so fixing or
		// changing the romanisation *renames* notes. Prune the stale `<prefix> <id> …`
		// files the old names left behind, so a re-render never doubles the corpus.
		// The prefix is per-work (`HW …` for Wehr, `LL …` for Lane).
		if (model.work.collection === "dictionary") {
			const keep = new Set(model.units.map((u) => `${u.note_stem}.md`));
			const prefix = String(model.work.note_prefix || "HW").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const stale = new RegExp(`^${prefix} \\d+ `);
			for (const f of await listMarkdown(app, folder)) {
				const base = f.split("/").pop() ?? "";
				if (stale.test(base) && !keep.has(base)) {
					await deleteNote(app, f);
					seen?.delete(f);
				}
			}
		}
	}
	const hubPath = `${outRoot}/${dir}.md`;
	if (yamlOnly) {
		const hubYaml = renderHubYaml(engine, templates, model, isQuranText ? undefined : singleUnit);
		const existing = await writeFrontmatterOnly(app, hubPath, hubYaml);
		if (!existing) {
			const full = renderHub(engine, templates, model, isQuranText ? undefined : singleUnit);
			await writeMerged(app, hubPath, full, force);
			seen?.set(hubPath, contentHash(full.content));
			written.push(hubPath);
		}
	} else {
		const hubContent = renderHub(engine, templates, model, isQuranText ? undefined : singleUnit);
		await writeMerged(app, hubPath, hubContent, force);
		seen?.set(hubPath, contentHash(hubContent.content));
		written.push(hubPath);
	}
	tick();
	return written;
}

/**
 * Render just a work's hub note. Used when only the *hub* template changed: the
 * hub is one note per work, so re-rendering every unit note for a hub-only edit
 * would be wasted work (the dictionary has 7,000+ units).
 */
export async function renderModelHub(
	app: App,
	templates: TemplateSet,
	model: SourceModel,
	outRoot: string,
	force = false
): Promise<string[]> {
	const engine = makeEngine();
	if (Array.isArray(model.work.up)) {
		model.work.up = (model.work.up as string[]).map(canonicalMocLink);
	}
	const dir = model.work.dir as string;
	const isQuranText = model.work.collection === "quran-text";
	const isCanonical = isQuranText && model.work.canonical === true;
	// The hub lists each unit by `note_stem`, so it must be set even though the
	// unit notes are not written here.
	for (const unit of model.units) {
		const dictRoot = model.work.collection === "dictionary" && unit.kind === "dict";
		const base = String(unit.base);
		unit.note_stem = (isCanonical || dictRoot) ? base : `${dir} - ${base}`;
		for (const ch of (unit.chapters as Array<JsonObject> | undefined) ?? []) {
			ch.note_stem = `${dir} - ${String(ch.base)}`;
		}
	}
	const singleUnit = model.units.length === 1 ? model.units[0] : undefined;
	const hubPath = `${outRoot}/${dir}.md`;
	await writeMerged(app, hubPath, renderHub(engine, templates, model, isQuranText ? undefined : singleUnit), force);
	return [hubPath];
}

/**
 * Render every category MOC from the full set of imported works. The generated
 * region is rewritten wholesale each time, so it always reflects exactly what
 * the plugin has imported; content outside the region is preserved.
 */
export async function renderMocs(
	app: App,
	templates: TemplateSet,
	works: Array<JsonObject>,
	outRoot: string,
	generated: string,
	parent: string,
	force = false
): Promise<string[]> {
	const engine = makeEngine();
	const groups = new Map<string, Array<JsonObject>>();
	for (const w of works) {
		// A work can belong to more than one category MOC (Turath + its type).
		const listed = (w.mocs as string[] | undefined) ?? (w.moc ? [String(w.moc)] : []);
		for (const moc of listed) {
			if (!moc) continue;
			const canonical = canonicalMocName(moc);
			let arr = groups.get(canonical);
			if (!arr) {
				arr = [];
				groups.set(canonical, arr);
			}
			arr.push(w);
		}
	}
	const written: string[] = [];
	for (const [moc, group] of groups) {
		const out = renderTemplate(engine, templates.moc, {
			moc: { name: moc },
			sections: buildMocSections(group),
			parent,
			generated,
		});
		const path = `${outRoot}/${moc}.md`;
		await writeMerged(app, path, out, force);
		written.push(path);
	}
	return written;
}

export interface SourcesMocItem {
	name: string;
	label: string;
}

export interface SourcesMocGroup {
	name: string;
	label: string;
	items: SourcesMocItem[];
}

/** Render the managed region of the top-level Sources/Midad note. */
export function renderSourcesNote(
	templates: TemplateSet,
	groups: SourcesMocGroup[],
	generated: string
): RenderOutput {
	return renderTemplate(makeEngine(), templates.sources, { groups, generated });
}

/** Render a generated MOC note whose entries are themselves MOCs or notes. */
export async function renderMocIndex(
	app: App,
	templates: TemplateSet,
	name: string,
	sections: Array<{ name: string; works: JsonObject[] }>,
	outRoot: string,
	parent: string,
	generated: string,
	force = false
): Promise<string> {
	const engine = makeEngine();
	const out = renderTemplate(engine, templates.moc, { moc: { name }, sections, parent, generated });
	const path = `${outRoot}/${name}.md`;
	await writeMerged(app, path, out, force);
	return path;
}
