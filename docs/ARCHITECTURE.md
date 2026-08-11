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
  (strip/encrypt), writes changed files under `store/`, and stamps source versions plus each touched
  item's own capture time and content hash into `store.lock.json` — carrying forward lock entries
  for groups outside this vault's compiled registry, whose store content only pulls (not local
  flows) manage.
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
  fieldOverlay consumer can't silently bypass whole-file encryption. `backfillLockLabels(groups,
  plugins, lock, carrierLists)` heals the local `store.lock.json`'s `label` field for every entry
  this device can resolve a display name for (installed community plugin manifest name / core
  plugin name), plus `memberLabels` on the two carrier entries (`core-plugins`/`community-plugins`
  — id → name for every list member this device can resolve); the carrier heal MERGES additively
  against the CURRENT store list per id (a freshly-resolved name wins, otherwise the existing
  entry's name survives, an id no longer listed is dropped) so no device's heal can erase a name
  only some OTHER device could resolve. Runs at the tail of every capture and once on startup when
  something resolvable is stale; write-only-on-change, `capturedAt` never touched (a heal is not a
  capture). `hotApplyAppearanceFamily(ctx, results)` runs at the end of both `apply()` and
  `applyWithActions()`: when a run wrote/deleted a file in the appearance family (`appearance`,
  `themes`, `snippets`, `enabled-css-snippets`), it calls the injected `PluginHost.reloadAppearance()`
  once — re-reading `app.json`/`appearance.json` into memory and re-applying the theme/snippets to
  the running app — so those items land live instead of needing an app reload; success clears
  `needsAppReload` on the family's results, a thrown failure keeps it set and pushes an honest warn
  note (no silent fallback). Whole-file/field encryption reuses the existing store envelope
  byte-for-byte when `fileUnchanged`/`fieldUnchanged` (crypto.ts) say the plaintext hasn't actually
  changed — captured twice over unchanged content is byte-stable output, and only a genuinely
  changed value produces a fresh envelope; the capture-preview diff goes through the same path, so
  it never shows an unchanged encrypted field as touched.
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
  carrier)` projects each plugin item's `enabledOn` (only `desktop`/`mobile` now — a stored `"local"` is ignored; the explicit **This device** choice lives in the device-local `localMembers` set instead, see Data model) into the carrier's per-element scope map, unioned with `localMembers`, which
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
  single Pull instead of nagging. **How it compares** (spec §6): **the items answer first**, each
  remote entry weighed **key by key, never `JSON.stringify`** — key order, in the known block or in
  the carried tail, can no longer read as a difference. Three rules narrow what counts: `label` /
  `memberLabels` are display and never count (a plugin renamed on one device is not something to
  Pull); `capturedAt` is freshness, so it ORDERS two differing entries rather than being one more
  thing that differs; and **only keys present on BOTH sides are compared** — in a mixed fleet an
  un-updated device strips `version`/`capturedAt`/`hash` every time it pulls and the next capture
  here writes them back, and that churn must not surface as a false "the store has newer settings".
  A differing entry the LOCAL side captured at or after the remote's is not ahead — v1 had no
  per-item date, so every difference had to be read as "ahead", which is why a local capture used to
  light the hint up. **The store-level stamp speaks only where the items leave a gap** (no entries at
  all, or one carried forward from a build that never dated it — "dated" meaning a stamp `Date.parse`
  can actually ORDER by, since one it cannot read dates nothing): when every remote entry is present
  here and dated on both sides, the per-item evidence is complete and the stamp may not manufacture a
  difference the items deny. When it does speak it compares `lockLineage` — the LATER of a lock's
  `syncedWatermark` and its own `capturedAt` — never the bare watermark. That distinction is
  load-bearing, and getting it wrong was a live regression: an updated device's watermark stops
  moving on capture (lineage belongs to the pull) while a v1 lock's single stamp stands in for both
  and tracks whatever it last pulled, which is OUR `capturedAt` — so comparing the two directly made
  an older device that pulled from us and pushed back read as "newer" with zero content difference,
  in exactly the mixed fleet §6 exists to keep quiet. `checkRemote(localLock, reader, ignoreGroups)`
  keeps its cheap contract (the lock file, no store reads) and its `{state, remoteCapturedAt}` shape,
  but when BOTH locks are v2 it decides the state from the entries (`perItemRemoteState`) instead of
  one whole-store timestamp: a store merely older in clock terms whose items all match reads `same`.
  `ignoreGroups` is REQUIRED for the same reason `remoteLockAhead` takes one — a remote with
  `excludeSelf` never exchanges the self entry, so without it the per-item path resolves a direction
  from the one entry the two sides diverge on by design, and no Pull could ever clear the arrow. It
  falls back to today's timestamp comparison whenever per-item resolution cannot answer: either side
  at v1, no entries left to compare, a difference it cannot date, or the two stores ahead of each
  other in different items, which `RemoteState` has no word for. Per-item precision is also weaker
  for an encrypted item, which carries no `hash` and so is ordered by capture time alone — a
  same-content re-capture elsewhere still reads as newer. A remote lock whose `version` is higher
  than this build understands reports `unknown` (the state that already means "cannot be compared"),
  so the panel never invites a Pull that §4.3 would then refuse — no new `RemoteState`, no UI change.
  Direction for a changed group
  is a three-way comparison against this device's `core/ledger.ts` entry, never file mtimes or the
  lock's `capturedAt`: no entry → `never-synced` (apply-default, counts into `bucketCounts.down`);
  only the store side moved → `store-newer`; only the local side moved → `local-changed`; both
  sides moved, or neither (a scope/rule edit shifted the comparison lens) → `differs`, meaning
  specifically "changed on both sides since this device last synced". A comparison error still
  reports `differs` with a `message`. One case bypasses the three-way entirely: a group that is
  otherwise `in-sync` but whose store base still carries a top-level `scope:"local"` key it must
  never hold (`baseHasStaleLocalKeys`, the same predicate the capture guard purges by) reports
  `local-changed` regardless of the ledger, so the Sync Center offers a capture — which purges the
  base — and the next scan finds it clean and reads `in-sync` again. `statusForGroups` is IO-free with respect to the ledger — it
  takes the parsed `Ledger` and returns `{ statuses, updates }`; `main.ts` owns loading and
  persisting it (see Connector below). `remoteLockLabels(remoteLockJson)` extracts each group's
  `label` (and, for the two carrier groups, `memberLabels`) out of a remote's `store.lock.json`
  into a plain map on the compare result — malformed/absent input degrades to an empty map, never
  an error — feeding the display-name chain below.
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
  `custom`. `resolveHostStoredLabel`/`displayLabelForGroup` are the shared display-name chain every
  caller (row naming, remote-pane naming/sort, on/off-list narration, progress toasts) routes
  through, in priority order: the local manifest/custom-rule label → this device's own
  `store.lock.json` label → the group's own carrier's `memberLabels[id]` (for a
  `plugin-<id>`/core group with no lock-entry label of its own) → the def-name/bare-id fallback.
  The remote pane's `remoteLockLabels` (status.ts above) slots in as one more step, after this
  device's own label and before the carrier fallback, so a remote's label can never shadow this
  device's own.
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
  totals), the self pane (coldstart/adopt), the four fixed type sections (`renderTypeSection`,
  one object = one row, companion families dissolved into their parent's row), the unified card
  renderer (`renderUnifiedCard` — On apply/On capture/State, Files, Resolve, Runs on/After
  install/Enablement, Settings sync, More, Note), filters/search, the Leftover section, the
  sticky result strip, run History, the Remotes block (which renders the remote pane's diffs
  through the same type-section/family grammar as the main list), and Capture/Apply/Pull/Push
  actions. Row content is memoized once per render (`deriveRow`) so the section partition,
  filter-pill counts and row painting all read the same computed `Fate`/`FateInput` instead of
  re-deriving it per consumer. The card footer's single `⊘ Stop syncing` button (`renderStopSyncing`)
  opens a Menu (`buildStopSyncingMenu`, C-#45) rather than the confirm modal directly — **On this
  device** writes this device's own opt-out list in localStorage, brings the carried
  `deviceOptOuts` map in step for this device's id (see the data model below), and re-renders;
  **Everywhere…** opens the unchanged `StopSyncingModal`.
- `fateModel.ts` — the fate-sentence engine: `rowFate(FateInput): Fate` is the pure function
  behind every row's verdict (spec `2026-08-06-sync-center-unified-grammar-design.md` §3's verb
  table) — glyph (`↓`/`↑`/`—`/`⚠`), sentence, chips (`not installed here`/`desktop only`/
  `stays off`/`off here — your rule`/`on here — your rule`/`🔒 encrypted`/`your rule` — the last
  four are suppressed on an excluded row, C-#45 fix-rounds 2-3: run-consequence facts are moot
  once the item is ignored on this device; `desktop only`/`encrypted` stay, intrinsic facts),
  `stageable`, `turnsOn`, and `excluded` (C-#45 §7 — true for either exclusion cause,
  `optedOutHere` OR `excludedHere`; `panelModel.ts`'s `fateBucket` reads this field directly
  rather than re-deriving the cause). `optedOutHere` is checked UNCONDITIONALLY, before
  conflict/direction (fix-round 2 — spec §1's "renders inert" has no family-member-wins
  exception); `excludedHere` keeps its original C-#24 direction-null-only precedence. A direction
  whose assembled verb set comes out empty (nothing this run would actually change) degrades to
  the `nothingYet` presentation (`NOTHING_YET_SENTENCE` = "No settings yet") rather than staying a
  bare, action-less glyph — "a direction with no verbs" is unrepresentable by construction, not
  filtered out downstream. `effectiveFate` (panelModel.ts) layers a Resolve choice or a
  fallback-ladder enablement bridge on top without
  re-deriving the base fate.
- `SettingTab.ts` — the settings tab (General / Obsidian / Core plugins / Community plugins /
  Beta / Advanced / Remotes). `renderRegistryCards`/`renderItemCard`/`renderCardExpansion` are the
  ONE renderer for every `ItemDef` across the Obsidian/Core/Community/Beta tabs (`itemDefs()`
  filtered by section) — there is no per-kind branch left; a plugin's own card carries its
  enablement zone, so the old "Enabled community plugins"/"Enabled core plugins" aggregate rows
  and their dedicated Device-scope drawer are gone. A card's `data-search-anchor` is also the
  target of the Sync Center card's `More` deep link (same scroll-and-highlight path the search
  bar itself uses — one anchoring mechanism, not two). Advanced (custom rules / discovered files)
  still renders the legacy per-`SyncGroup` rule form, unrelated to the card renderer.
