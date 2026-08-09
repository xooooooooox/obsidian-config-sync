# C live-test batch 16: report severity split + stable encrypted envelopes — design

Date: 2026-08-09 · Scope: C live-test issues C-#35, C-#36 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修")

## §1 C-#36 · unchanged encrypted fields keep their envelopes (core first — data honesty)

- Verified live: BRAT's capture-preview diff showed the encrypted token lines as
  replaced although their PLAINTEXTS are identical both sides — the preview re-encrypts
  with fresh salt/IV, so unchanged fields masquerade as changes and point the user at
  the wrong lines (the real change was `pluginSubListFrozenVersion`).
- Rule: wherever a would-be store content is produced (the card's capture-preview diff
  AND the real capture write path — implementer determines whether captureTransform
  already preserves; fix if not), an encrypted FIELD whose `fieldUnchanged` (mac) says
  unchanged REUSES the existing store envelope byte-for-byte; only changed plaintexts
  re-encrypt. Whole-file `encrypted` mode: same rule via `fileUnchanged` (unchanged
  file → existing envelope kept).
- Consequence to verify in tests: repeated captures of unchanged content leave the
  store byte-stable (no envelope churn, no spurious cross-device to-apply); a changed
  plaintext produces exactly one new envelope for that field.
- FAIL CRITERION (live): BRAT's card diff shows ONLY pluginSubListFrozenVersion lines;
  the token lines render no diff.

## §2 C-#35 · the run strip tells success-with-notes apart from failure

- Levels already exist (GroupResult.status ok/warning/error; stateNote). Rendering:
  - strip header: any error → `⚠ Applied with N issue(s)` (current error tone; N counts
    ERROR groups only); warnings only → `Applied · N note(s)` (success-frame strip with
    amber note count); clean → today's success strip;
  - message lines style by level: error red (today's), warning amber, ok-notes neutral;
  - the version-fallback message ("captured version X is no longer downloadable —
    installed Y instead") is a WARNING-level note on a successful install — never error
    styling, never counted as an issue.
- Implementer produces a table in the report: every current message/stateNote producer →
  level (and adjusts producers that misreport level, e.g. if the fallback is pushed as
  error today).
- DUPLICATE bug: the fallback line rendered twice in the live run — root-cause (two
  producers or a per-file loop) and fix at the source; a regression test pins single
  emission.
- Vocabulary rule holds; row chips (`installed & enabled X` / `install failed`)
  unchanged.

## §3 Tests

- Envelope stability: capture twice over unchanged fields/whole-file → byte-identical
  store output; one changed field → only that envelope differs; preview equals real
  capture output for the unchanged case.
- Report: level mapping unit tests for the producers table; strip header derivation
  (errors vs warnings-only vs clean); fallback message emitted exactly once.

## §4 Gates & verification

Suite 1187 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Live FAIL CRITERIA: (C-#36) BRAT card diff shows only
the frozen-version change; (C-#35) re-running an install-fallback scenario yields a
success-toned strip with one amber note, and a genuine failure keeps the issue-toned
strip (llm's IOTO Dashboard case can re-verify).
