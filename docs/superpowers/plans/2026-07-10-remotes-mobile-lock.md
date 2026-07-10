# Remotes on Mobile, Browse Fix, Lock Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the "publish" vocabulary from the lock file (`capturedAt`) with errored-capture carry-forward, fix the Browse button's "failed module electron" crash via `window.require`, and hide the Remotes tab on mobile.

**Architecture:** Lock changes are core-only (`types.ts`/`manifest.ts`/`ConfigSyncCore.ts`) with capture() loading the previous lock defensively (capture is the file's writer and sole healing path). The Browse fix swaps the ESM dynamic import — which esbuild preserves verbatim and the Electron renderer cannot resolve — for the community-standard `window.require("electron")`. The tab change is a one-flag filter in `renderTabNav`.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable); `pickFolder.ts` must contribute no warnings.
- `src/core/*` has zero Node-builtin/`obsidian` imports.
- **Strict rename, no back-compat**: `parseStoreLock` accepts only `capturedAt`; an old-format lock heals on the next Capture (and MUST NOT make Capture fail).
- Do NOT touch `src/core/catalog.ts`'s `publish: "publish.json"` / `CORE_NOT_RECOMMENDED ["sync", "publish"]` — that is Obsidian's own Publish core plugin.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.
- Copy strings verbatim where specified.
- `noUncheckedIndexedAccess` is on — guard array indexing.

---

### Task 1: `capturedAt` rename, `captureGroup`, errored-capture carry-forward

**Files:**
- Modify: `src/core/types.ts` (StoreLock)
- Modify: `src/core/manifest.ts` (`parseStoreLock`)
- Modify: `src/core/ConfigSyncCore.ts` (`capture`, `publishGroup`→`captureGroup`, `checkApply` message)
- Test: `tests/manifest.test.ts`, `tests/core.test.ts`

**Interfaces:**
- Consumes: existing `loadLock(ctx): Promise<StoreLock | null>`, `pluginIdForGroup`, test harness `setup()`/`MANIFEST`/`MemFS`/`FakePlugins` in `tests/core.test.ts`.
- Produces: `StoreLock { capturedAt: string; groups: Record<string, { sourcePluginVersion: string }> }` (no other task depends on this; the field is persisted in `store.lock.json`).

- [ ] **Step 1: Write the failing tests**

In `tests/manifest.test.ts`, inside `describe("parseStoreLock", …)`: change the valid-lock test's fixture key `publishedAt` → `capturedAt` and its expectation to `lock.capturedAt`; add:

```ts
it("rejects the retired publishedAt key", () => {
  expect(() => parseStoreLock('{"publishedAt":"t","groups":{}}')).toThrow("capturedAt");
});
```

In `tests/core.test.ts`, add to `describe("capture", …)` (the harness: `setup()` returns `{ io, plugins, ctx }` with `configDir: ".obs"`, `rootPath: "cs"`; `MANIFEST` has the plugin group `plugin-demo` at `.obs/plugins/demo/data.json`):

```ts
it("carries forward the version stamp for a group that errors this capture", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
  });
  await capture(ctx);
  await io.remove(".obs/plugins/demo/data.json");
  const results = await capture(ctx);
  expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
  const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { sourcePluginVersion: string }> };
  expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" });
});

it("does not invent lock entries for errored groups that never had one", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obsidian.vimrc": "v",
    // plugin-demo source missing from the start
  });
  const results = await capture(ctx);
  expect(results.find((r) => r.group === "plugin-demo")?.status).toBe("error");
  const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, unknown> };
  expect(lock.groups["plugin-demo"]).toBeUndefined();
});

it("rebuilds an old-format lock on capture instead of failing", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    "cs/store.lock.json": '{"publishedAt":"t","groups":{"plugin-demo":{"sourcePluginVersion":"9.9.9"}}}',
    ".obs/hotkeys.json": "{}",
    ".obs/snippets/one.css": "x",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
  });
  const results = await capture(ctx);
  expect(results.every((r) => r.status === "ok")).toBe(true);
  const lock = JSON.parse(await io.read("cs/store.lock.json")) as { capturedAt: string; groups: Record<string, { sourcePluginVersion: string }> };
  expect(lock.capturedAt).toBe("2026-07-08T00:00:00.000Z");
  expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" }); // current version, not the stale 9.9.9 — success always re-stamps
});
```

(If `MemFS` lacks a `remove` method usable from tests, check `tests/memfs.ts` — core calls `ctx.io.remove`, so it exists; call it as `io.remove(...)`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/manifest.test.ts tests/core.test.ts`
Expected: FAIL — `capturedAt` is undefined on parsed locks; old-key lock is accepted; carry-forward entry missing after errored capture; old-format lock makes capture throw.

- [ ] **Step 3: Implement**

`src/core/types.ts`:

```ts
export interface StoreLock {
  capturedAt: string;
  groups: Record<string, { sourcePluginVersion: string }>;
}
```

`src/core/manifest.ts` `parseStoreLock` — key and messages:

```ts
if (!isPlainObject(parsed) || typeof parsed.capturedAt !== "string" || !isPlainObject(parsed.groups)) {
  throw new ManifestValidationError("store.lock.json must be {capturedAt: string, groups: object}");
}
// …groups loop unchanged…
return { capturedAt: parsed.capturedAt, groups };
```

`src/core/ConfigSyncCore.ts`:

Rename `publishGroup` → `captureGroup` (definition + the single call in `capture`). Replace `capture` with:

```ts
export async function capture(ctx: CoreContext): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  // Capture is the lock's writer and its only healing path: a previous lock that is
  // missing, old-format, or corrupt must never block capture — it is rewritten below.
  let previous: StoreLock | null = null;
  try {
    previous = await loadLock(ctx);
  } catch {
    previous = null;
  }
  const lock: StoreLock = { capturedAt: ctx.now(), groups: {} };
  const results: GroupResult[] = [];
  for (const group of manifest.groups) {
    const result = await captureGroup(ctx, group);
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      if (result.status !== "error") {
        const version = ctx.plugins.getInstalledPluginVersion(pluginId);
        if (version !== null) {
          lock.groups[group.name] = { sourcePluginVersion: version };
        } else {
          result.status = "warning";
          result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
        }
      } else {
        const prev = previous?.groups[group.name];
        if (prev !== undefined) lock.groups[group.name] = prev; // errored capture keeps the last known version
      }
    }
    results.push(result);
  }
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}
```

`checkApply` — the two lock-related strings:
- mismatch message becomes exactly: `` `store config was captured with ${pluginId}@${recorded}, this device runs ${pluginId}@${installed} — settings schema may differ` ``
- the no-record message keeps its text (it already names store.lock.json without the retired verb).

- [ ] **Step 4: Update existing test wording/fixtures**

In `tests/core.test.ts`: every `publishedAt` fixture/assertion → `capturedAt` (the first capture test's `lock` expectation, the checkApply seeds around lines 121 and 257, and any others `grep -n publishedAt tests/` finds); test names `"reports missing sources as per-group errors and publishes the rest"` → `"…and captures the rest"`, `"publishes the starter groups created on demand"` → `"captures the starter groups created on demand"`; any assertion on the mismatch message text (`grep -n "published from" tests/`) updates to `captured with`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/manifest.test.ts tests/core.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors. Also `grep -rn "publish" src/ --include="*.ts" | grep -v catalog.ts` → no matches (catalog.ts's Obsidian-Publish entries are the only survivors).

```bash
git add src/core/types.ts src/core/manifest.ts src/core/ConfigSyncCore.ts tests/manifest.test.ts tests/core.test.ts
git commit -m "feat!: lock capturedAt with errored-capture carry-forward; retire publish vocabulary"
```

---

### Task 2: Browse fix — `window.require("electron")`

**Files:**
- Modify: `src/external/pickFolder.ts`

**Interfaces:**
- Consumes/Produces: `pickFolder(): Promise<string | null>` — signature unchanged; only the electron acquisition changes.

**Why:** the bundled `main.js` contains a literal `await import("electron")` — esbuild keeps `import()` of externals verbatim for modern targets even in CJS output, and the Electron renderer cannot resolve a bare specifier through native ESM import → "failed module electron" on every real Browse click. `window.require` is the community-plugin standard and is untouched by the bundler.

- [ ] **Step 1: Replace the electron acquisition**

Full new content of `src/external/pickFolder.ts`:

```ts
import { Platform } from "obsidian";

