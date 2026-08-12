import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged, scanSensitive, groupNeedsPassphrase, isWholeFileEncrypted } from "../src/core/modes";
import { isFieldEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { groupForItem, SELF_GROUP_NAME } from "../src/core/catalog";
import { SyncGroup, EVERYWHERE, THIS_DEVICE, perClass } from "../src/core/types";

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
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", sharing: EVERYWHERE, encrypted: true }] })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", sharing: THIS_DEVICE, encrypted: false }] })).toBe(false);
    expect(groupNeedsPassphrase(base)).toBe(false);
  });
});

// Regression (Task 2 review, Finding 1): the Sync Center's diff panel must suppress a raw
// plaintext-vs-ciphertext diff for a Plain group with fileRule.encrypted:true, the same way it
// already does for mode:"encrypted".
describe("isWholeFileEncrypted", () => {
  const base = { name: "g", path: "{configDir}/x.json", type: "file", devices: "all" } as unknown as SyncGroup;
  it("true for mode:\"encrypted\"", () => {
    expect(isWholeFileEncrypted({ ...base, mode: "encrypted" })).toBe(true);
  });
  it("true for a Plain group with fileRule.encrypted:true", () => {
    expect(isWholeFileEncrypted({ ...base, fileRule: { sharing: EVERYWHERE, encrypted: true } })).toBe(true);
  });
  it("false for a Plain group with fileRule.encrypted:false", () => {
    expect(isWholeFileEncrypted({ ...base, fileRule: { sharing: EVERYWHERE, encrypted: false } })).toBe(false);
  });
  it("false for a plain group with no fileRule, and for mode:\"fields\"", () => {
    expect(isWholeFileEncrypted(base)).toBe(false);
    expect(isWholeFileEncrypted({ ...base, mode: "fields", fields: [{ pattern: "a", sharing: EVERYWHERE, encrypted: true }] })).toBe(false);
  });
});

describe("captureTransform / applyTransform round-trip", () => {
  const group = (over: object): SyncGroup =>
    ({ name: "g", path: "{configDir}/x.json", type: "file", devices: "all", ...over }) as unknown as SyncGroup;
  const src = JSON.stringify({ updateAPIKey: "tok", userEmail: "e@x", theme: "dark" }, null, 2);

  it("fields mode strips and encrypts, and apply restores the exact original", async () => {
    const g = group({ mode: "fields", fields: [
      { pattern: "updateAPIKey", sharing: EVERYWHERE, encrypted: true },
      { pattern: "userEmail", sharing: THIS_DEVICE, encrypted: false },
    ]});
    const cap = await captureTransform(g, src, "pw", "desktop");
    expect(cap.note).toBe("encrypted updateAPIKey · stripped userEmail");
    const stored = JSON.parse(cap.content) as Record<string, unknown>;
    expect(isFieldEnvelope(stored["updateAPIKey"])).toBe(true);
    expect(stored["userEmail"]).toBeUndefined();
    expect(stored["theme"]).toBe("dark");
    const restored = await applyTransform(g, cap.content, src, "pw", "desktop", null);
    expect(JSON.parse(restored)).toEqual(JSON.parse(src));
    expect(await contentUnchanged(g, src, cap.content, "pw", "desktop", null)).toBe(true);
    const changed = JSON.stringify({ updateAPIKey: "tok2", userEmail: "e@x", theme: "dark" }, null, 2);
    expect(await contentUnchanged(g, changed, cap.content, "pw", "desktop", null)).toBe(false);
  });

  it("fields mode: a store copy that still holds a stripped key compares equal (apply keeps local)", async () => {
    // The store was captured before the strip rule existed, so it retains the stripped key.
    // Apply keeps the local value for stripped keys, so this is effectively in sync — not a diff.
    const g = group({ mode: "fields", fields: [{ pattern: "enabledCssSnippets", sharing: THIS_DEVICE, encrypted: false }] });
    const local = JSON.stringify({ theme: "dark", enabledCssSnippets: ["a", "b"] }, null, 2);
    const staleStore = JSON.stringify({ theme: "dark", enabledCssSnippets: ["x"] }, null, 2);
    expect(await contentUnchanged(g, local, staleStore, "pw", "desktop", null)).toBe(true);
    // A genuine difference in a non-stripped field is still detected.
    const changedStore = JSON.stringify({ theme: "light", enabledCssSnippets: ["x"] }, null, 2);
    expect(await contentUnchanged(g, local, changedStore, "pw", "desktop", null)).toBe(false);
  });

  it("encrypted mode round-trips and compares", async () => {
    const g = group({ mode: "encrypted" });
    const cap = await captureTransform(g, src, "pw", "desktop");
    expect(cap.note).toBe("whole file encrypted");
    expect(parseFileEnvelope(cap.content)).not.toBeNull();
    expect(await applyTransform(g, cap.content, null, "pw", "desktop", null)).toBe(src);
    expect(await contentUnchanged(g, src, cap.content, "pw", "desktop", null)).toBe(true);
  });

  it("throws PassphraseNeededError without a passphrase", async () => {
    const g = group({ mode: "encrypted" });
    await expect(captureTransform(g, src, null, "desktop")).rejects.toThrowError(
      "passphrase not set on this device — Settings → General"
    );
  });

  it("self item strips thisDeviceItems on capture and restores it on apply", async () => {
    const g = groupForItem(SELF_GROUP_NAME, "{configDir}/plugins/config-sync/data.json", "file", null);
    const local = JSON.stringify({ schemaVersion: 3, remotes: [], items: {}, thisDeviceItems: ["community/remotely-save"] });
    const stored = await captureTransform(g, local, null, "desktop", null);
    expect((JSON.parse(stored.content) as Record<string, unknown>).thisDeviceItems).toBeUndefined();
    const applied = await applyTransform(g, stored.content, local, null, "desktop", null);
    expect((JSON.parse(applied) as Record<string, unknown>).thisDeviceItems).toEqual(["community/remotely-save"]);
  });
});

