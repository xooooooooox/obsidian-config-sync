import { describe, expect, it } from "vitest";
import { withRef } from "./lock";
import { StoreLockEntry } from "../src/core/types";
import { lockEntry, STORE_LOCK_VERSION } from "../src/core/manifest";
import { CoreContext, capture, captureWithActions, loadManifest, groupsForDevice, apply, applyWithActions, planImport, applyImport, PendingPull, ExternalStoreReader, pushExternal, ExternalStoreWriter, pluginIdForGroup, orderInstallsCatalogFirst, readGroups, writeGroups, deviceExcludedPluginIds, isSelfStoreRel, remoteGroupsFrom, groupForStoreRel, backfillLockLabels, excludeOptedOutItems } from "../src/core/ConfigSyncCore";
import { parseStoreLock, parseSyncManifest } from "../src/core/manifest";
import { SwitchList } from "../src/core/switchList";
import { SELF_GROUP_NAME, SELF_ITEM_REF, selfPresetRules } from "../src/core/catalog";
import { StoreLock, SyncGroup, EVERYWHERE, THIS_DEVICE, perClass } from "../src/core/types";
import { isFieldEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { statusForGroups, remoteLockAhead } from "../src/core/status";
import { emptyLedger } from "../src/core/ledger";
import { isChanged } from "../src/core/runHistory";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";
import ConfigSyncPlugin from "../src/main";
import { SelfSyncInfo } from "../src/ui/SyncCenterView";
import { itemsIn } from "./items";

export const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all" },
    { name: "vimrc", path: ".obsidian.vimrc", type: "file", devices: "desktop" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }] },
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
    deviceClass: "desktop",
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

// spec 2026-08-11-data-model-hardening.md: every entry capture writes now also carries its own
// capturedAt and a hash of its store copy. The assertions below are about the KNOWN fields, so they
// wrap the expected entry rather than restate two values none of them is testing. The v2 payload
// itself is asserted directly in the "store.lock.json v2 payload" describe block.
const capturedEntry = (entry: Record<string, unknown>): Record<string, unknown> => ({
  ...entry,
  capturedAt: expect.any(String),
  hash: expect.any(String),
});

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
  const appGroup: SyncGroup = withRef({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "desktop" });
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
    expect(pluginIdForGroup({ name: "b", path: "{configDir}/plugins/cmdr", type: "folder", devices: "all" })).toBe("cmdr");
    expect(pluginIdForGroup({ name: "c", path: "{configDir}/hotkeys.json", type: "file", devices: "all" })).toBe(null);
  });
});

describe("orderInstallsCatalogFirst", () => {
  it("moves BRAT-managed names last, preserving relative order within each class", () => {
    const names = ["plugin-slides-rup", "plugin-obsidian42-brat", "plugin-dataview"];
    const isBrat = (id: string): boolean => id === "slides-rup";
    // The predicate is asked per staged NAME: the caller holds the identity, so nothing here reads
    // a plugin id back out of a group name.
    expect(orderInstallsCatalogFirst(names, (n) => n.startsWith("plugin-") && isBrat(n.slice("plugin-".length)))).toEqual(["plugin-obsidian42-brat", "plugin-dataview", "plugin-slides-rup"]);
  });

  it("is a no-op when nothing is BRAT-managed", () => {
    const names = ["plugin-dataview", "plugin-obsidian42-brat"];
    expect(orderInstallsCatalogFirst(names, () => false)).toEqual(names);
  });

  it("never treats non-plugin group names as BRAT-managed", () => {
    const names = ["plugin-slides-rup", "hotkeys"];
    expect(orderInstallsCatalogFirst(names, (n) => n.startsWith("plugin-"))).toEqual(["hotkeys", "plugin-slides-rup"]);
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; items: Record<string, Record<string, unknown>> };
    expect(lock).toEqual({
      // spec 2026-08-11-data-model-hardening.md: every lock this build writes declares its
      // format version (absent = 1, today's shape). Refusal behaviour lives in tests/versionGates.
      version: 3,
      // a store that has never pulled starts its own lineage at its own capture time, and the
      // top-level stamp is max(groups[*].capturedAt) — for a whole-store capture, ctx.now().
      syncedWatermark: "2026-07-08T00:00:00.000Z",
      capturedAt: "2026-07-08T00:00:00.000Z",
      items: {"obsidian": {"hotkeys": capturedEntry({ source: { kind: "app", version: "1.8.7" } })},"legacy": {"snippets": capturedEntry({ source: { kind: "app", version: "1.8.7" } }),"vimrc": capturedEntry({ source: { kind: "app", version: "1.8.7" } })},"community": {"demo": capturedEntry({ source: { kind: "plugin", version: "1.2.3" } })}},
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["demo"]).toBeDefined();
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["demo"]).toBeUndefined();
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" } })); // carried whole, v2 payload included
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["demo"]).toBeUndefined();
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.capturedAt).toBe("2026-07-08T00:00:00.000Z");
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" } })); // current version, not the stale 9.9.9 — success always re-stamps
  });

  it("a version-only capture (content identical, store version older) is recorded as a change", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.0" } }} } }),
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" } }));
  });

  it("records desktopOnly in the lock for a desktop-only plugin", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.desktopOnlyIds.add("demo");
    io.seed({ ".obs/plugins/demo/data.json": "{}", ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x" });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" }, innate: { desktopOnly: true } }));
    expect(lock.items["obsidian"]?.["hotkeys"]?.desktopOnly).toBeUndefined(); // app-anchored: never flagged
  });

  it("backfills desktopOnly onto a carried-forward installed desktop-only plugin", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.desktopOnlyIds.add("demo");
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.3" } }}, "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.2.3" }, innate: { desktopOnly: true } });
  });

  it("clears a stale desktopOnly on carry-forward when the plugin is no longer desktop-only", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.3" }, innate: { desktopOnly: true } }}, "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.2.3" } });
  });

  it("leaves a carried-forward entry untouched when the plugin is not installed here", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.3" }, innate: { desktopOnly: true } }}, "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.2.3" }, innate: { desktopOnly: true } });
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" } })); // carried, not restamped
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

  // An encrypted FIELD whose plaintext didn't change must reuse its existing store envelope
  // byte-for-byte, even when the group's file is rewritten because a DIFFERENT, unrelated field
  // changed — the BRAT shape: token fields' plaintexts identical both sides while the real change
  // is pluginSubListFrozenVersion; re-encrypting the tokens anyway would churn the store.
  it("captures fields-mode encrypted keys as envelopes; re-capture with an unrelated plain-field change reuses the untouched envelope", async () => {
    const FIELDS_MANIFEST = JSON.stringify({
      version: 1,
      groups: [
        {
          name: "beta",
          path: "{configDir}/plugins/brat/data.json",
          type: "file",
          devices: "all",
          mode: "fields",
          fields: [{ pattern: "token", sharing: EVERYWHERE, encrypted: true }],
        },
      ],
    });
    const { io, ctx } = setup();
    ctx.passphrase = "pw";
    io.seed({ ".obs/plugins/brat/data.json": JSON.stringify({ token: "ghp_secret", frozenVersion: 1 }) });
    await seedGroups(ctx, FIELDS_MANIFEST);
    await capture(ctx);
    const stored1 = JSON.parse(await io.read("cs/store/configdir/plugins/brat/data.json")) as Record<string, unknown>;
    expect(isFieldEnvelope(stored1["token"])).toBe(true);

    // Only the unrelated plain field changes — the token's plaintext is identical.
    await io.write(".obs/plugins/brat/data.json", JSON.stringify({ token: "ghp_secret", frozenVersion: 2 }));
    const again = await capture(ctx);
    expect(again[0]?.filesWritten).not.toEqual([]); // the file DID change (frozenVersion) — rewritten
    const stored2 = JSON.parse(await io.read("cs/store/configdir/plugins/brat/data.json")) as Record<string, unknown>;
    expect(stored2["token"]).toBe(stored1["token"]); // envelope reused byte-for-byte, not re-encrypted
    expect(stored2["frozenVersion"]).toBe(2);

    // A genuine token change DOES produce a new envelope.
    await io.write(".obs/plugins/brat/data.json", JSON.stringify({ token: "ghp_rotated", frozenVersion: 2 }));
    await capture(ctx);
    const stored3 = JSON.parse(await io.read("cs/store/configdir/plugins/brat/data.json")) as Record<string, unknown>;
    expect(stored3["token"]).not.toBe(stored2["token"]);
  });
});

export async function seedStore(io: MemFS, ctx: CoreContext): Promise<void> {
  io.seed({
    "cs/store.lock.json": JSON.stringify({
      capturedAt: "t",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.3" } }} },
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

  it("mirrors dir groups with deletion and writes no backup (there is no revert facility)", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/snippets/local-only.css": "bye", ".obs/snippets/one.css": "one-v1" });
    const results = await apply(ctx, ["snippets"]);
    expect(await io.read(".obs/snippets/one.css")).toBe("one-v2");
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(results[0]?.filesDeleted).toEqual([".obs/snippets/local-only.css"]);
    expect(await io.exists(".obs/config-sync-backup")).toBe(false);
  });

  it("reports an error result when the store has no data for a group", async () => {
    const { ctx } = setup();
    await seedGroups(ctx, MANIFEST);
    const results = await apply(ctx, ["hotkeys"]);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.messages[0]).toContain("capture it from the source vault first");
  });

  it("deletes a leftover 1.x backup folder on apply (legacy cleanup)", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/config-sync-backup/index.json": "{}", ".obs/config-sync-backup/files/0": "old" });
    await apply(ctx, ["snippets"]);
    expect(await io.exists(".obs/config-sync-backup")).toBe(false);
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

// adoptConfiguration (main.ts) applies the self group ("plugin-config-sync") through this
// same apply() — the exact path an "Adopt configuration" run takes. The adopt truth
// table: a store self-copy carrying bratIndex/memberRules/items/customGroups (every kind of
// top-level field the self item can carry, none of them preset-excluded) plus its own trio values,
// applied over a local copy with DIFFERENT trio values — every synced field must come out equal to
// the store, and the trio must come out equal to the PRE-adopt local values, untouched.
describe("apply — self group field completeness (adopt truth table)", () => {
  const SELF_PATH = "{configDir}/plugins/config-sync/data.json";
  const STORE_SELF_REL = "cs/store/configdir/plugins/config-sync/data.json";
  const LOCAL_SELF_REL = ".obs/plugins/config-sync/data.json";

  async function seedSelfGroup(ctx: CoreContext): Promise<void> {
    await writeGroups(ctx, [
      { name: SELF_GROUP_NAME, path: SELF_PATH, type: "file", devices: "all", mode: "fields", fields: selfPresetRules() },
    ]);
  }

  it("adopt imports every synced field (bratIndex included) and leaves the device-local trio untouched", async () => {
    const { io, ctx } = setup();
    await seedSelfGroup(ctx);
    const store = {
      schemaVersion: 3,
      items: itemsIn({ community: { dataview: { synced: true } }, custom: { "my-rule": { synced: true, type: "file", path: "notes/custom.json" } } }),
      remotes: [{ name: "store-remote" }],
      rootPath: "store-root",
      bratIndex: { "my-text-tools": "owner/my-text-tools", "slides-rup": "owner/slides-rup" },
    };
    const local = {
      schemaVersion: 3,
      items: itemsIn({}),
      remotes: [],
      rootPath: "local-root",
      bratIndex: {},
    };
    io.seed({ [STORE_SELF_REL]: JSON.stringify(store), [LOCAL_SELF_REL]: JSON.stringify(local) });

    const results = await apply(ctx, [SELF_GROUP_NAME]);
    expect(results[0]?.status).toBe("ok");
    const after = JSON.parse(await io.read(LOCAL_SELF_REL)) as Record<string, unknown>;

    // Every field the self compare tracks (i.e. everything selfPresetRules() does not name)
    // adopts the store's value — the whole nested item store, custom items included.
    expect(after.items).toEqual(store.items);
    expect(after.bratIndex).toEqual(store.bratIndex);
    // The device-local pair (selfPresetRules' exclusion set) stays exactly as it was locally —
    // never overwritten by the store's copy.
    expect(after.rootPath).toBe(local.rootPath);
    expect(after.remotes).toEqual(local.remotes);
  });
});

const APPEARANCE_MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "appearance", path: "{configDir}/appearance.json", type: "file", devices: "all" },
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
  ],
});

