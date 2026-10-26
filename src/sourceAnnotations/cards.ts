import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { annotationTint } from "./colors";
import { bodyBounds, managedBounds } from "./text";

import type { AnnotationTarget, SourceAnnotation } from "./types";

export type AnnotationCardVariant = "compact" | "sidebar";

export interface AnnotationCardOptions {
	app: App;
	annotation: SourceAnnotation;
	target: AnnotationTarget;
	component: Component;
	variant: AnnotationCardVariant;
	/** Sidebar cards are clickable; compact tooltip cards are not. */
	onActivate?: () => void;
	onEdit?: () => void;
	onDelete?: () => void;
	onOpenNote?: () => void;
}

function openLink(event: MouseEvent, app: App, sourcePath: string): boolean {
	const node = event.target as HTMLElement | null;
	const link = node?.closest("a");
	if (!link) return false;
	const href = link.getAttribute("data-href") ?? link.getAttribute("href");
	if (!href) return false;
	event.preventDefault();
	event.stopPropagation();
	if (link.hasAttribute("data-href") || link.classList.contains("internal-link")) {
		void app.workspace.openLinkText(href, sourcePath, event.metaKey || event.ctrlKey);
	} else {
		window.open(href, "_blank");
	}
	return true;
}

/**
 * Complete a selection that stops inside a wikilink. The source note is the
 * authority for the full target; the selected prefix remains the visible alias.
 */
async function completeTrailingWikilink(
	app: App,
	target: AnnotationTarget,
	text: string,
	annotation: SourceAnnotation
): Promise<string> {
	const start = text.lastIndexOf("[[");
	if (start < 0) return text;
	if (text.indexOf("]]", start + 2) >= 0) return text;
	const fragment = text.slice(start + 2);
	const lineEnd = fragment.indexOf("\n");
	const line = lineEnd >= 0 ? fragment.slice(0, lineEnd) : fragment;
	const pipe = line.indexOf("|");
	const targetPrefix = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
	if (!targetPrefix) return text;
	const visible = pipe >= 0 ? line.slice(pipe + 1).trim() : targetPrefix;
	const suffix = lineEnd >= 0 ? fragment.slice(lineEnd) : "";
	const prefix = text.slice(0, start);

	let source = "";
	try {
		source = await app.vault.adapter.read(target.notePath);
	} catch {
		/* source unavailable: use the visible fragment below */
	}

	// The most reliable resolution is the link at the annotation's actual source
	// offset. This distinguishes [[Arabic translations]] from the shorter
	// [[Arabic]] when the selection only contains `[[Arabic`.
	const rawQuote = annotation.quote || "";
	const rawStart = rawQuote.lastIndexOf("[[");
	if (source && annotation.position && rawStart >= 0) {
		const bounds = managedBounds(source) ?? (target.sourceStatus === "adopted" ? bodyBounds(source) : null);
		const absolute = bounds ? bounds.bodyStart + annotation.position.start + rawStart : -1;
		if (absolute >= 0 && source.startsWith("[[", absolute)) {
			const close = source.indexOf("]]", absolute + 2);
			if (close >= 0) {
				const full = source.slice(absolute + 2, close).split("|")[0].trim();
				if (full.startsWith(targetPrefix) || targetPrefix.startsWith(full)) {
					return `${prefix}[[${full}|${visible}]]${suffix}`;
				}
			}
		}
	}

	// Fallback for older annotations without a position: prefer the longest
	// matching target, so a generic `Arabic` does not win over `Arabic translations`.
	if (source) {
		const candidates: string[] = [];
		for (const match of source.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) {
			const candidate = match[1].trim();
			if (candidate.startsWith(targetPrefix) || targetPrefix.startsWith(candidate)) candidates.push(candidate);
		}
		candidates.sort((a, b) => b.length - a.length);
		if (candidates.length) return `${prefix}[[${candidates[0]}|${visible}]]${suffix}`;
	}
	return `${prefix}${visible}${suffix}`;
}

