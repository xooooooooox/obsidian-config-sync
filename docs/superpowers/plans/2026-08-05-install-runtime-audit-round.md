# Install regression + runtime on/off + audit fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release fixing the v2 install-on-apply regression (with synced labels and beta classification), making on/off applies take effect at runtime, adding type grouping to the extra sections, replacing the hazardous member scope-cycle with a direct menu, and landing seven verified audit fixes (R1 R2 R5 R6 R7 R9 R10).

**Architecture:** Obsidian plugin, TypeScript, pure-function core (`src/core`) + thin UI (`src/ui`) + Node-only externals (`src/external`). Sync list is compiled from `settings.items` on every recompile; capture/apply run through `ConfigSyncCore` with a `CoreContext` of host hooks.

**Tech Stack:** TypeScript, esbuild (`npm run build`), Vitest DOM-free (`npm test`), ESLint (`npm run lint`).

**Specs:** `docs/superpowers/specs/2026-08-05-restore-not-installed-items-design.md`, `…-onoff-apply-runtime-design.md`, `…-section-groups-and-member-menu-design.md`, `…-regression-audit-fixes-design.md`.

## Global Constraints

- **NO git commits** — all changes stay uncommitted (user review state); the cut happens later, controller-side, after live test.
- Repo root: `~/local/coding/open/obsidian-config-sync`. Compound `cd X && …` bash is permission-denied: use `git -C <repo>`, `npm --prefix <repo> run <script>`, absolute paths; quote grep globs (`--include='*.ts'`).
- Gates after every task: `npm --prefix <repo> run build` clean, `npm --prefix <repo> test` green, `npm --prefix <repo> run lint` **0 errors** (warnings baseline ≈ 57-58, do not add new ones).
- UI copy is English, product voice (no implementation words). Exact strings in tasks are final copy — use verbatim.
- No default parameter values in new code; explicit params. No `any`.
- Match surrounding comment density/style; comments state constraints, not change history.

---

### Task 1: Compile synthesized defs for selected-but-uninstalled plugins (spec C §1)

