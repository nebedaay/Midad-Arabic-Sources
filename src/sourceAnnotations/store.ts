import { App, normalizePath } from "obsidian";
import { ensureFolder as ensureVaultFolder, safeFileSegment } from "../sourcePaths";
import { localDate, localTimestamp } from "../time";
import type {
	AnnotationIndexEntry,
	AnnotationIndexFile,
	AnnotationUnitEntry,
	AnnotationUnitFile,
	AnnotationWorkFile,
	AnnotationTarget,
	SourceAnnotation,
	SourceStatus,
} from "./types";

export const ANNOTATION_ROOT = ".midad-arabic-sources/annotations";
export const ANNOTATION_INDEX = `${ANNOTATION_ROOT}/index.json`;
export const ANNOTATION_TRASH = ".midad-arabic-sources/trash/annotations";

export interface AnnotationTrashBatch {
	path: string;
	deletedAt: string;
	workKey: string;
	workTitle: string;
	count: number;
	sourceStatus: SourceStatus;
	originalNote: string;
	trashedNote: string;
}

function safeSegment(value: string): string {
	return safeFileSegment(value, "work", 100);
}

function workFolder(key: string): string {
	const parts = key.split(":");
	const collection = safeSegment(parts[0] || "work");
	const id = safeSegment(parts.slice(1).join(":") || parts[0] || "work");
	return normalizePath(`${ANNOTATION_ROOT}/${collection}/${id}`);
}

function unitFileName(unitKey: string): string {
	return `${safeSegment(unitKey.replace(":", "-"))}.json`;
}

export function annotationNow(): string {
	return localTimestamp();
}

export function annotationToday(): string {
	return localDate();
}

export function newAnnotationId(): string {
	const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID().replace(/-/g, "")
		: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
	return `ann_${uuid.slice(0, 12)}`;
}

function parseJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function normalizeAnnotation(annotation: Partial<SourceAnnotation>): SourceAnnotation {
	const now = annotationNow();
	const quote = String(annotation.quote ?? annotation.quoteText ?? "");
	return {
		id: annotation.id || newAnnotationId(),
		color: annotation.color ?? "yellow",
		quote,
		quoteText: String(annotation.quoteText ?? quote),
		quoteMarkdown: String(annotation.quoteMarkdown ?? quote),
		prefix: typeof annotation.prefix === "string" ? annotation.prefix : "",
		suffix: typeof annotation.suffix === "string" ? annotation.suffix : "",
		comment: annotation.comment,
		ordinal: Number(annotation.ordinal ?? 0),
		position: annotation.position,
		segments: annotation.segments,
		section: String(annotation.section ?? ""),
		created: String(annotation.created ?? now),
		modified: String(annotation.modified ?? now),
		anchored: String(annotation.anchored ?? now),
		anchorStatus: annotation.anchorStatus === "orphaned" ? "orphaned" : "ok",
		quoteChanged: annotation.quoteChanged === true,
		previousQuotes: Array.isArray(annotation.previousQuotes) ? annotation.previousQuotes : [],
		tags: Array.isArray(annotation.tags) ? annotation.tags : [],
	};
}

function countAnnotations(units: Record<string, AnnotationUnitEntry>): { count: number; orphanCount: number } {
	let count = 0;
	let orphanCount = 0;
	for (const unit of Object.values(units)) {
		count += unit.count;
		orphanCount += unit.orphanCount;
	}
	return { count, orphanCount };
}

/**
 * The annotation store: authoritative unit files under a per-work folder,
 * plus a derived work file and a derived global index. Only annotated units
 * have files, so a few annotations in Lane cost a few small reads, not 39 MB.
 */
export class AnnotationStore {
	private readonly app: App;
	private index: AnnotationIndexFile | null = null;
	private readonly works = new Map<string, AnnotationWorkFile>();
	private readonly units = new Map<string, AnnotationUnitFile>();
	private readonly paths = new Map<string, { workKey: string; unitKey: string }>();
	private readonly locks = new Map<string, Promise<void>>();

