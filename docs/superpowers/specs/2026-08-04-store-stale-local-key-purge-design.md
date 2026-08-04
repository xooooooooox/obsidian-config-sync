# Store Stale Local-Key Purge — Design

## Problem

A field scoped to **This device** (`scope: "local"`) whose value was already in the
store from an earlier capture — captured before the field became local — stays
**frozen in the shared store forever**. It is a privacy leak: one device's
device-specific value (e.g. App settings `userIgnoreFilters` holding a machine's
exclude paths) sits in the store where every other device can read it via the
Sync Center diff, and an un-adopted device applying for the first time would write
it onto itself.

### Observed

Live three-vault chain `main ← kickstart ← llm`. On `main`, App settings
`userIgnoreFilters` was set to **This device**. `llm`'s Sync Center shows the
store's `app.json` still carrying `main`'s exclude paths
(`5-Archives/old_vault/`, `0-Extra/IOTO/Templates/@dev/old/`) in the App settings
diff — device-specific values published in the shared store.

## Root Cause

`captureGroup` (`src/core/ConfigSyncCore.ts`) gates the store write behind a
"skip if unchanged" callback that, when content compares equal, still checks for
**stale scoped keys the equality check deliberately ignored** and forces a rewrite
to purge them. This base-hygiene mechanism exists for two of the three scope
families but not the third:

- `baseHasStaleClassKeys` — purges stale desktop/mobile **class-scoped top-level keys**.
- `baseHasStalePerItemElements` — purges stale **local-scoped per-item elements**.
- **(missing)** — no guard for stale **top-level `scope: "local"` keys**.

Because `contentUnchanged` (via Fix B's `withContractLocals`) now strips a local
field from both sides, the source device (`main`) sees the group as **in-sync**
and is never prompted to re-capture; and even a re-capture would hit the skip
callback, which — lacking the third guard — reports the write as unnecessary. The
stale value is therefore never purged.

## Fix (Approach A — minimal, mirrors the two existing guards)

### 1. New guard `baseHasStaleLocalKeys(effGroup, existing): boolean`

Placed beside the two existing guards, structurally identical to
`baseHasStaleClassKeys`, differing only in its pattern source:

```ts
function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = stripPatterns(effGroup);
  if (patterns.length === 0) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(existing); } catch { return false; }
  if (!isPlainObject(parsed)) return false;
  return Object.keys(parsed).some((k) => keyMatchesAny(k, patterns));
}
```

`stripPatterns(effGroup)` (already exported from `modes.ts`) is the set of top-level
`scope: "local"` field patterns `contentUnchanged` strips. A per-item key is never a
`scope:"local"` field (it lives in `group.perItem`, not `group.fields`), so it never
appears here — per-item local elements remain the second guard's responsibility, with
no overlap. Add `stripPatterns` to `ConfigSyncCore.ts`'s existing `./modes` import
(which already pulls in `classPatterns`); no new export is needed. Returns true iff the
existing store base still carries any such top-level key.

A doc comment mirrors the two existing guards and references the same base-hygiene
spec (`2026-07-25-domain-mirror-design.md §2.2`).

### 2. Extend the write-skip callback

The callback's terminal expression gains one clause:

```ts
return !baseHasStaleClassKeys(effGroup, existing)
    && !baseHasStalePerItemElements(effGroup, existing)
    && !baseHasStaleLocalKeys(effGroup, existing);   // new
```

When the store base still holds a now-local top-level key, the write is forced
and `captureTransform`'s strip removes it from the base.

## Testing

Mirror the class-key purge test in `tests/sidecarLifecycle.test.ts`:

- **Purge**: a store base carrying a top-level local key (e.g. `userIgnoreFilters`)
  with otherwise-equal content — first capture forces a rewrite that drops the key
  from the base. Assert the key is absent from the written store content.
- **No-op**: a group with no top-level local patterns — the guard returns false, the
  "unchanged" verdict stands, no spurious rewrite.

Node suite grows by the two cases; the rest of the suite is unchanged.

## Non-goals

- **Apply path untouched.** Routing `apply` through `withContractLocals` to defend
  an un-adopted device from writing store-resident local values is **Approach B**,
  deliberately out of scope here.
- **No status "clean me" prompt.** Surfacing a to-capture when the store still holds
  a now-local key is **Approach B**. Consequence, called out for the operator: after
  this fix ships, purging the **existing** leak requires **one manual Capture of App
  settings on `main`**. The guard gives that capture the power to purge; nothing here
  auto-triggers it.
- No retroactive bulk cleaning of stores beyond the next capture of each group.

## Docs currency

If `ARCHITECTURE.md` / `DESIGN.md` document the base-hygiene invariant, add the
third family (top-level local keys) alongside class keys and per-item elements. The
code comment references `2026-07-25-domain-mirror-design.md §2.2`.

## Global constraints

- Bare version tags (`.npmrc` `tag-version-prefix=""`); `npm version` builds the
  version commit + tag; `release.yml` drafts the release on tag push.
- No token/secret value ever reaches process args, logs, errors, or `data.json` —
  unaffected here (no secret handling in this change).
- No Claude/AI attribution in any commit, PR, or issue text.
- NO-COMMITS SDD: implementers do not commit; a single commit at cut.
