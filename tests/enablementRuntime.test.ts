import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { FakePlugins, MemFS } from "./memfs";
import { itemsIn } from "./items";
import { Item, ItemMap } from "../src/core/registry";
import { EVERYWHERE, perClass, Sharing, THIS_DEVICE } from "../src/core/types";
import { perElementKeyFor } from "../src/core/switchList";
import { DEVICE_ELEMENTS_KEY } from "../src/core/deviceElements";
import { applyWithActions, capture, CoreContext } from "../src/core/ConfigSyncCore";

// The runtime cutover (spec 2026-08-12-enablement-two-layers-design.md §5): what a run actually
// does is ONE decision per element over a stored fleet rule and this device's own exception, and
// `coreContext()`'s three fields — switchExceptions / switchForceOn / switchForceOff — are three
// projections of that one decision.
//
// These assert on those three fields, never on a UI value: §9's acceptance criteria 3 and 4 are
// about what a RUN does, and the four derivations this replaced are exactly why a UI value and a
// run once disagreed (C-#52). Harness pattern from tests/deviceOptOut.test.ts — a real
// ConfigSyncPlugin, an in-memory localStorage, a real MemFS behind the switch-list file.

const ELEMENT = "remotely-save";
const LIST = "community-plugins";
const LOCAL_FILE = "config-dir/community-plugins.json";

function makeLocalStorage(seed: Record<string, string>): {
  store: Map<string, string>;
  api: { loadLocalStorage: (key: string) => unknown; saveLocalStorage: (key: string, value: unknown) => void };
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    api: {
      loadLocalStorage: (key) => store.get(key) ?? null,
      saveLocalStorage: (key, value) => {
        if (value === null || value === undefined) store.delete(key);
        else store.set(key, value as string);
      },
    },
  };
}

// The carrier item is where a fleet rule lives (spec §3.3) — synced, so compileItems emits the
// `community-plugins` group whose local file the persisted read below actually finds. The
// perElement key comes from its ONE producer, never a literal.
function carrier(rules: Record<string, Sharing>): Item {
  return {
    synced: true,
    settingsFile: { mode: "fields", rules: {}, perElement: { [perElementKeyFor(LIST)]: rules } },
  } as unknown as Item;
}

function items(rules: Record<string, Sharing>): ItemMap {
  return itemsIn({
    obsidian: { "community-plugins": carrier(rules) },
    community: { [ELEMENT]: { synced: true } },
  });
}

interface Surface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  settings: { rootPath: string; items: ItemMap };
  enablementRuleFor: (list: string, elementId: string) => Sharing;
  setEnablementRule: (list: string, elementId: string, sharing: Sharing) => Promise<void>;
  deviceElementFor: (list: string, elementId: string) => "on" | "off" | null;
  setDeviceElement: (list: string, elementId: string, state: "on" | "off") => Promise<void>;
  followTheDefault: (list: string, elementId: string) => Promise<void>;
  leaveToThisDevice: (list: string, elementId: string) => Promise<void>;
  coreContext: () => Promise<{
    switchExceptions: Record<string, string[]>;
    switchForceOn: Record<string, string[]>;
    switchForceOff: Record<string, string[]>;
  }>;
}

