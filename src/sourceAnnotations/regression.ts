import { TFile, normalizePath, type App } from "obsidian";
import { AdoptedNotesRegistry } from "./adopted";
import { buildNavigationData } from "./navigation";
import { findNormalized, resolveAnnotations, visibleSegments } from "./resolve";
import { reanchorAnnotation } from "./reanchor";
import {
	bodyBounds,
	expandLinkListSelection,
	expandWikilinkSelection,
	findRenderedText,
	selectionExclusion,
} from "./text";

export interface RegressionResult {
	passed: number;
	failed: number;
	lines: string[];
}

interface FakeCache {
	links?: Array<{ link: string; displayText?: string }>;
	headings?: Array<{ level: number; heading: string }>;
}

function fakeApp(
	files: Record<string, string>,
	frontmatter: Record<string, Record<string, unknown>> = {},
	cache: Record<string, FakeCache> = {}
): App {
	const store = new Map(Object.entries(files));
	const folders = new Set<string>();
	const objects = new Map<string, TFile>();
	for (const path of store.keys()) {
		const file = new (TFile as unknown as new (path: string) => TFile)(path) as TFile & { basename: string };
		file.basename = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
		objects.set(normalizePath(path), file);
	}
	const adapter = {
		exists: async (p: string) => store.has(p) || folders.has(p) || [...store.keys()].some((k) => k.startsWith(`${p}/`)),
		read: async (p: string) => {
			const value = store.get(p);
			if (value === undefined) throw new Error(`no such file: ${p}`);
			return value;
		},
		write: async (p: string, value: string) => { store.set(p, value); },
		mkdir: async (p: string) => { folders.add(p); },
	};
	const resolveLink = (link: string, sourcePath: string): TFile | null => {
		const target = normalizePath(link.split("#")[0]);
		const direct = objects.get(target);
		if (direct) return direct;
		const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
		const local = objects.get(normalizePath(sourceDir ? `${sourceDir}/${target}` : target));
		if (local) return local;
		const basename = target.split("/").pop()?.replace(/\.md$/i, "");
		return [...objects.values()].find((file) => file.basename === basename) ?? null;
	};
	const vault = {
		adapter,
		getAbstractFileByPath: (path: string) => objects.get(normalizePath(path)) ?? null,
		getMarkdownFiles: () => [...objects.values()],
	};
	const metadataCache = {
		getFileCache: (file: TFile) => ({
			frontmatter: frontmatter[file.path] ?? {},
			links: cache[file.path]?.links ?? [],
			headings: cache[file.path]?.headings ?? [],
		}),
		getFirstLinkpathDest: (link: string, sourcePath: string) => resolveLink(link, sourcePath),
	};
	return { vault, metadataCache } as unknown as App;
}

