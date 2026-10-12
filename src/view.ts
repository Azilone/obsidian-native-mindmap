import {
	Component,
	HoverPopover,
	Keymap,
	MarkdownRenderer,
	Menu,
	Platform,
	TextFileView,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from 'obsidian';
import type MindmapPlugin from './main';
import { LAYOUTS, layoutTree, normalizeLayout, type LayoutMode, type LayoutOptions, type Placed, type Side, type Size } from './layout';
import {
	type MindDoc,
	type MindNode,
	cloneTree,
	countDescendants,
	createNode,
	parseDoc,
	parseFragment,
	reuseIds,
	serializeDoc,
	toMarkdownList,
} from './model';
import { ShortcutsModal } from './shortcuts';

export const VIEW_TYPE_MINDMAP = 'native-mindmap';

const BRANCH_COLORS = ['blue', 'purple', 'pink', 'orange', 'green', 'cyan', 'red', 'yellow'].map(
	(c) => `var(--color-${c})`,
);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SUPPORTS_CSS_D =
	typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('d', 'path("M 0 0")');

interface NodeView {
	el: HTMLDivElement;
	content: HTMLDivElement;
	toggle: HTMLDivElement;
	renderedText: string | null;
	renderSeq: number;
	pendingText: string | null;
	component: Component | null;
}

interface Snapshot {
	tree: MindNode;
	selected: string | null;
}

interface EditState {
	id: string;
	original: string;
	snapshot: Snapshot;
	isNew: boolean;
}

interface Visible {
	node: MindNode;
	depth: number;
	branch: number;
}

interface Point {
	x: number;
	y: number;
}

type DropMode = 'inside' | 'before' | 'after';

interface DropTarget {
	id: string;
	mode: DropMode;
}

interface DragState {
	id: string;
	pointerId: number;
	start: Point;
	active: boolean;
	wasSelected: boolean;
	pointerType: string;
	ghost?: HTMLElement;
	offset?: Point;
	subtree?: Set<string>;
	movers?: string[];
	target: DropTarget | null;
}

interface PanState {
	pointerId: number;
	start: Point;
	cam: Camera;
	moved: boolean;
}

interface PinchState {
	dist: number;
	center: Point;
	cam: Camera;
}

interface Camera {
	x: number;
	y: number;
	k: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r1 = (n: number) => Math.round(n * 10) / 10;

interface InternalPlugins {
	getPluginById?(id: string): { instance?: { openGlobalSearch?(query: string): void } } | null;
}

export class MindmapView extends TextFileView {
	plugin: MindmapPlugin;
	hoverPopover: HoverPopover | null = null;

	private doc: MindDoc | null = null;
	private nodes = new Map<string, MindNode>();
	private parents = new Map<string, MindNode | null>();
	private views = new Map<string, NodeView>();
	private edges = new Map<string, SVGPathElement>();
	private layout = new Map<string, Placed>();
	/** Selected topics; `selectedId` is the anchor that keyboard actions apply to. */
	private selection = new Set<string>();
	private anchorId: string | null = null;
	private get selectedId(): string | null {
		return this.anchorId;
	}
	private set selectedId(id: string | null) {
		this.setSelection(id ? [id] : [], id);
	}
	private marquee: { pointerId: number; start: Point; additive: boolean; base: Set<string>; el: HTMLElement; moved: boolean } | null = null;
	private space: { used: boolean } | null = null;
	private editing: EditState | null = null;
	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];

	private cam: Camera = { x: 0, y: 0, k: 1 };
	private camFrame = 0;
	private needsFit = true;
	private pendingLayout = false;
	private renderChain: Promise<void> = Promise.resolve();
	private relayoutFrame = 0;

	private drag: DragState | null = null;
	private pan: PanState | null = null;
	private pinch: PinchState | null = null;
	private pointers = new Map<number, Point>();
	private lastTap = { id: '', time: 0 };
	/** Keys typed while a new topic is being created, replayed into its editor. */
	private editQueue: string | null = null;
	private editQueueCommit = false;

	private viewportEl!: HTMLDivElement;
	private worldEl!: HTMLDivElement;
	private edgesEl!: SVGSVGElement;
	private nodesEl!: HTMLDivElement;
	private zoomLabel!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: MindmapPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.buildDom();
	}

	getViewType() {
		return VIEW_TYPE_MINDMAP;
	}

	getIcon() {
		return 'network';
	}

	getDisplayText() {
		return this.file?.basename ?? 'Mindmap';
	}

	// ─── TextFileView ──────────────────────────────────────────────────────────

	getViewData(): string {
		return this.doc ? serializeDoc(this.doc) : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		const doc = parseDoc(data, this.file?.basename ?? 'Mindmap');
		if (!clear && this.doc) reuseIds(this.doc.root, doc.root);
		if (clear) this.reset();
		this.doc = doc;
		if (clear) this.selectedId = null;
		void this.render(!clear);
	}

	clear(): void {
		this.reset();
		this.doc = null;
	}

	private reset() {
		this.editing = null;
		this.undoStack = [];
		this.redoStack = [];
		this.needsFit = true;
		for (const nv of this.views.values()) if (nv.component) this.removeChild(nv.component);
		this.views.clear();
		this.edges.clear();
		this.layout.clear();
		this.nodesEl.empty();
		this.edgesEl.empty();
	}

	onload() {
		super.onload();
		const vp = this.viewportEl;
		this.registerDomEvent(vp, 'pointerdown', (e) => this.onPointerDown(e));
		this.registerDomEvent(vp, 'pointermove', (e) => this.onPointerMove(e));
		this.registerDomEvent(vp, 'pointerup', (e) => this.onPointerUp(e));
		this.registerDomEvent(vp, 'pointercancel', (e) => this.onPointerUp(e));
		this.registerDomEvent(vp, 'wheel', (e) => this.onWheel(e), { passive: false });
		this.registerDomEvent(this.containerEl, 'keydown', (e) => this.onKeyDown(e));
		this.registerDomEvent(this.containerEl, 'keyup', (e) => {
			if (e.key !== ' ' || !this.space) return;
			const used = this.space.used;
			this.space = null;
			this.viewportEl.removeClass('is-space');
			const sel = this.selectedId;
			if (!used && sel && !this.editing) void this.startEdit(sel, 'end');
		});
		this.registerDomEvent(vp, 'contextmenu', (e) => this.onContextMenu(e));
		this.registerDomEvent(this.nodesEl, 'click', (e) => this.onClick(e));
		this.registerDomEvent(this.nodesEl, 'mouseover', (e) => this.onMouseOver(e));
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				// Defer so we run after Obsidian has finished moving focus itself.
				if (leaf === this.leaf) window.setTimeout(() => !this.editing && this.isActive() && this.focusViewport(), 0);
			}),
		);
		this.registerEvent(this.app.workspace.on('css-change', () => this.invalidateAll()));
		const ro = new ResizeObserver(() => this.onResize());
		ro.observe(vp);
		this.register(() => ro.disconnect());
		this.applySettings();
	}

	async onClose() {
		cancelAnimationFrame(this.camFrame);
		cancelAnimationFrame(this.relayoutFrame);
	}

	onResize() {
		if (this.pendingLayout || this.needsFit) void this.render(false);
	}

	onPaneMenu(menu: Menu, source: string) {
		if (source === 'more-options' || source === 'tab-header') {
			menu.addItem((i) =>
				i
					.setTitle('Open as Markdown')
					.setIcon('file-text')
					.setSection('pane')
					.onClick(() => this.plugin.setMarkdownView(this.leaf)),
			);
			menu.addItem((i) =>
				i.setTitle('Expand all').setIcon('chevrons-up-down').setSection('pane').onClick(() => this.expandAll()),
			);
			menu.addItem((i) =>
				i.setTitle('Collapse all').setIcon('chevrons-down-up').setSection('pane').onClick(() => this.collapseAll()),
			);
		}
		super.onPaneMenu(menu, source);
	}

	// ─── DOM ───────────────────────────────────────────────────────────────────

	private buildDom() {
		this.contentEl.addClass('mm-view');
		this.viewportEl = this.contentEl.createDiv({ cls: 'mm-viewport' });
		this.viewportEl.tabIndex = -1;
		this.worldEl = this.viewportEl.createDiv({ cls: 'mm-world' });
		this.edgesEl = this.worldEl.createSvg('svg', { cls: 'mm-edges' });
		this.nodesEl = this.worldEl.createDiv({ cls: 'mm-nodes' });

		const controls = this.contentEl.createDiv({ cls: 'mm-controls' });
		const button = (icon: string, label: string, cb: () => void) => {
			const b = controls.createDiv({ cls: ['mm-control', 'clickable-icon'] });
			setIcon(b, icon);
			setTooltip(b, label, { placement: 'left' });
			b.addEventListener('click', cb);
		};
		button('plus', 'Zoom in', () => this.zoomBy(1.25));
		this.zoomLabel = controls.createDiv({ cls: 'mm-zoom-label', text: '100%' });
		setTooltip(this.zoomLabel, 'Reset zoom', { placement: 'left' });
		this.zoomLabel.addEventListener('click', () => this.zoomBy(1 / this.cam.k));
		button('minus', 'Zoom out', () => this.zoomBy(0.8));
		controls.createDiv({ cls: 'mm-control-sep' });
		button('maximize', 'Zoom to fit (Shift 1)', () => this.fit());
		const layoutBtn = controls.createDiv({ cls: ['mm-control', 'clickable-icon'] });
		setIcon(layoutBtn, 'layout-template');
		setTooltip(layoutBtn, 'Layout', { placement: 'left' });
		layoutBtn.addEventListener('click', (e) => this.showLayoutMenu(e));
		button('keyboard', 'Keyboard shortcuts (?)', () => new ShortcutsModal(this.app).open());
	}

	applySettings() {
		const s = this.plugin.settings;
		this.contentEl.style.setProperty('--mm-dur', `${this.duration()}ms`);
		this.contentEl.style.setProperty('--mm-max-width', `${s.maxNodeWidth}px`);
		this.viewportEl.toggleClass('has-grid', s.showGrid);
		this.applyCam();
		this.invalidateAll();
	}

	private invalidateAll() {
		void this.render(true);
	}

	private isActive() {
		return this.app.workspace.getActiveViewOfType(MindmapView) === this;
	}

	private focusViewport() {
		this.viewportEl.focus({ preventScroll: true });
	}

	private animationsOn() {
		return this.plugin.settings.animations && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	private duration() {
		return this.animationsOn() ? this.plugin.settings.animationDuration : 0;
	}

	private layoutOptions(): LayoutOptions {
		const spacing = {
			compact: { hGap: 34, vGap: 6 },
			comfortable: { hGap: 50, vGap: 12 },
			spacious: { hGap: 72, vGap: 20 },
		}[this.plugin.settings.spacing];
		return { mode: this.layoutMode(), ...spacing, kids: (n) => ((n as MindNode).collapsed ? [] : n.children) };
	}

	/** Layout of this map: `mindmap-layout` in the frontmatter, else the default from settings. */
	layoutMode(): LayoutMode {
		const m = /^mindmap-layout:\s*["']?(\w+)/m.exec(this.doc?.frontmatter ?? '');
		return normalizeLayout(m?.[1], this.plugin.settings.layout);
	}

	setLayoutMode(mode: LayoutMode) {
		const doc = this.doc;
		if (!doc || mode === this.layoutMode()) return;
		const line = `mindmap-layout: ${mode}`;
		if (/^mindmap-layout:.*$/m.test(doc.frontmatter)) doc.frontmatter = doc.frontmatter.replace(/^mindmap-layout:.*$/m, line);
		else if (doc.frontmatter) doc.frontmatter = doc.frontmatter.replace(/\r?\n---$/, `\n${line}\n---`);
		else doc.frontmatter = `---\n${line}\n---`;
		this.requestSave();
		void this.render(true).then(() => this.fit());
	}

	private showLayoutMenu(e: MouseEvent) {
		const menu = new Menu();
		const current = this.layoutMode();
		for (const l of LAYOUTS) {
			menu.addItem((i) =>
				i
					.setTitle(l.name)
					.setIcon(l.icon)
					.setChecked(l.id === current)
					.onClick(() => this.setLayoutMode(l.id)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	private branchColor(v: Visible) {
		if (v.depth === 0) return 'var(--interactive-accent)';
		if (!this.plugin.settings.colorfulBranches) return 'var(--text-faint)';
		return BRANCH_COLORS[v.branch % BRANCH_COLORS.length];
	}

	// ─── Rendering ─────────────────────────────────────────────────────────────

	/** Renders are serialized so async Markdown rendering never interleaves. */
	render(animate = true): Promise<void> {
		const run = this.renderChain
			.then(() => this.doRender(animate))
			.catch((err) => console.error('[native-mindmap]', err));
		this.renderChain = run;
		return run;
	}

	private scheduleRelayout() {
		if (this.relayoutFrame) return;
		this.relayoutFrame = window.requestAnimationFrame(() => {
			this.relayoutFrame = 0;
			void this.render(true).then(() => this.selectedId && this.ensureVisible(this.selectedId));
		});
	}

	private reindex(root: MindNode) {
		this.nodes = new Map();
		this.parents = new Map();
		const walk = (n: MindNode, parent: MindNode | null) => {
			this.nodes.set(n.id, n);
			this.parents.set(n.id, parent);
			n.children.forEach((c) => walk(c, n));
		};
		walk(root, null);
	}

	private collectVisible(root: MindNode): Visible[] {
		const out: Visible[] = [];
		const walk = (n: MindNode, depth: number, branch: number) => {
			out.push({ node: n, depth, branch });
			if (depth > 0 && n.collapsed) return;
			n.children.forEach((c, i) => walk(c, depth + 1, depth === 0 ? i : branch));
		};
		walk(root, 0, 0);
		return out;
	}

	private isMeasurable() {
		return this.viewportEl.isConnected && this.viewportEl.clientWidth > 0 && this.viewportEl.clientHeight > 0;
	}

	private async doRender(animate: boolean): Promise<void> {
		if (!this.doc) return;
		const prevParents = this.parents;
		const created = new Set<string>();
		// Markdown rendering is async and the tree may change meanwhile, so sync
		// again after each wait; the last pass runs with no await before layout.
		let visible = this.syncViews(created);
		for (let pass = 0; pass < 3 && visible.jobs.length; pass++) {
			await Promise.all(visible.jobs);
			visible = this.syncViews(created);
		}
		this.applyRender(visible.list, created, prevParents, animate);
	}

	private syncViews(created: Set<string>): { list: Visible[]; jobs: Promise<void>[] } {
		const doc = this.doc!;
		this.reindex(doc.root);
		for (const id of this.selection) if (!this.nodes.has(id)) this.selection.delete(id);
		if (this.anchorId && !this.nodes.has(this.anchorId)) this.anchorId = this.selection.values().next().value ?? null;
		const list = this.collectVisible(doc.root);
		const jobs: Promise<void>[] = [];
		for (const v of list) {
			const id = v.node.id;
			let nv = this.views.get(id);
			if (!nv) {
				nv = this.createNodeView(id);
				created.add(id);
			}
			const el = nv.el;
			el.toggleClass('mm-d0', v.depth === 0);
			el.toggleClass('mm-d1', v.depth === 1);
			el.toggleClass('mm-dn', v.depth >= 2);
			el.toggleClass('is-selected', this.selection.has(id));
			el.style.setProperty('--mm-branch', this.branchColor(v));
			this.updateToggle(nv, v);
			if (this.editing?.id !== id && nv.renderedText !== v.node.text && nv.pendingText !== v.node.text) {
				jobs.push(this.renderContent(nv, v.node.text));
			}
		}
		return { list, jobs };
	}

	private applyRender(
		visible: Visible[],
		created: Set<string>,
		prevParents: Map<string, MindNode | null>,
		animate: boolean,
	) {
		if (!this.isMeasurable()) {
			this.pendingLayout = true;
			this.needsFit = true;
			return;
		}
		this.pendingLayout = false;
		const fit = this.needsFit;
		this.applyLayout(visible, created, prevParents, animate && !fit && this.animationsOn());
		if (fit) {
			this.needsFit = false;
			this.fit(false);
		}
	}

	private createNodeView(id: string): NodeView {
		const el = this.nodesEl.createDiv({ cls: ['mm-node', 'mm-entering'] });
		el.dataset.id = id;
		const content = el.createDiv({ cls: 'mm-content' });
		const toggle = el.createDiv({ cls: 'mm-toggle' });
		const nv: NodeView = { el, content, toggle, renderedText: null, renderSeq: 0, pendingText: null, component: null };

		content.addEventListener('input', () => {
			if (this.editing?.id === id) this.scheduleRelayout();
		});
		content.addEventListener('keydown', (e) => this.onEditorKeyDown(e, id));
		content.addEventListener('blur', () => {
			// Menus and modals hand focus back asynchronously; only commit when focus
			// really left the mindmap (clicks inside it commit in onPointerDown).
			window.setTimeout(() => {
				if (this.editing?.id !== id) return;
				const active = content.doc.activeElement;
				if (active === content) return;
				if (!active || active === content.doc.body || this.containerEl.contains(active)) {
					content.focus({ preventScroll: true });
				} else {
					this.commitEdit();
				}
			}, 0);
		});
		content.addEventListener('paste', (e) => {
			if (this.editing?.id !== id) return;
			const text = e.clipboardData?.getData('text/plain');
			if (text == null) return;
			e.preventDefault();
			content.doc.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
		});
		this.views.set(id, nv);
		return nv;
	}

	private async renderContent(nv: NodeView, text: string) {
		const seq = ++nv.renderSeq;
		nv.pendingText = text;
		const component = new Component();
		const tmp = createDiv();
		if (text.trim()) await MarkdownRenderer.render(this.app, text, tmp, this.file?.path ?? '', component);
		if (seq !== nv.renderSeq || this.editing?.id === nv.el.dataset.id) {
			component.unload();
			return;
		}
		nv.pendingText = null;
		if (nv.component) this.removeChild(nv.component);
		this.addChild(component);
		nv.component = component;

		nv.content.empty();
		const first = tmp.firstElementChild;
		const source = tmp.childElementCount === 1 && first?.tagName === 'P' ? first : tmp;
		while (source.firstChild) nv.content.appendChild(source.firstChild);
		nv.content.toggleClass('is-empty', !text.trim());
		nv.renderedText = text;
		// Content finished after the last layout (or an embed loaded late): re-layout if the size changed.
		const placed = this.layout.get(nv.el.dataset.id ?? '');
		if (placed && (placed.w !== nv.el.offsetWidth || placed.h !== nv.el.offsetHeight)) this.scheduleRelayout();
	}

	private updateToggle(nv: NodeView, v: Visible) {
		const has = v.depth > 0 && v.node.children.length > 0;
		nv.toggle.toggleClass('is-hidden', !has);
		nv.el.toggleClass('is-collapsed', has && v.node.collapsed);
		nv.toggle.setText(has && v.node.collapsed ? String(countDescendants(v.node)) : '');
	}

	private applyLayout(
		visible: Visible[],
		created: Set<string>,
		prevParents: Map<string, MindNode | null>,
		anim: boolean,
	) {
		const prevLayout = this.layout;
		const sizes = new Map<string, Size>();
		for (const v of visible) {
			const el = this.views.get(v.node.id)!.el;
			sizes.set(v.node.id, { w: el.offsetWidth, h: el.offsetHeight });
		}
		const layout = layoutTree(this.doc!.root, (id) => sizes.get(id) ?? { w: 0, h: 0 }, this.layoutOptions());
		this.layout = layout;
		this.contentEl.toggleClass('mm-no-anim', !anim);

		// Where an element that just appeared should grow from: the nearest
		// ancestor that already existed, at its previous position.
		const originOf = (id: string): Placed | undefined => {
			let cur: MindNode | null | undefined = this.nodes.get(id);
			while (cur) {
				if (!created.has(cur.id)) return prevLayout.get(cur.id) ?? layout.get(cur.id);
				cur = this.parents.get(cur.id);
			}
			return undefined;
		};

		// 1. Put entering elements at their start state.
		const enteringEdges: SVGPathElement[] = [];
		for (const v of visible) {
			const id = v.node.id;
			const nv = this.views.get(id)!;
			const p = layout.get(id)!;
			nv.el.toggleClass('side-left', p.side === -1);
			if (anim && created.has(id)) {
				const o = originOf(id);
				if (o) {
					nv.el.style.transform = this.nodeTransform(o.x + o.w / 2 - p.w / 2, o.y, p.h, 0.4);
					nv.el.setCssStyles({ opacity: '0' });
				}
			}
			if (v.depth === 0) continue;
			let path = this.edges.get(id);
			if (!path) {
				path = this.edgesEl.createSvg('path', { cls: ['mm-edge', 'mm-entering'] });
				this.edges.set(id, path);
				enteringEdges.push(path);
				const o = anim ? originOf(p.edgeFrom ?? this.parents.get(id)!.id) : undefined;
				if (o) {
					this.setPath(path, this.dotPath(this.anchor(o, p.fromSide ?? 'right', true)));
					path.setCssStyles({ opacity: '0' });
				}
			}
			path.dataset.depth = String(Math.min(v.depth, 3));
			path.style.setProperty('--mm-branch', this.branchColor(v));
		}

		// 2. Commit start state, then move everything to its target.
		void this.worldEl.offsetWidth;
		for (const id of created) this.views.get(id)?.el.removeClass('mm-entering');
		for (const path of enteringEdges) path.classList.remove('mm-entering');

		for (const v of visible) {
			const id = v.node.id;
			const p = layout.get(id)!;
			const nv = this.views.get(id)!;
			nv.el.style.transform = this.nodeTransform(p.x, p.y, p.h, 1);
			nv.el.setCssStyles({ opacity: '' });
			if (v.depth === 0) continue;
			const path = this.edges.get(id)!;
			this.setPath(path, this.edgePath(layout.get(p.edgeFrom ?? this.parents.get(id)!.id)!, p));
			path.setCssStyles({ opacity: '' });
		}

		// 3. Animate removed elements back into their closest visible ancestor.
		const visibleIds = new Set(sizes.keys());
		const ancestorOf = (id: string): Placed | undefined => {
			let cur = prevParents.get(id);
			while (cur) {
				if (visibleIds.has(cur.id)) return layout.get(cur.id);
				cur = prevParents.get(cur.id);
			}
			return undefined;
		};
		const dur = this.duration() + 60;
		for (const [id, nv] of Array.from(this.views)) {
			if (visibleIds.has(id)) continue;
			this.views.delete(id);
			const dispose = () => {
				if (nv.component) this.removeChild(nv.component);
				nv.el.remove();
			};
			const prev = prevLayout.get(id);
			const target = ancestorOf(id);
			if (!anim || !prev || !target) {
				dispose();
				continue;
			}
			nv.el.addClass('mm-exiting');
			nv.el.style.transform = this.nodeTransform(target.x + target.w / 2 - prev.w / 2, target.y, prev.h, 0.4);
			nv.el.setCssStyles({ opacity: '0' });
			window.setTimeout(dispose, dur);
		}
		for (const [id, path] of Array.from(this.edges)) {
			if (visibleIds.has(id)) continue;
			this.edges.delete(id);
			const prev = prevLayout.get(id);
			const target = ancestorOf(id);
			if (!anim || !prev || !target) {
				path.remove();
				continue;
			}
			this.setPath(path, this.dotPath(this.anchor(target, prev.fromSide ?? 'right', true)));
			path.setCssStyles({ opacity: '0' });
			window.setTimeout(() => path.remove(), dur);
		}

		if (!anim) {
			void this.worldEl.offsetWidth;
			this.contentEl.removeClass('mm-no-anim');
		}
	}

	private nodeTransform(x: number, yCenter: number, h: number, scale: number) {
		return `translate(${r1(x)}px, ${r1(yCenter - h / 2)}px) scale(${scale})`;
	}

	/** Point on a topic's box where an edge attaches on `side`. */
	private anchor(p: Placed, side: Side, outgoing: boolean): Point {
		// Edges tuck slightly under boxed topics; underlined topics attach to the underline.
		const inset = p.depth === 0 ? (outgoing ? 12 : 0) : p.depth === 1 ? 3 : 0;
		switch (side) {
			case 'left':
				return { x: p.x + inset, y: p.depth >= 2 ? p.y + p.h / 2 - 1 : p.y };
			case 'right':
				return { x: p.x + p.w - inset, y: p.depth >= 2 ? p.y + p.h / 2 - 1 : p.y };
			case 'top':
				return { x: p.x + p.w / 2, y: p.y - p.h / 2 + inset };
			case 'bottom':
				return { x: p.x + p.w / 2, y: p.y + p.h / 2 - inset };
		}
	}

	private edgePath(parent: Placed, child: Placed) {
		const fromSide = child.fromSide ?? 'right';
		const toSide = child.toSide ?? 'left';
		const a = this.anchor(parent, fromSide, true);
		const b = this.anchor(child, toSide, false);
		const dx = Math.abs(b.x - a.x);
		const dy = Math.abs(b.y - a.y);
		const ctrl = (pt: Point, side: Side): Point => {
			switch (side) {
				case 'left':
					return { x: pt.x - dx / 2, y: pt.y };
				case 'right':
					return { x: pt.x + dx / 2, y: pt.y };
				case 'top':
					return { x: pt.x, y: pt.y - Math.max(dy * 0.8, 12) };
				case 'bottom':
					return { x: pt.x, y: pt.y + Math.max(dy * 0.8, 12) };
			}
		};
		const c1 = ctrl(a, fromSide);
		const c2 = ctrl(b, toSide);
		return `M ${r1(a.x)} ${r1(a.y)} C ${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(b.x)} ${r1(b.y)}`;
	}

	private dotPath(a: Point) {
		const x = r1(a.x);
		const y = r1(a.y);
		return `M ${x} ${y} C ${x} ${y} ${x} ${y} ${x} ${y}`;
	}

	private setPath(path: SVGPathElement, d: string) {
		if (SUPPORTS_CSS_D) path.style.setProperty('d', `path("${d}")`);
		else path.setAttribute('d', d);
	}

	// ─── Camera ────────────────────────────────────────────────────────────────

	private applyCam() {
		const { x, y, k } = this.cam;
		this.worldEl.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
		if (this.plugin.settings.showGrid) {
			const size = 24 * k;
			this.viewportEl.style.backgroundSize = `${size}px ${size}px`;
			this.viewportEl.style.backgroundPosition = `${x}px ${y}px`;
		}
		this.zoomLabel?.setText(`${Math.round(k * 100)}%`);
	}

	private animateCam(target: Camera, duration = 320) {
		cancelAnimationFrame(this.camFrame);
		if (!this.animationsOn() || duration <= 0) {
			this.cam = { ...target };
			this.applyCam();
			return;
		}
		const from = { ...this.cam };
		const t0 = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / duration);
			const e = 1 - Math.pow(1 - t, 3);
			this.cam = {
				x: from.x + (target.x - from.x) * e,
				y: from.y + (target.y - from.y) * e,
				k: from.k + (target.k - from.k) * e,
			};
			this.applyCam();
			if (t < 1) this.camFrame = window.requestAnimationFrame(step);
		};
		this.camFrame = window.requestAnimationFrame(step);
	}

	private toViewport(e: { clientX: number; clientY: number }): Point {
		const rect = this.viewportEl.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private toWorld(p: Point): Point {
		return { x: (p.x - this.cam.x) / this.cam.k, y: (p.y - this.cam.y) / this.cam.k };
	}

	private zoomAt(sx: number, sy: number, k: number, animate: boolean, from: Camera = this.cam) {
		k = clamp(k, MIN_ZOOM, MAX_ZOOM);
		const wx = (sx - from.x) / from.k;
		const wy = (sy - from.y) / from.k;
		const target = { k, x: sx - wx * k, y: sy - wy * k };
		if (animate) this.animateCam(target, 200);
		else {
			cancelAnimationFrame(this.camFrame);
			this.cam = target;
			this.applyCam();
		}
	}

	zoomBy(factor: number) {
		this.zoomAt(this.viewportEl.clientWidth / 2, this.viewportEl.clientHeight / 2, this.cam.k * factor, true);
	}

	private bounds() {
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const p of this.layout.values()) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x + p.w);
			minY = Math.min(minY, p.y - p.h / 2);
			maxY = Math.max(maxY, p.y + p.h / 2);
		}
		return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
	}

	fit(animate = true) {
		const b = this.bounds();
		if (!b) return;
		const vw = this.viewportEl.clientWidth;
		const vh = this.viewportEl.clientHeight;
		const pad = 64;
		const k = clamp(Math.min((vw - pad * 2) / b.w, (vh - pad * 2) / b.h), MIN_ZOOM, 1);
		const target = { k, x: vw / 2 - (b.x + b.w / 2) * k, y: vh / 2 - (b.y + b.h / 2) * k };
		if (animate) this.animateCam(target, 380);
		else {
			this.cam = target;
			this.applyCam();
		}
	}

	zoomToSelection() {
		const p = this.selectedId ? this.layout.get(this.selectedId) : undefined;
		if (!p) return;
		const k = Math.max(this.cam.k, 1);
		this.animateCam({
			k,
			x: this.viewportEl.clientWidth / 2 - (p.x + p.w / 2) * k,
			y: this.viewportEl.clientHeight / 2 - p.y * k,
		});
	}

	private ensureVisible(id: string, margin = 56) {
		const p = this.layout.get(id);
		if (!p) return;
		const { x, y, k } = this.cam;
		const vw = this.viewportEl.clientWidth;
		const vh = this.viewportEl.clientHeight;
		const left = p.x * k + x;
		const right = (p.x + p.w) * k + x;
		const top = (p.y - p.h / 2) * k + y;
		const bottom = (p.y + p.h / 2) * k + y;
		let dx = 0;
		let dy = 0;
		if (left < margin) dx = margin - left;
		else if (right > vw - margin) dx = Math.max(vw - margin - right, margin - left);
		if (top < margin) dy = margin - top;
		else if (bottom > vh - margin) dy = Math.max(vh - margin - bottom, margin - top);
		if (dx || dy) this.animateCam({ x: x + dx, y: y + dy, k }, 260);
	}

	// ─── Selection & navigation ────────────────────────────────────────────────

	private select(id: string, reveal = true) {
		this.setSelection([id], id);
		if (reveal) this.ensureVisible(id);
	}

	private setSelection(ids: Iterable<string>, anchor: string | null) {
		const next = new Set(ids);
		for (const old of this.selection) if (!next.has(old)) this.views.get(old)?.el.removeClass('is-selected');
		for (const id of next) this.views.get(id)?.el.addClass('is-selected');
		this.selection = next;
		this.anchorId = anchor;
	}

	/** Selected topics without the ones already inside another selected branch. */
	private selectedBranches(includeRoot = false): MindNode[] {
		const out: MindNode[] = [];
		for (const id of this.selection) {
			const node = this.nodes.get(id);
			if (!node || (!includeRoot && node === this.doc?.root)) continue;
			let p = this.parents.get(id);
			let nested = false;
			while (p) {
				if (this.selection.has(p.id)) nested = true;
				p = this.parents.get(p.id) ?? null;
			}
			if (!nested) out.push(node);
		}
		// Keep document order.
		const order = new Map<string, number>();
		let i = 0;
		const walk = (n: MindNode) => {
			order.set(n.id, i++);
			n.children.forEach(walk);
		};
		if (this.doc) walk(this.doc.root);
		return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	}

	private navigate(dir: 'left' | 'right' | 'up' | 'down') {
		const id = this.selectedId;
		const p = id ? this.layout.get(id) : undefined;
		const node = id ? this.nodes.get(id) : undefined;
		if (!id || !p || !node) return;
		let target: string | undefined;

		if (this.layoutMode() === 'timeline') {
			target = this.nearestInDirection(id, p, dir);
		} else if (dir === 'left' || dir === 'right') {
			const side = dir === 'right' ? 1 : -1;
			if (p.depth > 0 && p.side !== side) {
				target = this.parents.get(id)?.id;
			} else if (p.depth > 0 && node.collapsed && node.children.length) {
				this.toggleCollapse(id);
				return;
			} else {
				let best = Infinity;
				for (const c of node.children) {
					const cp = this.layout.get(c.id);
					if (!cp || cp.side !== side) continue;
					const d = Math.abs(cp.y - p.y);
					if (d < best) {
						best = d;
						target = c.id;
					}
				}
			}
		} else {
			if (p.depth === 0) return;
			const up = dir === 'up';
			let best = Infinity;
			for (const [cid, c] of this.layout) {
				if (cid === id || c.side !== p.side || c.depth === 0) continue;
				const dy = up ? p.y - c.y : c.y - p.y;
				if (dy <= 1) continue;
				// Same depth wins; otherwise fall back to the closest node in that direction.
				const d = dy + Math.abs(c.depth - p.depth) * 10000 + Math.abs(c.x - p.x) * 0.2;
				if (d < best) {
					best = d;
					target = cid;
				}
			}
		}
		if (target) this.select(target);
	}

	/** Closest topic in a direction, favoring alignment over distance. */
	private nearestInDirection(id: string, p: Placed, dir: 'left' | 'right' | 'up' | 'down') {
		const [ux, uy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
		const cx = p.x + p.w / 2;
		let best = Infinity;
		let target: string | undefined;
		for (const [cid, c] of this.layout) {
			if (cid === id) continue;
			const dx = c.x + c.w / 2 - cx;
			const dy = c.y - p.y;
			const along = dx * ux + dy * uy;
			if (along <= 1) continue;
			const across = Math.abs(dx * uy - dy * ux);
			const score = along + across * 2.5;
			if (score < best) {
				best = score;
				target = cid;
			}
		}
		return target;
	}

	private deselect() {
		this.setSelection([], null);
	}

	// ─── Editing ───────────────────────────────────────────────────────────────

	/** Commit any pending edit and wait for the view to settle. */
	private async settle() {
		if (this.editing) this.commitEdit();
		await this.renderChain;
	}

	async startEdit(id: string, mode: 'end' | 'select' | { replace: string }, newSnapshot?: Snapshot) {
		if (this.editing && this.editing.id !== id) this.commitEdit();
		await this.renderChain;
		const node = this.nodes.get(id);
		const nv = this.views.get(id);
		const queued = this.editQueue;
		const commit = this.editQueueCommit;
		this.editQueue = null;
		this.editQueueCommit = false;
		if (!node || !nv || this.editing) return;
		if (newSnapshot && queued) mode = { replace: queued };
		this.select(id);
		this.editing = { id, original: node.text, snapshot: newSnapshot ?? this.snapshot(), isNew: !!newSnapshot };

		nv.renderSeq++; // drop any in-flight Markdown render
		nv.pendingText = null;
		nv.el.addClass('is-editing');
		const c = nv.content;
		c.empty();
		c.removeClass('is-empty');
		c.textContent = typeof mode === 'object' ? mode.replace : node.text;
		c.contentEditable = 'plaintext-only';
		if (c.contentEditable !== 'plaintext-only') c.contentEditable = 'true';
		c.focus({ preventScroll: true });

		const range = c.doc.createRange();
		range.selectNodeContents(c);
		if (mode !== 'select') range.collapse(false);
		const sel = c.win.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		if (newSnapshot && commit) this.commitEdit();
		else this.scheduleRelayout();
	}

	private endEditing(nv: NodeView) {
		const hadFocus = nv.content.contains(nv.content.doc.activeElement);
		nv.content.removeAttribute('contenteditable');
		nv.el.removeClass('is-editing');
		nv.renderedText = null;
		if (hadFocus) this.focusViewport();
	}

	/** Returns false if the node no longer exists (an empty new topic is discarded). */
	private commitEdit(): boolean {
		const ed = this.editing;
		if (!ed) return true;
		this.editing = null;
		const nv = this.views.get(ed.id);
		const node = this.nodes.get(ed.id);
		if (!nv || !node) return false;
		const text = (nv.content.textContent ?? '').replace(/\s+/g, ' ').trim();
		this.endEditing(nv);
		if (ed.isNew && !text) {
			this.discardNew(node);
			return false;
		}
		const isRoot = node === this.doc?.root;
		if ((text || !isRoot) && (text !== ed.original || ed.isNew)) {
			node.text = text;
			this.pushUndo(ed.snapshot);
			this.requestSave();
		}
		void this.render(true);
		return true;
	}

	private cancelEdit() {
		const ed = this.editing;
		if (!ed) return;
		this.editing = null;
		const nv = this.views.get(ed.id);
		const node = this.nodes.get(ed.id);
		if (nv) this.endEditing(nv);
		if (ed.isNew && node) this.discardNew(node);
		else void this.render(true);
	}

	private discardNew(node: MindNode) {
		const parent = this.parents.get(node.id);
		if (parent) {
			parent.children.remove(node);
			this.selectedId = parent.id;
		}
		void this.render(true);
	}

	private onEditorKeyDown(e: KeyboardEvent, id: string) {
		if (this.editing?.id !== id || e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			if (!e.shiftKey) this.commitEdit();
		} else if (e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			if (this.commitEdit()) {
				if (e.shiftKey) void this.outdent(id);
				else void this.addTopic(id);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.cancelEdit();
		}
	}

	editRootOnOpen() {
		void this.renderChain.then(() => {
			if (this.doc) void this.startEdit(this.doc.root.id, 'select');
		});
	}

	// ─── Tree operations ───────────────────────────────────────────────────────

	private snapshot(): Snapshot {
		return { tree: cloneTree(this.doc!.root), selected: this.selectedId };
	}

	private pushUndo(s: Snapshot) {
		this.undoStack.push(s);
		if (this.undoStack.length > 200) this.undoStack.shift();
		this.redoStack = [];
	}

	private async mutate(fn: () => void | false) {
		await this.settle();
		if (!this.doc) return;
		const snap = this.snapshot();
		if (fn() === false) return;
		this.pushUndo(snap);
		this.requestSave();
		await this.render(true);
		if (this.selectedId) this.ensureVisible(this.selectedId);
	}

	private async insertNew(parent: MindNode, index: number) {
		const snap = this.snapshot();
		const node = createNode();
		parent.collapsed = false;
		parent.children.splice(index, 0, node);
		this.selectedId = node.id;
		await this.render(true);
		this.ensureVisible(node.id);
		await this.startEdit(node.id, 'end', snap);
	}

	async addTopic(parentId: string) {
		this.editQueue ??= '';
		try {
			await this.settle();
			const parent = this.nodes.get(parentId);
			if (parent) await this.insertNew(parent, parent.children.length);
		} finally {
			this.editQueue = null;
			this.editQueueCommit = false;
		}
	}

	async addSibling(id: string, before = false) {
		this.editQueue ??= '';
		try {
			await this.settle();
			const node = this.nodes.get(id);
			const parent = this.parents.get(id);
			if (!node) return;
			if (!parent) return await this.insertNew(node, node.children.length);
			const idx = parent.children.indexOf(node);
			await this.insertNew(parent, before ? idx : idx + 1);
		} finally {
			this.editQueue = null;
			this.editQueueCommit = false;
		}
	}

	async deleteNode(id: string) {
		const node = this.nodes.get(id);
		const parent = this.parents.get(id);
		if (!node || !parent) return;
		const idx = parent.children.indexOf(node);
		const next = parent.children[idx + 1] ?? parent.children[idx - 1] ?? parent;
		await this.mutate(() => {
			parent.children.splice(idx, 1);
			this.selectedId = next.id;
		});
	}

	/** Delete every selected branch at once (one undo step). */
	async deleteSelection() {
		const branches = this.selectedBranches();
		if (branches.length <= 1) return branches[0] && this.deleteNode(branches[0].id);
		const parent = this.parents.get(branches[0].id);
		await this.mutate(() => {
			for (const n of branches) this.parents.get(n.id)?.children.remove(n);
			this.selectedId = parent && this.nodes.has(parent.id) ? parent.id : null;
		});
	}

	async outdent(id: string) {
		const node = this.nodes.get(id);
		const parent = this.parents.get(id);
		const grand = parent ? this.parents.get(parent.id) : null;
		if (!node || !parent || !grand) return;
		await this.mutate(() => {
			parent.children.remove(node);
			grand.children.splice(grand.children.indexOf(parent) + 1, 0, node);
		});
	}

	async moveSibling(id: string, delta: number) {
		const node = this.nodes.get(id);
		const parent = this.parents.get(id);
		if (!node || !parent) return;
		const i = parent.children.indexOf(node);
		const j = i + delta;
		if (j < 0 || j >= parent.children.length) return;
		await this.mutate(() => {
			parent.children.splice(i, 1);
			parent.children.splice(j, 0, node);
		});
	}

	/** Move topics (with their branches) onto, before or after a target, keeping their order. */
	private async moveNodes(ids: string[], target: DropTarget) {
		const nodes = ids.map((id) => this.nodes.get(id)).filter((n): n is MindNode => !!n && !!this.parents.get(n.id));
		const targetNode = this.nodes.get(target.id);
		const targetParent = this.parents.get(target.id);
		if (!nodes.length || !targetNode) return;
		if (target.mode !== 'inside' && !targetParent) return;
		await this.mutate(() => {
			for (const n of nodes) this.parents.get(n.id)!.children.remove(n);
			if (target.mode === 'inside') {
				targetNode.collapsed = false;
				targetNode.children.push(...nodes);
			} else {
				const idx = targetParent!.children.indexOf(targetNode);
				targetParent!.children.splice(target.mode === 'before' ? idx : idx + 1, 0, ...nodes);
			}
			this.setSelection(
				nodes.map((n) => n.id),
				nodes[0].id,
			);
		});
	}

	toggleCollapse(id: string) {
		const node = this.nodes.get(id);
		if (!node || node === this.doc?.root || !node.children.length) return;
		node.collapsed = !node.collapsed;
		void this.render(true).then(() => this.ensureVisible(id));
	}

	private setAllCollapsed(collapsed: boolean) {
		if (!this.doc) return;
		const walk = (n: MindNode, depth: number) => {
			if (depth > 0) n.collapsed = collapsed && n.children.length > 0;
			n.children.forEach((c) => walk(c, depth + 1));
		};
		walk(this.doc.root, 0);
		if (collapsed && this.selectedId) {
			// Keep the selection on a topic that stays visible.
			let cur = this.nodes.get(this.selectedId);
			while (cur && this.parents.get(cur.id) && this.parents.get(cur.id) !== this.doc.root) cur = this.parents.get(cur.id)!;
			if (cur) this.selectedId = cur.id;
		}
		void this.render(true).then(() => this.fit());
	}

	expandAll() {
		this.setAllCollapsed(false);
	}

	collapseAll() {
		this.setAllCollapsed(true);
	}

	undo() {
		const s = this.undoStack.pop();
		if (!s) return;
		this.redoStack.push(this.snapshot());
		this.restore(s);
	}

	redo() {
		const s = this.redoStack.pop();
		if (!s) return;
		this.undoStack.push(this.snapshot());
		this.restore(s);
	}

	private restore(s: Snapshot) {
		if (!this.doc) return;
		this.doc.root = cloneTree(s.tree);
		this.selectedId = s.selected;
		this.requestSave();
		void this.render(true).then(() => this.selectedId && this.ensureVisible(this.selectedId));
	}

	private async copy(id: string) {
		const branches = this.selection.has(id) ? this.selectedBranches(true) : [];
		const nodes = branches.length ? branches : [this.nodes.get(id)].filter((n): n is MindNode => !!n);
		if (nodes.length) await navigator.clipboard.writeText(toMarkdownList(nodes));
	}

	private async cut(id: string) {
		if (!this.parents.get(id)) return;
		await this.copy(id);
		if (this.selection.has(id)) await this.deleteSelection();
		else await this.deleteNode(id);
	}

	private async paste() {
		const id = this.selectedId;
		const parent = id ? this.nodes.get(id) : undefined;
		if (!parent) return;
		const text = await navigator.clipboard.readText();
		const added = parseFragment(text);
		if (!added.length) return;
		await this.mutate(() => {
			parent.collapsed = false;
			parent.children.push(...added);
			this.selectedId = added[0].id;
		});
	}

	// ─── Input ─────────────────────────────────────────────────────────────────

	private onKeyDown(e: KeyboardEvent) {
		if (this.editing || e.isComposing || !this.doc) return;
		// Ignore typing in the view header's title field and other inputs.
		const t = e.target as HTMLElement;
		if (t !== this.viewportEl && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
		if (this.editQueue !== null) {
			// A topic is being created: buffer what's typed until its editor opens.
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.editQueue += e.key;
			else if (e.key === 'Backspace') this.editQueue = this.editQueue.slice(0, -1);
			else if (e.key === 'Enter') this.editQueueCommit = true;
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		const key = e.key;
		const sel = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
		const isRoot = sel === this.doc.root;
		const run = (fn: () => unknown) => {
			e.preventDefault();
			e.stopPropagation();
			void fn();
		};

		if (mod && !e.altKey) {
			const k = key.toLowerCase();
			if (k === 'z') return run(() => (e.shiftKey ? this.redo() : this.undo()));
			if (k === 'y') return run(() => this.redo());
			if (k === 'c' && sel) return run(() => this.copy(sel.id));
			if (k === 'x' && sel) return run(() => this.cut(sel.id));
			if (k === 'v') return run(() => this.paste());
			if ((key === '.' || e.code === 'Period') && sel) {
				return run(() => {
					for (const id of this.selection) this.toggleCollapse(id);
				});
			}
			if (k === 'a') return run(() => this.setSelection(this.layout.keys(), this.selectedId ?? this.doc!.root.id));
			return;
		}
		if (e.altKey) {
			if (sel && key === 'ArrowUp') return run(() => this.moveSibling(sel.id, -1));
			if (sel && key === 'ArrowDown') return run(() => this.moveSibling(sel.id, 1));
			return;
		}
		if (e.shiftKey && e.code === 'Digit1') return run(() => this.fit());
		if (e.shiftKey && e.code === 'Digit2') return run(() => this.zoomToSelection());

		switch (key) {
			case 'Tab':
				return run(() => sel && (e.shiftKey ? this.outdent(sel.id) : this.addTopic(sel.id)));
			case 'Enter':
				return run(() => sel && (isRoot ? this.addTopic(sel.id) : this.addSibling(sel.id, e.shiftKey)));
			case ' ':
				// Tap Space to edit; hold it and drag to pan (handled on key up).
				if (!e.repeat) this.space = { used: false };
				this.viewportEl.addClass('is-space');
				e.preventDefault();
				e.stopPropagation();
				return;
			case 'F2':
				return run(() => sel && this.startEdit(sel.id, 'end'));
			case 'Backspace':
			case 'Delete':
				return run(() => this.deleteSelection());
			case 'ArrowUp':
			case 'ArrowDown':
			case 'ArrowLeft':
			case 'ArrowRight':
				if (!sel) return run(() => this.select(this.doc!.root.id));
				break;
		}
		switch (key) {
			case 'ArrowUp':
				return run(() => this.navigate('up'));
			case 'ArrowDown':
				return run(() => this.navigate('down'));
			case 'ArrowLeft':
				return run(() => this.navigate('left'));
			case 'ArrowRight':
				return run(() => this.navigate('right'));
			case 'Escape':
				if (sel) run(() => this.deselect());
				return;
			case 'Home':
				return run(() => this.select(this.doc!.root.id));
			case '?':
				return run(() => new ShortcutsModal(this.app).open());
		}
	}

	private onWheel(e: WheelEvent) {
		e.preventDefault();
		let dx = e.deltaX;
		let dy = e.deltaY;
		if (e.deltaMode === 1) {
			dx *= 16;
			dy *= 16;
		}
		const zoom = e.ctrlKey || e.metaKey || (this.plugin.settings.wheelBehavior === 'zoom' && !e.shiftKey);
		if (zoom) {
			const p = this.toViewport(e);
			this.zoomAt(p.x, p.y, this.cam.k * Math.exp(-clamp(dy, -50, 50) * 0.008), false);
			return;
		}
		if (e.shiftKey && !dx) {
			dx = dy;
			dy = 0;
		}
		cancelAnimationFrame(this.camFrame);
		this.cam.x -= dx;
		this.cam.y -= dy;
		this.applyCam();
	}

	private onPointerDown(e: PointerEvent) {
		const target = e.target as HTMLElement;
		if (this.editing && target.closest('.is-editing')) return;
		if (this.editing) this.commitEdit();
		if (target.closest('.mm-toggle')) return;
		if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
		// Links stay clickable: only capture the pointer once a drag really starts.
		const onLink = !!target.closest('a');

		const pt = this.toViewport(e);
		this.pointers.set(e.pointerId, pt);
		this.focusViewport();
		if (this.pointers.size === 2) return this.startPinch();
		if (this.pointers.size > 2) return;
		cancelAnimationFrame(this.camFrame);

		const nodeEl = target.closest('.mm-node') as HTMLElement | null;
		const id = nodeEl && !nodeEl.hasClass('mm-exiting') ? nodeEl.dataset.id : undefined;
		const panning = e.button === 1 || !!this.space || e.pointerType === 'touch';
		if (this.space) this.space.used = true;
		if (id && e.button === 0 && !this.space && this.nodes.has(id)) {
			if (e.shiftKey || e.metaKey) {
				// Shift-click adds or removes a topic from the selection.
				const next = new Set(this.selection);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				this.setSelection(next, next.has(id) ? id : (next.values().next().value ?? null));
				return;
			}
			const wasSelected = this.selectedId === id;
			// Keep a multi-selection when grabbing one of its topics, so they move together.
			if (this.selection.has(id) && this.selection.size > 1) this.anchorId = id;
			else this.select(id, false);
			this.drag = { id, pointerId: e.pointerId, start: pt, active: false, wasSelected, pointerType: e.pointerType, target: null };
		} else if (panning) {
			this.pan = { pointerId: e.pointerId, start: pt, cam: { ...this.cam }, moved: false };
		} else {
			const el = this.viewportEl.createDiv({ cls: 'mm-marquee' });
			el.hide();
			this.marquee = { pointerId: e.pointerId, start: pt, additive: e.shiftKey || e.metaKey, base: new Set(this.selection), el, moved: false };
		}
		if (!onLink || !this.drag) this.viewportEl.setPointerCapture(e.pointerId);
	}

	private startPinch() {
		if (this.drag?.active) {
			this.drag.target = null;
			this.finishDrag(this.drag);
		}
		this.drag = null;
		this.pan = null;
		const [a, b] = Array.from(this.pointers.values());
		this.pinch = {
			dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
			cam: { ...this.cam },
		};
	}

	private onPointerMove(e: PointerEvent) {
		if (!this.pointers.has(e.pointerId)) return;
		const pt = this.toViewport(e);
		this.pointers.set(e.pointerId, pt);

		if (this.pinch && this.pointers.size >= 2) {
			const [a, b] = Array.from(this.pointers.values());
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const p = this.pinch;
			const k = clamp((p.cam.k * dist) / p.dist, MIN_ZOOM, MAX_ZOOM);
			const wx = (p.center.x - p.cam.x) / p.cam.k;
			const wy = (p.center.y - p.cam.y) / p.cam.k;
			this.cam = { k, x: c.x - wx * k, y: c.y - wy * k };
			this.applyCam();
			return;
		}

		const m = this.marquee;
		if (m?.pointerId === e.pointerId) {
			if (!m.moved && Math.hypot(pt.x - m.start.x, pt.y - m.start.y) < 4) return;
			m.moved = true;
			const x = Math.min(pt.x, m.start.x);
			const y = Math.min(pt.y, m.start.y);
			const w = Math.abs(pt.x - m.start.x);
			const h = Math.abs(pt.y - m.start.y);
			m.el.show();
			m.el.style.transform = `translate(${x}px, ${y}px)`;
			m.el.style.width = `${w}px`;
			m.el.style.height = `${h}px`;
			const a = this.toWorld({ x, y });
			const b = this.toWorld({ x: x + w, y: y + h });
			const hits: string[] = [];
			for (const [id, p] of this.layout) {
				if (p.x < b.x && p.x + p.w > a.x && p.y - p.h / 2 < b.y && p.y + p.h / 2 > a.y) hits.push(id);
			}
			const ids = m.additive ? new Set([...m.base, ...hits]) : new Set(hits);
			this.setSelection(ids, hits[hits.length - 1] ?? (m.additive ? this.anchorId : null));
			return;
		}

		const pan = this.pan;
		if (pan?.pointerId === e.pointerId) {
			const dx = pt.x - pan.start.x;
			const dy = pt.y - pan.start.y;
			if (!pan.moved && Math.hypot(dx, dy) > 3) {
				pan.moved = true;
				this.viewportEl.addClass('is-panning');
			}
			if (pan.moved) {
				this.cam = { x: pan.cam.x + dx, y: pan.cam.y + dy, k: this.cam.k };
				this.applyCam();
			}
			return;
		}

		const d = this.drag;
		if (d?.pointerId !== e.pointerId) return;
		if (!d.active) {
			if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 6) return;
			if (this.editing) return;
			if (!this.viewportEl.hasPointerCapture(d.pointerId)) this.viewportEl.setPointerCapture(d.pointerId);
			if (!this.beginDrag(d)) {
				// Dragging the central topic pans the canvas instead.
				this.drag = null;
				this.pan = { pointerId: e.pointerId, start: d.start, cam: { ...this.cam }, moved: true };
				this.viewportEl.addClass('is-panning');
				return;
			}
		}
		this.updateDrag(d, pt);
	}

	private onPointerUp(e: PointerEvent) {
		this.pointers.delete(e.pointerId);
		if (this.viewportEl.hasPointerCapture(e.pointerId)) this.viewportEl.releasePointerCapture(e.pointerId);

		if (this.pinch) {
			if (this.pointers.size < 2) this.pinch = null;
			return;
		}
		const m = this.marquee;
		if (m?.pointerId === e.pointerId) {
			m.el.remove();
			this.marquee = null;
			// A plain click on empty space clears the selection.
			if (!m.moved && !m.additive && e.type === 'pointerup') this.deselect();
			return;
		}
		if (this.pan?.pointerId === e.pointerId) {
			this.pan = null;
			this.viewportEl.removeClass('is-panning');
			return;
		}
		const d = this.drag;
		if (d?.pointerId !== e.pointerId) return;
		this.drag = null;
		if (d.active) {
			if (e.type === 'pointercancel') d.target = null;
			this.finishDrag(d);
			return;
		}
		// Tap / click on a topic.
		if (this.selection.size > 1) this.select(d.id, false);
		const now = Date.now();
		if (this.lastTap.id === d.id && now - this.lastTap.time < 350) {
			this.lastTap = { id: '', time: 0 };
			void this.startEdit(d.id, 'select');
			return;
		}
		this.lastTap = { id: d.id, time: now };
		if (d.pointerType !== 'mouse' && d.wasSelected) void this.startEdit(d.id, 'end');
		else this.ensureVisible(d.id);
	}

	private beginDrag(d: DragState): boolean {
		const node = this.nodes.get(d.id);
		const nv = this.views.get(d.id);
		const p = this.layout.get(d.id);
		if (!node || !nv || !p || !this.parents.get(d.id)) return false;
		d.active = true;
		d.subtree = new Set();
		const walk = (n: MindNode) => {
			d.subtree!.add(n.id);
			n.children.forEach(walk);
		};
		d.movers = this.selection.has(d.id) ? this.selectedBranches().map((n) => n.id) : [d.id];
		if (!d.movers.includes(d.id)) d.movers.unshift(d.id);
		for (const id of d.movers) {
			const n = this.nodes.get(id);
			if (n) walk(n);
		}
		for (const id of d.subtree) {
			this.views.get(id)?.el.addClass('is-drag-source');
			this.edges.get(id)?.classList.add('is-drag-source');
		}
		const ghost = nv.el.cloneNode(true) as HTMLElement;
		ghost.removeClass('is-selected', 'mm-entering', 'is-drag-source');
		ghost.addClass('mm-ghost');
		ghost.setCssStyles({ opacity: '' });
		this.nodesEl.appendChild(ghost);
		d.ghost = ghost;
		const w = this.toWorld(d.start);
		d.offset = { x: w.x - p.x, y: w.y - (p.y - p.h / 2) };
		this.viewportEl.addClass('is-dragging');
		return true;
	}

	private updateDrag(d: DragState, pt: Point) {
		const w = this.toWorld(pt);
		d.ghost!.style.transform = `translate(${r1(w.x - d.offset!.x)}px, ${r1(w.y - d.offset!.y)}px) scale(1.04)`;
		const t = this.findDropTarget(w, d.subtree!);
		if (t?.id === d.target?.id && t?.mode === d.target?.mode) return;
		this.clearDropIndicator(d);
		d.target = t;
		if (t) this.views.get(t.id)?.el.addClass(`mm-drop-${t.mode}`);
	}

	private clearDropIndicator(d: DragState) {
		if (d.target) this.views.get(d.target.id)?.el.removeClass('mm-drop-inside', 'mm-drop-before', 'mm-drop-after');
	}

	private findDropTarget(w: Point, exclude: Set<string>): DropTarget | null {
		let best: DropTarget | null = null;
		let bestDist = Infinity;
		for (const [id, p] of this.layout) {
			if (exclude.has(id)) continue;
			const top = p.y - p.h / 2;
			const bottom = p.y + p.h / 2;
			if (w.x >= p.x - 6 && w.x <= p.x + p.w + 6 && w.y >= top - 6 && w.y <= bottom + 6) {
				if (p.depth === 0) return { id, mode: 'inside' };
				const r = (w.y - top) / p.h;
				return { id, mode: r < 0.3 ? 'before' : r > 0.7 ? 'after' : 'inside' };
			}
			// Hovering in the empty space just past a topic's outer edge → become its child.
			const dir = p.depth === 0 ? (w.x > p.x + p.w / 2 ? 1 : -1) : p.side;
			const outX = dir === 1 ? p.x + p.w : p.x;
			const dx = (w.x - outX) * dir;
			const dy = Math.abs(w.y - p.y);
			if (dx > 0 && dx < 140 && dy < p.h / 2 + 24) {
				const dist = dx + dy * 2;
				if (dist < bestDist) {
					bestDist = dist;
					best = { id, mode: 'inside' };
				}
			}
		}
		return best;
	}

	private finishDrag(d: DragState) {
		this.clearDropIndicator(d);
		this.viewportEl.removeClass('is-dragging');
		for (const id of d.subtree ?? []) {
			this.views.get(id)?.el.removeClass('is-drag-source');
			this.edges.get(id)?.classList.remove('is-drag-source');
		}
		// Let the real topic fly from where it was dropped to its new place.
		const nv = this.views.get(d.id);
		if (nv && d.ghost) {
			nv.el.addClass('mm-entering');
			nv.el.style.transform = d.ghost.style.transform.replace(/scale\([^)]*\)/, 'scale(1)');
			void nv.el.offsetWidth;
			nv.el.removeClass('mm-entering');
		}
		d.ghost?.remove();
		if (d.target) void this.moveNodes(d.movers ?? [d.id], d.target);
		else void this.render(true);
	}

	private onClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		const toggle = t.closest('.mm-toggle');
		if (toggle) {
			const id = (toggle.closest('.mm-node') as HTMLElement | null)?.dataset.id;
			if (id) {
				e.stopPropagation();
				this.toggleCollapse(id);
			}
			return;
		}
		const a = t.closest('a');
		if (!a || this.editing) return;
		e.preventDefault();
		const href = a.dataset.href ?? a.getAttr('href') ?? '';
		if (a.hasClass('internal-link')) {
			void this.app.workspace.openLinkText(href, this.file?.path ?? '', Keymap.isModEvent(e));
		} else if (a.hasClass('tag')) {
			const internal = (this.app as unknown as { internalPlugins?: InternalPlugins }).internalPlugins;
			internal?.getPluginById?.('global-search')?.instance?.openGlobalSearch?.(`tag:${href}`);
		} else if (href) {
			window.open(href);
		}
	}

	private onMouseOver(e: MouseEvent) {
		const a = (e.target as HTMLElement).closest('a.internal-link') as HTMLElement | null;
		if (!a || this.drag?.active) return;
		this.app.workspace.trigger('hover-link', {
			event: e,
			source: VIEW_TYPE_MINDMAP,
			hoverParent: this,
			targetEl: a,
			linktext: a.dataset.href ?? a.getAttr('href'),
			sourcePath: this.file?.path,
		});
	}

	private onContextMenu(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (this.editing && target.closest('.is-editing')) return;
		e.preventDefault();
		const id = (target.closest('.mm-node') as HTMLElement | null)?.dataset.id;
		const node = id ? this.nodes.get(id) : undefined;
		const menu = new Menu();

		if (id && node) {
			this.select(id, false);
			const isRoot = node === this.doc?.root;
			menu.addItem((i) => i.setTitle('Add child').setIcon('corner-down-right').onClick(() => this.addTopic(id)));
			if (!isRoot) {
				menu.addItem((i) => i.setTitle('Add sibling').setIcon('plus').onClick(() => this.addSibling(id)));
			}
			menu.addItem((i) => i.setTitle('Edit').setIcon('pencil').onClick(() => this.startEdit(id, 'select')));
			if (!isRoot && node.children.length) {
				menu.addItem((i) =>
					i
						.setTitle(node.collapsed ? 'Expand' : 'Collapse')
						.setIcon(node.collapsed ? 'chevrons-up-down' : 'chevrons-down-up')
						.onClick(() => this.toggleCollapse(id)),
				);
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Copy as Markdown').setIcon('copy').onClick(() => this.copy(id)));
			if (!isRoot) menu.addItem((i) => i.setTitle('Cut').setIcon('scissors').onClick(() => this.cut(id)));
			menu.addItem((i) => i.setTitle('Paste as children').setIcon('clipboard-paste').onClick(() => this.paste()));
			if (!isRoot) {
				menu.addSeparator();
				menu.addItem((i) =>
					i.setTitle('Delete').setIcon('trash-2').setWarning(true).onClick(() => this.deleteNode(id)),
				);
			}
		} else {
			menu.addItem((i) => i.setTitle('Zoom to fit').setIcon('maximize').onClick(() => this.fit()));
			menu.addItem((i) => i.setTitle('Expand all').setIcon('chevrons-up-down').onClick(() => this.expandAll()));
			menu.addItem((i) => i.setTitle('Collapse all').setIcon('chevrons-down-up').onClick(() => this.collapseAll()));
			menu.addSeparator();
			menu.addItem((i) =>
				i.setTitle('Open as Markdown').setIcon('file-text').onClick(() => this.plugin.setMarkdownView(this.leaf)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	// Public helpers for commands.
	get selected(): string | null {
		return this.selectedId;
	}
}
