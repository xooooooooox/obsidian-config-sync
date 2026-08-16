import { describe, expect, it } from "vitest";
import { commitDraft } from "../src/ui/commitGroups";
import { SELF_GROUP_NAME, selfPresetRules } from "../src/core/catalog";
import { SyncGroup, THIS_DEVICE } from "../src/core/types";
import { ConfigSyncSettingTab, setMemberDeviceClass } from "../src/ui/SettingTab";
import { compileItems, customItemFromGroup, Item, ItemMap } from "../src/core/registry";
import { itemsIn } from "./items";

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
        if (g !== undefined) g.fields = [{ pattern: "rootPath", sharing: THIS_DEVICE, encrypted: false }]; // user tries to strip the preset unlocked
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

describe("setMemberDeviceClass", () => {
  it("stores non-all and deletes on all", () => {
    expect(setMemberDeviceClass({}, "a-mobile", "mobile")).toEqual({ "a-mobile": "mobile" });
    expect(setMemberDeviceClass({ "a-mobile": "mobile" }, "a-mobile", "all")).toEqual({});
  });
});


// The custom section's unknown-field carry reads the tail off the STORED item, and a
// RENAME changes the map key while leaving the item's identity in the store alone — so a lookup by
// name alone would silently drop every field a newer build wrote the moment a user renamed a rule.
// Driven through the real persist path (persistCustomItems), not the pure converter, because the
// name→path fallback lives in the tab.
describe("persistCustomItems — the carry survives a rename", () => {
  const STORED: Item = { ...customItemFromGroup({ name: "old-name", path: "notes/x.json", type: "file", devices: "all" }), writtenByANewerBuild: { keep: true } } as Item;

  interface PersistTab {
    persistCustomItems: (draft: SyncGroup[]) => Promise<void>;
  }

  function tabWith(): { tab: PersistTab; items: () => ItemMap } {
    const host = {
      settingsWritable: () => true,
      settings: { items: itemsIn({ custom: { "old-name": STORED } }) },
      saveSettings: async () => {},
      installedPluginIds: () => [],
      itemDefs: () => [],
    };
    const tab = new ConfigSyncSettingTab({} as never, host as never);
    return { tab: tab as unknown as PersistTab, items: () => host.settings.items };
  }

  it("a rename keeps the tail, matched by the path the rename did not touch", async () => {
    const { tab, items } = tabWith();

    await tab.persistCustomItems([{ name: "new-name", path: "notes/x.json", type: "file", devices: "all" }]);

    const renamed = items().custom["new-name"];
    expect(renamed).toBeDefined();
    expect(items().custom["old-name"]).toBeUndefined();
    expect((renamed as unknown as { writtenByANewerBuild: unknown }).writtenByANewerBuild).toEqual({ keep: true });
  });

  it("an edit that keeps the name keeps the tail too — the name lookup still leads", async () => {
    const { tab, items } = tabWith();

    await tab.persistCustomItems([{ name: "old-name", path: "notes/moved.json", type: "file", devices: "all" }]);

    const edited = items().custom["old-name"];
    expect(edited?.path).toBe("notes/moved.json");
    expect((edited as unknown as { writtenByANewerBuild: unknown }).writtenByANewerBuild).toEqual({ keep: true });
  });

  // The honest limit, pinned so it is a known gap rather than a surprise: rename AND re-path in one
  // commit leaves nothing to match on. The Advanced tab commits per field, so it takes two writes
  // to get here, and the first one carries the tail forward under the new key.
  it("a rename AND a re-path in the same commit is the one case with nothing left to match on", async () => {
    const { tab, items } = tabWith();

    await tab.persistCustomItems([{ name: "new-name", path: "notes/elsewhere.json", type: "file", devices: "all" }]);

    expect(items().custom["new-name"]).toBeDefined();
    expect(items().custom["new-name"]).not.toHaveProperty("writtenByANewerBuild");
  });
});

// A custom rule is the only
// item that CHOOSES its mode — the Advanced tab's Mode dropdown offers Plain/Fields/Encrypt on
// every one. If the item ↔ group conversion enumerated only "fields", editing any
// other field of an encrypted rule would silently rewrite it to Plain and the next capture would
// write that file into the store as PLAINTEXT. Driven through the real persist path, then back
// out through the compile path, because the loss needs both halves to show.
describe("persistCustomItems — an Encrypt-mode custom rule survives an unrelated edit", () => {
  it("keeps mode:'encrypted' through the item round trip and back into the compiled group", async () => {
    const host = {
      settingsWritable: () => true,
      settings: { items: itemsIn({ custom: { secrets: customItemFromGroup({ name: "secrets", path: "notes/s.json", type: "file", devices: "all", mode: "encrypted" }) } }) },
      saveSettings: async () => {},
      installedPluginIds: () => [],
      itemDefs: () => [],
    };
    const tab = new ConfigSyncSettingTab({} as never, host as never) as unknown as { persistCustomItems: (draft: SyncGroup[]) => Promise<void> };

    // an edit to something else entirely — the description — exactly as the tab commits it
    await tab.persistCustomItems([{ name: "secrets", path: "notes/s.json", type: "file", devices: "all", mode: "encrypted", description: "keys" }]);

    expect(host.settings.items.custom["secrets"]?.settingsFile?.mode).toBe("encrypted");
    expect(compileItems([], { items: host.settings.items }).find((g) => g.name === "secrets")?.mode).toBe("encrypted");
  });
});
