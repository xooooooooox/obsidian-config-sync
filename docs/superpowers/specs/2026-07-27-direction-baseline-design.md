# Direction Baseline & Cold-Start Guidance — Design

Date: 2026-07-27
Status: approved approach (device-local baseline ledger + non-blocking cold-start banner); spec under user review.

## Problem

Direction for a differing group (`local-changed` ↑ vs `store-newer` ↓) is decided in
`src/core/status.ts:59-60` by comparing the group's max local file mtime against the store
lock's single global `capturedAt`. The system never records *what content this device last
synced*, so any timestamp heuristic is a guess. Three confirmed failure modes (2026-07-26/27
cold-start field test):

1. **Cold start reads all ↑.** A freshly installed device has fresh mtimes on every local
   file, so every differing group presents as "to capture" — steering the user toward
   overwriting the store from a half-configured device. The correct direction is adopt/apply.
2. **Any re-capture flips everything ↓.** Capturing one group advances the global
   `capturedAt`; every other group with pending *local* edits immediately mis-presents as
   "store newer".
3. **perItem two-sided truth.** For shared-array keys (`src/core/perItem.ts`) both devices
   legitimately hold their own scoped elements; a single mtime-derived direction was never
   well-defined.

## Decision

**Approach C — device-local baseline ledger.** Each device records, per group, a hash of the
content it last saw in sync. Direction becomes a three-way comparison against that baseline.
The mtime/`capturedAt` heuristic is deleted (not kept as a fallback).

Rejected:
- **A — baselines in `store.lock.json`:** the deciding fact ("what did *this device* last
  sync") is device-private; a shared lock cannot hold it, so A still needs the local ledger
  and adds a lock schema bump + multi-device merge surface for audit-only benefit. Can be
  layered later without rework if a cross-device audit need appears.
- **B — per-group timestamps only:** fixes only failure mode 2.

## 1. Baseline ledger

New pure module `src/core/ledger.ts`; persistence stays in `src/main.ts` via
`app.saveLocalStorage` / `app.loadLocalStorage` (vault- and device-scoped, invisible to
remotely-save — the vault-wide RS sync is exactly why the ledger must not live in a vault
file). Key: `config-sync-baselines` (naming follows the existing `config-sync-passphrase`
keys, `src/main.ts:770-793`).

Shape (validated on load; malformed or missing → empty ledger):

```json
{
  "version": 1,
  "groups": {
    "<groupName>": { "store": "<sha256hex>", "local": "<sha256hex>", "at": "<ISO datetime>" }
  }
}
```

**Single writer — the status pass.** `statusForGroups` already reads both sides of every
group each pass. For every group whose comparison result is `in-sync`, the pass emits a
fresh ledger entry (reseed); `main.ts` persists the merged ledger after the pass. There is
no separate write hook in the capture/apply runners: every run already triggers a status
recompute, whose in-sync result reseeds the baseline. This one path also covers:

- **Upgrade migration:** first status pass after installing this version seeds every
  currently-in-sync group.
- **Self-healing:** if localStorage is wiped (app reinstall), baselines rebuild on the next
  pass; until then affected groups fall into the safe `never-synced` presentation (§2).
- **Housekeeping:** entries for groups no longer in the compiled config are dropped on write.

Groups whose comparison is `no-settings` or `not-captured` never seed, and any stale entry
for them is removed. `locked` groups never seed either, but their existing entry is kept —
a missing passphrase is temporary and must not degrade direction knowledge.

Failure direction is safe by construction: a lost ledger only ever *widens* uncertainty
(→ `never-synced`, default apply, no destructive default).

## 2. Direction derivation (`src/core/status.ts`)

Direction is computed only when the existing content comparison reports changes. The mtime
stat loop and the lock `capturedAt` read in `statusForGroups`/`groupStatus` are deleted.
`checkRemote` / `remoteLockAhead` (remote push/pull hints, `status.ts:176-221`) are a
separate mechanism and remain untouched.

With `b` = ledger entry for the group, `storeMoved` = hash(store now) ≠ `b.store`,
`localMoved` = hash(local now) ≠ `b.local`:

| Case | State | Meaning shown to the user |
|---|---|---|
| no ledger entry | `never-synced` (new) | "Not synced on this device yet" — the store has content this device never took; default direction apply |
| storeMoved, not localMoved | `store-newer` | unchanged |
| localMoved, not storeMoved | `local-changed` | unchanged |
| both moved | `differs` | copy upgraded to the now-true meaning: "changed on both sides since this device last synced" |
| neither moved | `differs` | comparison lens changed (scope/rule edits) — direction genuinely ambiguous |

A comparison *error* keeps today's behavior (state `differs` + `message`,
`statusForGroups` catch).