export async function runAnnotationRegressionTests(): Promise<RegressionResult> {
	let passed = 0;
	let failed = 0;
	const lines: string[] = [];
	const check = (name: string, condition: boolean, detail = ""): void => {
		if (condition) {
			passed++;
			lines.push(`PASS ${name}`);
		} else {
			failed++;
			lines.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
		}
	};

	const prose = "The Prophet said: “The best of you are those who learn the Qur’an.”";
	check("plain prose is not excluded", selectionExclusion(prose, 0, prose.length) === null);

	const fenced = "text\n```ts\nconst x = 1;\n```\nmore";
	const codeAt = fenced.indexOf("const");
	check("fenced code is excluded", selectionExclusion(fenced, codeAt, codeAt + 5) === "fenced-code");
	check("text beside fenced code is allowed", selectionExclusion(fenced, 0, 4) === null);

	const inline = "before `code` after";
	const inlineAt = inline.indexOf("code");
	check("inline code is excluded", selectionExclusion(inline, inlineAt, inlineAt + 4) === "inline-code");
	check("text beside inline code is allowed", selectionExclusion(inline, 0, 6) === null);

	const table = "intro\n| a | b |\n| --- | --- |\n| 1 | 2 |\noutro";
	const tableAt = table.indexOf("| 1");
	check("table rows are excluded", selectionExclusion(table, tableAt, tableAt + 5) === "table");
	check("text beside a table is allowed", selectionExclusion(table, 0, 5) === null);
	check("a pipe line without a delimiter is not a table", selectionExclusion("a | b\nplain", 0, 5) === null);

	const listText = "intro\n- [[A|1]]\n- [[B|2]]\ntail";
	const firstLink = listText.indexOf("- [[A");
	const secondLink = listText.indexOf("- [[B");
	const expanded = expandLinkListSelection(listText, firstLink + 3, secondLink + 4);
	check("link-list selection expands to complete lines",
		expanded.from === firstLink && expanded.to === secondLink + "- [[B|2]]".length);

	const linkText = "Text text [[Part of a link]] tail";
	const linkStart = linkText.indexOf("[[");
	const linkEnd = linkText.indexOf("]]") + 2;
	const partAt = linkText.indexOf("Part");
	const partialLink = expandWikilinkSelection(linkText, partAt, partAt + "Part of".length);
	check("selection inside a wikilink expands to the whole link",
		partialLink.from === linkStart && partialLink.to === linkEnd);
	const spanningLink = expandWikilinkSelection(linkText, 0, partAt + 4);
	check("selection ending inside a wikilink expands its end",
		spanningLink.from === 0 && spanningLink.to === linkEnd);
	const startingLink = expandWikilinkSelection(linkText, partAt, linkText.length);
	check("selection starting inside a wikilink expands its start",
		startingLink.from === linkStart && startingLink.to === linkText.length);
	const imageText = "Before ![[image.png|alt]] after";
	const imageStart = imageText.indexOf("![[");
	const imageEnd = imageText.indexOf("]]") + 2;
	const imagePart = expandWikilinkSelection(imageText, imageText.indexOf("image"), imageText.indexOf("image") + 3);
	check("embedded image selection expands as one link",
		imagePart.from === imageStart && imagePart.to === imageEnd);

	const renderedRaw = "The **best** of [you](https://example.com) are [[chapter|here]].";
	const rendered = findRenderedText(renderedRaw, "The best of you are here.");
	check("rendered selection maps to raw markdown",
		!!rendered && renderedRaw.slice(rendered.start, rendered.end) === "The **best** of [you](https://example.com) are [[chapter|here]].");

	const withFront = "---\ntitle: Test\n---\n\n# Heading\n\nBody text.";
	const body = bodyBounds(withFront);
	check("body bounds skip frontmatter", !!body && withFront.slice(body.contentStart, body.contentEnd).includes("Body text"));

	const exact = "A the word here and the word there.";
	const hit = findNormalized(exact, "the word", 1);
	check("normalized search honours ordinal", !!hit && exact.slice(hit.start, hit.end) === "the word");
	check("visible segments trim list markers", visibleSegments("- one\n- two", 0, 11).length === 2);

	const resolved = resolveAnnotations("one\n- quoted text\nthree", [{
		id: "a", color: "yellow", quote: "- quoted text", quoteText: "quoted text", quoteMarkdown: "- quoted text",
		ordinal: 0, section: "", created: "", modified: "", anchored: "", anchorStatus: "ok", quoteChanged: false,
	}], false);
	check("resolver finds a quote", resolved.length === 1 && resolved[0].ranges.length === 1);

	const oldQuote = "learn the Qur’an and teach it";
	const original = "The Prophet said: “The best of you are those who learn the Qur’an and teach it.” Then he left.";
	const annotation = {
		id: "a", color: "yellow" as const, quote: oldQuote, quoteText: oldQuote, quoteMarkdown: oldQuote,
		prefix: "The Prophet said: “The best of you are those who ", suffix: ".” Then he left.",
		ordinal: 0, section: "", created: "", modified: "", anchored: "", anchorStatus: "ok" as const, quoteChanged: false,
	};
	const exactMatch = reanchorAnnotation(original, annotation);
	check("re-anchor finds an exact quote", !!exactMatch && exactMatch.method === "exact");
	const changed = original.replace("learn", "study");
	const fuzzyMatch = reanchorAnnotation(changed, annotation);
	check("re-anchor recovers a changed word", !!fuzzyMatch && changed.slice(fuzzyMatch.start, fuzzyMatch.end) === "study the Qur’an and teach it");
	check("re-anchor refuses a deleted quote", reanchorAnnotation("Nothing here.", annotation) === null);

	const known = {
		"_2 Bibliographic notes/@demo - transcription.md": "---\ntitle: Demo Book\n---\n",
		"_2 Bibliographic notes/@demo - transcription - v. 2 - Variant.md": "text",
		"_2 Bibliographic notes/@demo - translation - v. 2.md": "translation",
	};
	const app = fakeApp(known, {
		"_2 Bibliographic notes/@demo - transcription.md": { title: "Demo Book" },
	});
	const registry = new AdoptedNotesRegistry(app);
	await registry.load();
	await registry.scanKnownNotes();
	const entries = registry.all();
	check("adoption scanner registers known notes", entries.length === 3);
	check("transcription volumes share one work", new Set(entries.filter((e) => e.kind === "transcription").map((e) => e.workKey)).size === 1);
	check("translation is a separate work", entries.filter((e) => e.kind === "translation").every((e) => e.workKey !== entries.find((x) => x.kind === "transcription")?.workKey));
	check("hub title is used for the series", entries.some((e) => e.workTitle === "Transcription - Demo Book"));

	const recovered = new AdoptedNotesRegistry(fakeApp({}));
	await recovered.restoreFromStore(
		"adopted:recovered",
		"Transcription - Recovered",
		"@recovered - transcription",
		[{ path: "_2 Bibliographic notes/@recovered - transcription.md", unitKey: "note", ord: 0 }]
	);
	check("adoption registry can be rebuilt from the store",
		!!recovered.get("_2 Bibliographic notes/@recovered - transcription.md"));

	const oldPath = "_2 Bibliographic notes/@demo - transcription - v. 2 - Variant.md";
	const newPath = "_2 Bibliographic notes/@demo - transcription - v. 2 - Renamed.md";
	await registry.rename(oldPath, newPath);
	check("adopted note rename updates the locator", !!registry.get(newPath) && !registry.get(oldPath));

	const navigation = buildNavigationData(
		fakeApp(
			{
				"Root.md": "",
				"A.md": "",
				"B.md": "",
				"A1.md": "",
				"A2.md": "",
			},
			{
				"Root.md": { title: "Root" },
				"A.md": { title: "A", "midad-up": ["[[Root]]"] },
				"B.md": { title: "B", "midad-up": ["[[Root]]"] },
				"A1.md": { title: "A1", "midad-up": ["[[A]]"], "document-type": "[[text-source]]" },
				"A2.md": { title: "A2", "midad-up": ["[[A]]"] },
			},
			{
				"Root.md": { links: [{ link: "A" }, { link: "B" }] },
				"A.md": { links: [{ link: "A1" }, { link: "A2" }] },
				"A1.md": { headings: [{ level: 2, heading: "One" }, { level: 2, heading: "Two" }] },
			}
		),
		"A.md",
		(path) => path === "A1.md" ? 2 : 0
	);
	check("navigation finds midad-up parents", navigation?.parents[0]?.title === "Root");
	check("navigation lists siblings in parent order",
		navigation?.items.map((item) => item.title).join(",") === "A,B");
	check("navigation marks the current note",
		navigation?.items.find((item) => item.current)?.title === "A");
	check("navigation adds child notes to the current item",
		navigation?.items.find((item) => item.current)?.children.map((item) => item.title).join(",") === "A1,A2");
	check("navigation carries per-note annotation counts",
		navigation?.items.find((item) => item.current)?.children
			.find((item) => item.title === "A1")?.annotationCount === 2);

	const contentNavigation = buildNavigationData(
		fakeApp(
			{ "A1.md": "", "A.md": "" },
			{
				"A.md": { title: "A" },
				"A1.md": { title: "A1", "midad-up": ["[[A]]"], "document-type": "[[text-source]]" },
			},
			{ "A1.md": { headings: [{ level: 1, heading: "A1" }, { level: 2, heading: "One" }] } }
		),
		"A1.md",
		() => 0
	);
	check("navigation uses sections for a content note",
		contentNavigation?.items.find((item) => item.current)?.children.map((item) => item.title).join(",") === "One");

	return { passed, failed, lines };
}
