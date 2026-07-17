# Action sections: unified stageability (close the whole family)

Real-vault finding 2026-07-17 evening (kickstart): DEVONlink / SimpRead Sync / Vimrc Support sit
in "Disabled on this device" as ✓ identical-to-store — and have no enable entry at all. This is
the last cell of a gap family patched pointwise three times (install-only 0.24.0, enable-only
0.27.0, update-only 0.27.1).

## Rule

**In the non-main sections (Not installed / Disabled / Outdated), every row is stageable except
`locked`.** The section's state action (install / enable / update) IS the payload; whether the
settings transfer happens to be empty (no-settings, in-sync) no longer gates interaction.

`stageableRow(state, section)` collapses from three special cases to:
- section ≠ main → `state !== "locked"`
- section = main → `stageableState(state)` (unchanged)

The self plugin's exemption stays (view-level: `plugin-config-sync` in Outdated never stages;
core-level guard from 0.27.1 unchanged).

## Detail rendering per newly-stageable cell

- **disabled + in-sync**: "identical to the store — applying just turns the plugin on" +
  ladder (no-op choice hidden → ⏻ Enable only). Apply runs the existing enable-after-write
  path; rewriting identical settings is harmless.
- **not-installed + in-sync** (leftover data.json matching the store, plugin absent): existing
  install ladder (⤓ Install & enable / ⤓ Install), note "identical to the store — applying
  installs the plugin".
- **outdated + no-settings**: update ladder, note "no settings anywhere — updates the plugin
  only".
- Cells already shipped (no-settings in not-installed/disabled, in-sync in outdated,
  not-captured capture ladder in disabled) keep their wording.

Distinguishing "not in store" stays icon-driven (user question answered in review): — =
not-captured (local settings only), ○ = no settings anywhere; ✓/↓↑≠ = store has the file.

## Payload / counting

- Direction defaults unchanged (`directionForState`); staged defaults via `defaultPolicyFor`
  (disabled+capture → enable; otherwise ladder head).
- Counts follow the update-only precedent: staged rows count in the footer/actions; the state
  pills keep reflecting presented state.

## Testing

- panelModel: stageableRow truth table — non-main sections true for every state except locked;
  locked false everywhere; main unchanged.
- Core: no changes required (enable/install/update with store data all ride existing paths);
  existing action-only tests still cover empty-transfer runs.
- Live dev-vault: disabled+identical row stages and Enable turns the plugin on; gates (lint 67,
  colors).
