# Per-device scope: keep device-local facts out of the shared store

## Problem

Two Sync Center scenarios, both observed live across a `main ← kickstart ← llm`
remote chain (each vault pulls from the one to its left; `kickstart` is
simultaneously a client of `main` and the remote `llm` pulls from):

### Bug 1 — a "this device" plugin choice leaks and is fragile

`main` has `remotely-save` enabled and set to "all devices". `kickstart` pulls,
does not want the plugin, and answers the Sync Center's "where it runs?" prompt
with **This device decides for itself**. Observed:

- `kickstart`'s Sync Center shows a standing **"Pull would bring 1 file"** diff
  against `main`. The single differing line is `"enabledOn": "local"` inside the
  self item's `data.json` (`items["community:remotely-save"]`).
- A pull from `main` would **remove** that line — silently reverting the
  device's opt-out. The per-device decision does not survive one pull.

The plugin does stay uninstalled/disabled on `kickstart` (the runtime switch
mask works); the defect is that the *decision itself* is written into the shared
self item and therefore diverges and can be clobbered.

### Bug 2 — a "this device" field leaks to a downstream vault

`main` sets the App-settings key `userIgnoreFilters` ("Excluded files") to scope
**this device**. Observed: `llm`, pulling from `kickstart`, receives an
`app.json` that **contains real device-specific exclude paths**
(`5-Archives/old_vault/`, `0-Extra/IOTO/Templates/@dev/old/`). The "this device"
intent set on `main` did not protect `llm`.

Root cause: the store-side strip of a `local`-scoped field happens only if the
*capturing* device's own compiled group carries the `local` rule. `kickstart`,
not having adopted `main`'s contract, captured `app.json` with no such rule and
wrote its own `userIgnoreFilters` into the store, which then flowed to `llm`.
The only mitigation today is the advisory "adopt first" banner; the store is
already polluted and an un-adopted apply overwrites the downstream device's own
value.

## Root cause (one family)

**Device-local facts are persisted into the shared store, and "what counts as
device-local" is decided by whether *this* device has adopted the contract
rather than by the contract itself.**

- The "this device" membership decision is stored as `ItemConfig.enabledOn ===
  "local"` inside `settings.items` (`src/core/registry.ts:57-62`), which travels
  in the self item's store copy. Only the top-level `rootPath`/`remotes` are
  stripped from that copy (`selfPresetRules`, `src/core/catalog.ts:341-346`), so
  `enabledOn:"local"` rides along (Bug 1).
- Capture strips a group's `local` fields from `stripPatterns(group)` — the
  *local* group's rules only (`src/core/modes.ts:78-81, 267`). An un-adopted
  device has no rule, so it publishes its own value (Bug 2).

## Design principle

**Device-local facts never enter the shared store, and the store contract — not
this device's adoption state — decides what is device-local.**

Two independent fixes apply this principle. They share the principle but touch
mostly different code and can be implemented and reviewed as separate tasks.

---

## Fix A — a "this device" membership decision is device-local

Move the set of members a device has pinned to "this device" out of the shared
`items` map into a new **top-level device-local settings field**, stripped from
the self store copy exactly like `remotes`, and preserved on apply.

### Data model

- Add `localMembers?: string[]` to `ConfigSyncSettings` (`src/main.ts:82-102`);
  default `[]` in `DEFAULT_SETTINGS` (`src/main.ts:111-128`). It holds item ids
  in the same `community:<id>` / `core:<id>` form the code already uses
  (`registry.ts:323`, `main.ts:626`).
- Add `{ pattern: "localMembers", scope: "local", encrypted: false, locked:
  true }` to `selfPresetRules()` (`src/core/catalog.ts:341-346`). The existing
  fields-mode strip (`sanitizeJson`, `src/core/sanitize.ts:14-27`) drops
  top-level `local`-scoped keys on capture, and `mergePreservingSanitized`
  (`src/core/sanitize.ts:29-50`) restores them from the live file on apply — so
  `localMembers` is stripped from the store copy and preserved on apply,
  byte-for-byte like `remotes`. Keep the mirrored preset lists in sync
  (`withSelfPresets` `registry.ts:245-251`, `mergePresetFields`
  `catalog.ts:353-358`).

