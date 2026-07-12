# Wide Two-Pane Panel & Staging Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One execution point (footer) with per-item direction *staging* instead of immediate-execute buttons, and a 920px two-pane layout: scope sidebar (categories + remotes) on the left, flat filtered list or remote detail on the right.

**Architecture:** Pure helpers (`Direction`/`directionForState` move in, plus `effectiveDirection`, `matchesSearch`, `nosettingsLineText`) live in `src/ui/panelModel.ts`. `src/ui/SyncModal.ts` is restructured: `render` → header pills + shell grid (`renderSidebar` + item-mode or remote-mode main pane); sections, per-section checkboxes, expandable remote rows, and immediate mini-actions are retired. `styles.css` gains the grid/sidebar/segment/footer rules and a <700px single-column fallback. Core, counting, awareness, commands, reports: untouched.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, obsidian-cli.

**Spec:** `docs/superpowers/specs/2026-07-12-wide-panel-staging-design.md`. Visual ground truth: `.superpowers/brainstorm/9047-1783841141/content/iter18-final-gallery.html`.

## Global Constraints

- Gate per task: `npm test && npm run build && npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/ui/panelModel.ts`: no obsidian imports, no DOM.
- Staging semantics: segment click = check row + set direction override; click on the row's active segment = uncheck + clear override; checkbox toggles staged using effective direction; effective direction = override ?? state default; overrides and search reset on every `reload()`. Footer buttons are the ONLY execution points; `host.captureItems`/`applyItems` signatures unchanged.
- Copy verbatim: sidebar `All items`; heads `This device ↔ store` / `Remotes · checked {age}`; segments `↑ Capture` / `↓ Apply store`; segment aria `Capture this (keep local)` / `Apply store version (overwrites local)`; search placeholder `Filter by name…`; footer `{n} staged`; no-settings line `○ {n} item with no settings yet ▸` / `○ {n} items with no settings yet ▸` (`▾` open).
- Filter-pill counts are computed over the current sidebar scope; title pills stay global; footer staged/execute counts are global (across scopes).
- Known lint trap: async callbacks on `addEventListener` trip `@typescript-eslint/no-misused-promises` — wrap as `void (async () => {...})()` inside a sync handler (existing file idiom).
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read the output, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: panelModel — direction + search + line-text helpers

**Files:**
- Modify: `src/ui/panelModel.ts`
- Modify: `src/ui/SyncModal.ts` (only the import/removal of the moved `Direction`/`directionForState`)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Produces (Tasks 2-3 rely on these exact names):
  - `export type Direction = "capture" | "apply"` (moved from SyncModal.ts)
  - `export function directionForState(state: GroupState): Direction` (moved from SyncModal.ts, body unchanged)
  - `export function effectiveDirection(state: GroupState, override: Direction | undefined): Direction`
  - `export function matchesSearch(name: string, query: string): boolean`
  - `export function nosettingsLineText(n: number, open: boolean): string`

- [ ] **Step 1: Failing tests** — append to `tests/panelModel.test.ts`:

```ts
import { directionForState, effectiveDirection, matchesSearch, nosettingsLineText } from "../src/ui/panelModel";

describe("direction", () => {
  it("defaults by state and honors an explicit override", () => {
    expect(directionForState("local-changed")).toBe("capture");
    expect(directionForState("not-captured")).toBe("capture");
    expect(directionForState("store-newer")).toBe("apply");
    expect(directionForState("differs")).toBe("apply");
    expect(effectiveDirection("differs", undefined)).toBe("apply");
    expect(effectiveDirection("differs", "capture")).toBe("capture");
    expect(effectiveDirection("local-changed", "apply")).toBe("apply");
  });
});

describe("matchesSearch", () => {
  it("is case-insensitive substring, empty/whitespace query matches all", () => {
    expect(matchesSearch("plugin-templater-obsidian", "TEMPLA")).toBe(true);
    expect(matchesSearch("hotkeys", "graph")).toBe(false);
    expect(matchesSearch("anything", "")).toBe(true);
    expect(matchesSearch("anything", "   ")).toBe(true);
  });
});

describe("nosettingsLineText", () => {
  it("pluralizes and carries the chevron", () => {
    expect(nosettingsLineText(1, false)).toBe("○ 1 item with no settings yet ▸");
    expect(nosettingsLineText(16, false)).toBe("○ 16 items with no settings yet ▸");
    expect(nosettingsLineText(2, true)).toBe("○ 2 items with no settings yet ▾");
  });
});
```

