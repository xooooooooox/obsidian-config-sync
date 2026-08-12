import { describe, expect, it } from "vitest";
import {
  buildItemDefs,
  CompileError,
  CompileSettings,
  compileItems,
  customItemFromGroup,
  defForRef,
  defRef,
  defsForForeignItems,
  emptyItem,
  emptyItemMap,
  enablementSharing,
  itemEarnsDef,
  groupOwners,
  itemWithDevice,
  Item,
  withRunsOnDevice,
  ItemDef,
  ItemMap,
  itemFor,
  parentCardLabel,
  storageSection,
  withItem,
  RegistryEnv,
  structuralLocalElements,
} from "../src/core/registry";
import { itemsIn } from "./items";
import { leftoverStoreRels } from "../src/core/leftover";
import { SyncGroup, EVERYWHERE, itemRef, parseItemRef, perClass, StorageSection, THIS_DEVICE } from "../src/core/types";
import { ManifestValidationError, validateSyncManifest } from "../src/core/manifest";
import { mergePresetFields, selfPresetRules } from "../src/core/catalog";
import { carrierRef } from "../src/core/itemKeys";
import { withEnablementRule } from "../src/core/enablementRules";

// spec 2026-07-25-unified-card-design.md §1/§3/§5/§6; task-4-brief.md compile rules.

// Fixtures name items the way the document does: section, then bare id.
function settings(partial: Partial<Record<StorageSection, Record<string, Item>>> = {}): CompileSettings {
  return { items: itemsIn(partial) };
}

// A custom section built from the SyncGroup literals the Advanced tab still edits — the same
// conversion that tab persists through (customItemFromGroup).
function customSection(groups: SyncGroup[]): Record<string, Item> {
  return Object.fromEntries(groups.map((g) => [g.name, customItemFromGroup(g)]));
}

function on(overrides: Partial<Item> = {}): Item {
  return { ...emptyItem(), synced: true, ...overrides };
}

function findGroup(groups: SyncGroup[], name: string): SyncGroup | undefined {
  return groups.find((g) => g.name === name);
}

const EMPTY_ENV: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };

describe("buildItemDefs", () => {
  it("always includes the five Obsidian cards — the three settings cards plus the two on/off lists (task 5)", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const obsidianIds = defs.filter((d) => d.section === "obsidian").map((d) => d.id).sort();
    expect(obsidianIds).toEqual(["app", "appearance", "community-plugins", "core-plugins", "hotkeys"]);
  });

  it("core defs cover the full runtime id list, including state-only (no settings file yet)", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [
        { id: "graph", name: "Graph view", fileExists: true },
        { id: "zk-prefixer", name: "Unique note creator", fileExists: false },
      ],
    };
    const defs = buildItemDefs(env);
    const graph = defs.find((d) => d.section === "core" && d.id === "graph");
    const zk = defs.find((d) => d.section === "core" && d.id === "zk-prefixer");
    expect(graph?.section).toBe("core");
    expect(graph?.groupName).toBe("graph");
    expect(graph?.enablement).toEqual({ list: "core-plugins", element: "graph" });
    expect(graph?.settingsFile?.defaultPath).toBe("{configDir}/graph.json");
    expect(zk?.settingsFile?.defaultPath).toBe("{configDir}/zk-prefixer.json"); // ① known core keeps a path even when its file is absent
    expect(graph?.description).toBe("");
    expect(zk?.description).toBe("");
  });

  it("community/beta defs come from the plugins-dir scan, split by the BRAT index", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      plugins: [
        { id: "dataview", name: "Dataview" },
        { id: "slides-rup", name: "SlidesRup" },
      ],
      betaIds: new Set(["slides-rup"]),
    };
    const defs = buildItemDefs(env);
    const dv = defs.find((d) => d.id === "dataview");
    const beta = defs.find((d) => d.id === "slides-rup");
    expect(dv?.section).toBe("community");
    expect(dv?.enablement).toEqual({ list: "community-plugins", element: "dataview" });
    expect(dv?.settingsFile?.defaultPath).toBe("{configDir}/plugins/dataview/data.json");
    expect(dv?.groupName).toBe("plugin-dataview"); // lineage: the group name keeps its v2 form
    expect(dv?.description).toBe("");
    expect(beta?.section).toBe("beta"); // classification only — beta items still STORE under community
    expect(beta?.groupName).toBe("plugin-slides-rup");
  });

  it("sorts core and community defs by display label", () => {
    const defs = buildItemDefs({
      cores: [
        { id: "graph", name: "Graph view", fileExists: true },
        { id: "backlink", name: "Backlinks", fileExists: true },
      ],
      plugins: [
        { id: "b-plug", name: "Zebra" },
        { id: "a-plug", name: "alpha" },
      ],
      betaIds: new Set(),
    });
    const coreLabels = defs.filter((d) => d.section === "core").map((d) => d.label);
    const commLabels = defs.filter((d) => d.section === "community").map((d) => d.label);
    expect(coreLabels).toEqual(["Backlinks", "Graph view"]);
    expect(commLabels).toEqual(["alpha", "Zebra"]);
  });
});

describe("selected-but-uninstalled items compile locally", () => {
  it("a selected community item with no installed plugin still compiles its group", () => {
    const defs = defsForForeignItems(buildItemDefs(EMPTY_ENV), itemsIn({ community: { dataview: on() } }), new Set());
    const groups = compileItems(defs, settings({ community: { dataview: on() } }));
    expect(groups.map((g) => g.name)).toContain("plugin-dataview");
    expect(findGroup(groups, "plugin-dataview")?.path).toBe("{configDir}/plugins/dataview/data.json");
  });

  it("a synthesized def for a BRAT-indexed id is classified beta", () => {
    const defs = defsForForeignItems(buildItemDefs(EMPTY_ENV), itemsIn({ community: { "slides-rup": on() } }), new Set(["slides-rup"]));
    expect(defs.find((d) => d.id === "slides-rup")?.section).toBe("beta");
  });

  it("an installed plugin's def is never duplicated", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const installedDefs = buildItemDefs(env);
    const defs = defsForForeignItems(installedDefs, itemsIn({ community: { dataview: on() } }), new Set());
    expect(defs.filter((d) => d.id === "dataview")).toHaveLength(1);
  });
});

