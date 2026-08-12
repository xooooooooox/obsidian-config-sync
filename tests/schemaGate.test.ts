import { describe, expect, it } from "vitest";
import { classifySettings, CURRENT_SCHEMA, isFutureSchemaDocument, MIGRATABLE_SCHEMA, SCHEMA_FUTURE_APPLY_MESSAGE, SCHEMA_FUTURE_NOTICE, SCHEMA_UPGRADE_NOTICE, withDefaults } from "../src/core/settingsMigration";
import { emptyItemMap } from "../src/core/registry";

// A data.json older than `schemaVersion: 3` and not migratable (v1, unversioned) is classified
// legacy and blocked with this exact Notice text. A v2 document takes the migration branch instead
// — see tests/v2Migration.test.ts.
//
// spec 2026-08-11-data-model-hardening.md §4.1 (invariant II.3) splits a fourth answer out of the
// same test: `isLegacySettings` was `schemaVersion !== CURRENT`, so a document from a NEWER build took
// the legacy path — notice, defaults in memory, the user's whole setup overwritten at the next
// save. Since data.json travels between a user's devices wholesale, that made a staged upgrade
// able to wipe a device that hadn't updated yet.

describe("classifySettings", () => {
  it("a fresh install (no data.json yet) is neither legacy nor a stop", () => {
    expect(classifySettings(null)).toEqual({ kind: "fresh" });
  });

  it("this build's own schema loads through unchanged", () => {
    expect(classifySettings({ schemaVersion: CURRENT_SCHEMA, items: {}, appJson: { mode: "fields" } })).toEqual({ kind: "ok" });
  });

  it("the old groups-based v1 shape is legacy", () => {
    expect(classifySettings({ groups: [], memberScopes: {}, memberLocal: {} })).toEqual({ kind: "legacy" });
  });

  it("an older or unversioned schema is legacy", () => {
    expect(classifySettings({ schemaVersion: 1 })).toEqual({ kind: "legacy" });
    expect(classifySettings({})).toEqual({ kind: "legacy" });
  });

  // v2 is the one version with a way forward (spec 2026-08-11-v3-one-vocabulary-design.md §5/§6):
  // it is neither reset nor refused, it is migrated. v1 has no field a v3 shape could be
  // reconstructed from and keeps the reset branch above.
  it("a v2 document is migrated, not reset", () => {
    expect(classifySettings({ schemaVersion: MIGRATABLE_SCHEMA })).toEqual({ kind: "migrate" });
    expect(MIGRATABLE_SCHEMA).toBe(CURRENT_SCHEMA - 1);
  });

  it("a NEWER schema is its own answer — never legacy, and it carries the version it found", () => {
    expect(classifySettings({ schemaVersion: 4, items: {} })).toEqual({ kind: "future", found: 4 });
    expect(classifySettings({ schemaVersion: 99 })).toEqual({ kind: "future", found: 99 });
  });

  // A schemaVersion that isn't a number is not evidence of a newer build (a hand edit, a truncated
  // write), so it keeps today's verdict exactly rather than stopping the plugin dead.
  it("a non-numeric schemaVersion stays legacy", () => {
    expect(classifySettings({ schemaVersion: "3" })).toEqual({ kind: "legacy" });
    expect(classifySettings({ schemaVersion: null })).toEqual({ kind: "legacy" });
  });
});

// §4.2's half of the same gate: the document about to be written onto this device, still as text.
describe("isFutureSchemaDocument", () => {
  it("is true only for a document declaring a schema newer than this build's", () => {
    expect(isFutureSchemaDocument(JSON.stringify({ schemaVersion: 4, items: {} }))).toBe(true);
    expect(isFutureSchemaDocument(JSON.stringify({ schemaVersion: CURRENT_SCHEMA, items: {} }))).toBe(false);
    expect(isFutureSchemaDocument(JSON.stringify({ schemaVersion: 1 }))).toBe(false);
  });

  it("text that isn't a JSON object is not a newer document", () => {
    expect(isFutureSchemaDocument("{ truncated")).toBe(false);
    expect(isFutureSchemaDocument("[]")).toBe(false);
    expect(isFutureSchemaDocument('"3"')).toBe(false);
  });
});

