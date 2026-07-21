import { describe, expect, it } from "vitest";
import { parseQuery, applySuggestion, matchesQualifiers, suggest, type QualifierSpec } from "../src/ui/qualifierSearch";
import { syncTypeValue, syncModeValue, syncActionValue } from "../src/ui/SyncCenterView";

const KEYS = new Set(["type", "scope", "action", "mode", "device"]);

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
    expect(parseQuery("snippets scope:community type:folder", KEYS)).toEqual({
      text: "snippets",
      qualifiers: [{ key: "scope", value: "community" }, { key: "type", value: "folder" }],
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
    expect(parseQuery('scope:"a b" plain', KEYS)).toEqual({
      text: "plain",
      qualifiers: [{ key: "scope", value: "a b" }],
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
    expect(applySuggestion("scope:core ty", "type:")).toBe("scope:core type:");
  });
  it("completes a value token in place", () => {
    expect(applySuggestion("type:fo", "type:folder ")).toBe("type:folder ");
  });
  it("appends when input ends with a space", () => {
    expect(applySuggestion("type:folder ", "scope:")).toBe("type:folder scope:");
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
  { key: "scope", description: "area", values: [{ value: "core" }, { value: "community" }] },
];

describe("suggest", () => {
  it("empty token → all keys", () => {
    expect(suggest("", SPECS).map((s) => s.insert)).toEqual(["type:", "scope:"]);
  });
  it("key prefix filters keys", () => {
    expect(suggest("sc", SPECS).map((s) => s.insert)).toEqual(["scope:"]);
  });
  it("key: → that key's values, with trailing space", () => {
    expect(suggest("type:", SPECS).map((s) => s.insert)).toEqual(["type:file ", "type:folder "]);
  });
  it("value prefix filters values", () => {
    expect(suggest("scope:comm", SPECS).map((s) => s.insert)).toEqual(["scope:community "]);
  });
  it("unknown key before colon → no suggestions", () => {
    expect(suggest("bogus:x", SPECS)).toEqual([]);
  });
});

describe("sync resolver values", () => {
  it("type: dir → folder, file → file", () => {
    expect(syncTypeValue({ type: "dir" } as never)).toBe("folder");
    expect(syncTypeValue({ type: "file" } as never)).toBe("file");
  });
  it("mode: absent → plain, else the mode", () => {
    expect(syncModeValue({} as never)).toBe("plain");
    expect(syncModeValue({ mode: "fields" } as never)).toBe("fields");
    expect(syncModeValue({ mode: "encrypted" } as never)).toBe("encrypted");
  });
  it("action: state → PanelFilter bucket, locked → null", () => {
    expect(syncActionValue("local-changed")).toBe("capture");
    expect(syncActionValue("not-captured")).toBe("capture");
    expect(syncActionValue("store-newer")).toBe("apply");
    expect(syncActionValue("differs")).toBe("apply");
    expect(syncActionValue("in-sync")).toBe("ok");
    expect(syncActionValue("no-settings")).toBe("none");
    expect(syncActionValue("locked")).toBeNull();
  });
});