interface ElectronDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Opens the system directory picker. Returns the chosen absolute path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!Platform.isDesktop) {
    throw new Error("Config Sync: the folder picker is desktop-only");
  }
  // window.require, not import("electron"): esbuild keeps dynamic imports of externals
  // as native ESM import(), which the Electron renderer cannot resolve for bare specifiers.
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (req === undefined) {
    throw new Error("Config Sync: the folder picker needs the desktop app");
  }
  const electron = req("electron") as { remote?: { dialog?: ElectronDialog } };
  const dialog = electron.remote?.dialog;
  if (dialog === undefined) {
    throw new Error("Config Sync: the Electron file dialog is unavailable in this Obsidian build");
  }
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const first = result.filePaths[0];
  if (result.canceled || first === undefined) return null;
  return first;
}
```

- [ ] **Step 2: Verify the bundle no longer contains the broken import**

Run: `npm run build && grep -c 'import("electron")' main.js`
Expected: build clean; grep prints `0` (exit code 1 from grep is fine — assert on the count).

- [ ] **Step 3: Gate + commit**

Run: `npm test && npm run build && npm run lint` (and `npm run lint 2>&1 | grep pickFolder` → empty).
Expected: pass / clean / 0 errors.

```bash
git add src/external/pickFolder.ts
git commit -m "fix: Browse uses window.require('electron') — bundled import() cannot resolve it"
```

(End-to-end verification — a human click on Browse opening the real dialog — happens at branch-end smoke; it is mandatory this time.)

---

### Task 3: Hide the Remotes tab on mobile; Core-plugins icon matches Obsidian

**Files:**
- Modify: `src/ui/SettingTab.ts` (`TABS`, `renderTabNav`)

**Interfaces:** none new.

- [ ] **Step 1: Flag, filter, and icon**

In `src/ui/SettingTab.ts`, the `TABS` type and the `sources` entry gain a desktop-only flag, and the `core` icon changes from `blocks` to `toy-brick` — the icon Obsidian's own settings sidebar uses for its Core plugins tab (probed live: `{id: "plugins", name: "Core plugins", icon: "toy-brick"}`; our Community-plugins `puzzle` already matches Obsidian's):

```ts
const TABS: { id: PanelTab; label: string; icon: string; desktopOnly?: true }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "obsidian", label: "Obsidian", icon: "gem" },
  { id: "core", label: "Core plugins", icon: "toy-brick" },
  { id: "plugins", label: "Community plugins", icon: "puzzle" },
  { id: "advanced", label: "Advanced", icon: "wrench" },
  { id: "sources", label: "Remotes", icon: "git-branch", desktopOnly: true },
];
```

In `renderTabNav`'s loop, first line:

```ts
for (const tab of TABS) {
  if (tab.desktopOnly === true && Platform.isMobile) continue;
  // …existing rendering unchanged…
}
```

(`Platform` is already imported in this file.)

- [ ] **Step 2: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: hide the Remotes tab on mobile; core-plugins tab icon matches Obsidian"
```

---

## Verification after all tasks

1. Full gate: `npm test && npm run build && npm run lint` — all tests pass, 0 lint errors, `grep -c 'import("electron")' main.js` = 0, `grep -rn publish src --include="*.ts" | grep -v catalog.ts` empty.
2. Smoke (obsidian-cli, dev vault): desktop shows 6 tabs; `dev:mobile on` + forced narrow shows 5 (no Remotes); Capture writes `store.lock.json` with `capturedAt`; zero console errors. **Manual step (mandatory): click Browse on a vault remote — the system dialog opens and picking a vault auto-fills the store path.**
3. Release notes for the next version must call out: run **Capture once after upgrading** (old lock files fail to parse until rewritten; Apply's version warnings are degraded until then).
