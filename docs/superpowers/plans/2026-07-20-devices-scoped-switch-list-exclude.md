# Device-scoped plugins auto-excluded from the enabled-plugins switch list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin whose Config Sync group is scoped to a device class that excludes the current device (`devices:"desktop"` on mobile, `devices:"mobile"` on desktop) is auto-excepted from the `community-plugins.json` enabled-plugins switch list, and appears in the settings "Excluded from this list" panel exactly like an author-declared desktop-only plugin.

**Architecture:** One new pure core helper (`deviceExcludedPluginIds`) and one new pure UI-ordering helper pair (`switchRowBucket` / `orderSwitchRows`), each TDD'd in isolation. Then a wiring task in `main.ts` (symmetric `augmentedSwitchExceptions`, `deviceScoped` field on `switchListRows`) and a rendering task in `SettingTab.ts` + one CSS rule. A final live-verification task on the dev vault.

**Tech Stack:** TypeScript, vitest, esbuild. Obsidian plugin.

## Global Constraints

- Colors: theme vars only; `rgba(var(--*-rgb), α)` for alpha; no hex/rgb literals. Device-scoped rows reuse the existing orange `is-auto` / `config-sync-doto-pill` treatment — NO new color or class.
- Pill text on mobile is always `desktop-only` (covers desktop-only + device-scoped); the symmetric desktop `devices:"mobile"` case reads `mobile-only` via `${boundDevice}-only`, `boundDevice = Platform.isMobile ? "desktop" : "mobile"`.
- Bucket order (top → bottom), alphabetical within a bucket: `desktop-only` → `device-scoped` → `excluded` (manual) → `included`. Auto-exclusion outranks a manual exception when both apply.
- `desktopOnly` detection stays mobile-only; `deviceScoped` is computed on both platforms and only for the `community-plugins` list.
- Gates for every task: `npx tsc -noEmit -skipLibCheck` clean, `npm test` green, `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No Claude/AI attribution in any commit message.

---

### Task 1: `deviceExcludedPluginIds` core helper

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (add exported function after `groupsForDevice`, ends line 78)
- Test: `tests/core.test.ts` (add a `describe` block; extend the existing import from `"../src/core/ConfigSyncCore"`)

**Interfaces:**
- Consumes: `SyncGroup` (`src/core/types.ts`), existing `pluginIdForGroup(group: SyncGroup): string | null`.
- Produces: `deviceExcludedPluginIds(groups: SyncGroup[], device: "desktop" | "mobile"): Set<string>`.

- [ ] **Step 1: Write the failing test.** In `tests/core.test.ts`, add `deviceExcludedPluginIds` to the existing import from `"../src/core/ConfigSyncCore"`, then append:

```ts
describe("deviceExcludedPluginIds", () => {
  const pg = (id: string, devices: "all" | "desktop" | "mobile"): SyncGroup => ({
    name: `plugin-${id}`,
    path: `{configDir}/plugins/${id}/data.json`,
    type: "file",
    devices,
  });
  const appGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "desktop" };
  const groups = [pg("vim-toggle", "desktop"), pg("mobile-only-thing", "mobile"), pg("dataview", "all"), appGroup];

  it("on mobile, names plugins whose group is scoped to desktop", () => {
    expect(deviceExcludedPluginIds(groups, "mobile")).toEqual(new Set(["vim-toggle"]));
  });

  it("on desktop, names plugins whose group is scoped to mobile", () => {
    expect(deviceExcludedPluginIds(groups, "desktop")).toEqual(new Set(["mobile-only-thing"]));
  });

  it("never names devices:'all' plugins or app-anchored (non-plugin) groups", () => {
    const ids = deviceExcludedPluginIds(groups, "mobile");
    expect(ids.has("dataview")).toBe(false); // devices:'all'
    expect(ids.has("hotkeys")).toBe(false); // app-anchored: pluginIdForGroup is null
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/core.test.ts -t "deviceExcludedPluginIds"` — Expected: FAIL (`deviceExcludedPluginIds is not a function` / import error).

- [ ] **Step 3: Implement.** In `src/core/ConfigSyncCore.ts`, immediately after the `groupsForDevice` function (closing brace at line 78), add:

```ts
// Plugin ids whose group is scoped to a device class that excludes `device`
// (devices:"desktop" on a mobile device, devices:"mobile" on desktop). On a device they are
// scoped away from, they must never be captured out of — or forced into — the shared
// enabled-plugins switch list; they simply do not belong to this device.
export function deviceExcludedPluginIds(groups: SyncGroup[], device: "desktop" | "mobile"): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    if (g.devices === "all" || g.devices === device) continue;
    const id = pluginIdForGroup(g);
    if (id !== null) ids.add(id);
  }
  return ids;
}
```

(If `SyncGroup` is not already imported in `ConfigSyncCore.ts`, it is — `pluginIdForGroup` above uses it. No new import needed.)

- [ ] **Step 4: Run tests.** Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/core.test.ts` — Expected: ALL PASS.

- [ ] **Step 5: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npx eslint . && ./scripts/check-no-hardcoded-color.sh` — Expected: tsc clean, eslint 0 errors / 67 warnings, color check OK.

- [ ] **Step 6: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/core/ConfigSyncCore.ts tests/core.test.ts && git commit -m "feat: deviceExcludedPluginIds core helper"
```

---

### Task 2: `switchRowBucket` / `orderSwitchRows` pure ordering helpers

**Files:**
- Modify: `src/ui/panelModel.ts` (add exported types + functions at end)
- Test: `tests/panelModel.test.ts` (extend the existing import from `"../src/ui/panelModel"`)

**Interfaces:**
- Produces:
  - `type SwitchRow = { id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean }`
  - `type SwitchRowBucket = "desktop-only" | "device-scoped" | "excluded" | "included"`
  - `type OrderedSwitchRow = SwitchRow & { bucket: SwitchRowBucket }`
  - `switchRowBucket(row: SwitchRow, isManual: boolean): SwitchRowBucket`
  - `orderSwitchRows(rows: SwitchRow[], manualIds: Set<string>): OrderedSwitchRow[]`
- Consumed by: Task 3 (`switchListRows` returns `SwitchRow`-shaped rows) and Task 4 (`renderLocalDecisions`).

- [ ] **Step 1: Write the failing test.** In `tests/panelModel.test.ts`, add `switchRowBucket`, `orderSwitchRows`, and the type `SwitchRow` to the existing import from `"../src/ui/panelModel"`, then append:

```ts
describe("switchRowBucket / orderSwitchRows", () => {
  const row = (id: string, o: Partial<{ desktopOnly: boolean; deviceScoped: boolean }> = {}): SwitchRow => ({
    id,
    name: id,
    hint: "",
    desktopOnly: o.desktopOnly ?? false,
    deviceScoped: o.deviceScoped ?? false,
  });

  it("classifies by precedence: desktop-only > device-scoped > manual > included", () => {
    expect(switchRowBucket(row("a", { desktopOnly: true }), false)).toBe("desktop-only");
    expect(switchRowBucket(row("b", { deviceScoped: true }), false)).toBe("device-scoped");
    expect(switchRowBucket(row("c"), true)).toBe("excluded");
    expect(switchRowBucket(row("d"), false)).toBe("included");
  });

  it("auto-exclusion outranks a manual exception when both apply", () => {
    expect(switchRowBucket(row("a", { desktopOnly: true }), true)).toBe("desktop-only");
    expect(switchRowBucket(row("b", { deviceScoped: true }), true)).toBe("device-scoped");
  });

  it("orders into four blocks, alphabetical within a block", () => {
    const rows = [
      row("Zebra"),
      row("Vimrc", { deviceScoped: true }),
      row("Better PDF", { desktopOnly: true }),
      row("Apple"),
      row("Obsidian Git", { deviceScoped: true }),
      row("Quick Explorer", { desktopOnly: true }),
    ];
    const manual = new Set(["Apple"]);
    const ordered = orderSwitchRows(rows, manual);
    expect(ordered.map((r) => `${r.bucket}:${r.name}`)).toEqual([
      "desktop-only:Better PDF",
      "desktop-only:Quick Explorer",
      "device-scoped:Obsidian Git",
      "device-scoped:Vimrc",
      "excluded:Apple",
      "included:Zebra",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/panelModel.test.ts -t "switchRowBucket"` — Expected: FAIL (not exported).

- [ ] **Step 3: Implement.** At the end of `src/ui/panelModel.ts`, add:

```ts
export type SwitchRow = { id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean };
export type SwitchRowBucket = "desktop-only" | "device-scoped" | "excluded" | "included";
export type OrderedSwitchRow = SwitchRow & { bucket: SwitchRowBucket };

// Bucket precedence for the settings "Excluded from this list" panel. Auto-exclusion
// (desktop-only, then device-scoped) outranks a manual exclude even when a plugin is both —
// a desktop-only / device-scoped plugin's exclusion is not the user's to toggle.
const SWITCH_BUCKET_ORDER: SwitchRowBucket[] = ["desktop-only", "device-scoped", "excluded", "included"];

export function switchRowBucket(row: SwitchRow, isManual: boolean): SwitchRowBucket {
  if (row.desktopOnly) return "desktop-only";
  if (row.deviceScoped) return "device-scoped";
  if (isManual) return "excluded";
  return "included";
}

export function orderSwitchRows(rows: SwitchRow[], manualIds: Set<string>): OrderedSwitchRow[] {
  return rows
    .map((r) => ({ ...r, bucket: switchRowBucket(r, manualIds.has(r.id)) }))
    .sort(
      (a, b) =>
        SWITCH_BUCKET_ORDER.indexOf(a.bucket) - SWITCH_BUCKET_ORDER.indexOf(b.bucket) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}
```

- [ ] **Step 4: Run tests.** Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/panelModel.test.ts` — Expected: ALL PASS.

- [ ] **Step 5: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npx eslint .` — Expected: tsc clean, eslint 0 errors / 67 warnings.

- [ ] **Step 6: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/panelModel.ts tests/panelModel.test.ts && git commit -m "feat: switchRowBucket/orderSwitchRows ordering helpers"
```

---

### Task 3: Wire the core into `main.ts` (symmetric exceptions + `deviceScoped` field)

**Files:**
- Modify: `src/main.ts` — import (line 14 area), `augmentedSwitchExceptions` (lines 881-901), `switchListRows` (lines 1080-1120)
- Modify: `src/ui/SettingTab.ts` — the `switchListRows` return type in the `SettingsHost` interface (line 59)

**Interfaces:**
- Consumes: `deviceExcludedPluginIds` (Task 1), existing `desktopOnlyPluginIds`, `Platform.isMobile`.
- Produces: `switchListRows(...)` now returns `{ id; name; hint; desktopOnly: boolean; deviceScoped: boolean }[]` (structurally the `SwitchRow` of Task 2, consumed by Task 4).

- [ ] **Step 1: Import the helper.** In `src/main.ts`, add `deviceExcludedPluginIds` to the existing import from `"./core/ConfigSyncCore"` (the block that already imports `groupsForDevice` around line 14).

- [ ] **Step 2: Rewrite `augmentedSwitchExceptions`.** Replace the whole method body (lines 881-901) with:

```ts
  private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>> {
    const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    // Plugins the user scoped away from this device (devices:"desktop" on mobile,
    // devices:"mobile" on desktop): never capture them out of / force them into the shared
    // enabled list here. Symmetric — applies on both platforms.
    const extraIds = deviceExcludedPluginIds(this.settings.groups, device);
    // Desktop-only detection is mobile-only: that is where a desktop-only plugin can't run and
    // would otherwise be dropped. On desktop the plugin runs and its enable/disable syncs normally.
    if (Platform.isMobile) {
      const io = this.configIO();
      const lockPath = `${rootPath}/store.lock.json`;
      let lock: StoreLock | null = null;
      if (await io.exists(lockPath)) {
        try {
          lock = parseStoreLock(await io.read(lockPath));
        } catch {
          lock = null;
        }
      }
      for (const id of desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock)) extraIds.add(id);
    }
    if (extraIds.size === 0) return this.settings.switchExceptions;
    const manual = this.settings.switchExceptions["community-plugins"] ?? [];
    return { ...this.settings.switchExceptions, "community-plugins": [...new Set([...manual, ...extraIds])] };
  }
