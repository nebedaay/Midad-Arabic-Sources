import { App, ButtonComponent, Modal, Notice, Scope } from "obsidian";
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

export interface PopupAnchor {
	left: number;
	top: number;
	bottom: number;
}

export interface AnnotationPopupOptions {
	draft: AnnotationDraft;
	defaultColor: AnnotationColor;
	onSubmit: (color: AnnotationColor, comment: string) => Promise<void> | void;
	onCancel?: (reason: "escape" | "button" | "outside") => void;
	onDelete?: () => Promise<void> | void;
	onClosed?: () => void;
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

/**
 * The compact annotation popup: a fixed-position panel next to the selection,
 * not a centered modal. The swatch row is horizontal, so Left/Right moves
 * between colours and Tab moves to the comment box.
 */
export class AnnotationPopup {
	private readonly app: App;
	private readonly options: AnnotationPopupOptions;
	private color: AnnotationColor;
	private popup: HTMLElement | null = null;
	private submitted = false;
	private closed = false;
	private busy = false;
	private deleteArmed = false;
	private scope: Scope | null = null;
	private swatches: HTMLButtonElement[] = [];
	private textarea: HTMLTextAreaElement | null = null;
	private deleteButton: ButtonComponent | null = null;
	private readonly doc: Document;
	private readonly win: Window;
	private outsideHandler: ((event: PointerEvent) => void) | null = null;
	private scrollHandler: ((event: Event) => void) | null = null;
	private resizeHandler: (() => void) | null = null;

	constructor(app: App, options: AnnotationPopupOptions) {
		this.app = app;
		this.options = options;
		this.color = options.draft.annotation?.color ?? options.defaultColor;
		this.doc = app.workspace.containerEl.ownerDocument ?? document;
		this.win = this.doc.defaultView ?? window;
	}

	open(anchor?: PopupAnchor): void {
		const popup = this.doc.body.createDiv({ cls: "mas-annotation-popup" });
		popup.setAttribute("role", "dialog");
		popup.setAttribute("aria-label", this.options.draft.annotation ? "Edit annotation" : "Annotate selection");
		this.popup = popup;

		const row = popup.createDiv({ cls: "mas-annotation-popup-row" });
		const label = row.createEl("label", { cls: "mas-annotation-label", text: "Comment" });
		label.setAttribute("for", "mas-annotation-comment");

		const swatchRow = row.createDiv({ cls: "mas-annotation-popup-swatches" });
		swatchRow.setAttribute("role", "radiogroup");
		swatchRow.setAttribute("aria-label", "Highlight colour");
		for (const color of COLORS) {
			const button = swatchRow.createEl("button", {
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
		swatchRow.addEventListener("keydown", (event) => this.onSwatchKey(event));

		const textarea = popup.createEl("textarea", {
			cls: "mas-annotation-comment",
			attr: {
				id: "mas-annotation-comment",
				placeholder: "Comment (Markdown; wikilinks welcome)",
				rows: "3",
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

		const footer = popup.createDiv({ cls: "mas-annotation-popup-footer" });
		const hint = footer.createDiv({ cls: "mas-annotation-hint" });
		hint.setText("Esc · Cmd/Ctrl+Enter");
		const buttons = footer.createDiv({ cls: "mas-annotation-popup-buttons" });
		if (this.options.onDelete) {
			this.deleteButton = new ButtonComponent(buttons)
				.setButtonText("Delete")
				.setClass("mod-warning")
				.onClick(() => { void this.delete(); });
		}
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close("button"));
		new ButtonComponent(buttons)
			.setButtonText("Save")
			.setCta()
			.onClick(() => { void this.save(); });

		popup.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.close("escape");
			}
		});

		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (event) => {
			event.preventDefault();
			void this.save();
			return false;
		});
		this.scope.register([], "Escape", (event) => {
			event.preventDefault();
			this.close("escape");
			return false;
		});
		this.app.keymap.pushScope(this.scope);

		this.outsideHandler = (event: PointerEvent) => {
			if (!this.popup?.contains(event.target as Node)) this.close("outside");
		};
		this.doc.addEventListener("pointerdown", this.outsideHandler, true);
		this.scrollHandler = (event: Event) => {
			if (!this.popup?.contains(event.target as Node)) this.close("outside");
		};
		this.win.addEventListener("scroll", this.scrollHandler, true);
		this.resizeHandler = () => this.close("outside");
		this.win.addEventListener("resize", this.resizeHandler);

		this.win.setTimeout(() => {
			if (!this.popup) return;
			this.position(anchor);
			this.selectedSwatch()?.focus();
		}, 0);
	}

	private selectedSwatch(): HTMLButtonElement | undefined {
		return this.swatches.find((button) => button.classList.contains("is-selected")) ?? this.swatches[0];
	}

	private position(anchor?: PopupAnchor): void {
		if (!this.popup) return;
		const margin = 8;
		const rect = this.popup.getBoundingClientRect();
		let left = anchor ? anchor.left : this.win.innerWidth / 2 - rect.width / 2;
		let top = anchor ? anchor.bottom + 6 : this.win.innerHeight / 2;
		if (left + rect.width + margin > this.win.innerWidth) left = this.win.innerWidth - rect.width - margin;
		if (top + rect.height + margin > this.win.innerHeight) {
			top = (anchor?.top ?? this.win.innerHeight / 2) - rect.height - 6;
		}
		left = Math.max(margin, left);
		top = Math.max(margin, top);
		this.popup.setCssStyles({ left: `${left}px`, top: `${top}px` });
	}

	private onSwatchKey(event: KeyboardEvent): void {
		const index = COLORS.indexOf(this.color);
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const delta = event.key === "ArrowRight" ? 1 : -1;
			const next = (index + delta + COLORS.length) % COLORS.length;
			this.selectColor(COLORS[next]);
			this.swatches[next]?.focus();
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
	}

	private async save(): Promise<void> {
		if (this.busy || this.closed) return;
		this.busy = true;
		const comment = this.textarea?.value.trim() ?? "";
		try {
			await this.options.onSubmit(this.color, comment);
			this.submitted = true;
			this.close("button");
		} catch (error) {
			console.error("[midad-arabic-sources] save annotation", error);
			new Notice(`Could not save annotation: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.busy = false;
		}
	}

	private async delete(): Promise<void> {
		if (!this.options.onDelete || this.busy || this.closed) return;
		if (!this.deleteArmed) {
			this.deleteArmed = true;
			this.deleteButton?.setButtonText("Click again to delete");
			this.deleteButton?.setClass("mod-destructive");
			return;
		}
		this.busy = true;
		try {
			await this.options.onDelete();
			this.submitted = true;
			this.close("button");
		} catch (error) {
			console.error("[midad-arabic-sources] delete annotation", error);
			new Notice(`Could not delete annotation: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.busy = false;
		}
	}

	private close(reason: "escape" | "button" | "outside"): void {
		if (this.closed) return;
		this.closed = true;
		if (this.scope) {
			this.app.keymap.popScope(this.scope);
			this.scope = null;
		}
		if (this.outsideHandler) this.doc.removeEventListener("pointerdown", this.outsideHandler, true);
		if (this.scrollHandler) this.win.removeEventListener("scroll", this.scrollHandler, true);
		if (this.resizeHandler) this.win.removeEventListener("resize", this.resizeHandler);
		this.outsideHandler = null;
		this.scrollHandler = null;
		this.resizeHandler = null;
		this.popup?.remove();
		this.popup = null;
		if (!this.submitted) this.options.onCancel?.(reason);
		this.options.onClosed?.();
	}
}
