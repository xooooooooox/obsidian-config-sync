# Per-snippet device scope + local pin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CSS snippets the same per-device treatment plugins have — a shared per-snippet "Active on" scope (all/desktop/mobile) plus a device-local "Pin here" override — by promoting `enabledCssSnippets` to a third switch-list group through a contained field adapter.

**Architecture:** `enabled-css-snippets` joins `SWITCH_LIST_GROUPS`, inheriting the whole per-item layer (drawer, `switchListRows`, `switchDivergence`, exception masking). A single-file adapter in `switchList.ts` makes only the *local* read/write field-aware (the list is a field inside `appearance.json`); the store copy stays a plain array in a dedicated file, and `SyncGroup`/`groupStorePath`/`groupRealPath` are untouched. Scope produces a runtime mask (`scopedAwaySnippets`) folded into the exception set for capture/compare, plus a force-off subtraction on apply; pins reuse `switchExceptions`.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest. No new dependencies.

## Global Constraints

- **No emoji in UI.** Icons are Lucide via `setIcon` (the pin is `setIcon(el, "pin")`). Device state uses `--color-orange`; scope = outlined chip, pinned = filled chip.
- **Manual scope only** — no filename/marker auto-detection. Every snippet defaults to `all` (absent from `snippetScopes`).
- **Store copy is always a plain `string[]`.** Only the LOCAL side of the snippet list is field-aware.
- **`SyncGroup` schema, `groupStorePath`, `groupRealPath` are NOT changed.** The two existing switch lists must behave byte-identically.
- **Precedence: pin > scope.** A pinned snippet is never force-removed.
- No Claude attribution in any commit message.
- Run `npm test` (vitest) before each commit; all existing tests stay green.

---

### Task 1: Field adapter in `switchList.ts`

**Files:**
- Modify: `src/core/switchList.ts`
- Test: `tests/switchList.test.ts`

**Interfaces:**
- Produces: `SWITCH_LISTS: Record<string, SwitchListSpec>`, `SWITCH_LIST_GROUPS` (now derived, size 3), `readLocalSwitchList(name, content): SwitchList | null`, `writeLocalSwitchList(name, list, priorContent): string`, `localRealPath(name, groupPath, configDir): string`, `subtractForceOff(list, forceOff): SwitchList`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/switchList.test.ts` (and update the existing `SWITCH_LIST_GROUPS` block from size 2 → 3):

```ts
import {
  SWITCH_LISTS, readLocalSwitchList, writeLocalSwitchList, localRealPath, subtractForceOff,
} from "../src/core/switchList";

describe("SWITCH_LIST_GROUPS (now derived from SWITCH_LISTS)", () => {
  it("has community-plugins, core-plugins, enabled-css-snippets", () => {
    expect(SWITCH_LIST_GROUPS.has("community-plugins")).toBe(true);
    expect(SWITCH_LIST_GROUPS.has("core-plugins")).toBe(true);
    expect(SWITCH_LIST_GROUPS.has("enabled-css-snippets")).toBe(true);
    expect(SWITCH_LIST_GROUPS.size).toBe(3);
  });
});

describe("readLocalSwitchList", () => {
  it("plain groups parse the whole file (unchanged)", () => {
    expect(readLocalSwitchList("community-plugins", '["a","b"]')).toEqual(["a", "b"]);
  });
  it("field group extracts the array field", () => {
    const app = JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "a-mobile"], baseFontSize: 16 });
    expect(readLocalSwitchList("enabled-css-snippets", app)).toEqual(["a", "a-mobile"]);
  });
  it("field group returns [] when the field is absent", () => {
    expect(readLocalSwitchList("enabled-css-snippets", '{"cssTheme":"X"}')).toEqual([]);
  });
  it("field group returns null on non-string array or bad json", () => {
    expect(readLocalSwitchList("enabled-css-snippets", '{"enabledCssSnippets":[1,2]}')).toBeNull();
    expect(readLocalSwitchList("enabled-css-snippets", "not json")).toBeNull();
  });
});

