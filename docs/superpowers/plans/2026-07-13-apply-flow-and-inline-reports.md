# Apply Flow & Inline Reports (0.20.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Availability-layered Sync Center (main list + Outdated/Disabled/Not-installed sections with per-item state policies), a community-plugin install/update engine, inline result strips replacing report modals, and deletion of the pre-apply confirmation flow.

**Architecture:** Core gains an availability module (kind + version drift per group), an installer (community catalog → latest release download), and `applyWithActions` (state steps before config writes, outcome notes on `GroupResult`). The Sync Center buckets rows by availability into sections whose per-item "On apply" segments are composed from the item's gap list; results render as an inline strip whose expanded body shares markup with the restyled ReportModal (now Revert-only). `checkApply`/`confirmWarnings` are deleted.

**Tech Stack:** TypeScript, Obsidian API (`requestUrl`, `apiVersion`), vitest + MemFS test harness, esbuild.

## Global Constraints

- Copy is verbatim from the spec (`docs/superpowers/specs/2026-07-13-apply-flow-and-inline-reports-design.md`). Key strings repeated in each task; do not paraphrase.
- Error copy carries no prefixes ("Not saved", "Invalid …" are banned): state which item + what happened + the way out.
- No back-compat shims or migrations; `parseStoreLock` simply accepts the widened schema.
- All user-facing item names go through `displayName`/`labelFor`; raw group names appear only in code and store files.
- Checkbox = config participation; segment = plugin-state action; footer = only execution point. No inline immediate actions.
- Top-level counts (header pills, sidebar badges, filter pills, footer staged count, main select-all) count main-list rows only.
- Gate for every task: `npm test && npm run build && npm run lint` (lint baseline: 0 errors / 66 warnings; do not add errors).
- Commits: conventional messages, no Claude/AI attribution of any kind.

---

### Task 1: PluginHost expansion + widened lock schema + app-version recording

**Files:**
- Modify: `src/core/types.ts:26-29` (StoreLock)
- Modify: `src/core/manifest.ts:133-151` (parseStoreLock)
- Modify: `src/core/ConfigSyncCore.ts:9-16` (PluginHost), `:152-166` (capture version recording)
- Modify: `src/main.ts:53-64` (registry interfaces), `:330-340` (pluginHost)
- Modify: `tests/memfs.ts:90-116` (FakePlugins)
- Test: `tests/manifest.test.ts`, `tests/core.test.ts`

**Interfaces:**
- Produces: `PluginHost` gains `getAppVersion(): string`, `isCorePluginEnabled(id: string): boolean`, `enableCorePlugin(id: string): Promise<void>`, `reloadPluginManifests(): Promise<void>`. `StoreLock.groups` values become `{ sourcePluginVersion?: string; sourceAppVersion?: string }`. Capture writes `sourceAppVersion` for every group without a plugin id.

- [ ] **Step 1: Write failing tests**

Append to `tests/manifest.test.ts`:

```ts
describe("parseStoreLock widened schema", () => {
  it("accepts sourceAppVersion entries", () => {
    const lock = parseStoreLock(JSON.stringify({ capturedAt: "2026-01-01T00:00:00Z", groups: { hotkeys: { sourceAppVersion: "1.8.7" } } }));
    expect(lock.groups["hotkeys"]).toEqual({ sourceAppVersion: "1.8.7" });
  });
  it("rejects entries with neither version key", () => {
    expect(() => parseStoreLock(JSON.stringify({ capturedAt: "x", groups: { a: {} } }))).toThrow(
      'store.lock.json group "a" must have a string sourcePluginVersion or sourceAppVersion'
    );
  });
});
```

Append to `tests/core.test.ts` (inside a new describe):

```ts
describe("capture app-version recording", () => {
  it("records sourceAppVersion for non-plugin groups and sourcePluginVersion for plugin groups", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/config-sync.json": MANIFEST,
      ".obs/hotkeys.json": "{}",
      ".obs/plugins/demo/data.json": "{}",
    });
    await capture(ctx, ["hotkeys", "plugin-demo"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json"));
    expect(lock.groups["hotkeys"]).toEqual({ sourceAppVersion: "1.8.7" });
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/manifest.test.ts tests/core.test.ts`
Expected: FAIL (message mismatch on the reject test; `sourceAppVersion` missing from lock; FakePlugins lacks `getAppVersion` — TypeScript error).

- [ ] **Step 3: Implement**

`src/core/types.ts` — replace `StoreLock`:

```ts
export interface StoreLock {
  capturedAt: string;
  groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string }>;
}
```

`src/core/manifest.ts` — replace the body of the group loop in `parseStoreLock`:

```ts
  const groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string }> = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    const plugin = isPlainObject(v) && typeof v.sourcePluginVersion === "string" ? v.sourcePluginVersion : undefined;
    const app = isPlainObject(v) && typeof v.sourceAppVersion === "string" ? v.sourceAppVersion : undefined;
    if (plugin === undefined && app === undefined) {
      throw new ManifestValidationError(`store.lock.json group "${k}" must have a string sourcePluginVersion or sourceAppVersion`);
    }
    groups[k] = {};
    if (plugin !== undefined) groups[k].sourcePluginVersion = plugin;
    if (app !== undefined) groups[k].sourceAppVersion = app;
  }
```

`src/core/ConfigSyncCore.ts` — extend `PluginHost`:

```ts
export interface PluginHost {
  getInstalledPluginVersion(id: string): string | null;
  isPluginEnabled(id: string): boolean;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  getInstalledPluginName(id: string): string | null;
  getCorePluginName(id: string): string | null;
  getAppVersion(): string;
  isCorePluginEnabled(id: string): boolean;
  enableCorePlugin(id: string): Promise<void>;
  reloadPluginManifests(): Promise<void>;
}
```

In `capture()` (the `pluginId !== null` block at ~line 152), add an `else` branch so non-plugin groups record the app version:

```ts
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      // ... existing plugin-version recording unchanged ...
    } else if (result.status !== "error") {
      lock.groups[group.name] = { sourceAppVersion: ctx.plugins.getAppVersion() };
    }
```

`tests/memfs.ts` — extend `FakePlugins`:

```ts
  appVersion = "1.8.7";
  coreEnabled = new Set<string>();

  getAppVersion(): string {
    return this.appVersion;
  }
  isCorePluginEnabled(id: string): boolean {
    return this.coreEnabled.has(id);
  }
  async enableCorePlugin(id: string): Promise<void> {
    this.coreEnabled.add(id);
    this.log.push(`enable-core:${id}`);
  }
  async reloadPluginManifests(): Promise<void> {
    this.log.push("reload-manifests");
  }
```

`src/main.ts` — extend the registry interfaces and `pluginHost()`:

```ts
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string }>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  loadManifests(): Promise<void>;
}

interface InternalPluginsRegistry {
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string }; enable(): Promise<void> }>;
}
```

Add `import { apiVersion } from "obsidian"` (merge into the existing obsidian import) and extend `pluginHost()`:

```ts
      getAppVersion: () => apiVersion,
      isCorePluginEnabled: (id) => this.internalPlugins().plugins[id]?.enabled === true,
      enableCorePlugin: async (id) => {
        const p = this.internalPlugins().plugins[id];
        if (p === undefined) throw new Error(`core plugin "${id}" does not exist in this Obsidian build`);
        await p.enable();
      },
      reloadPluginManifests: () => this.pluginRegistry().loadManifests(),
```

- [ ] **Step 4: Run gate** — `npm test && npm run build && npm run lint` all green.
- [ ] **Step 5: Commit** — `git commit -m "feat: widen store lock schema and record app version for non-plugin groups"`

---

### Task 2: Availability module

**Files:**
- Create: `src/core/availability.ts`
- Test: `tests/availability.test.ts`

