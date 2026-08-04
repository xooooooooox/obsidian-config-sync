# Per-device scope local-containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep device-local facts out of the shared store so a "this device" choice neither leaks to downstream vaults nor is erased by a pull.

**Architecture:** Two independent fixes over the existing store/self-item machinery. Fix A relocates the explicit "this device" membership choice from `ItemConfig.enabledOn === "local"` (which travels in the shared self item) into a new top-level device-local settings field `localMembers`, stripped from the self store copy like `remotes`. Fix B makes capture and comparison strip a group's `local` fields using the union of the local rule and the store contract's rule, so an un-adopted device cannot publish device-local values.

**Tech Stack:** TypeScript, Obsidian plugin, Vitest. Bare version tags. Pure core modules under `src/core`, UI under `src/ui`, plugin shell `src/main.ts`.

## Global Constraints

- NO-COMMITS: implementers do not commit; the working tree is the review state; one commit at cut by the controller.
- No Claude/AI attribution in any commit, PR, or issue text.
- Bare version tags (`.npmrc` `tag-version-prefix=""`); release title is the bare `x.y.z`; hand-written release notes at cut; publishing the draft is the user's manual step.
- Every task ends green: `npm run build` clean, full Vitest suite passing, lint at baseline (0 errors).
- `enabledOn` must never again store `"local"`; after Fix A it holds only `"desktop"`/`"mobile"` (`"all"` = unset).
- The disabled-card structural `"local"` in `enablementScopes` (`cfg.enabled === false`) stays derived — only the explicit-choice `enabledOn === "local"` relocates.
- No user-visible UI change is intended (menu/chip stay visually and textually identical). Any surfaced copy/layout/affordance change stops for a mockup 定稿 first.

---

### Task 1: Introduce the `localMembers` device-local container

Add the field and make it strip/preserve like `remotes`. Nothing reads it yet — this task only proves the container is device-local.

**Files:**
- Modify: `src/main.ts` (`ConfigSyncSettings` ~82-102, `DEFAULT_SETTINGS` ~111-128)
- Modify: `src/core/catalog.ts` (`selfPresetRules` 341-346; keep `mergePresetFields` 353-358 consistent)
- Modify: `src/core/registry.ts` (`withSelfPresets` 245-251 — mirror the preset list)
- Test: `tests/modes.test.ts`, `tests/migration.test.ts` (`:59` self-preset assertion), `tests/registry.test.ts`

**Interfaces:**
- Produces: `ConfigSyncSettings.localMembers: string[]` (item ids in `community:<id>`/`core:<id>` form); `selfPresetRules()` includes `{ pattern: "localMembers", scope: "local", encrypted: false, locked: true }`.

- [ ] **Step 1: Write the failing test** — the self item strips `localMembers` on capture and restores it on apply.

```ts
// tests/modes.test.ts — in the fields round-trip describe
it("self item strips localMembers on capture and restores it on apply", async () => {
  const group = withSelfPresets({ name: SELF_GROUP_NAME, path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" });
  const local = JSON.stringify({ schemaVersion: 2, remotes: [], items: {}, localMembers: ["community:remotely-save"] });
  const stored = await captureTransform(group, local, null, "desktop", null);
  expect(JSON.parse(stored.content).localMembers).toBeUndefined();
  const applied = await applyTransform(group, stored.content, local, null, "desktop", null);
  expect(JSON.parse(applied.content).localMembers).toEqual(["community:remotely-save"]);
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/modes.test.ts` → fails (rule absent, `localMembers` survives capture). Adjust the test's `captureTransform`/`applyTransform` call shape to the file's actual signatures before asserting failure is for the right reason.

- [ ] **Step 3: Add the field + default** in `src/main.ts` — declare `localMembers: string[]` on `ConfigSyncSettings`, default `[]` in `DEFAULT_SETTINGS`.

- [ ] **Step 4: Add the preset rule** in `src/core/catalog.ts` `selfPresetRules()`:

```ts
return [
  { pattern: "rootPath", scope: "local", encrypted: false, locked: true },
  { pattern: "remotes", scope: "local", encrypted: false, locked: true },
  { pattern: "localMembers", scope: "local", encrypted: false, locked: true },
];
```

