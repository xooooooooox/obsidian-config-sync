# One vocabulary, one shape — schema v3 design

Date: 2026-08-11 · Scope: the settings document, the store lock, and the two search
bars · Branch: to be created · Status: 定稿 pending the user's read. Successor to
`2026-08-11-data-model-hardening.md` (shipped as 2.21.0), whose version gate is this
change's safety net.

The plugin names the same concept three different ways depending on where you stand,
and encodes taxonomy in strings that every consumer has to parse. This release gives
every concept exactly one word, lets structure carry classification, and splits the two
enums that collapsed orthogonal axes. It is a breaking document change (`schemaVersion:
3`, store lock `version: 3`) with a real migration, so it is one-way.

## §0 Preconditions — do not start implementation until both hold

1. **2.21.0 is published and is the floor on the user's own three vaults.** Its gate is
   what makes v3 survivable: a device on 2.21.0+ meeting a v3 document refuses it and
   says so, changing nothing. A device on **2.20.0 or earlier resets to defaults** —
   that path cannot be fixed retroactively, which is why the release notes for v3 must
   lead with "update every device first" rather than "nothing to do".
2. **The migration has been rehearsed on offline copies of all three vaults** (§10).

## §1 The vocabulary — one concept, one word

| Concept | Word | Values |
|---|---|---|
| which family an item belongs to | `section` | `obsidian` · `core` · `community` · `beta` · `custom` |
| file or directory | `type` | `file` · `folder` (`dir` retires) |
| who shares a value | `sharing` | the union below |
| which devices something runs on | `device` | `all` · `desktop` · `mobile` |
| how a file is handled | `mode` | `plain` · `fields` · `encrypted` |
| whether a value is encrypted | `encrypted` | boolean, orthogonal to `sharing` |
| one entry of an on/off list | **`element`** | — (`member` retires; see §5 C6) |
| what an item needs right now | `action` | derived, never stored |

```ts
type Sharing =
  | { kind: "everywhere" }
  | { kind: "per-class"; class: "desktop" | "mobile" }
  | { kind: "this-device" };
```

`scope` is retired as a word: it meant the settings area, the item category, and the
sharing rule, in three different places. Nothing is named `scope` after this change.
`Exclude<RuleScope, "local">` goes with it — a file-level rule simply cannot be
`this-device`, and the union says so.

## §2 `data.json` — `schemaVersion: 3`

```ts
interface ConfigSyncSettings {
  schemaVersion: 3;

  // transport wiring — locked-local preset, never travels
  rootPath: string;
  remotes: Remote[];
  thisDeviceItems: ItemRef[];          // was localMembers; ItemRef = `${section}/${id}`

  // the sync contract — structure carries the taxonomy
  items: Record<Section, Record<ItemId, Item>>;

  // preferences
  pkmMode; ribbonButtons; ribbonDot; statusInMenu; statusBarItem; statusBarRemote;
  mobileStatusBar; remoteAutoCheck; localPeriodicCheck; runHistory;
  bratIndex: Record<PluginId, string>; // was bratPluginIndex
}

interface Item {
  enabled: boolean;
  type: "file" | "folder";
  path?: string;                       // only when it differs from the default; required for custom
  settingsFile?: SettingsFile;
  companions?: Companion[];
  runsOn?: RunsOn;                     // was memberRules[itemId] + enabledOn
  elements?: Record<ElementId, RunsOn>; // on/off-list entries that are NOT items (snippet files…)
  origin?: "discovered";
}

interface RunsOn {                     // two orthogonal axes, not one enum
  device: "all" | "desktop" | "mobile";
  force?: { state: "on" | "off"; where: "everywhere" | "this-device" };
}

interface SettingsFile {
  mode: SyncMode;                      // plain | fields | ENCRYPTED — see the note below
  fileRule?: { sharing: Exclude<Sharing, { kind: "this-device" }>; encrypted: boolean };
  rules: Record<KeyPattern, { sharing: Sharing; encrypted: boolean }>;
  perElement: Record<KeyName, Record<ElementValue, Sharing>>;  // was perItem
}

interface Companion { path: string; device: DeviceClass; enabled: boolean }  // was scope
```

