# settings-ux-and-release-docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Form-based settings (groups + external sources), implicit config-sync.json creation, PKM-mode auto-detection with IOTO-aware default data folder, and release/smoke documentation — per the spec at `docs/superpowers/specs/2026-07-09-settings-ux-and-release-docs-design.md`.

**Architecture:** Pure logic lands in `src/core/` (object-level validation split, PKM resolution module, groups-file read/write) with vitest coverage; `src/main.ts` grows an async `coreContext()` that resolves the effective rootPath and auto-creates the starter groups file on Publish/Apply; `src/ui/SettingTab.ts` is rewritten as a form-based view over the file/settings ("文件是唯一真相源，面板只是视图").

**Tech Stack:** unchanged (TypeScript strict + esbuild from template vendor upstream, vitest, Obsidian API).

## Global Constraints

- All prior constraints hold: mobile I/O red line (core only via FileIO; Node APIs only in src/external/ behind dynamic import), blacklist (incl. ancestors `{configDir}`, `{configDir}/plugins`), strict tsconfig incl. `noUncheckedIndexedAccess` (narrow at error site, never loosen), errors explicit and contextual, JSON written 2-space + trailing newline, template-vendor toolchain files untouched.
- Groups file: `<root>/config-sync.json` with `$schema` = `SCHEMA_URL`. Starter groups: snippets (dir/all) + hotkeys (file/all).
- PKM defaults (verbatim from spec E): `default` mode → `config-sync`; `ioto` mode → `<extraFolder>/config-sync` read from `{configDir}/plugins/ioto-settings/data.json` key `extraFolder`, fallback `0-Extra/config-sync`. Detection: `ioto-update` plugin enabled. rootPath `""` = follow mode; non-empty = user override.
- Settings-form rule: text-field `onChange` handlers mutate drafts and save — they must NOT re-render (focus loss); only structural actions (add/delete/type change/mode change) re-render, and internal re-renders must NOT reload drafts (only Obsidian's own `display()` entry reloads from file/settings).
- Repo: https://github.com/xooooooooox/obsidian-config-sync , branch to be created from `main` at execution time (`feat/settings-ux`). All commands run from the repo root.

## File Structure

```
src/core/manifest.ts        # + validateSyncManifest(obj) / validateExternalSources(arr) (parse fns become thin wrappers)
src/core/pkm.ts             # NEW: PkmMode, PkmProbe, resolveEffectiveMode, defaultRootForMode, resolveRootPath
src/core/ConfigSyncCore.ts  # + readGroups(ctx) / writeGroups(ctx, groups)
src/main.ts                 # settings {pkmMode, rootPath:"" default}; async coreContext(); auto-create on Publish/Apply; host methods
src/ui/SettingTab.ts        # REWRITE: PKM dropdown, data-folder placeholder, groups form, sources form
tests/manifest.test.ts      # + object-level validation cases
tests/pkm.test.ts           # NEW
tests/core.test.ts          # + readGroups/writeGroups + starter-then-publish
README.md / CLAUDE.md       # release + smoke + settings docs
```

---

### Task 1: Object-level validation split

**Files:**
- Modify: `src/core/manifest.ts`
- Test: `tests/manifest.test.ts` (append)

**Interfaces:**
- Consumes: existing `parseSyncManifest(raw: string): SyncManifest`, `parseExternalSources(raw: string): ExternalSource[]` and their private helpers.
- Produces: `validateSyncManifest(data: unknown): SyncManifest` and `validateExternalSources(data: unknown): ExternalSource[]` — exactly the current validation semantics minus JSON.parse; `parseSyncManifest`/`parseExternalSources` become `JSON.parse` + validate wrappers with unchanged error messages. All existing tests must keep passing unmodified.

- [ ] **Step 1: Append the failing tests to `tests/manifest.test.ts`**

Add `validateSyncManifest, validateExternalSources` to the import from `../src/core/manifest`, then append:

```ts
describe("validateSyncManifest", () => {
  it("accepts a plain object and ignores a $schema key", () => {
    const m = validateSyncManifest({ $schema: "https://example.invalid/s.json", version: 1, groups: [GOOD] });
    expect(m.groups).toHaveLength(1);
    expect(m.version).toBe(1);
  });
  it("rejects blacklisted paths on direct objects", () => {
    const g = { name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "file", devices: "all" };
    expect(() => validateSyncManifest({ version: 1, groups: [g] })).toThrow("blacklisted");
  });
  it("rejects duplicate names on direct objects", () => {
    expect(() => validateSyncManifest({ version: 1, groups: [GOOD, { ...GOOD }] })).toThrow("duplicate group name");
  });
});

describe("validateExternalSources", () => {
  it("accepts an already-parsed array", () => {
    const sources = validateExternalSources([{ name: "l", type: "local-path", path: "/v", root: "r" }]);
    expect(sources).toHaveLength(1);
  });
  it("rejects non-array input", () => {
    expect(() => validateExternalSources({})).toThrow("array");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — `validateSyncManifest` is not exported.

- [ ] **Step 3: Restructure `src/core/manifest.ts`**

Split each parse function; validation bodies move verbatim, error messages unchanged:

```ts
export function parseSyncManifest(raw: string): SyncManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`config-sync.json is not valid JSON: ${(e as Error).message}`);
  }
  return validateSyncManifest(parsed);
}

