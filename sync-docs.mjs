#!/usr/bin/env node
/*
 * The vault's `Midad Docs` folder is the source of truth for user-facing
 * documentation. This copies it into the development repo's `docs/` and
 * `README.md` before the bundle is generated. In CI, where the vault folder is
 * absent, the committed copies are used unchanged.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const source = resolve(process.env.MIDAD_DOCS_SOURCE || "../../Midad Docs");
const targetDocs = resolve("docs");
const targetReadme = resolve("README.md");

if (!existsSync(source)) {
	console.log(`sync-docs: ${source} not found; using committed docs.`);
	process.exit(0);
}

const sourceDocs = join(source, "docs");
const sourceReadme = join(source, "README.md");
if (!existsSync(sourceDocs) || !existsSync(sourceReadme)) {
	console.error(`sync-docs: expected ${sourceDocs} and ${sourceReadme}.`);
	process.exit(1);
}

mkdirSync(targetDocs, { recursive: true });
const wanted = new Set();
let copied = 0;
for (const name of readdirSync(sourceDocs)) {
	if (!name.endsWith(".md")) continue;
	wanted.add(name);
	const from = join(sourceDocs, name);
	const to = join(targetDocs, name);
	const body = readFileSync(from, "utf8");
	if (!existsSync(to) || readFileSync(to, "utf8") !== body) {
		writeFileSync(to, body);
		copied += 1;
	}
}
for (const name of readdirSync(targetDocs)) {
	if (!name.endsWith(".md") || wanted.has(name)) continue;
	rmSync(join(targetDocs, name));
	copied += 1;
}
const readme = readFileSync(sourceReadme, "utf8");
if (!existsSync(targetReadme) || readFileSync(targetReadme, "utf8") !== readme) {
	writeFileSync(targetReadme, readme);
	copied += 1;
}
console.log(copied
	? `sync-docs: copied ${copied} file(s) from ${source}.`
	: `sync-docs: docs are already current.`);
