# C live-test batch 13: no direction without verbs + cause-voice nothing-yet copy — design

Date: 2026-08-09 · Scope: C live-test issues C-#28, C-#29 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修"; effect 定稿 in mock
https://claude.ai/code/artifact/74e72935-0f85-4520-814e-31c3cf13bde2 — mock copy final)

## §1 C-#28 · a fate with an empty verb set cannot exist

- Root-cause first (report the exact chain): why the five `stays off` core rows derive
  `direction: apply, stageable: true` with ZERO verbs (observed: bare `↓`; store has no
  settings data for the group, enablement needs no change). Expected mechanics:
  `hasSettingsPayload` false + no install/update + turnsOn false → sentence assembly
  empty while `stageableRow(presState)` still says stageable.
- Rule (spec-final): inside `rowFate`, when the assembled verb set for the derived
  direction is EMPTY, the fate degrades to the nothing-yet presentation — direction
  null, unstageable, `—` glyph, nothing-yet sentence (C-#29 copy below). Chips
  (`stays off` etc.) are unaffected. This is a derivation rule, not a render filter:
  "direction with no verbs" becomes unrepresentable.
- Guard the degradation precisely: it fires only on a genuinely EMPTY verb set — the
  appearance special, folder `Applies N files`, enablement-only verbs, and every
  existing non-empty sentence stay byte-identical (existing fate tests are the fence).
- Capture side symmetric if reachable (empty capture verb set → same degradation);
  state in the report whether any real input reaches it.
- Consequences that must fall out automatically (verify in tests): bucket → none
  (batch-10 fateBucket reads the degraded fate), select-all skips, stagedPayload never
  sees these rows, filter pills recount.

## §2 C-#29 · cause-voice copy (mock-final)

- Row sentence: `— No settings yet` (replaces `— Nothing to sync yet` everywhere the
  ROW sentence is produced).
- Card State clause for that fate: `No saved settings anywhere yet — neither this
  device nor the store has any.`
- Pill (`No settings yet N`) and fold line (`○ N items with no settings yet`) already
  speak this voice — unchanged.
- Sweep every producer/assertion of the old string (fateModel sentence, stateClauseText
  fallback, tests); update the C master spec §3 verb-table row and any DESIGN.md pointer
  that quotes the old copy (current-state voice).

## §3 Tests

- The 5-row scenario as a fate truth-table case: apply direction inputs with
  hasSettingsPayload false, turnsOn false, installed, no update → nothing-yet fate,
  unstageable, bucket none.
- Empty-verb degradation never fires on: appearance special, folder counts, turns-on
  only, settings only, install chains (byte-identical sentences pinned).
- Copy: new row sentence + card clause asserted; no test or source still contains
  "Nothing to sync yet".

## §4 Gates & verification

Suite 1144 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA (llm): the five rows (Format
converter / Publish / Random note / Slash commands / Slides) read `— No settings yet`
with `stays off` chip, no checkbox, inside the no-settings fold; To apply pill drops by
exactly those rows; select-all + Apply on Core plugins reports zero issues.
