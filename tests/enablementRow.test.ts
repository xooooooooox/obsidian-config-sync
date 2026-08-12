import { describe, expect, it } from "vitest";
import { enablementRowModel, ruleIcon, ruleLabel, RULE_OPTIONS } from "../src/ui/enablementRow";
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