**Interfaces:**
- Consumes: `PluginHost` from Task 1 (incl. `getAppVersion`, `isCorePluginEnabled`), `StoreLock` widened schema, `pluginIdForGroup`, `CORE_SETTINGS_IDS` from `src/core/catalog.ts`.
- Produces: `AvailabilityKind`, `VersionDrift`, `Availability`, `compareVersions(a, b): number`, `availabilityForGroup(group, plugins, lock): Availability`.

- [ ] **Step 1: Write failing tests** — create `tests/availability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { availabilityForGroup, compareVersions } from "../src/core/availability";
import { FakePlugins } from "./memfs";
import { StoreLock, SyncGroup } from "../src/core/types";

const pluginGroup: SyncGroup = { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" };
const coreGroup: SyncGroup = { name: "daily-notes", path: "{configDir}/daily-notes.json", type: "file", devices: "all" };
const obsGroup: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
const lock = (groups: StoreLock["groups"]): StoreLock => ({ capturedAt: "2026-01-01T00:00:00Z", groups });

describe("compareVersions", () => {
  it("orders dotted numerics", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.8.7", "1.8.2")).toBe(1);
  });
});

describe("availabilityForGroup", () => {
  it("classifies community plugins: enabled / disabled / not-installed with drift", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    p.enabled.add("demo");
    const a = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.4.0" } }));
    expect(a).toEqual({ kind: "enabled", drift: "behind", localVersion: "2.2.1", storeVersion: "2.4.0", anchor: "plugin" });
    p.enabled.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, null).kind).toBe("disabled");
    p.installed.delete("demo");
    const ni = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.4.0" } }));
    expect(ni.kind).toBe("not-installed");
    expect(ni.drift).toBeNull();
  });
  it("anchors core and obsidian groups to the app version", () => {
    const p = new FakePlugins();
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    const core = availabilityForGroup(coreGroup, p, lock({ "daily-notes": { sourceAppVersion: "1.9.2" } }));
    expect(core).toEqual({ kind: "enabled", drift: "behind", localVersion: "1.8.7", storeVersion: "1.9.2", anchor: "app" });
    p.coreEnabled.delete("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).kind).toBe("disabled");
    const obs = availabilityForGroup(obsGroup, p, lock({ hotkeys: { sourceAppVersion: "1.8.7" } }));
    expect(obs).toEqual({ kind: "enabled", drift: null, localVersion: "1.8.7", storeVersion: "1.8.7", anchor: "app" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/availability.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** — create `src/core/availability.ts`:

```ts
import { PluginHost, pluginIdForGroup } from "./ConfigSyncCore";
import { CORE_SETTINGS_IDS } from "./catalog";
import { StoreLock, SyncGroup } from "./types";

export type AvailabilityKind = "enabled" | "disabled" | "not-installed";
export type VersionDrift = "behind" | "ahead" | null; // local vs store: behind = local < store

export interface Availability {
  kind: AvailabilityKind;
  drift: VersionDrift;
  localVersion: string | null;
  storeVersion: string | null;
  anchor: "plugin" | "app";
}

// Dotted compare: numeric segments numerically, non-numeric lexically, missing = "0".
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? "0";
    const y = bs[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function driftFor(local: string | null, store: string | null): VersionDrift {
  if (local === null || store === null) return null;
  const c = compareVersions(local, store);
  return c === 0 ? null : c < 0 ? "behind" : "ahead";
}

export function availabilityForGroup(group: SyncGroup, plugins: PluginHost, lock: StoreLock | null): Availability {
  const pluginId = pluginIdForGroup(group);
  if (pluginId !== null) {
    const localVersion = plugins.getInstalledPluginVersion(pluginId);
    const storeVersion = lock?.groups[group.name]?.sourcePluginVersion ?? null;
    const kind: AvailabilityKind =
      localVersion === null ? "not-installed" : plugins.isPluginEnabled(pluginId) ? "enabled" : "disabled";
    return {
      kind,
      drift: kind === "not-installed" ? null : driftFor(localVersion, storeVersion),
      localVersion,
      storeVersion,
      anchor: "plugin",
    };
  }
  const localVersion = plugins.getAppVersion();
  const storeVersion = lock?.groups[group.name]?.sourceAppVersion ?? null;
  const isCore = CORE_SETTINGS_IDS.includes(group.name);
  const kind: AvailabilityKind = isCore && !plugins.isCorePluginEnabled(group.name) ? "disabled" : "enabled";
  return { kind, drift: driftFor(localVersion, storeVersion), localVersion, storeVersion, anchor: "app" };
}
```

- [ ] **Step 4: Run gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 5: Commit** — `git commit -m "feat: availability classification with version drift"`

---

### Task 3: Install/update engine

**Files:**
- Create: `src/core/installer.ts`
- Test: `tests/installer.test.ts`

**Interfaces:**
- Consumes: `FileIO` from `src/core/io.ts`.
- Produces: `HttpGet = (url: string) => Promise<ArrayBuffer>`, `CatalogError`, `DownloadError`, `COMMUNITY_CATALOG_URL`, `createInstaller(io, configDir, http): (pluginId: string) => Promise<string>` (resolves to the installed manifest version; caches the catalog per installer instance).

- [ ] **Step 1: Write failing tests** — create `tests/installer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COMMUNITY_CATALOG_URL, CatalogError, DownloadError, createInstaller } from "../src/core/installer";
import { MemFS } from "./memfs";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const CATALOG = JSON.stringify([{ id: "demo", name: "Demo", repo: "acme/demo" }]);

function fakeHttp(files: Record<string, string | null>): { http: (url: string) => Promise<ArrayBuffer>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    http: async (url: string) => {
      calls.push(url);
      const body = files[url];
      if (body === undefined || body === null) throw new Error(`404 ${url}`);
      return enc(body);
    },
  };
}

describe("createInstaller", () => {
  const base = "https://github.com/acme/demo/releases/latest/download";
  it("downloads manifest/main.js/styles.css into the plugin dir and returns the version", async () => {
    const io = new MemFS();
    const { http, calls } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: "module.exports = {};",
      [`${base}/styles.css`]: ".x{}",
    });
    const install = createInstaller(io, ".obs", http);
    expect(await install("demo")).toBe("2.5.0");
    expect(await io.read(".obs/plugins/demo/manifest.json")).toContain("2.5.0");
    expect(await io.read(".obs/plugins/demo/main.js")).toBe("module.exports = {};");
    expect(await io.read(".obs/plugins/demo/styles.css")).toBe(".x{}");
    await install("demo");
    expect(calls.filter((u) => u === COMMUNITY_CATALOG_URL)).toHaveLength(1); // catalog cached
  });
  it("tolerates a missing styles.css", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: "x",
      [`${base}/styles.css`]: null,
    });
    expect(await createInstaller(io, ".obs", http)("demo")).toBe("2.5.0");
    expect(await io.exists(".obs/plugins/demo/styles.css")).toBe(false);
  });
  it("throws CatalogError for unknown ids and DownloadError for failed required assets", async () => {
    const io = new MemFS();
    const miss = fakeHttp({ [COMMUNITY_CATALOG_URL]: CATALOG });
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow(CatalogError);
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow(
      'nope isn\'t in the community catalog — install it manually'
    );
    const noMain = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: null,
    });
    await expect(createInstaller(io, ".obs", noMain.http)("demo")).rejects.toThrow(DownloadError);
    await expect(createInstaller(io, ".obs", noMain.http)("demo")).rejects.toThrow(
      "couldn't download demo from the community catalog"
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/installer.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** — create `src/core/installer.ts`:

```ts
import { FileIO, ensureParentDir } from "./io";

export type HttpGet = (url: string) => Promise<ArrayBuffer>; // must throw on non-2xx

export class CatalogError extends Error {}
export class DownloadError extends Error {}

export const COMMUNITY_CATALOG_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

interface CatalogEntry {
  id: string;
  repo: string;
}

const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(buf);

// Returns an install function that downloads a community plugin's latest release
// (manifest.json + main.js required, styles.css optional) into {configDir}/plugins/{id}/
// and resolves to the installed manifest version. The catalog is fetched once per installer.
export function createInstaller(io: FileIO, configDir: string, http: HttpGet): (pluginId: string) => Promise<string> {
  let catalog: Promise<CatalogEntry[]> | null = null;
  const loadCatalog = (): Promise<CatalogEntry[]> => {
    if (catalog === null) {
      catalog = http(COMMUNITY_CATALOG_URL).then((buf) => JSON.parse(decode(buf)) as CatalogEntry[]);
      catalog.catch(() => {
        catalog = null; // a failed fetch must not poison later installs
      });
    }
    return catalog;
  };
  return async (pluginId: string): Promise<string> => {
    const entries = await loadCatalog();
    const entry = entries.find((e) => e.id === pluginId);
    if (entry === undefined) {
      throw new CatalogError(`${pluginId} isn't in the community catalog — install it manually`);
    }
    const base = `https://github.com/${entry.repo}/releases/latest/download`;
    const required = async (file: string): Promise<string> => {
      try {
        return decode(await http(`${base}/${file}`));
      } catch {
        throw new DownloadError(`couldn't download ${pluginId} from the community catalog`);
      }
    };
    const manifestRaw = await required("manifest.json");
    const mainJs = await required("main.js");
    const manifest = JSON.parse(manifestRaw) as { version?: string };
    if (typeof manifest.version !== "string") {
      throw new DownloadError(`couldn't download ${pluginId} from the community catalog`);
    }
    const dir = `${configDir}/plugins/${pluginId}`;
    await ensureParentDir(io, `${dir}/manifest.json`);
    await io.write(`${dir}/manifest.json`, manifestRaw);
    await io.write(`${dir}/main.js`, mainJs);
    try {
      await io.write(`${dir}/styles.css`, decode(await http(`${base}/styles.css`)));
    } catch {
      // styles.css is optional — many plugins ship without one
    }
    return manifest.version;
  };
}
```

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: community-plugin install engine (catalog + latest release download)"`

