/** Format a prose selection into the vault's Arabic-poetry callout shape. */

export const POETRY_MAX_LINE = 80;

function clean(value: string): string {
	return value.replace(/\u00a0/g, " ").trim();
}

/**
 * Turn selected lines into callouts and prose.
 *
 * Blank-line-separated blocks are couplets (or longer verse groups): each
 * becomes a nested list under an empty `>-` bullet. A block containing one
 * short line becomes a direct `>-` item. Lines over 80 characters are left as
 * ordinary paragraphs, and the short groups before and after them remain in
 * their own callouts.
 */
export function formatPoetrySelection(text: string, maxLength = POETRY_MAX_LINE): string {
	const blocks = text
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/)
		.map((block) => block.split("\n").map(clean).filter(Boolean))
		.filter((block) => block.length > 0);

	const sections: string[] = [];
	let groups: string[][] = [];

	const flush = (): void => {
		if (!groups.length) return;
		const out = [">[!arabic-poetry]"];
		for (const group of groups) {
			if (group.length === 1) {
				out.push(`>- ${group[0]}`);
			} else {
				out.push(">-");
				for (const line of group) out.push(`>\t- ${line}`);
			}
		}
		sections.push(out.join("\n"));
		groups = [];
	};

	for (const block of blocks) {
		let short: string[] = [];
		for (const line of block) {
			if (line.length > maxLength) {
				if (short.length) {
					groups.push(short);
					short = [];
				}
				flush();
				sections.push(line);
			} else {
				short.push(line);
			}
		}
		if (short.length) groups.push(short);
	}
	flush();

	return sections.join("\n\n").trim();
}
