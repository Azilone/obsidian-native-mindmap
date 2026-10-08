import { App, Modal, Platform } from 'obsidian';

const MOD = Platform.isMacOS ? '⌘' : 'Ctrl';
const ALT = Platform.isMacOS ? '⌥' : 'Alt';

const SECTIONS: [string, [string, string][]][] = [
	[
		'Editing',
		[
			['Tab', 'Add child topic'],
			['Enter', 'Add sibling below'],
			['Shift Enter', 'Add sibling above'],
			['Space', 'Edit topic (tap)'],
			['F2', 'Edit topic'],
			['Delete', 'Delete topic'],
			['Shift Tab', 'Move up one level'],
			[`${ALT} ↑`, 'Move topic up'],
			[`${ALT} ↓`, 'Move topic down'],
		],
	],
	[
		'Navigation',
		[
			['← ↑ → ↓', 'Move selection'],
			['Esc', 'Clear selection'],
			['Home', 'Select central topic'],
			[`${MOD} .`, 'Fold / unfold'],
			['Drag', 'Move topic (drop on, above or below)'],
			['Drag empty space', 'Select several topics'],
			['Shift click', 'Add to selection'],
			[`${MOD} A`, 'Select all'],
		],
	],
	[
		'View',
		[
			['Shift 1', 'Zoom to fit'],
			['Shift 2', 'Zoom to selection'],
			['Scroll', 'Pan'],
			['Space drag', 'Pan'],
			[`${MOD} Scroll`, 'Zoom'],
		],
	],
	[
		'In Canvas',
		[
			['Tab', 'Add a connected child card'],
			['Enter', 'Add a sibling card'],
			['← ↑ → ↓', 'Move between topics'],
			['Delete', 'Delete topic and its branch'],
			['Right-click', 'Layout: mindmap, logic or timeline'],
		],
	],
	[
		'History & clipboard',
		[
			[`${MOD} Z`, 'Undo'],
			[`${MOD} Shift Z`, 'Redo'],
			[`${MOD} C`, 'Copy as Markdown list'],
			[`${MOD} X`, 'Cut'],
			[`${MOD} V`, 'Paste list as children'],
		],
	],
];

export class ShortcutsModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('mm-shortcuts-modal');
		this.titleEl.setText('Mindmap shortcuts');
		const grid = this.contentEl.createDiv({ cls: 'mm-shortcuts' });
		for (const [title, rows] of SECTIONS) {
			const section = grid.createDiv({ cls: 'mm-shortcuts-section' });
			section.createDiv({ cls: 'mm-shortcuts-title', text: title });
			for (const [keys, label] of rows) {
				const row = section.createDiv({ cls: 'mm-shortcuts-row' });
				row.createSpan({ cls: 'mm-shortcuts-label', text: label });
				const k = row.createSpan({ cls: 'mm-shortcuts-keys' });
				for (const key of keys.split(' ')) k.createEl('kbd', { text: key });
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
