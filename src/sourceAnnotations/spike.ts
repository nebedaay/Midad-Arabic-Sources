import { App, MarkdownView, Notice, Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	annotationEditorExtension,
	applySpikeAnnotations,
	clearSpikeAnnotations,
	resolveForEditor,
} from "./editor";
import { refreshReadingViews, registerReadingAnnotations } from "./reading";
import { AnnotationSpikeStore } from "./store";
import { applyReadingAnnotations } from "./wrap";
import type { SourceAnnotation } from "./types";

function cmOf(view: MarkdownView): EditorView | null {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	return cm ?? null;
}

function markdownViews(app: App): MarkdownView[] {
	return app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view)
		.filter((view): view is MarkdownView => view instanceof MarkdownView);
}

/**
 * Phase 0 spike: reads `.midad-arabic-sources/annotations/spike-index.json`,
 * paints annotations in open editors and in Reading view, and proves the
 * sharded store and the overlap wrapper. It creates no annotations and writes
 * nothing to the vault.
 */
export function registerAnnotationSpike(plugin: Plugin): void {
	const app = plugin.app;
	const store = new AnnotationSpikeStore(app);

	const paintPreview = (view: MarkdownView, annotations: SourceAnnotation[] | null): boolean => {
		const sizer = view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer");
		if (!sizer) return false;
		applyReadingAnnotations(sizer, annotations ?? []);
		return !!annotations && annotations.length > 0;
	};

	const refreshViews = async (announce: boolean): Promise<void> => {
		let applied = 0;
		for (const view of markdownViews(app)) {
			if (!view.file) continue;
			const annotations = await store.ensure(view.file.path);
			const cm = cmOf(view);
			if (cm) {
				if (!annotations || !annotations.length) {
					clearSpikeAnnotations(cm);
				} else {
					applySpikeAnnotations(cm, resolveForEditor(view.editor.getValue(), annotations));
					applied++;
				}
			}
			if (paintPreview(view, annotations)) applied++;
		}
		if (announce) {
			new Notice(applied ? `${applied} annotation view(s) updated.` : "No spike annotations for the open notes.");
		}
	};

	plugin.registerEditorExtension(annotationEditorExtension);
	registerReadingAnnotations(plugin, (path) => store.get(path));

	const paintReading = async (): Promise<string> => {
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return "No active note.";
		const sizer = view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer");
		if (!sizer) return "The active note is not in Reading view.";
		const annotations = await store.ensure(view.file.path);
		if (!annotations || !annotations.length) return "No spike annotations for this note.";
		applyReadingAnnotations(sizer, annotations);
		const marks = sizer.querySelectorAll(".mas-annotation").length;
		const multis = sizer.querySelectorAll(".mas-annotation-multi").length;
		const icons = sizer.querySelectorAll(".mas-ann-icon").length;
		return `Reading view: ${marks} mark(s), ${multis} multi, ${icons} icon(s).`;
	};

	plugin.addCommand({
		id: "annotations-spike-reload",
		name: "Annotation spike: reload annotations",
		callback: async () => {
			await store.load();
			await store.loadAll();
			refreshReadingViews(app);
			window.setTimeout(() => { void refreshViews(true); }, 250);
		},
	});

	plugin.addCommand({
		id: "annotations-spike-paint-reading",
		name: "Annotation spike: paint reading view",
		callback: async () => {
			new Notice(await paintReading());
		},
	});

	plugin.registerEvent(app.workspace.on("active-leaf-change", () => {
		window.setTimeout(() => { void refreshViews(false); }, 120);
	}));

	window.setTimeout(() => {
		void store.load()
			.then(() => store.loadAll())
			.then(() => {
				refreshReadingViews(app);
				window.setTimeout(() => { void refreshViews(false); }, 250);
			});
	}, 1200);
}
