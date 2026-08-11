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
      plugins: {}, // live instances — empty: no BRAT here (see the refreshBratIndex test below)
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

// spec 2026-08-11-data-model-hardening.md §5.1/§5.2, driven through the real load→save path: an
// older document must come back with the nested defaults filled in, everything it carried (known
// or not) still on it — and its `companions: []` still on it too, since §5.2 phase 1 changed only
// what this build READS.
describe("ConfigSyncPlugin.loadSettings/saveSettings — nested defaults and companions tolerance", () => {
  interface LoadSaveSurface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    saveSettings: () => Promise<void>;
    settings: { runHistory: { maxDays: number; enabled: boolean }; items: Record<string, { enabled: boolean; companions?: unknown[] }> };
  }

  function makeLoadSavePlugin(data: unknown): { instance: LoadSaveSurface; saved: () => Record<string, unknown> | null } {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as LoadSaveSurface;
    instance.app = fakeApp();
    instance.loadData = async () => data;
    let saved: Record<string, unknown> | null = null;
    instance.saveData = async (d: unknown) => {
      saved = d as Record<string, unknown>;
    };
    return { instance, saved: () => saved };
  }

  it("fills a nested default an older document never had, and carries its unknown keys through the save", async () => {
    const { instance, saved } = makeLoadSavePlugin({
      schemaVersion: 2,
      items: {},
      remotes: [],
      bratPluginIndex: {},
      runHistory: { enabled: false, path: "", maxCount: 5 }, // written before maxDays existed
      writtenByANewerBuild: { keep: true },
    });

    await instance.loadSettings();
    expect(instance.settings.runHistory.maxDays).toBe(30);
    expect(instance.settings.runHistory.enabled).toBe(false);

    await instance.saveSettings();
    expect(saved()?.writtenByANewerBuild).toEqual({ keep: true });
    expect((saved()?.runHistory as { maxDays: number }).maxDays).toBe(30);
  });

  // Removing a field is a TWO-PHASE change and this release is phase one. A build that still
  // reads `cfg.companions` unguarded (compileCompanions / parentCardLabel / buildCompanionRows at
  // 2.20.0) throws on a document without the key, so dropping it here would destroy an un-updated
  // device with something it cannot read — the very thing invariant II exists to prevent. Phase 2
  // stops writing it once a tolerant build is the fleet's floor.
  it("still writes an item's empty companions list, byte-for-byte as today", async () => {
    const { instance, saved } = makeLoadSavePlugin(
      baseData({
        hotkeys: { enabled: true, companions: [] }, // what every older document looks like
        appearance: { enabled: true, companions: [{ path: "{configDir}/themes", scope: "all", enabled: true }] },
      })
    );

    await instance.loadSettings();
    await instance.saveSettings();

    const items = saved()?.items as Record<string, Record<string, unknown>>;
    expect(items.hotkeys).toEqual({ enabled: true, companions: [] });
    expect(items.appearance?.companions).toEqual([{ path: "{configDir}/themes", scope: "all", enabled: true }]);
  });

  it("an item with no companions key at all loads and compiles exactly like one with an empty list", async () => {
    const { instance } = makeLoadSavePlugin(baseData({ hotkeys: { enabled: true } }));
    const compiled = instance as unknown as { recompile: () => Promise<void>; compiledGroups: { name: string }[] };

    await instance.loadSettings();
    await compiled.recompile();

    expect(compiled.compiledGroups.map((g) => g.name)).toEqual(["hotkeys"]);
  });

  // THE phase-1 invariant, end to end: an entry this build creates from scratch must be readable
  // by a build that doesn't tolerate an absent `companions`. This is the case a lean
  // emptyItemConfig() leaks through — if someone re-prunes the write side later, this fails first.
  it("enabling an item for the FIRST time persists companions: [] — a brand-new entry stays readable by an older build", async () => {
    const { instance, saved } = makeLoadSavePlugin(baseData({}));
    const host = instance as unknown as { setItemSyncEnabled: (id: string, on: boolean) => Promise<void> };

    await instance.loadSettings();
    await host.setItemSyncEnabled("community:demo", true);

    const items = saved()?.items as Record<string, Record<string, unknown>>;
    expect(items["community:demo"]).toEqual({ enabled: true, companions: [] });
  });

  // Same guarantee for an entry that ARRIVED without the key (a hand edit, or a document from the
  // phase-2 build that stops writing it): the first write here heals it rather than passing the
  // unreadable shape on.
  it("a write to an entry that arrived without the key puts it back", async () => {
    const { instance, saved } = makeLoadSavePlugin(baseData({ hotkeys: { enabled: false } }));
    const host = instance as unknown as { setItemSyncEnabled: (id: string, on: boolean) => Promise<void> };

    await instance.loadSettings();
    await host.setItemSyncEnabled("hotkeys", true);

    const items = saved()?.items as Record<string, Record<string, unknown>>;
    expect(items.hotkeys).toEqual({ enabled: true, companions: [] });
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

// spec 2026-08-11-data-model-hardening.md §3.2 (invariant II.2), replacing sanitizeMemberRules'
// unit tests: the load path used to drop every memberRules value this build doesn't recognise and
// save immediately, so a rule written by a NEWER build became a deletion this device pushed to the
// whole fleet on its next capture. The value must now survive the load untouched, trigger no save,
// and simply be ignored by the two readers.
describe("ConfigSyncPlugin.loadSettings — an unrecognised memberRules value survives and is ignored", () => {
  interface MemberRulesSurface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    settings: { memberRules: Record<string, string> };
    memberRuleFor: (carrier: "core-plugins" | "community-plugins", elementId: string, locallyOn: boolean) => string;
    memberRulesFor: (carrier: "core-plugins.json" | "community-plugins.json") => Record<string, string>;
  }

  it("loads it unchanged with NO save, and neither reader acts on it", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as MemberRulesSurface;
    instance.app = fakeApp();
    instance.loadData = async () => ({
      schemaVersion: 2,
      items: {},
      remotes: [],
      bratPluginIndex: {},
      memberRules: { "community:futurist": "here-on-tuesdays", "community:known": "always-here" },
    });
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    await instance.loadSettings();

    // storage is left exactly as found — the whole point: nothing to propagate as a deletion.
    expect(instance.settings.memberRules).toEqual({ "community:futurist": "here-on-tuesdays", "community:known": "always-here" });
    expect(saveCallCount).toBe(0);

    // ignored at the point of use: the menu falls back to its default instead of showing it, and
    // the apply mask never sees the id at all — an unknown rule must not become a forced on/off.
    expect(instance.memberRuleFor("community-plugins", "futurist", true)).toBe("all");
    expect(instance.memberRuleFor("community-plugins", "known", false)).toBe("always-here");
    expect(instance.memberRulesFor("community-plugins.json")).toEqual({ known: "always-here" });
  });
});

// spec 2026-08-11-data-model-hardening.md §3.3 (invariant II.4): bratPluginIndex is a REPLICATED
// index — a device without BRAT still needs it to install beta plugins. resolveBratIndex prunes
// against THIS device's repo list, so on a device with no list at all the refresh used to save an
// emptied index: a fleet-shared structure wiped by the device that knows least about it.
describe("ConfigSyncPlugin.refreshBratIndex — a device with no BRAT repo list writes nothing", () => {
  interface BratSurface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    refreshBratIndex: () => Promise<{ resolved: number; total: number }>;
    settings: { bratPluginIndex: Record<string, string> };
  }

  it("keeps the index it cannot verify and never calls saveData", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as BratSurface;
    instance.app = fakeApp(); // no live BRAT instance, and adapter.exists() is false → repos is []
    const index = { "my-beta-plugin": "owner/my-beta-plugin" };
    instance.loadData = async () => ({ schemaVersion: 2, items: {}, remotes: [], bratPluginIndex: index });
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    await instance.loadSettings();
    const stats = await instance.refreshBratIndex();

    expect(instance.settings.bratPluginIndex).toEqual(index);
    expect(saveCallCount).toBe(0);
    expect(stats).toEqual({ resolved: 0, total: 0 });
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
