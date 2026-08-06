# C Live-Test Batch 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Sync Center remote pane to the main list's C grammar (ledger C-#13) per spec `docs/superpowers/specs/2026-08-07-c-livetest-batch4-remote-pane-grammar.md`.

**Architecture:** One pure-model task (section derivation + flip narration helpers, parentCardLabel display fallback, all DOM-free tested), then one view task consuming those helpers in `paintRemoteCompareResult` + styles. Pull/push semantics, summary/matched/buttons/error rendering untouched.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free), esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits enabled; NEVER any Claude/AI attribution.
- The alignment target is the MAIN LIST's C grammar exactly — no new dialect, no invented controls; `docs/design/DESIGN.md` is the design-system authority (read its Sync Center sections before the view task).
- UI vocabulary rule: `this device` / `your other devices` / `the store`; remote names are proper nouns; NEVER "carrier"/"switch list"/"fleet" in UI copy. New copy (spec-final): `On/off list · differs for N plugin(s) ▸`, `on at {remote}: …`, `off at {remote}: …`.
- No fake affordances: remote-pane section headers get NO chevron, NO collapse, NO checkbox, NO carrier chip (ledger C-#1 precedent).
- Strict typing, no `any`; minimal diffs; suite baseline 1013 green; build clean; lint 0 errors / ≤58 warnings.
- Environment: no `cd X && …`; use `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.
- Manual criteria = ledger C-#13 amended FAIL CRITERION.

---

### Task 1: Pure model — remote section derivation, flip narration, parent fallback

**Files:**
- Modify: `src/ui/panelModel.ts` (new helpers beside the TYPE_SECTION family)
- Modify: `src/core/registry.ts` (`parentCardLabel` fallback, ~line 296)
- Test: `src/ui/panelModel.test.ts` (or the file the existing TYPE_SECTION tests live in — follow the suite's layout), registry tests beside existing `parentCardLabel`/registry tests

**Interfaces:**
- Consumes: `TYPE_SECTION_ORDER`, `TypeSection`, `typeSectionForRow` (panelModel.ts:247-255); `RemoteDiffEntry` (`src/core/status.ts:260`); `parseSwitchList` (existing switch-list module); `OTHER_STORE_FILES_GROUP` (`src/core/status.ts:267`); `ItemCategory`.
- Produces (Task 2 relies on these exact names):
  - `interface RemoteSectionModel { section: TypeSection; onOff: RemoteDiffEntry | null; entries: RemoteDiffEntry[] }`
  - `function remoteSections(entries: RemoteDiffEntry[], categoryOf: (group: string) => ItemCategory | "beta", displayNameOf: (group: string) => string): RemoteSectionModel[]`
  - `function onOffFlips(local: string | null, remote: string | null): { onAtRemote: string[]; offAtRemote: string[] }`
  - `function onOffLineText(n: number, open: boolean): string` → `On/off list · differs for N plugin${n===1?"":"s"} ${open?"▾":"▸"}`

- [ ] **Step 1: Write failing tests for `remoteSections`.** Cases: carriers (`core-plugins`, `community-plugins`) extracted to their sections' `onOff` (never in `entries`); beta category lands in Community; custom lands in folders; entries sorted by `displayNameOf` (localeCompare); sections with no `onOff` and no entries absent from the result; result ordered by `TYPE_SECTION_ORDER`; `OTHER_STORE_FILES_GROUP` sorts last within folders regardless of display name.
- [ ] **Step 2: Write failing tests for `onOffFlips` + `onOffLineText`.** Both carrier file formats (community-plugins.json string array; core-plugins.json map — reuse whatever `parseSwitchList` accepts; feed real-shaped fixture strings); null local → every remote-on plugin in `onAtRemote`; null remote → every store-on plugin in `offAtRemote`; overlapping membership in different order → both lists empty; outputs sorted; unparseable side degrades to empty list (no throw). Line text singular/plural and open/closed glyph.
- [ ] **Step 3: Write failing tests for the `parentCardLabel` fallback.** Empty `settings.items` → `themes`/`snippets` return the appearance def's label; a configured ENABLED companion with the same basename on another item still wins; disabled appearance card with no configured companions still gets the preset fallback (display-only — state does not gate it); a non-companion group name returns null as before.
- [ ] **Step 4: Run the new tests, confirm they fail** (`npm --prefix <repo> test`), then implement: `remoteSections`/`onOffFlips`/`onOffLineText` in panelModel.ts beside the TYPE_SECTION helpers; extend `parentCardLabel` with the presetCompanions basename fallback AFTER the existing configured-companion loop (keep the enabled-companion priority; do not touch reservedCustomGroupNames or compile paths).
- [ ] **Step 5: Gates.** Full suite green (1013 + new), `npm --prefix <repo> run build`, `run lint` (0 errors / ≤58 warnings).
- [ ] **Step 6: Commit** (`feat(ui): remote pane C-grammar model — sections, on/off flips, parent fallback`).

### Task 2: View — remote pane renders the main-list grammar

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`paintRemoteCompareResult` ~:2684-2760, `renderRemoteDiffEntry` ~:2762; imports)
- Modify: `styles.css` (remote-pane section head reuse; pinned on/off line; flip narration lines)

**Interfaces:**
- Consumes: Task 1's `remoteSections` / `onOffFlips` / `onOffLineText` / `RemoteSectionModel`; existing `this.scopeOf`, `this.fullName`, `renderRuleName`, `renderRemoteFileRows`, `TYPE_SECTION_TITLES`, `sectionCountLabel`.
- Produces: no new exports; DOM classes `config-sync-remote-onoff` (pinned line) and `config-sync-remote-fliplist` (narration block) for styles.

- [ ] **Step 1: Read `docs/design/DESIGN.md`'s Sync Center sections** (section head anatomy, typography, vocabulary) — the header treatment must be the documented one.
- [ ] **Step 2: Replace the section loop in `paintRemoteCompareResult`.** Swap the `SCOPE_ORDER`/`config-sync-sect` loop (:2689-2694) for `remoteSections(changed, (g) => this.scopeOf(g), (g) => this.fullName(g, findGroupByName(this.groups, g)?.label))`. Per section: header via the main-list head family — `config-sync-section-head` markup with `config-sync-section-title` = `TYPE_SECTION_TITLES[section]` + neutral count pill `· N` (N = `entries.length + (onOff ? 1 : 0)`), NO chevron/checkbox/carrier-chip/click handler; add a modifier class (e.g. `is-static`) if the shared classes carry cursor/hover affordances that need neutralizing in CSS.
- [ ] **Step 3: Render the pinned on/off line.** When `onOff !== null`, first line inside the section: a `config-sync-remote-onoff` line (line treatment, not a row card) with text from `onOffLineText(n, open)` where `n = onAtRemote.length + offAtRemote.length` from `onOffFlips(f.local, f.remote)` of the carrier's single file (if the entry unexpectedly carries multiple files, sum over files). Click toggles: expanded shows a `config-sync-remote-fliplist` block — `on at {remote.name}: a, b` / `off at {remote.name}: c` lines (omit empty) — followed by the entry's standard file rows via `renderRemoteFileRows`. Collapsed removes both. No stored state beyond the local closure (same pattern as renderRemoteDiffEntry's fold).
- [ ] **Step 4: Keep everything else byte-identical.** Object rows still `renderRemoteDiffEntry` (unchanged); summary lines, "N more items match", self-note, buttons, error cards untouched. Delete now-unused pane pieces only if truly dead (`config-sync-sect` may have other call sites — check before removing CSS).
- [ ] **Step 5: Styles.** Reuse the section-head styles (scoped so the remote pane's static variant drops pointer cursor/hover); `config-sync-remote-onoff` matches the `config-sync-unchanged` line family with the diff-hint accent for the toggle glyph; `config-sync-remote-fliplist` indented, muted, `on at`/`off at` values in normal text.
- [ ] **Step 6: Gates.** Full suite, build, lint (0/≤58).
- [ ] **Step 7: Commit** (`fix(ui): remote pane speaks the main list's C grammar (C-#13)`).

---

## Self-Review

- Spec coverage: §1→T2 Step 2, §2 rows unchanged + parent fallback→T1 Step 3, §3→T1 Steps 2/4 + T2 Step 3, §4→T1 Steps 1-3, §5→gates in both tasks.
- No placeholders; interfaces named with exact signatures (`remoteSections`, `onOffFlips`, `onOffLineText`, `RemoteSectionModel`).
- Type consistency: `TypeSection`/`ItemCategory | "beta"` match panelModel.ts:247-255 and SyncCenterView.ts `scopeOf` (:541).
