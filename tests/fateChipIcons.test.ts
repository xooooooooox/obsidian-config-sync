import { describe, it, expect } from "vitest";
import { FATE_CHIP_ICON } from "../src/ui/fateChipIcons";

// C-#40 spec §4: every string buildChips (fateModel.ts) can produce, plus the two chips added
// at render time, must resolve to an icon; an unknown chip string is simply absent from the map
// (text-only fallback lives in the renderer) rather than throwing.
describe("FATE_CHIP_ICON — chip→icon map completeness (C-#40)", () => {
  const chips = [
    "not installed here",
    "desktop only",
    "your rule",
    "off here — your rule",
    "on here — your rule",
    "stays off",
    "encrypted",
    "your choice",
  ];

  it("maps every buildChips string + the two render-time chips to an icon", () => {
    for (const chip of chips) expect(FATE_CHIP_ICON[chip]).toBeTruthy();
  });

  it("uses the exact icons named in the spec", () => {
    expect(FATE_CHIP_ICON).toEqual({
      "not installed here": "circle-dashed",
      "desktop only": "monitor",
      "your rule": "sliders-horizontal",
      "off here — your rule": "sliders-horizontal",
      "on here — your rule": "sliders-horizontal",
      // `power` was re-pointed at the local-exception ON state by
      // 2026-08-12-enablement-two-layers-design.md §7 — a chip that says the row stays off must
      // not share it.
      "stays off": "power-off",
      encrypted: "lock",
      "your choice": "check",
    });
  });

  it("an unknown chip string has no icon (renderer falls back to text-only)", () => {
    expect(FATE_CHIP_ICON["some future chip"]).toBeUndefined();
  });
});
