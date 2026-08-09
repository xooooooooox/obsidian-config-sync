# C live-test batch 19: encrypted fate chip drops its emoji — design

Date: 2026-08-09 · Scope: C live-test issue C-#38 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main (post-merge; changes
stay UNCOMMITTED — the user's review state, joining batch 18's pending diff) · Status:
user-directed ("修"; applies the established DESIGN.md ruling — no new mockup)

## §1 C-#38 · the chip obeys DESIGN.md's no-emoji ruling

- The ONLY pictographic emoji rendered anywhere in the Sync Center is the string
  `"🔒 encrypted"`, produced twice — fateModel.ts:66 (`buildChips`) and
  SyncCenterView.ts:686 (the encrypted-no-passphrase synthetic fate) — and rendered as
  plain text by the chip loop (SyncCenterView.ts:2092, `config-sync-fatechip`).
- Rule (DESIGN.md §3): no emoji in copy; encrypted iconography is Lucide `lock`
  (§2.2 mode badge precedent; SettingTab's old " 🔒" suffix was already replaced,
  round-7 spec §2).
- Fix: both producers emit the chip string `encrypted` (plain text, no glyph). The chip
  renderer prepends a Lucide `lock` icon via `setIcon` exactly when the chip value is
  `encrypted` — `Fate.chips` stays `string[]` (no model change for one icon), the
  renderer owns presentation. Icon inherits the chip's text color (Lucide strokes use
  currentColor) so it themes like every other setIcon use; a minimal CSS touch for
  icon↔label gap/size is allowed if needed, following styles.css's existing badge/icon
  patterns.
- No other chip gains an icon; every other chip renders byte-identical.
- Sweep: update every test asserting `"🔒 encrypted"`; delete the stale 🔒 in
  jsonView.ts:5's comment (never rendered); after the change a pictographic-emoji sweep
  of src/ must come back empty (comments included).

## §2 Tests

- buildChips: encrypted → chip `encrypted` (and the no-passphrase fate's chip matches);
  existing chip assertions updated, everything else byte-identical (suite is the fence).
- Renderer icon wiring is DOM-side — manual verification per suite convention.

## §3 Gates & verification

Suite 1212 green; build clean; lint 0 errors / ≤58 warnings (ceiling, zero new);
NO git commits; no Claude attribution. Deploy llm AND kickstart. Live FAIL CRITERIA
(llm): IOTO Update's encrypted chip shows a themed Lucide lock + `encrypted`, no emoji
anywhere in the rendered Sync Center DOM (pictographic sweep of the panel's textContent
comes back empty).
