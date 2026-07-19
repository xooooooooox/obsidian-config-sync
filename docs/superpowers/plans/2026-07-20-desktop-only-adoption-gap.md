# Desktop-only adoption-gap fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make desktop-only detection actually work for the existing plugin set — desktop reads the manifest directly (①), any capture refreshes every installed plugin's flag in the lock (②), and a self-pane nudge (Y) ensures a capture happens.

**Architecture:** ① changes one expression in `availabilityForGroup`. ② wraps the two carry-forward lock writes in `capture()` with a flag-refresh helper. Y adds a pure `desktopOnlyDrift` counter, threads a `flagsDrift`/`flagsRefresh` pair through `selfPaneState`/`selfStatus`, and renders a line on the existing self pane.

**Tech Stack:** TypeScript, vitest. Files: `src/core/availability.ts`, `src/core/ConfigSyncCore.ts`, `src/core/selfPane.ts`, `src/main.ts`, `src/ui/SyncCenterView.ts`.

## Global Constraints

- Gates: `npm test` green, `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No store schema change (`desktopOnly` shipped in 1.1.2). No new UI element (reuse self pane). No out-of-band store writes — only capture writes the lock.
- Targets 1.1.3, bundled with the mobile-overflow fixes already on main.

---

### Task 1: ① `availabilityForGroup` reads the local manifest when installed

**Files:**
- Modify: `src/core/availability.ts` (plugin-anchored return, ~line 49-56)
- Test: `tests/availability.test.ts` (rewrite the existing desktopOnly test ~line 33-43)

**Interfaces:**
- Consumes: `PluginHost.isDesktopOnly(id): boolean`, `getInstalledPluginVersion(id): string | null` (both exist).
- Produces: unchanged `Availability` shape; `desktopOnly` now manifest-derived when installed.

- [ ] **Step 1: Rewrite the failing test.** Replace the existing test at `tests/availability.test.ts` (`it("carries desktopOnly from the lock (plugin groups only)", ...)`) with:

```ts
  it("reads desktopOnly from the manifest when installed, lock when not (plugin groups only)", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "2.2.1");
    p.desktopOnlyIds.add("demo"); // manifest says desktop-only
    // installed → manifest wins even when the lock lacks the flag
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1" } })).desktopOnly).toBe(true);
    // installed → manifest wins even over a stale lock flag
    p.desktopOnlyIds.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } })).desktopOnly).toBe(false);
    // not installed (the mobile case) → fall back to the lock
    p.installed.delete("demo");
    expect(availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } })).desktopOnly).toBe(true);
    // app-anchored → always false
    p.appVersion = "1.8.7";
    p.coreEnabled.add("daily-notes");
    expect(availabilityForGroup(coreGroup, p, null).desktopOnly).toBe(false);
  });
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run tests/availability.test.ts -t "reads desktopOnly from the manifest"` — Expected: FAIL (current code reads only the lock, so the first assertion — no lock flag but installed desktop-only — returns false).

- [ ] **Step 3: Implement.** In `src/core/availability.ts`, change the plugin-anchored return's `desktopOnly` line from:

```ts
      desktopOnly: lock?.groups[group.name]?.desktopOnly === true,
```

to:

```ts
      desktopOnly: localVersion !== null ? plugins.isDesktopOnly(pluginId) : lock?.groups[group.name]?.desktopOnly === true,
```

- [ ] **Step 4: Run tests.** `npx vitest run tests/availability.test.ts` — Expected: PASS (the rewritten test and all existing ones; the `desktopOnly: false` literals still hold because `demo` is not in `desktopOnlyIds` there).

- [ ] **Step 5: Commit.**

```bash
git add src/core/availability.ts tests/availability.test.ts
git commit -m "fix: desktop reads desktopOnly from the local manifest, lock only as mobile fallback"
```

---

### Task 2: ② capture backfills the flag onto carried-forward entries

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`capture()`: add helper + wrap the two `lock.groups[name] = prev` carry-forward writes)
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `pluginIdForGroup(group)` (defined in this file), `ctx.plugins` (`PluginHost`).
- Produces: `refreshLockDesktopOnly(entry, group, plugins)` — file-local helper.

- [ ] **Step 1: Write the failing tests.** Add to `tests/core.test.ts` (inside the capture describe block, or a new `describe("capture desktopOnly backfill", ...)`). `setup`, `MANIFEST`, `seedGroups` are already imported/defined in this file:

```ts
  it("backfills desktopOnly onto a carried-forward installed desktop-only plugin", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    plugins.desktopOnlyIds.add("demo");
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      // pre-fix lock: plugin-demo captured before the flag existed
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]); // capture ONLY hotkeys → plugin-demo carries forward
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true });
  });

  it("clears a stale desktopOnly on carry-forward when the plugin is no longer desktop-only", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3"); // installed, NOT desktop-only (desktopOnlyIds empty)
    io.seed({
      ".obs/plugins/demo/data.json": "{}",
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3", desktopOnly: true }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" }); // flag cleared
  });

  it("leaves a carried-forward entry untouched when the plugin is not installed here", async () => {
    const { io, plugins, ctx } = setup();
    // demo NOT installed on this device
    io.seed({
      ".obs/hotkeys.json": "{}",
      ".obs/snippets/one.css": "x",
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", groups: { "plugin-demo": { sourcePluginVersion: "1.2.3", desktopOnly: true }, hotkeys: { sourceAppVersion: "1.0.0" } } }),
    });
    await seedGroups(ctx, MANIFEST);
    await capture(ctx, ["hotkeys"]);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
    expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true }); // another device is authoritative — untouched
  });
