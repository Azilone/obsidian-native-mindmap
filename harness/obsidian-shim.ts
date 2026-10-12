/* Minimal stand-in for the Obsidian API, enough to run the mindmap view in a browser. */
/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── DOM augmentations Obsidian adds globally ───
type Info = { cls?: string | string[]; text?: string; attr?: Record<string, any> } | string;
function applyInfo(el: Element, info?: Info) {
	if (!info) return;
	if (typeof info === 'string') {
		(el as any).addClass(info);
		return;
	}
	if (info.cls) (el as any).addClass(...(Array.isArray(info.cls) ? info.cls : info.cls.split(' ')));
	if (info.text != null) el.textContent = info.text;
	if (info.attr) for (const k in info.attr) el.setAttribute(k, info.attr[k]);
}
const P = Element.prototype as any;
P.createEl = function (tag: string, info?: Info) {
	const el = document.createElement(tag);
	applyInfo(el, info);
	this.appendChild(el);
	return el;
};
P.createDiv = function (info?: Info) {
	return this.createEl('div', info);
};
P.createSpan = function (info?: Info) {
	return this.createEl('span', info);
};
P.createSvg = function (tag: string, info?: Info) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	// Strict like Obsidian for SVG: a space-separated cls string is not split.
	if (info && typeof info !== 'string' && typeof info.cls === 'string') el.classList.add(info.cls);
	else applyInfo(el, info);
	this.appendChild(el);
	return el;
};
P.addClass = function (...c: string[]) {
	this.classList.add(...c.filter(Boolean));
};
P.removeClass = function (...c: string[]) {
	this.classList.remove(...c);
};
P.toggleClass = function (c: string, v: boolean) {
	this.classList.toggle(c, v);
};
P.hasClass = function (c: string) {
	return this.classList.contains(c);
};
P.setText = function (t: string) {
	this.textContent = t;
};
P.empty = function () {
	while (this.firstChild) this.removeChild(this.firstChild);
};
P.hide = function () {
	this.style.display = 'none';
};
P.show = function () {
	this.style.display = '';
};
P.getAttr = function (n: string) {
	return this.getAttribute(n);
};
Object.defineProperty(Node.prototype, 'doc', {
	get() {
		return this.ownerDocument ?? document;
	},
});
Object.defineProperty(Node.prototype, 'win', {
	get() {
		return (this.ownerDocument ?? document).defaultView;
	},
});
(Array.prototype as any).remove = function (x: any) {
	const i = this.indexOf(x);
	if (i >= 0) this.splice(i, 1);
};
(window as any).createDiv = (info?: Info) => {
	const el = document.createElement('div');
	applyInfo(el, info);
	return el;
};

// ─── Classes ───
export class Component {
	_loaded = false;
	_children: Component[] = [];
	_cleanups: (() => void)[] = [];
	load() {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		this._children.forEach((c) => c.load());
	}
	onload() {}
	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		this._children.forEach((c) => c.unload());
		this._cleanups.forEach((f) => f());
		this._cleanups = [];
		this.onunload();
	}
	onunload() {}
	addChild<T extends Component>(c: T): T {
		this._children.push(c);
		if (this._loaded) c.load();
		return c;
	}
	removeChild<T extends Component>(c: T): T {
		this._children.remove(c);
		c.unload();
		return c;
	}
	register(f: () => void) {
		this._cleanups.push(f);
	}
	registerDomEvent(el: any, type: string, cb: any, opts?: any) {
		el.addEventListener(type, cb, opts);
		this.register(() => el.removeEventListener(type, cb, opts));
	}
	registerEvent(_ref: any) {}
}

export class WorkspaceLeaf {}
export class HoverPopover {}
export class TFile {}
export class TFolder {}

export class TextFileView extends Component {
	app: any;
	leaf: any;
	file: any = { path: 'Test.md', basename: 'Test' };
	data = '';
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	scope: any = null;
	constructor(leaf: any) {
		super();
		this.leaf = leaf;
		this.app = (window as any).app;
		this.containerEl = document.createElement('div');
		this.containerEl.className = 'workspace-leaf-content';
		const header = this.containerEl.createDiv({ cls: 'view-header' });
		header.setText('Untitled mindmap');
		this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
	}
	requestSave() {
		(window as any).__saves = ((window as any).__saves ?? 0) + 1;
		(window as any).__lastSave = (this as any).getViewData();
	}
	addAction() {
		return document.createElement('div');
	}
	onPaneMenu() {}
}

export const Platform = { isMacOS: true, isMobile: false };
export const Keymap = { isModEvent: (e: any) => e.metaKey || e.ctrlKey };

export function setIcon(el: HTMLElement, icon: string) {
	el.textContent = ({ plus: '+', minus: '−', maximize: '⤢', keyboard: '⌨' } as any)[icon] ?? '•';
}
export function setTooltip(el: HTMLElement, text: string) {
	el.title = text;
}

export const MarkdownRenderer_unused = 0;
export const MarkdownRenderer = {
	async render(_app: any, md: string, el: HTMLElement) {
		await new Promise((r) => setTimeout(r, 1));
		const p = el.createEl('p');
		p.innerHTML = md
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\[\[(.+?)\]\]/g, '<a class="internal-link" data-href="$1">$1</a>');
	},
};

class MenuItem {
	title = '';
	cb: () => void = () => {};
	setTitle(t: string) {
		this.title = t;
		return this;
	}
	setIcon() {
		return this;
	}
	setSection() {
		return this;
	}
	setWarning() {
		return this;
	}
	setChecked() {
		return this;
	}
	onClick(cb: () => void) {
		this.cb = cb;
		return this;
	}
}
export class Menu {
	items: MenuItem[] = [];
	addItem(f: (i: MenuItem) => void) {
		const i = new MenuItem();
		f(i);
		this.items.push(i);
		return this;
	}
	addSeparator() {
		return this;
	}
	showAtMouseEvent(e: MouseEvent) {
		document.querySelector('.menu')?.remove();
		const el = document.body.createDiv({ cls: 'menu' });
		el.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99`;
		// Like Obsidian: focus moves into the menu while it is open.
		el.tabIndex = -1;
		const prev = document.activeElement as HTMLElement | null;
		for (const it of this.items) {
			const row = el.createDiv({ cls: 'menu-item', text: it.title });
			row.addEventListener('click', () => {
				el.remove();
				it.cb();
				// Obsidian restores focus to the previously focused element after a click.
				setTimeout(() => prev?.focus(), 30);
			});
		}
		el.focus();
		setTimeout(() => document.addEventListener('pointerdown', (ev) => !el.contains(ev.target as Node) && el.remove(), { once: true }));
	}
}

export class Modal {
	app: any;
	modalEl = document.createElement('div');
	titleEl = document.createElement('div');
	contentEl = document.createElement('div');
	constructor(app: any) {
		this.app = app;
	}
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}

export class PluginSettingTab {}
export class Setting {}
export class Plugin {}
export class MarkdownView {}
export class Notice {}
export function normalizePath(p: string) {
	return p;
}

P.setCssStyles = function (styles: Record<string, string>) {
	Object.assign(this.style, styles);
};
P.setCssProps = function (props: Record<string, string>) {
	for (const k in props) this.style.setProperty(k, props[k]);
};
(Node.prototype as any).instanceOf = function (type: any) {
	return this instanceof type;
};
