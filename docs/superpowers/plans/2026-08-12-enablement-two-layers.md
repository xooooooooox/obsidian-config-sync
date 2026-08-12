# 启用范围:两粒度 × 两层 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move "which devices does this run on" onto one 2×2 model — fleet rules in the carrier item's `perElement`, this-device exceptions in localStorage — and delete the five overlapping expressions it replaces.

**Architecture:** Three new pure core modules carry the model (fleet rules, local exception table, precedence). The runtime mask keeps its existing convergence point (`main.ts`'s `switchExceptions` + `switchForceOn`/`switchForceOff`) and only changes where its inputs are read from. The two plugin lists become ordinary registry items, so a carrier gets a settings-panel card and a lock/baseline key it already had (`carrierRef(list) === itemRef("obsidian", list)` — identical string, no re-key). A one-shot v3 → v4 document migration lands the new shapes; its hard acceptance condition is that the three on/off list files are byte-identical before and after.

**Tech Stack:** TypeScript (strict), Obsidian API, vitest, esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-12-enablement-two-layers-design.md` — the sole source of requirements. Mockup (visual 定稿, consult before any UI edit): https://claude.ai/code/artifact/930aee7a-0d4b-43a8-9ca0-5437688a78f6

---

## Global Constraints

Every task's requirements implicitly include this section.

**Data & invariants**

- Invariant I — where a datum lives: `localStorage` (this device only) / locked-local `data.json` fields (transport wiring) / shared `data.json` (the fleet contract) / `store.lock.json` (what is in the store). A datum never lives in two of them.
- Invariant II — unknown ⇒ preserve: carry unknown fields through every read/write; ignore an unknown enum value at the point of use (never rewrite storage for it); refuse a higher `schemaVersion` rather than reset.
- `store.lock.json` is NOT touched: `STORE_LOCK_VERSION` stays `3`, its shape unchanged.
- `config-sync-device-optouts` keeps its current key AND its current value shape (a JSON array of item refs). Do not re-key it.
- Per-key field rules (`rules` / `FieldRule`), encryption, and the companion-folder mechanism are out of scope.
- No fleet-level ledger of "what each device chose" — that is the thing being deleted.

**Copy — verbatim, no synonyms**

- Device vocabulary, the only three allowed: `this device` / `your other devices` / `the store`.
- Rule values: `All devices` · `Desktop only` · `Mobile only` · `Each device decides`.
- Local segment: `Follows the default` · `On here` · `Off here` · `Not synced here`.
- Row labels: `Default enabled on` · `Default settings sync` · `More`.
- `More` row tooltip: `Per-key rules, locks & folders — opens Settings` (folder items: `Folder rules — opens Settings`). No trailing `▸`.
- Carrier chip words: `synced` / `not synced`. Tooltips: synced → `Which plugins are on is shared with your other devices — opens Settings`; not synced → `Which plugins are on stays on this device — opens Settings`.
- Carrier card drawer section title: `Which devices turn each plugin on`.
- Carrier card badges: `N device-scoped` (fleet fact) / `N left to me` (local fact).
- The fold-group line `N items not synced on this device` (`panelModel.ts`'s `excludedLineText`) is NOT changed.

**Icons — the registry in spec §7**

- `power` = local exception, on here. `power-off` = local exception, off here. `circle-slash` = not synced here. `settings-2` = opens Settings.
- Mandatory cleanup: `fateChipIcons.ts`'s `"stays off"` moves from `power` to `power-off` (one glyph, one meaning).
- `sliders-horizontal` stays `your rule` and must not be reused. `airplay` is not used for the local segment. `toggle-right`/`toggle-left` retire. `cloud-*`/`refresh-cw` must not be borrowed.
- The follow state renders NO icon — only the muted words `Follows the default`.

**Process**

- Retirement means DELETION, not a reader left with no callers.
- One datum, one write function, one read function. One derived key, one producer. Tests assert producer-vs-producer, never against a hand-written literal.
- Commit per task on the feature branch. **No Claude/AI attribution in any commit message** (`Claude-Session:`, `Co-Authored-By: Claude`, `🤖 Generated with Claude Code` — none of them). Never push.
- After every task: `npm test` (baseline 1535 passing) and `npm run build` must both be clean. `npm run lint` baseline is 0 errors / 57 warnings — never higher.
- Comments in this codebase explain WHY, at the density of the surrounding file. Match it.

**Two decisions this plan makes that the spec did not spell out** (both flagged to the user; implement as written):

1. **A custom item's device class** loses its `runsOn.device` home. It moves to `settingsFile.fileRule.sharing` — the field the Sync Center's `Settings sync` row already writes for every registry item — so `setCustomItemDevice` collapses into `setItemFileSharing`. `manifest.ts:191-195` rejects a `fileRule` on a `type: "folder"` group, so `customGroup` elevates the sharing into `devices` and does not emit `group.fileRule` for a folder. (Task 8)
2. **The carrier's own `synced` flag needs a migration value.** Today a carrier group exists iff any item in its section is synced (`anyEnabledInList`). Once the carrier is a real item, it exists iff `items.obsidian["core-plugins"].synced`. The migration therefore seeds each carrier's `synced` from that same predicate, or on/off sync silently stops on the first v4 load. (Task 9)
3. **Which engine APPLIES a rule.** Spec §3.3's table routes `community-plugins` through `perElement.ts`'s array path; spec §5 says the masking convergence point does not change. They disagree, and §5 wins — it is the behavioural claim. Today BOTH plugin lists are applied by `switchList.ts`'s id masking (`captureSwitchList`/`applySwitchList`, driven by `switchExceptions`/`switchForceOn`/`switchForceOff`), and `perElement.ts` serves only `enabledCssSnippets`. That stays exactly as it is: moving community-plugins onto `perElement.ts`'s different capture formula would change apply semantics for every user in exchange for nothing. What §3.3 actually requires — that rule STORAGE is uniform while APPLICATION is shape-aware — holds either way.

---

## Pre-flight (do this before Task 1)

The worktree currently holds TWO uncommitted batches: the `loose-ends` §3/§4/§5 implementation (`src/core/ConfigSyncCore.ts`, `src/core/status.ts`, `src/main.ts`, `src/ui/SettingTab.ts`, four test files, three docs) and the two new spec files. This plan edits `main.ts` and `SettingTab.ts` heavily.

- [ ] **Step 1: Confirm the worktree is clean before Task 1 starts**

```bash
git -C . status --short
```

Expected: no modified files. If the §3/§4/§5 batch is still uncommitted, STOP and ask the user whether to commit it first (their review state — never commit it unprompted). Do not begin Task 1 on top of an uncommitted batch: a later `git diff BASE HEAD` review package would mix the two.

- [ ] **Step 2: Record BASE**

```bash
git -C . rev-parse HEAD
```

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/core/enablementRules.ts` | THE fleet-rule store: read/write one element's `Sharing` in the carrying item's `settingsFile.perElement[key]`. Owns `ruleHomeFor` (which item + which key), the only producer of that pair. |
| `src/core/deviceElements.ts` | THE local exception table: pure parse/read/write over `config-sync-device-elements`. |
| `src/core/enablementDecision.ts` | THE precedence: (rule, exception, device class) → `{masked, force}`. Four rules, one function. |
| `src/core/v4Migration.ts` | The one-shot v3 → v4 document rewrite. Pure; the shell owns I/O and the localStorage half. |
| `src/ui/enablementRow.ts` | The two-segment row MODEL (fleet segment + local segment) shared by the Sync Center row, the plugin card and the carrier card — one producer for what each segment says. |
| `tests/enablementRules.test.ts`, `tests/deviceElements.test.ts`, `tests/enablementDecision.test.ts`, `tests/v4Migration.test.ts`, `tests/enablementRow.test.ts`, `tests/enablementRuntime.test.ts` | One suite per new module, plus the runtime/migration end-to-end suite built on the real `ConfigSyncPlugin` harness. |

**Files that change substantially**

| File | Change |
|---|---|
| `src/core/types.ts` | Delete `RunsOn`, `runsOnEquals`, `asRunsOn`. Everything else stands. |
| `src/core/registry.ts` | `Item.enabled` → `Item.synced`; delete `runsOn`/`elements`; delete `withRunsOnDevice`/`itemWithDevice`/`enablementSharing`/`structuralLocalElements`/`elementSharings`/`deviceSharing`; the two carriers become `OBSIDIAN_CARD_DEFS` entries; `compileItems` loses its `ENABLEMENT_LISTS` loop; gains `defaultSettingsFile`/`pruneSettingsFile`/`deriveMode` (moved out of `ui/itemCard.ts`). |
| `src/core/switchList.ts` | Gains `perElementKeyFor`. |
| `src/core/availability.ts` | Delete `forcedRunsOn`/`preferStoredRunsOn`. |
| `src/core/catalog.ts` | Drop the `thisDeviceItems` locked preset rule. |
| `src/core/settingsMigration.ts` | `CURRENT_SCHEMA` 3 → 4; `MIGRATABLE_SCHEMA` stays 2 (v2 → v3 → v4 chains through both migrations). |
| `src/main.ts` | Settings type v4; delete `thisDeviceItems`/`bratIndex`; mask inputs rewired; six new host methods; nine old ones deleted. |
| `src/ui/itemCard.ts` | Delete `RUNS_ON_OPTIONS`/`runsOnIcon`/`runsOnLabel`/`runsOnIsDefault`/`withSnippetSharing`; `deriveMode` moves to core; gains the local-segment icon/label vocabulary. |
| `src/ui/SyncCenterView.ts` | `Runs on` row → `Default enabled on` two-segment row; `Settings sync` row gains its local segment; `More` row becomes an icon; the Stop-syncing footer is deleted; the carrier chip becomes read-only. |
| `src/ui/SettingTab.ts` | `Enabled on` 4-stop cycle → `Default enabled on` two-segment row; snippet member rows and the new carrier element rows share one renderer. |
| `src/ui/fateModel.ts` | `FateInput.runsOn` → `ruleSharing` + `localException`. |
| `src/ui/fateChipIcons.ts` | `"stays off"` → `power-off`. |
| `styles.css` | The two-segment row's four-track grid + the local segment's accent. |
| `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md`, `docs/GUIDE.md`, `README.md`, `README.zh.md` | Doc currency (Task 13). |

---

### Task 1: The fleet-rule store (`enablementRules.ts`) + `perElementKeyFor`

**Files:**
- Modify: `src/core/switchList.ts` (add `perElementKeyFor` after `enablementListFile`, ~line 34)
- Create: `src/core/enablementRules.ts`
- Modify: `src/core/registry.ts` (move `defaultSettingsFile`/`pruneSettingsFile`/`deriveMode` in from `src/ui/itemCard.ts:147-155,253-272`)
- Modify: `src/ui/itemCard.ts` (delete the three moved functions; re-import `deriveMode`/`hasKeyRules` users)
- Modify: `src/ui/SettingTab.ts`, `src/main.ts`, `src/ui/SyncCenterView.ts` (import sites only)
- Test: `tests/enablementRules.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `perElementKeyFor(list: string): string` — `SWITCH_LISTS[list].field ?? ""`, throws on an unknown list.
  - `type RuleListId = "core-plugins" | "community-plugins" | "enabled-css-snippets"`
  - `ruleHomeFor(list: RuleListId): { section: "obsidian"; id: string; key: string }`
  - `enablementRules(items: ItemMap, list: RuleListId): PerElementSharing`
  - `enablementRuleFor(items: ItemMap, list: RuleListId, elementId: string): Sharing`
  - `withEnablementRule(items: ItemMap, list: RuleListId, elementId: string, sharing: Sharing): ItemMap`
  - `ruledElementIds(items: ItemMap, list: RuleListId): string[]`
  - moved to `src/core/registry.ts`, same signatures: `defaultSettingsFile()`, `pruneSettingsFile(sf)`, `deriveMode(sf)`

- [ ] **Step 1: Write the failing test**

Create `tests/enablementRules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { perElementKeyFor, SWITCH_LISTS } from "../src/core/switchList";
import { enablementRuleFor, enablementRules, ruledElementIds, ruleHomeFor, withEnablementRule } from "../src/core/enablementRules";
import { deriveMode, emptyItemMap, itemAt } from "../src/core/registry";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";
import { itemsIn } from "./items";

describe("perElementKeyFor", () => {
  // Producer-vs-producer (spec §9 lesson 3): the reserved key is whatever the ONE producer says
  // it is, asserted against SWITCH_LISTS itself — never against a hand-written "" literal.
  it("answers the field name for a field list and the reserved key for a whole-file list", () => {
    for (const [list, spec] of Object.entries(SWITCH_LISTS)) {
      expect(perElementKeyFor(list)).toBe(spec.field ?? "");
    }
  });

  it("throws on a list SWITCH_LISTS does not declare", () => {
    expect(() => perElementKeyFor("not-a-list")).toThrow(/no spec/);
  });
});

describe("ruleHomeFor", () => {
  it("routes the two plugin lists to their own item and snippets to appearance, always via perElementKeyFor", () => {
    expect(ruleHomeFor("core-plugins")).toEqual({ section: "obsidian", id: "core-plugins", key: perElementKeyFor("core-plugins") });
    expect(ruleHomeFor("community-plugins")).toEqual({ section: "obsidian", id: "community-plugins", key: perElementKeyFor("community-plugins") });
    expect(ruleHomeFor("enabled-css-snippets")).toEqual({ section: "obsidian", id: "appearance", key: perElementKeyFor("enabled-css-snippets") });
  });
});

describe("enablementRules", () => {
  it("reads an element's rule out of the carrying item, defaulting to everywhere", () => {
    const items = withEnablementRule(emptyItemMap(), "community-plugins", "obsidian-git", perClass("desktop"));
    expect(enablementRuleFor(items, "community-plugins", "obsidian-git")).toEqual(perClass("desktop"));
    expect(enablementRuleFor(items, "community-plugins", "dataview")).toEqual(EVERYWHERE);
    expect(ruledElementIds(items, "community-plugins")).toEqual(["obsidian-git"]);
  });

  it("writes under the reserved key for a whole-file list and under the field name for snippets", () => {
    const plugins = withEnablementRule(emptyItemMap(), "core-plugins", "daily-notes", THIS_DEVICE);
    expect(itemAt(plugins, "obsidian", "core-plugins")?.settingsFile?.perElement).toEqual({
      [perElementKeyFor("core-plugins")]: { "daily-notes": THIS_DEVICE },
    });
    const snippets = withEnablementRule(emptyItemMap(), "enabled-css-snippets", "mobile.css", perClass("mobile"));
    expect(itemAt(snippets, "obsidian", "appearance")?.settingsFile?.perElement).toEqual({
      [perElementKeyFor("enabled-css-snippets")]: { "mobile.css": perClass("mobile") },
    });
  });

  it("an everywhere write clears the entry, and clearing the last one leaves data.json as it was found (C-#26)", () => {
    const before = emptyItemMap();
    const with1 = withEnablementRule(before, "core-plugins", "daily-notes", THIS_DEVICE);
    const back = withEnablementRule(with1, "core-plugins", "daily-notes", EVERYWHERE);
    expect(back).toEqual(before);
  });

  it("ignores a rule value this build cannot read, leaving it on disk (invariant II.2)", () => {
    const items = itemsIn({
      obsidian: {
        "core-plugins": {
          synced: true,
          settingsFile: { mode: "plain", rules: {}, perElement: { "": { "daily-notes": { kind: "from-the-future" } as never } } },
        },
      },
    });
    expect(enablementRuleFor(items, "core-plugins", "daily-notes")).toEqual(EVERYWHERE);
    expect(enablementRules(items, "core-plugins")).toEqual({});
  });

  it("the reserved key never makes a file fields-mode", () => {
    const items = withEnablementRule(emptyItemMap(), "core-plugins", "daily-notes", THIS_DEVICE);
    const sf = itemAt(items, "obsidian", "core-plugins")?.settingsFile;
    expect(sf).toBeDefined();
    expect(deriveMode(sf!)).toBe("plain");
  });

  it("a snippets rule still makes appearance fields-mode, exactly as before", () => {
    const items = withEnablementRule(emptyItemMap(), "enabled-css-snippets", "mobile.css", perClass("mobile"));
    expect(deriveMode(itemAt(items, "obsidian", "appearance")!.settingsFile!)).toBe("fields");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/enablementRules.test.ts`
Expected: FAIL — `Cannot find module '../src/core/enablementRules'`.

- [ ] **Step 3: Add `perElementKeyFor` to `src/core/switchList.ts`**

Insert directly after `enablementListFile` (line 34):

```ts
// The `perElement` key a list's rules live under (spec §3.3). A field list is indexed by its JSON
// key name (appearance's `enabledCssSnippets`); a whole-file list has no key name to index, so the
// reserved key "" means "this file itself is the list".
//
// THE one producer of that string. Every compare, lookup and write goes through it, and the tests
// assert it against SWITCH_LISTS rather than against a literal — a derived key with two authors is
// the drift this release exists to end (spec §9 lesson 2/3).
export function perElementKeyFor(list: string): string {
  const spec = SWITCH_LISTS[list];
  if (spec === undefined) throw new Error(`switch list "${list}" has no spec — SWITCH_LISTS and the caller disagree about "${list}"`);
  return spec.field ?? "";
}
```

- [ ] **Step 4: Move the three settingsFile helpers into `src/core/registry.ts`**

Cut `defaultSettingsFile` (`itemCard.ts:253-255`), `pruneSettingsFile` (`itemCard.ts:257-272`) and `deriveMode` (`itemCard.ts:141-149`) verbatim — comments included — and paste them into `registry.ts` immediately after the `ItemSettingsFile` interface (~line 92). Then change `deriveMode`'s body to ignore the reserved key:

```ts
// Derived mode (spec 2026-07-26-card-visual-refresh-design.md §3): the stored mode is written by
// the UI, never chosen by the user — any per-key customization makes the card per-key ("fields");
// none makes it whole-file ("plain").
//
// The reserved perElement key "" (switchList.ts's perElementKeyFor) is excluded ON PURPOSE (spec
// §3.3): it means "this whole file is the list", which is the very definition of a whole-file
// group. Counting it would compile core-plugins.json as a fields-mode group and send a boolean map
// down perElement.ts's string-array path, which cannot read it.
export function deriveMode(sf: ItemSettingsFile): "plain" | "fields" {
  return Object.keys(sf.rules).length > 0 || Object.keys(sf.perElement).some((k) => k !== "") ? "fields" : "plain";
}
```

In `itemCard.ts`, delete the three functions and re-export nothing; instead add `deriveMode`, `defaultSettingsFile`, `pruneSettingsFile` to its existing `import { … } from "../core/registry"` line so `hasKeyRules` still compiles. Update the import sites in `src/main.ts`, `src/ui/SettingTab.ts` and `src/ui/SyncCenterView.ts` to take them from `../core/registry` instead of `./itemCard`.

- [ ] **Step 5: Write `src/core/enablementRules.ts`**

```ts
/**
 * THE fleet-level enablement rule store (spec 2026-08-12-enablement-two-layers-design.md §3.3).
 *
 * One question — "which devices turn this element on?" — with one answer per element, stored on the
 * item that CARRIES the list the element lives in, under `settingsFile.perElement[<key>]`. The value
 * is the existing `Sharing` union verbatim: `everywhere` / `per-class` / `this-device`. Nothing new
 * was invented for "each device decides" — `this-device` already means "never enters the store,
 * never resurrected from it" (perElement.ts's capture/apply), which is exactly that.
 *
 * Storage is uniform; APPLICATION is not, and must not be (§3.3): community-plugins.json and
 * appearance.json's enabledCssSnippets are string arrays and go through perElement.ts, while
 * core-plugins.json is a Record<string, boolean> and goes through switchList.ts's own id masking.
 * That split lives at the runtime seam (main.ts), never here — this module only answers what the
 * rule IS.
 *
 * ONE reader, ONE writer (§6.6). The three UI entrances — a carrier card's element row, a plugin
 * card's `Default enabled on`, a Sync Center row — all come through this file.
 */
import { ItemMap, ItemSettingsFile, defaultSettingsFile, itemAt, emptyItem, pruneSettingsFile, withItem } from "./registry";
import { perElementKeyFor } from "./switchList";
import { asSharing, EVERYWHERE, ItemId, PerElementSharing, Sharing } from "./types";

// The three lists that have per-element rules. Wider than switchList.ts's `EnablementList` (which
// answers "can an ITEM's enablement ride this list?") on purpose: snippets have per-element rules
// and no items, and they have had them since 2026-07-25 — this module is what makes the two plugin
// lists use the same mechanism instead of a second one.
export type RuleListId = "core-plugins" | "community-plugins" | "enabled-css-snippets";

export interface RuleHome {
  section: "obsidian";
  id: ItemId;
  key: string;
}

// WHICH item carries a list's rules, and under which key — one producer for both halves, because
// they are one fact. The two plugin lists carry their own (they are items since this release); the
// snippet list is a FIELD of appearance.json, so appearance carries it, exactly as it does today.
export function ruleHomeFor(list: RuleListId): RuleHome {
  return { section: "obsidian", id: list === "enabled-css-snippets" ? "appearance" : list, key: perElementKeyFor(list) };
}

// Every readable rule for a list. A value whose shape this build does not recognise is dropped FROM
// THE READ only (invariant II.2, types.ts's asSharing) — never rewritten on disk, and never allowed
// to reach the mask as a decision nobody asked for.
export function enablementRules(items: ItemMap, list: RuleListId): PerElementSharing {
  const home = ruleHomeFor(list);
  const raw = itemAt(items, home.section, home.id)?.settingsFile?.perElement?.[home.key] ?? {};
  const out: PerElementSharing = {};
  for (const [element, value] of Object.entries(raw)) {
    const sharing = asSharing(value);
    if (sharing !== undefined) out[element] = sharing;
  }
  return out;
}

export function enablementRuleFor(items: ItemMap, list: RuleListId, elementId: string): Sharing {
  return enablementRules(items, list)[elementId] ?? EVERYWHERE;
}

export function ruledElementIds(items: ItemMap, list: RuleListId): string[] {
  return Object.keys(enablementRules(items, list));
}

// Pure. An `everywhere` write CLEARS the entry rather than storing the default, and an emptied map
// drops its key — so a round trip through the control leaves data.json byte-identical to how it
// started (C-#26). pruneSettingsFile then drops the whole settingsFile when nothing is left, which
// is why the round-trip test can compare against the untouched map.
export function withEnablementRule(items: ItemMap, list: RuleListId, elementId: string, sharing: Sharing): ItemMap {
  const home = ruleHomeFor(list);
  const item = itemAt(items, home.section, home.id) ?? emptyItem();
  const sf = item.settingsFile ?? defaultSettingsFile();
  const forKey = { ...(sf.perElement[home.key] ?? {}) };
  if (sharing.kind === "everywhere") delete forKey[elementId];
  else forKey[elementId] = sharing;
  const perElement = { ...sf.perElement };
  if (Object.keys(forKey).length === 0) delete perElement[home.key];
  else perElement[home.key] = forKey;
  const withKey: ItemSettingsFile = { ...sf, perElement };
  const pruned = pruneSettingsFile({ ...withKey, mode: deriveMode(withKey) });
  const nextItem: Item = { ...item };
  if (pruned === undefined) delete nextItem.settingsFile;
  else nextItem.settingsFile = pruned;
  return withItem(items, home.section, home.id, nextItem);
}
```

`deriveMode` is imported from `./registry` (Task 1 step 4 moved it there); it is what keeps the reserved key from turning a whole-file list into a fields-mode group.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/enablementRules.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Full suite + build**

Run: `npm test && npm run build && npm run lint`
Expected: tests pass (the `deriveMode` move may need import fixes in `tests/itemCard.test.ts` — fix them), build clean, lint ≤ 0 errors / 57 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/core/switchList.ts src/core/enablementRules.ts src/core/registry.ts src/ui/itemCard.ts src/ui/SettingTab.ts src/ui/SyncCenterView.ts src/main.ts tests/
git commit -m "feat(core): one home and one producer for per-element enablement rules"
```

---

### Task 2: The local exception table (`deviceElements.ts`)

**Files:**
- Create: `src/core/deviceElements.ts`
- Test: `tests/deviceElements.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const DEVICE_ELEMENTS_KEY = "config-sync-device-elements"`
  - `type DeviceElementState = "on" | "off"`
  - `type DeviceElements = Record<string, Record<string, DeviceElementState>>` (outer key = the `SWITCH_LISTS` list id)
  - `parseDeviceElements(raw: unknown): DeviceElements`
  - `deviceElementState(table: DeviceElements, list: string, elementId: string): DeviceElementState | null`
  - `withDeviceElement(table: DeviceElements, list: string, elementId: string, state: DeviceElementState | null): DeviceElements`
  - `deviceElementIds(table: DeviceElements, list: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/deviceElements.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deviceElementIds, deviceElementState, DEVICE_ELEMENTS_KEY, parseDeviceElements, withDeviceElement } from "../src/core/deviceElements";

describe("parseDeviceElements", () => {
  it("reads the two-level table", () => {
    const raw = JSON.stringify({ "community-plugins": { "obsidian-kanban": "on", "some-plugin": "off" }, "core-plugins": { "daily-notes": "off" } });
    expect(parseDeviceElements(raw)).toEqual({
      "community-plugins": { "obsidian-kanban": "on", "some-plugin": "off" },
      "core-plugins": { "daily-notes": "off" },
    });
  });

  it.each([null, undefined, "", "not json", "[]", '"a string"', "42", JSON.stringify({ "core-plugins": ["daily-notes"] })])(
    "reads %s as no exceptions at all — a device that cannot read its own table must still sync",
    (raw) => {
      expect(parseDeviceElements(raw)).toEqual({});
    }
  );

  it("drops only the unreadable entries, keeping the readable ones beside them", () => {
    const raw = JSON.stringify({ "core-plugins": { "daily-notes": "off", graph: "maybe", canvas: 1 } });
    expect(parseDeviceElements(raw)).toEqual({ "core-plugins": { "daily-notes": "off" } });
  });

  it("names its localStorage key once", () => {
    expect(DEVICE_ELEMENTS_KEY).toBe("config-sync-device-elements");
  });
});

describe("withDeviceElement", () => {
  it("sets, flips and clears — and a clear that empties a list drops the list", () => {
    const on = withDeviceElement({}, "core-plugins", "daily-notes", "on");
    expect(deviceElementState(on, "core-plugins", "daily-notes")).toBe("on");
    const off = withDeviceElement(on, "core-plugins", "daily-notes", "off");
    expect(deviceElementState(off, "core-plugins", "daily-notes")).toBe("off");
    expect(withDeviceElement(off, "core-plugins", "daily-notes", null)).toEqual({});
  });

  it("never mutates its input", () => {
    const before = withDeviceElement({}, "core-plugins", "daily-notes", "on");
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown;
    withDeviceElement(before, "core-plugins", "graph", "off");
    expect(before).toEqual(snapshot);
  });

  it("answers null for an element with no exception, and lists the ids that have one", () => {
    const t = withDeviceElement(withDeviceElement({}, "core-plugins", "graph", "off"), "core-plugins", "daily-notes", "on");
    expect(deviceElementState(t, "core-plugins", "canvas")).toBeNull();
    expect(deviceElementState(t, "community-plugins", "graph")).toBeNull();
    expect(deviceElementIds(t, "core-plugins").sort()).toEqual(["daily-notes", "graph"]);
    expect(deviceElementIds(t, "community-plugins")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/deviceElements.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/deviceElements.ts`**

```ts
/**
 * THE local exception table (spec 2026-08-12-enablement-two-layers-design.md §3.4): which on/off
 * elements THIS device has taken out of the shared answer, and what it decided for them.
 *
 * It lives in localStorage and nowhere else, for the reason C-#52 paid for once already: a datum
 * true only of this device, stored in a document that travels wholesale, is a datum another
 * device's pull will overwrite. `thisDeviceItems` was exactly that, and this table is what replaces
 * it.
 *
 * The shape mirrors data.json's `perElement` — two levels, the same element ids — so a reader can
 * hold one mental model for both layers. Only the value differs: a rule says who SHARES an element,
 * an exception says whether it is on or off HERE.
 *
 * Every read is tolerant in exactly the way deviceOptOutGroups (main.ts) is: this is a plain
 * localStorage entry a user or a half-finished write can leave in any shape, and a device that
 * cannot read its own exception table must still sync. Unreadable ⇒ "no exception here" — never a
 * load failure, and never a rewrite of what was found.
 */

export const DEVICE_ELEMENTS_KEY = "config-sync-device-elements";

export type DeviceElementState = "on" | "off";

// list id (switchList.ts's SWITCH_LISTS keys) -> element id -> what this device decided.
//
// The outer key is the LIST id, not perElementKeyFor's result: the reserved-key problem does not
// exist on this side. That key exists because data.json indexes rules by the JSON field a list
// lives in, and two of the three lists have no field. localStorage has no document to index into —
// the list's own identity is the whole of it.
export type DeviceElements = Record<string, Record<string, DeviceElementState>>;

function isState(v: unknown): v is DeviceElementState {
  return v === "on" || v === "off";
}

export function parseDeviceElements(raw: unknown): DeviceElements {
  if (typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: DeviceElements = {};
  for (const [list, elements] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof elements !== "object" || elements === null || Array.isArray(elements)) continue;
    const kept: Record<string, DeviceElementState> = {};
    for (const [id, state] of Object.entries(elements as Record<string, unknown>)) {
      if (isState(state)) kept[id] = state;
    }
    if (Object.keys(kept).length > 0) out[list] = kept;
  }
  return out;
}

export function deviceElementState(table: DeviceElements, list: string, elementId: string): DeviceElementState | null {
  return table[list]?.[elementId] ?? null;
}

export function deviceElementIds(table: DeviceElements, list: string): string[] {
  return Object.keys(table[list] ?? {});
}

// Pure. `null` clears the exception; clearing the last one in a list drops the list, so the stored
// JSON never accumulates empty objects that would read as "this list has exceptions" to a human.
export function withDeviceElement(table: DeviceElements, list: string, elementId: string, state: DeviceElementState | null): DeviceElements {
  const forList = { ...(table[list] ?? {}) };
  if (state === null) delete forList[elementId];
  else forList[elementId] = state;
  const next = { ...table };
  if (Object.keys(forList).length === 0) delete next[list];
  else next[list] = forList;
  return next;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/deviceElements.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + build + commit**

```bash
npm test && npm run build && npm run lint
git add src/core/deviceElements.ts tests/deviceElements.test.ts
git commit -m "feat(core): this device's own on/off exceptions, in localStorage where they belong"
```

---

### Task 3: The precedence (`enablementDecision.ts`)

**Files:**
- Create: `src/core/enablementDecision.ts`
- Test: `tests/enablementDecision.test.ts`

**Interfaces:**
- Consumes: `DeviceElementState` (Task 2), `Sharing` (`src/core/types.ts`).
- Produces:
  - `interface EnablementDecision { masked: boolean; force: "on" | "off" | null }`
  - `decideEnablement(input: { rule: Sharing; exception: DeviceElementState | null; deviceClass: "desktop" | "mobile" }): EnablementDecision`

- [ ] **Step 1: Write the failing test**

Create `tests/enablementDecision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideEnablement } from "../src/core/enablementDecision";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

// Spec §5's four rules, top down, first hit wins.
describe("decideEnablement", () => {
  it("1. a local exception wins outright — the rule is not even consulted", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE]) {
      expect(decideEnablement({ rule, exception: "on", deviceClass: "mobile" })).toEqual({ masked: true, force: "on" });
      expect(decideEnablement({ rule, exception: "off", deviceClass: "mobile" })).toEqual({ masked: true, force: "off" });
    }
  });

  it("2. each-device-decides masks without forcing — the element keeps whatever this device has", () => {
    expect(decideEnablement({ rule: THIS_DEVICE, exception: null, deviceClass: "desktop" })).toEqual({ masked: true, force: null });
  });

  it("3. a class rule for the other class masks AND forces off", () => {
    expect(decideEnablement({ rule: perClass("desktop"), exception: null, deviceClass: "mobile" })).toEqual({ masked: true, force: "off" });
    expect(decideEnablement({ rule: perClass("mobile"), exception: null, deviceClass: "desktop" })).toEqual({ masked: true, force: "off" });
  });

  it("3b. a class rule for THIS class is not a mask at all — plain shared-list membership", () => {
    expect(decideEnablement({ rule: perClass("desktop"), exception: null, deviceClass: "desktop" })).toEqual({ masked: false, force: null });
  });

  it("4. everything else follows the shared list", () => {
    expect(decideEnablement({ rule: EVERYWHERE, exception: null, deviceClass: "mobile" })).toEqual({ masked: false, force: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/enablementDecision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/enablementDecision.ts`**

```ts
/**
 * THE precedence (spec 2026-08-12-enablement-two-layers-design.md §5): given the fleet rule for an
 * element, this device's own exception for it, and this device's class, what does a run do?
 *
 * Four rules, top down, first hit wins — and they are HERE, once, because they used to be spread
 * across `memberLocalIdsFor`, `memberForceOffIds`, `runsOnForces` and `preferStoredRunsOn`, which is
 * why "a local choice survives a pull" (C-#52) was true in one of them and false in another.
 *
 * The two outputs mean what they have always meant to the switch-list engine:
 *   - `masked`: the id joins `switchExceptions` — capture passes it through untouched (it can
 *     neither add nor remove the element from the shared list) and apply keeps this device's own
 *     state for it.
 *   - `force`: on top of the mask, apply writes the state outright (`switchForceOn`/
 *     `switchForceOff`). `null` means "leave whatever is on disk".
 *
 * `this-device` with no exception masks WITHOUT forcing: the element is this device's business, and
 * pass-through is exactly "leave it alone". A force would be this build deciding something the user
 * never said.
 */
import { DeviceElementState } from "./deviceElements";
import { Sharing } from "./types";

export interface EnablementDecision {
  masked: boolean;
  force: "on" | "off" | null;
}

const FOLLOW: EnablementDecision = { masked: false, force: null };

export function decideEnablement(input: { rule: Sharing; exception: DeviceElementState | null; deviceClass: "desktop" | "mobile" }): EnablementDecision {
  if (input.exception !== null) return { masked: true, force: input.exception };
  if (input.rule.kind === "this-device") return { masked: true, force: null };
  if (input.rule.kind === "per-class" && input.rule.class !== input.deviceClass) return { masked: true, force: "off" };
  return FOLLOW;
}
```

- [ ] **Step 4: Run the tests, then the suite**

Run: `npx vitest run tests/enablementDecision.test.ts && npm test && npm run build && npm run lint`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/enablementDecision.ts tests/enablementDecision.test.ts
git commit -m "feat(core): one precedence for local exception, rule and device class"
```

---

### Task 4: `Item.enabled` → `Item.synced`

**Files:**
- Modify: `src/core/registry.ts` (`Item`, `emptyItem`, `itemEarnsDef`, `WRITTEN_ITEM_KEYS`, `compileSingleFile`, `compileCompanions`, `compileCustomItems`, `customGroup`, `customItemFromGroup`, `anyEnabledInList`, `parentCardLabel`, `presetCompanionFallback`, `defsForForeignItems`)
- Modify: `src/main.ts`, `src/ui/SettingTab.ts`, `src/ui/SyncCenterView.ts`, `src/ui/itemCard.ts`, `src/core/catalog.ts`, `src/core/v2Migration.ts`
- Modify: every test that builds an `Item` literal
- Test: existing suite is the test

**Interfaces:**
- Consumes: nothing.
- Produces: `Item.synced: boolean` replacing `Item.enabled`. `emptyItem()` returns `{ synced: false }`. `itemEarnsDef` reads `item.synced`.

**Note for the implementer:** this rename is TYPE-DRIVEN, never a text substitution. `ItemCompanion.enabled`, `RunHistorySettings.enabled`, `ribbonButtons` and Obsidian's own `enabledPlugins` all keep the word. Let `tsc` name the sites.

- [ ] **Step 1: Rename the field and let the compiler find every site**

In `src/core/registry.ts`:

```ts
export interface Item {
  // Is this item synced at all? Renamed from `enabled` (spec §3.2): that word meant two different
  // things one line apart — "this item is synced" and "this plugin is turned on" — and the second
  // meaning is not stored here at all (it lives in Obsidian's own on/off lists, and config-sync
  // only masks them). One word, one meaning.
  synced: boolean;
  …
}
```

Run: `npx tsc -noEmit -skipLibCheck` and fix each reported site, mechanically. The v2 migration (`v2Migration.ts:275,415,423`) writes the v3 shape, so its literals become `synced` too.

- [ ] **Step 2: Update `itemEarnsDef` and `WRITTEN_ITEM_KEYS`**

```ts
export function itemEarnsDef(item: Item): boolean {
  if (item.synced) return true;
  const keys = Object.keys(item);
  return !keys.includes("runsOn") || keys.some((k) => k !== "synced" && k !== "runsOn");
}

const WRITTEN_ITEM_KEYS = ["synced", "type", "path", "settingsFile", "companions", "runsOn", "elements", "description", "label", "origin"] as const;
```

(`runsOn`/`elements` leave in Task 8; this task only renames.)

- [ ] **Step 3: Update the fixtures**

Run: `npm test` and fix each failing fixture. `tests/items.ts` needs no change (it takes whatever `Item` is).

- [ ] **Step 4: Verify**

Run: `npm test && npm run build && npm run lint`
Expected: 1535 passing, build clean, lint at baseline.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(schema): an item is synced, a plugin is enabled — one word each"
```

---

### Task 5: The two plugin lists become real items

**Files:**
- Modify: `src/core/registry.ts` (`OBSIDIAN_CARD_DEFS`, `compileItems`, `anyEnabledInList` deletion, `ENABLEMENT_LISTS` retention)
- Modify: `src/core/itemKeys.ts` (`OBSIDIAN_CARD_IDS`)
- Test: `tests/registry.test.ts`, `tests/itemKeys.test.ts` (existing suites), plus new cases below

**Interfaces:**
- Consumes: nothing.
- Produces: `buildItemDefs` now returns five `obsidian` defs — `app`, `appearance`, `hotkeys`, `core-plugins`, `community-plugins`. `compileItems` compiles a carrier through `compileSingleFile` like any item; the special `ENABLEMENT_LISTS` loop is gone. `ENABLEMENT_LISTS`/`isEnablementList` stay (the runtime still asks "which lists carry item enablement?").

- [ ] **Step 1: Write the failing test**

Add to `tests/registry.test.ts`:

```ts
import { carrierRef } from "../src/core/itemKeys";
import { buildItemDefs, compileItems, defRef, emptyItemMap } from "../src/core/registry";
import { itemsIn } from "./items";

const env = { cores: [{ id: "daily-notes", name: "Daily notes", fileExists: true }], plugins: [{ id: "dataview", name: "Dataview" }], betaIds: new Set<string>() };

describe("the on/off lists as items", () => {
  it("a carrier's def ref IS its carrier ref — the lock and the baselines keep their key", () => {
    const defs = buildItemDefs(env);
    for (const list of ["core-plugins", "community-plugins"] as const) {
      const def = defs.find((d) => d.id === list);
      expect(def?.section).toBe("obsidian");
      expect(defRef(def!)).toBe(carrierRef(list));
    }
  });

  it("a carrier compiles exactly when its own item is synced — not when some plugin in its section is", () => {
    const defs = buildItemDefs(env);
    const pluginOnly = compileItems(defs, { items: itemsIn({ community: { dataview: { synced: true } } }) });
    expect(pluginOnly.map((g) => g.name)).not.toContain("community-plugins");

    const carrierOn = compileItems(defs, { items: itemsIn({ obsidian: { "community-plugins": { synced: true } } }) });
    const carrier = carrierOn.find((g) => g.name === "community-plugins");
    expect(carrier).toMatchObject({ name: "community-plugins", ref: carrierRef("community-plugins"), path: "{configDir}/community-plugins.json", type: "file", devices: "all" });
    expect(carrier?.mode).toBeUndefined();
    expect(carrier?.perElement).toBeUndefined();
  });

  it("element rules never reach the compiled group — storage is uniform, application is not (spec §3.3)", () => {
    const defs = buildItemDefs(env);
    const items = withEnablementRule(itemsIn({ obsidian: { "core-plugins": { synced: true } } }), "core-plugins", "daily-notes", THIS_DEVICE);
    const carrier = compileItems(defs, { items }).find((g) => g.name === "core-plugins");
    expect(carrier?.perElement).toBeUndefined();
    expect(carrier?.mode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — no def with id `core-plugins`.

- [ ] **Step 3: Add the two carrier defs**

In `src/core/registry.ts`, append to `OBSIDIAN_CARD_DEFS`:

```ts
  // The two on/off lists (spec §3.1). They were already items in every way that matters —
  // itemKeys.ts's carrierRef has keyed their lock entry and their baseline under `obsidian/<list>`
  // since v3, and the comment there ends "A carrier IS an item". The only things they lacked were a
  // data.json entry and a card, which is what this def gives them. `defRef` mints the SAME string
  // carrierRef does, so nothing is re-keyed and no baseline is orphaned.
  {
    id: "core-plugins",
    groupName: "core-plugins",
    label: "Core plugins",
    description: "Which core plugins are turned on.",
    settingsFile: { defaultPath: "{configDir}/core-plugins.json" },
  },
  {
    id: "community-plugins",
    groupName: "community-plugins",
    label: "Community plugins",
    description: "Which community plugins are turned on.",
    settingsFile: { defaultPath: "{configDir}/community-plugins.json" },
  },
```

In `src/core/itemKeys.ts`, extend `OBSIDIAN_CARD_IDS` to `["app", "appearance", "hotkeys", "core-plugins", "community-plugins"] as const` and update its comment: the legacy converter must resolve a v1/v2 `core-plugins` group name to `obsidian/core-plugins`, which the `isSwitchListGroup` branch above it already did — keep both; they now agree by construction rather than by ordering.

- [ ] **Step 4: Delete the special-case loop in `compileItems`**

Remove the whole `for (const list of ENABLEMENT_LISTS) { … }` block (`registry.ts:746-753`) and `anyEnabledInList` (`registry.ts:581-583`). The carriers now compile through the ordinary def loop above it. Leave `ENABLEMENT_LISTS`/`isEnablementList` in place.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS after fixing fixtures that assumed a carrier appears from a plugin being synced. Any test that asserts "syncing a plugin makes `community-plugins` compile" must now seed `items.obsidian["community-plugins"].synced = true` — that is the behaviour change, and Task 9's migration is what preserves it for real users.

- [ ] **Step 6: Build, lint, commit**

```bash
npm run build && npm run lint
git add -A
git commit -m "feat(registry): the on/off lists are items, with the ref they already had"
```

---

### Task 6: `bratIndex` → `items.community.<id>.bratRepo`

**Files:**
- Modify: `src/core/registry.ts` (`Item.bratRepo`, `WRITTEN_ITEM_KEYS`)
- Modify: `src/main.ts` (`ConfigSyncSettings.bratIndex` removal, `betaIds()`, `refreshBratIndex`, `storeListGroups`, `bratScanStatus`)
- Modify: `src/core/bratIndex.ts` (`resolveBratIndex` gains an items-shaped in/out, or the shell adapts — see step 3)
- Test: `tests/bratIndex.test.ts`, new cases in `tests/registry.test.ts`

**Interfaces:**
- Consumes: `Item.synced` (Task 4).
- Produces: `Item.bratRepo?: string` (`"owner/repo"`). `betaIds()` derives from `items.community` entries carrying a `bratRepo`.

- [ ] **Step 1: Write the failing test**

Add to `tests/bratIndex.test.ts`:

```ts
import { bratRepoIndex, withBratRepos } from "../src/core/bratIndex";
import { itemsIn } from "./items";

describe("BRAT repos on the plugin they belong to", () => {
  it("reads the index back out of the items map", () => {
    const items = itemsIn({ community: { dataview: { synced: true }, "some-beta": { synced: true, bratRepo: "owner/some-beta" } } });
    expect(bratRepoIndex(items)).toEqual({ "some-beta": "owner/some-beta" });
  });

  it("a resolved repo for a plugin with no entry creates a skeleton that is NOT synced", () => {
    const next = withBratRepos(itemsIn({}), { "new-beta": "owner/new-beta" });
    expect(next.community["new-beta"]).toEqual({ synced: false, bratRepo: "owner/new-beta" });
  });

  it("a repo that left BRAT's list clears the field without touching the rest of the item", () => {
    const before = itemsIn({ community: { "some-beta": { synced: true, bratRepo: "owner/some-beta", path: "custom.json" } } });
    const after = withBratRepos(before, {});
    expect(after.community["some-beta"]).toEqual({ synced: true, path: "custom.json" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/bratIndex.test.ts`
Expected: FAIL — `bratRepoIndex` / `withBratRepos` not exported.

- [ ] **Step 3: Implement**

Add `Item.bratRepo?: string` to `registry.ts` with:

```ts
  // The BRAT repo this plugin was installed from ("owner/repo"), when BRAT manages it (spec §3.2).
  // Was a top-level `bratIndex` map — a SECOND list of plugin ids beside `items.community`, which
  // is one list too many: the two drift the moment a plugin is removed from one and not the other.
  // A property of a plugin lives on that plugin.
  bratRepo?: string;
```

Add `"bratRepo"` to `WRITTEN_ITEM_KEYS`. In `src/core/bratIndex.ts`, add the two projections beside `resolveBratIndex` (which keeps its `BratIndex` signature — it is the network-facing resolver and has no business knowing about items):

```ts
// The id -> repo view of the items map, for the resolver and for `betaIds`.
export function bratRepoIndex(items: ItemMap): BratIndex { … }

// The inverse write: every id in `index` gets its repo, every community item whose repo left the
// index loses the field. An id with no item yet gets a `{synced: false}` skeleton — recording where
// a plugin came from is not a decision to start syncing it.
export function withBratRepos(items: ItemMap, index: BratIndex): ItemMap { … }
```

In `main.ts`: delete the `bratIndex` settings field and its default; replace every `this.settings.bratIndex` read with `bratRepoIndex(this.settings.items)` and every write with `this.settings.items = withBratRepos(this.settings.items, resolved)`.

- [ ] **Step 4: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "refactor(schema): a plugin's BRAT repo lives on the plugin"
```

---

### Task 7: The runtime cutover

The biggest task. `main.ts` stops reading `runsOn`/`thisDeviceItems` and starts reading Tasks 1–3; the three UI entrances move to the new host methods in the same commit, because the old ones are deleted here.

**Files:**
- Modify: `src/main.ts` (delete `thisDeviceIdsIn`, `memberDecisionsFor`, `memberLocalIdsFor`, `setLocalMember`, `setMemberLocal`, `clearMemberDevice`, `addSwitchExceptions`, `setMemberDevice`, `clearMemberLocal`, `runsOnFor`, `storedRunsOn`, `setRunsOn`, `storedRunsOnFor`, `runsOnForces`, `enablementSharingFor`, `structuralLocalElementsFor`, `memberClassesFor`; add the six new host methods and the decision seam)
- Modify: `src/ui/SyncCenterView.ts` (host interface; `renderRunsOnRow` → `renderDefaultEnabledOnRow`; `computeFateInput`)
- Modify: `src/ui/SettingTab.ts` (host interface; `renderEnabledOnZone` → `renderDefaultEnabledOnRow`; `isThisDevice` deletion)
- Modify: `src/ui/fateModel.ts` (`FateInput.runsOn` → `ruleSharing` + `localException`)
- Create: `src/ui/enablementRow.ts`
- Modify: `src/core/availability.ts` (delete `forcedRunsOn`, `preferStoredRunsOn`)
- Modify: `src/ui/panelModel.ts` (delete `MemberDecision`, `memberDecisionsFromSharing`)
- Test: `tests/enablementRow.test.ts` (new), `tests/enablementRuntime.test.ts` (new), `tests/fateModel.test.ts`, `tests/panelModel.test.ts`, `tests/availability.test.ts`

**Interfaces:**
- Consumes: `enablementRuleFor` / `withEnablementRule` / `ruledElementIds` (T1), `parseDeviceElements` / `deviceElementState` / `withDeviceElement` / `deviceElementIds` / `DEVICE_ELEMENTS_KEY` (T2), `decideEnablement` (T3).
- Produces, on BOTH `SyncCenterHost` and `SettingsHost` (one method set, two interfaces that declare it):

```ts
  // The fleet rule for one element of one list — read and write, the only pair (spec §6.6).
  enablementRuleFor(list: RuleListId, elementId: string): Sharing;
  setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void>;
  // This device's own exception for that element: null = follows the rule.
  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null;
  // Take the element out of the shared answer, keeping EXACTLY what it is right now (spec §6.5) —
  // the initial value is read from the persisted list file, never from a live plugin query.
  leaveToThisDevice(list: RuleListId, elementId: string): Promise<void>;
  // Put it back under the shared answer.
  followTheDefault(list: RuleListId, elementId: string): Promise<void>;
  // Flip an existing exception.
  setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void>;
```

- Produces, in `src/ui/enablementRow.ts`:

```ts
export interface RowSegment { icon: string | null; label: string; }
export interface EnablementRowModel { fleet: RowSegment; local: RowSegment; localIsException: boolean; }
export function enablementRowModel(input: { rule: Sharing; exception: DeviceElementState | null }): EnablementRowModel;
export const RULE_OPTIONS: readonly Sharing[]; // EVERYWHERE, desktop, mobile, THIS_DEVICE
export function ruleLabel(s: Sharing): string;  // "All devices" | "Desktop only" | "Mobile only" | "Each device decides"
export function ruleIcon(s: Sharing): string;   // sharingIcon(), except this-device → "users"
export const FOLLOWS_LABEL: string;             // "Follows the default"
export const ON_HERE_LABEL: string;             // "On here"
export const OFF_HERE_LABEL: string;            // "Off here"
```

`EnablementList` (`"core-plugins" | "community-plugins"`) is a subset of `RuleListId`, so a Sync Center caller holding the narrower type passes straight through. Declare the host methods with `RuleListId` — the settings panel's snippet rows need the third value.

- [ ] **Step 1: Write the failing row-model test**

Create `tests/enablementRow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { enablementRowModel, ruleIcon, ruleLabel, RULE_OPTIONS } from "../src/ui/enablementRow";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

describe("the two-segment row", () => {
  it("names the four rule values exactly as the spec's copy table does", () => {
    expect(RULE_OPTIONS.map(ruleLabel)).toEqual(["All devices", "Desktop only", "Mobile only", "Each device decides"]);
  });

  it("gives each rule its own glyph, and never borrows a reserved one", () => {
    expect(RULE_OPTIONS.map(ruleIcon)).toEqual(["monitor-smartphone", "monitor", "smartphone", "users"]);
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("sliders-horizontal");
    expect(RULE_OPTIONS.map(ruleIcon)).not.toContain("airplay");
  });

  it("the follow state has no icon — the default has nothing to say", () => {
    const m = enablementRowModel({ rule: EVERYWHERE, exception: null });
    expect(m.local).toEqual({ icon: null, label: "Follows the default" });
    expect(m.localIsException).toBe(false);
  });

  it("an exception shows its own state, whatever the rule says (precedence 1 is visible)", () => {
    for (const rule of [EVERYWHERE, perClass("desktop"), THIS_DEVICE]) {
      expect(enablementRowModel({ rule, exception: "on" }).local).toEqual({ icon: "power", label: "On here" });
      expect(enablementRowModel({ rule, exception: "off" }).local).toEqual({ icon: "power-off", label: "Off here" });
      expect(enablementRowModel({ rule, exception: "on" }).localIsException).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/enablementRow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ui/enablementRow.ts`**

```ts
/**
 * The two-segment row's MODEL (spec §6.1): `label | fleet segment | divider | local segment`.
 *
 * Three surfaces render this row — a Sync Center row's `Default enabled on`, a plugin card's, and a
 * carrier card's element rows — and they must say the same thing, so what each segment SAYS is
 * decided once, here, and the renderers only paint it.
 *
 * The local segment renders no icon while it follows the default: a default has nothing to say, and
 * the glyph that used to stand for "this device" (`airplay`) reads as screen mirroring to everyone
 * who has not read this file.
 */
import { Sharing, EVERYWHERE, perClass, THIS_DEVICE } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { sharingIcon } from "./itemCard";

export const RULE_OPTIONS: readonly Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];

export function ruleLabel(s: Sharing): string {
  if (s.kind === "everywhere") return "All devices";
  if (s.kind === "this-device") return "Each device decides";
  return s.class === "desktop" ? "Desktop only" : "Mobile only";
}

// sharingIcon's vocabulary for the two class stops and the everywhere stop; `users` for
// each-device-decides — the value is about the fleet's PEOPLE-side arrangement ("each of you
// decides"), and `airplay` (sharingIcon's own this-device glyph) means screen mirroring to a reader
// who has not read the source.
export function ruleIcon(s: Sharing): string {
  return s.kind === "this-device" ? "users" : sharingIcon(s);
}

export interface RowSegment {
  icon: string | null;
  label: string;
}

export interface EnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

export const FOLLOWS_LABEL = "Follows the default";
export const ON_HERE_LABEL = "On here";
export const OFF_HERE_LABEL = "Off here";

export function enablementRowModel(input: { rule: Sharing; exception: DeviceElementState | null }): EnablementRowModel {
  const fleet: RowSegment = { icon: ruleIcon(input.rule), label: ruleLabel(input.rule) };
  if (input.exception === null) return { fleet, local: { icon: null, label: FOLLOWS_LABEL }, localIsException: false };
  const on = input.exception === "on";
  return { fleet, local: { icon: on ? "power" : "power-off", label: on ? ON_HERE_LABEL : OFF_HERE_LABEL }, localIsException: true };
}
```

- [ ] **Step 4: Rewire the mask in `src/main.ts`**

Replace `enablementSharingFor` / `memberClassesFor` / `memberLocalIdsFor` / `memberForceOffIds` / `runsOnForces` with one decision seam:

```ts
  // The device-element table, parsed at most once per load (same discipline as deviceOptOutsCache
  // — this is read per element per render).
  private deviceElementsCache: DeviceElements | null = null;

  private deviceElements(): DeviceElements {
    if (this.deviceElementsCache === null) this.deviceElementsCache = parseDeviceElements(this.app.loadLocalStorage(DEVICE_ELEMENTS_KEY));
    return this.deviceElementsCache;
  }

  private saveDeviceElements(next: DeviceElements): void {
    this.deviceElementsCache = next;
    this.app.saveLocalStorage(DEVICE_ELEMENTS_KEY, Object.keys(next).length === 0 ? null : JSON.stringify(next));
  }

  // Every element of a list that has anything to decide: a fleet rule, a local exception, or an
  // auto-derived exclusion the caller adds. One walk, one decision per element (enablementDecision.ts)
  // — the four readers that used to each derive their own slice of this are what let a local choice
  // survive in one of them and not another (C-#52).
  private enablementDecisions(list: EnablementList): Map<string, EnablementDecision> {
    const rules = enablementRules(this.settings.items, list);
    const table = this.deviceElements();
    const deviceClass: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    const out = new Map<string, EnablementDecision>();
    for (const id of new Set([...Object.keys(rules), ...deviceElementIds(table, list)])) {
      out.set(id, decideEnablement({ rule: rules[id] ?? EVERYWHERE, exception: deviceElementState(table, list, id), deviceClass }));
    }
    return out;
  }
```

`augmentedSwitchExceptions` keeps its shape; its per-list mask becomes:

```ts
      const decisions = this.enablementDecisions(name);
      const ruled = [...decisions].filter(([, d]) => d.masked).map(([id]) => id);
      const auto = name === "community-plugins" ? derived : new Set<string>();
      const mask = [...new Set([...ruled, ...auto])];
```

`coreContext` computes the decisions ONCE per run and projects all three fields off that one map — the three used to be three independent derivations, which is how they came to disagree:

```ts
    const decisions = new Map(ENABLEMENT_LISTS.map((list) => [list, this.enablementDecisions(list)] as const));
    const forced = (want: "on" | "off"): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      for (const [list, map] of decisions) {
        const ids = [...map].filter(([, d]) => d.force === want).map(([id]) => id);
        if (ids.length > 0) out[list] = ids;
      }
      return out;
    };
    return {
      …
      switchExceptions: await this.augmentedSwitchExceptions(rootPath, decisions),
      switchForceOff: forced("off"),
      switchForceOn: forced("on"),
      …
    };
```

`augmentedSwitchExceptions` takes the same map rather than recomputing it, and `coreContext` no longer calls `localSwitchListFor` at all — the persisted list is now read in exactly one place, `leaveToThisDevice` (step 5), where "keep what this device has right now" is the question being asked.

- [ ] **Step 5: Add the six host methods to `src/main.ts`**

```ts
  enablementRuleFor(list: RuleListId, elementId: string): Sharing {
    return enablementRuleFor(this.settings.items, list, elementId);
  }

  async setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b: refuse BEFORE mutating
    this.settings.items = withEnablementRule(this.settings.items, list, elementId, sharing);
    await this.saveSettings();
  }

  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null {
    return deviceElementState(this.deviceElements(), list, elementId);
  }

  // "Leave it to me" keeps EXACTLY what is on this device right now (spec §6.5). The state is read
  // from the PERSISTED list file — the same content applySwitchList's pass-through reads — never
  // from a live plugin query, which can diverge from disk (a non-persistent enablePlugin, which
  // config-sync's own apply cycle and the IOTO ecosystem both use).
  async leaveToThisDevice(list: RuleListId, elementId: string): Promise<void> {
    if (this.schemaStopped()) return;
    const persisted = await this.localSwitchListFor(list);
    this.writeDeviceElement(list, elementId, switchListMemberOn(persisted, elementId) ? "on" : "off");
    void this.refreshLocalStatus();
  }

  async followTheDefault(list: RuleListId, elementId: string): Promise<void> {
    if (this.schemaStopped()) return;
    this.writeDeviceElement(list, elementId, null);
    void this.refreshLocalStatus();
  }

  async setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void> {
    if (this.schemaStopped()) return;
    this.writeDeviceElement(list, elementId, state);
    void this.refreshLocalStatus();
  }

  // ONE writer for the exception table (spec §6.6) — the three methods above differ only in the
  // value they hand it.
  private writeDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState | null): void {
    this.saveDeviceElements(withDeviceElement(this.deviceElements(), list, elementId, state));
  }
```

Delete: `thisDeviceIdsIn`, `setLocalMember`, `setMemberLocal`, `clearMemberDevice`, `addSwitchExceptions`, `setMemberDevice`, `clearMemberLocal`, `runsOnFor`, `storedRunsOn`, `setRunsOn`, `storedRunsOnFor`, `memberDecisionsFor`, `memberLocalIdsFor`, `memberClassesFor`, `memberForceOffIds`, `enablementSharingFor`, `structuralLocalElementsFor`, `runsOnForces`, and the `switchMemberDecisions` / `addSwitchExceptions` / `setMemberDevice` / `clearMemberLocal` / `runsOnFor` / `setRunsOn` / `setMemberLocal` entries of the two host objects. Delete `setCustomItemDevice` only in Task 8.

- [ ] **Step 6: Rewire `fateModel.ts`**

```ts
  // Was `runsOn: RunsOn`. The fate of a row now reads the two layers the user actually set: the
  // shared rule, and this device's own exception. `null` exception = follows the rule.
  ruleSharing: Sharing;
  localException: "on" | "off" | null;
```

`effectiveTurnsOn`:

```ts
function effectiveTurnsOn(i: FateInput): boolean {
  if (!i.carrierSynced || i.storeListOn === null) return false;
  // A local exception decides outright — same precedence the run itself uses
  // (enablementDecision.ts), so the sentence can never promise what the run will not do.
  if (i.localException !== null) return i.localException === "on" && !i.locallyOn;
  if (i.ruleSharing.kind === "this-device") return false;
  if (i.ruleSharing.kind === "per-class" && i.ruleSharing.class !== i.deviceClass) return false;
  return i.storeListOn && !i.locallyOn;
}
```

`buildChips`: `i.runsOn.force?.state === "off"` → `i.localException === "off"`, `=== "on"` → `i.localException === "on"`; the chip strings stay `off here — your rule` / `on here — your rule`; the `stays off` guard becomes `i.localException !== "on"`.

`computeFateInput` (`SyncCenterView.ts:919-931`) reads the new host methods:

```ts
    let ruleSharing: Sharing = EVERYWHERE;
    let localException: "on" | "off" | null = null;
    if (carrierSynced) {
      …
      ruleSharing = this.host.enablementRuleFor(carrier, element);
      localException = this.host.deviceElementFor(carrier, element);
    }
```

- [ ] **Step 7: The Sync Center's `Default enabled on` row**

Replace `renderRunsOnRow` (`SyncCenterView.ts:2845-2863`) with a two-segment row. Add the shared renderer beside `renderCardIconMenuRow`:

```ts
  // The two-segment row (spec §6.1): fleet answer on the left of the divider, this device's own
  // exception on the right. Both segments open a menu; the local one renders wordmark-only while it
  // follows, because a default has nothing to say.
  private renderTwoSegmentRow(
    detail: HTMLElement,
    label: string,
    fleet: { seg: RowSegment; isSet: boolean; menu: () => Menu },
    local: { seg: RowSegment; isException: boolean; menu: () => Menu } | null
  ): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const row = value.createDiv({ cls: "config-sync-tworow" });
      const paint = (host: HTMLElement, seg: RowSegment, cls: string, menu: () => Menu): void => {
        const el = host.createSpan({ cls, attr: { "aria-label": seg.label } });
        if (seg.icon !== null) setIcon(el.createSpan({ cls: "config-sync-tworow-ic" }), seg.icon);
        el.createSpan({ text: seg.label });
        this.wireMenuTrigger(el, menu);
      };
      paint(row, fleet.seg, `config-sync-tworow-seg${fleet.isSet ? " is-set" : ""}`, fleet.menu);
      if (local === null) return;
      row.createSpan({ cls: "config-sync-tworow-vline" });
      paint(row, local.seg, `config-sync-tworow-seg is-local${local.isException ? " is-set" : ""}`, local.menu);
    });
  }
```

and:

```ts
  // Default enabled on (spec §6.2) — only for a plugin row whose carrier is synced: with no shared
  // list there is no default to state.
  private renderDefaultEnabledOnRow(detail: HTMLElement, name: string, input: FateInput): void {
    const list = enablementCarrierFor(this.rowRef(name));
    const elementId = this.carrierElementFor(name);
    const model = enablementRowModel({ rule: input.ruleSharing, exception: input.localException });
    this.renderTwoSegmentRow(
      detail,
      "Default enabled on",
      {
        seg: model.fleet,
        isSet: input.ruleSharing.kind !== "everywhere",
        menu: () => this.ruleMenu(list, elementId, input.ruleSharing),
      },
      { seg: model.local, isException: model.localIsException, menu: () => this.localMenu(list, elementId, input.localException) }
    );
  }

  private ruleMenu(list: EnablementList, elementId: string, current: Sharing): Menu {
    const menu = new Menu();
    for (const rule of RULE_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(ruleLabel(rule))
          .setIcon(ruleIcon(rule))
          .setChecked(sharingEquals(rule, current))
          .onClick(() => void this.host.setEnablementRule(list, elementId, rule).then(() => this.notifyExternalChange()))
      );
    }
    return menu;
  }

  private localMenu(list: EnablementList, elementId: string, current: "on" | "off" | null): Menu {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(FOLLOWS_LABEL).setChecked(current === null).onClick(() => void this.host.followTheDefault(list, elementId).then(() => this.reload())));
    menu.addItem((i) => i.setTitle(ON_HERE_LABEL).setIcon("power").setChecked(current === "on").onClick(() => void this.host.setDeviceElement(list, elementId, "on").then(() => this.reload())));
    menu.addItem((i) => i.setTitle(OFF_HERE_LABEL).setIcon("power-off").setChecked(current === "off").onClick(() => void this.host.setDeviceElement(list, elementId, "off").then(() => this.reload())));
    return menu;
  }
```

Call site (`SyncCenterView.ts:2624`): `if (input.carrierSynced) this.renderDefaultEnabledOnRow(fields, name, input);`

- [ ] **Step 8: The plugin card's `Default enabled on` row**

Replace `SettingTab.renderEnabledOnZone` (`SettingTab.ts:929-961`) — the four-stop cycle whose fourth stop wrote a different field from the other three — with the same two-segment row, in the card's existing `config-sync-grid` markup:

```ts
  // Zone ① `Default enabled on` (spec §6.5) — core/community/beta plugin cards only. Same name,
  // same values, same data as the Sync Center's row of that name: this used to be a 4-stop cycle
  // whose first three stops wrote `runsOn.device` and whose fourth wrote `thisDeviceItems`, i.e.
  // one control with two destinations. Now it is two controls, one per layer, each with one writer.
  private renderDefaultEnabledOnRow(exp: HTMLElement, def: ItemDef, wrap: HTMLElement): void {
    const list = def.enablement?.list;
    if (list === undefined) return;
    const elementId = def.enablement.element;
    const row = exp.createDiv({ cls: "config-sync-grid config-sync-card-fieldrow" });
    row.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: DEFAULT_ENABLED_ON_LABEL });
    const cell = row.createDiv({ cls: "config-sync-tworow" });
    const build = (): void => {
      cell.empty();
      const rule = this.host.enablementRuleFor(list, elementId);
      const exception = this.host.deviceElementFor(list, elementId);
      const model = enablementRowModel({ rule, exception });
      const after = (): void => {
        build();
        this.refreshCardBadges(wrap, def);
      };
      // Fleet segment: the cycle idiom the card already teaches (renderSharingCycle), over the four
      // rule values. A desktop-only plugin still drops the mobile stop — mobile can never install it.
      renderSharingCycle(cell.createDiv(), {
        sharing: rule,
        options: def.desktopOnly === true ? RULE_OPTIONS.filter((o) => o.kind !== "per-class" || o.class !== "mobile") : RULE_OPTIONS,
        disabled: false,
        onChange: (v) => void this.host.setEnablementRule(list, elementId, v).then(after),
      });
      cell.createSpan({ cls: "config-sync-tworow-vline" });
      // Local segment. A class rule that this device does not match has nothing true to show as a
      // local state, so it shows the default sentence — but the menu stays live, because an
      // exception outranks a class rule (spec §5 precedence 1) and a row that cannot be excepted
      // would be a dead end.
      const local = cell.createSpan({ cls: `config-sync-tworow-seg is-local${model.localIsException ? " is-set" : ""}`, attr: { role: "button", tabindex: "0", "aria-label": model.local.label } });
      if (model.local.icon !== null) setIcon(local.createSpan({ cls: "config-sync-tworow-ic" }), model.local.icon);
      local.createSpan({ text: model.local.label });
      const openLocalMenu = (x: number, y: number): void => {
        const menu = new Menu();
        // "Follows the default" is absent when there is no shared answer to follow (spec §6.5,
        // case 3): with `Each device decides`, every device's own state IS the answer.
        if (rule.kind !== "this-device") {
          menu.addItem((i) => i.setTitle(FOLLOWS_LABEL).setChecked(exception === null).onClick(() => void this.host.followTheDefault(list, elementId).then(after)));
        }
        menu.addItem((i) => i.setTitle(ON_HERE_LABEL).setIcon("power").setChecked(exception === "on").onClick(() => void this.host.setDeviceElement(list, elementId, "on").then(after)));
        menu.addItem((i) => i.setTitle(OFF_HERE_LABEL).setIcon("power-off").setChecked(exception === "off").onClick(() => void this.host.setDeviceElement(list, elementId, "off").then(after)));
        menu.showAtPosition({ x, y });
      };
      local.addEventListener("click", (e) => { e.stopPropagation(); openLocalMenu(e.clientX, e.clientY); });
      local.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        const r = local.getBoundingClientRect();
        openLocalMenu(r.left, r.bottom);
      });
    };
    build();
    row.createDiv(); // state column — empty
    row.createDiv(); // action column — empty
  }
```

Case 3 (`Each device decides` with no exception yet) shows `Follows the default` until the user picks a side; the first pick writes an explicit `on`/`off`. Where a card wants the state pre-seeded instead — the mockup's case 3 shows the live state — call `host.leaveToThisDevice(list, elementId)` when the fleet segment lands on `Each device decides` and no exception exists yet, so the displayed state is the plugin's real one and "switching to an exception keeps the status quo" (spec §6.5) holds by construction.

In `itemCard.ts`, replace `ENABLED_ON_LABEL`/`ENABLED_ON_HINT` with `export const DEFAULT_ENABLED_ON_LABEL = "Default enabled on";` (the hint is gone — each segment carries its own aria-label).

Delete `SettingTab.isThisDevice` and `settings.thisDeviceItems` from the `SettingsHost` interface; `computeBadges`' third parameter (`isThisDevice`) goes with it — a plugin card's badge for the local layer is now derived from `deviceElementFor`.

- [ ] **Step 9: Delete the now-unreferenced pure helpers**

`availability.ts`: delete `forcedRunsOn`, `preferStoredRunsOn` (and their tests in `tests/availability.test.ts`).
`panelModel.ts`: delete `MemberDecision`, `memberDecisionsFromSharing` (and their tests).
`itemCard.ts`: delete `RUNS_ON_OPTIONS`, `runsOnIcon`, `runsOnLabel`, `runsOnIsDefault`.

- [ ] **Step 10: Write the runtime test**

Create `tests/enablementRuntime.test.ts` using the `deviceOptOut.test.ts` harness (real `ConfigSyncPlugin`, in-memory localStorage, `MemFS`). Cover:

```ts
it("an Off here survives a pull that rewrites data.json (C-#52 regression)", async () => { … });
it("a local exception outranks a class rule set afterwards", async () => { … });
it("Each device decides masks without forcing — the local file is left exactly as it was", async () => { … });
it("leaveToThisDevice seeds the exception from the persisted list, not from a live plugin query", async () => { … });
```

The first two are spec §9 criteria 3 and 4 and must assert on `coreContext()`'s `switchExceptions`/`switchForceOn`/`switchForceOff`, not on a UI value.

- [ ] **Step 11: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "feat: the mask reads one rule layer and one local layer"
```

---

### Task 8: Delete the retired fields

Nothing reads them after Task 7. This task removes them so no future reader can start.

**Files:** `src/core/types.ts`, `src/core/registry.ts`, `src/core/catalog.ts`, `src/main.ts`, `src/ui/SyncCenterView.ts`, `src/ui/SettingTab.ts`, `tests/*`

- [ ] **Step 1: Delete the type and its helpers**

`src/core/types.ts`: delete `RunsOn`, `runsOnEquals`, `asRunsOn` (lines 109-138).

- [ ] **Step 2: Delete the item fields**

`src/core/registry.ts`: delete `Item.runsOn`, `Item.elements`, `withRunsOnDevice`, `itemWithDevice`, `deviceSharing`, `ElementSharing`, `elementSharings`, `enablementSharing`, `structuralLocalElements`. Remove `"runsOn"` and `"elements"` from `WRITTEN_ITEM_KEYS`. `itemEarnsDef` simplifies to:

```ts
// An entry's PRESENCE is load-bearing — see the note above; `{synced:false}` is what an absent
// entry is not. With `runsOn` retired there is no rule-only shape left to exclude: a rule now lives
// on the CARRIER, not on the plugin, so an entry here always means someone chose something about
// this item.
export function itemEarnsDef(item: Item): boolean {
  return true;
}
```

…and, being a constant, is deleted outright along with its call sites in `defsForForeignItems` (keep the `known.has(id)` guard).

- [ ] **Step 3: Move a custom item's device class onto its file rule**

`customGroup`:

```ts
  // A custom item's device class is its file-level sharing — the same field, the same menu and the
  // same writer as every registry item's `Settings sync` (spec plan note 1). It used to be
  // `runsOn.device`, a second expression of one idea, which is what this release exists to end.
  // manifest.ts refuses a `fileRule` on a folder group (whole-file encryption is a single-file
  // notion), so a folder's sharing is ELEVATED into `devices` and not emitted as a rule.
  const sharing = item.settingsFile?.fileRule?.sharing ?? EVERYWHERE;
  const group: SyncGroup = { ...carried, name, ref: itemRef("custom", name), path, type: item.type ?? "folder", devices: sharingClassOrAll(sharing) };
  …
  if (mode === "plain" && item.settingsFile?.fileRule !== undefined && group.type === "file") group.fileRule = item.settingsFile.fileRule;
```

`customItemFromGroup`: replace `if (g.devices !== "all") item.runsOn = { device: g.devices };` with a `fileRule` write through the same shape (`{ sharing: perClass(g.devices), encrypted: g.fileRule?.encrypted ?? false }`), skipped for `devices === "all"`.

`main.ts`: delete `setCustomItemDevice`; `SyncCenterView.renderSettingsSyncRow`'s custom branch calls `setItemFileSharing` like every other row. Delete `setCustomItemDevice` from the host interface.

- [ ] **Step 4: Delete `thisDeviceItems`**

`main.ts`: delete the settings field and its default. `catalog.ts`: delete the `thisDeviceItems` locked preset rule from `selfPresetRules()` — and update the comment: the two remaining presets are the transport wiring, and the third was a local-semantics field that no longer exists.

**Careful:** removing a locked preset changes what `adoptConfiguration` imports. `thisDeviceItems` will not exist in a v4 document, so nothing is newly imported; but a v3 document adopted from a device that has not updated is refused by the version gate before it reaches here. Assert this in a test rather than reasoning about it: `tests/catalog.test.ts` should assert `selfPresetRules().map(r => r.pattern)` equals `["rootPath", "remotes"]`.

- [ ] **Step 5: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "refactor(schema): retire runsOn, elements and thisDeviceItems"
```

---

### Task 9: The v3 → v4 migration

**Files:**
- Create: `src/core/v4Migration.ts`
- Modify: `src/core/settingsMigration.ts` (`CURRENT_SCHEMA` 3 → 4; classifier comment)
- Modify: `src/main.ts` (`ConfigSyncSettings.schemaVersion: 4`; `loadSettings` chains v2 → v3 → v4; the localStorage freeze half)
- Test: `tests/v4Migration.test.ts`, additions to `tests/schemaGate.test.ts` / `tests/versionGates.test.ts`

**Interfaces:**
- Consumes: `ruleHomeFor`/`perElementKeyFor` (T1), `withDeviceElement` (T2).
- Produces:

```ts
export interface V4Migration {
  document: Doc;
  // The elements whose LOCAL half the shell must freeze: the ids that were pinned to this device in
  // v3, per list. The shell reads each list file and records the element's real current state.
  freeze: { list: "core-plugins" | "community-plugins"; elementId: string }[];
}
export function migrateV4Settings(doc: Doc): V4Migration;
```

- [ ] **Step 1: Write the failing test**

Create `tests/v4Migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { migrateV4Settings } from "../src/core/v4Migration";
import { perElementKeyFor } from "../src/core/switchList";
import { perClass, THIS_DEVICE } from "../src/core/types";

const KEY = perElementKeyFor("community-plugins");

describe("v3 → v4", () => {
  it("renames enabled to synced and leaves the value alone", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { enabled: true } } } });
    expect(document.items).toMatchObject({ community: { dataview: { synced: true } } });
    expect(JSON.stringify(document)).not.toContain('"enabled"');
    expect(document.schemaVersion).toBe(4);
  });

  it("a device rule moves onto the carrier, under the reserved key", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { "obsidian-git": { enabled: true, runsOn: { device: "desktop" } } } } });
    expect(document.items).toMatchObject({
      obsidian: { "community-plugins": { settingsFile: { perElement: { [KEY]: { "obsidian-git": perClass("desktop") } } } } },
      community: { "obsidian-git": { synced: true } },
    });
    expect(JSON.stringify(document)).not.toContain("runsOn");
  });

  it("device: all writes no rule at all — a stored default is still a default", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { core: { "daily-notes": { enabled: true, runsOn: { device: "all" } } } } });
    expect((document.items as never as Record<string, Record<string, unknown>>).obsidian?.["core-plugins"]).toBeUndefined();
  });

  it("a force rule is dropped, not migrated — it claimed 'here' and meant 'everywhere'", () => {
    const { document } = migrateV4Settings({
      schemaVersion: 3,
      items: { core: { graph: { enabled: true, runsOn: { device: "all", force: { state: "on", where: "everywhere" } } } } },
    });
    expect(JSON.stringify(document)).not.toContain("force");
  });

  it("thisDeviceItems migrates in two halves: the rule fleet-side, the freeze list local-side", () => {
    const { document, freeze } = migrateV4Settings({
      schemaVersion: 3,
      thisDeviceItems: ["community/remotely-save", "core/graph", "custom/whatever"],
      items: { community: { "remotely-save": { enabled: true } }, core: { graph: { enabled: true } } },
    });
    expect(document.items).toMatchObject({
      obsidian: {
        "community-plugins": { settingsFile: { perElement: { [KEY]: { "remotely-save": THIS_DEVICE } } } },
        "core-plugins": { settingsFile: { perElement: { [perElementKeyFor("core-plugins")]: { graph: THIS_DEVICE } } } },
      },
    });
    expect(document.thisDeviceItems).toBeUndefined();
    // A custom item is not an on/off-list element — it has no rule to write and nothing to freeze.
    expect(freeze).toEqual([
      { list: "community-plugins", elementId: "remotely-save" },
      { list: "core-plugins", elementId: "graph" },
    ]);
  });

  it("each carrier is synced exactly when its section had a synced item (or the field is left alone if already set)", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, items: { community: { dataview: { enabled: true } }, core: { graph: { enabled: false } } } });
    const obsidian = (document.items as Record<string, Record<string, { synced?: boolean }>>).obsidian;
    expect(obsidian["community-plugins"]?.synced).toBe(true);
    expect(obsidian["core-plugins"]?.synced).toBe(false);
  });

  it("bratIndex folds onto the plugins, creating an unsynced skeleton for an id with no entry", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, bratIndex: { "some-beta": "owner/repo" }, items: {} });
    expect(document.items).toMatchObject({ community: { "some-beta": { synced: false, bratRepo: "owner/repo" } } });
    expect(document.bratIndex).toBeUndefined();
  });

  it("carries every key it does not recognise, at every level (invariant II.1)", () => {
    const { document } = migrateV4Settings({ schemaVersion: 3, futureTopLevel: 1, items: { community: { dataview: { enabled: true, futureItemKey: "x" } } } });
    expect(document.futureTopLevel).toBe(1);
    expect(document.items).toMatchObject({ community: { dataview: { futureItemKey: "x" } } });
  });

  it("returns a non-v3 document untouched — the classifier decides when this runs, not this function", () => {
    const doc = { schemaVersion: 4, items: {} };
    expect(migrateV4Settings(doc).document).toEqual(doc);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/v4Migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/v4Migration.ts`**

Model it on `v2Migration.ts` exactly: plain `Record<string, unknown>` throughout, every level rebuilt by SPREADING what was found, no compile-time type trusted about another build's document. The skeleton and the six rules:

```ts
/**
 * The v3 → v4 settings migration (spec 2026-08-12-enablement-two-layers-design.md §4).
 *
 * The ONE piece of code that will ever read a v3 `data.json` again. Pure: the shell decides when it
 * runs, saves the result exactly once, and owns the localStorage half (main.ts's
 * freezeThisDeviceElements).
 *
 * The rule that shapes it, inherited from v2Migration.ts: a document was written by ANOTHER build,
 * so its compile-time types are claims, not facts. Every level is a plain object of `unknown`,
 * rebuilt by spreading what was found — which is what carries a key this build has never heard of
 * (invariant II.1) — and a value whose shape we cannot read is left exactly as found.
 *
 * `thisDeviceItems` migrates in TWO halves and the second one is not optional (§4). A v3 pin did not
 * merely mask its element, it FORCED it (the retired forcedRunsOn, resolved against the persisted
 * list). The rule below preserves WHO decides; the `freeze` list the shell consumes preserves WHAT
 * was decided. Only both together leave every switch where it was.
 */
type Doc = Record<string, unknown>;

export interface V4Migration {
  document: Doc;
  freeze: { list: EnablementList; elementId: string }[];
}

export function migrateV4Settings(input: Doc): V4Migration {
  if (input.schemaVersion !== 3) return { document: input, freeze: [] };

  const doc: Doc = { ...input, schemaVersion: 4 };
  const items = cloneItems(doc.items);          // two levels deep, spread-copied
  const freeze: V4Migration["freeze"] = [];

  // Rule 2/3 — per item: `enabled` → `synced`, the device axis leaves, `force`/`elements` are
  // dropped, every other key rides through.
  for (const [section, byId] of Object.entries(items)) {
    for (const [id, raw] of Object.entries(byId)) {
      const item: Doc = { ...(raw as Doc) };
      if ("enabled" in item) {
        item.synced = item.enabled === true;
        delete item.enabled;
      }
      const device = deviceAxisOf(item.runsOn);   // "desktop" | "mobile" | null; ignores force
      delete item.runsOn;
      delete item.elements;                        // declared in v3, never written — nothing to carry
      if (device !== null) {
        if (section === "custom") setCustomDeviceSharing(item, device); // plan note 1
        else if (section === "core" || section === "community") writeRule(items, listFor(section), id, perClass(device));
      }
      byId[id] = item;
    }
  }

  // Rule 4 — the pins, both halves.
  for (const ref of stringList(doc.thisDeviceItems)) {
    const parsed = parseItemRef(ref);
    // A `custom`/`obsidian` pin never had a masking effect (only on/off-list elements do), and an
    // unparseable string never named anything. Dropped, not carried into a shape that would.
    if (parsed === null || (parsed.section !== "core" && parsed.section !== "community")) continue;
    const list = listFor(parsed.section);
    writeRule(items, list, parsed.id, THIS_DEVICE);
    freeze.push({ list, elementId: parsed.id });
  }
  delete doc.thisDeviceItems;

  // Rule 5 — BRAT repos onto the plugins they describe.
  for (const [id, repo] of Object.entries(stringMap(doc.bratIndex))) {
    const community = (items.community ??= {});
    community[id] = { synced: false, ...((community[id] as Doc) ?? {}), bratRepo: repo };
  }
  delete doc.bratIndex;

  // Rule 6 — the carriers' own `synced`. Today a carrier compiles iff any item in its section is
  // synced (the retired anyEnabledInList); from v4 it compiles iff its own item says so. Without
  // this line, every user's on/off sync would silently stop on the first v4 load. An existing value
  // wins: a hand-edited or newer document already said what it wanted.
  for (const section of ["core", "community"] as const) {
    const list = listFor(section);
    const carrier: Doc = { ...((items.obsidian?.[list] as Doc) ?? {}) };
    if (!("synced" in carrier)) carrier.synced = Object.values(items[section] ?? {}).some((i) => (i as Doc).synced === true);
    (items.obsidian ??= {})[list] = carrier;
  }

  doc.items = items;
  return { document: doc, freeze };
}

// The rule write, through the SAME producer the runtime reads with (enablementRules.ts's
// ruleHomeFor) — never a "" literal and never a second spelling of where a rule lives.
function writeRule(items: Record<string, Record<string, unknown>>, list: EnablementList, elementId: string, sharing: Sharing): void {
  const home = ruleHomeFor(list);
  const carrier: Doc = { ...((items[home.section]?.[home.id] as Doc) ?? {}) };
  const sf: Doc = { mode: "plain", rules: {}, ...((carrier.settingsFile as Doc) ?? {}) };
  const perElement: Doc = { ...((sf.perElement as Doc) ?? {}) };
  perElement[home.key] = { ...((perElement[home.key] as Doc) ?? {}), [elementId]: sharing };
  sf.perElement = perElement;
  carrier.settingsFile = sf;
  (items[home.section] ??= {})[home.id] = carrier;
}

// `device: "all"` writes NOTHING (spec §4): the default is what an absent rule already means, and
// storing it would be residue the first round trip has to clean up. `force` is read and discarded —
// it claimed "here" and behaved "everywhere", and all three vaults have zero of them.
function deviceAxisOf(runsOn: unknown): "desktop" | "mobile" | null {
  if (typeof runsOn !== "object" || runsOn === null) return null;
  const device = (runsOn as { device?: unknown }).device;
  return device === "desktop" || device === "mobile" ? device : null;
}

function listFor(section: "core" | "community"): EnablementList {
  return section === "core" ? "core-plugins" : "community-plugins";
}
```

`setCustomDeviceSharing(item, device)` writes `settingsFile.fileRule = { sharing: perClass(device), encrypted: <existing ?? false> }` and sets `settingsFile.mode = "plain"`, preserving any other settingsFile content.

- [ ] **Step 4: Wire it into `loadSettings`**

`settingsMigration.ts`: `CURRENT_SCHEMA = 4`. `classifySettings` needs a third accepted version: v3 is now migratable too. Extend the classifier rather than adding a parallel one:

```ts
// The versions this build can bring forward, oldest first. v2 chains through v3 on its way here —
// migrateV2Settings produces a v3 document, which migrateV4Settings then takes the rest of the way,
// so a 2.20.0 device that skipped every release in between still lands on v4 in one load.
export const MIGRATABLE_SCHEMAS: readonly number[] = [2, 3];
```

`classifySettings` answers `{ kind: "migrate", from: 2 | 3 }`. `loadSettings`:

```ts
    if (load.kind === "migrate") {
      const v3 = load.from === 2 ? migrateV2Settings(data ?? {}) : { document: data ?? {}, carriedDeviceOptOuts: undefined };
      const v4 = migrateV4Settings(v3.document);
      this.settings = withDefaults(DEFAULT_SETTINGS, v4.document);
      // localStorage FIRST, the document second — the same ordering rule the v2 migration follows,
      // and for the same reason: a crash between the two writes must leave a state the next load
      // recovers from. Here that state is "still a v3 document, some exceptions already frozen",
      // which migrates again cleanly because the freeze is idempotent (it writes the element's
      // CURRENT state, and the run that wrote it did not change that state).
      this.absorbCarriedDeviceOptOuts(v3.carriedDeviceOptOuts);
      await this.freezeThisDeviceElements(v4.freeze);
      await this.saveData(this.settings);
      return;
    }
```

and:

```ts
  // The LOCAL half of `thisDeviceItems`' migration (spec §4). The fleet half (a `this-device` rule)
  // preserves who decides; this half preserves WHAT was decided. Both are needed because a v3
  // this-device pin did not merely mask its element — it FORCED it (availability.ts's now-retired
  // forcedRunsOn, against the persisted list). Writing the rule alone would turn a force into a
  // pass-through, and the first apply after the migration could then move a switch the user had
  // pinned. With the freeze, the three list files are byte-identical before and after.
  private async freezeThisDeviceElements(freeze: { list: EnablementList; elementId: string }[]): Promise<void> {
    if (freeze.length === 0) return;
    let table = this.deviceElements();
    for (const { list, elementId } of freeze) {
      if (deviceElementState(table, list, elementId) !== null) continue; // already frozen — idempotent
      const persisted = await this.readListFileDirect(list);
      table = withDeviceElement(table, list, elementId, switchListMemberOn(persisted, elementId) ? "on" : "off");
    }
    this.saveDeviceElements(table);
  }

  // The list file read the migration needs, BEFORE anything is compiled: `localSwitchListFor` goes
  // through `compiledGroups`, which does not exist yet at load time. The path comes from the same
  // table (`SWITCH_LISTS`) the compiler would have used.
  private async readListFileDirect(list: EnablementList): Promise<SwitchList | null> { … }
```

- [ ] **Step 5: The acceptance test — byte-identical list files**

Add to `tests/enablementRuntime.test.ts`:

```ts
it("migration leaves the three on/off list files byte-identical (spec §9 criterion 1)", async () => {
  // Seed a v3 document with a this-device pin, a desktop rule and a plain synced plugin, plus real
  // list files; snapshot the three files, run loadSettings + one full capture/apply cycle, and
  // compare the bytes.
});

it("a v4 document has no runsOn, elements, thisDeviceItems, bratIndex or item-level enabled (criterion 2)", async () => {
  const saved = JSON.stringify(savedDocument);
  for (const dead of ["runsOn", "elements", "thisDeviceItems", "bratIndex"]) expect(saved).not.toContain(dead);
  expect(saved).not.toMatch(/"enabled":/);
});
```

- [ ] **Step 6: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "feat(schema): v4 — migrate the enablement layers without moving a single switch"
```

---

### Task 10: Sync Center — the row contract

**Files:** `src/ui/SyncCenterView.ts`, `styles.css`, `tests/` (view-level assertions where the existing suite has them)

- [ ] **Step 1: `Default settings sync` gains its local segment**

`renderSettingsSyncRow` becomes a `renderTwoSegmentRow` call: the fleet segment is today's `FILE_SHARING_OPTIONS` menu (unchanged writer, `setItemFileSharing`); the local segment is `Follows the default` / `Not synced here`, reading `host.deviceOptedOut(name)` and writing `host.setDeviceOptOut(name, on)` — the second item of the footer menu, moved. Its icon when set is `circle-slash`. Label: `Default settings sync`.

The `FILE_SHARING_MENU_UNAVAILABLE_TEXT` branch keeps its behaviour: no fleet menu, but the local segment still renders — a per-key item can still be opted out here.

- [ ] **Step 2: `More` becomes an icon row**

```ts
  private renderMoreRow(detail: HTMLElement, name: string): void {
    const isFolder = this.itemSectionOf(name) === "custom";
    const tooltip = isFolder ? "Folder rules — opens Settings" : "Per-key rules, locks & folders — opens Settings";
    // `settings-2`, never `sliders-horizontal`: that glyph is already `your rule` in the fate chips
    // (fateChipIcons.ts), and one glyph with two meanings is how an icon language stops teaching
    // anything. `settings-2` already means "opens Settings" in three places in this file.
    this.renderCardIconMenuRow(detail, "More", "settings-2", false, tooltip, …);
  }
```

`renderCardIconMenuRow` wires a menu; `More` needs a plain click. Add a sibling `renderCardIconActionRow(detail, label, icon, ariaLabel, onActivate)` rather than passing a fake menu — the two gestures are different and the row should not lie about which it is.

- [ ] **Step 3: Delete the footer**

Delete `renderStopSyncing`, `buildStopSyncingMenu`, `canStopSyncing` and the call site at `SyncCenterView.ts:2546-2548`. Keep `StopSyncingModal` and `openStopSyncing` — the settings-panel card is what opens it now (Task 12). If `openStopSyncing` has no caller left after Task 12, it goes too; check at the end of Task 12, not here.

Also delete the `.config-sync-stopsync-foot` / `.config-sync-stopsync` / `.config-sync-stopsync-ic` rules from `styles.css`.

- [ ] **Step 4: Row order**

`renderUnifiedCard`'s field order becomes: `State`/`On apply`/`On capture` → `Files` → `Resolve` (conflict only) → `Default enabled on` → `Default settings sync` → `More` → `Note` (hotkeys). The `After install` / `Enablement` fallback rows keep their existing ladder position (before `Default settings sync`), unchanged.

- [ ] **Step 5: Styles**

Add to `styles.css`:

```css
/* The two-segment row (spec §6.1): four fixed tracks so every row in a card lines its icons and
   its state words up on the same two vertical rules. */
.config-sync-tworow { display: grid; grid-template-columns: minmax(0, 182px) 1px 1fr; align-items: center; gap: 0 14px; }
.config-sync-tworow-vline { width: 1px; align-self: stretch; background: var(--background-modifier-border); }
.config-sync-tworow-seg { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-muted); }
.config-sync-tworow-seg.is-set { color: var(--text-normal); }
.config-sync-tworow-seg.is-local.is-set { color: var(--color-purple); }
.config-sync-tworow-ic { display: inline-flex; }
```

- [ ] **Step 6: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "feat(sync center): one row, two layers — and no destructive footer"
```

---

### Task 11: Sync Center — the carrier chip becomes a shortcut

**Files:** `src/ui/SyncCenterView.ts` (`renderCarrierChip`, 2297-2346), `styles.css`

- [ ] **Step 1: Rewrite the chip**

```ts
  // The Core/Community section header chip (spec §6.3). It used to WRITE `Item.synced`; it now only
  // SHOWS it and jumps to where that value is configured. One datum, one writer — and the writer is
  // the card's own toggle in the settings panel, beside the confirmation the change deserves.
  //
  // Same shape on both platforms. The mobile branch this replaces rendered a bare toggle glyph with
  // the copy in a tooltip — on the one platform that has no hover to show it. A short word costs one
  // line of nothing and reads everywhere.
  private renderCarrierChip(head: HTMLElement, carrierId: EnablementList): void {
    const synced = this.groups.some((g) => g.name === carrierId);
    const tooltip = synced
      ? "Which plugins are on is shared with your other devices — opens Settings"
      : "Which plugins are on stays on this device — opens Settings";
    const chip = head.createSpan({ cls: `config-sync-carrierchip${synced ? " is-synced" : ""}`, attr: { role: "button", tabindex: "0", "aria-label": tooltip } });
    setIcon(chip.createSpan({ cls: "config-sync-carrierchip-ic" }), "settings-2");
    chip.createSpan({ text: synced ? "synced" : "not synced" });
    setTooltip(chip, tooltip);
    const open = (): void => {
      const ref = this.host.itemRefForGroup(carrierId);
      if (ref !== null) this.host.openSettingsAt(ref);
    };
    chip.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    chip.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); e.stopPropagation(); open(); });
  }
