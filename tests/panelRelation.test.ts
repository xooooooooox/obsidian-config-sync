import { describe, it, expect } from "vitest";
import { destinationKey, foldStateKey, PanelDestination, PanelRelation, relationKey, relationLabel, viewOptions } from "../src/ui/panelModel";

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

describe("viewOptions", () => {
  const remotes = [
    { name: "main", state: "remote-newer" as const },
    { name: "work", state: "same" as const },
  ];

  it("puts this device first, then the remotes in the order settings gave them", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.label)).toEqual(["This device ↔ store", "store ↔ main", "store ↔ work"]);
  });

  it("marks exactly one option active, by value not by identity", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "work" }, deviceCounts: { up: 3, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([false, false, true]);
  });

  it("falls back to this device when the current remote is gone", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "deleted" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([true, false, false]);
  });

  it("gives this device its capture/apply counts and drops the zeroes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 11, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([{ kind: "capture", count: 11 }]);
  });

  it("gives this device no badges at all when nothing is waiting", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([]);
  });

  it("gives each remote its whole-store state, always — including the ones with nothing to do", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts[1]?.badges).toEqual([{ kind: "remote-state", state: "remote-newer" }]);
    expect(opts[2]?.badges).toEqual([{ kind: "remote-state", state: "same" }]);
  });

  it("offers this device alone when there are no remotes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 1, down: 2 }, remotes: [] });
    expect(opts).toHaveLength(1);
    expect(opts[0]?.badges).toEqual([
      { kind: "capture", count: 1 },
      { kind: "apply", count: 2 },
    ]);
  });
});
