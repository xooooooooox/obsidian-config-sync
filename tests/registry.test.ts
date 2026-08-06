import { describe, expect, it } from "vitest";
import {
  buildItemDefs,
  CompileError,
  CompileSettings,
  compileItems,
  CustomGroupConfig,
  defsForForeignItems,
  emptyItemConfig,
  enablementScopes,
  groupOwners,
  itemConfigWithEnabledOn,
  ItemConfig,
  parentCardLabel,
  RegistryEnv,
  structuralLocalElements,
} from "../src/core/registry";
import { leftoverStoreRels } from "../src/core/leftover";
import { SyncGroup } from "../src/core/types";
import { ManifestValidationError, validateSyncManifest } from "../src/core/manifest";

// spec 2026-07-25-unified-card-design.md §1/§3/§5/§6; task-4-brief.md compile rules.

function settings(items: Record<string, ItemConfig>, customGroups: CustomGroupConfig[] = []): CompileSettings {
  return { items, customGroups };
}

function on(overrides: Partial<ItemConfig> = {}): ItemConfig {
  return { ...emptyItemConfig(), enabled: true, ...overrides };
}

function findGroup(groups: SyncGroup[], name: string): SyncGroup | undefined {
  return groups.find((g) => g.name === name);
}

const EMPTY_ENV: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };

describe("buildItemDefs", () => {
  it("always includes the three Obsidian cards", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const obsidianIds = defs.filter((d) => d.section === "obsidian").map((d) => d.id).sort();
    expect(obsidianIds).toEqual(["app", "appearance", "hotkeys"]);
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
    const graph = defs.find((d) => d.id === "core:graph");
    const zk = defs.find((d) => d.id === "core:zk-prefixer");
    expect(graph?.section).toBe("core");
    expect(graph?.enablement).toEqual({ carrier: "core-plugins.json", element: "graph" });
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
    const dv = defs.find((d) => d.id === "community:dataview");
    const beta = defs.find((d) => d.id === "community:slides-rup");
    expect(dv?.section).toBe("community");
    expect(dv?.enablement).toEqual({ carrier: "community-plugins.json", element: "dataview" });
    expect(dv?.settingsFile?.defaultPath).toBe("{configDir}/plugins/dataview/data.json");
    expect(dv?.description).toBe("");
    expect(beta?.section).toBe("beta"); // beta reuses the community id form (spec §1)
    expect(beta?.id).toBe("community:slides-rup");
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
    const defs = defsForForeignItems(buildItemDefs(EMPTY_ENV), ["community:dataview"], new Set());
    const groups = compileItems(defs, settings({ "community:dataview": on() }));
    expect(groups.map((g) => g.name)).toContain("plugin-dataview");
    expect(findGroup(groups, "plugin-dataview")?.path).toBe("{configDir}/plugins/dataview/data.json");
  });

  it("a synthesized def for a BRAT-indexed id is classified beta", () => {
    const defs = defsForForeignItems(buildItemDefs(EMPTY_ENV), ["community:slides-rup"], new Set(["slides-rup"]));
    expect(defs.find((d) => d.id === "community:slides-rup")?.section).toBe("beta");
  });

  it("an installed plugin's def is never duplicated", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const installedDefs = buildItemDefs(env);
    const defs = defsForForeignItems(installedDefs, ["community:dataview"], new Set());
    expect(defs.filter((d) => d.id === "community:dataview")).toHaveLength(1);
  });
});

describe("compileItems — app card", () => {
  it("compiles the app card as an ordinary single-file group named 'app'", () => {
    const defs = buildItemDefs({ cores: [], plugins: [], betaIds: new Set() });
    const groups = compileItems(defs, {
      items: { app: { enabled: true, companions: [], settingsFile: { mode: "fields", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} } } },
      customGroups: [],
    });
    const app = groups.find((g) => g.name === "app");
    expect(app).toMatchObject({ path: "{configDir}/app.json", type: "file", mode: "fields" });
    expect(app?.fields).toEqual([{ pattern: "vimMode", scope: "desktop", encrypted: false }]);
    expect(app && "appSlices" in app).toBe(false);
  });

  it("app card off compiles no group, same as any other single-file card", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const groups = compileItems(defs, settings({ app: emptyItemConfig() }));
    expect(findGroup(groups, "app")).toBeUndefined();
  });
});

