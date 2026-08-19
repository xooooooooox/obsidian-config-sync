import { describe, expect, it } from "vitest";
import { capturePerElementArray, applyPerElementArray } from "../src/core/perElement";
import { captureTransform, applyTransform, contentUnchanged } from "../src/core/modes";
import { validateSyncManifest, ManifestValidationError } from "../src/core/manifest";
import { PerElementSharing, perClass, SyncGroup, EVERYWHERE, THIS_DEVICE } from "../src/core/types";
import { capture, CoreContext, writeGroups } from "../src/core/ConfigSyncCore";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

// Per-item scopes (spec 2026-07-25-unified-card-design.md) generalize
// switch-list semantics to any string-array key. capture(c) = local[scope∈{all,c}] (local
// order) ++ store[scope=otherClass(c)] (store order), deduped first-occurrence-wins.
// apply(c) = store[scope∈{all,c}] (store order) ++ local[scope=local] (local order), deduped.

describe("capturePerElementArray", () => {
  it.each(["desktop", "mobile"] as const)("%s: all/own/other/local elements land per formula, stale local-scoped store element dropped", (cls) => {
    const other = cls === "desktop" ? "mobile" : "desktop";
    const scopes: PerElementSharing = {
      "own-item": perClass(cls),
      "other-item": perClass(other),
      "local-item": THIS_DEVICE,
      "other-store-item": perClass(other),
      "stale-local-item": THIS_DEVICE,
    };
    const local = ["all-item", "own-item", "other-item", "local-item"];
    const store = ["all-item", "other-store-item", "stale-local-item"];

    const result = capturePerElementArray(local, store, scopes, cls);

    // fromLocal: all-item (default "all"), own-item (scope=cls) — local order.
    // fromStore: other-store-item (scope=other) — store order. other-item/local-item/
    // stale-local-item never appear (wrong scope for either branch).
    expect(result).toEqual(["all-item", "own-item", "other-store-item"]);
  });

  it("dedupes local duplicates, first occurrence wins", () => {
    const result = capturePerElementArray(["x", "x", "y"], [], {}, "desktop");
    expect(result).toEqual(["x", "y"]);
  });

  it("first capture (empty store) includes only local all/own elements", () => {
    const scopes: PerElementSharing = { "mobile-only": perClass("mobile") };
    const result = capturePerElementArray(["shared", "mobile-only"], [], scopes, "desktop");
    expect(result).toEqual(["shared"]);
  });
});

describe("applyPerElementArray", () => {
  it.each(["desktop", "mobile"] as const)("%s: store all/own elements plus local-only local-scoped elements", (cls) => {
    const other = cls === "desktop" ? "mobile" : "desktop";
    const scopes: PerElementSharing = {
      "own-item": perClass(cls),
      "other-item": perClass(other),
      "local-thing": THIS_DEVICE,
    };
    const store = ["all-item", "own-item", "other-item"];
    const local = ["local-thing", "all-item"];

    const result = applyPerElementArray(store, local, scopes, cls);

    // fromStore: all-item, own-item (other-item excluded — wrong scope). fromLocal: local-thing
    // (all-item excluded — its scope is "all", not "local").
    expect(result).toEqual(["all-item", "own-item", "local-thing"]);
  });

  it("dedupes, first occurrence wins", () => {
    const result = applyPerElementArray(["x", "x"], ["y"], {}, "desktop");
    expect(result).toEqual(["x"]);
  });

  it("no local file yet: result is store's all/own elements only", () => {
    const scopes: PerElementSharing = { "mobile-only": perClass("mobile") };
    const result = applyPerElementArray(["shared", "mobile-only"], [], scopes, "desktop");
    expect(result).toEqual(["shared"]);
  });
});

describe("capture ∘ apply ∘ capture idempotence", () => {
  it.each(["desktop", "mobile"] as const)("%s: a second capture/apply cycle reproduces the same store array", (cls) => {
    const other = cls === "desktop" ? "mobile" : "desktop";
    const scopes: PerElementSharing = {
      "own-item": perClass(cls),
      "other-item": perClass(other),
      "local-item": THIS_DEVICE,
    };
    const local = ["all-item", "own-item", "local-item"];
    const store = ["all-item", "other-item"];

    const store1 = capturePerElementArray(local, store, scopes, cls);
    const local2 = applyPerElementArray(store1, local, scopes, cls);
    const store2 = capturePerElementArray(local2, store1, scopes, cls);

    expect(store2).toEqual(store1);
  });
});