async function makePlugin(opts: {
  io: MemFS;
  rules?: Record<string, Sharing>;
  liveEnabled?: string[];
  localSeed?: Record<string, string>;
}): Promise<{ plugin: Surface; local: (key: string) => string | undefined }> {
  const ls = makeLocalStorage(opts.localSeed ?? {});
  const instance = new ConfigSyncPlugin({} as never, {} as never) as unknown as Surface;
  instance.app = {
    vault: { adapter: opts.io, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: {
      manifests: { [ELEMENT]: { id: ELEMENT, name: "Remotely Save", version: "1.0.0" } },
      enabledPlugins: new Set<string>(opts.liveEnabled ?? []),
      plugins: {},
    },
    workspace: { getLeavesOfType: () => [] },
    ...ls.api,
  };
  instance.loadData = async () => ({ schemaVersion: 4, rootPath: "cs", items: items(opts.rules ?? {}), remotes: [] });
  instance.saveData = async () => {};
  await instance.loadSettings();
  await instance.recompile();
  return { plugin: instance, local: (key) => ls.store.get(key) };
}

function seededIO(persistedOn: string[]): MemFS {
  const io = new MemFS();
  io.seed({ [LOCAL_FILE]: JSON.stringify(persistedOn) });
  return io;
}

describe("the runtime mask reads one rule layer and one local layer (spec §5)", () => {
  // §9 criterion 3 (C-#52's regression assertion). The failure this closes: `thisDeviceItems` lived
  // in data.json, a pull replaced that document with another device's, and this device's own choice
  // was simply gone. A SECOND plugin instance is what proves it — same localStorage, a foreign
  // data.json, and the exception still decides.
  it("an Off here survives a pull that rewrites data.json (C-#52 regression)", async () => {
    const io = seededIO([ELEMENT]);
    const first = await makePlugin({ io, liveEnabled: [ELEMENT] });
    await first.plugin.setDeviceElement(LIST, ELEMENT, "off");

    const before = await first.plugin.coreContext();
    expect(before.switchExceptions[LIST] ?? []).toContain(ELEMENT);
    expect(before.switchForceOff[LIST] ?? []).toContain(ELEMENT);

    // The pull: another device's document lands here wholesale — no rules, no trace of this
    // device's choice in it, because the choice was never in a document that travels.
    const carried = first.local(DEVICE_ELEMENTS_KEY);
    expect(carried).toBeDefined();
    const after = await makePlugin({ io, liveEnabled: [ELEMENT], localSeed: { [DEVICE_ELEMENTS_KEY]: carried as string } });

    expect(after.plugin.deviceElementFor(LIST, ELEMENT)).toBe("off");
    const ctx = await after.plugin.coreContext();
    expect(ctx.switchExceptions[LIST] ?? []).toContain(ELEMENT);
    expect(ctx.switchForceOff[LIST] ?? []).toContain(ELEMENT);
  });

  // §9 criterion 4: precedence 1 beats precedence 3. The rule is set AFTER the exception and to the
  // class this device IS — under the old model the class rule was the only thing the mask read for
  // a non-pinned id, so the exception would have vanished behind it.
  it("a local exception outranks a class rule set afterwards", async () => {
    const io = seededIO([ELEMENT]);
    const { plugin } = await makePlugin({ io, liveEnabled: [ELEMENT] });
    await plugin.setDeviceElement(LIST, ELEMENT, "off");

    await plugin.setEnablementRule(LIST, ELEMENT, perClass("desktop")); // this device's own class

    const ctx = await plugin.coreContext();
    // A matching class rule alone would mask nothing at all; the exception is what decides.
    expect(ctx.switchExceptions[LIST] ?? []).toContain(ELEMENT);
    expect(ctx.switchForceOff[LIST] ?? []).toContain(ELEMENT);
    expect(ctx.switchForceOn[LIST] ?? []).not.toContain(ELEMENT);
    // …and the rule is still stored, untouched — the two layers do not overwrite each other.
    expect(plugin.enablementRuleFor(LIST, ELEMENT)).toEqual(perClass("desktop"));
    expect(plugin.deviceElementFor(LIST, ELEMENT)).toBe("off");
  });

  // Precedence 2. "Each device decides" is pass-through, not a decision: the element leaves the
  // shared answer and whatever is on this machine stays exactly as it is. A force here would be
  // this build deciding something the user never said.
  it("Each device decides masks without forcing — the local file is left exactly as it was", async () => {
    const io = seededIO([ELEMENT]);
    const before = io.files.get(LOCAL_FILE);
    const { plugin } = await makePlugin({ io, rules: { [ELEMENT]: THIS_DEVICE }, liveEnabled: [ELEMENT] });

    const ctx = await plugin.coreContext();
    expect(ctx.switchExceptions[LIST] ?? []).toContain(ELEMENT);
    expect(ctx.switchForceOn[LIST] ?? []).not.toContain(ELEMENT);
    expect(ctx.switchForceOff[LIST] ?? []).not.toContain(ELEMENT);
    expect(io.files.get(LOCAL_FILE)).toBe(before);
  });

  // Precedence 4, the neutral case: no rule, no exception — nothing to say, nothing masked.
  it("an All-devices rule with no exception masks nothing", async () => {
    const io = seededIO([ELEMENT]);
    const { plugin } = await makePlugin({ io, liveEnabled: [ELEMENT] });

    expect(plugin.enablementRuleFor(LIST, ELEMENT)).toEqual(EVERYWHERE);
    const ctx = await plugin.coreContext();
    expect(ctx.switchExceptions[LIST] ?? []).not.toContain(ELEMENT);
    expect(ctx.switchForceOff[LIST] ?? []).not.toContain(ELEMENT);
  });

  // Spec §6.5, "switching to an exception keeps the status quo". The state is read from the
  // PERSISTED list file, never from a live plugin query: a non-persistent enablePlugin (which
  // config-sync's own apply cycle and the IOTO ecosystem both use) leaves a plugin loaded without
  // it being in the persisted enabled set, so the two genuinely diverge.
  it("leaveToThisDevice seeds the exception from the persisted list, not from a live plugin query", async () => {
    const liveOnly = await makePlugin({ io: seededIO([]), liveEnabled: [ELEMENT] }); // live on, persisted off
    await liveOnly.plugin.leaveToThisDevice(LIST, ELEMENT);
    expect(liveOnly.plugin.deviceElementFor(LIST, ELEMENT)).toBe("off");

    const persistedOn = await makePlugin({ io: seededIO([ELEMENT]), liveEnabled: [] }); // persisted on, live off
    await persistedOn.plugin.leaveToThisDevice(LIST, ELEMENT);
    expect(persistedOn.plugin.deviceElementFor(LIST, ELEMENT)).toBe("on");

    // …and the seeded state is what the run then enforces, so the status quo really is kept.
    const ctx = await persistedOn.plugin.coreContext();
    expect(ctx.switchForceOn[LIST] ?? []).toContain(ELEMENT);
  });

  // One writer, one store (spec §6.6): clearing the last exception drops the localStorage key
  // outright rather than leaving `{}` behind (C-#26's prune discipline).
  it("followTheDefault clears the exception and leaves the store as it was found", async () => {
    const io = seededIO([ELEMENT]);
    const { plugin, local } = await makePlugin({ io, liveEnabled: [ELEMENT] });
    await plugin.setDeviceElement(LIST, ELEMENT, "on");
    expect(local(DEVICE_ELEMENTS_KEY)).toBeDefined();

    await plugin.followTheDefault(LIST, ELEMENT);

    expect(plugin.deviceElementFor(LIST, ELEMENT)).toBeNull();
    expect(local(DEVICE_ELEMENTS_KEY)).toBeUndefined();
    const ctx = await plugin.coreContext();
    expect(ctx.switchExceptions[LIST] ?? []).not.toContain(ELEMENT);
  });
});

// ── The migration's acceptance criteria (spec §9) ──────────────────────────────────────────────
//
// Criterion 1 is the only HARD behavioural assertion the v3 → v4 migration makes: not a switch
// moves. It is asserted at the only place that can prove it — the BYTES of the on/off list files,
// before the migration and after a full capture + apply cycle on the migrated document.
//
// The two plugin lists are the ones the migration writes rules for; `enabled-css-snippets` has no
// v3 field to migrate (its perElement rules already live on appearance under the same key), so its
// carry is asserted structurally in the last test below rather than through a third file whose
// unrelated appearance fields would dominate the comparison.

const V3_LOCAL_COMMUNITY = JSON.stringify(["dataview", "obsidian-git", "some-unsynced", "remotely-save"], null, 2) + "\n";
const V3_LOCAL_CORE = JSON.stringify({ graph: true, "daily-notes": false }, null, 2) + "\n";
const STORE_COMMUNITY = "cs/store/configdir/community-plugins.json";
const STORE_CORE = "cs/store/configdir/core-plugins.json";
const LOCAL_CORE = "config-dir/core-plugins.json";

// A v3 document with one of every shape §4 has a row for, plus the shape it has no row for: an
// entry that is simply not synced (`some-unsynced`), whose element v3 masked structurally.
function v3Document(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    rootPath: "cs",
    remotes: [],
    thisDeviceItems: ["community/remotely-save"],
    items: {
      obsidian: {
        appearance: {
          enabled: true,
          companions: [{ path: "{configDir}/themes", device: "all", enabled: true }],
          settingsFile: { mode: "fields", rules: {}, perElement: { [perElementKeyFor("enabled-css-snippets")]: { "mobile.css": THIS_DEVICE } } },
        },
      },
      core: { graph: { enabled: true }, "daily-notes": { enabled: false } },
      community: {
        dataview: { enabled: true },
        "obsidian-git": { enabled: true, runsOn: { device: "desktop" } },
        "some-unsynced": { enabled: false },
        "remotely-save": { enabled: true },
      },
      custom: {},
    },
  };
}

