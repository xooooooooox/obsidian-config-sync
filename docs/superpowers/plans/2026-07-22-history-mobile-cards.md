# History Mobile Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On narrow screens the Sync Center History renders as a vertical card list with zero horizontal scroll; the desktop table is unchanged.

**Architecture:** Reuse the view's existing `this.compact` flag (`width < 700`, `ResizeObserver`-driven). Split the History header/legend out of `renderHistoryTable` so both layouts share them, extract the action-cell painter so table and card speak one vocabulary, then branch the body: `compact ? renderHistoryCards : renderHistoryTable`. Card styling is added to the plugin's `styles.css` reusing existing design tokens.

**Tech Stack:** TypeScript (strict), Obsidian API (`ItemView`, `setIcon`), esbuild build, ESLint, Vitest (pure-logic only — not used here). No new dependencies.

## Global Constraints

- **View-local only** — no additions to the `SettingsHost` interface. All state used (`this.compact`, `this.history`, `this.historyOpen`, `actionCell`, `formatRunTime`, `statusIcon`, `statusTip`, `STATUS_CLS`, `ACTION_ICON`, `ACTION_COLOR_CLASS`, `setIcon`) already exists on/around the view.
- **Desktop table untouched** — not-compact (≥700px) output must be byte-identical to today. `RunRecord`, history persistence, and the detail view (`renderHistoryDetail`) are not modified.
- **Issue pill only when `rec.issues > 0`** — no positive "no issues" pill.
- **No new responsive breakpoint** — reuse the `compact` flag and its existing re-render path.
- **TS strict + lint** — `npm run build` (tsc `-noEmit`) must pass; `npm run lint` must introduce no new errors above the current baseline of **67** warnings.
- **Do not commit `main.js`** — it is gitignored (`.gitignore:13`); the build artifact is never committed. Commit source only (`src/**`, `styles.css`).
- **Commit messages** — no Claude/AI attribution trailer of any kind.

**Reference spec:** `docs/superpowers/specs/2026-07-22-history-mobile-cards-design.md`
**定稿 mockup (session):** `history-mobile-mockup.html` (option A).

## File Structure

- Modify: `src/ui/SyncCenterView.ts` — restructure `renderHistoryMode`; extract `renderHistoryHead`, `renderHistoryLegend`, `renderActionInto`; slim `renderHistoryTable`; add `renderHistoryCards`.
- Modify: `styles.css` — add `.config-sync-hcard*` rules beside the existing `.config-sync-h*` block (~`:615-646`).

---

### Task 1: Extract shared head/legend + action painter (zero visual change)

Pure refactor. Desktop and mobile both still render the table; DOM output is identical to today. A reviewer can approve this as "clean extraction, no behavior change."

**Files:**
- Modify: `src/ui/SyncCenterView.ts:975-1035` (`renderHistoryMode` + `renderHistoryTable`)

**Interfaces:**
- Consumes (already present): `this.history`, `this.historyOpen`, `this.host.clearRunHistory()`, `this.render(this.renderGen)`, `this.actionCell(rec)`, `this.statusIcon`, `this.statusTip`, `formatRunTime`, `STATUS_CLS`, `ACTION_ICON`, `ACTION_COLOR_CLASS`, `setIcon`, `RunRecord`.
- Produces (used by Task 2): `renderHistoryHead(main: HTMLElement): void`, `renderHistoryLegend(main: HTMLElement): void`, `renderActionInto(el: HTMLElement, rec: RunRecord): void`.

- [ ] **Step 1: Replace `renderHistoryMode` (`:975-983`) with the head/legend/branch structure**

```ts
  private renderHistoryMode(main: HTMLElement): void {
    const open = this.historyOpen !== null ? this.history[this.historyOpen] : undefined;
    if (open !== undefined) {
      this.renderHistoryDetail(main, open);
      return;
    }
    this.historyOpen = null;
    this.renderHistoryHead(main);
    if (this.history.length === 0) {
      main.createDiv({ cls: "config-sync-hempty", text: "No runs recorded yet." });
      return;
    }
    this.renderHistoryLegend(main);
    this.renderHistoryTable(main);
  }

  private renderHistoryHead(main: HTMLElement): void {
    const head = main.createDiv({ cls: "config-sync-hhead" });
    head.createSpan({ cls: "config-sync-hhead-title", text: "History" });
    head.createSpan({ cls: "config-sync-hhead-count", text: `${this.history.length} run${this.history.length === 1 ? "" : "s"}` });
    if (this.history.length > 0) {
      const clear = head.createSpan({ cls: "config-sync-hclear", text: "Clear all" });
      clear.addEventListener("click", () => {
        void (async () => {
          await this.host.clearRunHistory();
          this.history = [];
          this.render(this.renderGen);
        })();
      });
    }
  }

  private renderHistoryLegend(main: HTMLElement): void {
    const legend = main.createDiv({ cls: "config-sync-hlegend" });
    const leg = (cls: string, glyph: string, text: string): void => {
      const s = legend.createSpan();
      s.createSpan({ cls: `config-sync-hstat ${cls}`, text: glyph });
      s.appendText(` ${text}`);
    };
    leg("is-ok", "✓", "Done"); leg("is-warn", "⚠", "Action needed"); leg("is-error", "✗", "Failed");
  }

  private renderActionInto(el: HTMLElement, rec: RunRecord): void {
    const act = this.actionCell(rec);
    if (act.action !== undefined) setIcon(el.createSpan({ cls: `config-sync-hglyph ${ACTION_COLOR_CLASS[act.action]}` }), ACTION_ICON[act.action]);
    else el.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
    el.appendText(` ${act.label}`);
  }
```

