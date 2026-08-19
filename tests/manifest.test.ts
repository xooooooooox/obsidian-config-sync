import { describe, expect, it } from "vitest";
import { EVERYWHERE, parseItemRef, StoreLock, SyncGroup, THIS_DEVICE, perClass } from "../src/core/types";
import {
  parseSyncManifest,
  parseStoreLock,
  validateSyncManifest,
  validateRemotes,
  ManifestValidationError,
  derivedLockCapturedAt,
  lockEntry,
  lockEntryList,
  lockSourceVersion,
  storeLockVersion,
  lockEntryTail,
  lockLineage,
  lockTail,
  lockWatermark,
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
    expect(() => parseSyncManifest(manifestWith([GOOD, { ...GOOD, path: ".x" }]))).toThrow("Two rules are named");
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
    expect(() => parseSyncManifest(bad)).toThrow('"origin" only supports "discovered"');
  });
  it("rejects paths with .. or absolute paths", () => {
    const g = { name: "e", path: "../outside", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("must stay inside the vault");
  });
  it("accepts mode/fields, rejects legacy sanitize and bad modes", () => {
    // A rule with no compiler behind it gains the ref legacyRef gives its name — the
    // same producer the v1/v2 lock read uses, which is what makes a hand-written rule able to hold a
    // baseline instead of reading as never-synced.
    const fields = { name: "f", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }] };
    expect(parseSyncManifest(manifestWith([fields])).groups[0]).toEqual({ ...fields, ref: "legacy/f" });

    const encrypted = { name: "e2", path: "{configDir}/plugins/demo2/data.json", type: "file", devices: "all", mode: "encrypted" };
    expect(parseSyncManifest(manifestWith([encrypted])).groups[0]).toEqual({ ...encrypted, ref: "legacy/e2" });

    const noMode = { name: "n", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    expect(parseSyncManifest(manifestWith([noMode])).groups[0]?.mode).toBeUndefined();

    const legacy = { name: "s", path: "{configDir}/hotkeys.json", type: "file", devices: "all", sanitize: ["*Token*"] };
    expect(() => parseSyncManifest(manifestWith([legacy]))).toThrow(
      '"s" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see the sensitive-settings guide in docs/GUIDE.md).'
    );

    const fieldsOnDir = { name: "d", path: "{configDir}/snippets", type: "folder", devices: "all", mode: "fields", fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }] };
    expect(() => parseSyncManifest(manifestWith([fieldsOnDir]))).toThrow("per-key rules only apply to a single file");

    const badMode = { name: "b", path: "{configDir}/hotkeys.json", type: "file", devices: "all", mode: "weird" };
    expect(() => parseSyncManifest(manifestWith([badMode]))).toThrow('the mode must be "plain", "fields" or "encrypted"');

    const fieldsWithoutMode = { name: "fw", path: "{configDir}/hotkeys.json", type: "file", devices: "all", fields: [{ pattern: "*Token*", sharing: THIS_DEVICE, encrypted: false }] };
    expect(() => parseSyncManifest(manifestWith([fieldsWithoutMode]))).toThrow('has a "fields" list but not "mode": "fields"');
  });
});

// Orthogonal {scope, encrypted} matrix coverage (all 7 legal combos, local+encrypted rejection,
// unknown scope) lives in tests/ruleMatrix.test.ts — this block keeps the pre-existing
// old-action-equivalent acceptance/rejection smoke tests, mechanically remapped.
describe("field rule scope/encrypted", () => {
  it("accepts the five scope/encrypted combinations equivalent to the old actions", () => {
    const fields = [
      { pattern: "a", sharing: THIS_DEVICE, encrypted: false }, // old "strip"
      { pattern: "b", sharing: EVERYWHERE, encrypted: true }, // old "encrypt"
      { pattern: "c", sharing: perClass("desktop"), encrypted: false }, // old "desktop"
      { pattern: "d", sharing: perClass("mobile"), encrypted: false }, // old "mobile"
      { pattern: "e", sharing: EVERYWHERE, encrypted: false }, // old inert "all"
    ];
    const g = { ...GOOD, mode: "fields", fields };
    expect(parseSyncManifest(manifestWith([g])).groups[0]?.fields).toEqual(fields);
  });
  it("rejects an unknown scope", () => {
    const g = { ...GOOD, mode: "fields", fields: [{ pattern: "a", scope: "tablet", encrypted: false }] };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow('the "fields" list is invalid');
  });
});

