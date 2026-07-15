import { describe, expect, it } from "vitest";
import { CoreContext, capture, loadManifest, groupsForDevice, apply, applyWithActions, revertLastApply, planImport, applyImport, ExternalStoreReader, pushExternal, ExternalStoreWriter, pluginIdForGroup, readGroups, writeGroups } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { SyncGroup } from "../src/core/types";
import { isFieldEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { statusForGroups } from "../src/core/status";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

export const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "vimrc", path: ".obsidian.vimrc", type: "file", devices: "desktop" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", action: "strip" }] },
  ],
});

export function setup(): { io: MemFS; plugins: FakePlugins; ctx: CoreContext } {
  const io = new MemFS();
  const plugins = new FakePlugins();
  const ctx: CoreContext = {
    io,
    configDir: ".obs",
    rootPath: "cs",
    plugins,
    passphrase: null,
    groupsIO: memGroupsIO(),
    now: () => "2026-07-08T00:00:00.000Z",
    switchExceptions: {},
  };
  return { io, plugins, ctx };
}

/** Test helper: seed ctx.groupsIO from a manifest JSON string (replaces seeding a config-sync.json file). */
async function seedGroups(ctx: CoreContext, manifestJson: string): Promise<void> {
  await writeGroups(ctx, parseSyncManifest(manifestJson).groups);
}

describe("loadManifest", () => {
  it("returns an empty group list when no groups are configured", async () => {
    const { ctx } = setup();
    expect(await loadManifest(ctx)).toEqual({ version: 1, groups: [] });
  });
});

describe("groupsForDevice", () => {
  it("filters by device class", () => {
    const manifest = parseSyncManifest(MANIFEST);
    expect(groupsForDevice(manifest, "mobile").map((g) => g.name)).toEqual(["hotkeys", "snippets", "plugin-demo"]);
    expect(groupsForDevice(manifest, "desktop").map((g) => g.name)).toEqual(["hotkeys", "snippets", "vimrc", "plugin-demo"]);
  });
});

describe("pluginIdForGroup", () => {
  it("extracts the id from data.json paths and whole-plugin-dir paths", () => {
    expect(pluginIdForGroup({ name: "a", path: "{configDir}/plugins/cmdr/data.json", type: "file", devices: "all" })).toBe("cmdr");
    expect(pluginIdForGroup({ name: "b", path: "{configDir}/plugins/cmdr", type: "dir", devices: "all" })).toBe("cmdr");
    expect(pluginIdForGroup({ name: "c", path: "{configDir}/hotkeys.json", type: "file", devices: "all" })).toBe(null);
  });
});

