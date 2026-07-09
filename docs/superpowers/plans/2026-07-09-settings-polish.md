# settings-polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group descriptions, workspace soft-block with tick-time confirmation, scroll/consistency fixes, always-visible known items, and a five-tab settings panel — per the spec at `docs/superpowers/specs/2026-07-09-settings-polish-design.md`.

**Architecture:** The core chain (types → schema → validation → starter → catalog) gains an optional `description` and a `cautionReason` split from `disabledReason`; `src/ui/SettingTab.ts` is rewritten around an internal tab bar with scroll preservation and devices-as-structural-change; `styles.css` (template placeholder) gets its first real content.

**Tech Stack:** unchanged (TypeScript strict, esbuild/eslint from template vendor upstream, vitest, Obsidian API).

## Global Constraints

- All prior constraints hold: mobile I/O red line, plugin-dir blacklist incl. ancestors (UNCHANGED — only `workspace*.json` moves to soft-block), strict tsconfig with `noUncheckedIndexedAccess`, explicit errors, JSON 2-space + trailing newline, `{configDir}` never rendered in the UI, form rules (text onChange never re-renders; `refresh()` keeps drafts; `display()` reloads; PKM change / Data-folder blur reload; render-generation guard).
- **Soft-block semantics (spec B):** `workspace*.json` passes validation; catalog marks it with `cautionReason` ("Window layout and open tabs — highly device-specific; syncing will make devices overwrite each other."); ticking it requires a confirmWarnings dialog; cancel = no group created, toggle restored by refresh. Plugin blacklist keeps `disabledReason` + disabled toggle.
- **Known items always visible (spec D):** every `KNOWN_OPTIONS` entry is listed regardless of file existence; `exists` only drives the "(not present in this vault yet)" note.
- **Description (spec A):** optional `SyncGroup.description`; blank (after trim) is omitted on validation; picker fills it (known option rows → item label; plugin rows → `<display name> plugin settings`; unknown rows → none); Advanced rows edit it via text field.
- **Tabs (spec E):** General / Obsidian / Community plugins / Advanced / External sources; `activeTab` survives `refresh()`, resets to General on `display()`; only the active tab renders; tab switch scrolls to top, every other refresh restores the previous `scrollTop`.
- CSS class prefix `config-sync-`; colors via Obsidian CSS variables. `styles.css` becomes OURS on template merges — CLAUDE.md's upstream conflict rule must be updated in this plan.
- Repo: https://github.com/xooooooooox/obsidian-config-sync . Branch `feat/settings-polish` created from `main` at execution time. All commands run from the repo root.

## File Structure

```
src/core/types.ts           # SyncGroup.description?: string
src/core/manifest.ts        # parseGroup: description validation; assertNotBlacklisted: drop workspace rule
schema/config-sync.schema.json  # + description property
src/core/ConfigSyncCore.ts  # STARTER_MANIFEST groups gain descriptions
src/core/catalog.ts         # CatalogItem.cautionReason; known-always-visible; groupForItem(+description)
src/ui/SettingTab.ts        # REWRITE: tab bar, scroll preservation, caution confirm, devices refresh,
                            #          description field in Advanced; <details> removed
styles.css                  # first real content: tab bar styles
CLAUDE.md / README.md / docs/superpowers/specs/2026-07-08-…md  # blacklist wording + styles.css ownership
tests/manifest.test.ts / tests/core.test.ts / tests/catalog.test.ts
```

---

### Task 1: `description` through the core chain

**Files:**
- Modify: `src/core/types.ts`, `src/core/manifest.ts`, `schema/config-sync.schema.json`, `src/core/ConfigSyncCore.ts` (STARTER_MANIFEST only)
- Test: `tests/manifest.test.ts`, `tests/core.test.ts` (append)

**Interfaces:**
- Produces: `SyncGroup.description?: string` (validated: optional string; trimmed; blank omitted); `STARTER_MANIFEST` groups carry `description: "CSS snippets"` / `"Custom keyboard shortcuts"`. Tasks 2–3 rely on the field existing and surviving `writeGroups`→`readGroups`.

