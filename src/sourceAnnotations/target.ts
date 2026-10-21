import { App, TFile, normalizePath } from "obsidian";
import type { SourceModel } from "../sourceImport/render";
import type { AdoptedNotesRegistry } from "./adopted";
import type { AnnotationTarget, AnnotationSettings, SourceStatus } from "./types";

interface ManifestWork {
	key?: string;
	collection?: string;
	id?: string | number;
	dir?: string;
	title?: string;
	status?: string;
	canonical?: boolean;
}

function workKey(work: ManifestWork): string {
	if (work.key) return work.key;
	return `${work.collection ?? "work"}:${work.id ?? ""}`;
}

function unitKey(unit: Record<string, unknown>): string {
	const kind = typeof unit.kind === "string" ? unit.kind : "unit";
	const id = typeof unit.id === "string" || typeof unit.id === "number"
		? String(unit.id)
		: (typeof unit.base === "string" ? unit.base : "");
	return `${kind}:${id}`;
}

function statusOf(work: ManifestWork): SourceStatus {
	if (work.status === "archived") return "archived";
	if (work.status === "adopted") return "adopted";
	if (work.status === "deleting") return "removed";
	return "installed";
}

/**
 * Resolve a source note to its stable work/unit identity. The fast paths are
 * the `mas-work`/`mas-unit` frontmatter properties; the fallback reads the
 * work's render model and reproduces the renderer's note-path computation.
 */
export class AnnotationTargetResolver {
	private readonly app: App;
	private readonly settings: AnnotationSettings;
	private readonly adoption: AdoptedNotesRegistry | null;
	private readonly models = new Map<string, SourceModel>();
	private manifestCache: ManifestWork[] | null = null;

	constructor(app: App, settings: AnnotationSettings, adoption: AdoptedNotesRegistry | null = null) {
		this.app = app;
		this.settings = settings;
		this.adoption = adoption;
	}

	private outRoot(): string {
		return this.settings.sourceImportRoot.trim() || "_7 Sources";
	}

	private canonicalRoot(): string {
		return this.settings.canonicalQuranFolder.trim() || `${this.outRoot()}/Quran`;
	}

	private canonicalId(): string {
		return this.settings.canonicalQuranRiwāya.trim() || "hafs";
	}

	invalidate(): void {
		this.models.clear();
		this.manifestCache = null;
	}

	private async manifest(): Promise<ManifestWork[]> {
		// Read on demand: a source can be installed or removed while the plugin
		// is running, and the manifest is small enough that a stale cache is not
		// worth the risk of failing to resolve a freshly installed work.
		try {
			const raw = await this.app.vault.adapter.read(normalizePath(".midad-arabic-sources/source-imports.json"));
			const parsed: unknown = JSON.parse(raw);
			const works = Array.isArray(parsed)
				? parsed
				: (parsed && typeof parsed === "object" && Array.isArray((parsed as { works?: unknown }).works)
					? (parsed as { works: unknown[] }).works
					: []);
			this.manifestCache = works.filter((work): work is ManifestWork => !!work && typeof work === "object");
		} catch {
			this.manifestCache = [];
		}
		return this.manifestCache;
	}