describe("capture", () => {
  it("mirrors groups into the store with sanitization, deletion propagation and version stamps", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obs/snippets/sub/two.css": "two",
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
      "cs/store/configdir/snippets/stale.css": "stale",
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    expect(await io.read("cs/store/obsidian.vimrc")).toBe("imap jk <Esc>");
    expect(await io.exists("cs/store/configdir/snippets/stale.css")).toBe(false);
    expect(await io.read("cs/store/configdir/snippets/sub/two.css")).toBe("two");
    expect(JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json"))).toEqual({ theme: "x" });
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, unknown> };
    expect(lock).toEqual({
      capturedAt: "2026-07-08T00:00:00.000Z",
      groups: {
        hotkeys: { sourceAppVersion: "1.8.7" },
        snippets: { sourceAppVersion: "1.8.7" },
        vimrc: { sourceAppVersion: "1.8.7" },
        "plugin-demo": { sourcePluginVersion: "1.2.3" },
      },
    });
  });

  it("reports missing sources as per-group errors and captures the rest", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"theme":"x"}',
      // snippets dir intentionally missing
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx);
    const status = Object.fromEntries(results.map((r) => [r.group, r.status]));
    expect(status["snippets"]).toBe("error");
    expect(status["hotkeys"]).toBe("ok");
    expect(results.find((r) => r.group === "snippets")?.messages[0]).toContain("nothing to capture yet");
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["plugin-demo"]).toBeDefined();
    expect(await io.exists("cs/store/configdir/snippets")).toBe(false);
  });

  it("skips the version stamp for a plugin group whose source is missing", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "x",
      // plugin demo data.json intentionally missing
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx);
    expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["plugin-demo"]).toBeUndefined();
  });

  it("carries forward the version stamp for a group that errors this capture", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    await io.remove(".obs/plugins/demo/data.json");
    const results = await capture(ctx);
    expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { sourcePluginVersion: string }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
  });

  it("does not invent lock entries for errored groups that never had one", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      ".obsidian.vimrc": "v",
      // plugin-demo source missing from the start
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx);
    expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["plugin-demo"]).toBeUndefined();
  });

  it("rebuilds an old-format lock on capture instead of failing", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/store.lock.json": '{"publishedAt":"t","groups":{"plugin-demo":{"sourcePluginVersion":"9.9.9"}}}',
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { sourcePluginVersion: string }> };
    expect(lock.capturedAt).toBe("2026-07-08T00:00:00.000Z");
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" }); // current version, not the stale 9.9.9 — success always re-stamps
  });

  it("skips OS junk when capturing dirs and cleans junk already in the store", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "one",
      ".obs/snippets/.DS_Store": "junk",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
      "cs/store/configdir/snippets/.DS_Store": "old junk",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    expect(await io.exists("cs/store/configdir/snippets/.DS_Store")).toBe(false);
    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("one");
  });

  it("classifies capture changes and skips unchanged writes", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    await io.write(".obs/snippets/two.css", "two");   // added
    await io.write(".obs/snippets/one.css", "ONE");   // updated
    const results = await capture(ctx);
    const snip = results.find((r) => r.group === "snippets");
    expect(snip?.changes).toEqual({ added: ["two.css"], updated: ["one.css"], deleted: [] });
    const hk = results.find((r) => r.group === "hotkeys");
    expect(hk?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(hk?.filesWritten).toEqual([]); // unchanged → not rewritten
  });

  it("selective capture touches only named items and carries the rest in the lock", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx); // demo stamped 1.2.3
    plugins.installed.set("demo", "9.9.9");
    await io.write(".obs/hotkeys.json", '{"a":2}');
    await io.write(".obs/plugins/demo/data.json", '{"x":1}');
    const results = await capture(ctx, ["hotkeys"]);
    expect(results.map((r) => r.group)).toEqual(["hotkeys"]);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":2}');
    expect(await io.read("cs/store/configdir/plugins/demo/data.json")).toBe("{}\n"); // untouched (unchanged since first capture's sanitized write)
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion: string }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" }); // carried, not restamped
  });

  it("captures an encrypted-mode group as an envelope, and re-capture writes nothing when unchanged", async () => {
    const ENC_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" }],
    });
    const { io, ctx } = setup();
    ctx.passphrase = "pw";
    io.seed({ ".obs/secrets.json": '{"token":"x"}' });
    await seedGroups(ctx, ENC_MANIFEST);
    const results = await capture(ctx);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.messages).toEqual(["whole file encrypted"]);
    const stored = await io.read("cs/store/configdir/secrets.json");
    expect(isFieldEnvelope(stored)).toBe(false);
    expect(parseFileEnvelope(stored)).not.toBeNull();
    const again = await capture(ctx);
    expect(again[0]?.filesWritten).toEqual([]); // unchanged local content — nothing rewritten
  });
});

export async function seedStore(io: MemFS, ctx: CoreContext): Promise<void> {
  io.seed({
    "cs/store.lock.json": JSON.stringify({
      capturedAt: "t",
      groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" } },
    }),
    "cs/store/configdir/hotkeys.json": '{"a":2}',
    "cs/store/configdir/snippets/one.css": "one-v2",
    "cs/store/configdir/plugins/demo/data.json": '{"theme":"new"}',
  });
  await seedGroups(ctx, MANIFEST);
}