- [ ] **Step 2: Slim `renderHistoryTable` (`:985-1035`) down to just the table body**

Remove the head/count/`Clear all`, empty-state, and legend lines (now in the shared helpers) and route the action cell through `renderActionInto`:

```ts
  private renderHistoryTable(main: HTMLElement): void {
    const table = main.createEl("table", { cls: "config-sync-htable" });
    const thead = table.createEl("thead").createEl("tr");
    for (const h of ["", "When", "Action", "Changed", "Issues", "Summary", ""]) thead.createEl("th", { text: h });
    const body = table.createEl("tbody");
    this.history.forEach((rec, i) => {
      const tr = body.createEl("tr", { cls: "config-sync-hrow" });
      const st = this.statusTip(rec.status);
      tr.createEl("td", { cls: "config-sync-htd-st" }).createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status), attr: { "aria-label": st } });
      tr.createEl("td", { cls: "config-sync-htd-when", text: formatRunTime(rec.at) });
      this.renderActionInto(tr.createEl("td", { cls: "config-sync-htd-act" }), rec);
      tr.createEl("td", { cls: "config-sync-htd-num", text: `${rec.changed}` });
      const iss = tr.createEl("td", { cls: `config-sync-htd-num${rec.issues > 0 ? " is-issues" : ""}` });
      iss.setText(rec.issues > 0 ? `${rec.issues}` : "—");
      tr.createEl("td", { cls: "config-sync-htd-sum", text: rec.desc });
      tr.createEl("td", { cls: "config-sync-htd-chev", text: "›" });
      tr.addEventListener("click", () => {
        this.historyOpen = i;
        this.render(this.renderGen);
      });
    });
  }
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run build`
Expected: PASS — no TS errors (tsc `-noEmit -skipLibCheck`), esbuild writes `main.js`.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no new errors introduced by `SyncCenterView.ts` (compare against the pre-change baseline).

- [ ] **Step 5: Visual regression — table unchanged**

Run: `npm run smoke:install`
Then in Obsidian (`dev/vault`), open Sync Center → History with the leaf **wide** (≥700px). Expected: identical 7-column table — title, count, `Clear all`, legend, rows, chevrons all as before; clicking a row opens detail; `Clear all` empties it.

- [ ] **Step 6: Commit**

```bash
git add src/ui/SyncCenterView.ts
git commit -m "refactor(sync-center): extract history head/legend + action painter"
```

---

### Task 2: Add compact card layout + CSS

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`renderHistoryMode` branch + new `renderHistoryCards`)
- Modify: `styles.css` (add `.config-sync-hcard*` after `.config-sync-hddesc`, `:646`)

**Interfaces:**
- Consumes: `renderHistoryHead`, `renderHistoryLegend`, `renderActionInto` (Task 1); `this.compact`, `this.history`, `this.historyOpen`, `this.statusIcon`, `this.statusTip`, `formatRunTime`, `STATUS_CLS`, `this.render(this.renderGen)`.
- Produces: `renderHistoryCards(main: HTMLElement): void`.

- [ ] **Step 1: Branch the body on `this.compact` in `renderHistoryMode`**

Replace the single `this.renderHistoryTable(main);` line (last line of the non-empty path) with:

```ts
    if (this.compact) this.renderHistoryCards(main);
    else this.renderHistoryTable(main);
```

- [ ] **Step 2: Add `renderHistoryCards` (beside `renderHistoryTable`)**

