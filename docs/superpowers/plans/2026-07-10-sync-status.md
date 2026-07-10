# Sync Status Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-group drift detection (in-sync / changed-here / store-newer, with mtime-based direction hints), on-demand remote freshness checks, status surfaced in a Status modal + sync-menu badges + the Apply picker (all behind default-on toggles), plus the `.DS_Store` capture fix and a report/picker copy pass.

**Architecture:** A new core module `src/core/status.ts` computes `GroupStatus` by comparing live config against the store (same path derivation capture uses; sanitize-aware; shared junk filter) and `checkRemote` by reading only the remote's `store.lock.json`. `FileIO` gains `stat()` (structurally satisfied by Obsidian's `DataAdapter.stat`). UI: new `StatusModal`, badge-aware `GroupSelectModal`, badge titles in `openSyncMenu`, two settings toggles.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/core/*` has zero Node-builtin/`obsidian` imports.
- Junk list exactly: `.DS_Store`, `Thumbs.db`, `desktop.ini`.
- Direction is a labeled guess — user-facing copy says "(likely)".
- The sync menu must NEVER fail to open: badge computation failures fall back to plain titles (`console.error` the cause).
- Status modal listing never aborts on one group's error — that group degrades to `differs` with the error message.
- Both feature toggles default `true` (`Object.assign` merge; no migration).
- Copy strings verbatim where specified. Commit messages: no Claude attribution / no Claude-Session trailer.
- `noUncheckedIndexedAccess` is on — guard array indexing.

---

### Task 1: Core — `stat()` on FileIO, junk filter, `statusForGroups`, `checkRemote`

**Files:**
- Modify: `src/core/io.ts` (FileIO.stat, FileStat, JUNK_FILES, isJunkPath)
- Modify: `src/core/ConfigSyncCore.ts` (`captureGroup` junk skip; `export` parseJsonOrThrow)
- Create: `src/core/status.ts`
- Modify: `tests/memfs.ts` (stat + touch)
- Create: `tests/status.test.ts`
- Test also: `tests/core.test.ts` (junk capture test)

**Interfaces:**
- Consumes: `groupRealPath`/`groupStorePath`/`relativeTo` (pathing), `storeDir`/`loadLock`/`ExternalStoreReader` (ConfigSyncCore, all already exported), `sanitizeJson` (sanitize), `parseStoreLock` (manifest), `StoreLock`/`SyncGroup` (types).
- Produces (Tasks 2–3 rely on):
  - `FileIO.stat(path: string): Promise<FileStat | null>` with `interface FileStat { mtime: number }` (epoch ms) — structurally satisfied by Obsidian's `DataAdapter.stat` (its `Stat` has `mtime: number`), so `ctx.io = app.vault.adapter` keeps working unchanged.
  - `JUNK_FILES: Set<string>`, `isJunkPath(path: string): boolean` (basename test) in `src/core/io.ts`.
  - In `src/core/status.ts`:
    ```ts
    export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured";
    export interface GroupStatus { group: string; state: GroupState; message?: string; }
    export async function statusForGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<GroupStatus[]>;
    export type RemoteState = "no-store" | "same" | "remote-newer" | "remote-older" | "unknown";
    export interface RemoteCheck { state: RemoteState; remoteCapturedAt: string | null; }
    export async function checkRemote(localLock: StoreLock | null, reader: ExternalStoreReader): Promise<RemoteCheck>;
    ```

- [ ] **Step 1: Write the failing tests**

Create `tests/status.test.ts` (harness mirrors `tests/core.test.ts`: `setup()` returns `{ io, plugins, ctx }` with `configDir: ".obs"`, `rootPath: "cs"`, `now: () => "2026-07-08T00:00:00.000Z"`; import `setup`, `MANIFEST` from `./core.test` or re-declare a minimal local manifest — declare locally to avoid cross-file coupling):

```ts
import { describe, expect, it } from "vitest";
import { CoreContext, capture, loadManifest, groupsForDevice, ExternalStoreReader } from "../src/core/ConfigSyncCore";
import { statusForGroups, checkRemote } from "../src/core/status";
import { MemFS, FakePlugins } from "./memfs";

const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", sanitize: ["*Token*"] },
  ],
});

function setup(): { io: MemFS; ctx: CoreContext } {
  const io = new MemFS();
  const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins: new FakePlugins(), now: () => "2026-07-08T00:00:00.000Z" };
  return { io, ctx };
}

async function seededAndCaptured(): Promise<{ io: MemFS; ctx: CoreContext }> {
  const { io, ctx } = setup();
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
  });
  await capture(ctx); // capturedAt = 2026-07-08T00:00:00.000Z
  return { io, ctx };
}

async function allStates(ctx: CoreContext): Promise<Record<string, string>> {
  const manifest = await loadManifest(ctx);
  const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
  return Object.fromEntries(statuses.map((s) => [s.group, s.state]));
}

describe("statusForGroups", () => {
  it("reports in-sync right after capture, including sanitize groups compared sanitized", async () => {
    const { ctx } = await seededAndCaptured();
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "in-sync", snippets: "in-sync", "plugin-demo": "in-sync" });
  });

  it("reports local-changed when a live file is newer than capturedAt", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/hotkeys.json", '{"a":2}');
    io.touch(".obs/hotkeys.json", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["hotkeys"]).toBe("local-changed");
  });

  it("reports store-newer when content differs but live mtimes predate capturedAt", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write("cs/store/configdir/hotkeys.json", '{"a":9}'); // simulate a fresher pulled store
    io.touch(".obs/hotkeys.json", Date.parse("2026-07-07T00:00:00.000Z"));
    expect((await allStates(ctx))["hotkeys"]).toBe("store-newer");
  });

  it("reports differs (no direction) when there is no lock", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.remove("cs/store.lock.json");
    await io.write(".obs/hotkeys.json", '{"a":3}');
    expect((await allStates(ctx))["hotkeys"]).toBe("differs");
  });

  it("reports not-captured when the store has no data for the group", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/config-sync.json": MANIFEST, ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x", ".obs/plugins/demo/data.json": "{}" });
    expect((await allStates(ctx))["hotkeys"]).toBe("not-captured");
  });

  it("detects dir set differences and ignores junk on both sides", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.seed({ ".obs/snippets/.DS_Store": "junk", "cs/store/configdir/snippets/.DS_Store": "junk" });
    expect((await allStates(ctx))["snippets"]).toBe("in-sync"); // junk alone never differs
    io.seed({ ".obs/snippets/two.css": "two" });
    io.touch(".obs/snippets/two.css", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["snippets"]).toBe("local-changed");
  });

  it("sanitize groups stay in-sync when only sanitized keys differ from raw", async () => {
    const { io, ctx } = await seededAndCaptured();
    await io.write(".obs/plugins/demo/data.json", '{"vikaToken":"ROTATED","theme":"x"}'); // token differs, sanitized view identical
    io.touch(".obs/plugins/demo/data.json", Date.parse("2026-07-09T00:00:00.000Z"));
    expect((await allStates(ctx))["plugin-demo"]).toBe("in-sync");
  });
});

function fakeReader(files: Record<string, string>): ExternalStoreReader {
  return {
    async listFiles(): Promise<string[]> {
      return Object.keys(files).sort();
    },
    async readFile(rel: string): Promise<string> {
      const c = files[rel];
      if (c === undefined) throw new Error(`no ${rel}`);
      return c;
    },
  };
}

describe("checkRemote", () => {
  const localLock = { capturedAt: "2026-07-08T00:00:00.000Z", groups: {} };
  it("classifies all five states", async () => {
    expect((await checkRemote(localLock, fakeReader({}))).state).toBe("no-store");
    expect((await checkRemote(localLock, fakeReader({ "config-sync.json": "{}" }))).state).toBe("unknown");
    const at = (t: string): Record<string, string> => ({ "config-sync.json": "{}", "store.lock.json": JSON.stringify({ capturedAt: t, groups: {} }) });
    expect((await checkRemote(localLock, fakeReader(at("2026-07-09T00:00:00.000Z")))).state).toBe("remote-newer");
    expect((await checkRemote(localLock, fakeReader(at("2026-07-07T00:00:00.000Z")))).state).toBe("remote-older");
    expect((await checkRemote(localLock, fakeReader(at("2026-07-08T00:00:00.000Z")))).state).toBe("same");
    expect((await checkRemote(null, fakeReader(at("2026-07-09T00:00:00.000Z")))).state).toBe("unknown");
  });
});
```

Add to `tests/core.test.ts` in `describe("capture", …)`:

```ts
it("skips OS junk when capturing dirs and cleans junk already in the store", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": "{}",
    ".obs/snippets/one.css": "one",
    ".obs/snippets/.DS_Store": "junk",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
    "cs/store/configdir/snippets/.DS_Store": "old junk",
  });
  await capture(ctx);
  expect(await io.exists("cs/store/configdir/snippets/.DS_Store")).toBe(false);
  expect(await io.read("cs/store/configdir/snippets/one.css")).toBe("one");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/status.test.ts tests/core.test.ts`
Expected: FAIL — `src/core/status.ts` does not exist; `io.touch`/`io.stat` missing; junk test fails (`.DS_Store` written to store).

- [ ] **Step 3: Implement io + MemFS**

`src/core/io.ts` — add:

```ts
export interface FileStat {
  mtime: number; // epoch ms
}
```

and to `FileIO`:

```ts
  stat(path: string): Promise<FileStat | null>;
```

and at the bottom:

```ts
export const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function isJunkPath(path: string): boolean {
  return JUNK_FILES.has(path.slice(path.lastIndexOf("/") + 1));
}
```

`tests/memfs.ts` — add to `MemFS`:

```ts
  mtimes = new Map<string, number>();

  /** Test control: set a file's mtime (epoch ms). Seeded files default to 1000. */
  touch(path: string, mtime: number): void {
    this.mtimes.set(path, mtime);
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    if (!this.files.has(path)) return null;
    return { mtime: this.mtimes.get(path) ?? 1000 };
  }
