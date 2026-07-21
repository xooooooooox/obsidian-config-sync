# Docs Currency — Design

**Date:** 2026-07-22
**Status:** Approved (pending spec review)

## Problem

`README.md` and `README.zh.md` are frozen at the 1.0.0 documentation pass
(commit `95d56bf`) and miss the entire 1.1.0 → 1.3.0 feature wave (qualifier
search, Beta/BRAT tab, Sync Center header status bar, self "this-device" pane,
distinct action icons, snippet re-scope + orphan cleanup). `docs/ARCHITECTURE.md`
was frozen in the same pass. This has recurred: docs drift because there is no
rule or gate keeping them current. Only `docs/design/DESIGN.md` has a
same-branch update rule (`CLAUDE.md:43`), and even it trails 1.3.0 (no self
pane, no qualifierSearch). There is zero automated enforcement.

## Goal

1. **Prevention** — a lightweight convention + durable memory that keeps docs
   current, gated at merge-to-`main` and at cut. No CI/hooks.
2. **Remediation** — bring the stale docs current to 1.3.0 as the first
   application of the new rule.

## Decisions (locked)

- **Enforcement:** convention + memory only. No CI, hooks, markdownlint, or
  link-check.
- **Trigger:** *user-facing behavior* changes (features, UI, commands,
  settings, workflows) require same-branch doc updates. Pure internal refactors
  that don't change what a user sees do not.
- **Gates:** docs must be current **before merging to `main`** and **before
  cutting a release**.
- **Remediate now:** `README.md` + `README.zh.md` + `docs/ARCHITECTURE.md` +
  the 1.3.0 gap in `docs/design/DESIGN.md`.

## Part A — Prevention

### A1. The rule (canonical text)

> **Docs-currency rule.** When a change alters user-facing behavior — features,
> UI, commands, settings, workflows — update the affected docs **in the same
> branch as the code**:
> - `README.md` **and** `README.zh.md` (keep the two in sync) — features,
>   walkthroughs, settings guide
> - `docs/ARCHITECTURE.md` — code map / invariants / extension points, when
>   structure changes
> - `docs/design/DESIGN.md` — tokens / icons / components (existing rule)
>
> Pure internal refactors that don't change what a user sees need no doc edit.
> **Gates:** docs must be current before merging to `main` and before cutting a
> release. The finishing-a-branch / cut checklist gains one line: *"docs current
> for this change? (README + zh, ARCHITECTURE, DESIGN)"*.

### A2. Where the rule lives

Three reinforcing surfaces, because the failure mode is "nobody was reminded":

1. **Repo `CLAUDE.md`** — extend the existing DESIGN.md line (`:43`) into a
   short "Documentation currency" block carrying A1's rule: the doc list, the
   same-branch requirement, and the two gates. Keep it terse (CLAUDE.md is ~43
   lines; add ~6–8). This is what every future agent session reads.
2. **A feedback memory** (global, cross-session) — `docs-currency-before-merge`,
   type `feedback`, capturing the rule + *why* (docs have drifted repeatedly) +
   *how to apply* (check before merge/push/cut). This carries the rule across
   sessions even outside this repo's context load.
3. **Workflow checkpoint** — the finishing-a-development-branch step and the
   cut step each gain the one-line "docs current for this change?" check. Since
   these flows are driven in-session, the memory + CLAUDE.md are what enforce it.

### A3. Non-goals / deferred

- **No automation** — CI docs-check, git hooks, markdownlint, and link-check are
  explicitly out of scope (chosen: convention + memory).
- **AGENTS.md ↔ CLAUDE.md consolidation — DEFERRED** (user shelved 2026-07-22).
  Finding to preserve: **Claude Code does not auto-read `AGENTS.md`; it loads
  only `CLAUDE.md`** (+ `CLAUDE.local.md`, `~/.claude/CLAUDE.md`) — so this
  repo's 270-line `AGENTS.md` is invisible to Claude every session. The
  documented fix is a `@AGENTS.md` import inside `CLAUDE.md` (expanded into
  context at launch, full token cost; docs advise keeping CLAUDE.md < ~200 lines
  incl. imports). Because `AGENTS.md` here is mostly generic inherited
  sample-plugin boilerplate that partly duplicates CLAUDE.md, importing as-is is
  discouraged. Options when revisited: (a) consolidate the useful bits into
  CLAUDE.md and drop/stub AGENTS.md; (b) make AGENTS.md canonical (trimmed) and
  have CLAUDE.md `@import` it; (c) import as-is as a stopgap. The deciding factor
  is whether non-Claude agents are used on this repo. Once resolved, `AGENTS.md`
  joins the A1 doc list.

## Part B — Remediation (bring docs current to 1.3.0)

**Source of truth for every claim:** the code, plus the hand-written GitHub
release notes for 1.1.0 → 1.3.0 (already accurate). Each documented feature must
be cross-checked against an actual component before it is written.

### B1. `README.md`

- **Features / "How it works":** add qualifier search (both search boxes +
  autocomplete; the `key:value` vocabulary), the Sync Center header status bar
  (self "this-device" chip + all-action totals incl. per-remote push/pull), the
  self pane (state, Settings button, expandable "view change" for the device's
  own `data.json`), the Beta/BRAT plugin-management tab, distinct action icons,
  and snippet re-scope + orphan cleanup.
- **Fix stale text:** the "Filter by name…" box description (now qualifier
  search); the "shared `↑`/`↓`" glyph framing (now distinct Lucide icons per
  action); the tab list that omits **Beta**; the `🔒`/`▤` mode-badge wording;
  the snippet walkthrough.

### B2. `README.zh.md`

Mirror B1 in Chinese; keep the section structure 1:1 with `README.md` so the two
stay diffable and in sync going forward.

### B3. `docs/ARCHITECTURE.md`

Refresh the code map and extension points to include `src/ui/actionIcons.ts`,
`src/ui/qualifierSearch.ts`, the self pane, and the header status bar; update any
invariants/extension-point text that the 1.1.0–1.3.0 work changed.

### B4. `docs/design/DESIGN.md`

Add the self-pane and qualifier-autocomplete components to the component
inventory and bump the audit-findings date — closing its 1.3.0 gap. (Its own
same-branch rule already exists; this is the one-time catch-up.)

## Execution

Docs-only content, plus one `CLAUDE.md` edit and one memory write — **no code, no
tests.** The three doc surfaces (B1 README-en · B2 README-zh · B3+B4
ARCHITECTURE+DESIGN) are independent and can be produced in parallel. This work
is itself the first exercise of the A1 rule: performed on a branch, with docs
current before merge and before any future cut.

## Verification

No automated tests (documentation). Verification is a cross-check pass: every
feature named in the docs must map to a real component in `src/` and to the
1.1.0–1.3.0 release notes; no doc should reference removed/renamed UI. A final
read-through confirms `README.md` and `README.zh.md` are structurally in sync.