- [ ] **Step 1: Append the failing tests**

To `tests/manifest.test.ts` (inside the `parseSyncManifest` describe):

```ts
  it("carries a group description through validation", () => {
    const g = { ...GOOD, description: "Custom keyboard shortcuts" };
    const m = validateSyncManifest({ version: 1, groups: [g] });
    expect(m.groups[0]?.description).toBe("Custom keyboard shortcuts");
  });

  it("omits blank descriptions and rejects non-string ones", () => {
    const blank = validateSyncManifest({ version: 1, groups: [{ ...GOOD, description: "   " }] });
    expect(blank.groups[0]?.description).toBeUndefined();
    expect(() => validateSyncManifest({ version: 1, groups: [{ ...GOOD, description: 42 }] })).toThrow(
      '"description" must be a string'
    );
  });
```

To `tests/core.test.ts` (inside the `readGroups / writeGroups` describe):

```ts
  it("round-trips a group description through writeGroups/readGroups", async () => {
    const { ctx } = setup();
    await writeGroups(ctx, [
      { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", description: "Custom keyboard shortcuts" },
    ]);
    const groups = await readGroups(ctx);
    expect(groups[0]?.description).toBe("Custom keyboard shortcuts");
  });
```

And extend the existing `createStarterManifest` test with one assertion after the group-names check:

```ts
    expect(manifest.groups[0]?.description).toBe("CSS snippets");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts tests/core.test.ts`
Expected: FAIL — description is stripped by parseGroup (property missing) and the non-string case doesn't throw the expected message.

- [ ] **Step 3: Implement**

`src/core/types.ts` — add to `SyncGroup`:

```ts
  description?: string; // optional human-readable label, shown in the settings panel
```

`src/core/manifest.ts` — in `parseGroup`, destructure `description` alongside the other fields, validate after the `sanitize` block:

```ts
  if (description !== undefined && typeof description !== "string") {
    throw new ManifestValidationError(`group "${name}": "description" must be a string`);
  }
```

and when building the returned group (after the existing sanitize attachment):

```ts
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  if (trimmedDescription !== "") group.description = trimmedDescription;
```

`schema/config-sync.schema.json` — add to the group `properties` (keep `additionalProperties: false`):

```json
          "description": { "type": "string", "minLength": 1, "description": "Human-readable label for this group, shown in the settings panel" },
```

`src/core/ConfigSyncCore.ts` — STARTER_MANIFEST groups become:

```ts
      groups: [
        { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all", description: "CSS snippets" },
        { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", description: "Custom keyboard shortcuts" },
      ],
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — 83 tests (80 + 3 new its). `npm run build` / `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/manifest.ts schema/config-sync.schema.json src/core/ConfigSyncCore.ts tests/manifest.test.ts tests/core.test.ts
git commit -m "feat: optional group description across schema, validation and starter"
```

---

### Task 2: workspace soft-block + known-always-visible in catalog

**Files:**
- Modify: `src/core/manifest.ts` (assertNotBlacklisted), `src/core/catalog.ts`
- Modify: `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` (§3 安全黑名单 wording)
- Test: `tests/manifest.test.ts`, `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `SyncGroup.description` (Task 1).
- Produces (Task 3 relies on these exact shapes):
  - `CatalogItem` gains `cautionReason: string | null` (soft-block; toggle stays ENABLED) — `disabledReason` keeps meaning hard-block (toggle disabled).
  - `PluginItem` unchanged; the pseudo-items Task 3 builds from it set `cautionReason: null`.
  - `export const WORKSPACE_CAUTION = "Window layout and open tabs — highly device-specific; syncing will make devices overwrite each other.";` (replaces `DEVICE_SPECIFIC_REASON`).
  - `groupForItem(path: string, type: "file" | "dir", existingNames: string[], description: string | null): SyncGroup` — includes `description` when non-null.
  - `listOptionItems` emits every `KNOWN_OPTIONS` entry regardless of existence.
