import { describe, expect, it } from "vitest";
import {
  DEVICE_FIELDS_KEY,
  deviceFieldPatterns,
  fieldExceptionsByGroupName,
  parseDeviceFields,
  withDeviceField,
} from "../src/core/deviceFields";
import type { SyncGroup } from "../src/core/types";

describe("parseDeviceFields", () => {
  it("reads a well-formed table", () => {
    const raw = JSON.stringify({ "core/graph": { colorGroups: "not-synced" } });
    expect(parseDeviceFields(raw)).toEqual({ "core/graph": { colorGroups: "not-synced" } });
  });

  it("unreadable shapes read as no exceptions, never throw", () => {
    for (const raw of [undefined, null, 42, "not json", "[]", JSON.stringify([1, 2])]) {
      expect(parseDeviceFields(raw)).toEqual({});
    }
  });

  it("drops entries whose value is not a known state, keeps the rest", () => {
    const raw = JSON.stringify({ "core/graph": { colorGroups: "not-synced", other: "bogus" } });
    expect(parseDeviceFields(raw)).toEqual({ "core/graph": { colorGroups: "not-synced" } });
  });

  it("drops an item whose whole map is empty after filtering", () => {
    expect(parseDeviceFields(JSON.stringify({ "core/graph": { a: "bogus" } }))).toEqual({});
  });
});

describe("withDeviceField", () => {
  it("adds and removes without mutating the input", () => {
    const before = {};
    const set = withDeviceField(before, "core/graph", "colorGroups", true);
    expect(before).toEqual({});
    expect(set).toEqual({ "core/graph": { colorGroups: "not-synced" } });
    expect(withDeviceField(set, "core/graph", "colorGroups", false)).toEqual({});
  });
});

describe("fieldExceptionsByGroupName", () => {
  it("re-keys ItemRef -> group name, skipping groups with no ref and refs with no group", () => {
    const groups: SyncGroup[] = [
      { name: "graph", ref: "core/graph", path: "{configDir}/graph.json", type: "file", devices: "all" },
      { name: "orphan", path: "x.json", type: "file", devices: "all" },
    ];
    const table = { "core/graph": { colorGroups: "not-synced" as const }, "core/gone": { k: "not-synced" as const } };
    expect(fieldExceptionsByGroupName(table, groups)).toEqual({ graph: ["colorGroups"] });
  });
});

it("exports the storage key verbatim", () => {
  expect(DEVICE_FIELDS_KEY).toBe("config-sync-device-fields");
});

it("deviceFieldPatterns returns [] for an unknown ref", () => {
  expect(deviceFieldPatterns({}, "core/graph")).toEqual([]);
});
