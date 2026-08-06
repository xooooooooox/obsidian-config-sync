# C Live-Test Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix C live-test issues C-#5..C-#10 per spec `docs/superpowers/specs/2026-08-06-c-livetest-batch2-design.md` and pay the DESIGN.md currency debt.

**Architecture:** View/CSS work on the expanded card (SyncCenterView.ts + styles.css) plus one docs task. No core/data changes; the only behavioral change is rule-control interaction (menu instead of any implicit mutation).

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free), esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits enabled; NEVER any Claude/AI attribution.
- `docs/design/DESIGN.md` is the design-system authority; icon vocabulary from `SCOPE_ICONS` (src/ui/itemCard.ts:390); shared control precedents: `renderScopeCycle` (src/ui/scopeCycle.ts).
- UI copy unchanged except none needed; vocabulary rule (this device / your other devices / the store).
- Strict typing, no `any`; minimal diffs; suite baseline 1012 green; build clean; lint 0 errors / ≤58 warnings.
- Environment: no `cd X && …`; use `git -C`, `npm --prefix <repo> run <script>`, absolute paths.
- Manual criteria = the ledger FAIL CRITERIA (`.superpowers/sdd/2026-08-06-c-livetest/issues.md` C-#5..#10).

---

### Task 1: Card mechanics (C-#5, C-#6, C-#8, C-#9)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (card row builder from C Task 5; row renderer for the expanded-state sentence suppression)
- Modify: `styles.css` (card grid/columns)

**Interfaces:**
- Consumes: existing card renderer structure.
- Produces: a card-row helper that renders NOTHING (no separator, no height) when the value is empty — Task 2 builds its triggers inside the same helper.

- [ ] **Step 1: Root-cause C-#5.** Reproduce by reading the card build path for an item like Hotkeys (no Runs on): find the element emitting the empty separator-bounded band (empty actions row / valueless row / stray border). Record the cause in the report.
- [ ] **Step 2: Fix the four issues.** Card rows: key column `white-space: nowrap` and width fitted to the longest key so no key wraps (C-#6); value cell starts immediately after the key and sizes to content (`min-width: 0`, no fixed narrow widths; ellipsis only under real overflow) (C-#6/C-#8); valueless rows render nothing (C-#5). Row renderer: when `expandedId === row.id`, skip rendering the fate sentence + direction glyph on the row line (checkbox and chips stay) (C-#9).
- [ ] **Step 3: Gates.** `npm --prefix <repo> test` (1012), `run build`, `run lint` (0/≤58).
- [ ] **Step 4: Commit** (`fix(ui): card row mechanics — adjacency, width, empty rows, expanded row sentence`).

### Task 2: Rule controls — icon + menu per DESIGN.md (C-#7, C-#10)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (Settings sync + Runs on card rows; After install/Enablement trigger restyle)
- Modify: `src/ui/itemCard.ts` only if the Runs-on glyph map is added beside `SCOPE_ICONS` (single-source; no duplicated literal maps)
- Modify: `styles.css`

**Interfaces:**
- Consumes: Task 1's card-row helper; `SCOPE_ICONS`; existing write targets (`setItemFileScope`-family for Settings sync, `settings.memberRules` for Runs on).
- Produces: `RUNS_ON_ICONS: Record<MemberRule, string>` = `{ all: "monitor-smartphone", desktop: "monitor", mobile: "smartphone", "always-here": "power", "never-here": "power-off" }` (exported beside SCOPE_ICONS).

- [ ] **Step 1: Build the shared card trigger.** Icon span with `config-sync-scopeicon` classes (`is-set` accent when non-default), `aria-label` = current state label, `role="button"`/`tabindex`; click opens an Obsidian `Menu`: each item `setIcon(glyph)` + final label, current item checked; selection invokes the existing write + rerender. Click target = the icon box only; no other element in the row carries a handler (C-#7).
- [ ] **Step 2: Apply to both rows.** Settings sync: glyphs from `SCOPE_ICONS`, labels = the existing scope labels, same write target as today. Runs on: `RUNS_ON_ICONS`, the five final labels, writes `settings.memberRules`. Verify `power`/`power-off` are unused in the codebase's icon set (`git grep -n '"power'` across src/) — note the result.
- [ ] **Step 3: Restyle After install / Enablement textual triggers** to the same trigger-box treatment (height/border/hover), keeping their text labels.
- [ ] **Step 4: Gates + commit** (`feat(ui): card rule controls on the shared icon language`).

### Task 3: DESIGN.md currency (merge gate)

**Files:**
- Modify: `docs/design/DESIGN.md`

- [ ] **Step 1: Read the file fully** (structure, voice, how it documents current state — never a changelog).
- [ ] **Step 2: Supersede the pre-C Sync Center sections in place:** type sections + real collapse + restored header typography; unified row anatomy (checkbox meaning, chips, fate sentence — point to the C spec's verb table rather than duplicating it); expanded card anatomy (key column, value adjacency, row set incl. Resolve/After install/Enablement fallbacks); rule controls (cards: icon+menu; Settings drawers: cycle unchanged; `RUNS_ON_ICONS` additions incl. `power`/`power-off` in the icon registry section); the UI vocabulary rule.
- [ ] **Step 3: Consistency pass:** no contradictions left with surviving sections (search for mentions of dissolved surfaces: on/off cards in the main list, Disabled/Not-installed sections, policy segments, "has settings below").
- [ ] **Step 4: Commit** (`docs: DESIGN.md catches up to the unified Sync Center grammar`).

---

## Self-Review

- Spec coverage: §1→T1, §2→T2, §3→T3; all six ledger issues mapped (C-#5/6/8/9→T1, C-#7/10→T2+T3). 
- No placeholders; interfaces named (`RUNS_ON_ICONS`, card-row helper contract T1→T2).
- Type consistency: `MemberRule` keys in RUNS_ON_ICONS match core/types.ts MEMBER_RULES.
