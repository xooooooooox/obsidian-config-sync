# Remote-compare convergence & feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four Sync Center remote-compare problems from the 2.13.2 field report: the "remote has newer version info" banner that never clears, the top-right refresh that ignores remotes, and the slow/dead-looking `comparing…` state.

**Architecture:** One core-logic fix (pull lock-merge converges `remoteLockAhead` by construction), one backend optimization (per-refresh in-memory reader cache so a compare clones once, not twice), and two UI changes (global refresh wiring + a live variant-B compare indicator with an aggregate refresh progress line). Backend before UI so the UI consumes stable interfaces.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (unit + real-git integration), plain CSS in `styles.css`.

## Global Constraints

- Target version 2.13.3; **do not** bump `minAppVersion` (stays `1.11.4`). No version bump happens in these tasks — the controller bumps at cut.
- **NO-COMMITS mode:** implementers do not commit. The working tree is the review state; a single commit happens at cut by the controller. (The per-task "Commit" steps below are intentionally omitted for this reason.)
- No Claude/AI attribution anywhere.
- No new public API surface; no change to `remoteLockAhead`, `checkRemote`, RemoteState pill semantics, the writer, 2.13.2's git isolation, timeouts, the field set, or auto-check cadence.
- **No fake data:** progress phases and the aggregate count reflect real step boundaries and real per-remote completion, never a timer standing in for work. The elapsed-seconds ticker is the one allowed UI-local timer (it measures real elapsed time).
- New CSS goes in `styles.css` next to the existing `config-sync-*` classes; in TS, toggle state classes only — no inline style strings.
- Respect `prefers-reduced-motion` for every animation added.
- Gates each task: `npm run build`, `npm test`, `npm run lint` (0 errors; hold the established warning baseline).

---

### Task 1: Pull lock-merge converges the "newer version info" hint (#2)

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`PendingPull` ~799-803; `planImport` return ~829; `applyImport` lock merge ~860-898)
- Test: `tests/core.test.ts` (`describe("planImport / applyImport")` ~850)

**Interfaces:**
- Consumes: `remoteLockAhead(localRaw, remoteRaw, ignoreGroups)` from `src/core/status.ts` (unchanged); `SELF_GROUP_NAME = "plugin-config-sync"` from `src/core/catalog.ts`.
- Produces: `PendingPull` gains `excludeSelf: boolean`. `applyImport(ctx, pending, choices)` signature unchanged; its post-pull local `store.lock.json` now satisfies `remoteLockAhead(newLocal, remote, ignore) === false` for every non-ignored, non-local-won remote group.

- [ ] **Step 1: Write the failing test (convergence repro)**

In `tests/core.test.ts`, inside the `describe("planImport / applyImport")` block, add. Import `remoteLockAhead` is already present (line 6). Adapt seeding to the local harness if a helper name differs — the two `remoteLockAhead` assertions are the binding contract:

```ts
it("pull converges the 'newer version info' hint for a store-only remote lock entry (repro)", async () => {
  const { io, ctx } = setup();
  await writeGroups(ctx, [HOTKEYS_GROUP]);
  // All store files identical on both sides; the ONLY difference is a remote lock entry
  // ("other-contract") that has no store file and is outside this vault's registry.
  io.seed({
    "cs/store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
    "cs/store/configdir/hotkeys.json": '{"a":1}',
    "cs/store.lock.json": JSON.stringify({ capturedAt: "T", groups: { hotkeys: { sourceAppVersion: "1.0.0" } } }),
  });
  const remoteLock = {
    capturedAt: "T", // equal — isolates the group-entry trigger from the capturedAt trigger
    groups: { hotkeys: { sourceAppVersion: "1.0.0" }, "other-contract": { sourcePluginVersion: "3.1.0" } },
  };
  const remote = {
    "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
    "store/configdir/hotkeys.json": '{"a":1}',
    "store.lock.json": JSON.stringify(remoteLock),
  };

  const before = await io.read("cs/store.lock.json");
  expect(remoteLockAhead(before, JSON.stringify(remoteLock), [])).toBe(true); // banner is up

  const pending = await planImport(ctx, fakeReader(remote), { excludeSelf: false });
  expect(pending.plan.conflicts).toEqual([]);
  await applyImport(ctx, pending, []);

  const after = await io.read("cs/store.lock.json");
  expect(remoteLockAhead(after, JSON.stringify(remoteLock), [])).toBe(false); // converged
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run tests/core.test.ts -t "converges the 'newer version info' hint"`
Expected: FAIL — final assertion is `true` (old merge never copies `other-contract`).

