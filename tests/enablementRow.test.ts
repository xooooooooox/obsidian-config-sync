import { describe, expect, it } from "vitest";
import {
  buildFileLocalMenu,
  buildLocalMenu,
  enablementRowModel,
  FOLLOWS_LABEL,
  NOT_SYNCED_HERE_LABEL,
  OFF_HERE_LABEL,
  ON_HERE_LABEL,
  ruleIcon,
  ruleLabel,
  ruleLandingNeedsSeed,
  RULE_OPTIONS,
} from "../src/ui/enablementRow";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

describe("the two-segment row", () => {
  it("names the four rule values exactly as the spec's copy table does", () => {
    expect(RULE_OPTIONS.map(ruleLabel)).toEqual(["All devices", "Desktop only", "Mobile only", "Each device decides"]);
  });

  it("gives each rule its own glyph, and never borrows a reserved one", () => {
    expect(RULE_OPTIONS.map(ruleIcon)).toEqual(["monitor-smartphone", "monitor", "smartphone", "users"]);
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("sliders-horizontal");
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("airplay");
  });

  it("the follow state has no icon — the default has nothing to say", () => {
    const m = enablementRowModel({ rule: EVERYWHERE, exception: null });
    expect(m.local).toEqual({ icon: null, label: "Follows the default" });
    expect(m.localIsException).toBe(false);
  });

  it("an exception shows its own state, whatever the rule says (precedence 1 is visible)", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), THIS_DEVICE]) {
      expect(enablementRowModel({ rule, exception: "on" }).local).toEqual({ icon: "power", label: "On here" });
      expect(enablementRowModel({ rule, exception: "off" }).local).toEqual({ icon: "power-off", label: "Off here" });
      expect(enablementRowModel({ rule, exception: "on" }).localIsException).toBe(true);
    }
  });
});

// ONE producer for the local menu (spec §6.6). Both entrances — the Sync Center's row and the
// settings card's — feed this list into an Obsidian Menu; when they each built their own, the Sync
// Center offered `Follows the default` under a rule that has no default to follow.
describe("buildLocalMenu", () => {
  const handlers = { follow: () => {}, setState: () => {} };

  it("offers follow / on / off in that order whenever there IS a shared answer to follow", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile")]) {
      expect(buildLocalMenu(rule, null, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, ON_HERE_LABEL, OFF_HERE_LABEL]);
    }
  });

  // §6.5 case 3: with `Each device decides` every device's own state IS the answer, so following
  // would be following nothing — and a row that showed the label without offering it (the settings
  // card's shape before this fix) named a state the user could not re-select.
  it("omits follow under Each device decides — at BOTH entrances, because there is only one list", () => {
    const items = buildLocalMenu(THIS_DEVICE, null, handlers);
    expect(items.map((i) => i.title)).toEqual([ON_HERE_LABEL, OFF_HERE_LABEL]);
    expect(items.map((i) => i.title)).not.toContain(FOLLOWS_LABEL);
  });

  it("carries the same glyphs the row's local segment shows, and none for follow", () => {
    expect(buildLocalMenu(EVERYWHERE, null, handlers).map((i) => i.icon)).toEqual([null, "power", "power-off"]);
    const model = enablementRowModel({ rule: EVERYWHERE, exception: "on" });
    expect(buildLocalMenu(EVERYWHERE, "on", handlers).find((i) => i.title === ON_HERE_LABEL)?.icon).toBe(model.local.icon);
  });

  it("checks exactly the current state — and follow is the checked one only when there is no exception", () => {
    const checked = (rule: Parameters<typeof buildLocalMenu>[0], e: "on" | "off" | null): string[] =>
      buildLocalMenu(rule, e, handlers).filter((i) => i.checked).map((i) => i.title);
    expect(checked(EVERYWHERE, null)).toEqual([FOLLOWS_LABEL]);
    expect(checked(EVERYWHERE, "on")).toEqual([ON_HERE_LABEL]);
    expect(checked(EVERYWHERE, "off")).toEqual([OFF_HERE_LABEL]);
    // …and with no follow entry to check, an unseeded this-device rule checks nothing — which is
    // exactly the state ruleLandingNeedsSeed below exists to prevent ever being visible.
    expect(checked(THIS_DEVICE, null)).toEqual([]);
  });

  it("routes each entry to its own handler", () => {
    const seen: string[] = [];
    const items = buildLocalMenu(EVERYWHERE, null, { follow: () => seen.push("follow"), setState: (s) => seen.push(s) });
    for (const i of items) i.action();
    expect(seen).toEqual(["follow", "on", "off"]);
  });
});

// ONE producer for the whole-FILE local menu (spec §6.2/§6.6) — a DIFFERENT datum from
// buildLocalMenu's above (device opt-out of the entire item, not one element of an enablement
// list), so it gets its own two-entry producer instead of being folded into the four-value shape.
describe("buildFileLocalMenu", () => {
  const handlers = { follow: () => {}, optOut: () => {} };

  it("always offers exactly follow / not-synced-here, in that order — no omit rule here", () => {
    expect(buildFileLocalMenu(false, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, NOT_SYNCED_HERE_LABEL]);
    expect(buildFileLocalMenu(true, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, NOT_SYNCED_HERE_LABEL]);
  });

  it("follow has no glyph; not-synced-here carries circle-slash, matching the row's set-state icon", () => {
    expect(buildFileLocalMenu(false, handlers).map((i) => i.icon)).toEqual([null, "circle-slash"]);
  });

  it("checks exactly the current state", () => {
    const checked = (optedOut: boolean): string[] => buildFileLocalMenu(optedOut, handlers).filter((i) => i.checked).map((i) => i.title);
    expect(checked(false)).toEqual([FOLLOWS_LABEL]);
    expect(checked(true)).toEqual([NOT_SYNCED_HERE_LABEL]);
  });

  it("routes each entry to its own handler", () => {
    const seen: string[] = [];
    const items = buildFileLocalMenu(false, { follow: () => seen.push("follow"), optOut: () => seen.push("optOut") });
    for (const i of items) i.action();
    expect(seen).toEqual(["follow", "optOut"]);
  });
});

// §6.5: the moment an element leaves the shared answer, its exception is seeded with exactly what it
// is right now (host.leaveToThisDevice) — so the row never shows `Follows the default` beside a menu
// that no longer offers it, and "switching to an exception keeps the status quo" holds by
// construction. Both entrances ask this one predicate.
describe("ruleLandingNeedsSeed", () => {
  it("is true only for a this-device landing with no exception yet", () => {
    expect(ruleLandingNeedsSeed(THIS_DEVICE, null)).toBe(true);
    expect(ruleLandingNeedsSeed(THIS_DEVICE, "on")).toBe(false); // already answered — never overwrite it
    expect(ruleLandingNeedsSeed(THIS_DEVICE, "off")).toBe(false);
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile")]) {
      expect(ruleLandingNeedsSeed(rule, null)).toBe(false);
      expect(ruleLandingNeedsSeed(rule, "on")).toBe(false);
    }
  });

  // The invariant the two producers share: a seeded landing is exactly the case where the menu has
  // no follow entry, so the row can always describe itself with a state the menu offers.
  it("fires for precisely the rules whose menu drops the follow entry", () => {
    const handlers = { follow: () => {}, setState: () => {} };
    for (const rule of RULE_OPTIONS) {
      const offersFollow = buildLocalMenu(rule, null, handlers).some((i) => i.title === FOLLOWS_LABEL);
      expect(ruleLandingNeedsSeed(rule, null)).toBe(!offersFollow);
    }
  });
});
