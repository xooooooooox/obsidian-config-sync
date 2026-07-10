# Remotes Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename/simplify the remote data model (`remotes`, `vault`+`storePath`, `url`+`subdir`; no back-compat), replace hand-typed local paths with a Browse dialog + store auto-detection, give the Remotes tab the Advanced row language with a visible add-row (both tabs), skip the picker modal for a single remote, remove the Store-transport row, and run a product-language copy pass.

**Architecture:** `Remote` replaces `ExternalSource` in `src/core/types.ts` with validation in `src/core/manifest.ts` (`validateRemotes`). External factories take the store directory directly (`storePath` / repo `subdir`). Folder picking is a new guard-first desktop-only module (`src/external/pickFolder.ts`); store detection (`findStoreDirs`) and tilde expansion live in `src/external/localPath.ts` (fs-only, unit-testable). UI rework stays in `src/ui/SettingTab.ts` + `styles.css`.

**Tech Stack:** TypeScript, Obsidian plugin API, Electron dialog (desktop only), vitest, esbuild (`electron` already in externals).

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable; new warnings from `src/external/*` static Node imports are acceptable ONLY in `localPath.ts`/`gitSource.ts` which already carry them — `pickFolder.ts` must add none: dynamic import behind a `Platform.isDesktop` guard whose check is the function's first statement).
- Mobile red line: `src/core/*` has zero Node-builtin/`obsidian` imports. `src/ui/SettingTab.ts` must not statically import from `src/external/*` (dynamic `await import()` only).
- **No back-compat**: the old `externalSources` settings key is never read; no migration code.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.
- Copy strings verbatim where the task specifies them (command names, descriptions, notices, labels).
- No hardcoded pixel breakpoints in CSS — phone styling keys off `body.is-phone`.
- `noUncheckedIndexedAccess` is on — guard array indexing.

---

### Task 1: `Remote` data model, validation, transport plumbing

**Files:**
- Modify: `src/core/types.ts` (replace `ExternalSource`)
- Modify: `src/core/manifest.ts` (replace `validateExternalSources`/`parseExternalSources`/`parseSource`)
- Modify: `src/external/localPath.ts` (single-dir factories + `expandTilde`)
- Modify: `src/external/gitSource.ts` (`subdir` semantics, `""` = repo root)
- Modify: `src/main.ts` (settings, commands wiring, single-remote skip, factories)
- Modify: `src/ui/SourceSelectModal.ts` (type + placeholder)
- Modify: `src/ui/SettingTab.ts` (minimal: drafts + field bindings so the file compiles; visual rework is Task 3)
- Test: `tests/manifest.test.ts`, `tests/external.test.ts`

**Interfaces:**
- Consumes: existing `ExternalStoreReader`/`ExternalStoreWriter`, `ManifestValidationError`, `isPlainObject`.
- Produces (later tasks rely on these exact shapes):
  - `type Remote = { name: string; type: "vault"; storePath: string } | { name: string; type: "git"; url: string; branch: string; subdir?: string }`
  - `validateRemotes(data: unknown): Remote[]`
  - `expandTilde(p: string): string` and `createLocalPathReader(storeDir: string)` / `createLocalPathWriter(storeDir: string)` (still synchronous factories)
  - `createGitReader(vaultBasePath, url, branch, subdir)` / `createGitWriter(url, branch, subdir)` with `subdir: string` (`""` = repo root)
  - `ConfigSyncSettings.remotes: Remote[]`; SettingTab drafts `RemoteDraft { name; type: "vault" | "git"; storePath; url; branch; subdir }` with `toDraft`/`toCandidate`; `saveRemotes()` method name.

- [ ] **Step 1: Write the failing validation tests**

In `tests/manifest.test.ts`: delete the `describe("parseExternalSources", …)` block and the `parseExternalSources` import; add (importing `validateRemotes` from `../src/core/manifest`):

