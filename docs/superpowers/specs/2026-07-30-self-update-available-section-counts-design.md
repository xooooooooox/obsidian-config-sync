# Self Update-Available Surfacing + Section Head Count Semantics — Design

Mockup (定稿): https://claude.ai/code/artifact/37cfc659-f6d8-4cb1-9bab-2b1ff7f397ce

Two bugs from 2026-07-30 device testing (device on Config Sync 2.7.2, store captured on 2.8.0;
Ribbon Organizer sitting in "Outdated on this device"):

1. Config Sync itself is behind the store's captured version, and **no surface says so** — not
   the Outdated section (the self group is excluded from the item list by design), not the
   Config Sync pane (its state machine only reacts to drift `"ahead"`).
2. The "Outdated on this device" section head reads **`0` + `✓ 1`** with one plugin inside —
   the neutral pill counts content-changed rows, but the section's normal case is update-only
   rows whose *content* is in sync, so the head contradicts its own title.

## Item 1: self "update available" advisory

The self layer stays out of the item list and the Outdated section (updating config-sync from
inside a run would unload the code executing the run — no stageable update action can exist).
Instead the drift surfaces as an **advisory** through the pane + the three self pills.

**Pure layer (`src/core/selfPane.ts`):** `selfPaneState` gains one output field:

```ts
versionBehind: boolean; // local plugin version < store's captured version — advisory only
```

- `versionBehind = !isColdStart && drift === "behind"`. The state machine is UNCHANGED —
  behind is orthogonal and can coexist with any state (`insync`, `adopt`, `capture`, `both`).
- Coldstart keeps `versionBehind: false`: the coldstart early-return in `main.ts` (line ~495)
  runs before the lock/availability are loaded, and the coldstart pane is a single-decision
  surface (Adopt). The advisory appears on the very next refresh after adopting.

**Host (`src/main.ts` `selfStatus`, ~line 510):** `SelfSyncInfo` gains

```ts
updateAvailable: { local: string; store: string } | null; // plugin version behind the store's
```

populated when `decided.versionBehind && av.localVersion !== null && av.storeVersion !== null`
(mirror of the existing `versionRefresh` wiring); the two early returns (coldstart, selfGroup
undefined) return `null`.

**Pane (`renderConfigSyncMode`, `src/ui/SyncCenterView.ts` ~line 572):** when
`info.updateAvailable !== null`, render an advisory directly under the title row, in EVERY
state (including `insync` — that's exactly the reported invisible case):

```
┌ config-sync-self-behind (amber left-accent block) ────────────────┐
│ Captured on Config Sync 2.8.0 — this device runs 2.7.2.           │
│ Update before adopting or applying.       [Open Community plugins]│
└───────────────────────────────────────────────────────────────────┘
```

- Copy (final): `Captured on Config Sync ${store} — this device runs ${local}. Update before
  adopting or applying.` — same phrasing family as `versionLine`'s app-anchored amber line.
- Button `Open Community plugins` → `setting.open(); setting.openTabById("community-plugins")`
  (same access pattern as `openConfigSyncSettings`, different tab id).
- No update action, no checkbox — advisory only, for the reason above.

**Pills (`selfStatePill`, ~line 518):** when `info.state === "insync" &&
info.updateAvailable !== null`, return `{ text: "update available", cls: "is-behind" }` instead
of `{ text: "in sync", cls: "is-ok" }`. Non-insync states keep their direction pills (the pane
advisory still shows). This propagates automatically to all three surfaces that reuse
`selfStatePill`: sidebar self entry, pane title, header self-chip.

**Chip icon (`renderSelfChip`, ~line 885):** the icon ternary keys off the pill, not the state:
`check` only when the pill is the green "in sync"; the behind case uses `arrow-down-to-line` —
the same lucide glyph as the ⤓ update ladder language.

**CSS (`styles.css`):** add an `is-behind` variant (orange, mirroring the `is-up` pattern:
`border-color: rgba(var(--color-orange-rgb), 0.5); color: var(--color-orange)`) next to the
existing variants of `.config-sync-side-self-pill`, `.config-sync-self-pill`, and
`.config-sync-self-chip`; plus the `.config-sync-self-behind` advisory block (amber tone, layout
like a `config-sync-self-block` with the button right-aligned).

**Dead code removal (same commit):** both self-in-outdated special cases are unreachable —
`rows()` (line ~401) skips `SELF_GROUP_NAME` before any section bucketing:

- `rowStageable` guard at `SyncCenterView.ts:445`
- the `renderItemDetail` outdated-section self note at `SyncCenterView.ts:1662-1669`
  ("Config Sync updates itself through Obsidian's plugin updater…")

## Item 2: section head counts follow the unified rule

Unified rule (spec 2026-07-17): in non-main sections the state ACTION is the payload — every
row is actionable, and content-in-sync is the *normal* case for update-only / enable-only /
install-only rows. The head count must say how many items sit in the section, not how many have
content drift.

**`renderSection` (`SyncCenterView.ts:1457-1461`):**

- Neutral pill, not searching: `${rows.length}` (was `rows.length - insync.length`).
- Neutral pill, searching: unchanged `${matches.length} of ${rows.length}`.
- **Delete the `✓ N` in-sync pill** (line 1461) and the now-unused `insync` filter — in these
  sections a green check mislabels a row that still carries an update/enable/install payload.
- `checkable` / select-all logic unchanged.

This lands `renderSection` on the same semantics `renderInfoSection` (desktop-only, line 1431)
already has. Applies to all three actionable sections — outdated, disabled, not-installed —
which share the same latent "0 ✓N" bug.

## Tests (`tests/selfPane.test.ts`)

- drift `"behind"` + groupState `"in-sync"` → `state: "insync"`, `versionBehind: true`
  (the reported case: content identical, plugin behind).
- drift `"behind"` + groupState `"store-newer"` → `state: "adopt"`, `versionBehind: true`
  (advisory coexists with a direction state).
- drift `"ahead"` → `versionBehind: false` and existing `versionRefresh: true` unchanged.
- drift `null` → `versionBehind: false`.
- `isColdStart: true` → `versionBehind: false` regardless of drift.

The Item 2 change is view-layer count text with no pure-function seam worth creating (YAGNI);
no new tests.

## Docs (same branch, per docs-currency)

- `README.md` (:23, :82) and `README.zh.md` (:23, :82): the self-chip sentences ("a green
  check when everything is in sync, otherwise…") gain the update-available case — an orange
  chip when this device's Config Sync is older than the store's captured version, with the
  pane advisory pointing at Community plugins.
- `docs/ARCHITECTURE.md`: the self-pane bullet notes the `versionBehind` advisory output.
- (This repo has no `docs/DESIGN.md` — that file belongs to the ribbon-organizer repo.)

## Out of scope

- Reintroducing the self group into the item list / Outdated section (design stands: the self
  layer lives in its own destination).
- Auto-updating config-sync or any in-run self-update action.
- Status bar: derives from main-section rows only; self stays excluded — unchanged.
