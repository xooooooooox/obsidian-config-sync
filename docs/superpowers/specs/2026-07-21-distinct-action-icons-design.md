# Distinct per-action icons (Capture / Apply / Push / Pull)

## Problem

The four sync actions ride a single vertical direction axis (remote ▲ — store —
device ▼), so they share **glyphs** and separate only by color:

| Action | Direction | Glyph today | Color |
|---|---|---|---|
| Capture | device → store | `↑` | orange (`is-up`) |
| Push | store → remote | `↑` | pink (`is-push`) |
| Apply | store → device | `↓` | accent (`is-down`) |
| Pull | remote → store | `↓` | cyan (`is-pull`) |

`↑` means both Capture and Push; `↓` means both Apply and Pull. Color is the only
separator, which fails for color-blind users and reads as "the same operation" at a
glance. DESIGN.md §2.1 records the shared arrows as a *deliberate* axis, and §2.4
mandates reusing the `↑ ↓ ✓ ○` vocabulary — so this change **amends a documented
decision** and updates DESIGN.md accordingly.

## Decision (定稿)

Each action gets a **unique Lucide SVG icon** and keeps its existing unique color —
no glyph is ever reused. Full uniform set (mockup 定稿 `mockup-action-icons.html`
方案 B; mobile 定稿 `mockup-action-icons-mobile.html` 变体 1 — SVG on **every**
surface including the compact aggregate counts).

| Action | Lucide icon | Color class (unchanged) |
|---|---|---|
| Capture | `arrow-up-from-line` | `is-up` (orange) |
| Apply | `arrow-down-to-line` | `is-down` (accent) |
| Push | `cloud-upload` | `is-push` (pink) |
| Pull | `cloud-download` | `is-pull` (cyan) |

Semantic spine: **plain arrow-to-line = local** (device↔store), **cloud arrow =
remote** (store↔remote); up = outward/toward-store-or-remote, down = inward. Colors
stay orange/accent/pink/cyan — this change is glyph-only.

The non-action **status** glyphs are untouched: `✓` in-sync, `≠` differs, `—`
missing, `○` no-settings, `?` unknown remain text glyphs. The state-icon column
therefore mixes SVG (the four actions + existing `key-round`) with text (the
statuses) — consistent with §2.1, which already documents the column as "text
glyphs + one SVG".

## Architecture — single source of truth

One new pure module so all ten call sites derive from one map; swapping an icon name
(see the Lucide-availability risk below) touches one line.

```ts
// src/ui/actionIcons.ts
export type SyncAction = "capture" | "apply" | "push" | "pull";

export const ACTION_ICON: Record<SyncAction, string> = {
  capture: "arrow-up-from-line",
  apply:   "arrow-down-to-line",
  push:    "cloud-upload",
  pull:    "cloud-download",
};

export const ACTION_COLOR_CLASS: Record<SyncAction, "is-up" | "is-down" | "is-push" | "is-pull"> = {
  capture: "is-up", apply: "is-down", push: "is-push", pull: "is-pull",
};

// Render an action icon into `parent` (setIcon + color class). Returns the icon span.
export function renderActionIcon(parent: HTMLElement, action: SyncAction): HTMLElement;

// Render an action icon followed by a count text node, into `parent`. For badges/pills.
export function renderActionCount(parent: HTMLElement, action: SyncAction, count: number): HTMLElement;
```

- `renderActionIcon` creates a `<span class="config-sync-action-icon is-*">`, calls
  `setIcon(span, ACTION_ICON[action])`, returns it.
- `renderActionCount` wraps `renderActionIcon` + a text node with the number, in a
  container the caller styles (existing `config-sync-side-badge` / `config-sync-fpill`
  / `config-sync-pill` classes).
- SVG inherits `currentColor`, so the existing `is-up/is-down/is-push/is-pull` color
  rules color the icon with no CSS color change. One small CSS addition sizes the
  icon inside badges/pills (see §CSS).

## Surfaces retargeted — all in `src/ui/SyncCenterView.ts`

Each currently emits a text `↑`/`↓`; each switches to the registry. Line numbers are
the current locations (verify at implementation time):

1. **Action-bar buttons** — Capture `:1807`, Apply `:1818`. `ButtonComponent.setIcon`
   and `setButtonText` do **not** compose (each replaces button content), so compose
   on `btn.buttonEl` directly: clear, `renderActionIcon(buttonEl, action)`, append the
   label text node (`Capture ${n} item(s)`). The solid fill + label copy are unchanged.
2. **Remote buttons** — Pull `:1928`, Push `:1942`. Same `buttonEl` composition;
   labels `Pull from ${name}` / `Push to ${name}` unchanged.
3. **Segmented per-item buttons** — Capture/Apply `:1646-1647`. Same composition;
   labels "Capture" / "Apply store" unchanged.
