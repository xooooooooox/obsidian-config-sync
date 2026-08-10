import { setIcon } from "obsidian";

// The three trailing-fold states' icon vocabulary (C-#50, spec
// 2026-08-10-c-livetest-batch24-fold-family.md §1): fixed-size 12px Lucide icons replace the old
// text glyphs (✓ ○ ⊘) — canvas-metrics measured on the reporting device found their ink heights
// unequal across themes (the excluded glyph 33% taller than the no-settings one, a font-fallback
// artifact) — fixed-size SVG reads as optically equal instead. `ban` stays reserved for the
// Stop-syncing ACTION (itemCard.ts's stop-sync menu) — action and state never share an icon, so
// the "not synced on this device" STATE uses `circle-slash`. The ROW state column
// (`.config-sync-state-icon` — ✓ ○ ≠ — ? key) is untouched by this map; it stays text (DESIGN.md
// §2.1).
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