- `itemCard.ts` — pure render-model helpers for the card renderer (badges, zone presence, the
  Fields/Companion-folders row models, path/companion validation) so the card's logic is
  unit-testable without touching the DOM; `SettingTab.ts`'s renderers turn these models into
  elements, and `scopeCycle.ts` reuses the scope-cycle model (`SCOPE_ICONS`/`nextScope`/
  `scopeCycleTooltip`). Also exports `RUNS_ON_ICONS` for `MemberRule`'s five stops (`follows`/
  `desktop`/`mobile`/`always-here`/`never-here`), the icon vocabulary behind the Sync Center
  card's `Runs on` menu; the matching `RUNS_ON_LABELS` copy is a module-local const in
  `SyncCenterView.ts` (not exported from `itemCard.ts`).
- `scopeCycle.ts` — the shared click-to-cycle scope control (`renderScopeCycle`): one glyph that
  IS the state, a click advances it. Every Settings drawer scope cell renders through this one
  function. The Sync Center card's `Runs on`/`Settings sync` rows share the same glyph
  vocabulary through a different idiom instead — an icon trigger that opens an Obsidian `Menu`
  of the options rather than cycling in place (`renderCardIconMenuRow`, SyncCenterView.ts) — so
  the two surfaces read as one control language without sharing the click interaction.