// C1 (fix round 1): `beta` is a PRESENTED classification, never a stored one (spec §7b). A
// `beta/<id>` ref would name an item no reader can find — every mask reader resolves the
// `community` section — so the chip would show a pin the capture/apply mask never saw, and the id
// would change the day BRAT adopted or dropped the plugin. `ItemRef` is built from
// StorageSection, so `itemRef(def.section, …)` does not compile for a def that may be beta;
// `defRef` is the only def → ref conversion and it goes through `storageSection`.
describe("item identity never carries the beta classification (spec §7b)", () => {
  const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "slides-rup", name: "SlidesRup" }], betaIds: new Set(["slides-rup"]) };
  const defs = buildItemDefs(env);
  const beta = defs.find((d) => d.id === "slides-rup") as ItemDef;

  it("a beta def presents as beta but refs and stores as community", () => {
    expect(beta.section).toBe("beta");
    expect(storageSection(beta.section)).toBe("community");
    expect(defRef(beta)).toBe("community/slides-rup");
  });

  it("a beta item is read out of the community section — one key, whichever way BRAT's list moves", () => {
    const s = settings({ community: { "slides-rup": on() } });
    expect(itemFor(s.items, beta).synced).toBe(true);
    // ...and the same item, once BRAT drops it, is the same entry under the same key.
    const asCommunity = buildItemDefs({ ...env, betaIds: new Set() }).find((d) => d.id === "slides-rup") as ItemDef;
    expect(defRef(asCommunity)).toBe(defRef(beta));
    expect(itemFor(s.items, asCommunity)).toEqual(itemFor(s.items, beta));
  });

  it("a beta write lands in community, so groupOwners and the mask agree with the chip", () => {
    const items = withItem(emptyItemMap(), beta.section, beta.id, on());
    expect(Object.keys(items.community)).toEqual(["slides-rup"]);
    expect(groupOwners(defs, items)["plugin-slides-rup"]).toEqual([{ section: "community", id: "slides-rup" }]);
    expect(enablementSharing(defs, { items }, "community-plugins")).toEqual({ "slides-rup": EVERYWHERE });
  });

  it("parseItemRef refuses a beta ref outright — it was never a legal identity", () => {
    expect(parseItemRef("beta/slides-rup")).toBeNull();
    expect(parseItemRef("community/slides-rup")).toEqual({ section: "community", id: "slides-rup" });
  });

  // NEW-I1 (fix round 2): closing the leak by construction protects MINTING, not MATCHING. The
  // type stops `itemRef(def.section, …)`, but nothing stopped `def.section === parsed.section` —
  // presented on the left, stored on the right — from silently never matching for a beta def.
  // defForRef is the one matching bridge, and it must find a beta def by its community ref.
  it("defForRef matches a beta def by its stored ref — the comparison the type could not protect", () => {
    expect(defForRef(defs, "community/slides-rup")).toBe(beta);
    // The naive comparison this replaced, pinned so the regression is legible if it comes back.
    expect(defs.find((d) => (d.section as string) === "community" && d.id === "slides-rup")).toBeUndefined();
  });

  it("defForRef answers undefined for a ref no def claims, rather than guessing", () => {
    expect(defForRef(defs, "community/not-installed")).toBeUndefined();
    expect(defForRef(defs, "custom/my-rule")).toBeUndefined();
  });

  // The loop main.ts's companionParentOf walks: groupOwners hands back a STORED section, and the
  // def it names presents the other one. It is latent today (only the obsidian `appearance` def
  // has preset companions, so the beta case is unreachable) — which is exactly why it needs a test
  // at the seam rather than end to end: the day any community def gains a preset companion, the
  // naive comparison would return null and the Sync Center would stop folding that family.
  it("groupOwners -> defForRef round-trips a beta def, the loop companionParentOf walks", () => {
    const owner = groupOwners(defs, emptyItemMap())["plugin-slides-rup"]?.[0];
    expect(owner).toEqual({ section: "community", id: "slides-rup" });
    expect(defForRef(defs, itemRef(owner!.section, owner!.id))).toBe(beta);
  });
});

describe("compileItems — app card", () => {
  it("compiles the app card as an ordinary single-file group named 'app'", () => {
    const defs = buildItemDefs({ cores: [], plugins: [], betaIds: new Set() });
    const groups = compileItems(defs, settings({ obsidian: { app: { synced: true, settingsFile: { mode: "fields", rules: { vimMode: { sharing: perClass("desktop"), encrypted: false } }, perElement: {} } } } }));
    const app = groups.find((g) => g.name === "app");
    expect(app).toMatchObject({ path: "{configDir}/app.json", type: "file", mode: "fields" });
    expect(app?.fields).toEqual([{ pattern: "vimMode", sharing: perClass("desktop"), encrypted: false }]);
    expect(app && "appSlices" in app).toBe(false);
  });

  it("app card off compiles no group, same as any other single-file card", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const groups = compileItems(defs, settings({ obsidian: { app: emptyItem() } }));
    expect(findGroup(groups, "app")).toBeUndefined();
  });
});

