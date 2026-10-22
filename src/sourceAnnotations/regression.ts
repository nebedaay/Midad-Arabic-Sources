import { TFile, type App } from "obsidian";
import { AdoptedNotesRegistry } from "./adopted";
import { findNormalized, resolveAnnotations, visibleSegments } from "./resolve";
import { reanchorAnnotation } from "./reanchor";
import { bodyBounds, expandLinkListSelection, findRenderedText, selectionExclusion } from "./text";

export interface RegressionResult {
	passed: number;
	failed: number;
	lines: string[];
}

function fakeApp(files: Record<string, string>, frontmatter: Record<string, Record<string, unknown>> = {}): App {
	const store = new Map(Object.entries(files));
	const folders = new Set<string>();
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
	const vault = {
		adapter,
		getMarkdownFiles: () => [...store.keys()].filter((p) => p.endsWith(".md")).map((p) =>
			new (TFile as unknown as new (path: string) => TFile)(p)),
	};
	const metadataCache = {
		getFileCache: (file: TFile) => ({ frontmatter: frontmatter[file.path] }),
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

	return { passed, failed, lines };
}