describe("parseStoreLock", () => {
  it("parses a v3 lock", () => {
    const lock = parseStoreLock(JSON.stringify({ version: 3, capturedAt: "t", items: { community: { demo: { source: { kind: "plugin", version: "1.0.0" } } } } }));
    expect(lockEntry(lock, "community/demo")).toEqual({ source: { kind: "plugin", version: "1.0.0" } });
    expect(lockSourceVersion(lockEntry(lock, "community/demo"), "plugin")).toBe("1.0.0");
    expect(lockSourceVersion(lockEntry(lock, "community/demo"), "app")).toBeNull(); // the kind is the question, not the field name
  });
  it("rejects malformed locks", () => {
    expect(() => parseStoreLock(JSON.stringify({ items: {} }))).toThrow(ManifestValidationError);
  });
  it("rejects the retired publishedAt key", () => {
    expect(() => parseStoreLock('{"publishedAt":"t","items":{}}')).toThrow("capturedAt");
  });
});

// spec/a v1/v2 lock is READ and converted in memory. During the transition window every
// device still on 2.21.0 is writing one, so this is the normal path, not an edge case. The group
// name → ref conversion asks the compiled sync list first (itemKeys.ts's lockRefFor) and falls back
// to the closed legacy rules; a name nothing claims lands in `legacy/`, preserved and unresolvable.
describe("parseStoreLock — v1/v2 → v3 conversion", () => {
  const V2 = {
    version: 2,
    capturedAt: "2026-08-11T00:00:00.000Z",
    syncedWatermark: "2026-08-10T00:00:00.000Z",
    fleetNotes: { any: ["shape", 1, null] }, // an unknown TOP-LEVEL key
    groups: {
      "plugin-dataview": { sourcePluginVersion: "0.5.0", desktopOnly: true, label: "Dataview", hash: "sha256:abc", perMemberFreshness: { x: 1 } },
      hotkeys: { sourceAppVersion: "1.8.7" },
      "daily-notes": { sourceAppVersion: "1.8.7" },
      "community-plugins": { sourceAppVersion: "1.8.7", memberLabels: { dataview: "Dataview" } },
      "who-knows": { sourceAppVersion: "1.8.7" },
    },
  };

  it("re-keys every entry and lands the partitions, carrying unknown keys at BOTH levels", () => {
    const lock = parseStoreLock(JSON.stringify(V2));
    expect(lock["fleetNotes"]).toEqual({ any: ["shape", 1, null] }); // top level
    expect(lockEntry(lock, "community/dataview")).toEqual({
      source: { kind: "plugin", version: "0.5.0" },
      innate: { desktopOnly: true },
      display: { label: "Dataview" },
      hash: "sha256:abc",
      perMemberFreshness: { x: 1 }, // entry level
    });
    expect(lockEntry(lock, "obsidian/hotkeys")).toEqual({ source: { kind: "app", version: "1.8.7" } });
    expect(lockEntry(lock, "core/daily-notes")).toEqual({ source: { kind: "app", version: "1.8.7" } });
    // a carrier IS an item, under the closed obsidian id space; its element names are display
    expect(lockEntry(lock, "obsidian/community-plugins")).toEqual({
      source: { kind: "app", version: "1.8.7" },
      display: { elements: { dataview: "Dataview" } },
    });
    // the v2 vocabulary does not survive alongside the v3 one — one reading, not two
    expect(lock["groups"]).toBeUndefined();
  });

  it("keeps an entry no item claims, under a section no reader can resolve", () => {
    const lock = parseStoreLock(JSON.stringify(V2));
    expect(lockEntry(lock, "legacy/who-knows")).toEqual({ source: { kind: "app", version: "1.8.7" } });
    expect(parseItemRef("legacy/who-knows")).toBeNull(); // unresolvable by construction: inert, never dropped
  });

  it("asks the compiled sync list before the legacy rules — the compiler is the single producer", () => {
    const compiled: SyncGroup[] = [
      { name: "who-knows", ref: "custom/who-knows", path: "notes/x.json", type: "file", devices: "all" },
      { name: "themes", ref: "obsidian/appearance/themes", path: "{configDir}/themes", type: "folder", devices: "all" },
    ];
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { "who-knows": { sourceAppVersion: "1.8.7" }, themes: { sourceAppVersion: "1.8.7" } } }), compiled);
    expect(lockEntry(lock, "custom/who-knows")).toBeDefined();
    expect(lockEntry(lock, "obsidian/appearance/themes")).toBeDefined(); // a companion, keyed under its owner
    expect(lockEntry(lock, "legacy/who-knows")).toBeUndefined();
  });

  // `items` is REBUILT by the parse, so a section it cannot read cannot ride the
  // top-level tail — it is kept in place and narrowed where it is consumed instead (invariant
  // II.1 + II.2 together).
  it("carries a section bucket this build cannot read, and ignores it at the point of use", () => {
    const raw = JSON.stringify({ version: 4, capturedAt: "t", items: { community: { a: { source: { kind: "plugin", version: "1.0" } } }, weird: "not a map" } });
    const lock = parseStoreLock(raw);
    expect(lock.items["weird"]).toBe("not a map"); // preserved, byte for byte on the way back out
    expect((JSON.parse(JSON.stringify(lock)) as StoreLock).items).toEqual({ community: { a: { source: { kind: "plugin", version: "1.0" } } }, weird: "not a map" });
    expect(lockEntryList(lock.items).map(([ref]) => ref)).toEqual(["community/a"]); // …and never read as entries
    expect(lockEntry(lock, "weird/x")).toBeUndefined();
  });

  it("a v1 lock (no version, no watermark) converts the same way", () => {
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { "plugin-dataview": { sourcePluginVersion: "0.5.0" } } }));
    expect(storeLockVersion(lock)).toBe(1); // read, never invented
    expect(lockEntry(lock, "community/dataview")).toEqual({ source: { kind: "plugin", version: "0.5.0" } });
  });
});

