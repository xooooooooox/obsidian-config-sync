import { describe, expect, it } from "vitest";
import { CoreContext, capture, loadManifest, groupsForDevice, ExternalStoreReader } from "../src/core/ConfigSyncCore";
import { statusForGroups, checkRemote, diffRemote, bucketCounts, GroupStatus } from "../src/core/status";
import { MemFS, FakePlugins } from "./memfs";

const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", sanitize: ["*Token*"] },
  ],
});

function setup(): { io: MemFS; ctx: CoreContext } {
  const io = new MemFS();
  const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins: new FakePlugins(), now: () => "2026-07-08T00:00:00.000Z" };
  return { io, ctx };
}

async function seededAndCaptured(): Promise<{ io: MemFS; ctx: CoreContext }> {
  const { io, ctx } = setup();
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
  });
  await capture(ctx); // capturedAt = 2026-07-08T00:00:00.000Z
  return { io, ctx };
}

async function allStates(ctx: CoreContext): Promise<Record<string, string>> {
  const manifest = await loadManifest(ctx);
  const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
  return Object.fromEntries(statuses.map((s) => [s.group, s.state]));
}

describe("statusForGroups", () => {
  it("reports in-sync right after capture, including sanitize groups compared sanitized", async () => {
    const { ctx } = await seededAndCaptured();
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "in-sync", snippets: "in-sync", "plugin-demo": "in-sync" });
  });

  it("reports local-changed when a live file is newer than capturedAt", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/hotkeys.json", '{"a":2}');
    io.touch(".obs/hotkeys.json", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["hotkeys"]).toBe("local-changed");
  });

  it("reports store-newer when content differs but live mtimes predate capturedAt", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write("cs/store/configdir/hotkeys.json", '{"a":9}'); // simulate a fresher pulled store
    io.touch(".obs/hotkeys.json", Date.parse("2026-07-07T00:00:00.000Z"));
    expect((await allStates(ctx))["hotkeys"]).toBe("store-newer");
  });

  it("reports differs (no direction) when there is no lock", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.remove("cs/store.lock.json");
    await io.write(".obs/hotkeys.json", '{"a":3}');
    expect((await allStates(ctx))["hotkeys"]).toBe("differs");
  });

  it("reports not-captured when the store has no data for the group", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/config-sync.json": MANIFEST, ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x", ".obs/plugins/demo/data.json": "{}" });
    expect((await allStates(ctx))["hotkeys"]).toBe("not-captured");
  });

  it("detects dir set differences and ignores junk on both sides", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.seed({ ".obs/snippets/.DS_Store": "junk", "cs/store/configdir/snippets/.DS_Store": "junk" });
    expect((await allStates(ctx))["snippets"]).toBe("in-sync"); // junk alone never differs
    io.seed({ ".obs/snippets/two.css": "two" });
    io.touch(".obs/snippets/two.css", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["snippets"]).toBe("local-changed");
  });

  it("sanitize groups stay in-sync when only sanitized keys differ from raw", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/plugins/demo/data.json", '{"vikaToken":"ROTATED","theme":"x"}'); // token differs, sanitized view identical
    io.touch(".obs/plugins/demo/data.json", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["plugin-demo"]).toBe("in-sync");
  });

  it("collects full file-level changes for differing items", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/snippets/two.css", "two");          // added live
    await io.write(".obs/snippets/one.css", "ONE");          // updated (store still has "one")
    io.seed({ "cs/store/configdir/snippets/three.css": "three" }); // store-only → deleted
    const manifest = await loadManifest(ctx);
    const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
    const snip = statuses.find((s) => s.group === "snippets");
    expect(snip?.changes?.added).toEqual(["two.css"]);
    expect(snip?.changes?.updated).toEqual(["one.css"]);
    expect(snip?.changes?.deleted).toEqual(["three.css"]);
  });

  it("reports no-settings when neither this device nor the store has files", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/config-sync.json": MANIFEST, ".obs/hotkeys.json": '{"a":1}' });
    // hotkeys: local only -> not-captured; snippets dir + plugin-demo file: nothing anywhere -> no-settings
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "not-captured", snippets: "no-settings", "plugin-demo": "no-settings" });
  });

  it("keeps deletion-only differs when the store has files but this device does not", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.remove(".obs/hotkeys.json");
    expect((await allStates(ctx))["hotkeys"]).toBe("differs");
  });
});