describe("apply", () => {
  it("applies only the selected groups", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.needsAppReload).toBe(true);
    expect(await io.read(".obs/hotkeys.json")).toBe('{"a":2}');
    expect(await io.exists(".obs/snippets/one.css")).toBe(false);
  });

  it("merges sanitized keys from the local file and cycles the plugin", async () => {
    const { io, plugins, ctx } = setup();
    await seedStore(io, ctx);
    plugins.installed.set("demo", "1.2.3");
    plugins.enabled.add("demo");
    io.seed({ ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"old"}' });
    const results = await apply(ctx, ["plugin-demo"]);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.needsAppReload).toBe(false);
    expect(JSON.parse(await io.read(".obs/plugins/demo/data.json"))).toEqual({ theme: "new", vikaToken: "secret" });
    expect(plugins.log).toEqual(["disable:demo", "enable:demo"]);
  });

  it("mirrors dir groups with deletion and records a backup", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/snippets/local-only.css": "bye", ".obs/snippets/one.css": "one-v1" });
    const results = await apply(ctx, ["snippets"]);
    expect(await io.read(".obs/snippets/one.css")).toBe("one-v2");
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(results[0]?.filesDeleted).toEqual([".obs/snippets/local-only.css"]);
    const indexData = JSON.parse(await io.read(".obs/plugins/config-sync/backup/index.json")) as {
      entries: Array<{ realPath: string }>;
    };
    const paths = indexData.entries.map((e) => e.realPath).sort();
    expect(paths).toEqual([".obs/snippets/local-only.css", ".obs/snippets/one.css"]);
  });

  it("reports an error result when the store has no data for a group", async () => {
    const { ctx } = setup();
    await seedGroups(ctx, MANIFEST);
    const results = await apply(ctx, ["hotkeys"]);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.messages[0]).toContain("capture it from the source vault first");
  });

  it("still writes the backup index when a group throws mid-run", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({
      ".obs/snippets/local-only.css": "bye",
      ".obs/plugins/demo/data.json": "not json",
    });
    await expect(apply(ctx, ["snippets", "plugin-demo"])).rejects.toThrow("not valid JSON");
    const index = JSON.parse(await io.read(".obs/plugins/config-sync/backup/index.json")) as {
      entries: Array<{ realPath: string }>;
    };
    expect(index.entries.length).toBeGreaterThan(0);
    const result = await revertLastApply(ctx);
    expect(result.status).toBe("ok");
    expect(await io.read(".obs/snippets/local-only.css")).toBe("bye");
  });

  it("classifies apply changes and skips identical writes", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "v",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');    // store updated elsewhere
    const results = await apply(ctx, ["hotkeys", "snippets"]);
    const hk = results.find((r) => r.group === "hotkeys");
    expect(hk?.changes.updated).toEqual(["hotkeys.json"]);
    const snip = results.find((r) => r.group === "snippets");
    expect(snip?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(snip?.filesWritten).toEqual([]); // identical → skipped
  });

  it("applies an encrypted-mode group and restores byte-identical content", async () => {
    const ENC_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" }],
    });
    const { io, ctx } = setup();
    ctx.passphrase = "pw";
    io.seed({ ".obs/secrets.json": '{"token":"x"}' });
    await seedGroups(ctx, ENC_MANIFEST);
    await capture(ctx);
    await io.remove(".obs/secrets.json");
    const results = await apply(ctx, ["secrets"]);
    expect(results[0]?.status).toBe("ok");
    expect(await io.read(".obs/secrets.json")).toBe('{"token":"x"}');
  });
});

