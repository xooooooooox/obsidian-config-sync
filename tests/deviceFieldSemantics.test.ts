import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { EVERYWHERE, SyncGroup } from "../src/core/types";

const group: SyncGroup = {
  name: "graph",
  ref: "core/graph",
  path: "{configDir}/graph.json",
  type: "file",
  devices: "all",
  mode: "fields",
  fields: [{ pattern: "colorGroups", sharing: EVERYWHERE, encrypted: false }],
};

const local = JSON.stringify({ colorGroups: ["mine"], scale: 1 }, null, 2) + "\n";
const store = JSON.stringify({ colorGroups: ["theirs"], scale: 1 }, null, 2) + "\n";

describe("capture with a device exception", () => {
  it("keeps the store's value for the excepted key — never publishes the local one", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["theirs"], scale: 1 });
  });

  it("does not invent the key when the store never had it", async () => {
    const bare = JSON.stringify({ scale: 1 }, null, 2) + "\n";
    const out = await captureTransform(group, local, null, "desktop", bare, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
  });

  it("is idempotent — a second capture reproduces the same bytes", async () => {
    const first = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    const second = await captureTransform(group, local, null, "desktop", first.content, null, ["colorGroups"]);
    expect(second.content).toBe(first.content);
  });

  it("without the exception the local value wins, exactly as before", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, []);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });
});

describe("apply with a device exception", () => {
  it("keeps this device's value and still applies the rest", async () => {
    const out = await applyTransform(group, store, local, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });

  it("with no local file the excepted key does not land", async () => {
    const out = await applyTransform(group, store, null, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ scale: 1 });
  });
});

describe("comparison with a device exception", () => {
  it("differing only in the excepted key reads as unchanged", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, ["colorGroups"])).toBe(true);
  });

  it("a real difference elsewhere still reads as changed", async () => {
    const moved = JSON.stringify({ colorGroups: ["mine"], scale: 2 }, null, 2) + "\n";
    expect(await contentUnchanged(group, moved, store, null, "desktop", null, ["colorGroups"])).toBe(false);
  });

  it("without the exception the same pair reads as changed", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, [])).toBe(false);
  });
});
