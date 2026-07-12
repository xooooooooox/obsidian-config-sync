# Panel Scale & Expanded-Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Sync panel usable at 60+ items (filter pills, collapsible sections, in-sync collapse lines) and make every expanded row show content, including per-item counter-direction actions.

**Architecture:** Pure view-model helpers go in a new DOM-free module `src/ui/panelModel.ts` (vitest-testable). All rendering changes live in `src/ui/SyncModal.ts` + `styles.css`. Core (`src/core/*`), counting model (`bucketCounts`), pre-check defaults, commands, ribbon, and the Remotes macro are untouched.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, obsidian-cli for live verification.

**Spec:** `docs/superpowers/specs/2026-07-12-panel-scale-design.md`. Visual ground truth: `.superpowers/brainstorm/9047-1783841141/content/iter16-final-gallery.html`.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/ui/panelModel.ts` must import nothing from `obsidian` and touch no DOM (vitest runs in node).
- Buckets (from existing `bucketCounts`): capture = `local-changed` + `not-captured`; apply = `store-newer` + `differs`; ok = `in-sync`.
- Copy strings verbatim (from the spec): `All {n}` / `To capture {n}` / `To apply {n}` / `In sync {n}`; `✓ {n} item in sync ▸` / `✓ {n} items in sync ▸` (`▾` when open); `↑ Capture this (keep local)`; `↓ Apply store version (overwrites local)`; `… {n} more files ▸`; `not captured yet — nothing in the store`; `identical to the store`.
- File-list cap: 10 entries, order added → updated → deleted.
- Filtering changes row visibility only — section-head pills, title pills, and action-bar counts always reflect the full set. Filter resets to `All` on every panel open.
- Section collapse and in-sync-line open state are remembered for the app session in module-scoped state in `SyncModal.ts`; filter is NOT remembered.
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read the output, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait 6 s, re-check. NEVER chain the guard with `&&`.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: `panelModel.ts` pure helpers

**Files:**
- Create: `src/ui/panelModel.ts`
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `GroupState` from `src/core/status`, `FileChanges` from `src/core/types`.
- Produces (used verbatim by Tasks 2–3):
  - `export type PanelFilter = "all" | "capture" | "apply" | "ok"`
  - `export function visibleUnderFilter(state: GroupState, filter: PanelFilter): boolean`
  - `export interface CappedEntry { kind: "add" | "upd" | "del"; name: string }`
  - `export function capFileEntries(changes: FileChanges, limit: number): { shown: CappedEntry[]; rest: CappedEntry[] }`
  - `export function insyncLineText(n: number, open: boolean): string`
  - `export function moreFilesText(n: number): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/panelModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, moreFilesText, visibleUnderFilter } from "../src/ui/panelModel";
import { GroupState } from "../src/core/status";

describe("visibleUnderFilter", () => {
  it("all shows every state", () => {
    const states: GroupState[] = ["in-sync", "local-changed", "store-newer", "differs", "not-captured"];
    for (const s of states) expect(visibleUnderFilter(s, "all")).toBe(true);
  });

  it("capture shows local-changed and not-captured only", () => {
    expect(visibleUnderFilter("local-changed", "capture")).toBe(true);
    expect(visibleUnderFilter("not-captured", "capture")).toBe(true);
    expect(visibleUnderFilter("store-newer", "capture")).toBe(false);
    expect(visibleUnderFilter("differs", "capture")).toBe(false);
    expect(visibleUnderFilter("in-sync", "capture")).toBe(false);
  });

  it("apply shows store-newer and differs only", () => {
    expect(visibleUnderFilter("store-newer", "apply")).toBe(true);
    expect(visibleUnderFilter("differs", "apply")).toBe(true);
    expect(visibleUnderFilter("local-changed", "apply")).toBe(false);
    expect(visibleUnderFilter("in-sync", "apply")).toBe(false);
  });

  it("ok shows in-sync only", () => {
    expect(visibleUnderFilter("in-sync", "ok")).toBe(true);
    expect(visibleUnderFilter("local-changed", "ok")).toBe(false);
  });
});