// A `ref` is a KEY, and the key space's sections are closed. `beta` is a presented
// classification and never an identity — a validator that accepted any two segments would
// let a `beta/<id>` identity leak back in through a store manifest.
describe("parseGroup — the ref is validated against the key space", () => {
  const withRef = (ref: unknown): string =>
    JSON.stringify({ version: 1, groups: [{ name: "x", ref, path: "{configDir}/x.json", type: "file", devices: "all" }] });

  it("accepts every section a key may name, including a companion's and the legacy holding pen", () => {
    for (const ref of ["obsidian/app", "core/daily-notes", "community/dataview", "custom/my-rule", "obsidian/appearance/themes", "legacy/who-knows"]) {
      expect(parseSyncManifest(withRef(ref)).groups[0]?.ref).toBe(ref);
    }
  });

  it("rejects a section that is not one — `beta` above all", () => {
    for (const ref of ["beta/dataview", "nope/x", "community/", "/dataview", "dataview", 42]) {
      expect(() => parseSyncManifest(withRef(ref))).toThrow('the "ref" isn\'t an item reference');
    }
  });

  it("rejects two rules sharing one ref, the way it rejects two sharing one name", () => {
    const two = JSON.stringify({
      version: 1,
      groups: [
        { name: "a", ref: "custom/same", path: "{configDir}/a.json", type: "file", devices: "all" },
        { name: "b", ref: "custom/same", path: "{configDir}/b.json", type: "file", devices: "all" },
      ],
    });
    // Both rules are named, not just the one that happened to be second — a message that says
    // "and another" leaves the user to find the other half themselves.
    expect(() => parseSyncManifest(two)).toThrow('Rules "b" and "a" both sync the item "custom/same"');
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
      'Remote "a": the store path needs to be a full path starting with / or ~/, for example ~/Vaults/other-vault/config-sync'
    );
  });
  it("rejects subdir escaping the repo", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "m", subdir: "../x" }])).toThrow("must stay inside the repository");
  });
  it("rejects unknown types and non-arrays", () => {
    expect(() => validateRemotes([{ name: "a", type: "local-path", storePath: "/x" }])).toThrow('the type must be "vault" or "git"');
    expect(() => validateRemotes({})).toThrow("Remotes must be a list");
  });

  it("accepts excludeSelf: true on both types; false/absent serialize as absent", () => {
    const remotes = validateRemotes([
      { name: "a", type: "vault", storePath: "/s", excludeSelf: true },
      { name: "b", type: "vault", storePath: "/s", excludeSelf: false },
      { name: "c", type: "git", url: "git@h:r.git", branch: "main", excludeSelf: true },
    ]);
    expect(remotes[0]).toEqual({ name: "a", type: "vault", storePath: "/s", excludeSelf: true });
    expect(remotes[1]).toEqual({ name: "b", type: "vault", storePath: "/s" });
    expect(remotes[2]).toEqual({ name: "c", type: "git", url: "git@h:r.git", branch: "main", excludeSelf: true });
  });

  it("rejects a non-boolean excludeSelf", () => {
    expect(() => validateRemotes([{ name: "a", type: "vault", storePath: "/s", excludeSelf: "yes" }])).toThrow("must be true or false");
  });

  it("round-trips tokenId on git remotes", () => {
    const remotes = validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "gitlab-token" }]);
    expect(remotes[0]).toEqual({ name: "b", type: "git", url: "u", branch: "main", tokenId: "gitlab-token" });
  });

  it("round-trips an explicit username and omits it when absent", () => {
    const remotes = validateRemotes([
      { name: "b", type: "git", url: "u", branch: "main", tokenId: "gitlab-token", username: "xozoz" },
      { name: "c", type: "git", url: "u", branch: "main", tokenId: "gitlab-token" },
    ]);
    expect(remotes[0]).toEqual({ name: "b", type: "git", url: "u", branch: "main", tokenId: "gitlab-token", username: "xozoz" });
    expect(remotes[1]).toEqual({ name: "c", type: "git", url: "u", branch: "main", tokenId: "gitlab-token" });
  });

  it("rejects a username carrying whitespace that could forge credential-protocol lines", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", username: "me\npassword=x" }])).toThrow(
      "single word without spaces"
    );
  });

  it("rejects a malformed tokenId", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "Bad_Id!" }])).toThrow(
      "lowercase letters, digits and dashes"
    );
  });

  it("rejects a tokenId longer than 64 characters", () => {
    expect(() =>
      validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "a".repeat(65) }])
    ).toThrow("lowercase letters, digits and dashes");
  });

  it("rejects the vault passphrase's secret id as a tokenId", () => {
    expect(() =>
      validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "config-sync-passphrase" }])
    ).toThrow("Config Sync's own vault passphrase");
  });
});

