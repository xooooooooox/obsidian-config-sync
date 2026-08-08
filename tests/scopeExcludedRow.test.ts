import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { GroupStatus } from "../src/core/status";
import { SyncGroup } from "../src/core/types";
import { Availability } from "../src/core/availability";

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
});
