import { describe, expect, it } from "vitest";
import { availabilityForGroup, compareVersions, desktopOnlyDrift, desktopOnlyPluginIds, snippetOrphans } from "../src/core/availability";
import { FakePlugins } from "./memfs";
import { StoreLock, StoreLockEntry, SyncGroup } from "../src/core/types";
import { lockByName, withRef } from "./lock";

const pluginGroup: SyncGroup = withRef({ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" });
const coreGroup: SyncGroup = withRef({ name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" });
const obsGroup: SyncGroup = withRef({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" });
const lock = (byName: Record<string, StoreLockEntry>): StoreLock => lockByName("2026-01-01T00:00:00Z", byName);

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
    const a = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "2.4.0" } } }));
    expect(a).toEqual({ kind: "enabled", drift: "behind", localVersion: "2.2.1", storeVersion: "2.4.0", anchor: "plugin", desktopOnly: false });
    p.enabled.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, null).kind).toBe("disabled");
    p.installed.delete("demo");
    const ni = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "2.4.0" } } }));
    expect(ni.kind).toBe("not-installed");
    expect(ni.drift).toBeNull();
  });
  it("reads desktopOnly from the manifest when installed, lock when not (plugin groups only)", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    p.desktopOnlyIds.add("demo"); // manifest says desktop-only
    // installed → manifest wins even when the lock lacks the flag
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "2.2.1" } } })).desktopOnly).toBe(true);
    // installed → manifest wins even over a stale lock flag
    p.desktopOnlyIds.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "2.2.1" }, innate: { desktopOnly: true } } })).desktopOnly).toBe(false);
    // not installed (the mobile case) → fall back to the lock
    p.installed.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "2.2.1" }, innate: { desktopOnly: true } } })).desktopOnly).toBe(true);
    // app-anchored → always false
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).desktopOnly).toBe(false);
  });
  it("anchors core and obsidian groups to the app version", () => {
    const p = new FakePlugins();
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    const core = availabilityForGroup(coreGroup, p, lock({ "daily-notes": { source: { kind: "app", version: "1.9.2" } } }));
    expect(core).toEqual({ kind: "enabled", drift: "behind", localVersion: "1.8.7", storeVersion: "1.9.2", anchor: "app", desktopOnly: false });
    p.coreEnabled.delete("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).kind).toBe("disabled");
    const obs = availabilityForGroup(obsGroup, p, lock({ hotkeys: { source: { kind: "app", version: "1.8.7" } } }));
    expect(obs).toEqual({ kind: "enabled", drift: null, localVersion: "1.8.7", storeVersion: "1.8.7", anchor: "app", desktopOnly: false });
  });
});

describe("desktopOnlyDrift", () => {
  const g = (name: string, path: string): SyncGroup => withRef({ name, path, type: "file", devices: "all" });
  it("lists only installed plugins whose lock flag disagrees with the manifest and that have an entry", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0");
    p.installedNames.set("demo", "Demo Plugin");
    p.desktopOnlyIds.add("demo"); // manifest: desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    // entry exists, flag missing → drift, with the row's display fields
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" } } }))).toEqual([
      { id: "demo", label: "Demo Plugin", version: "1.0.0", willBeDesktopOnly: true },
    ]);
    // no manifest name → the lock's display label, then the id
    p.installedNames.delete("demo");
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" }, display: { label: "Demo (stored)" } } }))[0]?.label).toBe("Demo (stored)");
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" } } }))[0]?.label).toBe("demo");
    // entry already flagged → no drift
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" }, innate: { desktopOnly: true } } }))).toEqual([]);
    // no lock entry → not listed (normal capture handles it; avoids a stuck nudge)
    expect(desktopOnlyDrift(groups, p, lock({}))).toEqual([]);
    // not installed here → not listed
    p.installed.delete("demo");
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" } } }))).toEqual([]);
  });
  it("does not count a plugin whose installed version differs from the entry's (version drift owns it)", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "0.4.20");
    p.desktopOnlyIds.add("demo"); // this version's manifest is desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    // the entry records another device's 0.5.2 capture, where the flag is legitimately absent —
    // nudging here would ping-pong the flag across a mid-upgrade fleet
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "0.5.2" } } }))).toEqual([]);
  });
  it("does not list a normal (non-desktop-only) installed plugin with no flag", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0"); // desktopOnlyIds empty → not desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" } } }))).toEqual([]);
  });
});

