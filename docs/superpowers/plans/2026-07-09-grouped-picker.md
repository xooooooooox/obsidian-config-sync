# grouped-picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regroup the settings picker into per-state buckets across a new six-tab layout (adding Core plugins), shift group identity from path to a stable `name` key with reserved-name validation, add per-group Sync all/none, an Advanced lock with provenance badges, and global search — per the spec at `docs/superpowers/specs/2026-07-09-grouped-picker-design.md`.

**Architecture:** `src/core/catalog.ts` is rewritten to return `CatalogSection[]` (bucketed, headed, ordered) built from two small hardcoded tables (`OPTION_LABELS`, `CORE_PLUGIN_FILES`) plus injected runtime state; group identity becomes the reserved `name` (`findGroupByName`, `expectedPathForName`, `reservedNames`), enforced in `src/core/manifest.ts`. `src/main.ts` collects core/community plugin runtime state; `src/ui/SettingTab.ts` grows the Core plugins tab, section rendering, Sync all/none, Advanced lock+provenance, and a global search box.

**Tech Stack:** unchanged (TypeScript strict, esbuild/eslint from template vendor upstream, vitest, Obsidian API).

## Global Constraints

- All prior constraints hold: mobile I/O red line (src/core imports no Node/`obsidian`), plugin-dir blacklist incl. ancestors, strict tsconfig with `noUncheckedIndexedAccess`, explicit errors, JSON 2-space + trailing newline, `{configDir}` never rendered in the UI, form rules (text onChange never re-renders; `refresh()` keeps drafts + restores scroll; `display()` reloads + resets activeTab/search; render-generation guard; PKM change / Data-folder blur reload).
- **Hardcoding minimized (spec B):** `OPTION_LABELS` ≈7 entries (global option files + 2 switch lists → friendly label); `CORE_PLUGIN_FILES` = a ~12-entry id→file map (needed because Obsidian exposes no id→file signal and acceptance #4 needs not-present core rows). Core/community plugin NAMES come from runtime (`instance.name` / `manifests[id].name`), never hardcoded.
- **Identity is `name` (spec H):** picker items have fixed reserved names (option = label-key like `app`/`hotkeys`; switch lists `core-plugins`/`community-plugins`; core plugin = its id; community = `plugin-<id>`). Checked ⇔ a group with that name exists (`findGroupByName`), not path. No slug dedup. Reserved-name-with-wrong-path is rejected in `validateSyncManifest`.
- **Buckets (spec C):** Obsidian → available / notPresent / notRecommended; Core → enabled / disabled / notRecommended (sync, publish); Community → enabled / disabled / notRecommended (blacklist). Empty sections omitted. Not-recommended sections have `allowSyncAll: false`.
- **Advanced (spec I):** two groups Managed-by-pickers (reserved name; locked by default, unlock to edit) vs Custom rules; a managed group whose `path` ≠ `expectedPathForName(name)` is "customized" — badged in Advanced and on its picker row.
- **Search (spec J):** top search box; while non-empty, hide tabs and show a flat cross-tab list of matches (by name / label / path substring, case-insensitive), each labelled with its origin tab·section; no Sync all in search results; cleared on `display()`.
- Repo: https://github.com/xooooooooox/obsidian-config-sync . Branch `feat/grouped-picker` created from `main` at execution time. All commands run from the repo root.

## File Structure

```
src/core/catalog.ts   # REWRITE: OPTION_LABELS + CORE_PLUGIN_FILES tables; CatalogItem gains name/bucket;
                      #   CatalogSection; listOptionSections / listCoreSections / listPluginSections;
                      #   reservedNames / expectedPathForName / findGroupByName / groupForItem(name,...);
                      #   toggleSection (batch); splitLocation/joinLocation kept
src/core/manifest.ts  # assertNotBlacklisted → also reject reserved-name-with-wrong-path (needs catalog import? NO —
                      #   keep core dependency-free: pass a reserved-name map into validateSyncManifest via a
                      #   module-level registry set by catalog at import time). See Task 3 for the exact seam.
src/main.ts           # host methods: coreRuntime() / pluginRuntime(); listCoreSections/listOptionSections/listPluginSections
src/ui/SettingTab.ts  # Core plugins tab; section rendering; Sync all/none; Advanced lock+provenance; search box
styles.css            # section heading, sync-all button, lock, customized badge, search box styles
tests/catalog.test.ts # REWRITE around sections + name identity
tests/manifest.test.ts# reserved-name validation
README.md / CLAUDE.md # six-tab + search + lock docs
```

**Naming/identity reference (used across tasks — exact values):**

- `OPTION_LABELS` (file → {label, description, type}): `app.json`→"Editor & general", `appearance.json`→"Appearance", `hotkeys.json`→"Hotkeys", `themes`(dir)→"Themes", `snippets`(dir)→"CSS snippets", `core-plugins.json`→"Enabled core plugins", `community-plugins.json`→"Enabled community plugins".
- `CORE_PLUGIN_FILES` (core id → settings file — a full explicit map, because Obsidian exposes no id→file signal and acceptance #4 needs not-present core rows): `graph`→`graph.json`, `backlink`→`backlink.json`, `canvas`→`canvas.json`, `page-preview`→`page-preview.json`, `daily-notes`→`daily-notes.json`, `templates`→`templates.json`, `zk-prefixer`→`zk-prefixer.json`, `bookmarks`→`bookmarks.json`, `command-palette`→`command-palette.json`, `properties`→`types.json`, `sync`→`sync.json`, `publish`→`publish.json`. `corePluginFile(id)` returns the map value or `<id>.json` fallback. Core plugin NAMES still come from runtime `instance.name`, never this table.
- `CORE_NOT_RECOMMENDED` (core ids): `["sync", "publish"]`.
- Reserved name for an option file `f` = `f` minus `.json` (dir names as-is): `app`, `appearance`, `hotkeys`, `themes`, `snippets`, `core-plugins`, `community-plugins`. For a core plugin id `c` = `c`. For a community plugin id `p` = `plugin-<p>`.
- `expectedPathForName`: option name `n` → `{configDir}/<file>` (reverse of OPTION_LABELS); core name `c` → `{configDir}/<CORE_PLUGIN_FILE(c)>`; `plugin-<p>` → `{configDir}/plugins/<p>/data.json`.

---

### Task 1: catalog tables + name/path helpers (pure)

**Files:**
- Modify: `src/core/catalog.ts` (add tables + helpers; keep existing exports until Task 2 rewrites the list functions)
- Test: `tests/catalog.test.ts` (append a new describe block; do not touch existing tests yet)

**Interfaces:**
- Consumes: `SyncGroup` from `./types`, `BLACKLISTED_PLUGIN_DIRS` from `./manifest`.
- Produces (Tasks 2–7 rely on these):
  - `OPTION_LABELS: Record<string, { label: string; description: string; type: "file" | "dir" }>`
  - `CORE_PLUGIN_FILES: Record<string, string>`; `corePluginFile(id: string): string`; `CORE_SETTINGS_IDS: string[]` (= `Object.keys(CORE_PLUGIN_FILES)`)
  - `CORE_NOT_RECOMMENDED: string[]`
  - `optionReservedName(file: string): string` (strip `.json`)
  - `reservedNames(pluginIds: string[]): Set<string>` (options + `CORE_SETTINGS_IDS` + `plugin-<id>`)
  - `expectedPathForName(name: string): string | null` (uses `CORE_SETTINGS_IDS` internally)
  - `findGroupByName(groups: SyncGroup[], name: string): SyncGroup | undefined`

- [ ] **Step 1: Append the failing tests to `tests/catalog.test.ts`**

Add these imports to the existing import line: `corePluginFile, expectedPathForName, findGroupByName, optionReservedName, reservedNames`. Then append:

```ts
describe("name and path helpers", () => {
  it("corePluginFile reads the map, with an <id>.json fallback", () => {
    expect(corePluginFile("graph")).toBe("graph.json");
    expect(corePluginFile("properties")).toBe("types.json");
    expect(corePluginFile("brand-new-core")).toBe("brand-new-core.json");
  });

  it("optionReservedName strips the .json extension, keeps dir names", () => {
    expect(optionReservedName("app.json")).toBe("app");
    expect(optionReservedName("snippets")).toBe("snippets");
  });

  it("reservedNames unions option, core-settings and community identities", () => {
    const names = reservedNames(["dataview"]);
    expect(names.has("app")).toBe(true);
    expect(names.has("graph")).toBe(true);
    expect(names.has("properties")).toBe(true);
    expect(names.has("plugin-dataview")).toBe(true);
    expect(names.has("core-plugins")).toBe(true);
    expect(names.has("nope")).toBe(false);
  });

  it("expectedPathForName maps each identity kind back to its path", () => {
    expect(expectedPathForName("app")).toBe("{configDir}/app.json");
    expect(expectedPathForName("snippets")).toBe("{configDir}/snippets");
    expect(expectedPathForName("graph")).toBe("{configDir}/graph.json");
    expect(expectedPathForName("properties")).toBe("{configDir}/types.json");
    expect(expectedPathForName("plugin-dataview")).toBe("{configDir}/plugins/dataview/data.json");
    expect(expectedPathForName("not-a-known-name")).toBe(null);
  });

  it("findGroupByName matches on name, not path", () => {
    const groups: SyncGroup[] = [{ name: "graph", path: "{configDir}/custom.json", type: "file", devices: "all" }];
    expect(findGroupByName(groups, "graph")?.path).toBe("{configDir}/custom.json");
    expect(findGroupByName(groups, "app")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — the new helpers are not exported.

- [ ] **Step 3: Add tables + helpers to `src/core/catalog.ts`** (append after the existing `WORKSPACE_CAUTION` block; leave the old `KNOWN_OPTIONS` and list functions in place for now)

```ts
export const OPTION_LABELS: Record<string, { label: string; description: string; type: "file" | "dir" }> = {
  "app.json": { label: "Editor & general", description: "Editor and general options.", type: "file" },
  "appearance.json": { label: "Appearance", description: "Theme choice, fonts and interface appearance.", type: "file" },
  "hotkeys.json": { label: "Hotkeys", description: "Custom keyboard shortcuts.", type: "file" },
  themes: { label: "Themes", description: "Installed theme files.", type: "dir" },
  snippets: { label: "CSS snippets", description: "Your CSS snippets.", type: "dir" },
  "core-plugins.json": {
    label: "Enabled core plugins",
    description: "Which core plugins are turned on. Mirrors the whole list across devices.",
    type: "file",
  },
  "community-plugins.json": {
    label: "Enabled community plugins",
    description:
      "Which community plugins are turned on — not the plugins themselves or their settings. Mirrors the whole list: plugins enabled only on the target device get turned off.",
    type: "file",
  },
};

export const CORE_PLUGIN_FILES: Record<string, string> = {
  graph: "graph.json",
  backlink: "backlink.json",
  canvas: "canvas.json",
  "page-preview": "page-preview.json",
  "daily-notes": "daily-notes.json",
  templates: "templates.json",
  "zk-prefixer": "zk-prefixer.json",
  bookmarks: "bookmarks.json",
  "command-palette": "command-palette.json",
  properties: "types.json",
  sync: "sync.json",
  publish: "publish.json",
};
export const CORE_SETTINGS_IDS = Object.keys(CORE_PLUGIN_FILES);
export const CORE_NOT_RECOMMENDED = ["sync", "publish"];

export function corePluginFile(id: string): string {
  return CORE_PLUGIN_FILES[id] ?? `${id}.json`;
}

export function optionReservedName(file: string): string {
  return file.endsWith(".json") ? file.slice(0, -".json".length) : file;
}

export function reservedNames(pluginIds: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of Object.keys(OPTION_LABELS)) names.add(optionReservedName(file));
  for (const id of CORE_SETTINGS_IDS) names.add(id);
  for (const id of pluginIds) names.add(`plugin-${id}`);
  return names;
}

export function expectedPathForName(name: string): string | null {
  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return `{configDir}/${meta.type === "dir" ? name : file}`;
  }
  if (name.startsWith("plugin-")) return `{configDir}/plugins/${name.slice("plugin-".length)}/data.json`;
  if (CORE_SETTINGS_IDS.includes(name)) return `{configDir}/${corePluginFile(name)}`;
  return null;
}

