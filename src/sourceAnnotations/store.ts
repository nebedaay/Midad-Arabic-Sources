import { App, normalizePath } from "obsidian";
import type { AnnotationUnitFile, SourceAnnotation, SpikeAnnotationIndex } from "./types";

const INDEX_PATH = ".midad-arabic-sources/annotations/spike-index.json";
const ROOT = ".midad-arabic-sources/annotations";

function parseIndex(raw: string): SpikeAnnotationIndex {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "notes" in parsed) {
			const notes = (parsed as { notes?: unknown }).notes;
			if (notes && typeof notes === "object") {
				return { notes: notes as SpikeAnnotationIndex["notes"] };
			}
		}
	} catch {
		/* fall through to an empty index */
	}
	return { notes: {} };
}

function parseUnit(raw: string): AnnotationUnitFile | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const unit = parsed as Partial<AnnotationUnitFile>;
		if (!Array.isArray(unit.annotations)) return null;
		return {
			schema: typeof unit.schema === "number" ? unit.schema : 1,
			unitKey: typeof unit.unitKey === "string" ? unit.unitKey : "",
			note: typeof unit.note === "string" ? unit.note : "",
			annotations: unit.annotations,
		};
	} catch {
		return null;
	}
}

/**
 * Spike store: a note-path index plus one sharded unit file per annotated note.
 * The production store will key units by the render model's stable unit key and
 * rebuild this index; the read shape is deliberately the same.
 */
export class AnnotationSpikeStore {
	private readonly app: App;
	private index: SpikeAnnotationIndex | null = null;
	private readonly cache = new Map<string, SourceAnnotation[]>();

	constructor(app: App) {
		this.app = app;
	}

	async load(): Promise<void> {
		this.index = null;
		this.cache.clear();
		try {
			const path = normalizePath(INDEX_PATH);
			if (!(await this.app.vault.adapter.exists(path))) {
				this.index = { notes: {} };
				return;
			}
			this.index = parseIndex(await this.app.vault.adapter.read(path));
		} catch {
			this.index = { notes: {} };
		}
	}

	async ensure(path: string): Promise<SourceAnnotation[] | null> {
		if (!this.index) await this.load();
		const entry = this.index?.notes[path];
		if (!entry) return null;
		const cached = this.cache.get(path);
		if (cached) return cached;
		try {
			const unitPath = normalizePath(`${ROOT}/${entry.file}`);
			if (!(await this.app.vault.adapter.exists(unitPath))) return null;
			const unit = parseUnit(await this.app.vault.adapter.read(unitPath));
			if (!unit) return null;
			this.cache.set(path, unit.annotations);
			return unit.annotations;
		} catch {
			return null;
		}
	}

	async loadAll(): Promise<void> {
		if (!this.index) await this.load();
		for (const path of Object.keys(this.index?.notes ?? {})) {
			await this.ensure(path);
		}
	}

	notes(): string[] {
		return Object.keys(this.index?.notes ?? {});
	}

	get(path: string): SourceAnnotation[] | null {
		return this.cache.get(path) ?? null;
	}
}
