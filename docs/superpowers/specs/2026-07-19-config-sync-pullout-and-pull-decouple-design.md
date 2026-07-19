# Config Sync pull-out + Pull decoupling

Real-vault cold-start finding (2026-07-19, post-1.0.0): on a fresh device B that has both the
store (via note-sync) and A's remote configured, opening the Sync Center shows the **Adopt**
banner and the remote shows **newer**; clicking **Pull** makes the Adopt banner silently vanish.

Root cause is a data-flow shortcut plus a UI framing problem, not a data-model flaw. This design
removes the shortcut (Pull becomes pure store transport) and pulls config-sync's own layer out of
the generic plugin list into a dedicated sidebar destination with an explicit, bidirectional
adopt/capture surface. **The data model does not change.**

## Terminology

- **Sync list** = `SyncManifest.groups` = `settings.groups` (a list of `SyncGroup`). It is *not*
  `manifest.json`. It lives in config-sync's own `data.json` and is itself synced via the self
  group `plugin-config-sync` (`SELF_GROUP_NAME`). `loadManifest` reads it through
  `ctx.groupsIO.read()` (= `this.settings.groups`).

## Problem

1. **Pull silently mutates the sync list.** `applyImport` (`ConfigSyncCore.ts`) does
   `groups = [...groups, ...plan.auto.addGroups]` then `await writeGroups(ctx, groups)` — importing
   the remote's group definitions into `settings.groups`. On a fresh device (0 groups) a Pull
   therefore adopts the whole list, so `bootstrapOffer` (`main.ts:368`, gated on
   `settings.groups.length > 0`) starts returning null and the Adopt banner disappears. This is a
   **shortcut** that bypasses the self-config model's own D2 ("propagation is self-capture"): the
   list should converge by applying the `plugin-config-sync` item, not by a side-write in Pull.
2. **config-sync is framed as a generic plugin.** Its self item sits in the Community/Beta list
   like Dataview. Applying it — which *is* "adopt/update what this device syncs" — reads as an
   opaque "Config Sync — to apply" row; the items it would add/remove are invisible.

Confirmed safe to build on: the self group is forced to `mode: "fields"` with **locked** preset
strips for `rootPath` / `remotes` / `switchExceptions` (`catalog.ts` `selfPresetRules` /
`ensureSelfPresets`), so applying it converges the shared list and shared prefs while each device
keeps its own store pointer, remotes, and switch exceptions. No clobber of device-local settings.

## Design decisions (定稿 2026-07-19)

- **D1 — Pull is pure store transport.** `applyImport` stops writing `settings.groups`; Pull
  merges store files + `store.lock.json` only. Group-definition additions/conflicts no longer
  land in settings through Pull. The sync list converges exclusively through the self item's
  apply (adopt).
- **D2 — config-sync is pulled out in the UI.** It is removed from the item list/scopes and given
  a dedicated top-of-sidebar destination **"Config Sync"** with a state badge, opening a
  dedicated bidirectional pane. No top card, no separate banner.
- **D3 — adoption granularity stays all-or-nothing** (as in 1.0.0). The delta (+/−) is shown as
  information; one **Adopt all** action. Per-item adoption and per-device list divergence are
  explicitly out of scope (shelved).
- **D4 — the pane is bidirectional with an adopt-first guard.** States: in-sync / to-adopt (↓) /
  to-capture (↑) / both (⚠). When both directions are pending, Capture is gated behind Adopt
  (git-style pull-before-push) because capturing the self item is a whole-file write that would
  otherwise overwrite another device's list additions.
- **D5 — supporting fixes:** the leftover classifier must not flag store files that the store's
  own sync list defines; applying the self item must reload settings so the adopted list takes
  effect.

## Part 1 — Data flow (Pull decouple)

`applyImport` (`ConfigSyncCore.ts`): remove the two lines that mutate the sync list —
`groups = [...groups, ...plan.auto.addGroups]` and the subsequent `await writeGroups(ctx, groups)`
(and the definition-conflict branch that maps `settings.groups`). Keep everything that writes
**store** content: `plan.auto.writeFiles`, file-conflict resolutions, `pruneEmptyDirsUnder`, and
the `store.lock.json` merge. `planImport`/`classifyMerge` are unchanged (they still *compute*
`addGroups`/definition conflicts); Pull simply no longer *applies* the group-definition part.

Consequence: `PendingPull`/`ConflictModal` for Pull now only surface **file** conflicts. Any
divergence in config-sync's own `data.json` shows up as a file conflict on the self-copy path
(store content), resolved like any other file; the *list-level* convergence is the pane's job
(Part 2), not Pull's.

`pushExternal`/Capture semantics are unchanged in this change (the adopt-first guard in Part 2
prevents the stale-capture clobber at the UI level).

## Part 2 — UI: config-sync pulled out

### Sidebar

A new destination **⚙ Config Sync** is added at the **top** of the sidebar (above
`THIS DEVICE ↔ STORE`), a peer of History/Remotes, with a state badge:
`↓N` to adopt · `↑N` to capture · `⚠` both · `✓` in sync (badge hidden when in sync is acceptable).

