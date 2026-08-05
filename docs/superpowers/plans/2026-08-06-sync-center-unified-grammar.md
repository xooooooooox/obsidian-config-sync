# Sync Center Unified Grammar (C Rework) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Sync Center main list as one unified grammar — one object = one row with a derived fate sentence, a standardized expanded card, two rule menus, and type sections + state filter pills — per spec `docs/superpowers/specs/2026-08-06-sync-center-unified-grammar-design.md`.

**Architecture:** All display facts derive from pure functions (`fateModel.ts` new, `panelModel.ts` extended) over existing compare/availability data; the view (`SyncCenterView.ts`) rerenders from them. Core gains three small additions: the unified `MemberRule` (with force-on mask), run-scoped partial-selection exceptions for switch-list writes, and a Settings deep-link host method. No store-format change.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free), esbuild.

## Global Constraints

- **Branch prerequisite:** implement on a new branch (suggested: `c-unified-grammar`) created only AFTER the user has committed the current round's uncommitted tree. Do not start implementation on main.
- **Commits:** none unless the user explicitly enables per-task commits at execution start; never on main; NEVER any Claude/AI attribution in any commit/PR text.
- **UI copy is final and verbatim** from spec §3 (fate sentence table) and §4 (card rows). Vocabulary rule (spec §1): only `this device` / `your other devices` / `the store`; forbidden in UI strings: `fleet`, `carrier`, `switch list`, `sidecar`.
- **Strict typing:** no `any`; internal Obsidian surfaces typed via the existing idiom in `src/main.ts` (see `disableCorePlugin`, `reloadAppearance`).
- **Tests:** DOM-free Vitest only (no DOM harness — accepted). Baseline at branch point: 945 passing; lint 0 errors / ≤58 warnings. Run via `npm --prefix <repo> test|run build|run lint` (compound `cd X && …` commands are denied in this environment).
- **Unchanged subsystems** (spec §7): sidebar, remote pane, history, pull/push, adopt flow, Settings tab content (except the deep-link anchor), compact-mode switcher, `.obsidian ↔ store ↔ remote` data flow, runtime switching, install ordering, StatePrelude ordering, appearance hot-apply.

---

### Task 1: Fate model — `rowFate` truth table

**Files:**
- Modify: `src/core/types.ts` (add `MemberRule`)
- Create: `src/ui/fateModel.ts`
- Test: `tests/fateModel.test.ts`

**Interfaces:**
- Consumes: nothing new (pure module).
- Produces (later tasks rely on these exact names):

```ts
// src/core/types.ts
export const MEMBER_RULES = ["all", "desktop", "mobile", "always-here", "never-here"] as const;
export type MemberRule = (typeof MEMBER_RULES)[number];
```

```ts
// src/ui/fateModel.ts
import type { MemberRule } from "../core/types";

export interface FateInput {
  direction: "apply" | "capture" | null; // null → in sync / nothing yet
  conflict: boolean;                     // both sides changed
  nothingYet: boolean;                   // no store data & no local settings
  installed: boolean;                    // plugin present locally (true for non-plugins)
  hasUpdate: boolean;                    // store has newer plugin version
  carrierSynced: boolean;                // the on/off list is a synced item
  storeListOn: boolean | null;           // null → no enablement dimension (obsidian/folder/self)
  locallyOn: boolean;
  memberRule: MemberRule;
  deviceClass: "desktop" | "mobile";
  desktopOnly: boolean;
  hasSettingsPayload: boolean;           // this run writes settings files
  special: "appearance" | null;
  folderFileCount: number | null;        // non-null → folder row ("Applies N files")
  encrypted: boolean;
}

export interface Fate {
  glyph: "↓" | "↑" | "—" | "⚠";
  sentence: string;   // text only, no glyph
  chips: string[];    // ordered, copy-final
  stageable: boolean; // false → dimmed row, hidden checkbox, skipped by select-all
  turnsOn: boolean;   // the run will switch it on here (drives stagedMembers + footer)
}

export function rowFate(i: FateInput): Fate;
```

- [ ] **Step 1: Write the failing tests** — the spec §3 table verbatim plus rule re-derivations:

```ts
import { describe, expect, it } from "vitest";
import { rowFate, FateInput } from "../src/ui/fateModel";

const base: FateInput = {
  direction: "apply", conflict: false, nothingYet: false, installed: true,
  hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
  memberRule: "all", deviceClass: "desktop", desktopOnly: false,
  hasSettingsPayload: true, special: null, folderFileCount: null, encrypted: false,
};

describe("rowFate — spec §3 verb table", () => {
  it("install + turn on + settings", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true });
    expect(f.glyph).toBe("↓");
    expect(f.sentence).toBe("Installs · turns on · applies settings");
    expect(f.chips).toContain("not installed here");
    expect(f.turnsOn).toBe(true);
  });
  it("install, off in the store list", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.chips).toContain("stays off");
  });
  it("installed, off here, store list turns it on — no settings", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: true });
    expect(f.sentence).toBe("Turns on");
  });
  it("update", () => {
    const f = rowFate({ ...base, hasUpdate: true });
    expect(f.sentence).toBe("Updates · applies settings");
  });
  it("appearance special", () => {
    const f = rowFate({ ...base, special: "appearance" });
    expect(f.sentence).toBe("Applies theme & snippets — live");
  });
  it("folder", () => {
    const f = rowFate({ ...base, folderFileCount: 2 });
    expect(f.sentence).toBe("Applies 2 files");
  });
  it("capture settings", () => {
    const f = rowFate({ ...base, direction: "capture" });
    expect(f.glyph).toBe("↑");
    expect(f.sentence).toBe("Captures settings");
  });
  it("capture: turned on here", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true });
    expect(f.sentence).toBe("Turned on here — shares it");
  });
  it("conflict", () => {
    const f = rowFate({ ...base, conflict: true });
    expect(f.glyph).toBe("⚠");
    expect(f.sentence).toBe("Changed on both sides");
    expect(f.stageable).toBe(false);
  });
  it("in sync / nothing yet", () => {
    expect(rowFate({ ...base, direction: null }).sentence).toBe("In sync");
    expect(rowFate({ ...base, direction: null, nothingYet: true }).sentence).toBe("Nothing to sync yet");
    expect(rowFate({ ...base, direction: null }).stageable).toBe(false);
  });
});

describe("rowFate — Runs on re-derivation", () => {
  it("never-here removes turns on, adds rule chip", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "never-here" });
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).toContain("off here — your rule");
    expect(f.turnsOn).toBe(false);
  });
  it("always-here on a store-off plugin adds turns on + rule chip", () => {
    const f = rowFate({ ...base, storeListOn: false, memberRule: "always-here" });
    expect(f.sentence).toBe("Turns on · applies settings");
    expect(f.chips).toContain("on here — your rule");
  });
  it("class rule suppresses turn-on on the wrong class", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "mobile", deviceClass: "desktop" });
    expect(f.turnsOn).toBe(false);
  });
  it("carrier unsynced suppresses enablement verbs entirely", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true, carrierSynced: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.sentence).not.toContain("turns on");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npm --prefix <repo> test -- fateModel` → FAIL (module not found).
- [ ] **Step 3: Implement `rowFate`.** Derivation skeleton (turn-on logic must match the tests exactly):

```ts
function effectiveTurnsOn(i: FateInput): boolean {
  if (!i.carrierSynced || i.storeListOn === null) return false;
  switch (i.memberRule) {
    case "never-here": return false;
    case "always-here": return !i.locallyOn;
    case "desktop": return i.deviceClass === "desktop" && i.storeListOn && !i.locallyOn;
    case "mobile": return i.deviceClass === "mobile" && i.storeListOn && !i.locallyOn;
    case "all": return i.storeListOn && !i.locallyOn;
  }
}
```

Sentence assembly: verbs in order `installs`/`updates` → `turns on` → settings verb (`applies settings`, or the appearance/folder/capture specials from the table); join with ` · `; capitalize the first letter. Chips in order: `not installed here` (apply ∧ !installed), `desktop only` (desktopOnly), `stays off` (carrierSynced ∧ storeListOn === false ∧ rule ≠ always-here ∧ !locallyOn), `off here — your rule` / `on here — your rule`, `🔒 encrypted`. `stageable` = direction ≠ null ∧ !conflict. Keep the module pure — no imports beyond types.

