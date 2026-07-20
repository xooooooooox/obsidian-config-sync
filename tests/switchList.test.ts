import { describe, expect, it } from "vitest";
import {
  SWITCH_LIST_GROUPS, readLocalSwitchList, writeLocalSwitchList, localRealPath, subtractForceOff,
  parseSwitchList,
  captureSwitchList,
  applySwitchList,
  switchDivergence,
  switchListsEqual,
  switchListSortedView,
  type SwitchList,
} from "../src/core/switchList";

describe("SWITCH_LIST_GROUPS (now derived from SWITCH_LISTS)", () => {
  it("has community-plugins, core-plugins, enabled-css-snippets", () => {
    expect(SWITCH_LIST_GROUPS.has("community-plugins")).toBe(true);
    expect(SWITCH_LIST_GROUPS.has("core-plugins")).toBe(true);
    expect(SWITCH_LIST_GROUPS.has("enabled-css-snippets")).toBe(true);
    expect(SWITCH_LIST_GROUPS.size).toBe(3);
  });
});

describe("readLocalSwitchList", () => {
  it("plain groups parse the whole file (unchanged)", () => {
    expect(readLocalSwitchList("community-plugins", '["a","b"]')).toEqual(["a", "b"]);
  });
  it("field group extracts the array field", () => {
    const app = JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "a-mobile"], baseFontSize: 16 });
    expect(readLocalSwitchList("enabled-css-snippets", app)).toEqual(["a", "a-mobile"]);
  });
  it("field group returns [] when the field is absent", () => {
    expect(readLocalSwitchList("enabled-css-snippets", '{"cssTheme":"X"}')).toEqual([]);
  });
  it("field group returns null on non-string array or bad json", () => {
    expect(readLocalSwitchList("enabled-css-snippets", '{"enabledCssSnippets":[1,2]}')).toBeNull();
    expect(readLocalSwitchList("enabled-css-snippets", "not json")).toBeNull();
  });
});

describe("writeLocalSwitchList", () => {
  it("field group replaces only the field, preserving siblings", () => {
    const prior = JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["old"], baseFontSize: 16 });
    const out = JSON.parse(writeLocalSwitchList("enabled-css-snippets", ["a", "a-desktop"], prior)) as { cssTheme: string; enabledCssSnippets: string[]; baseFontSize: number };
    expect(out).toEqual({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 });
  });
  it("field group tolerates null/garbage prior content", () => {
    expect(JSON.parse(writeLocalSwitchList("enabled-css-snippets", ["a"], null)) as { enabledCssSnippets: string[] }).toEqual({ enabledCssSnippets: ["a"] });
  });
  it("plain groups serialize the list as before (2-space + newline)", () => {
    expect(writeLocalSwitchList("community-plugins", ["a", "b"], null)).toBe(JSON.stringify(["a", "b"], null, 2) + "\n");
  });
});

describe("localRealPath", () => {
  it("redirects the snippet group to appearance.json", () => {
    expect(localRealPath("enabled-css-snippets", "{configDir}/enabled-css-snippets.json", ".obs")).toBe(".obs/appearance.json");
  });
  it("returns groupRealPath for plain switch lists and other groups", () => {
    expect(localRealPath("community-plugins", "{configDir}/community-plugins.json", ".obs")).toBe(".obs/community-plugins.json");
    expect(localRealPath("hotkeys", "{configDir}/hotkeys.json", ".obs")).toBe(".obs/hotkeys.json");
  });
});

describe("subtractForceOff", () => {
  it("removes force-off ids from an array list", () => {
    expect(subtractForceOff(["a", "a-mobile", "b"], ["a-mobile"])).toEqual(["a", "b"]);
  });
  it("is identity for empty force-off and for map lists", () => {
    expect(subtractForceOff(["a", "b"], [])).toEqual(["a", "b"]);
    expect(subtractForceOff({ a: true }, ["a"])).toEqual({ a: true });
  });
});

