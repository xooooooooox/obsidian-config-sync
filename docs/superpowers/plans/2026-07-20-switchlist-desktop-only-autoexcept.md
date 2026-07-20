# Auto-except desktop-only plugins from the enabled-plugins switch-list — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop a phone from removing desktop-only plugins from the store's enabled-plugins list — treat known desktop-only plugin ids as automatic switch-list exceptions, so no manual exclude is needed.

**Architecture:** A pure `desktopOnlyPluginIds(lock)` reads the lock's per-group `desktopOnly` flags. `main.ts` folds those ids into the runtime `switchExceptions` for `community-plugins` at `coreContext()` build time (and in `diffPair`), so every runtime consumer (`excFor`, `status.ts`, `switchDivergenceFor`, the inline diff) sees them as exceptions. Persisted `settings.switchExceptions` and the manual-exception surfaces are untouched.

**Tech Stack:** TypeScript, vitest. Files: `src/core/availability.ts`, `src/main.ts`.

## Global Constraints

- Gates: `npm test` green, `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- Augment the **`community-plugins`** switch list only (core plugins are never desktop-only). Only the runtime map is augmented — `settings.switchExceptions` persistence and the Settings UI stay manual-only.
- Independent version cut when done.

---

### Task 1: `desktopOnlyPluginIds` pure detector

**Files:**
- Modify: `src/core/availability.ts` (add exported function; `StoreLock` already imported)
- Test: `tests/availability.test.ts`

**Interfaces:**
- Produces: `desktopOnlyPluginIds(lock: StoreLock | null): Set<string>` — plugin ids (group name minus the `plugin-` prefix) the lock marks `desktopOnly: true`.

- [ ] **Step 1: Write the failing test.** Add to `tests/availability.test.ts` (the `lock` helper and `StoreLock` are already available in this file; add `desktopOnlyPluginIds` to the import from `"../src/core/availability"`):

```ts
describe("desktopOnlyPluginIds", () => {
  it("collects plugin ids the lock marks desktop-only, ignoring non-plugin and unflagged entries", () => {
    const ids = desktopOnlyPluginIds(
      lock({
        "plugin-media-extended": { sourcePluginVersion: "1.0.0", desktopOnly: true },
        "plugin-dataview": { sourcePluginVersion: "1.0.0" }, // no flag
        hotkeys: { sourceAppVersion: "1.0.0" }, // app-anchored, not plugin-prefixed
      })
    );
    expect([...ids].sort()).toEqual(["media-extended"]);
  });
  it("returns an empty set for a null lock", () => {
    expect(desktopOnlyPluginIds(null).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/availability.test.ts -t "desktopOnlyPluginIds"` — Expected: FAIL ("desktopOnlyPluginIds is not a function").

- [ ] **Step 3: Implement.** In `src/core/availability.ts`, add at the end:

```ts
// Plugin ids the store records as desktop-only (from the lock's per-group flags). The lock is the
// source that also works on a phone, where the plugin isn't installed and its manifest can't be
// read — used to auto-except them from the enabled-plugins switch list so a phone doesn't drop them.
export function desktopOnlyPluginIds(lock: StoreLock | null): Set<string> {
  const ids = new Set<string>();
  if (lock === null) return ids;
  for (const [name, entry] of Object.entries(lock.groups)) {
    if (entry.desktopOnly === true && name.startsWith("plugin-")) ids.add(name.slice("plugin-".length));
  }
  return ids;
}
```

- [ ] **Step 4: Run tests.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/availability.test.ts` — Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/core/availability.ts tests/availability.test.ts && git commit -m "feat: add desktopOnlyPluginIds lock reader"
```

---

### Task 2: Fold the ids into the runtime switch exceptions

**Files:**
- Modify: `src/main.ts` (add `augmentedSwitchExceptions`; wire `coreContext`, `diffPair`, `switchDivergenceFor`; add import)

**Interfaces:**
- Consumes: `desktopOnlyPluginIds` (Task 1), `parseStoreLock` (already imported in main.ts), `StoreLock` (already imported).
- Produces: `private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>>`.

- [ ] **Step 1: Import the detector.** In `src/main.ts`, add `desktopOnlyPluginIds` to the existing import from `"./core/availability"` (the one that already brings in `availabilityForGroup`, `desktopOnlyDrift`).

- [ ] **Step 2: Add the helper.** In `src/main.ts`, add a private method (place it next to `coreContext`):

```ts
// The switch exceptions used at RUNTIME = the user's manual excepts plus every plugin the store
// records as desktop-only, folded into the community-plugins list. A phone can't enable a
// desktop-only plugin, so excepting it stops capture from dropping it from the store's enabled
// list (and apply from force-adding it). settings.switchExceptions (persisted) is left untouched.
private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>> {
  const io = this.configIO();
  const lockPath = `${rootPath}/store.lock.json`;
  let lock: StoreLock | null = null;
  if (await io.exists(lockPath)) {
    try { lock = parseStoreLock(await io.read(lockPath)); } catch { lock = null; }
  }
  const dtoIds = desktopOnlyPluginIds(lock);
  if (dtoIds.size === 0) return this.settings.switchExceptions;
  const manual = this.settings.switchExceptions["community-plugins"] ?? [];
  return { ...this.settings.switchExceptions, "community-plugins": [...new Set([...manual, ...dtoIds])] };
}
```

- [ ] **Step 3: Use it in `coreContext`.** In `coreContext()`, after `this.lastResolvedRoot = rootPath;` (rootPath is already resolved above), compute the map and use it in the return. Change the return field:

```ts
// before the return object:
    const switchExceptions = await this.augmentedSwitchExceptions(rootPath);
```
and change `switchExceptions: this.settings.switchExceptions,` (in the returned object) to:
```ts
      switchExceptions,
```

- [ ] **Step 4: Use it in `diffPair`.** In `diffPair`, it already resolves the store path via `await this.resolvedRootPath()`. Capture that once and reuse it for the exceptions. Replace:

```ts
          const storeBase = `${await this.resolvedRootPath()}/store/${groupStorePath(group.path)}`;
```
with:
```ts
          const rootPath = await this.resolvedRootPath();
          const storeBase = `${rootPath}/store/${groupStorePath(group.path)}`;
```
and replace:
```ts
          const exc = SWITCH_LIST_GROUPS.has(name) ? (this.settings.switchExceptions[name] ?? []) : [];
```
with:
```ts
          const exc = SWITCH_LIST_GROUPS.has(name) ? ((await this.augmentedSwitchExceptions(rootPath))[name] ?? []) : [];
```

- [ ] **Step 5: Use the augmented map in `switchDivergenceFor`.** It already builds `const ctx = await this.coreContext();` (whose `switchExceptions` is now augmented). Change its exceptions source from `this.settings.switchExceptions[name]` to the ctx map. Replace:

```ts
          return switchDivergence(local, stored, this.settings.switchExceptions[name] ?? []);
```
with:
```ts
          return switchDivergence(local, stored, ctx.switchExceptions[name] ?? []);
```

Leave `switchLocalDecisions` (the sync getter of the user's manual excepts) and `addSwitchExceptions` (writes manual excepts) reading `this.settings.switchExceptions` — those are the manual-exception surfaces and must stay manual-only.

- [ ] **Step 6: Gates.** Run and confirm:
  - `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` → clean
  - `cd ~/local/coding/open/obsidian-config-sync && npm test` → all pass
  - `cd ~/local/coding/open/obsidian-config-sync && npx eslint .` → 0 errors / 67 warnings
  - `cd ~/local/coding/open/obsidian-config-sync && ./scripts/check-no-hardcoded-color.sh` → OK
  - `cd ~/local/coding/open/obsidian-config-sync && npm run build` → clean

- [ ] **Step 7: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/main.ts && git commit -m "feat: auto-except desktop-only plugins from the enabled-plugins switch-list"
```

---

### Task 3: Live verification (dev vault)

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`; reload the plugin (obsidian-cli disable/enable).
- [ ] **Step 2: Forge the footgun.** In the dev-vault store lock, ensure an installed desktop-only plugin (e.g. `plugin-media-extended`) has `desktopOnly: true` (backfill via a capture, or forge the lock). Confirm that plugin's id is in the store's `community-plugins.json` but simulate its absence locally (or read `community-plugins` status).
- [ ] **Step 3: Verify.** Via `obsidian-cli eval`, call the host's `switchDivergenceFor("community-plugins")` / read the `community-plugins` group status and confirm the desktop-only id is treated as excepted — no `to-capture`, and `diffPair("community-plugins", "", "capture")` does not mark it removed. Restore any forged lock afterward.

---

## Self-Review

**Spec coverage:** `desktopOnlyPluginIds` → Task 1. Fold into runtime exceptions (coreContext + diffPair) → Task 2 Steps 3-4. The spec named coreContext + diffPair; this plan also covers `switchDivergenceFor` (Step 5) — same "runtime consumer of exceptions" category, gets the augmentation via ctx — and explicitly leaves `switchLocalDecisions`/`addSwitchExceptions` manual, matching the spec's "manual excludes still shown/editable." Testing → Tasks 1 & 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. ✓

**Type consistency:** `desktopOnlyPluginIds(lock): Set<string>` (Task 1) → spread into `string[]` for the `community-plugins` map (Task 2 Step 2). `augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>>` returned/consumed consistently in coreContext (Step 3) and diffPair (Step 4). `ctx.switchExceptions` is `Record<string, string[]>` (CoreContext), read in Step 5. Consistent. ✓
