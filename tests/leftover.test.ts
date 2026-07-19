import { describe, expect, it } from "vitest";
import { SyncGroup } from "../src/core/types";
import { leftoverStoreRels, storeSelfCopyGroups } from "../src/core/leftover";

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

describe("storeSelfCopyGroups", () => {
  it("parses the groups array and tolerates malformed json", () => {
    expect(storeSelfCopyGroups('{"groups":[{"name":"x","path":"p","type":"file","devices":"all"}]}').map((g) => g.name)).toEqual(["x"]);
    expect(storeSelfCopyGroups("not json")).toEqual([]);
    expect(storeSelfCopyGroups('{"noGroups":true}')).toEqual([]);
  });
});
