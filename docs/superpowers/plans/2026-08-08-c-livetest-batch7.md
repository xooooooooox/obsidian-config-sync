# C Live-Test Batch 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the `· ` prefix from section count pills (ledger C-#18) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch7-count-pill-dot.md`.

**Architecture:** One task: the pure helper + its tests + docs currency.

**Tech Stack:** TypeScript, Vitest, esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commit; NEVER any Claude/AI attribution.
- Strict typing; minimal diff; suite 1086 green after assertion updates; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58, zero new).
- Environment: no `cd X && …`; `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.

---

### Task 1: Dotless count pill + docs currency

**Files:**
- Modify: `src/ui/panelModel.ts` (`sectionCountLabel`, :259-261)
- Modify: its test file (existing sectionCountLabel assertions)
- Modify: `docs/design/DESIGN.md`, `docs/superpowers/specs/2026-08-07-c-livetest-batch4-remote-pane-grammar.md` (count-pill wording only)

- [ ] **Step 1:** Update the sectionCountLabel tests to expect `"10"` and `"6 of 31"` (dotless); run to see them fail.
- [ ] **Step 2:** Change the two template strings; grep `src/` for any caller prepending `·` to the pill afterwards (`grep -n "· " src/ui/SyncCenterView.ts` around the two head builders) — report findings.
- [ ] **Step 3:** Docs sweep per spec (dotless wording; current-state voice, no changelog).
- [ ] **Step 4:** Gates: full suite, build, lint (0/≤58).
- [ ] **Step 5:** Commit (`fix(ui): section count pills drop the leading dot (C-#18)`).

---

## Self-Review
- Spec change→Step 2; tests→Step 1; docs sweep→Step 3; gates→Step 4. No placeholders.