Verify `mergePresetFields` (`catalog.ts:353`) and `withSelfPresets` (`registry.ts:245`) pick it up (they build from `selfPresetRules()`), so no separate edit unless a list is duplicated literally.

- [ ] **Step 5: Update the self-preset assertion** in `tests/migration.test.ts:59` (and any test asserting the exact `selfPresetRules()` contents) to include the new rule.

- [ ] **Step 6: Run build + full suite** — `npm run build && npx vitest run` → green.

---

### Task 2: Switch the "this device" source of truth to `localMembers`

Retarget readers and writers together so behavior never half-breaks: the explicit choice writes `localMembers`, readers derive from it, and a stored `enabledOn === "local"` is ignored.

**Files:**
- Modify: `src/core/registry.ts` (`enablementScopes` 310-329 — ignore stored `"local"`)
- Modify: `src/main.ts` (`memberLocalIdsFor` 1115-1119; `addSwitchExceptions` 620-634; an un-pin helper)
- Modify: `src/ui/SettingTab.ts` (`renderEnabledOnZone` 756-783 — "This device" writes/clears `localMembers`)
- Modify: `src/ui/SyncCenterView.ts` (where-it-runs "Everywhere"/other options clear the id from `localMembers`, ~1843-1878)
- Test: `tests/registry.test.ts` (`:232`), `tests/core.test.ts` (switch-list exceptions `:1487`), `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `ConfigSyncSettings.localMembers` (Task 1).
- Produces: `memberLocalIdsFor(group)` sources this-device ids from `localMembers` (carrier-prefix mapped) ∪ disabled-card locals; `enablementScopes` treats a stored `enabledOn === "local"` as `"all"`.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/registry.test.ts — enablementScopes describe
it("ignores a stored enabledOn 'local' but still forces 'local' for a disabled card", () => {
  const settings = compileSettingsWith({
    "community:a": { enabled: true, enabledOn: "local", companions: [] },   // explicit choice — now ignored
    "community:b": { enabled: false, companions: [] },                      // disabled card — stays local
  });
  const scopes = enablementScopes(defs, settings, "community-plugins.json");
  expect(scopes["a"]).toBe("all");
  expect(scopes["b"]).toBe("local");
});
```

```ts
// tests/core.test.ts — switch-list exceptions: the write lands in localMembers, not enabledOn
it("choosing 'this device' records the member in localMembers and masks it", async () => {
  await plugin.addSwitchExceptions("community-plugins", ["remotely-save"]);
  expect(plugin.settings.localMembers).toContain("community:remotely-save");
  expect(plugin.settings.items["community:remotely-save"]?.enabledOn).toBeUndefined();
  // still masked from capture/compare via augmentedSwitchExceptions
});
```

- [ ] **Step 2: Run them to confirm failure** — `npx vitest run tests/registry.test.ts tests/core.test.ts`. Adapt helper names (`compileSettingsWith`, `plugin` harness) to the files' existing patterns.

- [ ] **Step 3: `enablementScopes` ignores stored `"local"`** (`registry.ts:317` and `:326`): compute the scope so `cfg.enabled ? (cfg.enabledOn === "local" ? "all" : (cfg.enabledOn ?? "all")) : "local"`. The disabled-card `: "local"` branch is unchanged.

- [ ] **Step 4: `memberLocalIdsFor`** (`main.ts:1115`) returns the group's element ids drawn from `settings.localMembers` (map `community:<id>`/`core:<id>` → element id by carrier prefix, as `registry.ts:323`) ∪ the disabled-card `"local"` ids `enablementScopes`/`memberDecisionsFor` still emit. Union, dedupe.

- [ ] **Step 5: `addSwitchExceptions`** (`main.ts:620-634`) adds ids to `settings.localMembers` (dedup) instead of writing `items[id].enabledOn = "local"`; keep the `saveSettings()` + `refreshLocalStatus()`.

