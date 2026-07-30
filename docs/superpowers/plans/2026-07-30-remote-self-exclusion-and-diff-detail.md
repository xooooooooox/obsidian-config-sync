# Remote Self Exclusion + Diff Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-remote exclusion of Config Sync's own settings (kills the cross-vault self loop), expandable remote diff rows with real names + content diffs, and honest direction copy that separates what Pull/Push would actually do from what they would not.

**Architecture:** Pure-core first: the `Remote` schema gains `excludeSelf`, an `isSelfStoreRel` predicate identifies the self item's store rels, and `planImport`/`pushExternal`/`diffRemote`/`remoteLockAhead` take explicit exclusion options. `RemoteDiffEntry` is reworked to carry per-file kind + both sides' content. The UI then consumes: a settings toggle, a conflict-modal hint, and a rebuilt remote pane (two-tone names, two-level expansion into `renderDiffPanel`, split summary lines).

**Tech Stack:** TypeScript (strict), Obsidian plugin API, vitest, esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-remote-self-exclusion-and-diff-detail-design.md` (mockup 定稿: https://claude.ai/code/artifact/75cb4ca2-f104-4901-be4a-b5e356525245)

## Global Constraints

- **No git commits during execution.** Working tree stays uncommitted (user's review state); one commit at cut. Never add Claude/AI attribution anywhere.
- **UI copy is verbatim from this plan** (mockup-locked). Do not rephrase, re-case, or "improve" any quoted string.
- **Gates after every task:** `npm test` (all pass; suite grows from 802), `npm run build` (green), `npm run lint` (0 errors; warnings stay at the 57 baseline — see Task 4 for the one sanctioned `ignoreWords` addition if needed).
- **Explicit parameters, no defaults:** the new `opts`/`ignoreGroups` parameters are required at every call site (including tests). Never add a default value to smuggle in backward compatibility.
- Strict typing throughout; no `any`. Comments/identifiers in English. Match surrounding code style (file-scope doc comments, `createDiv`/`createSpan` UI idiom).
- `excludeSelf` is serialized **only when true** (absent = default off = current behavior).

---

### Task 1: `Remote.excludeSelf` schema + `isSelfStoreRel` predicate

**Files:**
- Modify: `src/core/types.ts` (~line 83, `Remote` type)
- Modify: `src/core/manifest.ts` (~lines 272-299, `parseRemote`)
- Modify: `src/core/ConfigSyncCore.ts` (~line 752, next to `SELF_STORE_DATA_REL`)
- Test: `tests/manifest.test.ts` (append inside `describe("validateRemotes")`), `tests/core.test.ts` (new describe near the top-level describes)

**Interfaces:**
- Consumes: existing `SELF_STORE_DATA_REL` const, `sidecarStoreSuffix` from `./pathing` (already imported in ConfigSyncCore.ts).
- Produces: `Remote` variants each carrying `excludeSelf?: boolean`; exported `isSelfStoreRel(rel: string): boolean` from `src/core/ConfigSyncCore.ts`. Tasks 3-5 rely on both names exactly.

- [ ] **Step 1: types.ts — extend `Remote`**

Replace the existing `Remote` type (keep the existing inline comments):

```ts
// excludeSelf (either type): true = Config Sync's own settings (the self item's store copy)
// never travel to/from this remote — pull/push skip them and the comparison stops reporting
// them. Absent = false = the self item travels like any other (same-lineage stores).
export type Remote =
  | { name: string; type: "vault"; storePath: string; excludeSelf?: boolean } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean }; // subdir: store folder inside the repo; absent = repo root
```

- [ ] **Step 2: manifest.ts — validate + serialize**

In `parseRemote`, extend the destructuring and add the check right after the `name` check:

```ts
  const { name, type, storePath, url, branch, subdir, excludeSelf } = r;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`remote #${index + 1} is missing a "name" — give it a short label, e.g. "name": "laptop"`);
  }
  if (excludeSelf !== undefined && typeof excludeSelf !== "boolean") {
    throw new ManifestValidationError(`remote "${name}" has "excludeSelf": ${JSON.stringify(excludeSelf)}, but it must be true or false`);
  }
```

In the `type === "vault"` branch, replace `return { name, type, storePath };` with:

```ts
    const remote: Remote = { name, type, storePath };
    if (excludeSelf === true) remote.excludeSelf = true;
    return remote;
```

In the `type === "git"` branch, after the existing `if (typeof subdir === "string" && subdir !== "") remote.subdir = subdir;` line add:

```ts
    if (excludeSelf === true) remote.excludeSelf = true;
