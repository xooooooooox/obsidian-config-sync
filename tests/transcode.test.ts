import { describe, expect, it } from "vitest";
import { TranscodeError, transcodeContent } from "../src/core/transcode";
import { decryptField, decryptFile, encryptField, encryptFile, parseFileEnvelope } from "../src/core/crypto";

// Real WebCrypto throughout: what is under test is precisely how real envelopes behave — fresh
// randomness on every encryption is the reason this module exists.
describe("transcodeContent", () => {
  it("returns the destination's existing bytes when they already say the same thing", async () => {
    const source = await encryptFile("a", '{"token":"x"}\n');
    const existing = await encryptFile("b", '{"token":"x"}\n');
    const out = await transcodeContent({ rel: "store/x.json", content: source, existing, from: "a", to: "b" });
    expect(out).toBe(existing); // byte-identical, so the seam's own identical-skip fires
  });

  it("re-encrypts for the destination when the content really changed", async () => {
    const source = await encryptFile("a", '{"token":"NEW"}\n');
    const existing = await encryptFile("b", '{"token":"old"}\n');
    const out = await transcodeContent({ rel: "store/x.json", content: source, existing, from: "a", to: "b" });
    expect(out).not.toBe(existing);
    const env = parseFileEnvelope(out);
    expect(env).not.toBeNull();
    expect(await decryptFile("b", env!, "x")).toBe('{"token":"NEW"}\n');
  });

  it("performs the one-time conversion when the destination holds nothing yet", async () => {
    const source = await encryptFile("a", '{"token":"x"}\n');
    const out = await transcodeContent({ rel: "store/x.json", content: source, existing: null, from: "a", to: "b" });
    expect(await decryptFile("b", parseFileEnvelope(out)!, "x")).toBe('{"token":"x"}\n');
  });

  it("re-encrypts only the fields that changed, reusing the destination's other envelopes", async () => {
    const keepPlain = "stays";
    const existingKeep = await encryptField("b", keepPlain);
    const existing = JSON.stringify({ theme: "dark", token: existingKeep, other: await encryptField("b", "old") }, null, 2) + "\n";
    const source = JSON.stringify({ theme: "dark", token: await encryptField("a", keepPlain), other: await encryptField("a", "NEW") }, null, 2) + "\n";
    const out = await transcodeContent({ rel: "store/x.json", content: source, existing, from: "a", to: "b" });
    const doc = JSON.parse(out) as { theme: string; token: string; other: string };
    expect(doc.token).toBe(existingKeep); // unchanged plaintext keeps the destination's envelope
    expect(await decryptField("b", doc.other, "x")).toBe("NEW");
  });

  it("returns the destination's whole document when nothing changed at all", async () => {
    const token = "same";
    const existing = JSON.stringify({ theme: "dark", token: await encryptField("b", token) }, null, 2) + "\n";
    const source = JSON.stringify({ theme: "dark", token: await encryptField("a", token) }, null, 2) + "\n";
    const out = await transcodeContent({ rel: "store/x.json", content: source, existing, from: "a", to: "b" });
    expect(out).toBe(existing);
  });

  it("refuses a source it cannot open, naming the file", async () => {
    const source = await encryptFile("a", '{"token":"x"}\n');
    await expect(transcodeContent({ rel: "store/x.json", content: source, existing: null, from: "wrong", to: "b" })).rejects.toThrow(TranscodeError);
  });

  it("refuses ciphertext with no destination key to re-encrypt under", async () => {
    const source = await encryptFile("a", '{"token":"x"}\n');
    await expect(transcodeContent({ rel: "store/x.json", content: source, existing: null, from: "a", to: null })).rejects.toThrow(TranscodeError);
  });

  it("passes plain content through untouched", async () => {
    expect(await transcodeContent({ rel: "store/x.json", content: '{"a":1}\n', existing: null, from: "a", to: "b" })).toBe('{"a":1}\n');
    expect(await transcodeContent({ rel: "store/x.css", content: "body{}", existing: null, from: "a", to: "b" })).toBe("body{}");
  });

  it("passes everything through when the two keys are the same one — today's road", async () => {
    const source = await encryptFile("a", '{"token":"x"}\n');
    expect(await transcodeContent({ rel: "store/x.json", content: source, existing: null, from: "a", to: "a" })).toBe(source);
    expect(await transcodeContent({ rel: "store/x.json", content: source, existing: null, from: null, to: null })).toBe(source);
  });
});