interface MigrationSurface {
  app: unknown;
  loadData: () => Promise<unknown>;
  saveData: (d: unknown) => Promise<void>;
  loadSettings: () => Promise<void>;
  recompile: () => Promise<boolean>;
  settings: { items: ItemMap };
  coreContext: () => Promise<CoreContext>;
}

async function migratedPlugin(io: MemFS): Promise<{ plugin: MigrationSurface; saved: () => Record<string, unknown> | null; local: (k: string) => string | undefined }> {
  const ls = makeLocalStorage({});
  const instance = new ConfigSyncPlugin({} as never, {} as never) as unknown as MigrationSurface;
  instance.app = {
    vault: { adapter: io, configDir: "config-dir", on: () => ({}) },
    internalPlugins: { plugins: {} },
    plugins: { manifests: {}, enabledPlugins: new Set<string>(), plugins: {} },
    workspace: { getLeavesOfType: () => [] },
    ...ls.api,
  };
  instance.loadData = async () => v3Document();
  let saved: Record<string, unknown> | null = null;
  instance.saveData = async (d) => {
    saved = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  };
  await instance.loadSettings();
  await instance.recompile();
  return { plugin: instance, saved: () => saved, local: (k) => ls.store.get(k) };
}

function seededMigrationIO(): MemFS {
  const io = new MemFS();
  io.seed({
    [LOCAL_FILE]: V3_LOCAL_COMMUNITY,
    [LOCAL_CORE]: V3_LOCAL_CORE,
    // The store the fleet already agreed on. `some-unsynced` is IN it — that is what makes the
    // pass-through assertion below mean something: an element this device never synced must be
    // neither added nor removed by this device's capture.
    [STORE_COMMUNITY]: JSON.stringify(["dataview", "obsidian-git", "some-unsynced"], null, 2) + "\n",
    [STORE_CORE]: JSON.stringify({ graph: true }, null, 2) + "\n",
  });
  return io;
}