export function findGroupByName(groups: SyncGroup[], name: string): SyncGroup | undefined {
  return groups.find((g) => g.name === name);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS (existing tests + 5 new). Full suite `npm test` still green; `npm run build` / `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/catalog.ts tests/catalog.test.ts
git commit -m "feat: catalog identity tables and name/path helpers"
```

---

### Task 2: catalog sections + identity-based group ops (pure)

**Files:**
- Modify: `src/core/catalog.ts` (replace `CatalogItem`/`PluginItem`/`KNOWN_OPTIONS`/`listOptionItems`/`listPluginItems`/`slugForPath`/`groupForItem`; keep `findGroupByPath`, `splitLocation`, `joinLocation`, `WORKSPACE_CAUTION`, and everything from Task 1)
- Test: `tests/catalog.test.ts` (replace the old `listOptionItems`/`listPluginItems`/`groupForItem`/`slug` describes with section tests; keep Task 1's describe)

**Interfaces:**
- Consumes: Task 1 exports; `FileIO` from `./io`; `SyncGroup` from `./types`; `BLACKLISTED_PLUGIN_DIRS` from `./manifest`.
- Produces (Tasks 3–8 rely on these exact shapes):
  - `interface CatalogItem { name: string; label: string; description: string | null; path: string; type: "file" | "dir"; exists: boolean; disabledReason: string | null; cautionReason: string | null }`
  - `interface CatalogSection { bucket: string; heading: string; description: string; allowSyncAll: boolean; items: CatalogItem[] }`
  - `listOptionSections(io: FileIO, configDir: string, groups: SyncGroup[]): Promise<CatalogSection[]>`
  - `listCoreSections(io: FileIO, configDir: string, cores: { id: string; name: string; enabled: boolean }[], groups: SyncGroup[]): Promise<CatalogSection[]>`
  - `listPluginSections(io: FileIO, configDir: string, plugins: { id: string; name: string; enabled: boolean }[], groups: SyncGroup[]): Promise<CatalogSection[]>`
  - `groupForItem(name: string, path: string, type: "file" | "dir", description: string | null): SyncGroup`
  - `toggleSection(groups: SyncGroup[], items: CatalogItem[], on: boolean): SyncGroup[]`

- [ ] **Step 1: Replace the list/group tests in `tests/catalog.test.ts`**

Delete the old `describe("listOptionItems", …)`, `describe("listPluginItems", …)`, `describe("slugForPath / groupForItem / findGroupByPath", …)` blocks. Keep `describe("name and path helpers", …)` (Task 1) and `describe("splitLocation / joinLocation", …)`. Update the top import to also pull `CatalogItem, listOptionSections, listCoreSections, listPluginSections, groupForItem, toggleSection`. Add:

```ts
function optionFs(): MemFS {
  const io = new MemFS();
  io.seed({
    ".obs/app.json": "{}",
    ".obs/appearance.json": "{}",
    ".obs/graph.json": "{}",           // core file — must NOT appear in options
    ".obs/workspace.json": "{}",
    ".obs/custom-unknown.json": "{}",
    ".obs/core-plugins-migration.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obs/plugins/demo/data.json": "{}",
  });
  return io;
}
const NO_GROUPS: SyncGroup[] = [];

describe("listOptionSections", () => {
  it("buckets known options by existence and puts workspace under Not recommended", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    const names = (b: string) => (byBucket[b]?.items ?? []).map((i) => i.name).sort();
    expect(names("available")).toEqual(["app", "appearance", "custom-unknown", "snippets"]);
    expect(names("notPresent")).toEqual(["hotkeys", "themes"]);
    expect(names("notRecommended")).toEqual(["workspace"]);
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
    expect(byBucket["available"]?.allowSyncAll).toBe(true);
  });

  it("excludes core files, plugins dir, switch lists and migration file from options", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const all = sections.flatMap((s) => s.items.map((i) => i.name));
    expect(all).not.toContain("graph");
    expect(all).not.toContain("plugins");
    expect(all).not.toContain("core-plugins");
    expect(all).not.toContain("core-plugins-migration");
  });

  it("marks the workspace item with a caution and keeps it tickable", async () => {
    const sections = await listOptionSections(optionFs(), ".obs", NO_GROUPS);
    const ws = sections.flatMap((s) => s.items).find((i) => i.name === "workspace");
    expect(ws?.cautionReason).toContain("device-specific");
    expect(ws?.disabledReason).toBe(null);
  });

  it("omits empty sections", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const sections = await listOptionSections(io, ".obs", NO_GROUPS);
    expect(sections.some((s) => s.bucket === "notRecommended")).toBe(false);
  });
});

describe("listCoreSections", () => {
  const cores = [
    { id: "graph", name: "Graph view", enabled: true },
    { id: "templates", name: "Templates", enabled: false },
    { id: "properties", name: "Properties", enabled: true },
    { id: "sync", name: "Sync", enabled: false },
  ];
  it("groups core settings by enabled state, sync under Not recommended, and reads runtime names", async () => {
    const io = new MemFS();
    io.seed({ ".obs/core-plugins.json": "{}", ".obs/graph.json": "{}", ".obs/types.json": "{}" });
    const sections = await listCoreSections(io, ".obs", cores, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("core-plugins");
    expect(byBucket["enabled"]?.items.map((i) => i.name).sort()).toEqual(["graph", "properties"]);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.label).toBe("Properties");
    expect(byBucket["enabled"]?.items.find((i) => i.name === "properties")?.path).toBe("{configDir}/types.json");
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["templates"]);
    expect(byBucket["notRecommended"]?.items.map((i) => i.name)).toEqual(["sync"]);
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
    expect(byBucket["enabled"]?.items.find((i) => i.name === "templates")).toBeUndefined();
    expect(byBucket["disabled"]?.items[0]?.exists).toBe(false); // templates.json not seeded
  });
});

describe("listPluginSections", () => {
  const plugins = [
    { id: "dataview", name: "Dataview", enabled: true },
    { id: "off-plugin", name: "Off Plugin", enabled: false },
    { id: "remotely-save", name: "Remotely Save", enabled: true },
  ];
  it("buckets community plugins by enabled/disabled/blacklist and leads with the switch list", async () => {
    const io = new MemFS();
    io.seed({ ".obs/community-plugins.json": "{}" });
    const sections = await listPluginSections(io, ".obs", plugins, NO_GROUPS);
    const byBucket = Object.fromEntries(sections.map((s) => [s.bucket, s]));
    expect(byBucket["list"]?.items[0]?.name).toBe("community-plugins");
    expect(byBucket["enabled"]?.items.map((i) => i.name)).toEqual(["plugin-dataview"]);
    expect(byBucket["disabled"]?.items.map((i) => i.name)).toEqual(["plugin-off-plugin"]);
    expect(byBucket["notRecommended"]?.items[0]?.name).toBe("plugin-remotely-save");
    expect(byBucket["notRecommended"]?.items[0]?.disabledReason).toContain("cannot be synced");
    expect(byBucket["notRecommended"]?.allowSyncAll).toBe(false);
  });
});

describe("groupForItem / toggleSection", () => {
  it("groupForItem uses the fixed name (no slug dedup) and attaches description when given", () => {
    expect(groupForItem("graph", "{configDir}/graph.json", "file", "Graph view")).toEqual({
      name: "graph",
      path: "{configDir}/graph.json",
      type: "file",
      devices: "all",
      description: "Graph view",
    });
    expect(groupForItem("app", "{configDir}/app.json", "file", null)).toEqual({
      name: "app",
      path: "{configDir}/app.json",
      type: "file",
      devices: "all",
    });
  });

  it("toggleSection adds groups for every tickable item, or removes them all", () => {
    const items: CatalogItem[] = [
      { name: "app", label: "Editor & general", description: "d", path: "{configDir}/app.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
      { name: "appearance", label: "Appearance", description: "d", path: "{configDir}/appearance.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
    ];
    const on = toggleSection([], items, true);
    expect(on.map((g) => g.name).sort()).toEqual(["app", "appearance"]);
    const off = toggleSection(on, items, false);
    expect(off).toEqual([]);
  });

  it("toggleSection(on) is idempotent and skips hard-disabled items", () => {
    const items: CatalogItem[] = [
      { name: "app", label: "l", description: null, path: "{configDir}/app.json", type: "file", exists: true, disabledReason: null, cautionReason: null },
      { name: "plugin-x", label: "l", description: null, path: "{configDir}/plugins/x/data.json", type: "file", exists: true, disabledReason: "blocked", cautionReason: null },
    ];
    const start: SyncGroup[] = [{ name: "app", path: "{configDir}/app.json", type: "file", devices: "all" }];
    const result = toggleSection(start, items, true);
    expect(result.map((g) => g.name)).toEqual(["app"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — section functions and new `groupForItem`/`toggleSection` don't exist.

- [ ] **Step 3: Rewrite the item/section layer in `src/core/catalog.ts`**

Replace the old `CatalogItem`, `PluginItem`, `KNOWN_OPTIONS`, `listOptionItems`, `listPluginItems`, `slugForPath`, `groupForItem` with:

```ts
export interface CatalogItem {
  name: string;
  label: string;
  description: string | null;
  path: string;
  type: "file" | "dir";
  exists: boolean;
  disabledReason: string | null;
  cautionReason: string | null;
}

export interface CatalogSection {
  bucket: string;
  heading: string;
  description: string;
  allowSyncAll: boolean;
  items: CatalogItem[];
}

const CORE_FILE_SET = new Set(Object.values(CORE_PLUGIN_FILES));
const SWITCH_LISTS = new Set(["core-plugins.json", "community-plugins.json"]);
const BLACKLIST_REASON = "Machine-bound or credential-bearing — cannot be synced.";
const CORE_CAUTION = "Contains account or device-specific data — not meant to travel between vaults.";

function section(bucket: string, heading: string, description: string, allowSyncAll: boolean, items: CatalogItem[]): CatalogSection[] {
  return items.length > 0 ? [{ bucket, heading, description, allowSyncAll, items }] : [];
}

async function presentSets(io: FileIO, configDir: string): Promise<{ files: Set<string>; dirs: Set<string> }> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (await io.exists(configDir)) {
    const listed = await io.list(configDir);
    for (const f of listed.files) files.add(basename(f));
    for (const d of listed.folders) dirs.add(basename(d));
  }
  return { files, dirs };
}

export async function listOptionSections(io: FileIO, configDir: string, _groups: SyncGroup[]): Promise<CatalogSection[]> {
  const { files, dirs } = await presentSets(io, configDir);
  const available: CatalogItem[] = [];
  const notPresent: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  const covered = new Set<string>();

  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (SWITCH_LISTS.has(file)) continue; // switch lists live in Core/Community tabs
    covered.add(file);
    const isDir = meta.type === "dir";
    const present = isDir ? dirs.has(file) : files.has(file);
    const item: CatalogItem = {
      name: optionReservedName(file),
      label: meta.label,
      description: meta.description,
      path: `{configDir}/${file}`,
      type: meta.type,
      exists: present,
      disabledReason: null,
      cautionReason: null,
    };
    (present ? available : notPresent).push(item);
  }

  for (const b of [...files].sort()) {
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    const workspace = WORKSPACE_RE.test(b);
    const item: CatalogItem = {
      name: optionReservedName(b),
      label: b,
      description: null,
      path: `{configDir}/${b}`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: workspace ? WORKSPACE_CAUTION : null,
    };
    (workspace ? notRecommended : available).push(item);
    covered.add(b);
  }
  for (const b of [...dirs].sort()) {
    if (covered.has(b) || HIDDEN_DIRS.has(b)) continue;
    available.push({ name: b, label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null, cautionReason: null });
    covered.add(b);
  }

  return [
    ...section("available", "Available", "Ready to sync — these settings already exist in this vault.", true, available),
    ...section("notPresent", "Not yet in this vault", "You haven't customized these yet, so there's nothing to sync until you do.", true, notPresent),
    ...section("notRecommended", "Not recommended", "Tied to this specific device — syncing makes your devices fight over each other.", false, notRecommended),
  ];
}

