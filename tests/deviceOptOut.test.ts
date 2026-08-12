import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { MemFS } from "./memfs";
import { GroupResult, SyncGroup } from "../src/core/types";
import { GroupStatus } from "../src/core/status";
import { Availability } from "../src/core/availability";
import { CaptureItem, ApplyItem } from "../src/core/ConfigSyncCore";
import { Item } from "../src/core/registry";
import { itemsIn } from "./items";

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
//
// C-#52 (spec 2026-08-11-data-model-hardening.md §2): the opt-out ITSELF moved into that same
// store, under "config-sync-device-optouts" as a JSON array of ITEM REFS (spec §4 re-keyed it from
// group names, together with the lock and the baselines — one key space) — that list is the
// AUTHORITY every read goes through. The old `deviceOptOuts` map is not deleted from data.json
// though (the §2 ruling): removing a field is two-phase, and a document written without it, once
// adopted by a device still on the old build, takes THAT device's opt-out with it — C-#52's own
// failure inflicted by C-#52's fix. So the map is carried, other devices' entries are never
// touched, and this device's entry in it is kept in step with localStorage.

const OPTOUTS_KEY = "config-sync-device-optouts";

function makeLocalStorage(seed: Record<string, string>): {
  store: Map<string, string>;
  api: { loadLocalStorage: (key: string) => unknown; saveLocalStorage: (key: string, value: unknown) => void };
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    api: {
      loadLocalStorage: (key) => store.get(key) ?? null,
      saveLocalStorage: (key, value) => {
        if (value === null || value === undefined) store.delete(key);
        else store.set(key, value as string);
      },
    },
  };
}

function fakeApp(localStorageApi: object): unknown {
  return {
    vault: { adapter: { exists: async () => false }, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { "config-sync": { id: "config-sync", name: "Config Sync", version: "1.0.0" } },
      enabledPlugins: new Set(["config-sync"]),
      plugins: {},
    },
    workspace: { getLeavesOfType: () => [] },
    ...localStorageApi,
  };
}

function baseData(items: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 3, items: itemsIn({ obsidian: items as Record<string, Item> }), remotes: [], bratIndex: {}, ...extra };
}

interface Surface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  rekeyDeviceStores: () => void;
  setDeviceOptOut: (groupName: string, on: boolean) => Promise<void>;
  syncCenterHost: () => {
    computeStatuses: () => Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
    deviceOptedOut: (groupName: string) => boolean;
  };
}

// deviceId: the KNOWN "this device" id to seed into localStorage — undefined lets the plugin
// generate its own fresh one (proving the generate-and-persist path), a string pins it so a test
// can say which id the legacy map must attribute to this device. `local` reads the same
// localStorage the plugin writes, so the opt-out list can be asserted at its real home.
function makePlugin(
  items: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  deviceId?: string,
  localSeed: Record<string, string> = {}
): { instance: Surface; saved: () => unknown; saveCount: () => number; local: (key: string) => string | undefined } {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as Surface;
  const ls = makeLocalStorage(deviceId !== undefined ? { "config-sync-device-id": deviceId, ...localSeed } : localSeed);
  instance.app = fakeApp(ls.api);
  instance.loadData = async () => baseData(items, extra);
  let saved: unknown = null;
  let saves = 0;
  instance.saveData = async (d: unknown) => {
    saved = d;
    saves += 1;
  };
  return { instance, saved: () => saved, saveCount: () => saves, local: (key) => ls.store.get(key) };
}

function optOutList(local: (key: string) => string | undefined): string[] {
  const raw = local(OPTOUTS_KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as string[]);
}

