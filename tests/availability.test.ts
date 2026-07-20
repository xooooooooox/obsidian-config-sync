import { describe, expect, it } from "vitest";
import { availabilityForGroup, compareVersions, desktopOnlyDrift, desktopOnlyPluginIds, scopedAwaySnippets, snippetForceOff } from "../src/core/availability";
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
  it("ignores app-anchored groups and empty input", () => {
    const p = new FakePlugins();
    expect(desktopOnlyPluginIds([appGroup], p, null).size).toBe(0);
    expect(desktopOnlyPluginIds([], p, null).size).toBe(0);
  });
});

describe("scopedAwaySnippets", () => {
  it("on desktop, names mobile-scoped snippets", () => {
    expect(scopedAwaySnippets(scopes, false)).toEqual(new Set(["a-mobile"]));
  });
  it("on mobile, names desktop-scoped snippets", () => {
    expect(scopedAwaySnippets(scopes, true)).toEqual(new Set(["a-desktop"]));
  });
  it("empty scopes → empty set", () => {
    expect(scopedAwaySnippets({}, false)).toEqual(new Set());
  });
});

describe("snippetForceOff (pin > scope)", () => {
  it("force-offs scope-away snippets on desktop", () => {
    expect(snippetForceOff(scopes, [], false)).toEqual(["a-mobile"]);
  });
  it("a pinned scope-away snippet is NOT force-offed", () => {
    expect(snippetForceOff(scopes, ["a-mobile"], false)).toEqual([]);
  });
});
