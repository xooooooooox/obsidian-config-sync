# Reader vault-repo isolation — design

Date: 2026-08-04
Baseline: 2.13.1 (Draft, never published). Target: 2.13.2 (patch; no new API
surface, no version floor change — minAppVersion stays 1.11.4).

## Context

Field report against the 2.13.1 dev build: after a while, Sync Center's compare fails with

```
git fetch --depth=1 --filter=blob:none config-sync-import main failed in <vault>:
fatal: shallow file has changed since we read it
```

surfaced as "Couldn't compare — couldn't reach this remote". The user reached it by
repeatedly clicking Refresh because a "remote has newer version info → Pull" banner would
not clear after a Pull.

### Root cause (verified, not reasoned)

`createGitReader` runs its fetch **in the user's live vault git repo**: `main.ts:1192`
passes `adapter.getBasePath()` as the working repo, and `gitSource.ts:103-109` does
`git remote add config-sync-import <url>` + `git fetch --depth=1 --filter=blob:none
config-sync-import <branch>` there. Inspecting an affected repo (`llm-wiki.vault`) confirms
the damage this leaves behind:

- `git rev-parse --is-shallow-repository` → `true` — the vault repo is now a **shallow**
  repository (a `.git/shallow` marker exists).
- `remote.config-sync-import.promisor true` + `partialclonefilter blob:none`, URL pointing
  at a **foreign** repo (`kickstart.vault.git`, not the vault's own origin
  `llm-wiki.vault.git`) — the vault is now a **partial clone from an unrelated remote**.

Once `.git/shallow` exists, every fetch in that repo — Config Sync's next compare, or
obsidian-git's own operations — must read and rewrite the shallow file. Two git processes
overlapping (repeated Refresh clicks; or a compare concurrent with obsidian-git) race on it,
producing `fatal: shallow file has changed since we read it`.

**This is a 2.13.1 regression.** Before 2.13.1 the reader did a plain full
`git fetch config-sync-import <branch>` in the vault repo — messy (it always added a foreign
remote there) but benign: no `.git/shallow`, no promisor flag, no shallow-file race. The
2.13.1 `--depth=1 --filter=blob:none` turned that benign side effect into a repo-mutating,
race-prone one. The prior spec (2026-08-03, lines 86-90) foresaw `.git/shallow` landing in
the vault repo but classified it an accepted tradeoff and only asked to live-verify
obsidian-git commits — it missed the concurrent-fetch race and the foreign-promisor mutation.

