# Self Update Advisory + Section Head Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface "this device's Config Sync is older than the store's captured version" as an advisory (pane block + orange pills), and fix the non-main section head counts that read "0 ✓1" for a section with one actionable row.

**Architecture:** `selfPaneState` (pure, `src/core/selfPane.ts`) gains an orthogonal `versionBehind` flag; `main.ts` `selfStatus` maps it into a new `SelfSyncInfo.updateAvailable` field; the Sync Center renders it as an amber advisory in the self pane and an `is-behind` pill on the three self surfaces. Separately, `renderSection` head counts switch to row-count semantics and two unreachable self-in-outdated branches are deleted.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-07-30-self-update-available-section-counts-design.md` (mockup 定稿 linked there).

## Global Constraints

- Copy is 定稿 — use these strings verbatim:
  - Advisory text: `Captured on Config Sync ${store} — this device runs ${local}. Update before adopting or applying.`
  - Advisory button label: `Open Community plugins`
  - Pill text: `update available`; pill/CSS variant class: `is-behind`
  - Chip lucide icon for the behind case: `arrow-down-to-line`
- No update ACTION for self anywhere — advisory only (updating config-sync from inside a run would unload the code executing the run).
- The self group stays OUT of the item list / Outdated section; the coldstart pane state keeps `versionBehind: false`.
- Repo: `~/local/coding/open/obsidian-config-sync`. Work on branch `self-update-advisory` off `main`.
- Gates per task: `npm test` (vitest), `npm run build` (tsc + esbuild), `npm run lint` (must add no new warnings over the current baseline).
- Commit messages: conventional (`fix:`/`feat:`/`docs:`), NO Claude/AI attribution trailers of any kind.

---

### Task 1: `selfPaneState` gains `versionBehind` (pure core + tests)

**Files:**
- Modify: `src/core/selfPane.ts`
- Test: `tests/selfPane.test.ts`

**Interfaces:**
- Produces: `selfPaneState(args)` return type gains `versionBehind: boolean` — `true` iff `!isColdStart && drift === "behind"`. State machine otherwise unchanged. Task 2 consumes `decided.versionBehind`.

- [ ] **Step 1: Update existing expectations and add failing tests**

In `tests/selfPane.test.ts`, every existing `toEqual({ ... })` expectation object (all 9 exact-object assertions; the `never-synced` test at the end asserts fields individually and needs no change) gains `versionBehind: false`, inserted right after its `versionRefresh` entry. Example — the first test becomes:

```ts
  it("cold start when the device has no list yet", () => {
    expect(selfPaneState({ isColdStart: true, groupState: "in-sync", drift: null, flagsDrift: false })).toEqual({ state: "coldstart", versionRefresh: false, versionBehind: false, contentChanged: false, flagsRefresh: false });
  });