describe("applyWithActions", () => {
  const seedStore = async (io: MemFS, ctx: CoreContext): Promise<void> => {
    io.seed({
      "cs/store/configdir/plugins/demo/data.json": '{"theme":"x"}',
    });
    await seedGroups(ctx, MANIFEST);
  };
  it("enable action enables then writes config and notes ⏻ enabled", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    await seedStore(io, ctx);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "9.9.9");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⏻ enabled" });
    expect(plugins.enabled.has("demo")).toBe(true);
    expect(plugins.log).toContain("enable-persist:demo");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true);
  });
  it("install-enable installs, reloads manifests, enables, writes config", async () => {
    const { io, plugins, ctx } = setup();
    await seedStore(io, ctx);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], async (id) => {
      plugins.installed.set(id, "2.5.0");
      return "2.5.0";
    });
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⤓ installed & enabled 2.5.0" });
    expect(plugins.log).toContain("reload-manifests");
    expect(plugins.log).toContain("enable-persist:demo");
    expect(plugins.enabled.has("demo")).toBe(true);
  });
  it("update failure skips the config write and warns; install failure still writes", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.0.0");
    plugins.enabled.add("demo");
    await seedStore(io, ctx);
    const failing = async (): Promise<string> => {
      throw new Error("couldn't download demo from the community catalog");
    };
    const upd = await applyWithActions(ctx, [{ name: "plugin-demo", action: "update" }], failing);
    expect(upd[0]?.status).toBe("warning");
    expect(upd[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ update failed" });
    expect(upd[0]?.messages[0]).toContain("settings not applied; they were captured on a newer version");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(false);
    plugins.installed.delete("demo");
    plugins.enabled.delete("demo");
    const inst = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install" }], failing);
    expect(inst[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ install failed" });
    expect(inst[0]?.messages[0]).toContain("settings were staged; install it manually to pick them up");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true);
  });
  it('action "none" on a not-installed plugin notes staged for install', async () => {
    const { io, plugins, ctx } = setup();
    void plugins;
    await seedStore(io, ctx);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "none" }], async () => "x");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "staged for install" });
  });

  describe("enable verification (Obsidian's enable resolves without throwing on a no-op)", () => {
    class NoOpEnablePlugins extends FakePlugins {
      async enablePluginPersistent(id: string): Promise<void> {
        this.log.push(`enable-persist:${id}`); // does NOT add to `enabled` — simulates an unregistered id
      }
    }

    it('action "enable" reports ⚠ enable failed with the exact message when Obsidian silently no-ops, but still writes config', async () => {
      const io = new MemFS();
      const plugins = new NoOpEnablePlugins();
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
      plugins.installed.set("demo", "1.2.3");
      await seedStore(io, ctx);
      const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "9.9.9");
      expect(results[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ enable failed" });
      expect(results[0]?.messages).toEqual([`Obsidian did not enable "demo" — enable it manually in Community plugins`]);
      expect(plugins.enabled.has("demo")).toBe(false);
      expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true); // config still written
    });

    it('action "install-enable" with a successful install but a silently no-op enable reports ⚠ enable failed (not install failed) and still writes config', async () => {
      const io = new MemFS();
      const plugins = new NoOpEnablePlugins();
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
      await seedStore(io, ctx);
      const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], async (id) => {
        plugins.installed.set(id, "2.5.0");
        return "2.5.0";
      });
      expect(results[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ enable failed" });
      expect(results[0]?.messages).toEqual([
        `installed 2.5.0, but: Obsidian did not enable "demo" — enable it manually in Community plugins`,
      ]);
      expect(plugins.enabled.has("demo")).toBe(false);
      expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true); // config still written — install succeeded
    });
  });
});

describe("revertLastApply", () => {
  it("restores overwritten files and deletes files created by apply", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/snippets/local-only.css": "bye" });
    await apply(ctx, ["snippets", "hotkeys"]);
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(await io.read(".obs/hotkeys.json")).toBe('{"a":2}');
    const result = await revertLastApply(ctx);
    expect(result.status).toBe("ok");
    expect(result.needsAppReload).toBe(true);
    expect(await io.read(".obs/snippets/local-only.css")).toBe("bye");
    expect(await io.exists(".obs/hotkeys.json")).toBe(false);
  });

  it("throws a clear error when there is no backup", async () => {
    const { ctx } = setup();
    await expect(revertLastApply(ctx)).rejects.toThrow("Nothing to revert");
  });
});

function fakeReader(files: Record<string, string>): ExternalStoreReader {
  return {
    async listFiles() {
      return Object.keys(files).sort();
    },
    async readFile(rel) {
      const content = files[rel];
      if (content === undefined) throw new Error(`missing ${rel}`);
      return content;
    },
  };
}

