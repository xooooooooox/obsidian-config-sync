import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitReader, createGitWriter } from "../src/external/gitSource";
import { createLocalPathReader, createLocalPathWriter } from "../src/external/localPath";

const run = promisify(execFile);

let sourceRepo: string;
let consumerRepo: string;
let bareRemote: string;

beforeAll(async () => {
  sourceRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-source-"));
  consumerRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-consumer-"));
  await mkdir(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir"), { recursive: true });
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/config-sync.json"), '{"version":1,"groups":[]}');
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir/hotkeys.json"), "{}");
  await run("git", ["init", "-b", "main"], { cwd: sourceRepo });
  await run("git", ["add", "."], { cwd: sourceRepo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: sourceRepo });
  await run("git", ["init", "-b", "main"], { cwd: consumerRepo });

  bareRemote = await mkdtemp(nodePath.join(tmpdir(), "cs-bare-"));
  await run("git", ["init", "--bare", "-b", "main", bareRemote]);
  const seed = await mkdtemp(nodePath.join(tmpdir(), "cs-seed-"));
  await run("git", ["clone", bareRemote, seed]);
  await mkdir(nodePath.join(seed, "cfg"), { recursive: true });
  await writeFile(nodePath.join(seed, "cfg/config-sync.json"), '{"version":1,"groups":[]}');
  await run("git", ["-C", seed, "add", "."]);
  await run("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
  await run("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(sourceRepo, { recursive: true, force: true });
  await rm(consumerRepo, { recursive: true, force: true });
  await rm(bareRemote, { recursive: true, force: true });
});

describe("createLocalPathReader", () => {
  it("lists and reads files under the source root", async () => {
    const reader = createLocalPathReader(sourceRepo, "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe("{}");
  });

  it("fails with a clear error when the root does not exist", async () => {
    const reader = createLocalPathReader(sourceRepo, "no/such/root");
    await expect(reader.listFiles()).rejects.toThrow("External source root not found");
  });
});

describe("createGitReader", () => {
  it("lists and reads files from a remote branch without touching the worktree", async () => {
    const reader = await createGitReader(consumerRepo, sourceRepo, "main", "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("config-sync.json")).toBe('{"version":1,"groups":[]}');
    const status = (await run("git", ["status", "--porcelain"], { cwd: consumerRepo })).stdout;
    expect(status).toBe("");
  });

  it("updates the remote url on subsequent calls instead of failing", async () => {
    const reader = await createGitReader(consumerRepo, sourceRepo, "main", "0-Extra/config-sync");
    expect(await reader.listFiles()).toContain("config-sync.json");
  });

  it("fails with a contextual error for an unreachable remote", async () => {
    await expect(createGitReader(consumerRepo, "/no/such/repo", "main", "x")).rejects.toThrow("git fetch");
  });
});

describe("createLocalPathWriter", () => {
  it("writes files under the dest root and propagates deletions, round-tripping via the reader", async () => {
    const dest = await mkdtemp(nodePath.join(tmpdir(), "cs-dest-"));
    const writer = createLocalPathWriter(dest, "0-Extra/config-sync");
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":7}');
    await writer.finalize();
    const reader = createLocalPathReader(dest, "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":7}');
    await writer.deleteFile("store/configdir/hotkeys.json");
    expect((await createLocalPathReader(dest, "0-Extra/config-sync").listFiles())).toEqual(["config-sync.json"]);
    await rm(dest, { recursive: true, force: true });
  });
});

describe("createGitWriter", () => {
  it("commits and pushes the store to the remote branch, visible to a fresh reader", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg");
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":42}');
    await writer.finalize();
    const reader = await createGitReader(consumerRepo, bareRemote, "main", "cfg");
    expect(await reader.listFiles()).toContain("store/configdir/hotkeys.json");
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
  });

  it("propagates deletions on the remote", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg");
    // only config-sync.json this time — the previously pushed hotkeys.json must disappear
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    for (const rel of await writer.listFiles()) {
      if (rel !== "config-sync.json") await writer.deleteFile(rel);
    }
    await writer.finalize();
    const reader = await createGitReader(consumerRepo, bareRemote, "main", "cfg");
    expect(await reader.listFiles()).toEqual(["config-sync.json"]);
  });
});
