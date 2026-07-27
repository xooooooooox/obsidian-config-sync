# Direction Baseline & Cold-Start Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mtime/`capturedAt` direction heuristic with a device-local baseline ledger (localStorage), add the `never-synced` state + cold-start banner, and ship two ride-along fixes (carrier-group categories, JSON sorted diff view).

**Architecture:** New pure module `src/core/ledger.ts` holds ledger types, hashing, and canonicalization. `src/core/status.ts` computes direction from baselines and emits reseed updates; `src/main.ts` owns localStorage persistence. UI consumers (`panelModel`, `selfPane`, `SyncCenterView`) learn the new state and render the banner. Spec: `docs/superpowers/specs/2026-07-27-direction-baseline-design.md`.

**Tech Stack:** TypeScript (strict), Obsidian plugin API (`app.saveLocalStorage`/`loadLocalStorage`), `crypto.subtle` SHA-256, vitest.

## Global Constraints

- **No git commits.** The repo owner commits at "cut" time; every task leaves its changes uncommitted. Never add Claude/AI attribution anywhere.
- All 758+ existing tests stay green: `npx vitest run` — 0 failures.
- eslint baseline: `npm run lint` — **0 errors, ≤64 warnings** (do not add warnings).
- `npm run build` must pass after code tasks.
- Strict typing: no `any`; validate external data at load (`parseLedger` takes `unknown`).
- localStorage keys (exact): `config-sync-baselines`, `config-sync-coldstart-dismissed`.
- New GroupState string (exact): `never-synced`.
- Banner copy (exact): headline `This device hasn't synced with the store yet.` body `Adopt the plugin settings first — they carry the scopes and device rules that make the diffs below trustworthy — then review and apply.` button `Review settings →`.
- Row copy (exact): never-synced tip `not synced on this device yet — apply takes the store's settings`; differs tip `changed on both sides since this device last synced — review the diff`.
- `remoteDirectionCounts` / `checkRemote` / `remoteLockAhead` in status.ts must NOT change.
- `main.ts` wiring is verified by dev-vault smoke, not unit tests (repo test strategy).

---

### Task 1: `src/core/ledger.ts` — ledger types, hashing, canonicalization

**Files:**
- Create: `src/core/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `parseSwitchList`, `readLocalSwitchList`, `SWITCH_LIST_GROUPS` from `src/core/switchList.ts`.
- Produces (used by Tasks 2/4):
  - `interface BaselineEntry { store: string; local: string; at: string }`
  - `interface Ledger { version: 1; groups: Record<string, BaselineEntry> }`
  - `type LedgerUpdates = Record<string, BaselineEntry | null>` (null = drop entry)
  - `const ABSENT_HASH = "absent"`
  - `emptyLedger(): Ledger`, `parseLedger(raw: unknown): Ledger`
  - `applyUpdates(ledger: Ledger, updates: LedgerUpdates): Ledger` (pure)
  - `pruneLedger(ledger: Ledger, keep: ReadonlySet<string>): Ledger` (pure)
  - `sha256Hex(text: string): Promise<string>`
  - `hashFileSide(groupName: string, content: string | null, side: "local" | "store"): Promise<string>`
  - `hashDirSide(files: { rel: string; content: string }[]): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `tests/ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ABSENT_HASH, applyUpdates, emptyLedger, hashDirSide, hashFileSide,
  Ledger, parseLedger, pruneLedger, sha256Hex,
} from "../src/core/ledger";

const ENTRY = { store: "s1", local: "l1", at: "2026-07-27T00:00:00.000Z" };

describe("parseLedger", () => {
  it("returns empty on null/garbage/wrong version", () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger("not json")).toEqual(emptyLedger());
    expect(parseLedger(JSON.stringify({ version: 2, groups: {} }))).toEqual(emptyLedger());
  });
  it("round-trips a valid ledger from its JSON string and drops malformed entries", () => {
    const raw = JSON.stringify({ version: 1, groups: { a: ENTRY, bad: { store: 5 } } });
    expect(parseLedger(raw)).toEqual({ version: 1, groups: { a: ENTRY } });
  });
});

describe("applyUpdates / pruneLedger", () => {
  it("adds, replaces, and drops entries without mutating the input", () => {
    const base: Ledger = { version: 1, groups: { a: ENTRY } };
    const next = applyUpdates(base, { b: ENTRY, a: null });
    expect(next.groups).toEqual({ b: ENTRY });
    expect(base.groups).toEqual({ a: ENTRY }); // pure
  });
  it("prunes entries not in keep", () => {
    const base: Ledger = { version: 1, groups: { a: ENTRY, b: ENTRY } };
    expect(pruneLedger(base, new Set(["a"])).groups).toEqual({ a: ENTRY });
  });
});

describe("hashing", () => {
  it("sha256Hex is deterministic and hex-shaped", async () => {
    const h = await sha256Hex("x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("x")).toBe(h);
  });
  it("hashFileSide: absent content hashes to the sentinel", async () => {
    expect(await hashFileSide("hotkeys", null, "local")).toBe(ABSENT_HASH);
  });
  it("hashFileSide: switch lists hash the set, not the bytes", async () => {
    const a = await hashFileSide("community-plugins", '["b","a"]', "store");
    const b = await hashFileSide("community-plugins", '["a", "b"]\n', "store");
    expect(a).toBe(b);
    const c = await hashFileSide("community-plugins", '["a","c"]', "store");
    expect(c).not.toBe(a);
  });
  it("hashFileSide: enabled-css-snippets local side reads the appearance.json field", async () => {
    const a = await hashFileSide("enabled-css-snippets", '{"enabledCssSnippets":["y","x"],"theme":"T"}', "local");
    const b = await hashFileSide("enabled-css-snippets", '["x","y"]', "store");
    expect(a).toBe(b); // same set → same canonical hash, regardless of carrier shape
  });
  it("hashFileSide: unparseable switch list falls back to raw bytes", async () => {
    const a = await hashFileSide("community-plugins", "not json", "store");
    expect(a).toBe(await sha256Hex("not json"));
  });
  it("hashDirSide: order-insensitive over rel, content-sensitive", async () => {
    const a = await hashDirSide([{ rel: "b.css", content: "B" }, { rel: "a.css", content: "A" }]);
    const b = await hashDirSide([{ rel: "a.css", content: "A" }, { rel: "b.css", content: "B" }]);
    expect(a).toBe(b);
    const c = await hashDirSide([{ rel: "a.css", content: "A2" }, { rel: "b.css", content: "B" }]);
    expect(c).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL — cannot resolve `../src/core/ledger`.

- [ ] **Step 3: Implement `src/core/ledger.ts`**

```ts
/**
 * Device-local sync baselines (spec 2026-07-27 direction-baseline).
 * Each entry records the canonical hash of a group's store and local content as of the last
 * moment THIS device saw the group in sync. Direction for a differing group is then a
 * three-way comparison against this baseline instead of an mtime guess.
 * Persistence lives in main.ts (app.saveLocalStorage — per-vault, per-device, invisible to
 * vault-wide file sync); this module is pure except for crypto.subtle.
 */
