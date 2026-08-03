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
  `store.lock.json` — carrying forward lock entries for groups outside this vault's compiled
  registry, whose store content only pulls (not local flows) manage.
- **Apply** — store → live config: `apply()` / `applyWithActions()` optionally
  install/enable/update the plugin first, then write the store's content into the config dir
  (no backup — the removed 1.x "Revert last apply" was the only consumer).
- **Pull / Push** — store ↔ a remote (git repo or another vault): planned by `planImport()` /
  merged by `merge.ts`, transported by `main.ts`; external no-code targets go through
  `pushExternal()` with an `ExternalStoreReader`/`ExternalStoreWriter`.

## Module map (`src/`)

**Engine & context**
- `core/ConfigSyncCore.ts` — the engine and its interfaces: `capture`, `apply`,
  `applyWithActions`, `captureWithActions`, `planImport`/`applyImport`,
  `pushExternal`. `planImport(ctx, reader, opts: { excludeSelf: boolean })` and
  `pushExternal(ctx, writer, opts: { excludeSelf: boolean })` both take an explicit options param
  (no default): when `excludeSelf` is set, `isSelfStoreRel(rel)` (exported next to
  `SELF_STORE_DATA_REL`) names the self item's data-file and sidecar rels, which `planImport` then
  drops from both file maps before `classifyMerge` and `pushExternal` skips in its write loop —
  and, on the push side, exempts from the mirror-delete loop too, so the remote's own self copy is
  never deleted even though it's absent from the local push set. `remoteGroupsFrom(ctx, reader,
  files)` resolves the remote's sync list from its self store copy — schema v1 copies carry a
  compiled `groups` array; v2 copies (items + customGroups) compile through the injected
  `CoreContext.storeListGroups` hook (main.ts wires `storeSelfCopyGroups` with the plugin's
  registry defs). `applyImport`'s lock merge attributes identical files two-sidedly
  (`owningGroupName`), so store content outside the local registry still carries its lock entry
  across on pull. The module also exports
  `CoreContext` (`deviceClass: "desktop" | "mobile"`; optional
  `fieldOverlay?: (group, topKeys) => FieldRule[] | null` — a seam for runtime category rules
  layered on top of a group's stored `fields`, via `overlayGroup(ctx, group, jsons)`; unused today
  — `main.ts` passes no `fieldOverlay`, since every registry item, including the "app" (app.json)
  card, compiles as one ordinary single-file group like any other (`registry.ts`'s
  `compileSingleFile`). Kept as a seam for a future runtime-only rule source). `overlayGroup`
  early-returns for any group that carries a `fileRule` (even `encrypted: false`), so a future
  fieldOverlay consumer can't silently bypass whole-file encryption.
- `core/types.ts` — shared types: `SyncGroup`, `SyncManifest`, `StoreLock`, `GroupResult`,
  `FileChanges`/`hasChanges`, `Remote`, `SyncMode`. The rule model is orthogonal (spec
  2026-07-25-unified-card-design.md §2, D1): `RULE_SCOPES = ["all", "desktop", "mobile", "local"]`
  (`RuleScope`, "local" = This device) is the single source of truth both the types and
  `manifest.ts`'s validator derive from, so they can't drift apart. `FieldRule = { pattern, scope:
  RuleScope, encrypted: boolean, locked? }` — scope and encrypted combine freely (`local` +
  `encrypted: true` is the one illegal combination, rejected by `manifest.ts`). `FileRule = {
  scope: Exclude<RuleScope, "local">, encrypted: boolean }` — a Plain single-file group's
  whole-file rule (no `local`: "don't sync it" is the group's own toggle, not a file-level scope);
  `encrypted: true` here means the ENTIRE file is stored as one encrypted envelope, not per-field.
  `PerItemScopes = Record<string, RuleScope>` — per-element scope for a string-array key
  (`SyncGroup.perItem: Record<string, PerItemScopes>`), generalizing the old switch-list-only
  per-member scope to any string-array key; governed exclusively by `core/perItem.ts`, never by
  the key's own `FieldRule`.
- `core/perItem.ts` — `capturePerItemArray`/`applyPerItemArray`: per-element merge for a
  `PerItemScopes`-governed array key — captures each element by its own scope (local-only elements
  never enter the store; desktop/mobile-only elements go through the same partition as class field
  rules) while preserving the other device's already-captured elements, since the array is one
  shared list, not a per-device sidecar.
- `core/registry.ts` — the item registry and its compiler, replacing the v3-era per-kind catalog
  rows (`app-view-*`, `appearance-domain`) with one flat list of `ItemDef` (task-4-brief.md, spec
  §1/§6; app.json merged to a single card per `2026-07-26-ui-feedback-round2-design.md` §2).
  `buildItemDefs(env)` builds one `ItemDef` per card — the three Obsidian cards (`app` /
  `appearance` / `hotkeys`, fixed order from `OBSIDIAN_CARD_DEFS`), every core plugin (`core:<id>`,
  including ones with no settings file yet, sorted by label) and every installed community/beta
  plugin (`community:<id>`, beta reuses the community id form, also sorted by label).
  `compileItems(defs, settings)` is the ONLY place that turns `(ItemDef[], ConfigSyncSettings)`
  into the `SyncGroup[]` the existing capture/apply engine already knows how to run: every item —
  including "app" — compiles through the same `compileSingleFile` path (there is no shared/merged
  carrier any more), plus one group per companion folder, and — only when at least one plugin
  element is enabled — the hidden `core-plugins`/`community-plugins` enablement-carrier groups (no
  longer surfaced as their own rows; see Data model below). `enablementScopes(defs, settings,
  carrier)` projects each plugin item's `enabledOn` into the carrier's per-element scope map, which
  `main.ts` folds into the switch-list engine's existing runtime member-exception derivation
  (`core-plugins.json`/`community-plugins.json` are not string-array files, so they cannot go
  through `perItem.ts` the way `enabledCssSnippets` does). `compileCustomGroups(customGroups, defs,
  seenPaths)` compiles `settings.customGroups` (freeform "Custom rules"/"Discovered files" entries
  with no `ItemDef`) into the same `SyncGroup[]`, rejecting names `reservedCustomGroupNames(defs)`
  already claims (every registry-owned group name). `groupOwners(defs, customGroups)` maps every
  compiled group name back to the `ItemConfig`(s) that own it, plus a synthetic `custom:<name>`
  owner per `customGroups` entry, so "Stop syncing" a group by name durably flips `settings.items`
  (or removes the matching `settings.customGroups` entry) instead of a session-only compiled group
  edit. `companionConflict(path, defs, settings)` rejects a new companion/custom path that's
  already claimed by any item's settings file (default or custom) or any preset or user-added
  companion. `parentCardLabel(groupName, defs, settings)` resolves the host-card label for a
  card-derived group — an enabled companion folder (matched the same way `compileCompanions`
  names it) or, for v3-era store manifests that still carry it as a group, the
  `enabled-css-snippets` switch list (pinned to the `appearance` def's label); `null` for a
  standalone group. It backs `GroupDisplayParts` and the host's `displayParts(group,
  storedLabel)` (`main.ts`), which the Sync Center (`SyncCenterView.ts`) renders as a faint
  `Parent › ` prefix and folds into its sort key and search text — display-only, never persisted
  (`displayName`/`backfillLabels` still write the bare label to the store manifest).

**Status & availability**
- `core/status.ts` — per-item status (`statusForGroups`), remote freshness (`diffRemote`,
  `remoteLockAhead`), and the counts the UI shows (`bucketCounts`, `remoteDirectionCounts` —
  the per-remote ⇡ push / ⇣ pull totals behind the header pills and the status bar).
  `diffRemote(ctx, reader, opts: { excludeSelf: boolean })` returns per-group `RemoteDiffEntry.files:
  RemoteDiffFile[]` — one entry per file with its `kind` (`added`/`updated`/`deleted`) and both
  sides' content, so the UI renders file lists and content diffs instead of bare counts;
  `excludeSelf` drops the self item's store rels from both sides before diffing.
  `remoteLockAhead(localRaw, remoteRaw, ignoreGroups)` takes an explicit `ignoreGroups` list —
  callers pass `[SELF_GROUP_NAME]` when a remote's `excludeSelf` is set, so a divergent self lock
  entry never keeps the "remote has newer version info" hint alive forever. `applyImport` closes the
  loop on the writer side: after a pull it carries every non-ignored remote lock entry (all but the
  self group when `excludeSelf`, and any group whose file conflict the user kept as `local`) into the
  local lock, so `remoteLockAhead` converges to false once contents match — the hint clears after a
  single Pull instead of nagging. Direction for a changed group
  is a three-way comparison against this device's `core/ledger.ts` entry, never file mtimes or the
  lock's `capturedAt`: no entry → `never-synced` (apply-default, counts into `bucketCounts.down`);
  only the store side moved → `store-newer`; only the local side moved → `local-changed`; both
  sides moved, or neither (a scope/rule edit shifted the comparison lens) → `differs`, meaning
  specifically "changed on both sides since this device last synced". A comparison error still
  reports `differs` with a `message`. `statusForGroups` is IO-free with respect to the ledger — it
  takes the parsed `Ledger` and returns `{ statuses, updates }`; `main.ts` owns loading and
  persisting it (see Connector below).
- `core/ledger.ts` — the device-local sync-baseline ledger behind that direction logic. After
  every group whose comparison reports `in-sync`, `statusForGroups` emits a fresh `{store, local,
  at}` fingerprint (SHA-256 hex via `crypto.subtle`); switch-list groups (`SWITCH_LIST_GROUPS`)
  hash their canonical *set* form rather than raw bytes, so on/off-list reordering never reads as
  movement, and dir groups hash a sorted `rel\nsha256(content)` manifest. `main.ts` is the ledger's
  only writer — there is no separate write hook in capture/apply, since every run already triggers
  a status recompute whose `in-sync` results reseed the baseline (this also covers upgrade
  migration and self-healing after a wiped ledger). `parseLedger`/`applyUpdates`/`pruneLedger` are
  pure and total: malformed or missing input parses to an empty ledger, entries for groups that
  left the compiled config are pruned on write, `no-settings`/`not-captured` groups drop
  their entry, while comparison errors and `locked` groups keep theirs (a transient read failure
  or missing passphrase must not degrade direction knowledge). A lost ledger only ever widens uncertainty toward
  `never-synced`, never guesses a destructive direction.
- `core/availability.ts` — is a plugin enabled / disabled / not-installed on this device, plus
  version drift (`availabilityForGroup`, `compareVersions`); `snippetOrphans(local, store,
  localFiles, storeFiles)` — enabled-snippet names with no `.css` file locally **and** none in
  the store's snippets dir (the store-file check is a fresh-device safeguard: before its
  `snippets/` dir has synced down, the store copy still covers it). `scopedAwayMembers`/
  `memberForceOff` (generalized from the old snippet-only `scopedAwaySnippets`/
  `snippetForceOff`) compute, for any switch group, which member ids a shared class scope
  keeps off this device and which of those must be force-removed from the applied list.
- `core/pluginState.ts` — `pluginRuntimeEnabled`: a plugin is "on" when **loaded OR persisted**.
- `core/catalog.ts` — `OPTION_LABELS`/`listOptionSections`/`listCoreSections`/
  `listPluginSections`/`listBetaSections` are the pre-registry `CatalogItem`/`CatalogSection`
  taxonomy; they no longer drive any tab's rendering (that's `registry.ts` + `itemCard.ts` now —
  see UI below) and today only feed `SettingTab.ts`'s search index and a few Advanced-tab helpers.
  `listDiscovered` (unclassified config-root files) is still live for the Advanced tab.
  `categoryForGroup(name)` maps a compiled group name to its search/leftover category (`obsidian`/
  `core`/`community`/`custom`/…) for the `scope:` qualifier and leftover grouping; the switch-list
  enablement-carrier groups `community-plugins`/`core-plugins` are pinned to `community`/`core`
  (the same way `enabled-css-snippets` is pinned to `obsidian`) instead of falling through to
  `custom`.
- `core/leftover.ts` — `leftoverStoreRels`: store files with no matching group (cleanup surface).
  `selfListGroups` is the list-membership compile the self pane's delta/coldstart/`itemCount`
  now share with the store side (`storeSelfCopyGroups` calls it too): items compiled with
  synthesized defs for ids whose plugin isn't installed on this device, so an item this device's
  own `data.json` carries never drops out of membership just because its plugin is absent here.
- `core/selfPane.ts` — `selfPaneState`: decides the Config Sync pane's direction from the self
  item's content status and version drift. It also reports an orthogonal `versionBehind` advisory
  (this device's plugin older than the store's captured version) — surfaced as the pane's
  update-available block and the orange `is-behind` pill; it never becomes a stageable action,
  since updating config-sync mid-run would unload the running code.
- `core/runHistory.ts` — the run-record model and helpers (`RunRecord`, `summarizeRun`,
  `worstStatus`, `countChanged`, `isChanged`, `pruneHistory`).

**Transforms & storage**
- `core/modes.ts` — sync modes: `captureTransform`/`applyTransform` (plain / fields / encrypted),
  sensitive-key scanning (`scanSensitive`), passphrase gating. `classPatterns(group, cls)` reads a
  group's `desktop`/`mobile` field rules — **top-level keys only**: class actions ignore a glob
  match inside a nested object (`strip`/`encrypt` keep their existing any-depth semantics; a
  shallow top-level merge is enough to reassemble the class partition, so nested support is
  YAGNI). `dropTopLevel` partitions/reassembles the root object on both sides: Capture removes
  both classes' keys from the base and returns the device's own-class subset as `ownScope`
  (`captureTransform`'s third return field); Apply computes `store base ⊕ own-class sidecar`
  (shallow merge, sidecar wins) via `applyTransform`'s `ownScopeContent` parameter, before
  decrypt/strip run. With no sidecar yet (a pre-partition device), own-class keys fall back to
  the local value; other-class keys are always dropped, never preserved from local.
- `core/crypto.ts` — AES-256-GCM file and field envelopes, PBKDF2 key derivation; whole-file
  encryption (a Plain-mode `FileRule.encrypted`) uses the same file-envelope primitive as
  `mode: "encrypted"` groups, just gated by a different rule shape.
- `core/switchList.ts` — set-semantics for the on/off lists (`community-plugins`, `core-plugins`,
  `enabled-css-snippets`) with per-device exception masking; `SWITCH_LIST_GROUPS` names them.
- `core/pathing.ts` — the configDir-agnostic mapping between a group's real path and its store
  path (`groupRealPath`, `groupStorePath`; `STORE_CONFIG_DIR` = literal `configdir`).
  `sidecarStoreSuffix(cls)` = `.__scopes__.<cls>.json`, appended to a file group's flat store path
  (there is no per-group store directory to nest a sidecar file under); `resolveGroupByStoreRel`
  matches that suffix so leftover/merge logic attributes a sidecar to its owning group.
- `core/io.ts` — the `FileIO` abstraction, recursive listing, OS-junk filtering (`isJunkPath`).
- `core/sanitize.ts` — key/pattern matching helpers used by field rules.
- `core/manifest.ts` — `validateSyncManifest`: structural validation for a `SyncGroup[]` (the
  `compileItems` safety net in `main.ts`'s `recompile`, and the hand-edited Advanced-tab custom
  rules); `RULE_SCOPES`-derived `FieldRule`/`FileRule` scope validation (single source of truth
  with `types.ts`, so the type and the validator can't drift — the failure mode a prior CRITICAL
  finding was named for); parse/validate `store.lock.json`.
- `core/merge.ts` — merge a remote `store.lock.json` against the local one (`classifyMerge`); also
  the shared `sortKeysDeep`/`jsonSortedView` helpers (key-order-normalized JSON rendering, arrays
  keep their order), used by both the merge-conflict modal and the Sync Center's diff preview —
  when a `.json` file's raw text differs but its sorted view doesn't, the preview shows a single
  "Only key order / formatting differs." note instead of a blank-looking diff.

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
  Beta / Advanced / Remotes). `renderRegistryCards`/`renderItemCard`/`renderCardExpansion` are the
  ONE renderer for every `ItemDef` across the Obsidian/Core/Community/Beta tabs (`itemDefs()`
  filtered by section) — there is no per-kind branch left; a plugin's own card carries its
  enablement zone, so the old "Enabled community plugins"/"Enabled core plugins" aggregate rows
  and their dedicated Device-scope drawer are gone. Advanced (custom rules / discovered files)
  still renders the legacy per-`SyncGroup` rule form, unrelated to the card renderer.
- `itemCard.ts` — pure render-model helpers for the card renderer (badges, zone presence, the
  Fields/Companion-folders row models, path/companion validation) so the card's logic is
  unit-testable without touching the DOM; `SettingTab.ts`'s renderers are the only consumer that
  turns these models into elements.
- `actionIcons.ts` — the single source for the per-action Lucide icons + color classes
  (Capture/Apply/Push/Pull) reused across the panel, buttons, badges and History.
- `statusBar.ts` — pure segment model (`statusBarSegments`, `statusBarAriaLabel`) + a thin DOM
  renderer for the status-bar item; segments mirror the Sync Center header pills (↑/↓ from
  presented bucket counts, ⇡/⇣ from `remoteDirectionCounts`).
- `qualifierSearch.ts` — the `key:value` search shared by both search boxes: pure `parseQuery` /
  `matchesQualifiers` / `suggest` / `applySuggestion`, plus the `QualifierAutocomplete` DOM widget.
- `panelModel.ts` — the pure view-model deciding what state each Sync Center row presents under
  the filters (unrelated to the settings-tab card renderer above); `never-synced` rows filter under
  `apply` and default-direction to apply, same as `store-newer`/`differs`. `showColdStartBanner(
  selfState, statuses, dismissed)` is the pure predicate behind the Sync Center's cold-start
  banner: true while the plugin's own settings are still pending adoption (self state `coldstart`/
  `adopt`/`both`) and at least one row is `never-synced`, unless dismissed. It also carries the
  switch-list member-guidance models: `memberChangeRows` turns a switch group's divergence into
  one row per element the pending action would flip, worded in device language; `memberDecisionsFromScopes`/
  `memberDecisionText` turn a group's per-member rule scopes into the note rows the Sync Center
  renders under each switch group's detail.
- `reportContent.ts` — shared run-report rendering (the Sync Center strip and History detail).
- `diffView.ts` — unified-diff rendering; `jsonView.ts` — read-only `data.json` viewer with keys
  colored by `{scope, encrypted}` rule state (per-element coloring too, for a `perItem` array);
  `itemCard.ts`'s `PREVIEW_LEGEND_ENTRIES` drives the purple detected-key highlight in the File
  preview; `commitGroups.ts` — Advanced-tab custom-rule save/commit logic; `ConfirmModal`/
  `ConflictModal`/`FolderSelectModal` — modals.

**External** (`src/external/`, desktop-only, the only Node code — dynamic-imported from `main.ts`)
- `gitSource.ts` — the git transport: `execFile('git', …)` against a temp clone, never touching
  the vault's own repo. Every spawn goes through one `git()` funnel that owns the child's
  environment (`gitEnv`): terminal prompts off, credential-helper dirs appended to a GUI process's
  bare PATH, no interactive credential-manager UI. Given a token it also clears the machine's
  helper chain and injects an inline helper reading `CONFIG_SYNC_GIT_TOKEN` from the environment,
  so the secret never reaches argv — and `stripCredentialArgs` keeps that plumbing out of error text.
- `gitToken.ts` — free of Node, the bridge between a remote's `tokenId` (the NAME of a keychain
  secret, chosen through Obsidian's own `SecretComponent` picker; it sits in the remotes list,
  which `selfPresetRules` keeps device-local, so it never leaves through Config Sync's own sync)
  and the value in `app.secretStorage`: `resolveGitToken()` returns `null` when a remote
  has no token (fall back to the machine's git sign-in), throws an actionable error when the name
  is set but this device never linked a secret under it, and otherwise returns the `GitAuth` pair
  the helper answers with — the remote's own `username` when it has one, else `"token"`, which
  PAT-only hosts ignore but a self-hosted GitLab validates.
- `localPath.ts` — an `ExternalStoreReader`/`ExternalStoreWriter` over Node `fs` for a
  "another vault" remote (an absolute store path).
- `readerCache.ts` — a framework-free `ReaderCache` + `remoteReaderKey`: since a reader is a
  point-in-time in-memory snapshot (the git reader deletes its temp clone before returning), it is
  cached per refresh generation and reused, so a compare no longer re-clones after the status check.
  `refreshRemoteChecks` bumps the generation once per refresh; `deepDiff` reads with `{ reuse: true }`
  while `pullFrom`/`pushTo` stay fresh; a remote add/edit/delete clears the cache.
- `pickFolder.ts` — the Electron folder-picker dialog.

**Connector**
- `main.ts` — the `Plugin` subclass: builds `CoreContext` from Obsidian's runtime, implements the
  `PluginHost` (plugin registry, install/enable, versions), persists run history to a local file,
  registers the ribbon/commands and the Sync Center view, and dynamic-imports `src/external/`
  behind desktop gates. `updateStatusIndicators()` (formerly `updateRibbonDot()`) drives both
  status surfaces from the same bucket/remote counts: the opt-in ribbon dot (unchanged
  `config-sync-dot-*` classes, gated by `settings.ribbonDot`) and the status-bar item
  (`ui/statusBar.ts`) — the dot folds remote-newer into its apply state (legacy behavior), while
  the status bar shows remote-newer as a ⇣ pull segment, matching the panel.
  `recompile()` runs on load and after every `saveSettings()`: `buildItemDefs(env)` (env = the
  running Obsidian's actual core-plugin/community-plugin/beta state) rebuilds `registryDefs`, then
  `compileItems(registryDefs, settings)` (validated through `validateSyncManifest` as a safety net)
  rebuilds `compiledGroups` — the only `SyncGroup[]` the capture/apply engine ever sees. A
  `CompileError` (a path collision) is surfaced as a `Notice` and leaves the PREVIOUS
  `compiledGroups` in place, so a bad edit can't silently wipe the working sync list.
  `reloadSettings()` (`loadSettings()` + `recompile()`) is used wherever something just rewrote
  `data.json` externally — e.g. a self-group apply or `adoptConfiguration` — so `compiledGroups`
  reflects it immediately instead of staying stale until the next unrelated save. For the
  `core-plugins`/`community-plugins` switch groups, `main.ts` derives the runtime mask/force-off
  pair `CoreContext` needs from `registry.ts`'s `enablementScopes` (never from a standalone
  settings field — see Data model below): `switchExceptions[group]` = local-scoped element ids ∪
  desktop/mobile-scoped ids not matching this device ∪ auto-derived exclusions (community-plugins
  only — desktop-only manifest ids on mobile, plus plugin groups whose `devices` class doesn't
  match); `switchForceOff[group]` = the subset of those that must be force-removed from the applied
  list. Auto-derived ids are mask-only and never appear in force-off, so they keep local state
  instead of being forced off — an explicit `This device` scope, by contrast, is enforced on the
  wrong device class. `enabled-css-snippets` is unaffected by any of this — its per-element scope
  lives in the compiled "appearance" group's `perItem.enabledCssSnippets` map instead (see
  `core/perItem.ts` above).
  `loadBaselines`/`saveBaselines` wrap `app.loadLocalStorage`/`saveLocalStorage` under the vault-
  and device-scoped key `config-sync-baselines` (same storage shape as the `config-sync-passphrase`
  key above) and are the ledger's only reader/writer, called before and after every
  `statusForGroups` pass (the main list, the self group, and the periodic/manual status refresh).
  The key is deliberately `localStorage`, not a vault file: remotely-save (or any note sync)
  carries the vault, and the baseline is exactly the fact a vault-wide sync must not carry — what
  THIS device last saw in sync. `coldStartDismissed`/`setColdStartDismissed` persist the cold-start
  banner's dismissal the same way, under `config-sync-coldstart-dismissed`, cleared whenever self
  state settles back to `insync` so a future genuine cold start shows the banner again.

**Brand assets**
- `assets/` — brand SVGs: `icon.svg` (24×24, `currentColor`, iconize-importable), `logo.svg`
  (256×256 README tile), `social-preview.svg` (1280×640 GitHub social card).

## Core invariants

Changes must preserve these:

- **Pure core, connectors-only classes.** Nothing in `core/` imports Obsidian; it operates on
  injected `FileIO`/`PluginHost`. Classes appear only at the boundary (`main.ts`, modals, views).
- **Node stays in `src/external/`, mobile-safe core.** `fs`/`child_process`/Electron live only in
  `src/external/`, reached via dynamic `import()` from desktop-gated code in `main.ts` — so the
  core never pulls Node into the mobile bundle.
- **Switch lists are identified by group name and compared as sets.** `SWITCH_LIST_GROUPS`
  (`community-plugins`, `core-plugins`, plus the legacy-only `enabled-css-snippets` — never
  compiled as its own group since the perItem move) drives set comparison — never byte
  comparison — at all
  five alignment points: `statusForGroups`, `classifyMerge`, `diffRemote`, capture, and apply.
- **Direction comes from a device-local baseline, not timestamps.** `store.lock.json`'s
  `capturedAt` and file mtimes never drive `local-changed`/`store-newer`/`differs`; only the
  `core/ledger.ts` fingerprint this device last saw in sync does. Losing the ledger (reinstall,
  cleared app data) only ever widens uncertainty to `never-synced` (apply-default) — it never
  guesses a destructive direction.
- **Class field rules (`desktop`/`mobile`) act on top-level keys only.** A glob match inside a
  nested object is ignored for class partitioning; `strip`/`encrypt` are unaffected and keep
  their any-depth semantics.
- **Enabled = loaded OR persisted** (`pluginRuntimeEnabled`). Reading `enabledPlugins` alone
  misclassifies a running-but-unpersisted plugin as disabled.
- **Self-apply never disables/reloads Config Sync.** Applying a plugin's settings cycles it
  off/on so it reloads clean — but `applyGroup` skips this for `config-sync` itself, or the run
  would reload the plugin and wipe the panel mid-run.
- **Lock model.** `store.lock.json` records each group's `sourcePluginVersion`/
  `sourceAppVersion`. (The 1.x one-slot apply backup at `<configDir>/config-sync-backup` is
  gone with the removed Revert feature; apply deletes a leftover copy.)
- **The store is configDir-agnostic.** Paths use the literal `configdir` segment, so a vault on
  `.obsidian` and one on `.obsidian_apple` map to the same store.
- **Run history is a separate, local-only file** — never captured, never synced.
- **A snippet orphan is never auto-removed.** A `snippets/` member whose file is gone but still
  has a per-item device choice (`SnippetMemberRow.fileExists: false`, `itemCard.ts`) stays listed
  until an explicit Forget clears the choice — the file's absence may be transient (mid-sync), so
  silently dropping the record would risk losing a real device choice.
- **Bulk apply/install is per-item isolated.** One item that throws becomes an error row; the
  rest of the batch still runs. Installs use timeout + retry.
- **The registry compiles, it never migrates.** `compileItems(registryDefs, settings)` is the only
  path from `(ItemDef[], settings.items)` to the `SyncGroup[]` the engine runs; a `CompileError`
  (a path collision) is surfaced as a `Notice` and leaves the PREVIOUS `compiledGroups` in place —
  a bad edit must never silently wipe the working sync list.
- **Schema v2 is a hard gate, not a migration.** `isLegacySettings` (any `data.json` without
  `schemaVersion: 2`) blocks with a `Notice` and starts from `DEFAULT_SETTINGS` — there is no
  field-by-field migration from the v1/v3-era `groups`/`memberScopes`/`memberLocal`/`appJsonTabs`.

## Data model

- **`data.json`** (`ConfigSyncSettings`, plugin settings, `schemaVersion: 2`) — what syncs and how,
  compiled to `SyncGroup[]` on every load/save; there is no separate hand-edited manifest file
  anymore (the old `config-sync.json` at `<store root>/` is legacy and only ever read to detect a
  pre-v2 install — see the schema-gate invariant above). Fields:
  - `items: Record<string, ItemConfig>` — one entry per registry item id (`app` / `appearance` /
    `hotkeys` / `core:<id>` / `community:<id>`). `ItemConfig = { enabled, settingsFile?,
    companions: ItemCompanion[], enabledOn?: RuleScope }`. `settingsFile = { customPath?, mode:
    "plain" | "fields", fileRule?: FileRule, rules: Record<string, ItemFieldRule>, perItem:
    Record<string, PerItemScopes> }` (`ItemFieldRule = Omit<FieldRule, "pattern">` — the map key IS
    the pattern, so there is exactly one source of truth for which key a rule governs).
    `companions: { path, scope: DeviceClass, enabled }[]` — preset (`themes/`, `snippets/`) plus
    user-added companion folders. `enabledOn` is only meaningful for a plugin item: which devices'
    enabled-plugins list carries it (`undefined` = `"all"`). The `app` item's `settingsFile` covers
    the whole `app.json` — one plain single-file item like any other, with no separate carrier or
    shared mode.
  - `customGroups: CustomGroupConfig[]` (= `SyncGroup[]`) — freeform Advanced-tab rules ("Custom
    rules" and adopted "Discovered files") with no owning registry item; compiled by
    `compileCustomGroups` (see `core/registry.ts` above) alongside the registry-driven groups.
  - `bratPluginIndex`, PKM mode, run-history config, remotes, ribbon/status-bar toggles — unchanged
    by the unified-card work.
  - Written through Obsidian's `saveData` (never externally, to avoid a reload); `main.ts`'s
    `recompile()` recomputes `compiledGroups` from `items`/`customGroups` after every save (see the
    Connector section above) — nothing here is itself a `SyncGroup[]`.
  - **Load-time shape normalizer** (`core/settingsMigration.ts`'s `mergeLegacyAppSliceItems`,
    v2-internal, distinct from the schema-gate above): a `data.json` still carrying the pre-merge
    `items.editor`/`items["files-links"]`/`items.other` cards or a top-level `appJson` field has
    them merged into `items.app` on load — `enabled` ORs across the three, `rules`/`perItem` union
    first-seen-wins in `editor → files-links → other → appearance` order (picking up appearance's
    borrowed `showInlineTitle` rule too), `settingsFile.mode` falls back to the old `appJson.mode`
    (default `fields`) — then the merged shape is saved once.
- **`store.lock.json`** — capture metadata: `capturedAt` + per-group `sourcePluginVersion` (plugin
  items) or `sourceAppVersion` (Obsidian/core items).
- **`store/`** — the mirrored content: `configdir/…` (device-independent mirror of the config
  dir) plus vault-root dotfiles with the leading dot stripped. A file group with `desktop`/
  `mobile` field rules also carries a same-class sidecar next to its store copy —
  `<storePath>.__scopes__.desktop.json` / `.mobile.json` — holding that class's own-class keys as
  a flat object (desktop/mobile + `encrypted: true` stores CIPHERTEXT there instead of the raw
  value); only same-class devices write or delete their own sidecar, and Apply merges it over the
  base (see `core/modes.ts` above). A Plain-mode item with `fileRule.encrypted: true` stores its
  entire store copy as one encrypted envelope (same crypto primitive as `mode: "encrypted"`,
  applied to the whole file instead of per field).
- **`run-history.json`** — the local-only run log (path/size/retention configurable).

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
- **Lint** — `npx eslint .`, held at a **57-warning baseline / 0 errors** (two "BRAT"
  sentence-case false positives are kept without `eslint-disable`; product terms like
  "Sync Center" pass via the sentence-case rule's `ignoreWords` in `eslint.config.mts` —
  never via inline disables, per repo convention).
- **No hardcoded colors** — `scripts/check-no-hardcoded-color.sh`; all CSS uses Obsidian theme
  variables, with `body.is-mobile`/`body.is-phone` scoping for touch.
- **Live checks** — drive a dedicated dev vault via **obsidian-cli**, which routes by CWD, so run
  from `dev/vault/` (never a real vault).
- **Build** — `npm run build` = `tsc -noEmit` + esbuild production bundle.

## Current state & how to resume

- The version in `manifest.json` is the source of truth for the current release; older releases'
  history is retained on GitHub.
- **Parked backlog** (deferred by the maintainer — don't start without an explicit pick):
  1. UI audit polish — `design/DESIGN.md` §6 (remaining: three undecided TS-only classes,
     micro font sizes, text-on-fill variable split, border-radius tiers, the shared `-fpill`
     class; dead-CSS and emoji-remnant findings are resolved).
  2. Capture/pull interruption robustness (crash-marker vs full atomicity — direction undecided).
  3. Run-history file diffs (unified diff per changed file, with a size cap).
- **Release flow**: `npm version <x.y.z>` (bumps `manifest.json`/`versions.json`, commits, tags)
  → `git push --follow-tags` → CI builds a **draft** GitHub release with the three assets →
  hand-write the release notes → publish (the directory and BRAT only see published releases).
