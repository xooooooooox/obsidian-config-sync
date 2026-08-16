# Agent guide

This repository is **obsidian-config-sync**, an Obsidian community plugin. Repo-specific
rules live in these files — read them instead of assuming sample-plugin defaults:

- [`CLAUDE.md`](CLAUDE.md) — agent orientation: doc map, commands, data vocabulary,
  schema-first/design-first rules, smoke-testing notes.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, build/test/lint gates, dev-vault smoke
  workflow, template-upstream merge rules, release process.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — code map and invariants.
- [`docs/design/DESIGN.md`](docs/design/DESIGN.md) — the UI design system (binding for any
  UI change).

Where this repo deliberately differs from generic Obsidian sample-plugin guidance:

- `main.js` **is committed** — it is the release artifact BRAT installs from the repo.
- Source is organized as `src/core/` (pure, mobile-safe) · `src/external/` (Node,
  desktop-only) · `src/ui/` · `src/main.ts` — not the sample's `commands/`/`utils/` layout.
- The two large UI files (`src/ui/SettingTab.ts`, `src/ui/SyncCenterView.ts`) are big by
  design; do not split them on line-count grounds alone.
- Testing means the vitest suite plus the CLI-driven `dev/vault` smoke harness — never a
  manual copy into a real vault.
