# C live-test batch 24: the trailing fold lines join the list's visual language — design

Date: 2026-08-10 · Scope: C live-test issue C-#50 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main · Status: 定稿 —
mockup https://claude.ai/code/artifact/77dc6ea0-8cdc-47d6-9392-67358efcfde5.
Three symptoms, one cause: the fold lines are a separate visual language.

## §1 Fixed-size icons replace the text glyphs (fold lines only)

- Measured on the reporting device (12px Overpass, canvas metrics): ink heights
  ✓ 8.6 · ○ 5.2 · ⊘ 6.9 — the excluded glyph is 33% taller than the no-settings one
  with a much heavier stroke (font fallback). Text glyphs cannot be made optically
  equal across themes; fixed-size SVG can.
- The three trailing-fold states render 12px Lucide icons via setIcon:
  `check` (in sync — may keep its current green), `circle` (no settings yet, muted),
  `circle-slash` (not synced on this device, muted).
- `ban` stays reserved for the Stop-syncing ACTION; the state uses `circle-slash` —
  action and state never share an icon.
- The ROW state column (✓ ○ ≠ — ? key) is NOT touched by this batch.
- DESIGN.md §2.1/§2.3 amended: the fold-line family moves from the text-glyph
  vocabulary to Lucide, with the action-vs-state note.

## §2 The disclosure triangle returns to the leading chevron

- Fold lines use the same `.config-sync-row-chevron` element the list rows use
  (leading, `▸`/`▾` by state) instead of a triangle appended to the label text.
- `insyncLineText` / `excludedLineText` / `nosettingsLineText` (panelModel.ts) return
  PLAIN TEXT (no glyph prefix, no trailing triangle); the renderer composes
  chevron + icon + label. Update their tests accordingly — the counts/pluralisation
  wording stays byte-identical.

## §3 Fill wraps rows, never summaries

- The section's filled body (`.config-sync-card` inside `.config-sync-section`,
  filled per batch-22 §8) renders ONLY when the section has real rows. A section
  whose visible content is fold lines alone renders head + fold lines with no filled
  block (mockup §3).
- Fold lines always sit on the section's own ground, never inside the filled body.
- An OPEN fold's rows get their own filled block directly beneath that fold line —
  the invariant "filled block = rows" holds in every state (mockup §4).
- Row geometry, the checkbox column (batch-3 ①) and fold order (✓ → ⊘ → ○) are
  unchanged; verify the column invariant by reasoning and report it (the controller
  probes live).

## §4 Behaviour frozen

Counts, click-to-toggle, sort order, session fold state, mobile rules — all
unchanged. This batch is presentation only.

## §5 Tests & gates

- Text producers: assert plain-text returns (no glyph/triangle) with pluralisation
  intact; existing count/behaviour tests stay green.
- Icon map for the three fold states is a pure seam if one exists — test it; DOM is
  manual per suite convention.
- Suite green (1270 baseline); build clean; lint 0 errors / ≤58 warnings (ceiling,
  zero new); NO commits; no Claude attribution.

## §6 Verification

Deploy llm + kickstart. Live FAIL CRITERIA (kickstart): the three fold lines render
optically equal icons with a leading chevron that flips on toggle; a section with only
fold lines shows no filled block; opening a fold puts its rows in their own filled
block; counts identical to before. Emulated-mobile spot check.
