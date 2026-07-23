# General-Tab Polish + Dead-Snippet Cleanup + Plugin Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passphrase moves above the Ribbon buttons heading; the "Sync" ribbon toggle is labeled "Sync Center"; dead enabled-snippet names (no `.css` file locally NOR in the store) become removable via the extended Clean up block; plugin icon assets (CS-A).

**Architecture:** `snippetOrphans` (pure, `core/availability.ts`) gains store-file awareness; `main.ts` feeds it the store snippets dir listing, excludes dead names from the main switch rows, returns provenance-aware orphan rows, and extends `removeSnippetOrphans` to clear scopes/pins and then propagate to the store via a sanctioned single-group `capture`. `SettingTab.ts` reorders two General renders and renders the provenance chips.

**Tech Stack:** TypeScript, esbuild, vitest, eslint (baseline: 67 problems / 0 errors — do not add any).

**Spec:** `docs/superpowers/specs/2026-07-23-general-polish-and-snippet-cleanup-design.md`

## Global Constraints

- NO COMMITS: leave all changes uncommitted (vault-owner convention; the controller commits only at cut, on explicit request).
- Dead-name definition: in the local enabled list OR the store enabled list, AND no `.css` file in the local `snippets/` dir AND none in the store snippets dir. The store-file check is the fresh-device safeguard — never weaken it.
- Store propagation goes through `capture(ctx, ["enabled-css-snippets"])` ONLY — never hand-edit the store file (stale index). Scopes/pins must be cleared and settings saved BEFORE the capture (scope-away pass-through would otherwise carry the dead name's store value back).
- Gates: `npm run build`, `npm test` (512 tests today), `npm run lint` (baseline 67/0).

---

### Task 1: General tab reorder + label

**Files:**
- Modify: `src/ui/SettingTab.ts`

**Interfaces:** self-contained.

- [ ] **Step 1: Move Passphrase above Ribbon buttons**

In `renderActiveTab`'s `"general"` case, reorder:

```ts
this.renderStatusToggles(containerEl);
this.renderPassphrase(containerEl);
this.renderRibbonToggles(containerEl);
```

(Today `renderPassphrase` comes after `renderRibbonToggles`.)

- [ ] **Step 2: Reorder the search-index entry**

In `GENERAL_SETTINGS`, move the `{ name: "Passphrase", … }` entry so it sits BEFORE the `{ name: "Ribbon buttons", … }` entry (keeps search results in visual order). No text changes.

- [ ] **Step 3: Rename the ribbon toggle**

In `renderRibbonToggles`: `{ key: "sync", label: "Sync" }` → `{ key: "sync", label: "Sync Center" }`.

- [ ] **Step 4: Full gates**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, 512 tests pass, lint 67 problems / 0 errors.

---

### Task 2: Dead-name detection + cleanup plumbing

**Files:**
- Modify: `src/core/availability.ts`
- Modify: `src/main.ts`
- Modify: `tests/availability.test.ts`

**Interfaces:**
- Produces: `snippetOrphans(localOn: string[], storeOn: string[], localFiles: string[], storeFiles: string[]): string[]`; host methods `snippetOrphanNames(): Promise<{ name: string; storeOn: boolean }[]>` and the extended `removeSnippetOrphans(names: string[]): Promise<void>` — Task 3 consumes both host methods.

- [ ] **Step 1: Rewrite the `snippetOrphans` tests (new signature)**

In `tests/availability.test.ts`, replace the `describe("snippetOrphans", …)` block:

```ts
describe("snippetOrphans", () => {
  it("flags names enabled locally with no file anywhere", () => {
    expect(snippetOrphans(["callouts", "mystyle"], [], ["mystyle"], [])).toEqual(["callouts"]);
  });

  it("flags names enabled only in the store with no file anywhere", () => {
    expect(snippetOrphans([], ["dead"], [], [])).toEqual(["dead"]);
  });

  it("keeps names whose file exists locally", () => {
    expect(snippetOrphans(["mystyle"], ["mystyle"], ["mystyle"], [])).toEqual([]);
  });

  it("keeps names whose file exists in the store (fresh device before snippets sync)", () => {
    expect(snippetOrphans([], ["pending"], [], ["pending"])).toEqual([]);
  });

  it("dedupes and sorts", () => {
    expect(snippetOrphans(["b", "a"], ["b", "c"], [], [])).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/availability.test.ts`
Expected: FAIL (old three-arg signature).

- [ ] **Step 3: New `snippetOrphans` implementation**

In `src/core/availability.ts`, replace the function and its comment:

```ts
// Enabled snippet names (local list or store list) whose .css file exists neither locally nor
// in the store's snippets dir — dead leftovers from deleted/renamed snippets. Checking the
// store FILES keeps a fresh device safe: before its snippets/ dir syncs down, the store still
// holds the files, so nothing there is offered for cleanup.
export function snippetOrphans(localOn: string[], storeOn: string[], localFiles: string[], storeFiles: string[]): string[] {
  const files = new Set([...localFiles, ...storeFiles]);
  return [...new Set([...localOn, ...storeOn].filter((n) => !files.has(n)))].sort();
}
```

- [ ] **Step 4: `main.ts` — store files in the universe, dead names out of the main rows**

`snippetUniverse()` additionally lists the store snippets dir and returns it:

```ts
const storeSnips = `${root}/store/${groupStorePath("{configDir}/snippets")}`;
const storeFileList = (await io.exists(storeSnips)) ? (await io.list(storeSnips)).files : [];
const storeFiles = storeFileList.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
return { fromDir, store, local, storeFiles };
```

(update the return-type annotation to `{ fromDir: string[]; store: string[]; local: string[]; storeFiles: string[] }`).

In `switchListRows("enabled-css-snippets")`, exclude dead names from the row universe (they render in the Clean up block instead):

```ts
const { fromDir, store, local, storeFiles } = await this.snippetUniverse();
const dead = new Set(snippetOrphans(local, store, fromDir, storeFiles));
const scopedAway = scopedAwaySnippets(this.settings.snippetScopes, Platform.isMobile);
const pins = new Set(this.settings.switchExceptions["enabled-css-snippets"] ?? []);
// universe = files ∪ store, minus dead names (no file locally OR in the store) — those are
// surfaced in the Clean up block via snippetOrphanNames()/removeSnippetOrphans().
const ids = [...new Set([...fromDir, ...store])].filter((id) => !dead.has(id)).sort();
```

- [ ] **Step 5: `main.ts` — provenance-aware orphan rows**

```ts
async snippetOrphanNames(): Promise<{ name: string; storeOn: boolean }[]> {
  const { fromDir, store, local, storeFiles } = await this.snippetUniverse();
  return snippetOrphans(local, store, fromDir, storeFiles).map((name) => ({ name, storeOn: store.includes(name) }));
}
```

- [ ] **Step 6: `main.ts` — extended removal**

Extend `removeSnippetOrphans` (existing in-memory + `appearance.json` cleanup stays first, unchanged), then append:

```ts
// Device-local bookkeeping: a dead name's scope and pin are meaningless. MUST be cleared and
// saved BEFORE the capture below — a still-scoped-away name would pass through the old store
// value and resurrect itself in the fresh store copy.
let touched = false;
for (const n of names) {
  if (n in this.settings.snippetScopes) {
    const next = { ...this.settings.snippetScopes };
    delete next[n];
    this.settings.snippetScopes = next;
    touched = true;
  }
}
const pins = this.settings.switchExceptions["enabled-css-snippets"];
if (pins !== undefined && pins.some((p) => drop.has(p))) {
  this.settings.switchExceptions["enabled-css-snippets"] = pins.filter((p) => !drop.has(p));
  touched = true;
}
if (touched) await this.saveSettings();
// Propagate to the store through the sanctioned path: a single-group capture rewrites the
// store copy plus lock/index bookkeeping (hand-editing the store file leaves the index stale).
const ctx = await this.coreContext();
await capture(ctx, ["enabled-css-snippets"]);
```

`capture` is exported from `./core/ConfigSyncCore` — add it to the existing import list if absent.

- [ ] **Step 7: Full gates**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, 513 tests (512 − 4 old orphan tests + 5 new), lint 67/0. (Adjust the count claim to the actual old-test delta if the old block had a different size — the requirement is: all pass, none skipped.)

---

### Task 3: Clean up block UI

**Files:**
- Modify: `src/ui/SettingTab.ts`

**Interfaces:**
- Consumes: `snippetOrphanNames(): Promise<{ name: string; storeOn: boolean }[]>`, `removeSnippetOrphans(names)` from Task 2.

- [ ] **Step 1: Host interface + state types**

In the host interface: `snippetOrphanNames(): Promise<{ name: string; storeOn: boolean }[]>;` (was `Promise<string[]>`).
In `renderLocalDecisions`: `let orphans: { name: string; storeOn: boolean }[] = [];`.

- [ ] **Step 2: Block copy + rows**

- Block description text becomes: `Enabled somewhere but the .css file no longer exists here or in the store. Removing also clears them from the shared store list, scopes and pins.`
- Per-row rendering:

```ts
for (const o of orphans) {
  const orow = body.createDiv({ cls: "config-sync-orphan-row" });
  orow.createSpan({ cls: "config-sync-orphan-name", text: o.name });
  orow.createSpan({ cls: "config-sync-orphan-tag", text: o.storeOn ? "no file · store has on" : "no file" });
  orow.createDiv({ cls: "config-sync-rule-spacer" });
  const rm = orow.createSpan({ cls: "config-sync-orphan-remove", text: "Remove", attr: { role: "button", tabindex: "0" } });
  rm.addEventListener("click", () => void (async () => {
    await this.host.removeSnippetOrphans([o.name]);
    await reload();
  })());
}
```

- "Remove all" handler: `await this.host.removeSnippetOrphans(orphans.map((o) => o.name));`

- [ ] **Step 3: Full gates**

Run: `npm run build && npm test && npm run lint`
Expected: all clean, lint 67/0.

---

### Task 4: Assets + docs

**Files:**
- Create: `assets/icon.svg`, `assets/logo.svg`, `assets/social-preview.svg`
- Modify: `README.md`, `README.zh.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md`

- [ ] **Step 1: Write the three SVGs exactly**

`assets/icon.svg` (CS-A mark — 24×24, currentColor, iconize-importable):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>
```

`assets/logo.svg` (README tile, 256×256, mark centered at scale 6 → offset 56):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b7fd4"/><stop offset="1" stop-color="#7d5bd4"/></linearGradient></defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <g transform="translate(56 56) scale(6)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/><circle cx="12" cy="12" r="2.4" fill="#ffffff" stroke="none"/>
  </g>
</svg>
```

`assets/social-preview.svg` (1280×640; tagline from the approved mockup):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" font-family="-apple-system, 'Segoe UI', sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#20242f"/><stop offset="1" stop-color="#15171d"/></linearGradient>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b7fd4"/><stop offset="1" stop-color="#7d5bd4"/></linearGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <rect x="240" y="212" width="216" height="216" rx="48" fill="url(#tile)"/>
  <g transform="translate(276 248) scale(6)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/><circle cx="12" cy="12" r="2.4" fill="#ffffff" stroke="none"/>
  </g>
  <text x="516" y="316" fill="#eef0f5" font-size="64" font-weight="700">Config Sync</text>
  <text x="518" y="372" fill="#9aa5c4" font-size="30">Your Obsidian settings, on every device</text>
</svg>
```

- [ ] **Step 2: README logos + docs**

- Both READMEs: insert `<p align="center"><img src="assets/logo.svg" width="96" alt="Config Sync logo"></p>` as the very first line, above the H1 (badges etc. untouched; zh alt text may stay English).
- Both READMEs' snippets/switch-list section: one added sentence — dead names (no `.css` here or in the store) surface in the Clean up block; removing clears the local list, the shared store list, scopes and pins.
- `docs/ARCHITECTURE.md`: update the `snippetOrphans` description (new inputs incl. store files; removal path = local cleanup → scopes/pins → single-group capture) and note `assets/`.
- `docs/DESIGN.md`: update the orphan-cleanup rationale (store-file check = fresh-device safeguard; capture-based store propagation).

- [ ] **Step 3: Full gates**

Run: `npm run build && npm test && npm run lint`
Expected: all clean.
