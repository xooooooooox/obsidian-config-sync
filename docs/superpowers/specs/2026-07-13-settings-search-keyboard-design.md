# Settings Search: Keyboard-Stable Typing (iter23)

User report (mobile): every character typed in the settings search box collapses and re-opens the on-screen keyboard.

## Root cause

`SettingTab.render()` rebuilds EVERYTHING per keystroke: `search.onChange → refresh() → rerender() → containerEl.empty()` destroys the `SearchComponent` itself, then `render()` re-creates it and force-refocuses (`SettingTab.ts:165-166`). Desktop hides the churn; on mobile the destroy→refocus cycle bounces the keyboard once per character.

## Design

Split the render so the search box is rendered ONCE and survives all search-driven updates (the same partial-render pattern as the Sync Center list and the iter22 item rows):

- `render()` structure becomes: search box + a persistent `bodyEl` container; everything below the search box (search results, or tab nav + active tab) renders into `bodyEl`.
- `search.onChange` re-renders ONLY `bodyEl` (`bodyEl.empty()` + render results/tabs into it) — the input element is never destroyed, so focus and the keyboard never move. The focus-restore hack (`searchInputEl` field + the `focus()/setSelectionRange` block) is deleted.
- Full `rerender()` (tab switches, structural edits, `display()`) keeps rebuilding everything including the search box, preserving current behavior and the scrollTop restoration; a full rerender while the search box is focused re-runs the old churn, which is fine — those are click-driven, not per-keystroke.
- `renderGen` guard continues to apply to the body renders (async).

No visual change; no copy change. (Per the UI-mockup rule: nothing drawable — this is keyboard/focus behavior only.)

## Testing

- Gate + existing tests (no new unit surface — DOM-only).
- Live: emulateMobile — type multiple characters into the settings search; input element identity persists across keystrokes (DOM marker), results update per keystroke; desktop identical behavior; tab switching and structural edits still fully refresh.

## Non-goals

- No search feature changes (matching, sections searched); no changes to Sync Center search (already partial-rendering).