- [ ] **Step 6: Writers/clearers in UI** — `renderEnabledOnZone` (`SettingTab.ts:773`): selecting "This device" adds the id to `localMembers` and leaves `enabledOn` unset; any other selection removes it from `localMembers`. The where-it-runs menu's non-local options (`SyncCenterView.ts` ~1843-1878) clear the id from `localMembers`. Add one small helper (e.g. `setMemberLocal(id, on)` on the plugin) so both call sites share it.

- [ ] **Step 7: Update existing tests that hand-build `enabledOn: "local"` and expect masking** to use `localMembers` (mechanical; the old contract no longer holds). Do not weaken assertions.

- [ ] **Step 8: Build + full suite** → green.

---

### Task 3: Migrate existing `enabledOn: "local"` into `localMembers`

Drain the old form on load (and after adopt) so upgrading users keep their choices and the old form stops being re-published.

**Files:**
- Modify: `src/core/settingsMigration.ts` (new exported migration, pattern of `mergeLegacyAppSliceItems` 35-69)
- Modify: `src/main.ts` (`loadSettings` ~1499 wiring; the `reloadSettings` self-apply path)
- Test: `tests/schemaGate.test.ts` (mirror the `mergeLegacyAppSliceItems` cases), `tests/mainReloadSettings.test.ts` (end-to-end wiring)

**Interfaces:**
- Consumes: `localMembers` (Task 1), readers on `localMembers` (Task 2).
- Produces: `drainEnabledOnLocal(settings): boolean` — true when it moved at least one id.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/schemaGate.test.ts
describe("drainEnabledOnLocal", () => {
  it("moves each enabledOn 'local' into localMembers and deletes the key", () => {
    const s = { localMembers: [], items: {
      "community:a": { enabled: true, enabledOn: "local", companions: [] },
      "community:b": { enabled: true, enabledOn: "desktop", companions: [] },
    } } as unknown as ConfigSyncSettings;
    expect(drainEnabledOnLocal(s)).toBe(true);
    expect(s.localMembers).toEqual(["community:a"]);
    expect(s.items["community:a"].enabledOn).toBeUndefined();
    expect(s.items["community:b"].enabledOn).toBe("desktop");
  });
  it("is a no-op (returns false) when nothing is enabledOn 'local'", () => {
    const s = { localMembers: ["community:a"], items: { "community:a": { enabled: true, companions: [] } } } as unknown as ConfigSyncSettings;
    expect(drainEnabledOnLocal(s)).toBe(false);
  });
  it("does not duplicate an id already in localMembers", () => {
    const s = { localMembers: ["community:a"], items: { "community:a": { enabled: true, enabledOn: "local", companions: [] } } } as unknown as ConfigSyncSettings;
    expect(drainEnabledOnLocal(s)).toBe(true);
    expect(s.localMembers).toEqual(["community:a"]);
  });
});
```

- [ ] **Step 2: Run to confirm failure** — `npx vitest run tests/schemaGate.test.ts`.

- [ ] **Step 3: Implement `drainEnabledOnLocal`** in `settingsMigration.ts`: iterate `settings.items`; for each entry with `enabledOn === "local"`, add its id to `settings.localMembers` if absent, then `delete entry.enabledOn`; return whether anything changed. Guard `settings.localMembers ??= []`.

- [ ] **Step 4: Wire on load** in `loadSettings` next to `main.ts:1499`: `if (drainEnabledOnLocal(this.settings)) await this.saveSettings();` after the existing `mergeLegacyAppSliceItems` line.

- [ ] **Step 5: Wire after adopt** — call the same drain in the `reloadSettings` path (self-apply), so a freshly adopted foreign `enabledOn:"local"` is drained rather than re-captured. Add an end-to-end assertion in `tests/mainReloadSettings.test.ts` mirroring the existing `mergeLegacyAppSliceItems` wiring test.

- [ ] **Step 6: Build + full suite** → green. Fix A is now complete end-to-end.

---

### Task 4: Store-contract-authoritative `local` strip (Fix B)

Strip a group's `local` fields using the local rule ∪ the store contract's rule, in the one effective-group computation both capture and comparison consume — so an un-adopted device cannot publish device-local values, and capture/compare stay consistent.

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`overlayGroup` 56-72 or the effective-group build feeding `captureGroup` `:353,359`; read the store self copy once per run — `storeListGroups` `:50`, self-copy path `:766`)
- Modify: `src/core/status.ts` (`compareFile` `:93` — the same effective group must carry the contract patterns)
- Modify: `src/core/modes.ts` if the seam needs a fields-mode promotion helper (cf. `stripPatterns` 78-81, plain branch 253-259)
- Test: `tests/modes.test.ts`, `tests/status.test.ts`, `tests/core.test.ts`

**Interfaces:**
- Consumes: `ctx.storeListGroups` (existing), the store self copy.
- Produces: an effective group whose `local` field set = local `local` patterns ∪ store-contract `local` patterns for the same name; plain-mode local groups are promoted to fields mode when the contract declares a `local` rule.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/modes.test.ts (or core.test.ts with a store fixture)
it("capture strips a field the store contract marks local even when the local rule does not (fields mode)", async () => {
  // store contract: group "app" fields-mode with userIgnoreFilters scope:"local"
  // local group "app": fields-mode WITHOUT that rule
  const stored = await captureGroupWithContract(localAppGroupNoRule, storeContractAppLocalRule, appJsonWithIgnoreFilters);
  expect(JSON.parse(stored).userIgnoreFilters).toBeUndefined();
});

it("capture strips a contract-local field even when the local group is plain mode", async () => {
  const stored = await captureGroupWithContract(localAppGroupPlain, storeContractAppLocalRule, appJsonWithIgnoreFilters);
  expect(JSON.parse(stored).userIgnoreFilters).toBeUndefined();
});

it("a contract-stripped, captured group compares in-sync (no phantom diff)", async () => {
  // after capture strips the contract-local field, status must strip both sides the same way
  const status = await compareWithContract(localAppGroupNoRule, storeContractAppLocalRule, appJsonWithIgnoreFilters);
  expect(status.state).toBe("in-sync");
});
```

