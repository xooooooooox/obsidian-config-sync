import { describe, expect, it } from "vitest";
import { CoreContext, ExternalStoreReader, capture, writeGroups } from "../src/core/ConfigSyncCore";
import { checkRemote, diffRemote, DirectionIgnores } from "../src/core/status";
import { compareStoreItem, refsNeedingContentCompare } from "../src/core/itemCompare";
import { remoteRowStatuses } from "../src/core/remoteRows";
import { parseStoreLock } from "../src/core/manifest";
import { SyncGroup } from "../src/core/types";
import { withRef } from "./lock";
import { MemFS, FakePlugins, memGroupsIO } from "./memfs";

// The whole 4a chain, end to end, on REAL envelopes: capture writes one, the far end holds another
// made from the same plaintext, and every surface between them has to call that "in sync".
//
// This is the shape the live smoke would have taken, minus Obsidian: two vaults that captured the
// same setting independently, which is the ONLY way to get two envelopes of one plaintext (inside a
// single vault the bytes are stable, because capture reuses an envelope whose plaintext has not
// changed — so a test that copies the store to make its "remote" proves nothing at all).

const NO_IGNORES: DirectionIgnores = { pull: [], push: [] };
const STORE_REL = "store/configdir/secrets.json";
// The identity the compiler would have given it — a group with no ref is recorded in no lock entry
// at all, and every per-item answer here is keyed by one.
const GROUPS = [
  withRef({ name: "secrets", path: "{configDir}/secrets.json", type: "file", devices: "all", mode: "encrypted" } as unknown as SyncGroup),
];
const REF = GROUPS[0]?.ref as string;
const SECRET = JSON.stringify({ token: "s3cret", theme: "dark" }, null, 2) + "\n";

function fakeReader(files: Record<string, string>): ExternalStoreReader {
  return {
    async listFiles(): Promise<string[]> {
      return Object.keys(files).sort();
    },
    async readFile(rel: string): Promise<string> {
      const c = files[rel];
      if (c === undefined) throw new Error(`no ${rel}`);
      return c;
    },
  };
}

// One vault: seed the live file, capture it, hand back what landed in the store.
async function vault(input: { passphrase: string; at: string; content: string }): Promise<{ io: MemFS; ctx: CoreContext }> {
  const io = new MemFS();
  const ctx: CoreContext = {
    io,
    configDir: ".obs",
    rootPath: "cs",
    plugins: new FakePlugins(),
    passphrase: input.passphrase,
    deviceClass: "desktop",
    groupsIO: memGroupsIO(),
    now: () => input.at,
    switchExceptions: {},
  };
  await writeGroups(ctx, GROUPS);
  io.seed({ ".obs/secrets.json": input.content });
  await capture(ctx);
  return { io, ctx };
}

async function remoteFiles(at: string, content: string): Promise<Record<string, string>> {
  const far = await vault({ passphrase: "pw", at, content });
  return {
    "store.lock.json": await far.io.read("cs/store.lock.json"),
    [STORE_REL]: await far.io.read(`cs/${STORE_REL}`),
  };
}

async function check(ctx: CoreContext, io: MemFS, remote: Record<string, string>): ReturnType<typeof checkRemote> {
  const reader = fakeReader(remote);
  const groups = await ctx.groupsIO.read();
  const localLock = parseStoreLock(await io.read("cs/store.lock.json"), groups);
  return checkRemote(localLock, reader, NO_IGNORES, {
    groups,
    content: {
      refs: refsNeedingContentCompare({ groups, items: undefined }),
      compare: (ref) =>
        compareStoreItem({
          io,
          rootPath: ctx.rootPath,
          reader,
          groups,
          ref,
          masked: () => [],
          passphrase: { mine: ctx.passphrase, theirs: ctx.passphrase },
        }),
    },
  });
}

