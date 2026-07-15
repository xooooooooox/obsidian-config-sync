# Self-Config Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Tasks 6–7 are UI with settled mockups; their CSS/rendered verification is controller-inline.

**Goal:** One config file (`data.json` holds the sync contract), self-propagation via the captured `plugin-config-sync` item guarded by locked strip rules, pull as a 2-way merge with a git-diff conflict modal, and store-based bootstrap for fresh devices.

**Architecture:** `ConfigSyncSettings` gains `groups`; the core reads/writes groups through new `CoreContext.groupsIO` callbacks instead of the `config-sync.json` file. `FieldRule` gains a generic `locked` flag; the self-item ships locked strip presets for `rootPath`/`remotes`. `importExternal` is split into a pure merge classifier (`src/core/merge.ts`) + an all-or-nothing writer; conflicts route through a new `ConflictModal`. Push/pull stop treating a root `config-sync.json` as mandatory (legacy remotes still readable).

**Tech Stack:** TypeScript (Obsidian plugin), vitest.

## Global Constraints

- Strip = key removal (`sanitizeJson` omits matching keys entirely); apply preserves local values via `mergePreservingSanitized`. Do not change these semantics.
- Strip-only fields groups need no passphrase (`requirePassphrase` gates on `groupNeedsPassphrase`).
- Pull is **all-or-nothing**: nothing is written before the user confirms (or the merge is conflict-free); Cancel writes nothing, not even auto-merged parts.
- Locked rules (`locked: true`) are non-removable in the UI; the flag is generic.
- Zero hardcoded color in styles.css; theme-native modal; `check-no-hardcoded-color.sh` stays green.
- Visual 定稿 is binding: conflict modal per `conflict-modal-v4.html` + `gallery-self-config.html` (git diff, Unified⇄Split, segmented Local|Remote, amber unresolved + disabled Apply, collapsible auto-merged section with `＋/＝/⌂`, pinned header/footer); locked-rule row = 🔒 prefix + single "don't sync" badge + disabled delete; adopt banner per gallery.
- Gates per task: `npm run build`, `npm run lint` (0 errors; warnings ≤ baseline 65), `npm test` green, color scan. No Claude/AI attribution in commits.
- Baselines at branch start: 207 tests, 65 lint warnings.

---

### Task 1: `groups` in settings; core reads groups via `CoreContext.groupsIO`

**Files:**
- Modify: `src/main.ts` (settings interface/default, coreContext), `src/core/ConfigSyncCore.ts` (CoreContext, readGroups/writeGroups/loadManifest; remove manifestPath/createStarterManifest/STARTER_MANIFEST/SCHEMA_URL), `src/core/manifest.ts` (keep parseSyncManifest for legacy/remote parsing — do NOT delete), `tests/*` (ctx helper gains groupsIO)
- Test: extend `tests/core.test.ts` / the shared ctx factory used by tests

**Interfaces:**
- Produces: `CoreContext.groupsIO: { read(): Promise<SyncGroup[]>; write(groups: SyncGroup[]): Promise<void> }`; `ConfigSyncSettings.groups: SyncGroup[]`.
- Unchanged for callers: exported `readGroups(ctx)`, `writeGroups(ctx, groups)`, `loadManifest(ctx)` keep signatures.

- [ ] **Step 1: Write the failing test.** In the tests' ctx factory (find it: `grep -rn "function makeCtx\|now: () =>" tests/ | head`), add an in-memory groups store, then add to `tests/core.test.ts`:

```ts
it("readGroups/writeGroups round-trip through ctx.groupsIO (no manifest file involved)", async () => {
  const ctx = makeCtx(); // in-memory groupsIO, starts empty
  expect(await readGroups(ctx)).toEqual([]);
  const g: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
  await writeGroups(ctx, [g]);
  expect(await readGroups(ctx)).toEqual([g]);
  expect(await ctx.io.exists(`${ctx.rootPath}/config-sync.json`)).toBe(false); // no file written
});
```

- [ ] **Step 2: Run to confirm it fails** (`npm test -- core 2>&1 | tail -15`): groupsIO not defined.

- [ ] **Step 3: Extend `CoreContext`** (ConfigSyncCore.ts:24-31):

```ts
export interface GroupsIO {
  read(): Promise<SyncGroup[]>;
  write(groups: SyncGroup[]): Promise<void>;
}

export interface CoreContext {
  io: FileIO;
  configDir: string;
  rootPath: string;
  plugins: PluginHost;
  passphrase: string | null;
  groupsIO: GroupsIO;
  now(): string;
}
```

- [ ] **Step 4: Rewire the groups IO** (ConfigSyncCore.ts:658-669 + loadManifest):

