// Fate chip icon registry (C-#40, spec 2026-08-09-c-livetest-batch20-chips-and-containment.md
// §1): every fate chip renders icon + text — the C-#38 `encrypted` special case generalized to
// every chip string `buildChips` (fateModel.ts) can produce, plus the two chips added at render
// time (`your choice` — SyncCenterView's displayFate; the synthetic locked row's `encrypted`).
// Single source, like ACTION_ICON (actionIcons.ts). An unmapped string never throws — chips are
// presentation, not user input — it just renders text-only, loud in review instead.
export const FATE_CHIP_ICON: Record<string, string> = {
  "not installed here": "circle-dashed",
  "desktop only": "monitor",
  "your rule": "sliders-horizontal",
  "off here — your rule": "sliders-horizontal",
  "on here — your rule": "sliders-horizontal",
  "stays off": "power",
  encrypted: "lock",
  "your choice": "check",
};
