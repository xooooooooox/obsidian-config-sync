import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOT,
  IOTO_FALLBACK_ROOT,
  PkmProbe,
  defaultRootForMode,
  discoverStoreRoot,
  resolveEffectiveMode,
  resolveRootPath,
} from "../src/core/pkm";
import { FakePlugins, MemFS } from "./memfs";

function probe(): { io: MemFS; plugins: FakePlugins; p: PkmProbe } {
  const io = new MemFS();
  const plugins = new FakePlugins();
  const p: PkmProbe = {
    io,
    configDir: ".obs",
    isPluginEnabled: (id) => plugins.isPluginEnabled(id),
  };
  return { io, plugins, p };
}

describe("resolveEffectiveMode", () => {
  it("auto resolves by ioto-update enablement", () => {
    const { plugins, p } = probe();
    expect(resolveEffectiveMode("auto", p)).toBe("default");
    plugins.enabled.add("ioto-update");
    expect(resolveEffectiveMode("auto", p)).toBe("ioto");
  });
  it("explicit modes pass through regardless of detection", () => {
    const { plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    expect(resolveEffectiveMode("default", p)).toBe("default");
    expect(resolveEffectiveMode("ioto", p)).toBe("ioto");
  });
});

describe("defaultRootForMode", () => {
  it("default mode uses the plain content-area folder", async () => {
    const { p } = probe();
    expect(await defaultRootForMode("default", p)).toBe(DEFAULT_ROOT);
  });
  it("ioto mode reads extraFolder from ioto-settings", async () => {
    const { io, p } = probe();
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"9-Aux"}' });
    expect(await defaultRootForMode("ioto", p)).toBe("9-Aux/config-sync");
  });
  it("falls back when the file is missing, unreadable, or the key is empty", async () => {
    const { io, p } = probe();
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
    io.seed({ ".obs/plugins/ioto-settings/data.json": "not json" });
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"   "}' });
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
  });
});

describe("discoverStoreRoot", () => {
  it("returns the first candidate that has a store, else null", async () => {
    const has = async (root: string): Promise<boolean> => root === "0-Extra/config-sync";
    expect(await discoverStoreRoot(["config-sync", "0-Extra/config-sync"], has)).toBe("0-Extra/config-sync");
    expect(await discoverStoreRoot(["config-sync", "x/config-sync"], has)).toBeNull();
  });
});

describe("resolveRootPath", () => {
  it("a custom rootPath always wins (no discovery)", async () => {
    const { plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    expect(await resolveRootPath("my/own", "auto", p)).toBe("my/own");
  });
  it("empty rootPath follows the effective mode default when no store exists yet", async () => {
    const { io, plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"0-Extra"}' });
    expect(await resolveRootPath("", "auto", p)).toBe("0-Extra/config-sync");
    expect(await resolveRootPath("   ", "default", p)).toBe(DEFAULT_ROOT);
  });
  it("discovers the real store even when auto-detection points elsewhere (F3)", async () => {
    // auto → default (ioto-update not enabled) → would be config-sync, but the store is at 0-Extra
    const { io, p } = probe();
    io.seed({ "0-Extra/config-sync/store.lock.json": "{}" });
    expect(await resolveRootPath("", "auto", p)).toBe(IOTO_FALLBACK_ROOT);
  });
  it("prefers the mode default when a store sits there", async () => {
    const { io, p } = probe();
    io.seed({ "config-sync/store.lock.json": "{}", "0-Extra/config-sync/store.lock.json": "{}" });
    expect(await resolveRootPath("", "default", p)).toBe(DEFAULT_ROOT);
  });
});