**`SettingsFile.mode` is the full `SyncMode`, `encrypted` included** (correction
2026-08-11, found by task 2). This spec first wrote `"plain" | "fields"`, and task 1
implemented that literally — which silently downgraded a custom rule set to Encrypted
into a plain one, so the next capture would have written that file into the store **as
plaintext**. The code is right and this line was wrong. A whole-file Encrypted rule is a
supported mode for custom rules and must survive both conversion directions.

```ts
```

**The top-level `memberRules` map is gone.** A plugin's entry in `community-plugins.json`
IS that item, so its rule is a property of the item (`runsOn`), not a side table keyed by
id. Entries that are genuinely not items — snippet files under the snippets folder —
live in their owning folder item's `elements`. A rule lives on the thing it governs.

`custom` stops being a second data shape (`customGroups: SyncGroup[]`) and becomes a
section whose items have the same `Item` shape as everything else; `path` and `type`,
which a registry item derives from its definition, are simply required there.

## §3 `store.lock.json` — `version: 3`

```ts
interface StoreLock {
  version: 3;
  syncedWatermark: string;                 // lineage; only a pull moves it
  capturedAt: string;                      // derived = max(items[*][*].capturedAt)
  items: Record<Section, Record<ItemId, LockEntry>>;   // was `groups`, flat string keys
}

interface LockEntry {
  capturedAt?: string;
  hash?: string;                           // "sha256:…"; absent for encrypted items
  source?: { kind: "plugin" | "app"; version: string };
  innate?: { desktopOnly?: true };
  display?: { label?: string; elements?: Record<ElementId, string> };  // was memberLabels
}
```

`sourcePluginVersion`/`sourceAppVersion` — a field name encoding which KIND of source —
becomes one `source` object. Those two had to stay flat in 2.21.0 because an older
reader throws on an entry with neither; **v3 is gated, so that constraint is lifted**,
and the `source`/`innate`/`display` partition that 2.21.0 §6 deferred lands here.

Unknown keys are still carried at every level, by the parser AND by every writer —
2.21.0's rule does not lapse because the shape changed. There are **four** lock writers,
not three: the startup label heal is the one that keeps getting forgotten, and it has now
been the site of a defect in two consecutive releases.

**The label heal never changes a lock's format** (ruling 2026-08-11, task-3 C1 — a
user-visible behaviour change, recorded here because it lived only in a review thread).
Writing a v1/v2 lock back in v3 shape while keeping its old `version` produces a hybrid
that a 2.21.0 peer neither refuses (it reads `2`) nor parses (it needs `groups`) — it
treats it as corrupt, and its next capture rewrites the lock flat, destroying the v3
bookkeeping including the `legacy/` entries §4 exists to preserve. So the heal runs only
on a lock whose declared version is exactly the one this build writes; v1, v2 and v4+ are
skipped byte-identical. **A format upgrade is earned by a user's action — a capture or a
pull — never by a cosmetic fix to a display name.** The cost is deliberate and belongs in
the release notes: on a v1/v2 store, a stale display name stays stale until one of those
happens.

## §4 localStorage

Unchanged homes, re-keyed values:

```ts
"config-sync-device-id":           string
"config-sync-device-optouts":      ItemRef[]     // "section/id", was group names
"config-sync-baselines":           Ledger        // keys re-keyed to ItemRef
"config-sync-passphrase":          string
"config-sync-coldstart-dismissed": "1" | absent
```

**§4 belongs to task 3, not task 2** (ruling 2026-08-11, task-2 concern 1). Baselines, the
lock, the opt-out list and `switchExceptions` are ONE key space — the compiled group name —
and nothing re-keys that space until the lock is re-keyed. Re-keying the ledger to
`ItemRef`s while every reader still asks by group name would make every baseline
unresolvable, which reads as never-synced, which defaults to APPLY: the precise harm the
gate below exists to prevent. Companions and carriers also hold baselines and have no
`ItemRef` at all. So the re-key lands with the lock, in one change, or not at all.

