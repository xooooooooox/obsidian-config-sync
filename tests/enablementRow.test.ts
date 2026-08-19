import { describe, expect, it } from "vitest";
import {
  buildOptOutLocalMenu,
  buildLocalMenu,
  enabledOnTooltip,
  enablementRowModel,
  fileEnablementRowModel,
  optOutLocalSegment,
  FOLLOWS_LABEL,
  localSegmentTooltip,
  NOT_SYNCED_HERE_LABEL,
  OFF_HERE_LABEL,
  ON_HERE_LABEL,
  ruleIcon,
  ruleLabel,
  ruleLandingNeedsSeed,
  RULE_OPTIONS,
  settingsSyncTooltip,
} from "../src/ui/enablementRow";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";
import { FIELD_SHARING_OPTIONS, sharingIcon } from "../src/ui/itemCard";

describe("the merged two-layer control", () => {
  // The fourth value names the FACT ("there is no shared answer"), never its consequence — the
  // consequence differs by row kind and lives in the three tooltips below.
  it("names the four rule values exactly as the spec's copy table does", () => {
    expect(RULE_OPTIONS.map(ruleLabel)).toEqual(["All devices", "Desktop only", "Mobile only", "Not shared"]);
  });

  // The fourth glyph is deliberately NOT a negation: the local layer's own opt-out sits in the same
  // control, and those two facts are the pair users confuse most, so the shared answer must not join
  // the negation family. `square-split-horizontal` replaced `split` — same argument, but readable at
  // the 16px every drawer control renders at.
  it("gives each rule its own glyph, and never borrows a reserved one", () => {
    expect(RULE_OPTIONS.map(ruleIcon)).toEqual(["monitor-smartphone", "monitor", "smartphone", "square-split-horizontal"]);
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("sliders-horizontal");
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("airplay");
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("circle-minus"); // the local layer's own mark
  });

  // A per-key rule row now has its own local layer, so its shared half must speak the
  // enablement vocabulary too — `airplay` reads as screen mirroring to anyone who has not read
  // this file, so it stays out of any control that carries a local layer. The per-element
  // array rows (renderPerElementRow) have no local layer and keep `sharingIcon`'s own `airplay` —
  // this pins that narrowing down so a later cleanup does not delete `airplay` as "dead".
  it("a per-key rule row speaks the enablement vocabulary; airplay survives only where there is no local layer", () => {
    // per-key rows now have a local layer -> users, never airplay
    expect(FIELD_SHARING_OPTIONS.map(ruleIcon)).not.toContain("airplay");
    // per-element array rows still have none -> airplay is still their this-device glyph
    expect(sharingIcon({ kind: "this-device" })).toBe("airplay");
  });

  // `equal` says "this device MATCHES the shared answer" without depending on where it sits: the
  // old `corner-down-right` only read as "follows" while it stood to the right of the shared glyph,
  // and it also has to work in a menu list, where it has no neighbour to point back at.
  it("the follow state has a glyph — equal, not an exception", () => {
    const m = enablementRowModel({ rule: EVERYWHERE, exception: null });
    expect(m.local).toEqual({ icon: "equal", tooltip: "This device: follows what's shared." });
    expect(m.localIsException).toBe(false);
  });

  it("an exception shows its own state, whatever the rule says (precedence 1 is visible)", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), THIS_DEVICE]) {
      expect(enablementRowModel({ rule, exception: "on" }).local).toEqual({ icon: "power", tooltip: "This device: always on." });
      expect(enablementRowModel({ rule, exception: "off" }).local).toEqual({ icon: "power-off", tooltip: "This device: always off." });
      expect(enablementRowModel({ rule, exception: "on" }).localIsException).toBe(true);
    }
  });

  // The shared tooltip states the CONSEQUENCE, not the label. On an on/off list the excluded class
  // is turned off outright, which is the strongest of the three row kinds' meanings and the one the
  // bare words "Desktop only" hide.
  it("the shared tooltip on an on/off row says what happens to the excluded class", () => {
    expect(enabledOnTooltip(EVERYWHERE)).toBe("Every device turns it on.");
    expect(enabledOnTooltip(perClass("desktop"))).toBe("Desktops turn it on. On phones it stays off.");
    expect(enabledOnTooltip(perClass("mobile"))).toBe("Phones turn it on. On desktops it stays off.");
    expect(enabledOnTooltip(THIS_DEVICE)).toBe("Nobody shares this. Every device keeps its own on/off.");
    // one producer: the model never re-spells it
    for (const rule of RULE_OPTIONS) expect(enablementRowModel({ rule, exception: null }).fleet.tooltip).toBe(enabledOnTooltip(rule));
  });

  // `not-synced` is the only state that needs a second sentence: it is what users mistake for the
  // shared answer's `Not shared`, and the entire difference is what happens to everyone else.
  it("the local tooltip is named once per state and reused by the model", () => {
    expect(localSegmentTooltip("follows")).toBe("This device: follows what's shared.");
    expect(localSegmentTooltip("on")).toBe("This device: always on.");
    expect(localSegmentTooltip("off")).toBe("This device: always off.");
    expect(localSegmentTooltip("not-synced")).toBe("This device: not synced. Your other devices keep sharing it.");
  });
});

