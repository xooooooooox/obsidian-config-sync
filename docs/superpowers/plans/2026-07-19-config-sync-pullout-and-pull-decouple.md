# Config Sync Pull-out + Pull Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pull pure store-transport and pull config-sync's own layer out of the generic item list into a dedicated, bidirectional sidebar destination — without changing the data model.

**Architecture:** Two pure-core changes (Pull stops writing the sync list; leftover ignores store-list-defined files) plus a pure delta helper, all TDD'd against the in-memory FileIO; then a view layer that adds a `"self"` panel scope, a top-of-sidebar **Config Sync** entry, and a `renderConfigSyncMode` pane with five states, verified live in the dev vault (matching the repo's core-unit-tested / view-live-verified split).

**Tech Stack:** TypeScript, vitest, esbuild. Live checks via obsidian-cli against `dev/vault/`.

## Global Constraints

- **Data model unchanged**: single `data.json`, self-config model, self group `plugin-config-sync` (`SELF_GROUP_NAME`) forced to `mode:"fields"` with locked strips for `rootPath`/`remotes`/`switchExceptions`. Do not touch `catalog.ts` presets.
- **Adoption is all-or-nothing** (one **Adopt all**); the +/− delta is informational, no per-item selection.
- **Already implemented, do not re-add:** `applyItems` (`main.ts`) already reloads settings after a run touching `SELF_GROUP_NAME` (`if (results.some(r => r.group === SELF_GROUP_NAME && r.status !== "error")) await this.loadSettings()`). Adopt therefore already takes effect in memory via the normal apply path.
- **Adopt action** is the existing `adoptConfiguration` (`main.ts:466`): injects the self group if missing, `applyWithActions([{name: SELF_GROUP_NAME, action:"none"}])`, `loadSettings()`.
- Gates every task must keep green: `npm test`, `npx eslint .` at **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh`. All new CSS uses Obsidian theme variables + `body.is-mobile`/`body.is-phone` scoping.
- Never commit unless the executing user asks; no Claude/AI attribution in commit messages.
- Privacy: no real home paths / usernames / hostnames in artifacts.

---

## File Structure

- **Modify** `src/core/ConfigSyncCore.ts` — `applyImport` stops applying group definitions; file conflicts only.
- **Create** `src/core/syncListDelta.ts` — pure `syncListDelta(local, store)` → `{ added, removed }` (group names), used by the pane and tests.
- **Modify** `src/core/leftover.ts` — no signature change; the *caller* passes the union of local + store-self-copy groups. Add a pure `storeSelfCopyGroups(json)` parser here (or in `manifest.ts`) for testability.
- **Modify** `src/main.ts` — `listLeftoverStoreFiles` passes the union; add a `selfStatus()`/delta host method feeding the pane; auto-select the self scope on cold start.
- **Modify** `src/ui/panelModel.ts` (+ callers) — exclude `SELF_GROUP_NAME` from item-list scopes / counts.
- **Modify** `src/ui/SyncCenterView.ts` — add `{kind:"self"}` to `PanelScope`; sidebar **Config Sync** entry + badge; `renderConfigSyncMode`; cold-start auto-land; remove `renderBootstrapBanner`/`renderAdoptGuidance` floating banners (folded into the pane).
- **Modify** `styles.css` — sidebar entry + pane styles.

---

## Task 1: Pull becomes pure store transport

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`applyImport`)
- Test: `tests/core.test.ts` (or `tests/external.test.ts` where import/pull is tested)

**Interfaces:**
- Produces: `applyImport(ctx, pending, choices)` with unchanged signature, but it no longer mutates `settings.groups` and `choices` now correspond to **file** conflicts only.

- [ ] **Step 1: Write the failing test** — a pull plan carrying `addGroups` must not change `settings.groups`, while store files + lock are still written.

```ts
it("pull is pure store transport — it writes store files but never changes the local sync list", async () => {
  const { io, ctx } = setup();
  await seedGroups(ctx, MANIFEST);              // local has plugin-demo etc.
  const before = await readGroups(ctx);
  // a plan with a remote-only group (addGroups) + a remote-only store file (writeFiles)
  const pending = {
    plan: { auto: { addGroups: [{ name: "plugin-new", path: "{configDir}/plugins/new/data.json", type: "file", devices: "all" }],
                    writeFiles: [{ rel: "store/configdir/plugins/new/data.json", content: '{"a":1}', name: "plugin-new" }],
                    keptLocalGroups: [], keptLocalFiles: [], identical: [] },
            conflicts: [] },
    remoteGroups: [], remoteLockRaw: null,
  };
  await applyImport(ctx, pending as any, []);
  expect(await readGroups(ctx)).toEqual(before);                       // sync list untouched
  expect(await io.exists("cs/store/configdir/plugins/new/data.json")).toBe(true); // store file written
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run -t "pull is pure store transport"`
Expected: FAIL — `readGroups` after includes `plugin-new` (current code imports it).

- [ ] **Step 3: Implement** — in `applyImport`, delete the group-definition application. Remove:
  - `let groups = await readGroups(ctx); groups = [...groups, ...plan.auto.addGroups];`
  - the `for (…) { if (choices[i] !== "remote") continue; if (conflict.kind !== "definition") continue; groups = groups.map(…) }` block
  - the final `await writeGroups(ctx, groups);`

  Then make conflicts file-only so the `choices` contract stays consistent: at the top of `applyImport`, compute `const fileConflicts = plan.conflicts.filter((c) => c.kind === "file");` and use `fileConflicts` for the `choices.length` guard and the conflict-apply loop (definition conflicts are ignored — Pull no longer resolves the sync list).

- [ ] **Step 4: Update `pullFrom`** (`main.ts:534`) so the ConflictModal only opens for file conflicts:
  `const fileConflicts = pending.plan.conflicts.filter((c) => c.kind === "file");` gate the modal on `fileConflicts.length > 0` and pass choices sized to `fileConflicts`.

- [ ] **Step 5: Fix any existing tests** that asserted pull imports groups (search `applyImport`/`planImport` in `tests/`). Update them to the new contract (store files change, sync list does not).

- [ ] **Step 6: Run tests + gates**

Run: `npx vitest run` → all pass. `npx eslint .` → 0 errors / 67 warnings.

- [ ] **Step 7: Commit (only if the user asked)** — `git commit -m "core: Pull no longer imports the sync list (pure store transport)"`

---

## Task 2: Sync-list delta helper

**Files:**
- Create: `src/core/syncListDelta.ts`
- Test: `tests/syncListDelta.test.ts`

**Interfaces:**
- Produces: `export function syncListDelta(local: SyncGroup[], store: SyncGroup[]): { added: string[]; removed: string[] }` — `added` = names in `store` not in `local`; `removed` = names in `local` not in `store`. Sorted.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { syncListDelta } from "../src/core/syncListDelta";
const g = (name: string) => ({ name, path: `{configDir}/${name}.json`, type: "file" as const, devices: "all" as const });
describe("syncListDelta", () => {
  it("added = store-only, removed = local-only, by name, sorted", () => {
    const d = syncListDelta([g("a"), g("b")], [g("b"), g("z"), g("y")]);
    expect(d).toEqual({ added: ["y", "z"], removed: ["a"] });
  });
  it("empty when identical", () => {
    expect(syncListDelta([g("a")], [g("a")])).toEqual({ added: [], removed: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run syncListDelta` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { SyncGroup } from "./types";
export function syncListDelta(local: SyncGroup[], store: SyncGroup[]): { added: string[]; removed: string[] } {
  const l = new Set(local.map((g) => g.name));
  const s = new Set(store.map((g) => g.name));
  const added = store.filter((g) => !l.has(g.name)).map((g) => g.name).sort();
  const removed = local.filter((g) => !s.has(g.name)).map((g) => g.name).sort();
  return { added, removed };
}
```

- [ ] **Step 4: Run** — `npx vitest run syncListDelta` → PASS.

- [ ] **Step 5: Commit (if asked)** — `git commit -m "core: add syncListDelta helper"`

---

## Task 3: Leftover ignores store-list-defined files

**Files:**
- Create/Modify: `src/core/leftover.ts` — add `export function storeSelfCopyGroups(json: string): SyncGroup[]` (parse the store self-copy `data.json`, return its `groups`, `[]` on malformed).
- Modify: `src/main.ts` (`listLeftoverStoreFiles`) — pass the union.
- Test: `tests/leftover.test.ts`

**Interfaces:**
- Consumes: `leftoverStoreRels(rels, groups)` (unchanged).
- Produces: `storeSelfCopyGroups(json)`; caller passes `[...this.settings.groups, ...storeGroups]`.

- [ ] **Step 1: Write the failing test** for the union behavior + the parser.

```ts
it("store files defined by the store's own sync list are pending, not leftover", () => {
  const localGroups = [{ name: "plugin-a", path: "{configDir}/plugins/a/data.json", type: "file" as const, devices: "all" as const }];
  const storeGroups = [{ name: "plugin-z", path: "{configDir}/plugins/z/data.json", type: "file" as const, devices: "all" as const }];
  const rels = ["store/configdir/plugins/a/data.json", "store/configdir/plugins/z/data.json", "store/configdir/plugins/orphan/data.json"];
  const out = leftoverStoreRels(rels, [...localGroups, ...storeGroups]);
  expect(out.map((f) => f.name)).toEqual(["orphan"]);  // a=local, z=store-list, only orphan is leftover
});
it("storeSelfCopyGroups parses groups and tolerates malformed json", () => {
  expect(storeSelfCopyGroups('{"groups":[{"name":"x","path":"p","type":"file","devices":"all"}]}').map(g=>g.name)).toEqual(["x"]);
  expect(storeSelfCopyGroups("not json")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run -t "store files defined"` (and the parser test) → FAIL (`storeSelfCopyGroups` missing).

- [ ] **Step 3: Implement `storeSelfCopyGroups`** in `leftover.ts`:

```ts
import { SyncGroup } from "./types";
export function storeSelfCopyGroups(json: string): SyncGroup[] {
  try {
    const raw = JSON.parse(json) as { groups?: unknown };
    return Array.isArray(raw.groups) ? (raw.groups as SyncGroup[]) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Wire the union in `main.ts`** `listLeftoverStoreFiles` — before the loop, read the store self-copy and union:

```ts
const selfCopy = `${ctx.rootPath}/store/configdir/plugins/config-sync/data.json`;
const storeGroups = (await ctx.io.exists(selfCopy)) ? storeSelfCopyGroups(await ctx.io.read(selfCopy)) : [];
for (const lf of leftoverStoreRels(rels, [...this.settings.groups, ...storeGroups])) { … }
```
Add `storeSelfCopyGroups` to the `./core/leftover` import.

- [ ] **Step 5: Run tests + gates** → all pass, lint clean.

- [ ] **Step 6: Commit (if asked)** — `git commit -m "core: pulled-but-unadopted store files are pending, not leftover"`

---

## Task 4: Exclude the self item from the item list, scopes, and counts

**Files:**
- Modify: `src/ui/panelModel.ts` and/or `src/ui/SyncCenterView.ts` (`rows()`/`scopedRows()`/count builders)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Produces: item-list rows, scope badges, filter pills, and footer totals that never include `SELF_GROUP_NAME`.

- [ ] **Step 1: Write the failing test** — the row set excludes the self group.

```ts
// In panelModel.test.ts, using its existing row-building helper:
it("excludes the config-sync self group from item-list rows", () => {
  const rows = buildRows([statusFor("plugin-config-sync"), statusFor("plugin-demo")]); // helper per the file's pattern
  expect(rows.map((r) => r.group.name)).not.toContain("plugin-config-sync");
  expect(rows.map((r) => r.group.name)).toContain("plugin-demo");
});
```
(Match the file's actual helper names; if the exclusion lives in `SyncCenterView.rows()`, test the smallest pure function that filters — extract one if needed so it is unit-testable.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run panelModel` → FAIL.

- [ ] **Step 3: Implement** — filter `r.group.name === SELF_GROUP_NAME` out of the row source that feeds scopes/pills/footer (single choke point — `rows()` in `SyncCenterView.ts`, or the shared builder in `panelModel.ts`). Import `SELF_GROUP_NAME` from `../core/catalog`.

- [ ] **Step 4: Run tests + gates** → pass.

- [ ] **Step 5: Commit (if asked)** — `git commit -m "ui: keep the config-sync self item out of the item list/counts"`

---

## Task 5: The "self" panel scope, sidebar entry, and Config Sync pane

**Files:**
- Modify: `src/ui/SyncCenterView.ts`
- Verified: live in `dev/vault/` (view code, per repo convention)

**Interfaces:**
- Consumes: `syncListDelta` (Task 2), `adoptConfiguration`/`captureItems`/`selfStatus` host methods, `SELF_GROUP_NAME`.
- Produces: `PanelScope` variant `{ kind: "self" }`; `renderConfigSyncMode(main)`.

- [ ] **Step 1: Extend `PanelScope`** (line 156) with `| { kind: "self" }`. In `render()` (after the `history` branch, ~line 361), add:
  `if (this.panelScope.kind === "self") { this.renderConfigSyncMode(main); return; }`

- [ ] **Step 2: Add the sidebar entry** in `renderSidebar` (and `renderSwitcher` for compact) — a **⚙ Config Sync** row at the **top**, above the `THIS DEVICE ↔ STORE` group, with a state badge computed from the self item's status: `↓N` (self item to-apply, N = delta.added+removed), `↑N` (to-capture), `⚠` (differs both), `✓`/hidden (in sync), `setup` (`groups.length===0`). Clicking sets `this.panelScope = { kind: "self" }` and re-renders.

- [ ] **Step 3: Implement `renderConfigSyncMode(main)`** — compute direction from the self item's `GroupStatus` (via a host `selfStatus()` returning `{ state: "adopt"|"capture"|"both"|"insync"|"coldstart"; delta: {added,removed} }`, backed by `statusForGroups` on `SELF_GROUP_NAME` + `syncListDelta(local, storeSelfCopyGroups)`). Render per state:
  - **coldstart** (`groups.length===0`): "Found a configuration in the store — N items. Adopt to set up this device." + the existing "don't Capture first" caution + **Adopt configuration** → `host.adoptConfiguration()`.
  - **adopt** (S2): "Updates from the store" + delta chips (info) + **Adopt all** → `host.adoptConfiguration()`; note "adds to the list; you still apply per item."
  - **capture** (S3): "Local changes not yet in the store" + delta + **Capture** → `host.captureItems([{name: SELF_GROUP_NAME, action:"none"}])` (or the existing capture entry point for a single item).
  - **both** (S4): "Adopt first, then capture." Adopt block enabled; Capture **disabled** until adopt completes.
  - **insync** (S0): "N items, in sync" + a device-config summary (store folder = `settings.rootPath` resolved, tracked count, PKM mode) + **Open Config Sync settings →** (`this.app.setting.open()` + select the tab, matching how the codebase opens settings elsewhere).

- [ ] **Step 4: Cold-start auto-land** — where the view currently decides the initial scope / shows the bootstrap banner, instead: if `host.bootstrapOffer()` is non-null, set `this.panelScope = { kind: "self" }` on first render so a fresh device opens on this pane.

- [ ] **Step 5: Remove the floating banners** — delete `renderBootstrapBanner` and `renderAdoptGuidance` calls (lines ~815-816) and the methods; their content now lives in the pane (coldstart / post-adopt). Keep `sessionRun` only if still needed for the result strip.

- [ ] **Step 6: Add the host `selfStatus()` method** in `main.ts` — reads the self item's status + `syncListDelta(this.settings.groups, storeSelfCopyGroups(selfCopy))` and returns the `{state, delta}` shape from Step 3. Add to the `SyncCenterHost` interface.

- [ ] **Step 7: Live-verify in dev vault** (`dev/vault/`, obsidian-cli routes by CWD):
  - Sidebar shows **⚙ Config Sync** at top with a badge; clicking opens the pane.
  - Forge a store-list change (edit the store self-copy groups) → pane shows **S2** with the delta; **Adopt all** → items appear in scopes, `loadSettings` took effect (badge → ✓).
  - Forge a local list add → **S3** → **Capture**.
  - Both pending → **S4**, Capture disabled until adopt.
  - Fresh device (0 groups) → panel opens on this pane (**coldstart**).
  - Item list no longer contains a "Config Sync" row.
  - Pull only refreshes the store — it no longer flips the pane's state on its own.

- [ ] **Step 8: Commit (if asked)** — `git commit -m "ui: pull Config Sync into a dedicated sidebar destination with a bidirectional adopt/capture pane"`

---

## Task 6: Styles for the sidebar entry and the pane

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add rules** for the sidebar entry (gear + name + badge; badge states via `--interactive-accent` / `--color-orange` / `--color-green`) and the pane (title + state pill, delta rows with `+`/`−` in `--color-green`/`--color-red`, action blocks, the disabled Capture in S4). All colors from theme variables; `body.is-mobile` touch sizing where rows are tappable.

- [ ] **Step 2: Verify** — `./scripts/check-no-hardcoded-color.sh` → OK; two-theme (default + one community theme) glance in the dev vault, light and dark.

- [ ] **Step 3: Commit (if asked)** — `git commit -m "ui: styles for the Config Sync sidebar entry and pane"`

---

## Task 7: Final verification

- [ ] **Step 1: Gates** — `npm test` (all pass), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK), `npm run build` (tsc + esbuild clean).
- [ ] **Step 2: Full live walkthrough** — deploy build to `dev/vault`, reload, and run the original repro end-to-end: a device with a store + a remote → the Adopt lives in the sidebar pane and is **not** wiped by Pull; Pull only refreshes the store; adopt/capture/both states all behave; the item list has no Config Sync row.
- [ ] **Step 3: Report** — summarize; leave uncommitted for review unless the user asked to commit.

---

## Self-Review

**1. Spec coverage:**
- D1 Pull pure transport → Task 1. ✓
- D2 config-sync pulled into sidebar destination → Task 4 (exclude from list) + Task 5 (entry + pane) + Task 6 (styles). ✓
- D3 all-or-nothing adopt (informational delta) → Task 5 Step 3 (single Adopt all; `syncListDelta` from Task 2 is display-only). ✓
- D4 bidirectional pane + adopt-first guard → Task 5 Step 3 (S2/S3/S4, Capture disabled in S4). ✓
- D5 leftover fix → Task 3; apply-self reload → already implemented (Global Constraints), covered by verification in Task 5 Step 7. ✓
- State machine S0–S4 → Task 5 Step 3. ✓
- Non-goals (no data-model change, no per-item adopt, Approach C rejected) → respected; no task touches `catalog.ts` presets or the store artifact layout. ✓

**2. Placeholder scan:** No TBD/TODO. The only "match the file's actual helper" note (Task 4 Step 1) is a deliberate instruction to align with `panelModel.test.ts`'s existing pattern, with a concrete fallback (extract a pure filter), not a gap.

**3. Type consistency:** `syncListDelta(local, store) → {added, removed}` used identically in Tasks 2 and 5/6-host. `storeSelfCopyGroups(json) → SyncGroup[]` used in Tasks 3 and 5-host. `PanelScope` `{kind:"self"}` and `renderConfigSyncMode` consistent across Task 5. `SELF_GROUP_NAME` imported from `../core/catalog` in Tasks 3/4/5. `adoptConfiguration` reused unchanged.