- [ ] **Step 3: Thread `excludeSelf` into `PendingPull`**

In `src/core/ConfigSyncCore.ts`, extend the interface (~799):

```ts
export interface PendingPull {
  plan: MergePlan;
  remoteGroups: SyncGroup[];
  remoteLockRaw: string | null;
  excludeSelf: boolean;
}
```

In `planImport` (~829), return it:

```ts
  return { plan, remoteGroups, remoteLockRaw, excludeSelf: opts.excludeSelf };
```

Add `SELF_GROUP_NAME` to the existing `./catalog` import at the top of the file (the module already imports from `./catalog`; add the name to that import list).

- [ ] **Step 4: Rewrite the `applyImport` lock merge to converge by construction**

In `applyImport`, delete the `remoteWonNames` machinery and the `plan.auto.identical` attribution loop, and replace the merge block. Concretely:

1. Delete the declaration `const remoteWonNames = new Set<string>(plan.auto.writeFiles.map((f) => f.name).filter((n) => n !== ""));` (~860).
2. Delete the line `remoteWonNames.add(conflict.name);` inside the file-conflict loop (~869).
3. Replace the merge block (`const localLock = await loadLock(ctx);` through the `await ctx.io.write(lockPath(ctx), …)` at ~878-898) with:

```ts
  const localLock = await loadLock(ctx);
  const remoteLock = remoteLockRaw !== null ? parseStoreLock(remoteLockRaw) : null;
  if (localLock !== null || remoteLock !== null) {
    const mergedGroups: StoreLock["groups"] = { ...(localLock?.groups ?? {}) };
    // Converge remoteLockAhead by construction: after a pull the local lock must carry every
    // remote lock entry the hint checks — except the self group when this remote excludes it,
    // and except a group whose file conflict the user kept as "local" (a real divergence that
    // belongs to the local lineage). Copying an entry with no comparable store file is correct:
    // a pull is additive, that content stays in the store, and its lock entry describes it
    // (see captureGroups' cross-registry note above).
    const localWonNames = new Set<string>();
    for (let i = 0; i < fileConflicts.length; i++) {
      if (choices[i] === "local") {
        const c = fileConflicts[i];
        if (c !== undefined) localWonNames.add(c.name);
      }
    }
    if (remoteLock !== null) {
      for (const [name, entry] of Object.entries(remoteLock.groups)) {
        if (pending.excludeSelf && name === SELF_GROUP_NAME) continue;
        if (localWonNames.has(name)) continue;
        mergedGroups[name] = entry;
      }
    }
    const merged: StoreLock = {
      capturedAt: remoteLock?.capturedAt ?? localLock?.capturedAt ?? ctx.now(),
      groups: mergedGroups,
    };
    await ctx.io.write(lockPath(ctx), JSON.stringify(merged, null, 2) + "\n");
  }
```

4. `owningGroupName` is now unused (it was only referenced in the deleted `identical` loop) — remove its import/usage if lint flags it as unused. Leave `remoteGroups` (still used by `orderedNames`) and `groups` in place.

- [ ] **Step 5: Run the repro test — verify it passes**

Run: `npx vitest run tests/core.test.ts -t "converges the 'newer version info' hint"`
Expected: PASS.

- [ ] **Step 6: Add the two edge tests**

