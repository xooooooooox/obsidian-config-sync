# C Live-Test Batch 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dissolve companion groups into their parent object in both Sync Center panes (ledger C-#15) per spec `docs/superpowers/specs/2026-08-07-c-livetest-batch5-companion-dissolve.md`.

**Architecture:** One pure-model task (family rollup, file-changes merge, remote fold, fate verb join, staging fan-out — all DOM-free tested), one view/host wiring task (row collapse, card files, remote pass), one docs task. Groups stay the run/store currency; only presentation + staging fan-out change.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free), esbuild.

## Global Constraints

- Branch c-unified-grammar; per-task commits enabled; NEVER any Claude/AI attribution.
- The C master spec (2026-08-06-sync-center-unified-grammar-design.md) is the grammar authority; `docs/design/DESIGN.md` is the design-system authority (read its Sync Center sections before any view change).
- UI vocabulary: `this device` / `your other devices` / `the store`; never carrier/switch list/fleet. NO new copy except the file verb join (`applies N files` / `captures N files` — existing folder verbs) — Appearance keeps `Applies theme & snippets — live` / `Captures theme & snippets`.
- Family conflict reuses the EXISTING conflict grammar (`⚠ Changed on both sides`, Resolve `Use theirs ↓` / `Keep mine ↑`, unstageable until resolved, excluded from select-all) — no new controls.
- Strict typing, no `any`; minimal diffs; suite baseline 1033 green; build clean; lint 0 errors / ≤58 warnings (ceiling is exactly 58 — ZERO new warnings).
- Environment: no `cd X && …`; use `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths.
- Manual criteria = ledger C-#15 FAIL CRITERION.

---

### Task 1: Pure model — family rollup, changes merge, remote fold, fate verbs, staging fan-out

**Files:**
- Modify: `src/ui/panelModel.ts` (family helpers beside the TYPE_SECTION/remoteSections family; `StageableRow`/`stagedPayload`)
- Modify: `src/ui/fateModel.ts` (file-verb join in `rowFate`)
- Test: alongside the existing panelModel/fateModel tests (follow suite layout)

**Interfaces:**
- Consumes: `GroupState` (verify exact members in `src/core/types.ts` before coding), `FileChanges`, `RemoteDiffEntry` (`src/core/status.ts:260`), existing `StageableRow`/`stagedPayload` (panelModel.ts:442), `rowFate`/`FateInput` (fateModel.ts — `folderFileCount` field exists).
- Produces (Task 2 relies on these exact names):
  - `interface FamilyMember { name: string; state: GroupState; fileCount: number }`
  - `function familyRollup(members: FamilyMember[]): { state: GroupState; applyMembers: string[]; captureMembers: string[]; applyFiles: number; captureFiles: number }` — state: any member `differs` OR (applyMembers.length > 0 && captureMembers.length > 0) → `differs`; else one-direction → that state; else all `no-settings` → `no-settings`; else `in-sync`. Member lists contain names of members actionable in that direction; file counts sum member `fileCount` per direction.
  - `function mergeFamilyChanges(parts: { prefix: string | null; changes: FileChanges }[]): FileChanges` — concatenates added/updated/deleted with `prefix + "/"` prepended to each path when prefix ≠ null (parent uses null).
  - `function foldCompanionEntries(entries: RemoteDiffEntry[], parentOf: (group: string) => string | null): RemoteDiffEntry[]` — companion entries merge into (or create) their parent's entry with each file's `itemRel` prefixed `"<companionGroup>/" +`; non-companions pass through; result order stable (first-seen).
  - `StageableRow` gains `companionNames: { apply: string[]; capture: string[] }` (default empty); `stagedPayload` pushes `{ name, action: "none" }` for each companion of the row's effective direction (dedup against already-pushed names).
- Fate verb join: `rowFate` — when `input.folderFileCount !== null && > 0` on a NON-folder, NON-appearance row, join the folder verb (`applies N files` / `captures N files`) after the settings verb (or alone when there's no settings verb); folder-type rows and the appearance special keep their existing sentences byte-identical.

- [ ] **Step 1: Write failing tests** — familyRollup truth table (all-in-sync; in-sync+nothing-yet → in-sync; settings-only; files-only; both-direction mix → differs; member differs → differs; empty companions ≡ current behavior); mergeFamilyChanges prefixing (parent null-prefix, companion prefixes, all three kinds); foldCompanionEntries (merge into existing parent, create missing parent, pass-through non-companions, itemRel prefixes, chip-count aggregation implied by file concat); stagedPayload companion fan-out (apply-side names, capture-side names, dedup, conflict-resolved direction only); rowFate verb join (settings+files, files-only, folder row unchanged, appearance unchanged).
- [ ] **Step 2: Run to confirm red, then implement** all of the above.
- [ ] **Step 3: Gates.** Full suite green, `npm --prefix <repo> run build`, `run lint` (0 / ≤58, zero new warnings).
- [ ] **Step 4: Commit** (`feat(ui): family model — companion rollup, changes merge, remote fold, staging fan-out`).

### Task 2: Wiring — host resolver, main-list row collapse, card files, remote pass

**Files:**
- Modify: `src/main.ts` (host resolver near `displayParts`, main.ts:587/1114)
- Modify: `src/ui/SyncCenterView.ts` (host interface ~:175; `rows()` ~:513; `fateInputFor` ~:591; `renderUnifiedFiles` ~:1975; staging-row builder feeding `stagedPayload`; remote paint ~:2687)

**Interfaces:**
- Consumes: Task 1's helpers verbatim; `groupOwners(defs, customGroups)` (`src/core/registry.ts:554`, static def-level presetCompanions included — works with empty settings); `legacyGroupName` (registry.ts:208, private — export it or add a host-side equivalent mapping itemId → parent group name).
- Produces: host method `companionParentOf(group: string): string | null` — parent GROUP name for a companion group (owner itemId → legacyGroupName), null for non-companions/custom groups/self; exposed on the view's host interface.

- [ ] **Step 1: Host resolver.** Implement `companionParentOf` in main.ts over `groupOwners(this.defs…, settings.customGroups)`; add to the view host interface. Custom groups and `enabled-css-snippets` return null (spec §1 out-of-scope).
- [ ] **Step 2: Main-list collapse.** In `rows()`: partition out StatusRows whose group is a companion (`companionParentOf ≠ null`) into a `familyMembers: Map<parentGroupName, StatusRow[]>`; companion rows never become rows. In `fateInputFor(r)`: compute `familyRollup([parentMember, …companions])` (member `state` = `presState`-equivalent of each StatusRow, `fileCount` = its `folderChangeCount`-style count for dir groups, 0 otherwise); feed `conflict` (rollup state differs), `folderFileCount` (effective-direction file sum; null when 0 and parent isn't a folder), and keep every parent-only field as today. Direction/stageability derive from the rollup state via the existing chains. Conflict-choice/direction-override stay keyed by parent name. An orphan companion (parent group not in rows — e.g. parent scope-excluded here) keeps its own row (honest degradation; do not drop data silently).
- [ ] **Step 3: Card files + staging.** `renderUnifiedFiles`: render `mergeFamilyChanges([{prefix:null, changes:parent}, …{prefix:companionGroupName, changes}])` for the chosen direction (missing member changes → skip). Staging-row builder: fill `companionNames` from the rollup's per-direction member lists (parent name excluded — it's `itemName`).
- [ ] **Step 4: Remote pass.** In the remote paint path, run Task 1's `foldCompanionEntries(changed, companionParentOf)` BEFORE `remoteSections`; everything else from batch 4 untouched. Verify the folded parent entry's display name resolves (existing displayNameOf; batch-4 preset fallback covers fresh devices).
- [ ] **Step 5: Sweep for member-count consumers.** Filter pills, footer summary, sidebar category counts, select-all, search — all derive from `rows()`/fates and must now count families once; verify by reading each call site (no separate companion handling left). Search: a family row matches if parent OR any member name matches (extend the search-string join in `rowMatchesSearch`/`fullName` usage).
- [ ] **Step 6: Gates.** Full suite, build, lint (0/≤58).
- [ ] **Step 7: Commit** (`fix(ui): companion groups dissolve into their parent object in both panes (C-#15)`).

### Task 3: Docs currency

**Files:**
- Modify: `docs/design/DESIGN.md`
- Modify: `docs/superpowers/specs/2026-08-06-sync-center-unified-grammar-design.md`

- [ ] **Step 1:** DESIGN.md: supersede the `Parent › Name` breadcrumb mention for Sync Center object rows (survives for Settings drawers/run reports); document the family object (one row/entry per family, file-verb join, family conflict reuse, remote fold) in current-state voice, in place.
- [ ] **Step 2:** C master spec: add the family rule to §1 (one object = one row includes an item's companions) and note the §3 verb join; keep amendments dated.
- [ ] **Step 3: Commit** (`docs: family grammar — companions dissolve into their parent object`).

---

## Self-Review

- Spec coverage: §1→T2 S1-S2, §2→T1 rollup+verbs / T2 S2+S5, §3→T1 stagedPayload / T2 S3, §4→T2 S3, §5→T1 fold / T2 S4, §6→T1 tests, §7→gates + T3.
- No placeholders; interfaces exact (`FamilyMember`, `familyRollup`, `mergeFamilyChanges`, `foldCompanionEntries`, `companionNames`, `companionParentOf`).
- Type consistency: `GroupState` verified in T1 Step 1 before use; parent-name keying stated in both T1 (payload) and T2 (view state).
