import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { MemFS } from "./memfs";
import { itemsIn } from "./items";

// batch6 task-1 (spec 2026-08-08-c-livetest-batch6-remote-labels.md): startup heal wiring —
// backfillLockLabels itself is unit-tested in tests/core.test.ts; this covers the main.ts call
// site, guarded to run once per plugin load (not on every refreshLocalStatus) and to no-op when
// there is no local store to heal yet.
//
// main.ts has no existing test harness beyond tests/mainReloadSettings.test.ts's pattern (Plugin
// is stubbed to an empty class by tests/mock-obsidian.ts). This builds a real ConfigSyncPlugin
// instance backed by a real MemFS vault adapter (the same idiom tests/core.test.ts's
// makeMemberRulePlugin uses), via bracket access to bypass TypeScript's `private`.

class CountingIO extends MemFS {
  lockWrites = 0;
  async write(path: string, data: string): Promise<void> {
    if (path.endsWith("store.lock.json")) this.lockWrites += 1;
    await super.write(path, data);
  }
}

interface HealPluginSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  refreshLocalStatus: () => Promise<void>;
  settings: { rootPath: string };
}

function makeHealPlugin(io: MemFS): HealPluginSurface {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as HealPluginSurface;
  instance.app = {
    vault: { adapter: io, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: { manifests: { demo: { id: "demo", name: "Demo Plugin", version: "1.0.0" } }, enabledPlugins: new Set(["demo"]) },
    workspace: { getLeavesOfType: () => [] },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {},
  };
  instance.loadData = async () => ({
    schemaVersion: 3,
    items: itemsIn({ community: { demo: { synced: true } } }),
    remotes: [],
    bratIndex: {},
  });
  instance.saveData = async () => {};
  return instance;
}

async function readyPlugin(io: MemFS): Promise<HealPluginSurface> {
  const plugin = makeHealPlugin(io);
  await plugin.loadSettings();
  plugin.settings.rootPath = "cs";
  await plugin.recompile(); // compiledGroups now carries "plugin-demo"
  return plugin;
}

describe("startup lock-label heal (main.ts refreshLocalStatus wiring)", () => {
  it("heals a label-less local lock entry and persists the healed lock", async () => {
    const io = new CountingIO();
    io.seed({
      "config-dir/plugins/demo/data.json": "{}",
      "cs/store/configdir/plugins/demo/data.json": "{}",
      "cs/store.lock.json": JSON.stringify({ version: 3, capturedAt: "2026-01-01T00:00:00.000Z", items: { community: { demo: { source: { kind: "plugin", version: "1.0.0" } } } } }),
    });
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();

    // The heal lands on the item's ref, and the label lands in the display partition (spec §3).
    const healed = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; items: Record<string, Record<string, { display?: { label?: string } }>> };
    expect(healed.items["community"]?.["demo"]?.display?.label).toBe("Demo Plugin");
    expect(healed.capturedAt).toBe("2026-01-01T00:00:00.000Z"); // never touched
    expect(io.lockWrites).toBe(1);
  });

  it("runs the heal once per plugin load — a second refreshLocalStatus does not re-write the lock", async () => {
    const io = new CountingIO();
    io.seed({
      "config-dir/plugins/demo/data.json": "{}",
      "cs/store/configdir/plugins/demo/data.json": "{}",
      "cs/store.lock.json": JSON.stringify({ version: 3, capturedAt: "2026-01-01T00:00:00.000Z", items: { community: { demo: { source: { kind: "plugin", version: "1.0.0" } } } } }),
    });
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();
    expect(io.lockWrites).toBe(1);
    const afterFirst = await io.read("cs/store.lock.json");

    await plugin.refreshLocalStatus();
    expect(io.lockWrites).toBe(1); // no second heal write
    expect(await io.read("cs/store.lock.json")).toBe(afterFirst);
  });

  // Task-3 review C1, and the reason this file exists at all: the heal is the FOURTH writer of this
  // file, it fires at startup with no user action behind it, and what it writes looks cosmetic — the
  // exact profile of a writer nobody counts. It must never change the lock's FORMAT.
  //
  // parseStoreLock converts a v1/v2 file to the v3 shape in memory, so writing that object back
  // would leave `items` on disk under the old `version`: a 2.21.0 peer would not refuse it (the
  // number is not from the future), could not parse it (it needs `groups`), would treat it as
  // corrupt, and its next capture would rewrite the whole lock flat — destroying the v3 bookkeeping,
  // `legacy/` entries and all. A format upgrade is earned by a capture or a pull, never by fixing a
  // display name.
  for (const [label, raw] of [
    ["v1 (no version)", JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", groups: { "plugin-demo": { sourcePluginVersion: "1.0.0" } } })],
    ["v2 (a 2.21.0 peer's store — the transition window's normal case)", JSON.stringify({ version: 2, capturedAt: "2026-01-01T00:00:00.000Z", groups: { "plugin-demo": { sourcePluginVersion: "1.0.0" } } })],
  ] as const) {
    it(`leaves a ${label} lock byte-identical — the heal never upgrades the format`, async () => {
      const io = new CountingIO();
      io.seed({
        "config-dir/plugins/demo/data.json": "{}",
        "cs/store/configdir/plugins/demo/data.json": "{}",
        "cs/store.lock.json": raw,
      });
      const plugin = await readyPlugin(io);

      await plugin.refreshLocalStatus();

      expect(io.lockWrites).toBe(0);
      expect(await io.read("cs/store.lock.json")).toBe(raw); // the stale label stays stale; the store stays readable
    });
  }

  it("is a no-op on a fresh device with no local store.lock.json yet", async () => {
    const io = new CountingIO(); // no store.lock.json seeded at all
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();

    expect(io.lockWrites).toBe(0);
    expect(await io.exists("cs/store.lock.json")).toBe(false);
  });
});
