import { App, TFile, normalizePath } from "obsidian";
import { makeEngine, SourceTemplateEngine } from "./engine";
import { YamlFieldSpec } from "./yaml";
import { mergeNote, substantiveContentDiffers } from "./merge";

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
	return order.map((name) => ({
		name,
		works: (map.get(name) ?? []).slice().sort((a, b) => String(a.title).localeCompare(String(b.title))),
	}));
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (!(await app.vault.adapter.exists(path))) await app.vault.createFolder(path);
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
	onlyKinds?: Set<string>
): Promise<string[]> {
	const engine = makeEngine();
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
	}

	if (singleUnit && !isQuranText) {
		// A one-unit non-Qur'ān work keeps its content in the work note.
		await deleteNote(app, `${folder}/${dir} - ${singleUnit.base}.md`);
	} else {
		await ensureFolder(app, folder);
		if (isCanonical && canonicalRoot) await ensureFolder(app, canonicalRoot);
		for (const unit of todo) {
			const path = `${unit.note_folder}/${unit.note_stem}.md`;
			await writeMerged(app, path, renderUnit(engine, templates, model, unit), force);
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
				if (stale.test(base) && !keep.has(base)) await deleteNote(app, f);
			}
		}
	}
	const hubPath = `${outRoot}/${dir}.md`;
	await writeMerged(app, hubPath, renderHub(engine, templates, model, isQuranText ? undefined : singleUnit), force);
	written.push(hubPath);
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
	const dir = model.work.dir as string;
	const isQuranText = model.work.collection === "quran-text";
	const isCanonical = isQuranText && model.work.canonical === true;
	// The hub lists each unit by `note_stem`, so it must be set even though the
	// unit notes are not written here.
	for (const unit of model.units) {
		const dictRoot = model.work.collection === "dictionary" && unit.kind === "dict";
		const base = String(unit.base);
		unit.note_stem = (isCanonical || dictRoot) ? base : `${dir} - ${base}`;
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
		const moc = w.moc as string | undefined;
		if (!moc) continue;
		let arr = groups.get(moc);
		if (!arr) {
			arr = [];
			groups.set(moc, arr);
		}
		arr.push(w);
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

/** Render the managed region of the top-level Sources note. */
export function renderSourcesNote(
	templates: TemplateSet,
	mocs: string[],
	generated: string
): RenderOutput {
	return renderTemplate(makeEngine(), templates.sources, { mocs, generated });
}
