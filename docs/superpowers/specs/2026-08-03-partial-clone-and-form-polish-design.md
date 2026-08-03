# Partial clone + remote-form polish — design

Date: 2026-08-03
Mockup (定稿): claude.ai artifact "Remote form — 2.13.1 定稿"
(https://claude.ai/code/artifact/172716e7-1079-44d5-85e1-8dd4ad2f610d) — form copy and
layout there are final.
Baseline: 2.13.0. Target: 2.13.1 (patch; no new API surface, no version floor change —
minAppVersion stays 1.11.4).

## Context

Three field-report items against the 2.13.0 token release, batched as one patch:

1. **#4 — compare/pull/push time out on a large host repo.** Test connection succeeds
   (instant) but Sync Center hangs on "comparing…" and fails after 60 s. Root cause is
   transfer volume, not auth: `git ls-remote` (Test connection) reads refs only, while
   compare/pull go through `createGitReader` → `git fetch config-sync-import <branch>`
   (`gitSource.ts:109`, full history) and push goes through `createGitWriter` →
   `git clone --branch <branch> URL .` (`gitSource.ts:141`, full clone). The store is a
   small subdir of a ~1 GB vault repo, and the fetching vault shares no objects with it,
   so every compare/pull/push transfers the whole repo and exceeds `GIT_TIMEOUT_MS`
   (60 s). The 60 s bound is the safety net, not the bug.
2. **#1 — optional/required labels.** Three git-form labels carry a literal "(optional)"
   suffix (`SettingTab.ts:2698/2708/2710`); required fields carry no marker. Reported: use
   `*` for required, drop the "(optional)" text.
3. **#3 — token row misaligned.** `.config-sync-remote-token` (`styles.css:338-342`) is a
   `flex; align-items:flex-end` row holding the token field and the Username field.
   `SecretComponent` injects three block children (warning icon, value, button), so the
   token column stacks tall and ragged while Username is label+input — bottom-aligning two
   unequal columns puts the labels at different heights. The row is also a separate div
   from the `.config-sync-remote-git` grid with no top margin, so it glues to the row above.

(A fourth report — PAT echoing into the Username input — could not be reproduced and is
out of scope.)

## Scope

### 1. #4 — partial clone (blobless + shallow)

Transfer only the store subdir's data instead of the whole repo. Verified empirically in
git 2.55: a filtered fetch auto-marks the remote a promisor and `git show` lazily fetches
each blob; a sparse+shallow+partial clone supports edit/commit/shallow-push. A server that
rejects `--filter` warns and falls back to a plain (still-shallow) fetch — never fails.

**Reader — `createGitReader` (`gitSource.ts:109`)**

Change the one fetch:
```
["fetch", REMOTE_NAME, branch]
→ ["fetch", "--depth=1", "--filter=blob:none", REMOTE_NAME, branch]
```
Everything downstream is unchanged: `--filter=blob:none` auto-sets
`remote.config-sync-import.promisor=true` + `partialclonefilter`; the existing
`git ls-tree -r --name-only FETCH_HEAD [-- prefix]` works (trees are present); and each
`git show FETCH_HEAD:<path>` (`:124`) lazily fetches only that blob through the promisor
remote. The `show` calls already pass `auth`, so the lazy fetches authenticate. Net: the
commit + trees + only the blobs under the store subdir download, not full history.

**Writer — `createGitWriter` (`gitSource.ts:141`)**

Replace the full clone with a partial+shallow clone, sparse only when there is a subdir.
Extract a pure `buildCloneArgs(branch, remoteUrl, subdir)` (new exported function in
`gitSource.ts`) returning the arg array, so the subdir branch is unit-testable:
```
subdir === "":  ["clone","--depth=1","--filter=blob:none","--branch",branch,remoteUrl,"."]
subdir !== "":  ["clone","--depth=1","--filter=blob:none","--sparse","--branch",branch,remoteUrl,"."]
```
When `subdir !== ""`, follow the clone with `git sparse-checkout set <subdir>`. `--sparse`
alone initializes the cone to root-only files; `sparse-checkout set` expands it to the
store subdir, so the working tree materializes exactly that subdir (its blobs lazily
fetched at checkout). With no subdir the whole tree is needed, so `--sparse` is omitted and
the blobless clone still limits to HEAD blobs. `base`, walkFs, write/delete, `add -A`,
commit, and `push origin branch` are unchanged — `add -A` under a cone stages only in-cone
(subdir) changes, and the shallow push is valid because the fetched HEAD is the remote HEAD
(its parent exists on the server).

**Edge cases / accepted tradeoffs (record, not build):**
- **Lazy-read round trips.** The reader does one lazy fetch per file it reads. For a
  config-sync store (tens of small files) that is a few seconds, well inside 60 s. A single
  batched pre-fetch of the subdir blobs would remove it if a huge store ever made it slow —
  YAGNI now.
- **Server without partial-clone support.** git warns "filtering not recognized by server,
  ignoring" and does a plain shallow fetch/clone — still bounded, no failure.
- **Upgrade path.** A `config-sync-import` remote left non-promisor by an older version
  keeps its already-downloaded objects; a subsequent filtered fetch is additive and benign.
- **`.git/shallow` in the vault repo.** The reader fetches into the user's real vault repo
  (existing behavior — this change only shrinks what it downloads). `--depth=1` writes
  shallow grafts for the *config-sync-import* commits only; the vault's own branches are
  untouched. Live-verify that obsidian-git still commits/pushes the vault normally after a
  compare.

The 60 s `GIT_TIMEOUT_MS` and `gitEnv`/credential plumbing are unchanged.

### 2. #1 — required marking, drop "(optional)" (SettingTab + CSS)

- New helper `markRequired(field: HTMLElement): void` — appends
  `<span class="config-sync-required">*</span>` to the field's `label`. `formField` stays
  single-purpose (no flag parameter).
- Call `markRequired` on the four required fields: **Name** (`:2658`), **Store path**
  (vault, `:2670`), **URL** (`:2688`), **Branch** (`:2693`). **Type** is a dropdown that
  always has a value — no marker.
- Drop the "(optional)" text from three labels: `Store folder in repo (optional)` →
  `Store folder in repo` (`:2698`); `Access token (optional)` → `Access token` (`:2708`);
  `Username (optional)` → `Username` (`:2710`). No marker on these.
- CSS: `.config-sync-required { color: var(--color-red); margin-left: 2px; }`.

### 3. #3 — token-row alignment (SettingTab + CSS)

- **Wrap the SecretComponent in its own single-line control div.** In `renderRemoteForm`
  (`:2708-2709`), instead of passing the label's field straight to `SecretComponent`
  (which stacks its three block children), create a nested control div and pass that:
  ```ts
  const tokenField = field(tokenLine, "Access token");
  const tokenControl = tokenField.createDiv({ cls: "config-sync-secret-control" });
  const tokenC = new SecretComponent(this.app, tokenControl);
  ```
- **CSS** (`styles.css`, replacing the `.config-sync-remote-token` block at `:338-342`):
  ```css
  .config-sync-remote-token {
    display: grid;
    grid-template-columns: 1fr 12em;
    gap: var(--size-4-3);
    margin-top: var(--size-4-3);      /* unglue from the git grid above */
  }
  .config-sync-remote-token > div { display: flex; flex-direction: column; }
  /* token control and username input share a bottom baseline even if a label wraps */
  .config-sync-secret-control,
  .config-sync-remote-token > div input { margin-top: auto; }
  .config-sync-secret-control { display: flex; align-items: center; gap: var(--size-4-2); }
  ```
- Phone: add `body.is-phone .config-sync-remote-token { grid-template-columns: 1fr; }`
  beside the existing `.config-sync-remote-git` phone override (`:387`).
- No behavior, status-line copy, or data-model change.

## Non-goals

- No PAT/username echo work (could not reproduce).
- No batched blob pre-fetch, no spinner/Cancel, no abort-on-navigate (60 s bound stands).
- No change to `RemoteCheck` state, auto-check cadence, the field set, or `minAppVersion`.
- No restructuring of where the reader fetches (keeps using the vault repo).

## Testing

- **Unit (Vitest):** `buildCloneArgs` — asserts the subdir="" case omits `--sparse` and the
  subdir!="" case includes it, and both carry `--depth=1 --filter=blob:none --branch`. This
  is the only new branching logic.
- **Gates as usual:** `npm run build`, `npm test`, `npm run lint` (zero-warning baseline).
- **Live verify (dev vault + the real ~1 GB homelab remote):**
  - compare and Pull on the git remote complete within 60 s (no "comparing…" hang);
  - Push writes and shallow-pushes successfully; subdir and repo-root store paths both work;
  - obsidian-git still commits/pushes the vault after a compare (no `.git/shallow` fallout);
  - Remotes tab: required `*` on Name/URL/Branch/Store path, no "(optional)" text, token row
    single-line and baseline-aligned with Username, spaced from the URL grid — matches mockup.