---

### Task 4: applyWithActions + delete checkApply/confirmWarnings

**Files:**
- Modify: `src/core/types.ts:41-49` (GroupResult), `src/core/ConfigSyncCore.ts` (add StateAction/applyWithActions; delete `checkApply`/`ApplyWarning` at lines 221-271)
- Modify: `src/main.ts` (applyItems wiring, installer plumbing, delete confirmWarnings import)
- Modify: `src/ui/ConfirmModal.ts` (delete `confirmWarnings`; delete the whole file if nothing else imports it — verify with `grep -rn "ConfirmModal\|confirmWarnings" src/`)
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `createInstaller` (Task 3), `PluginHost` extensions (Task 1).
- Produces: `StateAction = "none" | "enable" | "update" | "update-enable" | "install" | "install-enable"`, `ApplyItem { name: string; action: StateAction }`, `PluginInstallFn = (pluginId: string) => Promise<string>`, `applyWithActions(ctx, items: ApplyItem[], installPlugin: PluginInstallFn, onProgress?): Promise<GroupResult[]>`, `GroupResult.stateNote?: { kind: "ok" | "warn"; text: string }`. `SyncCenterHost.applyItems` still takes `names: string[]` in this task (mapped to action `"none"`); Task 8 switches it to `ApplyItem[]`.

- [ ] **Step 1: Write failing tests** — in `tests/core.test.ts`, DELETE the existing `checkApply` describe block and its import, then append:

```ts
import { applyWithActions } from "../src/core/ConfigSyncCore"; // merge into the existing import list

describe("applyWithActions", () => {
  const seedStore = (io: MemFS): void => {
    io.seed({
      "cs/config-sync.json": MANIFEST,
      "cs/store/configdir/plugins/demo/data.json": '{"theme":"x"}',
    });
  };
  it("enable action enables then writes config and notes ⏻ enabled", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    seedStore(io);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "enable" }], async () => "9.9.9");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⏻ enabled" });
    expect(plugins.enabled.has("demo")).toBe(true);
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true);
  });
  it("install-enable installs, reloads manifests, enables, writes config", async () => {
    const { io, plugins, ctx } = setup();
    seedStore(io);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install-enable" }], async (id) => {
      plugins.installed.set(id, "2.5.0");
      return "2.5.0";
    });
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "⤓ installed & enabled 2.5.0" });
    expect(plugins.log).toContain("reload-manifests");
    expect(plugins.enabled.has("demo")).toBe(true);
  });
  it("update failure skips the config write and warns; install failure still writes", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.0.0");
    plugins.enabled.add("demo");
    seedStore(io);
    const failing = async (): Promise<string> => {
      throw new Error("couldn't download demo from the community catalog");
    };
    const upd = await applyWithActions(ctx, [{ name: "plugin-demo", action: "update" }], failing);
    expect(upd[0]?.status).toBe("warning");
    expect(upd[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ update failed" });
    expect(upd[0]?.messages[0]).toContain("settings not applied; they were captured on a newer version");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(false);
    plugins.installed.delete("demo");
    plugins.enabled.delete("demo");
    const inst = await applyWithActions(ctx, [{ name: "plugin-demo", action: "install" }], failing);
    expect(inst[0]?.stateNote).toEqual({ kind: "warn", text: "⚠ install failed" });
    expect(inst[0]?.messages[0]).toContain("settings were staged; install it manually to pick them up");
    expect(await io.exists(".obs/plugins/demo/data.json")).toBe(true);
  });
  it('action "none" on a not-installed plugin notes staged for install', async () => {
    const { io, plugins, ctx } = setup();
    void plugins;
    seedStore(io);
    const results = await applyWithActions(ctx, [{ name: "plugin-demo", action: "none" }], async () => "x");
    expect(results[0]?.stateNote).toEqual({ kind: "ok", text: "staged for install" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/core.test.ts` → FAIL (`applyWithActions` not exported; checkApply import removal breaks first — fix imports as part of this step's edit).
- [ ] **Step 3: Implement**

`src/core/types.ts` — add to `GroupResult`:

```ts
  stateNote?: { kind: "ok" | "warn"; text: string };
```

`src/core/ConfigSyncCore.ts` — DELETE `ApplyWarning` (lines 221-224) and `checkApply` (243-271). Add after `apply()`:

```ts
export type StateAction = "none" | "enable" | "update" | "update-enable" | "install" | "install-enable";

export interface ApplyItem {
  name: string;
  action: StateAction;
}

export type PluginInstallFn = (pluginId: string) => Promise<string>; // resolves to the installed version

interface StatePrelude {
  note: { kind: "ok" | "warn"; text: string } | null;
  messages: string[];
  skipConfig: boolean;
}

async function runStateAction(
  ctx: CoreContext,
  group: SyncGroup,
  action: StateAction,
  installPlugin: PluginInstallFn
): Promise<StatePrelude> {
  const pluginId = pluginIdForGroup(group);
  if (action === "none") {
    if (pluginId !== null && ctx.plugins.getInstalledPluginVersion(pluginId) === null) {
      return { note: { kind: "ok", text: "staged for install" }, messages: [], skipConfig: false };
    }
    return { note: null, messages: [], skipConfig: false };
  }
  if (action === "enable") {
    try {
      if (pluginId !== null) await ctx.plugins.enablePlugin(pluginId);
      else await ctx.plugins.enableCorePlugin(group.name);
      return { note: { kind: "ok", text: "⏻ enabled" }, messages: [], skipConfig: false };
    } catch (e) {
      return { note: { kind: "warn", text: "⚠ enable failed" }, messages: [(e as Error).message], skipConfig: false };
    }
  }
  if (pluginId === null) {
    return {
      note: { kind: "warn", text: "⚠ update failed" },
      messages: [`"${group.name}" has no plugin directory — install and update actions only work for community plugin items`],
      skipConfig: true,
    };
  }
  const isUpdate = action === "update" || action === "update-enable";
  const wantsEnable = action === "update-enable" || action === "install-enable";
  const wasEnabled = ctx.plugins.isPluginEnabled(pluginId);
  try {
    if (isUpdate && wasEnabled) await ctx.plugins.disablePlugin(pluginId);
    const version = await installPlugin(pluginId);
    await ctx.plugins.reloadPluginManifests();
    let enabled = false;
    if (wantsEnable || (isUpdate && wasEnabled)) {
      await ctx.plugins.enablePlugin(pluginId);
      enabled = true;
    }
    const text = isUpdate
      ? enabled
        ? `⤓ updated to ${version} & enabled`
        : `⤓ updated to ${version}`
      : enabled
        ? `⤓ installed & enabled ${version}`
        : `⤓ installed ${version}`;
    return { note: { kind: "ok", text }, messages: [], skipConfig: false };
  } catch (e) {
    const messages = [(e as Error).message];
    if (isUpdate) {
      if (wasEnabled) {
        try {
          await ctx.plugins.enablePlugin(pluginId); // download failed before files changed — restore the running state
        } catch (re) {
          messages.push((re as Error).message);
        }
      }
      return {
        note: { kind: "warn", text: "⚠ update failed" },
        messages: [`${messages[0]} — settings not applied; they were captured on a newer version`, ...messages.slice(1)],
        skipConfig: true,
      };
    }
    return {
      note: { kind: "warn", text: "⚠ install failed" },
      messages: [`${messages[0]} — settings were staged; install it manually to pick them up`],
      skipConfig: false,
    };
  }
}

export async function applyWithActions(
  ctx: CoreContext,
  items: ApplyItem[],
  installPlugin: PluginInstallFn,
  onProgress?: ProgressFn
): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  if (await ctx.io.exists(backupDir(ctx))) {
    await ctx.io.rmdir(backupDir(ctx), true);
  }
  const state: BackupState = {
    index: { createdAt: ctx.now(), entries: [] },
    counter: 0,
    backedUp: new Set(),
  };
  const results: GroupResult[] = [];
  let done = 0;
  try {
    for (const item of items) {
      onProgress?.(done, items.length, item.name);
      const group = requireGroup(manifest, item.name);
      const prelude = await runStateAction(ctx, group, item.action, installPlugin);
      if (prelude.skipConfig) {
        const r = emptyResult(item.name, false);
        r.status = "warning";
        if (prelude.note !== null) r.stateNote = prelude.note;
        r.messages.push(...prelude.messages);
        results.push(r);
      } else {
        const r = await applyGroup(ctx, group, state);
        if (prelude.note !== null) r.stateNote = prelude.note;
        if (prelude.messages.length > 0) {
          r.messages.push(...prelude.messages);
          if (r.status === "ok") r.status = "warning";
        }
        results.push(r);
      }
      done++;
    }
  } finally {
    const indexPath = `${backupDir(ctx)}/index.json`;
    await ensureParentDir(ctx.io, indexPath);
    await ctx.io.write(indexPath, JSON.stringify(state.index, null, 2) + "\n");
  }
  return results;
}
```

Keep the plain `apply()` export — command-palette flows and tests still use it.

`src/main.ts`:
- Remove `checkApply` from the core import and the `confirmWarnings` import; import `applyWithActions`, `PluginInstallFn` from the core, `createInstaller` from `./core/installer`, and `requestUrl` (merge into the obsidian import).
- Add the installer accessor to the plugin class:

```ts
  private installFn: PluginInstallFn | null = null;

  installPlugin(): PluginInstallFn {
    if (this.installFn === null) {
      this.installFn = createInstaller(this.app.vault.adapter, this.app.vault.configDir, async (url) => {
        const res = await requestUrl({ url, throw: true });
        return res.arrayBuffer;
      });
    }
    return this.installFn;
  }
```

- Replace the body of the host's `applyItems` (drop the warnings block):

```ts
      applyItems: async (names: string[], onProgress?: ProgressFn) => {
        try {
          const ctx = await this.coreContext();
          const results = await applyWithActions(ctx, names.map((name) => ({ name, action: "none" as const })), this.installPlugin(), onProgress);
          new ReportModal(this.app, "Applied", results, new Date().toLocaleString(), (g) => this.displayName(g)).open();
          await this.refreshLocalStatus();
        } catch (e) {
          new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
        }
      },
```

`src/ui/ConfirmModal.ts`: run `grep -rn "ConfirmModal\|confirmWarnings" src/` — if `main.ts` was the only consumer, delete the file; otherwise delete only `confirmWarnings`.

- [ ] **Step 4: Run gate** — green (166-ish tests minus deleted checkApply, plus 4 new).
- [ ] **Step 5: Commit** — `git commit -m "feat: applyWithActions state pipeline; drop pre-apply warnings flow"`

---

### Task 5: Shared report content + ReportModal restyle

**Files:**
- Create: `src/ui/reportContent.ts`
- Modify: `src/ui/ReportModal.ts` (delegate to reportContent), `src/main.ts:366` (Revert title), `styles.css` (append)
- Test: `tests/reportContent.test.ts`

**Interfaces:**
- Consumes: `GroupResult` (incl. `stateNote`), `CATEGORY_LABELS`/`categoryForGroup` from catalog.
- Produces: `chipTooltip(kind, n): string`, `renderReportPills(host, results): void`, `renderReportContent(container, results, opts): void` with `opts: { labelFor(group: string): string; onReload(): void }`. `REPORT_CATEGORY_ORDER` export. Task 6's strip calls these.

- [ ] **Step 1: Write failing test** — create `tests/reportContent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chipTooltip } from "../src/ui/reportContent";

describe("chipTooltip", () => {
  it("pluralizes per kind", () => {
    expect(chipTooltip("add", 1)).toBe("1 file added");
    expect(chipTooltip("upd", 2)).toBe("2 files updated");
    expect(chipTooltip("del", 3)).toBe("3 files deleted");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/reportContent.test.ts` → FAIL.
- [ ] **Step 3: Implement** — create `src/ui/reportContent.ts` (row rendering moves here from ReportModal; DOM helpers are Obsidian's `createDiv/createSpan` element extensions):

```ts
import { Setting } from "obsidian";
import { GroupResult, hasChanges } from "../core/types";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";

export const REPORT_CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

export function chipTooltip(kind: "add" | "upd" | "del", n: number): string {
  const verb = kind === "add" ? "added" : kind === "upd" ? "updated" : "deleted";
  return `${n} file${n === 1 ? "" : "s"} ${verb}`;
}

export interface ReportContentOpts {
  labelFor(group: string): string;
  onReload(): void;
}

export function changedOf(results: GroupResult[]): { changed: GroupResult[]; unchanged: GroupResult[] } {
  const changed = results.filter((r) => r.status !== "ok" || hasChanges(r.changes) || r.stateNote !== undefined);
  return { changed, unchanged: results.filter((r) => !changed.includes(r)) };
}

export function renderReportPills(host: HTMLElement, results: GroupResult[]): void {
  const { changed, unchanged } = changedOf(results);
  const pills = host.createSpan({ cls: "config-sync-report-pills" });
  pills.createSpan({ cls: "config-sync-pill is-neutral", text: `${changed.length} changed` });
  if (unchanged.length > 0) pills.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${unchanged.length}` });
}