describe("appearance hot-apply post-pass (#7)", () => {
  it("apply run writing an appearance-family file calls reloadAppearance once and clears needsAppReload on family results", async () => {
    const { io, plugins, ctx } = setup();
    await seedGroups(ctx, APPEARANCE_MANIFEST);
    io.seed({ "cs/store/configdir/appearance.json": '{"cssTheme":"new"}', ".obs/appearance.json": '{"cssTheme":"old"}' });
    const results = await apply(ctx, ["appearance"]);
    expect(plugins.log.filter((l) => l === "reload-appearance")).toHaveLength(1);
    expect(results[0]?.needsAppReload).toBe(false);
  });

  it("apply run touching no family group does not call reloadAppearance and leaves its reload flag unchanged", async () => {
    const { io, plugins, ctx } = setup();
    await seedGroups(ctx, APPEARANCE_MANIFEST);
    io.seed({ "cs/store/configdir/hotkeys.json": '{"a":2}', ".obs/hotkeys.json": '{"a":1}' });
    const results = await apply(ctx, ["hotkeys"]);
    expect(plugins.log).not.toContain("reload-appearance");
    expect(results[0]?.needsAppReload).toBe(true);
  });

  it("reloadAppearance throwing keeps needsAppReload true, escalates status, and carries the warn message", async () => {
    const { io, plugins, ctx } = setup();
    plugins.failAppearance = true;
    await seedGroups(ctx, APPEARANCE_MANIFEST);
    io.seed({ "cs/store/configdir/appearance.json": '{"cssTheme":"new"}', ".obs/appearance.json": '{"cssTheme":"old"}' });
    const results = await apply(ctx, ["appearance"]);
    expect(results[0]?.needsAppReload).toBe(true);
    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.messages[0]).toContain("appearance hot-apply failed");
  });

  it("family group in the run but with zero files written/deleted does not call reloadAppearance", async () => {
    const { io, plugins, ctx } = setup();
    await seedGroups(ctx, APPEARANCE_MANIFEST);
    io.seed({ "cs/store/configdir/appearance.json": '{"cssTheme":"same"}', ".obs/appearance.json": '{"cssTheme":"same"}' });
    const results = await apply(ctx, ["appearance"]);
    expect(results[0]?.filesWritten).toEqual([]);
    expect(plugins.log).not.toContain("reload-appearance");
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
  // The fallback line must render exactly once: applyWithActions pushes both the prelude's own
  // `messages` and `finish`'s success return unconditionally, so a line placed in both would
  // render twice.
  it("install-enable with a version fallback reports the note exactly once, as a success note (not an issue)", async () => {
    const { io, plugins, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { "community": {"demo": { source: { kind: "plugin", version: "2.2.2" } }} } }) });
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], async (id) => {
      plugins.installed.set(id, "2.2.3");
      return "2.2.3";
    });
    const fallbackLines = (results[0]?.messages ?? []).filter((m) => m.includes("no longer downloadable"));
    expect(fallbackLines).toEqual(["the captured version 2.2.2 is no longer downloadable — installed 2.2.3 instead"]);
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⤓ installed & enabled 2.2.3" });
    expect(results[0]?.status).toBe("warning"); // a note on a successful install, never promoted to "error"
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
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
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
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
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
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
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
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-08T00:00:00.000Z", switchExceptions: {} };
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

// A store's bookkeeping, in the shape every captured store carries one. Spread into the remote
// fixtures below because (spec 2026-08-12-loose-ends-design.md) refuses a remote that holds
// content with no lock: these tests are about what a pull/push DOES with a store, so they have to
// describe a store rather than the shape the gate now turns away — which
// tests/versionGates.test.ts holds instead.
const REMOTE_LOCK = { "store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T00:00:00.000Z", items: {} }) };

