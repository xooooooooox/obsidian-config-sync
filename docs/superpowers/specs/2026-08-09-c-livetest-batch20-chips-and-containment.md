# C live-test batch 20: chip icons + containment axioms + mobile two-line structure — design

Date: 2026-08-09 · Scope: C live-test issues C-#39, C-#40, C-#41 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main (commits allowed
per-batch only when the user says so; default uncommitted) · Status: 定稿 —
mockup https://claude.ai/code/artifact/1781c352-a4ca-4714-9472-6971713479ff (v4),
user picked **B**; your-choice icon = **check** (recommended, unobjected); chip copy
UNCHANGED (incl. `stays off`, audited 2026-08-09).

## §0 The containment axioms (user-定稿, global)

1. Names and section titles are NEVER truncated or ellipsized — on any platform. (This
   REPLACES the mobile name-truncation rule styles.css:1540-1548; remove it.)
2. Chips never wrap and never clip: when the full icon+text set doesn't fit its line,
   the row's chips degrade AS A GROUP to icon-only + tooltip (Obsidian setTooltip;
   tap on mobile). Mixed full/icon chips on one row are forbidden.
3. The only sacrificial element is the fate sentence (duplicated in the expanded
   card per C-#9): ellipsize first, degrade to the bare direction glyph (`↓`/`↑`) at
   minimum. Chevron, checkbox, count pill never shrink.

## §1 C-#40 · chip icons (all platforms)

- Every fate chip renders icon + text (C-#38 pattern generalized). Map (chip string →
  Lucide icon), single source in the renderer; `Fate.chips` stays `string[]`:
  - `not installed here` → `circle-dashed`
  - `desktop only` → `monitor`
  - `your rule` / `off here — your rule` / `on here — your rule` → `sliders-horizontal`
  - `stays off` → `power`
  - `encrypted` → `lock` (shipped C-#38 — refactor into the same map)
  - `your choice` → `check`
- Styling: the existing `.config-sync-fatechip.is-encrypted` inline-flex/gap/11px-svg
  treatment becomes the base `.config-sync-fatechip` treatment (all chips have icons
  now); colors untouched (muted, currentColor).
- Icon-only degraded form: same chip element, text hidden, tooltip = full chip text.

## §2 C-#41 · mobile structure B (is-mobile only; desktop byte-identical)

- Section head, line 1: chevron + full title (nowrap, never truncated) + compact count
  pill `n/m` (replaces `n of m` on mobile) + spacer + select-all checkbox.
- Section head, line 2 (only for Core/Community, which own a carrier chip): the
  `on/off synced ✓` / `on/off not synced` chip, full text, indented under the title.
- The per-section `${staged} selected` head hint is NOT rendered on mobile (the
  checked/indeterminate checkbox + the global footer carry it). Desktop keeps it.
- Rows:
  - chips ≤ 1 → single line: chevron + name + inline full chip + spacer + sentence
    (sacrificial per §0.3) + checkbox.
  - chips ≥ 2 → two lines: line 1 = chevron + name + spacer + full sentence +
    checkbox; line 2 = indented chip meta line — full icon+text chips when the set
    fits on ONE line, else the whole group degrades to icon-only + tooltip (§0.2).
    The meta line never wraps to a third line.
- Expanded-card behavior, staging, and all model logic unchanged — this is
  render/CSS-layer structure only.

## §3 C-#39 · desktop narrow-pane containment (axiom ladder)

- `.config-sync-hub-row` stays single-line on desktop. Give-way order per §0:
  1. `.config-sync-fate-text` gains `flex: 0 1 auto; min-width: 0; overflow: hidden;
     text-overflow: ellipsis` (glyph span stays visible — the ellipsis consumes the
     sentence words, never the direction glyph).
  2. If the row still overflows (chip-heavy + narrow), the row's chips flip to the
     icon-only form. Mechanism: implementer picks CSS container queries (Obsidian's
     Chromium supports them) or a ResizeObserver on the list container toggling a
     class — must be a measured, deterministic breakpoint per row, not a global width
     guess; report the chosen mechanism.
- Names/titles never truncate (remove any conflicting rule); checkbox/chevron/chips
  keep `flex: none`.
- Section head (desktop): title + carrierchip gain `white-space: nowrap`; at extreme
  desktop narrowness the carrierchip may compact to `on/off ✓` under the same
  container-query mechanism (fact preserved, menu unchanged).

## §4 Tests

- Pure: chip→icon map completeness (every buildChips string + `your choice` +
  synthetic encrypted chip has an icon; unknown string → no icon, text-only —
  loud in review, not a throw, since chips are presentation).
- Existing chip/fate tests byte-identical (copy unchanged).
- Layout is DOM/CSS — manual + live verification per suite convention.

## §5 Gates & verification

Suite 1212 green + new; build clean; lint 0 errors / ≤58 warnings (ceiling, zero new);
no commits without the user's word; no Claude attribution. Deploy llm AND kickstart
(+ mobile check via kickstart on the phone — user-side screenshot). Live FAIL CRITERIA:
- (C-#40) every chip in the Sync Center shows its icon + text; encrypted chip
  unchanged visually; no emoji.
- (C-#41, phone) screenshot #75's state renders: one-line heads (full `COMMUNITY
  PLUGINS`, `11/73`, checkbox), carrier chip on its own second line, no head
  `1 selected`; a 4-chip row = two lines with icon-only chips + tooltips; a 1-chip
  row single line.
- (C-#39, desktop) screenshot #72's pane width: checkbox in-column, sentence
  ellipsized, name full; extreme narrowness flips chips to icons; wide pane
  byte-identical.
