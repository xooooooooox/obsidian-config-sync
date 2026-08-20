import { describe, it, expect } from "vitest";
import { SELF_ITEM_REF } from "../src/core/catalog";
import { refsBlockedFor } from "../src/core/remoteRules";
import { RemoteItems } from "../src/core/types";

// The bridge this task rests on: a migrated excludeSelf remote must produce exactly the list the
// four seams were hard-coding, in both directions. If this ever stops holding, the "behaviour
// unchanged" claim of schema v5 stops holding with it.
describe("migrated excludeSelf equals the old hard-coded skip list", () => {
  const migrated: RemoteItems = { community: { "config-sync": { direction: "none" } } };

  it("skips exactly the self item on push", () => {
    expect(refsBlockedFor(migrated, "push")).toEqual([SELF_ITEM_REF]);
  });

  it("skips exactly the self item on pull", () => {
    expect(refsBlockedFor(migrated, "pull")).toEqual([SELF_ITEM_REF]);
  });

  it("skips nothing when the remote had no rules", () => {
    expect(refsBlockedFor(undefined, "push")).toEqual([]);
    expect(refsBlockedFor(undefined, "pull")).toEqual([]);
  });
});
