import { describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import ConfigSyncPlugin from "../src/main";
import { deviceOptOutsFor, migrateV2Settings, mergeLegacyAppSliceItems, drainEnabledOnLocal, runsOnFrom, v2ItemRef } from "../src/core/v2Migration";
import { buildItemDefs, compileItems, defsForForeignItems, emptyItemMap, enablementSharing, ItemDef, ItemMap, RegistryEnv } from "../src/core/registry";
import { itemsIn } from "./items";
import { basename } from "../src/core/pathing";
import { validateSyncManifest } from "../src/core/manifest";
import { Ledger, rekeyLedger } from "../src/core/ledger";
import { lockRefFor } from "../src/core/itemKeys";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

// The v2 → v3 migration (spec 2026-08-11-v3-one-vocabulary-design.md §5, §7b, §9). One fixture
// carries every row of §5's table, so a change that breaks one row breaks a named assertion rather
// than a fixture nobody recognises; the awkward cases §9 calls out (a custom group, a discovered
// file, an item with perItem, enabledOn "mobile", a never-here rule) are all in it.

const NEWER_BUILD = { wroteThis: [1, 2] };

function v2Document(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    pkmMode: "auto",
    rootPath: "vault/cs",
    remotes: [{ name: "origin", type: "vault", storePath: "~/store" }],
    ribbonButtons: { sync: true },
    statusInMenu: true,
    runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
    items: {
      // bare ids -> the obsidian section
      app: {
        enabled: true,
        companions: [],
        settingsFile: { mode: "fields", rules: { "*Token*": { scope: "local", encrypted: false } }, perItem: {} },
      },
      appearance: {
        enabled: true,
        companions: [
          { path: "{configDir}/themes", scope: "all", enabled: true },
          { path: "{configDir}/snippets", scope: "desktop", enabled: false },
        ],
        settingsFile: {
          mode: "fields",
          rules: { enabledCssSnippets: { scope: "local", encrypted: false, locked: true } },
          perItem: { enabledCssSnippets: { "my-snippet.css": "desktop", "other.css": "local" } },
        },
      },
      hotkeys: { enabled: false, companions: [] },
      // enabledOn "mobile" (§9's awkward case) AND a memberRules class value that disagrees (§7b)
      "core:graph": { enabled: true, companions: [], enabledOn: "mobile" },
      // enabledOn "local" — drained into this device's own list
      "core:backlink": { enabled: true, companions: [], enabledOn: "local" },
      "community:dataview": {
        enabled: true,
        companions: [],
        settingsFile: {
          customPath: "{configDir}/plugins/dataview/data.json",
          mode: "plain",
          rules: {},
          perItem: {},
          fileRule: { scope: "desktop", encrypted: true },
        },
      },
      // a BRAT plugin: v2 keyed it `community:` and §7b keeps it stored there
      "community:my-beta-plugin": { enabled: true, companions: [], unknownItemField: NEWER_BUILD },
      "community:config-sync": { enabled: true, companions: [] },
    },
    customGroups: [
      { name: "vaultcss", path: "css", type: "dir", devices: "desktop", description: "shared css", unknownGroupField: NEWER_BUILD },
      { name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" },
      { name: "found-file", path: "{configDir}/whatever.json", type: "file", devices: "all", origin: "discovered" },
      {
        name: "arrayish",
        path: "x/y",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [{ pattern: "a", scope: "mobile", encrypted: false }],
        perItem: { k: { e1: "all", e2: "local" } },
      },
    ],
    memberRules: {
      "community:dataview": "desktop",
      "core:graph": "desktop", // disagrees with enabledOn: "mobile" — §7b says the mask wins
      "community:templater": "always-here", // no items entry of its own
      "core:daily-notes": "never-here", // §9's awkward case
      "community:excalidraw": "mobile",
      "community:futurist": "on-tuesdays", // a value neither axis recognises
    },
    localMembers: ["community:my-beta-plugin"],
    bratPluginIndex: { "my-beta-plugin": "owner/my-beta-plugin" },
    deviceOptOuts: { hotkeys: ["dev-1"], appearance: ["dev-2"] },
    somethingFromTheFuture: NEWER_BUILD,
    // stale keys a real v2 document can still carry — swept, never written back (review M6)
    quickCommands: [{ id: "old" }],
    deviceId: "some-other-machine",
  };
}

function migrated(): Record<string, unknown> {
  return migrateV2Settings(v2Document()).document;
}

function items(): ItemMap {
  return migrated().items as ItemMap;
}

describe("migrateV2Settings — §5 identity rows", () => {
  it("splits the prefixed id into a section and a bare id; bare ids are obsidian", () => {
    const map = items();
    expect(Object.keys(map.obsidian).sort()).toEqual(["app", "appearance", "hotkeys"]);
    expect(Object.keys(map.core).sort()).toEqual(["backlink", "daily-notes", "graph"]);
    expect(Object.keys(map.community).sort()).toEqual(["config-sync", "dataview", "excalidraw", "my-beta-plugin", "templater"]);
  });

  it("a beta plugin migrates into items.community, exactly where its v2 key put it (§7b)", () => {
    const map = items();
    expect(map.community["my-beta-plugin"]?.synced).toBe(true);
    expect((map as unknown as Record<string, unknown>).beta).toBeUndefined();
    // the ref producer agrees: a beta id is a community identity, never a `beta/…` one
    expect(v2ItemRef("community:my-beta-plugin")).toBe("community/my-beta-plugin");
  });

  it("localMembers become thisDeviceItems refs, joined by the drained enabledOn:'local' ids", () => {
    const doc = migrated();
    expect(doc.thisDeviceItems).toEqual(["community/my-beta-plugin", "core/backlink"]);
    expect(doc.localMembers).toBeUndefined();
    expect(items().core["backlink"]).toEqual({ synced: true });
  });

  // Fix round 2, review NEW-I2 — the same harm class as reading a v2 store copy as nothing, on the
  // write side. Adopting a store contract still written by a 2.21.0 device applies the STORE's
  // document as the base (schemaVersion 2 and all) while preserving this device's locked-local
  // presets, and `thisDeviceItems` is the only one of the three whose NAME changed. Overwriting it
  // from the store's own `localMembers` — locked, therefore empty — silently emptied this device's
  // device-local list and saved it.
  it("seeds thisDeviceItems from an existing one rather than overwriting it", () => {
    const hybrid = { ...v2Document(), thisDeviceItems: ["community/pinned-here", "core/backlink"] };

    const doc = migrateV2Settings(hybrid).document;

    // this device's own pins survive; localMembers joins them; the id both sides name appears once
    expect(doc.thisDeviceItems).toEqual(["community/pinned-here", "core/backlink", "community/my-beta-plugin"]);
  });

  it("a document with only thisDeviceItems and an empty localMembers keeps every pin", () => {
    const doc = migrateV2Settings({ schemaVersion: 2, items: {}, localMembers: [], thisDeviceItems: ["community/a", "core/b"] }).document;
    expect(doc.thisDeviceItems).toEqual(["community/a", "core/b"]);
  });

  it("bratPluginIndex becomes bratIndex, and the retired top-level fields are gone", () => {
    const doc = migrated();
    expect(doc.bratIndex).toEqual({ "my-beta-plugin": "owner/my-beta-plugin" });
    expect(doc.bratPluginIndex).toBeUndefined();
    expect(doc.memberRules).toBeUndefined();
    expect(doc.customGroups).toBeUndefined();
    expect(doc.deviceOptOuts).toBeUndefined();
    expect(doc.schemaVersion).toBe(3);
  });
});

// Task-4 review finding: every item in v2Document() carries an explicit `enabled`, so the suite
// never proved the OTHER direction — a v2 item that never had the key must not come out the other
// side with a spurious `synced`. itemFrom's rename is `if ("enabled" in item) { … }`; an
// unconditional `item.synced = item.enabled` would silently write `synced: undefined` here, which
// `?.synced === undefined` cannot tell apart from a genuinely absent key — hence the `in` checks.
describe("migrateV2Settings — a v2 item with no `enabled` key gains no `synced` key", () => {
  it("does not manufacture synced (or leave enabled behind) on an item that never had it", () => {
    const doc = migrateV2Settings({
      schemaVersion: 2,
      items: {
        "core:templates": { settingsFile: { mode: "plain", rules: {}, perItem: {} } },
      },
    }).document;
    const item = (doc.items as ItemMap).core["templates"] as unknown as Record<string, unknown>;
    expect("synced" in item).toBe(false);
    expect("enabled" in item).toBe(false);
    // …and the rest of the item still migrated normally — the guard didn't just no-op the whole item.
    expect(item.settingsFile).toEqual({ mode: "plain", rules: {}, perElement: {} });
  });
});

describe("migrateV2Settings — §5 value rows", () => {
  it("a field rule's scope becomes a sharing, keeping encrypted and locked", () => {
    expect(items().obsidian["app"]?.settingsFile?.rules["*Token*"]).toEqual({ sharing: THIS_DEVICE, encrypted: false });
    expect(items().obsidian["appearance"]?.settingsFile?.rules["enabledCssSnippets"]).toEqual({
      sharing: THIS_DEVICE,
      encrypted: false,
      locked: true,
    });
  });

  it("perItem becomes perElement, with the same value mapping (§9's awkward case)", () => {
    const sf = items().obsidian["appearance"]?.settingsFile;
    expect(sf?.perElement).toEqual({ enabledCssSnippets: { "my-snippet.css": perClass("desktop"), "other.css": THIS_DEVICE } });
    expect((sf as unknown as Record<string, unknown>).perItem).toBeUndefined();
  });

  it("fileRule.scope maps the same way, and settingsFile.customPath becomes the item's own path", () => {
    const item = items().community["dataview"];
    expect(item?.path).toBe("{configDir}/plugins/dataview/data.json");
    expect(item?.settingsFile?.fileRule).toEqual({ sharing: perClass("desktop"), encrypted: true });
    expect((item?.settingsFile as unknown as Record<string, unknown>).customPath).toBeUndefined();
  });

  it("companions[].scope becomes companions[].device; an empty list is dropped, a real one kept", () => {
    expect(items().obsidian["appearance"]?.companions).toEqual([
      { path: "{configDir}/themes", device: "all", enabled: true },
      { path: "{configDir}/snippets", device: "desktop", enabled: false },
    ]);
    expect(items().obsidian["hotkeys"]).toEqual({ synced: false });
  });
});

// §7b's ruling, which is the one place the migration has to choose between two v2 fields.
describe("migrateV2Settings — runsOn preserves what the system DID, not what the menu SAID (§7b)", () => {
  it("enabledOn wins over a disagreeing memberRules class value", () => {
    expect(items().core["graph"]?.runsOn).toEqual({ device: "mobile" });
  });

  it("memberRules' class value is used when there is no enabledOn", () => {
    expect(items().community["dataview"]?.runsOn).toEqual({ device: "desktop" });
  });

  it("always-here / never-here become the force axis, fleet-wide (C-#46 out of scope, §8)", () => {
    expect(items().community["templater"]?.runsOn).toEqual({ device: "all", force: { state: "on", where: "everywhere" } });
    expect(items().core["daily-notes"]?.runsOn).toEqual({ device: "all", force: { state: "off", where: "everywhere" } });
  });

  it("a memberRule with no items entry of its own still lands — v2 read that side table independently", () => {
    // …on an item that is off, which is what the absent entry already meant.
    expect(items().community["templater"]?.synced).toBe(false);
    expect(items().community["excalidraw"]).toEqual({ synced: false, runsOn: { device: "mobile" } });
  });

  // Deliberate drop, not parity: v2 ignored an unrecognised value at the point of use and left it
  // on disk (invariant II.2), but `memberRules` itself retires and v3 has nowhere to keep it.
  it("a value neither axis recognises is dropped — it did nothing in v2 either", () => {
    expect(items().community["futurist"]).toBeUndefined();
  });

  // Review M3: the merge deletes the three slice ids from the working map before the orphan pass
  // runs, so "did this id have an item?" has to be answered from a snapshot taken before it — or a
  // stray rule for a retired slice id resurrects a junk entry that is inert but written forever.
  it("does not resurrect an item for a retired app-slice id the merge just removed", () => {
    const doc = migrateV2Settings({
      schemaVersion: 2,
      items: { editor: { enabled: true, settingsFile: { mode: "fields", rules: {}, perItem: {} } } },
      memberRules: { editor: "always-here" },
    }).document;
    expect(Object.keys((doc.items as ItemMap).obsidian)).toEqual(["app"]);
  });

  // v3's ItemSettingsFile requires both maps and deriveMode reads their key counts unguarded.
  it("a settingsFile that never had rules/perItem still comes out with both maps", () => {
    const doc = migrateV2Settings({ schemaVersion: 2, items: { hotkeys: { enabled: true, settingsFile: { mode: "plain" } } } }).document;
    expect((doc.items as ItemMap).obsidian["hotkeys"]?.settingsFile).toEqual({ mode: "plain", rules: {}, perElement: {} });
  });

  it("a rule that says nothing at all leaves no runsOn key behind", () => {
    expect(runsOnFrom(undefined, undefined)).toBeUndefined();
    expect(runsOnFrom("all", "all")).toBeUndefined();
    expect(items().community["config-sync"]).toEqual({ synced: true });
  });
});

describe("migrateV2Settings — customGroups become items.custom (§5)", () => {
  it("type dir becomes folder, devices becomes runsOn.device, description survives", () => {
    expect(items().custom["vaultcss"]).toMatchObject({
      synced: true,
      type: "folder",
      path: "css",
      runsOn: { device: "desktop" },
      description: "shared css",
    });
  });

  it("a discovered file keeps its origin", () => {
    expect(items().custom["found-file"]).toMatchObject({ synced: true, type: "file", origin: "discovered" });
  });

  it("field rules and perItem inside a custom rule get the same value mapping", () => {
    expect(items().custom["arrayish"]?.settingsFile).toEqual({
      mode: "fields",
      rules: { a: { sharing: perClass("mobile"), encrypted: false } },
      perElement: { k: { e1: EVERYWHERE, e2: THIS_DEVICE } },
    });
  });

  // A custom rule is the only item that CHOOSES its mode (the Advanced tab's Mode dropdown offers
  // Plain/Fields/Encrypt on every one of them). Losing "encrypted" here would silently write the
  // file to the store in plaintext at the next capture — a data change, not a shape change.
  it("keeps mode:'encrypted' — and it still compiles to an encrypted group", () => {
    expect(items().custom["secrets"]?.settingsFile?.mode).toBe("encrypted");
    const group = compileItems(buildItemDefs(ENV), { items: items() }).find((g) => g.name === "secrets");
    expect(group?.mode).toBe("encrypted");
  });

  // spec §9: the 2.21.0 carry invariant binds the migration path too.
  it("carries a v2 customGroups entry's unknown fields through", () => {
    expect(items().custom["vaultcss"]).toMatchObject({ unknownGroupField: NEWER_BUILD });
  });
});

describe("migrateV2Settings — the carry invariant everywhere else", () => {
  it("keeps unknown top-level keys and unknown item fields", () => {
    expect(migrated().somethingFromTheFuture).toEqual(NEWER_BUILD);
    expect(items().community["my-beta-plugin"]).toMatchObject({ unknownItemField: NEWER_BUILD });
  });

  it("keeps every preference field it does not rename", () => {
    const doc = migrated();
    expect(doc.rootPath).toBe("vault/cs");
    expect(doc.remotes).toEqual([{ name: "origin", type: "vault", storePath: "~/store" }]);
    expect(doc.ribbonButtons).toEqual({ sync: true });
    expect(doc.runHistory).toEqual({ enabled: true, path: "", maxCount: 50, maxDays: 30 });
  });

  // The fixture MUST reach the app-slice merge (all three slices plus an appearance card carrying
  // the borrowed showInlineTitle rule): that pass deletes TWO levels down, and the first version of
  // this test used the §5 fixture, which has no slices — so the merge returned at its early guard
  // and the test proved nothing while the migration really was editing the caller's document
  // (fix round 1, review I2).
  it("never mutates the document it was handed — including through the app-slice merge", () => {
    const source: Record<string, unknown> = {
      schemaVersion: 2,
      appJson: { mode: "fields" },
      items: {
        editor: { enabled: true, settingsFile: { mode: "fields", rules: { spellcheck: { scope: "local", encrypted: false } }, perItem: {} } },
        "files-links": { enabled: false, settingsFile: { mode: "fields", rules: {}, perItem: { k: { e: "all" } } } },
        other: { enabled: false, settingsFile: { mode: "fields", rules: {}, perItem: {} } },
        appearance: {
          enabled: true,
          settingsFile: {
            mode: "fields",
            rules: { showInlineTitle: { scope: "local", encrypted: false }, cssTheme: { scope: "all", encrypted: false } },
            perItem: { showInlineTitle: { x: "all" } },
          },
        },
        "community:x": { enabled: true, companions: [{ path: "a/b", scope: "all", enabled: true }] },
      },
      customGroups: [{ name: "r", path: "p", type: "dir", devices: "all", carried: { deep: [1] } }],
      memberRules: { "community:x": "always-here" },
      localMembers: [],
    };
    const snapshot = JSON.stringify(source);

    const out = migrateV2Settings(source);

    expect(JSON.stringify(source)).toBe(snapshot);
    // …and the borrowed rule really did move, i.e. the merge path was exercised, not skipped.
    expect((out.document.items as ItemMap).obsidian["app"]?.settingsFile?.rules["showInlineTitle"]).toBeDefined();
  });

  // The other half of the same property, and stated to its real extent (review, round 2): the
  // structures the migration REWRITES — the item map and each custom entry — are deep-copied, so a
  // caller editing a carried value inside them cannot change a migrated document. The top level is
  // a shallow spread, so a value that is only renamed or carried (`remotes`, `bratIndex`,
  // `runHistory`) is still the caller's own object; nothing writes through those.
  it("shares no structure with the input INSIDE the item map (the top level is shallow, by design)", () => {
    const carried = { deep: [1, 2] };
    const source: Record<string, unknown> = {
      schemaVersion: 2,
      items: { "community:x": { enabled: true, fromTheFuture: carried } },
      customGroups: [{ name: "r", path: "p", type: "dir", devices: "all", alsoFromTheFuture: carried }],
    };
    const out = migrateV2Settings(source).document;
    const item = (out.items as ItemMap).community["x"] as unknown as { fromTheFuture: unknown };
    const custom = (out.items as ItemMap).custom["r"] as unknown as { alsoFromTheFuture: unknown };
    expect(item.fromTheFuture).toEqual(carried);
    expect(item.fromTheFuture).not.toBe(carried);
    expect(custom.alsoFromTheFuture).not.toBe(carried);
    // …and the honest limit of the claim, pinned so it reads as a decision:
    const shallow = { schemaVersion: 2, items: {}, bratPluginIndex: carried };
    expect(migrateV2Settings(shallow).document.bratIndex).toBe(carried);
  });

  it("hands the carried deviceOptOuts map back instead of dropping it on the floor", () => {
    expect(migrateV2Settings(v2Document()).carriedDeviceOptOuts).toEqual({ hotkeys: ["dev-1"], appearance: ["dev-2"] });
  });
});

describe("migrateV2Settings — runs once, and only on a v2 document", () => {
  it("is idempotent: a second run over its own output changes nothing", () => {
    const once = migrated();
    const twice = migrateV2Settings(once).document;
    expect(twice).toEqual(once);
  });

  it("a v3 document passes through untouched — identity, not a rewrite", () => {
    const v3 = { schemaVersion: 3, items: emptyItemMap(), remotes: [], bratIndex: {}, thisDeviceItems: ["community/x"] };
    const out = migrateV2Settings(v3);
    expect(out.document).toBe(v3);
    expect(out.carriedDeviceOptOuts).toBeUndefined();
  });

  it("a v1 / unversioned document is not touched either — it takes the legacy branch instead", () => {
    const v1 = { groups: [], memberScopes: {} };
    expect(migrateV2Settings(v1).document).toBe(v1);
  });
});

// ── The two restored v2 normalizers (spec §9: the release's only real coverage loss) ────────────

describe("mergeLegacyAppSliceItems", () => {
  it("merges the three slices into one app item, first-seen-wins in encounter order", () => {
    const items: Record<string, unknown> = {
      editor: { enabled: false, settingsFile: { mode: "fields", rules: { shared: { scope: "all", encrypted: false } }, perItem: {} } },
      "files-links": { enabled: true, settingsFile: { mode: "fields", rules: { shared: { scope: "local", encrypted: false }, own: { scope: "all", encrypted: false } }, perItem: { k: { e: "all" } } } },
      other: { enabled: false, settingsFile: { mode: "fields", rules: { shared: { scope: "mobile", encrypted: false } }, perItem: { k: { e: "local" } } } },
    };
    expect(mergeLegacyAppSliceItems(items, undefined)).toBe(true);
    expect(items.editor).toBeUndefined();
    expect(items["files-links"]).toBeUndefined();
    expect(items.other).toBeUndefined();
    expect(items.app).toEqual({
      enabled: true, // any slice enabled enables the merged card
      settingsFile: {
        mode: "fields",
        rules: { shared: { scope: "all", encrypted: false }, own: { scope: "all", encrypted: false } }, // editor's `shared` won
        perItem: { k: { e: "all" } }, // files-links' `k` won
      },
    });
  });

  it("appearance surrenders its borrowed showInlineTitle rule to the app card", () => {
    const items: Record<string, unknown> = {
      editor: { enabled: true, settingsFile: { mode: "fields", rules: {}, perItem: {} } },
      appearance: {
        enabled: true,
        settingsFile: { mode: "fields", rules: { showInlineTitle: { scope: "local", encrypted: false }, cssTheme: { scope: "all", encrypted: false } }, perItem: { showInlineTitle: {} } },
      },
    };
    mergeLegacyAppSliceItems(items, undefined);
    expect((items.app as { settingsFile: { rules: Record<string, unknown> } }).settingsFile.rules).toEqual({
      showInlineTitle: { scope: "local", encrypted: false },
    });
    const appearanceSf = (items.appearance as { settingsFile: { rules: Record<string, unknown>; perItem: Record<string, unknown> } }).settingsFile;
    expect(appearanceSf.rules).toEqual({ cssTheme: { scope: "all", encrypted: false } });
    expect(appearanceSf.perItem).toEqual({});
  });

  it("a top-level appJson mode alone still produces the merged card; nothing at all is a no-op", () => {
    const withAppJson: Record<string, unknown> = {};
    expect(mergeLegacyAppSliceItems(withAppJson, { mode: "plain" })).toBe(true);
    expect(withAppJson.app).toEqual({ enabled: false, settingsFile: { mode: "plain", rules: {}, perItem: {} } });

    const untouched: Record<string, unknown> = { hotkeys: { enabled: true } };
    expect(mergeLegacyAppSliceItems(untouched, undefined)).toBe(false);
    expect(untouched).toEqual({ hotkeys: { enabled: true } });
  });

  // Review M1: v2 was `appJson?.mode ?? "fields"` and carried whatever was stored, letting the
  // compile path decide. Coercing an unrecognised value to "fields" would make a mode this build
  // does not know start behaving like one it does — in the one function whose job is to be v2.
  it("carries an appJson mode this build does not recognise, rather than coercing it", () => {
    const items: Record<string, unknown> = {};
    mergeLegacyAppSliceItems(items, { mode: "some-future-mode" });
    expect((items.app as { settingsFile: { mode: unknown } }).settingsFile.mode).toBe("some-future-mode");
  });

  // The whole point of restoring it: a document written by a pre-merge v2 build still lands right.
  it("runs inside the migration, so a pre-merge v2 document ends up with one obsidian/app item", () => {
    const doc = migrateV2Settings({
      schemaVersion: 2,
      appJson: { mode: "fields" },
      items: { editor: { enabled: true, settingsFile: { mode: "fields", rules: { spellcheck: { scope: "local", encrypted: false } }, perItem: {} } } },
    }).document;
    const map = doc.items as ItemMap;
    expect(Object.keys(map.obsidian)).toEqual(["app"]);
    expect(map.obsidian["app"]).toEqual({
      synced: true,
      settingsFile: { mode: "fields", rules: { spellcheck: { sharing: THIS_DEVICE, encrypted: false } }, perElement: {} },
    });
    expect(doc.appJson).toBeUndefined();
  });
});

// Restored with the function (review M2): its unit cases went out with the `withDeviceOptOut` block
// in schemaGate.test.ts, leaving only two indirect loadSettings assertions. The read half still
// meets real documents — that is the whole reason it survived the field's retirement.
describe("deviceOptOutsFor", () => {
  it("reads only the groups whose array names this device", () => {
    expect(deviceOptOutsFor({ hotkeys: ["d1", "d2"], appearance: ["d2"], themes: [] }, "d1")).toEqual(["hotkeys"]);
  });

  it("anything that isn't the old shape reads as nothing", () => {
    expect(deviceOptOutsFor(undefined, "d1")).toEqual([]);
    expect(deviceOptOutsFor(null, "d1")).toEqual([]);
    expect(deviceOptOutsFor(["hotkeys"], "d1")).toEqual([]);
    expect(deviceOptOutsFor({ hotkeys: "d1" }, "d1")).toEqual([]);
  });
});

describe("drainEnabledOnLocal", () => {
  it("moves every enabledOn:'local' id into this device's list and deletes the dead key", () => {
    const items: Record<string, unknown> = {
      "core:graph": { enabled: true, enabledOn: "local" },
      "community:dataview": { enabled: true, enabledOn: "desktop" },
      appearance: { enabled: true },
    };
    const ids: string[] = ["community:already"];
    expect(drainEnabledOnLocal(items, ids)).toBe(true);
    expect(ids).toEqual(["community:already", "core:graph"]);
    expect(items["core:graph"]).toEqual({ enabled: true });
    expect(items["community:dataview"]).toEqual({ enabled: true, enabledOn: "desktop" });
  });

  it("adds nothing twice and reports no change when there is nothing to drain", () => {
    const items: Record<string, unknown> = { "core:graph": { enabled: true, enabledOn: "local" } };
    const ids: string[] = ["core:graph"];
    expect(drainEnabledOnLocal(items, ids)).toBe(true);
    expect(ids).toEqual(["core:graph"]);
    expect(drainEnabledOnLocal({ appearance: { enabled: true } }, ids)).toBe(false);
  });
});

// ── §4 / §9's headline gate: the baselines ─────────────────────────────────────────────────────

const ENV: RegistryEnv = {
  cores: [
    { id: "graph", name: "Graph view", fileExists: true },
    { id: "backlink", name: "Backlinks", fileExists: true },
    { id: "daily-notes", name: "Daily notes", fileExists: true },
  ],
  plugins: [
    { id: "dataview", name: "Dataview" },
    { id: "templater", name: "Templater" },
    { id: "my-beta-plugin", name: "My Beta Plugin" },
    { id: "config-sync", name: "Config Sync" },
  ],
  betaIds: new Set(["my-beta-plugin"]),
};

// v2's group-name producer, restored verbatim from registry.ts@2.21.0. It is the OTHER side of
// every producer-vs-producer assertion below: asserting the new names against literals typed here
// would pass just as happily if both sides moved together, which is exactly how a re-keying breaks
// silently (task-1 review NEW-I2).
function legacyGroupName(v2Id: string): string {
  if (v2Id.startsWith("core:")) return v2Id.slice("core:".length);
  if (v2Id.startsWith("community:")) return `plugin-${v2Id.slice("community:".length)}`;
  return v2Id;
}

function v2IdOf(def: ItemDef): string {
  if (def.section === "core") return `core:${def.id}`;
  return def.section === "community" || def.section === "beta" ? `community:${def.id}` : def.id;
}

// The baseline/lock key space AS V2 SAW IT, read off the v2 document alone: every item's group
// name, every companion's basename, every custom rule's name, plus the two enablement carriers.
function v2GroupNames(doc: Record<string, unknown>): Set<string> {
  const names = new Set<string>(["core-plugins", "community-plugins"]);
  for (const [v2Id, cfg] of Object.entries(doc.items as Record<string, { companions?: { path: string }[] }>)) {
    names.add(legacyGroupName(v2Id));
    for (const c of cfg.companions ?? []) names.add(basename(c.path));
  }
  for (const g of doc.customGroups as { name: string }[]) names.add(g.name);
  return names;
}

// status.ts's own rule for the state this gate exists to prevent: no baseline → never-synced,
// whose default direction is APPLY. Stated once, applied to both sides.
function neverSynced(keys: string[], ledger: Ledger): string[] {
  return keys.filter((key) => ledger.items[key] === undefined);
}

// Review I1. Keeping the user's orphan rule is right; letting it grow a CARD is not. Synthesis is
// what decides that — SettingTab.renderRegistryCards renders one card per def — so the pin belongs
// on defsForForeignItems and on the member-decision projection it feeds, driven by real migrated
// settings rather than a hand-built item map.
describe("a materialised orphan rule stays invisible until its plugin is installed (review I1)", () => {
  const migratedItems = (): ItemMap => migrateV2Settings(v2Document()).document.items as ItemMap;

  it("grows no card: no def is synthesized for an item that is off and merely carries a rule", () => {
    const defs = defsForForeignItems(buildItemDefs(ENV), migratedItems(), new Set());
    const synthesized = defs.filter((d) => !buildItemDefs(ENV).some((b) => b.id === d.id && b.section === d.section));
    // excalidraw (class rule) and daily-notes/templater (force rules) are all materialised orphans;
    // only templater has an installed def in ENV, and it gets that def from buildItemDefs, not here.
    expect(synthesized.map((d) => d.id)).toEqual([]);
    expect(defs.some((d) => d.id === "excalidraw")).toBe(false);
  });

  // PINNED, not removed — the masking half of I1 is the accepted half. `elementSharings`' second
  // pass walks stored items directly (not defs), so a materialised orphan for a plugin that is not
  // installed here becomes a this-device element, which v2 did not have. Kept for two reasons: §7b
  // blesses a Runs-on choice masking ("one field means one thing"), and it is the SAFER reading —
  // v2 forced such an id off locally without excepting it, so the next capture from this device
  // deleted it from the shared list for everyone. Asserted here so it is a decision on the record
  // and not something a rehearsal discovers.
  it("…does gain a this-device member decision, which is the accepted delta", () => {
    const sharing = enablementSharing(buildItemDefs(ENV), { items: migratedItems() }, "community-plugins");
    expect(sharing["excalidraw"]).toEqual(THIS_DEVICE);
  });

  // The rule itself is still there, and still forces the switch — that is the whole reason the
  // migration materialises it. It is stored, invisible, and waiting for the plugin to arrive.
  it("but the rule is kept, and an installed plugin's card shows it", () => {
    expect(migratedItems().community["excalidraw"]?.runsOn).toEqual({ device: "mobile" });
    const withPlugin: RegistryEnv = { ...ENV, plugins: [...ENV.plugins, { id: "excalidraw", name: "Excalidraw" }] };
    expect(buildItemDefs(withPlugin).some((d) => d.id === "excalidraw")).toBe(true);
  });

  // The narrowing must not touch what synthesis exists FOR: an enabled item whose plugin is not
  // installed here still gets its def, or its pulled files read as deletable leftover.
  it("an enabled item with no installed def still gets one", () => {
    const items = itemsIn({ community: { pendingInstall: { synced: true } } });
    expect(defsForForeignItems(buildItemDefs(ENV), items, new Set()).some((d) => d.id === "pendingInstall")).toBe(true);
  });

  it("so does a disabled item that carries configuration of its own", () => {
    const items = itemsIn({ community: { configured: { synced: false, companions: [{ path: "a/b", device: "all", enabled: true }] } } });
    expect(defsForForeignItems(buildItemDefs(ENV), items, new Set()).some((d) => d.id === "configured")).toBe(true);
  });
});

// The end-to-end shape gate: whatever the migration produced has to survive the same validator
// recompile() runs on every load, or the user's whole sync list would come back empty behind a
// Notice. Asserted on the full §5 fixture, not a minimal one.
//
// task 5 / task 9 boundary: the two on/off lists are items now, and migrateV2Settings does not yet
// seed items.obsidian["core-plugins"/"community-plugins"].synced for a v2 document — that backfill
// is task 9's (registry.ts's retired ENABLEMENT_LISTS compile-loop said so explicitly). Until it
// lands, a migrated v2 document's carriers compile to nothing, same as any other v2 read on this
// branch; "core-plugins"/"community-plugins" are gone from the expected list below for that reason,
// not because the migration dropped the plugins they carry (backlink/graph/dataview/etc. are all
// still here).
describe("the migrated document compiles into a manifest the engine accepts", () => {
  it("compiles and validates, with the same items the v2 document described", () => {
    const groups = compileItems(buildItemDefs(ENV), { items: migrateV2Settings(v2Document()).document.items as ItemMap });
    expect(() => validateSyncManifest({ version: 1, groups })).not.toThrow();
    expect(groups.map((g) => g.name).sort()).toEqual(
      [
        "app",
        "appearance",
        "themes", // appearance's enabled companion; the disabled one stays out, as in v2
        "graph",
        "backlink",
        "plugin-dataview",
        "plugin-my-beta-plugin",
        "plugin-config-sync",
        "vaultcss",
        "secrets",
        "found-file",
        "arrayish",
      ].sort()
    );
  });
});

describe("the baseline ledger survives the migration (§4, §9's headline gate)", () => {
  it("v2's group-name producer and v3's agree for every item — the key space did not move", () => {
    for (const def of buildItemDefs(ENV)) {
      expect(def.groupName).toBe(legacyGroupName(v2IdOf(def)));
    }
  });

  // §9's headline gate, end to end across BOTH halves of the migration: the document moves to v3
  // (task 2) and the baselines move with the lock to item refs (task 3, spec §4). What must not
  // change is which items have a baseline at all — a missing one reads as never-synced, whose
  // default direction is APPLY, so a half-moved key space would offer to overwrite this device's
  // live config for every item at once.
  it("no item reads as never-synced after the migration and the re-key: the count is unchanged, and it is zero", () => {
    const doc = v2Document();
    // A device that had everything in sync: one baseline per group name v2 knew.
    const ledger: Ledger = { version: 1, items: {} };
    for (const name of v2GroupNames(doc)) ledger.items[name] = { store: "s", local: "l", at: "2026-08-11T00:00:00.000Z" };

    const before = neverSynced([...v2GroupNames(doc)], ledger);
    const compiled = compileItems(buildItemDefs(ENV), { items: migrateV2Settings(doc).document.items as ItemMap });
    const moved = rekeyLedger(ledger, lockRefFor(compiled));
    const after = neverSynced(compiled.flatMap((g) => (g.ref === undefined ? [] : [g.ref])), moved);

    expect(before).toEqual([]);
    expect(after).toEqual([]);
    expect(after.length).toBe(before.length);
    expect(compiled.length).toBeGreaterThan(0); // the assertion above is not vacuous
    expect(compiled.every((g) => g.ref !== undefined)).toBe(true); // …and every group really had a key to move to
  });
});

// ── The real load path ─────────────────────────────────────────────────────────────────────────

const NoticeSpy = Notice as unknown as { lastMessage: string | undefined };

function fakeApp(store: Record<string, string | null>): unknown {
  return {
    vault: { adapter: { exists: async () => false }, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: { manifests: {}, enabledPlugins: new Set<string>(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
    loadLocalStorage: (k: string) => store[k] ?? null,
    saveLocalStorage: (k: string, v: string | null) => {
      store[k] = v;
    },
  };
}

interface LoadSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  settings: { schemaVersion: number; items: ItemMap; thisDeviceItems: string[]; bratIndex: Record<string, string> };
}

describe("ConfigSyncPlugin.loadSettings — a v2 document migrates, saves once, and says nothing", () => {
  it("migrates in memory, writes the v3 document exactly once, and raises no reset notice", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as LoadSurface;
    instance.app = fakeApp({ "config-sync-device-id": "dev-1" });
    instance.loadData = async () => v2Document();
    const saved: unknown[] = [];
    instance.saveData = async (d) => {
      saved.push(JSON.parse(JSON.stringify(d)));
    };
    NoticeSpy.lastMessage = undefined;

    await instance.loadSettings();

    expect(instance.settings.schemaVersion).toBe(3);
    expect(instance.settings.items.community["dataview"]?.runsOn).toEqual({ device: "desktop" });
    expect(instance.settings.thisDeviceItems).toEqual(["community/my-beta-plugin", "core/backlink"]);
    expect(instance.settings.bratIndex).toEqual({ "my-beta-plugin": "owner/my-beta-plugin" });
    expect(saved.length).toBe(1);
    const written = saved[0] as Record<string, unknown>;
    expect(written.schemaVersion).toBe(3);
    // what the migration carried must reach DISK, not just memory
    expect(written.somethingFromTheFuture).toEqual(NEWER_BUILD);
    expect(written.memberRules).toBeUndefined();
    expect(written.deviceOptOuts).toBeUndefined();
    // Review M6: the stale-key sweep runs AHEAD of the migrate branch, so the one save the
    // migration makes does not put a stray `deviceId` — a prior review's CRITICAL identity leak —
    // back on disk for a cycle.
    expect(written.deviceId).toBeUndefined();
    expect(written.quickCommands).toBeUndefined();
    // Nothing was reset, so nothing is announced — the legacy branch's notice must not fire here.
    expect(NoticeSpy.lastMessage).toBeUndefined();
  });

  // §5 retires the carried map. It is absorbed on the way out, or a device that never ran 2.21.0
  // silently resumes syncing what it deliberately opted out of.
  it("absorbs THIS device's carried opt-outs into localStorage before the field disappears", async () => {
    const store: Record<string, string | null> = { "config-sync-device-id": "dev-1" };
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as LoadSurface;
    instance.app = fakeApp(store);
    instance.loadData = async () => v2Document();
    instance.saveData = async () => undefined;

    await instance.loadSettings();

    // dev-1 opted out of "hotkeys"; dev-2's entry is none of this device's business.
    expect(JSON.parse(store["config-sync-device-optouts"] ?? "[]")).toEqual(["hotkeys"]);
  });

  it("leaves an existing opt-out list alone when the document adds nothing to it", async () => {
    const store: Record<string, string | null> = { "config-sync-device-id": "dev-3", "config-sync-device-optouts": '["appearance"]' };
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as LoadSurface;
    instance.app = fakeApp(store);
    instance.loadData = async () => v2Document();
    instance.saveData = async () => undefined;

    await instance.loadSettings();

    expect(JSON.parse(store["config-sync-device-optouts"] ?? "[]")).toEqual(["appearance"]);
  });
});
