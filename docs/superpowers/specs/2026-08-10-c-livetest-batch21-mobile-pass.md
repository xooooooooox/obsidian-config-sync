# C live-test batch 21: mobile pass — constant row skeleton, iconized on/off control, stacked cards — design

Date: 2026-08-10 · Scope: C live-test issues C-#43, C-#44 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main · Status: 定稿 —
mockup https://claude.ai/code/artifact/3b0e0210-4e83-44e3-98a4-2443ea4e7bd4, user
picked **A** for the on/off control (single-line head restored). ALL changes are
mobile-only (`Platform.isMobile` / `body.is-mobile`); desktop rendering byte-identical.
Batch-20 containment axioms remain binding (names never truncate; chip groups degrade
icon-only + tooltip; the sentence is the sole sacrificial element).

## §1 The constant row skeleton (revises batch-20's §2 row rule)

- Mobile row line 1 is ALWAYS exactly: chevron + name + spacer + sentence + checkbox.
- EVERY chip-bearing row (chips ≥ 1 — revised from batch-20's ≥ 2) moves its chips to
  the `.config-sync-row-chipmeta` line: 7px below its row, 20px left inset (aligned
  with the name), never a second meta line (group icon-only degradation per axiom).
- Chipless rows stay single-line. Row groups separated by 22px vertical rhythm + 1px
  hairline (`markLastRow` last-row handling unchanged).
- This kills the real-phone `↓ U` sentence squeeze (screenshot #77): the sentence
  shares line 1 only with the fixed-width name/chevron/checkbox.

## §2 On/off control — option A: iconized, back on the head line (C-#44 a+b)

- The mobile section head returns to ONE line: chevron + full title (nowrap) +
  compact `n/m` pill + on/off icon control + spacer + select-all checkbox.
- The carrier chip's mobile form becomes an icon-only control: Lucide `toggle-right`
  when the on/off list is synced (green, same green the text chip used) /
  `toggle-left` when not synced (muted). Same click → same Menu (Sync on/off / Stop
  syncing on/off); tooltip + aria-label carry the full existing copy
  (`on/off synced ✓` / `on/off not synced`). Keyboard handling as today.
- Batch-20's `.config-sync-section-meta` second-line path is REMOVED (code + CSS).
- Desktop keeps the full-text chip in the head, untouched.

## §3 Expanded card stacks vertically (C-#43 + C-#44 d)

- Mobile-only: each card fieldrow renders its label ON ITS OWN LINE (same monospace
  uppercase style, smaller/muted) with the value full-width below — replacing the
  desktop side-by-side fixed-label-column layout. CSS-first if the DOM order already
  permits (label span + value div are siblings inside the fieldrow — flex-direction
  column should suffice); JS branching only if CSS cannot express it.
- Resolve's segmented control gets the full card width: two buttons split 50/50
  (`flex: 1`), text centered, never clipped — this is C-#43's fix.
- Runs-on / Settings-sync / After-install icon controls, More bridge, Stop-syncing
  footer: behavior unchanged, only the label/value stacking applies.
- Desktop card fieldrows byte-identical.

## §4 Spacing tokens (mobile)

- Row group: 22px block rhythm, 1px hairline between groups.
- Chip meta line: 7px below its row line, 20px left inset.
- Card: 10px internal field gaps; card inset from row left edge aligned with name.
- Use the existing var(--size-*) scale where a token matches; exact px above are the
  design intent — implementer maps to nearest tokens and reports the mapping.

## §5 Tests & gates

- Pure logic barely changes (row-rule threshold 2 → 1: update the existing
  chips-placement condition and any test asserting the old threshold). Icon control:
  pure map/test only if a pure seam exists; DOM is manual per suite convention.
- Suite green (1217 baseline); build clean; lint 0 errors / ≤58 warnings (ceiling,
  zero new). NO git commits; no Claude attribution.

## §6 Verification

Deploy llm + kickstart. Emulated-mobile probes (llm, `app.emulateMobile(true)`):
- head is ONE line: full title + `n/m` + toggle icon (green when synced) + checkbox;
  `.config-sync-section-meta` absent from DOM;
- every chip-bearing row (incl. 1-chip encrypted rows) has its chips on the meta
  line; line-1 sentence renders un-squeezed; chipless rows single-line;
- expanded card: labels stacked above full-width values; Resolve buttons 50/50,
  neither clipped at 375px;
- desktop (emulation off): byte-identical behavior spot-check (head chip text form,
  card side-by-side layout, row inline chips).
Real-phone confirmation by the user closes the batch (FAIL CRITERION: the user no
longer calls it 乱).
