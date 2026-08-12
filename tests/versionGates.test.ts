import { describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import ConfigSyncPlugin from "../src/main";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";
import { applyImport, applyWithActions, capture, CoreContext, PendingPull, planImport, pushExternal, ExternalStoreReader, ExternalStoreWriter, writeGroups } from "../src/core/ConfigSyncCore";
import { declaredStoreLockVersion, lockEntry, parseSyncManifest, parseStoreLock, storeLockVersion, STORE_LOCK_FUTURE_MESSAGE, STORE_LOCK_VERSION } from "../src/core/manifest";
import { SCHEMA_FUTURE_APPLY_MESSAGE, SCHEMA_FUTURE_NOTICE, SCHEMA_UPGRADE_NOTICE } from "../src/core/settingsMigration";
import { SELF_GROUP_NAME } from "../src/core/catalog";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { ConfigSyncSettingTab } from "../src/ui/SettingTab";
import { GroupResult, Remote, SyncGroup } from "../src/core/types";
import { CaptureItem, ApplyItem } from "../src/core/ConfigSyncCore";
import { itemsIn } from "./items";
import { ItemMap } from "../src/core/registry";

// spec 2026-08-11-data-model-hardening.md §4 (invariant II.3): a document or store written by a
// NEWER build is refused with a clear message — never downgraded, never reset, never overwritten.
// Three gates, tested here end to end:
//   §4.1 the settings classifier's stop state and the writers that refuse while it holds,
//   §4.2 the pre-write guard on the self item's apply (the local file must survive the refusal),
//   §4.3 the store lock's own version, refused by pull and by push.
//
// main.ts has no dedicated test harness (Plugin is stubbed to an empty class by
// tests/mock-obsidian.ts), so the §4.1 tests build a real ConfigSyncPlugin the same way
// tests/deviceOptOut.test.ts / tests/mainReloadSettings.test.ts already do, via bracket access to
// bypass TypeScript's compile-time-only `private`.

const NoticeSpy = Notice as unknown as { lastMessage: string | undefined; messages: string[] };

// How many times a given notice fired since the last `NoticeSpy.messages = []` — the assertion
// "exactly once, and only for a future document" needs a count, not just the last message.
function noticeCount(message: string): number {
  return NoticeSpy.messages.filter((m) => m === message).length;
}

// Fast-forward past the refusal-notice window. The stop notice at LOAD seeds it (final-review N1),
// so a gesture in the same ten seconds deliberately adds nothing to what is already on screen — the
// tests below that are about what a LATER gesture says age the window rather than pretending the
// startup notice never fired. Bracket access for the same reason the rest of this file uses it:
// `private` is compile-time only.
function ageRefusalWindow(instance: unknown): void {
  (instance as { lastRefusalNoticeAt: number }).lastRefusalNoticeAt = 0;
}

interface StopSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  refreshLocalStatus: () => Promise<void>;
  settingsWritable: () => boolean;
  setItemSyncEnabled: (itemId: string, enabled: boolean) => Promise<void>;
  settings: { rootPath: string; items: ItemMap };
  syncCenterHost: () => {
    schemaStop: () => { found: number } | null;
    captureItems: (items: CaptureItem[]) => Promise<GroupResult[] | null>;
    applyItems: (items: ApplyItem[]) => Promise<GroupResult[] | null>;
    adoptConfiguration: () => Promise<GroupResult[] | null>;
    pullFrom: (remote: Remote) => Promise<GroupResult[] | null>;
    pushTo: (remote: Remote) => Promise<GroupResult[] | null>;
    stopSyncing: (groupName: string, deleteStore: boolean) => Promise<string[] | null>;
    deleteLeftoverStoreFiles: (rels: string[]) => Promise<string[] | null>;
    appendActionHistory: (entry: { kind: "stop-sync"; desc: string; changed: number }) => Promise<void>;
    appendRunHistory: (kind: "capture", remote: string | null, results: GroupResult[]) => Promise<void>;
    setDeviceOptOut: (groupName: string, on: boolean) => Promise<void>;
    deviceOptedOut: (groupName: string) => boolean;
  };
}

// A real (in-memory, stateful) localStorage: the stop state has to be provable for the things that
// live THERE rather than in data.json — the per-device opt-out (§2) and the sync baselines.
function makePlugin(io: MemFS, data: unknown): { instance: StopSurface; saveCount: () => number; local: (key: string) => string | undefined } {
  const plugin = new ConfigSyncPlugin({} as never, {} as never);
  const instance = plugin as unknown as StopSurface;
  const store = new Map<string, string>();
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
    loadLocalStorage: (key: string) => store.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => {
      if (value === null || value === undefined) store.delete(key);
      else store.set(key, value as string);
    },
  };
  instance.loadData = async () => data;
  let saves = 0;
  instance.saveData = async () => {
    saves += 1;
  };
  return { instance, saveCount: () => saves, local: (key) => store.get(key) };
}

const OK_DOCUMENT = { schemaVersion: 3, rootPath: "cs", items: itemsIn({ community: { demo: { enabled: true } } }), remotes: [], bratIndex: {} };