```ts
export async function readGroups(ctx: CoreContext): Promise<SyncGroup[]> {
  return ctx.groupsIO.read();
}

export async function writeGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<void> {
  const manifest = validateSyncManifest({ version: 1, groups }); // same validation as before
  await ctx.groupsIO.write(manifest.groups);
}
```

`loadManifest(ctx)` (find with `grep -n "loadManifest" src/core/ConfigSyncCore.ts`) returns `{ version: 1, groups: await ctx.groupsIO.read() }`. Delete `manifestPath`, `createStarterManifest`, `STARTER_MANIFEST`, `SCHEMA_URL`. Keep `parseSyncManifest` exported from manifest.ts (legacy + remote compat needs it in Tasks 2/5).

- [ ] **Step 5: Settings side** (`src/main.ts`): add `groups: SyncGroup[]` to `ConfigSyncSettings` (line ~35) and `groups: []` to `DEFAULT_SETTINGS`. In `loadSettings`, validate loaded groups defensively: wrap in `try { this.settings.groups = validateSyncManifest({ version: 1, groups: this.settings.groups }).groups } catch (e) { console.error("Config Sync: invalid groups in settings", e); new Notice(...); }` (keep the rest of settings usable). In `coreContext()` (line ~403), add:

```ts
      groupsIO: {
        read: async () => this.settings.groups,
        write: async (groups) => {
          this.settings.groups = groups;
          await this.saveSettings();
        },
      },
```

Remove the starter-manifest creation + Notice (main.ts ~243).

- [ ] **Step 6: Fix the test ctx factory** — add an in-memory `groupsIO` (array captured in closure) to every ctx built in tests; run the full suite; fix compile fallout mechanically (call sites do not change signatures).

- [ ] **Step 7: Gates + commit** — `git commit -m "feat: sync contract lives in plugin settings, core reads groups via ctx.groupsIO"`.

---

### Task 2: Legacy migration (`config-sync.json` → settings)

**Files:**
- Modify: `src/main.ts` (migration in `onload`, after `loadSettings`, before first status refresh)
- Test: `tests/manifest.test.ts` or new `tests/migration.test.ts` — migration is a pure-ish function, extract it

**Interfaces:**
- Produces: `migrateLegacyManifest(io: FileIO, rootPath: string, existing: SyncGroup[], now: string): Promise<{ groups: SyncGroup[]; migrated: boolean } >` in `src/core/manifest.ts` (pure core, testable).

- [ ] **Step 1: Failing tests** (new `tests/migration.test.ts`): legacy file exists → groups merged (by name, existing wins), file renamed to `config-sync.json.migrated-<now-date>`, `migrated: true`; no file → `{ groups: existing, migrated: false }`; malformed file → throws `ManifestValidationError` (caller Notices and leaves the file).
- [ ] **Step 2: Implement** in manifest.ts:

```ts
export async function migrateLegacyManifest(
  io: FileIO,
  rootPath: string,
  existing: SyncGroup[],
  now: string
): Promise<{ groups: SyncGroup[]; migrated: boolean }> {
  const p = `${rootPath}/config-sync.json`;
  if (!(await io.exists(p))) return { groups: existing, migrated: false };
  const legacy = parseSyncManifest(await io.read(p)).groups; // throws ManifestValidationError on bad JSON
  const have = new Set(existing.map((g) => g.name));
  const merged = [...existing, ...legacy.filter((g) => !have.has(g.name))];
  await io.rename(p, `${p}.migrated-${now.slice(0, 10)}`);
  return { groups: merged, migrated: true };
}
```