- Validation: `assertNotBlacklisted` no longer rejects `workspace*.json`; plugin-dir + ancestor rules unchanged.

- [ ] **Step 1: Rewrite/append the failing tests**

`tests/manifest.test.ts` — REPLACE `it("rejects workspace files", ...)` with:

```ts
  it("accepts workspace-pattern paths (soft-blocked in the UI, not in validation)", () => {
    const g = { name: "ws", path: "{configDir}/workspace.json", type: "file", devices: "all" };
    const m = parseSyncManifest(manifestWith([g]));
    expect(m.groups[0]?.name).toBe("ws");
  });
```

`tests/catalog.test.ts` — REPLACE `it("shows workspace files disabled with a device-specific reason", ...)` with:

```ts
  it("marks workspace files with a caution, not a hard disable", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const ws = items.find((i) => i.path === "{configDir}/workspace.json");
    expect(ws?.cautionReason).toContain("device-specific");
    expect(ws?.disabledReason).toBe(null);
  });
```

REPLACE `it("keeps a checked-but-absent item visible with exists=false", ...)` and `it("returns [] for a missing configDir with no groups", ...)` with:

```ts
  it("always lists known items, absent ones with exists=false", async () => {
    const items = await listOptionItems(seededFs(), ".obs", []);
    const themes = items.find((i) => i.path === "{configDir}/themes");
    expect(themes).toBeDefined();
    expect(themes?.exists).toBe(false);
    expect(items.find((i) => i.path === "{configDir}/app.json")?.exists).toBe(true);
  });

  it("keeps a checked-but-absent unknown item visible with exists=false", async () => {
    const groups: SyncGroup[] = [{ name: "gone", path: "{configDir}/custom-gone.json", type: "file", devices: "all" }];
    const items = await listOptionItems(seededFs(), ".obs", groups);
    const gone = items.find((i) => i.path === "{configDir}/custom-gone.json");
    expect(gone?.exists).toBe(false);
  });

  it("lists all known items even for a missing configDir", async () => {
    const items = await listOptionItems(new MemFS(), ".obs", []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !i.exists)).toBe(true);
  });
```

REPLACE the `groupForItem` assertions inside `it("groupForItem builds an all-devices group ...")` with:

```ts
    const g = groupForItem("{configDir}/snippets", "dir", [], "CSS snippets");
    expect(g).toEqual({ name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all", description: "CSS snippets" });
    const bare = groupForItem("{configDir}/x.json", "file", [], null);
    expect(bare).toEqual({ name: "x", path: "{configDir}/x.json", type: "file", devices: "all" });
    expect(findGroupByPath([g], "{configDir}/snippets")).toBe(g);
    expect(findGroupByPath([g], "{configDir}/hotkeys.json")).toBeUndefined();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts tests/catalog.test.ts`
Expected: FAIL — workspace path rejected by validation; `cautionReason` missing; absent known items not listed; groupForItem has no description parameter.

- [ ] **Step 3: Implement `src/core/manifest.ts`**

In `assertNotBlacklisted`, DELETE the basename/workspace block (the `const basename = ...` + `if (/^workspace.*\.json$/...)` statements). Plugin-dir and ancestor checks stay untouched.

- [ ] **Step 4: Implement `src/core/catalog.ts`**

- `CatalogItem`: add `cautionReason: string | null;` after `disabledReason`.
- Replace `export const DEVICE_SPECIFIC_REASON = ...` with:

```ts
export const WORKSPACE_CAUTION =
  "Window layout and open tabs — highly device-specific; syncing will make devices overwrite each other.";
```

- `listOptionItems` becomes:

```ts
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
    items.push({
      label: known.label,
      description: known.description,
      path: `{configDir}/${known.file}`,
      type: known.type,
      exists: present,
      disabledReason: null,
      cautionReason: WORKSPACE_RE.test(known.file) ? WORKSPACE_CAUTION : null,
    });
    covered.add(known.file);
  }
  for (const b of [...files].filter((f) => !covered.has(f)).sort()) {
    items.push({
      label: b,
      description: null,
      path: `{configDir}/${b}`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: WORKSPACE_RE.test(b) ? WORKSPACE_CAUTION : null,
    });
    covered.add(b);
  }
  for (const b of [...dirs].filter((d) => !covered.has(d)).sort()) {
    items.push({ label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null, cautionReason: null });
    covered.add(b);
  }
  for (const g of groups) {
    const m = g.path.match(/^\{configDir\}\/([^/]+)$/);
    if (m && m[1] !== undefined && !covered.has(m[1])) {
      items.push({
        label: m[1],
        description: null,
        path: g.path,
        type: g.type,
        exists: false,
        disabledReason: null,
        cautionReason: WORKSPACE_RE.test(m[1]) ? WORKSPACE_CAUTION : null,
      });
      covered.add(m[1]);
    }
  }
  return items;
}
```

- `groupForItem`:

```ts
export function groupForItem(path: string, type: "file" | "dir", existingNames: string[], description: string | null): SyncGroup {
  const group: SyncGroup = { name: slugForPath(path, existingNames), path, type, devices: "all" };
  if (description !== null) group.description = description;
  return group;
}
```

(No KNOWN_OPTIONS entry matches `workspace*.json` today — the `cautionReason` mapping there is defensive symmetry, verbatim from this plan.)

- [ ] **Step 5: Update the main spec's blacklist wording**

In `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` §3 安全黑名单, replace the sentence about `workspace*.json` ancestry line — the paragraph currently reads (single occurrence, added 2026-07-09):

> `remotely-save/`、`ioto-update/`、`slides-rup/`、`obsidian-config-sync/`、`workspace*.json` 永不入 store（机器绑定或含密）。manifest 校验时若组 path 命中黑名单，Publish/Apply 直接报错拒绝，而非静默跳过；黑名单的**祖先目录**（`{configDir}` 本身、`{configDir}/plugins` 整体）同样禁止作为组，防止 dir 组整目录扫入绕过。

Replace with:

> `remotely-save/`、`ioto-update/`、`slides-rup/`、`obsidian-config-sync/` 永不入 store（机器绑定或含密）。manifest 校验时若组 path 命中黑名单，Publish/Apply 直接报错拒绝，而非静默跳过；黑名单的**祖先目录**（`{configDir}` 本身、`{configDir}/plugins` 整体）同样禁止作为组，防止 dir 组整目录扫入绕过。`workspace*.json` 为**不推荐项**（设备强相关，同步会互相覆盖）：校验放行，面板勾选时需确认（iter4 起从硬黑名单降级）。

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — 84 tests (83 + 1 net-new it: two catalog tests replaced by three). `npm run build` / `npm run lint` clean (Task 3 hasn't consumed `cautionReason` yet — the UI still compiles because object literals in SettingTab.ts construct CatalogItem-shaped values... NOTE: `renderPlugins` in SettingTab.ts builds a `CatalogItem` literal — adding a required field BREAKS that literal. To keep this task compiling, add `cautionReason: null,` to that literal in `src/ui/SettingTab.ts` as part of this task (one-line edit, no behavior change).)

- [ ] **Step 7: Commit**

```bash
git add src/core/manifest.ts src/core/catalog.ts src/ui/SettingTab.ts docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md tests/manifest.test.ts tests/catalog.test.ts
git commit -m "feat: workspace soft-block and always-visible known items in catalog"
```

---

### Task 3: SettingTab rewrite — five tabs, scroll preservation, caution confirm, description editing

**Files:**
- Modify: `src/ui/SettingTab.ts` (full rewrite)

**Interfaces:**
- Consumes: Tasks 1–2 (`SyncGroup.description`, `CatalogItem.cautionReason`, `WORKSPACE_CAUTION` via items, `groupForItem(path, type, names, description)`), existing host methods, `confirmWarnings` from `./ConfirmModal`.
- Produces: the tabbed panel. `SettingsHost` unchanged. CSS classes `config-sync-tabs` / `config-sync-tab` / `is-active` (Task 4 styles them). No unit tests (project convention); gates tsc/build/lint + orchestrator smoke.

- [ ] **Step 1: Replace `src/ui/SettingTab.ts` entirely**

```ts
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";
import { CatalogItem, PluginItem, findGroupByPath, groupForItem, joinLocation, splitLocation } from "../core/catalog";
import { confirmWarnings } from "./ConfirmModal";

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

type PanelTab = "general" | "obsidian" | "plugins" | "advanced" | "sources";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "obsidian", label: "Obsidian" },
  { id: "plugins", label: "Community plugins" },
  { id: "advanced", label: "Advanced" },
  { id: "sources", label: "External sources" },
];

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false; // Obsidian entry: reload drafts from file/settings
    this.activeTab = "general";
    this.rerender(0);
  }

  // Structural re-render that keeps drafts and restores the current scroll position.
  private refresh(): void {
    this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): void {
    const gen = ++this.renderGen;
    const { containerEl } = this;
    containerEl.empty();
    void this.render(containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.rerender(0); // a freshly opened tab starts at the top
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
    this.renderTabNav(containerEl);
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        break;
      case "obsidian":
        if (!this.renderGroupsReadError(containerEl)) {
          await this.renderOptions(containerEl, gen);
          this.renderGroupsError(containerEl);
        }
        break;
      case "plugins":
        if (!this.renderGroupsReadError(containerEl)) {
          this.renderPlugins(containerEl);
          this.renderGroupsError(containerEl);
        }
        break;
      case "advanced":
        if (!this.renderGroupsReadError(containerEl)) {
          this.renderAdvanced(containerEl);
          this.renderGroupsError(containerEl);
        }
        break;
      case "sources":
        this.renderSources(containerEl);
        break;
    }
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
    for (const tab of TABS) {
      const el = nav.createEl("button", { text: tab.label, cls: "config-sync-tab" });
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => {
        this.switchTab(tab.id);
      });
    }
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

  private async renderOptions(containerEl: HTMLElement, gen: number): Promise<void> {
    new Setting(containerEl)
      .setName("Obsidian")
      .setHeading()
      .setDesc("Choose which Obsidian settings follow you across devices.");
    const items = await this.host.listOptionItems(this.groups);
    if (gen !== this.renderGen) return;
    const listEl = containerEl.createDiv();
    for (const item of items) {
      this.renderChecklistRow(listEl, item, item.description !== null ? item.label : null);
    }
  }

  private renderPlugins(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Community plugins")
      .setHeading()
      .setDesc("Sync a plugin's settings to your other devices. The plugin itself still installs from the community store or BRAT.");
    const listEl = containerEl.createDiv();
    for (const p of this.host.listPluginItems()) {
      this.renderChecklistRow(
        listEl,
        {
          label: p.name,
          description: `Settings of ${p.id}.`,
          path: p.dataPath,
          type: "file",
          exists: true,
          disabledReason: p.disabledReason,
          cautionReason: null,
        },
        `${p.name} plugin settings`
      );
    }
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem, groupDescription: string | null): void {
    const group = findGroupByPath(this.groups, item.path);
    const row = new Setting(listEl).setName(item.label);
    const descParts: string[] = [];
    if (item.description !== null) descParts.push(item.description);
    if (item.disabledReason !== null) descParts.push(item.disabledReason);
    if (item.cautionReason !== null) descParts.push(item.cautionReason);
    if (!item.exists && item.disabledReason === null) descParts.push("(not present in this vault yet)");
    row.setDesc(descParts.join(" "));
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
            this.refresh(); // keep every view of this group consistent
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
              this.refresh(); // groups unchanged — the re-render restores the toggle
              return;
            }
          }
          this.groups.push(groupForItem(item.path, item.type, this.groups.map((g) => g.name), groupDescription));
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
    new Setting(containerEl)
      .setName("Advanced")
      .setHeading()
      .setDesc("Custom sync rules for anything not listed elsewhere — files at the vault root, extra folders, or per-key credential protection (sanitize).");
    const listEl = containerEl.createDiv();
    this.groups.forEach((group, index) => {
      this.renderGroupRow(listEl, group, index);
    });
    new Setting(containerEl).addButton((b) =>
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
    row.addText((t) =>
      t.setPlaceholder("description (optional)").setValue(group.description ?? "").onChange((v) => {
        const trimmed = v.trim();
        if (trimmed !== "") group.description = trimmed;
        else delete group.description;
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
        .onChange(async (v) => {
          group.devices = v as DeviceClass;
          await this.saveGroups();
          this.refresh(); // keep picker rows for the same group consistent
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

Run: `npm run build` (exit 0), `npm test` (84 green — nothing may regress), `npm run lint` (no new ERRORS; style warnings from the literals above are acceptable, list them in the report).

- [ ] **Step 3: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: tabbed settings panel with scroll preservation and workspace caution"
```

---

### Task 4: styles.css + docs alignment

**Files:**
- Modify: `styles.css` (replace the template placeholder content entirely)
- Modify: `CLAUDE.md` (template-upstream conflict rule: styles.css becomes OURS)
- Modify: `README.md` (blacklist wording: workspace is discouraged, not blocked)

**Interfaces:**
- Consumes: CSS classes from Task 3 (`config-sync-tabs`, `config-sync-tab`, `is-active`).

- [ ] **Step 1: Replace `styles.css` content with**

```css
/* obsidian-config-sync — settings panel */

.config-sync-tabs {
  display: flex;
  gap: var(--size-4-1);
  margin-bottom: var(--size-4-3);
  border-bottom: 1px solid var(--background-modifier-border);
}

.config-sync-tab {
  background: none;
  box-shadow: none;
  border: none;
  border-radius: 0;
  padding: var(--size-4-1) var(--size-4-2);
  cursor: pointer;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
}

.config-sync-tab.is-active {
  color: var(--text-normal);
  border-bottom-color: var(--interactive-accent);
}
```

- [ ] **Step 2: Update CLAUDE.md's template-upstream conflict rule**

In the "## Template upstream" section, the conflict-rules sentence currently lists styles.css on the "take theirs" side. Replace that sentence with:

```markdown
Conflict rules: toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/.gitignore) take theirs; identity files (manifest.json, package.json name/author/license, versions.json), `styles.css` (plugin-owned styles since iter4), and `src/`/`tests/` stay ours; tsconfig takes theirs plus `tests/**/*.ts` re-added to `include`.
```

- [ ] **Step 3: Update README's blacklist line**

Replace the sentence "Never syncable (hard blacklist): `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync` plugin dirs and `workspace*.json`." with:

```markdown
Never syncable (hard blacklist): `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync` plugin dirs. `workspace*.json` (window layout) is allowed but discouraged — ticking it asks for confirmation because devices will overwrite each other's layout.
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm test` — both green (style/docs only).

```bash
git add styles.css CLAUDE.md README.md
git commit -m "feat: tab styles; docs reflect workspace soft-block and styles ownership"
```

---

## After the tasks (orchestrator, not plan tasks)

Final whole-branch review (cross-task: description survives picker→file→Advanced edit; caution confirm both paths; devices consistency picker↔Advanced; tab state across refresh vs display; scroll restore with gen guard; known-absent items vs per-group publish errors; docs accuracy), then obsidian-cli smoke in dev/vault including: create lazily-generated files (`backlink.json`, `canvas.json`, `command-palette.json`) and confirm they enumerate (closing feedback #3 factually); scroll-position check after a bottom-of-list toggle; workspace tick cancel/confirm; description in written JSON. Then merge + 0.3.0 release decision with the user.
