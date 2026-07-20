import { describe, expect, it } from "vitest";
import { CoreContext, capture, captureWithActions, loadManifest, groupsForDevice, apply, applyWithActions, revertLastApply, planImport, applyImport, PendingPull, ExternalStoreReader, pushExternal, ExternalStoreWriter, pluginIdForGroup, readGroups, writeGroups, deviceExcludedPluginIds } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { SyncGroup } from "../src/core/types";
import { isFieldEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { statusForGroups } from "../src/core/status";
import { isChanged } from "../src/core/runHistory";
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

describe("deviceExcludedPluginIds", () => {
  const pg = (id: string, devices: "all" | "desktop" | "mobile"): SyncGroup => ({
    name: `plugin-${id}`,
    path: `{configDir}/plugins/${id}/data.json`,
    type: "file",
    devices,
  });
  const appGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "desktop" };
  const groups = [pg("vim-toggle", "desktop"), pg("mobile-only-thing", "mobile"), pg("dataview", "all"), appGroup];

  it("on mobile, names plugins whose group is scoped to desktop", () => {
    expect(deviceExcludedPluginIds(groups, "mobile")).toEqual(new Set(["vim-toggle"]));
  });

  it("on desktop, names plugins whose group is scoped to mobile", () => {
    expect(deviceExcludedPluginIds(groups, "desktop")).toEqual(new Set(["mobile-only-thing"]));
  });

  it("never names devices:'all' plugins or app-anchored (non-plugin) groups", () => {
    const ids = deviceExcludedPluginIds(groups, "mobile");
    expect(ids.has("dataview")).toBe(false); // devices:'all'
    expect(ids.has("hotkeys")).toBe(false); // app-anchored: pluginIdForGroup is null
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

  it("a version-only capture (content identical, store version older) is recorded as a change", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", groups: { "plugin-demo": { sourcePluginVersion: "1.2.0" } } }),
      "cs/store/configdir/plugins/demo/data.json": '{"theme":"x"}',
      ".obs/plugins/demo/data.json": '{"theme":"x"}', // byte-identical to the store — no file change
    });
    await seedGroups(ctx, MANIFEST);
    const results = await capture(ctx, ["plugin-demo"]);
    const r = results.find((x) => x.group === "plugin-demo");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] }); // content unchanged — no file change
    expect(r?.stateNote?.text).toContain("1.2.0");
    expect(r?.stateNote?.text).toContain("1.2.3");
    expect(isChanged(r!)).toBe(true); // the store version refresh must count in the run report
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion: string }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
  });

  it("records desktopOnly in the lock for a desktop-only plugin", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.desktopOnlyIds.add("demo");
    io.seed({ ".obs/plugins/demo/data.json": "{}", ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x" });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true });
    expect(lock.groups["hotkeys"]?.desktopOnly).toBeUndefined(); // app-anchored: never flagged
  });

  it("backfills desktopOnly onto a carried-forward installed desktop-only plugin", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.desktopOnlyIds.add("demo");
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true });
  });

  it("clears a stale desktopOnly on carry-forward when the plugin is no longer desktop-only", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3", desktopOnly: true }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
  });

  it("leaves a carried-forward entry untouched when the plugin is not installed here", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3", desktopOnly: true }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true });
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
    const indexData = JSON.parse(await io.read(".obs/config-sync-backup/index.json")) as {
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
    const index = JSON.parse(await io.read(".obs/config-sync-backup/index.json")) as {
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
  it("install-only apply (no settings in the store) installs and enables without writing files", async () => {
    const { io, plugins, ctx } = setup();
    await seedGroups(ctx, MANIFEST); // group registered, but nothing captured for it
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], async (id) => {
      plugins.installed.set(id, "2.5.0");
      return "2.5.0";
    });
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "\u2913 installed & enabled 2.5.0" });
    expect(results[0]?.messages).toContain("no settings in the store \u2014 installed the plugin only");
    expect(results[0]?.filesWritten).toEqual([]);
    expect(plugins.enabled.has("demo")).toBe(true);
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(false);
  });
  it("update-only apply (no settings in the store) updates without an applyGroup error", async () => {
    const { plugins, ctx } = setup();
    plugins.installed.set("demo", "1.0.0");
    plugins.enabled.add("demo");
    await seedGroups(ctx, MANIFEST); // group registered, nothing captured
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "update" }], async (id) => {
      plugins.installed.set(id, "2.0.0");
      return "2.0.0";
    });
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "\u2913 updated to 2.0.0 & enabled" });
    expect(results[0]?.messages).toContain("no settings in the store \u2014 updated the plugin only");
    expect(results[0]?.filesWritten).toEqual([]);
  });
  it("enable-only apply (no settings in the store) enables without writing files", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    await seedGroups(ctx, MANIFEST); // group registered, nothing captured
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "9.9.9");
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "\u23fb enabled" });
    expect(results[0]?.messages).toContain("no settings in the store \u2014 enabled the plugin only");
    expect(results[0]?.filesWritten).toEqual([]);
    expect(plugins.enabled.has("demo")).toBe(true);
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(false);
  });
  it("failed enable-only apply keeps the warn note and drops the 'enabled only' line", async () => {
    const { plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.failEnable = true;
    await seedGroups(ctx, MANIFEST);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "9.9.9");
    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.stateNote).toEqual({ kind: "warn", text: "\u26a0 enable failed" });
    expect((results[0]?.messages ?? []).join(" | ")).not.toContain("enabled the plugin only");
  });
  it("failed install-only apply reports the failure honestly (no 'installed' line, no settings clause)", async () => {
    const { plugins, ctx } = setup();
    await seedGroups(ctx, MANIFEST); // group registered, nothing captured
    const failing = async (): Promise<string> => {
      throw new Error("demo isn't in the community catalog");
    };
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], failing);
    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.stateNote).toEqual({ kind: "warn", text: "\u26a0 install failed" });
    const joined = (results[0]?.messages ?? []).join(" | ");
    expect(joined).toContain("install it manually");
    expect(joined).not.toContain("installed the plugin only");
    expect(joined).not.toContain("settings were staged");
    expect(plugins.enabled.has("demo")).toBe(false);
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
    expect(upd[0]?.messages[0]).toContain("update the plugin manually, then apply again");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(false);
    plugins.installed.delete("demo");
    plugins.enabled.delete("demo");
    const inst = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install" }], failing);
    expect(inst[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ install failed" });
    expect(inst[0]?.messages[0]).toContain("settings were applied; install it manually to pick them up");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true);
  });
  it('action "none" on a not-installed plugin notes selected for install', async () => {
    const { io, plugins, ctx } = setup();
    void plugins;
    await seedStore(io, ctx);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "none" }], async () => "x");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "selected for install" });
  });
  it("a single item throwing becomes an error result without aborting the rest of the batch", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    await seedStore(io, ctx);
    // First item's group is unknown → requireGroup throws. The second item must still run.
    const results = await applyWithActions(
      ctx,
      [{ name: "plugin-missing", action: "enable" }, { name: "plugin-demo", action: "enable" }],
      async () => "9.9.9"
    );
    expect(results.length).toBe(2);
    expect(results[0]?.group).toBe("plugin-missing");
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.messages.join(" ")).toContain("Unknown config-sync group");
    expect(results[1]?.group).toBe("plugin-demo");
    expect(results[1]?.status).toBe("ok");
    expect(plugins.enabled.has("demo")).toBe(true);
  });

  describe("enable happens AFTER the config write (plugin loads with the applied settings)", () => {
    // Regression for the outdated-section race: enabling a plugin makes it load its data.json;
    // if enable ran before the config write, the plugin held stale settings in memory and its
    // deferred save-on-load could overwrite the applied file. Enable must come last.
    class ContentAtEnablePlugins extends FakePlugins {
      contentAtEnable: string | null = null;
      io: MemFS | null = null;
      watchPath = "";
      async enablePluginPersistent(id: string): Promise<void> {
        this.contentAtEnable = this.io?.files.get(this.watchPath) ?? null;
        await super.enablePluginPersistent(id);
      }
    }

    it('"update" writes the store settings BEFORE re-enabling the plugin', async () => {
      const io = new MemFS();
      const plugins = new ContentAtEnablePlugins();
      plugins.io = io;
      plugins.watchPath = ".obs/plugins/demo/data.json";
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
      plugins.installed.set("demo", "1.0.0");
      plugins.enabled.add("demo");
      io.seed({ ".obs/plugins/demo/data.json": '{"theme":"old"}' });
      await seedStore(io, ctx);
      const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "update" }], async (id) => {
        plugins.installed.set(id, "1.2.3");
        return "1.2.3";
      });
      expect(results[0]?.status).toBe("ok");
      expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⤓ updated to 1.2.3 & enabled" });
      // the decisive assertion: at enable time the file already held the APPLIED settings
      const applied = JSON.stringify({ theme: "x" }, null, 2) + "\n";
      expect(plugins.contentAtEnable).toBe(applied);
      expect(await io.read(".obs/plugins/demo/data.json")).toBe(applied);
      expect(plugins.enabled.has("demo")).toBe(true);
    });

    it('"enable" (disabled section) also writes settings before enabling', async () => {
      const io = new MemFS();
      const plugins = new ContentAtEnablePlugins();
      plugins.io = io;
      plugins.watchPath = ".obs/plugins/demo/data.json";
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
      plugins.installed.set("demo", "1.2.3");
      io.seed({ ".obs/plugins/demo/data.json": '{"theme":"old"}' });
      await seedStore(io, ctx);
      const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "x");
      expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⏻ enabled" });
      expect(plugins.contentAtEnable).toBe(JSON.stringify({ theme: "x" }, null, 2) + "\n");
      expect(plugins.enabled.has("demo")).toBe(true);
    });
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