// C-#36: an encrypted field whose plaintext hasn't changed must reuse its existing store envelope
// byte-for-byte (fieldUnchanged's mac decides "unchanged") — every encryption otherwise draws a
// fresh salt/IV (crypto.ts), so re-encrypting an unchanged field makes it masquerade as a change.
// captureTransform is the single function both the real capture write (ConfigSyncCore.ts) and the
// Sync Center's capture-preview diff (main.ts's diffPair) call the same way, so fixing it here
// fixes both — this suite is the byte-identical proof for that shared path.
describe("captureTransform: unchanged encrypted fields keep their envelopes (C-#36)", () => {
  const group = (over: object): SyncGroup =>
    ({ name: "g", path: "{configDir}/x.json", type: "file", devices: "all", ...over }) as unknown as SyncGroup;

  it("scope:all + encrypted field: two captures over unchanged content are byte-identical (no envelope churn)", async () => {
    const g = group({
      mode: "fields",
      fields: [
        { pattern: "token", sharing: EVERYWHERE, encrypted: true },
        { pattern: "apiKey", sharing: EVERYWHERE, encrypted: true },
      ],
    });
    const src = JSON.stringify({ token: "t1", apiKey: "k1", plain: "v1" });
    const cap1 = await captureTransform(g, src, "pw", "desktop");
    const cap2 = await captureTransform(g, src, "pw", "desktop", cap1.content);
    expect(cap2.content).toBe(cap1.content); // byte-identical: both envelopes reused, not re-encrypted
  });

  it("changing one plaintext re-encrypts only that field's envelope; the other's stays byte-identical", async () => {
    const g = group({
      mode: "fields",
      fields: [
        { pattern: "token", sharing: EVERYWHERE, encrypted: true },
        { pattern: "apiKey", sharing: EVERYWHERE, encrypted: true },
      ],
    });
    const src = JSON.stringify({ token: "t1", apiKey: "k1", plain: "v1" });
    const cap1 = await captureTransform(g, src, "pw", "desktop");
    // Only "plain" (unrelated, unencrypted) changes — mirrors the live BRAT bug: the real diff
    // was pluginSubListFrozenVersion, not the encrypted token fields.
    const changed = JSON.stringify({ token: "t1", apiKey: "k1", plain: "v2" });
    const cap2 = await captureTransform(g, changed, "pw", "desktop", cap1.content);
    const stored1 = JSON.parse(cap1.content) as Record<string, unknown>;
    const stored2 = JSON.parse(cap2.content) as Record<string, unknown>;
    expect(stored2["token"]).toBe(stored1["token"]); // envelope byte-identical, not just plaintext-equal
    expect(stored2["apiKey"]).toBe(stored1["apiKey"]);
    expect(stored2["plain"]).toBe("v2");
    const applied = await applyTransform(g, cap2.content, changed, "pw", "desktop", null);
    expect(JSON.parse(applied)).toEqual(JSON.parse(changed));
  });

  it("a changed encrypted plaintext produces exactly one new envelope for that field", async () => {
    const g = group({
      mode: "fields",
      fields: [
        { pattern: "token", sharing: EVERYWHERE, encrypted: true },
        { pattern: "apiKey", sharing: EVERYWHERE, encrypted: true },
      ],
    });
    const src = JSON.stringify({ token: "t1", apiKey: "k1" });
    const cap1 = await captureTransform(g, src, "pw", "desktop");
    const changed = JSON.stringify({ token: "t2", apiKey: "k1" });
    const cap2 = await captureTransform(g, changed, "pw", "desktop", cap1.content);
    const stored1 = JSON.parse(cap1.content) as Record<string, unknown>;
    const stored2 = JSON.parse(cap2.content) as Record<string, unknown>;
    expect(stored2["token"]).not.toBe(stored1["token"]); // plaintext changed: new envelope
    expect(stored2["apiKey"]).toBe(stored1["apiKey"]); // untouched: reused
    const applied = await applyTransform(g, cap2.content, changed, "pw", "desktop", null);
    expect(JSON.parse(applied)).toEqual(JSON.parse(changed));
  });

  it("with no prior store content, always encrypts fresh (nothing to reuse — first capture)", async () => {
    const g = group({ mode: "fields", fields: [{ pattern: "token", sharing: EVERYWHERE, encrypted: true }] });
    const src = JSON.stringify({ token: "t1" });
    const cap = await captureTransform(g, src, "pw", "desktop", null);
    expect(isFieldEnvelope((JSON.parse(cap.content) as Record<string, unknown>)["token"])).toBe(true);
  });

  it("class-scoped (desktop/mobile) + encrypted field: unchanged reuses the sidecar's envelope", async () => {
    const g = group({ mode: "fields", fields: [{ pattern: "secret", sharing: perClass("desktop"), encrypted: true }] });
    const src = JSON.stringify({ secret: "s1", plain: "v1" });
    const cap1 = await captureTransform(g, src, "pw", "desktop");
    expect(cap1.ownScope).not.toBeNull();
    const changed = JSON.stringify({ secret: "s1", plain: "v2" });
    const cap2 = await captureTransform(g, changed, "pw", "desktop", cap1.content, cap1.ownScope);
    const scope1 = JSON.parse(cap1.ownScope as string) as Record<string, unknown>;
    const scope2 = JSON.parse(cap2.ownScope as string) as Record<string, unknown>;
    expect(scope2["secret"]).toBe(scope1["secret"]); // sidecar envelope reused byte-for-byte
  });

  it("class-scoped + encrypted field: a changed plaintext gets a new sidecar envelope", async () => {
    const g = group({ mode: "fields", fields: [{ pattern: "secret", sharing: perClass("desktop"), encrypted: true }] });
    const src = JSON.stringify({ secret: "s1" });
    const cap1 = await captureTransform(g, src, "pw", "desktop");
    const changed = JSON.stringify({ secret: "s2" });
    const cap2 = await captureTransform(g, changed, "pw", "desktop", cap1.content, cap1.ownScope);
    const scope1 = JSON.parse(cap1.ownScope as string) as Record<string, unknown>;
    const scope2 = JSON.parse(cap2.ownScope as string) as Record<string, unknown>;
    expect(scope2["secret"]).not.toBe(scope1["secret"]);
  });
});
