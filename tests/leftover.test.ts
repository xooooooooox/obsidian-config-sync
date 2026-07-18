import { describe, expect, it } from "vitest";
import { SyncGroup } from "../src/core/types";
import { leftoverStoreRels } from "../src/core/leftover";

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
});
