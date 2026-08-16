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
  groupOwners,
  Item,
  ItemDef,
  ItemMap,
  itemFor,
  itemForGroupName,
  parentCardLabel,
  storageSection,
  withItem,
  RegistryEnv,
} from "../src/core/registry";
import { itemsIn } from "./items";
import { leftoverStoreRels } from "../src/core/leftover";
import { SyncGroup, EVERYWHERE, itemRef, parseItemRef, perClass, StorageSection, THIS_DEVICE } from "../src/core/types";
import { ManifestValidationError, validateSyncManifest } from "../src/core/manifest";
import { mergePresetFields, selfPresetRules } from "../src/core/catalog";
import { carrierRef } from "../src/core/itemKeys";
import { withEnablementRule } from "../src/core/enablementRules";

// Design reference: docs/superpowers/specs/2026-07-25-unified-card-design.md §1/§3/§5/§6.

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
  it("always includes the five Obsidian cards — the three settings cards plus the two on/off lists", () => {
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

// `beta` is a PRESENTED classification, never a stored one. A
// `beta/<id>` ref would name an item no reader can find — every mask reader resolves the
// `community` section — so the chip would show a pin the capture/apply mask never saw, and the id
// would change the day BRAT adopted or dropped the plugin. `ItemRef` is built from
// StorageSection, so `itemRef(def.section, …)` does not compile for a def that may be beta;
// `defRef` is the only def → ref conversion and it goes through `storageSection`.
describe("item identity never carries the beta classification", () => {
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
  });

  it("parseItemRef refuses a beta ref outright — it was never a legal identity", () => {
    expect(parseItemRef("beta/slides-rup")).toBeNull();
    expect(parseItemRef("community/slides-rup")).toEqual({ section: "community", id: "slides-rup" });
  });

  // Closing the leak by construction protects MINTING, not MATCHING. The
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

  // spec §3.2: a fileRule set before the card switched to per-key rules (mode "plain" ->
  // "fields") is leftover state, not live configuration — only the "plain" branch of
  // compileSingleFile ever reads item.settingsFile.fileRule. Pinning this protects the display
  // fix in a later task from a future "compile it too, while we're at it" regression.
  it("fields mode never compiles a leftover fileRule, and devices stays 'all'", () => {
    const defs = buildItemDefs({ cores: [], plugins: [], betaIds: new Set() });
    const groups = compileItems(
      defs,
      settings({
        obsidian: {
          app: {
            synced: true,
            settingsFile: {
              mode: "fields",
              rules: { vimMode: { sharing: perClass("desktop"), encrypted: false } },
              perElement: {},
              fileRule: { sharing: perClass("desktop"), encrypted: true },
            },
          },
        },
      })
    );
    const group = findGroup(groups, "app");
    expect(group?.devices).toBe("all");
    expect(group?.fileRule).toBeUndefined();
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
    expect(g.devices).toBe("desktop"); // sharing → devices class
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
    const noNames = { pluginLabels: new Map<string, string>(), fileOwners: new Map<string, { section: "obsidian" | "core"; label: string }>(), appearanceLabel: "Appearance" };
    const selected = compileItems(defs, settings({ core: { backlink: on() } }));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], selected, noNames)).toEqual([]);
    const unselected = compileItems(defs, settings({}));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], unselected, noNames).map((l) => l.path)).toEqual(["configdir/backlink.json"]);
  });

  it("a core card with a settings file compiles a file group named by its bare id", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "graph", name: "Graph view", fileExists: true }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ core: { graph: on() } }));
    const g = findGroup(groups, "graph")!;
    expect(g.path).toBe("{configDir}/graph.json");
  });
});

// The carriers are ordinary items (see "the on/off lists as items" below): a card underneath
// never drives its carrier's compile on its own; only the carrier's OWN entry does. These two
// pin the negative half — that a card being on is not SUFFICIENT.
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

