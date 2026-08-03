# Remote-compare convergence & feedback — design

Date: 2026-08-04
Baseline: 2.13.2 (Draft). Target: 2.13.3 (patch; UX + convergence fixes, no new
API surface, no version floor change — minAppVersion stays 1.11.4).

## Context

Field report against 2.13.2, four distinct problems, all on the Sync Center
remote-compare path:

1. **Top-right refresh doesn't re-check remotes.** Users read it as a global
   refresh; when a remote pane is open it does not refresh the remote's state.
2. **"remote has newer version info" banner never clears.** With all store files
   matching, the pane shows `✓ contents match — remote has newer version info;
   Pull refreshes it`; clicking Pull, then re-comparing, leaves the banner up.
3. **A silent gap before `comparing…` appears.** After clicking the sidebar
   refresh, there is a visible dead pause before any progress shows.
4. **`comparing…` looks dead.** No spinner, no timer, no phase — indistinguishable
   from a hang.

2.13.2 isolated the git reader into a disposable temp-dir clone (correct, and
kept). The side effect: **every remote operation is now a fresh full clone**, and
the compare path does **two** clones per remote per refresh (`checkRemote` then
`deepDiff`). That latency is real and is what made #3/#4 visible.

## Root causes (verified from code, 2.13.2)

- **#1** — `SyncCenterView.ts:966-970`: the top-right button's tooltip is literally
  `"Refresh local state"` and its click calls only `this.reload()`. `reload()`
  recomputes local status via `computeStatuses()` but never calls
  `refreshRemoteChecks()`. Re-checking remotes lives solely on the sidebar
  `"Re-check remotes"` button (`:825-829 → host.refreshRemoteChecks()`).
- **#2** — `remoteLockAhead` (`status.ts:210-230`) returns true when **any** remote
  lock group entry (outside `ignoreGroups`) is missing-from or different-from the
  local lock. `applyImport`'s lock merge (`ConfigSyncCore.ts:880-898`) copies remote
  lock entries **only for `remoteWonNames`** — groups that won a file write or were
  byte-identical (`plan.auto.identical`). Any remote lock entry with **no comparable
  store file** — cross-contract content outside this vault's registry, or a group
  whose identical files `owningGroupName` cannot attribute — is never copied. The two
  functions consult **different sets**, so `remoteLockAhead` cannot converge. The
  comments at `:315-322` and `:885` acknowledge this class of entry but the fix only
  covers `remoteWonNames`. (This is exactly the "secondary symptom" 2.13.2's spec
  deferred to live-verify; live-verify confirmed it persists → fix here.)
- **#3** — `refreshRemoteChecks` (`main.ts:366-385`) loops remotes and runs
  `checkRemote` (a full clone each) **serially with no UI signal**, then
  `notifySyncCenter → reload → render` finally paints `comparing…`. The dead pause is
  the `checkRemote` clone(s) running invisibly.
- **#4** — `renderRemoteDetail` (`SyncCenterView.ts:2215-2217`) writes a **static**
  `comparing…` string, then `await host.deepDiff` runs a **second** clone. No
  spinner, no timer, no phase, two clones.

## Scope / design

### 1. Global refresh (#1)

Make the top-right refresh mean "refresh everything". Its click calls
`host.refreshRemoteChecks()` (desktop: re-checks every remote, then its own
`notifySyncCenter → reload` recomputes local; mobile: `refreshRemoteChecks`
no-ops on `!Platform.isDesktop`, so also call `reload()` so local still
refreshes). Update the tooltip from `"Refresh local state"` to `"Refresh"`.
The sidebar `"Re-check remotes"` button stays as the per-context remote refresh.

### 2. Lock-merge convergence (#2)

Make `applyImport`'s merged lock **converge `remoteLockAhead` by construction**:
after a pull, copy every non-ignored remote lock entry **except** groups whose file
conflict the user resolved as "local" (those legitimately keep the local lineage and
a real divergence the banner should still reflect on the next compare — but that path
has `entries.length > 0`, not the stuck-banner path).

**Invariant:** for every remote lock group `g` not in `ignoreGroups` and not a
local-won conflict, `mergedLock.groups[g] === remoteLock.groups[g]` after
`applyImport`. Given that, `remoteLockAhead(mergedLockRaw, remoteLockRaw,
ignoreGroups)` is `false` — the banner clears. In the all-files-match case (the stuck
banner) there are no conflicts, so **every** non-ignored remote entry transfers.

Why copying "phantom" entries is correct, not a lie: a pull is additive and never
deletes; store content outside this vault's registry stays in the store, and its lock
entry describes that content (`ConfigSyncCore.ts:315-322`). Recording it locally
mirrors what the store actually holds.

**Changes:**
- `PendingPull` carries `excludeSelf: boolean` (planImport already receives it as
  `opts.excludeSelf`; thread it through so `applyImport` knows the ignore set).
- `applyImport` (`ConfigSyncCore.ts:880-898`) lock merge: after seeding
  `mergedGroups` from the local lock, compute
  `localWonNames = fileConflicts where choice[i] === "local"`, then
  `for (const [name, entry] of Object.entries(remoteLock.groups)) { if (excludeSelf
  && name === SELF_GROUP_NAME) continue; if (localWonNames.has(name)) continue;
  mergedGroups[name] = entry; }`. This **subsumes** the existing `remoteWonNames`
  copy loop entirely (remote-won conflicts and identical groups are a subset of
  "non-ignored, not local-won"), so `remoteWonNames` — used nowhere else in
  `applyImport` (result ordering uses `orderedNames`) — is removed along with the
  loops that build it. `capturedAt` handling is unchanged (`remoteLock?.capturedAt ??
  localLock?.capturedAt ?? ctx.now()`).