```

Then append the new cases before the closing `});`:

```ts
  it("content in-sync but version behind (store captured on a newer plugin) = insync with a versionBehind advisory", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: "behind", flagsDrift: false })).toEqual({ state: "insync", versionRefresh: false, versionBehind: true, contentChanged: false, flagsRefresh: false });
  });
  it("version behind coexists with a direction state (adopt)", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "store-newer", drift: "behind", flagsDrift: false })).toEqual({ state: "adopt", versionRefresh: false, versionBehind: true, contentChanged: true, flagsRefresh: false });
  });
  it("cold start ignores behind drift (single-decision surface; advisory appears after adopt)", () => {
    expect(selfPaneState({ isColdStart: true, groupState: undefined, drift: "behind", flagsDrift: false })).toEqual({ state: "coldstart", versionRefresh: false, versionBehind: false, contentChanged: false, flagsRefresh: false });
  });
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run tests/selfPane.test.ts`
Expected: FAIL — every `toEqual` mismatches (received objects lack `versionBehind`).

- [ ] **Step 3: Implement `versionBehind` in `src/core/selfPane.ts`**

Extend the return type and both return statements; extend the doc comment's last sentence. Full new function body:

```ts
export function selfPaneState(args: { isColdStart: boolean; groupState: GroupState | undefined; drift: VersionDrift; flagsDrift: boolean }): {
  state: SelfPaneState;
  versionRefresh: boolean;
  versionBehind: boolean;
  contentChanged: boolean;
  flagsRefresh: boolean;
} {
  if (args.isColdStart) return { state: "coldstart", versionRefresh: false, versionBehind: false, contentChanged: false, flagsRefresh: false };
  const s = args.groupState;
  const versionRefresh = s === "in-sync" && args.drift === "ahead";
  const versionBehind = args.drift === "behind";
  const flagsRefresh = args.flagsDrift;
  const contentChanged = s === "local-changed" || s === "store-newer" || s === "differs" || s === "not-captured" || s === "never-synced";
  let state: SelfPaneState;
  if (s === "store-newer" || s === "never-synced") state = "adopt";
  else if (s === "differs") state = "both";
  else if (s === "local-changed" || s === "not-captured" || versionRefresh || flagsRefresh) state = "capture";
  else state = "insync";
  return { state, versionRefresh, versionBehind, contentChanged, flagsRefresh };
}
```

Append to the doc comment above the function: `` `versionBehind` (this device's plugin older than the store's captured version) is an orthogonal advisory — it never changes `state`, because updating config-sync from inside a run would unload the running code; the pane can only point at Obsidian's updater.``

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/selfPane.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/selfPane.ts tests/selfPane.test.ts
git commit -m "feat: selfPaneState reports versionBehind advisory flag"
```

---

### Task 2: `SelfSyncInfo.updateAvailable` wiring (host)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (the `SelfSyncInfo` interface, ~line 120)
- Modify: `src/main.ts` (`selfStatus`, ~lines 495-514)

**Interfaces:**
- Consumes: `decided.versionBehind` from Task 1.
- Produces: `SelfSyncInfo.updateAvailable: { local: string; store: string } | null` — Task 3 consumes it.

- [ ] **Step 1: Extend the interface**

In `src/ui/SyncCenterView.ts`, after the `versionRefresh` line in `SelfSyncInfo`:

```ts
  updateAvailable: { local: string; store: string } | null; // plugin version behind the store's captured version — advisory only
```

- [ ] **Step 2: Populate it in `src/main.ts` `selfStatus`**

Add `updateAvailable: null` to both early returns (the `localList.length === 0` coldstart return at ~line 495 and the `selfGroup === undefined` return at ~line 497). Then, next to the existing `versionRefresh` mapping (~line 512), add the mirror mapping and include it in the final return:

```ts
        const updateAvailable =
          decided.versionBehind && av.localVersion !== null && av.storeVersion !== null ? { local: av.localVersion, store: av.storeVersion } : null;
        return { state: decided.state, delta, itemCount: localList.length, capturedAt, contentChanged: decided.contentChanged, versionRefresh, updateAvailable, flagsRefresh: flagsRefreshCount > 0 ? flagsRefreshCount : null };
```

- [ ] **Step 3: Verify with the full gates**

Run: `npm test && npm run build`
Expected: all tests PASS; tsc/esbuild clean (the compiler is the test here — every `SelfSyncInfo` construction site must carry the new field).

- [ ] **Step 4: Commit**

```bash
git add src/ui/SyncCenterView.ts src/main.ts
git commit -m "feat: selfStatus exposes updateAvailable version pair"
```

---

### Task 3: advisory UI — pills, chip icon, pane block, CSS

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`selfStatePill` ~line 518, `renderSelfChip` ~line 885, `renderConfigSyncMode` ~line 588, new `openCommunityPlugins` next to `openConfigSyncSettings` ~line 565)
- Modify: `styles.css` (chip variants ~line 612, side pill ~line 741, pane pill ~line 749, new advisory block near ~line 756)

**Interfaces:**
- Consumes: `info.updateAvailable` from Task 2.
- Produces: pill variant class `is-behind` (Task 5 documents it). No new exports.

- [ ] **Step 1: `selfStatePill` — insync + behind swaps the green pill**

Replace the `insync` case:

```ts
      case "insync":
        // Content is in sync, but an older plugin here shouldn't read as "all good" —
        // the store's settings were captured on a newer Config Sync.
        return info.updateAvailable !== null ? { text: "update available", cls: "is-behind" } : { text: "in sync", cls: "is-ok" };
```

