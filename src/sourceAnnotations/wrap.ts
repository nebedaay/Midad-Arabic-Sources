import { annotationClass, bandClass, resolveAnnotations } from "./resolve";
import { ANNOTATION_EVENTS, type AnnotationEventDetail } from "./events";
import type { ResolvedAnnotation, SourceAnnotation } from "./types";

interface IndexedTextNode {
	node: Text;
	start: number;
	end: number;
}

interface TextIndex {
	text: string;
	nodes: IndexedTextNode[];
}

interface WrapOperation {
	node: Text;
	start: number;
	end: number;
	logicalStart: number;
	logicalEnd: number;
	active: ResolvedAnnotation[];
}

export interface DomOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

/** Element factory, so the wrapper can run in Obsidian and in a DOM test. */
export interface DomFactory {
	el<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: DomOptions): HTMLElementTagNameMap[K];
	span(opts?: DomOptions): HTMLSpanElement;
}

const obsidianDom: DomFactory = {
	el(tag, opts) {
		return createEl(tag, opts);
	},
	span(opts) {
		return createSpan(opts);
	},
};

const SKIP_SELECTOR = [
	"script",
	"style",
	"code",
	"pre",
	"button",
	".callout-title",
	".callout-icon",
	".callout-fold",
	".copy-code-button",
	".list-bullet",
	".list-number",
	".task-list-item-checkbox",
	".math",
	".frontmatter",
	".markdown-embed",
	".internal-embed",
	".mas-ann-icon",
	".mas-annotation",
].join(", ");

const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL",
	"FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
	"H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
	"SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** Remove any previous annotation markup so a re-run is idempotent. */
export function unwrapAnnotations(root: HTMLElement): void {
	root.querySelectorAll(".mas-ann-icon").forEach((el) => el.remove());
	root.querySelectorAll(".mas-ann-margin").forEach((el) => el.remove());
	root.querySelectorAll(".mas-ann-margin-host").forEach((el) => el.classList.remove("mas-ann-margin-host"));
	root.classList.remove("mas-has-annotations");
	let mark = root.querySelector(".mas-annotation");
	while (mark) {
		const parent = mark.parentNode;
		if (!parent) break;
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		parent.removeChild(mark);
		mark = root.querySelector(".mas-annotation");
	}
}

