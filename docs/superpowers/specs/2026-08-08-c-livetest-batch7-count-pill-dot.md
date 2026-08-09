# C live-test batch 7: section count pill loses its leading dot — design

Date: 2026-08-08 · Scope: C live-test issue C-#18 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先修 C-#18")

Authority: the pre-C 定稿 (bare number, main@7e6078a SyncCenterView.ts:1587), the C
master spec §2 (`6 of 31`), and DESIGN.md:220 (`N of M`) all agree — the `· ` prefix in
`sectionCountLabel` (panelModel.ts:259-261) is implementer drift.

## Change

- `sectionCountLabel(total, visible, filtered)` returns `${total}` unfiltered and
  `${visible} of ${total}` filtered — no `· ` prefix in either form. Both panes (main
  list renderTypeSection, remote pane heads) inherit automatically; verify no OTHER call
  site prepends its own dot afterwards.
- Update the function's own tests to the dotless strings.
- Docs sweep for currency: any `· N` / `· 9 of 31` count-pill wording in
  docs/design/DESIGN.md and docs/superpowers/specs/2026-08-07-c-livetest-batch4-remote-pane-grammar.md
  (batch-4 spec says "count pill `· N`") corrected to the dotless form. The C master
  spec §2 already reads `6 of 31` — leave it.

## Gates

Suite 1086 green with the updated assertions; build clean; lint 0 errors / ≤58 warnings
(ceiling, zero new); redeploy llm AND kickstart (both run the branch build). FAIL
CRITERION (ledger): section-head count pills read `10` / `6 of 31` — no leading dot —
in both panes.