```ts
describe("validateRemotes", () => {
  it("parses valid remotes of both types", () => {
    const remotes = validateRemotes([
      { name: "kickstart", type: "vault", storePath: "/abs/kickstart.vault/0-Extras/config-sync" },
      { name: "backup", type: "git", url: "git@example.com:me/cfg.git", branch: "main", subdir: "config-sync" },
    ]);
    expect(remotes).toHaveLength(2);
    expect(remotes[0]).toEqual({ name: "kickstart", type: "vault", storePath: "/abs/kickstart.vault/0-Extras/config-sync" });
    expect(remotes[1]?.type).toBe("git");
  });
  it("accepts tilde storePath and omits empty subdir", () => {
    const remotes = validateRemotes([
      { name: "a", type: "vault", storePath: "~/vaults/kick/0-Extras/config-sync" },
      { name: "b", type: "git", url: "u", branch: "main", subdir: "" },
    ]);
    expect(remotes[0]?.type).toBe("vault");
    expect(remotes[1]).toEqual({ name: "b", type: "git", url: "u", branch: "main" });
  });
  it("rejects a relative storePath", () => {
    expect(() => validateRemotes([{ name: "a", type: "vault", storePath: "vaults/kick" }])).toThrow('"storePath" must be an absolute path');
  });
  it("rejects subdir escaping the repo", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "m", subdir: "../x" }])).toThrow('"subdir"');
  });
  it("rejects unknown types and non-arrays", () => {
    expect(() => validateRemotes([{ name: "a", type: "local-path", storePath: "/x" }])).toThrow('"type" must be "vault" or "git"');
    expect(() => validateRemotes({})).toThrow("array");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — `validateRemotes` is not exported.

- [ ] **Step 3: Implement the model + validator**

`src/core/types.ts` — replace the `ExternalSource` type with:

```ts
export type Remote =
  | { name: string; type: "vault"; storePath: string } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string }; // subdir: store folder inside the repo; absent = repo root
```

`src/core/manifest.ts` — delete `parseExternalSources`, replace `validateExternalSources`/`parseSource` with:

```ts
export function validateRemotes(data: unknown): Remote[] {
  if (!Array.isArray(data)) throw new ManifestValidationError("remotes must be a JSON array");
  return data.map((r, i) => parseRemote(r, i));
}

function parseRemote(r: unknown, index: number): Remote {
  if (!isPlainObject(r)) throw new ManifestValidationError(`remote #${index} must be an object`);
  const { name, type, storePath, url, branch, subdir } = r;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`remote #${index}: "name" must be a non-empty string`);
  }
  if (type === "vault") {
    if (typeof storePath !== "string" || !(storePath.startsWith("/") || storePath === "~" || storePath.startsWith("~/"))) {
      throw new ManifestValidationError(`remote "${name}": "storePath" must be an absolute path (a leading ~/ is allowed)`);
    }
    return { name, type, storePath };
  }
  if (type === "git") {
    if (typeof url !== "string" || url === "") {
      throw new ManifestValidationError(`remote "${name}": "url" must be a non-empty string`);
    }
    if (typeof branch !== "string" || branch === "") {
      throw new ManifestValidationError(`remote "${name}": "branch" must be a non-empty string`);
    }
    if (subdir !== undefined && (typeof subdir !== "string" || subdir.startsWith("/") || subdir.split("/").includes(".."))) {
      throw new ManifestValidationError(`remote "${name}": "subdir" must be a relative path without ".."`);
    }
    const remote: Remote = { name, type, url, branch };
    if (typeof subdir === "string" && subdir !== "") remote.subdir = subdir;
    return remote;
  }
  throw new ManifestValidationError(`remote "${name}": "type" must be "vault" or "git"`);
}
```

Update the `ExternalSource` import to `Remote` in this file's import list.

- [ ] **Step 4: Run to verify the validator passes**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: External factories — new signatures**

`src/external/localPath.ts` — the factories take the store directory itself; add `expandTilde` (add `homedir` to the imports):

```ts
import { promises as fs } from "fs";
import * as nodePath from "path";
import { homedir } from "os";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? nodePath.join(homedir(), p.slice(1)) : p;
}