describe("compileItems — appearance card", () => {
  it("compiles appearance.json (own keys only) + themes/ + snippets/ companions when enabled", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      appearance: on({
        settingsFile: { mode: "fields", rules: { cssTheme: { scope: "all", encrypted: false } }, perItem: {} },
        companions: [
          { path: "{configDir}/themes", scope: "all", enabled: true },
          { path: "{configDir}/snippets", scope: "desktop", enabled: true },
        ],
      }),
    });
    const groups = compileItems(defs, s);
    const appearanceGroup = findGroup(groups, "appearance")!;
    expect(appearanceGroup.path).toBe("{configDir}/appearance.json");
    expect(appearanceGroup.fields).toEqual([{ pattern: "cssTheme", scope: "all", encrypted: false }]);
    const themes = findGroup(groups, "themes")!;
    expect(themes.type).toBe("dir");
    expect(themes.devices).toBe("all");
    const snippets = findGroup(groups, "snippets")!;
    expect(snippets.devices).toBe("desktop");
  });

  it("enabledCssSnippets perItem compiles onto the appearance group", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      appearance: on({
        settingsFile: { mode: "fields", rules: {}, perItem: { enabledCssSnippets: { "my-snippet": "mobile" } } },
      }),
    });
    const groups = compileItems(defs, s);
    const appearanceGroup = findGroup(groups, "appearance")!;
    expect(appearanceGroup.perItem).toEqual({ enabledCssSnippets: { "my-snippet": "mobile" } });
  });

  it("appearance off compiles neither appearance.json nor its companions", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const s = settings({
      appearance: {
        enabled: false,
        companions: [{ path: "{configDir}/themes", scope: "all", enabled: true }],
        settingsFile: { mode: "fields", rules: { cssTheme: { scope: "all", encrypted: false } }, perItem: {} },
      },
    });
    const groups = compileItems(defs, s);
    expect(findGroup(groups, "appearance")).toBeUndefined();
    expect(findGroup(groups, "themes")).toBeUndefined();
  });
});

describe("compileItems — plugin cards (dir/file group when enabled)", () => {
  it("a plain single-file plugin item's fileRule.scope compiles to the group's devices class", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      "community:dataview": on({ settingsFile: { mode: "plain", rules: {}, perItem: {}, fileRule: { scope: "desktop", encrypted: true } } }),
    });
    const groups = compileItems(defs, s);
    const g = findGroup(groups, "plugin-dataview")!;
    expect(g.path).toBe("{configDir}/plugins/dataview/data.json");
    expect(g.fileRule).toEqual({ scope: "desktop", encrypted: true });
    expect(g.devices).toBe("desktop"); // Task-2-deferred: scope → devices class
  });

  it("a disabled plugin card compiles no group", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ "community:dataview": emptyItemConfig() }));
    expect(findGroup(groups, "plugin-dataview")).toBeUndefined();
  });

  it("① a state-only core card still compiles a file group when enabled (attributable, not leftover)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "zk-prefixer", name: "Unique note creator", fileExists: false }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ "core:zk-prefixer": on() }));
    expect(findGroup(groups, "zk-prefixer")?.path).toBe("{configDir}/zk-prefixer.json");
  });

  it("① a file-absent but selected core plugin's store config is attributed, not leftover", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "backlink", name: "Backlinks", fileExists: false }] };
    const defs = buildItemDefs(env);
    const selected = compileItems(defs, settings({ "core:backlink": on() }));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], selected)).toEqual([]);
    const unselected = compileItems(defs, settings({}));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], unselected).map((l) => l.path)).toEqual(["configdir/backlink.json"]);
  });

  it("a core card with a settings file compiles a file group named by its bare id", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "graph", name: "Graph view", fileExists: true }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ "core:graph": on() }));
    const g = findGroup(groups, "graph")!;
    expect(g.path).toBe("{configDir}/graph.json");
  });
});

describe("compileItems — hidden enablement switch-list groups", () => {
  it("exist iff at least one card in that section is enabled", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const defs = buildItemDefs(env);
    expect(findGroup(compileItems(defs, settings({})), "core-plugins")).toBeUndefined();
    expect(findGroup(compileItems(defs, settings({})), "community-plugins")).toBeUndefined();
    const withCore = compileItems(defs, settings({ "core:graph": on() }));
    expect(findGroup(withCore, "core-plugins")).toBeDefined();
    expect(findGroup(withCore, "community-plugins")).toBeUndefined();
    const withCommunity = compileItems(defs, settings({ "community:dataview": on() }));
    expect(findGroup(withCommunity, "community-plugins")).toBeDefined();
  });

  it("a beta card counts toward the community-plugins hidden group (same carrier file)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "slides-rup", name: "SlidesRup" }], betaIds: new Set(["slides-rup"]) };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ "community:slides-rup": on() }));
    expect(findGroup(groups, "community-plugins")).toBeDefined();
  });
});