`statusForGroups` becomes IO-free with respect to the ledger: it receives the parsed
ledger and returns `{ statuses, reseeds }`; `main.ts` owns load/persist. Hashes for the
predicates reuse the file contents the comparison already read (threaded out through the
`Comparison` result) — no second read of the tree.

**perItem groups** need no special direction code anymore: after every sync both sides
reseed; whichever side moved since is the mover, and both-moved reports honestly as
`differs`. The capture/apply merge semantics in `perItem.ts` are unchanged.

## 3. Hashing rules

SHA-256 hex via `crypto.subtle.digest` (available on desktop and mobile; the status pass is
already async). Input canonicalization:

- **File groups:** raw file bytes (string content as read).
- **Dir groups:** hash of the manifest string built from `rel + "\n" + sha256(content)`
  lines sorted by `rel`.
- **Switch-list groups** (`community-plugins`, `core-plugins`, `enabled-css-snippets`):
  hash the canonical *set* form, not bytes — arrays as `JSON.stringify([...ids].sort())`,
  maps as sorted-key `JSON.stringify` — using `parseSwitchList` for the store side and
  `readLocalSwitchList` for the local side (mirrors the set semantics the comparison
  already uses). Enable-order churn in `community-plugins.json` must not read as "local
  moved". If parsing fails, fall back to raw bytes.
- **Encrypted groups:** hash store bytes as-is; no decryption. Any re-capture rewrites the
  envelope (fresh IV), which is exactly the "store moved" signal we want. Local side is
  plaintext bytes as usual.
- **Scoped/fields groups:** local raw bytes may include scope-masked fields; if only masked
  fields change locally, the comparison stays `in-sync` and the reseed path refreshes the
  baseline, so no false direction arises.

## 4. New `GroupState`: `never-synced` — consumer inventory

Added to the union in `src/core/status.ts:10`. Every consumer updated:

- `bucketCounts` (`status.ts:142`): counts into `down` (resolved by Apply).
- `src/ui/panelModel.ts`:
  - `visibleUnderFilter`: matches the `apply` filter.
  - `directionForState`: `apply`.
  - `stageableState`: stageable (true) — user may stage it; direction override to capture
    stays possible via `effectiveDirection` for the rare intentional case.
  - `presentedState`, `statusBarStatuses`: pass through unchanged (bucket mapping does the
    work).
- `src/ui/SyncCenterView.ts` row rendering (state branches around :1555-1630): row
  sublabel "Not synced on this device yet"; `differs` sublabel becomes "Changed on both
  sides since this device last synced — review the diff before choosing a direction."
- `src/core/selfPane.ts` (`selfPaneState`): `never-synced` on the self group maps like
  `store-newer` → state `adopt`, `contentChanged: true`.
- Tests for each of the above (§7).

## 5. Cold-start guidance banner (`#4`)

The existing self cold-start detection stays the anchor: `main.ts:478` reports self state
`coldstart` when the local sync list is empty while the store has groups, and
`SyncCenterView.ts:309` already forces the panel to the self scope.

New non-blocking banner at the top of the Sync Center item list, shown when **self state is
pending** (`coldstart`, `adopt`, or `both`) **and** at least one `never-synced` row exists:

> **This device hasn't synced with the store yet.** Adopt the plugin settings first — they
> carry the scopes and device rules that make the diffs below trustworthy — then review and
> apply. `[Review settings →]`

