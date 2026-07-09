# settings-picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the settings panel as a checkbox picker over known configuration items (Obsidian settings + installed community plugins), demote the group editor to a collapsed Advanced section with a location dropdown, and make publish tolerate missing sources per-group — per the spec at `docs/superpowers/specs/2026-07-09-settings-picker-design.md`.

**Architecture:** A new pure module `src/core/catalog.ts` turns a runtime enumeration of `{configDir}/` plus the installed-plugin list into user-labeled catalog items and maps them to/from groups by PATH (groups stay the only storage model — zero migration). `src/ui/SettingTab.ts` renders three new sections over it; `src/main.ts` exposes two thin host methods; `publishGroup` swaps its missing-source throw for a per-group error result.

**Tech Stack:** unchanged (TypeScript strict, esbuild/eslint from template vendor upstream, vitest, Obsidian API).

## Global Constraints

- All prior constraints hold: mobile I/O red line (src/core/ imports no Node/`obsidian`), blacklist incl. ancestors, strict tsconfig with `noUncheckedIndexedAccess` (narrow at error site, never loosen), explicit errors, JSON 2-space + trailing newline, template toolchain files untouched.
- **Picker ⇔ groups by path**: an item is checked iff a group with exactly that path exists in config-sync.json. Storage format, schema, publish/apply engine unchanged.
- **`{configDir}` never appears in the UI**: Advanced rows use a location dropdown (Config folder / Vault root) + relative path; the stored path keeps the variable.
- **Enumeration rules** (spec A.1): list `{configDir}/*.json` + first-level dirs; hide `core-plugins-migration.json` and the `plugins/` dir; `workspace*.json` shown disabled with reason "Device-specific window layout — never synced."; known items get friendly labels, unknown ones show their filename; checked-but-absent items shown with "(not present in this vault yet)".
- **Publish missing source = per-group error** ("nothing to publish yet: <path> does not exist in this vault"), other groups publish, lock written, no version stamp for errored plugin groups.
- Form rules from iteration 2 remain binding: text onChange never re-renders; `refresh()` keeps drafts; `display()` reloads; PKM-mode change and Data-folder blur reload drafts.
- User-voiced copy is spec §D verbatim (the exact strings appear in Task 4's code).
- Repo: https://github.com/xooooooooox/obsidian-config-sync . Branch `feat/settings-picker` created from `main` at execution time. All commands run from the repo root.

## File Structure

```
src/core/ConfigSyncCore.ts  # publishGroup: missing source → error result; publish: skip stamp on error
src/core/catalog.ts         # NEW: CatalogItem/PluginItem, KNOWN_OPTIONS map, listOptionItems,
                            #      listPluginItems, findGroupByPath, slugForPath, groupForItem,
                            #      splitLocation/joinLocation
src/main.ts                 # registry manifests typing +{id,name}; host methods listOptionItems/listPluginItems
src/ui/SettingTab.ts        # REWRITE: Options picker, Community plugins picker, Advanced (collapsed,
                            #      location dropdown), user-voiced copy; sources editor unchanged
tests/core.test.ts          # publish per-group-error tests (replace the old hard-throw test)
tests/catalog.test.ts       # NEW
README.md                   # "Configuring what to sync" walkthroughs
```

---

### Task 1: publish — missing source becomes a per-group error

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (function `publishGroup`, function `publish`)
- Test: `tests/core.test.ts` (replace one test, add one)

**Interfaces:**
- Consumes: existing `publish(ctx)`, `publishGroup` (private), `pluginIdForGroup`, test fixtures `MANIFEST`/`setup()` exported by tests/core.test.ts.
- Produces: `publish` never throws for a missing group source; the group's `GroupResult` has `status: "error"` and a message containing "nothing to publish yet"; errored plugin groups get no `store.lock.json` stamp. (Task 4's picker UX relies on this: checking a not-yet-present item must not abort publish.)

- [ ] **Step 1: Replace the old hard-throw test and add the stamp-skip test in `tests/core.test.ts`**

Delete the test `it("fails with the group name when a source is missing", ...)` inside `describe("publish", ...)` and add in its place:

