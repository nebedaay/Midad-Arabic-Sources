import { App, normalizePath } from "obsidian";
import { MANAGED_CLOSE, MANAGED_OPEN } from "../sourceImport/merge";
import { writeMerged } from "../sourceImport/render";
import { YamlBuilder } from "../sourceImport/yaml";
import { annotationNotesFolder, ensureFolder, safeFileSegment, sourceRoot } from "../sourcePaths";
import { annotationLabel } from "./resolve";
import type { AnnotationStore } from "./store";
import { annotationToday } from "./store";
import { localTimestamp } from "../time";
import { noteHeadingLink } from "./text";
import type {
	AnnotationSettings,
	AnnotationUnitEntry,
	AnnotationWorkFile,
	AnnotationIndexEntry,
	SourceAnnotation,
} from "./types";

export function annotationNotePathForDir(settings: AnnotationSettings, dir: string): string {
	return normalizePath(`${annotationNotesFolder(settings)}/${safeFileSegment(dir, "Annotations")} - Annotations.md`);
}

export function annotationNotePath(work: AnnotationWorkFile, settings: AnnotationSettings): string {
	const adopted = work.key.startsWith("adopted:") || work.key.startsWith("note:");
	return annotationNotePathForDir(settings, adopted ? `Adopted - ${work.title}` : work.dir);
}

function calloutLines(markdown: string, prefix: string): string[] {
	return markdown
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => (line.trim() ? `${prefix} ${line}` : prefix.replace(/\s+$/, "")));
}

function annotationBlockId(id: string): string {
	// Obsidian block IDs are alphanumeric; the store id keeps its readable
	// `ann_` prefix, but the note's target must be `ann...` with no underscore.
	return id.replace(/[^A-Za-z0-9]/g, "") || "annotation";
}

function annotationBlock(annotation: SourceAnnotation, unitNote: string, sectionLabel?: string): string {
	const lines: string[] = [];
	const link = noteHeadingLink(unitNote, annotation.section, sectionLabel);
	lines.push(`> [!mas-annotation-${annotation.color}] ${annotationLabel(annotation.color)} · ${link}`);
	if (annotation.comment?.trim()) {
		lines.push(">");
		lines.push('> > [!mas-annotation-comment]');
		lines.push(...calloutLines(annotation.comment.trim(), "> >"));
	}
	lines.push(">");
	lines.push(...calloutLines(annotation.quoteMarkdown || annotation.quote, "> >"));
	lines.push(">");
	const modified = annotation.modified && annotation.modified !== annotation.created
		? ` · updated ${annotation.modified.slice(0, 10)}`
		: "";
	lines.push(`> <sub>added ${annotation.created.slice(0, 10)}${modified}</sub>`);
	lines.push(`^${annotationBlockId(annotation.id)}`);
	return lines.join("\n");
}

function unitLabel(work: AnnotationWorkFile, entry: AnnotationUnitEntry, article = false): string {
	const stem = entry.note.split("/").pop()?.replace(/\.md$/i, "") ?? entry.unitKey;
	if (entry.unitKey.endsWith(":hub") || entry.unitKey === "hub" || stem === work.dir) {
		return article ? "the Table of Contents" : "Table of Contents";
	}
	const prefix = `${work.dir} - `;
	return stem.startsWith(prefix) ? stem.slice(prefix.length) : stem;
}