export function createLocalPathReader(storeDir: string): ExternalStoreReader {
  const base = expandTilde(storeDir);
  // …reader body unchanged (uses `base` exactly as before)…
}

export function createLocalPathWriter(storeDir: string): ExternalStoreWriter {
  const base = expandTilde(storeDir);
  // …writer body unchanged…
}
```

(Only the signatures and the `base` computation change; the returned objects and `walk` are untouched.)

`src/external/gitSource.ts` — rename the last parameter and handle the repo-root case:

```ts
export async function createGitReader(
  vaultBasePath: string,
  remoteUrl: string,
  branch: string,
  subdir: string
): Promise<ExternalStoreReader> {
  // …remote add/set-url + fetch unchanged…
  const prefix = subdir === "" ? "" : subdir.endsWith("/") ? subdir : subdir + "/";
  const lsArgs = ["ls-tree", "-r", "--name-only", "FETCH_HEAD"];
  if (prefix !== "") lsArgs.push("--", prefix);
  const listed = await git(vaultBasePath, lsArgs);
  // …files mapping unchanged (f.slice(prefix.length) is a no-op for "")…
}

export async function createGitWriter(remoteUrl: string, branch: string, subdir: string): Promise<ExternalStoreWriter> {
  // …mkdtemp + clone unchanged…
  const base = subdir === "" ? dir : nodePath.join(dir, subdir);
  // …rest unchanged…
}
```

In `walkFs`, skip the `.git` directory at the top level only (needed when `subdir === ""` makes the clone root the base — deeper dot-entries stay included because store content may legitimately contain dotfile names):

```ts
for (const entry of entries) {
  if (rel === "" && entry.name === ".git") continue;
  // …existing recursion…
}
```

- [ ] **Step 6: Update external tests + add repo-root and tilde cases**

In `tests/external.test.ts`:
- Local-path calls become single-arg: `createLocalPathReader(sourceRepo, "0-Extra/config-sync")` → `createLocalPathReader(nodePath.join(sourceRepo, "0-Extra/config-sync"))` (same for the writer; import `nodePath` if the file doesn't already). The missing-root test points at `nodePath.join(sourceRepo, "no/such/root")`.
- Git calls: last argument keeps its current value (now meaning `subdir`).
- Add:

```ts
it("expandTilde expands a leading ~/", () => {
  expect(expandTilde("~/x/y")).toBe(nodePath.join(homedir(), "x/y"));
  expect(expandTilde("/abs/x")).toBe("/abs/x");
});

it("git writer at repo root (subdir '') skips .git and round-trips", async () => {
  const writer = await createGitWriter(bareRemote, "main", "");
  await writer.writeFile("config-sync.json", "{}");
  await writer.finalize();
  const reader = await createGitReader(consumerRepo, bareRemote, "main", "");
  expect(await reader.listFiles()).toContain("config-sync.json");
  const writer2 = await createGitWriter(bareRemote, "main", "");
  const files = await writer2.listFiles();
  expect(files.some((f) => f.startsWith(".git"))).toBe(false);
  await writer2.finalize(); // no changes → cleans up
});
```

(Import `expandTilde` from `../src/external/localPath` and `homedir` from `os`. Reuse the existing `bareRemote`/`consumerRepo` fixtures.)

- [ ] **Step 7: Run external tests**

Run: `npx vitest run tests/external.test.ts`
Expected: PASS.

- [ ] **Step 8: Rewire main.ts and the modal**

`src/main.ts`:
- Import `Remote` instead of `ExternalSource`; `ConfigSyncSettings.externalSources: ExternalSource[]` → `remotes: Remote[]`; `DEFAULT_SETTINGS` gets `remotes: []` (drop `externalSources`).
- `transportAvailable()`: `return Platform.isDesktop && this.settings.remotes.length > 0;`
- `runPull` (and `runPush` identically):

```ts
private async runPull(): Promise<void> {
  const remotes = this.settings.remotes;
  if (remotes.length === 0) {
    new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
    return;
  }
  const only = remotes[0];
  if (remotes.length === 1 && only !== undefined) {
    void this.pullFrom(only);
    return;
  }
  new SourceSelectModal(this.app, remotes, (remote) => {
    void this.pullFrom(remote);
  }).open();
}
```

- `pullFrom`/`pushTo`/`createReader`/`createWriter` take `remote: Remote`:

```ts
private async createReader(remote: Remote): Promise<ExternalStoreReader> {
  if (remote.type === "vault") {
    const { createLocalPathReader } = await import("./external/localPath");
    return createLocalPathReader(remote.storePath);
  }
  const { createGitReader } = await import("./external/gitSource");
  const adapter = this.app.vault.adapter as unknown as { getBasePath(): string };
  return createGitReader(adapter.getBasePath(), remote.url, remote.branch, remote.subdir ?? "");
}

