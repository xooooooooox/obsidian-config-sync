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
    expect(() => parseSyncManifest(JSON.stringify({ version: 2, groups: [] }))).toThrow('only supports "version": 1');
  });
  it("rejects duplicate group names", () => {
    expect(() => parseSyncManifest(manifestWith([GOOD, { ...GOOD, path: ".x" }]))).toThrow("two rules are named");
  });
  it("rejects store path collisions", () => {
    const a = { name: "a", path: ".vimrc", type: "file", devices: "all" };
    const b = { name: "b", path: "vimrc", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([a, b]))).toThrow("same store location");
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
    expect(() => parseSyncManifest(bad)).toThrow('only supported value is "discovered"');
  });
  it("rejects paths with .. or absolute paths", () => {
    const g = { name: "e", path: "../outside", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("must stay inside the vault");
  });
  it("accepts mode/fields, rejects legacy sanitize and bad modes", () => {
    const fields = { name: "f", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", action: "strip" }] };
    expect(parseSyncManifest(manifestWith([fields])).groups[0]).toEqual(fields);

    const encrypted = { name: "e2", path: "{configDir}/plugins/demo2/data.json", type: "file", devices: "all", mode: "encrypted" };
    expect(parseSyncManifest(manifestWith([encrypted])).groups[0]).toEqual(encrypted);

    const noMode = { name: "n", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    expect(parseSyncManifest(manifestWith([noMode])).groups[0]?.mode).toBeUndefined();

    const legacy = { name: "s", path: "{configDir}/hotkeys.json", type: "file", devices: "all", sanitize: ["*Token*"] };
    expect(() => parseSyncManifest(manifestWith([legacy]))).toThrow(
      '"s" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).'
    );

    const fieldsOnDir = { name: "d", path: "{configDir}/snippets", type: "dir", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", action: "strip" }] };
    expect(() => parseSyncManifest(manifestWith([fieldsOnDir]))).toThrow("only supported on file groups");

    const badMode = { name: "b", path: "{configDir}/hotkeys.json", type: "file", devices: "all", mode: "weird" };
    expect(() => parseSyncManifest(manifestWith([badMode]))).toThrow('but it must be "plain", "fields" or "encrypted"');

    const fieldsWithoutMode = { name: "fw", path: "{configDir}/hotkeys.json", type: "file", devices: "all", fields: [{ pattern: "*Token*", action: "strip" }] };
    expect(() => parseSyncManifest(manifestWith([fieldsWithoutMode]))).toThrow('sets "fields" but not "mode": "fields"');
  });
});

describe("parseStoreLock", () => {
  it("parses a valid lock", () => {
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { g: { sourcePluginVersion: "1.0.0" } } }));
    const g = lock.groups.g;
    expect(g).toBeDefined();
    if (g) expect(g.sourcePluginVersion).toBe("1.0.0");
  });
  it("rejects malformed locks", () => {
    expect(() => parseStoreLock(JSON.stringify({ groups: {} }))).toThrow(ManifestValidationError);
  });
  it("rejects the retired publishedAt key", () => {
    expect(() => parseStoreLock('{"publishedAt":"t","groups":{}}')).toThrow("capturedAt");
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
    expect(() => validateRemotes([{ name: "a", type: "vault", storePath: "vaults/kick" }])).toThrow(
      'The store path for "a" needs to be a full path starting with / or ~/ — for example ~/Vaults/other-vault/config-sync.'
    );
  });
  it("rejects subdir escaping the repo", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "m", subdir: "../x" }])).toThrow("must stay inside the repository");
  });
  it("rejects unknown types and non-arrays", () => {
    expect(() => validateRemotes([{ name: "a", type: "local-path", storePath: "/x" }])).toThrow('but it must be "vault" or "git"');
    expect(() => validateRemotes({})).toThrow("remotes must be a list");
  });
});

describe("validateSyncManifest", () => {
  it("accepts a plain object and ignores a $schema key", () => {
    const m = validateSyncManifest({ $schema: "https://example.invalid/s.json", version: 1, groups: [GOOD] });
    expect(m.groups).toHaveLength(1);
    expect(m.version).toBe(1);
  });
  it("rejects duplicate names on direct objects", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [GOOD, { ...GOOD }] })).toThrow("two rules are named");
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
      'has a "description" that isn\'t text'
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
