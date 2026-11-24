import { App, Keymap, MarkdownView, PaneType, Plugin, WorkspaceLeaf, parseLinktext } from "obsidian";
import { EditorView } from "@codemirror/view";

/**
 * Opening a Qur'ān citation, and landing on the verse it names.
 *
 * The two views differ in *mechanism*, not in intent: Reading view paints a real
 * `<a>` that Obsidian follows itself, Live Preview a widget `<span>` that no link
 * layer knows about. So the open is Live Preview's to perform and Reading view's
 * to leave alone, while the jump is shared — and the jump is the part that has
 * never worked, for a reason that is in this vault's own layout.
 *
 * A sūra note draws each verse heading as a gold emblem in the gutter
 * (`body .quran-ar h1 { position: absolute }` in `styles.css`). The heading
 * therefore has a visual position but no flow position, and Obsidian's
 * "go to heading" — which reads a flow offset — lands at the top of the note.
 * A rect is what there is to read, so a rect is what is used, and the retry
 * loop is because the target view renders a frame or two after it is opened.
 */

/** The pane a click asks for: the platform's rule, with `Cmd`/`Ctrl` as a last
 *  word in case the event reaches us in a shape `Keymap` does not read. */
export function paneForClick(event: MouseEvent): PaneType | boolean {
	const pane = Keymap.isModEvent(event);
	if (!pane && (event.metaKey || event.ctrlKey)) return "tab";
	return pane;
}

/**
 * Open `linktext` (`Q022#5`) as the note resolves it, then land on the verse.
 *
 * Resolving against the *source path* matters: `Q022#5` is a shortest-path
 * link, and without the note that wrote it the resolver falls back to finding
 * the file by name — which arrives without the subpath, and in this tab
 * whatever the modifier said.
 */
export async function openQuranCitation(
	app: App,
	linktext: string,
	sourcePath: string,
	pane: PaneType | boolean,
): Promise<void> {
	const { path, subpath } = parseLinktext(linktext);
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	if (!file) {
		// Not a note in this vault: let Obsidian show its own "not found"
		// behaviour, from the same source path.
		void app.workspace.openLinkText(linktext, sourcePath, pane);
		return;
	}
	const leaf = app.workspace.getLeaf(pane);
	await leaf.openFile(file, subpath ? { eState: { subpath } } : undefined);
	scheduleVerseScroll(app, file.path, subpath, leaf);
}

/** Wait for the target view, then scroll it to the verse the subpath names. */
export function scheduleVerseScroll(
	app: App,
	filePath: string,
	subpath: string,
	preferred?: WorkspaceLeaf,
): void {
	// A block reference (`#^id`) is positioned by the renderer, which knows
	// where the block is; only a heading needs this.
	if (!subpath || subpath.startsWith("#^")) return;
	const want = subpath.replace(/^#/, "").trim();
	if (!want) return;
	const attempt = (tries: number): void => {
		const leaf = markdownLeafFor(app, filePath, preferred);
		if (leaf && scrollLeafToVerse(leaf, want)) return;
		if (tries > 0) window.setTimeout(() => attempt(tries - 1), 80);
	};
	window.setTimeout(() => attempt(18), 30);
}

/** The leaf showing `filePath`, preferring the one that was just opened. */
function markdownLeafFor(
	app: App,
	filePath: string,
	preferred?: WorkspaceLeaf,
): WorkspaceLeaf | null {
	const shows = (leaf: WorkspaceLeaf | null | undefined): boolean =>
		(leaf?.view as MarkdownView | undefined)?.file?.path === filePath;
	if (shows(preferred)) return preferred ?? null;
	// Reading view has no leaf of ours to name: the tab Obsidian activated is
	// the one the reader is looking at, and an older tab showing the same note
	// must not be scrolled instead of it.
	const active = app.workspace.getMostRecentLeaf();
	if (shows(active)) return active;
	if (!preferred) return null;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		if (shows(leaf)) return leaf;
	}
	return null;
}

/** Scroll one view to its verse heading. False while the view has not rendered. */
function scrollLeafToVerse(leaf: WorkspaceLeaf, want: string): boolean {
	const container = leaf.view?.containerEl as HTMLElement | undefined;
	if (!container) return false;
	// Live Preview renders only the visible lines, so a verse further down has
	// no element to find. Its *position* does: the document holds the heading,
	// and the editor can be told to scroll there without waiting for the line.
	const editorEl = container.querySelector(".cm-editor") as HTMLElement | null;
	const editor = editorEl ? EditorView.findFromDOM(editorEl) : null;
	if (editor) {
		const match = new RegExp(`^#{1,6}[ \\t]+${want}[ \\t]*$`, "m")
			.exec(editor.state.doc.toString());
		if (match) {
			const line = editor.state.doc.lineAt(match.index);
			editor.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start" }) });
			return true;
		}
	}
	// Reading view: the heading is in the DOM but absolutely positioned, so
	// `scrollIntoView` (which works from the rect) is the reliable call.
	const heading = Array.from(
		container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
	).find((el) => (el.textContent ?? "").replace(/^#+\s*/, "").trim() === want);
	if (!heading) return false;
	heading.scrollIntoView({ block: "start" });
	return true;
}

/**
 * Reading view: leave the open to Obsidian, supply the landing.
 *
 * The anchor is a real internal link and Obsidian follows it correctly — the
 * right file, the right pane — but the jump is the broken part, so the click is
 * only *observed* here. Nothing is prevented: preventing it would navigate
 * twice, and the second navigation is the one that lands at the top.
 */
export function watchCitationClicks(plugin: Plugin, app: App): void {
	plugin.registerDomEvent(
		document,
		"click",
		(event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			const anchor = target?.closest(
				"a.mas-quran-citation, a.mas-quran-marker",
			) as HTMLElement | null;
			if (!anchor) return;
			const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (!href) return;
			const { path, subpath } = parseLinktext(href);
			const source = app.workspace.getActiveFile()?.path ?? "";
			const file = app.metadataCache.getFirstLinkpathDest(path, source);
			if (file) scheduleVerseScroll(app, file.path, subpath);
		},
		true,
	);
}
