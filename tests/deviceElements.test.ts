import { describe, expect, it } from "vitest";
import { deviceElementIds, deviceElementState, DEVICE_ELEMENTS_KEY, parseDeviceElements, withDeviceElement } from "../src/core/deviceElements";

describe("parseDeviceElements", () => {
  it("reads the two-level table", () => {
    const raw = JSON.stringify({ "community-plugins": { "obsidian-kanban": "on", "some-plugin": "off" }, "core-plugins": { "daily-notes": "off" } });
    expect(parseDeviceElements(raw)).toEqual({
      "community-plugins": { "obsidian-kanban": "on", "some-plugin": "off" },
      "core-plugins": { "daily-notes": "off" },
    });
  });

  it.each([null, undefined, "", "not json", "[]", '"a string"', "42", JSON.stringify({ "core-plugins": ["daily-notes"] })])(
    "reads %s as no exceptions at all — a device that cannot read its own table must still sync",
    (raw) => {
      expect(parseDeviceElements(raw)).toEqual({});
    }
  );

  it("drops only the unreadable entries, keeping the readable ones beside them", () => {
    const raw = JSON.stringify({ "core-plugins": { "daily-notes": "off", graph: "maybe", canvas: 1 } });
    expect(parseDeviceElements(raw)).toEqual({ "core-plugins": { "daily-notes": "off" } });
  });

  it("names its localStorage key once", () => {
    expect(DEVICE_ELEMENTS_KEY).toBe("config-sync-device-elements");
  });
});

describe("withDeviceElement", () => {
  it("sets, flips and clears — and a clear that empties a list drops the list", () => {
    const on = withDeviceElement({}, "core-plugins", "daily-notes", "on");
    expect(deviceElementState(on, "core-plugins", "daily-notes")).toBe("on");
    const off = withDeviceElement(on, "core-plugins", "daily-notes", "off");
    expect(deviceElementState(off, "core-plugins", "daily-notes")).toBe("off");
    expect(withDeviceElement(off, "core-plugins", "daily-notes", null)).toEqual({});
  });

  it("never mutates its input", () => {
    const before = withDeviceElement({}, "core-plugins", "daily-notes", "on");
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown;
    withDeviceElement(before, "core-plugins", "graph", "off");
    expect(before).toEqual(snapshot);
  });

  it("answers null for an element with no exception, and lists the ids that have one", () => {
    const t = withDeviceElement(withDeviceElement({}, "core-plugins", "graph", "off"), "core-plugins", "daily-notes", "on");
    expect(deviceElementState(t, "core-plugins", "canvas")).toBeNull();
    expect(deviceElementState(t, "community-plugins", "graph")).toBeNull();
    expect(deviceElementIds(t, "core-plugins").sort()).toEqual(["daily-notes", "graph"]);
    expect(deviceElementIds(t, "community-plugins")).toEqual([]);
  });
});