// --- Wiring: fields-mode captureTransform/applyTransform/contentUnchanged -------------------

function fieldsGroup(perElement: Record<string, PerElementSharing>, extraFields: SyncGroup["fields"] = []): SyncGroup {
  return {
    name: "app",
    path: "{configDir}/app.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: extraFields,
    perElement,
  };
}

describe("captureTransform — perItem wiring", () => {
  it("merges local all/own elements with prior store's other-class elements for the listed key", async () => {
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile") } });
    const local = JSON.stringify({ tags: ["shared-tag"], other: "unrelated" });
    const store = JSON.stringify({ tags: ["mobile-tag"], other: "stale" });
    const t = await captureTransform(group, local, null, "desktop", store);
    const parsed = JSON.parse(t.content) as { tags: string[]; other: string };
    expect(parsed.tags).toEqual(["shared-tag", "mobile-tag"]);
    expect(parsed.other).toBe("unrelated"); // non-perItem keys untouched by the wiring
  });

  it("first capture (no prior store) drops other-class elements", async () => {
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile") } });
    const local = JSON.stringify({ tags: ["shared-tag", "mobile-tag"] });
    const t = await captureTransform(group, local, null, "desktop", null);
    const parsed = JSON.parse(t.content) as { tags: string[] };
    expect(parsed.tags).toEqual(["shared-tag"]);
  });

  it("throws an explicit error naming the group, key, and actual type when the live value isn't a string array", async () => {
    const group = fieldsGroup({ tags: {} });
    const local = JSON.stringify({ tags: { not: "an array" } });
    await expect(captureTransform(group, local, null, "desktop", null)).rejects.toThrow(/"app".*"tags".*object/s);
  });

  it("throws for a non-array-of-strings value (numbers) too", async () => {
    const group = fieldsGroup({ tags: {} });
    const local = JSON.stringify({ tags: [1, 2, 3] });
    await expect(captureTransform(group, local, null, "desktop", null)).rejects.toThrow(/"tags"/);
  });
});

describe("applyTransform — perItem wiring", () => {
  it("merges store all/own elements with local's local-scoped elements for the listed key", async () => {
    const store = JSON.stringify({ tags: ["shared-tag", "mobile-tag"], other: "from-store" });
    const local = JSON.stringify({ tags: ["local-only-tag"], other: "from-local" });
    // "local-only-tag" needs an explicit "local" scope entry — an absent entry defaults to
    // "all" and would not survive apply unless the store also carried it.
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile"), "local-only-tag": THIS_DEVICE } });
    const out = JSON.parse(await applyTransform(group, store, local, null, "desktop", null)) as { tags: string[] };
    expect(out.tags).toEqual(["shared-tag", "local-only-tag"]);
  });

  it("no local file yet: result is store's all/own elements only", async () => {
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile") } });
    const store = JSON.stringify({ tags: ["shared-tag", "mobile-tag"] });
    const out = JSON.parse(await applyTransform(group, store, null, null, "desktop", null)) as { tags: string[] };
    expect(out.tags).toEqual(["shared-tag"]);
  });
});

describe("contentUnchanged — perItem symmetry", () => {
  it("ignores an other-class element present in store but absent locally", async () => {
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile") } });
    const local = JSON.stringify({ tags: ["shared-tag"] });
    const store = JSON.stringify({ tags: ["shared-tag", "mobile-tag"] });
    expect(await contentUnchanged(group, local, store, null, "desktop", null)).toBe(true);
  });

  it("still detects a real difference in the all/own portion", async () => {
    const group = fieldsGroup({ tags: { "mobile-tag": perClass("mobile") } });
    const local = JSON.stringify({ tags: ["shared-tag"] });
    const store = JSON.stringify({ tags: ["shared-tag", "another-shared-tag", "mobile-tag"] });
    expect(await contentUnchanged(group, local, store, null, "desktop", null)).toBe(false);
  });

  it("mobile device symmetrically ignores desktop-only elements", async () => {
    const group = fieldsGroup({ tags: { "desktop-tag": perClass("desktop") } });
    const local = JSON.stringify({ tags: ["shared-tag"] });
    const store = JSON.stringify({ tags: ["shared-tag", "desktop-tag"] });
    expect(await contentUnchanged(group, local, store, null, "mobile", null)).toBe(true);
  });
});