```

- [ ] **Step 2: Run them, verify they fail.** `npx vitest run tests/core.test.ts -t "desktopOnly"` — Expected: the first two FAIL (carry-forward copies `prev` verbatim today), the third PASSes already.

- [ ] **Step 3: Implement the helper.** In `src/core/ConfigSyncCore.ts`, above `capture()`, add:

```ts
// On capture, every group's lock entry is rewritten (selected → fresh, others → carried forward).
// For carried-forward entries of installed plugins, refresh desktopOnly to match the live manifest
// so the flag lands for the whole plugin set, not just the groups captured this run.
function refreshLockDesktopOnly(
  entry: StoreLock["groups"][string],
  group: SyncGroup,
  plugins: PluginHost
): StoreLock["groups"][string] {
  const pluginId = pluginIdForGroup(group);
  if (pluginId === null || plugins.getInstalledPluginVersion(pluginId) === null) return entry; // app-anchored or not installed here → untouched
  const { desktopOnly, ...rest } = entry;
  return plugins.isDesktopOnly(pluginId) ? { ...rest, desktopOnly: true } : rest;
}
```

Confirm `StoreLock`, `SyncGroup`, `PluginHost` are already imported in this file (they are — used throughout `capture`).

- [ ] **Step 4: Wire both carry-forward sites.** In `capture()`, change the not-selected carry-forward:

```ts
      const prev = previous?.groups[group.name];
      if (prev !== undefined) lock.groups[group.name] = prev; // not captured this run — carry forward
```

to:

```ts
      const prev = previous?.groups[group.name];
      if (prev !== undefined) lock.groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // carry forward, refreshing desktopOnly
```

and the errored-capture carry-forward:

```ts
        const prev = previous?.groups[group.name];
        if (prev !== undefined) lock.groups[group.name] = prev; // errored capture keeps the last known version
```

to:

```ts
        const prev = previous?.groups[group.name];
        if (prev !== undefined) lock.groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // errored capture keeps version, refreshing desktopOnly
```

- [ ] **Step 5: Run tests.** `npx vitest run tests/core.test.ts` — Expected: PASS (all three new tests + existing capture tests; the version-only-refresh and error-carry tests still hold — `refreshLockDesktopOnly` preserves `sourcePluginVersion` and only touches `desktopOnly`).

- [ ] **Step 6: Commit.**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "fix: refresh every installed plugin's desktopOnly flag on capture"
```

---

### Task 3: `desktopOnlyDrift` pure detector

**Files:**
- Modify: `src/core/availability.ts` (add exported function)
- Test: `tests/availability.test.ts`

**Interfaces:**
- Produces: `desktopOnlyDrift(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): number` — count of installed plugin groups whose local desktop-only status differs from a present lock entry's flag.

- [ ] **Step 1: Write the failing test.** Add to `tests/availability.test.ts`:

```ts
describe("desktopOnlyDrift", () => {
  const g = (name: string, path: string): SyncGroup => ({ name, path, type: "file", devices: "all" });
  it("counts only installed plugins whose lock flag disagrees with the manifest and that have an entry", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0");
    p.desktopOnlyIds.add("demo"); // manifest: desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    // entry exists, flag missing → drift
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(1);
    // entry already flagged → no drift
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0", desktopOnly: true } }))).toBe(0);
    // no lock entry → not counted (normal capture handles it; avoids a stuck nudge)
    expect(desktopOnlyDrift(groups, p, lock({}))).toBe(0);
    // not installed here → not counted
    p.installed.delete("demo");
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(0);
  });
  it("does not count a normal (non-desktop-only) installed plugin with no flag", () => {
    const p = new FakePlugins();
    p.installed.set("demo", "1.0.0"); // desktopOnlyIds empty → not desktop-only
    const groups = [g("plugin-demo", "{configDir}/plugins/demo/data.json")];
    expect(desktopOnlyDrift(groups, p, lock({ "plugin-demo": { sourcePluginVersion: "1.0.0" } }))).toBe(0);
  });
});
```

