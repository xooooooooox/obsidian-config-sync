import { afterEach, describe, expect, it } from "vitest";
import {
  appearancePresetRules,
  CatalogItem,
  categoryForGroup,
  corePluginFile,
  CORE_ID_SEED,
  defaultGroupForName,
  displayLabelForGroup,
  ensureAppearancePresets,
  ensureSelfPresets,
  expectedPathForName,
  findGroupByName,
  groupForItem,
  joinLocation,
  listCoreSections,
  listDiscovered,
  listOptionSections,
  listBetaSections,
  listPluginSections,
  optionReservedName,
  reservedNames,
  SELF_GROUP_NAME,
  selfPresetRules,
  setCorePluginIds,
  splitLocation,
  toggleSection,
} from "../src/core/catalog";
import { SyncGroup } from "../src/core/types";
import { FakePlugins, MemFS } from "./memfs";

function optionFs(): MemFS {
  const io = new MemFS();
  io.seed({
    ".obs/app.json": "{}",
    ".obs/appearance.json": "{}",
    ".obs/graph.json": "{}",           // core file — must NOT appear in options
    ".obs/workspace.json": "{}",
    ".obs/custom-unknown.json": "{}",
    ".obs/core-plugins-migration.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obs/plugins/demo/data.json": "{}",
  });
  return io;
}
const NO_GROUPS: SyncGroup[] = [];

describe("listOptionSections", () => {
  it("buckets known options by existence and leaves workspace.json to discovered", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    const names = (b: string) => (byBucket[b]?.items ?? []).map((i) => i.name).sort();
    expect(names("available")).toEqual(["app", "appearance", "enabled-css-snippets", "snippets"]);
    expect(names("notPresent")).toEqual(["hotkeys", "themes"]);
    expect(byBucket["notRecommended"]).toBeUndefined();
    expect(byBucket["available"]?.allowSyncAll).toBe(true);
  });

  it("excludes core files, plugins dir, switch lists and migration file from options", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const all = sections.flatMap((s) => s.items.map((i) => i.name));
    expect(all).not.toContain("graph");
    expect(all).not.toContain("plugins");
    expect(all).not.toContain("core-plugins");
    expect(all).not.toContain("core-plugins-migration");
  });

  it("does not first-class workspace.json — it falls through to discovered instead", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const ws = sections.flatMap((s) => s.items).find((i) => i.name === "workspace");
    expect(ws).toBeUndefined();
    const disc = await listDiscovered(optionFs(), ".obs", NO_GROUPS);
    expect(disc.map((d) => d.name)).toContain("workspace");
  });

  it("omits empty sections", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const sections = await listOptionSections(io, ".obs", NO_GROUPS);
    expect(sections.some((s) => s.bucket === "notRecommended")).toBe(false);
  });

  it("surfaces enabled-css-snippets as an available item when appearance.json is present", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const item = sections.flatMap((s) => s.items).find((i) => i.name === "enabled-css-snippets");
    expect(item).toEqual({
      name: "enabled-css-snippets",
      label: "Enabled CSS snippets",
      description: "Which CSS snippets are on, per device.",
      path: "{configDir}/enabled-css-snippets.json",
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: null,
    });
  });

  it("omits enabled-css-snippets when appearance.json is absent", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const sections = await listOptionSections(io, ".obs", NO_GROUPS);
    const all = sections.flatMap((s) => s.items.map((i) => i.name));
    expect(all).not.toContain("enabled-css-snippets");
  });
});