describe("capFileEntries", () => {
  it("orders added, updated, deleted and splits at the limit", () => {
    const changes = {
      added: ["a1", "a2"],
      updated: ["u1", "u2", "u3"],
      deleted: ["d1"],
    };
    const { shown, rest } = capFileEntries(changes, 4);
    expect(shown).toEqual([
      { kind: "add", name: "a1" },
      { kind: "add", name: "a2" },
      { kind: "upd", name: "u1" },
      { kind: "upd", name: "u2" },
    ]);
    expect(rest).toEqual([
      { kind: "upd", name: "u3" },
      { kind: "del", name: "d1" },
    ]);
  });

  it("returns empty rest when under the limit", () => {
    const { shown, rest } = capFileEntries({ added: [], updated: ["u1"], deleted: [] }, 10);
    expect(shown).toEqual([{ kind: "upd", name: "u1" }]);
    expect(rest).toEqual([]);
  });
});

describe("copy strings", () => {
  it("in-sync line pluralizes and carries the chevron", () => {
    expect(insyncLineText(1, false)).toBe("✓ 1 item in sync ▸");
    expect(insyncLineText(2, false)).toBe("✓ 2 items in sync ▸");
    expect(insyncLineText(2, true)).toBe("✓ 2 items in sync ▾");
  });

  it("more-files line", () => {
    expect(moreFilesText(5)).toBe("… 5 more files ▸");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/panelModel.test.ts`
Expected: FAIL — cannot resolve `../src/ui/panelModel`.

- [ ] **Step 3: Implement**

Create `src/ui/panelModel.ts`:

```ts
import { GroupState } from "../core/status";
import { FileChanges } from "../core/types";

// Panel row filter. Buckets match core bucketCounts: capture = local-changed + not-captured,
// apply = store-newer + differs, ok = in-sync.
export type PanelFilter = "all" | "capture" | "apply" | "ok";

export function visibleUnderFilter(state: GroupState, filter: PanelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "capture") return state === "local-changed" || state === "not-captured";
  if (filter === "apply") return state === "store-newer" || state === "differs";
  return state === "in-sync";
}

export interface CappedEntry {
  kind: "add" | "upd" | "del";
  name: string;
}

// Flattens a change set (added → updated → deleted) and splits it at `limit`
// so the detail view can render `shown` plus a "… N more files ▸" line for `rest`.
export function capFileEntries(changes: FileChanges, limit: number): { shown: CappedEntry[]; rest: CappedEntry[] } {
  const all: CappedEntry[] = [
    ...changes.added.map((name): CappedEntry => ({ kind: "add", name })),
    ...changes.updated.map((name): CappedEntry => ({ kind: "upd", name })),
    ...changes.deleted.map((name): CappedEntry => ({ kind: "del", name })),
  ];
  return { shown: all.slice(0, limit), rest: all.slice(limit) };
}

export function insyncLineText(n: number, open: boolean): string {
  return `✓ ${n} item${n === 1 ? "" : "s"} in sync ${open ? "▾" : "▸"}`;
}

export function moreFilesText(n: number): string {
  return `… ${n} more files ▸`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/panelModel.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/ui/panelModel.ts tests/panelModel.test.ts
git commit -m "feat: pure view-model helpers for panel filtering and file-list capping"
```

---

### Task 2: Expanded row always has content

**Files:**
- Modify: `src/ui/SyncModal.ts` (renderItemRow ~lines 185-248), `styles.css`

**Interfaces:**
- Consumes: `capFileEntries`, `CappedEntry`, `moreFilesText` from `src/ui/panelModel` (Task 1); existing `SyncModalHost.captureItems/applyItems`.
- Produces: `private renderItemDetail(detail: HTMLElement, r: StatusRow): void` — Task 3's rewritten section renderer calls this exact method for every expanded row.

There are no DOM unit tests in this repo (vitest is node-only); this task is verified by build + the live smoke in Task 4. Copy strings are already covered by Task 1's tests.

- [ ] **Step 1: Replace `renderChangesInto` with state-driven detail rendering**

In `src/ui/SyncModal.ts`, delete the `renderChangesInto` method (lines 243-248) and the `differs` hint block inside `renderItemRow` (lines 211-214, the `config-sync-hub-hint` div). Change the detail wiring in `renderItemRow` from:

```ts
    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !this.expandedItems.has(group.name);
    this.renderChangesInto(detail, status.changes);
```

to:

```ts
    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !this.expandedItems.has(group.name);
    this.renderItemDetail(detail, r);
```

Add the new methods (import `capFileEntries`, `CappedEntry`, `moreFilesText` from `./panelModel`):

```ts
  // Expanded rows always show content: an error, a state note, or actions + the file diff.
  private renderItemDetail(detail: HTMLElement, r: StatusRow): void {
    const { group, status } = r;
    if (status.message !== undefined) {
      detail.createDiv({ cls: "config-sync-status-error", text: status.message });
      return;
    }
    if (status.state === "in-sync") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "identical to the store" });
      return;
    }
    if (status.state === "not-captured") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "not captured yet — nothing in the store" });
      return;
    }
    if (status.changes === undefined) return;
    this.renderMiniActions(detail, group.name);
    this.renderCappedChanges(detail, status.changes);
  }

  // Per-item counter-direction actions: run immediately for this one item, reusing the
  // host's normal capture/apply flows (confirm + report + reload prompt), then refresh.
  private renderMiniActions(detail: HTMLElement, name: string): void {
    const bar = detail.createDiv({ cls: "config-sync-mini-actions" });
    const cap = bar.createEl("button", { cls: "config-sync-mini is-capture", text: "↑ Capture this (keep local)" });
    cap.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.host.captureItems([name]);
      await this.reload();
    });
    const apply = bar.createEl("button", { cls: "config-sync-mini is-apply", text: "↓ Apply store version (overwrites local)" });
    apply.addEventListener("click", async (e) => {
      e.stopPropagation();
      await this.host.applyItems([name]);
      await this.reload();
    });
  }

  private renderCappedChanges(detail: HTMLElement, changes: FileChanges): void {
    const { shown, rest } = capFileEntries(changes, 10);
    const renderEntry = (e: CappedEntry): void => {
      const glyph = e.kind === "add" ? "+" : e.kind === "upd" ? "~" : "−";
      detail.createDiv({ cls: `is-${e.kind}`, text: `${glyph} ${e.name}` });
    };
    for (const e of shown) renderEntry(e);
    if (rest.length > 0) {
      const more = detail.createDiv({ cls: "config-sync-more-files", text: moreFilesText(rest.length) });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        more.remove();
        for (const entry of rest) renderEntry(entry);
      });
    }
  }