```

- [ ] **Step 4: Capture junk skip + export parseJsonOrThrow**

`src/core/ConfigSyncCore.ts`:
- `function parseJsonOrThrow` → `export function parseJsonOrThrow` (status.ts reuses it).
- In `captureGroup`, the dir branch's source list gains the filter (import `isJunkPath` from `./io`):

```ts
const sourceRels = sourceFiles.map((f) => relativeTo(real, f)).filter((rel) => !isJunkPath(rel));
```

(Deletion propagation already removes store files not in the wanted set — previously captured junk is cleaned automatically.)

- [ ] **Step 5: Implement `src/core/status.ts`**

```ts
import { CoreContext, ExternalStoreReader, loadLock, parseJsonOrThrow, storeDir } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { sanitizeJson } from "./sanitize";
import { StoreLock, SyncGroup } from "./types";
import { parseStoreLock } from "./manifest";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
}

type Comparison = "equal" | "not-captured" | { liveFiles: string[] };

export async function statusForGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<GroupStatus[]> {
  // The lock is optional context for direction hints; never let it block status.
  let capturedAtMs: number | null = null;
  try {
    const lock = await loadLock(ctx);
    if (lock !== null) {
      const ms = Date.parse(lock.capturedAt);
      capturedAtMs = Number.isNaN(ms) ? null : ms;
    }
  } catch {
    capturedAtMs = null;
  }
  const out: GroupStatus[] = [];
  for (const group of groups) {
    try {
      out.push(await groupStatus(ctx, group, capturedAtMs));
    } catch (e) {
      out.push({ group: group.name, state: "differs", message: (e as Error).message });
    }
  }
  return out;
}

