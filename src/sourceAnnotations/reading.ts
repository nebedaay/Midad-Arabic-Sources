import { App, MarkdownView, Plugin } from "obsidian";
import type { MarkdownPostProcessorContext } from "obsidian";
import type { SourceAnnotation } from "./types";
import { applyReadingAnnotations } from "./wrap";

const pending = new WeakMap<HTMLElement, number>();

/** Debounced whole-preview pass; the post-processor runs per block. */
export function scheduleReadingAnnotations(root: HTMLElement, annotations: SourceAnnotation[]): void {
	const existing = pending.get(root);
	if (existing) window.clearTimeout(existing);
	const timer = window.setTimeout(() => {
		pending.delete(root);
		if (!root.isConnected) return;
		applyReadingAnnotations(root, annotations);
	}, 80);
	pending.set(root, timer);
}

/** Register the Reading-view renderer for the spike. */
export function registerReadingAnnotations(
	plugin: Plugin,
	getAnnotations: (path: string) => SourceAnnotation[] | null
): void {
	plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const annotations = getAnnotations(ctx.sourcePath);
		if (!annotations || !annotations.length) return;
		const sizer = el.closest<HTMLElement>(".markdown-preview-sizer");
		if (sizer) scheduleReadingAnnotations(sizer, annotations);
		else applyReadingAnnotations(el, annotations);
	});
}

/** Ask open Reading views to re-render after the store changes. */
export function refreshReadingViews(app: App): void {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		const preview = (view as unknown as { previewMode?: { rerender?: (full?: boolean) => void } }).previewMode;
		preview?.rerender?.(true);
	}
}