const HOTKEYS_GROUP: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
const SNIPPETS_GROUP: SyncGroup = { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" };

// Remote groups source (planImport precedence #1): store/plugin-config-sync's own store copy
// (store/configdir/plugins/config-sync/data.json), parsed as {groups: [...]}. Building the raw
// JSON directly (rather than round-tripping through capture) keeps these tests focused on the
// merge/apply behavior under test.
function selfDataJson(groups: SyncGroup[]): string {
  return JSON.stringify({ groups });
}

describe("planImport / applyImport", () => {
  it("local-only group and its store file survive a pull untouched", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [SNIPPETS_GROUP]);
    io.seed({ "cs/store/configdir/snippets/one.css": "local-only" });
    const remote = { "store/configdir/plugins/config-sync/data.json": selfDataJson([]) };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("local-only");
    expect((await readGroups(ctx)).map((g) => g.name)).toEqual(["snippets"]);
    expect(results.some((r) => r.group === "snippets")).toBe(false); // untouched -> no result
  });

  it("remote-only group and file land locally", async () => {
    const { ctx } = setup();
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}',
    };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await ctx.io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    expect((await readGroups(ctx)).map((g) => g.name)).toEqual(["hotkeys"]);
    const byGroup = Object.fromEntries(results.map((r) => [r.group, r.changes]));
    expect(byGroup["hotkeys"]).toEqual({ added: ["store/configdir/hotkeys.json"], updated: [], deleted: [] });
  });

  it("conflict-free pull (identical + auto-merged only) applies everything via applyImport(ctx, pending, [])", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({ "cs/store/configdir/hotkeys.json": '{"a":1}' });
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP, SNIPPETS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}', // identical
      "store/configdir/snippets/one.css": "one", // remote-only
    };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("one");
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("conflicted pull with choices=['remote'] writes the remote side", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({ "cs/store/configdir/hotkeys.json": '{"a":"local"}' });
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
    };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([
      { kind: "file", name: "hotkeys", rel: "store/configdir/hotkeys.json", localContent: '{"a":"local"}', remoteContent: '{"a":"remote"}' },
    ]);
    const results = await applyImport(ctx, pending, ["remote"]);

    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":"remote"}');
    expect(results.find((r) => r.group === "hotkeys")?.changes).toEqual({ added: [], updated: ["store/configdir/hotkeys.json"], deleted: [] });
  });

  it("conflicted pull with choices=['local'] keeps the local file untouched", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({ "cs/store/configdir/hotkeys.json": '{"a":"local"}' });
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
    };

    const pending = await planImport(ctx, fakeReader(remote));
    const results = await applyImport(ctx, pending, ["local"]);

    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":"local"}');
    expect(results.find((r) => r.group === "hotkeys")).toBeUndefined(); // nothing written for this group
  });

  it("a definition conflict resolved 'remote' replaces the local group definition", async () => {
    const { ctx } = setup();
    const localHotkeys = { ...HOTKEYS_GROUP, devices: "desktop" as const };
    const remoteHotkeys = { ...HOTKEYS_GROUP, devices: "all" as const };
    await writeGroups(ctx, [localHotkeys]);
    const remote = { "store/configdir/plugins/config-sync/data.json": selfDataJson([remoteHotkeys]) };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([{ kind: "definition", name: "hotkeys", local: localHotkeys, remote: remoteHotkeys }]);
    await applyImport(ctx, pending, ["remote"]);

    expect(await readGroups(ctx)).toEqual([remoteHotkeys]);
  });

  it("planImport writes nothing (read-only)", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({ "cs/store/configdir/hotkeys.json": '{"a":"local"}' });
    const before = new Map(io.files);
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP, SNIPPETS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
      "store/configdir/snippets/one.css": "one",
    };

    await planImport(ctx, fakeReader(remote));

    expect(io.files).toEqual(before);
    expect(await readGroups(ctx)).toEqual([HOTKEYS_GROUP]);
  });

  it("throws when choices.length does not match the number of conflicts", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    const pending = await planImport(ctx, fakeReader({}));
    expect(pending.plan.conflicts).toEqual([]);
    await expect(applyImport(ctx, pending, ["remote"])).rejects.toThrow("expected 0");
  });

  it("legacy compat: falls back to a root config-sync.json when no self store item is present", async () => {
    const { ctx } = setup();
    const remote = {
      "config-sync.json": MANIFEST,
      "store/configdir/hotkeys.json": '{"a":1}',
    };

    const pending = await planImport(ctx, fakeReader(remote));

    expect(pending.remoteGroups.map((g) => g.name)).toEqual(["hotkeys", "snippets", "vimrc", "plugin-demo"]);
    const results = await applyImport(ctx, pending, []);
    expect(results.some((r) => r.group === "hotkeys")).toBe(true);
    // the legacy root file is never written locally
    expect(await ctx.io.exists("cs/config-sync.json")).toBe(false);
  });

  it("a legacy config-sync.json.migrated-* remnant is excluded from file classification on both sides", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/config-sync.json.migrated-2026-01-01T00-00-00": "leftover" });
    const remote = { "config-sync.json.migrated-2020-01-01T00-00-00": "remote-leftover" };

    const pending = await planImport(ctx, fakeReader(remote));

    expect(pending.plan.auto.keptLocalFiles).toEqual([]);
    expect(pending.plan.auto.writeFiles).toEqual([]);
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    expect(await io.read("cs/config-sync.json.migrated-2026-01-01T00-00-00")).toBe("leftover");
  });

  describe("store.lock.json merge", () => {
    it("adopts the remote lock entry for a group taken from remote; keeps local entries otherwise", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP, SNIPPETS_GROUP]);
      io.seed({
        "cs/store/configdir/hotkeys.json": '{"a":"local"}',
        "cs/store/configdir/snippets/one.css": "local-only",
        "cs/store.lock.json": JSON.stringify({ capturedAt: "local-time", groups: { hotkeys: { sourceAppVersion: "1.0.0" }, snippets: { sourceAppVersion: "1.0.0" } } }),
      });
      const remote = {
        "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
        "store/configdir/hotkeys.json": '{"a":"remote"}',
        "store.lock.json": JSON.stringify({ capturedAt: "remote-time", groups: { hotkeys: { sourceAppVersion: "2.0.0" } } }),
      };

      const pending = await planImport(ctx, fakeReader(remote));
      await applyImport(ctx, pending, ["remote"]);

      const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, unknown> };
      expect(lock.groups["hotkeys"]).toEqual({ sourceAppVersion: "2.0.0" }); // taken from remote
      expect(lock.groups["snippets"]).toEqual({ sourceAppVersion: "1.0.0" }); // kept local
    });

    it("writes nothing when neither side has a lock", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      const remote = { "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]) };
      const pending = await planImport(ctx, fakeReader(remote));
      await applyImport(ctx, pending, []);
      expect(await io.exists("cs/store.lock.json")).toBe(false);
    });
  });
});