```

Note: `renderCappedChanges` appends the revealed entries to `detail` after removing the more-line, so they land in the right place (the more-line is the last child).

- [ ] **Step 2: Title / close-button avoidance + new CSS**

In `styles.css`:

Change line 241 from:

```css
.config-sync-panel-title { display: flex; align-items: center; gap: var(--size-4-2); }
```

to:

```css
.config-sync-panel-title { display: flex; align-items: center; gap: var(--size-4-2); padding-right: 28px; }
```

Delete the `.config-sync-hub-hint` rule (line ~360). Add:

```css
.config-sync-expand-note { color: var(--text-muted); font-size: var(--font-ui-smaller); font-style: italic; margin: 0 0 var(--size-4-1) 0; font-family: var(--font-interface); }

.config-sync-more-files { color: var(--text-muted); cursor: pointer; }

.config-sync-mini-actions { display: flex; gap: var(--size-4-2); flex-wrap: wrap; margin: 2px 0 var(--size-4-1) 0; font-family: var(--font-interface); }

.config-sync-mini { background: none; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 1px 8px; font-size: var(--font-ui-smaller); cursor: pointer; box-shadow: none; height: auto; }

.config-sync-mini.is-capture { color: var(--color-orange); }

.config-sync-mini.is-apply { color: var(--color-purple); }
```

(`.config-sync-report-files` is monospace; the note and mini-action rules reset to the interface font since they are prose/buttons, not file paths.)

- [ ] **Step 3: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: 135+ tests pass, build clean, 0 lint errors.

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "feat: expanded item rows always show content, with per-item counter-direction actions"
```

---

### Task 3: Filter pills, collapsible sections, in-sync collapse line

**Files:**
- Modify: `src/ui/SyncModal.ts` (`renderDeviceMacro` + `wireSectionCheckbox`, ~lines 137-183), `styles.css`

**Interfaces:**
- Consumes: `PanelFilter`, `visibleUnderFilter`, `insyncLineText` from `src/ui/panelModel` (Task 1); `renderItemDetail` via the existing `renderItemRow` (Task 2); existing `bucketCounts` from `src/core/status`.
- Produces: nothing consumed later.