**The key space, answered (rulings 2026-08-11, task 3).**
- **A companion is keyed under its owner** — `<owner ref>/<basename>`, e.g.
  `obsidian/appearance/themes`. It has no identity of its own, and its group name is
  unique only because `companionNameConflict` forbids a clash; owner-relative keying makes
  that uniqueness structural instead of enforced, and ties the baseline's lifetime to the
  card that owns the sync.
- **A carrier is an item, keyed `obsidian/<list>`.** The file it carries IS one of
  Obsidian's own config files, and the `obsidian` id space is closed and declared in code
  — so a carrier key cannot collide with an item by construction. Filing it under `core`
  would put it in the runtime-injected core-id space, where non-collision is only
  probable. Showing carriers under the Core/Community tabs is presentation, the same
  stored-vs-presented split §7b blesses for `beta`.
- No item id contains `/`, so the segment count reads the kind: two = item or carrier,
  three = companion.
- **An unmappable baseline is KEPT under `legacy/<name>`**, a section deliberately not a
  `StorageSection`, so `parseItemRef` refuses it and no reader can resolve it. Dropping it
  would read as never-synced and default to APPLY; keeping it resolvable under
  `custom/<name>` would be worse still — a stale companion entry could become a later
  custom rule's provenance, which is classification leaking into identity, the defect this
  whole release ends. Inert and honest beats either. Deleting it stays the ordinary
  prune's job, which can answer what a migration cannot: is this still synced HERE?
- **`switchExceptions` is NOT part of this key space** — it is in-memory, per-run, keyed by
  the switch list's own identity and never persisted. §4's original wording lumped it in;
  that was wrong.

**Baselines must be re-keyed, never dropped.** A missing baseline reads as never-synced,
which defaults to APPLY — dropping the ledger would offer to overwrite this device's
config for every item at once. This is the single most dangerous step in the migration
and needs its own test.

## §5 Migration map — every v2 field's landing

| v2 | v3 | Note |
|---|---|---|
| `items["community:x"]` | `items.community.x` | section from the prefix; bare ids (`app`/`appearance`/`hotkeys`) → `obsidian` |
| `customGroups[]` (SyncGroup literals) | `items.custom[name]` | `type: "dir"` → `"folder"`; `devices` → `runsOn.device`; `description` kept |
| `memberRules[id] = "all"\|"desktop"\|"mobile"` | `items[section][id].runsOn.device` | |
| `memberRules[id] = "always-here"` | `runsOn.force = { state: "on", where: "everywhere" }` | **behaviour-preserving**: today's "here" rules are fleet-wide in effect (C-#46), whatever the copy says |
| `memberRules[id] = "never-here"` | `runsOn.force = { state: "off", where: "everywhere" }` | as above |
| `enabledOn: "desktop"\|"mobile"` | `runsOn.device` | `"local"` was already drained into `localMembers` |
| `localMembers[]` | `thisDeviceItems[]` | re-keyed to `section/id` |
| `settingsFile.rules[k].scope: "all"` | `sharing: { kind: "everywhere" }` | |
| `… "desktop"\|"mobile"` | `sharing: { kind: "per-class", class }` | |
| `… "local"` | `sharing: { kind: "this-device" }` | |
| `fileRule.scope` | same mapping, `this-device` unrepresentable | |
| `perItem` | `perElement` | value mapping as above |
| `companions[].scope` | `companions[].device` | |
| `bratPluginIndex` | `bratIndex` | |
| `deviceOptOuts` (carried) | **dropped** | C-#54 phase 2 — the gate replaces the carry |
| `companions: []` written everywhere | **stop writing** | C-#54 phase 2, same reason |
| lock `groups[name]` | `items[section][id]` | name → ref via the same prefix rules |
| lock `sourcePluginVersion`/`sourceAppVersion` | `source: { kind, version }` | |
| lock `desktopOnly` / `label` / `memberLabels` | `innate` / `display.label` / `display.elements` | |

