import { describe, expect, it } from "vitest";
import {
  ABSENT_HASH, applyUpdates, baselineRefs, emptyLedger, hashDirSide, hashFileSide,
  Ledger, LEDGER_VERSION, parseLedger, pruneLedger, rekeyLedger, sha256Hex,
} from "../src/core/ledger";
import { SyncGroup } from "../src/core/types";

const ENTRY = { store: "s1", local: "l1", at: "2026-07-27T00:00:00.000Z" };

describe("parseLedger", () => {
  it("returns empty on null/garbage/a version from the future", () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger("not json")).toEqual(emptyLedger());
    expect(parseLedger(JSON.stringify({ version: 9, items: {} }))).toEqual(emptyLedger());
  });
  it("round-trips a v2 ledger from its JSON string and drops malformed entries", () => {
    const raw = JSON.stringify({ version: LEDGER_VERSION, items: { "community/a": ENTRY, bad: { store: 5 } } });
    expect(parseLedger(raw)).toEqual({ version: LEDGER_VERSION, items: { "community/a": ENTRY } });
  });
  // A v1 ledger is READ, not re-keyed: the conversion needs the compiled sync list, which does not
  // exist at parse time (spec §4). The version it reports is what tells rekeyLedger there is work.
  it("reads a v1 ledger's group-name keys unchanged, and says it is v1", () => {
    const raw = JSON.stringify({ version: 1, groups: { "plugin-a": ENTRY, bad: { store: 5 } } });
    expect(parseLedger(raw)).toEqual({ version: 1, items: { "plugin-a": ENTRY } });
  });
});

describe("rekeyLedger (spec §4 — the baselines move with the lock)", () => {
  const toRef = (name: string): string => (name.startsWith("plugin-") ? `community/${name.slice("plugin-".length)}` : `legacy/${name}`);

  it("moves every v1 key through the producer and stamps the new version", () => {
    const v1: Ledger = { version: 1, items: { "plugin-a": ENTRY } };
    expect(rekeyLedger(v1, toRef)).toEqual({ version: LEDGER_VERSION, items: { "community/a": ENTRY } });
  });
  it("is a no-op on a ledger that has already moved — the same object, not a copy", () => {
    const v2: Ledger = { version: LEDGER_VERSION, items: { "community/a": ENTRY } };
    expect(rekeyLedger(v2, toRef)).toBe(v2);
  });
  // The §4 ruling: a migration with no undo is not allowed to delete. An entry nothing claims keeps
  // its content under a section no reader can resolve — inert, but never dropped, because a missing
  // baseline reads as never-synced and defaults to APPLY.
  it("keeps an entry nothing claims, under a key no reader can resolve", () => {
    const v1: Ledger = { version: 1, items: { "plugin-a": ENTRY, "who-knows": ENTRY } };
    const moved = rekeyLedger(v1, toRef);
    expect(moved.items["legacy/who-knows"]).toEqual(ENTRY);
    expect(Object.keys(moved.items).length).toBe(2); // nothing lost
  });
});

describe("applyUpdates / pruneLedger", () => {
  it("adds, replaces, and drops entries without mutating the input", () => {
    const base: Ledger = { version: LEDGER_VERSION, items: { "community/a": ENTRY } };
    const next = applyUpdates(base, { "community/b": ENTRY, "community/a": null });
    expect(next.items).toEqual({ "community/b": ENTRY });
    expect(base.items).toEqual({ "community/a": ENTRY }); // pure
  });
  it("prunes entries not in keep", () => {
    const base: Ledger = { version: LEDGER_VERSION, items: { "community/a": ENTRY, "community/b": ENTRY } };
    expect(pruneLedger(base, new Set(["community/a"])).items).toEqual({ "community/a": ENTRY });
  });
  // The prune is what eventually clears an unresolvable entry the re-key preserved: the migration
  // never deletes, and the prune answers the question it cannot — is this still synced HERE?
  it("baselineRefs is the keep-set: the refs of the groups this device syncs, and only those", () => {
    const groups: SyncGroup[] = [
      { name: "plugin-a", ref: "community/a", path: "{configDir}/plugins/a/data.json", type: "file", devices: "all" },
      { name: "loose", path: "{configDir}/loose.json", type: "file", devices: "all" },
    ];
    expect(baselineRefs(groups)).toEqual(new Set(["community/a"]));
    const base: Ledger = { version: LEDGER_VERSION, items: { "community/a": ENTRY, "legacy/who-knows": ENTRY } };
    expect(Object.keys(pruneLedger(base, baselineRefs(groups)).items)).toEqual(["community/a"]);
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
