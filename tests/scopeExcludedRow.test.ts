import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { GroupStatus } from "../src/core/status";
import { SyncGroup, RuleScope } from "../src/core/types";
import { Availability } from "../src/core/availability";
import { groupExcludedHere } from "../src/ui/panelModel";

// C-#24 root cause (ledger .superpowers/sdd/2026-08-06-c-livetest/issues.md): groupsForDevice
// (ConfigSyncCore.ts:138-140) drops a scope-mismatched group before statusForGroups ever runs —
// correct for capture/apply (comparing content across device classes is meaningless), but that
// same drop used to make computeStatuses (main.ts, SyncCenterHost) omit the group's status AND
// availability entirely, so SyncCenterView.rows()/familyGroups() never produced a row for it —
// the item was invisible, not merely mislabeled "In sync". This test drives the REAL plugin
// (main.ts has no dedicated test harness — mock-obsidian.ts stubs it to an empty class — so this
// builds the minimum fake `app` the way mainReloadSettings.test.ts does) through the actual
// syncCenterHost().computeStatuses() wiring to pin that a rule-excluded item now gets a row.
function fakeApp(): unknown {
  return {
    vault: {
      adapter: { exists: async () => false },
      configDir: "config-dir",
      on: () => ({}),
    },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { "config-sync": { id: "config-sync", name: "Config Sync", version: "1.0.0" } },
      enabledPlugins: new Set(["config-sync"]),
      plugins: {},
    },
    workspace: { getLeavesOfType: () => [] },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {},
  };
}

function baseData(items: Record<string, unknown>): unknown {
  return { schemaVersion: 2, items, remotes: [], bratPluginIndex: {} };
}

describe("SyncCenterHost.computeStatuses — a device-scope-excluded item still gets a row (C-#24)", () => {
  it("hotkeys scoped mobile-only on a desktop-class instance: still present, synthetic neutral status", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      loadSettings: () => Promise<void>;
      recompile: () => Promise<void>;
      syncCenterHost: () => {
        computeStatuses: () => Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
      };
    };
    instance.app = fakeApp();
    instance.loadData = async () =>
      baseData({
        hotkeys: { enabled: true, settingsFile: { fileRule: { scope: "mobile", encrypted: false }, mode: "plain", rules: {}, perItem: {} }, companions: [] },
      });
    await instance.loadSettings();
    await instance.recompile();

    const { groups, statuses, availability } = await instance.syncCenterHost().computeStatuses();

    const hotkeysGroup = groups.find((g) => g.name === "hotkeys");
    expect(hotkeysGroup).toBeDefined();
    expect(hotkeysGroup?.devices).toBe("mobile"); // the fact computeFateInput's excludedHere reads
    expect(statuses.find((s) => s.group === "hotkeys")).toEqual({ group: "hotkeys", state: "in-sync" });
    expect(availability["hotkeys"]).toBeDefined();
  });

  it("a non-excluded item (devices: all) is completely unaffected — real comparison still runs", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      loadSettings: () => Promise<void>;
      recompile: () => Promise<void>;
      syncCenterHost: () => {
        computeStatuses: () => Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
      };
    };
    instance.app = fakeApp();
    instance.loadData = async () => baseData({ hotkeys: { enabled: true, settingsFile: { mode: "plain", rules: {}, perItem: {} }, companions: [] } });
    await instance.loadSettings();
    await instance.recompile();

    const { groups, statuses } = await instance.syncCenterHost().computeStatuses();

    const hotkeysGroup = groups.find((g) => g.name === "hotkeys");
    expect(hotkeysGroup?.devices).toBe("all");
    // never-synced, not the synthetic "in-sync" excluded groups get — a real comparison ran.
    expect(statuses.find((s) => s.group === "hotkeys")?.state).toBe("no-settings");
  });

  // C-#24 fix round 2: the real Settings-sync menu write path (setItemFileScope), driven end to
  // end through saveSettings' own recompile — never a hand-built settings shape — feeding the
  // resulting compiled group straight into groupExcludedHere, the same call computeFateInput makes.
  it("the real setItemFileScope('hotkeys','mobile') write path compiles a group groupExcludedHere reads true", async () => {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as {
      app: unknown;
      loadData: () => Promise<unknown>;
      saveData: (d: unknown) => Promise<void>;
      loadSettings: () => Promise<void>;
      recompile: () => Promise<void>;
      setItemFileScope: (itemId: string, scope: Exclude<RuleScope, "local">) => Promise<void>;
      syncCenterHost: () => {
        computeStatuses: () => Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
      };
    };
    instance.app = fakeApp();
    instance.loadData = async () => baseData({ hotkeys: { enabled: true, settingsFile: { mode: "plain", rules: {}, perItem: {} }, companions: [] } });
    instance.saveData = async () => {};
    await instance.loadSettings();
    await instance.recompile();

    await instance.setItemFileScope("hotkeys", "mobile");

    const { groups } = await instance.syncCenterHost().computeStatuses();
    const hotkeysGroup = groups.find((g) => g.name === "hotkeys");
    expect(hotkeysGroup).toBeDefined();
    expect(groupExcludedHere(hotkeysGroup!, "desktop")).toBe(true);
  });
});