4. **Local state-icon column** `:1357-1370` — `is-up` → `renderActionIcon(_, "capture")`,
   `is-down` → `"apply"`. The `≠/—/○/✓` branches stay text.
5. **Remote state-icon column** `:1842-1851` — `is-push` (`↑`) → `"push"`,
   `is-pull` (`↓`) → `"pull"`. The `✓/—/?` branches stay text.
6. **Sidebar / switcher count badges** `:666-667,738-739` — `↑${up}` →
   `renderActionCount(_, "capture", up)`, `↓${down}` → `renderActionCount(_, "apply", down)`.
7. **Header pills** `:771,778` — `↑ ${up}` → capture, `↓ ${down}` → apply.
8. **Mobile filter pills (short form)** `:1026-1032` — `short: \`↑ ${counts.up}\`` /
   `\`↓ ${counts.down}\``. Short form becomes an icon node + count rather than a string;
   the pill builder renders it via `renderActionCount`. Full-form labels ("To capture
   N") and the `✓`/`○` pills are unchanged.
9. **Badge-glyph helper** `:430-438` — the `{ text, cls }` returning fn that produces
   `↑${n}`/`↓${n}` is refactored so callers render an icon+count node instead of a bare
   string (or the helper returns the action + count for the caller to render).
10. **Divergence warnings (prose)** `:1497,1501` — the inline `↑`/`↓` prefix on
    "↑ Capture removes …" / "↓ Apply turns off …" becomes a small leading colored action
    icon; the sentence keeps the word "Capture"/"Apply". No bare arrow remains in prose.

Out of scope (no direction glyph): conflict-modal `✓/＋/＝/⌂`, report chips `+ ~ −`,
warnings `⚠ ✗`, chevrons — untouched.

## CSS (`styles.css`)

- New `.config-sync-action-icon { display:inline-flex; align-items:center; }` and
  `.config-sync-action-icon svg { width:1em; height:1em; }` so the SVG scales to each
  host context's font size (state column ~15px, badges/pills ~12–13px). Reuse the
  existing `is-up/is-down/is-push/is-pull` color rules — no new color, no hardcoded
  color (release gate).
- Verify badge/pill vertical alignment (icon baseline vs count) on desktop and mobile.

## Lucide-availability risk (must verify first)

Obsidian bundles a **subset/older snapshot** of Lucide; `setIcon` with an unknown name
renders **nothing** (silent). Before wiring surfaces, verify each of the four names
renders in the installed dev-vault Obsidian (`setIcon(el, name)` → non-empty `<svg>`).
Fallbacks if a name is absent, in order of preference:

- `cloud-upload` → `upload-cloud`; `cloud-download` → `download-cloud`.
- `arrow-up-from-line` → `upload`; `arrow-down-to-line` → `download`.

Because the registry is the single source, a fallback is a one-line change. Record the
verified names in the registry.

## Testing

- **Unit** — `tests/actionIcons.test.ts`: `ACTION_ICON` and `ACTION_COLOR_CLASS` have
  all four keys; the four icon names are pairwise distinct; each action maps to its
  expected color class. (`renderActionIcon`/`renderActionCount` touch the Obsidian DOM
  and are verified live, not unit-tested.)
- **Live (the real verification, per DESIGN.md §4)** — dev-vault probe, **desktop +
  390×844 mobile**:
  - Each of the four surfaces (buttons, both state columns, count badges/pills) shows
    the correct SVG (non-empty `<svg>`), correctly colored, distinct per action.
  - Mobile filter-pill row and count badges: icon+number aligned, no clipping; the row
    does not overflow the phone width in the common case (the SVG-in-counts choice was
    the mobile decision point — confirm it holds).
  - The `✓ ≠ — ○ ?` status glyphs still render as text.
- **Gates** — `npx tsc -noEmit -skipLibCheck`, `npm test`, `npx eslint .`
  (**0 errors / 67 warnings**), `./scripts/check-no-hardcoded-color.sh`, `npm run build`.

## DESIGN.md update (part of this work)

- §2.1: replace the shared-arrow axis description — the four action directions now
  carry dedicated Lucide icons; status glyphs `✓ ≠ — ○ ?` remain text; retire the
  "deliberate shared arrows" note.
- §2.3: add `arrow-up-from-line`, `arrow-down-to-line`, `cloud-upload`,
  `cloud-download` (or the verified fallbacks) to the Lucide-usage list.
- §2.4: note the direction *actions* now use dedicated icons; the count vocabulary
  embeds them (icon + number) rather than bare arrows.

## Non-goals

- No color change — the four colors already distinguish; this is glyph-only.
- No change to status glyphs (`✓ ≠ — ○ ?`), report chips, conflict modal, or chevrons.
- No behavior change — the actions, counts, and copy are identical; only their icons
  change.
- No new action types.
