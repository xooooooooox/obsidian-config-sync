import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged, PassphraseNeededError } from "../src/core/modes";
import { isFileEnvelope, parseFileEnvelope } from "../src/core/crypto";
import { validateSyncManifest, ManifestValidationError } from "../src/core/manifest";
import { SyncGroup, EVERYWHERE, THIS_DEVICE, perClass } from "../src/core/types";
import { apply, capture, CoreContext, overlayGroup } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

// Plain whole-file encryption + FileRule (spec 2026-07-25-unified-card-design.md §2):
// a Plain single-file group can carry `fileRule: {scope, encrypted}`. encrypted:true means
// the STORE copy is an encryption envelope (same crypto pipeline as mode:"encrypted"); the local
// disk copy stays plaintext. No "local" scope at the file level.

const PASSPHRASE = "correct horse battery staple";

const PLAIN_ENCRYPTED_GROUP: SyncGroup = {
  name: "secrets",
  path: "{configDir}/secrets.json",
  type: "file",
  devices: "all",
  fileRule: { sharing: EVERYWHERE, encrypted: true },
};

const CONTENT = JSON.stringify({ token: "sekret-value", nested: { a: [1, 2, 3] } }, null, 2) + "\n";

describe("captureTransform — Plain + FileRule", () => {
  it("stores a non-plaintext envelope, not the original bytes", async () => {
    const t = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    expect(t.content).not.toBe(CONTENT);
    expect(t.content).not.toContain("sekret-value");
    expect(isFileEnvelope(t.content)).toBe(false); // field-envelope shape check must not match
    expect(parseFileEnvelope(t.content)).not.toBeNull();
  });

  it("labels the note 'encrypted file' (diff/summary label)", async () => {
    const t = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    expect(t.note).toBe("encrypted file");
  });

  it("produces no sidecar — scope compiles to the group's devices class, not __scopes__", async () => {
    const t = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    expect(t.ownScope).toBeNull();
  });

  it("throws a specific, actionable error when the passphrase is missing", async () => {
    await expect(captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, null, "desktop")).rejects.toThrow(PassphraseNeededError);
    await expect(captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, null, "desktop")).rejects.toThrow(/"secrets".*"\{configDir\}\/secrets\.json".*passphrase/s);
  });

  it("a Plain group without fileRule is untouched (no envelope)", async () => {
    const plain: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    const t = await captureTransform(plain, CONTENT, null, "desktop");
    expect(t.content).toBe(CONTENT);
    expect(t.note).toBeNull();
  });

  it("fileRule.encrypted:false is a no-op (not enveloped)", async () => {
    const notEncrypted: SyncGroup = { ...PLAIN_ENCRYPTED_GROUP, fileRule: { sharing: EVERYWHERE, encrypted: false } };
    const t = await captureTransform(notEncrypted, CONTENT, null, "desktop");
    expect(t.content).toBe(CONTENT);
    expect(t.note).toBeNull();
  });
});

describe("applyTransform — Plain + FileRule", () => {
  it("round-trips to byte-identical content", async () => {
    const captured = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    const applied = await applyTransform(PLAIN_ENCRYPTED_GROUP, captured.content, null, PASSPHRASE, "desktop", null);
    expect(applied).toBe(CONTENT);
  });

  it("throws a specific, actionable error when the passphrase is missing on apply", async () => {
    const captured = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    await expect(applyTransform(PLAIN_ENCRYPTED_GROUP, captured.content, null, null, "desktop", null)).rejects.toThrow(
      PassphraseNeededError
    );
    await expect(applyTransform(PLAIN_ENCRYPTED_GROUP, captured.content, null, null, "desktop", null)).rejects.toThrow(
      /"secrets".*"\{configDir\}\/secrets\.json".*passphrase/s
    );
  });

  it("throws (not a silent plaintext write) when the store content is not a valid envelope", async () => {
    await expect(applyTransform(PLAIN_ENCRYPTED_GROUP, "not an envelope", null, PASSPHRASE, "desktop", null)).rejects.toThrow(
      "not a valid encrypted envelope"
    );
  });
});