- [ ] **Step 1: Session UI state + filter field**

At module scope in `src/ui/SyncModal.ts` (below the imports, near `CATEGORY_ORDER`):

```ts
// Session-remembered UI state (per spec: survives modal close, resets on plugin reload).
// undefined in sectionCollapsed = no explicit choice; default is "collapsed iff nothing actionable".
const sessionUi = {
  sectionCollapsed: new Map<ItemCategory, boolean>(),
  insyncOpen: new Set<ItemCategory>(),
};
```

Add an instance field to `SyncModal` (filter is per-open, so an instance field is the reset):

```ts
  private filter: PanelFilter = "all";
```

- [ ] **Step 2: Rewrite `renderDeviceMacro`**

Replace the whole method (lines 137-157) with:

```ts
  private renderDeviceMacro(): void {
    const macro = this.contentEl.createDiv({ cls: "config-sync-macro" });
    macro.createDiv({ cls: "config-sync-macro-head", text: "This device ↔ store" });
    this.renderFilterBar(macro);

    for (const cat of CATEGORY_ORDER) {
      const inCat = this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
      if (inCat.length === 0) continue;
      const visible = inCat.filter((r) => visibleUnderFilter(r.status.state, this.filter));
      if (visible.length === 0) continue;

      const counts = bucketCounts(inCat.map((r) => r.status));
      const collapsed = sessionUi.sectionCollapsed.get(cat) ?? (counts.up === 0 && counts.down === 0);

      const sect = macro.createDiv({ cls: "config-sync-sect" });
      sect.createSpan({ cls: "config-sync-row-chevron", text: collapsed ? "▸" : "▾" });
      sect.createSpan({ text: CATEGORY_LABELS[cat] });
      sect.createDiv({ cls: "config-sync-rule-spacer" });
      if (counts.up > 0) sect.createSpan({ cls: "config-sync-pill is-up", text: `↑ ${counts.up}` });
      if (counts.down > 0) sect.createSpan({ cls: "config-sync-pill is-down", text: `↓ ${counts.down}` });
      if (counts.ok > 0) sect.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${counts.ok}` });
      const boxCb = sect.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": `Select all ${CATEGORY_LABELS[cat]}` },
      });
      sect.addEventListener("click", () => {
        sessionUi.sectionCollapsed.set(cat, !collapsed);
        this.render(this.renderGen);
      });

      if (!collapsed) {
        const card = macro.createDiv({ cls: "config-sync-card" });
        if (this.filter === "all") {
          const active = visible.filter((r) => r.status.state !== "in-sync");
          const insync = visible.filter((r) => r.status.state === "in-sync");
          for (const r of active) this.renderItemRow(card, r);
          if (insync.length > 0) {
            const open = sessionUi.insyncOpen.has(cat);
            const line = card.createDiv({ cls: "config-sync-unchanged", text: insyncLineText(insync.length, open) });
            line.addEventListener("click", (e) => {
              e.stopPropagation();
              if (open) sessionUi.insyncOpen.delete(cat);
              else sessionUi.insyncOpen.add(cat);
              this.render(this.renderGen);
            });
            if (open) for (const r of insync) this.renderItemRow(card, r);
          }
        } else {
          for (const r of visible) this.renderItemRow(card, r);
        }
      }
      this.wireSectionCheckbox(boxCb, visible);
    }

    this.renderActionBar(macro);
  }

  private renderFilterBar(macro: HTMLElement): void {
    const counts = bucketCounts(this.rows().map((r) => r.status));
    const total = this.rows().length;
    const bar = macro.createDiv({ cls: "config-sync-filterbar" });
    const defs: { key: PanelFilter; label: string }[] = [
      { key: "all", label: `All ${total}` },
      { key: "capture", label: `To capture ${counts.up}` },
      { key: "apply", label: `To apply ${counts.down}` },
      { key: "ok", label: `In sync ${counts.ok}` },
    ];
    for (const d of defs) {
      const pill = bar.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, text: d.label });
      pill.addEventListener("click", () => {
        this.filter = d.key;
        this.render(this.renderGen);
      });
    }
  }
