# Transport plane & remotes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the store's transport into a first-class two-plane model — local `Capture`/`Apply`/`Revert` plus transport `Pull`/`Push` over git/local-path remotes — and expose it through one consolidated ribbon menu.

**Architecture:** Rename `Publish → Capture`. Add a `pushExternal` core engine (mirror of `importExternal`) driven by a new `ExternalStoreWriter` interface, with desktop-only `local-path` and `git` writers. Wire `Pull` (repeatable, ex-Import) and `Push` commands gated by `checkCallback`. Replace the four always-on ribbon icons with one "Config Sync" ribbon that opens a capability-aware `Menu`; individual icons become opt-in toggles. Add a transport-status line and relabel the "External sources" tab to "Remotes".

**Tech Stack:** TypeScript, Obsidian plugin API, esbuild, vitest. `src/core/*` is platform-neutral (no Node/`obsidian` imports); Node lives only in `src/external/*` behind dynamic `import()` gated by `Platform.isDesktop`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-10-transport-remotes-design.md`. This plan covers #2 + #1 only; #3 (Advanced visual polish) and mobile git Pull are out of scope.
- **Mobile red line:** `src/core/*` must never import Node built-ins or `obsidian`. All `fs`/`child_process` code stays in `src/external/*`, reached only via dynamic `import()` behind `Platform.isDesktop`.
- **Command set (exact ids/labels):** `capture` "Capture (this device's config → store)", `apply` "Apply (store → this device)", `revert-last-apply` "Revert last apply", `pull` "Pull (remote → store)", `push` "Push (store → remote)".
- **Transport availability predicate:** Pull/Push are available iff `Platform.isDesktop && settings.externalSources.length > 0`. When unavailable they are hidden (`checkCallback` returns `false`), never errored — "no remote" is a valid state.
- **Transport semantics:** Pull and Push both overwrite the destination `<root>/` with deletion propagation. No merge. Pull validates upstream `config-sync.json` (existing `importExternal` behavior).
- **Data model:** settings key stays `externalSources`; the `ExternalSource` union is reused unchanged. **Zero migration.** Only UI labels/copy change ("External sources" → "Remotes").
- **Consolidated ribbon icon:** `refresh-cw`, title "Config Sync", always present; opens a `Menu` listing only currently-available actions (3 without a remote, 5 with).
- **Report titles / notices** must use the new verbs ("Capture report", "Pull report", "Push report", "capture failed", "pull failed", "push failed").
- **Verification per task:** `npm test` (vitest) and `npm run build` (`tsc -noEmit` + esbuild) must both pass before commit. Never commit without both green.
- **Do NOT touch** `src/core/catalog.ts` `publish: "publish.json"` / `CORE_NOT_RECOMMENDED = ["sync","publish"]` — those refer to the Obsidian *Publish* core plugin, not our command.

---

### Task 1: Rename Publish → Capture

Pure rename across the core engine, plugin wiring, user-facing copy, and tests. No behavior change.

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (function + 3 message strings)
- Modify: `src/main.ts` (import, ribbon, command, method, report/notice copy)
- Modify: `tests/core.test.ts` (import, describe blocks, calls, 2 message assertions)

**Interfaces:**
- Produces: `capture(ctx: CoreContext): Promise<GroupResult[]>` (was `publish`); plugin method `runCapture()` (was `runPublish`); command id `capture`.

- [ ] **Step 1: Update the failing assertions first (they will now fail)**

In `tests/core.test.ts`:
- Line 2 import: change `publish,` → `capture,`.
- `describe("publish", ...)` → `describe("capture", ...)`; `describe("starter-then-publish ...")` → `describe("starter-then-capture ...")`.
- Every `await publish(ctx)` → `await capture(ctx)` (4 sites: ~L65, L89, L110, L330).
- Assertion `.toContain("nothing to publish yet")` → `.toContain("nothing to capture yet")` (~L93).
- Assertion `.toContain("publish it from the source vault first")` → `.toContain("capture it from the source vault first")` (~L175).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `capture` is not exported from `ConfigSyncCore`, and the two message assertions don't match.

- [ ] **Step 3: Rename in the core engine**

In `src/core/ConfigSyncCore.ts`:
- Line ~83: `export async function publish(` → `export async function capture(`.
- Line ~47 message: `Run Publish or Apply to create a starter` → `Run Capture or Apply to create a starter`.
- Line ~112 message: `nothing to publish yet:` → `nothing to capture yet:`.
- Line ~246 message: `publish it from the source vault first` → `capture it from the source vault first`.

- [ ] **Step 4: Rename in the plugin**

In `src/main.ts`:
- Import list: `publish,` → `capture,`.
- Ribbon (line ~53): `this.addRibbonIcon("upload", "Config Sync: Publish", () => { void this.runPublish(); });` → title `"Config Sync: Capture"`, call `void this.runCapture();`. (This ribbon is reworked in Task 5; rename it now for consistency.)
- Command (line ~67): `this.addCommand({ id: "publish", name: "Publish (vault config → store)", callback: () => void this.runPublish() });` → `id: "capture"`, `name: "Capture (this device's config → store)"`, `callback: () => void this.runCapture()`.
- Method `runPublish` → `runCapture`; inside it `await publish(ctx)` → `await capture(ctx)`; `"Config Sync: Publish report"` → `"Config Sync: Capture report"`; ``Config Sync publish failed: ...`` → ``Config Sync capture failed: ...``.

- [ ] **Step 5: Run tests and build to verify they pass**

Run: `npm test && npm run build`
Expected: PASS — all core tests green, build clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/ConfigSyncCore.ts src/main.ts tests/core.test.ts
git commit -m "refactor: rename Publish to Capture"
```

---

### Task 2: `pushExternal` engine + `ExternalStoreWriter` interface

The transport-outbound engine: read the local store, write it to a remote via a writer, propagate deletions, finalize once. Mirror of `importExternal`. Pure core, unit-tested with a fake writer.

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (add interface + function, after the `importExternal` block ~L345)
- Modify: `tests/core.test.ts` (add a `fakeWriter` helper + a `describe("pushExternal")` block)

**Interfaces:**
- Consumes: `CoreContext`, `GroupResult`, `emptyResult`, `listFilesRecursive` (all already in `ConfigSyncCore.ts`/`io.ts`).
- Produces:
  ```ts
  export interface ExternalStoreWriter {
    listFiles(): Promise<string[]>;                        // existing remote files, relative to <root>/, "/"-separated
    writeFile(relPath: string, content: string): Promise<void>;
    deleteFile(relPath: string): Promise<void>;
    finalize(): Promise<void>;                             // git: add/commit/push; local-path: no-op
  }
  export async function pushExternal(ctx: CoreContext, writer: ExternalStoreWriter): Promise<GroupResult>
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/core.test.ts` (import `pushExternal, ExternalStoreWriter` on line 2 alongside the existing imports):

```ts
function fakeWriter(initial: Record<string, string>): {
  writer: ExternalStoreWriter;
  files: Record<string, string>;
  finalized: number;
} {
  const files: Record<string, string> = { ...initial };
  const state = { finalized: 0 };
  const writer: ExternalStoreWriter = {
    async listFiles() {
      return Object.keys(files).sort();
    },
    async writeFile(rel, content) {
      files[rel] = content;
    },
    async deleteFile(rel) {
      delete files[rel];
    },
    async finalize() {
      state.finalized += 1;
    },
  };
  return {
    writer,
    files,
    get finalized() {
      return state.finalized;
    },
  } as { writer: ExternalStoreWriter; files: Record<string, string>; finalized: number };
}

describe("pushExternal", () => {
  it("writes the whole local store to the remote with deletion propagation and finalizes once", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/config-sync.json": '{"version":1,"groups":[]}',
      "cs/store.lock.json": '{"publishedAt":"t","groups":{}}',
      "cs/store/configdir/hotkeys.json": '{"a":9}',
    });
    const fw = fakeWriter({ "config-sync.json": "OLD", "store/gone.css": "stale" });
    const result = await pushExternal(ctx, fw.writer);
    expect(result.status).toBe("ok");
    expect(fw.files["config-sync.json"]).toBe('{"version":1,"groups":[]}');
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"a":9}');
    expect(fw.files["store/gone.css"]).toBeUndefined();
    expect(result.filesDeleted).toEqual(["store/gone.css"]);
    expect(fw.finalized).toBe(1);
  });

  it("refuses to push when the local store has no config-sync.json", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/store/configdir/hotkeys.json": "{}" });
    const fw = fakeWriter({});
    await expect(pushExternal(ctx, fw.writer)).rejects.toThrow("no config-sync.json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `pushExternal` / `ExternalStoreWriter` are not exported.

- [ ] **Step 3: Implement the interface and engine**

In `src/core/ConfigSyncCore.ts`, immediately after the `importExternal` function (~L345), add:

```ts
export interface ExternalStoreWriter {
  listFiles(): Promise<string[]>; // existing remote files, relative to <root>/, "/"-separated
  writeFile(relPath: string, content: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  finalize(): Promise<void>; // git: add/commit/push; local-path: no-op
}

export async function pushExternal(ctx: CoreContext, writer: ExternalStoreWriter): Promise<GroupResult> {
  const localAbs = await listFilesRecursive(ctx.io, ctx.rootPath);
  const rels = localAbs.map((f) => f.slice(ctx.rootPath.length + 1)).sort();
  if (!rels.includes("config-sync.json")) {
    throw new Error(
      `Local store has no config-sync.json at ${ctx.rootPath} — capture from this device (or pull) before pushing.`
    );
  }
  const result = emptyResult("push", false);
  for (const rel of rels) {
    await writer.writeFile(rel, await ctx.io.read(`${ctx.rootPath}/${rel}`));
    result.filesWritten.push(rel);
  }
  const wanted = new Set(rels);
  for (const rel of await writer.listFiles()) {
    if (!wanted.has(rel)) {
      await writer.deleteFile(rel);
      result.filesDeleted.push(rel);
    }
  }
  await writer.finalize();
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: add pushExternal engine and ExternalStoreWriter interface"
```

---

### Task 3: local-path and git store writers

Desktop-only implementations of `ExternalStoreWriter`. Integration-tested against real temp dirs and a real bare git remote, mirroring the existing reader tests.

**Files:**
- Modify: `src/external/localPath.ts` (add `createLocalPathWriter`)
- Modify: `src/external/gitSource.ts` (add `createGitWriter` + a node-fs walk helper + fs/os imports)
- Modify: `tests/external.test.ts` (add writer describe blocks + a bare-remote fixture)

**Interfaces:**
- Consumes: `ExternalStoreWriter` from `../core/ConfigSyncCore`; `git()` helper already in `gitSource.ts`; `walk()` already in `localPath.ts`.
- Produces:
  ```ts
  export function createLocalPathWriter(destVaultPath: string, destRoot: string): ExternalStoreWriter
  export async function createGitWriter(remoteUrl: string, branch: string, root: string): Promise<ExternalStoreWriter>
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/external.test.ts`. First extend imports at the top:

```ts
import { createLocalPathReader, createLocalPathWriter } from "../src/external/localPath";
import { createGitReader, createGitWriter } from "../src/external/gitSource";
```

Add a bare-remote fixture and two describe blocks (the file already has `sourceRepo`/`consumerRepo` in `beforeAll`; add `bareRemote` there and seed it):

```ts
let bareRemote: string;

// --- inside the existing beforeAll, after consumerRepo is created: ---
bareRemote = await mkdtemp(nodePath.join(tmpdir(), "cs-bare-"));
await run("git", ["init", "--bare", "-b", "main", bareRemote]);
const seed = await mkdtemp(nodePath.join(tmpdir(), "cs-seed-"));
await run("git", ["clone", bareRemote, seed]);
await mkdir(nodePath.join(seed, "cfg"), { recursive: true });
await writeFile(nodePath.join(seed, "cfg/config-sync.json"), '{"version":1,"groups":[]}');
await run("git", ["-C", seed, "add", "."]);
await run("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
await run("git", ["-C", seed, "push", "origin", "main"]);
await rm(seed, { recursive: true, force: true });

// --- add bareRemote to the existing afterAll cleanup: ---
// await rm(bareRemote, { recursive: true, force: true });
```

```ts
describe("createLocalPathWriter", () => {
  it("writes files under the dest root and propagates deletions, round-tripping via the reader", async () => {
    const dest = await mkdtemp(nodePath.join(tmpdir(), "cs-dest-"));
    const writer = createLocalPathWriter(dest, "0-Extra/config-sync");
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":7}');
    await writer.finalize();
    const reader = createLocalPathReader(dest, "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["config-sync.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":7}');
    await writer.deleteFile("store/configdir/hotkeys.json");
    expect((await createLocalPathReader(dest, "0-Extra/config-sync").listFiles())).toEqual(["config-sync.json"]);
    await rm(dest, { recursive: true, force: true });
  });
});

describe("createGitWriter", () => {
  it("commits and pushes the store to the remote branch, visible to a fresh reader", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg");
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    await writer.writeFile("store/configdir/hotkeys.json", '{"a":42}');
    await writer.finalize();
    const reader = await createGitReader(consumerRepo, bareRemote, "main", "cfg");
    expect(await reader.listFiles()).toContain("store/configdir/hotkeys.json");
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe('{"a":42}');
  });

  it("propagates deletions on the remote", async () => {
    const writer = await createGitWriter(bareRemote, "main", "cfg");
    // only config-sync.json this time — the previously pushed hotkeys.json must disappear
    await writer.writeFile("config-sync.json", '{"version":1,"groups":[]}');
    for (const rel of await writer.listFiles()) {
      if (rel !== "config-sync.json") await writer.deleteFile(rel);
    }
    await writer.finalize();
    const reader = await createGitReader(consumerRepo, bareRemote, "main", "cfg");
    expect(await reader.listFiles()).toEqual(["config-sync.json"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createLocalPathWriter` / `createGitWriter` are not exported.

- [ ] **Step 3: Implement `createLocalPathWriter`**

In `src/external/localPath.ts`, add the import and the function (reuse the existing private `walk`):

```ts
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";
```

```ts
export function createLocalPathWriter(destVaultPath: string, destRoot: string): ExternalStoreWriter {
  const base = nodePath.join(destVaultPath, destRoot);
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await fs.access(base);
        await walk(base, "", out);
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

(The existing `createLocalPathReader` import line becomes the combined import above — do not leave a duplicate `import { ExternalStoreReader } ...`.)

- [ ] **Step 4: Implement `createGitWriter`**

In `src/external/gitSource.ts`, extend imports and add the writer + a node-fs walk helper:

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, mkdir, writeFile, unlink, access, readdir } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";
```

```ts
async function walkFs(absBase: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(nodePath.join(absBase, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walkFs(absBase, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }
}

export async function createGitWriter(
  remoteUrl: string,
  branch: string,
  root: string
): Promise<ExternalStoreWriter> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "cs-push-"));
  await git(dir, ["clone", "--branch", branch, remoteUrl, "."]);
  const base = nodePath.join(dir, root);
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await access(base);
        await walkFs(base, "", out);
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
      const stamp = new Date().toISOString();
      await git(dir, ["-c", "user.email=config-sync@local", "-c", "user.name=config-sync", "commit", "-m", `config-sync push: ${stamp}`]);
      await git(dir, ["push", "origin", branch]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
```

Note: the git writer clones into its own temp dir and pushes to `origin` (the cloned remote) — it never touches the user's vault git repo. `new Date()` here is fine: this file is desktop-only and outside `src/core`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && npm run build`
Expected: PASS — writer round-trips through the readers; build clean.

- [ ] **Step 6: Commit**

```bash
git add src/external/localPath.ts src/external/gitSource.ts tests/external.test.ts
git commit -m "feat: add local-path and git store writers"
```

---

### Task 4: Pull/Push commands, gating, and writer factory

Rename Import→Pull (repeatable), add Push, gate both with `checkCallback`, and add the desktop-only writer factory. Ribbon is untouched here (reworked in Task 5).

**Files:**
- Modify: `src/main.ts` (imports, command registration, `runPull`/`pullFrom` rename, `runPush`/`pushTo`, `createWriter`, `transportAvailable`)

**Interfaces:**
- Consumes: `pushExternal`, `ExternalStoreWriter`, `importExternal` (already imported), `createLocalPathWriter`, `createGitWriter`, `SourceSelectModal`, `ReportModal`.
- Produces: plugin methods `runPull()`, `runPush()`, `transportAvailable(): boolean`, `createWriter(source): Promise<ExternalStoreWriter>`.

- [ ] **Step 1: Add the `transportAvailable` predicate and update imports**

In `src/main.ts`:
- Add to the core import block: `pushExternal,` and `ExternalStoreWriter,` (alongside the existing `importExternal, ExternalStoreReader,`).
- Add a method near `coreContext` (must be **public** — the settings host calls it in Task 5):

```ts
transportAvailable(): boolean {
  return Platform.isDesktop && this.settings.externalSources.length > 0;
}
```

- [ ] **Step 2: Rename Import→Pull and register Push**

Replace the `import-from-external` command (lines ~70-78) with both transport commands:

```ts
this.addCommand({
  id: "pull",
  name: "Pull (remote → store)",
  checkCallback: (checking) => {
    if (!this.transportAvailable()) return false;
    if (!checking) void this.runPull();
    return true;
  },
});
this.addCommand({
  id: "push",
  name: "Push (store → remote)",
  checkCallback: (checking) => {
    if (!this.transportAvailable()) return false;
    if (!checking) void this.runPush();
    return true;
  },
});
```

- [ ] **Step 3: Rename the Import methods to Pull and add Push methods**

- Rename `runImport` → `runPull`; change the notice to ``Config Sync: no remotes configured (Settings → Config Sync → Remotes)``; keep the `SourceSelectModal` flow but call `void this.pullFrom(source);`.
- Rename `importFrom` → `pullFrom`; change the report title to `` `Config Sync: Pull report (${source.name})` `` and the notice to ``Config Sync pull failed: ...``. Body still calls `await importExternal(ctx, reader)`.
- Add Push methods after `pullFrom`:

```ts
private async runPush(): Promise<void> {
  const sources = this.settings.externalSources;
  if (sources.length === 0) {
    new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
    return;
  }
  new SourceSelectModal(this.app, sources, (source) => {
    void this.pushTo(source);
  }).open();
}

private async pushTo(source: ExternalSource): Promise<void> {
  try {
    const ctx = await this.coreContext();
    const writer = await this.createWriter(source);
    const result = await pushExternal(ctx, writer);
    new ReportModal(this.app, `Config Sync: Push report (${source.name})`, [result]).open();
  } catch (e) {
    new Notice(`Config Sync push failed: ${(e as Error).message}`, 10000);
  }
}
```

- [ ] **Step 4: Add the writer factory (mirror of `createReader`)**

Add after `createReader` (~L224):

```ts
private async createWriter(source: ExternalSource): Promise<ExternalStoreWriter> {
  if (source.type === "local-path") {
    const { createLocalPathWriter } = await import("./external/localPath");
    return createLocalPathWriter(source.path, source.root);
  }
  const { createGitWriter } = await import("./external/gitSource");
  return createGitWriter(source.remote, source.branch, source.root);
}
```

- [ ] **Step 5: Build to verify types and dynamic-import boundaries**

Run: `npm run build && npm test`
Expected: PASS — `tsc` clean (dynamic imports keep Node out of the load path), all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat: add Pull/Push commands with transport gating and writer factory"
```

---

### Task 5: Consolidated ribbon menu + per-command ribbon toggles

Replace the four always-on ribbon icons with one "Config Sync" ribbon that opens a capability-aware `Menu`. Individual icons become opt-in via a new `ribbonButtons` setting, toggled in the General tab, re-registered live.

**Files:**
- Modify: `src/core/types.ts` (add `RibbonKey` / `RibbonButtons` types)
- Modify: `src/main.ts` (import `Menu`; settings type + default; ribbon rework; `openSyncMenu`; `refreshRibbons`; expose `refreshRibbons`/`transportAvailable` to the settings host)
- Modify: `src/ui/SettingTab.ts` (extend `SettingsHost`; add `renderRibbonToggles` in the General tab)

**Interfaces:**
- Consumes: `Platform`, `Menu` (obsidian); `transportAvailable()` (Task 4).
- Produces:
  ```ts
  // types.ts
  export type RibbonKey = "capture" | "apply" | "revert" | "pull" | "push";
  export type RibbonButtons = Record<RibbonKey, boolean>;
  // plugin
  refreshRibbons(): void
  ```

- [ ] **Step 1: Add the ribbon setting types**

In `src/core/types.ts`, append:

```ts
export type RibbonKey = "capture" | "apply" | "revert" | "pull" | "push";
export type RibbonButtons = Record<RibbonKey, boolean>;
```

- [ ] **Step 2: Extend settings type + default**

In `src/main.ts`:
- Import `RibbonButtons` from `./core/types` (alongside `ExternalSource, SyncGroup`), and add `Menu` to the `obsidian` import (`import { Menu, Notice, Platform, Plugin } from "obsidian";`).
- Add `ribbonButtons: RibbonButtons;` to the `ConfigSyncSettings` interface.
- Update `DEFAULT_SETTINGS`:

```ts
const DEFAULT_SETTINGS: ConfigSyncSettings = {
  pkmMode: "auto",
  rootPath: "",
  externalSources: [],
  ribbonButtons: { capture: false, apply: false, revert: false, pull: false, push: false },
};
```

(`loadSettings` already does `Object.assign({}, DEFAULT_SETTINGS, loaded)`, so existing users pick up the default `ribbonButtons` — no migration.)

- [ ] **Step 3: Rework the ribbon in `onload`**

Replace the entire ribbon block (the four `addRibbonIcon` calls, current lines ~53-66) with:

```ts
this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => this.openSyncMenu(evt));
this.refreshRibbons();
```

Add the field near the other private fields at the top of the class:

```ts
private individualRibbons: HTMLElement[] = [];
```

- [ ] **Step 4: Add `openSyncMenu` and `refreshRibbons`**

Add these methods to the plugin:

```ts
private openSyncMenu(evt: MouseEvent): void {
  const menu = new Menu();
  menu.addItem((i) => i.setTitle("Capture (config → store)").setIcon("upload").onClick(() => void this.runCapture()));
  menu.addItem((i) => i.setTitle("Apply (store → this device)").setIcon("folder-sync").onClick(() => void this.runApply()));
  menu.addItem((i) => i.setTitle("Revert last apply").setIcon("undo-2").onClick(() => void this.runRevert()));
  if (this.transportAvailable()) {
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Pull (remote → store)").setIcon("folder-input").onClick(() => void this.runPull()));
    menu.addItem((i) => i.setTitle("Push (store → remote)").setIcon("upload-cloud").onClick(() => void this.runPush()));
  }
  menu.showAtMouseEvent(evt);
}

refreshRibbons(): void {
  for (const el of this.individualRibbons) el.remove();
  this.individualRibbons = [];
  const rb = this.settings.ribbonButtons;
  const add = (icon: string, title: string, run: () => void): void => {
    this.individualRibbons.push(this.addRibbonIcon(icon, title, () => run()));
  };
  if (rb.capture) add("upload", "Config Sync: Capture", () => void this.runCapture());
  if (rb.apply) add("folder-sync", "Config Sync: Apply", () => void this.runApply());
  if (rb.revert) add("undo-2", "Config Sync: Revert last apply", () => void this.runRevert());
  if (rb.pull && this.transportAvailable()) add("folder-input", "Config Sync: Pull", () => void this.runPull());
  if (rb.push && this.transportAvailable()) add("upload-cloud", "Config Sync: Push", () => void this.runPush());
}
```

- [ ] **Step 5: Extend the settings host and add the toggle UI**

In `src/ui/SettingTab.ts`:
- Import `RibbonKey` from `../core/types`.
- Extend `SettingsHost` additively (leave all existing members in place): in the `settings` member type add `; ribbonButtons: Record<RibbonKey, boolean>` after `externalSources: ExternalSource[]`, and add two method members to the interface:

```ts
  refreshRibbons(): void;
  transportAvailable(): boolean;
```

So the top of the interface becomes:

```ts
export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[]; ribbonButtons: Record<RibbonKey, boolean> };
  saveSettings(): Promise<void>;
  refreshRibbons(): void;
  transportAvailable(): boolean;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>;
  installedPluginIds(): string[];
}
```

- In `renderActiveTab`, the `"general"` case, add a third call:

```ts
case "general":
  this.renderPkmMode(containerEl);
  await this.renderDataFolder(containerEl, gen);
  this.renderRibbonToggles(containerEl);
  break;
```

- Add the method:

```ts
private renderRibbonToggles(containerEl: HTMLElement): void {
  new Setting(containerEl)
    .setName("Ribbon buttons")
    .setDesc("The Config Sync ribbon icon always opens a menu of available actions. Optionally also show individual ribbon icons.")
    .setHeading();
  const defs: { key: RibbonKey; label: string; transport: boolean }[] = [
    { key: "capture", label: "Capture", transport: false },
    { key: "apply", label: "Apply", transport: false },
    { key: "revert", label: "Revert last apply", transport: false },
    { key: "pull", label: "Pull", transport: true },
    { key: "push", label: "Push", transport: true },
  ];
  for (const d of defs) {
    const s = new Setting(containerEl).setName(d.label);
    if (d.transport && !this.host.transportAvailable()) {
      s.setDesc("Shown on desktop once a remote is configured.");
    }
    s.addToggle((t) =>
      t.setValue(this.host.settings.ribbonButtons[d.key]).onChange(async (v) => {
        this.host.settings.ribbonButtons[d.key] = v;
        await this.host.saveSettings();
        this.host.refreshRibbons();
      })
    );
  }
}
```

- [ ] **Step 6: Build and smoke the ribbon**

Run: `npm run build && npm test`
Expected: PASS — `tsc` clean, tests green.

Manual smoke (desktop dev vault, `npm run smoke:install` then reload):
- Exactly one "Config Sync" (`refresh-cw`) ribbon icon by default; clicking it opens a menu with **3** items (Capture/Apply/Revert) when no remote is configured, **5** when a remote exists.
- Toggling any ribbon button in General adds/removes its individual icon immediately (no reload).

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/main.ts src/ui/SettingTab.ts
git commit -m "feat: consolidated ribbon menu with opt-in per-command icons"
```

---

### Task 6: "Remotes" relabel + transport-status line

Relabel the External-sources tab to "Remotes" and add a General-tab line telling the user how their store currently travels.

**Files:**
- Modify: `src/ui/SettingTab.ts` (TABS label, `renderSources` copy, add `renderTransportStatus`)

**Interfaces:**
- Consumes: `this.host.settings.externalSources`.
- Produces: General-tab status line; "Remotes" tab label.

- [ ] **Step 1: Relabel the tab**

In `src/ui/SettingTab.ts`, `TABS` array: change `{ id: "sources", label: "External sources" }` → `{ id: "sources", label: "Remotes" }`. (Keep the `sources` id.)

- [ ] **Step 2: Reframe the Remotes tab copy**

In `renderSources` (~L577), update the heading/description Setting so it reads as remotes you Pull from and Push to, e.g. name `"Remotes"` and description `"Places you Pull the store from and Push it to — another vault (local path) or a git repo. note-sync handles your own devices without a remote."`. Update the empty-list and any "external source" wording in this method to "remote".

- [ ] **Step 3: Add the transport-status line to General**

Add the method and call it first in the `"general"` case of `renderActiveTab`:

```ts
case "general":
  this.renderTransportStatus(containerEl);
  this.renderPkmMode(containerEl);
  await this.renderDataFolder(containerEl, gen);
  this.renderRibbonToggles(containerEl);
  break;
```

```ts
private renderTransportStatus(containerEl: HTMLElement): void {
  const remotes = this.host.settings.externalSources;
  const s = new Setting(containerEl).setName("Store transport");
  if (remotes.length === 0) {
    s.setDesc(
      "Store syncs via your note-sync tool (remotely-save / Obsidian Sync / …). Add a remote under Remotes for git or cross-vault sync."
    );
  } else {
    const list = remotes.map((r) => `${r.name} (${r.type})`).join(", ");
    s.setDesc(`Remotes: ${list}. Use Pull / Push to sync the store.`);
  }
}
```

- [ ] **Step 4: Build and smoke**

Run: `npm run build && npm test`
Expected: PASS.

Manual smoke: the settings tab shows a "Remotes" tab (not "External sources"); the General tab shows a "Store transport" line reading the note-sync message with no remote, and listing remotes by name+type once one is added.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: Remotes relabel and transport-status line"
```

---

## Notes for the executor

- Tasks are ordered by dependency: 1 (rename) → 2 (engine) → 3 (writers, implement the Task-2 interface) → 4 (commands, use Tasks 2+3) → 5 (ribbon, uses Task-4 methods) → 6 (labels/status).
- `src/core/*` must stay Node-free. Writers live in `src/external/*` and are reached only through the dynamic-`import()` factory in `main.ts` behind `Platform.isDesktop` (the `transportAvailable()` gate). Never add a static `import` of `./external/*` to `main.ts` or any `src/core` file.
- The bare-remote git test (Task 3) needs a full (non-shallow) clone so the push is accepted; do not add `--depth`.
- Do not stage `docs/`, `.superpowers/`, or `dev/` into task commits — only the source/test files each task lists.