// A document from the future, carrying shapes this build has no idea what to do with. Any
// `saveSettings()` on it would be an overwrite of a document this build does not own — exactly
// what the stop state exists to prevent.
function futureDocument(): unknown {
  return {
    schemaVersion: 4,
    rootPath: "cs",
    items: itemsIn({ community: { demo: { enabled: true, runsOn: { device: "here-on-tuesdays" } as never } } }),
    remotes: [],
    bratIndex: {},
    somethingOnlyTheFutureKnows: { keep: true },
  };
}

const A_REMOTE: Remote = { name: "other", type: "vault", storePath: "/nowhere/config-sync" };

describe("§4.1 — a data.json from a newer build is never reset and never overwritten", () => {
  it("loading one writes nothing, not even the migrations that normally save on sight", async () => {
    const { instance, saveCount } = makePlugin(new MemFS(), futureDocument());

    await instance.loadSettings();

    expect(saveCount()).toBe(0);
    expect(instance.syncCenterHost().schemaStop()).toEqual({ found: 4 });
    // Not reset to defaults either: the document's own values are what's in memory, unknown
    // fields included, so nothing this build might still write could flatten it.
    expect(instance.settings.rootPath).toBe("cs");
    expect(instance.settings.items.community["demo"]).toEqual({ enabled: true, runsOn: { device: "here-on-tuesdays" } });
  });

  // §4.2b: a device that has silently stopped syncing is the failure this release exists to
  // prevent, so it says so at load — not only to whoever opens the Sync Center. Same mechanism and
  // duration as the legacy branch's own notice.
  it("says so once at load, and only for a future document", async () => {
    NoticeSpy.messages = [];
    const { instance } = makePlugin(new MemFS(), futureDocument());

    await instance.loadSettings();

    expect(noticeCount(SCHEMA_FUTURE_NOTICE)).toBe(1);
  });

  // FINAL-REVIEW N1: the load's own notice has to seed the same quiet window every other refusal
  // shares. It did not, so the first gesture after startup stacked a second copy of the identical
  // sentence beside the one still on screen — precisely what that window was introduced to prevent.
  it("a gesture right after startup adds nothing to the notice already on screen", async () => {
    NoticeSpy.messages = [];
    const { instance } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    await instance.recompile();

    await instance.saveSettings();
    expect(instance.settingsWritable()).toBe(false);
    expect(await instance.syncCenterHost().pullFrom(A_REMOTE)).toBeNull();

    // Every one of those was still REFUSED — only the repeat of the sentence is suppressed.
    expect(noticeCount(SCHEMA_FUTURE_NOTICE)).toBe(1);
  });

  it("a document this build understands raises no stop notice at all", async () => {
    NoticeSpy.messages = [];
    const ok = makePlugin(new MemFS(), { schemaVersion: 3, items: itemsIn({}), remotes: [], bratIndex: {} });
    await ok.instance.loadSettings();
    const fresh = makePlugin(new MemFS(), null);
    await fresh.instance.loadSettings();
    const legacy = makePlugin(new MemFS(), { groups: [], memberScopes: {} });
    await legacy.instance.loadSettings();

    expect(noticeCount(SCHEMA_FUTURE_NOTICE)).toBe(0);
    expect(noticeCount(SCHEMA_UPGRADE_NOTICE)).toBe(1); // the legacy load still notices, as it always did
  });

  it("the stop state clears when a document this build understands loads next", async () => {
    const { instance } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    expect(instance.syncCenterHost().schemaStop()).not.toBeNull();

    instance.loadData = async () => ({ schemaVersion: 3, items: itemsIn({}), remotes: [], bratIndex: {} });
    await instance.loadSettings();

    expect(instance.syncCenterHost().schemaStop()).toBeNull();
  });

  it("saveSettings — every settings writer's choke point, the settings tab's included — refuses and says why", async () => {
    const { instance, saveCount } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    ageRefusalWindow(instance);
    NoticeSpy.lastMessage = undefined;

    await instance.saveSettings();

    expect(saveCount()).toBe(0);
    expect(NoticeSpy.lastMessage).toBe(SCHEMA_FUTURE_NOTICE);
  });

  it("capture refuses: the store copy is left exactly as it was", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
    });
    const { instance } = makePlugin(io, futureDocument());
    await instance.loadSettings();
    await instance.recompile();
    ageRefusalWindow(instance);
    NoticeSpy.lastMessage = undefined;

    expect(await instance.syncCenterHost().captureItems([{ name: "plugin-demo", action: "none" }])).toBeNull();

    expect(await io.read("cs/store/configdir/plugins/demo/data.json")).toBe(JSON.stringify({ store: true }));
    expect(await io.exists("cs/store.lock.json")).toBe(false);
    expect(NoticeSpy.lastMessage).toBe(SCHEMA_FUTURE_NOTICE);
  });

  it("apply refuses: the local file is left exactly as it was", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
    });
    const { instance } = makePlugin(io, futureDocument());
    await instance.loadSettings();
    await instance.recompile();
    ageRefusalWindow(instance);
    NoticeSpy.lastMessage = undefined;

    expect(await instance.syncCenterHost().applyItems([{ name: "plugin-demo", action: "none" }])).toBeNull();

    expect(await io.read("config-dir/plugins/demo/data.json")).toBe(JSON.stringify({ local: true }));
    expect(NoticeSpy.lastMessage).toBe(SCHEMA_FUTURE_NOTICE);
  });

  it("adopt refuses — it is the entry point that rewrites this device's own document wholesale", async () => {
    const { instance, saveCount } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    ageRefusalWindow(instance);
    NoticeSpy.lastMessage = undefined;

    expect(await instance.syncCenterHost().adoptConfiguration()).toBeNull();

    expect(saveCount()).toBe(0); // adopt's own "enable the self item" save never happens either
    expect(NoticeSpy.lastMessage).toBe(SCHEMA_FUTURE_NOTICE);
  });

  // The two paths that delete store content BEFORE they reach a settings write: leaving them to
  // saveSettings' own refusal would delete first and refuse afterwards. Both decide WHICH files to
  // delete from compiledGroups, and this build cannot compile a document it does not understand.
  it("stop-syncing and leftover cleanup refuse rather than delete on a guess", async () => {
    const io = new MemFS();
    io.seed({
      "config-dir/plugins/demo/data.json": JSON.stringify({ local: true }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ store: true }),
      "cs/store/configdir/onlyANewerBuildKnowsThis.json": "{}",
    });
    const { instance } = makePlugin(io, futureDocument());
    await instance.loadSettings();
    await instance.recompile();

    // null, not [] — "[] deleted" is a legitimate outcome the caller records in the run history,
    // so the refusal has to be a value a caller cannot mistake for a successful run (§4.2b).
    expect(await instance.syncCenterHost().stopSyncing("plugin-demo", true)).toBeNull();
    expect(await instance.syncCenterHost().deleteLeftoverStoreFiles(["store/configdir/onlyANewerBuildKnowsThis.json"])).toBeNull();

    expect(await io.exists("cs/store/configdir/plugins/demo/data.json")).toBe(true);
    expect(await io.exists("cs/store/configdir/onlyANewerBuildKnowsThis.json")).toBe(true);
  });

  // The startup lock-label heal was the one remaining store write while stopped (§4.2b). Cosmetic,
  // but "the stop state writes nothing" is the rule, and this is the kind of exception that grows.
  // The `ok` case below is what proves the refusal is doing the work: the same heal, same lock,
  // same missing label, and it lands.
  it("the startup lock-label heal writes nothing while stopped — and still heals when it isn't", async () => {
    // In THIS build's format: the heal refuses a lock in any other (see lockLabelHeal.test.ts), so a
    // v1/v2 fixture here would pass for the wrong reason — nothing written because nothing is ever
    // written, rather than because the stop state held.
    const lock = JSON.stringify({ version: 3, capturedAt: "2026-08-01T00:00:00.000Z", items: { community: { demo: { source: { kind: "plugin", version: "1.0.0" } } } } }, null, 2);
    const seed = { "cs/store.lock.json": lock, "cs/store/configdir/plugins/demo/data.json": "{}" };

    const stoppedIo = new MemFS();
    stoppedIo.seed(seed);
    const stopped = makePlugin(stoppedIo, futureDocument());
    await stopped.instance.loadSettings();
    await stopped.instance.recompile();
    await stopped.instance.refreshLocalStatus();
    expect(await stoppedIo.read("cs/store.lock.json")).toBe(lock);

    const okIo = new MemFS();
    okIo.seed(seed);
    const ok = makePlugin(okIo, { schemaVersion: 3, rootPath: "cs", items: itemsIn({ community: { demo: { enabled: true } } }), remotes: [], bratIndex: {} });
    await ok.instance.loadSettings();
    await ok.instance.recompile();
    await ok.instance.refreshLocalStatus();
    expect(lockEntry(parseStoreLock(await okIo.read("cs/store.lock.json")), "community/demo")?.display?.label).toBe("Demo Plugin");
  });

  // Review I1: the opt-out moved to localStorage in §2, which took it out from behind
  // `saveSettings`' choke point — and it is reachable with the banner on screen, through the same
  // Stop-syncing menu whose "Everywhere…" is refused. The two must agree.
  it("Stop syncing → On this device is refused, and writes no localStorage", async () => {
    const { instance, local } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    await instance.recompile();
    ageRefusalWindow(instance);
    NoticeSpy.lastMessage = undefined;

    await instance.syncCenterHost().setDeviceOptOut("plugin-demo", true);

    expect(local("config-sync-device-optouts")).toBeUndefined();
    expect(instance.syncCenterHost().deviceOptedOut("plugin-demo")).toBe(false);
    expect(NoticeSpy.lastMessage).toBe(SCHEMA_FUTURE_NOTICE);
  });

  // Review I2: the history entry is written by the ACTION'S CALLER, so a refusal that only
  // returned a value would still be logged as "Stopped syncing X" beside the refusal notice by any
  // caller that forgot to check. The last word is here.
  it("a refused action is never recorded as done", async () => {
    const io = new MemFS();
    const { instance } = makePlugin(io, futureDocument());
    await instance.loadSettings();

    await instance.syncCenterHost().appendActionHistory({ kind: "stop-sync", desc: "Stopped syncing Demo Plugin", changed: 1 });

    expect(await io.exists("config-dir/plugins/config-sync/run-history.json")).toBe(false);
  });

  it("...but an action that really happened still is", async () => {
    const io = new MemFS();
    const { instance } = makePlugin(io, OK_DOCUMENT);
    await instance.loadSettings();

    await instance.syncCenterHost().appendActionHistory({ kind: "stop-sync", desc: "Stopped syncing Demo Plugin", changed: 1 });

    expect(await io.exists("config-dir/plugins/config-sync/run-history.json")).toBe(true);
  });

  // The sibling guard (round-4 review N2): every run is refused before it starts, so nothing here
  // could be a real record either — and the Sync Center's `setLastRun` returning early on the
  // refusal is caller discipline, not a guarantee.
  it("a run history entry is never written for a run that could not have happened", async () => {
    const io = new MemFS();
    const { instance } = makePlugin(io, futureDocument());
    await instance.loadSettings();

    await instance.syncCenterHost().appendRunHistory("capture", null, []);

    expect(await io.exists("config-dir/plugins/config-sync/run-history.json")).toBe(false);
  });

  // Review M4: baselines are computed from `compiledGroups` — compiled from the document we cannot
  // read — so writing them records a fiction, and direction is decided from that fiction later.
  // They are per-device localStorage, hence the second half: the rule is "nothing another device
  // can see, and nothing DERIVED from the document we cannot read", not "nothing at all".
  it("sync baselines are not written while stopped — and are when the document is understood", async () => {
    const seed = { "config-dir/plugins/demo/data.json": "{}", "cs/store/configdir/plugins/demo/data.json": "{}" };

    const stoppedIo = new MemFS();
    stoppedIo.seed(seed);
    const stopped = makePlugin(stoppedIo, futureDocument());
    await stopped.instance.loadSettings();
    await stopped.instance.recompile();
    await stopped.instance.refreshLocalStatus();
    expect(stopped.local("config-sync-baselines")).toBeUndefined();

    const okIo = new MemFS();
    okIo.seed(seed);
    const ok = makePlugin(okIo, OK_DOCUMENT);
    await ok.instance.loadSettings();
    await ok.instance.recompile();
    await ok.instance.refreshLocalStatus();
    expect(ok.local("config-sync-baselines")).toBeDefined();
  });

  // Review N4: the settings tab's text fields refuse per KEYSTROKE. A notice per character is
  // worse than silence — a storm teaches the user to ignore the one message that matters — so the
  // MESSAGE is said once per window while every one of those keystrokes is still refused.
  it("a run of edits produces one notice, not one per keystroke — and every one of them is still refused", async () => {
    const { instance } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    ageRefusalWindow(instance);
    NoticeSpy.messages = [];

    const answers = [1, 2, 3, 4, 5, 6].map(() => instance.settingsWritable());

    expect(answers).toEqual([false, false, false, false, false, false]);
    expect(noticeCount(SCHEMA_FUTURE_NOTICE)).toBe(1);
  });

  // Review M5: every settings-tab writer is mutate-then-save, and `saveSettings` refuses too late
  // to undo the mutation — memory would diverge from disk with no recompile. `settingsWritable()`
  // is what those writers ask FIRST; the host-level writers guard themselves the same way.
  it("a settings writer refused while stopped leaves memory untouched", async () => {
    const { instance } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();
    const before = JSON.stringify(instance.settings.items);

    expect(instance.settingsWritable()).toBe(false);
    await instance.setItemSyncEnabled("community/demo", false);

    expect(JSON.stringify(instance.settings.items)).toBe(before);
  });

  it("and the same writer works normally when the document is understood", async () => {
    const { instance } = makePlugin(new MemFS(), OK_DOCUMENT);
    await instance.loadSettings();

    expect(instance.settingsWritable()).toBe(true);
    expect(instance.settings.items.community["demo"]?.enabled).toBe(true);
    await instance.setItemSyncEnabled("community/demo", false);

    // The entry stays and records the "off" — see registry.ts's withItem: in the enablement
    // sections an entry's presence is this device's capture mask. The before/after pair is what
    // proves the write happened rather than being refused.
    expect(instance.settings.items.community["demo"]).toEqual({ enabled: false });
  });

  it("pull and push refuse before a remote is even opened", async () => {
    const { instance } = makePlugin(new MemFS(), futureDocument());
    await instance.loadSettings();

    ageRefusalWindow(instance);
    NoticeSpy.messages = [];
    expect(await instance.syncCenterHost().pullFrom(A_REMOTE)).toBeNull();
    expect(await instance.syncCenterHost().pushTo(A_REMOTE)).toBeNull();

    // Both refused — and refused before the remote was opened, so neither raised a transport
    // failure notice. The message itself is said once: a repeat inside the notice window is
    // suppressed (N4), never the refusal.
    expect(noticeCount(SCHEMA_FUTURE_NOTICE)).toBe(1);
    expect(NoticeSpy.messages.filter((m) => m !== SCHEMA_FUTURE_NOTICE)).toEqual([]);
  });
});