function buildNoteBody(
	work: AnnotationWorkFile,
	units: Array<{ entry: AnnotationUnitEntry; annotations: SourceAnnotation[] }>
): string {
	const lines: string[] = [MANAGED_OPEN, "## Annotations", ""];
	let count = 0;
	for (const unit of units) {
		if (!unit.annotations.length) continue;
		count += unit.annotations.length;
		lines.push(`### On ${noteHeadingLink(unit.entry.note, "", unitLabel(work, unit.entry, true))}`, "");
		for (const annotation of unit.annotations) {
			if (annotation.anchorStatus === "orphaned") continue;
			lines.push(annotationBlock(
				annotation,
				unit.entry.note,
				annotation.section === "Chapters" ? unitLabel(work, unit.entry) : undefined
			), "");
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
	yaml.add("updated", localTimestamp());
	yaml.add("midad-up", [`[[${work.dir}]]`, "[[Midad Arabic Sources]]"]);
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
		work,
		units.map((unit) => ({ entry: unit.entry, annotations: unit.unit.annotations }))
	)}`;
	const parent = notePath.split("/").slice(0, -1).join("/");
	if (parent) await ensureFolder(app, parent);
	await writeMerged(app, notePath, { content, specs }, false, false);
	if (work.note !== notePath) {
		// Let setWorkNote see the old value; mutating the cached work first made it
		// return without writing, leaving adopted works with an empty note path.
		await store.setWorkNote(workKey, notePath);
		work.note = notePath;
	}
	return notePath;
}

export function annotationMocPath(settings: AnnotationSettings): string {
	return normalizePath(`${sourceRoot(settings)}/source-annotation.md`);
}

async function mocEntry(
	entry: AnnotationIndexEntry,
	store: AnnotationStore,
	settings: AnnotationSettings
): Promise<string[]> {
	const work = await store.getWork(entry.key);
	const notePath = entry.note || (work ? annotationNotePath(work, settings) : "");
	if (!notePath) return [];
	const annotationLink = noteHeadingLink(notePath, "", `${entry.title} Annotations`);
	const orphan = entry.orphanCount > 0 ? ` · ${entry.orphanCount} unanchored` : "";
	const plural = entry.count === 1 ? "annotation" : "annotations";
	const units = (await store.allUnits(entry.key)).filter((unit) => unit.unit.annotations.length > 0);
	if (units.length <= 1) {
		const unit = units[0];
		const sourceLink = unit
			? ` · ${noteHeadingLink(unit.entry.note, "", unitLabel(work, unit.entry))}`
			: "";
		return [`- ${annotationLink} — ${entry.count} ${plural}${orphan}${sourceLink}`];
	}
	const lines = [`- ${annotationLink} — ${entry.count} ${plural}${orphan}`];
	for (const unit of units) lines.push(`  - ${noteHeadingLink(unit.entry.note, "", unitLabel(work, unit.entry))}`);
	return lines;
}

async function mocBody(store: AnnotationStore, settings: AnnotationSettings): Promise<string> {
	const entries = Object.values(store.getIndex().works).filter((entry) => entry.count > 0);
	const groups: Array<[string, AnnotationIndexEntry[]]> = [
		["Installed", entries.filter((entry) => entry.sourceStatus === "installed")],
		["Adopted notes", entries.filter((entry) => entry.sourceStatus === "adopted")],
		["Archived", entries.filter((entry) => entry.sourceStatus === "archived")],
		["Source removed", entries.filter((entry) => entry.sourceStatus === "removed")],
	];
	const lines: string[] = [MANAGED_OPEN, "## Annotated sources", ""];
	let wrote = false;
	for (const [title, group] of groups) {
		if (!group.length) continue;
		wrote = true;
		lines.push(`### ${title}`, "");
		for (const entry of group.sort((a, b) => a.title.localeCompare(b.title))) {
			lines.push(...await mocEntry(entry, store, settings));
		}
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
	yaml.add("updated", localTimestamp());
	yaml.add("title", "Source Annotations");
	yaml.add("aliases", ["Source Annotations"]);
	const parent = settings.sourceMocParent.trim() || "Midad Arabic Sources";
	yaml.add("midad-up", parent === "Midad Arabic Sources" ? ["[[Midad Arabic Sources]]"] : [`[[${parent}]]`, "[[Midad Arabic Sources]]"]);
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
	const content = `${frontmatter}${await mocBody(store, settings)}`;
	const parent = path.split("/").slice(0, -1).join("/");
	if (parent) await ensureFolder(app, parent);
	await writeMerged(app, path, { content, specs }, false, false);
	return path;
}