describe("compileItems — appearance card", () => {
  it("compiles appearance.json (own keys only) + themes/ + snippets/ companions when enabled", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      obsidian: {
        appearance: on({
          settingsFile: { mode: "fields", rules: { cssTheme: { sharing: EVERYWHERE, encrypted: false } }, perElement: {} },
          companions: [
            { path: "{configDir}/themes", device: "all", enabled: true },
            { path: "{configDir}/snippets", device: "desktop", enabled: true },
          ],
        }),
      },
    });
    const groups = compileItems(defs, s);
    const appearanceGroup = findGroup(groups, "appearance")!;
    expect(appearanceGroup.path).toBe("{configDir}/appearance.json");
    expect(appearanceGroup.fields).toEqual([{ pattern: "cssTheme", sharing: EVERYWHERE, encrypted: false }]);
    const themes = findGroup(groups, "themes")!;
    expect(themes.type).toBe("folder");
    expect(themes.devices).toBe("all");
    const snippets = findGroup(groups, "snippets")!;
    expect(snippets.devices).toBe("desktop");
  });

  it("enabledCssSnippets perElement compiles onto the appearance group", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      obsidian: {
        appearance: on({
          settingsFile: { mode: "fields", rules: {}, perElement: { enabledCssSnippets: { "my-snippet": perClass("mobile") } } },
        }),
      },
    });
    const groups = compileItems(defs, s);
    const appearanceGroup = findGroup(groups, "appearance")!;
    expect(appearanceGroup.perElement).toEqual({ enabledCssSnippets: { "my-snippet": perClass("mobile") } });
  });

  it("appearance off compiles neither appearance.json nor its companions", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      obsidian: {
        appearance: {
          synced: false,
          companions: [{ path: "{configDir}/themes", device: "all", enabled: true }],
          settingsFile: { mode: "fields", rules: { cssTheme: { sharing: EVERYWHERE, encrypted: false } }, perElement: {} },
        },
      },
    });
    const groups = compileItems(defs, s);
    expect(findGroup(groups, "appearance")).toBeUndefined();
    expect(findGroup(groups, "themes")).toBeUndefined();
  });
});

describe("compileItems — plugin cards (dir/file group when enabled)", () => {
  it("a plain single-file plugin item's fileRule.sharing compiles to the group's devices class", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      community: { dataview: on({ settingsFile: { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("desktop"), encrypted: true } } }) },
    });
    const groups = compileItems(defs, s);
    const g = findGroup(groups, "plugin-dataview")!;
    expect(g.path).toBe("{configDir}/plugins/dataview/data.json");
    expect(g.fileRule).toEqual({ sharing: perClass("desktop"), encrypted: true });
    expect(g.devices).toBe("desktop"); // Task-2-deferred: sharing → devices class
  });

  it("a disabled plugin card compiles no group", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ community: { dataview: emptyItem() } }));
    expect(findGroup(groups, "plugin-dataview")).toBeUndefined();
  });

  it("① a state-only core card still compiles a file group when enabled (attributable, not leftover)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "zk-prefixer", name: "Unique note creator", fileExists: false }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ core: { "zk-prefixer": on() } }));
    expect(findGroup(groups, "zk-prefixer")?.path).toBe("{configDir}/zk-prefixer.json");
  });

  it("① a file-absent but selected core plugin's store config is attributed, not leftover", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "backlink", name: "Backlinks", fileExists: false }] };
    const defs = buildItemDefs(env);
    const selected = compileItems(defs, settings({ core: { backlink: on() } }));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], selected)).toEqual([]);
    const unselected = compileItems(defs, settings({}));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], unselected).map((l) => l.path)).toEqual(["configdir/backlink.json"]);
  });

  it("a core card with a settings file compiles a file group named by its bare id", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "graph", name: "Graph view", fileExists: true }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ core: { graph: on() } }));
    const g = findGroup(groups, "graph")!;
    expect(g.path).toBe("{configDir}/graph.json");
  });
});

// Retired-behaviour update (task 5): these two used to assert `anyEnabledInList` — a carrier
// compiled the moment ANY card in its section was synced. The carriers are ordinary items now
// (see "the on/off lists as items" below), so a card underneath no longer drives its carrier's
// compile on its own; only the carrier's OWN entry does. Kept here, retitled, because they still
// pin something the new describe block doesn't: that a card being on is no longer SUFFICIENT.
describe("compileItems — the two on/off lists as carriers", () => {
  it("compile iff the carrier's own item is synced — a card in that section being on is no longer sufficient", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const defs = buildItemDefs(env);
    expect(findGroup(compileItems(defs, settings({})), "core-plugins")).toBeUndefined();
    expect(findGroup(compileItems(defs, settings({})), "community-plugins")).toBeUndefined();
    const cardsOnCarriersOff = compileItems(defs, settings({ core: { graph: on() }, community: { dataview: on() } }));
    expect(findGroup(cardsOnCarriersOff, "core-plugins")).toBeUndefined();
    expect(findGroup(cardsOnCarriersOff, "community-plugins")).toBeUndefined();
    const withCore = compileItems(defs, settings({ obsidian: { "core-plugins": on() } }));
    expect(findGroup(withCore, "core-plugins")).toBeDefined();
    expect(findGroup(withCore, "community-plugins")).toBeUndefined();
    const withCommunity = compileItems(defs, settings({ obsidian: { "community-plugins": on() } }));
    expect(findGroup(withCommunity, "community-plugins")).toBeDefined();
  });

  it("a beta card no longer triggers the community-plugins carrier by itself — only the carrier's own item does (same carrier file)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "slides-rup", name: "SlidesRup" }], betaIds: new Set(["slides-rup"]) };
    const defs = buildItemDefs(env);
    const betaOnCarrierOff = compileItems(defs, settings({ community: { "slides-rup": on() } }));
    expect(findGroup(betaOnCarrierOff, "community-plugins")).toBeUndefined();
    const betaOnCarrierOn = compileItems(defs, settings({ community: { "slides-rup": on() }, obsidian: { "community-plugins": on() } }));
    expect(findGroup(betaOnCarrierOn, "community-plugins")).toBeDefined();
  });
});

