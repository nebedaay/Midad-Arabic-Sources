import { App, normalizePath } from "obsidian";
import { MANAGED_CLOSE, MANAGED_OPEN } from "../sourceImport/merge";
import { writeMerged } from "../sourceImport/render";
import { YamlBuilder } from "../sourceImport/yaml";
import { annotationLabel } from "./resolve";
import type { AnnotationStore } from "./store";
import { annotationToday } from "./store";
import { noteHeadingLink } from "./text";
import type {
	AnnotationSettings,
	AnnotationUnitEntry,
	AnnotationWorkFile,
	AnnotationIndexEntry,
	SourceAnnotation,
} from "./types";

function nowStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeFileStem(value: string): string {
	return value.replace(/[\\/:*?"<>|#^]/g, "-").trim() || "Annotations";
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) {
			try {
				await app.vault.adapter.mkdir(current);
			} catch {
				/* another writer may have created it */
			}
		}
	}
}

export function annotationNotePath(work: AnnotationWorkFile, settings: AnnotationSettings): string {
	const folder = settings.annotationNoteFolder.trim() || `${settings.sourceImportRoot.trim() || "_7 Sources"}/Notes`;
	return normalizePath(`${folder}/${safeFileStem(work.dir)} - Annotations.md`);
}

function calloutLines(markdown: string, prefix: string): string[] {
	return markdown
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => (line.trim() ? `${prefix} ${line}` : prefix.replace(/\s+$/, "")));
}

function annotationBlock(annotation: SourceAnnotation, unitNote: string): string {
	const lines: string[] = [];
	const link = noteHeadingLink(unitNote, annotation.section);
	lines.push(`> [!mas-annotation-${annotation.color}] ${annotationLabel(annotation.color)} · ${link}`);
	const quote = calloutLines(annotation.quoteMarkdown || annotation.quote, "> >");
	lines.push(...quote);
	if (annotation.comment?.trim()) {
		lines.push(">");
		lines.push(...calloutLines(annotation.comment.trim(), ">"));
	}
	lines.push(">");
	const modified = annotation.modified && annotation.modified !== annotation.created
		? ` · updated ${annotation.modified.slice(0, 10)}`
		: "";
	lines.push(`> <sub>added ${annotation.created.slice(0, 10)}${modified} · ^${annotation.id}</sub>`);
	return lines.join("\n");
}

function buildNoteBody(
	units: Array<{ entry: AnnotationUnitEntry; annotations: SourceAnnotation[] }>
): string {
	const lines: string[] = [MANAGED_OPEN, "## Annotations", ""];
	let count = 0;
	for (const unit of units) {
		if (!unit.annotations.length) continue;
		count += unit.annotations.length;
		const noteName = unit.entry.note.split("/").pop()?.replace(/\.md$/i, "") ?? unit.entry.unitKey;
		lines.push(`### [[${noteName}]]`, "");
		for (const annotation of unit.annotations) {
			if (annotation.anchorStatus === "orphaned") continue;
			lines.push(annotationBlock(annotation, unit.entry.note), "");
		}
	}
	const orphans = units.flatMap((unit) =>
		unit.annotations
			.filter((annotation) => annotation.anchorStatus === "orphaned")
			.map((annotation) => ({ annotation, note: unit.entry.note }))
	);
	if (orphans.length) {
		lines.push("## Unanchored", "", "*The source text changed; these quotes are preserved until they can be re-anchored.*", "");
		for (const orphan of orphans) lines.push(annotationBlock(orphan.annotation, orphan.note), "");
	}
	if (!count && !orphans.length) {
		lines.push("*No annotations yet.*", "");
	}
	lines.push(MANAGED_CLOSE, "", "## Notes", "");
	return lines.join("\n");
}

function buildNoteFrontmatter(work: AnnotationWorkFile): { frontmatter: string; specs: ReturnType<YamlBuilder["fieldSpecs"]> } {
	const yaml = new YamlBuilder();
	yaml.start();
	yaml.add("document-type", "[[source-annotation]]");
	yaml.add("created", annotationToday(), { merge: "keep" });
	yaml.add("updated", nowStamp());
	yaml.add("mas-up", [`[[${work.dir}]]`, "[[Midad Arabic Sources]]"]);
	yaml.add("related", [], { force: true, merge: "keep" });
	yaml.add("title", `${work.title} — Annotations`);
	yaml.add("aliases", [`${work.title} Annotations`, `${work.dir} - Annotations`]);
	yaml.add("source-work", work.key);
	yaml.add("source-status", work.sourceStatus);
	const counts = Object.values(work.units).reduce(
		(acc, unit) => ({ count: acc.count + unit.count, orphan: acc.orphan + unit.orphanCount }),
		{ count: 0, orphan: 0 }
	);
	yaml.add("annotation-count", counts.count);
	yaml.add("orphan-count", counts.orphan);
	yaml.add("cssclasses", ["mas-annotations"], { quote: "never" });
	const frontmatter = yaml.end();
	return { frontmatter, specs: yaml.fieldSpecs() };
}

