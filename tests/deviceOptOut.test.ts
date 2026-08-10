import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { MemFS } from "./memfs";
import { GroupResult, SyncGroup } from "../src/core/types";
import { GroupStatus } from "../src/core/status";
import { Availability } from "../src/core/availability";
import { CaptureItem, ApplyItem } from "../src/core/ConfigSyncCore";

// C-#45 (spec 2026-08-10-c-livetest-batch22-device-optout.md): per-device item opt-out via the
// Stop-syncing menu's "On this device". main.ts has no dedicated test harness (Plugin is stubbed
// to an empty class by tests/mock-obsidian.ts) — these build a real ConfigSyncPlugin instance the
// same way tests/customGroups.test.ts / tests/scopeExcludedRow.test.ts / tests/lockLabelHeal.test.ts
// already do, via bracket access to bypass TypeScript's `private` (compile-time-only).
//
// Fix-round 1 (reviewer-caught CRITICAL): the device identity lives in localStorage, NEVER
// data.json (main.ts's deviceId() method) — data.json travels wholesale (git-tracked vaults,
// remotely-save, manual copies), so a value trusted from an inherited data.json would let a
// bootstrapped machine silently claim the source machine's identity. A stateful in-memory
// loadLocalStorage/saveLocalStorage pair (below) is what lets these tests both seed a KNOWN
// "this device" id per test and prove a real generate-then-persist round-trip.

function makeLocalStorage(seed: Record<string, string> = {}): {
  loadLocalStorage: (key: string) => unknown;
  saveLocalStorage: (key: string, value: unknown) => void;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    loadLocalStorage: (key) => store.get(key) ?? null,
    saveLocalStorage: (key, value) => {
      if (value === null || value === undefined) store.delete(key);
      else store.set(key, value as string);
    },
  };
}

function fakeApp(deviceId?: string): unknown {
  return {
    vault: { adapter: { exists: async () => false }, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { "config-sync": { id: "config-sync", name: "Config Sync", version: "1.0.0" } },
      enabledPlugins: new Set(["config-sync"]),
      plugins: {},
    },
    workspace: { getLeavesOfType: () => [] },
    ...makeLocalStorage(deviceId !== undefined ? { "config-sync-device-id": deviceId } : {}),
  };
}

function baseData(items: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 2, items, remotes: [], bratPluginIndex: {}, ...extra };
}

interface Surface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<void>;
  setDeviceOptOut: (groupName: string, on: boolean) => Promise<void>;
  settings: { deviceOptOuts: Record<string, string[]> };
  syncCenterHost: () => {
    computeStatuses: () => Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
    deviceOptedOut: (groupName: string) => boolean;
  };
}

// deviceId: the KNOWN "this device" id to seed into localStorage — undefined lets the plugin
// generate its own fresh one (proving the generate-and-persist path), a string pins it so a test
// can assert exactly which id lands in deviceOptOuts.
function makePlugin(
  items: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  deviceId?: string
): { instance: Surface; saved: () => unknown } {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as Surface;
  instance.app = fakeApp(deviceId);
  instance.loadData = async () => baseData(items, extra);
  let saved: unknown = null;
  instance.saveData = async (d: unknown) => {
    saved = d;
  };
  return { instance, saved: () => saved };
}

describe("setDeviceOptOut / deviceOptedOut — round-trip + C-#26 prune discipline (C-#45)", () => {
  it("set true persists and reads back true, keyed by the localStorage-generated device id", async () => {
    const { instance, saved } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);

    await instance.setDeviceOptOut("hotkeys", true);

    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(true);
    expect(instance.settings.deviceOptOuts).toEqual({ hotkeys: ["d1"] });
    expect((saved() as { deviceOptOuts: Record<string, string[]> } | null)?.deviceOptOuts).toEqual({ hotkeys: ["d1"] });
    // the id itself never lands in the persisted settings document — only deviceOptOuts does.
    expect(saved()).not.toHaveProperty("deviceId");
  });

  it("with no seeded localStorage id, the plugin generates and persists its own — never empty", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", true);

    const ids = instance.settings.deviceOptOuts.hotkeys ?? [];
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe("");
  });

  it("set true then false round-trips byte-clean — the last id removed prunes the group's key entirely", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", true);
    expect(instance.settings.deviceOptOuts).toEqual({ hotkeys: ["d1"] });

    await instance.setDeviceOptOut("hotkeys", false);
    expect(instance.settings.deviceOptOuts).toEqual({});
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);
  });

  it("clearing when never set is a no-op (still no deviceOptOuts key)", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", false);
    expect(instance.settings.deviceOptOuts).toEqual({});
  });
});

describe("deviceOptOuts — fleet-shared shape (C-#45 spec §5)", () => {
  it("another device's key survives a local set/clear untouched", async () => {
    const { instance } = makePlugin(
      { hotkeys: { enabled: true, companions: [] } },
      { deviceOptOuts: { hotkeys: ["other-device"] } },
      "this-device"
    );
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", true);
    expect([...instance.settings.deviceOptOuts.hotkeys!].sort()).toEqual(["other-device", "this-device"]);

    await instance.setDeviceOptOut("hotkeys", false);
    expect(instance.settings.deviceOptOuts).toEqual({ hotkeys: ["other-device"] });
  });

  it("a set on a DIFFERENT group never touches another group's opt-outs", async () => {
    const { instance } = makePlugin(
      { hotkeys: { enabled: true, companions: [] }, appearance: { enabled: true, companions: [] } },
      { deviceOptOuts: { hotkeys: ["other-device"] } },
      "this-device"
    );
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("appearance", true);

    expect(instance.settings.deviceOptOuts).toEqual({ hotkeys: ["other-device"], appearance: ["this-device"] });
  });

  it("a data.json copied wholesale from another machine (e.g. a bootstrapped vault) never inherits its deviceOptOuts membership", async () => {
    // No localStorage seed at all here — simulates a fresh machine that received this data.json
    // via git/remotely-save/manual copy but has never run this plugin before; deviceOptOuts
    // already marks SOME device (from the source machine) as opted out of "hotkeys".
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, { deviceOptOuts: { hotkeys: ["source-machine"] } });
    await instance.loadSettings();
    await instance.recompile();

    // The fresh machine is NOT opted out — it has its own, freshly-generated, different id.
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);
  });
});

