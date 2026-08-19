import { describe, expect, it } from "vitest";
import { migrateV4Settings } from "../src/core/v4Migration";
import { migrateV2Settings } from "../src/core/v2Migration";
import { perElementKeyFor } from "../src/core/switchList";
import { perClass, THIS_DEVICE } from "../src/core/types";

// The v3 → v4 migration (spec 2026-08-12-enablement-two-layers-design.md). Every rule of's
// table, plus the one behaviour does not have a row for: v3's STRUCTURAL this-device, the mask
// an unsynced card implied in v3 (see v4Migration.ts's header).
//
// The reserved perElement key always comes from its ONE producer (switchList.ts's perElementKeyFor),
// never a "" literal: a derived key with two authors is exactly the drift this pins against.
const COMMUNITY_KEY = perElementKeyFor("community-plugins");
const CORE_KEY = perElementKeyFor("core-plugins");

type Doc = Record<string, unknown>;

function sectionOf(document: Doc, section: string): Record<string, Doc> {
  return (document.items as Record<string, Record<string, Doc> | undefined>)[section] ?? {};
}

function carrierRules(document: Doc, list: "core-plugins" | "community-plugins"): Doc {
  const sf = sectionOf(document, "obsidian")[list]?.settingsFile as Doc | undefined;
  return ((sf?.perElement as Doc | undefined)?.[perElementKeyFor(list)] as Doc | undefined) ?? {};
}

