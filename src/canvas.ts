/**
 * Mindmap mode for Obsidian's core Canvas.
 *
 * A mindmap on a canvas is a set of ordinary text cards joined by ordinary
 * edges. Edges created here carry `mindmap: true` (or `"next"` for the
 * timeline spine) in their data, and the central card carries
 * `mindmapLayout`. Only those edges are ever re-arranged, so the rest of the
 * canvas is left alone.
 *
 * Canvas has no public API: the types below describe the internals this file
 * relies on (checked against Obsidian 1.14).
 */
import { Menu, Platform, type View, type WorkspaceLeaf } from 'obsidian';
import { around } from 'monkey-around';
import type MindmapPlugin from './main';
import { LAYOUTS, layoutTree, normalizeLayout, type LayoutMode, type Placed, type Side } from './layout';

export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
	text?: string;
	isEditing: boolean;
	nodeEl: HTMLElement;
	contentEl?: HTMLElement;
	unknownData?: Record<string, unknown>;
	child?: { editMode?: { cm?: { state: { doc: { toString(): string } } } } };
	getData(): Record<string, unknown>;
	setData(data: Record<string, unknown>): void;
	moveTo(pos: { x: number; y: number }): void;
	setColor(color: string, render?: boolean): void;
	startEditing(): void;
	blur(): void;
	attach?(): void;
	render(): void;
	getBBox(): { minX: number; minY: number; maxX: number; maxY: number };
	onResizeDblclick?(e: { preventDefault(): void }, side: string): void;
}

interface CanvasEdge {
	id: string;
	from: { node: CanvasNode; side: Side };
	to: { node: CanvasNode; side: Side };
	color: string;
	unknownData?: Record<string, unknown>;
	getData(): Record<string, unknown>;
	setData(data: Record<string, unknown>): void;
}

export interface Canvas {
	nodes: Map<string, CanvasNode>;
	edges: Map<string, CanvasEdge>;
	selection: Set<CanvasNode | CanvasEdge>;
	wrapperEl: HTMLElement;
	readonly: boolean;
	createTextNode(options: {
		pos: { x: number; y: number };
		size: { width: number; height: number };
		text?: string;
		focus?: boolean;
		save?: boolean;
	}): CanvasNode;
	importData(data: { nodes: unknown[]; edges: unknown[] }, clear?: boolean): void;
	getEdgesForNode(node: CanvasNode): CanvasEdge[];
	selectOnly(item: CanvasNode): void;
	removeNode(node: CanvasNode): void;
	removeEdge(edge: CanvasEdge): void;
	requestSave(): void;
	requestFrame?(): void;
	nudgeSelection?(e: KeyboardEvent, dir: 'up' | 'down' | 'left' | 'right'): void;
	panIntoView?(bbox: { minX: number; minY: number; maxX: number; maxY: number }): void;
}

type CanvasView = View & { canvas?: Canvas };

interface ScopeInternal {
	keys: unknown[] & { remove(item: unknown): void };
	register(modifiers: string[], key: string, func: (e: KeyboardEvent) => boolean | undefined): unknown;
	unregister(handler: unknown): void;
}

interface DragSession {
	/** Cards being dragged, with their start position and the branch that follows them. */
	leaders: Map<CanvasNode, { x: number; y: number; followers: { node: CanvasNode; x: number; y: number }[]; inMap: boolean }>;
	applying: boolean;
	target: CanvasNode | null;
}

interface Tree {
	node: CanvasNode;
	children: Tree[];
	id: string;
}

const H_GAP = 80;
const V_GAP = 18;
const NEW_SIZE = { width: 200, height: 52 };
const MIN_SIZE = { width: 80, height: 44 };

