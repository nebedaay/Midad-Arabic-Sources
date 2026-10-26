import { localDate, localTimestamp } from "../time";
import { Eta } from "eta";
import { YamlBuilder, YamlPropertyOptions, YamlValue } from "./yaml";

/**
 * ETA engine for the text-source importer, mirroring ScholarWeft's template
 * conventions: a subclass whose methods are exposed to templates as bare
 * globals via `functionHeader`, and a stateful YAML-property builder
 * (`start_YAML` / `add_property` / `end_YAML`).
 *
 * The builder lives on the per-render data object, and its `fieldSpecs()` are
 * stashed on the data (as `__yamlSpecs`) so the re-render merge knows which
 * properties the template owns and how to reconcile them.
 */

export class SourceTemplateEngine extends Eta {
	startYAML(data: Record<string, unknown>): string {
		const builder = new YamlBuilder();
		builder.start();
		data.__yaml = builder;
		data.__yamlSpecs = [];
		return "";
	}

	addProperty(data: Record<string, unknown>, key: string, value: YamlValue, opts?: YamlPropertyOptions): string {
		const builder = data.__yaml as YamlBuilder | undefined;
		if (!builder) throw new Error("[as yaml] add_property() outside start_YAML()");
		builder.add(key, value, opts);
		return "";
	}

	endYAML(data: Record<string, unknown>): string {
		const builder = data.__yaml as YamlBuilder | undefined;
		if (!builder) throw new Error("[as yaml] end_YAML() without start_YAML()");
		data.__yamlSpecs = builder.fieldSpecs();
		return builder.end();
	}

	// ── Value helpers ─────────────────────────────────────────────────────────

	wikilink(target: string, alias?: string): string {
		return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
	}

	heading(level: number, text: string): string {
		return `${"#".repeat(Math.max(1, level))} ${text}`;
	}

	escapeMd(text: string): string {
		return String(text).replace(/([*_`[\]])/g, "\\$1");
	}

	updated(): string {
		return localTimestamp();
	}

	importDate(): string {
		return localDate();
	}
}

export function makeEngine(): SourceTemplateEngine {
	return new SourceTemplateEngine({
		cache: false,
		autoEscape: false,
		autoTrim: [false, false],
		functionHeader: [
			"const { work, unit, units, sections, moc, mocs, parent, generated, groups } = it;",
			"const bilingual = it.layout;",
			"const start_YAML = () => this.startYAML(it);",
			"const add_property = (k, v, o) => this.addProperty(it, k, v, o);",
			"const end_YAML = () => this.endYAML(it);",
			"const wikilink = (t, a) => this.wikilink(t, a);",
			"const heading = (l, t) => this.heading(l, t);",
			"const escape_md = (t) => this.escapeMd(t);",
			"const updated = () => this.updated();",
			"const import_date = () => this.importDate();",
		].join("\n"),
	} as never);
}
