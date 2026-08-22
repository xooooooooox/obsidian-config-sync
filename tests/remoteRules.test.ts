import { describe, it, expect } from "vitest";
import { itemDirection, keyDirection, keyHasOwnRule, keyStopsWithin, refsBlockedFor, withheldPatternsFor, withItemDirection, withKeyDirection } from "../src/core/remoteRules";
import { directionFlows, intersectDirection, ItemRef, RemoteDirection, RemoteItems } from "../src/core/types";

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

describe("keyHasOwnRule", () => {
  it("is false for a key that only inherits its item's direction — even a narrowed one", () => {
    // Under a push-only item, keyDirection resolves every un-ruled key to "push"; the document's
    // colour/clickability must still tell it apart from a key somebody actually ruled.
    expect(keyHasOwnRule(RULES, "community/dataview", "cssTheme")).toBe(false);
    expect(keyHasOwnRule(RULES, "core/backlink", "anything")).toBe(false);
    expect(keyHasOwnRule(undefined, "community/dataview", "accentColor")).toBe(false);
  });

  it("is true for a stored key rule, exact or glob, whatever the item's own direction", () => {
    expect(keyHasOwnRule(RULES, "community/dataview", "accentColor")).toBe(true);
    expect(keyHasOwnRule(RULES, "obsidian/appearance", "accentColor")).toBe(true);
    expect(keyHasOwnRule(RULES, "obsidian/appearance", "accentFont")).toBe(true); // via "accent*"
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

describe("withheldPatternsFor", () => {
  const KEYED: RemoteItems = {
    community: {
      dataview: { keys: { "*Token*": { direction: "none" }, defaultView: { direction: "push" } } },
      "config-sync": { direction: "pull", keys: { passphrase: { direction: "both" } } },
    },
  };

  it("names the keys that do not travel in the asked direction", () => {
    expect(withheldPatternsFor(KEYED, "community/dataview", "pull").sort()).toEqual(["*Token*", "defaultView"]);
    expect(withheldPatternsFor(KEYED, "community/dataview", "push")).toEqual(["*Token*"]);
  });

  it("intersects with the item's own direction, so a key can never travel further than its item", () => {
    // The item is Pull only; the key says both ways, which resolves to pull — so a PUSH withholds it.
    expect(withheldPatternsFor(KEYED, "community/config-sync", "push")).toEqual(["passphrase"]);
    expect(withheldPatternsFor(KEYED, "community/config-sync", "pull")).toEqual([]);
  });

  it("has nothing to say about an item with no key rules", () => {
    expect(withheldPatternsFor(KEYED, "obsidian/app", "pull")).toEqual([]);
    expect(withheldPatternsFor(undefined, "community/dataview", "pull")).toEqual([]);
  });
});

describe("withKeyDirection", () => {
  it("stores a key's decision under its item, leaving the item's own direction alone", () => {
    const next = withKeyDirection({ community: { dataview: { direction: "push" } } }, "community/dataview", "apiKey", "none");
    expect(next).toEqual({ community: { dataview: { direction: "push", keys: { apiKey: { direction: "none" } } } } });
  });

  it("creates the item entry when the key is the first decision made about it", () => {
    expect(withKeyDirection(undefined, "community/dataview", "apiKey", "pull")).toEqual({
      community: { dataview: { keys: { apiKey: { direction: "pull" } } } },
    });
  });

  it("never stores the default: setting a key back to Both ways removes its rule", () => {
    const rules: RemoteItems = { community: { dataview: { keys: { apiKey: { direction: "none" }, other: { direction: "pull" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toEqual({
      community: { dataview: { keys: { other: { direction: "pull" } } } },
    });
  });

  it("drops an item that carries nothing else once its last key rule goes", () => {
    const rules: RemoteItems = { community: { dataview: { keys: { apiKey: { direction: "none" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toBeUndefined();
  });

  it("keeps an item whose own direction is still a decision", () => {
    const rules: RemoteItems = { community: { dataview: { direction: "pull", keys: { apiKey: { direction: "none" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toEqual({ community: { dataview: { direction: "pull" } } });
  });

  it("ignores a ref no build of this parser accepts", () => {
    const rules: RemoteItems = { community: { dataview: { direction: "pull" } } };
    expect(withKeyDirection(rules, "nonsense" as ItemRef, "k", "none")).toEqual(rules);
  });
});

describe("keyStopsWithin", () => {
  it("offers every stop under an item that travels both ways", () => {
    expect(keyStopsWithin("both")).toEqual(["both", "push", "pull", "none"]);
  });

  it("offers only what the item still allows, so a key can never travel further than its item", () => {
    expect(keyStopsWithin("pull")).toEqual(["pull", "none"]);
    expect(keyStopsWithin("push")).toEqual(["push", "none"]);
  });

  it("leaves one stop under an item that travels neither way", () => {
    expect(keyStopsWithin("none")).toEqual(["none"]);
  });
});