const HOTKEYS_GROUP: SyncGroup = withRef({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" });
const SNIPPETS_GROUP: SyncGroup = withRef({ name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all" });

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

describe("switch-list apply switches the delta at runtime (spec B)", () => {
  const COMMUNITY_MANIFEST = JSON.stringify({
    version: 1,
    groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
  });
  const CORE_MANIFEST = JSON.stringify({
    version: 1,
    groups: [{ name: "core-plugins", path: "{configDir}/core-plugins.json", type: "file", devices: "all" }],
  });

  it("applying community-plugins switches the delta at runtime and needs no reload", async () => {
    const { io, plugins, ctx } = setup();
    plugins.enabled.add("b");
    io.seed({
      ".obs/community-plugins.json": '["keep","b"]',
      "cs/store/configdir/community-plugins.json": '["keep","a"]',
    });
    await writeGroups(ctx, parseSyncManifest(COMMUNITY_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const r = results.find((x) => x.group === "community-plugins");
    expect(plugins.log).toContain("enable:a");
    expect(plugins.log).toContain("disable:b");
    expect(r?.needsAppReload).toBe(false);
  });

  it("applying core-plugins uses the core enable/disable hooks", async () => {
    const { io, plugins, ctx } = setup();
    io.seed({
      ".obs/core-plugins.json": JSON.stringify({ graph: true, backlink: false }),
      "cs/store/configdir/core-plugins.json": JSON.stringify({ graph: false, backlink: true }),
    });
    await writeGroups(ctx, parseSyncManifest(CORE_MANIFEST).groups);
    const results = await apply(ctx, ["core-plugins"]);
    const r = results.find((x) => x.group === "core-plugins");
    expect(plugins.log).toContain("enable-core:backlink");
    expect(plugins.log).toContain("disable-core:graph");
    expect(r?.needsAppReload).toBe(false);
  });

  it("config-sync is never runtime-disabled", async () => {
    const { io, plugins, ctx } = setup();
    io.seed({
      ".obs/community-plugins.json": '["keep","config-sync"]',
      "cs/store/configdir/community-plugins.json": '["keep"]',
    });
    await writeGroups(ctx, parseSyncManifest(COMMUNITY_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const r = results.find((x) => x.group === "community-plugins");
    expect(plugins.log.some((l) => l.includes("config-sync"))).toBe(false);
    expect(r?.messages).toContain("config-sync stays running until reload");
  });

  it("one failing enable does not stop the others", async () => {
    const { io, plugins, ctx } = setup();
    plugins.failIds.add("a");
    io.seed({
      ".obs/community-plugins.json": "[]",
      "cs/store/configdir/community-plugins.json": '["a","b"]',
    });
    await writeGroups(ctx, parseSyncManifest(COMMUNITY_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const r = results.find((x) => x.group === "community-plugins");
    expect(plugins.enabled.has("a")).toBe(false);
    expect(plugins.enabled.has("b")).toBe(true);
    expect((r?.messages ?? []).some((m) => m.includes("a"))).toBe(true);
  });

  // applyGroup pre-sets needsAppReload false
  // right before the runtime switch runs (the switch itself is normally the reload), so a
  // per-id failure leaves the written file and the running app disagreeing — that must
  // restore needsAppReload to true (mirrors hotApplyAppearanceFamily's honest-on-failure
  // behavior) or the Reload CTA never surfaces for a real drift.
  it("a failing runtime switch restores needsAppReload so the Reload CTA surfaces the drift", async () => {
    const { io, plugins, ctx } = setup();
    plugins.failIds.add("a");
    io.seed({
      ".obs/community-plugins.json": "[]",
      "cs/store/configdir/community-plugins.json": '["a","b"]',
    });
    await writeGroups(ctx, parseSyncManifest(COMMUNITY_MANIFEST).groups);
    const results = await apply(ctx, ["community-plugins"]);
    const r = results.find((x) => x.group === "community-plugins");
    expect(r?.needsAppReload).toBe(true);
  });

  it("an obsidian config group still flags needsAppReload", async () => {
    const { io, ctx } = setup();
    await seedStore(io, ctx);
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results[0]?.needsAppReload).toBe(true);
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

describe("isSelfStoreRel", () => {
  it("matches the self data file and its device-class sidecars only", () => {
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json.__scopes__.mobile.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/demo/data.json")).toBe(false);
    expect(isSelfStoreRel("store.lock.json")).toBe(false);
  });
});

describe("planImport / applyImport", () => {
  it("local-only group and its store file survive a pull untouched", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [SNIPPETS_GROUP]);
    io.seed({ "cs/store/configdir/snippets/one.css": "local-only" });
    const remote = { ...REMOTE_LOCK, "store/configdir/plugins/config-sync/data.json": selfDataJson([]) };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("local-only");
    expect((await readGroups(ctx)).map((g) => g.name)).toEqual(["snippets"]);
    expect(results.some((r) => r.group === "snippets")).toBe(false); // untouched -> no result
  });

  it("remote-only file lands in the store but its group is NOT imported into the sync list", async () => {
    const { ctx } = setup();
    const remote = {
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}',
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
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
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP, SNIPPETS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}', // identical
      "store/configdir/snippets/one.css": "one", // remote-only
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
    expect(pending.plan.conflicts).toEqual([]);
    const results = await applyImport(ctx, pending, []);

    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("one");
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("reordered switch-list membership pulls conflict-free (real-vault repro 2026-07-17)", async () => {
    const { io, ctx } = setup();
    const SWITCH_GROUP: SyncGroup = withRef({ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" });
    await writeGroups(ctx, [SWITCH_GROUP]);
    io.seed({ "cs/store/configdir/community-plugins.json": '["obsidian-image-toolkit","ioto-tasks-center","config-sync"]' });
    const remote = {
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([SWITCH_GROUP]),
      "store/configdir/community-plugins.json": '["ioto-tasks-center","config-sync","obsidian-image-toolkit"]', // same set, different order
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
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
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
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
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
    const results = await applyImport(ctx, pending, ["local"]);

    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":"local"}');
    expect(results.find((r) => r.group === "hotkeys")).toBeUndefined(); // nothing written for this group
  });

  it("a definition-level difference is detected by planImport but NOT applied by pull", async () => {
    const { ctx } = setup();
    const localHotkeys = { ...HOTKEYS_GROUP, devices: "desktop" as const };
    const remoteHotkeys = { ...HOTKEYS_GROUP, devices: "all" as const };
    await writeGroups(ctx, [localHotkeys]);
    const remote = { ...REMOTE_LOCK, "store/configdir/plugins/config-sync/data.json": selfDataJson([remoteHotkeys]) };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
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
      ...REMOTE_LOCK,
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP, SNIPPETS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":"remote"}',
      "store/configdir/snippets/one.css": "one",
    };

    await planImport(ctx, fakeReader(remote), { skipRefs: [] });

    expect(io.files).toEqual(before);
    expect(await readGroups(ctx)).toEqual([HOTKEYS_GROUP]);
  });

  it("throws when choices.length does not match the number of conflicts", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    const pending = await planImport(ctx, fakeReader({}), { skipRefs: [] });
    expect(pending.plan.conflicts).toEqual([]);
    await expect(applyImport(ctx, pending, ["remote"])).rejects.toThrow("expected 0");
  });

  it("legacy compat: falls back to a root config-sync.json when no self store item is present", async () => {
    const { ctx } = setup();
    // No lock, deliberately (and unchanged since before): the legacy root manifest IS this
    // remote's bookkeeping, so the gate lets it through to the legacy path instead of refusing it
    // as content nothing identifies.
    const remote = {
      "config-sync.json": MANIFEST,
      "store/configdir/hotkeys.json": '{"a":1}',
    };

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });

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

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });

    expect(pending.plan.auto.keptLocalFiles).toEqual([]);
    expect(pending.plan.auto.writeFiles).toEqual([]);
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    expect(await io.read("cs/config-sync.json.migrated-2026-01-01T00-00-00")).toBe("leftover");
  });

  it("excludeSelf: a divergent self store copy is neither a conflict nor written by pull", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-01T00:00:00.000Z", items: { "community": {"config-sync": { source: { kind: "plugin", version: "1.0.0" } }} } }),
      "cs/store/configdir/plugins/config-sync/data.json": '{"groups":[],"mine":true}',
      "cs/store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json": '{"mine":true}',
    });
    const remote = {
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-02T00:00:00.000Z", items: { "community": {"config-sync": { source: { kind: "plugin", version: "9.9.9" } }}, "obsidian": {"hotkeys": { source: { kind: "app", version: "1.9.0" } }} } }),
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}',
    };
    // sanity: without the exclusion this exact setup IS a self-file conflict
    expect((await planImport(ctx, fakeReader(remote), { skipRefs: [] })).plan.conflicts.length).toBe(1);

    const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [SELF_ITEM_REF] });
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    expect(await io.read("cs/store/configdir/plugins/config-sync/data.json")).toBe('{"groups":[],"mine":true}');
    expect(await io.read("cs/store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json")).toBe('{"mine":true}');
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}'); // the rest of the pull still lands
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["config-sync"]?.source?.version).toBe("1.0.0"); // local self lineage survives
  });

  describe("store.lock.json merge", () => {
    it("adopts the remote lock entry for a group taken from remote; keeps local entries otherwise", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP, SNIPPETS_GROUP]);
      io.seed({
        "cs/store/configdir/hotkeys.json": '{"a":"local"}',
        "cs/store/configdir/snippets/one.css": "local-only",
        "cs/store.lock.json": JSON.stringify({ capturedAt: "local-time", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }}, "legacy": {"snippets": { source: { kind: "app", version: "1.0.0" } }} } }),
      });
      const remote = {
        "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
        "store/configdir/hotkeys.json": '{"a":"remote"}',
        "store.lock.json": JSON.stringify({ capturedAt: "remote-time", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "2.0.0" } }} } }),
      };

      const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
      await applyImport(ctx, pending, ["remote"]);

      const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; items: Record<string, Record<string, unknown>> };
      expect(lock.items["obsidian"]?.["hotkeys"]).toEqual({ source: { kind: "app", version: "2.0.0" } }); // taken from remote
      expect(lock.items["legacy"]?.["snippets"]).toEqual({ source: { kind: "app", version: "1.0.0" } }); // kept local
    });

    // narrowed the shapes this can be asked about: a remote holding content with no lock is
    // refused outright now, so the only lockless remote a pull ever reaches is an empty one — the
    // first-push target. Neither side has a lock, and the merge still invents none.
    it("writes nothing when neither side has a lock", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      io.seed({ "cs/store/configdir/hotkeys.json": '{"a":1}' });
      const pending = await planImport(ctx, fakeReader({}), { skipRefs: [] });
      await applyImport(ctx, pending, []);
      expect(await io.exists("cs/store.lock.json")).toBe(false);
    });

    it("pull adopts the remote lock entry for an identical store file whose group exists only in the remote contract", async () => {
      const io = new MemFS();
      const plugins = new FakePlugins();
      const FOREIGN: SyncGroup = withRef({ name: "plugin-foreign", path: "{configDir}/plugins/foreign/data.json", type: "file", devices: "all" });
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {}, storeListGroups: () => [FOREIGN] };
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      const remoteLock = JSON.stringify({ capturedAt: "2026-07-30T09:00:00.000Z", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.6.0" } }}, "community": {"foreign": { source: { kind: "plugin", version: "0.5.25" } }} } }, null, 2) + "\n";
      io.seed({
        "cs/store/configdir/hotkeys.json": '{"a":1}',
        "cs/store/configdir/plugins/foreign/data.json": '{"x":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T08:00:00.000Z", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.6.0" } }} } }, null, 2) + "\n",
      });
      const remote = {
        "store/configdir/hotkeys.json": '{"a":1}',
        "store/configdir/plugins/foreign/data.json": '{"x":1}',
        "store/configdir/plugins/config-sync/data.json": JSON.stringify({ schemaVersion: 2, items: { "community:foreign": { enabled: true } } }),
        "store.lock.json": remoteLock,
      };
      const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
      expect(pending.plan.conflicts.filter((c) => c.kind === "file")).toEqual([]);
      await applyImport(ctx, pending, []);
      const mergedRaw = await io.read("cs/store.lock.json");
      const merged = JSON.parse(mergedRaw) as { capturedAt: string; items: Record<string, Record<string, unknown>> };
      expect(merged.items["community"]?.["foreign"]).toEqual({ source: { kind: "plugin", version: "0.5.25" } }); // adopted across
      expect(remoteLockAhead(mergedRaw, remoteLock, [])).toBe(false); // the hint clears
    });

    it("capture carries forward lock entries for groups outside the compiled registry", async () => {
      const io = new MemFS();
      const plugins = new FakePlugins();
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T12:00:00.000Z", switchExceptions: {} };
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      io.seed({
        ".obs/hotkeys.json": '{"a":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T09:00:00.000Z", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "0.0.9" } }}, "community": {"foreign": { source: { kind: "plugin", version: "0.5.25" } }} } }, null, 2) + "\n",
      });
      await capture(ctx);
      const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, Record<string, unknown>>> };
      expect(lock.items["community"]?.["foreign"]).toEqual({ source: { kind: "plugin", version: "0.5.25" } }); // carried forward, untouched — no v2 payload invented for an item this run never captured
      expect(lock.items["obsidian"]?.["hotkeys"]).toEqual(capturedEntry({ source: { kind: "app", version: plugins.getAppVersion() } })); // fresh registry entry wins over 0.0.9
    });

    it("capture still drops the entry of a registry group whose plugin is uninstalled (carry-forward is for foreign names only)", async () => {
      const io = new MemFS();
      const plugins = new FakePlugins(); // "demo" NOT installed
      const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T12:00:00.000Z", switchExceptions: {} };
      await writeGroups(ctx, [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }]);
      io.seed({
        ".obs/plugins/demo/data.json": '{"a":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T09:00:00.000Z", items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} } }, null, 2) + "\n",
      });
      await capture(ctx);
      const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, Record<string, unknown>>> };
      expect(lock.items["community"]?.["demo"]).toBeUndefined(); // registry name: the no-version drop stands, never resurrected
    });

    it("pull converges the 'newer version info' hint for a store-only remote lock entry (repro)", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      io.seed({
        "cs/store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
        "cs/store/configdir/hotkeys.json": '{"a":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "T", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
      });
      const remoteLock = {
        capturedAt: "T",
        items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }}, "legacy": {"other-contract": { source: { kind: "plugin", version: "3.1.0" } }} },
      };
      const remote = {
        "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
        "store/configdir/hotkeys.json": '{"a":1}',
        "store.lock.json": JSON.stringify(remoteLock),
      };

      const before = await io.read("cs/store.lock.json");
      expect(remoteLockAhead(before, JSON.stringify(remoteLock), [])).toBe(true);

      const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
      expect(pending.plan.conflicts).toEqual([]);
      await applyImport(ctx, pending, []);

      const after = await io.read("cs/store.lock.json");
      expect(remoteLockAhead(after, JSON.stringify(remoteLock), [])).toBe(false);
    });

    it("excludeSelf: a differing self lock entry is ignored and still converges", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      io.seed({
        "cs/store/configdir/hotkeys.json": '{"a":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "T", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
      });
      const remoteLock = {
        capturedAt: "T",
        items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }}, "community": {"config-sync": { source: { kind: "plugin", version: "2.13.2" } }} },
      };
      const remote = {
        "store/configdir/hotkeys.json": '{"a":1}',
        "store.lock.json": JSON.stringify(remoteLock),
      };
      const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [SELF_ITEM_REF] });
      await applyImport(ctx, pending, []);
      const after = await io.read("cs/store.lock.json");
      expect(remoteLockAhead(after, JSON.stringify(remoteLock), ["community/config-sync"])).toBe(false);
      const afterLock = JSON.parse(after) as { items: Record<string, Record<string, unknown>> };
      expect(afterLock.items["community"]?.["config-sync"]).toBeUndefined();
    });

    it("a file conflict resolved 'local' keeps the local lock lineage (not overwritten by remote)", async () => {
      const { io, ctx } = setup();
      await writeGroups(ctx, [HOTKEYS_GROUP]);
      io.seed({
        "cs/store/configdir/hotkeys.json": '{"a":1}',
        "cs/store.lock.json": JSON.stringify({ capturedAt: "T", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "LOCAL" } }} } }),
      });
      const remoteLock = { capturedAt: "T", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "REMOTE" } }} } };
      const remote = {
        "store/configdir/hotkeys.json": '{"b":2}',
        "store.lock.json": JSON.stringify(remoteLock),
      };
      const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
      const conflicts = pending.plan.conflicts.filter((c) => c.kind === "file");
      expect(conflicts.length).toBe(1);
      await applyImport(ctx, pending, ["local"]);
      const after = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
      expect(after.items["obsidian"]?.["hotkeys"]?.source?.version).toBe("LOCAL");
    });

    // spec 2026-08-11-data-model-hardening.md, the pull half of the writers' carry. The merge
    // builds the lock from a fresh literal, so without this it strips the top-level keys's
    // parser just went to the trouble of keeping — and then pushes the loss back to the remote.
    describe("the v2 payload survives a pull", () => {
      const localLock = {
        version: 3,
        syncedWatermark: "2026-07-30T07:00:00.000Z",
        capturedAt: "2026-07-30T08:00:00.000Z",
        localOnlyTail: { mine: true },
        groups: {
          hotkeys: { source: { kind: "app", version: "1.0.0" }, capturedAt: "2026-07-30T08:00:00.000Z", hash: "h1", entryTailOnlyHere: "keep me" },
        },
      };
      const remoteLock = {
        version: 3,
        syncedWatermark: "2026-07-30T09:00:00.000Z",
        capturedAt: "2026-07-30T09:00:00.000Z",
        remoteOnlyTail: { theirs: true },
        items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "2.0.0" }, capturedAt: "2026-07-30T09:00:00.000Z", hash: "h2", futureField: [1, 2] }} },
      };

      const pull = async (local: object, remote: object): Promise<{ io: MemFS; raw: string }> => {
        const { io, ctx } = setup();
        await writeGroups(ctx, [HOTKEYS_GROUP]);
        io.seed({ "cs/store/configdir/hotkeys.json": '{"a":1}', "cs/store.lock.json": JSON.stringify(local) });
        const pending = await planImport(
          ctx,
          fakeReader({ "store/configdir/hotkeys.json": '{"a":1}', "store.lock.json": JSON.stringify(remote) }),
          { skipRefs: [] }
        );
        await applyImport(ctx, pending, []);
        return { io, raw: await io.read("cs/store.lock.json") };
      };

      it("carries both sides' unknown keys, stamps the current version, and converges the hint", async () => {
        const { raw } = await pull(localLock, remoteLock);
        const merged = JSON.parse(raw) as StoreLock;
        expect(merged.version).toBe(3); // a SUCCESSFUL pull declares the format too, not only capture
        expect(merged["localOnlyTail"]).toEqual({ mine: true }); // ours survives the rebuild…
        expect(merged["remoteOnlyTail"]).toEqual({ theirs: true }); // …and theirs is adopted, not dropped on the way back out
        const hotkeys = merged.items["obsidian"]?.["hotkeys"];
        expect(hotkeys?.["futureField"]).toEqual([1, 2]);
        // The adopted entry wins every field it HAS — the content is the remote's now…
        expect(hotkeys?.source?.version).toBe("2.0.0");
        expect(hotkeys?.hash).toBe("h2");
        // …but a key only OUR entry carried is not the remote's to delete. Keeping it is
        // convergence-safe, since only keys present on BOTH sides are ever weighed.
        expect(hotkeys?.["entryTailOnlyHere"]).toBe("keep me");
        // The pull is the only writer that moves the lineage, and moving it is what settles the hint.
        expect(merged.syncedWatermark).toBe("2026-07-30T09:00:00.000Z");
        expect(remoteLockAhead(raw, JSON.stringify(remoteLock), [])).toBe(false);
        expect(JSON.stringify(parseStoreLock(raw), null, 2) + "\n").toBe(raw); // same byte-stable order capture writes
      });

      it("recomputes capturedAt from the merged items and never moves it backwards", async () => {
        const olderRemote = {
          ...remoteLock,
          syncedWatermark: "2026-07-30T06:00:00.000Z",
          capturedAt: "2026-07-30T06:00:00.000Z",
          items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "0.9.0" }, capturedAt: "2026-07-30T06:00:00.000Z", hash: "h0" }} },
        };
        const { raw } = await pull(localLock, olderRemote);
        const merged = JSON.parse(raw) as StoreLock;
        // The remote's whole-store stamp is never copied over it (that conflation is what split),
        // and a pull is additive — the store it produces cannot be older than the one it started from.
        expect(merged.capturedAt).toBe("2026-07-30T08:00:00.000Z");
      });

      it("re-dates and re-fingerprints a locally-kept group whose remote-only files still landed", async () => {
        // The one counterexample to "only a capture changes store content, and a capture re-dates
        // what it captured": the user keeps `one.css` local, so the entry is NOT adopted from the
        // remote — but `two.css` lands anyway, and the entry would otherwise keep describing a store
        // copy that no longer exists. Items-first believes an equal hash outright, so a stamp that
        // outran its content is exactly what must not survive here.
        const { io, ctx } = setup();
        await writeGroups(ctx, [SNIPPETS_GROUP]);
        io.seed({
          "cs/store/configdir/snippets/one.css": "local",
          "cs/store.lock.json": JSON.stringify({
            version: 3,
            syncedWatermark: "2026-07-30T07:00:00.000Z",
            capturedAt: "2026-07-30T07:00:00.000Z",
            items: { "legacy": {"snippets": { source: { kind: "app", version: "1.0.0" }, capturedAt: "2026-07-30T07:00:00.000Z", hash: "sha256:stale" }} },
          }),
        });
        const remote = {
          "store/configdir/snippets/one.css": "remote", // conflicts — kept local below
          "store/configdir/snippets/two.css": "extra", // remote-only — lands regardless
          "store.lock.json": JSON.stringify({
            version: 3,
            syncedWatermark: "2026-07-30T09:00:00.000Z",
            capturedAt: "2026-07-30T09:00:00.000Z",
            items: { "legacy": {"snippets": { source: { kind: "app", version: "2.0.0" }, capturedAt: "2026-07-30T09:00:00.000Z", hash: "sha256:theirs" }} },
          }),
        };
        const pending = await planImport(ctx, fakeReader(remote), { skipRefs: [] });
        expect(pending.plan.conflicts.filter((c) => c.kind === "file").length).toBe(1);
        await applyImport(ctx, pending, ["local"]);

        expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("local"); // the user's choice stands
        expect(await io.read("cs/store/configdir/snippets/two.css")).toBe("extra"); // …and the store still changed
        const entry = lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "legacy/snippets");
        expect(entry?.source?.version).toBe("1.0.0"); // still the local lineage, not adopted
        expect(entry?.capturedAt).toBe("2026-07-08T00:00:00.000Z"); // ctx.now() — the store moved
        expect(entry?.hash).not.toBe("sha256:stale");
        expect(entry?.hash).not.toBe("sha256:theirs"); // it is neither side's copy now
        expect(entry?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      it("a v1 remote still converges: its capturedAt is the lineage it has", async () => {
        const v1Remote = { capturedAt: "2026-07-30T09:00:00.000Z", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "2.0.0" } }} } };
        const { raw } = await pull(localLock, v1Remote);
        expect((JSON.parse(raw) as StoreLock).syncedWatermark).toBe("2026-07-30T09:00:00.000Z");
        expect(remoteLockAhead(raw, JSON.stringify(v1Remote), [])).toBe(false);
      });
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
    // The remote's own lock, byte-identical to the local one so the push skips it — a remote with
    // content and no lock is a refusal now, not a push target.
    const fw = fakeWriter({ "store.lock.json": '{"capturedAt":"t","groups":{}}', "store/gone.css": "stale" });
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [] });
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
      "cs/store.lock.json": '{"capturedAt":"t","groups":{}}',
      "cs/store/configdir/hotkeys.json": '{"a":1}',
      "cs/store/configdir/snippets/one.css": "one",
    });
    await seedGroups(ctx, MANIFEST);
    const fw = fakeWriter({
      "store.lock.json": '{"capturedAt":"t","groups":{}}', // the remote's bookkeeping, identical -> skipped
      "store/configdir/hotkeys.json": '{"a":1}', // identical to local -> must not be rewritten
    });
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [] });
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
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [] });
    expect(fw.files["store/configdir/hotkeys.json"]).toBe("{}");
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("a lock file alone (no store/** tree) also satisfies the store-presence check", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/store.lock.json": '{"capturedAt":"t","groups":{}}' });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({});
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [] });
    expect(fw.files["store.lock.json"]).toBe('{"capturedAt":"t","groups":{}}');
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("refuses to push when the local store has no captured data at all", async () => {
    const { ctx } = setup();
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({});
    await expect(pushExternal(ctx, fw.writer, { skipRefs: [] })).rejects.toThrow("capture from this device");
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
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [] });
    expect(fw.files["config-sync.json"]).toBe("OLD-REMOTE"); // untouched: never written, never deleted
    expect(fw.files["config-sync.json.migrated-2026-01-01T00-00-00"]).toBeUndefined();
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("excludeSelf: push neither writes the local self copy nor mirror-deletes the remote's", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": '{"capturedAt":"t","groups":{}}',
      "cs/store/configdir/plugins/config-sync/data.json": '{"mine":true}',
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({
      "store.lock.json": '{"capturedAt":"t","groups":{}}', // identical to local -> skipped
      "store/configdir/plugins/config-sync/data.json": '{"theirs":true}',
    });
    const results = await pushExternal(ctx, fw.writer, { skipRefs: [SELF_ITEM_REF] });
    expect(fw.files["store/configdir/plugins/config-sync/data.json"]).toBe('{"theirs":true}'); // untouched both ways
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"a":1}');
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
    const bad = [{ name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "folder" as const, devices: "all" as const, mode: "fields" as const, fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }] }];
    await expect(writeGroups(ctx, bad)).rejects.toThrow("per-key rules only apply to a single file");
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
    const g: SyncGroup = withRef({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" });
    await writeGroups(ctx, [g]);
    expect(await readGroups(ctx)).toEqual([g]);
    expect(await ctx.io.exists(`${ctx.rootPath}/config-sync.json`)).toBe(false); // no file written
  });
});