describe("validateSyncManifest", () => {
  it("accepts a plain object and ignores a $schema key", () => {
    const m = validateSyncManifest({ $schema: "https://example.invalid/s.json", version: 1, groups: [GOOD] });
    expect(m.groups).toHaveLength(1);
    expect(m.version).toBe(1);
  });
  it("rejects duplicate names on direct objects", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [GOOD, { ...GOOD }] })).toThrow("Two rules are named");
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
      "the description must be plain text"
    );
  });
  it("round-trips a boolean locked flag on field rules and rejects a non-boolean one", () => {
    const withLocked = { ...GOOD, mode: "fields", fields: [{ pattern: "rootPath", sharing: THIS_DEVICE, encrypted: false, locked: true }] };
    expect(validateSyncManifest({ version: 1, groups: [withLocked] }).groups[0]?.fields?.[0]?.locked).toBe(true);
    const badLocked = { ...GOOD, mode: "fields", fields: [{ pattern: "rootPath", sharing: THIS_DEVICE, encrypted: false, locked: "yes" }] };
    expect(() => validateSyncManifest({ version: 1, groups: [badLocked] })).toThrow('the "fields" list is invalid');
  });
});

describe("group name format", () => {
  it("accepts variable-style names (reserved and custom)", () => {
    for (const name of ["app", "community-plugins", "plugin-dataview", "my_rule", "graph"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(parseSyncManifest(manifestWith([g])).groups[0]?.name).toBe(name);
    }
  });

  it("rejects names with spaces, illegal symbols, or leading punctuation", () => {
    for (const name of ["a b", "weird!", "-leading"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(() => parseSyncManifest(manifestWith([g]))).toThrow("names use only letters");
    }
  });
});

describe("parseStoreLock widened schema", () => {
  it("accepts sourceAppVersion entries", () => {
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "2026-01-01T00:00:00Z", groups: { hotkeys: { sourceAppVersion: "1.8.7" } } }));
    expect(lock.items["obsidian"]?.["hotkeys"]).toEqual({ source: { kind: "app", version: "1.8.7" } });
  });
  it("rejects entries with neither version key", () => {
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "x", groups: { a: {} } }))).toThrow(
      'store.lock.json item "legacy/a" must have a "source" of {"kind": "plugin"|"app", "version": string}'
    );
  });
  it("carries desktopOnly through the parse; omits it when absent or false", () => {
    const lock = parseStoreLock(
      JSON.stringify({
        capturedAt: "2026-01-01T00:00:00Z",
        groups: {
          a: { sourcePluginVersion: "1.0.0", desktopOnly: true },
          b: { sourcePluginVersion: "2.0.0", desktopOnly: false },
          c: { sourcePluginVersion: "3.0.0" },
        },
      })
    );
    expect(lock.items["legacy"]?.["a"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, innate: { desktopOnly: true } });
    expect(lock.items["legacy"]?.["b"]).toEqual({ source: { kind: "plugin", version: "2.0.0" } });
    expect(lock.items["legacy"]?.["c"]).toEqual({ source: { kind: "plugin", version: "3.0.0" } });
  });

  it("round-trips a group label; omits it when absent or blank", () => {
    const lock = parseStoreLock(
      JSON.stringify({
        capturedAt: "2026-01-01T00:00:00Z",
        groups: {
          a: { sourcePluginVersion: "1.0.0", label: "BRAT" },
          b: { sourcePluginVersion: "2.0.0", label: "   " },
          c: { sourcePluginVersion: "3.0.0" },
        },
      })
    );
    expect(lock.items["legacy"]?.["a"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "BRAT" } });
    expect(lock.items["legacy"]?.["b"]).toEqual({ source: { kind: "plugin", version: "2.0.0" } });
    expect(lock.items["legacy"]?.["c"]).toEqual({ source: { kind: "plugin", version: "3.0.0" } });
  });

  it("rejects a non-string label", () => {
    expect(() =>
      parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: { sourcePluginVersion: "1.0.0", label: 42 } } }))
    ).toThrow('store.lock.json item "legacy/a" has a "label" that isn\'t text');
  });
});

