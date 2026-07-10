import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, mkdir, writeFile, unlink, access, readdir } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

const execFileP = promisify(execFile);
const REMOTE_NAME = "config-sync-import";

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(e as Error).message}`);
  }
}

export async function createGitReader(
  vaultBasePath: string,
  remoteUrl: string,
  branch: string,
  subdir: string
): Promise<ExternalStoreReader> {
  const remotes = (await git(vaultBasePath, ["remote"])).split("\n").filter(Boolean);
  if (remotes.includes(REMOTE_NAME)) {
    await git(vaultBasePath, ["remote", "set-url", REMOTE_NAME, remoteUrl]);
  } else {
    await git(vaultBasePath, ["remote", "add", REMOTE_NAME, remoteUrl]);
  }
  await git(vaultBasePath, ["fetch", REMOTE_NAME, branch]);
  const prefix = subdir === "" ? "" : subdir.endsWith("/") ? subdir : subdir + "/";
  const lsArgs = ["ls-tree", "-r", "--name-only", "FETCH_HEAD"];
  if (prefix !== "") lsArgs.push("--", prefix);
  const listed = await git(vaultBasePath, lsArgs);
  const files = listed
    .split("\n")
    .filter(Boolean)
    .map((f) => f.slice(prefix.length))
    .sort();
  return {
    async listFiles(): Promise<string[]> {
      return files;
    },
    async readFile(relPath: string): Promise<string> {
      return git(vaultBasePath, ["show", `FETCH_HEAD:${prefix}${relPath}`]);
    },
  };
}

async function walkFs(absBase: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(nodePath.join(absBase, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (rel === "" && entry.name === ".git") continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walkFs(absBase, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }
}

export async function createGitWriter(remoteUrl: string, branch: string, subdir: string): Promise<ExternalStoreWriter> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-push-"));
  await git(dir, ["clone", "--branch", branch, remoteUrl, "."]);
  const base = subdir === "" ? dir : nodePath.join(dir, subdir);
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await access(base);
        await walkFs(base, "", out);
      } catch {
        // root not present in the remote yet
      }
      return out.sort();
    },
    async writeFile(relPath: string, content: string): Promise<void> {
      const target = nodePath.join(base, relPath);
      await mkdir(nodePath.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    async deleteFile(relPath: string): Promise<void> {
      await unlink(nodePath.join(base, relPath)).catch(() => undefined);
    },
    async finalize(): Promise<void> {
      await git(dir, ["add", "-A"]);
      const status = await git(dir, ["status", "--porcelain"]);
      if (status.trim() === "") {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      try {
        const stamp = new Date().toISOString();
        await git(dir, [
          "-c",
          "user.email=config-sync@local",
          "-c",
          "user.name=config-sync",
          "commit",
          "-m",
          `config-sync push: ${stamp}`,
        ]);
        await git(dir, ["push", "origin", branch]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
