# "No settings yet" State & Remote-Diff De-noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Items with files on neither side get their own inert `no-settings` (○) state — out of the ↑ bucket, un-checkable, self-explaining — and the remote deep-diff stops reporting the always-drifting store-metadata pseudo-entry.

**Architecture:** Core state detection and counting in `src/core/status.ts` (new `GroupState` value, `BucketCounts.none`, `diffRemote` filter). UI in `src/ui/panelModel.ts` (new filter key) and `src/ui/SyncModal.ts` + `styles.css` (pills, icon, dim row, disabled checkbox, expand note). Ribbon/menu need no code change — they read `up`/`down` from `bucketCounts`.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, obsidian-cli for live verification.

**Spec:** `docs/superpowers/specs/2026-07-12-no-settings-yet-design.md`. Visual ground truth: `.superpowers/brainstorm/9047-1783841141/content/nothing-to-sync.html` (wording B).

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/core/*` and `src/ui/panelModel.ts`: no `obsidian` imports, no DOM.
- Buckets: ↑ = `local-changed` + `not-captured`; ↓ = `store-newer` + `differs`; ✓ = `in-sync`; ○ = `no-settings`. `All = up + down + ok + none` everywhere.
- Copy strings verbatim: filter pill `No settings yet {n}`; title/section pill `○ {n}`; icon tip `no settings yet — nothing on this device or in the store`; expand note `no settings yet on this device or in the store — appears under “To capture” once this item has settings` (curly quotes around To capture).
- Capture/apply/pull/push behavior, reports, commands, settings: unchanged.
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read the output, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait 6 s, re-check. NEVER chain the guard with `&&`.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Core — `no-settings` state, fourth bucket, diffRemote de-noise

**Files:**
- Modify: `src/core/status.ts` (GroupState line 8, `groupStatus`, `compareFile`, `compareDir`, `BucketCounts`/`bucketCounts` ~lines 104-120, `diffRemote` return ~line 183)
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces: `GroupState` gains `"no-settings"`; `BucketCounts` gains `none: number`; `bucketCounts` counts `no-settings` into `none`; `diffRemote` never returns an entry with `group === ""`. Task 2 relies on exactly these.

- [ ] **Step 1: Write the failing tests**

In `tests/status.test.ts`, append inside `describe("statusForGroups", ...)` (reuse the file's `setup`/`seededAndCaptured`/`allStates` helpers):

```ts
  it("reports no-settings when neither this device nor the store has files", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/config-sync.json": MANIFEST, ".obs/hotkeys.json": '{"a":1}' });
    // hotkeys: local only -> not-captured; snippets dir + plugin-demo file: nothing anywhere -> no-settings
    const states = await allStates(ctx);
    expect(states).toEqual({ hotkeys: "not-captured", snippets: "no-settings", "plugin-demo": "no-settings" });
  });

  it("keeps deletion-only differs when the store has files but this device does not", async () => {
    const { io, ctx } = await seededAndCaptured();
    io.remove(".obs/hotkeys.json");
    expect((await allStates(ctx))["hotkeys"]).toBe("differs");
  });
```

(If `MemFS` has no `remove`, check `tests/memfs.ts` for the deletion helper it does have and use that; the assertion contract is binding.)

Replace the existing `bucketCounts` test (in `describe("bucketCounts", ...)`) with:

```ts
  it("bucketCounts groups the six states into capture/apply/ok/none buckets", () => {
    const statuses: GroupStatus[] = [
      { group: "a", state: "local-changed" },
      { group: "b", state: "not-captured" },
      { group: "c", state: "store-newer" },
      { group: "d", state: "differs" },
      { group: "e", state: "in-sync" },
      { group: "f", state: "no-settings" },
    ];
    expect(bucketCounts(statuses)).toEqual({ up: 2, down: 2, ok: 1, none: 1 });
  });
```

In `describe("diffRemote", ...)`, REWRITE the existing test `"omits the metadata entry when config-sync.json and store.lock.json match, includes it when they differ"` (lines ~133-149) — its second half asserts the old contract and must flip:

```ts
  it("never reports the store-metadata pseudo-entry, even when bookkeeping files differ", async () => {
    const { io, ctx } = await seededAndCaptured();
    const remote: Record<string, string> = {
      "config-sync.json": '{"version":1,"groups":[]}', // differs from local manifest
      "store.lock.json": JSON.stringify({ capturedAt: "2026-07-09T00:00:00.000Z", groups: {} }), // differs from local lock
      "store/configdir/hotkeys.json": '{"a":1}',
      "store/configdir/snippets/one.css": "one",
      "store/configdir/plugins/demo/data.json": await io.read("cs/store/configdir/plugins/demo/data.json"),
    };
    const entries = await diffRemote(ctx, fakeReader(remote));
    expect(entries).toEqual([]); // bookkeeping drift alone means "matches"
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL — `no-settings` not a `GroupState`; bucketCounts lacks `none`; diffRemote returns the `""` entry.

- [ ] **Step 3: Implement**

`src/core/status.ts`:

Line 8:

```ts
export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured" | "no-settings";
```

`Comparison` type and `groupStatus`:

```ts
type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; liveFiles: string[] };
```

In `groupStatus`, after the `cmp` assignment add the new branch first:

```ts
  if (cmp === "no-settings") return { group: group.name, state: "no-settings" };
  if (cmp === "not-captured") return { group: group.name, state: "not-captured" };
```

`compareFile` — replace the first line:

```ts
  if (!(await ctx.io.exists(store))) {
    return (await ctx.io.exists(real)) ? "not-captured" : "no-settings";
  }
```

`compareDir` — replace the first two lines so the live listing is computed once and reused:

```ts
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return liveFiles.length === 0 ? "no-settings" : "not-captured";
```

(and delete the now-duplicate `const liveFiles = ...` line that followed the old early return).

`BucketCounts` / `bucketCounts`:

```ts
export interface BucketCounts {
  up: number; // resolved by Capture: changed here + never captured
  down: number; // resolved by Apply: store newer + differs
  ok: number;
  none: number; // no files on either side — nothing to do
}

export function bucketCounts(statuses: GroupStatus[]): BucketCounts {
  let up = 0;
  let down = 0;
  let ok = 0;
  let none = 0;
  for (const s of statuses) {
    if (s.state === "local-changed" || s.state === "not-captured") up++;
    else if (s.state === "store-newer" || s.state === "differs") down++;
    else if (s.state === "no-settings") none++;
    else ok++;
  }
  return { up, down, ok, none };
}
```

`diffRemote` — last line becomes:

```ts
  // The "" store-metadata pseudo-entry (lock + manifest bookkeeping) drifts on every capture;
  // it is not a difference worth reporting here. Pull/push REPORTS still show it.
  return [...byName.values()].filter((e) => e.group !== "" && hasChanges(e.changes));
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/status.test.ts`, then `npm test` (a `bucketCounts` consumer compiling against the new field may need no change — TS structural widening is compatible).

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/core/status.ts tests/status.test.ts
git commit -m "feat: no-settings group state, fourth bucket, remote diff drops store-metadata noise"
```

---

### Task 2: UI — pills, filter, dim inert rows, expand note

**Files:**
- Modify: `src/ui/panelModel.ts`, `src/ui/SyncModal.ts`, `styles.css`
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: Task 1's `GroupState "no-settings"`, `bucketCounts(...).none`.
- Produces: `PanelFilter` gains `"none"`. Nothing later depends on this task.

- [ ] **Step 1: Failing panelModel tests**

Append to `tests/panelModel.test.ts` inside `describe("visibleUnderFilter", ...)`:

```ts
  it("none shows no-settings only; capture and ok exclude it; all includes it", () => {
    expect(visibleUnderFilter("no-settings", "none")).toBe(true);
    expect(visibleUnderFilter("in-sync", "none")).toBe(false);
    expect(visibleUnderFilter("local-changed", "none")).toBe(false);
    expect(visibleUnderFilter("no-settings", "capture")).toBe(false);
    expect(visibleUnderFilter("no-settings", "apply")).toBe(false);
    expect(visibleUnderFilter("no-settings", "ok")).toBe(false);
    expect(visibleUnderFilter("no-settings", "all")).toBe(true);
  });
```

Run: `npx vitest run tests/panelModel.test.ts` — FAIL (`"none"` not a `PanelFilter`).

- [ ] **Step 2: panelModel implementation**

`src/ui/panelModel.ts`:

```ts
export type PanelFilter = "all" | "capture" | "apply" | "ok" | "none";
```

and in `visibleUnderFilter`, before the final `return state === "in-sync";` line add:

```ts
  if (filter === "none") return state === "no-settings";
```

The existing `ok` branch (`return state === "in-sync"`) already excludes `no-settings`; the `capture` branch lists its two states explicitly and needs no change.

Run: `npx vitest run tests/panelModel.test.ts` — PASS.

- [ ] **Step 3: SyncModal edits**

All in `src/ui/SyncModal.ts` (line numbers reference the current file):

1. `renderHeaderPills` (~line 120): destructure `none` too, and after the ✓ pill block append:

```ts
    if (none > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-none",
        text: `○ ${none}`,
        attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
      });
    }
```

2. `renderDeviceMacro` section pills (~line 166): after the `counts.ok` pill line add:

```ts
      if (counts.none > 0) sect.createSpan({ cls: "config-sync-pill is-none", text: `○ ${counts.none}` });
```

(The default-collapse expression `counts.up === 0 && counts.down === 0` stays untouched. The `filter === "all"` branch stays untouched — `no-settings` rows are not `in-sync`, so they already render as rows, not in the ✓ line.)

3. `renderFilterBar` (~line 207): add a fifth def after `ok`:

```ts
      { key: "none", label: `No settings yet ${counts.none}` },
```

4. `wireSectionCheckbox` (~line 224):

```ts
    const checkable = inCat
      .filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings")
      .map((r) => r.group.name);
```

5. `renderItemRow` (~lines 250-265): replace the `insync` const and its two uses:

```ts
    const inert = status.state === "in-sync" || status.state === "no-settings";
    const row = card.createDiv({
      cls: `config-sync-hub-row${inert ? " is-insync" : ""}${status.state === "no-settings" ? " is-nosettings" : ""}`,
      attr: { "aria-label": this.host.resolvedPath(group) },
    });
```

and `cb.disabled = inert;`.

6. `stateIcon` (~line 285): add a case before `in-sync`:

```ts
      case "no-settings":
        return { glyph: "○", cls: "is-none", tip: "no settings yet — nothing on this device or in the store" };
```

7. `renderItemDetail` (~line 302): after the `in-sync` branch add:

```ts
    if (status.state === "no-settings") {
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: "no settings yet on this device or in the store — appears under “To capture” once this item has settings",
      });
      return;
    }
```

- [ ] **Step 4: CSS**

`styles.css` — next to the other `.config-sync-pill.is-*` rules add:

```css
.config-sync-pill.is-none { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }
```

next to the `.config-sync-state-icon` color rules add:

```css
.config-sync-state-icon.is-none { color: var(--text-faint); }
```

and next to the `.config-sync-hub-row` rules add:

```css
.config-sync-hub-row.is-nosettings .config-sync-rule-name { color: var(--text-muted); font-weight: 400; }
```

(Check the existing state-icon color rules' selector form first — if they use a different pattern like `.config-sync-state-icon.is-miss`, match it.)

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: all tests pass (Task 1's included), build clean, 0 lint errors.

```bash
git add src/ui/panelModel.ts src/ui/SyncModal.ts styles.css tests/panelModel.test.ts
git commit -m "feat: no-settings items are inert in the sync panel with their own pill and filter"
```

---

### Task 3: Live smoke

No file changes expected (screenshot refresh not needed — the shipped README screenshot has no ○ items and stays representative).

- [ ] **Step 1: Install + reload (guard first, standalone).** `npm run smoke:install`, reload the plugin via obsidian-cli eval.

- [ ] **Step 2: Stage.** Back up `dev/vault/config-sync/config-sync.json`. Append a group `{"name": "plugin-demo", "path": "{configDir}/plugins/demo/data.json", "type": "file", "devices": "all"}` — no file exists on either side. Reload plugin.

- [ ] **Step 3: Verify (guard first, standalone; DOM dumps via eval + one screenshot).**
1. plugin-demo row: `○` icon, dim name, disabled checkbox; expand shows the verbatim note.
2. Title pills show `○ 1` (gray); Community section head shows `○ 1`; filter bar shows `No settings yet 1`; `All` count includes it; `To capture` filter does NOT list it and its count excludes it.
3. Section select-all in its section does not check it; action bar Capture count excludes it.
4. Ribbon dot: with everything else in sync and one ○ item, no orange dot (`p.localStatuses` via eval or tooltip check).
5. Write `.obsidian/plugins/demo/data.json` (e.g. `{"x":1}`) → refresh → row flips to `—` under `To capture 1`; orange awareness returns.
6. Remote lock-only diff: copy the dev store to the scratchpad, edit the copy's `store.lock.json` `capturedAt` to a different time, add it as a vault-type remote in the plugin's `data.json` (`remotes: [{"name":"lockonly","type":"vault","storePath":"<scratchpad copy>"}]`), reload, open panel, expand the remote → expect `✓ remote matches the local store` (no `store metadata ~1`).

- [ ] **Step 4: Clean up.** Restore `config-sync.json` and `data.json` from backups, delete `.obsidian/plugins/demo/`, remove the scratchpad store copy, reload, confirm all in-sync and `dev:errors` clean.

---

## Verification after all tasks

1. Full gate; `grep -rn "no-settings" src/` shows status.ts + panelModel.ts + SyncModal.ts only.
2. `grep -n '"" ' src/core/status.ts` — diffRemote's filter present; ReportModal's "Store metadata" section untouched (`grep -n "Store metadata" src/ui/ReportModal.ts` still matches).
3. Smoke evidence in the ledger: ○ row + counts, flip to `—` after file creation, lock-only remote shows "matches".