/** Render (or refresh) one work's annotation note. Returns its path. */
export async function renderAnnotationNote(
	app: App,
	store: AnnotationStore,
	settings: AnnotationSettings,
	workKey: string
): Promise<string | null> {
	const work = await store.getWork(workKey);
	if (!work) return null;
	const notePath = work.note || annotationNotePath(work, settings);
	const units = await store.allUnits(workKey);
	const { frontmatter, specs } = buildNoteFrontmatter(work);
	const content = `${frontmatter}${buildNoteBody(
		units.map((unit) => ({ entry: unit.entry, annotations: unit.unit.annotations }))
	)}`;
	const parent = notePath.split("/").slice(0, -1).join("/");
	if (parent) await ensureFolder(app, parent);
	await writeMerged(app, notePath, { content, specs }, false, false);
	if (work.note !== notePath) {
		work.note = notePath;
		await store.setWorkNote(workKey, notePath);
	}
	return notePath;
}

export function annotationMocPath(settings: AnnotationSettings): string {
	const outRoot = settings.sourceImportRoot.trim() || "_7 Sources";
	return normalizePath(`${outRoot}/source-annotation.md`);
}

function mocEntry(entry: AnnotationIndexEntry): string {
	const noteName = entry.note.split("/").pop()?.replace(/\.md$/i, "") ?? entry.title;
	const orphan = entry.orphanCount > 0 ? ` · ${entry.orphanCount} unanchored` : "";
	const plural = entry.count === 1 ? "annotation" : "annotations";
	return `- [[${noteName}|${entry.title}]] — ${entry.count} ${plural}${orphan}`;
}

function mocBody(store: AnnotationStore): string {
	const entries = Object.values(store.getIndex().works).filter((entry) => entry.count > 0);
	const groups: Array<[string, AnnotationIndexEntry[]]> = [
		["Installed", entries.filter((entry) => entry.sourceStatus === "installed")],
		["Archived", entries.filter((entry) => entry.sourceStatus === "archived")],
		["Source removed", entries.filter((entry) => entry.sourceStatus === "removed")],
	];
	const lines: string[] = [MANAGED_OPEN, "## Annotated sources", ""];
	let wrote = false;
	for (const [title, group] of groups) {
		if (!group.length) continue;
		wrote = true;
		lines.push(`### ${title}`, "");
		for (const entry of group.sort((a, b) => a.title.localeCompare(b.title))) lines.push(mocEntry(entry));
		lines.push("");
	}
	if (!wrote) lines.push("*No annotated sources yet.*", "");
	lines.push(MANAGED_CLOSE, "", "## Notes", "");
	return lines.join("\n");
}

function mocFrontmatter(settings: AnnotationSettings): { frontmatter: string; specs: ReturnType<YamlBuilder["fieldSpecs"]> } {
	const yaml = new YamlBuilder();
	yaml.start();
	yaml.add("created", annotationToday(), { merge: "keep" });
	yaml.add("updated", nowStamp());
	yaml.add("title", "Source Annotations");
	yaml.add("aliases", ["Source Annotations"]);
	yaml.add("mas-up", [`[[${settings.sourceMocParent.trim() || "Sources"}]]`, "[[Midad Arabic Sources]]"]);
	const frontmatter = yaml.end();
	return { frontmatter, specs: yaml.fieldSpecs() };
}

/** Render the Source Annotations MOC from the derived index. */
export async function renderAnnotationMoc(
	app: App,
	store: AnnotationStore,
	settings: AnnotationSettings
): Promise<string> {
	const path = annotationMocPath(settings);
	const { frontmatter, specs } = mocFrontmatter(settings);
	const content = `${frontmatter}${mocBody(store)}`;
	const parent = path.split("/").slice(0, -1).join("/");
	if (parent) await ensureFolder(app, parent);
	await writeMerged(app, path, { content, specs }, false, false);
	return path;
}
