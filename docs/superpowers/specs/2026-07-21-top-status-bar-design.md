# Sync Center top status bar — global self + all-action totals

## Problem

The Sync Center header (`SyncCenterView.renderHeader`, `:771`) shows four
global item pills: `↑ capture`, `↓ apply`, `✓ in sync`, `○ no settings`
(bucketed over `mainRows()`, which is scope-independent). Two blind spots:

1. **Config Sync's own sync status is invisible on mobile.** The self status
   (`selfBadge` / `selfStatePill`) lives on the sidebar "Config Sync" entry.
   On mobile the sidebar collapses into a dropdown switcher (`renderSwitcher`,
   `:740`), so the self status is hidden unless you open the switcher — you
   can't tell at a glance that Config Sync itself needs setup / adopt / capture.
2. **Remote push/pull status is absent from the header.** Whether a remote is
   ahead/behind your store lives only in the sidebar Remotes list
   (`remoteIcon`, `:1859`). It never appears in the top summary.

Goal: make the header a **global at-a-glance status bar** — Config Sync's own
state plus all four sync actions — identical on desktop and mobile.

## Decision (定稿)

**Layout B** (定稿 mockup `mockup-top-badges.html`): a single header row —
`[self chip] │ [action/state totals]` … `refreshed · ↻` — on both platforms.

- **Self chip** — always shown (including in-sync, as a green check), so mobile
  can positively confirm self is synced. A vertical divider separates it from
  the totals (self = Config Sync itself; totals = the items/remotes it syncs).
- **Push/pull totals count remotes**, not items: `☁↑ N` = N remotes older than
  the store (need push), `☁↓ N` = N remotes newer (need pull). Remote state is
  a single per-remote whole-store lock-timestamp comparison
  (`RemoteCheck.state`, `core/status.ts:153`) — there is no per-item push/pull
  count to sum. Shown only when N > 0.
- **Remotes are desktop-only** (`main.ts:558`, `remotes()` returns `[]` on
  mobile). So push/pull pills render only where remotes exist — on mobile they
  simply never appear, which is correct (mobile has nothing to push/pull). No
  platform branch is needed: iterating an empty `remotes()` yields zero pills.
- **Item totals stay as they are** — `capture ↑N` / `apply ↓N` (shown when > 0),
  `✓ in sync` (always), `○ no settings` (when > 0), bucketed over the already
  scope-independent `mainRows()`.

This is a **view-local** change — no host-interface (`SettingsHost`) additions.
`selfInfo`, `remotes()`, and `remoteCheck()` are all already on the view.

## Architecture

### 1. Pure helper — remote direction counts (`src/core/status.ts`)

Beside `bucketCounts`. Counts remotes needing each direction from their check
states:

```ts
// Push/pull are per-remote whole-store states, not item counts: a remote is
// "older" (push would update it) or "newer" (pull would update the store).
// Counts how many remotes need each direction. same/no-store/unknown → neither.
export function remoteDirectionCounts(states: RemoteState[]): { push: number; pull: number } {
  let push = 0;
  let pull = 0;
  for (const s of states) {
    if (s === "remote-older") push++;
    else if (s === "remote-newer") pull++;
  }
  return { push, pull };
}
```

### 2. Self chip helper (`src/ui/SyncCenterView.ts`)

`renderHeader` gains a `renderSelfChip(parent)` step. It reuses the existing
`selfStatePill(info)` (`:454`) for both the text and the state class — the two
surfaces (self pane pill and header chip) then can't drift.

- `info === null` → render nothing (self status not yet loaded).
- Otherwise: a `span.config-sync-self-chip` with the `selfStatePill` cls
  (`is-up` / `is-down` / `is-ok`) for border/tint, a leading **Lucide icon via
  `setIcon`** — `check` when `info.state === "insync"`, else `settings` (gear)
  — then the `selfStatePill(info).text`.
- `aria-label` / tooltip: `Config Sync: <text>`.
- Click handler: `this.panelScope = { kind: "self" }; this.switcherOpen = false;
  this.render(this.renderGen);` (same as the sidebar self entry, `:429`).