const isNode = (x: unknown): x is CanvasNode => !!x && typeof x === 'object' && 'nodeEl' in x && 'x' in x;
const edgeKind = (e: CanvasEdge) => (e.unknownData ?? e.getData()).mindmap as boolean | 'next' | undefined;
const randomId = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export class CanvasMindmaps {
	private attached = new WeakMap<Canvas, () => void>();
	private allCleanups = new Set<() => void>();
	private anims = new WeakMap<object, number>();
	private fallbacks = new WeakMap<object, number>();
	private drags = new WeakMap<Canvas, DragSession>();
	/** Cards created by a shortcut that may still be empty. */
	private pendingNew = new Map<CanvasNode, number>();
	/** Where cards are animating to, so ordering never reads a mid-flight position. */
	private heading = new WeakMap<CanvasNode, { x: number; y: number }>();

	private pos(n: CanvasNode) {
		return this.heading.get(n) ?? { x: n.x, y: n.y };
	}

	constructor(private plugin: MindmapPlugin) {}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	attachAll() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) this.attach(leaf);
	}

	detachAll() {
		for (const cleanup of this.allCleanups) cleanup();
		this.allCleanups.clear();
	}

	private attach(leaf: WorkspaceLeaf) {
		const canvas = (leaf.view as CanvasView).canvas;
		if (!canvas || this.attached.has(canvas)) return;

		const onKey = (e: KeyboardEvent) => this.onKeydown(canvas, e);
		canvas.wrapperEl.addEventListener('keydown', onKey, true);
		const onPointerUp = () => window.setTimeout(() => this.sweepEmpty(canvas), 0);
		canvas.wrapperEl.addEventListener('pointerup', onPointerUp, true);

		// Canvas binds bare arrows to "nudge selection" in its view scope. Put our
		// handlers first: inside a mindmap arrows move the selection between topics,
		// anywhere else we hand over to the native nudge.
		const scope = (leaf.view as unknown as { scope?: ScopeInternal }).scope;
		const arrowHandlers: unknown[] = [];
		if (scope?.keys) {
			for (const [key, dir] of [
				['ArrowUp', 'up'],
				['ArrowDown', 'down'],
				['ArrowLeft', 'left'],
				['ArrowRight', 'right'],
			] as const) {
				const h = scope.register([], key, (e: KeyboardEvent) => {
					const t = e.target as HTMLElement | null;
					if (t?.isContentEditable || t?.closest?.('input, textarea')) return undefined;
					const node = this.selectedNode(canvas);
					if (this.plugin.settings.canvasMode && node && !node.isEditing && this.isInMap(canvas, node)) {
						const target = this.nearest(canvas, node, key);
						if (target) canvas.selectOnly(target);
						return false;
					}
					e.preventDefault();
					canvas.nudgeSelection?.(e, dir);
					return false;
				});
				scope.keys.remove(h);
				scope.keys.unshift(h);
				arrowHandlers.push(h);
			}
		}

		// Text cards are edited inside an iframe: watch for those editors to catch
		// Tab / Enter while typing, and to tidy up when editing ends.
		const editors = new Map<HTMLIFrameElement, () => void>();
		const hookIframe = (iframe: HTMLIFrameElement) => {
			if (editors.has(iframe)) return;
			const node = this.nodeForElement(canvas, iframe);
			if (!node) return;
			const bind = () => {
				const win = iframe.contentWindow;
				if (!win) return;
				const handler = (e: KeyboardEvent) => this.onEditorKeydown(canvas, node, e);
				win.addEventListener('keydown', handler, true);
				editors.set(iframe, () => win.removeEventListener('keydown', handler, true));
			};
			bind();
			iframe.addEventListener('load', () => {
				editors.get(iframe)?.();
				editors.delete(iframe);
				bind();
			});
		};
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				r.addedNodes.forEach((n) => {
					if (n.instanceOf(HTMLElement)) {
						if (n.tagName === 'IFRAME') hookIframe(n as HTMLIFrameElement);
						n.querySelectorAll?.('iframe').forEach((f) => hookIframe(f));
					}
				});
				r.removedNodes.forEach((n) => {
					if (!(n.instanceOf(HTMLElement))) return;
					const frames = n.tagName === 'IFRAME' ? [n as HTMLIFrameElement] : Array.from(n.querySelectorAll('iframe'));
					for (const f of frames) {
						if (!editors.has(f)) continue;
						editors.get(f)!();
						editors.delete(f);
						const node = this.nodeForElement(canvas, r.target as HTMLElement);
						if (node) this.onEditEnd(canvas, node);
					}
				});
			}
		});
		observer.observe(canvas.wrapperEl, { childList: true, subtree: true });
		canvas.wrapperEl.querySelectorAll('iframe').forEach((f) => hookIframe(f));

		// Follow the native drag: branches move with their card, and dropping a card
		// on another one re-attaches it there.
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- monkey-around wrappers rebind `this` to the patched object
		const self = this;
		const unpatch = around(canvas as unknown as Record<string, (...args: unknown[]) => unknown>, {
			handleSelectionDrag: (next) =>
				function (this: Canvas, ...args: unknown[]) {
					const result = next.apply(this, args);
					self.beginDrag(canvas);
					return result;
				},
			markMoved: (next) =>
				function (this: Canvas, ...args: unknown[]) {
					const result = next.apply(this, args);
					self.onNodeMoved(canvas, args[0]);
					return result;
				},
			updateSelection: (next) =>
				function (this: Canvas, ...args: unknown[]) {
					const result = next.apply(this, args);
					if (self.pendingNew.size) window.setTimeout(() => self.sweepEmpty(canvas), 0);
					return result;
				},
			deleteSelection: (next) =>
				function (this: Canvas, ...args: unknown[]) {
					return self.deleteSelection(canvas, () => next.apply(this, args));
				},
			setDragging: (next) =>
				function (this: Canvas, ...args: unknown[]) {
					const result = next.apply(this, args);
					if (!args[0]) self.endDrag(canvas);
					return result;
				},
		});

		const cleanup = () => {
			unpatch();
			canvas.wrapperEl.removeEventListener('keydown', onKey, true);
			canvas.wrapperEl.removeEventListener('pointerup', onPointerUp, true);
			for (const h of arrowHandlers) scope?.unregister(h);
			observer.disconnect();
			editors.forEach((off) => off());
			editors.clear();
			this.attached.delete(canvas);
			this.allCleanups.delete(cleanup);
		};
		this.attached.set(canvas, cleanup);
		this.allCleanups.add(cleanup);
	}

	private nodeForElement(canvas: Canvas, el: HTMLElement): CanvasNode | undefined {
		const nodeEl = el.closest('.canvas-node');
		if (!nodeEl) return undefined;
		for (const n of canvas.nodes.values()) if (n.nodeEl === nodeEl) return n;
		return undefined;
	}

	activeCanvas(): Canvas | undefined {
		const view = this.plugin.app.workspace.getMostRecentLeaf()?.view as CanvasView | undefined;
		return view?.getViewType?.() === 'canvas' ? view.canvas : undefined;
	}

	selectedNode(canvas: Canvas): CanvasNode | undefined {
		if (canvas.selection.size !== 1) return undefined;
		const item = canvas.selection.values().next().value;
		return isNode(item) ? item : undefined;
	}

	// ─── Tree structure ────────────────────────────────────────────────────────

	private treeEdges(canvas: Canvas, node: CanvasNode, dir: 'in' | 'out') {
		return canvas.getEdgesForNode(node).filter((e) => edgeKind(e) && (dir === 'in' ? e.to.node === node : e.from.node === node));
	}

	isInMap(canvas: Canvas, node: CanvasNode) {
		return canvas.getEdgesForNode(node).some((e) => edgeKind(e));
	}

	parentOf(canvas: Canvas, node: CanvasNode, guard = 0): CanvasNode | null {
		const e = this.treeEdges(canvas, node, 'in')[0];
		if (!e || guard > 500) return null;
		// On the timeline spine, an event's parent is its predecessor's parent.
		return edgeKind(e) === 'next' ? this.parentOf(canvas, e.from.node, guard + 1) : e.from.node;
	}

	rootOf(canvas: Canvas, node: CanvasNode): CanvasNode {
		let cur = node;
		const seen = new Set<CanvasNode>();
		for (let p = this.parentOf(canvas, cur); p && !seen.has(p); p = this.parentOf(canvas, cur)) {
			seen.add(cur);
			cur = p;
		}
		return cur;
	}

	layoutOf(root: CanvasNode): LayoutMode {
		return normalizeLayout((root.unknownData ?? root.getData()).mindmapLayout, this.plugin.settings.layout);
	}

	/** Children in reading order: spine order on timelines, else by position. */
	childrenOf(canvas: Canvas, node: CanvasNode, mode: LayoutMode): CanvasNode[] {
		const direct = this.treeEdges(canvas, node, 'out')
			.filter((e) => edgeKind(e) !== 'next')
			.map((e) => e.to.node);
		const cx = this.pos(node).x + node.width / 2;
		const isRoot = !this.parentOf(canvas, node);
		direct.sort((a, b) => {
			const pa = this.pos(a);
			const pb = this.pos(b);
			if (mode === 'timeline' && isRoot) return pa.x - pb.x || pa.y - pb.y;
			const sa = pa.x + a.width / 2 >= cx ? 0 : 1;
			const sb = pb.x + b.width / 2 >= cx ? 0 : 1;
			return sa - sb || pa.y - pb.y;
		});
		const out: CanvasNode[] = [];
		const seen = new Set<CanvasNode>();
		for (const d of direct) {
			for (let cur: CanvasNode | undefined = d; cur && !seen.has(cur); ) {
				seen.add(cur);
				out.push(cur);
				cur = this.treeEdges(canvas, cur, 'out').find((e) => edgeKind(e) === 'next')?.to.node;
			}
		}
		return out;
	}

	private buildTree(
		canvas: Canvas,
		root: CanvasNode,
		mode: LayoutMode,
		insert?: { parent: CanvasNode; node: CanvasNode; index: number },
	): Tree {
		const seen = new Set<CanvasNode>();
		const walk = (n: CanvasNode): Tree => {
			seen.add(n);
			let kids = this.childrenOf(canvas, n, mode).filter((c) => !seen.has(c));
			if (insert && insert.parent === n) {
				kids = kids.filter((k) => k !== insert.node);
				kids.splice(Math.min(insert.index, kids.length), 0, insert.node);
			}
			return { node: n, id: n.id, children: kids.map(walk) };
		};
		return walk(root);
	}

	// ─── Layout & animation ────────────────────────────────────────────────────

	relayout(
		canvas: Canvas,
		root: CanvasNode,
		opts: {
			insert?: { parent: CanvasNode; node: CanvasNode; index: number };
			done?: () => void;
			/** Read the current child order as laid out by this mode (when switching layouts). */
			orderMode?: LayoutMode;
		} = {},
	) {
		const mode = this.layoutOf(root);
		const tree = this.buildTree(canvas, root, opts.orderMode ?? mode, opts.insert);
		const byId = new Map<string, Tree>();
		const parentId = new Map<string, string>();
		const index = (t: Tree) => {
			byId.set(t.id, t);
			for (const c of t.children) {
				parentId.set(c.id, t.id);
				index(c);
			}
		};
		index(tree);

		const placed = layoutTree(
			tree,
			(id) => {
				const n = byId.get(id)!.node;
				return { w: n.width, h: n.height };
			},
			{ mode, hGap: H_GAP, vGap: V_GAP },
		);
		const rp = placed.get(root.id)!;
		const ox = root.x - rp.x;
		const oy = root.y + root.height / 2 - rp.y;

		const targets = new Map<CanvasNode, { x: number; y: number }>();
		for (const [id, p] of placed) {
			if (id === root.id) continue;
			targets.set(byId.get(id)!.node, { x: p.x + ox, y: p.y - p.h / 2 + oy });
			this.syncEdge(canvas, byId.get(id)!.node, byId.get(p.edgeFrom ?? parentId.get(id)!)!.node, p);
		}
		this.animate(canvas, root, targets, opts.done);
	}

	/** Make sure the edge into `child` comes from `from` with the right sides and kind. */
	private syncEdge(canvas: Canvas, child: CanvasNode, from: CanvasNode, p: Placed) {
		const kind: true | 'next' = p.edgeFrom ? 'next' : true;
		const fromSide = p.fromSide ?? 'right';
		const toSide = p.toSide ?? 'left';
		const incoming = this.treeEdges(canvas, child, 'in');
		const keep = incoming.find((e) => e.from.node === from && edgeKind(e) === kind);
		for (const e of incoming) if (e !== keep) canvas.removeEdge(e);
		if (keep) {
			if (keep.from.side !== fromSide || keep.to.side !== toSide) keep.setData({ ...keep.getData(), fromSide, toSide });
			return;
		}
		const color = incoming[0]?.color || child.color || '';
		canvas.importData(
			{
				nodes: [],
				edges: [
					{
						id: randomId(),
						fromNode: from.id,
						fromSide,
						toNode: child.id,
						toSide,
						toEnd: 'none',
						...(color ? { color } : {}),
						mindmap: kind,
					},
				],
			},
			false,
		);
	}

	private animationsOn() {
		const s = this.plugin.settings;
		return s.animations && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** Animate cards to their targets; `key` (the map's root) lets several maps animate at once. */
	private animate(canvas: Canvas, key: object, targets: Map<CanvasNode, { x: number; y: number }>, done?: () => void) {
		cancelAnimationFrame(this.anims.get(key) ?? 0);
		window.clearTimeout(this.fallbacks.get(key));
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			cancelAnimationFrame(this.anims.get(key) ?? 0);
			window.clearTimeout(this.fallbacks.get(key));
			for (const [n, t] of targets) {
				n.moveTo(t);
				if (this.heading.get(n) === t) this.heading.delete(n);
			}
			canvas.requestFrame?.();
			canvas.requestSave();
			done?.();
		};
		for (const [n, t] of targets) this.heading.set(n, t);
		const duration = this.animationsOn() ? this.plugin.settings.animationDuration + 60 : 0;
		const moving = Array.from(targets).filter(([n, t]) => n.x !== t.x || n.y !== t.y);
		if (!duration || !moving.length) return finish();
		const from = new Map(moving.map(([n]) => [n, { x: n.x, y: n.y }]));
		const t0 = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / duration);
			const e = 1 - Math.pow(1 - t, 3);
			for (const [n, to] of moving) {
				const f = from.get(n)!;
				n.moveTo({ x: f.x + (to.x - f.x) * e, y: f.y + (to.y - f.y) * e });
			}
			canvas.requestFrame?.();
			if (t < 1) this.anims.set(key, window.requestAnimationFrame(step));
			else finish();
		};
		this.anims.set(key, window.requestAnimationFrame(step));
		// Frames pause while the window is hidden: never leave cards mid-flight.
		this.fallbacks.set(key, window.setTimeout(finish, duration + 150));
	}

	// ─── Dragging ──────────────────────────────────────────────────────────────

	private descendants(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		const mode = this.layoutOf(this.rootOf(canvas, node));
		const out: CanvasNode[] = [];
		const walk = (n: CanvasNode) => {
			for (const c of this.childrenOf(canvas, n, mode)) {
				if (c === node || out.includes(c)) continue;
				out.push(c);
				walk(c);
			}
		};
		walk(node);
		return out;
	}

	private beginDrag(canvas: Canvas) {
		if (!this.plugin.settings.canvasMode || canvas.readonly) return;
		const selected = Array.from(canvas.selection).filter(isNode);
		const selectedSet = new Set(selected);
		const leaders: DragSession['leaders'] = new Map();
		for (const n of selected) {
			const inMap = this.isInMap(canvas, n);
			// A lone card only matters when dragged on its own (it may be dropped onto a map).
			if (!inMap && selected.length > 1) continue;
			const followers = inMap
				? this.descendants(canvas, n)
						.filter((d) => !selectedSet.has(d))
						.map((d) => ({ node: d, x: d.x, y: d.y }))
				: [];
			leaders.set(n, { x: n.x, y: n.y, followers, inMap });
		}
		if (leaders.size) this.drags.set(canvas, { leaders, applying: false, target: null });
	}

	private onNodeMoved(canvas: Canvas, item: unknown) {
		const s = this.drags.get(canvas);
		if (!s || s.applying || !isNode(item)) return;
		const lead = s.leaders.get(item);
		if (!lead) return;
		const dx = item.x - lead.x;
		const dy = item.y - lead.y;
		s.applying = true;
		for (const f of lead.followers) f.node.moveTo({ x: f.x + dx, y: f.y + dy });
		s.applying = false;
		if (s.leaders.size === 1) this.setDropTarget(s, this.dropTargetFor(canvas, item, lead));
	}

	private setDropTarget(s: DragSession, target: CanvasNode | null) {
		if (s.target === target) return;
		s.target?.nodeEl.removeClass('mm-drop-target');
		s.target = target;
		target?.nodeEl.addClass('mm-drop-target');
	}

	/** Card under the dragged card's center that it could be attached to. */
	private dropTargetFor(canvas: Canvas, node: CanvasNode, lead: DragSession['leaders'] extends Map<CanvasNode, infer V> ? V : never) {
		const cx = node.x + node.width / 2;
		const cy = node.y + node.height / 2;
		const own = new Set([node, ...lead.followers.map((f) => f.node)]);
		const parent = this.parentOf(canvas, node);
		for (const n of canvas.nodes.values()) {
			if (own.has(n) || n === parent || n.getData().type === 'group') continue;
			if (cx < n.x || cx > n.x + n.width || cy < n.y || cy > n.y + n.height) continue;
			if (!lead.inMap && !this.isInMap(canvas, n)) return null;
			return n;
		}
		return null;
	}

	private endDrag(canvas: Canvas) {
		const s = this.drags.get(canvas);
		if (!s) return;
		this.drags.delete(canvas);
		const target = s.target;
		this.setDropTarget(s, null);
		const moved = Array.from(s.leaders).filter(([n, st]) => n.x !== st.x || n.y !== st.y);
		if (!moved.length) return;
		if (target && moved.length === 1 && canvas.nodes.has(target.id)) {
			this.reparent(canvas, moved[0][0], target);
			return;
		}
		// Dropped on empty space: tidy the maps so siblings re-order around the drop.
		const roots = new Set<CanvasNode>();
		for (const [n, st] of moved) {
			if (!st.inMap) continue;
			const root = this.rootOf(canvas, n);
			if (root !== n) roots.add(root);
		}
		for (const root of roots) this.relayout(canvas, root);
	}

	private addEdge(canvas: Canvas, from: CanvasNode, to: CanvasNode, kind: true | 'next', color: string) {
		canvas.importData(
			{
				nodes: [],
				edges: [
					{
						id: randomId(),
						fromNode: from.id,
						fromSide: 'right',
						toNode: to.id,
						toSide: 'left',
						toEnd: 'none',
						...(color ? { color } : {}),
						mindmap: kind,
					},
				],
			},
			false,
		);
	}

	/** Attach `node` (and its branch) under `target`, closing any gap it leaves behind. */
	reparent(canvas: Canvas, node: CanvasNode, target: CanvasNode) {
		const oldRoot = this.rootOf(canvas, node);
		const branch = [node, ...this.descendants(canvas, node)];
		const incoming = this.treeEdges(canvas, node, 'in')[0];
		const nextOnSpine = this.treeEdges(canvas, node, 'out').find((e) => edgeKind(e) === 'next');
		if (incoming) canvas.removeEdge(incoming);
		if (nextOnSpine) {
			canvas.removeEdge(nextOnSpine);
			if (incoming) this.addEdge(canvas, incoming.from.node, nextOnSpine.to.node, edgeKind(incoming) === 'next' ? 'next' : true, nextOnSpine.to.node.color);
		}
		const newRoot = this.rootOf(canvas, target);
		if (newRoot === target && !(newRoot.unknownData ?? newRoot.getData()).mindmapLayout) {
			newRoot.setData({ ...newRoot.getData(), mindmapLayout: this.plugin.settings.layout });
		}
		if ((node.unknownData ?? node.getData()).mindmapLayout) {
			const { mindmapLayout: _drop, ...rest } = node.getData();
			node.setData(rest);
		}
		// Take on the colour of the new branch.
		const color = this.branchColor(canvas, target, newRoot);
		if (this.plugin.settings.colorfulBranches && color) {
			for (const n of branch) {
				n.setColor(color);
				for (const e of this.treeEdges(canvas, n, 'in')) e.setData({ ...e.getData(), color });
			}
		}
		this.addEdge(canvas, target, node, true, color);
		canvas.selectOnly(node);
		this.relayout(canvas, newRoot);
		if (oldRoot !== newRoot && oldRoot !== node && canvas.nodes.has(oldRoot.id)) this.relayout(canvas, oldRoot);
	}

	// ─── Editing operations ────────────────────────────────────────────────────

	private branchColor(canvas: Canvas, parent: CanvasNode, root: CanvasNode): string {
		if (!this.plugin.settings.colorfulBranches) return '';
		if (parent !== root) return parent.color;
		const used = this.childrenOf(canvas, root, this.layoutOf(root)).length;
		return String((used % 6) + 1);
	}

	addChild(canvas: Canvas, parent: CanvasNode, index?: number) {
		if (canvas.readonly) return;
		const root = this.rootOf(canvas, parent);
		if (root === parent && !(root.unknownData ?? root.getData()).mindmapLayout) {
			root.setData({ ...root.getData(), mindmapLayout: this.plugin.settings.layout });
		}
		const mode = this.layoutOf(root);
		const color = this.branchColor(canvas, parent, root);
		this.sweepEmpty(canvas);
		const node = canvas.createTextNode({
			pos: { x: parent.x + parent.width / 2 - NEW_SIZE.width / 2, y: parent.y + parent.height / 2 - NEW_SIZE.height / 2 },
			size: { ...NEW_SIZE },
			text: '',
			focus: false,
			save: false,
		});
		if (color) node.setColor(color);
		this.pendingNew.set(node, performance.now());
		window.setTimeout(() => this.sweepEmpty(canvas), 800);
		node.nodeEl.addClass('mm-canvas-enter');
		window.setTimeout(() => node.nodeEl.removeClass('mm-canvas-enter'), 600);

		// Wire the edge to the parent now; relayout re-routes it onto the spine if needed.
		canvas.importData(
			{
				nodes: [],
				edges: [
					{
						id: randomId(),
						fromNode: parent.id,
						fromSide: 'right',
						toNode: node.id,
						toSide: 'left',
						toEnd: 'none',
						...(color ? { color } : {}),
						mindmap: true,
					},
				],
			},
			false,
		);
		const siblings = this.childrenOf(canvas, parent, mode).filter((c) => c !== node);
		this.relayout(canvas, root, {
			insert: { parent, node, index: index ?? siblings.length },
			done: () => node.getBBox && canvas.panIntoView?.(node.getBBox()),
		});
		node.attach?.();
		node.render();
		canvas.selectOnly(node);
		node.startEditing();
	}

	addSibling(canvas: Canvas, node: CanvasNode) {
		const parent = this.parentOf(canvas, node);
		if (!parent) return this.addChild(canvas, node);
		const root = this.rootOf(canvas, node);
		const siblings = this.childrenOf(canvas, parent, this.layoutOf(root));
		this.addChild(canvas, parent, siblings.indexOf(node) + 1);
	}

	/** Remove a topic and its whole branch, closing the gap on a timeline spine. No relayout. */
	private removeBranch(canvas: Canvas, node: CanvasNode) {
		if (!canvas.nodes.has(node.id)) return;
		const branch = [node, ...this.descendants(canvas, node)];
		const incoming = this.treeEdges(canvas, node, 'in')[0];
		const next = this.treeEdges(canvas, node, 'out').find((e) => edgeKind(e) === 'next');
		for (const n of branch) canvas.removeNode(n);
		if (incoming && next && canvas.nodes.has(next.to.node.id) && canvas.nodes.has(incoming.from.node.id)) {
			this.addEdge(canvas, incoming.from.node, next.to.node, edgeKind(incoming) === 'next' ? 'next' : true, next.to.node.color);
		}
	}

	deleteBranch(canvas: Canvas, node: CanvasNode) {
		if (canvas.readonly) return;
		const parent = this.parentOf(canvas, node);
		const root = this.rootOf(canvas, node);
		const siblings = parent ? this.childrenOf(canvas, parent, this.layoutOf(root)) : [];
		const i = siblings.indexOf(node);
		const next = siblings[i + 1] ?? siblings[i - 1] ?? parent;
		this.removeBranch(canvas, node);
		if (next && canvas.nodes.has(next.id)) canvas.selectOnly(next);
		if (canvas.nodes.has(root.id)) this.relayout(canvas, root);
		else canvas.requestSave();
	}

	/**
	 * Every deletion path of the Canvas (Delete key, toolbar trash, menu) ends here:
	 * topics take their branch with them and their mindmaps are tidied once.
	 */
	private deleteSelection(canvas: Canvas, native: () => unknown) {
		if (!this.plugin.settings.canvasMode || canvas.readonly) return native();
		const nodes = Array.from(canvas.selection).filter(isNode);
		const topics = nodes.filter((n) => this.isInMap(canvas, n) && this.parentOf(canvas, n));
		if (!topics.length) return native();
		const roots = new Set(topics.map((n) => this.rootOf(canvas, n)));
		const firstParent = this.parentOf(canvas, topics[0]);
		for (const n of topics) this.removeBranch(canvas, n);
		// Whatever else was selected (other cards, edges) goes the native way.
		const result = canvas.selection.size ? native() : undefined;
		for (const root of roots) if (canvas.nodes.has(root.id)) this.relayout(canvas, root);
		if (firstParent && canvas.nodes.has(firstParent.id)) canvas.selectOnly(firstParent);
		canvas.requestSave();
		return result;
	}


	setLayout(canvas: Canvas, node: CanvasNode, mode: LayoutMode) {
		const root = this.rootOf(canvas, node);
		const previous = this.layoutOf(root);
		root.setData({ ...root.getData(), mindmapLayout: mode });
		this.relayout(canvas, root, { orderMode: previous });
	}

	private onEditEnd(canvas: Canvas, node: CanvasNode) {
		if (!canvas.nodes.has(node.id) || !this.isInMap(canvas, node)) return;
		// Wait for the card's preview to render, then shrink-wrap it around its text.
		window.setTimeout(() => {
			if (!canvas.nodes.has(node.id) || node.isEditing) return;
			// Like the Markdown view: a topic left empty disappears.
			if (this.isEmptyLeaf(canvas, node)) {
				const parent = this.parentOf(canvas, node);
				this.pendingNew.delete(node);
				this.deleteBranch(canvas, node);
				if (parent && canvas.nodes.has(parent.id)) canvas.selectOnly(parent);
				return;
			}
			this.fitCard(node);
			this.relayout(canvas, this.rootOf(canvas, node));
		}, 150);
	}

	/** Drop new cards that were left empty and are no longer being edited or selected. */
	private sweepEmpty(canvas: Canvas) {
		const roots = new Set<CanvasNode>();
		const now = performance.now();
		for (const [n, created] of Array.from(this.pendingNew)) {
			if (!canvas.nodes.has(n.id)) {
				this.pendingNew.delete(n);
				continue;
			}
			if ((n as unknown as { canvas: Canvas }).canvas !== canvas) continue;
			if (n.isEditing) {
				// Check again once editing ends, even if the editor's exit went unnoticed.
				window.setTimeout(() => this.sweepEmpty(canvas), 500);
				continue;
			}
			// Still selected and just created: its editor may be about to open.
			if (canvas.selection.has(n) && now - created < 600) {
				window.setTimeout(() => this.sweepEmpty(canvas), 650 - (now - created));
				continue;
			}
			this.pendingNew.delete(n);
			if (!this.isEmptyLeaf(canvas, n)) continue;
			roots.add(this.rootOf(canvas, n));
			this.removeBranch(canvas, n);
		}
		for (const root of roots) if (canvas.nodes.has(root.id)) this.relayout(canvas, root);
	}

	/** An empty card at the end of a branch (never the central topic). */
	private isEmptyLeaf(canvas: Canvas, node: CanvasNode) {
		if (node.getData().type !== 'text' || (node.text ?? '').trim()) return false;
		if (!this.parentOf(canvas, node)) return false;
		return this.childrenOf(canvas, node, this.layoutOf(this.rootOf(canvas, node))).length === 0;
	}

	/** Re-arrange a map after removing empty end-of-branch cards. */
	tidy(canvas: Canvas, node: CanvasNode) {
		const root = this.rootOf(canvas, node);
		for (let pass = 0; pass < 20; pass++) {
			const mode = this.layoutOf(root);
			const empties: CanvasNode[] = [];
			const walk = (n: CanvasNode) => {
				for (const c of this.childrenOf(canvas, n, mode)) {
					if (this.isEmptyLeaf(canvas, c)) empties.push(c);
					else walk(c);
				}
			};
			walk(root);
			if (!empties.length) break;
			for (const e of empties) this.removeBranch(canvas, e);
		}
		this.relayout(canvas, root);
	}

	/** Like double-clicking a card's edges: fit width, then height. Skipped if the preview can't be measured. */
	private fitCard(node: CanvasNode) {
		const preview = (node.child as { previewMode?: { renderer?: { previewEl?: HTMLElement } } } | undefined)
			?.previewMode?.renderer?.previewEl;
		if (!(node.text ?? '').trim() || !node.onResizeDblclick || !preview || preview.clientHeight === 0) return;
		const before = { width: node.width, height: node.height };
		try {
			node.onResizeDblclick({ preventDefault() {} }, 'right');
			node.onResizeDblclick({ preventDefault() {} }, 'bottom');
		} catch (err) {
			console.warn('[native-mindmap] could not fit card', err);
		}
		const width = Math.max(MIN_SIZE.width, Math.min(node.width, 420));
		const height = Math.max(MIN_SIZE.height, node.height);
		if (!Number.isFinite(width) || !Number.isFinite(height)) node.setData({ ...node.getData(), ...before });
		else if (width !== node.width || height !== node.height) node.setData({ ...node.getData(), width, height });
	}

	// ─── Keyboard ──────────────────────────────────────────────────────────────

	private onKeydown(canvas: Canvas, e: KeyboardEvent) {
		if (!this.plugin.settings.canvasMode || canvas.readonly || e.defaultPrevented || e.isComposing) return;
		const target = e.target as HTMLElement;
		if (target.isContentEditable || target.closest('input, textarea')) return;
		const node = this.selectedNode(canvas);
		if (!node || node.isEditing) return;
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		if (mod || e.altKey) return;
		const inMap = this.isInMap(canvas, node);
		const run = (fn: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			fn();
		};
		// Shortcuts typed before a new topic's editor opened: never stack empty cards.
		if ((e.key === 'Tab' || e.key === 'Enter') && this.isEmptyLeaf(canvas, node)) return run(() => {});
		switch (e.key) {
			case 'Tab':
				if (!e.shiftKey) run(() => this.addChild(canvas, node));
				return;
			case 'Enter':
				if (!inMap || e.shiftKey) return;
				return run(() => this.addSibling(canvas, node));
			case 'F2':
				return run(() => node.startEditing());
			case 'Delete':
			case 'Backspace':
				// Deleting a topic removes its whole branch and closes the gap.
				if (inMap) run(() => this.deleteBranch(canvas, node));
				return;
		}
	}

	private onEditorKeydown(canvas: Canvas, node: CanvasNode, e: KeyboardEvent) {
		if (!this.plugin.settings.canvasMode || e.isComposing || e.defaultPrevented) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const text = node.child?.editMode?.cm?.state.doc.toString() ?? node.text ?? '';
		if (text.includes('\n')) return; // multi-line cards keep normal editor behavior
		const inMap = this.isInMap(canvas, node);
		const commit = () => {
			e.preventDefault();
			e.stopPropagation();
			node.blur();
		};
		// Tab / Enter on an empty topic just drops it, as in the Markdown view.
		if (!text.trim() && inMap && (e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
			commit();
			this.onEditEnd(canvas, node);
			return;
		}
		if (e.key === 'Tab' && !e.shiftKey) {
			commit();
			this.addChild(canvas, node);
		} else if (e.key === 'Enter' && !e.shiftKey && inMap) {
			commit();
			this.addSibling(canvas, node);
		}
	}

	/** Closest card of the same mindmap in an arrow-key direction. */
	private nearest(canvas: Canvas, from: CanvasNode, key: string): CanvasNode | undefined {
		const root = this.rootOf(canvas, from);
		const members: CanvasNode[] = [];
		const walk = (n: CanvasNode) => {
			members.push(n);
			for (const c of this.childrenOf(canvas, n, this.layoutOf(root))) if (!members.includes(c)) walk(c);
		};
		walk(root);
		const [ux, uy] = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[key];
		const cx = from.x + from.width / 2;
		const cy = from.y + from.height / 2;
		let best = Infinity;
		let target: CanvasNode | undefined;
		for (const n of members) {
			if (n === from) continue;
			const dx = n.x + n.width / 2 - cx;
			const dy = n.y + n.height / 2 - cy;
			const along = dx * ux + dy * uy;
			if (along <= 1) continue;
			const score = along + Math.abs(dx * uy - dy * ux) * 2.5;
			if (score < best) {
				best = score;
				target = n;
			}
		}
		return target;
	}

	// ─── Menus ─────────────────────────────────────────────────────────────────

	addNodeMenuItems(menu: Menu, node: CanvasNode) {
		const canvas = (node as unknown as { canvas: Canvas }).canvas;
		if (!this.plugin.settings.canvasMode || !canvas || canvas.readonly) return;
		menu.addItem((i) =>
			i
				.setSection('mindmap')
				.setTitle('Add child topic')
				.setIcon('corner-down-right')
				.onClick(() => this.addChild(canvas, node)),
		);
		if (!this.isInMap(canvas, node)) return;
		menu.addItem((i) =>
			i
				.setSection('mindmap')
				.setTitle('Add sibling topic')
				.setIcon('plus')
				.onClick(() => this.addSibling(canvas, node)),
		);
		const current = this.layoutOf(this.rootOf(canvas, node));
		for (const l of LAYOUTS) {
			menu.addItem((i) =>
				i
					.setSection('mindmap')
					.setTitle(`Layout: ${l.name}`)
					.setIcon(l.icon)
					.setChecked(l.id === current)
					.onClick(() => this.setLayout(canvas, node, l.id)),
			);
		}
		menu.addItem((i) =>
			i
				.setSection('mindmap')
				.setTitle('Tidy up mindmap')
				.setIcon('sparkles')
				.onClick(() => this.tidy(canvas, node)),
		);
	}
}
