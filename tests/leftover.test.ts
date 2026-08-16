import { describe, expect, it } from "vitest";
import { SyncGroup } from "../src/core/types";
import { LeftoverNames, leftoverStoreRels, storeSelfCopyGroups, selfListGroups } from "../src/core/leftover";
import { buildItemDefs, ItemDef, RegistryEnv } from "../src/core/registry";
import { syncListDelta } from "../src/core/syncListDelta";
import { itemsIn } from "./items";

const groups: SyncGroup[] = [
  { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" },
  { name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all" },
];

// The no-resolution baseline: every name falls back to id/basename.
const NO_NAMES: LeftoverNames = { pluginLabels: new Map(), fileOwners: new Map(), appearanceLabel: "Appearance" };

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
    const out = leftoverStoreRels(rels, groups, NO_NAMES);
    // sorted by section (obsidian before community), then name
    expect(out.map((o) => o.rel)).toEqual(["store/configdir/app.json", "store/configdir/plugins/gone/data.json"]);
  });

  // The name slot names the file's REAL owner, never a raw store path (DESIGN.md §4 Leftover):
  // plugin label (else id), the Appearance breadcrumb for snippets/themes, the owning core
  // plugin / Obsidian card for a config-root file, basename otherwise — grouped into the main
  // list's section vocabulary, sorted section-then-name.
  it("resolves real owners: plugin label, Appearance breadcrumb, file owner, basename fallback", () => {
    const names: LeftoverNames = {
      pluginLabels: new Map([["slides-rup", "Slides Rup"]]),
      fileOwners: new Map([["graph.json", { section: "core", label: "Graph view" }]]),
      appearanceLabel: "Appearance",
    };
    const out = leftoverStoreRels(
      [
        "store/configdir/plugins/slides-rup/data.json",
        "store/configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json",
        "store/configdir/snippets/IOTO-TDL.css",
        "store/configdir/themes/Blue Topaz/theme.css",
        "store/configdir/graph.json",
        "store/configdir/app.json",
        "store/gitignore",
      ],
      [],
      names
    );
    expect(out).toEqual([
      // obsidian first: the app.json fallback (no owner registered in this fixture) and the two Appearance files
      { rel: "store/configdir/app.json", section: "obsidian", name: "app.json", crumb: null, path: "configdir/app.json" },
      { rel: "store/configdir/snippets/IOTO-TDL.css", section: "obsidian", name: "IOTO-TDL.css", crumb: "Appearance", path: "configdir/snippets/IOTO-TDL.css" },
      { rel: "store/configdir/themes/Blue Topaz/theme.css", section: "obsidian", name: "theme.css", crumb: "Appearance", path: "configdir/themes/Blue Topaz/theme.css" },
      // core: the owned config-root file names its core plugin
      { rel: "store/configdir/graph.json", section: "core", name: "Graph view", crumb: null, path: "configdir/graph.json" },
      // community: label when known, bare id when not — never the raw path
      {
        rel: "store/configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json",
        section: "community",
        name: "cm-editor-syntax-highlight-obsidian",
        crumb: null,
        path: "configdir/plugins/cm-editor-syntax-highlight-obsidian/data.json",
      },
      { rel: "store/configdir/plugins/slides-rup/data.json", section: "community", name: "Slides Rup", crumb: null, path: "configdir/plugins/slides-rup/data.json" },
      // other: vault-root files
      { rel: "store/gitignore", section: "other", name: "gitignore", crumb: null, path: "gitignore" },
    ]);
  });

  // The very shape behind a real 29-row sighting: an item `synced: false` on BOTH sides (the local
  // compile and the store's own self copy) compiles no group, so its store file IS leftover — by
  // design; the case that must NOT read as leftover is the device-local "On this device" opt-out,
  // which never touches `synced` and leaves the group compiled.
  it("a store file whose item is synced: false on both sides reads as leftover", () => {
    const env: RegistryEnv = { cores: [], plugins: [{ id: "demo", name: "Demo" }], betaIds: new Set() };
    const defs = buildItemDefs(env);
    const off = itemsIn({ obsidian: { "community-plugins": { synced: true } }, community: { demo: { synced: false } } });
    const local = selfListGroups(defs, off, NO_BETA_IDS);
    const storeCopy = storeSelfCopyGroups(JSON.stringify({ schemaVersion: 4, items: off }), defs, NO_BETA_IDS);
    const out = leftoverStoreRels(["store/configdir/plugins/demo/data.json"], [...local, ...storeCopy], NO_NAMES);
    expect(out.map((f) => f.name)).toEqual(["demo"]);
  });

  it("store files defined by the store's own sync list are pending, not leftover", () => {
    const localGroups: SyncGroup[] = [{ name: "plugin-a", path: "{configDir}/plugins/a/data.json", type: "file", devices: "all" }];
    const storeListGroups: SyncGroup[] = [{ name: "plugin-z", path: "{configDir}/plugins/z/data.json", type: "file", devices: "all" }];
    const rels = [
      "store/configdir/plugins/a/data.json", // local list → not leftover
      "store/configdir/plugins/z/data.json", // store list (pulled, not yet adopted) → pending, not leftover
      "store/configdir/plugins/orphan/data.json", // neither → leftover
    ];
    const out = leftoverStoreRels(rels, [...localGroups, ...storeListGroups], NO_NAMES);
    expect(out.map((f) => f.name)).toEqual(["orphan"]);
  });
});

