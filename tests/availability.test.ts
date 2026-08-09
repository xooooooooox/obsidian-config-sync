import { describe, expect, it } from "vitest";
import { availabilityForGroup, compareVersions, desktopOnlyDrift, desktopOnlyPluginIds, scopedAwayMembers, memberForceOff, snippetOrphans, normalizeMemberRule, preferStoredMemberRule } from "../src/core/availability";
import { FakePlugins } from "./memfs";
import { StoreLock, SyncGroup } from "../src/core/types";

const pluginGroup: SyncGroup = { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" };
const coreGroup: SyncGroup = { name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" };
const obsGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
const lock = (groups: StoreLock["groups"]): StoreLock => ({ capturedAt: "2026-01-01T00:00:00Z", groups });
const scopes = { "a-mobile": "mobile", "a-desktop": "desktop" } as const;

describe("compareVersions", () => {
  it("orders dotted numerics", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.8.7", "1.8.2")).toBe(1);
  });
});

describe("availabilityForGroup", () => {
  it("classifies community plugins: enabled / disabled / not-installed with drift", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    p.enabled.add("demo");
    const a = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.4.0" } }));
    expect(a).toEqual({ kind: "enabled", drift: "behind", localVersion: "2.2.1", storeVersion: "2.4.0", anchor: "plugin", desktopOnly: false });
    p.enabled.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, null).kind).toBe("disabled");
    p.installed.delete("demo");
    const ni = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.4.0" } }));
    expect(ni.kind).toBe("not-installed");
    expect(ni.drift).toBeNull();
  });
  it("reads desktopOnly from the manifest when installed, lock when not (plugin groups only)", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    p.desktopOnlyIds.add("demo"); // manifest says desktop-only
    // installed → manifest wins even when the lock lacks the flag
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1" } })).desktopOnly).toBe(true);
    // installed → manifest wins even over a stale lock flag
    p.desktopOnlyIds.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } })).desktopOnly).toBe(false);
    // not installed (the mobile case) → fall back to the lock
    p.installed.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } })).desktopOnly).toBe(true);
    // app-anchored → always false
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).desktopOnly).toBe(false);
  });
  it("anchors core and obsidian groups to the app version", () => {
    const p = new FakePlugins();
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    const core = availabilityForGroup(coreGroup, p, lock({ "daily-notes": { sourceAppVersion: "1.9.2" } }));
    expect(core).toEqual({ kind: "enabled", drift: "behind", localVersion: "1.8.7", storeVersion: "1.9.2", anchor: "app", desktopOnly: false });
    p.coreEnabled.delete("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).kind).toBe("disabled");
    const obs = availabilityForGroup(obsGroup, p, lock({ hotkeys: { sourceAppVersion: "1.8.7" } }));
    expect(obs).toEqual({ kind: "enabled", drift: null, localVersion: "1.8.7", storeVersion: "1.8.7", anchor: "app", desktopOnly: false });
  });
});

describe("desktopOnlyDrift", () => {
  const g = (name: string, path: string): SyncGroup => ({ name, path, type: "file", devices: "all" });
  it("counts only installed plugins whose lock flag disagrees with the manifest and that have an entry", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0");
    p.desktopOnlyIds.add("demo"); // manifest: desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    // entry exists, flag missing → drift
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(1);
    // entry already flagged → no drift
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0", desktopOnly: true } }))).toBe(0);
    // no lock entry → not counted (normal capture handles it; avoids a stuck nudge)
    expect(desktopOnlyDrift(groups, p, lock({}))).toBe(0);
    // not installed here → not counted
    p.installed.delete("demo");
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(0);
  });
  it("does not count a normal (non-desktop-only) installed plugin with no flag", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0"); // desktopOnlyIds empty → not desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(0);
  });
});

