import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitReader } from "../src/external/gitSource";
import { createLocalPathReader } from "../src/external/localPath";

const run = promisify(execFile);

let sourceRepo: string;
let consumerRepo: string;

beforeAll(async () => {
  sourceRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-source-"));
  consumerRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-consumer-"));
  await mkdir(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir"), { recursive: true });
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/manifest.json"), '{"version":1,"groups":[]}');
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir/hotkeys.json"), "{}");
  await run("git", ["init", "-b", "main"], { cwd: sourceRepo });
  await run("git", ["add", "."], { cwd: sourceRepo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: sourceRepo });
  await run("git", ["init", "-b", "main"], { cwd: consumerRepo });
});

afterAll(async () => {
  await rm(sourceRepo, { recursive: true, force: true });
  await rm(consumerRepo, { recursive: true, force: true });
});

describe("createLocalPathReader", () => {
  it("lists and reads files under the source root", async () => {
    const reader = createLocalPathReader(sourceRepo, "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["manifest.json", "store/configdir/hotkeys.json"]);
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
    expect(await reader.listFiles()).toEqual(["manifest.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("manifest.json")).toBe('{"version":1,"groups":[]}');
    const status = (await run("git", ["status", "--porcelain"], { cwd: consumerRepo })).stdout;
    expect(status).toBe("");
  });

  it("updates the remote url on subsequent calls instead of failing", async () => {
    const reader = await createGitReader(consumerRepo, sourceRepo, "main", "0-Extra/config-sync");
    expect(await reader.listFiles()).toContain("manifest.json");
  });

  it("fails with a contextual error for an unreachable remote", async () => {
    await expect(createGitReader(consumerRepo, "/no/such/repo", "main", "x")).rejects.toThrow("git fetch");
  });
});
