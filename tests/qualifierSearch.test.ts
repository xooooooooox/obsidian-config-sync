import { describe, expect, it } from "vitest";
import { parseQuery, applySuggestion } from "../src/ui/qualifierSearch";

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
