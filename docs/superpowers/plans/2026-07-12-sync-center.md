# Sync Center Workspace View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Sync panel moves from a modal into a persistent, self-refreshing workspace `ItemView` ("Sync Center") with a tasks-center-style compact mode, preserving all iter18 two-pane content.

**Architecture:** `src/ui/SyncModal.ts` is renamed to `src/ui/SyncCenterView.ts`; the class becomes an `ItemView`. `main.ts` registers the view, opens-or-reveals a single leaf, and notifies the open view from its two awareness paths. Compact mode is driven by `onResize()` container width (no media query). Two shipped visual fixes ride along in styles.css.

**Tech Stack:** TypeScript, Obsidian plugin API (`ItemView`, `registerView`, `WorkspaceLeaf`), vitest, obsidian-cli.

**Spec:** `docs/superpowers/specs/2026-07-12-sync-center-design.md`. Visual ground truth: `.superpowers/brainstorm/9047-1783841141/content/iter19-final-gallery.html`.

## Global Constraints

- Gate per task: `npm test && npm run build && npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- View identity verbatim: type `config-sync-center`, display text `Sync Center`, icon `arrow-left-right`. Refreshed indicator `refreshed {age}` via existing `relativeAge`.
- Single instance: ribbon/`sync` command reveal an existing leaf instead of opening a second.
- Reload preserves `panelScope`, `search`, fold-open sets, `expandedItems`, staged set + overrides (pruned to existing item names); default pre-check (local-changed + store-newer) only on first load.
- Compact trigger: content width < 700px via `onResize()`; class `is-compact`; the iter18 `@media (max-width: 700px)` block is removed.
- All iter18 content behavior and copy unchanged; reports/confirm stay modals; command and ribbon copy unchanged.
- `src/ui/panelModel.ts` and `src/core/*` untouched.
- Known lint trap: keep `addEventListener` handlers synchronous (`void (async () => {...})()` idiom).
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read the output, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Container migration — `SyncCenterView` + open-or-reveal

**Files:**
- Rename: `src/ui/SyncModal.ts` → `src/ui/SyncCenterView.ts` (`git mv`)
- Modify: `src/ui/SyncCenterView.ts`, `src/main.ts`, `styles.css`

**Interfaces:**
- Produces: `export const SYNC_CENTER_VIEW_TYPE = "config-sync-center"`; `export class SyncCenterView extends ItemView` with `constructor(leaf: WorkspaceLeaf, host: SyncCenterHost)`; `export interface SyncCenterHost` (renamed from `SyncModalHost`, members unchanged). Task 2 adds `notifyExternalChange()`; Task 3 adds compact rendering — both build on this class.

- [ ] **Step 1: Rename + class conversion**

`git mv src/ui/SyncModal.ts src/ui/SyncCenterView.ts`. In the file:

1. Imports: replace `Modal` with `ItemView, WorkspaceLeaf` in the obsidian import.
2. Rename `SyncModalHost` → `SyncCenterHost` (interface body unchanged).
3. Add above the class:

```ts
export const SYNC_CENTER_VIEW_TYPE = "config-sync-center";
```

4. Class declaration and modal plumbing:

```ts
export class SyncCenterView extends ItemView {
  // ... existing fields stay ...

  constructor(leaf: WorkspaceLeaf, private host: SyncCenterHost) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_CENTER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sync Center";
  }

  getIcon(): string {
    return "arrow-left-right";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("config-sync-center");
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
```

Delete the old `constructor(app, host)`, the old `onOpen` (scrim-close hack, `titleEl` setup, `modalEl.addClass("config-sync-wide")`) and old `onClose`. `this.app` is inherited from `ItemView`.

5. Header: the modal `titleEl` is gone. Replace `renderHeaderPills` with a header row rendered into content:

```ts
  private renderHeader(): void {
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    head.createSpan({ cls: "config-sync-center-title", text: "Sync Center" });
    const { up, down, ok, none } = bucketCounts(this.rows().map((r) => r.status));
    const pills = head.createSpan({ cls: "config-sync-report-pills" });
    if (up > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-up",
        text: `↑ ${up}`,
        attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` },
      });
    }
    if (down > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-down",
        text: `↓ ${down}`,
        attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` },
      });
    }
    pills.createSpan({
      cls: "config-sync-pill is-ok",
      text: `✓ ${ok}`,
      attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` },
    });
    if (none > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-none",
        text: `○ ${none}`,
        attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
      });
    }
  }
```

In `render`, replace `this.renderHeaderPills();` with `this.renderHeader();` and delete the old `renderHeaderPills` method.

- [ ] **Step 2: main.ts wiring**

1. Import change: `import { SYNC_CENTER_VIEW_TYPE, SyncCenterView } from "./ui/SyncCenterView";` (drop the SyncModal import). Add `WorkspaceLeaf` to the obsidian import if needed.
2. Extract the host: the object literal currently passed to `new SyncModal(this.app, {...})` in `openSyncPanel` (main.ts:187-255) moves verbatim into a new method:

```ts
  private syncCenterHost(): SyncCenterHost {
    return {
      /* the exact object literal previously passed to new SyncModal — unchanged */
    };
  }