Non-insync states keep their direction pills — the pane advisory (Step 3) still shows.

- [ ] **Step 2: `renderSelfChip` — icon keys off the pill, not the state**

Replace `setIcon(ic, info.state === "insync" ? "check" : "settings");` with:

```ts
    setIcon(ic, pill.cls === "is-ok" ? "check" : pill.cls === "is-behind" ? "arrow-down-to-line" : "settings");
```

- [ ] **Step 3: pane advisory block + `openCommunityPlugins`**

In `renderConfigSyncMode`, directly after the `cfgBtn` click listener (before the `if (info.state === "coldstart")` branch):

```ts
    if (info.updateAvailable !== null) {
      // Advisory only — no update action: updating config-sync from inside a run would
      // unload the code executing the run, so the pane can only point at Obsidian's updater.
      const behind = pane.createDiv({ cls: "config-sync-self-behind" });
      behind.createSpan({
        cls: "config-sync-self-behind-txt",
        text: `Captured on Config Sync ${info.updateAvailable.store} — this device runs ${info.updateAvailable.local}. Update before adopting or applying.`,
      });
      const open = behind.createEl("button", { cls: "config-sync-self-behind-btn", text: "Open Community plugins" });
      open.addEventListener("click", () => this.openCommunityPlugins());
    }
```

Next to `openConfigSyncSettings` add:

```ts
  private openCommunityPlugins(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById("community-plugins");
  }
```

- [ ] **Step 4: CSS**

Add each `is-behind` variant on the line after its sibling `is-ok` variant, and the advisory block after `.config-sync-self-block-s` (~line 760):

```css
.config-sync-self-chip.is-behind { border-color: rgba(var(--color-orange-rgb), 0.5); color: var(--color-orange); }
.config-sync-side-self-pill.is-behind { border-color: rgba(var(--color-orange-rgb), 0.5); color: var(--color-orange); }
.config-sync-self-pill.is-behind { background: rgba(var(--color-orange-rgb), 0.15); color: var(--color-orange); }
.config-sync-self-behind { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; border: 1px solid rgba(var(--color-orange-rgb), 0.35); border-left: 3px solid var(--color-orange); background: rgba(var(--color-orange-rgb), 0.07); border-radius: 8px; padding: 10px 12px; margin: 10px 0 12px; }
.config-sync-self-behind-txt { flex: 1 1 260px; color: var(--text-muted); font-size: var(--font-ui-smaller); line-height: 1.45; }
.config-sync-self-behind-btn { flex: none; font-size: var(--font-ui-smaller); color: var(--color-orange); background: rgba(var(--color-orange-rgb), 0.12); border: 1px solid rgba(var(--color-orange-rgb), 0.45); border-radius: 6px; padding: 4px 10px; white-space: nowrap; cursor: pointer; }
```

- [ ] **Step 5: Verify gates**