// spec §3.1/§3.3: the two on/off lists are ordinary registry items now — their own def, their own
// card, their own entry in `items.obsidian`. Their ref was already `obsidian/<list>` (itemKeys.ts's
// carrierRef, since v3), so nothing here re-keys anything; it only gives that ref a def and a
// compile path through the ordinary single-file loop, retiring the special-case one.
describe("the on/off lists as items", () => {
  const env = { cores: [{ id: "daily-notes", name: "Daily notes", fileExists: true }], plugins: [{ id: "dataview", name: "Dataview" }], betaIds: new Set<string>() };

  it("a carrier's def ref IS its carrier ref — the lock and the baselines keep their key", () => {
    const defs = buildItemDefs(env);
    for (const list of ["core-plugins", "community-plugins"] as const) {
      const def = defs.find((d) => d.id === list);
      expect(def?.section).toBe("obsidian");
      expect(defRef(def!)).toBe(carrierRef(list));
    }
  });

  it("a carrier compiles exactly when its own item is synced — not when some plugin in its section is", () => {
    const defs = buildItemDefs(env);
    const pluginOnly = compileItems(defs, { items: itemsIn({ community: { dataview: { synced: true } } }) });
    expect(pluginOnly.map((g) => g.name)).not.toContain("community-plugins");

    const carrierOn = compileItems(defs, { items: itemsIn({ obsidian: { "community-plugins": { synced: true } } }) });
    const carrier = carrierOn.find((g) => g.name === "community-plugins");
    expect(carrier).toMatchObject({ name: "community-plugins", ref: carrierRef("community-plugins"), path: "{configDir}/community-plugins.json", type: "file", devices: "all" });
    expect(carrier?.mode).toBeUndefined();
    expect(carrier?.perElement).toBeUndefined();
  });

  it("element rules never reach the compiled group — storage is uniform, application is not (spec §3.3)", () => {
    const defs = buildItemDefs(env);
    const items = withEnablementRule(itemsIn({ obsidian: { "core-plugins": { synced: true } } }), "core-plugins", "daily-notes", THIS_DEVICE);
    const carrier = compileItems(defs, { items }).find((g) => g.name === "core-plugins");
    expect(carrier?.perElement).toBeUndefined();
    expect(carrier?.mode).toBeUndefined();
  });
});

describe("enablementSharing — per-element sharing from the item's runsOn", () => {
  it("defaults to everywhere, reflects an explicit device rule, and forces this-device for a disabled card", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [
        { id: "graph", name: "Graph view", fileExists: true },
        { id: "canvas", name: "Canvas", fileExists: true },
        { id: "backlink", name: "Backlinks", fileExists: true },
      ],
    };
    const defs = buildItemDefs(env);
    const s = settings({
      core: {
        graph: on(), // no runsOn set → everywhere
        canvas: on({ runsOn: { device: "desktop" } }),
        backlink: emptyItem(), // disabled
      },
    });
    expect(enablementSharing(defs, s, "core-plugins")).toEqual({ graph: EVERYWHERE, canvas: perClass("desktop"), backlink: THIS_DEVICE });
  });

  it("only includes elements whose list matches", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const defs = buildItemDefs(env);
    const s = settings({ core: { graph: on() }, community: { dataview: on() } });
    expect(Object.keys(enablementSharing(defs, s, "core-plugins"))).toEqual(["graph"]);
    expect(Object.keys(enablementSharing(defs, s, "community-plugins"))).toEqual(["dataview"]);
  });

  // The 2026-07-27 mobile find: an adopted rule for a plugin NOT installed on this device has no
  // local def, so a defs-only scan dropped it — the rule was dead config and the element stayed
  // unmasked ("obsidian-git" kept showing in every mobile diff after adopt).
  it("covers stored items with no local def: their element id IS the item id", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      community: {
        dataview: on(),
        "obsidian-git": on({ runsOn: { device: "desktop" } }), // not installed here
        simpread: emptyItem(), // not installed, card disabled → this device
      },
      obsidian: { app: on() }, // no enablement list — must not leak in
    });
    expect(enablementSharing(defs, s, "community-plugins")).toEqual({
      dataview: EVERYWHERE,
      "obsidian-git": perClass("desktop"),
      simpread: THIS_DEVICE,
    });
    expect(Object.keys(enablementSharing(defs, s, "core-plugins"))).toEqual([]);
  });
});

// spec 2026-08-05-section-groups-and-member-menu-design.md §R3-A: a disabled card's this-device
// reading is structural (no rule the user wrote); a stored runsOn excludes the element from the
// structural set even though the disabled card still forces this-device.
describe("structuralLocalElements — disabled-card this-device vs a stored rule", () => {
  it("a disabled card with no stored rule is structural", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ community: { dataview: emptyItem() } });
    expect(structuralLocalElements(defs, s, "community-plugins")).toEqual(new Set(["dataview"]));
  });

  it("a disabled card that still carries a stored rule is not structural, even though its sharing is forced this-device", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ community: { dataview: { ...emptyItem(), runsOn: { device: "desktop" } } } });
    expect(enablementSharing(defs, s, "community-plugins")).toEqual({ dataview: THIS_DEVICE });
    expect(structuralLocalElements(defs, s, "community-plugins")).toEqual(new Set());
  });

  it("an enabled card is never structural", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ community: { dataview: on() } });
    expect(structuralLocalElements(defs, s, "community-plugins")).toEqual(new Set());
  });

  it("covers not-installed items the same way as defs (fallback loop parity)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      community: {
        dataview: on(),
        simpread: emptyItem(), // not installed, card disabled → structural
      },
    });
    expect(structuralLocalElements(defs, s, "community-plugins")).toEqual(new Set(["simpread"]));
  });
});

describe("compileItems — companion path collisions", () => {
  it("throws a CompileError when two DIFFERENT items' carriers land on the same store path", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      plugins: [
        { id: "dataview", name: "Dataview" },
        { id: "other-plugin", name: "Other Plugin" },
      ],
    };
    const defs = buildItemDefs(env);
    const s = settings({
      community: {
        dataview: on(),
        "other-plugin": on({
          // collides with dataview's own settingsFile path
          companions: [{ path: "{configDir}/plugins/dataview/data.json", device: "all", enabled: true }],
        }),
      },
    });
    expect(() => compileItems(defs, s)).toThrow(CompileError);
  });

  it("claims the app.json path (via the app card's own settingsFile) so a companion targeting it collides instead of compiling silently", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      obsidian: { app: on() },
      community: { dataview: on({ companions: [{ path: "{configDir}/app.json", device: "all", enabled: true }] }) },
    });
    expect(() => compileItems(defs, s)).toThrow(CompileError);
  });
});

