import { describe, expect, it } from "vitest";
import { CoreContext, capture, loadManifest, groupsForDevice, ExternalStoreReader, writeGroups } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { statusForGroups, checkRemote, diffRemote, bucketCounts, remoteLockAhead, remoteDirectionCounts, GroupStatus } from "../src/core/status";
import { applyUpdates, emptyLedger, Ledger } from "../src/core/ledger";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", scope: "local", encrypted: false }] },
  ],
});

function setup(): { io: MemFS; ctx: CoreContext } {
  const io = new MemFS();
  const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins: new FakePlugins(), passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
  return { io, ctx };
}

async function seededAndCaptured(): Promise<{ io: MemFS; ctx: CoreContext }> {
  const { io, ctx } = setup();
  io.seed({
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
  });
  await writeGroups(ctx, parseSyncManifest(MANIFEST).groups);
  await capture(ctx); // capturedAt = 2026-07-08T00:00:00.000Z
  return { io, ctx };
}

async function statusAndUpdates(ctx: CoreContext, ledger: Ledger = emptyLedger()) {
  const manifest = await loadManifest(ctx);
  return statusForGroups(ctx, groupsForDevice(manifest, "desktop"), ledger);
}

async function allStates(ctx: CoreContext, ledger: Ledger = emptyLedger()): Promise<Record<string, string>> {
  const { statuses } = await statusAndUpdates(ctx, ledger);
  return Object.fromEntries(statuses.map((s) => [s.group, s.state]));
}

// Produces a seeded ledger the way production does: run one pass on an in-sync vault and apply
// its reseed updates.
async function seededLedger(ctx: CoreContext): Promise<Ledger> {
  const { updates } = await statusAndUpdates(ctx);
  return applyUpdates(emptyLedger(), updates);
}

