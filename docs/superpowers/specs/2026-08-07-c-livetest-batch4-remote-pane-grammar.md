# C live-test batch 4: remote pane speaks the C grammar — design

Date: 2026-08-07 · Scope: C live-test issue C-#13 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先修复这个问题")

Binding context: the alignment target is the MAIN LIST's existing C grammar — identical
section vocabulary, naming, and typography — not a new dialect. Ground truth verified
2026-08-07: the main list keeps the appearance family as three rows (`Appearance`,
`Appearance › CSS snippets`, `Appearance › Themes` via `displayParts` parent prefixes) and
dissolves only the carriers; the ledger's earlier "merge theme + snippets into one row"
fix direction is superseded by this spec (merging would diverge from the main list).
`docs/design/DESIGN.md` is the design-system authority; UI vocabulary rule binds all copy
(`this device` / `your other devices` / `the store`; remote names are proper nouns and
fine; never "carrier"/"switch list").

Presentation-layer only: `deepDiff`/pull/push semantics, the summary lines, the
"N more items match" line, the self-exclusion note, the action buttons, and the error
cards all stay exactly as they are.

## §1 Sections (paintRemoteCompareResult)

- Replace the pane's `SCOPE_ORDER`/`SCOPE_LABELS` grouping (Obsidian / Core plugins /
  Community plugins / Beta / Custom, flat `config-sync-sect` labels) with the main list's
  four type sections: `TYPE_SECTION_ORDER` + `TYPE_SECTION_TITLES` (Obsidian /
  Core plugins / Community plugins / Your folders), derived exactly the way the main list
  does it — `typeSectionForRow(scopeOf(group))` (beta merges into Community, custom is
  Your folders; see SyncCenterView.ts:531).
- Header markup/typography = the main list's section head family
  (`config-sync-section-head` + `config-sync-section-title` + neutral count pill `· N`,
  N = that section's entry count). NO disclosure chevron, NO collapse, NO checkbox, NO
  carrier chip in the remote pane — a triangle that does nothing is exactly ledger C-#1's
  decorative-affordance failure. If the shared head classes carry hover/cursor affordances,
  neutralize them here (static header).
- Sections with no entries hide entirely (current behavior kept).
- Entries within a section sort by composed display name (`fullName`-style
  parent › label, localeCompare) — never manifest order.
- The `OTHER_STORE_FILES_GROUP` pseudo-entry stays, sorted last, under Your folders.

## §2 Rows

- Row content is unchanged: name via `renderRuleName`, `+N ~N −N` chips, expandable file
  rows with inline diffs. One object = one row already holds here; the taxonomy and the
  carrier rows were the problem.
- Fresh-device parent attribution: `Appearance › Themes` / `Appearance › CSS snippets`
  must read as a family even when no local items are configured yet (this device led with
  bare `CSS snippets` / `Themes` — three unrelated objects). `parentCardLabel` gains a
  display-only fallback: when no ENABLED configured companion matches the group name,
  match DEF-level `presetCompanions` basenames (appearance's `themes`/`snippets`) and
  return that def's label. Configured companions still win; compile/claim semantics and
  reserved-name logic untouched.

## §3 Carrier presentation (the core of C-#13)

- `core-plugins` / `community-plugins` diff entries never render as object rows.
- Each renders as a pinned on/off line — the FIRST line inside its section (Core plugins /
  Community plugins), before any object rows, visually a line (like
  `config-sync-unchanged`-class lines), not a row card:
  - Collapsed: `On/off list · differs for N plugin${s} ▸` where N = number of plugins
    whose effective on/off membership differs between the store copy and the remote copy
    (order-insensitive, same equality the compare itself uses — if the entry exists, N ≥ 1).
  - Expanded (click toggles ▸/▾): first the flip narration, then the entry's standard
    file row(s) (`core-plugins.json · diff ▾` etc., existing renderRemoteFileRows):
    - `on at {remote}: a, b, c` — plugins on in the remote list but not in the store's
    - `off at {remote}: d` — plugins on in the store's list but not in the remote's
    - Omit an empty line; names comma-joined, sorted; no truncation (lists are short in
      practice; the diff below is the full record anyway).
  - Derivation parses both sides with the existing switch-list machinery
    (`parseSwitchList`); a null side (file missing) reads as the empty list — on a fresh
    store every remote-on plugin lists under `on at {remote}`.
- A carrier with no diff entry contributes nothing (no line, no "synced ✓" — absence of
  divergence is silence, matching rows-only-when-changed).
- A section whose ONLY content is its on/off line still renders (the line is content).

## §4 Tests (extend the suite, DOM-free)

- Section derivation: a pure helper taking `RemoteDiffEntry[]` + a category resolver +
  a display-name resolver → ordered `{ section, onOffEntry | null, entries[] }[]` —
  carriers extracted to `onOffEntry`, beta→community merge, custom→folders, display-name
  sort, empty sections absent, OTHER_STORE_FILES_GROUP last in folders.
- Flip narration: `(local: string | null, remote: string | null)` → sorted
  `{ onAtRemote: string[], offAtRemote: string[] }` for both carrier formats, incl.
  null-side and order-insensitive-equal (never called, but degrade to empty) cases; the
  collapsed-line count N = union of both lists' lengths.
- `parentCardLabel` preset fallback: unset items → parent "Appearance" for
  `themes`/`snippets`; a configured enabled companion still wins; non-companion names
  unaffected.

## §5 Gates & verification

Suite ≥1013 green including the new tests; build clean; lint 0 errors / ≤58 warnings;
redeploy llm only. Manual FAIL CRITERION (ledger C-#13, amended): the remote pane shows
no `Core/Community plugins on/off` object rows; its section headers, vocabulary, and
order match the main list (Your folders, beta inside Community); the appearance family
reads as `Appearance › …` even on a fresh device; carrier divergence surfaces as the
pinned `On/off list` line with per-plugin narration and the diff still reachable.