// --- Manifest validation ---------------------------------------------------------------------

describe("manifest validation — perItem", () => {
  const BASE = { name: "app", path: "{configDir}/app.json", type: "file", devices: "all" };

  it("accepts a valid perItem map alongside mode:fields", () => {
    const m = validateSyncManifest({
      version: 1,
      groups: [{ ...BASE, mode: "fields", fields: [], perElement: { tags: { "mobile-tag": perClass("mobile") } } }],
    });
    expect(m.groups[0]?.perElement).toEqual({ tags: { "mobile-tag": perClass("mobile") } });
  });

  it("rejects perItem on a key that also has encrypted:true in its field rule", () => {
    expect(() =>
      validateSyncManifest({
        version: 1,
        groups: [
          {
            ...BASE,
            mode: "fields",
            fields: [{ pattern: "tags", sharing: EVERYWHERE, encrypted: true }],
            perElement: { tags: { "mobile-tag": perClass("mobile") } },
          },
        ],
      })
    ).toThrow(/tags.*encrypted/is);
  });

  it("rejects an invalid scope value inside a perItem map", () => {
    expect(() =>
      validateSyncManifest({
        version: 1,
        groups: [{ ...BASE, mode: "fields", fields: [], perElement: { tags: { "mobile-tag": "tablet" } } }],
      })
    ).toThrow(ManifestValidationError);
  });

  it("rejects perItem set without mode:fields", () => {
    expect(() =>
      validateSyncManifest({
        version: 1,
        groups: [{ ...BASE, perElement: { tags: { "mobile-tag": perClass("mobile") } } }],
      })
    ).toThrow(ManifestValidationError);
  });

  it("rejects a non-object perItem map", () => {
    expect(() =>
      validateSyncManifest({
        version: 1,
        groups: [{ ...BASE, mode: "fields", fields: [], perElement: { tags: ["not", "a", "map"] } }],
      })
    ).toThrow(ManifestValidationError);
  });
});

// captureTransform's optional 5th param (prior store content) —
// ConfigSyncCore.ts's captureGroup must thread the EXISTING store copy through it for perItem
// groups, or a second device's capture degrades to first-capture semantics every run and
// silently drops whatever the other device already contributed. Drives capture() end-to-end
// (not just captureTransform in isolation) to prove the real wiring, not just the pure function.
describe("perItem capture through ConfigSyncCore — storeContent threading", () => {
  const GROUP: SyncGroup = {
    name: "prefs",
    path: "{configDir}/prefs.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [],
    perElement: { list: { "desktop-item": perClass("desktop"), "mobile-item": perClass("mobile") } },
  };

  function setup(deviceClass: "desktop" | "mobile"): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins: new FakePlugins(),
      passphrase: null,
      deviceClass,
      groupsIO: memGroupsIO([GROUP]),
      now: () => "2026-07-25T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  it("a second device's capture preserves the first device's already-captured elements", async () => {
    // Desktop captures first: its local file only knows about desktop-item.
    const desktop = setup("desktop");
    await writeGroups(desktop.ctx, [GROUP]);
    await desktop.io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item", "desktop-item"] }));
    await capture(desktop.ctx, ["prefs"]);
    const afterDesktop = JSON.parse(await desktop.io.read("cs/store/configdir/prefs.json")) as { list: string[] };
    expect(afterDesktop.list).toEqual(["shared-item", "desktop-item"]);

    // Mobile captures next, against the SAME store the desktop capture just wrote — its own
    // local file only knows about mobile-item, and has no idea desktop-item exists.
    const mobile = setup("mobile");
    await writeGroups(mobile.ctx, [GROUP]);
    await mobile.io.write("cs/store/configdir/prefs.json", await desktop.io.read("cs/store/configdir/prefs.json"));
    await mobile.io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item", "mobile-item"] }));
    await capture(mobile.ctx, ["prefs"]);
    const afterMobile = JSON.parse(await mobile.io.read("cs/store/configdir/prefs.json")) as { list: string[] };

    // Without storeContent threading, this capture would degrade to first-capture semantics
    // (storeContent treated as absent) and produce only ["shared-item", "mobile-item"] — silently
    // dropping desktop-item that the desktop device already contributed.
    expect(afterMobile.list).toEqual(["shared-item", "mobile-item", "desktop-item"]);
  });
});

