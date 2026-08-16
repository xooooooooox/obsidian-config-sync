import { describe, expect, it } from "vitest";
import { parseQuery, applySuggestion, matchesQualifiers, suggest, type QualifierSpec, type QualifierResolver } from "../src/ui/qualifierSearch";
import { syncTypeValue, syncModeValue, syncActionValue, SyncCenterView, SYNC_QUALIFIER_SPECS, SYNC_QUALIFIER_KEYS } from "../src/ui/SyncCenterView";
import { ConfigSyncSettingTab, settingSectionValue, settingTypeValue, SETTING_QUALIFIER_RESOLVERS, SETTING_QUALIFIER_SPECS, SETTING_QUALIFIER_KEYS } from "../src/ui/SettingTab";
import { sectionForGroup } from "../src/core/catalog";
import { buildItemDefs, ItemDef, RegistryEnv } from "../src/core/registry";
import { SyncGroup } from "../src/core/types";
import { itemsIn } from "./items";

const KEYS = new Set(["type", "section", "action", "mode", "device"]);

describe("parseQuery", () => {
  it("empty → no text, no qualifiers", () => {
    expect(parseQuery("", KEYS)).toEqual({ text: "", qualifiers: [] });
  });
  it("plain words → text only", () => {
    expect(parseQuery("hot keys", KEYS)).toEqual({ text: "hot keys", qualifiers: [] });
  });
  it("single qualifier", () => {
    expect(parseQuery("type:folder", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "folder" }] });
  });
  it("multiple qualifiers AND, mixed with text, any order", () => {
    expect(parseQuery("snippets section:community type:folder", KEYS)).toEqual({
      text: "snippets",
      qualifiers: [{ key: "section", value: "community" }, { key: "type", value: "folder" }],
    });
  });
  it("unknown key → literal free text", () => {
    expect(parseQuery("foo:bar type:file", KEYS)).toEqual({
      text: "foo:bar",
      qualifiers: [{ key: "type", value: "file" }],
    });
  });
  it("key and value are case-insensitive (lowercased)", () => {
    expect(parseQuery("Type:Folder", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "folder" }] });
  });
  it("empty value kept (mid-typing)", () => {
    expect(parseQuery("type:", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "" }] });
  });
  it("quoted value keeps spaces, quotes stripped", () => {
    expect(parseQuery('section:"a b" plain', KEYS)).toEqual({
      text: "plain",
      qualifiers: [{ key: "section", value: "a b" }],
    });
  });
  it("quoted free text has quotes stripped", () => {
    expect(parseQuery('"a b" type:file', KEYS)).toEqual({
      text: "a b",
      qualifiers: [{ key: "type", value: "file" }],
    });
  });
});

describe("applySuggestion", () => {
  it("replaces the only token", () => {
    expect(applySuggestion("ty", "type:")).toBe("type:");
  });
  it("replaces just the last token, preserving earlier ones", () => {
    expect(applySuggestion("section:core ty", "type:")).toBe("section:core type:");
  });
  it("completes a value token in place", () => {
    expect(applySuggestion("type:fo", "type:folder ")).toBe("type:folder ");
  });
  it("appends when input ends with a space", () => {
    expect(applySuggestion("type:folder ", "section:")).toBe("type:folder section:");
  });
});

interface Row { t: string; tags: string[]; opt: string | null }
const RESOLVERS = {
  type: (r: Row) => r.t,
  tag: (r: Row) => r.tags,
  opt: (r: Row) => r.opt,
};