describe("enablementScopes — per-element scope from enabledOn", () => {
  it("default 'all', reflects an explicit enabledOn, and forces 'local' for a disabled card", () => {
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
      "core:graph": on(), // no enabledOn set → defaults to "all"
      "core:canvas": on({ enabledOn: "desktop" }),
      "core:backlink": emptyItemConfig(), // disabled
    });
    const scopes = enablementScopes(defs, s, "core-plugins.json");
    expect(scopes).toEqual({ graph: "all", canvas: "desktop", backlink: "local" });
  });

  it("only includes elements whose carrier matches", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const defs = buildItemDefs(env);
    const s = settings({ "core:graph": on(), "community:dataview": on() });
    expect(Object.keys(enablementScopes(defs, s, "core-plugins.json"))).toEqual(["graph"]);
    expect(Object.keys(enablementScopes(defs, s, "community-plugins.json"))).toEqual(["dataview"]);
  });

  // The 2026-07-27 mobile find: an adopted enabledOn for a plugin NOT installed on this device
  // has no local def, so a defs-only scan dropped it — the scope was dead config and the element
  // stayed unmasked ("obsidian-git" kept showing in every mobile diff after adopt).
  it("covers item configs with no local def: their element id derives from the item id", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      "community:dataview": on(),
      "community:obsidian-git": on({ enabledOn: "desktop" }), // not installed here
      "community:simpread": emptyItemConfig(), // not installed, card disabled → This-device
      app: on(), // obsidian card — no enablement carrier, must not leak in
    });
    expect(enablementScopes(defs, s, "community-plugins.json")).toEqual({
      dataview: "all",
      "obsidian-git": "desktop",
      simpread: "local",
    });
    expect(Object.keys(enablementScopes(defs, s, "core-plugins.json"))).toEqual([]);
  });

  // task-2 retarget: the explicit "this device" choice now lives in settings.localMembers, never
  // in ItemConfig.enabledOn — a stored "local" is a pre-retarget artifact and must be ignored
  // (read back as "all"), while the disabled-card structural "local" is untouched.
  it("ignores a stored enabledOn 'local' but still forces 'local' for a disabled card", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      plugins: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    const defs = buildItemDefs(env);
    const s = settings({
      "community:a": on({ enabledOn: "local" }),
      "community:b": emptyItemConfig(), // disabled
    });
    const scopes = enablementScopes(defs, s, "community-plugins.json");
    expect(scopes["a"]).toBe("all"); // explicit choice now ignored
    expect(scopes["b"]).toBe("local"); // disabled card stays local
  });
});

