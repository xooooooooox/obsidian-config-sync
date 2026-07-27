# Scope unification (granularity mechanism) — design

Date: 2026-07-24 · Status: approved · Baseline: 1.9.0 (`013ab1f`)

Mockup 定稿 2026-07-24: `scope-unify-mockup.html` (artifact label `scope-unify-v1`) — binding for structure, copy, and interaction. Phase split 定稿: two-phase plan, **phase 2 not in this iteration**.

## Goal

One scope vocabulary — **All devices / Desktop only / Mobile only / This device** — replaces the four divergent mechanisms ("Excluded" for plugins, "Pinned" + "Active on" for snippets, "Strip" for fields, lowercase device labels on groups). The two switch-list drawers become structurally identical; the fields drawer joins the same vocabulary. Zero store-format change.

## Model (partition)

Every syncable unit belongs to exactly one scope, assigned by rules:

- Capture splits by rule: shared (all) and class-scoped parts go to the store; **This-device values never leave the machine** (定稿).
- Apply reassembles: `this machine = shared + my class + my local`. A unit absent from the reassembly is simply not in effect — force-off is a consequence, not a special case.
- Implementation principle: **values stay in place, partitions are metadata.** Switch lists stay one physical list in the store; class membership is a travelling tag. Only key-level class scopes would need physical store compartments (sidecars) — that is phase 2, deferred until a real need is confirmed (design preview recorded in mockup section 05).

## Decisions (user-approved, mockup ①–⑧)

1. Member row = name + hint + one 4-value scope dropdown; "This device" absorbs pin/exclude.
2. Badges: `N device-scoped` + `N this-device` (replace `N excluded` / `N pinned` / snippet-only `N device-scoped`).
3. Explicit user class scope on a switch-list member ⇒ explicitly not enabled on the wrong device class (force-off), plugins/core now same as snippets. Auto-derived exclusions stay mask-only (see C).
4. When a local "This device" overrides a travelling class scope, the row shows an italic hint `overrides <Class> only`.
5. Dropdown routing: This device → local store; Desktop/Mobile → shared store (travels); All devices → clears both.
6. Auto rows: read-only dropdown `Desktop only (auto)` replaces the disabled toggle + "auto-excluded" text.
7. Fields drawer: single dropdown renamed `Strip → This device`, `Encrypt → Encrypted`; heading `Fields to protect → Field rules`.
8. Phase 2 (key-level Desktop/Mobile + store sidecars): **not now**; the fields dropdown gains no class options in this iteration.

## A. Settings storage & migration

New persisted shapes (flat, alongside existing settings):

- `memberScopes: Record<string, Record<string, "desktop" | "mobile">>` — group name → member id → class scope. Shared metadata; travels via the self item. Migrated from `snippetScopes` (nested under `"enabled-css-snippets"`). Plugins and core-plugins gain this capability for the first time.
- `memberLocal: Record<string, string[]>` — group name → ids kept device-local. Never travels. Migrated from `switchExceptions` (same shape, renamed).

Migration runs once in `loadSettings`, idempotent:

- Each pair migrates independently: if `memberScopes` is absent, build it from `snippetScopes`; if `memberLocal` is absent, build it from `switchExceptions`. After each migration the old key is deleted from the settings object. A new key that already exists is left untouched (never re-migrate, never resurrect).
- `selfPresetRules()` (catalog.ts) adds `{ pattern: "memberLocal", action: "strip", locked: true }` and **keeps** the `switchExceptions` strip — pre-migration data.json copies still carry the old key and it must never travel.

`FieldRule` storage is **unchanged** (`action: "strip" | "encrypt"`); the rename is UI-label-only. Refinement vs. the earlier discussion (which floated a schema migration): keeping the serialized form avoids any cross-device schema window and keeps the diff minimal; if phase 2 lands, the schema evolves then (class scopes need a value-bearing shape anyway).

Upgrade coordination: settings travel via the self item, so devices should upgrade together (sole-user vault, BRAT). Transient window: a not-yet-upgraded device applying a data.json captured by an upgraded device loses snippet scoping behavior until it upgrades (the `memberScopes` key is preserved in its data.json by the standard unknown-key passthrough, so upgrading fully recovers). Release notes state "update all devices promptly".

## B. Engine

- `switchList.ts`: unchanged except `subtractForceOff` gains map support — for `Record<string, boolean>` lists, force-off sets the key to `false` (arrays keep the existing remove behavior). This is the only engine-level change.
- `availability.ts`: `scopedAwaySnippets` / `snippetForceOff` generalize to `scopedAwayMembers` / `memberForceOff` — identical logic, group-agnostic names. `desktopOnlyPluginIds` unchanged.

## C. Wiring (main.ts)

For each switch group `G`, replacing today's snippets-only composition:

