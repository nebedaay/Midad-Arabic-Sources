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
}

export interface TemplateHashes {
	templates: Record<string, TemplateHashEntry>;
}

export function recordTemplateHashes(
	store: TemplateHashes,
	hashes: Record<string, string>,
	at: number
): { store: TemplateHashes; changed: string[] } {
	const templates: Record<string, TemplateHashEntry> = { ...(store?.templates ?? {}) };
	const changed: string[] = [];
	for (const [key, hash] of Object.entries(hashes)) {
		if (!hash) continue;
		const prev = templates[key];
		if (!prev) {
			templates[key] = { hash, at: 0 };
			continue;
		}
		if (prev.hash !== hash) {
			templates[key] = { hash, at };
			changed.push(key);
		}
	}
	return { store: { templates }, changed };
}

/** A recorded change age for one template (0 = never changed since tracking began). */
export function templateChangedAt(store: TemplateHashes, key: string): number {
	return store?.templates?.[key]?.at ?? 0;
}
