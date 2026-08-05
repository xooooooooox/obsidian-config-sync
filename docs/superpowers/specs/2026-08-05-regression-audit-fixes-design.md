# Regression-audit fixes (2.11.0 → HEAD sweep) — design

Date: 2026-08-05 · Scope: R1 R2 R5 R6 R7 R9 R10 of the 2026-08-05 round · Status:
approved (brainstorm). Findings verified firsthand at HEAD; R3/R4 live in the
section-groups-and-member-menu spec; R8 (2.13.1's leftover `config-sync-import` git
remote in user repos) adjudicated **no action** — manual cleanup.

## R1 · Stale-local-key guard must exclude per-item keys (2.14.x)

`baseHasStaleLocalKeys` (ConfigSyncCore.ts:287) matches raw `stripPatterns(effGroup)`
while every strip/compare in modes.ts filters through `excludingPerItem` — so a local
field rule whose pattern matches a per-item key flags that key forever: permanent
"to capture" plus a forced store-base rewrite on every capture (the per-item machinery
legitimately re-inserts the key). The guard's comment ("a per-item key is never a
scope:'local' field") is false — manifest validation only rejects perItem+encrypted, and
the rule-row UI offers "This device" one click away.

**Fix**: apply the same exclusion — `excludingPerItem(group, stripPatterns(group))`
(export it from modes.ts or move the helper somewhere shared). Test: a group with
`perItem.enabledCssSnippets` plus a local rule matching that key reports no stale key on
a base that contains it; a genuinely stale non-per-item key still reports true.

## R2 · Contract locals must not demote an encrypted group (2.13.3)

`withContractLocals` (ConfigSyncCore.ts:83) guards `fileRule` groups but not
`mode: "encrypted"` — it unconditionally rewrites to `mode: "fields"`, so during the
fields(local)→encrypted transition window a whole-file-encrypted custom group gets
captured as **plaintext** into the shared store.

**Fix**: `if (group.fileRule !== undefined || group.mode === "encrypted") return group;`
(mirrors the stated fileRule rationale: a group that owns whole-file encryption is never
rewritten to fields here). Test: encrypted-mode group with contract patterns returns
unchanged.

## R5 · Git reader must read bytes, not checkout-converted text (2.13.2)

1645bf0 moved reads from blob content to a temp-clone working tree; nothing disables
checkout conversion, so Windows-default `core.autocrlf=true` rewrites every file to CRLF
→ full false diff against the LF store, and Pull writes CRLF back into the local store.

**Fix**: clone with `-c core.autocrlf=false` (reader and writer clones — writer for
symmetry and future safety). Test: none practical in the Node suite (needs git config
matrix); covered by the one-flag change + live test.

## R6 · Compare's reader cache needs an age bound (2.13.2)

`createReader({reuse:true})` serves any cache entry from the current generation, the
miss path stores into the cache, and a generation only ends when another refresh runs —
with auto-check off (or within its 4-hour window) a pane-open compare can render a
days-old snapshot as "remote matches".

**Fix**: cache entries record their store time; `getReusable` returns a hit only when
generation matches **and** age ≤ 5 minutes. The intended same-refresh-cycle reuse
(seconds old) keeps working; a stale pane-open compare clones fresh. Test: readerCache
unit — same-gen fresh hit reusable, same-gen aged-out entry not.

## R7 · Tiered git timeouts (2.12.0)

A flat 60 s kills every slow-but-succeeding operation; first clone of a store with
theme/plugin payloads or a large first push deterministically fails where pre-2.12.0
succeeded.

**Fix**: two tiers — transfer operations (`clone`, `fetch`, `checkout`, `push`) get
300 s; quick local/remote queries keep 60 s. Callers pass the tier at the existing
`run()` seam. Test: none (constant plumbing); error message keeps naming the actual
timeout used.

## R9 · Progress notifies must not restart the open remote compare (2.13.2)

Every per-remote progress notify during `refreshRemoteChecks` triggers a full Sync
Center re-render; `renderRemoteDetail` starts a new `deepDiff` each time, abandoning the
in-flight one (whose git subprocess runs on) — up to N duplicate clones of the viewed
remote per refresh, with the "live" elapsed indicator resetting each tick.

**Fix**: the view keeps one in-flight compare per (remote name, reader-cache
generation); a re-render while that compare is pending re-attaches to the same promise
(and its phase/elapsed state) instead of starting over. A generation change (refresh
completed, remote edited) naturally invalidates and recompares once. Abandoned-promise
results stay discarded by the existing gen/scope gates. Test: pure-state helper for the
attach-or-start decision if extracted; otherwise view-layer, covered by live test
(indicator no longer resets during refresh).

## R10 · `refreshRemoteChecks` reentrancy guard (2.13.2, parked M1)

Two overlapping runs share one `remoteRefreshProgress`: `done` can pass `total`, and the
first finisher nulls the progress while the other still runs.

**Fix**: coalesce — an in-flight refresh stores its promise; a second call returns the
same promise instead of starting a parallel run. Test: fake-io main-layer test if the
seam allows; otherwise the guard is a three-line invariant covered by review.

## Parked (explicitly not this round)

- Nested device-local values stranded in the store (top-level-only guard) — incomplete
  fix, not a regression; backlog.
- Un-adopted local rule cross-device capture tug-of-war — converges on same-version
  fleets; backlog.
- 2.16.0 low-confidence candidates (pre-existing custom rule vs always-emitted core path
  collision → loud CompileError, contrived; snippets both-ways id-list visibility).
- af9a253 token-vs-credential-helper precedence — documented design, not a defect.