```ts
it("excludeSelf: a differing self lock entry is ignored and still converges", async () => {
  const { io, ctx } = setup();
  await writeGroups(ctx, [HOTKEYS_GROUP]);
  io.seed({
    "cs/store/configdir/hotkeys.json": '{"a":1}',
    "cs/store.lock.json": JSON.stringify({ capturedAt: "T", groups: { hotkeys: { sourceAppVersion: "1.0.0" } } }),
  });
  const remoteLock = {
    capturedAt: "T",
    groups: { hotkeys: { sourceAppVersion: "1.0.0" }, "plugin-config-sync": { sourcePluginVersion: "2.13.2" } },
  };
  const remote = {
    "store/configdir/hotkeys.json": '{"a":1}',
    "store.lock.json": JSON.stringify(remoteLock),
  };
  const pending = await planImport(ctx, fakeReader(remote), { excludeSelf: true });
  await applyImport(ctx, pending, []);
  const after = await io.read("cs/store.lock.json");
  // ignore the self group (excludeSelf) — hint converges, and we did NOT record a self entry we don't own
  expect(remoteLockAhead(after, JSON.stringify(remoteLock), ["plugin-config-sync"])).toBe(false);
  expect(JSON.parse(after).groups["plugin-config-sync"]).toBeUndefined();
});

it("a file conflict resolved 'local' keeps the local lock lineage (not overwritten by remote)", async () => {
  const { io, ctx } = setup();
  await writeGroups(ctx, [HOTKEYS_GROUP]);
  io.seed({
    "cs/store/configdir/hotkeys.json": '{"a":1}',
    "cs/store.lock.json": JSON.stringify({ capturedAt: "T", groups: { hotkeys: { sourceAppVersion: "LOCAL" } } }),
  });
  const remoteLock = { capturedAt: "T", groups: { hotkeys: { sourceAppVersion: "REMOTE" } } };
  const remote = {
    "store/configdir/hotkeys.json": '{"b":2}', // differs -> a file conflict
    "store.lock.json": JSON.stringify(remoteLock),
  };
  const pending = await planImport(ctx, fakeReader(remote), { excludeSelf: false });
  const conflicts = pending.plan.conflicts.filter((c) => c.kind === "file");
  expect(conflicts.length).toBe(1);
  await applyImport(ctx, pending, ["local"]); // keep local
  const after = JSON.parse(await io.read("cs/store.lock.json"));
  expect(after.groups.hotkeys.sourceAppVersion).toBe("LOCAL"); // local lineage preserved
});
```

- [ ] **Step 7: Run the full core suite + gates**

Run: `npx vitest run tests/core.test.ts` then `npm run build && npm run lint`
Expected: all pass; lint 0 errors, warnings at baseline. If any pre-existing applyImport test asserted the old lock contents for cross-registry/identical entries, reconcile it to the converged contract (do not weaken the new assertions).

---

### Task 2: Per-refresh reader cache — one clone per compare (#3)

**Files:**
- Modify: `src/main.ts` (`createReader` ~1185-1192; `refreshRemoteChecks` ~366-385; `deepDiff` host method ~682-697; add a cache field + generation counter; invalidate where remotes are edited/removed)
- Test: `tests/external.test.ts` (real git)

**Interfaces:**
- Consumes: `createGitReader` / `createLocalPathReader` (unchanged; the git reader is already fully in-memory after construction).
- Produces: `createReader(remote, opts?: { reuse?: boolean })`. `reuse: true` returns the cached reader when its generation matches the current refresh generation, else builds and caches one. Default builds fresh. `refreshRemoteChecks` bumps the generation and caches one fresh reader per remote. `deepDiff` reads with `{ reuse: true }`.

- [ ] **Step 1: Add the cache field + a stable remote key**

In the plugin class (near other private fields in `src/main.ts`), add:

```ts
private remoteReaderGen = 0;
private remoteReaderCache = new Map<string, { reader: ExternalStoreReader; gen: number }>();

private remoteReaderKey(remote: Remote): string {
  return remote.type === "vault"
    ? `vault:${remote.name}:${remote.storePath}`
    : `git:${remote.name}:${remote.url}:${remote.branch}:${remote.subdir ?? ""}`;
}
```

- [ ] **Step 2: Give `createReader` a reuse path**

Rewrite `createReader` (~1185):

```ts
private async createReader(remote: Remote, opts?: { reuse?: boolean }): Promise<ExternalStoreReader> {
  const key = this.remoteReaderKey(remote);
  if (opts?.reuse === true) {
    const hit = this.remoteReaderCache.get(key);
    if (hit !== undefined && hit.gen === this.remoteReaderGen) return hit.reader;
  }
  const reader = await this.buildReader(remote);
  this.remoteReaderCache.set(key, { reader, gen: this.remoteReaderGen });
  return reader;
}

private async buildReader(remote: Remote): Promise<ExternalStoreReader> {
  if (remote.type === "vault") {
    const { createLocalPathReader } = await import("./external/localPath");
    return createLocalPathReader(remote.storePath);
  }
  const { createGitReader } = await import("./external/gitSource");
  return createGitReader(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
}
```

