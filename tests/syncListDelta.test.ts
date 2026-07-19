import { describe, expect, it } from "vitest";
import { syncListDelta } from "../src/core/syncListDelta";

const g = (name: string) => ({ name, path: `{configDir}/${name}.json`, type: "file" as const, devices: "all" as const });

describe("syncListDelta", () => {
  it("added = store-only, removed = local-only, by name, sorted", () => {
    const d = syncListDelta([g("a"), g("b")], [g("b"), g("z"), g("y")]);
    expect(d).toEqual({ added: ["y", "z"], removed: ["a"] });
  });
  it("empty when identical", () => {
    expect(syncListDelta([g("a")], [g("a")])).toEqual({ added: [], removed: [] });
  });
});
