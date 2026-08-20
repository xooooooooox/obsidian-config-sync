# Architecture

How Config Sync is built — a map for maintainers and future contributors. For the **UI** design
system (tokens, components, conventions) see [design/DESIGN.md](design/DESIGN.md); for the
**per-feature** history and rationale see [superpowers/specs/](superpowers/specs/). This document
maps the code and states the invariants; it does not recount those.

**Contents:** [Overview](#overview--three-layers) ·
[Module map](#module-map-src) ·
[Storage invariants](#storage-invariants) ·
[Core invariants](#core-invariants) ·
[Data model](#data-model) ·
[How to extend](#how-to-extend) ·
[Testing & gates](#testing--gates) ·
[Current state & how to resume](#current-state--how-to-resume)

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
  `pushExternal`. `planImport(ctx, reader, opts: { skipRefs: ItemRef[] })` and
  `pushExternal(ctx, writer, opts: { skipRefs: ItemRef[] })` both take an explicit options param
  (no default). `skipRefs` is a set of ItemRefs — the items that do not travel in that direction with
  that remote, computed by `core/remoteRules.ts`'s `refsBlockedFor(remote.items, "pull" | "push")`.
  `skipRelPredicate(skipRefs, ...groupLists)` turns it into a per-rel test: a rel belongs to a skipped
  item when its owning group's ref (`resolveGroupByStoreRel`) is in the list, with
  `isSelfStoreRel(rel)` (exported next to `SELF_STORE_DATA_REL`) as the self item's fast path — the
  one ref whose rels are known without a group lookup, so it still answers while a device's own
  registry is empty. `planImport` drops those rels from both file maps before `classifyMerge` and
  carries `skipRefs` on the `PendingPull` so `applyImport` skips the same lock entries;
  `pushExternal` skips them in its write loop — and exempts them from the mirror-delete loop too, so
  the remote's own copy of a withheld item is never deleted even though it's absent from the local
  push set. `remoteGroupsFrom(ctx, reader,
  files)` resolves the remote's sync list from its self store copy — schema v1 copies carry a
  compiled `groups` array; v3 copies carry nested `items` and compile through the injected
  `CoreContext.storeListGroups` hook (main.ts wires `storeSelfCopyGroups` with the plugin's
  registry defs). A **v2** copy is migrated IN MEMORY first (`core/v2Migration.ts`) and nothing is
  written back: for the whole transition window the store is still being written by devices on
  2.21.0, so reading a v2 self copy is the normal case, not an edge one, and reading it as `[]`
  would make the self pane report every item as added, offer other devices' store files as
  deletable leftover, and switch off the store-contract this-device strip. `applyImport`'s lock merge attributes identical files two-sidedly
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
  plugins, lock, carrierLists)` heals the local `store.lock.json`'s `display.label` for every entry
  this device can resolve a display name for (installed community plugin manifest name / core
  plugin name), plus `display.elements` on the two carrier entries (`core-plugins`/`community-plugins`
  — id → name for every on/off-list element this device can resolve); the carrier heal MERGES additively
  against the CURRENT store list per id (a freshly-resolved name wins, otherwise the existing
  entry's name survives, an id no longer listed is dropped) so no device's heal can erase a name
  only some OTHER device could resolve. Runs at the tail of every capture and once on startup when
  something resolvable is stale; write-only-on-change, `capturedAt` never touched (a heal is not a
  capture). **The startup heal never changes a lock's FORMAT**: it runs only on
  a lock whose declared version is exactly the one this build writes, and leaves a v1, v2 or v4+ lock
  byte-identical. Writing a v1/v2 lock back in v3 shape under its old `version` produces a hybrid a
  2.21.0 peer neither refuses (it reads `2`) nor parses (it needs `groups`) — it reads it as corrupt
  and its next capture rewrites the lock flat, destroying the v3 bookkeeping. A format upgrade is
  earned by a capture or a pull, never by a cosmetic fix to a display name; the visible cost is that
  a stale name in a v1/v2 store stays stale until one of those happens. `hotApplyAppearanceFamily(ctx, results)` runs at the end of both `apply()` and
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
- `core/types.ts` — **the vocabulary** (one concept, one word) and the shared types built from it:
  `SyncGroup`, `SyncManifest`, `StoreLock`, `GroupResult`, `FileChanges`/`hasChanges`, `Remote`,
  `SyncMode`. The word `scope` is forbidden here: it can mean the settings area, the item family or
  the sharing rule, so a consumer reading it cannot tell which. Each is its own named type:
  - `Sharing` — "who shares a value": `{ kind: "everywhere" } | { kind: "per-class"; class:
    "desktop" | "mobile" } | { kind: "this-device" }`. A union, not an enum, because the class only
    exists for one of the three answers; a flat enum would collapse two orthogonal questions into
    one list and force every consumer to special-case one member by hand. `FileSharing =
    Exclude<Sharing, { kind: "this-device" }>` makes a file-level `this-device` unrepresentable,
    since "don't sync it at all" is the item's own toggle, so no runtime guard is needed for it.
    Helpers: `EVERYWHERE`/`perClass`/`THIS_DEVICE`, `sharingClass`, `isThisDevice`, `sharingEquals`,
    and `asSharing`/`asFileSharing` for narrowing a value read off a document.
  - `StorageSection` (`obsidian` · `core` · `community` · `custom`) vs `Section` (those plus `beta`)
    — the STORED four and the PRESENTED five. `beta` is an install source derived at runtime from
    each community item's own `bratRepo` field (`core/bratIndex.ts`'s `bratRepoIndex`), never a
    storage key; `registry.ts`'s `storageSection` is the one bridge between the
    two. `ItemRef = ${StorageSection}/${ItemId}` with `itemRef`/`parseItemRef` — built from
    `StorageSection` on purpose, so a classification can never leak into an identity.
  - `FieldRule = { pattern, sharing: Sharing, encrypted: boolean, locked? }` — sharing and encrypted
    combine freely (`this-device` + `encrypted: true` is the one illegal combination, rejected by
    `manifest.ts`). `FileRule = { sharing: FileSharing, encrypted: boolean }`, where `encrypted:
    true` means the ENTIRE file is stored as one encrypted envelope, not per-field.
    `PerElementSharing = Record<string, Sharing>` — per-element sharing for a string-array key
    (`SyncGroup.perElement: Record<string, PerElementSharing>`), generalizing the old
    switch-list-only per-element rule to any string-array key; governed exclusively by
    `core/perElement.ts`, never by the key's own `FieldRule`.
- `core/perElement.ts` (was `perItem.ts`) — `capturePerElementArray`/`applyPerElementArray`:
  per-element merge for a `PerElementSharing`-governed array key — captures each element by its own
  sharing rule (this-device elements never enter the store; per-class elements go through the same
  partition as class field rules) while preserving the other device's already-captured elements,
  since the array is one shared list, not a per-device sidecar.
- `core/enablementRules.ts` — the fleet layer of enablement: one `Sharing` per list element, stored
  on the item that CARRIES the list (`ruleHomeFor`: the two plugin lists carry their own, and the
  snippet list is a field of `appearance`, so `appearance` carries it) under
  `settingsFile.perElement[<key>]`, `key`
  from `switchList.ts`'s `perElementKeyFor`, the derived key's one producer. `enablementRules`/
  `enablementRuleFor` read, `withEnablementRule` writes (pure — an `everywhere` write CLEARS the
  entry rather than storing the default, so a round trip through the control leaves `data.json`
  byte-identical). Storage is uniform across the three lists; APPLICATION is not and must not be —
  `community-plugins.json`/`enabled-css-snippets` are string arrays and go through `perElement.ts`,
  while `core-plugins.json` is a `Record<string, boolean>` and goes through `switchList.ts`'s own id
  masking — and that split lives at the runtime seam (`main.ts`), never here.
- `core/deviceElements.ts` — the local layer: which on/off-list elements THIS device has taken out
  of the shared answer, and what it decided for them. Lives in `localStorage`
  (`config-sync-device-elements`) and nowhere else — a datum true only of this device stored
  in a document that travels wholesale is a datum a pull erases (invariant I.1's live failure). Shaped like
  `data.json`'s `perElement` (list id → element id → state) so a reader holds one mental model for
  both layers; only the value differs, `"on" | "off"` rather than a `Sharing`. `parseDeviceElements`
  tolerates any unreadable shape as "no exception here" (never a load failure, the same discipline
  `deviceOptOutGroups` follows), and `deviceElementState`/`withDeviceElement` are the one reader and
  one writer.
- `core/deviceFields.ts` — the local layer's sibling for per-key rules: which of an item's own
  rule PATTERNS THIS device has taken out of sync, keyed `ItemRef → pattern → "not-synced"` (one
  state only — a key is either following the shared rule or excepted, no on/off pair to choose
  between). Lives in `localStorage` (`config-sync-device-fields`) and nowhere else, same reasoning
  as `deviceElements.ts` above. Keyed by the rule's PATTERN, verbatim as `settingsFile.rules`
  spells it, not an expanded key name, so excepting a `plugins.*` rule excepts every key it
  matches, today or after the document gains a key tomorrow. `parseDeviceFields` is tolerant the
  same way `parseDeviceElements` is; `deviceFieldExcepted`/`withDeviceField` are the one reader and
  one writer, and `fieldExceptionsByGroupName` re-keys the table from `ItemRef` to the group name
  every capture/apply/compare call site already holds — the bridge into `CoreContext.fieldExceptions`.
  Capture's own use of the exception is the **preserve-not-strip** rule (Core invariants below).
- `core/enablementDecision.ts` — the precedence: given a list element's fleet rule, this
  device's own exception for it, and this device's class, what a run does. One function,
  `decideEnablement`, first match wins — replacing four separate derivations
  (`memberLocalIdsFor`/`memberForceOffIds`/`runsOnForces`/`preferStoredRunsOn`) that used to
  disagree about whether a local choice survives a pull — which is exactly how the
  invariant-I.1 failure happened.
  Outputs `{ masked, force }`: `masked` joins `switchExceptions` (capture passes it through
  untouched, apply keeps this device's own state); `force` on top of that writes the state outright,
  `null` meaning "leave whatever is on disk." A `this-device` rule with no exception masks WITHOUT
  forcing — the element is this device's own business, and pass-through already says that; a force
  there would be this build deciding something the user never said.
- `core/v4Migration.ts` — the v3 → v4 migration, the one piece of code that will ever read
  a v3 `data.json` again; see the migration chain note in Data model below for what it does.
- `core/itemKeys.ts` — the ONE key space. The store lock, the device-local baselines
  and the device-local opt-out list are all keyed by `ItemRef`, and the compiler is its only
  producer. `companionRef(owner, basename)` keys a companion under its owner
  (`obsidian/appearance/themes`) — it has no identity of its own, so owner-relative keying makes its
  uniqueness structural instead of enforced; `carrierRef(list)` keys the two on/off-list carriers as
  `obsidian/<list>`, whose id space is closed and declared in code, so a carrier key cannot collide
  with an item by construction. No item id contains `/`, so the segment count reads the kind: two =
  item or carrier, three = companion. `lockRefFor(groups)` resolves a v1/v2 lock's group NAME to a
  ref — the compiled index first, then a closed set of legacy rules; anything it cannot place is kept
  under `legacy/<name>`, a section deliberately outside `StorageSection` so `parseItemRef` refuses it
  and no reader can resolve it. Dropping such an entry would read as never-synced, which defaults to
  APPLY. `groupRefIndex`, `refItemId`, `isLockRef`, `rekeyRefList`, `OBSIDIAN_CARD_IDS`.
- `core/v2Migration.ts` — the one-way v2 → v3 conversion, run once on load and saved once:
  `items["community:x"]` → `items.community.x`, `customGroups[]` → `items.custom[name]` (`type:
  "dir"` → `"folder"`), `memberRules` + `enabledOn` → `runsOn`, `localMembers` → `thisDeviceItems`
  (re-keyed to refs), every rule's `scope` → `sharing`, `perItem` → `perElement`,
  `companions[].scope` → `.device`, `bratPluginIndex` → `bratIndex`. It re-creates the two v2
  normalizers the type change removed (`mergeLegacyAppSliceItems`, `drainEnabledOnLocal`) and reads
  the carried `deviceOptOuts` map one last time (`deviceOptOutsFor`) before dropping the field.
  Unknown fields ride through, including on `customGroups` entries.
- `core/lockLabels.ts` — the stored-name chain (`lockStoredLabel`, `resolveHostStoredLabel`): a
  lock entry's `display.label`, then, for an on/off-list element that is never individually synced
  and so has no entry of its own, its CARRIER's `display.elements[id]`. Its own module because it
  needs `manifest.ts`'s lock accessors while its caller's other half lives in `catalog.ts`, which
  sits below `manifest.ts` — and one priority order split across two files is one that can be
  reordered in half.
- `core/registry.ts` — the item registry and its compiler, replacing the v3-era per-kind catalog
  rows (`app-view-*`, `appearance-domain`) with one flat list of `ItemDef`;
  `app.json` is one card.
  `buildItemDefs(env)` builds one `ItemDef` per card — the five Obsidian cards (`app` /
  `appearance` / `hotkeys` / `core-plugins` / `community-plugins`, fixed order from
  `OBSIDIAN_CARD_DEFS`; the last two are the on/off-list carriers, ordinary items since this
  release rather than a compile-time special case — see Data model below), every core plugin
  (including ones with no settings file yet, sorted by label) and every installed community/beta
  plugin (also sorted by label). An `ItemDef`'s identity is STRUCTURAL — `{ section, id }`, with `defRef(def)` /
  `defForRef(defs, ref)` as the ref's only minter and matcher — while `groupName` is carried as
  LINEAGE (a community item's compiled group is still named `plugin-<id>`; nothing reads meaning
  back out of it). `defsForForeignItems(defs, items, betaIds)` synthesizes a def for a stored
  community item whose plugin isn't installed here — every entry in `items.community` earns one,
  **`{synced:false}` included** — that entry's mere presence is this device's capture mask for the
  on/off-list element, and it is how a card the user turned off is turned back on.
  `defsForForeignItems`' `known.has(id)` guard (does `items.community` have an entry at all) is the
  whole test — an enablement rule lives on the CARRIER item, never on the plugin's own entry, so
  there is no entry shape that fails to earn a card.
  `compileItems(defs, settings)` is the ONLY place that turns `(ItemDef[], CompileSettings)`
  into the `SyncGroup[]` the capture/apply engine already knows how to run: every item —
  including "app" — compiles through the same `compileSingleFile` path (there is no shared/merged
  carrier any more), plus one group per companion folder, one per `items.custom` entry, and — now
  ordinary registry defs of their own (task 5) — the `core-plugins`/`community-plugins`
  enablement-carrier groups (see Data model below). Per-element enablement sharing is STORED, never
  derived here: the rule lives on the carrier item's `perElement` map (`core/enablementRules.ts`)
  and is read from there — a rule is a thing the user wrote, never a side effect of whether a card
  happens to be switched on.
  `customItemFromGroup(g, existing)` / `itemTail(item)` convert between a custom item and the
  `SyncGroup` shape it compiles to, carrying every unknown field through. `groupOwners(defs, items)`
  maps every compiled group name back to the item(s) that own it, so "Stop syncing" a group by name
  durably edits `settings.items` instead of a session-only compiled group.
  `companionConflict(path, defs, settings)` rejects a new companion/custom path that's
  already claimed by any item's settings file (default or custom) or any preset or user-added
  companion. `parentCardLabel(groupName, defs, settings)` resolves the host-card label for a
  card-derived group — an enabled companion folder (matched the same way `compileCompanions`
  names it) or, for older store manifests that still carry it as a group, the
  `enabled-css-snippets` switch list (pinned to the `appearance` def's label); `null` for a
  standalone group. It backs `GroupDisplayParts` and the host's `displayParts(group,
  storedLabel)` (`main.ts`), which the Sync Center (`SyncCenterView.ts`) renders as a faint
  `Parent › ` prefix and folds into its sort key and search text — display-only, never persisted
  (`displayName` and `backfillLockLabels` write the bare label to the store lock).

**Status & availability**
- `core/remoteRows.ts` — turns one remote comparison into the rows the device relation already
  speaks. `remoteFlowFor(state)` gives the WHOLE list one direction (`diffRemote` only answers
  "are the two sides byte-equal", so no row has its own evidence yet), and every undecided state
  reads as `pull` because pull is the additive operation — push mirror-deletes, so an undecidable
  state must land on the side that cannot destroy anything. `remoteRowStatuses` folds each entry's
  files into the same `FileChanges` shape and calls every local item the comparison never mentioned
  in sync; an entry with no local counterpart still gets a row. `skipRefsForSelection` turns the
  checkboxes into the skip list the transport already takes: the rows the user did NOT tick.
- `core/status.ts` — per-item status (`statusForGroups`), remote freshness (`diffRemote`,
  `remoteLockAhead`), and the counts the UI shows (`bucketCounts`, `remoteDirectionCounts` —
  the per-remote ⇡ push / ⇣ pull totals behind the header pills and the status bar).
  `diffRemote(ctx, reader, opts: { skipRefs: ItemRef[] })` returns per-group `RemoteDiffEntry.files:
  RemoteDiffFile[]` — one entry per file with its `kind` (`added`/`updated`/`deleted`) and both
  sides' content, so the UI renders file lists and content diffs instead of bare counts;
  `skipRefs` drops those items' store rels from both sides before diffing (comparison answers for
  both directions at once, so main.ts passes the union of the pull and push blocked sets).
  `remoteLockAhead(localRaw, remoteRaw, ignoreRefs, groups?)` takes an explicit `ignoreRefs` list —
  callers pass `refsBlockedFor(remote.items, "pull")`, so a lock entry for an item the remote never
  pulls cannot keep the "remote has newer version info" hint alive forever. `applyImport` closes the
  loop on the writer side: after a pull it carries every non-ignored remote lock entry (all but the
  items in `skipRefs`, and any group whose file conflict the user kept as `local`) into the
  local lock, so `remoteLockAhead` converges to false once contents match — the hint clears after a
  single Pull instead of nagging. **How it compares**: **the items answer first**, each
  remote entry weighed **key by key, never `JSON.stringify`**, so key order cannot read as a
  difference, in the known block or in the carried tail. Three rules narrow what counts: `display`
  (`label` / `elements`) is display and never counts (a plugin renamed on one device is not something to
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
  in exactly the mixed fleet the item-by-item comparison exists to keep quiet. `checkRemote(localLock, reader, ignoreRefs, groups?)`
  keeps its cheap contract (the lock file, no store reads) and its `{state, remoteCapturedAt}` shape,
  but when BOTH locks are v2 or newer it decides the state from the entries (`perItemRemoteState`)
  instead of one whole-store timestamp: a store merely older in clock terms whose items all match
  reads `same`.
  `ignoreRefs` is REQUIRED for the same reason `remoteLockAhead` takes one — a remote never exchanges
  the entry of an item it does not pull, so without it the per-item path resolves a direction
  from an entry the two sides diverge on by design, and no Pull could ever clear the arrow. It
  falls back to today's timestamp comparison whenever per-item resolution cannot answer: either side
  at v1, no entries left to compare, a difference it cannot date, or the two stores ahead of each
  other in different items, which `RemoteState` has no word for. Per-item precision is also weaker
  for an encrypted item, which carries no `hash` and so is ordered by capture time alone — a
  same-content re-capture elsewhere still reads as newer. A remote lock whose `version` is higher
  than this build understands reports `unknown` (the state that already means "cannot be compared"),
  so the panel never invites a Pull that the store-version gate would then refuse — no new `RemoteState`, no UI change.
  Direction for a changed group
  is a three-way comparison against this device's `core/ledger.ts` entry, never file mtimes or the
  lock's `capturedAt`: no entry → `never-synced` (apply-default, counts into `bucketCounts.down`);
  only the store side moved → `store-newer`; only the local side moved → `local-changed`; both
  sides moved, or neither (a sharing/rule edit shifted the comparison lens) → `differs`, meaning
  specifically "changed on both sides since this device last synced". A comparison error still
  reports `differs` with a `message`. One case bypasses the three-way entirely: a group that is
  otherwise `in-sync` but whose store base still carries a top-level this-device key it must
  never hold (`baseHasStaleLocalKeys`, the same predicate the capture guard purges by) reports
  `local-changed` regardless of the ledger, so the Sync Center offers a capture — which purges the
  base — and the next scan finds it clean and reads `in-sync` again. `statusForGroups` is IO-free with respect to the ledger — it
  takes the parsed `Ledger` and returns `{ statuses, updates }`; `main.ts` owns loading and
  persisting it (see Connector below). `remoteLockLabels(remoteLockJson, toRef)` extracts each item's
  `display.label` (and, for the two carrier entries, `display.elements`) out of a remote's `store.lock.json`
  into a plain map on the compare result — malformed/absent input degrades to an empty map, never
  an error — feeding the display-name chain below.
- `core/ledger.ts` — the device-local sync-baseline ledger behind that direction logic. After
  every group whose comparison reports `in-sync`, `statusForGroups` emits a fresh `{store, local,
  at}` fingerprint (SHA-256 hex via `crypto.subtle`); switch-list groups (`isSwitchListGroup`, whose
  answer comes from the registry's `SWITCH_LISTS` rather than a hardcoded name set)
  hash their canonical *set* form rather than raw bytes, so on/off-list reordering never reads as
  movement, and folder groups hash a sorted `rel\nsha256(content)` manifest. **The ledger is keyed by
  `ItemRef`**, the same key space as the lock and the opt-out list; `rekeyLedger`
  (itemKeys.ts) converts a v2 ledger's group names once, during the migration — never dropping an
  entry, because a missing baseline reads as never-synced, which defaults to APPLY. `main.ts` is the ledger's
  only writer — there is no separate write hook in capture/apply, since every run already triggers
  a status recompute whose `in-sync` results reseed the baseline (this also covers upgrade
  migration and self-healing after a wiped ledger). `parseLedger`/`applyUpdates`/`pruneLedger` are
  pure and total: malformed or missing input parses to an empty ledger, entries for groups that
  left the compiled config are pruned on write — and **only** for that reason: the keep-set is built
  from the whole compile, never from the narrowed list a device actually compares. The device-class
  filter and this device's opt-out list both narrow that list, and both are reversible choices
  rather than statements that an item stopped existing. Building the keep-set from them instead
  deletes the baseline of every opted-out and every class-scoped-away item on the next refresh, so
  reversing the choice finds no baseline and the row falls to `never-synced`, which presents as
  APPLY on a row that had been asking to be captured.
  The prune answers "does this item still exist?", never "is it being compared right now?" — `no-settings`/`not-captured` groups drop
  their entry, while comparison errors and `locked` groups keep theirs (a transient read failure
  or missing passphrase must not degrade direction knowledge). A lost ledger only ever widens uncertainty toward
  `never-synced`, never guesses a destructive direction.
- `core/availability.ts` — is a plugin enabled / disabled / not-installed on this device, plus
  version drift (`availabilityForGroup`, `compareVersions`); `snippetOrphans(localOn, storeOn,
  localFiles, storeFiles)` — enabled-snippet names with no `.css` file locally **and** none in
  the store's snippets dir (the store-file check is a fresh-device safeguard: before its
  `snippets/` folder has synced down, the store copy still covers it); `desktopOnlyDrift` and
  `desktopOnlyPluginIds`, which read the same availability facts fleet-wide. Which element ids a
  shared per-class rule keeps off this device is `enablementDecision.ts`'s answer, not this
  module's.
- `core/pluginState.ts` — `pluginRuntimeEnabled`: a plugin is "on" when **loaded OR persisted**.
- `core/remoteFailure.ts` — `classifyRemoteFailure`: pure classification of a remote-compare
  failure message (`no-token` / `auth` / `timeout` / `other`) so a failed comparison can offer the
  right remedy instead of a raw git error.
- `core/syncListDelta.ts` — `syncListDelta(local, store)`: the by-name added/removed difference
  between this device's compiled sync list and the store's, behind the Config Sync pane's
  "adopting/capturing would add/remove …" summary.
- `core/catalog.ts` — `OPTION_LABELS`/`listOptionSections`/`listCoreSections`/
  `listPluginSections`/`listBetaSections` are the pre-registry `CatalogItem`/`CatalogSection`
  taxonomy. They do not drive any tab's rendering (`registry.ts` + `itemCard.ts` do, see UI below);
  they feed `SettingTab.ts`'s search index and a few Advanced-tab helpers.
  `listDiscovered` (unclassified config-root files) is still live for the Advanced tab.
  `sectionForGroup(name)` maps a compiled group name to its section (`obsidian`/
  `core`/`community`/`custom`) for the `section:` qualifier and run-report grouping; the switch-list
  enablement-carrier groups `community-plugins`/`core-plugins` are pinned to `community`/`core`
  (the same way `enabled-css-snippets` is pinned to `obsidian`) instead of falling through to
  `custom`. `displayLabelForGroup` and `lockLabels.ts`'s `resolveHostStoredLabel` are the shared
  display-name chain every caller (row naming, remote-row naming/sort, on/off-list narration,
  progress toasts) routes through, in priority order: the local manifest/custom-rule label → this
  device's own `store.lock.json` `display.label` → the group's own carrier's
  `display.elements[id]` (for a plugin/core group with no lock-entry label of its own) → the
  def-name/bare-id fallback.
  A remote comparison's `remoteLockLabels` (status.ts above) slots in as one more step, after this
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
  (`captureTransform`'s third return field — named after the `__scopes__` sidecar file it is written
  to, the one place the retired word survives, because that filename is an on-disk path every
  existing store already contains); Apply computes `store base ⊕ own-class sidecar`
  (shallow merge, sidecar wins) via `applyTransform`'s `ownScopeContent` parameter, before
  decrypt/strip run. With no sidecar yet (a pre-partition device), own-class keys fall back to
  the local value; other-class keys are always dropped, never preserved from local.
- `core/crypto.ts` — AES-256-GCM file and field envelopes, PBKDF2 key derivation; whole-file
  encryption (a Plain-mode `FileRule.encrypted`) uses the same file-envelope primitive as
  `mode: "encrypted"` groups, just gated by a different rule shape.
- `core/secrets.ts` — the plugin's own keychain entry names (`PASSPHRASE_SECRET_ID`), declared in
  one place so the settings UI and the manifest validator can refuse to hand the vault passphrase
  to anything else (e.g. as a git remote's token).
- `core/switchList.ts` — set-semantics for the on/off lists (`community-plugins`, `core-plugins`,
  `enabled-css-snippets`) with per-device exception masking; `SWITCH_LISTS` declares them, and
  `EnablementList` (`"core-plugins" | "community-plugins"`) is the identity a carrier's filename is
  derived FROM, in one place — v2's `enablement.carrier: "core-plugins.json"` encoded the filename
  as the identity.
- `core/pathing.ts` — the configDir-agnostic mapping between a group's real path and its store
  path (`groupRealPath`, `groupStorePath`; `STORE_CONFIG_DIR` = literal `configdir`).
  `sidecarStoreSuffix(cls)` = `.__scopes__.<cls>.json`, appended to a file group's flat store path
  (there is no per-group store directory to nest a sidecar file under). That filename keeps the
  retired word deliberately: it is an ON-DISK path every existing store already contains, so renaming
  it would be a store migration for a cosmetic gain. `resolveGroupByStoreRel`
  matches that suffix so leftover/merge logic attributes a sidecar to its owning group.
- `core/io.ts` — the `FileIO` abstraction, recursive listing, OS-junk filtering (`isJunkPath`).
- `core/sanitize.ts` — key/pattern matching helpers used by field rules.
- `core/manifest.ts` — `validateSyncManifest`: structural validation for a `SyncGroup[]` (the
  `compileItems` safety net in `main.ts`'s `recompile`, and the hand-edited Advanced-tab custom
  rules); `FieldRule`/`FileRule` sharing validation through `types.ts`'s own `asSharing`/
  `asFileSharing` narrowers (single source of truth with the types, so the type and the validator
  can't drift — the failure mode a prior CRITICAL finding was named for). It also rejects two rules
  that share one `ref`, naming both: the ref keys the lock, the baselines and the opt-out list, so
  two rules sharing one is two rules sharing a baseline. Parse/validate `store.lock.json` lives here
  too (`parseStoreLock`, `storeLockVersion`, `lockEntry`/`lockEntryList`, `lockLabel`/
  `lockElementLabels`) — reach a lock entry through those accessors, never by indexing two levels by
  hand, because the nesting is one fact and two sites that spell it out are two that can disagree.
- `core/merge.ts` — merge a remote `store.lock.json` against the local one (`classifyMerge`); also
  the shared `sortKeysDeep`/`jsonSortedView` helpers (key-order-normalized JSON rendering, arrays
  keep their order), used by both the merge-conflict modal and the Sync Center's diff preview —
  when a `.json` file's raw text differs but its sorted view doesn't, the preview shows a single
  "Only key order / formatting differs." note instead of a blank-looking diff.

**Install & discovery**
- `core/installer.ts` — download a plugin from the community catalog, version-pinned via the
  root manifest + tagged release; `CatalogError`/`DownloadError`.
- `core/bratIndex.ts` — the BRAT `id → repo` index for beta plugins. `bratRepoIndex(items)` is a
  VIEW over `items.community.*.bratRepo`, each plugin's own field. It is deliberately not a
  top-level `bratIndex` map, which would be a second id list beside `items.community` free to drift
  from it. `withBratRepos` writes the inverse: every resolved id gets its repo on its own
  item, and an id with no item yet earns a `{synced: false}` skeleton rather than starting to sync.
- `core/pkm.ts` — PKM mode (`auto`/`ioto`/`default`) and store-root discovery
  (`resolveRootPath`, `discoverStoreRoot`).
- `core/async.ts` — portable `retry`/`isRetryableError`/`TimeoutError`/`HttpStatusError` (the
  `window`-based timeout wrapper lives in `main.ts`, keeping timers out of the core).

**UI** (`src/ui/`)
- `SyncCenterView.ts` — the hub: the header status bar (self "this device" chip + push/pull
  totals), the self pane (coldstart/adopt), the four fixed type sections (`renderTypeSection`,
  one object = one row, companion families dissolved into their parent's row), the unified card
  renderer (`renderUnifiedCard` — On apply/On capture/State, Files, Resolve (if conflicted),
  `Enabled on`/After install/Enablement, `Settings sync`, More, Note), filters/search,
  the Leftover section, the sticky result strip, run History, and
  Capture/Apply/Pull/Push actions. **There is no second renderer for remotes**: the remote relation
  produces rows of the same shape (`core/remoteRows.ts`) and draws them through this same
  `renderItemMode` — same sections, same rows, same card, same checkboxes — with only the state
  words swapped (`relationCopy`) and the availability axis dropped, since store-copy-vs-remote-copy
  has nothing to do with what this device has installed. While a remote's comparison is still
  running, `renderRemoteComparing` holds the list's place; when it settles, the render finds the
  cached result and paints rows. **Two orthogonal axes drive what it paints**, not one field:
  `relation` (`PanelRelation` — this device against the store, or the store against one named
  remote) is what the View picker sets; `destination` (`PanelDestination` — a slice of items, run
  History, Config Sync's own entry) is what the sidebar sets. `renderMainRegionBody` checks them in
  that order deliberately: `self` and `history` answer the same thing under either relation and are
  dispatched first, so the relation never reaches them; only an items destination asks the relation,
  and a relation naming a remote settings no longer has falls back to the device before rendering.
  Row content is memoized once per render (`deriveRow`) so the
  section partition, filter-pill counts and row painting all read the same computed `Fate`/`FateInput`
  instead of re-deriving it per consumer. Its search bar's qualifiers are `SYNC_QUALIFIER_SPECS`
  (`type:` · `section:` · `action:` · `mode:` · `device:`), declared `as const` so `SyncQualifierKey`
  makes `syncResolvers()` total over them; `section:` presents FIVE values while only four are stored —
  `beta` is computed from the BRAT index at render time (see `types.ts`'s `Section` vs
  `StorageSection`), and this is the one place presented and stored vocabulary legitimately differ.
  `rowRef(name)` is the view's own ref resolver — the host's registry lookup for a compiled row, the
  closed legacy rules for a store-only one — memoized against the group list's identity, because it
  is asked per row per render. **The Sync Center card has no destructive footer**: it only changes
  rules and sets local exceptions. `StopSyncingModal` is called from exactly one place, the settings
  panel card's own toggle (`SettingTab.ts`), so the destructive gesture has one home, beside the
  confirmation the change deserves. `Settings sync`'s row offers the device opt-out in its local
  segment (`buildOptOutLocalMenu`, `ui/enablementRow.ts`), and `MORE`'s icon-only deep link
  (`renderMoreRow`, never `sliders-horizontal`: that glyph already means `your rule` in the fate
  chips) is the only path to Settings for stopping a whole item's sync.
- `fateModel.ts` — the fate-sentence engine: `rowFate(FateInput): Fate` is the pure function
  behind every row's verdict (the verb
  table) — glyph (`↓`/`↑`/`—`/`⚠`), sentence, chips (`not installed here`/`desktop only`/
  `stays off`/`off here — your rule`/`on here — your rule`/`🔒 encrypted`/`your rule` — the last
  four are suppressed on an excluded row: run-consequence facts are moot
  once the item is ignored on this device; `desktop only`/`encrypted` stay, intrinsic facts),
  `stageable`, `turnsOn`, and `excluded` (true for either exclusion cause,
  `optedOutHere` OR `excludedHere`; `panelModel.ts`'s `fateBucket` reads this field directly
  rather than re-deriving the cause). `optedOutHere` is checked UNCONDITIONALLY, before
  conflict/direction ("renders inert" has no family-member-wins
  exception); `excludedHere` keeps its direction-null-only precedence. A direction
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
  and their dedicated per-device drawer are gone. A card's `data-search-anchor` is `itemAnchorId(ref)`
  — a DERIVED KEY WITH ONE PRODUCER (`itemKeys.ts`), because it is also the
  target of the Sync Center card's `More` deep link and of the settings search index's jump, and
  that line has diverged from the renderer twice, each time silently killing every jump. Its inverse
  is `refFromItemAnchor`. Advanced (custom rules / discovered files)
  still renders the per-`SyncGroup` rule form, unrelated to the card renderer.
  The settings search bar's qualifiers are `SETTING_QUALIFIER_SPECS` (`section:` · `type:`), declared
  `as const` so `SettingQualifierKey` makes the resolver map total over them — a renamed key with no
  resolver is a compile error, not a qualifier that autocompletes and filters nothing. Here `section`
  names the settings AREA (`general` · `obsidian` · `core` · `community` · `custom` · `advanced` · `remotes`),
  where the Sync Center's names an item family, and an Advanced-tab hit answers BOTH: its area, plus
  the family `sectionForGroup` gives it — the Sync Center's own producer, so `section:custom` cannot
  mean one thing in one box and another in the other. Each hit's `type:` is the item's real kind:
  a custom rule's compiled `SyncGroup.type` (which is what `syncTypeValue` reads on the other side),
  a registry card's own settings FILE, and neither for a state-only item, which has no file at all.
- `itemCard.ts` — pure render-model helpers for the card renderer (badges, zone presence, the
  Fields/Companion-folders row models, path/companion validation) so the card's logic is
  unit-testable without touching the DOM; `SettingTab.ts`'s renderers turn these models into
  elements. The sharing-picker model lives here too (`sharingIcon`/`nextSharing`/
  `sharingCycleTooltip`), consumed by `SettingTab.ts`'s `renderSharingPicker` — the menu-based
  picker every sharing cell with no local layer renders through. `sharingIcon`'s vocabulary
  (`monitor-smartphone`/`monitor`/`smartphone`/`airplay`) backs the shared half of the merged
  control below.
- `ui/mergedControl.ts` — the merged two-layer control's SHAPE, painted once for both surfaces:
  `sharedGlyph · localGlyph ⇕` in one trigger, and `buildSectionedMenu`, which turns a list of
  `MenuSectionModel`s into an Obsidian `Menu` with `setIsLabel` headers and separators. The two
  views own their row SHELL (a scrow vs a card row) and their own menu-trigger wiring; everything
  between lives here, so the two surfaces cannot drift on what a row offers.
- `ui/enablementRow.ts` — that control's MODEL, shared by four renderers — a Sync Center row's
  `Enabled on`/`Settings sync` (`renderMergedRow`, SyncCenterView.ts), a plugin card's
  `Enabled on`, a carrier card's element rows, and a Settings-panel item card's own path row and
  per-key rule rows (SettingTab.ts, `paintMergedControl`) — so what each layer SAYS is decided once
  and the renderers only paint it. `sharingMenuSection` builds the shared half's section (same
  stops, same order, same separator before the fourth, at every entrance), and
  `SHARED_WITH_HEADER`/`ENABLED_ON_HEADER`/`ON_THIS_DEVICE_HEADER` are the section headers that
  make the same three words unambiguous — `Enabled on: Desktop only` and `Shared with: Desktop
  only` say different things, where the bare stop could not.
  `ruleOptionsFor` decides WHICH stops a row offers — `RULE_OPTIONS`, minus the two that name a
  phone when the element's plugin declares `isDesktopOnly` — and `displayRule` decides which one it
  shows as current, collapsing the `everywhere` an absent rule reads back as onto the stop that
  behaves identically, so a two-stop menu never opens with nothing checked. `ruleToStore` is the
  inverse: picking that collapsed stop clears the entry rather than writing one, keeping the round
  trip byte-identical and the entry removable at all (a two-stop menu has no stop left to clear it
  with). All three are asked at BOTH entrances, or one offers a stop the other refuses for the same
  plugin.
  `RULE_OPTIONS`/`ruleIcon`/`ruleLabel` are the shared-layer vocabulary
  (`sharingIcon`'s icons, plus `square-split-horizontal` for `Not shared` — `airplay`,
  `sharingIcon`'s own this-device glyph, would read as screen mirroring to a reader who has not read
  the source, and a negation glyph would put the shared answer in the local exception's family,
  which is the one distinction readers most often lose);
  `buildLocalMenu` is the element-level exception menu's one producer, and `buildOptOutLocalMenu`
  is the one producer for BOTH two-state local answers — the whole-file opt-out and a per-key
  rule's own exception — sharing one two-entry producer (`optOutLocalSegment` builds their shared
  glyph+tooltip) rather than each hand-typing a copy; the element-level menu stays its own
  producer, a genuinely different datum (an on/off exception, not a follow/except
  pair). `enablementRowModel`/`fileEnablementRowModel` compose a rule + an exception into what
  both halves say; the local half has a glyph in every state, `equal` for "follows what's shared"
  included — a layer that vanishes while it agrees reads as missing, not as agreement. Each half
  carries its own `isSet` (`RowSegment`), which is what its color reads: the paint site never
  decides it, because two paint sites deciding it separately is how they drift. `sharedSegment`
  answers it for the rows whose shared answer is a plain `Sharing` value. What makes an answer NOT
  set even when it is narrower than `All devices` is `restatesInnate` (itemCard.ts) — the same
  predicate `computeBadges` and `carrierBadgeCounts` ask, so a glyph, a badge and a count never
  disagree about whether the user decided anything.
- `ui/sidebarFit.ts` — WHEN the Sync Center trades its sidebar for the compact switcher. Pure and
  DOM-free: `sidebarNeededWidth` takes the entries as `{name, badges}` and a text measurer,
  `nextCompact` compares that against the column the stylesheet's `minmax(150px, 22%)` would give
  and applies the floor, the platform override and the leave-hysteresis. `SyncCenterView`'s
  `sidebarRowNeeds` builds the input from the same producers `renderSectionEntries` renders from, so
  the two cannot disagree about which rows exist or how many badges each draws, and `measureSideName`
  measures text on a detached canvas. **No DOM probe on purpose**: in compact there is no sidebar on
  screen to measure, so a probe-based rule could never decide to bring it back. The column
  constants are duplicated from `styles.css` (both sides carry a comment saying so) — a drift there
  makes entering and leaving asymmetric, and an asymmetric pair oscillates.
- `ui/panelTaxonomy.ts` — ONE declaration of which fold a Sync Center row files under
  (`placeRow`, `FATE_FOLD_YIELDS_TO_AVAILABILITY`), read by every consumer: the sections, the
  filter pills, the counts. A row carries a fate AND an availability at all times, so the choice
  between the two axes is a decision with a reason, and it lives here rather than inline wherever
  a fold is built. `tests/panelTaxonomy.test.ts` pins the whole table.
- `ui/resolveSegment.ts` — the conflict side-choice control, painted identically on the item card
  and inside a file's diff, so both entrances write one decision through `pickConflictSide`.
- `ui/refreshControl.ts` — the refresh button's busy state. Busy is passed in rather than derived
  from a remote-only signal, so the control spins for the whole refresh on desktop and mobile alike.
- `ui/settingsDeepLink.ts` — the Sync-Center-to-Settings bridge: `{ ref, spot }`, where `spot` is
  `"card"` or `"key-rules"`. Carrying the spot is what lets one bridge serve two jumps that mean
  different things: `More ▸ Per-key rules, locks & folders` means "this item's drawer", while
  `Per-key rules decide` must land on the key-rules rows themselves, the way Settings' own copy of
  that jump does.
- `ui/DiffModal.ts` — `openDiffModal`, the resizable standalone diff window; it shares
  `diffView.ts`'s unified/split and collapse preferences with the inline view.
- `actionIcons.ts` — the single source for the per-action Lucide icons + color classes
  (Capture/Apply/Push/Pull) reused across the panel, buttons, badges and History.
- `fateChipIcons.ts` — `FATE_CHIP_ICON`: the fate-chip string → Lucide glyph registry (single
  source, like `ACTION_ICON`); an unmapped chip string renders text-only rather than throwing.
- `foldIcons.ts` — `FOLD_ICON`/`renderFoldCount`: the fixed-size Lucide icons for the three fold
  summary lines (in-sync / excluded / no-settings) and the filter pills' short form, so the state
  marks read as equal weight regardless of theme font metrics.
- `foldChevron.ts` — `renderFoldChevron`/`setFoldOpen`: the ONE "expands in place" glyph for every
  fold in the app — a single `chevron-right` SVG rotated via CSS, so a fold's state is one boolean,
  never a second icon name to keep in sync.
- `statusBar.ts` — pure segment model (`statusBarSegments`, `statusBarAriaLabel`) + a thin DOM
  renderer for the status-bar item; segments mirror the Sync Center header pills (↑/↓ from
  presented bucket counts, ⇡/⇣ from `remoteDirectionCounts`). The bar runs outside the view, so
  `panelModel.ts`'s `statusBarStatuses` reproduces the view's row set structurally: self dropped,
  companions folded through `familyRollup`, and `desktop-only` dropped (the one availability class
  `stageableRow` calls unstageable). It cannot reproduce the view's FATE machinery — install
  policy, conflict choices, direction overrides — and that residual is stated at the function
  rather than papered over.
- `qualifierSearch.ts` — the `key:value` search shared by both search boxes: pure `parseQuery` /
  `matchesQualifiers` / `suggest` / `applySuggestion`, plus the `QualifierAutocomplete` DOM widget.
  A key the host's spec list does not declare is not a qualifier — it stays free text. That is what
  makes retiring one honest: the Sync Center's `SYNC_QUALIFIER_SPECS` and the settings panel's
  `SETTING_QUALIFIER_SPECS` both spell the item family `section:` now, with **no alias** for v2's
  `scope:`, so a typed `scope:core` searches for those literal words instead of quietly filtering.
- `panelModel.ts` — the pure view-model layer over `fateModel.ts`, unrelated to the settings-tab
  card renderer above. It also owns the panel's two navigation axes: `PanelRelation` /
  `PanelDestination` and their keys (`relationKey` prefixes a remote's name so a remote called
  `beta` or `history` cannot collide with the destination of the same spelling; `foldStateKey`
  combines both so one section's folds under two relations are two different lists),
  `relationLabel` (`This device ↔ store` / `store ↔ <name>`), `relationCopy` (the two relations'
  state words as ONE table — `To capture`/`To push`, `Not synced here`/`Doesn't sync with this
  remote`, the fold lines — so the three surfaces that bucket by state cannot drift apart), and
  `viewOptions` — the View picker's whole content as data, including the rule that a `current`
  naming a deleted remote resolves back to this device so the picker always has exactly one active
  row. A remote's badge is a real item count once a comparison has run against it, and its cheap
  whole-store state icon until then.
  `fateBucket(fate)`/`fateBucketCounts` derive the one `RowBucket`
  (`conflict`/`apply`/`capture`/`excluded`/`ok`/`none` — `excluded` read off
  `Fate.excluded`, positioned after the stageable checks and before `nothingYet`) every consumer —
  section partition (active vs. the in-sync/excluded/no-settings folds), filter-pill counts,
  filter visibility, sidebar badges, header pills — reads, so a row can never disagree with itself
  across those surfaces. **Which ROWS those counts run over is decided once too**
  (`SyncCenterView`'s `countable`): exactly the rows the list renders — families already folded,
  the self item out, the two on/off carriers out under the DEVICE relation (they dissolve into their
  section's head chip) and IN under a remote (there they are ordinary items with ordinary rows),
  and every availability section IN, because an outdated/disabled/not-installed row is drawn and
  staged like any other. The status bar reaches the same set from outside the view through
  `statusBarStatuses` (below). `TYPE_SECTION_ORDER`/
  `TYPE_SECTION_TITLES`/`typeSectionForRow` fix the four sections (Obsidian/Core plugins/
  Community plugins/Your folders — beta folds into Community, custom groups into Your folders);
  `sectionCountLabel` renders a section head's trailing `N` / `N/M`. `familyRollup` derives one
  family's fate from its parent + companion `GroupState`s (settings/folder verbs join, an
  Appearance override replaces them, any per-file conflict or split-direction membership becomes
  `⚠`); `mergeFamilyChanges`/`fileEntryFor` back the card's direction-aware Files rows.
  `foldCompanionEntries` folds a remote diff's companion entries into their parent, so a remote
  comparison yields the same one-row-per-family grammar; `onOffFlips`/`onOffNarrationLines` derive
  the flip counts and capped/whole-list narration a diverged `core-plugins`/`community-plugins`
  carrier shows in its own card's `On/off` row. `showColdStartBanner(selfState, statuses, dismissed)` is the pure predicate behind the
  cold-start guidance banner (true while the plugin's own settings are pending adoption and at
  least one row still needs its first sync, unless dismissed) — separate from the self pane's own
  coldstart/adopt state, which speaks through `SelfSyncInfo.storePresent` instead (no store yet →
  pull-first guidance; a store present → the Adopt guide). `leftoverPresentation(selfState, count)`
  is the Leftover surface's one gate (section / hint / nothing): a device whose own configuration
  is pending adoption cannot judge "leftover", so the section and its filter pill give way to
  `LEFTOVER_ADOPT_HINT`; capture-pending does not gate. `stagedPayload`/`effectiveFate` turn
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
  colored by `{sharing, encrypted}` rule state (per-element coloring too, for a `perElement` array);
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
  cached per refresh generation and reused, so a compare does not re-clone after the status check.
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
  `core-plugins`/`community-plugins` switch groups, `main.ts` computes ONE `EnablementDecision` per
  list element per run (`decisionsByList`, `core/enablementDecision.ts` — never three independent
  derivations that can disagree, which is how the invariant-I.1 failure happened) and projects it three ways for
  `CoreContext`: `switchExceptions[group]` = every masked element ∪ auto-derived exclusions
  (community-plugins only — desktop-only manifest ids on mobile, plus plugin groups whose `devices`
  class doesn't match, `augmentedSwitchExceptions`); `switchForceOn`/`switchForceOff[group]` = the
  subset each decision forces. Auto-derived ids are mask-only and never appear in force-off, so they
  keep local state instead of being forced off — an explicit local exception or an unmatched
  `per-class` rule, by contrast, IS forced. `switchExceptions` is NOT part of the `ItemRef` key
  space: it is in-memory, per-run, keyed by the switch list's own identity, and never persisted.
  `enabled-css-snippets` is unaffected by any of this — its per-element sharing
  lives in the compiled "appearance" group's `perElement.enabledCssSnippets` map instead (see
  `core/perElement.ts` above).
  `loadBaselines`/`saveBaselines` wrap `app.loadLocalStorage`/`saveLocalStorage` under the vault-
  and device-scoped key `config-sync-baselines` (same storage shape as the `config-sync-passphrase`
  key above) and are the ledger's only reader/writer, called before and after every
  `statusForGroups` pass (the main list, the self group, and the periodic/manual status refresh).
  The key is deliberately `localStorage`, not a vault file: remotely-save (or any note sync)
  carries the vault, and the baseline is exactly the fact a vault-wide sync must not carry — what
  THIS device last saw in sync. `coldStartDismissed`/`setColdStartDismissed` persist the cold-start
  banner's dismissal the same way, under `config-sync-coldstart-dismissed`, cleared whenever self
  state settles back to `insync` so a future genuine cold start shows the banner again. `deviceId()`
  is the same primitive again,
  under `config-sync-device-id`: read-generate-persist in one call (not a separate `ensure*` step
  at load, since there is nothing to migrate into). It had to live outside `data.json` because a
  wholesale copy (git-tracked vault, remotely-save, manual copy) would otherwise let a bootstrapped
  machine inherit the source machine's identity — a `selfPresetRules` strip on a settings field only
  ever promises "not on THIS device's own next capture," never "immune to an inbound copy." The
  opt-out it keys is itself a
  localStorage entry, `config-sync-device-optouts` (`deviceOptOutGroups`/`saveDeviceOptOutGroups`,
  a JSON array of `ItemRef`s — any other stored shape reads as "nothing opted out" and is
  never thrown; parsed at most once per load, since it is read per row per render). The carried
  fleet-wide `deviceOptOuts` map is **gone**: it existed only so a
  build too old to refuse a newer document would still find its own entry, and the version gate
  replaces it. `deviceId()`'s one remaining reader on that path is
  `absorbCarriedDeviceOptOuts`, run once by the migration — a device jumping straight from 2.20.0
  never ran 2.21.0's absorb, so dropping the field without reading it once would silently resume
  syncing items that device deliberately opted out of. It is a union, never a replacement, which
  also makes running it twice a no-op.
  `deviceFields()`/`saveDeviceFields()` are the same primitive again, under
  `config-sync-device-fields`: a per-item table (`ItemRef` → rule PATTERN → `"not-synced"`)
  recording which of an item's own per-key rules THIS device has taken out of sync — keyed by
  pattern, not an expanded key name, so excepting a `plugins.*` rule excepts everything it matches.
  Parsed at most once per load (`deviceFieldsCache`, same discipline as `deviceOptOutGroups` above)
  and never rewritten in place: an unreadable shape reads as "no exceptions," whether that shape is
  a corrupt write or simply a newer build's own.

**Brand assets**
- `assets/` — brand SVGs: `icon.svg` (24×24, `currentColor`, iconize-importable), `logo.svg`
  (256×256 README tile), `social-preview.svg` (1280×640 GitHub social card).

## Storage invariants

The two rules the whole data model answers to. Everything in **Data model** below
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
the `deviceOptOuts` map (a `deviceId`-keyed map in data.json, erased by one `pull` + `adopt`,
reproduced from a live run). II.1 is the lock's
whitelist rebuild, which let one pull by an older device strip a newer device's fields and push the
loss on to the fleet. II.2 is `sanitizeMemberRules`, which deleted a value it did not recognise and
saved immediately. II.3 is the settings gate that read a NEWER document as legacy and reset it.
II.4 is `refreshBratIndex` on a device with no BRAT list, wiping a fleet-shared index for everyone.

The invariants are stated as the rules the data model is held to, not as a claim that every site
already satisfies them. **II.4 is the one still partly open**: `refreshBratIndex`'s guard covers only
the empty case (`repos.length === 0`), so a device that has ONE BRAT repo still prunes the entries
for the other nine when it writes, a partial source of truth acting as a full one. It fires from the
Beta tab's render with no user gesture behind it. Narrowing that guard from "knows nothing" to
"knows less than the index does" is open work.

**I's corollary holds with no exceptions.** `deviceOptOuts`, a `deviceId`-keyed map, does not exist
in `data.json`. **Do not re-introduce it**, and note what makes its absence safe rather than a
regression: dropping a field like this is a two-phase change, because a document written without it
and adopted by a build that still reads it hands THAT device someone else's opt-out. The version
gate closes phase two, since a build old enough to need the field is a build that cannot read this
document at all. The migration reads the map once (`absorbCarriedDeviceOptOuts`, a union into
localStorage) and then deletes the field.

## Core invariants

Changes must preserve these:

- **Pure core, connectors-only classes.** Nothing in `core/` imports Obsidian; it operates on
  injected `FileIO`/`PluginHost`. Classes appear only at the boundary (`main.ts`, modals, views).
- **Node stays in `src/external/`, mobile-safe core.** `fs`/`child_process`/Electron live only in
  `src/external/`, reached via dynamic `import()` from desktop-gated code in `main.ts` — so the
  core never pulls Node into the mobile bundle.
- **Switch lists are identified by group name and compared as sets.** `SWITCH_LISTS`
  (`community-plugins`, `core-plugins`, plus the legacy-only `enabled-css-snippets` — never
  compiled as its own group since the per-element move) drives set comparison — never byte
  comparison — at all
  five alignment points: `statusForGroups`, `classifyMerge`, `diffRemote`, capture, and apply.
  Which items are carriers is declared by the registry (`EnablementList`), not by a hardcoded name
  set, and the carrier's filename is derived from that identity in one place.
- **Direction comes from a device-local baseline, not timestamps.** `store.lock.json`'s
  `capturedAt` and file mtimes never drive `local-changed`/`store-newer`/`differs`; only the
  `core/ledger.ts` fingerprint this device last saw in sync does. Losing the ledger (reinstall,
  cleared app data) only ever widens uncertainty to `never-synced` (apply-default) — it never
  guesses a destructive direction.
- **Class field rules (`desktop`/`mobile`) act on top-level keys only.** A glob match inside a
  nested object is ignored for class partitioning; `strip`/`encrypt` are unaffected and keep
  their any-depth semantics.
- **Device-local facts never enter the shared store; the store contract decides what is
  device-local.** The explicit **Not shared** choice for a list element lives in
  `config-sync-device-elements` (localStorage, never inside `data.json` at all — see the Data model
  and Enablement notes below), never in the carrier item's own `perElement` rule. On capture and comparison a
  group's this-device fields are stripped using the union of the local rule and the store contract's
  rule for that group (`withContractLocals` + `readStoreContractLocals`, applied identically to both
  sides so they can't desync) — an un-adopted device can't publish device-local values downstream; a
  contract this-device rule overrides a colliding local rule and promotes a plain-mode group to
  fields. During the transition window the store's own self copy is still a **v2** document, so that
  read is migrated in memory first (`storeSelfCopyGroups`); reading it as empty would switch the
  strip OFF for a first capture.
- **A datum true only of THIS device, and defined by this device's identity, lives in
  localStorage — no structure keyed by `deviceId` may appear in data.json.** The **On this device**
  whole-file opt-out lives under `config-sync-device-optouts`, keyed by nothing at all because a
  per-device document has no other devices in it — the same "per-vault, per-device, invisible to
  vault-wide sync" primitive `passphrase`/`loadBaselines`/`coldStartDismissed` use. The identity
  behind it (`main.ts`'s `deviceId()`) is out of `data.json` for the related reason that a wholesale
  copy would otherwise let a bootstrapped machine claim the source machine's identity — a
  `selfPresetRules` strip promises "not on this device's next capture," never "immune to an inbound
  copy." **The list is keyed by `ItemRef`**, the same key space as the lock and the baselines.
  (Why the rule exists, and why the fleet-shared `deviceOptOuts` map it replaced is deleted rather
  than carried, is the Storage-invariants story above — I.1 and its corollary.)
- **A device-local exception preserves the store's existing value; it never strips.** Excepting a
  per-key rule's pattern (`config-sync-device-fields`, `core/deviceFields.ts`) tells THIS device to
  stop syncing the keys that pattern covers — capture leaves the store's copy of each excepted key
  exactly as it found it, and apply/comparison mask it the same way an other-class key is masked
  (`captureTransform`/`applyTransform`/`contentUnchanged`, `core/modes.ts`). This device neither
  contributes its own value for what it has excepted nor deletes the store's: a device-local
  exception has no fleet consensus behind it, so stripping the key would let one device's private
  decision delete another device's data on that key at the next push. The whole-file opt-out above
  differs only in scope — one whole file instead of one rule's keys — never in this semantic.
  **"The store's copy" means both store files.** A fields-mode item's store copy is the base AND
  this device class's `__scopes__` sidecar, and the class partition moves an own-class key into the
  sidecar before any other rule runs — so a `Desktop only` key's store value exists only there. The
  sidecar is shared by every device of that class, so publishing this device's value into it is the
  same cross-device overwrite as publishing into the base. `captureTransform` therefore preserves
  the prior sidecar's value for an excepted own-class key (ciphertext byte-for-byte where the rule
  encrypts), applied after the sidecar's encryption pass so a preserved envelope is never
  re-encrypted. Conversely, an exception speaks only for keys the base is entitled to hold: `strip`
  and both classes' patterns are subtracted before the base preserve/re-add, or a stale key would be
  pinned in the shared store forever and `baseHasStaleLocalKeys`/`baseHasStaleClassKeys` would force
  a rewrite on every capture that never converges.
- **Enabled = loaded OR persisted** (`pluginRuntimeEnabled`). Reading `enabledPlugins` alone
  misclassifies a running-but-unpersisted plugin as disabled.
- **Self-apply never disables/reloads Config Sync.** Applying a plugin's settings cycles it
  off/on so it reloads clean — but `applyGroup` skips this for `config-sync` itself, or the run
  would reload the plugin and wipe the panel mid-run.
- **Lock model.** `store.lock.json` is `version: 3`: `items` nests **section → id → entry**, keyed by
  the same `ItemRef` key space as the baselines and the opt-out list (v2's flat `groups[name]` is
  read and converted on the way in). An entry records its provenance as one `source: { kind:
  "plugin" | "app", version }` object — v2 encoded the KIND in the field NAME
  (`sourcePluginVersion`/`sourceAppVersion`), so every reader had to know both and try them in
  order — plus `innate` (what the item IS, e.g. `desktopOnly`), `display` (`label` and, on a carrier
  entry, `elements` — names, never behaviour) and its own `capturedAt` and a `hash` of its store
  copy. Restructuring an entry this way needs the version gate: an older reader throws on an entry
  it cannot recognise, so the partition is only safe once such a reader is locked out.
  **Freshness and lineage are two fields, not one**, because one field cannot answer both
  questions: "when this store was captured" (what `checkRemote` reads) and "the state we last
  aligned to" (what a pull sets so `remoteLockAhead` converges). `syncedWatermark` is the lineage
  and **only a pull moves it**; `capturedAt` is derived, `max(items[*][*].capturedAt)`, describing
  local content only. A pull
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
  it, for a folder group every file under its store path. A sidecar is store content like any other (it
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
  **carries every key it does not know**, per entry and at the lock's top level. Rebuilding an entry
  from a whitelist instead would be fleet-wide data loss: the pull path writes the PARSED lock back,
  so one pull by an older device would strip a newer device's fields and push the loss onward.
  **The writers carry the tail too**, or that
  parser is theatre: three sites build lock structures from fresh literals — capture's whole-lock
  build, capture's per-group entry rebuild, and the pull merge — and each lays its own computed
  fields OVER what it does not write (`lockTail` / `lockEntryTail`, `core/manifest.ts`) instead of
  replacing the structure. There are **four** writers, not three — the startup label heal is the one
  that keeps getting forgotten, and it has now been the site of a defect in two consecutive
  releases; it is also the one writer that must never change a lock's FORMAT (see
  `backfillLockLabels` above). The known fields are still replaced, not merged, so a plugin that
  stops being desktop-only still loses its `innate.desktopOnly` flag. The pull merge carries BOTH sides' unknown
  top-level keys, the local lock's winning a collision: a pull-then-push through this build would
  otherwise strip a newer build's field from the remote, which is the same loss one level up. It
  carries the local ENTRY's unknown keys the same way — an adopted remote entry wins every field it
  has (the content is the remote's, so its versions, capture time and hash describe it) but does not
  get to delete a key only we recorded, and keeping it is convergence-safe because the comparison
  only ever weighs keys present on both sides. Every writer emits fields in `parseStoreLock`'s own
  order, which is what makes the parser's fixed order worth keeping: a capture and a
  parse-then-write of the same lock produce the same bytes, so a round trip does not churn the
  vault's history. (`backfillLockLabels` is the exception — it appends `display` to an
  entry it heals, and the next parse normalises the order back.) The lock also carries its own format
  `version`: absent = 1 (the flat `groups` shape), 2 = flat with per-item provenance, 3 = the
  nested `items` shape this build writes (`STORE_LOCK_VERSION`). v1 and v2 are converted on the way
  in; the version is read through `storeLockVersion`, never off the field, because it rides in the
  carried tail like any other key. **The gate belongs to the store, not to "the remote":** the
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
  deliberately not left to the carrying parser to make the round trip lossless, since that would
  rest the invariant on the parser instead of on the gate.
  `planImport` checks both locks as well, so a doomed pull is
  refused before the user is ever asked to resolve conflicts; the planner is a courtesy and
  `applyImport` stays the guarantee, re-reading the lock so it validates the bytes it is about to
  replace rather than the ones the planner happened to see. That refusal is not `checkRemote`'s `unknown` — an
  unreadable lock keeps today's tolerant behaviour, and a `version` that isn't a number reads as 1
  rather than stranding a fleet on a typo.
  **A gate on a version is only as strong as the bookkeeping being FOUND**, which is what
  `assertRemoteStoreDeclared` adds: no lock ⇒ no version ⇒ none of the above runs. Without it a
  remote holding content with no `store.lock.json` reads as brand new and is pulled wholesale, in
  silence (a remote pointed one level too deep at the `store` folder is the realistic way there).
  Pull, the pull merge and push all refuse it with `STORE_LOCK_MISSING_MESSAGE`. In one sentence:
  **refuse when there is content AND nothing here says what the content is.** Two producers, both
  shared with `checkRemote` so the status and the gesture can never disagree — `remoteDeclaresStore`
  (the lock, or the legacy root `config-sync.json`) and `remoteStoreContentRels` (every rel a pull
  would COPY: the listing minus bookkeeping, minus `.migrated-` remnants, minus OS junk).
  Deliberately *not* a "does it look like a store" shape test. The mistyped path lists `configdir/…`
  and no `store/…` at all, and the worse mistype — a remote aimed at a vault ROOT — lists notes and
  `.obsidian/…`, which a shape test would call empty and push would then MIRROR, deleting the vault.
  The breadth is the point: refusing a new repository that has a README in it is an inconvenience
  with a message attached; the shape test's failure mode is silent destruction of whatever the user
  actually pointed at. A LEGACY store is NOT the case the gate is for — its root manifest says what
  the folder is and this build still reads it (`remoteGroupsFrom` parses it, `migrateLegacyManifest`
  exists), so "no lock" there means "bookkeeping older than the lock" and the pull takes the legacy
  path the legacy shape needs; a `.migrated-` remnant declares nothing (nothing reads it), so content
  beside one is refused like any other. A first push to a non-empty target is therefore refused
  rather than mirror-deleting its files, and the copy names BOTH causes (wrong folder / target not
  empty yet). `checkRemote` reserves `no-store` for a remote with nothing in it
  at all — the first-push target — and answers `unknown` for anything present it cannot compare, so a
  remote the gate refuses can never read as an invitation to the push it would then decline.
  (`<configDir>/config-sync-backup` is a legacy path only: nothing writes it, and apply deletes a
  leftover copy.)
- **The store is configDir-agnostic.** Paths use the literal `configdir` segment, so a vault on
  `.obsidian` and one on `.obsidian_apple` map to the same store.
- **Run history is a separate, local-only file** — never captured, never synced.
- **A snippet orphan is never auto-removed.** A `snippets/` element whose file is gone but still
  has a per-element device choice (`SnippetMemberRow.fileExists: false`, `itemCard.ts`) stays listed
  until an explicit Forget clears the choice — the file's absence may be transient (mid-sync), so
  silently dropping the record would risk losing a real device choice.
- **Bulk apply/install is per-item isolated.** One item that throws becomes an error row; the
  rest of the batch still runs. Installs use timeout + retry.
- **The registry compiles, it never migrates.** `compileItems(registryDefs, settings)` is the only
  path from `(ItemDef[], settings.items)` to the `SyncGroup[]` the engine runs; a `CompileError`
  (a path collision) is surfaced as a `Notice` and leaves the PREVIOUS `compiledGroups` in place —
  a bad edit must never silently wipe the working sync list.
- **Schema v5 migrates from v2, v3 and v4 only; v1 is a hard gate, and a NEWER schema is refused, not reset.**
  `classifySettings` (`core/settingsMigration.ts`) answers `fresh` / `ok` / `migrate` / `legacy` /
  `future` against `CURRENT_SCHEMA` (5) and `MIGRATABLE_SCHEMAS` ([2, 3, 4]). `migrate` runs the
  chain (`core/v2Migration.ts`, then `core/v4Migration.ts`, then `core/v5Migration.ts` — each stage
  returns a document of any other version untouched, so a later one simply starts further along)
  once, on the load that finds it, saves once, and behaves afterwards exactly
  as it did before — **it is one way**: after it the document cannot be read by any earlier build
  (2.21.0 onward refuse it politely; ≤2.20.0 resets). `legacy` (the v1-era
  `groups`/`memberScopes`/`memberLocal`/
  `appJsonTabs` shape, or anything unversioned) blocks with a `Notice` and starts from
  `DEFAULT_SETTINGS` — schema v1 has no field a later shape could be reconstructed from. `future`
  exists so that a document from a newer build never takes the legacy path (invariant II.3): since
  `data.json` travels between a user's devices wholesale, one updated device taking that path would
  reset, and then at the next save overwrite, the setup of every device that had not updated yet.
  It sets `main.ts`'s
  `schemaStop`, leaves the file untouched, and says so once at load through the same `Notice` the
  legacy branch uses, because a device that has silently stopped syncing must be visible without the
  user going looking. **While it holds, this build writes nothing another device can see, and
  nothing derived from the document it cannot read**; a writer that appears on no list is refused
  rather than exempt. Refused: `saveSettings`, and `settingsWritable()` ahead of it — every settings
  writer is mutate-then-save, so a save-time refusal would arrive after the mutation and leave
  memory diverged from disk with no recompile; capture / apply / pull / push / adopt at the Sync
  Center host boundary; `stopSyncing` and `deleteLeftoverStoreFiles`, which delete store content
  before any settings write could refuse for them and choose files through a `compiledGroups`
  compiled from the misread document — both answer `null` for "refused", never `[]`, so a caller
  cannot record a refusal as a completed action; `appendActionHistory` and `appendRunHistory`, which
  have the last word on that; `setDeviceOptOut`, which lives in localStorage and so does not pass the
  `saveSettings` choke point at all; `refreshBratIndex`; the startup lock-label heal in
  `refreshLocalStatus`; and `saveBaselines` — per-device localStorage no other device sees, but
  computed from that same misread `compiledGroups`, so writing it records a fiction that direction
  is later decided from. Deliberately NOT refused: this device's scratch preferences that read
  nothing from the document — the passphrase, the cold-start dismissal, clearing the run history on
  request. The background paths (`saveBaselines`, the heal, `refreshBratIndex`) read `schemaStop`
  directly instead of through `schemaStopped()`: they are timer- or render-driven, with no user
  gesture to raise a notice about. The refusal itself is never suppressed, but a REPEAT of its
  notice inside `REFUSAL_NOTICE_MS` is: the settings tab's text fields refuse per keystroke, and
  a notice per character is worse than silence. **A flow that will be refused refuses before it
  opens** — pull before the conflict modal, Stop syncing before its own — and a refused gesture
  never moves the settings tab's drafts either, or the panel would show a delete that did not
  happen (the Advanced tab gets this from `commitDraft`, which keeps its draft whenever the write
  throws; the remotes list guards its structural gestures directly). The Sync Center states the
  refusal in the cold-start banner's structure with no action (`schemaStop()` on `SyncCenterHost`).
  The **same gate runs before the write**, not only at load: adopt/self-apply writes the
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
| **`localStorage`** (per vault, per device) | the device id, the sync baselines, the passphrase, the cold-start dismissal, the **On this device** whole-file opt-out list (`config-sync-device-optouts`), the on/off-list local exception table (`config-sync-device-elements`), the per-key-rule local exception table (`config-sync-device-fields`) | true only of THIS device and defined by its identity; `data.json` travels wholesale, so a shared field keyed by device id is erased by one pull + adopt |
| **`data.json`, locked-local preset** (`selfPresetRules`) | `rootPath`, `remotes` (with their `tokenId` / `passphraseId` names and their `items` direction rules) | this vault's transport wiring — it is in the document, but stripped from the document's own store copy so it never reaches another device. A remote's direction rules nest INSIDE the remote, so they inherit this strip for free: no new protection rule, and a rule naming a remote can never ride an item's store copy to a vault where that remote does not exist |
| **`data.json`, ordinary fields** | `items` (nested by section, custom items included), PKM mode, run-history config, ribbon/status toggles | the fleet's shared sync contract: every device is meant to converge on it |
| **`store.lock.json`** | per-item `source`, `innate`, `display`, `capturedAt`, `hash`; the store's own `version` and `syncedWatermark` | provenance and freshness of store CONTENT, which is a fact about the store, not about the settings that produced it |

Enablement itself answers the same two questions — "does this travel, and at what grain?" — twice
over:

|  | **fleet** — shared default, travels via `data.json` | **local** — this device's exception, never travels |
|---|---|---|
| **whole file**<br>(an item's own settings file) | `settingsFile.fileRule.sharing` | `config-sync-device-optouts` (localStorage) |
| **one element of a list**<br>(a plugin on/off) | the carrier item's `settingsFile.perElement[<key>]` (`core/enablementRules.ts`) | `config-sync-device-elements` (localStorage, `core/deviceElements.ts`) |

A third thing — whether a plugin is on RIGHT NOW — is neither: it lives in Obsidian's own on/off-list
files, config-sync never stores it, and only masks it at capture/apply time. `core/enablementDecision.ts`
is the one place a fleet rule and a local exception are reconciled into that mask, first match wins:
a local exception outranks the rule; an `each device decides` (`this-device`) rule masks without
forcing (this device's own state stands); a `per-class` rule not matching this device's class masks
and forces off; otherwise the element follows the shared list untouched.

A per-key field rule has the same fleet/local shape (fleet: `settingsFile.rules[<pattern>].sharing`;
local: `config-sync-device-fields`, localStorage, `core/deviceFields.ts`) but a different
reconciliation — there is no on/off mask to compute, since the local half here is not a state to
merge in but an instruction to leave the key alone entirely (Core invariants above).

**Schemas** (`schema/`, hand-maintained JSON Schema — the repo's schema-first rule, CLAUDE.md):
`data.schema.json` (data.json at `schemaVersion: 5`), `store-lock.schema.json` (store.lock.json),
`config-sync.schema.json` (the groups-file shape every compiled group still round-trips through
`parseGroup`), `local-storage.schema.json` (the device-local `config-sync-*` localStorage entries)
and `run-history.schema.json` (the run log). They document the persisted shapes for humans and
external tools; the plugin never validates against them at runtime — the parsers are the authority —
and `tests/schemaFiles.test.ts` gates them against the producers so they cannot silently drift.

**The one key space**: the store lock, the device-local baselines and the device-local
opt-out list are all keyed by `ItemRef` (`${section}/${id}`), minted only by the compiler
(`itemKeys.ts`). A companion is keyed under its owner (three segments), a carrier as
`obsidian/<list>`, and anything a v1/v2 conversion cannot place is kept inert under `legacy/<name>`
— a section deliberately outside `StorageSection`, so `parseItemRef` refuses it and no reader can
resolve it. Dropping such an entry instead would read as never-synced, which defaults to APPLY.

- **`data.json`** (`ConfigSyncSettings`, plugin settings, `schemaVersion: 5`) — what syncs and how,
  compiled to `SyncGroup[]` on every load/save; there is no separate hand-edited manifest file
  anymore (the old `config-sync.json` at `<store root>/` is legacy and only ever read to detect a
  pre-v2 install — see the schema-gate invariant above). `schema/data.schema.json` is this shape's
  authoritative reference — the file the owner's schema-first rule (CLAUDE.md) asks a persisted-shape
  change to update first. **Structure carries the taxonomy**: an
  item's family and id are where it SITS, not a prefix parsed out of its key. Fields:
  - `items: Record<StorageSection, Record<ItemId, Item>>` — two levels, never flattened, never a
    `beta` key. Two ids may legitimately collide across sections (a core and a community plugin
    sharing a name), which is the point of nesting. `Item = { synced, type?, path?, bratRepo?,
    settingsFile?, companions?, description?, label?, origin? }`:
    - `synced` (renamed from `enabled`) —
      is this item synced at all. The old name meant two different things one line apart — "this
      item is synced" and "this plugin is turned on" — and the second meaning is not stored here at
      all; it lives in Obsidian's own on/off-list files, and config-sync only masks them (see
      Enablement below). One word, one meaning.
    - `type` / `path` are required on a `custom` item and absent on a registry item, which derives
      both from its def. `type` is `"file" | "folder"` — v2's `"dir"` is converted by the migration
      and is not a word this build writes or shows.
    - `bratRepo?: string` — the BRAT repo this plugin was installed from (`"owner/repo"`), when
      BRAT manages it. Was a top-level `bratIndex` map — a second list of plugin ids beside
      `items.community`, drifting from it the moment a plugin left one list and not the other. A
      property of a plugin now lives on that plugin (see `bratIndex` below).
    - `settingsFile = { mode: SyncMode, fileRule?: FileRule, rules: Record<string, ItemFieldRule>,
      perElement: Record<string, PerElementSharing> }` (`ItemFieldRule = Omit<FieldRule, "pattern">`
      — the map key IS the pattern, so there is exactly one source of truth for which key a rule
      governs). `mode` is the FULL `SyncMode`, `encrypted` included: a registry item's mode is
      derived from whether it has per-key rules, but a `custom` item chooses it, and narrowing the
      type would turn a user's whole-file-encrypted rule into a plaintext one at the next capture.
      `perElement`'s reserved key `""` (`switchList.ts`'s `perElementKeyFor`, the derived key's one
      producer) means "this whole file IS the list": `core-plugins.json`/`community-plugins.json`
      have no JSON field to index a rule by, so their carrier item — `items.obsidian.core-plugins` /
      `items.obsidian.community-plugins`, real stored items rather than compile-time-only
      artifacts — stores its rules under `perElement[""]` instead. `enabled-css-snippets` indexes by
      its actual field name (`appearance.json`'s `enabledCssSnippets`).
    - `companions?: { path, device: DeviceClass, enabled }[]` — preset (`themes/`, `snippets/`) plus
      user-added companion folders. Optional, and **never written empty**. Writing `companions: []`
      was a compatibility measure for a build that read the field unguarded and would otherwise
      throw; the version gate locks that build out, so every site omits it. Dropping it costs no
      card visibility: any entry in `items.community`/`items.core` earns its card (above), with
      or without a `companions: []` beside it. `{synced: false}` is not residue however much it looks like it —
      it is what an absent entry is not, in the one place that matters most, and nothing on the
      write path prunes it.
  - **Enablement — two layers, one precedence** (see the 2×2 table above). The fleet layer is
    `Item.settingsFile.perElement` on the
    carrier item, read and written through `core/enablementRules.ts` (`enablementRules`,
    `enablementRuleFor`, `withEnablementRule`) — one reader, one writer; all three UI entrances (a
    carrier card's element row, a plugin card's `Enabled on` row, a Sync Center row) go through
    it. The local layer is `config-sync-device-elements` in localStorage, read and written through
    `core/deviceElements.ts` (`parseDeviceElements`, `deviceElementState`, `withDeviceElement`) —
    shaped like `perElement` (list id → element id → state) so both layers share one mental model,
    but it never travels (invariant I.1). `core/enablementDecision.ts`'s
    `decideEnablement` is the one place the two layers combine into a capture/apply mask (see the
    precedence spelled out above the 2×2 table). `Item.runsOn` and `Item.elements` are not fields
    of v4 — a rule lives on the carrier from the moment it is written, never derived from a
    disabled card or a side table, and `core/v4Migration.ts` below is the only code that will ever
    read a v3 `runsOn` again.
  - The whole-file opt-out lives ONLY in localStorage (`config-sync-device-optouts`, keyed by
    `ItemRef`) — there is no `deviceOptOuts` field in the document (see Storage invariants for why).
    An item in that list is excluded from THIS device's runs (capture/apply payload assembly and the
    capture lock-label heal both skip it) while its row stays visible, rendering exactly like a
    devices-class-excluded row — same glyph/sentence/chip, a distinct card clause
    (`FateInput.optedOutHere`, `fateModel.ts`/`SyncCenterView.ts`'s `stateClauseText`). It is a
    different table from the per-ELEMENT exception table above (`config-sync-device-elements`,
    keyed by list id + element id): the two answer the two rows of the 2×2 table, and neither reads
    the other's key space.
  - **A per-key rule's own local layer** is `config-sync-device-fields` in localStorage, read and
    written through `core/deviceFields.ts` (`deviceFieldExcepted`, `withDeviceField`), keyed
    `ItemRef` → rule pattern rather than list id + element id — the third table beside the two
    above, and structurally its own kind: excepting a key is not a state to fold into a mask
    (`decideEnablement`'s job), it is an instruction `captureTransform`/`applyTransform`/
    `contentUnchanged` (`core/modes.ts`) read directly, to leave that key's slot exactly as capture
    found it. `fieldExceptionsByGroupName` bridges `ItemRef` keying to the group-name keying
    `CoreContext.fieldExceptions` carries, mirroring `switchExceptions`'s own bridge. A key whose
    items each carry their own rule has no entry to make here and no control to make it with:
    `excludingPerElement` removes per-item keys from every pattern set the three transforms read, so
    `ruleRowHasLocalLayer` (`ui/itemCard.ts`) is the one producer deciding which rule rows carry a
    local layer at all — an option no runtime path would honour is not offered. It says no for a
    `Not shared` key too, for the opposite reason: nothing entered the store, so there is no shared
    value to opt out of. Either way the control shows one glyph and its menu one section, so what a
    row shows and what it can be told never disagree.
  - There is no second data shape for custom rules: `custom` is a section whose items have the same
    `Item` shape as everything else (v2's `customGroups` array is converted by the migration). One
    consequence is accepted: `items.custom` is an object, so an all-digits rule name sorts to the
    top where v2's array kept authored order — order was checked and is not load-bearing.
  - `thisDeviceItems` and `bratIndex` do not exist in v4. The first was a field whose SEMANTICS
    were "this device" but whose STORAGE traveled with every other device (invariant I.1); the
    migration splits it across the two enablement layers above. The second was a replicated
    top-level map that could drift from `items.community`; a plugin's BRAT repo now lives on the
    plugin's own item (`Item.bratRepo`).
  - PKM mode, run-history config, remotes, ribbon/status-bar toggles — unchanged.
  - Written through Obsidian's `saveData` (never externally, to avoid a reload); `main.ts`'s
    `recompile()` recomputes `compiledGroups` from `items` after every save (see the
    Connector section above) — nothing here is itself a `SyncGroup[]`.
  - **Load-time default fill** (`core/settingsMigration.ts`'s `withDefaults`): the stored document
    is merged onto `DEFAULT_SETTINGS` recursing into the nested defaults (`runHistory`,
    `ribbonButtons`), so a field added inside one of them still gets its default on an older
    document; a stored value always wins, and unknown fields — top-level and nested — are carried
    through untouched.
  - **The two v2 normalizers now live inside the migration** (`core/v2Migration.ts`), where they run
    once on a v2 document instead of on every load: `mergeLegacyAppSliceItems` folds a document's
    pre-merge `items.editor`/`items["files-links"]`/`items.other` cards or top-level `appJson` field
    into `items.app` (`enabled` ORs across the three, `rules`/`perElement` union first-seen-wins in
    `editor → files-links → other → appearance` order, `settingsFile.mode` falling back to the old
    `appJson.mode`), and `drainEnabledOnLocal` turns a legacy `enabledOn: "local"` into a
    `thisDeviceItems` entry. They are deferred behaviour, not retired behaviour, and each has its
    own tests.
  - **The migration chain is v2 → v3 → v4, run in memory on one load** (`classifySettings`'s
    `{kind:"migrate", from}`, `MIGRATABLE_SCHEMAS = [2, 3]`): a document that skipped every release
    in between still lands on v4 in one load, saved once. `v2Migration.ts` is unchanged by this
    release — it still produces an intermediate v3-shaped document, `runsOn` included — and
    `core/v4Migration.ts` then takes that document the rest of the way: `enabled` → `synced`;
    `runsOn.device` becomes a `perClass` rule on the carrier, `runsOn.force` is dropped (all three
    real vaults had zero of them at migration time); `bratIndex` folds into `Item.bratRepo`.
    **`thisDeviceItems` migrates in two halves, and the second is not optional**: a v3 pin
    did not merely mask its element, it FORCED it, so the fleet half (a `this-device` rule on the
    carrier, preserving WHO decides) and the local half (the pinned element's CURRENT state, frozen
    into `config-sync-device-elements` by `main.ts`'s `freezeThisDeviceElements`, preserving WHAT was
    decided) are both required — the rule alone would turn a force into a pass-through, and the
    first apply after the migration could move a switch the user had pinned. The migration also
    reconstructs the STRUCTURAL this-device rule v3 never wrote down: every core/community entry
    whose card was off (`synced !== true`) gets a stored `this-device` rule ahead of any class rule
    its `runsOn` would otherwise imply, because v3 masked such an entry unconditionally and never
    recorded that as a rule — without it, the first capture after upgrading would publish every
    locally-enabled plugin the user had never chosen to sync. Verified: the three list files
    (`community-plugins.json`/`core-plugins.json`/`appearance.json`) are byte-identical before and
    after the migration (`tests/enablementRuntime.test.ts`) — the one hard behavioral assertion it
    makes. **One user-visible behavior does change on the far side of the upgrade, by design**: a
    plugin nobody ever wrote a rule for now follows the shared on/off list once the list itself is
    synced, where in v3 an item with no `runsOn` had nothing forcing it to reconcile with the fleet
    at all — so the first sync after upgrading converges whatever switch differences had silently
    accumulated between devices (some plugins may turn on or off). Disclosed in GUIDE and README,
    not narrated further here.
- **`store.lock.json`** — capture metadata, `version: 3`. Top level: `version` (the lock's own format
  version; absent = 1, this build writes `STORE_LOCK_VERSION` = 3 — see the Lock model invariant for
  what a higher one means), an optional `syncedWatermark` (the lineage, moved only by a pull;
  absent = a v1 lock, whose `capturedAt` answers for it), and `capturedAt`, which since v2 is
  DERIVED — `max(items[*][*].capturedAt)`, describing this store's own content. Then `items`, nested
  **section → id → entry** (v2's flat `groups[name]`, converted on the way in). Per entry:
  `source: { kind: "plugin" | "app", version }` — one object where v2 encoded the kind in the field
  NAME (`sourcePluginVersion`/`sourceAppVersion`), so adding a third source later is a value change;
  an optional
  `capturedAt` (when THIS item was captured) and `hash` (`"sha256:<digest>"`, a fingerprint of its
  WHOLE store copy — base plus `__scopes__` sidecars, or every file under a folder group's store path
  — absent for ciphertext); `innate?: { desktopOnly?: true }` (what the item IS, independent of
  anything a user chose); and `display?: { label?, elements? }` — this device's best-resolved display
  name and, on the two carrier entries only, id → name for the on/off list's elements. Names, never
  behaviour: `status.ts` never counts `display` as a difference. The labels are healed in place by
  `backfillLockLabels`.
  That `source`/`innate`/`display` partition depends on the version gate: `manifest.ts`'s entry
  validator makes an OLDER reader throw on an entry with neither version field, and a restructured
  entry looks exactly like that. **v3 is gated, so the constraint
  is lifted.**
  The version and watermark are declared on the types but read through `manifest.ts`'s narrowing
  helpers (`storeLockVersion`, `lockWatermark`, `lockEntryCapturedAt`, `lockEntryHash`, `lockLabel`,
  `lockElementLabels`) rather than off the
  parsed object — they ride the carried tail and are never validated on the way in, deliberately: a
  value this build cannot make sense of must survive untouched (invariant II.1) rather than be
  dropped by a normalising parse, and must not be acted on either. `items` is typed as a plain
  two-level record rather than `Record<StorageSection, …>` for the same reason: a section a NEWER
  build writes has to ride through untouched like any other unknown key, and a required-key type
  would make the top level the one place carrying did not hold.
  **A refusal gate must ask `declaredStoreLockVersion(raw)` on the raw text, before parsing** — see
  the Lock model invariant above for the full argument; the one sanctioned gate that reads a PARSED
  version is `backfillLockLabels`' inline check, which is declining to WRITE, not deciding whether
  the store may be read at all.
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

- **New group type** (today `file`/`folder`): extend `pathing.ts` and the capture/apply paths in
  `ConfigSyncCore.ts`.
- **New sync mode** (today `plain`/`fields`/`encrypted`): add it in `modes.ts` (and `crypto.ts`
  if it transforms bytes).
- **New remote type** (today git / vault): extend the `Remote` union in `types.ts`, add the
  desktop transport in `src/external/` (dynamic-imported from `main.ts`), and the freshness check
  in `status.ts`.
- **New external store target**: implement `ExternalStoreReader`/`ExternalStoreWriter` from
  `ConfigSyncCore.ts` and wire `planImport`/`pushExternal`.

## Testing & gates

Commands, gates and the smoke workflow live in [../CONTRIBUTING.md](../CONTRIBUTING.md).
The invariants the gates protect: unit tests run over the pure core (in-memory `FileIO` +
fake `PluginHost`); lint is held at 0 errors / a 57-warning ceiling with no inline
disables (sentence-case exceptions go through `ignoreWords` in `eslint.config.mts`); all
CSS uses Obsidian theme variables (`scripts/check-no-hardcoded-color.sh`), with
`body.is-mobile`/`body.is-phone` scoping for touch; live checks run against `dev/vault/`,
never a real vault.

## Current state & how to resume

- The version in `manifest.json` is the source of truth for the current release; what each
  release changed is in [../CHANGELOG.md](../CHANGELOG.md).
- **Parked backlog** (deferred by the maintainer — don't start without an explicit pick):
  1. UI audit polish — `design/DESIGN.md`'s Open items (remaining: one undecided TS-only class
     (`-cm-unified`), micro font sizes, text-on-fill variable split, border-radius tiers, the
     shared `-fpill` class; dead-CSS and emoji-remnant findings are resolved).
  2. Capture/pull interruption robustness (crash-marker vs full atomicity — direction undecided).
  3. Run-history file diffs (unified diff per changed file, with a size cap).
- **Release flow**: see [../CONTRIBUTING.md](../CONTRIBUTING.md) (changelog entry → version bump →
  push tags → CI draft → publish).
- **A release that changes a persisted format writes an [../UPGRADING.md](../UPGRADING.md) entry
  before it ships.** Two things belong there and nowhere else: the update ORDER, when an older
  device would react to the new format by resetting rather than refusing, and any behaviour that
  differs on the far side of the migration. Both are the kind of thing a user can only act on
  before they sync, so a footnote in the changelog is not enough.