// Two halves: the payload capture writes, and the CARRY
// — the parser keeps unknown keys, but capture rebuilds the whole lock and each
// captured entry from its own values, so without the carry here that parser work is theatre and
// the format still cannot evolve.
describe("store.lock.json v2 payload — capture", () => {
  const TWO_GROUPS = JSON.stringify({
    version: 1,
    groups: [
      { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
      { name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all" },
    ],
  });
  const PREVIOUS = JSON.stringify({
    version: 2,
    syncedWatermark: "2026-07-01T00:00:00.000Z",
    capturedAt: "2026-07-01T00:00:00.000Z",
    fleetNotes: { from: "a newer build" }, // an unknown TOP-LEVEL key
    items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" }, perMemberFreshness: { x: 1 } }} }, // an unknown ENTRY key
  });

  it("stamps version, watermark and per-item provenance, and carries what it does not write", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": '{"a":1}', ".obs/snippets/one.css": "one", "cs/store.lock.json": PREVIOUS });
    await seedGroups(ctx, TWO_GROUPS);
    await capture(ctx);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as StoreLock;
    expect(lock.version).toBe(3);
    // Lineage belongs to the pull: a capture must not claim to have seen a state it has not seen.
    expect(lock.syncedWatermark).toBe("2026-07-01T00:00:00.000Z");
    expect(lock.capturedAt).toBe("2026-07-08T00:00:00.000Z"); // max(groups[*].capturedAt)
    expect(lock["fleetNotes"]).toEqual({ from: "a newer build" });
    const hotkeys = lock.items["obsidian"]?.["hotkeys"];
    expect(hotkeys?.["perMemberFreshness"]).toEqual({ x: 1 }); // the rebuilt entry kept the tail…
    expect(hotkeys?.source).toEqual({ kind: "app", version: "1.8.7" }); // …and the known field is still REPLACED, not merged
    expect(hotkeys?.capturedAt).toBe("2026-07-08T00:00:00.000Z");
    expect(hotkeys?.hash).toMatch(/^sha256:[0-9a-f]{64}$/); //'s documented shape — the algorithm names itself
  });

  it("writes the key order parseStoreLock re-emits, so a round trip is byte-stable", async () => {
    // The parser's fixed order is kept for byte stability — the lock is a file inside a vault that
    // other tools sync and version. That argument only holds if the WRITERS agree with it.
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": '{"a":1}', ".obs/snippets/one.css": "one", "cs/store.lock.json": PREVIOUS });
    await seedGroups(ctx, TWO_GROUPS);
    await capture(ctx);
    const written = await io.read("cs/store.lock.json");
    expect(JSON.stringify(parseStoreLock(written), null, 2) + "\n").toBe(written);
  });

  it("the hash follows the item's store content, not the run", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] }));
    await capture(ctx);
    const first = lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "obsidian/hotkeys")?.hash;
    await capture(ctx);
    expect(lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "obsidian/hotkeys")?.hash).toBe(first);
    await io.write(".obs/hotkeys.json", '{"a":2}');
    await capture(ctx);
    expect(lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "obsidian/hotkeys")?.hash).not.toBe(first);
  });

  it("the hash covers the per-device-class sidecars, not just the base file", async () => {
    // A sidecar is store content: it holds a class's shared values and travels like any other file.
    // A hash blind to it would let two stores differing ONLY in a sidecar read as identical, and the
    // items-first comparison believes an equal hash outright — so the pull would never be offered.
    const SCOPED = JSON.stringify({
      version: 1,
      groups: [
        {
          name: "plugin-demo",
          path: "{configDir}/plugins/demo/data.json",
          type: "file",
          devices: "all",
          mode: "fields",
          fields: [{ pattern: "desktopKey", sharing: perClass("desktop"), encrypted: false }],
        },
      ],
    });
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({ ".obs/plugins/demo/data.json": JSON.stringify({ shared: 1, desktopKey: "a" }) });
    await seedGroups(ctx, SCOPED);
    await capture(ctx);
    const base = await io.read("cs/store/configdir/plugins/demo/data.json");
    const first = lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "community/demo")?.hash;

    // Only the desktop-scoped value moves: the base file stays byte-identical, the sidecar does not.
    await io.write(".obs/plugins/demo/data.json", JSON.stringify({ shared: 1, desktopKey: "b" }));
    await capture(ctx);
    expect(await io.read("cs/store/configdir/plugins/demo/data.json")).toBe(base);
    expect(await io.read("cs/store/configdir/plugins/demo/data.json.__scopes__.desktop.json")).toContain("b");
    expect(lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "community/demo")?.hash).not.toBe(first);
  });

  it("leaves the hash absent for an item whose store copy is ciphertext", async () => {
    const { io, ctx } = setup();
    ctx.passphrase = "pw";
    io.seed({ ".obs/secrets.json": '{"token":"x"}' });
    await seedGroups(
      ctx,
      JSON.stringify({ version: 1, groups: [{ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" }] })
    );
    await capture(ctx);
    const entry = lockEntry(JSON.parse(await io.read("cs/store.lock.json")) as StoreLock, "legacy/secrets");
    // Every envelope carries its own salt and nonce, so two devices holding the SAME settings hold
    // different ciphertext. A hash that can never match is worse than none: the item is dated instead.
    expect(entry?.hash).toBeUndefined();
    expect(entry?.capturedAt).toBe("2026-07-08T00:00:00.000Z");
  });

  it("a partial capture dates only the items it touched, and the store stamp follows them", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": '{"a":1}', ".obs/snippets/one.css": "one" });
    await seedGroups(ctx, TWO_GROUPS);
    await capture(ctx);
    const later: CoreContext = { ...ctx, now: () => "2026-07-09T00:00:00.000Z" };
    await io.write(".obs/hotkeys.json", '{"a":2}');
    await capture(later, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as StoreLock;
    expect(lock.items["obsidian"]?.["hotkeys"]?.capturedAt).toBe("2026-07-09T00:00:00.000Z");
    expect(lock.items["legacy"]?.["snippets"]?.capturedAt).toBe("2026-07-08T00:00:00.000Z"); // untouched, and not re-dated
    expect(lock.capturedAt).toBe("2026-07-09T00:00:00.000Z"); // the newest item's stamp
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
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["obsidian"]?.["hotkeys"]).toEqual(capturedEntry({ source: { kind: "app", version: "1.8.7" } }));
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" } }));
  });
});

// The lock is the label's carrier for
// not-installed plugins, so capture must resolve and record it the same way the registry does —
// runtime plugin/core name, never the raw id.
describe("capture records a group label", () => {
  it("records the installed plugin's runtime name for a plugin group", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.installedNames.set("demo", "Demo Plugin");
    io.seed({ ".obs/plugins/demo/data.json": "{}" });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["plugin-demo"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["demo"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "1.2.3" }, display: { label: "Demo Plugin" } }));
  });

  it("records the core plugin's runtime name for a core-settings group", async () => {
    const { io, ctx, plugins } = setup();
    plugins.coreNames.set("daily-notes", "Daily notes"); // "daily-notes" is a CORE_ID_SEED member (catalog.ts)
    io.seed({ ".obs/daily-notes.json": "{}" });
    await seedGroups(
      ctx,
      JSON.stringify({ version: 1, groups: [{ name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" }] })
    );
    await capture(ctx, ["daily-notes"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["core"]?.["daily-notes"]).toEqual(capturedEntry({ source: { kind: "app", version: "1.8.7" }, display: { label: "Daily notes" } }));
  });

  it("omits the label for an Obsidian option group (no runtime name to resolve)", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/hotkeys.json": "{}" });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["obsidian"]?.["hotkeys"]).toEqual(capturedEntry({ source: { kind: "app", version: "1.8.7" } }));
  });

  // pluginIdForGroup also resolves for a companion dir
  // (group name = folder basename, not "plugin-<id>") and for custom rules on a plugin path.
  // Only the canonical "plugin-<id>" group may carry the community label — otherwise
  // displayLabelForGroup's storedLabel-fallback branch renders the companion as "Dataview › Dataview".
  it("omits the label for a companion dir group on a plugin path (not the canonical plugin-<id> group)", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("dataview", "0.5.0");
    plugins.installedNames.set("dataview", "Dataview");
    io.seed({ ".obs/plugins/dataview/cache.json": "{}" });
    await seedGroups(
      ctx,
      JSON.stringify({ version: 1, groups: [{ name: "dataview", path: "{configDir}/plugins/dataview", type: "folder", devices: "all" }] })
    );
    await capture(ctx, ["dataview"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["legacy"]?.["dataview"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "0.5.0" } }));
  });

  it("still records the label for the canonical plugin-<id> group", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("dataview", "0.5.0");
    plugins.installedNames.set("dataview", "Dataview");
    io.seed({ ".obs/plugins/dataview/data.json": "{}" });
    await seedGroups(
      ctx,
      JSON.stringify({ version: 1, groups: [{ name: "plugin-dataview", path: "{configDir}/plugins/dataview/data.json", type: "file", devices: "all" }] })
    );
    await capture(ctx, ["plugin-dataview"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["dataview"]).toEqual(capturedEntry({ source: { kind: "plugin", version: "0.5.0" }, display: { label: "Dataview" } }));
  });
});

