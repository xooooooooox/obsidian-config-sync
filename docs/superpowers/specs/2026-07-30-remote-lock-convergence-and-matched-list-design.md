# Remote lock convergence + matched-list exclusion honesty

Date: 2026-07-30
Status: pending user review
Target: 2.10.1 (patch — behavior fixes only, no new UI, no new copy)

## Context

2.10.0 shipped per-remote self exclusion and the expandable remote diff. Continued live
testing of the same cross-vault setup (a kickstart vault pulling from its source vault,
`excludeSelf: true`, both stores schema v2) surfaced two visible defects and one latent
one that turns out to be the root of the second. Nothing here adds UI or copy.

## Problem 1 — the excluded self item appears in the "N more items match" list

With the exclusion on, the remote pane's matched list renders "… · Config Sync · …" two
lines above the standing note "Config Sync's own settings stay out of this remote".

Root cause (`src/ui/SyncCenterView.ts:2247-2249`): the matched list is "this device's
groups minus the groups with diff entries". `diffRemote` skips the self item entirely
when the remote excludes it, so the self group never has a diff entry and falls into the
matched bucket. Excluded is not matched — the item was never compared.

## Problem 2 — "remote has newer version info; Pull refreshes it" never clears

After Pull (0 changed, stores fully matching), the hint stays forever. Verified against
the live locks: exactly one offending entry — the remote lock carries
`plugin-remotely-save: {sourcePluginVersion: "0.5.25"}` and the local lock has no entry
for that name. `remoteLockAhead` (`src/core/status.ts:227`) counts a remote entry that
is missing locally as ahead, so the hint is permanent.

Why no local flow can create the entry:

1. The plugin is uninstalled on the pulling vault (and its item is scoped away), so
   `plugin-remotely-save` is not in the locally compiled group registry.
2. Both stores nevertheless contain the identical
   `store/configdir/plugins/remotely-save/data.json` — a legitimate leftover of additive
   pulls. The store is a superset of the local contract by design.
3. Pull's lock merge attributes identical files to a group name via the LOCAL registry
   only (`src/core/ConfigSyncCore.ts:872-875`, `groupForStoreRel(groups, …)`); the name
   resolves to `""`, so the remote lock entry is never adopted.
4. The remote-side fallback that should catch this is dead for schema v2 (Problem 3).
5. Even a hand-edited lock entry would not survive: capture rebuilds the lock from
   scratch and writes entries only for compiled groups
   (`src/core/ConfigSyncCore.ts:271` — fresh `groups: {}`, loop over the registry).

So the lock's two writers (pull merge, capture rebuild) both bound the lock by the local
contract, while the store legitimately holds content outside it. The version info for
such content can never take up residence locally, and the hint's promise ("Pull
refreshes it") is a lie.

## Problem 3 (latent, root of 2) — `remoteGroupsFrom` returns [] for schema v2 stores

`src/core/ConfigSyncCore.ts:771-782` reads the remote's self store copy and only
recognizes the schema v1 shape (`Array.isArray(parsed.groups)`), falling back to the
deprecated root manifest, else `[]`. A v2 self copy persists `items` + `customGroups`
and no `groups` key — verified against the live remote store (`schemaVersion: 2`, no
`groups`). Every v2↔v2 comparison therefore runs with an empty remote registry:

- `classifyMerge`'s `owningGroupName` remote fallback never fires — which is why
  Problem 2's identical-file attribution has no second chance;
- `diffRemote`'s documented fresh-device fallback ("attribution falls back to the REMOTE
  manifest — otherwise every remote file would land in the metadata pseudo-group",
  status.ts:251-254) is dead code for v2 stores: a fresh device diffing a v2 store shows
  remote files under "(other store files)" instead of their real groups.

