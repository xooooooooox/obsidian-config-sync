# Surface a stale device-local key in the store as "to capture"

## Problem

2.14.1 added `baseHasStaleLocalKeys`, a capture-time guard that purges a top-level
`scope:"local"` key stranded in the shared store base. Live verification on the owner's
main vault (2026-08-04) proved the guard is real, correctly built, and — given a real
capture over the group — purges the base. Yet the existing leak was **not** cleaned:
`main.vault`'s store base for `app.json` still carried this device's private
`userIgnoreFilters` paths after the user updated to 2.14.1 and captured.

### Root cause (verified)

The guard only runs inside `captureGroup(group)`. The Sync Center only ever captures
rows whose effective direction is `"capture"` (`SyncCenterView.capturePayload` filters on
`effDir(r) === "capture"`). But an already-leaked group reads as **in-sync**:
`status.ts`'s `compareFile` computes equality via `contentUnchanged`, which — by Fix B —
strips the `scope:"local"` key from both sides, so live and store compare equal and the
group is reported `"in-sync"` (direction none). An in-sync row is never in the capture
payload, so the user cannot capture it, so the guard never runs, so the stale value stays
frozen in the store forever.

Evidence gathered during diagnosis:
- Installed `main.js` is byte-identical to the 2.14.1 source build (only a trailing
  `/* nosourcemap */` banner differs) — the fix is in the running build.
- A reproduction seeding the exact real `app.json` (live), store base, and desktop sidecar
  into `capture()` purges the base (`changes.updated: ["app.json"]`) — the core is correct
  when capture actually runs over the group.
- The store base's mtime never advanced past the pre-fix date after the user's capture —
  `captureGroup(app)` never executed, because the UI never offered `app` for capture.

Approach A (the guard alone) therefore closes the leak only for a group that happens to be
captured for some *other* reason; a stably in-sync leak is unreachable.

## Fix

Make the status comparison surface the stale-local condition as a **capture direction** so
the leaked group appears in the Sync Center as "to capture". Capturing then triggers the
existing 2.14.1 guard, which purges the base; the next status scan finds the base clean and
the group returns to in-sync. One-shot, self-clearing.

### Behavior

`status.ts` — inside the file comparison, when the group is otherwise in-sync but the store
base carries a top-level `scope:"local"` key that should not be there (the exact
`baseHasStaleLocalKeys(effGroup, storeContent)` predicate), report the group as
`state: "local-changed"` with `changes.updated = [file]` instead of `"in-sync"`.

`local-changed` is chosen because it already maps to the capture direction end-to-end:
`effectiveDirection("local-changed") === "capture"`, the row is stageable in the `main`
section (`stageableRow`), and `capturePayload` includes `effDir === "capture"` rows. No new
state, UI control, or scheduling is introduced. It is semantically honest: local is
authoritative, and the store must be rewritten to drop a value it should never hold.

`compareFile`/`compareDir` already read the store content, so the predicate needs no extra
I/O. The stale-local check runs only on the otherwise-in-sync branch — a group that is
already changed for real keeps its existing direction.

### Core invariant

The predicate that lights the row up in status and the predicate the capture guard uses to
purge the base are the **same** `baseHasStaleLocalKeys`. Light-up ⟺ capture cleans it.
There is no configuration where status shows "to capture" but a capture leaves the base
dirty — that would be exactly the permanent phantom Fix B was built to prevent, and it is
structurally excluded here.

### Lifecycle

```
base carries stray local key
  → status: "local-changed" (to capture)
  → user captures app
  → 2.14.1 guard purges the base
  → next status scan: base clean → predicate false → "in-sync" (row disappears)
```

The row appears once (until acted on) and then clears. It does not reappear on every scan.

## Scope and non-goals

- **In scope:** top-level `scope:"local"` keys in a file-mode group's store base — the same
  family `baseHasStaleLocalKeys` covers. This is what the reported leak is (`app.json` /
  `userIgnoreFilters`).
- **Per-item local elements** are a different family (`group.perItem`, handled by
  `baseHasStalePerItemElements`) — a separate status-surfacing question, out of scope here.
- **No new UI:** no dedicated "clean store" button or action; the fix reuses the existing
  capture affordance and payload.
- **No scheduling change:** detection piggybacks on the existing status scan
  (`refreshLocalStatus`: panel open, post-capture/apply, manual refresh, periodic local
  check). No new timer, no added scan cost.
- **Fix B unchanged:** a genuinely in-sync group (clean base) still reads in-sync; the
  compare-strip semantics are untouched for that case.

## Self-group edge

config-sync's own group carries locked `scope:"local"` fields (`rootPath`, `remotes`,
`localMembers`). Empirically (main.vault, 2026-08-04) every plugin store base — including
config-sync's own `data.json` — is already free of those keys, so the new detection does
not false-trigger on self. Detection is content-driven, so a clean self base stays in-sync;
a contaminated one would be cleaned by the same guard on capture. A regression test asserts
a group with a `scope:"local"` field but a clean base stays in-sync.

## Testing

- **Status unit (core):** a fields-mode group with a `scope:"local"` field whose store base
  carries that key, otherwise equal to live → `groupStatus` returns `state:
  "local-changed"` with `changes.updated = [file]` (not `"in-sync"`).
- **Regression (no phantom):** same group, base clean → `state: "in-sync"`.
- **Self-clearing (integration):** status shows `local-changed` → run `capture` over the
  group (2.14.1 guard purges) → re-run status → `in-sync`. This is the end-to-end proof the
  two predicates agree.
- **Mapping:** confirm `effectiveDirection("local-changed") === "capture"` and the row is
  stageable in `main` (guards the routing the fix depends on).

## Operational note

After installing 2.14.2, main's App settings automatically surfaces as "to capture" on the
next status scan. One capture cleans the store base of the stranded `userIgnoreFilters`;
downstream vaults (kickstart, llm) then see an App-settings diff free of main's private
paths. No manual selection of an in-sync item is required (which the UI does not allow) —
the item is presented as capturable on its own.

## Global constraints

- **Version:** 2.14.2 (bare tag, `.npmrc` `tag-version-prefix=""`).
- **minAppVersion floor:** unchanged from 2.14.1 (`version` script adds the versions.json
  floor from the current manifest `minAppVersion`).
- **NO-COMMITS during implementation:** implementers leave the tree uncommitted; a single
  commit is made at cut by the controller. No Claude/AI attribution in any commit, tag,
  release, or PR text.
- **Release:** hand-written release notes in house style; release title is the bare version
  `2.14.2`. Publishing the draft is the user's manual step.
- **Docs currency:** if ARCHITECTURE/DESIGN document the status states or the base-hygiene
  invariant, update them in the same branch before cut; otherwise the code comment carries
  it (as in 2.14.1).