The secondary symptom (Pull banner won't clear) is downstream: compares keep failing on the
shallow race, so sync state never converges to "in sync" and the banner keeps nagging. It is
expected to settle once compares stop failing; re-confirm on live-verify rather than fix
separately.

## Scope

### 1. Move the reader out of the vault repo (code)

Make the reader symmetric with the writer: do the blobless+shallow(+sparse) clone in an
isolated temp dir, read the store into memory, delete the temp dir, and return a
memory-backed reader. The plugin never touches the vault git repo again.

**`createGitReader` (`gitSource.ts:96-127`) — rewrite. New signature drops `vaultBasePath`:**
```ts
export async function createGitReader(
  remoteUrl: string,
  branch: string,
  subdir: string,
  auth: GitAuth | null
): Promise<ExternalStoreReader>
```
Body:
1. `const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-read-"));`
2. `await git(dir, buildCloneArgs(branch, remoteUrl, subdir), auth);` — reuses the existing
   exported `buildCloneArgs` verbatim (same blobless+shallow, `--sparse` only when subdir set).
3. `if (subdir !== "") await git(dir, ["sparse-checkout", "set", subdir], auth);` — expands
   the cone to the store subdir, materializing exactly that subdir's blobs.
4. `const base = subdir === "" ? dir : nodePath.join(dir, subdir);`
5. Walk `base` with the existing `walkFs`, reading every file into a `Map<string,string>`
   (`await readFile(nodePath.join(base, rel), "utf8")`). If `base` is absent (store not on
   the remote yet), the map stays empty — mirror the writer's `access(base)` guard.
6. `await rm(dir, { recursive: true, force: true });`
7. Return `{ listFiles: async () => [...map.keys()].sort(), readFile: async (rel) => { const v = map.get(rel); if (v === undefined) throw new Error(\`file not in remote store: ${rel}\`); return v; } }`.

Eager read-all is correct here: the core reads every store file anyway (`planImport` loops
`reader.readFile` over all files, `remoteGroupsFrom` reads the self `data.json`), and a
config store is small (plugin `data.json` files) even when the host repo is ~1 GB — that
smallness is exactly what the blobless+sparse clone delivers. Reading into memory removes any
need for a reader `dispose()` hook or a surviving temp dir.

**Remove** the now-dead `config-sync-import` machinery from the reader path: the
`git remote`/`remote add`/`remote set-url`, the `fetch`, the `ls-tree FETCH_HEAD`, and the
`git show FETCH_HEAD:` read. The `REMOTE_NAME` constant (`gitSource.ts:10`) becomes unused —
delete it (writer never referenced it).

**`main.ts:1185-1193` — `createReader`.** Stop passing the base path:
```ts
const { createGitReader } = await import("./external/gitSource");
return createGitReader(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
```
The `adapter`/`getBasePath()` lines here are used only for the git reader, so they go with it.

The writer, `gitEnv`/credential plumbing, `GIT_TIMEOUT_MS`, `gitLsRemote`, and
`buildCloneArgs` are all unchanged. The 2.13.1 speed win is preserved — the reader still
transfers only the store subdir's data.

### 2. Clean up already-damaged repos (manual commands, NOT in the plugin)

Decision: the plugin never touches the vault repo, so it does **not** auto-heal. The user
runs a one-time cleanup per affected repo per machine. `.git/shallow` cannot simply be
deleted while the foreign shallow-root commit is still referenced (its parents are absent →
missing-parent errors on any walk), so the safe order is: drop the remote and its refs first,
clear the leftover FETCH_HEAD tip, then remove the shallow marker, then gc the now-unreachable
shallow commit.

```
git -C <vault> remote remove config-sync-import
rm -f <vault>/.git/FETCH_HEAD
rm -f <vault>/.git/shallow
git -C <vault> gc --prune=now
git -C <vault> rev-parse --is-shallow-repository   # expect: false
```

`remote remove` also drops all `remote.config-sync-import.*` keys (promisor +
partialclonefilter), so the repo is no longer a partial clone. **This exact sequence must be
verified on a throwaway clone before being handed to the user** — confirm `is-shallow-repository`
flips to `false`, `git status`/`git log` still work, and obsidian-git can still commit/push.
Deliver the verified commands in the release notes / to the user; do not ship them as code.

### 3. Release bookkeeping

- The Draft 2.13.1 is superseded — do not publish it; 2.13.2 replaces it.
- Docs-currency: README and GUIDE describe token privacy and the field set, not the reader's
  internal transport, so no doc change is expected; re-confirm at cut.

## Non-goals

- No auto-heal of damaged repos (explicit user decision — manual commands only).
- No change to the writer (its temp-dir clone was already isolated and correct).
- No change to `RemoteCheck` state, the "remote is newer" banner logic, auto-check cadence,
  the field set, timeouts, or `minAppVersion`.
- No separate fix for the Pull-banner symptom (expected to resolve once compares stop racing;
  re-open only if live-verify shows it persists).

## Testing

- **Integration (Vitest, real git):** `tests/external.test.ts` spins up real local git repos
  and exercises `createGitReader`/`createGitWriter` end to end — it is the coverage for this
  change, not a mock. Its edits: drop the removed `vaultBasePath` arg from every
  `createGitReader` call; change the unreachable-remote assertion from `git fetch` to
  `git clone` (the reader now clones); and remove the code made dead by the isolation — the
  `consumerRepo` fixture (the old reader's target vault repo) and the "updates the remote url
  on subsequent calls" test (meaningless once each read uses a fresh temp dir with no
  persistent remote). No mock tests added; isolation is now guaranteed by the signature (the
  reader receives no local repo path), so there is nothing new to assert at runtime.
- **Gates as usual:** `npm run build`, `npm test` (848 — one obsolete test removed),
  `npm run lint` (0 errors; established 58-warning baseline).
- **Live verify (dev vault + real ~1 GB homelab remote):**
  - compare and Pull complete within 60 s and the vault repo is **not** mutated —
    `git -C <vault> rev-parse --is-shallow-repository` stays `false` and no
    `config-sync-import` remote appears after a compare;
  - repeated Refresh / compare while obsidian-git is active never produces
    "shallow file has changed since we read it";
  - subdir and repo-root store paths both read correctly;
  - the "remote is newer" banner clears after a Pull (confirms the secondary symptom was
    downstream);
  - the manual cleanup sequence flips an already-damaged repo back to non-shallow with
    obsidian-git still committing/pushing.
