# C live-test batch 18: version-ahead capture rows say what capture records — design

Date: 2026-08-09 · Scope: C live-test issue C-#37 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main (post-merge; changes
stay UNCOMMITTED — the user's review state) · Status: user-directed ("修"; copy 定稿 in
mock https://claude.ai/code/artifact/2d0e4981-7989-4b45-8c30-9fac3179e9c2 — mock copy
final)

## §1 C-#37 · the version-ahead fact enters the fate model

- Scenario: files in-sync both sides, but the installed plugin version is newer than the
  store lock's recorded `sourcePluginVersion` (availability drift "ahead"). Today
  `presentedState` (panelModel.ts:135-137) relabels the row to-capture, yet fate derives
  the generic `Captures settings` → card `Shares your settings with your other devices`
  (a lie — settings are identical) and no Files row explains anything.
- `FateInput` gains `versionAhead: { installed: string; stored: string } | null` —
  computed in `computeFateInput` symmetric to `hasUpdate` (SyncCenterView.ts:798):
  `a.anchor === "plugin" && a.drift === "ahead"` → both versions from `a`. The
  implementer verifies `driftFor`'s guarantee that "ahead" implies both versions
  non-null and mirrors it exactly (no defensive fallback).
- `hasSettingsPayload` switches its source from the PRESENTED parent state
  (SyncCenterView.ts:813) to the RAW `r.status.state`. The only rows this flips are
  raw-in-sync + drift-ahead — exactly the relabel set. Verified safe: the footer
  `settings` counter is apply-side only (SyncCenterView.ts:2730-2737), and
  `directionOverride` has no writer post-C (Resolve replaced the toggle), so a pure
  version-ahead row can never derive an apply direction and can never reach the C-#28
  apply degradation.

## §2 Capture verb assembly (fateModel.ts)

- The capture branch composes segments with the existing `·` join grammar:
  the current turned-on/settings/folder verb chain first, then — when
  `versionAhead !== null` — `records version {installed}` appended.
- Resulting sentences (mock-final):
  - pure version-ahead: `Records version 2.2.3`
  - settings + version: `Captures settings · records version 2.1.0`
  - turned-on + version: `Turned on here — shares it · records version 2.2.3`
- The `captures files` fallback fires only when ALL segments are empty (unchanged
  behavior — a versionAhead row always has a segment now).
- Apply branch untouched; `versionAhead` never contributes an apply verb.

## §3 Card On-capture clause (stateClauseText, SyncCenterView.ts)

- Capture direction with `versionAhead` set (mock-final copy):
  - pure version-ahead: `Installed {installed} is newer than the store's {stored} —
    capture records it so your other devices can update.`
  - settings + version: `Shares your settings with your other devices — and records
    the newer {installed} so they can update.`
  - turned-on + version: `Turned on here — your other devices will turn it on the next
    time they apply. Also records the newer {installed} so they can update.`
- Derive branches from `input.versionAhead` + the existing flags, not by matching the
  new sentence strings; every non-version-ahead row's clause stays byte-identical
  (existing tests are the fence).
- Files row logic untouched (SyncCenterView.ts:2170-2173): renders only with real file
  changes — its absence on a pure version-ahead card is correct and intended.

## §4 Tests

- fateModel truth table: pure version-ahead (raw-in-sync relabel → hasSettingsPayload
  false, versionAhead set) → `Records version X`, glyph ↑, stageable; settings+version
  join; turned-on+version join; versionAhead null keeps every existing capture sentence
  byte-identical (existing suite fences).
- Clause coverage: the three new clause branches asserted through whatever harness
  stateClauseText already has; if none exists, extract the clause derivation into a
  pure testable helper rather than leaving it untested.

## §5 Gates & verification

Suite 1205 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, ZERO
headroom — new code must add none); **NO git commits** (leave all changes uncommitted;
no Claude attribution anywhere). Deploy llm AND kickstart after review. Live FAIL
CRITERIA (llm): IOTO Update row reads `↑ Records version 2.2.3`, card clause names
2.2.3 vs 2.2.2 with no "shares your settings" claim and no Files row; SimpRead same
with 4.0.0/3.0.0; Mindmap NextGen (genuine data.json change) renders byte-identical to
today including its Files row.
