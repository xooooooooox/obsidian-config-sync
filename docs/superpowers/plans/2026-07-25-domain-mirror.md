# Domain Mirror + Key-Level Class Partition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror Obsidian's settings sidebar in the Obsidian tab (General / Editor / Files and links / Appearance / Hotkeys), powered by a new key-level device-class partition engine (store sidecars) — spec `docs/superpowers/specs/2026-07-25-domain-mirror-design.md`.

**Architecture:** Engine first: `FieldRule.action` gains `desktop | mobile | all`; capture partitions class-scoped top-level keys into sibling sidecar files `<storePath>.__scopes__.<class>.json`; apply/diff reassemble base ⊕ own-class sidecar. On top: app.json category rules composed from a hardcoded key→tab map + `appJsonTabs` settings, and pure-UI recomposition of the Obsidian tab (three app view rows, one Appearance container row). Underlying SyncGroups are unchanged — no settings migration.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild.

## Global Constraints

- **NO GIT COMMITS.** This work joins the existing uncommitted batch on `main` (base = tag 1.9.0, `013ab1f`). Task steps end with gates + ledger updates, never `git commit`. Subagents: no Claude attribution anywhere.
- Gates after every task: `npm test` (all pass), `npm run lint` (**0 errors, ≤ 64 warnings** — current baseline 64), `npm run build` (clean).
- Repo: `~/local/coding/open/obsidian-config-sync`. Ledger: `.superpowers/sdd/progress.md`.
- Binding copy strings (character-exact, from spec §7 / mockup domain-merge-v3-final-A):
  - General row desc: `Obsidian's General options (app.json). New or unrecognized keys land here.`
  - Editor row desc: `Editing behavior — live preview, spellcheck, line settings (app.json).`
  - Files and links row desc: `Attachments, link format, excluded files (app.json).`
  - Appearance row desc: `Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.`
  - Appearance section hints: `appearance.json — theme choice, fonts, interface` / `themes/ — installed theme files` / `snippets/ — the .css files` / Device scope: `which snippets are on — appearance.json → enabledCssSnippets`
  - cssTheme hint: `The active theme (cssTheme) travels with this file.`
  - Locked row pointer: `locked — managed under CSS snippets → Device scope`
  - Class-rule hint: `each class keeps its own value`
  - Field rules drawer hint: `per-key device scope — one choice per key`
  - JSON legend: `teal=encrypted`, `red=this device`, `blue=desktop only`, `amber=mobile only`
  - Dropdown labels: `All devices` / `Desktop only` / `Mobile only` / `This device` / `Encrypted`; shared-mode tag: `shared`
  - Face badges: `settings ✓` / `themes ✓` / `snippets ✓`
- Class rules (`desktop`/`mobile`) apply to **top-level keys only** (spec §2.1); `strip`/`encrypt` keep their existing any-depth glob semantics unchanged.
- Existing behavior must not change for configs without class rules or `appJsonTabs` (zero-behavior-change default path).

---

### Task 1: Engine — class actions, partition, sidecar IO

**Files:**
- Modify: `src/core/types.ts:5-8` (FieldRule action union)
- Modify: `src/core/modes.ts` (classPatterns, captureTransform/applyTransform/contentUnchanged)
- Modify: `src/core/pathing.ts` (sidecar suffix + resolveGroupByStoreRel)
- Modify: `src/core/ConfigSyncCore.ts` (CoreContext.deviceClass; captureGroup/applyGroup sidecar IO)
- Modify: `src/core/status.ts:64-88` (compareFile passes sidecar)
- Modify: `src/main.ts` (`coreContext()` ~:958 adds deviceClass; `diffPair` :479/:495 new args)
- Test: `tests/classPartition.test.ts` (new); update existing tests that call the three modes functions (mechanical extra args: `"desktop", null`)

**Interfaces:**
- Produces:
  - `FieldRule.action: "strip" | "encrypt" | "desktop" | "mobile" | "all"` (`"all"` is an inert explicit override — every engine filter ignores it)
  - `classPatterns(group: SyncGroup, cls: "desktop" | "mobile"): string[]`
  - `captureTransform(group, content, passphrase, deviceClass: "desktop" | "mobile"): Promise<{ content: string; note: string | null; ownScope: string | null }>` — `ownScope` is the serialized own-class sidecar (`null` = group has no own-class patterns → caller deletes the sidecar)
  - `applyTransform(group, storeContent, localContent, passphrase, deviceClass, ownScopeContent: string | null): Promise<string>`
  - `contentUnchanged(group, localContent, storeContent, passphrase, deviceClass, ownScopeContent: string | null): Promise<boolean>`
  - `sidecarStoreSuffix(cls: "desktop" | "mobile"): string` in pathing.ts → `` `.__scopes__.${cls}.json` ``
  - `CoreContext.deviceClass: "desktop" | "mobile"`