function fakeWriter(initial: Record<string, string>): {
  writer: ExternalStoreWriter;
  files: Record<string, string>;
  finalized: number;
  writeLog: string[];
} {
  const files: Record<string, string> = { ...initial };
  const state = { finalized: 0 };
  const writeLog: string[] = [];
  const writer: ExternalStoreWriter = {
    async listFiles() {
      return Object.keys(files).sort();
    },
    async readFile(rel) {
      const content = files[rel];
      if (content === undefined) throw new Error(`missing ${rel}`);
      return content;
    },
    async writeFile(rel, content) {
      files[rel] = content;
      writeLog.push(rel);
    },
    async deleteFile(rel) {
      delete files[rel];
    },
    async finalize() {
      state.finalized += 1;
    },
  };
  return {
    writer,
    files,
    writeLog,
    get finalized() {
      return state.finalized;
    },
  };
}

describe("pushExternal", () => {
  it("writes the whole local store to the remote with deletion propagation and finalizes once", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": '{"capturedAt":"t","groups":{}}',
      "cs/store/configdir/hotkeys.json": '{"a":9}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "store/gone.css": "stale" });
    const results = await pushExternal(ctx, fw.writer);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"a":9}');
    expect(fw.files["store/gone.css"]).toBeUndefined();
    const meta = results.find((r) => r.group === "");
    expect(meta?.filesDeleted).toEqual(["store/gone.css"]);
    expect(fw.finalized).toBe(1);
  });

  it("skips writing identical files and reports per-item changes", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store/configdir/hotkeys.json": '{"a":1}',
      "cs/store/configdir/snippets/one.css": "one",
    });
    await seedGroups(ctx, MANIFEST);
    const fw = fakeWriter({
      "store/configdir/hotkeys.json": '{"a":1}', // identical to local -> must not be rewritten
    });
    const results = await pushExternal(ctx, fw.writer);
    expect(fw.writeLog).not.toContain("store/configdir/hotkeys.json");
    expect(fw.writeLog).toContain("store/configdir/snippets/one.css");
    const byGroup = Object.fromEntries(results.map((r) => [r.group, r.changes]));
    expect(byGroup["hotkeys"]).toBeUndefined(); // unaffected -> no result
    expect(byGroup["snippets"]).toEqual({ added: ["one.css"], updated: [], deleted: [] });
  });

  it("pushes fine with no root config-sync.json present (store files alone are enough)", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/store/configdir/hotkeys.json": "{}" });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({});
    const results = await pushExternal(ctx, fw.writer);
    expect(fw.files["store/configdir/hotkeys.json"]).toBe("{}");
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("a lock file alone (no store/** tree) also satisfies the store-presence check", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/store.lock.json": '{"capturedAt":"t","groups":{}}' });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({});
    const results = await pushExternal(ctx, fw.writer);
    expect(fw.files["store.lock.json"]).toBe('{"capturedAt":"t","groups":{}}');
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("refuses to push when the local store has no captured data at all", async () => {
    const { ctx } = setup();
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({});
    await expect(pushExternal(ctx, fw.writer)).rejects.toThrow("capture from this device");
  });

  it("never writes a root config-sync.json, and excludes any lingering legacy manifest / migrated remnants from the push", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store/configdir/hotkeys.json": "{}",
      "cs/config-sync.json": "LEGACY",
      "cs/config-sync.json.migrated-2026-01-01T00-00-00": "leftover",
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "config-sync.json": "OLD-REMOTE" });
    const results = await pushExternal(ctx, fw.writer);
    expect(fw.files["config-sync.json"]).toBe("OLD-REMOTE"); // untouched: never written, never deleted
    expect(fw.files["config-sync.json.migrated-2026-01-01T00-00-00"]).toBeUndefined();
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});