describe("desktopOnlyPluginIds", () => {
  const pg = (id: string): SyncGroup => ({ name: `plugin-${id}`, path: `{configDir}/plugins/${id}/data.json`, type: "file", devices: "all" });
  const appGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
  it("uses the section's signal: manifest when installed (lock flag not required), lock when not", () => {
    const p = new FakePlugins();
    p.installed.set("quick-explorer", "1.0.0");
    p.desktopOnlyIds.add("quick-explorer"); // installed + manifest desktop-only, NO lock flag — the 1.1.6 bug case
    p.installed.set("dataview", "0.5.0"); // installed, not desktop-only
    const groups = [pg("quick-explorer"), pg("dataview"), appGroup];
    const ids = desktopOnlyPluginIds(groups, p, lock({ "plugin-quick-explorer": { sourcePluginVersion: "1.0.0" }, "plugin-dataview": { sourcePluginVersion: "0.5.0" } }));
    expect([...ids].sort()).toEqual(["quick-explorer"]);
  });
  it("falls back to the lock flag when not installed, and collects nothing without a signal", () => {
    const p = new FakePlugins(); // nothing installed
    const groups = [pg("media-extended")];
    expect([...desktopOnlyPluginIds(groups, p, lock({ "plugin-media-extended": { sourcePluginVersion: "1.0.0", desktopOnly: true } }))]).toEqual(["media-extended"]);
    expect(desktopOnlyPluginIds(groups, p, lock({ "plugin-media-extended": { sourcePluginVersion: "1.0.0" } })).size).toBe(0);
  });
  // The 2026-07-27 mobile find: a flagged plugin NOT installed on this device compiles no local
  // group, so a groups-only scan never reached its lock flag — the switch-list element it still
  // owns in the store went unmasked ("simpread" reappeared in every mobile diff).
  it("masks a lock-flagged plugin even when no local group compiles for it (not installed here)", () => {
    const p = new FakePlugins(); // nothing installed
    const ids = desktopOnlyPluginIds([], p, lock({ "plugin-simpread": { sourcePluginVersion: "3.0.0", desktopOnly: true } }));
    expect([...ids]).toEqual(["simpread"]);
  });

  it("manifest wins for an installed plugin: a stale lock flag alone never masks it", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0"); // manifest says NOT desktop-only
    expect(desktopOnlyPluginIds([], p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0", desktopOnly: true } })).size).toBe(0);
  });

  it("ignores app-anchored groups and empty input", () => {
    const p = new FakePlugins();
    expect(desktopOnlyPluginIds([appGroup], p, null).size).toBe(0);
    expect(desktopOnlyPluginIds([], p, null).size).toBe(0);
  });
});

describe("scopedAwayMembers", () => {
  it("on desktop, names mobile-scoped members", () => {
    expect(scopedAwayMembers(scopes, false)).toEqual(new Set(["a-mobile"]));
  });
  it("on mobile, names desktop-scoped members", () => {
    expect(scopedAwayMembers(scopes, true)).toEqual(new Set(["a-desktop"]));
  });
  it("empty scopes → empty set", () => {
    expect(scopedAwayMembers({}, false)).toEqual(new Set());
  });
});

describe("memberForceOff (localIds > scope)", () => {
  it("force-offs scope-away members on desktop", () => {
    expect(memberForceOff(scopes, [], false)).toEqual(["a-mobile"]);
  });
  it("a local scope-away member is NOT force-offed", () => {
    expect(memberForceOff(scopes, ["a-mobile"], false)).toEqual([]);
  });
});

describe("scopedAwayMembers / memberForceOff", () => {
  it("returns members whose scope excludes this device class", () => {
    const scopes: Record<string, "desktop" | "mobile"> = { a: "desktop", b: "mobile" };
    expect(scopedAwayMembers(scopes, false)).toEqual(new Set(["b"]));
    expect(scopedAwayMembers(scopes, true)).toEqual(new Set(["a"]));
  });
  it("local ids win over a travelling scope — never forced off", () => {
    expect(memberForceOff({ a: "mobile", b: "mobile" }, ["b"], false)).toEqual(["a"]);
  });
});

describe("normalizeMemberRule", () => {
  it("passes all/desktop/mobile through unchanged", () => {
    expect(normalizeMemberRule("all", true)).toBe("all");
    expect(normalizeMemberRule("all", false)).toBe("all");
    expect(normalizeMemberRule("desktop", true)).toBe("desktop");
    expect(normalizeMemberRule("mobile", false)).toBe("mobile");
  });
  it("maps 'local' to always-here when currently on locally", () => {
    expect(normalizeMemberRule("local", true)).toBe("always-here");
  });
  it("maps 'local' to never-here when currently off locally", () => {
    expect(normalizeMemberRule("local", false)).toBe("never-here");
  });
});

describe("preferStoredMemberRule (task-2 fix #2: a stored rule wins over local-state re-derivation)", () => {
  it("a stored rule wins outright, regardless of the persisted on/off state", () => {
    expect(preferStoredMemberRule("always-here", false)).toBe("always-here");
    expect(preferStoredMemberRule("never-here", true)).toBe("never-here");
  });
  it("falls back to normalizeMemberRule('local', ...) when nothing is stored", () => {
    expect(preferStoredMemberRule(undefined, true)).toBe("always-here");
    expect(preferStoredMemberRule(undefined, false)).toBe("never-here");
  });
});

describe("snippetOrphans", () => {
  it("flags names enabled locally with no file anywhere", () => {
    expect(snippetOrphans(["callouts", "mystyle"], [], ["mystyle"], [])).toEqual(["callouts"]);
  });

  it("flags names enabled only in the store with no file anywhere", () => {
    expect(snippetOrphans([], ["dead"], [], [])).toEqual(["dead"]);
  });

  it("keeps names whose file exists locally", () => {
    expect(snippetOrphans(["mystyle"], ["mystyle"], ["mystyle"], [])).toEqual([]);
  });

  it("keeps names whose file exists in the store (fresh device before snippets sync)", () => {
    expect(snippetOrphans([], ["pending"], [], ["pending"])).toEqual([]);
  });

  it("dedupes and sorts", () => {
    expect(snippetOrphans(["b", "a"], ["b", "c"], [], [])).toEqual(["a", "b", "c"]);
  });
});
