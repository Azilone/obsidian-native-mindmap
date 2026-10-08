/**
 * Data model: a mindmap is a plain Markdown note.
 *
 *   ---
 *   mindmap-plugin: basic
 *   ---
 *
 *   # Central topic
 *
 *   - Branch
 *   	- Sub topic
 *
 * The first H1 is the central topic, the nested bullet list is the tree.
 * Anything else in the note is preserved and written back after the list.
 */

export const FRONTMATTER_KEY = 'mindmap-plugin';

export interface MindNode {
	id: string;
	text: string;
	children: MindNode[];
	collapsed: boolean;
}

export interface MindDoc {
	frontmatter: string;
	root: MindNode;
	extra: string;
}

let seq = 0;
export function uid(): string {
	seq = (seq + 1) % 1e9;
	return `n${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createNode(text = ''): MindNode {
	return { id: uid(), text, children: [], collapsed: false };
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])(?:[ \t]+(.*))?$/;
const H1_RE = /^#[ \t]+(.+?)[ \t]*$/;

function indentWidth(ws: string): number {
	let w = 0;
	for (const ch of ws) w += ch === '\t' ? 4 : 1;
	return w;
}

class ListBuilder {
	private stack: { indent: number; node: MindNode }[] = [];
	constructor(private root: MindNode) {}

	add(indent: number, text: string): MindNode {
		while (this.stack.length && this.stack[this.stack.length - 1].indent >= indent) this.stack.pop();
		const parent = this.stack.length ? this.stack[this.stack.length - 1].node : this.root;
		const node = createNode(text);
		parent.children.push(node);
		this.stack.push({ indent, node });
		return node;
	}
}

export function parseDoc(data: string, fallbackTitle: string): MindDoc {
	let body = data;
	let frontmatter = '';
	const fm = FRONTMATTER_RE.exec(data);
	if (fm) {
		frontmatter = fm[0].trimEnd();
		body = data.slice(fm[0].length);
	}

	const root = createNode(fallbackTitle);
	const list = new ListBuilder(root);
	const extra: string[] = [];
	let titleFound = false;
	let last: MindNode | null = null;

	for (const line of body.split(/\r?\n/)) {
		const m = LIST_RE.exec(line);
		if (m) {
			last = list.add(indentWidth(m[1]), (m[2] ?? '').trim());
			continue;
		}
		if (!titleFound && root.children.length === 0 && extra.length === 0) {
			const h = H1_RE.exec(line);
			if (h) {
				root.text = h[1];
				titleFound = true;
				continue;
			}
		}
		// Indented continuation of a list item.
		if (last && /^[ \t]+\S/.test(line)) {
			last.text = `${last.text} ${line.trim()}`.trim();
			continue;
		}
		if (line.trim() === '') {
			if (extra.length) extra.push('');
			continue;
		}
		extra.push(line);
		last = null;
	}

	return { frontmatter, root, extra: extra.join('\n').trim() };
}

export function toMarkdownList(nodes: MindNode[], depth = 0): string {
	const lines: string[] = [];
	const walk = (n: MindNode, d: number) => {
		lines.push(`${'\t'.repeat(d)}- ${n.text}`.trimEnd());
		n.children.forEach((c) => walk(c, d + 1));
	};
	nodes.forEach((n) => walk(n, depth));
	return lines.join('\n');
}

export function serializeDoc(doc: MindDoc): string {
	const parts: string[] = [];
	if (doc.frontmatter) parts.push(doc.frontmatter, '');
	parts.push(`# ${doc.root.text.trim() || 'Untitled'}`);
	const list = toMarkdownList(doc.root.children);
	if (list) parts.push('', list);
	if (doc.extra) parts.push('', doc.extra);
	return parts.join('\n') + '\n';
}

/** Parse pasted text (a Markdown list or plain lines) into new nodes. */
export function parseFragment(text: string): MindNode[] {
	const root = createNode();
	const list = new ListBuilder(root);
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const m = LIST_RE.exec(line);
		if (m) list.add(indentWidth(m[1]), (m[2] ?? '').trim());
		else list.add(indentWidth(/^[ \t]*/.exec(line)![0]), line.trim().replace(/^#+\s+/, ''));
	}
	return root.children;
}

export function cloneTree(node: MindNode): MindNode {
	return {
		id: node.id,
		text: node.text,
		collapsed: node.collapsed,
		children: node.children.map(cloneTree),
	};
}

/** Keep ids (and fold state) stable across re-parses so the view can animate the diff. */
export function reuseIds(prev: MindNode, next: MindNode): void {
	next.id = prev.id;
	next.collapsed = prev.collapsed;
	const n = Math.min(prev.children.length, next.children.length);
	for (let i = 0; i < n; i++) reuseIds(prev.children[i], next.children[i]);
}

export function countDescendants(node: MindNode): number {
	let n = 0;
	for (const c of node.children) n += 1 + countDescendants(c);
	return n;
}