describe("writeLocalSwitchList", () => {
  it("field group replaces only the field, preserving siblings", () => {
    const prior = JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["old"], baseFontSize: 16 });
    const out = JSON.parse(writeLocalSwitchList("enabled-css-snippets", ["a", "a-desktop"], prior));
    expect(out).toEqual({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 });
  });
  it("field group tolerates null/garbage prior content", () => {
    expect(JSON.parse(writeLocalSwitchList("enabled-css-snippets", ["a"], null))).toEqual({ enabledCssSnippets: ["a"] });
  });
  it("plain groups serialize the list as before (2-space + newline)", () => {
    expect(writeLocalSwitchList("community-plugins", ["a", "b"], null)).toBe(JSON.stringify(["a", "b"], null, 2) + "\n");
  });
});

describe("localRealPath", () => {
  it("redirects the snippet group to appearance.json", () => {
    expect(localRealPath("enabled-css-snippets", "{configDir}/enabled-css-snippets.json", ".obs")).toBe(".obs/appearance.json");
  });
  it("returns groupRealPath for plain switch lists and other groups", () => {
    expect(localRealPath("community-plugins", "{configDir}/community-plugins.json", ".obs")).toBe(".obs/community-plugins.json");
    expect(localRealPath("hotkeys", "{configDir}/hotkeys.json", ".obs")).toBe(".obs/hotkeys.json");
  });
});

