# Contributing

Thanks for helping make Native Mindmap better! This project is actively maintained: every issue and pull request is read and answered.

## Issues

- **Bugs**: include your Obsidian version, platform (desktop / mobile), the steps to reproduce and, if possible, the Markdown of the map.
- **Features**: describe the workflow you want rather than only the solution. It helps find the best design.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. `bun install` (or `npm install`), then `VAULT="/path/to/test-vault" bun esbuild.config.mjs` for a watch build into a test vault.
3. Keep the map format plain Markdown: a change must never make a note unreadable without the plugin.
4. Run `bun run build` (type-check + bundle) before opening the PR.
5. Describe what changed and how you tested it. Screenshots or a short GIF are great for UI changes.

Small, focused PRs are reviewed fastest.