```

`itemRefForGroup("core-plugins")` now answers a real ref (Task 5 made the carrier an item with a `settingsFile`), so the jump lands on the card.

Note the chip must still render when the carrier is NOT synced: with no compiled group, `openSettingsAt` needs the ref anyway — `itemForGroupName` finds it from the DEF, not from the compiled list, so this works either way. Assert it in a test.

- [ ] **Step 2: Delete the mobile branch's styles**

Remove `.config-sync-carrierchip.is-icon` from `styles.css`; add the icon gap rule.

- [ ] **Step 3: Prove there is no write path (spec §9 criterion 5/6)**

Add to the view test suite:

```ts
it("Item.synced has exactly one writer, and it is not in the Sync Center", () => {
  const view = readFileSync("src/ui/SyncCenterView.ts", "utf8");
  expect(view).not.toContain("setItemSyncEnabled");
});
```

Then delete `setItemSyncEnabled` from `SyncCenterHost` in `SyncCenterView.ts` (keep the method on the plugin — the settings card calls it).

- [ ] **Step 4: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "feat(sync center): the list chip shows and jumps, it no longer decides"
```

---

### Task 12: Settings panel — five Obsidian cards

**Files:** `src/ui/SettingTab.ts`, `src/ui/itemCard.ts`, `tests/itemCard.test.ts`

