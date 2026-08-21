import { describe, expect, it } from "vitest";
import { SettingsDeepLink } from "../src/ui/settingsDeepLink";
import { cardExpandKey, ConfigSyncSettingTab, itemAnchorId, refFromItemAnchor } from "../src/ui/SettingTab";
import { buildItemDefs, defRef, ItemDef, RegistryEnv } from "../src/core/registry";
import { ItemRef, SyncGroup } from "../src/core/types";
import { itemsIn } from "./items";

// The type system makes a `beta/<id>` ref unmintable, so it protects every
// CONSTRUCTION. It cannot protect the COMPARISONS: if `consumeSettingsAnchor` matched a def
// against a
// parsed ref with `d.section === parsed.section`, presented on the left ("beta") and stored on the
// right ("community"), every BRAT-managed plugin's "More ▸ opens Settings" would fall through to
// the Advanced tab with a dead `advanced-rule-<id>` anchor — a regression invisible to
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

function tabFor(pending: SettingsDeepLink | null): AnchorTab {
  const defs = buildItemDefs(ENV);
  const host = {
    settings: { items: itemsIn({}) },
    itemDefs: (): ItemDef[] => defs,
    installedPluginIds: () => defs.filter((d) => d.groupName.startsWith("plugin-")).map((d) => d.id),
    remotes: [],
    consumePendingSettingsAnchor: () => pending,
    consumePendingGeneralAnchor: () => null,
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

  // Asserting an anchor against its own LITERAL is exactly
  // how a search-index divergence survives — a literal agrees with whichever
  // producer the test author was looking at, and says nothing about the other three. Every
  // assertion below compares a producer against a producer.
  it("a BRAT-managed plugin's ref opens its Beta card — the def presents beta, the ref stores community", () => {
    expect(beta.section).toBe("beta");

    const tab = tabFor({ ref: defRef(beta), spot: "card" });
    const anchor = tab.consumeSettingsAnchor();

    expect(tab.activeTab).toBe("beta");
    expect(anchor).toBe(itemAnchorId(defRef(beta)));
    expect(tab.expanded.has(cardExpandKey(defRef(beta)))).toBe(true);
  });

  it("an ordinary community plugin still lands on its card (the case that never broke)", () => {
    const dataview = defs.find((d) => d.id === "dataview") as ItemDef;
    const tab = tabFor({ ref: defRef(dataview), spot: "card" });

    expect(tab.consumeSettingsAnchor()).toBe(itemAnchorId(defRef(dataview)));
    expect(tab.activeTab).toBe("plugins");
  });

  it("a core item lands on the Core tab", () => {
    const graph = defs.find((d) => d.section === "core" && d.id === "graph") as ItemDef;
    const tab = tabFor({ ref: defRef(graph), spot: "card" });

    expect(tab.consumeSettingsAnchor()).toBe(itemAnchorId(defRef(graph)));
    expect(tab.activeTab).toBe("core");
  });

  // The fallback is for a ref no def claims — a custom rule, which really does live on the
  // Advanced tab under its bare name. It must stay reachable, and it must NOT be where a beta
  // plugin ends up.
  it("a custom item still falls through to the Advanced tab under its bare name", () => {
    const tab = tabFor({ ref: "custom/my-rule" as ItemRef, spot: "card" });

    expect(tab.consumeSettingsAnchor()).toBe("advanced-rule-my-rule");
    expect(tab.activeTab).toBe("advanced");
  });

  it("nothing pending is nothing to scroll to", () => {
    expect(tabFor(null).consumeSettingsAnchor()).toBeNull();
  });

  // Two entrances read the identical words `Per-key rules decide`, so they must land identically:
  // on the key-rules rows, never on the whole card. The card anchor is deliberately withheld —
  // returning one would flash the card first and the rules a moment later, which reads as two
  // different answers to one click — and the landing is handed to the card body's own build hook,
  // because the rules only exist once the async file read lands.
  it("a key-rules deep link withholds the card anchor and arms the in-card jump instead", () => {
    const dataview = defs.find((d) => d.id === "dataview") as ItemDef;
    const tab = tabFor({ ref: defRef(dataview), spot: "key-rules" });

    expect(tab.consumeSettingsAnchor()).toBeNull();
    expect(tab.activeTab).toBe("plugins");
    expect(tab.expanded.has(cardExpandKey(defRef(dataview)))).toBe(true);
    expect((tab as unknown as { pendingKeyRulesJump: string | null }).pendingKeyRulesJump).toBe(dataview.id);
  });
});


// The item card's anchor and drawer key have FOUR authors — the card
// renderer, the search index, the More bridge's consumer, and jumpTo — and they agree only by
// spelling. If the card sites use `defRef(def)` while the search index stays on `def.id`,
// every item hit in every section stops jumping, silently: `highlightAnchor` finds no element
// and returns.
//
// The shape that catches this is PRODUCER VERSUS PRODUCER. A test that pins either side against a
// literal passes while the other side drifts.
describe("the item card's derived keys have one producer", () => {
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
      expect(hit?.anchorId).toBe(tabFor({ ref: defRef(def), spot: "card" }).consumeSettingsAnchor());
    }
  });

  it("the drawer key jumpTo derives from a search hit is the key the anchor consumer expands", async () => {
    const beta = defs.find((d) => d.id === "slides-rup") as ItemDef;
    const tab = tabFor(null);
    const hits = await tab.buildSearchIndex(tab.renderGen);
    const hit = (hits ?? []).find((h) => h.kind === "item" && h.name === beta.label);

    const jumped = tabFor(null);
    jumped.jumpTo({ kind: "item", anchorId: hit!.anchorId, section: "beta" });

    const consumed = tabFor({ ref: defRef(beta), spot: "card" });
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
