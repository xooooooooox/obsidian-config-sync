import { describe, expect, it } from "vitest";
import { commitDraft } from "../src/ui/commitGroups";
import { SyncGroup } from "../src/core/types";

const base: SyncGroup[] = [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all" }];

describe("commitDraft", () => {
  it("returns the mutated draft on a successful write", async () => {
    const res = await commitDraft(base, (d) => d.push({ name: "b", path: "{configDir}/b.json", type: "file", devices: "all" }), async () => {});
    expect(res.ok).toBe(true);
    expect(res.groups.map((g) => g.name)).toEqual(["a", "b"]);
    expect(base.map((g) => g.name)).toEqual(["a"]); // original untouched
  });
  it("returns the original groups and the error on a failed write", async () => {
    const res = await commitDraft(base, (d) => d.push({ name: "bad", path: "", type: "file", devices: "all" }), async () => { throw new Error("boom"); });
    expect(res.ok).toBe(false);
    expect(res.groups).toBe(base); // same reference — unchanged
    expect(res.error).toBe("boom");
  });
});
