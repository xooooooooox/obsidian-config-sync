# Orphan enabled-snippet cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop showing/syncing orphan enabled-snippet names (enabled in `appearance.json` but with no `.css` file and not in the store), and offer a manual "Clean up" prune in the snippet drawer.

**Architecture:** A pure `snippetOrphans(local, fromDir, store)` helper classifies orphans; `switchListRows` drops them from the snippet row universe (→ `fromDir ∪ store`); two host methods (`snippetOrphanNames`, `removeSnippetOrphans`) expose + prune them; `SettingTab` renders a collapsed "no file" notice with manual Remove that edits both `appearance.json` and Obsidian's in-memory `enabledSnippets`.

**Tech Stack:** TypeScript, Obsidian API (`app.customCss.enabledSnippets`), CSS, vitest.

## Global Constraints

- **Orphan** = a name in local `enabledCssSnippets` that is **not** a `.css` file locally (`fromDir`) **and not** in the store's shared list. The "not in store" clause keeps a fresh device mid-sync (enabled-list synced, `snippets/` not yet) from being misclassified.
- **Never auto-delete.** Removal happens only on the user's Remove/Remove-all click. No scan/capture-time pruning.
- **Capture untouched** — no masking of orphans from capture (transient-file risk); prune is the sync remedy.
- Snippet-only: no orphan handling for plugin/core switch lists.
- CSS: theme variables only (no hex/rgb; release-gated by `check-no-hardcoded-color.sh`).
- Gates: `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (+ new unit tests), `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No Claude/AI attribution in commit messages.

---

### Task 1: `snippetOrphans` pure helper + unit tests

**Files:**
- Modify: `src/core/availability.ts` (add after `snippetForceOff`, ~line 110)
- Modify: `tests/availability.test.ts`

**Interfaces:**
- Produces: `export function snippetOrphans(local: string[], fromDir: string[], store: string[]): string[]`

- [ ] **Step 1: Write the failing test.** Append to `tests/availability.test.ts`:

```ts
describe("snippetOrphans", () => {
  it("flags names enabled locally with no file and not in the store", () => {
    const local = ["callouts", "mystyle", "IOTO-table"];
    const fromDir = ["mystyle", "IOTO-table"]; // files present
    const store = ["IOTO-table"]; // shared
    expect(snippetOrphans(local, fromDir, store)).toEqual(["callouts"]);
  });

  it("does not flag a name that has a local file", () => {
    expect(snippetOrphans(["mystyle"], ["mystyle"], [])).toEqual([]);
  });

  it("does not flag a name present in the store (fresh device, file not synced yet)", () => {
    expect(snippetOrphans(["pending"], [], ["pending"])).toEqual([]);
  });

  it("returns a sorted, unique list and handles empty local", () => {
    expect(snippetOrphans([], ["x"], ["y"])).toEqual([]);
    expect(snippetOrphans(["b", "a", "b"], [], [])).toEqual(["a", "b"]);
  });
});
```

