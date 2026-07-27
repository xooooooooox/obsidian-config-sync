# Scope Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One scope vocabulary (All devices / Desktop only / Mobile only / This device) across the three switch lists and the fields drawer, replacing Excluded/Pinned/Active-on/Strip — zero store-format change.

**Architecture:** The snippets machinery (scope tags + local pins + force-off) is already the full engine; this generalizes it to all switch lists. Settings rename `switchExceptions`→`memberLocal`, `snippetScopes`→`memberScopes` (per-group nesting) with a one-time pure migration; runtime mask/force-off composition in main.ts becomes per-group; one unified "Device scope" drawer renderer replaces the two divergent ones.

**Tech Stack:** TypeScript Obsidian plugin, esbuild, vitest-style unit tests in `tests/`, eslint (67-warning baseline).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-scope-unification-design.md`; mockup `scope-unify-mockup.html` (定稿 2026-07-24) is binding for UI structure and copy.
- **No git commits** — changes stay uncommitted (repo review-state convention). Task steps therefore end at "tests pass", never "commit".
- Gates for every task: `npm test`, `npm run build`, `npm run lint` (lint must stay at the 67-warning baseline, zero errors).
- Dropdown copy, verbatim: `All devices` / `Desktop only` / `Mobile only` / `This device`; auto rows: `Desktop only (auto)` / `Mobile only (auto)`.
- Drawer heading `Device scope`; description verbatim: `All devices — synced everywhere · Desktop/Mobile only — only enabled on that device class (shared, travels) · This device — keeps its own on/off here, never synced.`
- Badges, verbatim: `N device-scoped` and `N this-device`.
- Fields drawer heading `Field rules`; description verbatim: `This device — the field never enters the store and keeps its local value. Encrypted — the field syncs, but is encrypted in the store.`; dropdown labels `This device` / `Encrypted` — **serialized `FieldRule.action` values stay `"strip"`/`"encrypt"`, unchanged**.
- Auto-derived exclusions (desktop-only manifest ids on mobile; plugin groups with a non-matching `devices` class) are **mask-only, never force-off**. Force-off applies only to explicit `memberScopes` entries, minus `memberLocal` ids (local wins).
- `CoreContext` field names `switchExceptions` / `switchForceOff` / `switchLocalDecisions` / `addSwitchExceptions` stay unchanged (runtime mask concepts); only the persisted settings rename.
- Zero store-format change. No behavior change for existing configurations (migration maps old semantics 1:1).
- New tests match the existing framework and import style of the test file they land in.

---

### Task 1: Pure core layer — force-off map support, member-scope helpers, settings migration, self preset

**Files:**
- Modify: `src/core/switchList.ts:102-108` (subtractForceOff)
- Modify: `src/core/availability.ts:96-110` (rename + generalize the two snippet helpers)
- Create: `src/core/settingsMigration.ts`
- Modify: `src/core/catalog.ts:382-388` (selfPresetRules)
- Test: `tests/switchList.test.ts`, `tests/availability.test.ts`, `tests/settingsMigration.test.ts` (new), `tests/catalog.test.ts`

**Interfaces:**
- Consumes: existing `SwitchList` type, `FieldRule` type.
- Produces (used by Tasks 2–3):
  - `subtractForceOff(list: SwitchList, forceOff: string[]): SwitchList` — arrays: remove ids; maps: set existing keys to `false`.
  - `scopedAwayMembers(scopes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string>` (rename of `scopedAwaySnippets`, same body).
  - `memberForceOff(scopes: Record<string, "desktop" | "mobile">, localIds: string[], isMobile: boolean): string[]` (rename of `snippetForceOff`; `pins` param renamed `localIds`).
  - `migrateMemberSettings(raw: Record<string, unknown>): Record<string, unknown>` — pure, returns a new object.

- [ ] **Step 1: Write the failing tests**

Append to `tests/switchList.test.ts`:

```ts
describe("subtractForceOff on maps", () => {
  it("sets forced-off keys to false and leaves others untouched", () => {
    expect(subtractForceOff({ a: true, b: true }, ["b"])).toEqual({ a: true, b: false });
  });
  it("ignores ids absent from the map", () => {
    expect(subtractForceOff({ a: true }, ["zz"])).toEqual({ a: true });
  });
  it("returns the list unchanged when forceOff is empty", () => {
    const m = { a: true };
    expect(subtractForceOff(m, [])).toBe(m);
  });
});
```

In `tests/availability.test.ts`, rename existing `scopedAwaySnippets`/`snippetForceOff` test references to the new names (same assertions) and add:

```ts
describe("scopedAwayMembers / memberForceOff", () => {
  it("returns members whose scope excludes this device class", () => {
    const scopes: Record<string, "desktop" | "mobile"> = { a: "desktop", b: "mobile" };
    expect(scopedAwayMembers(scopes, false)).toEqual(new Set(["b"]));
    expect(scopedAwayMembers(scopes, true)).toEqual(new Set(["a"]));
  });
  it("local ids win over a travelling scope — never forced off", () => {
    expect(memberForceOff({ a: "mobile", b: "mobile" }, ["b"], false)).toEqual(["a"]);
  });
});
```

Create `tests/settingsMigration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { migrateMemberSettings } from "../src/core/settingsMigration";

describe("migrateMemberSettings", () => {
  it("renames switchExceptions to memberLocal and nests snippetScopes under enabled-css-snippets", () => {
    const out = migrateMemberSettings({
      switchExceptions: { "community-plugins": ["a"] },
      snippetScopes: { "m.css": "mobile" },
      other: 1,
    });
    expect(out.memberLocal).toEqual({ "community-plugins": ["a"] });
    expect(out.memberScopes).toEqual({ "enabled-css-snippets": { "m.css": "mobile" } });
    expect(out.switchExceptions).toBeUndefined();
    expect(out.snippetScopes).toBeUndefined();
    expect(out.other).toBe(1);
  });
  it("never overwrites existing new keys, still drops old keys", () => {
    const out = migrateMemberSettings({
      memberLocal: { g: ["keep"] },
      memberScopes: { "enabled-css-snippets": { s: "desktop" } },
      switchExceptions: { g: ["stale"] },
      snippetScopes: { s2: "mobile" },
    });
    expect(out.memberLocal).toEqual({ g: ["keep"] });
    expect(out.memberScopes).toEqual({ "enabled-css-snippets": { s: "desktop" } });
    expect(out.switchExceptions).toBeUndefined();
    expect(out.snippetScopes).toBeUndefined();
  });
  it("creates no memberScopes from an empty snippetScopes", () => {
    const out = migrateMemberSettings({ snippetScopes: {} });
    expect(out.memberScopes).toBeUndefined();
    expect(out.snippetScopes).toBeUndefined();
  });
  it("does not mutate its input", () => {
    const raw: Record<string, unknown> = { switchExceptions: { g: ["a"] } };
    migrateMemberSettings(raw);
    expect(raw.switchExceptions).toEqual({ g: ["a"] });
  });
});
```

(If the repo's tests import from `vitest` differently or use globals, match the neighboring files.)

In `tests/catalog.test.ts`, find the existing `selfPresetRules` assertion and extend it (or add):

```ts
it("selfPresetRules strips memberLocal alongside the legacy keys", () => {
  expect(selfPresetRules().map((r) => r.pattern)).toEqual(["rootPath", "remotes", "switchExceptions", "memberLocal"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `scopedAwayMembers`/`memberForceOff` not exported, `settingsMigration` module missing, map force-off returns unchanged map, preset list has 3 entries.

- [ ] **Step 3: Implement**

`src/core/switchList.ts` — replace `subtractForceOff` (keep its comment block, updated):

```ts
// Remove force-off ids from an applied list: user class scopes enforced on the wrong device
// class. Arrays drop the id; maps set an EXISTING key to false (an absent key is already off).
// Empty force-off passes through unchanged. Shared by applyGroup and diffPair so the diff
// preview provably mirrors what apply writes.
export function subtractForceOff(list: SwitchList, forceOff: string[]): SwitchList {
  if (forceOff.length === 0) return list;
  if (Array.isArray(list)) {
    const off = new Set(forceOff);
    return list.filter((id) => !off.has(id));
  }
  const result: Record<string, boolean> = { ...list };
  for (const id of forceOff) if (id in result) result[id] = false;
  return result;
}
```

`src/core/availability.ts` — rename the two functions (group-agnostic comments; bodies unchanged except the param rename):

```ts
// Member names whose shared scope excludes the current device class. Feeds the exception mask
// (capture pass-through + compare masking) exactly like desktopOnlyPluginIds does for plugins.
export function scopedAwayMembers(scopes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string> {
  const want = isMobile ? "mobile" : "desktop";
  const out = new Set<string>();
  for (const [name, scope] of Object.entries(scopes)) if (scope !== want) out.add(name);
  return out;
}

// The apply must force OFF members scoped away from this device — scope-away minus This-device
// ids, since an explicit local decision (local > scope) must keep the machine's own on/off.
export function memberForceOff(scopes: Record<string, "desktop" | "mobile">, localIds: string[], isMobile: boolean): string[] {
  const localSet = new Set(localIds);
  return [...scopedAwayMembers(scopes, isMobile)].filter((id) => !localSet.has(id));
}
```

Delete the old `scopedAwaySnippets`/`snippetForceOff` names (main.ts callers break until Task 2 — to keep this task green, update the two import sites mechanically now: `src/main.ts` imports and its three call sites at `main.ts:943`, `main.ts:949`, `main.ts:1164` switch to the new names with the same arguments).

Create `src/core/settingsMigration.ts`:

```ts
/**
 * One-time settings migration for the scope unification (2026-07-24 spec):
 * - switchExceptions (group -> device-local ids) renames to memberLocal
 * - snippetScopes (snippet -> class) nests under memberScopes["enabled-css-snippets"]
 * Each pair migrates independently and idempotently: an existing new key is never rebuilt,
 * and the old keys are always dropped so the next save cleans data.json.
 * Pure — returns a new object, never mutates the input.
 */
export function migrateMemberSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (out.memberLocal === undefined && out.switchExceptions !== undefined) {
    out.memberLocal = out.switchExceptions;
  }
  const scopes = out.snippetScopes;
  if (out.memberScopes === undefined && typeof scopes === "object" && scopes !== null && Object.keys(scopes).length > 0) {
    out.memberScopes = { "enabled-css-snippets": scopes };
  }
  delete out.switchExceptions;
  delete out.snippetScopes;
  return out;
}
```

`src/core/catalog.ts` — `selfPresetRules()` gains one entry after `switchExceptions` (the legacy strip stays: pre-migration data.json copies still carry the old key and it must never travel):

```ts
export function selfPresetRules(): FieldRule[] {
  return [
    { pattern: "rootPath", action: "strip", locked: true },
    { pattern: "remotes", action: "strip", locked: true },
    { pattern: "switchExceptions", action: "strip", locked: true },
    { pattern: "memberLocal", action: "strip", locked: true },
  ];
}
```

Note: Task 1 must NOT touch `settings.snippetScopes`/`settings.switchExceptions` reads in main.ts beyond the three renamed call sites' function names — the settings rename is Task 2.

- [ ] **Step 4: Run gates**

Run: `npm test && npm run build && npm run lint`
Expected: all tests PASS, build OK, lint at baseline (67 warnings, 0 errors). If other tests still reference the old availability names, update those references too (assertions unchanged).

---

### Task 2: Settings rename + per-group mask/force-off wiring (main.ts, panelModel, mechanical SettingTab swaps)

**Files:**
- Modify: `src/main.ts` — settings interface (`:62-63`), `DEFAULT_SETTINGS` (`:88-89`), `loadSettings` (`:1330-1343`), diff-side force-off (`:490`), `switchLocalDecisions` (`:502`), `addSwitchExceptions` (`:530-536`), `augmentedSwitchExceptions` (`:917-945`), `snippetForceOffIds` (`:947-950`), `coreContext.switchForceOff` (`:966-971`), `switchListRows` (`:1159-1221`), `removeSnippetOrphans` (`:1246-1263`)
- Modify: `src/ui/panelModel.ts:101-115` (`SwitchRow`, `switchRowBucket`)
- Modify: `src/ui/SettingTab.ts` — `SettingsHost` (`:48-49`, `:74`) + mechanical reference swaps (UI structure untouched; the rewrite is Task 3)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes (Task 1): `scopedAwayMembers`, `memberForceOff`, `migrateMemberSettings`, map-aware `subtractForceOff`.
- Produces (Task 3 relies on): settings fields `memberScopes: Record<string, Record<string, "desktop" | "mobile">>` and `memberLocal: Record<string, string[]>`; `SwitchRow` gains `userScoped: boolean`; host method signature `switchListRows(group): Promise<{ id; name; hint; desktopOnly; deviceScoped; userScoped }[]>`; private helpers `memberScopesFor(group: string)` / `memberLocalFor(group: string)` / `memberForceOffIds(group: string)` on the plugin class.

- [ ] **Step 1: Write the failing test**

Append to `tests/panelModel.test.ts` (add `userScoped: false` to every existing `SwitchRow` literal in this file while here — the type gains the field):

```ts
describe("switchRowBucket with userScoped", () => {
  const base = { id: "x", name: "x", hint: "", desktopOnly: false, deviceScoped: false, userScoped: false };
  it("userScoped rows land in device-scoped", () => {
    expect(switchRowBucket({ ...base, userScoped: true }, false)).toBe("device-scoped");
  });
  it("desktopOnly outranks userScoped", () => {
    expect(switchRowBucket({ ...base, desktopOnly: true, userScoped: true }, false)).toBe("desktop-only");
  });
  it("manual ids still bucket as excluded", () => {
    expect(switchRowBucket(base, true)).toBe("excluded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `userScoped` not in `SwitchRow` / bucket returns `included`.

- [ ] **Step 3: panelModel**

`src/ui/panelModel.ts`:

```ts
export type SwitchRow = { id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean; userScoped: boolean };
```

`switchRowBucket` new body (auto flags first, then user scope, then manual):

```ts
export function switchRowBucket(row: SwitchRow, isManual: boolean): SwitchRowBucket {
  if (row.desktopOnly) return "desktop-only";
  if (row.deviceScoped || row.userScoped) return "device-scoped";
  if (isManual) return "excluded";
  return "included";
}
```

- [ ] **Step 4: main.ts settings schema + migration**

Interface fields (replace lines 62-63):

```ts
  memberScopes: Record<string, Record<string, "desktop" | "mobile">>; // group -> member id -> class scope (shared, travels)
  memberLocal: Record<string, string[]>; // group -> ids kept device-local here (never travels)
```

`DEFAULT_SETTINGS`: replace `switchExceptions: {}, snippetScopes: {}` with `memberScopes: {}, memberLocal: {}`.

`loadSettings` — run the migration on the raw object before the defaults merge:

```ts
    const data = (await this.loadData()) as Record<string, unknown> | null;
    if (data !== null) delete data.quickCommands;
    const migrated = data === null ? null : (migrateMemberSettings(data) as Partial<ConfigSyncSettings>);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
```

Add private accessors near `augmentedSwitchExceptions`:

```ts
  private memberScopesFor(group: string): Record<string, "desktop" | "mobile"> {
    return this.settings.memberScopes[group] ?? {};
  }

  private memberLocalFor(group: string): string[] {
    return this.settings.memberLocal[group] ?? [];
  }
```

- [ ] **Step 5: main.ts wiring**

Replace `augmentedSwitchExceptions` (keep the lock-reading block verbatim):

```ts
  // The runtime mask per switch group = This-device ids (memberLocal) ∪ ids class-scoped away
  // from this device (memberScopes) ∪ auto-derived exclusions (community-plugins only:
  // desktop-only manifest ids on mobile, plus plugin groups with a non-matching devices class).
  // Masked ids pass through at capture, keep local state on apply, and are hidden from in-sync
  // comparison. The persisted settings are left untouched.
  private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>> {
    const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    const derived = deviceExcludedPluginIds(this.settings.groups, device);
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
      for (const id of desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock)) derived.add(id);
    }
    const out: Record<string, string[]> = {};
    for (const name of SWITCH_LIST_GROUPS) {
      const scoped = scopedAwayMembers(this.memberScopesFor(name), Platform.isMobile);
      const auto = name === "community-plugins" ? derived : new Set<string>();
      const mask = [...new Set([...this.memberLocalFor(name), ...scoped, ...auto])];
      if (mask.length > 0) out[name] = mask;
    }
    return out;
  }
```

Replace `snippetForceOffIds` with the per-group form:

```ts
  // Force-off = user class scopes enforced on the wrong device class, minus This-device ids
  // (local wins). Auto-derived exclusions are never forced off — they keep local state.
  private memberForceOffIds(group: string): string[] {
    return memberForceOff(this.memberScopesFor(group), this.memberLocalFor(group), Platform.isMobile);
  }
```

`coreContext` (`:966-971`):

```ts
      switchForceOff: (() => {
        const out: Record<string, string[]> = {};
        for (const name of SWITCH_LIST_GROUPS) {
          const f = this.memberForceOffIds(name);
          if (f.length > 0) out[name] = f;
        }
        return out;
      })(),
```

Diff-side (`:490`): `const fo = SWITCH_LIST_GROUPS.has(name) ? this.memberForceOffIds(name) : [];`

`switchLocalDecisions` (`:502`): `(name) => (SWITCH_LIST_GROUPS.has(name) ? this.memberLocalFor(name) : [])`

`addSwitchExceptions` (`:530-536`) — writes memberLocal now:

```ts
      addSwitchExceptions: async (name, ids) => {
        const merged = [...new Set([...this.memberLocalFor(name), ...ids])].sort();
        this.settings.memberLocal = { ...this.settings.memberLocal, [name]: merged };
        await this.saveSettings();
        void this.refreshLocalStatus();
      },
```

`switchListRows` — snippets branch (`:1164-1174`): scopes/pins read the new fields, `deviceScoped` becomes the auto-only flag (always false for snippets), user scopes move to `userScoped`:

```ts
      const scopedAway = scopedAwayMembers(this.memberScopesFor("enabled-css-snippets"), Platform.isMobile);
      const pins = new Set(this.memberLocalFor("enabled-css-snippets"));
      ...
        desktopOnly: false,
        deviceScoped: false,
        userScoped: scopedAway.has(id) && !pins.has(id), // local wins: This-device rows are user-controlled, not scoped-away
```

Plugins/core branch (`:1203-1219`): keep `dtoIds`/`devScopedIds` as-is (auto), and add the user dimension for every group:

```ts
    const scopedAway = scopedAwayMembers(this.memberScopesFor(groupName), Platform.isMobile);
    const pins = new Set(this.memberLocalFor(groupName));
    ...
        desktopOnly: dtoIds.has(id),
        deviceScoped: devScopedIds.has(id),
        userScoped: scopedAway.has(id) && !pins.has(id),
```

`removeSnippetOrphans` bookkeeping (`:1249-1262`):

```ts
    let touched = false;
    const scopes = { ...this.memberScopesFor("enabled-css-snippets") };
    for (const n of names) {
      if (n in scopes) {
        delete scopes[n];
        touched = true;
      }
    }
    if (touched) this.settings.memberScopes = { ...this.settings.memberScopes, "enabled-css-snippets": scopes };
    const pins = this.settings.memberLocal["enabled-css-snippets"];
    if (pins !== undefined && pins.some((p) => drop.has(p))) {
      this.settings.memberLocal = { ...this.settings.memberLocal, "enabled-css-snippets": pins.filter((p) => !drop.has(p)) };
      touched = true;
    }
```

Import `migrateMemberSettings` from `./core/settingsMigration`.

- [ ] **Step 6: SettingTab mechanical swaps (keep the current UI shape compiling; Task 3 rewrites it)**

`SettingsHost.settings`: replace `switchExceptions`/`snippetScopes` fields with the two new shapes; `switchListRows` return type gains `userScoped: boolean`.

Reference mapping (apply throughout `SettingTab.ts`, no layout changes):
- read `this.host.settings.snippetScopes` → `this.host.settings.memberScopes["enabled-css-snippets"] ?? {}`
- write `this.host.settings.snippetScopes = X` → `this.host.settings.memberScopes = { ...this.host.settings.memberScopes, "enabled-css-snippets": X }`
- read `this.host.settings.switchExceptions[G] ?? []` → `this.host.settings.memberLocal[G] ?? []`
- write `this.host.settings.switchExceptions[G] = X` → `this.host.settings.memberLocal = { ...this.host.settings.memberLocal, [G]: X }`

- [ ] **Step 7: Run gates + rename sweep**

Run: `npm test && npm run build && npm run lint`
Expected: PASS / OK / baseline.
Run: `git grep -n "switchExceptions\|snippetScopes" src/`
Expected: hits only in `settingsMigration.ts` and the `selfPresetRules` pattern string in `catalog.ts` (plus comments referencing the legacy keys).

---

### Task 3: Unified "Device scope" drawer + fields/group-row copy (SettingTab, styles)

**Files:**
- Modify: `src/ui/SettingTab.ts` — badges (`:556-575`), group-dropdown suppression (`:576-596`), fields drawer copy (`:642-648`), `renderLocalDecisions` (`:654-810` region), `setSnippetScope` (`:228-239`), fields action labels (`:1125-1126`)
- Modify: `styles.css` (two small rules)
- Test: gates + controller smoke in the dev vault (no new unit files; the logic under the UI was tested in Tasks 1–2)

**Interfaces:**
- Consumes (Task 2): `memberScopes`/`memberLocal` on `SettingsHost`, `SwitchRow.userScoped`, `orderSwitchRows`.
- Produces: `setMemberScope` (rename of `setSnippetScope`, same signature/semantics), unified drawer for all three switch groups.

- [ ] **Step 1: Rename the scope writer**

`setSnippetScope` → `setMemberScope` (comment: "Writes/clears one member's shared class scope for a switch group; 'all' is the absent default, so it deletes the key."). Update all references (Task 2 left them compiling under the old name).

- [ ] **Step 2: Badges (`:556-575`)** — both badges for every switch group, unified text:

```ts
    if (group !== undefined && SWITCH_LIST_GROUPS.has(item.name)) {
      const nScoped = Object.keys(this.host.settings.memberScopes[item.name] ?? {}).length;
      const scopeBadge = row.nameEl.createSpan({ cls: "config-sync-devbadge config-sync-scopebadge", text: `${nScoped} device-scoped` });
      scopeBadge.setAttribute("title", "Members scoped to one device class — shared, travels, not enabled on the other class");
      if (nScoped === 0) scopeBadge.hide();
      const nLocal = (this.host.settings.memberLocal[item.name] ?? []).length;
      const b = row.nameEl.createSpan({ cls: "config-sync-devbadge config-sync-exbadge", text: `${nLocal} this-device` });
      b.setAttribute("title", "Members that keep their own on/off state on this device — never synced");
      if (nLocal === 0) b.hide();
    }
```

- [ ] **Step 3: Suppress the group-level device dropdown for all switch lists (`:578`)**

Condition `item.name !== "enabled-css-snippets"` → `!SWITCH_LIST_GROUPS.has(item.name)`; update the comment above it (per-member scope makes the coarse group dropdown a redundant second control on every switch list). While in this block: capitalize the group `devices` dropdown labels to `All devices` / `Desktop only` / `Mobile only` (values unchanged).

- [ ] **Step 4: Fields drawer copy (`:642-648`, `:1125-1126`)**

Heading text `Fields to protect` → `Field rules`; description → the Global Constraints string. Action labels: `{ id: "strip", label: "This device" }`, `{ id: "encrypt", label: "Encrypted" }` (ids/serialization unchanged).

- [ ] **Step 5: Rewrite `renderLocalDecisions` as the unified renderer**

Structure (mockup 01–03 binding; orphan section and the `reload()`/row-fetch scaffolding stay as-is):

```ts
  // "Device scope" — the unified per-member scope editor for all three switch lists
  // (定稿 scope-unify-mockup.html): one 4-value dropdown per member. This device (memberLocal)
  // keeps the member's own on/off here and never travels; Desktop/Mobile (memberScopes) travel
  // and are enforced on the wrong class; auto-derived rows are read-only.
  private renderLocalDecisions(exp: HTMLElement, group: SyncGroup, wrap: HTMLElement, item: CatalogItem): void {
    const isSnippetGroup = group.name === "enabled-css-snippets";
    exp.createDiv({ cls: "config-sync-explabel", text: "Device scope" });
    exp.createDiv({
      cls: "config-sync-expdesc",
      text: "All devices — synced everywhere · Desktop/Mobile only — only enabled on that device class (shared, travels) · This device — keeps its own on/off here, never synced.",
    });
    const listEl = exp.createDiv({ cls: "config-sync-ldlist" });
    const boundDevice = Platform.isMobile ? "desktop" : "mobile";
    // ... orphans state + renderRows(rows) skeleton unchanged ...
```

Inside `renderRows`:

```ts
      const scopesOf = (): Record<string, "desktop" | "mobile"> => this.host.settings.memberScopes[group.name] ?? {};
      const localOf = (): Set<string> => new Set(this.host.settings.memberLocal[group.name] ?? []);
      const updateBadges = (): void => {
        const scopeBadge = wrap.querySelector<HTMLElement>(".config-sync-scopebadge");
        if (scopeBadge !== null) {
          const n = Object.keys(scopesOf()).length;
          scopeBadge.setText(`${n} device-scoped`);
          if (n > 0) scopeBadge.show();
          else scopeBadge.hide();
        }
        const localBadge = wrap.querySelector<HTMLElement>(".config-sync-exbadge");
        if (localBadge !== null) {
          const n = localOf().size;
          localBadge.setText(`${n} this-device`);
          if (n > 0) localBadge.show();
          else localBadge.hide();
        }
      };
      // This device → add to memberLocal, leave the shared scope untouched underneath.
      // Desktop/Mobile → set the shared scope, drop the local id. All devices → clear both.
      const setScope = async (id: string, v: "all" | "desktop" | "mobile" | "local"): Promise<void> => {
        const local = localOf();
        if (v === "local") local.add(id);
        else local.delete(id);
        this.host.settings.memberLocal = { ...this.host.settings.memberLocal, [group.name]: [...local].sort() };
        if (v !== "local") {
          this.host.settings.memberScopes = { ...this.host.settings.memberScopes, [group.name]: setMemberScope(scopesOf(), id, v) };
        }
        await this.host.saveSettings();
        updateBadges();
        await reload();
      };
      const scopeDropdown = (rowEl: HTMLElement, id: string, auto: boolean): void => {
        const dd = new DropdownComponent(rowEl);
        if (auto) {
          const label = Platform.isMobile ? "Desktop only (auto)" : "Mobile only (auto)";
          dd.addOption("auto", label).setValue("auto").setDisabled(true);
        } else {
          const value: "all" | "desktop" | "mobile" | "local" = localOf().has(id) ? "local" : scopesOf()[id] ?? "all";
          dd.addOption("all", "All devices")
            .addOption("desktop", "Desktop only")
            .addOption("mobile", "Mobile only")
            .addOption("local", "This device")
            .setValue(value)
            .onChange((v) => void setScope(id, v as "all" | "desktop" | "mobile" | "local"));
          dd.selectEl.toggleClass("is-scoped", value === "desktop" || value === "mobile");
          dd.selectEl.toggleClass("is-local", value === "local");
        }
        dd.selectEl.addClass("config-sync-ld-scope");
      };
```

Row loop (replaces the whole old per-bucket branching, including the pin/unpin buttons, the excluded/included toggle, and the old `renderScopeDropdown`):

```ts
      const ordered = orderSwitchRows(rows, localOf());
      let prevBucket: OrderedSwitchRow["bucket"] | null = null;
      for (const r of ordered) {
        const gsep = prevBucket !== null && r.bucket !== prevBucket;
        prevBucket = r.bucket;
        const isAuto = r.desktopOnly || r.deviceScoped;
        if (isAuto) {
          const rowEl = listEl.createDiv({ cls: `config-sync-ldrow is-auto${gsep ? " config-sync-ldrow-gsep" : ""}` });
          rowEl.setAttribute(
            "title",
            r.desktopOnly
              ? "Scoped automatically — this plugin can't run on this device"
              : `Scoped automatically — you set this plugin's settings group to devices: ${boundDevice}`,
          );
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({ cls: "config-sync-doto-pill", text: r.desktopOnly ? "desktop-only" : `${boundDevice}-only` });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: r.desktopOnly ? "can't run on this device" : `you set its settings group to ${boundDevice}` });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          scopeDropdown(rowEl, r.id, true);
          continue;
        }
        if (r.userScoped) {
          // Scoped away from this device by a shared class scope — stays editable from any device.
          const rowEl = listEl.createDiv({ cls: `config-sync-ldrow is-auto${gsep ? " config-sync-ldrow-gsep" : ""}` });
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({ cls: "config-sync-doto-pill", text: `${boundDevice}-only` });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: `not enabled here — scoped to ${boundDevice}` });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          scopeDropdown(rowEl, r.id, false);
          continue;
        }
        const isLocal = r.bucket === "excluded";
        const rowEl = listEl.createDiv({ cls: `config-sync-ldrow${isLocal ? " is-local" : ""}${gsep ? " config-sync-ldrow-gsep" : ""}` });
        rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
        if (isLocal) {
          const chip = rowEl.createSpan({ cls: "config-sync-ld-pinchip" });
          setIcon(chip.createSpan({ cls: "config-sync-ld-pinchip-icon" }), "pin");
          chip.appendText(`This device · ${r.hint.startsWith("on here") ? "on" : "off"}`);
          const shared = scopesOf()[r.id];
          if (shared !== undefined) {
            rowEl.createSpan({ cls: "config-sync-ld-ovr", text: `overrides ${shared === "desktop" ? "Desktop" : "Mobile"} only` });
          }
        }
        rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
        rowEl.createDiv({ cls: "config-sync-rule-spacer" });
        scopeDropdown(rowEl, r.id, false);
      }
