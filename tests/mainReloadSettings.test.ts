import { describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import ConfigSyncPlugin from "../src/main";

// The real "obsidian" package's Notice type (which tsc's build gate type-checks against, unlike
// vitest's aliased tests/mock-obsidian.ts) has no `lastMessage` — this cast reaches the mock's
// test-only static capture without lying about the real API surface anywhere else.
const NoticeSpy = Notice as unknown as { lastMessage: string | undefined };

// Review finding 1 (Task 4 fix round 1): adoptConfiguration and applyItems (main.ts) both call
// loadSettings() after a self-group apply rewrites the plugin's own data.json, but never
// recompiled — compiledGroups stayed stale until an unrelated save/restart. The fix routes both
// call sites through a new private reloadSettings() = loadSettings() + recompile().
//
// main.ts has no existing test harness (it extends Obsidian's real Plugin, which the vitest mock
// — tests/mock-obsidian.ts — deliberately stubs to an empty class since "no test drives these
// components"). This test builds the minimum fake `app`/`loadData` needed to exercise
// loadSettings/recompile/reloadSettings directly on a real ConfigSyncPlugin instance, via bracket
// access to bypass TypeScript's `private` (a compile-time-only restriction) — it is a real
// regression test, not a mock of the behavior under test: reverting reloadSettings() back to
// loadSettings()-only during development made it fail (see fix-round-1 report).
function fakeApp(): unknown {
  return {
    vault: {
      adapter: { exists: async () => false },
      configDir: "config-dir", // deliberately not ".obsidian" — obsidianmd/hardcoded-config-path; the value is irrelevant here (no core/community plugin paths are touched)
      on: () => ({}),
    },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { "config-sync": { id: "config-sync", name: "Config Sync", version: "1.0.0" } },
      enabledPlugins: new Set(["config-sync"]),
    },
    workspace: { getLeavesOfType: () => [] },
  };
}

function baseData(items: Record<string, unknown>): unknown {
  return { schemaVersion: 2, items, remotes: [], bratPluginIndex: {} };
}

describe("ConfigSyncPlugin.reloadSettings — loadSettings() must be followed by recompile()", () => {
  it("loadSettings() alone leaves compiledGroups stale; reloadSettings() picks up the change", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      loadSettings: () => Promise<void>;
      recompile: () => Promise<void>;
      reloadSettings: () => Promise<void>;
      compiledGroups: { name: string }[];
    };
    instance.app = fakeApp();

    let data = baseData({});
    instance.loadData = async () => data;
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.compiledGroups).toEqual([]);

    // Simulate a self-group apply rewriting this plugin's own data.json externally (the scenario
    // in adoptConfiguration/applyItems): the self item is now enabled.
    data = baseData({ "community:config-sync": { enabled: true, companions: [] } });

    // loadSettings() alone must NOT update compiledGroups — this is exactly the bug: the sync
    // list stays stale until an unrelated saveSettings() or a restart.
    await instance.loadSettings();
    expect(instance.compiledGroups).toEqual([]);

    // reloadSettings() (now used by both adoptConfiguration and applyItems) must recompile too.
    await instance.reloadSettings();
    expect(instance.compiledGroups.map((g) => g.name)).toContain("plugin-config-sync");
  });
});

// Final-review defense-in-depth / seam test 3: recompile()'s catch branch must keep whatever
// compiledGroups held before the failing recompile (mid-session, that's the last-good compiled
// list — never wiped to reflect the bad in-flight edit) and its Notice must name the offending
// group/item and the reason, not a generic line.
describe("ConfigSyncPlugin.recompile — keeps last-good compiledGroups on a mid-session failure (final-review defense-in-depth)", () => {
  it("a CompileError from a colliding custom path leaves the previous compiledGroups untouched and names the offending items in the Notice", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      reloadSettings: () => Promise<void>;
      compiledGroups: { name: string }[];
    };
    instance.app = fakeApp();

    let data = baseData({ hotkeys: { enabled: true, companions: [] } });
    instance.loadData = async () => data;
    await instance.reloadSettings();
    const lastGood = instance.compiledGroups.map((g) => g.name);
    expect(lastGood).toContain("hotkeys");

    // Simulate a hand-edited (or a future UI bug's) data.json: appearance's custom path collides
    // with hotkeys' default path — compileItems must throw a CompileError.
    data = baseData({
      hotkeys: { enabled: true, companions: [] },
      appearance: {
        enabled: true,
        companions: [],
        settingsFile: { mode: "plain", rules: {}, perItem: {}, customPath: "{configDir}/hotkeys.json" },
      },
    });
    NoticeSpy.lastMessage = undefined;
    await instance.reloadSettings();

    // last-good retained, NOT wiped to [] or partially overwritten.
    expect(instance.compiledGroups.map((g) => g.name)).toEqual(lastGood);
    // the Notice names both offending items, not a generic "invalid configuration" line.
    expect(NoticeSpy.lastMessage).toBeDefined();
    expect(NoticeSpy.lastMessage).toContain("hotkeys");
    expect(NoticeSpy.lastMessage).toContain("appearance");
  });
});

