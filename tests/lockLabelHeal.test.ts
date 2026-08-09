import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { MemFS } from "./memfs";

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
  recompile: () => Promise<void>;
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
    schemaVersion: 2,
    items: { "community:demo": { enabled: true, companions: [] } },
    remotes: [],
    bratPluginIndex: {},
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
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", groups: { "plugin-demo": { sourcePluginVersion: "1.0.0" } } }),
    });
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();

    const healed = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { label?: string }> };
    expect(healed.groups["plugin-demo"]?.label).toBe("Demo Plugin");
    expect(healed.capturedAt).toBe("2026-01-01T00:00:00.000Z"); // never touched
    expect(io.lockWrites).toBe(1);
  });

  it("runs the heal once per plugin load — a second refreshLocalStatus does not re-write the lock", async () => {
    const io = new CountingIO();
    io.seed({
      "config-dir/plugins/demo/data.json": "{}",
      "cs/store/configdir/plugins/demo/data.json": "{}",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", groups: { "plugin-demo": { sourcePluginVersion: "1.0.0" } } }),
    });
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();
    expect(io.lockWrites).toBe(1);
    const afterFirst = await io.read("cs/store.lock.json");

    await plugin.refreshLocalStatus();
    expect(io.lockWrites).toBe(1); // no second heal write
    expect(await io.read("cs/store.lock.json")).toBe(afterFirst);
  });

  it("is a no-op on a fresh device with no local store.lock.json yet", async () => {
    const io = new CountingIO(); // no store.lock.json seeded at all
    const plugin = await readyPlugin(io);

    await plugin.refreshLocalStatus();

    expect(io.lockWrites).toBe(0);
    expect(await io.exists("cs/store.lock.json")).toBe(false);
  });
});