- [ ] **Step 4: Run tests, verify green**; run full suite (`npm --prefix <repo> test`) — no regressions.

### Task 2: `MemberRule` storage, normalization, and switch masks

**Files:**
- Modify: `src/core/switchList.ts` (add `addForceOn`, `memberUniverse`)
- Modify: `src/core/ConfigSyncCore.ts:49` (CoreContext: add `switchForceOn?: Record<string, string[]>`; apply it at the `subtractForceOff` site ~:865)
- Modify: `src/main.ts` — locate where `switchExceptions` / `switchForceOff` are built from settings member scopes (grep `switchExceptions`), extend to emit `switchForceOn` and consume `MemberRule`
- Test: `tests/switchList.test.ts` (extend), `tests/core.test.ts` (extend)

**Interfaces:**
- Consumes: `MemberRule` (Task 1).
- Produces:

```ts
// src/core/switchList.ts
export function addForceOn(list: SwitchList, ids: string[]): SwitchList;   // array: append missing ids; map: set true
export function memberUniverse(store: SwitchList | null, local: SwitchList | null): string[]; // union of ids/keys
// src/core (normalization; put beside excFor's data source)
export function normalizeMemberRule(scope: RuleScope, locallyOn: boolean): MemberRule;
// "all"→"all", "desktop"→"desktop", "mobile"→"mobile", "local"→ locallyOn ? "always-here" : "never-here"
```

- Mask derivation from a member's `MemberRule` (document as a comment where masks are built):
  - `desktop`/`mobile` on the matching class → no mask (plain store membership); on the other class → exception + forceOff (existing behavior, unchanged semantics).
  - `never-here` → exception + forceOff.
  - `always-here` → exception + **forceOn** (new).
  - `all` → nothing.