// The two on/off lists are ordinary registry items — their own def, their own
// card, their own entry in `items.obsidian`. Their ref is `obsidian/<list>` (itemKeys.ts's
// carrierRef), and they compile through the ordinary single-file loop, no special case.
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

  // The Sync Center's carrier chip is a read-only shortcut, and it must
  // jump to the card whether or not the carrier is synced — a NOT-synced carrier has no compiled
  // group, but the def exists regardless, and itemForGroupName is a DEF lookup (registry.ts), never
  // a compiled-list lookup. An empty items map is the sharpest way to prove that.
  it("resolves the carrier's ref from the def alone — an empty compiled list changes nothing", () => {
    const defs = buildItemDefs(env);
    for (const list of ["core-plugins", "community-plugins"] as const) {
      const def = itemForGroupName(defs, list);
      expect(def).not.toBeNull();
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

  it("element rules never reach the compiled group — storage is uniform, application is not", () => {
    const defs = buildItemDefs(env);
    const items = withEnablementRule(itemsIn({ obsidian: { "core-plugins": { synced: true } } }), "core-plugins", "daily-notes", THIS_DEVICE);
    const carrier = compileItems(defs, { items }).find((g) => g.name === "core-plugins");
    expect(carrier?.perElement).toBeUndefined();
    expect(carrier?.mode).toBeUndefined();
  });

  // A rules entry keyed by a plugin id can land on a carrier item (the File preview's
  // click-to-add, SettingTab.ts's addRuleForKey, is suppressed for carriers, but a vault saved by
  // an older build can already carry one) — deriveMode then flips the item to "fields" mode
  // (rules is no longer empty; that part is a genuine, correct field rule and IS expected to
  // compile). compileSingleFile must NOT copy `perElement` onto the compiled group VERBATIM:
  // that would include the reserved "" key the carrier's own element rules live under, and
  // downstream captureTransform would read that "" key as a per-element ARRAY field and write
  // `"": []` into core-plugins.json/community-plugins.json, corrupting the switch-list file (the
  // next load's parseSwitchList returns null and the whole mechanism goes silently bypassed).
  // This test defends the registry.ts layer on its own, independent of the UI-level suppression.
  it("a carrier item carrying both a rules entry and reserved-key element rules never leaks the reserved key onto the compiled group", () => {
    const defs = buildItemDefs(env);
    const withElementRule = withEnablementRule(itemsIn({ obsidian: { "core-plugins": { synced: true } } }), "core-plugins", "daily-notes", THIS_DEVICE);
    const carrierItem = withElementRule.obsidian["core-plugins"]!;
    const sf = carrierItem.settingsFile!; // holds perElement[""] = { "daily-notes": THIS_DEVICE } from withEnablementRule above
    // A rules entry keyed by a plugin
    // id, on top of the reserved-key element rules already present.
    const corrupted: Item = { ...carrierItem, settingsFile: { ...sf, mode: "fields", rules: { "some-plugin-id": { sharing: EVERYWHERE, encrypted: false } } } };
    const items: ItemMap = { ...withElementRule, obsidian: { ...withElementRule.obsidian, "core-plugins": corrupted } };
    const carrier = compileItems(defs, { items }).find((g) => g.name === "core-plugins");
    // The rules entry is a genuine field rule and DOES compile — that part is correct, not the bug.
    expect(carrier?.mode).toBe("fields");
    expect(carrier?.fields).toEqual([{ pattern: "some-plugin-id", sharing: EVERYWHERE, encrypted: false }]);
    // The reserved key must never reach the compiled group — this is the actual corruption this test
    // guards against.
    expect(carrier?.perElement).toBeUndefined();
  });

  // perElementFromMap-level: a real perElement key survives
  // alongside the reserved "" key being dropped — proven through a fields-mode item's compiled group
  // rather than calling the (unexported) function directly.
  it("perElementFromMap drops only the reserved '' key — a real perElement key rides through untouched", () => {
    const env2: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env2);
    const items = itemsIn({
      community: {
        dataview: {
          synced: true,
          settingsFile: {
            mode: "fields",
            rules: { tags: { sharing: EVERYWHERE, encrypted: false } },
            perElement: { "": { "some-element": THIS_DEVICE }, tags: { desktop: perClass("desktop") } },
          },
        },
      },
    });
    const group = compileItems(defs, { items }).find((g) => g.name === "plugin-dataview");
    expect(group?.perElement).toEqual({ tags: { desktop: perClass("desktop") } });
  });
});

// There is no enablementSharing / structuralLocalElements / elementSharings / deviceSharing
// (2026-08-12-enablement-two-layers-design.md §5): a per-element rule is STORED
// on the carrier item (enablementRules.ts, tests/enablementRules.test.ts) rather than derived
// from each item's own runsOn plus whether its card happens to be switched on.

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

// compileItems itself only checks PATH collisions
// (claimPath) — it never validates a companion's basename-derived group NAME shape or a NAME
// collision across items with different paths. That gap would let the companion
// add/edit UI persist a settings.items shape that compiles fine here but bricks recompile()'s
// validateSyncManifest safety net (main.ts) on every subsequent load, zeroing out compiledGroups.
// The UI-side boundary (validateCompanionBasename / companionNameConflict, tested in
// tests/companions.test.ts) is what actually prevents this from ever being persisted; these tests
// pin the end-to-end compile+validate behavior it protects against.
describe("compileItems -> validateSyncManifest safety net — companion basename", () => {
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

  // One-list invariant: withSelfPresets (this file) must derive the self group's fields
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

  // One-list invariant, part 2: the compiled self group's exclusion set (locked, scope
  // "local" fields — what adopt preserves from local instead of importing from the store, and
  // what the self compare treats as never-a-difference) is EXACTLY selfPresetRules()'s pattern
  // set, regardless of what other rules the item carries. A future settings field (e.g. a
  // top-level map like the old bratIndex) is therefore imported by adopt and tracked by compare
  // together, by construction — it can never land only in one of the two lists.
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

  it("maps a custom item's group to its own custom-section owner", () => {
    const items = itemsIn({ custom: customSection([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]) });
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), items);
    expect(owners["my-rule"]).toEqual([{ section: "custom", id: "my-rule" }]);
  });
});

