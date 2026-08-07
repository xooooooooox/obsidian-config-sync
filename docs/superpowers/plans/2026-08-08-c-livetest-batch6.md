# C Live-Test Batch 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real display names in the remote pane (ledger C-#14) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch6-remote-labels.md`: remote lock labels reach the pane, and captures/startup heal the local lock's labels.

**Architecture:** One core task (remote-label extraction on the compare path + `backfillLockLabels` + wiring into capture/startup, all tested), one small view task (display chain in the remote paint). No UI copy changes.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free), esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits enabled; NEVER any Claude/AI attribution.
- No catalog/network lookups. No `capturedAt` mutation from backfill. Lock writes only when content actually changed.
- Strict typing, no `any`; minimal diffs; suite baseline 1068 green; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58 — ZERO new warnings).
- Environment: no `cd X && …`; use `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.
- Manual criteria = spec §4.

---

### Task 1: Core — remote label extraction + lock label backfill

**Files:**
- Modify: `src/core/status.ts` (or wherever the deepDiff path reads the remote lock — locate the `lockDiffers`/`hasLockDiff` computation and remote lock read first; extraction lives beside it)
- Modify: `src/core/ConfigSyncCore.ts` (capture-tail backfill; label resolvers already at :454/:477)
- Modify: `src/main.ts` (deepDiff result threading; startup heal call after the local store/lock loads)
- Modify: `src/ui/SyncCenterView.ts` ONLY the `RemoteCompareResult` type (:260) gaining `remoteLabels: Record<string, string>` and whatever host signature carries it — no pane rendering changes (Task 2's job)
- Test: beside existing status/core tests (follow suite layout)

**Interfaces:**
- Consumes: existing remote reader (`ExternalStoreReader.readFile/listFiles`), lock shape (`{ capturedAt, groups: Record<string, { label?: string; … }> }`), capture label resolvers (`ctx.plugins.getInstalledPluginName` / `getCorePluginName`, `coreSettingsIds`).
- Produces (Task 2 relies on):
  - `RemoteCompareResult` (SyncCenterView.ts:260) gains `remoteLabels: Record<string, string>`; `host.deepDiff` returns it filled (empty map on absent/malformed remote lock — never throws for that).
  - `function remoteLockLabels(lockJson: unknown): Record<string, string>` (pure, exported wherever the lock read lives) — group name → label for entries carrying a string label.
  - `function backfillLockLabels(…): boolean` (pure-ish core function; returns whether anything changed) + wiring: called at the tail of every capture run before the lock is persisted, and once at startup when the local store exists (write only on change).

- [ ] **Step 1: Locate the remote lock read** on the deepDiff path (grep `hasLockDiff` / `lockDiffers`); record file:line in your report. Write failing tests for `remoteLockLabels` (labels present / absent / malformed lock / non-string label skipped).
- [ ] **Step 2: Write failing tests for `backfillLockLabels`**: label-less resolvable community + core entries gain labels; not-installed community entry untouched; stale label refreshed; nothing-to-do returns false (and the caller skips the write); `capturedAt` byte-identical after backfill.
- [ ] **Step 3: Implement both + thread `remoteLabels`** through deepDiff/`RemoteCompareResult`; wire capture-tail + startup heal (startup: after store/lock load, if `backfillLockLabels` reports change, persist the lock; guard so it runs once per load, not per status refresh).
- [ ] **Step 4: Gates.** Full suite green (1068 + new), build, lint (0/≤58).
- [ ] **Step 5: Commit** (`feat(core): remote lock labels on the compare result + lock label backfill`).

### Task 2: View — display chain in the remote pane

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (remote paint path ~:2687 — the `renderRemoteDiffEntry` storedLabel argument and the `remoteSections` `displayNameOf` callback)

**Interfaces:**
- Consumes: Task 1's `remoteLabels` on the compare result; existing `fullName`/`findGroupByName`.

- [ ] **Step 1: Apply the chain** in BOTH spots: `storedLabel = findGroupByName(this.groups, g)?.label ?? dd.remoteLabels[g]` (local stored label first, then remote; `fullName`/`displayParts` handles the rest of the priority naturally). Verify no other remote-pane naming call site exists (grep `renderRuleName` uses in the remote region).
- [ ] **Step 2: Check DESIGN.md** for any display-name-resolution statement the new chain makes stale; update in place if so (current-state voice), else state "checked, none" in your report.
- [ ] **Step 3: Gates + commit** (`fix(ui): remote pane names resolve through remote lock labels (C-#14)`).

---

## Self-Review

- Spec coverage: §1→T1 (extraction/threading) + T2 (chain); §2→T1 (backfill + wiring); §3→T1 tests; §4→gates.
- No placeholders; exact names (`remoteLabels`, `remoteLockLabels`, `backfillLockLabels`).
- Type consistency: `RemoteCompareResult` extension named with the exact field Task 2 reads.
