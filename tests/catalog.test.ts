import { describe, expect, it } from "vitest";
import {
  findGroupByPath,
  groupForItem,
  joinLocation,
  listOptionItems,
  listPluginItems,
  slugForPath,
  splitLocation,
} from "../src/core/catalog";
import { SyncGroup } from "../src/core/types";
import { MemFS } from "./memfs";

function seededFs(): MemFS {
  const io = new MemFS();
  io.seed({
    ".obs/app.json": "{}",
    ".obs/hotkeys.json": "{}",
    ".obs/workspace.json": "{}",
    ".obs/core-plugins-migration.json": "{}",
    ".obs/custom-unknown.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obs/plugins/demo/data.json": "{}",
  });
  return io;
}

describe("listOptionItems", () => {
  it("labels known items, keeps unknown filenames, hides machine files and plugins/", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
    expect(byPath["{configDir}/app.json"]?.label).toBe("Editor & general");
    expect(byPath["{configDir}/hotkeys.json"]?.label).toBe("Hotkeys");
    expect(byPath["{configDir}/snippets"]?.type).toBe("dir");
    expect(byPath["{configDir}/custom-unknown.json"]?.label).toBe("custom-unknown.json");
    expect(byPath["{configDir}/core-plugins-migration.json"]).toBeUndefined();
    expect(items.some((i) => i.path === "{configDir}/plugins")).toBe(false);
  });

  it("marks workspace files with a caution, not a hard disable", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const ws = items.find((i) => i.path === "{configDir}/workspace.json");
    expect(ws?.cautionReason).toContain("device-specific");
    expect(ws?.disabledReason).toBe(null);
  });

  it("always lists known items, absent ones with exists=false", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const themes = items.find((i) => i.path === "{configDir}/themes");
    expect(themes).toBeDefined();
    expect(themes?.exists).toBe(false);
    expect(items.find((i) => i.path === "{configDir}/app.json")?.exists).toBe(true);
  });

  it("keeps a checked-but-absent unknown item visible with exists=false", async () => {
    const groups: SyncGroup[] = [{ name: "gone", path: "{configDir}/custom-gone.json", type: "file", devices: "all" }];
    const items = await listOptionItems(seededFs(), ".obs", groups);
    const gone = items.find((i) => i.path === "{configDir}/custom-gone.json");
    expect(gone?.exists).toBe(false);
  });

  it("lists all known items even for a missing configDir", async () => {
    const items = await listOptionItems(new MemFS(), ".obs", []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !i.exists)).toBe(true);
  });
});

describe("listPluginItems", () => {
  it("maps installed plugins to data.json paths, sorted by name, blacklist disabled", () => {
    const items = listPluginItems([
      { id: "zzz-plugin", name: "Zzz" },
      { id: "remotely-save", name: "Remotely Save" },
      { id: "dataview", name: "Dataview" },
    ]);
    expect(items.map((i) => i.name)).toEqual(["Dataview", "Remotely Save", "Zzz"]);
    expect(items[0]?.dataPath).toBe("{configDir}/plugins/dataview/data.json");
    expect(items.find((i) => i.id === "remotely-save")?.disabledReason).toContain("cannot be synced");
    expect(items.find((i) => i.id === "dataview")?.disabledReason).toBe(null);
  });
});

describe("slugForPath / groupForItem / findGroupByPath", () => {
  it("derives friendly slugs and dedupes against existing names", () => {
    expect(slugForPath("{configDir}/hotkeys.json", [])).toBe("hotkeys");
    expect(slugForPath("{configDir}/plugins/dataview/data.json", [])).toBe("plugin-dataview");
    expect(slugForPath("{configDir}/hotkeys.json", ["hotkeys"])).toBe("hotkeys-2");
  });

  it("groupForItem builds an all-devices group and findGroupByPath matches it", () => {
    const g = groupForItem("{configDir}/snippets", "dir", [], "CSS snippets");
    expect(g).toEqual({ name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all", description: "CSS snippets" });
    const bare = groupForItem("{configDir}/x.json", "file", [], null);
    expect(bare).toEqual({ name: "x", path: "{configDir}/x.json", type: "file", devices: "all" });
    expect(findGroupByPath([g], "{configDir}/snippets")).toBe(g);
    expect(findGroupByPath([g], "{configDir}/hotkeys.json")).toBeUndefined();
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