// Final-review MUST-FIX 1 / seam test 1: compileItems itself only checks PATH collisions
// (claimPath) — it never validates a companion's basename-derived group NAME shape or a NAME
// collision across items with different paths. That gap is what previously let the companion
// add/edit UI persist a settings.items shape that compiles fine here but bricks recompile()'s
// validateSyncManifest safety net (main.ts) on every subsequent load, zeroing out compiledGroups.
// The UI-side boundary fix (validateCompanionBasename / companionNameConflict, tested in
// tests/companions.test.ts) is what actually prevents this from ever being persisted; these tests
// pin the end-to-end compile+validate behavior that fix protects against.
describe("compileItems -> validateSyncManifest safety net — companion basename (final-review MUST-FIX 1)", () => {
  const env: RegistryEnv = {
    ...EMPTY_ENV,
    plugins: [
      { id: "dataview", name: "Dataview" },
      { id: "other-plugin", name: "Other Plugin" },
    ],
  };

  it("an illegal-basename companion path (a space) compiles but fails the validateSyncManifest safety net", () => {
    const defs = buildItemDefs(env);
    const s = settings({ community: { dataview: on({ companions: [{ path: "assets/My Folder", device: "all", enabled: true }] }) } });
    const compiled = compileItems(defs, s);
    expect(compiled.some((g) => g.name === "My Folder")).toBe(true); // compileItems does not validate the name shape
    expect(() => validateSyncManifest({ version: 1, groups: compiled })).toThrow(ManifestValidationError);
  });

  it("a dotted basename (e.g. 'my.backup') compiles but fails the same safety net", () => {
    const defs = buildItemDefs(env);
    const s = settings({ community: { dataview: on({ companions: [{ path: "assets/my.backup", device: "all", enabled: true }] }) } });
    const compiled = compileItems(defs, s);
    expect(() => validateSyncManifest({ version: 1, groups: compiled })).toThrow(ManifestValidationError);
  });

  it("two companions on DIFFERENT items ending in the same path segment compile but collide at validateSyncManifest (duplicate name)", () => {
    const defs = buildItemDefs(env);
    const s = settings({
      community: {
        dataview: on({ companions: [{ path: "a/logs", device: "all", enabled: true }] }),
        "other-plugin": on({ companions: [{ path: "b/logs", device: "all", enabled: true }] }),
      },
    });
    const compiled = compileItems(defs, s);
    expect(compiled.filter((g) => g.name === "logs")).toHaveLength(2); // compileItems does not dedupe by name
    expect(() => validateSyncManifest({ version: 1, groups: compiled })).toThrow(ManifestValidationError);
  });
});

describe("compileItems — self item protection (withSelfPresets)", () => {
  it("clears a hand-edited Plain-branch fileRule when forcing fields mode on the self item, so the compiled manifest stays valid", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "config-sync", name: "Config Sync" }] };
    const defs = buildItemDefs(env);
    // A hand-edited data.json could leave the self item on settingsFile.mode "plain" with a
    // fileRule still set, even though withSelfPresets always forces "fields" mode for the self
    // item — "fields" mode + fileRule together fails manifest.ts validation.
    const s = settings({
      community: { "config-sync": on({ settingsFile: { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("desktop"), encrypted: true } } }) },
    });
    const groups = compileItems(defs, s);
    const self = findGroup(groups, "plugin-config-sync")!;
    expect(self.mode).toBe("fields");
    expect(self.fileRule).toBeUndefined();
    // This is the exact check main.ts's recompile() runs on every compiled group together — one
    // bad self group must not throw here, or it would freeze ALL of compiledGroups, not just
    // this one.
    expect(() => validateSyncManifest({ version: 1, groups })).not.toThrow();
  });

  // C-#31 one-list invariant: withSelfPresets (this file) must derive the self group's fields
  // through catalog.ts's mergePresetFields — the SAME function the self item's other
  // preset-merge call sites (ensureSelfPresets/groupForItem) use — never a second, independently
  // maintained copy of the preset+rest merge. If a future edit reimplemented the merge here
  // instead of delegating, this test would catch the drift the moment the two outputs disagree.
  it("compiles the self group's fields via catalog.ts's shared mergePresetFields — not a second hand-maintained merge", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "config-sync", name: "Config Sync" }] };
    const defs = buildItemDefs(env);
    // A "rest" rule (anything not covered by selfPresetRules()) — proves the delegation holds
    // for arbitrary caller-configured rules too, not just the empty-rules case.
    const s = settings({
      community: { "config-sync": on({ settingsFile: { mode: "fields", rules: { someCustomKey: { sharing: perClass("desktop"), encrypted: false } }, perElement: {} } }) },
    });
    const compiledFields = findGroup(compileItems(defs, s), "plugin-config-sync")!.fields!;
    expect(compiledFields).toEqual(mergePresetFields([{ pattern: "someCustomKey", sharing: perClass("desktop"), encrypted: false }]));
  });

  // C-#31 one-list invariant, part 2: the compiled self group's exclusion set (locked, scope
  // "local" fields — what adopt preserves from local instead of importing from the store, and
  // what the self compare treats as never-a-difference) is EXACTLY selfPresetRules()'s pattern
  // set, regardless of what other rules the item carries. A future settings field (e.g. the next
  // bratIndex) is therefore imported by adopt and tracked by compare together, by
  // construction — it can never land only in one of the two lists.
  it("the self group's adopt/compare exclusion set is exactly selfPresetRules() — walking the shared constant", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "config-sync", name: "Config Sync" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      community: { "config-sync": on({ settingsFile: { mode: "fields", rules: { anotherKey: { sharing: perClass("mobile"), encrypted: false } }, perElement: {} } }) },
    });
    const compiledFields = findGroup(compileItems(defs, s), "plugin-config-sync")!.fields!;
    const exclusionSet = new Set(compiledFields.filter((f) => f.locked === true && f.sharing.kind === "this-device").map((f) => f.pattern));
    expect(exclusionSet).toEqual(new Set(selfPresetRules().map((f) => f.pattern)));
    // Nothing else in the compiled fields is locked/local-scoped — "anotherKey" (the rest rule)
    // stays a plain mobile-scoped rule, not swept into the exclusion set.
    expect(compiledFields.filter((f) => f.locked === true)).toHaveLength(selfPresetRules().length);
  });
});

