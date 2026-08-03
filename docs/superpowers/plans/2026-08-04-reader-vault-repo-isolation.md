# Reader vault-repo isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the git reader from mutating the user's live vault repo — do the blobless+shallow store fetch in a disposable temp dir instead, killing the `fatal: shallow file has changed since we read it` regression.

**Architecture:** `createGitReader` becomes symmetric with `createGitWriter`: it clones the store subdir into a `mkdtemp` temp dir (reusing `buildCloneArgs`), sparse-checks-out the subdir, reads every store file into an in-memory `Map`, deletes the temp dir, and returns a memory-backed `ExternalStoreReader`. The vault git repo is never touched. `main.ts` stops passing the vault base path.

**Tech Stack:** TypeScript, Node `child_process`/`fs`/`os` (desktop-only path, dynamically imported), Vitest.

## Global Constraints

- Target 2.13.2 — patch only. No new API surface; `minAppVersion` stays **1.11.4**; `versions.json` floor unchanged.
- **NO-COMMITS mode:** implementers do NOT commit. Leave the working tree as the user's review state; the single commit happens at cut, by the controller. No Claude attribution anywhere.
- Token value must never reach process arguments, logs, error messages, `data.json`, or the store — only pass `auth` to the existing `git()` helper, which already injects credentials via env, never argv. Do not log or interpolate token/username.
- Reader reads eagerly into memory (justified: the core reads every store file anyway; a config store is small even when the host repo is ~1 GB).
- Gate: `npm run build` clean, `npm test` = 849 passing, `npm run lint` = 0 errors (established 58-warning baseline; add 0 new).
- No new fake/mock tests (repo convention: git I/O is not unit-tested; only pure helpers are). Existing `buildCloneArgs` cases stay green.

---

### Task 1: Isolate the reader into a temp dir

**Files:**
- Modify: `src/external/gitSource.ts` — rewrite `createGitReader` (`:96-127`); delete unused `REMOTE_NAME` const (`:10`).
- Modify: `src/main.ts` — `createReader` (`:1185-1193`), drop the vault base-path argument.
- Test: none added (see Global Constraints). `tests/gitSource.test.ts` unchanged; it only imports `buildCloneArgs`/`classifyLsRemote`.

**Interfaces:**
- Consumes: existing exports in `gitSource.ts` — `buildCloneArgs(branch, remoteUrl, subdir): string[]`, `git(cwd, args, auth): Promise<string>`, `walkFs(absBase, rel, out): Promise<void>`; fs/os imports already present (`mkdtemp`, `rm`, `access`, `readFile`, `tmpdir`, `nodePath`).
- Produces: `createGitReader(remoteUrl: string, branch: string, subdir: string, auth: GitAuth | null): Promise<ExternalStoreReader>` — **4 args, `vaultBasePath` removed**. Return shape unchanged: `{ listFiles(): Promise<string[]>; readFile(relPath: string): Promise<string> }`.

- [ ] **Step 1: Confirm the pre-change gate is green**

Establishes the 849/0-error baseline before editing.

Run: `npm run build && npm test && npm run lint`
Expected: build OK; 849 tests pass; lint 0 errors (58 warnings).

- [ ] **Step 2: Rewrite `createGitReader` in `src/external/gitSource.ts`**

Replace the whole function at `:96-127` with:

```ts
export async function createGitReader(
  remoteUrl: string,
  branch: string,
  subdir: string,
  auth: GitAuth | null
): Promise<ExternalStoreReader> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-read-"));
  try {
    await git(dir, buildCloneArgs(branch, remoteUrl, subdir), auth);
    if (subdir !== "") await git(dir, ["sparse-checkout", "set", subdir], auth);
    const base = subdir === "" ? dir : nodePath.join(dir, subdir);
    const map = new Map<string, string>();
    try {
      await access(base);
      const rels: string[] = [];
      await walkFs(base, "", rels);
      for (const rel of rels) {
        map.set(rel, await readFile(nodePath.join(base, rel), "utf8"));
      }
    } catch {
      // store root not present on the remote yet — leave the map empty
    }
    return {
      async listFiles(): Promise<string[]> {
        return [...map.keys()].sort();
      },
      async readFile(relPath: string): Promise<string> {
        const value = map.get(relPath);
        if (value === undefined) throw new Error(`file not in remote store: ${relPath}`);
        return value;
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Notes for the implementer:
- The outer `readFile` (fs/promises, imported at `:3`) is used inside the walk loop; the returned object's own `readFile` method reads the in-memory map and never calls the fs one — no collision.
- `walkFs` already skips `.git` at its root; with a subdir, `base` is below `.git`, so it is never encountered.
- Keep `finally { rm }` so the temp dir is deleted on both the happy path (after everything is in memory) and on any git/fs error.

- [ ] **Step 3: Delete the now-unused `REMOTE_NAME` constant**

In `src/external/gitSource.ts:10`, remove:
```ts
const REMOTE_NAME = "config-sync-import";
```
It was referenced only by the old reader body just replaced. (Grep `REMOTE_NAME` across `src/` to confirm zero remaining references before deleting.)

- [ ] **Step 4: Update the caller in `src/main.ts`**

Replace `createReader`'s git branch (`:1190-1192`):
```ts
    const { createGitReader } = await import("./external/gitSource");
    const adapter = this.app.vault.adapter as unknown as { getBasePath(): string };
    return createGitReader(adapter.getBasePath(), remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
```
with:
```ts
    const { createGitReader } = await import("./external/gitSource");
    return createGitReader(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
```
The `adapter` local was only used to build the removed argument. Leave the surrounding `remote.type === "vault"` branch and the dynamic-import comment untouched.

- [ ] **Step 5: Type-check and lint the changed files**

Run: `npm run build && npm run lint`
Expected: build OK (no unused-symbol / arity errors — confirms `REMOTE_NAME` and the base-path arg are fully removed); lint 0 errors, 58 warnings (0 new).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 849 pass. `buildCloneArgs` cases still green (the reader now shares that arg builder with the writer).

- [ ] **Step 7: Static self-verification of the isolation invariant**

Grep the reader path to prove the vault repo is no longer touched:
- `grep -n "getBasePath\|REMOTE_NAME\|config-sync-import\|FETCH_HEAD" src/external/gitSource.ts src/main.ts`
Expected: no match in the reader path or `main.ts`'s `createReader`. (`config-sync-import`/`FETCH_HEAD`/`REMOTE_NAME` should be entirely gone from `gitSource.ts`; `getBasePath` gone from `createReader`.)

- [ ] **Step 8: NO-COMMITS — stop here**

Do not commit. Report status, the exact files touched, and the Step 5/6 gate output. Leave the working tree as the review state.

---

## Post-implementation (controller, not a task)

- **Verify the manual cleanup sequence on a throwaway clone** (spec §2) before handing it to the user:
  `remote remove config-sync-import` → `rm .git/FETCH_HEAD` → `rm .git/shallow` → `git gc --prune=now`; confirm `git rev-parse --is-shallow-repository` → `false`, `git status`/`git log` work.
- **Docs-currency** re-check at cut (README/GUIDE describe token privacy + field set, not reader transport — expected no change).
- **Live-verify** per spec (dev vault + real ~1 GB homelab remote): compare/Pull don't mutate the vault repo, no shallow-file error under repeated Refresh, subdir + repo-root paths read, "remote is newer" banner clears after Pull.
- 2.13.1 Draft is superseded — do not publish; cut 2.13.2.

## Self-Review

- **Spec coverage:** §1 reader isolation → Steps 2-4; `REMOTE_NAME` removal → Step 3; caller update → Step 4; §2 manual cleanup + §3 bookkeeping → Post-implementation (controller scope, not code). All spec code items map to a step.
- **Placeholder scan:** none — every code step carries the actual code; the one error message is concrete.
- **Type consistency:** new 4-arg `createGitReader` signature matches the single caller in Step 4; return shape matches `ExternalStoreReader` (`listFiles`/`readFile`). `buildCloneArgs`/`git`/`walkFs` signatures used exactly as defined in `gitSource.ts`.