```

(import `SyncCenterHost` type.)
3. In `onload()`, after `addSettingTab`:

```ts
    this.registerView(SYNC_CENTER_VIEW_TYPE, (leaf) => new SyncCenterView(leaf, this.syncCenterHost()));
```

4. Replace `openSyncPanel` with:

```ts
  private async openSyncCenter(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_CENTER_VIEW_TYPE)[0];
    if (existing !== undefined) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: SYNC_CENTER_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
```

Update the three call sites (`sync` command line 77, menu item line 180, individual ribbon line 268) from `openSyncPanel` to `openSyncCenter`. Command/ribbon/menu copy stays byte-identical.

- [ ] **Step 3: CSS**

In `styles.css`: delete the `.modal.config-sync-wide { ... }` rule. Add:

```css
.config-sync-center-head { display: flex; align-items: center; gap: var(--size-4-2); padding-bottom: var(--size-4-2); }

.config-sync-center-title { font-size: var(--font-ui-medium); font-weight: 600; }

.config-sync-center-head .config-sync-report-pills { margin-left: 0; }
```

(Check `.config-sync-panel-title` rules: they styled the modal title. Delete `.config-sync-panel-title` rules if nothing references that class anymore — the class was set on the modal `titleEl`, which no longer exists.)

- [ ] **Step 4: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: pass; typical failures are leftover `Modal`/`titleEl`/`modalEl` references or unused imports — remove them.

```bash
git add -A src/ui/SyncCenterView.ts src/main.ts styles.css
git commit -m "feat: sync panel becomes the Sync Center workspace view"
```

---

### Task 2: Lifecycle — focus/awareness refresh + state preservation

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: Task 1's view class.
- Produces: `notifyExternalChange(): void` on `SyncCenterView`; `main.ts` calls it after both awareness refreshes.

- [ ] **Step 1: State preservation + firstLoad**

In `SyncCenterView`, add fields:

```ts
  private firstLoad = true;
  private lastRefreshedAt: number | null = null;
```

Replace `reload()` with:

```ts
  private async reload(): Promise<void> {
    const gen = ++this.renderGen;
    const { groups, statuses } = await this.host.computeStatuses();
    if (gen !== this.renderGen) return;
    this.groups = groups;
    this.statuses = new Map(statuses.map((s) => [s.group, s]));
    // User state survives reloads; prune entries whose item vanished.
    const names = new Set(groups.map((g) => g.name));
    for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
    for (const n of [...this.directionOverride.keys()]) if (!names.has(n)) this.directionOverride.delete(n);
    for (const n of [...this.expandedItems]) if (!names.has(n)) this.expandedItems.delete(n);
    // Default pre-check seeds once per view lifetime, never on later refreshes.
    if (this.firstLoad) {
      this.firstLoad = false;
      for (const s of statuses) {
        if (s.state === "local-changed" || s.state === "store-newer") this.selected.add(s.group);
      }
    }
    this.lastRefreshedAt = Date.now();
    this.render(gen);
  }
