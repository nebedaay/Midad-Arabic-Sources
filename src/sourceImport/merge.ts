// Re-render merge: refresh what the template owns, leave everything else.
//
// Ported from ScholarWeft's template/merge.ts. Two independent mechanisms:
//   1. FRONTMATTER — only the properties the template declares are touched,
//      each with its merge strategy. Every other property (including the
//      user's `related:`) is preserved verbatim and in place.
//   2. MANAGED REGION — the template wraps its generated body in
//      `%%mas-managed%%` … `%%/mas-managed%%`. A re-render replaces exactly that
//      span; text above and below it is the user's and is never touched.
//
// Pure and line-based: untouched properties keep their raw text.

import type { FrontmatterMerge, YamlFieldSpec } from "./yaml";

// Region markers. Rendered as a small, faint HTML element so CSS can play it
// down (the plain `%%mas-managed%%` text was swept into the Qur'an gradient).
export const MANAGED_OPEN = '<span class="mas-managed">mas-managed</span>';
export const MANAGED_CLOSE = '<span class="mas-managed">/mas-managed</span>';

// The plain-text markers used before the change, recognised so existing notes
// are converted in place on the next render.
export const LEGACY_MANAGED_OPEN = "%%mas-managed%%";
export const LEGACY_MANAGED_CLOSE = "%%/mas-managed%%";

const REGION_MARKERS: ReadonlyArray<readonly [string, string]> = [
	[MANAGED_OPEN, MANAGED_CLOSE],
	[LEGACY_MANAGED_OPEN, LEGACY_MANAGED_CLOSE],
];

