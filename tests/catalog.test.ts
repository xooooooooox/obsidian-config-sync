import { describe, expect, it } from "vitest";
import {
  CatalogItem,
  corePluginFile,
  defaultGroupForName,
  expectedPathForName,
  findGroupByName,
  groupForItem,
  joinLocation,
  listCoreSections,
  listDiscovered,
  listOptionSections,
  listPluginSections,
  optionReservedName,
  reservedNames,
  splitLocation,
  toggleSection,
} from "../src/core/catalog";
import { SyncGroup } from "../src/core/types";
import { MemFS } from "./memfs";

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
  it("buckets known options by existence and puts workspace under Not recommended", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    const names = (b: string) => (byBucket[b]?.items ?? []).map((i) => i.name).sort();
    expect(names("available")).toEqual(["app", "appearance", "snippets"]);
    expect(names("notPresent")).toEqual(["hotkeys", "themes"]);
    expect(names("notRecommended")).toEqual(["workspace"]);
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
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

  it("marks the workspace item with a caution and keeps it tickable", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const ws = sections.flatMap((s) => s.items).find((i) => i.name === "workspace");
    expect(ws?.cautionReason).toContain("device-specific");
    expect(ws?.disabledReason).toBe(null);
  });

  it("omits empty sections", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const sections = await listOptionSections(io, ".obs", NO_GROUPS);
    expect(sections.some((s) => s.bucket === "notRecommended")).toBe(false);
  });
});

describe("listCoreSections", () => {
  const cores = [
    { id: "graph", name: "Graph view", enabled: true },
    { id: "templates", name: "Templates", enabled: false },
    { id: "properties", name: "Properties", enabled: true },
    { id: "sync", name: "Sync", enabled: false },
  ];
  it("groups core settings by enabled state, sync under Not recommended, and reads runtime names", async () => {
    const io = new MemFS();
    io.seed({ ".obs/core-plugins.json": "{}", ".obs/graph.json": "{}", ".obs/types.json": "{}" });
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("core-plugins");
    expect(byBucket["enabled"]?.items.map((i) => i.name).sort()).toEqual(["graph", "properties"]);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.label).toBe("Properties");
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.path).toBe("{configDir}/types.json");
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["templates"]);
    expect(byBucket["notRecommended"]?.items.map((i) => i.name)).toEqual(["sync"]);
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "templates")).toBeUndefined();
    expect(byBucket["disabled"]?.items[0]?.exists).toBe(false); // templates.json not seeded
  });
});

describe("listPluginSections", () => {
  const plugins = [
    { id: "dataview", name: "Dataview", enabled: true },
    { id: "off-plugin", name: "Off Plugin", enabled: false },
    { id: "remotely-save", name: "Remotely Save", enabled: true },
  ];
  it("buckets community plugins by enabled/disabled/blacklist and leads with the switch list", async () => {
    const io = new MemFS();
    io.seed({ ".obs/community-plugins.json": "{}" });
    const sections = await listPluginSections(io, ".obs", plugins, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("community-plugins");
    expect(byBucket["enabled"]?.items.map((i) => i.name)).toEqual(["plugin-dataview"]);
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["plugin-off-plugin"]);
    expect(byBucket["notRecommended"]?.items[0]?.name).toBe("plugin-remotely-save");
    expect(byBucket["notRecommended"]?.items[0]?.disabledReason).toContain("cannot be synced");
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
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
      { name: "app", label: "Editor & general", description: "d", path: "{configDir}/app.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
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
      description: "Editor and general options.",
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
});

describe("section copy (action-oriented)", () => {
  it("uses the action-oriented descriptions", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const opt = await listOptionSections(io, ".obs", []);
    expect(opt.find((s) => s.bucket === "available")?.description).toBe("Sync these settings that already exist in this vault.");
    const core = await listCoreSections(io, ".obs", [{ id: "graph", name: "Graph view", enabled: true }], []);
    expect(core.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled core plugins.");
    const com = await listPluginSections(io, ".obs", [{ id: "dataview", name: "Dataview", enabled: true }], []);
    expect(com.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled community plugins.");
  });
});
