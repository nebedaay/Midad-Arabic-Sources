import {
	Component,
	ItemView,
	MarkdownView,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { renderAnnotationCard } from "./cards";
import type { AnnotationService } from "./service";
import type { NavigationData, NavigationLink } from "./navigation";
import type { AnnotationTarget, SourceAnnotation } from "./types";

export const ANNOTATION_SIDEBAR_VIEW = "midad-annotation-sidebar";

export interface AnnotationSidebarData {
	notePath: string;
	noteName: string;
	workTitle: string;
	target: AnnotationTarget | null;
	annotations: SourceAnnotation[];
	navigation: NavigationData;
}

type SidebarTab = "annotations" | "navigation";

function renderAnnotationCount(parent: HTMLElement, count: number): void {
	const label = `${count} ${count === 1 ? "annotation" : "annotations"}`;
	const badge = parent.createSpan({
		cls: "mas-ann-nav__count",
		attr: { "aria-label": label, title: label },
	});
	setIcon(badge.createSpan({ cls: "mas-ann-nav__count-icon" }), "message-square-text");
	badge.createSpan({ cls: "mas-ann-nav__count-number", text: String(count) });
}

/**
 * Right-side list of the active note's annotations, plus a navigation tab for
 * the note's place in the Midad hierarchy.
 */
export class AnnotationSidebarView extends ItemView {
	private readonly service: AnnotationService;
	private component: Component | null = null;
	private renderToken = 0;
	private activeTab: SidebarTab = "annotations";
	private navigationPath = "";
	private readonly foldedNavigation = new Set<string>();

	constructor(leaf: WorkspaceLeaf, service: AnnotationService) {
		super(leaf);
		this.service = service;
	}

	getViewType(): string {
		return ANNOTATION_SIDEBAR_VIEW;
	}

	getDisplayText(): string {
		return "Midad";
	}

	getIcon(): string {
		return "midad";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("mas-ann-sidebar");
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			// Refreshing when this sidebar itself gains focus would replace the
			// clicked node before its click handler runs. Side docks keep the note
			// context of the main area; any other leaf — a note tab, graph, canvas —
			// changes it (and a non-Midad one empties the sidebar).
			if (!leaf || leaf === this.leaf || this.isSideDockLeaf(leaf)) return;
			void this.refresh();
		}));
		// A link can replace the file in the already-active leaf without an
		// active-leaf-change event; file-open covers that same-leaf navigation.
		// A link opened from this sidebar can leave focus here, so pass the opened
		// file explicitly in that case.
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			const fromSidebar = this.app.workspace.getActiveViewOfType(AnnotationSidebarView) === this;
			void this.refresh(fromSidebar ? file : undefined);
		}));
		// Activate the sidebar on pointer-down, before the click lands. Some
		// pointer devices otherwise spend the first click only focusing the leaf.
		this.registerDomEvent(this.contentEl, "pointerdown", (event) => {
			if (event.button !== 0) return;
			this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
		});
		await this.refresh();
	}

	/** Side docks (explorer, search, this sidebar) keep the note context. */
	private isSideDockLeaf(leaf: WorkspaceLeaf): boolean {
		return !!leaf.view.containerEl.closest(".mod-left-split, .mod-right-split, .workspace-drawer");
	}

	async onClose(): Promise<void> {
		this.component?.unload();
		this.component = null;
	}

	async refresh(file?: TFile | null): Promise<void> {
		const token = ++this.renderToken;
		const data = await this.service.sidebarData(file);
		if (token !== this.renderToken) return;
		this.component?.unload();
		const component = new Component();
		component.load();
		this.component = component;

		const root = this.contentEl;
		root.empty();
		const brand = root.createDiv({ cls: "mas-ann-sidebar__brand" });
		setIcon(brand.createSpan({ cls: "mas-ann-sidebar__brand-icon" }), "midad");
		brand.createSpan({ text: "Midad" });

		const head = root.createDiv({ cls: "mas-ann-sidebar__head" });
		if (!data) {
			this.navigationPath = "";
			const activeNote = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
			head.createDiv({
				cls: "mas-ann-sidebar__empty",
				text: activeNote
					? "This note is not part of Midad."
					: "Open a note to see its annotations and navigation.",
			});
			return;
		}

		head.createDiv({ cls: "mas-ann-sidebar__title", text: data.noteName });
		const tabs = root.createDiv({
			cls: "mas-ann-sidebar__tabs",
			attr: { role: "tablist" },
		});
		const navigationTab = tabs.createEl("button", {
			cls: "mas-ann-sidebar__tab",
			text: "Navigation",
			attr: { type: "button", role: "tab" },
		});
		const hasAnnotationTab = data.target !== null;
		const annotationTab = hasAnnotationTab
			? tabs.createEl("button", {
				cls: "mas-ann-sidebar__tab",
				text: `Annotations (${data.annotations.length})`,
				attr: { type: "button", role: "tab" },
			})
			: null;
		const panels = root.createDiv({ cls: "mas-ann-sidebar__panels" });
		const annotationsPanel = panels.createDiv({
			cls: "mas-ann-sidebar__panel mas-ann-sidebar__panel--annotations",
			attr: { role: "tabpanel" },
		});
		const navigationPanel = panels.createDiv({
			cls: "mas-ann-sidebar__panel mas-ann-sidebar__panel--navigation",
			attr: { role: "tabpanel" },
		});
		if (!hasAnnotationTab || !data.annotations.length) this.activeTab = "navigation";

		const showTab = (tab: SidebarTab, scrollToCurrent = false): void => {
			if (tab === "annotations" && !annotationTab) tab = "navigation";
			this.activeTab = tab;
			const buttons: Array<{ button: HTMLButtonElement; tab: SidebarTab }> = [
				{ button: navigationTab, tab: "navigation" },
			];
			if (annotationTab) buttons.push({ button: annotationTab, tab: "annotations" });
			for (const { button, tab: name } of buttons) {
				const active = name === tab;
				button.toggleClass("is-active", active);
				button.setAttribute("aria-selected", String(active));
			}
			annotationsPanel.toggleClass("is-active", tab === "annotations");
			navigationPanel.toggleClass("is-active", tab === "navigation");
			if (tab === "navigation" && scrollToCurrent) this.scrollCurrentIntoView(navigationPanel);
		};
		navigationTab.addEventListener("click", () => showTab("navigation", true));
		annotationTab?.addEventListener("click", () => showTab("annotations"));

		await this.renderAnnotations(annotationsPanel, data, component, token);
		if (token !== this.renderToken) return;
		this.renderNavigation(navigationPanel, data.navigation);
		const scrollNavigation = this.activeTab === "navigation" && this.navigationPath !== data.notePath;
		this.navigationPath = data.notePath;
		showTab(this.activeTab, scrollNavigation);
		this.renderBottomLinks(root);
	}

	private async renderAnnotations(
		panel: HTMLElement,
		data: AnnotationSidebarData,
		component: Component,
		token: number
	): Promise<void> {
		panel.empty();
		const target = data.target;
		if (!target) {
			panel.createDiv({
				cls: "mas-ann-sidebar__empty",
				text: "This note is not set up for text annotations.",
			});
			return;
		}
		if (!data.annotations.length) {
			panel.createDiv({
				cls: "mas-ann-sidebar__empty",
				text: "No annotations on this note yet. Select text to add one.",
			});
			return;
		}
		const list = panel.createDiv({ cls: "mas-ann-sidebar__list" });
		for (const annotation of data.annotations) {
			await renderAnnotationCard(list, {
				app: this.app,
				annotation,
				target,
				component,
				variant: "sidebar",
				onActivate: () => { void this.service.revealAnnotation(target, annotation); },
				onEdit: () => { void this.service.editAnnotation(target, annotation); },
				onDelete: () => { this.service.confirmDeleteAnnotation(target, annotation); },
				onOpenNote: () => { void this.service.openAnnotationNoteForTarget(target); },
			});
			if (token !== this.renderToken) return;
		}
	}

	private renderNavigation(panel: HTMLElement, data: NavigationData): void {
		panel.empty();
		const navigation = panel.createDiv({ cls: "mas-ann-nav" });
		if (data.parents.length) {
			const parents = navigation.createDiv({ cls: "mas-ann-nav__parents" });
			for (const parent of data.parents) {
				const row = parents.createDiv({ cls: "mas-ann-nav__parent" });
				const icon = row.createSpan({ cls: "mas-ann-nav__parent-icon" });
				setIcon(icon, "arrow-up");
				this.renderNavigationLink(row, parent, "mas-ann-nav__parent-link");
			}
		}

		const scroller = navigation.createDiv({ cls: "mas-ann-nav__scroll" });
		const list = scroller.createEl("ul", { cls: "mas-ann-nav__list" });
		for (const item of data.items) {
			const row = list.createEl("li", { cls: "mas-ann-nav__item" });
			const heading = row.createDiv({
				cls: `mas-ann-nav__row${item.current ? " is-current" : ""}`,
			});
			let children: HTMLUListElement | null = null;
			if (item.current && item.children.length) {
				const folded = this.foldedNavigation.has(item.path);
				const fold = heading.createEl("button", {
					cls: "mas-ann-nav__fold",
					attr: {
						type: "button",
						"aria-label": folded ? "Expand current note" : "Collapse current note",
						"aria-expanded": String(!folded),
					},
				});
				setIcon(fold, folded ? "chevron-right" : "chevron-down");
				fold.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const next = !this.foldedNavigation.has(item.path);
					if (next) this.foldedNavigation.add(item.path);
					else this.foldedNavigation.delete(item.path);
					setIcon(fold, next ? "chevron-right" : "chevron-down");
					fold.setAttribute("aria-expanded", String(!next));
					fold.setAttribute("aria-label", next ? "Expand current note" : "Collapse current note");
					children?.toggleClass("is-collapsed", next);
				});
			}
			if (item.current) {
				heading.createSpan({ cls: "mas-ann-nav__title", text: item.title });
			} else {
				this.renderNavigationLink(heading, item, "mas-ann-nav__title");
			}
			if (item.annotationCount > 0) renderAnnotationCount(heading, item.annotationCount);
			if (item.current && item.children.length) {
				children = row.createEl("ul", { cls: "mas-ann-nav__children" });
				const folded = this.foldedNavigation.has(item.path);
				children.toggleClass("is-collapsed", folded);
				for (const child of item.children) {
					const childRow = children.createEl("li", { cls: "mas-ann-nav__child" });
					const line = childRow.createDiv({ cls: "mas-ann-nav__row" });
					this.renderNavigationLink(line, child, "mas-ann-nav__child-link");
					if (child.annotationCount > 0) renderAnnotationCount(line, child.annotationCount);
				}
			}
		}
	}

	private renderNavigationLink(parent: HTMLElement, link: NavigationLink, cls: string): void {
		const anchor = parent.createEl("a", {
			cls: `internal-link ${cls}`,
			text: link.title,
			href: "#",
		});
		anchor.dataset.href = link.path;
		anchor.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.service.openNavigationLink(link.path, link.heading);
		});
	}

	private scrollCurrentIntoView(panel: HTMLElement): void {
		window.requestAnimationFrame(() => {
			const scroller = panel.querySelector<HTMLElement>(".mas-ann-nav__scroll");
			const current = panel.querySelector<HTMLElement>(".mas-ann-nav__row.is-current");
			if (!scroller || !current) return;
			const offset = current.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
			scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - 2);
		});
	}

	private renderBottomLinks(root: HTMLElement): void {
		const nav = root.createDiv({ cls: "mas-ann-sidebar__mocs" });
		const link = (label: string, run: () => void): void => {
			const button = nav.createEl("button", { cls: "mas-ann-sidebar__moc", text: label });
			button.onclick = run;
		};
		link("Source annotations", () => { void this.service.openMoc(); });
		link("Transcriptions", () => { void this.service.openNamedNote(["Transcriptions", "Arabic transcriptions"]); });
		link("Translations", () => { void this.service.openNamedNote(["Translations", "Arabic translations"]); });
		link("Midad Arabic Sources", () => { void this.service.openNamedNote(["Midad Arabic Sources"]); });
		const manage = nav.createEl("button", { cls: "mas-ann-sidebar__moc is-manage", text: "Manage sources" });
		manage.onclick = () => { this.service.openManageSources(); };
	}
}