	constructor(app: App) {
		this.app = app;
	}

	async load(): Promise<void> {
		this.index = null;
		this.works.clear();
		this.units.clear();
		this.paths.clear();
		try {
			const path = normalizePath(ANNOTATION_INDEX);
			if (await this.app.vault.adapter.exists(path)) {
				const parsed = parseJson<AnnotationIndexFile>(await this.app.vault.adapter.read(path));
				if (parsed && parsed.works && typeof parsed.works === "object") this.index = parsed;
			}
		} catch {
			this.index = null;
		}
		if (!this.index || !Object.keys(this.index.works).length) {
			await this.rebuild();
			return;
		}
		await this.loadWorkFiles();
	}

	private async loadWorkFiles(): Promise<void> {
		for (const key of Object.keys(this.index?.works ?? {})) {
			const work = await this.readWork(key);
			if (work) {
				this.works.set(key, work);
				this.indexUnitPaths(work);
			}
		}
	}

	private indexUnitPaths(work: AnnotationWorkFile): void {
		for (const [unitKey, entry] of Object.entries(work.units)) {
			if (entry.note) this.paths.set(normalizePath(entry.note), { workKey: work.key, unitKey });
		}
	}

	private async readWork(key: string): Promise<AnnotationWorkFile | null> {
		try {
			const path = normalizePath(`${workFolder(key)}/work.json`);
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const work = parseJson<AnnotationWorkFile>(await this.app.vault.adapter.read(path));
			if (!work || !work.units || typeof work.units !== "object") return null;
			work.key = key;
			return work;
		} catch {
			return null;
		}
	}

	async rebuild(): Promise<void> {
		const works: Record<string, AnnotationIndexEntry> = {};
		this.works.clear();
		this.paths.clear();
		try {
			const roots = await this.app.vault.adapter.list(normalizePath(ANNOTATION_ROOT));
			for (const collectionFolder of roots.folders) {
				const collection = await this.app.vault.adapter.list(collectionFolder);
				for (const folder of collection.folders) {
					const workPath = normalizePath(`${folder}/work.json`);
					if (!(await this.app.vault.adapter.exists(workPath))) continue;
					const work = parseJson<AnnotationWorkFile>(await this.app.vault.adapter.read(workPath));
					if (!work || !work.key || !work.units) continue;
					this.works.set(work.key, work);
					this.indexUnitPaths(work);
					const counts = countAnnotations(work.units);
					works[work.key] = {
						key: work.key,
						title: work.title,
						dir: work.dir,
						note: work.note,
						count: counts.count,
						orphanCount: counts.orphanCount,
						sourceStatus: work.sourceStatus,
						updated: work.updated,
					};
				}
			}
		} catch {
			/* no annotation folder yet */
		}
		this.index = { schema: 1, works };
		await this.writeIndex();
	}

	private async writeIndex(): Promise<void> {
		if (!this.index) return;
		await this.writeAtomic(normalizePath(ANNOTATION_INDEX), JSON.stringify(this.index, null, 2) + "\n");
	}

	async getWork(key: string): Promise<AnnotationWorkFile | null> {
		const cached = this.works.get(key);
		if (cached) return cached;
		const work = await this.readWork(key);
		if (work) {
			this.works.set(key, work);
			this.indexUnitPaths(work);
		}
		return work;
	}

	async ensureWork(
		target: AnnotationTarget,
		notePath: string
	): Promise<AnnotationWorkFile> {
		const existing = await this.getWork(target.workKey);
		const now = annotationNow();
		const work: AnnotationWorkFile = existing ?? {
			schema: 1,
			key: target.workKey,
			title: target.workTitle,
			dir: target.workDir,
			note: notePath,
			sourceStatus: target.sourceStatus,
			created: now,
			updated: now,
			units: {},
		};
		work.title = target.workTitle || work.title;
		work.dir = target.workDir || work.dir;
		work.sourceStatus = target.sourceStatus;
		if (notePath) work.note = notePath;
		this.works.set(work.key, work);
		return work;
	}

