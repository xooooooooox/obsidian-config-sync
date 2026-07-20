# Diff "changed-only" collapse view

## Problem

The Sync Center diff (`renderDiffPanel`, `src/ui/diffView.ts`) renders every line of
the file, changed or not. For a large file only a couple of changed lines matter,
but the user must scroll the whole thing to find them. Add a **collapse view** that
shows changes plus a few context lines and folds long unchanged runs into a
`⋯ N unchanged lines ⋯` marker — like git's unified diff / Obsidian's native diff.
Approved 定稿 (approach A: global toggle, default collapsed, 3 context lines).

## Design

All three diff surfaces (item change diff, conflict modal, Config Sync self pane)
already share `renderDiffPanel(host, leftText, rightText, leftLabel, rightLabel, meta)`
which computes `diffLines(...)` → `DiffOp[]` and renders via `renderUnified`/
`renderSplit`. One change here covers all of them, in both unified and split views.

### 1. Collapse transform (pure)

New in `src/ui/diffView.ts`:

```ts
export type DiffRow = DiffOp | { kind: "gap"; count: number };

// Keeps every change and `context` common lines around each change; folds the remaining
// runs of common lines into a single gap row. A run shorter than `minGap` is shown inline
// rather than replaced by a same-height gap marker (no visual saving).
export function collapseUnchanged(ops: DiffOp[], context: number, minGap = 2): DiffRow[] {
  const shown = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== "common") {
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) shown[j] = true;
    }
  }
  const rows: DiffRow[] = [];
  let runStart = -1;
  let runLen = 0;
  const flush = (): void => {
    if (runLen === 0) return;
    if (runLen < minGap) for (let k = runStart; k < runStart + runLen; k++) rows.push(ops[k]!);
    else rows.push({ kind: "gap", count: runLen });
    runLen = 0;
  };
  for (let i = 0; i < ops.length; i++) {
    if (shown[i]) {
      flush();
      rows.push(ops[i]!);
    } else {
      if (runLen === 0) runStart = i;
      runLen++;
    }
  }
  flush();
  return rows;
}
```

Standard git semantics: a common line is shown iff it's within `context` of any
`del`/`ins`. This handles leading, trailing, and between-change runs uniformly.
`context = 3`.

### 2. Session preference + toggle

Add `let sessionDiffCollapse = true;` next to `sessionDiffView` (session-level, not
persisted, default **collapsed**). In `renderDiffPanel`, add a **Collapse ⇄ Full**
segmented toggle to the toolbar — on **both** mobile and desktop (the Unified/Split
toggle stays desktop-only; big files hurt most on mobile, so the collapse toggle
must be reachable there). Clicking re-renders, same pattern as the existing view
toggle.

### 3. Render gaps

`renderUnified`/`renderSplit` take `DiffRow[]` instead of `DiffOp[]`. In
`renderDiffPanel`'s `render()`:

```ts
const ops = diffLines(leftText, rightText);
if (ops === null) { /* existing "too large" message */ return; }
const rows: DiffRow[] = sessionDiffCollapse ? collapseUnchanged(ops, 3) : ops;
if (sessionDiffView === "unified" || Platform.isMobile) renderUnified(pane, rows, leftLabel, rightLabel);
else renderSplit(pane, rows, leftLabel, rightLabel);
```

In each renderer, a `gap` row renders one muted, dashed line
`⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋯` (class `config-sync-cm-dgap`);
a `DiffOp` row renders exactly as today. In split view a gap spans both panes (one
gap row across the pair, or a gap line in each pane — a single full-width gap row is
cleaner).

`Full` mode passes `ops` straight through (no gaps) — byte-identical to today.

### 4. Styling

New `styles.css` rule `.config-sync-cm-dgap`: muted (`--text-faint`), italic,
dashed top/bottom border (`--background-modifier-border`), faint background — all
theme vars, no hardcoded colors. Toggle buttons reuse the existing
`.config-sync-cm-viewseg`/`.config-sync-cm-viewbtn` classes.

## Testing

- **`tests/diffView.test.ts`** (new) — `collapseUnchanged` (pure):
  - changes near the top/bottom keep `context` lines and fold the far run into a gap
    with the exact remaining count;
  - a between-change run longer than `2*context` folds; one `≤ 2*context` does not;
  - a run shorter than `minGap` renders inline (no gap);
  - all-common input (no changes) → a single gap of the full length;
  - all-changed input → no gaps.
  Also a light `diffLines` sanity test (it's currently untested): a one-line change
  yields one `del` + one `ins` surrounded by `common`.
- Gates: `npm test`, `npx eslint .` 0/67, `./scripts/check-no-hardcoded-color.sh`,
  `npm run build` clean.
- Live (dev vault): open an item with a multi-line data.json diff; confirm the
  Collapse toggle folds long unchanged runs to `⋯ N unchanged lines ⋯` with 3 context
  lines around the change, Full shows everything, and the toggle appears on mobile
  (forced `is-mobile`) too. Screenshot for the 定稿 match.

## Non-goals

- No per-gap click-to-expand (approach B) — a later enhancement; gaps are static here.
- No persistence of the toggle (session-level, matching Unified/Split).
- No change to `diffLines`, the 2000-line cap, or the three call sites.