```

- [ ] **Step 3: Add `deviceScoped` to `switchListRows`.** In `src/main.ts`, change the method signature (line 1080) from:

```ts
  async switchListRows(groupName: string): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean }[]> {
```

to:

```ts
  async switchListRows(groupName: string): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean }[]> {
```

Then, immediately after the `dtoIds` block (the `if (Platform.isMobile && groupName === "community-plugins") { ... dtoIds = desktopOnlyPluginIds(...); }` ending at line 1107), add:

```ts
    let devScopedIds = new Set<string>();
    if (groupName === "community-plugins") {
      const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
      devScopedIds = deviceExcludedPluginIds(this.settings.groups, device);
    }
```

Then in the `.map(...)` object (currently ending with `desktopOnly: dtoIds.has(id),`), add the new field so it reads:

```ts
        desktopOnly: dtoIds.has(id),
        deviceScoped: devScopedIds.has(id),
```

(Leave the trailing `.sort((a, b) => a.name.localeCompare(...))` unchanged — it is the stable base order; Task 4 applies the bucket order.)

- [ ] **Step 4: Update the host interface.** In `src/ui/SettingTab.ts` line 59, change:

```ts
  switchListRows(group: string): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean }[]>;
```

to:

```ts
  switchListRows(group: string): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean }[]>;
