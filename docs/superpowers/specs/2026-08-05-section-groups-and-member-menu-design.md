# Section type grouping + member-list direct menu — design

Date: 2026-08-05 · Scope: A, R3-A, R4-B of the 2026-08-05 round · Status: approved
(mockup 定稿: `.superpowers/brainstorm/85022-1785849756/content/r3-r4-scope-fixes.html`)

## A · Extra sections group rows by type

**Problem**: the All-items main section groups rows under scope headers (定稿 A,
`renderRowList`), but the extra sections — "Disabled on this device", "Not installed on
this device", "Outdated on this device", "Desktop-only" — render flat
(`renderSection`:1541, `renderInfoSection`:1485), so core and community plugins mix
indistinguishably. After the install-regression fix (spec `restore-not-installed-items`)
the "Not installed" section can hold 60+ rows on a bootstrap device — grouping becomes
essential there.

**Design**: `renderSection` and `renderInfoSection` render their row lists through the
same path as the main section: scope headers (`config-sync-sect` style) when the panel
scope is All items, flat when a single-type sidebar filter is active (定稿 B unchanged).
No new visuals; the headers are the ones the main list and history detail already use.

## R3-A · Structural-local member rows become read-only

**Problem**: `enablementScopes` derives scope `"local"` for every member whose item
config has `enabled: false` (settings-sync card off) — a **structural** fact, not a rule
the user wrote. The scoped disclosure ("N scoped to specific devices") renders every row
with an always-active scope control; on a structural row the cycle's write
(`clearMemberLocal`) cannot change what the row re-derives — a permanent no-op — and it
silently deletes any stored `enabledOn` rule for that item.

**Design**:

- `MemberDecision` gains `structural: boolean` — true when the derived scope is `"local"`
  solely because `cfg.enabled === false` (no `localMembers` entry, no `enabledOn`).
  Derivation lives in the pure layer (`memberDecisionsFromScopes` / its inputs), tested.
- The scoped disclosure renders structural rows read-only: greyed scope glyph
  (non-interactive) plus hint text, copy per mockup (final):
  **"settings sync off — turn it on in Settings to set a rule"**.
- Explicit rows (user-pinned `localMembers` / `enabledOn`) stay interactive.

## R4-B · Member scope control: direct menu replaces the cycle

**Problem**: the scope-cycle persists every intermediate stop. In the "Set a per-plugin
rule" list on a phone, the first click toward "This device" durably writes
`enabledOn: "desktop"`; `scopedAwayMembers` then masks the row out of the list the user
is working in mid-gesture. An abandoned gesture leaves a rule that force-offs the plugin
on this device at the next Apply. (The pre-2.15.0 menu had no intermediate states.)

**Design**:

- In the two Sync Center member lists — "Set a per-plugin rule" (`renderPerPluginRules`)
  and the scoped disclosure (`renderScopedDisclosure`) — clicking the scope glyph opens a
  **menu** (Obsidian `Menu`) and writes exactly the chosen target once:
  - Everywhere · Computers only · Phones only · This computer/phone only (device-aware
    wording; current value checked; desktop-only plugins omit "Phones only" via the
    existing `scopeOptionsFor`).
- Writes map through the existing `memberScopeWrite` — no change to write semantics,
  only to how the target is chosen. No intermediate persistence exists anymore, so no
  freeze/migration machinery is needed.
- The **scope-cycle stays** everywhere else (Settings item cards, per-key rules) — those
  contexts have no row-migration hazard. Glyphs are unchanged (`SCOPE_ICONS`); only the
  click behavior in these two lists differs.

## Tests

- panelModel: `structural` flag derivation (card-off → structural local; explicit
  localMembers/enabledOn → not structural); menu target → `memberScopeWrite` mapping
  unchanged (existing tests keep passing).
- Section grouping is view-layer composition of already-tested pieces — no new pure
  functions; no new tests beyond keeping the suite green.

## Out of scope

- Bulk multi-select in member lists (deferred since ② 2.15.0 spec).
- Any change to the Settings-card scope cycles.
