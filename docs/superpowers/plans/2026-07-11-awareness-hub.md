# Awareness + Sync Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change-aware engine (per-file added/updated/deleted everywhere, selective capture, remote deep diff), passive awareness (vault-event + periodic + remote auto-check, ribbon status dot), one Sync panel replacing the Status/Apply modals, verdict-style reports, and the command surface consolidated to Sync + Revert.

**Architecture:** Core gains `FileChanges` classification threaded through capture/apply/pull/push/status plus `diffRemote`; `ExternalStoreWriter` gains `readFile` so push can compare-before-write. `main.ts` hosts the awareness runtime (events, timers, caches, ribbon dot) and exposes a `SyncModalHost` interface consumed by the new `SyncModal`. `ReportModal` is rewritten around `GroupResult.changes`.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/core/*`: zero Node-builtin/`obsidian` imports.
- **Four-color action system:** Capture = orange (`--color-orange`), Apply = purple (`--interactive-accent`), Pull = cyan (`--color-cyan`), Push = pink (`--color-pink`). No action borrows another's color.
- User-facing copy says **item(s)**, never "group". `config-sync.json`'s `groups` key and Advanced-tab "rules" unchanged.
- Direction hints are labeled guesses — tooltips include "(likely)".
- The ribbon menu and the Sync panel must never fail to open (awareness failures → `console.error` + degraded display).
- No migration: removed settings keys (`statusInPickers`, old ribbon keys) are ignored if present in data.json.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.
- `noUncheckedIndexedAccess` is on — guard array indexing.
- Copy strings verbatim where a task specifies them.

---

### Task 1: Core — `FileChanges` classification, selective capture, apply classification, status full-diff, category helper

**Files:**
- Modify: `src/core/types.ts`, `src/core/ConfigSyncCore.ts`, `src/core/status.ts`, `src/core/catalog.ts`
- Test: `tests/core.test.ts`, `tests/status.test.ts`, `tests/catalog.test.ts`

**Interfaces:**
- Produces (later tasks rely on):
  - `export interface FileChanges { added: string[]; updated: string[]; deleted: string[] }` (types.ts). Entries are **group-relative** names (dir groups: rel path inside the group; file groups: the file's basename).
  - `GroupResult.changes: FileChanges` (always present; `emptyResult` initializes empties).
  - `export function hasChanges(c: FileChanges): boolean` (types.ts): any array non-empty.
  - `capture(ctx, names?: string[])` — omitted = all groups; provided = only those captured; the lock still rewrites: selected groups stamp current versions per existing rules, **all other groups carry forward** their previous lock entries.
  - `GroupStatus.changes?: FileChanges` — populated for every non-`in-sync`, non-`not-captured` state.
  - `export type ItemCategory = "obsidian" | "core" | "community" | "custom"`, `export function categoryForGroup(name: string): ItemCategory`, `export const CATEGORY_LABELS: Record<ItemCategory, string>` (catalog.ts).

- [ ] **Step 1: Failing tests**

`tests/catalog.test.ts` (append):

```ts
it("categorizes group names", () => {
  expect(categoryForGroup("themes")).toBe("obsidian");
  expect(categoryForGroup("daily-notes")).toBe("core");
  expect(categoryForGroup("plugin-dataview")).toBe("community");
  expect(categoryForGroup("my-vimrc")).toBe("custom");
});
```

(`daily-notes` must be a member of `CORE_SETTINGS_IDS` — check the array and use any real entry.)

`tests/core.test.ts` (append inside `describe("capture", …)`):

```ts
it("classifies capture changes and skips unchanged writes", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
  });
  await capture(ctx);
  await io.write(".obs/snippets/two.css", "two");   // added
  await io.write(".obs/snippets/one.css", "ONE");   // updated
  const results = await capture(ctx);
  const snip = results.find((r) => r.group === "snippets");
  expect(snip?.changes).toEqual({ added: ["two.css"], updated: ["one.css"], deleted: [] });
  const hk = results.find((r) => r.group === "hotkeys");
  expect(hk?.changes).toEqual({ added: [], updated: [], deleted: [] });
  expect(hk?.filesWritten).toEqual([]); // unchanged → not rewritten
});

it("selective capture touches only named items and carries the rest in the lock", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
  });
  await capture(ctx); // demo stamped 1.2.3
  plugins.installed.set("demo", "9.9.9");
  await io.write(".obs/hotkeys.json", '{"a":2}');
  await io.write(".obs/plugins/demo/data.json", '{"x":1}');
  const results = await capture(ctx, ["hotkeys"]);
  expect(results.map((r) => r.group)).toEqual(["hotkeys"]);
  expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":2}');
  expect(await io.read("cs/store/configdir/plugins/demo/data.json")).toBe("{}"); // untouched
  const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion: string }> };
  expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3" }); // carried, not restamped
});
```

`tests/core.test.ts` (append inside the apply describe — find it via `grep -n 'describe("apply' tests/core.test.ts`):

```ts
it("classifies apply changes and skips identical writes", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  io.seed({
    "cs/config-sync.json": MANIFEST,
    ".obs/hotkeys.json": '{"a":1}',
    ".obs/snippets/one.css": "one",
    ".obsidian.vimrc": "v",
    ".obs/plugins/demo/data.json": "{}",
  });
  await capture(ctx);
  await io.write("cs/store/configdir/hotkeys.json", '{"a":9}');    // store updated elsewhere
  const results = await apply(ctx, ["hotkeys", "snippets"]);
  const hk = results.find((r) => r.group === "hotkeys");
  expect(hk?.changes.updated).toEqual(["hotkeys.json"]);
  const snip = results.find((r) => r.group === "snippets");
  expect(snip?.changes).toEqual({ added: [], updated: [], deleted: [] });
  expect(snip?.filesWritten).toEqual([]); // identical → skipped
});
```

`tests/status.test.ts` (append):

```ts
it("collects full file-level changes for differing items", async () => {
  const { io, ctx } = await seededAndCaptured();
  await io.write(".obs/snippets/two.css", "two");          // added live
  await io.write(".obs/snippets/one.css", "ONE");          // updated
  await io.remove("cs/store/configdir/snippets/one.css");  // keep store copy? no — simulate deletion the other way:
  // (re-seed store copy so 'one.css' compares as updated, and delete a third from live)
  io.seed({ "cs/store/configdir/snippets/one.css": "one", "cs/store/configdir/snippets/three.css": "three" });
  const manifest = await loadManifest(ctx);
  const statuses = await statusForGroups(ctx, groupsForDevice(manifest, "desktop"));
  const snip = statuses.find((s) => s.group === "snippets");
  expect(snip?.changes?.added).toEqual(["two.css"]);
  expect(snip?.changes?.updated).toEqual(["one.css"]);
  expect(snip?.changes?.deleted).toEqual(["three.css"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/core.test.ts tests/status.test.ts tests/catalog.test.ts`
Expected: FAIL — `changes` undefined, `capture` rejects a second argument, `categoryForGroup` missing.

- [ ] **Step 3: Implement**

`src/core/types.ts`:

```ts
export interface FileChanges {
  added: string[];
  updated: string[];
  deleted: string[];
}

export function hasChanges(c: FileChanges): boolean {
  return c.added.length > 0 || c.updated.length > 0 || c.deleted.length > 0;
}
```

Add `changes: FileChanges;` to `GroupResult`.

`src/core/catalog.ts` (append; reuse the file's existing `OPTION_LABELS`, `optionReservedName`, `CORE_SETTINGS_IDS`):

```ts
export type ItemCategory = "obsidian" | "core" | "community" | "custom";

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  community: "Community plugins",
  custom: "Custom",
};

export function categoryForGroup(name: string): ItemCategory {
  for (const file of Object.keys(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return "obsidian";
  }
  if (CORE_SETTINGS_IDS.includes(name)) return "core";
  if (name.startsWith("plugin-")) return "community";
  return "custom";
}
```

`src/core/ConfigSyncCore.ts`:

- `emptyResult` initializes `changes: { added: [], updated: [], deleted: [] }`.
- Add a shared helper near `emptyResult`:

```ts
async function writeClassified(
  ctx: CoreContext,
  target: string,
  content: string,
  relName: string,
  result: GroupResult
): Promise<void> {
  const existed = await ctx.io.exists(target);
  if (existed && (await ctx.io.read(target)) === content) return; // unchanged: skip the write
  await ensureParentDir(ctx.io, target);
  await ctx.io.write(target, content);
  result.filesWritten.push(target);
  (existed ? result.changes.updated : result.changes.added).push(relName);
}
```

- `captureGroup` file branch: replace the ensureParentDir+write+push block with `await writeClassified(ctx, store, content, basename(real), result);` (import `basename` from `./pathing` — it exists there; if the export is missing, add `export function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }`).
- `captureGroup` dir branch: per rel, `await writeClassified(ctx, target, await ctx.io.read(`${real}/${rel}`), rel, result);` and in the deletion loop also `result.changes.deleted.push(relativeTo(store, f));`.
- `capture(ctx, names?: string[])`: add the optional param; `const selected = names === undefined ? null : new Set(names);` inside the loop, first line:

```ts
if (selected !== null && !selected.has(group.name)) {
  const prev = previous?.groups[group.name];
  if (prev !== undefined) lock.groups[group.name] = prev; // not captured this run — carry forward
  continue;
}
```

(The existing errored-capture carry-forward stays as-is for selected groups.)
- `applyGroup` (the function writing live files during apply): route every file write through the same compare-first pattern — skip identical writes, classify into `result.changes` with group-relative names (file groups: `basename(real)`; dir groups: rel), and classify live deletions (dir groups' deletion propagation) into `changes.deleted`. The sanitized-key merge logic is untouched — classification compares the FINAL merged content against the current live content.

`src/core/status.ts`: `compareFile`/`compareDir` stop early-returning; both build a full `FileChanges` (live-only → `added`, store-only → `deleted`, both-but-different → `updated`; sanitize groups compare canonically as today for the single file). `Comparison` becomes `"not-captured" | { changes: FileChanges; liveFiles: string[] }` where empty changes ⇒ in-sync. `groupStatus` sets `changes` on the returned `GroupStatus` for differing states. Add `changes?: FileChanges` to `GroupStatus` (import `FileChanges` from `./types`).

- [ ] **Step 4: Green + fix count assertions**

Run: `npx vitest run tests/core.test.ts tests/status.test.ts tests/catalog.test.ts` — adjust any pre-existing assertions that counted `filesWritten` on unchanged files (they are now skipped; e.g. a second capture writes nothing). Then full `npm test`.
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
git add src/core tests
git commit -m "feat: file-level change classification, selective capture, status full diffs"
```

---

### Task 2: Core — per-item pull/push, writer readFile, `diffRemote`

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`importExternal`, `pushExternal`, `ExternalStoreWriter`), `src/external/localPath.ts`, `src/external/gitSource.ts`
- Test: `tests/core.test.ts`, `tests/external.test.ts`, `tests/status.test.ts` (diffRemote lives in `src/core/status.ts`)

**Interfaces:**
- Consumes: `FileChanges`/`hasChanges`, `emptyResult`, `groupStorePath`, Task 1's `writeClassified` pattern.
- Produces:
  - `ExternalStoreWriter.readFile(relPath: string): Promise<string>` (both writers implement it).
  - `importExternal(ctx, reader): Promise<GroupResult[]>` and `pushExternal(ctx, writer): Promise<GroupResult[]>` — one result per affected item, plus a pseudo-result `group: ""` for store metadata (`config-sync.json`, `store.lock.json`, unmatched rels). Unaffected items produce NO result.
  - In `src/core/status.ts`: `export interface RemoteDiffEntry { group: string; changes: FileChanges }` and `export async function diffRemote(ctx: CoreContext, reader: ExternalStoreReader): Promise<RemoteDiffEntry[]>` (entries only for differing items + `""` metadata when it differs; direction-neutral: `added` = present only on the remote).

- [ ] **Step 1: Failing tests**

`tests/core.test.ts` — rework the `importExternal`/`pushExternal` describes: the fake reader/writer fixtures stay; assertions change to per-item results. Add (representative; adapt the existing fixture names — the current tests build `fakeReader`-style objects inline):

```ts
it("maps pulled changes to items and skips identical files", async () => {
  const { io, ctx } = setup();
  io.seed({ "cs/config-sync.json": MANIFEST, "cs/store/configdir/hotkeys.json": '{"a":1}' });
  const remote: Record<string, string> = {
    "config-sync.json": MANIFEST,
    "store/configdir/hotkeys.json": '{"a":2}',
    "store/configdir/snippets/one.css": "one",
  };
  const reader = {
    listFiles: async () => Object.keys(remote).sort(),
    readFile: async (r: string) => {
      const c = remote[r];
      if (c === undefined) throw new Error(`no ${r}`);
      return c;
    },
  };
  const results = await importExternal(ctx, reader);
  const byGroup = Object.fromEntries(results.map((r) => [r.group, r.changes]));
  expect(byGroup["hotkeys"]).toEqual({ added: [], updated: ["hotkeys.json"], deleted: [] });
  expect(byGroup["snippets"]).toEqual({ added: ["one.css"], updated: [], deleted: [] });
  expect(byGroup[""]).toBeDefined(); // config-sync.json differs from absent local copy? it was seeded identical → adjust: metadata entry exists only when changed
});
```

(Author the final assertions to match the seeded fixture precisely: seed the local `cs/config-sync.json` identical to the remote one so the `""` entry is ABSENT, and assert `byGroup[""]` undefined.)

Push test: mirror it through a fake writer object `{ files: Record<string,string>; listFiles; readFile; writeFile; deleteFile; finalize }`, asserting identical files are not rewritten (`writeFile` call log) and per-item `changes`.

`tests/status.test.ts` — diffRemote:

```ts
it("diffRemote reports per-item differences against the local store", async () => {
  const { io, ctx } = await seededAndCaptured();
  const remote: Record<string, string> = {
    "config-sync.json": await io.read("cs/config-sync.json"),
    "store.lock.json": await io.read("cs/store.lock.json"),
    "store/configdir/hotkeys.json": '{"a":1}', // same as local
    "store/configdir/snippets/one.css": "REMOTE", // differs
    "store/configdir/snippets/extra.css": "x", // remote-only
  };
  const entries = await diffRemote(ctx, fakeReader(remote));
  const snip = entries.find((e) => e.group === "snippets");
  expect(snip?.changes.updated).toEqual(["one.css"]);
  expect(snip?.changes.added).toEqual(["extra.css"]);
  expect(entries.find((e) => e.group === "hotkeys")).toBeUndefined();
});
```

`tests/external.test.ts`: add `readFile` round-trips for both writers (write a file via the writer, read it back via `writer.readFile`).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/core.test.ts tests/status.test.ts tests/external.test.ts`; FAIL (readFile missing, single-result shape).

- [ ] **Step 3: Implement**

Shared rel→group mapping in `src/core/ConfigSyncCore.ts`:

```ts
function groupForStoreRel(groups: SyncGroup[], rel: string): { name: string; itemRel: string } {
  if (rel.startsWith("store/")) {
    const inner = rel.slice("store/".length);
    for (const g of groups) {
      const sp = groupStorePath(g.path);
      if (g.type === "file" && inner === sp) return { name: g.name, itemRel: basename(sp) };
      if (g.type === "dir" && inner.startsWith(sp + "/")) return { name: g.name, itemRel: inner.slice(sp.length + 1) };
    }
  }
  return { name: "", itemRel: rel }; // store metadata / unmatched
}
```

`importExternal(ctx, reader): Promise<GroupResult[]>`:
- Same preamble (config-sync.json presence + fail-fast parse; keep the parsed incoming manifest as the mapping source).
- Maintain `const byName = new Map<string, GroupResult>()` with a `resultFor(name)` getter creating `emptyResult(name, false)` lazily.
- Write loop: compare-before-write against local `${ctx.rootPath}/${rel}` (skip identical; classify added/updated with `itemRel` from `groupForStoreRel(incoming.groups, rel)`); keep populating `filesWritten` on real writes.
- Deletion loop: classify each removal into its owning result's `changes.deleted` + `filesDeleted`.
- Return `[...byName.values()]` (order: manifest order for named items, `""` last).

`pushExternal(ctx, writer): Promise<GroupResult[]>`:
- Load the LOCAL manifest for mapping (`await loadManifest(ctx)` — pushExternal currently doesn't load it; add).
- Read remote list once into a `Set`; for each local rel: if remote has it, `writer.readFile(rel)` and skip when identical, else classify updated; missing remotely → added. Deletions classified likewise. `finalize()` unchanged.

`ExternalStoreWriter` interface gains `readFile(relPath: string): Promise<string>;`. Implementations:
- `src/external/localPath.ts` writer: `async readFile(relPath) { return fs.readFile(nodePath.join(base, relPath), "utf8"); }`
- `src/external/gitSource.ts` writer: `async readFile(relPath) { return readFile(nodePath.join(base, relPath), "utf8"); }` (add `readFile` to the `fs/promises` destructuring).

`src/core/status.ts`:

```ts
export interface RemoteDiffEntry {
  group: string;
  changes: FileChanges;
}

export async function diffRemote(ctx: CoreContext, reader: ExternalStoreReader): Promise<RemoteDiffEntry[]> {
  const manifest = await loadManifest(ctx);
  const remoteFiles = await reader.listFiles();
  const localFiles = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const localRels = new Set(localFiles.map((f) => f.slice(ctx.rootPath.length + 1)));
  const byName = new Map<string, RemoteDiffEntry>();
  const entry = (name: string): RemoteDiffEntry => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { group: name, changes: { added: [], updated: [], deleted: [] } };
      byName.set(name, e);
    }
    return e;
  };
  for (const rel of remoteFiles) {
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    if (!localRels.has(rel)) {
      entry(name).changes.added.push(itemRel);
    } else if ((await reader.readFile(rel)) !== (await ctx.io.read(`${ctx.rootPath}/${rel}`))) {
      entry(name).changes.updated.push(itemRel);
    }
  }
  const remoteSet = new Set(remoteFiles);
  for (const rel of localRels) {
    if (!remoteSet.has(rel)) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
      entry(name).changes.deleted.push(itemRel);
    }
  }
  return [...byName.values()].filter((e) => hasChanges(e.changes));
}
```

(`groupForStoreRel`, `loadManifest`, `listFilesRecursive` exported from ConfigSyncCore/io as needed — export `groupForStoreRel`.)

- [ ] **Step 4: Green** — targeted files, then `npm test`.
- [ ] **Step 5: Gate + commit**

```bash
git add src/core src/external tests
git commit -m "feat: per-item pull/push results, writer readFile, remote deep diff"
```

---

### Task 3: Report rework

**Files:**
- Modify: `src/ui/ReportModal.ts` (full rewrite), `styles.css`
- Verify call sites still compile (`src/main.ts` — signature kept compatible below).

**Interfaces:**
- Consumes: `GroupResult.changes`/`hasChanges`, `categoryForGroup`/`CATEGORY_LABELS`.
- Produces: `new ReportModal(app, title: string, results: GroupResult[], subtitle?: string)` — existing call sites keep working (they update titles in Task 6). The modal partitions internally: **changed** = `status !== "ok"` OR `hasChanges(changes)`; **unchanged** = the rest.

- [ ] **Step 1: Rewrite `src/ui/ReportModal.ts`**

```ts
import { App, Modal, Setting } from "obsidian";
import { GroupResult, hasChanges } from "../core/types";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

const CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

export class ReportModal extends Modal {
  constructor(
    app: App,
    private modalTitle: string,
    private results: GroupResult[],
    private subtitle?: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.addClass("config-sync-report-title");
    this.titleEl.setText(this.modalTitle);
    const changed = this.results.filter((r) => r.status !== "ok" || hasChanges(r.changes));
    const unchanged = this.results.filter((r) => !changed.includes(r));
    const pills = this.titleEl.createSpan({ cls: "config-sync-report-pills" });
    pills.createSpan({ cls: "config-sync-pill is-neutral", text: `${changed.length} changed` });
    if (unchanged.length > 0) pills.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${unchanged.length}` });
    if (this.subtitle !== undefined) this.contentEl.createDiv({ cls: "config-sync-report-sub", text: this.subtitle });

    for (const cat of CATEGORY_ORDER) {
      const inCat = changed.filter((r) => r.group !== "" && categoryForGroup(r.group) === cat);
      if (inCat.length === 0) continue;
      this.contentEl.createDiv({ cls: "config-sync-sect", text: CATEGORY_LABELS[cat] });
      const block = this.contentEl.createDiv({ cls: "config-sync-card" });
      for (const r of inCat) this.renderRow(block, r);
    }
    const meta = changed.find((r) => r.group === "");
    if (meta !== undefined) {
      this.contentEl.createDiv({ cls: "config-sync-sect", text: "Store metadata" });
      this.renderRow(this.contentEl.createDiv({ cls: "config-sync-card" }), meta, "store metadata");
    }
    if (unchanged.length > 0) {
      const line = this.contentEl.createDiv({ cls: "config-sync-unchanged", text: `✓ ${unchanged.length} item${unchanged.length === 1 ? "" : "s"} unchanged ▸` });
      line.addEventListener("click", () => {
        line.setText(`✓ ${unchanged.map((r) => r.group).join(" · ")}`);
      });
    }
    if (this.results.some((r) => r.needsAppReload)) {
      new Setting(this.contentEl)
        .setName("Some changes need an app reload to take effect")
        .addButton((b) =>
          b.setCta().setButtonText("Reload app").onClick(() => {
            (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload");
          })
        );
    }
  }

  private renderRow(block: HTMLElement, r: GroupResult, label?: string): void {
    const isError = r.status !== "ok";
    const row = block.createDiv({ cls: "config-sync-report-row" });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: isError ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: label ?? r.group });
    if (isError) row.createSpan({ cls: "config-sync-pill is-warn", text: r.status === "warning" ? "⚠" : "✗" });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    const chip = (cls: string, text: string): void => {
      row.createSpan({ cls: `config-sync-chip ${cls}`, text });
    };
    if (r.changes.added.length > 0) chip("is-add", `+${r.changes.added.length}`);
    if (r.changes.updated.length > 0) chip("is-upd", `~${r.changes.updated.length}`);
    if (r.changes.deleted.length > 0) chip("is-del", `−${r.changes.deleted.length}`);
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

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: CSS** (append to `styles.css`; card/sect reuse the four-color vars):

```css
.config-sync-report-title { display: flex; align-items: center; gap: var(--size-4-2); }
.config-sync-report-pills { display: flex; gap: var(--size-4-1); margin-left: auto; }
.config-sync-pill { font-size: var(--font-ui-smaller); border-radius: 999px; padding: 0 var(--size-4-2); }
.config-sync-pill.is-neutral { background: var(--background-modifier-border); color: var(--text-normal); }
.config-sync-pill.is-ok { background: rgba(var(--color-green-rgb), 0.15); color: var(--color-green); }
.config-sync-pill.is-warn { background: none; color: var(--color-orange); margin-left: var(--size-4-1); }
.config-sync-report-sub { color: var(--text-muted); font-size: var(--font-ui-smaller); margin-bottom: var(--size-4-2); }
.config-sync-sect { font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: var(--size-4-3) 0 var(--size-4-1); }
.config-sync-card { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); padding: 0 var(--size-4-3); }
.config-sync-report-row { display: flex; align-items: center; gap: var(--size-4-2); padding: var(--size-4-2) 0; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; }
.config-sync-card > .config-sync-report-row:last-of-type { border-bottom: none; }
.config-sync-chip { font-size: var(--font-ui-smaller); border-radius: 999px; padding: 0 var(--size-4-2); flex: none; }
.config-sync-chip.is-add { background: rgba(var(--color-green-rgb), 0.15); color: var(--color-green); }
.config-sync-chip.is-upd { background: rgba(var(--color-blue-rgb), 0.15); color: var(--color-blue); }
.config-sync-chip.is-del { background: rgba(var(--color-red-rgb), 0.15); color: var(--color-red); }
.config-sync-report-files { font-family: var(--font-monospace); font-size: var(--font-ui-smaller); margin: 0 0 var(--size-4-2) var(--size-4-4); }
.config-sync-report-files .is-add { color: var(--color-green); }
.config-sync-report-files .is-upd { color: var(--color-blue); }
.config-sync-report-files .is-del { color: var(--color-red); text-decoration: line-through; }
.config-sync-unchanged { color: var(--text-muted); font-size: var(--font-ui-smaller); margin-top: var(--size-4-2); cursor: pointer; }
```

- [ ] **Step 3: Compile check** — `main.ts` call sites pass 3 args (`app, title, results`) — the new optional 4th is compatible; the empty-group pull/push mapping from iter10 now routes through the `""` metadata rendering. Run the gate.
- [ ] **Step 4: Commit**

```bash
git add src/ui/ReportModal.ts styles.css
git commit -m "feat: change-aware report modal with category cards and pills"
```

---

### Task 4: Awareness runtime (events, timers, remote cache, ribbon dot, settings)

**Files:**
- Modify: `src/main.ts`, `src/ui/SettingTab.ts`, `styles.css`

**Interfaces:**
- Consumes: `statusForGroups`, `checkRemote`, `loadLock`, `groupsForDevice`, `GroupStatus`.
- Produces (Task 6's host relies on): plugin fields/methods
  - `localStatuses: GroupStatus[] | null` (latest computation)
  - `remoteChecks: Map<string, { check: RemoteCheck; at: number }>`
  - `async refreshLocalStatus(): Promise<void>` — recompute + `updateRibbonDot()`; never throws (catch → console.error, statuses left as-were).
  - `async refreshRemoteChecks(): Promise<void>` — light check every remote (desktop), cache results (`unknown` + message on failure), then `updateRibbonDot()`.
  - `updateRibbonDot(): void` — classes on the main ribbon icon element: `config-sync-dot-capture` when any local-changed/differs, else `config-sync-dot-apply` when any store-newer OR any cached `remote-newer`; neither → both removed. Tooltip via `setAttribute("aria-label", …)`: `Config Sync — 2 changed here, 1 store-newer, remote "kickstart" newer` (segments only when non-zero/applicable; base label `Config Sync` when clean).
- Settings: interface/DEFAULT gain `remoteAutoCheck: true`, `localPeriodicCheck: true`; **remove `statusInPickers`** everywhere (interface, defaults, SettingTab toggle, `SettingsHost`).

- [ ] **Step 1: Settings + toggles**

`main.ts` settings interface/defaults as above. `SettingTab.ts`: replace the "Apply picker shows group status" toggle with two new Settings (verbatim copy):

```ts
new Setting(containerEl)
  .setName("Check remotes automatically")
  .setDesc("Checks each remote's last capture shortly after startup and every few hours.")
  .addToggle((t) =>
    t.setValue(this.host.settings.remoteAutoCheck).onChange(async (v) => {
      this.host.settings.remoteAutoCheck = v;
      await this.host.saveSettings();
    })
  );
new Setting(containerEl)
  .setName("Periodic local check")
  .setDesc("Re-scans for local changes every 5 minutes while the window is focused, keeping the ribbon dot fresh.")
  .addToggle((t) =>
    t.setValue(this.host.settings.localPeriodicCheck).onChange(async (v) => {
      this.host.settings.localPeriodicCheck = v;
      await this.host.saveSettings();
    })
  );
```

- [ ] **Step 2: Runtime in `main.ts` `onload` (after ribbon registration)**

```ts
// --- awareness runtime ---
this.registerEvent(this.app.vault.on("modify", (f) => this.onStoreFileEvent(f.path)));
this.registerEvent(this.app.vault.on("create", (f) => this.onStoreFileEvent(f.path)));
this.registerEvent(this.app.vault.on("delete", (f) => this.onStoreFileEvent(f.path)));
this.registerEvent(this.app.vault.on("rename", (f, old) => { this.onStoreFileEvent(f.path); this.onStoreFileEvent(old); }));
this.registerInterval(window.setInterval(() => {
  if (this.settings.localPeriodicCheck && document.hasFocus()) void this.refreshLocalStatus();
}, 5 * 60 * 1000));
if (Platform.isDesktop) {
  window.setTimeout(() => { if (this.settings.remoteAutoCheck) void this.refreshRemoteChecks(); }, 30 * 1000);
  this.registerInterval(window.setInterval(() => {
    if (this.settings.remoteAutoCheck) void this.refreshRemoteChecks();
  }, 4 * 60 * 60 * 1000));
}
this.app.workspace.onLayoutReady(() => void this.refreshLocalStatus());
```

Supporting members:

```ts
localStatuses: GroupStatus[] | null = null;
remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
private storeEventTimer: number | null = null;

private onStoreFileEvent(path: string): void {
  const root = this.settings.rootPath !== "" ? this.settings.rootPath : this.lastResolvedRoot;
  if (root === null || !(path === root || path.startsWith(root + "/"))) return;
  if (this.storeEventTimer !== null) window.clearTimeout(this.storeEventTimer);
  this.storeEventTimer = window.setTimeout(() => {
    this.storeEventTimer = null;
    void this.refreshLocalStatus();
  }, 2000);
}
```

(`lastResolvedRoot: string | null` — set inside `coreContext()`/`resolvedRootPath()` whenever the root is resolved; the guard tolerates null by skipping.)

```ts
async refreshLocalStatus(): Promise<void> {
  try {
    const ctx = await this.coreContext();
    const manifest = await loadManifest(ctx);
    const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
    this.localStatuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
  } catch (e) {
    console.error("Config Sync: status refresh failed", e);
  }
  this.updateRibbonDot();
}

async refreshRemoteChecks(): Promise<void> {
  if (!Platform.isDesktop) return;
  let localLock: StoreLock | null = null;
  try {
    localLock = await loadLock(await this.coreContext());
  } catch {
    localLock = null;
  }
  for (const remote of this.settings.remotes) {
    try {
      const reader = await this.createReader(remote);
      this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader), at: Date.now() });
    } catch (e) {
      this.remoteChecks.set(remote.name, { check: { state: "unknown", remoteCapturedAt: null }, at: Date.now() });
      console.error(`Config Sync: remote check failed for ${remote.name}`, e);
    }
  }
  this.updateRibbonDot();
}

updateRibbonDot(): void {
  const el = this.mainRibbonEl;
  if (el === null) return;
  const s = this.localStatuses ?? [];
  const changedHere = s.filter((x) => x.state === "local-changed" || x.state === "differs").length;
  const storeNewer = s.filter((x) => x.state === "store-newer").length;
  const remoteNewer = [...this.remoteChecks.entries()].filter(([, v]) => v.check.state === "remote-newer").map(([k]) => k);
  el.toggleClass("config-sync-dot-capture", changedHere > 0);
  el.toggleClass("config-sync-dot-apply", changedHere === 0 && (storeNewer > 0 || remoteNewer.length > 0));
  const parts: string[] = [];
  if (changedHere > 0) parts.push(`${changedHere} changed here`);
  if (storeNewer > 0) parts.push(`${storeNewer} store-newer`);
  for (const name of remoteNewer) parts.push(`remote "${name}" newer`);
  el.setAttribute("aria-label", parts.length > 0 ? `Config Sync — ${parts.join(", ")}` : "Config Sync");
}
```

(`mainRibbonEl: HTMLElement | null` — capture the return of the existing `addRibbonIcon` for the main icon. Recompute after `runCapture`/`applyGroups`/`pullFrom`/`pushTo` complete: add `void this.refreshLocalStatus();` at the end of each success path — Task 6 rewires these anyway; add it now where they currently live.)

- [ ] **Step 3: Dot CSS** (append):

```css
.config-sync-dot-capture, .config-sync-dot-apply { position: relative; }
.config-sync-dot-capture::after, .config-sync-dot-apply::after {
  content: "";
  position: absolute;
  top: 2px;
  right: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.config-sync-dot-capture::after { background: var(--color-orange); }
.config-sync-dot-apply::after { background: var(--color-blue); }
```

- [ ] **Step 4: Gate + commit**

```bash
git add src/main.ts src/ui/SettingTab.ts styles.css
git commit -m "feat: passive awareness runtime with ribbon status dot"
```

---

### Task 5: SyncModal component

**Files:**
- Create: `src/ui/SyncModal.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `GroupStatus`/`GroupState`/`RemoteCheck`/`RemoteDiffEntry`, `SyncGroup`, `Remote`, `ItemCategory`/`categoryForGroup`/`CATEGORY_LABELS`, `hasChanges`.
- Produces:

```ts
export interface SyncModalHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[] }>;
  resolvedPath(group: SyncGroup): string;
  captureItems(names: string[]): Promise<void>;   // runs selective capture + shows its report
  applyItems(names: string[]): Promise<void>;     // warnings-confirm + apply + report
  remotes(): Remote[];                            // [] on mobile
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  deepDiff(remote: Remote): Promise<RemoteDiffEntry[]>;
  pullFrom(remote: Remote): Promise<void>;
  pushTo(remote: Remote): Promise<void>;
}
export class SyncModal extends Modal {
  constructor(app: App, host: SyncModalHost) …
}
```

Behavioral contract (all binding, from the spec/v13):

- `onOpen`: disable scrim-close first — `const bg = this.containerEl.children[0] as HTMLElement; bg.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true });` — Esc/× still close. Then `void this.reload()`.
- `reload()`: `host.computeStatuses()`, rebuild everything (render-generation guard against overlapping reloads); selections reset to defaults on reload: pre-check `local-changed` (capture direction) and `store-newer` (apply direction); `differs` and `not-captured` NOT pre-checked; `in-sync` disabled.
- Header: `Config Sync` + pills `↑ N` (orange) / `↓ N` (purple) / `✓ N` (green); tooltips: `N item(s) changed on this device` / `N item(s): store is newer` / `N item(s) in sync`.
- Macro-block 1 (`This device ↔ store` heading) contains per-category sub-cards; each category heading carries a tri-state checkbox (all checkable rows ↔ none; indeterminate via `el.indeterminate = true` on a real `<input type="checkbox">`); item rows: chevron · mono name · dim resolved path (ellipsis) · state icon span (`↑` orange, `↓` purple, `≠` gray, `✓` green, `—` gray; `aria-label` tooltip with "(likely)" where applicable) · direction checkbox (native `<input type="checkbox">` with class `is-capture` (orange accent) or `is-apply` (purple accent); disabled for `in-sync`).
- Checked `differs` rows show `⚠ applying overwrites local changes` under the row.
- Row click (outside inputs) toggles a file-diff detail div fed by `status.changes` (`+`/`~`/`−` rendering identical to ReportModal's).
- Action bar at macro-block-1 bottom: `↑ Capture N item(s)` (orange-styled button) + `↓ Apply N item(s)` (CTA). Live counts; disabled at 0. On click: `await host.captureItems(names)` / `applyItems(names)`, then `await this.reload()`.
- Macro-block 2 `Remotes · checked <age>` (+ refresh `refresh-cw` ExtraButton → `await host.refreshRemoteChecks(); this.renderRemotes()` only) renders only when `host.remotes().length > 0`. Remote rows: chevron · name · state icon (cyan `↓` remote-newer / pink `↑` remote-older / green `✓` same / gray `—` no-store / gray `?` unknown; tooltips: `remote captured later — Pull would update your store` etc.) · dim `captured <remoteCapturedAt>`.
- Remote row expand: placeholder `comparing…`, then `host.deepDiff(remote)` → category-subsectioned rows with chips, collapsible `✓ N more items match ▸` line (N = groups count − changed entries, expanding lists their names), summary sentence `Pull would bring these changes` / `Push would send these changes` picked by the cached check state (default to Pull wording for `same`/`unknown`), and **both buttons**: `↓ Pull from <name>` (class `is-pull`) + `↑ Push to <name>` (class `is-push`); the state-aligned one gets `is-primary`, the other `is-dimmed` with a risk `aria-label` (`Push would overwrite the newer remote` / `Pull would overwrite your newer local store`). Buttons call `host.pullFrom`/`pushTo` then `await this.reload()`.
- Deep-diff failure: inline `cannot compare: <message>` in the expanded area.

- [ ] **Step 1: Implement `SyncModal.ts` per the contract** (single file; follow the file's peers for style — explicit types, no default params). Keep internal state: `selected: Set<string>`, `expandedItems: Set<string>`, `expandedRemotes: Set<string>`, `renderGen: number`.

- [ ] **Step 2: CSS** (append; reuse Task 3's `.config-sync-card`, `.config-sync-chip`, `.config-sync-sect`):

```css
.config-sync-macro { background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); padding: var(--size-4-2) var(--size-4-3) var(--size-4-3); margin-bottom: var(--size-4-3); }
.config-sync-macro-head { font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); display: flex; align-items: center; gap: var(--size-4-2); padding-bottom: var(--size-4-1); }
.config-sync-hub-row { display: flex; align-items: center; gap: var(--size-4-2); padding: var(--size-4-2) 0; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer; }
.config-sync-card > .config-sync-hub-row:last-of-type { border-bottom: none; }
.config-sync-state-icon { flex: none; width: 1.2em; text-align: center; font-size: var(--font-ui-small); }
.config-sync-state-icon.is-up { color: var(--color-orange); }
.config-sync-state-icon.is-down { color: var(--interactive-accent); }
.config-sync-state-icon.is-neq, .config-sync-state-icon.is-miss { color: var(--text-faint); }
.config-sync-state-icon.is-ok { color: var(--color-green); }
.config-sync-state-icon.is-pull { color: var(--color-cyan); }
.config-sync-state-icon.is-push { color: var(--color-pink); }
.config-sync-hub-row input[type="checkbox"].is-capture { accent-color: var(--color-orange); }
.config-sync-hub-row input[type="checkbox"].is-apply { accent-color: var(--interactive-accent); }
.config-sync-hub-row.is-insync { opacity: 0.55; }
.config-sync-hub-hint { color: var(--color-orange); font-size: var(--font-ui-smaller); margin: 0 0 var(--size-4-1) var(--size-4-4); }
.config-sync-actionbar { display: flex; gap: var(--size-4-2); justify-content: flex-end; margin-top: var(--size-4-2); }
.config-sync-btn-capture { color: var(--color-orange); border-color: var(--color-orange); }
.config-sync-remote-btn.is-pull.is-primary { background: var(--color-cyan); color: var(--background-primary); border: none; }
.config-sync-remote-btn.is-push.is-primary { background: var(--color-pink); color: var(--background-primary); border: none; }
.config-sync-remote-btn.is-dimmed { opacity: 0.55; }
.config-sync-remote-btn.is-pull:not(.is-primary) { color: var(--color-cyan); }
.config-sync-remote-btn.is-push:not(.is-primary) { color: var(--color-pink); }
body.is-phone .config-sync-actionbar { flex-wrap: wrap; }
```

- [ ] **Step 3: Gate + commit** (the file compiles standalone; nothing references it yet)

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "feat: sync panel component with directional selection and remote previews"
```

---

### Task 6: Consolidation — commands, menu, ribbon, wiring; retire old modals

**Files:**
- Modify: `src/main.ts`, `src/core/types.ts` (RibbonKey), `src/ui/SettingTab.ts` (ribbon defs)
- Delete: `src/ui/StatusModal.ts`, `src/ui/GroupSelectModal.ts`, `src/ui/SourceSelectModal.ts`
- Test: `tests/manifest.test.ts` untouched; run full gate.

**Interfaces:**
- Consumes: everything above.
- Produces: final command surface.

- [ ] **Step 1: RibbonKey + settings**

`types.ts`: `export type RibbonKey = "sync" | "revert";`. `main.ts` DEFAULT `ribbonButtons: { sync: false, revert: false }`. `SettingTab.ts` ribbon defs: `[{ key: "sync", label: "Sync" }, { key: "revert", label: "Revert last apply" }]` (drop the transport hint row logic).

- [ ] **Step 2: Commands + menu**

Replace the six command registrations with:

```ts
this.addCommand({ id: "sync", name: "Sync: open the sync panel", callback: () => void this.openSyncPanel() });
this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });
```

`openSyncMenu` becomes (badges from cached `localStatuses`; recompute first when `statusInMenu`):

```ts
private async openSyncMenu(evt: MouseEvent): Promise<void> {
  if (this.settings.statusInMenu) await this.refreshLocalStatus(); // never throws
  const s = this.localStatuses ?? [];
  const up = s.filter((x) => x.state === "local-changed" || x.state === "differs").length;
  const down = s.filter((x) => x.state === "store-newer").length;
  const menu = new Menu();
  menu.addItem((i) => {
    const frag = createFragment();
    frag.createSpan({ text: "Sync…" });
    if (this.settings.statusInMenu && up > 0) frag.createSpan({ cls: "config-sync-menu-badge is-up", text: `↑ ${up}` });
    if (this.settings.statusInMenu && down > 0) frag.createSpan({ cls: "config-sync-menu-badge is-down", text: `↓ ${down}` });
    i.setTitle(frag).setIcon("refresh-cw").onClick(() => void this.openSyncPanel());
  });
  menu.addItem((i) => i.setTitle("Revert last apply").setIcon("undo-2").onClick(() => void this.runRevert()));
  menu.showAtMouseEvent(evt);
}
```

CSS: `.config-sync-menu-badge { font-size: var(--font-ui-smaller); border-radius: 999px; padding: 0 var(--size-4-2); margin-left: var(--size-4-2); } .config-sync-menu-badge.is-up { background: rgba(var(--color-orange-rgb), 0.15); color: var(--color-orange); } .config-sync-menu-badge.is-down { background: rgba(var(--color-purple-rgb), 0.15); color: var(--color-purple); }`

- [ ] **Step 3: `openSyncPanel` + host implementation**

```ts
private async openSyncPanel(): Promise<void> {
  try {
    const plugin = this;
    new SyncModal(this.app, {
      async computeStatuses() {
        const ctx = await plugin.coreContext();
        if ((await coreCreateStarterManifest(ctx)) === "created") {
          new Notice(`Config Sync: created starter items file at ${ctx.rootPath}/config-sync.json — review it in settings`);
        }
        const manifest = await loadManifest(ctx);
        const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
        const groups = groupsForDevice(manifest, device);
        const statuses = await statusForGroups(ctx, groups);
        plugin.localStatuses = statuses;
        plugin.updateRibbonDot();
        return { groups, statuses };
      },
      resolvedPath: (g) => g.path.replace("{configDir}", plugin.app.vault.configDir),
      captureItems: async (names) => {
        const ctx = await plugin.coreContext();
        const results = await capture(ctx, names);
        new ReportModal(plugin.app, "Captured", results, new Date().toLocaleString()).open();
        await plugin.refreshLocalStatus();
      },
      applyItems: async (names) => {
        const ctx = await plugin.coreContext();
        const warnings = await checkApply(ctx, names);
        if (warnings.length > 0) {
          const ok = await confirmWarnings(plugin.app, "Config Sync: version warnings", warnings.map((w) => `${w.group}: ${w.message}`));
          if (!ok) return;
        }
        const results = await apply(ctx, names);
        new ReportModal(plugin.app, "Applied", results, new Date().toLocaleString()).open();
        await plugin.refreshLocalStatus();
      },
      remotes: () => (Platform.isDesktop ? plugin.settings.remotes : []),
      remoteCheck: (name) => plugin.remoteChecks.get(name),
      refreshRemoteChecks: () => plugin.refreshRemoteChecks(),
      deepDiff: async (remote) => {
        const ctx = await plugin.coreContext();
        return diffRemote(ctx, await plugin.createReader(remote));
      },
      pullFrom: async (remote) => {
        const ctx = await plugin.coreContext();
        const results = await importExternal(ctx, await plugin.createReader(remote));
        new ReportModal(plugin.app, `Pulled from ${remote.name}`, results).open();
        await plugin.refreshLocalStatus();
        await plugin.refreshRemoteChecks();
      },
      pushTo: async (remote) => {
        const ctx = await plugin.coreContext();
        const results = await pushExternal(ctx, await plugin.createWriter(remote));
        new ReportModal(plugin.app, `Pushed to ${remote.name}`, results).open();
        await plugin.refreshRemoteChecks();
      },
    }).open();
  } catch (e) {
    new Notice(`Config Sync: ${(e as Error).message}`, 10000);
  }
}
```

Errors inside host callbacks: each existing run* wrapper's Notice pattern moves into the callbacks (wrap capture/apply/pull/push bodies in try/catch → `new Notice("Config Sync <verb> failed: …", 10000)` and rethrow is NOT needed — swallow after noticing so the panel reload still runs).

- [ ] **Step 4: Delete the retired**

Remove `runCapture`/`runApply`/`applyGroups`/`runPull`/`runPush`/`runStatus`/`pullFrom`/`pushTo` methods (their bodies migrated above), the old command registrations, the `SourceSelectModal`/`GroupSelectModal`/`StatusModal` imports, and delete the three files. Keep `runRevert` and `confirmWarnings`. `transportAvailable()` stays (used by the panel host via `remotes()` gating and by nothing else — inline or keep as-is).

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint` — plus `grep -rn "GroupSelectModal\|StatusModal\|SourceSelectModal" src/` → empty.

```bash
git add -A src styles.css
git commit -m "feat!: consolidate commands into the sync panel; retire status/apply/select modals"
```

---

### Task 7: Label accuracy + item-copy audit

**Files:**
- Modify: `src/core/catalog.ts` (OPTION_LABELS), possibly `src/ui/*` strings
- Test: `tests/catalog.test.ts` if any label is asserted there (check `grep -n "Editor" tests/`)

- [ ] **Step 1:** In `OPTION_LABELS`, the `app.json` entry's label `Editor & general` → `App settings`, description → `Editor, Files & links and other general options (app.json)`. Audit every other OPTION_LABELS entry against what its file actually stores (Obsidian docs / file contents in the dev vault) and fix mismatches; list each change in your report.
- [ ] **Step 2:** `grep -rn '\bgroup' src/ui src/main.ts` — every USER-VISIBLE string still saying "group(s)" becomes "item(s)" (variable/type names unchanged; the Advanced tab's "rules" copy and `config-sync.json` schema words stay).
- [ ] **Step 3:** Gate + commit

```bash
git add src
git commit -m "fix: accurate App settings label; user copy says items"
```

---

## Verification after all tasks

1. Full gate; `grep -rn "statusInPickers\|GroupSelectModal\|StatusModal\|SourceSelectModal" src/` empty.
2. Smoke (obsidian-cli, dev vault): edit a captured file → ribbon dot orange ≤ 5 min (or immediately after opening the menu); write into the store folder → dot flips per state ~2 s; Sync panel: macro-blocks, pills, tri-state, direction checkboxes and defaults, file-diff expand, action-bar counts, scrim-click does NOT close, Esc does; remotes light state auto-present with age + refresh icon; expand → deep diff + dual buttons (aligned one primary); Capture/Apply/Pull/Push from the panel each produce the new report (pills title, category cards, chips, expandable files, collapsible unchanged); menu shows Sync…+Revert with badges; command palette has exactly `Sync: open the sync panel` + `Revert last apply`; zero console errors.
3. Release notes obligations: breaking — commands renamed (hotkeys need re-binding), individual ribbon icon settings reset, `statusInPickers` retired.