// Third extension of the baseHasStaleClassKeys/baseHasStaleDisabledSliceKeys base-hygiene
// mechanism (smoke finding): perElementArrayUnchanged symmetrically ignores "local"-scoped elements
// on both sides, so contentUnchanged can report "no change" while the store base still carries an
// element that was re-scoped to "local" — capture would then skip the rewrite forever, and the
// stale element keeps shipping to other devices. Live repro: appearance group, perElement:
// {enabledCssSnippets: {"kanban-block-editor": THIS_DEVICE}}, base still has the snippet after
// multiple captures.
describe("capture base-hygiene: stale local-scoped per-item elements", () => {
  const GROUP: SyncGroup = {
    name: "prefs",
    path: "{configDir}/prefs.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [],
    perElement: { list: { "local-item": THIS_DEVICE, "mobile-item": perClass("mobile") } },
  };

  function setup(): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins: new FakePlugins(),
      passphrase: null,
      deviceClass: "desktop",
      groupsIO: memGroupsIO([GROUP]),
      now: () => "2026-07-25T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  const BASE_PATH = "cs/store/configdir/prefs.json";

  it("a base carrying a now-local-scoped element is purged on the next capture (smoke scenario)", async () => {
    const { io, ctx } = setup();
    // Local file has already dropped the element (user turned the snippet off after re-scoping it
    // to "local") — same shape as the smoke repro: an element re-scoped to "local" whose base copy
    // predates the re-scope and is never rewritten because contentUnchanged ignores it.
    await io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item"] }));
    await io.write(BASE_PATH, JSON.stringify({ list: ["shared-item", "local-item"] }) + "\n");

    const results = await capture(ctx, ["prefs"]);
    const r = results.find((x) => x.group === "prefs");

    expect(r?.status).toBe("ok");
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ list: ["shared-item"] });
    expect(r?.changes.updated).toEqual(["prefs.json"]);
  });

  it("an other-class element in the base is NOT treated as stale (no forced rewrite)", async () => {
    const { io, ctx } = setup();
    await io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item"] }));
    await io.write(BASE_PATH, JSON.stringify({ list: ["shared-item", "mobile-item"] }) + "\n");

    const results = await capture(ctx, ["prefs"]);
    const r = results.find((x) => x.group === "prefs");

    expect(r?.status).toBe("ok");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] }); // store's union of non-local elements — not stale
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ list: ["shared-item", "mobile-item"] });
  });

  it("a second capture after the purge reports no further changes (idempotent)", async () => {
    const { io, ctx } = setup();
    await io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item"] }));
    await io.write(BASE_PATH, JSON.stringify({ list: ["shared-item", "local-item"] }) + "\n");

    await capture(ctx, ["prefs"]); // first capture: purges the base
    const results = await capture(ctx, ["prefs"]); // second capture: nothing left to purge
    const r = results.find((x) => x.group === "prefs");

    expect(r?.status).toBe("ok");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ list: ["shared-item"] });
  });

  it('re-scoping the element back to "all" restores it on the next capture', async () => {
    const { io, ctx } = setup();
    await io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item"] }));
    await io.write(BASE_PATH, JSON.stringify({ list: ["shared-item", "local-item"] }) + "\n");
    await capture(ctx, ["prefs"]); // purges local-item from the base

    // User re-scopes local-item back to "all" (drops its perItem entry) and re-enables it locally
    // — per-item elements live locally, so this is how it "returns": the next capture picks it
    // back up from the local file, not from the (already-purged) store.
    ctx.groupsIO = memGroupsIO([{ ...GROUP, perElement: { list: { "mobile-item": perClass("mobile") } } }]);
    await io.write(".obs/prefs.json", JSON.stringify({ list: ["shared-item", "local-item"] }));

    const results = await capture(ctx, ["prefs"]);
    const r = results.find((x) => x.group === "prefs");

    expect(r?.status).toBe("ok");
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ list: ["shared-item", "local-item"] });
  });
});
