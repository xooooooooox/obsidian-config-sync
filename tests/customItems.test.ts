import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { buildItemDefs, compileItems, customItemFromGroup, Item, ItemMap, RegistryEnv } from "../src/core/registry";
import { perClass, SyncGroup } from "../src/core/types";
import { itemsIn } from "./items";

// The Advanced tab's "Custom rules"/"Discovered files" must never write through
// a session-only groupsIO path — a custom rule or an adopted discovered file would survive within
// the current session but be lost on the next Obsidian restart/plugin reload, since nothing in
// settings.items recorded it. The `custom` SECTION of settings.items (registry.ts's compileItems,
// main.ts's stopSyncing) is their durable home.
//
// main.ts has no existing test harness beyond tests/mainReloadSettings.test.ts's pattern (Plugin
// is stubbed to an empty class by tests/mock-obsidian.ts — no test drives Obsidian's own runtime).
// This builds the same minimum fake app/loadData/saveData and drives a real ConfigSyncPlugin
// instance, via bracket access to bypass TypeScript's `private` (compile-time-only).
function fakeApp(): unknown {
  return {
    vault: {
      adapter: { exists: async () => false },
      configDir: "config-dir", // deliberately not ".obsidian" — obsidianmd/hardcoded-config-path; irrelevant here
      on: () => ({}),
    },
    internalPlugins: { plugins: {} },
    plugins: { manifests: {}, enabledPlugins: new Set<string>(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {},
  };
}

function customSection(groups: SyncGroup[]): Record<string, Item> {
  return Object.fromEntries(groups.map((g) => [g.name, customItemFromGroup(g)]));
}

function baseData(groups: SyncGroup[]): unknown {
  return { schemaVersion: 3, items: itemsIn({ custom: customSection(groups) }), remotes: [], bratIndex: {} };
}

interface PluginTestSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  stopSyncing: (groupName: string, deleteStore: boolean) => Promise<string[] | null>; // null = refused (spec 2026-08-11)
  settings: { items: ItemMap };
  compiledGroups: { name: string }[];
}

function makePlugin(groups: SyncGroup[]): { instance: PluginTestSurface; saved: () => unknown } {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as PluginTestSurface;
  instance.app = fakeApp();
  instance.loadData = async () => baseData(groups);
  let saved: unknown = null;
  instance.saveData = async (d: unknown) => {
    saved = d;
  };
  return { instance, saved: () => saved };
}

function savedCustomNames(saved: unknown): string[] {
  return Object.keys((saved as { items?: ItemMap } | null)?.items?.custom ?? {});
}

describe("items.custom — settings round-trip (add -> serialize shape -> compile)", () => {
  it("a custom item loaded from data.json round-trips into compiledGroups", async () => {
    const group: SyncGroup = { name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" };
    const { instance } = makePlugin([group]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.settings.items.custom).toEqual(customSection([group]));
    expect(instance.compiledGroups.find((g) => g.name === "my-rule")).toBeDefined();
  });

  it("a discovered-file adoption (origin: \"discovered\") round-trips the same way", async () => {
    const { instance } = makePlugin([{ name: "a-discovered-file", path: "a-discovered-file.json", type: "file", devices: "all", origin: "discovered" }]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.compiledGroups.find((g) => g.name === "a-discovered-file")).toBeDefined();
  });
});

describe("stopSyncing — custom-item removal is durable (items.custom), not session-only", () => {
  it("removes the custom item from items.custom and persists it via saveData", async () => {
    const { instance, saved } = makePlugin([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.compiledGroups.map((g) => g.name)).toContain("my-rule");

    await instance.stopSyncing("my-rule", false);

    // In-memory settings no longer carry the removed rule...
    expect(instance.settings.items.custom).toEqual({});
    // ...and the removal was actually persisted (saveData called with the updated settings), not
    // just held in memory for the rest of the session (the original defect).
    expect(savedCustomNames(saved())).toEqual([]);
    // ...and the recompile that follows saveSettings() drops it from the compiled list too.
    expect(instance.compiledGroups.map((g) => g.name)).not.toContain("my-rule");
  });

  it("leaves a different custom item's entry untouched", async () => {
    const { instance, saved } = makePlugin([
      { name: "keep-me", path: "notes/keep.json", type: "file", devices: "all" },
      { name: "drop-me", path: "notes/drop.json", type: "file", devices: "all" },
    ]);
    await instance.loadSettings();
    await instance.recompile();

    await instance.stopSyncing("drop-me", false);

    expect(Object.keys(instance.settings.items.custom)).toEqual(["keep-me"]);
    expect(savedCustomNames(saved())).toEqual(["keep-me"]);
  });
});

// A custom item's device class lives on its file rule, not on a `runsOn`
// field — the same field a registry item's Settings-sync
// control writes. manifest.ts refuses a `fileRule` on a folder group, so a folder's class is
// elevated into the compiled group's `devices` instead of emitted as a rule.
describe("a custom folder item's device class survives item -> compiled group -> item", () => {
  const EMPTY_ENV: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };

  it("round-trips unchanged, and the compiled group carries devices with no fileRule key", () => {
    const item: Item = {
      synced: true,
      type: "folder",
      path: "notes/stuff",
      settingsFile: { mode: "plain", fileRule: { sharing: perClass("desktop"), encrypted: false }, rules: {}, perElement: {} },
    };
    const defs = buildItemDefs(EMPTY_ENV);
    const groups = compileItems(defs, { items: itemsIn({ custom: { "my-folder": item } }) });
    const compiled = groups.find((g) => g.name === "my-folder");

    expect(compiled?.devices).toBe("desktop");
    expect(compiled).not.toHaveProperty("fileRule");

    // Producer vs producer, both directions: customGroup (reached only through compileItems) and
    // its inverse customItemFromGroup agree with each other.
    expect(customItemFromGroup(compiled as SyncGroup)).toEqual(item);
  });
});
