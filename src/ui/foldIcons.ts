import { setIcon } from "obsidian";

// The three trailing-fold states' icon vocabulary: fixed-size 12px Lucide icons, never
// text glyphs (✓ ○ ⊘) — text-glyph ink heights are unequal across themes (a font-fallback
// artifact); fixed-size SVG reads as optically equal instead. `ban` stays reserved for the
// Stop-syncing ACTION (itemCard.ts's stop-sync menu) — action and state never share an icon, so
// the "not synced on this device" STATE uses `circle-minus` (it was `circle-slash` until
// 2026-08-18: at this size a diagonal through a circle is the least legible mark in the set, and a
// horizontal bar says "taken out of this device's set" more plainly. Still a circle, so the trio
// below stays one family — and the merged control's own local glyph moved with it, since that is
// the same state said in a different place). `.config-sync-state-icon` (✓ ○ ≠ —
// ? key, a DIFFERENT, Statistic-workspace vocabulary) is untouched by this map and stays text —
// but a collapsed item ROW's own neutral (`—`-glyph) fate is NOT that column: per DESIGN.md §2.1
// (the authority for this ruling), the same FOLD_ICON/FOLD_ICON_COLOR_CLASS map is reused at
// the row's `config-sync-fate-ic` size for exactly that fate (SyncCenterView.ts's fateWrap and
// renderRemoteDiffEntry) — the fold vocabulary speaks at both the group-header line and the
// row it summarizes.
export type FoldKind = "insync" | "excluded" | "nosettings";

export const FOLD_ICON: Record<FoldKind, string> = {
  insync: "check",
  excluded: "circle-minus",
  nosettings: "circle",
};

// insync keeps its established green (parity with the row state column's own ✓); the other two
// stay muted, matching the fold line's own text color (no override needed).
export const FOLD_ICON_COLOR_CLASS: Record<FoldKind, string | null> = {
  insync: "is-ok",
  excluded: null,
  nosettings: null,
};

// Appends the fold state's icon to `parent`, colored per FOLD_ICON_COLOR_CLASS.
export function renderFoldIcon(parent: HTMLElement, kind: FoldKind): HTMLSpanElement {
  const colorCls = FOLD_ICON_COLOR_CLASS[kind];
  const span = parent.createSpan({ cls: `config-sync-fold-ic${colorCls !== null ? ` ${colorCls}` : ""}` });
  setIcon(span, FOLD_ICON[kind]);
  return span;
}

// Appends the fold icon followed by `count` — the filter pills' short (mobile/compact) form for
// the ok/excluded/none pills (the same optical mismatch the fold lines had would otherwise
// survive in the one place these three glyphs sit side by side). Unlike renderActionCount
// (actionIcons.ts), the count is ALWAYS appended, never suppressed at 0 — the pre-existing short
// text (`✓ ${n}` etc.) never omitted a zero either, and that must stay byte-for-byte.
export function renderFoldCount(parent: HTMLElement, kind: FoldKind, count: number): void {
  renderFoldIcon(parent, kind);
  parent.appendText(String(count));
}