export async function listCoreSections(
  io: FileIO,
  configDir: string,
  cores: { id: string; name: string; enabled: boolean }[],
  _groups: SyncGroup[]
): Promise<CatalogSection[]> {
  const { files } = await presentSets(io, configDir);
  const byId = new Map(cores.map((c) => [c.id, c]));
  const switchItem: CatalogItem = {
    name: "community-plugins" === "core-plugins" ? "" : "core-plugins", // placeholder replaced below
    label: OPTION_LABELS["core-plugins.json"]!.label,
    description: OPTION_LABELS["core-plugins.json"]!.description,
    path: "{configDir}/core-plugins.json",
    type: "file",
    exists: files.has("core-plugins.json"),
    disabledReason: null,
    cautionReason: null,
  };
  switchItem.name = "core-plugins";

  const enabled: CatalogItem[] = [];
  const disabled: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  for (const id of CORE_SETTINGS_IDS) {
    const core = byId.get(id);
    if (core === undefined) continue; // core plugin absent in this Obsidian build
    const file = corePluginFile(id);
    const item: CatalogItem = {
      name: id,
      label: core.name,
      description: null,
      path: `{configDir}/${file}`,
      type: "file",
      exists: files.has(file),
      disabledReason: null,
      cautionReason: CORE_NOT_RECOMMENDED.includes(id) ? CORE_CAUTION : null,
    };
    if (CORE_NOT_RECOMMENDED.includes(id)) notRecommended.push(item);
    else (core.enabled ? enabled : disabled).push(item);
  }
  const sort = (a: CatalogItem, b: CatalogItem) => a.label.localeCompare(b.label);
  enabled.sort(sort);
  disabled.sort(sort);
  notRecommended.sort(sort);

  return [
    ...section("list", "Plugin on/off list", "Which core plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Turned on here.", true, enabled),
    ...section("disabled", "Disabled", "Turned off — you can still sync its settings for when you enable it.", true, disabled),
    ...section("notRecommended", "Not recommended", "Contains account or device-specific data — not meant to travel between vaults.", false, notRecommended),
  ];
}