import { parseSwitchList, readLocalSwitchList, SWITCH_LIST_GROUPS, SwitchList } from "./switchList";

export interface BaselineEntry {
  store: string;
  local: string;
  at: string;
}

export interface Ledger {
  version: 1;
  groups: Record<string, BaselineEntry>;
}

/** null = drop the entry (group left the config or lost its settings). */
export type LedgerUpdates = Record<string, BaselineEntry | null>;

/** Hash sentinel for a side that has no content at all (file missing). */
export const ABSENT_HASH = "absent";

export function emptyLedger(): Ledger {
  return { version: 1, groups: {} };
}

function validEntry(v: unknown): v is BaselineEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.store === "string" && typeof e.local === "string" && typeof e.at === "string";
}

/** Accepts the raw localStorage value (JSON string or anything else); malformed → empty. */
export function parseLedger(raw: unknown): Ledger {
  if (typeof raw !== "string") return emptyLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLedger();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyLedger();
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.groups !== "object" || obj.groups === null) return emptyLedger();
  const groups: Record<string, BaselineEntry> = {};
  for (const [name, entry] of Object.entries(obj.groups as Record<string, unknown>)) {
    if (validEntry(entry)) groups[name] = entry;
  }
  return { version: 1, groups };
}

export function applyUpdates(ledger: Ledger, updates: LedgerUpdates): Ledger {
  const groups = { ...ledger.groups };
  for (const [name, entry] of Object.entries(updates)) {
    if (entry === null) delete groups[name];
    else groups[name] = entry;
  }
  return { version: 1, groups };
}