```

- [ ] **Step 3: ConfigSyncCore.ts — the predicate**

Directly below the `SELF_STORE_DATA_REL` const:

```ts
// Every store rel belonging to the self item: its data file plus the two device-class sidecars.
// The excludeSelf remote option uses this to keep the self item out of pull/push/diff entirely.
export function isSelfStoreRel(rel: string): boolean {
  return (
    rel === SELF_STORE_DATA_REL ||
    rel === SELF_STORE_DATA_REL + sidecarStoreSuffix("desktop") ||
    rel === SELF_STORE_DATA_REL + sidecarStoreSuffix("mobile")
  );
}
```

- [ ] **Step 4: tests**

`tests/manifest.test.ts`, inside `describe("validateRemotes")`:

```ts
  it("accepts excludeSelf: true on both types; false/absent serialize as absent", () => {
    const remotes = validateRemotes([
      { name: "a", type: "vault", storePath: "/s", excludeSelf: true },
      { name: "b", type: "vault", storePath: "/s", excludeSelf: false },
      { name: "c", type: "git", url: "git@h:r.git", branch: "main", excludeSelf: true },
    ]);
    expect(remotes[0]).toEqual({ name: "a", type: "vault", storePath: "/s", excludeSelf: true });
    expect(remotes[1]).toEqual({ name: "b", type: "vault", storePath: "/s" });
    expect(remotes[2]).toEqual({ name: "c", type: "git", url: "git@h:r.git", branch: "main", excludeSelf: true });
  });

  it("rejects a non-boolean excludeSelf", () => {
    expect(() => validateRemotes([{ name: "a", type: "vault", storePath: "/s", excludeSelf: "yes" }])).toThrow("must be true or false");
  });
```

`tests/core.test.ts` — add `isSelfStoreRel` to the existing `../src/core/ConfigSyncCore` import, then as a new top-level describe (place it right before `describe("planImport / applyImport")`):

```ts
describe("isSelfStoreRel", () => {
  it("matches the self data file and its device-class sidecars only", () => {
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/config-sync/data.json.__scopes__.mobile.json")).toBe(true);
    expect(isSelfStoreRel("store/configdir/plugins/demo/data.json")).toBe(false);
    expect(isSelfStoreRel("store.lock.json")).toBe(false);
  });
});
```

- [ ] **Step 5: run gates** — `npm test`, `npm run build`, `npm run lint`. All green, warnings 57.

---

### Task 2: `RemoteDiffEntry` carries per-file kind + content

**Files:**
- Modify: `src/core/status.ts` (~lines 230-292: `RemoteDiffEntry`, `diffRemote`)
- Modify: `src/ui/SyncCenterView.ts` (~line 2233 `changed` filter; ~lines 2274-2281 `renderRemoteDiffEntry` — **minimal mechanical adaptation only**, the visual rework is Task 5)
- Test: `tests/status.test.ts` (`describe("diffRemote")` rewritten expectations)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 3/5 rely on these exact shapes):

```ts
export interface RemoteDiffFile {
  itemRel: string;                       // display path within the item (resolve()'s itemRel)
  kind: "added" | "updated" | "deleted"; // added = only at the remote; deleted = only in the local store
  local: string | null;                  // content in the local store; null when the file doesn't exist there
  remote: string | null;                 // content at the remote; null when the file doesn't exist there
}

export interface RemoteDiffEntry {
  group: string;
  files: RemoteDiffFile[];
}
```

- [ ] **Step 1: status.ts — replace the interface**

Replace the current `RemoteDiffEntry` (with its `changes: FileChanges`) with the two interfaces above (keep the position between `remoteLockAhead` and `OTHER_STORE_FILES_GROUP`). `FileChanges` stays imported only if still used elsewhere in the file — if the import becomes unused, remove it from the import list.

- [ ] **Step 2: status.ts — rework `diffRemote`'s collection**

Replace the `byName`/`entry` block and both loops (keep `resolve`, `filesMatch`, and the doc comments as they are):

```ts
  const byName = new Map<string, RemoteDiffEntry>();
  const entry = (name: string): RemoteDiffEntry => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { group: name, files: [] };
      byName.set(name, e);
    }
    return e;
  };
```

```ts
  for (const rel of remoteFiles) {
    const { name, itemRel } = resolve(rel);
    if (!localRels.has(rel)) {
      entry(name).files.push({ itemRel, kind: "added", local: null, remote: await reader.readFile(rel) });
    } else {
      const remoteContent = await reader.readFile(rel);
      const localContent = await ctx.io.read(`${ctx.rootPath}/${rel}`);
      if (!filesMatch(name, remoteContent, localContent)) {
        entry(name).files.push({ itemRel, kind: "updated", local: localContent, remote: remoteContent });
      }
    }
  }
  const remoteSet = new Set(remoteFiles);
  for (const rel of localRels) {
    if (!remoteSet.has(rel)) {
      const { name, itemRel } = resolve(rel);
      entry(name).files.push({ itemRel, kind: "deleted", local: await ctx.io.read(`${ctx.rootPath}/${rel}`), remote: null });
    }
  }