// spec 2026-08-11-data-model-hardening.md §5.1 (S8): the shallow Object.assign this replaced
// filled only the top level, so a field added inside runHistory/ribbonButtons was `undefined` on
// any older document. Invariant II.1 binds it in the other direction: nothing the document carries
// may be lost, known or not.
describe("withDefaults", () => {
  const defaults = {
    schemaVersion: 2,
    rootPath: "",
    remotes: [] as string[],
    ribbonButtons: { sync: false },
    runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
    items: {} as Record<string, unknown>,
  };

  it("no document at all is the defaults", () => {
    expect(withDefaults(defaults, null)).toEqual(defaults);
  });

  it("backfills a MISSING nested field while keeping the stored ones", () => {
    const loaded = withDefaults(defaults, { schemaVersion: 2, runHistory: { enabled: false, maxCount: 5 } });
    expect(loaded.runHistory).toEqual({ enabled: false, path: "", maxCount: 5, maxDays: 30 });
  });

  it("carries unknown keys through untouched, top-level and nested", () => {
    const loaded = withDefaults(defaults, {
      schemaVersion: 2,
      fromAFutureVersion: { deep: [1, 2] },
      runHistory: { enabled: false, alsoFromTheFuture: "keep me" },
    }) as typeof defaults & { fromAFutureVersion: unknown; runHistory: { alsoFromTheFuture: string } };
    expect(loaded.fromAFutureVersion).toEqual({ deep: [1, 2] });
    expect(loaded.runHistory.alsoFromTheFuture).toBe("keep me");
    expect(loaded.runHistory.maxDays).toBe(30); // and the default still filled in around it
  });

  it("a stored value always wins over the default, including an emptied array or map", () => {
    const loaded = withDefaults(defaults, { schemaVersion: 2, rootPath: "vault/cs", remotes: [], items: { hotkeys: { enabled: true } } });
    expect(loaded.rootPath).toBe("vault/cs");
    expect(loaded.items).toEqual({ hotkeys: { enabled: true } });
  });

  it("never mutates the defaults it was given", () => {
    withDefaults(defaults, { schemaVersion: 2, runHistory: { maxDays: 1 } });
    expect(defaults.runHistory.maxDays).toBe(30);
  });

  it("hands out its OWN nested object even when the document had none — the settings tab edits it in place", () => {
    const loaded = withDefaults(defaults, { schemaVersion: 2 });
    expect(loaded.runHistory).not.toBe(defaults.runHistory);
    loaded.runHistory.enabled = false;
    expect(defaults.runHistory.enabled).toBe(true);
  });

  it("a nested value stored as a non-object is left exactly as found — this is a fill, not a validator", () => {
    const loaded = withDefaults(defaults, { schemaVersion: 2, runHistory: "broken" }) as unknown as { runHistory: unknown };
    expect(loaded.runHistory).toBe("broken");
  });
});

// spec 2026-08-11-data-model-hardening.md §2 ruling: the pre-C-#52 map is CARRIED. These two are
// the whole contract in pure form — read this device's groups out of it, and write this device's
// id into it without ever disturbing another device's entry.
// `items` is a NESTED default (fix round 1): a document that never had a section must come back
// with it, and the map must never be handed out as DEFAULT_SETTINGS' own object — every section is
// written through registry.ts's withItem/withoutItem, and a shared mutable default is a bug
// waiting for its first in-place write.
describe("withDefaults — the item map", () => {
  const defaults = { schemaVersion: 3, items: emptyItemMap(), rootPath: "" };

  it("fills a section the document never had", () => {
    const out = withDefaults(defaults, { items: { community: { dataview: { enabled: true } } } });
    expect(Object.keys(out.items).sort()).toEqual(["community", "core", "custom", "obsidian"]);
    expect(out.items.community).toEqual({ dataview: { enabled: true } });
    expect(out.items.custom).toEqual({});
  });

  it("never shares the default's own map, at either level", () => {
    const out = withDefaults(defaults, null);
    expect(out.items).not.toBe(defaults.items);
    expect(out.items.custom).not.toBe(defaults.items.custom);
    // ...and a second load is independent of the first.
    const other = withDefaults(defaults, null);
    other.items.custom["my-rule"] = { enabled: true };
    expect(out.items.custom).toEqual({});
    expect(defaults.items.custom).toEqual({});
  });

  it("carries a section only a NEWER build knows about", () => {
    const out = withDefaults(defaults, { items: { somethingNew: { x: { enabled: true } } } });
    expect((out.items as Record<string, unknown>).somethingNew).toEqual({ x: { enabled: true } });
  });
});

describe("SCHEMA_UPGRADE_NOTICE", () => {
  it("is the character-exact Notice copy", () => {
    expect(SCHEMA_UPGRADE_NOTICE).toBe("Config Sync: this update reset your sync setup — open Settings to choose what to sync again.");
  });
});

// §4.1/§4.2 final copy. Pinned character-exact for the same reason as the notice above: these are
// the sentences the spec approved, and the UI vocabulary rule (`this device` / `your other
// devices` / `the store`) lives in them.
describe("the version-gate copy", () => {
  it("§4.1 — what the Sync Center's banner and every refused write say", () => {
    expect(SCHEMA_FUTURE_NOTICE).toBe("These settings were written by a newer Config Sync. Update Config Sync on this device to open them. Nothing has been changed.");
  });

  it("§4.2 — what the self item fails with when the store's document is newer", () => {
    expect(SCHEMA_FUTURE_APPLY_MESSAGE).toBe("The store's Config Sync settings were written by a newer version. Update Config Sync on this device before applying them.");
  });
});

// sanitizeMemberRules is gone (spec 2026-08-11-data-model-hardening.md §3.2, invariant II.2). It
// dropped every memberRules value this build didn't recognise and saved immediately — so a rule
// written by a NEWER build became a deletion this device published to the whole fleet on its next
// capture. The contract it used to carry now lives in two places, and is tested there:
// storage is untouched by a load (tests/mainReloadSettings.test.ts, driving the real load path),
// and an unrecognised value is ignored where it is consumed (tests/availability.test.ts's
// asMemberRule/preferStoredMemberRule, plus memberRuleFor/memberRulesFor in mainReloadSettings).

// C-#45 fix-round 1 (reviewer-caught CRITICAL): the per-device item opt-out rule's device
// identity moved OUT of settings entirely, into localStorage (main.ts's deviceId() method,
// tested via tests/deviceOptOut.test.ts's real-plugin harness) — there is no settings-level
// migration for it any more; settingsMigration.ts has nothing to own here.