No emoji: the gear/check are Lucide icons via `setIcon` (DESIGN.md §148),
matching the action-icon convention (`renderActionIcon`). The existing `✓`/`○`
text glyphs in the item pills are unchanged (established glyph vocabulary).

### 3. `renderHeader` rework (`src/ui/SyncCenterView.ts:771`)

Order inside `.config-sync-center-head`:

1. `renderSelfChip(head)` — the self chip (§2).
2. `head.createSpan({ cls: "config-sync-head-divider" })` — the vertical
   divider, rendered only when the self chip rendered (i.e. `selfInfo !== null`).
3. The totals span (existing `.config-sync-report-pills`), now also carrying
   push/pull:
   - `capture ↑N` / `apply ↓N` — unchanged (`renderActionCount`, when > 0).
   - **push/pull** — compute
     `remoteDirectionCounts(this.host.remotes().map((r) => this.host.remoteCheck(r.name)?.check.state ?? "unknown"))`;
     when `push > 0` render `renderActionCount(pills.createSpan({ cls: "config-sync-pill is-push", attr: { "aria-label": "<n> remote(s) to push" } }), "push", push)`;
     same for `pull` with `is-pull` / `"pull"`.
   - `✓ in sync` (always) / `○ no settings` (when > 0) — unchanged.
   - **Pill order:** capture, apply, push, pull, in-sync, no-settings — local
     actions before remote actions, mutations before steady states.
4. `refreshed …` text + refresh button — unchanged.

The item counts still come from `this.presentedCounts(this.mainRows())`
(already global). No change to `mainRows`, `presentedCounts`, or `rows`.

### 4. CSS (`src/ui/../styles.css`)

- `.config-sync-self-chip` — inline-flex, gap, small radius, `1px solid
  transparent` border, subtle chip background (`rgba(var(--*-rgb), α)` /
  theme vars only), cursor pointer; its `svg` sized to match the pill icons.
  State tint via the shared `is-up` / `is-down` / `is-ok` classes already used
  for pills (border + text color).
- `.config-sync-head-divider` — a `1px` vertical rule
  (`background: var(--background-modifier-border)`, fixed height, `flex: none`).
- `is-push` / `is-pull` pill styles already exist (action-icons wave) — reused.
- No hardcoded colors — theme vars / `rgba(var(--…-rgb), α)` only
  (`./scripts/check-no-hardcoded-color.sh`, release-gated).

## Testing

- **Unit (`tests/status.test.ts`):** `remoteDirectionCounts` —
  - `["remote-older", "remote-older"]` → `{push: 2, pull: 0}`.
  - `["remote-newer"]` → `{push: 0, pull: 1}`.
  - `["same", "no-store", "unknown"]` → `{push: 0, pull: 0}`.
  - mixed `["remote-older", "remote-newer", "same"]` → `{push: 1, pull: 1}`.
  - `[]` → `{push: 0, pull: 0}`.
- **Live (dev vault — the real verification):**
  - **Desktop:** header shows the self chip (with the vault's real self state)
    left of a divider, then the totals; if a remote is configured and its check
    is `remote-older`/`remote-newer`, a `☁↑`/`☁↓` pill appears. In-sync self
    shows a green check. Clicking the self chip opens the self pane.
  - **Mobile (390×844):** the self chip is visible at the top even with the
    sidebar collapsed (the blind-spot fix); no push/pull pills (no remotes);
    the row fits without horizontal overflow. Switching scope does not change
    the header totals (they stay global).
  - Force each self state (coldstart / adopt / capture / both / insync) and
    confirm the chip icon + text + tint match `selfStatePill`.
- **Gates:** `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (+ new
  unit tests), `npx eslint .` **0 errors / 67 warnings**,
  `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- **No per-item push/pull counts.** Remote state stays a single whole-store
  timestamp comparison; the top total counts remotes, not items.
- **No mobile remote sync.** Remotes remain desktop-only; this spec does not
  add remote support on mobile.
- **No change to the sidebar** self entry, Remotes list, filter pills, switcher
  badges, or the scope-reactive filter-pill row below the header.
- **No host-interface changes** — the feature is entirely view-local.
- No change to `selfBadge` (sidebar badge) or `selfStatePill` behavior; the
  header chip consumes `selfStatePill` as-is.