export async function listPluginSections(
  io: FileIO,
  configDir: string,
  plugins: { id: string; name: string; enabled: boolean }[],
  _groups: SyncGroup[]
): Promise<CatalogSection[]> {
  const { files } = await presentSets(io, configDir);
  const switchItem: CatalogItem = {
    name: "community-plugins",
    label: OPTION_LABELS["community-plugins.json"]!.label,
    description: OPTION_LABELS["community-plugins.json"]!.description,
    path: "{configDir}/community-plugins.json",
    type: "file",
    exists: files.has("community-plugins.json"),
    disabledReason: null,
    cautionReason: null,
  };
  const enabled: CatalogItem[] = [];
  const disabled: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  for (const p of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    const item: CatalogItem = {
      name: `plugin-${p.id}`,
      label: p.name,
      description: `Settings of ${p.id}.`,
      path: `{configDir}/plugins/${p.id}/data.json`,
      type: "file",
      exists: true,
      disabledReason: BLACKLISTED_PLUGIN_DIRS.includes(p.id) ? BLACKLIST_REASON : null,
      cautionReason: null,
    };
    if (item.disabledReason !== null) notRecommended.push(item);
    else (p.enabled ? enabled : disabled).push(item);
  }
  return [
    ...section("list", "Plugin on/off list", "Which community plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Turned on here.", true, enabled),
    ...section("disabled", "Installed but disabled", "Installed but turned off — you can still sync its settings for later.", true, disabled),
    ...section("notRecommended", "Not recommended", BLACKLIST_REASON, false, notRecommended),
  ];
}

export function groupForItem(name: string, path: string, type: "file" | "dir", description: string | null): SyncGroup {
  const group: SyncGroup = { name, path, type, devices: "all" };
  if (description !== null) group.description = description;
  return group;
}

