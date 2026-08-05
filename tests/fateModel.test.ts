import { describe, expect, it } from "vitest";
import { rowFate, FateInput } from "../src/ui/fateModel";

const base: FateInput = {
  direction: "apply", conflict: false, nothingYet: false, installed: true,
  hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
  memberRule: "all", deviceClass: "desktop", desktopOnly: false,
  hasSettingsPayload: true, special: null, folderFileCount: null, encrypted: false,
};

describe("rowFate — spec §3 verb table", () => {
  it("install + turn on + settings", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true });
    expect(f.glyph).toBe("↓");
    expect(f.sentence).toBe("Installs · turns on · applies settings");
    expect(f.chips).toContain("not installed here");
    expect(f.turnsOn).toBe(true);
  });
  it("install, off in the store list", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.chips).toContain("stays off");
  });
  it("installed, off here, store list turns it on — no settings", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: true });
    expect(f.sentence).toBe("Turns on");
  });
  it("update", () => {
    const f = rowFate({ ...base, hasUpdate: true });
    expect(f.sentence).toBe("Updates · applies settings");
  });
  it("appearance special", () => {
    const f = rowFate({ ...base, special: "appearance" });
    expect(f.sentence).toBe("Applies theme & snippets — live");
  });
  it("folder", () => {
    const f = rowFate({ ...base, folderFileCount: 2 });
    expect(f.sentence).toBe("Applies 2 files");
  });
  it("capture settings", () => {
    const f = rowFate({ ...base, direction: "capture" });
    expect(f.glyph).toBe("↑");
    expect(f.sentence).toBe("Captures settings");
  });
  it("capture: turned on here", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true });
    expect(f.sentence).toBe("Turned on here — shares it");
  });
  it("conflict", () => {
    const f = rowFate({ ...base, conflict: true });
    expect(f.glyph).toBe("⚠");
    expect(f.sentence).toBe("Changed on both sides");
    expect(f.stageable).toBe(false);
  });
  it("in sync / nothing yet", () => {
    expect(rowFate({ ...base, direction: null }).sentence).toBe("In sync");
    expect(rowFate({ ...base, direction: null, nothingYet: true }).sentence).toBe("Nothing to sync yet");
    expect(rowFate({ ...base, direction: null }).stageable).toBe(false);
  });
});

describe("rowFate — Runs on re-derivation", () => {
  it("never-here removes turns on, adds rule chip", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "never-here" });
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).toContain("off here — your rule");
    expect(f.turnsOn).toBe(false);
  });
  it("always-here on a store-off plugin adds turns on + rule chip", () => {
    const f = rowFate({ ...base, storeListOn: false, memberRule: "always-here" });
    expect(f.sentence).toBe("Turns on · applies settings");
    expect(f.chips).toContain("on here — your rule");
  });
  it("class rule suppresses turn-on on the wrong class", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "mobile", deviceClass: "desktop" });
    expect(f.turnsOn).toBe(false);
  });
  it("carrier unsynced suppresses enablement verbs entirely", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true, carrierSynced: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.sentence).not.toContain("turns on");
  });
});
