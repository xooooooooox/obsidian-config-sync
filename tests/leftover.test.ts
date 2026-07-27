import { describe, expect, it } from "vitest";
import { SyncGroup } from "../src/core/types";
import { leftoverStoreRels, storeSelfCopyGroups } from "../src/core/leftover";
import { buildItemDefs, ItemDef, RegistryEnv } from "../src/core/registry";

const groups: SyncGroup[] = [
  { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" },
  { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
];

describe("leftoverStoreRels", () => {
  it("keeps only store files that map to no current group", () => {
    const rels = [
      "store/configdir/plugins/demo/data.json", // tracked (plugin-demo) → not leftover
      "store/configdir/snippets/a.css", // tracked (snippets dir) → not leftover
      "store/configdir/plugins/gone/data.json", // no group → leftover
      "store/configdir/app.json", // no group → leftover
      "store.lock.json", // bookkeeping, not under store/ → excluded
      "config-sync.json", // legacy bookkeeping → excluded
    ];
    const out = leftoverStoreRels(rels, groups);
    expect(out.map((o) => o.rel)).toEqual(["store/configdir/plugins/gone/data.json", "store/configdir/app.json"]);
  });

  it("derives a plugin id name for plugin paths and the relative path otherwise", () => {
    const out = leftoverStoreRels(
      ["store/configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json", "store/configdir/graph.json"],
      []
    );
    expect(out).toEqual([
      { rel: "store/configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json", name: "cm-editor-syntax-highlight-obsidian", path: "configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json" },
      { rel: "store/configdir/graph.json", name: "configdir/graph.json", path: "configdir/graph.json" },
    ]);
  });

  it("store files defined by the store's own sync list are pending, not leftover", () => {
    const localGroups: SyncGroup[] = [{ name: "plugin-a", path: "{configDir}/plugins/a/data.json", type: "file", devices: "all" }];
    const storeListGroups: SyncGroup[] = [{ name: "plugin-z", path: "{configDir}/plugins/z/data.json", type: "file", devices: "all" }];
    const rels = [
      "store/configdir/plugins/a/data.json", // local list → not leftover
      "store/configdir/plugins/z/data.json", // store list (pulled, not yet adopted) → pending, not leftover
      "store/configdir/plugins/orphan/data.json", // neither → leftover
    ];
    const out = leftoverStoreRels(rels, [...localGroups, ...storeListGroups]);
    expect(out.map((f) => f.name)).toEqual(["orphan"]);
  });
});

const NO_DEFS: ItemDef[] = [];

describe("storeSelfCopyGroups", () => {
  it("parses the schema-v1 groups array and tolerates malformed json", () => {
    expect(storeSelfCopyGroups('{"groups":[{"name":"x","path":"p","type":"file","devices":"all"}]}', NO_DEFS).map((g) => g.name)).toEqual(["x"]);
    expect(storeSelfCopyGroups("not json", NO_DEFS)).toEqual([]);
    expect(storeSelfCopyGroups('{"noGroups":true}', NO_DEFS)).toEqual([]);
  });

  // Schema v2 no longer persists the compiled `groups` list — the store copy carries
  // `items` + `customGroups`, which must recompile to the same group list the source device
  // ran with. The 2026-07-27 regression: this returned [] for every v2 store copy, so the
  // self pane's delta listed the ENTIRE local sync list as "not yet in the store".
  describe("schema v2 store copies", () => {
    const env: RegistryEnv = { cores: [], plugins: [{ id: "demo", name: "Demo" }], betaIds: new Set() };
    const defs = buildItemDefs(env);

    it("recompiles items + customGroups into the store's group list", () => {
      const json = JSON.stringify({
        items: { "community:demo": { enabled: true, companions: [] } },
        customGroups: [{ name: "my-rule", path: "docs/x.md", type: "file", devices: "all" }],
      });
      const names = storeSelfCopyGroups(json, defs)
        .map((g) => g.name)
        .sort();
      expect(names).toEqual(["community-plugins", "my-rule", "plugin-demo"]);
    });

    it("synthesizes a community def for a store item whose plugin is not installed locally", () => {
      const json = JSON.stringify({
        items: {
          "community:foreign": {
            enabled: true,
            companions: [{ path: "{configDir}/plugins/foreign", scope: "all", enabled: true }],
          },
        },
      });
      const groups = storeSelfCopyGroups(json, defs);
      const byName = new Map(groups.map((g) => [g.name, g]));
      expect([...byName.keys()].sort()).toEqual(["community-plugins", "foreign", "plugin-foreign"]);
      expect(byName.get("plugin-foreign")?.path).toBe("{configDir}/plugins/foreign/data.json");
      // pulled-but-unadopted plugin data must attribute to the store list, not read as leftover
      expect(leftoverStoreRels(["store/configdir/plugins/foreign/data.json", "store/configdir/plugins/foreign/main.js"], groups)).toEqual([]);
    });

    it("returns [] when the v2 compile fails instead of breaking status", () => {
      // two custom rules with the same name → CompileError inside compileItems
      const json = JSON.stringify({
        items: {},
        customGroups: [
          { name: "dup", path: "a.md", type: "file", devices: "all" },
          { name: "dup", path: "b.md", type: "file", devices: "all" },
        ],
      });
      expect(storeSelfCopyGroups(json, defs)).toEqual([]);
    });
  });
});
