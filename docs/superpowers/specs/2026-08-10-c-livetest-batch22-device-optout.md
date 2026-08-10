# C live-test batch 22: per-device item opt-out via the Stop-syncing menu — design

Date: 2026-08-10 · Scope: C live-test issue C-#45 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: main · Status: 定稿 —
mockup https://claude.ai/code/artifact/c3b337c0-6cfd-4396-9267-2dabfe253cf9 (v3,
single button + menu, user-approved "A"). Copy is mock-final.

## §1 The rule: a device can opt out of an item

- New per-device item rule, fleet-shared via self-sync and keyed by device identity —
  the SAME identity + storage pattern the Runs-on here-rules already use (implementer
  verifies how memberRules key devices and mirrors it exactly; report the shape, e.g.
  `settings.items[id].<deviceOff-shaped field>`).
- Semantics when set for THIS device: the item is skipped in BOTH directions (apply
  never installs/writes, capture never reads), leaves every count/pill, is excluded
  from select-all and stagedPayload, and its row renders inert. Other devices are
  untouched; the store is untouched (nothing becomes leftover).
- Layering vs the existing global Stop syncing: global = item leaves the sync list
  everywhere (existing StopSyncingModal flow, byte-identical); per-device = this
  device ignores it while the fleet keeps syncing.

## §2 Presentation: reuse C-#24's excluded-honesty path

- An opted-out row renders exactly like a rule-excluded row: sentence
  `— Not synced on this device`, chip `your rule`, no checkbox, fate bucket ok
  (folds into the ✓ fold), direction null.
- Card State clause (mock-final): `Not synced on this device — you turned it off
  here. Your other devices keep syncing it.` (distinct from the class-rule clause so
  the cause stays honest).