// The two
// carrier entries additionally carry memberLabels (id → display name) — validated/preserved the
// same way the single-label field above is, and fully back-compatible in both directions.
describe("parseStoreLock memberLabels", () => {
  it("round-trips a carrier's memberLabels; drops blank/empty-string values", () => {
    const lock = parseStoreLock(
      JSON.stringify({
        capturedAt: "t",
        groups: {
          "community-plugins": { sourceAppVersion: "1.8.7", memberLabels: { dataview: "Dataview", blank: "   ", ghost: "" } },
        },
      })
    );
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" }, display: { elements: { dataview: "Dataview" } } });
  });

  it("omits memberLabels entirely when the map normalizes to empty", () => {
    const lock = parseStoreLock(
      JSON.stringify({ capturedAt: "t", groups: { "community-plugins": { sourceAppVersion: "1.8.7", memberLabels: { blank: "   " } } } })
    );
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" } });
  });

  it("a legacy lock with no memberLabels field at all still parses (back-compat)", () => {
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { "community-plugins": { sourceAppVersion: "1.8.7" } } }));
    expect(lock.items["obsidian"]?.["community-plugins"]).toEqual({ source: { kind: "app", version: "1.8.7" } });
  });

  it("rejects a non-object memberLabels", () => {
    expect(() =>
      parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: { sourcePluginVersion: "1.0.0", memberLabels: "nope" } } }))
    ).toThrow('store.lock.json item "legacy/a" has an "elements" that isn\'t a map of id to text');
  });

  it("rejects a memberLabels entry whose value isn't a string", () => {
    expect(() =>
      parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: { sourcePluginVersion: "1.0.0", memberLabels: { x: 42 } } } }))
    ).toThrow('store.lock.json item "legacy/a" has an "elements" that isn\'t a map of id to text');
  });
});