**Files:**
- Modify: `src/core/registry.ts` (`defsForForeignItems`, ~line 182)
- Modify: `src/main.ts` (`recompile`, ~line 265)
- Modify: `src/core/leftover.ts` (line 15 call site and its enclosing exported function's signature)
- Test: `tests/registry.test.ts`

**Interfaces:**
- Produces: `defsForForeignItems(defs: ItemDef[], itemIds: string[], betaIds: Set<string>): ItemDef[]` — synthesized defs get `section: betaIds.has(pluginId) ? "beta" : "community"`.
- `main.ts` recompile passes `env.betaIds` (already on `RegistryEnv`); leftover's path threads a `betaIds: Set<string>` param from its main.ts caller(s) (`storeSelfCopyGroups` / `selfListGroups` chain — find callers with grep and extend each signature explicitly; main holds `new Set(Object.keys(this.settings.bratPluginIndex))`, same value as `env.betaIds`).

- [ ] **Step 1: failing tests** in `tests/registry.test.ts` (follow the file's existing builder helpers):

```ts
describe("selected-but-uninstalled items compile locally", () => {
  it("a selected community item with no installed plugin still compiles its group", () => {
    const defs = defsForForeignItems(buildItemDefs(envWithNoCommunityPlugins), ["community:dataview"], new Set());
    const groups = compileItems(defs, { items: { "community:dataview": { enabled: true, companions: [] } }, customGroups: [] });
    expect(groups.map((g) => g.name)).toContain("plugin-dataview");
    expect(groups.find((g) => g.name === "plugin-dataview")?.path).toBe("{configDir}/plugins/dataview/data.json");
  });
  it("a synthesized def for a BRAT-indexed id is classified beta", () => {
    const defs = defsForForeignItems(buildItemDefs(envWithNoCommunityPlugins), ["community:slides-rup"], new Set(["slides-rup"]));
    expect(defs.find((d) => d.id === "community:slides-rup")?.section).toBe("beta");
  });
  it("an installed plugin's def is never duplicated", () => { /* known-set dedupe: pass an id already in defs, assert single def */ });
});
```

- [ ] **Step 2: run** `npm --prefix <repo> test -- registry` — expect FAIL (arity + missing group).
- [ ] **Step 3: implement** — `defsForForeignItems` gains the third param; section per the interface above; update the doc comment (it currently says the function is only for foreign/store parsing — it now also backs the local compile). In `recompile()`: `this.registryDefs = defsForForeignItems(buildItemDefs(env), Object.keys(this.settings.items), env.betaIds);`. Thread `betaIds` through leftover.ts's call site.
- [ ] **Step 4: run** registry tests → PASS; then full gates (build/test/lint).

### Task 2: Labels ride the store lock; retire backfillLabels (spec C §2)

**Files:**
- Modify: `src/core/types.ts` (`StoreLock.groups` value type)
- Modify: the lock writer (capture path builds `lock.groups[name]` entries with `sourcePluginVersion` — locate with `grep -rn "sourcePluginVersion" src/core --include='*.ts'`) and `parseStoreLock` validation
- Modify: `src/main.ts` — keep last loaded lock; `displayName`/`displayParts` fall back to it; DELETE `backfillLabels` (~line 357) and its call (~line 347)
- Test: `tests/` file that already covers `parseStoreLock` / lock round-trip (grep for `parseStoreLock`), plus a resolver-order test wherever `displayLabelForGroup` is tested

**Interfaces:**
- `StoreLock.groups[name]` gains `label?: string`.
- Resolver order (unchanged function, new fallback input): runtime name → stored group label → **lock label** → id. Implemented by passing `storedLabel ?? lockLabel` into the existing `displayLabelForGroup(name, plugins, storedLabel?)` — order is preserved because `displayLabelForGroup` already tries runtime first.

- [ ] **Step 1: failing tests** — lock round-trip keeps `label`; capture writes `label` for a plugin group using `ctx.plugins.getInstalledPluginName` (core plugins: `getCorePluginName`; obsidian cards: omit label).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement.** Capture side: when building a group's lock entry, resolve the label the same way the registry does for installed defs and include it when non-null. Main side: store the lock loaded in `computeStatuses` (`this.lastLock = lock`) and use `this.lastLock?.groups[group]?.label` as the final storedLabel fallback in `displayName`/`displayParts`. Delete `backfillLabels` wholesale — do NOT leave a stub.
- [ ] **Step 4:** tests PASS; full gates. `grep -rn "backfillLabels" src tests` returns nothing.

### Task 3: Catalog installs before BRAT installs in one apply run (spec C §3)

**Files:**
- Modify: the apply-run assembly point where staged groups with install state-actions are iterated (locate via `grep -n "installPlugin\|runStateAction" src/core/ConfigSyncCore.ts` and its caller in `src/main.ts` / `src/ui/SyncCenterView.ts`)
- Test: `tests/` alongside the existing apply/state-action tests (grep `runStateAction`)

**Interfaces:**
- Consumes: `settings.bratPluginIndex` (id → repo) — an id present there installs via BRAT.
- Produces: a pure ordering helper, e.g. `orderInstallsCatalogFirst(names: string[], isBrat: (pluginId: string) => boolean): string[]` (stable sort: non-BRAT first), applied to the sequential install iteration only — non-install applies keep their current order.

- [ ] **Step 1: failing test** — mixed staged list `["plugin-slides-rup", "plugin-obsidian42-brat", "plugin-dataview"]` with `isBrat = (id) => id === "slides-rup"` orders BRAT-managed last, others' relative order preserved.
- [ ] **Step 2:** FAIL → **Step 3:** implement helper + wire at the iteration point. **Step 4:** PASS + full gates.

### Task 4: Switch-list applies switch at runtime (spec B)

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` — `PluginHost` interface (~line 27), switch-list apply path (~lines 738-764; `switchDeltaMessages` at ~189)
- Modify: `src/main.ts` — `pluginHost()` (~line 855) adds `disableCorePlugin`
- Test: `tests/` file covering the apply path with the fake `ctx.plugins` (grep `enableForGroup` / `needsAppReload` in tests)

**Interfaces:**
- `PluginHost` gains `disableCorePlugin(id: string): Promise<void>` (impl: `internalPlugins().plugins[id].disable()`, throw on unknown id with the same message shape as `enableCorePlugin`).
- Refactor `switchDeltaMessages(before, after)` into `switchDelta(before: SwitchList | null, after: SwitchList): { on: string[]; off: string[] }` + a message formatter over it (messages stay byte-identical).
- Apply contract for `core-plugins` / `community-plugins` groups: after the carrier file write succeeds — for each `on` id: core → `enableCorePlugin`, community → `enablePlugin` (non-persistent); for each `off` id: core → `disableCorePlugin`, community → `disablePlugin`. `result.needsAppReload = false` for these two groups. Guards: skip runtime-disable of `"config-sync"` with warn message `config-sync stays running until reload`; a per-id throw appends a warn message and continues.

- [ ] **Step 1: failing tests** (fake plugins host records calls):

```ts
it("applying community-plugins switches the delta at runtime and needs no reload", async () => { /* on: [a], off: [b] → enablePlugin(a), disablePlugin(b), needsAppReload false */ });
it("applying core-plugins uses the core enable/disable hooks", async () => { /* … */ });
it("config-sync is never runtime-disabled", async () => { /* off contains config-sync → no disablePlugin call, warn message present */ });
it("one failing enable does not stop the others", async () => { /* enable throws for first id → warn recorded, second id still enabled */ });
it("an obsidian config group still flags needsAppReload", async () => { /* app group unchanged */ });
```

- [ ] **Step 2:** FAIL → **Step 3:** implement (file write first, runtime after — mirror the `StatePrelude.finish` ordering rationale in a short comment). **Step 4:** PASS + full gates.

### Task 5: R1 per-item exclusion + R2 encrypted guard

**Files:**
- Modify: `src/core/modes.ts` (export `excludingPerItem`, ~line 112), `src/core/ConfigSyncCore.ts` (`baseHasStaleLocalKeys` ~287 incl. its comment; `withContractLocals` ~83)
- Test: extend the files covering `baseHasStaleLocalKeys` (tests/status.test.ts per its sidecar test) and `withContractLocals`

- [ ] **Step 1: failing tests:**

```ts
it("R1: a local rule overlapping a per-item key never flags the base stale", () => { /* group: fields [{pattern:"enabledCssSnippets",scope:"local"}], perItem:{enabledCssSnippets:{}}; base contains the key → false */ });
it("R1: a genuinely stale non-per-item local key still flags", () => { /* → true */ });
it("R2: an encrypted-mode group is never demoted by contract locals", () => { expect(withContractLocals({ ...g, mode: "encrypted" }, ["vimMode"])).toEqual({ ...g, mode: "encrypted" }); });
```

- [ ] **Step 2:** FAIL → **Step 3:** `baseHasStaleLocalKeys`: `const patterns = excludingPerItem(effGroup, stripPatterns(effGroup));` and rewrite the false comment sentence ("A per-item key is never…") to state the real constraint (per-item keys are governed by perItem machinery, so the stale-key guard must use the same exclusion the strip paths use). `withContractLocals`: `if (group.fileRule !== undefined || group.mode === "encrypted") return group;` and extend its comment's fileRule sentence to cover encrypted mode. **Step 4:** PASS + full gates.

### Task 6: R5 autocrlf + R6 cache age bound + R7 tiered timeouts

**Files:**
- Modify: `src/external/gitSource.ts` (clone sites — reader AND writer; timeout constant ~line 10 and the exec seam ~line 59)
- Modify: `src/external/readerCache.ts`, `src/main.ts` (ReaderCache construction)
- Test: `tests/readerCache.test.ts` (exists — grep to confirm name; extend)

**Interfaces:**
- Clone arg lists gain leading `"-c", "core.autocrlf=false"` (git `-c` flags precede the subcommand).
- `ReaderCache` constructor: `constructor(private readonly now: () => number)`; entries `{ value, gen, at: number }`; `getReusable` requires `gen` match AND `this.now() - at <= REUSE_MAX_AGE_MS` (`export const REUSE_MAX_AGE_MS = 300_000`). main.ts constructs with `() => Date.now()`.
- gitSource: `const QUICK_TIMEOUT_MS = 60_000; const TRANSFER_TIMEOUT_MS = 300_000;` — the exec helper takes the timeout explicitly; `clone`/`fetch`/`checkout`/`push` invocations pass transfer, everything else quick. Timeout error text names the value actually used.

- [ ] **Step 1: failing tests** — readerCache: fresh same-gen entry reusable; entry older than `REUSE_MAX_AGE_MS` (advance injected now) not reusable; gen mismatch still not reusable.
- [ ] **Step 2:** FAIL → **Step 3:** implement all three (R5/R7 are arg/constant plumbing with no practical Node-suite test — covered by the readerCache tests compiling against the new constructor plus build/lint). **Step 4:** PASS + full gates.

### Task 7: R10 refresh coalescing + R9 compare attach

**Files:**
- Modify: `src/main.ts` (`refreshRemoteChecks` ~375; host surface for the reader generation)
- Modify: `src/ui/SyncCenterView.ts` (`renderRemoteDetail` / the deepDiff start site, ~2261-2314; host interface ~141-171)

**Interfaces:**
- R10: `private remoteRefreshRun: Promise<void> | null = null;` — `refreshRemoteChecks()` returns the in-flight promise when set; otherwise assigns `this.remoteRefreshRun = this.doRefreshRemoteChecks().finally(() => { this.remoteRefreshRun = null; })` (body moved to the private method unchanged).
- R9: host gains `readerGeneration(): number` (returns `this.readerCache.generation()`). The view keeps `private inflightCompare: { key: string; promise: Promise<…existing diff result type…> } | null`; key = `` `${remote.name}:${this.host.readerGeneration()}` ``. On render: same key + pending → re-attach (render the progress UI against the existing promise; do not start a new deepDiff); different key → start fresh and replace. Existing gen/scope gates on completion stay as they are.

- [ ] **Step 1:** No clean pure-function seam here — this is wiring. Write the R10 guard and R9 attach logic directly.
- [ ] **Step 2: manual verification via build + targeted read-through**: `refreshRemoteChecks` re-entry returns the same promise (add a small main-layer test only if the existing test harness already fakes this seam — grep `refreshRemoteChecks` in tests; do not build new scaffolding for it).
- [ ] **Step 3:** full gates. Live test covers the visible behavior (elapsed indicator no longer resets during refresh; progress count never exceeds total).

### Task 8: A section grouping + R3 read-only structural rows + R4 direct menu

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`renderSection` ~1492, `renderInfoSection` ~1466, `renderPerPluginRules` ~1838, `renderScopedDisclosure` ~1875)
- Modify: `src/ui/panelModel.ts` (`MemberDecision`, `memberDecisionsFromScopes` and/or the scope-derivation input it needs)
- Modify: `src/main.ts` (`switchMemberDecisions` host path ~1100 — supply the structural fact)
- Modify: `styles.css` (structural-row hint + disabled glyph styling; reuse existing tokens)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- A: `renderSection` renders its card rows via `this.renderRowList(card, matches)` (replaces the flat loop). `renderInfoSection` applies the same grouping inline for its static rows (headers only when `panelScope` is device+all — same predicate `renderRowList` uses; extract that predicate into a tiny private helper both use).
- R3: `MemberDecision` gains `structural: boolean` — true iff the derived scope is `"local"` with no explicit source (`localMembers` entry or `enabledOn`) and the item's card is off (`cfg.enabled === false`). The derivation function reads whatever inputs it needs — read `memberDecisionsFromScopes` and its main.ts caller first, then extend the signature explicitly (no boolean flags multiplexing behavior; pass the data, derive inside).
- R3 render: structural rows — name span keeps normal styling, hint span text **"settings sync off — turn it on in Settings to set a rule"**, scope glyph rendered dimmed and non-interactive (no click handler, `aria-disabled="true"`).
- R4: in BOTH member lists, the scope control becomes a glyph button that opens an Obsidian `Menu` on click: one item per `scopeOptionsFor(id)` entry, labels `Everywhere` / `Computers only` / `Phones only` / (`Platform.isMobile ? "This phone only" : "This computer only"`), icons from `SCOPE_ICONS`, current value `setChecked(true)`; selecting calls the existing `writeMemberScope(group, id, scope)` once. Delete the `renderScopeCycle` usage from these two call sites only — `scopeCycle.ts` itself and its Settings-card usages stay.

- [ ] **Step 1: failing tests** (panelModel): structural derivation truth table — card-off+no-rule → `structural: true`; `localMembers` pin → `false`; `enabledOn: "desktop"` → `false`; card-on explicit local → `false`.
- [ ] **Step 2:** FAIL → **Step 3:** implement panelModel + main plumbing → tests PASS.
- [ ] **Step 4:** implement the view changes (A grouping, structural rows, menus) + styles.
- [ ] **Step 5:** full gates; grep confirms `renderScopeCycle` no longer referenced from `renderPerPluginRules`/`renderScopedDisclosure` but still used by Settings cards.

---

## Final (controller-side, not a subagent task)

1. Whole-branch final review (most capable model) against the four specs.
2. Build; deploy `main.js`/`manifest.json`/`styles.css` to the three vaults (`main.vault`, `kickstart.vault`, `llm-wiki.vault` under `~/local/data/application_data/obsidian/`, each `.obsidian/plugins/config-sync/`), sha256-verify.
3. Live-test checklist: llm shows ~100 items with "Not installed" grouped by type; batch apply installs catalog plugins then BRAT ones; labels show pretty names after one capture on main; on/off apply reflects immediately with no reload banner for those two rows; member menus one-click; refresh no longer resets the compare indicator.
4. USER confirms → docs-currency pass → hand-written release notes → ONE cut. No publishing.

## Self-review notes

- Spec coverage: C §1→T1, §2→T2, §3→T3; B→T4; R1 R2→T5; R5 R6 R7→T6; R9 R10→T7; A R3 R4→T8. R8 = no action (adjudicated).
- Type consistency: `defsForForeignItems` third param `Set<string>` everywhere; `StoreLock.groups[name].label?: string`; `switchDelta` returns `{on, off}`; `ReaderCache` ctor injection used by both prod and tests.
- Known look-ups left to implementers are locate-only (grep target given), never design decisions.