private async createWriter(remote: Remote): Promise<ExternalStoreWriter> {
  if (remote.type === "vault") {
    const { createLocalPathWriter } = await import("./external/localPath");
    return createLocalPathWriter(remote.storePath);
  }
  const { createGitWriter } = await import("./external/gitSource");
  return createGitWriter(remote.url, remote.branch, remote.subdir ?? "");
}
```

(Preserve the existing comment above `createReader` about the mobile load path.)

`src/ui/SourceSelectModal.ts` — swap the type and placeholder:

```ts
import { App, FuzzySuggestModal } from "obsidian";
import { Remote } from "../core/types";

export class SourceSelectModal extends FuzzySuggestModal<Remote> {
  constructor(app: App, private remotes: Remote[], private onChoose: (r: Remote) => void) {
    super(app);
    this.setPlaceholder("Select a remote");
  }
  getItems(): Remote[] {
    return this.remotes;
  }
  getItemText(r: Remote): string {
    return `${r.name} (${r.type})`;
  }
  onChooseItem(r: Remote): void {
    this.onChoose(r);
  }
}
```

- [ ] **Step 9: Minimal SettingTab adaptation (compile only — visual rework is Task 3)**

In `src/ui/SettingTab.ts`:
- `SettingsHost.settings` gets `remotes: Remote[]` (drop `externalSources`); import `Remote` and `validateRemotes` (drop `ExternalSource`/`validateExternalSources`).
- Replace `SourceDraft`/`toDraft`/`toCandidate`:

```ts
interface RemoteDraft {
  name: string;
  type: "vault" | "git";
  storePath: string;
  url: string;
  branch: string;
  subdir: string;
}

function toDraft(r: Remote): RemoteDraft {
  return {
    name: r.name,
    type: r.type,
    storePath: r.type === "vault" ? r.storePath : "",
    url: r.type === "git" ? r.url : "",
    branch: r.type === "git" ? r.branch : "",
    subdir: r.type === "git" ? (r.subdir ?? "") : "",
  };
}

