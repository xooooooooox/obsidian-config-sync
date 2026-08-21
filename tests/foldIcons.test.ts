import { describe, it, expect } from "vitest";
import { FOLD_ICON, FOLD_ICON_COLOR_CLASS, type FoldKind } from "../src/ui/foldIcons";

// The three trailing-fold states'
// icon vocabulary — fixed-size Lucide icons, never unequal-weight text glyphs.
describe("FOLD_ICON — fold-state→icon map", () => {
  const kinds: FoldKind[] = ["insync", "excluded", "nosettings"];

  it("maps every fold state to an icon", () => {
    for (const k of kinds) expect(FOLD_ICON[k]).toBeTruthy();
  });

  // `ban` stays reserved for the stop-syncing ACTION — action and state never share a glyph. All
  // three are circles, so the trio reads as one family at a glance.
  it("uses the exact icons named in the spec — never ban (action vs. state)", () => {
    expect(FOLD_ICON).toEqual({
      insync: "check",
      excluded: "circle-minus",
      nosettings: "circle",
      locked: "key-round",
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
      // Uncoloured on purpose: every coloured mark in this column promises a run, and an item
      // nobody could open promises none.
      locked: null,
    });
  });
});