- [ ] **Step 3: `refreshRemoteChecks` bumps the generation and warms the cache**

In `refreshRemoteChecks` (~366), before the loop add `this.remoteReaderGen++;`. Inside the loop, keep `const reader = await this.createReader(remote);` — the default (non-reuse) path now builds fresh AND caches under the new generation (because `createReader` always caches). No other change to the loop body.

- [ ] **Step 4: `deepDiff` reuses the warm reader**

In the `deepDiff` host method (~682-697), change both `this.createReader(remote)` calls (the diff reader and, if present, any lock read that re-creates one) to `this.createReader(remote, { reuse: true })`. `pullFrom`/`pushTo` keep the default fresh `createReader`/`createWriter`.

- [ ] **Step 5: Invalidate on remote mutation**

Where a remote is added, edited, or removed in settings (search `this.settings.remotes` assignments / the remote editor save/delete handlers), clear the cache so a changed URL/branch never serves a stale reader: add `this.remoteReaderCache.clear();` at each such save/delete site. (A generation bump on the next refresh also covers edits, but an explicit clear on delete prevents unbounded growth and stale keys.)

- [ ] **Step 6: Integration assertion (real git)**

In `tests/external.test.ts`, add a test that builds a real store repo, then verifies reuse. Follow the file's existing harness for spinning a repo. Assert the reuse contract by observing clone side effects (e.g., count temp dirs created, or spy on the transport) within the harness's available means:

```ts
it("reuses a cloned reader within a refresh generation and re-clones across generations", async () => {
  // build a real remote store repo via the existing harness helpers
  // gen A: createReader(remote) then createReader(remote, {reuse:true}) -> same object, one clone
  // bump generation (simulate refreshRemoteChecks) -> createReader(remote, {reuse:true}) -> new object, new clone
});
```

If the harness cannot observe object identity through the plugin boundary, assert at the `gitSource` level instead: two `{reuse:true}` reads in one generation resolve to a reader whose backing data is identical and produced by a single clone (e.g., temp-dir count). Keep it real — no mock reader.

- [ ] **Step 7: Gates**

Run: `npm test && npm run build && npm run lint`
Expected: all pass; lint baseline held.

---

### Task 3: Live variant-B compare indicator + real phases (#4a)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (Host interface `deepDiff` ~146; `renderRemoteDetail` ~2215-2225)
- Modify: `src/main.ts` (`deepDiff` host method ~682-697 — accept and call `onPhase`)
- Modify: `styles.css` (new `config-sync-remote-comparing` styling + spinner/bar keyframes)

**Interfaces:**
- Consumes: `createReader(remote, { reuse: true })` (Task 2).
- Produces: `deepDiff(remote, onPhase?: (phase: "fetch" | "compare") => void)` on the Host interface and its `main.ts` implementation. `onPhase("fetch")` fires before the reader is obtained; `onPhase("compare")` before `diffRemote`.

- [ ] **Step 1: Extend the `deepDiff` interface + implementation to report real phases**

In `SyncCenterView.ts` Host interface (~146):

```ts
deepDiff(remote: Remote, onPhase?: (phase: "fetch" | "compare") => void): Promise<{ entries: RemoteDiffEntry[]; lockDiffers: boolean }>;
```

In `main.ts` `deepDiff` (~682), thread it:

```ts
deepDiff: async (remote, onPhase) => {
  const ctx = await this.coreContext();
  onPhase?.("fetch");
  const reader = await this.createReader(remote, { reuse: true });
  onPhase?.("compare");
  const entries = await diffRemote(ctx, reader, { excludeSelf: remote.excludeSelf === true });
  let lockDiffers = false;
  try {
    const remoteLock = (await reader.listFiles()).includes("store.lock.json") ? await reader.readFile("store.lock.json") : null;
    const localLock = (await ctx.io.exists(`${ctx.rootPath}/store.lock.json`)) ? await ctx.io.read(`${ctx.rootPath}/store.lock.json`) : null;
    lockDiffers = remoteLockAhead(localLock, remoteLock, remote.excludeSelf === true ? [SELF_GROUP_NAME] : []);
  } catch {
    lockDiffers = false;
  }
  return { entries, lockDiffers };
},
```

