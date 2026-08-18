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
  // exist at parse time. The version it reports is what tells rekeyLedger there is work.
  it("reads a v1 ledger's group-name keys unchanged, and says it is v1", () => {
    const raw = JSON.stringify({ version: 1, groups: { "plugin-a": ENTRY, bad: { store: 5 } } });
    expect(parseLedger(raw)).toEqual({ version: 1, items: { "plugin-a": ENTRY } });
  });
});

describe("rekeyLedger — the baselines move with the lock", () => {
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
  // never deletes, and the prune answers the question it cannot — does this item still EXIST?
  it("baselineRefs is the keep-set: the refs of the groups this device compiles, and only those", () => {
    const groups: SyncGroup[] = [
      { name: "plugin-a", ref: "community/a", path: "{configDir}/plugins/a/data.json", type: "file", devices: "all" },
      { name: "loose", path: "{configDir}/loose.json", type: "file", devices: "all" },
    ];
    expect(baselineRefs(groups)).toEqual(new Set(["community/a"]));
    const base: Ledger = { version: LEDGER_VERSION, items: { "community/a": ENTRY, "legacy/who-knows": ENTRY } };
    expect(Object.keys(pruneLedger(base, baselineRefs(groups)).items)).toEqual(["community/a"]);
  });
});

// THE CONTRACT, pinned. `pruneLedger` deletes what its keep-set omits, so what you build the
// keep-set FROM decides which baselines survive — and a baseline is the only thing that can tell
// "the store moved" from "this device moved" the next time an item is compared.
//
// Callers narrow the compile twice before comparing: once by device class, once by this device's
// opt-out list. Both are REVERSIBLE CHOICES, not statements that an item stopped existing. Building
// the keep-set from that narrowed list — which is what refreshLocalStatus did — deleted the
// baseline of every opted-out and every class-scoped-away item on the next refresh. Opting back in
// then found no baseline, so groupStatus (core/status.ts) fell through to `never-synced`: a row
// that read "capture my newer settings" came back reading "apply the store over me", and an item
// with companions rolled that up into a phantom `Changed on both sides`.
describe("the prune's keep-set — existence, never current participation", () => {
  const compiled: SyncGroup[] = [
    { name: "plugin-a", ref: "community/a", path: "{configDir}/plugins/a/data.json", type: "file", devices: "all" },
    { name: "plugin-optedout", ref: "community/optedout", path: "{configDir}/plugins/o/data.json", type: "file", devices: "all" },
    { name: "plugin-desktoponly", ref: "community/desktoponly", path: "{configDir}/plugins/d/data.json", type: "file", devices: "desktop" },
  ];
  // What a mobile device actually compares: minus the desktop-only group, minus the opted-out one.
  const compared = compiled.filter((g) => g.devices === "all" && g.ref !== "community/optedout");
  const full: Ledger = {
    version: LEDGER_VERSION,
    items: {
      "community/a": ENTRY,
      "community/optedout": ENTRY,
      "community/desktoponly": ENTRY,
      "community/deleted": ENTRY, // nothing compiles this any more — the entry the prune is FOR
    },
  };

  it("keeps the baseline of an item this device opted out of", () => {
    expect(Object.keys(pruneLedger(full, baselineRefs(compiled)).items)).toContain("community/optedout");
  });

  it("keeps the baseline of an item scoped to another device class", () => {
    expect(Object.keys(pruneLedger(full, baselineRefs(compiled)).items)).toContain("community/desktoponly");
  });

  it("still drops an entry nothing compiles — the prune's actual job is untouched", () => {
    expect(Object.keys(pruneLedger(full, baselineRefs(compiled)).items)).not.toContain("community/deleted");
  });

  // The regression, stated as the difference between the two candidate keep-sets. Narrowing by what
  // is being compared right now loses two baselines that the compile-wide set keeps.
  it("loses baselines when built from what is compared instead of what is compiled", () => {
    const byCompiled = Object.keys(pruneLedger(full, baselineRefs(compiled)).items).sort();
    const byCompared = Object.keys(pruneLedger(full, baselineRefs(compared)).items).sort();
    expect(byCompiled).toEqual(["community/a", "community/desktoponly", "community/optedout"]);
    expect(byCompared).toEqual(["community/a"]);
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
