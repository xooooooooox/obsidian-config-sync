# Discovered-origin rules, icon buttons, mobile adaptation, review cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discovered-file rules stay in the Discovered section with locked name/path; Reset/Add controls become icons; the settings panel works on phones (Linter-style tabs, no horizontal panning); the directory's automated-review findings are cleared (release notes, Node-import warnings, README disclosures).

**Architecture:** `SyncGroup` gains an optional persisted `origin: "discovered"` marker that drives Advanced-tab section assignment. UI changes live in `src/ui/SettingTab.ts` + `styles.css` only. `src/external/*` is refactored to the scanner-sanctioned pattern (guard-first dynamic imports), which makes both factories async and requires an `obsidian` stub for vitest.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild, GitHub Actions.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — lint must report **0 errors** (pre-existing warnings acceptable; Task 3 removes 6 of them).
- Mobile red line: `src/core/*` must have zero `node:*`/Node-builtin/`obsidian` imports. (`src/external/*` MAY import `obsidian`; it may use Node builtins ONLY via dynamic `await import()` behind a `Platform.isDesktop` guard.)
- Commit messages: plain conventional-commit style, **no Claude attribution / no `Claude-Session:` trailer**.
- No hardcoded pixel breakpoints in CSS — phone styling keys off Obsidian's `body.is-phone` class.
- Copy strings, tooltips, icon names, and error messages exactly as written in each task.
- Do not change `src/core/catalog.ts` behavior (`listDiscovered` exclusion logic stays as-is).

---

### Task 1: `origin` field + Discovered rules stay in Discovered

**Files:**
- Modify: `src/core/types.ts` (SyncGroup)
- Modify: `src/core/manifest.ts` (`parseGroup`)
- Modify: `src/ui/SettingTab.ts` (`renderAdvanced`, `renderDiscoveredRow`, new `renderDiscoveredOnRow`, `renderRuleCard`, `renderRuleForm`)
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: existing `SyncGroup`, `splitLocation`, `reservedNames`, `saveGroups`, `expanded: Set<string>`.
- Produces: `SyncGroup.origin?: "discovered"`; `renderRuleForm(listEl, group, mode: "managed" | "custom" | "discovered")` (Task 2 must not change this signature).

- [ ] **Step 1: Write the failing tests**

Add to `tests/manifest.test.ts` inside `describe("parseSyncManifest", ...)`, following the existing test style in that file (they build a manifest JSON string and call `parseSyncManifest`):

```ts
it("preserves origin: discovered on groups", () => {
  const raw = JSON.stringify({
    version: 1,
    groups: [{ name: "workspace-x", path: "{configDir}/workspace-x.json", type: "file", devices: "all", origin: "discovered" }],
  });
  const parsed = parseSyncManifest(raw);
  expect(parsed.groups[0]?.origin).toBe("discovered");
});

it("omits origin when absent and rejects invalid origin values", () => {
  const ok = JSON.stringify({
    version: 1,
    groups: [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all" }],
  });
  expect(parseSyncManifest(ok).groups[0]?.origin).toBeUndefined();
  const bad = JSON.stringify({
    version: 1,
    groups: [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all", origin: "picker" }],
  });
  expect(() => parseSyncManifest(bad)).toThrow('"origin" must be "discovered"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — first test: `parsed.groups[0]?.origin` is `undefined` (parseGroup drops unknown fields); second test: no error thrown for `origin: "picker"`.

- [ ] **Step 3: Implement the field**

In `src/core/types.ts`, extend `SyncGroup`:

```ts
export interface SyncGroup {
  name: string;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "dir";
  devices: DeviceClass;
  sanitize?: string[]; // key-name glob patterns; file groups only
  description?: string; // optional human-readable label, shown in the settings panel
  origin?: "discovered"; // rule created from the Discovered-files section; name/path are fixed by the file
}
```

In `src/core/manifest.ts` `parseGroup`, change the destructuring line and add validation + preservation (parseGroup rebuilds the group object, so unknown fields are dropped unless explicitly carried over):

```ts
const { name, path, type, devices, sanitize, description, origin } = g;
```

After the `description` type check and before `assertNotBlacklisted(name, path);`:

```ts
if (origin !== undefined && origin !== "discovered") {
  throw new ManifestValidationError(`group "${name}": "origin" must be "discovered" when present`);
}
```

After the `description` assignment at the end:

```ts
if (origin === "discovered") group.origin = "discovered";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Rework the Advanced-tab section assignment**