export interface SplitNote {
	frontmatter: string | null;
	body: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitNote(content: string): SplitNote {
	const m = FRONTMATTER_RE.exec(content);
	if (!m) return { frontmatter: null, body: content };
	return { frontmatter: m[1], body: content.slice(m[0].length) };
}

export function joinNote(frontmatter: string, body: string): string {
	const fm = frontmatter.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	const cleanBody = body.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
	return normalizeManagedMarkerSpacing(`---\n${fm}\n---\n\n${cleanBody}`);
}

export interface FrontmatterProperty {
	key: string;
	lines: string[];
}

const KEY_RE = /^([A-Za-z0-9_][^:\n]*?)[ \t]*:(?:[ \t]|$)/;

function unquoteKey(key: string): string {
	const k = key.trim();
	if (k.length >= 2 && ((k[0] === '"' && k.endsWith('"')) || (k[0] === "'" && k.endsWith("'")))) {
		return k.slice(1, -1);
	}
	return k;
}

export function parseFrontmatter(frontmatter: string): FrontmatterProperty[] {
	const props: FrontmatterProperty[] = [];
	let current: FrontmatterProperty | null = null;
	for (const line of frontmatter.replace(/\r\n?/g, "\n").split("\n")) {
		const m = !/^[ \t]/.test(line) ? KEY_RE.exec(line) : null;
		if (m) {
			if (current) props.push(current);
			current = { key: unquoteKey(m[1]), lines: [line] };
		} else if (current) {
			current.lines.push(line);
		} else if (line.trim()) {
			props.push({ key: "", lines: [line] });
		}
	}
	if (current) props.push(current);
	return props;
}

function isListBlock(lines: string[]): boolean {
	return (
		lines.length >= 1 &&
		/:[ \t]*$/.test(lines[0]) &&
		lines.slice(1).length > 0 &&
		lines.slice(1).every((l) => /^[ \t]*-[ \t]/.test(l))
	);
}

function appendListItems(existing: string[], generated: string[]): string[] {
	const head = existing[0] ?? generated[0];
	const seen = new Set(existing.slice(1).map((l) => l.trim()));
	const out = [...existing.slice(1)];
	for (const item of generated.slice(1)) {
		if (seen.has(item.trim())) continue;
		seen.add(item.trim());
		out.push(item);
	}
	return [head, ...out];
}

function subtractListItems(existing: string[], generated: string[]): string[] {
	const head = existing[0] ?? generated[0];
	const claimed = new Set(generated.slice(1).map((l) => l.trim()));
	const kept = existing.slice(1).filter((l) => !claimed.has(l.trim()));
	return [head, ...kept];
}

function reconcile(merge: FrontmatterMerge, existing: string[] | undefined, generated: string[]): string[] {
	const has = !!existing && existing.length > 0;
	switch (merge) {
		case "keep":
			return has ? existing : generated;
		case "append":
			if (!has) return generated;
			if (isListBlock(existing) && isListBlock(generated)) return appendListItems(existing, generated);
			return generated;
		case "subtract":
			if (!has) return existing ?? [];
			if (isListBlock(existing) && isListBlock(generated)) return subtractListItems(existing, generated);
			return existing;
		case "remove":
			// Retired property: declared empty so a re-render deletes it.
			return [];
		case "replace":
		default:
			return generated;
	}
}

export function mergeFrontmatter(existingFrontmatter: string | null, specs: readonly YamlFieldSpec[]): string {
	const existing = parseFrontmatter(existingFrontmatter ?? "");
	const byKey = new Map(specs.map((s) => [s.key, s]));

	const subtractAgainst = new Map<string, string[]>();
	for (const spec of specs) {
		if (spec.merge === "subtract" && spec.subtractFrom) {
			const owner = byKey.get(spec.subtractFrom);
			if (owner) subtractAgainst.set(spec.key, owner.lines);
		}
	}

	const emitted = new Set<string>();
	const out: string[] = [];
	for (const prop of existing) {
		const spec = byKey.get(prop.key);
		if (!spec) {
			out.push(...prop.lines);
			continue;
		}
		emitted.add(spec.key);
		out.push(...reconcile(spec.merge, prop.lines, subtractAgainst.get(spec.key) ?? spec.lines));
	}
	for (const spec of specs) {
		if (emitted.has(spec.key)) continue;
		out.push(...reconcile(spec.merge, undefined, spec.lines));
	}
	return out.join("\n");
}

export interface ManagedRegion {
	start: number;
	end: number;
}

/** Keep managed-region markers on their own blank-line-separated block. */
export function ensureManagedRegion(content: string): string {
	const prior = splitNote(content);
	if (findManagedRegion(prior.body)) return normalizeManagedMarkerSpacing(content);
	const body = prior.body.trim();
	if (!body) return content;
	const wrapped = `${MANAGED_OPEN}\n\n${body}\n\n${MANAGED_CLOSE}\n`;
	const ensured = prior.frontmatter == null ? wrapped : joinNote(prior.frontmatter, wrapped);
	return normalizeManagedMarkerSpacing(ensured);
}

/** Collapse blank runs and internal space runs, preserving fenced code and YAML. */
function normalizeWhitespace(text: string): string {
	const prior = splitNote(text);
	const lines = prior.body.split("\n");
	const trailingBlank = lines.length >= 2 && lines[lines.length - 1].trim() === "" && lines[lines.length - 2].trim() === "";
	const out: string[] = [];
	let inFence = false;
	let fence = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			const marker = trimmed.slice(0, 3);
			if (!inFence) { inFence = true; fence = marker; }
			else if (marker === fence) inFence = false;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		if (!trimmed) {
			if (out.length && out[out.length - 1] !== "") out.push("");
			continue;
		}
		const leading = /^[ \t]*/.exec(line)?.[0] ?? "";
		const rest = line.slice(leading.length).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, "");
		out.push(leading + rest);
	}
	if (trailingBlank && out.length) out.push("");
	const body = out.join("\n");
	return prior.frontmatter == null ? body : `---\n${prior.frontmatter}\n---\n\n${body}`;
}

/** Keep the first opening and last closing marker, removing nested/duplicate marker lines. */
function collapseManagedRegions(text: string): string {
	const prior = splitNote(text);
	const lines = prior.body.split("\n");
	let firstOpen = -1;
	let lastClose = -1;
	let inFence = false;
	let fence = "";
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			const marker = trimmed.slice(0, 3);
			if (!inFence) { inFence = true; fence = marker; }
			else if (marker === fence) inFence = false;
			continue;
		}
		if (inFence) continue;
		const isOpen = trimmed === MANAGED_OPEN || trimmed === LEGACY_MANAGED_OPEN
			|| (trimmed.startsWith('<span class="mas-managed') && !trimmed.includes("/mas-managed"));
		const isClose = trimmed === MANAGED_CLOSE || trimmed === LEGACY_MANAGED_CLOSE
			|| trimmed.includes("/mas-managed</span>") || trimmed.includes("%%/mas-managed%%");
		if (isOpen && firstOpen < 0) firstOpen = i;
		if (isClose && firstOpen >= 0) lastClose = i;
	}
	if (firstOpen < 0 || lastClose <= firstOpen) return text;
	const body: string[] = [...lines.slice(0, firstOpen)];
	body.push(MANAGED_OPEN);
	for (let i = firstOpen + 1; i < lastClose; i++) {
		const trimmed = lines[i].trim();
		const marker = trimmed === MANAGED_OPEN || trimmed === LEGACY_MANAGED_OPEN || trimmed === MANAGED_CLOSE || trimmed === LEGACY_MANAGED_CLOSE
			|| (trimmed.startsWith('<span class="mas-managed') && trimmed.includes("/mas-managed"));
		if (!marker) body.push(lines[i]);
	}
	body.push(MANAGED_CLOSE, ...lines.slice(lastClose + 1));
	const collapsed = body.join("\n");
	return prior.frontmatter == null ? collapsed : `---\n${prior.frontmatter}\n---\n${collapsed}`;
}

