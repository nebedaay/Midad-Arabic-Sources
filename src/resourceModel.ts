/**
 * The abstract resource model behind the sidebar's Navigation tab and the
 * Midad Arabic Sources note. Nothing in this module reads a rendered MOC: the
 * categories, entries, labels and counts are built from the manifest, the
 * local transcription/translation registry and the annotation summary, then
 * persisted to `.midad-arabic-sources/resource-model.json`.
 *
 * The sidebar and the MOC renderers both consume this model. The rendered note
 * is a projection of it, and is only used as a fallback when the JSON is
 * missing.
 */
import { App, normalizePath } from "obsidian";
import type { JsonObject } from "./sourceImport/render";

export const RESOURCE_MODEL_PATH = ".midad-arabic-sources/resource-model.json";

/** The three top-level resource categories, in display order. */
export const TOPICS_NOTE = "Midad Arabic Sources - Topics";
export const REPOSITORIES_NOTE = "Midad Arabic Sources - Repositories";
export const MY_CONTENT_NOTE = "Midad Arabic Sources - My Midad Content";

/** The local-content entries under My Midad Content. */
export const TRANSCRIPTIONS_NOTE = "Arabic transcriptions";
export const TRANSLATIONS_NOTE = "Arabic translations";
export const ANNOTATIONS_NOTE = "source-annotation";

export const MY_CONTENT_LABEL = "My Midad Content";
export const TRANSCRIPTIONS_LABEL = "My Transcriptions";
export const TRANSLATIONS_LABEL = "My Translations";
export const ANNOTATIONS_LABEL = "Annotations";

export type ResourceCategoryId = "topics" | "repositories" | "my-content";

export type ResourceEntryKind =
	| "topic"
	| "repository"
	| "transcription"
	| "translation"
	| "annotations";

export interface ResourceEntry {
	/** Stable id, e.g. `topic:Tafsīr Sources`. */
	id: string;
	kind: ResourceEntryKind;
	label: string;
	/** Note name (link target). */
	note: string;
	/** Resources represented by this entry. */
	count: number;
}

export interface ResourceCategory {
	id: ResourceCategoryId;
	label: string;
	/** Index note for the category. */
	note: string;
	/** Number of entries in the category. */
	count: number;
	entries: ResourceEntry[];
}

export interface ResourceCounts {
	/** Number of topic entries. */
	topics: number;
	/** Number of repository entries. */
	repositories: number;
	/** Number of transcription works. */
	transcriptions: number;
	/** Number of translation works. */
	translations: number;
	/** Number of annotations. */
	annotations: number;
	/** Repository works + local transcription/translation works. */
	resources: number;
}

export interface ResourceModelFile {
	schema: 1;
	generated: string;
	categories: ResourceCategory[];
	counts: ResourceCounts;
}

/** A local (non-repository) work: one transcription or translation group. */
export interface LocalResource {
	kind: "transcription" | "translation";
	/** Note basename for the group's link. */
	name: string;
	title: string;
	/** Canonical topic-MOC names the work is assigned to. */
	topics: string[];
}

export interface ResourceTopic {
	entry: ResourceEntry;
	works: JsonObject[];
	local: LocalResource[];
}

export interface ResourceRepository {
	entry: ResourceEntry;
	works: JsonObject[];
}

export interface ResourceModelBuild {
	file: ResourceModelFile;
	topics: ResourceTopic[];
	repositories: ResourceRepository[];
	transcriptions: LocalResource[];
	translations: LocalResource[];
	annotations: { count: number; works: number };
}

export interface RepositoryGroup {
	name: string;
	label: string;
	works: JsonObject[];
}

export interface BuildResourceModelInput {
	installed: JsonObject[];
	repositories: RepositoryGroup[];
	local: LocalResource[];
	annotations: { count: number; works: number };
	generated: string;
	/** Canonical topic labels for a repository work. */
	topicsForWork: (work: JsonObject) => string[];
	/** Every known topic label, including ones no installed work uses. */
	knownTopics: string[];
	/** Display label for a topic label. */
	topicLabel: (name: string) => string;
	/** Page name for a topic label. */
	topicNote: (name: string) => string;
	/** Display label for a repository MOC. */
	repositoryLabel: (name: string) => string;
}

function byLabel<T extends { entry: ResourceEntry }>(items: T[]): T[] {
	return items.slice().sort((a, b) =>
		a.entry.label.localeCompare(b.entry.label, undefined, { sensitivity: "base", numeric: true })
	);
}