In `src/ui/SettingTab.ts` `renderAdvanced`:

Change the two filters at the top so discovered-origin groups belong to neither Managed nor Custom:

```ts
const managed = this.groups.filter((g) => reserved.has(g.name) && g.origin === undefined);
const custom = this.groups.filter((g) => !reserved.has(g.name) && g.origin === undefined);
```

Replace the Discovered block (currently gated on `discovered.length > 0` only) with:

```ts
const discovered = await this.host.listDiscoveredFiles(this.groups);
if (gen !== this.renderGen) return;
const discoveredOn = this.groups.filter((g) => g.origin === "discovered");
if (discovered.length > 0 || discoveredOn.length > 0) {
  new Setting(containerEl)
    .setName("Discovered files")
    .setHeading()
    .setDesc("Config files we found but couldn't classify. Turn one on to start syncing it.");
  const discEl = containerEl.createDiv();
  for (const group of discoveredOn) this.renderDiscoveredOnRow(discEl, group);
  for (const d of discovered) this.renderDiscoveredRow(discEl, d);
}
```

(The section description loses the old "— rename it under Custom rules." clause.)

- [ ] **Step 6: Toggle-on creates the group with origin; add the enabled-row renderer**

In `renderDiscoveredRow`, the pushed group gains the marker:

```ts
this.groups.push({ name: d.name, path: d.path, type: "file", devices: "all", origin: "discovered" });
```

Add the new method after `renderDiscoveredRow`:

```ts
private renderDiscoveredOnRow(listEl: HTMLElement, group: SyncGroup): void {
  const isOpen = this.expanded.has(group.name);
  const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
  row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
  row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(group.path).rel });
  row.createDiv({ cls: "config-sync-rule-spacer" });
  new ToggleComponent(row).setValue(true).setTooltip("Stop syncing this file").onChange(async (v) => {
    if (v) return;
    const idx = this.groups.findIndex((g) => g === group);
    if (idx >= 0) this.groups.splice(idx, 1);
    this.expanded.delete(group.name);
    await this.saveGroups();
    this.refresh();
  });
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
    if (isOpen) this.expanded.delete(group.name);
    else this.expanded.add(group.name);
    this.refresh();
  });
  if (isOpen) this.renderRuleForm(listEl, group, "discovered");
}
```