describe("matchesQualifiers", () => {
  const row: Row = { t: "folder", tags: ["a", "b"], opt: null };
  it("no qualifiers → matches", () => {
    expect(matchesQualifiers(row, [], RESOLVERS)).toBe(true);
  });
  it("single scalar match, case-insensitive", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }], RESOLVERS)).toBe(true);
    expect(matchesQualifiers(row, [{ key: "type", value: "file" }], RESOLVERS)).toBe(false);
  });
  it("AND across qualifiers", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }, { key: "tag", value: "a" }], RESOLVERS)).toBe(true);
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }, { key: "tag", value: "z" }], RESOLVERS)).toBe(false);
  });
  it("array resolver matches any element", () => {
    expect(matchesQualifiers(row, [{ key: "tag", value: "b" }], RESOLVERS)).toBe(true);
  });
  it("empty value is a no-op", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "" }], RESOLVERS)).toBe(true);
  });
  it("null resolver result → no match", () => {
    expect(matchesQualifiers(row, [{ key: "opt", value: "x" }], RESOLVERS)).toBe(false);
  });
  it("unknown key is skipped (defensive)", () => {
    expect(matchesQualifiers(row, [{ key: "nope", value: "x" }], RESOLVERS)).toBe(true);
  });
});

const SPECS: QualifierSpec[] = [
  { key: "type", description: "kind", values: [{ value: "file" }, { value: "folder" }] },
  { key: "section", description: "area", values: [{ value: "core" }, { value: "community" }] },
];

describe("suggest", () => {
  it("empty token → all keys", () => {
    expect(suggest("", SPECS).map((s) => s.insert)).toEqual(["type:", "section:"]);
  });
  it("key prefix filters keys", () => {
    expect(suggest("se", SPECS).map((s) => s.insert)).toEqual(["section:"]);
  });
  it("key: → that key's values, with trailing space", () => {
    expect(suggest("type:", SPECS).map((s) => s.insert)).toEqual(["type:file ", "type:folder "]);
  });
  it("value prefix filters values", () => {
    expect(suggest("section:comm", SPECS).map((s) => s.insert)).toEqual(["section:community "]);
  });
  it("unknown key before colon → no suggestions", () => {
    expect(suggest("bogus:x", SPECS)).toEqual([]);
  });
});

// The vocabulary the user actually types, asserted against the SHIPPED spec lists rather
// than a copy of them — a test that restates the literal agrees with whichever site its author was
// reading and says nothing about the other.
describe("the shipped qualifier vocabulary", () => {
  const syncKeys = SYNC_QUALIFIER_SPECS.map((s) => s.key);
  const settingKeys = SETTING_QUALIFIER_SPECS.map((s) => s.key);

  it("Sync Center: section, never scope", () => {
    expect(syncKeys).toEqual(["type", "section", "action", "mode", "device"]);
    expect(SYNC_QUALIFIER_KEYS.has("section")).toBe(true);
    expect(SYNC_QUALIFIER_KEYS.has("scope")).toBe(false);
  });
  it("settings panel: section, never scope", () => {
    expect(settingKeys).toEqual(["section", "type"]);
    expect(SETTING_QUALIFIER_KEYS.has("section")).toBe(true);
    expect(SETTING_QUALIFIER_KEYS.has("scope")).toBe(false);
  });
  it("every declared key set is derived from its spec list, not restated", () => {
    expect([...SYNC_QUALIFIER_KEYS].sort()).toEqual([...syncKeys].sort());
    expect([...SETTING_QUALIFIER_KEYS].sort()).toEqual([...settingKeys].sort());
  });

  it("Sync Center values: the five presented sections, beta included", () => {
    const section = SYNC_QUALIFIER_SPECS.find((s) => s.key === "section");
    expect(section?.values.map((v) => v.value)).toEqual(["obsidian", "core", "community", "beta", "custom"]);
  });
  it("settings panel values: the six settings areas, plus the one family word that is not an area", () => {
    const section = SETTING_QUALIFIER_SPECS.find((s) => s.key === "section");
    expect(section?.values.map((v) => v.value)).toEqual(["general", "obsidian", "core", "community", "advanced", "custom", "remotes"]);
  });
  // §4: every word the Sync Center offers for an item FAMILY is offered here too — `custom` was the
  // one missing, so the same word answered differently depending on which box you typed it in.
  // Asserted between the two shipped spec lists, not against a copy of either.
  it("both panels offer the same family words (beta aside, which this panel folds into community)", () => {
    const valuesOf = (specs: readonly QualifierSpec[]): string[] => specs.find((s) => s.key === "section")?.values.map((v) => v.value) ?? [];
    const settingValues = valuesOf(SETTING_QUALIFIER_SPECS);
    for (const family of valuesOf(SYNC_QUALIFIER_SPECS).filter((v) => v !== "beta")) {
      expect(settingValues).toContain(family);
    }
  });
  it("type: speaks folder, never dir", () => {
    for (const specs of [SYNC_QUALIFIER_SPECS, SETTING_QUALIFIER_SPECS]) {
      const type = specs.find((s) => s.key === "type");
      expect(type?.values.map((v) => v.value)).toEqual(["file", "folder"]);
      const words = (type?.values ?? []).map((v) => `${v.value} ${v.description ?? ""}`).join(" ");
      expect(words).not.toMatch(/\bdir(ectory|ectories)?\b/i);
    }
  });
});