describe("groupOwners — compiled group name -> owning item(s), for durable stop-syncing", () => {
  it("maps the \"app\" group to the app card itself", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), emptyItemMap());
    expect(owners.app).toEqual([{ section: "obsidian", id: "app" }]);
  });

  it("maps appearance's own file and hotkeys to themselves", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), emptyItemMap());
    expect(owners.appearance).toEqual([{ section: "obsidian", id: "appearance" }]);
    expect(owners.hotkeys).toEqual([{ section: "obsidian", id: "hotkeys" }]);
  });

  it("maps appearance's companion groups to appearance, carrying the companion path", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), emptyItemMap());
    expect(owners.themes).toEqual([{ section: "obsidian", id: "appearance", companionPath: "{configDir}/themes" }]);
    expect(owners.snippets).toEqual([{ section: "obsidian", id: "appearance", companionPath: "{configDir}/snippets" }]);
  });

  it("maps a core/community plugin's group name back to its own (section, id)", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const owners = groupOwners(buildItemDefs(env), emptyItemMap());
    expect(owners.graph).toEqual([{ section: "core", id: "graph" }]);
    expect(owners["plugin-dataview"]).toEqual([{ section: "community", id: "dataview" }]);
  });

  it("maps a custom item's group to its own custom-section owner (task-8 concern fix)", () => {
    const items = itemsIn({ custom: customSection([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]) });
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), items);
    expect(owners["my-rule"]).toEqual([{ section: "custom", id: "my-rule" }]);
  });
});

// Task-8 concern fix: the Advanced tab's "Custom rules"/"Discovered files" used to be
// session-only (a bare in-memory groupsIO write) — the `custom` SECTION of settings.items +
// compileItems is their durable home now, going through the SAME claimPath accounting as every
// other item.
describe("compileItems — the custom section (spec §2/§6)", () => {
  function withCustom(groups: SyncGroup[], rest: Partial<Record<StorageSection, Record<string, Item>>> = {}): CompileSettings {
    return { items: itemsIn({ ...rest, custom: customSection(groups) }) };
  }

  it("compiles a custom item and appends it to the compiled list", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" };
    // The compiler mints the item's ref alongside its name (spec §3/§4) — a custom item's key is
    // `custom/<name>`, and it is the ONLY producer of that key.
    expect(findGroup(compileItems(defs, withCustom([group])), "my-rule")).toEqual({ ...group, ref: "custom/my-rule" });
  });

  // Task-3 review M4: the name decides the KEY now, so a name that cannot be one must fail before it
  // mints one — and it must fail by NAME. Left to validateSyncManifest downstream, the user met a
  // generic "your sync setup has an invalid rule" Notice with no culprit in it.
  it("names the offending custom rule when its name is not a legal one", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const bad: SyncGroup = { name: "bad name!", path: "notes/x.json", type: "file", devices: "all" };
    expect(() => compileItems(defs, withCustom([bad]))).toThrow(CompileError);
    expect(() => compileItems(defs, withCustom([bad]))).toThrow('"bad name!" is not a valid custom rule name');
  });

  it("compiles a discovered-file adoption (origin: \"discovered\") the same way", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "a-discovered-file", path: "a-discovered-file.json", type: "file", devices: "all", origin: "discovered" };
    expect(findGroup(compileItems(defs, withCustom([group])), "a-discovered-file")?.origin).toBe("discovered");
  });

  it("throws when a custom item's path collides with a registry item's path", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "my-hotkeys-copy", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    expect(() => compileItems(defs, withCustom([group], { obsidian: { hotkeys: on() } }))).toThrow(CompileError);
  });

  it("throws when two custom items both claim the same path", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const groups: SyncGroup[] = [
      { name: "rule-a", path: "notes/shared.json", type: "file", devices: "all" },
      { name: "rule-b", path: "notes/shared.json", type: "file", devices: "all" },
    ];
    expect(() => compileItems(defs, withCustom(groups))).toThrow(CompileError);
  });

  it("throws when a custom item's name collides with a reserved registry name", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "hotkeys", path: "notes/not-hotkeys.json", type: "file", devices: "all" };
    expect(() => compileItems(defs, withCustom([group]))).toThrow(CompileError);
  });

  it("throws when a custom item's name collides with an installed plugin's group name", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const group: SyncGroup = { name: "plugin-dataview", path: "notes/not-dataview.json", type: "file", devices: "all" };
    expect(() => compileItems(defs, withCustom([group]))).toThrow(CompileError);
  });

  it("ignores a blank-name custom item (the Advanced tab's in-memory-only draft placeholder)", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const items: ItemMap = itemsIn({ custom: { "  ": customItemFromGroup({ name: "  ", path: "notes/x.json", type: "file", devices: "all" }) } });
    expect(() => compileItems(defs, { items })).not.toThrow();
    expect(compileItems(defs, { items })).toEqual([]);
  });

  // 2.21.0 invariant II.1, at the custom section's own round trip (fix round 1, I1): a field a
  // NEWER build wrote onto a custom item must survive item -> compiled group -> Advanced-tab draft
  // -> item. v2's `{...cg}` spread carried it by accident; v3 rebuilds from a field list, so the
  // carry has to be deliberate on both sides.
  it("compiles an unknown field on a custom item straight through onto its group", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const item: Item = { synced: true, type: "file", path: "notes/x.json", writtenByANewerBuild: { keep: true } } as Item;
    const compiled = findGroup(compileItems(defs, { items: itemsIn({ custom: { "my-rule": item } }) }), "my-rule");
    expect((compiled as unknown as { writtenByANewerBuild: unknown }).writtenByANewerBuild).toEqual({ keep: true });
  });

  it("customItemFromGroup restores the tail off the STORED item — the draft has already been through the whitelist parse", () => {
    const stored: Item = { synced: true, type: "file", path: "notes/x.json", writtenByANewerBuild: { keep: true } } as Item;
    // What the Advanced tab actually holds: validateSyncManifest rebuilt it from known keys only.
    const draft: SyncGroup = { name: "my-rule", path: "notes/moved.json", type: "file", devices: "mobile" };
    const next = customItemFromGroup(draft, stored);
    expect((next as unknown as { writtenByANewerBuild: unknown }).writtenByANewerBuild).toEqual({ keep: true });
    expect(next.path).toBe("notes/moved.json"); // the edit still wins over the stored value
    expect(next.runsOn).toEqual({ device: "mobile" });
  });

  // Fix round 2: the tail crosses the Item/SyncGroup boundary, and the two shapes share field
  // NAMES — `mode`/`fields`/`fileRule`/`perElement` are SyncGroup fields today and could become
  // Item fields tomorrow. An unfiltered spread would let a value written for one be read as the
  // other, which is worse than losing it: the compiled group is rebuilt from the item every load,
  // so dropping the collision costs nothing durable, while reinterpreting it feeds a bogus value
  // to the validator and the engine.
  it("an item-level field a newer build named `mode` never lands on the compiled group as its mode", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const item: Item = { synced: true, type: "file", path: "notes/x.json", mode: "something-else" } as unknown as Item;
    const compiled = findGroup(compileItems(defs, { items: itemsIn({ custom: { "my-rule": item } }) }), "my-rule");
    expect(compiled?.mode).toBeUndefined();
    // ...and the item itself still has it — the durable side never loses anything.
    expect((item as unknown as { mode: string }).mode).toBe("something-else");
  });

  it("a group-level field a newer build named `companions` never lands on the item as its companions", () => {
    const draft = { name: "my-rule", path: "notes/x.json", type: "file", devices: "all", companions: "not an item field" } as unknown as SyncGroup;
    expect(customItemFromGroup(draft).companions).toBeUndefined();
  });

  it("a draft that DID keep an unknown field carries it too, and the draft wins", () => {
    const stored: Item = { synced: true, type: "file", path: "notes/x.json", fromTheFuture: "old" } as Item;
    const draft = { name: "my-rule", path: "notes/x.json", type: "file", devices: "all", fromTheFuture: "new" } as unknown as SyncGroup;
    expect((customItemFromGroup(draft, stored) as unknown as { fromTheFuture: string }).fromTheFuture).toBe("new");
  });

  it("carries a folder custom item's device class through runsOn", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "my-folder", path: "notes/stuff", type: "folder", devices: "mobile" };
    expect(customItemFromGroup(group).runsOn).toEqual({ device: "mobile" });
    expect(findGroup(compileItems(defs, withCustom([group])), "my-folder")).toEqual({ ...group, ref: "custom/my-folder" });
  });
});