describe("listCoreSections", () => {
  const cores = [
    { id: "graph", name: "Graph view", enabled: true },
    { id: "templates", name: "Templates", enabled: false },
    { id: "properties", name: "Properties", enabled: true },
    { id: "sync", name: "Sync", enabled: false },
    { id: "switcher", name: "Quick switcher", enabled: true }, // runtime id NOT in the seed
  ];

  it("lists only cores whose settings file exists, split by enabled state, with caution on sync", async () => {
    const io = new MemFS();
    // graph.json, types.json (properties), sync.json, switcher.json exist; templates.json does NOT
    io.seed({
      ".obs/core-plugins.json": "{}",
      ".obs/graph.json": "{}",
      ".obs/types.json": "{}",
      ".obs/sync.json": "{}",
      ".obs/switcher.json": "{}",
    });
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("core-plugins");
    // switcher is picked up dynamically even though it is not in CORE_ID_SEED
    expect(byBucket["enabled"]?.items.map((i) => i.name).sort()).toEqual(["graph", "properties", "switcher"]);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "switcher")?.path).toBe("{configDir}/switcher.json");
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.path).toBe("{configDir}/types.json");
    // sync.json exists → disabled + caution; templates.json absent → excluded by the file filter
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["sync"]);
    expect(byBucket["disabled"]?.items.find((i) => i.name === "sync")?.cautionReason).not.toBeNull();
    expect(sections.some((s) => s.items.some((i) => i.name === "templates"))).toBe(false);
  });

  it("excludes a core whose settings file is absent", async () => {
    const io = new MemFS();
    io.seed({ ".obs/core-plugins.json": "{}" }); // no per-core files
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["enabled"]).toBeUndefined();
    expect(byBucket["disabled"]).toBeUndefined();
  });
});

describe("setCorePluginIds injection", () => {
  afterEach(() => setCorePluginIds(CORE_ID_SEED)); // restore seed so test order is independent

  it("recognizes an injected non-seed core id in pure judgments", () => {
    expect(categoryForGroup("switcher")).toBe("custom"); // not in seed yet
    expect(expectedPathForName("switcher")).toBe(null);
    setCorePluginIds(["switcher"]);
    expect(categoryForGroup("switcher")).toBe("core");
    expect(expectedPathForName("switcher")).toBe("{configDir}/switcher.json");
    expect(reservedNames([]).has("switcher")).toBe(true);
  });
});

describe("listPluginSections", () => {
  const plugins = [
    { id: "dataview", name: "Dataview", enabled: true },
    { id: "off-plugin", name: "Off Plugin", enabled: false },
    { id: "remotely-save", name: "Remotely Save", enabled: true },
  ];
  it("buckets community plugins by enabled/disabled and leads with the switch list", async () => {
    const io = new MemFS();
    io.seed({ ".obs/community-plugins.json": "{}" });
    const sections = await listPluginSections(io, ".obs", plugins, NO_GROUPS, new Set<string>());
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("community-plugins");
    expect(byBucket["enabled"]?.items.map((i) => i.name).sort()).toEqual(["plugin-dataview", "plugin-remotely-save"]);
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["plugin-off-plugin"]);
    expect(byBucket["notRecommended"]).toBeUndefined();
  });
});