(Merge the import line with the file's existing panelModel import.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/panelModel.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement** — in `src/ui/panelModel.ts` add:

```ts
// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
export type Direction = "capture" | "apply";

// Default direction by state: capture for local-changed/not-captured, apply otherwise.
export function directionForState(state: GroupState): Direction {
  return state === "local-changed" || state === "not-captured" ? "capture" : "apply";
}

// The staged direction: an explicit user choice wins over the state default.
export function effectiveDirection(state: GroupState, override: Direction | undefined): Direction {
  return override ?? directionForState(state);
}

export function matchesSearch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

export function nosettingsLineText(n: number, open: boolean): string {
  return `○ ${n} item${n === 1 ? "" : "s"} with no settings yet ${open ? "▾" : "▸"}`;
}
```

In `src/ui/SyncModal.ts`: delete the local `type Direction` (~line 9) and `directionForState` (~lines 26-28, with its comment), and add `Direction`, `directionForState` to the existing `./panelModel` import. Nothing else changes in this task.

- [ ] **Step 4: Verify pass** — `npx vitest run tests/panelModel.test.ts`, then `npm test`.
- [ ] **Step 5: Gate + commit**

```bash
git add src/ui/panelModel.ts src/ui/SyncModal.ts tests/panelModel.test.ts
git commit -m "feat: direction, search, and line-text helpers in panelModel"
```

---

### Task 2: Staging semantics — segmented toggle, one execution point

**Files:**
- Modify: `src/ui/SyncModal.ts`, `styles.css`

**Interfaces:**
- Consumes: Task 1's `Direction`, `directionForState`, `effectiveDirection`.
- Produces: field `private directionOverride: Map<string, Direction>`; method `private renderDirectionToggle(detail: HTMLElement, r: StatusRow): void`; method `private effDir(r: StatusRow): Direction`. Task 3's rewritten layout calls these unchanged.

- [ ] **Step 1: State + effective direction**

In `SyncModal`, next to `private selected` add:

```ts
  private directionOverride: Map<string, Direction> = new Map();
```

In `reload()`, next to the `this.selected = new Set()` reset add:

```ts
    this.directionOverride.clear();
```

Add the helper method:

```ts
  private effDir(r: StatusRow): Direction {
    return effectiveDirection(r.status.state, this.directionOverride.get(r.group.name));
  }
```

- [ ] **Step 2: Replace `renderMiniActions` with `renderDirectionToggle`**

Delete `renderMiniActions` (~lines 323-341) and its call in `renderItemDetail`; call the new method instead (same call site, same arguments shape — pass `r`, not `r.group.name`):

```ts
    this.renderDirectionToggle(detail, r);
    this.renderCappedChanges(detail, status.changes);
```

```ts
  // Staging, not execution: a segment checks the row in that direction; clicking the
  // active segment unstages it. The footer buttons are the only execution points.
  private renderDirectionToggle(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const staged = this.selected.has(name);
    const dir = this.effDir(r);
    const seg = detail.createDiv({ cls: "config-sync-seg" });
    const segBtn = (d: Direction, label: string, aria: string): void => {
      const on = staged && dir === d;
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-${d}${on ? " is-on" : ""}`,
        text: label,
        attr: { "aria-label": aria },
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (on) {
          this.selected.delete(name);
          this.directionOverride.delete(name);
        } else {
          this.selected.add(name);
          this.directionOverride.set(name, d);
        }
        this.render(this.renderGen);
      });
    };
    segBtn("capture", "↑ Capture", "Capture this (keep local)");
    segBtn("apply", "↓ Apply store", "Apply store version (overwrites local)");
  }
```

- [ ] **Step 3: Effective direction drives checkbox + split**

In `renderItemRow`, replace `const dir = directionForState(status.state);` with `const dir = this.effDir(r);` (keep the `is-capture`/`is-apply` class logic).

Replace `captureNames`/`applyNames`:

```ts
  private captureNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.effDir(r) === "capture")
      .map((r) => r.group.name);
  }

  private applyNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.effDir(r) === "apply")
      .map((r) => r.group.name);
  }
