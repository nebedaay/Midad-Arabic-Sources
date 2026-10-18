import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import { promisify } from "util";
import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TextComponent,
	normalizePath,
	requestUrl,
} from "obsidian";
import {
	TEMPLATE_FILES,
	TEMPLATE_FOLDER,
	SourceModel,
	TemplateSet,
	JsonObject,
	RenderProgress,
	expectedNotePaths,
	loadTemplates,
	renderMocs,
	renderModelToVault,
	renderSourcesNote,
	vaultRelative,
	writeMerged,
} from "./sourceImport/render";
import {
	TemplateHashes,
	hashString,
	recordTemplateHashes,
	templateChangedAt,
} from "./sourceImport/history";
import { BUNDLED_ASSETS } from "./assets.generated";

// ── External tool resolution (mirrors ScholarWeft's tools.ts) ────────────────
// Electron's renderer does not inherit the shell PATH, so we probe candidates
// and pick the first that can actually import the pipeline's modules.

async function execProbe(file: string, args: string[]): Promise<boolean> {
	try {
		await promisify(execFile)(file, args);
		return true;
	} catch {
		return false;
	}
}

async function findPython3(configured: string, modules: string[]): Promise<string | null> {
	if (configured.trim()) return configured.trim();
	const platform = (window as NodeWindow).process?.platform;
	const win = platform === "win32";
	let home = "";
	try {
		home = os.homedir() ?? "";
	} catch {
		home = "";
	}
	const probe = (p: string) => execProbe(p, ["-c", `import ${modules.join(", ")}; import sys; sys.exit(0)`]);

	const candidates: string[] = [];
	candidates.push(...(win ? ["py", "python", "python3"] : ["python3", "python"]));
	if (home) {
		candidates.push(win ? `${home}\\ScholarWeft\\venv\\Scripts\\python.exe` : `${home}/ScholarWeft/venv/bin/python3`);
	}
	if (win) {
		const local = process.env.LOCALAPPDATA ?? "";
		candidates.push(
			`${home}\\miniconda3\\python.exe`, `${home}\\anaconda3\\python.exe`,
			`${local}\\Programs\\Python\\Python313\\python.exe`,
			`${local}\\Programs\\Python\\Python312\\python.exe`
		);
	} else {
		candidates.push(
			"python3.13", "python3.12", "python3.11",
			"/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3",
			`${home}/miniconda3/bin/python3`, `${home}/anaconda3/bin/python3`,
			"/opt/miniconda3/bin/python3", "/opt/anaconda3/bin/python3",
			`${home}/.pyenv/shims/python3`
		);
	}
	for (const p of candidates) {
		if (p && (await probe(p))) return p;
	}
	return null;
}

function basenameJS(p: string): string {
	return p.split(/[\\/]/).pop() ?? p;
}

function inferVolumeJS(name: string): number | null {
	const stem = name.replace(/\.[^.]+$/, "");
	const m = stem.match(/(?:vol(?:ume)?|juz)\s*[._-]?\s*(\d+)/i);
	if (m) return parseInt(m[1], 10);
	const nums = stem.match(/\d+/g);
	return nums ? parseInt(nums[nums.length - 1], 10) : null;
}

type Engine = "bert" | "mle" | "none";
type DotlessYa = "maqsura" | "ya";
type LlmProvider = "gemini" | "deepseek";

interface ArabicSupportSettings {
	serverUrl: string;
	transliterationServerScript: string;
	engine: Engine;
	sunLetters: boolean;
	keepCase: boolean;
	dotlessYa: DotlessYa;
	nameMode: boolean;
	// remembered choices from the transliterate modal
	useLlm: boolean;
	fullVocalization: boolean;
	// LLM configuration
	llmProvider: LlmProvider;
	llmModel: string;
	llmApiKey: string;
	// Gemini transcription/translation pipeline
	pythonPath: string;
	pipelineScript: string;
	geminiApiKey: string;
	// Text-source importer (tafsīr, Qur'ān translations, ḥadīth, …)
	sourceImportScript: string;
	sourceImportRoot: string;
	sourceTemplateFolder: string;
	canonicalQuranRiwāya: string;
	canonicalQuranFolder: string;
	sourceMocParent: string;
	manageShowFilter?: string;
	manageGenreFilter?: string[];
	sourceUpdateCheckDays?: number;
	autoUpdateSourceTemplates?: boolean;
	// Zotero export
	zoteroExport: boolean;
	zoteroMethod: "local" | "web" | "csl";
	zoteroApiKey: string;
	zoteroLibraryId: string;
	zoteroServerId: string;
	/** Keep already-exported items in step with the imported works, silently. */
	zoteroAutoUpdate?: boolean;
	/** Create a Zotero item for every installed work, without being asked. */
	zoteroAutoCreate?: boolean;
}

interface RunOptions {
	useLlm: boolean;
	fullVocalization: boolean;
}

/** Electron exposes a Node `process` on the window; the Obsidian typings do not. */
interface NodeWindow extends Window {
	process?: { platform?: string };
}

/** Obsidian app internals the plugin reaches into (absent from the public typings). */
interface ScholarWeftApi {
	bibManager?: { zCitekeyToPDFLinks?: Map<string, string[]> };
}
interface AppInternals {
	plugins?: { plugins?: Record<string, ScholarWeftApi> };
	setting?: { open(): void; openTabById(id: string): void };
}

/** One PDF attachment, as the pipeline reports it. */
interface PipelinePdf {
	key?: string;
	path: string;
	filename?: string;
	exists?: boolean;
	volume?: number | string;
}

/** One transcription note, as the pipeline reports it. */
interface PipelineNote {
	type: string;
	path: string;
	name?: string;
}

/** One archived batch, as the reprocess dialogue reports it. */
interface ArchiveZip {
	name: string;
	path: string;
}

/** The `result` payload a pipeline script emits on its final stdout line. */
interface PipelineResult {
	notes?: string[];
	sources?: string[];
	pdfs?: PipelinePdf[];
	zips?: ArchiveZip[];
	changed?: string[];
	date_only?: string[];
	models?: string[];
	[k: string]: unknown;
}

/** One JSON progress line from a pipeline script. */
interface PipelineEvent {
	event: string;
	message?: string;
	name?: string;
	status?: string;
	detail?: string;
	result?: PipelineResult;
	works?: JsonObject[];
	[k: string]: unknown;
}

/** The persisted job state a pipeline script writes while running. */
interface PipelineState {
	stage?: string;
	pdf?: string;
	pid?: number;
	_path: string;
	[k: string]: unknown;
}

/** A creator in the work model: a name string or a `{first,last}` / `{name}` object. */
type CreatorValue =
	| string
	| { first?: string; last?: string; firstName?: string; lastName?: string; name?: string };

/** A Zotero creator as a built item carries it. */
interface ZoteroCreator {
	creatorType?: string;
	name?: string;
	firstName?: string;
	lastName?: string;
}

/** The subset of a built Zotero item that the CSL-JSON export reads. */
interface CslSourceItem {
	title?: string;
	url?: string;
	publisher?: string;
	place?: string;
	edition?: string;
	extra?: string;
	date?: string;
	creators?: ZoteroCreator[];
}

/** One unresolved Arabic word the transliteration service reports. */
interface LexiconGuess {
	term: string;
	guess: string;
}

/** The transliteration service's `/romanize` response. */
interface TransliterateResponse {
	unknown?: LexiconGuess[];
	error?: string;
	romanized?: string;
}

/** Zotero API response shapes the plugin reads (fields vary by endpoint). */
interface ZoteroCollectionRef {
	key?: string;
	data?: { name?: string; key?: string };
}
interface ZoteroItemData {
	key?: string;
	version?: number;
	citationKey?: string;
}
interface ZoteroItemResponse {
	key?: string;
	version?: number;
	data?: ZoteroItemData;
}
interface ZoteroCreateResponse {
	successful?: Record<string, { key?: string; version?: number }>;
}
interface ZoteroAuthResponse {
	key?: string;
}

/**
 * A cached measurement for one work: its on-disk size, and — the important part —
 * per-template render watermarks. A single "rendered at" cannot work once
 * re-renders are scoped by unit kind: rewriting only the dictionary letter pages
 * must not mark the roots as up to date. So each template key records when the
 * work was last rendered *with that template*.
 */
interface SourceStat {
	bytes?: number;
	/** When `bytes` was measured (epoch ms). */
	at?: number;
	/** Per-template last-render time (epoch ms), keyed by template key. */
	rendered?: Record<string, number>;
	/** Note count from the last full render, for a cheap completeness check. */
	notes?: number;
	/** The model schema at the last render, so a stale model is still noticed. */
	schema?: number;
}

/**
 * A frontmatter date as epoch ms. Obsidian's YAML parser (js-yaml's default
 * schema) turns a bare `YYYY-MM-DD HH:MM:SS` into a **Date**, not a string, so a
 * `typeof value === "string"` check silently yields "no watermark" — which made
 * every work look stale on every startup. Accept a Date, a number, or a string.
 */
