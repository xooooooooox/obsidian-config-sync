import { describe, expect, it } from "vitest";
import { buildItemDefs, compileItems, ItemDef } from "../src/core/registry";
import { carrierRef, companionRef, groupRefIndex, isLockRef, lockRefFor, OBSIDIAN_CARD_IDS, refItemId, rekeyRefList } from "../src/core/itemKeys";
import { LEDGER_VERSION, Ledger, rekeyLedger } from "../src/core/ledger";
import { SWITCH_LISTS } from "../src/core/switchList";
import { parseItemRef, SyncGroup } from "../src/core/types";
import { itemsIn } from "./items";

// The one key space (spec §3/§4): the store lock, the device-local baselines and the device-local
// opt-out list are all keyed by the item's ref, and the COMPILER is its only producer.
//
// The load-bearing assertions here are producer-versus-producer — two sites made to agree with each
// other, never with a literal written by hand (the `producer vs producer` block below, plus the
// re-keying gates at the end). Task 1's two regressions both survived tests that compared a key
// against the tester's own copy of it: the copy moved with the code, and the site that had not moved
// stayed silently broken.
//
// Where a literal DOES appear it is pinning something no second producer can state — the exact set of
// names the closed legacy rules cannot place, and the refs those rules produce for a name this device
// does not compile. Those literals are the specification, not a restatement of it.

const ENV = {
  cores: [
    { id: "daily-notes", name: "Daily notes", fileExists: true },
    { id: "templates", name: "Templates", fileExists: true },
  ],
  plugins: [
    { id: "dataview", name: "Dataview" },
    { id: "completr", name: "Completr" },
  ],
  betaIds: new Set(["completr"]),
};

// A settings document that exercises every SHAPE the key space has to hold: registry items in three
// sections, a beta plugin (presented apart, stored under community), two companions on one card, a
// second card's companion with the SAME basename (which the old flat name space could not even
// express), and a custom rule.
function compiled(): { defs: ItemDef[]; groups: SyncGroup[] } {
  const defs = buildItemDefs(ENV);
  const groups = compileItems(defs, {
    items: itemsIn({
      obsidian: {
        app: { enabled: true },
        appearance: { enabled: true, companions: [{ path: "{configDir}/themes", device: "all", enabled: true }] },
        hotkeys: { enabled: true },
      },
      core: { "daily-notes": { enabled: true } },
      community: {
        // The same BASENAME on two different cards — a shape the flat group-name space could not
        // even express (compileCompanions names both groups "logs"), and the reason a companion is
        // keyed under its owner. Asserted below, not merely described.
        dataview: { enabled: true, companions: [{ path: "vault/dataview/logs", device: "all", enabled: true }] },
        completr: { enabled: true, companions: [{ path: "vault/completr/logs", device: "all", enabled: true }] },
      },
      custom: { "my-rule": { enabled: true, type: "file", path: "notes/custom.json" } },
    }),
  });
  return { defs, groups };
}

// The same document with DISTINCT companion basenames. `compiled()` above deliberately holds a shape
// validateSyncManifest rejects (two groups, one name) because that is precisely what the key space
// has to survive and the name space cannot express — but a real device's ledger never held it:
// recompile() would have refused the whole list, and companionNameConflict stops the UI producing it.
// The baseline gate is a claim about a REAL v1 ledger, so it runs over a configuration that could
// really have existed. Keeping the two fixtures apart is the difference between "the keys don't
// collide" and "no item lost its baseline".
function compiledLegal(): SyncGroup[] {
  return compileItems(buildItemDefs(ENV), {
    items: itemsIn({
      obsidian: {
        app: { enabled: true },
        appearance: { enabled: true, companions: [{ path: "{configDir}/themes", device: "all", enabled: true }] },
        hotkeys: { enabled: true },
      },
      core: { "daily-notes": { enabled: true } },
      community: {
        dataview: { enabled: true, companions: [{ path: "vault/dataview/logs", device: "all", enabled: true }] },
        completr: { enabled: true, companions: [{ path: "vault/completr/notes", device: "all", enabled: true }] },
      },
      custom: { "my-rule": { enabled: true, type: "file", path: "notes/custom.json" } },
    }),
  });
}

describe("the key space is total and injective over everything the compiler emits", () => {
  it("every compiled group carries a ref — there is no group without an identity", () => {
    const { groups } = compiled();
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.filter((g) => g.ref === undefined)).toEqual([]);
    expect(groups.every((g) => isLockRef(g.ref))).toBe(true);
  });

  it("no two compiled groups share a ref", () => {
    const { groups } = compiled();
    expect(new Set(groups.map((g) => g.ref)).size).toBe(groups.length);
  });

  // The shape rule the whole design rests on: an item id never contains "/", so two segments is
  // always an item or a carrier and three is always a companion. Asserted against the compiler's
  // own output rather than against a list of names.
  it("a ref has two segments for an item and three for a companion, never more", () => {
    const { groups } = compiled();
    for (const g of groups) {
      const segments = (g.ref ?? "").split("/");
      expect(segments.length === 2 || segments.length === 3).toBe(true);
      expect(segments.every((s) => s !== "")).toBe(true);
    }
  });
});