async function groupStatus(ctx: CoreContext, group: SyncGroup, capturedAtMs: number | null): Promise<GroupStatus> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const cmp = group.type === "file" ? await compareFile(ctx, group, real, store) : await compareDir(ctx, real, store);
  if (cmp === "not-captured") return { group: group.name, state: "not-captured" };
  if (cmp === "equal") return { group: group.name, state: "in-sync" };
  let maxMtime: number | null = null;
  for (const f of cmp.liveFiles) {
    const s = await ctx.io.stat(f);
    if (s !== null && (maxMtime === null || s.mtime > maxMtime)) maxMtime = s.mtime;
  }
  if (maxMtime === null || capturedAtMs === null) return { group: group.name, state: "differs" };
  return { group: group.name, state: maxMtime > capturedAtMs ? "local-changed" : "store-newer" };
}

async function compareFile(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  if (!(await ctx.io.exists(store))) return "not-captured";
  if (!(await ctx.io.exists(real))) return { liveFiles: [] };
  const storeContent = await ctx.io.read(store);
  const liveContent = await ctx.io.read(real);
  if (group.sanitize !== undefined) {
    // capture stores the sanitized view — compare canonical sanitized JSON, not raw text
    const liveCanon = JSON.stringify(sanitizeJson(parseJsonOrThrow(liveContent, group.name, real), group.sanitize));
    const storeCanon = JSON.stringify(parseJsonOrThrow(storeContent, group.name, store));
    return liveCanon === storeCanon ? "equal" : { liveFiles: [real] };
  }
  return liveContent === storeContent ? "equal" : { liveFiles: [real] };
}