// NO ALIAS (spec §7, the user's ruling): the retired syntax stops working rather than being quietly
// accepted. `scope:` is not a key in either panel, so it falls through to free text — which is what
// makes the change visible (a search that suddenly finds nothing) instead of silent.
describe("`scope:` is retired in both search bars", () => {
  it("Sync Center: parsed as free text, not as a qualifier", () => {
    expect(parseQuery("scope:community", SYNC_QUALIFIER_KEYS)).toEqual({ text: "scope:community", qualifiers: [] });
    expect(parseQuery("section:community", SYNC_QUALIFIER_KEYS)).toEqual({
      text: "",
      qualifiers: [{ key: "section", value: "community" }],
    });
  });
  it("settings panel: parsed as free text, not as a qualifier", () => {
    expect(parseQuery("scope:advanced", SETTING_QUALIFIER_KEYS)).toEqual({ text: "scope:advanced", qualifiers: [] });
    expect(parseQuery("section:advanced", SETTING_QUALIFIER_KEYS)).toEqual({
      text: "",
      qualifiers: [{ key: "section", value: "advanced" }],
    });
  });
  it("neither autocomplete offers it, at any prefix", () => {
    for (const specs of [SYNC_QUALIFIER_SPECS, SETTING_QUALIFIER_SPECS]) {
      for (const prefix of ["", "s", "sc", "scope"]) {
        expect(suggest(prefix, specs).map((s) => s.insert)).not.toContain("scope:");
      }
      expect(suggest("scope:", specs)).toEqual([]); // no values either — an unknown key has none
      expect(suggest("sec", specs).map((s) => s.insert)).toEqual(["section:"]);
    }
  });
});

describe("sync resolver values", () => {
  it("type: folder → folder, file → file", () => {
    expect(syncTypeValue({ type: "folder" } as never)).toBe("folder");
    expect(syncTypeValue({ type: "file" } as never)).toBe("file");
  });
  it("mode: absent → plain, else the mode", () => {
    expect(syncModeValue({} as never)).toBe("plain");
    expect(syncModeValue({ mode: "fields" } as never)).toBe("fields");
    expect(syncModeValue({ mode: "encrypted" } as never)).toBe("encrypted");
  });
  it("action: fate bucket → PanelFilter bucket, locked → null (bucket-driven, not raw state)", () => {
    expect(syncActionValue("capture")).toBe("capture");
    expect(syncActionValue("apply")).toBe("apply");
    expect(syncActionValue("conflict")).toBe("apply"); // conflict's current placement, preserved
    expect(syncActionValue("ok")).toBe("ok");
    expect(syncActionValue("none")).toBe("none");
    expect(syncActionValue("locked")).toBeNull();
    // "excluded" is a bucket outside this function's fixed
    // capture/apply/ok/none vocabulary (the `action:` qualifier's own value set, GUIDE.md)
    // — same non-match treatment as "locked".
    expect(syncActionValue("excluded")).toBeNull();
  });
});