// Capture's
// own tail heal call (backfillLockLabels, wired with the store content this run just wrote) is
// the writer for a captured carrier's memberLabels — COMMUNITY_MANIFEST/CORE_MANIFEST are defined
// further down this file (switch-list exceptions describe block) but usable here: vitest runs
// `it` bodies only after the whole module has finished evaluating.
describe("capture records carrier memberLabels", () => {
  it("records memberLabels for every resolvable id in the community carrier's resulting store list", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    plugins.installedNames.set("templater", "Templater");
    io.seed({ ".obs/community-plugins.json": JSON.stringify(["dataview", "templater", "not-installed-anywhere"]) });
    await seedGroups(ctx, COMMUNITY_MANIFEST);
    await capture(ctx, ["community-plugins"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual(
      capturedEntry({ source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview", templater: "Templater" } } })
    );
  });

  it("records memberLabels for every resolvable id in the core carrier's resulting store list (map shape)", async () => {
    const { io, plugins, ctx } = setup();
    plugins.coreNames.set("daily-notes", "Daily notes");
    io.seed({ ".obs/core-plugins.json": JSON.stringify({ "daily-notes": true, graph: false }) });
    await seedGroups(ctx, CORE_MANIFEST);
    await capture(ctx, ["core-plugins"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["obsidian"]?.["core-plugins"]).toEqual(capturedEntry({ source: { kind: "app", version: "1.8.7" }, display: { elements: { "daily-notes": "Daily notes" } } }));
  });
});

// A group entry born without a resolved label
// (or from an all-in-sync run that never touched it) stays
// label-less forever without a dedicated heal — backfillLockLabels is that heal, run at the tail
// of every capture and once at startup (main.ts) so the remote pane always has a name to show.
//
// carrierLists is irrelevant to these single-label cases — both
// carriers null means "nothing to heal there".
const NO_CARRIER_LISTS: Record<"core-plugins" | "community-plugins", SwitchList | null> = {
  "core-plugins": null,
  "community-plugins": null,
};

describe("backfillLockLabels", () => {
  const PLUGIN_DEMO_GROUP: SyncGroup = withRef({ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" });
  const PLUGIN_FOO_GROUP: SyncGroup = withRef({ name: "plugin-foo", path: "{configDir}/plugins/foo/data.json", type: "file", devices: "all" });
  // "daily-notes" is a CORE_ID_SEED member (catalog.ts) — resolvable without any special setup.
  const CORE_GROUP: SyncGroup = withRef({ name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" });

  it("fills in labels for label-less resolvable community and core entries", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    plugins.coreNames.set("daily-notes", "Daily notes");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }}, "core": {"daily-notes": { source: { kind: "app", version: "1.8.7" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP, CORE_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(changed).toBe(true);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } });
    expect(lock.items["core"]?.["daily-notes"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { label: "Daily notes" } });
  });

  it("leaves a not-installed community entry untouched", () => {
    const { plugins } = setup(); // plugins.installedNames has nothing for "foo" — not installed
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"foo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_FOO_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(changed).toBe(false);
    expect(lock.items["community"]?.["foo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" } });
  });

  it("refreshes a stale label", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Renamed Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(changed).toBe(true);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Renamed Plugin" } });
  });

  it("reports no change (and leaves the lock untouched) when every label is already current", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(changed).toBe(false);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } });
  });

  it("never touches capturedAt", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(lock.capturedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not resolve a label for an entry with no matching local group (orphaned/dropped)", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, NO_CARRIER_LISTS); // manifest no longer declares plugin-demo
    expect(changed).toBe(false);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" } });
  });
});