- `actionIcons.ts` — the single source for the per-action Lucide icons + color classes
  (Capture/Apply/Push/Pull) reused across the panel, buttons, badges and History.
- `statusBar.ts` — pure segment model (`statusBarSegments`, `statusBarAriaLabel`) + a thin DOM
  renderer for the status-bar item; segments mirror the Sync Center header pills (↑/↓ from
  presented bucket counts, ⇡/⇣ from `remoteDirectionCounts`).
- `qualifierSearch.ts` — the `key:value` search shared by both search boxes: pure `parseQuery` /
  `matchesQualifiers` / `suggest` / `applySuggestion`, plus the `QualifierAutocomplete` DOM widget.
- `panelModel.ts` — the pure view-model layer over `fateModel.ts`, unrelated to the settings-tab
  card renderer above. `fateBucket(fate)`/`fateBucketCounts` derive the one `RowBucket`
  (`conflict`/`apply`/`capture`/`excluded`/`ok`/`none` — `excluded` added C-#45 §7, read off
  `Fate.excluded`, positioned after the stageable checks and before `nothingYet`) every consumer —
  section partition (active vs. the in-sync/excluded/no-settings folds), filter-pill counts,
  filter visibility, sidebar badges, header pills — reads, so a row can never disagree with itself
  across those surfaces. `TYPE_SECTION_ORDER`/
  `TYPE_SECTION_TITLES`/`typeSectionForRow` fix the four sections (Obsidian/Core plugins/
  Community plugins/Your folders — beta folds into Community, custom groups into Your folders);
  `sectionCountLabel` renders a section head's trailing `N` / `N of M`. `familyRollup` derives one
  family's fate from its parent + companion `GroupState`s (settings/folder verbs join, an
  Appearance override replaces them, any per-file conflict or split-direction membership becomes
  `⚠`); `mergeFamilyChanges`/`fileEntryFor` back the card's direction-aware Files rows.
  `remoteSections`/`foldCompanionEntries` bucket a remote's raw file diff into the same four type
  sections and fold companion diff entries into their parent, mirroring the main list in the
  remote pane; `onOffFlips`/`onOffNarrationLines` derive the pinned `On/off list` line's flip
  counts and capped/whole-list narration for a diverged `core-plugins`/`community-plugins`
  carrier. `showColdStartBanner(selfState, statuses, dismissed)` is the pure predicate behind the
  cold-start guidance banner (true while the plugin's own settings are pending adoption and at
  least one row still needs its first sync, unless dismissed) — separate from the self pane's own
  coldstart/adopt state, which speaks through `SelfSyncInfo.storePresent` instead (no store yet →
  pull-first guidance; a store present → the Adopt guide). `stagedPayload`/`effectiveFate` turn
  the checked, resolved rows into the actual apply/capture item lists and the Resolve-aware
  display fate. Older section-based helpers (`policyOptions`, `sectionForItem`,
  `stageableRow`) remain as the fallback ladder's plumbing for `After install`/`Enablement` when a
  plugin's on/off carrier isn't itself synced — the only context where a standalone
  outdated/disabled/not-installed section concept still applies.