	async saveUnit(target: AnnotationTarget, annotations: SourceAnnotation[]): Promise<void> {
		const key = `${target.workKey}::${target.unitKey}`;
		const previous = this.locks.get(target.workKey) ?? Promise.resolve();
		const next = previous.then(async () => {
			const work = await this.ensureWork(target, this.works.get(target.workKey)?.note ?? "");
			const existing = work.units[target.unitKey];
			const file = existing?.file || unitFileName(target.unitKey);
			const folder = workFolder(target.workKey);
			await this.ensureFolder(folder);
			const unitPath = normalizePath(`${folder}/${file}`);
			const clean = annotations.map((annotation) => normalizeAnnotation(annotation));
			if (existing?.note && existing.note !== target.notePath) {
				this.paths.delete(normalizePath(existing.note));
			}
			if (!clean.length) {
				if (await this.app.vault.adapter.exists(unitPath)) await this.app.vault.adapter.remove(unitPath);
				delete work.units[target.unitKey];
				this.units.delete(key);
				this.paths.delete(normalizePath(target.notePath));
			} else {
				const unit: AnnotationUnitFile = {
					schema: 1,
					unitKey: target.unitKey,
					note: target.notePath,
					annotations: clean,
				};
				await this.writeAtomic(unitPath, JSON.stringify(unit, null, 2) + "\n");
				this.units.set(key, unit);
				work.units[target.unitKey] = {
					unitKey: target.unitKey,
					note: target.notePath,
					file,
					count: clean.length,
					orphanCount: clean.filter((annotation) => annotation.anchorStatus !== "ok").length,
					ord: existing?.ord ?? Object.keys(work.units).length,
				};
				this.paths.set(normalizePath(target.notePath), {
					workKey: target.workKey,
					unitKey: target.unitKey,
				});
			}
			work.updated = annotationNow();
			await this.writeAtomic(
				normalizePath(`${folder}/work.json`),
				JSON.stringify(work, null, 2) + "\n"
			);
			const counts = countAnnotations(work.units);
			if (!this.index) this.index = { schema: 1, works: {} };
			this.index.works[work.key] = {
				key: work.key,
				title: work.title,
				dir: work.dir,
				note: work.note,
				count: counts.count,
				orphanCount: counts.orphanCount,
				sourceStatus: work.sourceStatus,
				updated: work.updated,
			};
			await this.writeIndex();
		});
		this.locks.set(target.workKey, next.catch(() => { /* keep the chain alive */ }));
		await next;
	}

	async getUnit(workKey: string, unitKey: string): Promise<AnnotationUnitFile | null> {
		const key = `${workKey}::${unitKey}`;
		const cached = this.units.get(key);
		if (cached) return cached;
		const work = await this.getWork(workKey);
		const entry = work?.units[unitKey];
		if (!work || !entry) return null;
		try {
			const path = normalizePath(`${workFolder(workKey)}/${entry.file}`);
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const unit = parseJson<AnnotationUnitFile>(await this.app.vault.adapter.read(path));
			if (!unit) return null;
			this.units.set(key, unit);
			return unit;
		} catch {
			return null;
		}
	}

	async allUnits(workKey: string): Promise<Array<{ entry: AnnotationUnitEntry; unit: AnnotationUnitFile }>> {
		const work = await this.getWork(workKey);
		if (!work) return [];
		const entries = Object.values(work.units).sort((a, b) => a.ord - b.ord);
		const out: Array<{ entry: AnnotationUnitEntry; unit: AnnotationUnitFile }> = [];
		for (const entry of entries) {
			const unit = await this.getUnit(workKey, entry.unitKey);
			if (unit) out.push({ entry, unit });
		}
		return out;
	}