describe("beta/community split (BRAT index)", () => {
  const plugins = [
    { id: "dataview", name: "Dataview", enabled: true },
    { id: "slides-rup", name: "SlidesRup", enabled: true },
    { id: "simpread", name: "SimpRead Sync", enabled: false },
  ];
  const index = { "slides-rup": "shawndotty/slidesrup", simpread: "Kenshin/simpread-obsidian-plugin", "my-text-tools": "shawndotty/my-text-tools" };
  const groups: SyncGroup[] = [
    { name: "plugin-my-text-tools", label: "My Text Tools", path: "{configDir}/plugins/my-text-tools/data.json", type: "file", devices: "all" },
    { name: "plugin-devonlink", label: "DEVONlink", path: "{configDir}/plugins/devonlink/data.json", type: "file", devices: "all" },
  ];

  it("community tab excludes beta ids and lists non-beta not-installed groups", async () => {
    const io = new MemFS();
    io.seed({ ".obs/community-plugins.json": "{}" });
    const sections = await listPluginSections(io, ".obs", plugins, groups, new Set(Object.keys(index)));
    const byBucket = Object.fromEntries(sections.map((sec) => [sec.bucket, sec]));
    expect(byBucket["enabled"]?.items.map((i) => i.name)).toEqual(["plugin-dataview"]);
    expect(byBucket["disabled"]).toBeUndefined(); // simpread is beta → not here
    expect(byBucket["notinstalled"]?.items.map((i) => i.name)).toEqual(["plugin-devonlink"]);
  });

  it("beta tab splits installed by enabled state and lists not-installed beta groups with repos", async () => {
    const sections = await listBetaSections(plugins, groups, index);
    const byBucket = Object.fromEntries(sections.map((sec) => [sec.bucket, sec]));
    expect(byBucket["enabled"]?.items.map((i) => i.name)).toEqual(["plugin-slides-rup"]);
    expect(byBucket["enabled"]?.items[0]?.description).toContain("shawndotty/slidesrup");
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["plugin-simpread"]);
    expect(byBucket["notinstalled"]?.items.map((i) => i.name)).toEqual(["plugin-my-text-tools"]);
    expect(byBucket["notinstalled"]?.items[0]?.description).toContain("shawndotty/my-text-tools");
    expect(byBucket["list"]).toBeUndefined(); // no on/off list on the beta tab
  });

  it("beta tab is empty with an empty index", async () => {
    expect(await listBetaSections(plugins, groups, {})).toEqual([]);
  });
});

