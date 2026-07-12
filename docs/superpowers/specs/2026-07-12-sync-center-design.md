# Sync Center Workspace View (iter19)

Approved mockup: `.superpowers/brainstorm/9047-1783841141/content/iter19-final-gallery.html` (5 screens; compact design revised per `iter19-compact-v2.html`). This is step 2 of the two-step path chosen in iter18's brainstorm: the two-pane content ships as-is; only the container and lifecycle change.

## Problem

The Sync panel is a modal: rebuilt from scratch on every open, discarded on Esc, capped at 920px, and disconnected from the awareness runtime (the ribbon dot can light up, but the panel you then open still has to compute everything from cold, and a panel left open goes stale). The reference layout (ioto-tasks-center) lives as a workspace `ItemView` — persistent, full-leaf, self-refreshing.

## Design

### 1. Container migration: `SyncModal` → `SyncCenterView`

- `src/ui/SyncModal.ts` becomes `src/ui/SyncCenterView.ts`; `class SyncCenterView extends ItemView`. The two-pane rendering (sidebar, item mode, remote mode, staging, footer) moves over unchanged except where this spec says otherwise. The host interface is renamed `SyncCenterHost` (same members).
- View identity: view type `config-sync-center`, display text `Sync Center`, icon `arrow-left-right`. Registered via `registerView`; **single instance** — the ribbon icon and the `sync` command open the view if absent, otherwise reveal the existing leaf. Command/ribbon copy unchanged.
- **The modal is retired**: no `Modal` remains for the panel. Reports, apply-confirm, and the reload prompt stay as the existing modals, opening above the view.
- Header (formerly the modal title bar) renders as the view's first content row: title `Sync Center`, the global count pills (unchanged), and right-aligned `refreshed {age}` (via existing `relativeAge`, tracking the last `reload()` completion).
- Esc has no special handling; the leaf closes via normal workspace means.

### 2. Lifecycle: persistent + self-refreshing

- `reload()` runs on: view open; the view's leaf becoming active (focus); and awareness events while the view is open — the plugin's debounced local status refresh and remote auto-check completion notify the view. The view exposes one method for this (e.g. `notifyExternalChange()`); `main.ts` calls it from the two existing awareness paths.
- The `refreshed {age}` label updates on each reload (re-rendered with the view; no ticking timer needed).

### 3. Reload preserves user state

Current modal semantics (reset everything) change to:

- **Preserved across reloads**: `panelScope`, `search`, ✓/○ fold-open sets, `expandedItems`, and the staged set + direction overrides — all keyed by item name; entries whose item vanished are pruned.
- **Default pre-check** (local-changed + store-newer) is applied only on the view's FIRST load after it opens (a `firstLoad` flag); subsequent reloads never re-seed or clear the user's staging.
- If `panelScope` points at a remote that no longer exists, fall back to `All items` (existing rule).

### 4. Compact mode (tasks-center pattern)

- Trigger: **leaf container width**, not viewport — `ItemView.onResize()` measures the content width; below **700px** the shell gets class `is-compact` (and loses it above). The iter18 `@media (max-width: 700px)` fallback CSS is removed.
- In compact: the sidebar is hidden; above the filter pills renders a full-width **scope switcher** button showing the current scope label + its bucket badges + `▾`.
- Clicking the switcher opens a dropdown (custom, styled like a menu) whose structure mirrors the sidebar exactly: `This device ↔ store` section (All items + categories, with badges) and `Remotes · checked {age}` section (with the refresh button and remote entries). Selecting an entry sets the scope, closes the dropdown, re-renders. Clicking the switcher again or anywhere outside closes it.
- Mobile always lands in compact (narrow container); remotes stay hidden on mobile (existing `host.remotes()` rule), so the mobile dropdown shows only the This-device section.

### 5. Carried visual fixes (styles.css)

1. **Select-all alignment**: the main-bar select-all checkbox's right edge aligns with the row-checkbox column below (`.config-sync-mainbar` gets `padding-right: 11px` — card padding 10px + 1px border).
2. **Segment direction tints**: inactive segments regain their direction colors — `.config-sync-seg-btn.is-capture` text `var(--color-orange)` and `.is-apply` text `var(--color-purple)` at rest (replacing the gray `--text-muted`); the `.is-on` filled backgrounds stay as shipped.

## Copy strings (verbatim)

| Context | String |
|---|---|
| View display text / header title | `Sync Center` |
| View type id | `config-sync-center` |
| View icon | `arrow-left-right` |
| Refreshed indicator | `refreshed {age}` (age via existing `relativeAge`) |
| Compact switcher | current scope label + badges + `▾` (`▴` while open); dropdown section heads identical to sidebar heads |

All other copy is unchanged from iter18.

## Testing

- Unit: none new required (no new pure logic; `panelModel` untouched).
- Live smoke: ribbon/command opens then REVEALS (no second leaf); header pills + `refreshed` indicator; focus-refresh and awareness-refresh with the view open (edit a config file → view updates in place); state preservation across an awareness reload (scope/search/staging survive; pre-check not re-seeded); execute via footer still runs report flow and the view refreshes; drag the leaf narrow → `is-compact` (sidebar → switcher), dropdown scope switch + remote entry; restore wide; the two visual fixes verified against the gallery; `SyncModal` fully gone (grep) and command no longer opens a modal.

## Non-goals

- No content redesign: item mode, remote mode, staging, filters, search, select-all, trailing lines all ship as-is from iter18.
- No changes to core, awareness timers/dot logic (only the added view notification call), reports, settings, or mobile remotes policy.
