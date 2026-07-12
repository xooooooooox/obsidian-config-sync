import { describe, expect, it } from "vitest";
import { scanSensitive, groupNeedsPassphrase } from "../src/core/modes";
import { SyncGroup } from "../src/core/types";

describe("scanSensitive", () => {
  it("finds sensitive-looking keys recursively, case-insensitive", () => {
    const s = scanSensitive(JSON.stringify({ updateAPIKey: "x", nested: { myToken: "y", plain: 1 }, userEmail: "e" }));
    expect(s.keys.sort()).toEqual(["myToken", "updateAPIKey", "userEmail"]);
    expect(s.blob).toBe(false);
  });

  it("detects an opaque blob: one string >=1024 chars making >80% of the file", () => {
    const s = scanSensitive(JSON.stringify({ readme: "hi", d: "A".repeat(5000) }));
    expect(s.blob).toBe(true);
  });

  it("non-JSON content scans clean", () => {
    expect(scanSensitive("body { color: red }")).toEqual({ keys: [], blob: false });
  });
});

describe("groupNeedsPassphrase", () => {
  const base = { name: "g", path: "{configDir}/x.json", type: "file", devices: "all" } as unknown as SyncGroup;
  it("true for encrypted mode and for fields with an encrypt action", () => {
    expect(groupNeedsPassphrase({ ...base, mode: "encrypted" })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "encrypt" }] })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "strip" }] })).toBe(false);
    expect(groupNeedsPassphrase(base)).toBe(false);
  });
});
