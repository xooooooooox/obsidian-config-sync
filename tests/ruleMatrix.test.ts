import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { decryptField, isFieldEnvelope } from "../src/core/crypto";
import { validateSyncManifest, ManifestValidationError } from "../src/core/manifest";
import { SyncGroup, EVERYWHERE, THIS_DEVICE, perClass } from "../src/core/types";

// Orthogonal rule model (spec 2026-07-25-unified-card-design.md, D1): one test per
// {scope, encrypted} matrix cell — capture placement, encrypted-cell ciphertext, and apply
// round-trips on both device classes.

const PASSPHRASE = "correct horse battery staple";

const GROUP: SyncGroup = {
  name: "app",
  path: "{configDir}/app.json",
  type: "file",
  devices: "all",
  mode: "fields",
  fields: [
    { pattern: "keyAll", sharing: EVERYWHERE, encrypted: false },
    { pattern: "keyAllEnc", sharing: EVERYWHERE, encrypted: true },
    { pattern: "keyDesktop", sharing: perClass("desktop"), encrypted: false },
    { pattern: "keyDesktopEnc", sharing: perClass("desktop"), encrypted: true },
    { pattern: "keyMobile", sharing: perClass("mobile"), encrypted: false },
    { pattern: "keyMobileEnc", sharing: perClass("mobile"), encrypted: true },
    { pattern: "keyLocal", sharing: THIS_DEVICE, encrypted: false },
  ],
};

const LOCAL_VALUES = {
  keyAll: "a-plain",
  keyAllEnc: "a-secret",
  keyDesktop: "d-plain",
  keyDesktopEnc: "d-secret",
  keyMobile: "m-plain",
  keyMobileEnc: "m-secret",
  keyLocal: "loc-plain",
};

const LOCAL_CONTENT = JSON.stringify(LOCAL_VALUES);

async function decrypt(envelope: unknown): Promise<string> {
  expect(typeof envelope).toBe("string");
  expect(isFieldEnvelope(envelope as string)).toBe(true);
  return JSON.parse(await decryptField(PASSPHRASE, envelope as string, "app")) as string;
}

describe("rule matrix — capture placement", () => {
  it("scope=all, encrypted=false: plaintext in the common base", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(base.keyAll).toBe("a-plain");
  });

  it("scope=all, encrypted=true: ciphertext in the common base, decryptable", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(base.keyAllEnc).not.toBe("a-secret");
    expect(await decrypt(base.keyAllEnc)).toBe("a-secret");
  });

  it("scope=desktop, encrypted=false: plaintext in the desktop sidecar on capture from desktop", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(sidecar.keyDesktop).toBe("d-plain");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(base).not.toHaveProperty("keyDesktop");
  });

  it("scope=desktop, encrypted=true: ciphertext in the desktop sidecar, decryptable", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(sidecar.keyDesktopEnc).not.toBe("d-secret");
    expect(await decrypt(sidecar.keyDesktopEnc)).toBe("d-secret");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(base).not.toHaveProperty("keyDesktopEnc");
  });

  it("scope=desktop, encrypted=true: capture note marks the key encrypted, not just desktop-only", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    expect(t.note).toContain("desktop-only");
    expect(t.note).toContain("keyDesktopEnc (encrypted)");
    expect(t.note).toContain("keyDesktop,"); // plaintext desktop-only key stays bare, no "(encrypted)"
    expect(t.note).not.toContain("keyDesktop (encrypted)");
  });

  it("scope=mobile, encrypted=false: plaintext in the mobile sidecar on capture from mobile", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "mobile");
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(sidecar.keyMobile).toBe("m-plain");
  });

  it("scope=mobile, encrypted=true: ciphertext in the mobile sidecar, decryptable", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "mobile");
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(sidecar.keyMobileEnc).not.toBe("m-secret");
    expect(await decrypt(sidecar.keyMobileEnc)).toBe("m-secret");
  });

  it("desktop capture drops mobile-scoped keys entirely (own-class sidecar only carries own keys)", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(base).not.toHaveProperty("keyMobile");
    expect(base).not.toHaveProperty("keyMobileEnc");
    expect(sidecar).not.toHaveProperty("keyMobile");
    expect(sidecar).not.toHaveProperty("keyMobileEnc");
  });

  it("scope=local, encrypted=false: dropped from the store entirely (base and sidecar)", async () => {
    const t = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    const sidecar = JSON.parse(t.ownScope as string) as Record<string, unknown>;
    expect(base).not.toHaveProperty("keyLocal");
    expect(sidecar).not.toHaveProperty("keyLocal");
  });
});

