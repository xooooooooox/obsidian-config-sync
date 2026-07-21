# Architecture

How Config Sync is built — a map for maintainers and future contributors. For the **UI** design
system (tokens, components, conventions) see [design/DESIGN.md](design/DESIGN.md); for the
**per-feature** history and rationale see [superpowers/specs/](superpowers/specs/). This document
maps the code and states the invariants; it does not recount those.

## Overview — three layers

```
src/core/*      pure logic, zero Obsidian & zero Node imports   (unit-tested with vitest)
    ⇅  injected interfaces: FileIO, PluginHost, CoreContext
src/main.ts     the ONLY connector to Obsidian                  (app.vault.adapter, app.plugins,
                                                                 requestUrl, window timers → CoreContext)
    ⇅  dynamic import(), desktop-gated
src/external/*  the ONLY place Node fs/child_process live       (git transport, local-path store,
                                                                 folder picker — desktop only)
    ⇅
src/ui/*        views, modals, panel view-model                 (SyncCenterView is the hub)
```

The core knows nothing about Obsidian **or Node** — so it runs on mobile and is testable against
an in-memory filesystem and a fake plugin host. `main.ts` adapts Obsidian's runtime into the plain
interfaces the core consumes (`FileIO` for the filesystem, `PluginHost` for the plugin registry,
`CoreContext` bundling both plus config). Anything needing Node (`fs`, `child_process`, the
Electron dialog) lives only in `src/external/`, loaded via **dynamic `import()` from desktop-gated
code in `main.ts`** so it never ships into the mobile bundle path. Classes exist only at the
boundary — the `Plugin` subclass and the modal/view classes; everything in `core/` is pure
functions.

**Data flows** (all through `CoreContext`):

- **Capture** — live config → store: `capture()` reads each group's files, applies its sync mode
  (strip/encrypt), writes changed files under `store/`, and stamps source versions into
  `store.lock.json`.
- **Apply** — store → live config: `apply()` / `applyWithActions()` back up every touched file,
  optionally install/enable/update the plugin first, then write the store's content into the
  config dir. One-slot **Revert** restores the backup.
- **Pull / Push** — store ↔ a remote (git repo or another vault): planned by `planImport()` /
  merged by `merge.ts`, transported by `main.ts`; external no-code targets go through
  `pushExternal()` with an `ExternalStoreReader`/`ExternalStoreWriter`.

## Module map (`src/`)

**Engine & context**
- `core/ConfigSyncCore.ts` — the engine and its interfaces: `capture`, `apply`,
  `applyWithActions`, `captureWithActions`, `revertLastApply`, `planImport`/`applyImport`,
  `pushExternal`, plus `CoreContext`, `PluginHost`, `ExternalStoreReader`/`ExternalStoreWriter`.
- `core/types.ts` — shared types: `SyncGroup`, `SyncManifest`, `StoreLock`, `GroupResult`,
  `FileChanges`/`hasChanges`, `Remote`, `SyncMode`.

**Status & availability**
- `core/status.ts` — per-item status (`statusForGroups`), remote freshness (`diffRemote`,
  `remoteLockAhead`), and the counts the UI shows (`bucketCounts`).
- `core/availability.ts` — is a plugin enabled / disabled / not-installed on this device, plus
  version drift (`availabilityForGroup`, `compareVersions`).
- `core/pluginState.ts` — `pluginRuntimeEnabled`: a plugin is "on" when **loaded OR persisted**.
- `core/catalog.ts` — the group taxonomy: how items sort into Options / Core / Community / Beta
  sections and their display labels; discovery of unclassified files.
- `core/leftover.ts` — `leftoverStoreRels`: store files with no matching group (cleanup surface).
- `core/runHistory.ts` — the run-record model and helpers (`RunRecord`, `summarizeRun`,
  `worstStatus`, `countChanged`, `isChanged`, `pruneHistory`).

**Transforms & storage**
- `core/modes.ts` — sync modes: `captureTransform`/`applyTransform` (plain / fields / encrypted),
  sensitive-key scanning (`scanSensitive`), passphrase gating.