export function validateSyncManifest(data: unknown): SyncManifest {
  // ← the entire existing body of parseSyncManifest AFTER the JSON.parse block,
  //   with `parsed` renamed to `data` (top-level object check, version === 1,
  //   groups array, parseGroup loop, duplicate-name and store-path-collision checks)
}

export function parseExternalSources(raw: string): ExternalSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`external sources is not valid JSON: ${(e as Error).message}`);
  }
  return validateExternalSources(parsed);
}

export function validateExternalSources(data: unknown): ExternalSource[] {
  if (!Array.isArray(data)) throw new ManifestValidationError("external sources must be a JSON array");
  return data.map((s, i) => parseSource(s, i));
}
```

(The `validateSyncManifest` body is a pure move, not a rewrite — copy the existing statements. Do not touch `parseGroup`, `assertNotBlacklisted`, `parseStoreLock`, `parseSource`.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — 55 prior + 5 new = 60 tests. Also `npm run build` and `npm run lint` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/manifest.ts tests/manifest.test.ts
git commit -m "refactor: split object-level validate fns from string parsers"
```

---

### Task 2: PKM resolution module

**Files:**
- Create: `src/core/pkm.ts`
- Test: `tests/pkm.test.ts`

**Interfaces:**
- Consumes: `FileIO` from `src/core/io`.
- Produces (used by Tasks 4–5):
  - `type PkmMode = "auto" | "ioto" | "default"`
  - `interface PkmProbe { io: FileIO; configDir: string; isPluginEnabled(id: string): boolean }`
  - `const DEFAULT_ROOT = "config-sync"`, `const IOTO_FALLBACK_ROOT = "0-Extra/config-sync"`
  - `resolveEffectiveMode(mode: PkmMode, probe: PkmProbe): "ioto" | "default"`
  - `defaultRootForMode(effective: "ioto" | "default", probe: PkmProbe): Promise<string>`
  - `resolveRootPath(customRootPath: string, mode: PkmMode, probe: PkmProbe): Promise<string>`

