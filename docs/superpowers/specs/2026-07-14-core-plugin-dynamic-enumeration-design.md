# Dynamic Core-Plugin Enumeration (0.22.x)

Stop hand-maintaining the list of Obsidian core plugins. Recognize any core plugin the
running Obsidian ships — present or future — so a core plugin like **Quick switcher**
(`switcher`) that was simply missing from the hardcoded list now appears and is classified,
labeled, and path-validated correctly.

## Problem

`catalog.ts` carries a hardcoded `CORE_PLUGIN_FILES` map of 13 core-plugin ids → settings
files, and derives `CORE_SETTINGS_IDS = Object.keys(CORE_PLUGIN_FILES)` from it. That id list
is the sole source of truth for every core-plugin judgment:

- **Listing** — `listCoreSections` iterates `CORE_SETTINGS_IDS` and looks each up in the
  runtime `cores` param; a core plugin present at runtime but absent from the hardcoded list is
  silently skipped. This is why **Quick switcher (`switcher`, file `switcher.json`) never
  appears** — it was simply omitted from the list.
- **Pure judgments** — `reservedNames`, `expectedPathForName`, `defaultGroupForName`,
  `categoryForGroup`, `displayLabelForGroup` (catalog.ts) and `availability.ts:58` all test
  `CORE_SETTINGS_IDS.includes(name)`. An unrecognized core id falls through:
  `categoryForGroup` returns `"custom"`, `expectedPathForName` returns `null`,
  `displayLabelForGroup` misses the runtime core name. So even if a `switcher` group were
  created, it would be miscategorized, unvalidated, and mislabeled.

The runtime already has the full truth: `main.ts`'s `coreRuntime()` returns every entry of
`app.internalPlugins.plugins` as `{ id, name, enabled }[]`, and that array is already passed to
`listCoreSections`. The hardcoded list is redundant with — and staler than — runtime.

## Design

Two coordinated parts: the visible listing fix (uses the runtime param already in hand) and the
pure-judgment fix (an injected module-level id set, since pure functions have no runtime handle).

### catalog.ts — split the hardcoded map into two concerns

`CORE_PLUGIN_FILES` conflated two things: the *id list* (its keys) and the *filename mapping*
(its values). Split them:

```ts
// The ONLY core plugin whose settings file is not `${id}.json`.
const CORE_FILE_EXCEPTIONS: Record<string, string> = { properties: "types.json" };

// Seed fallback for the injected core-id set (below). Overwritten by the runtime list at
// plugin load, so a stale seed never affects production — it only covers unit tests and any
// pre-injection call. Not authoritative: new core plugins are picked up from runtime, not here.
const CORE_ID_SEED = [
  "graph", "backlink", "canvas", "page-preview", "daily-notes", "templates",
  "zk-prefixer", "bookmarks", "command-palette", "properties", "sync", "publish", "workspaces",
];

export function corePluginFile(id: string): string {
  return CORE_FILE_EXCEPTIONS[id] ?? `${id}.json`;
}
```

`CORE_NOT_RECOMMENDED = ["sync", "publish"]` stays hardcoded — it is a semantic caution list,
not an enumeration.

### Injected module-level id set (Part 2 — pure judgments)

```ts
let coreIds: Set<string> = new Set(CORE_ID_SEED);

// Called by main.ts at plugin load with the runtime core-plugin id set.
export function setCorePluginIds(ids: Iterable<string>): void {
  coreIds = new Set(ids);
}

export function coreSettingsIds(): ReadonlySet<string> {
  return coreIds;
}
```

Replace every `CORE_SETTINGS_IDS.includes(name)` with `coreSettingsIds().has(name)`, and the
`for (const id of CORE_SETTINGS_IDS)` loop in `reservedNames` with `for (const id of
coreSettingsIds())`. Affected functions: `reservedNames`, `expectedPathForName`,
`defaultGroupForName`, `categoryForGroup`, `displayLabelForGroup` (catalog.ts) and the `isCore`
check in `availability.ts:58` (import `coreSettingsIds` instead of `CORE_SETTINGS_IDS`).

`listDiscovered`'s `CORE_FILE_SET` (used to exclude core files from the "discovered" list)
becomes derived from the injected set at call time:

```ts
function coreFileSet(): Set<string> {
  const s = new Set<string>();
  for (const id of coreIds) s.add(corePluginFile(id));
  return s;
}
```

The exported `CORE_SETTINGS_IDS` const is removed; nothing outside catalog.ts imports it except
`availability.ts`, which switches to `coreSettingsIds()`.

### listCoreSections (Part 1 — the visible fix, approach A)