export function normalizeManagedMarkerSpacing(text: string): string {
	text = collapseManagedRegions(text);
	text = normalizeWhitespace(text);
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	let fence = "";
	for (let i = 0; i < lines.length; i++) {
		const stripped = lines[i].trim();
		if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
			const marker = stripped.slice(0, 3);
			if (!inFence) { inFence = true; fence = marker; }
			else if (marker === fence) inFence = false;
		}
		const isOpen = stripped === MANAGED_OPEN || stripped === LEGACY_MANAGED_OPEN;
		const isClose = stripped === MANAGED_CLOSE || stripped === LEGACY_MANAGED_CLOSE;
		if (!inFence && (isOpen || isClose)) {
			while (out.length && out[out.length - 1].trim() === "") out.pop();
			if (out.length) out.push("");
			out.push(lines[i].trim());
			i += 1;
			while (i < lines.length && lines[i].trim() === "") i += 1;
			if (i < lines.length) out.push("");
			else out.push("", "");
			i -= 1;
			continue;
		}
		out.push(lines[i]);
	}
	return out.join("\n");
}

/** Remove Markdown Attributes wrappers from ornate Qur'ān parentheses. */
export function unwrapQuranQuotes(text: string): string {
	return text
		.replace(/\*?﴿([^﴾\n]+)﴾\*?\{\.quran-quote\}\*?/g, "﴿$1﴾")
		.replace(/\{\.quran-quote\}/g, "");
}

export function findManagedRegion(body: string): ManagedRegion | null {
	for (const [open, close] of REGION_MARKERS) {
		const start = body.indexOf(open);
		if (start === -1) continue;
		const end = body.indexOf(close, start + open.length);
		if (end === -1) continue;
		return { start, end: end + close.length };
	}
	return null;
}

export interface ManagedRegionOptions {
	/** The template manages a region, so an absent one in the render removes it. */
	managesRegion?: boolean;
	/** On first managed render, replace an existing body that has no region. */
	replaceUnmanaged?: boolean;
}

export function mergeManagedRegion(existingBody: string, renderedBody: string, opts: ManagedRegionOptions = {}): string {
	const rendered = findManagedRegion(renderedBody);
	const existing = findManagedRegion(existingBody);

	if (rendered && existing) {
		return (
			existingBody.slice(0, existing.start) +
			renderedBody.slice(rendered.start, rendered.end) +
			existingBody.slice(existing.end)
		);
	}
	if (rendered && !existing) {
		// Converting a note that predates the managed region: drop the old body.
		if (opts.replaceUnmanaged) return renderedBody;
		const region = renderedBody.slice(rendered.start, rendered.end);
		const before = existingBody.replace(/\s+$/, "");
		return before ? `${before}\n\n${region}\n` : `${region}\n`;
	}
	if (!rendered && existing && opts.managesRegion) {
		const before = existingBody.slice(0, existing.start).replace(/\n+$/, "");
		const after = existingBody.slice(existing.end).replace(/^\n+/, "");
		if (!before) return after;
		if (!after) return `${before}\n`;
		return `${before}\n\n${after}`;
	}
	return existingBody;
}

/** Re-render an existing note, preserving user content and out-of-scope properties. */
export function mergeNote(
	existing: string,
	rendered: string,
	specs: readonly YamlFieldSpec[],
	opts: ManagedRegionOptions = {}
): string {
	const prior = splitNote(existing);
	const fresh = splitNote(rendered);
	const frontmatter = mergeFrontmatter(prior.frontmatter, specs);
	let body: string;
	if (prior.frontmatter === null) {
		body = opts.replaceUnmanaged ? fresh.body : prior.body;
	} else {
		body = mergeManagedRegion(prior.body, fresh.body, opts);
	}
	return joinNote(frontmatter, body);
}

const UPDATED_LINE = /^updated:[^\n]*\n?/m;

/** Do two notes differ in anything except the volatile `updated:` line? */
export function substantiveContentDiffers(existing: string, rendered: string): boolean {
	return existing.replace(UPDATED_LINE, "") !== rendered.replace(UPDATED_LINE, "");
}
