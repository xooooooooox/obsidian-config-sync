import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import * as nodePath from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitReader, createGitWriter } from "../src/external/gitSource";
import { createLocalPathReader, createLocalPathWriter, expandTilde, findStoreDirs } from "../src/external/localPath";
import { GitAuth } from "../src/core/types";

const run = promisify(execFile);
const REAL_AUTH: GitAuth = { username: "u", token: "t" };

let sourceRepo: string;
let bareRemote: string;

beforeAll(async () => {
  sourceRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-source-"));
  await mkdir(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir"), { recursive: true });
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/config-sync.json"), '{"version":1,"groups":[]}');
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir/hotkeys.json"), "{}");
  await run("git", ["init", "-b", "main"], { cwd: sourceRepo });
  await run("git", ["add", "."], { cwd: sourceRepo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: sourceRepo });

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
  await rm(bareRemote, { recursive: true, force: true });
});

describe("findStoreDirs", () => {
  it("finds store dirs by config-sync.json, skipping dot dirs, stopping at a hit", async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), "cs-find-"));
    await mkdir(nodePath.join(base, "0-Extras/config-sync/plugin-x"), { recursive: true });
    await writeFile(nodePath.join(base, "0-Extras/config-sync/config-sync.json"), "{}");
    await writeFile(nodePath.join(base, "0-Extras/config-sync/plugin-x/config-sync.json"), "{}"); // below a hit → not reported
    await mkdir(nodePath.join(base, ".obsidian/config-sync"), { recursive: true });
    await writeFile(nodePath.join(base, ".obsidian/config-sync/config-sync.json"), "{}"); // dot dir → skipped
    const dirs = await findStoreDirs(base);
    expect(dirs).toEqual([nodePath.join(base, "0-Extras/config-sync")]);
    await rm(base, { recursive: true, force: true });
  });
  it("returns [] when nothing matches and throws on an unreadable base", async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), "cs-find-"));
    expect(await findStoreDirs(base)).toEqual([]);
    await rm(base, { recursive: true, force: true });
    await expect(findStoreDirs(base)).rejects.toThrow("Cannot read folder");
  });
});

describe("createLocalPathReader", () => {
  it("lists and reads files under the source root", async () => {
    const reader = createLocalPathReader(nodePath.join(sourceRepo, "0-Extra/config-sync"));
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe("{}");
  });

  it("fails with a clear error when the root does not exist", async () => {
    const reader = createLocalPathReader(nodePath.join(sourceRepo, "no/such/root"));
    await expect(reader.listFiles()).rejects.toThrow("External store not found");
  });

  it("expandTilde expands a leading ~/", () => {
    expect(expandTilde("~/x/y")).toBe(nodePath.join(homedir(), "x/y"));
    expect(expandTilde("/abs/x")).toBe("/abs/x");
  });
});

describe("createGitReader", () => {
  it("lists and reads files from a remote branch", async () => {
    const reader = await createGitReader(sourceRepo, "main", "0-Extra/config-sync", null);
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("config-sync.json")).toBe('{"version":1,"groups":[]}');
  });

  it("fails with a contextual error for an unreachable remote", async () => {
    await expect(createGitReader("/no/such/repo", "main", "x", null)).rejects.toThrow("git -c core.autocrlf=false clone");
  });

  // Local file remotes never consult a credential helper, so this proves git accepts the
  // injected -c configuration for clone/sparse-checkout rather than dying on a malformed helper
  // string — not that credentials actually flow anywhere.
  it("lists and reads files from a remote branch with a real auth object injected", async () => {
    const reader = await createGitReader(sourceRepo, "main", "0-Extra/config-sync", REAL_AUTH);
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("config-sync.json")).toBe('{"version":1,"groups":[]}');
  });
});

describe("createLocalPathWriter", () => {
  it("writes files under the dest root and propagates deletions, round-tripping via the reader", async () => {
    const dest = await mkdtemp(nodePath.join(tmpdir(), "cs-dest-"));
    const storeDir = nodePath.join(dest, "0-Extra/config-sync");
    const writer = createLocalPathWriter(storeDir);
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":7}');
    expect(await writer.readFile("store/configdir/hotkeys.json")).toBe('{"a":7}');
    await writer.finalize();
    const reader = createLocalPathReader(storeDir);
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":7}');
    await writer.deleteFile("store/configdir/hotkeys.json");
    expect((await createLocalPathReader(storeDir).listFiles())).toEqual(["config-sync.json"]);
    await rm(dest, { recursive: true, force: true });
  });
});

describe("createGitWriter", () => {
  it("commits and pushes the store to the remote branch, visible to a fresh reader", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg", null);
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":42}');
    expect(await writer.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
    await writer.finalize();
    const reader = await createGitReader(bareRemote, "main", "cfg", null);
    expect(await reader.listFiles()).toContain("store/configdir/hotkeys.json");
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
  });

  it("propagates deletions on the remote", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg", null);
    // only config-sync.json this time — the previously pushed hotkeys.json must disappear
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    for (const rel of await writer.listFiles()) {
      if (rel !== "config-sync.json") await writer.deleteFile(rel);
    }
    await writer.finalize();
    const reader = await createGitReader(bareRemote, "main", "cfg", null);
    expect(await reader.listFiles()).toEqual(["config-sync.json"]);
  });

  it("git writer at repo root (subdir '') skips .git and round-trips", async () => {
    const writer = await createGitWriter(bareRemote, "main", "", null);
    await writer.writeFile("config-sync.json", "{}");
    await writer.finalize();
    const reader = await createGitReader(bareRemote, "main", "", null);
    expect(await reader.listFiles()).toContain("config-sync.json");
    const writer2 = await createGitWriter(bareRemote, "main", "", null);
    const files = await writer2.listFiles();
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
    await writer2.finalize(); // no changes → cleans up
  });

  // Same rationale as the reader's real-auth case above: local file remotes never consult a
  // credential helper, so this proves git accepts the injected -c configuration for
  // clone/add/status/commit/push, not that credentials actually flow anywhere.
  it("commits and pushes with a real auth object injected", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg", REAL_AUTH);
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":42}');
    expect(await writer.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
    await writer.finalize();
    const reader = await createGitReader(bareRemote, "main", "cfg", REAL_AUTH);
    expect(await reader.listFiles()).toContain("store/configdir/hotkeys.json");
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
  });
});
