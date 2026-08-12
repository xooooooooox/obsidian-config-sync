import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { SyncGroup, EVERYWHERE, THIS_DEVICE, perClass } from "../src/core/types";

const group: SyncGroup = {
  name: "app", path: "{configDir}/app.json", type: "file", devices: "all",
  mode: "fields",
  fields: [
    { pattern: "userIgnoreFilters", sharing: perClass("desktop"), encrypted: false },
    { pattern: "mobileToolbarCommands", sharing: perClass("mobile"), encrypted: false },
    { pattern: "vimMode", sharing: THIS_DEVICE, encrypted: false },
    { pattern: "promptDelete", sharing: EVERYWHERE, encrypted: false },
  ],
};
const local = JSON.stringify({
  attachmentFolderPath: "99", userIgnoreFilters: ["a/"], mobileToolbarCommands: [], vimMode: true, promptDelete: true,
});

describe("class partition", () => {
  it("capture on desktop: own keys → ownScope, other-class and strip keys dropped, all/inert kept", async () => {
    const t = await captureTransform(group, local, null, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(Object.keys(base).sort()).toEqual(["attachmentFolderPath", "promptDelete"]);
    expect(JSON.parse(t.ownScope as string)).toEqual({ userIgnoreFilters: ["a/"] });
  });
  it("capture on mobile mirrors the split", async () => {
    const t = await captureTransform(group, local, null, "mobile");
    expect(JSON.parse(t.ownScope as string)).toEqual({ mobileToolbarCommands: [] });
    expect(JSON.parse(t.content)).not.toHaveProperty("userIgnoreFilters");
  });
  it("ownScope is null when the group has no own-class patterns", async () => {
    const g: SyncGroup = { ...group, fields: [{ pattern: "vimMode", sharing: THIS_DEVICE, encrypted: false }] };
    const t = await captureTransform(g, local, null, "desktop");
    expect(t.ownScope).toBeNull();
  });
  it("apply reassembles base + own sidecar and preserves other-class/strip keys from local", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store", promptDelete: false });
    const sidecar = JSON.stringify({ userIgnoreFilters: ["fromStore/"] });
    const out = JSON.parse(await applyTransform(group, store, local, null, "desktop", sidecar)) as Record<string, unknown>;
    expect(out["attachmentFolderPath"]).toBe("store");     // base wins
    expect(out["userIgnoreFilters"]).toEqual(["fromStore/"]); // sidecar wins for own class
    expect(out["mobileToolbarCommands"]).toEqual([]);      // other class: local preserved
    expect(out["vimMode"]).toBe(true);                     // strip: local preserved
  });
  it("apply without sidecar preserves own-class keys locally (degradation)", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store" });
    const out = JSON.parse(await applyTransform(group, store, local, null, "desktop", null)) as Record<string, unknown>;
    expect(out["userIgnoreFilters"]).toEqual(["a/"]);
  });
  it("apply drops a stale other-class key still present in an old-format store base", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store", mobileToolbarCommands: ["stale"] });
    const localNoMobile = JSON.stringify({ attachmentFolderPath: "x" });
    const out = JSON.parse(await applyTransform(group, store, localNoMobile, null, "desktop", null)) as Record<string, unknown>;
    expect(out).not.toHaveProperty("mobileToolbarCommands");
  });
  it("sidecar deletion propagates: own-class key missing from sidecar disappears on apply", async () => {
    const out = JSON.parse(await applyTransform(group, "{}", local, null, "desktop", "{}")) as Record<string, unknown>;
    expect(out).not.toHaveProperty("userIgnoreFilters");
  });
  it("contentUnchanged compares own-class keys through the sidecar", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "99", promptDelete: true });
    expect(await contentUnchanged(group, local, store, null, "desktop", JSON.stringify({ userIgnoreFilters: ["a/"] }))).toBe(true);
    expect(await contentUnchanged(group, local, store, null, "desktop", JSON.stringify({ userIgnoreFilters: ["b/"] }))).toBe(false);
    expect(await contentUnchanged(group, local, store, null, "desktop", null)).toBe(true); // no sidecar → own class ignored
  });
});
