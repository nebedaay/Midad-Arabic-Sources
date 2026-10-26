import { execFile, spawn } from "child_process";
import { webUtils } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import { promisify } from "util";
import * as zlib from "zlib";
import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TAbstractFile,
	TFile,
	TextComponent,
	setIcon,
	normalizePath,
	parseYaml,
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
	buildMocSections,
	canonicalMocName,
	renderMocIndex,
	renderSourcesNote,
	vaultRelative,
	writeMerged,
} from "./sourceImport/render";
import {
	TemplateHashes,
	TemplateHashValue,
	hashString,
	recordTemplateHashes,
	splitTemplateSource,
	templateChangedAt,
} from "./sourceImport/history";
import { BUNDLED_ASSETS } from "./assets.generated";
import { localDate } from "./time";
import { sourceIdFromYaml, sourceIdToYaml } from "./sourceIds";
import { sourceRoot as resolveSourceRoot, installedSourcesRoot as resolveInstalledSourcesRoot, transcriptionsFolder as resolveTranscriptionsFolder, translationsFolder as resolveTranslationsFolder, canonicalQuranFolder as resolveCanonicalQuranFolder, sourceNotePath as resolveSourceNotePath } from "./sourcePaths";
import { openDocs, getDocs } from "./docs";
import { registerAnnotations, AnnotationService } from "./sourceAnnotations/service";
import { buildSourceRegistry, writeSourceRegistry } from "./sourceRegistry/registry";
import { YamlBuilder } from "./sourceImport/yaml";
import { ConfirmModal } from "./sourceAnnotations/modal";
import { AnnotationTrashModal } from "./sourceAnnotations/trashModal";
import type { AnnotationColor } from "./sourceAnnotations/types";

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
type LlmProvider = "gemini" | "deepseek" | "openai";
type LlmTask = "transliteration" | "transcription" | "translation";

/** One reusable LLM endpoint/key/model configuration. */
interface LlmConfig {
	id: string;
	name: string;
	provider: LlmProvider;
	model: string;
	apiKey: string;
	baseUrl: string;
}

interface LlmAssignments {
	transliteration: string;
	transcription: string;
	translation: string;
}

interface MidadArabicSourcesSettings {
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
	// LLM configuration (legacy fields kept for migration)
	llmProvider: LlmProvider;
	llmModel: string;
	llmApiKey: string;
	llmBaseUrl: string;
	llmConfigs?: LlmConfig[];
	llmAssignments?: LlmAssignments;
	// Gemini transcription/translation pipeline
	pythonPath: string;
	pipelineScript: string;
	geminiApiKey: string;
	// General
	sourceRoot: string;
	sourceLayoutMigrated?: boolean;
	// Text-source importer (tafsīr, Qur’ān translations, ḥadīth, …)
	sourceImportScript: string;
	sourceImportRoot: string;
	sourceTemplateFolder: string;
	canonicalQuranRiwāya: string;
	canonicalQuranFolder: string;
	sourceMocParent: string;
	// Annotations
	annotationNoteFolder: string;
	annotationDefaultColor: AnnotationColor;
	annotationTrashDays: number;
	annotateOnSelection: boolean;
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

type ArchivedDocType = "transcription" | "translation";

/** A note that may have an archived JSON batch instead of a source model. */
interface ArchivedNoteInfo {
	citekey: string;
	type: ArchivedDocType | null;
	volume: number | null;
}

/** An archive name parsed into its citekey, kind, and optional volume. */
interface ArchivedBatchInfo {
	citekey: string;
	type: ArchivedDocType;
	volume: number | null;
}

function archivedNoteInfo(path: string): ArchivedNoteInfo | null {
	const stem = basenameJS(path).replace(/\.md$/i, "");
	const typed = stem.match(/^(?:@|mas-)(.+?) - (transcription|translation)(?: - (?:vol|v)\.\s*(\d+))?$/i);
	if (typed) {
		return {
			citekey: typed[1],
			type: typed[2].toLowerCase() as ArchivedDocType,
			volume: typed[3] ? parseInt(typed[3], 10) : null,
		};
	}
	// A literature note: re-render any archived transcription/translation for
	// its citekey.
	const literature = stem.match(/^@([^\s/]+)$/);
	if (literature) return { citekey: literature[1], type: null, volume: null };
	return null;
}

function archivedBatchInfo(name: string): ArchivedBatchInfo | null {
	const stem = name.replace(/\.zip$/i, "");
	const m = stem.match(/^(.+?) - (transcription|translation)(?: - (?:vol|v)\.\s*(\d+))? files$/i);
	if (!m) return null;
	return {
		citekey: m[1],
		type: m[2].toLowerCase() as ArchivedDocType,
		volume: m[3] ? parseInt(m[3], 10) : null,
	};
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

/** The two prompt kinds: one list for OCR, one for translation. */
type PromptKind = "transcription" | "translation";

/** One named prompt in a `.midad-arabic-sources/*-prompts.json` file. */
interface PromptEntry {
	name: string;
	text: string;
	/** The built-in "Default prompt": it can be edited but not deleted. */
	builtin?: boolean;
	/** True once the user has edited the built-in default, so it is not auto-refreshed. */
	modified?: boolean;
}

/** The prompt file's shape. */
interface PromptFile {
	version: number;
	prompts: PromptEntry[];
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
	/** The *render* version this work was last rendered with (see below). */
	render?: number;
	/** Note path → hash of the content last rendered there (see `contentHash`). */
	units?: Record<string, string>;
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
const SOURCE_CATALOG_SCHEMA = 4;

/**
 * The cached-model schema at which each collection's *acquisition* last changed.
 * A model older than its collection's entry is re-fetched, because a re-render
 * only replays the cached model and cannot apply an acquisition change. Listing
 * it per collection means one collection's change never triggers a corpus-wide
 * re-fetch: a collection absent here keeps its cached models.
 *
 * `dictionary` → 6: the leading-parenthesis fix, the verb-form look-ahead, the
 * engine fallback, the gemination completion, `title`/`section_page`, and
 * dropping the generated form-label parenthetical (`<b>III</b> (اَاَخَذَ)`).
 * Bump only the affected entries, and in step with `MODEL_SCHEMA` in
 * `scripts/text-source-import.py`.
 */
const COLLECTION_MODEL_SCHEMA: Record<string, number> = {
	dictionary: 6,
};

/**
 * The version at which each collection's *rendering* last changed — the plugin's
 * own code, not the template and not the model.
 *
 * Templates carry their own hashes and models carry their mtimes, so both of
 * those are already noticed. What was untracked is a change to how this plugin
 * turns a model into notes (naming, pruning, link forms). Bumping a collection
 * here makes its works stale, and they re-render in full on the next maintenance
 * pass — scoped to that collection, so a change to how dictionaries render never
 * drags the tafsīrs or ḥadīth along with it. Bump it only when the *rendered
 * output* changes, not for every edit.
 */
const COLLECTION_RENDER_VERSION: Record<string, number> = {};

/** The render version a work of this collection must have been rendered at. */
function requiredRenderVersion(collection: string): number {
	return COLLECTION_RENDER_VERSION[collection] ?? 0;
}
/** The schema every model was written at before per-collection tracking. */
const BASE_MODEL_SCHEMA = 1;

/** The model schema a work of this collection must have to be renderable. */
function requiredModelSchema(collection: string): number {
	return COLLECTION_MODEL_SCHEMA[collection] ?? BASE_MODEL_SCHEMA;
}

/** Tag and collection every Zotero export carries, so its origin is traceable. */
const ZOTERO_MARK = "Midad Arabic Sources";
const SOURCE_INDEX_NOTE = "Midad Arabic Sources - By Source";

/** Appended to an item whose bibliographic details are still unverified. */
const BIB_PROVISIONAL = "Bibliographic details are provisional — verify against the edition you used before citing.";

/** Which unit `kind` each per-work template renders (the scoped re-render map). */
const SOURCE_TEMPLATE_KIND: Record<string, string> = {
	source: "source",
	hadith: "hadith",
	quran: "quran",
	dictionary: "dict",
	dictionaryIndex: "dict-index",
	book: "book",
	bookVolume: "book-volume",
};

const DEFAULT_PROMPT_NAME = "Default prompt";
const PROMPT_FILES: Record<PromptKind, string> = {
	transcription: ".midad-arabic-sources/transcription-prompts.json",
	translation: ".midad-arabic-sources/translation-prompts.json",
};
const PROMPT_KIND_LABEL: Record<PromptKind, string> = {
	transcription: "transcription",
	translation: "translation",
};

const DEFAULT_SETTINGS: MidadArabicSourcesSettings = {
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
	llmBaseUrl: "",
	llmConfigs: [],
	llmAssignments: { transliteration: "", transcription: "", translation: "" },
	pythonPath: "",
	pipelineScript: "scripts/midad-arabic-sources-pipeline.py",
	geminiApiKey: "",
	sourceImportScript: "scripts/text-source-import.py",
	sourceRoot: "Midad Arabic Sources",
	sourceLayoutMigrated: false,
	sourceImportRoot: "Midad Arabic Sources/Installed Sources",
	sourceTemplateFolder: "",
	canonicalQuranRiwāya: "",
	canonicalQuranFolder: "Midad Arabic Sources/Installed Sources/Quran",
	sourceMocParent: "Midad Arabic Sources",
	annotationNoteFolder: "Midad Arabic Sources/Annotation Notes",
	annotationDefaultColor: "yellow",
	annotationTrashDays: 30,
	annotateOnSelection: true,
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

export default class MidadArabicSourcesPlugin extends Plugin {
	settings: MidadArabicSourcesSettings;
	lastUnknown: LexiconGuess[] = [];
	statusPanels: StatusPanel[] = [];
	/** Catalogue of available works, cached per session (and on disk for longer). */
	sourceCatalog: SourceWork[] | null = null;
	/** Guards the automatic Zotero sync against overlapping runs. */
	zoteroSyncRunning = false;
	zoteroSyncAgain = false;
	/** Set by the Stop button/command; checked per note by a source render. */
	sourceCancelled = false;
	/** The current source operation; a newer one invalidates the old one. */
	sourceOperationId = 0;
	sourceOperationActive = false;
	sourceOperationKind: "explicit" | "auto" | null = null;
	/** The Python process currently acquiring sources, if any. */
	activeSourceProc: ReturnType<typeof spawn> | null = null;
	/** Works whose models are being compressed by the archive command. */
	archivingSources = new Set<string>();
	/** Phase 1 annotation layer; null until startup succeeds. */
	annotations: AnnotationService | null = null;
	/** Old locations captured during the one-time source-layout migration. */
	sourceLayoutLegacy: { installedRoot: string; annotationNotes: string } | null = null;
	/** Repository MOCs generated by the last source-index refresh. */
	repositoryMocNames: string[] = [];
	repositoryMocLabels: Record<string, string> = {};
	/** Debounced refresh after a transcription/translation note changes. */
	transcriptionMocTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		// Extract the bundled templates and Python scripts into the plugin folder
		// (they ship inside main.js; see gen-assets.mjs).
		this.extractBundledAssets();
		await this.ensureSourceLayout();
		this.addSettingTab(new MidadArabicSourcesSettingTab(this.app, this));
		try {
			this.annotations = await registerAnnotations({
				app: this.app,
				plugin: this,
				settings: this.settings,
				refreshParent: () => this.refreshAnnotationParent(),
				refreshRegistry: () => this.refreshSourceRegistry(),
			});
			await this.refreshAnnotationParent();
		} catch (error) {
			console.error("[midad-arabic-sources] annotations failed to start", error);
			new Notice("The annotation layer could not start. See the developer console for details.");
		}
		await this.refreshSourceRegistry();
		await this.refreshSourcesIndex();

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
			id: "transliteration-server",
			name: "Transliteration server…",
			callback: () => { new TransliterationServerModal(this.app, this).open(); },
		});

		this.addCommand({
			id: "transcribe-item-pdfs",
			name: "Transcribe this item's PDF file(s)",
			callback: async () => { await this.openTranscribe(); },
		});

		this.addCommand({
			id: "transcribe-pdf-standalone",
			name: "Transcribe a PDF…",
			callback: async () => { await this.openStandalonePdf(); },
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
			id: "archive-this-source",
			name: "Archive this source…",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("Open a source note first.");
					return;
				}
				const work = await this.workForPath(file.path);
				if (!work) {
					new Notice("That note is not part of an imported source.");
					return;
				}
				if (this.workStatus(work) === "archived") {
					new Notice("That source is already archived.");
					return;
				}
				new ConfirmModal(this.app, {
					title: "Archive source",
					message: `Archive “${work.title || work.dir}”? Its notes will be removed, but its annotations and a compressed model are kept.`,
					confirmText: "Archive",
					onConfirm: () => { void this.archiveSourceWithProgress(work); },
				}).open();
			},
		});

		this.addCommand({
			id: "add-turath-work-by-url",
			name: "Add Turath work by URL…",
			callback: () => { new TurathUrlModal(this.app, this).open(); },
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
			id: "stop-source-operation",
			name: "Stop source import or render",
			callback: () => { this.cancelSourceOperation(); },
		});

		this.addCommand({
			id: "rerender-this-source",
			name: "Re-render this source",
			callback: async () => { await this.rerenderCurrentSource(); },
		});