Note the click-guard includes `.checkbox-container` (the ToggleComponent's root element) so clicking the toggle doesn't also expand/collapse the row.

- [ ] **Step 7: renderRuleForm gains a mode; discovered mode renders only line 2**

Change the signature from `(listEl: HTMLElement, group: SyncGroup, managed: boolean)` to:

```ts
private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "managed" | "custom" | "discovered"): void {
```

Wrap the entire line-1 block (the `const line1 = …` div, the custom-only Name field, the Location dropdown, the Path text field) in:

```ts
if (mode !== "discovered") {
  // ...existing line1 code, with `if (!managed)` becoming `if (mode === "custom")`
  // and the line1 class expression becoming:
  // "config-sync-form-line1" + (mode === "custom" ? " has-name" : "")
}
```

Line 2 (Type/Devices/Sanitize/Description) renders unchanged for all modes. Update the existing call in `renderRuleCard` from `this.renderRuleForm(listEl, group, managed)` to:

```ts
this.renderRuleForm(listEl, group, managed ? "managed" : "custom");
```

Design note: line 2 includes Type — for a discovered rule Type is always "file" and changing it to "dir" would be odd but harmless (the path points at a file). Leave it editable; do not special-case.

- [ ] **Step 8: Gate + smoke**

Run: `npm test && npm run build && npm run lint`
Expected: all tests pass, build clean, lint 0 errors.

Smoke (dev vault via `npm run smoke:install`, then obsidian-cli): open Config Sync settings → Advanced. Toggle a Discovered file ON → the row stays in Discovered with toggle on; it does NOT appear under Custom rules; expanding it shows only Devices/Sanitize/Description (no Name/Location/Path inputs). Toggle OFF → row reverts to the not-synced state. `config-sync.json` in the data folder contains `"origin": "discovered"` on the rule while enabled. Zero console errors.

- [ ] **Step 9: Commit**

```bash
git add src/core/types.ts src/core/manifest.ts src/ui/SettingTab.ts tests/manifest.test.ts
git commit -m "feat: discovered rules stay in Discovered with locked name/path (origin field)"
```

---

### Task 2: Icon buttons, Linter-style tabs, mobile CSS

**Files:**
- Modify: `src/ui/SettingTab.ts` (`TABS`, `renderTabNav`, `renderAdvanced` heading buttons, `renderRuleCard` Reset, `renderSources`)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `renderRuleForm(..., mode)` from Task 1 (do not change its signature); `setIcon` from `obsidian`.
- Produces: CSS classes `.config-sync-tab-icon`, `.config-sync-tab-label`, `.config-sync-sources`.

- [ ] **Step 1: Tab definitions gain icons**

In `src/ui/SettingTab.ts`, add `setIcon` to the `obsidian` import list, then:

```ts
const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "obsidian", label: "Obsidian", icon: "gem" },
  { id: "core", label: "Core plugins", icon: "blocks" },
  { id: "plugins", label: "Community plugins", icon: "puzzle" },
  { id: "advanced", label: "Advanced", icon: "wrench" },
  { id: "sources", label: "Remotes", icon: "git-branch" },
];
```

`renderTabNav` becomes:

```ts
private renderTabNav(containerEl: HTMLElement): void {
  const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
  for (const tab of TABS) {
    const el = nav.createEl("button", { cls: "config-sync-tab" });
    setIcon(el.createSpan({ cls: "config-sync-tab-icon" }), tab.icon);
    el.createSpan({ cls: "config-sync-tab-label", text: tab.label });
    if (tab.id === this.activeTab) el.addClass("is-active");
    el.addEventListener("click", () => this.switchTab(tab.id));
  }
}
```

- [ ] **Step 2: Reset / Add controls become ExtraButtons**

In `renderAdvanced`, the Managed heading's Reset-all button changes from `addButton` to:

```ts
managedHead.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("Reset all to picker defaults").onClick(async () => {
  // ...existing loop body unchanged...
}));
```

In `renderRuleCard`, the managed-row Reset changes from `ButtonComponent` + `setButtonText("Reset")` to:

```ts
new ExtraButtonComponent(row)
  .setIcon("rotate-ccw")
  .setTooltip("Restore to the picker default")
  .onClick(async () => {
    // ...existing body unchanged...
  });
```

"Add rule" moves onto the "Custom rules" heading (symmetric with Reset-all on Managed) — in `renderAdvanced`, capture the heading Setting and add the button:

```ts
const customHead = new Setting(containerEl)
  .setName("Custom rules")
  .setHeading()
  .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection (sanitize).");
customHead.addExtraButton((b) => b.setIcon("plus").setTooltip("Add rule").onClick(() => {
  this.groups.push({ name: "", path: "", type: "file", devices: "all" });
  this.expanded.add("");
  this.refresh();
}));
```

…and delete the trailing `new Setting(containerEl).addButton((b) => b.setButtonText("Add rule")…)` block at the end of `renderAdvanced`.

Same move in `renderSources`: capture the "Remotes" heading Setting into a variable, add:

```ts
sourcesHead.addExtraButton((b) => b.setIcon("plus").setTooltip("Add remote").onClick(() => {
  this.sources.push({ name: "", type: "local-path", path: "", remote: "", branch: "", root: "" });
  this.refresh();
}));
```

…and delete the trailing "Add remote" button Setting. If `ButtonComponent` is no longer referenced anywhere in the file, remove it from the `obsidian` import.

- [ ] **Step 3: Remotes list gets a scoping class**

In `renderSources`: `const listEl = containerEl.createDiv({ cls: "config-sync-sources" });`

- [ ] **Step 4: CSS — tabs, phone stacking, path truncation**

In `styles.css`, replace the `.config-sync-tabs` / `.config-sync-tab` rules with:

```css
.config-sync-tabs {
  display: flex;
  gap: var(--size-4-1);
  margin-bottom: var(--size-4-3);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow-x: auto;
}

.config-sync-tab {
  display: flex;
  align-items: center;
  gap: var(--size-2-2);
  background: none;
  box-shadow: none;
  border: none;
  border-radius: 0;
  padding: var(--size-4-1) var(--size-4-2);
  cursor: pointer;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  flex: none;
}

.config-sync-tab.is-active {
  color: var(--text-normal);
  border-bottom-color: var(--interactive-accent);
}

.config-sync-tab-icon {
  display: flex;
  align-items: center;
}
```

Change `.config-sync-row-path` to truncate instead of widening the row, and pin the name:

```css
.config-sync-row-path {
  font-family: var(--font-monospace);
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.config-sync-row .config-sync-rule-name {
  flex: none;
}
```

Append the phone block at the end of the file:

```css
/* Phone layout — Obsidian sets body.is-phone; no pixel breakpoints */
body.is-phone .config-sync-tab:not(.is-active) .config-sync-tab-label {
  display: none;
}

body.is-phone .config-sync-form-line1,
body.is-phone .config-sync-form-line1.has-name,
body.is-phone .config-sync-form-line2 {
  grid-template-columns: 1fr;
}

body.is-phone .config-sync-sources .setting-item-control {
  flex-wrap: wrap;
}
```

- [ ] **Step 5: Gate + smoke**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

Smoke (dev vault): tabs show icon+label, active tab underlined accent; Reset-all and per-row Reset are icon buttons with tooltips; heading `+` buttons add a rule / a remote (rule row auto-expands as before); no stray "Add rule"/"Add remote" text buttons remain. Phone check: in the dev vault run `document.body.classList.add("is-phone")` via obsidian-cli eval, narrow the window — inactive tabs collapse to icons, expanded forms stack single-column, no horizontal page scroll on any tab; remove the class afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "feat: icon controls, icon tabs with phone collapse, mobile layout fixes"
```

---

### Task 3: Desktop-guarded dynamic Node imports in src/external

**Files:**
- Modify: `src/external/gitSource.ts` (full rewrite of import structure; behavior identical)
- Modify: `src/external/localPath.ts` (same)
- Create: `tests/obsidian-stub.ts`
- Create: `vitest.config.ts`
- Modify: `tests/external.test.ts` (await the now-async local-path factories)
- Verify only (no change expected): `src/main.ts` `createReader`/`createWriter`

**Interfaces:**
- Consumes: `Platform` from `obsidian` (vitest resolves it to the stub via alias).
- Produces: `createLocalPathReader`/`createLocalPathWriter` become `async` (return `Promise<ExternalStoreReader>` / `Promise<ExternalStoreWriter>`); `createGitReader`/`createGitWriter` stay async with unchanged signatures.

**Why:** the directory's scanner (`obsidianmd/eslint-plugin`, rule `no-nodejs-modules`) warns on any Node-builtin import unless the import is dynamic AND its enclosing function's **first statement** is `if (!Platform.isDesktop) { throw … }` — same file, property name exactly `isDesktop`. Top-level static imports (current state) always warn.

- [ ] **Step 1: vitest obsidian stub**

Create `tests/obsidian-stub.ts`:

```ts
// Minimal runtime stand-in for the "obsidian" package (types-only on npm) so
// vitest can execute src/external/* which imports Platform.
export const Platform = { isDesktop: true };
```

Create `vitest.config.ts` at the repo root:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { obsidian: resolve(__dirname, "tests/obsidian-stub.ts") },
  },
});
```

- [ ] **Step 2: Rewrite `src/external/localPath.ts`**

Full new content:

```ts
import { Platform } from "obsidian";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

const DESKTOP_ONLY = "Config Sync: local-path remotes are desktop-only";

export async function createLocalPathReader(sourceVaultPath: string, sourceRoot: string): Promise<ExternalStoreReader> {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY);
  }
  const { promises: fs } = await import("fs");
  const nodePath = await import("path");
  const base = nodePath.join(sourceVaultPath, sourceRoot);
  const walk = async (rel: string, out: string[]): Promise<void> => {
    const entries = await fs.readdir(nodePath.join(base, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel, out);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  return {
    async listFiles(): Promise<string[]> {
      try {
        await fs.access(base);
      } catch {
        throw new Error(`External source root not found: ${base} — check the source "path" and "root" settings`);
      }
      const out: string[] = [];
      await walk("", out);
      return out.sort();
    },
    async readFile(relPath: string): Promise<string> {
      return fs.readFile(nodePath.join(base, relPath), "utf8");
    },
  };
}

export async function createLocalPathWriter(destVaultPath: string, destRoot: string): Promise<ExternalStoreWriter> {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY);
  }
  const { promises: fs } = await import("fs");
  const nodePath = await import("path");
  const base = nodePath.join(destVaultPath, destRoot);
  const walk = async (rel: string, out: string[]): Promise<void> => {
    const entries = await fs.readdir(nodePath.join(base, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel, out);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await fs.access(base);
        await walk("", out);
      } catch {
        // dest root does not exist yet — nothing to list
      }
      return out.sort();
    },
    async writeFile(relPath: string, content: string): Promise<void> {
      const target = nodePath.join(base, relPath);
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
    async deleteFile(relPath: string): Promise<void> {
      await fs.rm(nodePath.join(base, relPath), { force: true });
    },
    async finalize(): Promise<void> {
      // no-op: fs writes are already durable
    },
  };
}
```

(The `walk` closure is intentionally duplicated per factory: a shared module-level helper would need Node types in its signature, defeating the per-function guard pattern. Method bodies are byte-identical to the current implementation.)

- [ ] **Step 3: Rewrite `src/external/gitSource.ts`**

Full new content:

```ts
import { Platform } from "obsidian";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

const REMOTE_NAME = "config-sync-import";
const DESKTOP_ONLY = "Config Sync: git remotes are desktop-only";

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

async function loadGitRunner(): Promise<GitRunner> {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY);
  }
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileP = promisify(execFile);
  return async (cwd: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(e as Error).message}`);
    }
  };
}

