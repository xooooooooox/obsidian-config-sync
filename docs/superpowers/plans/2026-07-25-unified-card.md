# Unified Card (统一卡 · 归域 v7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the settings panel as one uniform item-card renderer (row + 3-zone drawer) over a registry, with orthogonal {scope, encrypted} rules, whole-file encryption for Plain mode, generalized per-item scopes for string-array keys, dissolved aggregate rows, and a breaking settings-schema v2.

**Architecture:** Engine keeps the v3 batch (sidecars, capture/apply/diff, switch-list); this iteration restructures `FieldRule`, generalizes switch-list semantics to embedded array keys, introduces an item registry that compiles `ItemConfig` → existing `SyncGroup`s, and replaces the three UI render branches (`app-view` / `appearance-domain` / switch-list rows) with one card renderer.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild. Spec: `docs/superpowers/specs/2026-07-25-unified-card-design.md` (D1–D13 normative).

## Global Constraints

- **NO COMMITS.** All work stays uncommitted on `main` (same batch as phase 1 + v3). Per-task baselines via `git stash create` snapshots; review packages = `git --no-pager diff -U10 <SNAP> -- <files>` (use `git add -N` for new files first). Never `git reset --hard`, never commit, no Claude attribution anywhere.
- **Gates per task:** `npm run build` clean; `npx vitest run` all green (update tests broken by intentional restructures — never delete coverage without replacement); `npx eslint .` 0 errors, ≤ 64 warnings.
- **Copy contract is character-exact** (spec §10). Binding strings, verbatim:
  - Row descriptions: `Editing behavior — live preview, spellcheck, line settings (app.json).` · `Attachments, link format, excluded files (app.json).` · `Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.` · `Custom keyboard shortcuts.` · `App settings without a page in Obsidian's settings window (app.json). New or unrecognized keys land here.` · community: `plugins/<id> — files, settings and enabled state.` · core with file: `<file> — settings and enabled state.` · core state-only: `Enabled state only — no settings file yet.`
  - `Sync all` / `Toggle every plugin below.`
  - Zone titles: `Enabled on` · `Settings file` · `Companion folders`
  - Hints: `which devices turn this plugin on — community-plugins.json` (core: `— core-plugins.json`) · `items managed under snippets/ below` · `chips write enabledCssSnippets per item — the snippet file follows its scope` · `Obsidian stores this Appearance option in app.json — synced with the app group.` · `Settings appear here once <Name> writes <file>.`
  - Controls: `Custom path` · `Per-item scopes` · `Encrypt` (checkbox) · scopes `All devices` / `Desktop only` / `Mobile only` / `This device` · mode `Plain` / `Fields` / `Fields · shared` · `+ Add folder`
  - Legend: `blue = desktop only · amber = mobile only · red = this device · 🔒 = encrypted · click a key to add a rule`
  - Badges: `on: desktop` / `on: mobile` / `on: this device` / `N device-scoped` / `N encrypted` / `array` / `array · per-item` / `from app.json` / `shared slice` / `This device · on`
