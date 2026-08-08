# C live-test batch 14: adopt imports every self-synced field — design

Date: 2026-08-09 · Scope: C live-test issue C-#31 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修")

## §1 The completeness rule

- Verified gap: the store self-copy carries `bratPluginIndex` (4 entries) but
  `adoptConfiguration` did not import it — llm post-adopt had `{}`, so betaIds was
  empty and the 4 BRAT-tracked plugins classified as plain community with a wrong
  install source.
- Rule: **adopt imports exactly the set of fields the self COMPARE tracks** — the two
  must share one field list, not two hand-maintained ones. The self compare excludes
  only the device-local trio (`rootPath` / `remotes` / `localMembers`, per the existing
  selfPresetRules); everything else it would flag as a difference is something adopt
  must bring over. Implementer: enumerate what adopt copies today, derive both adopt
  and the compare-exclusion from ONE shared constant (or adopt = "store copy minus the
  device-local trio merged over local"), and list every field the old adopt silently
  skipped in the report (bratPluginIndex is confirmed; find any siblings — e.g.
  memberRules was reportedly imported, verify).
- Behavior guard: adopt must NOT clobber the device-local trio, and must go through the
  normal settings save path (recompile, notify) as today.

## §2 Tests

- Adopt truth table via the plugin-instance harness: store copy with
  bratPluginIndex/memberRules/items/customGroups + local trio values → post-adopt
  local equals store for all synced fields, trio untouched.
- The one-list invariant: a test that walks the shared constant and asserts the
  compare-exclusions and adopt-exclusions are the same set (a future field added to
  settings cannot silently split them again).

## §3 Gates & verification

Suite 1157 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA (llm): re-running Adopt imports
the index (bratPluginIndex 0 → 4); the 4 rows (my-text-tools / slides-rup / ioto-update
/ simpread) then show the via-BRAT install source in their cards; remotes/rootPath/
localMembers unchanged by the re-adopt.
