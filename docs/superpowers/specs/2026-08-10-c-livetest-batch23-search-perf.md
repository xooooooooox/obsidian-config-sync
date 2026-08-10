# C live-test batch 23: the sidebar filter keeps up with typing — design

Date: 2026-08-10 · Scope: C live-test issue C-#48 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main · Status:
user-directed ("修"). Performance work — **profile first, optimize second**.

## §1 The measured problem (do not re-derive; extend it)

Live probes on kickstart (109 rows, build 25d8c88c64ae):
- one real keystroke, end to end (input event on the live element): **445ms / 400ms**;
- `renderMainRegion()` alone: **82-117ms**, the same whether type sections are
  collapsed or all expanded;
- sidebar scope re-render: **9ms**.
So ~300ms per keystroke lives OUTSIDE the main render — unattributed. The input
listener (SyncCenterView.ts:1288-1302) runs everything synchronously per keystroke,
with no debounce and no incremental path; entering search also calls
`expandAllTypeSections()`.

## §2 Phase 1 — attribute the cost (mandatory before any fix)

- Instrument the keystroke path end to end and report a table: handler total, and each
  contributor (qualifier autocomplete `qac`, `searching()`/`rowMatchesSearch` over all
  rows, pill pool recompute, per-row `deriveRow`/fate derivation and its memo hit rate,
  DOM build, layout/paint attribution where visible).
- Method: temporary `performance.now()` instrumentation driven through the real
  listener (headless harness or a scratch build — do NOT leave instrumentation in the
  shipped code), plus a jsdom/Node micro-benchmark for the pure functions where that
  is faithful. The ~300ms must be attributed to named call sites before a fix lands.
- Report the top 3 costs with numbers. The fix must target those, not a guess.

## §3 Phase 2 — the fix (shape follows the profile; these are the sanctioned tools)

- **Instant field, deferred work**: the input element must never wait on rendering.
  Debounce the heavy path (~120-150ms trailing, single timer, cancelled on unmount);
  the qualifier autocomplete stays synchronous if it is cheap (profile says).
  A trailing debounce must still settle on the final query — no dropped last keystroke.
- **Incremental over rebuild**: rows already exist in the DOM. Follow batch-10's
  in-place precedent (`buildTypeSectionCard`/`buildTrailingRows` flip DOM in place):
  a query change that only changes WHICH rows match should toggle row visibility and
  update counts, rebuilding only when the row set itself changes. Chip-overflow
  re-measure must still run for rows that become visible (refreshChipOverflow).
- **Memoize per-query derivations**: lowercased name cache for `rowMatchesSearch`,
  one pass for pill counts instead of per-pill filtering, reuse the existing
  `deriveRow` per-render memo rather than re-deriving per pill/badge/section.
- Behavior is frozen: same matches, same counts, same auto-expand on entering search,
  same focus/caret behavior, same autocomplete. This is a performance change only.

## §4 Tests

- Pure functions gain unit coverage where the profile leads (match cache correctness
  incl. case/qualifier forms; single-pass pill counts equal today's per-pill results).
- A debounce test with fake timers: rapid keystrokes produce ONE settled render with
  the final query; no lost final keystroke.
- Existing suite is the behavior fence (1257 baseline).

## §5 Gates & verification

Suite green + new; build clean; lint 0 errors / ≤58 warnings (ceiling, zero new);
NO commits; no Claude attribution. Deploy llm + kickstart.
FAIL CRITERION (live, kickstart, same probe method as §1): a real keystroke's handler
is **well under 100ms** and sustained typing keeps the field responsive; the settled
result (rows, pills, sidebar badges) is identical to today's for the same query.