- [ ] **Step 1: Write failing tests** (`tests/classPartition.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { SyncGroup } from "../src/core/types";

const group: SyncGroup = {
  name: "app", path: "{configDir}/app.json", type: "file", devices: "all",
  mode: "fields",
  fields: [
    { pattern: "userIgnoreFilters", action: "desktop" },
    { pattern: "mobileToolbarCommands", action: "mobile" },
    { pattern: "vimMode", action: "strip" },
    { pattern: "promptDelete", action: "all" },
  ],
};
const local = JSON.stringify({
  attachmentFolderPath: "99", userIgnoreFilters: ["a/"], mobileToolbarCommands: [], vimMode: true, promptDelete: true,
});

describe("class partition", () => {
  it("capture on desktop: own keys → ownScope, other-class and strip keys dropped, all/inert kept", async () => {
    const t = await captureTransform(group, local, null, "desktop");
    const base = JSON.parse(t.content) as Record<string, unknown>;
    expect(Object.keys(base).sort()).toEqual(["attachmentFolderPath", "promptDelete"]);
    expect(JSON.parse(t.ownScope as string)).toEqual({ userIgnoreFilters: ["a/"] });
  });
  it("capture on mobile mirrors the split", async () => {
    const t = await captureTransform(group, local, null, "mobile");
    expect(JSON.parse(t.ownScope as string)).toEqual({ mobileToolbarCommands: [] });
    expect(JSON.parse(t.content)).not.toHaveProperty("userIgnoreFilters");
  });
  it("ownScope is null when the group has no own-class patterns", async () => {
    const g: SyncGroup = { ...group, fields: [{ pattern: "vimMode", action: "strip" }] };
    const t = await captureTransform(g, local, null, "desktop");
    expect(t.ownScope).toBeNull();
  });
  it("apply reassembles base + own sidecar and preserves other-class/strip keys from local", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store", promptDelete: false });
    const sidecar = JSON.stringify({ userIgnoreFilters: ["fromStore/"] });
    const out = JSON.parse(await applyTransform(group, store, local, null, "desktop", sidecar)) as Record<string, unknown>;
    expect(out["attachmentFolderPath"]).toBe("store");     // base wins
    expect(out["userIgnoreFilters"]).toEqual(["fromStore/"]); // sidecar wins for own class
    expect(out["mobileToolbarCommands"]).toEqual([]);      // other class: local preserved
    expect(out["vimMode"]).toBe(true);                     // strip: local preserved
  });
  it("apply without sidecar preserves own-class keys locally (degradation)", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store" });
    const out = JSON.parse(await applyTransform(group, store, local, null, "desktop", null)) as Record<string, unknown>;
    expect(out["userIgnoreFilters"]).toEqual(["a/"]);
  });
  it("apply drops a stale other-class key still present in an old-format store base", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "store", mobileToolbarCommands: ["stale"] });
    const localNoMobile = JSON.stringify({ attachmentFolderPath: "x" });
    const out = JSON.parse(await applyTransform(group, store, localNoMobile, null, "desktop", null)) as Record<string, unknown>;
    expect(out).not.toHaveProperty("mobileToolbarCommands");
  });
  it("sidecar deletion propagates: own-class key missing from sidecar disappears on apply", async () => {
    const out = JSON.parse(await applyTransform(group, "{}", local, null, "desktop", "{}")) as Record<string, unknown>;
    expect(out).not.toHaveProperty("userIgnoreFilters");
  });
  it("contentUnchanged compares own-class keys through the sidecar", async () => {
    const store = JSON.stringify({ attachmentFolderPath: "99", promptDelete: true });
    expect(await contentUnchanged(group, local, store, null, "desktop", JSON.stringify({ userIgnoreFilters: ["a/"] }))).toBe(true);
    expect(await contentUnchanged(group, local, store, null, "desktop", JSON.stringify({ userIgnoreFilters: ["b/"] }))).toBe(false);
    expect(await contentUnchanged(group, local, store, null, "desktop", null)).toBe(true); // no sidecar → own class ignored
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/classPartition.test.ts` → FAIL (signature mismatch / missing exports).

- [ ] **Step 3: types.ts** — extend the union:

```ts
export interface FieldRule {
  pattern: string;
  action: "strip" | "encrypt" | "desktop" | "mobile" | "all";
  locked?: boolean;
}
```
(Keep any existing `locked` field exactly as-is; only the union changes. `"all"` is inert everywhere in the engine.)

- [ ] **Step 4: modes.ts** — implement. Add after `encryptPatterns`:

```ts
export function classPatterns(group: SyncGroup, cls: "desktop" | "mobile"): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.action === cls).map((f) => f.pattern);
}

function otherClass(cls: "desktop" | "mobile"): "desktop" | "mobile" {
  return cls === "desktop" ? "mobile" : "desktop";
}

// Class rules are TOP-LEVEL ONLY (spec §2.1): partition and preservation act on root object
// keys; nested keys with matching names are untouched.
function dropTopLevel(v: unknown, patterns: string[]): unknown {
  if (patterns.length === 0 || !isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!keyMatchesAny(k, patterns)) out[k] = val;
  return out;
}
```

`captureTransform` fields branch — partition BEFORE strip/encrypt (plain/encrypted modes return `ownScope: null`):

```ts
const own = classPatterns(group, deviceClass);
const other = classPatterns(group, otherClass(deviceClass));
let scopeObj: Record<string, unknown> | null = own.length > 0 ? {} : null;
let parsedBase = parsed;
if ((own.length > 0 || other.length > 0) && isPlainObject(parsed)) {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (own.length > 0 && keyMatchesAny(k, own)) { (scopeObj as Record<string, unknown>)[k] = v; continue; }
    if (other.length > 0 && keyMatchesAny(k, other)) continue;
    rest[k] = v;
  }
  parsedBase = rest;
}
// …existing strip/encrypt pipeline runs on parsedBase…
// note: when scopeObj has keys, append `${deviceClass}-only ${names.join(", ")}` to the note parts.
return { content: …, note, ownScope: scopeObj === null ? null : JSON.stringify(scopeObj, null, 2) + "\n" };
```

`applyTransform` fields branch — after `decryptFields`:

```ts
let incoming = await decryptFields(JSON.parse(storeContent) as unknown, pw, group.name);
if (ownScopeContent !== null && isPlainObject(incoming)) {
  incoming = { ...incoming, ...(JSON.parse(ownScopeContent) as Record<string, unknown>) };
}
const own = classPatterns(group, deviceClass);
const other = classPatterns(group, otherClass(deviceClass));
const classPreserve = [...other, ...(ownScopeContent === null ? own : [])];
if (localContent === null) {
  return JSON.stringify(dropTopLevel(incoming, classPreserve), null, 2) + "\n";
}
const local = JSON.parse(localContent) as unknown;
const merged = strip.length > 0 ? mergePreservingSanitized(local, incoming, strip) : incoming;
// class-preserve pass (shallow): local value wins; stale store copies must not introduce keys
let out = merged;
if (classPreserve.length > 0 && isPlainObject(merged)) {
  const o: Record<string, unknown> = { ...merged };
  for (const k of Object.keys(o)) {
    if (keyMatchesAny(k, classPreserve) && !(isPlainObject(local) && k in local)) delete o[k];
  }
  if (isPlainObject(local)) {
    for (const [k, v] of Object.entries(local)) if (keyMatchesAny(k, classPreserve)) o[k] = v;
  }
  out = o;
}
return JSON.stringify(out, null, 2) + "\n";
```
Note: when `strip.length === 0 && localContent !== null`, `merged` = `incoming` (the old early-return for `strip.length === 0` must be removed — the class pass still runs).

`contentUnchanged` fields branch — symmetric shallow ignore + sidecar overlay:

```ts
const own = classPatterns(group, deviceClass);
const other = classPatterns(group, otherClass(deviceClass));
const classIgnore = [...other, ...(ownScopeContent === null ? own : [])];
let storeParsed = JSON.parse(storeContent) as unknown;
if (ownScopeContent !== null && isPlainObject(storeParsed)) {
  storeParsed = { ...storeParsed, ...(JSON.parse(ownScopeContent) as Record<string, unknown>) };
}
let localParsed = JSON.parse(localContent) as unknown;
localParsed = dropTopLevel(strip.length > 0 ? sanitizeJson(localParsed, strip) : localParsed, classIgnore);
storeParsed = dropTopLevel(strip.length > 0 ? sanitizeJson(storeParsed, strip) : storeParsed, classIgnore);
return fieldsUnchanged(localParsed, storeParsed, pw, group.name);
```

- [ ] **Step 5: pathing.ts** — add + extend:

```ts
export function sidecarStoreSuffix(cls: "desktop" | "mobile"): string {
  return `.__scopes__.${cls}.json`;
}
```
In `resolveGroupByStoreRel`, replace the file match line with:
```ts
if (g.type === "file" && (inner === sp || inner.startsWith(sp + ".__scopes__."))) return g;
```

- [ ] **Step 6: ConfigSyncCore.ts** — `CoreContext` gains `deviceClass: "desktop" | "mobile";` (after `passphrase`). `captureGroup` file branch (:253-274): read the own sidecar first, pass new args, write/delete sidecar after the base write:

```ts
const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
const t = await captureTransform(group, captureInput, ctx.passphrase, ctx.deviceClass);
if (t.note !== null) result.messages.push(t.note);
await writeClassified(ctx, store, t.content, basename(store), result, (existing) => {
  /* existing switch-list branch unchanged */
  return contentUnchanged(group, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, existingSidecar);
});
if (!SWITCH_LIST_GROUPS.has(group.name)) {
  if (t.ownScope !== null) {
    await writeClassified(ctx, sidecarPath, t.ownScope, basename(sidecarPath), result);
  } else if (await ctx.io.exists(sidecarPath)) {
    await ctx.io.remove(sidecarPath);
    result.filesDeleted.push(sidecarPath);
    result.changes.deleted.push(basename(sidecarPath));
  }
}
```
where `const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;` is read before the transform. `applyGroup` file branch (:667-684): read sidecar the same way and call `applyTransform(group, storeContent, localContent, ctx.passphrase, ctx.deviceClass, existingSidecar)`. The dir-branch `captureTransform`/`applyTransform` calls (encrypted mode, :282/:693) pass `ctx.deviceClass` and discard/pass `null` sidecar.

- [ ] **Step 7: status.ts `compareFile`** — before the `contentUnchanged` call (:84), read the sidecar and pass it; both `contentUnchanged` calls in the file get the two new args (dir compare at :118 passes `null`):

```ts
const sidecar = store + sidecarStoreSuffix(ctx.deviceClass);
const ownScope = (await ctx.io.exists(sidecar)) ? await ctx.io.read(sidecar) : null;
```

- [ ] **Step 8: main.ts** — `coreContext()` adds `deviceClass: Platform.isMobile ? "mobile" : "desktop",`; `diffPair` (:479, :495) passes the class and (apply side) the sidecar content read from `` `${storeBase}${sidecarStoreSuffix(cls)}` ``; capture side also surfaces `produced` base only (sidecar not shown in the pair — acceptable, diff view is per-file).

- [ ] **Step 9: Update existing test callsites** — every `captureTransform(g, c, p)` → `captureTransform(g, c, p, "desktop")`, `applyTransform(g, s, l, p)` → `(g, s, l, p, "desktop", null)`, `contentUnchanged(g, l, s, p)` → `(g, l, s, p, "desktop", null)`; test `CoreContext` fixtures gain `deviceClass: "desktop"`.

- [ ] **Step 10: Gates** — `npm test` (new + old green), `npm run lint` (0 err, ≤64 warn), `npm run build`. Update ledger.

---

### Task 2: Engine — APP_JSON_TAB_MAP + appJsonTabs composition

**Files:**
- Modify: `src/core/catalog.ts` (AppJsonTab, APP_JSON_TAB_MAP, appTabFor)
- Create: `src/core/appTabs.ts`
- Modify: `src/core/ConfigSyncCore.ts` (CoreContext.fieldOverlay hook + overlayGroup helper, used in captureGroup/applyGroup)
- Modify: `src/core/status.ts` (compareFile uses overlayGroup)
- Modify: `src/main.ts` (settings field, DEFAULT, fieldOverlay in coreContext, diffPair overlay)
- Test: `tests/appTabs.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's extended FieldRule + deviceClass plumbing.
- Produces:
  - `type AppJsonTab = "general" | "editor" | "files-and-links"` and `appTabFor(key: string): AppJsonTab` (catalog.ts; unmapped → `"general"`)
  - `interface AppTabSetting { enabled?: boolean; devices?: "desktop" | "mobile" }`, `type AppJsonTabs = Partial<Record<AppJsonTab, AppTabSetting>>`
  - `appTabRules(topKeys: string[], tabs: AppJsonTabs, explicit: FieldRule[]): FieldRule[]`
  - `appTabsNonDefault(tabs: AppJsonTabs): boolean`
  - `CoreContext.fieldOverlay?: (group: SyncGroup, topKeys: string[]) => FieldRule[] | null`
  - `overlayGroup(ctx: CoreContext, group: SyncGroup, jsons: (string | null)[]): SyncGroup` (exported from ConfigSyncCore)
  - Settings: `appJsonTabs: AppJsonTabs` (DEFAULT `{}`, no migration)

- [ ] **Step 1: Failing tests** (`tests/appTabs.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { appTabRules, appTabsNonDefault } from "../src/core/appTabs";
import { appTabFor } from "../src/core/catalog";

describe("app tab composition", () => {
  it("maps anchors and falls back to general", () => {
    expect(appTabFor("userIgnoreFilters")).toBe("files-and-links");
    expect(appTabFor("vimMode")).toBe("editor");
    expect(appTabFor("someFutureKey")).toBe("general");
    expect(appTabFor("pdfExportSettings")).toBe("general");
  });
  it("category devices → class rules; enabled:false → strip; default → nothing", () => {
    const rules = appTabRules(
      ["attachmentFolderPath", "vimMode", "pdfExportSettings"],
      { "files-and-links": { devices: "desktop" }, editor: { enabled: false } },
      [],
    );
    expect(rules).toEqual([
      { pattern: "attachmentFolderPath", action: "desktop" },
      { pattern: "vimMode", action: "strip" },
    ]);
  });
  it("explicit rules win — matching keys are skipped (including inert all-overrides)", () => {
    const rules = appTabRules(
      ["attachmentFolderPath", "newFileLocation"],
      { "files-and-links": { devices: "desktop" } },
      [{ pattern: "attachmentFolderPath", action: "all" }],
    );
    expect(rules).toEqual([{ pattern: "newFileLocation", action: "desktop" }]);
  });
  it("appTabsNonDefault", () => {
    expect(appTabsNonDefault({})).toBe(false);
    expect(appTabsNonDefault({ editor: {} })).toBe(false);
    expect(appTabsNonDefault({ editor: { enabled: false } })).toBe(true);
    expect(appTabsNonDefault({ general: { devices: "mobile" } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: catalog.ts** — add near OPTION_LABELS:

```ts
export type AppJsonTab = "general" | "editor" | "files-and-links";

// key → Obsidian settings tab, verified against the Obsidian UI (Obsidian 1.x, 2026-07).
// UNMAPPED KEYS ALWAYS FALL BACK TO "general" — syncing never loses a key. Known approximation:
// showInlineTitle lives under Obsidian's Appearance tab but is stored in app.json → general.
export const APP_JSON_TAB_MAP: Record<string, AppJsonTab> = {
  attachmentFolderPath: "files-and-links",
  alwaysUpdateLinks: "files-and-links",
  newFileLocation: "files-and-links",
  newLinkFormat: "files-and-links",
  useMarkdownLinks: "files-and-links",
  showUnsupportedFiles: "files-and-links",
  userIgnoreFilters: "files-and-links",
  trashOption: "files-and-links",
  promptDelete: "files-and-links",
  vimMode: "editor",
  propertiesInDocument: "editor",
  readableLineLength: "editor",
  spellcheck: "editor",
  strictLineBreaks: "editor",
  showLineNumber: "editor",
  livePreview: "editor",
  defaultViewMode: "editor",
  foldHeading: "editor",
  foldIndent: "editor",
  showIndentGuide: "editor",
  tabSize: "editor",
  useTab: "editor",
  autoPairBrackets: "editor",
  autoPairMarkdown: "editor",
  smartIndentList: "editor",
  rightToLeft: "editor",
};

export function appTabFor(key: string): AppJsonTab {
  return APP_JSON_TAB_MAP[key] ?? "general";
}
```

- [ ] **Step 4: appTabs.ts** (new):

```ts
import { FieldRule } from "./types";
import { keyMatchesAny } from "./sanitize";
import { appTabFor, AppJsonTab } from "./catalog";

export interface AppTabSetting {
  enabled?: boolean; // absent = true
  devices?: "desktop" | "mobile"; // absent = all
}
export type AppJsonTabs = Partial<Record<AppJsonTab, AppTabSetting>>;

export function appTabsNonDefault(tabs: AppJsonTabs): boolean {
  return Object.values(tabs).some((t) => t !== undefined && (t.enabled === false || t.devices !== undefined));
}

// Effective per-key rules for app.json view rows: explicit FieldRules win; then the key's
// category default (enabled:false → strip, devices → class); default = no rule (spec §4.2).
export function appTabRules(topKeys: string[], tabs: AppJsonTabs, explicit: FieldRule[]): FieldRule[] {
  const explicitPatterns = explicit.map((r) => r.pattern);
  const out: FieldRule[] = [];
  for (const key of topKeys) {
    if (keyMatchesAny(key, explicitPatterns)) continue;
    const t = tabs[appTabFor(key)];
    if (t === undefined) continue;
    if (t.enabled === false) {
      out.push({ pattern: key, action: "strip" });
    } else if (t.devices !== undefined) {
      out.push({ pattern: key, action: t.devices });
    }
  }
  return out;
}
```

- [ ] **Step 5: ConfigSyncCore.ts** — `CoreContext` gains `fieldOverlay?: (group: SyncGroup, topKeys: string[]) => FieldRule[] | null;`. Add + export:

```ts
// Composes runtime category rules (app.json view rows) into a group's effective field set.
// jsons: any texts whose top-level keys should participate (local content, store base, sidecar).
export function overlayGroup(ctx: CoreContext, group: SyncGroup, jsons: (string | null)[]): SyncGroup {
  if (ctx.fieldOverlay === undefined) return group;
  const keys = new Set<string>();
  for (const j of jsons) {
    if (j === null) continue;
    try {
      const p = JSON.parse(j) as unknown;
      if (isPlainObject(p)) for (const k of Object.keys(p)) keys.add(k);
    } catch { /* non-JSON content participates with no keys */ }
  }
  const extra = ctx.fieldOverlay(group, [...keys]);
  if (extra === null || extra.length === 0) return group;
  return { ...group, mode: "fields", fields: [...(group.fields ?? []), ...extra] };
}
```
In `captureGroup` (file branch), build `const effGroup = overlayGroup(ctx, group, [plainLocalContent]);` and use `effGroup` for `captureTransform`/`contentUnchanged`. In `applyGroup`, `const effGroup = overlayGroup(ctx, group, [storeContent, localContent, existingSidecar]);` for `applyTransform`. In `status.ts compareFile`, same overlay with `[liveContent, storeContent, ownScope]`.

- [ ] **Step 6: main.ts** — settings interface + DEFAULT:

```ts
appJsonTabs: AppJsonTabs; // app.json view rows: category enabled/devices (spec §4.2); {} = all-default
```
`DEFAULT_SETTINGS: … appJsonTabs: {},`. In `coreContext()`:

```ts
fieldOverlay: (group, topKeys) =>
  group.name === "app" && appTabsNonDefault(this.settings.appJsonTabs)
    ? appTabRules(topKeys, this.settings.appJsonTabs, group.fields ?? [])
    : null,
```
`diffPair` (:474-496): wrap `group` with the same overlay before `captureTransform`/`applyTransform` (compose a local `overlayed` group via `appTabRules` on the parsed top keys — reuse `overlayGroup` by importing it and passing the ad-hoc ctx? No: extract the tiny composition inline using the same expressions; keep it identical to `coreContext().fieldOverlay`).

- [ ] **Step 7: Gates + ledger.**

---

### Task 3: UI — Field rules drawer v2 + JSON viewer recolor

**Files:**
- Modify: `src/ui/SettingTab.ts:1081-1160` (renderFieldsEditor: buttons → 4-choice dropdown), `:632-638` (drawer desc), `:875-890` (legend)
- Modify: `src/ui/jsonView.ts` (KeyState + class states)
- Modify: `styles.css` (state colors: blue/amber for classes; detected → purple; none → faint)
- Test: `tests/jsonView.test.ts` (extend or create)

**Interfaces:**
- Consumes: FieldRule 5-value union (Task 1).
- Produces: `KeyState = "encrypt" | "strip" | "desktop" | "mobile" | "detected" | "none"`; `classifyJsonKeys` returns class states for class rules.

- [ ] **Step 1: Failing test** — extend jsonView tests:

```ts
it("classifies class-scoped keys", () => {
  const out = classifyJsonKeys(
    JSON.stringify({ a: 1, b: 2, c: 3 }),
    [{ pattern: "a", action: "desktop" }, { pattern: "b", action: "mobile" }],
    [],
  );
  expect(out).toEqual([
    { key: "a", state: "desktop" }, { key: "b", state: "mobile" }, { key: "c", state: "none" },
  ]);
});
```

- [ ] **Step 2: jsonView.ts** — extend `KeyState`; in `classifyJsonKeys` add desktop/mobile pattern buckets checked after encrypt/strip (`"all"` rules are ignored — state "none").

- [ ] **Step 3: renderFieldsEditor** — replace the two-button `actions` block (:1097-1125) with one `DropdownComponent` per rule row:

```ts
const dd = new DropdownComponent(fr.createDiv({ cls: "config-sync-act" }));
dd.addOption("strip", "This device")
  .addOption("encrypt", "Encrypted")
  .addOption("desktop", "Desktop only")
  .addOption("mobile", "Mobile only")
  .setValue(rule.action === "all" ? "strip" : rule.action)
  .onChange((v) => { /* commitGroups: r.action = v as FieldRule["action"], then afterChange() — same body as the old button click */ });
if (rule.locked === true) {
  dd.setDisabled(true);
  dd.selectEl.setAttribute("title", "Preset rule — action is fixed");
}
if (rule.action === "desktop" || rule.action === "mobile") {
  fr.createSpan({ cls: "config-sync-ldhint", text: "each class keeps its own value" });
}
```
(X-remove button and locked xspacer stay exactly as they are. `"all"` rules only occur on the app group via Task 4's key list; if one appears here, it renders as a plain rule row whose dropdown shows "This device" until changed — acceptable, the app drawer is the owner of that state.)
Drawer desc (:636) becomes: `This device — never enters the store. Encrypted — syncs encrypted. Desktop/Mobile only — each class keeps its own value (store sidecar).`

- [ ] **Step 4: legend + colors** — legend block (:881-889) now reads, in order: `click a key to add a rule · ` `teal=encrypted` ` · ` `red=this device` ` · ` `blue=desktop only` ` · ` `amber=mobile only`. styles.css: `.config-sync-json-desktop { color: var(--color-blue); }`, `.config-sync-json-mobile { color: var(--color-orange); }`; re-point `.config-sync-json-detected` to `var(--color-purple)` and the none/clickable state to `var(--text-faint)` (update the :825 comment accordingly). The json render switch maps the two new states to the new classes.

- [ ] **Step 5: Gates + ledger.**

---

### Task 4: UI — app.json view rows (General / Editor / Files and links)

**Files:**
- Modify: `src/core/catalog.ts:168-221` (listOptionSections: three view items replace the app.json row), CatalogItem type (add `kind`)
- Modify: `src/ui/SettingTab.ts` (renderItemInto branch → renderAppViewRow + key-list drawer; mode pin)
- Modify: `src/main.ts` (host accessors if needed: expose settings + saveSettings already exist via `this.host`)
- Test: `tests/catalog.test.ts` (extend), `tests/appTabs.test.ts` (view-item presence)

**Interfaces:**
- Consumes: Task 2 (`AppJsonTab`, `appTabFor`, `AppJsonTabs`, `appTabsNonDefault`), Task 3 (dropdown idiom).
- Produces: `CatalogItem.kind?: "app-view" | "appearance-domain"` and `CatalogItem.appTab?: AppJsonTab`; catalog emits, in this order: General, Editor, Files and links, (Appearance container — Task 5), Hotkeys.

- [ ] **Step 1: Failing catalog test** — listOptionSections with app.json present yields items named `app-view-general` / `app-view-editor` / `app-view-files-links` (labels `General` / `Editor` / `Files and links`, all `path: "{configDir}/app.json"`, `kind: "app-view"`), and NO item named `app`; with app.json absent, the three land in the notPresent section.

- [ ] **Step 2: catalog.ts** — in `listOptionSections`, special-case `app.json` out of the OPTION_LABELS loop and emit:

```ts
const APP_VIEWS: { name: string; tab: AppJsonTab; label: string; description: string }[] = [
  { name: "app-view-general", tab: "general", label: "General", description: "Obsidian's General options (app.json). New or unrecognized keys land here." },
  { name: "app-view-editor", tab: "editor", label: "Editor", description: "Editing behavior — live preview, spellcheck, line settings (app.json)." },
  { name: "app-view-files-links", tab: "files-and-links", label: "Files and links", description: "Attachments, link format, excluded files (app.json)." },
];
```
Each becomes a CatalogItem `{ name, label, description, path: "{configDir}/app.json", type: "file", exists: files.has("app.json"), kind: "app-view", appTab: tab, disabledReason: null, cautionReason: null }`, pushed to available/notPresent by existence. `OPTION_LABELS["app.json"]` stays (Sync Center label + reserved names + expectedPathForName unchanged — the group is still named `app`).

- [ ] **Step 3: SettingTab renderItemInto** — top of the method: `if (item.kind === "app-view") { this.renderAppViewRow(wrap, item); return; }`. Implement:

```ts
private renderAppViewRow(wrap: HTMLElement, item: CatalogItem): void {
  wrap.empty();
  const tab = item.appTab as AppJsonTab;
  const group = findGroupByName(this.groups, "app");
  const tabs = this.host.settings.appJsonTabs;
  const setting = tabs[tab] ?? {};
  const enabled = group !== undefined && setting.enabled !== false;
  const row = new Setting(wrap).setName(item.label);
  row.settingEl.setAttribute("data-search-anchor", `item-${item.name}`);
  // chevron + drawer (key list) — same expand mechanics as renderItemInto, keyed on item.name
  // badges: explicit per-key rules of this category only (spec §9.5-5)
  const explicit = (group?.fields ?? []).filter((r) => appTabFor(r.pattern) === tab);
  const nScoped = explicit.filter((r) => r.action === "desktop" || r.action === "mobile").length;
  const nLocal = explicit.filter((r) => r.action === "strip").length;
  // …create the two badges exactly like :556-565 (same classes/titles), hidden at 0…
  row.setDesc(item.description ?? "");
  if (enabled) {
    row.addDropdown((d) =>
      d.addOption("all", "All devices").addOption("desktop", "Desktop only").addOption("mobile", "Mobile only")
        .setValue(setting.devices ?? "all")
        .onChange((v) => void this.setAppTab(tab, { ...setting, devices: v === "all" ? undefined : (v as "desktop" | "mobile") })),
    );
    this.renderAppSharedMode(row.controlEl, group as SyncGroup, () => this.renderAppViewRow(wrap, item));
  }
  row.addToggle((t) =>
    t.setValue(enabled).setDisabled(!item.exists && group === undefined).onChange((v) => void this.toggleAppTab(tab, v)),
  );
}
```
Helpers:
```ts
private async setAppTab(tab: AppJsonTab, s: AppTabSetting): Promise<void> {
  const next = { ...this.host.settings.appJsonTabs };
  if (s.enabled === undefined && s.devices === undefined) delete next[tab]; else next[tab] = s;
  this.host.settings.appJsonTabs = next;
  await this.host.saveSettings();
  this.refresh();
}
private async toggleAppTab(tab: AppJsonTab, on: boolean): Promise<void> {
  const cur = this.host.settings.appJsonTabs[tab] ?? {};
  await this.setAppTab(tab, { ...cur, enabled: on ? undefined : false });
  const anyOn = (["general", "editor", "files-and-links"] as AppJsonTab[]).some(
    (t) => (this.host.settings.appJsonTabs[t]?.enabled ?? true) !== false,
  );
  const has = findGroupByName(this.groups, "app") !== undefined;
  if (on && !has) await this.commitGroups((d) => { d.push(groupForItem("app", "{configDir}/app.json", "file", OPTION_LABELS["app.json"]!.description)); });
  if (!anyOn && has) await this.commitGroups((d) => { const i = d.findIndex((g) => g.name === "app"); if (i >= 0) d.splice(i, 1); });
  this.refresh();
}
```
`renderAppSharedMode`: render the normal mode dropdown for the app group (same options/commit as `renderModeSegment`), then `controlEl.createSpan({ cls: "config-sync-shared-tag", text: "shared" })`; when `appTabsNonDefault(this.host.settings.appJsonTabs)` the dropdown is pinned to Fields (disabled, title `Category rules require fields mode — shared across General / Editor / Files and links`). Add `.config-sync-shared-tag { font-size: var(--font-ui-smaller); color: var(--text-faint); }` to styles.css.

- [ ] **Step 4: key-list drawer** — the app-view expansion (chevron) renders heading `Field rules` + desc `per-key device scope — one choice per key`, then reads `` await this.app.vault.adapter.read(`${this.app.vault.configDir}/app.json`) ``, filters top-level keys by `appTabFor(k) === tab` (sorted), and per key renders a five-option dropdown:

```ts
const explicitRule = (group.fields ?? []).find((r) => r.pattern === key);
const tabDefault = setting.enabled === false ? "strip" : setting.devices ?? "all";
const value = explicitRule !== undefined ? explicitRule.action : tabDefault;
dd.addOption("all", "All devices").addOption("desktop", "Desktop only").addOption("mobile", "Mobile only")
  .addOption("strip", "This device").addOption("encrypt", "Encrypted")
  .setValue(value)
  .onChange((v) => void this.setAppKeyRule(key, v as FieldRule["action"], tabDefault));
```
`setAppKeyRule(key, action, tabDefault)`: via `commitGroups` on the app group — remove any existing rule with `pattern === key`; if `action !== tabDefault` push `{ pattern: key, action }` (this writes the inert `"all"` override when the tab default is non-all); if the group is plain and a rule now exists, set `mode: "fields"`. Class-valued rows also render the hint span `each class keeps its own value`. Below the list, the existing JSON preview/legend for the app group is reused as-is.

- [ ] **Step 5: Gates + ledger.** Manual dev-vault smoke deferred to final review checklist.

---

### Task 5: UI — Appearance container row

**Files:**
- Modify: `src/core/catalog.ts` (suppress 4 standalone items; emit container item)
- Modify: `src/ui/SettingTab.ts` (renderAppearanceDomainRow + 3-section drawer)
- Modify: `styles.css` (section head styles `.config-sync-domain-sect`, face badges)
- Test: `tests/catalog.test.ts` (container item; suppression; notPresent when no carriers)

**Interfaces:**
- Consumes: existing `renderLocalDecisions` (Device scope editor, unchanged), `renderFieldsEditor`, `renderModeSegment`, `commitGroups`, `seededGroupFor`; `ensureAppearancePresets` (unchanged).
- Produces: catalog item `{ name: "appearance-domain", kind: "appearance-domain", label: "Appearance", description: "Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.", path: "{configDir}/appearance.json", type: "file", exists: <any carrier present> }`; items `appearance`, `themes`, `snippets`, `enabled-css-snippets` no longer emitted as rows.

- [ ] **Step 1: Failing catalog test** — with appearance.json + snippets/ present: exactly one `appearance-domain` item, none of the four standalone names; order in available: app views → appearance-domain → hotkeys. With no carriers: appearance-domain in notPresent.

- [ ] **Step 2: catalog.ts** — in `listOptionSections`, skip `appearance.json`, `themes`, `snippets` in the OPTION_LABELS loop and drop the `enabled-css-snippets` synthesis block (:204-215); emit the container item after the app views with `exists = files.has("appearance.json") || dirs.has("themes") || dirs.has("snippets")`. Keep OPTION_LABELS entries themselves (Sync Center labels, reserved names, `defaultGroupForName` all still resolve).

- [ ] **Step 3: SettingTab** — branch: `if (item.kind === "appearance-domain") { this.renderAppearanceDomain(wrap, item); return; }`. Header row: chevron (expand key `"appearance-domain"`), name, aggregate member badges (counts from `memberScopes["enabled-css-snippets"]` / `memberLocal["enabled-css-snippets"]`, same classes/hide-at-0 as :556-565), then face badges for each active group:

```ts
for (const [name, label] of [["appearance", "settings ✓"], ["themes", "themes ✓"], ["snippets", "snippets ✓"]] as const) {
  if (findGroupByName(this.groups, name) !== undefined) row.nameEl.createSpan({ cls: "config-sync-devbadge config-sync-facebadge", text: label });
}
```
No row-level controls. Drawer = three sections; each section head: title (`Settings file` / `Themes` / `CSS snippets`), hint (binding strings), spacer, controls for that group:
- **Settings file** (`appearance`, seeds via `seededGroupFor` on toggle-on using item `{ name: "appearance", path: "{configDir}/appearance.json", type: "file" }`): devices dropdown (same as :569-585 but targeting `appearance`), `renderModeSegment` (appearancePinned logic already lives there), toggle add/remove. Body when mode fields: `renderFieldsEditor` (locked `enabledCssSnippets` row appears via ensureAppearancePresets; extend the locked row rendering in renderFieldsEditor: when `rule.locked === true && rule.pattern === "enabledCssSnippets"`, the fixed-action label cell instead shows text `locked — managed under CSS snippets → Device scope`) + a hint line `The active theme (cssTheme) travels with this file.`
- **Themes** (`themes`, dir): devices dropdown + toggle.
- **CSS snippets** (`snippets`, dir): devices dropdown + `renderModeSegment` + toggle; body contains sub-section head `Device scope` with hint `which snippets are on — appearance.json → enabledCssSnippets` and its own toggle bound to the existence of the `enabled-css-snippets` group (`toggleSection`-style add/remove of `{ name: "enabled-css-snippets", path: "{configDir}/enabled-css-snippets.json", type: "file" }` with the existing description `Which CSS snippets are on, per device.`); when on, call `this.renderLocalDecisions(body, group, wrap, item)` with the enabled-css-snippets group — unchanged editor + orphans.
Face toggles are independent — toggling one never touches the others' groups (definition B, spec §5).

- [ ] **Step 4: styles.css** — `.config-sync-domain-sect { margin: 6px 0 4px 12px; padding-left: 12px; border-left: 2px solid var(--background-modifier-border); }`, `.config-sync-domain-secthead { display: flex; align-items: center; gap: 8px; }`, `.config-sync-facebadge { background: var(--background-modifier-hover); color: var(--text-muted); }` (match existing badge sizing).

- [ ] **Step 5: Gates + ledger.** Update `tests/settingtab-commit.test.ts`-style tests only if they reference the removed standalone rows.

---

### Task 6: Docs + ledger wrap-up

**Files:**
- Modify: `README.md` + `README.zh.md` (1:1 line parity), `docs/ARCHITECTURE.md`, `docs/DESIGN.md`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: README/zh** — Obsidian tab now mirrors Obsidian's sidebar (five rows); Field rules five choices with `userIgnoreFilters` Desktop-only example (correct old `userIgnoredFilters` spelling if present); sidecar layout one-liner; JSON legend colors. Keep EN/zh line counts equal.
- [ ] **Step 2: ARCHITECTURE.md** — FieldRule union, classPatterns/dropTopLevel semantics (top-level only), sidecar path scheme + capture/apply reassembly, `appTabs.ts`, `fieldOverlay`/`overlayGroup`, catalog view items (`kind`), settings shape `appJsonTabs`.
- [ ] **Step 3: DESIGN.md** — domain/companion model entry + 定稿 pointer (mockup domain-merge-v3-final-A, artifact 2026-07-25, 候选 A); release-notes clause: store adds `__scopes__` sidecars — **update all devices together** (merged with the phase-1 memberScopes window).
- [ ] **Step 4: Gates** (docs don't run code — still run all three to confirm nothing drifted) **+ ledger final entry.**

---

## Verification (final review checklist)

- Unit: all Task 1/2/3 tests green; full suite green; lint ≤64/0; build clean.
- dev-vault smoke (controller, after final review): five rows + order; `userIgnoreFilters` → Desktop only → capture creates `store/configdir/app.json.__scopes__.desktop.json` and removes the key from the base; apply round-trips; Editor row toggle off → its keys stripped from store; Appearance container: three sections render, independent toggles, locked row shows the pointer text and disappears when Device scope is off; JSON legend four colors; mode chip pinned+`shared` on all three app rows once a category rule exists.