```

- [ ] **Step 5: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npm test && npx eslint . && npm run build` — Expected: tsc clean, all tests green, eslint 0 errors / 67 warnings, build clean. (No new unit test here — this is wiring of already-tested pure helpers into Obsidian-API code; behavior is verified live in Task 5. `tsc` proves the interface/return-type threading is consistent.)

- [ ] **Step 6: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/main.ts src/ui/SettingTab.ts && git commit -m "feat: device-scoped plugins auto-excepted from the enabled-plugins switch list"
```

---

### Task 4: Render the four ordered blocks in the settings panel

**Files:**
- Modify: `src/ui/SettingTab.ts` — `renderLocalDecisions` (lines 564-612); add `orderSwitchRows`/`OrderedSwitchRow` + `Platform` imports
- Modify: `styles.css` — one rule near the `.config-sync-ldrow` block (line 1039)

**Interfaces:**
- Consumes: `orderSwitchRows`, `OrderedSwitchRow` (Task 2); `switchListRows` return shape with `deviceScoped` (Task 3); Obsidian `Platform`, `ToggleComponent`.

- [ ] **Step 1: Imports.** In `src/ui/SettingTab.ts`, add `orderSwitchRows` and `OrderedSwitchRow` to the existing import from `"./panelModel"`. Ensure `Platform` is imported from `"obsidian"` (add it to the existing `obsidian` import if absent — `ToggleComponent` is already imported).

- [ ] **Step 2: Rewrite `renderLocalDecisions`.** Replace the entire method (lines 564-612) with:

```ts
  private renderLocalDecisions(exp: HTMLElement, group: SyncGroup, wrap: HTMLElement, item: CatalogItem): void {
    exp.createDiv({ cls: "config-sync-explabel", text: "Excluded from this list (this device)" });
    exp.createDiv({
      cls: "config-sync-expdesc",
      text: "Excluded plugins keep their own on/off state on this device — the shared list neither includes nor changes them.",
    });
    const listEl = exp.createDiv({ cls: "config-sync-ldlist" });
    void this.host.switchListRows(group.name).then((rows) => {
      // The device this list belongs to when it's scoped away from us (mobile → "desktop").
      const boundDevice = Platform.isMobile ? "desktop" : "mobile";
      const renderRows = (): void => {
        listEl.empty();
        const exceptions = new Set(this.host.settings.switchExceptions[group.name] ?? []);
        const ordered = orderSwitchRows(rows, exceptions);
        let prevBucket: OrderedSwitchRow["bucket"] | null = null;
        for (const r of ordered) {
          const gsep = prevBucket !== null && r.bucket !== prevBucket;
          prevBucket = r.bucket;
          if (r.bucket === "desktop-only" || r.bucket === "device-scoped") {
            const rowEl = listEl.createDiv({ cls: `config-sync-ldrow is-auto${gsep ? " config-sync-ldrow-gsep" : ""}` });
            rowEl.setAttribute(
              "title",
              r.bucket === "desktop-only"
                ? "Excluded automatically — this plugin can't run on this device"
                : `Excluded automatically — you set this plugin to devices: ${boundDevice}`,
            );
            rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
            rowEl.createSpan({
              cls: "config-sync-doto-pill",
              text: r.bucket === "desktop-only" ? "desktop-only" : `${boundDevice}-only`,
            });
            rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
            rowEl.createDiv({ cls: "config-sync-rule-spacer" });
            rowEl.createSpan({ cls: "config-sync-ldstate", text: "auto-excluded" });
            new ToggleComponent(rowEl).setValue(true).setDisabled(true);
            continue;
          }
          const isLocal = r.bucket === "excluded";
          const rowEl = listEl.createDiv({
            cls: `config-sync-ldrow${isLocal ? " is-local" : ""}${gsep ? " config-sync-ldrow-gsep" : ""}`,
          });
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          rowEl.createSpan({ cls: "config-sync-ldstate", text: isLocal ? "excluded" : "included" });
          new ToggleComponent(rowEl).setValue(isLocal).onChange(async (v) => {
            const cur = new Set(this.host.settings.switchExceptions[group.name] ?? []);
            if (v) cur.add(r.id);
            else cur.delete(r.id);
            this.host.settings.switchExceptions[group.name] = [...cur].sort();
            await this.host.saveSettings();
            const badge = wrap.querySelector<HTMLElement>(".config-sync-exbadge");
            if (badge !== null) {
              badge.setText(`${cur.size} excluded`);
              if (cur.size > 0) badge.show();
              else badge.hide();
            }
            // Re-sort the already-fetched rows so the toggled plugin jumps to/from the
            // "excluded" block. No refetch, no async — no flash.
            renderRows();
          });
        }
      };
      renderRows();
    });
  }
