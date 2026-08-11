# Data-model hardening — design

Date: 2026-08-11 · Scope: the two storage invariants and every place that breaks
them · Branch: main · Status: 定稿, awaiting dispatch. Source audit: this session's
review of `data.json` + `store.lock.json` (findings S1-S12); ledger entry C-#52 in
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`.

One release, no schema bump, no migration of user data, **no visible UI change** apart
from two new refusal messages. The story: *Config Sync no longer destroys what it
doesn't understand, and a device's own choices stay its own.*

## §1 The two invariants (write them into DESIGN.md)

**Invariant I — where a datum lives.**
1. True only of THIS device, and defined by this device's identity → **localStorage**
   (same lifetime as the device id).
2. This vault's transport wiring (paths, remotes, credential references) → data.json
   under a locked-local preset (`selfPresetRules`).
3. The fleet's shared sync contract or preferences → ordinary data.json fields.
4. Provenance and freshness of store content → `store.lock.json`.

Corollary, testable: **no per-device datum may ride whole-document propagation, and no
structure keyed by `deviceId` may appear in data.json.**

**Invariant II — unknown ⇒ preserve.**
1. Unknown FIELDS are carried through untouched and written back as found — never
   dropped by a rebuild.
2. Unknown ENUM VALUES are ignored at the point of use; storage is not rewritten.
3. A document from a HIGHER version is refused with a clear message — never
   downgraded, never reset, never overwritten.
4. A device with no source of truth for a shared structure is a READER of it.

Corollary, testable: every persisted structure survives a round trip
(parse → serialize) with unknown fields intact.

Home for both, decided 2026-08-11: **ARCHITECTURE.md**, whose subject is system
structure — `DESIGN.md` is the UI design system and is not the place for storage rules.
ARCHITECTURE.md gains the invariants verbatim as a new section, and its storage
description is updated to name the four homes.

## §2 The device opt-out moves out of data.json (C-#52, invariant I)

Live failure, reproduced from kickstart's run history and the vault's git log: capture
at 22:45 wrote `deviceOptOuts: {"plugin-remotely-save": ["msmxod5k-…"]}`; `pull main`
at 22:52 replaced the store copy with main.vault's (`{}`); `adopt` landed the empty map
in the live settings. The opt-out was gone and Remotely Save returned to To apply.

- New localStorage key `config-sync-device-optouts`, value a JSON `string[]` of GROUP
  NAMES. Read/write through `deviceId()`'s neighbours in main.ts; malformed value =
  treated as absent, never thrown.
- The `deviceId` key disappears from the structure entirely: the map existed only to
  say whose entry it was, and a per-device document has no other devices in it.
  `Record<groupName, deviceId[]>` → `string[]`.
- `settings.deviceOptOuts` is REMOVED from `ConfigSyncSettings` and
  `DEFAULT_SETTINGS`. `optedOutHere` / `deviceOptedOutGroupNames` / `setDeviceOptOut`
  / `excludeOptedOutItems` keep their signatures and semantics; only their backing
  store changes. `setDeviceOptOut` no longer writes data.json — it writes localStorage
  and then runs the same refresh the callers already run.
- One-time migration on load, ignore-and-prune style (the `quickCommands` / `deviceId`
  precedent, main.ts:1999-2002): if `data.deviceOptOuts` exists, union the group names
  whose array contains this device's id into the local list, then `delete` the field.
  The migration **saves once, immediately** (the `mergeLegacyAppSliceItems` /
  `drainEnabledOnLocal` precedent at main.ts:2008/2014) rather than waiting for the next
  unrelated save, so the self item's resulting drift appears exactly once and at a
  predictable moment. No notice, no user action.
- Key space: group name is kept deliberately. Item id would have to route through
  `itemIdFor`'s inverse mapping, which is the known-ambiguous half of finding S3
  (a folder name can shadow a registry id). This entry is listed in S3's migration
  inventory instead, to convert with everything else.

**The field is CARRIED, not deleted** (ruling 2026-08-11, final review I1 — this reverses
the "then `delete` the field" instruction above, which stands only as history). Removing a
field is two-phase, and §5.2 argues exactly why: a document written without
`deviceOptOuts` and adopted by a device still on 2.20.0 drops that device's own opt-out —
C-#52's own failure, inflicted by C-#52's fix on the devices that have not yet been fixed.
So: migrate this device's entries into localStorage, which becomes authoritative, and
leave the field itself in the document as carried data (invariant II.1 applies to our own
legacy fields, not only to fields from the future). Keep THIS device's entry inside it in
step with localStorage, so an un-updated device is not told something false; every other
device's entry passes through untouched. Phase 2 — stop writing it — waits until a build
that reads localStorage is the fleet's floor, ledgered beside C-#54.

**Recovery:** kickstart's own entry was already erased and the migration cannot bring it
back — it survives only in the vault's git history (`b85a218d`). The controller restores
it by hand during verification (§9); llm/main keep whatever their documents still hold.

## §3 Unknown ⇒ preserve, three call sites (invariant II.1/II.2/II.4)

**§3.1 `parseStoreLock` stops rebuilding from a whitelist** (manifest.ts:247-277).
Today each entry is reconstructed field by field, so any key this build doesn't know is
silently dropped — and the pull path writes the PARSED lock back
(ConfigSyncCore.ts:1262-1273), so one pull by an older device strips a newer device's
fields and pushes the loss onward. This is the reason the lock format cannot evolve
today.
- Parse by validate-and-carry: start from the raw entry, validate the known fields
  exactly as now (same error messages, same rejections), and keep everything else.
- `StoreLock` and its entry type gain an index signature for the carried keys.
- Unknown TOP-LEVEL keys of the lock are carried the same way.
- The existing validation stays as-is, including the rule that an entry must have a
  string `sourcePluginVersion` or `sourceAppVersion` — §6 keeps both fields flat
  precisely so older readers keep parsing.

**§3.2 `sanitizeMemberRules` stops deleting** (settingsMigration.ts:96-106, called with
an immediate `saveSettings()` at main.ts:2015-2018). An unknown `MemberRule` value —
which is exactly what a future build would write — is currently dropped and persisted,
and the deletion then propagates to the whole fleet on the next capture.
- The function is removed from the load path. Unknown values are ignored where rules
  are consumed (`normalizeMemberRule` / `preferStoredMemberRule` already treat an
  unrecognised value as "no stored rule" — verify and, if not, make them do so).
- Storage is left byte-identical. No save is triggered by loading.

**§3.3 A device without BRAT no longer writes the shared index** (bratIndex.ts:16-21,
main.ts:1204-1218). `resolveBratIndex` keeps only ids whose repo is still in THIS
device's BRAT list; on a device with no BRAT, `repos` is `[]`, so `next` is `{}` and
`refreshBratIndex` saves the emptied index — a fleet-shared structure wiped by the
device that knows least. The manual ↻ Re-scan in the Beta tab reaches this.
- `refreshBratIndex` returns without writing when `repos.length === 0`; the Beta tab's
  map-note keeps reporting the index it can see. The write path is unchanged for a
  device that does have a BRAT list.

## §4 Version gates (invariant II.3)

**§4.1 Settings.** `isLegacySettings` is replaced by a pure classifier in
settingsMigration.ts:

```ts
type SettingsLoad =
  | { kind: "fresh" }                    // no data.json
  | { kind: "ok" }                       // schemaVersion === 2
  | { kind: "legacy" }                   // < 2, or unversioned — today's reset + SCHEMA_UPGRADE_NOTICE
  | { kind: "future"; found: number };   // > 2