```

(The old body reset `selected`, cleared `directionOverride`, and reset `search` — all of that is gone; `search` and `panelScope` are simply left alone.)

- [ ] **Step 2: Refresh triggers**

In `onOpen()`, before the initial `reload()`:

```ts
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.reload();
      })
    );
```

Add the public notification method:

```ts
  // Called by the plugin when awareness state changes while the view is open.
  notifyExternalChange(): void {
    void this.reload();
  }
```

- [ ] **Step 3: Refreshed indicator**

In `renderHeader()` (Task 1), append as the last child:

```ts
    head.createSpan({
      cls: "config-sync-center-refreshed",
      text: this.lastRefreshedAt === null ? "" : `refreshed ${relativeAge(this.lastRefreshedAt)}`,
    });
```

`styles.css`:

```css
.config-sync-center-refreshed { margin-left: auto; color: var(--text-faint); font-size: var(--font-ui-smaller); }
```

(With `margin-left: auto` on the refreshed span, keep the pills immediately after the title.)

- [ ] **Step 4: main.ts notifications**

Add to the plugin class:

```ts
  private notifySyncCenter(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_CENTER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SyncCenterView) view.notifyExternalChange();
    }
  }
```

Call `this.notifySyncCenter();` as the last line of BOTH `refreshLocalStatus()` (after `updateRibbonDot()`, main.ts ~line 133) and `refreshRemoteChecks()` (after its `updateRibbonDot()`, ~line 153).

Re-entrancy note (verify, don't change): `notifyExternalChange → reload → host.computeStatuses` sets `localStatuses` + `updateRibbonDot` directly and does NOT call `refreshLocalStatus`, so there is no notification loop. The view's own post-action `reload()` plus the host's `refreshLocalStatus` notification can double-refresh; `renderGen` already serializes that.

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/ui/SyncCenterView.ts src/main.ts styles.css
git commit -m "feat: sync center self-refreshes and preserves user state across reloads"
```

---

### Task 3: Compact mode + carried visual fixes

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `styles.css`

**Interfaces:**
- Consumes: Tasks 1-2 view class; existing `renderSidebar`.
- Produces: nothing consumed later.

- [ ] **Step 1: Extract shared scope entries**

Split `renderSidebar` so the sidebar and the compact dropdown share one body. The current `renderSidebar(shell)` becomes:

```ts
  private renderSidebar(shell: HTMLElement): void {
    const side = shell.createDiv({ cls: "config-sync-side" });
    this.renderScopeEntries(side);
  }
```

and the ENTIRE former body (device heads/entries, remotes head + refresh + entries) moves into `renderScopeEntries(container: HTMLElement): void`, writing into `container` instead of `side`. Inside every entry click handler, add `this.switcherOpen = false;` before `this.render(this.renderGen);` (harmless for the sidebar; closes the dropdown in compact).

- [ ] **Step 2: Compact state + onResize**

Fields:

```ts
  private compact = false;
  private switcherOpen = false;
```

```ts
  onResize(): void {
    const width = this.contentEl.clientWidth;
    if (width === 0) return; // hidden leaf
    const compact = width < 700;
    if (compact !== this.compact) {
      this.compact = compact;
      this.render(this.renderGen);
    }
  }
```

In `render()`, the shell line becomes:

```ts
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
```

Also call `this.onResize()` once at the top of `onOpen()` (before the first reload) so the initial render starts in the right mode.

- [ ] **Step 3: Switcher + dropdown**

```ts
  // Compact replacement for the sidebar: current scope as a button; dropdown mirrors the sidebar.
  private renderSwitcher(shell: HTMLElement): void {
    const sw = shell.createDiv({ cls: "config-sync-switcher" });
    if (this.panelScope.kind === "device") {
      const cat = this.panelScope.cat;
      sw.createSpan({ text: cat === "all" ? "All items" : CATEGORY_LABELS[cat] });
      const c = bucketCounts(this.scopedRows().map((r) => r.status));
      if (c.up > 0) sw.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) sw.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
      if (c.ok > 0) sw.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) sw.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
    } else {
      sw.createSpan({ text: this.panelScope.name });
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
      sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph });
    }
    sw.createSpan({ cls: "config-sync-switcher-chev", text: this.switcherOpen ? "▴" : "▾" });
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      this.switcherOpen = !this.switcherOpen;
      this.render(this.renderGen);
    });
    if (this.switcherOpen) {
      const menu = shell.createDiv({ cls: "config-sync-switcher-menu" });
      this.renderScopeEntries(menu);
    }
  }
```

