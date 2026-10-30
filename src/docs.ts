/**
 * In-app documentation. The README and docs/*.md are bundled into main.js by
 * esbuild (see gen-assets.mjs) and rendered with Obsidian's MarkdownRenderer, so
 * users can read the guides inside the settings modal instead of going to
 * GitHub. A GitHub link is kept per page.
 */
import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { BUNDLED_ASSETS } from "./assets.generated";

export const GITHUB_DOCS_BASE =
	"https://github.com/nebedaay/Midad-Arabic-Sources/blob/main/docs/";
export const GITHUB_README_URL =
	"https://github.com/nebedaay/Midad-Arabic-Sources/blob/main/README.md";

export interface DocEntry {
	/** Filename within docs/, or "README.md" for the overview. */
	name: string;
	/** Menu label. */
	title: string;
	markdown: string;
}

/** Menu order + labels. Any doc not listed is appended automatically. */
const DOC_ORDER: [string, string][] = [
	["setup.md", "Setup"],
	["dependencies.md", "Dependencies"],
	["transliteration.md", "Transliteration"],
	["transcription.md", "Transcription"],
	["translation.md", "Translation"],
	["document-import.md", "Document import"],
	["templates.md", "Templates"],
	["zotero.md", "Zotero"],
	["midad-arabic-transliteration.md", "Midad Arabic Transliteration"],
	["commands.md", "Commands"],
	["troubleshooting.md", "Troubleshooting"],
];

/** The bundled assets are an array (gen-assets.mjs); index them by path. */
const ASSET_MAP: Record<string, string> = {};
for (const asset of BUNDLED_ASSETS) ASSET_MAP[asset.path] = asset.content;

export function getDocs(): DocEntry[] {
	const out: DocEntry[] = [];
	const seen = new Set<string>();

	// The repo README, rendered as the "Overview" page. Its `./docs/…md` links
	// are intercepted by DocsModal.show() and navigate in-app.
	const readme = ASSET_MAP["README.md"];
	if (readme) {
		out.push({ name: "README.md", title: "Overview", markdown: readme });
		seen.add("README.md");
	}

	const take = (name: string, title: string) => {
		const markdown = ASSET_MAP[`docs/${name}`];
		if (!markdown) return;
		out.push({ name, title, markdown });
		seen.add(name);
	};
	for (const [name, title] of DOC_ORDER) take(name, title);
	for (const key of Object.keys(ASSET_MAP)) {
		if (!key.startsWith("docs/")) continue;
		const name = key.slice("docs/".length);
		if (seen.has(name)) continue;
		take(name, name.replace(/\.md$/, ""));
	}

	return out;
}

export function githubDocUrl(name: string): string {
	return name === "README.md" ? GITHUB_README_URL : GITHUB_DOCS_BASE + name;
}

/** Modal with a docs navigation list and a rendered markdown pane. */
export class DocsModal extends Modal {
	private body!: HTMLElement;
	private navItems = new Map<string, HTMLElement>();
	private component = new Component();

	constructor(app: App, private initial = "README.md") {
		super(app);
	}

	onOpen(): void {
		this.component.load();
		// Width lives on the modal element (contentEl sits inside it).
		this.modalEl.addClass("mas-docs-modal");
		const { contentEl } = this;
		contentEl.addClass("mas-docs-modal");
		this.setTitle("Midad Arabic Sources documentation");
		const wrap = contentEl.createDiv({ cls: "mas-docs-wrap" });
		const nav = wrap.createDiv({ cls: "mas-docs-nav" });
		this.body = wrap.createDiv({ cls: "mas-docs-body" });

		for (const doc of getDocs()) {
			const item = nav.createEl("a", { text: doc.title, cls: "mas-docs-nav-item" });
			item.addEventListener("click", (e) => {
				e.preventDefault();
				void this.show(doc.name);
			});
			this.navItems.set(doc.name, item);
		}
		void this.show(this.initial);
	}

	/**
	 * Render a doc; internal `./other.md` links navigate within the modal, and
	 * GitHub-style `#heading` / `page.md#heading` fragments scroll to the
	 * matching heading after the Markdown has rendered.
	 */
	private async show(name: string, anchor = ""): Promise<void> {
		const docs = getDocs();
		const doc = docs.find((d) => d.name === name) ?? docs[0];
		if (!doc) return;

		for (const [n, el] of this.navItems) {
			el.toggleClass("is-active", n === doc.name);
		}

		this.body.empty();
		const gh = this.body.createDiv({ cls: "mas-docs-gh" });
		gh.createEl("a", {
			text: "Open on GitHub",
			href: githubDocUrl(doc.name),
		}).setAttr("target", "_blank");

		const content = this.body.createDiv({ cls: "mas-docs-content" });
		content.addEventListener("click", (e) => {
			const a = (e.target as HTMLElement).closest("a");
			if (!a) return;
			const href = a.getAttribute("href") ?? "";
			if (/^https?:/i.test(href)) return;
			const hash = href.indexOf("#");
			const fragment = hash >= 0 ? href.slice(hash + 1) : "";
			const base = hash >= 0 ? href.slice(0, hash) : href;
			const m = base.match(/([\w-]+\.md)$/);
			if (m && docs.some((d) => d.name === m[1])) {
				e.preventDefault();
				void this.show(m[1], fragment);
				return;
			}
			if (hash >= 0) {
				// A same-page fragment, or an Obsidian-rewritten internal href.
				e.preventDefault();
				this.scrollToAnchor(content, fragment);
			}
		});
		this.body.scrollTop = 0;
		await MarkdownRenderer.render(this.app, doc.markdown, content, "", this.component);
		if (anchor) this.scrollToAnchor(content, anchor);
	}

	/** Resolve a GitHub heading slug (or a literal heading) within this doc. */
	private scrollToAnchor(content: HTMLElement, raw: string): void {
		const wanted = decodeURIComponent(raw).replace(/^#/, "").trim();
		if (!wanted) return;
		const slug = (value: string): string => value
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.replace(/\s+/g, "-");
		const target = slug(wanted);
		const headings = Array.from(content.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
		const match = headings.find((heading) =>
			heading.id === wanted
			|| slug(heading.dataset.heading ?? heading.textContent ?? "") === target);
		if (match) match.scrollIntoView({ block: "start" });
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}
}

/** Open the docs modal (optionally at a specific page). */
export function openDocs(app: App, name = "README.md"): void {
	new DocsModal(app, name).open();
}