- [ ] **Step 1: Failing tests** — `normalizeMemberRule` all five mappings; `addForceOn` on array and map shapes (idempotent when already on); `memberUniverse` union/dedupe; core-level: a member with `always-here` rule, off locally, off in store → after apply the final list contains it (use the existing memfs core harness pattern from `tests/core.test.ts`'s switch-list cases).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** In `ConfigSyncCore.ts` the apply site becomes:

```ts
const afterOff = subtractForceOff(merged, ctx.switchForceOff?.[group.name] ?? []);
const finalList = addForceOn(afterOff, ctx.switchForceOn?.[group.name] ?? []);
```

Storage: keep the existing settings field shape (`Record<string, RuleScope>` per carrier) on disk for backward compatibility; `normalizeMemberRule` is applied at read time wherever the value feeds masks or `rowFate`. Writes from the new Runs on menu (Task 5) store: `all`/`desktop`/`mobile` as-is, and `always-here`/`never-here` as `"local"` **plus** the local switch flip that makes normalization re-derive the intended value — NO: that is fragile. Instead extend the stored value union: the settings field now accepts `RuleScope | MemberRule`; old `"local"` values normalize at read; new writes store the `MemberRule` directly. Update the settings validator (see `manifest.ts` note at `types.ts:5-8`) to accept the extended union.

- [ ] **Step 4: All tests green; lint clean.**

### Task 3: Partial-selection switch staging (core)

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` — `ApplyItem` (:567), `CaptureItem` (:720), `applyGroup` (:805, switch branch :829-854), `captureGroup` (:470, switch site :484), `applyWithActions` (:760), `captureWithActions` (:725), `apply` (:523), `capture` (:390)
- Test: `tests/core.test.ts` (extend)

**Interfaces:**
- Consumes: `memberUniverse` (Task 2).
- Produces:

```ts
export interface ApplyItem { name: string; action: StateAction; stagedMembers?: string[]; }
export interface CaptureItem { name: string; action: "enable" | "none"; stagedMembers?: string[]; }
// applyGroup(ctx, group, stagedMembers?: string[])  — undefined = whole-list (back-compat)
// captureGroup(ctx, group, stagedMembers?: string[])
```

Semantics: for a switch-list group, the run-scoped exception set becomes
`excFor(ctx, name) ∪ (memberUniverse(store, local) − stagedMembers)` — unstaged members keep their local value on apply, and keep their store value on capture (`captureSwitchList` already takes `exceptions`). `stagedMembers: []` therefore means "write settings, touch no switches". Delta messages (`switchDeltaMessages`) automatically shrink to the staged flips — assert that.

- [ ] **Step 1: Failing tests** (memfs harness): apply with `stagedMembers: ["a"]` where store turns on `a`+`b` → only `a` flips, message `turns on: a`; capture with staged subset → store list changes only for staged ids; `stagedMembers` undefined → today's whole-list behavior (existing tests must stay green untouched).
- [ ] **Step 2: Verify fail. Step 3: Implement (thread the field through both entry points; do not change `apply`/`capture` whole-run paths' behavior when the field is absent). Step 4: Full suite green.**

### Task 4: View skeleton — type sections, pills, folds, footer

**Files:**
- Modify: `src/ui/panelModel.ts` (new helpers; do not yet delete old ones)
- Modify: `src/ui/SyncCenterView.ts` — `renderMainRegion` (:583) and the section pipeline it calls (`groupSectionsByType` ~:1426, `renderSection`, `renderInfoSection`, disabled/not-installed renderers ~:2296-2352)
- Modify: `styles.css` (section header chip, dimmed rows)
- Test: `tests/panelModel.test.ts` (extend)

**Interfaces:**
- Consumes: `rowFate`/`Fate` (Task 1).
- Produces:

```ts
export type TypeSection = "obsidian" | "core" | "community" | "folders";
export const TYPE_SECTION_TITLES: Record<TypeSection, string> = {
  obsidian: "Obsidian", core: "Core plugins", community: "Community plugins", folders: "Your folders",
};
export function typeSectionForRow(defSection: "obsidian" | "core" | "community" | "beta" | "custom"): TypeSection; // beta→community, custom→folders
export function sectionCountLabel(total: number, visible: number, filtered: boolean): string; // "· 31" | "· 6 of 31"
export function unifiedFooterSummary(sel: { applyN: number; installs: number; turnsOn: number; settings: number; captureN: number }): string;
// 0 selected → "Nothing selected"
// apply only  → "5 selected — installs 2 · turns on 3 · settings 4"
// mixed       → "7 selected — installs 2 · turns on 3 · settings 4 · captures 2"
// capture only→ "2 selected — captures 2"
```

Layout rules (from mockups, binding): four sections in fixed order, alphabetical within (`byLabel` from registry); self row pinned first in Community with copy `your Sync Center — manages itself`; per-section trailing fold lines using the existing `insyncLineText`/`nosettingsLineText`; filter pills reuse the existing `PanelFilter` machinery minus `leftover` (leftover/foreign items become normal rows — verify `visibleUnderFilter` call sites); section header chip `on/off synced ✓` / `on/off not synced` on the two plugin sections opens an Obsidian `Menu` with one toggle item (`Sync on/off` / `Stop syncing on/off`) writing the carrier item's sync-enabled flag (the same write the Settings toggle does today — find it via the carrier item id `core-plugins`/`community-plugins`); select-all targets only rows whose `Fate.stageable` is true.

- [ ] **Step 1: Failing tests** for the four pure helpers (every branch of `unifiedFooterSummary`, both `sectionCountLabel` forms, `typeSectionForRow` all five inputs).
- [ ] **Step 2: Verify fail. Step 3: Implement helpers; green.**
- [ ] **Step 4: Rebuild `renderMainRegion`** around the new skeleton: one flat row list per section fed by existing status rows (keep the current row rendering for this task — rows are restyled in Task 5). Remove the *rendering* of the Disabled/Not-installed info sections and the carrier cards from the main list (leave their functions in place; deletion happens in Task 8). Keep scroll preservation (Batch 2) intact in both render paths.
- [ ] **Step 5: `npm --prefix <repo> run build` clean; manual smoke criteria noted in the report: 4 sections render, pills filter, folds expand, select-all skips dimmed rows.**

### Task 5: Unified row + expanded card

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (row renderer, new card renderer; File entries — `renderCappedChanges` ~:2217)
- Modify: `src/ui/panelModel.ts` (file-entry presentation)
- Modify: `styles.css` (chips, fate text, card rows)
- Test: `tests/panelModel.test.ts` (extend)

**Interfaces:**
- Consumes: `rowFate` (Task 1), `MemberRule` storage (Task 2), `openSettingsAt` (Task 7 — call through the host; Task 7 provides the implementation).
- Produces:

```ts
export interface FileEntryPresentation { glyph: "+" | "↑" | "del" | "·"; label: string; affordance: "view" | "diff" | "none"; note: string | null; }
export function fileEntryFor(change: { kind: "added" | "updated" | "deleted"; rel: string }, effDir: "apply" | "capture", encrypted: boolean): FileEntryPresentation;
// #8 rules: apply+added → "+", affordance "view" (full incoming content, reuse the remote pane's
// "not in your store" content view); both-sides → "diff"; capture-side → "↑" + "diff";
// encrypted → affordance "none", note "changed — encrypted, no preview";
// "del" strikethrough ONLY when the effective direction actually deletes the file.
```

Card rows in order (omit when N/A; copy verbatim from spec §4): `On apply`/`On capture`/`State` (full clause: `from the community catalog` / `via BRAT`, `Updates <a> → <b>`, `Shares your settings with your other devices`), `Files`, `Resolve` (Task 6), `Runs on` (menu, 5 options: `Follows your devices` / `Computers only` / `Phones only` / `Always on here` / `Never on here`; writes `MemberRule`, rerenders), `After install` (only ¬carrierSynced ∧ ¬installed: `Turn it on` / `Leave it off` → StateAction `install-enable`/`install`), `Settings sync` (existing item-scope write — same target as the Settings tab file-row scope control), `More` (`Per-key rules, locks & folders — opens Settings ▸`; folders: `Folder rules — opens Settings ▸`) → `host.openSettingsAt(itemId)`, `Note` (e.g. Hotkeys `Takes effect after an app reload`).

- [ ] **Step 1: Failing tests for `fileEntryFor`** (all branches above, incl. deletion-direction rule and encrypted).
- [ ] **Step 2: Verify fail. Step 3: Implement `fileEntryFor`; green.**
- [ ] **Step 4: Implement the row + card renderers** on top of Task 4's skeleton; wire the two menus; dimmed unstageable rows hide checkboxes.
- [ ] **Step 5: Build clean; full suite green; report manual criteria: expand any row → same card shape; Runs on choice re-derives the collapsed sentence immediately.**

### Task 6: Conflict resolution + staging + run wiring

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`applyPayload` region ~:2113-2352 — replace the policy/disabled ladders for the synced-carrier case), footer/buttons
- Modify: `src/ui/panelModel.ts`
- Test: `tests/panelModel.test.ts` (extend)

**Interfaces:**
- Consumes: `ApplyItem.stagedMembers`/`CaptureItem.stagedMembers` (Task 3), `Fate.turnsOn`/`stageable` (Task 1).
- Produces:

```ts
export type ConflictChoice = "apply" | "capture";
export function stagedPayload(rows: Array<{
  id: string; itemName: string; fate: Fate; selected: boolean;
  carrier: "core-plugins" | "community-plugins" | null; elementId: string | null;
  availability: Availability | null; conflictChoice: ConflictChoice | null; conflict: boolean;
}>): {
  apply: ApplyItem[];      // includes the carrier ApplyItems with collected stagedMembers
  capture: CaptureItem[];  // symmetric
};
// Rules: unselected → excluded. Conflict without choice → excluded (never stageable).
// A selected plugin row with fate.turnsOn contributes its elementId to its carrier's
// stagedMembers; the carrier ApplyItem exists iff ≥1 member or the carrier file itself differs.
// action derivation replaces defaultPolicy: !installed → hasUpdate irrelevant → "install-enable"
// iff fate.turnsOn else "install"; installed ∧ hasUpdate → "update-enable" iff turnsOn else
// "update"; otherwise "none"/"enable" per turnsOn.
```

Session state: `conflictChoice: Map<string, ConflictChoice>` on the view; `Resolve` segmented control writes it; after choosing, the collapsed row renders the directed sentence + chip `your choice`; the map resets after a successful run. Footer uses `unifiedFooterSummary`; show both `Apply` and `Capture` buttons when both sides have staged rows, each running only its side.

- [ ] **Step 1: Failing tests for `stagedPayload`** — cases: mixed selection both directions; turnsOn member collection per carrier; conflict unresolved excluded / resolved joins its side; action derivation matrix (install/install-enable/update/update-enable/enable/none).
- [ ] **Step 2: Verify fail. Step 3: Implement; green. Step 4: Wire into the view (buttons, run calls, post-run reset); build clean; full suite green.**

### Task 7: Settings deep link (`More` bridge)

**Files:**
- Modify: `src/main.ts` (host surface), `src/ui/SettingTab.ts` (anchor consume at `display()`/`render()` ~:434-470)
- Test: none (view wiring — manual)

**Interfaces:**
- Produces: `openSettingsAt(itemId: string): void` on the host object the view already holds (same surface as the existing `⚙ Settings` affordance on the self card — reuse its open-settings call, then set `pendingAnchorItemId` consumed by `SettingTab.render()`: expand that item's card and `scrollIntoView({ block: "start" })` its element; clear the field after consuming).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Build clean; manual criteria in report: `More` on Dataview's card opens Settings scrolled to Dataview, card expanded; works from both plugin sections and Your folders.**

### Task 8: Dissolution cleanup + copy audit

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `src/ui/panelModel.ts`, `styles.css`
- Test: full suite

Delete (verify each symbol's remaining references first — Settings tab keeps its own controls):
- Old sections: `SECTION_TITLES`, `SECTION_NOTES`, `sectionForItem`, `stageableRow`'s section param usage, the Disabled/Not-installed renderers and `disabledRowAction`/`disabledStaged`/`disabledEnableCount` (batch-1 footer split), `disabledInSyncNote`/`disabledNoSettingsNote`.
- Carrier-card UI in the main list: `ruleGroups`, `switchSummaryLines`, `switchBothWaysCaption`, `memberFate` fate pills, the member scope glyph menu (`renderScopeMenuGlyph`) — superseded by `Runs on`; keep any of these still referenced by SettingTab or history rendering.
- `policyOptions`/`defaultPolicy`/`isValidPolicy` main-list usage (keep only the `After install` fallback path from Task 5); `footerSummary` (5-param batch-1 version) replaced by `unifiedFooterSummary`; `PanelFilter` `"leftover"` value and its pill.
- Dead CSS classes for removed elements.

- [ ] **Step 1: Delete with reference checks; adjust tests that asserted removed surfaces (delete those assertions — the replaced behavior is covered by Tasks 1-6 tests).**
- [ ] **Step 2: Copy audit:** `grep -n "fleet\|carrier\|switch list\|sidecar" src/ui/*.ts` over user-visible strings → zero hits (code comments exempt).
- [ ] **Step 3: Full gates:** `npm --prefix <repo> test` green (report final count), `run build` clean, `run lint` 0 errors / ≤58 warnings.
- [ ] **Step 4: Report:** list every deleted symbol and every remaining consumer you kept and why.

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 grammar → T1/T5; §2 sections/filters/chip popover → T4; §3 table → T1; §4 card incl. #8 files, menus, More → T5/T7; §5 staging/partial switch/conflict/footer → T3/T6; §6 rule unification incl. force-on → T2; §8 tests distributed per task; §9 out of scope respected. Dissolution list (§1) → T8.
- **Type consistency:** `MemberRule` (T1) consumed T2/T5; `stagedMembers` (T3) consumed T6; `Fate.turnsOn`/`stageable` (T1) consumed T4/T6; `openSettingsAt` (T7) consumed T5; `unifiedFooterSummary` (T4) consumed T6.
- **Known judgment points for implementers:** exact settings-field name for member scopes (locate via `switchExceptions` construction in main.ts, T2); `visibleUnderFilter` leftover call sites (T4); which dissolved symbols SettingTab still uses (T8 reference checks).