- `reportContent.ts` — shared run-report rendering (the Sync Center strip and History detail);
  a strip's header reads any error as `✗ Applied with N issue(s)` (errored groups only),
  warnings-only as `Applied · N note(s)` on a success-toned frame, and a clean run as plain
  success — so a captured plugin version falling back to the latest stable reads as a note, never
  an error.
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
  settings field — see Data model below): `switchExceptions[group]` = local-scoped element ids (from `localMembers` ∪ disabled-card structural locals) ∪
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
  state settles back to `insync` so a future genuine cold start shows the banner again. `deviceId()`
  (C-#45, spec `2026-08-10-c-livetest-batch22-device-optout.md` §1) is the same primitive again,
  under `config-sync-device-id`: read-generate-persist in one call (not a separate `ensure*` step
  at load, since there is nothing to migrate into). It had to live outside `data.json` because a
  wholesale copy (git-tracked vault, remotely-save, manual copy) would otherwise let a bootstrapped
  machine inherit the source machine's identity — a `selfPresetRules` strip on a settings field only
  ever promises "not on THIS device's own next capture," never "immune to an inbound copy." Since
  C-#52 (spec `2026-08-11-data-model-hardening.md` §2) the opt-out it used to key is itself a
  localStorage entry, `config-sync-device-optouts` (`deviceOptOutGroups`/`saveDeviceOptOutGroups`,
  a JSON `string[]` of group names — any other stored shape reads as "nothing opted out" and is
  never thrown; parsed at most once per load, since it is read per row per render). `deviceId()`'s
  remaining readers are the two halves that still speak the old map's language:
  `absorbCarriedDeviceOptOuts` (load: this device's groups in the carried map join the localStorage
  list) and `setDeviceOptOut` (write: this device's id in that map is brought back in step).

**Brand assets**
- `assets/` — brand SVGs: `icon.svg` (24×24, `currentColor`, iconize-importable), `logo.svg`
  (256×256 README tile), `social-preview.svg` (1280×640 GitHub social card).

## Storage invariants

The two rules the whole data model answers to (spec
`2026-08-11-data-model-hardening.md` §1, stated here verbatim). Everything in **Data model** below
is an instance of one of them; the **Core invariants** that follow are the code-level consequences.

**Invariant I — where a datum lives.**
1. True only of THIS device, and defined by this device's identity → **localStorage** (same lifetime
   as the device id).
2. This vault's transport wiring (paths, remotes, credential references) → data.json under a
   locked-local preset (`selfPresetRules`).
3. The fleet's shared sync contract or preferences → ordinary data.json fields.
4. Provenance and freshness of store content → `store.lock.json`.

Corollary, testable: **no per-device datum may ride whole-document propagation, and no structure
keyed by `deviceId` may appear in data.json.**

**Invariant II — unknown ⇒ preserve.**
1. Unknown FIELDS are carried through untouched and written back as found — never dropped by a
   rebuild.
2. Unknown ENUM VALUES are ignored at the point of use; storage is not rewritten.
3. A document from a HIGHER version is refused with a clear message — never downgraded, never reset,
   never overwritten.
4. A device with no source of truth for a shared structure is a READER of it.

Corollary, testable: every persisted structure survives a round trip (parse → serialize) with
unknown fields intact.

Why they are written down rather than assumed: every clause has a live failure behind it. I.1 is
C-#52 (a `deviceId`-keyed map in data.json, erased by one `pull` + `adopt`). II.1 is the lock's
whitelist rebuild, which let one pull by an older device strip a newer device's fields and push the
loss on to the fleet. II.2 is `sanitizeMemberRules`, which deleted a value it did not recognise and
saved immediately. II.3 is the settings gate that read a NEWER document as legacy and reset it.
II.4 is `refreshBratIndex` on a device with no BRAT list, wiping a fleet-shared index for everyone.

The invariants are stated as the rules the data model is held to, not as a claim that every site
already satisfies them. **II.4 is the one still partly open**: `refreshBratIndex`'s guard covers only
the empty case (`repos.length === 0`, spec §5.3), so a device that has ONE BRAT repo still prunes the
entries for the other nine when it writes — a partial source of truth acting as a full one. It fires
from the Beta tab's render with no user gesture behind it. Narrowing that guard from "knows nothing"
to "knows less than the index does" is follow-up work, not something this release did.

**I's corollary has one sanctioned exception, and it is not a bug to fix.** `deviceOptOuts` — a
`deviceId`-keyed map — is still in data.json on purpose (spec §2 ruling). Removing a field is a
two-phase change: a document written without it, adopted by a device still on the old build, takes
THAT device's opt-out with it, which is C-#52 again pointed the other way. So the datum this device
READS lives in localStorage, exactly as I.1 requires, and the map is carried alongside it as legacy
data — never read for a decision, this device's own entry kept in step, every other device's entry
untouched. The corollary bites on where a datum is read from; a field being phased out is cargo.
Phase 2 removes it once a localStorage-reading build is the fleet's floor (ledger C-#54's sibling).
Anyone "fixing" the carry before then re-opens the bug this release closed.

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
- **Device-local facts never enter the shared store; the store contract decides what is
  device-local.** The explicit **This device** choice lives in `localMembers` (stripped from the
  self store copy like `remotes`), never in `enabledOn`. On capture and comparison a group's
  `local` fields are stripped using the union of the local rule and the store contract's rule for
  that group (`withContractLocals` + `readStoreContractLocals`, applied identically to both sides so
  they can't desync) — an un-adopted device can't publish device-local values downstream; a contract
  `local` overrides a colliding local rule and promotes a plain-mode group to fields.
- **A datum true only of THIS device, and defined by this device's identity, lives in
  localStorage — no structure keyed by `deviceId` may appear in data.json.** The Stop-syncing
  menu's **On this device** rule was first built the other way (C-#45): a fleet-shared
  `deviceOptOuts` map, group name → the device ids that opted out, on the theory that a shared
  field is safe as long as each device only ever touches its own key. It isn't. `data.json`
  travels **wholesale** — a `pull` replaced the store copy with another device's, `adopt` landed
  that copy here, and this device's entry was simply gone (C-#52, reproduced from a live run).
  The rule now lives in `localStorage` under `config-sync-device-optouts`, keyed by nothing at all
  because a per-device document has no other devices in it; the same "per-vault, per-device,
  invisible to vault-wide sync" primitive `passphrase`/`loadBaselines`/`coldStartDismissed` use.
  The identity behind it (`main.ts`'s `deviceId()`) was moved out of `data.json` for the related
  reason that a wholesale copy would otherwise let a bootstrapped machine claim the source
  machine's identity — a `selfPresetRules` strip promises "not on this device's next capture,"
  never "immune to an inbound copy."
  **The old map is still in the document, and that is deliberate** (§2 ruling): deleting it would
  be a one-phase field removal, and a document written without it — adopted by a device still on
  the old build, whose self item preserves only `rootPath`/`remotes`/`localMembers` — takes THAT
  device's opt-out with it, which is C-#52's own failure inflicted by C-#52's fix. So the field is
  carried until a localStorage-reading build is the fleet's floor: localStorage decides every read
  here, other devices' entries pass through untouched, and this device's entry is kept in step so
  an un-updated device is never told something false about us. The invariant is about where a
  datum is READ from; a legacy field mid-phase-out is data we carry, not a home we use.
- **Enabled = loaded OR persisted** (`pluginRuntimeEnabled`). Reading `enabledPlugins` alone
  misclassifies a running-but-unpersisted plugin as disabled.
- **Self-apply never disables/reloads Config Sync.** Applying a plugin's settings cycles it
  off/on so it reloads clean — but `applyGroup` skips this for `config-sync` itself, or the run
  would reload the plugin and wipe the panel mid-run.
- **Lock model.** `store.lock.json` records each group's `sourcePluginVersion`/
  `sourceAppVersion`, and since v2 (spec `2026-08-11-data-model-hardening.md` §6) its own
  `capturedAt` and a `hash` of its store copy. **Freshness and lineage are two fields, not one.**
  The single `capturedAt` used to carry both meanings: "when this store was captured" (what
  `checkRemote` reads) and "the state we last aligned to" (what a pull set to the remote's value so
  `remoteLockAhead` would converge). Now `syncedWatermark` is the lineage — **only a pull moves it**
  — and `capturedAt` is derived, `max(groups[*].capturedAt)`, describing local content only. A pull
  recomputes it from the merged entries, floored at the value it already had (a pull is additive, so
  the store it produces can never be older than the one it started from); a capture stamps the items
  it touched and leaves the rest alone — as does a pull, for the one group whose store content it
  changed without adopting the remote's entry for it (a group the user kept as `local` whose
  remote-only files still landed): that entry is re-dated and re-fingerprinted, since a stamp that
  outran its content is precisely what the comparison below must never be handed. **A lock's lineage
  is never older than its own
  `capturedAt`** (`lockLineage`) — that is what makes a v2 lock and a v1 one, whose single stamp
  stands in for both meanings, comparable at all. Per-item `hash` is `"sha256:<digest>"` — the
  algorithm names itself so a later build can change it without readers guessing — and it covers the
  item's **WHOLE store copy**: for a file group the base file AND both `__scopes__` sidecars beside
  it, for a dir group every file under its store path. A sidecar is store content like any other (it
  holds a class's shared values and travels with the store), so a hash blind to it would let two
  stores differing only in a sidecar read as identical — a false NEGATIVE, and the comparison below
  believes an equal hash outright, so it would silently withhold a pull. Per-FILE hashing is
  `core/ledger.ts`'s canonical one, the same the direction baseline uses (switch lists as sets,
  everything else as bytes), so "equal" keeps meaning what "in-sync" means here. It is **absent,
  never blank, on an item whose store copy is ciphertext**, because every
  envelope carries its own salt and nonce and two devices holding identical settings hold different
  bytes. Those items are dated instead of fingerprinted. Capture computes the hash from the bytes it
  just wrote (the author's own bytes are what another device's capture of the same settings would
  produce; a historical formatting difference on disk is not); a pull, whose merged result exists
  nowhere but on disk, reads the store back through the same hashing rule. They can only disagree
  where the disk genuinely differs, and that direction is safe — it surfaces a pull, it never hides
  one. `parseStoreLock` (`core/manifest.ts`)
  validates the named fields and
  **carries every key it does not know** — per entry and at the lock's top level (spec
  `2026-08-11-data-model-hardening.md` §3.1). It used to rebuild each entry from a whitelist, and
  since the pull path writes the PARSED lock back, one pull by an older device stripped a newer
  device's fields and pushed the loss on to the fleet. **The writers carry the tail too**, or that
  parser is theatre: three sites build lock structures from fresh literals — capture's whole-lock
  build, capture's per-group entry rebuild, and the pull merge — and each lays its own computed
  fields OVER what it does not write (`lockTail` / `lockEntryTail`, `core/manifest.ts`) instead of
  replacing the structure. The known fields are still replaced, not merged, so a plugin that stops
  being desktop-only still loses its `desktopOnly` flag. The pull merge carries BOTH sides' unknown
  top-level keys, the local lock's winning a collision: a pull-then-push through this build would
  otherwise strip a newer build's field from the remote, which is the same loss one level up. It
  carries the local ENTRY's unknown keys the same way — an adopted remote entry wins every field it
  has (the content is the remote's, so its versions, capture time and hash describe it) but does not
  get to delete a key only we recorded, and keeping it is convergence-safe because the comparison
  only ever weighs keys present on both sides. Every writer emits fields in `parseStoreLock`'s own
  order, which is what makes the parser's fixed order worth keeping: a capture and a
  parse-then-write of the same lock produce the same bytes, so a round trip does not churn the
  vault's history. (`backfillLockLabels` is the exception — it appends `label`/`memberLabels` to an
  entry it heals, and the next parse normalises the order back.) The lock also carries its own format
  `version` (§4.3): absent = 1, today's shape, parsed and normalised as ever; every lock this build
  writes declares `STORE_LOCK_VERSION`. **The gate belongs to the store, not to "the remote":** the
  store lives inside the vault and the vault is synced by other tools, so a newer build on another
  device can leave a v3 lock here with no pull involved. All FOUR operations that write a lock check
  the version of the one they are about to replace, rather than overwriting it with this build's
  shape: capture and the pull merge against the LOCAL lock, pull and push against the REMOTE's —
  those four via `assertStoreLockVersionUnderstood` — and the startup label heal, which has no
  operation to abort and so refuses INSIDE `backfillLockLabels` with an inline `storeLockVersion`
  test on the lock it is asked to mutate: it reports no change, and its startup caller writes only
  when something changed. (Capture's own call to it discards that boolean, which is safe because
  capture already gated the same lock before touching anything.) The heal is the only lock writer
  that fires with no user action AND with `schemaStop` null — its trigger is a perfectly readable
  `data.json` — which is why it needs a gate of its own rather than the stop state's; it is
  deliberately not left to §3.1's carrying parser to make the round trip lossless, since that would
  rest the invariant on the parser instead of on the gate.
  `planImport` checks both locks as well, so a doomed pull is
  refused before the user is ever asked to resolve conflicts; the planner is a courtesy and
  `applyImport` stays the guarantee, re-reading the lock so it validates the bytes it is about to
  replace rather than the ones the planner happened to see. That refusal is not `checkRemote`'s `unknown` — an
  unreadable lock keeps today's tolerant behaviour, and a `version` that isn't a number reads as 1
  rather than stranding a fleet on a typo. (The 1.x one-slot apply backup at `<configDir>/config-sync-backup` is gone with the removed
  Revert feature; apply deletes a leftover copy.)
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
- **Schema v2 is a hard gate, not a migration — and a NEWER schema is refused, not reset.**
  `classifySettings` (`core/settingsMigration.ts`) answers `fresh` / `ok` / `legacy` / `future`
  against `CURRENT_SCHEMA`. `legacy` (the v1/v3-era `groups`/`memberScopes`/`memberLocal`/
  `appJsonTabs` shape, or anything unversioned) blocks with a `Notice` and starts from
  `DEFAULT_SETTINGS` — there is no field-by-field migration. `future` is the half that exists
  because the gate used to be `schemaVersion !== 2`: a document from a newer build took the legacy
  path, and since `data.json` travels between a user's devices wholesale, one updated device could
  reset — and then, at the next save, overwrite — the setup of every device that hadn't updated
  yet (spec `2026-08-11-data-model-hardening.md` §4.1, invariant II.3). It now sets `main.ts`'s
  `schemaStop`, leaves the file untouched, and says so once at load through the same `Notice` the
  legacy branch uses — a device that has silently stopped syncing must be visible without the user
  going looking (§4.2b). **While it holds, this build writes nothing another device can see, and
  nothing derived from the document it cannot read**; a writer that appears on no list is refused
  rather than exempt. Refused: `saveSettings`, and `settingsWritable()` ahead of it — every settings
  writer is mutate-then-save, so a save-time refusal would arrive after the mutation and leave
  memory diverged from disk with no recompile; capture / apply / pull / push / adopt at the Sync
  Center host boundary; `stopSyncing` and `deleteLeftoverStoreFiles`, which delete store content
  before any settings write could refuse for them and choose files through a `compiledGroups`
  compiled from the misread document — both answer `null` for "refused", never `[]`, so a caller
  cannot record a refusal as a completed action; `appendActionHistory` and `appendRunHistory`, which
  have the last word on that; `setDeviceOptOut`, which since §2 lives in localStorage and no longer passes the
  `saveSettings` choke point at all; `refreshBratIndex`; the startup lock-label heal in
  `refreshLocalStatus`; and `saveBaselines` — per-device localStorage no other device sees, but
  computed from that same misread `compiledGroups`, so writing it records a fiction that direction
  is later decided from. Deliberately NOT refused: this device's scratch preferences that read
  nothing from the document — the passphrase, the cold-start dismissal, clearing the run history on
  request. The background paths (`saveBaselines`, the heal, `refreshBratIndex`) read `schemaStop`
  directly instead of through `schemaStopped()`: they are timer- or render-driven, with no user
  gesture to raise a notice about. The refusal itself is never suppressed, but a REPEAT of its
  notice inside `REFUSAL_NOTICE_WINDOW` is: the settings tab's text fields refuse per keystroke, and
  a notice per character is worse than silence. **A flow that will be refused refuses before it
  opens** — pull before the conflict modal, Stop syncing before its own — and a refused gesture
  never moves the settings tab's drafts either, or the panel would show a delete that did not
  happen (the Advanced tab gets this from `commitDraft`, which keeps its draft whenever the write
  throws; the remotes list guards its structural gestures directly). The Sync Center states the
  refusal in the cold-start banner's structure with no action (`schemaStop()` on `SyncCenterHost`).
  The **same gate runs before the write**, not only at load (§4.2): adopt/self-apply writes the
  store's `data.json` onto this device and only then reloads, so `applyGroup` classifies the
  incoming document (`isFutureSchemaDocument`) while the local file is still intact and fails just
  that item, byte-identical, through the ordinary run-result path.