function toCandidate(d: RemoteDraft): unknown {
  if (d.type === "vault") return { name: d.name, type: d.type, storePath: d.storePath };
  const c: Record<string, string> = { name: d.name, type: d.type, url: d.url, branch: d.branch };
  if (d.subdir.trim() !== "") c.subdir = d.subdir.trim();
  return c;
}
```

- `this.sources` type becomes `RemoteDraft[]`; `this.sources = this.host.settings.remotes.map(toDraft);`
- `saveSources` → rename to `saveRemotes`, body uses `this.host.settings.remotes = validateRemotes(this.sources.map(toCandidate));` (banner logic unchanged). Update all `void this.saveSources()` call sites.
- `renderTransportStatus`: change `this.host.settings.externalSources` to `this.host.settings.remotes` (the row is deleted in Task 4; keep it compiling here).
- `renderSourceRow` keeps the current one-line `Setting` layout but binds the new fields: type dropdown `("vault", "Another vault")` / `("git", "Git repository")`; when `vault` one text input placeholder `/absolute/path/to/store` bound to `draft.storePath`; when `git` three text inputs — `git url` → `draft.url`, `branch` → `draft.branch`, `folder in repo (optional)` → `draft.subdir`. Delete the old `root` input. The `Add remote` handler pushes `{ name: "", type: "vault", storePath: "", url: "", branch: "", subdir: "" }`.

- [ ] **Step 10: Gate**

Run: `npm test && npm run build && npm run lint`
Expected: all pass, build clean, lint 0 errors.

- [ ] **Step 11: Commit**

```bash
git add src/core/types.ts src/core/manifest.ts src/external/localPath.ts src/external/gitSource.ts src/main.ts src/ui/SourceSelectModal.ts src/ui/SettingTab.ts tests/manifest.test.ts tests/external.test.ts
git commit -m "feat!: Remote model (vault storePath / git url+subdir), single-remote fast path, no back-compat"
```

---

### Task 2: `findStoreDirs` + `pickFolder`

**Files:**
- Modify: `src/external/localPath.ts` (add `findStoreDirs`)
- Create: `src/external/pickFolder.ts`
- Test: `tests/external.test.ts`

**Interfaces:**
- Consumes: `expandTilde` (Task 1, same module).
- Produces: `findStoreDirs(baseAbs: string): Promise<string[]>` (sorted absolute dirs containing `config-sync.json`); `pickFolder(): Promise<string | null>` (null = cancelled). Task 3 dynamic-imports both.

- [ ] **Step 1: Write the failing tests**

In `tests/external.test.ts` (uses the existing temp-dir fixture helpers; create a small tree with `fs.mkdir`/`fs.writeFile`):

```ts
describe("findStoreDirs", () => {
  it("finds store dirs by config-sync.json, skipping dot dirs, stopping at a hit", async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), "cs-find-"));
    await mkdir(nodePath.join(base, "0-Extras/config-sync/plugin-x"), { recursive: true });
    await writeFile(nodePath.join(base, "0-Extras/config-sync/config-sync.json"), "{}");
    await writeFile(nodePath.join(base, "0-Extras/config-sync/plugin-x/config-sync.json"), "{}"); // below a hit → not reported
    await mkdir(nodePath.join(base, ".obsidian/config-sync"), { recursive: true });
    await writeFile(nodePath.join(base, ".obsidian/config-sync/config-sync.json"), "{}"); // dot dir → skipped
    const dirs = await findStoreDirs(base);
    expect(dirs).toEqual([nodePath.join(base, "0-Extras/config-sync")]);
    await rm(base, { recursive: true, force: true });
  });
  it("returns [] when nothing matches and throws on an unreadable base", async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), "cs-find-"));
    expect(await findStoreDirs(base)).toEqual([]);
    await rm(base, { recursive: true, force: true });
    await expect(findStoreDirs(base)).rejects.toThrow("Cannot read folder");
  });
});
```

(Import `findStoreDirs` from `../src/external/localPath`; `mkdtemp`/`mkdir`/`writeFile`/`rm` from `fs/promises`, `tmpdir` from `os` — the file already uses these patterns.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/external.test.ts`
Expected: FAIL — `findStoreDirs` is not exported.

- [ ] **Step 3: Implement `findStoreDirs`**

Append to `src/external/localPath.ts`:

```ts
/** BFS for directories containing config-sync.json: depth ≤ 4, skips dot-dirs and node_modules,
 *  does not descend below a hit. Used by the settings Browse flow to locate a store. */
export async function findStoreDirs(baseAbs: string): Promise<string[]> {
  const base = expandTilde(baseAbs);
  const hits: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const abs = item.rel === "" ? base : nodePath.join(base, item.rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (item.rel === "") throw new Error(`Cannot read folder ${base}: ${(e as Error).message}`);
      continue; // unreadable subdir — keep scanning the rest
    }
    if (entries.some((e) => e.isFile() && e.name === "config-sync.json")) {
      hits.push(abs);
      continue;
    }
    if (item.depth >= 4) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      queue.push({ rel: item.rel === "" ? entry.name : `${item.rel}/${entry.name}`, depth: item.depth + 1 });
    }
  }
  return hits.sort();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/external.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `pickFolder` (no unit-test surface — Electron dialog)**

Create `src/external/pickFolder.ts`:

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
  const electron = (await import("electron")) as unknown as { remote?: { dialog?: ElectronDialog } };
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

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors, and no NEW `no-nodejs-modules`-style warnings from `pickFolder.ts` (check: `npm run lint 2>&1 | grep pickFolder` → empty).

```bash
git add src/external/localPath.ts src/external/pickFolder.ts tests/external.test.ts
git commit -m "feat: store auto-detection scan and desktop folder picker"
```

---

### Task 3: Remotes tab row UI, Browse flow, add-rows (both tabs)

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderSources`, new `renderRemoteRow`/`renderRemoteForm`, Advanced add-row)
- Create: `src/ui/FolderSelectModal.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `RemoteDraft`/`toCandidate`/`saveRemotes` (Task 1); `pickFolder`/`findStoreDirs` via dynamic import (Task 2); existing row/expand CSS classes and `expanded: Set<string>`.
- Produces: CSS classes `.config-sync-add-row`, `.config-sync-row-type`, `.config-sync-remote-path`, `.config-sync-remote-git`.

- [ ] **Step 1: Folder-choice modal**

Create `src/ui/FolderSelectModal.ts`:

```ts
import { App, FuzzySuggestModal } from "obsidian";

export class FolderSelectModal extends FuzzySuggestModal<string> {
  constructor(app: App, private folders: string[], private onChoose: (f: string) => void) {
    super(app);
    this.setPlaceholder("Several stores found — pick one");
  }
  getItems(): string[] {
    return this.folders;
  }
  getItemText(f: string): string {
    return f;
  }
  onChooseItem(f: string): void {
    this.onChoose(f);
  }
}
```

- [ ] **Step 2: Rework `renderSources` into rows + add-row**

Replace `renderSources` and `renderSourceRow` in `src/ui/SettingTab.ts` (import `FolderSelectModal`; heading copy verbatim from the spec):

```ts
private renderSources(containerEl: HTMLElement): void {
  new Setting(containerEl)
    .setName("Remotes")
    .setHeading()
    .setDesc("Sync your settings with another vault or a git repository. Your own devices don't need a remote — your regular vault sync already carries the settings.");
  const listEl = containerEl.createDiv({ cls: "config-sync-sources" });
  this.sources.forEach((draft, index) => this.renderRemoteRow(listEl, draft, index));
  this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
  this.sourcesErrorEl.setText(this.sourcesErrorMsg);
  const addBtn = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add remote" });
  addBtn.addEventListener("click", () => {
    this.sources.push({ name: "", type: "vault", storePath: "", url: "", branch: "", subdir: "" });
    this.expanded.add("remote:");
    this.refresh();
  });
}