export function renderReportContent(container: HTMLElement, results: GroupResult[], opts: ReportContentOpts): void {
  const { changed, unchanged } = changedOf(results);
  container.createDiv({ cls: "config-sync-report-legend", text: "+ added · ~ updated · − deleted (files)" });
  for (const cat of REPORT_CATEGORY_ORDER) {
    const inCat = changed.filter((r) => r.group !== "" && categoryForGroup(r.group) === cat);
    if (inCat.length === 0) continue;
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: CATEGORY_LABELS[cat] });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: `${inCat.length}` });
    const block = container.createDiv({ cls: "config-sync-card" });
    for (const r of inCat) renderResultRow(block, r, opts.labelFor(r.group));
  }
  const meta = changed.find((r) => r.group === "");
  if (meta !== undefined) {
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: "Store metadata" });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: "1" });
    renderResultRow(container.createDiv({ cls: "config-sync-card" }), meta, "store metadata");
  }
  if (unchanged.length > 0) {
    const line = container.createDiv({
      cls: "config-sync-unchanged",
      text: `✓ ${unchanged.length} item${unchanged.length === 1 ? "" : "s"} unchanged ▸`,
    });
    line.addEventListener("click", () => {
      line.setText(`✓ ${unchanged.map((r) => opts.labelFor(r.group)).join(" · ")}`);
    });
  }
  if (results.some((r) => r.needsAppReload)) {
    new Setting(container)
      .setName("Some changes need an app reload to take effect")
      .addButton((b) => b.setCta().setButtonText("Reload app").onClick(() => opts.onReload()));
  }
}

function renderResultRow(block: HTMLElement, r: GroupResult, label: string): void {
  const isError = r.status !== "ok";
  const row = block.createDiv({ cls: "config-sync-report-row" });
  const chev = row.createSpan({ cls: "config-sync-row-chevron", text: isError ? "▾" : "▸" });
  row.createSpan({ cls: "config-sync-rule-name", text: label });
  if (r.stateNote !== undefined) {
    row.createSpan({
      cls: `config-sync-pill ${r.stateNote.kind === "warn" ? "is-warn" : "is-statenote"}`,
      text: r.stateNote.text,
    });
  } else if (isError) {
    row.createSpan({ cls: "config-sync-pill is-warn", text: r.status === "warning" ? "⚠" : "✗" });
  }
  row.createDiv({ cls: "config-sync-rule-spacer" });
  const chip = (kind: "add" | "upd" | "del", cls: string, glyph: string, n: number): void => {
    if (n > 0) row.createSpan({ cls: `config-sync-chip ${cls}`, text: `${glyph}${n}`, attr: { title: chipTooltip(kind, n) } });
  };
  chip("add", "is-add", "+", r.changes.added.length);
  chip("upd", "is-upd", "~", r.changes.updated.length);
  chip("del", "is-del", "−", r.changes.deleted.length);
  const detail = block.createDiv({ cls: "config-sync-report-files" });
  detail.hidden = !isError;
  for (const m of r.messages) detail.createDiv({ cls: "config-sync-status-error", text: `• ${m}` });
  for (const f of r.changes.added) detail.createDiv({ cls: "is-add", text: `+ ${f}` });
  for (const f of r.changes.updated) detail.createDiv({ cls: "is-upd", text: `~ ${f}` });
  for (const f of r.changes.deleted) detail.createDiv({ cls: "is-del", text: `− ${f}` });
  row.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    chev.setText(detail.hidden ? "▸" : "▾");
  });
}
```

Replace `src/ui/ReportModal.ts` wholesale:

```ts
import { App, Modal } from "obsidian";
import { GroupResult } from "../core/types";
import { renderReportContent, renderReportPills } from "./reportContent";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