// C-#25/C-#26 (docs/superpowers/specs/2026-08-09-c-livetest-batch12-fields-honesty.md): the live
// repro was setItemFileScope resolving without error on a fields-mode item while persisting
// nothing (deriveMode stripped the just-written fileRule at the old main.ts:1350) — the item's
// card no longer offers that menu at all (SyncCenterView's renderSettingsSyncRow), but the API
// itself must also refuse the write outright rather than silently no-op for any other caller.
describe("setItemFileScope — fields-mode guard (C-#25) + write-back pruning (C-#26)", () => {
  type Harness = {
    app: unknown;
    settings: { items: Record<string, { settingsFile?: { fileRule?: { scope: string; encrypted: boolean } } }> };
    loadData: () => Promise<unknown>;
    saveData: (d: unknown) => Promise<void>;
    loadSettings: () => Promise<void>;
    recompile: () => Promise<void>;
    setItemFileScope: (itemId: string, scope: Exclude<RuleScope, "local">) => Promise<void>;
  };

  function harness(items: Record<string, unknown>): Harness {
    const plugin = new ConfigSyncPlugin({} as never, {} as never);
    const instance = plugin as unknown as Harness;
    instance.app = fakeApp();
    instance.loadData = async () => baseData(items);
    instance.saveData = async () => {};
    return instance;
  }

  it("throws (never silently no-ops) writing to a fields-mode item", async () => {
    const instance = harness({ hotkeys: { enabled: true, settingsFile: { mode: "fields", rules: { a: { scope: "all", encrypted: false } }, perItem: {} }, companions: [] } });
    await instance.loadSettings();
    await instance.recompile();

    await expect(instance.setItemFileScope("hotkeys", "desktop")).rejects.toThrow();
    // the field-rule content is untouched — the rejected write left no trace
    expect(instance.settings.items["hotkeys"]?.settingsFile?.fileRule).toBeUndefined();
  });

  it("plain-mode item: the write succeeds", async () => {
    const instance = harness({ hotkeys: { enabled: true, settingsFile: { mode: "plain", rules: {}, perItem: {} }, companions: [] } });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setItemFileScope("hotkeys", "desktop");

    expect(instance.settings.items["hotkeys"]?.settingsFile?.fileRule).toEqual({ scope: "desktop", encrypted: false });
  });

  it("desktop -> all round-trip prunes the fileRule and the settingsFile entirely (byte-clean)", async () => {
    const instance = harness({ hotkeys: { enabled: true, settingsFile: { mode: "plain", rules: {}, perItem: {} }, companions: [] } });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setItemFileScope("hotkeys", "desktop");
    expect(instance.settings.items["hotkeys"]?.settingsFile?.fileRule).toEqual({ scope: "desktop", encrypted: false });

    await instance.setItemFileScope("hotkeys", "all");
    expect(instance.settings.items["hotkeys"]?.settingsFile).toBeUndefined();
  });

  it("an encrypted fileRule survives a scope write instead of being pruned", async () => {
    const instance = harness({
      hotkeys: { enabled: true, settingsFile: { mode: "plain", rules: {}, perItem: {}, fileRule: { scope: "desktop", encrypted: true } }, companions: [] },
    });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setItemFileScope("hotkeys", "all");

    expect(instance.settings.items["hotkeys"]?.settingsFile?.fileRule).toEqual({ scope: "all", encrypted: true });
  });
});
