/** FNV-1a 32-bit hash of a template's source text or render model. */
export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}

// ── Per-template hashes ──────────────────────────────────────────────────────
//
// Recording each template separately lets a change be attributed to the works
// that actually use it: editing the dictionary template re-renders the
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