New `PanelScope` variant (e.g. `{ kind: "self" }`) selected by clicking the entry; rendered by a
new `renderConfigSyncMode(main)`. The self item (`SELF_GROUP_NAME`) is **excluded** from the
normal item list, the sidebar scope counts, filter pills, and footer totals (it is surfaced only
in this pane).

### The pane (`renderConfigSyncMode`)

Direction comes from the self item's existing status (`statusForGroups` on
`SELF_GROUP_NAME`): to-apply → **to adopt**, to-capture → **to capture**, differs-both → **both**,
in-sync → **in sync**. The +/− delta is the by-name diff between the store self-copy's groups
(`store/configdir/plugins/config-sync/data.json` → `groups`) and local `settings.groups`.

- **S0 in sync:** minimal — "Config Sync — 50 items, in sync." plus a device-config summary block
  (store folder, tracked count, PKM mode) and **Open Config Sync settings →**.
- **S1 cold-start** (`settings.groups.length === 0`, store has a self-copy with groups): "Found a
  configuration in the store — N sync items, captured … Adopt to set up this device." with the
  existing "don't Capture first" caution. **On a fresh device the Sync Center opens straight to
  this pane** (auto-select the self scope when `bootstrapOffer` is non-null) instead of an empty
  item list.
- **S2 to adopt:** "Updates from the store" — delta chips (+Zotero, +ZotLit, −Emoji Toolbar) as
  information + **Adopt all** (with the "adopting adds to the list; you still apply per item"
  note). Adopting = `adoptConfiguration` (apply self item + reload). Adopted items then appear in
  the normal scopes as apply-able rows.
- **S3 to capture:** "Local changes not yet in the store" — delta (+Kanban) + **Capture**.
- **S4 both (⚠):** "Adopt first, then capture." Adopt block emphasized; Capture **disabled** until
  the adopt completes.

`adoptConfiguration` (`main.ts:466`) is reused as the adopt action (it already injects the self
group if missing, applies it, and reloads). The cold-start bootstrap banner
(`renderBootstrapBanner`) and post-adopt guidance (`renderAdoptGuidance`) are folded into this
pane's S1 / post-adopt state; the floating banners are removed.

## Part 3 — Supporting fixes

- **Leftover classifier** (`leftover.ts` `leftoverStoreRels` + its caller): a store file is
  leftover only when attributable to **neither** the local sync list **nor** the store's own sync
  list (the self-copy's `groups`). Pass the union (local groups ∪ store-self-copy groups) so
  just-pulled, not-yet-adopted data is treated as *pending*, never as deletable junk.
- **Apply-self reload:** the normal apply path (`applyItems`) must call `loadSettings()` after a
  run that applied `SELF_GROUP_NAME`, so an adopted/updated sync list takes effect in memory
  (currently only `adoptConfiguration` does this).

## State machine (badge ↔ pane)

| State | When | Badge | Pane |
|---|---|---|---|
| S0 in sync | self item in-sync | `✓` / hidden | summary + settings link |
| S1 cold-start | `groups.length===0`, store has config | setup | Adopt configuration (auto-landed) |
| S2 to adopt | self item to-apply | `↓N` | delta + Adopt all |
| S3 to capture | self item to-capture | `↑N` | delta + Capture |
| S4 both | self item differs both ways | `⚠` | Adopt first (Capture gated) |

## Non-goals

- No data-model change (single `data.json`, self-config model, self group with locked strips).
- No per-item adoption / per-device list divergence (D3).
- No change to Capture/Push wire semantics beyond the UI adopt-first guard.
- Approach C (sync list as a standalone store artifact) is rejected — it reintroduces the
  pre-0.22.0 "pull mirror-overwrites the manifest, loses local-only groups" bug.

## Testing

- **core** (`ConfigSyncCore` / `tests/core.test.ts`): a Pull whose plan has `addGroups` no longer
  changes `settings.groups` (groups before == groups after), while store files + lock are still
  written; file conflicts still resolve.
- **leftover** (`tests/leftover.test.ts`): a store file defined by the store self-copy's groups
  but absent from the local list is **not** leftover; a file in neither is.
- **apply-self reload**: applying a run containing `SELF_GROUP_NAME` triggers a settings reload
  (assert via the host seam / a fake that records `loadSettings`).
- **panel model** (`tests/panelModel.test.ts`): `SELF_GROUP_NAME` is excluded from item-list
  scopes/counts; the config-sync scope's direction maps to S0–S4 from the self item's status; the
  delta = store-self-copy groups vs local groups.
- **Live dev-vault**: fresh device auto-lands on the Config Sync pane (S1); forge a store-list
  change → S2 with delta → Adopt all → items appear in scopes, reload took effect; forge a local
  list add → S3 → Capture; both pending → S4 with Capture gated until adopt; Pull no longer makes
  the pane's state jump on its own (it only refreshes the store).
- **Gates**: `npm test`, lint 67-warning baseline, `check-no-hardcoded-color.sh`, all pane CSS via
  theme vars + mobile scoping.