// §4.2: adopt/self-apply writes the store's data.json onto this device and only then reloads, so a
// check inside loadSettings arrives after the local document is already gone. The guard runs
// BEFORE the write, on the incoming document, and fails only that item.
const SELF_STORE_REL = "cs/store/configdir/plugins/config-sync/data.json";
const SELF_LOCAL_REL = "config-dir/plugins/config-sync/data.json";

const GUARD_MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" },
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
  ],
});

function guardCtx(io: MemFS): CoreContext {
  return {
    io,
    configDir: "config-dir",
    rootPath: "cs",
    plugins: new FakePlugins(),
    passphrase: null,
    deviceClass: "desktop",
    groupsIO: memGroupsIO(),
    now: () => "2026-08-11T00:00:00.000Z",
    switchExceptions: {},
  };
}

describe("§4.2 — the guard runs before the write, not after it", () => {
  const LOCAL_SELF = JSON.stringify({ schemaVersion: 3, items: itemsIn({ obsidian: { hotkeys: { enabled: true } } }) }, null, 2);

  async function runAdopt(storeSelf: string): Promise<{ io: MemFS; results: GroupResult[] }> {
    const io = new MemFS();
    io.seed({
      [SELF_LOCAL_REL]: LOCAL_SELF,
      [SELF_STORE_REL]: storeSelf,
      "config-dir/hotkeys.json": '{"local":1}',
      "cs/store/configdir/hotkeys.json": '{"store":1}',
    });
    const ctx = guardCtx(io);
    await writeGroups(ctx, parseSyncManifest(GUARD_MANIFEST).groups);
    const results = await applyWithActions(
      ctx,
      [
        { name: SELF_GROUP_NAME, action: "none" },
        { name: "hotkeys", action: "none" },
      ],
      async () => "1.0.0"
    );
    return { io, results };
  }

  it("fails the self item with the §4.2 message and leaves the local document byte-identical", async () => {
    const { io, results } = await runAdopt(JSON.stringify({ schemaVersion: 4, items: {} }));

    const self = results.find((r) => r.group === SELF_GROUP_NAME);
    expect(self?.status).toBe("error");
    expect(self?.messages).toContain(SCHEMA_FUTURE_APPLY_MESSAGE);
    expect(self?.filesWritten).toEqual([]);
    expect(await io.read(SELF_LOCAL_REL)).toBe(LOCAL_SELF);
  });

  it("other items in the same run are unaffected", async () => {
    const { io, results } = await runAdopt(JSON.stringify({ schemaVersion: 4, items: {} }));

    expect(results.find((r) => r.group === "hotkeys")?.status).toBe("ok");
    expect(await io.read("config-dir/hotkeys.json")).toBe('{"store":1}');
  });

  it("a store document this build understands still applies exactly as before", async () => {
    const incoming = JSON.stringify({ schemaVersion: 3, items: itemsIn({ obsidian: { appearance: { enabled: true } } }) });
    const { io, results } = await runAdopt(incoming);

    expect(results.find((r) => r.group === SELF_GROUP_NAME)?.status).toBe("ok");
    expect(await io.read(SELF_LOCAL_REL)).toBe(incoming);
  });
});

