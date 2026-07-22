# Sync Center History — card layout on narrow screens

## Problem

The Sync Center History (`SyncCenterView.renderHistoryTable`, `:985`) is a
fixed 7-column HTML `<table>` — `["", "When", "Action", "Changed", "Issues",
"Summary", ""]` — with `white-space: nowrap` on every `th`/`td`
(`styles.css:626-627`). Seven non-wrapping columns cannot fit a phone width, so
on mobile the table is clipped and the user must scroll horizontally to read
`Issues` / `Summary`. Long `Action` labels (`Capture · <remote>`) push the rest
off-screen.

Goal: History reads top-to-bottom on a phone with **zero horizontal scroll**,
while the desktop table is left exactly as-is.

## Decision (定稿)

When the view is **compact** (`this.compact`, already `width < 700`,
`ResizeObserver`-driven at `:277`), render History as a **vertical card list**
instead of the table. Not-compact (desktop, ≥700px) keeps the 7-column table
untouched. The detail view (`renderHistoryDetail`, `:1037`) is already vertical
(flex header that wraps + stacked desc/report rows) and is unchanged.

定稿 mockup: `history-mobile-mockup.html` (option **A**, card list). Each run is
one card, clickable → opens the same detail as a table row (sets `historyOpen`).

Card anatomy (per `RunRecord`):

- **top row** — status glyph (`config-sync-hstat` + `STATUS_CLS[status]`) ·
  action icon + label (`Capture · <remote>`, via `actionCell`) · `›` chevron
  pushed to the right edge.
- **when** — `formatRunTime(rec.at)`, monospace + faint.
- **summary** — `rec.desc`, **wrapping** (no `nowrap`). This is what unclips the
  content.
- **footer pills** — always `✎ N changed`; the `⚠ N issue(s)` pill (orange)
  renders **only when `rec.issues > 0`**. Zero issues shows no pill — consistent
  with the table's `—` for a clean run. (No positive "no issues" pill.)

This is a **view-local** change — no host-interface (`SettingsHost`) additions.
`this.compact`, `this.history`, `actionCell`, `formatRunTime`, `statusIcon`,
`STATUS_CLS`, `ACTION_ICON`, `ACTION_COLOR_CLASS`, and `historyOpen` are all
already on the view.

## Architecture

### 1. Share the header/legend, branch the body (`SyncCenterView.ts`)

`renderHistoryMode` (`:975`) currently returns detail-or-table. Restructure so
the head and legend are built once and only the body branches:

- Extract `renderHistoryHead(main)` — the `config-sync-hhead` block
  (title · count · *Clear all*) plus the empty-state (`config-sync-hempty`,
  return-early) currently inline at `:986-1002`.
- Extract `renderHistoryLegend(main)` — the `is-ok/is-warn/is-error` legend at
  `:1003-1009`. Still meaningful for cards (status glyph sits on each card).
- `renderHistoryMode`: if `historyOpen` → detail (unchanged); else
  `renderHistoryHead`; if empty, stop; `renderHistoryLegend`; then
  `this.compact ? renderHistoryCards(main) : renderHistoryTable(main)`.

`renderHistoryTable` keeps only the `<table>` build (`:1011-1034`); its own
head/legend/empty lines move into the shared helpers.

### 2. Extract the action-cell render (`SyncCenterView.ts`)

The four inline lines that paint the action glyph/icon + label
(`:1020-1024`) are duplicated verbatim by the card top row. Extract:

```ts
// Paints "<icon> <label>" for a run into `el`; shared by the history table
// cell and the compact card so both speak one action vocabulary.
private renderActionInto(el: HTMLElement, rec: RunRecord): void {
  const act = this.actionCell(rec);
  if (act.action !== undefined)
    setIcon(el.createSpan({ cls: `config-sync-hglyph ${ACTION_COLOR_CLASS[act.action]}` }), ACTION_ICON[act.action]);
  else
    el.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
  el.appendText(` ${act.label}`);
}
```

The table's `td.config-sync-htd-act` and the card's `config-sync-hcard-act`
both call it.

### 3. New `renderHistoryCards(main)` (`SyncCenterView.ts`)

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
    card.addEventListener("click", () => { this.historyOpen = i; this.render(this.renderGen); });
  });
}
```

### 4. Card CSS (plugin `styles.css`, beside the `.config-sync-h*` block ~`:615`)

Reuse existing tokens (`--background-secondary`, `--background-modifier-border`,
`--text-muted/faint`, `--color-orange`, `--radius-*`, `--font-ui-*`). Sketch:

- `.config-sync-hcard` — border + `--background-secondary`, radius, padding,
  `margin-bottom`, `cursor: pointer`; `:hover` → `--background-modifier-hover`.
- `.config-sync-hcard-top` — `display:flex; align-items:center; gap`.
- `.config-sync-hcard-act` — `flex:1; min-width:0` (lets the chevron stay put;
  label may ellipsize while summary carries the full text).
- `.config-sync-hcard-chev` — `margin-left:auto; color:var(--text-faint)`.
- `.config-sync-hcard-when` — mono, faint, `--font-ui-smaller`.
- `.config-sync-hcard-sum` — `color:var(--text-muted)`; **wraps** (no `nowrap`).
- `.config-sync-hcard-foot` — `display:flex; flex-wrap:wrap; gap`.
- `.config-sync-hcard-pill` — small radius pill; `.is-chg` neutral
  (`--background-modifier-hover` / muted), `.is-iss` orange
  (`rgba(var(--color-orange-rgb),0.14)` + `--color-orange`).
- `.config-sync-hglyph.is-in/.is-out/.is-remove` already exist (`:632-634`) and
  are reused by the card top row via the shared helper — no new glyph colors.

## Non-goals

- No change to the desktop table, the detail view, `RunRecord`, or history
  persistence.
- No new responsive breakpoint — reuse the existing `compact` flag and its
  re-render path.
- No positive "no issues" pill.

## Verification

- Desktop (≥700px): History unchanged — 7-column table.
- Narrow (<700px, mobile or dragged-narrow desktop leaf): cards, no horizontal
  scroll; long remote names and multi-line summaries fully visible; tapping a
  card opens detail; *Clear all* and empty-state still work.
- Drag the leaf across the 700px boundary: layout swaps live (existing
  `ResizeObserver` → `render`).