- **A direction with an empty verb set is unrepresentable.** `fateModel.ts`'s `rowFate` degrades
  any apply/capture direction that would otherwise render with zero verbs into the nothing-yet
  presentation (unstageable, `— No settings yet`) rather than a bare, action-less glyph — every
  bucket/filter/select-all consumer reads the same degraded fate, so none can disagree.
- **Unchanged encrypted content reuses its existing envelope.** Capture only re-encrypts a field
  or whole file whose plaintext actually changed (`fieldUnchanged`/`fileUnchanged`, crypto.ts);
  repeated captures over unchanged content are byte-stable, and the capture-preview diff goes
  through the same check, so it never shows an untouched credential as changed.

## Data model

Four storage homes, one per clause of invariant I above, and a datum belongs to exactly one:

| Home | What lives there | Why not elsewhere |
|---|---|---|
| **`localStorage`** (per vault, per device) | the device id, the sync baselines, the passphrase, the cold-start dismissal, the **On this device** opt-out list | true only of THIS device and defined by its identity; `data.json` travels wholesale, so a shared field keyed by device id is erased by one pull + adopt |
| **`data.json`, locked-local preset** (`selfPresetRules`) | `rootPath`, `remotes` (with their `tokenId` names), `localMembers` | this vault's transport wiring — it is in the document, but stripped from the document's own store copy so it never reaches another device |
| **`data.json`, ordinary fields** | `items`, `customGroups`, `memberRules`, `bratPluginIndex`, PKM mode, run-history config, ribbon/status toggles | the fleet's shared sync contract: every device is meant to converge on it |
| **`store.lock.json`** | per-item source versions, labels, `capturedAt`, `hash`; the store's own `version` and `syncedWatermark` | provenance and freshness of store CONTENT, which is a fact about the store, not about the settings that produced it |