```ts
  it("reports missing sources as per-group errors and publishes the rest", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/config-sync.json": MANIFEST,
      ".obs/hotkeys.json": '{"a":1}',
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"theme":"x"}',
      // snippets dir intentionally missing
    });
    const results = await publish(ctx);
    const status = Object.fromEntries(results.map((r) => [r.group, r.status]));
    expect(status["snippets"]).toBe("error");
    expect(status["hotkeys"]).toBe("ok");
    expect(results.find((r) => r.group === "snippets")?.messages[0]).toContain("nothing to publish yet");
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["plugin-demo"]).toBeDefined();
    expect(await io.exists("cs/store/configdir/snippets")).toBe(false);
  });

  it("skips the version stamp for a plugin group whose source is missing", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/config-sync.json": MANIFEST,
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obsidian.vimrc": "x",
      // plugin demo data.json intentionally missing
    });
    const results = await publish(ctx);
    expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
    expect(lock.groups["plugin-demo"]).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — publish currently rejects with "Publish failed: source of group … not found".

- [ ] **Step 3: Change `publishGroup` and the stamping in `publish`**

In `publishGroup`, replace the missing-source throw:

```ts
  if (!(await ctx.io.exists(real))) {
    result.status = "error";
    result.messages.push(`nothing to publish yet: ${real} does not exist in this vault`);
    return result;
  }
```

In `publish`, guard the version stamping so errored groups get neither a stamp nor the not-installed warning:

```ts
    const result = await publishGroup(ctx, group);
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null && result.status !== "error") {
      // ... existing stamping / warning body unchanged ...
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — 72 tests (71 − 1 replaced + 2 new). `npm run build` / `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: publish reports missing sources per group instead of aborting"
```

---

### Task 2: catalog module

**Files:**
- Create: `src/core/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `FileIO` from `./io`, `SyncGroup` from `./types`, `BLACKLISTED_PLUGIN_DIRS` from `./manifest`.
- Produces (used by Tasks 3–4):
  - `interface CatalogItem { label: string; description: string | null; path: string; type: "file" | "dir"; exists: boolean; disabledReason: string | null }`
  - `interface PluginItem { id: string; name: string; dataPath: string; disabledReason: string | null }`
  - `listOptionItems(io: FileIO, configDir: string, groups: SyncGroup[]): Promise<CatalogItem[]>`
  - `listPluginItems(installed: { id: string; name: string }[]): PluginItem[]`
  - `findGroupByPath(groups: SyncGroup[], path: string): SyncGroup | undefined`
  - `slugForPath(path: string, existingNames: string[]): string`
  - `groupForItem(path: string, type: "file" | "dir", existingNames: string[]): SyncGroup`
  - `splitLocation(path: string): { location: "config" | "vault"; rel: string }`
  - `joinLocation(location: "config" | "vault", rel: string): string`

- [ ] **Step 1: Write the failing tests — `tests/catalog.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  findGroupByPath,
  groupForItem,
  joinLocation,
  listOptionItems,
  listPluginItems,
  slugForPath,
  splitLocation,
} from "../src/core/catalog";
import { SyncGroup } from "../src/core/types";
import { MemFS } from "./memfs";

function seededFs(): MemFS {
  const io = new MemFS();
  io.seed({
    ".obs/app.json": "{}",
    ".obs/hotkeys.json": "{}",
    ".obs/workspace.json": "{}",
    ".obs/core-plugins-migration.json": "{}",
    ".obs/custom-unknown.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obs/plugins/demo/data.json": "{}",
  });
  return io;
}

describe("listOptionItems", () => {
  it("labels known items, keeps unknown filenames, hides machine files and plugins/", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
    expect(byPath["{configDir}/app.json"]?.label).toBe("Editor & general");
    expect(byPath["{configDir}/hotkeys.json"]?.label).toBe("Hotkeys");
    expect(byPath["{configDir}/snippets"]?.type).toBe("dir");
    expect(byPath["{configDir}/custom-unknown.json"]?.label).toBe("custom-unknown.json");
    expect(byPath["{configDir}/core-plugins-migration.json"]).toBeUndefined();
    expect(items.some((i) => i.path === "{configDir}/plugins")).toBe(false);
  });

  it("shows workspace files disabled with a device-specific reason", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const ws = items.find((i) => i.path === "{configDir}/workspace.json");
    expect(ws?.disabledReason).toContain("Device-specific");
  });

  it("keeps a checked-but-absent item visible with exists=false", async () => {
    const groups: SyncGroup[] = [{ name: "themes", path: "{configDir}/themes", type: "dir", devices: "all" }];
    const items = await listOptionItems(seededFs(), ".obs", groups);
    const themes = items.find((i) => i.path === "{configDir}/themes");
    expect(themes).toBeDefined();
    expect(themes?.exists).toBe(false);
  });

  it("returns [] for a missing configDir with no groups", async () => {
    expect(await listOptionItems(new MemFS(), ".obs", [])).toEqual([]);
  });
});

