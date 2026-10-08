import { App, PluginSettingTab, Setting } from 'obsidian';
import type MindmapPlugin from './main';
import { LAYOUTS, type LayoutMode } from './layout';

export interface MindmapSettings {
	layout: LayoutMode;
	spacing: 'compact' | 'comfortable' | 'spacious';
	colorfulBranches: boolean;
	showGrid: boolean;
	maxNodeWidth: number;
	animations: boolean;
	animationDuration: number;
	wheelBehavior: 'pan' | 'zoom';
	newFileFolder: string;
	canvasMode: boolean;
}

export const DEFAULT_SETTINGS: MindmapSettings = {
	layout: 'mindmap',
	spacing: 'comfortable',
	colorfulBranches: true,
	showGrid: true,
	maxNodeWidth: 260,
	animations: true,
	animationDuration: 280,
	wheelBehavior: 'pan',
	newFileFolder: '',
	canvasMode: true,
};

export class MindmapSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MindmapPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = async () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName('Layout').setHeading();

		new Setting(containerEl)
			.setName('Default layout')
			.setDesc('Used by new mindmaps. Each map can switch layout from its layout button or menu.')
			.addDropdown((d) =>
				d
					.addOptions(Object.fromEntries(LAYOUTS.map((l) => [l.id, l.name])))
					.setValue(s.layout)
					.onChange(async (v) => {
						s.layout = v as LayoutMode;
						await save();
					}),
			);

		new Setting(containerEl).setName('Spacing').addDropdown((d) =>
			d
				.addOptions({ compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' })
				.setValue(s.spacing)
				.onChange(async (v) => {
					s.spacing = v as MindmapSettings['spacing'];
					await save();
				}),
		);

		new Setting(containerEl)
			.setName('Maximum topic width')
			.setDesc('Longer topics wrap onto several lines.')
			.addSlider((sl) =>
				sl
					.setLimits(140, 480, 20)
					.setValue(s.maxNodeWidth)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxNodeWidth = v;
						await save();
					}),
			);

		new Setting(containerEl).setName('Appearance').setHeading();

		new Setting(containerEl)
			.setName('Colorful branches')
			.setDesc("Give each branch a color from your theme's palette.")
			.addToggle((t) =>
				t.setValue(s.colorfulBranches).onChange(async (v) => {
					s.colorfulBranches = v;
					await save();
				}),
			);

		new Setting(containerEl).setName('Dot grid background').addToggle((t) =>
			t.setValue(s.showGrid).onChange(async (v) => {
				s.showGrid = v;
				await save();
			}),
		);

		new Setting(containerEl)
			.setName('Animations')
			.setDesc('Animations are always off when your system asks to reduce motion.')
			.addToggle((t) =>
				t.setValue(s.animations).onChange(async (v) => {
					s.animations = v;
					await save();
				}),
			);

		new Setting(containerEl).setName('Animation speed').addDropdown((d) =>
			d
				.addOptions({ '180': 'Fast', '280': 'Normal', '420': 'Relaxed' })
				.setValue(String(s.animationDuration))
				.onChange(async (v) => {
					s.animationDuration = Number(v);
					await save();
				}),
		);

		new Setting(containerEl).setName('Behavior').setHeading();

		new Setting(containerEl)
			.setName('Mindmap mode in Canvas')
			.setDesc(
				'In Canvas, Tab on a card adds a connected child, Enter adds a sibling, and branches are arranged automatically.',
			)
			.addToggle((t) =>
				t.setValue(s.canvasMode).onChange(async (v) => {
					s.canvasMode = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName('Mouse wheel')
			.setDesc('Pan behaves like Canvas: scroll to move, hold Ctrl/⌘ or pinch to zoom.')
			.addDropdown((d) =>
				d
					.addOptions({ pan: 'Pan', zoom: 'Zoom' })
					.setValue(s.wheelBehavior)
					.onChange(async (v) => {
						s.wheelBehavior = v as MindmapSettings['wheelBehavior'];
						await save();
					}),
			);

		new Setting(containerEl)
			.setName('Folder for new mindmaps')
			.setDesc("Leave empty to use Obsidian's default location for new notes.")
			.addText((t) =>
				t
					.setPlaceholder('e.g. Mindmaps')
					.setValue(s.newFileFolder)
					.onChange(async (v) => {
						s.newFileFolder = v.trim();
						await save();
					}),
			);
	}
}
