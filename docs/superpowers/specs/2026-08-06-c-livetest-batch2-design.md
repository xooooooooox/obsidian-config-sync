# C live-test batch 2: card mechanics + DESIGN.md control unification — design

Date: 2026-08-06 · Scope: C live-test issues C-#5..C-#10 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先把这一批修复了", process spec → plan → SDD)

Binding context: `docs/design/DESIGN.md` is the design-system authority (this batch also
pays its currency debt, §3). Icon vocabulary source of truth: `SCOPE_ICONS`
(src/ui/itemCard.ts:390 — all `monitor-smartphone` / desktop `monitor` / mobile
`smartphone` / local `airplay`) rendered via the shared `renderScopeCycle` idiom
("the glyph IS the state").

## §1 Card mechanics (C-#5, C-#6, C-#8, C-#9)

- **C-#5 empty band:** root-cause the empty separator-bounded region at the card bottom
  (a valueless row or empty actions container still emitting borders). A card row that
  renders no value renders nothing — no separator, no reserved height.
- **C-#6 adjacency:** every value (including icon controls) sits immediately right of its
  key, in the value column's left edge — never floated/centered into open space. The key
  column is wide enough that no key wraps (`SETTINGS SYNC` on one line); keys never wrap
  at any supported pane width.
- **C-#8 width allocation:** value cells size to content within the remaining row width;
  a trigger/label never truncates while free space exists on its row (no fixed narrow
  value width; ellipsis only when the row is genuinely out of space).
- **C-#9 row-sentence suppression:** while a row's card is expanded, the collapsed-row
  fate sentence (and its direction glyph) is hidden — the card's `On apply`/`On capture`/
  `State` line is the single statement; the checkbox stays. Collapsed rows unchanged.

## §2 Rule controls on the DESIGN.md icon language (C-#7, C-#10)

One idiom for both card rule rows: **icon trigger + Obsidian Menu** (glyph IS the state;
menu = explicit choice, killing the silent-cycle hazard the user hit).

- **Settings sync (card):** the trigger is the shared scope icon (`SCOPE_ICONS`, same
  classes/`is-set` accent semantics as `renderScopeCycle`), but in the CARD a click opens
  an Obsidian Menu of the scope options — each menu item shows the option's glyph + the
  existing label copy, current one checked. Selecting writes the same target as today.
  The Settings tab's drawer cycle control is untouched (established idiom there; same
  glyph vocabulary keeps the two surfaces one language).
- **Runs on (card):** same construction — icon trigger + menu, extending the vocabulary:
  `follows` → `monitor-smartphone` (dim, like the "all" idle state) · `desktop` →
  `monitor` · `mobile` → `smartphone` · `always-here` → `power` · `never-here` →
  `power-off` (both accented when set). Menu items: glyph + the five final labels
  (`Follows your devices` / `Computers only` / `Phones only` / `Always on here` /
  `Never on here`), current checked. Implementer verifies `power`/`power-off` don't
  collide with DESIGN.md's icon registry; the DESIGN.md update (§3) records them.
- **C-#7 hit target:** the clickable area is the icon trigger only (its natural glyph
  box + standard padding). Clicking anywhere else in the row does nothing. No stored
  value ever changes without an explicit menu selection. Tooltip (`aria-label`) names
  the current state, per the `renderScopeCycle` precedent.
- **After install / Enablement fallback menus:** keep textual triggers (no glyph
  vocabulary for them) but restyle their triggers to the same trigger box treatment so
  the card has one visual family of controls.

## §3 DESIGN.md currency (merge gate)

Update `docs/design/DESIGN.md` on this branch to document the C grammar as current state
(not a changelog): type sections + real collapse + header typography; unified row anatomy
(fate sentence verb table pointer to the spec, chips); expanded card anatomy (key column,
value adjacency, row set); the rule-control decisions above (icon+menu in cards, cycle in
Settings drawers, `power`/`power-off` additions to the icon registry); the vocabulary
rule (this device / your other devices / the store). Prose follows the file's existing
style and structure; supersede outdated pre-C panel sections in place.

## Gates & verification

Suite untouched unless a pure helper changes (then extend tests); build clean; lint 0
errors / ≤58 warnings. Manual criteria = ledger FAIL CRITERIA (C-#5..#10), plus: clicking
blank card space changes nothing (C-#7), both rule triggers read as one control family.
Redeploy llm only.
