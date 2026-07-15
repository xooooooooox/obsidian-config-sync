# Switch-List Local Decisions (0.23.x)

Give the two plugin on/off switch lists (`community-plugins.json`, `core-plugins.json`) a
per-device **local decision** mechanism, so a device can keep its own choices for specific
plugins while the rest of the list still syncs. Design 定稿 via the visual companion
(`switch-exceptions.html`, 2026-07-15): symmetric strip semantics, both switch lists, edit UI in
the config-panel item expansion, Sync Center badge + ⌂ detail rows.

## Problem

The switch-list items are whole-list mirrors (catalog copy: "Mirrors the whole list: plugins
enabled only on the target device get turned off"). When devices legitimately differ — B doesn't
install or doesn't want some plugins A uses — the item can never stabilize:

- B applies A's list → B's own enables get turned off; entries B lacks get pruned by Obsidian's
  next write → `differs` again.
- B captures → A pulls → A loses A's choices. Perpetual ping-pong; the item is effectively
  unusable across heterogeneous devices.

Root cause: the list's value is a blend of shared intent and per-device intent, but sync only
has whole-file semantics.

## Design (定稿 decisions)

- **D1 — per-device exceptions:** each device may mark plugin ids as *local decisions* for a
  switch-list group. Marked ids never sync in either direction on that device.
- **D2 — symmetric strip semantics:** exceptions behave like strip does for fields — a device's
  excepted ids are **removed from the store copy at capture** (the store holds only shared
  intent) and **keep their local state on apply**.
- **D3 — both switch lists:** `community-plugins` (JSON `string[]`) and `core-plugins`
  (JSON `Record<string, boolean>`), one mechanism.

### Data model (device-local)

`ConfigSyncSettings` gains:

```ts
switchExceptions: Record<string, string[]>; // group name → excepted plugin/core ids
```

Default `{}`. This is per-device state, so `selfPresetRules()` gains a third locked strip rule
`{ pattern: "switchExceptions", action: "strip", locked: true }` — `ensureSelfPresets` is
idempotent and adds the new preset to existing self groups on the next commit/migration, so
exceptions never travel via the self item.

### Core semantics (pure, testable — new `src/core/switchList.ts`)

The two file shapes get shape-aware set operations:

```ts
export type SwitchList = string[] | Record<string, boolean>;

// capture: local minus this device's exceptions (order preserved for arrays; key removal for maps)
export function captureSwitchList(local: SwitchList, exceptions: string[]): SwitchList;

// apply: store's shared intent + this device's current state for excepted ids.
// Arrays: (store − exceptions) in store order, then (local ∩ exceptions) in local order.
// Maps: store entries, minus excepted keys, plus local entries for excepted keys (absent stays absent).
export function applySwitchList(store: SwitchList, local: SwitchList, exceptions: string[]): SwitchList;

// status: equal after masking this device's exceptions on BOTH sides (the store may carry an
// excepted id captured by a device that syncs it).
export function switchListsEqual(local: SwitchList, store: SwitchList, exceptions: string[]): boolean;
```

Malformed content (neither shape) → fall back to plain byte comparison / passthrough (no crash).

### Threading through capture/apply/status

- `CoreContext` gains `switchExceptions: Record<string, string[]>` (device-local, like
  `passphrase`; `main.ts` supplies `this.settings.switchExceptions`; the tests' ctx factory
  defaults `{}`).
- A group is a switch list iff its name is in `SWITCH_LIST_GROUPS = new Set(["community-plugins",
  "core-plugins"])` (core constant; matches the existing `SWITCH_LISTS` filename set in catalog).
- `captureGroup`: for switch-list groups, transform content with `captureSwitchList` before the
  normal mode pipeline. `applyGroup`: compute the written content via `applySwitchList(store,
  local, exc)`. `statusForGroups`/`contentUnchanged`: use `switchListsEqual` for switch-list
  groups (exceptions-masked comparison) instead of byte equality.
- Groups with no exceptions (`[]`) behave byte-for-byte as today (the equal/order-preserving
  path must be identity — regression guard).

### UI (定稿 per mockup)

**Config panel — item expansion** for the two switch-list items gains a **"Local decisions
(this device)"** segment:

- Row list = union of (ids in local list) ∪ (ids in store copy) ∪ (installed plugins / runtime
  cores), each row: display name + state hint ("enabled here · in store" etc.) + a
  **synced ↔ local decision** toggle. Marked rows tinted with the caution accent.
- The item's header shows an **"N local decisions"** badge (caution-tinted) when N > 0.
- Toggling writes `settings.switchExceptions[group]` (device-local; normal saveSettings, no
  group/commitGroups involvement) and refreshes status.

**Sync Center** — the switch-list row's status hint appends "· N local decisions" when N > 0;
the row expansion's change detail marks excepted ids with `⌂` (kept local) instead of `±`.
Colors bind to palette vars (caution = `--color-orange`); zero hardcoded color.

## Edge cases

- **Excepted id absent locally and in store:** contributes nothing anywhere (harmless stale
  entry; the UI row list won't show it unless installed).
- **Not-installed plugins from the store:** unchanged — the "Not installed on this device"
  section and its install policies are orthogonal to this mechanism.
- **core-plugins map `false` vs absent:** apply preserves the local *entry state* for excepted
  keys — present:false stays present:false, absent stays absent.
- **Exceptions on non-switch-list groups:** not representable (UI only offers the segment on the
  two switch items; core consults the map only for `SWITCH_LIST_GROUPS`).
- **Legacy stores** (captured before this feature, containing another device's now-excepted
  ids): masked comparison (D2 status rule) keeps the item stable regardless.

## Testing

- **Unit (`tests/switchList.test.ts`):** all three functions × both shapes × empty-exceptions
  identity × order preservation × map false/absent preservation × malformed fallback.
- **Existing suites:** ctx factory gains `switchExceptions: {}`; no behavior change for
  non-switch groups (243 baseline stays green).
- **Controller smoke (dev vault):** mark an enabled-here plugin as local decision → capture →
  store copy lacks it; doctor the store list → status stays in-sync when only excepted ids
  differ, `differs` when a synced id differs; apply → excepted id keeps local state, synced ids
  follow store; UI: segment toggle round-trip, badge, ⌂ detail rows; two-theme screenshots.
- Gates: build/lint (0 errors, 65-warning baseline), color scan, node suite green.

## Scope

`src/core/switchList.ts` (new), `src/core/ConfigSyncCore.ts` (ctx field + three hook points),
`src/core/catalog.ts` (`SWITCH_LIST_GROUPS`, third self preset), `src/core/status.ts` or
`src/core/modes.ts` (comparison hook — wherever `contentUnchanged` lives), `src/main.ts`
(settings field + ctx wiring), `src/ui/SettingTab.ts` (Local-decisions segment + badge),
`src/ui/SyncCenterView.ts` (hint + ⌂ detail), `styles.css`, tests. Parked separately: backlog
#5 (capture/pull interruption robustness — direction a/b/c still undecided).