// The tail heal must not
// resurrect/write a lock entry for a group THIS device has opted out of, even when it's otherwise
// perfectly resolvable — `excluded` is a bare extra skip check ahead of the existing entry lookup.
describe("backfillLockLabels — excluded", () => {
  const PLUGIN_DEMO_GROUP: SyncGroup = withRef({ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" });

  it("skips a label-less resolvable entry that is in the excluded set", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS, new Set(["community/demo"]));
    expect(changed).toBe(false);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" } }); // no label written
  });

  it("an omitted excluded set heals every resolvable entry", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS);
    expect(changed).toBe(true);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } });
  });

  it("excluding an unrelated name leaves this group's heal unaffected", () => {
    const { plugins } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} },
    };
    const changed = backfillLockLabels([PLUGIN_DEMO_GROUP], plugins, lock, NO_CARRIER_LISTS, new Set(["plugin-other"]));
    expect(changed).toBe(true);
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo Plugin" } });
  });
});

// Runner-level payload guard — the pure filter main.ts's captureItems/applyItems
// call before a CaptureItem[]/ApplyItem[] ever reaches captureWithActions/applyWithActions.
describe("excludeOptedOutItems", () => {
  it("drops an item whose name is in the opted-out set", () => {
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(excludeOptedOutItems(items, new Set(["b"]), (n) => n)).toEqual([{ name: "a" }, { name: "c" }]);
  });

  it("an empty opted-out set is a no-op", () => {
    const items = [{ name: "a" }, { name: "b" }];
    expect(excludeOptedOutItems(items, new Set(), (n) => n)).toEqual(items);
  });

  it("works over ApplyItem/CaptureItem-shaped objects (extra fields pass through untouched)", () => {
    const items = [
      { name: "a", action: "none" as const },
      { name: "b", action: "enable" as const },
    ];
    expect(excludeOptedOutItems(items, new Set(["b"]), (n) => n)).toEqual([{ name: "a", action: "none" }]);
  });
});

// capture()'s own tail-heal call threads optedOutForHeal straight into
// backfillLockLabels — an end-to-end proof the two unit-tested pieces above actually wire together.
describe("capture — optedOutForHeal threads through to the tail heal", () => {
  it("an opted-out group's stale/label-less lock entry is carried forward but never healed", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installedNames.set("demo", "Demo Plugin");
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", items: { "community": {"demo": { source: { kind: "plugin", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, MANIFEST);
    // Simulate the host-level payload filter (main.ts's captureItems): "plugin-demo" is opted out,
    // so it's never in `names` — capture() carries its lock entry forward unchanged (existing
    // partial-selection behavior), and the tail heal must not resolve its label either.
    await capture(ctx, ["hotkeys"], undefined, undefined, new Set(["community/demo"]));
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.0.0" } }); // no label written
  });
});

// The two
// carrier lock entries (core-plugins, community-plugins) additionally carry memberLabels — a name
// for every CURRENT store-list member this device can resolve, healed the same way the single
// label above is (write-only-on-change, capturedAt untouched).
describe("backfillLockLabels memberLabels", () => {
  it("fills in memberLabels for every resolvable id in the community carrier's current store list", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    plugins.installedNames.set("templater", "Templater");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview", "templater", "unresolvable"] });
    expect(changed).toBe(true);
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({
      source: { kind: "app", version: "1.8.7" },
      display: { elements: { dataview: "Dataview", templater: "Templater" } },
    });
  });

  it("fills in memberLabels for every resolvable id in the core carrier's current store list (map shape)", () => {
    const { plugins } = setup();
    plugins.coreNames.set("daily-notes", "Daily notes");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"core-plugins": { source: { kind: "app", version: "1.8.7" } }} },
    };
    const changed = backfillLockLabels(
      [],
      plugins,
      lock,
      { "core-plugins": { "daily-notes": true, "not-a-core-id": false }, "community-plugins": null }
    );
    expect(changed).toBe(true);
    expect(lock.items["obsidian"]?.["core-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { elements: { "daily-notes": "Daily notes" } } });
  });

  it("leaves an unresolvable-only store list without a memberLabels field (no change)", () => {
    const { plugins } = setup(); // nothing installed
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["unresolvable"] });
    expect(changed).toBe(false);
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" } });
  });

  it("reports no change when memberLabels are already current", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview" } } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview"] });
    expect(changed).toBe(false);
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview" } } });
  });

  it("skips a carrier with no lock entry of its own", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: {},
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview"] });
    expect(changed).toBe(false);
    expect(lock.items["obsidian"]?.["community-plugins"]).toBeUndefined();
  });

  it("never touches capturedAt when only memberLabels change", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "2026-01-01T00:00:00.000Z",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" } }} },
    };
    backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview"] });
    expect(lock.capturedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // The heal must MERGE additively — a name
  // this device can't resolve locally must survive from the existing map, never get erased just
  // because this device's own plugin set is narrower. The failure shape: seeded
  // {completr, dataview}, a device with only dataview installed heals the map down to
  // {dataview} — completr's name is gone.
  it("superset preservation: a name unresolvable on THIS device survives the heal", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview"); // "completr" is NOT installed here
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" }, display: { elements: { completr: "Completr", dataview: "Dataview" } } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["completr", "dataview"] });
    expect(changed).toBe(false); // already converged — merge is a no-op
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({
      source: { kind: "app", version: "1.8.7" },
      display: { elements: { completr: "Completr", dataview: "Dataview" } },
    });
  });

  it("drops an id no longer in the current store list, even though its existing name was known", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" }, display: { elements: { completr: "Completr", dataview: "Dataview" } } }} },
    };
    // "completr" no longer appears in the store list (uninstalled/removed everywhere) — dropped.
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview"] });
    expect(changed).toBe(true);
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview" } } });
  });

  it("local resolution refreshes a stale existing name for an id this device CAN resolve", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview (renamed)");
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview (stale)" } } }} },
    };
    const changed = backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["dataview"] });
    expect(changed).toBe(true);
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview (renamed)" } } });
  });

  it("two-device convergence: kickstart's heal (both installed) then llm's heal (only dataview installed) leave the map unchanged", () => {
    const store: SwitchList = ["completr", "dataview"];
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": { source: { kind: "app", version: "1.8.7" } }} },
    };

    const kickstart = new FakePlugins();
    kickstart.installedNames.set("completr", "Completr");
    kickstart.installedNames.set("dataview", "Dataview");
    backfillLockLabels([], kickstart, lock, { "core-plugins": null, "community-plugins": store });
    expect(lock.items["obsidian"]?.["community-plugins"]?.display?.elements).toEqual({ completr: "Completr", dataview: "Dataview" });

    const beforeLlmHeal = { ...lock.items["obsidian"]?.["community-plugins"]?.display?.elements };
    const llm = new FakePlugins();
    llm.installedNames.set("dataview", "Dataview"); // llm never had completr installed
    const changed = backfillLockLabels([], llm, lock, { "core-plugins": null, "community-plugins": store });
    expect(changed).toBe(false); // no-op: llm's merge carries completr's name forward unchanged
    expect(lock.items["obsidian"]?.["community-plugins"]?.display?.elements).toEqual(beforeLlmHeal);
  });

  it("write-only-on-change still holds when the merge is a genuine no-op", () => {
    const { plugins } = setup();
    plugins.installedNames.set("dataview", "Dataview");
    const entry: StoreLockEntry = { source: { kind: "app", version: "1.8.7" }, display: { elements: { completr: "Completr", dataview: "Dataview" } } };
    const lock: StoreLock = {
      version: STORE_LOCK_VERSION,
      capturedAt: "t",
      items: { "obsidian": {"community-plugins": entry} },
    };
    backfillLockLabels([], plugins, lock, { "core-plugins": null, "community-plugins": ["completr", "dataview"] });
    // Same object identity — no rewrite happened, not just an equal-by-value replacement.
    expect(lock.items["obsidian"]?.["community-plugins"]).toBe(entry);
  });
});