export class ReportModal extends Modal {
  constructor(
    app: App,
    private modalTitle: string,
    private results: GroupResult[],
    private subtitle: string | undefined,
    private labelFor: (group: string) => string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.addClass("config-sync-report-title");
    this.titleEl.setText(this.modalTitle);
    renderReportPills(this.titleEl, this.results);
    if (this.subtitle !== undefined) this.contentEl.createDiv({ cls: "config-sync-report-sub", text: this.subtitle });
    renderReportContent(this.contentEl, this.results, {
      labelFor: this.labelFor,
      onReload: () => (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload"),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

`src/main.ts` line ~366: revert title `"Config Sync: Revert report"` → `"Reverted"`.

Append to `styles.css`:

```css
/* 0.20.0 report styling */
.config-sync-report-legend { color: var(--text-faint); font-size: var(--font-ui-smaller); margin: 2px 0 8px; }
.config-sync-sect .config-sync-sect-count { margin-left: 6px; font-size: 10px; }
.config-sync-pill.is-statenote { background: rgba(88, 166, 160, 0.2); color: #58a6a0; }
```

Note: the old `config-sync-sect` rule renders plain text; it now wraps two spans — verify visually during smoke, no CSS change expected beyond the count pill.

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: shared report content with legend, section pills, chip tooltips"`

---

### Task 6: Inline result strip in the Sync Center

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (host contract + strip), `src/main.ts` (host methods return results instead of opening modals), `styles.css`

**Interfaces:**
- Consumes: `renderReportContent`/`renderReportPills` (Task 5).
- Produces: `SyncCenterHost.captureItems/applyItems` return `Promise<GroupResult[] | null>`; `pullFrom/pushTo` return `Promise<GroupResult[] | null>` (null = failed, Notice already shown). The view owns a `lastRun` strip state.

- [ ] **Step 1: Update the host contract** in `src/ui/SyncCenterView.ts`:

```ts
export interface SyncCenterHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[] }>;
  resolvedPath(group: SyncGroup): string;
  displayName(group: string): string;
  captureItems(names: string[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  applyItems(names: string[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  reloadApp(): void;
  remotes(): Remote[];
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  deepDiff(remote: Remote): Promise<RemoteDiffEntry[]>;
  pullFrom(remote: Remote): Promise<GroupResult[] | null>;
  pushTo(remote: Remote): Promise<GroupResult[] | null>;
}
```

Add imports: `GroupResult` from `../core/types`, `renderReportContent, renderReportPills` from `./reportContent`.

- [ ] **Step 2: Add strip state and rendering** to the view:

```ts
  private lastRun: { title: string; tone: "local" | "transfer"; results: GroupResult[]; expanded: boolean } | null = null;

  private setLastRun(title: string, tone: "local" | "transfer", results: GroupResult[] | null): void {
    if (results !== null) this.lastRun = { title, tone, results, expanded: false };
  }

  private renderResultStrip(main: HTMLElement): void {
    const run = this.lastRun;
    if (run === null) return;
    const strip = main.createDiv({ cls: `config-sync-strip${run.tone === "transfer" ? " is-transfer" : ""}` });
    const head = strip.createDiv({ cls: "config-sync-strip-head" });
    head.createSpan({ cls: "config-sync-strip-check", text: "✓" });
    head.createSpan({ cls: "config-sync-strip-title", text: run.title });
    renderReportPills(head, run.results);
    const toggle = head.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
    toggle.addEventListener("click", () => {
      run.expanded = !run.expanded;
      this.render(this.renderGen);
    });
    const close = head.createSpan({ cls: "config-sync-strip-close", text: "✕" });
    close.addEventListener("click", () => {
      this.lastRun = null;
      this.render(this.renderGen);
    });
    if (run.expanded) {
      renderReportContent(strip.createDiv({ cls: "config-sync-strip-body" }), run.results, {
        labelFor: (g) => this.host.displayName(g),
        onReload: () => this.host.reloadApp(),
      });
    }
  }
```

Call `this.renderResultStrip(main)` as the FIRST line of both `renderItemMode(main)` and `renderRemoteMode(main, remote)`.

- [ ] **Step 3: Route runs into the strip.** In `renderActionBar`'s `run()` helper, capture the results:

```ts
        try {
          const results = await exec(names, (done, total, current) => { /* existing progress body unchanged */ });
          this.setLastRun(verb === "Capturing" ? "Captured" : "Applied", "local", results);
        } finally {
          this.running = false;
        }
```

with `exec` retyped to `(names: string[], onProgress: ProgressFn) => Promise<GroupResult[] | null>`. In `renderRemoteButtons`, wire pull/push:

```ts
    pull.onClick(async () => {
      this.setLastRun(`Pulled from ${remote.name}`, "transfer", await this.host.pullFrom(remote));
      await this.reload();
    });
    // push mirrors: `Pushed to ${remote.name}`
```

- [ ] **Step 4: main.ts host update.** In `syncCenterHost()`: `captureItems`/`applyItems`/`pullFrom`/`pushTo` stop opening `ReportModal` and instead `return results;` (and `return null;` in each catch after the Notice). Add:

```ts
      reloadApp: () => (this.app as unknown as { commands: { executeCommandById(id: string): void } }).commands.executeCommandById("app:reload"),
```

The `ReportModal` import in `main.ts` stays (Revert still uses it).

- [ ] **Step 5: Strip CSS** — append to `styles.css`:

```css
.config-sync-strip { border: 1px solid rgba(125, 200, 125, 0.35); background: rgba(125, 200, 125, 0.07); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
.config-sync-strip.is-transfer { border-color: rgba(91, 200, 214, 0.4); background: rgba(91, 200, 214, 0.07); }
.config-sync-strip-head { display: flex; align-items: center; gap: 8px; }
.config-sync-strip-check { color: var(--color-green); }
.config-sync-strip-title { font-weight: 600; }
.config-sync-strip-toggle { color: var(--interactive-accent); cursor: pointer; font-size: var(--font-ui-smaller); }
.config-sync-strip-close { margin-left: auto; color: var(--text-faint); cursor: pointer; }
.config-sync-strip-body { margin-top: 6px; }
```

- [ ] **Step 6: Run gate** — green. **Step 7: Commit** — `git commit -m "feat: inline result strip replaces report modals for hub actions"`

---

### Task 7: Panel model helpers for sections and policies

**Files:**
- Modify: `src/ui/panelModel.ts`
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `Availability` (Task 2), `StateAction` (Task 4).
- Produces: `SectionKind`, `sectionForItem(a): SectionKind`, `PolicyOption { action; label; pill }`, `policyOptions(a): PolicyOption[]` (first entry = default; `[]` for plain main-list rows), `defaultPolicy(a): StateAction`, `versionLine(a): { text; tone: "gray" | "amber" } | null`, `footerSummary(staged, outdated, disabled, toInstall): string`, `SECTION_TITLES`, `SECTION_NOTES`.

- [ ] **Step 1: Write failing tests** — append to `tests/panelModel.test.ts`:

```ts
import { defaultPolicy, footerSummary, policyOptions, sectionForItem, versionLine } from "../src/ui/panelModel";
import { Availability } from "../src/core/availability";

const avail = (over: Partial<Availability>): Availability => ({
  kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: "1.0.0", anchor: "plugin", ...over,
});

describe("sectionForItem", () => {
  it("buckets by availability, then behind-drift for community plugins", () => {
    expect(sectionForItem(avail({ kind: "not-installed" }))).toBe("not-installed");
    expect(sectionForItem(avail({ kind: "disabled", drift: "behind" }))).toBe("disabled");
    expect(sectionForItem(avail({ drift: "behind", storeVersion: "2.0.0" }))).toBe("outdated");
    expect(sectionForItem(avail({ drift: "ahead" }))).toBe("main");
    expect(sectionForItem(avail({ anchor: "app", drift: "behind" }))).toBe("main");
  });
});

describe("policyOptions ladder", () => {
  it("composes options from the gap list, default first", () => {
    expect(policyOptions(avail({ kind: "not-installed" })).map((o) => o.action)).toEqual(["install-enable", "install", "none"]);
    expect(policyOptions(avail({ kind: "disabled" })).map((o) => o.action)).toEqual(["enable", "none"]);
    expect(policyOptions(avail({ kind: "disabled", drift: "behind" })).map((o) => o.action)).toEqual(["update-enable", "enable", "none"]);
    const outdated = policyOptions(avail({ drift: "behind", localVersion: "2.2.1", storeVersion: "2.4.0" }));
    expect(outdated.map((o) => o.action)).toEqual(["update", "none"]);
    expect(outdated[1]?.label).toBe("Keep 2.2.1");
    expect(policyOptions(avail({}))).toEqual([]);
    expect(defaultPolicy(avail({ kind: "not-installed" }))).toBe("install-enable");
    expect(defaultPolicy(avail({}))).toBe("none");
  });
});

describe("versionLine", () => {
  it("writes drift metadata per anchor and direction", () => {
    expect(versionLine(avail({ drift: "ahead", localVersion: "1.5.10", storeVersion: "1.4.2" }))).toEqual({
      text: "this device 1.5.10 · store 1.4.2 — newer here; capturing will refresh the store", tone: "gray",
    });
    expect(versionLine(avail({ kind: "disabled", drift: "behind", localVersion: "1.5.3", storeVersion: "1.8.0" }))?.text).toBe(
      "this device 1.5.3 · store 1.8.0 — settings were captured on a newer version"
    );
    expect(versionLine(avail({ anchor: "app", drift: "behind", localVersion: "1.8.7", storeVersion: "1.9.2" }))).toEqual({
      text: "captured on Obsidian 1.9.2 — this device runs 1.8.7; update Obsidian if settings look off", tone: "amber",
    });
    expect(versionLine(avail({}))).toBeNull();
  });
});

describe("footerSummary", () => {
  it("lists only non-zero sources", () => {
    expect(footerSummary(3, 0, 1, 2)).toBe("3 staged · +1 disabled · +2 to install");
    expect(footerSummary(4, 0, 0, 0)).toBe("4 staged");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/panelModel.test.ts` → FAIL.
- [ ] **Step 3: Implement** — append to `src/ui/panelModel.ts` (add imports `Availability` from `../core/availability`, `StateAction` from `../core/ConfigSyncCore`):

```ts
export type SectionKind = "main" | "outdated" | "disabled" | "not-installed";

export const SECTION_TITLES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Outdated on this device",
  disabled: "Disabled on this device",
  "not-installed": "Not installed on this device",
};

export const SECTION_NOTES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Store settings were captured on a newer plugin version than this device runs — updating first is the safe path.",
  disabled: "Settings sync either way — choose whether applying also turns the plugin on.",
  "not-installed": "Settings sync either way — choose whether applying also installs the plugin (latest version, from the community catalog).",
};

export function sectionForItem(a: Availability): SectionKind {
  if (a.kind === "not-installed") return "not-installed";
  if (a.kind === "disabled") return "disabled";
  if (a.anchor === "plugin" && a.drift === "behind") return "outdated";
  return "main";
}

export interface PolicyOption {
  action: StateAction;
  label: string;
  pill: string | null; // collapsed-row pill; null = no state action
}

export function policyOptions(a: Availability): PolicyOption[] {
  if (a.kind === "not-installed") {
    return [
      { action: "install-enable", label: "⤓ Install & enable", pill: "⤓ install & enable" },
      { action: "install", label: "⤓ Install", pill: "⤓ install" },
      { action: "none", label: "Stage only", pill: null },
    ];
  }
  if (a.kind === "disabled") {
    if (a.anchor === "plugin" && a.drift === "behind") {
      return [
        { action: "update-enable", label: "⤓ Update & enable", pill: "⤓ update & enable" },
        { action: "enable", label: "⏻ Enable", pill: "⏻ enable" },
        { action: "none", label: "Keep disabled", pill: null },
      ];
    }
    return [
      { action: "enable", label: "⏻ Enable", pill: "⏻ enable" },
      { action: "none", label: "Keep disabled", pill: null },
    ];
  }
  if (a.anchor === "plugin" && a.drift === "behind") {
    return [
      { action: "update", label: "⤓ Update to latest", pill: "⤓ update" },
      { action: "none", label: `Keep ${a.localVersion ?? "current"}`, pill: null },
    ];
  }
  return [];
}

export function defaultPolicy(a: Availability): StateAction {
  return policyOptions(a)[0]?.action ?? "none";
}

export function versionLine(a: Availability): { text: string; tone: "gray" | "amber" } | null {
  if (a.drift === null || a.localVersion === null || a.storeVersion === null) return null;
  if (a.anchor === "app") {
    return a.drift === "behind"
      ? { text: `captured on Obsidian ${a.storeVersion} — this device runs ${a.localVersion}; update Obsidian if settings look off`, tone: "amber" }
      : { text: `captured on Obsidian ${a.storeVersion} · this device runs ${a.localVersion}`, tone: "gray" };
  }
  if (a.drift === "ahead") {
    return { text: `this device ${a.localVersion} · store ${a.storeVersion} — newer here; capturing will refresh the store`, tone: "gray" };
  }
  const suffix = a.kind === "disabled" ? " — settings were captured on a newer version" : "";
  return { text: `this device ${a.localVersion} · store ${a.storeVersion}${suffix}`, tone: "gray" };
}

export function footerSummary(staged: number, outdated: number, disabled: number, toInstall: number): string {
  const parts = [`${staged} staged`];
  if (outdated > 0) parts.push(`+${outdated} outdated`);
  if (disabled > 0) parts.push(`+${disabled} disabled`);
  if (toInstall > 0) parts.push(`+${toInstall} to install`);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run gate** — green. **Step 5: Commit** — `git commit -m "feat: section/policy/version-line helpers for the availability panel"`

---

### Task 8: Availability sections in the Sync Center view

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `src/main.ts` (host: availability + ApplyItem signature), `styles.css`

**Interfaces:**
- Consumes: everything from Tasks 2/4/7.
- Produces: `SyncCenterHost.computeStatuses` returns `{ groups, statuses, availability: Record<string, Availability> }`; `SyncCenterHost.applyItems(items: ApplyItem[], onProgress?)`. View fields `availability: Map<string, Availability>`, `policy: Map<string, StateAction>`, `sectionOpen: Set<SectionKind>`.

- [ ] **Step 1: Host + main.ts.** `computeStatuses` additionally builds availability (lock read best-effort):

```ts
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        const availability: Record<string, Availability> = {};
        for (const g of groups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        return { groups, statuses, availability };
```

`applyItems` signature becomes `(items: ApplyItem[], onProgress?: ProgressFn)` and passes `items` straight to `applyWithActions(ctx, items, this.installPlugin(), onProgress)`.

- [ ] **Step 2: View bucketing.** Add fields and reload handling:

```ts
  private availability: Map<string, Availability> = new Map();
  private policy: Map<string, StateAction> = new Map();
  private sectionOpen: Set<SectionKind> = new Set();
```

In `reload()`: store `availability` from the host; prune `policy` with the other maps; the firstLoad seed only pre-checks rows whose section is `main`:

```ts
      for (const s of statuses) {
        if ((s.state === "local-changed" || s.state === "store-newer") && this.sectionOf(s.group) === "main") this.selected.add(s.group);
      }
```

Add helpers on the view:

```ts
  private availOf(name: string): Availability {
    return this.availability.get(name) ?? { kind: "enabled", drift: null, localVersion: null, storeVersion: null, anchor: "app" };
  }
  private sectionOf(name: string): SectionKind {
    return sectionForItem(this.availOf(name));
  }
```

- [ ] **Step 3: Main list = main section only.** In `renderItemMode`, split `scoped` first:

```ts
    const scoped = this.scopedRows();
    const mainRows = scoped.filter((r) => this.sectionOf(r.group.name) === "main");
    const sections: Record<Exclude<SectionKind, "main">, StatusRow[]> = { outdated: [], disabled: [], "not-installed": [] };
    for (const r of scoped) {
      const s = this.sectionOf(r.group.name);
      if (s !== "main") sections[s].push(r);
    }
```

Use `mainRows` everywhere `scoped` fed counts/filter pills/list/select-all before. After `renderListInto(listHost, mainRows)` and before `renderActionBar`, render the three sections in order outdated → disabled → not-installed via `renderSection(main, kind, rows)` (skip empty). `scopedRows` for the sidebar badges likewise filters to main-section rows (`bucketCounts` inputs). Header pills (`renderHeader`) filter `this.rows()` to main-section rows too.

- [ ] **Step 4: renderSection.** New method (full code):

```ts
  private renderSection(main: HTMLElement, kind: Exclude<SectionKind, "main">, rows: StatusRow[]): void {
    if (rows.length === 0) return;
    const open = this.sectionOpen.has(kind);
    const fold = main.createDiv({ cls: `config-sync-section is-${kind}${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "config-sync-section-title", text: SECTION_TITLES[kind] });
    const insync = rows.filter((r) => r.status.state === "in-sync");
    const checkable = rows.filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings" && r.status.state !== "locked");
    head.createSpan({ cls: "config-sync-pill is-neutral", text: `${rows.length - insync.length}` });
    if (insync.length > 0) head.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${insync.length}` });
    const staged = checkable.filter((r) => this.selected.has(r.group.name)).length;
    head.createSpan({ cls: "config-sync-section-hint", text: staged === 0 ? "not staged" : `${staged} staged` });
    const box = head.createEl("input", { type: "checkbox", attr: { "aria-label": "Select all in this section" } });
    box.indeterminate = staged > 0 && staged < checkable.length;
    box.checked = checkable.length > 0 && staged === checkable.length;
    box.disabled = checkable.length === 0;
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const turnOn = checkable.some((r) => !this.selected.has(r.group.name));
      for (const r of checkable) {
        const name = r.group.name;
        if (turnOn) {
          this.selected.add(name);
          if (!this.policy.has(name)) this.policy.set(name, defaultPolicy(this.availOf(name)));
        } else {
          this.selected.delete(name);
          this.policy.delete(name);
        }
      }
      this.render(this.renderGen);
    });
    head.addEventListener("click", () => {
      if (open) this.sectionOpen.delete(kind);
      else this.sectionOpen.add(kind);
      this.render(this.renderGen);
    });
    if (!open) return;
    fold.createDiv({ cls: "config-sync-section-note", text: SECTION_NOTES[kind] });
    const card = fold.createDiv({ cls: "config-sync-card" });
    for (const r of rows) this.renderItemRow(card, r);
  }
```

- [ ] **Step 5: Row/detail extensions.** In `renderItemRow`: checking a checkbox on a non-main row seeds its default policy; unchecking clears it:

```ts
      if (cb.checked) {
        this.selected.add(group.name);
        if (this.sectionOf(group.name) !== "main" && !this.policy.has(group.name)) {
          this.policy.set(group.name, defaultPolicy(this.availOf(group.name)));
        }
      } else {
        this.selected.delete(group.name);
        this.policy.delete(group.name);
      }
```

After the mode badge, render the collapsed policy pill:

```ts
    const chosen = this.policy.get(group.name);
    if (this.selected.has(group.name) && chosen !== undefined) {
      const opt = policyOptions(this.availOf(group.name)).find((o) => o.action === chosen);
      if (opt !== undefined && opt.pill !== null) row.createSpan({ cls: "config-sync-pill is-statenote", text: opt.pill });
    }
```

In `renderItemDetail`, before the direction toggle: render the version line (all rows) and the policy segment (non-main rows, apply direction only):

```ts
    const a = this.availOf(r.group.name);
    const line = versionLine(a);
    if (line !== null) detail.createDiv({ cls: `config-sync-version-line${line.tone === "amber" ? " is-amber" : ""}`, text: line.text });
    const section = this.sectionOf(r.group.name);
    if (section === "not-installed") {
      this.renderPolicySeg(detail, r, a); // apply-only: no direction toggle
      this.renderCappedChanges(detail, status.changes);
      return;
    }
    this.renderDirectionToggle(detail, r);
    if (section !== "main" && this.effDir(r) === "apply") this.renderPolicySeg(detail, r, a);
    this.renderCappedChanges(detail, status.changes);
```

(replacing the previous unconditional `renderDirectionToggle` + `renderCappedChanges` tail). Add:

```ts
  private renderPolicySeg(detail: HTMLElement, r: StatusRow, a: Availability): void {
    const options = policyOptions(a);
    if (options.length === 0) return;
    const name = r.group.name;
    detail.createDiv({ cls: "config-sync-seg-label", text: "On apply" });
    const seg = detail.createDiv({ cls: "config-sync-seg" });
    const current = this.policy.get(name) ?? defaultPolicy(a);
    for (const opt of options) {
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-policy${this.selected.has(name) && current === opt.action ? " is-on" : ""}`,
        text: opt.label,
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selected.add(name);
        this.policy.set(name, opt.action);
        this.render(this.renderGen);
      });
    }
  }
```

- [ ] **Step 6: Footer + apply payload.** `applyNames()` becomes `applyItems()` returning `ApplyItem[]`:

```ts
  private applyPayload(): ApplyItem[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.effDir(r) === "apply")
      .map((r) => ({
        name: r.group.name,
        action: this.sectionOf(r.group.name) === "main" ? "none" : (this.policy.get(r.group.name) ?? defaultPolicy(this.availOf(r.group.name))),
      }));
  }
```

In `renderActionBar`: staged-count span uses `footerSummary(mainStaged, outdatedStaged, disabledStaged, installStaged)` where each is a count of selected rows per section (main = section "main"; toInstall = section "not-installed"); the apply button's `names` count comes from `this.applyPayload().length` and its exec closure calls `this.host.applyItems(this.applyPayload(), p)`. Capture path (`captureNames`) is unchanged — disabled/outdated rows staged in the capture direction flow through it naturally.

- [ ] **Step 7: Section CSS** — append to `styles.css`:

```css
.config-sync-section { border: 1px dashed var(--background-modifier-border); border-radius: 8px; padding: 8px 10px; margin-top: 8px; }
.config-sync-section.is-open { border-style: solid; }
.config-sync-section.is-outdated { border-color: rgba(214, 123, 181, 0.45); }
.config-sync-section.is-not-installed { border-color: rgba(232, 176, 75, 0.45); }
.config-sync-section-head { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.config-sync-section.is-outdated .config-sync-section-title { color: #d67bb5; }
.config-sync-section.is-not-installed .config-sync-section-title { color: #e8b04b; }
.config-sync-section-title { font-weight: 600; }
.config-sync-section-hint { margin-left: auto; color: var(--text-faint); font-size: var(--font-ui-smaller); }
.config-sync-section-note { color: var(--text-faint); font-style: italic; font-size: var(--font-ui-smaller); padding: 4px 0 2px 18px; }
.config-sync-version-line { color: var(--text-faint); font-size: var(--font-ui-smaller); padding: 2px 0; }
.config-sync-version-line.is-amber { color: #e8b04b; }
.config-sync-seg-label { color: var(--text-faint); font-size: 10px; margin-top: 4px; }
.config-sync-seg-btn.is-policy.is-on { background: rgba(88, 166, 160, 0.25); color: #a8e0db; }
```

- [ ] **Step 8: Run gate** — green. **Step 9: Commit** — `git commit -m "feat: availability sections with per-item on-apply policies"`

---

### Task 9: Search moves to the sidebar (global scope)

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `styles.css`

**Interfaces:**
- Consumes: view internals from Task 8.
- Produces: search input at the sidebar top (wide mode) / mainbar (compact); active search widens to all scopes, auto-expands sections to matching rows with `{hits} of {total}` pills, and shows hit counts on sidebar badges.

- [ ] **Step 1: Relocate the input.** In `renderSidebar`, before scope entries:

```ts
    const searchEl = side.createEl("input", {
      type: "search",
      cls: "config-sync-side-search",
      attr: { placeholder: "Filter by name…" },
    });
    searchEl.value = this.search;
    if (this.panelScope.kind === "remote") searchEl.disabled = true;
    searchEl.addEventListener("input", () => {
      this.search = searchEl.value;
      this.render(this.renderGen); // full render: badges, sections, list all react
    });
```

Full-render on input loses focus — restore it: after `render()` runs, refocus via `this.contentEl.querySelector<HTMLInputElement>(".config-sync-side-search")?.focus()` with cursor at end (`el.setSelectionRange` is unsupported on `type="search"` in some engines — set `el.value = ""` then back to keep the caret at the end). Wrap that in the input listener after calling render. In compact mode keep the existing mainbar input (unchanged placement/partial-render behavior); in wide mode REMOVE the mainbar input (the `searchEl` block in `renderItemMode` renders only `if (this.compact)`).

- [ ] **Step 2: Global scope while searching.** Add a helper `searching(): boolean { return this.search.trim() !== ""; }`. In `scopedRows()`: when searching, return `this.rows()` (ignore category scope). In `visibleRows` keep the name/id match. Sidebar `deviceEntry` badges: when searching, replace bucket badges with a single hit-count badge:

```ts
      if (this.searching()) {
        const hits = statuses.filter((s) => {
          const g = this.groups.find((x) => x.name === s.group);
          return g !== undefined && matchesSearch(`${this.host.displayName(g.name)} ${g.name}`, this.search);
        }).length;
        item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${hits}` });
      } else { /* existing four badges */ }
```

- [ ] **Step 3: Sections under search.** In `renderSection`: when searching, filter `rows` to matches; skip the section when no match; force-open regardless of `sectionOpen` (do not mutate the set); the neutral count pill shows `` `${matches.length} of ${rows.length}` `` where `rows` is the unfiltered section population. When not searching, behavior from Task 8 unchanged. Pass the unfiltered rows in as a second parameter or compute matches inside — compute inside:

```ts
    const matches = this.searching()
      ? rows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name)} ${r.group.name}`, this.search))
      : rows;
    if (this.searching() && matches.length === 0) return;
    const open = this.searching() || this.sectionOpen.has(kind);
```

…and render `matches` (count pill text: searching ? `${matches.length} of ${rows.length}` : as Task 8).

- [ ] **Step 4: CSS** — append:

```css
.config-sync-side-search { width: 100%; margin-bottom: 6px; }
.config-sync-side-badge.is-neutral { background: var(--background-modifier-hover); color: var(--text-normal); }
```

- [ ] **Step 5: Run gate** — green. **Step 6: Commit** — `git commit -m "feat: sidebar search with global scope and section auto-expand"`

---

### Task 10: README + full gate

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README.** Rewrite the Sync Center section to describe: the four availability layers (main list + `Outdated on this device` / `Disabled on this device` / `Not installed on this device`), checkbox vs On-apply policy semantics with the exact option labels, the install engine (community catalog, latest release, `requestUrl`; not-in-catalog items are staged with a manual-install note), version drift handling (behind → Outdated section with `⤓ Update to latest`; ahead → quiet metadata; Obsidian/core anchored to the app version, reminder-only), inline result strips replacing report modals (Revert keeps its modal), and the removal of the pre-apply version-warnings dialog. Remove any text describing "Continue anyway"/version-warning modals.
- [ ] **Step 2: Full gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 3: Commit** — `git commit -m "docs: README for availability sections, install engine, inline reports"`

---

## Self-Review Notes

- Spec §1.1-§1.4 → Tasks 1-4; §2.1-§2.4 → Tasks 7-8; §2.5 → Task 9; §3.1-§3.3 → Tasks 5-6 (+ deletions in Task 4); README/edge cases → Task 10 and inline steps.
- Spec deviation (deliberate): core-level failure messages use the plugin id, not the display name (core has no label access; consistent with existing core messages). The strip renders them verbatim.
- Type check: `Availability` (T2) consumed by T7/T8; `StateAction`/`ApplyItem` (T4) consumed by T7/T8; `renderReportContent` (T5) consumed by T6; host signature changes land with their consumers (T6, T8).
