# Remote Lock Convergence + Matched-List Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote "newer version info" hint convergeable (v2-aware remote registry, two-sided lock adoption, capture carry-forward) and stop the matched list from naming the excluded self item.

**Architecture:** Three legs on the existing pull/capture engine: (1) `remoteGroupsFrom` learns schema v2 self copies via an injected `CoreContext.storeListGroups` hook (plugin wires `storeSelfCopyGroups` + its registry defs); (2) `applyImport`'s identical-file lock attribution goes two-sided via `merge.ts`'s `owningGroupName`; (3) `capture()`'s lock rebuild carries forward entries outside the compiled registry. Plus a one-line UI filter fix.

**Tech Stack:** TypeScript, esbuild, vitest (Node), Obsidian plugin API.

**Spec:** docs/superpowers/specs/2026-07-30-remote-lock-convergence-and-matched-list-design.md

## Global Constraints

- **NO COMMITS.** The working tree is the review state; one commit happens at cut time by the controller. Never run `git commit`.
- No Claude/AI attribution anywhere.
- No new user-facing copy; no UI changes beyond Task 3's matched-list filter. Code, comments, identifiers in English.
- No default parameter values in new code — `remoteGroupsFrom`'s new `ctx` param is required; `storeListGroups` is an optional interface field (absent = no v2 compile), matching the `fieldOverlay` precedent.
- Gates for every task: `npm test` green, `npm run build` green, `npm run lint` — 0 errors, warnings at the 57 baseline.
- Baseline before this plan: 809 tests, build green, lint 0/57.

---

### Task 1: v2-aware remote registry (`storeListGroups` hook)

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (CoreContext interface :35-47; `remoteGroupsFrom` :771-782; `planImport` call site :793)
- Modify: `src/core/status.ts` (`diffRemote` call site :254)
- Modify: `src/main.ts` (`coreContext()` :1141-1172)
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `storeSelfCopyGroups(json, defs)` from `src/core/leftover.ts` (exists, unchanged).
- Produces: `CoreContext.storeListGroups?: (selfCopyJson: string) => SyncGroup[]`; `remoteGroupsFrom(ctx: CoreContext, reader: ExternalStoreReader, files: string[])` — Task 2's test relies on the hook populating `pending.remoteGroups`.

- [ ] **Step 1: Add the hook to `CoreContext`** (`src/core/ConfigSyncCore.ts`), after the `fieldOverlay` field:

```ts
  // Compiles a self store copy's sync list. Schema v2 copies persist items+customGroups (no
  // compiled groups array), and only the plugin holds the registry defs needed to compile them
  // (leftover.ts's storeSelfCopyGroups) — absent in bare test contexts, where v2 copies yield [].
  storeListGroups?: (selfCopyJson: string) => SyncGroup[];
```

- [ ] **Step 2: Teach `remoteGroupsFrom` schema v2.** Replace the whole function (v1 and legacy branches byte-identical, plus the hook branch):

```ts
export async function remoteGroupsFrom(ctx: CoreContext, reader: ExternalStoreReader, files: string[]): Promise<SyncGroup[]> {
  if (files.includes(SELF_STORE_DATA_REL)) {
    const raw = await reader.readFile(SELF_STORE_DATA_REL);
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && Array.isArray(parsed.groups)) {
      return validateSyncManifest({ version: 1, groups: parsed.groups }).groups;
    }
    if (ctx.storeListGroups !== undefined) return ctx.storeListGroups(raw); // schema v2: items + customGroups
  }
  if (files.includes(LEGACY_MANIFEST_REL)) {
    return parseSyncManifest(await reader.readFile(LEGACY_MANIFEST_REL)).groups; // compat, deprecated format
  }
  return [];
}
```

- [ ] **Step 3: Update the two call sites.**
  - `src/core/ConfigSyncCore.ts:793` → `const remoteGroups = await remoteGroupsFrom(ctx, reader, files);`
  - `src/core/status.ts:254` → `const remoteGroups = await remoteGroupsFrom(ctx, reader, remoteFiles);`

- [ ] **Step 4: Wire the plugin side.** In `src/main.ts` `coreContext()`'s returned object, after the `groupsIO` block:

```ts
      // Schema v2 self copies carry items+customGroups, not a compiled groups array — core needs
      // the plugin's registry defs to compile them (storeSelfCopyGroups' contract).
      storeListGroups: (json) => storeSelfCopyGroups(json, this.registryDefs),
```

(`storeSelfCopyGroups` is already imported in main.ts; `this.registryDefs` exists.)

- [ ] **Step 5: Write the failing test** in `tests/core.test.ts` (add `remoteGroupsFrom` to the existing `../src/core/ConfigSyncCore` import). Place it after the `planImport / applyImport` describe block:

```ts
describe("remoteGroupsFrom (schema v2 self copy)", () => {
  const DEMO_GROUP: SyncGroup = { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" };
  const v2SelfCopy = JSON.stringify({ schemaVersion: 2, items: { "community:demo": { enabled: true } }, customGroups: [] });
  const files = { "store/configdir/plugins/config-sync/data.json": v2SelfCopy };

  it("compiles a v2 self copy through ctx.storeListGroups", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {}, storeListGroups: (json) => (json === v2SelfCopy ? [DEMO_GROUP] : []) };
    expect(await remoteGroupsFrom(ctx, fakeReader(files), Object.keys(files))).toEqual([DEMO_GROUP]);
  });

  it("yields [] for a v2 self copy when the hook is absent (bare context)", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {} };
    expect(await remoteGroupsFrom(ctx, fakeReader(files), Object.keys(files))).toEqual([]);
  });
});
```

If the test file's helpers (`MemFS`, `FakePlugins`, `memGroupsIO`, `fakeReader`) sit below the insertion point, place the describe after them — match the file's existing ordering.

- [ ] **Step 6: Run the new tests, expect FAIL before Steps 1-4 are in, PASS after.** `npx vitest run tests/core.test.ts -t "remoteGroupsFrom"`

- [ ] **Step 7: Full gates.** `npm test` (existing suites must be untouched — no test currently calls `remoteGroupsFrom` directly), `npm run build`, `npm run lint`. Report results. Do NOT commit.

---

### Task 2: two-sided lock adoption + capture carry-forward

**Files:**
- Modify: `src/core/merge.ts` (:25 — export `owningGroupName`)
- Modify: `src/core/ConfigSyncCore.ts` (import :6; `applyImport` identical attribution :870-876; `capture()` lock write :310-312)
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `owningGroupName(localGroups, remoteGroups, rel)` (newly exported); `pending.remoteGroups` populated via Task 1's hook.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Export `owningGroupName`** in `src/core/merge.ts:25` — change `function owningGroupName(` to `export function owningGroupName(`.

- [ ] **Step 2: Two-sided identical attribution.** In `src/core/ConfigSyncCore.ts`:
  - extend the merge import (:6): `import { classifyMerge, MergeConflict, MergePlan, owningGroupName } from "./merge";`
  - in `applyImport`, replace the `file:` branch of the identical loop (currently `const { name } = groupForStoreRel(groups, id.slice("file:".length)); if (name !== "") remoteWonNames.add(name);`) with:

```ts
      if (id.startsWith("file:")) {
        const name = owningGroupName(groups, remoteGroups, id.slice("file:".length));
        if (name !== "") remoteWonNames.add(name);
      }
```

The surrounding comment block ("Content-identical groups follow the remote's capture lineage…") stays; append one sentence to it: `// Attribution is two-sided (local first, then the remote contract): store content outside the local registry must still carry its lock entry across, or remoteLockAhead reports it forever.`

- [ ] **Step 3: Capture carry-forward.** In `capture()` (`src/core/ConfigSyncCore.ts`), between the end of the group loop (:310 `}`) and `await ensureParentDir(...)` (:311), insert:

```ts
  // The store legitimately holds content outside this vault's registry (additive pulls never
  // delete, and no local flow prunes another contract's files). Its lock entries describe that
  // content — dropping them here would resurrect the remote "newer version info" hint after
  // every capture. Registry names always win: their entries were just written or deliberately
  // dropped (e.g. plugin uninstalled) by the loop above.
  const registryNames = new Set(manifest.groups.map((g) => g.name));
  for (const [name, entry] of Object.entries(previous?.groups ?? {})) {
    if (!registryNames.has(name)) lock.groups[name] = entry;
  }
```

(Note the guard is registry membership, NOT `name in lock.groups` — a registry group whose plugin is uninstalled deliberately has no entry, and carry-forward must not resurrect it.)

- [ ] **Step 4: Write the failing tests** in `tests/core.test.ts` (inside or after the `planImport / applyImport` describe; add `import { remoteLockAhead } from "../src/core/status";` if not already imported):