describe("SyncCenterHost.computeStatuses — a device-opted-out item still gets a row (C-#45)", () => {
  it("hotkeys opted out on THIS device: still present, synthetic neutral status, deviceOptedOut true", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, { deviceOptOuts: { hotkeys: ["d1"] } }, "d1");
    await instance.loadSettings();
    await instance.recompile();

    const host = instance.syncCenterHost();
    const { groups, statuses } = await host.computeStatuses();

    expect(groups.find((g) => g.name === "hotkeys")).toBeDefined();
    expect(statuses.find((s) => s.group === "hotkeys")).toEqual({ group: "hotkeys", state: "in-sync" });
    expect(host.deviceOptedOut("hotkeys")).toBe(true);
  });

  it("hotkeys opted out on a DIFFERENT device: this device runs a real comparison, unaffected", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, { deviceOptOuts: { hotkeys: ["other-device"] } }, "d1");
    await instance.loadSettings();
    await instance.recompile();

    const host = instance.syncCenterHost();
    const { statuses } = await host.computeStatuses();

    expect(statuses.find((s) => s.group === "hotkeys")?.state).toBe("no-settings"); // real comparison ran
    expect(host.deviceOptedOut("hotkeys")).toBe(false);
  });

  it("a non-opted-out item is completely unaffected — real comparison still runs", async () => {
    const { instance } = makePlugin({ hotkeys: { enabled: true, companions: [] } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    const { statuses } = await instance.syncCenterHost().computeStatuses();
    expect(statuses.find((s) => s.group === "hotkeys")?.state).toBe("no-settings");
  });
});

// Runner-level payload guard (spec §4): captureItems/applyItems must skip an opted-out group EVEN
// GIVEN an explicit stale selection naming it — the guard lives below the UI's own stageable:false,
// at the host boundary itself. Full local/store file IO (mirrors tests/lockLabelHeal.test.ts).
interface IoSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<void>;
  setDeviceOptOut: (groupName: string, on: boolean) => Promise<void>;
  settings: { deviceOptOuts: Record<string, string[]>; rootPath: string };
  syncCenterHost: () => {
    captureItems: (items: CaptureItem[]) => Promise<GroupResult[] | null>;
    applyItems: (items: ApplyItem[]) => Promise<GroupResult[] | null>;
  };
}

function makeIoPlugin(io: MemFS): IoSurface {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as IoSurface;
  instance.app = {
    vault: { adapter: io, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { demo: { id: "demo", name: "Demo Plugin", version: "1.0.0" } },
      enabledPlugins: new Set(["demo"]),
      plugins: {},
      disablePlugin: async () => {},
      enablePlugin: async () => {},
      enablePluginAndSave: async () => {},
      loadManifests: async () => {},
    },
    workspace: { getLeavesOfType: () => [] },
    ...makeLocalStorage({ "config-sync-device-id": "d1" }),
  };
  instance.loadData = async () => baseData({ "community:demo": { enabled: true, companions: [] } });
  instance.saveData = async () => {};
  return instance;
}

describe("captureItems/applyItems — runner-level opted-out guard (C-#45 spec §4)", () => {
  it("capture skips an opted-out group's content even when explicitly named in the payload", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
    });
    const plugin = makeIoPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";
    await plugin.recompile();
    await plugin.setDeviceOptOut("plugin-demo", true);

    // A stale selection: explicitly names the opted-out group, exactly as if a leftover checkbox
    // state or a caller bypassing the UI's own stageable:false had sneaked it into the payload.
    await plugin.syncCenterHost().captureItems([{ name: "plugin-demo", action: "none" }]);

    // capture never reads: the store copy is untouched (still the pre-existing content, not the
    // local content a real capture would have copied over).
    expect(await io.read("cs/store/configdir/plugins/demo/data.json")).toBe(JSON.stringify({ store: true }));
  });

  it("apply skips an opted-out group's content even when explicitly named in the payload", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
    });
    const plugin = makeIoPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";
    await plugin.recompile();
    await plugin.setDeviceOptOut("plugin-demo", true);

    await plugin.syncCenterHost().applyItems([{ name: "plugin-demo", action: "none" }]);

    // apply never installs/writes: the local file is untouched (still the pre-existing content,
    // not the store content a real apply would have written).
    expect(await io.read("config-dir/plugins/demo/data.json")).toBe(JSON.stringify({ local: true }));
  });

  it("a non-opted-out group in the same payload still runs normally", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
    });
    const plugin = makeIoPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";
    await plugin.recompile();
    // No opt-out set this time — a plain apply should still copy the store content over.
    await plugin.syncCenterHost().applyItems([{ name: "plugin-demo", action: "none" }]);

    expect(await io.read("config-dir/plugins/demo/data.json")).toBe(JSON.stringify({ store: true }));
  });
});