- [ ] **Step 1: One renderer for every element rule row**

Extract the row body of `renderSnippetMembers` (`SettingTab.ts:1820-1861`) into

```ts
  // ONE element-rule row (spec §6.4): a snippet under Appearance and a plugin under Core/Community
  // plugins are the same thing — an element of an on/off list with a rule and a local exception —
  // so they are the same row. Appearance's snippet rows are the older half of this; this is what
  // makes the two new carrier cards reuse them instead of growing a second dialect.
  private renderElementRuleRow(host: HTMLElement, opts: { list: RuleListId; elementId: string; label: string; orphan: boolean; onWritten: () => void }): void
```

which renders the two-segment row (`enablementRowModel`) with the fleet menu writing `host.setEnablementRule` and the local menu writing `followTheDefault` / `setDeviceElement`. The snippet-specific `Forget` affordance and the `file deleted` pill stay in the snippets caller, passed in via `orphan`.

Delete `withSnippetSharing` from `itemCard.ts` — `withEnablementRule` is its generalization, and having both is two writers for one datum.

- [ ] **Step 2: The two carrier cards' drawers**

`renderCardExpansion` gains a branch for `def.id === "core-plugins" | "community-plugins"`:

```
  Settings file zone (unchanged — path row, preview)
  ── Which devices turn each plugin on ──
  <element rule row per element>
```