```

In `renderActionBar`, before the buttons add the staged label as the bar's first child:

```ts
    bar.createSpan({ cls: "config-sync-staged-count", text: `${this.selected.size} staged` });
    bar.createDiv({ cls: "config-sync-rule-spacer" });
```

- [ ] **Step 4: CSS** — in `styles.css`, replace the `.config-sync-mini*` rules (delete `.config-sync-mini-actions`, `.config-sync-mini`, `.config-sync-mini.is-capture`, `.config-sync-mini.is-apply`) with:

```css
.config-sync-seg { display: inline-flex; border: 1px solid var(--background-modifier-border); border-radius: 5px; overflow: hidden; margin: 2px 0 var(--size-4-1) 0; font-family: var(--font-interface); }

.config-sync-seg-btn { background: none; border: none; border-radius: 0; box-shadow: none; height: auto; padding: 1px 9px; font-size: var(--font-ui-smaller); color: var(--text-muted); cursor: pointer; }

.config-sync-seg-btn.is-capture.is-on { background: rgba(var(--color-orange-rgb), 0.25); color: var(--color-orange); }

.config-sync-seg-btn.is-apply.is-on { background: rgba(var(--color-purple-rgb), 0.25); color: var(--color-purple); }

.config-sync-staged-count { color: var(--text-muted); font-size: var(--font-ui-smaller); }
```

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "feat: per-item direction staging replaces immediate-execute buttons"
```

---

### Task 3: Two-pane layout — sidebar, flat list, search, remote mode

**Files:**
- Modify: `src/ui/SyncModal.ts` (structural rewrite of render paths), `styles.css`

**Interfaces:**
- Consumes: Task 1 helpers (`matchesSearch`, `nosettingsLineText`), Task 2 (`renderDirectionToggle`, `effDir`, staged footer). Existing: `bucketCounts`, `CATEGORY_ORDER`/`CATEGORY_LABELS`/`categoryForGroup`, `visibleUnderFilter`, `insyncLineText`, `renderItemRow`, `renderItemDetail`, `renderRemoteDetail`, `renderRemoteButtons`, `remoteIcon`, `relativeAge`, `isoAge`.
- Produces: nothing consumed later.

- [ ] **Step 1: Scope state + retired state**

Replace the module-scope `sessionUi` block with (collapse lines now keyed by scope key string):

```ts
// Session-remembered UI state: which scopes have their ✓ / ○ trailing lines flattened open.
const sessionUi = {
  insyncOpen: new Set<string>(),
  nosettingsOpen: new Set<string>(),
};
```

In `SyncModal` fields: DELETE `expandedRemotes` and `remotesEl`. ADD:

```ts
  private scope: { kind: "device"; cat: ItemCategory | "all" } | { kind: "remote"; name: string } = { kind: "device", cat: "all" };
  private search = "";
```

In `reload()`, add `this.search = "";` next to the other resets (scope is intentionally kept across reloads within one open; a fresh modal starts at the default). In `onOpen()`, after `titleEl` setup add `this.modalEl.addClass("config-sync-wide");`.

- [ ] **Step 2: New render skeleton**

Replace `render` (~lines 111-118) with:

```ts
  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    this.contentEl.empty();
    this.renderHeaderPills();
    const shell = this.contentEl.createDiv({ cls: "config-sync-shell" });
    this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "config-sync-main" });
    if (this.scope.kind === "remote") {
      const remote = this.host.remotes().find((x) => this.scope.kind === "remote" && x.name === this.scope.name);
      if (remote !== undefined) {
        this.renderRemoteMode(main, remote);
        return;
      }
      this.scope = { kind: "device", cat: "all" }; // remote vanished (settings change) — fall back
    }
    this.renderItemMode(main);
  }
```

DELETE outright: `renderDeviceMacro`, `renderFilterBar`, `wireSectionCheckbox`, `renderRemotes`, `renderRemoteRow` (and any now-unused imports).

- [ ] **Step 3: Sidebar**