- [ ] **Step 1: Write the failing tests — `tests/pkm.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOT,
  IOTO_FALLBACK_ROOT,
  PkmProbe,
  defaultRootForMode,
  resolveEffectiveMode,
  resolveRootPath,
} from "../src/core/pkm";
import { FakePlugins, MemFS } from "./memfs";

function probe(): { io: MemFS; plugins: FakePlugins; p: PkmProbe } {
  const io = new MemFS();
  const plugins = new FakePlugins();
  const p: PkmProbe = {
    io,
    configDir: ".obs",
    isPluginEnabled: (id) => plugins.isPluginEnabled(id),
  };
  return { io, plugins, p };
}

describe("resolveEffectiveMode", () => {
  it("auto resolves by ioto-update enablement", () => {
    const { plugins, p } = probe();
    expect(resolveEffectiveMode("auto", p)).toBe("default");
    plugins.enabled.add("ioto-update");
    expect(resolveEffectiveMode("auto", p)).toBe("ioto");
  });
  it("explicit modes pass through regardless of detection", () => {
    const { plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    expect(resolveEffectiveMode("default", p)).toBe("default");
    expect(resolveEffectiveMode("ioto", p)).toBe("ioto");
  });
});

describe("defaultRootForMode", () => {
  it("default mode uses the plain content-area folder", async () => {
    const { p } = probe();
    expect(await defaultRootForMode("default", p)).toBe(DEFAULT_ROOT);
  });
  it("ioto mode reads extraFolder from ioto-settings", async () => {
    const { io, p } = probe();
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"9-Aux"}' });
    expect(await defaultRootForMode("ioto", p)).toBe("9-Aux/config-sync");
  });
  it("falls back when the file is missing, unreadable, or the key is empty", async () => {
    const { io, p } = probe();
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
    io.seed({ ".obs/plugins/ioto-settings/data.json": "not json" });
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"   "}' });
    expect(await defaultRootForMode("ioto", p)).toBe(IOTO_FALLBACK_ROOT);
  });
});

describe("resolveRootPath", () => {
  it("a custom rootPath always wins", async () => {
    const { plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    expect(await resolveRootPath("my/own", "auto", p)).toBe("my/own");
  });
  it("empty rootPath follows the effective mode default", async () => {
    const { io, plugins, p } = probe();
    plugins.enabled.add("ioto-update");
    io.seed({ ".obs/plugins/ioto-settings/data.json": '{"extraFolder":"0-Extra"}' });
    expect(await resolveRootPath("", "auto", p)).toBe("0-Extra/config-sync");
    expect(await resolveRootPath("   ", "default", p)).toBe(DEFAULT_ROOT);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pkm.test.ts`
Expected: FAIL — cannot resolve `../src/core/pkm`.

- [ ] **Step 3: Write `src/core/pkm.ts`**

```ts
import { FileIO } from "./io";

export type PkmMode = "auto" | "ioto" | "default";

export interface PkmProbe {
  io: FileIO;
  configDir: string;
  isPluginEnabled(id: string): boolean;
}

export const DEFAULT_ROOT = "config-sync";
export const IOTO_FALLBACK_ROOT = "0-Extra/config-sync";

export function resolveEffectiveMode(mode: PkmMode, probe: PkmProbe): "ioto" | "default" {
  if (mode === "auto") {
    return probe.isPluginEnabled("ioto-update") ? "ioto" : "default";
  }
  return mode;
}

export async function defaultRootForMode(effective: "ioto" | "default", probe: PkmProbe): Promise<string> {
  if (effective === "default") return DEFAULT_ROOT;
  const settingsPath = `${probe.configDir}/plugins/ioto-settings/data.json`;
  if (!(await probe.io.exists(settingsPath))) return IOTO_FALLBACK_ROOT;
  try {
    const data = JSON.parse(await probe.io.read(settingsPath)) as Record<string, unknown>;
    const extra = data.extraFolder;
    if (typeof extra === "string" && extra.trim() !== "") {
      return `${extra.trim().replace(/\/+$/, "")}/config-sync`;
    }
  } catch {
    // spec-mandated fallback: an unreadable ioto-settings file must not break the plugin
  }
  return IOTO_FALLBACK_ROOT;
}

export async function resolveRootPath(customRootPath: string, mode: PkmMode, probe: PkmProbe): Promise<string> {
  const custom = customRootPath.trim();
  if (custom !== "") return custom;
  return defaultRootForMode(resolveEffectiveMode(mode, probe), probe);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pkm.test.ts`