export function pruneLedger(ledger: Ledger, keep: ReadonlySet<string>): Ledger {
  const groups: Record<string, BaselineEntry> = {};
  for (const [name, entry] of Object.entries(ledger.groups)) {
    if (keep.has(name)) groups[name] = entry;
  }
  return { version: 1, groups };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalSwitchList(list: SwitchList): string {
  if (Array.isArray(list)) return JSON.stringify([...list].sort());
  const sorted: Record<string, boolean> = {};
  for (const k of Object.keys(list).sort()) sorted[k] = list[k] ?? false;
  return JSON.stringify(sorted);
}

/**
 * Canonical hash of one side of a file group. Switch lists hash their SET form (enable-order
 * churn must not read as movement); everything else hashes raw bytes. `null` content = the
 * file does not exist on that side.
 */
export async function hashFileSide(groupName: string, content: string | null, side: "local" | "store"): Promise<string> {
  if (content === null) return ABSENT_HASH;
  if (SWITCH_LIST_GROUPS.has(groupName)) {
    const parsed = side === "local" ? readLocalSwitchList(groupName, content) : parseSwitchList(content);
    if (parsed !== null) return sha256Hex(canonicalSwitchList(parsed));
  }
  return sha256Hex(content);
}

/** Canonical hash of one side of a dir group: sorted `rel\n sha256(content)` manifest. */
export async function hashDirSide(files: { rel: string; content: string }[]): Promise<string> {
  const lines = await Promise.all(files.map(async (f) => `${f.rel}\n${await sha256Hex(f.content)}`));
  return sha256Hex([...lines].sort().join("\n"));
}
```

Note: if `SwitchList` is not exported from `src/core/switchList.ts` (it is — `export type SwitchList = string[] | Record<string, boolean>`), import it as shown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Full-suite + lint sanity**

Run: `npx vitest run && npm run lint`
Expected: all tests pass; 0 errors, ≤64 warnings. Leave changes uncommitted.

---

### Task 2: `src/core/status.ts` — baseline-driven direction, `never-synced`, reseed emission

**Files:**
- Modify: `src/core/status.ts` (GroupState :10, statusForGroups :21-42, groupStatus :44-62, compareFile :64-91, compareDir :102-133, bucketCounts :142-154)
- Test: `tests/status.test.ts` (direction tests rework), `tests/core.test.ts` (5 call sites :1371-1516)

**Interfaces:**
- Consumes (Task 1): `Ledger`, `LedgerUpdates`, `BaselineEntry`, `ABSENT_HASH`, `hashFileSide`, `hashDirSide` from `./ledger`.
- Produces (used by Tasks 3/4/5):
  - `GroupState` union gains `"never-synced"`.
  - `statusForGroups(ctx: CoreContext, groups: SyncGroup[], ledger: Ledger): Promise<{ statuses: GroupStatus[]; updates: LedgerUpdates }>`
  - `bucketCounts`: `never-synced` counts into `down`.
  - Deleted: the mtime stat loop, the lock `capturedAt` read, and `liveFiles` on the internal `Comparison` type. `checkRemote`/`remoteLockAhead`/`remoteDirectionCounts` untouched.

- [ ] **Step 1: Rework the direction tests in `tests/status.test.ts`**

Update the import and `allStates` helper (statuses now come wrapped):

```ts
import { statusForGroups, checkRemote, diffRemote, bucketCounts, remoteLockAhead, remoteDirectionCounts, GroupStatus } from "../src/core/status";
import { applyUpdates, emptyLedger, Ledger } from "../src/core/ledger";
```

```ts
async function statusAndUpdates(ctx: CoreContext, ledger: Ledger = emptyLedger()) {
  const manifest = await loadManifest(ctx);
  return statusForGroups(ctx, groupsForDevice(manifest, "desktop"), ledger);
}

async function allStates(ctx: CoreContext, ledger: Ledger = emptyLedger()): Promise<Record<string, string>> {
  const { statuses } = await statusAndUpdates(ctx, ledger);
  return Object.fromEntries(statuses.map((s) => [s.group, s.state]));
}
```

Add a helper that produces a seeded ledger the way production does — run one pass on an in-sync vault and apply its reseed updates:

```ts
async function seededLedger(ctx: CoreContext): Promise<Ledger> {
  const { updates } = await statusAndUpdates(ctx);
  return applyUpdates(emptyLedger(), updates);
}
```

Replace the three mtime-era direction tests (`reports local-changed when a live file is newer than capturedAt`, `reports store-newer when content differs but live mtimes predate capturedAt`, `reports differs (no direction) when there is no lock`) with:

```ts
it("in-sync groups emit reseed updates; no-settings/not-captured emit drops", async () => {
  const { ctx } = await seededAndCaptured();
  const { statuses, updates } = await statusAndUpdates(ctx);
  expect(statuses.every((s) => s.state === "in-sync")).toBe(true);
  expect(Object.keys(updates).sort()).toEqual(["hotkeys", "plugin-demo", "snippets"]);
  expect(updates["hotkeys"]).not.toBeNull();
});

it("reports local-changed when only the local side moved off the baseline", async () => {
  const { io, ctx } = await seededAndCaptured();
  const ledger = await seededLedger(ctx);
  await io.write(".obs/hotkeys.json", '{"a":2}');
  expect((await allStates(ctx, ledger))["hotkeys"]).toBe("local-changed");
});

it("reports store-newer when only the store side moved off the baseline", async () => {
  const { io, ctx } = await seededAndCaptured();
  const ledger = await seededLedger(ctx);
  await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');
  expect((await allStates(ctx, ledger))["hotkeys"]).toBe("store-newer");
});

it("reports differs when both sides moved off the baseline", async () => {
  const { io, ctx } = await seededAndCaptured();
  const ledger = await seededLedger(ctx);
  await io.write(".obs/hotkeys.json", '{"a":2}');
  await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');
  expect((await allStates(ctx, ledger))["hotkeys"]).toBe("differs");
});

it("reports never-synced for a differing group with no baseline entry", async () => {
  const { io, ctx } = await seededAndCaptured();
  await io.write(".obs/hotkeys.json", '{"a":2}');
  expect((await allStates(ctx))["hotkeys"]).toBe("never-synced"); // empty ledger
});

it("dir groups get directions from baselines too, including added/deleted files", async () => {
  const { io, ctx } = await seededAndCaptured();
  const ledger = await seededLedger(ctx);
  await io.write(".obs/snippets/two.css", "two"); // local added a file
  expect((await allStates(ctx, ledger))["snippets"]).toBe("local-changed");
});

it("switch-list enable-order churn does not read as local movement", async () => {
  const { io, ctx } = setup();
  const SWITCH_MANIFEST = JSON.stringify({
    version: 1,
    groups: [{ name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" }],
  });
  io.seed({ ".obs/community-plugins.json": '["a","b"]' });
  await writeGroups(ctx, parseSyncManifest(SWITCH_MANIFEST).groups);
  await capture(ctx);
  const manifest = await loadManifest(ctx);
  const groups = groupsForDevice(manifest, "desktop");
  const first = await statusForGroups(ctx, groups, emptyLedger());
  const ledger = applyUpdates(emptyLedger(), first.updates);
  await io.write(".obs/community-plugins.json", '["b","a"]'); // reorder only, same set
  await io.write("cs/store/configdir/community-plugins.json", '["a","b","c"]\n'); // store gained "c"
  const { statuses } = await statusForGroups(ctx, groups, ledger);
  expect(statuses.find((s) => s.group === "community-plugins")?.state).toBe("store-newer");
});
```

Keep every other existing test, updating only its `statusForGroups(...)`/`allStates(...)` call shape (destructure `{ statuses }`, pass `emptyLedger()`). The existing `io.touch(...)` calls in kept tests become inert and should be deleted where they only served direction. In `tests/core.test.ts`, update the 5 call sites (:1371, :1384, :1449, :1462, :1516) mechanically: `const { statuses } = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"), emptyLedger());` (import `emptyLedger` from `../src/core/ledger`) — those tests assert states that don't depend on direction, or use fresh stores where `never-synced` now appears; adjust expected states from `local-changed`/`store-newer`/`differs` to `never-synced` wherever the test runs with an empty ledger on a differing group.

Also update the `bucketCounts` test block in `tests/status.test.ts` (search `bucketCounts`): add an assertion that `never-synced` counts into `down`:

```ts
it("bucketCounts sends never-synced to the apply bucket", () => {
  const statuses: GroupStatus[] = [{ group: "a", state: "never-synced" }];
  expect(bucketCounts(statuses)).toEqual({ up: 0, down: 1, ok: 0, none: 0 });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL — `statusForGroups` signature mismatch / `never-synced` not a GroupState.

- [ ] **Step 3: Implement the status.ts rework**

Line 10:

```ts
export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured" | "never-synced" | "no-settings" | "locked";
```

Replace `statusForGroups` (:21-42) — the lock read and mtime logic go away:

```ts
export async function statusForGroups(
  ctx: CoreContext,
  groups: SyncGroup[],
  ledger: Ledger
): Promise<{ statuses: GroupStatus[]; updates: LedgerUpdates }> {
  const statuses: GroupStatus[] = [];
  const updates: LedgerUpdates = {};
  for (const group of groups) {
    try {
      const r = await groupStatus(ctx, group, ledger.groups[group.name]);
      statuses.push(r.status);
      if (r.update !== undefined) updates[group.name] = r.update;
    } catch (e) {
      statuses.push({ group: group.name, state: "differs", message: (e as Error).message });
    }
  }
  return { statuses, updates };
}
```

Replace `Comparison` (:19) and `groupStatus` (:44-62):

```ts
type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; localHash: string; storeHash: string };

// Direction is a three-way comparison against this device's last-synced baseline (spec
// 2026-07-27): no baseline → never-synced; one side moved → that side is the direction; both
// moved (or neither — a scope/rule change shifted the comparison lens) → differs. in-sync
// reseeds the baseline; not-captured/no-settings drop it; locked keeps it (a missing
// passphrase is temporary and must not degrade direction knowledge).
async function groupStatus(
  ctx: CoreContext,
  group: SyncGroup,
  baseline: BaselineEntry | undefined
): Promise<{ status: GroupStatus; update?: BaselineEntry | null }> {
  if (groupNeedsPassphrase(group) && ctx.passphrase === null) {
    return { status: { group: group.name, state: "locked" } };
  }
  const real = localRealPath(group.name, group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const cmp = group.type === "file" ? await compareFile(ctx, group, real, store) : await compareDir(ctx, group, real, store);
  if (cmp === "no-settings") return { status: { group: group.name, state: "no-settings" }, update: null };
  if (cmp === "not-captured") return { status: { group: group.name, state: "not-captured" }, update: null };
  if (!hasChanges(cmp.changes)) {
    return {
      status: { group: group.name, state: "in-sync" },
      update: { store: cmp.storeHash, local: cmp.localHash, at: ctx.now() },
    };
  }
  if (baseline === undefined) return { status: { group: group.name, state: "never-synced", changes: cmp.changes } };
  const storeMoved = cmp.storeHash !== baseline.store;
  const localMoved = cmp.localHash !== baseline.local;
  const state: GroupState =
    storeMoved && !localMoved ? "store-newer" : localMoved && !storeMoved ? "local-changed" : "differs";
  return { status: { group: group.name, state, changes: cmp.changes } };
}
```

`compareFile` (:64-91): read the store content first, hash both sides, drop `liveFiles`:

```ts
async function compareFile(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  if (!(await ctx.io.exists(store))) {
    return (await ctx.io.exists(real)) ? "not-captured" : "no-settings";
  }
  const name = basename(real);
  const storeContent = await ctx.io.read(store);
  const storeHash = await hashFileSide(group.name, storeContent, "store");
  if (!(await ctx.io.exists(real))) {
    return { changes: { added: [], updated: [], deleted: [name] }, localHash: ABSENT_HASH, storeHash };
  }
  const liveContent = await ctx.io.read(real);
  const localHash = await hashFileSide(group.name, liveContent, "local");
  const exc = SWITCH_LIST_GROUPS.has(group.name) ? ctx.switchExceptions[group.name] ?? [] : [];
  // Switch lists ALWAYS compare as sets — exceptions or not. The old `exc.length > 0` guard
  // made exception-free devices fall through to byte comparison, where local enable-order vs
  // store-stable order reads as a permanent phantom "To capture" (real-vault find 2026-07-17).
  const switchEqual =
    SWITCH_LIST_GROUPS.has(group.name) ? switchListEqualOrNull(group.name, liveContent, storeContent, exc) : null;
  const sidecar = store + sidecarStoreSuffix(ctx.deviceClass);
  const ownScope = (await ctx.io.exists(sidecar)) ? await ctx.io.read(sidecar) : null;
  const effGroup = overlayGroup(ctx, group, [liveContent, storeContent, ownScope]);
  const equal =
    switchEqual !== null
      ? switchEqual
      : parseFileEnvelope(storeContent) !== null || effGroup.mode === "fields" || effGroup.mode === "encrypted"
        ? await contentUnchanged(effGroup, liveContent, storeContent, ctx.passphrase, ctx.deviceClass, ownScope)
        : liveContent === storeContent;
  const changes: FileChanges = equal ? { added: [], updated: [], deleted: [] } : { added: [], updated: [name], deleted: [] };
  return { changes, localHash, storeHash };
}
```

`compareDir` (:102-133): read all contents on both sides (added/deleted files included) so the manifests hash completely:

```ts
async function compareDir(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return liveFiles.length === 0 ? "no-settings" : "not-captured";
  const liveEntries: { rel: string; content: string }[] = [];
  for (const f of liveFiles) liveEntries.push({ rel: relativeTo(real, f), content: await ctx.io.read(f) });
  const storeEntries: { rel: string; content: string }[] = [];
  for (const f of storeFiles) storeEntries.push({ rel: relativeTo(store, f), content: await ctx.io.read(f) });
  const liveByRel = new Map(liveEntries.map((e) => [e.rel, e.content]));
  const storeByRel = new Map(storeEntries.map((e) => [e.rel, e.content]));
  const changes: FileChanges = { added: [], updated: [], deleted: [] };
  for (const e of liveEntries) {
    const storeContent = storeByRel.get(e.rel);
    if (storeContent === undefined) {
      changes.added.push(e.rel);
      continue;
    }
    const equal =
      group.mode === "encrypted"
        ? await contentUnchanged(group, e.content, storeContent, ctx.passphrase, ctx.deviceClass, null)
        : e.content === storeContent;
    if (!equal) changes.updated.push(e.rel);
  }
  for (const e of storeEntries) {
    if (!liveByRel.has(e.rel)) changes.deleted.push(e.rel);
  }
  return { changes, localHash: await hashDirSide(liveEntries), storeHash: await hashDirSide(storeEntries) };
}
```

Imports at the top of status.ts: remove `loadLock` and `StoreLock` from their import lists **only if** now unused elsewhere in the file (`checkRemote` still uses `StoreLock`; `loadLock` becomes unused — remove it). Add:

```ts
import { ABSENT_HASH, BaselineEntry, hashDirSide, hashFileSide, Ledger, LedgerUpdates } from "./ledger";
```

`bucketCounts` (:148): change the down line to

```ts
else if (s.state === "store-newer" || s.state === "differs" || s.state === "never-synced") down++;
```

- [ ] **Step 4: Fix remaining compile errors from the signature change**

`src/main.ts` (:312, :446, :481) will fail to compile — apply a **minimal temporary shim** so this task stays green, replaced properly in Task 4:

```ts
const { statuses } = await statusForGroups(ctx, scoped, emptyLedger());
this.localStatuses = statuses;
```

(at :312; same `{ statuses }` destructure + `emptyLedger()` at :446 and :481; import `emptyLedger` from `./core/ledger`). Direction quality temporarily degrades to `never-synced` for differing groups; Task 4 wires real persistence.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS after adjusting any `tests/core.test.ts` expectations per Step 1 (empty-ledger differing groups now read `never-synced`).

- [ ] **Step 6: Lint + build; leave uncommitted**

Run: `npm run lint && npm run build`
Expected: 0 errors, ≤64 warnings; build green.

---

### Task 3: UI consumers of `never-synced` (panelModel, selfPane, SyncCenterView rows)

**Files:**
- Modify: `src/ui/panelModel.ts:19` (visibleUnderFilter), `src/core/selfPane.ts:23-27`, `src/ui/SyncCenterView.ts:342` (auto-select), `:1521-1539` (stateIcon), `renderItemDetail` bottom branch (~:1645)
- Test: `tests/panelModel.test.ts`, `tests/selfPane.test.ts`

**Interfaces:**
- Consumes: `GroupState` with `never-synced` (Task 2).
- Produces: no new exports; behavior only. `directionForState`/`stageableState`/`presentedState`/`statusBarStatuses` need NO change (never-synced already falls into apply/stageable/pass-through by their existing logic — verify, don't edit).

- [ ] **Step 1: Write the failing tests**

Append to `tests/panelModel.test.ts`:

```ts
it("never-synced rows are visible under the apply filter, default apply, stageable", () => {
  expect(visibleUnderFilter("never-synced", "apply")).toBe(true);
  expect(visibleUnderFilter("never-synced", "capture")).toBe(false);
  expect(directionForState("never-synced")).toBe("apply");
  expect(stageableState("never-synced")).toBe(true);
});
```

Append to `tests/selfPane.test.ts`:

```ts
it("never-synced self maps to adopt with a content diff", () => {
  const r = selfPaneState({ isColdStart: false, groupState: "never-synced", drift: null, flagsDrift: false });
  expect(r.state).toBe("adopt");
  expect(r.contentChanged).toBe(true);
});
```

(Match the surrounding tests' import style; `drift: null` matches `VersionDrift`'s null member — check the file's existing calls and copy their shape.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/panelModel.test.ts tests/selfPane.test.ts`
Expected: FAIL — apply filter returns false; selfPane maps to insync.

- [ ] **Step 3: Implement**

`src/ui/panelModel.ts:19`:

```ts
  if (filter === "apply") return state === "store-newer" || state === "differs" || state === "never-synced";
```

`src/core/selfPane.ts` (:23-27):

```ts
  const contentChanged = s === "local-changed" || s === "store-newer" || s === "differs" || s === "not-captured" || s === "never-synced";
  let state: SelfPaneState;
  if (s === "store-newer" || s === "never-synced") state = "adopt";
```

`src/ui/SyncCenterView.ts:342` (auto-select on open):

```ts
        if ((s.state === "local-changed" || s.state === "store-newer" || s.state === "never-synced") && this.sectionOf(s.group) === "main") this.selected.add(s.group);
```

`stateIcon` (:1521): add before `case "differs"` and update the differs tip:

```ts
      case "never-synced":
        return { glyph: "↓", cls: "is-down", tip: "not synced on this device yet — apply takes the store's settings", action: "apply" };
      case "differs":
        return { glyph: "≠", cls: "is-neq", tip: "changed on both sides since this device last synced — review the diff" };
```

`renderItemDetail` bottom branch — right before `this.renderDirectionToggle(detail, r);` (after the `section === "not-installed"` early return):

```ts
    if (status.state === "never-synced") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "not synced on this device yet — review the diff, then apply (or switch direction to capture)" });
    }
```

- [ ] **Step 4: Run tests + suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Lint + build; leave uncommitted**

Run: `npm run lint && npm run build`
Expected: clean per baseline.

---

### Task 4: `src/main.ts` ledger persistence wiring

**Files:**
- Modify: `src/main.ts` — plugin-class helpers + the three call sites (:312 refreshLocalStatus, :446 computeStatuses, :481 selfStatus), replacing Task 2's shims.

**Interfaces:**
- Consumes (Task 1): `applyUpdates`, `parseLedger`, `pruneLedger`, `Ledger` from `./core/ledger`.
- Produces (Task 5 relies on): private methods `loadBaselines(): Ledger` and `saveBaselines(ledger: Ledger): void` on the plugin class.

- [ ] **Step 1: Add persistence helpers**

Next to the passphrase localStorage helpers (main.ts ~:770):

```ts
  private loadBaselines(): Ledger {
    return parseLedger(this.app.loadLocalStorage("config-sync-baselines"));
  }

  private saveBaselines(ledger: Ledger): void {
    this.app.saveLocalStorage("config-sync-baselines", JSON.stringify(ledger));
  }
```

- [ ] **Step 2: Wire the three call sites**

`refreshLocalStatus` (:312 area):

```ts
      const ledger = this.loadBaselines();
      const { statuses, updates } = await statusForGroups(ctx, scoped, ledger);
      this.localStatuses = statuses;
      this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), new Set(scoped.map((g) => g.name))));
```

`computeStatuses` host fn (:446 area):

```ts
        const ledger = this.loadBaselines();
        const { statuses, updates } = await statusForGroups(ctx, groups, ledger);
        this.localStatuses = statuses;
        this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), new Set(groups.map((g) => g.name))));
```

`selfStatus` host fn (:481 area) — **no prune** (single-group call must not wipe the ledger):

```ts
        const selfLedger = this.loadBaselines();
        const { statuses: selfStatuses, updates: selfUpdates } = await statusForGroups(ctx, [selfGroup], selfLedger);
        const st = selfStatuses[0];
        this.saveBaselines(applyUpdates(selfLedger, selfUpdates));
```

Remove the Task 2 `emptyLedger` shim import if now unused.

- [ ] **Step 3: Suite + lint + build**

Run: `npx vitest run && npm run lint && npm run build`
Expected: green / baseline.

- [ ] **Step 4: Dev-vault smoke**

From the dev vault (`cd ~/local/coding/open/obsidian-config-sync/dev/vault`), install the freshly built plugin, then via `obsidian-cli eval`:
1. `app.plugins.plugins["config-sync"]` loaded, open Sync Center → statuses render.
2. Clear the ledger: `app.saveLocalStorage("config-sync-baselines", null)`, edit one synced file's local copy, reopen Sync Center → the row shows **↓ / "not synced on this device yet"** (`never-synced`).
3. Capture or apply that row so it returns to in-sync (this seeds the baseline), then verify both directions: edit only the LOCAL file → row shows **↑ local-changed**; restore it to in-sync again, then edit only the STORE copy → row shows **↓ store-newer**. The second check is the one the old mtime heuristic always got wrong (fresh local mtimes used to force ↑).
Record the eval outputs in the task report. Leave uncommitted.

---

### Task 5: Cold-start banner

**Files:**
- Modify: `src/ui/panelModel.ts` (new predicate), `src/ui/SyncCenterView.ts` (`SyncCenterHost` interface :117, `renderItemMode` top), `src/main.ts` (`syncCenterHost()` + dismissed helpers + clear-on-insync in `selfStatus`)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `SelfSyncInfo.state` (SyncCenterView.ts:108), `GroupStatus` (already imported in panelModel).
- Produces: `showColdStartBanner(selfState: "coldstart" | "adopt" | "capture" | "both" | "insync", statuses: GroupStatus[], dismissed: boolean): boolean` in panelModel; host members `coldStartDismissed(): boolean` and `setColdStartDismissed(v: boolean): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/panelModel.test.ts`:

```ts
it("cold-start banner: self pending + never-synced rows + not dismissed", () => {
  const never: GroupStatus[] = [{ group: "a", state: "never-synced" }];
  const synced: GroupStatus[] = [{ group: "a", state: "in-sync" }];
  expect(showColdStartBanner("coldstart", never, false)).toBe(true);
  expect(showColdStartBanner("adopt", never, false)).toBe(true);
  expect(showColdStartBanner("both", never, false)).toBe(true);
  expect(showColdStartBanner("insync", never, false)).toBe(false);
  expect(showColdStartBanner("capture", never, false)).toBe(false);
  expect(showColdStartBanner("coldstart", synced, false)).toBe(false);
  expect(showColdStartBanner("coldstart", never, true)).toBe(false);
});
```

(Import `showColdStartBanner`; `GroupStatus` may need adding to the test's imports from `../src/core/status`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/panelModel.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the predicate**

In `src/ui/panelModel.ts` (near `statusBarStatuses`):

```ts
// Cold-start guidance (spec 2026-07-27): show only while the plugin's own settings are still
// pending (coldstart/adopt/both) AND some group has never synced on this device. "capture"
// pending is a normal working state, not a cold start. Dismissal is device-local and cleared
// by main.ts when self returns to insync, so a future genuine cold start shows it again.
export function showColdStartBanner(
  selfState: "coldstart" | "adopt" | "capture" | "both" | "insync",
  statuses: GroupStatus[],
  dismissed: boolean
): boolean {
  if (dismissed) return false;
  if (selfState !== "coldstart" && selfState !== "adopt" && selfState !== "both") return false;
  return statuses.some((s) => s.state === "never-synced");
}
```

- [ ] **Step 4: Host plumbing in main.ts**

Dismissed helpers next to `loadBaselines`:

```ts
  private coldStartDismissed(): boolean {
    return this.app.loadLocalStorage("config-sync-coldstart-dismissed") === "1";
  }

  private setColdStartDismissed(v: boolean): void {
    this.app.saveLocalStorage("config-sync-coldstart-dismissed", v ? "1" : null);
  }
```

In `syncCenterHost()` return object add:

```ts
      coldStartDismissed: () => this.coldStartDismissed(),
      setColdStartDismissed: (v) => this.setColdStartDismissed(v),
```

In the `selfStatus` host fn, after `decided` is computed, clear the flag on insync:

```ts
        if (decided.state === "insync") this.setColdStartDismissed(false);
```

Add both members to the `SyncCenterHost` interface (SyncCenterView.ts:117 block):

```ts
  coldStartDismissed(): boolean;
  setColdStartDismissed(v: boolean): void;
```

- [ ] **Step 5: Render the banner**

At the top of `renderItemMode(main)` in SyncCenterView.ts (before the existing list rendering), using the view's `this.selfInfo` and current statuses (`this.statuses` — match the field the view actually holds; it is the array `computeStatuses` returned, check nearby usage like `mainRows()`):

```ts
    if (this.selfInfo !== null && showColdStartBanner(this.selfInfo.state, this.statuses, this.host.coldStartDismissed())) {
      const banner = main.createDiv({ cls: "config-sync-coldstart-banner" });
      const txt = banner.createDiv({ cls: "config-sync-coldstart-text" });
      txt.createSpan({ cls: "config-sync-coldstart-head", text: "This device hasn't synced with the store yet. " });
      txt.createSpan({ text: "Adopt the plugin settings first — they carry the scopes and device rules that make the diffs below trustworthy — then review and apply." });
      const actions = banner.createDiv({ cls: "config-sync-coldstart-actions" });
      const go = actions.createEl("button", { cls: "config-sync-coldstart-go", text: "Review settings →" });
      go.addEventListener("click", () => {
        this.panelScope = { kind: "self" };
        this.renderMainRegion();
      });
      const close = actions.createEl("button", { cls: "config-sync-coldstart-x", text: "✕" });
      close.addEventListener("click", () => {
        this.host.setColdStartDismissed(true);
        this.renderMainRegion();
      });
    }
```

Adapt the two field names (`this.selfInfo`, `this.statuses`) to the view's actual members (both exist — `selfInfo` is used at :309; find the statuses field via `mainRows()` at :395). Style the banner in `styles.css` following the existing `config-sync-*` class conventions (a bordered callout row; reuse an existing callout/banner class if one exists — search `styles.css` for `banner`/`callout` before adding new rules).

- [ ] **Step 6: Suite + lint + build; dev-vault smoke**

Run: `npx vitest run && npm run lint && npm run build`
Smoke: in the dev vault, clear both localStorage keys, empty the plugin's items list (simulated cold start), open Sync Center → banner shows; "Review settings →" jumps to the Config Sync pane; ✕ dismisses and it stays dismissed after reopening; after adopt + statuses settle to insync the dismissal flag resets. Leave uncommitted.

---

### Task 6: Ride-along #3 — carrier groups get real categories

**Files:**
- Modify: `src/core/catalog.ts:431-443` (`categoryForGroup`)
- Test: `tests/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/catalog.test.ts` (match its import style):

```ts
it("switch-list carrier groups land in their real categories, not custom", () => {
  expect(categoryForGroup("community-plugins")).toBe("community");
  expect(categoryForGroup("core-plugins")).toBe("core");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — both return `"custom"`.

- [ ] **Step 3: Implement**

In `categoryForGroup`, after the `enabled-css-snippets` pin:

```ts
  // The other two switch-list carriers (see SWITCH_LISTS) are the on/off lists OF those
  // sections — pin them alongside the plugins they govern.
  if (name === "community-plugins") return "community";
  if (name === "core-plugins") return "core";
```

- [ ] **Step 4: Run tests; suite; leave uncommitted**

Run: `npx vitest run tests/catalog.test.ts && npx vitest run`
Expected: PASS.

---

### Task 7: Ride-along #5 — JSON sorted diff view + order-only note

**Files:**
- Modify: `src/core/merge.ts` (export `sortKeysDeep`, add `jsonSortedView`), `src/ui/ConflictModal.ts:10-19` (delete local `sortKeysDeep`, import from merge), `src/ui/SyncCenterView.ts:661-672` (self data.json diff) and `:1845-1849` (item diff)
- Test: `tests/merge.test.ts`

**Interfaces:**
- Produces: `export function jsonSortedView(content: string): string | null` in merge.ts (null = not parseable as JSON; callers fall back to raw). `sortKeysDeep` becomes exported.

- [ ] **Step 1: Write the failing tests**

Append to `tests/merge.test.ts`:

```ts
it("jsonSortedView normalizes key order and formatting; null for non-JSON", () => {
  expect(jsonSortedView('{"b":1,"a":{"d":2,"c":3}}')).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  expect(jsonSortedView('{"a":[2,1]}')).toBe('{\n  "a": [\n    2,\n    1\n  ]\n}\n'); // arrays keep order
  expect(jsonSortedView("not json")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/merge.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in merge.ts**

Export the existing `sortKeysDeep` (:31) and add below it:

```ts
/**
 * Key-order/format-normalized rendering of a JSON document for diff previews: parse, sort keys
 * deep (arrays keep order), pretty-print. Returns null when the content is not JSON so callers
 * can fall back to the raw text. Preview-only — never feeds capture/apply bytes.
 */
export function jsonSortedView(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return JSON.stringify(sortKeysDeep(parsed), null, 2) + "\n";
}
```

- [ ] **Step 4: Dedupe ConflictModal**

Delete the local `sortKeysDeep` in `src/ui/ConflictModal.ts:10-19`; import it from `../core/merge` (keep `definitionText` as-is otherwise).

- [ ] **Step 5: Wire the two Sync Center diff sites**

Item diff (SyncCenterView.ts:1845-1849) — extend the sorted-view treatment to all JSON files and add the order-only note:

```ts
          // On/off lists compare as sets — sorted view keeps ordering/comma artifacts out.
          // Other JSON files get key-order normalization for the same reason (spec 2026-07-27).
          const switchSorted = SWITCH_LIST_GROUPS.has(r.group.name);
          let base = switchSorted ? switchListSortedView(pair.base) : pair.base;
          let produced = switchSorted ? switchListSortedView(pair.produced) : pair.produced;
          let jsonSorted = false;
          if (!switchSorted && e.name.endsWith(".json")) {
            const sb = jsonSortedView(pair.base);
            const sp = jsonSortedView(pair.produced);
            if (sb !== null && sp !== null) {
              base = sb;
              produced = sp;
              jsonSorted = true;
            }
          }
          if (base === produced && pair.base !== pair.produced) {
            p.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
            return;
          }
          renderDiffPanel(p, base, produced, leftLabel, rightLabel, switchSorted || jsonSorted ? `${e.name} · sorted view` : e.name);
```

Self data.json diff (`renderSelfDataJsonDiff`, :661-672) — same pattern without the switch-list branch:

```ts
      const leftLabel = dir === "capture" ? "store" : "this device";
      const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
      const sb = jsonSortedView(pair.base);
      const sp = jsonSortedView(pair.produced);
      const base = sb ?? pair.base;
      const produced = sp !== null && sb !== null ? sp : pair.produced;
      if (base === produced && pair.base !== pair.produced) {
        holder.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
        return;
      }
      renderDiffPanel(holder, base, produced, leftLabel, rightLabel, sb !== null && sp !== null ? "data.json · sorted view" : "data.json");
```

Add the needed imports (`jsonSortedView` from `../core/merge`) in SyncCenterView.ts.

- [ ] **Step 6: Suite + lint + build; leave uncommitted**

Run: `npx vitest run && npm run lint && npm run build`
Expected: green / baseline.

---

### Task 8: Docs currency + final gates

**Files:**
- Modify: `README.md`, `README.zh.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md` (verify exact names with `ls docs/ *.md` first; update only the ones that exist and describe affected behavior)

- [ ] **Step 1: Update user-facing docs**

Repo rule (docs-currency): user-facing changes ship with docs in the same branch. Cover, in the existing docs' own style and language(s):
- Direction detection now uses per-device sync baselines (localStorage) instead of file-time heuristics; new "not synced on this device yet" state; "differs" now means changed on both sides.
- Cold-start banner: what triggers it, what adopting first buys, that it's dismissible.
- Diff previews: JSON files render key-order-normalized ("sorted view"); pure ordering/format differences say so instead of showing noise.
- Carrier on/off lists (`community-plugins`, `core-plugins`) now appear under their plugin categories.
State current behavior only — no changelog prose in docs (release notes carry the delta).

- [ ] **Step 2: Final whole-feature gates**

Run: `npx vitest run && npm run lint && npm run build`
Expected: all green, lint at baseline. Leave everything uncommitted; report ready-for-review (the owner cuts).