function frontmatterTimeMs(value: unknown): number | null {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const ms = Date.parse(value.replace(" ", "T"));
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/** How long the on-disk source catalogue is reused before it is re-listed. */
const SOURCE_CATALOG_TTL = 7 * 86_400_000;

/** Bump when the catalogue's shape changes, to invalidate stale caches. */
const SOURCE_CATALOG_SCHEMA = 2;

/**
 * The cached-model schema at which each collection's *acquisition* last changed.
 * A model older than its collection's entry is re-fetched, because a re-render
 * only replays the cached model and cannot apply an acquisition change. Listing
 * it per collection means one collection's change never triggers a corpus-wide
 * re-fetch: a collection absent here keeps its cached models.
 *
 * `dictionary` → 3: the leading-parenthesis fix, the verb-form look-ahead, the
 * engine fallback, the gemination completion, and `title`/`section_page`.
 * Bump only the affected entries, and in step with `MODEL_SCHEMA` in
 * `scripts/text-source-import.py`.
 */
const COLLECTION_MODEL_SCHEMA: Record<string, number> = {
	dictionary: 4,
};
/** The schema every model was written at before per-collection tracking. */
const BASE_MODEL_SCHEMA = 1;

/** The model schema a work of this collection must have to be renderable. */
function requiredModelSchema(collection: string): number {
	return COLLECTION_MODEL_SCHEMA[collection] ?? BASE_MODEL_SCHEMA;
}

/** Tag and collection every Zotero export carries, so its origin is traceable. */
const ZOTERO_MARK = "Midad Arabic Sources";

/** Appended to an item whose bibliographic details are still unverified. */
const BIB_PROVISIONAL = "Bibliographic details are provisional — verify against the edition you used before citing.";

/** Which unit `kind` each per-work template renders (the scoped re-render map). */
const SOURCE_TEMPLATE_KIND: Record<string, string> = {
	source: "source",
	hadith: "hadith",
	quran: "quran",
	dictionary: "dict",
	dictionaryIndex: "dict-index",
};

const DEFAULT_SETTINGS: ArabicSupportSettings = {
	serverUrl: "http://127.0.0.1:8756",
	transliterationServerScript: "scripts/transliterate-server.py",
	engine: "bert",
	sunLetters: false,
	keepCase: false,
	dotlessYa: "maqsura",
	nameMode: false,
	useLlm: false,
	fullVocalization: false,
	llmProvider: "gemini",
	llmModel: "gemini-3.5-flash-lite",
	llmApiKey: "",
	pythonPath: "",
	pipelineScript: "scripts/midad-arabic-sources-pipeline.py",
	geminiApiKey: "",
	sourceImportScript: "scripts/text-source-import.py",
	sourceImportRoot: "_7 Sources",
	sourceTemplateFolder: "",
	canonicalQuranRiwāya: "",
	canonicalQuranFolder: "_7 Sources/Quran",
	sourceMocParent: "Sources",
	manageShowFilter: "all",
	manageGenreFilter: [],
	zoteroExport: false,
	zoteroMethod: "local",
	zoteroApiKey: "",
	zoteroLibraryId: "",
	zoteroServerId: "",
	zoteroAutoUpdate: false,
	zoteroAutoCreate: false,
	sourceUpdateCheckDays: 7,
};

export default class ArabicSupportPlugin extends Plugin {
	settings: ArabicSupportSettings;
	lastUnknown: LexiconGuess[] = [];
	statusPanels: StatusPanel[] = [];
	/** Catalogue of available works, cached per session (and on disk for longer). */
	sourceCatalog: SourceWork[] | null = null;
	/** Guards the automatic Zotero sync against overlapping runs. */
	zoteroSyncRunning = false;
	zoteroSyncAgain = false;

	async onload() {
		await this.loadSettings();
		// Extract the bundled templates and Python scripts into the plugin folder
		// (they ship inside main.js; see gen-assets.mjs).
		this.extractBundledAssets();
		this.addSettingTab(new ArabicSupportSettingTab(this.app, this));

		this.addCommand({
			id: "transliterate-selection-to-clipboard",
			name: "Transliterate selection to clipboard",
			editorCallback: async (editor: Editor) => {
				const text = editor.getSelection() || editor.getLine(editor.getCursor().line);
				if (!text.trim()) {
					new Notice("Nothing selected.");
					return;
				}
				new TransliterateModal(this.app, this, text, async (result) => {
					await navigator.clipboard.writeText(result);
					new Notice("Romanized text copied to clipboard.");
				}).open();
			},
		});

		this.addCommand({
			id: "transliterate-note-to-new-note",
			name: "Transliterate note to new note",
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !view.file) {
					new Notice("No active note.");
					return;
				}
				const editor = view.editor;
				const source = editor.getSelection() || (await this.app.vault.read(view.file));
				const opts: RunOptions = {
					useLlm: this.settings.useLlm,
					fullVocalization: this.settings.fullVocalization,
				};
				const result = await this.runTransliteration(source, opts);
				if (result === null) return;
				const folder = view.file.parent?.path ?? "";
				const path = this.uniquePath(folder, `${view.file.basename} (romanized)`);
				const file = await this.app.vault.create(path, result);
				new Notice(`Created ${path}`);
				this.maybePromptUnknown(source, async (r) => { await this.app.vault.modify(file, r); }, opts);
			},
		});

		this.addCommand({
			id: "check-transliteration-server",
			name: "Check transliteration server",
			callback: async () => {
				const health = await this.health();
				if (!health) {
					new Notice(`Transliteration server not reachable at ${this.settings.serverUrl}.`);
					return;
				}
				const engines = health.engines_loaded?.join(", ") || "none loaded yet";
				const providers = health.providers
					? Object.entries(health.providers).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"
					: "unknown";
				new Notice(`Server OK. Engines: ${engines}. LLM providers (env): ${providers}.`);
			},
		});

		this.addCommand({
			id: "start-transliteration-server",
			name: "Start transliteration server",
			callback: async () => { await this.startTransliterationServer(); },
		});

		this.addCommand({
			id: "stop-transliteration-server",
			name: "Stop transliteration server",
			callback: async () => { await this.stopTransliterationServer(); },
		});

		this.addCommand({
			id: "transcribe-item-pdfs",
			name: "Transcribe this item's PDF file(s)",
			callback: async () => { await this.openTranscribe(); },
		});

		this.addCommand({
			id: "translate-item-transcriptions",
			name: "Translate this item's transcription(s)",
			callback: async () => { await this.openTranslate(); },
		});

		this.addCommand({
			id: "reprocess-from-archive",
			name: "Reprocess from archive…",
			callback: async () => { await this.openReprocess(); },
		});

		this.addCommand({
			id: "check-transcription-pipeline",
			name: "Check transcription pipeline",
			callback: async () => { await this.runWithProgress("Checking pipeline", ["list-archive"]); },
		});

		this.addCommand({
			id: "show-pipeline-status",
			name: "Show pipeline status",
			callback: async () => {
				if (this.statusPanels.length) { this.statusPanels.forEach((p) => p.reveal()); return; }
				const st = this.newestState();
				if (st && st.status && st.status !== "done" && st.status !== "error") {
					new ResumeModal(this.app, this, st).open();
				} else {
					await this.openLastLog();
				}
			},
		});

		this.addCommand({
			id: "open-last-pipeline-log",
			name: "Open last pipeline log",
			callback: async () => { await this.openLastLog(); },
		});

		this.addCommand({
			id: "manage-text-sources",
			name: "Manage text sources…",
			callback: async () => { await this.openManageSources(); },
		});

		this.addCommand({
			id: "copy-import-templates",
			name: "Copy import templates to vault",
			callback: async () => { await this.copyImportTemplates(); },
		});

		this.addCommand({
			id: "rerender-sources",
			name: "Re-render imported sources",
			callback: async () => { await this.rerenderAllSources(); },
		});

		this.addCommand({
			id: "apply-template-changes",
			name: "Apply template changes to imported sources",
			callback: async () => {
				const n = await this.applyTemplateChanges();
				new Notice(n ? `Re-rendered ${n} source(s) for template changes.` : "No template changes to apply.");
			},
		});

		this.addCommand({
			id: "redownload-sources",
			name: "Re-download imported sources (rebuild models)",
			callback: async () => { await this.redownloadSources(); },
		});

		this.addCommand({
			id: "reconcile-sources",
			name: "Check imported sources",
			callback: async () => {
				const incomplete = await this.findIncompleteSources();
				if (!incomplete.length) {
					new Notice("All imported sources are complete.");
					return;
				}
				new ReconcileSourcesModal(this.app, this, incomplete).open();
			},
		});

		this.addCommand({
			id: "check-source-updates",
			name: "Check for source updates",
			callback: async () => { await this.checkSourceUpdates(); },
		});

		this.addCommand({
			id: "send-sources-to-zotero",
			name: "Send all installed sources to Zotero",
			callback: async () => { await this.exportToZotero(); },
		});

		this.addCommand({
			id: "send-selected-sources-to-zotero",
			name: "Send selected sources to Zotero…",
			callback: async () => { await this.openZoteroSend(); },
		});

		this.addCommand({
			id: "send-this-source-to-zotero",
			name: "Send this source to Zotero",
			callback: async () => { await this.sendActiveSource(); },
		});

		// Auto-maintain: restore anything incomplete and re-render stale notes.
		// (The template hashes are recorded inside maintainSources, so the pass
		// that notices a change is also the one that applies it.)
		window.setTimeout(() => { void this.maintainSources(); }, 4000);
		// Ask the repositories for upstream changes at most once every N days.
		window.setTimeout(() => { void this.maybeScheduledUpdateCheck(); }, 15000);
		// Bring Zotero in step at startup too (covers a publication-map edit and
		// works installed while auto-create was off).
		window.setTimeout(() => { void this.autoSyncZotero(); }, 20000);
		// Re-list the source catalogue in the background when its cache is old.
		window.setTimeout(() => { void this.maybeRefreshSourceCatalog(); }, 25000);
		// Templates live in `.obsidian`, which Obsidian's vault watcher ignores, so
		// poll for edits and apply them without a reload.
		this.registerInterval(window.setInterval(() => { void this.pollTemplateChanges(); }, 45000));
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.isSourceTemplateFile(file.path)) {
					void this.recordSourceTemplateAndCheck();
				}
			})
		);
	}

	onunload(): void {
		this.statusPanels.forEach((p) => p.destroy());
		this.statusPanels = [];
	}

	// ── Gemini transcription/translation pipeline ────────────────────────────

	vaultPath(): string {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string; basePath?: string };
		try {
			if (typeof adapter?.getBasePath === "function") return adapter.getBasePath();
		} catch { /* ignore */ }
		return adapter?.basePath ?? "";
	}

	/**
	 * Write the bundled templates and Python scripts into the plugin folder when
	 * they differ. They are compiled into main.js (gen-assets.mjs), so a release
	 * ships them inside the three assets BRAT downloads; a plugin update therefore
	 * updates them, which changes their hashes and triggers the scoped re-render.
	 * Only files whose content differs are written, so a normal load touches
	 * nothing.
	 */
	extractBundledAssets(): void {
		const vault = this.vaultPath();
		if (!vault) return;
		const base = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/midad-arabic-sources`;
		for (const asset of BUNDLED_ASSETS) {
			try {
				const dest = `${vault}/${base}/${asset.path}`;
				if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === asset.content) continue;
				fs.mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
				fs.writeFileSync(dest, asset.content);
			} catch (e) {
				console.error("[midad-arabic-sources] asset extract", asset.path, e);
			}
		}
	}

	pythonPromise: Promise<string> | null = null;

	/** The configured Python, or the first candidate that imports the pipeline deps. */
	resolvePython(): Promise<string> {
		const configured = this.settings.pythonPath ?? "";
		if (configured.trim()) return Promise.resolve(configured.trim());
		if (this.pythonPromise == null) {
			this.pythonPromise = findPython3("", ["fitz", "requests", "google.genai"]).then((p) => p ?? "python3");
		}
		return this.pythonPromise;
	}

	/** PDF paths ScholarWeft has already resolved for a citekey, if any. */
	swPdfPaths(citekey: string): string[] {
		const sw = (this.app as unknown as AppInternals).plugins?.plugins?.["scholar-weft"];
		const map = sw?.bibManager?.zCitekeyToPDFLinks;
		try {
			return map && typeof map.get === "function" ? (map.get(citekey) ?? []) : [];
		} catch {
			return [];
		}
	}

	/** True when a Gemini key is available (plugin setting or inherited env). */
	apiKeyAvailable(): boolean {
		return !!(this.settings.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
	}

	openSettings(): void {
		const s = (this.app as unknown as AppInternals).setting;
		if (s) {
			s.open();
			s.openTabById("midad-arabic-sources");
		} else {
			new Notice("Open Settings → Community plugins → Midad Arabic Sources.");
		}
	}

	/** Block the Gemini commands with a clear prompt when no key is configured. */
	ensureApiKey(): boolean {
		if (this.apiKeyAvailable()) return true;
		new ApiKeyModal(this.app, this).open();
		return false;
	}

	/** Citekey and path for the active note (works from @citekey or a transcription/translation note). */
	activeItem(): { citekey: string; path: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;
		const base = view.file.basename;
		if (!base.startsWith("@")) return null;
		const citekey = base.slice(1).split(" - ")[0];
		return { citekey, path: view.file.path };
	}

	/** Resolve a script path: bundled in the plugin dir first, then the vault. */
	resolveScript(rel: string): string {
		const vault = this.vaultPath();
		const bundled = `${vault}/.obsidian/plugins/midad-arabic-sources/${rel}`;
		try {
			if (fs.existsSync(bundled)) return bundled;
		} catch { /* ignore */ }
		return `${vault}/${rel}`;
	}

	async runScript(scriptRel: string, args: string[], onEvent: (ev: PipelineEvent) => void): Promise<{ code: number; lines: string[] }> {
		const vault = this.vaultPath();
		const python = await this.resolvePython();
		const lines: string[] = [];
		return await new Promise((resolve) => {
			if (!vault) {
				onEvent({ event: "error", message: "Could not determine the vault path." });
				resolve({ code: 1, lines });
				return;
			}
			const script = this.resolveScript(scriptRel);
			const proc = spawn(python, [script, ...args], {
				cwd: vault,
				env: {
					...process.env,
					OBSIDIAN_VAULT: vault,
					PYTHONUNBUFFERED: "1",
					...(this.settings.geminiApiKey ? { GEMINI_API_KEY: this.settings.geminiApiKey } : {}),
				},
			});
			let buf = "";
			const handle = (chunk: Buffer) => {
				buf += chunk.toString();
				let idx: number;
				while ((idx = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, idx).trim();
					buf = buf.slice(idx + 1);
					if (!line) continue;
					lines.push(line);
					try {
						onEvent(JSON.parse(line) as PipelineEvent);
					} catch {
						onEvent({ event: "log", message: line });
					}
				}
			};
			proc.stdout.on("data", handle);
			proc.stderr.on("data", handle);
			proc.on("close", (code: number) => resolve({ code: code ?? 0, lines }));
			proc.on("error", (e: Error) => {
				onEvent({ event: "error", message: String(e) });
				resolve({ code: 1, lines });
			});
		});
	}

	/** Run the Gemini pipeline orchestrator (thin wrapper over runScript). */
	async runPipeline(args: string[], onEvent: (ev: PipelineEvent) => void): Promise<{ code: number; lines: string[] }> {
		return this.runScript(this.settings.pipelineScript, args, onEvent);
	}

	async pipelineResult(args: string[]): Promise<PipelineResult> {
		let result: PipelineResult | null = null;
		let lastError = "";
		const { code, lines } = await this.runPipeline(args, (ev) => {
			if (ev.event === "result") result = ev.result;
			else if (ev.event === "error") lastError = ev.message;
		});
		if (!result) {
			const tail = lines.slice(-3).join("  |  ");
			new Notice(`Midad Arabic Sources: no result (exit ${code}). ${lastError || tail || "no output"}`);
			console.error("[midad-arabic-sources] pipeline", args, { code, lines });
		}
		return result;
	}

	async runWithProgress(title: string, args: string[], scriptRel?: string): Promise<PipelineResult> {
		// Clear finished panels so only the current job(s) stay visible.
		for (const p of this.statusPanels.filter((x) => x.state !== "running")) p.destroy();
		this.statusPanels = this.statusPanels.filter((p) => p.state === "running");
		const panel = new StatusPanel(this.app, title);
		this.statusPanels.push(panel);

		const logPath = this.jobPath(title, "log");
		const statePath = this.jobPath(title, "json");
		const fullArgs = args[0] === "transcribe" ? [...args, "--log", logPath, "--state", statePath] : args;

		let result: PipelineResult | null = null;
		const { code } = await this.runScript(scriptRel ?? this.settings.pipelineScript, fullArgs, (ev) => {
			panel.append(ev);
			if (ev.event === "result") result = ev.result;
		});
		panel.finish(code === 0);
		panel.addResultLinks(result?.notes ?? result?.sources ?? []);
		if (code === 0) new Notice(`${title}: finished.`);
		else new Notice(`${title}: failed — use “Show pipeline status” to see the log.`);
		return result;
	}

	async runResume(statePath: string): Promise<PipelineResult> {
		for (const p of this.statusPanels.filter((x) => x.state !== "running")) p.destroy();
		this.statusPanels = this.statusPanels.filter((p) => p.state === "running");
		const panel = new StatusPanel(this.app, "Resuming");
		this.statusPanels.push(panel);
		let result: PipelineResult | null = null;
		const { code } = await this.runPipeline(["resume", "--state", statePath], (ev) => {
			panel.append(ev);
			if (ev.event === "result") result = ev.result;
		});
		panel.finish(code === 0);
		panel.addResultLinks(result?.notes ?? result?.sources ?? []);
		new Notice(code === 0 ? "Resume: finished." : "Resume: failed — see the log.");
		return result;
	}

	jobPath(title: string, ext: string): string {
		const dir = `${this.vaultPath()}/.midad-arabic-sources/jobs`;
		try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		return `${dir}/${ts}-${title.replace(/[^\w.-]+/g, "_")}.${ext}`;
	}

	newestState(): PipelineState | null {
		try {
			const dir = `${this.vaultPath()}/.midad-arabic-sources/jobs`;
			if (!fs.existsSync(dir)) return null;
			const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
			if (!files.length) return null;
			const name = files[files.length - 1];
			const st = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8")) as PipelineState;
			st._path = `${dir}/${name}`;
			return st;
		} catch {
			return null;
		}
	}

	async openLastLog() {
		try {
			const dir = `${this.vaultPath()}/.midad-arabic-sources/jobs`;
			if (!fs.existsSync(dir)) { new Notice("No pipeline logs yet."); return; }
			const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
			if (!files.length) { new Notice("No pipeline logs yet."); return; }
			const name = files[files.length - 1];
			new LogModal(this.app, name, fs.readFileSync(`${dir}/${name}`, "utf8")).open();
		} catch {
			new Notice("Could not read the pipeline logs.");
		}
	}

	async openTranscribe() {
		const item = this.activeItem();
		if (!item) { new Notice("Open a literature note (@citekey) first."); return; }
		if (!this.ensureApiKey()) return;
		let pdfs = (await this.pipelineResult(["list-pdfs", item.path]))?.pdfs ?? [];
		// If Python could not reach Zotero, use ScholarWeft's already-resolved paths.
		if (!pdfs.some((p) => p.exists)) {
			const sw = this.swPdfPaths(item.citekey);
			if (sw.length) {
				pdfs = sw.map((path) => {
					const filename = basenameJS(path);
					return { key: "", filename, path, exists: true, volume: inferVolumeJS(filename) };
				});
			}
		}
		if (!pdfs.length) { new Notice("No PDF attachments found for this item."); return; }
		new TranscribeModal(this.app, this, item.citekey, pdfs).open();
	}

	async openTranslate() {
		const item = this.activeItem();
		if (!item) { new Notice("Open a literature note (@citekey) first."); return; }
		if (!this.ensureApiKey()) return;
		const notes = ((await this.pipelineResult(["list-transcriptions", item.path]))?.notes ?? []) as unknown as PipelineNote[];
		const pdfs = (await this.pipelineResult(["list-pdfs", item.path]))?.pdfs ?? [];
		new TranslateModal(this.app, this, item.citekey, notes, pdfs).open();
	}

	async openReprocess() {
		const zips = (await this.pipelineResult(["list-archive"]))?.zips ?? [];
		new ReprocessModal(this.app, this, zips).open();
	}

	/** Ask the importer script for its catalogue of available works. */
	async listSources(): Promise<SourceWork[]> {
		let works: SourceWork[] = [];
		const { code, lines } = await this.runScript(this.settings.sourceImportScript, ["list", "--json"], (ev) => {
			if (ev.event === "works") works = ev.works as SourceWork[];
		});
		if (!works.length) console.error("[midad-arabic-sources] source list", { code, lines });
		return works;
	}

	/**
	 * The catalogue of available works. It changes rarely (a source repository adds
	 * an edition), so it is cached for the session and, on disk, for
	 * SOURCE_CATALOG_TTL — rather than re-listing every time the modal opens.
	 * `force` bypasses both caches.
	 */
	async listSourcesCached(force = false): Promise<SourceWork[]> {
		if (!force && this.sourceCatalog) return this.sourceCatalog;
		const path = normalizePath(".midad-arabic-sources/source-catalog.json");
		let cached: { at?: number; schema?: number; works?: SourceWork[] } | null = null;
		try {
			cached = JSON.parse(await this.app.vault.adapter.read(path)) as { at?: number; schema?: number; works?: SourceWork[] };
		} catch { /* no usable cache */ }
		const works0 = cached?.works;
		const usable = Array.isArray(works0) && works0.length > 0 && cached?.schema === SOURCE_CATALOG_SCHEMA;
		if (!force && usable && works0) {
			this.sourceCatalog = works0;
			// Serve the cache immediately; refresh in the background when it is old,
			// so opening the modal never waits on the repositories.
			if (Date.now() - (cached?.at ?? 0) >= SOURCE_CATALOG_TTL) void this.refreshSourceCatalogInBackground();
			return works0;
		}
		const works = await this.listSources();
		if (works.length) {
			this.sourceCatalog = works;
			try {
				await this.app.vault.adapter.write(path, JSON.stringify({ at: Date.now(), schema: SOURCE_CATALOG_SCHEMA, works }));
			} catch { /* ignore */ }
		}
		return works;
	}

	sourceCatalogRefreshing = false;

	/** Re-list the catalogue and persist it, without blocking the caller. */
	async refreshSourceCatalogInBackground(): Promise<void> {
		if (this.sourceCatalogRefreshing) return;
		this.sourceCatalogRefreshing = true;
		try {
			const works = await this.listSources();
			if (works.length) {
				this.sourceCatalog = works;
				await this.app.vault.adapter.write(
					normalizePath(".midad-arabic-sources/source-catalog.json"),
					JSON.stringify({ at: Date.now(), schema: SOURCE_CATALOG_SCHEMA, works })
				);
			}
		} catch (e) {
			console.error("[midad-arabic-sources] catalogue refresh", e);
		} finally {
			this.sourceCatalogRefreshing = false;
		}
	}

	/** Refresh the catalogue in the background at startup when it is past its TTL. */
	async maybeRefreshSourceCatalog(): Promise<void> {
		try {
			const text = await this.app.vault.adapter.read(normalizePath(".midad-arabic-sources/source-catalog.json"));
			const cached = JSON.parse(text) as { at?: number };
			if (Date.now() - (cached.at ?? 0) >= SOURCE_CATALOG_TTL) await this.refreshSourceCatalogInBackground();
		} catch { /* no cache yet */ }
	}

	// ── Zotero export ───────────────────────────────────────────────────────

	zoteroStatePath(): string {
		return ".midad-arabic-sources/zotero-export.json";
	}

	async loadZoteroState(): Promise<Record<string, { itemKey: string; hash: string }>> {
		try {
			const text = await this.app.vault.adapter.read(normalizePath(this.zoteroStatePath()));
			const parsed = JSON.parse(text) as { items?: Record<string, { itemKey: string; hash: string }> };
			return parsed.items ?? {};
		} catch {
			return {};
		}
	}

	async saveZoteroState(items: Record<string, { itemKey: string; hash: string }>): Promise<void> {
		try {
			await this.app.vault.adapter.write(normalizePath(this.zoteroStatePath()), JSON.stringify({ items }, null, 1));
		} catch { /* ignore */ }
	}

	/**
	 * Measured on-disk footprints, keyed by work. Kept in its own file (not the
	 * catalogue, which is re-listed, nor the manifest, which is rebuilt) so a
	 * measurement survives both. A removed work keeps its last size, as the user
	 * asked; an installed work is re-measured only after its hub changes.
	 */
	async loadSourceStats(): Promise<Record<string, SourceStat>> {
		try {
			const text = await this.app.vault.adapter.read(normalizePath(".midad-arabic-sources/source-stats.json"));
			const parsed = JSON.parse(text) as { works?: Record<string, SourceStat> };
			return parsed?.works && typeof parsed.works === "object" ? parsed.works : {};
		} catch {
			return {};
		}
	}

	async saveSourceStats(works: Record<string, SourceStat>): Promise<void> {
		try {
			await this.app.vault.adapter.write(
				normalizePath(".midad-arabic-sources/source-stats.json"),
				JSON.stringify({ works }, null, 1)
			);
		} catch { /* ignore */ }
	}

	/** A work's hub note `updated` time (its last-render watermark), in ms. */
	hubUpdatedMs(work: JsonObject): number {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const file = this.app.vault.getAbstractFileByPath(normalizePath(`${outRoot}/${work.dir}.md`));
		const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
		return frontmatterTimeMs(fm?.["updated"]) ?? 0;
	}

	/**
	 * When a work was last rendered (epoch ms): its newest per-template watermark
	 * if recorded, else its hub note's `updated`, else 0.
	 */
	workRenderedMs(work: JsonObject, stat?: SourceStat): number {
		const vals = stat?.rendered ? Object.values(stat.rendered) : [];
		if (vals.length) return Math.max(...vals);
		return this.hubUpdatedMs(work);
	}

	/**
	 * A plain-text publisher for a work. Citation styles expect one, and the
	 * repositories do not carry an imprint — so the work's own source is named
	 * where we know it, else the repository that supplied the text.
	 */
	zoteroPublisher(w: JsonObject): string {
		const FRIENDLY: Record<string, string> = {
			"qul.tarteel.ai": "Quranic Universal Library (Tarteel)",
			"altafsir.com": "Altafsir.com",
			"tanzil.net": "Tanzil Project",
			"qurancomplex.gov.sa": "King Fahd Glorious Qurʾān Printing Complex",
			"sunnah.com": "Sunnah.com",
			"quran-json.risanb.com": "risan/quran-json",
		};
		let host = "";
		try {
			host = new URL(String(w.source || "")).hostname.replace(/^www\./, "");
		} catch { /* not a URL */ }
		// A GitHub URL names the repo, not a publisher, so fall through to owner/name.
		if (host && host !== "github.com" && host !== "raw.githubusercontent.com") {
			return FRIENDLY[host] ?? host;
		}
		const m = String(w.repo || w.source || "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
		return m ? `${m[1]}/${m[2]}` : String(w.repo_name || w.repo || "");
	}

	/**
	 * The user's publication map (their template folder first, then the bundled
	 * default): researched bibliographic details keyed by work key.
	 */
	async loadPublicationMap(): Promise<Record<string, JsonObject>> {
		const folder = this.settings.sourceTemplateFolder.trim();
		const paths = [
			folder ? `${folder}/${TEMPLATE_FOLDER}/publication-map.json` : "",
			`${this.bundledTemplateDir()}/publication-map.json`,
		];
		for (const p of paths) {
			if (!p) continue;
			try {
				const text = await this.app.vault.adapter.read(normalizePath(p));
				return (JSON.parse(text) ?? {}) as Record<string, JsonObject>;
			} catch { /* try the next */ }
		}
		return {};
	}

	/** Split a personal name into Zotero's firstName / lastName fields, best effort. */
	nameParts(name: string): { firstName?: string; lastName?: string; name?: string } {
		const s = String(name ?? "").trim();
		const parts = s.split(/\s+/).filter(Boolean);
		if (parts.length <= 1) return { lastName: s };
		return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
	}

	/** A Zotero creator from a name string, or a `{first, last}` / `{name}` object. */
	creator(creatorType: string, value: CreatorValue): JsonObject {
		if (value && typeof value === "object") {
			const last = value.last ?? value.lastName ?? "";
			const first = value.first ?? value.firstName ?? "";
			if (last || first) return { creatorType, firstName: String(first), lastName: String(last) };
			if (value.name) return { creatorType, name: String(value.name) };
		}
		return { creatorType, ...this.nameParts(String((value as string | null | undefined) ?? "")) };
	}

	/** The display form of a name (string or `{first, last}` object). */
	nameText(value: CreatorValue): string {
		if (value && typeof value === "object") {
			return String(value.name ?? [value.first, value.last].filter(Boolean).join(" "));
		}
		return String((value as string | null | undefined) ?? "");
	}

	/**
	 * The human-readable notes that accompany an item — the publication map's own
	 * `note` plus the provisional caveat — combined into the single `mas-note`
	 * property the hub carries, so nothing in the Zotero `extra` is kept only in
	 * Zotero. Mirrors the `extra` built by `zoteroItem`.
	 */
	masNote(pub: JsonObject): string {
		return [
			pub.note ? String(pub.note) : "",
			pub.verified ? "" : BIB_PROVISIONAL,
		].filter(Boolean).join(" ");
	}

	/** A Zotero `book` item built from a work's model, overlaid by the publication map. */
	zoteroItem(w: JsonObject, pub: JsonObject = {}): JsonObject {
		const authors = (pub.authors ?? w.authors ?? []) as CreatorValue[];
		const translators = (pub.translators ?? w.translators ?? []) as CreatorValue[];
		const editors = (pub.editors ?? []) as CreatorValue[];
		const creators = [
			...authors.map((n) => this.creator("author", n)),
			...translators.map((n) => this.creator("translator", n)),
			...editors.map((n) => this.creator("editor", n)),
		];
		const extra = [
			w.repo ? `Repository: ${w.repo}` : "",
			w.license_attribution ? `Attribution: ${w.license_attribution}` : "",
			w.repository_updated ? `Repository updated: ${w.repository_updated}` : "",
			pub.note ? `Note: ${pub.note}` : "",
			pub.verified ? "" : BIB_PROVISIONAL,
			`Midad Arabic Sources: ${w.key}`,
		].filter(Boolean).join("\n");
		return {
			itemType: "book",
			title: String(pub.title || w.title || w.name || ""),
			creators,
			date: String(pub.date || w.repository_updated || ""),
			url: String(w.source || w.repo || ""),
			publisher: String(pub.publisher || this.zoteroPublisher(w)),
			place: String(pub.place || ""),
			edition: String(pub.edition || ""),
			libraryCatalog: String(w.repo_name || ""),
			extra,
			tags: [{ tag: ZOTERO_MARK }, { tag: String(w.collection || "") }],
		};
	}

	/**
	 * Every installed work with its Zotero status: `new` (never sent), `changed`
	 * (sent before but altered, or deleted in Zotero), or `current`.
	 */
	async zoteroEntries(): Promise<Array<{ work: JsonObject; item: JsonObject; hash: string; itemKey: string; status: "new" | "changed" | "current" }>> {
		const manifest = await this.loadSourceManifest();
		const installed = manifest.filter((w) => this.workStatus(w) === "installed");
		const state = await this.loadZoteroState();
		const live = this.settings.zoteroMethod === "local" ? await this.zoteroLiveKeys() : null;
		const pubs = await this.loadPublicationMap();
		const out: Array<{ work: JsonObject; item: JsonObject; hash: string; itemKey: string; status: "new" | "changed" | "current" }> = [];
		for (const work of installed) {
			const key = this.workKey(work);
			const item = this.zoteroItem(work, pubs[key] ?? {});
			const hash = hashString(JSON.stringify(item));
			const prev = state[key];
			let status: "new" | "changed" | "current" = "new";
			// If the item was never sent, or has since been deleted in Zotero, it is
			// created; otherwise an update targets the existing item in place.
			const itemKey = prev && prev.itemKey && (live === null || live.has(prev.itemKey)) ? prev.itemKey : "";
			if (prev) status = itemKey === "" || prev.hash !== hash ? "changed" : "current";
			out.push({ work, item, hash, itemKey, status });
		}
		out.sort((a, b) => String(a.work.title).localeCompare(String(b.work.title)));
		return out;
	}

	/** The installed works that need (re)sending. */
	async zoteroPending(): Promise<Array<{ work: JsonObject; item: JsonObject; hash: string; itemKey: string }>> {
		return (await this.zoteroEntries()).filter((e) => e.status !== "current");
	}

	/** The installed work whose hub or folder contains `path`, if any. */
	async workForPath(path: string): Promise<JsonObject | null> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const manifest = await this.loadSourceManifest();
		for (const w of manifest) {
			const dir = String(w.dir ?? "");
			if (!dir) continue;
			if (path === `${outRoot}/${dir}.md` || path.startsWith(`${outRoot}/${dir}/`)) return w;
		}
		return null;
	}

	/** The item keys present in the local library, or null if it cannot be read. */
	async zoteroLiveKeys(): Promise<Set<string> | null> {
		try {
			const resp = await this.zbFetch("GET", "http://127.0.0.1:23119/api/users/0/items?format=keys&limit=100", {});
			return new Set(resp.text.split("\n").map((s) => s.trim()).filter(Boolean));
		} catch {
			return null;
		}
	}

	/** Auth headers for a Zotero method. */
	/**
	 * A plain Node HTTP request. Electron's `requestUrl` runs through Chromium's
	 * net stack, which closes on the local Zotero server with `ERR_EMPTY_RESPONSE`
	 * (an HTTP/1.0 quirk) even though `curl` reaches it fine. Node's `http` module
	 * talks to it normally.
	 */
	async localHttp(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; headers: Record<string, string> }> {
		const u = new URL(url);
		const h = { ...headers };
		if (body) h["Content-Type"] = "application/json";
		if (body) h["Content-Length"] = String(Buffer.byteLength(body));
		return await new Promise((resolve, reject) => {
			const req = http.request(
				{ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h },
				(res: http.IncomingMessage) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							text: Buffer.concat(chunks).toString("utf8"),
							headers: (res.headers ?? {}) as Record<string, string>,
						})
					);
				}
			);
			req.on("error", reject);
			if (body) req.write(body);
			req.end();
		});
	}

	/**
	 * One hardened Zotero request: routes localhost through Node's http (see
	 * `localHttp`), never throws on an empty body, logs the method/url/status, and
	 * returns the parsed parts.
	 */
	async zbFetch(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; json: unknown; headers: Record<string, string> }> {
		let status = 0;
		let text = "";
		let hdrs: Record<string, string> = {};
		if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
			const r = await this.localHttp(method, url, headers, body);
			status = r.status;
			text = r.text;
			hdrs = r.headers;
		} else {
			const resp = await requestUrl({
				method,
				url,
				headers,
				body,
				contentType: body ? "application/json" : undefined,
				throw: false,
			});
			status = resp.status;
			text = resp.text ?? "";
			hdrs = resp.headers ?? {};
		}
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		console.debug("[arabic-support] zotero", method, url, "→", status);
		return { status, text, json, headers: hdrs };
	}

	zoteroHeaders(method: "local" | "web"): Record<string, string> {
		return method === "local"
			? { "Zotero-Server-ID": this.settings.zoteroServerId }
			: { "Zotero-API-Key": this.settings.zoteroApiKey.trim(), "Zotero-API-Version": "3" };
	}

	/** The base URL of the active Zotero library for a method. */
	zoteroLibraryPath(method: "local" | "web"): string {
		return method === "local"
			? "http://127.0.0.1:23119/api/users/0"
			: `https://api.zotero.org/users/${this.settings.zoteroLibraryId.trim()}`;
	}

	/** The key of the plugin's Zotero collection, creating it if it is missing. */
	async ensureZoteroCollection(method: "local" | "web"): Promise<string> {
		const base = this.zoteroLibraryPath(method);
		const headers = this.zoteroHeaders(method);
		const list = await this.zbFetch("GET", `${base}/collections?limit=100`, headers);
		const refs = (list.json as ZoteroCollectionRef[] | null) ?? [];
		const found = refs.find((c) => c.data?.name === ZOTERO_MARK);
		if (found) return String(found.key ?? found.data?.key ?? "");
		const resp = await this.zbFetch("POST", `${base}/collections`, headers, JSON.stringify([{ name: ZOTERO_MARK }]));
		const created = resp.json as ZoteroCreateResponse | null;
		return String(created?.successful?.["0"]?.key ?? "");
	}

	/** Add `mas-up: [[@citekey]]` to the work note for any item Better BibTeX has keyed. */
	async applyCitekeys(
		pending: Array<{ work: JsonObject }>,
		keys: string[],
		method: "local" | "web"
	): Promise<void> {
		const base = this.zoteroLibraryPath(method);
		const headers = this.zoteroHeaders(method);
		for (let i = 0; i < pending.length; i++) {
			if (!keys[i]) continue;
			try {
				const resp = await this.zbFetch("GET", `${base}/items/${keys[i]}`, headers);
				const item = resp.json as ZoteroItemResponse | null;
				const ck = item?.data?.citationKey;
				if (ck) await this.addCitekeyUp(pending[i].work, String(ck));
			} catch { /* ignore */ }
		}
	}

	/** Prepend `- "[[@citekey]]"` under the work note's `mas-up:` list, once. */
	async addCitekeyUp(work: JsonObject, citekey: string): Promise<void> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const hub = normalizePath(`${outRoot}/${work.dir}.md`);
		try {
			const text = await this.app.vault.adapter.read(hub);
			if (text.includes(`[[@${citekey}]]`)) return;
			const next = text.replace(/^(mas-up:\n(?: {2}- .+\n)+)/m, (m) => `${m}  - "[[@${citekey}]]"\n`);
			if (next !== text) await this.app.vault.adapter.write(hub, next);
		} catch { /* ignore */ }
	}

	/** One item's current version, for a conditional (in-place) update. */
	async zoteroItemVersion(method: string, itemKey: string): Promise<number | null> {
		try {
			const url = method === "web"
				? `https://api.zotero.org/users/${this.settings.zoteroLibraryId.trim()}/items/${itemKey}`
				: `http://127.0.0.1:23119/api/users/0/items/${itemKey}`;
			const headers: Record<string, string> = method === "web"
				? { "Zotero-API-Key": this.settings.zoteroApiKey.trim(), "Zotero-API-Version": "3" }
				: (this.settings.zoteroServerId ? { "Zotero-Server-ID": this.settings.zoteroServerId } : {});
			const resp = await this.zbFetch("GET", url, headers);
			const item = resp.json as ZoteroItemResponse | null;
			const v = item?.version ?? item?.data?.version;
			return typeof v === "number" ? v : null;
		} catch {
			return null;
		}
	}

	async sendZoteroLocal(pending: Array<{ item: JsonObject; itemKey: string }>): Promise<string[]> {
		const base = "http://127.0.0.1:23119/api";
		const probe = await this.zbFetch("GET", `${base}/users/0/items?limit=1`, {});
		const serverId = header(probe, "Zotero-Server-ID") || this.settings.zoteroServerId;
		if (!serverId) throw new Error("Local Zotero is running, but its server id could not be read.");
		const version = header(probe, "Last-Modified-Version") || "0";
		const auth = await this.zbFetch(
			"POST",
			`${base}/local/authorize`,
			{ "Zotero-Server-ID": serverId },
			JSON.stringify({ appName: "Midad Arabic Sources" })
		);
		const authResp = auth.json as ZoteroAuthResponse | null;
		const key = String(authResp?.key ?? "");
		if (!key) throw new Error(`Local Zotero refused the connection (${auth.status}): ${auth.text.slice(0, 160)}`);
		const headers = { "Zotero-API-Key": key, "Zotero-Server-ID": serverId };
		const out: string[] = pending.map(() => "");
		const idx = pending.map((p, i) => [p, i] as const);

		// New items are created in one batch…
		const creates = idx.filter(([p]) => !p.itemKey);
		if (creates.length) {
			const resp = await this.zbFetch(
				"POST",
				`${base}/users/0/items`,
				{ ...headers, "If-Unmodified-Since-Version": version },
				JSON.stringify(creates.map(([p]) => p.item))
			);
			if (resp.status >= 400) throw new Error(`Zotero ${resp.status}: ${resp.text.slice(0, 200)}`);
			const created = resp.json as ZoteroCreateResponse | null;
			const successful = created?.successful ?? {};
			creates.forEach(([, i], n) => { out[i] = String(successful[String(n)]?.key ?? ""); });
		}
		// …and items we sent before are updated in place, never duplicated.
		for (const [p, i] of idx.filter(([p]) => p.itemKey)) {
			const v = await this.zoteroItemVersion("local", p.itemKey);
			const resp = await this.zbFetch(
				"PUT",
				`${base}/users/0/items/${p.itemKey}`,
				{ ...headers, ...(v !== null ? { "If-Unmodified-Since-Version": String(v) } : {}) },
				JSON.stringify(p.item)
			);
			if (resp.status >= 400) throw new Error(`Zotero update ${resp.status}: ${resp.text.slice(0, 200)}`);
			out[i] = p.itemKey;
		}
		return out;
	}

	async sendZoteroWeb(pending: Array<{ item: JsonObject; itemKey: string }>): Promise<string[]> {
		const key = this.settings.zoteroApiKey.trim();
		const lib = this.settings.zoteroLibraryId.trim();
		if (!key || !lib) throw new Error("Web API key and library ID are required.");
		const headers = { "Zotero-API-Key": key, "Zotero-API-Version": "3" };
		const out: string[] = pending.map(() => "");
		const idx = pending.map((p, i) => [p, i] as const);

		const creates = idx.filter(([p]) => !p.itemKey);
		if (creates.length) {
			const resp = await this.zbFetch(
				"POST",
				`https://api.zotero.org/users/${lib}/items`,
				headers,
				JSON.stringify(creates.map(([p]) => p.item))
			);
			if (resp.status >= 400) throw new Error(`Zotero ${resp.status}: ${resp.text.slice(0, 200)}`);
			const created = resp.json as ZoteroCreateResponse | null;
			const successful = created?.successful ?? {};
			creates.forEach(([, i], n) => { out[i] = String(successful[String(n)]?.key ?? ""); });
		}
		for (const [p, i] of idx.filter(([p]) => p.itemKey)) {
			const v = await this.zoteroItemVersion("web", p.itemKey);
			const resp = await this.zbFetch(
				"PUT",
				`https://api.zotero.org/users/${lib}/items/${p.itemKey}`,
				{ ...headers, ...(v !== null ? { "If-Unmodified-Since-Version": String(v) } : {}) },
				JSON.stringify(p.item)
			);
			if (resp.status >= 400) throw new Error(`Zotero update ${resp.status}: ${resp.text.slice(0, 200)}`);
			out[i] = p.itemKey;
		}
		return out;
	}

	async writeZoteroCsl(pending: Array<{ item: JsonObject }>): Promise<string> {
		const csl = pending.map((p) => {
			const it = p.item as CslSourceItem;
			const creators = it.creators ?? [];
			const of = (t: string) => creators.filter((c) => c.creatorType === t).map((c) => (
				c.name ? { literal: c.name } : { family: c.lastName || undefined, given: c.firstName || undefined }
			));
			return {
				type: "book",
				title: it.title,
				author: of("author"),
				translator: of("translator"),
				issued: it.date ? { "date-parts": [[Number(String(it.date).slice(0, 4))]] } : undefined,
				URL: it.url || undefined,
				publisher: it.publisher || undefined,
				"publisher-place": it.place || undefined,
				edition: it.edition || undefined,
				note: it.extra || undefined,
			};
		});
		const path = normalizePath("_7 Sources/zotero-export.csl.json");
		await this.app.vault.adapter.write(path, JSON.stringify(csl, null, 2));
		return path;
	}

	/** Send the installed sources to Zotero (only new/changed ones). */
	async exportToZotero(onlyKeys?: Set<string>, silent = false): Promise<void> {
		if (!this.settings.zoteroExport) {
			if (!silent) new Notice("Enable Zotero export in settings first.");
			return;
		}
		const method = this.settings.zoteroMethod;
		let pending = await this.zoteroPending();
		if (onlyKeys) pending = pending.filter((p) => onlyKeys.has(String(p.work.key)));
		if (!pending.length) {
			if (!silent) new Notice("Nothing to send — the selection is already up to date.");
			return;
		}
		const progress = silent ? null : new Notice(`Sending ${pending.length} source(s) to Zotero…`, 0);
		try {
			const state = await this.loadZoteroState();
			if (method === "csl") {
				const path = await this.writeZoteroCsl(pending);
				for (const p of pending) state[String(p.work.key)] = { itemKey: "", hash: p.hash };
				if (!silent) new Notice(`Wrote ${pending.length} item(s) to ${path}. Import it in Zotero (File → Import).`);
			} else {
				progress?.setMessage(`Sending ${pending.length} source(s) to Zotero (${method} API)…`);
				// Everything goes into the plugin's own collection, so its items are
				// easy to find (and to remove) as a set.
				const coll = await this.ensureZoteroCollection(method);
				if (coll) for (const p of pending) p.item.collections = [coll];
				const keys = method === "local"
					? await this.sendZoteroLocal(pending)
					: await this.sendZoteroWeb(pending);
				pending.forEach((p, i) => {
					state[String(p.work.key)] = { itemKey: keys[i] || "", hash: p.hash };
				});
				// A Better BibTeX citekey, if present, becomes an `up` link on the work note.
				await this.applyCitekeys(pending, keys, method);
				if (!silent) new Notice(`Sent ${pending.length} item(s) to Zotero.`);
			}
			await this.saveZoteroState(state);
		} catch (e) {
			if (!silent) new Notice(`Zotero export failed: ${e instanceof Error ? e.message : e}`);
			console.error("[midad-arabic-sources] zotero export", e);
		} finally {
			progress?.hide();
		}
	}

	/**
	 * The automatic half of the export: keep Zotero in step without asking, once
	 * the user has opted in. A work never sent is created only when auto-create is
	 * on; a work sent before is updated in place only when auto-update is on (and
	 * is recreated — after a deletion in Zotero — only when auto-create is on).
	 *
	 * Whether an item actually changed is decided by its content hash, which is
	 * built from the work model and the publication map — *not* from the rendered
	 * note. A pure template re-render therefore changes no Zotero field and sends
	 * nothing; only a re-fetch (new model) or a publication-map edit does.
	 */
	async autoSyncZotero(): Promise<void> {
		if (!this.settings.zoteroExport) return;
		const allowCreate = this.settings.zoteroAutoCreate === true;
		const allowUpdate = this.settings.zoteroAutoUpdate === true;
		if (!allowCreate && !allowUpdate) return;
		// A render and the startup pass can overlap; never run two at once, and
		// re-run once if something asked while we were busy.
		if (this.zoteroSyncRunning) {
			this.zoteroSyncAgain = true;
			return;
		}
		this.zoteroSyncRunning = true;
		try {
			do {
				this.zoteroSyncAgain = false;
				const state = await this.loadZoteroState();
				const entries = await this.zoteroEntries();
				const todo = entries.filter((e) => {
					if (e.status === "current") return false;
					if (!state[String(e.work.key)]) return allowCreate; // never exported
					return e.itemKey ? allowUpdate : allowCreate; // update, or re-create after a delete
				});
				if (todo.length) await this.exportToZotero(new Set(todo.map((e) => String(e.work.key))), true);
			} while (this.zoteroSyncAgain);
		} catch (e) {
			console.error("[midad-arabic-sources] automatic Zotero sync", e);
		} finally {
			this.zoteroSyncRunning = false;
		}
	}

	/** Open the modal to choose which installed sources to send. */
	async openZoteroSend(): Promise<void> {
		if (!this.settings.zoteroExport) {
			new Notice("Enable Zotero export in settings first.");
			return;
		}
		const entries = await this.zoteroEntries();
		if (!entries.length) {
			new Notice("No installed sources to send.");
			return;
		}
		new ZoteroSendModal(this.app, this, entries).open();
	}

	/** Send the work of the currently open source note. */
	async sendActiveSource(): Promise<void> {
		if (!this.settings.zoteroExport) {
			new Notice("Enable Zotero export in settings first.");
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Open a source note first.");
			return;
		}
		const work = await this.workForPath(file.path);
		if (!work) {
			new Notice("That note is not an imported source.");
			return;
		}
		await this.exportToZotero(new Set([this.workKey(work)]));
	}

	/** The local Zotero's library id + server id, if it is running on :23119. */
	async detectZoteroLocal(): Promise<{ libraryId: number; serverId: string } | null> {
		try {
			const resp = await this.zbFetch("GET", "http://127.0.0.1:23119/api/users/0/items?limit=1", {});
			const first = ((resp.json as Array<{ library?: { id?: number } }> | null) ?? [])[0];
			const libraryId = first?.library?.id;
			if (!libraryId) return null;
			return {
				libraryId: Number(libraryId),
				serverId: header(resp, "Zotero-Server-ID") || this.settings.zoteroServerId,
			};
		} catch {
			return null;
		}
	}

	/** Whether a work's source text is already downloaded (in the cache). */
	async sourceIsCached(key: string): Promise<boolean> {
		const id = key.split(":")[1] ?? key;
		try {
			const listed = await this.app.vault.adapter.list(normalizePath(".midad-arabic-sources/cache/text-sources"));
			const needle = new RegExp(`_${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_|\\.json$)`);
			return listed.files.some((f) => needle.test(f));
		} catch {
			return false;
		}
	}

	async openManageSources(force = false) {
		const loading = new Notice("Loading available sources…", 0);
		try {
			const works = await this.listSourcesCached(force);
			if (!works.length) {
				new Notice("No sources found. Is Python configured and the importer script present?");
				return;
			}
			const manifest = await this.loadSourceManifest();
			const statusKeys = (status: "installed" | "deleting") =>
				new Set(manifest.filter((w) => this.workStatus(w) === status).map((w) => this.workKey(w)));
			const installedKeys = statusKeys("installed");
			// A real footprint is known only for works we've downloaded (installed or
			// cached); the repositories don't publish sizes, so the rest show "—".
			// Measurements are cached (loadSourceStats): an installed work is
			// re-measured only after its hub changes, and a removed work keeps its
			// last size — so opening the modal never re-stats the whole corpus.
			const sizes = new Map<string, number>();
			const stats = await this.loadSourceStats();
			let statsDirty = false;
			for (const w of works) {
				const st = stats[w.key];
				if (installedKeys.has(w.key)) {
					if (st && typeof st.bytes === "number" && (st.at ?? 0) > this.workRenderedMs(w, st)) {
						sizes.set(w.key, st.bytes);
					} else {
						const bytes = await this.onDiskBytes(w);
						sizes.set(w.key, bytes);
						stats[w.key] = { ...st, bytes, at: Date.now() };
						statsDirty = true;
					}
				} else if (st && typeof st.bytes === "number") {
					sizes.set(w.key, st.bytes); // removed, but its last size is remembered
				} else if (w.cache_bytes) {
					sizes.set(w.key, w.cache_bytes);
				}
			}
			if (statsDirty) await this.saveSourceStats(stats);
			// Zotero status per work, so the modal can pre-check the new/changed ones.
			const zoteroStatus = new Map<string, string>();
			if (this.settings.zoteroExport) {
				for (const e of await this.zoteroEntries()) zoteroStatus.set(String(e.work.key), e.status);
			}
			new ManageSourcesModal(
				this.app, this, works, installedKeys, statusKeys("deleting"), sizes, zoteroStatus,
				() => { void this.openManageSources(true); }
			).open();
		} finally {
			loading.hide();
		}
	}

	/**
	 * Delete a work's notes, its cached model, and its manifest entry.
	 * `onProgress(done, total)` reports per-file progress so a slow removal is
	 * not silent.
	 */
	async removeSource(work: JsonObject, onProgress?: (done: number, total: number) => void): Promise<void> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const dir = work.dir as string;
		const adapter = this.app.vault.adapter;
		const problems: string[] = [];
		const key = this.workKey(work);

		// Flag first: auto-maintenance must not treat the half-removed state as a
		// broken install and re-fetch it.
		await this.markPendingDeletion(key);
		try {
			const modelPath = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
			const hubPath = normalizePath(`${outRoot}/${dir}.md`);
			const folderPath = normalizePath(`${outRoot}/${dir}`);

			// Drop the cached model first, so nothing can re-render the work while
			// the (larger, slower) note files are being deleted.
			if (await adapter.exists(modelPath)) {
				try {
					await adapter.remove(modelPath);
				} catch (e) {
					problems.push(`model: ${e instanceof Error ? e.message : e}`);
				}
			}

			// Enumerate what is left, so progress is meaningful.
			const files: string[] = [];
			if (await adapter.exists(hubPath)) files.push(hubPath);
			if (await adapter.exists(folderPath)) files.push(...(await this.listFilesUnder(folderPath)));
			const total = files.length;
			let done = 0;
			onProgress?.(0, total);

			for (const f of files) {
				try {
					await adapter.remove(f);
				} catch (e) {
					problems.push(`${f}: ${e instanceof Error ? e.message : e}`);
				}
				onProgress?.(++done, total);
			}
			// Clear any now-empty folders left behind.
			if (await adapter.exists(folderPath)) {
				try {
					await adapter.rmdir(folderPath, true);
				} catch { /* already gone */ }
			}

			// Fully removed: drop it from the manifest (which is the status list).
			// On a problem the entry stays, still flagged "deleting", so the next
			// maintenance run retries the removal rather than restoring the work.
			if (!problems.length) {
				const manifest = await this.loadSourceManifest();
				await this.saveSourceManifest(
					manifest.filter((w) => !(w.collection === work.collection && w.id === work.id) && w.dir !== dir)
				);
			}

			// Refresh only the MOCs and parent note; never re-render the removed
			// work. It is still flagged, so it drops out of the sources list now.
			await this.refreshSourcesIndex();
		} catch (e) {
			// Leave the entry flagged "deleting": the next maintenance run retries.
			problems.push(e instanceof Error ? e.message : String(e));
			console.error("[midad-arabic-sources] removeSource", key, e);
		}

		if (problems.length) {
			console.error("[midad-arabic-sources] removeSource", key, problems);
			new Notice(`Removed “${work.title || dir}” with problems: ${problems.join("; ")}`);
		}
	}

	/** Every file under `path` (vault-relative), following subfolders. */
	async listFilesUnder(path: string): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		const out: string[] = [];
		const walk = async (p: string) => {
			let listed;
			try {
				listed = await adapter.list(p);
			} catch {
				return;
			}
			for (const f of listed.files) out.push(f);
			for (const d of listed.folders) await walk(d);
		};
		await walk(path);
		return out;
	}

	/**
	 * A work's real on-disk footprint: downloaded source + render model + the
	 * rendered notes. This is what the user's drive actually holds, which is not
	 * the same as the repository size (a fetch, a model, and markdown all count).
	 */
	async onDiskBytes(work: JsonObject): Promise<number> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const adapter = this.app.vault.adapter;
		let total = Number(work.cache_bytes ?? 0);
		// The cached model is plugin state, outside the vault index.
		try {
			const s = await adapter.stat(normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`));
			if (s) total += s.size;
		} catch { /* not present */ }
		// The hub and the work's folder come from the vault index, which is already
		// in memory — so a 50,000-file work costs no per-file `stat`.
		const hub = normalizePath(`${outRoot}/${work.dir}.md`);
		const prefix = normalizePath(`${outRoot}/${work.dir}/`);
		for (const f of this.app.vault.getFiles()) {
			if (f.path === hub || f.path.startsWith(prefix)) total += f.stat.size;
		}
		return total;
	}

	/**
	 * Remove notes a work left under its old, title-based folder after its folder
	 * was renamed. Before disambiguation every work's folder *was* its title, so a
	 * stale folder is exactly `<title>` when that differs from the current folder.
	 * Guarded on `document-type: text-source` so an unrelated note of the same name
	 * is never touched.
	 */
	async pruneRenamedFolder(work: JsonObject): Promise<void> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const dir = String(work.dir ?? "");
		const title = String(work.title ?? "");
		if (!dir || !title || dir === title) return;
		const adapter = this.app.vault.adapter;
		const hub = normalizePath(`${outRoot}/${title}.md`);
		try {
			if (!(await adapter.exists(hub))) return;
			if (!(await adapter.read(hub)).includes("text-source")) return;
			await adapter.remove(hub);
			const folder = normalizePath(`${outRoot}/${title}`);
			if (await adapter.exists(folder)) await adapter.rmdir(folder, true);
		} catch { /* leave it if anything is off */ }
	}

	/**
	 * Rebuild the category MOCs and the parent note from what is currently
	 * installed. Unlike a full re-render this never touches work notes, so it
	 * cannot resurrect a just-removed source.
	 */
	async refreshSourcesIndex(): Promise<string[]> {
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch {
			return [];
		}
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const manifest = await this.loadSourceManifest();
		// Keep every entry — including ones still being removed — in the manifest
		// (the status list), but only list live, non-deleting works in the index.
		const byKey = new Map<string, JsonObject>();
		for (const w of manifest) byKey.set(this.workKey(w), w);
		// Self-heal: a model on disk with no manifest entry (e.g. the manifest was
		// lost) is re-adopted from that model. Filenames are scanned first, so the
		// only models read are the ones actually missing — never the whole corpus.
		for (const key of await this.listModelKeys()) {
			if (byKey.has(key)) continue;
			try {
				const rel = normalizePath(`.midad-arabic-sources/source-models/${key.replace(":", "/")}.json`);
				const m = JSON.parse(await this.app.vault.adapter.read(rel)) as SourceModel;
				byKey.set(key, m.work);
			} catch { /* skip */ }
		}
		const works = [...byKey.values()];
		await this.saveSourceManifest(works);
		// The index lists every work that is *installed* — its status is
		// authoritative, so a work with missing files still belongs (it will be
		// restored); a work being removed does not.
		const installed = works.filter((w) => this.workStatus(w) === "installed");
		const today = new Date().toISOString().slice(0, 10);
		const written = await renderMocs(this.app, templates, installed, outRoot, today, this.settings.sourceMocParent.trim() || "Sources", true);
		const mocNames = [...new Set(installed.map((w) => (typeof w.moc === "string" ? w.moc : "")).filter(Boolean))].sort();
		const parentPath = await this.updateSourceParent(templates, mocNames, today);
		if (parentPath) written.push(parentPath);
		return written;
	}

	/** Works whose notes are partially or wholly missing in the vault. */
	/** Works whose notes or cached model are missing in the vault. */
	async findIncompleteSources(): Promise<Array<{ work: JsonObject; missing: number; total: number; reason: string }>> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const modelKeys = new Set(await this.listModelKeys());
		const stats = await this.loadSourceStats();
		const canonicalId = this.resolveCanonicalQuran();
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		const out: Array<{ work: JsonObject; missing: number; total: number; reason: string }> = [];
		for (const work of manifest) {
			if (pending.has(this.workKey(work))) continue; // being removed
			if (!modelKeys.has(`${work.collection}:${work.id}`)) {
				// The cached model is gone, so the work can no longer be re-rendered.
				out.push({ work, missing: 0, total: 0, reason: "model" });
				continue;
			}
			// Cheap path: a work whose last full render we recorded, at the current
			// model schema, and whose file count is intact needs no model read — so
			// startup never parses the whole (100+ MB) corpus.
			const st = stats[this.workKey(work)];
			if (
				st && typeof st.notes === "number" && typeof st.schema === "number" &&
				st.schema >= requiredModelSchema(String(work.collection ?? "")) &&
				this.countWorkFiles(work) === st.notes
			) {
				continue;
			}
			// Precise path: read the model and check each expected note.
			let model: SourceModel;
			try {
				const rel = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
				model = JSON.parse(await this.app.vault.adapter.read(rel)) as SourceModel;
			} catch {
				out.push({ work, missing: 0, total: 0, reason: "model" });
				continue;
			}
			if (Number(model.schema ?? 0) < requiredModelSchema(String(work.collection ?? model.work.collection ?? ""))) {
				// The model predates a change to this collection's acquisition (so a
				// re-render cannot apply it); re-fetch it instead.
				out.push({ work, missing: 0, total: 0, reason: "model-stale" });
				continue;
			}
			const paths = expectedNotePaths(model, outRoot, canonicalRoot, canonicalId);
			let missing = 0;
			for (const p of paths) if (!this.app.vault.getAbstractFileByPath(normalizePath(p))) missing++;
			if (missing > 0) out.push({ work, missing, total: paths.length, reason: "notes" });
		}
		return out;
	}

	/** How many notes a work currently has (its hub plus everything in its folder). */
	countWorkFiles(work: JsonObject): number {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const hub = normalizePath(`${outRoot}/${work.dir}.md`);
		const prefix = normalizePath(`${outRoot}/${work.dir}/`);
		let n = 0;
		for (const f of this.app.vault.getFiles()) {
			if (f.path === hub || f.path.startsWith(prefix)) n++;
		}
		return n;
	}

	async checkIncompleteSources(): Promise<void> {
		const incomplete = await this.findIncompleteSources();
		if (!incomplete.length) return;
		new ReconcileSourcesModal(this.app, this, incomplete).open();
	}

	/** Reinstall a work by re-fetching (cached) and re-rendering it. */
	async reinstallSource(work: JsonObject): Promise<void> {
		await this.importSources([`${work.collection}:${work.id}`]);
	}

	/** Ask the source repositories whether any imported work has changed upstream. */
	async checkSourceUpdates(): Promise<string[]> {
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const keys = new Set<string>();
		for (const w of manifest) keys.add(`${w.collection}:${w.id}`);
		for (const k of await this.listModelKeys()) keys.add(k);
		for (const k of pending) keys.delete(k); // being removed: leave them alone
		if (!keys.size) {
			new Notice("No imported sources to check.");
			return [];
		}
		const args = ["check-updates"];
		for (const k of keys) args.push("--key", k);
		const result = await this.runWithProgress("Checking for updates", args, this.settings.sourceImportScript);
		const changed: string[] = result?.changed ?? [];
		const dateOnly: string[] = result?.date_only ?? [];
		if (!changed.length && !dateOnly.length) {
			new Notice("All imported sources are up to date.");
			return [];
		}
		// Repository moved but the text did not: refresh the property from the model.
		if (dateOnly.length) await this.renderWithProgress(dateOnly, false, "Refreshing source details");
		if (changed.length) {
			new Notice(`Text changed in ${changed.length} work(s); updating…`);
			await this.importSources(changed, true);
		}
		return changed;
	}

	/**
	 * Ask before rendering when a selected source names entries by transliterating
	 * them, but the transliteration service is not running. Returns true to proceed
	 * without transliteration, false to proceed with it, or null to cancel.
	 */
	async confirmTransliteration(keys: string[]): Promise<boolean | null> {
		let needs: JsonObject | undefined;
		try {
			const works = await this.listSourcesCached();
			const byKey = new Map(works.map((w) => [String(w.key), w]));
			needs = keys.map((k) => byKey.get(k)).find((w) => w && w.needs_transliteration);
		} catch {
			needs = undefined;
		}
		if (!needs) return false; // nothing in this batch needs transliteration
		const name = String(needs.title || needs.name || needs.key);
		for (;;) {
			if (await this.health()) return false; // the service is running
			const choice = await new Promise<"retry" | "skip" | "cancel">((resolve) => {
				new TransliterationUnavailableModal(this.app, name, resolve).open();
			});
			if (choice === "skip") return true;
			if (choice === "cancel") return null;
			// "Try again" → re-check whether the service has come up.
		}
	}

	/** Run the update check at most once every `sourceUpdateCheckDays` days. */
	async maybeScheduledUpdateCheck(): Promise<void> {
		const days = this.settings.sourceUpdateCheckDays ?? 7;
		if (!days || days <= 0) return;
		const path = normalizePath(".midad-arabic-sources/last-update-check.json");
		let last = 0;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as { at?: number };
			last = parsed.at ?? 0;
		} catch { last = 0; }
		if (Date.now() - last < days * 86_400_000) return;
		try {
			await this.app.vault.adapter.write(path, JSON.stringify({ at: Date.now() }));
		} catch { /* ignore */ }
		await this.checkSourceUpdates();
	}

	bundledTemplateDir(): string {
		// Relative to the vault config dir, like ScholarWeft (plugin.manifest.dir).
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/midad-arabic-sources`;
		return `${dir}/${TEMPLATE_FOLDER}`;
	}

	/** A work is "installed" when its hub/work note exists in the vault. */
	async isSourceInstalled(dir: string): Promise<boolean> {
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		try {
			return await this.app.vault.adapter.exists(normalizePath(`${outRoot}/${dir}.md`));
		} catch {
			return false;
		}
	}

	/** Acquire the chosen works, then render their models into the vault. */
	async importSources(keys: string[], refresh = false): Promise<void> {
		if (!keys.length) {
			new Notice("Select at least one source.");
			return;
		}
		// (Re)installing clears any half-finished removal flag for these keys.
		await this.unmarkPendingDeletion(...keys);
		// The first riwāya ever installed becomes the canonical one, permanently.
		// Later installs never take over; the user can change it in settings.
		if (!this.settings.canonicalQuranRiwāya.trim()) {
			const firstQuranText = keys.find((k) => k.startsWith("quran-text:"));
			if (firstQuranText) {
				this.settings.canonicalQuranRiwāya = firstQuranText.slice("quran-text:".length);
				await this.saveSettings();
			}
		}
		const args = ["fetch"];
		if (refresh) args.push("--no-cache");
		args.push("--canonical", this.resolveCanonicalQuran());
		// Some collections name entries the source does not transliterate by
		// romanizing the bare root, which needs the transliteration service. Ask
		// before rendering rather than silently producing radical-only names.
		const noTransliteration = await this.confirmTransliteration(keys);
		if (noTransliteration === null) return; // the user closed the prompt
		if (noTransliteration) args.push("--no-transliteration");
		else args.push("--transliteration-server", this.baseUrl());
		for (const k of keys) args.push("--key", k);
		// Say what actually happens: a work already in the cache is only re-prepared.
		const allCached = !refresh && (await Promise.all(keys.map((k) => this.sourceIsCached(k)))).every(Boolean);
		const result = await this.runWithProgress(
			allCached ? "Preparing sources (from cache)" : "Downloading sources",
			args,
			this.settings.sourceImportScript
		);
		const models: string[] = result?.models ?? [];
		if (!models.length) {
			new Notice("No models were produced — see the pipeline status.");
			return;
		}
		const written = await this.renderWithProgress(models, false, "Rendering notes");
		new Notice(`Rendered ${written.length} notes.`);
	}

	/**
	 * Render a batch while a persistent notice reports progress: files written,
	 * which work of the batch, and how many works remain — otherwise a long
	 * re-render is silent and its end is impossible to detect. Every background
	 * render goes through here, so nothing large ever runs without a report.
	 */
	async renderWithProgress(modelPaths: string[], force: boolean, title: string): Promise<string[]> {
		const progress = new Notice(`${title}…`, 0);
		// Cumulative file count: `step` restarts at each work, so the previous
		// work's total is banked when the work changes.
		let filesDone = 0;
		let lastIndex = -1;
		let lastSteps = 0;
		try {
			return await this.renderModels(modelPaths, force, (p) => {
				if (p.index !== lastIndex) {
					filesDone += lastSteps;
					lastIndex = p.index;
					lastSteps = 0;
				}
				lastSteps = p.steps;
				const files = filesDone + p.step;
				const within = p.steps ? p.step / p.steps : 0;
				const pct = p.total ? Math.floor(((p.index + within) / p.total) * 100) : 0;
				const left = p.total - p.index - 1;
				const parts = [
					`${files} file${files === 1 ? "" : "s"} — ${p.index + 1}/${p.total} works (${pct}%)`,
					p.work,
				];
				if (left > 0) parts.push(`${left} work${left === 1 ? "" : "s"} left`);
				progress.setMessage(`${title}: ${parts.join(" — ")}`);
			});
		} finally {
			progress.hide();
		}
	}

	async renderModels(modelPaths: string[], force = false, onProgress?: (p: RenderProgress) => void): Promise<string[]> {
		const vault = this.vaultPath();
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch (e) {
			new Notice(`Import templates could not be loaded: ${e instanceof Error ? e.message : e}`);
			return [];
		}
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		// Parse the batch models, resolve the canonical riwāya, and tag them.
		const pending = await this.loadPendingDeletions();
		const batch: SourceModel[] = [];
		for (const abs of modelPaths) {
			const rel = vaultRelative(vault, abs);
			let text: string | null = null;
			try {
				text = await this.app.vault.adapter.read(rel);
			} catch {
				text = null;
			}
			if (!text) continue;
			try {
				const model = JSON.parse(text) as SourceModel;
				// Never re-render a work that is mid-removal.
				if (pending.has(this.workKey(model.work))) continue;
				batch.push(model);
			} catch { /* skip */ }
		}
		// The canonical riwāya is designated once, at first install (see
		// importSources), and thereafter simply read back from the setting.
		const canonicalId = this.resolveCanonicalQuran();
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		for (const m of batch) {
			const isQuranText = m.work.collection === "quran-text";
			const isCanonical = isQuranText && String(m.work.id) === canonicalId;
			if (isQuranText) {
				m.work.canonical = isCanonical;
				m.work.canonical_root = canonicalRoot;
			}
			// Hub sūra links: a work's own notes are named `<dir> - <base>`; only
			// the canonical riwāya has unprefixed sūra notes (in canonical_root).
			// Every other genre needs its folder here too, or the hub would link
			// to the canonical Qur'ān notes instead of its own.
			m.work.unit_prefix = isCanonical ? "" : (m.work.dir as string);
		}
		const written: string[] = [];
		const pubs = await this.loadPublicationMap();
		const stats = await this.loadSourceStats();
		for (let i = 0; i < batch.length; i++) {
			const model = batch[i];
			// Hand the templates the researched bibliographic details, if any — plus
			// the combined `mas-note` text, so the note holds everything the Zotero
			// `extra` does.
			const pub = pubs[this.workKey(model.work)] ?? {};
			model.work.publication = { ...pub, mas_note: this.masNote(pub) };
			const work = String(model.work.title || model.work.dir || model.work.id);
			const emit = (step: number, steps: number) =>
				onProgress?.({ index: i, total: batch.length, work, step, steps });
			emit(0, 0);
			try {
				const w = await renderModelToVault(this.app, templates, model, outRoot, force, emit);
				written.push(...w);
				// A full render brings every template the work uses up to date.
				const key = this.workKey(model.work);
				const now = Date.now();
				const rendered: Record<string, number> = { ...(stats[key]?.rendered ?? {}) };
				for (const tkey of this.templateKeysFor(String(model.work.collection ?? ""))) rendered[tkey] = now;
				stats[key] = { ...stats[key], rendered, notes: w.length, schema: Number(model.schema ?? 0) };
			} catch (e) {
				// One unusable model must not abort the whole batch: a template/model
				// mismatch used to kill a re-render, leaving only a flashed notice.
				console.error("[midad-arabic-sources] render failed", this.workKey(model.work), e);
				new Notice(`Could not render ${work}: ${e instanceof Error ? e.message : e}`);
			}
			await this.pruneRenamedFolder(model.work);
		}
		await this.saveSourceStats(stats);
		// Category MOCs and the parent note reflect exactly what is installed;
		// a manifest keeps a work listed even if its cached model is removed.
		written.push(...(await this.refreshSourcesIndex()));
		// If the user wants Zotero kept in step, do it now — silently, and only
		// for items whose Zotero fields actually changed (see autoSyncZotero).
		await this.autoSyncZotero();
		return written;
	}

	/**
	 * Maintain the top-level parent note that every category MOC points up to.
	 * Reuses the user's existing note (found by name anywhere in the vault) or
	 * creates one; only its managed region and merge-keep properties are written,
	 * so hand-written content is never lost.
	 */
	async updateSourceParent(templates: TemplateSet, mocs: string[], generated: string): Promise<string | null> {
		const name = (this.settings.sourceMocParent || "").trim() || "Sources";
		if (!mocs.length) return null;
		let file = this.app.metadataCache.getFirstLinkpathDest(name, "");
		if (!file) {
			// Give a plugin-created parent a home beside the other source notes.
			const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
			const path = normalizePath(`${outRoot}/${name}.md`);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) file = existing;
			else {
				try {
					file = await this.app.vault.create(path, "");
				} catch {
					return null;
				}
			}
		}
		const out = renderSourcesNote(templates, mocs, generated);
		// append (not replace) so a user-written note keeps its own content.
		await writeMerged(this.app, file.path, out, false, false);
		return file.path;
	}

	async loadSourceManifest(): Promise<Array<JsonObject>> {
		try {
			const text = await this.app.vault.adapter.read(normalizePath(".midad-arabic-sources/source-imports.json"));
			const parsed = JSON.parse(text) as { works?: Array<JsonObject> };
			return Array.isArray(parsed.works) ? parsed.works : [];
		} catch {
			return [];
		}
	}

	async saveSourceManifest(works: Array<JsonObject>): Promise<void> {
		try {
			await this.app.vault.adapter.write(
				normalizePath(".midad-arabic-sources/source-imports.json"),
				JSON.stringify({ works }, null, 1)
			);
		} catch { /* ignore */ }
	}

	// ── Work status ──────────────────────────────────────────────────────────
	// The manifest is the authoritative list of works and their status:
	//   "installed"      — keep it; restore any missing files (notes, model, …).
	//   "deleting"       — do not restore it; finish removing it.
	// A status of *deleting* is written before a removal starts, so maintenance
	// that fires mid-removal (it is timer-driven) neither resurrects the work nor
	// leaves a half-deleted one; the removal resumes on the next run instead.

	/** A work's status, defaulting to installed for older manifest entries. */
	workStatus(work: JsonObject): "installed" | "deleting" {
		return work.status === "deleting" ? "deleting" : "installed";
	}

	/** The stable identity of a work (its key, falling back to its folder). */
	workKey(work: JsonObject): string {
		return String(work.key ?? `${work.collection}:${work.id}`);
	}

	async setWorkStatus(keys: string | string[], status: "installed" | "deleting" | null): Promise<void> {
		const list = Array.isArray(keys) ? keys : [keys];
		const manifest = await this.loadSourceManifest();
		let changed = false;
		const next: Array<JsonObject> = [];
		for (const w of manifest) {
			if (!list.includes(this.workKey(w))) {
				next.push(w);
				continue;
			}
			changed = true;
			if (status !== null) next.push({ ...w, status });
		}
		if (changed) await this.saveSourceManifest(next);
	}

	/** Keys of every work currently being removed. */
	async loadPendingDeletions(): Promise<Set<string>> {
		const manifest = await this.loadSourceManifest();
		return new Set(manifest.filter((w) => this.workStatus(w) === "deleting").map((w) => this.workKey(w)));
	}

	/** The manifest entries for works whose removal has not finished. */
	async findPendingDeletions(): Promise<Array<JsonObject>> {
		const manifest = await this.loadSourceManifest();
		return manifest.filter((w) => this.workStatus(w) === "deleting");
	}

	async markPendingDeletion(key: string): Promise<void> {
		await this.setWorkStatus(key, "deleting");
	}

	async unmarkPendingDeletion(...keys: string[]): Promise<void> {
		await this.setWorkStatus(keys, "installed");
	}

	/** The canonical Qur'ān-text work: designated once at first install, then persisted. */
	resolveCanonicalQuran(): string {
		return this.settings.canonicalQuranRiwāya.trim() || "hafs";
	}

	async loadAllSourceModels(): Promise<SourceModel[]> {
		const root = `${this.vaultPath()}/.midad-arabic-sources/source-models`;
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const p = `${dir}/${name}`;
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (name.endsWith(".json")) files.push(p);
			}
		};
		try {
			walk(root);
		} catch { /* none yet */ }
		const models: SourceModel[] = [];
		for (const f of files) {
			try {
				models.push(JSON.parse(fs.readFileSync(f, "utf8")) as SourceModel);
			} catch { /* skip */ }
		}
		return models;
	}

	/**
	 * The `collection:id` keys of the cached models on disk, read from filenames
	 * only — never parsed. Used to notice a model whose manifest entry is missing
	 * without paying to read the whole (often 100+ MB) corpus.
	 */
	async listModelKeys(): Promise<string[]> {
		const root = `${this.vaultPath()}/.midad-arabic-sources/source-models`;
		const keys: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const p = `${dir}/${name}`;
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (name.endsWith(".json")) {
					const rel = p.slice(root.length + 1).replace(/\.json$/, "");
					const slash = rel.indexOf("/");
					if (slash > 0) keys.push(`${rel.slice(0, slash)}:${rel.slice(slash + 1)}`);
				}
			}
		};
		try {
			walk(root);
		} catch { /* none yet */ }
		return keys;
	}

	/** Copy the bundled ETA templates into the user's template folder. */
	async copyImportTemplates(): Promise<void> {
		const folder = this.settings.sourceTemplateFolder.trim();
		if (!folder) {
			new Notice("Set a template folder in the Midad Arabic Sources settings first.");
			return;
		}
		const src = this.bundledTemplateDir();
		const dest = normalizePath(`${folder}/${TEMPLATE_FOLDER}`);
		try {
			if (!(await this.app.vault.adapter.exists(dest))) await this.app.vault.createFolder(dest);
			for (const file of Object.values(TEMPLATE_FILES)) {
				const text = await this.app.vault.adapter.read(normalizePath(`${src}/${file}`));
				await this.app.vault.adapter.write(normalizePath(`${dest}/${file}`), text);
			}
			new Notice(`Copied import templates to ${dest}.`);
		} catch (e) {
			new Notice(`Could not copy templates: ${e}`);
		}
	}

	/**
	 * Re-fetch every installed work (cache-backed, so nothing is re-downloaded)
	 * and re-render it. This is the way to pick up a change to how a work is
	 * acquired — a re-render alone only replays the cached model.
	 */
	async redownloadSources(): Promise<void> {
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const keys = manifest
			.filter((w) => this.workStatus(w) === "installed" && !pending.has(this.workKey(w)))
			.map((w) => this.workKey(w));
		if (!keys.length) {
			new Notice("No installed sources to re-download.");
			return;
		}
		new Notice(`Re-downloading ${keys.length} source(s)…`);
		await this.importSources(keys);
	}

	/** Re-render every cached model (run after editing a template). */
	async rerenderAllSources(): Promise<string[]> {
		const root = `${this.vaultPath()}/.midad-arabic-sources/source-models`;
		const models: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const p = `${dir}/${name}`;
				if (fs.statSync(p).isDirectory()) walk(p);
				else if (name.endsWith(".json")) models.push(p);
			}
		};
		try {
			walk(root);
		} catch { /* none yet */ }
		if (!models.length) {
			new Notice("No cached source models found.");
			return [];
		}
		const written = await this.renderWithProgress(models, true, "Re-rendering imported sources");
		new Notice(`Re-rendered ${written.length} notes.`);
		return written;
	}

	// ── Template auto-update ─────────────────────────────────────────────────

	sourceHistoryPath(): string {
		return ".midad-arabic-sources/template-history.json";
	}

	/** The unit template(s) a collection's notes use, plus the shared hub. */
	templateKeysFor(collection: string): string[] {
		const unit: Record<string, string[]> = {
			tafsir: ["source"],
			"tafsir-qul": ["source"],
			quran: ["source"],
			hadith: ["hadith"],
			"quran-text": ["quran"],
			dictionary: ["dictionary", "dictionaryIndex"],
		};
		return ["hub", ...(unit[collection] ?? ["source"])];
	}

	/** A hash per template file, so a change can be attributed to its users. */
	async sourceTemplateHashes(): Promise<Record<string, string>> {
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		const t = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		return {
			source: hashString(t.source),
			hadith: hashString(t.hadith),
			quran: hashString(t.quran),
			dictionary: hashString(t.dictionary),
			dictionaryIndex: hashString(t.dictionaryIndex),
			hub: hashString(t.hub),
			moc: hashString(t.moc),
			sources: hashString(t.sources),
		};
	}

	async loadSourceHashes(): Promise<TemplateHashes> {
		try {
			const text = await this.app.vault.adapter.read(normalizePath(this.sourceHistoryPath()));
			const parsed = JSON.parse(text) as TemplateHashes;
			const templates = parsed?.templates;
			return { templates: templates && typeof templates === "object" ? templates : {} };
		} catch {
			return { templates: {} };
		}
	}

	async saveSourceHashes(store: TemplateHashes): Promise<void> {
		try {
			await this.app.vault.adapter.write(
				normalizePath(this.sourceHistoryPath()),
				JSON.stringify(store, null, 1)
			);
		} catch { /* ignore */ }
	}

	/** Record the current per-template hashes; returns the keys that changed. */
	async recordSourceTemplate(): Promise<string[]> {
		const hashes = await this.sourceTemplateHashes();
		const store = await this.loadSourceHashes();
		const { store: next, changed } = recordTemplateHashes(store, hashes, Date.now());
		await this.saveSourceHashes(next);
		return changed;
	}

	async recordSourceTemplateAndCheck(): Promise<void> {
		// The recording happens inside maintainSources (the single place that
		// records), so this pass's delta is still available to decide what to
		// re-render — including the MOCs, which carry no `updated` to self-heal by.
		this.scheduleSourceTemplateCheck();
	}

	isSourceTemplateFile(path: string): boolean {
		const folder = this.settings.sourceTemplateFolder.trim();
		if (!folder) return false;
		return path.startsWith(normalizePath(`${folder}/${TEMPLATE_FOLDER}/`));
	}

	sourceTemplateCheckTimer: number | null = null;
	scheduleSourceTemplateCheck(): void {
		if (this.sourceTemplateCheckTimer != null) window.clearTimeout(this.sourceTemplateCheckTimer);
		this.sourceTemplateCheckTimer = window.setTimeout(() => {
			void this.maintainSources();
		}, 3000);
	}

	/**
	 * The installed works whose notes predate a change to one of the templates
	 * that renders them, each with the *unit kinds* affected. Attribution is per
	 * template, so editing the dictionary letter-index template re-renders only
	 * the letter pages — not the 50,000 root notes — and editing the dictionary
	 * template re-renders only the roots. A scoped render always rewrites the hub
	 * too, because its `updated` is the work's staleness watermark.
	 */
	async findStaleSourceWorks(): Promise<Array<{ work: JsonObject; kinds: Set<string> }>> {
		const store = await this.loadSourceHashes();
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const stats = await this.loadSourceStats();
		const out: Array<{ work: JsonObject; kinds: Set<string> }> = [];
		for (const work of manifest) {
			if (this.workStatus(work) !== "installed") continue;
			if (pending.has(this.workKey(work))) continue;
			const stat = stats[this.workKey(work)];
			// A work rendered by an older build has no per-template watermark; seed
			// from its hub note so it is not re-rendered once just for the upgrade.
			// Once ANY per-template watermark exists, a missing key means "not
			// rendered with that template" — never the legacy hub time, which a
			// scoped render would have bumped.
			const rendered = stat?.rendered;
			const hasRendered = !!rendered && Object.keys(rendered).length > 0;
			const legacyMs = hasRendered ? 0 : this.hubUpdatedMs(work);
			const renderedMs = (key: string) => (hasRendered ? (rendered?.[key] ?? 0) : legacyMs);
			const stale = (key: string) => {
				const at = templateChangedAt(store, key);
				if (at <= 0) return false;
				const ms = renderedMs(key);
				return !ms || ms < at;
			};
			const kinds = new Set<string>();
			for (const key of this.templateKeysFor(String(work.collection ?? ""))) {
				if (key === "hub") continue;
				if (!stale(key)) continue;
				const kind = SOURCE_TEMPLATE_KIND[key];
				if (kind) kinds.add(kind);
			}
			if (!kinds.size && !stale("hub")) continue; // nothing stale
			out.push({ work, kinds });
		}
		return out;
	}

	/**
	 * Re-render the stale works, each scoped to the unit kinds whose template
	 * changed (`kinds: null` means a full render). Reads only the affected works'
	 * models — never the whole corpus.
	 */
	async renderStaleScoped(items: Array<{ work: JsonObject; kinds: Set<string> | null }>): Promise<void> {
		if (!items.length) return;
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch (e) {
			new Notice(`Import templates could not be loaded: ${e instanceof Error ? e.message : e}`);
			return;
		}
		const outRoot = this.settings.sourceImportRoot.trim() || "_7 Sources";
		const canonicalId = this.resolveCanonicalQuran();
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		const stats = await this.loadSourceStats();
		const notice = new Notice("Updating imported sources…", 0);
		let done = 0;
		try {
			for (const it of items) {
				const label = String(it.work.title ?? it.work.dir ?? it.work.id);
				const nth = `${++done}/${items.length}`;
				notice.setMessage(`Updating imported sources: ${nth} — ${label}`);
				const key = this.workKey(it.work);
				const legacy = this.hubUpdatedMs(it.work); // read before the render bumps it
				const rel = normalizePath(`.midad-arabic-sources/source-models/${it.work.collection}/${it.work.id}.json`);
				try {
					if (!(await this.app.vault.adapter.exists(rel))) continue;
					const model = JSON.parse(await this.app.vault.adapter.read(rel)) as SourceModel;
					model.work.canonical_root = canonicalRoot;
					model.work.canonical = model.work.collection === "quran-text" && String(model.work.id) === canonicalId;
					// Per-note progress: a large work (a dictionary) can take minutes, so
					// the work name alone would look frozen. Throttled so a 6,000-note
					// work does not rewrite the notice DOM 6,000 times.
					let lastTick = 0;
					const onStep = (step: number, steps: number) => {
						if (step !== steps && step - lastTick < 25) return;
						lastTick = step;
						const pct = steps ? Math.floor((step / steps) * 100) : 0;
						notice.setMessage(`Updating imported sources: ${nth} — ${label} — ${step}/${steps} notes (${pct}%)`);
					};
					await renderModelToVault(this.app, templates, model, outRoot, false, onStep, it.kinds ?? undefined);
					// Record which templates this render brought up to date. A scoped
					// render marks only the rendered kinds (plus the hub); a full render
					// (kinds === null) marks every template the work uses. On the first
					// touch, seed every key from the hub's old watermark, so a scoped
					// render does not implicitly mark templates we did NOT re-render.
					const now = Date.now();
					const rendered: Record<string, number> = { ...(stats[key]?.rendered ?? {}) };
					if (!stats[key]?.rendered) {
						for (const tkey of this.templateKeysFor(String(it.work.collection ?? ""))) rendered[tkey] = legacy;
					}
					rendered["hub"] = now;
					for (const tkey of this.templateKeysFor(String(it.work.collection ?? ""))) {
						if (tkey === "hub") continue;
						const kind = SOURCE_TEMPLATE_KIND[tkey];
						if (it.kinds === null || (kind && it.kinds.has(kind))) rendered[tkey] = now;
					}
					stats[key] = { ...stats[key], rendered, notes: expectedNotePaths(model, outRoot, canonicalRoot, canonicalId).length, schema: Number(model.schema ?? 0) };
				} catch (e) {
					console.error("[midad-arabic-sources] scoped render", it.work.key, e);
				}
			}
		} finally {
			notice.hide();
			await this.saveSourceStats(stats);
		}
	}

	/** Restore anything incomplete and re-render notes that predate the template. */
	/**
	 * Record the current template hashes and re-render only the sources a change
	 * affects. Cheap (unaffected works are not read), so it is safe to call from
	 * the poll and the command as well as from maintainSources.
	 */
	async applyTemplateChanges(): Promise<number> {
		const changedKeys = await this.recordSourceTemplate();
		const stale = await this.findStaleSourceWorks();
		const indexDirty = changedKeys.some((k) => k === "moc" || k === "sources");
		if (!stale.length && !indexDirty) return 0;
		await this.renderStaleScoped(stale.map((s) => ({ work: s.work, kinds: s.kinds })));
		if (indexDirty) await this.refreshSourcesIndex();
		return stale.length;
	}

	templateCheckRunning = false;

	/**
	 * Poll the templates for edits and apply them. The bundled copies live in
	 * `.obsidian`, which Obsidian's vault watcher ignores (and `sourceTemplateFolder`
	 * may be unset), so without this an edit to a bundled template is only noticed
	 * on the next reload. This is what makes editing a template take effect live.
	 */
	async pollTemplateChanges(): Promise<void> {
		if (this.templateCheckRunning) return;
		if (this.settings.autoUpdateSourceTemplates !== true) return;
		this.templateCheckRunning = true;
		try {
			const hashes = await this.sourceTemplateHashes();
			const store = await this.loadSourceHashes();
			const changed = Object.entries(hashes).some(([k, h]) => h && store.templates[k]?.hash !== h);
			if (changed) await this.applyTemplateChanges();
		} catch { /* templates unavailable */ } finally {
			this.templateCheckRunning = false;
		}
	}

	async maintainSources(): Promise<void> {
		// Finish any interrupted removal first, and never restore such a work —
		// the user already asked for it gone, so it does not prompt.
		for (const w of await this.findPendingDeletions()) {
			try {
				await this.removeSource(w);
			} catch (e) {
				console.error("[midad-arabic-sources] resume removal", w.key, e);
			}
		}
		const incomplete = await this.findIncompleteSources();
		// Per-template attribution: a change to one template only re-renders the
		// works that use it. `changedKeys` is this pass's delta (used to decide
		// whether the MOCs/parent need rebuilding); `staleWorks` is self-healing.
		const changedKeys = await this.recordSourceTemplate();
		const stale = await this.findStaleSourceWorks();
		const indexDirty = changedKeys.some((k) => k === "moc" || k === "sources");
		if (!incomplete.length && !stale.length && !indexDirty) return;
		const apply = async () => {
			// A work whose cached model is present only needs re-rendering; re-fetch
			// only the ones whose model is gone. (A fetch is cache-backed — it does
			// not re-download — but it still re-runs acquisition, so skip it when a
			// plain re-render will do.)
			const rerender: Array<{ work: JsonObject; kinds: Set<string> | null }> = [];
			for (const it of incomplete) {
				const rel = normalizePath(`.midad-arabic-sources/source-models/${it.work.collection}/${it.work.id}.json`);
				if (it.reason === "notes" && (await this.app.vault.adapter.exists(rel))) {
					rerender.push({ work: it.work, kinds: null }); // full: recreate the missing notes
					continue;
				}
				try {
					await this.reinstallSource(it.work);
				} catch (e) {
					console.error("[midad-arabic-sources] restore", it.work.key, e);
				}
			}
			// Stale works: only the unit kinds whose template changed, plus the hub.
			for (const s of stale) rerender.push({ work: s.work, kinds: s.kinds });
			await this.renderStaleScoped(rerender);
			if (indexDirty) await this.refreshSourcesIndex();
		};
		if (this.settings.autoUpdateSourceTemplates === true) {
			await apply();
		} else if (this.settings.autoUpdateSourceTemplates === false) {
			return;
		} else {
			new SourceTemplateUpdateConsentModal(this.app, incomplete.length + stale.length + (indexDirty ? 1 : 0), (choice) => {
				void (async () => {
					if (choice === "yes") {
						this.settings.autoUpdateSourceTemplates = true;
						await this.saveSettings();
						await apply();
					} else if (choice === "no") {
						this.settings.autoUpdateSourceTemplates = false;
						await this.saveSettings();
					}
				})();
			}).open();
		}
	}

	async runTransliteration(text: string, opts: RunOptions): Promise<string | null> {
		const loading = new Notice("Transliterating…", 0);
		try {
			const body: Record<string, unknown> = { text };
			let path = "/transliterate";
			if (opts.useLlm) {
				path = "/romanize";
				body.provider = this.settings.llmProvider;
				body.model = this.settings.llmModel;
				body.keep_case = opts.fullVocalization;
				body.name = this.settings.nameMode;
				if (this.settings.llmApiKey) body.api_key = this.settings.llmApiKey;
			} else {
				body.engine = this.settings.engine;
				body.sun_letters = this.settings.sunLetters;
				body.keep_case = opts.fullVocalization;
				body.dotless_ya = this.settings.dotlessYa;
				body.name = this.settings.nameMode;
			}
			const res = await requestUrl({
				url: this.baseUrl() + path,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(body),
			});
			const data = (res.json ?? {}) as TransliterateResponse;
			this.lastUnknown = Array.isArray(data.unknown) ? data.unknown : [];
			if (data.error) {
				new Notice(`Transliteration error: ${data.error}`);
				return null;
			}
			return data.romanized ?? "";
		} catch {
			new Notice(
				`Transliteration server not reachable at ${this.settings.serverUrl}. ` +
					"Start it with: python3 scripts/transliterate-server.py"
			);
			return null;
		} finally {
			loading.hide();
		}
	}

	maybePromptUnknown(source: string, apply: (romanized: string) => Promise<void> | void, opts: RunOptions) {
		const unknown = this.lastUnknown;
		this.lastUnknown = [];
		if (!unknown.length) return;
		new LexiconModal(this.app, this, unknown, async () => {
			const updated = await this.runTransliteration(source, opts);
			if (updated !== null) await apply(updated);
		}).open();
	}

	async saveLexicon(entries: Record<string, string>) {
		try {
			await requestUrl({
				url: this.baseUrl() + "/lexicon",
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ entries }),
			});
			new Notice(`Lexicon updated (${Object.keys(entries).length} term(s)).`);
		} catch {
			new Notice("Could not update the lexicon.");
		}
	}

	async health(): Promise<{ engines_loaded?: string[]; providers?: Record<string, boolean> } | null> {
		try {
			const res = await requestUrl({ url: this.baseUrl() + "/health", method: "GET" });
			return res.json as { engines_loaded?: string[]; providers?: Record<string, boolean> } | null;
		} catch {
			return null;
		}
	}

	translitServerPid: number | null = null;

	/** Launch the resident transliteration service (if it is not already up). */
	async startTransliterationServer(): Promise<void> {
		if (await this.health()) {
			new Notice(`Transliteration server already running at ${this.settings.serverUrl}.`);
			return;
		}
		const vault = this.vaultPath();
		const script = this.resolveScript(this.settings.transliterationServerScript || "scripts/transliterate-server.py");
		const python = (this.settings.pythonPath ?? "").trim() || "python3";
		let port = "8756";
		try { port = new URL(this.settings.serverUrl).port || "8756"; } catch { /* ignore */ }
		const logPath = `${vault}/tmp/transliterate-server.log`;
		try { fs.mkdirSync(`${vault}/tmp`, { recursive: true }); } catch { /* ignore */ }
		let logFd: number | undefined;
		try { logFd = fs.openSync(logPath, "a"); } catch { logFd = undefined; }
		try {
			const proc = spawn(python, [script, "--port", port], {
				cwd: vault,
				detached: true,
				stdio: logFd != null ? ["ignore", logFd, logFd] : "ignore",
			});
			proc.unref();
			this.translitServerPid = proc.pid ?? null;
		} catch (e) {
			new Notice(`Could not start the transliteration server: ${e}`);
			return;
		}
		const loading = new Notice("Starting transliteration server…", 0);
		try {
			for (let i = 0; i < 40; i++) {
				await new Promise((resolve) => window.setTimeout(resolve, 1000));
				if (await this.health()) {
					new Notice("Transliteration server started.");
					return;
				}
			}
			new Notice(`Server did not become ready. See ${logPath}.`);
		} finally {
			loading.hide();
		}
	}

	/** Stop the transliteration service we started, or one matching the script name. */
	async stopTransliterationServer(): Promise<void> {
		if (this.translitServerPid != null) {
			try {
				process.kill(-this.translitServerPid);
			} catch {
				try { process.kill(this.translitServerPid); } catch { /* ignore */ }
			}
			this.translitServerPid = null;
			new Notice("Transliteration server stopped.");
			return;
		}
		const name = (this.settings.transliterationServerScript || "transliterate-server.py").split("/").pop();
		execFile("pkill", ["-f", String(name)], (err: unknown) => {
			new Notice(err ? "No running transliteration server found." : "Transliteration server stopped.");
		});
	}

	baseUrl(): string {
		return this.settings.serverUrl.replace(/\/+$/, "");
	}

	uniquePath(folder: string, base: string): string {
		const dir = folder && folder !== "/" ? `${folder}/` : "";
		let path = `${dir}${base}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${dir}${base} ${n}.md`;
			n += 1;
		}
		return path;
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ArabicSupportSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		// Pre-designation installs: Ḥafṣ was the first riwāya, so adopt it once and
		// persist it, after which the designation is purely the setting.
		if (!this.settings.canonicalQuranRiwāya.trim()) {
			try {
				if (await this.app.vault.adapter.exists(normalizePath(".midad-arabic-sources/source-models/quran-text/hafs.json"))) {
					this.settings.canonicalQuranRiwāya = "hafs";
					await this.saveSettings();
				}
			} catch { /* ignore */ }
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TransliterateModal extends Modal {
	plugin: ArabicSupportPlugin;
	text: string;
	onDone: (romanized: string) => Promise<void> | void;
	useLlm: boolean;
	fullVocalization: boolean;

	constructor(
		app: App,
		plugin: ArabicSupportPlugin,
		text: string,
		onDone: (romanized: string) => Promise<void> | void
	) {
		super(app);
		this.plugin = plugin;
		this.text = text;
		this.onDone = onDone;
		this.useLlm = plugin.settings.useLlm;
		this.fullVocalization = plugin.settings.fullVocalization;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Transliterate" });

		new Setting(contentEl)
			.setName("Full vocalization")
			.setDesc("Retain case endings and tanwīn (pausal shortening at the end of a passage).")
			.addToggle((toggle) =>
				toggle.setValue(this.fullVocalization).onChange((value) => {
					this.fullVocalization = value;
				})
			);

		new Setting(contentEl)
			.setName("Use LLM")
			.setDesc("Romanize with the configured API instead of the rule engine.")
			.addToggle((toggle) =>
				toggle.setValue(this.useLlm).onChange((value) => {
					this.useLlm = value;
				})
			);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Transliterate")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.useLlm = this.useLlm;
					this.plugin.settings.fullVocalization = this.fullVocalization;
					await this.plugin.saveSettings();
					const opts: RunOptions = { useLlm: this.useLlm, fullVocalization: this.fullVocalization };
					this.close();
					const result = await this.plugin.runTransliteration(this.text, opts);
					if (result === null) return;
					await this.onDone(result);
					if (!opts.useLlm) this.plugin.maybePromptUnknown(this.text, this.onDone, opts);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class LexiconModal extends Modal {
	plugin: ArabicSupportPlugin;
	unknown: LexiconGuess[];
	inputs: Array<{ term: string; comp: TextComponent }> = [];
	onSaved: (() => Promise<void> | void) | null;

	constructor(
		app: App,
		plugin: ArabicSupportPlugin,
		unknown: LexiconGuess[],
		onSaved: (() => Promise<void> | void) | null = null
	) {
		super(app);
		this.plugin = plugin;
		this.unknown = unknown;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Add to transliteration lexicon" });
		contentEl.createEl("p", {
			text: "These terms had no morphological analysis. Edit or confirm their romanization to remember them for next time.",
		});
		for (const item of this.unknown) {
			new Setting(contentEl).setName(item.term).addText((text) => {
				text.setValue(item.guess || "");
				this.inputs.push({ term: item.term, comp: text });
			});
		}
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					const entries: Record<string, string> = {};
					for (const { term, comp } of this.inputs) {
						const value = comp.getValue().trim();
						if (value) entries[term] = value;
					}
					if (Object.keys(entries).length) {
						await this.plugin.saveLexicon(entries);
						this.close();
						if (this.onSaved) await this.onSaved();
						return;
					}
					this.close();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ArabicSupportSettingTab extends PluginSettingTab {
	plugin: ArabicSupportPlugin;

	constructor(app: App, plugin: ArabicSupportPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Address of the resident transliteration service.")
			.addText((text) =>
				text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
					this.plugin.settings.serverUrl = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Server script")
			.setDesc("Path (relative to the vault) of transliterate-server.py, used by the start/stop commands.")
			.addText((text) =>
				text.setValue(this.plugin.settings.transliterationServerScript).onChange(async (value) => {
					this.plugin.settings.transliterationServerScript = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Engine")
			.setDesc("BERT: best for unvocalized prose. MLE: faster, rougher. None: no CAMeL; fully vocalized text only.")
			.addDropdown((drop) =>
				drop
					.addOptions({ bert: "bert", mle: "mle", none: "none" })
					.setValue(this.plugin.settings.engine)
					.onChange(async (value) => {
						this.plugin.settings.engine = value as Engine;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sun-letter assimilation")
			.setDesc("Assimilate the article before sun letters (off means invariant al-).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.sunLetters).onChange(async (value) => {
					this.plugin.settings.sunLetters = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Keep case endings")
			.setDesc("Retain noun/adjective case endings and tanwīn (used automatically inside Qur’an spans).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.keepCase).onChange(async (value) => {
					this.plugin.settings.keepCase = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Name mode")
			.setDesc("Capitalize each substantive word (for author/editor name fields).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.nameMode).onChange(async (value) => {
					this.plugin.settings.nameMode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Final dotless yāʾ")
			.setDesc("How to read a final dotless yāʾ (ى).")
			.addDropdown((drop) =>
				drop
					.addOptions({ maqsura: "alif maqṣūra (ā)", ya: "let the analysis choose" })
					.setValue(this.plugin.settings.dotlessYa)
					.onChange(async (value) => {
						this.plugin.settings.dotlessYa = value as DotlessYa;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("LLM romanization").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Used when “Use LLM” is checked in the transliterate modal.")
			.addDropdown((drop) =>
				drop
					.addOptions({ gemini: "Gemini", deepseek: "DeepSeek" })
					.setValue(this.plugin.settings.llmProvider)
					.onChange(async (value) => {
						this.plugin.settings.llmProvider = value as LlmProvider;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model name for the selected provider.")
			.addText((text) =>
				text.setValue(this.plugin.settings.llmModel).onChange(async (value) => {
					this.plugin.settings.llmModel = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Optional. Used only if the server process has no GEMINI_API_KEY/GOOGLE_API_KEY.")
			.addText((text) => {
				text.setValue(this.plugin.settings.llmApiKey).onChange(async (value) => {
					this.plugin.settings.llmApiKey = value.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
			});

		new Setting(containerEl).setName("Transcription & translation pipeline").setHeading();

		new Setting(containerEl)
			.setName("Python executable")
			.setDesc("Python used to run the Gemini batch pipeline scripts. Leave blank to auto-detect.")
			.addText((text) =>
				text.setPlaceholder("Auto-detect").setValue(this.plugin.settings.pythonPath).onChange(async (value) => {
					this.plugin.settings.pythonPath = value.trim();
					this.plugin.pythonPromise = null;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Pipeline script")
			.setDesc("Path (relative to the vault) of the Midad Arabic Sources pipeline orchestrator.")
			.addText((text) =>
				text.setValue(this.plugin.settings.pipelineScript).onChange(async (value) => {
					this.plugin.settings.pipelineScript = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Gemini API key")
			.setDesc("Passed to the pipeline as GEMINI_API_KEY. Needed when Obsidian was launched without shell environment variables.")
			.addText((text) => {
				text.setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => {
					this.plugin.settings.geminiApiKey = value.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
			});

		new Setting(containerEl).setName("Text source importer").setHeading();

		new Setting(containerEl)
			.setName("Importer script")
			.setDesc("Path (relative to the vault) of the catalog-driven importer script.")
			.addText((text) =>
				text.setValue(this.plugin.settings.sourceImportScript).onChange(async (value) => {
					this.plugin.settings.sourceImportScript = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Import destination")
			.setDesc("Folder imported works are written under (one subfolder per work).")
			.addText((text) =>
				text.setValue(this.plugin.settings.sourceImportRoot).onChange(async (value) => {
					this.plugin.settings.sourceImportRoot = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Template folder")
			.setDesc("Vault folder holding your edited import templates (blank = bundled defaults). Use “Copy import templates to vault”.")
			.addText((text) =>
				text.setPlaceholder("Templates").setValue(this.plugin.settings.sourceTemplateFolder).onChange(async (value) => {
					this.plugin.settings.sourceTemplateFolder = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Canonical Qurʾān riwāya")
			.setDesc("Riwāya whose sūra notes are unprefixed (the main reference). Set once, to the first riwāya you install; edit here to switch. Qurʾān citation linking in source notes requires Ḥafṣ (hafs): almost all source texts quote the Ḥafṣ reading, so citations cannot be matched against another riwāya.")
			.addText((text) =>
				text.setPlaceholder("Ḥafṣ").setValue(this.plugin.settings.canonicalQuranRiwāya).onChange(async (value) => {
					this.plugin.settings.canonicalQuranRiwāya = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Canonical Qurʾān folder")
			.setDesc("Vault folder that holds the canonical riwāya's sūra notes.")
			.addText((text) =>
				text.setValue(this.plugin.settings.canonicalQuranFolder).onChange(async (value) => {
					this.plugin.settings.canonicalQuranFolder = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sources parent note")
			.setDesc("Top-level note every category MOC points up to. The plugin lists each category in its managed region, reusing your existing note if one exists.")
			.addText((text) =>
				text.setPlaceholder("Sources").setValue(this.plugin.settings.sourceMocParent).onChange(async (value) => {
					this.plugin.settings.sourceMocParent = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Update notes when templates change")
			.setDesc("Re-render imported source notes automatically when an import template changes.")
			.addDropdown((drop) =>
				drop
					.addOptions({ ask: "Ask", yes: "Always", no: "Never" })
					.setValue(
						this.plugin.settings.autoUpdateSourceTemplates === true
							? "yes"
							: this.plugin.settings.autoUpdateSourceTemplates === false
								? "no"
								: "ask"
					)
					.onChange(async (value) => {
						this.plugin.settings.autoUpdateSourceTemplates =
							value === "ask" ? undefined : value === "yes";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Check repositories every … days")
			.setDesc("How often to ask the repositories whether an imported text changed (0 = only on the command).")
			.addText((text) =>
				text.setPlaceholder("7").setValue(String(this.plugin.settings.sourceUpdateCheckDays ?? 7)).onChange(async (value) => {
					const n = parseInt(value.trim(), 10);
					this.plugin.settings.sourceUpdateCheckDays = Number.isFinite(n) ? n : 7;
					await this.plugin.saveSettings();
				})
			);

		// ── Zotero export ────────────────────────────────────────────────────
		new Setting(containerEl).setName("Zotero export").setHeading();

		let methodSetting: Setting;
		let keySetting: Setting;
		let libSetting: Setting;
		let detectSetting: Setting;
		let autoUpdateSetting: Setting;
		let autoCreateSetting: Setting;
		const refreshZotero = () => {
			const on = this.plugin.settings.zoteroExport;
			const web = this.plugin.settings.zoteroMethod === "web";
			methodSetting.settingEl.style.display = on ? "" : "none";
			keySetting.settingEl.style.display = on && web ? "" : "none";
			libSetting.settingEl.style.display = on && web ? "" : "none";
			detectSetting.settingEl.style.display = on && web ? "" : "none";
			autoUpdateSetting.settingEl.style.display = on ? "" : "none";
			autoCreateSetting.settingEl.style.display = on ? "" : "none";
		};

		new Setting(containerEl)
			.setName("Enable Zotero export")
			.setDesc("Adds a command that sends imported sources to Zotero.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.zoteroExport).onChange(async (v) => {
					this.plugin.settings.zoteroExport = v;
					await this.plugin.saveSettings();
					refreshZotero();
				})
			);

		autoUpdateSetting = new Setting(containerEl)
			.setName("Keep Zotero items up to date")
			.setDesc("Re-send an already-exported item whenever its bibliographic fields change — after a re-fetch, or an edit to the publication map. Items update in place; a plain template re-render changes nothing.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.zoteroAutoUpdate === true).onChange(async (v) => {
					this.plugin.settings.zoteroAutoUpdate = v;
					await this.plugin.saveSettings();
				})
			);

		autoCreateSetting = new Setting(containerEl)
			.setName("Create Zotero items for all sources")
			.setDesc("Send every installed source to Zotero automatically, without asking; an item you deleted there is recreated.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.zoteroAutoCreate === true).onChange(async (v) => {
					this.plugin.settings.zoteroAutoCreate = v;
					await this.plugin.saveSettings();
					if (v) void this.plugin.autoSyncZotero();
				})
			);

		methodSetting = new Setting(containerEl)
			.setName("Method")
			.setDesc("Local API writes to the Zotero on this computer; Web API writes to your online library; CSL-JSON downloads a file you import by hand.")
			.addDropdown((d) =>
				d
					.addOptions({
						local: "Local API (this computer)",
						web: "Web API (zotero.org)",
						csl: "CSL-JSON file (manual import)",
					})
					.setValue(this.plugin.settings.zoteroMethod)
					.onChange(async (v) => {
						this.plugin.settings.zoteroMethod = v as "local" | "web" | "csl";
						await this.plugin.saveSettings();
						refreshZotero();
					})
			);

		libSetting = new Setting(containerEl)
			.setName("Zotero library ID")
			.setDesc("Detected from the local Zotero when it is running; otherwise enter your numeric user (or group) ID.")
			.addText((t) =>
				t.setPlaceholder("649").setValue(this.plugin.settings.zoteroLibraryId).onChange(async (v) => {
					this.plugin.settings.zoteroLibraryId = v.trim();
					await this.plugin.saveSettings();
				})
			);

		keySetting = new Setting(containerEl)
			.setName("Zotero web API key")
			.setDesc("From Zotero.org/settings/keys, with write access. Stored in this vault's plugin data.")
			.addText((t) =>
				t.setValue(this.plugin.settings.zoteroApiKey).onChange(async (v: string) => {
					this.plugin.settings.zoteroApiKey = v.trim();
					await this.plugin.saveSettings();
				})
			);

		detectSetting = new Setting(containerEl)
			.setName("Detect local Zotero")
			.setDesc("Fill the library ID from a running local Zotero.")
			.addButton((b) =>
				b.setButtonText("Detect").onClick(async () => {
					const found = await this.plugin.detectZoteroLocal();
					if (!found) {
						new Notice("No local Zotero found on port 23119.");
						return;
					}
					this.plugin.settings.zoteroLibraryId = String(found.libraryId);
					this.plugin.settings.zoteroServerId = found.serverId;
					await this.plugin.saveSettings();
					const input = libSetting.settingEl.querySelector("input");
					if (input) input.value = String(found.libraryId);
					new Notice(`Local Zotero: library ${found.libraryId}.`);
				})
			);

		refreshZotero();
		void this.plugin.detectZoteroLocal().then(async (found) => {
			if (found && !this.plugin.settings.zoteroLibraryId) {
				this.plugin.settings.zoteroLibraryId = String(found.libraryId);
				this.plugin.settings.zoteroServerId = found.serverId;
				await this.plugin.saveSettings();
			}
		});
	}
}

// ── Transcription / translation modals ───────────────────────────────────────

function formatEvent(ev: PipelineEvent): string {
	if (ev.event === "log") return ev.message ?? "";
	if (ev.event === "step") return `[${ev.name}] ${ev.status}${ev.detail ? " — " + ev.detail : ""}`;
	if (ev.event === "result") return "✓ done";
	if (ev.event === "error") return `✗ ${ev.message}`;
	return JSON.stringify(ev);
}

/** A non-modal, persistent status bubble pinned to the corner of the window. */
class StatusPanel {
	app: App;
	title: string;
	root: HTMLElement;
	header: HTMLElement;
	titleEl: HTMLElement;
	body: HTMLElement;
	logEl: HTMLElement;
	state: "running" | "done" | "error" = "running";
	minimized = false;
	baseTitle = "";
	onClose: (() => void) | null = null;

	constructor(app: App, title: string) {
		this.app = app;
		this.title = title;
		this.baseTitle = title;
		this.root = document.body.createDiv();
		const s = this.root.style;
		s.position = "fixed";
		s.right = "16px";
		s.bottom = "16px";
		s.zIndex = "1000";
		s.width = "360px";
		s.maxWidth = "90vw";
		s.display = "flex";
		s.flexDirection = "column";
		s.background = "var(--background-secondary)";
		s.border = "1px solid var(--background-modifier-border)";
		s.borderRadius = "8px";
		s.boxShadow = "0 4px 16px rgba(0,0,0,0.25)";
		s.overflow = "hidden";

		this.header = this.root.createDiv();
		this.header.setCssStyles({
			display: "flex",
			alignItems: "center",
			gap: "6px",
			padding: "6px 8px",
			cursor: "pointer",
			fontWeight: "600",
			fontSize: "var(--font-ui-small)",
		});
		this.titleEl = this.header.createSpan({ text: `⟳ ${title}` });
		const spacer = this.header.createDiv();
		spacer.setCssStyles({ flex: "1" });
		const minBtn = this.header.createEl("button", { text: "–" });
		minBtn.setCssStyles({ cursor: "pointer" });
		minBtn.onclick = (e) => { e.stopPropagation(); this.toggleMinimize(); };
		const closeBtn = this.header.createEl("button", { text: "×" });
		closeBtn.setCssStyles({ cursor: "pointer" });
		closeBtn.onclick = (e) => { e.stopPropagation(); this.hide(); };
		this.header.onclick = () => { if (this.minimized) this.toggleMinimize(); };

		this.body = this.root.createDiv();
		this.body.setCssStyles({ padding: "0 8px 8px" });
		this.logEl = this.body.createEl("pre");
		this.logEl.setCssStyles({
			whiteSpace: "pre-wrap",
			fontSize: "var(--font-ui-smaller)",
			maxHeight: "32vh",
			overflow: "auto",
			margin: "0",
		});
	}

	append(ev: PipelineEvent): void {
		this.logEl.setText((this.logEl.getText() ? this.logEl.getText() + "\n" : "") + formatEvent(ev));
		if (ev.event === "step") {
			const detail = ev.detail ? ` — ${String(ev.detail).slice(0, 40)}` : "";
			this.titleEl.setText(`⟳ ${ev.name}${detail}`);
		}
		this.scrollToBottom();
	}

	scrollToBottom(): void {
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	finish(ok: boolean): void {
		this.state = ok ? "done" : "error";
		this.titleEl.setText(`${ok ? "✓" : "✗"} ${this.baseTitle}`);
		this.root.style.borderColor = ok ? "var(--color-green)" : "var(--color-red)";
		this.scrollToBottom();
	}

	addResultLinks(paths: string[]): void {
		const valid = paths.filter((p) => typeof p === "string" && p);
		if (!valid.length) return;
		const row = this.body.createDiv();
		row.setCssStyles({ marginTop: "4px" });
		for (const path of valid) {
			const a = row.createEl("a", { text: `↗ ${basenameJS(path)}` });
			a.setCssStyles({ marginRight: "10px", cursor: "pointer" });
			a.onclick = (e) => { e.preventDefault(); this.openPath(path); };
		}
		this.scrollToBottom();
	}

	openPath(path: string): void {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		const vault = adapter?.getBasePath?.() ?? "";
		const rel = vault && path.startsWith(vault) ? path.slice(vault.length + 1) : path;
		const file = this.app.vault.getAbstractFileByPath(rel);
		if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
		else void this.app.workspace.openLinkText(rel, "", true);
	}

	reveal(): void {
		this.root.setCssStyles({ display: "flex" });
		if (this.minimized) this.toggleMinimize();
		this.scrollToBottom();
		this.root.scrollIntoView({ block: "nearest" });
	}

	hide(): void {
		this.root.setCssStyles({ display: "none" });
	}

	toggleMinimize(): void {
		this.minimized = !this.minimized;
		this.body.style.display = this.minimized ? "none" : "block";
		if (!this.minimized) this.scrollToBottom();
	}

	destroy(): void {
		this.root.remove();
		if (this.onClose) this.onClose();
	}
}

class LogModal extends Modal {
	title: string;
	text: string;

	constructor(app: App, title: string, text: string) {
		super(app);
		this.title = title;
		this.text = text;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		const pre = contentEl.createEl("pre");
		pre.setText(this.text);
		pre.setCssStyles({
			whiteSpace: "pre-wrap",
			maxHeight: "60vh",
			overflow: "auto",
			fontSize: "var(--font-ui-smaller)",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ApiKeyModal extends Modal {
	plugin: ArabicSupportPlugin;

	constructor(app: App, plugin: ArabicSupportPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Gemini API key required" });
		contentEl.createEl("p", {
			text: "The transcription and translation pipeline calls Gemini, which needs an API key.",
		});
		contentEl.createEl("p", {
			text: "Set it in the Midad Arabic Sources plugin settings (recommended): it is passed to the pipeline automatically. Alternatively, provide GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment Obsidian was launched from.",
		});
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Open plugin settings").setCta().onClick(() => {
					this.close();
					this.plugin.openSettings();
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ResumeModal extends Modal {
	plugin: ArabicSupportPlugin;
	state: PipelineState;

	constructor(app: App, plugin: ArabicSupportPlugin, state: PipelineState) {
		super(app);
		this.plugin = plugin;
		this.state = state;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Pipeline job" });
		const pdf = this.state.pdf ? basenameJS(this.state.pdf) : "";
		contentEl.createEl("p", { text: `${this.state.stage ?? "unknown"}${pdf ? " — " + pdf : ""}` });
		const pre = contentEl.createEl("pre");
		pre.setText(JSON.stringify(this.state, null, 1));
		pre.setCssStyles({
			maxHeight: "30vh",
			overflow: "auto",
			fontSize: "var(--font-ui-smaller)",
		});
		const setting = new Setting(contentEl);
		let alive = false;
		try { if (this.state.pid) { process.kill(this.state.pid, 0); alive = true; } } catch { alive = false; }
		if (alive) {
			contentEl.createEl("p", { text: "This job appears to still be running (its worker process is alive)." });
		} else {
			setting.addButton((b) =>
				b.setButtonText("Resume").setCta().onClick(async () => {
					this.close();
					await this.plugin.runResume(this.state._path);
				})
			);
		}
		setting.addButton((b) => b.setButtonText("Open log").onClick(() => { this.close(); void this.plugin.openLastLog(); }));
		setting.addButton((b) => b.setButtonText("Dismiss").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TranscribeModal extends Modal {
	plugin: ArabicSupportPlugin;
	citekey: string;
	pdfs: PipelinePdf[];
	checks: Array<{ pdf: PipelinePdf; el: HTMLInputElement; vol: TextComponent }> = [];

	constructor(app: App, plugin: ArabicSupportPlugin, citekey: string, pdfs: PipelinePdf[]) {
		super(app);
		this.plugin = plugin;
		this.citekey = citekey;
		this.pdfs = pdfs;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Transcribe PDFs — @${this.citekey}` });
		contentEl.createEl("p", {
			text: "Choose the PDF file(s) to transcribe. The volume is inferred from the filename and can be edited.",
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Select all").onClick(() => this.checks.forEach((c) => (c.el.checked = !c.el.disabled)))
			)
			.addButton((b) =>
				b.setButtonText("Select none").onClick(() => this.checks.forEach((c) => (c.el.checked = false)))
			);

		for (const pdf of this.pdfs) {
			const row = contentEl.createDiv();
			const cb = row.createEl("input");
			cb.type = "checkbox";
			cb.checked = !!pdf.exists;
			cb.disabled = !pdf.exists;
			row.createSpan({ text: ` ${pdf.filename}${pdf.exists ? "" : " (file not found)"} ` });
			row.createSpan({ text: "vol." });
			const vol = new TextComponent(row);
			vol.setValue(pdf.volume != null ? String(pdf.volume) : "").setPlaceholder("—");
			vol.inputEl.setCssStyles({ width: "3.5em" });
			this.checks.push({ pdf, el: cb, vol });
		}

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Transcribe")
				.setCta()
				.onClick(async () => {
					const chosen = this.checks.filter((c) => c.el.checked);
					if (!chosen.length) { new Notice("Select at least one PDF."); return; }
					const args = ["transcribe", "--citekey", this.citekey];
					for (const c of chosen) {
						const v = c.vol.getValue().trim();
						args.push("--pdf", v ? `${c.pdf.path}::${v}` : c.pdf.path);
					}
					this.close();
					await this.plugin.runWithProgress("Transcribing", args);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TranslateModal extends Modal {
	plugin: ArabicSupportPlugin;
	citekey: string;
	notes: PipelineNote[];
	pdfs: PipelinePdf[];
	checks: Array<{ note: PipelineNote; el: HTMLInputElement }> = [];
	volume = "";

	constructor(app: App, plugin: ArabicSupportPlugin, citekey: string, notes: PipelineNote[], pdfs: PipelinePdf[]) {
		super(app);
		this.plugin = plugin;
		this.citekey = citekey;
		this.notes = notes;
		this.pdfs = pdfs;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Translate — @${this.citekey}` });

		const transcriptions = this.notes.filter((n) => n.type === "transcription");
		if (!transcriptions.length) {
			contentEl.createEl("p", { text: "No transcription exists yet. Run “transcribe this item's PDF file(s)” first." });
		} else {
			contentEl.createEl("p", { text: "Choose the transcription(s) to translate." });
			new Setting(contentEl)
				.addButton((b) =>
					b.setButtonText("Select all").onClick(() => this.checks.forEach((c) => (c.el.checked = true)))
				)
				.addButton((b) =>
					b.setButtonText("Select none").onClick(() => this.checks.forEach((c) => (c.el.checked = false)))
				);
			for (const n of transcriptions) {
				const row = contentEl.createDiv();
				const cb = row.createEl("input");
			cb.type = "checkbox";
				cb.checked = true;
				row.createSpan({ text: ` ${n.name}` });
				this.checks.push({ note: n, el: cb });
			}
		}

		if (this.pdfs.length) {
			contentEl.createEl("p", { text: "PDF files associated with this item:" });
			const ul = contentEl.createEl("ul");
			for (const p of this.pdfs) {
				ul.createEl("li", { text: `${p.filename}${p.exists ? "" : " (file not found)"}` });
			}
		}

		new Setting(contentEl)
			.setName("Volume")
			.setDesc("Optional volume number.")
			.addText((t) => t.setPlaceholder("E.g. 2").onChange((v) => (this.volume = v.trim())));

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Translate")
				.setCta()
				.onClick(async () => {
					const chosen = this.checks.filter((c) => c.el.checked).map((c) => c.note.path);
					if (!chosen.length) { new Notice("Select at least one transcription."); return; }
					const args = ["translate", "--citekey", this.citekey];
					for (const p of chosen) args.push("--source", p);
					if (this.volume) args.push("--volume", this.volume);
					this.close();
					await this.plugin.runWithProgress("Translating", args);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ReprocessModal extends Modal {
	plugin: ArabicSupportPlugin;
	zips: ArchiveZip[];
	checks: Array<{ zip: ArchiveZip; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: ArabicSupportPlugin, zips: ArchiveZip[]) {
		super(app);
		this.plugin = plugin;
		this.zips = zips;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Reprocess from archive" });
		if (!this.zips.length) {
			contentEl.createEl("p", { text: "No archived batches found in .midad-arabic-sources/archive." });
			return;
		}
		contentEl.createEl("p", { text: "Re-run post-processing on an archived batch (no Gemini resubmission)." });
		for (const z of this.zips) {
			const row = contentEl.createDiv();
			const cb = row.createEl("input");
			cb.type = "checkbox";
			row.createSpan({ text: ` ${z.name}` });
			this.checks.push({ zip: z, el: cb });
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Reprocess")
				.setCta()
				.onClick(async () => {
					const chosen = this.checks.filter((c) => c.el.checked).map((c) => c.zip.path);
					if (!chosen.length) { new Notice("Select at least one archive."); return; }
					this.close();
					for (const z of chosen) await this.plugin.runWithProgress("Reprocessing", ["reprocess", "--zip", z]);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Template update consent ──────────────────────────────────────────────────

class SourceTemplateUpdateConsentModal extends Modal {
	count: number;
	onChoose: (choice: "yes" | "no" | "skip") => void;

	constructor(app: App, count: number, onChoose: (choice: "yes" | "no" | "skip") => void) {
		super(app);
		this.count = count;
		this.onChoose = onChoose;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Update imported source notes?" });
		contentEl.createEl("p", {
			text: `The import templates changed. ${this.count} note(s) were rendered with an older version. Re-render them now? Your own edits and out-of-template properties are preserved.`,
		});
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Yes, update").setCta().onClick(() => {
					this.close();
					this.onChoose("yes");
				})
			)
			.addButton((b) =>
				b.setButtonText("Not now").onClick(() => {
					this.close();
					this.onChoose("skip");
				})
			)
			.addButton((b) =>
				b.setButtonText("Never").onClick(() => {
					this.close();
					this.onChoose("no");
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Reconcile incomplete imports ─────────────────────────────────────────────

class ReconcileSourcesModal extends Modal {
	plugin: ArabicSupportPlugin;
	items: Array<{ work: JsonObject; missing: number; total: number; reason: string }>;
	checks: Array<{ work: JsonObject; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: ArabicSupportPlugin, items: Array<{ work: JsonObject; missing: number; total: number; reason: string }>) {
		super(app);
		this.plugin = plugin;
		this.items = items;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Incomplete imported sources" });
		contentEl.createEl("p", {
			text: "Some files for the following work(s) are missing, or their cached source is gone (perhaps deleted outside the plugin). Restore them, or remove the work(s) completely.",
		});
		for (const it of this.items) {
			const row = contentEl.createDiv();
			const cb = row.createEl("input");
			cb.type = "checkbox";
			cb.checked = true;
			const detail = it.reason === "model" ? "cached source missing"
				: it.reason === "model-stale" ? "cached source is outdated"
				: `${it.missing}/${it.total} file(s) missing`;
			row.createSpan({ text: ` ${it.work.title} — ${detail}` });
			this.checks.push({ work: it.work, el: cb });
		}
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Reinstall selected").setCta().onClick(async () => {
					const chosen = this.checks.filter((c) => c.el.checked);
					if (!chosen.length) { new Notice("Select at least one work."); return; }
					this.close();
					for (const c of chosen) await this.plugin.reinstallSource(c.work);
					new Notice(`Reinstalled ${chosen.length} work(s).`);
				})
			)
			.addButton((b) =>
				b.setButtonText("Remove selected").setDestructive().onClick(async () => {
					const chosen = this.checks.filter((c) => c.el.checked);
					if (!chosen.length) { new Notice("Select at least one work."); return; }
					this.close();
					for (const c of chosen) await this.plugin.removeSource(c.work);
					new Notice(`Removed ${chosen.length} work(s).`);
				})
			)
			.addButton((b) => b.setButtonText("Decide later").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Manage text sources ──────────────────────────────────────────────────────

/**
 * Shown when a source needs transliteration to render but the service is not
 * running. The user can start it and try again, or accept simpler names.
 */
class TransliterationUnavailableModal extends Modal {
	sourceName: string;
	resolve: (choice: "retry" | "skip" | "cancel") => void;
	answered = false;

	constructor(app: App, sourceName: string, resolve: (choice: "retry" | "skip" | "cancel") => void) {
		super(app);
		this.sourceName = sourceName;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.titleEl.setText("Transliteration unavailable");
		this.contentEl.createEl("p", {
			text: `This source, ${this.sourceName}, requires transliteration to render, but the `
				+ "transliteration server is not running. Would you like to start the server before "
				+ "rendering this source, or would you like to proceed with simpler transliteration?",
		});
		const footer = new Setting(this.contentEl);
		footer.addButton((b) =>
			b.setButtonText("Try again").setCta().onClick(() => {
				this.answered = true;
				this.resolve("retry");
				this.close();
			})
		);
		footer.addButton((b) =>
			b.setButtonText("Proceed without transliteration").onClick(() => {
				this.answered = true;
				this.resolve("skip");
				this.close();
			})
		);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve("cancel");
	}
}

interface SourceWork {
	key: string;
	collection: string;
	collection_label: string;
	/** The topic/genre this work belongs to (collections can share one). */
	genre?: string;
	/** The repository the text is drawn from (for the column + sidebar). */
	repository?: string;
	/** True when some entries are named by transliterating their Arabic. */
	needs_transliteration?: boolean;
	id: string;
	name: string;
	title: string;
	dir: string;
	author: string;
	language: string;
	language_label: string;
	type: string;
	/** Bytes of this work's source already downloaded (0 = not downloaded). */
	cache_bytes?: number;
	/** A rough size for a work that is not downloaded yet, if the catalogue allows. */
	est_bytes?: number;
}

/** A human-readable byte size, or an em dash when nothing is known. */
function formatBytes(n: number | undefined): string {
	if (!n) return "—";
	const mb = n / 1_048_576;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Recognisable genre labels for the modal's "Kinds of sources". */
const GENRE_LABELS: Record<string, string> = {
	tafsir: "Tafsīr",
	quran: "Translations",
	hadith: "Ḥadīth",
	"quran-text": "Qurʾān text",
};

/** A response header, matched case-insensitively (Obsidian keeps the sent case). */
function header(resp: { headers?: Record<string, string> }, name: string): string {
	const h = resp.headers ?? {};
	const want = name.toLowerCase();
	for (const k of Object.keys(h)) {
		if (k.toLowerCase() === want) return String(h[k]);
	}
	return "";
}

/**
 * One modal to install and uninstall sources. Installed works are pre-checked;
 * non-installed ones are unchecked. "Apply" reconciles the two: newly checked
 * works are installed, newly unchecked installed works are removed. Reinstalling
 * a corrupt item is just uncheck + Apply, then check + Apply.
 */
class ManageSourcesModal extends Modal {
	plugin: ArabicSupportPlugin;
	works: SourceWork[];
	installed: Set<string>;
	deleting: Set<string>;
	sizes: Map<string, number>;
	onReload?: () => void;
	initial: Map<string, boolean>;
	zoteroStatus: Map<string, string>;
	rows: Array<{ work: SourceWork; el: HTMLElement; isInstalled: boolean; genre: string; repo: string; collection: string }> = [];
	headings: Map<string, HTMLElement> = new Map();
	/** The works the user has highlighted; Apply acts on the difference. */
	selected = new Set<string>();
	show: "all" | "installed" | "not-installed";
	mode: "manage" | "zotero" = "manage";
	activeGenres = new Set<string>();
	offRepos = new Set<string>();
	allSelected = false;
	refreshSelection: () => void = () => {};
	updateFilter: () => void = () => {};

	constructor(app: App, plugin: ArabicSupportPlugin, works: SourceWork[], installed: Set<string>, deleting: Set<string> = new Set(), sizes: Map<string, number> = new Map(), zoteroStatus: Map<string, string> = new Map(), onReload?: () => void) {
		super(app);
		this.plugin = plugin;
		this.works = works;
		this.installed = installed;
		this.deleting = deleting;
		this.sizes = sizes;
		this.zoteroStatus = zoteroStatus;
		this.onReload = onReload;
		this.initial = new Map(works.map((w) => [w.key, installed.has(w.key)]));
		const saved = plugin.settings.manageShowFilter;
		this.show = saved === "installed" || saved === "not-installed" ? saved : "all";
		this.activeGenres = new Set(plugin.settings.manageGenreFilter || []);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Midad Arabic Sources");
		this.modalEl.classList.add("mas-manage-modal");
		contentEl.classList.add("mas-manage");

		// Two functions over one window, as tabs: install/uninstall, or send.
		const tabs = contentEl.createDiv({ cls: "mas-manage__tabs" });
		const manageTab = tabs.createEl("button", { cls: "mas-manage__tab", text: "Install/uninstall sources" });
		const zoteroTab = tabs.createEl("button", { cls: "mas-manage__tab", text: "Send references to Zotero" });
		const desc = contentEl.createEl("p", { cls: "mas-manage__desc" });

		// ── Top bar: Show / search / language / reload ────────────────────────
		const topbar = contentEl.createDiv({ cls: "mas-manage__searchrow" });
		topbar.createSpan({ cls: "mas-manage__label", text: "Show:" });
		const showSel = topbar.createEl("select");
		for (const [val, label] of [["all", "All"], ["installed", "Installed"], ["not-installed", "Not installed"]] as const) {
			showSel.createEl("option", { text: label }).value = val;
		}
		showSel.value = this.show;
		const search = topbar.createEl("input", { cls: "mas-manage__search" });
		search.type = "search";
		search.placeholder = "Filter…";
		const langSel = topbar.createEl("select");
		const langLabels = new Map<string, string>();
		for (const w of this.works) langLabels.set(w.language, w.language_label || w.language);
		for (const lg of Array.from(langLabels.keys()).sort()) {
			langSel.createEl("option", { text: langLabels.get(lg) || lg }).value = lg;
		}
		langSel.createEl("option", { text: "All languages" }).value = "";
		langSel.value = "";
		if (this.onReload) {
			const reload = topbar.createEl("button", { cls: "mas-manage__reload", text: "↻" });
			reload.title = "Reload the list of available sources";
			reload.setAttribute("aria-label", "Reload the list of available sources");
			reload.onclick = () => {
				this.close();
				this.onReload?.();
			};
		}

		// ── Body: sidebar (kinds + repositories) + list pane ──────────────────
		const body = contentEl.createDiv({ cls: "mas-manage__body" });
		const side = body.createDiv({ cls: "mas-manage__side" });

		side.createDiv({ cls: "mas-manage__group", text: "Kinds of sources" });
		const genreToggles = side.createDiv({ cls: "mas-manage__toggles" });
		const genres: string[] = [];
		const genreLabel = new Map<string, string>();
		for (const w of this.works) {
			const g = w.genre || w.collection;
			if (genreLabel.has(g)) continue;
			genres.push(g);
			genreLabel.set(g, GENRE_LABELS[g] || w.collection_label || g);
		}
		for (const g of [...this.activeGenres]) if (!genreLabel.has(g)) this.activeGenres.delete(g);
		for (const g of genres) {
			const btn = genreToggles.createEl("button", { cls: "mas-manage__toggle", text: genreLabel.get(g) || g });
			btn.classList.toggle("is-on", this.activeGenres.has(g));
			btn.onclick = () => {
				if (this.activeGenres.has(g)) this.activeGenres.delete(g);
				else this.activeGenres.add(g);
				btn.classList.toggle("is-on", this.activeGenres.has(g));
				this.plugin.settings.manageGenreFilter = [...this.activeGenres];
				void this.plugin.saveSettings();
				this.updateFilter();
			};
		}

		side.createDiv({ cls: "mas-manage__group", text: "Repositories" });
		const repoList = side.createDiv({ cls: "mas-manage__repo-list" });
		const repos: string[] = [];
		const repoSeen = new Set<string>();
		for (const w of this.works) {
			const r = w.repository || "Other";
			if (repoSeen.has(r)) continue;
			repoSeen.add(r);
			repos.push(r);
		}
		repos.sort((a, b) => a.localeCompare(b));
		for (const r of repos) {
			const item = repoList.createDiv({ cls: "mas-manage__repo", text: r });
			item.onclick = () => {
				if (this.offRepos.has(r)) this.offRepos.delete(r);
				else this.offRepos.add(r);
				item.classList.toggle("is-off", this.offRepos.has(r));
				this.updateFilter();
			};
		}

		// ── The list: one clickable row per work (highlight = selected) ───────
		const pane = body.createDiv({ cls: "mas-manage__pane" });
		const list = pane.createDiv({ cls: "mas-manage__list" });
		const COLS = "8ch minmax(110px,0.9fr) minmax(190px,1.8fr) minmax(120px,0.9fr) 76px 96px";
		const head = list.createDiv({ cls: "mas-manage__head" });
		head.style.gridTemplateColumns = COLS;
		for (const label of ["Lang", "Author", "Title", "Repository", "Size", "State"]) head.createSpan({ text: label });

		let lastCollection = "";
		for (const w of this.works) {
			if (w.collection !== lastCollection) {
				lastCollection = w.collection;
				this.headings.set(w.collection, list.createDiv({ cls: "mas-manage__collection", text: w.collection_label || w.collection }));
			}
			const row = list.createDiv({ cls: "mas-manage__row" });
			row.style.gridTemplateColumns = COLS;
			const isInstalled = this.installed.has(w.key);
			row.createSpan({ cls: "mas-manage__lang", text: w.language.toUpperCase() });
			row.createSpan({ text: w.author || "" });
			row.createSpan({ text: w.title || w.name });
			row.createSpan({ cls: "mas-manage__mut", text: w.repository || "" });
			const known = this.sizes.get(w.key);
			const size = row.createSpan({
				cls: "mas-manage__size",
				text: known ? formatBytes(known) : w.est_bytes ? `≈${formatBytes(w.est_bytes)}` : "—",
			});
			size.title = known ? "On disk" : w.est_bytes ? "Estimated" : "Unknown";
			row.createSpan({
				cls: "mas-manage__mut",
				text: this.deleting.has(w.key) ? "being removed" : isInstalled ? "installed" : "",
			});
			row.onclick = () => {
				if (this.selected.has(w.key)) this.selected.delete(w.key);
				else this.selected.add(w.key);
				this.refreshSelection();
			};
			this.rows.push({
				work: w, el: row, isInstalled,
				genre: w.genre || w.collection,
				repo: w.repository || "Other",
				collection: w.collection,
			});
		}

		const foot = pane.createDiv({ cls: "mas-manage__foot" });
		const statusEl = foot.createDiv({ cls: "mas-manage__status" });
		const actions = foot.createDiv({ cls: "mas-manage__actions" });
		const selectAllBtn = actions.createEl("button", { cls: "mas-manage__toggle", text: "Select all/none" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		const applyBtn = actions.createEl("button", { cls: "mod-cta", text: "Apply" });

		const updateStatus = () => {
			const visible = this.rows.filter((r) => !r.el.classList.contains("is-hidden")).length;
			statusEl.setText(`${this.selected.size} selected · ${visible} shown`);
		};
		this.refreshSelection = () => {
			for (const r of this.rows) r.el.classList.toggle("is-selected", this.selected.has(r.work.key));
			updateStatus();
		};
		this.updateFilter = () => {
			const q = search.value.trim().toLowerCase();
			const lg = langSel.value;
			for (const r of this.rows) {
				const w = r.work;
				const hay = `${w.title} ${w.name} ${w.author} ${w.id} ${w.repository || ""}`.toLowerCase();
				const showOk = this.show === "all" || (this.show === "installed" ? r.isInstalled : !r.isInstalled);
				const genreOk = !this.activeGenres.size || this.activeGenres.has(r.genre);
				const repoOk = !this.offRepos.has(r.repo);
				const visible = showOk && genreOk && repoOk && (!q || hay.includes(q)) && (!lg || w.language === lg);
				r.el.classList.toggle("is-hidden", !visible);
			}
			// A collection heading is only meaningful while it still has a visible row.
			for (const [coll, heading] of this.headings) {
				const anyVisible = this.rows.some((r) => r.collection === coll && !r.el.classList.contains("is-hidden"));
				heading.classList.toggle("is-hidden", !anyVisible);
			}
			updateStatus();
		};

		showSel.onchange = async () => {
			this.show = showSel.value as typeof this.show;
			this.plugin.settings.manageShowFilter = this.show;
			await this.plugin.saveSettings();
			this.updateFilter();
		};
		search.oninput = () => this.updateFilter();
		langSel.onchange = () => this.updateFilter();
		selectAllBtn.onclick = () => {
			this.allSelected = !this.allSelected;
			const visible = this.rows.filter((r) => !r.el.classList.contains("is-hidden"));
			if (this.allSelected) for (const r of visible) this.selected.add(r.work.key);
			else for (const r of visible) this.selected.delete(r.work.key);
			this.refreshSelection();
		};
		cancelBtn.onclick = () => this.close();
		applyBtn.onclick = async () => {
			if (this.mode === "zotero") {
				const keys = new Set(
					this.works.filter((w) => this.selected.has(w.key) && this.installed.has(w.key)).map((w) => w.key)
				);
				if (!keys.size) {
					new Notice("Nothing selected.");
					return;
				}
				this.close();
				await this.plugin.exportToZotero(keys);
				return;
			}
			const toInstall: SourceWork[] = [];
			const toRemove: SourceWork[] = [];
			for (const w of this.works) {
				const was = this.initial.get(w.key) === true;
				const now = this.selected.has(w.key);
				if (now && !was) toInstall.push(w);
				else if (!now && was) toRemove.push(w);
			}
			if (!toInstall.length && !toRemove.length) {
				new Notice("Nothing to change.");
				return;
			}
			this.close();
			const progress = new Notice(
				`Applying… (${toInstall.length} to install, ${toRemove.length} to remove)`,
				0
			);
			const failed: string[] = [];
			try {
				let n = 0;
				for (const w of toRemove) {
					const name = w.title || w.dir;
					const nth = `${++n}/${toRemove.length}`;
					progress.setMessage(`Removing ${nth}: ${name}…`);
					try {
						await this.plugin.removeSource(w, (done, total) =>
							progress.setMessage(`Removing ${nth}: ${name} — ${done}/${total} files…`)
						);
					} catch (e) {
						failed.push(`${name}: ${e instanceof Error ? e.message : e}`);
					}
				}
				if (toInstall.length) {
					progress.setMessage(`Installing ${toInstall.length} source(s)…`);
					try {
						await this.plugin.importSources(toInstall.map((w) => w.key));
					} catch (e) {
						failed.push(`install: ${e instanceof Error ? e.message : e}`);
					}
				}
			} finally {
				progress.hide();
			}
			new Notice(
				`Applied: ${toInstall.length} installed, ${toRemove.length} removed.` +
					(failed.length ? ` ${failed.length} failed — see the console.` : "")
			);
			if (failed.length) console.error("[midad-arabic-sources] apply failures", failed);
		};

		const setMode = (m: "manage" | "zotero") => {
			this.mode = m;
			manageTab.classList.toggle("is-active", m === "manage");
			zoteroTab.classList.toggle("is-active", m === "zotero");
			desc.setText(m === "manage"
				? "Selected works are kept installed; deselect one to remove it. Apply installs the newly selected and removes the newly deselected."
				: "Select the sources to send; new and changed entries start selected. Only installed sources are listed.");
			applyBtn.setText(m === "manage" ? "Apply" : "Send to Zotero");
			selectAllBtn.classList.toggle("is-hidden", m === "manage");
			this.allSelected = false;
			if (m === "zotero") {
				this.show = "installed";
				showSel.value = "installed";
			}
			showSel.disabled = m === "zotero";
			// Manage selects what is installed; Zotero selects what needs sending.
			this.selected = new Set(
				this.works
					.filter((w) => (m === "manage"
						? this.initial.get(w.key) === true
						: this.installed.has(w.key) && this.zoteroStatus.get(w.key) !== "current"))
					.map((w) => w.key)
			);
			this.refreshSelection();
			this.updateFilter();
		};
		manageTab.onclick = () => setMode("manage");
		zoteroTab.onclick = () => setMode("zotero");
		setMode(this.mode);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Send selected installed sources to Zotero. The rows come from the same data the
 * "Manage text sources" modal uses, but only installed works are listed and Apply
 * sends to Zotero instead of installing/uninstalling.
 */
class ZoteroSendModal extends Modal {
	plugin: ArabicSupportPlugin;
	entries: Array<{ work: JsonObject; item: JsonObject; hash: string; itemKey: string; status: "new" | "changed" | "current" }>;
	checks: Array<{ key: string; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: ArabicSupportPlugin, entries: ZoteroSendModal["entries"]) {
		super(app);
		this.plugin = plugin;
		this.entries = entries;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Send sources to Zotero" });
		contentEl.createEl("p", {
			text: "Check the sources to send. New and changed entries are checked; those already in Zotero are left unchecked.",
		});

		const controls = contentEl.createDiv();
		controls.setCssStyles({ display: "flex", gap: "8px", margin: "6px 0" });
		const all = controls.createEl("button", { text: "Check all" });
		const none = controls.createEl("button", { text: "Uncheck all" });

		const list = contentEl.createDiv();
		list.setCssStyles({
			maxHeight: "50vh",
			overflow: "auto",
			border: "1px solid var(--background-modifier-border)",
			borderRadius: "6px",
			padding: "4px",
		});

		const COLS = "18px minmax(180px,2fr) minmax(120px,1fr) 90px";
		for (const e of this.entries) {
			const row = list.createDiv();
			row.setCssStyles({
				display: "grid",
				gridTemplateColumns: COLS,
				columnGap: "8px",
				alignItems: "center",
				padding: "3px 4px",
			});
			const cb = row.createEl("input");
			cb.type = "checkbox";
			cb.checked = e.status !== "current";
			row.createSpan({ text: String(e.work.title || e.work.name || e.work.key) });
			const author = row.createSpan({ text: String(e.work.author || "") });
			author.setCssStyles({ opacity: "0.6", fontSize: "var(--font-ui-smaller)" });
			const status = row.createSpan({ text: e.status });
			status.setCssStyles({ opacity: "0.6", fontSize: "var(--font-ui-smaller)" });
			this.checks.push({ key: String(e.work.key), el: cb });
		}
		all.onclick = () => this.checks.forEach((c) => (c.el.checked = true));
		none.onclick = () => this.checks.forEach((c) => (c.el.checked = false));

		const footer = new Setting(contentEl);
		footer.addButton((b) =>
			b.setButtonText("Send to Zotero").setCta().onClick(async () => {
				const keys = new Set(this.checks.filter((c) => c.el.checked).map((c) => c.key));
				if (!keys.size) {
					new Notice("Nothing selected.");
					return;
				}
				this.close();
				await this.plugin.exportToZotero(keys);
			})
		);
		footer.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