Expected: PASS (7 tests). Also `npm test` → 67 total, `npm run build` / `npm run lint` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/pkm.ts tests/pkm.test.ts
git commit -m "feat: PKM mode resolution with IOTO auto-detection"
```

---

### Task 3: Groups-file read/write in core

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (append)
- Test: `tests/core.test.ts` (append)

**Interfaces:**
- Consumes: `manifestPath(ctx)`, `SCHEMA_URL`, `ensureParentDir`, `parseSyncManifest`; `validateSyncManifest` from Task 1.
- Produces (used by Task 4's host methods):
  - `readGroups(ctx: CoreContext): Promise<SyncGroup[]>` — `[]` when the file is missing; propagates parse/validation errors otherwise.
  - `writeGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<void>` — validates first (throws without touching the file), writes `{$schema, version: 1, groups}` 2-space + trailing newline, creating parent dirs.

- [ ] **Step 1: Append the failing tests to `tests/core.test.ts`**

Add `readGroups, writeGroups, SCHEMA_URL` to the core import, then append:

```ts
describe("readGroups / writeGroups", () => {
  it("returns [] when the groups file is missing", async () => {
    const { ctx } = setup();
    expect(await readGroups(ctx)).toEqual([]);
  });

  it("writes a schema-referenced file that round-trips", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }]);
    const raw = JSON.parse(await io.read("cs/config-sync.json")) as Record<string, unknown>;
    expect(raw.$schema).toBe(SCHEMA_URL);
    const groups = await readGroups(ctx);
    expect(groups.map((g) => g.name)).toEqual(["hotkeys"]);
  });

  it("rejects invalid group lists without touching the file", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, []);
    const before = await io.read("cs/config-sync.json");
    const bad = [{ name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "file" as const, devices: "all" as const }];
    await expect(writeGroups(ctx, bad)).rejects.toThrow("blacklisted");
    expect(await io.read("cs/config-sync.json")).toBe(before);
  });
});

describe("starter-then-publish (implicit creation flow)", () => {
  it("publishes the starter groups created on demand", async () => {
    const { io, ctx } = setup();
    io.seed({ ".obs/snippets/one.css": "one", ".obs/hotkeys.json": "{}" });
    expect(await createStarterManifest(ctx)).toBe("created");
    const results = await publish(ctx);
    expect(results.map((r) => r.group)).toEqual(["snippets", "hotkeys"]);
    expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("one");
  });
});
```

(`createStarterManifest` and `publish` are already imported in this file from earlier tasks; extend the import if not.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — `readGroups` / `writeGroups` not exported.

- [ ] **Step 3: Append to `src/core/ConfigSyncCore.ts`**

```ts
export async function readGroups(ctx: CoreContext): Promise<SyncGroup[]> {
  const p = manifestPath(ctx);
  if (!(await ctx.io.exists(p))) return [];
  return parseSyncManifest(await ctx.io.read(p)).groups;
}

export async function writeGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<void> {
  const manifest = validateSyncManifest({ version: 1, groups });
  const p = manifestPath(ctx);
  await ensureParentDir(ctx.io, p);
  await ctx.io.write(p, JSON.stringify({ $schema: SCHEMA_URL, version: 1, groups: manifest.groups }, null, 2) + "\n");
}
```

(Add `validateSyncManifest` to the import from `./manifest`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 71 tests. `npm run build` / `npm run lint` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: groups-file read/write with validate-before-write"
```

---

### Task 4: main.ts plumbing — PKM settings, async coreContext, auto-create on Publish/Apply

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/SettingTab.ts` (minimal: remove the Groups-file button + extend `SettingsHost`; the full rewrite is Task 5)

**Interfaces:**
- Consumes: `PkmMode`, `PkmProbe`, `resolveRootPath`, `resolveEffectiveMode` (Task 2); `readGroups`, `writeGroups` (Task 3); existing `createStarterManifest` (aliased as `coreCreateStarterManifest`).
- Produces (Task 5 relies on these exact host members):

```ts
export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
}
```

- [ ] **Step 1: Update settings shape and defaults in `src/main.ts`**

```ts
interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  externalSources: ExternalSource[];
}

