// Template-staleness timeline, ported from ScholarWeft.
//
// A note records WHEN it was last rendered (`updated`); a global log records the
// template hash IN EFFECT over each time range (`{ hash, at }`). The hash a note
// was rendered with is reconstructed as `hashAt(updated)`, so staleness is
// decided without storing a per-note hash, and a template that changes and later
// reverts does not over-flag (ranges, not a single cut, decide).

export interface TemplateTimelineEntry {
	hash: string;
	at: number;
}

export interface TemplateTimeline {
	entries: TemplateTimelineEntry[];
}

/** FNV-1a 32-bit hash of a template's source text. */
export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}

export function emptyTimeline(hash: string, at: number): TemplateTimeline {
	return { entries: hash ? [{ hash, at }] : [] };
}

export function recordTemplateHash(
	timeline: TemplateTimeline,
	hash: string,
	at: number
): { timeline: TemplateTimeline; changed: boolean } {
	if (!hash) return { timeline, changed: false };
	const entries = timeline?.entries ?? [];
	const last = entries[entries.length - 1];
	if (last && last.hash === hash) return { timeline, changed: false };
	return { timeline: { entries: [...entries, { hash, at }] }, changed: true };
}

export function currentHash(timeline: TemplateTimeline): string {
	const entries = timeline?.entries ?? [];
	return entries[entries.length - 1]?.hash ?? "";
}

export function hashAt(timeline: TemplateTimeline, t: number): string {
	const entries = timeline?.entries ?? [];
	let found = "";
	for (const e of entries) {
		if (e.at <= t) found = e.hash;
		else break;
	}
	return found;
}

export function isNoteStale(timeline: TemplateTimeline, updatedMs: number | null | undefined): boolean {
	const now = currentHash(timeline);
	if (!now) return false;
	if (updatedMs == null || !Number.isFinite(updatedMs)) return true;
	const then = hashAt(timeline, updatedMs);
	if (!then) return true;
	return then !== now;
}

export function pruneTimeline(timeline: TemplateTimeline, minUpdatedMs: number | null): TemplateTimeline {
	const entries = [...(timeline?.entries ?? [])].sort((a, b) => a.at - b.at);
	if (entries.length <= 1 || minUpdatedMs == null) return { entries };
	let floorIdx = -1;
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].at <= minUpdatedMs) floorIdx = i;
		else break;
	}
	if (floorIdx <= 0) return { entries };
	return { entries: entries.slice(floorIdx) };
}

// ── Per-template hashes ──────────────────────────────────────────────────────
//
// The single concatenated hash above means any template edit invalidates every
// note. Recording each template separately lets a change be attributed to the
// works that actually use it: editing the dictionary template re-renders the
// dictionary, not the corpus. `at` is when the current hash was first seen, so a
// note rendered before it is stale for that template — and the check is
// self-healing, independent of the pass that noticed the change. A template seen
// for the first time is recorded at `at: 0`, so introducing tracking never of
// itself invalidates anything.

export interface TemplateHashEntry {
	hash: string;
	at: number;
	/** Hash of the YAML-building part (through end_YAML()). */
	yamlHash?: string;
	/** Hash of the template body after end_YAML(). */
	bodyHash?: string;
}

export interface TemplateHashValue {
	hash: string;
	yaml: string;
	body: string;
}

export type TemplateChangePart = "yaml" | "body" | "both";

/** Split a template at the end of its frontmatter-building block. */
export function splitTemplateSource(source: string): { yaml: string; body: string } {
	const marker = "end_YAML()";
	const idx = source.lastIndexOf(marker);
	if (idx < 0) return { yaml: "", body: source };
	const close = source.indexOf("%>", idx);
	const end = close < 0 ? source.length : close + 2;
	return { yaml: source.slice(0, end), body: source.slice(end) };
}

export interface TemplateHashes {
	templates: Record<string, TemplateHashEntry>;
}

export function recordTemplateHashes(
	store: TemplateHashes,
	hashes: Record<string, string | TemplateHashValue>,
	at: number
): { store: TemplateHashes; changed: string[]; changedParts: Record<string, TemplateChangePart> } {
	const templates: Record<string, TemplateHashEntry> = { ...(store?.templates ?? {}) };
	const changed: string[] = [];
	const changedParts: Record<string, TemplateChangePart> = {};
	for (const [key, value] of Object.entries(hashes)) {
		if (!value) continue;
		const isParts = typeof value !== "string";
		const hash = isParts ? value.hash : value;
		const prev = templates[key];
		if (!prev) {
			templates[key] = isParts
				? { hash, at: 0, yamlHash: value.yaml, bodyHash: value.body }
				: { hash, at: 0 };
			continue;
		}
		if (prev.hash === hash) {
			if (isParts && (prev.yamlHash == null || prev.bodyHash == null)) {
				templates[key] = { ...prev, yamlHash: value.yaml, bodyHash: value.body };
			}
			continue;
		}
		if (prev.hash !== hash) {
			let part: TemplateChangePart = "both";
			if (isParts && prev.yamlHash != null && prev.bodyHash != null) {
				const yamlChanged = prev.yamlHash !== value.yaml;
				const bodyChanged = prev.bodyHash !== value.body;
				part = yamlChanged && !bodyChanged ? "yaml" : bodyChanged && !yamlChanged ? "body" : "both";
			}
			templates[key] = isParts
				? { hash, at, yamlHash: value.yaml, bodyHash: value.body }
				: { hash, at };
			changed.push(key);
			changedParts[key] = part;
		}
	}
	return { store: { templates }, changed, changedParts };
}

/** A recorded change age for one template (0 = never changed since tracking began). */
export function templateChangedAt(store: TemplateHashes, key: string): number {
	return store?.templates?.[key]?.at ?? 0;
}
