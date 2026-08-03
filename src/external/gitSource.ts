import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, mkdir, writeFile, unlink, access, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";
import { GitAuth } from "../core/types";

const execFileP = promisify(execFile);
const REMOTE_NAME = "config-sync-import";
const GIT_TIMEOUT_MS = 60_000;

const EXTRA_PATH_DIRS = ["/usr/local/bin", "/opt/homebrew/bin"];

// GUI apps on macOS (and some Linux desktops) inherit a bare launchd PATH that misses the
// dirs where git credential helpers usually live; git then can't run the configured helper
// and every authenticated https call dies on "terminal prompts disabled". Windows GUI
// processes inherit the user PATH (";"-separated) — leave it untouched there.
// GCM_INTERACTIVE=never: a background process must never trigger a credential GUI — a
// misconfigured helper fails fast into the error card instead of an invisible prompt.
export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, auth: GitAuth | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  if (auth !== null) {
    env.CONFIG_SYNC_GIT_USER = auth.username;
    env.CONFIG_SYNC_GIT_TOKEN = auth.token;
  }
  if (platform === "win32") return env;
  const parts = (base.PATH ?? "").split(":").filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(":");
  return env;
}

// With a plugin-managed token the machine's credential chain is deliberately out of the
// loop: the first -c clears the configured helper list, the second injects an inline
// helper that reads both fields from the environment — neither ever appears in process
// arguments. `!`-helpers run through git's bundled sh (Git for Windows ships one too).
export const TOKEN_CREDENTIAL_ARGS: readonly string[] = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!f() { printf '%s\\n' \"username=$CONFIG_SYNC_GIT_USER\" \"password=$CONFIG_SYNC_GIT_TOKEN\"; }; f",
];

// Node rebuilds the failing command line — injected helper flags included — inside its own
// error message; strip them so an error card shows the caller's git command, not our
// credential plumbing. split/join, not a regex: the helper text is full of regex metacharacters.
export function stripCredentialArgs(message: string): string {
  return message.split(`${TOKEN_CREDENTIAL_ARGS.join(" ")} `).join("");
}

async function git(cwd: string, args: string[], auth: GitAuth | null): Promise<string> {
  const fullArgs = auth === null ? args : [...TOKEN_CREDENTIAL_ARGS, ...args];
  try {
    const { stdout } = await execFileP("git", fullArgs, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      // Fail fast on credential prompts; make helpers outside the GUI PATH reachable.
      env: gitEnv(process.env, process.platform, auth),
    });
    return stdout;
  } catch (e) {
    const err = e as Error & { killed?: boolean };
    // execFile kills the child on timeout (killed=true); maxBuffer kills too but says so.
    const detail =
      err.killed === true && !err.message.includes("maxBuffer")
        ? `timed out after ${GIT_TIMEOUT_MS / 1000}s`
        : stripCredentialArgs(err.message);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

export type LsRemoteResult = { kind: "ok"; branchFound: boolean } | { kind: "error"; message: string };

// Pure classification of an ls-remote outcome. Empty stdout = repo reachable but branch absent.
export function classifyLsRemote(outcome: { stdout: string } | { error: Error }): LsRemoteResult {
  if ("error" in outcome) return { kind: "error", message: outcome.error.message };
  return { kind: "ok", branchFound: outcome.stdout.trim() !== "" };
}

// Reachability + auth check without downloading objects. Never throws — a failed git call
// (unreachable host, auth failure, bad URL) becomes { kind: "error" }. cwd is irrelevant for
// ls-remote against a URL, so "." (the spawn's working dir) is fine.
export async function gitLsRemote(remoteUrl: string, branch: string, auth: GitAuth | null): Promise<LsRemoteResult> {
  try {
    const stdout = await git(".", ["ls-remote", "--heads", remoteUrl, branch], auth);
    return classifyLsRemote({ stdout });
  } catch (e) {
    return classifyLsRemote({ error: e as Error });
  }
}

export async function createGitReader(
  vaultBasePath: string,
  remoteUrl: string,
  branch: string,
  subdir: string,
  auth: GitAuth | null
): Promise<ExternalStoreReader> {
  const remotes = (await git(vaultBasePath, ["remote"], auth)).split("\n").filter(Boolean);
  if (remotes.includes(REMOTE_NAME)) {
    await git(vaultBasePath, ["remote", "set-url", REMOTE_NAME, remoteUrl], auth);
  } else {
    await git(vaultBasePath, ["remote", "add", REMOTE_NAME, remoteUrl], auth);
  }
  await git(vaultBasePath, ["fetch", REMOTE_NAME, branch], auth);
  const prefix = subdir === "" ? "" : subdir.endsWith("/") ? subdir : subdir + "/";
  const lsArgs = ["ls-tree", "-r", "--name-only", "FETCH_HEAD"];
  if (prefix !== "") lsArgs.push("--", prefix);
  const listed = await git(vaultBasePath, lsArgs, auth);
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
      return git(vaultBasePath, ["show", `FETCH_HEAD:${prefix}${relPath}`], auth);
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

export async function createGitWriter(remoteUrl: string, branch: string, subdir: string, auth: GitAuth | null): Promise<ExternalStoreWriter> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-push-"));
  await git(dir, ["clone", "--branch", branch, remoteUrl, "."], auth);
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
    async readFile(relPath: string): Promise<string> {
      return readFile(nodePath.join(base, relPath), "utf8");
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
      await git(dir, ["add", "-A"], auth);
      const status = await git(dir, ["status", "--porcelain"], auth);
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
        ], auth);
        await git(dir, ["push", "origin", branch], auth);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
