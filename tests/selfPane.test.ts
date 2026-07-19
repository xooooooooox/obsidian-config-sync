import { describe, expect, it } from "vitest";
import { selfPaneState } from "../src/core/selfPane";

describe("selfPaneState", () => {
  it("cold start when the device has no list yet", () => {
    expect(selfPaneState({ isColdStart: true, groupState: "in-sync", drift: null, flagsDrift: false })).toEqual({ state: "coldstart", versionRefresh: false, contentChanged: false, flagsRefresh: false });
  });
  it("in-sync content + no drift = insync", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: null, flagsDrift: false })).toEqual({ state: "insync", versionRefresh: false, contentChanged: false, flagsRefresh: false });
  });
  it("content in-sync but version ahead (a config-sync update) = capture via versionRefresh", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: "ahead", flagsDrift: false })).toEqual({ state: "capture", versionRefresh: true, contentChanged: false, flagsRefresh: false });
  });
  it("local content changed = capture with contentChanged", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "local-changed", drift: null, flagsDrift: false })).toEqual({ state: "capture", versionRefresh: false, contentChanged: true, flagsRefresh: false });
  });
  it("store newer = adopt (content changed)", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "store-newer", drift: null, flagsDrift: false })).toEqual({ state: "adopt", versionRefresh: false, contentChanged: true, flagsRefresh: false });
  });
  it("differs both ways = both", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "differs", drift: null, flagsDrift: false })).toEqual({ state: "both", versionRefresh: false, contentChanged: true, flagsRefresh: false });
  });
  it("flags drift with an otherwise in-sync self = capture via flagsRefresh", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: null, flagsDrift: true })).toEqual({ state: "capture", versionRefresh: false, contentChanged: false, flagsRefresh: true });
  });
  it("version refresh and flags refresh compose", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: "ahead", flagsDrift: true })).toEqual({ state: "capture", versionRefresh: true, contentChanged: false, flagsRefresh: true });
  });
  it("flags drift does not override adopt", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "store-newer", drift: null, flagsDrift: true })).toEqual({ state: "adopt", versionRefresh: false, contentChanged: true, flagsRefresh: true });
  });
});
