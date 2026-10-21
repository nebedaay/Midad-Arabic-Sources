import { App, ButtonComponent, Modal, Notice } from "obsidian";
import type { AnnotationColor, SourceAnnotation } from "./types";

export interface AnnotationDraft {
	annotation?: SourceAnnotation;
	quote: string;
	quoteText: string;
	quoteMarkdown: string;
	section: string;
	ordinal: number;
	position: { start: number; end: number };
	segments: Array<[number, number]>;
}

export interface AnnotationModalOptions {
	draft: AnnotationDraft;
	defaultColor: AnnotationColor;
	onSubmit: (color: AnnotationColor, comment: string) => Promise<void> | void;
	onCancel?: () => void;
	onDelete?: () => Promise<void> | void;
}

const COLORS: AnnotationColor[] = [
	"yellow", "orange", "red", "purple", "magenta", "blue", "green", "gray",
];

const COLOR_LABEL: Record<AnnotationColor, string> = {
	yellow: "Yellow",
	orange: "Orange",
	red: "Red",
	purple: "Purple",
	magenta: "Magenta",
	blue: "Blue",
	green: "Green",
	gray: "Gray",
};

const COLOR_HUE: Record<AnnotationColor, number> = {
	yellow: 55,
	orange: 28,
	red: 0,
	purple: 265,
	magenta: 300,
	blue: 205,
	green: 115,
	gray: 100,
};

function tint(color: AnnotationColor, lightness: number, alpha: number): string {
	const saturation = color === "gray" ? "0%" : "75%";
	return `hsla(${COLOR_HUE[color]}, ${saturation}, ${lightness}%, ${alpha})`;
}

/**
 * The creation/edit dialog. The colour row is focused on open; Up/Down changes
 * colour, Right or Tab moves to the comment, Esc cancels, Cmd/Ctrl+Enter saves.
 */
export interface ConfirmOptions {
	title: string;
	message: string;
	confirmText?: string;
	onConfirm: () => Promise<void> | void;
}

export class ConfirmModal extends Modal {
	private readonly options: ConfirmOptions;

	constructor(app: App, options: ConfirmOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.createEl("p", { text: this.options.message });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		new ButtonComponent(buttons)
			.setButtonText(this.options.confirmText ?? "Confirm")
			.setDestructive()
			.onClick(async () => {
				try {
					await this.options.onConfirm();
					this.close();
				} catch (error) {
					console.error("[midad-arabic-sources] confirm action", error);
					new Notice(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class AnnotationModal extends Modal {
	private readonly options: AnnotationModalOptions;
	private color: AnnotationColor;
	private submitted = false;
	private deleteArmed = false;
	private swatches: HTMLButtonElement[] = [];
	private textarea: HTMLTextAreaElement | null = null;
	private previewEl: HTMLElement | null = null;
	private deleteButton: ButtonComponent | null = null;

	constructor(app: App, options: AnnotationModalOptions) {
		super(app);
		this.options = options;
		this.color = options.draft.annotation?.color ?? options.defaultColor;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		this.modalEl.addClass("mas-annotation-modal");
		contentEl.addClass("mas-annotation-modal-content");
		titleEl.setText(this.options.draft.annotation ? "Edit annotation" : "Annotate selection");

		const preview = contentEl.createDiv({ cls: "mas-annotation-preview" });
		preview.dataset.color = this.color;
		preview.setText(this.options.draft.quoteText || this.options.draft.quote);
		this.previewEl = preview;
		this.updatePreviewColor();

		const row = contentEl.createDiv({ cls: "mas-swatch-row" });
		row.setAttribute("role", "radiogroup");
		row.setAttribute("aria-label", "Highlight colour");
		for (const color of COLORS) {
			const button = row.createEl("button", {
				cls: `mas-swatch ${color === this.color ? "is-selected" : ""}`,
				attr: {
					type: "button",
					role: "radio",
					"aria-label": COLOR_LABEL[color],
					"aria-checked": String(color === this.color),
					"data-color": color,
					tabindex: color === this.color ? "0" : "-1",
				},
			});
			button.setCssStyles({ background: tint(color, 62, 0.9) });
			button.addEventListener("click", () => {
				this.selectColor(color);
				button.focus();
			});
			this.swatches.push(button);
		}
		row.addEventListener("keydown", (event) => this.onSwatchKey(event));

		const label = contentEl.createEl("label", { cls: "mas-annotation-label", text: "Comment" });
		label.setAttribute("for", "mas-annotation-comment");
		const textarea = contentEl.createEl("textarea", {
			cls: "mas-annotation-comment",
			attr: {
				id: "mas-annotation-comment",
				placeholder: "Comment (Markdown; wikilinks welcome)",
				rows: "4",
			},
		});
		textarea.value = this.options.draft.annotation?.comment ?? "";
		textarea.addEventListener("keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				event.preventDefault();
				void this.save();
			}
		});
		this.textarea = textarea;

		const hint = contentEl.createDiv({ cls: "mas-annotation-hint" });
		hint.setText("Esc cancels · Cmd/Ctrl+Enter saves");

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		if (this.options.onDelete) {
			this.deleteButton = new ButtonComponent(buttons)
				.setButtonText("Delete")
				.setClass("mod-warning")
				.onClick(() => { void this.delete(); });
		}
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		new ButtonComponent(buttons)
			.setButtonText("Save")
			.setCta()
			.onClick(() => { void this.save(); });

		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		window.setTimeout(() => {
			(this.swatches.find((button) => button.classList.contains("is-selected")) ?? this.swatches[0])?.focus();
		}, 0);
	}

	private onSwatchKey(event: KeyboardEvent): void {
		const index = COLORS.indexOf(this.color);
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			const next = (index + delta + COLORS.length) % COLORS.length;
			this.selectColor(COLORS[next]);
			this.swatches[next]?.focus();
			return;
		}
		if (event.key === "ArrowRight" || event.key === "Tab") {
			event.preventDefault();
			this.textarea?.focus();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			this.textarea?.focus();
		}
	}

	private selectColor(color: AnnotationColor): void {
		this.color = color;
		for (let i = 0; i < this.swatches.length; i++) {
			const button = this.swatches[i];
			const selected = COLORS[i] === color;
			button.classList.toggle("is-selected", selected);
			button.setAttribute("aria-checked", String(selected));
			button.setAttribute("tabindex", selected ? "0" : "-1");
		}
		this.updatePreviewColor();
	}

	private updatePreviewColor(): void {
		if (!this.previewEl) return;
		this.previewEl.dataset.color = this.color;
		this.previewEl.setCssStyles({ background: tint(this.color, 82, 0.55) });
	}

	private async save(): Promise<void> {
		const comment = this.textarea?.value.trim() ?? "";
		try {
			await this.options.onSubmit(this.color, comment);
			this.submitted = true;
			this.close();
		} catch (error) {
			console.error("[midad-arabic-sources] save annotation", error);
			new Notice(`Could not save annotation: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async delete(): Promise<void> {
		if (!this.options.onDelete) return;
		if (!this.deleteArmed) {
			this.deleteArmed = true;
			this.deleteButton?.setButtonText("Click again to delete");
			this.deleteButton?.setClass("mod-destructive");
			return;
		}
		try {
			await this.options.onDelete();
			this.submitted = true;
			this.close();
		} catch (error) {
			console.error("[midad-arabic-sources] delete annotation", error);
			new Notice(`Could not delete annotation: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.options.onCancel?.();
	}
}