// spec 2026-08-05-section-groups-and-member-menu-design.md §R3-A: a disabled card's "local" is
// structural (no rule the user wrote); a stored enabledOn survives even though it's ignored for
// the scope itself, so it must still exclude the element from the structural set.
describe("structuralLocalElements — disabled-card 'local' vs an explicit enabledOn leftover", () => {
  it("a disabled card with no stored enabledOn is structural", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ "community:dataview": emptyItemConfig() });
    expect(structuralLocalElements(defs, s, "community-plugins.json")).toEqual(new Set(["dataview"]));
  });

  it("a disabled card that still carries a stored enabledOn is not structural, even though its scope is forced local", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ "community:dataview": { ...emptyItemConfig(), enabledOn: "desktop" } });
    expect(enablementScopes(defs, s, "community-plugins.json")).toEqual({ dataview: "local" });
    expect(structuralLocalElements(defs, s, "community-plugins.json")).toEqual(new Set());
  });

  it("an enabled card is never structural", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({ "community:dataview": on() });
    expect(structuralLocalElements(defs, s, "community-plugins.json")).toEqual(new Set());
  });

  it("covers not-installed item configs the same way as defs (fallback loop parity)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      "community:dataview": on(),
      "community:simpread": emptyItemConfig(), // not installed, card disabled → structural
    });
    expect(structuralLocalElements(defs, s, "community-plugins.json")).toEqual(new Set(["simpread"]));
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
      "community:dataview": on(),
      "community:other-plugin": on({
        // collides with dataview's own settingsFile path
        companions: [{ path: "{configDir}/plugins/dataview/data.json", scope: "all", enabled: true }],
      }),
    });
    expect(() => compileItems(defs, s)).toThrow(CompileError);
  });

  it("claims the app.json path (via the app card's own settingsFile) so a companion targeting it collides instead of compiling silently", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const s = settings({
      app: on(),
      "community:dataview": on({ companions: [{ path: "{configDir}/app.json", scope: "all", enabled: true }] }),
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
    const s = settings({
      "community:dataview": on({ companions: [{ path: "assets/My Folder", scope: "all", enabled: true }] }),
    });
    const compiled = compileItems(defs, s);
    expect(compiled.some((g) => g.name === "My Folder")).toBe(true); // compileItems does not validate the name shape
    expect(() => validateSyncManifest({ version: 1, groups: compiled })).toThrow(ManifestValidationError);
  });

  it("a dotted basename (e.g. 'my.backup') compiles but fails the same safety net", () => {
    const defs = buildItemDefs(env);
    const s = settings({
      "community:dataview": on({ companions: [{ path: "assets/my.backup", scope: "all", enabled: true }] }),
    });
    const compiled = compileItems(defs, s);
    expect(() => validateSyncManifest({ version: 1, groups: compiled })).toThrow(ManifestValidationError);
  });

  it("two companions on DIFFERENT items ending in the same path segment compile but collide at validateSyncManifest (duplicate name)", () => {
    const defs = buildItemDefs(env);
    const s = settings({
      "community:dataview": on({ companions: [{ path: "a/logs", scope: "all", enabled: true }] }),
      "community:other-plugin": on({ companions: [{ path: "b/logs", scope: "all", enabled: true }] }),
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
      "community:config-sync": on({
        settingsFile: { mode: "plain", rules: {}, perItem: {}, fileRule: { scope: "desktop", encrypted: true } },
      }),
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
});

describe("groupOwners — compiled group name -> owning item(s), for durable stop-syncing", () => {
  it("maps the \"app\" group to the app card itself", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), []);
    expect(owners.app).toEqual([{ itemId: "app" }]);
  });

  it("maps appearance's own file and hotkeys to themselves", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), []);
    expect(owners.appearance).toEqual([{ itemId: "appearance" }]);
    expect(owners.hotkeys).toEqual([{ itemId: "hotkeys" }]);
  });

  it("maps appearance's companion groups to appearance, carrying the companion path", () => {
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), []);
    expect(owners.themes).toEqual([{ itemId: "appearance", companionPath: "{configDir}/themes" }]);
    expect(owners.snippets).toEqual([{ itemId: "appearance", companionPath: "{configDir}/snippets" }]);
  });

  it("maps a core/community plugin's legacy group name back to its own item id", () => {
    const env: RegistryEnv = {
      ...EMPTY_ENV,
      cores: [{ id: "graph", name: "Graph view", fileExists: true }],
      plugins: [{ id: "dataview", name: "Dataview" }],
    };
    const owners = groupOwners(buildItemDefs(env), []);
    expect(owners.graph).toEqual([{ itemId: "core:graph" }]);
    expect(owners["plugin-dataview"]).toEqual([{ itemId: "community:dataview" }]);
  });

  it("maps a custom group to a synthetic custom:<name> owner (task-8 concern fix)", () => {
    const custom: CustomGroupConfig[] = [{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }];
    const owners = groupOwners(buildItemDefs(EMPTY_ENV), custom);
    expect(owners["my-rule"]).toEqual([{ itemId: "custom:my-rule", custom: true }]);
  });
});

// Task-8 concern fix: the Advanced tab's "Custom rules"/"Discovered files" used to be
// session-only (a bare in-memory groupsIO write) — settings.customGroups + compileItems is their
// durable home now, going through the SAME claimPath accounting as every other item.
describe("compileItems — settings.customGroups (spec §6 addition)", () => {
  it("compiles a custom group and appends it to the compiled list", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }];
    const groups = compileItems(defs, settings({}, custom));
    expect(findGroup(groups, "my-rule")).toEqual(custom[0]);
  });

  it("compiles a discovered-file adoption (origin: \"discovered\") the same way", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [{ name: "a-discovered-file", path: "a-discovered-file.json", type: "file", devices: "all", origin: "discovered" }];
    const groups = compileItems(defs, settings({}, custom));
    expect(findGroup(groups, "a-discovered-file")?.origin).toBe("discovered");
  });

  it("throws when a custom group's path collides with a registry item's path", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [{ name: "my-hotkeys-copy", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }];
    expect(() => compileItems(defs, settings({ hotkeys: on() }, custom))).toThrow(CompileError);
  });

  it("throws when two custom groups both claim the same path", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [
      { name: "rule-a", path: "notes/shared.json", type: "file", devices: "all" },
      { name: "rule-b", path: "notes/shared.json", type: "file", devices: "all" },
    ];
    expect(() => compileItems(defs, settings({}, custom))).toThrow(CompileError);
  });

  it("throws when a custom group's name collides with a reserved registry name", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [{ name: "hotkeys", path: "notes/not-hotkeys.json", type: "file", devices: "all" }];
    expect(() => compileItems(defs, settings({}, custom))).toThrow(CompileError);
  });

  it("throws when a custom group's name collides with an installed plugin's legacy group name", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
    const defs = buildItemDefs(env);
    const custom: CustomGroupConfig[] = [{ name: "plugin-dataview", path: "notes/not-dataview.json", type: "file", devices: "all" }];
    expect(() => compileItems(defs, settings({}, custom))).toThrow(CompileError);
  });

  it("ignores a blank-name custom group (the Advanced tab's in-memory-only draft placeholder)", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const custom: CustomGroupConfig[] = [{ name: "  ", path: "notes/x.json", type: "file", devices: "all" }];
    expect(() => compileItems(defs, settings({}, custom))).not.toThrow();
    expect(compileItems(defs, settings({}, custom))).toEqual([]);
  });

});

