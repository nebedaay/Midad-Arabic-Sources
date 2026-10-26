import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { annotationTint } from "./colors";

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
 * The quote as displayable Markdown: links become their visible text, while
 * emphasis and other Markdown are left for MarkdownRenderer. Selections that
 * stop inside a wikilink leave an unterminated `[[target|visible` fragment;
 * the visible half is retained rather than dropping the whole line.
 */
function quoteMarkdown(annotation: SourceAnnotation): string {
	let text = (annotation.quoteMarkdown || annotation.quote || annotation.quoteText || "")
		.replace(/\r\n?/g, "\n")
		.replace(/^(?:>\s?)+/gm, "");
	text = text
		.replace(/\[\[([^\]|\n]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]\n]+)\]\]/g, "$1")
		.replace(/\[\[([^\]|\n]+)\|([^\n]*)$/gm, "$2")
		.replace(/\[\[([^\n]*)$/gm, (_match, rest: string) => rest.split("|").pop()?.trim() || rest.trim());
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
		await MarkdownRenderer.render(app, quoteMarkdown(annotation), quote, target.notePath, component);
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
