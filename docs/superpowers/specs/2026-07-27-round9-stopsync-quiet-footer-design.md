# Round 9 — Sync Center "Stop syncing" quiet footer (定稿 A)

Feedback (2026-07-27, mobile screenshot): in an expanded Sync Center card the pink
`Stop syncing` pill sits ~6px under the file/diff row — tapping `diff ▾` on a phone easily
lands on it. It is also the most eye-catching element of the card while being its least
frequent action.

Mockup (定稿 A of A/B/C): https://claude.ai/code/artifact/2d4587e4-7dce-4581-b0ea-afce6147f1d1

## Decision

One placement, both platforms: **Stop syncing always renders as the drawer's last row — a
quiet right-aligned text link under a divider** — and never inline anywhere else.

- `SyncCenterView.renderItemCard`: drop the "only when no `.config-sync-segrow`" condition —
  every removable row (`canStopSyncing`) gets the footer.
- `renderPolicySeg`: delete its inline `renderStopSyncing(segrow, r)` call — the policy
  ladder row no longer carries the remove entry.
- `.config-sync-stopsync-foot`: divider (`border-top` background-modifier-border) +
  `padding-top`, larger `margin-top`.
- `.config-sync-stopsync`: visual demotion — `var(--text-muted)`, no border/pill; red only on
  `:hover`/`:active`. Mobile (`.is-mobile`) adds taller padding for the tap target and a wider
  gap above the divider.

Not chosen: B (kebab overflow menu — extra tap, single-item menu) and C (spacing-only — the
pill keeps outsized visual weight). The existing confirm modal stays the safety net.
