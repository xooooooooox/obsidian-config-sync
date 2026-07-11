# Sync panel polish — accounting model, dedup, style fidelity — design

**Status:** approved for planning
**Date:** 2026-07-12
**Scope:** post-0.12.1 feedback: the five states have no coherent counting model (header can claim "all in sync" while `≠` items exist; a freshly ticked item never lights the ribbon dot), `workspace*.json` files appear in two tabs, item rows carry redundant path text, and the shipped styling is flatter/cheaper than the approved mockups (`.superpowers/brainstorm/22414-1783791813/content/all-final-gallery.html` is the visual ground truth). Plus one rendering-overlap glitch to reproduce.

## 1. One accounting model everywhere (the design decision)

Buckets align exactly with checkbox directions:

- **↑ orange bucket = `local-changed` + `not-captured`** — both are resolved by Capture (their checkboxes are already orange).
- **↓ purple bucket = `store-newer` + `differs`** — both are resolved by Apply (their checkboxes are already purple).
- **✓ = `in-sync`** only.

Applied uniformly to: panel header pills (tooltips update: `N item(s) to capture` / `N item(s) to apply` / `N item(s) in sync`), ribbon-dot buckets (orange when ↑>0; blue when ↑=0 and ↓>0 or a cached remote-newer), ribbon tooltip segments (`N to capture, N to apply, remote "x" newer`), and the menu title counts (`Sync… (↑N ↓N)`). Consequence fixed: ticking a new item in the pickers (state `—`) now lights the dot orange and counts in `↑`.

`differs` keeps its NOT-pre-checked default and overwrite hint; `not-captured` keeps NOT-pre-checked. Pre-check defaults are unchanged — only counting/coloring buckets change.

## 2. workspace dedup

`listDiscovered` additionally skips basenames matching `WORKSPACE_RE` — those files are already offered (with caution) in the Obsidian tab's *Not recommended* bucket. One file, one home. Unit test: seed `workspace.json`/`workspaces.json` → absent from discovered.

## 3. Item rows lose the inline path

The dim path span is removed from the panel's item rows (names alone; category section already gives context). The resolved path moves to the ROW's hover tooltip (`aria-label` on the row: `<resolved path>`). Remote rows keep their `captured <time>` text. Reports are unaffected (they never showed paths).

## 4. Style fidelity pass (mockup = ground truth)

Theme-agnostic layered depth via white overlays instead of theme vars that invert in dark themes:

- `.config-sync-macro` background `rgba(255,255,255,0.035)`, border `rgba(255,255,255,0.07)`.
- `.config-sync-card` background `rgba(255,255,255,0.05)`, border `rgba(255,255,255,0.09)`; row separators `rgba(255,255,255,0.07)`.
- **Custom-drawn checkboxes** replacing native rendering: `appearance: none; width/height 15px; border: 1.5px solid var(--text-faint); border-radius: 3px;` — checked: orange (`--color-orange`) or purple (`--interactive-accent`) fill + white `✓` (pseudo-element); indeterminate (section boxes): gray fill + `−`; disabled: opacity .25. Same input elements, pure CSS.
- Spacing rhythm per mockup: macro padding `var(--size-4-3)`, section heading `padding: var(--size-4-3) 2px var(--size-4-1)`, row padding-block `var(--size-4-2)`, action-bar top margin `var(--size-4-3)`.
- Pills: `font-size: var(--font-ui-smaller); padding: 1px 8px;` (slightly larger than shipped), state icons `font-size: var(--font-ui-small)`.
- Verified against the gallery mockup side-by-side via screenshot at branch smoke.

## 5. Row-overlap glitch (investigate then fix)

Screenshot evidence (user's many-item vault): two pairs of rows render superimposed mid-list. Reproduce in the dev vault by enabling many items; suspected causes to check: the empty `config-sync-report-files` detail div's margins on auto-expanded rows, or nowrap + min-width interactions. Fix whatever reproduces; if it cannot be reproduced after an honest attempt (≥20 items, expanded/collapsed mixes, scrolling), document the attempt and park it with a note in the ledger.

## Error handling / testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit: bucket counting (a fixture with all five states → ↑/↓/✓ counts per the model — expose a small pure helper `bucketCounts(statuses)` in `src/core/status.ts` so it's testable and shared by panel/dot/menu); workspace dedup in `listDiscovered`.
- Smoke: new-item tick → orange dot; ≠ present → ↓ pill non-zero; panel screenshot vs gallery mockup side-by-side; overlap repro attempt; zero console errors.

## Non-goals

Pre-check default changes; report layout changes; mobile-specific styling beyond inherited fixes.
