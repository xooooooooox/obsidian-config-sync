# C live-test batch 12: fields-mode Settings-sync honesty + two write/render polish riders — design

Date: 2026-08-09 · Scope: C live-test issues C-#25, C-#26, C-#27 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修")

## §1 C-#25 · the card never offers a choice that persists nothing

- Ground rule: the whole-file `fileRule` is legal ONLY where the manifest validator
  allows it. The implementer verifies the exact validator rule (manifest.ts — batch-11
  review cited "type:'file' plain-mode groups only") and mirrors it: the card's
  Settings-sync 3-option menu renders ONLY for items where a fileRule write is legal.
- For a fields-mode item: no icon-menu; the value renders as non-interactive text
  `Per-key rules decide — see More` (vocabulary consistent with the More row's
  "Per-key rules, locks & folders"). No icon claiming "All devices".
- For an encrypted-mode item: whatever the validator says — if fileRule is illegal
  there too, same honest treatment with mode-appropriate wording (implementer proposes,
  copy stays within the vocabulary rule; if legal, menu stays).
- `setItemFileScope` gains a guard: writing to an item whose mode makes fileRule illegal
  throws (loud, never silent no-op) — the UI no longer offers it, and the API stops
  lying to any future caller.
- Settings tab parity CHECK (report-only): does the Settings tab's file-row scope cycle
  render for fields-mode items, and if so does it also silently discard? Investigate and
  REPORT with file:line — do not change the Settings tab in this batch without a
  controller ruling.

## §2 C-#26 · write-back prunes semantic defaults

- `setItemFileScope(..., "all")` (and any path through it) prunes: a resulting
  `fileRule` of `{scope:"all", encrypted:false}` is removed entirely; a resulting
  `settingsFile` deep-equal to the default skeleton (mode plain, empty rules/perItem, no
  fileRule) is removed entirely; an `ItemConfig` reduced to the default shape stays as
  it was stored before if it existed (do not over-prune enabled/companions). Encrypted
  `true`, any rules/perItem content, and non-plain modes always survive.
- Result: a scope round-trip is byte-clean against the prior state (the exact residue
  that hit the user on 2026-08-09 cannot recur).

## §3 C-#27 · no dead checkbox

- `renderTypeSection`'s head select-all checkbox is not rendered at all when
  `checkable.length === 0` (today it renders disabled — e.g. pre-adopt Community with
  only the self row).

## §4 Tests

- Menu-legality helper (pure): plain → menu; fields → no menu; encrypted → per
  validator finding. setItemFileScope guard throws on illegal mode (test via the
  plugin-instance harness used in batch 11).
- Prune truth table: all-default → removed; encrypted:true survives; rules/perItem
  survive; round-trip byte-equality (write desktop → write all → deep-equal original).
- Checkbox: pure-boundary if extractable, else manual note.

## §5 Gates & verification

Suite 1129 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA (llm): App settings (fields) card
shows `Per-key rules decide — see More` with no menu; Hotkeys (plain) still has the
working 3-option menu and a desktop→all round-trip leaves data.json byte-identical;
pre-adopt-style empty section shows no checkbox (verify by probing DOM absence where
checkable=0).
