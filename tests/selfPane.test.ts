import { describe, expect, it } from "vitest";
import { selfPaneState } from "../src/core/selfPane";

describe("selfPaneState", () => {
  it("cold start when the device has no list yet", () => {
    expect(selfPaneState({ isColdStart: true, groupState: "in-sync", drift: null })).toEqual({ state: "coldstart", versionRefresh: false, contentChanged: false });
  });
  it("in-sync content + no drift = insync", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: null })).toEqual({ state: "insync", versionRefresh: false, contentChanged: false });
  });
  it("content in-sync but version ahead (a config-sync update) = capture via versionRefresh", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: "ahead" })).toEqual({ state: "capture", versionRefresh: true, contentChanged: false });
  });
  it("local content changed = capture with contentChanged", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "local-changed", drift: null })).toEqual({ state: "capture", versionRefresh: false, contentChanged: true });
  });
  it("store newer = adopt (content changed)", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "store-newer", drift: null })).toEqual({ state: "adopt", versionRefresh: false, contentChanged: true });
  });
  it("differs both ways = both", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "differs", drift: null })).toEqual({ state: "both", versionRefresh: false, contentChanged: true });
  });
});