// spec 2026-08-11-data-model-hardening.md (invariant II.1): the parse validates the fields it
// knows and CARRIES everything else. The whitelist rebuild this replaced was not a local loss — the
// pull path writes the parsed lock back, so an older device stripped a newer device's fields and
// pushed the loss on to the fleet, which is why the lock format could never evolve.
describe("parseStoreLock carries unknown keys (unknown ⇒ preserve)", () => {
  const RAW = {
    capturedAt: "2026-08-11T00:00:00.000Z",
    version: 3, // a top-level field a newer build writes
    fleetNotes: { any: ["shape", 1, null] },
    items: {
      community: {
        dataview: {
          source: { kind: "plugin", version: "0.5.0" },
          display: { label: "Dataview" },
          hash: "sha256:abc", // an entry field a newer build writes
          perMemberFreshness: { dataview: "2026-08-11T00:00:00.000Z" },
        },
      },
    },
  };

  it("round-trips unknown top-level and unknown entry keys through parse → JSON.stringify", () => {
    const lock = parseStoreLock(JSON.stringify(RAW));
    expect(lock["version"]).toBe(3);
    expect(lock["fleetNotes"]).toEqual({ any: ["shape", 1, null] });
    const entry = lock.items["community"]?.["dataview"];
    expect(entry?.["hash"]).toBe("sha256:abc");
    expect(entry?.["perMemberFreshness"]).toEqual({ dataview: "2026-08-11T00:00:00.000Z" });
    // and the whole document survives serialization, not just the in-memory object.
    expect(JSON.parse(JSON.stringify(lock))).toEqual(RAW);
  });

  it("still normalizes the fields it knows around the carried ones", () => {
    const lock = parseStoreLock(
      JSON.stringify({
        capturedAt: "t",
        groups: { a: { sourcePluginVersion: "1.0.0", sourceAppVersion: 7, desktopOnly: false, label: "  ", memberLabels: { x: " " }, keepMe: 1 } },
      })
    );
    // a non-string version, desktopOnly:false, a blank label and an all-blank memberLabels map are
    // dropped exactly as the whitelist rebuild dropped them — carrying must not smuggle them back.
    expect(lock.items["legacy"]?.["a"]).toEqual({ source: { kind: "plugin", version: "1.0.0" }, keepMe: 1 });
  });

  // The known fields come back in a FIXED order however the document happened to write them, and
  // the carried tail lands AFTER that block — so two devices re-emitting the same entry produce the
  // same bytes and the lock file stops churning the vault's history on every parse-and-write.
  //
  // The shuffle covers the tail as well as the known block, which is what the claim is about.
  it("emits the known fields in a fixed order, with the carried tail after them", () => {
    const shuffled = parseStoreLock(
      JSON.stringify({ capturedAt: "t", items: { legacy: { a: { zTail: 1, display: { label: "Demo" }, aTail: 2, innate: { desktopOnly: true }, source: { kind: "plugin", version: "1.0.0" } } } } })
    );
    const canonical = parseStoreLock(
      JSON.stringify({ capturedAt: "t", items: { legacy: { a: { source: { kind: "plugin", version: "1.0.0" }, innate: { desktopOnly: true }, display: { label: "Demo" }, zTail: 1, aTail: 2 } } } })
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical));
    // …and the block really is known-then-tail, not merely "the same either way".
    expect(Object.keys(shuffled.items["legacy"]?.["a"] ?? {})).toEqual(["source", "innate", "display", "zTail", "aTail"]);
  });

  it("rejects exactly what it rejected before, with the same messages", () => {
    const SOURCE_REQUIRED = 'store.lock.json item "legacy/a" must have a "source" of {"kind": "plugin"|"app", "version": string}';
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: { fromTheFuture: true } } }))).toThrow(SOURCE_REQUIRED);
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: 5 } }))).toThrow(SOURCE_REQUIRED);
    // the same rejection reaches a v3 document written directly, not only a converted one
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "t", items: { legacy: { a: { source: { kind: "tablet", version: "1" } } } } }))).toThrow(SOURCE_REQUIRED);
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "t", groups: { a: { sourceAppVersion: "1.8.7", label: 42, keepMe: 1 } } }))).toThrow(
      'store.lock.json item "legacy/a" has a "label" that isn\'t text'
    );
    expect(() => parseStoreLock(JSON.stringify({ items: {} }))).toThrow("store.lock.json must be {capturedAt: string, items: object}");
  });
});