import { transcodePreflight } from "../src/core/transcode";
import { MemFS } from "./memfs";
import { SyncGroup } from "../src/core/types";

function preflightReader(files: Record<string, string>): { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> } {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (rel) => {
      const c = files[rel];
      if (c === undefined) throw new Error(`no ${rel}`);
      return c;
    },
  };
}

const PF_GROUPS = [
  { name: "secrets", ref: "custom/secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" },
  { name: "hotkeys", ref: "obsidian/hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
] as unknown as SyncGroup[];

describe("transcodePreflight", () => {
  it("answers instantly with nothing to hold on the shared-passphrase default", async () => {
    const out = await transcodePreflight({
      key: { kind: "same-as-local", passphrase: "pw" },
      remoteName: "work",
      direction: "pull",
      groups: PF_GROUPS,
      io: new MemFS(),
      rootPath: "cs",
      reader: preflightReader({}),
      localPassphrase: "pw",
    });
    expect(out).toEqual({ skipRefs: [], results: [] });
  });

  it("holds every encrypted item out when the named entry is not linked here", async () => {
    const out = await transcodePreflight({
      key: { kind: "missing", secretId: "work-pass" },
      remoteName: "work",
      direction: "pull",
      groups: PF_GROUPS,
      io: new MemFS(),
      rootPath: "cs",
      reader: preflightReader({}),
      localPassphrase: "pw",
    });
    expect(out.skipRefs).toEqual(["custom/secrets"]);
    expect(out.results[0]?.messages).toEqual(["Skipped — the passphrase named for work isn't linked on this device. Nothing was written."]);
  });

  it("holds out an item whose remote copy the saved key does not open, and lets the rest travel", async () => {
    const theirs = await encryptFile("their-real-pw", '{"token":"x"}\n');
    const out = await transcodePreflight({
      key: { kind: "own", passphrase: "wrong" },
      remoteName: "work",
      direction: "pull",
      groups: PF_GROUPS,
      io: new MemFS(),
      rootPath: "cs",
      reader: preflightReader({ "store/configdir/secrets.json": theirs, "store/configdir/hotkeys.json": '{"a":1}' }),
      localPassphrase: "pw",
    });
    expect(out.skipRefs).toEqual(["custom/secrets"]);
    expect(out.results[0]?.messages).toEqual(["Skipped — the passphrase saved for work doesn't open its copy. Nothing was written."]);
  });

  it("lets an item travel once the saved key opens its copy", async () => {
    const theirs = await encryptFile("their-pw", '{"token":"x"}\n');
    const out = await transcodePreflight({
      key: { kind: "own", passphrase: "their-pw" },
      remoteName: "work",
      direction: "pull",
      groups: PF_GROUPS,
      io: new MemFS(),
      rootPath: "cs",
      reader: preflightReader({ "store/configdir/secrets.json": theirs }),
      localPassphrase: "pw",
    });
    expect(out).toEqual({ skipRefs: [], results: [] });
  });

  it("holds a push out when this device cannot open its own copy", async () => {
    const io = new MemFS();
    io.seed({ "cs/store/configdir/secrets.json": await encryptFile("pw", '{"token":"x"}\n') });
    const out = await transcodePreflight({
      key: { kind: "own", passphrase: "their-pw" },
      remoteName: "work",
      direction: "push",
      groups: PF_GROUPS,
      io,
      rootPath: "cs",
      reader: preflightReader({}),
      localPassphrase: null,
    });
    expect(out.skipRefs).toEqual(["custom/secrets"]);
    expect(out.results[0]?.messages).toEqual(["Skipped — this item is encrypted and this device has no passphrase. Nothing was written."]);
  });
});