// The whole-FILE row's model counterpart (`Settings sync`) — same shape, a FileSharing
// fleet datum and a two-state local layer (follow / not-synced-here).
describe("fileEnablementRowModel", () => {
  // The whole-FILE consequence is the strongest of the three: a class-scoped file rule becomes the
  // compiled group's device class, and a group scoped away from this device is not in its sync set
  // at all. The excluded class keeps no private copy — it simply has nothing to do with the file.
  it("the fleet segment carries sharingIcon's glyph and the whole-file consequence", () => {
    const m = fileEnablementRowModel({ sharing: EVERYWHERE, optedOut: false });
    expect(m.fleet).toEqual({ icon: "monitor-smartphone", tooltip: "Every device syncs this file." });
    expect(settingsSyncTooltip(perClass("desktop"))).toBe("Only desktops sync this file. Phones don't sync it at all.");
    expect(settingsSyncTooltip(perClass("mobile"))).toBe("Only phones sync this file. Desktops don't sync it at all.");
  });

  it("follows when not opted out; not-synced, with the fold family's own glyph, when opted out", () => {
    expect(fileEnablementRowModel({ sharing: EVERYWHERE, optedOut: false }).local).toEqual({
      icon: "equal",
      tooltip: "This device: follows what's shared.",
    });
    const optedOut = fileEnablementRowModel({ sharing: EVERYWHERE, optedOut: true });
    expect(optedOut.local).toEqual({ icon: "circle-minus", tooltip: "This device: not synced. Your other devices keep sharing it." });
    expect(optedOut.localIsException).toBe(true);
  });

  // The fields-mode fallback (a fields-mode item's fleet cell is an italic note, not a menu): the local
  // half alone must still be the SAME producer, not a second hand-typed copy of it.
  it("optOutLocalSegment is the same producer fileEnablementRowModel's local half uses", () => {
    for (const optedOut of [false, true]) {
      expect(optOutLocalSegment(optedOut)).toEqual(fileEnablementRowModel({ sharing: EVERYWHERE, optedOut }).local);
    }
  });
});

// ONE producer for the local menu. Both entrances — the Sync Center's row and the
// settings card's — feed this list into an Obsidian Menu; when they each built their own, the Sync
// Center offered a follow entry under a rule that has no shared answer to follow.
describe("buildLocalMenu", () => {
  const handlers = { follow: () => {}, setState: () => {} };

  it("offers follow / on / off in that order whenever there IS a shared answer to follow", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile")]) {
      expect(buildLocalMenu(rule, null, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, ON_HERE_LABEL, OFF_HERE_LABEL]);
    }
  });

  // With `Not shared` every device's own state IS the answer, so following
  // would be following nothing — and a row that showed the label without offering it (the settings
  // card's shape before this fix) named a state the user could not re-select.
  it("omits follow under Not shared — at BOTH entrances, because there is only one list", () => {
    const items = buildLocalMenu(THIS_DEVICE, null, handlers);
    expect(items.map((i) => i.title)).toEqual([ON_HERE_LABEL, OFF_HERE_LABEL]);
    expect(items.map((i) => i.title)).not.toContain(FOLLOWS_LABEL);
  });

  it("carries the same glyphs the control's local half shows, and none for follow", () => {
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

// ONE producer for the whole-FILE local menu — a DIFFERENT datum from
// buildLocalMenu's above (device opt-out of the entire item, not one element of an enablement
// list), so it gets its own two-entry producer instead of being folded into the four-value shape.
describe("buildOptOutLocalMenu", () => {
  const handlers = { follow: () => {}, optOut: () => {} };

  it("always offers exactly follow / not-synced-here, in that order — no omit rule here", () => {
    expect(buildOptOutLocalMenu(false, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, NOT_SYNCED_HERE_LABEL]);
    expect(buildOptOutLocalMenu(true, handlers).map((i) => i.title)).toEqual([FOLLOWS_LABEL, NOT_SYNCED_HERE_LABEL]);
  });

  it("follow has no glyph; not-synced-here carries the row's own set-state icon", () => {
    expect(buildOptOutLocalMenu(false, handlers).map((i) => i.icon)).toEqual([null, "circle-minus"]);
  });

  it("checks exactly the current state", () => {
    const checked = (optedOut: boolean): string[] => buildOptOutLocalMenu(optedOut, handlers).filter((i) => i.checked).map((i) => i.title);
    expect(checked(false)).toEqual([FOLLOWS_LABEL]);
    expect(checked(true)).toEqual([NOT_SYNCED_HERE_LABEL]);
  });

  it("routes each entry to its own handler", () => {
    const seen: string[] = [];
    const items = buildOptOutLocalMenu(false, { follow: () => seen.push("follow"), optOut: () => seen.push("optOut") });
    for (const i of items) i.action();
    expect(seen).toEqual(["follow", "optOut"]);
  });
});

// The moment an element leaves the shared answer, its exception is seeded with exactly what it
// is right now (host.leaveToThisDevice) — so the row never shows the follow glyph beside a menu
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
