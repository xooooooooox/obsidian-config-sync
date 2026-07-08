import { describe, expect, it } from "vitest";
import { CoreContext, publish, loadManifest, groupsForDevice, apply, checkApply, revertLastApply, importExternal, ExternalStoreReader } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { MemFS, FakePlugins } from "./memfs";

export const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "vimrc", path: ".obsidian.vimrc", type: "file", devices: "desktop" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", sanitize: ["*Token*"] },
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
    now: () => "2026-07-08T00:00:00.000Z",
  };
  return { io, plugins, ctx };
}

describe("loadManifest", () => {
  it("throws a clear error when the manifest is missing", async () => {
    const { ctx } = setup();
    await expect(loadManifest(ctx)).rejects.toThrow("cs/manifest.json");
  });
});

describe("groupsForDevice", () => {
  it("filters by device class", () => {
    const manifest = parseSyncManifest(MANIFEST);
    expect(groupsForDevice(manifest, "mobile").map((g) => g.name)).toEqual(["hotkeys", "snippets", "plugin-demo"]);
    expect(groupsForDevice(manifest, "desktop").map((g) => g.name)).toEqual(["hotkeys", "snippets", "vimrc", "plugin-demo"]);
  });
});

describe("publish", () => {
  it("mirrors groups into the store with sanitization, deletion propagation and version stamps", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/manifest.json": MANIFEST,
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obs/snippets/sub/two.css": "two",
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
      "cs/store/configdir/snippets/stale.css": "stale",
    });
    const results = await publish(ctx);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    expect(await io.read("cs/store/obsidian.vimrc")).toBe("imap jk <Esc>");
    expect(await io.exists("cs/store/configdir/snippets/stale.css")).toBe(false);
    expect(await io.read("cs/store/configdir/snippets/sub/two.css")).toBe("two");
    expect(JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json"))).toEqual({ theme: "x" });
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { publishedAt: string; groups: Record<string, { sourcePluginVersion: string }> };
    expect(lock).toEqual({
      publishedAt: "2026-07-08T00:00:00.000Z",
      groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" } },
    });
  });

  it("fails with the group name when a source is missing", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": MANIFEST });
    await expect(publish(ctx)).rejects.toThrow('group "hotkeys"');
  });
});

export function seedStore(io: MemFS): void {
  io.seed({
    "cs/manifest.json": MANIFEST,
    "cs/store.lock.json": JSON.stringify({
      publishedAt: "t",
      groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" } },
    }),
    "cs/store/configdir/hotkeys.json": '{"a":2}',
    "cs/store/configdir/snippets/one.css": "one-v2",
    "cs/store/configdir/plugins/demo/data.json": '{"theme":"new"}',
  });
}

describe("apply", () => {
  it("applies only the selected groups", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.needsAppReload).toBe(true);
    expect(await io.read(".obs/hotkeys.json")).toBe('{"a":2}');
    expect(await io.exists(".obs/snippets/one.css")).toBe(false);
  });

  it("merges sanitized keys from the local file and cycles the plugin", async () => {
    const { io, plugins, ctx } = setup();
    seedStore(io);
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
    seedStore(io);
    io.seed({ ".obs/snippets/local-only.css": "bye", ".obs/snippets/one.css": "one-v1" });
    const results = await apply(ctx, ["snippets"]);
    expect(await io.read(".obs/snippets/one.css")).toBe("one-v2");
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(results[0]?.filesDeleted).toEqual([".obs/snippets/local-only.css"]);
    const indexData = JSON.parse(await io.read(".obs/plugins/obsidian-config-sync/backup/index.json")) as {
      entries: Array<{ realPath: string }>;
    };
    const paths = indexData.entries.map((e) => e.realPath).sort();
    expect(paths).toEqual([".obs/snippets/local-only.css", ".obs/snippets/one.css"]);
  });

  it("reports an error result when the store has no data for a group", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": MANIFEST });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.messages[0]).toContain("publish it from the source vault first");
  });
});

describe("checkApply", () => {
  it("warns on version mismatch", async () => {
    const { io, plugins, ctx } = setup();
    seedStore(io);
    plugins.installed.set("demo", "9.9.9");
    const warnings = await checkApply(ctx, ["hotkeys", "plugin-demo"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.group).toBe("plugin-demo");
    expect(warnings[0]?.message).toContain("1.2.3");
    expect(warnings[0]?.message).toContain("9.9.9");
  });

  it("warns when the plugin is not installed on this device", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    const warnings = await checkApply(ctx, ["plugin-demo"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("not installed");
  });
});

describe("revertLastApply", () => {
  it("restores overwritten files and deletes files created by apply", async () => {
    const { io, ctx } = setup();
    seedStore(io);
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

describe("importExternal", () => {
  it("overwrites the local root with deletion propagation", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": '{"version":1,"groups":[]}', "cs/store/old.css": "old" });
    const result = await importExternal(ctx, fakeReader({
      "manifest.json": MANIFEST,
      "store.lock.json": '{"publishedAt":"t","groups":{}}',
      "store/configdir/hotkeys.json": '{"a":3}',
    }));
    expect(result.status).toBe("ok");
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":3}');
    expect(await io.read("cs/manifest.json")).toBe(MANIFEST);
    expect(await io.exists("cs/store/old.css")).toBe(false);
    expect(result.filesDeleted).toEqual(["cs/store/old.css"]);
  });

  it("rejects sources without a manifest.json", async () => {
    const { ctx } = setup();
    await expect(importExternal(ctx, fakeReader({ "store/x.css": "x" }))).rejects.toThrow("no manifest.json");
  });

  it("rejects sources whose manifest is invalid", async () => {
    const { ctx } = setup();
    await expect(importExternal(ctx, fakeReader({ "manifest.json": '{"version":9}' }))).rejects.toThrow("unsupported version");
  });
});
