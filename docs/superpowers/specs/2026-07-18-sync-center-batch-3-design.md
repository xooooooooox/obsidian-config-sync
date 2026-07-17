# Sync Center batch 3 (0.27.8): column alignment, Beta scope, ordering, session staging

Real-vault findings 2026-07-18 (kickstart desktop + phone). Six items, diagnosis-approved.

## ① One checkbox column

The panel's checkbox column is defined by the mainbar select-all (aligned with the main
card's row checkboxes by the existing `padding-right: calc(--size-4-3 + 1px)` rule). Two
things fall outside it:

- **Section rows** (outdated/disabled/not-installed) sit ~11px deeper — the
  `.config-sync-section` container's horizontal geometry differs from the card's. Calibrate
  the section's padding/inset so its rows' checkboxes land on the same column, verified by
  geometry probe (desktop and mobile emulation, exact equality like the ↻ calibration).
- **Section-head checkboxes** are inline after the pills. Right-align them into the column:
  `margin-left: auto` on the head checkbox; when the "N selected" hint is present it keeps
  its own auto margin and the checkbox follows it (`.config-sync-section-hint + input {
  margin-left: 0 }`). Calibrate the head checkbox's right edge to the same column.

## ② Select-all hides when there is nothing to select

The mainbar select-all currently renders disabled (opacity 0.35) when zero rows are
checkable, which reads as a differently-colored checkbox. Following the 0.27.5 idle-renders-
nothing principle: `visibility: hidden` (keeps layout, including the mobile search-row
geometry) when checkable count is 0. Section-head boxes are unaffected (their sections
always contain rows).

## ③ Sidebar Beta scope (parity with the settings Beta tab, 0.25.0)

The sidebar's device scopes iterate the fixed category order and never learned about Beta.

- Host exposes the beta id set (keys of `settings.bratPluginIndex`, same source as
  `listBetaSections`).
- Sidebar adds a **Beta** entry after Community plugins, with the standard badges; the
  scope switcher (mobile) gets the same entry. Shown only when the beta set is non-empty —
  the same emptiness rule that already hides Custom.
- Membership: groups whose plugin id is in the beta set (the mapping the settings Beta tab
  uses). The Community scope excludes those groups, so an item belongs to exactly one scope.
- Search hit counts and presented-count badges follow the same scope filter.

## ④ Deterministic item ordering

`rows()` returns store-manifest order (accretion order), so e.g. "Enabled core plugins"
lands mid-way through the Obsidian items. Sort in the view layer only (store untouched):
category rank (Obsidian → Core plugins → Community → custom) then display name
(localeCompare). Applies everywhere rows() feeds: main card, sections, flattened in-sync /
no-settings lines.

## ⑤ Mobile action bar stays on one line

`body.is-phone .config-sync-actionbar { flex-wrap: wrap }` lets the two buttons stack when
"N selected" + both buttons overflow. On mobile: the staged count takes its own line
(`flex: 1 1 100%`), the Capture/Apply buttons share one row (no wrapping between them),
with slightly tightened button padding as the fallback for very narrow widths. Desktop
unchanged.

## ⑥ Panel staging state survives view recreation (mobile "self-checking" fix)

The 0.24.0 default pre-check seeds pending main rows "once per view lifetime". Mobile
Obsidian recreates the view on tab switches, so every recreation re-seeds — after an apply
the user returns to a panel with everything re-checked.

Lift the panel's user state to module-level session state (same pattern as `sessionUi`):
`selected`, `directionOverride`, `policy`, and a `seeded` flag. Seeding happens once per
Obsidian session; reload keeps its existing pruning (stale names, inert rows, invalid
policies). Desktop behavior is unchanged; on mobile, a recreated view now restores the
previous selection instead of re-seeding.

## ⑦ Mobile filter pills on one line

The filter pill row (All / To capture / To apply / In sync / No settings yet) wraps to a
second line on phones. Switch the mobile pill row to the standard chip-row pattern: one
line, `flex-wrap: nowrap`, horizontal scroll (`overflow-x: auto`, scrollbar hidden,
momentum scrolling). Desktop keeps wrapping.

## Verification

Dev vault (desktop + 390×844 emulation; fabricate a disabled-section row by disabling a
captured plugin): probe-equal checkbox columns (mainbar / card rows / section rows /
section heads), select-all hidden at zero checkable, Beta entry present with a stubbed
brat index and absent without, sorted order in All items, one-line action bar with a long
staged count, seeding-once across view close/reopen. Gates: npm test, lint 67-warning
baseline, no hardcoded colors.