describe("capture backfills carried-forward entries' labels at the tail of the run", () => {
  it("heals a label-less carried-forward entry even though this run didn't select it", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({ ".obs/hotkeys.json": "{}", ".obs/plugins/demo/data.json": "{}" });
    await seedGroups(ctx, MANIFEST);
    // First capture predates label resolution (simulated): write a lock entry with no label.
    await capture(ctx);
    await io.write(
      "cs/store.lock.json",
      JSON.stringify({ capturedAt: "2026-07-08T00:00:00.000Z", items: { "community": {"demo": { source: { kind: "plugin", version: "1.2.3" } }} } }, null, 2) + "\n"
    );
    // The plugin only becomes resolvable NOW — a real capture run must still heal it, even
    // though this run only selects "hotkeys" and never touches plugin-demo directly.
    plugins.installedNames.set("demo", "Demo Plugin");
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, unknown>> };
    expect(lock.items["community"]?.["demo"]).toEqual({ source: { kind: "plugin", version: "1.2.3" }, display: { label: "Demo Plugin" } });
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
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] }));
    const remoteFiles: Record<string, string> = {
      "store/configdir/hotkeys.json": '{"a":2}', // identical content
      "store.lock.json": JSON.stringify({ capturedAt: "newer", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "2.0.0" } }} } }),
    };
    const reader: ExternalStoreReader = {
      listFiles: async () => Object.keys(remoteFiles),
      readFile: async (rel) => remoteFiles[rel]!,
    };
    const pending = await planImport(ctx, reader, { skipRefs: [] });
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; syncedWatermark: string; items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["obsidian"]?.["hotkeys"]?.source?.version).toBe("2.0.0"); // adopted despite zero file writes
    // Two fields, two meanings: the remote's lineage lands on
    // syncedWatermark (which is what makes remoteLockAhead settle), while capturedAt keeps
    // describing this store's own content and is never overwritten with the remote's stamp.
    expect(lock.syncedWatermark).toBe("newer");
    expect(lock.capturedAt).toBe("old");
  });

  it("locally-kept groups keep their local lock entries", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/hotkeys.json": '{"a":2}',
      "cs/store/configdir/hotkeys.json": '{"local":"only"}', // differs → conflict
      "cs/store.lock.json": JSON.stringify({ capturedAt: "old", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "1.0.0" } }} } }),
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] }));
    const remoteFiles: Record<string, string> = {
      "store/configdir/hotkeys.json": '{"remote":"side"}',
      "store.lock.json": JSON.stringify({ capturedAt: "newer", items: { "obsidian": {"hotkeys": { source: { kind: "app", version: "2.0.0" } }} } }),
    };
    const reader: ExternalStoreReader = { listFiles: async () => Object.keys(remoteFiles), readFile: async (rel) => remoteFiles[rel]! };
    const pending = await planImport(ctx, reader, { skipRefs: [] });
    expect(pending.plan.conflicts.length).toBe(1);
    await applyImport(ctx, pending, ["local"]); // keep local content
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { items: Record<string, Record<string, StoreLockEntry>> };
    expect(lock.items["obsidian"]?.["hotkeys"]?.source?.version).toBe("1.0.0"); // content stayed local → lock stays local
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

    // Mask table: always-here → exception + forceOn. The
    // member is off locally AND off in the store list, yet an always-here rule still turns it on.
    it("switchForceOn turns on an always-here member that is off locally and off in the store", async () => {
      const { io, ctx } = setup();
      ctx.switchExceptions["community-plugins"] = ["always-on"];
      ctx.switchForceOn = { "community-plugins": ["always-on"] };
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a"]),
        ".obs/community-plugins.json": JSON.stringify(["a"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await apply(ctx, ["community-plugins"]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "always-on"]);
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
      const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
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
      const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
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
      const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
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
      const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
      expect(statuses[0]?.state).not.toBe("in-sync");
    });
  });
});

