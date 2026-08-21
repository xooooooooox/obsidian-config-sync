import { describe, expect, it } from "vitest";
import { compareCopies } from "../src/core/cipherCompare";
import { encryptField, encryptFile } from "../src/core/crypto";

// Real WebCrypto, on purpose: the whole point of this module is what REAL envelopes do — every
// encryption draws a fresh salt and IV, so two vaults holding the very same setting hold different
// bytes. A mocked cipher would hide exactly the fact under test.
describe("compareCopies", () => {
  it("calls two encryptions of the same plaintext the same content", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"x"}\n');
    expect(a).not.toEqual(b);
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("same");
  });

  it("says THIS side cannot open when this device has no passphrase", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"y"}\n');
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toEqual({ cannot: "here" });
  });

  it("says the OTHER side cannot open when only the remote's key fails", async () => {
    const a = await encryptFile("mine-pw", '{"token":"x"}\n');
    const b = await encryptFile("their-pw", '{"token":"y"}\n');
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "mine-pw", theirs: "wrong" }, masked: [], groupName: "g" })).toEqual({ cannot: "there" });
  });

  it("names its own side first when neither key opens anything", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"y"}\n');
    // The user can only fix what is theirs to fix; sending them to the remote's settings while
    // their own passphrase is wrong would have them fix the wrong thing first.
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "wrong", theirs: "wrong" }, masked: [], groupName: "g" })).toEqual({ cannot: "here" });
  });

  it("still reports a real difference once both sides open", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"y"}\n');
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("differs");
  });

  it("compares encrypted FIELDS by their plaintext", async () => {
    const mine = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    expect(mine).not.toEqual(theirs);
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("same");
  });

  it("reports a real difference in an encrypted field", async () => {
    const mine = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", token: await encryptField("pw", "other") }, null, 2) + "\n";
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("differs");
  });

  it("cannot compare a field it has no passphrase for, and says which side", async () => {
    const mine = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "light", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    expect(await compareCopies({ mine, theirs, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toEqual({ cannot: "here" });
  });

  it("blames the remote's key for a field only its side fails to open", async () => {
    const mine = JSON.stringify({ theme: "dark", token: await encryptField("mine-pw", "s") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", token: await encryptField("their-pw", "s") }, null, 2) + "\n";
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "mine-pw", theirs: "nope" }, masked: [], groupName: "g" })).toEqual({ cannot: "there" });
  });

  it("masks the keys that travel neither way before deciding", async () => {
    const mine = JSON.stringify({ theme: "dark", local: 1, token: await encryptField("pw", "s") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", local: 999, token: await encryptField("pw", "s") }, null, 2) + "\n";
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "pw", theirs: "pw" }, masked: ["local"], groupName: "g" })).toBe("same");
  });

  it("says nothing about passphrases when the other end has no copy yet", async () => {
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    expect(await compareCopies({ mine, theirs: null, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("differs");
    expect(await compareCopies({ mine: null, theirs: null, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("same");
  });

  it("calls two copies stored in different FORMS different, without guessing", async () => {
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    expect(await compareCopies({ mine, theirs: '{"token":"x"}\n', passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("differs");
  });

  it("leaves plain items on the byte path — never `cannot`", async () => {
    expect(await compareCopies({ mine: '{"a":1}', theirs: '{"a":2}', passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("differs");
    expect(await compareCopies({ mine: '{"a":1}', theirs: '{ "a": 1 }', passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("same");
  });

  it("costs one derivation per salt, not one per comparison", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"x"}\n');
    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("same");
    }
    // Five comparisons of the same two envelopes must not pay PBKDF2 ten times over (210k
    // iterations each); crypto.ts memoizes by passphrase+salt and both salts are fixed on disk.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
