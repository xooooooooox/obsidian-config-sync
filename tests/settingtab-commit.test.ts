import { describe, expect, it } from "vitest";
import { commitDraft } from "../src/ui/commitGroups";
import { SELF_GROUP_NAME, selfPresetRules } from "../src/core/catalog";
import { SyncGroup } from "../src/core/types";
import { setSnippetScope } from "../src/ui/SettingTab";

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
  it("re-runs ensureSelfPresets so no UI edit can drop the self item's locked rules", async () => {
    const withSelfNoPresets: SyncGroup[] = [
      { name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" },
    ];
    let written: SyncGroup[] = [];
    const res = await commitDraft(
      withSelfNoPresets,
      (d) => {
        const g = d.find((x) => x.name === SELF_GROUP_NAME);
        if (g !== undefined) g.fields = [{ pattern: "rootPath", action: "strip" }]; // user tries to strip the preset unlocked
      },
      async (g) => {
        written = g;
      }
    );
    expect(res.ok).toBe(true);
    const self = written.find((g) => g.name === SELF_GROUP_NAME);
    expect(self?.mode).toBe("fields");
    expect(self?.fields).toEqual(selfPresetRules());
  });
});

describe("setSnippetScope", () => {
  it("stores non-all and deletes on all", () => {
    expect(setSnippetScope({}, "a-mobile", "mobile")).toEqual({ "a-mobile": "mobile" });
    expect(setSnippetScope({ "a-mobile": "mobile" }, "a-mobile", "all")).toEqual({});
  });
});
