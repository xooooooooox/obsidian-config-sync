# C live-test batch 10: fate-driven buckets + interaction-scoped rendering — design

Date: 2026-08-08 · Scope: C live-test issues C-#23, C-#22 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("先修了")

## §1 C-#23 · one bucket derivation, from fate

- New pure mapping (panelModel, beside the fate consumers):
  `fateBucket(fate, nothingYet): "conflict" | "apply" | "capture" | "ok" | "none"` —
  `⚠` → conflict; stageable `↓` → apply; stageable `↑` → capture; else nothingYet →
  none; else ok. (`nothingYet` comes from the same FateInput already computed — no new
  state.)
- ALL row-bucket consumers switch to it, replacing raw `familyState` reads:
  1. the section partition (active / insync-fold / nosettings-fold,
     SyncCenterView.ts:1781-1786) — active = conflict|apply|capture; the folds hold
     ONLY ok / none buckets;
  2. filter-pill counts (`bucketCounts` feed, :782) — apply pill counts the apply
     bucket, capture the capture bucket, `In sync` = ok, `No settings yet` = none;
     conflict rows keep EXACTLY their current pill placement (implementer states what
     that is today and preserves it — this batch moves only the fate-vs-state divergent
     rows, i.e. enable/install-only actions sitting on no-settings/in-sync states);
  3. filter visibility (`visibleUnderFilter` feed, :1730);
  4. the sidebar per-category badges and anything else feeding off
     `familyState`-as-bucket (implementer greps `familyState(` and reclassifies each
     call site: bucket-like → fateBucket; genuine GroupState semantics — e.g. conflict
     detection, locked bypass — stay).
- Result: a `↓ Turns on` row is active, counts under To apply, shows under the To apply
  filter, never sits in the no-settings fold. One derivation, three surfaces agree.

## §2 C-#22 · interactions stop paying for the world

Measured (llm, 109 rows): full `render()` = 1310ms synchronous; fate derivation ≈ 85ms;
≈ 11ms/row DOM+host-lookup cost. Two-pronged:

- **Toggle = DOM flip, never a rebuild.** Section-head collapse/expand and
  trailing-fold toggle mutate the existing DOM in place (flip `is-open` class, chevron
  glyph, line text; closed→open builds JUST that section's card / that fold's rows into
  the existing container; open→closed removes them). Mirror of the C-#9 row-expand
  precedent (fateEl.hidden flip, no render). No `this.render()` on these paths.
- **One fate pass per render.** Memoize the per-row fate/input (keyed by group name)
  for the duration of one render cycle — partition, counts, filters, and row rendering
  currently each re-derive. Invalidate at the top of `render()`/`reload()` (any data
  change). If profiling shows per-row host lookups (resolvedPath/displayParts/availOf)
  dominate the ~11ms/row, memoize those the same way; record before/after numbers in
  the report.
- **Checkbox / select-all stay correct without a full pane rebuild** if feasible within
  this batch: staging toggles update the affected checkboxes, section-head tri-state,
  section `N selected` hints, and the footer summary in place. If a genuinely scoped
  implementation is not reachable, they may keep full render THIS batch — measure and
  state the residual cost in the report; the toggles above must not regress either way.
- Full render remains for: filter/search transitions, reload/data changes, run
  completion.

## §3 Tests

- `fateBucket` truth table (all five outcomes; enable-only ↓-on-no-settings → apply;
  conflict preserved).
- Bucket-consumer parity: counts derived via the new path for a mixed row set match the
  expected pill numbers (extend existing bucketCounts/panelModel tests).
- Perf/toggle behavior: manually verified (no DOM harness) — report must include live
  before/after `render()`-vs-toggle timings from the deployed vault.

## §4 Gates & verification

Suite 1100 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA: (C-#23) a `↓ Turns on` row is
active/To-apply-counted/To-apply-visible and outside the fold; (C-#22) section collapse
and fold toggle respond < 100ms perceived on the 109-row llm (CLI-measured toggle path
< 50ms).