Outside-click close — register ONCE in `onOpen()` (auto-cleaned by the component):

```ts
    this.registerDomEvent(document, "click", (ev) => {
      if (!this.switcherOpen) return;
      const t = ev.target as Node;
      const sw = this.contentEl.querySelector(".config-sync-switcher");
      const menu = this.contentEl.querySelector(".config-sync-switcher-menu");
      if (sw?.contains(t) === true || menu?.contains(t) === true) return;
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
```

- [ ] **Step 4: CSS — compact + the two fixes**

Delete the whole `@media (max-width: 700px) { ... }` block. Add:

```css
.config-sync-shell.is-compact { grid-template-columns: 1fr; }

.config-sync-switcher { display: flex; align-items: center; gap: var(--size-4-1); width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; padding: 7px 11px; cursor: pointer; font-size: var(--font-ui-small); }

.config-sync-switcher-chev { margin-left: auto; color: var(--text-faint); }

.config-sync-switcher-menu { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 9px; padding: 5px; box-shadow: var(--shadow-s); }
```

Fix 1 — select-all alignment: extend the existing `.config-sync-mainbar` rule with `padding-right: 11px;`.

Fix 2 — segment direction tints: after the base `.config-sync-seg-btn` rule add:

```css
.config-sync-seg-btn.is-capture { color: var(--color-orange); }

.config-sync-seg-btn.is-apply { color: var(--color-purple); }
```

(The existing `.is-on` filled-background rules stay and win when active.)

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat: compact scope switcher for narrow leaves; alignment and segment-tint fixes"
```

---

### Task 4: Live smoke + docs refresh

**Files:**
- Modify: `docs/assets/sync-panel.png`, `README.md`, `README.zh.md` (minimal wording)

- [ ] **Step 1: Install + reload** (guard first, standalone). `npm run smoke:install`, reload plugin via eval.
- [ ] **Step 2: Verify** (guard per batch; DOM dumps + screenshots):
  1. `config-sync:sync` command opens a "Sync Center" tab (icon `arrow-left-right`); running it again REVEALS the same leaf (leaf count stays 1).
  2. Header: title + global pills + `refreshed just now`.
  3. Stage a change on disk while the view is open → within ~2s (debounce) the view refreshes in place; scope/search/staging survive; pre-check is NOT re-seeded (an unstaged actionable row stays unstaged).
  4. Focus-refresh: switch to another tab, touch a config file, switch back → view refreshed.
  5. Footer execute still runs the report flow; view refreshes after.
  6. Resize the leaf below 700px (window resize or split) → `is-compact`: sidebar gone, switcher shows scope + badges; dropdown lists device + remote entries and switches scope; outside click closes; back above 700px restores the sidebar.
  7. Visual fixes: select-all right edge aligns with row checkboxes; unstaged segments show orange/purple text.
  8. `grep -rn "SyncModal" src/` → no matches; no modal opens anywhere for the panel.
- [ ] **Step 3: README wording + screenshot.** In `README.md`/`README.zh.md`, update only the sentences that describe opening "the sync panel (modal)" to say the Sync Center tab (keep all other content); refresh `docs/assets/sync-panel.png` with a representative Sync Center frame (MD5 double-take; NBSP-safe copy).
- [ ] **Step 4: Clean up** staging, confirm all in-sync, `dev:errors` clean. Commit:

```bash
git add docs/assets/sync-panel.png README.md README.zh.md
git commit -m "docs: Sync Center tab wording and screenshot"
```

---

## Verification after all tasks

1. Full gate. `grep -rn "SyncModal\|config-sync-wide\|@media (max-width: 700px)" src/ styles.css` → no matches.
2. Smoke evidence in ledger incl. single-instance reveal, live refresh with state preservation, compact switcher round-trip.
3. Ledger records iter19 completion.