```

`future` must never reset and never overwrite:
- `loadSettings` keeps the file untouched, sets a stop state
  (`schemaStop: { found: number } | null`), and does NOT populate defaults over it.
- Every mutating entry point (capture, apply, pull, push, adopt, and the settings tab's
  writers) refuses while `schemaStop` is set, with the message below.
- The Sync Center renders the refusal in the EXISTING cold-start banner structure
  (`.config-sync-coldstart-banner`, SyncCenterView.ts:1878-1890) with no primary
  action. No new visual variant — if the implementer believes one is needed, it stops
  and reports rather than inventing one.

Copy (final, follows the UI vocabulary rule — `this device` / `your other devices` /
`the store`):

> **These settings were written by a newer Config Sync.** Update Config Sync on this
> device to open them. Nothing has been changed.

**§4.2 The guard moves BEFORE the write.** Adopt writes the store's `data.json` onto
this device and only then reloads (main.ts:751-764), so a check inside `loadSettings`
arrives after the local document is already gone. The self item's apply path parses the
incoming document's `schemaVersion` first and, when it is higher than this build's,
fails that item with `status: "error"` and a message through the existing run-result
path (ConfigSyncCore.ts:625/1010/1026) — no new UI:

> The store's Config Sync settings were written by a newer version. Update Config Sync
> on this device before applying them.

Other items in the same run are unaffected.

**§4.2b Rulings made during task 3 (2026-08-11).**
- **The stop state writes nothing that another device can see, and nothing derived from
  the document it cannot read** (wording sharpened by the task-3 review, M4). That
  covers the settings document, the store, the lock, the run history, and the sync
  BASELINES — baselines are computed from `compiledGroups`, which is compiled from the
  misread document, so writing them is recording a fiction. It deliberately does NOT
  cover this device's own scratch preferences that carry no reading of the document —
  the passphrase, the cold-start dismissal, clearing the run history on request. Say the
  precise rule in the docs; "writes nothing at all" is not true and should not be
  claimed.
- **A flow that will be refused refuses before it opens.** A modal the user must confirm,
  a conflict set they must adjudicate, a form they must fill — none of them may appear
  when the operation behind them is already known to be impossible. This has now bitten
  twice (the pull planner, the Stop-syncing modal); it is the same rule as "a surface
  says what will happen before you act", applied to refusals.
- **A refused action is never recorded as done.** Run-history entries are written by the
  action's caller, so a refusal must suppress the entry as well — a "Stopped syncing X"
  line beside a refusal notice is worse than either alone.
- **Refuse before mutating memory.** A settings-tab writer that updates in-memory state
  and only then hits the refusal leaves memory diverged from disk with no recompile.
- **The stop state writes NOTHING, to either side.** Beyond the enumerated mutators, it
  also refuses `stopSyncing` and `deleteLeftoverStoreFiles` (both delete store content,
  and both choose files through `compiledGroups` — compiled from a document this build
  cannot fully read; deleting on a misreading is the worst available outcome) and the
  startup lock-label heal (cosmetic, and the one remaining store write while stopped).
  "Refuse every writer" is the rule; a writer not on any list is refused, not exempt.
- **A stopped device says so at startup**, once, with the §4.1 copy — not only when the
  Sync Center is opened. A device silently not syncing is the failure this release
  exists to prevent; it must be visible without the user going looking.
- **In-memory settings for a `future` document are the DOCUMENT's own values**
  (`withDefaults(DEFAULT_SETTINGS, data)`), not the defaults. Holding defaults would be
  precisely the state that overwrites the user if any writer ever slipped through the
  refusals — the document's own values keep a slip harmless. The refusals, not the
  in-memory shape, are what guarantee nothing is written.

**§4.3 The store lock gains a version.** `version` absent = 1 (today's shape, parsed and
normalised as now); this build writes `version: 2`. A lock whose `version` is higher than
2 is not `unknown` — the operation refuses it and says so:

> The store was written by a newer Config Sync. Update Config Sync on this device
> before syncing.

**The gate belongs to the STORE, not to "the remote"** (task-3 review, I3). The local
store lives inside the vault, and the vault itself is synced by other tools (git,
Remotely Save, a file-sync service) — so a newer build on another device can put a v3
lock into THIS vault without any pull ever happening. Capture must therefore read the
local lock's version and refuse the same way, rather than overwriting it with `version: 2`
and silently discarding whatever v3 recorded. Every operation that WRITES the lock —
capture, the pull merge, push — checks the version of the lock it is about to replace.
Reading and comparing stay unaffected.

## §5 Shape cleanups

**§5.1 Nested defaults actually apply (S8).** `Object.assign({}, DEFAULT_SETTINGS, data)`
(main.ts:2003) fills only the top level, so a nested field added in a later version is
`undefined` when an older document is adopted. Replace with a `withDefaults(data)` that
recurses into the KNOWN nested objects (`runHistory`, `ribbonButtons`) and carries
unknown keys through untouched (invariant II.1).

**§5.2 `ItemConfig.companions` becomes optional (S7) — READERS ONLY this release.** Live
data: 107 of kickstart's 108 entries store an empty array, and 93 entries are nothing but
`{"enabled":true,"companions":[]}`.

Removing a field is a **two-phase change**, and this release is phase one:
- Phase 1 (here): the type becomes optional and EVERY read site tolerates absence
  (`?? []`), including `compileCompanions`, `parentCardLabel` and `buildCompanionRows`.
- Phase 1 keeps WRITING `companions: []` **at every construction site**, `emptyItemConfig()`
  included — an item enabled for the first time after this release must persist the same
  shape an older build can read. "Stop writing it" is phase 2, all of it, or the
  compatibility this phasing buys leaks away through the newest entries.
- Phase 1 keeps WRITING `companions: []` exactly as today. At BASE those three read
  sites are unguarded, so a document without the field makes a 2.20.0 device throw
  during compile — a device destroyed by what it cannot read, which is precisely what
  invariant II exists to prevent. Our own rule applies to our own past builds.
- Phase 2 (a later release, once a tolerant build is the fleet's floor): stop writing
  the empty array. Record it in the ledger as the follow-up; do not do it here.

**§5.3 `bratPluginIndex`'s contract is written down.** It is a REPLICATED index, not a
cache: a device without BRAT still needs it to install beta plugins. Writers are devices
that have a BRAT list (§3.3); everyone else reads.

## §6 store.lock.json v2 — freshness with per-item resolution

Today's single `capturedAt` carries two meanings at once: "when this store was captured"
(what `checkRemote` reads) and "the lineage watermark" (what pull aligns to the remote's
value, deliberately, so `remoteLockAhead` converges — ConfigSyncCore.ts:1250-1254). Split
them; keep the convergence exactly as it is.

```ts
interface StoreLock {
  version: 2;                 // absent = 1
  syncedWatermark: string;    // the lineage watermark; pull aligns it to the remote's (v1 remote: its capturedAt)
  capturedAt: string;         // derived = max(groups[*].capturedAt); describes local content only, never rewritten by pull
  groups: Record<string, StoreLockEntry>;
  // unknown keys carried (§3.1)
}