async function compareDir(ctx: CoreContext, real: string, store: string): Promise<Comparison> {
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return "not-captured";
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const liveRels = liveFiles.map((f) => relativeTo(real, f));
  const storeRels = storeFiles.map((f) => relativeTo(store, f));
  if (liveRels.length !== storeRels.length || liveRels.some((r, i) => r !== storeRels[i])) return { liveFiles };
  for (const rel of liveRels) {
    if ((await ctx.io.read(`${real}/${rel}`)) !== (await ctx.io.read(`${store}/${rel}`))) return { liveFiles };
  }
  return "equal";
}

export type RemoteState = "no-store" | "same" | "remote-newer" | "remote-older" | "unknown";

export interface RemoteCheck {
  state: RemoteState;
  remoteCapturedAt: string | null;
}

export async function checkRemote(localLock: StoreLock | null, reader: ExternalStoreReader): Promise<RemoteCheck> {
  const files = await reader.listFiles();
  if (!files.includes("config-sync.json")) return { state: "no-store", remoteCapturedAt: null };
  if (!files.includes("store.lock.json")) return { state: "unknown", remoteCapturedAt: null };
  let remote: StoreLock;
  try {
    remote = parseStoreLock(await reader.readFile("store.lock.json"));
  } catch {
    return { state: "unknown", remoteCapturedAt: null };
  }
  if (localLock === null) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  const r = Date.parse(remote.capturedAt);
  const l = Date.parse(localLock.capturedAt);
  if (Number.isNaN(r) || Number.isNaN(l)) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  const state: RemoteState = r > l ? "remote-newer" : r < l ? "remote-older" : "same";
  return { state, remoteCapturedAt: remote.capturedAt };
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/status.test.ts tests/core.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors (adding `stat` to `FileIO` compiles against `app.vault.adapter` unchanged — Obsidian's `DataAdapter.stat` satisfies it structurally; if tsc disagrees, report NEEDS_CONTEXT rather than casting).

```bash
git add src/core/io.ts src/core/ConfigSyncCore.ts src/core/status.ts tests/memfs.ts tests/status.test.ts tests/core.test.ts
git commit -m "feat: group drift detection, remote freshness check, junk-file capture filter"
```

---

### Task 2: Entry points — toggles, Status modal, menu badges

**Files:**
- Create: `src/ui/StatusModal.ts`
- Modify: `src/main.ts` (settings, status command, sync-menu item + badges)
- Modify: `src/ui/SettingTab.ts` (two toggles in General)

**Interfaces:**
- Consumes: `statusForGroups`/`checkRemote`/`GroupStatus`/`GroupState`/`RemoteCheck` (Task 1), `loadLock`, `groupsForDevice`, existing `createReader`, `Remote` type.
- Produces: `STATE_BADGES: Record<GroupState, string>` exported from `src/ui/StatusModal.ts` (Task 3's picker reuses it); settings fields `statusInMenu: boolean`, `statusInPickers: boolean`.

- [ ] **Step 1: Settings fields**

`src/main.ts`: `ConfigSyncSettings` gains `statusInMenu: boolean; statusInPickers: boolean;`, `DEFAULT_SETTINGS` gains `statusInMenu: true, statusInPickers: true,`. The `SettingsHost` interface in `src/ui/SettingTab.ts` mirrors the two fields.

- [ ] **Step 2: General-tab toggles**

In `SettingTab.ts`, after `renderRibbonToggles`'s heading block (append two plain Settings at the end of the General case, before the ribbon heading — place them right after the Data folder setting):

```ts
new Setting(containerEl)
  .setName("Sync menu shows change counts")
  .setDesc("Counts changed groups when the menu opens. Turn off if opening the menu feels slow.")
  .addToggle((t) =>
    t.setValue(this.host.settings.statusInMenu).onChange(async (v) => {
      this.host.settings.statusInMenu = v;
      await this.host.saveSettings();
    })
  );
new Setting(containerEl)
  .setName("Apply picker shows group status")
  .setDesc("Badges each group and pre-selects the ones the store updated.")
  .addToggle((t) =>
    t.setValue(this.host.settings.statusInPickers).onChange(async (v) => {
      this.host.settings.statusInPickers = v;
      await this.host.saveSettings();
    })
  );
```

- [ ] **Step 3: StatusModal**

Create `src/ui/StatusModal.ts`:

```ts
import { App, ButtonComponent, Modal } from "obsidian";
import { GroupState, GroupStatus, RemoteCheck } from "../core/status";
import { Remote } from "../core/types";

export const STATE_BADGES: Record<GroupState, string> = {
  "in-sync": "✓ in sync",
  "local-changed": "↑ changed on this device (likely)",
  "store-newer": "↓ store is newer (likely)",
  differs: "≠ differs",
  "not-captured": "— not captured yet",
};

export function remoteCheckText(check: RemoteCheck): string {
  const when = check.remoteCapturedAt === null ? "" : ` (captured ${check.remoteCapturedAt})`;
  switch (check.state) {
    case "no-store":
      return "no store at the remote yet — Push will initialize it";
    case "same":
      return `same as local${when}`;
    case "remote-newer":
      return `remote is newer${when} — consider Pull`;
    case "remote-older":
      return `remote is older${when} — consider Push`;
    case "unknown":
      return "cannot compare (missing or unreadable lock)";
  }
}

export interface StatusEntry {
  status: GroupStatus;
  resolvedPath: string;
}

export class StatusModal extends Modal {
  constructor(
    app: App,
    private entries: StatusEntry[],
    private remotes: Remote[],
    private onCheck: (remote: Remote) => Promise<string>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Config Sync: status");
    for (const e of this.entries) {
      const row = this.contentEl.createDiv({ cls: "config-sync-status-row" });
      row.createSpan({ cls: "config-sync-rule-name", text: e.status.group });
      row.createSpan({ cls: "config-sync-row-path", text: e.resolvedPath });
      row.createDiv({ cls: "config-sync-rule-spacer" });
      row.createSpan({ cls: `config-sync-state is-${e.status.state}`, text: STATE_BADGES[e.status.state] });
      if (e.status.message !== undefined) {
        this.contentEl.createDiv({ cls: "config-sync-status-error", text: e.status.message });
      }
    }
    if (this.remotes.length > 0) {
      this.contentEl.createEl("h5", { text: "Remotes" });
      for (const remote of this.remotes) {
        const row = this.contentEl.createDiv({ cls: "config-sync-status-row" });
        row.createSpan({ cls: "config-sync-rule-name", text: remote.name });
        const result = row.createSpan({ cls: "config-sync-row-path", text: "" });
        row.createDiv({ cls: "config-sync-rule-spacer" });
        new ButtonComponent(row).setButtonText("Check").onClick(async () => {
          result.setText("checking…");
          try {
            result.setText(await this.onCheck(remote));
          } catch (e) {
            result.setText(`cannot compare: ${(e as Error).message}`);
          }
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

And in `styles.css` append:

```css
.config-sync-status-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) 0;
  border-bottom: 1px solid var(--background-modifier-border);
}

.config-sync-state {
  font-size: var(--font-ui-smaller);
  flex: none;
}

.config-sync-state.is-in-sync { color: var(--color-green); }
.config-sync-state.is-local-changed { color: var(--color-orange); }
.config-sync-state.is-store-newer { color: var(--color-blue); }
.config-sync-state.is-differs { color: var(--color-orange); }
.config-sync-state.is-not-captured { color: var(--text-faint); }

.config-sync-status-error {
  color: var(--text-error);
  font-size: var(--font-ui-smaller);
  margin: 0 0 var(--size-4-1) var(--size-4-3);
}
```

- [ ] **Step 4: Status command + menu item + runStatus**

In `src/main.ts` (imports: `statusForGroups`, `checkRemote` from `./core/status`; `loadLock` from `./core/ConfigSyncCore`; `StatusModal`, `remoteCheckText` from `./ui/StatusModal`):

Command (after the existing five):

```ts
this.addCommand({ id: "status", name: "Status: check what's in sync", callback: () => void this.runStatus() });
```

Menu item in `openSyncMenu` (after Revert, before the transport separator):

```ts
menu.addItem((i) => i.setTitle("Status…").setIcon("activity").onClick(() => void this.runStatus()));
```

Method:

```ts
private async runStatus(): Promise<void> {
  try {
    const ctx = await this.coreContext();
    const manifest = await loadManifest(ctx);
    const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
    const groups = groupsForDevice(manifest, device);
    const statuses = await statusForGroups(ctx, groups);
    const byName = new Map(groups.map((g) => [g.name, g]));
    const entries = statuses.map((s) => ({
      status: s,
      resolvedPath: (byName.get(s.group)?.path ?? "").replace("{configDir}", this.app.vault.configDir),
    }));
    let localLock: StoreLock | null = null;
    try {
      localLock = await loadLock(ctx);
    } catch {
      localLock = null;
    }
    const remotes = Platform.isDesktop ? this.settings.remotes : [];
    new StatusModal(this.app, entries, remotes, async (remote) => {
      const reader = await this.createReader(remote);
      return remoteCheckText(await checkRemote(localLock, reader));
    }).open();
  } catch (e) {
    new Notice(`Config Sync status failed: ${(e as Error).message}`, 10000);
  }
}
```

(`StoreLock` joins the type imports from `./core/types`.)

- [ ] **Step 5: Menu badges**

Rework `openSyncMenu` to compute counts first when enabled (the ribbon callback becomes `(evt) => void this.openSyncMenu(evt)`):

```ts
private async openSyncMenu(evt: MouseEvent): Promise<void> {
  let captureTitle = "Capture: save this device's settings";
  let applyTitle = "Apply: update this device with synced settings";
  if (this.settings.statusInMenu) {
    try {
      const ctx = await this.coreContext();
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      const statuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
      const changedHere = statuses.filter((s) => s.state === "local-changed" || s.state === "differs").length;
      const storeNewer = statuses.filter((s) => s.state === "store-newer").length;
      if (changedHere > 0) captureTitle = `Capture (${changedHere} changed here)`;
      if (storeNewer > 0) applyTitle = `Apply (${storeNewer} store-newer)`;
    } catch (e) {
      console.error("Config Sync: menu status check failed", e); // the menu must still open
    }
  }
  const menu = new Menu();
  menu.addItem((i) => i.setTitle(captureTitle).setIcon("upload").onClick(() => void this.runCapture()));
  // …remaining items exactly as today (Apply uses applyTitle), plus the Status… item from Step 4…
  menu.showAtMouseEvent(evt);
}
```

(A vault without a rules file yet: `loadManifest` throws → caught → plain titles. That is the correct first-run behavior.)

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

```bash
git add src/main.ts src/ui/StatusModal.ts src/ui/SettingTab.ts styles.css
git commit -m "feat: status command and modal, sync-menu change counts, feature toggles"
```

---

### Task 3: Apply picker status + report copy pass

**Files:**
- Modify: `src/ui/GroupSelectModal.ts` (status-aware items)
- Modify: `src/main.ts` (`runApply` builds items; pull/push report titles)
- Modify: `src/ui/ReportModal.ts` (skip empty group label)

**Interfaces:**
- Consumes: `GroupStatus`/`GroupState` (Task 1), `STATE_BADGES` (Task 2), `statusForGroups`, `settings.statusInPickers`.
- Produces: `GroupPickItem { group: SyncGroup; resolvedPath: string; meta: string; status: GroupStatus | null }`; `GroupSelectModal(app, items: GroupPickItem[], title, onSubmit)`.

- [ ] **Step 1: Rework GroupSelectModal**

Full new content of `src/ui/GroupSelectModal.ts`:

```ts
import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { GroupStatus } from "../core/status";
import { SyncGroup } from "../core/types";
import { STATE_BADGES } from "./StatusModal";

export interface GroupPickItem {
  group: SyncGroup;
  resolvedPath: string;
  meta: string; // description, or "folder · all devices"-style line
  status: GroupStatus | null; // null = status display disabled
}

export class GroupSelectModal extends Modal {
  private selected = new Set<string>();
  private cta: ButtonComponent | null = null;

  constructor(
    app: App,
    private items: GroupPickItem[],
    private modalTitle: string,
    private onSubmit: (names: string[]) => void
  ) {
    super(app);
    for (const item of this.items) {
      if (item.status?.state === "store-newer") this.selected.add(item.group.name);
    }
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const item of this.items) {
      const state = item.status?.state ?? null;
      const parts = [item.resolvedPath, item.meta];
      if (state !== null) parts.push(STATE_BADGES[state]);
      if (state === "local-changed" || state === "differs") parts.push("applying overwrites local changes");
      const row = new Setting(this.contentEl).setName(item.group.name).setDesc(parts.join(" · "));
      if (state === "in-sync") row.settingEl.addClass("config-sync-picker-insync");
      row.addToggle((t) => {
        t.setValue(this.selected.has(item.group.name));
        t.setDisabled(state === "not-captured");
        t.onChange((v) => {
          if (v) this.selected.add(item.group.name);
          else this.selected.delete(item.group.name);
          this.updateCta();
        });
      });
    }
    new Setting(this.contentEl).addButton((b) => {
      this.cta = b;
      b.setCta().onClick(() => {
        this.close();
        this.onSubmit([...this.selected]);
      });
      this.updateCta();
    });
  }

  private updateCta(): void {
    const n = this.selected.size;
    this.cta?.setButtonText(n === 1 ? "Apply 1 group" : `Apply ${n} groups`);
    this.cta?.setDisabled(n === 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

And in `styles.css`:

```css
.config-sync-picker-insync {
  opacity: 0.55;
}
```

- [ ] **Step 2: runApply builds items**

In `src/main.ts` `runApply`, replace the `GroupSelectModal` construction with:

```ts
const statuses = this.settings.statusInPickers ? await statusForGroups(ctx, groups) : null;
const statusByName = statuses === null ? null : new Map(statuses.map((s) => [s.group, s]));
const deviceWords: Record<SyncGroup["devices"], string> = { all: "all devices", desktop: "desktop only", mobile: "mobile only" };
const items = groups.map((group) => ({
  group,
  resolvedPath: group.path.replace("{configDir}", this.app.vault.configDir),
  meta: group.description ?? `${group.type === "dir" ? "folder" : "file"} · ${deviceWords[group.devices]}`,
  status: statusByName?.get(group.name) ?? null,
}));
new GroupSelectModal(this.app, items, "Config Sync: select groups to apply", (names) => {
  void this.applyGroups(ctx, names);
}).open();
```

- [ ] **Step 3: Pull/Push report titles**

In `pullFrom`: `new ReportModal(this.app, \`Pulled from ${remote.name}\`, [{ ...result, group: "" }]).open();`
In `pushTo`: same pattern with `` `Pushed to ${remote.name}` ``.

In `src/ui/ReportModal.ts` `onOpen`, the heading line

```ts
block.createEl("strong", { text: `${icon} ${r.group}` });
```

becomes (the counts/messages lines below it are untouched — for pull/push single results the icon still communicates the outcome):

```ts
block.createEl("strong", { text: r.group === "" ? icon : `${icon} ${r.group}` });
```

- [ ] **Step 4: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

```bash
git add src/ui/GroupSelectModal.ts src/ui/ReportModal.ts src/main.ts styles.css
git commit -m "feat: status-aware apply picker with smart defaults; friendlier pull/push reports"
```

---

## Verification after all tasks

1. Full gate: `npm test && npm run build && npm run lint`.
2. Smoke (obsidian-cli, dev vault): Status modal lists groups with badges and resolved paths; remote Check renders inline result; menu shows `Capture (N changed here)` after editing a captured file and plain titles when nothing changed or the toggle is off; Apply picker pre-selects store-newer only, disables not-captured, dims in-sync, CTA counts selections; `.DS_Store` planted in a captured dir disappears from the store on next Capture and never shows as `differs`; toggles off → instant menu / plain picker; zero console errors.
3. Release notes: mention the new Status command, menu counts, smarter Apply picker, junk-file cleanup, and the two toggles.
