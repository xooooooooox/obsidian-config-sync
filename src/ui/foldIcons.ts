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

// The conflict mark. Not a fold — a conflict is the one row state with nothing to fold INTO, and
// the only fate that keeps its sentence on screen ("a conflict must shout"). It lives here anyway
// because this file is the row-state icon vocabulary, and until 2.25.0 conflict was the last state
// in that column still drawing a TEXT glyph (`⚠`) while ↑/↓/✓/⊖/○ had all become fixed-size SVG:
// its size and baseline drifted with the font, and it could not carry a colour class of its own.
//
// Red, not the orange it shared with `capture`. A routine "your settings are newer, capture them"
// and a deadlock waiting on the user were wearing the same colour in the same column, and once the
// conflict row stopped being dimmed (it used to inherit the in-sync opacity) that collision was the
// only thing left telling them apart — which is to say, nothing was. Red has uses elsewhere (a
// failed run in the result strip, a deleted line in a diff), but those are other surfaces; in the
// row's fate column nothing else claims it.
export const CONFLICT_ICON = "triangle-alert";
export const CONFLICT_COLOR_CLASS = "is-conflict";

// The AVAILABILITY folds — a second axis, and deliberately a different one. The three above answer
// "is there anything to do with this item"; these answer "can this device do it at all".
//
// Each glyph is the one the row's own fate chip already wears for the same fact (`circle-dashed`
// not installed here, `monitor` desktop only, `power-off` off here), so the fold line and the rows
// inside it say the same thing in the same mark. `circle-arrow-up` is the one new glyph: the store
// was captured on a newer version than this device runs, and updating is the way out.
//
// The four titles and their notes come back verbatim from the sections this replaced
// (987eacf deleted them when the list moved to type sections; the copy was good and the need for
// it never went away — it just stopped being reachable).
export type AvailabilityFoldKind = "outdated" | "disabled" | "not-installed" | "desktop-only";

export const AVAILABILITY_FOLD_ICON: Record<AvailabilityFoldKind, string> = {
  outdated: "circle-arrow-up",
  disabled: "power-off",
  "not-installed": "circle-dashed",
  "desktop-only": "monitor",
};

export const AVAILABILITY_FOLD_TEXT: Record<AvailabilityFoldKind, (n: number) => string> = {
  outdated: (n) => `${n} outdated on this device`,
  disabled: (n) => `${n} disabled on this device`,
  "not-installed": (n) => `${n} not installed on this device`,
  "desktop-only": (n) => `${n} desktop-only`,
};

export const AVAILABILITY_FOLD_NOTE: Record<AvailabilityFoldKind, string> = {
  outdated: "Store settings were captured on a newer plugin version than this device runs. Updating first is the safe path.",
  disabled: "Settings sync either way. Choose whether applying also turns the plugin on.",
  "not-installed": "Settings sync either way. Choose whether applying also installs the plugin.",
  "desktop-only": "In your config but can't run on this device. Nothing to do here.",
};

// The one painter for a fold's fixed-size glyph. Takes the resolved name/color rather than a
// FoldKind so the availability folds (a different kind set, same visual treatment) share it
// instead of growing a second painter that could drift in size or class.
export function renderFoldIconNamed(parent: HTMLElement, icon: string, colorCls: string | null): HTMLSpanElement {
  const span = parent.createSpan({ cls: `config-sync-fold-ic${colorCls !== null ? ` ${colorCls}` : ""}` });
  setIcon(span, icon);
  return span;
}

// Appends the fold state's icon to `parent`, colored per FOLD_ICON_COLOR_CLASS.
export function renderFoldIcon(parent: HTMLElement, kind: FoldKind): HTMLSpanElement {
  return renderFoldIconNamed(parent, FOLD_ICON[kind], FOLD_ICON_COLOR_CLASS[kind]);
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