- `core/crypto.ts` — AES-256-GCM file and field envelopes, PBKDF2 key derivation.
- `core/switchList.ts` — set-semantics for the on/off lists (`community-plugins`, `core-plugins`)
  with per-device exception masking; `SWITCH_LIST_GROUPS` names them.
- `core/pathing.ts` — the configDir-agnostic mapping between a group's real path and its store
  path (`groupRealPath`, `groupStorePath`; `STORE_CONFIG_DIR` = literal `configdir`).
- `core/io.ts` — the `FileIO` abstraction, recursive listing, OS-junk filtering (`isJunkPath`).
- `core/sanitize.ts` — key/pattern matching helpers used by field rules.
- `core/manifest.ts` — parse/validate/migrate `config-sync.json` and `store.lock.json`.
- `core/merge.ts` — merge a remote `store.lock.json` against the local one (`classifyMerge`).

**Install & discovery**
- `core/installer.ts` — download a plugin from the community catalog, version-pinned via the
  root manifest + tagged release; `CatalogError`/`DownloadError`.
- `core/bratIndex.ts` — the BRAT `id → repo` index (synced via `data.json`) for beta plugins.
- `core/pkm.ts` — PKM mode (`auto`/`ioto`/`default`) and store-root discovery
  (`resolveRootPath`, `discoverStoreRoot`).
- `core/async.ts` — portable `retry`/`isRetryableError`/`TimeoutError`/`HttpStatusError` (the
  `window`-based timeout wrapper lives in `main.ts`, keeping timers out of the core).

**UI** (`src/ui/`)
- `SyncCenterView.ts` — the hub: the header status bar (self "this device" chip + push/pull
  totals), the self pane, status list, filters/search, availability sections, the sticky
  result strip, run History, the Remotes block, and Capture/Apply/Pull/Push actions.
- `SettingTab.ts` — the settings tab (General / Obsidian / Core plugins / Community plugins /
  Beta / Advanced / Remotes).
- `actionIcons.ts` — the single source for the per-action Lucide icons + color classes
  (Capture/Apply/Push/Pull) reused across the panel, buttons, badges and History.
- `qualifierSearch.ts` — the `key:value` search shared by both search boxes: pure `parseQuery` /
  `matchesQualifiers` / `suggest` / `applySuggestion`, plus the `QualifierAutocomplete` DOM widget.
- `panelModel.ts` — the pure view-model deciding what state each row presents under the filters.
- `reportContent.ts` — shared run-report rendering (the strip and the Revert modal).
- `diffView.ts` — unified-diff rendering; `jsonView.ts` — read-only `data.json` viewer with keys
  colored by rule state; `sensitiveSort.ts` — floats rows with sensitive keys to the top;
  `commitGroups.ts` — settings save/commit logic; `ConfirmModal`/`ConflictModal`/
  `FolderSelectModal`/`ReportModal` — modals.

**External** (`src/external/`, desktop-only, the only Node code — dynamic-imported from `main.ts`)
- `gitSource.ts` — the git transport: `execFile('git', …)` against a temp clone, never touching
  the vault's own repo.
- `localPath.ts` — an `ExternalStoreReader`/`ExternalStoreWriter` over Node `fs` for a
  "another vault" remote (an absolute store path).
- `pickFolder.ts` — the Electron folder-picker dialog.

**Connector**
- `main.ts` — the `Plugin` subclass: builds `CoreContext` from Obsidian's runtime, implements the
  `PluginHost` (plugin registry, install/enable, versions), persists run history to a local file,
  registers the ribbon/commands and the Sync Center view, and dynamic-imports `src/external/`
  behind desktop gates.

## Core invariants

Changes must preserve these:

- **Pure core, connectors-only classes.** Nothing in `core/` imports Obsidian; it operates on
  injected `FileIO`/`PluginHost`. Classes appear only at the boundary (`main.ts`, modals, views).
- **Node stays in `src/external/`, mobile-safe core.** `fs`/`child_process`/Electron live only in
  `src/external/`, reached via dynamic `import()` from desktop-gated code in `main.ts` — so the
  core never pulls Node into the mobile bundle.
- **Switch lists are identified by group name and compared as sets.** `SWITCH_LIST_GROUPS`
  (`community-plugins`, `core-plugins`) drives set comparison — never byte comparison — at all
  five alignment points: `statusForGroups`, `classifyMerge`, `diffRemote`, capture, and apply.
