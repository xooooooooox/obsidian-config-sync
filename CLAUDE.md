# CLAUDE.md

Obsidian plugin: selective config distribution across devices/vaults.

## Doc map

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the live code map, storage/core
  invariants and data model. Read it before structural changes.
- [`docs/design/DESIGN.md`](docs/design/DESIGN.md) — the design-system reference (colors,
  type, icons, components, conventions). Read it before any UI work; update it in the same
  branch as any UI change.
- [`docs/GUIDE.md`](docs/GUIDE.md) — the user guide (Obsidian-user-facing; behavioral
  detail lives there, not in the READMEs). `README.md`/`README.zh.md` are the short pitch,
  kept in sync with each other.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — commands, lint/color gates, smoke workflow,
  template-upstream merge rules, release process, docs-currency rule.
- `schema/` — JSON Schemas for every persisted shape: `data.schema.json`,
  `store-lock.schema.json`, `config-sync.schema.json`, `local-storage.schema.json`,
  `run-history.schema.json`. Gated against the code by `tests/schemaFiles.test.ts`.
- `AGENTS.md` — a short pointer file (kept ours on template merges).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — historical design/working
  documents, ordered by date. Useful for rationale archaeology; never a statement of the
  current system — the live docs above are.

## Commands

`npm run dev` (watch) · `npm run build` (type-check + bundle — run before finishing any
change) · `npm test` (vitest) · `npm run lint` (0 errors / 58-warning ceiling, no inline
disables) · `npm run smoke:install` (build into `./dev/vault`) ·
`./scripts/check-no-hardcoded-color.sh` (CSS gate). Details and the release flow:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture (one-screen version)

Full map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

- `src/core/` — pure functions; ALL file I/O via the `FileIO` interface (`app.vault.adapter`
  in prod, `tests/memfs.ts` in tests). **Never import Node APIs here — core must run on mobile.**
- `src/external/` — the only place Node `fs`/`child_process` are allowed; loaded exclusively
  via dynamic `import()` from desktop-gated code in `main.ts`.
- `src/ui/` — views/modals plus pure, unit-tested view-models (`panelModel`, `itemCard`,
  `qualifierSearch`, `statusBar`); DOM code stays thin.
- `src/main.ts` — plugin shell; the only file that touches non-public API (`app.plugins`),
  typed via the local `CommunityPluginRegistry` interface.

## Data vocabulary (do not resurrect retired shapes)

- `data.json` is `schemaVersion: 4`; the item flag is **`synced`** (never `enabled` — that
  rename fixed a double meaning).
- **Retired fields, gone from the document:** `runsOn`, `thisDeviceItems`, `bratIndex`,
  `deviceOptOuts`, `customGroups`. Enablement rules live on the carrier item's
  `settingsFile.perElement`; device-local exceptions live in localStorage
  (`config-sync-device-elements` / `config-sync-device-optouts`). Only the migrations read
  the old shapes.
- The word `scope` is retired everywhere (code and copy); the current words are `section` /
  `sharing` / `device` / `mode` / `element` / `action` / `type` (DESIGN.md §3).

## Smoke testing — agent notes

The general dev-vault workflow is in [CONTRIBUTING.md](CONTRIBUTING.md). Agent-specific:

- The CLI binary is `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`; it routes by
  CWD — run from `dev/vault/`. `eval` takes `code=<js>`, not bare JS.
- **Vault registration is human-only** (Obsidian prunes injected registry entries at
  startup); calls against a stale vault hang ~2 min.
- Never smoke-test in a real vault.

## Rules

- Store path mapping and manifest validation live in `core/pathing.ts` / `core/manifest.ts`
  — change them only with matching schema + test updates.
- Errors must carry context (group name, path, git command). No silent fallback.
- **Schema-first, design-first:** a change to a persisted data shape (`data.json`,
  `store.lock.json`, localStorage keys, the legacy manifest, `run-history.json`) starts by
  updating `schema/*.schema.json`; a change to UI structure or styling starts by updating
  `docs/design/DESIGN.md` (with an owner-approved visual draft for visual changes). Only
  then does code move. A commit that changes a shape without its schema, or a surface
  without DESIGN.md, is incomplete by definition.
- **Smoke before deploy:** a UI change is never "style-only" — render functions carry event
  wiring. Before deploying any UI diff, run the `dev/vault` smoke harness and CLICK every
  control the diff touched; a diff that edits a render function must list the event
  listeners it moved. `npm test` alone proves nothing about a click path.
- **Documentation currency:** user-facing behavior changes update the affected docs in the
  SAME branch (see CONTRIBUTING.md's list); docs must be current before merging to `main`
  and before cutting a release.