const DEFAULT_SETTINGS: ConfigSyncSettings = { pkmMode: "auto", rootPath: "", externalSources: [] };
```

Add imports: `PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath` from `./core/pkm`; `readGroups, writeGroups` from `./core/ConfigSyncCore`; `SyncGroup` from `./core/types`.

- [ ] **Step 2: Make `coreContext()` async with PKM resolution**

Replace the current `coreContext()` and add `pkmProbe()`:

```ts
  private pkmProbe(): PkmProbe {
    const registry = this.pluginRegistry();
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
    };
  }

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    const registry = this.pluginRegistry();
    const host: PluginHost = {
      getInstalledPluginVersion: (id) => registry.manifests[id]?.version ?? null,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
      disablePlugin: (id) => registry.disablePlugin(id),
      enablePlugin: (id) => registry.enablePlugin(id),
    };
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: host,
      now: () => new Date().toISOString(),
    };
  }
```

Every call site becomes `const ctx = await this.coreContext();` (they are already inside try blocks — keep them there).

- [ ] **Step 3: Auto-create the groups file on Publish and Apply**

At the top of the `try` in `runPublish` and `runApply`, right after `const ctx = await this.coreContext();`:

```ts
      if ((await coreCreateStarterManifest(ctx)) === "created") {
        new Notice(`Config Sync: created starter groups file at ${ctx.rootPath}/config-sync.json — review it in settings`);
      }
```

(`runRevert` / `runImport` are NOT touched — they don't depend on the groups file.)

- [ ] **Step 4: Host methods for the settings tab; drop the old one**

Remove the `createStarterManifest()` host method from `ConfigSyncPlugin` (the core function stays imported for Step 3). Add:

```ts
  async readGroupsFile(): Promise<SyncGroup[]> {
    return readGroups(await this.coreContext());
  }

  async writeGroupsFile(groups: SyncGroup[]): Promise<void> {
    await writeGroups(await this.coreContext(), groups);
  }

  async resolvedRootPath(): Promise<string> {
    return resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
  }

  detectedMode(): "ioto" | "default" {
    return resolveEffectiveMode("auto", this.pkmProbe());
  }
```

- [ ] **Step 5: Minimal `src/ui/SettingTab.ts` sync**

Update `SettingsHost` to the interface in this task's Produces block (imports: `PkmMode` from `../core/pkm`, `SyncGroup` from `../core/types`). Delete the entire "Groups file" `Setting` (the Create button) and its handler. In the "Data folder" text setting, allow empty input (remove the `trimmed === ""` rejection — empty now means "follow mode"; keep the `/`-prefix and `..` rejections). Everything else stays until Task 5.

- [ ] **Step 6: Verify**

Run: `npm run build` — exit 0 (this catches any missed `await this.coreContext()` call site).
Run: `npm test` — 71 tests pass.
Run: `npm run lint` — no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/ui/SettingTab.ts
git commit -m "feat: PKM-aware rootPath resolution and implicit groups-file creation"
```

---

### Task 5: Settings tab rewrite — PKM dropdown, groups form, sources form

**Files:**
- Modify: `src/ui/SettingTab.ts` (full rewrite; keep the `SettingsHost` interface from Task 4 verbatim)

**Interfaces:**
- Consumes: `SettingsHost` (Task 4), `validateExternalSources` (Task 1), `SyncGroup`/`DeviceClass`/`ExternalSource` types, `PkmMode`.
- Produces: form-based settings UI. No unit tests (project convention) — gate is tsc/build/lint + orchestrator smoke.

- [ ] **Step 1: Replace `src/ui/SettingTab.ts` entirely**