- **Enabled = loaded OR persisted** (`pluginRuntimeEnabled`). Reading `enabledPlugins` alone
  misclassifies a running-but-unpersisted plugin as disabled.
- **Self-apply never disables/reloads Config Sync.** Applying a plugin's settings cycles it
  off/on so it reloads clean — but `applyGroup` skips this for `config-sync` itself, or the run
  would reload the plugin and wipe the panel mid-run.
- **Backup / lock model.** Apply backs every touched file into `<configDir>/config-sync-backup`
  (outside the plugin folder, so hot-reload can't fire mid-apply); one-slot **Revert** restores
  it. `store.lock.json` records each group's `sourcePluginVersion`/`sourceAppVersion`.
- **The store is configDir-agnostic.** Paths use the literal `configdir` segment, so a vault on
  `.obsidian` and one on `.obsidian_apple` map to the same store.
- **Run history is a separate, local-only file** — never captured, never synced.
- **Bulk apply/install is per-item isolated.** One item that throws becomes an error row; the
  rest of the batch still runs. Installs use timeout + retry.

## Data model

- **`config-sync.json`** (`<store root>/`) — the user-editable group definitions, validated
  against `schema/config-sync.schema.json`.
- **`store.lock.json`** — capture metadata: `capturedAt` + per-group `sourcePluginVersion` (plugin
  items) or `sourceAppVersion` (Obsidian/core items).
- **`store/`** — the mirrored content: `configdir/…` (device-independent mirror of the config
  dir) plus vault-root dotfiles with the leading dot stripped.
- **`run-history.json`** — the local-only run log (path/size/retention configurable).
- **`data.json`** (plugin settings) — persisted groups, `bratPluginIndex`, PKM mode, run-history
  config; written through Obsidian's `saveData` (never externally, to avoid a reload).

## How to extend

- **New group type** (today `file`/`dir`): extend `pathing.ts` and the capture/apply paths in
  `ConfigSyncCore.ts`.
- **New sync mode** (today `plain`/`fields`/`encrypted`): add it in `modes.ts` (and `crypto.ts`
  if it transforms bytes).
- **New remote type** (today git / vault): extend the `Remote` union in `types.ts`, add the
  desktop transport in `src/external/` (dynamic-imported from `main.ts`), and the freshness check
  in `status.ts`.
- **New external store target**: implement `ExternalStoreReader`/`ExternalStoreWriter` from
  `ConfigSyncCore.ts` and wire `planImport`/`pushExternal`.

## Testing & gates

- **Unit tests** — `vitest` over the pure core (in-memory `FileIO` + fake `PluginHost`);
  `npm test`.
- **Lint** — `npx eslint .`, held at a **67-warning baseline / 0 errors** (two "BRAT"
  sentence-case false positives are kept without `eslint-disable`, per repo convention).
- **No hardcoded colors** — `scripts/check-no-hardcoded-color.sh`; all CSS uses Obsidian theme
  variables, with `body.is-mobile`/`body.is-phone` scoping for touch.
- **Live checks** — drive a dedicated dev vault via **obsidian-cli**, which routes by CWD, so run
  from `dev/vault/` (never a real vault).
- **Build** — `npm run build` = `tsc -noEmit` + esbuild production bundle.

## Current state & how to resume

- **1.0.0** is the first stable release; the 0.x development history is retained on GitHub.
- **Parked backlog** (deferred by the maintainer — don't start without an explicit pick):
  1. UI audit polish — `design/DESIGN.md` §5 (six findings: dead CSS, emoji remnants, micro font
     sizes, text-on-fill variable split, border-radius tiers, one double-duty class).
  2. Capture/pull interruption robustness (crash-marker vs full atomicity — direction undecided).
  3. Run-history file diffs (unified diff per changed file, with a size cap).
- **Release flow**: `npm version <x.y.z>` (bumps `manifest.json`/`versions.json`, commits, tags)
  → `git push --follow-tags` → CI builds a **draft** GitHub release with the three assets →
  hand-write the release notes → publish (the directory and BRAT only see published releases).
