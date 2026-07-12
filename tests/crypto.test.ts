import { describe, expect, it } from "vitest";
import {
  DecryptError, decryptField, decryptFile, encryptField, encryptFile,
  fieldUnchanged, fileUnchanged, isFieldEnvelope, parseFileEnvelope,
} from "../src/core/crypto";

describe("file envelopes", () => {
  it("round-trips and compares deterministically", async () => {
    const enc = await encryptFile("pw", '{"a":1}');
    const env = parseFileEnvelope(enc);
    expect(env).not.toBeNull();
    if (env === null) throw new Error("unreachable");
    expect(await decryptFile("pw", env, "g")).toBe('{"a":1}');
    expect(await fileUnchanged("pw", env, '{"a":1}')).toBe(true);
    expect(await fileUnchanged("pw", env, '{"a":2}')).toBe(false);
    // two captures of the same plaintext produce different ciphertext but both compare unchanged
    const enc2 = await encryptFile("pw", '{"a":1}');
    expect(enc2).not.toBe(enc);
  });

  it("wrong passphrase fails with the verbatim error", async () => {
    const env = parseFileEnvelope(await encryptFile("pw", "x"));
    if (env === null) throw new Error("unreachable");
    await expect(decryptFile("other", env, "hotkeys")).rejects.toThrowError(
      'cannot decrypt "hotkeys" — wrong passphrase on this device?'
    );
    await expect(decryptFile("other", env, "hotkeys")).rejects.toBeInstanceOf(DecryptError);
  });

  it("parseFileEnvelope rejects ordinary json and junk", () => {
    expect(parseFileEnvelope('{"a":1}')).toBeNull();
    expect(parseFileEnvelope("not json")).toBeNull();
  });
});

describe("field envelopes", () => {
  it("round-trips, detects, compares", async () => {
    const f = await encryptField("pw", "secret-token");
    expect(isFieldEnvelope(f)).toBe(true);
    expect(isFieldEnvelope("plain")).toBe(false);
    expect(await decryptField("pw", f, "g")).toBe("secret-token");
    expect(await fieldUnchanged("pw", f, "secret-token")).toBe(true);
    expect(await fieldUnchanged("pw", f, "other")).toBe(false);
    await expect(decryptField("bad", f, "g")).rejects.toBeInstanceOf(DecryptError);
  });
});