	async setWorkNote(workKey: string, notePath: string): Promise<void> {
		const work = await this.getWork(workKey);
		if (!work || work.note === notePath) return;
		work.note = notePath;
		work.updated = annotationNow();
		await this.ensureFolder(workFolder(workKey));
		await this.writeAtomic(
			normalizePath(`${workFolder(workKey)}/work.json`),
			JSON.stringify(work, null, 2) + "\n"
		);
		if (this.index?.works[workKey]) {
			this.index.works[workKey].note = notePath;
			this.index.works[workKey].updated = work.updated;
			await this.writeIndex();
		}
	}

	async setSourceStatus(workKey: string, status: SourceStatus): Promise<void> {
		const work = await this.getWork(workKey);
		if (!work) return;
		if (work.sourceStatus === status) return;
		work.sourceStatus = status;
		work.updated = annotationNow();
		await this.writeAtomic(
			normalizePath(`${workFolder(workKey)}/work.json`),
			JSON.stringify(work, null, 2) + "\n"
		);
		if (this.index?.works[workKey]) {
			this.index.works[workKey].sourceStatus = status;
			this.index.works[workKey].updated = work.updated;
			await this.writeIndex();
		}
	}

	async updatePaths(
		workKey: string,
		workDir: string,
		workNote: string,
		unitNotes: Map<string, string>
	): Promise<void> {
		const work = await this.getWork(workKey);
		if (!work) return;
		work.dir = workDir || work.dir;
		if (workNote) work.note = workNote;
		for (const [unitKey, note] of unitNotes) {
			if (work.units[unitKey]) {
				this.paths.delete(normalizePath(work.units[unitKey].note));
				work.units[unitKey].note = note;
				this.paths.set(normalizePath(note), { workKey, unitKey });
			}
		}
		work.updated = annotationNow();
		await this.writeAtomic(
			normalizePath(`${workFolder(workKey)}/work.json`),
			JSON.stringify(work, null, 2) + "\n"
		);
		if (this.index?.works[workKey]) {
			this.index.works[workKey].dir = work.dir;
			this.index.works[workKey].note = work.note;
			this.index.works[workKey].updated = work.updated;
			await this.writeIndex();
		}
	}

	findTarget(path: string): { workKey: string; unitKey: string } | null {
		return this.paths.get(normalizePath(path)) ?? null;
	}

	getIndex(): AnnotationIndexFile {
		return this.index ?? { schema: 1, works: {} };
	}

	hasWorks(): boolean {
		return Object.keys(this.getIndex().works).length > 0;
	}

	async trashWork(workKey: string): Promise<string | null> {
		const work = await this.getWork(workKey);
		if (!work) return null;
		const stamp = annotationNow().replace(/[:]/g, "-").replace(" ", "T");
		const batch = normalizePath(`${ANNOTATION_TRASH}/${stamp}`);
		await this.ensureFolder(batch);
		const folder = workFolder(workKey);
		const trashedData = normalizePath(`${batch}/data`);
		try {
			if (await this.app.vault.adapter.exists(folder)) {
				await this.app.vault.adapter.rename(folder, trashedData);
			}
		} catch {
			/* leave the folder if the move fails */
		}
		let trashedNote = "";
		if (work.note) {
			const notePath = normalizePath(work.note);
			if (await this.app.vault.adapter.exists(notePath)) {
				const notesFolder = normalizePath(`${batch}/notes`);
				await this.ensureFolder(notesFolder);
				const name = notePath.split("/").pop() ?? "Annotations.md";
				trashedNote = normalizePath(`${notesFolder}/${name}`);
				try {
					await this.app.vault.adapter.rename(notePath, trashedNote);
				} catch {
					trashedNote = "";
				}
			}
		}
		const manifest = {
			schema: 1,
			deletedAt: annotationNow(),
			reason: "manual",
			workKey,
			workTitle: work.title,
			sourceStatus: work.sourceStatus,
			originalNote: work.note,
			trashedNote,
			count: countAnnotations(work.units).count,
		};
		await this.writeAtomic(
			normalizePath(`${batch}/manifest.json`),
			JSON.stringify(manifest, null, 2) + "\n"
		);
		if (this.index) {
			delete this.index.works[workKey];
			await this.writeIndex();
		}
		this.works.delete(workKey);
		for (const [key] of this.units) {
			if (key.startsWith(`${workKey}::`)) this.units.delete(key);
		}
		for (const [path, target] of this.paths) {
			if (target.workKey === workKey) this.paths.delete(path);
		}
		return batch;
	}