describe("itemConfigWithEnabledOn", () => {
  it("creates an enabled config from nothing", () => {
    expect(itemConfigWithEnabledOn(undefined, "desktop")).toEqual({ enabled: true, companions: [], enabledOn: "desktop" });
  });
  it("preserves existing fields and forces enabled", () => {
    const existing: ItemConfig = { enabled: false, companions: [{ path: "x", enabled: true, scope: "all" }], settingsFile: { mode: "plain", rules: {}, perItem: {} } };
    const out = itemConfigWithEnabledOn(existing, "mobile");
    expect(out.enabledOn).toBe("mobile");
    expect(out.enabled).toBe(true);
    expect(out.companions).toEqual(existing.companions);
    expect(out.settingsFile).toEqual(existing.settingsFile);
  });
});

describe("parentCardLabel", () => {
  const env: RegistryEnv = { ...EMPTY_ENV, plugins: [{ id: "dataview", name: "Dataview" }] };
  const defs = buildItemDefs(env);
  const appearanceSettings = settings({
    appearance: on({
      companions: [
        { path: "{configDir}/themes", scope: "all", enabled: true },
        { path: "{configDir}/snippets", scope: "all", enabled: true },
      ],
    }),
  });

  it("resolves a preset companion to its card label", () => {
    expect(parentCardLabel("snippets", defs, appearanceSettings)).toBe("Appearance");
    expect(parentCardLabel("themes", defs, appearanceSettings)).toBe("Appearance");
  });

  // Legacy path: compileItems never emits this group under schema v2, but v3-era store
  // manifests can still carry it at runtime.
  it("resolves enabled-css-snippets to Appearance", () => {
    expect(parentCardLabel("enabled-css-snippets", defs, appearanceSettings)).toBe("Appearance");
  });

  it("returns null when the card is disabled", () => {
    const s = settings({
      appearance: { enabled: false, companions: [{ path: "{configDir}/themes", scope: "all", enabled: true }] },
    });
    expect(parentCardLabel("themes", defs, s)).toBeNull();
  });

  it("returns null when the companion itself is disabled", () => {
    const s = settings({
      appearance: on({ companions: [{ path: "{configDir}/themes", scope: "all", enabled: false }] }),
    });
    expect(parentCardLabel("themes", defs, s)).toBeNull();
  });

  it("returns null for standalone groups", () => {
    expect(parentCardLabel("app", defs, appearanceSettings)).toBeNull();
    expect(parentCardLabel("community-plugins", defs, appearanceSettings)).toBeNull();
  });

  it("resolves a user-added companion on an enabled card", () => {
    const s = settings({
      "community:dataview": on({ companions: [{ path: "scripts-folder/scripts", scope: "all", enabled: true }] }),
    });
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
    const s = settings({
      "community:dataview": on({ companions: [{ path: "elsewhere/themes", scope: "all", enabled: true }] }),
    });
    expect(parentCardLabel("themes", defs, s)).toBe("Dataview");
  });

  it("disabled appearance card with no configured companions still gets the preset fallback (state does not gate it)", () => {
    const s = settings({ appearance: { enabled: false, companions: [] } });
    expect(parentCardLabel("themes", defs, s)).toBe("Appearance");
  });

  it("a non-companion group name still returns null", () => {
    expect(parentCardLabel("random-group", defs, settings({}))).toBeNull();
  });
});
