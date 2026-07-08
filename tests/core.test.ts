import { describe, expect, it } from "vitest";
import { CoreContext, publish, loadManifest, groupsForDevice } from "../src/core/ConfigSyncCore";
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