Iterate the runtime `cores` param instead of the hardcoded ids, and include a core **only when
its expected settings file exists** in configDir:

```ts
const enabled: CatalogItem[] = [];
const disabled: CatalogItem[] = [];
for (const core of cores) {
  const file = corePluginFile(core.id);
  if (!files.has(file)) continue; // approach A: no settings file → nothing to sync, skip
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

The file-existence filter is what makes iterating the *full* runtime list safe:
`internalPlugins.plugins` includes ~a dozen UI-only core plugins (file-explorer, global-search,
outline, tag-pane, word-count, …) that never write a settings file. Filtering to cores whose
file is present keeps the list to genuinely syncable settings — and surfaces `switcher` (and any
future core plugin) whose file exists.

Behavior change vs today: a core plugin whose settings file does **not** exist yet no longer
appears with `exists: false`. That is acceptable — an absent file has nothing to capture, and
with a dynamic list, file-existence is the proxy for "this core plugin has settings worth
syncing" (the hardcoded list previously encoded that knowledge by hand). The `switchItem`
(core-plugins.json on/off list) and the enabled/disabled section structure are unchanged.

### main.ts — inject at load

In `onload`, after the plugin is constructed and before the first status refresh, inject the
runtime id set:

```ts
setCorePluginIds(this.coreRuntime().map((c) => c.id));
```

The core-plugin *id set* only changes when Obsidian itself adds or removes a core plugin — an
app upgrade, which reloads the plugin and re-runs `onload`. So injecting once at load is
sufficient; enabled/disabled state (which does change at runtime) is read live via the `cores`
param on each `listCoreSections` call, not from the injected set. `internalPlugins.plugins` is
populated synchronously by the time `onload` runs; if verification shows it empty at `onload`,
move the call to the start of the `onLayoutReady` callback (still before the first
`refreshLocalStatus`).

## Edge cases

- **Seed vs runtime divergence:** the seed is only a fallback. In production `setCorePluginIds`
  overwrites it at load, so runtime is authoritative and a stale seed cannot cause a wrong
  production judgment. Unit tests that don't inject see the 13 seed ids (today's behavior).
- **`properties` exception:** `corePluginFile("properties")` → `types.json` via
  `CORE_FILE_EXCEPTIONS`; every other id → `${id}.json`. `switcher` → `switcher.json`.
- **Non-recommended cores (`sync`, `publish`):** still get `CORE_CAUTION`; their files only
  exist when configured, so the filter shows them only when relevant.
- **A group named for a core id not in the runtime set** (e.g. a manifest carried from another
  Obsidian build): after injection `coreSettingsIds()` reflects *this* device's runtime, so such
  a group classifies as `"custom"` — correct, since that core plugin isn't present here.
- **UI-only core plugins** (no settings file): excluded from `listCoreSections` by the filter,
  and never become groups, so their presence in the injected id set is harmless.

## Testing

- Existing `catalog.test.ts` pure-function tests (e.g. `reservedNames(["dataview"])` expects
  `graph`/`properties`; `expectedPathForName("graph")` → `graph.json`, `("properties")` →
  `types.json`; `corePluginFile` map + fallback; `defaultGroupForName` core cases) stay green
  unchanged via the seed. No mocking needed for these.
- **New — listing picks up a runtime-only core:** `listCoreSections` with `cores` including
  `{ id: "switcher", name: "Quick switcher", enabled: true }` and `switcher.json` seeded →
  `switcher` appears in Enabled with path `{configDir}/switcher.json`. Without `switcher.json`
  seeded → `switcher` is excluded (file-existence filter).
- **New — injection affects pure judgments:** after `setCorePluginIds(["switcher"])`,
  `expectedPathForName("switcher")` → `{configDir}/switcher.json` and
  `categoryForGroup("switcher")` → `"core"`; reset injection afterward so test order is
  independent (restore the seed via `setCorePluginIds(CORE_ID_SEED)` in an `afterEach`, or
  export the seed for tests).
- Node suite grows by a few tests from 202; build, lint (0 errors / 65 warnings baseline), and
  `check-no-hardcoded-color.sh` stay clean.

## Scope

`src/core/catalog.ts` (the split, injected set, six call-site updates, `listCoreSections`
rewrite), `src/core/availability.ts` (one call-site swap), `src/main.ts` (one injection call),
`tests/catalog.test.ts` (new filter + injection tests). No UI, no user-facing copy change. This
is item 2 of the post-0.21.0 backlog; the remaining items (Remotes UX, Sync Center checkbox
presentation, capture/pull interruption robustness, and the deferred self-config-propagation
model) are separate specs.
