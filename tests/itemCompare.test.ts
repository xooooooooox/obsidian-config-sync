import { describe, expect, it } from "vitest";
import { compareStoreItem, refsNeedingContentCompare } from "../src/core/itemCompare";
import { ContentVerdict } from "../src/core/cipherCompare";
import { encryptField, encryptFile } from "../src/core/crypto";
import { MemFS } from "./memfs";
import { EVERYWHERE, RemoteItems, SyncGroup } from "../src/core/types";

const ROOT = "cs";

function group(over: Record<string, unknown>): SyncGroup {
  return { name: "demo", ref: "community/demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", ...over } as unknown as SyncGroup;
}

function reader(files: Record<string, string>): { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> } {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (rel) => {
      const c = files[rel];
      if (c === undefined) throw new Error(`reader: missing ${rel}`);
      return c;
    },
  };
}

const BASE = "store/configdir/plugins/demo/data.json";
const DESKTOP = `${BASE}.__scopes__.desktop.json`;

async function verdict(input: {
  local: Record<string, string>;
  remote: Record<string, string>;
  groups: SyncGroup[];
  passphrase?: string | null;
  masked?: (rel: string) => string[];
}): Promise<ContentVerdict> {
  const io = new MemFS();
  io.seed(Object.fromEntries(Object.entries(input.local).map(([rel, c]) => [`${ROOT}/${rel}`, c])));
  const pass = input.passphrase === undefined ? "pw" : input.passphrase;
  return compareStoreItem({
    io,
    rootPath: ROOT,
    reader: reader(input.remote),
    groups: input.groups,
    ref: "community/demo",
    masked: input.masked ?? (() => []),
    passphrase: { mine: pass, theirs: pass },
  });
}

describe("compareStoreItem", () => {
  it("calls a whole-file encrypted item in sync when both copies say the same thing", async () => {
    const g = [group({ mode: "encrypted" })];
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    const theirs = await encryptFile("pw", '{"token":"x"}\n');
    expect(mine).not.toEqual(theirs); // the bytes never match; that is the bug being fixed
    expect(await verdict({ local: { [BASE]: mine }, remote: { [BASE]: theirs }, groups: g })).toBe("same");
  });

  it("cannot compare a whole-file encrypted item with no passphrase on this device", async () => {
    const g = [group({ mode: "encrypted" })];
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    const theirs = await encryptFile("pw", '{"token":"y"}\n');
    expect(await verdict({ local: { [BASE]: mine }, remote: { [BASE]: theirs }, groups: g, passphrase: null })).toEqual({ cannot: "here" });
  });

  it("finds a difference in an encrypted field inside a sidecar", async () => {
    const g = [group({ mode: "fields", fields: [{ pattern: "token", sharing: EVERYWHERE, encrypted: true }] })];
    const base = '{"theme":"dark"}\n';
    const mineSide = JSON.stringify({ token: await encryptField("pw", "a") }, null, 2) + "\n";
    const theirsSide = JSON.stringify({ token: await encryptField("pw", "b") }, null, 2) + "\n";
    expect(await verdict({ local: { [BASE]: base, [DESKTOP]: mineSide }, remote: { [BASE]: base, [DESKTOP]: theirsSide }, groups: g })).toBe("differs");
  });

  it("compares a whole-file encrypted FOLDER item file by file", async () => {
    const g = [group({ type: "folder", path: "{configDir}/plugins/demo", mode: "encrypted" })];
    const dir = "store/configdir/plugins/demo";
    const mineA = await encryptFile("pw", '{"a":1}\n');
    const theirsA = await encryptFile("pw", '{"a":1}\n');
    expect(
      await verdict({ local: { [`${dir}/a.json`]: mineA }, remote: { [`${dir}/a.json`]: theirsA }, groups: g })
    ).toBe("same");
    // A file only one side has is a difference, and it is why both sides' listings are consulted.
    expect(
      await verdict({ local: { [`${dir}/a.json`]: mineA }, remote: { [`${dir}/a.json`]: theirsA, [`${dir}/b.json`]: theirsA }, groups: g })
    ).toBe("differs");
  });

  it("lets a plain difference outrank a file it could not open", async () => {
    const g = [group({ mode: "fields", fields: [{ pattern: "token", sharing: EVERYWHERE, encrypted: true }] })];
    const mineBase = JSON.stringify({ token: await encryptField("pw", "a") }, null, 2) + "\n";
    const theirsBase = JSON.stringify({ token: await encryptField("pw", "a") }, null, 2) + "\n";
    expect(
      await verdict({
        local: { [BASE]: mineBase, [DESKTOP]: '{"theme":"dark"}\n' },
        remote: { [BASE]: theirsBase, [DESKTOP]: '{"theme":"light"}\n' },
        groups: g,
        passphrase: null,
      })
    ).toBe("differs");
  });

  it("says nothing about passphrases when the other end holds no copy", async () => {
    const g = [group({ mode: "encrypted" })];
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    expect(await verdict({ local: { [BASE]: mine }, remote: {}, groups: g, passphrase: null })).toBe("differs");
  });

  it("masks the keys that travel neither way", async () => {
    const g = [group({ mode: "fields", fields: [{ pattern: "token", sharing: EVERYWHERE, encrypted: true }] })];
    const token = await encryptField("pw", "a");
    const mine = JSON.stringify({ local: 1, token }, null, 2) + "\n";
    const theirs = JSON.stringify({ local: 2, token }, null, 2) + "\n";
    expect(await verdict({ local: { [BASE]: mine }, remote: { [BASE]: theirs }, groups: g, masked: () => ["local"] })).toBe("same");
  });
});

describe("refsNeedingContentCompare", () => {
  it("unions the key-ruled items with the ones holding ciphertext, without repeating", () => {
    const items: RemoteItems = { community: { demo: { keys: { localOnly: { direction: "none" } } } } };
    const groups = [
      group({ mode: "encrypted" }),
      group({ name: "other", ref: "community/other", path: "{configDir}/plugins/other/data.json" }),
    ];
    expect(refsNeedingContentCompare({ groups, items }).sort()).toEqual(["community/demo"]);
  });

  it("asks for nothing when a remote has no key rules and nothing is encrypted", () => {
    expect(refsNeedingContentCompare({ groups: [group({})], items: undefined })).toEqual([]);
  });
});
