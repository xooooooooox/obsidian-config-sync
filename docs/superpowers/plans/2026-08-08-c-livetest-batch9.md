# C Live-Test Batch 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Honest coldstart pane (C-#19) + persistent remote-pane folds (C-#21) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch9-coldstart-and-fold-state.md`.

**Architecture:** Two independent tasks: T1 = SelfSyncInfo.storePresent + coldstart pane branch (+tests); T2 = remote-pane fold-state set replacing closure booleans.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest, esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits; NEVER any Claude/AI attribution.
- Copy is spec-final (§1). UI vocabulary rule (this device / your other devices / the store; remote names as proper nouns).
- Strict typing, no `any`; minimal diffs; suite 1097 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58, ZERO new).
- Environment: no `cd X && …`; `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.

---

### Task 1: C-#19 — storePresent + coldstart pane branch

**Files:**
- Modify: `src/main.ts` (`selfStatus`, ~:556 — it already computes `ctx.io.exists(lockPath)` and the selfCopy exists check; derive `storePresent` from those without extra IO)
- Modify: the `SelfSyncInfo` type (find its home — likely `src/core/selfPane.ts` or types)
- Modify: `src/ui/SyncCenterView.ts` (coldstart branch :939-955)
- Test: extend the existing selfStatus/selfPane tests

**Interfaces:**
- Produces: `SelfSyncInfo.storePresent: boolean`; coldstart pane branches per spec §1 (copy verbatim); `host.remotes()` (existing) drives the button/no-button variants.

- [ ] **Step 1:** Failing tests: storePresent true (lock only / self-copy only), false (neither). Check every constructor of SelfSyncInfo-shaped returns in selfStatus (coldstart early return AND the configured-path returns) sets it.
- [ ] **Step 2:** Implement type + selfStatus + pane branch (spec §1 copy verbatim; `Open {name}` button sets `panelScope = { kind: "remote", name }` + render — mirror the sidebar item click at :1179-1183).
- [ ] **Step 3:** Gates. **Step 4:** Commit (`fix(ui): coldstart pane tells the truth when no store exists yet (C-#19)`).

### Task 2: C-#21 — remote-pane fold persistence

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`renderRemoteDiffEntry` ~:2950, `renderRemoteOnOff` ~:2915, file-row diff toggle in `renderRemoteFileRows`)

**Interfaces:**
- Produces: one view-instance `Set<string>` (e.g. `remoteFoldsOpen`), keys per spec §2; all three toggles read at render / update on click; closure-local `built`/`panel !== null` booleans replaced (content rebuilt per render from current data).

- [ ] **Step 1:** Implement the set + key scheme; row fold, on/off line, and inline diff panel each render open when keyed open (build content immediately at render when open — no lazy `built` divergence between fresh-render-open and clicked-open).
- [ ] **Step 2:** Manual-verify note for the report: describe the repaint path you exercised (e.g. trigger `notifySyncCenter`/refresh with a fold open).
- [ ] **Step 3:** Gates. **Step 4:** Commit (`fix(ui): remote pane folds survive repaints (C-#21)`).

---

## Self-Review
- §1→T1 (copy in spec, button mirror cited); §2→T2 (keys verbatim); §3→T1 tests + T2 manual note; §4→gates. Types named (`storePresent`, `remoteFoldsOpen`). No placeholders.