```ts
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
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
    this.renderGroups(containerEl);
    this.renderSources(containerEl);
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    new Setting(containerEl)
      .setName("PKM mode")
      .setDesc("Determines the default data folder. Auto detects IOTO through the ioto-update plugin.")
      .addDropdown((d) =>
        d
          .addOption("auto", `Auto (detected: ${detected === "ioto" ? "IOTO" : "default"})`)
          .addOption("ioto", "IOTO")
          .addOption("default", "Default")
          .setValue(this.host.settings.pkmMode)
          .onChange(async (v) => {
            this.host.settings.pkmMode = v as PkmMode;
            await this.host.saveSettings();
            this.refresh(); // update the data-folder placeholder
          })
      );
  }

  private async renderDataFolder(containerEl: HTMLElement): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
    new Setting(containerEl)
      .setName("Data folder")
      .setDesc(`Vault-relative folder holding config-sync.json and store/. Leave empty to follow the PKM mode default (currently: ${resolved}).`)
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
      });
  }

  private renderGroups(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync groups")
      .setHeading()
      .setDesc("Saved to <data folder>/config-sync.json when valid. The file can also be edited directly (JSON Schema referenced).");
    if (this.groupsReadError !== null) {
      containerEl.createEl("p", {
        text: `Cannot read the groups file — fix it manually and reopen this tab: ${this.groupsReadError}`,
        cls: "mod-warning",
      });
      return;
    }
    const listEl = containerEl.createDiv();
    this.groups.forEach((group, index) => {
      this.renderGroupRow(listEl, group, index);
    });
    this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add group").onClick(() => {
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
      t.setPlaceholder("{configDir}/…").setValue(group.path).onChange((v) => {
        group.path = v.trim();
        void this.saveGroups();
      })
    );
    row.addDropdown((d) =>
      d.addOption("file", "file").addOption("dir", "dir").setValue(group.type).onChange((v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        void this.saveGroups();
        this.refresh(); // enable/disable the sanitize field
      })
    );
    row.addDropdown((d) =>
      d.addOption("all", "all").addOption("desktop", "desktop").addOption("mobile", "mobile")
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
      b.setIcon("trash").setTooltip("Delete group").onClick(() => {
        this.groups.splice(index, 1);
        void this.saveGroups();
        this.refresh();
      })
    );
  }

  private async saveGroups(): Promise<void> {
    try {
      await this.host.writeGroupsFile(this.groups);
      this.groupsErrorEl?.setText("");
    } catch (e) {
      this.groupsErrorEl?.setText(`Not saved: ${(e as Error).message}`);
    }
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("External sources")
      .setHeading()
      .setDesc("Import sources for this vault (used by the desktop-only Import command). Stored in plugin settings, never in the store.");
    const listEl = containerEl.createDiv();
    this.sources.forEach((source, index) => {
      this.renderSourceRow(listEl, source, index);
    });
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
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
      d.addOption("local-path", "local-path").addOption("git", "git").setValue(source.type).onChange((v) => {
        source.type = v as SourceDraft["type"];
        void this.saveSources();
        this.refresh(); // switch the conditional fields
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
      b.setIcon("trash").setTooltip("Delete source").onClick(() => {
        this.sources.splice(index, 1);
        void this.saveSources();
        this.refresh();
      })
    );
  }

  private async saveSources(): Promise<void> {
    try {
      this.host.settings.externalSources = validateExternalSources(this.sources.map(toCandidate));
      await this.host.saveSettings();
      this.sourcesErrorEl?.setText("");
    } catch (e) {
      this.sourcesErrorEl?.setText(`Not saved: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 2: Verify**