The v2-aware parser already exists: `storeSelfCopyGroups(json, defs)`
(`src/core/leftover.ts:26`) handles v1 verbatim, compiles v2 `items` + `customGroups`
via `selfListGroups` with `defsForForeignItems` (so items whose plugin is absent on this
device still compile), and yields `[]` for malformed content by documented contract. It
needs `ItemDef[]`, which lives in the plugin (`this.registryDefs`) — core cannot build
it (`buildItemDefs` needs the app's `RegistryEnv`).

## Design

### Item 1 — matched list excludes the excluded self group

`src/ui/SyncCenterView.ts` (`renderRemoteDetail`), extend the matched-list filter:

```ts
const matchNames = this.groups
  .filter((g) => !changedNames.has(g.name) && !(remote.excludeSelf === true && g.name === SELF_GROUP_NAME))
  .map((g) => this.fullName(g.name, g.label));
```

Import `SELF_GROUP_NAME` from `src/core/catalog.ts` if not already imported. The
"✓ N more items match" count corrects itself through `matchNames.length`; the standing
self-note remains the sole explanation of where the item went. The
`entries.length === 0` "remote matches the local store" branch is unaffected.

### Item 2A — `remoteGroupsFrom` learns schema v2 via a CoreContext hook

`src/core/ConfigSyncCore.ts`:

- `CoreContext` gains an injected hook, following the `groupsIO` / `fieldOverlay`
  precedent:

```ts
storeListGroups?: (selfCopyJson: string) => SyncGroup[]; // v2 self-copy list compile (plugin wires storeSelfCopyGroups with its registry defs)
```

- `remoteGroupsFrom` gains `ctx` and routes v2 through the hook; the v1 and legacy
  branches are byte-for-byte unchanged:

```ts
export async function remoteGroupsFrom(ctx: CoreContext, reader: ExternalStoreReader, files: string[]): Promise<SyncGroup[]> {
  if (files.includes(SELF_STORE_DATA_REL)) {
    const raw = await reader.readFile(SELF_STORE_DATA_REL);
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && Array.isArray(parsed.groups)) {
      return validateSyncManifest({ version: 1, groups: parsed.groups }).groups;
    }
    if (ctx.storeListGroups !== undefined) return ctx.storeListGroups(raw); // schema v2: items + customGroups
  }
  if (files.includes(LEGACY_MANIFEST_REL)) {
    return parseSyncManifest(await reader.readFile(LEGACY_MANIFEST_REL)).groups; // compat, deprecated format
  }
  return [];
}
```

- Call sites updated: `planImport` (ConfigSyncCore.ts:793) and `diffRemote`
  (status.ts:254) pass their existing `ctx`. No other callers exist.

`src/main.ts` (`coreContext()`): wire the hook —
`storeListGroups: (json) => storeSelfCopyGroups(json, this.registryDefs)`.

Side effects, all inert or strictly better:

- `classifyMerge` may now see remote group definitions in v2 setups. Definition
  conflicts and `addGroups` remain inert in pull (`pullFrom` filters to file conflicts;
  `applyImport` applies neither — the list converges via adopt, unchanged 2.10.0
  semantics). `group:` identical entries may now appear and adopt lock entries for
  definition-identical groups — desired.
- `diffRemote` fresh-device attribution matches its own comment again for v2 stores.

### Item 2B — pull's lock merge adopts entries for store content outside the local registry

`src/core/merge.ts`: export `owningGroupName` (currently private; it already implements
the two-sided lookup — local first, remote fallback, then `""`).

`src/core/ConfigSyncCore.ts` (`applyImport`, identical-file attribution, lines 872-875):
replace the local-only lookup with the two-sided one:

```ts
if (id.startsWith("file:")) {
  const name = owningGroupName(groups, remoteGroups, id.slice("file:".length));
  if (name !== "") remoteWonNames.add(name);
}
```

(`remoteGroups` is already in scope from `pending`; with Item 2A it is populated for v2
remotes.) Effect: a store file present and identical on both sides whose group exists
only in the remote contract now carries its remote lock entry into the merged local
lock. One pull clears the hint.

Adopting an entry for a group with no local definition is inert data: lock entries only
drive the Outdated / install-target flows, which begin from a local item — a foreign
entry sits dormant until the item is (re)adopted, at which point the stored
`sourcePluginVersion` is exactly the install target wanted.

### Item 2C — capture carries foreign lock entries forward

`src/core/ConfigSyncCore.ts` (`captureAll`'s lock rebuild): after the registry loop
fills `lock.groups` and before the write (line 311), carry forward previous entries
whose name is outside the compiled registry (reuse the already-loaded previous lock; do
not re-read):

```ts
// The store legitimately holds content outside this vault's registry (additive pulls
// never delete, and no local flow prunes another contract's files). Its lock entries
// describe that content — dropping them here would resurrect the remote "newer version
// info" hint after every capture.
for (const [name, entry] of Object.entries(previousLock?.groups ?? {})) {
  if (!(name in lock.groups)) lock.groups[name] = entry;
}
```

(`previousLock` stands for whatever the function already calls its loaded prior lock;
registry groups all have entries by this point — captured fresh, carried forward, or
version-only — so the `name in lock.groups` guard alone keeps registry entries winning.)
Effect: the entry adopted in Item 2B survives subsequent captures, so the hint stays
cleared instead of ping-ponging (capture drops entry → hint returns → pull re-adopts).

Staleness analysis (why unconditional carry-forward is safe): a foreign entry can only
go stale if the store files it describes disappear locally. Pull never deletes, capture
prunes only within compiled groups' directories, and item removal does not prune the
store — so foreign store content persists exactly as long as its entry does. Manual
store surgery is the only way to orphan an entry, and the healing path for that is the
same as today: hand-edit or re-seed the store.

## Out of scope

- Deletion propagation on pull stays additive (hard design).
- `remoteLockAhead`'s heuristic is unchanged — after 2A-2C its "missing/different remote
  entry" rule is truthful again, because pull can now refresh every entry the remote
  store actually backs. The residual theoretical case (a remote lock entry for a group
  with zero store files at the remote) is not reachable through normal flows (capture
  writes an entry and its files in the same pass) and is deliberately left.
- Pull still does not apply definition conflicts or remote-only group additions; the
  sync list converges via adopt only.
- The record-only items from 2.10.0 (ARCHITECTURE parenthetical, `changed` no-op filter)
  stay record-only.

## Tests

`tests/core.test.ts`:

1. **`remoteGroupsFrom` compiles a v2 self copy through the hook.** Remote store whose
   self copy has `schemaVersion: 2` + `items` (no `groups` key); ctx wired with a
   `storeListGroups` stub (or real `storeSelfCopyGroups` over test defs). Returns the
   compiled groups; without the hook, returns `[]` (today's behavior preserved).
2. **Pull adopts a foreign lock entry.** Local registry without group X; both stores
   hold X's identical file; the remote self copy (v2) carries X's item; remote lock has
   an entry for X, local lock does not. After `applyImport`: merged local lock contains
   X's entry verbatim, and `remoteLockAhead(localRaw, remoteRaw, [])` is `false`.
3. **Capture keeps a foreign lock entry.** Previous lock contains an entry whose name is
   not in the compiled registry. After capture: the new lock still contains it,
   alongside fresh entries for the registry groups; on a name collision the registry
   entry wins.
4. Existing lock-merge, excludeSelf, and diffRemote tests stay green; call sites in
   tests gain the new `ctx` argument where they call `remoteGroupsFrom` directly.

Item 1 is DOM-only; it is covered by a real-vault smoke (matched list no longer names
Config Sync while the exclusion is on) rather than a unit test.

## Docs

`docs/ARCHITECTURE.md`: update the `remoteGroupsFrom` / lock-merge sentences
(v2-aware remote list via `storeListGroups` hook; two-sided identical attribution;
capture carries foreign entries forward). No README change — lock internals are not
user-facing documentation.

## Gates

`npm test` (809 + new), `npm run build`, `npm run lint` (0 errors / 57-warning
baseline). Real-vault verification on the pulling vault: one Pull clears the "newer
version info" hint; a subsequent Capture does not resurrect it; the matched list no
longer names Config Sync.
