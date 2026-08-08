# C Live-Test Batch 10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fate-driven buckets (C-#23) then interaction-scoped rendering (C-#22) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch10-fate-buckets-and-perf.md`.

**Architecture:** T1 = pure `fateBucket` + rewiring every bucket consumer (+tests). T2 = toggle DOM flips + per-render fate memoization (+ scoped staging updates if feasible), building on T1's single derivation.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest, esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits; NEVER any Claude/AI attribution.
- Single-derivation principle: fate is the grammar's core — no consumer re-derives buckets from raw GroupState after T1 (genuine GroupState semantics like conflict detection/locked bypass stay).
- Strict typing, no `any`; minimal diffs; suite 1100 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58, ZERO new).
- Environment: no `cd X && …`; `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.
- Sequential tasks (same file). Manual criteria = spec §4.

---

### Task 1: C-#23 — fateBucket + consumer rewiring

**Files:**
- Modify: `src/ui/panelModel.ts` (+ its tests), `src/ui/SyncCenterView.ts` (partition :1781-1786, counts feed :782, visibility feed :1730, sidebar badges, and every bucket-like `familyState(` call site — grep and classify each in your report)

**Interfaces:**
- Produces: `fateBucket(...)` per spec §1 (exact signature implementer's choice; must be pure and take only fate-derived facts). Conflict rows keep their CURRENT pill placement — state what that is in the report before changing anything.

- [ ] **Step 1:** Failing tests: fateBucket truth table; counts parity on a mixed set (incl. enable-only ↓ on no-settings state → apply bucket).
- [ ] **Step 2:** Implement + rewire all consumers; grep-classification table in the report.
- [ ] **Step 3:** Gates. **Step 4:** Commit (`fix(ui): buckets, counts, folds and filters derive from fate (C-#23)`).

### Task 2: C-#22 — toggle DOM flips + fate memoization

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (section-head click :~1745, trailing-fold click :1799-1804, fate memo around `fateWithInput`, optional staging-path scoping), `styles.css` only if a class flip needs it

- [ ] **Step 1:** Fate memo: per-render-cycle Map (invalidated at render/reload start); verify one derivation per row per cycle (count calls in a quick instrumented run, note in report).
- [ ] **Step 2:** Section toggle → in-place flip (class/chevron; closed→open builds that one section's card via the extracted per-section builder; open→closed removes the card). Trailing fold toggle → in-place (line text via existing text fn; rows built/removed in a dedicated container after the line). NO `this.render()` on either path.
- [ ] **Step 3:** Staging scoping per spec §2 (attempt; fall back to full render with measured residual if not cleanly reachable — do not ship half-correct counts).
- [ ] **Step 4:** Gates + live measurement note placeholder for the report (deployer will fill CLI timings).
- [ ] **Step 5:** Commit (`perf(ui): section and fold toggles flip DOM in place; one fate pass per render (C-#22)`).

---

## Self-Review
- §1→T1 (consumers enumerated, conflict placement preserved); §2→T2 (both prongs + optional third); §3→T1 tests + T2 measurement; §4→gates. No placeholders.
