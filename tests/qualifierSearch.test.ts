import { describe, expect, it } from "vitest";
import { parseQuery, applySuggestion, matchesQualifiers, suggest, type QualifierSpec } from "../src/ui/qualifierSearch";
import { syncTypeValue, syncModeValue, syncActionValue, SYNC_QUALIFIER_SPECS, SYNC_QUALIFIER_KEYS } from "../src/ui/SyncCenterView";
import { settingSectionValue, settingTypeValue, SETTING_QUALIFIER_SPECS, SETTING_QUALIFIER_KEYS } from "../src/ui/SettingTab";

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

// The vocabulary the user actually types (spec §7), asserted against the SHIPPED spec lists rather
// than a copy of them — a test that restates the literal agrees with whichever site its author was
// reading and says nothing about the other (task-1 NEW-I2).
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
  it("settings panel values: the six settings areas", () => {
    const section = SETTING_QUALIFIER_SPECS.find((s) => s.key === "section");
    expect(section?.values.map((v) => v.value)).toEqual(["general", "obsidian", "core", "community", "advanced", "remotes"]);
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
  it("action: fate bucket → PanelFilter bucket, locked → null (ledger C-#23: bucket-driven, not raw state)", () => {
    expect(syncActionValue("capture")).toBe("capture");
    expect(syncActionValue("apply")).toBe("apply");
    expect(syncActionValue("conflict")).toBe("apply"); // conflict's current placement, preserved
    expect(syncActionValue("ok")).toBe("ok");
    expect(syncActionValue("none")).toBe("none");
    expect(syncActionValue("locked")).toBeNull();
    // C-#45 §7 (fix-round 4): "excluded" is a new bucket outside this function's fixed
    // capture/apply/ok/none vocabulary (the `action:` qualifier's own value set, GUIDE.md,
    // is unchanged by §7) — same non-match treatment as "locked", not a regression.
    expect(syncActionValue("excluded")).toBeNull();
  });
});

describe("setting resolver values", () => {
  it("section: plugins & beta → community; sources → remotes; others pass through", () => {
    expect(settingSectionValue("plugins")).toBe("community");
    expect(settingSectionValue("beta")).toBe("community");
    expect(settingSectionValue("sources")).toBe("remotes");
    expect(settingSectionValue("general")).toBe("general");
    expect(settingSectionValue("obsidian")).toBe("obsidian");
    expect(settingSectionValue("core")).toBe("core");
    expect(settingSectionValue("advanced")).toBe("advanced");
  });
  it("type: only on item hits", () => {
    expect(settingTypeValue({ item: { type: "folder" } as never })).toBe("folder");
    expect(settingTypeValue({ item: { type: "file" } as never })).toBe("file");
    expect(settingTypeValue({ item: undefined })).toBeNull();
  });
});
