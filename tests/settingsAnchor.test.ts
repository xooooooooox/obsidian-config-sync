import { describe, expect, it } from "vitest";
import { cardExpandKey, ConfigSyncSettingTab, itemAnchorId, refFromItemAnchor } from "../src/ui/SettingTab";
import { buildItemDefs, defRef, ItemDef, RegistryEnv } from "../src/core/registry";
import { ItemRef, SyncGroup } from "../src/core/types";
import { itemsIn } from "./items";

// NEW-I1 (fix round 2). The C1 fix made a `beta/<id>` ref unmintable, and the type found every
// CONSTRUCTION. It could not find the COMPARISONS: `consumeSettingsAnchor` matched a def against a
// parsed ref with `d.section === parsed.section`, presented on the left ("beta") and stored on the
// right ("community"), so every BRAT-managed plugin's "More ▸ opens Settings" fell through to the
// Advanced tab with a dead `advanced-rule-<id>` anchor. A regression against BASE, invisible to
// tsc, and reachable from the one bridge the Sync Center uses to deep-link into this panel.
//
// This drives the real anchor path — the tab's own consume, fed the ref main.ts's openSettingsAt
// actually stores — rather than the ref-construction the type already protects.
const ENV: RegistryEnv = {
  cores: [{ id: "graph", name: "Graph view", fileExists: true }],
  plugins: [
    { id: "dataview", name: "Dataview" },
    { id: "slides-rup", name: "SlidesRup" },
  ],
  betaIds: new Set(["slides-rup"]),
};

interface AnchorTab {
  activeTab: string;
  expanded: Set<string>;
  renderGen: number;
  groups: SyncGroup[];
  consumeSettingsAnchor: () => string | null;
  buildSearchIndex: (gen: number) => Promise<{ kind: string; anchorId: string; name: string }[] | null>;
  jumpTo: (hit: { kind: string; anchorId: string; section: string }) => void;
  // Stubbed below: jumpTo's tail re-renders and scrolls, which needs a live panel. The derivation
  // under test runs before either.
  rerender: (gen: number) => Promise<void>;
  highlightAnchor: (anchorId: string) => void;
}

function tabFor(pending: ItemRef | null): AnchorTab {
  const defs = buildItemDefs(ENV);
  const host = {
    settings: { items: itemsIn({}) },
    itemDefs: (): ItemDef[] => defs,
    installedPluginIds: () => defs.filter((d) => d.groupName.startsWith("plugin-")).map((d) => d.id),
    remotes: [],
    consumePendingSettingsAnchor: () => pending,
  };
  const tab = new ConfigSyncSettingTab({} as never, host as never);
  const priv = tab as unknown as AnchorTab;
  priv.groups = [];
  priv.rerender = async () => {};
  priv.highlightAnchor = () => {};
  return priv;
}

