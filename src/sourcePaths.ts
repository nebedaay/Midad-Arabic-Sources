import { App, normalizePath } from "obsidian";

/** The subset of plugin/annotation settings that determines vault folders. */
export interface SourcePathSettings {
	sourceRoot?: string;
	sourceImportRoot?: string;
	annotationNoteFolder?: string;
	canonicalQuranFolder?: string;
}

export const DEFAULT_SOURCE_ROOT = "Midad Arabic Sources";

function clean(value: string | undefined): string {
	return String(value ?? "").trim();
}

/** The root that holds Installed Sources, Transcriptions, and Translations. */
export function sourceRoot(settings: SourcePathSettings): string {
	const explicit = clean(settings.sourceRoot);
	if (explicit) return normalizePath(explicit);
	// Older annotation settings sometimes only had the installed root. Fold it
	// back to the source root rather than nesting another description below it.
	const installed = clean(settings.sourceImportRoot);
	if (installed) {
		return normalizePath(installed.replace(/\/Installed Sources\/?$/, ""));
	}
	return DEFAULT_SOURCE_ROOT;
}

export function installedSourcesRoot(settings: SourcePathSettings): string {
	return normalizePath(clean(settings.sourceImportRoot) || `${sourceRoot(settings)}/Installed Sources`);
}

export function transcriptionsFolder(settings: SourcePathSettings): string {
	return normalizePath(`${sourceRoot(settings)}/Transcriptions`);
}

export function translationsFolder(settings: SourcePathSettings): string {
	return normalizePath(`${sourceRoot(settings)}/Translations`);
}

export function annotationNotesFolder(settings: SourcePathSettings): string {
	return normalizePath(clean(settings.annotationNoteFolder) || `${sourceRoot(settings)}/Annotation Notes`);
}

export function canonicalQuranFolder(settings: SourcePathSettings): string {
	return normalizePath(clean(settings.canonicalQuranFolder) || `${installedSourcesRoot(settings)}/Quran`);
}

/** A managed note at the source root. */
export function sourceNotePath(settings: SourcePathSettings, name: string): string {
	return normalizePath(`${sourceRoot(settings)}/${name}.md`);
}

/** Sanitize one path segment while preserving readable spaces. */
export function safeFileSegment(value: string, fallback = "note", max = 100): string {
	return String(value ?? "")
		.replace(/[\\/:*?"<>|#^]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max) || fallback;
}

/** Create a folder and any missing ancestors. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	const normalized = normalizePath(folder);
	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await app.vault.adapter.exists(current))) {
			try {
				await app.vault.adapter.mkdir(current);
			} catch {
				/* another writer may have created it */
			}
		}
	}
}
