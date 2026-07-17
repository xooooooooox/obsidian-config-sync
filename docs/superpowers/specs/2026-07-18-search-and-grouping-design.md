# Batch 4 (0.27.9): mobile search coherence, grouped All-items, header style, pull-primary

Real-vault findings 2026-07-18 (kickstart, 0.27.8). Four items.

## ① Mobile search renders coherently

The compact search input re-renders only the list host (a deliberate trade to keep the
soft keyboard open — a full render rebuilds the input). Everything else goes stale: filter
pills keep pre-search counts, the action sections keep pre-search rows, and with a
direction filter active (e.g. ↓) a search can show "0 of 58" with no visible explanation.

- **In-place co-render**: pills row, action sections, and footer move to re-renderable
  hosts (the `listHost` pattern); the search input handler refreshes them all without
  touching the input element. Behavior matches the desktop sidebar search's full render.
- **Search resets the direction filter**: when the search term transitions empty →
  non-empty, `filter` resets to "all" (searching means "find this item"; a hidden ↓ filter
  makes matches invisible). While a search is active, tapping pills re-filters within the
  results as today.

## ② All items groups with headers; single scopes stay flat (定稿: A + B hybrid)

- **All items scope**: rows group under scope headers — Obsidian / Core plugins /
  Community plugins / Beta / custom — in SCOPE_ORDER, alphabetical inside each group
  (mockup-approved 方案 A). The flattened ✓ in-sync / ○ no-settings trailing lines stay
  panel-wide (below all groups), unchanged.
- **Single-scope views** (Obsidian, Core plugins, Community, Beta, custom): no headers —
  the scope is already the title (方案 B). Current sorted order unchanged.
- Search across All items keeps the headers for groups that still have matches.

## ③ Group headers get a real visual identity

The remote-diff detail's existing headers (`.config-sync-sect`) read exactly like rows.
One shared header style for remote diff and the new All-items headers, per the order
mockup: `--font-ui-smaller`, uppercase with letter-spacing, `--text-muted`, top breathing
room and a hairline divider under the label. No layout changes to the rows themselves.

## ④ Pull button lights up on version-info-only freshness (already on branch)

`renderRemoteButtons` treated `entries.length === 0` as "nothing to do", ignoring
`lockDiffers` — while the note right above says "remote has newer version info; Pull
refreshes it". Now `noChanges = entries.length === 0 && !lockDiffers`: Pull goes primary,
Push dims with its overwrite warning. (Committed as 905e02d.)

## Verification

Dev vault: mobile emulation — type into search with ↓ filter active and see pills/sections/
footer recompute and filter reset to All, keyboard stays up (input element untouched across
renders); All items shows headers, single scopes none; remote diff headers visually
distinct. Desktop regression on search and scope views. Gates: npm test, lint 67-warning
baseline, no hardcoded colors.