// Round-1 leftover: `withRunsOnDevice` had no test of its own and is NOT `itemWithDevice` — it is
// the settings card's "Enabled on" write, which touches only the device axis and never enables the
// item, where itemWithDevice is the Sync Center's menu write, which forces the item on.
describe("withRunsOnDevice — the device axis alone", () => {
  it("writes the device class without enabling the item", () => {
    expect(withRunsOnDevice({ synced: false }, "mobile")).toEqual({ synced: false, runsOn: { device: "mobile" } });
  });

  it("keeps a force rule while the device axis moves — the two axes answer different questions", () => {
    const item: Item = { synced: true, runsOn: { device: "desktop", force: { state: "off", where: "everywhere" } } };
    expect(withRunsOnDevice(item, "mobile").runsOn).toEqual({ device: "mobile", force: { state: "off", where: "everywhere" } });
  });

  it("drops runsOn entirely when it would say nothing at all — a round trip leaves data.json as it found it (C-#26)", () => {
    const pinned = withRunsOnDevice({ synced: true }, "desktop");
    expect(pinned.runsOn).toEqual({ device: "desktop" });
    expect(withRunsOnDevice(pinned, "all")).toEqual({ synced: true });
    expect(withRunsOnDevice(pinned, "all")).not.toHaveProperty("runsOn");
  });

  it("keeps a lone force rule when the device axis goes back to all", () => {
    const item: Item = { synced: true, runsOn: { device: "desktop", force: { state: "on", where: "everywhere" } } };
    expect(withRunsOnDevice(item, "all").runsOn).toEqual({ device: "all", force: { state: "on", where: "everywhere" } });
  });

  it("leaves every other field alone, and does not mutate its input", () => {
    const item: Item = { synced: true, companions: [{ path: "x", device: "all", enabled: true }] };
    const snapshot = structuredClone(item);
    expect(withRunsOnDevice(item, "desktop").companions).toEqual(item.companions);
    expect(item).toEqual(snapshot);
  });
});

describe("itemWithDevice", () => {
  it("creates an enabled item from nothing", () => {
    expect(itemWithDevice(undefined, "desktop")).toEqual({ synced: true, runsOn: { device: "desktop" } });
  });
  it("preserves existing fields and forces enabled", () => {
    const existing: Item = { synced: false, companions: [{ path: "x", enabled: true, device: "all" }], settingsFile: { mode: "plain", rules: {}, perElement: {} } };
    const out = itemWithDevice(existing, "mobile");
    expect(out.runsOn).toEqual({ device: "mobile" });
    expect(out.synced).toBe(true);
    expect(out.companions).toEqual(existing.companions);
    expect(out.settingsFile).toEqual(existing.settingsFile);
  });
  it("keeps a force rule while changing the device axis — the two axes are orthogonal", () => {
    const existing: Item = { synced: true, runsOn: { device: "all", force: { state: "on", where: "everywhere" } } };
    expect(itemWithDevice(existing, "desktop").runsOn).toEqual({ device: "desktop", force: { state: "on", where: "everywhere" } });
  });
});