describe("statusForGroups", () => {
  it("reports in-sync right after capture, including sanitize groups compared sanitized", async () => {
    const { ctx } = await seededAndCaptured();
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "in-sync", snippets: "in-sync", "plugin-demo": "in-sync" });
  });

  it("in-sync groups emit reseed updates; no-settings/not-captured emit drops", async () => {
    const { ctx } = await seededAndCaptured();
    const { statuses, updates } = await statusAndUpdates(ctx);
    expect(statuses.every((s) => s.state === "in-sync")).toBe(true);
    expect(Object.keys(updates).sort()).toEqual(["hotkeys", "plugin-demo", "snippets"]);
    expect(updates["hotkeys"]).not.toBeNull();
  });

  it("reports local-changed when only the local side moved off the baseline", async () => {
    const { io, ctx } = await seededAndCaptured();
    const ledger = await seededLedger(ctx);
    await io.write(".obs/hotkeys.json", '{"a":2}');
    expect((await allStates(ctx, ledger))["hotkeys"]).toBe("local-changed");
  });

  it("reports store-newer when only the store side moved off the baseline", async () => {
    const { io, ctx } = await seededAndCaptured();
    const ledger = await seededLedger(ctx);
    await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');
    expect((await allStates(ctx, ledger))["hotkeys"]).toBe("store-newer");
  });

  it("reports differs when both sides moved off the baseline", async () => {
    const { io, ctx } = await seededAndCaptured();
    const ledger = await seededLedger(ctx);
    await io.write(".obs/hotkeys.json", '{"a":2}');
    await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');
    expect((await allStates(ctx, ledger))["hotkeys"]).toBe("differs");
  });

  it("reports never-synced for a differing group with no baseline entry", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/hotkeys.json", '{"a":2}');
    expect((await allStates(ctx))["hotkeys"]).toBe("never-synced"); // empty ledger
  });

  it("dir groups get directions from baselines too, including added/deleted files", async () => {
    const { io, ctx } = await seededAndCaptured();
    const ledger = await seededLedger(ctx);
    await io.write(".obs/snippets/two.css", "two"); // local added a file
    expect((await allStates(ctx, ledger))["snippets"]).toBe("local-changed");
  });

  it("switch-list enable-order churn does not read as local movement", async () => {
    const { io, ctx } = setup();
    const SWITCH_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
    });
    io.seed({ ".obs/community-plugins.json": '["a","b"]' });
    await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
    await capture(ctx);
    const manifest = await loadManifest(ctx);
    const groups = groupsForDevice(manifest, "desktop");
    const first = await statusForGroups(ctx, groups, emptyLedger());
    const ledger = applyUpdates(emptyLedger(), first.updates);
    await io.write(".obs/community-plugins.json", '["b","a"]'); // reorder only, same set
    await io.write("cs/store/configdir/community-plugins.json", '["a","b","c"]\n'); // store gained "c"
    const { statuses } = await statusForGroups(ctx, groups, ledger);
    expect(statuses.find((s) => s.group === "community-plugins")?.state).toBe("store-newer");
  });

  it("reports not-captured when the store has no data for the group", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x", ".obs/plugins/demo/data.json": "{}" });
    await writeGroups(ctx, parseSyncManifest(MANIFEST).groups);
    expect((await allStates(ctx))["hotkeys"]).toBe("not-captured");
  });

  it("switch lists with equal membership in a different order are in-sync even with NO exceptions", async () => {
    const { io, ctx } = setup();
    const SWITCH_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
    });
    io.seed({ ".obs/community-plugins.json": '["b","a","c"]' }); // local enable-order
    await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
    await capture(ctx);
    await io.write("cs/store/configdir/community-plugins.json", '["a","b","c"]\n'); // store-stable order
    const manifest = await loadManifest(ctx);
    const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
    expect(statuses.find((s) => s.group === "community-plugins")?.state).toBe("in-sync");
  });

  it("ignores junk on both sides", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.seed({ ".obs/snippets/.DS_Store": "junk", "cs/store/configdir/snippets/.DS_Store": "junk" });
    expect((await allStates(ctx))["snippets"]).toBe("in-sync"); // junk alone never differs
  });

  it("sanitize groups stay in-sync when only sanitized keys differ from raw", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/plugins/demo/data.json", '{"vikaToken":"ROTATED","theme":"x"}'); // token differs, sanitized view identical
    expect((await allStates(ctx))["plugin-demo"]).toBe("in-sync");
  });

  it("collects full file-level changes for differing items", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/snippets/two.css", "two");          // added live
    await io.write(".obs/snippets/one.css", "ONE");          // updated (store still has "one")
    io.seed({ "cs/store/configdir/snippets/three.css": "three" }); // store-only → deleted
    const manifest = await loadManifest(ctx);
    const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
    const snip = statuses.find((s) => s.group === "snippets");
    expect(snip?.changes?.added).toEqual(["two.css"]);
    expect(snip?.changes?.updated).toEqual(["one.css"]);
    expect(snip?.changes?.deleted).toEqual(["three.css"]);
  });

  it("reports no-settings when neither this device nor the store has files", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    await writeGroups(ctx, parseSyncManifest(MANIFEST).groups);
    // hotkeys: local only -> not-captured; snippets dir + plugin-demo file: nothing anywhere -> no-settings
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "not-captured", snippets: "no-settings", "plugin-demo": "no-settings" });
  });

  it("reports never-synced when the store has files but this device does not (no baseline)", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.remove(".obs/hotkeys.json");
    expect((await allStates(ctx))["hotkeys"]).toBe("never-synced");
  });
});