- [ ] **Step 2: Run to confirm failure** — `npx vitest run tests/modes.test.ts tests/status.test.ts`. Adapt the fixtures/helpers (`captureGroupWithContract`, `compareWithContract`) to the repo's `CoreContext` test harness; if none exists, build a minimal `ctx` with `storeListGroups` returning the contract groups.

- [ ] **Step 3: Compute the store contract once per run** — read `${storeDir(ctx)}/configdir/plugins/config-sync/data.json` if present, pass through `ctx.storeListGroups`, index by group name. Absent store → empty map (today's behavior).

- [ ] **Step 4: Extend the effective-group build** so a group's `fields` gains the contract group's `local`-scoped patterns for the same name (deduped by pattern), promoting a `plain` local group to `fields` mode when the contract declares a `local` rule. Do this in the shared `overlayGroup`/effective-group path so **both** `captureGroup` (`ConfigSyncCore.ts:353,359`) and `compareFile` (`status.ts:93`) receive the same augmented group.

- [ ] **Step 5: Thread the contract map** into the effective-group call sites in `capture()` and `statusForGroups`/`compareFile` (compute once, pass down) so status does not re-read the self copy per group.

- [ ] **Step 6: Run build + full suite** → green. Confirm no pre-existing fields/status test regressed (the union only adds strips; a group with no contract-local field is unchanged).

---

## Self-review notes

- Spec coverage: Fix A → Tasks 1-3 (container, source-of-truth switch, migration); Fix B → Task 4. Non-goals (encrypted compare, index refactor, UI change) are excluded.
- Ordering keeps each boundary green: Task 1 adds an unused field; Task 2 switches readers+writers atomically (updating any old-contract tests); Task 3 drains legacy data after readers are on the new source; Task 4 is independent of A.
- Type consistency: `localMembers: string[]` (main.ts) ↔ `selfPresetRules` pattern `"localMembers"` (catalog.ts) ↔ `drainEnabledOnLocal` populates it ↔ `memberLocalIdsFor` reads it. `enabledOn` narrows to `"desktop"|"mobile"` in practice after Fix A.
- Fix B's union MUST feed both capture and compare (single effective group) — Task 4 Step 4 is explicit about this to avoid a capture/compare desync.