private renderRemoteRow(listEl: HTMLElement, draft: RemoteDraft, index: number): void {
  const key = `remote:${draft.name}`;
  const isOpen = this.expanded.has(key);
  const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
  row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
  row.createSpan({ cls: "config-sync-rule-name", text: draft.name === "" ? "(unnamed)" : draft.name });
  row.createSpan({ cls: "config-sync-row-type", text: draft.type });
  row.createSpan({
    cls: "config-sync-row-path",
    text: draft.type === "vault" ? draft.storePath : draft.url === "" ? "" : `${draft.url}#${draft.branch}`,
  });
  row.createDiv({ cls: "config-sync-rule-spacer" });
  new ExtraButtonComponent(row)
    .setIcon("trash")
    .setTooltip("Delete remote")
    .onClick(async () => {
      this.sources.splice(index, 1);
      this.expanded.delete(key);
      await this.saveRemotes();
      this.refresh();
    });
  row.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
    if (isOpen) this.expanded.delete(key);
    else this.expanded.add(key);
    this.refresh();
  });
  if (isOpen) this.renderRemoteForm(listEl, draft);
}
```

- [ ] **Step 3: The expand form with Browse**

Add (same `field()` helper pattern as `renderRuleForm` — reuse by extracting it to a private method `formField(parent, label)` if it is currently a local closure; otherwise duplicate the 4-line helper):

```ts
private renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft): void {
  const panel = listEl.createDiv({ cls: "config-sync-expand" });
  const field = (parent: HTMLElement, label: string): HTMLElement => {
    const f = parent.createDiv();
    f.createEl("label", { cls: "config-sync-form-label", text: label });
    return f;
  };
  const line1 = panel.createDiv({ cls: "config-sync-form-line1" });
  new DropdownComponent(field(line1, "Type"))
    .addOption("vault", "Another vault")
    .addOption("git", "Git repository")
    .setValue(draft.type)
    .onChange(async (v) => {
      draft.type = v as RemoteDraft["type"];
      await this.saveRemotes();
      this.refresh();
    });
  const nameC = new TextComponent(field(line1, "Name"));
  nameC.setPlaceholder("name").setValue(draft.name).onChange((v) => {
    this.expanded.delete(`remote:${draft.name}`);
    draft.name = v.trim();
    this.expanded.add(`remote:${draft.name}`);
    void this.saveRemotes();
  });
  nameC.inputEl.addClass("config-sync-rule-name-input");

  if (draft.type === "vault") {
    const line2 = panel.createDiv({ cls: "config-sync-remote-path" });
    const pathField = field(line2, "Store path");
    const pathC = new TextComponent(pathField);
    pathC.setPlaceholder("/path/to/other-vault/…/config-sync").setValue(draft.storePath).onChange((v) => {
      draft.storePath = v.trim();
      void this.saveRemotes();
    });
    if (Platform.isDesktop) {
      new ExtraButtonComponent(line2).setIcon("folder-open").setTooltip("Browse…").onClick(() => void this.browseStorePath(draft));
    }
  } else {
    const line2 = panel.createDiv({ cls: "config-sync-remote-git" });
    new TextComponent(field(line2, "URL")).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
      draft.url = v.trim();
      void this.saveRemotes();
    });
    new TextComponent(field(line2, "Branch")).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
      draft.branch = v.trim();
      void this.saveRemotes();
    });
    new TextComponent(field(line2, "Folder in repo (optional)")).setPlaceholder("empty = repo root").setValue(draft.subdir).onChange((v) => {
      draft.subdir = v.trim();
      void this.saveRemotes();
    });
  }
}

private async browseStorePath(draft: RemoteDraft): Promise<void> {
  try {
    const { pickFolder } = await import("../external/pickFolder");
    const picked = await pickFolder();
    if (picked === null) return;
    const { findStoreDirs } = await import("../external/localPath");
    const dirs = await findStoreDirs(picked);
    const apply = (p: string): void => {
      draft.storePath = p;
      void this.saveRemotes();
      this.refresh();
    };
    const first = dirs[0];
    if (dirs.length === 1 && first !== undefined) {
      apply(first);
    } else if (dirs.length === 0) {
      apply(picked);
      new Notice("No store found here yet — Pull needs the other vault to Capture first; Push will initialize a store at this path.");
    } else {
      new FolderSelectModal(this.app, dirs, apply).open();
    }
  } catch (e) {
    new Notice(`Config Sync: ${(e as Error).message}`);
  }
}
```

(`Platform` joins the `obsidian` import list in SettingTab; this is a UI file, allowed.)

- [ ] **Step 4: Advanced tab add-row**

In `renderAdvanced`: remove the `customHead.addExtraButton((b) => b.setIcon("plus")…)` block; after the `customEl` loop append:

```ts
const addRule = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add rule" });
addRule.addEventListener("click", () => {
  this.groups.push({ name: "", path: "", type: "file", devices: "all" });
  this.expanded.add("");
  this.refresh();
});
```

(The Custom-rules heading keeps its name/description, just loses the `+`.)

- [ ] **Step 5: CSS**

In `styles.css`: delete the phone rule `body.is-phone .config-sync-sources .setting-item-control { flex-wrap: wrap; }` (the Setting-row layout is gone). Add:

```css
.config-sync-add-row {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: var(--size-4-2);
  margin: var(--size-4-2) 0;
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: none;
  box-shadow: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-ui-small);
}

