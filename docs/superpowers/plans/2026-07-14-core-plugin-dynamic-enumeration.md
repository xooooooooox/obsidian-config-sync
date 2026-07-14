# Dynamic Core-Plugin Enumeration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make core-plugin recognition dynamic — driven by the running Obsidian's `internalPlugins` list — so any core plugin (e.g. Quick switcher / `switcher`) that exists is listed, classified, labeled, and path-validated, instead of only the 13 hardcoded ids.

**Architecture:** `catalog.ts` splits the hardcoded `CORE_PLUGIN_FILES` map into a filename-exception map (`{ properties: "types.json" }`) plus a seed id list, and introduces a module-level `coreIds` Set with `setCorePluginIds`/`coreSettingsIds`. Pure judgments read `coreSettingsIds()`; `listCoreSections` iterates the runtime `cores` param and filters to cores whose settings file exists. `main.ts` injects the runtime id set at load; `availability.ts` swaps its one call site.

**Tech Stack:** TypeScript (Obsidian plugin), vitest (`tests/` suite).

## Global Constraints

- Runtime is authoritative: the seed id list is a pre-injection fallback only, overwritten by `setCorePluginIds` at plugin load. A stale seed must never change a production judgment.
- The only filename exception is `properties → types.json`; every other core id maps to `${id}.json`.
- `listCoreSections` includes a core **only when its expected settings file exists** in configDir (approach A). This intentionally changes behavior: cores with no settings file no longer appear.
- `CORE_NOT_RECOMMENDED = ["sync", "publish"]` stays hardcoded (semantic caution, not enumeration).
- Gate: `npm run build && npm run lint` clean (0 errors / 65 warnings baseline, add none), `npm test` green (currently 202 — this plan adds tests), `./scripts/check-no-hardcoded-color.sh` passes.
- No UI change, no user-facing copy change. No Claude/AI attribution in commits.

---

### Task 1: Runtime-driven core-plugin enumeration

**Files:**
- Modify: `src/core/catalog.ts` (split map; injected set + setter/accessor; update `reservedNames`, `expectedPathForName`, `defaultGroupForName`, `categoryForGroup`, `displayLabelForGroup`, `listDiscovered`; rewrite `listCoreSections`)
- Modify: `src/core/availability.ts` (swap `CORE_SETTINGS_IDS` import → `coreSettingsIds()`)
- Modify: `src/main.ts` (inject runtime id set in `onload`)
- Modify: `tests/catalog.test.ts` (rewrite `listCoreSections` test for the file-existence filter; add dynamic-id + injection tests)

**Interfaces:**
- Produces: `setCorePluginIds(ids: Iterable<string>): void`, `coreSettingsIds(): ReadonlySet<string>`, `corePluginFile(id: string): string`, exported `CORE_ID_SEED: string[]`.
- Removes exports: `CORE_PLUGIN_FILES`, `CORE_SETTINGS_IDS`.
- Consumes (from main.ts): `this.coreRuntime(): { id: string; name: string; enabled: boolean }[]` (already exists).

- [ ] **Step 1: Rewrite the failing/updated `listCoreSections` test + add new tests.** In `tests/catalog.test.ts`:

Replace the entire `describe("listCoreSections", …)` block (currently lines ~76-98) with:

```ts
describe("listCoreSections", () => {
  const cores = [
    { id: "graph", name: "Graph view", enabled: true },
    { id: "templates", name: "Templates", enabled: false },
    { id: "properties", name: "Properties", enabled: true },
    { id: "sync", name: "Sync", enabled: false },
    { id: "switcher", name: "Quick switcher", enabled: true }, // runtime id NOT in the seed
  ];

  it("lists only cores whose settings file exists, split by enabled state, with caution on sync", async () => {
    const io = new MemFS();
    // graph.json, types.json (properties), sync.json, switcher.json exist; templates.json does NOT
    io.seed({
      ".obs/core-plugins.json": "{}",
      ".obs/graph.json": "{}",
      ".obs/types.json": "{}",
      ".obs/sync.json": "{}",
      ".obs/switcher.json": "{}",
    });
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("core-plugins");
    // switcher is picked up dynamically even though it is not in CORE_ID_SEED
    expect(byBucket["enabled"]?.items.map((i) => i.name).sort()).toEqual(["graph", "properties", "switcher"]);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "switcher")?.path).toBe("{configDir}/switcher.json");
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.path).toBe("{configDir}/types.json");
    // sync.json exists → disabled + caution; templates.json absent → excluded by the file filter
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["sync"]);
    expect(byBucket["disabled"]?.items.find((i) => i.name === "sync")?.cautionReason).not.toBeNull();
    expect(sections.some((s) => s.items.some((i) => i.name === "templates"))).toBe(false);
  });

  it("excludes a core whose settings file is absent", async () => {
    const io = new MemFS();
    io.seed({ ".obs/core-plugins.json": "{}" }); // no per-core files
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["enabled"]).toBeUndefined();
    expect(byBucket["disabled"]).toBeUndefined();
  });
});

describe("setCorePluginIds injection", () => {
  afterEach(() => setCorePluginIds(CORE_ID_SEED)); // restore seed so test order is independent

  it("recognizes an injected non-seed core id in pure judgments", () => {
    expect(categoryForGroup("switcher")).toBe("custom"); // not in seed yet
    expect(expectedPathForName("switcher")).toBe(null);
    setCorePluginIds(["switcher"]);
    expect(categoryForGroup("switcher")).toBe("core");
    expect(expectedPathForName("switcher")).toBe("{configDir}/switcher.json");
    expect(reservedNames([]).has("switcher")).toBe(true);
  });
});
```

