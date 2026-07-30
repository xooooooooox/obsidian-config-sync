# Remote Pane: Self Exclusion, Expandable Diffs, Honest Direction Copy — Design

Mockup (定稿): https://claude.ai/code/artifact/75cb4ca2-f104-4901-be4a-b5e356525245 — all UI copy below is final.

Three problems from cross-vault device testing (kickstart vault pulling from its source vault
via a `type: "vault"` remote, pull-only by convention):

1. **Config Sync itself loops forever.** The two vaults' sync contracts intentionally diverge
   (the pulling vault keeps its own device choices), so the self item's store copies always
   differ. The remote comparison reports it every time; resolving the pull conflict with
   "remote" overwrites the local contract, forces the user to redo their choices, and the
   difference immediately returns. There is no way to say "this item stays separate on this
   remote".
2. **`−2` with no way in.** A remote diff row shows count chips only — no file names, no
   content diff. The user can't see *which* two files exist only locally, and Pull never clears
   the row (Pull is additive by design: `applyImport` never deletes local-only files), while
   the pane's "Pull would bring these changes" copy claims otherwise.
3. **Naming regression.** Device-side item rows render companions two-tone as "Parent › Name"
   (`renderRuleName`), but the remote diff row builds its own span from the bare label — the
   snippets folder shows as "CSS snippets" instead of "Appearance › CSS snippets".

Direction asymmetry (existing behavior, unchanged — the copy in Item 3 must state it):
**Push mirrors** the local store (writes changed/missing files at the remote AND deletes remote
files the local store lacks — `pushExternal`); **Pull is additive** (writes remote-only and
conflict-resolved files locally, never deletes — `applyImport`).

## Item 1: per-remote exclusion of Config Sync's own settings

The self store copy carries the whole sync contract (`items` config, custom groups, field
rules; `rootPath`/`remotes` are already stripped by the locked presets). Contract propagation
via adopt is right for same-lineage stores and wrong for a vault that deliberately keeps its
own setup — so exclusion is **per remote, opt-in**, default off (current behavior preserved).

**Schema (`src/core/types.ts`):** both `Remote` variants gain

```ts
excludeSelf?: boolean; // true = Config Sync's own settings never travel to/from this remote
```

**Validation (`src/core/manifest.ts` `parseRemote`):** accept optional `excludeSelf`; if
present and not a boolean, throw a `ManifestValidationError` naming the remote and showing the
expected form. Include the field in the returned object only when `true` (absent stays the
clean/default serialization).

**Self rel predicate (`src/core/ConfigSyncCore.ts`, exported next to `SELF_STORE_DATA_REL`):**

```ts
export function isSelfStoreRel(rel: string): boolean {
  return rel === SELF_STORE_DATA_REL || rel.startsWith(SELF_STORE_DATA_REL + ".__scopes__.");
}
```

covers the data file and its device-class sidecars (`sidecarStoreSuffix`).

**Core plumbing — explicit options param, no defaults (all call sites and tests updated):**

- `planImport(ctx, reader, opts: { excludeSelf: boolean })`: when set, drop self rels from BOTH
  file maps before `classifyMerge` — the self file can no longer become a conflict, a
  `writeFiles` entry, or an `identical`/`keptLocal` entry. `remoteGroupsFrom` still reads the
  remote self data.json for group attribution (read-only, unaffected).
- `applyImport`: unchanged — it consumes the already-filtered plan; the self lock entry never
  enters `remoteWonNames`, so the local lock keeps its own self lineage.
- `pushExternal(ctx, writer, opts: { excludeSelf: boolean })`: when set, skip self rels in the
  write loop AND exempt the remote's self rels from the mirror-delete loop — the remote's own
  contract is left untouched in both directions.
- `diffRemote(ctx, reader, opts: { excludeSelf: boolean })`: when set, skip self rels on both
  sides — no diff entry for the self group.
- `remoteLockAhead(localRaw, remoteRaw, ignoreGroups: string[])`: new explicit param; the
  per-group comparison skips names in `ignoreGroups`. Callers pass
  `remote.excludeSelf === true ? [SELF_GROUP_NAME] : []`. Without this, a divergent self lock
  entry keeps "remote has newer version info — Pull refreshes it" alive forever.
- `checkRemote` (whole-store `capturedAt` comparison) is untouched: a self-only capture on the
  other side may still flip the arrow once; Pull then converges the lock. Accepted noise.

**Settings UI (`src/ui/SettingTab.ts`):** `RemoteDraft` gains `excludeSelf: boolean`;
`toDraft`/`toCandidate` round-trip it (candidate carries the key only when true). The remote
form (both types) gains a toggle line under the type/name row. Copy (final):

> **Keep Config Sync's own settings out of this remote**
> For a vault that keeps its own setup: Pull and Push skip Config Sync's settings, and the
> comparison stops reporting them.

**Remote pane note (`renderRemoteDetail`):** when `remote.excludeSelf === true`, render one
muted line near the matched-items line (always, not only when the copies differ — it explains
why Config Sync never appears here). Copy (final): `Config Sync's own settings stay out of
this remote`. The view reads the flag off the `Remote` object it already holds — the
`deepDiff` host signature is unchanged.

