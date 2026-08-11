import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";

// Task-8 concern fix: the Advanced tab's "Custom rules"/"Discovered files" used to write through
// a session-only groupsIO path — a custom rule or an adopted discovered file survived within the
// current session but was lost on the next Obsidian restart/plugin reload, since nothing in
// settings.items recorded it. settings.customGroups (registry.ts's compileItems, main.ts's
// stopSyncing) is their durable home now.
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
    plugins: { manifests: {}, enabledPlugins: new Set<string>() },
    workspace: { getLeavesOfType: () => [] },
  };
}

interface CustomGroupData {
  name: string;
  path: string;
  type: "file" | "dir";
  devices: "all" | "desktop" | "mobile";
  origin?: "discovered";
}

function baseData(customGroups: CustomGroupData[]): unknown {
  return { schemaVersion: 2, items: {}, appJson: { mode: "fields" }, remotes: [], bratPluginIndex: {}, customGroups };
}

interface PluginTestSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<void>;
  stopSyncing: (groupName: string, deleteStore: boolean) => Promise<string[] | null>; // null = refused (spec 2026-08-11 §4.2b)
  settings: { customGroups: CustomGroupData[] };
  compiledGroups: { name: string }[];
}

function makePlugin(customGroups: CustomGroupData[]): { instance: PluginTestSurface; saved: () => unknown } {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as PluginTestSurface;
  instance.app = fakeApp();
  instance.loadData = async () => baseData(customGroups);
  let saved: unknown = null;
  instance.saveData = async (d: unknown) => {
    saved = d;
  };
  return { instance, saved: () => saved };
}

describe("settings.customGroups — settings round-trip (add -> serialize shape -> compile)", () => {
  it("a customGroups entry loaded from data.json round-trips into compiledGroups", async () => {
    const { instance } = makePlugin([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.settings.customGroups).toEqual([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]);
    const compiled = instance.compiledGroups.find((g) => g.name === "my-rule");
    expect(compiled).toBeDefined();
  });

  it("a discovered-file adoption (origin: \"discovered\") round-trips the same way", async () => {
    const { instance } = makePlugin([{ name: "a-discovered-file", path: "a-discovered-file.json", type: "file", devices: "all", origin: "discovered" }]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.compiledGroups.find((g) => g.name === "a-discovered-file")).toBeDefined();
  });
});

describe("stopSyncing — custom-group removal is durable (settings.customGroups), not session-only", () => {
  it("removes the custom group from settings.customGroups and persists it via saveData", async () => {
    const { instance, saved } = makePlugin([{ name: "my-rule", path: "notes/custom.json", type: "file", devices: "all" }]);
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.compiledGroups.map((g) => g.name)).toContain("my-rule");

    await instance.stopSyncing("my-rule", false);

    // In-memory settings no longer carry the removed rule...
    expect(instance.settings.customGroups).toEqual([]);
    // ...and the removal was actually persisted (saveData called with the updated settings), not
    // just held in memory for the rest of the session (the original defect).
    expect((saved() as { customGroups: CustomGroupData[] } | null)?.customGroups).toEqual([]);
    // ...and the recompile that follows saveSettings() drops it from the compiled list too.
    expect(instance.compiledGroups.map((g) => g.name)).not.toContain("my-rule");
  });

  it("leaves a different custom group's entry untouched", async () => {
    const { instance, saved } = makePlugin([
      { name: "keep-me", path: "notes/keep.json", type: "file", devices: "all" },
      { name: "drop-me", path: "notes/drop.json", type: "file", devices: "all" },
    ]);
    await instance.loadSettings();
    await instance.recompile();

    await instance.stopSyncing("drop-me", false);

    expect(instance.settings.customGroups.map((g) => g.name)).toEqual(["keep-me"]);
    expect((saved() as { customGroups: CustomGroupData[] } | null)?.customGroups.map((g) => g.name)).toEqual(["keep-me"]);
  });
});