describe("v3 → v4", () => {
  it("renames enabled to synced and leaves the value alone", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { enabled: true } } } });
    expect(document.items).toMatchObject({ community: { dataview: { synced: true } } });
    expect(JSON.stringify(document)).not.toContain('"enabled"');
    expect(document.schemaVersion).toBe(4);
  });

  it("leaves an already-renamed synced alone — the v2 chain hands one in", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { synced: true } } } });
    expect(document.items).toMatchObject({ community: { dataview: { synced: true } } });
  });

  it("an item with neither enabled nor synced gains an explicit synced: false — the written document satisfies its own schema", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { bratRepo: "a/b" } } } });
    expect(document.items).toMatchObject({ community: { dataview: { synced: false, bratRepo: "a/b" } } });
  });

  it("a device rule moves onto the carrier, under the reserved key", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { "obsidian-git": { enabled: true, runsOn: { device: "desktop" } } } } });
    expect(document.items).toMatchObject({
      obsidian: { "community-plugins": { settingsFile: { perElement: { [COMMUNITY_KEY]: { "obsidian-git": perClass("desktop") } } } } },
      community: { "obsidian-git": { synced: true } },
    });
    expect(JSON.stringify(document)).not.toContain("runsOn");
  });

  it("device: all writes no rule at all — a stored default is still a default", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { core: { "daily-notes": { enabled: true, runsOn: { device: "all" } } } } });
    expect(carrierRules(document, "core-plugins")).toEqual({});
  });

  it("a force rule is dropped, not migrated — it claimed 'here' and meant 'everywhere'", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { core: { graph: { enabled: true, runsOn: { device: "all", force: { state: "on", where: "everywhere" } } } } },
    });
    expect(JSON.stringify(document)).not.toContain("force");
  });

  it("thisDeviceItems migrates in two halves: the rule fleet-side, the freeze list local-side", () => {
    const { document, freeze } = migrateV4Settings({
      schemaVersion: 3,
      thisDeviceItems: ["community/remotely-save", "core/graph", "custom/whatever"],
      items: { community: { "remotely-save": { enabled: true } }, core: { graph: { enabled: true } } },
    });
    expect(document.items).toMatchObject({
      obsidian: {
        "community-plugins": { settingsFile: { perElement: { [COMMUNITY_KEY]: { "remotely-save": THIS_DEVICE } } } },
        "core-plugins": { settingsFile: { perElement: { [CORE_KEY]: { graph: THIS_DEVICE } } } },
      },
    });
    expect(document.thisDeviceItems).toBeUndefined();
    // A custom item is not an on/off-list element — it has no rule to write and nothing to freeze.
    expect(freeze).toEqual([
      { list: "community-plugins", elementId: "remotely-save" },
      { list: "core-plugins", elementId: "graph" },
    ]);
  });

  it("a pin outranks the item's own device rule, exactly as v3's memberDecisionsFor overlaid it", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      thisDeviceItems: ["community/obsidian-git"],
      items: { community: { "obsidian-git": { enabled: true, runsOn: { device: "desktop" } } } },
    });
    expect(carrierRules(document, "community-plugins")).toEqual({ "obsidian-git": THIS_DEVICE });
  });

  // F1, the carry's table has no row for. v3 read an element's sharing as
  // `item.synced ? deviceSharing(...) : THIS_DEVICE` (registry.ts's retired elementSharings), so an
  // unsynced entry masked its element: it never entered the store and was never resurrected from it.
  // Without this rule the first capture after a v4 load would publish every locally-enabled plugin
  // the user had never chosen to sync.
  it("an unsynced entry keeps its mask as a stored this-device rule (v3's structural this-device)", () => {
    const { document, freeze } = migrateV4Settings({
      schemaVersion: 3,
      items: { community: { "some-plugin": { enabled: false } }, core: { graph: { synced: false } } },
    });
    expect(carrierRules(document, "community-plugins")).toEqual({ "some-plugin": THIS_DEVICE });
    expect(carrierRules(document, "core-plugins")).toEqual({ graph: THIS_DEVICE });
    // …and NOT on the freeze list: v3's structural mask was pass-through (its forcedRunsOn was
    // recomputed from the persisted file every run, which is the same no-op v4's this-device
    // decision is), while a pin's force is what asks to be pinned down.
    expect(freeze).toEqual([]);
  });

  it("an entry with no synced key at all is unsynced — one predicate, `synced === true`, decides", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { husk: { label: "Husk" } } } });
    expect(carrierRules(document, "community-plugins")).toEqual({ husk: THIS_DEVICE });
  });

  // The structural rule is tested BEFORE the device axis, because in v3 an unsynced item's `runsOn`
  // was a label the mask never read (`item.synced ? deviceSharing(...) : THIS_DEVICE`). Writing the
  // class rule instead is the one shape where the migration would move a switch: on the OTHER
  // device class it masks AND forces off, and subtractForceOff deletes an element v3 passed through
  // untouched; on its own class it makes the element start following the shared list.
  it("an unsynced entry stays this-device even when it carries a device rule (what the system DID)", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: {
        community: { "obsidian-git": { enabled: false, runsOn: { device: "mobile" } } },
        core: { graph: { synced: false, runsOn: { device: "desktop" } } },
      },
    });
    expect(carrierRules(document, "community-plugins")).toEqual({ "obsidian-git": THIS_DEVICE });
    expect(carrierRules(document, "core-plugins")).toEqual({ graph: THIS_DEVICE });
  });

  it("…while a SYNCED entry's device rule is migrated — `synced` alone tells the two apart", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { community: { "obsidian-git": { enabled: true, runsOn: { device: "mobile" } } } },
    });
    expect(carrierRules(document, "community-plugins")).toEqual({ "obsidian-git": perClass("mobile") });
  });

  it("each carrier is synced exactly when its section had a synced item (or the field is left alone if already set)", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { enabled: true } }, core: { graph: { enabled: false } } } });
    const obsidian = sectionOf(document, "obsidian");
    expect(obsidian["community-plugins"]?.synced).toBe(true);
    expect(obsidian["core-plugins"]?.synced).toBe(false);
  });

  // A v3 document never wrote a carrier entry — v3's own compile decided a
  // carrier's sync via anyEnabledInList over the section, never by reading
  // `items.obsidian["core-plugins"|"community-plugins"]`. A `synced`/`enabled` value already sitting
  // there in a v3 doc is v2-chip residue (v2's carrier chip wrote an inert bare-key entry that no
  // v3 build ever gave behaviour to), not a value any build chose — so the section predicate
  // IGNORES it, in both directions, rather than "existing value wins".
  it("a v2-chip carrier entry is neutralized when nothing in its section is synced — the predicate wins, not the residue", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { obsidian: { "core-plugins": { enabled: true } }, core: { graph: { enabled: false } } },
    });
    const obsidian = sectionOf(document, "obsidian");
    expect(obsidian["core-plugins"]?.synced).toBe(false);
  });

  it("a v2-chip carrier entry is overridden true when something in its section IS synced — the predicate wins either way", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { obsidian: { "core-plugins": { enabled: true } }, core: { graph: { enabled: true } } },
    });
    const obsidian = sectionOf(document, "obsidian");
    expect(obsidian["core-plugins"]?.synced).toBe(true);
  });

  it("an unknown field already on the carrier entry still rides through untouched — only `synced` is overwritten", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { obsidian: { "community-plugins": { synced: false, futureField: "kept" } }, community: { dataview: { enabled: true } } },
    });
    const obsidian = sectionOf(document, "obsidian");
    expect(obsidian["community-plugins"]).toMatchObject({ synced: true, futureField: "kept" });
  });

  it("bratIndex folds onto the plugins, creating an unsynced skeleton for an id with no entry", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, bratIndex: { "some-beta": "owner/repo" }, items: {} });
    expect(document.items).toMatchObject({ community: { "some-beta": { synced: false, bratRepo: "owner/repo" } } });
    expect(document.bratIndex).toBeUndefined();
    // A skeleton had no entry in v3, so it had no structural mask to preserve either.
    expect(carrierRules(document, "community-plugins")).toEqual({});
  });

  it("bratIndex lands on an existing entry without disturbing it", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      bratIndex: { "some-beta": "owner/repo" },
      items: { community: { "some-beta": { enabled: true, label: "Beta" } } },
    });
    expect(document.items).toMatchObject({ community: { "some-beta": { synced: true, label: "Beta", bratRepo: "owner/repo" } } });
  });

  it("a custom item's device axis lands on its file rule, and never over one that is already there", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: {
        custom: {
          plain: { synced: true, type: "file", path: "notes/a.json", runsOn: { device: "desktop" } },
          claimed: { synced: true, type: "file", path: "notes/b.json", runsOn: { device: "desktop" }, settingsFile: { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("mobile"), encrypted: false } } },
          fields: { synced: true, type: "file", path: "notes/c.json", runsOn: { device: "desktop" }, settingsFile: { mode: "fields", rules: {}, perElement: {} } },
        },
      },
    });
    const custom = sectionOf(document, "custom");
    expect(custom.plain?.settingsFile).toMatchObject({ mode: "plain", fileRule: { sharing: perClass("desktop"), encrypted: false } });
    expect(custom.claimed?.settingsFile).toMatchObject({ fileRule: { sharing: perClass("mobile") } });
    expect(custom.fields?.settingsFile).toMatchObject({ mode: "fields" });
    expect((custom.fields?.settingsFile as Doc)?.fileRule).toBeUndefined();
  });

  it("drops the declared-but-never-written `elements` field", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { enabled: true, elements: { x: true } } } } });
    expect(JSON.stringify(document)).not.toContain("elements");
  });

  it("carries every key it does not recognise, at every level (invariant II.1)", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, futureTopLevel: 1, items: { community: { dataview: { enabled: true, futureItemKey: "x" } } } });
    expect(document.futureTopLevel).toBe(1);
    expect(document.items).toMatchObject({ community: { dataview: { futureItemKey: "x" } } });
  });

  it("carries a section, and an entry, whose shape it cannot read", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { somethingNew: "opaque", community: { weird: 7 } } });
    const items = document.items as Record<string, unknown>;
    expect(items.somethingNew).toBe("opaque");
    expect((items.community as Record<string, unknown>).weird).toBe(7);
  });

  it("never mutates the document it was given", () => {
    const input = { schemaVersion: 3, thisDeviceItems: ["community/x"], bratIndex: { b: "o/r" }, items: { community: { x: { enabled: true, runsOn: { device: "desktop" } } } } };
    const snapshot = JSON.stringify(input);
    migrateV4Settings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns a non-v3 document untouched — the classifier decides when this runs, not this function", () => {
    const doc = { schemaVersion: 4, items: {} };
    expect(migrateV4Settings(doc).document).toEqual(doc);
    expect(migrateV4Settings(doc).document).toBe(doc);
  });

  // The chain the load path runs for a device that skipped 2.22.0 entirely: v2 → v3 → v4
  // in one load. migrateV2Settings emits the v3 shape BY CONTRACT — `runsOn`, `thisDeviceItems` and
  // `bratIndex` included — and this is what takes it the rest of the way.
  it("composes with the v2 migration: a 2.20.0 document lands on v4 in one pass", () => {
    const v2 = {
      schemaVersion: 2,
      items: {
        "community:obsidian-git": { enabled: true },
        "community:remotely-save": { enabled: true },
        "core:graph": { enabled: false },
      },
      memberRules: { "community:obsidian-git": "desktop" },
      localMembers: ["community:remotely-save"],
      bratPluginIndex: { "some-beta": "owner/repo" },
    };
    const { document, freeze } = migrateV4Settings(migrateV2Settings(v2).document);

    expect(document.schemaVersion).toBe(4);
    expect(carrierRules(document, "community-plugins")).toEqual({
      "obsidian-git": perClass("desktop"),
      "remotely-save": THIS_DEVICE,
    });
    expect(carrierRules(document, "core-plugins")).toEqual({ graph: THIS_DEVICE }); // structural: the card was off
    expect(freeze).toEqual([{ list: "community-plugins", elementId: "remotely-save" }]);
    expect(document.items).toMatchObject({ community: { "some-beta": { bratRepo: "owner/repo" } } });
    const saved = JSON.stringify(document);
    for (const dead of ["runsOn", "thisDeviceItems", "bratIndex", "localMembers", "memberRules"]) expect(saved).not.toContain(dead);
  });
});