The element list is the union of installed defs for that list and every element that already has a rule or a local exception, sorted by display label. Community's list is long (73 on the author's vault); spec §10 leaves search/grouping open — do NOT add a search box in this task.

- [ ] **Step 3: Card badges**

`computeBadges` loses its `isThisDevice` parameter (Task 7) and gains the two carrier badge classes:

```ts
  // Two facts, two colors (spec §6.4): what the fleet agreed (`N device-scoped`) and what this
  // device kept for itself (`N left to me`). Mixing them into one count is what made the old
  // "N device-scoped" badge unreadable on a device that had its own exceptions.
```

Counts come from `ruledElementIds(items, list).filter(class rules)` and `deviceElementIds(table, list)`.

- [ ] **Step 4: The card head keeps the only `Item.synced` writer**

Unchanged (`SettingTab.ts:860-866`) — verify it is still the only call site of `setItemSyncEnabled`/`{...c, synced: v}` in the repo, and that `StopSyncingModal` is reachable from the card (spec §6.2). If it is not, wire the card's toggle-to-off path through it; if `openStopSyncing` ends up with no caller, delete it.

- [ ] **Step 5: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "feat(settings): the two plugin lists get the card they always were"
```

---

### Task 13: Icon registry cleanup + documentation currency

**Files:** `src/ui/fateChipIcons.ts`, `tests/fateChipIcons.test.ts`, `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md`, `docs/GUIDE.md`, `README.md`, `README.zh.md`

- [ ] **Step 1: One glyph, one meaning**

```ts
  // `power` now means "this device turned it on" (a local exception, spec §7). A chip that means
  // "the shared list has it off" cannot share that glyph — `power-off` is what it was always
  // describing.
  "stays off": "power-off",