describe("self-update guard and switch-apply delta reporting", () => {
  it("refuses to update the self plugin and points at Obsidian's updater", async () => {
    const SELF_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "plugin-config-sync", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }],
    });
    const { io, plugins, ctx } = setup();
    plugins.installed.set("config-sync", "0.26.0");
    plugins.enabled.add("config-sync");
    io.seed({ ".obs/plugins/config-sync/data.json": '{"a":1}', "cs/store/configdir/plugins/config-sync/data.json": '{"a":1}' });
    await writeGroups(ctx, parseSyncManifest(SELF_MANIFEST).groups);
    let installCalled = false;
    const results = await applyWithActions(ctx, [{ name: "plugin-config-sync", action: "update" }], async () => {
      installCalled = true;
      return "9.9.9";
    });
    expect(installCalled).toBe(false);
    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.stateNote).toEqual({ kind: "warn", text: "\u26a0 update skipped" });
    expect((results[0]?.messages ?? []).join(" ")).toContain("Obsidian's plugin updater");
    expect(plugins.enabled.has("config-sync")).toBe(true); // never disabled
  });

  it("applying the self plugin's own settings never disables/reloads config-sync", async () => {
    const SELF_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "plugin-config-sync", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }],
    });
    const { io, plugins, ctx } = setup();
    plugins.installed.set("config-sync", "0.33.0");
    plugins.enabled.add("config-sync");
    io.seed({ ".obs/plugins/config-sync/data.json": '{"old":1}', "cs/store/configdir/plugins/config-sync/data.json": '{"new":1}' });
    await writeGroups(ctx, parseSyncManifest(SELF_MANIFEST).groups);
    const results = await applyWithActions(ctx, [{ name: "plugin-config-sync", action: "none" }], async () => "9.9.9");
    expect(results[0]?.status).not.toBe("error");
    // Disabling config-sync mid-apply reloads the plugin and wipes the Sync Center — the self
    // group applies its data.json in place (the plugin reconciles via loadSettings).
    expect(plugins.log.filter((l) => l.includes("config-sync"))).toEqual([]);
    expect(plugins.enabled.has("config-sync")).toBe(true);
    expect(await io.read(".obs/plugins/config-sync/data.json")).toBe('{"new":1}');
  });

  it("switch-list apply names the plugins it turns on and off", async () => {
    const SWITCH_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
    });
    const { io, ctx } = setup();
    io.seed({
      ".obs/community-plugins.json": '["keep","local-only"]',
      "cs/store/configdir/community-plugins.json": '["keep","store-only"]',
    });
    await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const msgs = results.find((r) => r.group === "community-plugins")?.messages ?? [];
    expect(msgs).toContain("turns on: store-only");
    expect(msgs).toContain("turns off: local-only");
  });

  it("switch-list apply with excluded ids reports no delta for them", async () => {
    const SWITCH_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
    });
    const { io, ctx } = setup();
    ctx.switchExceptions = { "community-plugins": ["local-only"] };
    io.seed({
      ".obs/community-plugins.json": '["keep","local-only"]',
      "cs/store/configdir/community-plugins.json": '["keep"]',
    });
    await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const msgs = results.find((r) => r.group === "community-plugins")?.messages ?? [];
    expect(msgs).toEqual([]); // excluded id keeps local state — nothing toggled
  });
});