describe("setting resolver values", () => {
  it("section: plugins & beta → community; sources → remotes; others pass through", () => {
    expect(settingSectionValue({ section: "plugins" })).toEqual(["community"]);
    expect(settingSectionValue({ section: "beta" })).toEqual(["community"]);
    expect(settingSectionValue({ section: "sources" })).toEqual(["remotes"]);
    expect(settingSectionValue({ section: "general" })).toEqual(["general"]);
    expect(settingSectionValue({ section: "obsidian" })).toEqual(["obsidian"]);
    expect(settingSectionValue({ section: "core" })).toEqual(["core"]);
    expect(settingSectionValue({ section: "advanced" })).toEqual(["advanced"]);
  });

  // §4: an Advanced-tab item answers the tab AND its family — and the family word is not this
  // test's invention or the resolver's: both ask `sectionForGroup`, the function the Sync Center's
  // own `section:` resolver calls, so the two search boxes cannot answer differently.
  it("section: a custom rule answers its tab and the family the Sync Center gives it", () => {
    const values = settingSectionValue({ section: "advanced", groupName: "my-rule" });
    expect(values).toContain("advanced");
    expect(values).toContain(sectionForGroup("my-rule"));
  });

  // …and a name whose family is NOT custom says so instead of being labelled custom by position:
  // a store-only entry for a plugin this device does not have renders among the Advanced rules.
  it("section: an Advanced-tab entry that is really a community item answers community, not custom", () => {
    expect(settingSectionValue({ section: "advanced", groupName: "plugin-not-installed" })).toEqual(["advanced", sectionForGroup("plugin-not-installed")]);
  });

  it("type: only on item hits", () => {
    expect(settingTypeValue({ item: { type: "folder" } as never })).toBe("folder");
    expect(settingTypeValue({ item: { type: "file" } as never })).toBe("file");
    expect(settingTypeValue({ item: undefined })).toBeNull();
  });
});