Run: `npm run build` — exit 0.
Run: `npm test` — 71 tests pass (UI has none; nothing may regress).
Run: `npm run lint` — no new ERRORS (style warnings from the obsidianmd plugin on the brief's own literals are acceptable; list them in the report).

- [ ] **Step 3: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: form-based settings — PKM mode, groups editor, sources editor"
```

---

### Task 6: Docs — release procedure, smoke knowledge, settings docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the shipped behavior of Tasks 4–5 and the existing `.github/workflows/release.yml` (tag push → build → attest → DRAFT release with main.js/manifest.json/styles.css).

- [ ] **Step 1: README — replace the release sentence with a real section**

Find the Development section's closing line ("Develop against a dedicated test vault (never a real one). Releases: tag `x.y.z`, attach `main.js` + `manifest.json` to the GitHub release.") — keep the dev-vault sentence, delete the stale release half, and add this section after Development:

```markdown
## Releasing

1. `npm version <x.y.z>` — bumps `manifest.json` + `versions.json` (via `version-bump.mjs`), commits, and tags.
2. `git push --follow-tags`
3. The "Release Obsidian plugin" workflow builds, attests build provenance, and creates a **draft** GitHub release with `main.js`, `manifest.json`, `styles.css`.
4. Publish the draft on GitHub — BRAT only sees published releases.
```

- [ ] **Step 2: README — update the settings/usage passages**

Wherever the README currently says the groups file can be created from Settings ("Create config-sync.json" button) or mentions the JSON textarea, replace with:

```markdown
Groups and external sources are edited as forms in Settings → Config Sync. The groups file `<data folder>/config-sync.json` is created automatically on first Publish/Apply (starter: snippets + hotkeys) or by the first valid edit in settings; JSON-savvy users can still edit it directly (a JSON Schema reference is included). **PKM mode** picks the default data folder — Auto detects IOTO via the `ioto-update` plugin and uses `<extraFolder>/config-sync` read from ioto-settings (fallback `0-Extra/config-sync`); otherwise `config-sync`. A non-empty Data folder value always overrides the mode; leave it empty to follow.
```

- [ ] **Step 3: CLAUDE.md — releasing pointer + expanded smoke section**

Add under "## Commands":

```markdown
- Releasing: `npm version <x.y.z>` → `git push --follow-tags` → CI drafts the release → publish the draft on GitHub (BRAT needs a published release).
```

Replace the existing "## Smoke testing" section body with:

```markdown
`dev/vault/` (gitignored) is a disposable Obsidian vault for CLI-driven smoke tests. Install the current build with `npm run smoke:install`, then drive the RUNNING app with the official CLI (`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`):

- `vaults verbose` lists registered vaults; target one with `vault=<folder-basename>`.
- `command id=obsidian-config-sync:<publish|apply|revert-last-apply|import-from-external>` runs commands; `plugin:reload id=obsidian-config-sync` reloads a dev build; `dev:errors` shows console errors; `dev:mobile on` emulates mobile; `dev:dom` / `dev:screenshot` inspect UI.
- Drive modals via `eval code=...`: `document.querySelectorAll('.modal .checkbox-container')[i].click()` toggles, find buttons by textContent (e.g. Continue), `.modal-close-button` closes reports, `.suggestion-item` picks in fuzzy modals.
- **Vault registration is human-only**: Obsidian rebuilds its vault registry from internal state at startup, pruning injected entries; the CLI cannot register or open new vaults. A human must "Open folder as vault" + Trust once — afterwards CLI automation is fully autonomous. CLI calls against a stale vault hang (~2 min).
- Never smoke-test in a real vault.
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm test` — both green (docs must not affect them).

```bash
git add README.md CLAUDE.md
git commit -m "docs: release procedure, CLI smoke knowledge, form-based settings"
```

---

### Task 7 (GATED — requires explicit user confirmation at execution time): first GitHub Release

**Files:** none (git tag + GitHub).

**Pre-condition:** Tasks 1–6 merged to `main` (or the user explicitly chooses to release from the feature branch); the orchestrator has ASKED THE USER and received a yes. If the user says no or is unavailable, skip this task and mark it deferred.

- [ ] **Step 1: Confirm version** — `manifest.json` version is `0.1.0` and has never been released; this iteration ships within `0.1.0` as the first release. Verify: `gh release list` shows none; `git tag` shows no `0.1.0`.

- [ ] **Step 2: Tag and push**

```bash
git tag 0.1.0
git push origin 0.1.0
```

- [ ] **Step 3: Watch the workflow**

Run: `gh run watch --exit-status $(gh run list --workflow "Release Obsidian plugin" --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: success; `gh release view 0.1.0` shows a DRAFT with main.js / manifest.json / styles.css attached.

- [ ] **Step 4: Hand off to the user** — publishing the draft is a human action on GitHub (release notes review). Report the draft URL.

---

## Out of scope

Real-device acceptance (BRAT install, iPhone, kickstart import channels) and the deferred v0.1.0 minors (FETCH_HEAD pinning, publish partial-failure semantics, revert without plugin cycle, binary files, getSettingDefinitions) remain tracked in `.superpowers/sdd/progress.md`.