```

Notes: `isSnippetGroup` stays only for the orphan section gate; the old `setPin`, `updateScopeBadge`, `renderScopeDropdown`, per-group wording branches, `.config-sync-ldstate` spans, `ToggleComponent` rows, and pin/unpin controls are all deleted. If `ToggleComponent` becomes unused in the file, drop the import.

- [ ] **Step 6: styles.css** — append after the existing `.config-sync-ld-*` rules:

```css
/* Scope unification: This-device dropdown tint + override hint (定稿 scope-unify-mockup.html) */
.config-sync-ld-scope.is-local {
  color: var(--color-pink);
  border-color: var(--color-pink);
}
.config-sync-ld-ovr {
  font-size: var(--font-ui-smaller);
  color: var(--text-faint);
  font-style: italic;
}
```

- [ ] **Step 7: Run gates**

Run: `npm test && npm run build && npm run lint`
Expected: PASS / OK / baseline. Controller then smokes in the dev vault (drawer parity across the three lists, dropdown transitions and storage effects, badge in-place updates, migration from a seeded old-format data.json, desktop apply force-offs a mobile-scoped plugin, fields labels renamed with unchanged serialized rules).

---

### Task 4: Docs (docs-currency gate)

**Files:**
- Modify: `README.md`, `README.zh.md` (keep 1:1 line parity)
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/design/DESIGN.md`

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–3 and the spec's vocabulary.