```

Final return line becomes:

```ts
  return [...byName.values()].filter((e) => e.group !== "" && e.files.length > 0);
```

- [ ] **Step 3: SyncCenterView.ts — mechanical adaptation (keep today's visuals)**

At ~line 2233: `const changed = entries.filter((e) => e.files.length > 0);`. That was the file's ONLY `hasChanges` use — remove `hasChanges` from the `../core/types` import (line 5); `FileChanges` stays (used by `renderCappedChanges`).

Replace the chip lines in `renderRemoteDiffEntry`:

```ts
    const counts = { added: 0, updated: 0, deleted: 0 };
    for (const f of e.files) counts[f.kind]++;
    if (counts.added > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${counts.added}` });
    if (counts.updated > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${counts.updated}` });
    if (counts.deleted > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${counts.deleted}` });
```

- [ ] **Step 4: tests/status.test.ts — rewrite the four `diffRemote` expectations**

Test 1 ("reports per-item differences"): replace the three `expect`s:

```ts
    const snip = entries.find((e) => e.group === "snippets");
    expect(snip?.files).toEqual([
      { itemRel: "extra.css", kind: "added", local: null, remote: "x" },
      { itemRel: "one.css", kind: "updated", local: "one", remote: "REMOTE" },
    ]);
    expect(entries.find((e) => e.group === "hotkeys")).toBeUndefined();
```

(Note: files arrive in remote-listing order — `listFiles` sorts rels, and `extra.css` < `one.css`.)

Test 2 ("fresh device"): replace the `byName` block:

```ts
    const byName = Object.fromEntries(entries.map((e) => [e.group, e.files]));
    expect(byName["hotkeys"]).toEqual([{ itemRel: "hotkeys.json", kind: "added", local: null, remote: '{"a":1}' }]);
    expect(byName["snippets"]).toEqual([{ itemRel: "one.css", kind: "added", local: null, remote: "one" }]);
    expect(byName["plugin-config-sync"]?.map((f) => f.itemRel)).toEqual(["data.json"]);
    expect(byName["(other store files)"]?.map((f) => f.itemRel)).toEqual(["store/mystery/leftover.bin"]);
    expect(byName[""]).toBeUndefined(); // lock stays metadata
```

Test 3 (switch lists): the reordered case stays `toEqual([])`; the membership case becomes:

```ts
    expect(entries.find((e) => e.group === "community-plugins")?.files.map((f) => [f.itemRel, f.kind])).toEqual([["community-plugins.json", "updated"]]);
```

Test 4 ("never reports the store-metadata pseudo-entry"): unchanged (`toEqual([])`).

- [ ] **Step 5: run gates** — `npm test`, `npm run build`, `npm run lint`.

---

### Task 3: `excludeSelf` behavior in core + main.ts wiring

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`planImport` ~line 781, `pushExternal` ~line 897)
- Modify: `src/core/status.ts` (`diffRemote` ~line 239, `remoteLockAhead` ~line 209)
- Modify: `src/main.ts` (host `deepDiff` ~line 681, `pullFrom` ~line 700, `pushTo` ~line 739)
- Test: `tests/core.test.ts`, `tests/status.test.ts` (mechanical call-site updates + new behavior tests)

**Interfaces:**
- Consumes: `isSelfStoreRel` (Task 1), `RemoteDiffEntry.files` (Task 2).
- Produces (exact signatures):
  - `planImport(ctx: CoreContext, reader: ExternalStoreReader, opts: { excludeSelf: boolean }): Promise<PendingPull>`
  - `pushExternal(ctx: CoreContext, writer: ExternalStoreWriter, opts: { excludeSelf: boolean }): Promise<GroupResult[]>`
  - `diffRemote(ctx: CoreContext, reader: ExternalStoreReader, opts: { excludeSelf: boolean }): Promise<RemoteDiffEntry[]>`
  - `remoteLockAhead(localRaw: string | null, remoteRaw: string | null, ignoreGroups: string[]): boolean`

- [ ] **Step 1: `planImport`**

Change the signature (add `opts: { excludeSelf: boolean }`) and extend BOTH skip conditions:

```ts
    if (rel === LOCK_REL || isLegacyManifestRel(rel) || (opts.excludeSelf && isSelfStoreRel(rel))) continue;
```