const NO_DEFS: ItemDef[] = [];
const NO_BETA_IDS: ReadonlySet<string> = new Set();

describe("storeSelfCopyGroups", () => {
  it("parses the schema-v1 groups array and tolerates malformed json", () => {
    expect(storeSelfCopyGroups('{"groups":[{"name":"x","path":"p","type":"file","devices":"all"}]}', NO_DEFS, NO_BETA_IDS).map((g) => g.name)).toEqual(["x"]);
    expect(storeSelfCopyGroups("not json", NO_DEFS, NO_BETA_IDS)).toEqual([]);
    expect(storeSelfCopyGroups('{"noGroups":true}', NO_DEFS, NO_BETA_IDS)).toEqual([]);
  });

  // v3 does not persist the compiled `groups` list — the store copy carries `items` (custom
  // items included), which must recompile to the same group list the source device ran with. The
  // 2026-07-27 regression: this returned [] for every such store copy, so the self pane's delta
  // listed the ENTIRE local sync list as "not yet in the store".
  describe("v3 store copies", () => {
    const env: RegistryEnv = { cores: [], plugins: [{ id: "demo", name: "Demo" }], betaIds: new Set() };
    const defs = buildItemDefs(env);

    it("recompiles every section, custom items included, into the store's group list", () => {
      const json = JSON.stringify({
        items: itemsIn({
          // The carrier is an item: its own entry, not merely "some plugin in the
          // section is synced", is what makes compileItems emit "community-plugins".
          obsidian: { "community-plugins": { synced: true } },
          community: { demo: { synced: true } },
          custom: { "my-rule": { synced: true, type: "file", path: "docs/x.md" } },
        }),
      });
      const names = storeSelfCopyGroups(json, defs, NO_BETA_IDS)
        .map((g) => g.name)
        .sort();
      expect(names).toEqual(["community-plugins", "my-rule", "plugin-demo"]);
    });

    it("synthesizes a community def for a store item whose plugin is not installed locally", () => {
      const json = JSON.stringify({
        items: itemsIn({
          obsidian: { "community-plugins": { synced: true } },
          community: { foreign: { synced: true, companions: [{ path: "{configDir}/plugins/foreign", device: "all", enabled: true }] } },
        }),
      });
      const groups = storeSelfCopyGroups(json, defs, NO_BETA_IDS);
      const byName = new Map(groups.map((g) => [g.name, g]));
      expect([...byName.keys()].sort()).toEqual(["community-plugins", "foreign", "plugin-foreign"]);
      expect(byName.get("plugin-foreign")?.path).toBe("{configDir}/plugins/foreign/data.json");
      // pulled-but-unadopted plugin data must attribute to the store list, not read as leftover
      expect(leftoverStoreRels(["store/configdir/plugins/foreign/data.json", "store/configdir/plugins/foreign/main.js"], groups, NO_NAMES)).toEqual([]);
    });

    it("returns [] when the compile fails instead of breaking status", () => {
      // a custom item whose name shadows a reserved registry name → CompileError in compileItems
      const json = JSON.stringify({ items: itemsIn({ custom: { hotkeys: { synced: true, type: "file", path: "a.md" } } }) });
      expect(storeSelfCopyGroups(json, defs, NO_BETA_IDS)).toEqual([]);
    });
  });

  // Review C1. For the whole v3 transition window the store is still written by devices on 2.21.0,
  // so a v3 device reading a v2 self copy is the NORMAL state, not an edge case. Reading it as []
  // would report every item as "added" in the self pane, offer other devices' store files as
  // deletable leftover, and empty readStoreContractLocals — which switches OFF the store-contract
  // this-device strip and lets this device publish its own device-local values into the store.
  describe("v2 store copies are migrated in memory (review C1)", () => {
    const env: RegistryEnv = { cores: [{ id: "graph", name: "Graph view", fileExists: true }], plugins: [{ id: "demo", name: "Demo" }], betaIds: new Set() };
    const defs = buildItemDefs(env);
    const v2Copy = JSON.stringify({
      schemaVersion: 2,
      items: {
        "community:demo": { enabled: true, companions: [] },
        "community:foreign": { enabled: true, companions: [] },
        "core:graph": { enabled: true, companions: [] },
        appearance: {
          enabled: true,
          companions: [],
          settingsFile: { mode: "fields", rules: { cssTheme: { scope: "local", encrypted: false } }, perItem: {} },
        },
      },
      customGroups: [{ name: "my-rule", path: "docs/x.md", type: "file", devices: "all" }],
      memberRules: {},
      localMembers: [],
    });

    // The two carriers are in this list BECAUSE the read runs the whole chain (v2 → v3 → v4): the
    // v4 step's rule 6 seeds `items.obsidian["core-plugins"/"community-plugins"].synced` from
    // whether the section had a synced item, which is exactly what v2/v3's `anyEnabledInList`
    // compile loop answered. Without it a foreign copy's on/off lists read as not synced at
    // all, and the self pane would report them as this device's own additions.
    it("recompiles the flat v2 item map and its customGroups into the store's group list", () => {
      const names = storeSelfCopyGroups(v2Copy, defs, NO_BETA_IDS)
        .map((g) => g.name)
        .sort();
      expect(names).toEqual(["appearance", "graph", "my-rule", "plugin-demo", "plugin-foreign", "core-plugins", "community-plugins"].sort());
    });

    it("attributes a not-installed plugin's pulled files as pending, not as deletable leftover", () => {
      const groups = storeSelfCopyGroups(v2Copy, defs, NO_BETA_IDS);
      expect(leftoverStoreRels(["store/configdir/plugins/foreign/data.json"], groups, NO_NAMES)).toEqual([]);
    });

    // The rule readStoreContractLocals reads off these groups: a v2 `scope: "local"` field must
    // arrive as a this-device sharing, or the store-contract strip has nothing to union.
    it("brings the store contract's this-device field rules across, so the strip stays on", () => {
      const appearance = storeSelfCopyGroups(v2Copy, defs, NO_BETA_IDS).find((g) => g.name === "appearance");
      expect((appearance?.fields ?? []).filter((f) => f.sharing.kind === "this-device").map((f) => f.pattern)).toEqual(["cssTheme"]);
    });

    // The SAME argument one version later, and the reason storeSelfCopyGroups runs the v4 step too:
    // for the v4 transition window the store is written by devices on 2.22.0, and a genuine v3 copy
    // spells an item's sync flag `enabled` and carries no carrier entries at all — two facts nothing
    // in this build reads any more. Without the chain such a copy compiles to NOTHING, which is
    // exactly the three failures the block comment above names.
    it("reads a genuine 2.22.0 self copy: `enabled` items and no carrier entries", () => {
      const v3Copy = JSON.stringify({
        schemaVersion: 3,
        items: {
          obsidian: { appearance: { enabled: true } },
          core: { graph: { enabled: true } },
          community: { demo: { enabled: true }, foreign: { enabled: true } },
          custom: {},
        },
      });

      const names = storeSelfCopyGroups(v3Copy, defs, NO_BETA_IDS).map((g) => g.name);

      // the plugin/core items, which read as nothing at all while `enabled` went unread…
      expect(names).toContain("plugin-demo");
      expect(names).toContain("plugin-foreign");
      expect(names).toContain("graph");
      expect(names).toContain("appearance");
      // …and both carriers, which a v3 document has no entry for: rule 6 seeds them from whether the
      // section had a synced item, exactly as the retired anyEnabledInList compile loop did.
      expect(names).toContain("community-plugins");
      expect(names).toContain("core-plugins");
    });

    it("…and seeds a carrier only when its own section had something synced", () => {
      const noCore = JSON.stringify({
        schemaVersion: 3,
        items: { obsidian: {}, core: { graph: { enabled: false } }, community: { demo: { enabled: true } }, custom: {} },
      });

      const names = storeSelfCopyGroups(noCore, defs, NO_BETA_IDS).map((g) => g.name);

      expect(names).toContain("community-plugins");
      expect(names).not.toContain("core-plugins");
    });
  });
});