describe("an encrypted item compared with a remote", () => {
  it("is in sync when both vaults hold the same setting, however different the bytes are", async () => {
    const { io, ctx } = await vault({ passphrase: "pw", at: "2026-08-20T00:00:00.000Z", content: SECRET });
    // The far end captured later, so the lock stamps alone would read as a pull — the exact
    // false alarm this release removes.
    const remote = await remoteFiles("2026-08-21T00:00:00.000Z", SECRET);
    expect(remote[STORE_REL]).not.toEqual(await io.read(`cs/${STORE_REL}`));

    const result = await check(ctx, io, remote);
    expect(result.itemVerdicts?.[REF]).toBeUndefined();
    expect(result.items).toEqual({ push: 0, pull: 0 });
    expect(result.uncomparable).toEqual({});

    const entries = await diffRemote(ctx, fakeReader(remote), {
      skipRefs: [],
      unexchanged: () => [],
      passphrase: { mine: "pw", theirs: "pw" },
    });
    expect(entries.find((e) => e.group === "secrets")).toBeUndefined();

    const rows = remoteRowStatuses({
      entries,
      verdicts: result.itemVerdicts ?? {},
      uncomparable: Object.keys(result.uncomparable),
      refOf: () => REF,
      companionRefsOf: () => [],
      localGroupNames: ["secrets"],
    });
    expect(rows.find((r) => r.group === "secrets")?.state).toBe("in-sync");
  });

  it("still reports a real difference in what the two copies say", async () => {
    const { io, ctx } = await vault({ passphrase: "pw", at: "2026-08-20T00:00:00.000Z", content: SECRET });
    const remote = await remoteFiles("2026-08-21T00:00:00.000Z", JSON.stringify({ token: "s3cret", theme: "light" }, null, 2) + "\n");

    const result = await check(ctx, io, remote);
    expect(result.itemVerdicts?.[REF]).toBe("pull");
    expect(result.uncomparable).toEqual({});

    const entries = await diffRemote(ctx, fakeReader(remote), {
      skipRefs: [],
      unexchanged: () => [],
      passphrase: { mine: "pw", theirs: "pw" },
    });
    expect(entries.find((e) => e.group === "secrets")?.files.map((f) => f.itemRel)).toEqual(["secrets.json"]);
  });

  it("says it cannot compare, claims no difference, and files the row accordingly with no passphrase here", async () => {
    const { io, ctx } = await vault({ passphrase: "pw", at: "2026-08-20T00:00:00.000Z", content: SECRET });
    const remote = await remoteFiles("2026-08-21T00:00:00.000Z", JSON.stringify({ token: "other", theme: "dark" }, null, 2) + "\n");
    // This device forgets the passphrase — the state the panel has to be honest about.
    const locked: CoreContext = { ...ctx, passphrase: null };

    const result = await check(locked, io, remote);
    expect(result.uncomparable).toEqual({ [REF]: "here" });
    expect(result.itemVerdicts?.[REF]).toBeUndefined();
    expect(result.items).toEqual({ push: 0, pull: 0 });

    const entries = await diffRemote(locked, fakeReader(remote), {
      skipRefs: [],
      unexchanged: () => [],
      passphrase: { mine: null, theirs: null },
    });
    const entry = entries.find((e) => e.group === "secrets");
    // Named, but with nothing claimed about it: no file row, because nobody read one.
    expect(entry?.uncomparable).toBe(true);
    expect(entry?.files).toEqual([]);

    const rows = remoteRowStatuses({
      entries,
      verdicts: result.itemVerdicts ?? {},
      uncomparable: Object.keys(result.uncomparable),
      refOf: () => REF,
      companionRefsOf: () => [],
      localGroupNames: ["secrets"],
    });
    expect(rows.find((r) => r.group === "secrets")?.state).toBe("locked");
  });

  it("says nothing about passphrases when the remote has no copy of the item yet", async () => {
    const { io, ctx } = await vault({ passphrase: "pw", at: "2026-08-20T00:00:00.000Z", content: SECRET });
    const far = await remoteFiles("2026-08-21T00:00:00.000Z", SECRET);
    const remote = { "store.lock.json": far["store.lock.json"] as string };
    const locked: CoreContext = { ...ctx, passphrase: null };

    const result = await check(locked, io, remote);
    expect(result.uncomparable).toEqual({});

    const entries = await diffRemote(locked, fakeReader(remote), {
      skipRefs: [],
      unexchanged: () => [],
      passphrase: { mine: null, theirs: null },
    });
    const entry = entries.find((e) => e.group === "secrets");
    expect(entry?.uncomparable).toBeUndefined();
    expect(entry?.files.map((f) => f.kind)).toEqual(["deleted"]); // only this side has it: an ordinary push row
  });
});

