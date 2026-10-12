import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const prod = process.argv[2] === 'production';
// Set VAULT=/path/to/vault to build straight into that vault's plugin folder.
const vault = process.env.VAULT;
const outdir = vault ? join(vault, '.obsidian', 'plugins', 'native-mindmap') : '.';
if (vault) mkdirSync(outdir, { recursive: true });

const copyAssets = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(() => {
      if (!vault) return;
      for (const f of ['manifest.json', 'styles.css']) copyFileSync(f, join(outdir, f));
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: join(outdir, 'main.js'),
  plugins: [copyAssets],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