// mergeLegacyAppSliceItems (settingsMigration.ts) is unit-tested directly, but its wiring into
// ConfigSyncPlugin.loadSettings() (`if (mergeLegacyAppSliceItems(this.settings)) await
// this.saveSettings();`) had no test driving the real load path — this exercises loadSettings()
// on a fixture data.json that still carries the pre-merge legacy shape (a v2-internal shape
// revision, not the schema v1→v2 gate covered above) and asserts the merge actually lands and is
// persisted exactly once, the same idiom tests/customGroups.test.ts (~lines 42-91) uses for
// stubbing saveData on the fake plugin.
function legacyAppSliceData(): unknown {
  return {
    schemaVersion: 2,
    items: {
      editor: {
        enabled: true,
        companions: [],
        settingsFile: { mode: "fields", rules: { foldHeading: { scope: "all", encrypted: false } }, perItem: {} },
      },
    },
    appJson: { mode: "plain" },
    remotes: [],
    bratPluginIndex: {},
  };
}

describe("ConfigSyncPlugin.loadSettings — mergeLegacyAppSliceItems wiring (end-to-end)", () => {
  it("merges legacy items.editor + appJson into items.app and persists the merge via saveData exactly once", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      saveData: (d: unknown) => Promise<void>;
      loadSettings: () => Promise<void>;
      settings: {
        items: Record<
          string,
          {
            enabled: boolean;
            settingsFile?: { mode: string; rules: Record<string, unknown>; perItem: Record<string, unknown> };
          }
        >;
        appJson?: unknown;
      };
    };
    instance.app = fakeApp();
    instance.loadData = async () => legacyAppSliceData();
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    await instance.loadSettings();

    const appItem = instance.settings.items["app"];
    expect(appItem).toBeDefined();
    expect(appItem?.settingsFile?.rules["foldHeading"]).toEqual({ scope: "all", encrypted: false });
    expect(appItem?.settingsFile?.mode).toBe("plain");
    // legacy keys are gone, not just shadowed by the merged "app" item.
    expect(instance.settings.items["editor"]).toBeUndefined();
    expect(instance.settings.appJson).toBeUndefined();
    // the merge is persisted through the real saveSettings() -> saveData() path exactly once —
    // not left in memory only, and not saved more than once.
    expect(saveCallCount).toBe(1);
  });
});

// Task 3 (spec 2026-08-04-per-device-scope-local-containment-design.md): drainEnabledOnLocal
// (settingsMigration.ts) is unit-tested directly, but its wiring into loadSettings() (`if
// (drainEnabledOnLocal(this.settings)) await this.saveSettings();`) had no test driving the real
// load path — same idiom as the mergeLegacyAppSliceItems wiring test above.
describe("ConfigSyncPlugin.loadSettings — drainEnabledOnLocal wiring (end-to-end)", () => {
  it("drains a stored enabledOn:'local' into localMembers and persists the drain via saveData exactly once", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      saveData: (d: unknown) => Promise<void>;
      loadSettings: () => Promise<void>;
      settings: { items: Record<string, { enabled: boolean; enabledOn?: string }>; localMembers: string[] };
    };
    instance.app = fakeApp();
    instance.loadData = async () => baseData({ "community:config-sync": { enabled: true, enabledOn: "local", companions: [] } });
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    await instance.loadSettings();

    expect(instance.settings.localMembers).toEqual(["community:config-sync"]);
    expect(instance.settings.items["community:config-sync"]?.enabledOn).toBeUndefined();
    // persisted through the real saveSettings() -> saveData() path exactly once.
    expect(saveCallCount).toBe(1);
  });
});

// A self-apply (adoptConfiguration/applyItems, main.ts ~625-670) rewrites this plugin's own
// data.json externally and then calls the private reloadSettings() = loadSettings() + recompile()
// to pick it up. reloadSettings() has no logic of its own beyond that delegation, so wiring the
// drain into loadSettings() already covers the adopt path — this end-to-end test proves a
// freshly-adopted foreign enabledOn:"local" is drained on the very next reloadSettings(), rather
// than round-tripping back out to the shared contract on the next save.
describe("ConfigSyncPlugin.reloadSettings — drains a freshly-adopted enabledOn:'local' (adopt path)", () => {
  it("drains the id adopted from a foreign data.json instead of re-capturing it", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      saveData: (d: unknown) => Promise<void>;
      reloadSettings: () => Promise<void>;
      settings: { items: Record<string, { enabled: boolean; enabledOn?: string }>; localMembers: string[] };
    };
    instance.app = fakeApp();
    instance.loadData = async () => baseData({});
    instance.saveData = async () => {};
    await instance.reloadSettings();
    expect(instance.settings.localMembers).toEqual([]);

    // Simulate applyWithActions rewriting this plugin's own data.json externally after an adopt —
    // the foreign contract's enabledOn:"local" lands on disk exactly as the old form wrote it.
    instance.loadData = async () => baseData({ "community:config-sync": { enabled: true, enabledOn: "local", companions: [] } });
    await instance.reloadSettings();

    expect(instance.settings.localMembers).toEqual(["community:config-sync"]);
    expect(instance.settings.items["community:config-sync"]?.enabledOn).toBeUndefined();
  });
});