```

Add a test that asserts no glyph appears twice with two unrelated meanings across `FATE_CHIP_ICON`, `ACTION_ICON`, `FOLD_ICON` and `ruleIcon`'s outputs — a registry-level guard, since this is the third time a glyph collision has been caught by hand.

- [ ] **Step 2: Documentation**

Per the repo's docs-currency rule, update in this same branch:

- `docs/ARCHITECTURE.md` — the data model section: the 2×2 table, the two new core modules, the retired fields, `schemaVersion: 4`.
- `docs/design/DESIGN.md` — the icon/copy registry (spec §7) and the two-segment row.
- `docs/GUIDE.md` — the user-facing story: what `Each device decides` means, where `Leave it to me` lives now, why the Sync Center footer is gone.
- `README.md` + `README.zh.md` — any sentence that names `Runs on`, `Enabled on`, or the Stop-syncing footer. Screenshots that show the old rows are stale: list them in the commit message; retaking them is a separate, manual step for the user.

Use `~`/`<placeholder>` forms in every path or identifier written into these files.

- [ ] **Step 3: Verify + commit**

```bash
npm test && npm run build && npm run lint
git add -A
git commit -m "docs: the two-layer enablement model, and one glyph per meaning"
```

---

## Acceptance (spec §9 — verify all eight before calling the branch done)

| # | Criterion | Where it is proven |
|---|---|---|
| 1 | The three list files are byte-identical across the migration | `tests/enablementRuntime.test.ts` (Task 9 step 5) |
| 2 | No `runsOn` / `elements` / `thisDeviceItems` / `bratIndex` / item-level `enabled` in a v4 document | same suite |
| 3 | An `Off here` survives a pull (C-#52 regression) | `tests/enablementRuntime.test.ts` (Task 7 step 10) |
| 4 | A local exception outranks a class rule | same suite |
| 5 | The list chip has no write path | Task 11 step 3 |
| 6 | `setItemSyncEnabled` is called only from the settings-panel card | Task 11 step 3 + Task 12 step 4 |
| 7 | by-construction protects minting, not matching — every comparison point re-checked | Task 1's `perElementKeyFor` tests + a grep for `""` used as a perElement key |
| 8 | Tests are producer-vs-producer | Task 1 steps 1/3; no test in this plan asserts a `""` literal |

**Live verification (manual, after the branch is green — the user runs this):** deploy to `kickstart.vault` and `llm-wiki.vault` first, never `main.vault`; check a v3 → v4 load on a real vault with real pins, then one capture and one apply on two devices.
