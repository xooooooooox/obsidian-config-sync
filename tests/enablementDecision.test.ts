import { describe, expect, it } from "vitest";
import { decideEnablement } from "../src/core/enablementDecision";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

// Spec's four rules, top down, first hit wins.
describe("decideEnablement", () => {
  it("1. a local exception wins outright — the rule is not even consulted", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE]) {
      expect(decideEnablement({ rule, exception: "on", deviceClass: "mobile" })).toEqual({ masked: true, force: "on" });
      expect(decideEnablement({ rule, exception: "off", deviceClass: "mobile" })).toEqual({ masked: true, force: "off" });
    }
  });

  it("2. each-device-decides masks without forcing — the element keeps whatever this device has", () => {
    expect(decideEnablement({ rule: THIS_DEVICE, exception: null, deviceClass: "desktop" })).toEqual({ masked: true, force: null });
  });

  it("3. a class rule for the other class masks AND forces off", () => {
    expect(decideEnablement({ rule: perClass("desktop"), exception: null, deviceClass: "mobile" })).toEqual({ masked: true, force: "off" });
    expect(decideEnablement({ rule: perClass("mobile"), exception: null, deviceClass: "desktop" })).toEqual({ masked: true, force: "off" });
  });

  it("3b. a class rule for THIS class is not a mask at all — plain shared-list membership", () => {
    expect(decideEnablement({ rule: perClass("desktop"), exception: null, deviceClass: "desktop" })).toEqual({ masked: false, force: null });
  });

  it("4. everything else follows the shared list", () => {
    expect(decideEnablement({ rule: EVERYWHERE, exception: null, deviceClass: "mobile" })).toEqual({ masked: false, force: null });
  });
});