/** Build a logical text string and a map back to the rendered text nodes. */
function buildTextIndex(root: HTMLElement): TextIndex {
	const nodes: IndexedTextNode[] = [];
	let text = "";
	const newline = () => {
		if (text && !text.endsWith("\n")) text += "\n";
	};
	const walk = (node: Node): void => {
		if (node.nodeType === 3) {
			const value = (node as Text).data;
			if (!value) return;
			const start = text.length;
			text += value;
			nodes.push({ node: node as Text, start, end: text.length });
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node as HTMLElement;
		if (el.matches(SKIP_SELECTOR)) return;
		if (el.tagName === "BR") {
			text += "\n";
			return;
		}
		const block = BLOCK_TAGS.has(el.tagName);
		if (block) newline();
		for (const child of Array.from(el.childNodes)) walk(child);
		if (block) newline();
	};
	walk(root);
	return { text, nodes };
}

function makeSegment(
	dom: DomFactory,
	segment: Text,
	active: ResolvedAnnotation[],
	logicalStart: number,
	logicalEnd: number
): void {
	const allIds = active.map((annotation) => annotation.id).join(" ");
	const allStart = active.every((annotation) =>
		annotation.ranges.some((range) => range.start === logicalStart)
	);
	const allEnd = active.every((annotation) =>
		annotation.ranges.some((range) => range.end === logicalEnd)
	);
	let current: Node = segment;
	for (let i = active.length - 1; i >= 0; i--) {
		const annotation = active[i];
		const classes = ["mas-annotation", annotationClass(annotation.color)];
		if (active.length > 1) {
			classes.push("mas-annotation-multi", "mas-band");
			const band = bandClass(active.length, i);
			if (band) classes.push(band);
		}
		if (allStart) classes.push("mas-seg-start");
		if (allEnd) classes.push("mas-seg-end");
		// A span, not a mark: Reading view's default `mark` background would
		// show through the transparent parts of the bands and make them brighter
		// (and a blue band over a yellow mark look grey).
		const mark = dom.el("span", { cls: classes.join(" "), attr: { role: "mark" } });
		mark.dataset.annId = annotation.id;
		mark.dataset.annIds = allIds;
		const parent = current.parentNode;
		if (!parent) return;
		parent.insertBefore(mark, current);
		mark.appendChild(current);
		current = mark;
	}
}

function addMarginIcons(root: HTMLElement, dom: DomFactory, annotations: ResolvedAnnotation[]): void {
	const marks = Array.from(root.querySelectorAll<HTMLElement>(".mas-annotation"));
	const groups = new Map<HTMLElement, string[]>();
	for (const annotation of annotations) {
		let last: HTMLElement | null = null;
		for (const mark of marks) {
			const ids = (mark.dataset.annIds ?? "").split(" ");
			if (ids.includes(annotation.id)) last = mark;
		}
		if (!last) continue;
		const block = last.closest<HTMLElement>(
			".callout, p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th"
		) ?? root;
		const ids = groups.get(block) ?? [];
		if (!ids.includes(annotation.id)) ids.push(annotation.id);
		groups.set(block, ids);
	}
	if (!groups.size) return;
	for (const [block, ids] of groups) {
		block.classList.add("mas-ann-margin-host");
		const label = ids.length === 1 ? "1 annotation" : `${ids.length} annotations`;
		const icon = dom.el("button", {
			cls: "mas-ann-margin",
			attr: { type: "button", "aria-label": label, "data-ann-ids": ids.join(" ") },
		});
		icon.appendChild(dom.span({ cls: "mas-ann-margin-glyph", text: "💬" }));
		if (ids.length > 1) {
			icon.appendChild(dom.span({ cls: "mas-ann-margin-count", text: String(ids.length) }));
		}
		const fire = (type: string): void => {
			icon.dispatchEvent(new CustomEvent<AnnotationEventDetail>(type, {
				bubbles: true,
				detail: { ids },
			}));
		};
		icon.addEventListener("mouseenter", () => fire(ANNOTATION_EVENTS.hover));
		icon.addEventListener("mouseleave", () => fire(ANNOTATION_EVENTS.leave));
		icon.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			fire(ANNOTATION_EVENTS.open);
		});
		icon.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				fire(ANNOTATION_EVENTS.open);
			}
		});
		block.appendChild(icon);
	}
	root.classList.add("mas-has-annotations");
}

/** Paint annotations into a rendered Reading-view container. */
export function applyReadingAnnotations(
	root: HTMLElement,
	annotations: SourceAnnotation[],
	dom: DomFactory = obsidianDom
): void {
	unwrapAnnotations(root);
	if (!annotations.length) return;
	const index = buildTextIndex(root);
	const resolved = resolveAnnotations(index.text, annotations, true);
	if (!resolved.length) return;
	const boundaries = new Set<number>();
	for (const annotation of resolved) {
		boundaries.add(annotation.start);
		boundaries.add(annotation.end);
	}
	const sorted = Array.from(boundaries).sort((a, b) => a - b);
	const operations = new Map<Text, WrapOperation[]>();
	for (let i = 0; i < sorted.length - 1; i++) {
		const from = sorted[i];
		const to = sorted[i + 1];
		if (to <= from) continue;
		const active = resolved.filter((annotation) => annotation.start < to && annotation.end > from);
		if (!active.length) continue;
		for (const node of index.nodes) {
			const start = Math.max(from, node.start);
			const end = Math.min(to, node.end);
			if (end <= start) continue;
			const operation: WrapOperation = {
				node: node.node,
				start: start - node.start,
				end: end - node.start,
				logicalStart: start,
				logicalEnd: end,
				active,
			};
			const list = operations.get(node.node) ?? [];
			list.push(operation);
			operations.set(node.node, list);
		}
	}
	for (const [node, list] of operations) {
		list.sort((a, b) => b.start - a.start);
		for (const operation of list) {
			if (operation.start < 0 || operation.end > node.data.length) continue;
			if (operation.end <= operation.start) continue;
			if (!node.data.slice(operation.start, operation.end).trim()) continue;
			const middle = node.splitText(operation.start);
			middle.splitText(operation.end - operation.start);
			makeSegment(dom, middle, operation.active, operation.logicalStart, operation.logicalEnd);
		}
	}
	addMarginIcons(root, dom, resolved);
}