describe("parentCardLabel", () => {
  const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
  const defs = buildItemDefs(env);
  const appearanceSettings = settings({
    obsidian: {
      appearance: on({
        companions: [
          { path: "{configDir}/themes", device: "all", enabled: true },
          { path: "{configDir}/snippets", device: "all", enabled: true },
        ],
      }),
    },
  });

  it("resolves a preset companion to its card label", () => {
    expect(parentCardLabel("snippets", defs, appearanceSettings)).toBe("Appearance");
    expect(parentCardLabel("themes", defs, appearanceSettings)).toBe("Appearance");
  });

  // Legacy path: compileItems never emits this group, but a store manifest can still carry it
  // at runtime.
  it("resolves enabled-css-snippets to Appearance", () => {
    expect(parentCardLabel("enabled-css-snippets", defs, appearanceSettings)).toBe("Appearance");
  });

  it("returns null when the card is disabled", () => {
    const s = settings({ obsidian: { appearance: { synced: false, companions: [{ path: "{configDir}/themes", device: "all", enabled: true }] } } });
    expect(parentCardLabel("themes", defs, s)).toBeNull();
  });

  it("returns null when the companion itself is disabled", () => {
    const s = settings({ obsidian: { appearance: on({ companions: [{ path: "{configDir}/themes", device: "all", enabled: false }] }) } });
    expect(parentCardLabel("themes", defs, s)).toBeNull();
  });

  it("returns null for standalone groups", () => {
    expect(parentCardLabel("app", defs, appearanceSettings)).toBeNull();
    expect(parentCardLabel("community-plugins", defs, appearanceSettings)).toBeNull();
  });

  it("resolves a user-added companion on an enabled card", () => {
    const s = settings({ community: { dataview: on({ companions: [{ path: "scripts-folder/scripts", device: "all", enabled: true }] }) } });
    expect(parentCardLabel("scripts", defs, s)).toBe("Dataview");
  });

  // presetCompanions basename fallback (c-livetest batch4 task 1): themes/snippets still read as
  // "Appearance" even when the user never touched that companion — display-only, so it applies
  // whether or not the appearance card itself is enabled.
  it("empty settings.items → themes/snippets fall back to the appearance def's label", () => {
    const s = settings({});
    expect(parentCardLabel("themes", defs, s)).toBe("Appearance");
    expect(parentCardLabel("snippets", defs, s)).toBe("Appearance");
  });

  it("a configured enabled companion with the same basename on another item still wins over the fallback", () => {
    const s = settings({ community: { dataview: on({ companions: [{ path: "elsewhere/themes", device: "all", enabled: true }] }) } });
    expect(parentCardLabel("themes", defs, s)).toBe("Dataview");
  });

  it("disabled appearance card with no configured companions still gets the preset fallback (state does not gate it)", () => {
    const s = settings({ obsidian: { appearance: { synced: false, companions: [] } } });
    expect(parentCardLabel("themes", defs, s)).toBe("Appearance");
  });

  it("a non-companion group name still returns null", () => {
    expect(parentCardLabel("random-group", defs, settings({}))).toBeNull();
  });
});

// Final review C1 + review NEW-I1, together — they are one question with one answer.
//
// `itemEarnsDef` is 2.21.0's condition ("is there an entry?") minus exactly one shape: an entry
// whose only content is a Runs-on rule, which at 2.21.0 lived in a side table with no entry at all.
// Everything else earns a def, `{synced:false}` included — that is how a card turned off is turned
// back on (NEW-I1), and its presence in the map is the capture mask for an on/off-list element
// whose plugin is not installed here (C1). The write path prunes nothing; there is no second
// mechanism to keep in step with this one.
describe("itemEarnsDef — 2.21.0's condition minus the rule-only entry", () => {
  const CASES: Item[] = [
    { synced: false },
    { synced: true },
    { synced: false, runsOn: { device: "desktop" } },
    { synced: false, runsOn: { device: "all", force: { state: "off", where: "everywhere" } } },
    { synced: true, runsOn: { device: "mobile" } },
    { synced: false, companions: [{ path: "a/b", device: "all", enabled: true }] },
    { synced: false, settingsFile: { mode: "plain", rules: {}, perElement: {} } },
    { synced: false, path: "x/y.json" },
    { synced: false, description: "kept" },
    { synced: false, label: "kept" },
    { synced: false, origin: "discovered" },
    { synced: false, fromANewerBuild: { keep: true } } as unknown as Item,
  ];

  // Producer vs producer: the ONLY shapes this build declines are the ones 2.21.0 never had an
  // entry for. Stated as a property over every shape an item can take, not as a list of literals.
  it("declines exactly the rule-only entries, and nothing else", () => {
    const declined = CASES.filter((i) => !itemEarnsDef(i));
    expect(declined).toEqual([
      { synced: false, runsOn: { device: "desktop" } },
      { synced: false, runsOn: { device: "all", force: { state: "off", where: "everywhere" } } },
    ]);
  });

  it("a card that was turned off keeps its def, so it can be turned back on", () => {
    expect(itemEarnsDef({ synced: false })).toBe(true);
    expect(itemEarnsDef(emptyItem())).toBe(true);
  });

  it("a rule alongside real configuration is not a rule-only entry", () => {
    expect(itemEarnsDef({ synced: false, runsOn: { device: "mobile" }, description: "x" })).toBe(true);
  });
});

// The presence of an entry is this device's capture mask for that element (registry.ts's
// elementSharings, second pass), so a write must never decide an entry has nothing to say. An
// earlier round pruned `{synced:false}` here by analogy with the C-#26 field prunes; the analogy
// was false — those drop a FIELD whose absence and default agree, this dropped the entry whose
// existence IS the decision — and the result was final-review C1.
describe("withItem — never removes an entry", () => {
  it("stores an off entry rather than pruning it, because its presence is the mask", () => {
    const items = itemsIn({ community: { demo: { synced: true } } });
    const next = withItem(items, "community", "demo", { synced: false });
    expect(next.community["demo"]).toEqual({ synced: false });
  });

  it("keeps an entry that carries a rule, and leaves the other sections alone", () => {
    const items = itemsIn({ community: { demo: { synced: true } }, obsidian: { hotkeys: { synced: true } } });
    const next = withItem(items, "community", "demo", { synced: false, runsOn: { device: "desktop" } });
    expect(next.community["demo"]).toEqual({ synced: false, runsOn: { device: "desktop" } });
    expect(next.obsidian["hotkeys"]).toEqual({ synced: true });
  });

  // The two halves of the pair, on one map: an off card keeps its def AND its entry, while the
  // rule-only entry beside it keeps its entry and earns no def.
  it("an off card keeps both its entry and its def; a rule-only entry keeps only its entry", () => {
    const env: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };
    const items = withItem(
      withItem(itemsIn({}), "community", "was-a-card", { synced: false }),
      "community",
      "rule-only",
      { synced: false, runsOn: { device: "desktop" } }
    );
    const ids = defsForForeignItems(buildItemDefs(env), items, new Set()).map((d) => d.id);
    expect(items.community["was-a-card"]).toEqual({ synced: false });
    expect(items.community["rule-only"]).toEqual({ synced: false, runsOn: { device: "desktop" } });
    expect(ids).toContain("was-a-card");
    expect(ids).not.toContain("rule-only");
  });
});
