import { describe, expect, it } from "vitest";
import { parseSyncManifest, parseStoreLock, parseExternalSources, ManifestValidationError } from "../src/core/manifest";

function manifestWith(groups: unknown[]): string {
  return JSON.stringify({ version: 1, groups });
}

const GOOD = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };

describe("parseSyncManifest", () => {
  it("parses a valid manifest", () => {
    const m = parseSyncManifest(manifestWith([GOOD]));
    expect(m.groups).toHaveLength(1);
    const g0 = m.groups[0];
    expect(g0).toBeDefined();
    if (g0) expect(g0.name).toBe("hotkeys");
  });
  it("rejects invalid JSON with a clear error", () => {
    expect(() => parseSyncManifest("{nope")).toThrow(ManifestValidationError);
  });
  it("rejects unsupported versions", () => {
    expect(() => parseSyncManifest(JSON.stringify({ version: 2, groups: [] }))).toThrow("unsupported version");
  });
  it("rejects duplicate group names", () => {
    expect(() => parseSyncManifest(manifestWith([GOOD, { ...GOOD, path: ".x" }]))).toThrow("duplicate group name");
  });
  it("rejects store path collisions", () => {
    const a = { name: "a", path: ".vimrc", type: "file", devices: "all" };
    const b = { name: "b", path: "vimrc", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([a, b]))).toThrow("collides");
  });
  it("rejects blacklisted plugin dirs", () => {
    const g = { name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("blacklisted");
  });
  it("rejects workspace files", () => {
    const g = { name: "ws", path: "{configDir}/workspace.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("blacklisted");
  });
  it("rejects sanitize on dir groups", () => {
    const g = { name: "s", path: "{configDir}/snippets", type: "dir", devices: "all", sanitize: ["*Token*"] };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("file groups");
  });
  it("rejects paths with .. or absolute paths", () => {
    const g = { name: "e", path: "../outside", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("vault-relative");
  });
  it("rejects groups that are ancestors of blacklisted dirs", () => {
    const plugins = { name: "all-plugins", path: "{configDir}/plugins", type: "dir", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([plugins]))).toThrow("sweep");
    const configdir = { name: "whole-configdir", path: "{configDir}", type: "dir", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([configdir]))).toThrow("sweep");
  });
});

describe("parseStoreLock", () => {
  it("parses a valid lock", () => {
    const lock = parseStoreLock(JSON.stringify({ publishedAt: "t", groups: { g: { sourcePluginVersion: "1.0.0" } } }));
    const g = lock.groups.g;
    expect(g).toBeDefined();
    if (g) expect(g.sourcePluginVersion).toBe("1.0.0");
  });
  it("rejects malformed locks", () => {
    expect(() => parseStoreLock(JSON.stringify({ groups: {} }))).toThrow(ManifestValidationError);
  });
});

describe("parseExternalSources", () => {
  it("parses valid sources of both types", () => {
    const raw = JSON.stringify([
      { name: "local", type: "local-path", path: "/v/main.vault", root: "0-Extra/config-sync" },
      { name: "git", type: "git", remote: "git@host:g/r.git", branch: "main", root: "0-Extra/config-sync" },
    ]);
    const sources = parseExternalSources(raw);
    expect(sources).toHaveLength(2);
    const s1 = sources[1];
    expect(s1).toBeDefined();
    if (s1) expect(s1.type).toBe("git");
  });
  it("rejects a git source without a branch", () => {
    const raw = JSON.stringify([{ name: "g", type: "git", remote: "u", root: "r" }]);
    expect(() => parseExternalSources(raw)).toThrow('"branch"');
  });
  it("rejects non-array input", () => {
    expect(() => parseExternalSources("{}")).toThrow("array");
  });
});
