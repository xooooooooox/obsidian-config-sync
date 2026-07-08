import { describe, expect, it } from "vitest";
import { sanitizeJson, mergePreservingSanitized } from "../src/core/sanitize";

describe("sanitizeJson", () => {
  it("drops keys matching patterns at any depth, including inside arrays", () => {
    const input = {
      userEmail: "a@b.c",
      nested: { feishuAppSecret: "s", keep: 1 },
      list: [{ airtableAPIKey: "k", ok: true }],
    };
    expect(sanitizeJson(input, ["*Secret*", "*APIKey*", "userEmail"])).toEqual({
      nested: { keep: 1 },
      list: [{ ok: true }],
    });
  });
  it("treats * as wildcard and other regex metachars literally", () => {
    expect(sanitizeJson({ "a.b": 1, axb: 2 }, ["a.b"])).toEqual({ axb: 2 });
  });
});

describe("mergePreservingSanitized", () => {
  const patterns = ["*Token*", "userEmail"];
  it("keeps local values for sanitized keys and takes incoming for the rest", () => {
    const local = { userEmail: "me@x.y", vikaToken: "t", theme: "old", nested: { apiTokenX: "n", other: 1 } };
    const incoming = { theme: "new", nested: { other: 2 } };
    expect(mergePreservingSanitized(local, incoming, patterns)).toEqual({
      theme: "new",
      nested: { other: 2, apiTokenX: "n" },
      userEmail: "me@x.y",
      vikaToken: "t",
    });
  });
  it("drops non-sanitized local keys that the store no longer has", () => {
    expect(mergePreservingSanitized({ removed: 1 }, {}, patterns)).toEqual({});
  });
  it("returns incoming when local content is not an object", () => {
    expect(mergePreservingSanitized("bad", { a: 1 }, patterns)).toEqual({ a: 1 });
  });
  it("preserves sanitized keys inside arrays index-wise", () => {
    const local = { list: [{ apiTokenX: "secret", other: 1 }] };
    const incoming = { list: [{ other: 2 }] };
    expect(mergePreservingSanitized(local, incoming, patterns)).toEqual({ list: [{ other: 2, apiTokenX: "secret" }] });
  });
});
