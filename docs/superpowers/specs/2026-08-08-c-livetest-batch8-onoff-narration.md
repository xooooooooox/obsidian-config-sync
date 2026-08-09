# C live-test batch 8: on/off narration — capped, named, whole-list aware — design

Date: 2026-08-08 · Scope: C live-test issue C-#20 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("先按您说的这个方向改进", direction agreed in discussion)

Supersedes batch-4 spec §3's "no truncation" clause for the expanded flip narration.
Collapsed line (`On/off list · differs for N plugins ▸`) and the file-diff rows are
unchanged; only the expanded narration lines change.

## §1 Narration rules (per side, `on at {remote}` / `off at {remote}`)

Inputs per side: the flip list (sorted element ids from `onOffFlips`) and that side's
SOURCE on-set size (for `onAtRemote`: the remote list's total on-members; for
`offAtRemote`: the store list's total on-members).

1. **Whole-list case** — the side's flip count equals its source on-set size (every
   member flipped; covers the fresh/empty-other-side case):
   - `on at {remote}: its entire list — N plugins`
   - `off at {remote}: everything in your store's list — N plugins`
2. **Capped case** — otherwise, list at most 5 display names, then `and N more` when
   truncated: `on at {remote}: A, B, C, D, E, and 69 more`. ≤5 flips list all (current
   behavior, now with display names).
3. Empty side still omitted entirely (unchanged).

## §2 Display names

Narration names resolve through the SAME chain the pane's rows use: element id → group
name (community carrier: `plugin-<id>`; core carrier: the id itself) → the pane's
storedLabel closure → `displayParts`. Sort the narration by the DISPLAY name
(localeCompare), matching row ordering. No raw ids when a label exists anywhere;
id fallback stays honest when nothing resolves.

## §3 Shape

- Pure helper in panelModel beside `onOffFlips` (exact signature is the implementer's
  choice; must take the flip lists + per-side source sizes + a `displayOf(elementId) →
  string` resolver + the remote name, and return the ready-to-render side lines) with
  the truth table in §1 tested DOM-free (whole-list both sides, capped, ≤5, empty side,
  display-name sort, id fallback).
- View: `renderRemoteOnOff` builds `displayOf` from the section's carrier (element →
  group name → the existing storedLabel closure) and renders the returned lines.
  No other pane behavior changes.

## §4 Gates & verification

Suite 1086 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. FAIL CRITERION (ledger C-#20): expanded narration
never exceeds 5 names per side; names match row display names; llm's fresh-store case
reads `on at kickstart: its entire list — 74 plugins` (one line, no wall).
