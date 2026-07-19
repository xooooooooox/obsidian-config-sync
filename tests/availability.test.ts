import { describe, expect, it } from "vitest";
import { availabilityForGroup, compareVersions } from "../src/core/availability";
import { FakePlugins } from "./memfs";
import { StoreLock, SyncGroup } from "../src/core/types";

const pluginGroup: SyncGroup = { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" };
const coreGroup: SyncGroup = { name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" };
const obsGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
const lock = (groups: StoreLock["groups"]): StoreLock => ({ capturedAt: "2026-01-01T00:00:00Z", groups });

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
  it("carries desktopOnly from the lock (plugin groups only)", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    const on = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } }));
    expect(on.desktopOnly).toBe(true);
    const off = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1" } }));
    expect(off.desktopOnly).toBe(false);
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).desktopOnly).toBe(false); // app-anchored
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