```

The section-head chevron needs no reference: the click handler re-renders the whole panel, which redraws it.

Imports at the top of the file gain: `PanelFilter`, `visibleUnderFilter`, `insyncLineText` from `./panelModel`.

Update `wireSectionCheckbox` (no signature change — it already takes the row list; it now receives the filter-visible rows, matching the spec "operates on the checkable rows visible under the current filter"). Inside it, `box.addEventListener("click", (e) => { e.stopPropagation(); ... })` already stops propagation, which now also prevents the section-head collapse toggle — required behavior, keep it.

Note the tri-state rules already handle the all-✓ default-collapsed section: its checkbox gets `disabled = true` because no checkable rows exist.

- [ ] **Step 3: CSS for filter pills**

Add to `styles.css` (near the `.config-sync-pill` rules):

```css
.config-sync-filterbar { display: flex; gap: var(--size-4-1); margin: 2px 0 var(--size-4-2) 0; flex-wrap: wrap; }

.config-sync-fpill { background: none; border: 1px solid var(--background-modifier-border); border-radius: 999px; padding: 2px 10px; font-size: var(--font-ui-smaller); color: var(--text-muted); cursor: pointer; box-shadow: none; height: auto; }

.config-sync-fpill.is-active { background: var(--interactive-accent); border-color: var(--interactive-accent); color: var(--text-on-accent); }

.config-sync-sect { cursor: pointer; }

.config-sync-sect .config-sync-pill { margin-right: var(--size-4-1); }
```

- [ ] **Step 4: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: all pass, 0 lint errors.

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "feat: filter pills, collapsible sections, and in-sync collapse lines in the sync panel"
```

---

### Task 4: Live smoke + screenshot refresh

**Files:**
- Modify: `docs/assets/sync-panel.png` (refresh — panel gained a filter bar)

No code changes; this task verifies Tasks 2-3 in the dev vault and refreshes the README screenshot.

- [ ] **Step 1: Install + reload (guard first)**

Run the vault-identity guard as its own command (see Global Constraints). Then `npm run smoke:install` and reload the plugin via obsidian-cli.

- [ ] **Step 2: Stage one row per state**

As in previous smokes: back up the dev vault's `config-sync.json` and staged files first, then arrange: one `local-changed` (touch a captured file locally), one `store-newer` (edit the store copy + backdate nothing — lock heuristic handles it), one `differs` (edit both / or rely on an errored group), one `not-captured` (tick a new item in settings), rest `in-sync`.

- [ ] **Step 3: Verify each spec behavior**

Guard first (own command), then via panel screenshots (Read tool on each):

1. Expand each staged row: ↑/↓/≠ rows show mini buttons THEN file list; — row shows `not captured yet — nothing in the store`; a ✓ row (via the in-sync line, expanded) shows `identical to the store`. No expanded row is empty.
2. Filter pills: click `To capture` — only ↑/— rows remain, all-✓ sections disappear, section-head pills and title pills unchanged; `All` restores.
3. Section collapse: click a section head — collapses to head + pills; reopen panel — state remembered.
4. In-sync line: shows `✓ N items in sync ▸`, click flattens.
5. Mini button: click `↑ Capture this (keep local)` on the ≠ row — report flow runs, row lands ✓ after refresh.
6. Title: pills do not underlap the ✕.
7. A dir group with >10 changed files (stage extra files under `snippets/` or `themes/`) shows 10 + `… N more files ▸`; click reveals the rest.

- [ ] **Step 4: Refresh README screenshot**

Capture the panel in a representative state (mixed sections, filter bar visible, one row expanded), crop as before, replace `docs/assets/sync-panel.png`. Verify the capture is fresh (MD5 double-take against the previous frame; temp screenshot paths contain non-breaking spaces — copy by mtime glob).

- [ ] **Step 5: Clean up + commit**

Restore the dev vault's original `config-sync.json` and staged files; verify all rows land in-sync. Then:

```bash
git add docs/assets/sync-panel.png
git commit -m "docs: refresh sync panel screenshot"
```

---

## Verification after all tasks

1. Full gate: `npm test && npm run build && npm run lint`.
2. Grep sanity: `grep -n "renderChangesInto\|config-sync-hub-hint" src/ styles.css -r` → no matches (both removed).
3. Smoke evidence in the task report: per-state expand screenshots, filter-pill before/after, mini-button capture landing ✓.
4. Ledger records iter16 completion.
