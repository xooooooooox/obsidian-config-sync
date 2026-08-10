import { describe, it, expect } from "vitest";
import { FOLD_ICON, FOLD_ICON_COLOR_CLASS, type FoldKind } from "../src/ui/foldIcons";

// C-#50 (spec 2026-08-10-c-livetest-batch24-fold-family.md §1): the three trailing-fold states'
// icon vocabulary — fixed-size Lucide replacing the old unequal-weight text glyphs.
describe("FOLD_ICON — fold-state→icon map (C-#50)", () => {
  const kinds: FoldKind[] = ["insync", "excluded", "nosettings"];

  it("maps every fold state to an icon", () => {
    for (const k of kinds) expect(FOLD_ICON[k]).toBeTruthy();
  });

  it("uses the exact icons named in the spec — circle-slash never ban (action vs. state)", () => {
    expect(FOLD_ICON).toEqual({
      insync: "check",
      excluded: "circle-slash",
      nosettings: "circle",
    });
  });

  it("uses a distinct icon per state", () => {
    const icons = kinds.map((k) => FOLD_ICON[k]);
    expect(new Set(icons).size).toBe(kinds.length);
  });
});

describe("FOLD_ICON_COLOR_CLASS", () => {
  it("keeps insync's established green; excluded/nosettings stay unstyled (muted, inherited)", () => {
    expect(FOLD_ICON_COLOR_CLASS).toEqual({
      insync: "is-ok",
      excluded: null,
      nosettings: null,
    });
  });
});
