/**
 * Parser for the managed `mas-sources-list` callout in the parent note (the
 * `[[Midad Arabic Sources]]` index). Kept free of Obsidian imports so it can be
 * tested on its own; `navigation.ts` turns the entries into links.
 *
 * The callout is two levels:
 *
 *     >[!mas-sources-list]
 *     >- [[Midad Arabic Sources - Topics|By Topic]]
 *     >	- [[Tafsīr Sources|Tafsīr]]
 *
 * A tab (or two or more spaces) after `>` marks a child entry.
 */

/** One `>- [[target|label]]` line inside the parent note's index callout. */
const INDEX_LINK = /^>(\s*)-\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

export interface SourceIndexEntry {
	/** Whitespace between `>` and `-`: a tab or 2+ spaces marks a child entry. */
	indent: string;
	target: string;
	label: string;
}

/** Parse the managed `mas-sources-list` callout into its entries, in order. */
export function parseSourceIndex(text: string): SourceIndexEntry[] {
	const entries: SourceIndexEntry[] = [];
	let inIndex = false;
	for (const line of text.split("\n")) {
		if (!inIndex) {
			if (/^>\s*\[!mas-sources-list\]/.test(line)) inIndex = true;
			continue;
		}
		if (!line.startsWith(">")) break;
		const match = INDEX_LINK.exec(line);
		if (!match) continue;
		entries.push({
			indent: match[1],
			target: match[2].trim(),
			label: (match[3] ?? match[2]).trim(),
		});
	}
	return entries;
}

/** True when an index entry is a child of the preceding top-level entry. */
export function isChildEntry(entry: SourceIndexEntry): boolean {
	return entry.indent.includes("\t") || entry.indent.length >= 2;
}
