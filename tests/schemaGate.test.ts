import { describe, expect, it } from "vitest";
import { classifySettings, CURRENT_SCHEMA, deviceOptOutsFor, drainEnabledOnLocal, isFutureSchemaDocument, mergeLegacyAppSliceItems, SCHEMA_FUTURE_APPLY_MESSAGE, SCHEMA_FUTURE_NOTICE, SCHEMA_UPGRADE_NOTICE, withDefaults, withDeviceOptOut } from "../src/core/settingsMigration";
import { emptyItemConfig, ItemConfig } from "../src/core/registry";

// spec 2026-07-25-unified-card-design.md §6, D13: blocking upgrade — no data migration, no
// compat window. A data.json without `schemaVersion: 2` (the old `groups`-based shape, or
// anything unversioned) is legacy and must be blocked with this exact Notice text.
//
// spec 2026-08-11-data-model-hardening.md §4.1 (invariant II.3) splits a fourth answer out of that
// same test: `isLegacySettings` was `schemaVersion !== 2`, so a document from a NEWER build took
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

  it("a NEWER schema is its own answer — never legacy, and it carries the version it found", () => {
    expect(classifySettings({ schemaVersion: 3, items: {} })).toEqual({ kind: "future", found: 3 });
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
    expect(isFutureSchemaDocument(JSON.stringify({ schemaVersion: 3, items: {} }))).toBe(true);
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
describe("deviceOptOutsFor / withDeviceOptOut", () => {
  it("reads only the groups whose array names this device", () => {
    expect(deviceOptOutsFor({ hotkeys: ["d1", "d2"], appearance: ["d2"], themes: [] }, "d1")).toEqual(["hotkeys"]);
  });

  it("anything that isn't the old shape reads as nothing", () => {
    expect(deviceOptOutsFor(undefined, "d1")).toEqual([]);
    expect(deviceOptOutsFor(null, "d1")).toEqual([]);
    expect(deviceOptOutsFor(["hotkeys"], "d1")).toEqual([]);
    expect(deviceOptOutsFor({ hotkeys: "d1" }, "d1")).toEqual([]);
  });

  it("adds and removes only this device's id, and prunes the group only when it empties", () => {
    expect(withDeviceOptOut({ hotkeys: ["d2"] }, "d1", "hotkeys", true)).toEqual({ hotkeys: ["d2", "d1"] });
    expect(withDeviceOptOut({ hotkeys: ["d2", "d1"] }, "d1", "hotkeys", false)).toEqual({ hotkeys: ["d2"] });
    expect(withDeviceOptOut({ hotkeys: ["d1"] }, "d1", "hotkeys", false)).toEqual({});
    expect(withDeviceOptOut(undefined, "d1", "hotkeys", true)).toEqual({ hotkeys: ["d1"] });
  });

  it("is idempotent in both directions", () => {
    expect(withDeviceOptOut({ hotkeys: ["d1"] }, "d1", "hotkeys", true)).toEqual({ hotkeys: ["d1"] });
    expect(withDeviceOptOut({ appearance: ["d2"] }, "d1", "hotkeys", false)).toEqual({ appearance: ["d2"] });
  });

  it("never mutates the map it was given, nor the arrays inside it", () => {
    const map = { hotkeys: ["d2"], appearance: ["d1"] };
    const snapshot = JSON.parse(JSON.stringify(map)) as typeof map;
    withDeviceOptOut(map, "d1", "hotkeys", true);
    withDeviceOptOut(map, "d1", "appearance", false);
    expect(map).toEqual(snapshot);
  });

  // Round-5 review M1. A group value that is not an array is a shape from a build we don't know:
  // spreading a string would explode it into characters and filtering a number would throw — and a
  // throw here lands AFTER localStorage was written, leaving the two stores disagreeing with no
  // notice and no re-render. Carry it, and never throw.
  it("leaves a group value that is not an array exactly as found, in both directions", () => {
    for (const junk of ["d1", 7, null, { d1: true }]) {
      expect(withDeviceOptOut({ hotkeys: junk }, "d1", "hotkeys", true)).toEqual({ hotkeys: junk });
      expect(withDeviceOptOut({ hotkeys: junk }, "d1", "hotkeys", false)).toEqual({ hotkeys: junk });
    }
  });

  it("a malformed group elsewhere never blocks this device's own entry", () => {
    expect(withDeviceOptOut({ appearance: "broken" }, "d1", "hotkeys", true)).toEqual({ appearance: "broken", hotkeys: ["d1"] });
  });

  it("carries non-string elements inside an array it does edit", () => {
    expect(withDeviceOptOut({ hotkeys: ["d2", 7] }, "d1", "hotkeys", true)).toEqual({ hotkeys: ["d2", 7, "d1"] });
    expect(withDeviceOptOut({ hotkeys: ["d2", 7, "d1"] }, "d1", "hotkeys", false)).toEqual({ hotkeys: ["d2", 7] });
  });

  it("a value that isn't a map at all never throws — it yields this device's entry alone", () => {
    expect(withDeviceOptOut("not a map", "d1", "hotkeys", true)).toEqual({ hotkeys: ["d1"] });
    expect(withDeviceOptOut(["hotkeys"], "d1", "hotkeys", false)).toEqual({});
    expect(withDeviceOptOut(null, "d1", "hotkeys", false)).toEqual({});
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

// spec 2026-07-26-ui-feedback-round2-design.md §2.3: a v2-internal shape revision, not the
// blocking gate above — the three app.json slice cards (editor/files-links/other) plus the
// top-level appJson mode merge into a single items.app, and appearance gives up the one app.json
// key it ever borrowed (showInlineTitle).
function cfg(overrides: Partial<ItemConfig> = {}): ItemConfig {
  return { ...emptyItemConfig(), ...overrides };
}

describe("mergeLegacyAppSliceItems", () => {
  it("merges legacy editor/files-links/other + appJson.mode into items.app, idempotently", () => {
    const s: { items: Record<string, ItemConfig>; appJson?: { mode: "plain" | "fields" } } = {
      items: {
        editor: cfg({ enabled: true, settingsFile: { mode: "plain", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} } }),
        "files-links": cfg({
          enabled: false,
          settingsFile: { mode: "plain", rules: { userIgnoreFilters: { scope: "desktop", encrypted: false } }, perItem: { userIgnoreFilters: { a: "all" } } },
        }),
        other: cfg({ enabled: false }),
        appearance: cfg({
          enabled: true,
          settingsFile: { mode: "plain", rules: { showInlineTitle: { scope: "all", encrypted: false }, cssTheme: { scope: "all", encrypted: false } }, perItem: {} },
        }),
      },
      appJson: { mode: "fields" },
    };

    expect(mergeLegacyAppSliceItems(s)).toBe(true);
    expect(s.items.app).toMatchObject({ enabled: true, settingsFile: { mode: "fields" } });
    expect(s.items.app!.settingsFile?.rules).toEqual({
      vimMode: { scope: "desktop", encrypted: false },
      userIgnoreFilters: { scope: "desktop", encrypted: false },
      showInlineTitle: { scope: "all", encrypted: false },
    });
    expect(s.items.app!.settingsFile?.perItem).toEqual({ userIgnoreFilters: { a: "all" } });
    expect(s.items.appearance!.settingsFile?.rules).toEqual({ cssTheme: { scope: "all", encrypted: false } });
    expect(s.items.editor).toBeUndefined();
    expect(s.appJson).toBeUndefined();
    expect(mergeLegacyAppSliceItems(s)).toBe(false); // idempotent
  });

  it("handles a partial legacy shape with only appJson present (no legacy item ids)", () => {
    const s: { items: Record<string, ItemConfig>; appJson?: { mode: "plain" | "fields" } } = {
      items: {},
      appJson: { mode: "plain" },
    };

    expect(mergeLegacyAppSliceItems(s)).toBe(true);
    expect(s.items.app).toEqual({ enabled: false, companions: [], settingsFile: { mode: "plain", rules: {}, perItem: {} } });
    expect(s.appJson).toBeUndefined();
    expect(mergeLegacyAppSliceItems(s)).toBe(false); // idempotent
  });

  it("handles a partial legacy shape with only some of the three item ids present", () => {
    const s: { items: Record<string, ItemConfig>; appJson?: { mode: "plain" | "fields" } } = {
      items: {
        editor: cfg({ enabled: true, settingsFile: { mode: "plain", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} } }),
      },
    };

    expect(mergeLegacyAppSliceItems(s)).toBe(true);
    expect(s.items.app).toEqual({
      enabled: true,
      companions: [], // §5.2 phase 1 keeps WRITING the empty array — only readers went tolerant
      settingsFile: { mode: "fields", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} },
    });
    expect(s.items.editor).toBeUndefined();
    expect(mergeLegacyAppSliceItems(s)).toBe(false); // idempotent
  });

  it("is a no-op when there is nothing legacy to merge", () => {
    const s: { items: Record<string, ItemConfig>; appJson?: { mode: "plain" | "fields" } } = {
      items: { app: cfg({ enabled: true, settingsFile: { mode: "fields", rules: {}, perItem: {} } }) },
    };

    expect(mergeLegacyAppSliceItems(s)).toBe(false);
  });
});

// Task 3 (spec 2026-08-04-per-device-scope-local-containment-design.md): a stored
// `enabledOn: "local"` is a pre-retarget artifact — Task 2 already makes enablementScopes ignore
// it, so this is drain-only cleanup that moves every such id into localMembers and deletes the key.
function drainSettings(items: Record<string, ItemConfig>, localMembers: string[]): { items: Record<string, ItemConfig>; localMembers: string[] } {
  return { items, localMembers };
}

describe("drainEnabledOnLocal", () => {
  it("moves each enabledOn 'local' into localMembers and deletes the key, idempotently", () => {
    const s = drainSettings(
      {
        "community:a": cfg({ enabled: true, enabledOn: "local" }),
        "community:b": cfg({ enabled: true, enabledOn: "desktop" }),
      },
      []
    );

    expect(drainEnabledOnLocal(s)).toBe(true);
    expect(s.localMembers).toEqual(["community:a"]);
    expect(s.items["community:a"]!.enabledOn).toBeUndefined();
    expect(s.items["community:b"]!.enabledOn).toBe("desktop");
    expect(drainEnabledOnLocal(s)).toBe(false); // idempotent
  });

  it("is a no-op (returns false) when nothing is enabledOn 'local'", () => {
    const s = drainSettings({ "community:a": cfg({ enabled: true }) }, ["community:a"]);

    expect(drainEnabledOnLocal(s)).toBe(false);
    expect(s.localMembers).toEqual(["community:a"]);
  });

  it("does not duplicate an id already in localMembers", () => {
    const s = drainSettings({ "community:a": cfg({ enabled: true, enabledOn: "local" }) }, ["community:a"]);

    expect(drainEnabledOnLocal(s)).toBe(true);
    expect(s.localMembers).toEqual(["community:a"]);
    expect(s.items["community:a"]!.enabledOn).toBeUndefined();
    expect(drainEnabledOnLocal(s)).toBe(false); // idempotent
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
