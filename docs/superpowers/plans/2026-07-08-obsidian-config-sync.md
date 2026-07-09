# obsidian-config-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin that publishes sanitized config into a vault-content "store", applies selected config groups per device, and imports the store from external vaults (local path / git) — per the spec at `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md`.

**Architecture:** Pure functional core (`src/core/`) doing all file I/O through a narrow `FileIO` interface satisfied by Obsidian's `app.vault.adapter`; a thin plugin shell (`src/main.ts`) wires commands/UI; desktop-only external sources (`src/external/`) use Node `fs`/`child_process` behind dynamic imports.

**Tech Stack:** TypeScript (strict) + esbuild/eslint toolchain vendored from the official sample plugin (git vendor upstream, remote `template`), vitest for tests, Obsidian API, BRAT for distribution.

## Global Constraints

- Plugin id `obsidian-config-sync`, name "Config Sync", `isDesktopOnly: false`, `minAppVersion: "1.5.0"`.
- **Template vendor upstream:** the working branch is rooted at the official `obsidianmd/obsidian-sample-plugin` repo's git history (remote name `template` — see Task 1); the project's recorded origin IS the template. Toolchain files (`esbuild.config.mjs`, `eslint.config.mts`, `version-bump.mjs`, `.npmrc`, `.editorconfig`, `styles.css`, `.gitignore`) stay upstream-shaped; identity files (`manifest.json`, `package.json` name/author/license, `versions.json`), the vitest test chain, and `src/`/`tests/` content are ours. Upgrading later = `git fetch template && git merge template/master`.
- **tsconfig is the template's** (`strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, ES2021) plus `tests/**/*.ts` added to `include`. Where plan code fails these flags, the implementer narrows types in place (root-cause fix, e.g. guard `m[1]` after a regex match) — never loosens the config.
- **Mobile I/O red line (spec D6):** `src/core/` may only touch files through the `FileIO` interface (`app.vault.adapter` in production). Node `fs`/`child_process` are allowed ONLY in `src/external/`, loaded via dynamic `import()` behind a `Platform.isDesktop` gate (a static import would evaluate `require("fs")` at plugin load and crash mobile).
- **Blacklist (verbatim):** groups may never target plugin dirs `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync`, nor any `workspace*.json` file. Validation rejects with an explicit error.
- Store layout: `<root>/manifest.json`, `<root>/store.lock.json`, `<root>/store/` with `configdir/` canonical name and leading-dot stripping for vault-root files.
- Backup location: `{configDir}/plugins/obsidian-config-sync/backup/` — single latest apply only, never enters the store.
- Functional style: pure functions; classes only where the Obsidian framework requires subclassing (`Plugin`, `Modal`, `PluginSettingTab`, `FuzzySuggestModal`) and for the in-memory test `FileIO`.
- Errors are explicit and contextual (group name, path, underlying message). No silent fallback, no catch-all swallowing.
- JSON files are written with 2-space indent and a trailing newline.
- All vault paths use `/` separators and are vault-relative (adapter convention).
- Repo: https://github.com/xooooooooox/obsidian-config-sync . All commands below run from the repo root.

## File Structure

```
manifest.json / versions.json / package.json / tsconfig.json / esbuild.config.mjs / .gitignore
eslint.config.mts / version-bump.mjs / .npmrc / .editorconfig / styles.css   # vendored from template
src/
├── main.ts                  # Plugin shell: commands, ribbon, settings, CoreContext wiring
├── core/
│   ├── types.ts             # SyncGroup/SyncManifest/StoreLock/GroupResult/ExternalSource
│   ├── pathing.ts           # {configDir}↔configdir/, dot-stripping, relativeTo (pure)
│   ├── sanitize.ts          # key-glob matching, sanitizeJson, mergePreservingSanitized (pure)
│   ├── manifest.ts          # parse/validate manifest, store.lock, external sources (pure)
│   ├── io.ts                # FileIO interface + recursive list / mkdir helpers
│   └── ConfigSyncCore.ts    # publish / apply / checkApply / revertLastApply / importExternal
├── ui/
│   ├── GroupSelectModal.ts  # multi-select toggle modal
│   ├── ConfirmModal.ts      # warning confirm (Promise<boolean>)
│   ├── ReportModal.ts       # per-group results + "Reload app" button
│   ├── SourceSelectModal.ts # fuzzy pick of external source
│   └── SettingTab.ts        # rootPath + externalSources (JSON textarea)
└── external/
    ├── localPath.ts         # Node fs reader (desktop)
    └── gitSource.ts         # read-only blob reader via git fetch/ls-tree/show (desktop)
tests/
├── memfs.ts                 # in-memory FileIO + FakePlugins host
├── pathing.test.ts / sanitize.test.ts / manifest.test.ts / io.test.ts
├── core.test.ts             # publish/apply/revert/import against MemFS
└── external.test.ts         # real tmp-dir fs + real git repos
```

---

### Task 1: Bootstrap from the official sample template

**Why this shape:** the working branch is **rooted at the template's own git history** — the project's origin IS the official sample plugin, visible at the tail of `git log`, and every later task is a legible evolution on top of that starting point. Upstream updates arrive forever via `git fetch template && git merge template/master` (three-way merge brings only upstream increments). A one-shot copy or GitHub's "Use this template" would provide neither.

**Files:**
- Branch: create `feat/v0.1.0` rooted at `template/master`
- Modify (identity, template content otherwise untouched): `manifest.json`, `versions.json`, `package.json`, `LICENSE`
- Replace with stub: `src/main.ts`; Delete: every other file under the template's `src/` (demo code, e.g. `settings.ts`)
- Modify (test chain): `package.json` (vitest devDep + `test` script), `tsconfig.json` (add `tests/**/*.ts` to `include`)
- Leave as template's: `esbuild.config.mjs`, `eslint.config.mts`, `version-bump.mjs`, `.npmrc`, `.editorconfig`, `.gitignore`, `styles.css`, `README.md` (rewritten later in Task 13), `AGENTS.md`, `.github/**`

**Interfaces:**
- Produces: a branch whose history is the template's + two adaptation commits; working `npm run dev` / `npm run build` / `npm test` / `npm run lint`; the `template` remote as the permanent upgrade channel. All later tasks build on this without touching toolchain files.

- [ ] **Step 1: Add the vendor remote and fetch**

```bash
git remote add template https://github.com/obsidianmd/obsidian-sample-plugin.git 2>/dev/null || git remote set-url template https://github.com/obsidianmd/obsidian-sample-plugin.git
git fetch template
git rev-parse --short template/master
```
Expected: fetch succeeds; record the printed template SHA in your report.

- [ ] **Step 2: Root the working branch at the template**

```bash
git checkout -B feat/v0.1.0 template/master
git log --oneline -3
```
Expected: working tree now equals the template exactly; log shows the template's commits. Untracked `docs/` remains in the tree — leave it alone and never commit it.

- [ ] **Step 3: Identity commit**

3a. `manifest.json` — replace content with:
```json
{
  "id": "obsidian-config-sync",
  "name": "Config Sync",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Selective, on-demand distribution of vault configuration (snippets, hotkeys, plugin settings) across devices and vaults.",
  "author": "xooooooooox",
  "authorUrl": "https://github.com/xooooooooox",
  "isDesktopOnly": false
}
```

3b. `versions.json` — replace content with:
```json
{
  "0.1.0": "1.5.0"
}
```

3c. `package.json` — keep the template's file as-is EXCEPT these fields: `"name": "obsidian-config-sync"`, `"version": "0.1.0"`, `"description": "Selective, on-demand distribution of vault configuration across devices and vaults"`, `"author": "xooooooooox"`, `"license": "MIT"`. Do not touch the template's scripts or devDependencies in this step.

3d. `LICENSE` — restore ours from main: `git show main:LICENSE > LICENSE` (MIT; the template ships 0BSD).

3e. `src/main.ts` — replace content with:
```ts
import { Plugin } from "obsidian";

export default class ConfigSyncPlugin extends Plugin {
  async onload(): Promise<void> {}
}
```
Delete every other file under `src/` (template demo code): `git rm src/settings.ts` (plus any others present at the fetched SHA — list them in your report).

3f. Commit:
```bash
git add manifest.json versions.json package.json LICENSE src/
git commit -m "chore: adapt template identity to obsidian-config-sync"
```

- [ ] **Step 4: Test-chain commit**

