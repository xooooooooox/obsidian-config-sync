# Per-snippet device scope + local pin for CSS snippets

## Problem

Obsidian tracks *enabled* CSS snippets as a `string[]` at `appearance.json →
enabledCssSnippets` (names, no metadata); the `.css` files live in
`.obsidian/snippets/`. config-sync has **no snippet awareness**: the files ride
the generic `snippets` dir group (opaque byte mirror) and the enabled-list rides
inside the `appearance.json` whole-file group as one opaque field. So the enabled
set is forced identical on every device.

That is the footgun the owner hit: a snippet is inherently device-class-specific
(`mystyle-mobile` for phones, `mystyle-ribbon-icons` for desktop) but there is no
way to say so. Enabling it anywhere enables it everywhere.

Plugins already solve the equivalent problem with a two-layer model that snippets
get none of, because the whole fine-grained layer is hard-gated to
`SWITCH_LIST_GROUPS = {community-plugins, core-plugins}`:

1. **Shared class scope** — a group's `devices: all|desktop|mobile` plus
   auto-derived `desktopOnly` (`availability.ts`), folded into the runtime
   exception mask (`augmentedSwitchExceptions`, `main.ts`).
2. **Device-local exception** — `switchExceptions` (device-local, stripped from
   the self group so it never travels), edited in `renderLocalDecisions`
   (`SettingTab.ts`).

## Design overview

Promote `enabledCssSnippets` to a **third switch-list group**,
`enabled-css-snippets`, reusing the set-membership machinery in `switchList.ts`.
Give it snippet analogues of both plugin layers, but at **per-snippet** (not
per-group) granularity, since all snippets share one list:

- **Active on (scope)** — per-snippet `all | desktop | mobile`, **shared**
  (new non-stripped setting `snippetScopes`, travels via the self group to every
  device). On a device outside a snippet's scope the snippet is **forced off**
  (removed from the local `enabledCssSnippets`) and masked from comparison.
