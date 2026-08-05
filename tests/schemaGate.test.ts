import { describe, expect, it } from "vitest";
import { drainEnabledOnLocal, isLegacySettings, mergeLegacyAppSliceItems, sanitizeMemberRules, SCHEMA_UPGRADE_NOTICE } from "../src/core/settingsMigration";
import type { MemberRule } from "../src/core/types";
import { emptyItemConfig, ItemConfig } from "../src/core/registry";

// spec 2026-07-25-unified-card-design.md §6, D13: blocking upgrade — no data migration, no
// compat window. A data.json without `schemaVersion: 2` (the old `groups`-based shape, or
// anything unversioned) is legacy and must be blocked with this exact Notice text.

describe("isLegacySettings", () => {
  it("a fresh install (no data.json yet) is not legacy", () => {
    expect(isLegacySettings(null)).toBe(false);
  });

  it("v2 settings load through unchanged", () => {
    expect(isLegacySettings({ schemaVersion: 2, items: {}, appJson: { mode: "fields" } })).toBe(false);
  });

  it("the old groups-based v1 shape is blocked", () => {
    expect(isLegacySettings({ groups: [], memberScopes: {}, memberLocal: {} })).toBe(true);
  });

  it("any non-2 schemaVersion is blocked", () => {
    expect(isLegacySettings({ schemaVersion: 1 })).toBe(true);
    expect(isLegacySettings({})).toBe(true);
  });
});

describe("SCHEMA_UPGRADE_NOTICE", () => {
  it("is the character-exact Notice copy", () => {
    expect(SCHEMA_UPGRADE_NOTICE).toBe("Config Sync: this update reset your sync setup — open Settings to choose what to sync again.");
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
      companions: [],
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

describe("sanitizeMemberRules (task 2, single-source against MEMBER_RULES)", () => {
  it("keeps every valid MemberRule value untouched", () => {
    const s = { memberRules: { "community:a": "always-here", "core:b": "desktop" } as Record<string, MemberRule> };
    expect(sanitizeMemberRules(s)).toBe(false);
    expect(s.memberRules).toEqual({ "community:a": "always-here", "core:b": "desktop" });
  });

  it("drops an entry whose value isn't a real MemberRule (malformed/foreign data.json)", () => {
    const s = { memberRules: { "community:a": "local", "community:b": "always-here" } as unknown as Record<string, MemberRule> };
    expect(sanitizeMemberRules(s)).toBe(true);
    expect(s.memberRules).toEqual({ "community:b": "always-here" });
    expect(sanitizeMemberRules(s)).toBe(false); // idempotent
  });
});