- `userLocal = memberLocal[G] ?? []`
- `userScoped = scopedAwayMembers(memberScopes[G] ?? {}, Platform.isMobile)`
- `derived` (community-plugins only, unchanged): desktop-only plugin ids on mobile + ids from plugin groups with a non-matching `devices` class. **Mask-only, never force-off** — so existing setups see no behavior change from the migration itself.
- `ctx.switchExceptions[G]` (the mask: capture pass-through, apply preserve, compare masking) `= userLocal ∪ userScoped ∪ derived`
- `ctx.switchForceOff[G] = userScoped − userLocal` (local wins over travelling scope, i.e. today's pin > scope, generalized)

Behavior change (release notes): an explicit class scope on a plugin or core-plugin member is enforced on the wrong device class — the member is removed from the applied list (array) or set `false` (map). Auto-derived desktop-only/`devices`-class exclusions keep today's keep-local-state semantics.

## D. UI (SettingTab; mockup sections 01–04, 06 binding)

**Unified drawer** — `renderLocalDecisions` becomes one renderer for all three switch groups (community-plugins, core-plugins, enabled-css-snippets):

- Heading `Device scope`; description verbatim: "All devices — synced everywhere · Desktop/Mobile only — only enabled on that device class (shared, travels) · This device — keeps its own on/off here, never synced."
- Every member row: name, state hint, spacer, one dropdown `All devices / Desktop only / Mobile only / This device`.
  - Displayed value: id in `memberLocal[G]` → "This device"; else `memberScopes[G][id]`; else "All devices".
  - This-device rows get the `is-local` tint and a filled chip (pin icon) `This device · on|off`; if a travelling scope ≠ all sits underneath, append italic `overrides <Class> only`.
  - Scoped-away rows (member's class ≠ this device): pill `<class>-only`, hint `not enabled here — scoped to <class>`, dropdown stays editable from any device (existing snippets behavior, now all lists).
  - Auto rows (desktop-only manifest / plugin-group `devices` derived): pill + reason hint + **read-only** dropdown labelled `Desktop only (auto)`; the disabled toggle and "auto-excluded" text are removed.
- Dropdown onChange: `This device` → add id to `memberLocal[G]` (leave `memberScopes` untouched underneath); `Desktop/Mobile` → set `memberScopes[G][id]`, remove id from `memberLocal[G]`; `All devices` → remove from both. Snippet pin buttons/`Unpin`/pin-chip-specific controls and the separate "Active on" dropdown are all replaced by this single control.
- Badges on the group row: `N device-scoped` (count of `memberScopes[G]`) + `N this-device` (count of `memberLocal[G]`), both hidden at 0; replaces `N excluded` / `N pinned` and extends the scope badge to all three lists.
- Orphan cleanup section (snippets): unchanged.
- The group-level device dropdown is suppressed for **all** switch-list groups (today only for enabled-css-snippets; same redundancy rationale, and the mockup group rows show none).

**Fields drawer**: heading `Field rules`; description "This device — the field never enters the store and keeps its local value. Encrypted — the field syncs, but is encrypted in the store."; dropdown options `This device` / `Encrypted` (values still serialize as `strip`/`encrypt`). Locked preset rules render as today.

**Group rows** (non-switch): `devices` dropdown labels capitalize to `All devices / Desktop only / Mobile only`. No other change.

## E. Out of scope

- Phase 2: key-level Desktop/Mobile scopes with store sidecars (`<group>/__scopes__/<class>.json`) — mockup 05 records the direction; nothing in this iteration blocks it, and the dropdown vocabulary already fits.
- Any store format change; Sync Center panel redesign; encryption mechanics; `userIgnoredFilters` special-casing (its correct expression is now a `This device` field rule on app.json — documentation mention only).

## Verification

- Gates: `npm test`, `npm run build`, `npm run lint` (67-warning baseline).
- Unit (`tests/`): `subtractForceOff` map semantics; mask/force-off composition (local ∪ scoped ∪ derived; forceOff = scoped − local; derived never in forceOff); settings migration (old→new, already-migrated no-op, old keys deleted, empty inputs); displayed-scope precedence (local > travelling > all).
- Smoke (dev vault via obsidian-cli): two drawers render identical structure; dropdown transitions write the right stores and update badges in place; seeded old-format data.json migrates on load; a plugin scoped `mobile` disappears from the applied enabled list on desktop (array force-off) and a core plugin scoped away applies as `false` (map force-off); fields drawer shows renamed labels with unchanged serialized rules.
- Docs (same branch, docs-currency): README + README.zh (1:1) — switch-list feature bullets rewritten to scope vocabulary; ARCHITECTURE — settings shapes and wiring rename; DESIGN — drawer component entry and 定稿 pointer.
- Changes stay uncommitted until the user asks for a commit/cut.