(one in the remote loop, one in the local loop — they are textually identical today).

- [ ] **Step 2: `pushExternal`**

Add `opts: { excludeSelf: boolean }`. Change the pushable filter:

```ts
  const pushableRels = rels.filter((r) => !isLegacyManifestRel(r) && !(opts.excludeSelf && isSelfStoreRel(r)));
```

and in the mirror-delete loop, first line inside `for (const rel of remoteFiles)`:

```ts
    if (opts.excludeSelf && isSelfStoreRel(rel)) continue; // the remote's own contract is not ours to delete
```

Note: the deletion guard matters even though `pushableRels` is already filtered — it protects the REMOTE's self copy from the mirror pass.

- [ ] **Step 3: `diffRemote` + `remoteLockAhead` (status.ts)**

Extend the `./ConfigSyncCore` import with `isSelfStoreRel`. `diffRemote` gains `opts: { excludeSelf: boolean }`; add as the first line of both loops:

```ts
    if (opts.excludeSelf && isSelfStoreRel(rel)) continue;
```

`remoteLockAhead(localRaw, remoteRaw, ignoreGroups: string[])`: in the `for (const [name, entry] of Object.entries(remote.groups))` loop, first line:

```ts
    if (ignoreGroups.includes(name)) continue;
```

Extend the function's doc comment with one sentence: `ignoreGroups names lock entries that never count (the self group when the remote excludes it).`

- [ ] **Step 4: main.ts wiring**

In the host object:

```ts
      deepDiff: async (remote) => {
        const ctx = await this.coreContext();
        const reader = await this.createReader(remote);
        const entries = await diffRemote(ctx, reader, { excludeSelf: remote.excludeSelf === true });
```

and the lock line:

```ts
          lockDiffers = remoteLockAhead(localLock, remoteLock, remote.excludeSelf === true ? [SELF_GROUP_NAME] : []);
```

`pullFrom`: `const pending = await planImport(ctx, await this.createReader(remote), { excludeSelf: remote.excludeSelf === true });`

`pushTo`: `const results = await pushExternal(ctx, await this.createWriter(remote), { excludeSelf: remote.excludeSelf === true });`

(`SELF_GROUP_NAME` is already imported in main.ts.)

- [ ] **Step 5: mechanical test call-site updates**

- `tests/core.test.ts`: every existing `planImport(ctx, ...)` call gains `, { excludeSelf: false }` as the third argument; every existing `pushExternal(ctx, fw.writer)` becomes `pushExternal(ctx, fw.writer, { excludeSelf: false })`.
- `tests/status.test.ts`: every existing `diffRemote(ctx, fakeReader(...))` gains `, { excludeSelf: false }`; every existing `remoteLockAhead(a, b)` becomes `remoteLockAhead(a, b, [])`.

- [ ] **Step 6: new behavior tests**

`tests/core.test.ts`, inside `describe("planImport / applyImport")`:

```ts
  it("excludeSelf: a divergent self store copy is neither a conflict nor written by pull", async () => {
    const { io, ctx } = setup();
    await writeGroups(ctx, [HOTKEYS_GROUP]);
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "2026-07-01T00:00:00.000Z", groups: { "plugin-config-sync": { sourcePluginVersion: "1.0.0" } } }),
      "cs/store/configdir/plugins/config-sync/data.json": '{"groups":[],"mine":true}',
      "cs/store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json": '{"mine":true}',
    });
    const remote = {
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-02T00:00:00.000Z", groups: { "plugin-config-sync": { sourcePluginVersion: "9.9.9" }, hotkeys: { sourceAppVersion: "1.9.0" } } }),
      "store/configdir/plugins/config-sync/data.json": selfDataJson([HOTKEYS_GROUP]),
      "store/configdir/hotkeys.json": '{"a":1}',
    };
    // sanity: without the exclusion this exact setup IS a self-file conflict
    expect((await planImport(ctx, fakeReader(remote), { excludeSelf: false })).plan.conflicts.length).toBe(1);

    const pending = await planImport(ctx, fakeReader(remote), { excludeSelf: true });
    expect(pending.plan.conflicts).toEqual([]);
    await applyImport(ctx, pending, []);
    expect(await io.read("cs/store/configdir/plugins/config-sync/data.json")).toBe('{"groups":[],"mine":true}');
    expect(await io.read("cs/store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json")).toBe('{"mine":true}');
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}'); // the rest of the pull still lands
    const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string }> };
    expect(lock.groups["plugin-config-sync"]?.sourcePluginVersion).toBe("1.0.0"); // local self lineage survives
  });
```

`tests/core.test.ts`, inside `describe("pushExternal")`:

```ts
  it("excludeSelf: push neither writes the local self copy nor mirror-deletes the remote's", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": '{"capturedAt":"t","groups":{}}',
      "cs/store/configdir/plugins/config-sync/data.json": '{"mine":true}',
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "store/configdir/plugins/config-sync/data.json": '{"theirs":true}' });
    const results = await pushExternal(ctx, fw.writer, { excludeSelf: true });
    expect(fw.files["store/configdir/plugins/config-sync/data.json"]).toBe('{"theirs":true}'); // untouched both ways
    expect(fw.files["store/configdir/hotkeys.json"]).toBe('{"a":1}');
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
```

`tests/status.test.ts`, inside `describe("diffRemote")`:

```ts
  it("excludeSelf drops the self data file and sidecars from both sides", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.seed({ "cs/store/configdir/plugins/config-sync/data.json": '{"mine":true}' });
    const selfGroups = [{ name: "plugin-config-sync", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" }];
    const remote: Record<string, string> = {
      "store.lock.json": await io.read("cs/store.lock.json"),
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/snippets/one.css": "one",
      "store/configdir/plugins/demo/data.json": await io.read("cs/store/configdir/plugins/demo/data.json"),
      "store/configdir/plugins/config-sync/data.json": JSON.stringify({ groups: selfGroups, theirs: true }),
      "store/configdir/plugins/config-sync/data.json.__scopes__.desktop.json": "{}",
    };
    expect(await diffRemote(ctx, fakeReader(remote), { excludeSelf: true })).toEqual([]);
    const withSelf = await diffRemote(ctx, fakeReader(remote), { excludeSelf: false });
    expect(withSelf.map((e) => e.group)).toEqual(["plugin-config-sync"]);
    expect(withSelf[0]?.files.map((f) => f.kind).sort()).toEqual(["added", "updated"]);
  });
```

`tests/status.test.ts`, inside `describe("remoteLockAhead")`:

```ts
  it("ignoreGroups suppresses a difference from the named group only", () => {
    const local = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "1.0" } });
    const selfDiff = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "2.0" } });
    expect(remoteLockAhead(local, selfDiff, [])).toBe(true);
    expect(remoteLockAhead(local, selfDiff, ["plugin-config-sync"])).toBe(false);
    const otherDiff = lock("2026-07-17T10:00:00.000Z", { "plugin-config-sync": { sourcePluginVersion: "2.0" }, a: { sourcePluginVersion: "1.0" } });
    expect(remoteLockAhead(local, otherDiff, ["plugin-config-sync"])).toBe(true);
  });
```

- [ ] **Step 7: run gates** — `npm test`, `npm run build`, `npm run lint`.

---

### Task 4: Settings toggle + conflict-modal hint

**Files:**
- Modify: `src/ui/SettingTab.ts` (`RemoteDraft` ~line 201, `toDraft` ~line 210, `toCandidate` ~line 221, `renderRemoteForm` ~line 2627)
- Modify: `src/ui/ConflictModal.ts` (`renderConflict` ~line 122)
- Modify: `styles.css` (new classes)
- Modify (only if lint flags it): `eslint.config.mts` `ignoreWords`

**Interfaces:**
- Consumes: `Remote.excludeSelf` (Task 1), `isSelfStoreRel` (Task 1).
- Produces: UI only — nothing downstream consumes new names.

- [ ] **Step 1: `RemoteDraft` round-trip**

```ts
interface RemoteDraft {
  name: string;
  type: "vault" | "git";
  storePath: string;
  url: string;
  branch: string;
  subdir: string;
  excludeSelf: boolean;
}
```

`toDraft` gains `excludeSelf: r.excludeSelf === true,`. `toCandidate` becomes:

```ts
function toCandidate(d: RemoteDraft): unknown {
  const c: Record<string, unknown> = { name: d.name, type: d.type };
  if (d.type === "vault") {
    c.storePath = d.storePath;
  } else {
    c.url = d.url;
    c.branch = d.branch;
    if (d.subdir.trim() !== "") c.subdir = d.subdir.trim();
  }
  if (d.excludeSelf) c.excludeSelf = true;
  return c;
}
```

- [ ] **Step 2: toggle line in `renderRemoteForm`**

Append after the `if (draft.type === "vault") { … } else { … }` block (so it renders for both types, below the git test-connection lines), exact copy:

```ts
    const selfLine = panel.createDiv({ cls: "config-sync-remote-selfline" });
    const selfText = selfLine.createDiv({ cls: "config-sync-remote-selftext" });
    selfText.createDiv({ cls: "config-sync-remote-selfname", text: "Keep Config Sync's own settings out of this remote" });
    selfText.createDiv({ cls: "config-sync-remote-selfdesc", text: "For a vault that keeps its own setup: Pull and Push skip Config Sync's settings, and the comparison stops reporting them." });
    new ToggleComponent(selfLine).setValue(draft.excludeSelf).onChange((v) => {
      draft.excludeSelf = v;
      void this.saveRemotes();
    });
```

(`ToggleComponent` is already imported in SettingTab.ts.)

- [ ] **Step 3: conflict-modal hint**

In `ConflictModal.ts`: add `isSelfStoreRel` to the `../core/ConfigSyncCore` import (currently only `PendingPull` — becomes `import { isSelfStoreRel, PendingPull } from "../core/ConfigSyncCore";`). In `renderConflict`, after the `diffHost` block (end of the method), exact copy:

```ts
    if (c.kind === "file" && isSelfStoreRel(c.rel)) {
      row.createDiv({
        cls: "config-sync-cm-selfhint",
        text: "If this vault keeps its own Config Sync setup, you can leave it out of this remote — Settings → Remotes.",
      });
    }
```

- [ ] **Step 4: styles.css**

Append (near the other `config-sync-remote-*` / `config-sync-cm-*` rules):

```css
.config-sync-remote-selfline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--background-modifier-border);
}
.config-sync-remote-selftext {
  flex: 1;
}
.config-sync-remote-selfname {
  font-size: var(--font-ui-small);
}
.config-sync-remote-selfdesc {
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
}
.config-sync-cm-selfhint {
  margin: 6px 10px 10px;
  padding: 6px 10px;
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  background: var(--background-secondary);
  border-left: 3px solid var(--background-modifier-border-hover);
  border-radius: 4px;
}
```

- [ ] **Step 5: lint contingency**

