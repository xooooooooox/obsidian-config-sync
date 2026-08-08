# C Live-Test Batch 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rule-excluded items tell the truth (C-#24) per spec `docs/superpowers/specs/2026-08-08-c-livetest-batch11-excluded-honesty.md`.

**Architecture:** T1 = excludedHere fact + fate sentence/chip/card + bucket pin (+tests). T2 = self capture-nudge live verification, fix only if real.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest, esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits; NEVER any Claude/AI attribution.
- Copy is spec-final: `— Not synced on this device` (row), chip `your rule`, card clause `Not synced on this device — your Settings sync rule excludes it.` UI vocabulary rule holds.
- Strict typing, no `any`; minimal diffs; suite 1114 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling exactly 58, ZERO new).
- Environment: no `cd X && …`; `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.
- Manual criteria = spec §4.

---

### Task 1: excludedHere — fact, fate, card, bucket

**Files:**
- Modify: `src/ui/fateModel.ts` (FateInput + sentence branch), `src/ui/SyncCenterView.ts` (fateInputFor derivation; card STATE clause; chip), `src/ui/panelModel.ts` only if the bucket needs an explicit pin; tests beside existing fateModel/panelModel tests

- [ ] **Step 1:** Root-cause where scope exclusion manifests today (trace a devices:"mobile" group through compile → status on desktop; record file:line in report). Derive `excludedHere` at the fact layer (`fateInputFor`), from the compiled group's device scope vs `Platform.isMobile`.
- [ ] **Step 2:** Failing tests per spec §3 (sentence truth table incl. directional-family precedence; bucket ok; byte-identical when false).
- [ ] **Step 3:** Implement: rowFate branch (neutral+excludedHere → sentence/glyph/unstageable), chip `your rule` via fate.chips, card STATE clause, bucket stays ok.
- [ ] **Step 4:** Gates. **Step 5:** Commit (`fix(ui): rule-excluded items say so instead of "In sync" (C-#24)`).

### Task 2: self capture-nudge — verify live, fix only if real

**Files:**
- Possibly: `src/main.ts` (selfStatus/baseline machinery) — ONLY if §2 finds a real insensitivity

- [ ] **Step 1:** Live protocol per spec §2 on llm via obsidian-cli (this environment CAN reach it: `obsidian-cli vault=llm-wiki.vault eval code='…'`; restore every mutation).
- [ ] **Step 2:** If insensitive: root-cause (systematic-debugging — no fix before the cause is proven), fix minimally, add the §3 test. If sensitive: write the verification evidence in the report, no code change.
- [ ] **Step 3:** Gates. **Step 4:** Commit only if code changed (`fix(core): rule-only settings changes surface the self item as to-capture`).

---

## Self-Review
- §1→T1 (copy verbatim in constraints; precedence stated); §2→T2 (verify-first, fix-if-real); §3→both; §4→gates. No placeholders.