// The Advanced tab's "Custom rules"/"Discovered files" live durably in
// the `custom` SECTION of settings.items +
// compileItems, going through the SAME claimPath accounting as every
// other item — never a session-only in-memory groupsIO write.
describe("compileItems — the custom section", () => {
  function withCustom(groups: SyncGroup[], rest: Partial<Record<StorageSection, Record<string, Item>>> = {}): CompileSettings {
    return { items: itemsIn({ ...rest, custom: customSection(groups) }) };
  }

  it("compiles a custom item and appends it to the compiled list", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" };
    // The compiler mints the item's ref alongside its name — a custom item's key is
    // `custom/<name>`, and it is the ONLY producer of that key.
    expect(findGroup(compileItems(defs, withCustom([group])), "my-rule")).toEqual({ ...group, ref: "custom/my-rule" });
  });

  // The name decides the KEY, so a name that cannot be one must fail before it
  // mints one — and it must fail by NAME. Left to validateSyncManifest downstream, the user would
  // meet a generic "your sync setup has an invalid rule" Notice with no culprit in it.
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

  // The unknown-field carry, at the custom section's own round trip: a field a
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
    expect(next.settingsFile?.fileRule).toEqual({ sharing: perClass("mobile"), encrypted: false });
  });

  // The tail crosses the Item/SyncGroup boundary, and the two shapes share field
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

  it("carries a folder custom item's device class through its file rule", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const group: SyncGroup = { name: "my-folder", path: "notes/stuff", type: "folder", devices: "mobile" };
    const item = customItemFromGroup(group);
    expect(item.settingsFile?.fileRule).toEqual({ sharing: perClass("mobile"), encrypted: false });
    expect(findGroup(compileItems(defs, withCustom([group])), "my-folder")).toEqual({ ...group, ref: "custom/my-folder" });
  });
});

// There is no withRunsOnDevice / itemWithDevice / `runsOn` (2026-08-12-enablement-two-layers):
// a custom item's device class is its file-level sharing (customItemFromGroup, tested
// above) — the same field and writer as every registry item's Settings-sync control — and the
// on/off-list's own two layers are
// enablementRules.ts/deviceElements.ts, covered by tests/enablementDecision.test.ts.

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

  // presetCompanions basename fallback: themes/snippets still read as
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

// There is no itemEarnsDef (retired with `runsOn`, 2026-08-12-enablement-two-layers): its one
// exclusion was an entry whose only content was
// a Runs-on rule, and that shape no longer exists — a rule lives on the carrier item, not on
// the plugin's own entry. defsForForeignItems' `known.has(id)` guard is the whole test again; see
// its own comment in registry.ts.

// The presence of an entry is this device's capture mask for an on/off-list element, so a write
// must never decide an entry has nothing to say. Pruning `{synced:false}` by
// analogy with the field prunes would be a false analogy — those drop a FIELD whose absence and
// default agree; this entry's existence IS the decision.
describe("withItem — never removes an entry", () => {
  it("stores an off entry rather than pruning it, because its presence is the mask", () => {
    const items = itemsIn({ community: { demo: { synced: true } } });
    const next = withItem(items, "community", "demo", { synced: false });
    expect(next.community["demo"]).toEqual({ synced: false });
  });

  it("keeps an entry that carries other configuration, and leaves the other sections alone", () => {
    const items = itemsIn({ community: { demo: { synced: true } }, obsidian: { hotkeys: { synced: true } } });
    const next = withItem(items, "community", "demo", { synced: false, description: "kept" });
    expect(next.community["demo"]).toEqual({ synced: false, description: "kept" });
    expect(next.obsidian["hotkeys"]).toEqual({ synced: true });
  });

  // An off card keeps both its entry and its def, so it can be turned back on.
  it("an off card keeps both its entry and its def", () => {
    const env: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };
    const items = withItem(itemsIn({}), "community", "was-a-card", { synced: false });
    const ids = defsForForeignItems(buildItemDefs(env), items, new Set()).map((d) => d.id);
    expect(items.community["was-a-card"]).toEqual({ synced: false });
    expect(ids).toContain("was-a-card");
  });
});
