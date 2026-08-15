# CLAUDE.md

Obsidian plugin: selective config distribution across devices/vaults. Spec: `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` (design decisions D1–D7 explain every non-obvious choice — read it before structural changes).

## Commands

- `npm run dev` — esbuild watch → `main.js`
- `npm run build` — `tsc -noEmit` + production bundle (run before finishing any change)
- `npm test` — vitest; `tests/external.test.ts` needs the `git` binary
- `npm run smoke:install` — build and install the plugin into `./dev/vault` (gitignored copy of a test vault)
- Releasing: `npm version <x.y.z>` → `git push --follow-tags` → CI drafts the release → hand-write the release notes → publish the draft on GitHub (BRAT needs a published release).

## Architecture

Full code map, invariants, and extension points: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

- `src/core/` — pure functions; ALL file I/O via the `FileIO` interface (`app.vault.adapter` in prod, `tests/memfs.ts` in tests). **Never import Node APIs here — core must run on mobile.**
- `src/external/` — the only place Node `fs`/`child_process` are allowed; loaded exclusively via dynamic `import()` from desktop-gated code in `main.ts`.
- `src/ui/` — views/modals plus pure, unit-tested view-models (`panelModel`, `itemCard`, `qualifierSearch`, `statusBar`); DOM code stays thin.
- `src/main.ts` — plugin shell; the only file that touches non-public API (`app.plugins`), typed via the local `CommunityPluginRegistry` interface.
- `src/core/registry.ts` + `src/ui/SettingTab.ts`/`itemCard.ts` drive the picker tabs (one card per `ItemDef`); `src/core/catalog.ts` only feeds the settings search index and Advanced-tab helpers. Hardcoding is limited to `OPTION_LABELS` (option file → friendly name) and `CORE_FILE_EXCEPTIONS`/`corePluginFile()` (core plugin id → settings file, e.g. `properties → types.json` — Obsidian exposes no id→file link at runtime). All plugin *names* come from runtime (`instance.name` / `manifests[id].name`). Group identity is the `name` field (reserved names for picker items; `validateSyncManifest` rejects a custom rule that takes a reserved name at the wrong path).
- The Advanced tab renders each custom rule as a `config-sync-row` (chevron + name + path + delete); customized managed items surface only as a one-row summary with a bulk "Reset all to defaults" (`defaultGroupForName` in catalog.ts computes the default). Group names must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` (enforced in `validateSyncManifest`).

## Template upstream

The repo's git history is rooted at `obsidianmd/obsidian-sample-plugin` (remote `template`); toolchain files are vendored from it. To pull upstream updates: `git fetch template && git merge template/master`. Conflict rules: toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/.gitignore) take theirs; identity files (manifest.json, package.json name/author/license, versions.json), `styles.css` (plugin-owned styles since iter4), and `src/`/`tests/` stay ours; tsconfig takes theirs plus `tests/**/*.ts` re-added to `include`.

## Smoke testing

`dev/vault/` (gitignored) is a disposable Obsidian vault for CLI-driven smoke tests. Install the current build with `npm run smoke:install`, then drive the RUNNING app with the official CLI (`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`):

- `vaults verbose` lists registered vaults; target one with `vault=<folder-basename>`.
- `command id=config-sync:sync` opens the Sync Center (the only registered command — Capture/Apply/Pull/Push are driven from its DOM); `plugin:reload id=config-sync` reloads a dev build; `dev:errors` shows console errors; `dev:mobile on` emulates mobile; `dev:dom` / `dev:screenshot` inspect UI.
- Drive the Sync Center via `eval code=...`: tick `.config-sync-*` checkboxes and click the Capture/Apply buttons by textContent; run reports render as the pinned result strip (no report modal). Remaining modals (Stop syncing, Keep on this device, conflict, folder picker) still use `.modal` selectors.
- **Vault registration is human-only**: Obsidian rebuilds its vault registry from internal state at startup, pruning injected entries; the CLI cannot register or open new vaults. A human must "Open folder as vault" + Trust once — afterwards CLI automation is fully autonomous. CLI calls against a stale vault hang (~2 min).
- Never smoke-test in a real vault.

## Rules

- Store path mapping and manifest validation live in `core/pathing.ts` / `core/manifest.ts` — change them only with matching spec + test updates.
- Errors must carry context (group name, path, git command). No silent fallback.
- Test in a dedicated dev vault, never in a real vault.
- `docs/design/DESIGN.md` is the design-system reference (colors, type, icons, components, conventions). Read it before any UI work, and update it in the same branch as any UI 定稿 or change.
- **Smoke before deploy (owner's rule, 2026-08-16):** a UI change is never "style-only" here — render functions carry event wiring, so touching them touches behavior. Before deploying any UI diff to a real vault: run the `dev/vault` smoke harness and CLICK every control the diff touched (folds, menus, jumps); a diff that edits a render function must list the event listeners it moved in its report. `npm test` alone proves nothing about a click path.
- **Schema-first, design-first (owner's standing rule, restated 2026-08-13):** a change to a persisted data shape (`data.json`, `store.lock.json`, localStorage keys, the legacy manifest) starts by updating `schema/*.schema.json`; a change to UI structure or styling starts by updating `docs/design/DESIGN.md` (and a mockup where the owner's 定稿 process asks for one). Only then does code move. A PR/commit that changes a shape without its schema, or a surface without DESIGN.md, is incomplete by definition — this rule exists because both drifts have happened more than once.
- Documentation currency: when a change alters user-facing behavior (features, UI, commands, settings, workflows), update the affected docs in the SAME branch — `README.md` and `README.zh.md` (keep the two in sync), `docs/GUIDE.md` (the user guide — behavioral detail lives there, not in the READMEs), `docs/ARCHITECTURE.md` (code map / invariants, when structure changes), and `docs/design/DESIGN.md` (per the rule above). Pure internal refactors that change nothing a user sees need no doc edit. Gate: docs must be current before merging to `main` and before cutting a release.