/** Build the persisted model and the per-entry work lists its renderers need. */
export function buildResourceModel(input: BuildResourceModelInput): ResourceModelBuild {
	const topics = new Map<string, ResourceTopic>();
	const repositoryNames = new Set(input.repositories.map((group) => group.name));
	const ensureTopic = (name: string): ResourceTopic => {
		let topic = topics.get(name);
		if (!topic) {
			topic = {
				entry: {
					id: `topic:${name}`,
					kind: "topic",
					label: input.topicLabel(name) || name,
					note: input.topicNote(name) || name,
					count: 0,
				},
				works: [],
				local: [],
			};
			topics.set(name, topic);
		}
		return topic;
	};

	// Start with every official/user-visible topic so the Topics MOC can show
	// unused subjects too, not only the ones an installed work happens to use.
	for (const name of input.knownTopics) {
		if (name) ensureTopic(name);
	}

	for (const work of input.installed) {
		for (const name of input.topicsForWork(work)) {
			if (!name) continue;
			const topic = ensureTopic(name);
			topic.works.push(work);
			topic.entry.count += 1;
		}
	}
	for (const resource of input.local) {
		for (const name of resource.topics) {
			if (!name || repositoryNames.has(name)) continue;
			const topic = ensureTopic(name);
			topic.local.push(resource);
			topic.entry.count += 1;
		}
	}

	const topicList = byLabel([...topics.values()]).sort((a, b) =>
		Number(b.entry.count > 0) - Number(a.entry.count > 0)
		|| a.entry.label.localeCompare(b.entry.label, undefined, { sensitivity: "base", numeric: true }));
	const repositoryList = byLabel(
		input.repositories.map((group) => ({
			entry: {
				id: `repository:${group.name}`,
				kind: "repository" as const,
				label: input.repositoryLabel(group.name) || group.label || group.name,
				note: group.name,
				count: group.works.length,
			},
			works: group.works,
		}))
	);
	const transcriptions = input.local.filter((resource) => resource.kind === "transcription");
	const translations = input.local.filter((resource) => resource.kind === "translation");

	const counts: ResourceCounts = {
		topics: topicList.length,
		repositories: repositoryList.length,
		transcriptions: transcriptions.length,
		translations: translations.length,
		annotations: input.annotations.count,
		resources: repositoryList.reduce((total, group) => total + group.entry.count, 0)
			+ transcriptions.length + translations.length,
	};

	const contentEntries: ResourceEntry[] = [
		{ id: "content:transcriptions", kind: "transcription", label: TRANSCRIPTIONS_LABEL, note: TRANSCRIPTIONS_NOTE, count: transcriptions.length },
		{ id: "content:translations", kind: "translation", label: TRANSLATIONS_LABEL, note: TRANSLATIONS_NOTE, count: translations.length },
		{ id: "content:annotations", kind: "annotations", label: ANNOTATIONS_LABEL, note: ANNOTATIONS_NOTE, count: input.annotations.count },
	];

	const categories: ResourceCategory[] = [
		{ id: "topics", label: "Topics", note: TOPICS_NOTE, count: topicList.length, entries: topicList.map((topic) => topic.entry) },
		{ id: "repositories", label: "Repositories", note: REPOSITORIES_NOTE, count: repositoryList.length, entries: repositoryList.map((group) => group.entry) },
		{ id: "my-content", label: MY_CONTENT_LABEL, note: MY_CONTENT_NOTE, count: contentEntries.length, entries: contentEntries },
	];

	return {
		file: { schema: 1, generated: input.generated, categories, counts },
		topics: topicList,
		repositories: repositoryList,
		transcriptions,
		translations,
		annotations: input.annotations,
	};
}

export async function saveResourceModel(app: App, model: ResourceModelFile): Promise<void> {
	const path = normalizePath(RESOURCE_MODEL_PATH);
	const parent = path.split("/").slice(0, -1).join("/");
	try {
		if (parent && !(await app.vault.adapter.exists(parent))) await app.vault.adapter.mkdir(parent);
		await app.vault.adapter.write(path, JSON.stringify(model, null, 1) + "\n");
	} catch (error) {
		console.error("[midad-arabic-sources] resource model", error);
	}
}

/** The persisted model, or null when it is absent or from another schema. */
export async function loadResourceModel(app: App): Promise<ResourceModelFile | null> {
	try {
		const text = await app.vault.adapter.read(normalizePath(RESOURCE_MODEL_PATH));
		const parsed = JSON.parse(text) as ResourceModelFile;
		if (parsed?.schema !== 1 || !Array.isArray(parsed.categories)) return null;
		return parsed;
	} catch {
		return null;
	}
}