describe("groupForItem / toggleSection", () => {
  it("groupForItem uses the fixed name (no slug dedup) and attaches description when given", () => {
    expect(groupForItem("graph", "{configDir}/graph.json", "file", "Graph view")).toEqual({
      name: "graph",
      path: "{configDir}/graph.json",
      type: "file",
      devices: "all",
      description: "Graph view",
    });
    expect(groupForItem("app", "{configDir}/app.json", "file", null)).toEqual({
      name: "app",
      path: "{configDir}/app.json",
      type: "file",
      devices: "all",
    });
  });

  it("toggleSection adds groups for every tickable item, or removes them all", () => {
    const items: CatalogItem[] = [
      { name: "app", label: "App settings", description: "d", path: "{configDir}/app.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
      { name: "appearance", label: "Appearance", description: "d", path: "{configDir}/appearance.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
    ];
    const on = toggleSection([], items, true);
    expect(on.map((g) => g.name).sort()).toEqual(["app", "appearance"]);
    const off = toggleSection(on, items, false);
    expect(off).toEqual([]);
  });

  it("toggleSection(on) is idempotent and skips hard-disabled items", () => {
    const items: CatalogItem[] = [
      { name: "app", label: "l", description: null, path: "{configDir}/app.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
      { name: "plugin-x", label: "l", description: null, path: "{configDir}/plugins/x/data.json", type: "file", exists: true, disabledReason: "blocked", cautionReason: null },
    ];
    const start: SyncGroup[] = [{ name: "app", path: "{configDir}/app.json", type: "file", devices: "all" }];
    const result = toggleSection(start, items, true);
    expect(result.map((g) => g.name)).toEqual(["app"]);
  });
});

describe("splitLocation / joinLocation", () => {
  it("round-trips config-folder and vault-root paths", () => {
    expect(splitLocation("{configDir}/plugins/x/data.json")).toEqual({ location: "config", rel: "plugins/x/data.json" });
    expect(splitLocation(".obsidian.vimrc")).toEqual({ location: "vault", rel: ".obsidian.vimrc" });
    expect(joinLocation("config", "hotkeys.json")).toBe("{configDir}/hotkeys.json");
    expect(joinLocation("vault", ".obsidian.vimrc")).toBe(".obsidian.vimrc");
  });
});

describe("name and path helpers", () => {
  it("corePluginFile reads the map, with an <id>.json fallback", () => {
    expect(corePluginFile("graph")).toBe("graph.json");
    expect(corePluginFile("properties")).toBe("types.json");
    expect(corePluginFile("brand-new-core")).toBe("brand-new-core.json");
  });

  it("optionReservedName strips the .json extension, keeps dir names", () => {
    expect(optionReservedName("app.json")).toBe("app");
    expect(optionReservedName("snippets")).toBe("snippets");
  });

  it("reservedNames unions option, core-settings and community identities", () => {
    const names = reservedNames(["dataview"]);
    expect(names.has("app")).toBe(true);
    expect(names.has("graph")).toBe(true);
    expect(names.has("properties")).toBe(true);
    expect(names.has("plugin-dataview")).toBe(true);
    expect(names.has("core-plugins")).toBe(true);
    expect(names.has("nope")).toBe(false);
  });

  it("expectedPathForName maps each identity kind back to its path", () => {
    expect(expectedPathForName("app")).toBe("{configDir}/app.json");
    expect(expectedPathForName("snippets")).toBe("{configDir}/snippets");
    expect(expectedPathForName("graph")).toBe("{configDir}/graph.json");
    expect(expectedPathForName("properties")).toBe("{configDir}/types.json");
    expect(expectedPathForName("plugin-dataview")).toBe("{configDir}/plugins/dataview/data.json");
    expect(expectedPathForName("not-a-known-name")).toBe(null);
  });

  it("findGroupByName matches on name, not path", () => {
    const groups: SyncGroup[] = [{ name: "graph", path: "{configDir}/custom.json", type: "file", devices: "all" }];
    expect(findGroupByName(groups, "graph")?.path).toBe("{configDir}/custom.json");
    expect(findGroupByName(groups, "app")).toBeUndefined();
  });
});

describe("defaultGroupForName", () => {
  it("returns the picker default for an option name (with catalog description)", () => {
    expect(defaultGroupForName("app")).toEqual({
      name: "app",
      path: "{configDir}/app.json",
      type: "file",
      devices: "all",
      description: "Editor, Files & links and other general options (app.json).",
    });
    expect(defaultGroupForName("snippets")).toEqual({
      name: "snippets",
      path: "{configDir}/snippets",
      type: "dir",
      devices: "all",
      description: "Your CSS snippets.",
    });
  });

  it("returns the picker default for a community and core name", () => {
    expect(defaultGroupForName("plugin-dataview")).toEqual({
      name: "plugin-dataview",
      path: "{configDir}/plugins/dataview/data.json",
      type: "file",
      devices: "all",
      description: "Settings of dataview.",
    });
    expect(defaultGroupForName("properties")).toEqual({
      name: "properties",
      path: "{configDir}/types.json",
      type: "file",
      devices: "all",
    });
  });

  it("returns null for a non-reserved name", () => {
    expect(defaultGroupForName("my-own")).toBeNull();
  });
});

describe("listDiscovered", () => {
  it("lists unclassified config-root json, excludes junk/known/covered, prefills a slug name", async () => {
    const io = new MemFS();
    io.seed({
      ".obs/app.json": "{}",                              // known option → excluded
      ".obs/graph.json": "{}",                            // core file → excluded
      ".obs/community-plugins.json": "{}",                // switch list → excluded
      ".obs/core-plugins-migration.json": "{}",           // hidden → excluded
      ".obs/.DS_Store": "junk",                           // dotfile/non-json → excluded
      ".obs/image-converter-image-alignments.json": "{}", // unclassified → INCLUDED
      ".obs/covered.json": "{}",                          // covered by a group below → excluded
      ".obs/plugins/demo/data.json": "{}",                // under plugins/ → excluded
    });
    const groups: SyncGroup[] = [{ name: "covered-rule", path: "{configDir}/covered.json", type: "file", devices: "all" }];
    const found = await listDiscovered(io, ".obs", groups);
    expect(found).toEqual([
      { name: "image-converter-image-alignments", path: "{configDir}/image-converter-image-alignments.json" },
    ]);
  });

  it("excludes .DS_Store and non-json even when no group exists", async () => {
    const io = new MemFS();
    io.seed({ ".obs/.DS_Store": "junk", ".obs/notes.txt": "x" });
    expect(await listDiscovered(io, ".obs", [])).toEqual([]);
  });

  it("discovered files include volatile workspace.json but exclude the workspaces core plugin file", async () => {
    const io = new MemFS();
    io.seed({
      ".obs/workspace.json": "{}",                         // device-specific but unclassified → INCLUDED
      ".obs/workspaces.json": "{}",                        // core plugin file → excluded via coreFileSet()
      ".obs/image-converter-image-alignments.json": "{}", // unclassified → INCLUDED
    });
    const found = await listDiscovered(io, ".obs", []);
    expect(found).toEqual([
      { name: "image-converter-image-alignments", path: "{configDir}/image-converter-image-alignments.json" },
      { name: "workspace", path: "{configDir}/workspace.json" },
    ]);
  });
});

describe("section copy (action-oriented)", () => {
  it("uses the action-oriented descriptions", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}", ".obs/graph.json": "{}" });
    const opt = await listOptionSections(io, ".obs", []);
    expect(opt.find((s) => s.bucket === "available")?.description).toBe("Sync these settings that already exist in this vault.");
    const core = await listCoreSections(io, ".obs", [{ id: "graph", name: "Graph view", enabled: true }], []);
    expect(core.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled core plugins.");
    const com = await listPluginSections(io, ".obs", [{ id: "dataview", name: "Dataview", enabled: true }], [], new Set<string>());
    expect(com.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled community plugins.");
  });
});

describe("categoryForGroup", () => {
  it("categorizes group names", () => {
    expect(categoryForGroup("themes")).toBe("obsidian");
    expect(categoryForGroup("daily-notes")).toBe("core");
    expect(categoryForGroup("plugin-dataview")).toBe("community");
    expect(categoryForGroup("my-vimrc")).toBe("custom");
  });

  it("categorizes the synthetic enabled-css-snippets switch list as Obsidian", () => {
    // It is derived from appearance.json and surfaces under the Obsidian settings tab, so the
    // Sync Center scope must match — not fall through to Custom.
    expect(categoryForGroup("enabled-css-snippets")).toBe("obsidian");
  });
});

describe("displayLabelForGroup", () => {
  it("resolves labels per source with fallbacks", () => {
    const plugins = new FakePlugins();
    plugins.installed.set("obsidian42-brat", "1.0.0");
    plugins.installedNames.set("obsidian42-brat", "BRAT");
    plugins.coreNames.set("daily-notes", "Daily notes");
    expect(displayLabelForGroup("appearance", plugins)).toBe("Appearance");
    expect(displayLabelForGroup("daily-notes", plugins)).toBe("Daily notes");
    expect(displayLabelForGroup("plugin-obsidian42-brat", plugins)).toBe("BRAT");
    expect(displayLabelForGroup("plugin-not-installed", plugins)).toBe("not-installed");
    expect(displayLabelForGroup("my-custom-rule", plugins)).toBe("my-custom-rule");
  });
});

describe("displayLabelForGroup label priority", () => {
  const noPlugins = { getInstalledPluginName: () => null, getCorePluginName: () => null } as unknown as import("../src/core/ConfigSyncCore").PluginHost;
  it("uses the stored label when no runtime name resolves", () => {
    expect(displayLabelForGroup("plugin-obsidian42-brat", noPlugins, "BRAT")).toBe("BRAT");
  });
  it("prefers the runtime plugin name over the stored label", () => {
    const p = { getInstalledPluginName: (id: string) => (id === "obsidian42-brat" ? "BRAT live" : null), getCorePluginName: () => null } as unknown as import("../src/core/ConfigSyncCore").PluginHost;
    expect(displayLabelForGroup("plugin-obsidian42-brat", p, "BRAT stale")).toBe("BRAT live");
  });
  it("falls back to the raw id when neither resolves", () => {
    expect(displayLabelForGroup("plugin-obsidian42-brat", noPlugins)).toBe("obsidian42-brat");
  });
});

describe("groupForItem", () => {
  it("records a label when given", () => {
    expect(groupForItem("plugin-x", "{configDir}/plugins/x/data.json", "file", null, "Xtension").label).toBe("Xtension");
    expect(groupForItem("plugin-x", "{configDir}/plugins/x/data.json", "file", null).label).toBeUndefined();
  });

  it("attaches locked strip presets when the produced group is the self item", () => {
    const g = groupForItem(SELF_GROUP_NAME, "{configDir}/plugins/config-sync/data.json", "file", null);
    expect(g.mode).toBe("fields");
    expect(g.fields).toEqual(selfPresetRules());
    expect(g.fields).toEqual([
      { pattern: "rootPath", action: "strip", locked: true },
      { pattern: "remotes", action: "strip", locked: true },
      { pattern: "switchExceptions", action: "strip", locked: true },
    ]);
  });

  it("leaves other item names unaffected (no mode/fields added)", () => {
    const g = groupForItem("plugin-x", "{configDir}/plugins/x/data.json", "file", null);
    expect(g.mode).toBeUndefined();
    expect(g.fields).toBeUndefined();
  });
});

describe("selfPresetRules", () => {
  it("has exactly three locked strip rules, the third being switchExceptions", () => {
    const rules = selfPresetRules();
    expect(rules).toHaveLength(3);
    expect(rules[2]).toEqual({ pattern: "switchExceptions", action: "strip", locked: true });
  });
});

describe("appearancePresetRules", () => {
  it("has exactly one locked strip rule for enabledCssSnippets", () => {
    expect(appearancePresetRules()).toEqual([{ pattern: "enabledCssSnippets", action: "strip", locked: true }]);
  });
});

describe("ensureSelfPresets", () => {
  it("adds presets to a bare self group", () => {
    const groups: SyncGroup[] = [{ name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }];
    const out = ensureSelfPresets(groups);
    const self = out.find((g) => g.name === SELF_GROUP_NAME);
    expect(self?.mode).toBe("fields");
    expect(self?.fields).toEqual(selfPresetRules());
  });

  it("upgrades an existing two-preset self group to three presets", () => {
    const groups: SyncGroup[] = [
      {
        name: SELF_GROUP_NAME,
        path: "{configDir}/plugins/config-sync/data.json",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [
          { pattern: "rootPath", action: "strip", locked: true },
          { pattern: "remotes", action: "strip", locked: true },
        ],
      },
    ];
    const out = ensureSelfPresets(groups);
    const self = out.find((g) => g.name === SELF_GROUP_NAME);
    expect(self?.fields).toEqual(selfPresetRules());
    expect(self?.fields).toHaveLength(3);
  });

  it("normalizes an unlocked duplicate of a preset pattern to the locked preset", () => {
    const groups: SyncGroup[] = [
      {
        name: SELF_GROUP_NAME,
        path: "{configDir}/plugins/config-sync/data.json",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [{ pattern: "rootPath", action: "strip" }],
      },
    ];
    const out = ensureSelfPresets(groups);
    const self = out.find((g) => g.name === SELF_GROUP_NAME);
    expect(self?.fields?.filter((f) => f.pattern === "rootPath")).toEqual([{ pattern: "rootPath", action: "strip", locked: true }]);
    expect(self?.fields).toEqual(selfPresetRules());
  });

  it("keeps user-added other rules alongside the presets", () => {
    const groups: SyncGroup[] = [
      {
        name: SELF_GROUP_NAME,
        path: "{configDir}/plugins/config-sync/data.json",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [{ pattern: "myToken", action: "encrypt" }],
      },
    ];
    const out = ensureSelfPresets(groups);
    const self = out.find((g) => g.name === SELF_GROUP_NAME);
    expect(self?.fields).toEqual([...selfPresetRules(), { pattern: "myToken", action: "encrypt" }]);
  });

  it("is idempotent: double-apply equals single-apply", () => {
    const groups: SyncGroup[] = [{ name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }];
    const once = ensureSelfPresets(groups);
    const twice = ensureSelfPresets(once);
    expect(twice).toEqual(once);
  });

  it("returns groups unchanged (same values) when no self group is present", () => {
    const groups: SyncGroup[] = [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }];
    const out = ensureSelfPresets(groups);
    expect(out).toEqual(groups);
    expect(out).not.toBe(groups);
  });

  it("does not mutate its input", () => {
    const groups: SyncGroup[] = [{ name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }];
    const snapshot = structuredClone(groups);
    ensureSelfPresets(groups);
    expect(groups).toEqual(snapshot);
  });
});

describe("appearance strip when snippet list is active", () => {
  // Group name is "appearance" (the reserved name — see optionReservedName), not "appearance.json";
  // matches the fixtures used elsewhere in this file (e.g. line 238) and in merge.test.ts.
  const appearance = { name: "appearance", path: "{configDir}/appearance.json", type: "file", devices: "all" } as const;
  const snippet = { name: "enabled-css-snippets", path: "{configDir}/enabled-css-snippets.json", type: "file", devices: "all" } as const;

  it("adds a locked enabledCssSnippets strip + fields mode ONLY when the snippet group is present", () => {
    const out = ensureAppearancePresets([{ ...appearance }, { ...snippet }]);
    const app = out.find((g) => g.name === "appearance")!;
    expect(app.mode).toBe("fields");
    expect(app.fields).toContainEqual({ pattern: "enabledCssSnippets", action: "strip", locked: true });
  });
  it("leaves appearance untouched when the snippet group is absent", () => {
    const out = ensureAppearancePresets([{ ...appearance }]);
    expect(out.find((g) => g.name === "appearance")).toEqual(appearance);
  });
});

describe("workspaces reclassification and section dissolution", () => {
  it("lists workspaces.json as a core plugin item, not a discovered file", async () => {
    const io = new MemFS();
    io.seed({ ".obs/workspaces.json": "{}", ".obs/graph.json": "{}" });
    const cores = [{ id: "workspaces", name: "Workspaces", enabled: true }, { id: "graph", name: "Graph view", enabled: true }];
    const secs = await listCoreSections(io, ".obs", cores, []);
    const names = secs.flatMap((s) => s.items.map((i) => i.name));
    expect(names).toContain("workspaces");
    expect(secs.map((s) => s.heading)).not.toContain("Not recommended");
    const disc = await listDiscovered(io, ".obs", []);
    expect(disc.map((d) => d.name)).not.toContain("workspaces");
  });
  it("keeps volatile workspace.json out of the Obsidian sections and lets it reach discovered", async () => {
    const io = new MemFS();
    io.seed({ ".obs/workspace.json": "{}", ".obs/app.json": "{}" });
    const secs = await listOptionSections(io, ".obs", []);
    const names = secs.flatMap((s) => s.items.map((i) => i.name));
    expect(names).not.toContain("workspace");
    expect(secs.map((s) => s.heading)).not.toContain("Not recommended");
    const disc = await listDiscovered(io, ".obs", []);
    expect(disc.map((d) => d.name)).toContain("workspace");
  });
  it("returns sync/publish to Enabled/Disabled with a cautionReason", async () => {
    const io = new MemFS();
    io.seed({ ".obs/sync.json": "{}", ".obs/publish.json": "{}" });
    const cores = [{ id: "sync", name: "Sync", enabled: true }, { id: "publish", name: "Publish", enabled: false }];
    const secs = await listCoreSections(io, ".obs", cores, []);
    const enabled = secs.find((s) => s.heading === "Enabled")?.items ?? [];
    const disabled = secs.find((s) => s.heading === "Disabled")?.items ?? [];
    expect(enabled.find((i) => i.name === "sync")?.cautionReason).not.toBeNull();
    expect(disabled.find((i) => i.name === "publish")?.cautionReason).not.toBeNull();
  });
});