- **Pin here (local decision)** — reuses `switchExceptions["enabled-css-snippets"]`,
  **device-local**, keep-local semantics (the machine's own on/off is preserved).
- **Precedence: pin > scope.** An explicit local pin wins over the shared class
  scope (the "I want this mobile-only snippet on *this* desktop" case).

The two layers differ only in **apply** behavior — scope force-removes, pin
keeps-local — and that is the one piece of new logic; masking on capture/compare
is the existing generic path.

Per Q2 (owner decision): **manual only, no auto-detection** of scope from
filename or in-file marker. Every snippet defaults to `all`.

## 1. The switch-list, via a contained field adapter

The `enabled-css-snippets` group joins `SWITCH_LIST_GROUPS`, so it inherits the
entire per-item layer (drawer, `switchListRows`, `switchDivergence`, exception
masking) for free. The only new core code is a **single-file adapter** in
`switchList.ts` — the `SyncGroup` schema, `groupStorePath`, and `groupRealPath`
are **not** changed, and the two existing lists behave byte-identically.

Two facts force the adapter: the switch-list machinery assumes
*file content == list content* (all 5 call sites do `parseSwitchList(wholeFile)`),
but `enabledCssSnippets` is a field *inside* `appearance.json`; and a group's
store path derives from `group.path`, so the snippet list needs a store identity
distinct from the `appearance.json` group.

**Resolution — a spec table + field-aware read/write + a local-path redirect:**

```ts
// src/core/switchList.ts — SyncGroup schema untouched
export interface SwitchListSpec {
  localFile: string;   // file under {configDir} the LOCAL list lives in
  field?: string;      // set => the list is this array field inside localFile; unset => whole file
  storeName?: string;  // store artifact basename; defaults to localFile
}
export const SWITCH_LISTS: Record<string, SwitchListSpec> = {
  "community-plugins":    { localFile: "community-plugins.json" },
  "core-plugins":         { localFile: "core-plugins.json" },
  "enabled-css-snippets": { localFile: "appearance.json", field: "enabledCssSnippets",
                            storeName: "enabled-css-snippets.json" },
};
export const SWITCH_LIST_GROUPS = new Set(Object.keys(SWITCH_LISTS)); // derived

// LOCAL-side only. Read the list out of the local file (whole file, or the array field).
export function readLocalSwitchList(name: string, content: string): SwitchList | null { /* field ? obj[field] ?? [] : parseSwitchList */ }
// LOCAL-side only. Write a produced list back into the local file (whole array, or appearance.json with only that field replaced).
export function writeLocalSwitchList(name: string, list: SwitchList, priorContent: string | null): string { /* field ? {...JSON.parse(prior), [field]: list} : serialize */ }
```

**The store copy is always a plain array** (all three lists) — `parseSwitchList` /
`serializeSwitchList` handle the store side unchanged. Only the LOCAL read/write is
field-aware, so the asymmetry is contained:

- **Store identity.** The group's `path` is the virtual `{configDir}/enabled-css-snippets.json`,
  so `groupStorePath` yields a clean, non-colliding store file
  (`store/configdir/enabled-css-snippets.json`, a plain `string[]`) with **no
  change to `groupStorePath`**.
- **Local redirect.** Because that virtual path has no real local file, the
  switch-list read/write path (the only place already special-casing these groups)
  resolves the LOCAL path from `SWITCH_LISTS[name].localFile` — i.e.
  `appearance.json` — via a helper `localRealPath(name, group.path, configDir)`.
  For the two plugin lists (`field` unset) it returns `groupRealPath(group.path)`
  unchanged.
- **Touch points (local-content parses only):** `ConfigSyncCore` capture (local
  read), apply (local read + write + force-off), `status.compareFile` (local read),
  `main.diffPair` (local read) swap the *local* `parseSwitchList` →
  `readLocalSwitchList(name, …)`, resolve the local file via `localRealPath`, and
  the apply write uses `writeLocalSwitchList`. Store-content parses and
  `serializeSwitchList` stay plain everywhere. `merge.ts` operates on store copies
  (plain arrays) and needs **no change**.

**No double management.** Add a locked strip so the `appearance.json` group never
carries `enabledCssSnippets` (else both groups write the field, last-writer wins).
Reuse the existing strip mechanism (`selfPresetRules`-style
`{ pattern: "enabledCssSnippets", action: "strip", locked: true }` in
`catalog.ts`). Field strips require fields mode, so — like the self group, pinned
to fields mode for its locked strips (`SettingTab.ts:858-861`) — the
`appearance.json` group is pinned to fields mode when its snippet strip is active
(or the strip is applied mode-independently at capture, plan's choice). This is
the **only** interaction with the `appearance.json` group.

New catalog item in `catalog.ts` `OPTION_LABELS`:
`"enabled-css-snippets": { label: "Enabled CSS snippets", description: "Which CSS
snippets are on, per device.", type: "file" }` built in `listPluginSections` next
to the `community-plugins` switch item (fixed virtual path, pinned to Plain mode
like the other switch lists — `SettingTab.ts:847`).

## 2. Scope storage — shared, in `data.json`

```jsonc
// .obsidian/plugins/config-sync/data.json
"snippetScopes": { "mystyle-mobile": "mobile", "mystyle-ribbon-icons": "desktop" }
```

- Only **non-`all`** entries are stored (default `all` ⇒ absent). Small, sparse.
- Added to the settings type + `main.ts` init, next to `switchExceptions`.
- **Not stripped** by `selfPresetRules` (unlike `switchExceptions`, which stays
  stripped): so it lands in `store/configdir/plugins/config-sync/data.json` and
  reaches every device. This is the single shared source of per-snippet scope —
  no new store file, no store-lock change.

## 3. Runtime derivation — force-off vs keep-local, with precedence

Pure helper (new, `src/core/availability.ts`, beside `desktopOnlyPluginIds`):

```ts
// Snippet names whose scope excludes the current device class.
export function scopedAwaySnippets(scopes: Record<string, "desktop" | "mobile">,
                                   isMobile: boolean): Set<string> {
  const want = isMobile ? "mobile" : "desktop";
  return new Set(Object.entries(scopes).filter(([, s]) => s !== want).map(([n]) => n));
}
```

Extend the existing `augmentedSwitchExceptions` (`main.ts`) — which already folds
`deviceExcludedPluginIds` and `desktopOnlyPluginIds` into the community-plugins
mask — to also produce the `enabled-css-snippets` mask:

```
pins       = settings.switchExceptions["enabled-css-snippets"] ?? []
scopedAway = scopedAwaySnippets(settings.snippetScopes, Platform.isMobile)
exceptions["enabled-css-snippets"] = pins ∪ scopedAway     // masks capture + compare
```

`exceptions` masks capture (this device's absence never deletes a masked name
from the store) and comparison (no phantom `↑`/`↓`, no ping-pong) — identical to
the plugin path, so `excFor` (`ConfigSyncCore.ts`), `status.ts`, and `diffPair`
inherit it with no change.

The **one** snippet-specific addition is force-off on apply. In `applySwitchList`
for this list, after computing the generic result, subtract the force-off set:

```
forceOff = scopedAway \ pins          // pin > scope: a pinned name is never forced off
finalEnabledCssSnippets = applySwitchList(store, exceptions) \ forceOff
```

Net: pinned names keep the machine's own on/off; scope-away (non-pinned) names
are removed from the local list (self-healing a prior leak); everything else
follows the store.

## 4. UI (settings drawer) — 定稿 `snippet-scope-refined-v2.html`

New row **"Enabled CSS snippets"** (`appearance.json › enabledCssSnippets`),
expandable like the plugin switch lists. Extend `switchListRows(group)`
(`SettingTab.ts` host port) to return snippet rows for this group; the snippet
**universe is knowable** = `.css` files in `.obsidian/snippets/` ∪ store list ∪
locally-enabled. Each row: `{ id: name, name, scope, pinned, state }`.

Generalize `renderLocalDecisions` (or a sibling) beyond the two plugin lists to
render, per snippet row:

- **Active on** dropdown — `all | desktop | mobile`, writes `snippetScopes`
  (omit key when `all`). Outlined orange chip when non-`all` (like `.doto-pill`).
- **Pin** — Lucide `pin` via `setIcon`, faded until hover; toggles the name in
  `switchExceptions["enabled-css-snippets"]`. When pinned: a **filled** orange
  "Pinned here · on/off" chip (like `.devbadge`) + an "Unpin" action, and the
  Active-on dropdown greys out (the machine decides).
- Scope-away snippets on this device render as auto-off rows with a
  `mobile-only`/`desktop-only` pill, mirroring the existing desktop-only auto rows
  (`SettingTab.ts:583-600`).

Header badge: **"N device-scoped"** = count of non-`all` scopes (pins are not
counted). All device state uses `--color-orange`; scope = outlined chip, pin =
filled chip; no emoji (matches config-sync's Lucide + orange convention).

## 5. Sync Center — reactive pin offer

When a device's snippet state differs from the shared expectation (a name is
locally off but the shared/scoped state is on, or vice-versa) and it is **not**
already pinned or scope-masked, `SyncCenterView` surfaces it like the existing
switch-divergence flow (`switchDivergence` / `addSwitchExceptions`,
`SyncCenterView.ts:1497,1511`): a card offering **[Pin to this device]** (writes
`switchExceptions`) or **[Restore shared]** (drops the local deviation). This
makes pinning discoverable at the moment of conflict rather than requiring
foresight. Ignoring it leaves the name masked — differs, but no ping-pong.

## Data flow (a.css / a-mobile.css / a-desktop.css; desktop D, phone M)

- Files: all three `.css` mirror to every device via the `snippets` dir group —
  unchanged, untouched by this feature.
- Scope set once (`a-mobile → mobile`, `a-desktop → desktop`): lands in
  `snippetScopes`, travels in the store's config-sync `data.json`.
- **D apply**: `scopedAwaySnippets = {a-mobile}` → `a-mobile` removed from D's
  `enabledCssSnippets` (force off), masked from compare. D = `[a, a-desktop]`.
- **M apply**: `scopedAwaySnippets = {a-desktop}` → M = `[a, a-mobile]`.
- **Pin on D** (`IOTO-TDL` off locally, shared is on): `IOTO-TDL` ∈ pins →
  masked from capture/compare, and excluded from force-off → D keeps it off; M
  unaffected (M's `data.json` has no such pin).
- New desktop D2: reads the same `snippetScopes` from the store → `[a, a-desktop]`
  automatically, zero re-config.

`appearance.json` structure is **unchanged** throughout — still a flat
`enabledCssSnippets: string[]`. What changes is which names each device's array
contains; scope/pin metadata lives only in config-sync's `data.json`.

## Testing

- **`tests/availability.test.ts`** — `scopedAwaySnippets`: `{a-mobile:"mobile",
  a-desktop:"desktop"}` on desktop → `{a-mobile}`; on mobile → `{a-desktop}`;
  empty scopes → empty set; a `mobile`-scoped name on mobile is not excluded.
- **`tests/switchList.test.ts`** — field-targeted capture/apply against an
  `appearance.json` fixture: apply preserves sibling fields (fonts, theme) and
  rewrites only `enabledCssSnippets`; force-off removes scope-away names; a name
  in both `pins` and `scopedAway` is kept-local (pin > scope, not force-removed);
  masked names don't register as divergence.
- **Live (dev vault, mobile-forced + real phone):** set `mystyle-mobile → mobile`;
  confirm desktop drops it from Appearance and shows no `↑`/`↓`; pin a snippet
  off on desktop and confirm the store's "on" never flips it back; confirm the
  `.css` files still sync to both.

## Non-goals

- **No auto-detection** of scope (no filename suffix, no in-file marker) — manual
  dropdown only, per owner decision. Revisit later if desired.
- **No change to `.css` file sync** (`snippets` dir group) or to the
  `community-plugins` / `core-plugins` lists' behavior.
- **No appearance.json schema change** — `enabledCssSnippets` stays a `string[]`;
  all new metadata lives in config-sync's `data.json`.
- Multi-machine-per-class scope values (e.g. "this specific desktop") remain out
  of scope — the pin covers per-machine deviation.