describe("captureWithActions (capture-side enable policy)", () => {
  it("captures then enables flagged items, noting \u23fb enabled", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({ ".obs/plugins/demo/data.json": '{"theme":"x"}' });
    await seedGroups(ctx, MANIFEST);
    const results = await captureWithActions(ctx, [{ name: "plugin-demo", action: "enable" }]);
    const r = results.find((x) => x.group === "plugin-demo");
    expect(r?.status).toBe("ok");
    expect(r?.stateNote).toEqual({ kind: "ok", text: "\u23fb enabled" });
    expect(plugins.enabled.has("demo")).toBe(true);
    expect(await io.exists("cs/store/configdir/plugins/demo/data.json")).toBe(true); // capture still happened
  });

  it("a failed enable marks the result warning without undoing the capture", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.failEnable = true;
    io.seed({ ".obs/plugins/demo/data.json": '{"theme":"x"}' });
    await seedGroups(ctx, MANIFEST);
    const results = await captureWithActions(ctx, [{ name: "plugin-demo", action: "enable" }]);
    const r = results.find((x) => x.group === "plugin-demo");
    expect(r?.status).toBe("warning");
    expect(r?.stateNote).toEqual({ kind: "warn", text: "\u26a0 enable failed" });
    expect(await io.exists("cs/store/configdir/plugins/demo/data.json")).toBe(true);
  });

  it('action "none" behaves exactly like a plain capture', async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({ ".obs/plugins/demo/data.json": '{"theme":"x"}' });
    await seedGroups(ctx, MANIFEST);
    const results = await captureWithActions(ctx, [{ name: "plugin-demo", action: "none" }]);
    expect(results.find((x) => x.group === "plugin-demo")?.stateNote).toBeUndefined();
    expect(plugins.enabled.has("demo")).toBe(false);
  });
});

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

  it("remote-only file lands in the store but its group is NOT imported into the sync list", async () => {
    const { ctx } = setup();
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}',
    };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await ctx.io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}'); // store file written
    expect(await readGroups(ctx)).toEqual([]); // sync list untouched — the group stays adoptable via the Config Sync pane
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

  it("reordered switch-list membership pulls conflict-free (real-vault repro 2026-07-17)", async () => {
    const { io, ctx } = setup();
    const SWITCH_GROUP: SyncGroup = { name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" };
    await writeGroups(ctx, [SWITCH_GROUP]);
    io.seed({ "cs/store/configdir/community-plugins.json": '["obsidian-image-toolkit","ioto-tasks-center","config-sync"]' });
    const remote = {
      "store/configdir/plugins/config-sync/data.json": selfDataJson([SWITCH_GROUP]),
      "store/configdir/community-plugins.json": '["ioto-tasks-center","config-sync","obsidian-image-toolkit"]', // same set, different order
    };

    const pending = await planImport(ctx, fakeReader(remote));
    expect(pending.plan.conflicts).toEqual([]);
    expect(pending.plan.auto.identical).toContain("file:store/configdir/community-plugins.json");
    // local bytes stay — no churn from the pull
    const results = await applyImport(ctx, pending, []);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(await io.read("cs/store/configdir/community-plugins.json")).toBe('["obsidian-image-toolkit","ioto-tasks-center","config-sync"]');
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

  it("a definition-level difference is detected by planImport but NOT applied by pull", async () => {
    const { ctx } = setup();
    const localHotkeys = { ...HOTKEYS_GROUP, devices: "desktop" as const };
    const remoteHotkeys = { ...HOTKEYS_GROUP, devices: "all" as const };
    await writeGroups(ctx, [localHotkeys]);
    const remote = { "store/configdir/plugins/config-sync/data.json": selfDataJson([remoteHotkeys]) };

    const pending = await planImport(ctx, fakeReader(remote));
    // planImport still surfaces the difference (the Config Sync pane uses it), but pull no longer
    // resolves sync-list conflicts — no file conflicts, so choices = []. Convergence is via adopt.
    expect(pending.plan.conflicts).toEqual([{ kind: "definition", name: "hotkeys", local: localHotkeys, remote: remoteHotkeys }]);
    await applyImport(ctx, pending, []);

    expect(await readGroups(ctx)).toEqual([localHotkeys]); // local definition kept — pull did not touch the sync list
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

describe("pull lock adoption for identical groups (version-refresh chain)", () => {
  it("an identical-only pull adopts the remote lock entries (version bump arrives)", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/hotkeys.json": '{"a":2}',
      "cs/store/configdir/hotkeys.json": '{"a":2}',
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", groups: { hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] }));
    const remoteFiles: Record<string, string> = {
      "store/configdir/hotkeys.json": '{"a":2}', // identical content
      "store.lock.json": JSON.stringify({ capturedAt: "newer", groups: { hotkeys: { sourceAppVersion: "2.0.0" } } }),
    };
    const reader: ExternalStoreReader = {
      listFiles: async () => Object.keys(remoteFiles),
      readFile: async (rel) => remoteFiles[rel]!,
    };
    const pending = await planImport(ctx, reader);
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { sourceAppVersion?: string }> };
    expect(lock.groups["hotkeys"]?.sourceAppVersion).toBe("2.0.0"); // adopted despite zero file writes
    expect(lock.capturedAt).toBe("newer");
  });

  it("locally-kept groups keep their local lock entries", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/hotkeys.json": '{"a":2}',
      "cs/store/configdir/hotkeys.json": '{"local":"only"}', // differs → conflict
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", groups: { hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] }));
    const remoteFiles: Record<string, string> = {
      "store/configdir/hotkeys.json": '{"remote":"side"}',
      "store.lock.json": JSON.stringify({ capturedAt: "newer", groups: { hotkeys: { sourceAppVersion: "2.0.0" } } }),
    };
    const reader: ExternalStoreReader = { listFiles: async () => Object.keys(remoteFiles), readFile: async (rel) => remoteFiles[rel]! };
    const pending = await planImport(ctx, reader);
    expect(pending.plan.conflicts.length).toBe(1);
    await applyImport(ctx, pending, ["local"]); // keep local content
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourceAppVersion?: string }> };
    expect(lock.groups["hotkeys"]?.sourceAppVersion).toBe("1.0.0"); // content stayed local → lock stays local
  });
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

    it("with exceptions set but malformed local content, falls through to the plain path", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["x"];
      io.seed({ ".obs/community-plugins.json": "not json at all" });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await capture(ctx);
      // parseSwitchList → null → today's exact behavior: raw copy, no masking, no crash
      expect(await io.read("cs/store/configdir/community-plugins.json")).toBe("not json at all");
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

const SNIPPET_MANIFEST = JSON.stringify({
  version: 1,
  groups: [{ name: "enabled-css-snippets", path: "{configDir}/enabled-css-snippets.json", type: "file", devices: "all" }],
});

describe("enabled-css-snippets switch list (field-aware local, plain store)", () => {
  it("captures the field to a dedicated plain-array store file", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({ ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 }) });
    await capture(ctx, ["enabled-css-snippets"]);
    expect(JSON.parse(await io.read("cs/store/configdir/enabled-css-snippets.json"))).toEqual(["a", "a-desktop"]);
  });

  it("apply rewrites only enabledCssSnippets, preserving sibling fields", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({
      "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["a", "a-desktop"]),
      ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["old"], baseFontSize: 16 }),
    });
    await apply(ctx, ["enabled-css-snippets"]);
    expect(JSON.parse(await io.read(".obs/appearance.json"))).toEqual({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 });
  });

  it("force-off removes scope-away ids on apply; pins survive", async () => {
    const { io, ctx } = setup();
    ctx.switchExceptions = { "enabled-css-snippets": ["a-mobile", "keepPinned"] }; // mask (pins ∪ scoped)
    ctx.switchForceOff = { "enabled-css-snippets": ["a-mobile"] }; // scoped-away, not pinned
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({
      "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["a"]),
      ".obs/appearance.json": JSON.stringify({ enabledCssSnippets: ["a", "a-mobile", "keepPinned"] }),
    });
    await apply(ctx, ["enabled-css-snippets"]);
    // a from store; a-mobile force-offed; keepPinned kept-local (pin)
    const applied = JSON.parse(await io.read(".obs/appearance.json")) as { enabledCssSnippets: string[] };
    expect(applied.enabledCssSnippets).toEqual(["a", "keepPinned"]);
  });
});

describe("applyImport — pull is pure store transport", () => {
  it("writes store files but never changes the local sync list", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, MANIFEST);
    const before = await readGroups(ctx);
    const pending: PendingPull = {
      plan: {
        auto: {
          addGroups: [{ name: "plugin-new", path: "{configDir}/plugins/new/data.json", type: "file", devices: "all" }],
          writeFiles: [{ rel: "store/configdir/plugins/new/data.json", content: '{"a":1}', name: "plugin-new" }],
          keptLocalGroups: [],
          keptLocalFiles: [],
          identical: [],
        },
        conflicts: [],
      },
      remoteGroups: [],
      remoteLockRaw: null,
    };
    await applyImport(ctx, pending, []);
    expect(await readGroups(ctx)).toEqual(before); // sync list untouched
    expect(await io.exists("cs/store/configdir/plugins/new/data.json")).toBe(true); // store file written
  });
});