describe("progress callbacks", () => {
  it("capture reports done/total/current before each selected group", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
    });
    await seedGroups(ctx, MANIFEST);
    const calls: Array<[number, number, string]> = [];
    await capture(ctx, ["hotkeys", "snippets"], (d, t, c) => calls.push([d, t, c]));
    expect(calls).toEqual([
      [0, 2, "hotkeys"],
      [1, 2, "snippets"],
    ]);
  });

  it("apply reports the same shape", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    const calls: Array<[number, number, string]> = [];
    await apply(ctx, ["hotkeys"], (d, t, c) => calls.push([d, t, c]));
    expect(calls).toEqual([[0, 1, "hotkeys"]]);
  });
});

describe("readGroups / writeGroups", () => {
  it("returns [] when no groups are configured", async () => {
    const { ctx } = setup();
    expect(await readGroups(ctx)).toEqual([]);
  });

  it("writes groups that round-trip through ctx.groupsIO", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }]);
    const groups = await readGroups(ctx);
    expect(groups.map((g) => g.name)).toEqual(["hotkeys"]);
  });

  it("rejects invalid group lists without touching existing groups", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }]);
    const bad = [{ name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "dir" as const, devices: "all" as const, mode: "fields" as const, fields: [{ pattern: "*Token*", action: "strip" as const }] }];
    await expect(writeGroups(ctx, bad)).rejects.toThrow("file groups");
    expect((await readGroups(ctx)).map((g) => g.name)).toEqual(["hotkeys"]);
  });

  it("round-trips a group description through writeGroups/readGroups", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [
      { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", description: "Custom keyboard shortcuts" },
    ]);
    const groups = await readGroups(ctx);
    expect(groups[0]?.description).toBe("Custom keyboard shortcuts");
  });

  it("readGroups/writeGroups round-trip through ctx.groupsIO (no manifest file involved)", async () => {
    const { ctx } = setup();
    expect(await readGroups(ctx)).toEqual([]);
    const g: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    await writeGroups(ctx, [g]);
    expect(await readGroups(ctx)).toEqual([g]);
    expect(await ctx.io.exists(`${ctx.rootPath}/config-sync.json`)).toBe(false); // no file written
  });
});

describe("capture app-version recording", () => {
  it("records sourceAppVersion for non-plugin groups and sourcePluginVersion for plugin groups", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/plugins/demo/data.json": "{}",
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys", "plugin-demo"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["hotkeys"]).toEqual({ sourceAppVersion: "1.8.7" });
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
  });
});

const COMMUNITY_MANIFEST = JSON.stringify({
  version: 1,
  groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
});

const CORE_MANIFEST = JSON.stringify({
  version: 1,
  groups: [{ name: "core-plugins", path: "{configDir}/core-plugins.json", type: "file", devices: "all" }],
});