describe("partial-selection switch staging", () => {
  describe("applyWithActions with ApplyItem.stagedMembers", () => {
    it("stages a subset — only staged members flip, delta message shrinks to them", async () => {
      const { io, ctx } = setup();
      io.seed({
        ".obs/community-plugins.json": JSON.stringify(["keep"]),
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep", "a", "b"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await applyWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: ["a"] }], async () => "9.9.9");
      const r = results.find((x) => x.group === "community-plugins");
      expect(r?.messages).toEqual(["turns on: a"]);
      // "b" is unstaged — it keeps its local value (absent). Only "a" was staged, so it's the
      // one non-excepted (store-synced) id; "keep" is unstaged, so it passes through from local.
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "keep"]);
    });

    it("stagedMembers: [] writes settings but touches no switches", async () => {
      const { io, ctx } = setup();
      io.seed({
        ".obs/community-plugins.json": JSON.stringify(["keep"]),
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep", "a"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await applyWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: [] }], async () => "9.9.9");
      const r = results.find((x) => x.group === "community-plugins");
      expect(r?.status).not.toBe("error");
      expect(r?.messages).toEqual([]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["keep"]);
    });

    it("stagedMembers undefined applies the whole list", async () => {
      const { io, ctx } = setup();
      io.seed({
        ".obs/community-plugins.json": JSON.stringify(["keep", "local-only"]),
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep", "store-only"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await applyWithActions(ctx, [{ name: "community-plugins", action: "none" }], async () => "9.9.9");
      const r = results.find((x) => x.group === "community-plugins");
      expect(r?.messages).toContain("turns on: store-only");
      expect(r?.messages).toContain("turns off: local-only");
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["keep", "store-only"]);
    });

    // subtractForceOff/addForceOn must not run unconditionally, ignoring
    // stagedMembers — a force-on/off mask could flip an UNSTAGED member's switch even with
    // stagedMembers: []. Masks are scoped to stagedMembers when it is provided.
    it("stagedMembers: [] leaves an active switchForceOn mask untouched", async () => {
      const { io, ctx } = setup();
      ctx.switchForceOn = { "community-plugins": ["always-on"] };
      io.seed({
        ".obs/community-plugins.json": JSON.stringify(["a"]),
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await applyWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: [] }], async () => "9.9.9");
      const r = results.find((x) => x.group === "community-plugins");
      expect(r?.messages).toEqual([]); // zero switch flips, even though the mask is active
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a"]);
    });

    it("a member both staged AND force-on still flips (a staged member's Runs-on rule still applies)", async () => {
      const { io, ctx } = setup();
      ctx.switchForceOn = { "community-plugins": ["always-on"] };
      io.seed({
        ".obs/community-plugins.json": JSON.stringify(["a"]),
        "cs/store/configdir/community-plugins.json": JSON.stringify(["a"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await applyWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: ["always-on"] }], async () => "9.9.9");
      const r = results.find((x) => x.group === "community-plugins");
      expect(r?.messages).toEqual(["turns on: always-on"]);
      expect(JSON.parse(await io.read(".obs/community-plugins.json"))).toEqual(["a", "always-on"]);
    });
  });

  describe("captureWithActions with CaptureItem.stagedMembers", () => {
    it("stages a subset — the store changes only for the staged id", async () => {
      const { io, ctx } = setup();
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep"]),
        ".obs/community-plugins.json": JSON.stringify(["keep", "a", "b"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await captureWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: ["a"] }]);
      expect(JSON.parse(await io.read("cs/store/configdir/community-plugins.json"))).toEqual(["keep", "a"]);
    });

    it("stagedMembers: [] writes settings but leaves the store's member set untouched", async () => {
      const { io, ctx } = setup();
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep"]),
        ".obs/community-plugins.json": JSON.stringify(["keep", "a"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      const results = await captureWithActions(ctx, [{ name: "community-plugins", action: "none", stagedMembers: [] }]);
      expect(results.find((r) => r.group === "community-plugins")?.status).not.toBe("error");
      expect(JSON.parse(await io.read("cs/store/configdir/community-plugins.json"))).toEqual(["keep"]);
    });

    it("stagedMembers undefined captures the whole list, byte-for-byte as today", async () => {
      const { io, ctx } = setup();
      io.seed({
        "cs/store/configdir/community-plugins.json": JSON.stringify(["keep"]),
        ".obs/community-plugins.json": JSON.stringify(["keep", "a", "b"]),
      });
      await seedGroups(ctx, COMMUNITY_MANIFEST);
      await captureWithActions(ctx, [{ name: "community-plugins", action: "none" }]);
      expect(JSON.parse(await io.read("cs/store/configdir/community-plugins.json"))).toEqual(["keep", "a", "b"]);
    });
  });
});

// A real ConfigSyncPlugin instance driven through bracket access to bypass TypeScript's `private`
// (compile-time-only), same as customGroups.test.ts — main.ts has no harness of its own (Plugin is
// stubbed to an empty class by tests/mock-obsidian.ts).
//
// Switch-mask behavior (exceptions, force masks, rule precedence) is covered by
// tests/enablementRuntime.test.ts, which asserts on coreContext()
// outputs against the stored rule + this device's own exception.
function fakePluginApp(): unknown {
  return {
    vault: {
      adapter: { exists: async () => false },
      configDir: "config-dir",
      on: () => ({}),
    },
    internalPlugins: { plugins: {} },
    plugins: { manifests: {}, enabledPlugins: new Set<string>(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
  };
}



interface DisplayNamePluginSurface {
  app: unknown;
  lastLock: StoreLock | null;
  displayName: (group: string, storedLabel?: string) => string;
  displayParts: (group: string, storedLabel?: string) => { parent: string | null; label: string };
}

function makeDisplayNamePlugin(lastLock: StoreLock | null): DisplayNamePluginSurface {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as DisplayNamePluginSurface;
  instance.app = fakePluginApp(); // empty manifests/internalPlugins — runtime name resolution always misses
  instance.lastLock = lastLock;
  return instance;
}

// The resolver order is
// runtime name -> stored (registry) label -> lock label -> id. Runtime always misses here
// (fakePluginApp has no manifests), so these cases isolate stored-vs-lock-vs-id.
describe("displayName / displayParts — lock label as the final fallback", () => {
  const lock: StoreLock = {
    version: STORE_LOCK_VERSION,
    capturedAt: "t",
    items: { "community": {"foo": { source: { kind: "plugin", version: "1.0.0" }, display: { label: "Foo Lock Label" } }} },
  };

  it("falls back to the lock label when no stored label is passed", () => {
    const plugin = makeDisplayNamePlugin(lock);
    expect(plugin.displayName("plugin-foo")).toBe("Foo Lock Label");
  });

  it("prefers a stored (registry) label over the lock label", () => {
    const plugin = makeDisplayNamePlugin(lock);
    expect(plugin.displayName("plugin-foo", "Stored Label")).toBe("Stored Label");
  });

  it("falls back to the raw id when neither stored nor lock has a label", () => {
    const plugin = makeDisplayNamePlugin({ capturedAt: "t", items: {} });
    expect(plugin.displayName("plugin-foo")).toBe("foo");
  });

  it("falls back to the raw id when no lock was ever loaded", () => {
    const plugin = makeDisplayNamePlugin(null);
    expect(plugin.displayName("plugin-foo")).toBe("foo");
  });

  it("displayParts carries the same lock fallback into its label field", () => {
    const plugin = makeDisplayNamePlugin(lock);
    expect(plugin.displayParts("plugin-foo").label).toBe("Foo Lock Label");
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

  it("status: snippet field equals its plain-array store (no phantom change)", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({
      "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["b", "a"]),
      ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "b"] }),
    });
    const manifest = await loadManifest(ctx);
    const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
    expect(statuses.find((s) => s.group === "enabled-css-snippets")?.state).toBe("in-sync");
  });
});

describe("remoteGroupsFrom (schema v2 self copy)", () => {
  const DEMO_GROUP: SyncGroup = withRef({ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" });
  const v2SelfCopy = JSON.stringify({ schemaVersion: 2, items: { "community:demo": { enabled: true } }, customGroups: [] });
  const files = { "store/configdir/plugins/config-sync/data.json": v2SelfCopy };

  it("compiles a v2 self copy through ctx.storeListGroups", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {}, storeListGroups: (json) => (json === v2SelfCopy ? [DEMO_GROUP] : []) };
    expect(await remoteGroupsFrom(ctx, fakeReader(files), Object.keys(files))).toEqual([DEMO_GROUP]);
  });

  it("yields [] for a v2 self copy when the hook is absent (bare context)", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {} };
    expect(await remoteGroupsFrom(ctx, fakeReader(files), Object.keys(files))).toEqual([]);
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
      // A hand-built plan still has to describe a remote that could have produced it: a lock, and
      // the listing it was read from.
      remoteLockRaw: '{"capturedAt":"t","groups":{}}',
      remoteFiles: ["store.lock.json", "store/configdir/plugins/new/data.json"],
      skipRefs: [],
    };
    await applyImport(ctx, pending, []);
    expect(await readGroups(ctx)).toEqual(before); // sync list untouched
    expect(await io.exists("cs/store/configdir/plugins/new/data.json")).toBe(true); // store file written
  });
});

// Fix B: capture (and status comparison) must strip a group's `local`-scoped fields using the
// UNION of the local rule and the store contract's rule for that group name — an un-adopted
// intermediate device must not leak its own device-local values (e.g. userIgnoreFilters)
// downstream just because its own copy of the group has no (or a narrower) local rule.
describe("store-contract-authoritative local strip (Fix B)", () => {
  const CONTRACT_SELF_COPY = JSON.stringify({ schemaVersion: 2, items: {}, customGroups: [] });
  const CONTRACT_GROUP: SyncGroup = {
    name: "plugin-demo",
    path: "{configDir}/plugins/demo/data.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [{ pattern: "userIgnoreFilters", sharing: THIS_DEVICE, encrypted: false }],
  };

  function setupWithContract(): { io: MemFS; plugins: FakePlugins; ctx: CoreContext } {
    const base = setup();
    base.ctx.storeListGroups = (json) => (json === CONTRACT_SELF_COPY ? [CONTRACT_GROUP] : []);
    base.io.seed({ "cs/store/configdir/plugins/config-sync/data.json": CONTRACT_SELF_COPY });
    return base;
  }

  const FIELDS_MODE_MANIFEST = JSON.stringify({
    version: 1,
    groups: [
      {
        name: "plugin-demo",
        path: "{configDir}/plugins/demo/data.json",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }],
      },
    ],
  });

  const PLAIN_MODE_MANIFEST = JSON.stringify({
    version: 1,
    groups: [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }],
  });

  const DEMO_CONTENT = JSON.stringify({ vikaToken: "secret", theme: "x", userIgnoreFilters: ["a", "b"] });

  it("fields-mode local group: capture strips the contract-local field the local rule does not cover", async () => {
    const { io, ctx } = setupWithContract();
    await seedGroups(ctx, FIELDS_MODE_MANIFEST);
    io.seed({ ".obs/plugins/demo/data.json": DEMO_CONTENT });
    await capture(ctx, ["plugin-demo"]);
    const stored = JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("userIgnoreFilters"); // contract-local, stripped despite local rule silence
    expect(stored).not.toHaveProperty("vikaToken"); // still stripped by the local rule itself
    expect(stored.theme).toBe("x");
  });

  it("plain-mode local group: capture still strips the contract-local field (promotion works)", async () => {
    const { io, ctx } = setupWithContract();
    await seedGroups(ctx, PLAIN_MODE_MANIFEST);
    io.seed({ ".obs/plugins/demo/data.json": DEMO_CONTENT });
    await capture(ctx, ["plugin-demo"]);
    const stored = JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("userIgnoreFilters");
    expect(stored.theme).toBe("x");
    expect(stored.vikaToken).toBe("secret"); // plain-mode local group has no rule stripping this
  });

  it("a captured, contract-stripped group compares in-sync (no phantom diff)", async () => {
    const { io, ctx } = setupWithContract();
    await seedGroups(ctx, FIELDS_MODE_MANIFEST);
    io.seed({ ".obs/plugins/demo/data.json": DEMO_CONTENT });
    await capture(ctx, ["plugin-demo"]);
    const manifest = await loadManifest(ctx);
    const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
    expect(statuses.find((s) => s.group === "plugin-demo")?.state).toBe("in-sync");
  });

  it("no store contract (empty map): capture output is byte-identical to today", async () => {
    const { io, ctx } = setup(); // no storeListGroups, no self store copy — today's behavior
    await seedGroups(ctx, FIELDS_MODE_MANIFEST);
    io.seed({ ".obs/plugins/demo/data.json": DEMO_CONTENT });
    await capture(ctx, ["plugin-demo"]);
    const stored = JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("vikaToken"); // local rule still applies
    expect(stored.userIgnoreFilters).toEqual(["a", "b"]); // no contract — not stripped, as today
    expect(stored.theme).toBe("x");
  });

  // Review Important: an explicit local "all" rule for a contract-local pattern must not win by
  // dedup-skip — the contract has to OVERRIDE it, per spec: "In the window where a device's own
  // rule says 'sync field X' but the store contract says 'local', capture will strip it."
  const COLLISION_MANIFEST = JSON.stringify({
    version: 1,
    groups: [
      {
        name: "plugin-demo",
        path: "{configDir}/plugins/demo/data.json",
        type: "file",
        devices: "all",
        mode: "fields",
        fields: [{ pattern: "userIgnoreFilters", sharing: EVERYWHERE, encrypted: false }],
      },
    ],
  });

  it("contract-local overrides a colliding explicit local 'all' rule for the same pattern (no leak, no phantom diff)", async () => {
    const { io, ctx } = setupWithContract();
    await seedGroups(ctx, COLLISION_MANIFEST);
    io.seed({ ".obs/plugins/demo/data.json": DEMO_CONTENT });
    await capture(ctx, ["plugin-demo"]);
    const stored = JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("userIgnoreFilters"); // contract-local wins over the local "all" rule
    expect(stored.theme).toBe("x");
    const manifest = await loadManifest(ctx);
    const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());
    expect(statuses.find((s) => s.group === "plugin-demo")?.state).toBe("in-sync"); // invariant 1 — no phantom diff
  });
});

describe("groupForStoreRel — sidecar display label", () => {
  const groups: SyncGroup[] = [
    { name: "app", path: "{configDir}/app.json", type: "file", devices: "all" },
  ];
  it("the main file keeps its bare name", () => {
    expect(groupForStoreRel(groups, "store/configdir/app.json")).toEqual({ name: "app", itemRel: "app.json" });
  });
  it("a device sidecar is labeled apart from the main file", () => {
    expect(groupForStoreRel(groups, "store/configdir/app.json.__scopes__.desktop.json")).toEqual({ name: "app", itemRel: "app.json \u00b7 desktop values" });
    expect(groupForStoreRel(groups, "store/configdir/app.json.__scopes__.mobile.json")).toEqual({ name: "app", itemRel: "app.json \u00b7 mobile values" });
  });
});

interface SelfStatusPluginSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  settings: { rootPath: string };
  syncCenterHost: () => { selfStatus: () => Promise<SelfSyncInfo> };
}

// storePresent must reflect the store lock OR the
// store's self-copy, never itemCount \u2014 a device with no compiled local list (settings.items
// stays {} here, same as makeSwitchPlugin's stub loadData) always takes selfStatus's coldstart
// early return, so these cases isolate storePresent's own derivation.
function makeSelfStatusPlugin(io: MemFS): SelfStatusPluginSurface {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as SelfStatusPluginSurface;
  instance.app = {
    vault: { adapter: io, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: { manifests: {}, enabledPlugins: new Set<string>(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
    loadLocalStorage: () => null,
  };
  instance.loadData = async () => ({ schemaVersion: 2, items: {}, remotes: [], bratIndex: {} });
  instance.saveData = async () => {};
  return instance;
}

describe("selfStatus.storePresent", () => {
  it("lock only \u2192 storePresent true", async () => {
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-08-01T00:00:00.000Z", groups: {} }) });
    const plugin = makeSelfStatusPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";

    const info = await plugin.syncCenterHost().selfStatus();
    expect(info.state).toBe("coldstart");
    expect(info.storePresent).toBe(true);
  });

  it("self-copy only \u2192 storePresent true", async () => {
    const io = new MemFS();
    io.seed({ "cs/store/configdir/plugins/config-sync/data.json": JSON.stringify({ items: {}, customGroups: [] }) });
    const plugin = makeSelfStatusPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";

    const info = await plugin.syncCenterHost().selfStatus();
    expect(info.state).toBe("coldstart");
    expect(info.storePresent).toBe(true);
  });

  it("neither \u2192 storePresent false", async () => {
    const io = new MemFS();
    const plugin = makeSelfStatusPlugin(io);
    await plugin.loadSettings();
    plugin.settings.rootPath = "cs";

    const info = await plugin.syncCenterHost().selfStatus();
    expect(info.state).toBe("coldstart");
    expect(info.storePresent).toBe(false);
  });
});