// §4.3: `version` absent = 1 (today's shape); this build writes 2; a lock declaring more than 2 is
// refused — it is not the `unknown` state an unreadable lock gets. The gate belongs to the STORE,
// not to "the remote" (review I3): the store lives in the vault, the vault is synced by other
// tools, so a v3 lock lands here with no pull involved and every operation that WRITES the lock
// has to check the one it is about to replace.
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

function fakeWriter(initial: Record<string, string>): { writer: ExternalStoreWriter; files: Record<string, string>; writeLog: string[] } {
  const files: Record<string, string> = { ...initial };
  const writeLog: string[] = [];
  return {
    files,
    writeLog,
    writer: {
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
      async finalize() {},
    },
  };
}

// A lock in the shape a 2.21.0 device writes — the transition window's normal store, and still the
// "today's shape" side of every gate below.
const V1_LOCK = JSON.stringify({ capturedAt: "2026-08-01T00:00:00.000Z", groups: { hotkeys: { sourceAppVersion: "1.8.7" } } });
// "From the future" is version 4 now that this build writes 3 (spec §3). The gate is unchanged; the
// number it refuses moved with the format, which is the whole point of declaring one.
const V4_LOCK = JSON.stringify({ version: 4, capturedAt: "2026-08-01T00:00:00.000Z", items: { obsidian: { hotkeys: { source: { kind: "app", version: "1.8.7" } } } } });