- **Breaking upgrade (D13):** no migration code; old schema → Notice + empty config. Delete legacy paths, don't preserve them.
- **obsidian-cli:** any manual smoke MUST `cd dev/vault` first (CWD routing falls back to the user's real vault). Subagents must not run obsidian-cli at all; controller smokes at the end.
- Code/comments/identifiers English; no personal paths in any artifact.

---

### Task 1: Orthogonal rule model — FieldRule {scope, encrypted}

**Files:**
- Modify: `src/core/types.ts`, `src/core/manifest.ts`, `src/core/modes.ts`, `src/ui/jsonView.ts`
- Tests: `tests/ruleMatrix.test.ts` (new), update `tests/classPartition.test.ts`, `tests/sidecarLifecycle.test.ts`, manifest validation tests, `tests/json-view.test.ts`

**Interfaces (produces — later tasks consume exactly these):**

```ts
// types.ts — replaces FIELD_RULE_ACTIONS/action
export const RULE_SCOPES = ["all", "desktop", "mobile", "local"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];
export interface FieldRule { scope: RuleScope; encrypted: boolean; }
```

Semantics matrix (D1, spec §2) — implement in `modes.ts` `captureTransform`/`applyTransform`/`contentUnchanged`:

| scope | encrypted=false | encrypted=true |
|---|---|---|
| all | plaintext → common base | ciphertext → common base (old `encrypt`) |
| desktop/mobile | value → matching `__scopes__` sidecar (old class rule) | **encrypt first, ciphertext → matching sidecar** |
| local | dropped from store; apply preserves local (old `strip`) | **invalid** — `manifest.ts` validator rejects `{scope:"local",encrypted:true}` with an error naming the key and both fields |

- [ ] **Step 1:** Write `tests/ruleMatrix.test.ts`: one test per matrix cell — capture places the value in the right region (base / sidecar / dropped), encrypted cells store ciphertext (assert not plaintext, decryptable with passphrase), apply round-trips each cell on both device classes (own class gets sidecar value decrypted; other class preserves local). Plus: manifest validator accepts all 7 legal combos, rejects `local+encrypted` and unknown scopes.
- [ ] **Step 2:** Run — all new tests FAIL (FieldRule shape mismatch).
- [ ] **Step 3:** Implement: `types.ts` shape; `manifest.ts` `isValidFieldRule` derives from `RULE_SCOPES` + boolean check + local/encrypted rejection (validator and type MUST share the const — this exact drift caused the v3 config-wipe CRITICAL); `modes.ts` branch on `{scope, encrypted}` (compose: encrypt value, then route by scope; `classPatterns`/sidecar plumbing unchanged); `jsonView.ts` `KeyState` → `{ scope: RuleScope | "none"; encrypted: boolean }`, color by scope, `encrypted` renders 🔒 suffix (color+lock combine).
- [ ] **Step 4:** Update existing tests mechanically (`{action:"strip"}` → `{scope:"local",encrypted:false}`, `{action:"encrypt"}` → `{scope:"all",encrypted:true}`, `{action:"desktop"}` → `{scope:"desktop",encrypted:false}`; drop inert `"all"` action tests — `{scope:"all",encrypted:false}` is now simply the default and needs one explicit-inert test).
- [ ] **Step 5:** Gates green; append ledger line.

### Task 2: Plain whole-file encryption + file-level rule

**Files:**
- Modify: `src/core/types.ts` (FileRule), `src/core/modes.ts`, `src/core/ConfigSyncCore.ts`, `src/core/manifest.ts`
- Tests: `tests/fileEncrypt.test.ts` (new)

**Interfaces:**

```ts
export interface FileRule { scope: Exclude<RuleScope, "local">; encrypted: boolean; } // D9: no local
```

- Plain group with `fileRule.encrypted` → store content is an encryption envelope (reuse the existing field-crypto primitives; payload = whole file text; envelope JSON marker so `contentUnchanged`/diff can detect without decrypting: compare decrypted payload when passphrase available, else envelope bytes).
- `fileRule.scope` compiles to the group's devices class (existing mechanism) — no sidecar involvement.
- Applies to any Plain single-file group and to companion-folder member files? **No** — files-in-folders stay plaintext (YAGNI); FileRule attaches to `settingsFile` Plain mode only.

- [ ] **Step 1:** Write `tests/fileEncrypt.test.ts`: capture(plain+encrypted) stores non-plaintext envelope; apply decrypts to byte-identical original; `contentUnchanged` true for same content / false after local edit; missing passphrase on apply → explicit error (no silent plaintext fallback); diff labels the pair `encrypted file`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement in `modes.ts` (envelope encode/decode helpers, exported) + `ConfigSyncCore.ts` wiring at captureGroup/applyGroup/compareFile; manifest carries `fileRule` per group, validated.
- [ ] **Step 4:** Gates green; ledger.

### Task 3: Per-item scopes for string-array keys (generalized switch-list)

**Files:**
- Modify: `src/core/modes.ts` (or new `src/core/perItem.ts` if modes.ts grows unwieldy), reuse helpers from `src/core/switchList.ts`
- Tests: `tests/perItemScopes.test.ts` (new)

**Interfaces:**

```ts
export type PerItemScopes = Record<string, RuleScope>; // element value → scope; absent = "all"
// per group: perItem: Record<string /*key*/, PerItemScopes>
export function capturePerItemArray(localArr: string[], storeArr: string[], scopes: PerItemScopes, cls: DeviceClass): string[];
export function applyPerItemArray(storeArr: string[], localArr: string[], scopes: PerItemScopes, cls: DeviceClass): string[];
```

Semantics (spec §3): capture(c) = local elements with scope∈{all,c} (local order) ⧺ store elements with scope=otherClass(c) (store order, deduped); apply(c) = store elements with scope∈{all,c} ⧺ local elements with scope=local. Non-string arrays and object arrays: `perItem` config is rejected by manifest validation (D3). Encrypt stays key-level: a key with per-item enabled cannot also be `encrypted` (validator rejects). Companion behaviors (force-off, orphan cleanup, file-follow) are NOT in this task — they stay in switchList.ts and attach via registry in Task 4.

- [ ] **Step 1:** Write `tests/perItemScopes.test.ts`: matrix over both classes — all/desktop/mobile/local elements captured & applied per formulas; dedupe; stale store element with local scope dropped on capture; idempotence (capture∘apply∘capture stable); `contentUnchanged` ignores other-class elements symmetrically; validator rejects perItem on non-array key and perItem+encrypted.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; wire into fields-mode captureTransform/applyTransform/contentUnchanged for keys listed in the group's `perItem` map.
- [ ] **Step 4:** Gates green; ledger.

### Task 4: Settings schema v2 + item registry + compile + blocking upgrade + map fix

**Files:**
- Create: `src/core/registry.ts`
- Modify: `src/main.ts` (settings shape + load gate), `src/core/catalog.ts` (APP_JSON_TAB_MAP, remove kind/app-view/appearance-domain emission), delete legacy paths in `src/core/settingsMigration.ts`
- Tests: `tests/registry.test.ts` (new), `tests/schemaGate.test.ts` (new), update `tests/catalog.test.ts`, `tests/appTabs.test.ts`

**Interfaces (spec §6, exact):**

```ts
interface ConfigSyncSettings {
  schemaVersion: 2;
  items: Record<string, ItemConfig>;
  appJson: { mode: "plain" | "fields" };
  /* remotes, passphrase, existing globals unchanged */
}
interface ItemConfig {
  enabled: boolean;
  settingsFile?: {
    customPath?: string;
    mode: "plain" | "fields";
    fileRule?: FileRule;
    rules: Record<string, FieldRule>;
    perItem: Record<string, PerItemScopes>;
  };
  companions: { path: string; scope: "all" | "desktop" | "mobile"; enabled: boolean }[];
  enabledOn?: RuleScope;
}
interface ItemDef { // registry, built from env
  id: string; label: string; description: string;
  section: "obsidian" | "core" | "community" | "beta";
  enablement?: { carrier: "core-plugins.json" | "community-plugins.json"; element: string };
  settingsFile?: { defaultPath: string | null; appSlice?: AppJsonTab }; // null = state-only (no file yet)
  presetCompanions?: { path: string; mapKey?: string }[]; // appearance: snippets/ (mapKey "enabledCssSnippets"), themes/
}
export function buildItemDefs(env: RegistryEnv): ItemDef[];
export function compileItems(defs: ItemDef[], settings: ConfigSyncSettings): SyncGroup[];
```

Compile rules (normative):
- Obsidian cards: `editor`/`files-links`/`other` + appearance's `showInlineTitle` share ONE `app` group; each card's `rules`/`perItem` merge flat (keys partitioned by `appTabFor`); card `enabled:false` → its keys compiled to `{scope:"local"}`; all four off → no app group. `appJson.mode` is the group mode.
- `APP_JSON_TAB_MAP`: `showInlineTitle` → `"appearance"`; `appTabFor` fallback → `"other"`; `AppJsonTab` gains `"appearance" | "other"`, drops `"general"`.
- Appearance card additionally compiles `appearance.json` group + companion groups (themes/, snippets/) + `enabledCssSnippets` perItem from its snippet scopes.
- Plugin cards: dir/file group per plugin when `enabled`; enablement arrays compile to two hidden switch-list groups (`core-plugins.json`, `community-plugins.json`) whose per-element scopes = each card's `enabledOn` (default `all`); card `enabled:false` → element scope `local` (D5). Hidden groups exist iff ≥1 card in their section is enabled. Core defs = full runtime core-id list (state-only when settings file absent); community/beta defs = plugins dir scan.
- Companions compile to dir groups (path-collision with any other item's carriers → compile error surfaced as Notice; add-time UI also rejects, Task 7).
- Load gate: `data.json` lacking `schemaVersion: 2` (e.g. legacy `groups`) → show Notice `Config Sync: settings schema changed — please reconfigure your sync items.` and start with defaults (all items disabled); delete `settingsMigration.ts` legacy migrations, keep only this gate.

- [ ] **Step 1:** Write tests: `registry.test.ts` — def building (core full list incl. state-only null path; community scan; appearance presets), each compile rule above (esp. four-off removes app group, enabledOn→element scope, card-off→local, collision error); `schemaGate.test.ts` — legacy data.json blocked with Notice text, v2 loads; catalog/appTabs updates (showInlineTitle appearance, other fallback, no general).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement registry + compile; rewire `main.ts` to compile on settings change; catalog stops emitting `kind` items (Task 5 consumes ItemDefs directly); keep `resolveGroupByStoreRel` etc. intact.
- [ ] **Step 4:** Gates green; ledger.

### Task 5: Unified card renderer — Obsidian tab

**Files:**
- Create: `src/ui/itemCard.ts` (pure render helpers + badge computation), rewrite relevant parts of `src/ui/SettingTab.ts`
- Modify: `src/ui/jsonView.ts` (element-level coloring for per-item arrays; click-key-to-add kept), `styles.css`
- Tests: `tests/itemCard.test.ts` (badge/zone computation as pure functions), update `tests/catalog.test.ts`, `tests/sensitive-sort.test.ts` (unchanged behavior, new inputs)

Card anatomy (D2, spec §4) — one renderer for every ItemDef:
- Row: name + badges (`computeBadges(def, cfg): Badge[]` pure, exact strings from Global Constraints) + sync toggle + chevron. No chips on row.
- Drawer zone ②: `SETTINGS FILE` head (path code, `Custom path` toggle — Task 7 wires behavior, this task renders disabled placeholder OFF state only), mode chip (`Plain ▾`/`Fields ▾`; app-slice cards render `Fields ▾ · shared` and write `appJson.mode`); Fields = every actual key row [+`array` badge] + scope chip (4 options) + `Encrypt` checkbox (disabled at This device); array keys get `Per-item scopes` toggle → indented element rows with scope chips; Plain = single file-level row (3-scope chip + Encrypt). Data-file preview = card slice only, scope colors + 🔒, click-to-add kept, glob input REMOVED.
- Appearance specifics: `enabledCssSnippets` renders pointer row (`array · per-item` badge + hint `items managed under snippets/ below`, no chip); `showInlineTitle` row with `from app.json` badge + its hint; preset companions render via zone ③ scaffold (Task 7 completes interactions) with snippet member rows merged from perItem scopes (chip writes element scope; hint string per contract).
- Delete: `renderAppViewRow`, `renderAppSharedMode`, `renderAppearanceDomain`, kind branches, snippets master toggle, glob rule editor, `.config-sync-act-btn`-era leftovers touched by these regions.
- Row order: Editor → Files and links → Appearance → Hotkeys → Other (catalog order; sensitive float unchanged).

- [ ] **Step 1:** Write `tests/itemCard.test.ts`: badge computation matrix (enabledOn defaults/non-defaults, device-scoped & encrypted counts incl. per-item elements), zone presence rules (state-only/no-enablement/plain omissions), app-slice shared-mode write-through, appearance pointer-row logic, slice-preview key filtering.
- [ ] **Step 2:** Run — FAIL; implement; migrate SettingTab Obsidian tab to `renderItemCard(def, cfg)`.
- [ ] **Step 3:** Gates green (all suites); ledger.

### Task 6: Plugins tabs — Enabled on, state-only cards, aggregate rows removed, Sync all

**Files:**
- Modify: `src/ui/SettingTab.ts`, `src/core/catalog.ts` (drop `OPTION_LABELS` entries + emission for `core-plugins.json` / `community-plugins.json` rows)
- Tests: update `tests/catalog.test.ts`, extend `tests/itemCard.test.ts`

- Core/Community/Beta tabs render ItemDef cards through the same renderer: zone ① `Enabled on` row (hint per contract, 4-scope chip writing `enabledOn`), zone ② per state (state-only hint `Settings appear here once <Name> writes <file>.`), descriptions per contract.
- Aggregate rows fully gone (labels, drawers, their Device scope editor — `renderLocalDecisions` survives only if snippet members still use it; otherwise delete).
- `Sync all` = plain master toggle over the section's cards (`Toggle every plugin below.`), no kind-exclusion logic left.
- [ ] **Steps:** tests (rows emitted for full core list incl. state-only; no aggregate items anywhere; Sync all flips every card and derives state from all-enabled) → FAIL → implement → gates → ledger.

### Task 7: Companion folders + custom path

**Files:**
- Modify: `src/ui/SettingTab.ts` / `src/ui/itemCard.ts`, `src/core/registry.ts` (collision check helper `companionConflict(path, defs, settings): string | null`)
- Tests: `tests/companions.test.ts` (new)

- Zone ③ full behavior: `+ Add folder` (text input, vault-relative; normalize; reject empty/absolute/`..`); dedupe within card; `companionConflict` rejects any path already a carrier of any item (returns offending item label for the error Notice). User-added rows removable (`✕`); preset rows (snippets/, themes/) not removable — editing their path or removing requires the warning modal: confirm proceeds, cancel reverts (exact modal copy: title `Change a preset folder?`, body `This folder is part of <Item>'s preset configuration. Changing it makes the old store entry a leftover (cleaned up by the usual flow) and captures the new path as a fresh item.` buttons `Change` / `Cancel`).
- `Custom path` toggle (zone ②): ON reveals path input; same warning modal for preset paths; on confirmed change: old store entry left to existing leftover cleanup, config points at new path (D7). No migration.
- Member rows inside expanded companion: scope chip; mapKey-backed folders (snippets) write perItem element scopes; plain folders write per-member carry scope (reuse snippet member mechanics).
- [ ] **Steps:** tests (conflict matrix incl. self, preset guard requires confirm, custom-path change produces new group id + leaves old store rel) → FAIL → implement → gates → ledger.

### Task 8: Cleanup, vocabulary, docs, final gates

**Files:**
- Modify: `src/ui/SyncCenter*.{ts,tsx?}`/relevant view files (excluded/Exclude wording), `styles.css` (dead selectors), `README.md` + `README.zh.md` (1:1 line parity), `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md`
- Tests: full suite pass; grep-based assertions where cheap

- Sync Center: replace `excluded`/`Exclude` vocabulary with This-device phrasing consistent with the card model (exact strings chosen against existing Sync Center copy at implementation time and recorded in the ledger — they become contract).
- Remove now-dead settings/UI code paths (appTabs module parts superseded by registry, unused CSS classes), keeping engine intact.
- Docs currency (same batch, per rule): README both languages describe card model, per-item scopes, orthogonal rules, breaking upgrade; ARCHITECTURE reflects registry/compile pipeline; DESIGN gets the unified-card entry + release-notes clause (all devices upgrade together + reconfigure).
- [ ] **Steps:** implement → grep leftovers (`app-view`, `appearance-domain`, `Enabled community plugins`, `Enabled core plugins`, `excluded`) → full gates (build / vitest / eslint 0-errors ≤64-warnings) → ledger.

---

## Final verification (controller, not a task subagent)

1. `scripts/review-package <START_SNAP> HEAD`-equivalent snapshot diff → opus whole-branch review (0 must-fix to proceed).
2. Deploy to dev vault; smoke per spec §9 (**`cd dev/vault` mandatory**): five Obsidian cards copy check; Dataview full chain (Enabled on → community-plugins.json element behavior across capture/apply; apiKey encrypt; desktop+encrypted → ciphertext in sidecar); snippets member chip → enabledCssSnippets + file-follow; userIgnoreFilters per-item; custom path warning + leftover; legacy data.json → blocking Notice.
3. Record findings + release-notes obligations in `.superpowers/sdd/progress.md`; update memory backlog entry. No commit, no cut (user decides).

## Self-review notes

- Type/validator drift (v3 CRITICAL) addressed structurally: Task 1 derives validation from `RULE_SCOPES`.
- Cross-task interface consistency checked: `FieldRule`/`FileRule`/`PerItemScopes`/`ItemDef`/`ItemConfig` names and shapes match spec §2/§3/§6 verbatim; Tasks 5–7 consume Task 4's `buildItemDefs`/`compileItems` only.
- Ordering: engine (1–3) → schema/compile (4) → UI (5–7) → cleanup/docs (8); each task independently green.
