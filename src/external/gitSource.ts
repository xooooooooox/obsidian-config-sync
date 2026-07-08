import { execFile } from "child_process";
import { promisify } from "util";
import { ExternalStoreReader } from "../core/ConfigSyncCore";

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
  sourceRoot: string
): Promise<ExternalStoreReader> {
  const remotes = (await git(vaultBasePath, ["remote"])).split("\n").filter(Boolean);
  if (remotes.includes(REMOTE_NAME)) {
    await git(vaultBasePath, ["remote", "set-url", REMOTE_NAME, remoteUrl]);
  } else {
    await git(vaultBasePath, ["remote", "add", REMOTE_NAME, remoteUrl]);
  }
  await git(vaultBasePath, ["fetch", REMOTE_NAME, branch]);
  const prefix = sourceRoot.endsWith("/") ? sourceRoot : sourceRoot + "/";
  const listed = await git(vaultBasePath, ["ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", prefix]);
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
