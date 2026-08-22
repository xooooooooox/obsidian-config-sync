# Pull scope carries companions; conflict modal names its sources

Iteration 2.25.1. Approved mockup: "Config Sync 2.25.1 · Pull 计数与冲突来源" (session
artifact; V1 grouped sections adopted, row keeps the "N files" annotation). Copy in the
mockup is final.

## Context

Observed on a vault pulling from a vault-type remote: the panel says "To pull 1", the
button says "Pull 1 item", yet the conflict modal compares 134 entries and surfaces 5
conflicts, 4 of them theme files under an item the user never staged. Two defects
compound:

- **(a) Counts read locks, the merge reads bytes.** `remoteItemVerdicts` (status.ts)
  answers from the two `store.lock.json` files; `planImport` → `classifyMerge`
  (ConfigSyncCore.ts, merge.ts) compares raw bytes of every non-skipped store file. A
  file whose lock entries are absent or agree can still differ in bytes and become a
  conflict the counts never announced. In the observed case the local lock has no
  appearance/themes entries at all.
- **(b) Companion groups cannot be skipped.** themes/snippets are presetCompanions of
  Appearance (registry.ts). They have refs (`companionRef`, itemKeys.ts) but no rows:
  `familyGroups()` folds them into the parent row, so their refs never enter `allRefs`
  in `renderRemoteActionBar` (SyncCenterView.ts), never enter
  `skipRefsForSelection`'s exclusion list (remoteRows.ts), and `skipRelPredicate`
  (ConfigSyncCore.ts) therefore never skips their rels. Their files join every pull and
  push regardless of staging. Their verdicts, when they exist, also never reach the
  parent row's state (`remoteRowStatuses.stateOf` reads the parent ref only), so they
  cannot raise "To pull".

Defect (b) gets a behavior fix (Part A). Defect (a) keeps its lock-based counts by
design (content-comparing every file on every status pass is the cost we refused); its
user-facing answer is provenance in the modal (Part B).

## Part A — selection carries companions

**A1. Ref expansion at the staging seam.** Wherever staged rows become ref lists for a
run (`renderRemoteActionBar`: `picked` and `allRefs`), each parent ref expands to
itself plus its companion refs, derived from the compiled registry
(`companionRef(owner, path)` per presetCompanion). Consequences:

- `skipRefsForSelection` output now contains companion refs for every unstaged parent,
  so `skipRelPredicate` excludes their store files from `planImport`'s two file walks.
- Push (`pushTo(remote, skip, picked)`) gets the same expansion on both lists; the
  companion files travel only when their parent is staged, in either direction.

**A2. Companion verdicts raise the parent row.** `remoteRowStatuses.stateOf`
(remoteRows.ts) derives a parent's state from its own verdict OR any companion's:
any `pull` → store-newer, else any `push` → store-older. Counts
(`fateBucketCounts`) and the pill totals follow for free, since they read row states.

**A3. Row annotation.** When the folded companion evidence
(`foldCompanionEntries`, panelModel.ts) carries file differences and the row's
direction owes to them, the row shows a dim "N files" annotation after the name
(mockup, block 1). The expanded card's FILES area already lists the files; no new
surface beyond the annotation.

## Part B — conflict modal groups by provenance

**B1. The modal learns what was picked.** `pullFrom` receives the staged (expanded)
picked refs alongside `skipRefs` and threads them into the `ConflictModal`. For each
file conflict, resolve its rel to an owning ref (`resolveGroupByStoreRel`, local first,
remote second — same order planImport uses); the conflict is "picked" iff that ref is
in the picked set.

**B2. Two sections, headers carry the explanation.** Conflict rows render under
section headers, each present only when non-empty:

- `On items you picked · N`
- `Came along with the pull · N` — subtitle: `a pull compares the whole remote, and
  these also changed on both sides`

Row anatomy, All local / All remote, footer, and apply semantics are unchanged; the
two buttons still act on all rows.

## Acceptance

1. Observed scenario replayed (theme files differ in bytes, no local lock entries,
   remote's item rules leave Appearance's pull closed): stage only Config Sync →
   compared drops by the companion file count (134 → 130), conflicts 5 → 1, only the
   "On items you picked" section renders (mockup, block 2b). "To pull" stays 1 —
   correct, because this remote owes Appearance nothing.
2. Companion-verdict scenario (remote re-captures themes, pull direction open):
   Appearance row shows store-newer with the "N files" annotation, "To pull" counts
   it, unstaging it withholds the theme files from the run (mockup, block 1).
3. Push mirror of (1): unstaged parent → companion files stay out of the push.
4. Full-stage pull with both sections populated matches mockup block 2 (V1).

## Non-goals

- Byte-based status counts (defect (a)'s root): rejected for cost; B is its answer.
- Include-semantics for staging, scoping of sync-rule (definition) merges, remote-only
  items, or unattributable files: parked (mockup, block 3).
- Per-remote item exclusion (`Remote.excludeItems`): separate backlog entry.
- Making an unorderable difference actionable (a remote row's own Resolve): the existing
  "per-file conflict adjudication" backlog entry, not this iteration.

## Amendments from live acceptance (same iteration)

- **Modal numbers speak files and real writes only** (`mergeDisclosure`, merge.ts):
  definition identicals and kept-local definitions are invisible in the modal, so they
  left every count and the fold list. Zero-content auto box hides; header sub drops
  "· N items compared"; CTA drops the "0 +".
- **Section headers only on a mixed list**: all-picked → flat, came-along-only → the one
  explanatory header.
- **STATE clause split by cause** (`stateClauseText` → `unorderedChangeClause`): "Push
  only, so they stay there" may only be said when the remote's rule actually closes
  pull. With pull open, a quiet row with differing files means the records could not be
  ordered — observed live: pre-stamp lock entries (source-only, no capturedAt/hash) make
  `itemFreshness` return "undatable", which produces no verdict. The honest clause names
  the unblock that works no matter which side's record is stampless: capture on both
  sides, the winner last ("… but there's no way to tell which side is newer. Capture on
  both sides; the side captured last wins." — "newer", never "ordered": the clause is
  about telling the two copies apart in time, and "ordered" read as sorting).
- **Self hint gated and deduplicated**: the "…you can leave it out of this remote" line
  renders at most once per modal (the self item's data.json plus two sidecars can
  conflict together) and only while the remote carries no written rule for config-sync
  (`hasItemRule`, remoteRules.ts) — a stored rule means its user already knows the
  control the hint teaches.

## Docs to update in the same branch

- DESIGN.md: conflict modal section (provenance sections + final copy), remote row
  state (companion elevation), staging semantics (companions travel with parent).
- ARCHITECTURE.md: the `skipRefs` seam note — refs at this seam are now
  companion-expanded.
- README screenshots only if the conflict modal shot exists there.
