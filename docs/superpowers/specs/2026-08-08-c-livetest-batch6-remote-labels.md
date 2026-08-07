# C live-test batch 6: real names in the remote pane (label plumbing + lock backfill) — design

Date: 2026-08-08 · Scope: C live-test issue C-#14 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed batch ("先修 C-#14")

Two stacked gaps, two fixes. No catalog/network lookup (ruled out in the ledger — the id
fallback is honest when no label exists anywhere).

## §1 Remote lock labels reach the pane (display gap)

- The remote compare path already reads the remote store.lock.json (the `lockDiffers`
  computation). Extract `label` fields from its group entries into a
  `remoteLabels: Record<string, string>` carried on the compare result
  (`RemoteCompareResult`), absent entries simply missing.
- The remote pane's display resolution becomes a four-step chain, in priority order
  (amended 2026-08-08 after Task 2 review: the original three-step prose let a remote's
  label shadow this device's OWN lock label, because passing a defined storedLabel
  bypasses displayName's internal lastLock fallback):
  1. the local manifest/custom-rule label (`findGroupByName`);
  2. this device's own store.lock.json label (host `localLockLabel`, the field
     `backfillLockLabels` heals);
  3. the remote lock's label for that group;
  4. the existing def-name/bare-id fallback inside `displayParts`.
  Applied consistently to BOTH row naming (`renderRuleName` call) and the section-sort
  `displayNameOf` callback, so names and ordering agree.
- Malformed/absent remote lock degrades to an empty map — never an error in the pane.

## §2 Lock label backfill at the source (data gap)

- New core pass `backfillLockLabels`: for EVERY entry in the LOCAL store's
  store.lock.json that this device can resolve a display name for (community
  `plugin-<id>` with the plugin installed → live manifest name; core settings ids →
  core plugin name — same resolvers capture already uses at
  ConfigSyncCore.ts:454/:477), write/refresh the `label` field. Entries it cannot
  resolve stay untouched. Write the lock ONLY when something actually changed; the
  lock's `capturedAt` is NOT a capture and must not change.
- Runs:
  1. at the end of EVERY capture run (regardless of which groups were processed), and
  2. once on plugin startup after the local store loads, when at least one resolvable
     entry lacks/has a stale label — the silent heal that fixes the user-confirmed
     dead-end (an all-in-sync store never processes a group, so labels never appeared).
- Propagation note (accepted semantics, document in code comment): a pull overwrites the
  local lock with the remote's (labels may drop until the next startup heal re-adds
  them); a push carries healed labels to the remote. Convergent, no loop.

## §3 Tests (DOM-free)

- Remote label extraction: lock with labels / without / malformed JSON / missing file →
  map contents; result carries them.
- Display chain: local label wins over remote label; remote label wins over id; id when
  neither.
- Backfill: label-less resolvable entries gain labels; unresolvable (not-installed)
  untouched; stale label refreshed; no-op write skipped (lock file untouched when
  nothing changed); capturedAt unchanged; runs on the capture path and the startup-heal
  condition triggers only when needed.

## §4 Gates & verification

Suite ≥1068 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
headroom); redeploy llm only. Live-verifiable on llm now: the pane still degrades to ids
(remote lock has no labels yet) with no errors, and llm's own store (after pull) heals
its config-sync entry on startup. FULL end-to-end (real names on llm's remote pane)
additionally needs one capture+push from a configured device running this build — the
user decides when/whether to put the branch build on such a device; not part of this
batch's deploy. FAIL CRITERION (ledger C-#14): after that capture, the fresh device's
remote pane shows real names for not-installed plugins; ids only where no label exists
anywhere.
