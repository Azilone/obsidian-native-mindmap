import { DEFAULT_SETTINGS } from '../src/settings';
import { MindmapView } from '../src/view';

(window as any).app = {
	workspace: { getActiveViewOfType: () => (window as any).view, on: () => ({}), trigger: () => {}, openLinkText: (l: string) => console.log('open', l) },
	vault: {},
};
const plugin: any = { settings: { ...DEFAULT_SETTINGS }, setMarkdownView: () => console.log('md view') };
const view = new MindmapView({} as any, plugin);
document.getElementById('app')!.appendChild(view.containerEl);
view.load();
const sample = new URLSearchParams(location.search).has('empty')
	? '---\nmindmap-plugin: basic\n---\n\n# Central idea\n'
	: '---\nmindmap-plugin: basic\n---\n\n# Projet **Alpha**\n\n- Idées\n\t- [[Une note]]\n\t- Deux\n- Tâches\n\t- A\n\t- B\n\t\t- B1\n- Questions\n- Notes de lecture assez longues pour passer sur deux lignes peut-être\n';
view.setViewData(sample, true);
(window as any).view = view;