describe("selfListGroups (delta ghost regression, spec 2026-07-28 §2)", () => {
  const defs = buildItemDefs({
    cores: [],
    plugins: [{ id: "omnisearch", name: "Omnisearch", desktopOnly: false }],
    betaIds: new Set<string>(),
  });
  const items = itemsIn({
    community: {
      omnisearch: { synced: true },
      // obsidian-git is NOT installed on this device (no def) but IS in the local items:
      "obsidian-git": { synced: true },
    },
  });

  it("keeps items whose plugin has no local def", () => {
    const names = selfListGroups(defs, items, NO_BETA_IDS).map((g) => g.name);
    expect(names).toContain("plugin-omnisearch");
    expect(names).toContain("plugin-obsidian-git");
  });

  it("identical items on both sides produce an empty delta", () => {
    const local = selfListGroups(defs, items, NO_BETA_IDS);
    const store = selfListGroups(defs, items, NO_BETA_IDS);
    expect(syncListDelta(local, store)).toEqual({ added: [], removed: [] });
  });

  it("a store-only item still reports added", () => {
    const local = selfListGroups(defs, items, NO_BETA_IDS);
    const store = selfListGroups(defs, { ...items, community: { ...items.community, newone: { synced: true } } }, NO_BETA_IDS);
    expect(syncListDelta(local, store).added).toContain("plugin-newone");
  });
});

// The version gate on the read side. A store copy written by a NEWER build is not ours
// to compile — its `items` may mean something this build cannot see, and every consumer of this list
// would then act on a reading we invented.
describe("storeSelfCopyGroups — a self copy from a newer build", () => {
  it("compiles nothing for a document whose schemaVersion is from the future", () => {
    const future = JSON.stringify({ schemaVersion: 99, items: { obsidian: { hotkeys: { synced: true } } } });
    const env: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };
    expect(storeSelfCopyGroups(future, buildItemDefs(env), new Set())).toEqual([]);
  });

  it("still compiles a document this build understands", () => {
    const ours = JSON.stringify({ schemaVersion: 3, items: { obsidian: { hotkeys: { synced: true } }, core: {}, community: {}, custom: {} } });
    const env: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };
    expect(storeSelfCopyGroups(ours, buildItemDefs(env), new Set()).map((g) => g.name)).toEqual(["hotkeys"]);
  });
});