- The remote panes on THIS device show the same excluded presentation for the item
  (honest — never pretend the item doesn't exist).
- Implementation seam: extend the existing excludedHere derivation (groupExcludedHere
  or a sibling fact feeding the same FateInput.excludedHere → rowFate branch) so the
  render path is genuinely shared, not duplicated; the CLAUSE differentiates by cause.

## §3 Control: single Stop-syncing button + scope menu (mock-final)

- The card footer keeps ONE quiet action `⊘ Stop syncing` (same placement/icon).
  Click opens a Menu (same idiom as the carrier chip's menu):
  - `On this device` — applies the per-device rule instantly, no modal (reversible in
    place), then re-render.
  - `Everywhere…` — opens the EXISTING StopSyncingModal, zero changes to it.
- On an already-opted-out row the same button's menu reads:
  - `Sync on this device again` — clears the rule instantly.
  - `Everywhere…` — as above.
- Mobile: menu is native (Menu works on mobile); footer stacking per batch-21 rules.
- canStopSyncing gating unchanged (self row and carriers keep their existing
  behavior; the carriers' own menu is NOT this menu).

## §4 Safety & runner

- Runner-level guard, not just UI: capture/apply payload assembly must skip opted-out
  groups even if a stale selection sneaks in (loud skip note is unnecessary — they
  simply cannot enter the payload; a thrown error on explicit API misuse is fine per
  repo error rules).
- Backfill/heal paths (lock labels etc.) must not resurrect or write the item on an
  opted-out device; verify capture-tail heal skips it.
- Adopt on a fresh device: adopting a store whose self-config marks THIS device
  opted-out honors the rule immediately (rules are fleet-shared, keyed by device —
  a device adopting sees only ITS own key; report how device identity is resolved at
  adopt time).

## §5 Tests

- Rule model: set/clear round-trip byte-clean (C-#26 prune discipline: clearing the
  last rule removes the field entirely); fleet-shared shape (other devices' keys
  survive a local set/clear untouched).
- Fate: opted-out input → excluded presentation (sentence/chip/bucket/unstageable);
  the new clause branch; class-excluded rows keep their existing clause byte-identical.
- Payload: staged selection including an opted-out group → payload excludes it (both
  directions).
- Existing suite is the fence (1217 baseline).

## §6 Gates & verification

Suite green + new; build clean; lint 0 errors / ≤58 warnings (ceiling, zero new);
NO commits; no Claude attribution. Deploy llm + kickstart. Live verification
(kickstart — the real use case): open Remotely Save's card → Stop syncing →
On this device → row flips to `— Not synced on this device` + `your rule`, leaves
To apply and select-all; Apply-all runs without touching it; menu shows
`Sync on this device again` and clearing restores the To-apply row; main.vault
(other device) state unchanged. Emulated-mobile spot-check of the menu + footer.

## §7 Excluded rows get their own fold and pill (added 2026-08-10, user 定稿 "A")

Mockup: https://claude.ai/code/artifact/fd4b129d-6db6-4d91-80e3-7049f317dc96 (option A).
Problem: an opted-out row currently lands in the `ok` bucket, so a user who just
turned an item off here still reads it inside `✓ N items in sync` — the count lies to
the person who caused it.

- `fateBucket` gains a fifth value `excluded`, returned for BOTH causes (opt-out and
  C-#24 class exclusion — same user-rule family, same placement), after the stageable
  checks and before `nothingYet`. `fateBucketCounts` gains its own tally; sidebar
  badges and header pills follow the same fan-out the existing buckets use.
- Section trailing fold: `⊘ N item(s) not synced on this device` — rendered in the
  same style as the `✓`/`○` folds, order `✓ → ⊘ → ○`. Rows inside sort by name.
- Filter pill: `Not synced here N` (copy 定稿 2026-08-10 — deliberately NOT "Skipped":
  that word is already run-event vocabulary, `⚠ update skipped`
  ConfigSyncCore.ts:800, and this is a standing state, not a run outcome; the wording
  is verbatim-consistent with the row sentence so pill → rows maps at zero cost).
- Empty state: N = 0 renders neither fold nor pill (matching `✓`/`○`).
- Everything else in this spec is unchanged; rows keep their sentence/chips/clause.

## §8 Section body regains its fill; head gets air (C-#47, user 定稿 A″ + A″-1)

Mockup: https://claude.ai/code/artifact/7821ece0-e1d3-4ca4-bd21-595ee68a2689 (v4).
Archaeology: section CSS is unchanged from 1.0.0 → 2.16.0. Pre-C, main-list rows lived
in a FILLED card (`--background-secondary` + border + radius) and sections were rare
colour-accented exception boxes. The C rework made every category a section, and
`.config-sync-section .config-sync-card` strips the nested card's background/border —
so rows lost their fill, the head lost anything to sit against, and today the expanded
drawer (`.config-sync-itemcard`, still filled) outranks the row list that owns it.

- Section body (the nested `.config-sync-card` inside `.config-sync-section`) regains
  `background: var(--background-secondary)` + `border-radius`; it KEEPS `border: none`
  and `padding: 0` so geometry does not move (batch-3 ① checkbox-column rule — verify
  by probe that head / rows / select-all still share one right edge).
- Section head gains `padding-bottom: var(--size-4-2)`; NO hairline (material contrast
  does the separating).
- Section title lifts `--text-faint` → `--text-muted` (C-#1 uppercase/small/letter-
  spaced header identity unchanged).
- Drawer drops a level (A″-1): `.config-sync-itemcard` inside a section renders with
  NO background, keeping its border + radius — hierarchy is box > filled block >
  outlined drawer.
- Collapsed sections have no body, therefore no fill — the dashed frame already reads
  as a closed box (`.is-open` semantics unchanged).
- Category sections stay neutral (no colour); state sections (leftover, orange) keep
  today's accent — the pre-C "frame colour = semantics" rule still lives there.
- Remote pane's static sections get the same treatment (always open → always filled).
- Mobile: same rules, no extra height; unrelated to C-#39's shrink ladder.