// spec 2026-08-11-data-model-hardening.md: the v2 payload's readers. All four narrow the raw
// value rather than trusting the declared type, because the fields arrive through the carried tail
// and are never validated on the way in.
describe("store.lock v2 field readers", () => {
  it("lockWatermark falls back to capturedAt for a v1 lock, which is the comparison v1 already made", () => {
    expect(lockWatermark({ capturedAt: "2026-08-01T00:00:00.000Z", items: {} })).toBe("2026-08-01T00:00:00.000Z");
    expect(lockWatermark({ capturedAt: "2026-08-01T00:00:00.000Z", syncedWatermark: "2026-08-09T00:00:00.000Z", items: {} })).toBe(
      "2026-08-09T00:00:00.000Z"
    );
    // A malformed watermark is not evidence of anything — the v1 reading stands, and the value
    // still rides through untouched. Built by parsing, because that is the only way such a document
    // reaches a reader: the field is never validated on the way in.
    const malformed = parseStoreLock(JSON.stringify({ capturedAt: "2026-08-01T00:00:00.000Z", syncedWatermark: 7, items: {} }));
    expect(lockWatermark(malformed)).toBe("2026-08-01T00:00:00.000Z");
    expect(malformed["syncedWatermark"]).toBe(7);
  });

  it("lockLineage is never older than the lock's own capturedAt", () => {
    // The scale locks from both builds are compared on. A v2 lock's watermark stops moving on
    // capture; a v1 lock's single stamp does not. Taking the LATER of the two is what keeps a device
    // that captured locally from reading as behind an older device that merely pulled from it.
    expect(lockLineage({ syncedWatermark: "2026-08-01T00:00:00.000Z", capturedAt: "2026-08-09T00:00:00.000Z", items: {} })).toBe(
      "2026-08-09T00:00:00.000Z"
    );
    expect(lockLineage({ syncedWatermark: "2026-08-09T00:00:00.000Z", capturedAt: "2026-08-01T00:00:00.000Z", items: {} })).toBe(
      "2026-08-09T00:00:00.000Z"
    );
    // a v1 lock has only the one stamp, which is exactly what it always compared by
    expect(lockLineage({ capturedAt: "2026-08-01T00:00:00.000Z", items: {} })).toBe("2026-08-01T00:00:00.000Z");
    // an undatable value never displaces a real one, in either slot
    expect(lockLineage(parseStoreLock(JSON.stringify({ capturedAt: "T", syncedWatermark: "2026-08-01T00:00:00.000Z", items: {} })))).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(lockLineage({ capturedAt: "T", items: {} })).toBe("T");
  });

  it("derivedLockCapturedAt takes the newest item stamp, never falls below a floor, and never returns nothing", () => {
    // The stamp is derived across the whole nested map, not one section of it.
    const items = {
      obsidian: {
        a: { source: { kind: "app" as const, version: "1.8.7" }, capturedAt: "2026-08-02T00:00:00.000Z" },
        b: { source: { kind: "app" as const, version: "1.8.7" }, capturedAt: "2026-08-05T00:00:00.000Z" },
      },
      community: { c: { source: { kind: "app" as const, version: "1.8.7" } } }, // no stamp of its own, and that is not a difference
    };
    expect(derivedLockCapturedAt(items, [], "now")).toBe("2026-08-05T00:00:00.000Z");
    expect(derivedLockCapturedAt(items, ["2026-08-09T00:00:00.000Z"], "now")).toBe("2026-08-09T00:00:00.000Z"); // floor wins
    expect(derivedLockCapturedAt(items, ["2026-08-01T00:00:00.000Z"], "now")).toBe("2026-08-05T00:00:00.000Z"); // older floor does not
    expect(derivedLockCapturedAt({ obsidian: { a: { source: { kind: "app" as const, version: "1.8.7" } } } }, ["not-a-date"], "now")).toBe("now"); // nothing datable
  });

  it("the tail helpers strip exactly the fields this build writes for itself", () => {
    expect(
      lockEntryTail({ source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo" }, innate: { desktopOnly: true }, capturedAt: "t", hash: "abc", fromTheFuture: { deep: [1] } })
    ).toEqual({ fromTheFuture: { deep: [1] } });
    expect(lockEntryTail(undefined)).toEqual({});
    expect(lockTail({ version: 3, syncedWatermark: "w", capturedAt: "c", items: {}, fleetNotes: 1 })).toEqual({ fleetNotes: 1 });
    expect(lockTail(null)).toEqual({});
  });
});

describe("group name validation allows uppercase", () => {
  const mk = (name: string) => JSON.stringify({ version: 1, groups: [{ name, path: "{configDir}/x.json", type: "file", devices: "all" }] });
  it("accepts a mixed-case plugin id", () => {
    expect(() => parseSyncManifest(mk("plugin-DEVONlink-obsidian"))).not.toThrow();
  });
  it("still rejects a leading punctuation name with the reworded message", () => {
    expect(() => parseSyncManifest(mk("-bad"))).toThrow(
      'Rule "-bad": names use only letters, digits, "-" or "_", starting with a letter or digit — e.g. my-plugin'
    );
  });
});

describe("group label field", () => {
  it("round-trips a label through parse", () => {
    const raw = JSON.stringify({ version: 1, groups: [{ name: "plugin-x", label: "Xtension", path: "{configDir}/plugins/x/data.json", type: "file", devices: "all" }] });
    expect(parseSyncManifest(raw).groups[0]?.label).toBe("Xtension");
  });
  it("ignores an empty/whitespace label", () => {
    const raw = JSON.stringify({ version: 1, groups: [{ name: "plugin-x", label: "  ", path: "{configDir}/plugins/x/data.json", type: "file", devices: "all" }] });
    expect(parseSyncManifest(raw).groups[0]?.label).toBeUndefined();
  });
});