```ts
  it("pull adopts the remote lock entry for an identical store file whose group exists only in the remote contract", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const FOREIGN: SyncGroup = { name: "plugin-foreign", path: "{configDir}/plugins/foreign/data.json", type: "file", devices: "all" };
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T00:00:00.000Z", switchExceptions: {}, storeListGroups: () => [FOREIGN] };
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    const remoteLock = JSON.stringify({ capturedAt: "2026-07-30T09:00:00.000Z", groups: { hotkeys: { sourceAppVersion: "1.6.0" }, "plugin-foreign": { sourcePluginVersion: "0.5.25" } } }, null, 2) + "\n";
    io.seed({
      "cs/store/configdir/hotkeys.json": '{"a":1}',
      "cs/store/configdir/plugins/foreign/data.json": '{"x":1}',
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T08:00:00.000Z", groups: { hotkeys: { sourceAppVersion: "1.6.0" } } }, null, 2) + "\n",
    });
    const remote = {
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/plugins/foreign/data.json": '{"x":1}',
      "store/configdir/plugins/config-sync/data.json": JSON.stringify({ schemaVersion: 2, items: { "community:foreign": { enabled: true } } }),
      "store.lock.json": remoteLock,
    };
    const pending = await planImport(ctx, fakeReader(remote), { excludeSelf: false });
    expect(pending.plan.conflicts.filter((c) => c.kind === "file")).toEqual([]);
    await applyImport(ctx, pending, []);
    const mergedRaw = await io.read("cs/store.lock.json");
    const merged = JSON.parse(mergedRaw) as { capturedAt: string; groups: Record<string, unknown> };
    expect(merged.groups["plugin-foreign"]).toEqual({ sourcePluginVersion: "0.5.25" }); // adopted across
    expect(remoteLockAhead(mergedRaw, remoteLock, [])).toBe(false); // the hint clears
  });

  it("capture carries forward lock entries for groups outside the compiled registry", async () => {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = { io, configDir: ".obs", rootPath: "cs", plugins, passphrase: null, deviceClass: "desktop", groupsIO: memGroupsIO(), now: () => "2026-07-30T12:00:00.000Z", switchExceptions: {} };
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({
      ".obs/hotkeys.json": '{"a":1}',
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-30T09:00:00.000Z", groups: { hotkeys: { sourceAppVersion: "0.0.9" }, "plugin-foreign": { sourcePluginVersion: "0.5.25" } } }, null, 2) + "\n",
    });
    await capture(ctx);
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, Record<string, unknown>> };
    expect(lock.groups["plugin-foreign"]).toEqual({ sourcePluginVersion: "0.5.25" }); // carried forward
    expect(lock.groups["hotkeys"]).toEqual({ sourceAppVersion: plugins.getAppVersion() }); // fresh registry entry wins over 0.0.9
  });
```

Adjust only mechanical fit (helper names, `SyncGroup` import, `kind` narrowing) to the file's existing idioms — the seeded paths, lock JSON, and assertions are the spec.

- [ ] **Step 5: Run the new tests** — `npx vitest run tests/core.test.ts -t "foreign"` (both must FAIL before Steps 1-3, PASS after) and `-t "adopts the remote lock entry"`.

- [ ] **Step 6: Full gates.** `npm test`, `npm run build`, `npm run lint`. Report results. Do NOT commit.

---

### Task 3: matched-list filter + ARCHITECTURE notes

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (:2247-2249)
- Modify: `docs/ARCHITECTURE.md` (Capture flow bullet :33-35; status.ts `remoteLockAhead` sentence :124-126; add a lock-adoption sentence near the ConfigSyncCore bullet :46-54)

**Interfaces:**
- Consumes: `SELF_GROUP_NAME` (already imported in SyncCenterView.ts:4); `remote.excludeSelf` (in scope in `renderRemoteDetail`).
- Produces: none.

- [ ] **Step 1: Filter the matched list.** In `renderRemoteDetail`, replace:

```ts
    const matchNames = this.groups
      .filter((g) => !changedNames.has(g.name))
      .map((g) => this.fullName(g.name, g.label));
```

with:

```ts
    const matchNames = this.groups
      // The excluded self item was never compared — it is neither changed nor matched, and
      // listing it two lines above the "stays out of this remote" note would contradict it.
      .filter((g) => !changedNames.has(g.name) && !(remote.excludeSelf === true && g.name === SELF_GROUP_NAME))
      .map((g) => this.fullName(g.name, g.label));
```

- [ ] **Step 2: ARCHITECTURE.md — capture bullet.** Extend the Capture flow bullet (:33-35) so it ends: `…and stamps source versions into \`store.lock.json\` — carrying forward lock entries for groups outside this vault's compiled registry, whose store content only pulls (not local flows) manage.`

- [ ] **Step 3: ARCHITECTURE.md — lock adoption + v2 remote list.** In the `core/ConfigSyncCore.ts` module bullet (after the excludeSelf sentences, around :54), add: `\`remoteGroupsFrom(ctx, reader, files)\` resolves the remote's sync list from its self store copy — schema v1 copies carry a compiled \`groups\` array; v2 copies (items + customGroups) compile through the injected \`CoreContext.storeListGroups\` hook (main.ts wires \`storeSelfCopyGroups\` with the plugin's registry defs). \`applyImport\`'s lock merge attributes identical files two-sidedly (\`owningGroupName\`), so store content outside the local registry still carries its lock entry across on pull.`

- [ ] **Step 4: Gates.** `npm test`, `npm run build`, `npm run lint`. Report results. Do NOT commit.

---

## Verification after all tasks

- Full suite: 809 + 4 new = 813 expected.
- Real-vault smoke (controller/user, post-cut or via dev build): one Pull clears the "newer version info" hint; a subsequent Capture does not resurrect it; the matched list no longer names Config Sync while the exclusion is on.
