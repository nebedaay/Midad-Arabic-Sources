import { App, TFile, normalizePath } from "obsidian";
import { isChildEntry, parseSourceIndex } from "./sourceIndex";
import type { ResourceModelFile } from "../resourceModel";

export interface NavigationLink {
	title: string;
	path: string;
	annotationCount: number;
	heading?: string;
	/** Resources represented (resource-model entries only). */
	count?: number;
}

export interface NavigationItem extends NavigationLink {
	current: boolean;
	children: NavigationLink[];
}

export interface NavigationData {
	parents: NavigationLink[];
	items: NavigationItem[];
	/**
	 * True when the tree is the collection index shown in the absence of a Midad
	 * note, rather than the active note's place in the hierarchy. In that mode
	 * every top-level item may carry children.
	 */
	collection?: boolean;
}

type CountForPath = (path: string) => number;

function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
	return app.metadataCache.getFileCache(file)?.frontmatter ?? {};
}

function fileTitle(app: App, file: TFile): string {
	const title = frontmatterOf(app, file).title;
	return typeof title === "string" && title.trim() ? title.trim() : file.basename;
}

function midadUpValues(app: App, file: TFile): string[] {
	const value = frontmatterOf(app, file)["midad-up"];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

interface WikiLink {
	target: string;
}

function wikiLinks(value: string): WikiLink[] {
	const out: WikiLink[] = [];
	for (const match of value.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
		out.push({ target: match[1].trim() });
	}
	return out;
}

function resolveLink(app: App, target: string, sourcePath: string): TFile | null {
	const file = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
	return file instanceof TFile && file.extension === "md" ? file : null;
}

function parentFiles(app: App, file: TFile): TFile[] {
	const out: TFile[] = [];
	const seen = new Set<string>();
	for (const value of midadUpValues(app, file)) {
		for (const link of wikiLinks(value)) {
			const parent = resolveLink(app, link.target, file.path);
			if (!parent || seen.has(parent.path)) continue;
			seen.add(parent.path);
			out.push(parent);
		}
	}
	return out;
}

function primaryParent(app: App, file: TFile): TFile | null {
	return parentFiles(app, file)[0] ?? null;
}

function outgoingFiles(app: App, file: TFile): TFile[] {
	const links = app.metadataCache.getFileCache(file)?.links ?? [];
	const out: TFile[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		const target = resolveLink(app, link.link, file.path);
		if (!target || target.path === file.path || seen.has(target.path)) continue;
		seen.add(target.path);
		out.push(target);
	}
	return out;
}

function linkFor(app: App, file: TFile, countForPath: CountForPath, heading?: string): NavigationLink {
	return {
		title: heading ?? fileTitle(app, file),
		path: file.path,
		annotationCount: heading ? 0 : countForPath(file.path),
		heading,
	};
}

function documentType(app: App, file: TFile): string {
	const rawType = frontmatterOf(app, file)["document-type"];
	return typeof rawType === "string" ? rawType : "";
}

function childLinks(app: App, file: TFile, countForPath: CountForPath): NavigationLink[] {
	const outgoing = outgoingFiles(app, file);
	const title = fileTitle(app, file);
	const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
	const sections = (): NavigationLink[] => headings
		.filter((heading, index) => !(index === 0 && heading.level === 1 && heading.heading.trim() === title))
		.map((heading) => linkFor(app, file, countForPath, heading.heading));

	const type = documentType(app, file);
	if (type.includes("source-annotation")) return sections();
	if (!type.includes("text-source")) {
		return outgoing.length ? outgoing.map((child) => linkFor(app, child, countForPath)) : sections();
	}

	const children = outgoing.filter((child) => primaryParent(app, child)?.path === file.path);
	if (children.length) return children.map((child) => linkFor(app, child, countForPath));
	return sections();
}

function currentItem(
	app: App,
	file: TFile,
	countForPath: CountForPath,
	children: NavigationLink[]
): NavigationItem {
	return {
		...linkFor(app, file, countForPath),
		current: true,
		children,
	};
}

/** Build the parent/sibling/child list shown in the sidebar's Navigation tab. */
export function buildNavigationData(
	app: App,
	path: string,
	countForPath: CountForPath
): NavigationData | null {
	const normalized = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(normalized);
	if (!(file instanceof TFile) || file.extension !== "md") return null;

	const parents = parentFiles(app, file).map((parent) => linkFor(app, parent, countForPath));
	const primary = parentFiles(app, file)[0] ?? null;
	const current = currentItem(app, file, countForPath, childLinks(app, file, countForPath));
	if (!primary) return { parents, items: [current] };

	const siblings = outgoingFiles(app, primary);
	const items: NavigationItem[] = [];
	let found = false;
	for (const sibling of siblings) {
		if (sibling.path === file.path) {
			items.push(current);
			found = true;
			continue;
		}
		items.push({
			...linkFor(app, sibling, countForPath),
			current: false,
			children: [],
		});
	}
	if (!found) items.unshift(current);
	return { parents, items };
}

/**
 * The collection index shown when no Midad note is in context: the groups and
 * entries of the parent note's managed `mas-sources-list` callout. Reading the
 * note itself keeps the sidebar in step with what the note displays. The groups
 * (By Topic, By Source, Annotations) are siblings; their MOC entries are
 * children.
 */
export async function buildCollectionNavigation(
	app: App,
	parentName: string,
	countForPath: CountForPath
): Promise<NavigationData | null> {
	const parent = app.metadataCache.getFirstLinkpathDest(parentName, "");
	if (!(parent instanceof TFile)) return null;
	const text = await app.vault.cachedRead(parent);

	const items: NavigationItem[] = [];
	let group: NavigationItem | null = null;
	for (const entry of parseSourceIndex(text)) {
		const file = resolveLink(app, entry.target, parent.path);
		if (!file) continue;
		const link: NavigationLink = {
			...linkFor(app, file, countForPath),
			title: entry.label || fileTitle(app, file),
		};
		if (isChildEntry(entry)) {
			group?.children.push(link);
			continue;
		}
		group = { ...link, current: false, children: [] };
		items.push(group);
	}
	if (!items.length) return null;
	return { parents: [], items, collection: true };
}

/**
 * The resource browser built from the persisted model: the three categories,
 * their entries, and the cached counts. The rendered MOC is only a fallback for
 * when the model JSON is absent.
 */
export function buildResourceNavigation(
	app: App,
	model: ResourceModelFile,
	countForPath: CountForPath
): NavigationData | null {
	const items: NavigationItem[] = [];
	for (const category of model.categories) {
		const categoryFile = app.metadataCache.getFirstLinkpathDest(category.note, "");
		const base = categoryFile instanceof TFile
			? linkFor(app, categoryFile, countForPath)
			: { title: category.label, path: "", annotationCount: 0 };
		const item: NavigationItem = {
			...base,
			title: category.label,
			count: category.count,
			current: false,
			children: [],
		};
		for (const entry of category.entries) {
			const file = app.metadataCache.getFirstLinkpathDest(entry.note, "");
			if (!(file instanceof TFile)) continue;
			item.children.push({
				...linkFor(app, file, countForPath),
				title: entry.label,
				count: entry.count,
			});
		}
		items.push(item);
	}
	if (!items.length) return null;
	return { parents: [], items, collection: true };
}
