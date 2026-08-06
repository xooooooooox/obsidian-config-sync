# C live-test batch 3: More anchoring + fourth scope stop — design

Date: 2026-08-07 · Scope: C live-test issues C-#11, C-#12 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先把这两个修复了")

## C-#11 · More lands on the item's card (reuse the search-bar anchoring)

Live behavior today: `More` opens Settings but never positions to the card, despite the
pendingAnchor implementation passing code review. Requirements:

- Root-cause the current failure first (why the consume never fires or loses the race
  live) and record it — do not stack a second mechanism on an undiagnosed one.
- Then make `More` reuse the SettingTab search bar's existing card-anchoring path — the
  same target resolution (`data-search-anchor`), the same scroll AND the same visual
  highlight the search bar produces. One anchoring mechanism in the file afterwards: if
  pendingAnchor survives, it must delegate to the search path; no parallel scroll logic.
- Works for plugin items, Obsidian items, and custom folders (Advanced-tab anchor), from
  every type section.

FAIL CRITERION (ledger): More on any item lands Settings scrolled to that item's card,
expanded, with the search bar's highlight.

## C-#12 · Fourth stop in the card's Settings-sync menu

- Add `This device` (`local`, glyph `airplay`) as the fourth menu item — the card menu
  offers exactly the four stops the Settings cycle offers, same glyphs, same labels
  (`All devices` / `Desktop only` / `Mobile only` / `This device`), same write target.
- The options list derives from the same single source the Settings cycle uses (no
  hand-written second list that can drift; if the cycle's options are per-context, reuse
  that context's list for the card).
- C spec §4 already amended (2026-08-07) to this vocabulary.

FAIL CRITERION (ledger): card menu = the Settings cycle's four stops, glyphs and labels
identical.

## Gates

Suite 1013 green (extend only if a pure helper changes); build clean; lint 0 errors /
≤58 warnings. Redeploy llm only. Manual criteria = the two FAIL CRITERIA.