describe("§4.3 — the store lock's version", () => {
  it("absent means 1: today's locks parse and read exactly as they always did", () => {
    const lock = parseStoreLock(V1_LOCK);
    expect(storeLockVersion(lock)).toBe(1);
    expect(lock.capturedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(lockEntry(lock, "obsidian/hotkeys")).toEqual({ source: { kind: "app", version: "1.8.7" } }); // converted in memory, not on disk
  });

  // A version that isn't a number is not evidence of a newer format, and refusing to sync over a
  // typo would strand a whole fleet — so it degrades to today's shape instead of throwing.
  it("a non-numeric version degrades to 1 rather than throwing", () => {
    expect(storeLockVersion(parseStoreLock(JSON.stringify({ version: "4", capturedAt: "t", items: {} })))).toBe(1);
    expect(parseStoreLock(JSON.stringify({ version: "4", capturedAt: "t", items: {} })).version).toBe("4"); // and it is carried, not dropped (§3.1)
  });

  it("capture writes this build's version", async () => {
    const io = new MemFS();
    io.seed({ "config-dir/hotkeys.json": '{"a":1}' });
    const ctx = guardCtx(io);
    await writeGroups(ctx, parseSyncManifest(JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] })).groups);

    await capture(ctx);

    expect(storeLockVersion(parseStoreLock(await io.read("cs/store.lock.json")))).toBe(STORE_LOCK_VERSION);
  });

  it("pull refuses a remote lock from a newer build, and writes nothing", async () => {
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": V1_LOCK, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
    const ctx = guardCtx(io);

    await expect(planImport(ctx, fakeReader({ "store.lock.json": V4_LOCK, "store/configdir/hotkeys.json": '{"theirs":1}' }), { excludeSelf: false })).rejects.toThrow(
      STORE_LOCK_FUTURE_MESSAGE
    );
    expect(await io.read("cs/store.lock.json")).toBe(V1_LOCK);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"mine":1}');
  });

  it("push refuses a remote lock from a newer build before the first file is written", async () => {
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": V1_LOCK, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
    const ctx = guardCtx(io);
    const fw = fakeWriter({ "store.lock.json": V4_LOCK, "store/configdir/hotkeys.json": '{"theirs":1}' });

    await expect(pushExternal(ctx, fw.writer, { excludeSelf: false })).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

    expect(fw.writeLog).toEqual([]);
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"theirs":1}');
  });

  // Review I3: no pull, no remote — the v3 lock is simply THERE, put in this vault by another
  // device's newer build through git / Remotely Save / a file-sync service. Capture is about to
  // replace it with `version: 3`, which would discard whatever v4 recorded.
  it("capture refuses a LOCAL lock from a newer build and leaves it byte-identical", async () => {
    const io = new MemFS();
    io.seed({ "config-dir/hotkeys.json": '{"a":1}', "cs/store.lock.json": V4_LOCK });
    const ctx = guardCtx(io);
    await writeGroups(ctx, parseSyncManifest(JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] })).groups);

    await expect(capture(ctx)).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

    expect(await io.read("cs/store.lock.json")).toBe(V4_LOCK);
    // and it refused before the first group was mirrored, not just before the lock write
    expect(await io.exists("cs/store/configdir/hotkeys.json")).toBe(false);
  });

  // Round 3: a pull that cannot happen must be refused at PLANNING, not after the user has worked
  // through conflict resolution — the same honesty rule that keeps a doomed pull from being
  // invited in the first place.
  it("planning refuses a LOCAL lock from a newer build — the user is never asked to resolve a conflict", async () => {
    const remote = { "store.lock.json": V1_LOCK, "store/configdir/hotkeys.json": '{"theirs":1}' };
    const store = { "cs/store/configdir/hotkeys.json": '{"mine":1}' };

    // With a lock this build can read, this very pull DOES stop for a conflict — so the refusal
    // below is what spares the user that adjudication, not an empty scenario.
    const okIo = new MemFS();
    okIo.seed({ ...store, "cs/store.lock.json": V1_LOCK });
    const planned = await planImport(guardCtx(okIo), fakeReader(remote), { excludeSelf: false });
    expect(planned.plan.conflicts.filter((c) => c.kind === "file")).toHaveLength(1);

    const io = new MemFS();
    io.seed({ ...store, "cs/store.lock.json": V4_LOCK });

    await expect(planImport(guardCtx(io), fakeReader(remote), { excludeSelf: false })).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

    expect(await io.read("cs/store.lock.json")).toBe(V4_LOCK);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"mine":1}');
  });

  // The planner is a courtesy; the writer is the guarantee. A caller holding a plan — made before
  // the v3 lock landed, or built without planImport at all — is still refused.
  it("and the pull merge refuses it too, for a caller that never planned", async () => {
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": V4_LOCK });
    const pending: PendingPull = {
      plan: {
        auto: {
          addGroups: [],
          writeFiles: [{ rel: "store/configdir/hotkeys.json", content: '{"theirs":1}', name: "hotkeys" }],
          keptLocalGroups: [],
          keptLocalFiles: [],
          identical: [],
        },
        conflicts: [],
      },
      remoteGroups: [],
      remoteLockRaw: V1_LOCK,
      excludeSelf: false,
    };

    await expect(applyImport(guardCtx(io), pending, [])).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

    expect(await io.read("cs/store.lock.json")).toBe(V4_LOCK);
    expect(await io.exists("cs/store/configdir/hotkeys.json")).toBe(false);
  });

  // FINAL-REVIEW C1. Every v3 fixture above happens to satisfy v1's entry rule, so the gate was
  // never asked the question that breaks it. `parseStoreLock` still enforces "every entry carries a
  // string sourcePluginVersion or sourceAppVersion" — so a v3 that RESTRUCTURES the entry throws
  // there, and a gate that read the version through the parser treated that throw as permission to
  // proceed. The restructure is not hypothetical: it is exactly the source/innate/display partition
  // §6's own "Out of scope" note defers to v3, which is why those two fields were kept flat. Asking
  // the version off a raw JSON.parse is what separates "invalid for v1" from "newer than us".
  describe("a v3 lock this build cannot even parse", () => {
    const V4_RESTRUCTURED = JSON.stringify({
      version: 4,
      capturedAt: "2026-08-01T00:00:00.000Z",
      items: { obsidian: { hotkeys: { origin: { app: "1.8.7" }, display: { label: "Hotkeys" } } } },
    });
    const HOTKEYS_ONLY = JSON.stringify({ version: 1, groups: [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }] });

    it("is genuinely unparseable, and genuinely declares 3 — the two questions have different answers", () => {
      expect(() => parseStoreLock(V4_RESTRUCTURED)).toThrow('store.lock.json item "obsidian/hotkeys" must have a "source"');
      expect(declaredStoreLockVersion(V4_RESTRUCTURED)).toBe(4);
      // …while something that is not a lock at all still reads as today's shape, so a corrupt file
      // keeps the tolerant behaviour it has always had rather than stranding the fleet.
      expect(declaredStoreLockVersion("not json at all")).toBe(1);
      expect(declaredStoreLockVersion(null)).toBe(1);
      expect(declaredStoreLockVersion(V1_LOCK)).toBe(1);
    });

    it("capture refuses it instead of rewriting a newer build's bookkeeping as version 3", async () => {
      const io = new MemFS();
      io.seed({ "config-dir/hotkeys.json": '{"a":1}', "cs/store.lock.json": V4_RESTRUCTURED });
      const ctx = guardCtx(io);
      await writeGroups(ctx, parseSyncManifest(HOTKEYS_ONLY).groups);

      await expect(capture(ctx)).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

      expect(await io.read("cs/store.lock.json")).toBe(V4_RESTRUCTURED);
      expect(await io.exists("cs/store/configdir/hotkeys.json")).toBe(false);
    });

    it("pull refuses it at both ends — as the remote's lock, and as the local one it would replace", async () => {
      const remoteFiles = { "store.lock.json": V4_RESTRUCTURED, "store/configdir/hotkeys.json": '{"theirs":1}' };
      const io = new MemFS();
      io.seed({ "cs/store.lock.json": V1_LOCK, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
      await expect(planImport(guardCtx(io), fakeReader(remoteFiles), { excludeSelf: false })).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);
      expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"mine":1}');

      const localIo = new MemFS();
      localIo.seed({ "cs/store.lock.json": V4_RESTRUCTURED, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
      await expect(
        planImport(guardCtx(localIo), fakeReader({ "store.lock.json": V1_LOCK, "store/configdir/hotkeys.json": '{"theirs":1}' }), { excludeSelf: false })
      ).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);
      expect(await localIo.read("cs/store.lock.json")).toBe(V4_RESTRUCTURED);
    });

    it("the pull merge refuses it too, for a caller that never planned", async () => {
      const io = new MemFS();
      io.seed({ "cs/store.lock.json": V4_RESTRUCTURED });
      const pending: PendingPull = {
        plan: {
          auto: {
            addGroups: [],
            writeFiles: [{ rel: "store/configdir/hotkeys.json", content: '{"theirs":1}', name: "hotkeys" }],
            keptLocalGroups: [],
            keptLocalFiles: [],
            identical: [],
          },
          conflicts: [],
        },
        remoteGroups: [],
        remoteLockRaw: V1_LOCK,
        excludeSelf: false,
      };

      await expect(applyImport(guardCtx(io), pending, [])).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

      expect(await io.read("cs/store.lock.json")).toBe(V4_RESTRUCTURED);
      expect(await io.exists("cs/store/configdir/hotkeys.json")).toBe(false);
    });

    it("push refuses it before the first file is written — store.lock.json is in the pushed set", async () => {
      const io = new MemFS();
      io.seed({ "cs/store.lock.json": V1_LOCK, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
      const fw = fakeWriter({ "store.lock.json": V4_RESTRUCTURED, "store/configdir/hotkeys.json": '{"theirs":1}' });

      await expect(pushExternal(guardCtx(io), fw.writer, { excludeSelf: false })).rejects.toThrow(STORE_LOCK_FUTURE_MESSAGE);

      expect(fw.writeLog).toEqual([]);
      expect(fw.files["store.lock.json"]).toBe(V4_RESTRUCTURED);
    });
  });

  // Round-4 review N1: the startup label heal is the FOURTH writer of this file, and the case is
  // worse than the others — data.json here is a perfectly readable v2, so `schemaStop` is null and
  // the stop state's guard says nothing, and the write fires at startup with no user action at
  // all. The pairing that proves it: `refreshLocalStatus` over a lock in THIS build's own format
  // (the heal test above, at version 3) does write the healed label. A v1/v2 lock would not be that
  // pairing — task-3's C1 ruling stopped the heal upgrading a format, so those are left
  // byte-identical too, for a different reason (lockLabelHeal.test.ts holds that case).
  it("the startup label heal refuses a lock from a newer build and leaves it byte-identical", async () => {
    const v4Lock = JSON.stringify({ version: 4, capturedAt: "2026-08-01T00:00:00.000Z", items: { community: { demo: { source: { kind: "plugin", version: "1.0.0" } } } } }, null, 2);
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": v4Lock, "cs/store/configdir/plugins/demo/data.json": "{}" });
    const { instance } = makePlugin(io, OK_DOCUMENT); // NOT stopped — this build reads the document fine

    await instance.loadSettings();
    await instance.recompile();
    await instance.refreshLocalStatus();

    expect(await io.read("cs/store.lock.json")).toBe(v4Lock);
  });

  it("a remote lock with no version at all still pulls and pushes as today", async () => {
    const io = new MemFS();
    io.seed({ "cs/store.lock.json": V1_LOCK, "cs/store/configdir/hotkeys.json": '{"mine":1}' });
    const ctx = guardCtx(io);

    const pending = await planImport(ctx, fakeReader({ "store.lock.json": V1_LOCK, "store/configdir/other.json": '{"theirs":1}' }), { excludeSelf: false });
    expect(pending.plan.auto.writeFiles.map((f) => f.rel)).toContain("store/configdir/other.json");

    const fw = fakeWriter({ "store.lock.json": V1_LOCK });
    await pushExternal(ctx, fw.writer, { excludeSelf: false });
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"mine":1}');
  });
});