describe("producer vs producer", () => {
  // THE central agreement, and it has to be between two INDEPENDENT derivations to mean anything:
  // `lockRefFor(groups)` looks its answer up in the compiler's own output, so asking it would be a
  // tautology. `lockRefFor([])` has no index at all — it runs the closed legacy rules a v1/v2 lock
  // read falls back to — and those rules must land on the same string the compiler minted for every
  // name they can place. If the two ever drift, a v1/v2 lock's entries land under keys no compiled
  // group can reach: every baseline unresolvable, everything reading as never-synced, APPLY for the
  // lot. (Verified to bite: change the `plugin-` rule or a section here and this fails.)
  it("the legacy rules land on exactly what compileItems minted, for every name they can place", () => {
    const { groups } = compiled();
    const legacyOnly = lockRefFor([]);
    const placed = groups.filter((g) => !legacyOnly(g.name).startsWith("legacy/"));
    expect(placed.length).toBeGreaterThan(0);
    for (const g of placed) expect(legacyOnly(g.name)).toBe(g.ref);
    // …and what the rules CANNOT place is exactly the two shapes that never had a legacy form of
    // their own: a companion (keyed under its owner) and a custom rule (named by the user).
    const unplaced = groups.filter((g) => legacyOnly(g.name).startsWith("legacy/")).map((g) => g.ref);
    expect(unplaced.sort()).toEqual(["community/completr/logs", "community/dataview/logs", "custom/my-rule", "obsidian/appearance/themes"]);
  });

  // The other half of lockRefFor's contract, and the one the index cannot restate: a name the
  // compiled list does NOT hold still resolves, through the closed legacy rules, and lands in the
  // holding pen only when those cannot place it either.
  it("a name this device does not compile falls through to the legacy rules, then to the holding pen", () => {
    const { groups } = compiled();
    const toRef = lockRefFor(groups);
    expect(toRef("plugin-not-installed-here")).toBe("community/not-installed-here");
    expect(toRef("core-plugins")).toBe(carrierRef("core-plugins"));
    expect(toRef("someone-elses-rule")).toBe("legacy/someone-elses-rule");
  });

  // NOT `index.get(g.name) === g.ref` — the index is BUILT from g.ref, so that would restate its
  // own construction (the tautology this file's central gate was rewritten to avoid). What is worth
  // asserting is what the map cannot show about itself: the name space it is keyed by collapses two
  // of the compiled groups onto one key, so an index of names is LOSSY where the ref space is not.
  it("groupRefIndex is keyed by a name space that is provably narrower than the key space", () => {
    const { groups } = compiled();
    const index = groupRefIndex(groups);
    expect(new Set(groups.map((g) => g.ref)).size).toBe(groups.length);
    expect(index.size).toBeLessThan(groups.length); // the two same-basename companions share a name
    expect(groups.length - index.size).toBe(1);
  });

  // itemKeys.ts names the obsidian card ids because the legacy converter runs where the registry is
  // not available. Two declarations of one fact, made to agree here rather than by hope.
  it("OBSIDIAN_CARD_IDS is exactly what buildItemDefs produces for the obsidian section", () => {
    const fromRegistry = buildItemDefs(ENV)
      .filter((d) => d.section === "obsidian")
      .map((d) => d.id);
    expect([...OBSIDIAN_CARD_IDS].sort()).toEqual([...fromRegistry].sort());
  });

  // Why carriers are keyed under `obsidian`: that section's id space is closed and declared in code,
  // so a carrier key cannot collide with an item. This is the collision-freedom argument itself,
  // checked against both declarations instead of asserted in a comment.
  it("no carrier id collides with an obsidian card id", () => {
    const carriers = Object.keys(SWITCH_LISTS);
    expect(carriers.filter((c) => (OBSIDIAN_CARD_IDS as readonly string[]).includes(c))).toEqual([]);
    for (const c of carriers) expect(carrierRef(c)).toBe(`obsidian/${c}`);
  });
});

