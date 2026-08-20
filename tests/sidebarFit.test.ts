import { describe, expect, it } from "vitest";
import {
  COMPACT_FLOOR_PX,
  FIT_HYSTERESIS_PX,
  NAME_FLOOR_PX,
  nextCompact,
  SIDE_COL_MIN_PX,
  sidebarColumnWidth,
  sidebarNeededWidth,
  SidebarRowNeed,
} from "../src/ui/sidebarFit";

// A stand-in for the caller's text measurement: 7px per character is close enough to a UI font at
// --font-ui-small for these tests, and the point is that the WIDEST row decides, not the exact px.
const width = (s: string): number => s.length * 7;
const BADGE = 32;

describe("sidebarColumnWidth", () => {
  it("takes the percentage when it clears the minimum, the minimum when it doesn't", () => {
    expect(sidebarColumnWidth(1000)).toBe(220);
    // 22% of 600 is 132, under the 150 floor the stylesheet's minmax() imposes
    expect(sidebarColumnWidth(600)).toBe(SIDE_COL_MIN_PX);
  });
});

describe("sidebarNeededWidth", () => {
  const rows = (...defs: [string, number][]): SidebarRowNeed[] => defs.map(([name, badges]) => ({ name, badges }));

  it("is the widest row, not the first or the last", () => {
    const one = sidebarNeededWidth(rows(["All items", 1]), width, BADGE);
    const many = sidebarNeededWidth(rows(["All items", 1], ["Community plugins", 3], ["Beta", 1]), width, BADGE);
    expect(many).toBeGreaterThan(one);
    expect(many).toBe(sidebarNeededWidth(rows(["Community plugins", 3]), width, BADGE));
  });

  // The badges never shrink, so the name is the only thing a narrow column can take from — and the
  // reported failure was it taking all of it. A floor, not the full name: an ellipsised
  // `Community…` still reads, and asking for every name in full costs the sidebar at widths where
  // it was working.
  it("asks for the badges in full, but only a floor's worth of name", () => {
    const long = sidebarNeededWidth(rows(["Community plugins and then some", 2]), width, BADGE);
    expect(long).toBe(9 * 2 + NAME_FLOOR_PX + 2 * (BADGE + 5));
    // A name under the floor asks only for itself
    expect(sidebarNeededWidth(rows(["Beta", 2]), width, BADGE)).toBe(9 * 2 + 4 * 7 + 2 * (BADGE + 5));
  });

  // The whole reason this is measured per render rather than fixed: a vault whose rows agree draws
  // one badge, mid-sync it draws five, and the column that fits the first cannot fit the second.
  it("follows how many badges are actually drawn, not how many could ever be", () => {
    const quiet = sidebarNeededWidth(rows(["All items", 1]), width, BADGE);
    const busy = sidebarNeededWidth(rows(["All items", 5]), width, BADGE);
    expect(busy - quiet).toBe(4 * (BADGE + 5));
  });

  it("a row with no badges needs only its name and the row's own padding", () => {
    expect(sidebarNeededWidth(rows(["History", 0]), width, BADGE)).toBe(9 * 2 + "History".length * 7);
  });
});

describe("nextCompact", () => {
  const at = (over: Partial<Parameters<typeof nextCompact>[0]>): boolean =>
    nextCompact({ compact: false, forceNarrow: false, viewWidth: 1400, neededWidth: 100, ...over });

  it("a phone is narrow whatever it measures", () => {
    expect(at({ forceNarrow: true, viewWidth: 4000, neededWidth: 0 })).toBe(true);
  });

  it("below the floor the sidebar goes regardless of whether it would have fitted", () => {
    expect(at({ viewWidth: COMPACT_FLOOR_PX - 1, neededWidth: 0 })).toBe(true);
  });

  it("switches the moment the column can no longer show a row in full", () => {
    // 22% of 1000 = 220
    expect(at({ viewWidth: 1000, neededWidth: 219 })).toBe(false);
    expect(at({ viewWidth: 1000, neededWidth: 221 })).toBe(true);
  });

  // Same pane, same width — only the data differs. This is the behaviour a fixed breakpoint
  // could not express, and the reason the rule reads the rendered badges.
  it("keeps the sidebar at a width that would have lost it, when the rows are quieter", () => {
    const quiet = sidebarNeededWidth([{ name: "Community plugins", badges: 1 }], width, BADGE);
    const busy = sidebarNeededWidth([{ name: "Community plugins", badges: 5 }], width, BADGE);
    expect(at({ viewWidth: 900, neededWidth: quiet })).toBe(false);
    expect(at({ viewWidth: 900, neededWidth: busy })).toBe(true);
  });

  // Leaving costs a full rebuild, so the two directions cannot share one threshold: on a window
  // drag a shared one flips every pixel across the boundary.
  it("leaves compact only once there is room to spare", () => {
    const available = sidebarColumnWidth(1000); // 220
    const compact = (neededWidth: number): boolean => at({ compact: true, viewWidth: 1000, neededWidth });
    expect(compact(available - 1)).toBe(true); // fits by a hair — not enough to rebuild for
    expect(compact(available - FIT_HYSTERESIS_PX)).toBe(false);
  });
});