describe("contentUnchanged — Plain + FileRule", () => {
  it("true for the same content across a capture/apply round trip", async () => {
    const captured = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    expect(await contentUnchanged(PLAIN_ENCRYPTED_GROUP, CONTENT, captured.content, PASSPHRASE, "desktop", null)).toBe(true);
  });

  it("false after a local edit", async () => {
    const captured = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    const edited = JSON.stringify({ token: "different-value" });
    expect(await contentUnchanged(PLAIN_ENCRYPTED_GROUP, edited, captured.content, PASSPHRASE, "desktop", null)).toBe(false);
  });

  it("never throws without a passphrase — falls back to a literal byte comparison, never silently 'unchanged'", async () => {
    const captured = await captureTransform(PLAIN_ENCRYPTED_GROUP, CONTENT, PASSPHRASE, "desktop");
    // Local plaintext can never equal the store's envelope JSON byte-for-byte, so the fallback
    // is conservative: it reports "changed", it does not decrypt, and it does not throw.
    expect(await contentUnchanged(PLAIN_ENCRYPTED_GROUP, CONTENT, captured.content, null, "desktop", null)).toBe(false);
  });

  it("false when the store side isn't a valid envelope", async () => {
    expect(await contentUnchanged(PLAIN_ENCRYPTED_GROUP, CONTENT, "not an envelope", PASSPHRASE, "desktop", null)).toBe(false);
  });
});

describe("Plain + FileRule — full capture/apply round trip through ConfigSyncCore", () => {
  function setup(): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins: new FakePlugins(),
      passphrase: PASSPHRASE,
      deviceClass: "desktop",
      groupsIO: memGroupsIO(),
      now: () => "2026-07-25T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  const FILE_RULE_MANIFEST = JSON.stringify({
    version: 1,
    groups: [{ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", fileRule: { sharing: EVERYWHERE, encrypted: true } }],
  });

  it("capture stores an envelope and reports the 'encrypted file' label; re-capture writes nothing when unchanged", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/secrets.json": CONTENT });
    await ctx.groupsIO.write(parseSyncManifest(FILE_RULE_MANIFEST).groups);
    const results = await capture(ctx);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.messages).toEqual(["encrypted file"]);
    const stored = await io.read("cs/store/configdir/secrets.json");
    expect(stored).not.toContain("sekret-value");
    expect(parseFileEnvelope(stored)).not.toBeNull();
    const again = await capture(ctx);
    expect(again[0]?.filesWritten).toEqual([]); // unchanged local content — nothing rewritten
  });

  it("apply restores byte-identical local content from the envelope", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/secrets.json": CONTENT });
    await ctx.groupsIO.write(parseSyncManifest(FILE_RULE_MANIFEST).groups);
    await capture(ctx);
    await io.remove(".obs/secrets.json");
    const results = await apply(ctx, ["secrets"]);
    expect(results[0]?.status).toBe("ok");
    expect(await io.read(".obs/secrets.json")).toBe(CONTENT);
  });
});