### `enabledOn:"local"` is no longer a source of truth

`enablementScopes` (`src/core/registry.ts:310-329`) emits scope `"local"` from
**two** sources that must be kept apart:

1. an enabled card whose `enabledOn === "local"` — the explicit "This device"
   choice. **This relocates to `localMembers`.**
2. a disabled card (`cfg.enabled === false`) — a structural "each device manages
   its own" fact. **This stays derived, unchanged.**

Change (`registry.ts:317` and `:326`): a stored `enabledOn === "local"` is
treated as `"all"` (ignored). The disabled-card branch is untouched. Result: the
only inputs that pin a member to "this device" are `localMembers` and the
disabled-card structural case. A foreign or old-format `enabledOn:"local"` that
arrives in the shared contract during a staggered rollout has **no effect** on
this device — correctness does not depend on migration timing.

### Writers retargeted to `localMembers`

Every path that sets/clears the explicit "This device" choice writes
`localMembers`, never `items[*].enabledOn`:

- `addSwitchExceptions` (`src/main.ts:620-634`) — the "This device decides for
  itself" action. Add the ids to `localMembers` instead of writing
  `enabledOn:"local"`.
- The settings card's "Enabled on" chip, `renderEnabledOnZone`
  (`src/ui/SettingTab.ts:756-783`): selecting "This device" adds the item to
  `localMembers` (and leaves `enabledOn` unset); deselecting removes it.
  `enabledOn` retains only `"desktop"`/`"mobile"` (`"all"` remains the unset
  default) — it never stores `"local"` again.
- A path to **un-pin** (remove from `localMembers`) must exist wherever pinning
  does — the where-it-runs menu's "Everywhere"/other options and the chip both
  clear the id from `localMembers`.

### Reader retargeted

`memberLocalIdsFor(group)` (`src/main.ts:1115-1119`) derives this-device element
ids from `localMembers` (carrier-prefix mapping as in `registry.ts:323`),
**unioned** with the disabled-card `"local"` cases `enablementScopes` still
emits. `memberScopesFor`/`memberForceOffIds` are unaffected (they only handle
`desktop`/`mobile`).

### Migration

A new load-time migration in `src/core/settingsMigration.ts`, following the
`mergeLegacyAppSliceItems` pattern (a `boolean`-returning in-place mutator,
invoked next to `src/main.ts:1499`, triggering one `saveSettings` on change):

- For each `settings.items[id]` with `enabledOn === "local"`: add `id` to
  `settings.localMembers`, delete the `enabledOn` key.
- Idempotent (no `enabledOn === "local"` left → returns `false`).
- Must also run wherever settings are re-read from disk after an adopt
  (`reloadSettings`, `src/main.ts` — the self-apply path), so a freshly adopted
  foreign `enabledOn:"local"` is drained rather than re-published. (Because
  `enablementScopes` already ignores stored `"local"`, an undrained value is
  merely cosmetic, but draining stops the old form from being re-captured.)

### Resulting behavior

- `kickstart`'s "this device" choice for `remotely-save` lives only in its own
  `localMembers`, stripped from its self store copy → **no standing diff against
  `main`, and a pull cannot erase it** (Bug 1 resolved).
- The choice never travels, so `llm` forms its own independent decision.

---

## Fix B — the store contract is authoritative for `local` strips

At capture and comparison, strip a group's `local` fields using the union of the
**local** group's `local` patterns and the **store contract's** `local` patterns
for the same group name. The store contract is authoritative regardless of
whether this device has adopted it.

### The store contract source

The store's self copy compiled through `ctx.storeListGroups`
(`src/core/ConfigSyncCore.ts:50`, wired to `storeSelfCopyGroups`
`src/core/leftover.ts:26-37`) yields the shared `SyncGroup[]`, each with its
`fields` and their `scope:"local"` rules. Read the store self copy
(`${storeDir}/configdir/plugins/config-sync/data.json`, cf.
`ConfigSyncCore.ts:766`) **once per capture/status run**; absent store → empty
contract → today's behavior.

### The seam — one effective group feeds both capture and compare

