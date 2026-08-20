import { describe, it, expect } from "vitest";
import { itemDirection, keyDirection, refsBlockedFor, withItemDirection } from "../src/core/remoteRules";
import { directionFlows, intersectDirection, RemoteDirection, RemoteItems } from "../src/core/types";

describe("directionFlows", () => {
  it("maps each of the four positions to the two flags", () => {
    expect(directionFlows("both")).toEqual({ push: true, pull: true });
    expect(directionFlows("push")).toEqual({ push: true, pull: false });
    expect(directionFlows("pull")).toEqual({ push: false, pull: true });
    expect(directionFlows("none")).toEqual({ push: false, pull: false });
  });
});

describe("intersectDirection", () => {
  it("is the intersection of the two direction SETS, not a max/min on an order", () => {
    // push and pull are incomparable: their intersection is empty, not one of them
    expect(intersectDirection("push", "pull")).toBe("none");
    expect(intersectDirection("pull", "push")).toBe("none");
  });

  it("lets an item widen nothing and a key narrow anything", () => {
    expect(intersectDirection("both", "pull")).toBe("pull");
    expect(intersectDirection("pull", "both")).toBe("pull");
    expect(intersectDirection("none", "both")).toBe("none");
    expect(intersectDirection("push", "push")).toBe("push");
  });

  it("is commutative for every pair", () => {
    const all: RemoteDirection[] = ["both", "push", "pull", "none"];
    for (const a of all) {
      for (const b of all) {
        expect(intersectDirection(a, b)).toBe(intersectDirection(b, a));
      }
    }
  });
});

const RULES: RemoteItems = {
  community: {
    "config-sync": { direction: "none" },
    dataview: { direction: "push", keys: { accentColor: { direction: "pull" } } },
  },
  obsidian: { appearance: { keys: { "accent*": { direction: "none" } } } },
};

describe("itemDirection", () => {
  it("defaults to both for an item, a section, or a rule set nobody mentioned", () => {
    expect(itemDirection(RULES, "core/backlink")).toBe("both");
    expect(itemDirection(RULES, "obsidian/appearance")).toBe("both"); // has keys, no item rule
    expect(itemDirection(undefined, "community/dataview")).toBe("both");
  });

  it("reads the stored value when there is one", () => {
    expect(itemDirection(RULES, "community/config-sync")).toBe("none");
    expect(itemDirection(RULES, "community/dataview")).toBe("push");
  });
});

describe("keyDirection", () => {
  it("intersects the key rule with its item rule", () => {
    // item push, key pull -> empty
    expect(keyDirection(RULES, "community/dataview", "accentColor")).toBe("none");
  });

  it("matches glob patterns and falls back to the item's own direction", () => {
    expect(keyDirection(RULES, "obsidian/appearance", "accentColor")).toBe("none");
    expect(keyDirection(RULES, "obsidian/appearance", "cssTheme")).toBe("both");
  });

  it("never widens past the item", () => {
    expect(keyDirection(RULES, "community/config-sync", "anything")).toBe("none");
  });
});

describe("withItemDirection", () => {
  it("writes a non-default value", () => {
    const next = withItemDirection(undefined, "core/backlink", "pull");
    expect(next?.core?.backlink).toEqual({ direction: "pull" });
  });

  it("removes the entry instead of storing the default", () => {
    const next = withItemDirection(RULES, "community/config-sync", "both");
    expect(next?.community?.["config-sync"]).toBeUndefined();
  });

  it("keeps an entry that still carries key rules when its item rule returns to the default", () => {
    const next = withItemDirection(RULES, "community/dataview", "both");
    expect(next?.community?.dataview).toEqual({ keys: { accentColor: { direction: "pull" } } });
  });

  it("drops the whole map when nothing is left", () => {
    let next = withItemDirection(RULES, "community/config-sync", "both");
    next = withItemDirection(next, "community/dataview", "both");
    next = withItemDirection(next, "obsidian/appearance", "both");
    // obsidian/appearance still holds key rules, so the map survives
    expect(next).not.toBeUndefined();
    expect(withItemDirection(undefined, "core/backlink", "both")).toBeUndefined();
  });
});

describe("refsBlockedFor", () => {
  it("names the items that do not flow in the asked direction", () => {
    expect(refsBlockedFor(RULES, "pull").sort()).toEqual(["community/config-sync", "community/dataview"]);
    expect(refsBlockedFor(RULES, "push").sort()).toEqual(["community/config-sync"]);
  });

  it("is empty when there are no rules", () => {
    expect(refsBlockedFor(undefined, "push")).toEqual([]);
  });
});
