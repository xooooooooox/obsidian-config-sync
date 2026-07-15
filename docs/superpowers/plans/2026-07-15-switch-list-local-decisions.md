# Switch-List Local Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Tasks 3–4 are UI with settled mockups (`switch-exceptions.html`, `panel-gallery-023.html`); their rendered verification is controller-inline.

**Goal:** Per-device "local decision" exceptions for the two plugin on/off switch lists: excepted ids never enter the store at capture, keep their local state on apply, and are masked out of the in-sync comparison — so heterogeneous devices stabilize instead of ping-ponging.

**Architecture:** New pure module `src/core/switchList.ts` (shape-aware set ops for `string[]` and `Record<string, boolean>`). `CoreContext` gains device-local `switchExceptions`; the three mode-pipeline call sites (`captureTransform`/`applyTransform`/`contentUnchanged` callers in ConfigSyncCore + status) apply the switch-list ops for groups in `SWITCH_LIST_GROUPS` before/instead of byte comparison. `ConfigSyncSettings.switchExceptions` + a third locked self-preset. UI: "Local decisions (this device)" segment + badges per 定稿.

**Tech Stack:** TypeScript, vitest.

## Global Constraints

- Empty exceptions (`[]` / absent) must be behaviorally **identity** — byte-for-byte today's behavior (regression guard; 243-test baseline stays green).
- `switchExceptions` is device-local: stored in `ConfigSyncSettings`, protected by a locked strip preset on the self item (never travels).
- Arrays preserve order (store order for synced ids, local order for kept exceptions); maps preserve the present:false vs absent distinction for excepted keys.
- Malformed switch-list JSON → fall back to existing behavior (no crash, plain comparison).
- Zero hardcoded color; caution accents via `--color-orange` vars. Gates per task: build, lint (0 errors ≤65 warnings), tests, color scan. No Claude/AI attribution.

---

### Task 1: Pure `src/core/switchList.ts` + tests

**Files:** Create `src/core/switchList.ts`, `tests/switchList.test.ts`.

**Interfaces (produced — Tasks 2–4 consume verbatim):**

```ts
export const SWITCH_LIST_GROUPS: ReadonlySet<string> = new Set(["community-plugins", "core-plugins"]);
export type SwitchList = string[] | Record<string, boolean>;
export function parseSwitchList(content: string): SwitchList | null; // null on malformed
export function captureSwitchList(local: SwitchList, exceptions: string[]): SwitchList;
export function applySwitchList(store: SwitchList, local: SwitchList | null, exceptions: string[]): SwitchList;
export function switchListsEqual(local: SwitchList, store: SwitchList, exceptions: string[]): boolean;
```

- [ ] **Step 1: Failing tests** covering: array capture strips excepted ids (order preserved); map capture removes excepted keys; apply array = (store − exc, store order) ++ (local ∩ exc, local order); apply map = store minus exc keys plus local's excepted entries (present:false kept, absent stays absent; `local === null` → store minus exc); equality masks exceptions on both sides (differs only in excepted ids → equal; differs in a synced id → not equal); empty exceptions = identity (capture/apply return structurally equal input; equality = deep equality); parseSwitchList: array ok, map ok, `"{}"`→map, `"[]"`→array, garbage/number/string → null.
- [ ] **Step 2: Implement** (pure; no imports beyond types; deterministic).
- [ ] **Step 3: Gates + commit** — `git commit -m "feat: pure switch-list ops with per-device exception masking"`.

---

### Task 2: Data model + threading + hooks

**Files:** Modify `src/main.ts` (settings field, ctx), `src/core/ConfigSyncCore.ts` (ctx field; capture/apply hook points at lines ~187/200 and ~472/482), `src/core/status.ts` (comparison hook where `contentUnchanged` is used), `src/core/catalog.ts` (third preset in `selfPresetRules`), tests (ctx factory + catalog/migration test updates).

**Interfaces:**
- `CoreContext.switchExceptions: Record<string, string[]>` (tests default `{}`).
- Helper in ConfigSyncCore: `excFor(ctx, name): string[]` → `SWITCH_LIST_GROUPS.has(name) ? ctx.switchExceptions[name] ?? [] : []`.