	async listTrash(): Promise<AnnotationTrashBatch[]> {
		try {
			const root = normalizePath(ANNOTATION_TRASH);
			if (!(await this.app.vault.adapter.exists(root))) return [];
			const listed = await this.app.vault.adapter.list(root);
			const batches: AnnotationTrashBatch[] = [];
			for (const folder of listed.folders) {
				try {
					const manifestPath = normalizePath(`${folder}/manifest.json`);
					if (!(await this.app.vault.adapter.exists(manifestPath))) continue;
					const parsed = parseJson<Partial<AnnotationTrashBatch>>(await this.app.vault.adapter.read(manifestPath));
					if (!parsed || !parsed.workKey) continue;
					batches.push({
						path: folder,
						deletedAt: String(parsed.deletedAt ?? ""),
						workKey: parsed.workKey,
						workTitle: String(parsed.workTitle ?? parsed.workKey),
						count: Number(parsed.count ?? 0),
						sourceStatus: parsed.sourceStatus ?? "removed",
						originalNote: String(parsed.originalNote ?? ""),
						trashedNote: String(parsed.trashedNote ?? ""),
					});
				} catch { /* skip a corrupt batch */ }
			}
			return batches.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
		} catch {
			return [];
		}
	}

	async restoreTrash(batchPath: string): Promise<string | null> {
		try {
			const manifestPath = normalizePath(`${batchPath}/manifest.json`);
			const parsed = parseJson<Partial<AnnotationTrashBatch>>(await this.app.vault.adapter.read(manifestPath));
			if (!parsed?.workKey) return null;
			const folder = workFolder(parsed.workKey);
			const dataPath = normalizePath(`${batchPath}/data`);
			if (await this.app.vault.adapter.exists(folder)) {
				throw new Error("The annotation store for this work already exists.");
			}
			if (await this.app.vault.adapter.exists(dataPath)) {
				await this.app.vault.adapter.rename(dataPath, folder);
			}
			if (parsed.trashedNote && parsed.originalNote) {
				const trashed = normalizePath(parsed.trashedNote);
				const original = normalizePath(parsed.originalNote);
				if (await this.app.vault.adapter.exists(trashed)) {
					if (await this.app.vault.adapter.exists(original)) {
						throw new Error("The original annotation note path is occupied.");
					}
					const parent = original.split("/").slice(0, -1).join("/");
					if (parent) await this.ensureFolder(parent);
					await this.app.vault.adapter.rename(trashed, original);
				}
			}
			await this.rebuild();
			return parsed.workKey;
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async emptyTrash(batchPath?: string): Promise<number> {
		const targets: string[] = [];
		if (batchPath) {
			targets.push(batchPath);
		} else {
			for (const batch of await this.listTrash()) targets.push(batch.path);
		}
		let removed = 0;
		for (const target of targets) {
			try {
				if (await this.app.vault.adapter.exists(normalizePath(target))) {
					await this.app.vault.adapter.rmdir(normalizePath(target), true);
					removed += 1;
				}
			} catch { /* leave it for the next attempt */ }
		}
		return removed;
	}

	async purgeTrash(days: number): Promise<number> {
		const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (const batch of await this.listTrash()) {
			const time = Date.parse(batch.deletedAt);
			if (!Number.isFinite(time) || time > cutoff) continue;
			try {
				if (await this.app.vault.adapter.exists(normalizePath(batch.path))) {
					await this.app.vault.adapter.rmdir(normalizePath(batch.path), true);
					removed += 1;
				}
			} catch { /* leave it for the next attempt */ }
		}
		return removed;
	}

	/**
	 * Migrate the Phase 0 path-keyed fixtures into the real per-work store.
	 * `resolveMeta` supplies title/dir/annotation-note path for each work.
	 */
	async migrateSpike(
		resolveMeta: (workKey: string, notePath: string) => Promise<{ title: string; dir: string; note: string } | null>
	): Promise<boolean> {
		const spikePath = normalizePath(`${ANNOTATION_ROOT}/spike-index.json`);
		if (!(await this.app.vault.adapter.exists(spikePath))) return false;
		try {
			const parsed = parseJson<{
				notes?: Record<string, { work?: string; unit?: string; file?: string }>;
			}>(await this.app.vault.adapter.read(spikePath));
			for (const [notePath, entry] of Object.entries(parsed?.notes ?? {})) {
				if (!entry.work || !entry.unit || !entry.file) continue;
				const meta = await resolveMeta(entry.work, notePath);
				if (!meta) continue;
				const oldPath = normalizePath(`${ANNOTATION_ROOT}/${entry.file}`);
				const old = parseJson<AnnotationUnitFile>(await this.app.vault.adapter.read(oldPath));
				const annotations = Array.isArray(old?.annotations)
					? old.annotations.map((annotation) => normalizeAnnotation(annotation))
					: [];
				if (!annotations.length) continue;
				const target: AnnotationTarget = {
					workKey: entry.work,
					unitKey: entry.unit,
					notePath,
					workTitle: meta.title,
					workDir: meta.dir,
					sourceStatus: "installed",
				};
				const work = await this.ensureWork(target, meta.note);
				const file = oldPath.split("/").pop() ?? unitFileName(entry.unit);
				work.units[entry.unit] = {
					unitKey: entry.unit,
					note: notePath,
					file,
					count: annotations.length,
					orphanCount: annotations.filter((annotation) => annotation.anchorStatus !== "ok").length,
					ord: Object.keys(work.units).length,
				};
				await this.writeAtomic(oldPath, JSON.stringify({ schema: 1, unitKey: entry.unit, note: notePath, annotations }, null, 2) + "\n");
				await this.writeAtomic(
					normalizePath(`${workFolder(entry.work)}/work.json`),
					JSON.stringify(work, null, 2) + "\n"
				);
				this.works.set(entry.work, work);
				this.indexUnitPaths(work);
			}
			const migrated = normalizePath(`${ANNOTATION_ROOT}/spike-index.migrated.json`);
			if (await this.app.vault.adapter.exists(migrated)) await this.app.vault.adapter.remove(migrated);
			await this.app.vault.adapter.rename(spikePath, migrated);
			await this.rebuild();
			return true;
		} catch {
			return false;
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		await ensureVaultFolder(this.app, path);
	}

	private async writeAtomic(path: string, content: string): Promise<void> {
		const normalized = normalizePath(path);
		const parent = normalized.split("/").slice(0, -1).join("/");
		if (parent) await this.ensureFolder(parent);
		// Obsidian's adapter.rename refuses to overwrite an existing destination
		// ("Destination file already exists!"), so a temp+rename is not a safe
		// replace here. Write directly, and clear a temp left by an interrupted
		// earlier attempt.
		const temp = `${normalized}.tmp`;
		if (await this.app.vault.adapter.exists(temp)) {
			try {
				await this.app.vault.adapter.remove(temp);
			} catch {
				/* ignore */
			}
		}
		await this.app.vault.adapter.write(normalized, content);
	}
}
