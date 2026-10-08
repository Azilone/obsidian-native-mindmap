import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
const shim = fileURLToPath(new URL('./obsidian-shim.ts', import.meta.url));
await esbuild.build({
	entryPoints: [fileURLToPath(new URL('./entry.ts', import.meta.url))],
	bundle: true, format: 'iife', target: 'es2020', sourcemap: 'inline',
	outfile: fileURLToPath(new URL('./bundle.js', import.meta.url)),
	alias: { obsidian: shim },
	plugins: [{ name: 'alias-obsidian', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim })); } }],
});
