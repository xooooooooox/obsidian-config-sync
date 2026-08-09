# C live-test batch 11: rule-excluded items tell the truth — design

Date: 2026-08-08 · Scope: C live-test issue C-#24 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("开工", plan agreed in discussion)

## §1 Excluded-state honesty

- **Fact**: `FateInput.excludedHere: boolean` — the item's file-rule scope (the compiled
  group's device scope) excludes THIS device's class (desktop/mobile). Derived, not
  stored. The implementer first root-causes WHERE exclusion currently manifests in the
  status chain (C-#7 evidence: scope=mobile on desktop reads plain in-sync) and derives
  the fact at the same layer facts like `desktopOnly` come from.
- **Row**: when the family presentation is otherwise neutral (no directional member, no
  conflict) and `excludedHere` — sentence `— Not synced on this device` (glyph `—`,
  unstageable) + chip `your rule`. A family with directional members keeps its
  directional sentence (a companion may still sync; don't mask real work).
- **Card**: STATE clause `Not synced on this device — your Settings sync rule excludes
  it.` The Settings sync icon row already shows the accented non-default state; no
  control changes.
- **Bucket**: stays neutral `ok` (inert, unstageable, inside the "N items in sync"
  trailing fold, counted under In sync) — the wording is what lied, not the inertness
  (decision agreed with the user).
- Symmetric for mobile devices (desktop-only rule on a phone). Vocabulary rule holds.

## §2 Self capture-nudge sensitivity (verify, then fix only if real)

- Protocol (live, llm): change a rule via the real write path
  (`setItemFileScope("hotkeys","mobile")`), let the status machinery settle (explicit
  refresh), inspect `selfStatus` (`state`/`contentChanged`); restore to "all". Repeat
  with a `memberRules` write for coverage.
- If rule-only changes never flip the self item to a to-capture presentation, root-cause
  (suspects: baseline/ledger auto-updating on saveSettings, masking the change) and fix
  so ANY config-sync settings change the store copy doesn't have surfaces as self
  to-capture. If they DO flip (the earlier ~3s observation was timing), document the
  verification in the report — no code change.

## §3 Tests

- fateModel: excludedHere truth table (neutral+excluded → new sentence/unstageable;
  directional family unaffected; excludedHere false → byte-identical sentences).
- Bucket: excluded rows land in `ok` (extend fateBucket/rowBucket-level tests).
- Self: if §2 yields a fix, a test pinning rule-change → self group state change.

## §4 Gates & verification

Suite 1114 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA (llm, then restore): set Hotkeys
to Mobile only → row reads `— Not synced on this device` + `your rule` chip (never
`— In sync`), card STATE matches, row stays unstageable in the in-sync fold; self item
signals a change to capture (or §2 documents that it already did).