describe("setDeviceOptOut / deviceOptedOut — round-trip + C-#26 prune discipline (C-#45, §2 storage)", () => {
  it("set true persists into localStorage — the authority no pull or adopt can overwrite", async () => {
    const { instance, saved, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);

    await instance.setDeviceOptOut("hotkeys", true);

    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(true);
    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]); // the ITEM, not the compiled group name
    // ...and nothing else: the fleet-shared `deviceOptOuts` map this used to keep in step is gone
    // from the document (spec §5, C-#54 phase 2) — the version gate refuses a v3 document to
    // every build that read it, so the carry has nothing left to protect.
    expect(saved()).toBeNull();
  });

  it("with no seeded localStorage id, the opt-out still lands — it is keyed by nothing but this device's own store", async () => {
    const { instance, local } = makePlugin({ hotkeys: { synced: true } });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", true);

    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]);
  });

  it("set true then false round-trips byte-clean — the last name removed drops the key entirely", async () => {
    const { instance, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", true);
    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]);

    await instance.setDeviceOptOut("hotkeys", false);
    expect(local(OPTOUTS_KEY)).toBeUndefined();
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);
  });

  it("clearing when never set is a no-op (still no stored list)", async () => {
    const { instance, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("hotkeys", false);
    expect(local(OPTOUTS_KEY)).toBeUndefined();
  });

  it("a set on a DIFFERENT group never touches an existing one", async () => {
    const { instance, local } = makePlugin({ hotkeys: { synced: true }, appearance: { synced: true } }, {}, "d1", {
      [OPTOUTS_KEY]: JSON.stringify(["obsidian/hotkeys"]),
    });
    await instance.loadSettings();
    await instance.recompile();

    await instance.setDeviceOptOut("appearance", true);

    expect(optOutList(local).sort()).toEqual(["obsidian/appearance", "obsidian/hotkeys"]);
  });

  // Spec §4's re-key, at the seam the shell really runs it (main.ts onload/reloadSettings, after
  // the compile — the conversion asks the compiler what each name's ref is). Idempotent BY SHAPE:
  // a name has no "/" and a ref always does, so a second run cannot re-key what has already moved.
  it("re-keys a list still written in group names, once, and leaves an already-moved list alone", async () => {
    const { instance, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1", { [OPTOUTS_KEY]: JSON.stringify(["hotkeys"]) });
    await instance.loadSettings();
    await instance.recompile();
    instance.rekeyDeviceStores();

    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]);
    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(true); // the choice survived the move

    instance.rekeyDeviceStores();
    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]);
  });

  it("a garbage stored value reads as no opt-out at all, and the next write replaces it", async () => {
    // Hand-edited, truncated, or written by something else entirely: the device must still sync.
    const { instance, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1", { [OPTOUTS_KEY]: "{not json" });
    await instance.loadSettings();
    await instance.recompile();

    expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(false);

    await instance.setDeviceOptOut("hotkeys", true);
    expect(optOutList(local)).toEqual(["obsidian/hotkeys"]);
  });

  it("a stored value of the wrong TYPE (the old map, a number, a mixed array) degrades to the names it can read", async () => {
    const cases: [string, string[]][] = [
      [JSON.stringify({ "obsidian/hotkeys": ["d1"] }), []], // the pre-migration shape, seen without a migration
      ["42", []],
      [JSON.stringify(["obsidian/hotkeys", 7, null]), ["obsidian/hotkeys"]],
    ];
    for (const [stored, expected] of cases) {
      const { instance, local } = makePlugin({ hotkeys: { synced: true } }, {}, "d1", { [OPTOUTS_KEY]: stored });
      await instance.loadSettings();
      await instance.recompile();
      expect(instance.syncCenterHost().deviceOptedOut("hotkeys")).toBe(expected.includes("obsidian/hotkeys"));
      expect(local(OPTOUTS_KEY)).toBe(stored); // reading never rewrites the store
    }
  });
});

// The fleet-shared `deviceOptOuts` map is retired with v3 (spec
// 2026-08-11-v3-one-vocabulary-design.md §5, C-#54 phase 2). Its two behaviours — reading this
// device's entries out of a carried map at load, and keeping this device's entry in step on every
// write — existed only so a device still on a build that READ that map would not lose its own
// opt-out when it adopted our document. No such build can read a v3 document at all: the version
// gate refuses it and says so. localStorage is the authority, and now the only store.

describe("SyncCenterHost.computeStatuses — a device-opted-out item still gets a row (C-#45)", () => {
  it("hotkeys opted out on THIS device: still present, synthetic neutral status, deviceOptedOut true", async () => {
    const { instance } = makePlugin({ hotkeys: { synced: true } }, {}, "d1", { [OPTOUTS_KEY]: JSON.stringify(["obsidian/hotkeys"]) });
    await instance.loadSettings();
    await instance.recompile();

    const host = instance.syncCenterHost();
    const { groups, statuses } = await host.computeStatuses();

    expect(groups.find((g) => g.name === "hotkeys")).toBeDefined();
    expect(statuses.find((s) => s.group === "hotkeys")).toEqual({ group: "hotkeys", state: "in-sync" });
    expect(host.deviceOptedOut("hotkeys")).toBe(true);
  });

  it("hotkeys opted out on a DIFFERENT device: this device runs a real comparison, unaffected", async () => {
    // Post-§2 that is simply "this device has no opt-out": another device's choice lives in ITS
    // localStorage and can no longer reach this document at all.
    const { instance } = makePlugin({ hotkeys: { synced: true } }, {}, "d1");
    await instance.loadSettings();
    await instance.recompile();

    const host = instance.syncCenterHost();
    const { statuses } = await host.computeStatuses();

    expect(statuses.find((s) => s.group === "hotkeys")?.state).toBe("no-settings"); // real comparison ran
    expect(host.deviceOptedOut("hotkeys")).toBe(false);
  });

  it("a non-opted-out item is completely unaffected — real comparison still runs", async () => {
    const { instance } = makePlugin({ hotkeys: { synced: true, companions: [] } }, {}, "d1");
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
  recompile: () => Promise<boolean>;
  rekeyDeviceStores: () => void;
  setDeviceOptOut: (groupName: string, on: boolean) => Promise<void>;
  settings: { rootPath: string };
  syncCenterHost: () => {
    captureItems: (items: CaptureItem[]) => Promise<GroupResult[] | null>;
    applyItems: (items: ApplyItem[]) => Promise<GroupResult[] | null>;
  };
}

// The demo plugin's own item, in the community section — `plugin-demo` is its compiled group.
function ioBaseData(): unknown {
  return baseData({}, { items: itemsIn({ community: { demo: { synced: true } } }) });
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
    ...makeLocalStorage({ "config-sync-device-id": "d1" }).api,
  };
  instance.loadData = async () => ioBaseData();
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