Add `setCorePluginIds` and `CORE_ID_SEED` to the existing import from `../src/core/catalog` at the top of the test file (alongside `categoryForGroup`, `corePluginFile`, `expectedPathForName`, `reservedNames`, `listCoreSections`, etc.), and ensure `afterEach` is imported from `vitest`.

- [ ] **Step 2: Run the tests to confirm they fail** (old code still has the hardcoded list / no injection API).

Run: `npm test -- catalog 2>&1 | tail -20`
Expected: FAIL — `setCorePluginIds`/`CORE_ID_SEED` not exported (import error) and/or `listCoreSections` still includes `templates`.

- [ ] **Step 3: Split the map and add the injected set in `catalog.ts`.** Replace the current block (lines ~46-66: `CORE_PLUGIN_FILES`, `CORE_SETTINGS_IDS`, `CORE_NOT_RECOMMENDED`, `corePluginFile`) with:

```ts
// The ONLY core plugin whose settings file is not `${id}.json`.
const CORE_FILE_EXCEPTIONS: Record<string, string> = { properties: "types.json" };

// Seed fallback for the injected core-id set. Overwritten by the runtime list at plugin load
// (main.ts calls setCorePluginIds), so a stale seed never affects production — it only covers
// unit tests and any pre-injection call. New core plugins are picked up from runtime, not here.
export const CORE_ID_SEED = [
  "graph", "backlink", "canvas", "page-preview", "daily-notes", "templates",
  "zk-prefixer", "bookmarks", "command-palette", "properties", "sync", "publish", "workspaces",
];
export const CORE_NOT_RECOMMENDED = ["sync", "publish"];

let coreIds: Set<string> = new Set(CORE_ID_SEED);

// Injected by main.ts at load with the running Obsidian's core-plugin id set.
export function setCorePluginIds(ids: Iterable<string>): void {
  coreIds = new Set(ids);
}

export function coreSettingsIds(): ReadonlySet<string> {
  return coreIds;
}

export function corePluginFile(id: string): string {
  return CORE_FILE_EXCEPTIONS[id] ?? `${id}.json`;
}

function coreFileSet(): Set<string> {
  const s = new Set<string>();
  for (const id of coreIds) s.add(corePluginFile(id));
  return s;
}
```

- [ ] **Step 4: Update the pure judgments to read `coreSettingsIds()`.** In `catalog.ts`:

  - `reservedNames` — change `for (const id of CORE_SETTINGS_IDS) names.add(id);` to `for (const id of coreSettingsIds()) names.add(id);`
  - `expectedPathForName` — change `if (CORE_SETTINGS_IDS.includes(name)) return …` to `if (coreSettingsIds().has(name)) return \`{configDir}/${corePluginFile(name)}\`;`
  - `defaultGroupForName` — change `if (CORE_SETTINGS_IDS.includes(name)) {` to `if (coreSettingsIds().has(name)) {`
  - `categoryForGroup` — change `if (CORE_SETTINGS_IDS.includes(name)) return "core";` to `if (coreSettingsIds().has(name)) return "core";`
  - `displayLabelForGroup` — change `if (CORE_SETTINGS_IDS.includes(name)) return plugins.getCorePluginName(name) ?? storedLabel ?? name;` to `if (coreSettingsIds().has(name)) return plugins.getCorePluginName(name) ?? storedLabel ?? name;`

- [ ] **Step 5: Replace `CORE_FILE_SET` usage in `listDiscovered`.** Delete the module-level `const CORE_FILE_SET = new Set(Object.values(CORE_PLUGIN_FILES));` (line ~119). In `listDiscovered`, after `const { files } = await presentSets(io, configDir);`, add `const coreFiles = coreFileSet();` and change the filter test `CORE_FILE_SET.has(b)` to `coreFiles.has(b)`.

- [ ] **Step 6: Rewrite `listCoreSections`.** Replace the enabled/disabled build loop (the `const byId = …` line through the `for (const id of CORE_SETTINGS_IDS) { … }` loop, lines ~205-234) with:

```ts
  const enabled: CatalogItem[] = [];
  const disabled: CatalogItem[] = [];
  for (const core of cores) {
    const file = corePluginFile(core.id);
    if (!files.has(file)) continue; // approach A: no settings file → nothing to sync
    const item: CatalogItem = {
      name: core.id,
      label: core.name,
      description: null,
      path: `{configDir}/${file}`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: CORE_NOT_RECOMMENDED.includes(core.id) ? CORE_CAUTION : null,
    };
    (core.enabled ? enabled : disabled).push(item);
  }
```

Leave the `switchItem`, the `sort`, and the `return [...]` sections unchanged.

- [ ] **Step 7: Swap the call site in `availability.ts`.** Change the import (line 2) from `import { CORE_SETTINGS_IDS } from "./catalog";` to `import { coreSettingsIds } from "./catalog";`, and line 58 from `const isCore = CORE_SETTINGS_IDS.includes(group.name);` to `const isCore = coreSettingsIds().has(group.name);`

- [ ] **Step 8: Inject the runtime id set in `main.ts`.** Add `setCorePluginIds` to the existing catalog import (line ~23: `import { type CatalogSection, displayLabelForGroup, listCoreSections, listDiscovered, listOptionSections, listPluginSections, setCorePluginIds } from "./core/catalog";`). In `onload`, immediately after `await this.loadSettings();` (line ~83), add:

```ts
    setCorePluginIds(this.coreRuntime().map((c) => c.id));
```

- [ ] **Step 9: Run the catalog tests to verify they pass.**

Run: `npm test -- catalog 2>&1 | tail -20`
Expected: PASS (new `listCoreSections`, injection, and existing pure-fn tests all green).

- [ ] **Step 10: Full gate.**

Run: `npm test 2>&1 | grep Tests`
Expected: `Tests  <205-ish> passed` (202 baseline + the added tests; no failures).

Run: `npm run build && npm run lint 2>&1 | grep -E "error|problem" ; ./scripts/check-no-hardcoded-color.sh`
Expected: build clean; lint `0 errors` (warnings at/near 65 baseline); color check passes.

- [ ] **Step 11: Commit.**

```bash
git add src/core/catalog.ts src/core/availability.ts src/main.ts tests/catalog.test.ts
git commit -m "feat: enumerate core plugins from runtime, not a hardcoded list"
```

---

### Task 2: Smoke — Quick switcher appears in the Sync Center

**Files:** none (controller-run verification in the dev vault).

- [ ] **Step 1: Deploy + vault guard.** `npm run smoke:install`. Run the vault-name guard: `obsidian-cli eval vault=vault code="app.vault.getName()"` must print `=> vault`; on mismatch, `open "obsidian://open?vault=vault"`, re-check, never proceed on mismatch.
- [ ] **Step 2: Ensure a `switcher.json` exists.** Confirm the Quick switcher core plugin has written `dev/vault/.obsidian/switcher.json` (open its settings once in the dev vault if absent, or write a minimal `{}` there). Reload the plugin (disable/enable `config-sync`) so `onload` injects the runtime id set.
- [ ] **Step 3: Verify listing.** Open the Sync Center → Obsidian/Core tab. Confirm **Quick switcher** appears (Enabled if the plugin is on), with no console error frames (`obsidian-cli dev:errors` shows no config-sync frame). Before this change it was absent.
- [ ] **Step 4: Verify classification.** Enable `switcher` sync, confirm `config-sync/config-sync.json` records a group `switcher` with path `{configDir}/switcher.json` and (after a refresh) label `Quick switcher`; confirm it renders under the Core category, not Custom. Record the result in the ledger.

---

## Self-Review Notes

- Spec coverage: split map + exceptions → Step 3; injected set + accessor → Step 3; pure-judgment swaps → Steps 4-5, 7; `listCoreSections` filter (approach A) → Step 6; main.ts injection → Step 8; tests (existing green via seed, new dynamic-id + injection + filter) → Steps 1, 9-10; smoke → Task 2.
- Type consistency: `coreSettingsIds()` returns `ReadonlySet<string>` (callers use `.has`/iteration only); `setCorePluginIds(ids: Iterable<string>)` matches `this.coreRuntime().map((c) => c.id)` (string[]) and `CORE_ID_SEED` (string[]); `corePluginFile` unchanged signature.
- Behavior-change guard: the rewritten `listCoreSections` test (Step 1) asserts the new filter (templates excluded when its file is absent; switcher included when present) rather than the old `exists:false` display — the one intentional behavior change from the spec.
- Post-plan flow (standing user instruction): after Tasks 1-2, hand to the user for pre-merge acceptance; merge + cut only after the user verifies.
