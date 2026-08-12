import { describe, expect, it } from "vitest";
import { classifyJsonKeys, classifyPerElementLines, jsonElementClass } from "../src/ui/jsonView";
import { PerElementSharing, EVERYWHERE, perClass } from "../src/core/types";

describe("classifyJsonKeys", () => {
  it("labels each top-level key by rule/detection state", () => {
    const raw = JSON.stringify({ apiKey: "x", customEndpoint: "y", theme: "dark" });
    const out = classifyJsonKeys(raw, [{ pattern: "apiKey", sharing: EVERYWHERE, encrypted: true }], ["apiKey", "customEndpoint"]);
    expect(out.find((k) => k.key === "apiKey")?.state).toEqual({ sharing: EVERYWHERE, encrypted: true });
    expect(out.find((k) => k.key === "customEndpoint")?.state).toEqual({ sharing: null, encrypted: false });
    expect(out.find((k) => k.key === "customEndpoint")?.detected).toBe(true);
    expect(out.find((k) => k.key === "theme")?.state).toEqual({ sharing: null, encrypted: false });
    expect(out.find((k) => k.key === "theme")?.detected).toBe(false);
  });

  it("classifies class-scoped keys", () => {
    const out = classifyJsonKeys(
      JSON.stringify({ a: 1, b: 2, c: 3 }),
      [{ pattern: "a", sharing: perClass("desktop"), encrypted: false }, { pattern: "b", sharing: perClass("mobile"), encrypted: false }],
      [],
    );
    expect(out).toEqual([
      { key: "a", state: { sharing: perClass("desktop"), encrypted: false }, detected: false },
      { key: "b", state: { sharing: perClass("mobile"), encrypted: false }, detected: false },
      { key: "c", state: { sharing: null, encrypted: false }, detected: false },
    ]);
  });

  it("classifies an encrypted device-scoped key (desktop + encrypted)", () => {
    const out = classifyJsonKeys(JSON.stringify({ a: 1 }), [{ pattern: "a", sharing: perClass("desktop"), encrypted: true }], []);
    expect(out).toEqual([{ key: "a", state: { sharing: perClass("desktop"), encrypted: true }, detected: false }]);
  });

  it("ignores everywhere+unencrypted rules — state stays null (inert override)", () => {
    const out = classifyJsonKeys(JSON.stringify({ a: 1 }), [{ pattern: "a", sharing: EVERYWHERE, encrypted: false }], []);
    expect(out).toEqual([{ key: "a", state: { sharing: null, encrypted: false }, detected: false }]);
  });
});

// FINDING 2 (Task 5 review): per-element array coloring (spec D10 "逐项数组按元素着色") was
// never implemented — these pin the pure state-walk that colors each element of a per-element-ruled array by ITS OWN sharing, independent of unrelated keys and nested structures.
describe("classifyPerElementLines", () => {
  it("colors each element of a per-element array by its own sharing, defaulting an unruled element to everywhere", () => {
    const doc = { userIgnoreFilters: ["*.tmp", "*.log", "*.bak"] };
    const raw = JSON.stringify(doc, null, 2);
    const out = classifyPerElementLines(raw, { userIgnoreFilters: { "*.tmp": perClass("desktop"), "*.log": perClass("mobile") } });
    const lines = raw.split("\n");
    expect(lines[2]!.trim()).toBe('"*.tmp",');
    expect(lines[3]!.trim()).toBe('"*.log",');
    expect(lines[4]!.trim()).toBe('"*.bak"');
    expect(out.get(2)).toEqual({ key: "userIgnoreFilters", value: "*.tmp", sharing: perClass("desktop") });
    expect(out.get(3)).toEqual({ key: "userIgnoreFilters", value: "*.log", sharing: perClass("mobile") });
    expect(out.get(4)).toEqual({ key: "userIgnoreFilters", value: "*.bak", sharing: EVERYWHERE });
    expect(jsonElementClass(out.get(2)!)).toBe("config-sync-json-desktop");
    expect(jsonElementClass(out.get(3)!)).toBe("config-sync-json-mobile");
    expect(jsonElementClass(out.get(4)!)).toBeNull(); // "all" — no color
  });

  it("leaves elements of a key that has NO perElement entry untouched, even though it is also a string array", () => {
    // JSON.stringify(doc, null, 2) is deterministic — line 5 is '"x",' and line 6 is '"y"'
    // (otherArray's own elements), lines verified via the assertions on `lines` below.
    const doc = { userIgnoreFilters: ["*.tmp"], otherArray: ["x", "y"] };
    const raw = JSON.stringify(doc, null, 2);
    const lines = raw.split("\n");
    expect(lines[5]!.trim()).toBe('"x",');
    expect(lines[6]!.trim()).toBe('"y"');
    const out = classifyPerElementLines(raw, { userIgnoreFilters: { "*.tmp": perClass("desktop") } });
    expect(out.has(5)).toBe(false);
    expect(out.has(6)).toBe(false);
  });

  it("does not misattribute lines from nested structures — a same-named key nested inside another object, and an array-of-objects", () => {
    const doc = {
      userIgnoreFilters: ["*.tmp", "*.log"],
      nested: { userIgnoreFilters: ["*.log"] },
      arrOfObjects: [{ a: 1 }, { a: 2 }],
    };
    const raw = JSON.stringify(doc, null, 2);
    const lines = raw.split("\n");
    // Pin the exact lines this test depends on, so a future JSON.stringify formatting surprise
    // fails loudly here instead of silently invalidating the assertions below.
    expect(lines[2]!.trim()).toBe('"*.tmp",'); // top-level userIgnoreFilters[0]
    expect(lines[3]!.trim()).toBe('"*.log"'); // top-level userIgnoreFilters[1]
    expect(lines[7]!.trim()).toBe('"*.log"'); // nested.userIgnoreFilters[0] — same string, wrong key
    const perElement: Record<string, PerElementSharing> = { userIgnoreFilters: { "*.tmp": perClass("desktop"), "*.log": perClass("mobile") } };
    const out = classifyPerElementLines(raw, perElement);
    // top-level userIgnoreFilters elements ARE classified.
    expect(out.get(2)).toEqual({ key: "userIgnoreFilters", value: "*.tmp", sharing: perClass("desktop") });
    expect(out.get(3)).toEqual({ key: "userIgnoreFilters", value: "*.log", sharing: perClass("mobile") });
    // the SAME string, nested two levels deep under "nested", must NOT be classified — it isn't
    // the top-level userIgnoreFilters key at all.
    expect(out.has(7)).toBe(false);
    // array-of-objects must not produce any classified lines, and must not throw / desync depth
    // tracking so the keys after it are unaffected — every classified line belongs to the one
    // real per-item key.
    for (const [, v] of out) expect(v.key).toBe("userIgnoreFilters");
    expect(out.size).toBe(2);
  });
});