(When the reader is a warm cache hit, `createReader` resolves instantly and the UI moves straight to the compare phase — honest.)

- [ ] **Step 2: Build the live indicator in `renderRemoteDetail`**

Replace the static line at `SyncCenterView.ts:2217` (`detail.createDiv({ cls: "config-sync-remote-comparing", text: "comparing…" });`) and the `deepDiff` call (~2222) with a variant-B indicator. The elapsed timer is a UI-local `setInterval`; the phase is set by the `onPhase` callback; both are torn down before the pane is rewritten:

```ts
const box = detail.createDiv({ cls: "config-sync-remote-comparing" });
box.createSpan({ cls: "config-sync-cmp-spinner" });
box.createSpan({ cls: "config-sync-cmp-label", text: `Comparing with ${remote.name}` });
const elapsed = box.createSpan({ cls: "config-sync-cmp-elapsed", text: "0.0s" });
const phaseEl = detail.createDiv({ cls: "config-sync-cmp-phase", text: "Fetching remote…" });
detail.createDiv({ cls: "config-sync-cmp-bar" }).createDiv({ cls: "config-sync-cmp-bar-fill" });
const startedAt = Date.now();
const ticker = window.setInterval(() => {
  elapsed.setText(`${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}, 100);
this.registerInterval(ticker); // Obsidian View auto-clears on close
let entries: RemoteDiffEntry[];
let lockDiffers = false;
try {
  const dd = await this.host.deepDiff(remote, (phase) => {
    if (gen !== this.renderGen) return;
    phaseEl.setText(phase === "fetch" ? "Fetching remote…" : "Comparing files…");
  });
  entries = dd.entries;
  lockDiffers = dd.lockDiffers;
} catch (e) {
  window.clearInterval(ticker);
  // ... existing catch body unchanged ...
```

After the `try` resolves and before the code repaints `detail` (the existing `detail.empty()`-equivalent rebuild path already runs because the method re-renders results into `detail`), call `window.clearInterval(ticker);`. Ensure `clearInterval` runs on every exit path (success, error-return, stale-gen return). Keep the existing stale-gen guard `if (gen !== this.renderGen …) return;`.

Note: the current method writes `comparing…` then leaves it until results replace it — confirm the results rendering path clears the `config-sync-remote-comparing` box (it rebuilds `detail`'s children below); if it appends rather than replaces, remove the indicator nodes explicitly before rendering results.

- [ ] **Step 3: Style variant B in `styles.css`**

Add near the other `config-sync-remote-*` rules:

```css
.config-sync-remote-comparing { display: flex; align-items: center; gap: 8px; font-size: var(--font-ui-small); color: var(--text-muted); }
.config-sync-cmp-elapsed { margin-left: auto; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.config-sync-cmp-phase { font-size: var(--font-ui-smaller); color: var(--text-muted); margin: 6px 0; }
.config-sync-cmp-spinner { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--background-modifier-border); border-top-color: var(--interactive-accent); display: inline-block; animation: config-sync-spin 0.7s linear infinite; }
.config-sync-cmp-bar { position: relative; height: 4px; border-radius: 3px; background: var(--background-modifier-border); overflow: hidden; }
.config-sync-cmp-bar-fill { position: absolute; top: 0; height: 100%; width: 35%; border-radius: 3px; background: var(--interactive-accent); animation: config-sync-indeterminate 1.15s ease-in-out infinite; }
@keyframes config-sync-spin { to { transform: rotate(360deg); } }
@keyframes config-sync-indeterminate { 0% { left: -35%; } 100% { left: 100%; } }
@media (prefers-reduced-motion: reduce) {
  .config-sync-cmp-spinner { animation: none; }
  .config-sync-cmp-bar-fill { animation: none; left: 0; width: 40%; }
}
```

- [ ] **Step 4: Build + manual check**

Run: `npm run build`
Manual (dev vault, real remote): open a remote → spinner turns, elapsed ticks, phase reads `Fetching remote…` then `Comparing files…`, bar animates; a warm re-open jumps straight to `Comparing files…`. With OS "reduce motion" on, spinner/bar are static but the timer/phase still update.

- [ ] **Step 5: Gates**

Run: `npm test && npm run lint`
Expected: pass; baseline held. (No new unit test is required for pure presentation; if the harness can call `deepDiff` with an `onPhase` spy, add a small assertion that it fires `"fetch"` then `"compare"` in order.)

---

### Task 4: Global refresh + option-2 refresh working state (#1, #4b)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (top-right refresh ~966-970; sidebar refresh ~825-831; sidebar remote rows ~832-843; a refresh working-state paint)
- Modify: `src/main.ts` (`refreshRemoteChecks` ~366-385 — publish `{ total, done }` progress; expose it to the view)
- Modify: `styles.css` (spinning ↻ button, sidebar row spinner, aggregate line)

**Interfaces:**
- Consumes: `host.refreshRemoteChecks()` (existing), the reader cache/generation from Task 2, the `config-sync-spin` keyframe from Task 3.
- Produces: `host.remoteRefreshProgress(): { total: number; done: number } | null` on the Host interface; `null` when no refresh is in flight. `refreshRemoteChecks` sets `{ total, done: 0 }`, increments `done` after each remote (notifying the view each time), and clears to `null` when finished.

- [ ] **Step 1: Publish real refresh progress from `refreshRemoteChecks`**

In `main.ts`, add a field `private remoteRefreshProgress: { total: number; done: number } | null = null;` and a getter used by the Host wiring. Rewrite `refreshRemoteChecks` (~366) so it publishes progress and notifies per remote:

```ts
async refreshRemoteChecks(): Promise<void> {
  if (!Platform.isDesktop) return;
  this.remoteReaderGen++;
  let localLock: StoreLock | null = null;
  try { localLock = await loadLock(await this.coreContext()); } catch { localLock = null; }
  this.remoteRefreshProgress = { total: this.settings.remotes.length, done: 0 };
  this.notifySyncCenter(); // paint the working state before the first clone — no silent gap
  for (const remote of this.settings.remotes) {
    try {
      const reader = await this.createReader(remote);
      this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader), at: Date.now() });
    } catch (e) {
      this.remoteChecks.set(remote.name, { check: { state: "unknown", remoteCapturedAt: null }, at: Date.now() });
      console.error(`Config Sync: remote check failed for ${remote.name}`, e);
    }
    if (this.remoteRefreshProgress !== null) this.remoteRefreshProgress.done++;
    this.notifySyncCenter();
  }
  this.remoteRefreshProgress = null;
  this.updateStatusIndicators();
  this.notifySyncCenter();
}
```

Note the moved `this.remoteReaderGen++;` (from Task 2 Step 3) now lives here at the top — keep a single bump. Wire the getter into the Host object (~680): `remoteRefreshProgress: () => this.remoteRefreshProgress,`.

- [ ] **Step 2: Add `remoteRefreshProgress` to the Host interface**

In `SyncCenterView.ts` Host interface (~145, next to `refreshRemoteChecks`):

```ts
remoteRefreshProgress(): { total: number; done: number } | null;
```

- [ ] **Step 3: Make the top-right refresh global (#1)**

Replace `SyncCenterView.ts:967-970`:

```ts
refresh.setIcon("refresh-cw");
refresh.setTooltip("Refresh");
refresh.extraSettingsEl.addClass("config-sync-center-refresh");
refresh.onClick(async () => {
  await this.host.refreshRemoteChecks(); // desktop: re-checks every remote, then reloads via notify
  await this.reload();                   // mobile no-ops the above; ensure local still refreshes
});
```

- [ ] **Step 4: Aggregate line + spinning button + sidebar row spinners (option 2)**

Progress-aware paint, all reading `this.host.remoteRefreshProgress()`:

1. **Aggregate line** — in `renderRemoteMode` (~2186), right after the remote head and before `renderRemoteDetail`, when a refresh is in flight show the count:

```ts
const prog = this.host.remoteRefreshProgress();
if (prog !== null) {
  const agg = main.createDiv({ cls: "config-sync-cmp-agg" });
  agg.createSpan({ cls: "config-sync-cmp-spinner" });
  agg.createSpan({ text: `Checking ${prog.total} remote${prog.total === 1 ? "" : "s"}… ${prog.done} done` });
}
```

2. **Spinning ↻** — both refresh `ExtraButtonComponent`s (sidebar ~825, top-right ~966): after creating each, toggle a spin class from progress:

```ts
refresh.extraSettingsEl.toggleClass("config-sync-refresh-spinning", this.host.remoteRefreshProgress() !== null);
```

3. **Sidebar row spinner** — in the sidebar remote-row loop (~832-843), when a refresh is in flight, render a spinner in the state-icon slot instead of the resolved glyph:

```ts
const iconSpan = item.createSpan({ cls: "config-sync-state-icon" });
if (this.host.remoteRefreshProgress() !== null) {
  iconSpan.addClass("config-sync-row-checking");
  iconSpan.createSpan({ cls: "config-sync-cmp-spinner" });
} else {
  const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
  iconSpan.addClass(icon.cls);
  iconSpan.setAttribute("aria-label", icon.tip);
  this.paintStateIcon(iconSpan, icon);
}
```

(Adjust to preserve the existing `aria-label`/`paintStateIcon` call shape; the change is only the in-flight branch.) Because `notifySyncCenter` → `reload` re-renders after each remote resolves, the aggregate count and row spinners update truthfully as work completes.

- [ ] **Step 5: Also spin the sidebar refresh + paint-before-await**

The sidebar refresh (~828) already `await this.host.refreshRemoteChecks()` then re-renders; since Step 1 now notifies (re-renders) synchronously at the start of `refreshRemoteChecks`, the working state paints before the first clone. No change needed beyond Step 4's spin class. Keep the sidebar `onClick` as-is.

- [ ] **Step 6: Style the additions in `styles.css`**

```css
.config-sync-cmp-agg { display: flex; align-items: center; gap: 8px; font-size: var(--font-ui-smaller); color: var(--text-muted); padding: 6px 8px; margin-bottom: 8px; background: var(--background-secondary-alt); border: 1px solid var(--background-modifier-border); border-radius: 6px; }
.config-sync-refresh-spinning svg { animation: config-sync-spin 0.7s linear infinite; transform-origin: center; }
.config-sync-row-checking { display: inline-flex; align-items: center; justify-content: center; }
@media (prefers-reduced-motion: reduce) { .config-sync-refresh-spinning svg { animation: none; } }
```

(`config-sync-cmp-spinner` and `config-sync-spin` come from Task 3.)

- [ ] **Step 7: Build + manual check + gates**

Run: `npm run build && npm test && npm run lint`
Manual (dev vault, ≥2 remotes): click the top-right ↻ → it spins immediately, the open remote shows `Checking N remotes… M done` counting up, sidebar rows show spinners, then resolve to their glyphs; the banner clears after one Pull and stays clear on re-compare. Reduce-motion freezes the ↻ spin.

---

## Self-Review

**Spec coverage:** #1 → Task 4 Step 3. #2 → Task 1. #3 (de-dup) → Task 2; #3 (silent gap) → Task 4 Step 1 (notify before first clone). #4 (variant B) → Task 3; #4 (option 2 working state) → Task 4 Steps 4-5. Non-goals respected (no prefetch, no writer/isolation/pill/minAppVersion change).

**Placeholders:** none — every step carries real code or a concrete, adapt-to-harness note with binding assertions named.

**Type consistency:** `PendingPull.excludeSelf` set in `planImport`, read in `applyImport` (Task 1). `createReader(remote, { reuse })` produced in Task 2, consumed by `deepDiff` in Task 3. `deepDiff(remote, onPhase)` interface + impl both updated (Task 3). `remoteRefreshProgress()` added to the Host interface (Task 4 Step 2), implemented in `main.ts` (Step 1), consumed in the view (Step 4). `remoteReaderGen++` lives in one place after Task 4 Step 1 supersedes Task 2 Step 3 — the Task 4 reviewer must confirm it is not bumped twice per refresh.
