import {
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	ViewState,
	WorkspaceLeaf,
	normalizePath,
} from 'obsidian';
import { around } from 'monkey-around';
import { FRONTMATTER_KEY } from './model';
import { LAYOUTS, normalizeLayout } from './layout';
import { CanvasMindmaps } from './canvas';
import { DEFAULT_SETTINGS, MindmapSettingTab, type MindmapSettings } from './settings';
import { MindmapView, VIEW_TYPE_MINDMAP } from './view';

const TEMPLATE = `---\n${FRONTMATTER_KEY}: basic\n---\n\n# Central idea\n`;

export default class MindmapPlugin extends Plugin {
	settings!: MindmapSettings;
	/** Leaves the user explicitly switched to Markdown, keyed to the file they show. */
	private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
	private headerActions = new WeakMap<MarkdownView, HTMLElement>();
	canvasMaps = new CanvasMindmaps(this);

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new MindmapView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE_MINDMAP, { display: 'Mindmap', defaultMod: true });
		this.addRibbonIcon('network', 'New mindmap', () => this.createMindmap());
		this.addSettingTab(new MindmapSettingTab(this.app, this));

		this.registerCommands();
		this.registerMenus();
		this.patchLeaves();

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.syncHeaderActions();
				this.canvasMaps.attachAll();
			}),
		);
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.canvasMaps.attachAll()));
		this.registerEvent(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.workspace as any).on('canvas:node-menu', (menu: Menu, node: any) =>
				this.canvasMaps.addNodeMenuItems(menu, node),
			),
		);
		this.register(() => this.canvasMaps.detachAll());
		this.registerEvent(this.app.metadataCache.on('changed', () => this.syncHeaderActions()));
		this.app.workspace.onLayoutReady(() => {
			for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
				const file = (leaf.view as MarkdownView).file;
				if (file && this.isMindmapFile(file)) void this.setMindmapView(leaf);
			}
			this.syncHeaderActions();
			this.canvasMaps.attachAll();
		});
	}

	onunload() {
		// Hand open mindmaps back to the Markdown editor so nothing closes.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP)) {
			void leaf.setViewState({ type: 'markdown', state: leaf.view.getState(), popstate: true } as ViewState);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.layout = normalizeLayout(this.settings.layout);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP)) {
			if (leaf.view instanceof MindmapView) leaf.view.applySettings();
		}
	}

	isMindmapFile(file: TFile): boolean {
		if (file.extension !== 'md') return false;
		return !!this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY];
	}

	// ─── View switching ────────────────────────────────────────────────────────

	/** Open mindmap notes in the mindmap view, wherever Obsidian opens them from. */
	private patchLeaves() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;
		this.register(
			around(WorkspaceLeaf.prototype, {
				setViewState(next) {
					return function (this: WorkspaceLeaf, state: ViewState, ...rest: unknown[]) {
						const path = state?.state?.file;
						if (state?.type === 'markdown' && typeof path === 'string' && plugin.markdownLeaves.get(this) !== path) {
							const file = plugin.app.vault.getAbstractFileByPath(path);
							if (file instanceof TFile && plugin.isMindmapFile(file)) {
								return next.call(this, { ...state, type: VIEW_TYPE_MINDMAP }, ...rest);
							}
						}
						return next.call(this, state, ...rest);
					};
				},
			}),
		);
	}

	async setMarkdownView(leaf: WorkspaceLeaf) {
		const state = leaf.view.getState();
		if (typeof state.file === 'string') this.markdownLeaves.set(leaf, state.file);
		await leaf.setViewState({ type: 'markdown', state, popstate: true } as ViewState);
	}

	async setMindmapView(leaf: WorkspaceLeaf) {
		this.markdownLeaves.delete(leaf);
		await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, state: leaf.view.getState(), popstate: true } as ViewState);
	}

	/** Add a "Open as mindmap" button to the header of Markdown views showing a mindmap note. */
	private syncHeaderActions() {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			const isMap = !!view.file && this.isMindmapFile(view.file);
			const existing = this.headerActions.get(view);
			if (isMap && !existing) {
				this.headerActions.set(
					view,
					view.addAction('network', 'Open as mindmap', () => this.setMindmapView(leaf)),
				);
			} else if (!isMap && existing) {
				existing.remove();
				this.headerActions.delete(view);
			}
		}
	}

	// ─── Files ─────────────────────────────────────────────────────────────────

	private async resolveFolder(): Promise<TFolder> {
		const wanted = this.settings.newFileFolder;
		if (wanted) {
			const path = normalizePath(wanted);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFolder) return existing;
			if (!existing) return this.app.vault.createFolder(path);
		}
		return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
	}

	async createMindmap(folder?: TFolder) {
		try {
			const parent = folder ?? (await this.resolveFolder());
			const prefix = parent.isRoot() ? '' : `${parent.path}/`;
			let path = normalizePath(`${prefix}Untitled mindmap.md`);
			for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
				path = normalizePath(`${prefix}Untitled mindmap ${i}.md`);
			}
			const file = await this.app.vault.create(path, TEMPLATE);
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, state: { file: file.path }, active: true });
			if (leaf.view instanceof MindmapView) leaf.view.editRootOnOpen();
		} catch (err) {
			console.error(err);
			new Notice(`Could not create mindmap: ${err instanceof Error ? err.message : err}`);
		}
	}

	async convertToMindmap(file: TFile, leaf?: WorkspaceLeaf) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FRONTMATTER_KEY] = 'basic';
		});
		if (leaf) await this.setMindmapView(leaf);
	}

	// ─── Commands & menus ──────────────────────────────────────────────────────

	private registerCommands() {
		this.addCommand({ id: 'create', name: 'Create new mindmap', callback: () => this.createMindmap() });

		this.addCommand({
			id: 'toggle-view',
			name: 'Toggle between mindmap and Markdown',
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				if (!leaf) return false;
				if (view instanceof MindmapView) {
					if (!checking) void this.setMarkdownView(leaf);
					return true;
				}
				if (view instanceof MarkdownView && view.file && this.isMindmapFile(view.file)) {
					if (!checking) void this.setMindmapView(leaf);
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'convert-note',
			name: 'Convert current note to mindmap',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || this.isMindmapFile(view.file)) return false;
				if (!checking) void this.convertToMindmap(view.file, view.leaf);
				return true;
			},
		});

		const viewCommand = (id: string, name: string, fn: (v: MindmapView) => unknown) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const view = this.app.workspace.getActiveViewOfType(MindmapView);
					if (!view) return false;
					if (!checking) void fn(view);
					return true;
				},
			});

		const canvasCommand = (id: string, name: string, fn: (canvas: any, node: any) => unknown) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const canvas = this.canvasMaps.activeCanvas();
					const node = canvas && this.canvasMaps.selectedNode(canvas);
					if (!canvas || !node || canvas.readonly) return false;
					if (!checking) void fn(canvas, node);
					return true;
				},
			});
		canvasCommand('canvas-add-child', 'Canvas: add child topic', (c, n) => this.canvasMaps.addChild(c, n));
		canvasCommand('canvas-add-sibling', 'Canvas: add sibling topic', (c, n) => this.canvasMaps.addSibling(c, n));
		canvasCommand('canvas-tidy', 'Canvas: tidy up mindmap', (c, n) => this.canvasMaps.tidy(c, n));
		for (const l of LAYOUTS) {
			canvasCommand(`canvas-layout-${l.id}`, `Canvas: use ${l.name} layout`, (c, n) => this.canvasMaps.setLayout(c, n, l.id));
			viewCommand(`layout-${l.id}`, `Use ${l.name} layout`, (v) => v.setLayoutMode(l.id));
		}

		viewCommand('zoom-to-fit', 'Zoom to fit', (v) => v.fit());
		viewCommand('zoom-to-selection', 'Zoom to selected topic', (v) => v.zoomToSelection());
		viewCommand('expand-all', 'Expand all topics', (v) => v.expandAll());
		viewCommand('collapse-all', 'Collapse all topics', (v) => v.collapseAll());
		viewCommand('add-child', 'Add child topic', (v) => v.selected && v.addTopic(v.selected));
		viewCommand('add-sibling', 'Add sibling topic', (v) => v.selected && v.addSibling(v.selected));
		viewCommand('edit-topic', 'Edit selected topic', (v) => v.selected && v.startEdit(v.selected, 'select'));
		viewCommand('toggle-fold', 'Fold / unfold selected topic', (v) => v.selected && v.toggleCollapse(v.selected));
		viewCommand('undo', 'Undo', (v) => v.undo());
		viewCommand('redo', 'Redo', (v) => v.redo());
	}

	private registerMenus() {
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
				if (file instanceof TFolder) {
					menu.addItem((i) =>
						i
							.setTitle('New mindmap')
							.setIcon('network')
							.setSection('action-primary')
							.onClick(() => this.createMindmap(file)),
					);
					return;
				}
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				const isMap = this.isMindmapFile(file);
				if (leaf?.view instanceof MarkdownView && source === 'more-options') {
					menu.addItem((i) =>
						i
							.setTitle(isMap ? 'Open as mindmap' : 'Convert to mindmap')
							.setIcon('network')
							.setSection('pane')
							.onClick(() => (isMap ? this.setMindmapView(leaf) : this.convertToMindmap(file, leaf))),
					);
				}
			}),
		);
	}
}