```ts
  private renderSidebar(shell: HTMLElement): void {
    const side = shell.createDiv({ cls: "config-sync-side" });
    side.createDiv({ cls: "config-sync-side-head", text: "This device ↔ store" });

    const deviceEntry = (cat: ItemCategory | "all", label: string, statuses: GroupStatus[]): void => {
      const active = this.scope.kind === "device" && this.scope.cat === cat;
      const item = side.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      const c = bucketCounts(statuses);
      if (c.up > 0) item.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) item.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
      if (c.ok > 0) item.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) item.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
      item.addEventListener("click", () => {
        this.scope = { kind: "device", cat };
        this.render(this.renderGen);
      });
    };

    deviceEntry("all", "All items", this.rows().map((r) => r.status));
    for (const cat of CATEGORY_ORDER) {
      const inCat = this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, CATEGORY_LABELS[cat], inCat.map((r) => r.status));
    }

    const remotes = this.host.remotes();
    if (remotes.length === 0) return;
    let newestCheck: number | null = null;
    for (const remote of remotes) {
      const c = this.host.remoteCheck(remote.name);
      if (c !== undefined && (newestCheck === null || c.at > newestCheck)) newestCheck = c.at;
    }
    const head = side.createDiv({ cls: "config-sync-side-head config-sync-side-head-remotes" });
    head.createSpan({ text: `Remotes · checked ${newestCheck === null ? "never" : relativeAge(newestCheck)}` });
    const refresh = new ExtraButtonComponent(head);
    refresh.setIcon("refresh-cw");
    refresh.setTooltip("Re-check remotes");
    refresh.onClick(async () => {
      await this.host.refreshRemoteChecks();
      this.render(this.renderGen);
    });
    for (const remote of remotes) {
      const active = this.scope.kind === "remote" && this.scope.name === remote.name;
      const item = side.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: remote.name });
      const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
      item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
      item.addEventListener("click", () => {
        this.scope = { kind: "remote", name: remote.name };
        this.render(this.renderGen);
      });
    }
  }
```

