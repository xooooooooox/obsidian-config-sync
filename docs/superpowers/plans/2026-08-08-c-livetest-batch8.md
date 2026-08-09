# C Live-Test Batch 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capped, display-named, whole-list-aware on/off narration in the remote pane (ledger C-#20) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch8-onoff-narration.md`.

**Architecture:** One task: pure narration helper + tests in panelModel, thin wiring in renderRemoteOnOff.

**Tech Stack:** TypeScript, Vitest, esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commit; NEVER any Claude/AI attribution.
- Copy is spec-final (§1): `on at {remote}: its entire list — N plugins` / `off at {remote}: everything in your store's list — N plugins` / `…, and N more`. Cap = 5. UI vocabulary rule holds (this device / your other devices / the store; remote names as proper nouns).
- Strict typing, no `any`; minimal diff; suite 1086 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58, ZERO new).
- Environment: no `cd X && …`; `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.

---

### Task 1: Narration helper + wiring

**Files:**
- Modify: `src/ui/panelModel.ts` (helper beside `onOffFlips`), its test file
- Modify: `src/ui/SyncCenterView.ts` (`renderRemoteOnOff` — the fliplist block only)

**Interfaces:**
- Consumes: `onOffFlips` output; the pane's existing storedLabel closure + `displayParts` for names; the section's carrier identity for element→group mapping (community: `plugin-<id>`; core: id).
- Produces: the pure helper per spec §3 (implementer names it; must return ready-to-render per-side lines given flips, per-side source on-set sizes, `displayOf`, remote name).

- [ ] **Step 1:** Failing tests for the §1 truth table: whole-list on-side, whole-list off-side, both; capped >5 with `and N more`; ≤5 lists all; empty side omitted; display-name sort; id fallback when displayOf returns the id.
- [ ] **Step 2:** Implement the helper; wire `renderRemoteOnOff`: build `displayOf` (element → group name by carrier → storedLabel chain → displayParts label), compute per-side source sizes from the same parsed lists `onOffFlips` reads (reuse the existing parse — don't parse twice if avoidable), render returned lines.
- [ ] **Step 3:** Gates: full suite, build, lint (0/≤58).
- [ ] **Step 4:** Commit (`fix(ui): on/off narration capped with display names and whole-list case (C-#20)`).

---

## Self-Review
- §1→Steps 1-2 (copy verbatim in constraints); §2→Step 2 displayOf; §3→helper+tests; §4→gates. No placeholders.