// §4.2b, round-4 review N5: a flow that will be refused refuses BEFORE it opens. Taking a decision
// from the user in a modal and only then declining is the same defect round 3 fixed for pull.
// `SyncCenterHost` is an interface, so a fake carrying only what this path touches is enough — the
// same idiom tests/emptyVerbDegradation.test.ts uses to drive the view's private methods.
describe("Stop syncing → Everywhere…", () => {
  function openStopSyncingWith(writable: boolean): { open: () => Promise<void>; counted: () => number } {
    let counted = 0;
    const host = {
      settingsWritable: () => writable,
      displayName: (n: string) => n,
      // Fetched to size the modal's checkbox line — so it happens strictly BEFORE the modal opens,
      // which makes "was it called" the honest probe for "did this flow start at all".
      storeFileCount: async () => {
        counted += 1;
        return 0;
      },
      stopSyncing: async () => {
        throw new Error("stopSyncing must never be reached from a refused flow");
      },
    };
    const view = new SyncCenterView({} as never, host as never);
    const row = { group: { name: "plugin-demo", path: "p", type: "file", devices: "all" }, status: { group: "plugin-demo", state: "in-sync" } };
    const priv = view as unknown as { openStopSyncing: (r: unknown) => Promise<void> };
    return { open: () => priv.openStopSyncing(row), counted: () => counted };
  }

  it("never opens its modal while stopped", async () => {
    const { open, counted } = openStopSyncingWith(false);
    await open();
    expect(counted()).toBe(0);
  });

  it("opens normally when the document is understood", async () => {
    const { open, counted } = openStopSyncingWith(true);
    await open();
    expect(counted()).toBe(1);
  });
});