(Ensure `snippetOrphans` is added to the existing import from `../src/core/availability` at the top of the test file.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/availability.test.ts`
Expected: FAIL — `snippetOrphans` is not exported.

- [ ] **Step 3: Implement.** In `src/core/availability.ts`, after the `snippetForceOff` function (ends ~line 110), add:

```ts
// Enabled snippet names with no local .css file and not in the shared store — dead
// leftovers from deleted/renamed snippets. "not in store" excludes a fresh device whose
// snippets/ dir hasn't synced yet (its enabled names travel in the store).
export function snippetOrphans(local: string[], fromDir: string[], store: string[]): string[] {
  const files = new Set(fromDir);
  const shared = new Set(store);
  return [...new Set(local.filter((n) => !files.has(n) && !shared.has(n)))].sort();
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run tests/availability.test.ts`
Expected: PASS (4 new cases green).

- [ ] **Step 5: Commit.**

```bash
git add src/core/availability.ts tests/availability.test.ts && git commit -m "feat(core): snippetOrphans helper (enabled, no file, not in store)"
```

---

### Task 2: Exclude orphans from `switchListRows` + host methods

**Files:**
- Modify: `src/main.ts` — add `snippetOrphans` import; extract a `snippetUniverse` private method; change the `enabled-css-snippets` branch of `switchListRows` (`:1109-1136`); add `snippetOrphanNames` + `removeSnippetOrphans` methods.

**Interfaces:**
- Consumes: `snippetOrphans` (Task 1); existing `readLocalSwitchList`, `writeLocalSwitchList`, `parseSwitchList`, `groupStorePath`, `basename`, `scopedAwaySnippets` (already imported in `main.ts`).
- Produces: `async snippetOrphanNames(): Promise<string[]>`; `async removeSnippetOrphans(names: string[]): Promise<void>`.

- [ ] **Step 1: Import the helper.** In `src/main.ts`, add `snippetOrphans` to the existing import from `./core/availability` (the module that already exports `scopedAwaySnippets`).

- [ ] **Step 2: Extract `snippetUniverse`.** Add this private method just above `switchListRows` (before `:1107`):

```ts
  private async snippetUniverse(): Promise<{ fromDir: string[]; store: string[]; local: string[] }> {
    const io = this.app.vault.adapter;
    const cfg = this.app.vault.configDir;
    const readArr = async (p: string): Promise<string[]> => {
      try {
        if (!(await io.exists(p))) return [];
        const parsed = parseSwitchList(await io.read(p));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const files = (await io.exists(`${cfg}/snippets`)) ? (await io.list(`${cfg}/snippets`)).files : [];
    const fromDir = files.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
    const appList = (await io.exists(`${cfg}/appearance.json`)) ? readLocalSwitchList("enabled-css-snippets", await io.read(`${cfg}/appearance.json`)) : [];
    const local = Array.isArray(appList) ? appList : [];
    const root = await this.resolvedRootPath();
    const store = await readArr(`${root}/store/${groupStorePath("{configDir}/enabled-css-snippets.json")}`);
    return { fromDir, store, local };
  }
```

- [ ] **Step 3: Rewrite the `enabled-css-snippets` branch of `switchListRows`** (`:1109-1136`). Replace:

```ts
    if (groupName === "enabled-css-snippets") {
      const cfg = this.app.vault.configDir;
      const readArr = async (p: string): Promise<string[]> => {
        try {
          if (!(await io.exists(p))) return [];
          const parsed = parseSwitchList(await io.read(p));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      // universe = .css files in snippets/ ∪ store list ∪ locally-enabled
      const files = (await io.exists(`${cfg}/snippets`)) ? (await io.list(`${cfg}/snippets`)).files : [];
      const fromDir = files.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
      const app = (await io.exists(`${cfg}/appearance.json`)) ? readLocalSwitchList("enabled-css-snippets", await io.read(`${cfg}/appearance.json`)) : [];
      const local = Array.isArray(app) ? app : [];
      const root = await this.resolvedRootPath();
      const store = await readArr(`${root}/store/${groupStorePath("{configDir}/enabled-css-snippets.json")}`);
      const scopedAway = scopedAwaySnippets(this.settings.snippetScopes, Platform.isMobile);
      const pins = new Set(this.settings.switchExceptions["enabled-css-snippets"] ?? []);
      const ids = [...new Set([...fromDir, ...store, ...local])].sort();
      return ids.map((id) => ({
        id,
        name: id,
        hint: `${local.includes(id) ? "on here" : "off here"} · ${store.includes(id) ? "store has on" : "store has off"}`,
        desktopOnly: false,
        deviceScoped: scopedAway.has(id) && !pins.has(id), // pin > scope: pinned rows are user-controlled/local, not auto-excluded
      }));
    }
```

with:

```ts
    if (groupName === "enabled-css-snippets") {
      const { fromDir, store, local } = await this.snippetUniverse();
      const scopedAway = scopedAwaySnippets(this.settings.snippetScopes, Platform.isMobile);
      const pins = new Set(this.settings.switchExceptions["enabled-css-snippets"] ?? []);
      // universe = files ∪ store; orphans (enabled locally, no file, not in store) are excluded
      // and surfaced separately via snippetOrphanNames()/removeSnippetOrphans().
      const ids = [...new Set([...fromDir, ...store])].sort();
      return ids.map((id) => ({
        id,
        name: id,
        hint: `${local.includes(id) ? "on here" : "off here"} · ${store.includes(id) ? "store has on" : "store has off"}`,
        desktopOnly: false,
        deviceScoped: scopedAway.has(id) && !pins.has(id), // pin > scope: pinned rows are user-controlled/local, not auto-excluded
      }));
    }
```

(The `const io = this.app.vault.adapter;` at `:1108` stays — the plugin/core branch below still uses it.)

- [ ] **Step 4: Add the two host methods.** Immediately after `switchListRows` closes (after its final `}`), add:

```ts
  async snippetOrphanNames(): Promise<string[]> {
    const { fromDir, store, local } = await this.snippetUniverse();
    return snippetOrphans(local, fromDir, store);
  }

  // Prune dead enabled-snippet names. Removes from both appearance.json on disk AND
  // Obsidian's in-memory enabledSnippets set, so a later appearance-write can't re-add them.
  async removeSnippetOrphans(names: string[]): Promise<void> {
    if (names.length === 0) return;
    const drop = new Set(names);
    const customCss = (this.app as unknown as { customCss?: { enabledSnippets?: Set<string> } }).customCss;
    if (customCss?.enabledSnippets !== undefined) {
      for (const n of names) customCss.enabledSnippets.delete(n);
    }
    const io = this.app.vault.adapter;
    const path = `${this.app.vault.configDir}/appearance.json`;
    if (!(await io.exists(path))) return;
    const prior = await io.read(path);
    const current = readLocalSwitchList("enabled-css-snippets", prior);
    const list = Array.isArray(current) ? current : [];
    const filtered = list.filter((n) => !drop.has(n));
    await io.write(path, writeLocalSwitchList("enabled-css-snippets", filtered, prior));
  }
```

- [ ] **Step 5: Gates.** Run the full gate command (see Global Constraints). Expected: tsc clean; tests green (Task 1's + unchanged suite); eslint 0/67; color-check OK; build clean.

- [ ] **Step 6: Commit.**

```bash
git add src/main.ts && git commit -m "feat(main): exclude snippet orphans from the list; expose + prune host methods"
```

---

### Task 3: Orphan "no file" notice + prune wiring + CSS

**Files:**
- Modify: `src/ui/SettingTab.ts` — `SettingsHost` interface (`:28-61`); `renderLocalDecisions` (`renderRows` end ~`:707`, `reload` ~`:722`).
- Modify: `styles.css` — orphan-notice rules.

**Interfaces:**
- Consumes: `snippetOrphanNames(): Promise<string[]>`, `removeSnippetOrphans(names: string[]): Promise<void>` (Task 2).

- [ ] **Step 1: Extend the host interface.** In `src/ui/SettingTab.ts`, in the `SettingsHost` interface right after the `switchListRows(...)` line (`:61`), add:

```ts
  snippetOrphanNames(): Promise<string[]>;
  removeSnippetOrphans(names: string[]): Promise<void>;
```

- [ ] **Step 2: Add orphan state + fetch in `reload`.** In `renderLocalDecisions`, declare two closure vars just before `const renderRows = (rows: SwitchRow[]): void => {` (~`:608`):

```ts
    let orphans: string[] = [];
    let orphansExpanded = false;
```

Then change `reload` (currently `:722-724`) to fetch orphans before rendering:

```ts
    const reload = async (): Promise<void> => {
      const fresh = await this.host.switchListRows(group.name);
      orphans = isSnippetGroup ? await this.host.snippetOrphanNames() : [];
      renderRows(fresh);
    };
```

- [ ] **Step 3: Render the notice at the end of `renderRows`.** Inside `renderRows`, after the `for (const r of ordered) { ... }` loop closes and before `renderRows`'s own closing `}` (~`:707`), add:

```ts
      if (isSnippetGroup && orphans.length > 0) {
        const sec = listEl.createDiv({ cls: "config-sync-orphan-sec" });
        const notice = sec.createDiv({ cls: "config-sync-orphan-notice", attr: { role: "button", tabindex: "0" } });
        notice.createSpan({ cls: "config-sync-orphan-ic", text: "○" });
        notice.createSpan({ cls: "config-sync-orphan-nt", text: `${orphans.length} enabled snippet${orphans.length === 1 ? "" : "s"} have no file` });
        notice.createDiv({ cls: "config-sync-rule-spacer" });
        notice.createSpan({ cls: "config-sync-orphan-act", text: "Clean up" });
        notice.createSpan({ cls: "config-sync-orphan-chev", text: orphansExpanded ? "▾" : "▸" });
        notice.addEventListener("click", () => {
          orphansExpanded = !orphansExpanded;
          renderRows(rows);
        });
        if (orphansExpanded) {
          const body = sec.createDiv({ cls: "config-sync-orphan-body" });
          body.createDiv({
            cls: "config-sync-orphan-desc",
            text: "Enabled in Obsidian but their .css file is gone (deleted or renamed). They do nothing and aren't synced. Remove to clean appearance.json.",
          });
          for (const name of orphans) {
            const orow = body.createDiv({ cls: "config-sync-orphan-row" });
            orow.createSpan({ cls: "config-sync-orphan-name", text: name });
            orow.createSpan({ cls: "config-sync-orphan-tag", text: "no file" });
            orow.createDiv({ cls: "config-sync-rule-spacer" });
            const rm = orow.createSpan({ cls: "config-sync-orphan-remove", text: "Remove", attr: { role: "button", tabindex: "0" } });
            rm.addEventListener("click", () => void (async () => {
              await this.host.removeSnippetOrphans([name]);
              await reload();
            })());
          }
          const allRow = body.createDiv({ cls: "config-sync-orphan-row" });
          allRow.createDiv({ cls: "config-sync-rule-spacer" });
          const rmAll = allRow.createSpan({ cls: "config-sync-orphan-removeall", text: `Remove all ${orphans.length}`, attr: { role: "button", tabindex: "0" } });
          rmAll.addEventListener("click", () => void (async () => {
            await this.host.removeSnippetOrphans([...orphans]);
            await reload();
          })());
        }
      }
```

(`rows` is `renderRows`'s parameter, in scope; `orphans`/`orphansExpanded`/`reload` are the enclosing closures. Toggling expand re-runs `renderRows(rows)`; Remove calls `reload()` which re-fetches orphans and re-renders, so the count updates and the notice vanishes at 0.)

- [ ] **Step 4: Add CSS.** In `styles.css`, add near the other `.config-sync-ld*` rules:

```css
.config-sync-orphan-sec { border-top: 1px solid var(--background-modifier-border); }
.config-sync-orphan-notice { display: flex; align-items: center; gap: var(--size-4-2); padding: var(--size-4-2) var(--size-4-3); cursor: pointer; }
.config-sync-orphan-ic { color: var(--text-faint); }
.config-sync-orphan-nt { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.config-sync-orphan-act { color: var(--text-accent); font-size: var(--font-ui-smaller); }
.config-sync-orphan-chev { color: var(--text-faint); font-size: var(--font-ui-smaller); }
.config-sync-orphan-desc { color: var(--text-faint); font-size: var(--font-ui-smaller); padding: 0 var(--size-4-3) var(--size-4-2); line-height: 1.4; }
.config-sync-orphan-row { display: flex; align-items: center; gap: var(--size-4-2); padding: var(--size-2-3) var(--size-4-3); opacity: 0.85; }
.config-sync-orphan-name { color: var(--text-muted); }
.config-sync-orphan-tag { color: var(--text-faint); font-size: var(--font-ui-smaller); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 0 var(--size-2-2); }
.config-sync-orphan-remove, .config-sync-orphan-removeall { color: var(--text-error); font-size: var(--font-ui-smaller); cursor: pointer; }
```

- [ ] **Step 5: Gates.** Run the full gate command. Expected: all clean (tests unchanged from Task 2 — DOM change, no new tests).

- [ ] **Step 6: Commit.**

```bash
git add src/ui/SettingTab.ts styles.css && git commit -m "feat(ui): snippet drawer surfaces + prunes no-file orphans"
```

---

### Task 4: Live verification (dev vault)

**Files:** none. Drive with `obsidian-cli` (binary `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`; run from `dev/vault/`; `eval` needs `code=<js>`, wrap top-level `await`). Focus Obsidian first (`open -a Obsidian`). The dev vault has 4 real orphans (`callouts`, `dashboard`, `hideProperties`, `table`).

- [ ] **Step 1: Deploy + reload.** `cd ~/local/coding/open/obsidian-config-sync && npm run build && cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`, then from `dev/vault/`: `obsidian-cli eval code="(async()=>{await app.plugins.disablePlugin('config-sync');await app.plugins.enablePlugin('config-sync');return 'reloaded';})()"`.

- [ ] **Step 2: Orphans excluded + notice present.** Open Settings → config-sync tab → the "Obsidian" sub-tab → expand the "Enabled CSS snippets" drawer (e.g. `tab.expanded.add('enabled-css-snippets'); await tab.rerender(0)`), then probe:

```js
(async()=>{
  const tab=app.setting.activeTab, ce=tab.containerEl;
  const listNames=[...ce.querySelectorAll('.config-sync-ldname')].map(e=>e.textContent);
  const orphanShown=['callouts','dashboard','hideProperties','table'].filter(n=>listNames.includes(n));
  const notice=ce.querySelector('.config-sync-orphan-nt')?.textContent;
  return JSON.stringify({ normalListHasOrphans:orphanShown, notice });
})()
```

Expected: `normalListHasOrphans: []` (none in the normal list), `notice: "4 enabled snippets have no file"`.

- [ ] **Step 3: Expand + Remove one.** Click the notice (or set `orphansExpanded` via a click on `.config-sync-orphan-notice`), confirm 4 orphan rows appear, click one `.config-sync-orphan-remove`, wait, then verify that name left `appearance.json` and the notice now reads "3 …":

```js
(async()=>{
  const ce=app.setting.activeTab.containerEl;
  ce.querySelector('.config-sync-orphan-notice')?.click();
  await new Promise(r=>setTimeout(r,300));
  ce.querySelector('.config-sync-orphan-remove')?.click();
  await new Promise(r=>setTimeout(r,500));
  const io=app.vault.adapter, cfg=app.vault.configDir;
  const enabled=JSON.parse(await io.read(`${cfg}/appearance.json`)).enabledCssSnippets;
  const inMem=[...app.customCss.enabledSnippets];
  return JSON.stringify({ notice:ce.querySelector('.config-sync-orphan-nt')?.textContent, calloutsInFile:enabled.includes('callouts'), calloutsInMem:inMem.includes('callouts') });
})()
```

Expected: `notice: "3 enabled snippets have no file"`, and the removed name absent from both `appearance.json` and the in-memory set.

- [ ] **Step 4: Remove all → notice gone.** Click `.config-sync-orphan-removeall`, wait, confirm the notice is gone and `enabledCssSnippets` now equals the real file/store set (no orphans):

```js
(async()=>{
  const ce=app.setting.activeTab.containerEl;
  ce.querySelector('.config-sync-orphan-removeall')?.click();
  await new Promise(r=>setTimeout(r,500));
  const io=app.vault.adapter, cfg=app.vault.configDir;
  const enabled=JSON.parse(await io.read(`${cfg}/appearance.json`)).enabledCssSnippets;
  const orphansLeft=['callouts','dashboard','hideProperties','table'].filter(n=>enabled.includes(n));
  return JSON.stringify({ noticeGone: ce.querySelector('.config-sync-orphan-notice')===null, orphansLeftInFile:orphansLeft });
})()
```

Expected: `noticeGone: true`, `orphansLeftInFile: []`.

- [ ] **Step 5: Screenshot** desktop (collapsed + expanded notice). Note: 390×844 mobile fit can be eyeballed on a real phone (the notice is a single row + short list).

---

## Self-Review

**Spec coverage:**
- Orphan detection (pure) → Task 1 (`snippetOrphans`, unit-tested incl. fresh-device/store case). ✓
- List exclusion (`fromDir ∪ store`) → Task 2 Step 3. ✓
- `snippetOrphanNames` + `removeSnippetOrphans` host methods (appearance.json + in-memory set) → Task 2 Step 4; interface → Task 3 Step 1. ✓
- Collapsed V2 notice, snippet-drawer-only, manual Remove/Remove-all, never auto → Task 3 Steps 2-3. ✓
- Capture untouched → no task modifies capture. ✓
- CSS theme-vars only → Task 3 Step 4. ✓
- Testing: unit (Task 1) + live desktop (Task 4). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete before/after; eval probes complete. ✓

**Type consistency:** `snippetOrphans(local, fromDir, store): string[]` (Task 1) is imported and called in Task 2's `snippetOrphanNames` and nowhere clashes (host method is deliberately named `snippetOrphanNames`, not `snippetOrphans`, to avoid shadowing the import). `snippetOrphanNames`/`removeSnippetOrphans` signatures match between Task 2 (impl), Task 3 Step 1 (interface), and Task 3 Step 3 (calls). `snippetUniverse(): Promise<{fromDir,store,local}>` consumed by both `switchListRows` and `snippetOrphanNames`. The `customCss` internal is narrowed from `unknown` at the boundary (no `any`). ✓