describe("companions and carriers are keyed and resolvable", () => {
  it("a companion is keyed under its owner, so two cards really can own the same basename", () => {
    const { groups } = compiled();
    expect(groups.find((g) => g.name === "themes")?.ref).toBe(companionRef("obsidian/appearance", "{configDir}/themes"));
    // Two groups, ONE name, two distinct keys — the whole point of keying a companion under its
    // owner. A beta plugin's companion lands under `community`, never `beta`: a classification is
    // not an identity (spec §7b).
    const logs = groups.filter((g) => g.name === "logs");
    expect(logs).toHaveLength(2);
    expect(logs.map((g) => g.ref).sort()).toEqual(["community/completr/logs", "community/dataview/logs"]);
    expect(new Set(logs.map((g) => g.ref)).size).toBe(2);
  });

  it("a companion's ref is not an ITEM's — refItemId refuses it, so it can never be read as its owner's", () => {
    const { groups } = compiled();
    const themes = groups.find((g) => g.name === "themes");
    expect(refItemId(themes?.ref ?? "")).toBeNull();
    expect(refItemId("community/dataview")).toEqual({ section: "community", id: "dataview" });
  });

  it("a carrier is an item: its ref resolves, and it is the ref the compiler emits for the group", () => {
    const { groups } = compiled();
    const carrier = groups.find((g) => g.name === "community-plugins");
    expect(carrier?.ref).toBe(carrierRef("community-plugins"));
    expect(parseItemRef(carrier?.ref ?? "")).toEqual({ section: "obsidian", id: "community-plugins" });
  });

  it("every compiled ref this build calls its own resolves; only the legacy holding pen does not", () => {
    const { groups } = compiled();
    for (const g of groups) expect(parseItemRef(g.ref ?? "")).not.toBeNull();
    expect(parseItemRef("legacy/who-knows")).toBeNull();
    expect(isLockRef("legacy/who-knows")).toBe(true); // a legal KEY, an unresolvable ITEM — different questions
  });
});

// §9's headline gate. A baseline is what tells this device an item was ever in sync; a missing one
// reads as never-synced, which defaults to APPLY. So the re-key's whole job is that the SAME items
// have baselines afterwards — not that the keys look right.
describe("the baseline re-key leaves the never-synced count unchanged", () => {
  const entry = { store: "s", local: "l", at: "2026-08-11T00:00:00.000Z" };

  it("every group that had a baseline under its group name has one under its ref", () => {
    const groups = compiledLegal();
    // A v1 ledger as this device would really have written it: one entry per compiled group name.
    const before: Ledger = { version: 1, items: Object.fromEntries(groups.map((g) => [g.name, entry])) };
    const neverSyncedBefore = groups.filter((g) => before.items[g.name] === undefined).length;
    expect(neverSyncedBefore).toBe(0);

    const after = rekeyLedger(before, lockRefFor(groups));

    expect(after.version).toBe(LEDGER_VERSION);
    const neverSyncedAfter = groups.filter((g) => after.items[g.ref ?? ""] === undefined).length;
    expect(neverSyncedAfter).toBe(neverSyncedBefore);
    expect(Object.keys(after.items).length).toBe(Object.keys(before.items).length); // nothing dropped either
  });

  it("a PARTIAL ledger keeps exactly the same items never-synced — not fewer, not more", () => {
    const groups = compiledLegal();
    const synced = groups.filter((_, i) => i % 2 === 0);
    const before: Ledger = { version: 1, items: Object.fromEntries(synced.map((g) => [g.name, entry])) };
    const namesNeverSynced = groups.filter((g) => before.items[g.name] === undefined).map((g) => g.ref);

    const after = rekeyLedger(before, lockRefFor(groups));

    expect(groups.filter((g) => after.items[g.ref ?? ""] === undefined).map((g) => g.ref)).toEqual(namesNeverSynced);
  });

  it("the opt-out list moves through the same producer, so a kept opt-out still matches its group", () => {
    const groups = compiledLegal();
    const toRef = lockRefFor(groups);
    const optedOut = groups.slice(0, 3).map((g) => g.name);

    const moved = rekeyRefList(optedOut, toRef);

    expect(moved).toEqual(groups.slice(0, 3).map((g) => g.ref));
    expect(rekeyRefList(moved, toRef)).toEqual(moved); // idempotent by shape — a second load re-keys nothing
  });

  // Final-review I2: the "already moved" test is `isLockRef`, not `parseItemRef`. They answer
  // different questions and `legacy/…` is deliberately a legal KEY that names no resolvable ITEM —
  // so asking the second question made an entry in the holding pen look unmoved, and it grew a
  // segment per load with a localStorage write each time and no prune to ever clear it.
  it("an entry already in the holding pen survives repeated loads unchanged", () => {
    const toRef = lockRefFor(compiledLegal());
    let list = ["legacy/who-knows", "obsidian/hotkeys"];
    for (let load = 0; load < 5; load++) list = rekeyRefList(list, toRef);
    expect(list).toEqual(["legacy/who-knows", "obsidian/hotkeys"]);
  });
});
