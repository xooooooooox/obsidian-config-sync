import { setIcon } from "obsidian";

// The FOLD family's one glyph (DESIGN.md §2.4): every "expands in
// place" toggle across the app — Sync Center section heads, fold-group/self/item rows, the
// run-strip's `details`, the self pane's `view change`, the Settings tab's rule/remote rows and
// its member-disclosure arrow, the conflict modal, the report strip's per-result rows — must not
// render its own text triangle (`▸`/`▾`) or swap between `chevron-down`/
// `chevron-right`. Both are banned: one SVG `chevron-right`, rotated 90° via CSS
// (`.config-sync-row-chevron.is-open svg`) when open, so a fold's glyph is a pure function of one
// boolean and never a second icon name to keep in sync.
//
// `extraCls` lets a site keep its own class (`config-sync-cm-chev`, `config-sync-card-memberarrow`,
// …) for site-specific color/size alongside the shared rotation rule — pass `null` when the site
// has no class of its own beyond `config-sync-row-chevron`.
export function renderFoldChevron(parent: HTMLElement, open: boolean, extraCls: string | null): HTMLElement {
  const cls = extraCls === null ? "config-sync-row-chevron" : `config-sync-row-chevron ${extraCls}`;
  const el = parent.createSpan({ cls });
  setIcon(el, "chevron-right");
  setFoldOpen(el, open);
  return el;
}

// Toggles a chevron `renderFoldChevron` already created between its open/closed rotation —
// click handlers call this (never setText("▾"/"▸")), so a fold's own
// open/closed state can update the glyph in place without a full re-render.
export function setFoldOpen(el: HTMLElement, open: boolean): void {
  el.toggleClass("is-open", open);
}
