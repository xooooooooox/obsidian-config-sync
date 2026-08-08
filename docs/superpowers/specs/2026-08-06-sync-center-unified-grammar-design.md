# Sync Center unified grammar (C rework) — design

Date: 2026-08-06 · Status: approved via mockups (`.superpowers/brainstorm/39861-1785943358/content/`
`c-grammar-round1.html` → `c-hybrid-round2.html` → `c-interactive-round3.html` →
`c-states-round4.html`; copy therein is final) · Implementation: **separate branch**
(user decision — the current round's uncommitted tree must land first; flag before branching).

Resolves ledger issues #5 (dual-surface residue), #8, #9, #10, #11
(`.superpowers/sdd/2026-08-05-install-runtime-audit-round/live-test-issues.md`).

## 1. Principles

- **One object = one row.** A plugin/settings item/folder appears exactly once in the main
  list. The on/off carrier cards, the "Disabled on this device" and "Not installed on this
  device" sections, per-row policy segments, fate pills, and the "has settings below" pill
  (#9) all dissolve into row state. **An object includes its companions** (amendment
  2026-08-07, C-#15 companion-dissolve batch): a parent item plus every companion group
  its item owns — Appearance's `themes`/`snippets` presets, or any item's Settings-drawer
  `+ Add folder` companions — is one object, dissolving into the parent's row/entry in
  both panes; companion groups never render their own row. Custom `+ Add folder` groups
  and the legacy `enabled-css-snippets` switch list are not companions and stay their own
  objects. The sole exception is an orphan companion (its parent group not compiled
  locally), which keeps its own row — honest degradation, the one place the `Parent ›
  Name` breadcrumb still appears inside the object grammar (it otherwise survives only in
  Settings drawers and run reports).
- **Row = checkbox · display name · state chips · fate sentence · disclosure.** Nothing else.
- **Checkbox has one meaning everywhere:** include this row in the next Apply/Capture run.
  Selection never changes what would happen — only whether it happens. Section select-all
  is therefore always safe.
- **The fate sentence is the grammar's core:** direction glyph + verbs describing
  everything the run will do to this object. All derived, never stored.
- **Two rule menus only** on the expanded card — `Runs on` (enablement) and `Settings sync`
  (item-level device scope). Everything deeper (per-key rules, locks, companions, custom
  folder config, raw preview) stays in the Settings tab, reachable via the `More` bridge.
  Both surfaces edit the same stored rules (config-sync data.json); the Sync Center list is
  a pure derivation `f(.obsidian, store, rules)` and re-renders after any rule write.
- **Organization: type sections + the existing state filter pills** (hybrid). Filters hide
  rows; rows never move between sections.
- **Vocabulary rule (binding for all UI copy):** narrate in devices and consequences using
  only the established nouns — `this device` / `your other devices` / `the store`. No new
  concept nouns (no "fleet", no implementation terms like carrier/switch list/sidecar).

## 2. Sections and filters

Fixed section order, alphabetical within (existing `byLabel`):

1. `Obsidian` — App settings, Appearance, Hotkeys
2. `Core plugins` — header chip `on/off synced ✓` / `on/off not synced`
3. `Community plugins` — same header chip; the config-sync **self row** pinned first
   (copy: `your Sync Center — manages itself`; expand keeps today's self-card content)
4. `Your folders` — custom groups from + Add folder (label as name, path as dim chip)

- Filter pills (top, kept from current version): `All · N` / `To apply · N` /
  `To capture · N` / `In sync · N` / `Nothing yet · N`. Zero pills render dimmed. Under a
  filter, section counts read `6 of 31`; sections with no visible rows hide entirely.
- Per-section trailing fold lines (#10): `22 in sync ▸ · 3 with nothing to sync yet ▸` —
  aggregate only their own section; expandable in place.
- Section select-all/clear targets **actionable** visible rows only: excludes the self row,
  in-sync, nothing-yet, and unresolved-conflict rows.
- The `on/off synced` chip opens a small popover: toggle the carrier's sync membership
  (the only remaining home of the carrier as a configurable item); when off, chip reads
  `on/off not synced` and the fallback grammar (§5) activates.

## 3. Row anatomy

### Collapsed row

`[checkbox] Name [chips…] <fate sentence> ▸`

Chips (only when the fact deviates from the default): `not installed here` ·
`desktop only` · `stays off` (off in the store's on/off list) · `off here — your rule` /
`on here — your rule` (Runs on exception) · `🔒 encrypted` · folder path chip ·
conflict handled by the fate sentence itself. In-sync/nothing-yet rows render dimmed with
hidden checkbox.

### Fate sentence verb table (copy final)

| Situation | Sentence |
|---|---|
| apply: not installed, store list turns it on, has settings | `↓ Installs · turns on · applies settings` |
| apply: not installed, off in the store list | `↓ Installs · applies settings` + chip `stays off` |
| apply: installed, off here, store list turns it on | `↓ Turns on · applies settings` (or `↓ Turns on`) |
| apply: newer version in store | `↓ Updates · applies settings` |
| apply: settings only | `↓ Applies settings` |
| apply: Appearance | `↓ Applies theme & snippets — live` |
| apply: folder | `↓ Applies N files` |
| capture: settings changed here | `↑ Captures settings` |
| capture: turned on here (carrier delta) | `↑ Turned on here — shares it` |
| capture: Appearance | `↑ Captures theme & snippets` |
| capture: folder | `↑ Captures N files` |
| both changed | `⚠ Changed on both sides` |
| identical | `— In sync` |
| no store data & no local settings (also: a derived direction whose verb set is empty — degrades here, C-#28) | `— No settings yet` |

Verbs join with ` · `; first letter capitalized. `Runs on` exceptions re-derive the
sentence (e.g. `Never on here` removes `turns on`, adds the rule chip). When the carrier is
unsynced, enablement verbs never appear (§5). A non-folder object whose companions
contribute file changes joins the folder verb after the settings verb (amendment
2026-08-07, C-#15 companion-dissolve batch): `↓ Applies settings · applies N files` /
`↑ Captures settings · captures N files`; a plain folder object (no parent settings
payload) keeps the `apply: folder` / `capture: folder` rows above unchanged, and
Appearance's override row always wins over the join.

## 4. Expanded card

Standardized rows, in order (omit when not applicable):

- `On apply` / `On capture` / `State` — the fate sentence expanded to a full clause, with
  specifics: install source (`from the community catalog` / `via BRAT`), update versions
  (`Updates 2.14.0 → 2.15.1`), capture consequence (`Shares your settings with your other devices`;
  for enablement: your other devices will turn it on the next time they apply).
- `Files` — direction-aware entries (#8): apply-side additions `+ file` (green) with
  `view ▸` opening the full incoming content (like the remote pane's "not in your store"
  view) or `diff ▸` when both sides exist; capture-side `↑ file · diff ▸`; encrypted:
  `changed — encrypted, no preview`; deletions strikethrough only when the effective
  direction actually deletes.
- `Resolve` (conflict rows only) — segmented `Use theirs ↓` / `Keep mine ↑`; until
  chosen the row is unstageable; after choosing, the collapsed row reads as a normal
  directed sentence plus chip `your choice`.
- `Runs on` (plugins, carrier synced) — menu, five options:
  `Follows your devices` / `Computers only` / `Phones only` / `Always on here` /
  `Never on here`. Unifies the existing per-plugin rules, member class scopes, and
  this-device pins into one control (see §6 mapping).
- `After install` (only when carrier NOT synced, row installs) — menu `Turn it on` /
  `Leave it off` (today's policy ladder, alive only in the fallback).
- `Enablement` (only when carrier NOT synced ∧ plugin installed ∧ locally off) — same menu
  `Turn it on` / `Leave it off`; restores the pre-C fallback enable path in the new grammar
  (amendment 2026-08-06, from Task 6 review finding b). The fate sentence still carries no
  enablement verbs when the carrier is unsynced — only the staged action changes.
- `Settings sync` — item-level device-scope menu mirroring the Settings tab's file-level
  scope cycle exactly: three stops (`All devices` / `Desktop only` / `Mobile only`), same
  glyphs, same write target. File-level scope excludes `This device` by design (D9 — the
  validator rejects it); only KEY-level rules carry a this-device stop (amendment
  2026-08-07, live-test C-#12 investigation).
- `More` — `Per-key rules, locks & folders — opens Settings ▸` (folders:
  `Folder rules — opens Settings ▸`): deep link opening the plugin's Settings tab scrolled
  to that item's card, expanded.
- `Note` — honest runtime notes (e.g. Hotkeys: `Takes effect after an app reload`).

## 5. Behavior semantics

- **Staging:** the payload derives per selected row from its fate: file writes (settings /
  folder files), install/update action, and — when the carrier is synced — its enablement
  element. No stored per-row action state beyond the checkbox and conflict resolutions
  (session-scoped).
- **Partial-selection switch writes (feasibility core):** the carrier file is written once
  per run; its final list = store list merged with local, where **unstaged members are
  treated as run-scoped exceptions** (existing `applySwitchList` exception mask /
  `switchForceOff` machinery — no new data model). Capture side symmetric: only staged
  members' local states flip in the store list.
- **Runtime switching** (RUNTIME_SWITCH_GROUPS), **install ordering** (catalog before
  BRAT), **settings-before-enable** (StatePrelude), and **appearance hot-apply** (Batch 2)
  are consumed unchanged.
- **Conflicts** are excluded from select-all and unstageable until resolved; resolution is
  per-row, session-scoped, and resets after the run.
- **Fate derivation** is a pure function extending the existing chain
  (`switchDivergenceFor` / `memberFate` / install-state probes / compare results); the
  `Runs on` rule feeds it. Full truth table in tests.
- **Footer:** `N selected — installs X · turns on Y · settings Z` (apply side) ·
  `captures M`; both `Apply` and `Capture` buttons shown when both directions are staged,
  each counting its own side.

## 6. Runs-on rule unification (data mapping)

One per-plugin enablement rule replaces three current forms. Stored in config-sync
data.json (shared across your devices via the self item), values:

| Menu option | Meaning / mapping from current data |
|---|---|
| `Follows your devices` | default — plain store-list membership (no rule) |
| `Computers only` / `Phones only` | existing member class scopes (`enabledOn`) |
| `Always on here` / `Never on here` | existing this-device pins / per-plugin exceptions |

Migration: existing rules load into the unified field losslessly (read old forms, write the
unified form on first change); no store-format change.

## 7. Unchanged

Sidebar (scopes list, remote badges, self chip), remote pane, history, pull/push, adopt
flow, Settings tab content (gains only the deep-link anchor), compact-mode switcher,
search (now hits one row per plugin). The three-layer data flow
(`.obsidian ↔ store ↔ remote`) is untouched.

## 8. Tests

DOM-free, extending the existing suite:

- Fate-sentence truth table (every row of §3's table + Runs-on exception re-derivations +
  carrier-unsynced suppression of enablement verbs).
- Staging derivation: selected rows → payload (install/update/settings/enablement element);
  self/in-sync/nothing-yet/unresolved-conflict rows never stage; select-all exclusions.
- Partial-selection switch merge: apply and capture sides, staged subset only, exception
  mask reuse; delta messages still name flipped plugins.
- Runs-on mapping: old rule forms → unified value → old consumers (mask, divergence) agree.
- Footer count derivation; filter-pill counts vs presented rows.
- View wiring stays manually verified (no DOM harness — accepted).

## 9. Out of scope / later

- Inline per-key exclusion shortcut inside the diff view (candidate follow-up once the
  bridge proves insufficient for a high-frequency action).
- Key-level scope editing in Sync Center (stays in Settings).
- Remote pane / history restyling to the new grammar.
- Any release cut decisions.