- **`data.json`** (`ConfigSyncSettings`, plugin settings, `schemaVersion: 2`) — what syncs and how,
  compiled to `SyncGroup[]` on every load/save; there is no separate hand-edited manifest file
  anymore (the old `config-sync.json` at `<store root>/` is legacy and only ever read to detect a
  pre-v2 install — see the schema-gate invariant above). Fields:
  - `items: Record<string, ItemConfig>` — one entry per registry item id (`app` / `appearance` /
    `hotkeys` / `core:<id>` / `community:<id>`). `ItemConfig = { enabled, settingsFile?,
    companions?: ItemCompanion[], enabledOn?: RuleScope }`. `settingsFile = { customPath?, mode:
    "plain" | "fields", fileRule?: FileRule, rules: Record<string, ItemFieldRule>, perItem:
    Record<string, PerItemScopes> }` (`ItemFieldRule = Omit<FieldRule, "pattern">` — the map key IS
    the pattern, so there is exactly one source of truth for which key a rule governs).
    `companions?: { path, scope: DeviceClass, enabled }[]` — preset (`themes/`, `snippets/`) plus
    user-added companion folders. Optional since spec `2026-08-11-data-model-hardening.md` §5.2,
    **readers only**: absent means none and every read is `?? []`, but the empty array is still
    WRITTEN at every construction site — `emptyItemConfig()` and `itemConfigForWrite()`
    (`core/registry.ts`), the base every writer (`SettingTab.updateItem`, `setItemSyncEnabled`,
    `setItemFileScope`, `itemConfigWithEnabledOn`, `clearMemberEnabledOn`, `applySyncAll`, adopt's
    self-item enable, `stopSyncing`) starts from; a stored entry that arrives WITHOUT the key gets
    it back on the first write. One writer does NOT go through that base and must be changed by
    hand: `mergeLegacyAppSliceItems` (`core/settingsMigration.ts`) builds `items.app` from its own
    object literal, `companions: []` included — the site a phase-2 sweep is most likely to miss.
    Dropping a field is a two-phase change — a build that reads `cfg.companions`
    unguarded (2.20.0's `compileCompanions`/`parentCardLabel`/`buildCompanionRows`) throws on a
    document without it, and our own rule against destroying what a device cannot read applies to
    our own past builds. Phase 2 (ledger C-#54) stops writing it at every site at once, once a
    tolerant build is the fleet's floor.
    `enabledOn` is only meaningful for a plugin item: which devices'
    enabled-plugins list carries it (`undefined` = `"all"`). It stores only `"desktop"`/`"mobile"`
    now — the **This device** choice moved to the top-level `localMembers` (below), and
    `drainEnabledOnLocal` migrates any legacy `enabledOn:"local"` on load (and after adopt). The `app` item's `settingsFile` covers
    the whole `app.json` — one plain single-file item like any other, with no separate carrier or
    shared mode.
  - `localMembers: string[]` — device-local set of plugin item ids (`community:<id>`/`core:<id>`)
    the user pinned to **This device**. A locked `selfPresetRules` local strip keeps it out of the
    shared self store copy (like `remotes`/`rootPath`), so the choice never travels and a pull can't
    erase it; `enabledOn` no longer carries `"local"`.
  - `memberRules: Record<string, MemberRule>` — the Runs-on menu's stored rule (`all`/`desktop`/
    `mobile`/`always-here`/`never-here`) per plugin item id; fleet-shared (not stripped), applied
    identically on every device that pulls it — `always-here`/`never-here` force a member on/off
    regardless of the shared switch-list content, they are not keyed by a specific device. A value
    this build does not recognise — what a NEWER build's rule looks like from here — is ignored
    where it is consumed (`availability.ts`'s `asMemberRule`, read by `memberRuleFor` /
    `memberRulesFor`) and left on disk untouched. The load path used to drop it and save
    immediately, which turned the future's data into a deletion this device published to the whole
    fleet on its next capture (spec `2026-08-11-data-model-hardening.md` §3.2).
  - `deviceOptOuts?: Record<string, unknown>` — **carried, not owned** (spec
    `2026-08-11-data-model-hardening.md` §2 and its ruling). The Stop-syncing menu's **On this
    device** rule used to live here, group name → the device ids that opted out, until C-#52; the
    authority is now `localStorage`'s `config-sync-device-optouts` and nothing reads this field to
    decide anything. It stays in the document for the devices that have not updated yet: they read
    this map and nothing else, and a document written without it wipes their own opt-out when they
    adopt. `loadSettings` reads this device's groups out of it into localStorage and writes nothing
    (`absorbCarriedDeviceOptOuts` — no deletion, no save, no drift); `setDeviceOptOut` writes
    localStorage and then updates THIS device's id inside the map (`withDeviceOptOut`), leaving
    every other device's entry byte-for-byte. The value type is `unknown`, not `string[]`, and
    `withDeviceOptOut` narrows at the seam the way `asMemberRule` does: a group whose value is not
    an array — what a build we do not know might have written — is carried untouched rather than
    edited, even at the cost of not publishing this device's own entry for that one group
    (localStorage still decides every read here). Typing it `string[]` would be a lie at the JS
    boundary, and it is the lie that let a string spread into characters and destroy another
    device's entry. Optional and absent from `DEFAULT_SETTINGS` — a
    document that never had the field only gets it if this device has an opt-out to publish, and
    once present it is never deleted. Phase 2 (once a localStorage-reading build is the fleet's
    floor) stops writing it. A group in the localStorage list is excluded
    from THIS device's runs (capture/apply payload assembly and the capture lock-label heal both
    skip it) while its row stays visible, rendering exactly like a devices-class-excluded row
    (`groupExcludedHere`/C-#24) — same glyph/sentence/chip, a distinct card clause
    (`FateInput.optedOutHere`, `fateModel.ts`/`SyncCenterView.ts`'s `stateClauseText`).
  - `customGroups: CustomGroupConfig[]` (= `SyncGroup[]`) — freeform Advanced-tab rules ("Custom
    rules" and adopted "Discovered files") with no owning registry item; compiled by
    `compileCustomGroups` (see `core/registry.ts` above) alongside the registry-driven groups.
  - `bratPluginIndex`, PKM mode, run-history config, remotes, ribbon/status-bar toggles — unchanged
    by the unified-card work. `bratPluginIndex` is a REPLICATED index, not a cache: a device with
    no BRAT of its own still needs it to install beta plugins, so only a device that HAS a BRAT
    repo list writes it (`refreshBratIndex` returns without saving on an empty list — its fill+prune
    would otherwise let the device that knows least wipe the index for everyone, spec
    `2026-08-11-data-model-hardening.md` §3.3). Everyone else reads. The guard stops at the EMPTY
    list: a device with one repo still prunes the rest on write, which invariant II.4 says it should
    not — see the note under Storage invariants above.
  - Written through Obsidian's `saveData` (never externally, to avoid a reload); `main.ts`'s
    `recompile()` recomputes `compiledGroups` from `items`/`customGroups` after every save (see the
    Connector section above) — nothing here is itself a `SyncGroup[]`.
  - **Load-time default fill** (`core/settingsMigration.ts`'s `withDefaults`): the stored document
    is merged onto `DEFAULT_SETTINGS` recursing into the nested defaults (`runHistory`,
    `ribbonButtons`), so a field added inside one of them still gets its default on an older
    document; a stored value always wins, and unknown fields — top-level and nested — are carried
    through untouched.
  - **Load-time shape normalizer** (`core/settingsMigration.ts`'s `mergeLegacyAppSliceItems`,
    v2-internal, distinct from the schema-gate above): a `data.json` still carrying the pre-merge
    `items.editor`/`items["files-links"]`/`items.other` cards or a top-level `appJson` field has
    them merged into `items.app` on load — `enabled` ORs across the three, `rules`/`perItem` union
    first-seen-wins in `editor → files-links → other → appearance` order (picking up appearance's
    borrowed `showInlineTitle` rule too), `settingsFile.mode` falls back to the old `appJson.mode`
    (default `fields`) — then the merged shape is saved once.
- **`store.lock.json`** — capture metadata. Top level: an optional `version` (the lock's own format
  version; absent = 1, this build writes `STORE_LOCK_VERSION` = 2 — see the Lock model invariant for
  what a higher one means), an optional `syncedWatermark` (the lineage, moved only by a pull;
  absent = a v1 lock, whose `capturedAt` answers for it), and `capturedAt`, which since v2 is
  DERIVED — `max(groups[*].capturedAt)`, describing this store's own content. Per group:
  `sourcePluginVersion` (plugin items) or `sourceAppVersion` (Obsidian/core items); an optional
  `capturedAt` (when THIS item was captured) and `hash` (`"sha256:<digest>"`, a fingerprint of its
  WHOLE store copy — base plus `__scopes__` sidecars, or every file under a dir group's store path —
  absent for ciphertext); an optional `label` (this device's best-resolved display name for the
  group) and, on the two carrier entries only, an optional `memberLabels: Record<string, string>`
  (element id → display name for the on/off list's members) — the labels healed in place by
  `backfillLockLabels`. Every field beyond `capturedAt`/`groups` is absent in a legacy lock and
  optional here, so a v1 lock is fully readable and an older build keeps parsing a v2 one: the two
  version fields stay FLAT next to the rest precisely because `manifest.ts`'s entry validator makes
  an older reader throw on an entry with neither, which is what a restructured entry would look like.
  The v2 fields are declared on the types but read through `manifest.ts`'s narrowing helpers
  (`storeLockVersion`, `lockWatermark`, `lockEntryCapturedAt`, `lockEntryHash`) rather than off the
  parsed object — they ride the carried tail and are never validated on the way in, deliberately: a
  value this build cannot make sense of must survive untouched (invariant II.1) rather than be
  dropped by a normalising parse, and must not be acted on either.
  **`storeLockVersion` reads a lock this build already parsed, so it can only report a version
  whose file we could read.** A REFUSAL gate must ask `declaredStoreLockVersion(raw)` on the raw
  text, before parsing — that is `assertStoreLockVersionUnderstood`'s whole shape, and final-review
  C1's finding: a future v3 that restructures an entry makes the parse throw, so a gate downstream
  of it never runs, the refusal is skipped, and capture writes `version: 2` over the newer
  bookkeeping and pushes the loss to the fleet. The one sanctioned gate that reads a PARSED
  version is `backfillLockLabels`' inline check: it already holds a parsed lock and is declining to
  WRITE, not deciding whether the store may be read at all. Copy that pattern only in that
  position.
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
- **Lint** — `npx eslint .`, held at a **58-warning ceiling / 0 errors** (two "BRAT"
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
