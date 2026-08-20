import { describe, it, expect } from "vitest";
import { destinationKey, foldStateKey, PanelDestination, PanelRelation, relationKey, relationLabel } from "../src/ui/panelModel";

describe("relationLabel", () => {
  it("names the two relations exactly as the design says", () => {
    expect(relationLabel({ kind: "device" })).toBe("This device ↔ store");
    expect(relationLabel({ kind: "remote", name: "main" })).toBe("store ↔ main");
  });
});

describe("relationKey / destinationKey", () => {
  it("keeps a remote's key apart from an item category that happens to share its name", () => {
    // "beta" is a real item category AND a plausible remote name — the two must never collide
    expect(relationKey({ kind: "remote", name: "beta" })).not.toBe(destinationKey({ kind: "items", cat: "beta" }));
  });

  it("is stable per value", () => {
    expect(relationKey({ kind: "device" })).toBe(relationKey({ kind: "device" }));
    expect(relationKey({ kind: "remote", name: "a" })).toBe(relationKey({ kind: "remote", name: "a" }));
    expect(relationKey({ kind: "remote", name: "a" })).not.toBe(relationKey({ kind: "remote", name: "b" }));
    expect(destinationKey({ kind: "history" })).not.toBe(destinationKey({ kind: "self" }));
  });
});

describe("foldStateKey", () => {
  it("separates the same fold under two different relations", () => {
    const d: PanelDestination = { kind: "items", cat: "all" };
    const device: PanelRelation = { kind: "device" };
    const remote: PanelRelation = { kind: "remote", name: "main" };
    expect(foldStateKey(device, d, "plugins", "outdated")).not.toBe(foldStateKey(remote, d, "plugins", "outdated"));
  });

  it("separates two folds under the same relation and destination", () => {
    const r: PanelRelation = { kind: "device" };
    const d: PanelDestination = { kind: "items", cat: "all" };
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "plugins", "disabled"));
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "obsidian", "outdated"));
  });
});