.config-sync-add-row:hover {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}

.config-sync-row-type {
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  padding: 0 var(--size-2-2);
  flex: none;
}

.config-sync-remote-path {
  display: flex;
  align-items: flex-end;
  gap: var(--size-4-2);
}

.config-sync-remote-path > div:first-child {
  flex: 1;
}

.config-sync-remote-git {
  display: grid;
  grid-template-columns: 1fr 8em 1fr;
  gap: var(--size-4-3);
}
```

And extend the phone block:

```css
body.is-phone .config-sync-remote-git {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

```bash
git add src/ui/SettingTab.ts src/ui/FolderSelectModal.ts styles.css
git commit -m "feat: remote rows with expand form and Browse; dashed add-rows in Remotes and Advanced"
```

---

### Task 4: Remove Store transport; product-language copy pass

**Files:**
- Modify: `src/ui/SettingTab.ts` (delete `renderTransportStatus` + its call; Data folder desc)
- Modify: `src/main.ts` (command + menu strings)

**Interfaces:** none new; strings below are verbatim-binding.

- [ ] **Step 1: Remove the Store transport row**

In `src/ui/SettingTab.ts`: delete the `renderTransportStatus` method and the `this.renderTransportStatus(containerEl);` line in `renderActiveTab`'s `"general"` case (PKM mode becomes the first row).

- [ ] **Step 2: Data folder description**

In `renderDataFolder`, the `setDesc` template becomes exactly:

```ts
`Where your synced settings live inside this vault. Your regular vault sync (e.g. remotely-save) carries this folder to your other devices. Leave empty for the recommended location (currently: ${resolved}).`
```

- [ ] **Step 3: Command + menu strings**

In `src/main.ts`, replace the five command `name`s and the matching `Menu` item titles with exactly:

| id | name / menu title |
|---|---|
| capture | `Capture: save this device's settings` |
| apply | `Apply: update this device with synced settings` |
| revert-last-apply | `Revert last apply` |
| pull | `Pull: get settings from a remote` |
| push | `Push: send settings to a remote` |

(Ribbon tooltips `Config Sync: Capture` etc. and menu icons unchanged.)

- [ ] **Step 4: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass / clean / 0 errors.

```bash
git add src/ui/SettingTab.ts src/main.ts
git commit -m "feat: drop Store transport row; product-language command and settings copy"
```

---

## Verification after all tasks

1. Full gate: `npm test && npm run build && npm run lint` — all tests pass, 0 lint errors, no new warnings from `pickFolder.ts`.
2. Smoke (obsidian-cli, dev vault): Remotes tab shows heading + dashed "+ Add remote" (no left-gutter rows); add → row auto-expands; type switch swaps the form; Browse button present on the vault form (dialog itself checked manually once); Advanced tab has the dashed "+ Add rule" and no heading `+`; General tab starts with PKM mode (no Store transport); command palette shows the five new names; with exactly one remote configured, Pull runs without the picker modal; zero console errors.
3. data.json sanity: adding a remote writes `remotes: [...]`; an old `externalSources` key (if present) is untouched and ignored.