`remoteLockAhead` itself is unchanged — it was already correct; the writer side was
the mismatch.

### 3. De-duplicate the clone (reader cache)

The 2.13.2 reader is a pure in-memory `Map` once built (temp dir already deleted), so
caching the reader object is cheap and holds no live temp dir. Share one clone between
`checkRemote` and the immediately-following `deepDiff`.

- Add a per-remote reader cache to the plugin keyed by remote identity
  (`name` + `url`/`storePath` + `branch` + `subdir`), tagged with a refresh
  generation counter.
- `createReader(remote, opts?: { reuse?: boolean })`:
  - `reuse: true` → return the cached reader if its generation matches the current
    refresh generation; otherwise build one and cache it.
  - default (no reuse) → always build fresh (used by pull/push and by the fresh
    per-remote checks).
- `refreshRemoteChecks` bumps the generation, builds one fresh reader per remote,
  runs `checkRemote` on it, and leaves it cached under the new generation.
- `deepDiff` calls `createReader(remote, { reuse: true })` — within the same refresh
  cascade it reuses the reader from `checkRemote`; a cold pane (no prior check) builds
  and caches one.
- Invalidate the cache entry for a remote when that remote is edited or removed, and
  on the app-level "refresh generation" bump. Never persisted; in-memory only.

Result: one clone per remote per refresh instead of two, with no correctness change
(reads only).

### 4. Compare-progress feedback

Replace the static `comparing…` with the approved **variant B** indicator and paint
the working state **synchronously on refresh click** (approved **option 2**).

**Compare indicator (variant B), in `renderRemoteDetail`:**
- Spinner (CSS) + `Comparing with <remote>` + a **live elapsed timer** (`N.Ns`, a
  UI-local `setInterval`, cleared on completion/teardown) + an **indeterminate
  progress bar** + a **phase line** driven by real step boundaries, not a fake timer.
- Real phases: `deepDiff` accepts an optional `onPhase("fetch" | "compare")` callback
  and calls `onPhase("fetch")` before `createReader`, `onPhase("compare")` before
  `diffRemote`. UI maps: fetch → `Fetching remote…`, compare → `Comparing files…`.
  When the reader is a warm cache hit, the fetch phase is instant and the UI jumps
  straight to compare — honest.
- `prefers-reduced-motion`: freeze the spinner and progress-bar animations; keep the
  timer and phase text.

**Refresh working state (option 2):** on the global (top-right) and sidebar refresh
clicks:
- Spin the ↻ button from the instant of click (CSS class), cleared when the refresh
  completes.
- Paint the working state **before** awaiting any clone — no silent gap.
- Sidebar remote rows show a small spinner in the status-glyph slot while their check
  is in flight.
- The open remote pane shows an aggregate line `Checking <N> remotes… <M> done`,
  incremented as each remote resolves. Backed by real progress: `refreshRemoteChecks`
  publishes `{ total, done }` (a field on the plugin, updated per remote) and notifies
  the view after each remote so the count is truthful, not timed.

All new CSS lives in `styles.css` alongside the existing `config-sync-remote-*`
classes; no inline styles in TS beyond toggling state classes.

## Non-goals

- No background prefetch on pane open (option 3 was declined) — the cache only
  de-dups within an active refresh.
- No change to `remoteLockAhead`, `checkRemote`, or the RemoteState pill semantics.
- No change to the writer, the git isolation from 2.13.2, timeouts, the field set,
  auto-check cadence, or `minAppVersion`.
- No change to Pull/Push payload semantics — only the post-pull lock merge converges.

## Testing

- **`tests/core.test.ts` / `tests/status.test.ts` (Vitest):** the convergence fix is
  the priority. First a **red** reproduction: build a local lock missing a remote
  "phantom" group entry (a group present in `remoteLock.groups` with no comparable
  store file) with all store files identical; assert `remoteLockAhead(local, remote,
  [])` is `true`, run `planImport` + `applyImport`, then assert `remoteLockAhead` on
  the rewritten local lock is `false`. Add a case for the `excludeSelf` ignore set
  (self entry differs but is ignored → still converges) and a case where a file
  conflict resolved "local" keeps the local lineage (does **not** get overwritten).
- **`tests/external.test.ts` (real git):** confirm `deepDiff`/`checkRemote` reader
  reuse builds one clone per refresh generation and fresh clones across generations —
  assert via the existing real-repo harness (e.g. spy/observe clone count or a fresh
  file appearing) without touching the vault.
- **Manual UI (dev vault + real remote):** top-right refresh re-checks remotes;
  `comparing…` shows spinner + ticking timer + phase + bar and never a silent gap;
  the ↻ button spins on click; the aggregate `Checking N remotes… M done` line counts
  up; the "newer version info" banner clears after a single Pull and stays clear on
  re-compare; `prefers-reduced-motion` freezes animation but keeps timer/phase.
- **Gates:** `npm run build`, `npm test`, `npm run lint` (0 errors; hold the
  established warning baseline).
