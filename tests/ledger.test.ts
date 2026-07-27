import { describe, expect, it } from "vitest";
import {
  ABSENT_HASH, applyUpdates, emptyLedger, hashDirSide, hashFileSide,
  Ledger, parseLedger, pruneLedger, sha256Hex,
} from "../src/core/ledger";

const ENTRY = { store: "s1", local: "l1", at: "2026-07-27T00:00:00.000Z" };

describe("parseLedger", () => {
  it("returns empty on null/garbage/wrong version", () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger("not json")).toEqual(emptyLedger());
    expect(parseLedger(JSON.stringify({ version: 2, groups: {} }))).toEqual(emptyLedger());
  });
  it("round-trips a valid ledger from its JSON string and drops malformed entries", () => {
    const raw = JSON.stringify({ version: 1, groups: { a: ENTRY, bad: { store: 5 } } });
    expect(parseLedger(raw)).toEqual({ version: 1, groups: { a: ENTRY } });
  });
});

describe("applyUpdates / pruneLedger", () => {
  it("adds, replaces, and drops entries without mutating the input", () => {
    const base: Ledger = { version: 1, groups: { a: ENTRY } };
    const next = applyUpdates(base, { b: ENTRY, a: null });
    expect(next.groups).toEqual({ b: ENTRY });
    expect(base.groups).toEqual({ a: ENTRY }); // pure
  });
  it("prunes entries not in keep", () => {
    const base: Ledger = { version: 1, groups: { a: ENTRY, b: ENTRY } };
    expect(pruneLedger(base, new Set(["a"])).groups).toEqual({ a: ENTRY });
  });
});

describe("hashing", () => {
  it("sha256Hex is deterministic and hex-shaped", async () => {
    const h = await sha256Hex("x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("x")).toBe(h);
  });
  it("hashFileSide: absent content hashes to the sentinel", async () => {
    expect(await hashFileSide("hotkeys", null, "local")).toBe(ABSENT_HASH);
  });
  it("hashFileSide: switch lists hash the set, not the bytes", async () => {
    const a = await hashFileSide("community-plugins", '["b","a"]', "store");
    const b = await hashFileSide("community-plugins", '["a", "b"]\n', "store");
    expect(a).toBe(b);
    const c = await hashFileSide("community-plugins", '["a","c"]', "store");
    expect(c).not.toBe(a);
  });
  it("hashFileSide: enabled-css-snippets local side reads the appearance.json field", async () => {
    const a = await hashFileSide("enabled-css-snippets", '{"enabledCssSnippets":["y","x"],"theme":"T"}', "local");
    const b = await hashFileSide("enabled-css-snippets", '["x","y"]', "store");
    expect(a).toBe(b); // same set → same canonical hash, regardless of carrier shape
  });
  it("hashFileSide: unparseable switch list falls back to raw bytes", async () => {
    const a = await hashFileSide("community-plugins", "not json", "store");
    expect(a).toBe(await sha256Hex("not json"));
  });
  it("hashDirSide: order-insensitive over rel, content-sensitive", async () => {
    const a = await hashDirSide([{ rel: "b.css", content: "B" }, { rel: "a.css", content: "A" }]);
    const b = await hashDirSide([{ rel: "a.css", content: "A" }, { rel: "b.css", content: "B" }]);
    expect(a).toBe(b);
    const c = await hashDirSide([{ rel: "a.css", content: "A2" }, { rel: "b.css", content: "B" }]);
    expect(c).not.toBe(a);
  });
});