// §4.2b/N3, the settings tab's own drafts: a refused gesture must not move what the panel renders,
// or the UI shows an edit that never happened. The Advanced tab gets this from ONE line —
// `persistCustomGroups` throws the refusal, and `commitDraft` already keeps the caller's draft
// whenever the write fails — which is what covers all ~15 `commitGroups` call sites at once.
describe("the Advanced tab's draft", () => {
  const RULE: SyncGroup = { name: "custom-rule", path: "{configDir}/x.json", type: "file", devices: "all" };
  const ADDED: SyncGroup = { name: "second-rule", path: "{configDir}/y.json", type: "file", devices: "all" };

  function tabWith(writable: boolean): { commit: () => Promise<boolean>; names: () => string[]; saved: () => number } {
    let saves = 0;
    const host = {
      settingsWritable: () => writable,
      settings: { items: itemsIn({}) },
      saveSettings: async () => {
        saves += 1;
      },
      installedPluginIds: () => [],
      itemDefs: () => [],
    };
    const tab = new ConfigSyncSettingTab({} as never, host as never);
    const priv = tab as unknown as { groups: SyncGroup[]; commitGroups: (m: (d: SyncGroup[]) => void, culprit?: string) => Promise<boolean> };
    priv.groups = [RULE];
    return {
      commit: () => priv.commitGroups((draft) => draft.push({ ...ADDED }), RULE.name),
      names: () => priv.groups.map((g) => g.name),
      saved: () => saves,
    };
  }

  it("a refused edit leaves the draft — and the panel — exactly as it was", async () => {
    const tab = tabWith(false);

    expect(await tab.commit()).toBe(false);
    expect(tab.names()).toEqual([RULE.name]);
    expect(tab.saved()).toBe(0);
  });

  it("...and an allowed one lands", async () => {
    const tab = tabWith(true);

    expect(await tab.commit()).toBe(true);
    expect(tab.names()).toEqual([RULE.name, ADDED.name]);
    expect(tab.saved()).toBe(1);
  });
});
