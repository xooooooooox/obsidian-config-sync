# Sync Center polish batch 2 (rides 0.27.7 with mobile round 2)

Real-vault findings 2026-07-17 night (desktop, kickstart). Four items, all 定稿 via mockup
(`mode-badge-mockup.html` iterations) or diagnosis-approved.

## ① "refreshed just now" centered in the header (round-2 regression)

`.config-sync-center-head > :last-child { margin-left: auto }` (added in round 2 for the ↻)
fights `.config-sync-center-refreshed { margin-left: auto }`: two auto margins split the free
space, centering the refreshed note. Fix: scope the `:last-child` rule to `body.is-mobile`
(there the refreshed note is hidden and ↻ needs its own auto margin); desktop returns to
"refreshed … · ↻" right-aligned via the note's own auto margin.

## ② Mode badges → lock family (定稿方案 B)

Both modes mean encryption; the badge should say so, differing by degree:

- **encrypted** (`🔒` emoji today): Lucide `lock` via `setIcon`. Tooltip (aria-label):
  "Encrypted mode — the whole file is stored encrypted".
- **fields** (`▤` today): custom inline SVG "three field lines + small padlock at the
  bottom-right corner" (viewBox 24, lines `M3 5h18 / M3 11h9 / M3 17h7` stroke 2; lock
  rect 14.5,14.5 8×6.5 r1.4 + shackle, stroke 1.8; all `currentColor`). Tooltip:
  "Fields mode — only sensitive fields are filtered/encrypted".

Badge stays `--text-faint`, rendered at 12px (`.config-sync-mode-badge svg { 12px }`,
badge becomes inline-flex). Scope: Sync Center item rows only (SyncCenterView.ts:720-721).
The settings-tab per-field 🔒 (`config-sync-flock`) and the locked-state icon are separate
semantics and stay unchanged.

## ③ Select-all brightened grey (定稿档②)

Select-all stays in the grey family (it carries no direction; rows keep orange/purple), but
the fill lifts from muted to bright:

- `.config-sync-mainbar` checked: `--text-muted` → `--text-normal`; indeterminate:
  `--text-faint` → `--text-normal`. Symbol color stays `--background-primary`.
- Section-head select-alls join the custom-drawn set (today they fall through to the native
  accent checkbox): add `.config-sync-section-head input[type="checkbox"]` to the base
  appearance-none rule and the checked/indeterminate/disabled rules, same bright grey.

## ④ Refresh icons unified

Header ↻ and Remotes ↻ are both `refresh-cw`; the header one is forced to 14px
(`.config-sync-center-refresh svg`), which reads as a different, undersized icon. Drop the
override so both use the default icon size, then re-probe and recalibrate the header ↻'s
right alignment to the checkbox column (current `margin-right: 7px` was calibrated for the
14px glyph; expected ≈9px, verified by geometry probe on desktop and mobile emulation).

## Verification

Dev-vault live check (desktop + 390×844 emulation): refreshed note right-aligned, both ↻
same size, ↻/checkbox column edges equal by probe, badges legible at 12px with tooltips,
select-all checked/indeterminate bright grey including section heads. Gates: npm test,
lint 0 errors / 67-warning baseline, check-no-hardcoded-color.
