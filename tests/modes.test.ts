import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged, scanSensitive, groupNeedsPassphrase } from "../src/core/modes";
import { isFieldEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { SyncGroup } from "../src/core/types";

describe("scanSensitive", () => {
  it("finds sensitive-looking keys recursively, case-insensitive", () => {
    const s = scanSensitive(JSON.stringify({ updateAPIKey: "x", nested: { myToken: "y", plain: 1 }, userEmail: "e" }));
    expect(s.keys.sort()).toEqual(["myToken", "updateAPIKey", "userEmail"]);
    expect(s.blob).toBe(false);
  });

  it("detects an opaque blob: one string >=1024 chars making >80% of the file", () => {
    const s = scanSensitive(JSON.stringify({ readme: "hi", d: "A".repeat(5000) }));
    expect(s.blob).toBe(true);
  });

  it("non-JSON content scans clean", () => {
    expect(scanSensitive("body { color: red }")).toEqual({ keys: [], blob: false });
  });

  it("auth does not match author*, still matches real auth keys", () => {
    const s = scanSensitive(JSON.stringify({ author: "x", authorUrl: "y", authors: ["a"], oauth: "t", authToken: "z", auth_key: "k" }));
    expect(s.keys.sort()).toEqual(["authToken", "auth_key", "oauth"]);
  });
});

describe("groupNeedsPassphrase", () => {
  const base = { name: "g", path: "{configDir}/x.json", type: "file", devices: "all" } as unknown as SyncGroup;
  it("true for encrypted mode and for fields with an encrypt action", () => {
    expect(groupNeedsPassphrase({ ...base, mode: "encrypted" })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "encrypt" }] })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "strip" }] })).toBe(false);
    expect(groupNeedsPassphrase(base)).toBe(false);
  });
});

describe("captureTransform / applyTransform round-trip", () => {
  const group = (over: object): SyncGroup =>
    ({ name: "g", path: "{configDir}/x.json", type: "file", devices: "all", ...over }) as unknown as SyncGroup;
  const src = JSON.stringify({ updateAPIKey: "tok", userEmail: "e@x", theme: "dark" }, null, 2);

  it("fields mode strips and encrypts, and apply restores the exact original", async () => {
    const g = group({ mode: "fields", fields: [
      { pattern: "updateAPIKey", action: "encrypt" },
      { pattern: "userEmail", action: "strip" },
    ]});
    const cap = await captureTransform(g, src, "pw");
    expect(cap.note).toBe("encrypted updateAPIKey · stripped userEmail");
    const stored = JSON.parse(cap.content) as Record<string, unknown>;
    expect(isFieldEnvelope(stored["updateAPIKey"])).toBe(true);
    expect(stored["userEmail"]).toBeUndefined();
    expect(stored["theme"]).toBe("dark");
    const restored = await applyTransform(g, cap.content, src, "pw");
    expect(JSON.parse(restored)).toEqual(JSON.parse(src));
    expect(await contentUnchanged(g, src, cap.content, "pw")).toBe(true);
    const changed = JSON.stringify({ updateAPIKey: "tok2", userEmail: "e@x", theme: "dark" }, null, 2);
    expect(await contentUnchanged(g, changed, cap.content, "pw")).toBe(false);
  });

  it("fields mode: a store copy that still holds a stripped key compares equal (apply keeps local)", async () => {
    // The store was captured before the strip rule existed, so it retains the stripped key.
    // Apply keeps the local value for stripped keys, so this is effectively in sync — not a diff.
    const g = group({ mode: "fields", fields: [{ pattern: "enabledCssSnippets", action: "strip" }] });
    const local = JSON.stringify({ theme: "dark", enabledCssSnippets: ["a", "b"] }, null, 2);
    const staleStore = JSON.stringify({ theme: "dark", enabledCssSnippets: ["x"] }, null, 2);
    expect(await contentUnchanged(g, local, staleStore, "pw")).toBe(true);
    // A genuine difference in a non-stripped field is still detected.
    const changedStore = JSON.stringify({ theme: "light", enabledCssSnippets: ["x"] }, null, 2);
    expect(await contentUnchanged(g, local, changedStore, "pw")).toBe(false);
  });

  it("encrypted mode round-trips and compares", async () => {
    const g = group({ mode: "encrypted" });
    const cap = await captureTransform(g, src, "pw");
    expect(cap.note).toBe("whole file encrypted");
    expect(parseFileEnvelope(cap.content)).not.toBeNull();
    expect(await applyTransform(g, cap.content, null, "pw")).toBe(src);
    expect(await contentUnchanged(g, src, cap.content, "pw")).toBe(true);
  });

  it("throws PassphraseNeededError without a passphrase", async () => {
    const g = group({ mode: "encrypted" });
    await expect(captureTransform(g, src, null)).rejects.toThrowError(
      "passphrase not set on this device — Settings → General"
    );
  });
});