4a. `package.json` — add to scripts: `"test": "vitest run --passWithNoTests"`; add to devDependencies: `"vitest": "^1.6.0"` (or the current stable major if npm resolves it without peer conflicts against the template's TypeScript — record what you used).

4b. `tsconfig.json` — change only the `include` array to `["src/**/*.ts", "tests/**/*.ts"]`. Every compilerOption stays exactly as the template has it (including `noUncheckedIndexedAccess` if present).

4c. Verify:

Run: `npm install`
Expected: lockfile created/updated, no errors.

Run: `npm run build`
Expected: exit 0, `main.js` produced.

Run: `npm test`
Expected: "No test files found" pass via `--passWithNoTests`.

Run: `npm run lint`
Expected: exit 0 against the stub `src/main.ts`. If `eslint-plugin-obsidianmd` flags something in our identity/stub files, fix it if mechanical; otherwise report BLOCKED with the rule name.

4d. Commit:
```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add vitest test chain"
```

- [ ] **Step 5: Verify the upgrade channel**

```bash
git merge-base HEAD template/master && git log --oneline | tail -3
```
Expected: merge-base prints the template SHA (channel live); log tail shows the template's earliest commits — the project's recorded origin is the official sample plugin.

> **Integration note (for finishing time, not this task):** `main` currently holds only the GitHub init commit (LICENSE). When the branch is done, either reset `main` to this branch (template history becomes the repo root — truest to the design) or merge with `--allow-unrelated-histories`. Decide with the user at finishing-a-development-branch.
---

### Task 2: Core types + pathing

**Files:**
- Create: `src/core/types.ts`, `src/core/pathing.ts`
- Test: `tests/pathing.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `DeviceClass = "all" | "desktop" | "mobile"`; `SyncGroup { name: string; path: string; type: "file" | "dir"; devices: DeviceClass; sanitize?: string[] }`; `SyncManifest { version: 1; groups: SyncGroup[] }`; `StoreLock { publishedAt: string; groups: Record<string, { sourcePluginVersion: string }> }`; `GroupResult { group: string; status: "ok" | "warning" | "error"; filesWritten: string[]; filesDeleted: string[]; messages: string[]; needsAppReload: boolean }`; `ExternalSource` (discriminated union on `type`).
  - `pathing.ts`: `groupRealPath(groupPath: string, configDir: string): string`; `groupStorePath(groupPath: string): string`; `relativeTo(base: string, full: string): string`; `PathingError`.

- [ ] **Step 1: Write the failing tests — `tests/pathing.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { groupRealPath, groupStorePath, relativeTo, PathingError } from "../src/core/pathing";

describe("groupRealPath", () => {
  it("resolves {configDir} against the device config dir", () => {
    expect(groupRealPath("{configDir}/snippets", ".obsidian_apple")).toBe(".obsidian_apple/snippets");
  });
  it("returns vault-root paths untouched", () => {
    expect(groupRealPath(".obsidian.vimrc", ".obsidian_apple")).toBe(".obsidian.vimrc");
  });
});

describe("groupStorePath", () => {
  it("maps {configDir} to the canonical configdir/ folder", () => {
    expect(groupStorePath("{configDir}/plugins/cmdr/data.json")).toBe("configdir/plugins/cmdr/data.json");
  });
  it("strips the leading dot of vault-root paths", () => {
    expect(groupStorePath(".obsidian.vimrc")).toBe("obsidian.vimrc");
  });
  it("keeps dot-less vault paths unchanged", () => {
    expect(groupStorePath("some/folder/file.md")).toBe("some/folder/file.md");
  });
});

describe("relativeTo", () => {
  it("returns the path relative to a base dir", () => {
    expect(relativeTo("a/b", "a/b/c/d.json")).toBe("c/d.json");
  });
  it("throws when the path is outside the base", () => {
    expect(() => relativeTo("a/b", "a/x/c")).toThrow(PathingError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pathing.test.ts`
Expected: FAIL — cannot resolve `../src/core/pathing`.

- [ ] **Step 3: Write `src/core/types.ts`**

```ts
export type DeviceClass = "all" | "desktop" | "mobile";

export interface SyncGroup {
  name: string;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "dir";
  devices: DeviceClass;
  sanitize?: string[]; // key-name glob patterns; file groups only
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

export interface StoreLock {
  publishedAt: string;
  groups: Record<string, { sourcePluginVersion: string }>;
}

export interface GroupResult {
  group: string;
  status: "ok" | "warning" | "error";
  filesWritten: string[];
  filesDeleted: string[];
  messages: string[];
  needsAppReload: boolean;
}

export type ExternalSource =
  | { name: string; type: "local-path"; path: string; root: string }
  | { name: string; type: "git"; remote: string; branch: string; root: string };
```

- [ ] **Step 4: Write `src/core/pathing.ts`**

```ts
export const CONFIG_DIR_VARIABLE = "{configDir}";
export const STORE_CONFIG_DIR = "configdir";

export class PathingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathingError";
  }
}

export function groupRealPath(groupPath: string, configDir: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return configDir + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  return groupPath;
}

export function groupStorePath(groupPath: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return STORE_CONFIG_DIR + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  if (groupPath.startsWith(".")) {
    return groupPath.slice(1);
  }
  return groupPath;
}

export function relativeTo(base: string, full: string): string {
  if (!full.startsWith(base + "/")) {
    throw new PathingError(`"${full}" is not inside "${base}"`);
  }
  return full.slice(base.length + 1);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/pathing.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/pathing.ts tests/pathing.test.ts
git commit -m "feat: core types and store path mapping"
```

---

### Task 3: Sanitize + merge

**Files:**
- Create: `src/core/sanitize.ts`
- Test: `tests/sanitize.test.ts`

**Interfaces:**
- Produces: `isPlainObject(v: unknown): v is Record<string, unknown>`; `keyMatchesAny(key: string, patterns: string[]): boolean`; `sanitizeJson(value: unknown, patterns: string[]): unknown`; `mergePreservingSanitized(local: unknown, incoming: unknown, patterns: string[]): unknown`.

- [ ] **Step 1: Write the failing tests — `tests/sanitize.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeJson, mergePreservingSanitized } from "../src/core/sanitize";

describe("sanitizeJson", () => {
  it("drops keys matching patterns at any depth, including inside arrays", () => {
    const input = {
      userEmail: "a@b.c",
      nested: { feishuAppSecret: "s", keep: 1 },
      list: [{ airtableAPIKey: "k", ok: true }],
    };
    expect(sanitizeJson(input, ["*Secret*", "*APIKey*", "userEmail"])).toEqual({
      nested: { keep: 1 },
      list: [{ ok: true }],
    });
  });
  it("treats * as wildcard and other regex metachars literally", () => {
    expect(sanitizeJson({ "a.b": 1, axb: 2 }, ["a.b"])).toEqual({ axb: 2 });
  });
});

describe("mergePreservingSanitized", () => {
  const patterns = ["*Token*", "userEmail"];
  it("keeps local values for sanitized keys and takes incoming for the rest", () => {
    const local = { userEmail: "me@x.y", vikaToken: "t", theme: "old", nested: { apiTokenX: "n", other: 1 } };
    const incoming = { theme: "new", nested: { other: 2 } };
    expect(mergePreservingSanitized(local, incoming, patterns)).toEqual({
      theme: "new",
      nested: { other: 2, apiTokenX: "n" },
      userEmail: "me@x.y",
      vikaToken: "t",
    });
  });
  it("drops non-sanitized local keys that the store no longer has", () => {
    expect(mergePreservingSanitized({ removed: 1 }, {}, patterns)).toEqual({});
  });
  it("returns incoming when local content is not an object", () => {
    expect(mergePreservingSanitized("bad", { a: 1 }, patterns)).toEqual({ a: 1 });
  });
  it("preserves sanitized keys inside arrays index-wise", () => {
    const local = { list: [{ apiTokenX: "secret", other: 1 }] };
    const incoming = { list: [{ other: 2 }] };
    expect(mergePreservingSanitized(local, incoming, patterns)).toEqual({ list: [{ other: 2, apiTokenX: "secret" }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sanitize.test.ts`
Expected: FAIL — cannot resolve `../src/core/sanitize`.

- [ ] **Step 3: Write `src/core/sanitize.ts`**

```ts
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function keyMatchesAny(key: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegex(p).test(key));
}

export function sanitizeJson(value: unknown, patterns: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJson(v, patterns));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (keyMatchesAny(k, patterns)) continue;
      out[k] = sanitizeJson(v, patterns);
    }
    return out;
  }
  return value;
}

export function mergePreservingSanitized(local: unknown, incoming: unknown, patterns: string[]): unknown {
  if (Array.isArray(incoming) && Array.isArray(local)) {
    return incoming.map((v, i) => mergePreservingSanitized(local[i], v, patterns));
  }
  if (isPlainObject(incoming) && isPlainObject(local)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (keyMatchesAny(k, patterns) && k in local) {
        out[k] = local[k];
      } else {
        out[k] = mergePreservingSanitized(local[k], v, patterns);
      }
    }
    for (const [k, v] of Object.entries(local)) {
      if (!(k in out) && keyMatchesAny(k, patterns)) {
        out[k] = v;
      }
    }
    return out;
  }
  return incoming;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sanitize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sanitize.ts tests/sanitize.test.ts
git commit -m "feat: sanitize key stripping and credential-preserving merge"
```

---

### Task 4: Manifest / lock / external-source validation

**Files:**
- Create: `src/core/manifest.ts`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `SyncGroup`, `SyncManifest`, `StoreLock`, `ExternalSource` from `src/core/types`; `groupStorePath` from `src/core/pathing`; `isPlainObject` from `src/core/sanitize`.
- Produces: `ManifestValidationError`; `BLACKLISTED_PLUGIN_DIRS: string[]`; `parseSyncManifest(raw: string): SyncManifest`; `parseStoreLock(raw: string): StoreLock`; `parseExternalSources(raw: string): ExternalSource[]`.

- [ ] **Step 1: Write the failing tests — `tests/manifest.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseSyncManifest, parseStoreLock, parseExternalSources, ManifestValidationError } from "../src/core/manifest";

function manifestWith(groups: unknown[]): string {
  return JSON.stringify({ version: 1, groups });
}

const GOOD = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };

describe("parseSyncManifest", () => {
  it("parses a valid manifest", () => {
    const m = parseSyncManifest(manifestWith([GOOD]));
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].name).toBe("hotkeys");
  });
  it("rejects invalid JSON with a clear error", () => {
    expect(() => parseSyncManifest("{nope")).toThrow(ManifestValidationError);
  });
  it("rejects unsupported versions", () => {
    expect(() => parseSyncManifest(JSON.stringify({ version: 2, groups: [] }))).toThrow("unsupported version");
  });
  it("rejects duplicate group names", () => {
    expect(() => parseSyncManifest(manifestWith([GOOD, { ...GOOD, path: ".x" }]))).toThrow("duplicate group name");
  });
  it("rejects store path collisions", () => {
    const a = { name: "a", path: ".vimrc", type: "file", devices: "all" };
    const b = { name: "b", path: "vimrc", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([a, b]))).toThrow("collides");
  });
  it("rejects blacklisted plugin dirs", () => {
    const g = { name: "rs", path: "{configDir}/plugins/remotely-save/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("blacklisted");
  });
  it("rejects workspace files", () => {
    const g = { name: "ws", path: "{configDir}/workspace.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("blacklisted");
  });
  it("rejects sanitize on dir groups", () => {
    const g = { name: "s", path: "{configDir}/snippets", type: "dir", devices: "all", sanitize: ["*Token*"] };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("file groups");
  });
  it("rejects paths with .. or absolute paths", () => {
    const g = { name: "e", path: "../outside", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([g]))).toThrow("vault-relative");
  });
});

describe("parseStoreLock", () => {
  it("parses a valid lock", () => {
    const lock = parseStoreLock(JSON.stringify({ publishedAt: "t", groups: { g: { sourcePluginVersion: "1.0.0" } } }));
    expect(lock.groups.g.sourcePluginVersion).toBe("1.0.0");
  });
  it("rejects malformed locks", () => {
    expect(() => parseStoreLock(JSON.stringify({ groups: {} }))).toThrow(ManifestValidationError);
  });
});

describe("parseExternalSources", () => {
  it("parses valid sources of both types", () => {
    const raw = JSON.stringify([
      { name: "local", type: "local-path", path: "/v/main.vault", root: "0-Extra/config-sync" },
      { name: "git", type: "git", remote: "git@host:g/r.git", branch: "main", root: "0-Extra/config-sync" },
    ]);
    const sources = parseExternalSources(raw);
    expect(sources).toHaveLength(2);
    expect(sources[1].type).toBe("git");
  });
  it("rejects a git source without a branch", () => {
    const raw = JSON.stringify([{ name: "g", type: "git", remote: "u", root: "r" }]);
    expect(() => parseExternalSources(raw)).toThrow('"branch"');
  });
  it("rejects non-array input", () => {
    expect(() => parseExternalSources("{}")).toThrow("array");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/core/manifest`.

- [ ] **Step 3: Write `src/core/manifest.ts`**

```ts
import { DeviceClass, ExternalSource, StoreLock, SyncGroup, SyncManifest } from "./types";
import { groupStorePath } from "./pathing";
import { isPlainObject } from "./sanitize";

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(`Invalid config-sync data: ${message}`);
    this.name = "ManifestValidationError";
  }
}

export const BLACKLISTED_PLUGIN_DIRS = ["remotely-save", "ioto-update", "slides-rup", "obsidian-config-sync"];

export function parseSyncManifest(raw: string): SyncManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new ManifestValidationError("manifest top level must be an object");
  if (parsed.version !== 1) {
    throw new ManifestValidationError(`unsupported version: ${String(parsed.version)} (expected 1)`);
  }
  if (!Array.isArray(parsed.groups)) throw new ManifestValidationError('"groups" must be an array');
  const groups = parsed.groups.map((g, i) => parseGroup(g, i));
  const names = new Set<string>();
  const storePaths = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new ManifestValidationError(`duplicate group name "${g.name}"`);
    names.add(g.name);
    const sp = groupStorePath(g.path);
    if (storePaths.has(sp)) {
      throw new ManifestValidationError(`group "${g.name}" collides with another group on store path "${sp}"`);
    }
    storePaths.add(sp);
  }
  return { version: 1, groups };
}

function parseGroup(g: unknown, index: number): SyncGroup {
  if (!isPlainObject(g)) throw new ManifestValidationError(`group #${index} must be an object`);
  const { name, path, type, devices, sanitize } = g;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`group #${index}: "name" must be a non-empty string`);
  }
  if (typeof path !== "string" || path === "") {
    throw new ManifestValidationError(`group "${name}": "path" must be a non-empty string`);
  }
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new ManifestValidationError(`group "${name}": path must be vault-relative without ".."`);
  }
  if (type !== "file" && type !== "dir") {
    throw new ManifestValidationError(`group "${name}": "type" must be "file" or "dir"`);
  }
  if (devices !== "all" && devices !== "desktop" && devices !== "mobile") {
    throw new ManifestValidationError(`group "${name}": "devices" must be "all", "desktop" or "mobile"`);
  }
  if (sanitize !== undefined) {
    if (type !== "file") {
      throw new ManifestValidationError(`group "${name}": "sanitize" is only supported on file groups`);
    }
    if (!Array.isArray(sanitize) || sanitize.some((p) => typeof p !== "string" || p === "")) {
      throw new ManifestValidationError(`group "${name}": "sanitize" must be an array of non-empty strings`);
    }
  }
  assertNotBlacklisted(name, path);
  const group: SyncGroup = { name, path, type, devices: devices as DeviceClass };
  if (sanitize !== undefined) group.sanitize = sanitize as string[];
  return group;
}

function assertNotBlacklisted(name: string, path: string): void {
  const m = path.match(/^\{configDir\}\/plugins\/([^/]+)(\/|$)/);
  if (m !== null && BLACKLISTED_PLUGIN_DIRS.includes(m[1])) {
    throw new ManifestValidationError(
      `group "${name}": plugin "${m[1]}" is blacklisted (machine-bound or credential-bearing), it can never enter the store`
    );
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (/^workspace.*\.json$/.test(basename)) {
    throw new ManifestValidationError(`group "${name}": workspace files are blacklisted (device-specific)`);
  }
}

export function parseStoreLock(raw: string): StoreLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`store.lock.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.publishedAt !== "string" || !isPlainObject(parsed.groups)) {
    throw new ManifestValidationError("store.lock.json must be {publishedAt: string, groups: object}");
  }
  const groups: Record<string, { sourcePluginVersion: string }> = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    if (!isPlainObject(v) || typeof v.sourcePluginVersion !== "string") {
      throw new ManifestValidationError(`store.lock.json group "${k}" must have a string sourcePluginVersion`);
    }
    groups[k] = { sourcePluginVersion: v.sourcePluginVersion };
  }
  return { publishedAt: parsed.publishedAt, groups };
}

export function parseExternalSources(raw: string): ExternalSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`external sources is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new ManifestValidationError("external sources must be a JSON array");
  return parsed.map((s, i) => parseSource(s, i));
}

function parseSource(s: unknown, index: number): ExternalSource {
  if (!isPlainObject(s)) throw new ManifestValidationError(`source #${index} must be an object`);
  const { name, type, path, remote, branch, root } = s;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`source #${index}: "name" must be a non-empty string`);
  }
  if (typeof root !== "string" || root === "") {
    throw new ManifestValidationError(`source "${name}": "root" must be a non-empty string`);
  }
  if (type === "local-path") {
    if (typeof path !== "string" || path === "") {
      throw new ManifestValidationError(`source "${name}": "path" must be a non-empty string`);
    }
    return { name, type, path, root };
  }
  if (type === "git") {
    if (typeof remote !== "string" || remote === "") {
      throw new ManifestValidationError(`source "${name}": "remote" must be a non-empty string`);
    }
    if (typeof branch !== "string" || branch === "") {
      throw new ManifestValidationError(`source "${name}": "branch" must be a non-empty string`);
    }
    return { name, type, remote, branch, root };
  }
  throw new ManifestValidationError(`source "${name}": "type" must be "local-path" or "git"`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/manifest.ts tests/manifest.test.ts
git commit -m "feat: manifest, store.lock and external-source validation"
```

---

### Task 5: FileIO abstraction + in-memory test FS

**Files:**
- Create: `src/core/io.ts`, `tests/memfs.ts`
- Test: `tests/io.test.ts`

**Interfaces:**
- Produces:
  - `io.ts`: `ListedDir { files: string[]; folders: string[] }`; `FileIO { read(path): Promise<string>; write(path, data): Promise<void>; exists(path): Promise<boolean>; remove(path): Promise<void>; rmdir(path, recursive: boolean): Promise<void>; mkdir(path): Promise<void>; list(path): Promise<ListedDir> }` — structurally satisfied by Obsidian's `DataAdapter`; `listFilesRecursive(io, dir): Promise<string[]>` (full paths, sorted); `ensureParentDir(io, filePath): Promise<void>`; `pruneEmptyDirsUnder(io, dir): Promise<void>` (removes empty subdirs, keeps `dir` itself).
  - `memfs.ts`: `class MemFS implements FileIO` with `seed(files: Record<string, string>): void`; `class FakePlugins` with `installed: Map<string, string>`, `enabled: Set<string>`, `log: string[]` implementing the `PluginHost` shape used in Task 6.

- [ ] **Step 1: Write the failing tests — `tests/io.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { listFilesRecursive, ensureParentDir, pruneEmptyDirsUnder } from "../src/core/io";
import { MemFS } from "./memfs";

describe("listFilesRecursive", () => {
  it("returns all files under a dir, sorted, full paths", async () => {
    const io = new MemFS();
    io.seed({ "a/x.md": "1", "a/sub/y.md": "2", "b/z.md": "3" });
    expect(await listFilesRecursive(io, "a")).toEqual(["a/sub/y.md", "a/x.md"]);
  });
});

describe("ensureParentDir", () => {
  it("creates missing ancestor dirs", async () => {
    const io = new MemFS();
    await ensureParentDir(io, "one/two/three/file.txt");
    expect(await io.exists("one/two/three")).toBe(true);
  });
  it("is a no-op for root-level files", async () => {
    const io = new MemFS();
    await ensureParentDir(io, "file.txt");
    expect(io.dirs.size).toBe(0);
  });
});

describe("pruneEmptyDirsUnder", () => {
  it("removes empty subdirs but keeps the base and non-empty dirs", async () => {
    const io = new MemFS();
    io.seed({ "base/keep/file.md": "x" });
    await io.mkdir("base/empty/nested");
    await pruneEmptyDirsUnder(io, "base");
    expect(await io.exists("base/empty")).toBe(false);
    expect(await io.exists("base/keep")).toBe(true);
    expect(await io.exists("base")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/io.test.ts`
Expected: FAIL — cannot resolve `../src/core/io` / `./memfs`.

- [ ] **Step 3: Write `src/core/io.ts`**

```ts
export interface ListedDir {
  files: string[];
  folders: string[];
}

// Structurally satisfied by Obsidian's DataAdapter (app.vault.adapter).
export interface FileIO {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<ListedDir>;
}

export async function listFilesRecursive(io: FileIO, dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const listed = await io.list(cur);
    out.push(...listed.files);
    stack.push(...listed.folders);
  }
  return out.sort();
}

export async function ensureParentDir(io: FileIO, filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf("/");
  if (idx === -1) return;
  const parts = filePath.slice(0, idx).split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur === "" ? part : `${cur}/${part}`;
    if (!(await io.exists(cur))) {
      await io.mkdir(cur);
    }
  }
}

export async function pruneEmptyDirsUnder(io: FileIO, dir: string): Promise<void> {
  const listed = await io.list(dir);
  for (const sub of listed.folders) {
    await pruneDir(io, sub);
  }
}

async function pruneDir(io: FileIO, dir: string): Promise<boolean> {
  const listed = await io.list(dir);
  let empty = listed.files.length === 0;
  for (const sub of listed.folders) {
    const removed = await pruneDir(io, sub);
    if (!removed) empty = false;
  }
  if (empty) {
    await io.rmdir(dir, false);
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Write `tests/memfs.ts`**

```ts
import { FileIO, ListedDir } from "../src/core/io";

export class MemFS implements FileIO {
  files = new Map<string, string>();
  dirs = new Set<string>();

  seed(files: Record<string, string>): void {
    for (const [p, content] of Object.entries(files)) {
      this.files.set(p, content);
      this.addAncestors(p);
    }
  }

  private addAncestors(path: string): void {
    let cur = path;
    while (cur.includes("/")) {
      cur = cur.slice(0, cur.lastIndexOf("/"));
      this.dirs.add(cur);
    }
  }

  async read(path: string): Promise<string> {
    const c = this.files.get(path);
    if (c === undefined) throw new Error(`MemFS: read of missing file ${path}`);
    return c;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    this.addAncestors(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`MemFS: remove of missing file ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
    this.addAncestors(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.dirs.has(path)) throw new Error(`MemFS: rmdir of missing dir ${path}`);
    const children = [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(path + "/"));
    if (!recursive && children.length > 0) {
      throw new Error(`MemFS: rmdir of non-empty dir ${path}`);
    }
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(path + "/")) this.files.delete(f);
    }
    for (const d of [...this.dirs]) {
      if (d === path || d.startsWith(path + "/")) this.dirs.delete(d);
    }
  }

  async list(path: string): Promise<ListedDir> {
    if (!this.dirs.has(path)) throw new Error(`MemFS: list of missing dir ${path}`);
    const files: string[] = [];
    const folders = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(path + "/")) continue;
      const rest = f.slice(path.length + 1);
      if (rest.includes("/")) folders.add(`${path}/${rest.slice(0, rest.indexOf("/"))}`);
      else files.push(f);
    }
    for (const d of this.dirs) {
      if (!d.startsWith(path + "/")) continue;
      const rest = d.slice(path.length + 1);
      if (!rest.includes("/")) folders.add(d);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }
}

export class FakePlugins {
  installed = new Map<string, string>();
  enabled = new Set<string>();
  log: string[] = [];

  getInstalledPluginVersion(id: string): string | null {
    return this.installed.get(id) ?? null;
  }
  isPluginEnabled(id: string): boolean {
    return this.enabled.has(id);
  }
  async disablePlugin(id: string): Promise<void> {
    this.enabled.delete(id);
    this.log.push(`disable:${id}`);
  }
  async enablePlugin(id: string): Promise<void> {
    this.enabled.add(id);
    this.log.push(`enable:${id}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/io.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/io.ts tests/memfs.ts tests/io.test.ts
git commit -m "feat: FileIO abstraction with recursive helpers and in-memory test FS"
```

---

### Task 6: Core — publish

**Files:**
- Create: `src/core/ConfigSyncCore.ts`
- Test: `tests/core.test.ts` (new file; Tasks 7–9 extend it)

**Interfaces:**
- Consumes: everything produced by Tasks 2–5.
- Produces (used by Tasks 7–9 and 12):
  - `PluginHost { getInstalledPluginVersion(id: string): string | null; isPluginEnabled(id: string): boolean; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> }`
  - `CoreContext { io: FileIO; configDir: string; rootPath: string; plugins: PluginHost; now(): string }`
  - `manifestPath(ctx)`, `lockPath(ctx)`, `storeDir(ctx)`, `backupDir(ctx)` — path helpers
  - `pluginIdForGroup(group: SyncGroup): string | null`
  - `loadManifest(ctx): Promise<SyncManifest>`, `loadLock(ctx): Promise<StoreLock | null>`
  - `groupsForDevice(manifest: SyncManifest, device: "desktop" | "mobile"): SyncGroup[]`
  - `publish(ctx): Promise<GroupResult[]>`

- [ ] **Step 1: Write the failing tests — `tests/core.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { CoreContext, publish, loadManifest, groupsForDevice } from "../src/core/ConfigSyncCore";
import { parseSyncManifest } from "../src/core/manifest";
import { MemFS, FakePlugins } from "./memfs";

export const MANIFEST = JSON.stringify({
  version: 1,
  groups: [
    { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all" },
    { name: "vimrc", path: ".obsidian.vimrc", type: "file", devices: "desktop" },
    { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all", sanitize: ["*Token*"] },
  ],
});

export function setup(): { io: MemFS; plugins: FakePlugins; ctx: CoreContext } {
  const io = new MemFS();
  const plugins = new FakePlugins();
  const ctx: CoreContext = {
    io,
    configDir: ".obs",
    rootPath: "cs",
    plugins,
    now: () => "2026-07-08T00:00:00.000Z",
  };
  return { io, plugins, ctx };
}

describe("loadManifest", () => {
  it("throws a clear error when the manifest is missing", async () => {
    const { ctx } = setup();
    await expect(loadManifest(ctx)).rejects.toThrow("cs/manifest.json");
  });
});

describe("groupsForDevice", () => {
  it("filters by device class", () => {
    const manifest = parseSyncManifest(MANIFEST);
    expect(groupsForDevice(manifest, "mobile").map((g) => g.name)).toEqual(["hotkeys", "snippets", "plugin-demo"]);
    expect(groupsForDevice(manifest, "desktop").map((g) => g.name)).toEqual(["hotkeys", "snippets", "vimrc", "plugin-demo"]);
  });
});

describe("publish", () => {
  it("mirrors groups into the store with sanitization, deletion propagation and version stamps", async () => {
    const { io, plugins, ctx } = setup();
    plugins.installed.set("demo", "1.2.3");
    io.seed({
      "cs/manifest.json": MANIFEST,
      ".obs/hotkeys.json": '{"a":1}',
      ".obs/snippets/one.css": "one",
      ".obs/snippets/sub/two.css": "two",
      ".obsidian.vimrc": "imap jk <Esc>",
      ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"x"}',
      "cs/store/configdir/snippets/stale.css": "stale",
    });
    const results = await publish(ctx);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":1}');
    expect(await io.read("cs/store/obsidian.vimrc")).toBe("imap jk <Esc>");
    expect(await io.exists("cs/store/configdir/snippets/stale.css")).toBe(false);
    expect(await io.read("cs/store/configdir/snippets/sub/two.css")).toBe("two");
    expect(JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json"))).toEqual({ theme: "x" });
    const lock = JSON.parse(await io.read("cs/store.lock.json"));
    expect(lock).toEqual({
      publishedAt: "2026-07-08T00:00:00.000Z",
      groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" } },
    });
  });

  it("fails with the group name when a source is missing", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": MANIFEST });
    await expect(publish(ctx)).rejects.toThrow('group "hotkeys"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — cannot resolve `../src/core/ConfigSyncCore`.

- [ ] **Step 3: Write `src/core/ConfigSyncCore.ts`**

```ts
import { FileIO, ensureParentDir, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { GroupResult, StoreLock, SyncGroup, SyncManifest } from "./types";
import { groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { parseStoreLock, parseSyncManifest } from "./manifest";
import { mergePreservingSanitized, sanitizeJson } from "./sanitize";

export interface PluginHost {
  getInstalledPluginVersion(id: string): string | null;
  isPluginEnabled(id: string): boolean;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
}

export interface CoreContext {
  io: FileIO;
  configDir: string;
  rootPath: string;
  plugins: PluginHost;
  now(): string; // ISO-8601 timestamp, injectable for tests
}

export function manifestPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/manifest.json`;
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

export function backupDir(ctx: CoreContext): string {
  return `${ctx.configDir}/plugins/obsidian-config-sync/backup`;
}

export function pluginIdForGroup(group: SyncGroup): string | null {
  const m = group.path.match(/^\{configDir\}\/plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

export async function loadManifest(ctx: CoreContext): Promise<SyncManifest> {
  const p = manifestPath(ctx);
  if (!(await ctx.io.exists(p))) {
    throw new Error(`Config Sync manifest not found: ${p}. Create it before running commands (see README).`);
  }
  return parseSyncManifest(await ctx.io.read(p));
}

export async function loadLock(ctx: CoreContext): Promise<StoreLock | null> {
  const p = lockPath(ctx);
  if (!(await ctx.io.exists(p))) return null;
  return parseStoreLock(await ctx.io.read(p));
}

export function groupsForDevice(manifest: SyncManifest, device: "desktop" | "mobile"): SyncGroup[] {
  return manifest.groups.filter((g) => g.devices === "all" || g.devices === device);
}

function requireGroup(manifest: SyncManifest, name: string): SyncGroup {
  const group = manifest.groups.find((g) => g.name === name);
  if (group === undefined) {
    throw new Error(`Unknown config-sync group "${name}" — not defined in manifest.json`);
  }
  return group;
}

function parseJsonOrThrow(raw: string, groupName: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Group "${groupName}": ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function emptyResult(group: string, needsAppReload: boolean): GroupResult {
  return { group, status: "ok", filesWritten: [], filesDeleted: [], messages: [], needsAppReload };
}

export async function publish(ctx: CoreContext): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  const lock: StoreLock = { publishedAt: ctx.now(), groups: {} };
  const results: GroupResult[] = [];
  for (const group of manifest.groups) {
    const result = await publishGroup(ctx, group);
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      const version = ctx.plugins.getInstalledPluginVersion(pluginId);
      if (version !== null) {
        lock.groups[group.name] = { sourcePluginVersion: version };
      } else {
        result.status = "warning";
        result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
      }
    }
    results.push(result);
  }
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}

async function publishGroup(ctx: CoreContext, group: SyncGroup): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const result = emptyResult(group.name, false);
  if (!(await ctx.io.exists(real))) {
    throw new Error(`Publish failed: source of group "${group.name}" not found: ${real}`);
  }
  if (group.type === "file") {
    let content = await ctx.io.read(real);
    if (group.sanitize !== undefined) {
      const sanitized = sanitizeJson(parseJsonOrThrow(content, group.name, real), group.sanitize);
      content = JSON.stringify(sanitized, null, 2) + "\n";
    }
    await ensureParentDir(ctx.io, store);
    await ctx.io.write(store, content);
    result.filesWritten.push(store);
    return result;
  }
  const sourceFiles = await listFilesRecursive(ctx.io, real);
  const sourceRels = sourceFiles.map((f) => relativeTo(real, f));
  for (const rel of sourceRels) {
    const target = `${store}/${rel}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await ctx.io.read(`${real}/${rel}`));
    result.filesWritten.push(target);
  }
  if (await ctx.io.exists(store)) {
    const storeFiles = await listFilesRecursive(ctx.io, store);
    const wanted = new Set(sourceRels);
    for (const f of storeFiles) {
      if (!wanted.has(relativeTo(store, f))) {
        await ctx.io.remove(f);
        result.filesDeleted.push(f);
      }
    }
    await pruneEmptyDirsUnder(ctx.io, store);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: publish — sanitized mirror into store with version stamps"
```

---

### Task 7: Core — apply + checkApply + backup

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (append)
- Test: `tests/core.test.ts` (append)

**Interfaces:**
- Consumes: Task 6 exports (`CoreContext`, `backupDir`, `storeDir`, `pluginIdForGroup`, `loadManifest`, `loadLock`, private helpers `requireGroup`/`parseJsonOrThrow`/`emptyResult`).
- Produces:
  - `ApplyWarning { group: string; message: string }`
  - `checkApply(ctx, groupNames: string[]): Promise<ApplyWarning[]>`
  - `apply(ctx, groupNames: string[]): Promise<GroupResult[]>`
  - `BackupEntry { realPath: string; existed: boolean; backupFile: string | null }`, `BackupIndex { createdAt: string; entries: BackupEntry[] }` — persisted at `backupDir(ctx)/index.json`, content files at `backupDir(ctx)/files/<n>`.

- [ ] **Step 1: Append the failing tests to `tests/core.test.ts`**

Add `apply, checkApply` to the existing import from `../src/core/ConfigSyncCore`, then append at module scope:

```ts
export function seedStore(io: MemFS): void {
  io.seed({
    "cs/manifest.json": MANIFEST,
    "cs/store.lock.json": JSON.stringify({
      publishedAt: "t",
      groups: { "plugin-demo": { sourcePluginVersion: "1.2.3" } },
    }),
    "cs/store/configdir/hotkeys.json": '{"a":2}',
    "cs/store/configdir/snippets/one.css": "one-v2",
    "cs/store/configdir/plugins/demo/data.json": '{"theme":"new"}',
  });
}

describe("apply", () => {
  it("applies only the selected groups", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    io.seed({ ".obs/hotkeys.json": '{"a":1}' });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results).toHaveLength(1);
    expect(results[0].needsAppReload).toBe(true);
    expect(await io.read(".obs/hotkeys.json")).toBe('{"a":2}');
    expect(await io.exists(".obs/snippets/one.css")).toBe(false);
  });

  it("merges sanitized keys from the local file and cycles the plugin", async () => {
    const { io, plugins, ctx } = setup();
    seedStore(io);
    plugins.installed.set("demo", "1.2.3");
    plugins.enabled.add("demo");
    io.seed({ ".obs/plugins/demo/data.json": '{"vikaToken":"secret","theme":"old"}' });
    const results = await apply(ctx, ["plugin-demo"]);
    expect(results[0].status).toBe("ok");
    expect(results[0].needsAppReload).toBe(false);
    expect(JSON.parse(await io.read(".obs/plugins/demo/data.json"))).toEqual({ theme: "new", vikaToken: "secret" });
    expect(plugins.log).toEqual(["disable:demo", "enable:demo"]);
  });

  it("mirrors dir groups with deletion and records a backup", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    io.seed({ ".obs/snippets/local-only.css": "bye", ".obs/snippets/one.css": "one-v1" });
    const results = await apply(ctx, ["snippets"]);
    expect(await io.read(".obs/snippets/one.css")).toBe("one-v2");
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(results[0].filesDeleted).toEqual([".obs/snippets/local-only.css"]);
    const index = JSON.parse(await io.read(".obs/plugins/obsidian-config-sync/backup/index.json"));
    const paths = index.entries.map((e: { realPath: string }) => e.realPath).sort();
    expect(paths).toEqual([".obs/snippets/local-only.css", ".obs/snippets/one.css"]);
  });

  it("reports an error result when the store has no data for a group", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": MANIFEST });
    const results = await apply(ctx, ["hotkeys"]);
    expect(results[0].status).toBe("error");
    expect(results[0].messages[0]).toContain("publish it from the source vault first");
  });
});

describe("checkApply", () => {
  it("warns on version mismatch", async () => {
    const { io, plugins, ctx } = setup();
    seedStore(io);
    plugins.installed.set("demo", "9.9.9");
    const warnings = await checkApply(ctx, ["hotkeys", "plugin-demo"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].group).toBe("plugin-demo");
    expect(warnings[0].message).toContain("1.2.3");
    expect(warnings[0].message).toContain("9.9.9");
  });

  it("warns when the plugin is not installed on this device", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    const warnings = await checkApply(ctx, ["plugin-demo"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("not installed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — `apply` / `checkApply` are not exported.

- [ ] **Step 3: Append to `src/core/ConfigSyncCore.ts`**

```ts
export interface ApplyWarning {
  group: string;
  message: string;
}

export interface BackupEntry {
  realPath: string;
  existed: boolean;
  backupFile: string | null;
}

export interface BackupIndex {
  createdAt: string;
  entries: BackupEntry[];
}

interface BackupState {
  index: BackupIndex;
  counter: number;
  backedUp: Set<string>;
}

export async function checkApply(ctx: CoreContext, groupNames: string[]): Promise<ApplyWarning[]> {
  const manifest = await loadManifest(ctx);
  const lock = await loadLock(ctx);
  const warnings: ApplyWarning[] = [];
  for (const name of groupNames) {
    const group = requireGroup(manifest, name);
    const pluginId = pluginIdForGroup(group);
    if (pluginId === null) continue;
    const installed = ctx.plugins.getInstalledPluginVersion(pluginId);
    const recorded = lock?.groups[name]?.sourcePluginVersion ?? null;
    if (installed === null) {
      warnings.push({
        group: name,
        message: `plugin "${pluginId}" is not installed on this device; its config will be staged for a future install`,
      });
    } else if (recorded !== null && recorded !== installed) {
      warnings.push({
        group: name,
        message: `store config was published from ${pluginId}@${recorded}, this device runs ${pluginId}@${installed} — settings schema may differ`,
      });
    } else if (recorded === null) {
      warnings.push({
        group: name,
        message: `store.lock.json has no recorded version for this group — cannot verify compatibility`,
      });
    }
  }
  return warnings;
}

export async function apply(ctx: CoreContext, groupNames: string[]): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  if (await ctx.io.exists(backupDir(ctx))) {
    await ctx.io.rmdir(backupDir(ctx), true);
  }
  const state: BackupState = {
    index: { createdAt: ctx.now(), entries: [] },
    counter: 0,
    backedUp: new Set(),
  };
  const results: GroupResult[] = [];
  for (const name of groupNames) {
    results.push(await applyGroup(ctx, requireGroup(manifest, name), state));
  }
  const indexPath = `${backupDir(ctx)}/index.json`;
  await ensureParentDir(ctx.io, indexPath);
  await ctx.io.write(indexPath, JSON.stringify(state.index, null, 2) + "\n");
  return results;
}

async function backupOnce(ctx: CoreContext, state: BackupState, realPath: string): Promise<void> {
  if (state.backedUp.has(realPath)) return;
  state.backedUp.add(realPath);
  const existed = await ctx.io.exists(realPath);
  let backupFile: string | null = null;
  if (existed) {
    backupFile = `files/${state.counter}`;
    state.counter += 1;
    const target = `${backupDir(ctx)}/${backupFile}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await ctx.io.read(realPath));
  }
  state.index.entries.push({ realPath, existed, backupFile });
}

async function applyGroup(ctx: CoreContext, group: SyncGroup, state: BackupState): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const pluginId = pluginIdForGroup(group);
  const result = emptyResult(group.name, pluginId === null);
  if (!(await ctx.io.exists(store))) {
    result.status = "error";
    result.needsAppReload = false;
    result.messages.push(`store has no data for this group (expected at ${store}) — publish it from the source vault first`);
    return result;
  }
  const pluginWasEnabled = pluginId !== null && ctx.plugins.isPluginEnabled(pluginId);
  if (pluginId !== null && pluginWasEnabled) {
    await ctx.plugins.disablePlugin(pluginId);
  }
  try {
    if (group.type === "file") {
      let content = await ctx.io.read(store);
      if (group.sanitize !== undefined && (await ctx.io.exists(real))) {
        const local = parseJsonOrThrow(await ctx.io.read(real), group.name, real);
        const incoming = parseJsonOrThrow(content, group.name, store);
        content = JSON.stringify(mergePreservingSanitized(local, incoming, group.sanitize), null, 2) + "\n";
      }
      await backupOnce(ctx, state, real);
      await ensureParentDir(ctx.io, real);
      await ctx.io.write(real, content);
      result.filesWritten.push(real);
    } else {
      const storeFiles = await listFilesRecursive(ctx.io, store);
      const rels = storeFiles.map((f) => relativeTo(store, f));
      for (const rel of rels) {
        const target = `${real}/${rel}`;
        await backupOnce(ctx, state, target);
        await ensureParentDir(ctx.io, target);
        await ctx.io.write(target, await ctx.io.read(`${store}/${rel}`));
        result.filesWritten.push(target);
      }
      if (await ctx.io.exists(real)) {
        const realFiles = await listFilesRecursive(ctx.io, real);
        const wanted = new Set(rels);
        for (const f of realFiles) {
          if (!wanted.has(relativeTo(real, f))) {
            await backupOnce(ctx, state, f);
            await ctx.io.remove(f);
            result.filesDeleted.push(f);
          }
        }
        await pruneEmptyDirsUnder(ctx.io, real);
      }
    }
  } finally {
    if (pluginId !== null && pluginWasEnabled) {
      await ctx.plugins.enablePlugin(pluginId);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: apply — selective landing with merge, backup and plugin cycling"
```

---

### Task 8: Core — revert last apply

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (append)
- Test: `tests/core.test.ts` (append)

**Interfaces:**
- Consumes: `apply` (Task 7), `backupDir`, `BackupIndex`.
- Produces: `revertLastApply(ctx): Promise<GroupResult>` — result `group` field is the literal string `"revert"`.

- [ ] **Step 1: Append the failing tests to `tests/core.test.ts`**

Add `revertLastApply` to the core import, then:

```ts
describe("revertLastApply", () => {
  it("restores overwritten files and deletes files created by apply", async () => {
    const { io, ctx } = setup();
    seedStore(io);
    io.seed({ ".obs/snippets/local-only.css": "bye" });
    await apply(ctx, ["snippets", "hotkeys"]);
    expect(await io.exists(".obs/snippets/local-only.css")).toBe(false);
    expect(await io.read(".obs/hotkeys.json")).toBe('{"a":2}');
    const result = await revertLastApply(ctx);
    expect(result.status).toBe("ok");
    expect(result.needsAppReload).toBe(true);
    expect(await io.read(".obs/snippets/local-only.css")).toBe("bye");
    expect(await io.exists(".obs/hotkeys.json")).toBe(false);
  });

  it("throws a clear error when there is no backup", async () => {
    const { ctx } = setup();
    await expect(revertLastApply(ctx)).rejects.toThrow("Nothing to revert");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — `revertLastApply` is not exported.

- [ ] **Step 3: Append to `src/core/ConfigSyncCore.ts`**

```ts
export async function revertLastApply(ctx: CoreContext): Promise<GroupResult> {
  const indexPath = `${backupDir(ctx)}/index.json`;
  if (!(await ctx.io.exists(indexPath))) {
    throw new Error(`No apply backup found (${indexPath}). Nothing to revert.`);
  }
  const index = JSON.parse(await ctx.io.read(indexPath)) as BackupIndex;
  const result = emptyResult("revert", true);
  result.messages.push(`reverted the apply from ${index.createdAt}; reload the app to take effect`);
  for (const entry of index.entries) {
    if (entry.existed && entry.backupFile !== null) {
      await ensureParentDir(ctx.io, entry.realPath);
      await ctx.io.write(entry.realPath, await ctx.io.read(`${backupDir(ctx)}/${entry.backupFile}`));
      result.filesWritten.push(entry.realPath);
    } else if (await ctx.io.exists(entry.realPath)) {
      await ctx.io.remove(entry.realPath);
      result.filesDeleted.push(entry.realPath);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: revert last apply from the single-slot backup"
```

---

### Task 9: Core — import from external store

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (append)
- Test: `tests/core.test.ts` (append)

**Interfaces:**
- Consumes: `parseSyncManifest`, `listFilesRecursive`, `pruneEmptyDirsUnder`, `ensureParentDir`.
- Produces: `ExternalStoreReader { listFiles(): Promise<string[]>; readFile(relPath: string): Promise<string> }` — paths relative to the source `<root>/`, `/`-separated; `importExternal(ctx, reader): Promise<GroupResult>` — result `group` field is `"import"`. Task 10 implements readers against this interface.

- [ ] **Step 1: Append the failing tests to `tests/core.test.ts`**

Add `importExternal` and type `ExternalStoreReader` to the core import, then:

```ts
function fakeReader(files: Record<string, string>): ExternalStoreReader {
  return {
    async listFiles() {
      return Object.keys(files).sort();
    },
    async readFile(rel) {
      const content = files[rel];
      if (content === undefined) throw new Error(`missing ${rel}`);
      return content;
    },
  };
}

describe("importExternal", () => {
  it("overwrites the local root with deletion propagation", async () => {
    const { io, ctx } = setup();
    io.seed({ "cs/manifest.json": '{"version":1,"groups":[]}', "cs/store/old.css": "old" });
    const result = await importExternal(ctx, fakeReader({
      "manifest.json": MANIFEST,
      "store.lock.json": '{"publishedAt":"t","groups":{}}',
      "store/configdir/hotkeys.json": '{"a":3}',
    }));
    expect(result.status).toBe("ok");
    expect(await io.read("cs/store/configdir/hotkeys.json")).toBe('{"a":3}');
    expect(await io.read("cs/manifest.json")).toBe(MANIFEST);
    expect(await io.exists("cs/store/old.css")).toBe(false);
    expect(result.filesDeleted).toEqual(["cs/store/old.css"]);
  });

  it("rejects sources without a manifest.json", async () => {
    const { ctx } = setup();
    await expect(importExternal(ctx, fakeReader({ "store/x.css": "x" }))).rejects.toThrow("no manifest.json");
  });

  it("rejects sources whose manifest is invalid", async () => {
    const { ctx } = setup();
    await expect(importExternal(ctx, fakeReader({ "manifest.json": '{"version":9}' }))).rejects.toThrow("unsupported version");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL — `importExternal` is not exported.

- [ ] **Step 3: Append to `src/core/ConfigSyncCore.ts`**

```ts
export interface ExternalStoreReader {
  listFiles(): Promise<string[]>; // relative to the source <root>/, "/"-separated
  readFile(relPath: string): Promise<string>;
}

export async function importExternal(ctx: CoreContext, reader: ExternalStoreReader): Promise<GroupResult> {
  const files = await reader.listFiles();
  if (!files.includes("manifest.json")) {
    throw new Error(`External source has no manifest.json at its root — check the source "root" setting.`);
  }
  parseSyncManifest(await reader.readFile("manifest.json")); // fail fast on invalid upstream data
  const result = emptyResult("import", false);
  for (const rel of files) {
    const target = `${ctx.rootPath}/${rel}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await reader.readFile(rel));
    result.filesWritten.push(target);
  }
  const wanted = new Set(files.map((f) => `${ctx.rootPath}/${f}`));
  const localFiles = await listFilesRecursive(ctx.io, ctx.rootPath);
  for (const f of localFiles) {
    if (!wanted.has(f)) {
      await ctx.io.remove(f);
      result.filesDeleted.push(f);
    }
  }
  await pruneEmptyDirsUnder(ctx.io, ctx.rootPath);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core.test.ts`
Expected: PASS (15 tests). Also run the full suite: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat: import external store with deletion propagation"
```

---

### Task 10: External sources — local path & git (desktop)

**Files:**
- Create: `src/external/localPath.ts`, `src/external/gitSource.ts`
- Test: `tests/external.test.ts`

**Interfaces:**
- Consumes: `ExternalStoreReader` from `src/core/ConfigSyncCore`.
- Produces:
  - `createLocalPathReader(sourceVaultPath: string, sourceRoot: string): ExternalStoreReader`
  - `createGitReader(vaultBasePath: string, remoteUrl: string, branch: string, sourceRoot: string): Promise<ExternalStoreReader>` — manages a read-only remote named `config-sync-import` in the vault's own repo; reads blobs via `git show FETCH_HEAD:<path>`; never touches worktree or index.
- These modules import Node `fs`/`child_process` — they may ONLY be loaded via dynamic `import()` from desktop-gated code (Global Constraints).

- [ ] **Step 1: Write the failing tests — `tests/external.test.ts`**

Real integration: temp dirs via Node fs, a real git repo as source, a second real git repo as consumer. Requires the `git` binary (present on the dev machine).

```ts
import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as nodePath from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitReader } from "../src/external/gitSource";
import { createLocalPathReader } from "../src/external/localPath";

const run = promisify(execFile);

let sourceRepo: string;
let consumerRepo: string;

beforeAll(async () => {
  sourceRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-source-"));
  consumerRepo = await mkdtemp(nodePath.join(tmpdir(), "cs-consumer-"));
  await mkdir(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir"), { recursive: true });
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/manifest.json"), '{"version":1,"groups":[]}');
  await writeFile(nodePath.join(sourceRepo, "0-Extra/config-sync/store/configdir/hotkeys.json"), "{}");
  await run("git", ["init", "-b", "main"], { cwd: sourceRepo });
  await run("git", ["add", "."], { cwd: sourceRepo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: sourceRepo });
  await run("git", ["init", "-b", "main"], { cwd: consumerRepo });
});

afterAll(async () => {
  await rm(sourceRepo, { recursive: true, force: true });
  await rm(consumerRepo, { recursive: true, force: true });
});

describe("createLocalPathReader", () => {
  it("lists and reads files under the source root", async () => {
    const reader = createLocalPathReader(sourceRepo, "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["manifest.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("store/configdir/hotkeys.json")).toBe("{}");
  });

  it("fails with a clear error when the root does not exist", async () => {
    const reader = createLocalPathReader(sourceRepo, "no/such/root");
    await expect(reader.listFiles()).rejects.toThrow("External source root not found");
  });
});

describe("createGitReader", () => {
  it("lists and reads files from a remote branch without touching the worktree", async () => {
    const reader = await createGitReader(consumerRepo, sourceRepo, "main", "0-Extra/config-sync");
    expect(await reader.listFiles()).toEqual(["manifest.json", "store/configdir/hotkeys.json"]);
    expect(await reader.readFile("manifest.json")).toBe('{"version":1,"groups":[]}');
    const status = (await run("git", ["status", "--porcelain"], { cwd: consumerRepo })).stdout;
    expect(status).toBe("");
  });

  it("updates the remote url on subsequent calls instead of failing", async () => {
    const reader = await createGitReader(consumerRepo, sourceRepo, "main", "0-Extra/config-sync");
    expect(await reader.listFiles()).toContain("manifest.json");
  });

  it("fails with a contextual error for an unreachable remote", async () => {
    await expect(createGitReader(consumerRepo, "/no/such/repo", "main", "x")).rejects.toThrow("git fetch");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/external.test.ts`
Expected: FAIL — cannot resolve `../src/external/gitSource` / `../src/external/localPath`.

- [ ] **Step 3: Write `src/external/localPath.ts`**

```ts
import { promises as fs } from "fs";
import * as nodePath from "path";
import { ExternalStoreReader } from "../core/ConfigSyncCore";

export function createLocalPathReader(sourceVaultPath: string, sourceRoot: string): ExternalStoreReader {
  const base = nodePath.join(sourceVaultPath, sourceRoot);
  return {
    async listFiles(): Promise<string[]> {
      try {
        await fs.access(base);
      } catch {
        throw new Error(`External source root not found: ${base} — check the source "path" and "root" settings`);
      }
      const out: string[] = [];
      await walk(base, "", out);
      return out.sort();
    },
    async readFile(relPath: string): Promise<string> {
      return fs.readFile(nodePath.join(base, relPath), "utf8");
    },
  };
}

async function walk(absBase: string, rel: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(nodePath.join(absBase, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(absBase, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}
```

- [ ] **Step 4: Write `src/external/gitSource.ts`**

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import { ExternalStoreReader } from "../core/ConfigSyncCore";

const execFileP = promisify(execFile);
const REMOTE_NAME = "config-sync-import";

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(e as Error).message}`);
  }
}

export async function createGitReader(
  vaultBasePath: string,
  remoteUrl: string,
  branch: string,
  sourceRoot: string
): Promise<ExternalStoreReader> {
  const remotes = (await git(vaultBasePath, ["remote"])).split("\n").filter(Boolean);
  if (remotes.includes(REMOTE_NAME)) {
    await git(vaultBasePath, ["remote", "set-url", REMOTE_NAME, remoteUrl]);
  } else {
    await git(vaultBasePath, ["remote", "add", REMOTE_NAME, remoteUrl]);
  }
  await git(vaultBasePath, ["fetch", REMOTE_NAME, branch]);
  const prefix = sourceRoot.endsWith("/") ? sourceRoot : sourceRoot + "/";
  const listed = await git(vaultBasePath, ["ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", prefix]);
  const files = listed
    .split("\n")
    .filter(Boolean)
    .map((f) => f.slice(prefix.length))
    .sort();
  return {
    async listFiles(): Promise<string[]> {
      return files;
    },
    async readFile(relPath: string): Promise<string> {
      return git(vaultBasePath, ["show", `FETCH_HEAD:${prefix}${relPath}`]);
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/external.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/external/localPath.ts src/external/gitSource.ts tests/external.test.ts
git commit -m "feat: external store readers — local path and read-only git blobs"
```

---

### Task 11: UI — modals and settings tab

**Files:**
- Create: `src/ui/GroupSelectModal.ts`, `src/ui/ConfirmModal.ts`, `src/ui/ReportModal.ts`, `src/ui/SourceSelectModal.ts`, `src/ui/SettingTab.ts`

**Interfaces:**
- Consumes: `SyncGroup`, `GroupResult`, `ExternalSource` from `src/core/types`; `parseExternalSources` from `src/core/manifest`.
- Produces (used by Task 12):
  - `new GroupSelectModal(app, groups: SyncGroup[], modalTitle: string, onSubmit: (names: string[]) => void)`
  - `confirmWarnings(app, title: string, lines: string[]): Promise<boolean>`
  - `new ReportModal(app, modalTitle: string, results: GroupResult[])`
  - `new SourceSelectModal(app, sources: ExternalSource[], onChoose: (s: ExternalSource) => void)`
  - `new ConfigSyncSettingTab(app, plugin)` where plugin exposes `settings: { rootPath: string; externalSources: ExternalSource[] }` and `saveSettings(): Promise<void>` (defined in Task 12; declared here as the `SettingsHost` interface to avoid a circular import).
- No unit tests (pure UI); exercised in Task 12's manual smoke test. `npm run build` type-checks everything.

- [ ] **Step 1: Write `src/ui/GroupSelectModal.ts`**

```ts
import { App, Modal, Setting } from "obsidian";
import { SyncGroup } from "../core/types";

export class GroupSelectModal extends Modal {
  private selected = new Set<string>();

  constructor(
    app: App,
    private groups: SyncGroup[],
    private modalTitle: string,
    private onSubmit: (names: string[]) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const group of this.groups) {
      new Setting(this.contentEl)
        .setName(group.name)
        .setDesc(`${group.path} · ${group.type} · ${group.devices}`)
        .addToggle((t) =>
          t.setValue(false).onChange((v) => {
            if (v) this.selected.add(group.name);
            else this.selected.delete(group.name);
          })
        );
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setCta()
        .setButtonText("Continue")
        .onClick(() => {
          this.close();
          this.onSubmit([...this.selected]);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Write `src/ui/ConfirmModal.ts`**

```ts
import { App, Modal, Setting } from "obsidian";

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private modalTitle: string,
    private lines: string[],
    private onDone: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const line of this.lines) {
      this.contentEl.createEl("p", { text: line });
    }
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Continue anyway")
          .onClick(() => {
            this.confirmed = true;
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone(this.confirmed);
  }
}

export function confirmWarnings(app: App, title: string, lines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, lines, resolve).open();
  });
}
```

- [ ] **Step 3: Write `src/ui/ReportModal.ts`**

```ts
import { App, Modal, Setting } from "obsidian";
import { GroupResult } from "../core/types";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

export class ReportModal extends Modal {
  constructor(app: App, private modalTitle: string, private results: GroupResult[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const r of this.results) {
      const icon = r.status === "ok" ? "✓" : r.status === "warning" ? "⚠" : "✗";
      const block = this.contentEl.createDiv();
      block.createEl("strong", { text: `${icon} ${r.group}` });
      block.createEl("div", { text: `${r.filesWritten.length} written, ${r.filesDeleted.length} deleted` });
      for (const m of r.messages) {
        block.createEl("div", { text: `• ${m}` });
      }
    }
    if (this.results.some((r) => r.needsAppReload)) {
      new Setting(this.contentEl)
        .setName("Some changes need an app reload to take effect")
        .addButton((b) =>
          b
            .setCta()
            .setButtonText("Reload app")
            .onClick(() => {
              (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload");
            })
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 4: Write `src/ui/SourceSelectModal.ts`**

```ts
import { App, FuzzySuggestModal } from "obsidian";
import { ExternalSource } from "../core/types";

export class SourceSelectModal extends FuzzySuggestModal<ExternalSource> {
  constructor(app: App, private sources: ExternalSource[], private onChoose: (s: ExternalSource) => void) {
    super(app);
    this.setPlaceholder("Select an external source to import from");
  }

  getItems(): ExternalSource[] {
    return this.sources;
  }

  getItemText(s: ExternalSource): string {
    return `${s.name} (${s.type})`;
  }

  onChooseItem(s: ExternalSource): void {
    this.onChoose(s);
  }
}
```

- [ ] **Step 5: Write `src/ui/SettingTab.ts`**

```ts
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ExternalSource } from "../core/types";
import { parseExternalSources } from "../core/manifest";

export interface SettingsHost extends Plugin {
  settings: { rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
}

export class ConfigSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Data folder")
      .setDesc("Vault-relative folder holding manifest.json, store.lock.json and store/. Synced by remotely-save like normal notes.")
      .addText((t) =>
        t.setValue(this.host.settings.rootPath).onChange(async (v) => {
          this.host.settings.rootPath = v.trim();
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("External sources")
      .setDesc(
        'JSON array, desktop import only. Example: [{"name":"main (local)","type":"local-path","path":"/abs/path/main.vault","root":"0-Extra/config-sync"},{"name":"main (git)","type":"git","remote":"git@host:group/repo.git","branch":"main","root":"0-Extra/config-sync"}]'
      )
      .addTextArea((t) => {
        t.inputEl.rows = 10;
        t.inputEl.cols = 60;
        t.setValue(JSON.stringify(this.host.settings.externalSources, null, 2));
        t.onChange(async (v) => {
          try {
            this.host.settings.externalSources = parseExternalSources(v);
            await this.host.saveSettings();
          } catch (e) {
            new Notice(`External sources not saved: ${(e as Error).message}`, 8000);
          }
        });
      });
  }
}
```

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: exit 0, no errors.

```bash
git add src/ui/
git commit -m "feat: modals and settings tab"
```

---

### Task 12: Plugin shell — commands, wiring, manual smoke test

**Files:**
- Modify: `src/main.ts` (replace the Task 1 stub entirely)

**Interfaces:**
- Consumes: everything from Tasks 6–11.
- Produces: the four commands `Config Sync: Publish / Apply / Revert last apply / Import from external source`, ribbon icon, settings persistence. `ConfigSyncPlugin` satisfies `SettingsHost` from Task 11.

- [ ] **Step 1: Replace `src/main.ts`**

```ts
import { Notice, Platform, Plugin } from "obsidian";
import {
  CoreContext,
  ExternalStoreReader,
  PluginHost,
  apply,
  checkApply,
  groupsForDevice,
  importExternal,
  loadManifest,
  publish,
  revertLastApply,
} from "./core/ConfigSyncCore";
import { ExternalSource } from "./core/types";
import { GroupSelectModal } from "./ui/GroupSelectModal";
import { confirmWarnings } from "./ui/ConfirmModal";
import { ReportModal } from "./ui/ReportModal";
import { SourceSelectModal } from "./ui/SourceSelectModal";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

interface ConfigSyncSettings {
  rootPath: string;
  externalSources: ExternalSource[];
}

const DEFAULT_SETTINGS: ConfigSyncSettings = { rootPath: "config-sync", externalSources: [] };

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { version: string }>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
}

export default class ConfigSyncPlugin extends Plugin {
  settings: ConfigSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.addRibbonIcon("folder-sync", "Config Sync: Apply", () => {
      void this.runApply();
    });
    this.addCommand({ id: "publish", name: "Publish (vault config → store)", callback: () => void this.runPublish() });
    this.addCommand({ id: "apply", name: "Apply (store → this device)", callback: () => void this.runApply() });
    this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });
    this.addCommand({
      id: "import-from-external",
      name: "Import from external source",
      checkCallback: (checking) => {
        if (!Platform.isDesktop) return false;
        if (!checking) void this.runImport();
        return true;
      },
    });
  }

  private pluginRegistry(): CommunityPluginRegistry {
    return (this.app as unknown as { plugins: CommunityPluginRegistry }).plugins;
  }

  private coreContext(): CoreContext {
    const registry = this.pluginRegistry();
    const host: PluginHost = {
      getInstalledPluginVersion: (id) => registry.manifests[id]?.version ?? null,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
      disablePlugin: (id) => registry.disablePlugin(id),
      enablePlugin: (id) => registry.enablePlugin(id),
    };
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      rootPath: this.settings.rootPath,
      plugins: host,
      now: () => new Date().toISOString(),
    };
  }

  private async runPublish(): Promise<void> {
    const ctx = this.coreContext();
    try {
      const results = await publish(ctx);
      new ReportModal(this.app, "Config Sync: Publish report", results).open();
    } catch (e) {
      new Notice(`Config Sync publish failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runApply(): Promise<void> {
    const ctx = this.coreContext();
    try {
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      const groups = groupsForDevice(manifest, device);
      if (groups.length === 0) {
        new Notice("Config Sync: no groups available for this device");
        return;
      }
      new GroupSelectModal(this.app, groups, "Config Sync: select groups to apply", (names) => {
        void this.applyGroups(ctx, names);
      }).open();
    } catch (e) {
      new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
    }
  }

  private async applyGroups(ctx: CoreContext, names: string[]): Promise<void> {
    if (names.length === 0) return;
    try {
      const warnings = await checkApply(ctx, names);
      if (warnings.length > 0) {
        const ok = await confirmWarnings(
          this.app,
          "Config Sync: version warnings",
          warnings.map((w) => `${w.group}: ${w.message}`)
        );
        if (!ok) return;
      }
      const results = await apply(ctx, names);
      new ReportModal(this.app, "Config Sync: Apply report", results).open();
    } catch (e) {
      new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runRevert(): Promise<void> {
    const ctx = this.coreContext();
    try {
      const result = await revertLastApply(ctx);
      new ReportModal(this.app, "Config Sync: Revert report", [result]).open();
    } catch (e) {
      new Notice(`Config Sync revert failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runImport(): Promise<void> {
    const sources = this.settings.externalSources;
    if (sources.length === 0) {
      new Notice("Config Sync: no external sources configured (Settings → Config Sync)");
      return;
    }
    new SourceSelectModal(this.app, sources, (source) => {
      void this.importFrom(source);
    }).open();
  }

  private async importFrom(source: ExternalSource): Promise<void> {
    const ctx = this.coreContext();
    try {
      const reader = await this.createReader(source);
      const result = await importExternal(ctx, reader);
      new ReportModal(this.app, `Config Sync: Import report (${source.name})`, [result]).open();
    } catch (e) {
      new Notice(`Config Sync import failed: ${(e as Error).message}`, 10000);
    }
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async createReader(source: ExternalSource): Promise<ExternalStoreReader> {
    if (source.type === "local-path") {
      const { createLocalPathReader } = await import("./external/localPath");
      return createLocalPathReader(source.path, source.root);
    }
    const { createGitReader } = await import("./external/gitSource");
    const adapter = this.app.vault.adapter as unknown as { getBasePath(): string };
    return createGitReader(adapter.getBasePath(), source.remote, source.branch, source.root);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ConfigSyncSettings> | null);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
```

- [ ] **Step 2: Full build + full test suite**

Run: `npm run build`
Expected: exit 0, `main.js` regenerated.

Run: `npm test`
Expected: all tests pass (pathing, sanitize, manifest, io, core, external).

- [ ] **Step 3: Manual smoke test in a dedicated dev vault (never main.vault / kickstart.vault)**

1. Create a throwaway vault: in Obsidian, "Create new vault" named `config-sync-dev` (e.g. under `~/obsidian-dev/`). Enable community plugins.
2. Install the build:
   ```bash
   DEV_VAULT=~/obsidian-dev/config-sync-dev
   mkdir -p "$DEV_VAULT/.obsidian/plugins/obsidian-config-sync"
   cp main.js manifest.json "$DEV_VAULT/.obsidian/plugins/obsidian-config-sync/"
   ```
3. Reload Obsidian, enable "Config Sync" in Community plugins.
4. In the dev vault create `config-sync/manifest.json`:
   ```json
   {
     "version": 1,
     "groups": [
       { "name": "snippets", "path": "{configDir}/snippets", "type": "dir", "devices": "all" },
       { "name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all" }
     ]
   }
   ```
   and add at least one CSS snippet + one custom hotkey so the sources exist.
5. Run `Config Sync: Publish` → report modal lists both groups; check `config-sync/store/configdir/` contents and `config-sync/store.lock.json`.
6. Edit `config-sync/store/configdir/snippets/<file>.css` manually, run `Config Sync: Apply`, select snippets → local snippet changes; report offers "Reload app".
7. Run `Config Sync: Revert last apply` → snippet content restored.
8. Settings → Config Sync → add a `local-path` source pointing at a second copy of the dev vault (or any folder with a valid `<root>/manifest.json`), run `Config Sync: Import from external source` → store overwritten, report shown.

Expected: every step behaves as described; no errors in the developer console.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: plugin shell — commands, ribbon, settings wiring"
```

---

### Task 13: Docs — README, repo CLAUDE.md, release notes

**Files:**
- Create: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything; documents the finished v0.1.0 surface.

- [ ] **Step 1: Write `README.md`**

````markdown
# obsidian-config-sync

Selective, on-demand distribution of Obsidian vault configuration (CSS snippets, hotkeys, plugin settings) across devices and vaults. Transport rides your existing note-sync (e.g. remotely-save); landing is an explicit, per-device **Apply**.

## How it works

- **Publish** (source vault): copies the config groups defined in `<root>/manifest.json` into `<root>/store/`, stripping credential keys (`sanitize` patterns) and recording source plugin versions in `<root>/store.lock.json`. The store is plain vault content — your note-sync carries it everywhere.
- **Apply** (any device): pick groups, get version-mismatch warnings, then land them into this device's config dir (`app.vault.configDir`, whatever its name). Sanitized keys keep their local values, so credentials entered once survive every apply. The previous state of every touched file is kept in a single-slot backup.
- **Revert last apply**: restores that backup.
- **Import from external source** (desktop): overwrite this vault's `<root>/` from another vault — via filesystem path, or via a read-only git remote (`fetch` + `ls-tree` + `show`, worktree untouched).

## Store layout

```
<root>/                      # default "config-sync", configurable
├── manifest.json            # group definitions (yours to edit)
├── store.lock.json          # publish metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/…
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

`manifest.json` example:

```json
{
  "version": 1,
  "groups": [
    { "name": "snippets", "path": "{configDir}/snippets", "type": "dir", "devices": "all" },
    { "name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all" },
    { "name": "vimrc", "path": ".obsidian.vimrc", "type": "file", "devices": "desktop" },
    { "name": "plugin-ioto-settings", "path": "{configDir}/plugins/ioto-settings/data.json",
      "type": "file", "devices": "all",
      "sanitize": ["*ForSync", "*ForFetch", "*APIKey*", "*Token*", "*Secret*", "userEmail"] }
  ]
}
```

Group fields: `name` (unique) · `path` (`{configDir}` variable supported) · `type` (`file`/`dir`) · `devices` (`all`/`desktop`/`mobile`) · `sanitize` (optional key-glob list, file groups only).

Never syncable (hard blacklist): `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync` plugin dirs and `workspace*.json`.

## Install

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add beta plugin `xooooooooox/obsidian-config-sync`.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

Develop against a dedicated test vault (never a real one). Releases: tag `x.y.z`, attach `main.js` + `manifest.json` to the GitHub release.
````

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# CLAUDE.md

Obsidian plugin: selective config distribution across devices/vaults. Spec: `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` (design decisions D1–D7 explain every non-obvious choice — read it before structural changes).

## Commands

- `npm run dev` — esbuild watch → `main.js`
- `npm run build` — `tsc -noEmit` + production bundle (run before finishing any change)
- `npm test` — vitest; `tests/external.test.ts` needs the `git` binary

## Architecture

- `src/core/` — pure functions; ALL file I/O via the `FileIO` interface (`app.vault.adapter` in prod, `tests/memfs.ts` in tests). **Never import Node APIs here — core must run on mobile.**
- `src/external/` — the only place Node `fs`/`child_process` are allowed; loaded exclusively via dynamic `import()` from desktop-gated code in `main.ts`.
- `src/ui/` — thin Obsidian modals/settings; no logic worth testing.
- `src/main.ts` — plugin shell; the only file that touches non-public API (`app.plugins`), typed via the local `CommunityPluginRegistry` interface.

## Template upstream

The repo's git history is rooted at `obsidianmd/obsidian-sample-plugin` (remote `template`); toolchain files are vendored from it. To pull upstream updates: `git fetch template && git merge template/master`. Conflict rules: toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/styles.css/.gitignore) take theirs; identity files (manifest.json, package.json name/author/license, versions.json) and `src/`/`tests/` stay ours; tsconfig takes theirs plus `tests/**/*.ts` re-added to `include`.

## Rules

- Store path mapping and the blacklist live in `core/pathing.ts` / `core/manifest.ts` — change them only with matching spec + test updates.
- Errors must carry context (group name, path, git command). No silent fallback.
- Test in a dedicated dev vault, never in a real vault.
```

- [ ] **Step 3: Verify and commit**

Run: `npm run build && npm test`
Expected: both exit 0.

```bash
git add README.md CLAUDE.md
git commit -m "docs: README and repo CLAUDE.md"
```

---

## Out of scope for this plan (tracked in the spec's acceptance checklist §7)

Real-environment acceptance (items 0–8: remotely-save dot-path probe, main.vault publish + credential grep, multi-device apply, iPhone mobile test, kickstart import via both channels, deletion propagation, merge-preservation, revert) and the first GitHub release + BRAT install verification happen on the user's real vaults/devices after this plan lands — they need hardware and credentials no agent has.