describe("subtractForceOff", () => {
  it("removes force-off ids from an array list", () => {
    expect(subtractForceOff(["a", "a-mobile", "b"], ["a-mobile"])).toEqual(["a", "b"]);
  });
  it("is identity for empty force-off and for map lists", () => {
    expect(subtractForceOff(["a", "b"], [])).toEqual(["a", "b"]);
    expect(subtractForceOff({ a: true }, ["a"])).toEqual({ a: true });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/switchList.test.ts`
Expected: FAIL — `readLocalSwitchList` etc. not exported; existing size test fails (2 vs 3).

- [ ] **Step 3: Implement in `src/core/switchList.ts`**

At the top, add the import and replace the hardcoded `SWITCH_LIST_GROUPS` (line 10):

```ts
import { groupRealPath } from "./pathing";

export interface SwitchListSpec {
  localFile: string; // file under {configDir} the LOCAL list lives in
  field?: string;    // set => list is this array field inside localFile; unset => whole file
}
export const SWITCH_LISTS: Record<string, SwitchListSpec> = {
  "community-plugins": { localFile: "community-plugins.json" },
  "core-plugins": { localFile: "core-plugins.json" },
  "enabled-css-snippets": { localFile: "appearance.json", field: "enabledCssSnippets" },
};
export const SWITCH_LIST_GROUPS: ReadonlySet<string> = new Set(Object.keys(SWITCH_LISTS));
```

Add these three functions (near the top, after `parseSwitchList`):

```ts
// LOCAL-side read: whole file for plain lists, the array field for field lists.
export function readLocalSwitchList(name: string, content: string): SwitchList | null {
  const spec = SWITCH_LISTS[name];
  if (spec?.field !== undefined) {
    try {
      const arr = (JSON.parse(content) as Record<string, unknown>)[spec.field];
      if (arr === undefined) return [];
      if (Array.isArray(arr) && arr.every((x): x is string => typeof x === "string")) return arr;
      return null;
    } catch {
      return null;
    }
  }
  return parseSwitchList(content);
}

// LOCAL-side write: whole array for plain lists; for field lists, replace ONLY that field in
// the prior file content so sibling fields (theme, fonts) survive.
export function writeLocalSwitchList(name: string, list: SwitchList, priorContent: string | null): string {
  const spec = SWITCH_LISTS[name];
  if (spec?.field !== undefined) {
    let obj: Record<string, unknown> = {};
    if (priorContent !== null) {
      try {
        const parsed = JSON.parse(priorContent) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      } catch {
        obj = {};
      }
    }
    obj[spec.field] = list;
    return JSON.stringify(obj, null, 2) + "\n";
  }
  return JSON.stringify(list, null, 2) + "\n";
}

// LOCAL real path: field lists resolve to their localFile (appearance.json); everything else
// resolves the group's own path. This is the ONLY place the virtual snippet path is redirected.
export function localRealPath(name: string, groupPath: string, configDir: string): string {
  const spec = SWITCH_LISTS[name];
  return spec?.field !== undefined ? `${configDir}/${spec.localFile}` : groupRealPath(groupPath, configDir);
}

// Remove force-off ids from an applied list. Arrays only (snippet scope-away force-off);
// maps and empty force-off sets pass through unchanged. Shared by applyGroup and diffPair so
// the diff preview provably mirrors what apply writes.
export function subtractForceOff(list: SwitchList, forceOff: string[]): SwitchList {
  if (!Array.isArray(list) || forceOff.length === 0) return list;
  const off = new Set(forceOff);
  return list.filter((id) => !off.has(id));
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/switchList.test.ts`
Expected: PASS (all, including the updated size test).

- [ ] **Step 5: Commit**

```bash
git add src/core/switchList.ts tests/switchList.test.ts
git commit -m "feat(switchList): field-aware local adapter for a third switch list"
```

---

### Task 2: `scopedAwaySnippets` + `snippetForceOff` (pure)

**Files:**
- Modify: `src/core/availability.ts`
- Test: `tests/availability.test.ts`

**Interfaces:**
- Produces: `scopedAwaySnippets(scopes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string>`; `snippetForceOff(scopes, pins: string[], isMobile: boolean): string[]` (= scopedAway minus pins, pin > scope).

- [ ] **Step 1: Write the failing tests**

Add to `tests/availability.test.ts`:

```ts
import { scopedAwaySnippets, snippetForceOff } from "../src/core/availability";

describe("scopedAwaySnippets", () => {
  const scopes = { "a-mobile": "mobile", "a-desktop": "desktop" } as const;
  it("on desktop, names mobile-scoped snippets", () => {
    expect(scopedAwaySnippets(scopes, false)).toEqual(new Set(["a-mobile"]));
  });
  it("on mobile, names desktop-scoped snippets", () => {
    expect(scopedAwaySnippets(scopes, true)).toEqual(new Set(["a-desktop"]));
  });
  it("empty scopes → empty set", () => {
    expect(scopedAwaySnippets({}, false)).toEqual(new Set());
  });
});

describe("snippetForceOff (pin > scope)", () => {
  const scopes = { "a-mobile": "mobile", "a-desktop": "desktop" } as const;
  it("force-offs scope-away snippets on desktop", () => {
    expect(snippetForceOff(scopes, [], false)).toEqual(["a-mobile"]);
  });
  it("a pinned scope-away snippet is NOT force-offed", () => {
    expect(snippetForceOff(scopes, ["a-mobile"], false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/availability.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/core/availability.ts`** (append, next to `desktopOnlyPluginIds`)

```ts
// Snippet names whose shared scope excludes the current device class. Feeds the exception mask
// (capture pass-through + compare masking) exactly like desktopOnlyPluginIds does for plugins.
export function scopedAwaySnippets(scopes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string> {
  const want = isMobile ? "mobile" : "desktop";
  const out = new Set<string>();
  for (const [name, scope] of Object.entries(scopes)) if (scope !== want) out.add(name);
  return out;
}

// The snippets apply must force OFF on the wrong device — scope-away minus pins, since an explicit
// local pin (pin > scope) must keep the machine's own on/off.
export function snippetForceOff(scopes: Record<string, "desktop" | "mobile">, pins: string[], isMobile: boolean): string[] {
  const pinSet = new Set(pins);
  return [...scopedAwaySnippets(scopes, isMobile)].filter((id) => !pinSet.has(id));
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/availability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/availability.ts tests/availability.test.ts
git commit -m "feat(availability): scopedAwaySnippets + snippetForceOff (pure)"
```

---

### Task 3: Core capture/apply field-awareness + force-off

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (CoreContext type; `captureGroup` ~244–272; `applyGroup` ~646–682)
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `localRealPath`, `readLocalSwitchList`, `writeLocalSwitchList` (Task 1).
- Produces: `CoreContext.switchForceOff?: Record<string, string[]>` — group name → ids to remove from the applied list.

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/core.test.ts` (uses the file's existing `setup`/`seedGroups` helpers):

```ts
const SNIPPET_MANIFEST = JSON.stringify({
  version: 1,
  groups: [{ name: "enabled-css-snippets", path: "{configDir}/enabled-css-snippets.json", type: "file", devices: "all" }],
});

describe("enabled-css-snippets switch list (field-aware local, plain store)", () => {
  it("captures the field to a dedicated plain-array store file", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({ ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 }) });
    await capture(ctx, ["enabled-css-snippets"]);
    expect(JSON.parse(await io.read("cs/store/configdir/enabled-css-snippets.json"))).toEqual(["a", "a-desktop"]);
  });

  it("apply rewrites only enabledCssSnippets, preserving sibling fields", async () => {
    const { io, ctx } = setup();
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({
      "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["a", "a-desktop"]),
      ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["old"], baseFontSize: 16 }),
    });
    await apply(ctx, ["enabled-css-snippets"]);
    expect(JSON.parse(await io.read(".obs/appearance.json"))).toEqual({ cssTheme: "X", enabledCssSnippets: ["a", "a-desktop"], baseFontSize: 16 });
  });

  it("force-off removes scope-away ids on apply; pins survive", async () => {
    const { io, ctx } = setup();
    ctx.switchExceptions = { "enabled-css-snippets": ["a-mobile", "keepPinned"] }; // mask (pins ∪ scoped)
    ctx.switchForceOff = { "enabled-css-snippets": ["a-mobile"] }; // scoped-away, not pinned
    await seedGroups(ctx, SNIPPET_MANIFEST);
    io.seed({
      "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["a"]),
      ".obs/appearance.json": JSON.stringify({ enabledCssSnippets: ["a", "a-mobile", "keepPinned"] }),
    });
    await apply(ctx, ["enabled-css-snippets"]);
    // a from store; a-mobile force-offed; keepPinned kept-local (pin)
    expect(JSON.parse(await io.read(".obs/appearance.json")).enabledCssSnippets).toEqual(["a", "keepPinned"]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — snippet store not written / siblings lost / force-off ignored (and `switchForceOff` not on the type).

- [ ] **Step 3: Implement**

In `src/core/ConfigSyncCore.ts`, extend the import (line 8) and the `CoreContext` interface:

```ts
import { applySwitchList, captureSwitchList, localRealPath, parseSwitchList, readLocalSwitchList, subtractForceOff, SWITCH_LIST_GROUPS, SwitchList, switchListsEqual, writeLocalSwitchList } from "./switchList";
```
Add to the `CoreContext` interface (near `switchExceptions`):
```ts
  switchForceOff?: Record<string, string[]>; // group name -> ids removed from the applied list (snippet scope-away)
```

In `captureGroup` (line 244) change the local path resolution and the local parse:
```ts
  const real = localRealPath(group.name, group.path, ctx.configDir);   // was groupRealPath(...)
```
```ts
    const localSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? readLocalSwitchList(group.name, plainLocalContent) : null; // was parseSwitchList(plainLocalContent)
```
And the report label (line 266) — use the store basename so the snippet reports its real store file:
```ts
    await writeClassified(ctx, store, t.content, basename(store), result, (existing) => {  // was basename(real)
```
(`existingStoreList` and the `unchanged` comparator keep `parseSwitchList` — the store is a plain array.)

In `applyGroup` (line 647) change the local path and the local parse/write + force-off (replace lines 671–678 body):
```ts
  const real = localRealPath(group.name, group.path, ctx.configDir);   // was groupRealPath(...)
```
```ts
      let content: string;
      if (storeSwitchList !== null) {
        const localSwitchList = localContent !== null ? readLocalSwitchList(group.name, localContent) : null;
        const merged = applySwitchList(storeSwitchList, localSwitchList, exc);
        const finalList = subtractForceOff(merged, ctx.switchForceOff?.[group.name] ?? []);
        content = writeLocalSwitchList(group.name, finalList, localContent);
        for (const line of switchDeltaMessages(localSwitchList, finalList)) result.messages.push(line);
      } else {
        content = await applyTransform(group, storeContent, localContent, ctx.passphrase);
      }
```
(`storeSwitchList = ... parseSwitchList(storeContent)` stays — store is plain.)

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/core.test.ts tests/switchList.test.ts`
Expected: PASS (new + all existing — plugin lists unchanged because `readLocalSwitchList`/`writeLocalSwitchList`/`localRealPath` are identity for non-field groups).

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat(core): field-aware snippet capture/apply with scope force-off"
```

---

### Task 4: Status compare field-awareness

**Files:**
- Modify: `src/core/status.ts` (line 48 `real`; `switchListEqualOrNull` ~92; call site ~79)
- Test: `tests/core.test.ts` (status path) or `tests/status.test.ts`

**Interfaces:**
- Consumes: `localRealPath`, `readLocalSwitchList`.

- [ ] **Step 1: Write the failing test** (add to `tests/core.test.ts`)

```ts
it("status: snippet field equals its plain-array store (no phantom change)", async () => {
  const { io, ctx } = setup();
  await seedGroups(ctx, SNIPPET_MANIFEST);
  io.seed({
    "cs/store/configdir/enabled-css-snippets.json": JSON.stringify(["b", "a"]),
    ".obs/appearance.json": JSON.stringify({ cssTheme: "X", enabledCssSnippets: ["a", "b"] }),
  });
  const st = await statusForGroups(ctx, ["enabled-css-snippets"]);
  expect(st.find((s) => s.group === "enabled-css-snippets")?.state).toBe("in-sync");
});
```
(Confirm the exact `statusForGroups` return shape against neighbouring status assertions in the file; adjust the `state`/field name to match.)

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/core.test.ts -t "snippet field equals"`
Expected: FAIL — live read is the whole appearance.json object, which doesn't parse as a switch list, so it falls through to byte compare and reports a change.

- [ ] **Step 3: Implement in `src/core/status.ts`**

Extend imports (line 8 area) to add `localRealPath, readLocalSwitchList` from `./switchList`. Change line 48:
```ts
  const real = localRealPath(group.name, group.path, ctx.configDir);   // was groupRealPath(...)
```
Make `switchListEqualOrNull` field-aware by passing the group name (line 79 call and the function ~92):
```ts
  const switchEqual = SWITCH_LIST_GROUPS.has(group.name)
    ? switchListEqualOrNull(group.name, liveContent, storeContent, exc)   // add group.name
    : null;
```
```ts
function switchListEqualOrNull(name: string, liveContent: string, storeContent: string, exc: string[]): boolean | null {
  const live = readLocalSwitchList(name, liveContent);   // field-aware local
  const store = parseSwitchList(storeContent);           // plain store
  if (live === null || store === null) return null;
  return switchListsEqual(live, store, exc);
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/core.test.ts tests/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/status.ts tests/core.test.ts
git commit -m "feat(status): field-aware snippet switch-list comparison"
```

---

### Task 5: Catalog item + appearance.json strip

**Files:**
- Modify: `src/core/catalog.ts` (general "available" section builder ~174–208; add `appearancePresetRules`/`ensureAppearancePresets` near `selfPresetRules` ~369–408)
- Modify: the call site of `ensureSelfPresets` so `ensureAppearancePresets` runs alongside it (grep `ensureSelfPresets(` across `src/`)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Produces catalog item `enabled-css-snippets` (path `{configDir}/enabled-css-snippets.json`, type `file`); `appearancePresetRules(): FieldRule[]`; `ensureAppearancePresets(groups): SyncGroup[]`.

- [ ] **Step 1: Write the failing tests** (`tests/catalog.test.ts`)

```ts
import { appearancePresetRules, ensureAppearancePresets } from "../src/core/catalog";

describe("appearance strip when snippet list is active", () => {
  const appearance = { name: "appearance.json", path: "{configDir}/appearance.json", type: "file", devices: "all" } as const;
  const snippet = { name: "enabled-css-snippets", path: "{configDir}/enabled-css-snippets.json", type: "file", devices: "all" } as const;

  it("adds a locked enabledCssSnippets strip + fields mode ONLY when the snippet group is present", () => {
    const out = ensureAppearancePresets([{ ...appearance }, { ...snippet }]);
    const app = out.find((g) => g.name === "appearance.json")!;
    expect(app.mode).toBe("fields");
    expect(app.fields).toContainEqual({ pattern: "enabledCssSnippets", action: "strip", locked: true });
  });
  it("leaves appearance untouched when the snippet group is absent", () => {
    const out = ensureAppearancePresets([{ ...appearance }]);
    expect(out.find((g) => g.name === "appearance.json")).toEqual(appearance);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/core/catalog.ts`**

Add near `selfPresetRules` (line 369):
```ts
export function appearancePresetRules(): FieldRule[] {
  return [{ pattern: "enabledCssSnippets", action: "strip", locked: true }];
}

// When the enabled-css-snippets switch list is active, the appearance.json group must NOT also
// carry enabledCssSnippets (else both write the field). Pin it to fields mode + a locked strip.
// No-op when the snippet group isn't present, so opting out restores plain appearance sync.
export function ensureAppearancePresets(groups: SyncGroup[]): SyncGroup[] {
  if (!groups.some((g) => g.name === "enabled-css-snippets")) return groups;
  const presets = appearancePresetRules();
  const patterns = new Set(presets.map((p) => p.pattern));
  return groups.map((g) => {
    if (g.name !== "appearance.json") return g;
    return { ...g, mode: "fields", fields: [...presets, ...(g.fields ?? []).filter((f) => !patterns.has(f.pattern))] };
  });
}
```

Wherever `ensureSelfPresets(...)` is applied to the group list (grep to find it — typically in `main.ts` on load/commit), chain `ensureAppearancePresets` on the same list.

Add the catalog item in the general "available settings" section builder (the function returning the `available`/`notPresent` sections, ~174–208): after `available` is built, push the snippet switch item when `appearance.json` is present:
```ts
if (files.has("appearance.json")) {
  available.push({
    name: "enabled-css-snippets",
    label: "Enabled CSS snippets",
    description: "Which CSS snippets are on, per device.",
    path: "{configDir}/enabled-css-snippets.json",
    type: "file",
    exists: true,
    disabledReason: null,
    cautionReason: null,
  });
}
```
(Match the exact `CatalogItem` shape and the local variable names in that builder; `files` is the present-set already computed there via `presentSets`.)

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/catalog.ts tests/catalog.test.ts
git commit -m "feat(catalog): enabled-css-snippets item + appearance strip preset"
```

---

### Task 6: Wire runtime mask, force-off, settings, and diff in `main.ts`

**Files:**
- Modify: `src/main.ts` (`ConfigSyncSettings` ~47 + `DEFAULT_SETTINGS` ~68; `augmentedSwitchExceptions` ~882; add `snippetForceOff` method; `coreContext` ~908; `diffPair` ~427; `switchListRows` ~1085)
- Test: covered by Tasks 3–4 at core level + live (Task 8); no new unit test (private methods / `Platform`).

**Interfaces:**
- Consumes: `scopedAwaySnippets`, `snippetForceOff` (Task 2); `localRealPath`, `readLocalSwitchList`, `writeLocalSwitchList` (Task 1).
- Produces: `coreContext()` now sets `switchForceOff`; `augmentedSwitchExceptions` includes the `enabled-css-snippets` mask; `switchListRows("enabled-css-snippets")` returns snippet rows.

- [ ] **Step 1: Settings field**

In `ConfigSyncSettings` (line 56 area) add:
```ts
  snippetScopes: Record<string, "desktop" | "mobile">; // snippet name -> scope; absent = "all" (shared, travels)
```
In `DEFAULT_SETTINGS` (line 77 area) add: `snippetScopes: {},`.
Import `scopedAwaySnippets, snippetForceOff` from `./core/availability`.

- [ ] **Step 2: Fold the snippet mask into `augmentedSwitchExceptions`** (replace lines 903–905)

```ts
    const base = extraIds.size === 0
      ? this.settings.switchExceptions
      : { ...this.settings.switchExceptions, "community-plugins": [...new Set([...(this.settings.switchExceptions["community-plugins"] ?? []), ...extraIds])] };
    const pins = this.settings.switchExceptions["enabled-css-snippets"] ?? [];
    const snippetMask = [...new Set([...pins, ...scopedAwaySnippets(this.settings.snippetScopes, Platform.isMobile)])];
    return snippetMask.length === 0 ? base : { ...base, "enabled-css-snippets": snippetMask };
```

- [ ] **Step 3: Add `snippetForceOff` method and set it on the context**

```ts
  private snippetForceOffIds(): string[] {
    const pins = this.settings.switchExceptions["enabled-css-snippets"] ?? [];
    return snippetForceOff(this.settings.snippetScopes, pins, Platform.isMobile);
  }
```
In `coreContext()` (after `switchExceptions` is computed, ~914), add to the returned object:
```ts
      switchForceOff: (() => { const f = this.snippetForceOffIds(); return f.length > 0 ? { "enabled-css-snippets": f } : {}; })(),
```

- [ ] **Step 4: Make `diffPair` field-aware** (in the block at lines 427–466)

- `const real = localRealPath(name, this.app.vault.configDir, this.app.vault.configDir);` — no: use `localRealPath(name, group.path, this.app.vault.configDir)` (replaces the `groupRealPath(group.path, …)` line).
- Capture branch: `const l = readLocalSwitchList(name, local)` (was `parseSwitchList(local)`); `produced = serialize(captureSwitchList(l, store !== null ? parseSwitchList(store) : null, exc))` (store stays plain `parseSwitchList`).
- Apply branch: keep `const st = parseSwitchList(store)`; then
  ```ts
  const localList = local !== null ? readLocalSwitchList(name, local) : null;
  const merged = applySwitchList(st, localList, exc);
  const fo = name === "enabled-css-snippets" ? this.snippetForceOffIds() : [];
  produced = writeLocalSwitchList(name, subtractForceOff(merged, fo), local);   // was serialize(applySwitchList(...))
  ```
Import `localRealPath, readLocalSwitchList, subtractForceOff, writeLocalSwitchList` (extend the existing `./core/switchList` import at line 33).

- [ ] **Step 5: Snippet rows in `switchListRows`** (line 1085)

At the top of the method, branch the snippet group before the plugin logic:
```ts
    if (groupName === "enabled-css-snippets") {
      const cfg = this.app.vault.configDir;
      const readArr = async (p: string): Promise<string[]> => {
        try { return (await io.exists(p)) ? (JSON.parse(await io.read(p)) as string[]) : []; } catch { return []; }
      };
      // universe = .css files in snippets/ ∪ store list ∪ locally-enabled
      const files = (await io.exists(`${cfg}/snippets`)) ? (await io.list(`${cfg}/snippets`)).files : [];
      const fromDir = files.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
      const app = (await io.exists(`${cfg}/appearance.json`)) ? readLocalSwitchList("enabled-css-snippets", await io.read(`${cfg}/appearance.json`)) : [];
      const local = Array.isArray(app) ? app : [];
      const root = await this.resolvedRootPath();
      const store = await readArr(`${root}/store/${groupStorePath("{configDir}/enabled-css-snippets.json")}`);
      const scopedAway = scopedAwaySnippets(this.settings.snippetScopes, Platform.isMobile);
      const ids = [...new Set([...fromDir, ...store, ...local])].sort();
      return ids.map((id) => ({
        id,
        name: id,
        hint: `${local.includes(id) ? "on here" : "off here"} · ${store.includes(id) ? "store has on" : "store has off"}`,
        desktopOnly: false,
        deviceScoped: scopedAway.has(id), // renders as an auto-excluded row via orderSwitchRows
      }));
    }
```
(Confirm the adapter's directory-list API — `io.list(dir).files` per `ListedDir` — and `basename` import; both already used in this file.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions; the wiring is exercised at the core level by Tasks 3–4).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): snippet scope mask, force-off context, diff + rows"
```

---

### Task 7: Settings drawer — scope dropdown + pin

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderLocalDecisions` ~565–630; the item detection/badges ~479–486)
- Test: `tests/settingtab-commit.test.ts` for the scope write; visual/live otherwise.

**Interfaces:**
- Consumes: `switchListRows` snippet rows (Task 6); `host.settings.snippetScopes`.

- [ ] **Step 1: Write the failing test** (scope write path, `tests/settingtab-commit.test.ts` — mirror an existing commit test)

Assert that choosing `mobile` for a snippet writes `settings.snippetScopes[name] = "mobile"` and choosing `all` deletes the key. (Match the file's existing harness for constructing the tab/host; if that harness can't drive a `DropdownComponent`, extract the write into a pure helper `setSnippetScope(scopes, name, value)` in `SettingTab.ts` and unit-test that instead.)

```ts
import { setSnippetScope } from "../src/ui/SettingTab";
describe("setSnippetScope", () => {
  it("stores non-all and deletes on all", () => {
    expect(setSnippetScope({}, "a-mobile", "mobile")).toEqual({ "a-mobile": "mobile" });
    expect(setSnippetScope({ "a-mobile": "mobile" }, "a-mobile", "all")).toEqual({});
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/settingtab-commit.test.ts -t setSnippetScope`
Expected: FAIL — `setSnippetScope` not exported.

- [ ] **Step 3: Implement**

Add the pure helper to `SettingTab.ts`:
```ts
export function setSnippetScope(
  scopes: Record<string, "desktop" | "mobile">,
  name: string,
  value: "all" | "desktop" | "mobile",
): Record<string, "desktop" | "mobile"> {
  const next = { ...scopes };
  if (value === "all") delete next[name];
  else next[name] = value;
  return next;
}
```
In `renderLocalDecisions`, for the snippet group only (`group.name === "enabled-css-snippets"`), prepend a scope dropdown to each non-auto row (before the pin toggle at line 610), styled as an outlined orange chip:
```ts
if (group.name === "enabled-css-snippets") {
  new DropdownComponent(rowEl)
    .addOption("all", "All devices").addOption("desktop", "Desktop only").addOption("mobile", "Mobile only")
    .setValue(this.host.settings.snippetScopes[r.id] ?? "all")
    .onChange(async (v) => {
      this.host.settings.snippetScopes = setSnippetScope(this.host.settings.snippetScopes, r.id, v as "all" | "desktop" | "mobile");
      await this.host.saveSettings();
      renderRows();
    });
}
```
Relabel the pin: the existing exclusion toggle (line 610) keeps its behavior; for the snippet group, prefix its name cell with `setIcon(el, "pin")` and use the "Pinned here" copy from the 定稿 mock (`snippet-scope-refined-v2.html`). The `deviceScoped` auto rows already render the orange "…-only" pill via the existing `is-auto` branch.
Header badge (line 483 area): for the snippet group, count `snippetScopes` entries as "N device-scoped" instead of the exclusion count (or show both).

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/settingtab-commit.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SettingTab.ts tests/settingtab-commit.test.ts
git commit -m "feat(ui): per-snippet Active-on scope + pin in the switch-list drawer"
```

---

### Task 8: Live verification (dev vault)

**Files:** none (manual). Build: `npm run dev` (or the repo's build), reload the dev vault.

- [ ] **Step 1** — In Settings → the "Enabled CSS snippets" row, expand it. Confirm each snippet shows one **Active on** dropdown; the pin (Lucide `pin`) fades in on hover.
- [ ] **Step 2** — Set `mystyle-mobile` → **Mobile only**. Capture. Confirm `store/configdir/enabled-css-snippets.json` is a plain array and `appearance.json` on this (desktop) machine drops `mystyle-mobile` from `enabledCssSnippets`, with **other appearance fields intact** (theme/fonts unchanged).
- [ ] **Step 3** — Confirm the Sync Center shows the "Enabled CSS snippets" item **in sync** (no phantom `↑/↓`) after the scope is set.
- [ ] **Step 4** — Pin a snippet off on this device; capture on another machine that has it on; apply here; confirm the pin holds (store's "on" does not flip it) and the other machine is unaffected.
- [ ] **Step 5** — Toggle the "Enabled CSS snippets" group off entirely; confirm `appearance.json` returns to carrying `enabledCssSnippets` normally (strip preset is gated on the group's presence).
- [ ] **Step 6: Commit** any doc/UX tweaks found during verification.

---

## Self-Review

- **Spec coverage:** §1 field adapter → Task 1; §2 `snippetScopes` storage → Task 6 (settings) + travels via existing self group; §3 mask + force-off + precedence → Tasks 2/3/6; §4 UI drawer → Task 7; §5 Sync Center reactive pin → inherited by joining `SWITCH_LIST_GROUPS` (Tasks 1/6) + verified in Task 8 step 4 (the bespoke card copy is a Task 7/8 polish item, not new machinery); data-flow + non-goals → covered by Tasks 3/6 and the "no auto-detection / no .css change / no appearance schema change" constraints.
- **Placeholder scan:** deliverable code is complete; the two "match the exact shape / locate the call site" notes (catalog section builder variable names, `ensureSelfPresets` call site, status return field) are grep-and-confirm anchors, not unwritten logic.
- **Type consistency:** `readLocalSwitchList` / `writeLocalSwitchList` / `localRealPath` / `scopedAwaySnippets` / `snippetForceOff` / `CoreContext.switchForceOff` / `snippetScopes` are used with identical signatures across Tasks 1–7.