(If `FileIO` has no `rename`, check `src/core/io.ts` — add a `rename(old, new)` member implemented over the adapter, mirrored in the tests' MemFS.)

- [ ] **Step 3: Wire in `main.ts` onload** after `loadSettings()`/`setCorePluginIds(...)`: resolve rootPath (`await this.resolvedRootPath()` — it exists, main.ts ~460), call the migration with `this.settings.groups`; on `migrated`, save settings + `new Notice("Config Sync: imported groups from config-sync.json (file renamed, now lives in plugin settings)")`; on `ManifestValidationError`, `new Notice(...)` with the error and continue.
- [ ] **Step 4: Gates + commit** — `git commit -m "feat: migrate legacy config-sync.json groups into plugin settings"`.

---

### Task 3: `locked` field rules + self-item presets + self-apply hot-reload

**Files:**
- Modify: `src/core/types.ts` (FieldRule), `src/core/catalog.ts` (`groupForItem` presets), `src/core/manifest.ts` (migration adds presets; parseGroup accepts `locked`), `src/main.ts` (hot-reload after self-apply), `src/ui/SettingTab.ts` (🔒 row, disabled delete — small; mockup settled)
- Test: `tests/catalog.test.ts`, `tests/migration.test.ts`

**Interfaces:**
- `FieldRule` gains `locked?: boolean`.
- Produces: `SELF_GROUP_NAME = "plugin-config-sync"` and `selfPresetRules(): FieldRule[]` exported from catalog.ts:

```ts
export const SELF_GROUP_NAME = "plugin-config-sync";
export function selfPresetRules(): FieldRule[] {
  return [
    { pattern: "rootPath", action: "strip", locked: true },
    { pattern: "remotes", action: "strip", locked: true },
  ];
}
```

- [ ] **Step 1: Failing tests.** catalog: `groupForItem("plugin-config-sync", …)` returns `mode: "fields"` + the two locked strip rules; any other name unchanged. migration: a migrated legacy `plugin-config-sync` group without presets gains them (merged, user rules kept); one that has them (unlocked duplicates) is normalized to locked.
- [ ] **Step 2: Implement.** types.ts `locked?: boolean`; parseGroup accepts/roundtrips it (check `parseGroup`'s fields validation in manifest.ts and extend). `groupForItem` special-case on `SELF_GROUP_NAME` appends `mode: "fields"`, `fields: selfPresetRules()` (merging with caller-passed rules if the signature carries any). Add `ensureSelfPresets(groups: SyncGroup[]): SyncGroup[]` in catalog.ts (idempotent: finds the self group, guarantees the two locked rules exist exactly once) and call it inside `migrateLegacyManifest`'s result and in main.ts after migration.
- [ ] **Step 3: Hot-reload.** In the `applyItems` host (main.ts, find `apply(` call in the actions host ~line 267-297): after a successful apply whose names include `SELF_GROUP_NAME`, run `await this.loadSettings(); await this.refreshLocalStatus();` before returning (settings file changed under the running plugin).
- [ ] **Step 4: UI (inline-verifiable but mechanical).** In SettingTab's fields-rule row render (find `fields` rule list render — `grep -n "strip\|rule" src/ui/SettingTab.ts` around the Fields segment): when `rule.locked === true`, prefix a `🔒` span (`title: "Preset rule — cannot be removed"`), and disable the delete control (reuse the standard disabled treatment). Rule add/edit logic must never drop locked rules: in the save path, re-run `ensureSelfPresets`.
- [ ] **Step 5: Gates + commit** — `git commit -m "feat: locked field rules with rootPath/remotes presets on the self item"`.

---

### Task 4: Pure merge classifier (`src/core/merge.ts`)

**Files:**
- Create: `src/core/merge.ts`
- Test: `tests/merge.test.ts`

**Interfaces (produced, consumed by Tasks 5–6):**

```ts
import { SyncGroup } from "./types";

export type MergeConflict =
  | { kind: "definition"; name: string; local: SyncGroup; remote: SyncGroup }
  | { kind: "file"; name: string; rel: string; localContent: string; remoteContent: string };

export interface MergeAuto {
  addGroups: SyncGroup[];                    // remote-only groups → add locally
  writeFiles: { rel: string; content: string; name: string }[]; // remote-only or identical-skip? (only remote-only + remote-newer-nonconflicting = remote-only)
  keptLocalGroups: string[];                 // local-only group names (kept, informational)
  keptLocalFiles: string[];                  // local-only rels (kept, informational)
  identical: string[];                       // rels/groups identical both sides (informational)
}

export interface MergePlan { auto: MergeAuto; conflicts: MergeConflict[]; }

export function classifyMerge(
  localGroups: SyncGroup[],
  localFiles: Map<string, string>,   // rel → content, rel relative to rootPath (e.g. "store/hotkeys/hotkeys.json", "store.lock.json")
  remoteGroups: SyncGroup[],
  remoteFiles: Map<string, string>
): MergePlan
```

Classification rules (spec Part 4): groups — remote-only→addGroups; local-only→keptLocalGroups; both & deep-equal→identical; both & differ→definition conflict. Files (excluding `store.lock.json`, handled by Task 5) — remote-only→writeFiles; local-only→keptLocalFiles; both & identical→identical; both & differ→file conflict (name resolved via the same `groupForStoreRel` logic — import it or reimplement the `store/<group>/` prefix match).

- [ ] **Step 1: Failing tests** covering every cell: remote-only group+files, local-only group+files (kept), identical both, definition conflict (deep compare ignores key order — compare via canonical JSON), file conflict, mixed scenario asserting the full plan shape.
- [ ] **Step 2: Implement** (pure; deep-equal = `JSON.stringify` of a key-sorted normalization — write a small `canonical(g)` helper; no external deps).
- [ ] **Step 3: Gates + commit** — `git commit -m "feat: pure 2-way merge classifier for pull"`.

---

### Task 5: Pull/push rewrite — plan-then-write, legacy compat, lock merge

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (importExternal split; pushExternal root-file removal), `src/main.ts` (pull flow calls classifier; conflict-free path auto-applies)
- Test: `tests/external.test.ts` (rewrite import tests for merge semantics; push tests drop the manifest-required assertion)

**Interfaces:**
- Produces (ConfigSyncCore.ts):

```ts
export interface PendingPull { plan: MergePlan; remoteGroups: SyncGroup[]; }
// Phase 1 — read-only: never writes.
export async function planImport(ctx: CoreContext, reader: ExternalStoreReader): Promise<PendingPull>
// Phase 2 — writes the whole result per choices; choices maps conflict index → "local" | "remote".
export async function applyImport(ctx: CoreContext, pending: PendingPull, choices: ("local" | "remote")[]): Promise<GroupResult[]>
```

- [ ] **Step 1: Failing tests** (rewrite `tests/external.test.ts` import section): local-only group + its store file survive a pull (the old delete-mirror assertions are REPLACED — they encoded the bug); remote-only lands; conflict-free pull writes everything via `applyImport(ctx, pending, [])`; conflicted pull with `choices=["remote"]` writes remote side, `["local"]` keeps local file untouched; `planImport` alone writes nothing.
- [ ] **Step 2: `planImport`.** Read remote files (reader.listFiles/readFile all). Remote groups source: `store/configdir/plugins/config-sync/data.json` parsed as `{ groups?: SyncGroup[] }` → validate via `validateSyncManifest({version:1, groups})`; else legacy root `config-sync.json` via `parseSyncManifest` (compat); else `[]` (store-only remote). Local files via `listFilesRecursive(ctx.io, ctx.rootPath)` → rel map. Exclude `store.lock.json` and any legacy root `config-sync.json` from the file classification (lock handled in Step 3; legacy manifest file is never written locally). Call `classifyMerge`.
- [ ] **Step 3: `applyImport`.** Throws if `choices.length !== plan.conflicts.length`. Writes: auto `writeFiles` + conflict files chosen "remote" (via the existing `writeClassified` so GroupResults accumulate); groups: `readGroups` → apply `addGroups` + definition conflicts chosen "remote" (replace by name) → `ensureSelfPresets` → `writeGroups`. Lock merge: parse local + remote `store.lock.json`; for every group whose files/definition came from remote, take the remote lock entry; keep local entries otherwise; write the merged lock. Never delete local-only files. `pruneEmptyDirsUnder` at the end. Return GroupResults (reuse `emptyResult`/`resultFor` pattern).
- [ ] **Step 4: Delete old `importExternal`** and update its callers (main.ts pull action → `planImport`; if `plan.conflicts.length === 0` → `applyImport(ctx, pending, [])` immediately; else → hand `pending` to the ConflictModal (Task 6; until Task 6 lands, temporary behavior: abort with Notice "Pull has N conflicts — resolution UI arrives in the next task" so this task stays shippable).
- [ ] **Step 5: `pushExternal`:** drop the `rels.includes("config-sync.json")` requirement (replace with: non-empty `store/` tree or lock file, else the existing "capture before pushing" error); exclude any lingering legacy `config-sync.json.migrated-*` from push; never write a root config-sync.json. Also include the self store item as usual (it's just a store file).
- [ ] **Step 6: Gates + commit** — `git commit -m "feat: pull is a plan-then-write 2-way merge; push drops the root manifest file"`.

---

### Task 6: Conflict modal (v4 定稿) — **UI; CSS + rendered check controller-inline**

**Files:**
- Create: `src/ui/ConflictModal.ts`
- Modify: `src/main.ts` (pull flow opens modal), `styles.css`
- Test: none (DOM glue; behavior covered by Task 5 tests + controller smoke)

**Interfaces:**
- Produces: `class ConflictModal extends Modal` with `constructor(app, pending: PendingPull, displayName: (name: string) => string, onResolve: (choices: ("local"|"remote")[]) => void, onCancel: () => void)`.

- [ ] **Step 1: Build the modal per 定稿** (`conflict-modal-v4.html`): pinned header (title + "Pulling from <remote> · N items compared"); collapsible auto-merged section (collapsed default, `＋n · ＝n · ⌂n` summary; expanded rows with reason lines); conflict rows: label + kind badge + (file rows) store rel + segmented Local|Remote buttons; unresolved = amber border class + "⚠ choose a side"; expandable diff area with Unified⇄Split toggle (session-remembered in a module let; `body.is-phone` hides the toggle and forces unified); diff rendering: definition = canonical-JSON line diff of the two definitions; file = line diff of contents; a minimal LCS-free line diff is acceptable (lines only in local → `-` red, only in remote → `+` green, common → dim context; hunk headers optional `@@`) — no external diff dependency. Footer: "k of n resolved · nothing is written until you apply", Cancel pull, Apply merge (disabled until k===n).
- [ ] **Step 2: Wire main.ts pull flow** (replacing Task 5's temporary Notice): conflicts → `new ConflictModal(...).open()`; onResolve → `applyImport` → surface GroupResults exactly like the old pull did (inline result strip path); onCancel → Notice "Pull cancelled — nothing was changed".
- [ ] **Step 3: CSS** — theme-native: modal reuses Obsidian modal vars; badges/tints via `rgba(var(--color-…-rgb), o)` (orange definition, blue file? — blue uses `--color-blue`; diff red/green `--color-red`/`--color-green`; chosen segment `--interactive-accent`; amber unresolved `--color-orange`); zero hardcoded color.
- [ ] **Step 4: Controller two-theme verification** (default + AnuPpuccin): drive a doctored pull in the dev vault (guard first), screenshot modal with expanded unified + split diffs, unresolved + resolved rows; compare to 定稿.
- [ ] **Step 5: Gates + commit** — `git commit -m "feat: git-style conflict modal for pull merges"`.

---

### Task 7: Bootstrap adopt banner — **UI; controller-inline verification**

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (banner), `src/main.ts` (detection + adopt action via host), `styles.css`

- [ ] **Step 1: Detection host fn** (main.ts): `bootstrapOffer(): Promise<{ itemCount: number; sourceDevice: string | null; capturedAt: string | null } | null>` — non-null when `settings.groups.length === 0` && no legacy manifest file && `${root}/store/configdir/plugins/config-sync/data.json` exists; counts groups inside that store copy; source/time from `store.lock.json` if present. Session-dismiss flag on the plugin instance.
- [ ] **Step 2: Banner in SyncCenterView** per 定稿: accent-tinted top banner, title + summary line, Adopt button, ✕ dismiss. Adopt → host action: apply `plugin-config-sync` only → hot-reload settings (Task 3 already covers) → refresh view (banner disappears since groups now exist).
- [ ] **Step 3: CSS** (theme-native accent tint), two-theme screenshot, gates.
- [ ] **Step 4: Commit** — `git commit -m "feat: adopt-existing-configuration banner for fresh devices"`.

---

### Task 8: Copy pass + full smoke

**Files:**
- Modify: `src/ui/SettingTab.ts` (Fields segment desc → "Fields marked \"don't sync\" are removed from the store copy at capture and keep their local value on apply."), any residual "config-sync.json" user-facing copy (grep `config-sync.json` in src/ui + Notices; reword to "plugin settings" where it refers to the manifest)
- Test: none new

- [ ] **Step 1: Copy edits + gates + commit** — `git commit -m "feat: copy pass for the settings-resident contract"`.
- [ ] **Step 2: Controller full smoke (dev vault, guard before every batch):** (1) migration: seed a legacy config-sync.json → reload → groups in data.json, file renamed, Notice; (2) self-capture → store copy lacks rootPath/remotes keys; (3) simulated device B: doctor data.json (different rootPath/remotes) → apply self item → both preserved, portable fields + groups adopted, hot-reload took effect; (4) conflicted pull → modal → both resolution paths + cancel-writes-nothing; (5) fresh-vault bootstrap → banner → Adopt; (6) locked rules render 🔒 + disabled delete; two-theme screenshots for modal + banner + locked rows. Record all in the ledger.

---

## Self-Review Notes

- Spec coverage: Part 1 → Tasks 1–2; Part 2 → Task 3; Part 3 → Task 3 (UI) + Task 8 (copy); Part 4 → Tasks 4–6; Part 5 → Task 7; testing section → per-task tests + Task 8 smoke.
- Type consistency: `GroupsIO` consumed by Task 1 rewiring; `MergePlan/MergeConflict/PendingPull/planImport/applyImport` names match across Tasks 4/5/6; `SELF_GROUP_NAME`/`selfPresetRules`/`ensureSelfPresets` match across Tasks 3/5.
- Sequencing: each task leaves the plugin shippable (Task 5's temporary conflict Notice bridges to Task 6).
- Post-plan flow: user pre-merge acceptance before merge; cut (0.22.0) includes hand-written release notes per the standing rule.