export function toggleSection(groups: SyncGroup[], items: CatalogItem[], on: boolean): SyncGroup[] {
  const names = new Set(items.filter((i) => i.disabledReason === null).map((i) => i.name));
  if (!on) return groups.filter((g) => !names.has(g.name));
  const next = [...groups];
  const have = new Set(groups.map((g) => g.name));
  for (const item of items) {
    if (item.disabledReason !== null || have.has(item.name)) continue;
    next.push(groupForItem(item.name, item.path, item.type, item.description));
  }
  return next;
}
```

(The `switchItem.name` two-line dance in `listCoreSections` is ugly — simplify to a straight literal `name: "core-plugins"` when transcribing; the placeholder was only to make the diff explicit. Keep `findGroupByPath`, `splitLocation`, `joinLocation` as they are.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS. Then `npm test` — the OLD callers in `src/ui/SettingTab.ts` and `src/main.ts` still reference removed exports, so `npm run build` FAILS here. That's expected; Tasks 3+ fix the callers. To keep this task's suite green, this task ALSO applies the minimal caller compile-fixes below.

- [ ] **Step 5: Minimal caller compile-fixes so the build passes**

The section functions replace `listOptionItems`/`listPluginItems`; `main.ts` and `SettingTab.ts` won't compile. Full UI rewrite is Task 6. To land Task 2 building, apply temporary bridges: in `src/main.ts`, change `listOptionItems`/`listPluginItems` host methods to call the new section functions and flatten to items (kept only until Task 5/6 replace them):

```ts
  async listOptionItems(groups: SyncGroup[]): Promise<import("./core/catalog").CatalogItem[]> {
    const sections = await listOptionSections(this.app.vault.adapter, this.app.vault.configDir, groups);
    return sections.flatMap((s) => s.items);
  }

  listPluginItems(): PluginItem[] {
    return []; // superseded in Task 5; temporary to keep the build green
  }