- [ ] **Step 1: Failing integration tests** (tests/core.test.ts): capture of a `community-plugins` group with `switchExceptions: {"community-plugins": ["x"]}` writes a store copy without `"x"` while the local file keeps it; apply brings store list but keeps local state for `"x"`; statusForGroups reports `in-sync` when local and store differ only in `"x"`, and a real diff still reports change. Same trio for a `core-plugins` map fixture. catalog test: `selfPresetRules()` has the third locked rule; `ensureSelfPresets` adds it to an existing two-rule self group.
- [ ] **Step 2: Implement.** Settings: `switchExceptions: Record<string, string[]>` + `{}` default; `coreContext()` passes it. Hook points: in `captureGroup` (before `captureTransform` at ~187/200) and `applyGroup` (before writing, at ~472/482) and the status comparison (`contentUnchanged` caller in status.ts): when `excFor(ctx, group.name).length > 0` and `parseSwitchList` succeeds on the relevant contents, use `captureSwitchList`/`applySwitchList`/`switchListsEqual` (serialize with `JSON.stringify(v, null, 2) + "\n"`); otherwise fall through to today's path. `selfPresetRules()` gains `{ pattern: "switchExceptions", action: "strip", locked: true }`.
- [ ] **Step 3: Gates + commit** — `git commit -m "feat: switch-list exceptions thread through capture, apply and status"`.

---

### Task 3: Config panel — "Local decisions (this device)" segment — **INLINE**

**Files:** Modify `src/ui/SettingTab.ts`, `src/main.ts` (host data fn), `styles.css`.

- [ ] **Step 1: Host fn** (SettingTab host in main.ts): `switchListRows(group: string): Promise<{ id: string; name: string; hint: string }[]>` — union of local-list ids ∪ store-copy ids ∪ (community → installed plugins / core → runtime cores), each with display name and state hint ("enabled here · in store" style); plus `getSwitchExceptions(group)` / `setSwitchExceptions(group, ids)` writing settings.
- [ ] **Step 2: UI per 定稿** (`switch-exceptions.html`): in `renderItemExpansion` for groups in `SWITCH_LIST_GROUPS`, render the segment: label + desc line, one row per id (name + hint + synced↔local-decision toggle; marked rows caution-tinted). Header badge "N local decisions" (caution-tinted) on the item row when N > 0. Toggle → set settings + refresh.
- [ ] **Step 3: CSS** (theme-native, `--color-orange` accents only), gates, two-theme rendered check in dev vault against the mockup.
- [ ] **Step 4: Commit** — `git commit -m "feat: local-decisions editor on the switch-list items"`.

---

### Task 4: Sync Center — hint + ⌂ detail — **INLINE**

**Files:** Modify `src/ui/SyncCenterView.ts`, `src/main.ts` (host exposure of exceptions), `styles.css` (if needed).

- [ ] **Step 1:** Switch-list rows: status hint appends `· N local decisions` when N > 0.
- [ ] **Step 2:** Row expansion detail for switch-list items: a compact id-level diff block — `＝ n synced` summary line, `⌂ <id> — local decision` per excepted id (caution color), real shared diffs keep ±. (Replaces the generic file-change line for these two items only.)
- [ ] **Step 3:** Gates + two-theme check + commit — `git commit -m "feat: sync center surfaces switch-list local decisions"`.

---

### Task 5: Controller smoke

- [ ] Mark an enabled plugin as local decision in the dev vault → capture → store copy lacks it → doctor store list → status stays ✓ when only excepted ids differ / `≠` when a synced id differs → apply → excepted id keeps local state, synced ids follow → UI round-trip (toggle, badge, ⌂ rows) → no error frames → ledger.

---

## Self-Review Notes

- Spec coverage: D1/D2/D3 → T1–T2; data model + preset → T2; UI 定稿 both surfaces → T3–T4; edge cases (orthogonality untouched — no code touches plugin-* items; malformed fallback → T1 parse + T2 fall-through; false/absent → T1).
- Type consistency: `SWITCH_LIST_GROUPS`/`SwitchList`/four functions used identically across T1→T2→T3/T4.
- Execution: T1–T2 subagent; T3–T5 inline. Post-plan: user pre-merge acceptance → merge → cut (0.23.0) with hand-written release notes.
