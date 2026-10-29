// YAML frontmatter builder for the text-source templates.
//
// Ported from ScholarWeft's template/yaml.ts so the two plugins share the same
// conventions: a template author adds PROPERTIES (never raw YAML), and this
// serialiser decides quoting, indentation, block scalars, and omission of empty
// values. Pure and unit-testable.

export type YamlScalar = string | number | boolean;
export type YamlValue = YamlScalar | YamlScalar[] | null | undefined;

/**
 * How a re-render reconciles a managed property with the value already on disk.
 *   - `replace` (default): the freshly rendered value wins (an empty value
 *     removes the property);
 *   - `append`: list items already present are kept and the new ones added;
 *   - `keep`: the existing value wins unless it is empty (write-once);
 *   - `subtract`: migration only (drop existing items another property owns);
 *   - `remove`: retirement only — drop the property from an existing note. A
 *     template declares it with an empty value, which emits no line, so the
 *     property disappears on the next re-render and never appears on a new note.
 */
export type FrontmatterMerge = "replace" | "append" | "keep" | "subtract" | "remove";

export interface YamlPropertyOptions {
	force?: boolean;
	quote?: "auto" | "always" | "never";
	merge?: FrontmatterMerge;
	subtractFrom?: string;
}

export interface YamlFieldSpec {
	key: string;
	merge: FrontmatterMerge;
	lines: string[];
	subtractFrom?: string;
}

const INDENT = "  ";
const INDICATOR_RE = /^[\s\-?:,[\]{}#&*!|>'"%@`]/;
const NUMBER_LIKE_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const BOOL_NULL_LIKE_RE = /^(?:true|false|null|~|yes|no|on|off)$/i;
const KEY_SAFE_RE = /^[A-Za-z0-9_.-]+$/;

export function needsQuotes(value: string, quote: "auto" | "always" | "never" = "auto"): boolean {
	if (quote === "always") return true;
	if (quote === "never") return false;
	if (value === "") return true;
	if (value !== value.trim()) return true;
	if (INDICATOR_RE.test(value)) return true;
	if (/:\s/.test(value) || /\s#/.test(value)) return true;
	if (/["\\\t]/.test(value)) return true;
	if (BOOL_NULL_LIKE_RE.test(value)) return true;
	if (NUMBER_LIKE_RE.test(value)) return true;
	return false;
}

function quoteString(value: string): string {
	return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function serializeScalar(value: YamlScalar, quote: "auto" | "always" | "never"): string {
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	return needsQuotes(value, quote) ? quoteString(value) : value;
}

function serializeBlockScalar(value: string): string {
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const body = lines.map((line) => (line === "" ? "" : INDENT + line)).join("\n");
	return `|-\n${body}`;
}

function serializeKey(key: string): string {
	return KEY_SAFE_RE.test(key) ? key : quoteString(key);
}

export function serializeProperty(key: string, value: YamlValue, opts: YamlPropertyOptions = {}): string[] {
	const quote = opts.quote ?? "auto";
	const k = serializeKey(key);
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) {
		if (value.length === 0) return opts.force ? [`${k}: []`] : [];
		return [`${k}:`, ...value.map((item) => `${INDENT}- ${serializeScalar(item, quote)}`)];
	}
	if (typeof value === "string") {
		if (value === "") return opts.force ? [`${k}: ""`] : [];
		if (/[\n\r]/.test(value)) return `${k}: ${serializeBlockScalar(value)}`.split("\n");
		return [`${k}: ${serializeScalar(value, quote)}`];
	}
	return [`${k}: ${serializeScalar(value, quote)}`];
}

/** Stateful frontmatter builder used by start_YAML / add_property / end_YAML. */
export class YamlBuilder {
	private lines: string[] = [];
	private specs: YamlFieldSpec[] = [];
	private open = false;
	private finished = false;

	start(): void {
		if (this.open) throw new Error("[as yaml] start_YAML() called twice");
		if (this.finished) throw new Error("[as yaml] start_YAML() called after end_YAML()");
		this.open = true;
	}

	add(key: string, value: YamlValue, opts?: YamlPropertyOptions): void {
		if (!this.open) throw new Error("[as yaml] add_property() outside start_YAML()");
		if (typeof key !== "string" || !key.trim()) throw new Error("[as yaml] add_property() needs a key");
		const lines = serializeProperty(key, value, opts);
		this.lines.push(...lines);
		this.specs.push({ key, merge: opts?.merge ?? "replace", subtractFrom: opts?.subtractFrom, lines });
	}

	fieldSpecs(): YamlFieldSpec[] {
		return this.specs.map((s) => ({ ...s, lines: [...s.lines] }));
	}

	end(): string {
		if (!this.open) throw new Error("[as yaml] end_YAML() without start_YAML()");
		this.open = false;
		this.finished = true;
		return ["---", ...this.lines, "---", ""].join("\n");
	}
}