		// The same, from a note's own right-click menu, so it is reachable where you
		// are looking. The item only appears for a note that belongs to a source.
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			void (async () => {
				const work = await this.workForPath(file.path);
				const archived = work ? null : archivedNoteInfo(file.path);
				if (!work && (!archived || !(file instanceof TFile) || file.extension !== "md")) return;
				menu.addItem((item) => item
					.setTitle("Re-render this source")
					.setIcon("refresh-cw")
					.onClick(() => { void this.rerenderCurrentSource(file); }));
			})();
		}));

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
			id: "migrate-source-naming",
			name: "Migrate imported sources to the current naming scheme",
			callback: async () => { await this.migrateSourceNaming(); },
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

		this.addCommand({
			id: "open-documentation",
			name: "Open documentation",
			callback: () => { openDocs(this.app); },
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
		const watchTranscription = (file: TAbstractFile): void => {
			if (this.transcriptionNotePath(file.path)) this.scheduleTranscriptionMocRefresh();
		};
		this.registerEvent(this.app.vault.on("create", watchTranscription));
		this.registerEvent(this.app.vault.on("modify", watchTranscription));
		this.registerEvent(this.app.vault.on("delete", watchTranscription));
		this.registerEvent(this.app.vault.on("rename", watchTranscription));
	}

	onunload(): void {
		if (this.transcriptionMocTimer !== null) window.clearTimeout(this.transcriptionMocTimer);
		this.annotations?.dispose();
		// Invalidate this instance's source operation before a re-enable creates a
		// new one: the old render loop checks the generation per note, and the
		// importer subprocess is killed, so two instances cannot write together.
		this.sourceCancelled = true;
		this.sourceOperationId += 1;
		this.sourceOperationActive = false;
		this.sourceOperationKind = null;
		try { this.activeSourceProc?.kill("SIGTERM"); } catch { /* already gone */ }
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

	sourcesRoot(): string {
		return resolveSourceRoot(this.settings);
	}

	installedSourcesRoot(): string {
		return resolveInstalledSourcesRoot(this.settings);
	}

	transcriptionsFolder(): string {
		return resolveTranscriptionsFolder(this.settings);
	}

	translationsFolder(): string {
		return resolveTranslationsFolder(this.settings);
	}

	canonicalQuranFolder(): string {
		return resolveCanonicalQuranFolder(this.settings);
	}

	sourceNotePath(name: string): string {
		return resolveSourceNotePath(this.settings, name);
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
			if (asset.extract === false) continue;
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

	serverPythonPromise: Promise<string> | null = null;

	/**
	 * The interpreter that can import CAMeL, for the transliteration server. It is
	 * resolved the same way as the pipeline's Python (ScholarWeft's `findPython3`:
	 * configured path, then PATH, then the installer venv, conda/anaconda, pyenv,
	 * Homebrew, distro), but probed on `camel_tools` rather than the PDF deps.
	 */
	resolveServerPython(): Promise<string> {
		const configured = this.settings.pythonPath ?? "";
		if (configured.trim()) return Promise.resolve(configured.trim());
		if (this.serverPythonPromise == null) {
			this.serverPythonPromise = findPython3("", ["camel_tools"])
				.then((p) => p ?? this.resolvePython());
		}
		return this.serverPythonPromise;
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

	/** The configuration selected for a task, falling back to a sensible first. */
	llmConfigForTask(task: LlmTask): LlmConfig | null {
		const configs = this.settings.llmConfigs ?? [];
		const assigned = this.settings.llmAssignments?.[task] ?? "";
		const selected = configs.find((c) =>
			c.id === assigned && (task === "transliteration" || c.provider === "gemini")
		);
		if (selected) return selected;
		const eligible = task === "transliteration"
			? configs
			: configs.filter((c) => c.provider === "gemini");
		return eligible[0] ?? null;
	}

	llmModelForTask(task: LlmTask): string {
		return this.llmConfigForTask(task)?.model ?? "";
	}

	llmApiKeyForTask(task: LlmTask): string {
		const config = this.llmConfigForTask(task);
		return config?.provider === "gemini" ? config.apiKey : "";
	}

	/** Create/replace assignments and migrate the old single-configuration fields. */
	async ensureLlmSettings(): Promise<void> {
		const providerName = (provider: LlmProvider) =>
			provider === "deepseek" ? "DeepSeek" : provider === "openai" ? "OpenAI-compatible" : "Gemini";
		const configs: LlmConfig[] = [];
		const seen = new Set<string>();
		for (const raw of Array.isArray(this.settings.llmConfigs) ? this.settings.llmConfigs : []) {
			if (!raw || typeof raw !== "object") continue;
			const provider: LlmProvider =
				raw.provider === "deepseek" || raw.provider === "openai" ? raw.provider : "gemini";
			let id = String(raw.id ?? "").trim() || `llm-${configs.length + 1}`;
			while (seen.has(id)) id = `${id}-2`;
			seen.add(id);
			const fallbackModel = provider === "deepseek" ? "deepseek-chat" : provider === "openai" ? "gpt-4o-mini" : "gemini-3.5-flash-lite";
			configs.push({
				id,
				name: String(raw.name ?? "").trim() || `${providerName(provider)} configuration ${configs.length + 1}`,
				provider,
				model: String(raw.model ?? "").trim() || fallbackModel,
				apiKey: String(raw.apiKey ?? "").trim(),
				baseUrl: String(raw.baseUrl ?? "").trim(),
			});
		}

		let changed = configs.length === 0;
		if (!configs.length) {
			const legacyProvider: LlmProvider =
				this.settings.llmProvider === "deepseek" || this.settings.llmProvider === "openai"
					? this.settings.llmProvider
					: "gemini";
			const legacyModel = (this.settings.llmModel || "gemini-3.5-flash-lite").trim();
			const mainKey = (this.settings.geminiApiKey || "").trim();
			const legacyKey = (this.settings.llmApiKey || "").trim();
			const mainId = "llm-gemini";
			const main: LlmConfig = {
				id: mainId,
				name: "Gemini 3.5 Flash Lite",
				provider: "gemini",
				model: "gemini-3.5-flash-lite",
				apiKey: mainKey || (legacyProvider === "gemini" ? legacyKey : ""),
				baseUrl: "",
			};
			configs.push(main);
			let transliteration = mainId;
			if (
				legacyProvider !== "gemini"
				|| (legacyKey && legacyKey !== main.apiKey)
				|| legacyModel !== "gemini-3.5-flash-lite"
				|| (this.settings.llmBaseUrl || "").trim()
			) {
				transliteration = "llm-transliteration";
				configs.push({
					id: transliteration,
					name: legacyProvider === "gemini" && legacyModel === "gemini-3.5-flash-lite"
						? "Gemini 3.5 Flash Lite (transliteration)"
						: `${providerName(legacyProvider)} ${legacyModel}`,
					provider: legacyProvider,
					model: legacyModel,
					apiKey: legacyKey,
					baseUrl: (this.settings.llmBaseUrl || "").trim(),
				});
			}
			this.settings.llmAssignments = {
				transliteration,
				transcription: mainId,
				translation: mainId,
			};
		}

		const assignments = {
			...(this.settings.llmAssignments ?? {
				transliteration: "",
				transcription: "",
				translation: "",
			}),
		};
		for (const task of ["transliteration", "transcription", "translation"] as LlmTask[]) {
			const eligible = task === "transliteration"
				? configs
				: configs.filter((c) => c.provider === "gemini");
			const current = assignments[task];
			if (!eligible.some((c) => c.id === current)) {
				assignments[task] = eligible[0]?.id ?? "";
				changed = true;
			}
		}

		this.settings.llmConfigs = configs;
		this.settings.llmAssignments = assignments;
		if (changed) await this.saveSettings();
	}

	/** True when a Gemini key is available for a task (plugin config or inherited env). */
	apiKeyAvailable(task: LlmTask = "transcription"): boolean {
		const config = this.llmConfigForTask(task);
		if (config?.provider === "gemini" && config.apiKey) return true;
		return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
	}

	async ensureSourceLayout(): Promise<void> {
		if (this.settings.sourceLayoutMigrated) return;
		const legacy = this.sourceLayoutLegacy;
		if (!legacy) {
			this.settings.sourceLayoutMigrated = true;
			await this.saveSettings();
			return;
		}
		const args = [
			"--source-root", this.sourcesRoot(),
			"--old-installed-root", legacy.installedRoot,
			"--old-annotation-notes", legacy.annotationNotes,
		];
		const { code, lines } = await this.runScript("migrate-source-layout.py", args, () => {});
		if (code === 0) {
			this.settings.sourceImportRoot = normalizePath(`${this.sourcesRoot()}/Installed Sources`);
			this.settings.annotationNoteFolder = normalizePath(`${this.sourcesRoot()}/Annotation Notes`);
			this.settings.canonicalQuranFolder = normalizePath(`${this.settings.sourceImportRoot}/Quran`);
			this.settings.sourceLayoutMigrated = true;
			this.sourceLayoutLegacy = null;
			await this.saveSettings();
			new Notice("Midad Arabic Sources: source folders reorganized.");
		} else {
			console.error("[midad-arabic-sources] source-layout migration", lines);
			new Notice("Midad Arabic Sources could not reorganize its folders — see the developer console.");
		}
	}

	/** Move every plugin-owned folder to a new source root. */
	async moveSourceRoot(newRoot: string): Promise<void> {
		const root = normalizePath(newRoot.trim() || "Midad Arabic Sources");
		if (root === this.sourcesRoot()) {
			this.settings.sourceRoot = root;
			await this.saveSettings();
			return;
		}
		const args = [
			"--source-root", root,
			"--old-source-root", this.sourcesRoot(),
			"--old-installed-root", this.installedSourcesRoot(),
			"--old-transcriptions", this.transcriptionsFolder(),
			"--old-translations", this.translationsFolder(),
			"--old-annotation-notes", this.settings.annotationNoteFolder,
		];
		const { code, lines } = await this.runScript("migrate-source-layout.py", args, () => {});
		if (code !== 0) {
			console.error("[midad-arabic-sources] source-root move", lines);
			new Notice("Midad Arabic Sources could not move its folders — see the developer console.");
			return;
		}
		this.settings.sourceRoot = root;
		this.settings.sourceImportRoot = normalizePath(`${root}/Installed Sources`);
		this.settings.annotationNoteFolder = normalizePath(`${root}/Annotation Notes`);
		this.settings.canonicalQuranFolder = normalizePath(`${root}/Installed Sources/Quran`);
		this.settings.sourceLayoutMigrated = true;
		await this.saveSettings();
		new Notice(`Midad Arabic Sources: moved plugin folders to ${root}.`);
	}

	async refreshSourceRegistry(): Promise<void> {
		try {
			const registry = await buildSourceRegistry(this.app, {
				installedRoot: this.installedSourcesRoot(),
				transcriptions: this.transcriptionsFolder(),
				translations: this.translationsFolder(),
				manifest: ".midad-arabic-sources/source-imports.json",
				adopted: ".midad-arabic-sources/annotations/adopted.json",
			});
			await writeSourceRegistry(this.app, registry);
		} catch (error) {
			console.error("[midad-arabic-sources] source registry", error);
		}
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
	ensureApiKey(task: LlmTask = "transcription"): boolean {
		const config = this.llmConfigForTask(task);
		if (config && config.provider !== "gemini") {
			new Notice(`Choose a Gemini configuration for ${task} in Settings → Midad Arabic Sources → LLM.`);
			return false;
		}
		if (this.apiKeyAvailable(task)) return true;
		new ApiKeyModal(this.app, this, task).open();
		return false;
	}

	/** Citekey and path for the active note (works from @citekey or a transcription/translation note). */
	activeItem(): { citekey: string; path: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;
		const base = view.file.basename;
		if (!base.startsWith("@") && !base.startsWith("mas-")) return null;
		const citekey = base.replace(/^(?:@|mas-)/, "").split(" - ")[0];
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
			const task: LlmTask | null = args[0] === "transcribe"
				? "transcription"
				: args[0] === "translate"
					? "translation"
					: args[0] === "resume" ? "transcription" : null;
			const taskKey = task ? this.llmApiKeyForTask(task) : "";
			const proc = spawn(python, [script, ...args], {
				cwd: vault,
				env: {
					...process.env,
					OBSIDIAN_VAULT: vault,
					PYTHONUNBUFFERED: "1",
					MIDAD_SOURCES_ROOT: this.sourcesRoot(),
					MIDAD_INSTALLED_ROOT: this.installedSourcesRoot(),
					MIDAD_TRANSCRIPTIONS_DIR: this.transcriptionsFolder(),
					MIDAD_TRANSLATIONS_DIR: this.translationsFolder(),
					MIDAD_CANONICAL_QURAN_DIR: this.canonicalQuranFolder(),
					...(taskKey ? { GEMINI_API_KEY: taskKey } : {}),
				},
			});
			// Only the source importer is a cancellable source operation; a
			// transcription/translation job must not be killed by a source stop.
			const isSourceScript = scriptRel === this.settings.sourceImportScript
				|| /text-source-import\.py$/.test(scriptRel);
			if (isSourceScript) this.activeSourceProc = proc;
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
			proc.on("close", (code: number) => {
				if (this.activeSourceProc === proc) this.activeSourceProc = null;
				resolve({ code: code ?? 0, lines });
			});
			proc.on("error", (e: Error) => {
				if (this.activeSourceProc === proc) this.activeSourceProc = null;
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

	/**
	 * Start a source operation. If one is still running, invalidate it first: the
	 * old loops check their generation before every note and stop, so a plugin
	 * update or a new install never leaves two renders writing the same notes.
	 */
	beginSourceOperation(kind: "explicit" | "auto" = "explicit"): number | null {
		if (this.sourceOperationActive) {
			// A background pass must not interrupt something the user started;
			// it will simply run on its next cadence. A new explicit operation,
			// or another automatic pass, supersedes the old one.
			if (kind === "auto" && this.sourceOperationKind === "explicit") return null;
			this.cancelSourceOperation();
		}
		this.sourceCancelled = false;
		this.sourceOperationId += 1;
		this.sourceOperationActive = true;
		this.sourceOperationKind = kind;
		return this.sourceOperationId;
	}

	/** Whether the operation `id` has been stopped or superseded. */
	isSourceCancelled(id: number): boolean {
		return this.sourceCancelled || id !== this.sourceOperationId;
	}

	/** Release an operation only if it is still the current one. */
	endSourceOperation(id: number): void {
		if (id === this.sourceOperationId) {
			this.sourceOperationActive = false;
			this.sourceOperationKind = null;
		}
	}

	/**
	 * Stop the current source import/render. The render loop checks the flag
	 * before every note, and a running acquisition subprocess is killed; the
	 * work is left uninstalled, so installing again resumes from the model.
	 */
	cancelSourceOperation(): void {
		this.sourceCancelled = true;
		this.sourceOperationId += 1;   // supersede the running operation
		this.sourceOperationActive = false;
		this.sourceOperationKind = null;
		try { this.activeSourceProc?.kill("SIGTERM"); } catch { /* already gone */ }
		new Notice("Stopping source operation…");
	}

	async runWithProgress(title: string, args: string[], scriptRel?: string): Promise<PipelineResult> {
		// Clear finished panels so only the current job(s) stay visible.
		for (const p of this.statusPanels.filter((x) => x.state !== "running")) p.destroy();
		this.statusPanels = this.statusPanels.filter((p) => p.state === "running");
		const panel = new StatusPanel(this.app, title);
		this.statusPanels.push(panel);

		const logPath = this.jobPath(title, "log");
		const statePath = this.jobPath(title, "json");
		const task: LlmTask | null = args[0] === "transcribe"
			? "transcription"
			: args[0] === "translate" ? "translation" : null;
		const config = task ? this.llmConfigForTask(task) : null;
		const fullArgs = [...args];
		if (task && config?.provider === "gemini" && config.model) {
			fullArgs.push("--model", config.model);
		}
		if (args[0] === "transcribe") fullArgs.push("--log", logPath, "--state", statePath);

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

	/** Built-in prompt text, fetched once per session. */
	promptDefaults: Record<PromptKind, string> | null = null;

	/** Ask the pipeline for the built-in prompts (single source: midad_prompts.py). */
	async loadDefaultPrompts(): Promise<Record<PromptKind, string> | null> {
		if (this.promptDefaults) return this.promptDefaults;
		const result = await this.pipelineResult(["default-prompts"]);
		const transcription = typeof result?.transcription === "string" ? result.transcription : "";
		const translation = typeof result?.translation === "string" ? result.translation : "";
		if (!transcription || !translation) return null;
		this.promptDefaults = { transcription, translation };
		return this.promptDefaults;
	}

	promptPath(kind: PromptKind): string {
		return normalizePath(PROMPT_FILES[kind]);
	}

	async savePromptSet(kind: PromptKind, prompts: PromptEntry[]): Promise<void> {
		const dir = normalizePath(".midad-arabic-sources");
		try {
			if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
		} catch { /* the pipeline may already have created it */ }
		const data: PromptFile = { version: 1, prompts };
		await this.app.vault.adapter.write(this.promptPath(kind), JSON.stringify(data, null, 2) + "\n");
	}

	/**
	 * Read a prompt list, seeding it from the built-in default on first use. An
	 * unmodified built-in default is refreshed from midad_prompts.py, so a plugin
	 * update can improve it without overwriting a user's edits.
	 */
	async loadPromptSet(kind: PromptKind): Promise<PromptEntry[]> {
		const path = this.promptPath(kind);
		let prompts: PromptEntry[] = [];
		let fileExists = false;
		try {
			fileExists = await this.app.vault.adapter.exists(path);
			if (fileExists) {
				const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as PromptFile;
				if (Array.isArray(parsed?.prompts)) {
					prompts = parsed.prompts
						.filter((p): p is PromptEntry => !!p && typeof p.name === "string" && typeof p.text === "string")
						.map((p) => ({ ...p }));
				}
			}
		} catch (e) {
			console.error("[midad-arabic-sources] prompt file", kind, e);
			new Notice(`Could not read the ${PROMPT_KIND_LABEL[kind]} prompts file; it will be recreated.`);
			prompts = [];
		}

		// Keep dropdown values unique and ignore blank entries.
		const seen = new Set<string>();
		prompts = prompts.filter((p) => {
			const name = p.name.trim();
			if (!name || seen.has(name)) return false;
			seen.add(name);
			return true;
		});

		const builtin = prompts.find((p) => p.builtin);
		const needDefaults = !builtin || !builtin.modified;
		const defaults = needDefaults ? await this.loadDefaultPrompts() : null;
		const defaultText = defaults?.[kind] ?? "";
		let changed = !fileExists;

		if (!builtin) {
			if (!defaultText) throw new Error(`Could not load the built-in ${PROMPT_KIND_LABEL[kind]} prompt.`);
			prompts.unshift({ name: DEFAULT_PROMPT_NAME, text: defaultText, builtin: true });
			changed = true;
		} else if (defaultText && !builtin.modified && builtin.text !== defaultText) {
			builtin.text = defaultText;
			changed = true;
		}
		const defaultEntry = prompts.find((p) => p.builtin);
		if (defaultEntry && !defaultEntry.text.trim() && !defaultText) {
			throw new Error(`Could not load the built-in ${PROMPT_KIND_LABEL[kind]} prompt.`);
		}
		if (defaultEntry && defaultEntry.name !== DEFAULT_PROMPT_NAME) {
			defaultEntry.name = DEFAULT_PROMPT_NAME;
			changed = true;
		}

		if (changed) await this.savePromptSet(kind, prompts);
		return prompts;
	}

	/** Write the chosen prompt where the pipeline's submit script can read it. */
	writePromptFile(kind: PromptKind, text: string): string | null {
		try {
			const path = this.jobPath(`Prompt ${PROMPT_KIND_LABEL[kind]}`, "txt");
			fs.writeFileSync(path, text, "utf8");
			return path;
		} catch (e) {
			console.error("[midad-arabic-sources] prompt file", kind, e);
			new Notice("Could not write the prompt file — see the developer console.");
			return null;
		}
	}

	async openTranscribe() {
		const item = this.activeItem();
		if (!item) { new Notice("Open a literature note (@citekey) first."); return; }
		if (!this.ensureApiKey("transcription")) return;
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
		let prompts: PromptEntry[];
		try {
			prompts = await this.loadPromptSet("transcription");
		} catch (e) {
			console.error("[midad-arabic-sources] transcription prompts", e);
			new Notice("Could not load the transcription prompts — see the developer console.");
			return;
		}
		new TranscribeModal(this.app, this, item.citekey, pdfs, prompts).open();
	}

	/** Transcribe any PDF the user chooses, without a Zotero/literature note. */
	async openStandalonePdf() {
		if (!this.ensureApiKey("transcription")) return;
		let prompts: PromptEntry[];
		try {
			prompts = await this.loadPromptSet("transcription");
		} catch (e) {
			console.error("[midad-arabic-sources] transcription prompts", e);
			new Notice("Could not load the transcription prompts — see the developer console.");
			return;
		}
		new StandalonePdfModal(this.app, this, prompts).open();
	}

	async openTranslate() {
		const item = this.activeItem();
		if (!item) { new Notice("Open a literature note (@citekey) first."); return; }
		if (!this.ensureApiKey("translation")) return;
		const notes = ((await this.pipelineResult(["list-transcriptions", item.path]))?.notes ?? []) as unknown as PipelineNote[];
		const pdfs = (await this.pipelineResult(["list-pdfs", item.path]))?.pdfs ?? [];
		let prompts: PromptEntry[];
		try {
			prompts = await this.loadPromptSet("translation");
		} catch (e) {
			console.error("[midad-arabic-sources] translation prompts", e);
			new Notice("Could not load the translation prompts — see the developer console.");
			return;
		}
		new TranslateModal(this.app, this, item.citekey, notes, pdfs, prompts).open();
	}

	async openReprocess() {
		const zips = (await this.pipelineResult(["list-archive"]))?.zips ?? [];
		new ReprocessModal(this.app, this, zips).open();
	}

	/** Ask the importer script for its catalogue of available works. */
	async listSources(freshDirs = false): Promise<SourceWork[]> {
		let works: SourceWork[] = [];
		const args = ["list", "--json", ...(freshDirs ? ["--fresh-dirs"] : [])];
		const { code, lines } = await this.runScript(this.settings.sourceImportScript, args, (ev) => {
			if (ev.event === "works") works = ev.works as SourceWork[];
		});
		if (!works.length) console.error("[midad-arabic-sources] source list", { code, lines });
		return works;
	}

	// ── User-added Turath works (a URL list) ─────────────────────────────────

	customWorksPath(): string {
		return normalizePath(".midad-arabic-sources/turath-custom-works.json");
	}

	/** A cheap stamp for the custom-work list, used to invalidate the catalogue. */
	async customWorksStamp(): Promise<number> {
		try {
			if (await this.app.vault.adapter.exists(this.customWorksPath())) {
				return (await this.app.vault.adapter.stat(this.customWorksPath()))?.mtime ?? 0;
			}
		} catch { /* no custom list yet */ }
		return 0;
	}

	async loadCustomWorks(): Promise<TurathCustomWork[]> {
		try {
			const text = await this.app.vault.adapter.read(this.customWorksPath());
			const data = JSON.parse(text) as TurathCustomWork[] | { works?: TurathCustomWork[] };
			const rows = Array.isArray(data) ? data : data.works;
			return Array.isArray(rows) ? rows.filter((w) => w && w.id) : [];
		} catch {
			return [];
		}
	}

	async saveCustomWorks(works: TurathCustomWork[]): Promise<void> {
		await this.app.vault.adapter.write(this.customWorksPath(), JSON.stringify({ works }, null, 2));
		this.sourceCatalog = null; // the catalogue now differs
		// Remove the on-disk catalogue too; otherwise a reopened Manage modal serves
		// the old titles/author until its TTL expires.
		try {
			const catalogPath = normalizePath(".midad-arabic-sources/source-catalog.json");
			if (await this.app.vault.adapter.exists(catalogPath)) await this.app.vault.adapter.remove(catalogPath);
		} catch { /* next list will rebuild it */ }
	}

	/** The numeric id from a Turath URL, or from a bare id; '' if neither. */
	parseTurathId(input: string): string {
		const text = String(input || "").trim();
		const m = text.match(/\/book\/(\d+)/i) || text.match(/^(\d+)$/);
		return m ? m[1] : "";
	}

	/** Fetch a book's metadata and add it to the user's list. */
	/** Ask the resident server to romanize a title or name (best effort). */
	async romanizeName(text: string): Promise<string> {
		const value = String(text || "").trim();
		if (!value) return "";
		try {
			const res = await requestUrl({
				url: this.baseUrl() + "/transliterate",
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ text: value, engine: "bert", name: true, standalone: true, citation: true }),
			});
			const out = (res.json as { romanized?: string })?.romanized;
			return typeof out === "string" ? out.trim() : "";
		} catch {
			return "";
		}
	}

	/** Read a book's metadata and build a provisional entry (not saved yet). */
	async previewTurathWork(input: string): Promise<TurathCustomWork | null> {
		const id = this.parseTurathId(input);
		if (!id) {
			new Notice("Paste a Turath book URL (or its numeric ID).");
			return null;
		}
		let meta: { name?: string; info?: string; cat_id?: number } | undefined;
		try {
			const res = await requestUrl({ url: `https://api.turath.io/book?id=${id}&include=indexes&ver=3`, method: "GET" });
			meta = (res.json as { meta?: { name?: string; info?: string; cat_id?: number } })?.meta;
		} catch (e) {
			new Notice(`Could not fetch Turath book ${id}: ${e instanceof Error ? e.message : e}`);
			return null;
		}
		if (!meta?.name) {
			new Notice(`Turath book ${id} was not found (or has no metadata).`);
			return null;
		}
		const cat = Number(meta.cat_id ?? 0);
		const type = TURATH_CAT_TYPES[cat] ?? "other";
		const authorAr = this.authorFromInfo(meta.info);
		const [titleRoman, authorRoman] = await Promise.all([
			this.romanizeName(meta.name),
			this.romanizeName(authorAr),
		]);
		return {
			id,
			title: titleRoman ? sentenceCaseTitle(titleRoman) : meta.name,
			arabic: meta.name,
			author: authorRoman || authorAr,
			type,
			genres: genresForCat(cat, type),
			url: `https://app.turath.io/book/${id}`,
		};
	}

	async saveTurathWork(work: TurathCustomWork): Promise<void> {
		const list = await this.loadCustomWorks();
		const i = list.findIndex((w) => String(w.id) === work.id);
		if (i >= 0) list[i] = work;
		else list.push(work);
		await this.saveCustomWorks(list);
		new Notice(`Added “${work.title}”. Select it under Install/uninstall sources, then Apply.`);
	}

	async removeTurathWork(id: string): Promise<void> {
		await this.saveCustomWorks((await this.loadCustomWorks()).filter((w) => String(w.id) !== String(id)));
	}

	/** The author line from Turath's `info` (`المؤلف: …`), without the dates. */
	authorFromInfo(info: string | undefined): string {
		const m = String(info || "").match(/(?:المؤلف|تأليف)\s*[:：]\s*(.+)/);
		if (!m) return "";
		return m[1].replace(/\s*\(ت.*$/, "").trim().replace(/^[-–—\s]+|[-–—\s]+$/g, "");
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
		let cached: { at?: number; schema?: number; customAt?: number; works?: SourceWork[] } | null = null;
		try {
			cached = JSON.parse(await this.app.vault.adapter.read(path)) as { at?: number; schema?: number; works?: SourceWork[] };
		} catch { /* no usable cache */ }
		const works0 = cached?.works;
		const customAt = await this.customWorksStamp();
		const usable = Array.isArray(works0) && works0.length > 0 && cached?.schema === SOURCE_CATALOG_SCHEMA &&
			(cached?.customAt ?? 0) === customAt;
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
				await this.app.vault.adapter.write(path, JSON.stringify({ at: Date.now(), schema: SOURCE_CATALOG_SCHEMA, customAt, works }));
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
					JSON.stringify({ at: Date.now(), schema: SOURCE_CATALOG_SCHEMA, customAt: await this.customWorksStamp(), works })
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
		const outRoot = this.installedSourcesRoot();
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
	 * `note` plus the provisional caveat — combined into the single `midad-note`
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
		const outRoot = this.installedSourcesRoot();
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
		console.debug("[midad-arabic-sources] zotero", method, url, "→", status);
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

	/** Add `midad-up: [[@citekey]]` to the work note for any item Better BibTeX has keyed. */
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

	/** Prepend `- "[[@citekey]]"` under the work note's `midad-up:` list, once. */
	async addCitekeyUp(work: JsonObject, citekey: string): Promise<void> {
		const outRoot = this.installedSourcesRoot();
		const hub = normalizePath(`${outRoot}/${work.dir}.md`);
		try {
			const text = await this.app.vault.adapter.read(hub);
			if (text.includes(`[[@${citekey}]]`)) return;
			const next = text.replace(/^(midad-up:\n(?: {2}- .+\n)+)/m, (m) => `${m}  - "[[@${citekey}]]"\n`);
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
		const path = normalizePath(`${this.sourcesRoot()}/zotero-export.csl.json`);
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

	async openManageSources(
		force = false,
		showFilter?: "all" | "installed" | "not-installed" | "archived" | "annotated",
		initialMode: "manage" | "zotero" | "url" = "manage"
	) {
		const loading = new Notice("Loading available sources…", 0);
		try {
			const works = [...await this.listSourcesCached(force)];
			if (!works.length) {
				new Notice("No sources found. Is Python configured and the importer script present?");
				return;
			}
			const manifest = await this.loadSourceManifest();
			// Never hide an installed work just because its catalogue entry vanished
			// (for example a custom-only Turath work whose list entry was removed).
			// Showing it lets the user remove the source from the main list.
			const catalogueKeys = new Set(works.map((w) => this.workKey(w)));
			for (const w of manifest) {
				if (this.workStatus(w) === "deleting") continue;
				if (catalogueKeys.has(this.workKey(w))) continue;
				works.push(w as unknown as SourceWork);
			}
			const statusKeys = (status: "installed" | "deleting") =>
				new Set(manifest.filter((w) => this.workStatus(w) === status).map((w) => this.workKey(w)));
			const archivedKeys = new Set(manifest.filter((w) => w.status === "archived").map((w) => this.workKey(w)));
			const installedKeys = new Set(
				manifest.filter((w) => w.status !== "archived" && this.workStatus(w) === "installed").map((w) => this.workKey(w))
			);
			for (const key of this.archivingSources) installedKeys.delete(key);
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
				this.app, this, works, installedKeys, statusKeys("deleting"), archivedKeys, sizes, zoteroStatus,
				() => { void this.openManageSources(true); }, new Set(this.archivingSources), showFilter, initialMode
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
	async removeSource(work: JsonObject, onProgress?: (done: number, total: number) => void): Promise<boolean> {
		const outRoot = this.installedSourcesRoot();
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
				try {
					const archive = this.sourceArchivePath(work);
					if (fs.existsSync(archive)) fs.unlinkSync(archive);
				} catch { /* leave a stale archive rather than failing the removal */ }
			}

			// Refresh only the MOCs and parent note; never re-render the removed
			// work. It is still flagged, so it drops out of the sources list now.
			await this.refreshSourcesIndex();
			// Annotations outlive the source text: keep the store and annotation
			// note, and mark the note's source-status as removed.
			try {
				await this.annotations?.onSourceRemoved(key);
			} catch (e) {
				console.error("[midad-arabic-sources] annotation status after removal", e);
			}
		} catch (e) {
			// Leave the entry flagged "deleting": the next maintenance run retries.
			problems.push(e instanceof Error ? e.message : String(e));
			console.error("[midad-arabic-sources] removeSource", key, e);
		}

		if (problems.length) {
			console.error("[midad-arabic-sources] removeSource", key, problems);
			new Notice(`Removed “${work.title || dir}” with problems: ${problems.join("; ")}`);
			return false;
		}
		return true;
	}

	/** The gzipped model that backs an archived work. */
	sourceArchivePath(work: JsonObject): string {
		const collection = String(work.collection ?? "work").replace(/[^\w.-]+/g, "_");
		const id = String(work.id ?? "work").replace(/[^\w.-]+/g, "_");
		return `${this.vaultPath()}/.midad-arabic-sources/source-archives/${collection}/${id}.json.gz`;
	}

	/** Remove a work's rendered notes, returning any per-file errors. */
	async deleteRenderedNotes(work: JsonObject, model?: SourceModel): Promise<string[]> {
		const outRoot = this.installedSourcesRoot();
		const dir = String(work.dir ?? "");
		const adapter = this.app.vault.adapter;
		const problems: string[] = [];
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		const canonicalId = this.resolveCanonicalQuran();
		const paths = model
			? expectedNotePaths(model, outRoot, canonicalRoot, canonicalId)
			: [`${outRoot}/${dir}.md`];
		for (const path of paths) {
			try {
				const rel = normalizePath(path);
				if (await adapter.exists(rel)) await adapter.remove(rel);
			} catch (e) {
				problems.push(`${path}: ${e instanceof Error ? e.message : e}`);
			}
		}
		// Clean the work folder, including any old-style names the model no longer
		// lists. Canonical Qur'ān notes live outside it and were removed by path.
		const folder = normalizePath(`${outRoot}/${dir}`);
		try {
			if (await adapter.exists(folder)) {
				for (const file of await this.listFilesUnder(folder)) {
					try {
						await adapter.remove(file);
					} catch (e) {
						problems.push(`${file}: ${e instanceof Error ? e.message : e}`);
					}
				}
				await adapter.rmdir(folder, true);
			}
		} catch (e) {
			problems.push(`folder: ${e instanceof Error ? e.message : e}`);
		}
		return problems;
	}

	/**
	 * Compress a work's model and remove its rendered notes. The manifest keeps
	 * the work as `archived`, so maintenance leaves it alone and the Manage filter
	 * can offer it for restore. Annotations are deliberately untouched.
	 */
	async archiveSourceWithProgress(work: JsonObject): Promise<boolean> {
		const key = this.workKey(work);
		this.archivingSources.add(key);
		const progress = new Notice(`Archiving “${work.title || work.dir}”…`, 0);
		try {
			return await this.archiveSource(work);
		} catch (e) {
			console.error("[midad-arabic-sources] archive", key, e);
			new Notice(`Could not archive the source: ${e instanceof Error ? e.message : e}`);
			return false;
		} finally {
			this.archivingSources.delete(key);
			progress.hide();
		}
	}

	async archiveSource(work: JsonObject): Promise<boolean> {
		if (this.sourceOperationActive) {
			new Notice("Wait for the current source operation to finish before archiving.");
			return false;
		}
		const key = this.workKey(work);
		if (this.workStatus(work) === "archived") {
			new Notice("That source is already archived.");
			return false;
		}
		const modelAbs = `${this.vaultPath()}/.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`;
		if (!fs.existsSync(modelAbs)) {
			new Notice("That source has no cached model to archive.");
			return false;
		}
		const archive = this.sourceArchivePath(work);
		let model: SourceModel;
		try {
			const text = fs.readFileSync(modelAbs, "utf8");
			model = JSON.parse(text) as SourceModel;
			fs.mkdirSync(archive.slice(0, archive.lastIndexOf("/")), { recursive: true });
			fs.writeFileSync(archive, zlib.gzipSync(Buffer.from(text, "utf8")));
		} catch (e) {
			new Notice(`Could not archive the source: ${e instanceof Error ? e.message : e}`);
			return false;
		}
		await this.setWorkStatus(key, "archived");
		const problems = await this.deleteRenderedNotes(work, model);
		try {
			fs.unlinkSync(modelAbs);
		} catch (e) {
			problems.push(`model: ${e instanceof Error ? e.message : e}`);
		}
		await this.refreshSourcesIndex();
		try {
			await this.annotations?.onSourceArchived(key);
		} catch (e) {
			console.error("[midad-arabic-sources] annotation status after archive", e);
		}
		new Notice(
			problems.length
				? `Archived “${work.title || work.dir}” with problems: ${problems.join("; ")}`
				: `Archived “${work.title || work.dir}”.`
		);
		return true;
	}

	/** Expand an archived model, render its notes, and mark it installed again. */
	async restoreArchivedSource(work: JsonObject): Promise<boolean> {
		if (this.sourceOperationActive) {
			new Notice("Wait for the current source operation to finish before restoring.");
			return false;
		}
		const key = this.workKey(work);
		const archive = this.sourceArchivePath(work);
		if (!fs.existsSync(archive)) {
			new Notice("No archive was found for that source.");
			return false;
		}
		const modelRel = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
		const modelAbs = `${this.vaultPath()}/${modelRel}`;
		try {
			const text = zlib.gunzipSync(fs.readFileSync(archive)).toString("utf8");
			JSON.parse(text);
			fs.mkdirSync(modelAbs.slice(0, modelAbs.lastIndexOf("/")), { recursive: true });
			fs.writeFileSync(modelAbs, text);
		} catch (e) {
			new Notice(`Could not restore the archive: ${e instanceof Error ? e.message : e}`);
			return false;
		}
		await this.renderWithProgress([modelAbs], true, `Restoring ${work.title || work.dir}`);
		const outRoot = this.installedSourcesRoot();
		const hub = normalizePath(`${outRoot}/${work.dir}.md`);
		if (!this.app.vault.getAbstractFileByPath(hub)) {
			new Notice("The archive was extracted, but its notes could not be rendered. It remains archived.");
			return false;
		}
		await this.setWorkStatus(key, "installed");
		await this.refreshSourcesIndex();
		try {
			await this.annotations?.onSourceRestored(key);
		} catch (e) {
			console.error("[midad-arabic-sources] annotation status after restore", e);
		}
		try { fs.unlinkSync(archive); } catch { /* keep the backup if it cannot be removed */ }
		new Notice(`Restored “${work.title || work.dir}”.`);
		return true;
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
		const outRoot = this.installedSourcesRoot();
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
		const outRoot = this.installedSourcesRoot();
		const dir = String(work.dir ?? "");
		const title = String(work.title ?? "");
		const key = this.workKey(work);
		if (!dir || !title || !key || dir === title) return;
		const adapter = this.app.vault.adapter;
		const hub = normalizePath(`${outRoot}/${title}.md`);
		try {
			if (!(await adapter.exists(hub))) return;
			const content = await adapter.read(hub);
			if (!content.includes("text-source")) return;
			// Only prune a folder this work used to own. Two editions can share a
			// `title`, so a same-named hub may belong to another work.
			const yamlKey = sourceIdToYaml(key);
			if (!content.includes(`midad-key: ${yamlKey}`) && !content.includes(`midad-key: "${yamlKey}"`) && !content.includes(`midad-key: ${key}`) && !content.includes(`midad-key: "${key}"`)) return;
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
	/** Rename the old “Midad Sources” index to its unambiguous name. */
	async renameLegacySourceIndex(): Promise<void> {
		const legacy = this.sourceNotePath("Midad Sources");
		const canonical = this.sourceNotePath(SOURCE_INDEX_NOTE);
		const old = this.app.vault.getAbstractFileByPath(legacy);
		if (old instanceof TFile && !this.app.vault.getAbstractFileByPath(canonical)) {
			try {
				await this.app.fileManager.renameFile(old, canonical);
			} catch (error) {
				console.error("[midad-arabic-sources] source index rename", error);
			}
		}
	}

	async refreshSourcesIndex(): Promise<string[]> {
		await this.renameLegacySourceIndex();
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch {
			return [];
		}
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
		const today = localDate();
		const written = await renderMocs(this.app, templates, installed, this.sourcesRoot(), today, this.settings.sourceMocParent.trim() || "Midad Arabic Sources", true);
		const repositoryGroups = new Map<string, { label: string; works: JsonObject[] }>();
		const repositoryNames = new Map<string, string>();
		for (const work of installed) {
			const repo = this.repositoryMoc(work);
			if (!repo) continue;
			let name = repo.name;
			const existing = repositoryNames.get(name);
			if (existing && existing !== repo.label) {
				name = `${repo.name} (${repo.label})`;
			}
			repositoryNames.set(name, repo.label);
			let group = repositoryGroups.get(name);
			if (!group) {
				group = { label: repo.label, works: [] };
				repositoryGroups.set(name, group);
			}
			group.works.push(work);
		}
		this.repositoryMocNames = [...repositoryGroups.keys()];
		this.repositoryMocLabels = {};
		for (const [name, group] of repositoryGroups) {
			this.repositoryMocLabels[name] = group.label;
			const sections = buildMocSections(group.works);
			written.push(await renderMocIndex(
				this.app, templates, name,
				sections.length ? sections : [{ name: "Works", works: group.works }],
				this.sourcesRoot(), SOURCE_INDEX_NOTE, today, true
			));
		}
		try {
			written.push(...await this.refreshTranscriptionMocs());
		} catch (error) {
			console.error("[midad-arabic-sources] transcription MOCs", error);
		}
		const mocNames = [...new Set(installed.flatMap((w): string[] => {
			const names = Array.isArray(w.mocs) ? (w.mocs as string[]) : (typeof w.moc === "string" ? [w.moc] : []);
			return names.map(canonicalMocName);
		}))].filter(Boolean).sort();
		if (this.annotations?.hasAnnotatedWorks() || this.annotations?.mocExists()) {
			if (!mocNames.includes("source-annotation")) mocNames.push("source-annotation");
		}
		const parentPath = await this.updateSourceParent(templates, mocNames, today);
		if (parentPath) written.push(parentPath);
		void this.refreshSourceRegistry();
		return written;
	}

	/** Works whose notes are partially or wholly missing in the vault. */
	/** Works whose notes or cached model are missing in the vault. */
	async findIncompleteSources(): Promise<Array<{ work: JsonObject; missing: number; total: number; reason: string }>> {
		const outRoot = this.installedSourcesRoot();
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const modelKeys = new Set(await this.listModelKeys());
		const stats = await this.loadSourceStats();
		const canonicalId = this.resolveCanonicalQuran();
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		const out: Array<{ work: JsonObject; missing: number; total: number; reason: string }> = [];
		for (const work of manifest) {
			if (this.workStatus(work) !== "installed") continue;
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
		const outRoot = this.installedSourcesRoot();
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
	async reinstallSource(work: JsonObject, kind: "explicit" | "auto" = "explicit"): Promise<void> {
		await this.importSources([`${work.collection}:${work.id}`], false, undefined, kind);
	}

	/** Ask the source repositories whether any imported work has changed upstream. */
	async checkSourceUpdates(kind: "explicit" | "auto" = "explicit"): Promise<string[]> {
		const op = this.beginSourceOperation(kind);
		if (op === null) return [];
		try {
		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const keys = new Set<string>();
		for (const w of manifest) {
			if (this.workStatus(w) === "installed") keys.add(`${w.collection}:${w.id}`);
		}
		for (const k of await this.listModelKeys()) keys.add(k);
		for (const k of pending) keys.delete(k); // being removed: leave them alone
		if (!keys.size) {
			new Notice("No imported sources to check.");
			return [];
		}
		const args = ["check-updates"];
		for (const k of keys) args.push("--key", k);
		const result = await this.runWithProgress("Checking for updates", args, this.settings.sourceImportScript);
		if (this.isSourceCancelled(op)) return [];
		const changed: string[] = result?.changed ?? [];
		const dateOnly: string[] = result?.date_only ?? [];
		if (!changed.length && !dateOnly.length) {
			new Notice("All imported sources are up to date.");
			return [];
		}
		// Repository moved but the text did not: refresh the property from the model.
		if (dateOnly.length) await this.renderWithProgress(dateOnly, false, "Refreshing source details", op);
		if (this.isSourceCancelled(op)) return [];
		if (changed.length) {
			new Notice(`Text changed in ${changed.length} work(s); updating…`);
			await this.importSources(changed, true, op);
		}
		return changed;
		} finally {
			this.endSourceOperation(op);
		}
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
			const choice = await new Promise<"start" | "skip" | "cancel">((resolve) => {
				new TransliterationUnavailableModal(this.app, name, resolve).open();
			});
			if (choice === "skip") return true;
			if (choice === "cancel") return null;
			// "Start server" → start it here, then re-check in the loop.
			await this.startTransliterationServer();
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
		await this.checkSourceUpdates("auto");
	}

	bundledTemplateDir(): string {
		// Relative to the vault config dir, like ScholarWeft (plugin.manifest.dir).
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/midad-arabic-sources`;
		return `${dir}/${TEMPLATE_FOLDER}`;
	}

	/** A work is "installed" when its hub/work note exists in the vault. */
	async isSourceDirInstalled(dir: string): Promise<boolean> {
		const outRoot = this.installedSourcesRoot();
		try {
			return await this.app.vault.adapter.exists(normalizePath(`${outRoot}/${dir}.md`));
		} catch {
			return false;
		}
	}

	/** Acquire the chosen works, then render their models into the vault. */
	async importSources(keys: string[], refresh = false, operationId?: number,
		kind: "explicit" | "auto" = "explicit"): Promise<void> {
		if (!keys.length) {
			new Notice("Select at least one source.");
			return;
		}
		const op = operationId ?? this.beginSourceOperation(kind);
		if (op === null) return;
		const owns = operationId === undefined;
		try {
		void this.maybeWarnEngineFallback();
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
		if (this.isSourceCancelled(op)) {
			new Notice("Stopped. The work is not installed; install it again to resume.");
			return;
		}
		const models: string[] = result?.models ?? [];
		if (!models.length) {
			new Notice("No models were produced — see the pipeline status.");
			return;
		}
		const written = await this.renderWithProgress(models, false, "Rendering notes", op);
		if (this.isSourceCancelled(op)) {
			new Notice("Stopped. Partial notes remain; install again to finish.");
			return;
		}
		new Notice(`Rendered ${written.length} notes.`);
		void this.maybeWarnEngineFallback();
		} finally {
			if (owns) this.endSourceOperation(op);
		}
	}

	/**
	 * Render a batch while a persistent notice reports progress: files written,
	 * which work of the batch, and how many works remain — otherwise a long
	 * re-render is silent and its end is impossible to detect. Every background
	 * render goes through here, so nothing large ever runs without a report.
	 */
	async renderWithProgress(modelPaths: string[], force: boolean, title: string,
		operationId?: number, kind: "explicit" | "auto" = "explicit"): Promise<string[]> {
		const op = operationId ?? this.beginSourceOperation(kind);
		if (op === null) return [];
		const owns = operationId === undefined;
		const progress = new Notice(`${title}…`, 0);
		const stop = progress.messageEl.createEl("button", { text: "Stop" });
		stop.addEventListener("click", () => {
			stop.disabled = true;
			progress.setMessage(`${title}: stopping…`);
			this.cancelSourceOperation();
		});
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
			}, () => this.isSourceCancelled(op));
		} finally {
			progress.hide();
			if (owns) this.endSourceOperation(op);
		}
	}

	async renderModels(modelPaths: string[], force = false, onProgress?: (p: RenderProgress) => void,
		shouldCancel?: () => boolean): Promise<string[]> {
		const vault = this.vaultPath();
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch (e) {
			new Notice(`Import templates could not be loaded: ${e instanceof Error ? e.message : e}`);
			return [];
		}
		const outRoot = this.installedSourcesRoot();
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
			if (shouldCancel?.()) break;
			const model = batch[i];
			// Hand the templates the researched bibliographic details, if any — plus
			// the combined `midad-note` text, so the note holds everything the Zotero
			// `extra` does.
			const pub = pubs[this.workKey(model.work)] ?? {};
			model.work.publication = { ...pub, mas_note: this.masNote(pub) };
			const work = String(model.work.title || model.work.dir || model.work.id);
			const emit = (step: number, steps: number) =>
				onProgress?.({ index: i, total: batch.length, work, step, steps });
			emit(0, 0);
			try {
				const seen = new Map(Object.entries(stats[this.workKey(model.work)]?.units ?? {}));
				const w = await renderModelToVault(this.app, templates, model, outRoot, force, emit,
					undefined, seen, shouldCancel);
				written.push(...w);
				// A full render brings every template the work uses up to date.
				const key = this.workKey(model.work);
				const now = Date.now();
				const rendered: Record<string, number> = { ...(stats[key]?.rendered ?? {}) };
				for (const tkey of this.templateKeysFor(String(model.work.collection ?? ""))) rendered[tkey] = now;
				stats[key] = {
					...stats[key], rendered, units: Object.fromEntries(seen),
					// The total, not the number just rewritten: this is the baseline the
					// completeness check compares against, and most notes are skipped.
					notes: expectedNotePaths(model, outRoot, canonicalRoot, canonicalId).length,
					schema: Number(model.schema ?? 0),
					render: requiredRenderVersion(String(model.work.collection ?? "")),
				};
			} catch (e) {
				// A user's Stop is not a failure: leave the work uninstalled and stop.
				if (shouldCancel?.()) break;
				// One unusable model must not abort the whole batch: a template/model
				// mismatch used to kill a re-render, leaving only a flashed notice.
				console.error("[midad-arabic-sources] render failed", this.workKey(model.work), e);
				new Notice(`Could not render ${work}: ${e instanceof Error ? e.message : e}`);
			}
			await this.pruneRenamedFolder(model.work);
		}
		await this.saveSourceStats(stats);
		// A stopped render leaves the MOCs and Zotero as they were; the next pass
		// finishes the work. Rebuilding them now would be more writes after a stop.
		if (shouldCancel?.()) return written;
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
	/**
	 * Refresh only the top-level parent note after an annotation change, so the
	 * Source Annotations MOC appears there without re-rendering every category MOC.
	 */
	async refreshAnnotationParent(): Promise<void> {
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch {
			return;
		}
		try {
			const manifest = await this.loadSourceManifest();
			const installed = manifest.filter((w) => this.workStatus(w) === "installed");
			const mocNames = [...new Set(installed.flatMap((w) => (
				Array.isArray(w.mocs) ? (w.mocs as string[]) : (typeof w.moc === "string" ? [w.moc] : [])
			)))].filter(Boolean).sort();
			if (this.annotations?.hasAnnotatedWorks() || this.annotations?.mocExists()) {
				if (!mocNames.includes("source-annotation")) mocNames.push("source-annotation");
			}
			if (!mocNames.length) return;
			const today = localDate();
			await this.updateSourceParent(templates, mocNames, today);
			try { await this.refreshTranscriptionMocs(); } catch (error) { console.error("[midad-arabic-sources] transcription MOCs", error); }
		} catch (error) {
			console.error("[midad-arabic-sources] annotation parent", error);
		}
	}

	/** A stable, readable MOC name for a repository. */
	repositoryMoc(work: JsonObject): { name: string; label: string } | null {
		const repo = [work.repo_name, work.repo, work.repository_name, work.source]
			.map((value) => String(value ?? "").trim())
			.find(Boolean)
			?.replace(/^https?:\/\//, "")
			.replace(/\/$/, "") ?? "";
		if (!repo) return null;
		const known: Record<string, [string, string]> = {
			"app.turath.io": ["Turath", "Turath"],
			"github.com/spa5k/tafsir_api": ["Tafsir API", "Tafsīr API"],
			"qul.tarteel.ai": ["QUL", "QUL"],
			"altafsir.com": ["Altafsir", "Altafsir"],
			"github.com/AhmedBaset/hadith-json": ["Hadith JSON", "Ḥadīth JSON"],
			"github.com/fawazahmed0/quran-api": ["Quran API", "Qurʾān API"],
			"github.com/risan/quran-json": ["Quran JSON", "Qurʾān JSON"],
			"quran-json.risanb.com": ["Quran JSON", "Qurʾān JSON"],
			"tanzil.net": ["Tanzil", "Tanzil"],
			"github.com/GibreelAbdullah/HansWehrDictionary": ["Hans Wehr", "Hans Wehr"],
			"github.com/GibreelAbdullah/LaneLexicon": ["Lane", "Lane"],
			"github.com/muhammad-abdurrahman/hans-wehr-fodt-parser": ["Hans Wehr FODT", "Hans Wehr FODT"],
		};
		const mapped = known[repo];
		if (mapped) return { name: mapped[0], label: mapped[1] };
		const fallback = repo
			.replace(/^https?:\/\//, "")
			.replace(/^github\.com\//, "")
			.replace(/[\\/:*?"<>|#^]+/g, " - ")
			.replace(/\s+/g, " ")
			.trim();
		return fallback ? { name: fallback, label: fallback } : null;
	}

	/** Does this new/renamed/deleted note belong in a transcription/translation MOC? */
	transcriptionNotePath(path: string): boolean {
		const note = normalizePath(path);
		if (!note.endsWith(".md")) return false;
		if (note.startsWith("tmp/") || note.startsWith(".midad-") || note.startsWith(".trash/") || note.includes("/tmp/")) return false;
		if (note.startsWith(`${this.transcriptionsFolder()}/`) || note.startsWith(`${this.translationsFolder()}/`)) return true;
		return /(?:^|\s[-–—]\s).*?(?:transcription|translation)(?:[,\s–—-]|$)/i.test(note.split("/").pop() ?? "");
	}

	scheduleTranscriptionMocRefresh(): void {
		if (this.transcriptionMocTimer !== null) window.clearTimeout(this.transcriptionMocTimer);
		this.transcriptionMocTimer = window.setTimeout(() => {
			this.transcriptionMocTimer = null;
			void this.refreshTranscriptionMocs().catch((error) => console.error("[midad-arabic-sources] transcription MOCs", error));
		}, 1500);
	}

	/** Render the transcription/translation category MOCs. */
	async refreshTranscriptionMocs(): Promise<string[]> {
		const written: string[] = [];
		const notePattern = /^(.*?)\s+[-–—]\s+(?:(?:[A-Za-z]+\s+)*)(transcription|translation)(?:\s+[-–—]\s+(?:v(?:ol)?\.?|volume)\s*(\d+))?(?:\s*[,–—]\s*(.+))?(?:\s+(\([^)]+\)))?$/i;
		const cleanLabel = (value: string): string => value
			.replace(/^\s*(?:transcription|translation)\s*[-–—]\s*/i, "")
			.replace(/\s*\((?:transcription|translation)(?:[^()]*)\)\s*$/i, "")
			.replace(/\s*[-–—]\s*(?:transcription|translation)\s*$/i, "")
			.replace(/\s+v(?:ol)?\.?\s*\d+\s*$/i, "")
			.trim();
		const indexPath = async (name: string): Promise<string> => {
			const canonical = this.sourceNotePath(name);
			const existing = this.app.vault.getAbstractFileByPath(canonical);
			if (existing instanceof TFile) return existing.path;
			const first = this.app.metadataCache.getFirstLinkpathDest(name, "");
			if (first instanceof TFile && first.path !== canonical) {
				try {
					await this.app.fileManager.renameFile(first, canonical);
					const moved = this.app.vault.getAbstractFileByPath(canonical);
					if (moved instanceof TFile) return moved.path;
				} catch { /* fall through */ }
			}
			try {
				await this.app.vault.create(canonical, "");
				return canonical;
			} catch {
				return canonical;
			}
		};
		const adopted = new Map<string, Record<string, unknown>>();
		try {
			const raw = JSON.parse(await this.app.vault.adapter.read(".midad-arabic-sources/annotations/adopted.json")) as { notes?: Record<string, Record<string, unknown>> };
			for (const [key, value] of Object.entries(raw.notes ?? {})) {
				if (value && typeof value === "object") adopted.set(normalizePath(key), value);
			}
		} catch { /* no adopted registry yet */ }
		const folders = [this.transcriptionsFolder(), this.translationsFolder()]
			.map((folder) => normalizePath(folder).replace(/\/+$/, ""))
			.filter(Boolean);
		const inFolder = (path: string): boolean => folders.some((folder) => path.startsWith(`${folder}/`));
		const groups = new Map<string, {
			docType: "transcription" | "translation";
			route: "lit" | "pdf" | "adopted";
			title: string;
			parentStem: string;
			parentTitle: string;
			volumes: Array<{ stem: string; label: string }>;
		}>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const path = normalizePath(file.path);
			if (path.startsWith("tmp/") || path.startsWith(".midad-") || path.startsWith(".trash/") || path.includes("/tmp/")) continue;
			const entry = adopted.get(path);
			const match = notePattern.exec(file.basename);
			if (!inFolder(path) && !entry && !(match && /^(?:@|mas-)/.test(file.basename))) continue;
			const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
			const entryString = (key: string): string => typeof entry?.[key] === "string" ? String(entry[key]) : "";
			const source = sourceIdFromYaml(fm["midad-source"]);
			const kind = typeof fm["midad-kind"] === "string" ? String(fm["midad-kind"]) : "";
			const rawBase = (match?.[1] ?? "").trim();
			const baseVolume = /^(.*?)\s+(?:vol\.?|v\.?|volume)\s*(\d+)$/i.exec(rawBase);
			const base = baseVolume ? baseVolume[1].trim() : rawBase;
			const namedType = (match?.[2] ?? "").toLowerCase();
			const fallbackType = kind === "translation" || entryString("kind") === "translation"
				? "translation"
				: kind === "transcription" || entryString("kind") === "transcription"
					? "transcription"
					: "";
			const docType = namedType === "translation" || fallbackType === "translation" || path.startsWith(`${this.translationsFolder()}/`)
				? "translation"
				: namedType === "transcription" || fallbackType === "transcription" || path.startsWith(`${this.transcriptionsFolder()}/`)
					? "transcription"
					: "";
			if (!docType) continue;
			const volumeFromName = match?.[3] ? Number(match[3]) : null;
			const rawVolumeValue = fm["volume"];
			const rawVolume = typeof rawVolumeValue === "number"
				? rawVolumeValue
				: typeof rawVolumeValue === "string"
					? Number(rawVolumeValue.match(/\d+/)?.[0] ?? NaN)
					: NaN;
			const unitKey = entryString("unitKey");
			const volumeFromUnit = /^volume:(\d+)/i.exec(unitKey) ?? /^vol(?:ume)?\.?\s*(\d+)/i.exec(unitKey);
			const volume = [volumeFromName, baseVolume ? Number(baseVolume[2]) : null, Number.isFinite(rawVolume) ? rawVolume : null, volumeFromUnit ? Number(volumeFromUnit[1]) : null]
				.find((value): value is number => typeof value === "number" && value > 0) ?? null;
			const variant = (match?.[4] ?? match?.[5] ?? "").trim();
			let route: "lit" | "pdf" | "adopted" = "adopted";
			if (source.startsWith("zotero:")) route = "lit";
			else if (source.startsWith("pdf:")) route = "pdf";
			else if (/^(?:transcription|translation):@/.test(entryString("sourceKey"))) route = "lit";
			else if (!source && /^@/.test(base)) route = "lit";
			const rawTitle = typeof fm["title"] === "string" ? String(fm["title"]).trim() : "";
			const aliases = Array.isArray(fm["aliases"]) ? fm["aliases"].map(String) : [];
			const entryTitle = cleanLabel(entryString("workTitle"));
			const title = [
				/^(?:transcription|translation)\s+of\b/i.test(rawTitle) ? "" : cleanLabel(rawTitle),
				cleanLabel(aliases[0] ?? ""),
				/^(?:transcription|translation)\s+of\b/i.test(entryTitle) ? "" : entryTitle,
				cleanLabel((base || file.basename).replace(/^(?:mas-|@)/, "")),
			].find((value) => value.length > 0) ?? file.basename;
			const key = base
				? `stem:${docType}:${base.toLocaleLowerCase()}`
				: entryString("workKey")
					? `adopted:${docType}:${entryString("workKey")}:${unitKey}`
					: `path:${docType}:${path}`;
			let group = groups.get(key);
			if (!group) {
				group = { docType, route, title, parentStem: "", parentTitle: "", volumes: [] };
				groups.set(key, group);
			}
			if (route === "lit") group.route = "lit";
			else if (route === "pdf" && group.route !== "lit") group.route = "pdf";
			if (volume) {
				const label = `vol. ${volume}${variant ? ` ${variant.startsWith("(") ? variant : `(${variant})`}` : ""}`;
				group.volumes.push({ stem: file.basename, label });
			} else {
				group.parentStem = file.basename;
				group.parentTitle = title;
			}
		}
		const sorted = [...groups.values()].sort((a, b) =>
			(a.parentTitle || a.title).localeCompare(b.parentTitle || b.title, undefined, { sensitivity: "base", numeric: true })
		);
		const render = async (name: string, docType: "transcription" | "translation"): Promise<void> => {
			const path = await indexPath(name);
			const noun = docType === "transcription" ? "Transcriptions" : "Translations";
			const lines = [
				'<span class="mas-managed">mas-managed</span>',
				"",
				`# ${noun} from literature notes`,
				"",
			];
			const append = (route: "lit" | "pdf" | "adopted"): void => {
				const items = sorted.filter((group) => group.docType === docType && group.route === route);
				if (route === "adopted" && items.length === 0) return;
				for (const group of items) {
					group.volumes.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
					const top = group.parentStem || group.volumes[0]?.stem;
					if (!top) continue;
					const label = group.parentTitle || group.title || group.volumes[0]?.label || top;
					lines.push(`- [[${top}|${label}]]`);
					const volumes = group.parentStem ? group.volumes : group.volumes.slice(1);
					for (const volume of volumes) lines.push(`\t- [[${volume.stem}|${volume.label}]]`);
				}
				lines.push("");
			};
			append("lit");
			lines.push(`# ${noun} directly from PDFs`, "");
			append("pdf");
			if (sorted.some((group) => group.docType === docType && group.route === "adopted")) {
				lines.push(`# Adopted ${docType === "transcription" ? "transcriptions" : "translations"}`, "");
				append("adopted");
			}
			lines.push('<span class="mas-managed">/mas-managed</span>', "");
			const today = localDate();
			const yaml = new YamlBuilder();
			yaml.start();
			yaml.add("created", today, { merge: "keep" });
			yaml.add("midad-up", [`[[${SOURCE_INDEX_NOTE}]]`, "[[Midad Arabic Sources]]"]);
			const specs = yaml.fieldSpecs();
			const content = `${yaml.end()}\n${lines.join("\n")}`;
			await writeMerged(this.app, path, { content, specs }, true, false);
			written.push(path);
		};
		await render("Arabic transcriptions", "transcription");
		await render("Arabic translations", "translation");
		return written;
	}


	async updateSourceParent(templates: TemplateSet, mocs: string[], generated: string): Promise<string | null> {
		const name = (this.settings.sourceMocParent || "").trim() || "Midad Arabic Sources";
		if (!mocs.length) return null;
		const isMidadParent = name === "Midad Arabic Sources";
		const canonicalPath = this.sourceNotePath(name);
		const existingCanonical = this.app.vault.getAbstractFileByPath(canonicalPath);
		let file = existingCanonical instanceof TFile ? existingCanonical : null;
		if (!file && isMidadParent) {
			const existing = this.app.metadataCache.getFirstLinkpathDest(name, "");
			if (existing instanceof TFile) file = existing;
		}
		if (!file) {
			// A note with the configured name may predate the source-folder layout.
			// Move it into the sources root rather than creating a second Sources note.
			const first = this.app.metadataCache.getFirstLinkpathDest(name, "");
			if (first instanceof TFile && first.path !== canonicalPath) {
				try {
					const folder = canonicalPath.split("/").slice(0, -1).join("/");
					if (folder && !(await this.app.vault.adapter.exists(folder))) {
						await this.app.vault.createFolder(folder);
					}
					await this.app.fileManager.renameFile(first, canonicalPath);
					const moved = this.app.vault.getAbstractFileByPath(canonicalPath);
					if (moved instanceof TFile) file = moved;
				} catch (e) {
					console.error("[midad-arabic-sources] move source parent", e);
				}
			}
		}
		if (!file) {
			try {
				const folder = canonicalPath.split("/").slice(0, -1).join("/");
				if (folder && !(await this.app.vault.adapter.exists(folder))) {
					await this.app.vault.createFolder(folder);
				}
				file = await this.app.vault.create(canonicalPath, "");
			} catch {
				return null;
			}
		}
		const repositoryMocs = this.repositoryMocNames.filter(Boolean);
		const sourceMocs = new Set([...repositoryMocs, "Arabic transcriptions", "Arabic translations"]);
		const topicMocs = mocs.filter((m) => m !== "source-annotation" && !sourceMocs.has(m));
		const sourceList = [...new Set([...repositoryMocs, "Arabic transcriptions", "Arabic translations"])]
			.filter((m) => m === "Turath" || m === "Arabic transcriptions" || m === "Arabic translations" || mocs.includes(m) || repositoryMocs.includes(m));
		const label = (name: string) => (
			this.repositoryMocLabels[name] ??
			(name === "Tafsīr Sources" ? "Tafsīr"
				: name === "Ḥadīth Sources" ? "Ḥadīth"
					: name === "Language Sources" ? "Language"
						: name === "Arabic transcriptions" ? "My transcriptions"
							: name === "Arabic translations" ? "My translations"
								: name)
		);
		await renderMocIndex(this.app, templates, "Midad Arabic Sources - Topics",
			[{ name: "Topics", works: topicMocs.map((m) => ({ dir: m, title: label(m) })) }],
			this.sourcesRoot(), "Midad Arabic Sources", generated);
		const repoItems = repositoryMocs.map((m) => ({ dir: m, title: label(m) }));
		await renderMocIndex(this.app, templates, SOURCE_INDEX_NOTE,
			[
				{ name: "Repositories", works: repoItems },
				{ name: "Local transcriptions", works: [{ dir: "Arabic transcriptions", title: "My transcriptions" }] },
				{ name: "Local translations", works: [{ dir: "Arabic translations", title: "My translations" }] },
			].filter((section) => section.works.length > 0),
			this.sourcesRoot(), "Midad Arabic Sources", generated);
		const groups = [
			{ name: "Midad Arabic Sources - Topics", label: "By Topic", items: topicMocs.map((m) => ({ name: m, label: label(m) })) },
			{ name: SOURCE_INDEX_NOTE, label: "By Source", items: sourceList.map((m) => ({ name: m, label: label(m) })) },
			{ name: "source-annotation", label: "Annotations", items: [] },
		];
		const out = renderSourcesNote(templates, groups, generated);
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
	workStatus(work: JsonObject): "installed" | "deleting" | "archived" {
		if (work.status === "archived") return "archived";
		return work.status === "deleting" ? "deleting" : "installed";
	}

	/** The stable identity of a work (its key, falling back to its folder). */
	workKey(work: JsonObject): string {
		return String(work.key ?? `${work.collection}:${work.id}`);
	}

	async setWorkStatus(keys: string | string[], status: "installed" | "deleting" | "archived" | null): Promise<void> {
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

	/** Whether a work key is currently installed (not archived, not being removed). */
	async isSourceInstalled(key: string): Promise<boolean> {
		const manifest = await this.loadSourceManifest();
		return manifest.some((w) => this.workKey(w) === key &&
			(w.status === "archived" ? false : this.workStatus(w) === "installed"));
	}

	/** Whether a Turath work is in the built-in catalogue (custom entries may override it). */
	async isBuiltinTurathWork(id: string): Promise<boolean> {
		const works = await this.listSourcesCached();
		return works.some((w) => w.collection === "turath" && String(w.id) === String(id) && w.builtin === true);
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

	/**
	 * Rename every installed work's folder, hub, and unit files to the current
	 * naming scheme (repository-qualified; a work flagged `unique` keeps its bare
	 * name). Files move *before* the re-render, so the re-render merges into the
	 * moved notes and user content outside the managed region survives.
	 *
	 * `adapter.rename` is used rather than `fileManager.renameFile`: the latter
	 * rewrites every inbound link on each of thousands of renames, which is very
	 * slow; the single re-render afterwards rewrites the managed links instead.
	 */
	async migrateSourceNaming(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const canonicalId = this.resolveCanonicalQuran();

		let catalogue: SourceWork[];
		try {
			catalogue = await this.listSources(true);
		} catch (e) {
			new Notice(`Could not read the catalogue: ${e instanceof Error ? e.message : e}`);
			return;
		}
		const targets = new Map(catalogue.map((w) => [w.key, w.dir]));

		const manifest = await this.loadSourceManifest();
		const pending = await this.loadPendingDeletions();
		const migrated: string[] = [];
		const models: string[] = [];
		const problems: string[] = [];
		const notice = new Notice("Checking source names…", 0);
		try {
			for (const work of manifest) {
				if (this.workStatus(work) !== "installed" || pending.has(this.workKey(work))) continue;
				const key = this.workKey(work);
				const oldDir = String(work.dir ?? "");
				const newDir = String(targets.get(key) ?? "");
				if (!oldDir || !newDir || oldDir === newDir) continue;

				const modelRel = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
				let text: string;
				try {
					text = await adapter.read(modelRel);
				} catch {
					problems.push(`${key}: model missing`);
					continue;
				}
				let model: SourceModel;
				try {
					model = JSON.parse(text) as SourceModel;
				} catch {
					problems.push(`${key}: model unreadable`);
					continue;
				}

				try {
					await this.moveWorkFiles(work, model, oldDir, newDir, canonicalId);
				} catch (e) {
					problems.push(`${key}: ${e instanceof Error ? e.message : e}`);
					continue;
				}
				model.work.dir = newDir;
				await adapter.write(modelRel, JSON.stringify(model));
				work.dir = newDir;
				try {
					await this.annotations?.onSourceRenamed(key, oldDir, newDir);
				} catch (e) {
					console.error("[midad-arabic-sources] annotation paths after rename", e);
				}
				migrated.push(key);
				models.push(`${this.vaultPath()}/${modelRel}`);
				notice.setMessage(`Renaming sources: ${migrated.length} moved — ${newDir}`);
			}
		} finally {
			notice.hide();
		}

		if (migrated.length) {
			await this.saveSourceManifest(manifest);
			await this.renderWithProgress(models, false, "Renaming imported sources");
		}
		const summary = migrated.length
			? `Renamed ${migrated.length} source(s) and re-rendered their notes.`
			: "No source folders needed renaming.";
		new Notice(problems.length ? `${summary} Problems: ${problems.join("; ")}` : summary);
	}

	/** Move one work's hub, folder, and prefixed unit files. Throws if a target exists. */
	async moveWorkFiles(
		work: JsonObject,
		model: SourceModel,
		oldDir: string,
		newDir: string,
		canonicalId: string
	): Promise<void> {
		const outRoot = this.installedSourcesRoot();
		const adapter = this.app.vault.adapter;
		const oldHub = normalizePath(`${outRoot}/${oldDir}.md`);
		const newHub = normalizePath(`${outRoot}/${newDir}.md`);
		const oldFolder = normalizePath(`${outRoot}/${oldDir}`);
		const newFolder = normalizePath(`${outRoot}/${newDir}`);

		if ((await adapter.exists(newHub)) || (await adapter.exists(newFolder))) {
			throw new Error(`“${newDir}” already exists`);
		}
		if (await adapter.exists(oldHub)) await adapter.rename(oldHub, newHub);
		if (await adapter.exists(oldFolder)) await adapter.rename(oldFolder, newFolder);

		// Dictionary roots and canonical-riwāya sūras keep unprefixed names: the
		// folder move carries the dictionary roots, and canonical sūras live in
		// their own root. Every other unit is `<dir> - <base>.md`.
		const isDict = work.collection === "dictionary";
		const isCanonical = work.collection === "quran-text" && String(work.id) === canonicalId;
		if (isDict || isCanonical || !(await adapter.exists(newFolder))) return;
		for (const unit of model.units) {
			const base = String(unit.base ?? "");
			if (!base) continue;
			const from = normalizePath(`${newFolder}/${oldDir} - ${base}.md`);
			const to = normalizePath(`${newFolder}/${newDir} - ${base}.md`);
			if (from !== to && (await adapter.exists(from))) await adapter.rename(from, to);
		}
	}

	/** Re-render every cached model (run after editing a template). */
	/**
	 * Re-render only the source the open note belongs to — whether that note is the
	 * work's hub or any note under it. Handy after a model is rebuilt for one work:
	 * the rest of the corpus is left alone.
	 */
	async rerenderCurrentSource(file?: TAbstractFile | null): Promise<void> {
		const target = file ?? this.app.workspace.getActiveFile();
		if (!target) {
			new Notice("Open a note that belongs to an imported source first.");
			return;
		}
		const work = await this.workForPath(target.path);
		if (!work) {
			await this.rerenderArchivedNote(target);
			return;
		}
		const rel = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
		if (!(await this.app.vault.adapter.exists(rel))) {
			new Notice("That source has no cached model — install it again from Manage text sources.");
			return;
		}
		const label = String(work.title ?? work.dir ?? work.id);
		await this.renderWithProgress([`${this.vaultPath()}/${rel}`], true, `Re-rendering ${label}`);
		new Notice(`Re-rendered ${label}.`);
	}

	/**
	 * Re-render a transcribed note from its archived batch. Covers standalone
	 * PDF transcriptions, literature-note transcriptions/translations, and
	 * volume notes. The archive contains the OCR/translation JSON, so this
	 * never calls Gemini.
	 */
	async rerenderArchivedNote(file: TAbstractFile): Promise<void> {
		const info = archivedNoteInfo(file.path);
		if (!info) {
			new Notice("That note does not belong to an imported source and has no archived transcription.");
			return;
		}

		const all = (await this.pipelineResult(["list-archive"]))?.zips ?? [];
		const batches = all
			.map((zip) => ({ zip, info: archivedBatchInfo(zip.name) }))
			.filter((entry): entry is { zip: ArchiveZip; info: ArchivedBatchInfo } => {
				if (!entry.info || entry.info.citekey !== info.citekey) return false;
				return info.type === null || entry.info.type === info.type;
			})
			.sort((a, b) => (a.info.volume ?? -1) - (b.info.volume ?? -1));

		if (!batches.length) {
			const kind = info.type ? ` ${info.type}` : "";
			new Notice(`No archived${kind} batch found for @${info.citekey}.`);
			return;
		}

		let chosen = batches;
		if (info.volume != null) {
			const exact = batches.filter((entry) => entry.info.volume === info.volume);
			if (!exact.length) {
				new Notice(`No archived ${info.type ?? "transcription"} batch found for @${info.citekey}, vol. ${info.volume}.`);
				return;
			}
			if (batches.some((entry) => entry.info.volume !== info.volume)) {
				const scope = await new Promise<"one" | "all" | null>((resolve) => {
					new ReRenderBatchScopeModal(
						this.app,
						info.citekey,
						info.volume,
						batches.length,
						resolve
					).open();
				});
				if (!scope) return;
				chosen = scope === "one" ? exact : batches;
			} else {
				chosen = exact;
			}
		}

		for (const entry of chosen) {
			await this.runWithProgress(`Re-rendering @${info.citekey}`, ["reprocess", "--zip", entry.zip.path]);
		}
		new Notice(`Re-rendered ${chosen.length} archived batch(es) for @${info.citekey}.`);
	}

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
			turath: ["book", "bookVolume"],
		};
		return ["hub", ...(unit[collection] ?? ["source"])];
	}

	/** A hash per template file, so a change can be attributed to its users. */
	async sourceTemplateHashes(): Promise<Record<string, TemplateHashValue>> {
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		const t = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		const values: Record<string, string> = {
			source: t.source,
			hadith: t.hadith,
			quran: t.quran,
			dictionary: t.dictionary,
			dictionaryIndex: t.dictionaryIndex,
			book: t.book,
			bookVolume: t.bookVolume,
			hub: t.hub,
			moc: t.moc,
			sources: t.sources,
		};
		const out: Record<string, TemplateHashValue> = {};
		for (const [key, source] of Object.entries(values)) {
			const parts = splitTemplateSource(source);
			out[key] = {
				hash: hashString(source),
				yaml: hashString(parts.yaml),
				body: hashString(parts.body),
			};
		}
		return out;
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
	async recordSourceTemplate(): Promise<{
		changed: string[];
		changedParts: Record<string, "yaml" | "body" | "both">;
		yamlOnly: boolean;
	}> {
		const hashes = await this.sourceTemplateHashes();
		const store = await this.loadSourceHashes();
		const { store: next, changed, changedParts } = recordTemplateHashes(store, hashes, Date.now());
		await this.saveSourceHashes(next);
		const yamlOnly = changed.length > 0 && changed.every((key) => changedParts[key] === "yaml");
		return { changed, changedParts, yamlOnly };
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
	async findStaleSourceWorks(): Promise<Array<{ work: JsonObject; kinds: Set<string> | null }>> {
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
			// A model rebuilt since this work was last rendered means its notes are out
			// of date even though no template or source changed — the acquisition code
			// was fixed, and the notes still carry the old names or wording. Compare the
			// model file's own mtime with the newest render watermark we hold, and treat
			// it as a *full* render (null), not a scoped one: every note may be affected.
			// A change to how this collection is *rendered* (see
			// COLLECTION_RENDER_VERSION) is a full render too, scoped to the collection.
			if ((stat?.render ?? 0) < requiredRenderVersion(String(work.collection ?? ""))) {
				out.push({ work, kinds: null });
				continue;
			}
			const modelRel = normalizePath(`.midad-arabic-sources/source-models/${work.collection}/${work.id}.json`);
			const modelStat = await this.app.vault.adapter.stat(modelRel).catch((): null => null);
			const renderedAt = hasRendered ? Math.max(0, ...Object.values(rendered ?? {})) : legacyMs;
			// Only when we actually know when this work was last rendered. A work with
			// neither a render watermark nor a dated hub note would otherwise be older
			// than *any* model file and be re-rendered on every pass, which is the
			// opposite of the careful scoping this check exists for.
			if (renderedAt > 0 && modelStat && modelStat.mtime > 0 && modelStat.mtime > renderedAt) {
				out.push({ work, kinds: null });
				continue;
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
	async renderStaleScoped(items: Array<{ work: JsonObject; kinds: Set<string> | null }>,
		kind: "explicit" | "auto" = "auto", yamlOnly = false): Promise<void> {
		if (!items.length) return;
		const op = this.beginSourceOperation(kind);
		if (op === null) return;
		const userFolder = this.settings.sourceTemplateFolder.trim() || null;
		let templates: TemplateSet;
		try {
			templates = await loadTemplates(this.app, this.bundledTemplateDir(), userFolder);
		} catch (e) {
			new Notice(`Import templates could not be loaded: ${e instanceof Error ? e.message : e}`);
			this.endSourceOperation(op);
			return;
		}
		const outRoot = this.installedSourcesRoot();
		const canonicalId = this.resolveCanonicalQuran();
		const canonicalRoot = this.settings.canonicalQuranFolder.trim() || `${outRoot}/Quran`;
		const stats = await this.loadSourceStats();
		const notice = new Notice("Updating imported sources…", 0);
		const stop = notice.messageEl.createEl("button", { text: "Stop" });
		stop.addEventListener("click", () => {
			stop.disabled = true;
			notice.setMessage("Updating imported sources: stopping…");
			this.cancelSourceOperation();
		});
		let done = 0;
		try {
			for (const it of items) {
				if (this.isSourceCancelled(op)) break;
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
					const seen = new Map(Object.entries(stats[key]?.units ?? {}));
					if (yamlOnly) {
						await renderModelToVault(this.app, templates, model, outRoot, false, onStep,
							it.kinds ?? undefined, seen, () => this.isSourceCancelled(op), true);
					} else {
						await renderModelToVault(this.app, templates, model, outRoot, false, onStep,
							it.kinds ?? undefined, seen, () => this.isSourceCancelled(op));
					}
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
					stats[key] = {
						...stats[key],
						rendered,
						units: Object.fromEntries(seen),
						notes: expectedNotePaths(model, outRoot, canonicalRoot, canonicalId).length,
						schema: Number(model.schema ?? 0),
						render: requiredRenderVersion(String(model.work.collection ?? "")),
					};
				} catch (e) {
					if (this.isSourceCancelled(op)) break;
					console.error("[midad-arabic-sources] scoped render", it.work.key, e);
				}
			}
		} finally {
			notice.hide();
			await this.saveSourceStats(stats);
			const cancelled = this.isSourceCancelled(op);
			this.endSourceOperation(op);
			if (cancelled) new Notice("Stopped updating sources.");
		}
	}

	/** Restore anything incomplete and re-render notes that predate the template. */
	/**
	 * Record the current template hashes and re-render only the sources a change
	 * affects. Cheap (unaffected works are not read), so it is safe to call from
	 * the poll and the command as well as from maintainSources.
	 */
	async applyTemplateChanges(kind: "explicit" | "auto" = "explicit"): Promise<number> {
		const { changed: changedKeys, yamlOnly } = await this.recordSourceTemplate();
		const stale = await this.findStaleSourceWorks();
		const indexDirty = changedKeys.some((k) => k === "moc" || k === "sources");
		if (!stale.length && !indexDirty) return 0;
		await this.renderStaleScoped(stale.map((s) => ({ work: s.work, kinds: s.kinds })), kind, yamlOnly);
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
			const changed = Object.entries(hashes).some(([k, h]) => h.hash && store.templates[k]?.hash !== h.hash);
			if (changed) await this.applyTemplateChanges("auto");
		} catch { /* templates unavailable */ } finally {
			this.templateCheckRunning = false;
		}
	}

	/** Set while a maintenance pass is running, so a reload cannot stack a second. */
	private maintenanceInFlight = false;
	/** Set while the update-consent prompt is open, for the same reason. */
	private awaitingSourceConsent = false;

	async maintainSources(): Promise<void> {
		// Two passes at once re-fetch and re-render the same works, competing for the
		// transliteration service and writing the same notes over each other — a reload
		// while a pass was still running used to start exactly that duplicate. The pass
		// is self-healing, so skipping one loses nothing: the next one picks it up.
		if (this.maintenanceInFlight || this.awaitingSourceConsent) return;
		this.maintenanceInFlight = true;
		try {
			await this.maintainSourcesOnce();
		} finally {
			this.maintenanceInFlight = false;
		}
	}

	async maintainSourcesOnce(): Promise<void> {
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
		const { changed: changedKeys, yamlOnly } = await this.recordSourceTemplate();
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
					await this.reinstallSource(it.work, "auto");
				} catch (e) {
					console.error("[midad-arabic-sources] restore", it.work.key, e);
				}
			}
			// Stale works: only the unit kinds whose template changed, plus the hub.
			for (const s of stale) rerender.push({ work: s.work, kinds: s.kinds });
			await this.renderStaleScoped(rerender, "auto", yamlOnly && incomplete.length === 0);
			if (indexDirty) await this.refreshSourcesIndex();
		};
		if (this.settings.autoUpdateSourceTemplates === true) {
			await apply();
		} else if (this.settings.autoUpdateSourceTemplates === false) {
			return;
		} else {
			// Hold the guard while the prompt is open, so another pass cannot stack
			// behind it and ask the same question twice.
			this.awaitingSourceConsent = true;
			new SourceTemplateUpdateConsentModal(this.app, incomplete.length + stale.length + (indexDirty ? 1 : 0), (choice) => {
				void (async () => {
					try {
						if (choice === "yes") {
							this.settings.autoUpdateSourceTemplates = true;
							await this.saveSettings();
							await apply();
						} else if (choice === "no") {
							this.settings.autoUpdateSourceTemplates = false;
							await this.saveSettings();
						}
					} finally {
						this.awaitingSourceConsent = false;
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
				const config = this.llmConfigForTask("transliteration");
				if (!config) {
					new Notice("Add an LLM configuration in Settings → Midad Arabic Sources → LLM.");
					return null;
				}
				path = "/romanize";
				body.provider = config.provider;
				body.model = config.model;
				body.keep_case = opts.fullVocalization;
				body.name = this.settings.nameMode;
				if (config.baseUrl) body.base_url = config.baseUrl;
				if (config.apiKey) body.api_key = config.apiKey;
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

	async health(): Promise<{ pid?: number; engines_loaded?: string[]; engines_actual?: Record<string, string>; providers?: Record<string, boolean> } | null> {
		try {
			const res = await requestUrl({ url: this.baseUrl() + "/health", method: "GET" });
			return res.json as { pid?: number; engines_loaded?: string[]; engines_actual?: Record<string, string>; providers?: Record<string, boolean> } | null;
		} catch {
			return null;
		}
	}

	/** True once we have told the user the server fell back from bert to mle. */
	engineFallbackWarned = false;

	/**
	 * If bert was requested but the server is actually running on mle (bert could
	 * not load — no `transformers` or no model data), say so once, with the fix.
	 */
	async maybeWarnEngineFallback(): Promise<void> {
		if (this.engineFallbackWarned) return;
		const actual = (await this.health())?.engines_actual;
		if (!actual || !actual.bert || actual.bert === "bert") return;
		this.engineFallbackWarned = true;
		new Notice(
			"Transliteration is using the MLE engine because BERT could not be loaded. " +
			"For best results, install `transformers` and the BERT model data " +
			"(`camel_data -i disambig-bert-unfactored-msa`), then restart the transliteration server.",
			15000,
		);
	}

	/** One line describing the resident server, plus the action it calls for. */
	async serverStatusSummary(): Promise<{ running: boolean; action: "start" | "stop"; text: string }> {
		const h = await this.health();
		if (!h) {
			return { running: false, action: "start", text: `Not running at ${this.settings.serverUrl}.` };
		}
		const engines = h.engines_loaded?.join(", ") || "none loaded yet";
		const actual = h.engines_actual ?? {};
		const fallback = actual.bert && actual.bert !== "bert" ? ` — bert unavailable, running ${actual.bert}` : "";
		const providers = h.providers
			? Object.entries(h.providers).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"
			: "unknown";
		return {
			running: true, action: "stop",
			text: `Running at ${this.settings.serverUrl}. Engines: ${engines}${fallback}. LLM providers: ${providers}.`,
		};
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
		// Resolve an interpreter that can import CAMeL (configured path first, then
		// the same candidates ScholarWeft probes). Using bare `python3` here is what
		// made a GUI-launched process miss a conda install.
		const python = await this.resolveServerPython();
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
					await this.maybeWarnEngineFallback();
					return;
				}
			}
			let tail = "";
			try {
				tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-4).join("\n");
			} catch { /* ignore */ }
			new Notice(
				"The transliteration server did not start."
					+ (tail ? `\n\n${tail}` : "")
					+ "\n\nIf it mentions a missing module, set the Python path under Transliteration → Python path.",
				20000,
			);
		} finally {
			loading.hide();
		}
	}

	/** Stop the transliteration service we started, or one matching the script path. */
	async stopTransliterationServer(): Promise<void> {
		// Prefer the PID we spawned; otherwise ask the server for its own PID. This
		// avoids `pkill`-by-name, which would also kill a server another window or a
		// terminal started.
		let pid = this.translitServerPid;
		if (pid == null) {
			const reported = (await this.health())?.pid;
			if (typeof reported === "number") pid = reported;
		}
		let found = true;
		if (pid != null) {
			try {
				process.kill(-pid);
			} catch {
				try { process.kill(pid); } catch { /* already gone */ }
			}
			this.translitServerPid = null;
		} else {
			// Last resort: match this plugin's resolved script path, not a bare name.
			const script = this.resolveScript(this.settings.transliterationServerScript || "scripts/transliterate-server.py");
			found = await new Promise<boolean>((resolve) => {
				execFile("pkill", ["-f", script], (err: unknown) => resolve(!err));
			});
		}
		// Wait for the port to close, so a caller's status refresh sees it down
		// (the kill is asynchronous; refreshing immediately would still look "up").
		for (let i = 0; i < 20; i++) {
			if (!(await this.health())) break;
			await new Promise((resolve) => window.setTimeout(resolve, 150));
		}
		new Notice(found ? "Transliteration server stopped." : "No running transliteration server found.");
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
		const data = (await this.loadData()) as Partial<MidadArabicSourcesSettings> | null;
		const hadSourceRoot = typeof data?.sourceRoot === "string" && !!data.sourceRoot.trim();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		if (!hadSourceRoot) {
			if (data) {
				const oldRoot = (data.sourceImportRoot || "_7 Sources").trim();
				this.settings.sourceRoot = oldRoot;
				this.settings.sourceImportRoot = normalizePath(`${oldRoot}/Installed Sources`);
				this.settings.annotationNoteFolder = normalizePath(`${oldRoot}/Annotation Notes`);
				this.settings.canonicalQuranFolder = normalizePath(`${oldRoot}/Installed Sources/Quran`);
				this.settings.sourceLayoutMigrated = false;
				this.sourceLayoutLegacy = {
					installedRoot: oldRoot,
					annotationNotes: (data.annotationNoteFolder || `${oldRoot}/Notes`).trim(),
				};
			} else {
				this.settings.sourceRoot = "Midad Arabic Sources";
				this.settings.sourceImportRoot = "Midad Arabic Sources/Installed Sources";
				this.settings.annotationNoteFolder = "Midad Arabic Sources/Annotation Notes";
				this.settings.canonicalQuranFolder = "Midad Arabic Sources/Installed Sources/Quran";
				this.settings.sourceLayoutMigrated = true;
				this.sourceLayoutLegacy = null;
			}
		} else {
			this.settings.sourceRoot = (data?.sourceRoot || this.settings.sourceRoot).trim() || "Midad Arabic Sources";
			this.settings.sourceImportRoot = (data?.sourceImportRoot || `${this.settings.sourceRoot}/Installed Sources`).trim();
			this.settings.annotationNoteFolder = (data?.annotationNoteFolder || `${this.settings.sourceRoot}/Annotation Notes`).trim();
			this.settings.canonicalQuranFolder = (data?.canonicalQuranFolder || `${this.settings.sourceImportRoot}/Quran`).trim();
		}
		await this.ensureLlmSettings();
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

/** Start or stop the resident transliteration server, with its current status. */
class TransliterationServerModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	private statusEl!: HTMLElement;
	private button: ButtonComponent | null = null;
	private running = false;

	constructor(app: App, plugin: MidadArabicSourcesPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Transliteration server" });
		this.statusEl = this.contentEl.createEl("p", { text: "Checking…" });
		new Setting(this.contentEl).addButton((button) => {
			this.button = button;
			button.onClick(async () => {
				button.setDisabled(true);
				if (this.running) await this.plugin.stopTransliterationServer();
				else await this.plugin.startTransliterationServer();
				button.setDisabled(false);
				await this.refresh();
				await this.plugin.maybeWarnEngineFallback();
			});
		});
		void this.refresh();
	}

	async refresh(): Promise<void> {
		const status = await this.plugin.serverStatusSummary();
		this.running = status.running;
		this.statusEl.setText(status.text);
		this.button?.setButtonText(status.running ? "Stop server" : "Start server");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TransliterateModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	text: string;
	onDone: (romanized: string) => Promise<void> | void;
	useLlm: boolean;
	fullVocalization: boolean;

	constructor(
		app: App,
		plugin: MidadArabicSourcesPlugin,
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
	plugin: MidadArabicSourcesPlugin;
	unknown: LexiconGuess[];
	inputs: Array<{ term: string; comp: TextComponent }> = [];
	onSaved: (() => Promise<void> | void) | null;

	constructor(
		app: App,
		plugin: MidadArabicSourcesPlugin,
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

class MidadArabicSourcesSettingTab extends PluginSettingTab {
	plugin: MidadArabicSourcesPlugin;
	/** The one-shot local-Zotero probe has run (see probeZotero). */
	private zoteroProbed = false;

	constructor(app: App, plugin: MidadArabicSourcesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Read a control's value. The tri-state "Update notes when templates change"
	 * setting is stored as `boolean | undefined` but shown as a dropdown.
	 */
	getControlValue(key: string): unknown {
		if (key === "autoUpdateSourceTemplates") {
			const v = this.plugin.settings.autoUpdateSourceTemplates;
			return v === true ? "yes" : v === false ? "no" : "ask";
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "autoUpdateSourceTemplates") {
			settings[key] = value === "ask" ? undefined : value === "yes";
		} else {
			settings[key] = value;
		}
		// A new interpreter invalidates the cached probe result.
		if (key === "pythonPath") {
			this.plugin.pythonPromise = null;
			this.plugin.serverPythonPromise = null;
		}
		await this.plugin.saveSettings();
		// Re-evaluate the rows whose visibility depends on this value.
		if (key === "zoteroExport" || key === "zoteroMethod") this.refreshDomState();
		if (key === "zoteroAutoCreate" && value === true) void this.plugin.autoSyncZotero();
	}

	/** Changing the root moves the plugin folders, after confirmation when needed. */
	renderSourceRoot(setting: Setting): void {
		setting.controlEl.empty();
		const current = this.plugin.settings.sourceRoot || "Midad Arabic Sources";
		let value = current;
		const text = new TextComponent(setting.controlEl);
		text.setValue(value).onChange((v) => { value = v; });
		text.inputEl.setCssStyles({ width: "18em" });
		text.inputEl.addEventListener("change", () => {
			const next = value.trim() || "Midad Arabic Sources";
			if (next === this.plugin.settings.sourceRoot) return;
			void (async () => {
				const sourceAbs = `${this.plugin.vaultPath()}/${this.plugin.sourcesRoot()}`;
				const targetAbs = `${this.plugin.vaultPath()}/${next}`;
				let sourceHasFiles = false;
				let targetHasFiles = false;
				try { sourceHasFiles = fs.existsSync(sourceAbs) && fs.readdirSync(sourceAbs).length > 0; } catch { /* ignore */ }
				try { targetHasFiles = fs.existsSync(targetAbs) && fs.readdirSync(targetAbs).length > 0; } catch { /* ignore */ }
				if (sourceHasFiles || targetHasFiles) {
					const ok = await new Promise<boolean>((resolve) => {
						new SourceRootMoveModal(this.app, next, sourceHasFiles, targetHasFiles, resolve).open();
					});
					if (!ok) {
						text.setValue(current);
						value = current;
						return;
					}
				}
				await this.plugin.moveSourceRoot(next);
				this.update();
			})().catch((e) => {
				console.error("[midad-arabic-sources] move source root", e);
				new Notice("Could not move the source folders — see the developer console.");
			});
		});
	}

	/** Add a reusable LLM endpoint/key/model configuration. */
	addLlmConfig(): void {
		const configs = this.plugin.settings.llmConfigs ?? [];
		const id = `llm-${Date.now().toString(36)}`;
		configs.push({
			id,
			name: `Configuration ${configs.length + 1}`,
			provider: "gemini",
			model: "gemini-3.5-flash-lite",
			apiKey: "",
			baseUrl: "",
		});
		this.plugin.settings.llmConfigs = configs;
		void this.plugin.saveSettings();
	}

	renderLlmConfigCard(container: HTMLElement, config: LlmConfig, configs: LlmConfig[]): void {
		const card = container.createDiv({ cls: "mas-llm-config-card" });
		new Setting(card)
			.setName("Name")
			.addText((text) => {
				text.setValue(config.name).onChange(async (value) => {
					config.name = value.trim() || "Untitled configuration";
					await this.plugin.saveSettings();
				});
				text.inputEl.setCssStyles({ width: "100%" });
			});
		new Setting(card)
			.setName("Provider")
			.setDesc("Gemini for transcription/translation; all three providers are available for transliteration.")
			.addDropdown((dropdown) => {
				for (const [value, label] of [
					["gemini", "Gemini"],
					["deepseek", "DeepSeek"],
					["openai", "OpenAI-compatible"],
				] as const) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(config.provider);
				dropdown.onChange(async (value) => {
					config.provider = value as LlmProvider;
					await this.plugin.saveSettings();
					await this.plugin.ensureLlmSettings();
					this.update();
				});
			});
		new Setting(card)
			.setName("Model")
			.setDesc("The model identifier for the selected provider.")
			.addText((text) => {
				text.setValue(config.model).onChange(async (value) => {
					config.model = value.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.setCssStyles({ width: "100%" });
			});
		new Setting(card)
			.setName("API key")
			.addText((text) => {
				text.setValue(config.apiKey).onChange(async (value) => {
					config.apiKey = value.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = "password";
				text.inputEl.setCssStyles({ width: "100%" });
			});
		if (config.provider === "openai") {
			new Setting(card)
				.setName("Base URL")
				.setDesc("The endpoint for an OpenAI-compatible provider; leave blank to use its environment default.")
				.addText((text) => {
					text.setValue(config.baseUrl).onChange(async (value) => {
						config.baseUrl = value.trim();
						await this.plugin.saveSettings();
					});
					text.inputEl.setCssStyles({ width: "100%" });
				});
		}
		new Setting(card).addButton((button) =>
			button
				.setButtonText("Delete configuration")
				.setDisabled(configs.length <= 1)
				.onClick(async () => {
					this.plugin.settings.llmConfigs = configs.filter((c) => c.id !== config.id);
					await this.plugin.saveSettings();
					await this.plugin.ensureLlmSettings();
					this.update();
				})
		);
	}

	renderLlmConfigs(setting: Setting): void {
		// Obsidian may invoke a definition's render more than once on the same
		// element. Rebuild our own container instead of appending to it, or the
		// cards (and Add button) multiply on every pass.
		setting.settingEl.querySelectorAll(":scope > .mas-llm-configs-dynamic").forEach((el) => el.remove());
		const dynamic = setting.settingEl.createDiv({ cls: "mas-llm-configs-dynamic" });
		const actions = dynamic.createDiv({ cls: "mas-llm-config-actions" });
		new ButtonComponent(actions)
			.setButtonText("Add LLM configuration")
			.setCta()
			.onClick(() => {
				this.addLlmConfig();
				this.update();
			});
		const configs = this.plugin.settings.llmConfigs ?? [];
		const list = dynamic.createDiv({ cls: "mas-llm-config-list" });
		if (!configs.length) {
			list.createEl("p", { text: "No LLM configurations yet." });
			return;
		}
		for (const config of configs) this.renderLlmConfigCard(list, config, configs);
	}

	renderLlmTask(setting: Setting, task: LlmTask): void {
		// Same duplicate-render guard for the task dropdown.
		setting.controlEl.empty();
		const configs = this.plugin.settings.llmConfigs ?? [];
		const eligible = task === "transliteration"
			? configs
			: configs.filter((config) => config.provider === "gemini");
		setting.addDropdown((dropdown) => {
			if (!eligible.length) {
				dropdown.addOption("", "No eligible configuration");
				dropdown.setDisabled(true);
				return;
			}
			for (const config of eligible) {
				dropdown.addOption(config.id, `${config.name || "Untitled configuration"} — ${config.provider}/${config.model}`);
			}
			const assignments = this.plugin.settings.llmAssignments;
			const current = assignments?.[task] ?? "";
			const selected = eligible.some((config) => config.id === current) ? current : eligible[0].id;
			dropdown.setValue(selected);
			if (selected !== current && assignments) {
				assignments[task] = selected;
				void this.plugin.saveSettings();
			}
			dropdown.onChange(async (value) => {
				if (this.plugin.settings.llmAssignments) {
					this.plugin.settings.llmAssignments[task] = value;
					await this.plugin.saveSettings();
				}
			});
		});
	}

	/** Fill the library ID from a running local Zotero, then refresh the rows. */
	async detectZotero(): Promise<void> {
		const found = await this.plugin.detectZoteroLocal();
		if (!found) {
			new Notice("No local Zotero found on port 23119.");
			return;
		}
		this.plugin.settings.zoteroLibraryId = String(found.libraryId);
		this.plugin.settings.zoteroServerId = found.serverId;
		await this.plugin.saveSettings();
		this.update();
		new Notice(`Local Zotero: library ${found.libraryId}.`);
	}

	/**
	 * Probe the local Zotero once (when the settings are first shown), filling the
	 * library ID if Zotero is running and none is stored. The Detect button does
	 * the same on demand; this just spares the user the click.
	 */
	private probeZotero(): void {
		if (this.zoteroProbed) return;
		this.zoteroProbed = true;
		void this.plugin.detectZoteroLocal().then(async (found) => {
			if (!found || this.plugin.settings.zoteroLibraryId) return;
			this.plugin.settings.zoteroLibraryId = String(found.libraryId);
			this.plugin.settings.zoteroServerId = found.serverId;
			await this.plugin.saveSettings();
			this.update();
		});
	}

	/**
	 * The settings, grouped into one section per function. Declarative, so the
	 * sections appear in Obsidian's settings search (1.13+).
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.probeZotero();
		const zoteroOn = () => this.plugin.settings.zoteroExport;
		const zoteroWeb = () => zoteroOn() && this.plugin.settings.zoteroMethod === "web";
		const password = (get: () => string, set: (v: string) => void) =>
			(setting: Setting) => {
				setting.addText((text) => {
					text.setValue(get()).onChange(async (value) => {
						set(value.trim());
						await this.plugin.saveSettings();
					});
					text.inputEl.type = "password";
				});
			};
		const doc = (label: string, file: string, desc: string) => ({
			name: label,
			desc,
			action: () => { openDocs(this.app, file); },
		});

		const pages: SettingDefinitionItem[] = [
			{
				type: "page",
				name: "General",
				desc: "Where the plugin keeps its source folders.",
				items: [
					{
						name: "Sources folder",
						desc: "Root folder for Installed Sources, Transcriptions, Translations, and Annotation Notes. “Move folders here” moves the existing plugin-owned folders to the new root.",
						render: (setting: Setting) => this.renderSourceRoot(setting),
					},
					{
						name: "Source registry",
						desc: "Rebuild .midad-arabic-sources/sources.json, the unified index of repository works, Zotero items, transcriptions, translations, and adopted notes.",
						render: (setting: Setting) => {
							setting.addButton((button) => button
								.setButtonText("Rebuild registry")
								.onClick(async () => {
									await this.plugin.refreshSourceRegistry();
									new Notice("Source registry rebuilt.");
								}));
						},
					},
				],
			},
			{
				type: "page",
				name: "Transliteration",
				desc: "Romanize Arabic: the resident server, the engine, and the naming options.",
				items: [
					{
						name: "Transliteration server",
						render: (setting: Setting) => {
							const status = setting.descEl.createDiv({ text: "Checking…" });
							let running = false;
							setting.addButton((button) => {
								const refresh = async () => {
									const s = await this.plugin.serverStatusSummary();
									running = s.running;
									status.setText(s.text);
									button.setButtonText(s.running ? "Stop server" : "Start server");
								};
								button.onClick(async () => {
									button.setDisabled(true);
									if (running) await this.plugin.stopTransliterationServer();
									else await this.plugin.startTransliterationServer();
									button.setDisabled(false);
									await refresh();
									await this.plugin.maybeWarnEngineFallback();
								});
								void refresh();
							});
						},
					},
					{
						name: "Server URL",
						desc: "Address of the resident transliteration service.",
						control: { type: "text", key: "serverUrl", placeholder: "http://127.0.0.1:8756" },
					},
					{
						name: "Server script",
						desc: "Path (relative to the vault) of transliterate-server.py, used by the start/stop commands.",
						control: { type: "text", key: "transliterationServerScript" },
					},
					{
						name: "Engine",
						desc: "BERT (default): best for unvocalized prose; this is what the plugin is tuned for. MLE: opt-in only, rougher on classical text, and requires the calima MLE data. None: no CAMeL; fully vocalized text only.",
						control: { type: "dropdown", key: "engine", options: { bert: "bert", mle: "mle", none: "none" } },
					},
					{
						name: "Sun-letter assimilation",
						desc: "Assimilate the article before sun letters (off means invariant al-).",
						control: { type: "toggle", key: "sunLetters" },
					},
					{
						name: "Keep case endings",
						desc: "Retain noun/adjective case endings and tanwīn (used automatically inside Qur’an spans).",
						control: { type: "toggle", key: "keepCase" },
					},
					{
						name: "Name mode",
						desc: "Capitalize each substantive word (for author/editor name fields).",
						control: { type: "toggle", key: "nameMode" },
					},
					{
						name: "Final dotless yāʾ",
						desc: "How to read a final dotless yāʾ (ى).",
						control: {
							type: "dropdown",
							key: "dotlessYa",
							options: { maqsura: "alif maqṣūra (ā)", ya: "let the analysis choose" },
						},
					},
					doc("Transliteration guide", "transliteration.md", "Commands, engines, the server, the lexicon, and LLM romanization."),
				],
			},
			{
				type: "page",
				name: "LLM",
				desc: "Reusable model and API-key configurations, and which configuration each feature uses.",
				items: [
					{
						name: "Configurations",
						desc: "Add one configuration per model or API key. A configuration can be shared by several tasks.",
						render: (setting: Setting) => this.renderLlmConfigs(setting),
					},
					{
						name: "Transliteration",
						desc: "Configuration used when “Use LLM” is checked. All providers are available for romanization.",
						render: (setting: Setting) => this.renderLlmTask(setting, "transliteration"),
					},
					{
						name: "Transcription",
						desc: "Configuration used for PDF OCR. The PDF pipeline uses Gemini’s Batch API, so only Gemini configurations can run it; other providers remain available for transliteration.",
						render: (setting: Setting) => this.renderLlmTask(setting, "transcription"),
					},
					{
						name: "Translation",
						desc: "Configuration used for translating transcriptions. The PDF pipeline uses Gemini’s Batch API, so only Gemini configurations can run it.",
						render: (setting: Setting) => this.renderLlmTask(setting, "translation"),
					},
				],
			},
			{
				type: "page",
				name: "Transcription and translation",
				desc: "The Gemini OCR and translation pipeline for scanned PDFs.",
				items: [
					{
						name: "Python executable",
						desc: "Python used to run the Gemini batch pipeline scripts. Leave blank to auto-detect.",
						control: { type: "text", key: "pythonPath", placeholder: "Auto-detect" },
					},
					{
						name: "Pipeline script",
						desc: "Path (relative to the vault) of the Midad Arabic Sources pipeline orchestrator.",
						control: { type: "text", key: "pipelineScript" },
					},
					{
						name: "Gemini API key",
						desc: "Passed to the pipeline as GEMINI_API_KEY. Needed when Obsidian was launched without shell environment variables.",
						render: password(
							() => this.plugin.settings.geminiApiKey,
							(v) => { this.plugin.settings.geminiApiKey = v; }
						),
					},
					doc("Transcription guide", "transcription.md", "The Gemini OCR pipeline, its post-processing, status, and reprocessing."),
					doc("Translation guide", "translation.md", "Translating a finished transcription."),
				],
			},
			{
				type: "page",
				name: "Source import from repository",
				desc: "Install, name, and maintain imported text sources.",
				items: [
					{
						name: "Importer script",
						desc: "Path (relative to the vault) of the catalog-driven importer script.",
						control: { type: "text", key: "sourceImportScript" },
					},
					{
						name: "Template folder",
						desc: "Vault folder holding your edited import templates (blank = bundled defaults). Use “Copy import templates to vault”.",
						control: { type: "text", key: "sourceTemplateFolder", placeholder: "Templates" },
					},
					{
						name: "Canonical Qurʾān riwāya",
						desc: "Riwāya whose sūra notes are unprefixed (the main reference). Set once, to the first riwāya you install; edit here to switch. Qurʾān citation linking in source notes requires Ḥafṣ (hafs): almost all source texts quote the Ḥafṣ reading, so citations cannot be matched against another riwāya.",
						control: { type: "text", key: "canonicalQuranRiwāya", placeholder: "Ḥafṣ" },
					},
					{
						name: "Sources parent note",
						desc: "Top-level note every category MOC points up to. The default is the existing Midad Arabic Sources note; other names are kept in the sources folder.",
						control: { type: "text", key: "sourceMocParent", placeholder: "Midad Arabic Sources" },
					},
					{
						name: "Update notes when templates change",
						desc: "Re-render imported source notes automatically when an import template changes.",
						control: {
							type: "dropdown",
							key: "autoUpdateSourceTemplates",
							options: { ask: "Ask", yes: "Always", no: "Never" },
						},
					},
					{
						name: "Check repositories every … days",
						desc: "How often to ask the repositories whether an imported text changed (0 = only on the command).",
						control: { type: "number", key: "sourceUpdateCheckDays", defaultValue: 7, placeholder: "7", min: 0 },
					},
					doc("Document import guide", "document-import.md", "Collections, the Manage text sources dialogue, naming, and updates."),
					doc("Templates guide", "templates.md", "The ETA templates and the render-model reference."),
				],
			},
			{
				type: "page",
				name: "Annotations",
				desc: "Highlights, comments, the annotation note, and the Source Annotations MOC.",
				items: [
					{
						name: "Annotate on selection",
						desc: "Open the annotation dialog when text is selected inside a source note, after a short pause. Copying or opening the context menu suppresses it.",
						control: { type: "toggle", key: "annotateOnSelection" },
					},
					{
						name: "Default annotation colour",
						desc: "Colour selected when the annotation dialog opens.",
						control: {
							type: "dropdown",
							key: "annotationDefaultColor",
							options: {
								yellow: "Yellow",
								orange: "Orange",
								red: "Red",
								purple: "Purple",
								magenta: "Magenta",
								blue: "Blue",
								green: "Green",
								gray: "Gray",
							},
						},
					},
					{
						name: "Annotation trash retention (days)",
						desc: "How long deleted annotations and their notes stay in the plugin trash before permanent removal.",
						control: { type: "number", key: "annotationTrashDays", defaultValue: 30, placeholder: "30", min: 1 },
					},
					{
						name: "Annotation maintenance",
						desc: "Open the annotation trash, re-anchor orphans in the active source, or open the Midad sidebar.",
						render: (setting: Setting) => {
							setting.addButton((button) => button
								.setButtonText("Open trash")
								.onClick(() => {
									if (this.plugin.annotations) new AnnotationTrashModal(this.app, this.plugin.annotations).open();
									else new Notice("The annotation layer is not running.");
								}));
							setting.addButton((button) => button
								.setButtonText("Re-anchor active source")
								.onClick(async () => { await this.plugin.annotations?.reanchorActiveSource(); }));
							setting.addButton((button) => button
								.setButtonText("Open Midad sidebar")
								.onClick(() => { void this.plugin.annotations?.openSidebar(); }));
						},
					},
				],
			},
			{
				type: "page",
				name: "Zotero",
				desc: "Send imported works to your Zotero library, and keep them up to date.",
				items: [
					{
						name: "Enable Zotero export",
						desc: "Adds commands that send imported sources to Zotero.",
						control: { type: "toggle", key: "zoteroExport" },
					},
					{
						name: "Method",
						desc: "Local API writes to the Zotero on this computer; Web API writes to your online library; CSL-JSON downloads a file you import by hand.",
						visible: zoteroOn,
						control: {
							type: "dropdown",
							key: "zoteroMethod",
							options: {
								local: "Local API (this computer)",
								web: "Web API (zotero.org)",
								csl: "CSL-JSON file (manual import)",
							},
						},
					},
					{
						name: "Zotero library ID",
						desc: "Detected from the local Zotero when it is running; otherwise enter your numeric user (or group) ID.",
						visible: zoteroWeb,
						control: { type: "text", key: "zoteroLibraryId", placeholder: "649" },
					},
					{
						name: "Zotero web API key",
						desc: "From Zotero.org/settings/keys, with write access. Stored in this vault’s plugin data.",
						visible: zoteroWeb,
						render: password(
							() => this.plugin.settings.zoteroApiKey,
							(v) => { this.plugin.settings.zoteroApiKey = v; }
						),
					},
					{
						name: "Detect local Zotero",
						desc: "Fill the library ID from a running local Zotero.",
						visible: zoteroWeb,
						action: () => { void this.detectZotero(); },
					},
					{
						name: "Keep Zotero items up to date",
						desc: "Re-send an already-exported item whenever its bibliographic fields change — after a re-fetch, or an edit to the publication map. Items update in place; a plain template re-render changes nothing.",
						visible: zoteroOn,
						control: { type: "toggle", key: "zoteroAutoUpdate" },
					},
					{
						name: "Create Zotero items for all sources",
						desc: "Send every installed source to Zotero automatically, without asking; an item you deleted there is recreated.",
						visible: zoteroOn,
						control: { type: "toggle", key: "zoteroAutoCreate" },
					},
					doc("Zotero guide", "zotero.md", "Methods, the collection and tag, update-in-place, and the publication map."),
				],
			},
			{
				type: "page",
				name: "Documentation",
				desc: "Read the plugin's guides in Obsidian.",
				items: [
					{
						name: "Open documentation",
						desc: "Read the plugin's guides in Obsidian.",
						action: () => { openDocs(this.app); },
					},
					...getDocs().map((entry) => ({
						name: entry.title,
						desc: entry.name === "README.md" ? "The plugin at a glance." : `docs/${entry.name}`,
						action: () => { openDocs(this.app, entry.name); },
					})),
				],
			},
		];
		const order = [
			"General",
			"LLM",
			"Transliteration",
			"Transcription and translation",
			"Source import from repository",
			"Annotations",
			"Zotero",
			"Documentation",
		];
		return [...pages].sort((a, b) => {
			const an = String((a as { name?: string }).name ?? "");
			const bn = String((b as { name?: string }).name ?? "");
			const ai = order.indexOf(an);
			const bi = order.indexOf(bn);
			return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
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
	plugin: MidadArabicSourcesPlugin;
	task: LlmTask;

	constructor(app: App, plugin: MidadArabicSourcesPlugin, task: LlmTask) {
		super(app);
		this.plugin = plugin;
		this.task = task;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "LLM configuration required" });
		contentEl.createEl("p", {
			text: `The ${this.task} feature has no usable API key in its selected configuration.`,
		});
		contentEl.createEl("p", {
			text: "Add a configuration and assign it to this task under Settings → Midad Arabic Sources → LLM. A key can also come from GEMINI_API_KEY / GOOGLE_API_KEY in the environment Obsidian was launched from.",
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
	plugin: MidadArabicSourcesPlugin;
	state: PipelineState;

	constructor(app: App, plugin: MidadArabicSourcesPlugin, state: PipelineState) {
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

/** A unique display name for a copied prompt. */
function uniquePromptName(base: string, entries: PromptEntry[]): string {
	const taken = new Set(entries.map((e) => e.name));
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base} ${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * The prompt dropdown plus its action buttons, shared by the transcription and
 * translation dialogs. It owns the "Select all"/"Select none" buttons too, so
 * the dropdown sits to their left as one row.
 */
class PromptPicker {
	plugin: MidadArabicSourcesPlugin;
	kind: PromptKind;
	containerEl: HTMLElement;
	entries: PromptEntry[];
	selectedName: string;
	onSelectAll?: () => void;
	onSelectNone?: () => void;
	deleteButton: ButtonComponent | null = null;

	constructor(
		plugin: MidadArabicSourcesPlugin,
		kind: PromptKind,
		containerEl: HTMLElement,
		entries: PromptEntry[],
		opts: { onSelectAll?: () => void; onSelectNone?: () => void } = {}
	) {
		this.plugin = plugin;
		this.kind = kind;
		this.containerEl = containerEl;
		this.entries = entries;
		this.onSelectAll = opts.onSelectAll;
		this.onSelectNone = opts.onSelectNone;
		const builtin = entries.find((e) => e.builtin);
		this.selectedName = builtin?.name ?? entries[0]?.name ?? "";
		this.render();
	}

	selectedEntry(): PromptEntry | null {
		return this.entries.find((e) => e.name === this.selectedName) ?? this.entries[0] ?? null;
	}

	render(): void {
		this.containerEl.empty();

		const row = new Setting(this.containerEl).setName("Prompt");
		row.addDropdown((dd) => {
			for (const p of this.entries) dd.addOption(p.name, p.name);
			dd.setValue(this.selectedName);
			dd.onChange((value) => {
				this.selectedName = value;
				this.updateDeleteButton();
			});
		});
		if (this.onSelectAll || this.onSelectNone) {
			row.addButton((b) => b.setButtonText("Select all").onClick(() => this.onSelectAll?.()));
			row.addButton((b) => b.setButtonText("Select none").onClick(() => this.onSelectNone?.()));
		}

		const actions = new Setting(this.containerEl).setName("Manage prompts");
		actions.addButton((b) => b.setButtonText("Modify selected").onClick(() => this.openEditor("edit")));
		actions.addButton((b) =>
			b.setButtonText("Create a new prompt from selected").onClick(() => this.openEditor("new"))
		);
		actions.addButton((b) => {
			this.deleteButton = b;
			b.setButtonText("Delete selected prompt").onClick(() => {
				void this.deleteSelected().catch((e) => {
					console.error("[midad-arabic-sources] delete prompt", e);
					new Notice("Could not delete the prompt — see the developer console.");
				});
			});
		});
		this.updateDeleteButton();
	}

	updateDeleteButton(): void {
		this.deleteButton?.setDisabled(this.selectedEntry()?.builtin === true);
	}

	private openEditor(mode: "edit" | "new"): void {
		const source = this.selectedEntry();
		if (!source) return;
		const initialName =
			mode === "new" ? uniquePromptName(`${source.name} copy`, this.entries) : source.name;
		new PromptEditorModal(this.plugin, this.kind, mode, source, initialName, async (savedName) => {
			this.entries = await this.plugin.loadPromptSet(this.kind);
			this.selectedName = this.entries.some((e) => e.name === savedName)
				? savedName
				: this.entries.find((e) => e.builtin)?.name ?? this.entries[0]?.name ?? "";
			this.render();
		}).open();
	}

	private async deleteSelected(): Promise<void> {
		const entry = this.selectedEntry();
		if (!entry || entry.builtin) return;
		const entries = await this.plugin.loadPromptSet(this.kind);
		const remaining = entries.filter((e) => e.name !== entry.name);
		await this.plugin.savePromptSet(this.kind, remaining);
		this.entries = remaining;
		this.selectedName = remaining.find((e) => e.builtin)?.name ?? remaining[0]?.name ?? "";
		this.render();
		new Notice(`Deleted prompt “${entry.name}”.`);
	}
}

/** The large editor for a prompt's name and system instruction. */
class PromptEditorModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	kind: PromptKind;
	mode: "edit" | "new";
	source: PromptEntry;
	originalName: string;
	onSaved: (name: string) => void | Promise<void>;
	name: string;
	text: string;

	constructor(
		plugin: MidadArabicSourcesPlugin,
		kind: PromptKind,
		mode: "edit" | "new",
		source: PromptEntry,
		initialName: string,
		onSaved: (name: string) => void | Promise<void>
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.kind = kind;
		this.mode = mode;
		this.source = source;
		this.originalName = source.name;
		this.onSaved = onSaved;
		this.name = initialName;
		this.text = source.text;
	}

	onOpen(): void {
		this.modalEl.addClass("mas-prompt-editor-modal");
		const { contentEl } = this;
		const kindLabel = PROMPT_KIND_LABEL[this.kind];
		contentEl.createEl("h3", {
			text: this.mode === "new" ? `New ${kindLabel} prompt` : `Edit ${kindLabel} prompt`,
		});
		contentEl.createEl("p", {
			text:
				this.mode === "edit" && this.source.builtin
					? "This is the built-in default. Save updates it in place (its name stays “Default prompt”); Save as keeps it and adds a copy under the name above. It cannot be deleted."
					: "Save replaces this prompt; Save as adds a copy under the name above.",
		});
		contentEl.createEl("p", {
			text: `The text below is appended to the pipeline's built-in page-formatting and ${kindLabel} instructions. Describe the document and any text-specific handling here.`,
		});

		new Setting(contentEl)
			.setName("Name")
			.addText((t) => {
				t.setValue(this.name).onChange((v) => (this.name = v));
				t.inputEl.setCssStyles({ width: "100%" });
			});

		const textarea = contentEl.createEl("textarea");
		textarea.value = this.text;
		textarea.spellcheck = false;
		textarea.setCssStyles({
			width: "100%",
			minHeight: "48vh",
			resize: "vertical",
			fontFamily: "var(--font-monospace)",
			fontSize: "var(--font-ui-smaller)",
			lineHeight: "1.45",
		});
		textarea.addEventListener("input", () => (this.text = textarea.value));

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Save").setCta().onClick(() => {
					void this.save(false).catch((e) => {
						console.error("[midad-arabic-sources] save prompt", e);
						new Notice("Could not save the prompt — see the developer console.");
					});
				})
			)
			.addButton((b) =>
				b.setButtonText("Save as").onClick(() => {
					void this.save(true).catch((e) => {
						console.error("[midad-arabic-sources] save prompt copy", e);
						new Notice("Could not save the prompt — see the developer console.");
					});
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	async save(asCopy: boolean): Promise<void> {
		const name = this.name.trim();
		if (!name) { new Notice("Enter a prompt name."); return; }
		if (!this.text.trim()) { new Notice("The prompt cannot be empty."); return; }
		if (asCopy && this.mode === "edit" && name === this.originalName) {
			new Notice("Enter a different name in the name field to save a copy.");
			return;
		}

		const entries = await this.plugin.loadPromptSet(this.kind);
		const existing = entries.find((e) => e.name === name);

		if (this.mode === "edit" && !asCopy) {
			const target = entries.find((e) => e.name === this.originalName);
			if (!target) { new Notice("This prompt no longer exists."); return; }
			if (!target.builtin && name !== this.originalName && existing) {
				new Notice(`A prompt named “${name}” already exists.`);
				return;
			}
			target.text = this.text;
			if (target.builtin) {
				target.name = DEFAULT_PROMPT_NAME;
				target.modified = true;
			} else {
				target.name = name;
			}
			await this.plugin.savePromptSet(this.kind, entries);
			await this.onSaved(target.name);
		} else {
			if (existing) {
				new Notice(`A prompt named “${name}” already exists.`);
				return;
			}
			entries.push({ name, text: this.text });
			await this.plugin.savePromptSet(this.kind, entries);
			await this.onSaved(name);
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TranscribeModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	citekey: string;
	pdfs: PipelinePdf[];
	prompts: PromptEntry[];
	checks: Array<{ pdf: PipelinePdf; el: HTMLInputElement; vol: TextComponent }> = [];
	picker!: PromptPicker;

	constructor(app: App, plugin: MidadArabicSourcesPlugin, citekey: string, pdfs: PipelinePdf[], prompts: PromptEntry[]) {
		super(app);
		this.plugin = plugin;
		this.citekey = citekey;
		this.pdfs = pdfs;
		this.prompts = prompts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Transcribe PDFs — @${this.citekey}` });
		contentEl.createEl("p", {
			text: "Choose the PDF file(s) to transcribe. The volume is inferred from the filename and can be edited.",
		});

		const promptRow = contentEl.createDiv();
		this.picker = new PromptPicker(this.plugin, "transcription", promptRow, this.prompts, {
			onSelectAll: () => this.checks.forEach((c) => (c.el.checked = !c.el.disabled)),
			onSelectNone: () => this.checks.forEach((c) => (c.el.checked = false)),
		});

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
					const prompt = this.picker.selectedEntry();
					if (!prompt) { new Notice("Select a prompt."); return; }
					const args = ["transcribe", "--citekey", this.citekey];
					for (const c of chosen) {
						const v = c.vol.getValue().trim();
						args.push("--pdf", v ? `${c.pdf.path}::${v}` : c.pdf.path);
					}
					const promptFile = this.plugin.writePromptFile("transcription", prompt.text);
					if (!promptFile) return;
					args.push("--prompt-file", promptFile);
					this.close();
					await this.plugin.runWithProgress("Transcribing", args);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The path Electron exposes for a file chosen from an `<input type=file>`. */
function chosenFilePath(file: File): string {
	const direct = (file as File & { path?: string }).path;
	if (direct) return direct;
	try {
		return webUtils?.getPathForFile(file) ?? "";
	} catch {
		return "";
	}
}

/** A stable, readable citekey for a PDF with no Zotero record. */
function standaloneCitekey(path: string): string {
	const name = basenameJS(path).replace(/\.pdf$/i, "");
	const slug = name
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.toLowerCase();
	return `pdf-${slug || "document"}`;
}

/** The base title from a generated `Title (transcription)` value. */
function stripTranscriptionSuffix(title: string): string {
	return title
		.replace(/\s*\((?:transcription|translation)(?:,\s*vol\.\s*\d+)?\)\s*$/i, "")
		.trim();
}

/** Pick a PDF and transcribe it without a Zotero item or literature note. */
class StandalonePdfModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	prompts: PromptEntry[];
	path = "";
	citekey = "";
	citekeyTouched = false;
	pathInput!: TextComponent;
	citekeyInput!: TextComponent;
	picker!: PromptPicker;

	constructor(app: App, plugin: MidadArabicSourcesPlugin, prompts: PromptEntry[]) {
		super(app);
		this.plugin = plugin;
		this.prompts = prompts;
	}

	onOpen(): void {
		this.modalEl.addClass("mas-standalone-pdf-modal");
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Transcribe a PDF" });
		contentEl.createEl("p", {
			text: `Choose a PDF that is not attached to a Zotero item. The transcription goes into ${this.plugin.transcriptionsFolder()}; Gemini will guess the title and author from the title page so you can check them afterwards.`,
		});

		const fileInput = contentEl.createEl("input");
		fileInput.type = "file";
		fileInput.accept = ".pdf,application/pdf";
		fileInput.setCssStyles({ display: "none" });
		fileInput.addEventListener("change", () => {
			const file = fileInput.files?.[0];
			if (!file) return;
			const path = chosenFilePath(file);
			fileInput.value = "";
			if (!path) {
				new Notice("Obsidian did not expose that file's path. Paste it into the field instead.");
				return;
			}
			this.setPath(path);
		});

		new Setting(contentEl)
			.setName("PDF file")
			.setDesc("Choose a PDF, or paste its full path.")
			.addText((t) => {
				this.pathInput = t;
				t.setPlaceholder("/Users/you/Downloads/book.pdf").onChange((v) => {
					this.path = v.trim();
					if (!this.citekeyTouched) this.setSuggestedCitekey();
				});
				t.inputEl.setCssStyles({ width: "100%" });
			})
			.addButton((b) =>
				b.setButtonText("Choose PDF…").onClick(() => fileInput.click())
			);

		new Setting(contentEl)
			.setName("Citekey")
			.setDesc("Used in the transcription's filename and links. It can be edited.")
			.addText((t) => {
				this.citekeyInput = t;
				t.setPlaceholder("Book title").onChange((v) => {
					this.citekey = v.trim().replace(/^@+/, "");
					this.citekeyTouched = true;
				});
				t.inputEl.setCssStyles({ width: "100%" });
			});

		const promptRow = contentEl.createDiv();
		this.picker = new PromptPicker(this.plugin, "transcription", promptRow, this.prompts);

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Transcribe").setCta().onClick(() => {
					void this.transcribe().catch((e) => {
						console.error("[midad-arabic-sources] standalone transcribe", e);
						new Notice("Could not start the transcription — see the developer console.");
					});
				})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	setPath(path: string): void {
		this.path = path;
		this.pathInput?.setValue(path);
		if (!this.citekeyTouched) this.setSuggestedCitekey();
	}

	setSuggestedCitekey(): void {
		if (!this.path.trim()) return;
		this.citekey = standaloneCitekey(this.path);
		this.citekeyInput?.setValue(this.citekey);
	}

	async transcribe(): Promise<void> {
		const entered = (this.pathInput?.getValue() ?? this.path).trim();
		const path = entered.startsWith("~/") ? `${os.homedir()}${entered.slice(1)}` : entered;
		if (!path) { new Notice("Choose a PDF first."); return; }
		if (!path.toLowerCase().endsWith(".pdf")) { new Notice("Choose a PDF file."); return; }
		if (!fs.existsSync(path)) { new Notice("That PDF could not be found at the selected path."); return; }

		const citekey = (this.citekeyInput?.getValue() ?? this.citekey)
			.trim()
			.replace(/^@+/, "")
			.replace(/[\\/:*?"<>|\s]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!citekey) { new Notice("Enter a citekey."); return; }
		this.citekeyInput?.setValue(citekey);

		const folder = this.plugin.transcriptionsFolder();
		const notePrefix = normalizePath(`${folder}/mas-${citekey} - transcription`);
		const existing = this.app.vault
			.getFiles()
			.find((f) => f.extension === "md" && f.path.startsWith(notePrefix));
		let existingName = existing?.name ?? "";
		if (!existingName) {
			try {
				const folderAbs = `${this.plugin.vaultPath()}/${folder}`;
				existingName = fs
					.readdirSync(folderAbs)
					.find((name) => name.startsWith(`mas-${citekey} - transcription`) && name.endsWith(".md")) ?? "";
			} catch {
				/* folder does not exist yet */
			}
		}
		if (existingName) {
			new Notice(`A transcription already exists at ${existingName}. Choose a different citekey.`);
			return;
		}

		const prompt = this.picker.selectedEntry();
		if (!prompt) { new Notice("Select a prompt."); return; }
		const promptFile = this.plugin.writePromptFile("transcription", prompt.text);
		if (!promptFile) return;

		const args = [
			"transcribe",
			"--citekey", citekey,
			"--pdf", path,
			"--standalone",
			"--prompt-file", promptFile,
		];
		this.close();
		const result = await this.plugin.runWithProgress("Transcribing PDF", args);
		const notePath = result?.notes?.[0];
		if (!notePath) return;
		const rel = vaultRelative(this.plugin.vaultPath(), notePath);
		const note = await this.waitForNote(rel);
		if (note) {
			new VerifyTranscriptionMetadataModal(this.app, note).open();
		} else {
			new Notice(`Transcription written to ${rel}. Open it to check its title and author.`);
		}
	}

	/** The pipeline writes outside Obsidian, so wait for its file watcher. */
	async waitForNote(path: string): Promise<TFile | null> {
		for (let i = 0; i < 40; i++) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) return file;
			await new Promise((resolve) => window.setTimeout(resolve, 150));
		}
		return null;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Check Gemini's title/author guess before the standalone note is kept. */
class VerifyTranscriptionMetadataModal extends Modal {
	file: TFile;
	title = "";
	author = "";
	titleInput!: TextComponent;
	authorInput!: TextComponent;
	loaded = false;

	constructor(app: App, file: TFile) {
		super(app);
		this.file = file;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Check the transcription's title and author" });
		contentEl.createEl("p", {
			text: "Gemini guessed these from the title page. Correct them if needed, then save. They fill the same bibliography fields as a Zotero-derived transcription.",
		});

		new Setting(contentEl)
			.setName("Title")
			.addText((t) => {
				this.titleInput = t;
				t.setPlaceholder("Book title").onChange((v) => (this.title = v));
				t.inputEl.setCssStyles({ width: "100%" });
			});

		new Setting(contentEl)
			.setName("Author")
			.setDesc("Separate multiple authors with semicolons.")
			.addText((t) => {
				this.authorInput = t;
				t.setPlaceholder("Author").onChange((v) => (this.author = v));
				t.inputEl.setCssStyles({ width: "100%" });
			});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Save").setCta().onClick(() => {
					void this.save(false).catch((e) => this.reportError(e));
				})
			)
			.addButton((b) =>
				b.setButtonText("Save and open").onClick(() => {
					void this.save(true).catch((e) => this.reportError(e));
				})
			)
			.addButton((b) => b.setButtonText("Skip").onClick(() => this.close()));

		void this.load();
	}

	async load(): Promise<void> {
		try {
			const text = await this.app.vault.read(this.file);
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
			const parsed = match ? parseYaml(match[1]) as unknown : {};
			const fm = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
			const rawTitle = typeof fm.title === "string" ? fm.title : "";
			const rawAuthors = fm.authors;
			const authors = Array.isArray(rawAuthors)
				? rawAuthors.map((a) => String(a))
				: typeof rawAuthors === "string" ? [rawAuthors] : [];
			this.title = stripTranscriptionSuffix(rawTitle);
			this.author = authors.join("; ");
		} catch (e) {
			console.error("[midad-arabic-sources] read transcription metadata", e);
		}
		this.loaded = true;
		this.titleInput?.setValue(this.title);
		this.authorInput?.setValue(this.author);
	}

	async save(open: boolean): Promise<void> {
		if (!this.loaded) return;
		const title = this.title.trim() || "Untitled";
		const authors = this.author
			.split(";")
			.map((a) => a.trim())
			.filter(Boolean);

		await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
			fm.title = `${title} (transcription)`;
			if (authors.length) fm.authors = authors;
			else delete fm.authors;
			const suffix = typeof fm.volume === "number" ? `transcription, vol. ${fm.volume}` : "transcription";
			const aliases = [`${title} (${suffix})`];
			if (authors.length) aliases.push(`${authors[0]} - ${title} (${suffix})`);
			fm.aliases = Array.from(new Set(aliases));
		});
		new Notice("Transcription metadata saved.");
		this.close();
		if (open) {
			await this.app.workspace.getLeaf(false).openFile(this.file);
		}
	}

	reportError(e: unknown): void {
		console.error("[midad-arabic-sources] save transcription metadata", e);
		new Notice("Could not save the metadata — see the developer console.");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TranslateModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	citekey: string;
	notes: PipelineNote[];
	pdfs: PipelinePdf[];
	prompts: PromptEntry[];
	checks: Array<{ note: PipelineNote; el: HTMLInputElement }> = [];
	volume = "";
	picker!: PromptPicker;

	constructor(app: App, plugin: MidadArabicSourcesPlugin, citekey: string, notes: PipelineNote[], pdfs: PipelinePdf[], prompts: PromptEntry[]) {
		super(app);
		this.plugin = plugin;
		this.citekey = citekey;
		this.notes = notes;
		this.pdfs = pdfs;
		this.prompts = prompts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Translate — @${this.citekey}` });

		const promptRow = contentEl.createDiv();
		this.picker = new PromptPicker(this.plugin, "translation", promptRow, this.prompts, {
			onSelectAll: () => this.checks.forEach((c) => (c.el.checked = true)),
			onSelectNone: () => this.checks.forEach((c) => (c.el.checked = false)),
		});

		const transcriptions = this.notes.filter((n) => n.type === "transcription");
		if (!transcriptions.length) {
			contentEl.createEl("p", { text: "No transcription exists yet. Run “transcribe this item's PDF file(s)” first." });
		} else {
			contentEl.createEl("p", { text: "Choose the transcription(s) to translate." });
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
					const prompt = this.picker.selectedEntry();
					if (!prompt) { new Notice("Select a prompt."); return; }
					const args = ["translate", "--citekey", this.citekey];
					for (const p of chosen) args.push("--source", p);
					if (this.volume) args.push("--volume", this.volume);
					const promptFile = this.plugin.writePromptFile("translation", prompt.text);
					if (!promptFile) return;
					args.push("--prompt-file", promptFile);
					this.close();
					await this.plugin.runWithProgress("Translating", args);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class SourceRootMoveModal extends Modal {
	root: string;
	sourceHasFiles: boolean;
	targetHasFiles: boolean;
	onChoose: (ok: boolean) => void;
	settled = false;

	constructor(app: App, root: string, sourceHasFiles: boolean, targetHasFiles: boolean, onChoose: (ok: boolean) => void) {
		super(app);
		this.root = root;
		this.sourceHasFiles = sourceHasFiles;
		this.targetHasFiles = targetHasFiles;
		this.onChoose = onChoose;
	}

	choose(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.onChoose(ok);
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Move Midad source folders?" });
		contentEl.createEl("p", {
			text: `Move Installed Sources, Transcriptions, Translations, and Annotation Notes to “${this.root}”?`,
		});
		if (this.targetHasFiles) {
			contentEl.createEl("p", {
				text: "The destination already contains files. Existing folders will be merged; files with the same name are left untouched.",
			});
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.choose(false)))
			.addButton((b) => b.setButtonText("Move folders").setCta().onClick(() => this.choose(true)));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onChoose(false);
		}
	}
}

class ReRenderBatchScopeModal extends Modal {
	citekey: string;
	volume: number;
	count: number;
	onChoose: (scope: "one" | "all" | null) => void;
	settled = false;

	constructor(
		app: App,
		citekey: string,
		volume: number,
		count: number,
		onChoose: (scope: "one" | "all" | null) => void
	) {
		super(app);
		this.citekey = citekey;
		this.volume = volume;
		this.count = count;
		this.onChoose = onChoose;
	}

	choose(scope: "one" | "all" | null): void {
		if (this.settled) return;
		this.settled = true;
		this.onChoose(scope);
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Re-render @${this.citekey}` });
		contentEl.createEl("p", {
			text: `This work has ${this.count} archived batch(es). Re-render only volume ${this.volume}, or every archived batch?`,
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.choose(null)))
			.addButton((b) =>
				b.setButtonText(`Only vol. ${this.volume}`).onClick(() => this.choose("one"))
			)
			.addButton((b) =>
				b.setButtonText(`All ${this.count} archived batches`).setCta().onClick(() => this.choose("all"))
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onChoose(null);
		}
	}
}

class ReprocessModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	zips: ArchiveZip[];
	checks: Array<{ zip: ArchiveZip; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: MidadArabicSourcesPlugin, zips: ArchiveZip[]) {
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
	plugin: MidadArabicSourcesPlugin;
	items: Array<{ work: JsonObject; missing: number; total: number; reason: string }>;
	checks: Array<{ work: JsonObject; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: MidadArabicSourcesPlugin, items: Array<{ work: JsonObject; missing: number; total: number; reason: string }>) {
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
	resolve: (choice: "start" | "skip" | "cancel") => void;
	answered = false;

	constructor(app: App, sourceName: string, resolve: (choice: "start" | "skip" | "cancel") => void) {
		super(app);
		this.sourceName = sourceName;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.titleEl.setText("Transliteration unavailable");
		this.contentEl.createEl("p", {
			text: `This source, ${this.sourceName}, requires transliteration to render, but the `
				+ "transliteration server is not running. Start it now, or proceed without transliteration.",
		});
		const footer = new Setting(this.contentEl);
		footer.addButton((b) =>
			b.setButtonText("Start server").setCta().onClick(async () => {
				this.answered = true;
				this.resolve("start");
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
	/** The primary topic/genre this work belongs to (collections can share one). */
	genre?: string;
	/** Every topic/genre it belongs to (a work may sit in more than one kind). */
	genres?: string[];
	/** A longer descriptive title, shown under the main one. */
	subtitle?: string;
	/** The repository the text is drawn from (for the column + sidebar). */
	repository?: string;
	/** True when some entries are named by transliterating their Arabic. */
	needs_transliteration?: boolean;
	/** True when the work exists in the built-in catalogue, not only a custom entry. */
	builtin?: boolean;
	id: string;
	name: string;
	title: string;
	/** Arabic title, used by search even when it is not displayed in the row. */
	title_ar?: string;
	short_ar?: string;
	aliases?: string[];
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
	"hadith-commentary": "Ḥadīth commentary",
	"quran-text": "Qurʾān text",
	dictionary: "Dictionaries",
	fiqh: "Fiqh",
	usul: "Uṣūl al-Fiqh",
	aqida: "Doctrine (ʿaqīda)",
	theology: "Theology",
	tarikh: "Tārīkh",
	biography: "Biography (rijāl)",
	language: "Language (lugha)",
	lexicography: "Lexicography",
	grammar: "Grammar (naḥw and ṣarf)",
	rhetoric: "Rhetoric",
	adab: "Adab",
	linguistics: "Linguistics",
	maqasid: "Maqāṣid",
	"quran-sciences": "ʿUlūm al-Qurʾān",
	other: "Other",
};

/** The genre keys a work belongs to (older works carry only `genre`). */
function workGenres(w: SourceWork): string[] {
	if (Array.isArray(w.genres) && w.genres.length) return w.genres.map(normalizeGenre);
	return [normalizeGenre(w.genre || "other")];
}

/** A readable label for a genre key. */
function genreLabelOf(g: string): string {
	return GENRE_LABELS[g] || g.replace(/-/g, " ");
}

/** A user-added Turath work, persisted in `turath-custom-works.json`. */
interface TurathCustomWork {
	id: string;
	title: string;
	arabic: string;
	author: string;
	type: string;
	genres: string[];
	subtitle?: string;
	url: string;
}

/** Turath category id → our genre key (used for works added by URL). */
const TURATH_CAT_TYPES: Record<number, string> = {
	1: "aqida", 3: "tafsir", 4: "quran-sciences", 6: "hadith", 7: "hadith",
	11: "usul", 14: "fiqh", 15: "fiqh", 16: "fiqh", 17: "fiqh", 18: "fiqh",
	19: "fiqh", 20: "fiqh", 21: "fiqh", 22: "fiqh", 23: "adab", 24: "tarikh",
	25: "tarikh", 26: "biography", 27: "tarikh", 28: "tarikh", 29: "language",
	30: "language", 31: "language", 32: "adab", 33: "language", 34: "adab",
	35: "language", 36: "other", 37: "other", 38: "other", 39: "other", 40: "other",
};

/** Finer genres implied by a Turath category (defaults to the broad type). */
function genresForCat(cat: number, type: string): string[] {
	if (cat === 30) return ["language", "lexicography", "dictionary"];
	if (cat === 31) return ["language", "grammar"];
	if (cat === 35) return ["language", "rhetoric"];
	if (cat === 26) return ["biography"];
	if (cat === 32) return ["adab"];
	return [type];
}

/** Proper-name stems that stay capitalised in a sentence-cased title. */
const TITLE_PROPER = new Set([
	"ibn", "abī", "abū", "bint", "banū",
	"ṭabarī", "qurṭubī", "kathīr", "zamakhsharī", "rāzī", "andalusī", "suyūṭī", "maḥallī",
	"jalālayn", "shinqīṭī", "qāsimī", "saʿdī", "bukārī", "bukhari", "muslim", "dāwūd", "tirmidhī",
	"mājah", "mālik", "aḥmad", "ḥanbal", "ḥajar", "ʿasqalānī", "nawawī", "qudāma", "shāfiʿī",
	"kāsānī", "marghīnānī", "rushd", "buhūtī", "qayrawānī", "akhḍarī", "qudūrī", "ḥaḍramī",
	"thaʿlabī", "ājurrūm", "ḥājib", "khalīl", "kharashī", "ḥaṭṭāb", "mawwāq", "ʿulaysh",
	"bilʿālam", "sībawayh", "jāḥiẓ", "manẓūr", "fīrūzābādī", "jawharī", "fāris", "qutayba",
	"jurjānī", "mizzī", "dhahabī", "khallikān", "saʿd", "ziriklī", "athīr", "taymiyya",
	"ʿizz", "ashʿarī", "ājurrī", "marwazī", "sarakhsī", "juwaynī", "shāṭibī", "qayyim",
	"jawziyya", "qurʾān", "qur’ān", "qur'ān", "allāh", "raḥmān", "bārī", "ʿarab", "ʿarabiyya",
	"nawawiyya", "qayrawāniyya", "ḥaḍramiyya", "ājurrūmiyya", "mālikī", "ḥanafī", "ḥanbalī",
	"baghdādī", "qazwīnī", "sijistānī", "nasāʾī", "dārimī", "tibrīzī", "dihlawī",
	"jalīl", "khaldūn", "zahrī", "ṭaḥāwiyya", "wāsiṭiyya",
]);

/** Fold the former split grammar keys into the combined category. */
function normalizeGenre(g: string): string {
	return g === "grammar-syntax" || g === "grammar-inflection" ? "grammar" : g;
}

/**
 * Sentence case for a romanized non-English title: the first word and proper
 * nouns are capitalised, everything else is lowercased (the article stays
 * `al-`). English titles keep their own casing and should not pass through here.
 */
function sentenceCaseTitle(text: string): string {
	const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
	return String(text || "").trim().split(/\s+/).map((tok, i) => {
		const bare = tok.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
		const stem = bare.replace(/^al-/, "");
		if (TITLE_PROPER.has(stem)) {
			return /^al-/i.test(tok) ? "al-" + cap(tok.slice(3)) : cap(tok);
		}
		if (i === 0) return /^al-/i.test(tok) ? "al-" + cap(tok.slice(3)) : cap(tok);
		return tok.toLowerCase();
	}).join(" ");
}

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
/** The "add by URL" form and the user's list; shared by the tab and the command. */
function buildUrlAdder(plugin: MidadArabicSourcesPlugin, container: HTMLElement, onAdded?: () => void): void {
	container.createEl("p", {
		text: "Paste a Turath book URL (or its numeric ID). The plugin reads its metadata and offers a provisional romanization you can edit before adding.",
	});
	container.createEl("p", {
		text: "After adding a work to the list of available sources, you still need to install it, either here or through the main “Install/uninstall sources” tab.",
	});
	let inputEl!: HTMLInputElement;
	let titleEl!: HTMLInputElement;
	let authorEl!: HTMLInputElement;
	let pending: TurathCustomWork | null = null;
	const preview = container.createDiv();
	preview.classList.add("mas-manage__hidden");
	const listEl = container.createDiv();

	const renderList = async (): Promise<void> => {
		listEl.empty();
		listEl.createEl("h3", { text: "Your list" });
		const works = await plugin.loadCustomWorks();
		if (!works.length) {
			listEl.createEl("p", { text: "No works added yet." });
			return;
		}
		for (const w of works) {
			const key = `turath:${w.id}`;
			const installed = await plugin.isSourceInstalled(key);
			new Setting(listEl)
				.setName(w.title || w.arabic || w.id)
				.setDesc(w.author ? `${w.author} — ${w.url}` : w.url)
				.addButton((b) => b
					.setButtonText(installed ? "Installed" : "Install")
					.setDisabled(installed)
					.onClick(async () => {
						b.setDisabled(true);
						b.setButtonText("Installing…");
						try {
							await plugin.importSources([key]);
							onAdded?.();
						} finally {
							await renderList();
						}
					}))
				.addButton((b) => b
					.setButtonText("Remove from list")
					.setDestructive()
					.onClick(async () => {
						const builtin = await plugin.isBuiltinTurathWork(w.id);
						const manifest = builtin ? [] : await plugin.loadSourceManifest();
						const source = manifest.find((entry) => plugin.workKey(entry) === key);
						if (source) {
							new ConfirmModal(plugin.app, {
								title: "Remove from list and uninstall",
								message: "This work is not in the built-in catalogue. Removing it from the list will also uninstall it and delete its generated notes; annotations are kept. Continue?",
								confirmText: "Remove",
								onConfirm: async () => {
									const progress = new Notice(`Uninstalling “${w.title || w.id}”…`, 0);
									try {
										const ok = await plugin.removeSource(source, (done, total) =>
											progress.setMessage(`Uninstalling “${w.title || w.id}” — ${done}/${total} files…`)
										);
										if (!ok) {
											new Notice("The source could not be fully uninstalled; its custom entry was kept.");
											return;
										}
										await plugin.removeTurathWork(w.id);
										onAdded?.();
										await renderList();
									} finally {
										progress.hide();
									}
								},
							}).open();
							return;
						}
						await plugin.removeTurathWork(w.id);
						onAdded?.();
						await renderList();
					}));
		}
	};

	const pull = async (): Promise<void> => {
		const work = await plugin.previewTurathWork(inputEl.value);
		if (!work) return;
		pending = work;
		titleEl.value = work.title;
		authorEl.value = work.author;
		preview.classList.remove("mas-manage__hidden");
	};

	new Setting(container)
		.addText((text) => {
			inputEl = text.inputEl;
			text.setPlaceholder("https://app.turath.io/book/95864");
			text.inputEl.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") { ev.preventDefault(); void pull(); }
			});
		})
		.addButton((b) => b.setButtonText("Fetch").setCta().onClick(() => void pull()));

	new Setting(preview).setName("Title (romanized)").addText((text) => { titleEl = text.inputEl; });
	new Setting(preview).setName("Author (romanized)").addText((text) => { authorEl = text.inputEl; });
	new Setting(preview).addButton((b) => b.setButtonText("Add to list").onClick(async () => {
		if (!pending) return;
		const work = pending;
		work.title = titleEl.value.trim() || work.title;
		work.author = authorEl.value.trim() || work.author;
		const save = async (): Promise<void> => {
			await plugin.saveTurathWork(work);
			pending = null;
			inputEl.value = "";
			preview.classList.add("mas-manage__hidden");
			await renderList();
			onAdded?.();
		};
		const custom = (await plugin.loadCustomWorks()).some((item) => String(item.id) === String(work.id));
		const available = (await plugin.listSourcesCached()).some((item) =>
			item.collection === "turath" && String(item.id) === String(work.id)
		);
		const installed = (await plugin.loadSourceManifest()).some((item) =>
			plugin.workKey(item) === `turath:${work.id}` && item.status !== "deleting"
		);
		if (custom || available || installed) {
			new ConfirmModal(plugin.app, {
				title: "Work already exists",
				message: "This work already exists in the list of available sources. Override the entry in the list with this custom entry?",
				confirmText: "Yes",
				onConfirm: save,
			}).open();
			return;
		}
		await save();
	}));
	void renderList();
}

/** Add Turath works by URL; the list lives in `turath-custom-works.json`. */
class TurathUrlModal extends Modal {
	plugin: MidadArabicSourcesPlugin;

	constructor(app: App, plugin: MidadArabicSourcesPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.titleEl.setText("Add Turath works by URL");
		buildUrlAdder(this.plugin, this.contentEl);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ManageSourcesModal extends Modal {
	plugin: MidadArabicSourcesPlugin;
	works: SourceWork[];
	installed: Set<string>;
	deleting: Set<string>;
	archived: Set<string>;
	archiving: Set<string>;
	annotationCounts: Map<string, number>;
	sizes: Map<string, number>;
	onReload?: () => void;
	initial: Map<string, boolean>;
	zoteroStatus: Map<string, string>;
	rows: Array<{ work: SourceWork; el: HTMLElement; stateEl: HTMLElement; isInstalled: boolean; isArchived: boolean; isArchiving: boolean; annotationCount: number; genres: string[]; repo: string; collection: string }> = [];
	headings: Map<string, HTMLElement> = new Map();
	/** The works the user has highlighted; Apply acts on the difference. */
	selected = new Set<string>();
	show: "all" | "installed" | "not-installed" | "archived" | "annotated";
	mode: "manage" | "zotero" | "url" = "manage";
	activeGenres = new Set<string>();
	offRepos = new Set<string>();
	allSelected = false;
	catalogDirty = false;
	refreshSelection: () => void = () => {};
	updateFilter: () => void = () => {};
	markArchiving: (work: SourceWork) => void = () => {};
	finishArchiving: (work: SourceWork, ok: boolean) => void = () => {};

	constructor(app: App, plugin: MidadArabicSourcesPlugin, works: SourceWork[], installed: Set<string>, deleting: Set<string> = new Set(), archived: Set<string> = new Set(), sizes: Map<string, number> = new Map(), zoteroStatus: Map<string, string> = new Map(), onReload?: () => void, archiving: Set<string> = new Set(), showFilter?: "all" | "installed" | "not-installed" | "archived" | "annotated", initialMode: "manage" | "zotero" | "url" = "manage") {
		super(app);
		this.plugin = plugin;
		this.works = works;
		this.installed = installed;
		this.deleting = deleting;
		this.archived = archived;
		this.archiving = archiving;
		this.annotationCounts = new Map(
			Object.entries(plugin.annotations?.annotationSummary() ?? {}).map(([key, value]) => [key, value.count])
		);
		this.sizes = sizes;
		this.zoteroStatus = zoteroStatus;
		this.onReload = onReload;
		this.initial = new Map(works.map((w) => [w.key, installed.has(w.key) && !archiving.has(w.key)]));
		const saved = plugin.settings.manageShowFilter;
		this.show = showFilter ?? (saved === "installed" || saved === "not-installed" || saved === "archived" || saved === "annotated"
			? saved
			: "all");
		this.mode = initialMode;
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
		const urlTab = tabs.createEl("button", { cls: "mas-manage__tab", text: "Add by URL" });
		const desc = contentEl.createEl("p", { cls: "mas-manage__desc" });

		// ── Top bar: Show / search / language / reload ────────────────────────
		const topbar = contentEl.createDiv({ cls: "mas-manage__searchrow" });
		topbar.createSpan({ cls: "mas-manage__label", text: "Show:" });
		const showSel = topbar.createEl("select");
		for (const [val, label] of [
			["all", "All"],
			["installed", "Installed"],
			["not-installed", "Not installed"],
			["archived", "Archived"],
			["annotated", "Annotated"],
		] as const) {
			showSel.createEl("option", { text: label }).value = val;
		}
		showSel.value = this.show;
		const search = topbar.createEl("input", { cls: "mas-manage__search" });
		search.type = "search";
		search.placeholder = "Filter…";
		const langSel = topbar.createEl("select");
		const langLabels = new Map<string, string>();
		for (const w of this.works) langLabels.set(w.language, w.language_label || w.language);
		for (const [lg, label] of Array.from(langLabels.entries()).sort((a, b) => a[1].localeCompare(b[1]))) {
			langSel.createEl("option", { text: label }).value = lg;
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
		const addByUrl = topbar.createEl("button", { text: "Add by URL…" });
		addByUrl.title = "Add a Turath work by URL";

		// ── Body: sidebar (kinds + repositories) + list pane ──────────────────
		const body = contentEl.createDiv({ cls: "mas-manage__body" });
		const side = body.createDiv({ cls: "mas-manage__side" });

		side.createDiv({ cls: "mas-manage__group", text: "Kinds of sources" });
		const genreToggles = side.createDiv({ cls: "mas-manage__toggles" });
		const genres: string[] = [];
		const genreLabel = new Map<string, string>();
		for (const w of this.works) {
			for (const g of workGenres(w)) {
				if (genreLabel.has(g)) continue;
				genres.push(g);
				genreLabel.set(g, genreLabelOf(g));
			}
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
		const COLS = "6ch minmax(80px,0.8fr) minmax(160px,1.8fr) minmax(90px,0.9fr) minmax(90px,0.8fr) 68px 80px";
		const head = list.createDiv({ cls: "mas-manage__head" });
		head.style.gridTemplateColumns = COLS;
		for (const label of ["Lang", "Author", "Title", "Kind", "Repository", "Size", "State"]) head.createSpan({ text: label });

		let lastCollection = "";
		for (const w of this.works) {
			if (w.collection !== lastCollection) {
				lastCollection = w.collection;
				this.headings.set(w.collection, list.createDiv({ cls: "mas-manage__collection", text: w.collection_label || w.collection }));
			}
			const row = list.createDiv({ cls: "mas-manage__row" });
			row.style.gridTemplateColumns = COLS;
			const isInstalled = this.installed.has(w.key) && !this.archiving.has(w.key);
			const isArchived = this.archived.has(w.key);
			const isArchiving = this.archiving.has(w.key);
			const annotationCount = this.annotationCounts.get(w.key) ?? 0;
			row.createSpan({ cls: "mas-manage__lang", text: w.language.toUpperCase() });
			row.createSpan({ text: w.author || "" });
			const titleCell = row.createDiv({ cls: "mas-manage__title" });
			titleCell.createDiv({ cls: "mas-manage__title-main", text: w.title || w.name });
			if (w.subtitle) titleCell.createDiv({ cls: "mas-manage__subtitle", text: w.subtitle });
			if (annotationCount) {
				const badge = titleCell.createDiv({ cls: "mas-manage__ann" });
				setIcon(badge.createSpan({ cls: "mas-manage__ann-icon" }), "highlighter");
				badge.createSpan({ cls: "mas-manage__ann-count", text: String(annotationCount) });
				badge.title = `${annotationCount} annotation(s)`;
			}
			row.createSpan({ cls: "mas-manage__kind", text: workGenres(w).map(genreLabelOf).join(", ") });
			row.createSpan({ cls: "mas-manage__mut", text: w.repository || "" });
			const known = this.sizes.get(w.key);
			const size = row.createSpan({
				cls: "mas-manage__size",
				text: known ? formatBytes(known) : w.est_bytes ? `≈${formatBytes(w.est_bytes)}` : "—",
			});
			size.title = known ? "On disk" : w.est_bytes ? "Estimated" : "Unknown";
			row.classList.toggle("is-archived", isArchived || isArchiving);
			row.classList.toggle("is-archiving", isArchiving);
			const stateEl = row.createSpan({
				cls: "mas-manage__mut mas-manage__state",
				text: this.deleting.has(w.key) ? "Being removed" : isArchiving ? "Archiving" : isArchived ? "Archived" : isInstalled ? "Installed" : "",
			});
			row.oncontextmenu = (event) => {
				const current = this.rows.find((entry) => entry.work.key === w.key);
				if (!current || current.isArchiving) return;
				const isInstalledNow = current.isInstalled;
				const isArchivedNow = current.isArchived;
				const annotationCountNow = current.annotationCount;
				if (!annotationCountNow && !isInstalledNow && !isArchivedNow) return;
				event.preventDefault();
				const menu = new Menu();
				if (annotationCountNow) {
					menu.addItem((item) => item
						.setTitle("Delete annotations for this item…")
						.setIcon("trash-2")
						.onClick(() => { void this.plugin.annotations?.confirmDeleteAnnotations(w.key); }));
				}
				if (isInstalledNow && !isArchivedNow) {
					menu.addItem((item) => item
						.setTitle("Archive source…")
						.setIcon("archive")
						.onClick(() => {
							new ConfirmModal(this.app, {
								title: "Archive source",
								message: `Archive “${w.title || w.dir}”? Its notes will be removed, but its annotations and a compressed model are kept.`,
								confirmText: "Archive",
								onConfirm: () => {
									this.markArchiving(w);
									void (async () => {
										const ok = await this.plugin.archiveSourceWithProgress(w);
										this.finishArchiving(w, ok);
									})();
								},
							}).open();
						}));
				}
				if (isArchivedNow) {
					menu.addItem((item) => item
						.setTitle("Restore from archive")
						.setIcon("archive-restore")
						.onClick(() => {
							this.close();
							void (async () => {
								await this.plugin.restoreArchivedSource(w);
								void this.plugin.openManageSources(true);
							})();
						}));
					menu.addItem((item) => item
						.setTitle("Remove archived source…")
						.setIcon("trash-2")
						.onClick(() => {
							new ConfirmModal(this.app, {
								title: "Remove archived source",
								message: `Remove “${w.title || w.dir}” completely? Its compressed model will be deleted; its annotations are kept.`,
								confirmText: "Remove",
								onConfirm: () => {
									this.close();
									void (async () => {
										const progress = new Notice(`Removing “${w.title || w.dir}”…`, 0);
										try {
											await this.plugin.removeSource(w, (done, total) =>
												progress.setMessage(`Removing “${w.title || w.dir}” — ${done}/${total} files…`)
											);
										} finally {
											progress.hide();
											void this.plugin.openManageSources(true);
										}
									})();
								},
							}).open();
						}));
				}
				menu.showAtMouseEvent(event);
			};
			row.onclick = () => {
				if (this.archiving.has(w.key)) {
					new Notice("That source is still being archived.");
					return;
				}
				if (this.selected.has(w.key)) this.selected.delete(w.key);
				else this.selected.add(w.key);
				this.refreshSelection();
			};
			this.rows.push({
				work: w, el: row, stateEl, isInstalled, isArchived, isArchiving, annotationCount,
				genres: workGenres(w),
				repo: w.repository || "Other",
				collection: w.collection,
			});
		}

		const foot = pane.createDiv({ cls: "mas-manage__foot" });
		const statusEl = foot.createDiv({ cls: "mas-manage__status" });
		const deleteAnnotationsWrap = foot.createEl("label", { cls: "mas-manage__delete-ann" });
		const deleteAnnotationsOnRemove = deleteAnnotationsWrap.createEl("input", { attr: { type: "checkbox" } });
		deleteAnnotationsWrap.createSpan({ text: "Delete annotations for items removed while applying these changes" });
		const actions = foot.createDiv({ cls: "mas-manage__actions" });
		const selectAllBtn = actions.createEl("button", { cls: "mas-manage__toggle", text: "Select all/none" });
		const trashBtn = actions.createEl("button", { text: "Annotation trash…" });
		trashBtn.onclick = () => {
			if (this.plugin.annotations) new AnnotationTrashModal(this.app, this.plugin.annotations).open();
			else new Notice("The annotation layer is not running.");
		};
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		const applyBtn = actions.createEl("button", { cls: "mod-cta", text: "Apply" });

		const updateStatus = () => {
			const visible = this.rows.filter((r) => !r.el.classList.contains("is-hidden")).length;
			statusEl.setText(`${this.selected.size} selected · ${visible} shown`);
		};
		this.markArchiving = (work: SourceWork) => {
			const key = work.key;
			this.archiving.add(key);
			this.archived.delete(key);
			this.installed.delete(key);
			this.selected.delete(key);
			this.initial.set(key, false);
			const row = this.rows.find((entry) => entry.work.key === key);
			if (row) {
				row.isInstalled = false;
				row.isArchived = false;
				row.isArchiving = true;
				row.el.classList.add("is-archived", "is-archiving");
				row.stateEl.setText("Archiving");
			}
			this.refreshSelection();
			this.updateFilter();
		};
		this.finishArchiving = (work: SourceWork, ok: boolean) => {
			const key = work.key;
			this.archiving.delete(key);
			const row = this.rows.find((entry) => entry.work.key === key);
			if (ok) {
				this.archived.add(key);
				this.installed.delete(key);
				if (row) {
					row.isInstalled = false;
					row.isArchived = true;
					row.isArchiving = false;
					row.el.classList.add("is-archived");
					row.el.classList.remove("is-archiving");
					row.stateEl.setText("Archived");
				}
			} else {
				this.installed.add(key);
				this.initial.set(key, true);
				if (row) {
					row.isInstalled = true;
					row.isArchived = false;
					row.isArchiving = false;
					row.el.classList.remove("is-archived", "is-archiving");
					row.stateEl.setText("Installed");
				}
			}
			this.refreshSelection();
			this.updateFilter();
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
				const hay = `${w.title} ${w.name} ${w.title_ar ?? ""} ${w.short_ar ?? ""} ${(w.aliases ?? []).join(" ")} ${w.author} ${w.subtitle ?? ""} ${w.id} ${w.repository || ""}`.toLowerCase();
				const showOk = this.show === "all"
					? true
					: this.show === "installed"
						? r.isInstalled
						: this.show === "not-installed"
							? !r.isInstalled && !r.isArchived && !r.isArchiving
							: this.show === "archived"
								? r.isArchived || r.isArchiving
								: r.annotationCount > 0;
				const genreOk = !this.activeGenres.size || r.genres.some((g) => this.activeGenres.has(g));
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
			const visible = this.rows.filter((r) => !r.el.classList.contains("is-hidden") && !this.archiving.has(r.work.key));
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
			if (this.archiving.size) {
				new Notice("Wait for the source archive to finish before applying other changes.");
				return;
			}
			const toInstall: SourceWork[] = [];
			const toRestore: SourceWork[] = [];
			const toRemove: SourceWork[] = [];
			for (const w of this.works) {
				const was = this.initial.get(w.key) === true;
				const now = this.selected.has(w.key);
				if (now && !was) {
					if (this.archived.has(w.key)) toRestore.push(w);
					else toInstall.push(w);
				} else if (!now && was) {
					toRemove.push(w);
				}
			}
			if (!toInstall.length && !toRestore.length && !toRemove.length) {
				new Notice("Nothing to change.");
				return;
			}
			this.close();
			const progress = new Notice(
				`Applying… (${toInstall.length} to install, ${toRestore.length} to restore, ${toRemove.length} to remove)`,
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
						if (deleteAnnotationsOnRemove.checked && this.plugin.annotations) {
							await this.plugin.annotations.trashAnnotationsForWork(w.key);
						}
					} catch (e) {
						failed.push(`${name}: ${e instanceof Error ? e.message : e}`);
					}
				}
				if (toRestore.length) {
					for (const w of toRestore) {
						progress.setMessage(`Restoring ${w.title || w.dir}…`);
						try {
							if (!(await this.plugin.restoreArchivedSource(w))) failed.push(`restore: ${w.title || w.dir}`);
						} catch (e) {
							failed.push(`restore ${w.title || w.dir}: ${e instanceof Error ? e.message : e}`);
						}
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
				`Applied: ${toInstall.length} installed, ${toRestore.length} restored, ${toRemove.length} removed.` +
					(failed.length ? ` ${failed.length} failed — see the console.` : "")
			);
			if (failed.length) console.error("[midad-arabic-sources] apply failures", failed);
		};

		const urlPane = contentEl.createDiv({ cls: "mas-manage__urlpane" });
		urlPane.classList.add("mas-manage__hidden");
		buildUrlAdder(this.plugin, urlPane, () => {
			this.catalogDirty = true;
		});

		const setMode = (m: "manage" | "zotero" | "url") => {
			if (m === "manage" && this.catalogDirty) {
				this.catalogDirty = false;
				this.close();
				window.setTimeout(() => { void this.plugin.openManageSources(true, "all", "manage"); }, 0);
				return;
			}
			const prev = this.mode;
			this.mode = m;
			const isUrl = m === "url";
			manageTab.classList.toggle("is-active", m === "manage");
			zoteroTab.classList.toggle("is-active", m === "zotero");
			urlTab.classList.toggle("is-active", isUrl);
			topbar.classList.toggle("mas-manage__hidden", isUrl);
			body.classList.toggle("mas-manage__hidden", isUrl);
			urlPane.classList.toggle("mas-manage__hidden", !isUrl);
			if (isUrl) {
				desc.setText("Add a Turath work by URL. Your current selections are kept while you are here.");
				return;
			}
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
			// Coming back from the URL tab keeps whatever the user had selected;
			// switching between manage and Zotero still resets as before.
			if (prev !== "url" || m === "zotero") {
				this.selected = new Set(
					this.works
						.filter((w) => (m === "manage"
							? this.initial.get(w.key) === true
							: this.installed.has(w.key) && this.zoteroStatus.get(w.key) !== "current"))
						.map((w) => w.key)
				);
			}
			this.refreshSelection();
			this.updateFilter();
		};
		manageTab.onclick = () => setMode("manage");
		zoteroTab.onclick = () => setMode("zotero");
		urlTab.onclick = () => setMode("url");
		addByUrl.onclick = () => setMode("url");
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
	plugin: MidadArabicSourcesPlugin;
	entries: Array<{ work: JsonObject; item: JsonObject; hash: string; itemKey: string; status: "new" | "changed" | "current" }>;
	checks: Array<{ key: string; el: HTMLInputElement }> = [];

	constructor(app: App, plugin: MidadArabicSourcesPlugin, entries: ZoteroSendModal["entries"]) {
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