const ENC_MANIFEST = JSON.stringify({
  version: 1,
  groups: [{ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" }],
});

describe("statusForGroups: encrypted mode", () => {
  it("is in-sync right after capture, actionable after a local edit, and locked without a passphrase", async () => {
    const { io, ctx } = setup();
    ctx.passphrase = "pw";
    io.seed({ ".obs/secrets.json": '{"token":"x"}' });
    await writeGroups(ctx, parseSyncManifest(ENC_MANIFEST).groups);
    await capture(ctx);
    const ledger = await seededLedger(ctx);
    expect((await allStates(ctx, ledger))["secrets"]).toBe("in-sync");

    await io.write(".obs/secrets.json", '{"token":"y"}');
    expect((await allStates(ctx, ledger))["secrets"]).toBe("local-changed");

    ctx.passphrase = null;
    expect((await allStates(ctx, ledger))["secrets"]).toBe("locked");
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
      "config-sync.json": MANIFEST, // legacy root manifest file, no longer written locally — filtered from the diff regardless
      "store.lock.json": await io.read("cs/store.lock.json"),
      "store/configdir/hotkeys.json": '{"a":1}', // same as local
      "store/configdir/snippets/one.css": "REMOTE", // differs
      "store/configdir/snippets/extra.css": "x", // remote-only
    };
    const entries = await diffRemote(ctx, fakeReader(remote), { excludeSelf: false });
    const snip = entries.find((e) => e.group === "snippets");
    expect(snip?.files).toEqual([
      { itemRel: "extra.css", kind: "added", local: null, remote: "x" },
      { itemRel: "one.css", kind: "updated", local: "one", remote: "REMOTE" },
    ]);
    expect(entries.find((e) => e.group === "hotkeys")).toBeUndefined();
  });

  it("resolves files unknown to the local manifest via the remote manifest (fresh device)", async () => {
    const { ctx } = setup(); // fresh device: zero groups, empty local store
    await writeGroups(ctx, []);
    const remoteSelf = JSON.stringify({
      groups: [
        { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
        { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
        { name: "plugin-config-sync", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" },
      ],
    });
    const remote: Record<string, string> = {
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-09T00:00:00.000Z", groups: {} }),
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/snippets/one.css": "one",
      "store/configdir/plugins/config-sync/data.json": remoteSelf,
      "store/mystery/leftover.bin": "x", // matches neither manifest
    };
    const entries = await diffRemote(ctx, fakeReader(remote), { excludeSelf: false });
    const byName = Object.fromEntries(entries.map((e) => [e.group, e.files]));
    expect(byName["hotkeys"]).toEqual([{ itemRel: "hotkeys.json", kind: "added", local: null, remote: '{"a":1}' }]);
    expect(byName["snippets"]).toEqual([{ itemRel: "one.css", kind: "added", local: null, remote: "one" }]);
    expect(byName["plugin-config-sync"]?.map((f) => f.itemRel)).toEqual(["data.json"]);
    expect(byName["(other store files)"]?.map((f) => f.itemRel)).toEqual(["store/mystery/leftover.bin"]);
    expect(byName[""]).toBeUndefined(); // lock stays metadata
  });

  it("treats switch-list store files as sets — reordered membership is not a difference", async () => {
    const { io, ctx } = setup();
    const SWITCH_MANIFEST = JSON.stringify({
      version: 1,
      groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
    });
    io.seed({ ".obs/community-plugins.json": '["a","b","c"]', "cs/store/configdir/community-plugins.json": '["a","b","c"]' });
    await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
    const reordered = { "store/configdir/community-plugins.json": '["c","a","b"]' };
    expect(await diffRemote(ctx, fakeReader(reordered), { excludeSelf: false })).toEqual([]);
    const membershipDiff = { "store/configdir/community-plugins.json": '["c","a","b","d"]' };
    const entries = await diffRemote(ctx, fakeReader(membershipDiff), { excludeSelf: false });
    expect(entries.find((e) => e.group === "community-plugins")?.files.map((f) => [f.itemRel, f.kind])).toEqual([["community-plugins.json", "updated"]]);
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
    const entries = await diffRemote(ctx, fakeReader(remote), { excludeSelf: false });
    expect(entries).toEqual([]); // bookkeeping drift alone means "matches"
  });

  it("excludeSelf drops the self data file and sidecars from both sides", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.seed({ "cs/store/configdir/plugins/config-sync/data.json": '{"mine":true}' });
    const selfGroups = [{ name: "plugin-config-sync", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }];
    const remote: Record<string, string> = {
      "store.lock.json": await io.read("cs/store.lock.json"),
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/snippets/one.css": "one",
      "store/configdir/plugins/demo/data.json": await io.read("cs/store/configdir/plugins/demo/data.json"),
      "store/configdir/plugins/config-sync/data.json": JSON.stringify({ groups: selfGroups, theirs: true }),
      "store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json": "{}",
    };
    expect(await diffRemote(ctx, fakeReader(remote), { excludeSelf: true })).toEqual([]);
    const withSelf = await diffRemote(ctx, fakeReader(remote), { excludeSelf: false });
    expect(withSelf.map((e) => e.group)).toEqual(["plugin-config-sync"]);
    expect(withSelf[0]?.files.map((f) => f.kind).sort()).toEqual(["added", "updated"]);
  });
});

describe("remoteLockAhead", () => {
  const lock = (capturedAt: string, groups: Record<string, object>) => JSON.stringify({ capturedAt, groups });
  it("false when the local lock semantically covers the remote one (post-pull state)", () => {
    const remote = lock("2026-07-17T10:00:00.000Z", { a: { sourcePluginVersion: "1.0" } });
    // local adopted remote's time+entries but also has a local-only group and different formatting
    const local = JSON.stringify({ capturedAt: "2026-07-17T10:00:00.000Z", groups: { a: { sourcePluginVersion: "1.0" }, localOnly: { sourceAppVersion: "1.8.7" } } }, null, 2);
    expect(remoteLockAhead(local, remote, [])).toBe(false);
  });
  it("true when the remote captured later", () => {
    expect(remoteLockAhead(lock("2026-07-17T10:00:00.000Z", {}), lock("2026-07-17T11:00:00.000Z", {}), [])).toBe(true);
  });
  it("true when a remote group entry is missing or different locally", () => {
    const local = lock("2026-07-17T10:00:00.000Z", { a: { sourcePluginVersion: "1.0" } });
    expect(remoteLockAhead(local, lock("2026-07-17T10:00:00.000Z", { a: { sourcePluginVersion: "2.0" } }), [])).toBe(true);
    expect(remoteLockAhead(local, lock("2026-07-17T10:00:00.000Z", { b: { sourcePluginVersion: "1.0" } }), [])).toBe(true);
  });
  it("false when the local lock is simply newer (push side, not pull)", () => {
    expect(remoteLockAhead(lock("2026-07-17T12:00:00.000Z", {}), lock("2026-07-17T10:00:00.000Z", {}), [])).toBe(false);
  });
  it("handles missing locks: remote absent → false; local absent with remote present → true", () => {
    expect(remoteLockAhead(null, null, [])).toBe(false);
    expect(remoteLockAhead(lock("2026-07-17T10:00:00.000Z", {}), null, [])).toBe(false);
    expect(remoteLockAhead(null, lock("2026-07-17T10:00:00.000Z", {}), [])).toBe(true);
  });

  it("ignoreGroups suppresses a difference from the named group only", () => {
    const local = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "1.0" } });
    const selfDiff = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "2.0" } });
    expect(remoteLockAhead(local, selfDiff, [])).toBe(true);
    expect(remoteLockAhead(local, selfDiff, ["plugin-config-sync"])).toBe(false);
    const otherDiff = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "2.0" }, a: { sourcePluginVersion: "1.0" } });
    expect(remoteLockAhead(local, otherDiff, ["plugin-config-sync"])).toBe(true);
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
  it("recognizes a new-format store (store/** + lock, no root config-sync.json)", async () => {
    const newFormat = {
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-09T00:00:00.000Z", groups: {} }),
      "store/configdir/hotkeys.json": "{}",
    };
    expect((await checkRemote(localLock, fakeReader(newFormat))).state).toBe("remote-newer");
    // store files but no lock yet → present but unknown, NOT no-store
    expect((await checkRemote(localLock, fakeReader({ "store/configdir/hotkeys.json": "{}" }))).state).toBe("unknown");
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

  it("puts locked groups into the none bucket", () => {
    const statuses: GroupStatus[] = [
      { group: "a", state: "in-sync" },
      { group: "b", state: "locked" },
    ];
    expect(bucketCounts(statuses)).toEqual({ up: 0, down: 0, ok: 1, none: 1 });
  });

  it("bucketCounts sends never-synced to the apply bucket", () => {
    const statuses: GroupStatus[] = [{ group: "a", state: "never-synced" }];
    expect(bucketCounts(statuses)).toEqual({ up: 0, down: 1, ok: 0, none: 0 });
  });
});

describe("remoteDirectionCounts", () => {
  it("counts remote-older as push", () => {
    expect(remoteDirectionCounts(["remote-older", "remote-older"])).toEqual({ push: 2, pull: 0 });
  });
  it("counts remote-newer as pull", () => {
    expect(remoteDirectionCounts(["remote-newer"])).toEqual({ push: 0, pull: 1 });
  });
  it("ignores same/no-store/unknown", () => {
    expect(remoteDirectionCounts(["same", "no-store", "unknown"])).toEqual({ push: 0, pull: 0 });
  });
  it("counts a mixed set", () => {
    expect(remoteDirectionCounts(["remote-older", "remote-newer", "same"])).toEqual({ push: 1, pull: 1 });
  });
  it("returns zeroes for an empty list", () => {
    expect(remoteDirectionCounts([])).toEqual({ push: 0, pull: 0 });
  });
});