Add `desktopOnlyDrift` and `SyncGroup` to the import from `../src/core/availability` / `../src/core/types` at the top of the test file as needed (`SyncGroup` is already imported from types in this file — confirm; add `desktopOnlyDrift` to the availability import).

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run tests/availability.test.ts -t "desktopOnlyDrift"` — Expected: FAIL ("desktopOnlyDrift is not a function").

- [ ] **Step 3: Implement.** In `src/core/availability.ts`, add at the end:

```ts
// Counts installed plugin groups whose local desktop-only status differs from what the lock
// records AND that a capture can fix (an entry already exists). Used to nudge a capture so the
// flag propagates to devices that can't read the manifest (mobile). Excludes entryless groups so
// the nudge can't get stuck on a never-captured plugin (the normal capture path handles those).
export function desktopOnlyDrift(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): number {
  let n = 0;
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue; // app-anchored
    if (plugins.getInstalledPluginVersion(id) === null) continue; // not installed here
    const entry = lock?.groups[g.name];
    if (entry?.sourcePluginVersion === undefined) continue; // no entry to refresh
    if (plugins.isDesktopOnly(id) !== (entry.desktopOnly === true)) n++;
  }
  return n;
}
```

- [ ] **Step 4: Run tests.** `npx vitest run tests/availability.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/availability.ts tests/availability.test.ts
git commit -m "feat: add desktopOnlyDrift detector for the capture nudge"
```

---

### Task 4: `selfPaneState` gains `flagsDrift`/`flagsRefresh`

**Files:**
- Modify: `src/core/selfPane.ts`
- Test: `tests/selfPane.test.ts` (add new cases + update all existing literals)

**Interfaces:**
- Produces: `selfPaneState({ isColdStart, groupState, drift, flagsDrift }): { state, versionRefresh, contentChanged, flagsRefresh }` — new required input `flagsDrift: boolean` and new output `flagsRefresh: boolean`.
- Consumed by: Task 5 (`main.ts selfStatus`).

- [ ] **Step 1: Update + add tests.** In `tests/selfPane.test.ts`, add `flagsDrift: false` to every existing input and `flagsRefresh: false` to every existing expected object. Then add:

```ts
  it("flags drift with an otherwise in-sync self = capture via flagsRefresh", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: null, flagsDrift: true })).toEqual({ state: "capture", versionRefresh: false, contentChanged: false, flagsRefresh: true });
  });
  it("version refresh and flags refresh compose", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "in-sync", drift: "ahead", flagsDrift: true })).toEqual({ state: "capture", versionRefresh: true, contentChanged: false, flagsRefresh: true });
  });
  it("flags drift does not override adopt", () => {
    expect(selfPaneState({ isColdStart: false, groupState: "store-newer", drift: null, flagsDrift: true })).toEqual({ state: "adopt", versionRefresh: false, contentChanged: true, flagsRefresh: true });
  });
```

- [ ] **Step 2: Run, verify failure.** `npx vitest run tests/selfPane.test.ts` — Expected: FAIL (existing tests fail on the missing `flagsRefresh` key / signature; new tests fail).

- [ ] **Step 3: Implement.** Replace `selfPaneState` in `src/core/selfPane.ts` with:

```ts
export function selfPaneState(args: { isColdStart: boolean; groupState: GroupState | undefined; drift: VersionDrift; flagsDrift: boolean }): {
  state: SelfPaneState;
  versionRefresh: boolean;
  contentChanged: boolean;
  flagsRefresh: boolean;
} {
  if (args.isColdStart) return { state: "coldstart", versionRefresh: false, contentChanged: false, flagsRefresh: false };
  const s = args.groupState;
  const versionRefresh = s === "in-sync" && args.drift === "ahead";
  const flagsRefresh = args.flagsDrift;
  const contentChanged = s === "local-changed" || s === "store-newer" || s === "differs" || s === "not-captured";
  let state: SelfPaneState;
  if (s === "store-newer") state = "adopt";
  else if (s === "differs") state = "both";
  else if (s === "local-changed" || s === "not-captured" || versionRefresh || flagsRefresh) state = "capture";
  else state = "insync";
  return { state, versionRefresh, contentChanged, flagsRefresh };
}
```

Update the doc-comment above it to mention `flagsRefresh` (flags-not-recorded also nudges a capture).

- [ ] **Step 4: Run tests.** `npx vitest run tests/selfPane.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/selfPane.ts tests/selfPane.test.ts
git commit -m "feat: selfPaneState treats desktopOnly flag drift as a capture nudge"
```

---

### Task 5: Wire the nudge into `selfStatus` and render it

**Files:**
- Modify: `src/main.ts` (`selfStatus`)
- Modify: `src/ui/SyncCenterView.ts` (`SelfSyncInfo` interface; `renderSelfContentDetail`)

**Interfaces:**
- Consumes: `desktopOnlyDrift` (Task 3), `selfPaneState` new shape (Task 4).
- Produces: `SelfSyncInfo.flagsRefresh: number | null`.

- [ ] **Step 1: Extend the `SelfSyncInfo` interface.** In `src/ui/SyncCenterView.ts`, add to the interface (after `versionRefresh`):

```ts
  flagsRefresh: number | null; // installed plugins whose desktopOnly flag isn't recorded yet → nudge a capture