// §3/§4 (spec 2026-08-12-loose-ends-design.md), driven through the REAL index and the REAL resolver
// maps of both panels — not through hand-built hits. `type:folder` answered nothing in the settings
// panel for as long as it has been offered, because the index stamped every item `{type: "file"}`;
// `section:custom` answered in one box and not the other. Both are questions about what the panels
// produce, so both are asked of the producers.
describe("the two search boxes over the same items", () => {
  const ENV: RegistryEnv = {
    cores: [{ id: "graph", name: "Graph view", fileExists: true }],
    plugins: [{ id: "dataview", name: "Dataview" }],
    betaIds: new Set<string>(),
  };
  // An item that is on/off and nothing else — the `defaultPath: null` shape ItemDef declares and
  // itemCard.ts renders ("state-only"). Built by hand because buildItemDefs mints none today; the
  // index still has to answer for it, and "a plugin with no settings file" is not a file.
  const STATE_ONLY: ItemDef = { section: "core", id: "bases", groupName: "bases", label: "Bases", description: "", settingsFile: { defaultPath: null } };
  const FOLDER_RULE: SyncGroup = { name: "my-attachments", path: "Attachments", type: "folder", devices: "all" };
  const FILE_RULE: SyncGroup = { name: "my-vimrc", path: "{configDir}/vimrc.json", type: "file", devices: "all" };
  const DISCOVERED: SyncGroup = { name: "mystery", path: "{configDir}/mystery.json", type: "file", devices: "all", origin: "discovered" };
  const GROUPS = [FOLDER_RULE, FILE_RULE, DISCOVERED];

  interface SettingHit {
    section: string;
    kind: string;
    name: string;
    item?: { type: "file" | "folder" };
    groupName?: string;
  }

  async function settingsHits(): Promise<SettingHit[]> {
    const defs = [...buildItemDefs(ENV), STATE_ONLY];
    const host = {
      settings: { items: itemsIn({}) },
      itemDefs: () => defs,
      installedPluginIds: () => defs.filter((d) => d.groupName.startsWith("plugin-")).map((d) => d.id),
      displayName: (name: string, label?: string) => label ?? name,
      consumePendingSettingsAnchor: () => null,
    };
    const tab = new ConfigSyncSettingTab({} as never, host as never);
    const priv = tab as unknown as { groups: SyncGroup[]; renderGen: number; buildSearchIndex: (gen: number) => Promise<SettingHit[] | null> };
    priv.groups = GROUPS;
    return (await priv.buildSearchIndex(priv.renderGen)) ?? [];
  }

  // The settings panel's own filter, exactly as renderSearchResults runs it.
  function panelAnswers(hits: SettingHit[], query: string): string[] {
    const parsed = parseQuery(query, SETTING_QUALIFIER_KEYS);
    return hits.filter((h) => matchesQualifiers(h as never, parsed.qualifiers, SETTING_QUALIFIER_RESOLVERS)).map((h) => h.name);
  }

  // The Sync Center's own filter, over the same groups, through the view's real resolver map.
  function centerAnswers(query: string): string[] {
    const view = new SyncCenterView({} as never, { itemRefForGroup: () => null } as never);
    const priv = view as unknown as { groups: SyncGroup[]; syncResolvers: () => Record<string, QualifierResolver<{ group: SyncGroup }>> };
    priv.groups = GROUPS;
    const resolvers = priv.syncResolvers();
    const parsed = parseQuery(query, SYNC_QUALIFIER_KEYS);
    return GROUPS.filter((g) => matchesQualifiers({ group: g }, parsed.qualifiers, resolvers)).map((g) => g.name);
  }

  it("§3: an item that is a folder answers type:folder — and stops answering type:file", async () => {
    const hits = await settingsHits();

    expect(panelAnswers(hits, "type:folder")).toContain(FOLDER_RULE.name);
    expect(panelAnswers(hits, "type:file")).not.toContain(FOLDER_RULE.name);
    expect(panelAnswers(hits, "type:file")).toContain(FILE_RULE.name);
  });

  it("§3: every hit's type is the one the Sync Center reads off the same group", async () => {
    const hits = await settingsHits();
    const byName = new Map(hits.map((h) => [h.name, h]));

    for (const g of GROUPS) {
      const hit = byName.get(g.name);
      expect(hit, `no search hit for ${g.name}`).toBeDefined();
      // Producer against producer: settingTypeValue is what the settings panel answers with,
      // syncTypeValue what the Sync Center answers with, and a blanket "file" in the index made
      // them disagree for every folder item without either side looking wrong on its own.
      expect(settingTypeValue(hit as never)).toBe(syncTypeValue(g));
    }
  });

  it("§3: an on/off-only item claims neither type — it has no file to be one", async () => {
    const hits = await settingsHits();

    expect(hits.map((h) => h.name)).toContain(STATE_ONLY.label); // indexed, and findable by name
    expect(panelAnswers(hits, "type:file")).not.toContain(STATE_ONLY.label);
    expect(panelAnswers(hits, "type:folder")).not.toContain(STATE_ONLY.label);
  });

  it("§4: section:custom finds the custom rule in BOTH boxes", async () => {
    const hits = await settingsHits();

    expect(centerAnswers("section:custom")).toContain(FOLDER_RULE.name); // as it already did
    expect(panelAnswers(hits, "section:custom")).toContain(FOLDER_RULE.name); // and now here too
  });

  it("§4: section:advanced still means that tab — every item it renders", async () => {
    const hits = await settingsHits();
    const advanced = panelAnswers(hits, "section:advanced");

    for (const g of GROUPS) expect(advanced).toContain(g.name);
    // …and the tab's word is not the family's: a card item is on no Advanced tab.
    expect(advanced).not.toContain("Graph view");
  });
});