describe("desktopOnlyPluginIds", () => {
  const pg = (id: string): SyncGroup => withRef({ name: `plugin-${id}`, path: `{configDir}/plugins/${id}/data.json`, type: "file", devices: "all" });
  const appGroup: SyncGroup = withRef({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" });
  it("uses the section's signal: manifest when installed (lock flag not required), lock when not", () => {
    const p = new FakePlugins();
    p.installed.set("quick-explorer", "1.0.0");
    p.desktopOnlyIds.add("quick-explorer"); // installed + manifest desktop-only, NO lock flag — the 1.1.6 bug case
    p.installed.set("dataview", "0.5.0"); // installed, not desktop-only
    const groups = [pg("quick-explorer"), pg("dataview"), appGroup];
    const ids = desktopOnlyPluginIds(groups, p, lock({ "plugin-quick-explorer": { source: { kind: "plugin", version: "1.0.0" } }, "plugin-dataview": { source: { kind: "plugin", version: "0.5.0" } } }));
    expect([...ids].sort()).toEqual(["quick-explorer"]);
  });
  it("falls back to the lock flag when not installed, and collects nothing without a signal", () => {
    const p = new FakePlugins(); // nothing installed
    const groups = [pg("media-extended")];
    expect([...desktopOnlyPluginIds(groups, p, lock({ "plugin-media-extended": { source: { kind: "plugin", version: "1.0.0" }, innate: { desktopOnly: true } } }))]).toEqual(["media-extended"]);
    expect(desktopOnlyPluginIds(groups, p, lock({ "plugin-media-extended": { source: { kind: "plugin", version: "1.0.0" } } })).size).toBe(0);
  });
  // The 2026-07-27 mobile find: a flagged plugin NOT installed on this device compiles no local
  // group, so a groups-only scan never reached its lock flag — the switch-list element it still
  // owns in the store went unmasked ("simpread" reappeared in every mobile diff).
  it("masks a lock-flagged plugin even when no local group compiles for it (not installed here)", () => {
    const p = new FakePlugins(); // nothing installed
    const ids = desktopOnlyPluginIds([], p, lock({ "plugin-simpread": { source: { kind: "plugin", version: "3.0.0" }, innate: { desktopOnly: true } } }));
    expect([...ids]).toEqual(["simpread"]);
  });

  it("manifest wins for an installed plugin: a stale lock flag alone never masks it", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0"); // manifest says NOT desktop-only
    expect(desktopOnlyPluginIds([], p, lock({ "plugin-demo": { source: { kind: "plugin", version: "1.0.0" }, innate: { desktopOnly: true } } })).size).toBe(0);
  });

  it("ignores app-anchored groups and empty input", () => {
    const p = new FakePlugins();
    expect(desktopOnlyPluginIds([appGroup], p, null).size).toBe(0);
    expect(desktopOnlyPluginIds([], p, null).size).toBe(0);
  });
});

// There is no membersExcludedByClass / memberForceOff / forcedRunsOn / preferStoredRunsOn
// (2026-08-12-enablement-two-layers-design.md): the mask and the two force
// sets are ONE decision per element (enablementDecision.ts, tests/enablementDecision.test.ts),
// and the runtime projection off it is covered end to end by tests/enablementRuntime.test.ts.

// There is no asRunsOn (retired with `runsOn` itself) — that runtime
// narrowing applies to Sharing (asSharing/asFileSharing, types.ts), which is
// what every rule reaches a reader through.

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