describe("SettingTab.consumeSettingsAnchor — the More bridge lands on the card, not the Advanced tab", () => {
  const defs = buildItemDefs(ENV);
  const beta = defs.find((d) => d.id === "slides-rup") as ItemDef;

  // NEW-I2 (fix round 3) reshaped these: asserting an anchor against its own LITERAL is exactly
  // why the search-index divergence survived the NEW-I1 test — a literal agrees with whichever
  // producer the test author was looking at, and says nothing about the other three. Every
  // assertion below now compares a producer against a producer.
  it("a BRAT-managed plugin's ref opens its Beta card — the def presents beta, the ref stores community", () => {
    expect(beta.section).toBe("beta");

    const tab = tabFor(defRef(beta));
    const anchor = tab.consumeSettingsAnchor();

    expect(tab.activeTab).toBe("beta");
    expect(anchor).toBe(itemAnchorId(defRef(beta)));
    expect(tab.expanded.has(cardExpandKey(defRef(beta)))).toBe(true);
  });

  it("an ordinary community plugin still lands on its card (the case that never broke)", () => {
    const dataview = defs.find((d) => d.id === "dataview") as ItemDef;
    const tab = tabFor(defRef(dataview));

    expect(tab.consumeSettingsAnchor()).toBe(itemAnchorId(defRef(dataview)));
    expect(tab.activeTab).toBe("plugins");
  });

  it("a core item lands on the Core tab", () => {
    const graph = defs.find((d) => d.section === "core" && d.id === "graph") as ItemDef;
    const tab = tabFor(defRef(graph));

    expect(tab.consumeSettingsAnchor()).toBe(itemAnchorId(defRef(graph)));
    expect(tab.activeTab).toBe("core");
  });

  // The fallback is for a ref no def claims — a custom rule, which really does live on the
  // Advanced tab under its bare name. It must stay reachable, and it must NOT be where a beta
  // plugin ends up.
  it("a custom item still falls through to the Advanced tab under its bare name", () => {
    const tab = tabFor("custom/my-rule");

    expect(tab.consumeSettingsAnchor()).toBe("advanced-rule-my-rule");
    expect(tab.activeTab).toBe("advanced");
  });

  it("nothing pending is nothing to scroll to", () => {
    expect(tabFor(null).consumeSettingsAnchor()).toBeNull();
  });
});


// NEW-I2 (fix round 3). The item card's anchor and drawer key had FOUR authors — the card
// renderer, the search index, the More bridge's consumer, and jumpTo — and they agreed only by
// spelling. When the card sites moved to `defRef(def)` and the search index was left on `def.id`,
// every item hit in every section stopped jumping, silently: `highlightAnchor` finds no element
// and returns.
//
// The shape that catches this is PRODUCER VERSUS PRODUCER. A test that pins either side against a
// literal passes while the other side drifts — which is precisely what happened.
describe("the item card's derived keys have one producer (NEW-I2)", () => {
  const defs = buildItemDefs(ENV);

  it("what buildSearchIndex emits is what the card's own anchor consumer produces — for every item", async () => {
    const tab = tabFor(null);
    const hits = await tab.buildSearchIndex(tab.renderGen);
    const itemHits = (hits ?? []).filter((h) => h.kind === "item");
    expect(itemHits.length).toBe(defs.length); // every def is indexed — no silent gap

    for (const def of defs) {
      const hit = itemHits.find((h) => h.name === def.label);
      expect(hit, `no search hit for ${def.label}`).toBeDefined();
      // The other producer, reached through the path that actually renders the card.
      expect(hit?.anchorId).toBe(tabFor(defRef(def)).consumeSettingsAnchor());
    }
  });

  it("the drawer key jumpTo derives from a search hit is the key the anchor consumer expands", async () => {
    const beta = defs.find((d) => d.id === "slides-rup") as ItemDef;
    const tab = tabFor(null);
    const hits = await tab.buildSearchIndex(tab.renderGen);
    const hit = (hits ?? []).find((h) => h.kind === "item" && h.name === beta.label);

    const jumped = tabFor(null);
    jumped.jumpTo({ kind: "item", anchorId: hit!.anchorId, section: "beta" });

    const consumed = tabFor(defRef(beta));
    consumed.consumeSettingsAnchor();
    expect([...jumped.expanded]).toEqual([...consumed.expanded]);
  });

  it("itemAnchorId round-trips through refFromItemAnchor, and refuses everything that is not an item anchor", () => {
    for (const def of defs) expect(refFromItemAnchor(itemAnchorId(defRef(def)))).toBe(defRef(def));
    expect(refFromItemAnchor("general-pkm-mode")).toBeNull();
    expect(refFromItemAnchor("advanced-rule-my-rule")).toBeNull();
    expect(refFromItemAnchor("remote-laptop")).toBeNull();
    // A ref that was never legal is refused here the same way parseItemRef refuses it everywhere.
    expect(refFromItemAnchor("item-beta/slides-rup")).toBeNull();
  });
});
