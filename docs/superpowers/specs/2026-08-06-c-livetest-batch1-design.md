# C live-test batch 1: section headers, card container, control unification — design

Date: 2026-08-06 · Scope: C live-test issues C-#1..C-#4 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先把这几个问题修复了")

## C-#1 · Real section collapse + restored header typography

- Section headers get REAL collapse: clicking the header toggles its section's rows
  (fold lines included); disclosure glyph reflects state (▾ open / ▸ collapsed);
  collapsed state is remembered per section for the view instance's lifetime (survives
  re-renders, resets on view close — same session-state idiom as expanded rows).
- Header typography returns to the pre-C identity: uppercase, letter-spaced, small,
  muted (`CORE PLUGINS` treatment), visually unmistakable from member rows with the
  badge covered. The `· 9 of 31` count and `on/off synced ✓` chip stay; the triangle
  scales to the header size.
- The header's select-all/checkbox affordance (if rendered on the header line) must not
  conflict with the collapse click target — checkbox click stages, anywhere else on the
  header toggles collapse.

## C-#2 · Card reads as one contained unit

Match the approved interactive mockup (`c-interactive-round3.html`): the expanded card is
a bordered, left-indented container (`margin-left` under the row's name column, subtle
border + slightly offset background); each key (On apply / Files / Runs on /
Settings sync / More / Note) is a fixed-width muted small-caps column with its value
IMMEDIATELY adjacent — no full-width spread, no far-right floating values. Menus sit next
to their labels. Row separators inside the card are hairlines within the container, not
full-pane rules.

## C-#3 · One control language for the item-level device scope

- `Settings sync` in the card uses the SAME icon control the Settings panel uses for
  item/file device scope (the device-glyph control), wired to the same stored value —
  two surfaces, one idiom, one value. Remove the bordered-text menu for this fact.
- `Runs on` stays a textual menu (five options exceed the device-icon vocabulary) but its
  trigger styling harmonizes with the card (same height/border treatment as the icon
  control's hover surface, not a bespoke chip).

## C-#4 · File-entry styling follows the glyph

Entry presentation obeys `FileEntryPresentation.glyph`: "+" renders green with NO
strikethrough; "↑" amber, no strikethrough; strikethrough exclusively for genuine
del-direction entries. Root-cause the leak (old deletion class applied container-wide)
rather than overriding it.

## Gates & verification

DOM-free suite untouched or extended only if a pure helper changes; build clean; lint 0
errors / ≤58 warnings. Manual criteria = the four ledger FAIL CRITERIA. Redeploy to
llm-wiki.vault only.
