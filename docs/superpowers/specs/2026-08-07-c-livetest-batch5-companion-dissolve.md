# C live-test batch 5: companion groups dissolve into their parent object — design

Date: 2026-08-07 · Scope: C live-test issue C-#15 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("开工")

Authority note (the lesson C-#15 recorded): the C master spec is the grammar authority —
`Parent › Name` object rows are pre-C residue in BOTH panes, even though the main list
ships them today. This spec extends the C master spec
(2026-08-06-sync-center-unified-grammar-design.md §1 "appears exactly once", §3's
Appearance verb `↓ Applies theme & snippets — live`) down to companion groups.

## §1 The family model

- A **family** = a parent object group + every companion group owned by its item
  (registry `groupOwners`: def-level presetCompanions — appearance's `themes`/`snippets`
  — and any item's configured companions). Custom groups (`+ Add folder`) are NOT
  companions and stay their own objects; the legacy v3 `enabled-css-snippets` switch-list
  group is out of scope (rare, not a dir companion — leave as-is).
- In the Sync Center, a family is ONE object: one row in the main list, one diff entry in
  the remote pane. `Parent › Name` object rows disappear from both panes. The `Parent ›
  Name` display idiom survives ONLY outside the object grammar (Settings drawers, run
  reports — unchanged).
- Aggregation happens over the per-group statuses the engine already produces (each
  companion keeps its own scope/devices filtering; a scope-excluded companion simply
  contributes nothing on this device). No storage or compile change: groups remain the
  run/store currency; only presentation and staging fan-out change.

## §2 Family fate (main list)

Derived from the member GroupStates (parent + companions), feeding the existing
`rowFate`/`effectiveFate` chain:

- All members in-sync → in-sync. All nothing-yet → nothing-yet. In-sync/nothing-yet mix
  → in-sync presentation (nothing actionable).
- Actionable members all one direction → that direction. Verbs:
  - parent settings payload changed → existing settings verb (`applies settings` /
    `captures settings`), plus install/update/turns-on facts from the parent as today;
  - companion file changes (summed count N > 0) → the folder verb joins:
    `applies N files` / `captures N files`;
  - Appearance override unchanged: `↓ Applies theme & snippets — live` /
    `↑ Captures theme & snippets` replace the settings+files verbs (copy from the C
    master spec §3, already shipped).
- Any member in per-file conflict, OR actionable members in BOTH directions
  (e.g. appearance.json to-apply while a snippet is to-capture) → the family is
  `⚠ Changed on both sides`: unstageable until resolved via the existing Resolve control
  (`Use theirs ↓` / `Keep mine ↑`), excluded from select-all — the conflict grammar
  applies at family level with no new UI. Resolving picks ONE direction for the whole
  family's next run (the other direction's members simply become the next run's work).
- Filter pills / footer counts / sidebar category counts count families (one object),
  never members.

## §3 Staging & payload (main list)

- The family row has one checkbox. Staging it expands, at payload-build time, to the
  member group names actionable in the effective direction (parent and/or companions) —
  `stagedPayload` output stays a list of group names per direction; only the row→groups
  mapping changes from 1:1 to 1:family. Conflict-choice and direction-override state stay
  keyed by the PARENT group name.
- Run mechanics, reports, switch lists, exceptions: untouched (groups in, groups out).

## §4 Expanded card (main list)

- The family card's `Files` section lists every member's entries: parent entries as
  today; companion entries displayed with their companion-dir prefix (`themes/<file>`,
  `snippets/<file>`) — same direction-aware `fileEntryFor` presentation, diff/view
  intact.
- `On apply`/`On capture` clause = the family sentence (§2). `Settings sync` menu keeps
  editing the PARENT item's file rule (companion scopes remain Settings-drawer
  territory, reachable via `More` — no new card controls).
- No other card rows change.

## §5 Remote pane

- Companion diff entries fold into their parent's entry: group remapped to the parent
  group, each file's `itemRel` prefixed with the companion group name
  (`themes/Blue Topaz.theme.css`), `+N ~N −N` chips aggregate, expansion lists the
  merged file rows (existing renderer). One `Appearance` entry carries the whole family.
- Attribution uses the same owner mapping; on a fresh device it works for def-level
  preset companions (static registry). A companion knowable only from local settings
  that don't exist yet falls back to a standalone entry (honest degradation, same rule
  as batch 4's label fallback).
- Sections/labels/on-off lines from batch 4 unchanged.

## §6 Tests (extend the suite, DOM-free)

- Family mapping: groupOwners-driven `familyOf`/`companionsOf` derivation — presets,
  configured companions, custom groups NOT families, self excluded.
- Family fate truth table: all-in-sync; in-sync+nothing-yet; single-direction with
  settings only / files only / both (verb joins, count sums); appearance override;
  per-file conflict member; mixed directions → conflict; scope-excluded companion
  contributes nothing.
- Staging expansion: family row staged → member groups actionable in the effective
  direction only; conflict family unstageable until resolved; resolved direction expands
  to that side's members.
- Remote fold: companion entries merge into parent (itemRel prefixes, chip sums);
  unknown-owner companion stays standalone; carrier/on-off behavior from batch 4
  untouched.

## §7 Gates & verification

Suite ≥1033 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling —
zero headroom); redeploy llm only. Manual FAIL CRITERION (ledger C-#15): no
`Parent › Name` object rows anywhere in the Sync Center; the Appearance row's card lists
theme/snippet entries and staging it moves the whole family; the remote pane shows one
Appearance entry aggregating the family diff. DESIGN.md currency for the family grammar
in the same batch.