(`ExtraButtonComponent`'s `onClick` accepts the async arrow here the same way the old `renderRemotes` did — keep that exact pattern. `GroupStatus` is already imported.)

- [ ] **Step 4: Item mode**

```ts
  private scopeKey(): string {
    return this.scope.kind === "device" ? this.scope.cat : `remote:${this.scope.name}`;
  }

  private scopedRows(): StatusRow[] {
    if (this.scope.kind !== "device" || this.scope.cat === "all") return this.rows();
    const cat = this.scope.cat;
    return this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    const scoped = this.scopedRows();
    const counts = bucketCounts(scoped.map((r) => r.status));

    const bar = main.createDiv({ cls: "config-sync-mainbar" });
    const defs: { key: PanelFilter; label: string }[] = [
      { key: "all", label: `All ${scoped.length}` },
      { key: "capture", label: `To capture ${counts.up}` },
      { key: "apply", label: `To apply ${counts.down}` },
      { key: "ok", label: `In sync ${counts.ok}` },
      { key: "none", label: `No settings yet ${counts.none}` },
    ];
    for (const d of defs) {
      const pill = bar.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, text: d.label });
      pill.addEventListener("click", () => {
        this.filter = d.key;
        this.render(this.renderGen);
      });
    }
    const searchEl = bar.createEl("input", {
      type: "search",
      cls: "config-sync-search",
      attr: { placeholder: "Filter by name…" },
    });
    searchEl.value = this.search;
    searchEl.addEventListener("input", () => {
      this.search = searchEl.value;
      this.renderListInto(listHost, scoped); // re-render only the list; keeps the input focused
    });
    const selectAll = bar.createEl("input", { type: "checkbox", attr: { "aria-label": "Select all visible items" } });

    const listHost = main.createDiv();
    this.renderListInto(listHost, scoped);
    this.wireGlobalSelectAll(selectAll, scoped);

    this.renderActionBar(main);
  }

  private visibleRows(scoped: StatusRow[]): StatusRow[] {
    return scoped.filter((r) => visibleUnderFilter(r.status.state, this.filter) && matchesSearch(r.group.name, this.search));
  }

  private renderListInto(listHost: HTMLElement, scoped: StatusRow[]): void {
    listHost.empty();
    const card = listHost.createDiv({ cls: "config-sync-card" });
    const visible = this.visibleRows(scoped);
    const searching = this.search.trim() !== "";
    if (this.filter === "all" && !searching) {
      const active = visible.filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings");
      const insync = visible.filter((r) => r.status.state === "in-sync");
      const nosettings = visible.filter((r) => r.status.state === "no-settings");
      for (const r of active) this.renderItemRow(card, r);
      this.renderTrailingLine(card, insync, sessionUi.insyncOpen, (n, open) => insyncLineText(n, open));
      this.renderTrailingLine(card, nosettings, sessionUi.nosettingsOpen, (n, open) => nosettingsLineText(n, open));
    } else {
      for (const r of visible) this.renderItemRow(card, r);
    }
  }

  // ✓ / ○ rows fold into one dim line per scope; searching bypasses the fold entirely.
  private renderTrailingLine(card: HTMLElement, rows: StatusRow[], openSet: Set<string>, text: (n: number, open: boolean) => string): void {
    if (rows.length === 0) return;
    const key = this.scopeKey();
    const open = openSet.has(key);
    const line = card.createDiv({ cls: "config-sync-unchanged", text: text(rows.length, open) });
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open) openSet.delete(key);
      else openSet.add(key);
      this.render(this.renderGen);
    });
    if (open) for (const r of rows) this.renderItemRow(card, r);
  }

  // Tri-state select-all over the currently visible checkable rows.
  private wireGlobalSelectAll(box: HTMLInputElement, scoped: StatusRow[]): void {
    const checkable = this.visibleRows(scoped)
      .filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings")
      .map((r) => r.group.name);
    const selectedCount = checkable.filter((n) => this.selected.has(n)).length;
    if (checkable.length === 0) {
      box.disabled = true;
      box.checked = false;
    } else if (selectedCount === checkable.length) {
      box.checked = true;
    } else if (selectedCount === 0) {
      box.checked = false;
    } else {
      box.indeterminate = true;
    }
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const turnOn = checkable.some((n) => !this.selected.has(n));
      for (const name of checkable) {
        if (turnOn) this.selected.add(name);
        else this.selected.delete(name);
      }
      this.render(this.renderGen);
    });
  }
```

Note on `renderListInto` during search input: it intentionally re-renders only the list (not the whole modal) so the search box keeps focus; pill counts and select-all state refresh on the next full render. Also update `renderActionBar`'s container class: it now attaches to the main pane (add cls `config-sync-footer` alongside the existing `config-sync-actionbar` if the CSS needs a hook — reuse the existing class as-is otherwise).

- [ ] **Step 5: Remote mode**

```ts
  private renderRemoteMode(main: HTMLElement, remote: Remote): void {
    const check = this.host.remoteCheck(remote.name)?.check;
    const icon = this.remoteIcon(check);
    main.createDiv({
      cls: "config-sync-remote-head",
      text: `${remote.name} · captured ${isoAge(check?.remoteCapturedAt ?? null)} — ${icon.tip}`,
    });
    const detail = main.createDiv({ cls: "config-sync-report-files config-sync-remote-pane" });
    void this.renderRemoteDetail(detail, remote, check);
  }
```

In `renderRemoteDetail`, the two mid-flight guards (~lines 499 and 504) currently read:

```ts
    if (gen !== this.renderGen || !this.expandedRemotes.has(remote.name)) return;
```

Replace both with:

```ts
    if (gen !== this.renderGen || this.scope.kind !== "remote" || this.scope.name !== remote.name) return;
```

`renderRemoteButtons` and `renderRemoteDiffEntry` stay as-is.

- [ ] **Step 6: CSS**

Add to `styles.css` (and DELETE the now-orphaned `.config-sync-macro`, `.config-sync-macro-head`, `.config-sync-sect` layout rules — grep for remaining uses first; `.config-sync-sect` is still used by `renderRemoteDetail`'s category labels and `ReportModal`, so KEEP `.config-sync-sect` itself and delete only `.config-sync-macro > .config-sync-sect { cursor: pointer; }` and the `.config-sync-sect input[type="checkbox"]` blocks):

```css
.modal.config-sync-wide { width: 920px; max-width: 95vw; }

.config-sync-shell { display: grid; grid-template-columns: minmax(150px, 22%) minmax(0, 1fr); gap: var(--size-4-3); }

.config-sync-side { display: flex; flex-direction: column; gap: 3px; }

.config-sync-side-head { font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); padding: var(--size-4-1) 4px; display: flex; align-items: center; gap: var(--size-4-1); }

.config-sync-side-head-remotes { margin-top: var(--size-4-2); }

.config-sync-side-item { display: flex; align-items: center; gap: 5px; padding: 6px 9px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-size: var(--font-ui-small); }

.config-sync-side-item.is-active { background: rgba(var(--color-purple-rgb), 0.14); border-color: rgba(var(--color-purple-rgb), 0.4); color: var(--text-normal); }

.config-sync-side-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.config-sync-side-badge { font-size: 10px; border-radius: 8px; padding: 0 5px; flex: none; }

.config-sync-side-badge.is-up { background: rgba(var(--color-orange-rgb), 0.15); color: var(--color-orange); }

.config-sync-side-badge.is-down { background: rgba(var(--color-purple-rgb), 0.15); color: var(--color-purple); }

.config-sync-side-badge.is-ok { background: rgba(var(--color-green-rgb), 0.15); color: var(--color-green); }

.config-sync-side-badge.is-none { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }

.config-sync-main { display: flex; flex-direction: column; min-width: 0; }

.config-sync-mainbar { display: flex; align-items: center; gap: var(--size-4-1); padding-bottom: var(--size-4-2); flex-wrap: wrap; }

.config-sync-search { margin-left: auto; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 2px 8px; font-size: var(--font-ui-smaller); width: 140px; }

.config-sync-remote-head { color: var(--text-muted); font-size: var(--font-ui-small); padding-bottom: var(--size-4-2); }

@media (max-width: 700px) {
  .config-sync-shell { grid-template-columns: 1fr; }
  .config-sync-side { flex-direction: row; flex-wrap: wrap; }
  .config-sync-side-head { width: 100%; }
}
```

Style the mainbar select-all with the existing custom-checkbox rules: extend the `.config-sync-hub-row input[type="checkbox"]` selector list to include `.config-sync-mainbar input[type="checkbox"]`, and carry over the checked/indeterminate gray fills that previously lived under `.config-sync-sect input[type="checkbox"]` as `.config-sync-mainbar input[type="checkbox"]:checked` / `:indeterminate` (same declarations).

- [ ] **Step 7: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: tests pass, build clean, 0 lint errors (unused-import errors are the usual failure — remove every import the deleted methods no longer need).

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "feat: two-pane wide panel with scope sidebar, flat list, search, and remote mode"
```

---

### Task 4: Live smoke + screenshot refresh

**Files:**
- Modify: `docs/assets/sync-panel.png`

- [ ] **Step 1: Install + reload** (guard first, standalone). `npm run smoke:install`, reload plugin via eval.
- [ ] **Step 2: Stage mixed states** (backup first, as in prior smokes): one ↑, one ↓, one ≠, one — (new group with local file), one ○ (new group with no files), plus the existing ✓ rows. Add a vault-type remote pointing at a scratch copy of the store with one changed file.
- [ ] **Step 3: Verify** (guard per batch; DOM dumps + screenshots):
  1. Segment staging: expand the ≠ row → click `↓ Apply store` → checkbox purple, footer `1 staged` / `↓ Apply 1 item`; click `↑ Capture` on the same row → checkbox orange, counts move to Capture; click the active segment → unstaged. Nothing executes until the footer button.
  2. Footer execute: `↓ Apply N items` runs the normal confirm/report flow.
  3. Sidebar: All/category scoping (pill counts change to scope, title pills stay global); staged selections persist across scope switches; remote entry click → right pane deep diff + Pull/Push; back to All items.
  4. Search: typing narrows rows live without losing input focus; collapse lines bypassed while searching; clearing restores.
  5. Select-all tri-state on visible rows (scope + filter + search respected).
  6. ✓ and ○ trailing lines fold/flatten per scope, remembered within the session.
  7. Layout: 920px two-pane screenshot vs gallery mockup; narrow window (<700px) collapses to single column with sidebar chips.
- [ ] **Step 4: Refresh `docs/assets/sync-panel.png`** with a representative two-pane frame (MD5 double-take; NBSP-safe copy).
- [ ] **Step 5: Clean up** staging + remote config, confirm all in-sync, `dev:errors` clean. Commit:

```bash
git add docs/assets/sync-panel.png
git commit -m "docs: refresh sync panel screenshot for the two-pane layout"
```

---

## Verification after all tasks

1. Full gate. `grep -n "renderMiniActions\|sectionCollapsed\|expandedRemotes\|remotesEl\|renderDeviceMacro\|renderRemotes\b" src/ui/SyncModal.ts` → no matches.
2. `grep -n "config-sync-mini\|config-sync-macro" styles.css src/ -r` → no matches.
3. Smoke evidence in ledger: staging state machine, scope/search/select-all, remote mode, narrow fallback.
