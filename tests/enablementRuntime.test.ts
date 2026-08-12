import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { MemFS } from "./memfs";
import { itemsIn } from "./items";
import { Item, ItemMap } from "../src/core/registry";
import { EVERYWHERE, perClass, Sharing, THIS_DEVICE } from "../src/core/types";
import { perElementKeyFor } from "../src/core/switchList";
import { DEVICE_ELEMENTS_KEY } from "../src/core/deviceElements";

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
  instance.loadData = async () => ({ schemaVersion: 3, rootPath: "cs", items: items(opts.rules ?? {}), remotes: [] });
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