Run `npm run lint`. If the sentence-case rule flags `Config` in the two new literals, add `'Config'` to the rule's `ignoreWords` in `eslint.config.mts` with the comment `// "Config Sync" is this plugin's own name, quoted mid-sentence in remote copy` (mirror of the existing `Community` entry). Do NOT rephrase the copy. Warnings must end at the 57 baseline.

- [ ] **Step 6: run gates** — `npm test`, `npm run build`, `npm run lint`.

---

### Task 5: remote pane rework — two-tone names, two-level expansion, split summary

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`renderRemoteDetail` ~line 2214, `renderRemoteDiffEntry` ~line 2274, two new private methods)
- Modify: `styles.css` (new classes)

**Interfaces:**
- Consumes: `RemoteDiffFile`/`RemoteDiffEntry` (Task 2), `Remote.excludeSelf` (Task 1), existing `renderRuleName`, `fullName`, `renderDiffPanel`, `jsonSortedView`, `switchListSortedView`, `SWITCH_LIST_GROUPS` (all already imported/defined in this file).
- Produces: UI only.

- [ ] **Step 1: `renderRemoteDiffEntry` → expandable row**

Replace the whole method (and pass the remote name from `renderRemoteDetail`, Step 3):

```ts
  private renderRemoteDiffEntry(detail: HTMLElement, e: RemoteDiffEntry, remoteName: string): void {
    const row = detail.createDiv({ cls: "config-sync-report-row config-sync-remote-row" });
    const chev = row.createSpan({ cls: "config-sync-cm-chev", text: "▸" });
    this.renderRuleName(row, e.group, findGroupByName(this.groups, e.group)?.label);
    row.createDiv({ cls: "config-sync-rule-spacer" });
    const counts = { added: 0, updated: 0, deleted: 0 };
    for (const f of e.files) counts[f.kind]++;
    if (counts.added > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${counts.added}` });
    if (counts.updated > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${counts.updated}` });
    if (counts.deleted > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${counts.deleted}` });
    const fold = detail.createDiv({ cls: "config-sync-remote-files" });
    fold.hide();
    let built = false;
    row.addEventListener("click", () => {
      const open = fold.isShown();
      if (open) {
        fold.hide();
        chev.setText("▸");
        return;
      }
      if (!built) {
        this.renderRemoteFileRows(fold, e, remoteName);
        built = true;
      }
      fold.show();
      chev.setText("▾");
    });
  }
```

- [ ] **Step 2: the two new methods (place directly below `renderRemoteDiffEntry`)**

```ts
  // File-level detail for one remote diff row: added → updated → deleted, each line expandable
  // into a content diff (single-sided kinds diff against an empty side).
  private renderRemoteFileRows(fold: HTMLElement, e: RemoteDiffEntry, remoteName: string): void {
    const order = { added: 0, updated: 1, deleted: 2 } as const;
    const files = [...e.files].sort((a, b) => order[a.kind] - order[b.kind] || (a.itemRel < b.itemRel ? -1 : a.itemRel > b.itemRel ? 1 : 0));
    for (const f of files) {
      const cls = f.kind === "added" ? "is-add" : f.kind === "updated" ? "is-upd" : "is-del";
      const line = fold.createDiv({ cls: `config-sync-remote-frow ${cls} config-sync-diffable` });
      line.createSpan({ cls: "config-sync-remote-fglyph", text: f.kind === "added" ? "+" : f.kind === "updated" ? "~" : "−" });
      line.createSpan({ cls: "config-sync-remote-fname", text: f.itemRel });
      const hint = line.createSpan({ cls: "config-sync-diffhint", text: " · diff ▾" });
      let panel: HTMLElement | null = null;
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (panel !== null) {
          panel.remove();
          panel = null;
          hint.setText(" · diff ▾");
          return;
        }
        hint.setText(" · diff ▴");
        const p = createDiv({ cls: "config-sync-inline-diff" });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        this.renderRemoteFileDiff(p, e.group, f, remoteName);
      });
    }
  }

  private renderRemoteFileDiff(p: HTMLElement, group: string, f: RemoteDiffFile, remoteName: string): void {
    let left = f.local ?? "";
    let right = f.remote ?? "";
    const switchSorted = SWITCH_LIST_GROUPS.has(group);
    let jsonSorted = false;
    if (switchSorted) {
      left = f.local !== null ? switchListSortedView(f.local) : "";
      right = f.remote !== null ? switchListSortedView(f.remote) : "";
    } else if (f.itemRel.endsWith(".json") && f.local !== null && f.remote !== null) {
      const sl = jsonSortedView(f.local);
      const sr = jsonSortedView(f.remote);
      if (sl !== null && sr !== null) {
        left = sl;
        right = sr;
        jsonSorted = true;
      }
    }
    if (f.local !== null && f.remote !== null && left === right) {
      p.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
      return;
    }
    const leftLabel = f.local !== null ? "your store" : "not in your store";
    const rightLabel = f.remote !== null ? remoteName : `not at ${remoteName}`;
    renderDiffPanel(p, left, right, leftLabel, rightLabel, switchSorted || jsonSorted ? `${f.itemRel} · sorted view` : f.itemRel);
  }
```

Add `RemoteDiffFile` to the `../core/status` import list.

- [ ] **Step 3: `renderRemoteDetail` — call-through, split summary, composed matched names, self note**

Entry loop passes the name: `for (const e of inCat) this.renderRemoteDiffEntry(detail, e, remote.name);`

Replace everything from `const state = check?.state ?? "unknown";` down to (but not including) the `renderRemoteButtons` call with:

```ts
    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.groups
      .filter((g) => !changedNames.has(g.name))
      .map((g) => this.fullName(g.name, g.label));
    const matched = matchNames.length;
    if (entries.length === 0) {
      detail.createDiv({
        cls: "config-sync-unchanged",
        text: lockDiffers
          ? "✓ contents match — remote has newer version info; Pull refreshes it"
          : "✓ remote matches the local store",
      });
    } else {
      // The aligned action's REAL payload, then what it will not do (spec Item 3): Pull is
      // additive (never removes local files); Push mirrors (removes remote-only files).
      const allFiles = changed.flatMap((e) => e.files);
      const incoming = allFiles.filter((f) => f.kind !== "deleted").length;
      const keptLocal = allFiles.filter((f) => f.kind === "deleted").length;
      const outgoing = allFiles.filter((f) => f.kind !== "added").length;
      const remoteOnly = allFiles.filter((f) => f.kind === "added").length;
      const summary = detail.createDiv({ cls: "config-sync-remote-summary" });
      summary.createDiv({
        text: pullAligned
          ? incoming === 0 ? "Pull would bring nothing" : `Pull would bring ${incoming} file${incoming === 1 ? "" : "s"}`
          : outgoing === 0 ? "Push would send nothing" : `Push would send ${outgoing} file${outgoing === 1 ? "" : "s"}`,
      });
      if (pullAligned && keptLocal > 0) {
        summary.createDiv({
          cls: "config-sync-remote-kept",
          text: keptLocal === 1
            ? `1 file exists only in your store — Pull never removes files; Push would add it to ${remote.name}.`
            : `${keptLocal} files exist only in your store — Pull never removes files; Push would add them to ${remote.name}.`,
        });
      }
      if (!pullAligned && remoteOnly > 0) {
        summary.createDiv({
          cls: "config-sync-remote-kept",
          text: remoteOnly === 1
            ? `1 file exists only at ${remote.name} — Push would remove it there; Pull would bring it here.`
            : `${remoteOnly} files exist only at ${remote.name} — Push would remove them there; Pull would bring them here.`,
        });
      }
      if (matched > 0) {
        const line = detail.createDiv({
          cls: "config-sync-unchanged",
          text: `✓ ${matched} more item${matched === 1 ? " matches" : "s match"} ▸`,
        });
        line.addEventListener("click", () => line.setText(`✓ ${matchNames.join(" · ")}`));
      }
    }
    if (remote.excludeSelf === true) {
      detail.createDiv({ cls: "config-sync-remote-selfnote", text: "Config Sync's own settings stay out of this remote" });
    }
```

(The old single-line `directionText` and the `config-sync-remote-summary`-as-fallback branch are gone; the matched line no longer carries direction text.)

- [ ] **Step 4: styles.css**

Append:

```css
.config-sync-remote-row {
  cursor: pointer;
}
.config-sync-remote-row:hover {
  background: var(--background-modifier-hover);
}
.config-sync-remote-files {
  margin: 2px 0 8px 22px;
  padding-left: 10px;
  border-left: 2px solid var(--background-modifier-border);
}
.config-sync-remote-frow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: var(--font-ui-small);
}
.config-sync-remote-fglyph {
  width: 12px;
  text-align: center;
  font-weight: 600;
}
.config-sync-remote-frow.is-add .config-sync-remote-fglyph {
  color: var(--color-green);
}
.config-sync-remote-frow.is-upd .config-sync-remote-fglyph {
  color: var(--color-yellow);
}
.config-sync-remote-frow.is-del .config-sync-remote-fglyph {
  color: var(--color-red);
}
.config-sync-remote-fname {
  font-family: var(--font-monospace);
  font-size: var(--font-ui-smaller);
  color: var(--text-normal);
}
.config-sync-remote-kept {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  margin-top: 4px;
}
.config-sync-remote-selfnote {
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
  font-style: italic;
  margin-top: 8px;
}
```

- [ ] **Step 5: run gates** — `npm test`, `npm run build`, `npm run lint`. Then a dev-vault smoke is done by the controller after the final review (not by this task).

---

### Task 6: docs

**Files:**
- Modify: `README.md`, `README.zh.md` (Remotes section + Sync Center remote-pane description)
- Modify: `docs/ARCHITECTURE.md` (`core/status.ts` and `core/ConfigSyncCore.ts` bullets)

**Interfaces:** none — prose only. Keep README.md and README.zh.md structurally parallel (same sections, same order; zh keeps UI strings in English).

- [ ] **Step 1: README.md** — locate the Remotes section (search for "Remotes") and add one bullet/sentence documenting the toggle, verbatim UI name quoted: *Keep Config Sync's own settings out of this remote* — for a remote vault that keeps its own setup; Pull/Push skip Config Sync's settings and the comparison stops reporting them. Locate the remote-pane paragraph (search for "Pull would bring" or the remote pane description) and update it: diff rows expand to file lists and per-file diffs, and the summary separates what Pull would bring from files that exist only in your store (Pull never removes files).

- [ ] **Step 2: README.zh.md** — same two edits in Chinese prose (UI copy stays English, full-width punctuation per file convention), keeping the 中英 line-parallel structure.

- [ ] **Step 3: docs/ARCHITECTURE.md** — update the `core/status.ts` bullet: `diffRemote(ctx, reader, opts)` returns per-file `RemoteDiffFile` entries (kind + both sides' content) and honors `excludeSelf`; `remoteLockAhead(local, remote, ignoreGroups)`. Update the `core/ConfigSyncCore.ts` (or store/pull/push) bullet: `planImport`/`pushExternal` take `{ excludeSelf }`; `isSelfStoreRel` names the self item's store rels; push's mirror-delete exempts the remote's self copy when excluded.

- [ ] **Step 4: run gates** — `npm run lint` (docs don't affect vitest/build, but run all three anyway to leave the tree verified).

---

## Self-Review (done at plan time)

- Spec coverage: Item 1 → Tasks 1/3/4 (+pane note in Task 5); Item 2 → Tasks 2/5; Item 3 → Task 5; conflict hint → Task 4; docs → Task 6. Out-of-scope items have no tasks — correct.
- Type consistency: `opts: { excludeSelf: boolean }` spelled identically across planImport/pushExternal/diffRemote; `RemoteDiffFile`/`files` names match between Task 2 (producer) and Task 5 (consumer); `isSelfStoreRel` exported in Task 1, imported in Tasks 3/4.
- Known sequencing: Task 2 keeps the pane compiling via a minimal chip adaptation that Task 5 then replaces — intentional, so every task leaves the build green.