export async function createGitReader(
  vaultBasePath: string,
  remoteUrl: string,
  branch: string,
  sourceRoot: string
): Promise<ExternalStoreReader> {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY);
  }
  const git = await loadGitRunner();
  const remotes = (await git(vaultBasePath, ["remote"])).split("\n").filter(Boolean);
  if (remotes.includes(REMOTE_NAME)) {
    await git(vaultBasePath, ["remote", "set-url", REMOTE_NAME, remoteUrl]);
  } else {
    await git(vaultBasePath, ["remote", "add", REMOTE_NAME, remoteUrl]);
  }
  await git(vaultBasePath, ["fetch", REMOTE_NAME, branch]);
  const prefix = sourceRoot.endsWith("/") ? sourceRoot : sourceRoot + "/";
  const listed = await git(vaultBasePath, ["ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", prefix]);
  const files = listed
    .split("\n")
    .filter(Boolean)
    .map((f) => f.slice(prefix.length))
    .sort();
  return {
    async listFiles(): Promise<string[]> {
      return files;
    },
    async readFile(relPath: string): Promise<string> {
      return git(vaultBasePath, ["show", `FETCH_HEAD:${prefix}${relPath}`]);
    },
  };
}

export async function createGitWriter(
  remoteUrl: string,
  branch: string,
  root: string
): Promise<ExternalStoreWriter> {
  if (!Platform.isDesktop) {
    throw new Error(DESKTOP_ONLY);
  }
  const git = await loadGitRunner();
  const { mkdtemp, rm, mkdir, writeFile, unlink, access, readdir } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const nodePath = await import("path");
  const walk = async (absBase: string, rel: string, out: string[]): Promise<void> => {
    const entries = await readdir(nodePath.join(absBase, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(absBase, childRel, out);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-push-"));
  await git(dir, ["clone", "--branch", branch, remoteUrl, "."]);
  const base = nodePath.join(dir, root);
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await access(base);
        await walk(base, "", out);
      } catch {
        // root not present in the remote yet
      }
      return out.sort();
    },
    async writeFile(relPath: string, content: string): Promise<void> {
      const target = nodePath.join(base, relPath);
      await mkdir(nodePath.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    async deleteFile(relPath: string): Promise<void> {
      await unlink(nodePath.join(base, relPath)).catch(() => undefined);
    },
    async finalize(): Promise<void> {
      await git(dir, ["add", "-A"]);
      const status = await git(dir, ["status", "--porcelain"]);
      if (status.trim() === "") {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      try {
        const stamp = new Date().toISOString();
        await git(dir, [
          "-c",
          "user.email=config-sync@local",
          "-c",
          "user.name=config-sync",
          "commit",
          "-m",
          `config-sync push: ${stamp}`,
        ]);
        await git(dir, ["push", "origin", branch]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
```

- [ ] **Step 4: Update `tests/external.test.ts`**

Every call to `createLocalPathReader(...)` and `createLocalPathWriter(...)` gains `await` (the git factories are already awaited). Example: `const reader = createLocalPathReader(sourceRepo, "0-Extra/config-sync");` → `const reader = await createLocalPathReader(sourceRepo, "0-Extra/config-sync");`. Test bodies are otherwise unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all suites including `tests/external.test.ts` (the stub makes `Platform.isDesktop` true so the guards pass in Node).

- [ ] **Step 6: Verify main.ts needs no change**

`src/main.ts` `createReader`/`createWriter` do `return createLocalPathReader(...)` inside async methods — a returned Promise is fine. Confirm with the compiler: `npm run build`. Expected: clean. If tsc complains about the return type, wrap the call as `return await createLocalPathReader(...)` (and the writer counterpart) — nothing else.

- [ ] **Step 7: Verify the warnings are gone**

Run: `npm run lint 2>&1 | grep -c "no-nodejs-modules" || true`
Expected: `0` (was 6 warnings across the two files). Also `npm run lint` overall: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/external/gitSource.ts src/external/localPath.ts tests/obsidian-stub.ts vitest.config.ts tests/external.test.ts
git commit -m "refactor: guard-first dynamic Node imports in external transports"
```

---

### Task 4: Release notes + README security disclosures

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:** none (CI + docs only).

- [ ] **Step 1: Auto-generated release notes**

In `.github/workflows/release.yml`, the `gh release create` invocation gains `--generate-notes`:

```yaml
                  gh release create "$tag" \
                    --title="$tag" \
                    --draft \
                    --generate-notes \
                    main.js manifest.json ${{ steps.styles.outputs.exists == 'true' && 'styles.css' || '' }}
```

- [ ] **Step 2: README "Security & privacy" section**

In `README.md`, insert a new section between `## Install` and `## Development` (heading levels match the file's existing `##` style):

```markdown
## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note-sync tool moves them between devices. Two **optional, desktop-only** remote features go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (local-path remotes and git temp clones).** If you add a local-path remote, Pull/Push read/write the absolute path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.

Both features are disabled until you configure a remote, and never run without an explicit Pull or Push command.
```

- [ ] **Step 3: Gate**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors (nothing code-touching changed; this is the constraint gate).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "docs: security disclosures in README; auto-generate release notes in CI"
```

---

## Verification after all tasks

1. Full gate on the branch: `npm test && npm run build && npm run lint` — 104+ tests pass, 0 lint errors, `no-nodejs-modules` count 0.
2. Smoke in the dev vault (desktop): Discovered on/off round-trip; icon buttons; tab icons; forced `is-phone` layout has no horizontal overflow.
3. After the next release tag: the directory's automated review should show the release-notes recommendation and the six source-code warnings cleared (the two Behavior warnings remain by design — they describe the disclosed capabilities).
