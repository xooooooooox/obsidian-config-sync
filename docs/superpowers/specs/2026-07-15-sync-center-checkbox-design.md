# Sync Center Checkbox Presentation (0.22.x)

Two CSS fixes to the Sync Center's checkbox column: align the top "select all" to the same
right baseline as the row checkboxes, and give disabled checkboxes an obvious disabled
appearance. Design 定稿 via the visual companion (option A — both fixes).

## Problem

1. **Top select-all is not aligned with the row-checkbox column.** Row checkboxes sit at the
   card's inner right edge (`.config-sync-card` has `padding: 0 var(--size-4-3)` and a 1px
   border, so the checkbox right edge is `border + padding` ≈ 13px from the panel edge). The
   mainbar's select-all is pushed right by `margin-left: auto` but then inset by
   `.config-sync-mainbar { padding-right: 11px }` **plus** `.config-sync-selectall { margin-right:
   var(--size-4-3) }` — a combined ≈23px inset. The two right edges never line up; the top box
   floats ~10px left of the column below it.
2. **Disabled checkboxes have no clear disabled appearance.** The top select-all is disabled when
   nothing is checkable (`box.disabled = true`), but `.config-sync-mainbar input[type="checkbox"]`
   has **no `:disabled` rule at all**, so a disabled top box looks identical to an enabled empty
   one. Row checkboxes do have `.config-sync-hub-row input:disabled { opacity: 0.25; cursor:
   default }`, but the cursor is `default` (not the conventional disabled cursor) and there is no
   consistency with the top box. The functional disabled state is invisible to the user.

## Design (option A — both fixes)

CSS-only, in `styles.css`. No TypeScript, no markup change — the elements, classes, and the
`disabled` property are already set correctly in `SyncCenterView.ts`; only their appearance
changes.

### (a) Align the top select-all to the row-checkbox column

Make the select-all's right edge land on the same x as the row checkboxes. Row checkboxes align
to the card's inner right edge = card border (1px) + card padding (`--size-4-3`). So:

- `.config-sync-mainbar` — change `padding-right: 11px` to `padding-right: calc(var(--size-4-3) +
  1px)` (12px padding + 1px to match the card's border), replacing the magic `11px`.
- `.config-sync-selectall` — drop the extra `margin-right: var(--size-4-3)`; keep `margin-left:
  auto` so the box sits flush against the mainbar's right padding. Result: select-all right edge =
  `calc(var(--size-4-3) + 1px)` from the panel edge = the row-checkbox right edge.

Both checkboxes are 15px wide (shared rule), so aligning right edges aligns them fully. The exact
inset is pixel-sensitive; the value is verified by the two-theme screenshot, not asserted in code.

### (b) Obvious disabled appearance

A single shared disabled treatment for both the top select-all and the row checkboxes:
reduced opacity **and** `cursor: not-allowed` (the conventional "can't act here" affordance,
replacing the row rule's `cursor: default`).

- Add `.config-sync-mainbar input[type="checkbox"]:disabled { opacity: 0.35; cursor: not-allowed;
  }` (today: nothing).
- Change `.config-sync-hub-row input[type="checkbox"]:disabled` from `{ opacity: 0.25; cursor:
  default }` to `{ opacity: 0.35; cursor: not-allowed }` — a shared opacity with the top box and
  the not-allowed cursor. (0.35 rather than 0.25 so the box stays perceptible inside the already
  0.55-dimmed in-sync row, where 0.25 compounded to near-invisible.)

The whole in-sync row keeps `.config-sync-hub-row.is-insync { opacity: 0.55 }`; the row context
(the "in sync" trailing label) plus the not-allowed cursor on hover now clearly communicate why
the box can't be toggled. No color is introduced (pure opacity + cursor), so this is theme-native
and adds no hardcoded color.

## Edge cases

- **Mobile:** the mobile checkbox sizing rules (`body.is-mobile … input[type="checkbox"]`) are
  unaffected — the disabled `:disabled` treatment layers on top (opacity/cursor only). The
  alignment fix applies equally; mobile still uses the same mainbar/card structure.
- **Indeterminate top box:** the `:indeterminate` fill rule is orthogonal to `:disabled`; a box is
  never both (indeterminate implies some checkable rows exist, so it isn't disabled). No conflict.
- **Checked-but-disabled:** not a real state here — disabled rows are the inert/in-sync ones that
  are never auto-checked; still, opacity + not-allowed read correctly if it ever co-occurs.

## Testing

Pure CSS; no unit test. Verification is the controller two-theme screenshot protocol:

- Deploy to the dev vault, reload the plugin, open the Sync Center.
- **Alignment:** confirm the top select-all's right edge lines up with the row checkboxes'
  column (a vertical guide / pixel read in both the default theme and AnuPpuccin).
- **Disabled:** produce a state where the top select-all is disabled (no checkable rows — e.g.
  everything in sync) and confirm it reads as clearly disabled (dimmed) and shows `not-allowed` on
  hover; confirm an in-sync row's checkbox reads disabled with `not-allowed` too.
- Gates: `npm run build`/`lint` clean (0 errors / 65 warnings baseline), `npm test` green (207),
  `./scripts/check-no-hardcoded-color.sh` passes (no new color introduced).

## Scope

`styles.css` only (mainbar padding, select-all margin, two `:disabled` rules). No TS, no markup,
no copy change. This is item 4 of the post-0.21.0 backlog; the remaining items (capture/pull
interruption robustness, and the deferred self-config-propagation model) are separate specs.
