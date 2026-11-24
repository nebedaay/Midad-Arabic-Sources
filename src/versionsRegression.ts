/**
 * Regression tests for the saved-version store's file I/O.
 *
 * Run with `npm run test:versions`. The point of these is the change that made
 * "Manage versions" usable: a saved-version archive is read and written **per
 * work**, so managing one note never touches the other works' archives. The
 * cost of getting this wrong is data, so the assertions are about which files
 * were read and written, not only about the values returned.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { strToU8, strFromU8, unzipSync } from "fflate";
import type { App } from "obsidian";
import { NoteVersionEntry, VersionStore, workArchivePath } from "./sourceVersions";

export interface VersionsResult {
	passed: number;
	failed: number;
	lines: string[];
}

const SNAPSHOT = "A".repeat(2000);

function entryFor(key: string, workKey: string, notePath: string): NoteVersionEntry {
	const entry: NoteVersionEntry = {
		key,
		path: notePath,
		title: notePath.split("/").pop()?.replace(/\.md$/, "") ?? key,
		defaultId: "v1",
		workKey,
		versions: [
			{
				id: "v1",
				label: "Version 1",
				kind: "user",
				savedAt: new Date(0).toISOString(),
				file: `versions/${key.replace(/[^a-z0-9]+/gi, "-")}/v1.md`,
				selected: true,
				archived: false,
			},
		],
	};
	return entry;
}

export function runVersionStoreTests(): VersionsResult {
	const lines: string[] = [];
	let passed = 0;
	let failed = 0;
	const check = (label: string, condition: boolean, detail = ""): void => {
		if (condition) {
			passed += 1;
			lines.push(`ok    ${label}`);
		} else {
			failed += 1;
			lines.push(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
		}
	};

	const vault = fs.mkdtempSync(path.join(os.tmpdir(), "midad-versions-"));
	const archives = path.join(vault, ".midad-arabic-sources", "version-archives");
	fs.mkdirSync(archives, { recursive: true });
	const app = {
		vault: {
			read: async (file: { path: string }): Promise<string> =>
				fs.readFileSync(path.join(vault, file.path), "utf8"),
			getAbstractFileByPath: (_path: string): null => null,
		},
		fileManager: {},
	} as unknown as App;

	// The work key follows the note's own `midad-id`, exactly as the store
	// derives it from the text (`zotero/<item>/transcription`).
	const idA = "zotero/AAA/transcription/vol.1";
	const idB = "zotero/BBB/transcription/vol.1";
	const workA = "zotero/AAA/transcription";
	const workB = "zotero/BBB/transcription";
	const textA = `midad-id: ${idA}\n`;
	const textB = `midad-id: ${idB}\n`;
	const a = entryFor(`id:${idA}`, workA, "Notes/A.md");
	const b = entryFor(`id:${idB}`, workB, "Notes/B.md");

	// Write each work through the store itself, so the archives land where the
	// store will look for them.
	const seed = new VersionStore(app, vault);
	for (const entry of [a, b] as NoteVersionEntry[]) {
		const manifest = (seed as unknown as { manifestFor: (e: NoteVersionEntry) => { notes: Record<string, NoteVersionEntry> } }).manifestFor(entry);
		manifest.notes[entry.key] = entry;
		(seed as unknown as { files: Record<string, Uint8Array> }).files[entry.versions[0].file] = strToU8(SNAPSHOT);
		(seed as unknown as { saveEntry: (e: NoteVersionEntry) => void }).saveEntry(entry);
	}
	const archiveA = workArchivePath(vault, workA);
	const archiveB = workArchivePath(vault, workB);
	check("each work has its own archive", fs.existsSync(archiveA) && fs.existsSync(archiveB));
	check("the archive holds its own snapshot",
		Object.keys(unzipSync(new Uint8Array(fs.readFileSync(archiveA)))).some((name) => name.endsWith("v1.md")));
	const before = fs.readFileSync(archiveB);

	// Opening the dialog: the manifest index must find both works without
	// decompressing a single snapshot.
	const store = new VersionStore(app, vault);
	const index = (store as unknown as { manifestIndex: () => { notes: Record<string, NoteVersionEntry> } }).manifestIndex();
	check("the index sees every work", Object.keys(index.notes).sort().join(",") === [a.key, b.key].sort().join(","),
		Object.keys(index.notes).join(","));
	check("reading the index decompresses no snapshot",
		Object.keys((store as unknown as { files: Record<string, Uint8Array> }).files).length === 0);

	// Reading one note's entry loads that work's archive only.
	const loaded = store.entryForText({ path: "Notes/A.md" } as never, textA);
	check("the entry for a note is found", !!loaded && loaded.key === a.key);
	const files = (store as unknown as { files: Record<string, Uint8Array> }).files;
	check("only that work's snapshot is read",
		Object.keys(files).length === 1 && !!files[a.versions[0].file], Object.keys(files).join(","));

	// A change to one work rewrites that work and leaves the other alone.
	loaded!.versions[0].label = "Renamed";
	(store as unknown as { saveEntry: (e: NoteVersionEntry) => void }).saveEntry(loaded!);
	const after = fs.readFileSync(archiveB);
	check("the other work's archive is untouched", Buffer.compare(before, after) === 0);
	const reopened = new VersionStore(app, vault);
	const again = reopened.entryForText({ path: "Notes/A.md" } as never, textA);
	check("the change was written", again?.versions[0].label === "Renamed", again?.versions[0].label);
	const entries = unzipSync(new Uint8Array(fs.readFileSync(archiveA)));
	const snapshot = Object.entries(entries).find(([name]) => name.endsWith("v1.md"))?.[1];
	check("the snapshot survived the rewrite", snapshot ? strFromU8(snapshot) === SNAPSHOT : false);

	fs.rmSync(vault, { recursive: true, force: true });
	return { passed, failed, lines };
}
