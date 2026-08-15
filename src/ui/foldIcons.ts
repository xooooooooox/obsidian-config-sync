import { setIcon } from "obsidian";

// The three trailing-fold states' icon vocabulary (C-#50, spec
// 2026-08-10-c-livetest-batch24-fold-family.md §1): fixed-size 12px Lucide icons replace the old
// text glyphs (✓ ○ ⊘) — canvas-metrics measured on the reporting device found their ink heights
// unequal across themes (the excluded glyph 33% taller than the no-settings one, a font-fallback
// artifact) — fixed-size SVG reads as optically equal instead. `ban` stays reserved for the
// Stop-syncing ACTION (itemCard.ts's stop-sync menu) — action and state never share an icon, so
// the "not synced on this device" STATE uses `circle-slash`. `.config-sync-state-icon` (✓ ○ ≠ —
// ? key, a DIFFERENT, Statistic-workspace vocabulary) is untouched by this map and stays text —
// but a collapsed item ROW's own neutral (`—`-glyph) fate is NOT that column: round 12+13 ③
// (DESIGN.md §2.1, the authority for this ruling — supersedes this comment's own earlier claim
// that "the row state column stays text") reuses this same FOLD_ICON/FOLD_ICON_COLOR_CLASS map at
// the row's `config-sync-fate-ic` size for exactly that fate (SyncCenterView.ts's fateWrap and
// renderRemoteDiffEntry) — the fold vocabulary now speaks at both the group-header line and the
// row it summarizes.
export type FoldKind = "insync" | "excluded" | "nosettings";

export const FOLD_ICON: Record<FoldKind, string> = {
  insync: "check",
  excluded: "circle-slash",
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
// the ok/excluded/none pills (C-#50 follow-up: the same optical mismatch the fold lines had,
// surviving in the one place these three glyphs sat side by side). Unlike renderActionCount
// (actionIcons.ts), the count is ALWAYS appended, never suppressed at 0 — the pre-existing short
// text (`✓ ${n}` etc.) never omitted a zero either, and that must stay byte-for-byte.
export function renderFoldCount(parent: HTMLElement, kind: FoldKind, count: number): void {
  renderFoldIcon(parent, kind);
  parent.appendText(String(count));
}
