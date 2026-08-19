import { describe, expect, it } from "vitest";
import { capture, CoreContext } from "../src/core/ConfigSyncCore";
import { SyncGroup, THIS_DEVICE, perClass } from "../src/core/types";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

// Regression for the capture base-hygiene bug (2026-07-25): a fresh class rule on a fields-mode
// group must purge the class-scoped key from the store BASE, not just write the sidecar.
// contentUnchanged deliberately ignores class-scoped top-level keys on both sides (spec
// 2026-07-25-domain-mirror-design.md's diff semantics), so before the fix, a base that
// still carried the class key after the rule was added looked "unchanged" and was never rewritten.
describe("capture sidecar lifecycle: base-hygiene for class keys", () => {
  const APP_GROUP: SyncGroup = {
    name: "app",
    path: "{configDir}/app.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [{ pattern: "userIgnoreFilters", sharing: perClass("desktop"), encrypted: false }],
  };

  function setup(): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins,
      passphrase: null,
      deviceClass: "desktop",
      groupsIO: memGroupsIO([APP_GROUP]),
      now: () => "2026-07-25T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  const LOCAL_CONTENT = JSON.stringify({ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] });
  const BASE_PATH = "cs/store/configdir/app.json";
  const DESKTOP_SIDECAR_PATH = "cs/store/configdir/app.json.__scopes__.desktop.json";
  const MOBILE_SIDECAR_PATH = "cs/store/configdir/app.json.__scopes__.mobile.json";

  it("first capture after the rule lands rewrites the stale base and writes the sidecar; local content is unchanged", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/app.json": LOCAL_CONTENT,
      // Store base written BEFORE the class rule existed — still carries the class key, as a
      // plain (pre-rule) capture would have produced.
      [BASE_PATH]: LOCAL_CONTENT + "\n",
    });

    const results = await capture(ctx);
    const r = results.find((x) => x.group === "app");
    expect(r?.status).toBe("ok");

    // Base purged of the class-scoped key —'s "no class-scoped keys in the base" invariant.
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
    expect(r?.changes.updated).toEqual(["app.json"]);

    // Sidecar written with the class-scoped key.
    expect(await io.exists(DESKTOP_SIDECAR_PATH)).toBe(true);
    expect(JSON.parse(await io.read(DESKTOP_SIDECAR_PATH))).toEqual({ userIgnoreFilters: ["a/"] });

    // The other class's sidecar is never created — this group has no mobile-class pattern.
    expect(await io.exists(MOBILE_SIDECAR_PATH)).toBe(false);
  });

  it("a second capture with local content unchanged reports no changes (idempotent)", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/app.json": LOCAL_CONTENT,
      [BASE_PATH]: LOCAL_CONTENT + "\n",
    });

    await capture(ctx); // first capture: purges the base, writes the sidecar
    const results = await capture(ctx); // second capture: nothing should change
    const r = results.find((x) => x.group === "app");

    expect(r?.status).toBe("ok");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(r?.filesWritten).toEqual([]);

    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
    expect(JSON.parse(await io.read(DESKTOP_SIDECAR_PATH))).toEqual({ userIgnoreFilters: ["a/"] });
    expect(await io.exists(MOBILE_SIDECAR_PATH)).toBe(false);
  });
});

// Regression for the third base-hygiene family (2026-08-04): a field re-scoped to "local"
// whose value was already in the store base (captured before the local rule) must be purged
// from the base. contentUnchanged strips top-level local keys on both sides (Fix B), so a stale
// base looked "unchanged" and was never rewritten — the leak the class-key and per-item guards
// already close for their families, now closed for top-level local keys too.
describe("capture base-hygiene for top-level local keys", () => {
  const LOCAL_FIELD_GROUP: SyncGroup = {
    name: "app",
    path: "{configDir}/app.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [{ pattern: "userIgnoreFilters", sharing: THIS_DEVICE, encrypted: false }],
  };

  function setup(): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins,
      passphrase: null,
      deviceClass: "desktop",
      groupsIO: memGroupsIO([LOCAL_FIELD_GROUP]),
      now: () => "2026-08-04T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  const LOCAL_CONTENT = JSON.stringify({ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] });
  const BASE_PATH = "cs/store/configdir/app.json";
  const LOCAL_SIDECAR_DESKTOP = "cs/store/configdir/app.json.__scopes__.desktop.json";
  const LOCAL_SIDECAR_MOBILE = "cs/store/configdir/app.json.__scopes__.mobile.json";

  it("purges a stale local key from the base; local content is untouched, no sidecar is written", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/app.json": LOCAL_CONTENT,
      // Store base written BEFORE the local rule existed — still carries the now-local key.
      [BASE_PATH]: LOCAL_CONTENT + "\n",
    });

    const results = await capture(ctx);
    const r = results.find((x) => x.group === "app");
    expect(r?.status).toBe("ok");

    // Base purged of the local-scoped key — the store must never carry a device-local value.
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
    expect(r?.changes.updated).toEqual(["app.json"]);

    // Local scope never lands in a sidecar (that is class scope) — neither class sidecar exists.
    expect(await io.exists(LOCAL_SIDECAR_DESKTOP)).toBe(false);
    expect(await io.exists(LOCAL_SIDECAR_MOBILE)).toBe(false);

    // The device keeps its own value.
    expect(JSON.parse(await io.read(".obs/app.json"))).toEqual({ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] });
  });

  it("no-op when the base is already clean: local patterns present but base carries no such key", async () => {
    const { io, ctx } = setup();
    const CLEAN = JSON.stringify({ attachmentFolderPath: "99" });
    io.seed({
      ".obs/app.json": CLEAN,
      [BASE_PATH]: CLEAN + "\n",
    });

    const results = await capture(ctx);
    const r = results.find((x) => x.group === "app");

    expect(r?.status).toBe("ok");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(r?.filesWritten).toEqual([]);
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
  });
});