```

- [ ] **Step 2: Import + compute drift in `selfStatus`.** In `src/main.ts`, add `desktopOnlyDrift` to the import from `./core/availability`. In `selfStatus`, after `const av = availabilityForGroup(selfGroup, this.pluginHost(), lock);`, add:

```ts
        const flagsRefreshCount = desktopOnlyDrift(this.settings.groups, this.pluginHost(), lock);
```

Change the `selfPaneState` call to pass the new input:

```ts
        const decided = selfPaneState({ isColdStart: false, groupState: st?.state, drift: av.drift, flagsDrift: flagsRefreshCount > 0 });
```

Change the main return to include the field:

```ts
        return { state: decided.state, delta, itemCount: local.length, capturedAt, contentChanged: decided.contentChanged, versionRefresh, flagsRefresh: flagsRefreshCount > 0 ? flagsRefreshCount : null };
```

Add `flagsRefresh: null` to the two early returns in `selfStatus` (the `local.length === 0` coldstart return and the `selfGroup === undefined` return).

- [ ] **Step 3: Render the line.** In `src/ui/SyncCenterView.ts` `renderSelfContentDetail`, after the `versionRefresh` early-return block and before `if (!info.contentChanged) return;`, add:

```ts
    if (dir === "capture" && info.flagsRefresh !== null) {
      const n = info.flagsRefresh;
      block.createDiv({
        cls: "config-sync-self-block-s",
        text: `${n} desktop-only plugin${n === 1 ? "" : "s"} not recorded in the store yet — capturing lets your phones skip installs that can't run there.`,
      });
      return;
    }
```

- [ ] **Step 4: Fix any other `SelfSyncInfo` literals.** Run `npx tsc -noEmit -skipLibCheck`. If it flags any other object literal missing `flagsRefresh` (e.g. a UI test mock), add `flagsRefresh: null` there. Expected after fixes: tsc clean.

- [ ] **Step 5: Full gates.** `npm test` (green), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK — no colors touched), `npm run build` (clean).

- [ ] **Step 6: Commit.**

```bash
git add src/main.ts src/ui/SyncCenterView.ts
git commit -m "feat: surface the desktopOnly flag-drift capture nudge on the Config Sync pane"
```

---

### Task 6: Live verification on dev/vault

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`; reload the plugin (obsidian-cli disable/enable).
- [ ] **Step 2: ① pill without capture.** Confirm an installed desktop-only plugin (e.g. `media-extended`) now reports `availOf(name).desktopOnly === true` against a lock with NO flag (via `obsidian-cli eval`), proving desktop reads the manifest.
- [ ] **Step 3: Y nudge.** Forge the store lock so an installed desktop-only plugin's entry lacks the flag; reload; open the Config Sync self pane; confirm it shows "N desktop-only plugins not recorded…" and the "to capture" state.
- [ ] **Step 4: ② resolves it.** Capture (self or anything); confirm the forged lock entry gains `desktopOnly: true` and the self-pane nudge clears on the next scan.
- [ ] **Step 5: Restore.** Restore the dev-vault lock from backup so the synced store stays clean.

---

## Self-Review

**Spec coverage:** ① → Task 1; ② → Task 2; Y detection → Task 3; Y state → Task 4; Y wiring + render → Task 5; live → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the exact code. ✓

**Type consistency:** `desktopOnlyDrift` returns `number` (Task 3); `flagsDrift: boolean = count > 0` and `flagsRefresh: number | null = count > 0 ? count : null` (Task 5) feed `selfPaneState`'s `flagsDrift: boolean` → `flagsRefresh: boolean` (Task 4) and `SelfSyncInfo.flagsRefresh: number | null` (Task 5); `renderSelfContentDetail` reads the `number` for the message. `refreshLockDesktopOnly` returns `StoreLock["groups"][string]` (Task 2). Consistent. ✓