function fakeReader(files: Record<string, string>): ExternalStoreReader {
  return {
    async listFiles(): Promise<string[]> {
      return Object.keys(files).sort();
    },
    async readFile(rel: string): Promise<string> {
      const c = files[rel];
      if (c === undefined) throw new Error(`no ${rel}`);
      return c;
    },
  };
}

describe("diffRemote", () => {
  it("diffRemote reports per-item differences against the local store", async () => {
    const { io, ctx } = await seededAndCaptured();
    const remote: Record<string, string> = {
      "config-sync.json": await io.read("cs/config-sync.json"),
      "store.lock.json": await io.read("cs/store.lock.json"),
      "store/configdir/hotkeys.json": '{"a":1}', // same as local
      "store/configdir/snippets/one.css": "REMOTE", // differs
      "store/configdir/snippets/extra.css": "x", // remote-only
    };
    const entries = await diffRemote(ctx, fakeReader(remote));
    const snip = entries.find((e) => e.group === "snippets");
    expect(snip?.changes.updated).toEqual(["one.css"]);
    expect(snip?.changes.added).toEqual(["extra.css"]);
    expect(entries.find((e) => e.group === "hotkeys")).toBeUndefined();
  });

  it("never reports the store-metadata pseudo-entry, even when bookkeeping files differ", async () => {
    const { io, ctx } = await seededAndCaptured();
    const remote: Record<string, string> = {
      "config-sync.json": '{"version":1,"groups":[]}', // differs from local manifest
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-09T00:00:00.000Z", groups: {} }), // differs from local lock
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/snippets/one.css": "one",
      "store/configdir/plugins/demo/data.json": await io.read("cs/store/configdir/plugins/demo/data.json"),
    };
    const entries = await diffRemote(ctx, fakeReader(remote));
    expect(entries).toEqual([]); // bookkeeping drift alone means "matches"
  });
});

describe("checkRemote", () => {
  const localLock = { capturedAt: "2026-07-08T00:00:00.000Z", groups: {} };
  it("classifies all five states", async () => {
    expect((await checkRemote(localLock, fakeReader({}))).state).toBe("no-store");
    expect((await checkRemote(localLock, fakeReader({ "config-sync.json": "{}" }))).state).toBe("unknown");
    const at = (t: string): Record<string, string> => ({ "config-sync.json": "{}", "store.lock.json": JSON.stringify({ capturedAt: t, groups: {} }) });
    expect((await checkRemote(localLock, fakeReader(at("2026-07-09T00:00:00.000Z")))).state).toBe("remote-newer");
    expect((await checkRemote(localLock, fakeReader(at("2026-07-07T00:00:00.000Z")))).state).toBe("remote-older");
    expect((await checkRemote(localLock, fakeReader(at("2026-07-08T00:00:00.000Z")))).state).toBe("same");
    expect((await checkRemote(null, fakeReader(at("2026-07-09T00:00:00.000Z")))).state).toBe("unknown");
  });
});

describe("bucketCounts", () => {
  it("bucketCounts groups the six states into capture/apply/ok/none buckets", () => {
    const statuses: GroupStatus[] = [
      { group: "a", state: "local-changed" },
      { group: "b", state: "not-captured" },
      { group: "c", state: "store-newer" },
      { group: "d", state: "differs" },
      { group: "e", state: "in-sync" },
      { group: "f", state: "no-settings" },
    ];
    expect(bucketCounts(statuses)).toEqual({ up: 2, down: 2, ok: 1, none: 1 });
  });
});