import { applyImport, planImport, pushExternal, ExternalStoreWriter } from "../src/core/ConfigSyncCore";
import { decryptFile, parseFileEnvelope } from "../src/core/crypto";
import { transcodeContent } from "../src/core/transcode";

// The full 4c loop on real envelopes: vault A (passphrase "a") pushes to a remote keyed "b", the
// far end reads its copy under ITS OWN key, a second push writes nothing, and a change made over
// there comes back readable under A's key. Each side only ever holds ciphertext its own key opens.
describe("a remote keyed differently, round trip", () => {
  function memWriter(files: Record<string, string>): { writer: ExternalStoreWriter; files: Record<string, string>; writeLog: string[] } {
    const writeLog: string[] = [];
    const writer: ExternalStoreWriter = {
      async listFiles() {
        return Object.keys(files).sort();
      },
      async readFile(rel) {
        const c = files[rel];
        if (c === undefined) throw new Error(`no ${rel}`);
        return c;
      },
      async writeFile(rel, content) {
        files[rel] = content;
        writeLog.push(rel);
      },
      async deleteFile(rel) {
        delete files[rel];
      },
      async finalize() {},
    };
    return { writer, files, writeLog };
  }

  it("pushes readable-by-them, stays silent when nothing changed, pulls back readable-by-us", async () => {
    const mine = await vault({ passphrase: "a", at: "2026-08-20T00:00:00.000Z", content: SECRET });
    const remote = memWriter({ "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }) });
    const pushOpts = {
      skipRefs: [],
      withheldPush: (): string[] => [],
      expectPush: [],
      transcode: (rel: string, content: string, existing: string | null) =>
        transcodeContent({ rel, content, existing, from: "a", to: "b" }),
    };
    await pushExternal(mine.ctx, remote.writer, pushOpts);
    const overThere = remote.files[STORE_REL];
    expect(overThere).toBeDefined();
    expect(await decryptFile("b", parseFileEnvelope(overThere!)!, "secrets")).toBe(SECRET);

    // Steady state: fresh salts on every encryption, and still not a byte moves.
    const afterFirst = remote.writeLog.length;
    await pushExternal(mine.ctx, remote.writer, pushOpts);
    expect(remote.writeLog.length).toBe(afterFirst);

    // The far end edits; the pull lands a copy THIS vault's key opens.
    const changed = JSON.stringify({ token: "rotated", theme: "dark" }, null, 2) + "\n";
    const far = await vault({ passphrase: "b", at: "2026-08-22T00:00:00.000Z", content: changed });
    remote.files[STORE_REL] = await far.io.read(`cs/${STORE_REL}`);
    remote.files["store.lock.json"] = await far.io.read("cs/store.lock.json");
    const pending = await planImport(mine.ctx, remote.writer, {
      skipRefs: [],
      withheldPull: () => [],
      transcode: (rel, content, existing) => transcodeContent({ rel, content, existing, from: "b", to: "a" }),
    });
    await applyImport(mine.ctx, pending, pending.plan.conflicts.map(() => "remote" as const));
    const local = await mine.io.read(`cs/${STORE_REL}`);
    expect(await decryptFile("a", parseFileEnvelope(local)!, "secrets")).toBe(changed);
  });
});