describe("parseSwitchList", () => {
  it("parses JSON array of strings", () => {
    const result = parseSwitchList('["a", "b", "c"]');
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("parses JSON object with boolean values", () => {
    const result = parseSwitchList('{"a": true, "b": false}');
    expect(result).toEqual({ a: true, b: false });
  });

  it("parses empty array", () => {
    const result = parseSwitchList("[]");
    expect(result).toEqual([]);
  });

  it("parses empty object", () => {
    const result = parseSwitchList("{}");
    expect(result).toEqual({});
  });

  it("returns null for garbage input", () => {
    expect(parseSwitchList("not json")).toBeNull();
    expect(parseSwitchList("123")).toBeNull();
    expect(parseSwitchList('"string"')).toBeNull();
  });

  it("returns null for array containing non-strings", () => {
    expect(parseSwitchList("[1, 2, 3]")).toBeNull();
    expect(parseSwitchList('["a", 1, "c"]')).toBeNull();
    expect(parseSwitchList('["a", {"nested": true}]')).toBeNull();
  });

  it("returns null for object with non-boolean values", () => {
    expect(parseSwitchList('{"a": "string"}')).toBeNull();
    expect(parseSwitchList('{"a": true, "b": "false"}')).toBeNull();
    expect(parseSwitchList('{"a": true, "b": 1}')).toBeNull();
    expect(parseSwitchList('{"a": true, "b": null}')).toBeNull();
  });

  it("returns null for objects that are arrays", () => {
    // Array is technically an object in JSON, but we reject it for the object path
    expect(parseSwitchList('[{"a": true}]')).toBeNull();
  });
});

describe("captureSwitchList (array shape) — pass-through for excluded ids (甲)", () => {
  it("returns structurally equal copy with empty exceptions (store irrelevant)", () => {
    const input: SwitchList = ["a", "b", "c"];
    const result = captureSwitchList(input, ["stale"], []);
    expect(result).toEqual(input);
    expect(result).not.toBe(input); // different reference
  });

  it("with no store (first capture), excluded ids contribute nothing", () => {
    const input: SwitchList = ["a", "b", "c", "d"];
    expect(captureSwitchList(input, null, ["b"])).toEqual(["a", "c", "d"]);
    expect(captureSwitchList(input, null, ["b", "d"])).toEqual(["a", "c"]);
  });

  it("preserves the store's existing entry for an excluded id, in its store position", () => {
    // local has it, store has it, excluded → store keeps it IN PLACE (not deleted, not moved)
    expect(captureSwitchList(["a", "x", "b"], ["a", "x", "b"], ["x"])).toEqual(["a", "x", "b"]);
    // local has it, store does NOT → excluded id is not added
    expect(captureSwitchList(["a", "x", "b"], ["a", "b"], ["x"])).toEqual(["a", "b"]);
    // local lacks it, store has it → excluded id stays in store, in place
    expect(captureSwitchList(["a", "b"], ["a", "x"], ["x"])).toEqual(["a", "x", "b"]);
  });

  it("identical membership captures byte-identical to the store, whatever the local order", () => {
    // Obsidian writes local lists in per-device enable order; same members must mean no churn
    expect(captureSwitchList(["c", "a", "b"], ["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(captureSwitchList(["c", "a"], ["a", "x", "c"], ["x"])).toEqual(["a", "x", "c"]);
  });

  it("unrelated changes flow through while the excluded entry is untouched", () => {
    // B installs "calendar"; excluded "remote-save" must survive in the store list
    expect(captureSwitchList(["dataview", "brat", "calendar"], ["dataview", "brat", "remote-save"], ["remote-save"])).toEqual([
      "dataview",
      "brat",
      "remote-save",
      "calendar",
    ]);
  });

  it("handles non-existent exceptions gracefully", () => {
    expect(captureSwitchList(["a", "b"], ["a", "b"], ["x", "y"])).toEqual(["a", "b"]);
  });
});

describe("captureSwitchList (map shape) — pass-through for excluded ids (甲)", () => {
  it("returns structurally equal copy with empty exceptions", () => {
    const input: SwitchList = { a: true, b: false };
    const result = captureSwitchList(input, { a: true }, []);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it("with no store, excluded keys contribute nothing", () => {
    expect(captureSwitchList({ a: true, b: false, c: true }, null, ["b"])).toEqual({ a: true, c: true });
  });

  it("preserves the store's entry state for excluded keys (true, false, and absent)", () => {
    // store has true → stays true regardless of local
    expect(captureSwitchList({ a: true, x: false }, { a: true, x: true }, ["x"])).toEqual({ a: true, x: true });
    // store has false → stays false
    expect(captureSwitchList({ a: true, x: true }, { a: true, x: false }, ["x"])).toEqual({ a: true, x: false });
    // store absent → stays absent even though local has it
    expect(captureSwitchList({ a: true, x: true }, { a: true }, ["x"])).toEqual({ a: true });
  });
});

describe("switchDivergence (bidirectional summary)", () => {
  it("splits non-excluded divergence into captureRemoves / applyDisables, sorted", () => {
    const local = ["z-local-only", "a-local-only", "common"];
    const store = ["common", "store-only-b", "store-only-a"];
    expect(switchDivergence(local, store, [])).toEqual({
      captureRemoves: ["store-only-a", "store-only-b"],
      applyDisables: ["a-local-only", "z-local-only"],
    });
  });

  it("masks excluded ids on both sides", () => {
    const local = ["mine", "kept-here"];
    const store = ["theirs", "kept-here"];
    expect(switchDivergence(local, store, ["mine", "theirs"])).toEqual({ captureRemoves: [], applyDisables: [] });
  });

  it("one-sided differences populate only their side", () => {
    expect(switchDivergence(["a", "b"], ["a"], [])).toEqual({ captureRemoves: [], applyDisables: ["b"] });
    expect(switchDivergence(["a"], ["a", "b"], [])).toEqual({ captureRemoves: ["b"], applyDisables: [] });
  });

  it("map shapes compare by truthy membership", () => {
    expect(switchDivergence({ a: true, b: false, c: true }, { a: true, d: true }, [])).toEqual({
      captureRemoves: ["d"],
      applyDisables: ["c"], // b is false locally → not enabled → not a divergence
    });
  });
});

describe("switchListSortedView (display canonicalization)", () => {
  it("sorts array lists and map keys; passes unparseable content through", () => {
    expect(switchListSortedView('["c","a","b"]')).toBe(JSON.stringify(["a", "b", "c"], null, 2) + "\n");
    expect(switchListSortedView('{"b":false,"a":true}')).toBe(JSON.stringify({ a: true, b: false }, null, 2) + "\n");
    expect(switchListSortedView("not json")).toBe("not json");
  });
});

describe("applySwitchList (array shape)", () => {
  it("returns store with empty exceptions when local is null", () => {
    const store: SwitchList = ["a", "b", "c"];
    const result = applySwitchList(store, null, []);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns store minus exceptions when local is null", () => {
    const store: SwitchList = ["a", "b", "c", "d"];
    expect(applySwitchList(store, null, ["b", "d"])).toEqual(["a", "c"]);
  });

  it("combines store (minus exceptions, store order) with local (intersect exceptions, local order)", () => {
    // store has [a, b, c], exceptions are [b]
    // result: (store - [b]) in store order = [a, c], then (local ∩ [b]) in local order
    const store: SwitchList = ["a", "b", "c"];
    const local: SwitchList = ["x", "b", "y"];
    expect(applySwitchList(store, local, ["b"])).toEqual(["a", "c", "b"]);
  });

  it("orders synced ids by store, excepted ids by local", () => {
    // store [a, b, c, d], local [d, x, b, y], exceptions [b, d]
    // synced: [a, c] (store order)
    // excepted in local: [d, b] (local order)
    // result: [a, c, d, b]
    const store: SwitchList = ["a", "b", "c", "d"];
    const local: SwitchList = ["d", "x", "b", "y"];
    expect(applySwitchList(store, local, ["b", "d"])).toEqual(["a", "c", "d", "b"]);
  });

  it("handles local ids that are not in exceptions", () => {
    const store: SwitchList = ["a", "b"];
    const local: SwitchList = ["b", "c"];
    expect(applySwitchList(store, local, ["b"])).toEqual(["a", "b"]);
  });

  it("handles excepted ids absent from local", () => {
    const store: SwitchList = ["a", "b", "c"];
    const local: SwitchList = ["a", "c"];
    expect(applySwitchList(store, local, ["b"])).toEqual(["a", "c"]);
  });

  it("handles empty store and exceptions", () => {
    const store: SwitchList = [];
    const local: SwitchList = ["a", "b"];
    expect(applySwitchList(store, local, [])).toEqual([]);
  });

  it("handles empty local with exceptions", () => {
    const store: SwitchList = ["a", "b"];
    const local: SwitchList = [];
    expect(applySwitchList(store, local, ["a"])).toEqual(["b"]);
  });
});

describe("applySwitchList (map shape)", () => {
  it("returns store with empty exceptions when local is null", () => {
    const store: SwitchList = { a: true, b: false };
    const result = applySwitchList(store, null, []);
    expect(result).toEqual({ a: true, b: false });
  });

  it("returns store minus exceptions when local is null", () => {
    const store: SwitchList = { a: true, b: false, c: true };
    expect(applySwitchList(store, null, ["b"])).toEqual({ a: true, c: true });
  });

  it("combines store (minus exceptions) with local entries for excepted keys", () => {
    const store: SwitchList = { a: true, b: false, c: true };
    const local: SwitchList = { b: true };
    expect(applySwitchList(store, local, ["b"])).toEqual({ a: true, c: true, b: true });
  });

  it("preserves local false value for excepted keys", () => {
    const store: SwitchList = { a: true, b: true };
    const local: SwitchList = { b: false };
    expect(applySwitchList(store, local, ["b"])).toEqual({ a: true, b: false });
  });

  it("keeps absent excepted keys absent if absent locally", () => {
    const store: SwitchList = { a: true };
    const local: SwitchList = { a: false };
    expect(applySwitchList(store, local, ["b"])).toEqual({ a: true });
  });

  it("adds local excepted keys that are absent from store", () => {
    const store: SwitchList = { a: true };
    const local: SwitchList = { a: false, b: true };
    expect(applySwitchList(store, local, ["b"])).toEqual({ a: true, b: true });
  });

  it("handles multiple excepted keys", () => {
    const store: SwitchList = { a: true, b: false, c: true, d: false };
    const local: SwitchList = { b: true, d: true };
    expect(applySwitchList(store, local, ["b", "d"])).toEqual({ a: true, c: true, b: true, d: true });
  });

  it("handles empty store and exceptions", () => {
    const store: SwitchList = {};
    const local: SwitchList = { a: true };
    expect(applySwitchList(store, local, [])).toEqual({});
  });

  it("handles empty local with exceptions", () => {
    const store: SwitchList = { a: true, b: false };
    const local: SwitchList = {};
    expect(applySwitchList(store, local, ["b"])).toEqual({ a: true });
  });
});

describe("applySwitchList (mixed shapes)", () => {
  it("when store is array and local is map, prefers store shape with membership semantics", () => {
    // store is array [a, b], local is map {b: false}
    // array result should contain: [a, b] (both in store) with [b] as exceptions from local
    // Membership check: b present in store array, present in local map with false
    const store: SwitchList = ["a", "b"];
    const local: SwitchList = { b: false };
    const result = applySwitchList(store, local, ["b"]);
    // store minus exceptions [a], local map membership for [b] = false means don't include
    expect(result).toEqual(["a"]);
  });

  it("when store is map and local is array, prefers store shape with membership semantics", () => {
    const store: SwitchList = { a: true, b: true };
    const local: SwitchList = ["a"];
    const result = applySwitchList(store, local, ["b"]);
    // store minus exceptions {a: true}, local array membership for [b] = not present
    expect(result).toEqual({ a: true });
  });
});

describe("switchListsEqual (array shape)", () => {
  it("returns true for identical arrays with no exceptions", () => {
    const a: SwitchList = ["x", "y", "z"];
    const b: SwitchList = ["x", "y", "z"];
    expect(switchListsEqual(a, b, [])).toBe(true);
  });

  it("returns false for different arrays with no exceptions", () => {
    const a: SwitchList = ["x", "y"];
    const b: SwitchList = ["x", "z"];
    expect(switchListsEqual(a, b, [])).toBe(false);
  });

  it("returns true for arrays that differ only in order (masked sets, order-insensitive)", () => {
    const a: SwitchList = ["x", "y"];
    const b: SwitchList = ["y", "x"];
    expect(switchListsEqual(a, b, [])).toBe(true);
  });

  it("masks exceptions and compares remaining as sets (order-insensitive)", () => {
    // local [a, b, c], store [a, c, b], exceptions [b]
    // masked: local [a, c], store [a, c] (sets, ignore order)
    const local: SwitchList = ["a", "b", "c"];
    const store: SwitchList = ["a", "c", "b"];
    expect(switchListsEqual(local, store, ["b"])).toBe(true);
  });

  it("returns false if masked sets differ", () => {
    const local: SwitchList = ["a", "b", "c"];
    const store: SwitchList = ["a", "d"];
    expect(switchListsEqual(local, store, ["b"])).toBe(false);
  });

  it("ignores excepted ids completely", () => {
    const local: SwitchList = ["a", "x"];
    const store: SwitchList = ["a", "y"];
    expect(switchListsEqual(local, store, ["x", "y"])).toBe(true);
  });

  it("handles empty arrays", () => {
    const a: SwitchList = [];
    const b: SwitchList = [];
    expect(switchListsEqual(a, b, [])).toBe(true);
  });

  it("returns false for different-length arrays with no common sync ids", () => {
    const a: SwitchList = ["a"];
    const b: SwitchList = [];
    expect(switchListsEqual(a, b, [])).toBe(false);
  });
});

describe("switchListsEqual (map shape)", () => {
  it("returns true for identical maps with no exceptions", () => {
    const a: SwitchList = { x: true, y: false };
    const b: SwitchList = { x: true, y: false };
    expect(switchListsEqual(a, b, [])).toBe(true);
  });

  it("returns false for different maps with no exceptions", () => {
    const a: SwitchList = { x: true };
    const b: SwitchList = { x: false };
    expect(switchListsEqual(a, b, [])).toBe(false);
  });

  it("masks exceptions and compares remaining keys/values", () => {
    const local: SwitchList = { a: true, b: false };
    const store: SwitchList = { a: true, b: true };
    expect(switchListsEqual(local, store, ["b"])).toBe(true);
  });

  it("returns false if masked maps differ in values", () => {
    const local: SwitchList = { a: true, b: false };
    const store: SwitchList = { a: false, b: false };
    expect(switchListsEqual(local, store, ["b"])).toBe(false);
  });

  it("returns false if masked maps differ in synced keys", () => {
    const local: SwitchList = { a: true, b: false };
    const store: SwitchList = { a: true };
    // After masking [b]: local {a: true}, store {a: true} → equal
    expect(switchListsEqual(local, store, ["b"])).toBe(true);
  });

  it("returns false if masked maps differ in keys (synced key absent)", () => {
    const local: SwitchList = { a: true, c: true, b: false };
    const store: SwitchList = { a: true };
    // After masking [b]: local {a: true, c: true}, store {a: true} → different
    expect(switchListsEqual(local, store, ["b"])).toBe(false);
  });

  it("ignores excepted keys completely", () => {
    const local: SwitchList = { a: true, x: false };
    const store: SwitchList = { a: true, y: true };
    expect(switchListsEqual(local, store, ["x", "y"])).toBe(true);
  });

  it("handles empty maps", () => {
    const a: SwitchList = {};
    const b: SwitchList = {};
    expect(switchListsEqual(a, b, [])).toBe(true);
  });
});

describe("switchListsEqual (mixed shapes)", () => {
  it("returns false when shapes differ", () => {
    const arr: SwitchList = ["a", "b"];
    const map: SwitchList = { a: true, b: true };
    expect(switchListsEqual(arr, map, [])).toBe(false);
  });

  it("returns false for mixed shapes even with exceptions that would mask differences", () => {
    const arr: SwitchList = ["a"];
    const map: SwitchList = { a: true };
    expect(switchListsEqual(arr, map, [])).toBe(false);
  });
});

describe("edge cases and identity", () => {
  it("capture with no exceptions returns structurally-equal array", () => {
    const input: SwitchList = ["a", "b"];
    const result = captureSwitchList(input, null, []);
    expect(result).toEqual(input);
    expect(Array.isArray(result)).toBe(true);
  });

  it("capture with no exceptions returns structurally-equal map", () => {
    const input: SwitchList = { a: true, b: false };
    const result = captureSwitchList(input, null, []);
    expect(result).toEqual(input);
    expect(Array.isArray(result)).toBe(false);
  });

  it("apply with store and no local/exceptions is identity for arrays", () => {
    const store: SwitchList = ["a", "b", "c"];
    const result = applySwitchList(store, null, []);
    expect(result).toEqual(store);
  });

  it("apply with store and no local/exceptions is identity for maps", () => {
    const store: SwitchList = { a: true, b: false };
    const result = applySwitchList(store, null, []);
    expect(result).toEqual(store);
  });

  it("equality with no exceptions is plain deep equality for arrays", () => {
    expect(switchListsEqual(["a", "b"], ["a", "b"], [])).toBe(true);
    expect(switchListsEqual(["a", "b"], ["a"], [])).toBe(false);
  });

  it("equality with no exceptions is plain deep equality for maps", () => {
    expect(switchListsEqual({ a: true }, { a: true }, [])).toBe(true);
    expect(switchListsEqual({ a: true }, { a: false }, [])).toBe(false);
  });

  it("multiple calls with empty exceptions produce identical outputs", () => {
    const arr: SwitchList = ["a", "b"];
    const map: SwitchList = { a: true };
    expect(captureSwitchList(arr, null, [])).toEqual(captureSwitchList(arr, null, []));
    expect(captureSwitchList(map, null, [])).toEqual(captureSwitchList(map, null, []));
  });

  it("roundtrip: capture then apply with same local and empty exceptions", () => {
    // If we capture with exceptions, store loses those ids
    // Then apply with same local/exceptions, we should restore the full picture
    const local: SwitchList = ["a", "b", "c"];
    const captured = captureSwitchList(local, null, ["b"]);
    // captured should be ["a", "c"]
    expect(captured).toEqual(["a", "c"]);
    // Now apply with the original local and same exceptions
    const restored = applySwitchList(captured, local, ["b"]);
    // should be (captured) + (local ∩ exceptions) = [a, c] + [b] = [a, c, b]
    expect(restored).toEqual(["a", "c", "b"]);
  });

  it("preserves false in maps across capture and apply", () => {
    const local: SwitchList = { a: true, b: false };
    const captured = captureSwitchList(local, null, ["b"]);
    expect(captured).toEqual({ a: true });

    const store = captured;
    const restored = applySwitchList(store, local, ["b"]);
    expect(restored).toEqual({ a: true, b: false });
  });
});
