import { describe, expect, it } from "vitest";
import { pluginRuntimeEnabled, PluginEnabledView } from "../src/core/pluginState";

const view = (enabled: string[], loaded: string[]): PluginEnabledView => ({
  enabledPlugins: new Set(enabled),
  plugins: Object.fromEntries(loaded.map((id) => [id, {}])),
});

describe("pluginRuntimeEnabled", () => {
  it("is true when the plugin is loaded but NOT in the persisted set (the IOTO Tasks Center case)", () => {
    // A non-persistent enablePlugin() loads without adding to enabledPlugins.
    expect(pluginRuntimeEnabled(view([], ["ioto-tasks-center"]), "ioto-tasks-center")).toBe(true);
  });
  it("is true when persisted-enabled but not currently loaded (intended on / failed load)", () => {
    expect(pluginRuntimeEnabled(view(["dataview"], []), "dataview")).toBe(true);
  });
  it("is true when both loaded and persisted", () => {
    expect(pluginRuntimeEnabled(view(["calendar"], ["calendar"]), "calendar")).toBe(true);
  });
  it("is false when neither loaded nor persisted", () => {
    expect(pluginRuntimeEnabled(view(["a"], ["b"]), "off-plugin")).toBe(false);
  });
});
