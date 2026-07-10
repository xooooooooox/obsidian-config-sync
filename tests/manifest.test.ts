import { describe, expect, it } from "vitest";
import {
  parseSyncManifest,
  parseStoreLock,
  validateSyncManifest,
  validateRemotes,
  ManifestValidationError,
} from "../src/core/manifest";

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
  it("rejects the plugin's own dir under both old and new ids", () => {
    const neu = { name: "self", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([neu]))).toThrow("blacklisted");
    const old = { name: "self-old", path: "{configDir}/plugins/obsidian-config-sync/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([old]))).toThrow("blacklisted");
  });
  it("accepts workspace-pattern paths (soft-blocked in the UI, not in validation)", () => {
    const g = { name: "ws", path: "{configDir}/workspace.json", type: "file", devices: "all" };
    const m = parseSyncManifest(manifestWith([g]));
    expect(m.groups[0]?.name).toBe("ws");
  });
  it("preserves origin: discovered on groups", () => {
    const raw = JSON.stringify({
      version: 1,
      groups: [{ name: "workspace-x", path: "{configDir}/workspace-x.json", type: "file", devices: "all", origin: "discovered" }],
    });
    const parsed = parseSyncManifest(raw);
    expect(parsed.groups[0]?.origin).toBe("discovered");
  });
  it("omits origin when absent and rejects invalid origin values", () => {
    const ok = JSON.stringify({
      version: 1,
      groups: [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all" }],
    });
    expect(parseSyncManifest(ok).groups[0]?.origin).toBeUndefined();
    const bad = JSON.stringify({
      version: 1,
      groups: [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all", origin: "picker" }],
    });
    expect(() => parseSyncManifest(bad)).toThrow('"origin" must be "discovered"');
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

describe("validateRemotes", () => {
  it("parses valid remotes of both types", () => {
    const remotes = validateRemotes([
      { name: "kickstart", type: "vault", storePath: "/abs/kickstart.vault/0-Extras/config-sync" },
      { name: "backup", type: "git", url: "git@example.com:me/cfg.git", branch: "main", subdir: "config-sync" },
    ]);
    expect(remotes).toHaveLength(2);
    expect(remotes[0]).toEqual({ name: "kickstart", type: "vault", storePath: "/abs/kickstart.vault/0-Extras/config-sync" });
    expect(remotes[1]?.type).toBe("git");
  });
  it("accepts tilde storePath and omits empty subdir", () => {
    const remotes = validateRemotes([
      { name: "a", type: "vault", storePath: "~/vaults/kick/0-Extras/config-sync" },
      { name: "b", type: "git", url: "u", branch: "main", subdir: "" },
    ]);
    expect(remotes[0]?.type).toBe("vault");
    expect(remotes[1]).toEqual({ name: "b", type: "git", url: "u", branch: "main" });
  });
  it("rejects a relative storePath", () => {
    expect(() => validateRemotes([{ name: "a", type: "vault", storePath: "vaults/kick" }])).toThrow('"storePath" must be an absolute path');
  });
  it("rejects subdir escaping the repo", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "m", subdir: "../x" }])).toThrow('"subdir"');
  });
  it("rejects unknown types and non-arrays", () => {
    expect(() => validateRemotes([{ name: "a", type: "local-path", storePath: "/x" }])).toThrow('"type" must be "vault" or "git"');
    expect(() => validateRemotes({})).toThrow("array");
  });
});

describe("validateSyncManifest", () => {
  it("accepts a plain object and ignores a $schema key", () => {
    const m = validateSyncManifest({ $schema: "https://example.invalid/s.json", version: 1, groups: [GOOD] });
    expect(m.groups).toHaveLength(1);
    expect(m.version).toBe(1);
  });
  it("rejects blacklisted paths on direct objects", () => {
    const g = { name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "file", devices: "all" };
    expect(() => validateSyncManifest({ version: 1, groups: [g] })).toThrow("blacklisted");
  });
  it("rejects duplicate names on direct objects", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [GOOD, { ...GOOD }] })).toThrow("duplicate group name");
  });
  it("carries a group description through validation", () => {
    const g = { ...GOOD, description: "Custom keyboard shortcuts" };
    const m = validateSyncManifest({ version: 1, groups: [g] });
    expect(m.groups[0]?.description).toBe("Custom keyboard shortcuts");
  });
  it("omits blank descriptions and rejects non-string ones", () => {
    const blank = validateSyncManifest({ version: 1, groups: [{ ...GOOD, description: "   " }] });
    expect(blank.groups[0]?.description).toBeUndefined();
    expect(() => validateSyncManifest({ version: 1, groups: [{ ...GOOD, description: 42 }] })).toThrow(
      '"description" must be a string'
    );
  });
});

describe("group name format", () => {
  it("accepts variable-style names (reserved and custom)", () => {
    for (const name of ["app", "community-plugins", "plugin-dataview", "my_rule", "graph"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(parseSyncManifest(manifestWith([g])).groups[0]?.name).toBe(name);
    }
  });

  it("rejects names with spaces, uppercase or illegal symbols", () => {
    for (const name of ["My Rule", "Graph", "a b", "weird!", "-leading"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(() => parseSyncManifest(manifestWith([g]))).toThrow("lowercase");
    }
  });
});
