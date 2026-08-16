// Fate chip icon registry:
// every fate chip renders icon + text — the `encrypted` special case generalized to
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
  // `power-off`, not `power`: `power`
  // means "this device has an exception and it is ON" in the two-segment enablement row, so a chip
  // that says the row stays OFF cannot keep the same glyph — one form, one meaning.
  "stays off": "power-off",
  encrypted: "lock",
  "your choice": "check",
};