```ts
  private renderHistoryCards(main: HTMLElement): void {
    this.history.forEach((rec, i) => {
      const card = main.createDiv({ cls: "config-sync-hcard" });
      const top = card.createDiv({ cls: "config-sync-hcard-top" });
      top.createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status), attr: { "aria-label": this.statusTip(rec.status) } });
      this.renderActionInto(top.createSpan({ cls: "config-sync-hcard-act" }), rec);
      top.createSpan({ cls: "config-sync-hcard-chev", text: "›" });
      card.createDiv({ cls: "config-sync-hcard-when", text: formatRunTime(rec.at) });
      card.createDiv({ cls: "config-sync-hcard-sum", text: rec.desc });
      const foot = card.createDiv({ cls: "config-sync-hcard-foot" });
      foot.createSpan({ cls: "config-sync-hcard-pill is-chg", text: `✎ ${rec.changed} changed` });
      if (rec.issues > 0)
        foot.createSpan({ cls: "config-sync-hcard-pill is-iss", text: `⚠ ${rec.issues} issue${rec.issues === 1 ? "" : "s"}` });
      card.addEventListener("click", () => {
        this.historyOpen = i;
        this.render(this.renderGen);
      });
    });
  }
```

- [ ] **Step 3: Add card CSS to `styles.css` (after `.config-sync-hddesc`, `:646`)**

```css
/* ── Run history — compact card layout (narrow screens) ──────────────────── */
.config-sync-hcard { border: 1px solid var(--background-modifier-border); background: var(--background-secondary); border-radius: var(--radius-m); padding: 11px 12px; margin-bottom: var(--size-4-2); cursor: pointer; }
.config-sync-hcard:hover { background: var(--background-modifier-hover); }
.config-sync-hcard-top { display: flex; align-items: center; gap: var(--size-4-2); }
.config-sync-hcard-act { flex: 1; min-width: 0; font-weight: var(--font-semibold); display: inline-flex; align-items: center; gap: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-sync-hcard-chev { margin-left: auto; color: var(--text-faint); font-size: var(--font-ui-medium); flex: none; }
.config-sync-hcard-when { font-family: var(--font-monospace); color: var(--text-faint); font-size: var(--font-ui-smaller); margin: 3px 0 6px; }
.config-sync-hcard-sum { color: var(--text-muted); font-size: var(--font-ui-small); margin-bottom: 9px; }
.config-sync-hcard-foot { display: flex; flex-wrap: wrap; gap: var(--size-4-2); }
.config-sync-hcard-pill { font-size: var(--font-ui-smaller); padding: 1px 8px; border-radius: 999px; }
.config-sync-hcard-pill.is-chg { background: var(--background-modifier-hover); color: var(--text-muted); }
.config-sync-hcard-pill.is-iss { background: rgba(var(--color-orange-rgb), 0.14); color: var(--color-orange); }
```

Note: `.config-sync-hcard-sum` deliberately has no `white-space: nowrap` — wrapping is what unclips the summary. `.config-sync-hglyph.is-in/.is-out/.is-remove` (`:632-634`) are reused by the card top row via `renderActionInto`; no new glyph colors.

- [ ] **Step 4: Typecheck + build**

Run: `npm run build`
Expected: PASS — no TS errors.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors introduced by `SyncCenterView.ts`.

- [ ] **Step 6: Visual check — cards on narrow, table on wide**

Run: `npm run smoke:install`
Then in Obsidian (`dev/vault`), open Sync Center → History and drag the leaf **narrow** (`<700px`, or use a mobile emulator / real phone). Expected:
  - Card list, **no horizontal scroll**; long remote names and multi-line summaries fully visible.
  - Footer shows `✎ N changed` always; `⚠ N issue(s)` only on runs with issues; a clean run shows no issue pill.
  - Tapping a card opens the detail view; `‹ Back to history` returns to the cards.
  - `Clear all` and the empty-state ("No runs recorded yet.") still work.
  - Drag the leaf back **wide** (≥700px): layout swaps live to the 7-column table (existing `ResizeObserver` → `render`).

- [ ] **Step 7: Commit**

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(sync-center): card layout for history on narrow screens"
```

---

## Self-Review

**Spec coverage:**
- Compact-only swap, desktop table untouched → Task 2 Step 1 branch; Task 1 keeps table output identical (Step 5 gate). ✓
- Card anatomy (status · action+remote · chevron / when / wrapping summary / pills) → Task 2 Steps 2-3. ✓
- Issue pill only when `issues>0`, no positive pill → Task 2 Step 2 (`if (rec.issues > 0)`). ✓
- DRY: shared head/legend + `renderActionInto` → Task 1. ✓
- View-local, no `SettingsHost` change → no host edits in any task. ✓
- Detail view unchanged → not touched. ✓
- Reuse existing `compact`/re-render path → Task 2 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `renderHistoryHead`/`renderHistoryLegend`/`renderActionInto`/`renderHistoryCards` signatures are `(main|el|…): void` and referenced identically across tasks. `renderActionInto(el, rec)` used by both table (Task 1 Step 2) and card (Task 2 Step 2). `RunRecord` param type matches `actionCell(rec: RunRecord)`. ✓