- [ ] **Step 1: README.md + README.zh.md**

Rewrite the switch-list feature bullets to the scope vocabulary: the two lists share one "Device scope" editor (All devices / Desktop only / Mobile only / This device); This device replaces the old Excluded/Pinned wording; class scopes travel and are enforced on the other device class; auto-derived desktop-only exclusions keep local state. Mention the fields drawer rename (Field rules; This device / Encrypted) and that a device-local key like `userIgnoredFilters` is expressed as a This-device field rule. Keep both files at identical line counts and 1:1 content.

- [ ] **Step 2: docs/ARCHITECTURE.md**

Update the settings-shape mentions: `memberScopes` (shared, travels) / `memberLocal` (device-local, stripped via the self preset) replacing `switchExceptions`/`snippetScopes`; note `src/core/settingsMigration.ts` (one-time load migration) and the availability renames (`scopedAwayMembers`/`memberForceOff`); note per-group mask/force-off composition in main.ts (auto-derived = mask-only).

- [ ] **Step 3: docs/design/DESIGN.md**

Update the switch-list drawer component entry: unified "Device scope" drawer, 定稿 pointer `scope-unify-mockup.html` (2026-07-24), badge copy, override hint, auto rows. Remove/adjust the now-stale pin/exclude wording.

- [ ] **Step 4: Run gates**

Run: `npm test && npm run build && npm run lint`
Expected: unchanged from Task 3 (docs only).
Check: `wc -l README.md README.zh.md` — equal line counts.