describe("rule matrix — apply round-trips", () => {
  it("desktop apply reconstructs local exactly from desktop's own capture", async () => {
    const captured = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const out = JSON.parse(
      await applyTransform(GROUP, captured.content, LOCAL_CONTENT, PASSPHRASE, "desktop", captured.ownScope)
    ) as Record<string, unknown>;
    // own class (desktop): sidecar value decrypted back to plaintext
    expect(out.keyDesktop).toBe("d-plain");
    expect(out.keyDesktopEnc).toBe("d-secret");
    // all-scoped: round-trips through the common base
    expect(out.keyAll).toBe("a-plain");
    expect(out.keyAllEnc).toBe("a-secret");
    // other class (mobile) and local: preserved from local, never came from the store
    expect(out.keyMobile).toBe("m-plain");
    expect(out.keyMobileEnc).toBe("m-secret");
    expect(out.keyLocal).toBe("loc-plain");
  });

  it("mobile apply reconstructs local exactly from mobile's own capture", async () => {
    const captured = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "mobile");
    const out = JSON.parse(
      await applyTransform(GROUP, captured.content, LOCAL_CONTENT, PASSPHRASE, "mobile", captured.ownScope)
    ) as Record<string, unknown>;
    expect(out.keyMobile).toBe("m-plain");
    expect(out.keyMobileEnc).toBe("m-secret");
    expect(out.keyAll).toBe("a-plain");
    expect(out.keyAllEnc).toBe("a-secret");
    expect(out.keyDesktop).toBe("d-plain");
    expect(out.keyDesktopEnc).toBe("d-secret");
    expect(out.keyLocal).toBe("loc-plain");
  });

  it("applying a desktop capture on a mobile device (no mobile sidecar) preserves all class-scoped keys locally", async () => {
    const captured = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    const out = JSON.parse(
      await applyTransform(GROUP, captured.content, LOCAL_CONTENT, PASSPHRASE, "mobile", null)
    ) as Record<string, unknown>;
    // all-scoped keys still come from the store base
    expect(out.keyAll).toBe("a-plain");
    expect(out.keyAllEnc).toBe("a-secret");
    // both desktop (other class) and mobile (own class, no sidecar) keys are preserved from local
    expect(out.keyDesktop).toBe("d-plain");
    expect(out.keyDesktopEnc).toBe("d-secret");
    expect(out.keyMobile).toBe("m-plain");
    expect(out.keyMobileEnc).toBe("m-secret");
    expect(out.keyLocal).toBe("loc-plain");
  });

  it("contentUnchanged is true right after a matched capture, and false after a local edit to an own-class encrypted key", async () => {
    const captured = await captureTransform(GROUP, LOCAL_CONTENT, PASSPHRASE, "desktop");
    expect(await contentUnchanged(GROUP, LOCAL_CONTENT, captured.content, PASSPHRASE, "desktop", captured.ownScope)).toBe(true);
    const edited = JSON.stringify({ ...LOCAL_VALUES, keyDesktopEnc: "changed" });
    expect(await contentUnchanged(GROUP, edited, captured.content, PASSPHRASE, "desktop", captured.ownScope)).toBe(false);
  });
});

describe("rule matrix — manifest validation", () => {
  const BASE = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };

  it("accepts all 7 legal scope×encrypted combinations", () => {
    const fields = [
      { pattern: "a", sharing: EVERYWHERE, encrypted: false },
      { pattern: "b", sharing: EVERYWHERE, encrypted: true },
      { pattern: "c", sharing: perClass("desktop"), encrypted: false },
      { pattern: "d", sharing: perClass("desktop"), encrypted: true },
      { pattern: "e", sharing: perClass("mobile"), encrypted: false },
      { pattern: "f", sharing: perClass("mobile"), encrypted: true },
      { pattern: "g", sharing: THIS_DEVICE, encrypted: false },
    ];
    const m = validateSyncManifest({ version: 1, groups: [{ ...BASE, mode: "fields", fields }] });
    expect(m.groups[0]?.fields).toEqual(fields);
  });

  it("rejects a this-device sharing combined with encrypted=true, naming the key and both facts", () => {
    const fields = [{ pattern: "myKey", sharing: THIS_DEVICE, encrypted: true }];
    expect(() => validateSyncManifest({ version: 1, groups: [{ ...BASE, mode: "fields", fields }] })).toThrow(
      /myKey.*This device.*encrypt/
    );
  });

  it("rejects an unknown scope", () => {
    const fields = [{ pattern: "a", scope: "tablet", encrypted: false }];
    expect(() => validateSyncManifest({ version: 1, groups: [{ ...BASE, mode: "fields", fields }] })).toThrow(ManifestValidationError);
  });
});