describe("overlayGroup — FileRule groups are exempt from runtime field overlays", () => {
  // A runtime field overlay (e.g. app.json view-row rules) must never rewrite a fileRule group's
  // mode to "fields" — that would silently bypass the whole-file-encryption branch in
  // captureTransform/applyTransform for a group that also happens to match the overlay's keys.
  function ctxWithOverlay(fieldOverlay: CoreContext["fieldOverlay"]): CoreContext {
    return {
      io: new MemFS(),
      configDir: ".obs",
      rootPath: "cs",
      plugins: new FakePlugins(),
      passphrase: PASSPHRASE,
      deviceClass: "desktop",
      groupsIO: memGroupsIO(),
      now: () => "2026-07-25T00:00:00.000Z",
      switchExceptions: {},
      fieldOverlay,
    };
  }

  it("leaves a fileRule group untouched even when the overlay would add fields", () => {
    const ctx = ctxWithOverlay(() => [{ pattern: "x", sharing: EVERYWHERE, encrypted: false }]);
    const result = overlayGroup(ctx, PLAIN_ENCRYPTED_GROUP, [CONTENT]);
    expect(result).toEqual(PLAIN_ENCRYPTED_GROUP);
    expect(result.mode).not.toBe("fields");
  });

  it("still overlays fields normally for a group with no fileRule", () => {
    const plain: SyncGroup = { name: "app", path: "{configDir}/app.json", type: "file", devices: "all" };
    const ctx = ctxWithOverlay(() => [{ pattern: "x", sharing: EVERYWHERE, encrypted: false }]);
    const result = overlayGroup(ctx, plain, [CONTENT]);
    expect(result.mode).toBe("fields");
  });
});

describe("manifest validation — fileRule", () => {
  function groupWith(fileRule: unknown, extra: Record<string, unknown> = {}): unknown {
    return { name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", fileRule, ...extra };
  }

  it.each([EVERYWHERE, perClass("desktop"), perClass("mobile")])("accepts %o sharing with encrypted true/false", (sharing) => {
    for (const encrypted of [true, false]) {
      const m = validateSyncManifest({ version: 1, groups: [groupWith({ sharing, encrypted })] });
      expect(m.groups[0]?.fileRule).toEqual({ sharing, encrypted });
    }
  });

  it("rejects a this-device sharing (D9: no this-device at file level)", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [groupWith({ sharing: THIS_DEVICE, encrypted: true })] })).toThrow(
      ManifestValidationError
    );
    expect(() => validateSyncManifest({ version: 1, groups: [groupWith({ sharing: THIS_DEVICE, encrypted: true })] })).toThrow(
      /whole-file rule cannot be This device/
    );
  });

  it("rejects an unknown scope", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [groupWith({ scope: "galaxy", encrypted: true })] })).toThrow(
      ManifestValidationError
    );
  });

  it("rejects a non-boolean encrypted", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [groupWith({ sharing: EVERYWHERE, encrypted: "yes" })] })).toThrow(
      ManifestValidationError
    );
  });

  it('rejects fileRule on a "dir" group (companion folders stay plaintext — YAGNI)', () => {
    const dirGroup = { name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all", fileRule: { sharing: EVERYWHERE, encrypted: true } };
    expect(() => validateSyncManifest({ version: 1, groups: [dirGroup] })).toThrow(ManifestValidationError);
    expect(() => validateSyncManifest({ version: 1, groups: [dirGroup] })).toThrow(/whole-file rule only applies to a single file/);
  });

  it("rejects fileRule combined with mode:\"fields\" (never double-encrypt via two mechanisms)", () => {
    const g = {
      name: "app",
      path: "{configDir}/app.json",
      type: "file",
      devices: "all",
      mode: "fields",
      fields: [{ pattern: "x", sharing: EVERYWHERE, encrypted: false }],
      fileRule: { sharing: EVERYWHERE, encrypted: true },
    };
    expect(() => validateSyncManifest({ version: 1, groups: [g] })).toThrow(ManifestValidationError);
    expect(() => validateSyncManifest({ version: 1, groups: [g] })).toThrow(/whole-file rule only applies in Whole file/);
  });

  it('rejects fileRule combined with mode:"encrypted"', () => {
    const g = { name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted", fileRule: { sharing: EVERYWHERE, encrypted: true } };
    expect(() => validateSyncManifest({ version: 1, groups: [g] })).toThrow(ManifestValidationError);
  });

  it("error messages name the group and the field", () => {
    try {
      validateSyncManifest({ version: 1, groups: [groupWith({ scope: "not-a-scope", encrypted: true })] });
      throw new Error("expected validateSyncManifest to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestValidationError);
      expect((e as Error).message).toContain("secrets");
      expect((e as Error).message).toContain("fileRule");
    }
  });
});