describe("switch-list exceptions", () => {
  describe("capture (community-plugins array)", () => {
    it("strips the excepted id from the store copy while the local file keeps it", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({ ".obs/community-plugins.json": JSON.stringify(["a", "x", "b"]) });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await capture(ctx);
      expect(JSON.parse(await io.read("cs/store/configdir/community-plugins.json"))).toEqual(["a", "b"]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "x", "b"]);
    });

    it("with no exceptions, captures byte-for-byte as today (identity)", async () => {
      const { io, ctx } = setup();
      io.seed({ ".obs/community-plugins.json": JSON.stringify(["a", "x", "b"], null, 2) + "\n" });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await capture(ctx);
      expect(await io.read("cs/store/configdir/community-plugins.json")).toBe(JSON.stringify(["a", "x", "b"], null, 2) + "\n");
    });
  });

  describe("apply (community-plugins array)", () => {
    it("keeps local state for the excepted id, follows the store for synced ids", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a", "b"]),
        ".obs/community-plugins.json": JSON.stringify(["x", "c"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await apply(ctx, ["community-plugins"]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "b", "x"]);
    });

    it("with no local file, applies the store minus exceptions", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({ "cs/store/configdir/community-plugins.json": JSON.stringify(["a", "x", "b"]) });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await apply(ctx, ["community-plugins"]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "b"]);
    });
  });

  describe("status (community-plugins array)", () => {
    it("is in-sync when local and store differ only in the excepted id", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a", "b"]),
        ".obs/community-plugins.json": JSON.stringify(["a", "b", "x"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const manifest = await loadManifest(ctx);
      const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
      expect(statuses).toEqual([{ group: "community-plugins", state: "in-sync" }]);
    });

    it("still reports a real diff when a synced id differs", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a", "b"]),
        ".obs/community-plugins.json": JSON.stringify(["a", "c", "x"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const manifest = await loadManifest(ctx);
      const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
      expect(statuses[0]?.state).not.toBe("in-sync");
    });

    it("capture does not rewrite the store when local and store differ only in the excepted id (masked-equal skip)", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a", "b"], null, 2) + "\n",
        ".obs/community-plugins.json": JSON.stringify(["a", "b", "x"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await capture(ctx);
      expect(results[0]?.filesWritten).toEqual([]);
    });
  });

  describe("capture (core-plugins map)", () => {
    it("strips the excepted id from the store copy while the local file keeps it", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["core-plugins"] = ["backlink"];
      io.seed({ ".obs/core-plugins.json": JSON.stringify({ graph: true, backlink: false, canvas: true }) });
      await seedGroups(ctx, CORE_MANIFEST);
      await capture(ctx);
      expect(JSON.parse(await io.read("cs/store/configdir/core-plugins.json"))).toEqual({ graph: true, canvas: true });
      expect(JSON.parse(await io.read(".obs/core-plugins.json"))).toEqual({ graph: true, backlink: false, canvas: true });
    });
  });

  describe("apply (core-plugins map)", () => {
    it("keeps local entry state (present:false) for the excepted key, follows store otherwise", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["core-plugins"] = ["backlink"];
      io.seed({
        "cs/store/configdir/core-plugins.json": JSON.stringify({ graph: true, canvas: true }),
        ".obs/core-plugins.json": JSON.stringify({ backlink: false }),
      });
      await seedGroups(ctx, CORE_MANIFEST);
      await apply(ctx, ["core-plugins"]);
      expect(JSON.parse(await io.read(".obs/core-plugins.json"))).toEqual({ graph: true, canvas: true, backlink: false });
    });

    it("leaves an absent excepted key absent when local lacks it", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["core-plugins"] = ["backlink"];
      io.seed({
        "cs/store/configdir/core-plugins.json": JSON.stringify({ graph: true, backlink: true, canvas: true }),
        ".obs/core-plugins.json": JSON.stringify({ graph: false }),
      });
      await seedGroups(ctx, CORE_MANIFEST);
      await apply(ctx, ["core-plugins"]);
      expect(JSON.parse(await io.read(".obs/core-plugins.json"))).toEqual({ graph: true, canvas: true });
    });
  });

  describe("status (core-plugins map)", () => {
    it("is in-sync when local and store differ only in the excepted key", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["core-plugins"] = ["backlink"];
      io.seed({
        "cs/store/configdir/core-plugins.json": JSON.stringify({ graph: true, canvas: true }),
        ".obs/core-plugins.json": JSON.stringify({ graph: true, canvas: true, backlink: false }),
      });
      await seedGroups(ctx, CORE_MANIFEST);
      const manifest = await loadManifest(ctx);
      const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
      expect(statuses).toEqual([{ group: "core-plugins", state: "in-sync" }]);
    });

    it("still reports a real diff when a synced key differs", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["core-plugins"] = ["backlink"];
      io.seed({
        "cs/store/configdir/core-plugins.json": JSON.stringify({ graph: true, canvas: true }),
        ".obs/core-plugins.json": JSON.stringify({ graph: false, canvas: true, backlink: false }),
      });
      await seedGroups(ctx, CORE_MANIFEST);
      const manifest = await loadManifest(ctx);
      const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
      expect(statuses[0]?.state).not.toBe("in-sync");
    });
  });
});