function normalizeQuoteList(text: string): string {
	const lines = text.split("\n");
	const content = lines.filter((line) => line.trim());
	if (content.length < 2 || !content.some((line) => /^\s*[-*+]\s+/.test(line))) return text;
	if (!content.every((line) => /^\s*[-*+]?\s*\[\[[^\]]+\]\]\s*$/.test(line))) return text;
	return lines.map((line) => {
		if (!line.trim() || /^\s*[-*+]\s+/.test(line)) return line;
		return `- ${line}`;
	}).join("\n");
}

/**
 * The quote as renderable Markdown. Complete wikilinks stay as wikilinks so
 * Obsidian renders them as links; a truncated final wikilink is completed from
 * the source, or flattened to its visible text when the source cannot help.
 */
async function quoteMarkdown(
	app: App,
	target: AnnotationTarget,
	annotation: SourceAnnotation
): Promise<string> {
	let text = (annotation.quoteMarkdown || annotation.quote || annotation.quoteText || "")
		.replace(/\r\n?/g, "\n")
		.replace(/^(?:>\s?)+/gm, "");
	text = await completeTrailingWikilink(app, target, text, annotation);
	text = normalizeQuoteList(text);
	return text.trim() || "Empty quote";
}

function action(
	parent: HTMLElement,
	icon: string,
	label: string,
	run: () => void
): void {
	const button = parent.createEl("button", {
		cls: "clickable-icon mas-ann-card-action",
		attr: { type: "button", "aria-label": label },
	});
	setIcon(button, icon);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		run();
	});
}

/** One annotation card shared by the tooltip and the sidebar. */
export async function renderAnnotationCard(
	parent: HTMLElement,
	options: AnnotationCardOptions
): Promise<HTMLElement> {
	const { app, annotation, component, target, variant } = options;
	const card = parent.createDiv({ cls: `mas-ann-card mas-ann-card--${variant}` });
	card.dataset.annId = annotation.id;
	if (annotation.anchorStatus === "orphaned") card.addClass("is-orphaned");
	if (variant === "compact") {
		card.setCssStyles({ background: annotationTint(annotation.color, 92, 0.55) });
	}

	if (variant === "sidebar" && annotation.anchorStatus === "orphaned") {
		card.createSpan({ cls: "mas-ann-card-badge", text: "Unanchored" });
	}

	const dot = card.createSpan({ cls: "mas-ann-card-dot" });
	dot.setCssStyles({ background: annotationTint(annotation.color, 62, 0.9) });
	const body = card.createDiv({ cls: "mas-ann-card-body" });
	const comment = body.createDiv({ cls: "mas-ann-card-comment" });
	if (annotation.comment?.trim()) {
		await MarkdownRenderer.render(app, annotation.comment, comment, target.notePath, component);
	} else {
		comment.addClass("is-empty");
		comment.setText("No comment");
	}
	if (variant === "sidebar") {
		comment.setCssStyles({ background: annotationTint(annotation.color, 96, 0.32) });
		// The comment leads; the highlighted excerpt sits directly beneath it.
		const quote = body.createDiv({ cls: "mas-ann-card-quote" });
		try {
			await MarkdownRenderer.render(app, await quoteMarkdown(app, target, annotation), quote, target.notePath, component);
		} catch {
			quote.setText(annotation.quoteText || annotation.quote || "Empty quote");
		}
		quote.setCssStyles({ background: annotationTint(annotation.color, 84, 0.65) });
	}

	if (options.onEdit || options.onDelete || options.onOpenNote) {
		const actions = body.createDiv({ cls: "mas-ann-card-actions" });
		if (options.onEdit) action(actions, "pencil", "Edit annotation", options.onEdit);
		if (options.onOpenNote) action(actions, "notebook-pen", "Open annotation note", options.onOpenNote);
		if (options.onDelete) action(actions, "trash-2", "Delete annotation", options.onDelete);
	}

	card.addEventListener("click", (event) => {
		if (openLink(event, app, target.notePath)) return;
		const node = event.target as HTMLElement | null;
		if (node?.closest("button")) return;
		options.onActivate?.();
	});

	if (options.onActivate) {
		card.tabIndex = 0;
		card.setAttribute("role", "button");
		card.setAttribute("aria-label", "Go to annotation in source");
		card.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			if ((event.target as HTMLElement | null)?.closest("button, a")) return;
			event.preventDefault();
			options.onActivate?.();
		});
	}

	return card;
}