The effective group is already computed once and consumed by both paths:
capture via `overlayGroup` → `captureTransform` (`ConfigSyncCore.ts:353,359`) and
comparison via `overlayGroup` → `contentUnchanged` (`src/core/status.ts:93,98`).
Extend the effective-group computation so a group's `fields` gains the store
contract's `local` patterns for that name (deduped). Because the same effective
group flows into both `captureTransform` and `contentUnchanged`, the strip stays
consistent — the union **must not** be applied to capture alone, or a captured
in-sync group would compare as changed (`contentUnchanged` strips both sides with
the same patterns, `modes.ts:444,459-460`).

### Plain-mode groups

If this device's local group is `plain` mode (byte sync, no fields,
`modes.ts:253-259` returns content verbatim, `stripPatterns` returns `[]`) but
the store contract declares the group fields-mode with a `local` rule, the
effective group must be **promoted to fields mode** driven by the contract
(analogous to `overlayGroup`'s promotion at `ConfigSyncCore.ts:71` and
`withSelfPresets`), so the contract's `local` field is stripped. Without this,
Bug 2 persists for plain-mode groups.

### Tradeoff (accepted)

In the window where a device's own rule says "sync this field" but the store
contract says "local", capture will strip it — the device cannot publish a field
the shared contract marks device-local until it adopts and republishes a changed
contract. This is the safe default: it prevents leaks, and changing the contract
is the sanctioned way to make a field shared again.

### Resulting behavior

`kickstart`, even un-adopted, strips `userIgnoreFilters` because the store
contract (from `main`) marks it `local` → it stops writing its own value into the
store → `llm` no longer receives device-specific exclude paths (Bug 2 resolved).

---

## Non-goals

- **Cross-device encrypted compare** (encrypted store copies differ by IV) is a
  separate pre-existing limitation, not touched here.
- **The store index / content-manifest refactor** (the parked "Approach A") is
  separate work; this spec does not depend on it.
- **No user-visible UI change is intended.** The where-it-runs menu and the
  "Enabled on" chip stay visually and textually identical; only what they write
  changes. If implementation surfaces any copy/layout/affordance change, it must
  be mocked up and 定稿 before coding.

## Testing

Attach to existing suites (extend, do not restructure):

- **Fix A model + strip:** `tests/modes.test.ts` fields round-trip; migration
  test mirroring `tests/schemaGate.test.ts` `mergeLegacyAppSliceItems` (idempotent,
  partial-shape, no-op); `tests/migration.test.ts:59` self-preset assertion
  updates for the new `localMembers` rule; `tests/mainReloadSettings.test.ts`
  end-to-end load/migrate/save wiring.
- **Fix A behavior:** a red repro — a self-item capture with a member in
  `localMembers` produces a store copy **without** that member's this-device
  marker, and apply preserves it; `enablementScopes` ignores a stored
  `enabledOn:"local"` while still emitting `"local"` for a disabled card
  (`tests/registry.test.ts:232`); the "this device" write lands in `localMembers`
  (`tests/core.test.ts` switch-list exceptions, `:1487`).
- **Fix B:** a red repro — capturing a group whose **store contract** marks a
  field `local`, from a device whose **local** rule does not, strips the field
  from the store copy (both fields-mode and plain-mode local group); a captured,
  contract-stripped group compares in-sync (`tests/modes.test.ts:81`,
  `tests/status.test.ts`).

## Global constraints

- **NO-COMMITS SDD:** implementers do not commit; the working tree is the review
  state; a single commit at cut by the controller. No Claude attribution in any
  commit/PR/issue text.
- **Bare version tags** (`.npmrc` `tag-version-prefix=""`); release title is the
  bare `x.y.z`; hand-written release notes in house style at cut; publishing the
  draft is the user's manual step.
- **Docs-currency before cut:** update `docs/ARCHITECTURE.md` (and README /
  README.zh / GUIDE / DESIGN if user-facing behavior or the settings schema
  description changes) in the same branch.
- **Feature hard rule (carried):** no secret/token value ever reaches process
  args, logs, errors, or `data.json`.
- Gates green before cut: build clean, full Vitest suite, lint at baseline (0
  errors).