Retired outright: `legacyGroupName`, `itemIdFor` (and with it the folder-name-shadows-a-
registry-id bug), the `plugin-` name prefix, `SWITCH_LIST_GROUPS`' hardcoded name set
(the registry declares which items are carriers), and
`enablement.carrier: "core-plugins.json"` → `enablement.list: "core-plugins" |
"community-plugins"`, with the filename derived from that identity in one place.

Migration runs once on load, saves once, and is **one-way**: after it, the document
cannot be read by 2.21.0 (which refuses it politely) or by ≤2.20.0 (which resets).

## §6 The gate handover

- A **v3 build meeting a v2 document**: migrates per §5, saves once, continues. A v1 or
  unversioned document keeps today's legacy path.
- A **2.21.0 device meeting a v3 document or store**: refuses, changes nothing, tells the
  user to update — the behaviour that release exists to provide. Verify it live rather
  than assuming (§10), because this is the first time it is exercised for real.
- A **≤2.20.0 device meeting a v3 document**: resets to defaults. Unfixable from here;
  it is the reason for §0 and for the release-note wording.

## §7 Breaking changes the user sees

- Search qualifiers: `scope:` → `section:` in the Sync Center, `scope:` → `section:` in
  the settings panel (values gain `general`/`advanced`/`remotes` there). **No aliases** —
  the user's ruling; the old syntax stops working and is documented as such.
- `type:dir` was never user-facing; `type:folder` was already the UI's word and now the
  data agrees with it.
- `section:custom` means custom items **in the Sync Center**; in the settings panel custom
  rules and discovered files are indexed under `advanced`, so `section:advanced` is what
  finds them there (correction 2026-08-12, task-4 concern 1 — the original line above
  described an intention, not the code). Making `section:custom` work in the settings
  panel would move that query from zero hits to N, and this release freezes search
  BEHAVIOUR while renaming its vocabulary. The remaining wart — one word meaning
  something slightly different in each panel — is deliberately deferred: it is a search
  change, and it deserves its own decision rather than riding a rename.
- `type:folder` in the settings panel matches nothing and always has: `buildSearchIndex`
  hardcodes every item as `file`. Pre-existing, frozen here, and the docs do not claim
  otherwise. Ledgered rather than fixed, because both available fixes (teach the index
  about folders, or drop the value) change what a query returns.
- Docs currency: README, README.zh, GUIDE and ARCHITECTURE all state the new vocabulary,
  and GUIDE's search section lists the retired syntax explicitly.

## §7b Rulings made during task 1 (2026-08-11)

- **`runsOn` merging two v2 fields changes one behaviour, deliberately.** In v2 a Runs-on
  choice of "Computers only"/"Phones only" was read by nothing but the menu; the
  capture/apply mask followed `enabledOn`. One field now means one thing, so the choice
  masks too. That is the release's whole point — two fields that could disagree is the
  defect class, not the feature — and it goes in the release notes.
  **Migration rule (task 2): preserve what the system DID, not what the menu SAID.**
  `runsOn.device` = `enabledOn` when present, else the class value from `memberRules`,
  else `all`. A document where the two disagreed keeps its effective masking, and the
  menu starts telling the truth about it.
- **`section` has FOUR stored values — `obsidian` · `core` · `community` · `custom`.**
  `beta` is not a family, it is an install source (BRAT), derived at runtime from
  `bratIndex`; a beta plugin stores under `community`, exactly where its v2 key put it.
  Storing it would mean an item changing section — and therefore its storage key — when
  BRAT's list changes, which is churn no benefit justifies.
  `section:beta` REMAINS a search value and a settings tab, computed rather than stored;
  say so in the docs rather than leaving the 4-vs-5 difference silent. This is the one
  place the stored vocabulary and the presented vocabulary legitimately differ, and it is
  the seam C-#32/#33 will revisit when they add a category.