	private async model(work: ManifestWork): Promise<SourceModel | null> {
		const key = workKey(work);
		const cached = this.models.get(key);
		if (cached) return cached;
		try {
			const path = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
			const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(path));
			if (!parsed || typeof parsed !== "object") return null;
			const model = parsed as SourceModel;
			if (!model.work || !Array.isArray(model.units)) return null;
			this.models.set(key, model);
			return model;
		} catch {
			return null;
		}
	}

	private isCanonicalQuran(model: SourceModel): boolean {
		return model.work.collection === "quran-text" && String(model.work.id) === this.canonicalId();
	}

	private findUnitByPath(model: SourceModel, path: string): string | null {
		const dir = String(model.work.dir ?? "");
		const isQuranText = model.work.collection === "quran-text";
		const canonical = isQuranText && this.isCanonicalQuran(model);
		const normalized = normalizePath(path);
		for (const unit of model.units) {
			const dictRoot = model.work.collection === "dictionary" && unit.kind === "dict";
			const base = String(unit.base ?? "");
			const stem = canonical || dictRoot ? base : `${dir} - ${base}`;
			const folder = canonical ? this.canonicalRoot() : `${this.outRoot()}/${dir}`;
			if (normalizePath(`${folder}/${stem}.md`) === normalized) return unitKey(unit);
		}
		return null;
	}

	/** The current note path for a unit, derived from the render model. */
	async notePathForUnit(workKeyValue: string, unitKeyValue: string): Promise<string | null> {
		const works = await this.manifest();
		const work = works.find((candidate) => workKey(candidate) === workKeyValue);
		if (!work) return null;
		const model = await this.model(work);
		if (!model) return null;
		const dir = String(model.work.dir ?? "");
		const isQuranText = model.work.collection === "quran-text";
		const canonical = isQuranText && this.isCanonicalQuran(model);
		for (const unit of model.units) {
			if (unitKey(unit) !== unitKeyValue) continue;
			const dictRoot = model.work.collection === "dictionary" && unit.kind === "dict";
			const base = String(unit.base ?? "");
			const stem = canonical || dictRoot ? base : `${dir} - ${base}`;
			const folder = canonical ? this.canonicalRoot() : `${this.outRoot()}/${dir}`;
			return normalizePath(`${folder}/${stem}.md`);
		}
		return null;
	}

	async resolve(path: string): Promise<AnnotationTarget | null> {
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) return null;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const masWork = typeof frontmatter?.["mas-work"] === "string" ? String(frontmatter["mas-work"]) : "";
		const masUnit = typeof frontmatter?.["mas-unit"] === "string" ? String(frontmatter["mas-unit"]) : "";

		// Known transcriptions/translations are registered without touching their
		// YAML or filenames.
		const adopted = this.adoption?.get(normalized);
		if (adopted) {
			return {
				workKey: adopted.workKey,
				unitKey: adopted.unitKey,
				notePath: normalized,
				workTitle: adopted.workTitle,
				workDir: adopted.workDir,
				sourceStatus: "adopted",
			};
		}

		const works = await this.manifest();
		const outRoot = this.outRoot();
		let work = works.find((candidate) => workKey(candidate) === masWork) ?? null;
		if (!work) {
			work = works.find((candidate) => {
				const dir = String(candidate.dir ?? "");
				if (!dir) return false;
				return normalized === normalizePath(`${outRoot}/${dir}.md`) ||
					normalized.startsWith(normalizePath(`${outRoot}/${dir}/`));
			}) ?? null;
		}

		if (!work && masWork) {
			const base = normalized.split("/").pop()?.replace(/\.md$/i, "") ?? masWork;
			const title = typeof frontmatter?.title === "string" ? frontmatter.title : base;
			work = { key: masWork, title, dir: base, status: "adopted" };
		}
		if (!work) return null;

		const dir = String(work.dir ?? "");
		const hubPath = normalizePath(`${outRoot}/${dir}.md`);
		const isHub = normalized === hubPath;

		const resolvedUnit = masUnit || (masWork ? "note" : "");
		if (resolvedUnit) {
			return {
				workKey: workKey(work),
				unitKey: resolvedUnit,
				notePath: normalized,
				workTitle: String(work.title ?? dir ?? workKey(work)),
				workDir: dir,
				sourceStatus: statusOf(work),
			};
		}

		const model = await this.model(work);
		if (model) {
			if (isHub) {
				const unit = model.units.length === 1 ? unitKey(model.units[0]) : "hub";
				return {
					workKey: workKey(work),
					unitKey: unit,
					notePath: normalized,
					workTitle: String(work.title ?? dir ?? workKey(work)),
					workDir: dir,
					sourceStatus: statusOf(work),
				};
			}
			const unit = this.findUnitByPath(model, normalized);
			if (unit) {
				return {
					workKey: workKey(work),
					unitKey: unit,
					notePath: normalized,
					workTitle: String(work.title ?? dir ?? workKey(work)),
					workDir: dir,
					sourceStatus: statusOf(work),
				};
			}
		}

		if (isHub) {
			return {
				workKey: workKey(work),
				unitKey: "hub",
				notePath: normalized,
				workTitle: String(work.title ?? dir ?? workKey(work)),
				workDir: dir,
				sourceStatus: statusOf(work),
			};
		}
		return null;
	}

	async metaForWork(workKeyValue: string, notePath: string): Promise<{ title: string; dir: string; note: string } | null> {
		const works = await this.manifest();
		const work = works.find((candidate) => workKey(candidate) === workKeyValue);
		const dir = String(work?.dir ?? notePath.split("/").slice(-2, -1)[0] ?? workKeyValue);
		const title = String(work?.title ?? dir);
		return { title, dir, note: "" };
	}
}
