# C live-test batch 15: on/off list members carry their names — design

Date: 2026-08-09 · Scope: C live-test issue C-#34 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修")

## §1 Data: memberLabels on the carrier lock entries

- The two carrier lock entries (`core-plugins`, `community-plugins`) gain an optional
  `memberLabels: Record<string, string>` (element id → display name).
- Writers:
  1. capture of a carrier group records memberLabels for every list member this device
     can resolve (installed manifests — community via `getInstalledPluginName`, core via
     `getCorePluginName`); unresolvable members simply absent;
  2. `backfillLockLabels` (batch 6) extends to heal memberLabels the same way, so one
     startup on a configured device populates them with no capture needed; same
     write-only-on-change and capturedAt-untouched guarantees.
- The heal MERGES additively per id of the CURRENT store list — freshly resolved locally
  wins (refreshes a stale name), otherwise the existing entry's name for that id survives,
  otherwise absent; an id no longer in the store list is dropped. "Can't resolve locally"
  must never erase a name only some OTHER device could resolve, or two devices with
  different plugin sets would each overwrite the other's names on every heal (a
  perpetual lock-drift nag) and the "ids only where unresolvable anywhere" criterion
  would regress to "unresolvable on the last device to heal".
- Lock validator/parse accepts and preserves the field; absent map = today's shape
  (fully back-compatible both directions).
- Structural non-case: a community plugin that is OFF (never in the store's on/off array
  at all) carries no name here — it either has no row to name, or, if individually
  synced, its name comes from that group's own C-#14 label instead; this is not a bug.

## §2 Display chain

- Local: the label resolution for a `plugin-<id>` / core group WITHOUT its own
  lock-entry label falls through to the carrier's `memberLabels[id]` before the bare-id
  fallback (extend `resolveHostStoredLabel`'s lock lookup or its host feeder — one
  chain, no second path; main list, drag/staging labels, progress toasts all inherit).
- Remote pane: `remoteLockLabels` gains the same fallback from the remote lock's
  carrier memberLabels (batch-6 chain position: after own-entry labels, before id).
- Honest id fallback unchanged for genuinely unresolvable names.

## §3 Tests (DOM-free)

- Lock write: capture + backfill produce memberLabels for resolvable members only;
  no-change write skipped; capturedAt untouched; legacy lock without the field parses.
  Merge: a name unresolvable on this device survives from the existing map (superset
  preservation); a removed-from-list id is dropped; local resolution refreshes a stale
  existing name; two-device convergence (a heal shaped like each device leaves the
  merged map unchanged the second time).
- Display: own-entry label wins over memberLabels; memberLabels win over id; core and
  community both; remoteLockLabels sibling behavior.

## §4 Gates & verification

Suite 1160 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Live verification split (data must travel):
kickstart's startup heal writes memberLabels into its store.lock.json (verify locally,
capturedAt untouched); llm's MAIN list shows the names only after the store reaches it
(user vault push → llm pull refresh — same loop as C-#14; the batch is complete when
kickstart's lock carries the labels and the chain is test-proven; the llm visual is the
user-side confirmation afterwards).
FAIL CRITERION (ledger C-#34): post-propagation, llm's enable-only rows read real names
(Completr, Copy Block Link, Quick Explorer…); ids only where unresolvable anywhere.