- **Custom-rule order may hoist, and that is accepted** (ruling 2026-08-11, task-1
  re-review). `items.custom` is an object, so an all-digits rule name sorts to the top
  where v2's array kept authored order. Order was checked and is not load-bearing:
  `claimPath` is order-independent, customs compile last, duplicate detection is
  positional-free, apply groups are path-disjoint with install order re-sorted
  separately, and the Sync Center re-sorts by section and name. A blanket sort would be
  worse — it would reorder every existing vault to fix a naming edge case.
- **A derived key needs ONE producer** (task-1 final re-review, NEW-I2 — the sharper form
  of the lesson below). Changing an identity means finding every site that BUILDS it, and
  "every site" includes the ones that build it for a different purpose. The settings
  card's anchor was minted in four places; three moved to the new reference and the
  fourth, the search index, kept the old one — so every search hit in every section
  stopped jumping to its card, with no type error and no failing test. The sweep for
  section values could not see it because it never touches a section value. The fix is
  not a fourth edit, it is one named producer the other three call; and the test shape
  that catches it is producer-vs-producer, asserting the two sites agree rather than
  asserting either against a literal.
- **Closing a leak by construction protects MINTING, not MATCHING** (task-1 re-review,
  NEW-I1). Making `itemRef(beta, …)` unrepresentable stopped every site that BUILDS a
  reference, and the compiler found fifteen. It did nothing for sites that COMPARE a
  presentation `Section` against a stored one — an equality test between two strings
  compiles fine and fails silently. After any by-construction fix, sweep the comparisons
  as a separate pass; the type system will not do it for you.

## §8 Out of scope

- **C-#46's product question** — whether a `force` rule should mean this device or the
  fleet. The migration preserves today's behaviour (`where: "everywhere"`); the new field
  makes the choice explicit and cheap to change later. Do not fold it in here.
- C-#32/#33 (a new plugin category and a separate Beta section) — they touch `section`'s
  value list and want a mockup of their own.

## §9 Tests & gates

- A v2 → v3 migration fixture per row of §5, including the awkward ones: a custom group,
  a discovered file, an item with `perItem`, `enabledOn: "mobile"`, and a `never-here`
  rule.
- **The two v2 normalizers task 1 deleted must be re-created inside the migration and
  re-tested** — `mergeLegacyAppSliceItems` (the app-slice merge, including its
  first-seen-wins order `editor → files-links → other → appearance`) and
  `drainEnabledOnLocal` (`enabledOn: "local"` → `thisDeviceItems`). Task 1's review
  called these the release's only real coverage loss; they are deferred behaviour, not
  retired behaviour, and only a prose comment records them today.
- **v2 `customGroups` entries carry their unknown fields through the migration** — the
  2.21.0 carry invariant applies to the migration path too.
- **Baseline re-keying**: after migration every baseline still resolves, and no item
  reads as never-synced. Assert the count of never-synced items is unchanged.
- Lock v1 → v3 and v2 → v3 conversion, with unknown keys surviving at both levels.
- Round trip: a v3 document and a v3 lock with unknown fields re-serialise intact.
- The gate: a v3 document/lock is refused by the 2.21.0 code path (kept as a fixture,
  not by installing the old build).
- Suite green (1394 baseline), build clean, lint 0 errors / no new warnings (58).
- NO commits; no Claude attribution.

## §10 Verification

**Vault whitelist: kickstart and llm only for iteration.** main.vault is the user's
production vault and is touched only after they say so, and only once the rehearsal
below has passed.

1. **Rehearsal first**: copy all three vaults' `.obsidian/plugins/config-sync/data.json`,
   their store and lock, into a scratch tree; run the migration against the copies; diff
   the result field by field against §5's table.
2. On kickstart: migrate live, then confirm the Sync Center reads identically to before —
   same items, same sections, same fates, same counts. A migration that changes what the
   panel says has changed behaviour, not shape.
3. Confirm the baselines survived: no item flipped to never-synced.
4. Point kickstart at a v2 store and confirm the refusal, then at a migrated v3 store and
   confirm normal operation.
5. Only then main.vault, with a backup taken first.
