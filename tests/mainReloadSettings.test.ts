import { describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import ConfigSyncPlugin from "../src/main";

import { Item, ItemMap } from "../src/core/registry";
import { Ledger, LEDGER_VERSION } from "../src/core/ledger";
import { itemsIn } from "./items";
import { perElementKeyFor } from "../src/core/switchList";
import { EVERYWHERE, perClass } from "../src/core/types";

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
function fakeApp(local: Map<string, string> = new Map()): unknown {
  return {
    // reloadSettings() re-keys this device's own two localStorage stores after the compile (spec
    // §4) — a fake App without them would fail on the read, not on anything this file is about.
    // Stateful so the re-key can be OBSERVED, not merely tolerated (see the compile-gate test).
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => {
      if (value === null || value === undefined) local.delete(key);
      else local.set(key, value as string);
    },
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

// A v3 document with the named sections filled; the rest come out empty.
function baseData(partial: Partial<Record<"obsidian" | "core" | "community" | "custom", Record<string, Item>>> = {}): unknown {
  return { schemaVersion: 3, items: itemsIn(partial), remotes: [], bratIndex: {} };
}

describe("ConfigSyncPlugin.reloadSettings — loadSettings() must be followed by recompile()", () => {
  it("loadSettings() alone leaves compiledGroups stale; reloadSettings() picks up the change", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      loadSettings: () => Promise<void>;
      recompile: () => Promise<boolean>;
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
    data = baseData({ community: { "config-sync": { synced: true } } });

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

    let data = baseData({ obsidian: { hotkeys: { synced: true } } });
    instance.loadData = async () => data;
    await instance.reloadSettings();
    const lastGood = instance.compiledGroups.map((g) => g.name);
    expect(lastGood).toContain("hotkeys");

    // Simulate a hand-edited (or a future UI bug's) data.json: appearance's custom path collides
    // with hotkeys' default path — compileItems must throw a CompileError.
    data = baseData({
      obsidian: {
        hotkeys: { synced: true },
        appearance: { synced: true, path: "{configDir}/hotkeys.json" },
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

// spec 2026-08-11-data-model-hardening.md §5.1, driven through the real load→save path: an older
// document must come back with the nested defaults filled in and everything it carried (known or
// not) still on it.
describe("ConfigSyncPlugin.loadSettings/saveSettings — nested defaults and an absent companions key", () => {
  interface LoadSaveSurface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    saveSettings: () => Promise<void>;
    settings: { runHistory: { maxDays: number; enabled: boolean }; items: ItemMap };
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
      schemaVersion: 3,
      items: itemsIn({}),
      remotes: [],
      bratIndex: {},
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

  // C-#54 phase 2 (spec 2026-08-11-v3-one-vocabulary-design.md §5): `companions: []` is no longer
  // written. It only ever persisted so a build that read `cfg.companions` unguarded could still
  // read our document, and no such build can read a v3 document at all — the version gate refuses
  // it. An absent key already means "no companion folders" everywhere it is read.
  it("does not write an empty companions list for an item that has no companion folders", async () => {
    const { instance, saved } = makeLoadSavePlugin(
      baseData({
        obsidian: {
          hotkeys: { synced: true },
          appearance: { synced: true, companions: [{ path: "{configDir}/themes", device: "all", enabled: true }] },
        },
      })
    );

    await instance.loadSettings();
    await instance.saveSettings();

    const items = saved()?.items as ItemMap;
    expect(items.obsidian.hotkeys).toEqual({ synced: true });
    expect(items.obsidian.appearance?.companions).toEqual([{ path: "{configDir}/themes", device: "all", enabled: true }]);
  });

  it("an item with no companions key at all loads and compiles exactly like one with an empty list", async () => {
    const { instance } = makeLoadSavePlugin(baseData({ obsidian: { hotkeys: { synced: true } } }));
    const compiled = instance as unknown as { recompile: () => Promise<boolean>; compiledGroups: { name: string }[] };

    await instance.loadSettings();
    await compiled.recompile();

    expect(compiled.compiledGroups.map((g) => g.name)).toEqual(["hotkeys"]);
  });

});

// spec 2026-08-11-data-model-hardening.md §3.2 (invariant II.2): the load path used to drop every
// stored rule value this build doesn't recognise and save immediately, so a rule written by a
// NEWER build became a deletion this device pushed to the whole fleet on its next capture. The
// value must now survive the load untouched, trigger no save, and simply be ignored at the point
// of use.
//
// The rule itself moved with the two-layer cutover (2026-08-12-enablement-two-layers-design.md
// §3.3): it lives on the carrier item's `perElement` map, and `asSharing` (enablementRules.ts) is
// what drops an unreadable one FROM THE READ. Both halves are asserted here through the real
// plugin — the surviving bytes, and the two readers that must not act on them.
describe("ConfigSyncPlugin.loadSettings — an unrecognised enablement rule survives and is ignored", () => {
  interface RuleSurface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    settings: { rootPath: string; items: ItemMap };
    enablementRuleFor: (list: string, elementId: string) => unknown;
    coreContext: () => Promise<{ switchExceptions: Record<string, string[]>; switchForceOff: Record<string, string[]> }>;
  }

  // The reserved key "" is perElementKeyFor("community-plugins") — asserted against the producer,
  // never spelled as a literal (spec §9 lesson 2).
  const carrierWithRules = (rules: Record<string, unknown>): ItemMap =>
    itemsIn({
      obsidian: {
        "community-plugins": {
          synced: true,
          settingsFile: { mode: "fields", rules: {}, perElement: { [perElementKeyFor("community-plugins")]: rules } },
        } as unknown as Item,
      },
      community: { futurist: { synced: true }, known: { synced: true } },
    });

  it("loads it unchanged with NO save, and neither reader acts on it", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as RuleSurface;
    instance.app = fakeApp();
    const stored = { futurist: { kind: "on-tuesdays" }, known: perClass("desktop") };
    instance.loadData = async () => ({ schemaVersion: 3, rootPath: "cs", items: carrierWithRules(stored), remotes: [] });
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    // No recompile(): manifest.ts's perElement validator rejects a sharing shape it does not know,
    // which is a SEPARATE seam from the two readers under test here (and one the migration task
    // owns) — this test is about loadSettings and the readers, not about compile validation.
    await instance.loadSettings();

    // storage is left exactly as found — the whole point: nothing to propagate as a deletion.
    expect(instance.settings.items.obsidian["community-plugins"]?.settingsFile?.perElement[perElementKeyFor("community-plugins")]).toEqual(stored);
    expect(saveCallCount).toBe(0);

    // ignored at the point of use: the row falls back to the default instead of showing it…
    expect(instance.enablementRuleFor("community-plugins", "futurist")).toEqual(EVERYWHERE);
    expect(instance.enablementRuleFor("community-plugins", "known")).toEqual(perClass("desktop"));
    // …and the mask never sees the id at all — an unknown rule must not become a forced on/off.
    const ctx = await instance.coreContext();
    expect(ctx.switchExceptions["community-plugins"] ?? []).not.toContain("futurist");
    expect(ctx.switchForceOff["community-plugins"] ?? []).not.toContain("futurist");
  });
});

// spec 2026-08-11-data-model-hardening.md §3.3 (invariant II.4): bratIndex is a REPLICATED
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
    settings: { bratIndex: Record<string, string> };
  }

  it("keeps the index it cannot verify and never calls saveData", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as BratSurface;
    instance.app = fakeApp(); // no live BRAT instance, and adapter.exists() is false → repos is []
    const index = { "my-beta-plugin": "owner/my-beta-plugin" };
    instance.loadData = async () => ({ schemaVersion: 3, items: itemsIn({}), remotes: [], bratIndex: index });
    let saveCallCount = 0;
    instance.saveData = async () => {
      saveCallCount += 1;
    };

    await instance.loadSettings();
    const stats = await instance.refreshBratIndex();

    expect(instance.settings.bratIndex).toEqual(index);
    expect(saveCallCount).toBe(0);
    expect(stats).toEqual({ resolved: 0, total: 0 });
  });
});

// Final-review I1. The §4 re-key keys every baseline against `compiledGroups`, so it must not run
// when the compile that produced that list FAILED: `lockRefFor([])` has no rule for a companion or a
// custom rule, so each of those baselines would land under `legacy/…` — and `rekeyLedger` would then
// stamp the ledger's new version, so the mistake is never retried. Every one of them would read as
// never-synced, whose default direction is APPLY. One illegal custom rule name is enough to get
// there, and all the user sees is a generic Notice.
describe("the baseline re-key runs only when the compile it keys against succeeded", () => {
  const BASELINES = "config-sync-baselines";
  const V1_LEDGER = JSON.stringify({ version: 1, groups: { themes: { store: "s", local: "l", at: "2026-08-11T00:00:00.000Z" } } });

  interface Surface {
    app: unknown;
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    recompile: () => Promise<boolean>;
    reloadSettings: () => Promise<void>;
    saveBaselines: (ledger: Ledger) => void;
    syncCenterHost: () => { computeStatuses: () => Promise<unknown> };
    compiledGroups: { name: string }[];
  }

  const makePlugin = (data: unknown, local: Map<string, string>): Surface => {
    const instance = new ConfigSyncPlugin({} as never, {} as never) as unknown as Surface;
    instance.app = fakeApp(local);
    instance.loadData = async () => data;
    instance.saveData = async () => undefined;
    return instance;
  };

  it("recompile answers false when a custom rule cannot compile, and the ledger is left retryable", async () => {
    const local = new Map([[BASELINES, V1_LEDGER]]);
    const instance = makePlugin(
      { schemaVersion: 3, items: itemsIn({ custom: { "bad name!": { synced: true, type: "file", path: "notes/x.json" } } }), remotes: [], bratIndex: {} },
      local
    );

    await instance.loadSettings();
    expect(await instance.recompile()).toBe(false);

    await instance.reloadSettings(); // the real seam: the caller gates the re-key on that answer
    expect(local.get(BASELINES)).toBe(V1_LEDGER); // untouched — still v1, still name-keyed, still retryable
  });

  // Final-review N1: the re-key was not the only writer that keys against `compiledGroups`. The
  // status path prunes the ledger against it too, so a failed compile made it persist an EMPTY one —
  // reaching I1's end state by a different road. Both preconditions now sit on saveBaselines, the
  // ONE writer every baseline write goes through.
  it("no baseline write survives a failed compile, whichever writer asks", async () => {
    const local = new Map([[BASELINES, V1_LEDGER]]);
    const instance = makePlugin(
      { schemaVersion: 3, items: itemsIn({ custom: { "bad name!": { synced: true, type: "file", path: "notes/x.json" } } }), remotes: [], bratIndex: {} },
      local
    );
    await instance.loadSettings();
    expect(await instance.recompile()).toBe(false);

    // The status path's own write — pruning against an empty compiled list, which keeps nothing.
    await instance.syncCenterHost().computeStatuses();

    expect(local.get(BASELINES)).toBe(V1_LEDGER); // not emptied, not re-shaped: exactly as found
  });

  // The second half, and the one that holds regardless of which writer runs first next time: a
  // writer that does not understand the file it is rewriting declines. A v1 ledger reached by any
  // path — including one where the re-key has not run yet — is left alone rather than overwritten in
  // a shape whose own reader would answer empty.
  it("declines to persist a ledger that is not the version this build writes", async () => {
    const local = new Map([[BASELINES, V1_LEDGER]]);
    const instance = makePlugin({ schemaVersion: 3, items: itemsIn({ obsidian: { hotkeys: { synced: true } } }), remotes: [], bratIndex: {} }, local);
    await instance.loadSettings();
    expect(await instance.recompile()).toBe(true); // the compile is fine — it is the LEDGER that is not ours

    instance.saveBaselines({ version: 1, items: { themes: { store: "s", local: "l", at: "t" } } });
    expect(local.get(BASELINES)).toBe(V1_LEDGER);

    instance.saveBaselines({ version: LEDGER_VERSION, items: {} }); // …and the current version still writes
    expect(local.get(BASELINES)).toBe(JSON.stringify({ version: LEDGER_VERSION, items: {} }));
  });

  it("recompile answers true on a good document, and the re-key then runs once", async () => {
    const local = new Map([[BASELINES, V1_LEDGER]]);
    const instance = makePlugin(
      { schemaVersion: 3, items: itemsIn({ obsidian: { appearance: { synced: true, companions: [{ path: "{configDir}/themes", device: "all", enabled: true }] } } }), remotes: [], bratIndex: {} },
      local
    );

    await instance.loadSettings();
    expect(await instance.recompile()).toBe(true);
    await instance.reloadSettings();

    const moved = JSON.parse(local.get(BASELINES) ?? "{}") as { version: number; items: Record<string, unknown> };
    expect(moved.version).toBe(2);
    // The companion resolved through the COMPILER, which is the whole reason the gate exists: the
    // closed legacy rules have no answer for a companion, so a failed compile would have filed this
    // under `legacy/themes` and stamped it permanent.
    expect(Object.keys(moved.items)).toEqual(["obsidian/appearance/themes"]);
  });
});
