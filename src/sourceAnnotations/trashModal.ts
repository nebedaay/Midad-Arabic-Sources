import { App, ButtonComponent, Modal, Notice } from "obsidian";
import { ConfirmModal } from "./modal";
import type { AnnotationService } from "./service";
import type { AnnotationTrashBatch } from "./store";

/** Restore or permanently delete annotation batches. */
export class AnnotationTrashModal extends Modal {
	private readonly service: AnnotationService;

	constructor(app: App, service: AnnotationService) {
		super(app);
		this.service = service;
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		this.titleEl.setText("Annotation trash");
		contentEl.empty();
		contentEl.addClass("mas-trash-modal");
		contentEl.createEl("p", {
			text: "Deleted annotations and their notes stay here for the retention period set in Settings → annotations. Restoring brings back the annotation note and its store.",
		});

		let batches: AnnotationTrashBatch[] = [];
		try {
			batches = await this.service.listTrash();
		} catch (error) {
			console.error("[midad-arabic-sources] list annotation trash", error);
		}
		if (!batches.length) {
			contentEl.createEl("p", { text: "The annotation trash is empty." });
			return;
		}

		const list = contentEl.createDiv({ cls: "mas-trash-list" });
		for (const batch of batches) {
			const row = list.createDiv({ cls: "mas-trash-row" });
			const info = row.createDiv({ cls: "mas-trash-info" });
			info.createDiv({ cls: "mas-trash-title", text: batch.workTitle || batch.workKey });
			info.createDiv({
				cls: "mas-trash-meta",
				text: `${batch.count} annotation(s) · ${batch.sourceStatus} · deleted ${batch.deletedAt.slice(0, 10)}`,
			});
			const actions = row.createDiv({ cls: "mas-trash-actions" });
			new ButtonComponent(actions)
				.setButtonText("Restore")
				.onClick(async () => {
					try {
						await this.service.restoreTrashBatch(batch.path);
						await this.render();
					} catch (error) {
						new Notice(`Could not restore: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
			new ButtonComponent(actions)
				.setButtonText("Delete permanently")
				.setDestructive()
				.onClick(() => {
					new ConfirmModal(this.app, {
						title: "Delete annotation batch",
						message: "Permanently delete these annotations and the archived note? This cannot be undone.",
						confirmText: "Delete permanently",
						onConfirm: async () => {
							await this.service.emptyTrash(batch.path);
							await this.render();
						},
					}).open();
				});
		}

		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(footer)
			.setButtonText("Empty trash")
			.setDestructive()
			.onClick(() => {
				new ConfirmModal(this.app, {
					title: "Empty annotation trash",
					message: `Permanently delete all ${batches.length} batch(es)? This cannot be undone.`,
					confirmText: "Empty trash",
					onConfirm: async () => {
						await this.service.emptyTrash();
						await this.render();
					},
				}).open();
			});
		new ButtonComponent(footer)
			.setButtonText("Close")
			.onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
