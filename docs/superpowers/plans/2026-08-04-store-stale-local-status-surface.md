# Surface a stale device-local key in the store as "to capture" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the status comparison report a group whose store base still carries a top-level `scope:"local"` key as `local-changed` (a capture direction), so the Sync Center offers it for capture and 2.14.1's purge guard finally runs — cleaning an existing leak that otherwise reads as in-sync forever.

**Architecture:** Detect the stale-local condition inside `status.ts`'s file comparison using the exact `baseHasStaleLocalKeys` predicate the capture guard already uses (exported from `ConfigSyncCore.ts`), and intercept it in `groupStatus` to return `local-changed` instead of `in-sync`. The predicate that lights the row up is identical to the predicate the capture purges by, so the row is self-clearing: capture → base purged → next scan → in-sync.

**Tech Stack:** TypeScript, Vitest, esbuild. Obsidian plugin.

## Global Constraints

- **Version:** 2.14.2, bare tag (`.npmrc` `tag-version-prefix=""`). Set at cut, not in this plan.
- **minAppVersion floor:** unchanged from 2.14.1; the `version` npm script writes the versions.json floor automatically at cut.
- **NO-COMMITS during implementation:** leave every change uncommitted (the user's review state). A single commit is made at cut by the controller. No Claude/AI attribution in any commit, tag, release, or PR text.
- **Scope:** top-level `scope:"local"` keys in a **file**-mode group's store base only (mirrors `baseHasStaleLocalKeys`). Dir-mode groups always report `staleLocal: false`. Per-item local elements are a separate family, out of scope.
- **Invariant:** the status light-up predicate and the capture-guard purge predicate are the SAME `baseHasStaleLocalKeys`. Never light up a case a capture would not clean.

---

### Task 1: Report a stale-local store base as `local-changed`

**Files:**
- Modify: `src/core/ConfigSyncCore.ts:287` (export `baseHasStaleLocalKeys`)
- Modify: `src/core/status.ts:20` (Comparison type), `:78-107` (`compareFile`), `:144` (`compareDir` return), `:51-76` (`groupStatus`)
- Test: `tests/status.test.ts` (append tests)

**Interfaces:**
- Consumes: `baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean` — already implemented in `ConfigSyncCore.ts`; this task exports it.
- Produces: `Comparison` object variant gains `staleLocal: boolean`. `groupStatus` returns `state: "local-changed"` when `staleLocal` is true.
- Existing routing this relies on (already true, asserted by a test step, not changed): `directionForState("local-changed") === "capture"`, `stageableState("local-changed") === true`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/status.test.ts` (inside the `describe("statusForGroups", …)` block, or a new sibling `describe`). The existing `plugin-demo` group already has `fields: [{ pattern: "*Token*", scope: "local", encrypted: false }]`, so its captured base is stripped of `vikaToken`.

```ts
import { directionForState, stageableRow } from "../src/ui/panelModel";

describe("stale device-local key in the store base", () => {
  const DEMO_BASE = "cs/store/configdir/plugins/demo/data.json";

  it("surfaces a group whose store base still carries a scope:local key as local-changed", async () => {
    const { io, ctx } = await seededAndCaptured();
    // Capture stripped vikaToken from the base ({theme:"x"}); simulate a base written before the
    // local rule existed by putting the local-scoped key back into the store base.
    await io.write(DEMO_BASE, '{"vikaToken":"stale","theme":"x"}');
    // Empty ledger: proves the interception fires regardless of baseline (would otherwise be
    // never-synced/in-sync via the three-way path).
    expect((await allStates(ctx))["plugin-demo"]).toBe("local-changed");
  });

  it("a group with a scope:local field but a clean base stays in-sync (no phantom)", async () => {
    const { ctx } = await seededAndCaptured();
    expect((await allStates(ctx))["plugin-demo"]).toBe("in-sync");
  });

  it("capturing the surfaced group purges the base and it returns to in-sync (self-clearing)", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(DEMO_BASE, '{"vikaToken":"stale","theme":"x"}');
    expect((await allStates(ctx))["plugin-demo"]).toBe("local-changed");
    await capture(ctx); // 2.14.1's baseHasStaleLocalKeys guard purges the stale key
    expect(JSON.parse(await io.read(DEMO_BASE))).toEqual({ theme: "x" });
    expect((await allStates(ctx))["plugin-demo"]).toBe("in-sync");
  });

  it("local-changed routes to a capturable row (the direction the fix depends on)", () => {
    expect(directionForState("local-changed")).toBe("capture");
    expect(stageableRow("local-changed", "main")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/status.test.ts`
Expected: the first and third new tests FAIL — `plugin-demo` reports `"in-sync"` (contentUnchanged strips the local key, so the stale base reads as unchanged) instead of `"local-changed"`. The second and fourth pass already.

- [ ] **Step 3: Export the guard**

In `src/core/ConfigSyncCore.ts`, change the declaration at line 287 from:

```ts
function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
```

to:

```ts
export function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
```

- [ ] **Step 4: Extend the Comparison type**

In `src/core/status.ts`, add `baseHasStaleLocalKeys` to the existing import from `"./ConfigSyncCore"` (line 1), and change the `Comparison` type (line 20) to:

```ts
type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; localHash: string; storeHash: string; staleLocal: boolean };
```

- [ ] **Step 5: Compute `staleLocal` in `compareFile`**

In `compareFile` (`src/core/status.ts`), the early "real absent" return (line 86) becomes:

```ts
    return { changes: { added: [], updated: [], deleted: [name] }, localHash: ABSENT_HASH, storeHash, staleLocal: false };
```

Replace the final `changes`/`return` (lines 105-106) with:

```ts
  const staleLocal = equal && baseHasStaleLocalKeys(effGroup, storeContent);
  const changes: FileChanges = equal
    ? staleLocal
      ? { added: [], updated: [name], deleted: [] } // surface the store's stray local key as to-capture
      : { added: [], updated: [], deleted: [] }
    : { added: [], updated: [name], deleted: [] };
  return { changes, localHash, storeHash, staleLocal };
```

- [ ] **Step 6: Set `staleLocal: false` in `compareDir`**

In `compareDir` (`src/core/status.ts:144`), change the return to:

```ts
  return { changes, localHash: await hashDirSide(liveEntries), storeHash: await hashDirSide(storeEntries), staleLocal: false };
```

- [ ] **Step 7: Intercept in `groupStatus`**

In `groupStatus` (`src/core/status.ts`), immediately after the `not-captured` guard (line 63) and before the `if (!hasChanges(cmp.changes))` block (line 64), insert:

```ts
  if (cmp.staleLocal) {
    // The store base holds a top-level scope:"local" key it must never carry (2.14.1's
    // baseHasStaleLocalKeys). The group is otherwise in-sync — contentUnchanged strips the key on
    // both sides — so it would read in-sync forever, the UI would never offer it for capture, and
    // the capture-time purge guard would never run. Surface it as local-changed (a capture
    // direction) so a capture is offered; that capture purges the base, and the next scan finds it
    // clean and returns to in-sync. No baseline reseed — this is a dirty state, not a synced one.
    return { status: { group: group.name, state: "local-changed", changes: cmp.changes } };
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/status.test.ts`
Expected: all four new tests PASS; the existing `statusForGroups` tests still PASS (in particular "reports in-sync right after capture" — a clean captured base has no stray local key, so `staleLocal` is false).

- [ ] **Step 9: Run the full suite and type/lint checks**

Run: `npx vitest run` then `npm run build` (which runs `tsc -noEmit` + esbuild) then `npm run lint`.
Expected: whole suite green; type check clean (the new `staleLocal` field is exhaustively provided at every Comparison object return — `compareFile` two returns, `compareDir` one return); lint at or under the established baseline (0 errors).

## Self-Review

- **Spec coverage:** Behavior (stale-local → local-changed) → Steps 5+7. Same-predicate invariant → Step 3 (export) + Step 5 (`baseHasStaleLocalKeys` used for both light-up here and purge in capture). Self-clearing → Step 1 test 3. No phantom → Step 1 test 2. Mapping the fix depends on → Step 1 test 4. Self-group edge → covered structurally: `staleLocal` is content-driven, and a clean base (empirically true for self today) yields `staleLocal: false`; the no-phantom test guards it. Dir-mode out of scope → Step 6 (`staleLocal: false`).
- **Placeholder scan:** none.
- **Type consistency:** `Comparison` object variant gains `staleLocal: boolean`; all three object-returning sites (compareFile ×2, compareDir ×1) set it; `groupStatus` reads `cmp.staleLocal` only after the two string-variant guards (`no-settings`, `not-captured`), where `cmp` is narrowed to the object variant. `baseHasStaleLocalKeys` signature matches its call site (`effGroup`, `storeContent`).

## Execution Handoff

After saving, offer: (1) Subagent-Driven or (2) Inline execution. Given the prior tasks in this thread ran inline, inline is the likely choice, but confirm with the user.