```

- [ ] **Step 3: Add the group-separation CSS rule.** In `styles.css`, immediately after the `.config-sync-ldrow { ... }` block (closing brace at line 1047), add:

```css
.config-sync-ldrow-gsep { margin-top: var(--size-4-3); }
```

- [ ] **Step 4: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npm test && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build` — Expected: tsc clean, tests green, eslint 0 errors / 67 warnings, color check OK, build clean.

- [ ] **Step 5: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/SettingTab.ts styles.css && git commit -m "feat: order the exclude list into desktop-only/device-scoped/excluded/included blocks"
```

---

### Task 5: Live verification (dev vault)

**Files:** none (verification only).

- [ ] **Step 1: Deploy + reload.** `cd ~/local/coding/open/obsidian-config-sync && cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`, then reload the plugin (obsidian-cli command from `dev/vault/`, or disable/enable in the dev vault).

- [ ] **Step 2: Forge a device-scoped group.** Pick a cross-platform community plugin present in the dev vault (one that is NOT desktop-only-by-manifest, e.g. a dataview-like plugin) and set its Config Sync group's `devices` to `"desktop"` via plugin settings (or by editing the persisted `settings.groups` through `obsidian-cli eval` and re-reading). Confirm `deviceExcludedPluginIds(settings.groups, "desktop")` returns that id via `obsidian-cli eval`.

- [ ] **Step 3: Verify the settings panel.** Force mobile CSS in the dev vault (`document.body.classList.add("is-mobile")` via `obsidian-cli eval` — note this only forces CSS, not `Platform.isMobile`; the row-classification path is data-driven off `deviceScoped`, which is computed for both platforms, so it is exercisable on desktop). Open the Config Sync settings → the group's "Excluded from this list" panel and assert, via reading the rendered DOM (`obsidian-cli eval` querying `.config-sync-ldlist`): the forged plugin renders as a `config-sync-ldrow is-auto` row with a `config-sync-doto-pill`, `auto-excluded` state, disabled toggle, and sits in the device-scoped block (after any desktop-only rows, before manual `is-local` rows). Confirm the four buckets appear in order with `config-sync-ldrow-gsep` on each block's first row.

- [ ] **Step 4: Verify the capture diff.** Confirm via `obsidian-cli eval` that `augmentedSwitchExceptions(rootPath)["community-plugins"]` includes the forged plugin id, so a capture would not strike it from `community-plugins.json`.

- [ ] **Step 5: Reset.** Restore the forged group's `devices` back to `"all"` and remove the injected `is-mobile` class.

---

## Self-Review

**Spec coverage:**
- Core `deviceExcludedPluginIds` → Task 1. ✓
- Symmetric `augmentedSwitchExceptions` → Task 3 Step 2. ✓
- `switchListRows` `deviceScoped` field + host interface → Task 3 Steps 3-4. ✓
- Ordering helpers → Task 2. ✓
- Four-block render, pill text (`${boundDevice}-only`), tooltip split, `renderRows()` re-sort, `is-auto` reuse → Task 4 Step 2. ✓
- CSS `.config-sync-ldrow-gsep` → Task 4 Step 3. ✓
- Edge cases (desktop-only ∧ device-scoped → desktop-only; auto ∧ manual → auto; symmetric desktop `mobile-only`; core-plugins unaffected) → encoded in `switchRowBucket` precedence (Task 2) + `deviceScoped` gated to community-plugins (Task 3 Step 3). ✓
- Live verification → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after with complete code. ✓

**Type consistency:** `deviceExcludedPluginIds(groups, "desktop"|"mobile"): Set<string>` (Task 1) consumed in Task 3 Steps 2-3. `SwitchRow`/`OrderedSwitchRow`/`switchRowBucket`/`orderSwitchRows` (Task 2) consumed in Task 4. `switchListRows` return `{id,name,hint,desktopOnly,deviceScoped}` (Task 3) is structurally `SwitchRow` (Task 2) and matches the host interface (Task 3 Step 4) and Task 4's consumption. `boundDevice`/pill/tooltip strings consistent between spec and Task 4. ✓