- The button jumps to the self pane (existing `panelScope = { kind: "self" }` mechanism).
- Dismissible (×). Dismissal persists in localStorage key `config-sync-coldstart-dismissed`;
  the flag is cleared whenever self state returns to `insync`, so a *future* genuine cold
  start shows the banner again.
- The banner disappears on its own once settings are adopted (self leaves pending), leaving
  the `never-synced` rows (default apply) to guide the rest — no second banner phase.
- No blocking wizard; experienced users can ignore it entirely.

## 6. Ride-along fixes

### 6a. Carrier groups land in CUSTOM (`#3`)

`categoryForGroup` (`src/core/catalog.ts:431-443`) has no rule for the switch-list carrier
groups, so `community-plugins` and `core-plugins` fall through to `custom`. Pin them the
same way `enabled-css-snippets` is pinned: `community-plugins` → `community`,
`core-plugins` → `core`.

### 6b. JSON diff ordering/comma noise (`#5`)

Diff previews of JSON files show noise lines when only key order (and the trailing-comma
placement that follows from it) differs. Today only switch lists get a normalized "sorted
view" (`SyncCenterView.ts:1845-1849` via `switchListSortedView`).

- Extract the duplicated `sortKeysDeep` (`src/ui/ConflictModal.ts:10`, `src/core/merge.ts:31`)
  into one exported helper and add `jsonSortedView(content: string): string` beside it in
  `src/core/merge.ts`: parse; on failure return content unchanged; on success
  `JSON.stringify(sortKeysDeep(parsed), null, 2) + "\n"`.
- In the Sync Center diff preview, when both sides of a `.json` file parse, render the
  sorted view of both sides and keep the existing "· sorted view" meta suffix. Switch lists
  keep `switchListSortedView` (set semantics beat plain key sorting there).
- When the raw texts differ but the sorted views are identical, render a single note line
  in the diff pane instead of an empty diff: "Only key order / formatting differs." —
  otherwise a `differs` row with a blank preview reads as a bug.

This changes preview rendering only; comparison and capture/apply bytes are untouched.

## 7. Testing

Pure logic → vitest, following the repo split (pure core tested; `main.ts` wiring verified
by dev-vault smoke):

- `ledger.ts`: parse/validate/merge/housekeeping; malformed input → empty ledger.
- Direction table (§2): all five rows, including no-entry → `never-synced` and
  neither-moved → `differs`.
- Hash canonicalization: switch-list order insensitivity; dir-group manifest stability;
  parse-failure byte fallback.
- `statusForGroups` reseed emission: in-sync groups emit entries; `no-settings`/
  `not-captured` prune; `locked` preserves.
- panelModel/bucketCounts/selfPane updates for `never-synced`.
- Banner predicate (pure function: self state + statuses + dismissed flag → show/hide).
- `categoryForGroup` pins; `jsonSortedView` + identical-sorted-view note predicate.

Dev-vault smoke: simulate cold start (clear the localStorage key, mutate store) and
upgrade (existing store, no ledger); verify banner, `never-synced` rows, and that a
capture/apply flips the row to in-sync and seeds the baseline. Field verification on the
phone — the environment that surfaced the problem.

## 8. Migration, compatibility, risks

- **No store schema change.** `store.lock.json` untouched; devices on older plugin versions
  interoperate unchanged.
- **Upgrade UX:** groups with pending changes at upgrade time briefly show
  "Not synced on this device yet" (apply-default) until their first in-sync/capture/apply
  reseeds them. Honest wording, non-destructive default, diff preview still gates every
  action. Accepted trade-off for deleting the known-broken heuristic instead of keeping it
  as a second code path.
- **Ledger loss** (Obsidian reinstall, cleared app data): degrades to `never-synced`, which
  is the safe direction; self-heals via reseeding.
- **localStorage size:** ~100 bytes/group, trivial.
- **Perf:** hashing reuses contents the status pass already reads; SHA-256 of small JSON
  files is negligible, including on mobile.