describe("listPluginItems", () => {
  it("maps installed plugins to data.json paths, sorted by name, blacklist disabled", () => {
    const items = listPluginItems([
      { id: "zzz-plugin", name: "Zzz" },
      { id: "remotely-save", name: "Remotely Save" },
      { id: "dataview", name: "Dataview" },
    ]);
    expect(items.map((i) => i.name)).toEqual(["Dataview", "Remotely Save", "Zzz"]);
    expect(items[0]?.dataPath).toBe("{configDir}/plugins/dataview/data.json");
    expect(items.find((i) => i.id === "remotely-save")?.disabledReason).toContain("cannot be synced");
    expect(items.find((i) => i.id === "dataview")?.disabledReason).toBe(null);
  });
});

describe("slugForPath / groupForItem / findGroupByPath", () => {
  it("derives friendly slugs and dedupes against existing names", () => {
    expect(slugForPath("{configDir}/hotkeys.json", [])).toBe("hotkeys");
    expect(slugForPath("{configDir}/plugins/dataview/data.json", [])).toBe("plugin-dataview");
    expect(slugForPath("{configDir}/hotkeys.json", ["hotkeys"])).toBe("hotkeys-2");
  });

  it("groupForItem builds an all-devices group and findGroupByPath matches it", () => {
    const g = groupForItem("{configDir}/snippets", "dir", []);
    expect(g).toEqual({ name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" });
    expect(findGroupByPath([g], "{configDir}/snippets")).toBe(g);
    expect(findGroupByPath([g], "{configDir}/hotkeys.json")).toBeUndefined();
  });
});

describe("splitLocation / joinLocation", () => {
  it("round-trips config-folder and vault-root paths", () => {
    expect(splitLocation("{configDir}/plugins/x/data.json")).toEqual({ location: "config", rel: "plugins/x/data.json" });
    expect(splitLocation(".obsidian.vimrc")).toEqual({ location: "vault", rel: ".obsidian.vimrc" });
    expect(joinLocation("config", "hotkeys.json")).toBe("{configDir}/hotkeys.json");
    expect(joinLocation("vault", ".obsidian.vimrc")).toBe(".obsidian.vimrc");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — cannot resolve `../src/core/catalog`.

- [ ] **Step 3: Write `src/core/catalog.ts`**

```ts
import { FileIO } from "./io";
import { SyncGroup } from "./types";
import { BLACKLISTED_PLUGIN_DIRS } from "./manifest";

export interface CatalogItem {
  label: string;
  description: string | null;
  path: string;
  type: "file" | "dir";
  exists: boolean;
  disabledReason: string | null;
}

export interface PluginItem {
  id: string;
  name: string;
  dataPath: string;
  disabledReason: string | null;
}

interface KnownEntry {
  file: string;
  type: "file" | "dir";
  label: string;
  description: string;
}

export const KNOWN_OPTIONS: KnownEntry[] = [
  { file: "app.json", type: "file", label: "Editor & general", description: "Editor and general options." },
  { file: "appearance.json", type: "file", label: "Appearance", description: "Theme choice, fonts and interface appearance." },
  { file: "themes", type: "dir", label: "Themes", description: "Installed theme files." },
  { file: "snippets", type: "dir", label: "CSS snippets", description: "Your CSS snippets." },
  { file: "hotkeys.json", type: "file", label: "Hotkeys", description: "Custom keyboard shortcuts." },
  { file: "graph.json", type: "file", label: "Graph view", description: "Graph view settings." },
  { file: "types.json", type: "file", label: "Properties", description: "Property type definitions." },
  { file: "command-palette.json", type: "file", label: "Command palette", description: "Pinned commands." },
  { file: "page-preview.json", type: "file", label: "Page preview", description: "Page preview settings." },
  { file: "backlink.json", type: "file", label: "Backlinks", description: "Backlink settings." },
  { file: "canvas.json", type: "file", label: "Canvas", description: "Canvas settings." },
  { file: "daily-notes.json", type: "file", label: "Daily notes", description: "Daily notes settings." },
  { file: "templates.json", type: "file", label: "Templates", description: "Template settings." },
  { file: "zk-prefixer.json", type: "file", label: "Unique note creator", description: "Unique note prefix settings." },
  { file: "bookmarks.json", type: "file", label: "Bookmarks", description: "Your bookmarks." },
  { file: "core-plugins.json", type: "file", label: "Enabled core plugins", description: "Which core plugins are turned on." },
  {
    file: "community-plugins.json",
    type: "file",
    label: "Enabled community plugins",
    description:
      "Which community plugins are turned on — not the plugins themselves or their settings. This mirrors the whole list: plugins enabled only on the target device get turned off. Best when your devices run the same plugins.",
  },
];

const HIDDEN_FILES = new Set(["core-plugins-migration.json"]);
const HIDDEN_DIRS = new Set(["plugins"]);
const WORKSPACE_RE = /^workspace.*\.json$/;
export const DEVICE_SPECIFIC_REASON = "Device-specific window layout — never synced.";

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export async function listOptionItems(io: FileIO, configDir: string, groups: SyncGroup[]): Promise<CatalogItem[]> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (await io.exists(configDir)) {
    const listed = await io.list(configDir);
    for (const f of listed.files) {
      const b = basename(f);
      if (b.endsWith(".json") && !HIDDEN_FILES.has(b)) files.add(b);
    }
    for (const d of listed.folders) {
      const b = basename(d);
      if (!HIDDEN_DIRS.has(b)) dirs.add(b);
    }
  }
  const items: CatalogItem[] = [];
  const covered = new Set<string>();
  for (const known of KNOWN_OPTIONS) {
    const present = known.type === "file" ? files.has(known.file) : dirs.has(known.file);
    const path = `{configDir}/${known.file}`;
    const checked = findGroupByPath(groups, path) !== undefined;
    if (present || checked) {
      items.push({ label: known.label, description: known.description, path, type: known.type, exists: present, disabledReason: null });
    }
    covered.add(known.file);
  }
  for (const b of [...files].filter((f) => !covered.has(f)).sort()) {
    const disabled = WORKSPACE_RE.test(b) ? DEVICE_SPECIFIC_REASON : null;
    items.push({ label: b, description: null, path: `{configDir}/${b}`, type: "file", exists: true, disabledReason: disabled });
    covered.add(b);
  }
  for (const b of [...dirs].filter((d) => !covered.has(d)).sort()) {
    items.push({ label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null });
    covered.add(b);
  }
  for (const g of groups) {
    const m = g.path.match(/^\{configDir\}\/([^/]+)$/);
    if (m && m[1] !== undefined && !covered.has(m[1])) {
      const disabled = WORKSPACE_RE.test(m[1]) ? DEVICE_SPECIFIC_REASON : null;
      items.push({ label: m[1], description: null, path: g.path, type: g.type, exists: false, disabledReason: disabled });
      covered.add(m[1]);
    }
  }
  return items;
}

export function listPluginItems(installed: { id: string; name: string }[]): PluginItem[] {
  return [...installed]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      dataPath: `{configDir}/plugins/${p.id}/data.json`,
      disabledReason: BLACKLISTED_PLUGIN_DIRS.includes(p.id)
        ? "Machine-bound or credential-bearing — cannot be synced."
        : null,
    }));
}

export function findGroupByPath(groups: SyncGroup[], path: string): SyncGroup | undefined {
  return groups.find((g) => g.path === path);
}

export function slugForPath(path: string, existingNames: string[]): string {
  const pluginMatch = path.match(/^\{configDir\}\/plugins\/([^/]+)\/data\.json$/);
  let base: string;
  if (pluginMatch && pluginMatch[1] !== undefined) {
    base = `plugin-${pluginMatch[1]}`;
  } else {
    const b = basename(path).replace(/\.json$/, "");
    base = b.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  }
  if (!existingNames.includes(base)) return base;
  let i = 2;
  while (existingNames.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function groupForItem(path: string, type: "file" | "dir", existingNames: string[]): SyncGroup {
  return { name: slugForPath(path, existingNames), path, type, devices: "all" };
}

export function splitLocation(path: string): { location: "config" | "vault"; rel: string } {
  if (path.startsWith("{configDir}/")) {
    return { location: "config", rel: path.slice("{configDir}/".length) };
  }
  return { location: "vault", rel: path };
}

export function joinLocation(location: "config" | "vault", rel: string): string {
  return location === "config" ? `{configDir}/${rel}` : rel;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS (9 tests). Full suite: `npm test` → 81. Build/lint clean (catalog imports only core modules — mobile red line holds).

- [ ] **Step 5: Commit**

```bash
git add src/core/catalog.ts tests/catalog.test.ts
git commit -m "feat: catalog — enumerate config items and map them to groups by path"
```

---

### Task 3: main.ts host methods

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/SettingTab.ts` (interface sync only — the rewrite is Task 4)

**Interfaces:**
- Consumes: `listOptionItems`, `listPluginItems`, `CatalogItem`, `PluginItem` from `./core/catalog` (Task 2).
- Produces — `SettingsHost` gains exactly these two members (Task 4 depends on them):

```ts
  listOptionItems(groups: SyncGroup[]): Promise<CatalogItem[]>;
  listPluginItems(): PluginItem[];
```

- [ ] **Step 1: Extend the plugin-registry typing in `src/main.ts`**

`CommunityPluginRegistry.manifests` becomes:

```ts
  manifests: Record<string, { id: string; name: string; version: string }>;
```

- [ ] **Step 2: Add the two host methods to `ConfigSyncPlugin`** (next to `readGroupsFile`; alias imports as needed to avoid name clashes):

```ts
  async listOptionItems(groups: SyncGroup[]): Promise<CatalogItem[]> {
    return listOptionItems(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  listPluginItems(): PluginItem[] {
    const manifests = this.pluginRegistry().manifests;
    return listPluginItems(Object.values(manifests).map((m) => ({ id: m.id, name: m.name })));
  }
```

(Import `listOptionItems as coreListOptionItems` / `listPluginItems as coreListPluginItems` if tsc complains about self-reference; otherwise plain imports are fine because class methods don't shadow module imports — use the plain form first and only alias if the build fails.)

- [ ] **Step 3: Sync `SettingsHost` in `src/ui/SettingTab.ts`** — add the two members (with `CatalogItem`, `PluginItem` imported from `../core/catalog`). No UI changes yet.

- [ ] **Step 4: Verify**

Run: `npm run build` (exit 0), `npm test` (81 green), `npm run lint` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/ui/SettingTab.ts
git commit -m "feat: host methods exposing catalog items to the settings tab"
```

---

### Task 4: SettingTab rewrite — pickers + collapsed Advanced

**Files:**
- Modify: `src/ui/SettingTab.ts` (full rewrite; `SettingsHost` stays byte-identical to Task 3's version)

**Interfaces:**
- Consumes: everything from Tasks 2–3 plus iteration-2 host methods; `validateExternalSources` from `../core/manifest`.
- Produces: the picker UI. No unit tests (project convention); gates are tsc/build/lint + the orchestrator's obsidian-cli smoke.

- [ ] **Step 1: Replace `src/ui/SettingTab.ts` entirely**

```ts
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";
import { CatalogItem, PluginItem, findGroupByPath, groupForItem, joinLocation, splitLocation } from "../core/catalog";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionItems(groups: SyncGroup[]): Promise<CatalogItem[]>;
  listPluginItems(): PluginItem[];
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

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false; // Obsidian entry: reload drafts from file/settings
    this.refresh();
  }

  // Internal re-render that keeps in-progress drafts.
  private refresh(): void {
    const { containerEl } = this;
    containerEl.empty();
    void this.render(containerEl);
  }

  private async render(containerEl: HTMLElement): Promise<void> {
    if (!this.loaded) {
      try {
        this.groups = await this.host.readGroupsFile();
        this.groupsReadError = null;
      } catch (e) {
        this.groups = [];
        this.groupsReadError = (e as Error).message;
      }
      this.sources = this.host.settings.externalSources.map(toDraft);
      this.loaded = true;
    }
    this.renderPkmMode(containerEl);
    await this.renderDataFolder(containerEl);
    if (this.groupsReadError !== null) {
      containerEl.createEl("p", {
        text: `Cannot read the sync configuration — fix <data folder>/config-sync.json manually and reopen this tab: ${this.groupsReadError}`,
        cls: "mod-warning",
      });
    } else {
      await this.renderOptions(containerEl);
      this.renderPlugins(containerEl);
      this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
      this.groupsErrorEl.setText(this.groupsErrorMsg);
      this.renderAdvanced(containerEl);
    }
    this.renderSources(containerEl);
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
            this.loaded = false; // effective root may change — reload drafts
            this.refresh();
          })
      );
  }

  private async renderDataFolder(containerEl: HTMLElement): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
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

  private async renderOptions(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl)
      .setName("Obsidian settings")
      .setHeading()
      .setDesc("Choose which Obsidian settings follow you across devices.");
    const listEl = containerEl.createDiv();
    for (const item of await this.host.listOptionItems(this.groups)) {
      this.renderChecklistRow(listEl, item);
    }
  }

  private renderPlugins(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Community plugins")
      .setHeading()
      .setDesc("Sync a plugin's settings to your other devices. The plugin itself still installs from the community store or BRAT.");
    const listEl = containerEl.createDiv();
    for (const p of this.host.listPluginItems()) {
      this.renderChecklistRow(listEl, {
        label: p.name,
        description: `Settings of ${p.id}.`,
        path: p.dataPath,
        type: "file",
        exists: true,
        disabledReason: p.disabledReason,
      });
    }
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem): void {
    const group = findGroupByPath(this.groups, item.path);
    const row = new Setting(listEl).setName(item.label);
    const descParts: string[] = [];
    if (item.description !== null) descParts.push(item.description);
    if (item.disabledReason !== null) descParts.push(item.disabledReason);
    if (!item.exists && item.disabledReason === null) descParts.push("(not present in this vault yet)");
    row.setDesc(descParts.join(" "));
    if (group !== undefined && item.disabledReason === null) {
      row.addDropdown((d) =>
        d
          .addOption("all", "all devices")
          .addOption("desktop", "desktop only")
          .addOption("mobile", "mobile only")
          .setValue(group.devices)
          .onChange((v) => {
            group.devices = v as DeviceClass;
            void this.saveGroups();
          })
      );
    }
    row.addToggle((t) => {
      t.setValue(group !== undefined);
      t.setDisabled(item.disabledReason !== null);
      t.onChange(async (v) => {
        if (v) {
          this.groups.push(groupForItem(item.path, item.type, this.groups.map((g) => g.name)));
        } else {
          const idx = this.groups.findIndex((g) => g.path === item.path);
          if (idx >= 0) this.groups.splice(idx, 1);
        }
        await this.saveGroups();
        this.refresh();
      });
    });
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details");
    details.createEl("summary", { text: "Advanced" });
    details.createEl("p", {
      text: "Custom sync rules for anything not listed above — files at the vault root, extra folders, or per-key credential protection (sanitize).",
    });
    const listEl = details.createDiv();
    this.groups.forEach((group, index) => {
      this.renderGroupRow(listEl, group, index);
    });
    new Setting(details).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.refresh();
      })
    );
  }

  private renderGroupRow(listEl: HTMLElement, group: SyncGroup, index: number): void {
    const row = new Setting(listEl);
    row.addText((t) =>
      t.setPlaceholder("name").setValue(group.name).onChange((v) => {
        group.name = v.trim();
        void this.saveGroups();
      })
    );
    const loc = splitLocation(group.path);
    row.addDropdown((d) =>
      d
        .addOption("config", "Config folder")
        .addOption("vault", "Vault root")
        .setValue(loc.location)
        .onChange((v) => {
          group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
          void this.saveGroups();
        })
    );
    row.addText((t) =>
      t.setPlaceholder("relative path, e.g. plugins/x/data.json").setValue(loc.rel).onChange((v) => {
        group.path = joinLocation(splitLocation(group.path).location, v.trim());
        void this.saveGroups();
      })
    );
    row.addDropdown((d) =>
      d
        .addOption("file", "file")
        .addOption("dir", "dir")
        .setValue(group.type)
        .onChange(async (v) => {
          group.type = v as SyncGroup["type"];
          if (group.type !== "file") delete group.sanitize;
          await this.saveGroups();
          this.refresh();
        })
    );
    row.addDropdown((d) =>
      d
        .addOption("all", "all")
        .addOption("desktop", "desktop")
        .addOption("mobile", "mobile")
        .setValue(group.devices)
        .onChange((v) => {
          group.devices = v as DeviceClass;
          void this.saveGroups();
        })
    );
    row.addText((t) => {
      t.setPlaceholder("sanitize globs, comma-separated");
      t.setValue(group.sanitize?.join(", ") ?? "");
      t.setDisabled(group.type !== "file");
      t.onChange((v) => {
        const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (patterns.length > 0) group.sanitize = patterns;
        else delete group.sanitize;
        void this.saveGroups();
      });
    });
    row.addExtraButton((b) =>
      b.setIcon("trash").setTooltip("Delete rule").onClick(async () => {
        this.groups.splice(index, 1);
        await this.saveGroups();
        this.refresh();
      })
    );
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
    this.sources.forEach((source, index) => {
      this.renderSourceRow(listEl, source, index);
    });
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
      d
        .addOption("local-path", "local-path")
        .addOption("git", "git")
        .setValue(source.type)
        .onChange(async (v) => {
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

Run: `npm run build` (exit 0), `npm test` (81 green — nothing may regress), `npm run lint` (no new ERRORS; obsidianmd style warnings from the literals above are acceptable, list them in the report).

- [ ] **Step 3: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: checkbox picker settings — Obsidian options, plugins, collapsed Advanced"
```

---

### Task 5: README — "Configuring what to sync"

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: shipped behavior of Tasks 1–4 (factual accuracy is the review bar).

- [ ] **Step 1: Read README.md, then replace the settings paragraph and add the walkthrough section**

Replace the existing paragraph that describes form-based groups/sources editing (added in iteration 2, starting "Groups and external sources are edited as forms…") with:

```markdown
Pick what to sync in Settings → Config Sync: tick items under **Obsidian settings** (hotkeys, appearance, CSS snippets, …) and **Community plugins** (a plugin's settings — the plugin itself still installs from the store or BRAT). No paths to type; each ticked item can be limited to desktop or mobile. The **Advanced** section holds custom rules for anything else — vault-root files, extra folders, or per-key credential protection (sanitize). Under the hood every choice is stored as a group in `<data folder>/config-sync.json` (JSON Schema included), created automatically on first use. **PKM mode** picks the default data folder — Auto detects IOTO via the `ioto-update` plugin and uses `<extraFolder>/config-sync` read from ioto-settings (fallback `0-Extra/config-sync`); otherwise `config-sync`. A non-empty Data folder always overrides the mode; leave it empty to follow.
```

Then add a new section (after the store-layout section, before Releasing):

```markdown
## Configuring what to sync — walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian settings*, tick **Hotkeys**, **Appearance**, **CSS snippets**.
2. Run `Config Sync: Publish` (ribbon or command palette).
3. On each other device, run `Config Sync: Apply` once your note-sync has delivered the data folder.

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, tick the plugin.
2. Open *Advanced* — the rule the tick created is listed there. Add sanitize patterns for its credential keys, e.g. `*Token*, *Secret*, *APIKey*`.
3. Publish. Credentials never enter the store; each device keeps its locally-entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Publish, and let remotely-save carry it; other devices Apply.
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build && npm test` — both green (docs-only).

```bash
git add README.md
git commit -m "docs: configuring-what-to-sync walkthroughs for the picker UI"
```

---

## After the tasks (orchestrator, not plan tasks)

Final whole-branch review (cross-task seams: picker⇔groups path identity incl. legacy groups; publish per-group errors vs picker "not present" items; Advanced location dropdown round-trip; copy accuracy), then obsidian-cli smoke in dev/vault (tick/untick items, devices dropdown, greyed blacklist rows, Advanced vimrc rule without `{configDir}`, publish with a ticked-but-missing item), then merge + release decision with the user.