Run: `npm test && npm run build && npm run lint`
Expected: tests PASS, build clean, lint adds no new warnings (the sentence-case rule: "Open Community plugins" and "update available" are sentence case; "Community plugins" matches Obsidian's own tab name).

- [ ] **Step 6: Commit**

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat: surface self update-available advisory in pane and pills"
```

---

### Task 4: section head counts + dead self-in-outdated code

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`rowStageable` ~line 440, `renderSection` ~line 1457, `renderItemDetail` ~line 1662)

**Interfaces:**
- Consumes: nothing new. No signature changes; view-internal only.

- [ ] **Step 1: `renderSection` count semantics**

Replace lines ~1457-1461:

```ts
    const insync = matches.filter((r) => this.presState(r) === "in-sync");
    const checkable = matches.filter((r) => this.rowStageable(r));
    const countText = this.searching() ? `${matches.length} of ${rows.length}` : `${rows.length - insync.length}`;
    head.createSpan({ cls: "config-sync-pill is-neutral", text: countText });
    if (insync.length > 0) head.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${insync.length}` });
```

with:

```ts
    const checkable = matches.filter((r) => this.rowStageable(r));
    // Unified rule (spec 2026-07-17): every row in these sections carries an action payload —
    // content-in-sync is the NORMAL case for update-only/enable-only/install-only rows, so the
    // head counts rows, not content drift, and never shows a ✓ pill (a green check would
    // mislabel a row that still needs an update/enable/install). Same semantics as the
    // desktop-only info section.
    const countText = this.searching() ? `${matches.length} of ${rows.length}` : `${rows.length}`;
    head.createSpan({ cls: "config-sync-pill is-neutral", text: countText });
```

- [ ] **Step 2: delete the unreachable self guard in `rowStageable`**

`rows()` skips `SELF_GROUP_NAME` before any section bucketing, so the guard can never fire. Replace the method (~lines 440-447) with:

```ts
  // Section-aware stageability: action-only rows (install-only / enable-only / update-only)
  // stage in their sections. (The self group never reaches here — rows() excludes it; its
  // update-available case is the pane advisory instead.)
  private rowStageable(r: StatusRow): boolean {
    return stageableRow(this.presState(r), this.sectionOf(r.group.name));
  }
```

- [ ] **Step 3: delete the unreachable self note in `renderItemDetail`**

Inside the `if (sec === "outdated") {` branch (~line 1662), remove only the inner block:

```ts
        if (r.group.name === SELF_GROUP_NAME) {
          detail.createDiv({
            cls: "config-sync-expand-note",
            text: "Config Sync updates itself through Obsidian's plugin updater — Settings → Community plugins.",
          });
          return;
        }
```

The rest of the branch (version line + "no content changes — updates the plugin only" + policy segment) stays. If `SELF_GROUP_NAME` is now unused in this file, drop it from the import; it is still used elsewhere (`rows()`, `runSelfCapture`, `diffPair`, line ~1849), so expect NO import change — verify with a grep before touching the import.

- [ ] **Step 4: Verify gates**

Run: `npm test && npm run build && npm run lint`
Expected: tests PASS, build clean, no new lint warnings.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SyncCenterView.ts
git commit -m "fix: section heads count actionable rows; drop unreachable self-in-outdated branches"
```

---

### Task 5: docs currency

**Files:**
- Modify: `README.md` (lines 23, 82), `README.zh.md` (lines 23, 82), `docs/ARCHITECTURE.md` (self-pane bullet, ~line 154 area)

**Interfaces:** none — prose only.

- [ ] **Step 1: README.md**

Line 23, extend the chip parenthetical: `(a green check when everything is in sync, an orange *update available* when this device's Config Sync is older than the version the store was captured on, otherwise the current state and a shortcut into settings)`.

Line 82, extend the chip sentence the same way: `— a green check when in sync, an orange *update available* when this device runs an older Config Sync than the store was captured on (the pane then points at **Community plugins** to update first), otherwise its state plus a Settings shortcut —`.

- [ ] **Step 2: README.zh.md**

Line 23, the counterpart parenthetical becomes: `（全部 in sync 时显示绿色对勾;当本设备的 Config Sync 比 store 捕获时的版本旧时显示橙色 *update available*;否则显示当前状态并提供进入设置的快捷入口）`.

Line 82, the counterpart dash clause becomes: `——in sync 时显示绿色对勾;当本设备运行的 Config Sync 比 store 捕获时的版本旧时显示橙色 *update available*(面板会提示先到 **Community plugins** 更新);否则显示其状态并提供一个 Settings 快捷入口——`.

Match the file's existing punctuation style (full-width;/() as used in the surrounding sentence — inspect the exact line before editing).

- [ ] **Step 3: docs/ARCHITECTURE.md**

In the self-pane / `selfListGroups` bullet area (~line 154), append one sentence to the paragraph describing the self pane: `selfPaneState also reports an orthogonal versionBehind advisory (this device's plugin older than the store's captured version) — surfaced as the pane's update-available block and the orange is-behind pill; it never becomes a stageable action, since updating config-sync mid-run would unload the running code.`

- [ ] **Step 4: Verify + commit**

Run: `npm run lint`
Expected: no new warnings (docs-only change; lint covers the repo config).

```bash
git add README.md README.zh.md docs/ARCHITECTURE.md
git commit -m "docs: document self update-available advisory"
```