describe("the v3 → v4 migration moves no switch (spec §9 criterion 1)", () => {
  it("leaves the on/off list files byte-identical across a full capture + apply cycle", async () => {
    const io = seededMigrationIO();
    const before = { community: io.files.get(LOCAL_FILE), core: io.files.get(LOCAL_CORE) };
    const { plugin } = await migratedPlugin(io);

    // The plugin host is swapped for the fake one: applying an on/off list turns plugins on and off
    // through it, and this test is about the FILES, not about Obsidian's runtime switching.
    const ctx: CoreContext = { ...(await plugin.coreContext()), plugins: new FakePlugins() };
    await capture(ctx);
    await applyWithActions(
      ctx,
      [
        { name: "community-plugins", action: "none" },
        { name: "core-plugins", action: "none" },
      ],
      async () => "1.0.0"
    );

    expect(io.files.get(LOCAL_FILE)).toBe(before.community);
    expect(io.files.get(LOCAL_CORE)).toBe(before.core);
  });

  // The F1 half, at the seam that pays for it: an entry that was not synced keeps its element out
  // of this device's business entirely — capture may neither add it to the shared list nor drop it
  // from one, exactly as v3's structural this-device did.
  it("an unsynced entry's element passes through capture untouched, in the store and out of it", async () => {
    const io = seededMigrationIO();
    const { plugin } = await migratedPlugin(io);
    const ctx: CoreContext = { ...(await plugin.coreContext()), plugins: new FakePlugins() };

    expect(ctx.switchExceptions["community-plugins"]).toContain("some-unsynced");
    await capture(ctx);

    // still in the store (this device did not remove what it never synced)…
    expect(JSON.parse(io.files.get(STORE_COMMUNITY) ?? "[]")).toContain("some-unsynced");
    // …and the pinned one is still out of it (this device did not publish its own pin).
    expect(JSON.parse(io.files.get(STORE_COMMUNITY) ?? "[]")).not.toContain("remotely-save");
  });

  it("freezes the pin's local half into the exception table, at the state it was already in", async () => {
    const io = seededMigrationIO();
    const { plugin, local } = await migratedPlugin(io);

    expect(JSON.parse(local(DEVICE_ELEMENTS_KEY) ?? "{}")).toEqual({ "community-plugins": { "remotely-save": "on" } });
    expect(plugin.settings.items.obsidian["community-plugins"]?.settingsFile?.perElement[perElementKeyFor("community-plugins")]).toEqual({
      "obsidian-git": perClass("desktop"),
      "some-unsynced": THIS_DEVICE,
      "remotely-save": THIS_DEVICE,
    });
  });

  // §9 criterion 2: the retired fields are gone from what reaches DISK — the leak window
  // `thisDeviceItems` opened (a this-device datum in a document that travels) closes here, not
  // merely in memory.
  it("the saved document carries none of the retired fields (criterion 2)", async () => {
    const { plugin, saved } = await migratedPlugin(seededMigrationIO());
    const document = saved();
    expect(document).not.toBeNull();
    const text = JSON.stringify(document);
    for (const dead of ["runsOn", "thisDeviceItems", "bratIndex"]) expect(text).not.toContain(dead);
    expect(document?.schemaVersion).toBe(4);

    // `enabled` is asserted at the ITEM level rather than by a regex over the whole document,
    // because two legitimate `enabled` fields remain and must: a companion's own on/off
    // (ItemCompanion.enabled) and the local run-history preference. The walk says exactly what §3.2
    // retired — an ITEM's `enabled`, now `synced` — without pretending the others are gone.
    for (const byId of Object.values(document?.items as Record<string, Record<string, Record<string, unknown>>>)) {
      for (const [id, item] of Object.entries(byId)) {
        expect(`${id}: ${JSON.stringify("enabled" in item)}`).toBe(`${id}: false`);
        expect("elements" in item).toBe(false);
      }
    }
    expect(plugin.settings.items.obsidian["appearance"]?.companions?.[0]?.enabled).toBe(true);
    // The snippet list's rules were already stored in exactly this place and are carried verbatim.
    expect(plugin.settings.items.obsidian["appearance"]?.settingsFile?.perElement[perElementKeyFor("enabled-css-snippets")]).toEqual({
      "mobile.css": THIS_DEVICE,
    });
  });
});