**Conflict modal discoverability (`src/ui/ConflictModal.ts`):** when a file conflict's rel
`isSelfStoreRel`, add one hint line under that conflict's diff. Copy (final): `If this vault
keeps its own Config Sync setup, you can leave it out of this remote — Settings → Remotes.`
(This is the bridge for users who hit the loop before finding the toggle.)

## Item 2: remote diff rows — real names, expandable file detail, content diffs

**Data (`src/core/status.ts`):** `RemoteDiffEntry` carries per-file detail instead of bare
counts:

```ts
export interface RemoteDiffFile {
  itemRel: string;                       // display path within the item (resolve()'s itemRel)
  kind: "added" | "updated" | "deleted"; // added = only at the remote; deleted = only in the local store
  local: string | null;                  // content in the local store; null when absent
  remote: string | null;                 // content at the remote; null when absent
}

export interface RemoteDiffEntry {
  group: string;
  files: RemoteDiffFile[];
}
```

`diffRemote` already reads both sides to compare `updated` files — it now keeps those strings,
and additionally reads content for `added` (remote side) and `deleted` (local side) rows in the
same pass. Store files are small text; entries live only for the pane render. The `−`/`+`/`~`
chip counts and `hasChanges`-style guards derive from `files` (`files.length > 0`,
`files.filter(f => f.kind === ...)`).

**Row rendering (`renderRemoteDiffEntry`, `src/ui/SyncCenterView.ts`):**

- Name via `this.renderRuleName(row, e.group, findGroupByName(this.groups, e.group)?.label)` —
  the same two-tone "Parent › Name" as device-side rows (fixes "CSS snippets" →
  "Appearance › CSS snippets"). Count chips stay as today.
- The row becomes expandable (chevron ▸/▾, same affordance family as the section folds).
  Expanded: one line per file in kind order added → updated → deleted, each with its
  `+`/`~`/`−` glyph (`is-add`/`is-upd`/`is-del`) and `itemRel`.
- Each file line expands further into a content diff via the existing `renderDiffPanel` +
  `jsonSortedView` normalization (mirror of the item-detail "· diff ▾" pattern at
  ~SyncCenterView.ts:1996-2040): `updated` shows local vs remote; `added` shows an empty left
  side vs the remote content; `deleted` shows the local content vs an empty right side. Side
  labels (final): left `your store`, right the remote's name; an absent side's label reads
  `not in your store` / `not at {remote}`.

**Matched-items line (`renderRemoteDetail` ~:2250):** the expanded name list uses the composed
`fullName()` (parent-prefixed) instead of the bare `displayName`, for consistency with the
rows above it.

## Item 3: honest direction copy

Replace the single `directionText` line with a summary that separates what the aligned action
would actually do from what it would NOT do (copy final, per mockup):

- **Pull-aligned** (`remote-newer`/`same`/`unknown`/`no-store`):
  - incoming = total `added` + `updated` files across entries: `Pull would bring N file(s)`;
    when incoming is 0 (kept-local differences only): `Pull would bring nothing`.
  - if any `deleted` (local-only) files exist, a separate muted line:
    `K file(s) exist(s) only in your store — Pull never removes files; Push would add
    it/them to {remote}.`
- **Push-aligned** (`remote-older`):
  - outgoing = total `updated` + `deleted` (local-only) files: `Push would send N file(s)`;
    when outgoing is 0: `Push would send nothing`.
  - if any `added` (remote-only) files exist, a separate muted line:
    `K file(s) exist(s) only at {remote} — Push would remove it/them there; Pull would bring
    it/them here.`

The per-row chips keep their current meaning; the summary is where directionality is explained
once, honestly, in both directions.

## Out of scope

- Pull-side deletion propagation stays out: Pull remains additive by design ("never deletes
  local-only files or groups"). Convergence for intentionally-deleted dir members is local:
  delete the files in the vault, capture the item — dir capture already prunes the store
  (`captureGroup`'s mirror pass).
- Per-remote exclusion of arbitrary items (beyond self): no second concrete case yet — YAGNI.
- Acknowledge/dismiss for kept-local rows: the expandable detail + honest copy cover the need.
- The self pane's adopt/capture delta rows (`renderSelfDelta`) keep bare labels — they list
  sync-list membership, not companion files.

## Docs

- `README.md` / `README.zh.md`: the remotes section gains the exclusion toggle; the Sync
  Center remote-pane description gains expandable rows + the split direction summary.
- `docs/ARCHITECTURE.md`: `core/status.ts` bullet (RemoteDiffFile, diffRemote/remoteLockAhead
  signatures), `core/ConfigSyncCore.ts` bullet (planImport/pushExternal options,
  `isSelfStoreRel`).

## Tests (Node suite, baseline 802)

- `diffRemote`: per-file detail (contents on both/one side per kind); `excludeSelf` drops self
  data + sidecar rels from both sides.
- `planImport`/`applyImport`: with `excludeSelf`, a divergent self file produces no conflict,
  no write, and the local lock's self entry survives an otherwise remote-winning pull.
- `pushExternal`: with `excludeSelf`, the local self copy is not written and the remote's self
  copy is not mirror-deleted.
- `remoteLockAhead`: `ignoreGroups` suppresses a self-only lock difference; other groups still
  flag.
- `parseRemote`/`validateRemotes`: `excludeSelf` round-trips when true, absent when false/
  omitted, rejects non-boolean with a clear message.
- `isSelfStoreRel`: data file, both sidecar suffixes, non-self rels.