```

Update the imports in `main.ts` (`listOptionSections` instead of `listOptionItems`) and drop the now-unused `PluginItem`/`listPluginItems` import if TS complains, replacing the `listPluginItems(): PluginItem[]` return type with `unknown[]`. In `src/ui/SettingTab.ts`, the `renderPlugins`/`renderChecklistRow` still compile against `CatalogItem` (unchanged names on the interface plus new `name` field — existing literals must add `name`); add `name: item.path` as a placeholder to any `CatalogItem` literal that fails to compile. These bridges are torn out in Task 6; note each in the report.

- [ ] **Step 6: Verify build + full suite**

Run: `npm run build` (exit 0), `npm test` (all green), `npm run lint` (no new errors).

- [ ] **Step 7: Commit**

```bash
git add src/core/catalog.ts src/main.ts src/ui/SettingTab.ts tests/catalog.test.ts
git commit -m "feat: catalog sections and name-identity group ops"
```

---

### Task 3: reserved-name validation

**Files:**
- Modify: `src/core/manifest.ts`, `src/core/catalog.ts` (register reserved-name resolver)
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `expectedPathForName` (Task 1).
- Produces: `validateSyncManifest` rejects a group whose `name` is a reserved name but whose `path` ≠ `expectedPathForName(name)`. **Seam (keeps core dependency-free):** `manifest.ts` exposes `setReservedPathResolver(fn: (name: string) => string | null)`; `catalog.ts` calls it at module load with `expectedPathForName`. If unset (e.g. isolated manifest unit tests), the check is skipped. The community reserved set (`plugin-<id>`) resolves through the same function.

- [ ] **Step 1: Append the failing tests to `tests/manifest.test.ts`**

Add `setReservedPathResolver` to the manifest import. Then:

```ts
describe("reserved-name validation", () => {
  it("rejects a group that takes a reserved name with the wrong path", () => {
    setReservedPathResolver((name) => (name === "graph" ? "{configDir}/graph.json" : null));
    const g = { name: "graph", path: "{configDir}/custom.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("reserved");
    setReservedPathResolver(null);
  });

  it("accepts a reserved name at its expected path", () => {
    setReservedPathResolver((name) => (name === "graph" ? "{configDir}/graph.json" : null));
    const g = { name: "graph", path: "{configDir}/graph.json", type: "file", devices: "all" };
    expect(parseSyncManifest(manifestWith([g])).groups[0]?.name).toBe("graph");
    setReservedPathResolver(null);
  });

  it("leaves non-reserved names alone", () => {
    setReservedPathResolver((name) => (name === "graph" ? "{configDir}/graph.json" : null));
    const g = { name: "my-own", path: "{configDir}/whatever.json", type: "file", devices: "all" };
    expect(parseSyncManifest(manifestWith([g])).groups[0]?.name).toBe("my-own");
    setReservedPathResolver(null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — `setReservedPathResolver` not exported; no reserved-name rejection.

- [ ] **Step 3: Add the resolver seam + check to `src/core/manifest.ts`**

Near the top (after `ManifestValidationError`):

```ts
let reservedPathResolver: ((name: string) => string | null) | null = null;

export function setReservedPathResolver(fn: ((name: string) => string | null) | null): void {
  reservedPathResolver = fn;
}
```

In `parseGroup`, after the existing `assertNotBlacklisted(name, path)` call:

```ts
  if (reservedPathResolver !== null) {
    const expected = reservedPathResolver(name);
    if (expected !== null && expected !== path) {
      throw new ManifestValidationError(
        `group "${name}": the name "${name}" is reserved for a built-in item at "${expected}" — rename this custom rule`
      );
    }
  }
```

- [ ] **Step 4: Register the resolver from `src/core/catalog.ts`**

At the end of `catalog.ts`, wire it up (uses only names, not runtime plugin ids — community `plugin-<id>` paths are computable purely from the name):

```ts
import { setReservedPathResolver } from "./manifest";

setReservedPathResolver(expectedPathForName);
```

(Import at the top with the other imports; the call goes at module end. Note: `expectedPathForName` returns the expected path for option/core/`plugin-*` names and `null` otherwise, which is exactly the resolver contract.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Note: because `catalog.ts` now registers the resolver at import, any test importing catalog will have it active — confirm existing manifest tests that use `plugin-remotely-save`-style names still pass (they use non-reserved or correct-path names). `npm run build` / `npm run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/manifest.ts src/core/catalog.ts tests/manifest.test.ts
git commit -m "feat: reject reserved picker names used at the wrong path"
```

---

### Task 4: host runtime collectors

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/SettingTab.ts` (SettingsHost interface sync only)

**Interfaces:**
- Consumes: `listOptionSections`, `listCoreSections`, `listPluginSections`, `CatalogSection` (Task 2).
- Produces — `SettingsHost` gains exactly:

```ts
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  installedPluginIds(): string[];
```

- [ ] **Step 1: Type the internal-plugins registry in `src/main.ts`**

Extend the non-public app typing used for `app.plugins`; add an internal-plugins shape:

```ts
interface InternalPluginsRegistry {
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string } }>;
}
```

Add a private accessor next to `pluginRegistry()`:

```ts
  private internalPlugins(): InternalPluginsRegistry {
    return (this.app as unknown as { internalPlugins: InternalPluginsRegistry }).internalPlugins;
  }

  private coreRuntime(): { id: string; name: string; enabled: boolean }[] {
    const reg = this.internalPlugins().plugins;
    return Object.entries(reg).map(([id, p]) => ({ id, name: p.instance?.name ?? id, enabled: p.enabled }));
  }

  private pluginRuntime(): { id: string; name: string; enabled: boolean }[] {
    const reg = this.pluginRegistry();
    return Object.values(reg.manifests).map((m) => ({ id: m.id, name: m.name, enabled: reg.enabledPlugins.has(m.id) }));
  }
```

- [ ] **Step 2: Replace the old host list methods** (remove `listOptionItems`/`listPluginItems` bridges from Task 2; add):

```ts
  async listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listOptionSections(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  async listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listCoreSections(this.app.vault.adapter, this.app.vault.configDir, this.coreRuntime(), groups);
  }

  async listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listPluginSections(this.app.vault.adapter, this.app.vault.configDir, this.pluginRuntime(), groups);
  }

  installedPluginIds(): string[] {
    return Object.values(this.pluginRegistry().manifests).map((m) => m.id);
  }
```

Update imports: drop `listOptionItems`/`listPluginItems`/`PluginItem`/`CatalogItem`-as-return; import `listOptionSections, listCoreSections, listPluginSections, CatalogSection` from `./core/catalog`.

- [ ] **Step 3: Sync `SettingsHost` in `src/ui/SettingTab.ts`** — replace the two old `list*` members with the four new ones above (import `CatalogSection` from `../core/catalog`). No UI-body changes here (Task 5 does the rewrite); the current body still references old methods, so the build will fail — that is acceptable ONLY if Task 5 lands in the same review cycle. To keep Task 4 independently building, temporarily keep the old `renderOptions`/`renderPlugins` working by having them call `(await this.host.listOptionSections(this.groups)).flatMap(s => s.items)`. Note these temporary flattenings in the report; Task 5 removes them.

- [ ] **Step 4: Verify**

Run: `npm run build` (exit 0), `npm test` (green), `npm run lint` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/ui/SettingTab.ts
git commit -m "feat: host collectors for core/community runtime and catalog sections"
```

---

### Task 5: SettingTab rewrite — six tabs, sections, Sync all/none, Advanced lock+provenance, search

**Files:**
- Modify: `src/ui/SettingTab.ts` (full rewrite; `SettingsHost` stays byte-identical to Task 4's version)

**Interfaces:**
- Consumes: Task 4 host methods (`listOptionSections`/`listCoreSections`/`listPluginSections`/`installedPluginIds`), Task 2 (`CatalogSection`/`CatalogItem`/`groupForItem`/`toggleSection`/`findGroupByName`/`splitLocation`/`joinLocation`), Task 1 (`reservedNames`/`expectedPathForName`), `confirmWarnings` from `./ConfirmModal`.
- Produces: the six-tab picker UI. No unit tests; gates = tsc/build/lint + orchestrator smoke.

- [ ] **Step 1: Replace `src/ui/SettingTab.ts` entirely**

```ts
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";
import {
  CatalogItem,
  CatalogSection,
  expectedPathForName,
  findGroupByName,
  groupForItem,
  joinLocation,
  reservedNames,
  splitLocation,
  toggleSection,
} from "../core/catalog";
import { confirmWarnings } from "./ConfirmModal";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  installedPluginIds(): string[];
}

interface SourceDraft {
  name: string;
  type: "local-path" | "git";
  path: string;
  remote: string;
  branch: string;
  root: string;
}

function toDraft(s: ExternalSource): SourceDraft {
  return {
    name: s.name,
    type: s.type,
    path: s.type === "local-path" ? s.path : "",
    remote: s.type === "git" ? s.remote : "",
    branch: s.type === "git" ? s.branch : "",
    root: s.root,
  };
}

function toCandidate(d: SourceDraft): unknown {
  return d.type === "local-path"
    ? { name: d.name, type: d.type, path: d.path, root: d.root }
    : { name: d.name, type: d.type, remote: d.remote, branch: d.branch, root: d.root };
}

type PanelTab = "general" | "obsidian" | "core" | "plugins" | "advanced" | "sources";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "obsidian", label: "Obsidian" },
  { id: "core", label: "Core plugins" },
  { id: "plugins", label: "Community plugins" },
  { id: "advanced", label: "Advanced" },
  { id: "sources", label: "External sources" },
];

const SECTION_TAB: Record<"obsidian" | "core" | "plugins", string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  plugins: "Community plugins",
};

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private search = "";
  private searchInputEl: HTMLInputElement | null = null; // restore focus across search re-renders
  private unlocked = new Set<string>(); // UI-transient: advanced rows unlocked this session
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false;
    this.activeTab = "general";
    this.search = "";
    this.unlocked.clear();
    this.rerender(0);
  }

  private refresh(): void {
    this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): void {
    const gen = ++this.renderGen;
    this.containerEl.empty();
    void this.render(this.containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.rerender(0);
  }

  private reservedSet(): Set<string> {
    return reservedNames(this.host.installedPluginIds());
  }

  private async render(containerEl: HTMLElement, gen: number, scrollTop: number): Promise<void> {
    if (gen !== this.renderGen) return;
    if (!this.loaded) {
      try {
        this.groups = await this.host.readGroupsFile();
        this.groupsReadError = null;
      } catch (e) {
        this.groups = [];
        this.groupsReadError = (e as Error).message;
      }
      if (gen !== this.renderGen) return;
      this.sources = this.host.settings.externalSources.map(toDraft);
      this.loaded = true;
    }
    this.renderSearchBox(containerEl);
    if (this.search.trim() !== "") {
      await this.renderSearchResults(containerEl, gen);
    } else {
      this.renderTabNav(containerEl);
      await this.renderActiveTab(containerEl, gen);
    }
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
    if (this.search.trim() !== "" && this.searchInputEl !== null) {
      const el = this.searchInputEl;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  private renderSearchBox(containerEl: HTMLElement): void {
    const box = new Setting(containerEl).setName("Search").addText((t) => {
      t.setPlaceholder("Find a setting or plugin to sync…");
      t.setValue(this.search);
      this.searchInputEl = t.inputEl;
      t.onChange((v) => {
        this.search = v;
        this.refresh();
      });
    });
    box.settingEl.addClass("config-sync-search");
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
    for (const tab of TABS) {
      const el = nav.createEl("button", { text: tab.label, cls: "config-sync-tab" });
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => this.switchTab(tab.id));
    }
  }

  private async renderActiveTab(containerEl: HTMLElement, gen: number): Promise<void> {
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        break;
      case "obsidian":
      case "core":
      case "plugins":
        if (this.renderGroupsReadError(containerEl)) break;
        await this.renderSections(containerEl, gen, this.activeTab);
        if (gen !== this.renderGen) return;
        this.renderGroupsError(containerEl);
        break;
      case "advanced":
        if (this.renderGroupsReadError(containerEl)) break;
        this.renderAdvanced(containerEl);
        this.renderGroupsError(containerEl);
        break;
      case "sources":
        this.renderSources(containerEl);
        break;
    }
  }

  private async sectionsFor(tab: "obsidian" | "core" | "plugins"): Promise<CatalogSection[]> {
    if (tab === "obsidian") return this.host.listOptionSections(this.groups);
    if (tab === "core") return this.host.listCoreSections(this.groups);
    return this.host.listPluginSections(this.groups);
  }

  private async renderSections(containerEl: HTMLElement, gen: number, tab: "obsidian" | "core" | "plugins"): Promise<void> {
    const sections = await this.sectionsFor(tab);
    if (gen !== this.renderGen) return;
    for (const sec of sections) {
      const head = new Setting(containerEl).setName(sec.heading).setDesc(sec.description).setHeading();
      if (sec.allowSyncAll) this.addSyncAllButton(head, sec);
      const listEl = containerEl.createDiv();
      for (const item of sec.items) this.renderChecklistRow(listEl, item);
    }
  }

  private addSyncAllButton(head: Setting, sec: CatalogSection): void {
    const tickable = sec.items.filter((i) => i.disabledReason === null);
    const allOn = tickable.length > 0 && tickable.every((i) => findGroupByName(this.groups, i.name) !== undefined);
    head.addButton((b) =>
      b.setButtonText(allOn ? "Sync none" : "Sync all").onClick(async () => {
        this.groups = toggleSection(this.groups, sec.items, !allOn);
        await this.saveGroups();
        this.refresh();
      })
    );
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem): void {
    const group = findGroupByName(this.groups, item.name);
    const row = new Setting(listEl).setName(item.label);
    const parts: string[] = [];
    if (item.description !== null) parts.push(item.description);
    if (item.disabledReason !== null) parts.push(item.disabledReason);
    if (item.cautionReason !== null) parts.push(item.cautionReason);
    if (!item.exists && item.disabledReason === null && item.cautionReason === null) parts.push("(not present in this vault yet)");
    const expected = expectedPathForName(item.name);
    if (group !== undefined && expected !== null && group.path !== expected) parts.push("⚙ customized");
    row.setDesc(parts.join(" "));
    if (group !== undefined && item.disabledReason === null) {
      row.addDropdown((d) =>
        d
          .addOption("all", "all devices")
          .addOption("desktop", "desktop only")
          .addOption("mobile", "mobile only")
          .setValue(group.devices)
          .onChange(async (v) => {
            group.devices = v as DeviceClass;
            await this.saveGroups();
            this.refresh();
          })
      );
    }
    row.addToggle((t) => {
      t.setValue(group !== undefined);
      t.setDisabled(item.disabledReason !== null);
      t.onChange(async (v) => {
        if (v) {
          if (item.cautionReason !== null) {
            const ok = await confirmWarnings(this.app, "Sync a device-specific file?", [item.cautionReason]);
            if (!ok) {
              this.refresh();
              return;
            }
          }
          this.groups.push(groupForItem(item.name, item.path, item.type, item.description));
        } else {
          const idx = this.groups.findIndex((g) => g.name === item.name);
          if (idx >= 0) this.groups.splice(idx, 1);
        }
        await this.saveGroups();
        this.refresh();
      });
    });
  }

  private async renderSearchResults(containerEl: HTMLElement, gen: number): Promise<void> {
    const q = this.search.trim().toLowerCase();
    const tabs: ("obsidian" | "core" | "plugins")[] = ["obsidian", "core", "plugins"];
    const listEl = containerEl.createDiv();
    let any = false;
    for (const tab of tabs) {
      const sections = await this.sectionsFor(tab);
      if (gen !== this.renderGen) return;
      for (const sec of sections) {
        for (const item of sec.items) {
          const hay = `${item.name} ${item.label} ${item.path}`.toLowerCase();
          if (!hay.includes(q)) continue;
          any = true;
          const labelled: CatalogItem = { ...item, label: `${item.label} — ${SECTION_TAB[tab]} · ${sec.heading}` };
          this.renderChecklistRow(listEl, labelled);
        }
      }
    }
    if (!any) listEl.createEl("p", { text: "No matching settings.", cls: "config-sync-empty" });
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    new Setting(containerEl)
      .setName("PKM mode")
      .setDesc("Adjusts the recommended storage location to match how your vault is organized. Auto detects IOTO vaults.")
      .addDropdown((d) =>
        d
          .addOption("auto", `Auto (detected: ${detected === "ioto" ? "IOTO" : "default"})`)
          .addOption("ioto", "IOTO")
          .addOption("default", "Default")
          .setValue(this.host.settings.pkmMode)
          .onChange(async (v) => {
            this.host.settings.pkmMode = v as PkmMode;
            await this.host.saveSettings();
            this.loaded = false;
            this.refresh();
          })
      );
  }

  private async renderDataFolder(containerEl: HTMLElement, gen: number): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
    if (gen !== this.renderGen) return;
    new Setting(containerEl)
      .setName("Data folder")
      .setDesc(
        `Where synced settings are stored inside your vault, so your note-sync app (e.g. remotely-save) carries them to your other devices. Leave empty to use the recommended location (currently: ${resolved}).`
      )
      .addText((t) => {
        t.setPlaceholder(resolved);
        t.setValue(this.host.settings.rootPath);
        t.onChange(async (v) => {
          const trimmed = v.trim();
          if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
            new Notice(`Config Sync: invalid data folder "${trimmed}" — must be a vault-relative path`);
            return;
          }
          this.host.settings.rootPath = trimmed;
          await this.host.saveSettings();
        });
        t.inputEl.addEventListener("blur", () => {
          this.loaded = false;
          this.refresh();
        });
      });
  }

  private renderGroupsReadError(containerEl: HTMLElement): boolean {
    if (this.groupsReadError === null) return false;
    containerEl.createEl("p", {
      text: `Cannot read the sync configuration — fix <data folder>/config-sync.json manually and reopen this tab: ${this.groupsReadError}`,
      cls: "mod-warning",
    });
    return true;
  }

  private renderGroupsError(containerEl: HTMLElement): void {
    this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.groupsErrorEl.setText(this.groupsErrorMsg);
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    const reserved = this.reservedSet();
    const managed = this.groups.filter((g) => reserved.has(g.name));
    const custom = this.groups.filter((g) => !reserved.has(g.name));

    new Setting(containerEl)
      .setName("Managed by pickers")
      .setHeading()
      .setDesc("Rules created from the other tabs. Locked by default — unlock a row to fix a path that has gone stale.");
    const managedEl = containerEl.createDiv();
    for (const group of managed) this.renderGroupRow(managedEl, group, true);

    new Setting(containerEl)
      .setName("Custom rules")
      .setHeading()
      .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection (sanitize).");
    const customEl = containerEl.createDiv();
    custom.forEach((group) => this.renderGroupRow(customEl, group, false));
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.refresh();
      })
    );
  }

  private renderGroupRow(listEl: HTMLElement, group: SyncGroup, managed: boolean): void {
    const locked = managed && !this.unlocked.has(group.name);
    const row = new Setting(listEl);
    if (managed) {
      const expected = expectedPathForName(group.name);
      if (expected !== null && group.path !== expected) row.setName(`${group.name}  ⚙ customized (was ${expected})`);
      else row.setName(group.name);
      row.addExtraButton((b) =>
        b
          .setIcon(locked ? "lock" : "unlock")
          .setTooltip(locked ? "Unlock to edit" : "Lock")
          .onClick(() => {
            if (locked) this.unlocked.add(group.name);
            else this.unlocked.delete(group.name);
            this.refresh();
          })
      );
    } else {
      row.addText((t) =>
        t.setPlaceholder("name").setValue(group.name).onChange((v) => {
          group.name = v.trim();
          void this.saveGroups();
        })
      );
    }
    row.addText((t) =>
      t.setPlaceholder("description (optional)").setValue(group.description ?? "").setDisabled(locked).onChange((v) => {
        const d = v.trim();
        if (d !== "") group.description = d;
        else delete group.description;
        void this.saveGroups();
      })
    );
    const loc = splitLocation(group.path);
    row.addDropdown((d) =>
      d.addOption("config", "Config folder").addOption("vault", "Vault root").setValue(loc.location).setDisabled(locked).onChange((v) => {
        group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
        void this.saveGroups();
      })
    );
    row.addText((t) =>
      t.setPlaceholder("relative path").setValue(loc.rel).setDisabled(locked).onChange((v) => {
        group.path = joinLocation(splitLocation(group.path).location, v.trim());
        void this.saveGroups();
      })
    );
    row.addDropdown((d) =>
      d.addOption("file", "file").addOption("dir", "dir").setValue(group.type).setDisabled(locked).onChange(async (v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        await this.saveGroups();
        this.refresh();
      })
    );
    row.addDropdown((d) =>
      d.addOption("all", "all").addOption("desktop", "desktop").addOption("mobile", "mobile").setValue(group.devices).setDisabled(locked).onChange(async (v) => {
        group.devices = v as DeviceClass;
        await this.saveGroups();
        this.refresh();
      })
    );
    row.addText((t) => {
      t.setPlaceholder("sanitize globs, comma-separated");
      t.setValue(group.sanitize?.join(", ") ?? "");
      t.setDisabled(locked || group.type !== "file");
      t.onChange((v) => {
        const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (patterns.length > 0) group.sanitize = patterns;
        else delete group.sanitize;
        void this.saveGroups();
      });
    });
    if (!managed) {
      row.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Delete rule").onClick(async () => {
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups.splice(idx, 1);
          await this.saveGroups();
          this.refresh();
        })
      );
    }
  }

  private async saveGroups(): Promise<void> {
    try {
      await this.host.writeGroupsFile(this.groups);
      this.groupsErrorMsg = "";
    } catch (e) {
      this.groupsErrorMsg = `Not saved: ${(e as Error).message}`;
    }
    this.groupsErrorEl?.setText(this.groupsErrorMsg);
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("External sources")
      .setHeading()
      .setDesc("Pull the synced settings of another vault into this one (e.g. from your main vault into a published copy).");
    const listEl = containerEl.createDiv();
    this.sources.forEach((source, index) => this.renderSourceRow(listEl, source, index));
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.sourcesErrorEl.setText(this.sourcesErrorMsg);
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add source").onClick(() => {
        this.sources.push({ name: "", type: "local-path", path: "", remote: "", branch: "", root: "" });
        this.refresh();
      })
    );
  }

  private renderSourceRow(listEl: HTMLElement, source: SourceDraft, index: number): void {
    const row = new Setting(listEl);
    row.addText((t) =>
      t.setPlaceholder("name").setValue(source.name).onChange((v) => {
        source.name = v.trim();
        void this.saveSources();
      })
    );
    row.addDropdown((d) =>
      d.addOption("local-path", "local-path").addOption("git", "git").setValue(source.type).onChange(async (v) => {
        source.type = v as SourceDraft["type"];
        await this.saveSources();
        this.refresh();
      })
    );
    if (source.type === "local-path") {
      row.addText((t) =>
        t.setPlaceholder("/absolute/path/to/source-vault").setValue(source.path).onChange((v) => {
          source.path = v.trim();
          void this.saveSources();
        })
      );
    } else {
      row.addText((t) =>
        t.setPlaceholder("git remote url").setValue(source.remote).onChange((v) => {
          source.remote = v.trim();
          void this.saveSources();
        })
      );
      row.addText((t) =>
        t.setPlaceholder("branch").setValue(source.branch).onChange((v) => {
          source.branch = v.trim();
          void this.saveSources();
        })
      );
    }
    row.addText((t) =>
      t.setPlaceholder("root, e.g. 0-Extra/config-sync").setValue(source.root).onChange((v) => {
        source.root = v.trim();
        void this.saveSources();
      })
    );
    row.addExtraButton((b) =>
      b.setIcon("trash").setTooltip("Delete source").onClick(async () => {
        this.sources.splice(index, 1);
        await this.saveSources();
        this.refresh();
      })
    );
  }

  private async saveSources(): Promise<void> {
    try {
      this.host.settings.externalSources = validateExternalSources(this.sources.map(toCandidate));
      await this.host.saveSettings();
      this.sourcesErrorMsg = "";
    } catch (e) {
      this.sourcesErrorMsg = `Not saved: ${(e as Error).message}`;
    }
    this.sourcesErrorEl?.setText(this.sourcesErrorMsg);
  }
}
```

- [ ] **Step 2: Verify**

Run: `npm run build` (exit 0), `npm test` (all green — nothing may regress), `npm run lint` (no new ERRORS; obsidianmd style/sentence-case warnings from the literals are acceptable — list them in the report).

- [ ] **Step 3: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: six-tab grouped picker with Sync all, Advanced lock, provenance and search"
```

---

### Task 6: styles + docs

**Files:**
- Modify: `styles.css`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: CSS classes from Task 5 (`config-sync-search`, `config-sync-empty`; existing `config-sync-tabs`/`config-sync-tab`/`is-active`).

- [ ] **Step 1: Append to `styles.css`** (keep the existing tab styles from iter4, add):

```css
.config-sync-search {
  border-top: none;
  padding-top: 0;
}

.config-sync-empty {
  color: var(--text-muted);
  font-style: italic;
}
```

- [ ] **Step 2: Update `README.md`** — replace the "Pick what to sync in Settings → Config Sync…" paragraph (from iter3) with:

```markdown
Pick what to sync in Settings → Config Sync. Items are grouped into tabs — **Obsidian** (global options), **Core plugins**, **Community plugins** — and within each tab by state (Available / Not yet in this vault / Not recommended, or Enabled / Disabled). Tick an item to sync it; each group has a **Sync all / Sync none** button. Core and community plugin names come from Obsidian at runtime. The **Advanced** tab lists every rule split into *Managed by pickers* (created by ticking, locked by default — unlock to fix a stale path) and *Custom rules* (your own). A top **search box** finds items across all tabs. `workspace.json` and the `sync`/`publish` core plugins are shown under *Not recommended* and ask for confirmation before syncing. Everything is stored as named groups in `<data folder>/config-sync.json`.
```

- [ ] **Step 3: Update `CLAUDE.md`** — under the architecture/notes, add one line about the catalog:

```markdown
- `src/core/catalog.ts` builds the settings-picker sections. Hardcoding is limited to two tables: `OPTION_LABELS` (global option file → friendly name) and `CORE_PLUGIN_FILES` (core plugin id → its settings file, e.g. `properties → types.json` — Obsidian exposes no id→file link at runtime). All plugin *names* come from runtime (`instance.name` / `manifests[id].name`). Group identity is the `name` field (reserved names for picker items; `validateSyncManifest` rejects a custom rule that takes a reserved name at the wrong path).
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm test` — both green.

```bash
git add styles.css README.md CLAUDE.md
git commit -m "docs: grouped-picker styles and README/CLAUDE updates"
```

---

## After the tasks (orchestrator, not plan tasks)

Final whole-branch review (cross-task: name-identity replaces path everywhere checked/toggled; reserved-name validation vs picker names incl. `plugin-<id>`; section bucketing per tab incl. sync/publish → Not recommended and switch-list leading rows; Sync all/none idempotence and Not-recommended exclusion; Advanced managed/custom split, lock disables all fields, provenance badge on customized path in both Advanced and picker row; search flatting across three tabs with origin labels; scroll/gen/draft invariants preserved; the `CORE_PLUGIN_FILES` hardcode acknowledged). Then obsidian-cli smoke in dev/vault: six tabs; Core tab enabled/disabled grouping with runtime names (verify `properties`→"Properties view" at `types.json`); lazily-created core files (`backlink.json` etc.) appear; Sync all on Obsidian available; workspace tick confirm + no Sync all in its section; Advanced lock/unlock + edit a managed path → customized badge appears in Advanced AND on the picker row; search "graph" finds it cross-tab and ticks it; reserved-name custom rule rejected. Then merge + 0.4.0 release decision with the user.