interface StoreLockEntry {
  capturedAt?: string;             // NEW — this item's own capture time
  hash?: string;                   // NEW — "sha256:…" fingerprint of this item's store content
  sourcePluginVersion?: string;    // stays FLAT: manifest.ts:261 makes older readers throw without it
  sourceAppVersion?: string;
  desktopOnly?: true;
  label?: string;                  // display
  memberLabels?: Record<string, string>;  // display
  // unknown keys carried (§3.1)
}
```

- Capture writes `capturedAt` + `hash` for the items it touches and leaves other entries
  alone; the top-level `capturedAt` is recomputed as the max (falling back to now() when
  no entry has one).
- Pull sets `syncedWatermark` from the remote (`syncedWatermark ?? capturedAt` for a v1
  remote) and recomputes `capturedAt` from the merged groups. The convergence property
  `remoteLockAhead` relies on is preserved — assert it in a test.
- `remoteLockAhead` compares the watermark and then, per entry, everything EXCEPT
  `label` / `memberLabels`. A pure display change stops reading as "the remote is
  ahead" — the false positive S6 was meant to fix, at no format cost.
- **A field the remote does not have is not a difference.** In a mixed fleet an
  un-updated device still strips `version` / `capturedAt` / `hash` when it pulls (that
  is S10, and only this release fixes it), and the next capture here writes them back.
  Comparing only the keys present on BOTH sides keeps that churn from surfacing as a
  false "the store has newer settings" prompt; precision returns on its own once every
  device is updated. A key present on both sides with different values is a difference,
  as today.
- `checkRemote` keeps its cheap contract (no file reads) and its return shape
  `{state, remoteCapturedAt}`, but when BOTH sides carry per-group data it decides the
  state from those entries instead of the whole-store timestamp. Either side at v1 →
  today's behaviour exactly.
- **A remote this build cannot read must not look actionable** (task-3 concern 6).
  §4.3 scopes the refusal to pull and push, so today a remote lock at `version: 3` still
  reports an ordinary freshness state — the panel can invite a pull that will then be
  refused. Decide it here: a remote whose lock version is higher than this build
  understands reports `unknown` (the state that already means "this remote cannot be
  compared"), so the invitation never appears. No new `RemoteState` value, no UI change.
- **The WRITERS carry the tail too, or §3.1 is theatre** (task-2 review, finding I-1).
  §3.1 makes the parser carry unknown keys, but three sites rebuild lock structures from
  fresh literals and would strip them again on the way out:
  - the pull merge (`ConfigSyncCore.ts` ~1269) builds `{capturedAt, groups}` — it must
    carry the local lock's unknown TOP-LEVEL keys;
  - capture (`ConfigSyncCore.ts` ~547) builds the whole lock the same way;
  - capture rebuilds each captured group's ENTRY from a literal
    (`ConfigSyncCore.ts` ~573-576 and ~595-597) — it must merge its computed fields ONTO
    the existing entry rather than replace it, or an unknown entry field is stripped and
    published for every group this device captures.
  Decide carry-vs-recompute explicitly per site and say so in the report; a round-trip
  test must cover capture and pull, not only parse.
- **Comparison is order-insensitive.** Entries are compared key by key (excluding
  `label`/`memberLabels`), never by `JSON.stringify`, so neither the known fields nor the
  carried unknown tail can read as "the remote is ahead" merely by being emitted in a
  different order. This retires the fixed-order workaround task 2 had to add.
- **The items answer first; the stamp speaks only where they leave a gap** (ruling
  2026-08-11, task-4 fix round 2). When every remote entry is present locally and both
  sides carry an orderable date, `remoteLockAhead` returns false without consulting any
  timestamp. A timestamp is a stand-in for a content comparison; where real content
  evidence exists, the stand-in has no standing. Consequences this makes binding:
  - the per-item `hash` must cover EVERYTHING that travels for that item, sidecars
    included — a signal trusted absolutely has to be true absolutely (task-4 round 3);
  - every writer of store content re-dates and re-fingerprints what it changed. This is
    an obligation maintained BY THE WRITERS, not a property that falls out of the design;
    a future writer of store content inherits it. Capture and the pull's non-adopted
    writes both do it today; entries adopted verbatim from a remote deliberately do not,
    since rewriting them is what would break convergence;
  - "dated" means ORDERABLE. A stamp `Date.parse` cannot order is treated as absent, so
    the timestamp path can still speak, rather than as present-and-useless, which would
    silence both paths.
- **A lock's lineage is never older than what it captured itself.** The comparison uses
  `max(syncedWatermark, capturedAt)`, and a pull records the remote's lineage rather than
  its bare watermark — otherwise adopting content leaves this device recorded as behind
  the very content it just took. This is what puts a v1 lock and a v2 lock on one scale.
- **`capturedAt` is an ORDERING key, not a difference** (ruling 2026-08-11, task-4
  concern 1 — amends the bullet above). Two devices holding byte-identical content
  captured at different moments are not different, and treating the timestamp as a
  difference would light the "the store has newer settings" hint on every other device
  after every local capture — the exact false positive this section exists to remove.
  `hash` is the content signal; `capturedAt` orders the two sides once a real difference
  is found.
- **Out of scope:** exposing item-level remote counts in the UI (the ⇡/⇣ pills keep
  their per-remote meaning), and the `source`/`innate`/`display` entry partition —
  restructuring the entry would make every older reader treat the store as `unknown`
  (manifest.ts:261-263), so it waits until §3.1's reader is the fleet's floor.

## §7 Frozen

No schema bump (data.json stays `schemaVersion: 2`; the store gains `version` but reads
v1). No namespace change (item id vs group name is a separate project). No behaviour
change to capture/apply/pull/push beyond the refusals above. No visible UI change beyond
the three messages, all of which reuse existing surfaces.

## §8 Tests

- Round trip: a lock with unknown top-level and unknown entry keys parses and
  re-serialises with them intact; the existing validation errors are unchanged.
- `memberRules` holding an unrecognised value: loading changes nothing on disk and
  triggers no save; the value is ignored where consumed.
- `refreshBratIndex` with an empty repo list: index unchanged, nothing saved.
- The settings classifier: fresh / ok / legacy / future, including `schemaVersion: 3`.
- The pre-write guard: applying a self item whose stored document declares a higher
  schema fails that item and leaves the local document byte-identical.
- Nested defaults: an older document missing a nested field gets the default, and its
  unknown keys survive the load-save cycle.
- opt-out migration: a document carrying this device's id moves it to localStorage and
  drops the field; a document carrying only OTHER devices' ids leaves this device with
  no opt-out and still drops the field.
- Lock semantics: a pull from an older remote does not move local `capturedAt`
  backwards; `remoteLockAhead` still converges to false after a pull; a label-only
  change is not "ahead".
- Baseline 1274 tests stays green.

## §9 Gates & verification

Suite green + new; build clean; lint 0 errors and no new warnings (baseline **58** — the
task-1 implementer measured HEAD from a pristine `git archive` copy; the 57 this spec
first claimed was wrong); NO
commits; no Claude attribution anywhere.

**Vault whitelist: deploy and act on `kickstart.vault` and `llm-wiki.vault` ONLY.
`main.vault` is the user's production vault — never deploy to it, never reload it,
never capture or push there.** Pulling FROM the existing `main` remote is read-only
against it and is allowed.

Live FAIL CRITERIA (kickstart, after deploy):
1. Restore the opt-out for Remotely Save (from git `b85a218d`, or re-set it in the UI),
   then `pull main` + adopt: the opt-out **survives** and Remotely Save stays out of To
   apply. **`data.json` still CONTAINS `deviceOptOuts`** — amended 2026-08-11 with §2's
   carried-field ruling; the original criterion demanded the field be gone, which a
   correct build now fails on purpose. What to check instead: localStorage's
   `config-sync-device-optouts` holds the group, the document's map still names this
   device's id for it, and any other device's id in that map is untouched.
1b. Revoking an opt-out sticks: turn Stop syncing off again, then `pull main` + adopt
   from a store copy that still carries this device's id (main.vault's document is
   exactly that, being on an older build) — the opt-out **returns**, because the
   migration unions rather than tombstones. This is accepted behaviour, not a bug: it
   errs toward preserving a choice rather than losing one, and it stops once every
   device runs a build that no longer publishes the field. Note the field is no longer
   cleared for the fleet by a capture (that was the deleted-field design); what a
   revoke does clear is this device's id inside the carried map. State it in the
   release notes.
2. After a capture, `store.lock.json` shows `version: 2`, a `syncedWatermark`, and
   per-group `capturedAt` + `hash`; the remote pane and the ⇡/⇣ pills read the same as
   before the change.
3. A scratch copy of a store whose lock says `"version": 3` is refused by pull with the
   §4.3 message, and the local store is untouched.
4. A hand-edited scratch `data.json` with `schemaVersion: 3` puts the plugin in the stop
   state with the §4.1 copy, and the file is **still byte-identical** afterwards.
