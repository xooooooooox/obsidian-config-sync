# Settings Picker De-dup, Self-Delta Ghost Fix, Banner Mobile Layout, In-place Where-it-runs — Design

Date: 2026-07-28
Status: approaches approved (picker mockup 方案 A,
https://claude.ai/code/artifact/6142030c-8d96-4b86-b18a-0f7b3d724293; where-it-runs mockup
https://claude.ai/code/artifact/03213f3b-523f-47f3-a756-c26f5913225b, device-language copy +
Lucide icons 定稿); spec under user review.

Three items from the 2026-07-28 phone/desktop field pass (§1 design change, §2/§3 bug fixes)
plus backlog brainstorm #2 (§4, the in-place where-it-runs guidance).

## 1. Settings picker: default state carries no text (mockup 方案 A)

### Problem

Every core-plugin row without a settings file repeats "On/off state — no saved settings on
this device yet."; every community/beta row repeats "Plugin files, settings and on/off
state." (`src/core/registry.ts:132-136`). 100+ identical description lines say nothing and
double the list height.

### Decision

Rule: **the default state writes no text**. The shared sentence moves up to a one-line
section subtitle; a row only shows what deviates from it. Deviations use the existing badge
system (方案 A: single-line rows + badge), not a per-row description line (rejected 方案 B:
Core's state-only rows are the majority, so the repetition would survive).

### Changes

- `src/core/registry.ts`:
  - `corePluginDescription` deleted; core defs get `description: ""`.
  - `COMMUNITY_PLUGIN_DESCRIPTION` becomes `""` (kept as the constant so
    `defsForForeignItems` stays in sync, or both sites inline `""` — implementer's choice,
    but the two sites must stay identical).
  - The three Obsidian cards (App settings / Appearance / Hotkeys) keep their real,
    differentiated descriptions untouched.
- Section subtitle: `renderRegistryCards` (`src/ui/SettingTab.ts:606`), only when
  `withSyncAll` is true, renders one muted line ABOVE the Sync all row:
  - core: `Each plugin syncs its settings and on/off state.`
  - community and beta: `Each plugin syncs its files, settings and on/off state.`
  - obsidian tab: no subtitle (withSyncAll is false there already).
  - CSS class `config-sync-section-sub`, styled like existing muted hint text
    (`--font-ui-small`, `var(--text-muted)`).
- State-only badge: `computeBadges` (`src/ui/itemCard.ts`) gains, FIRST in the list (innate
  property, ahead of desktop-only and config badges):
  - condition: `def.settingsFile !== undefined && def.settingsFile.defaultPath === null`
    (same predicate as `settingsFileZoneKind(def) === "state-only"`).
  - badge: `{ text: "on/off only", cls: "config-sync-card-badge-state" }`.
  - `Badge` gains optional `tooltip?: string`; this badge sets
    `"No settings file on this device yet — only the enable state syncs."` and `renderBadge`
    applies it via Obsidian's `setTooltip` (works on desktop hover and mobile long-press).
  - CSS: `.config-sync-card-badge-state { color: var(--text-faint); background: transparent;
    border: 1px dashed var(--background-modifier-border-hover); }`.
- Empty description rendering: `renderItemCard`'s `setDesc("")` leaves no visible line; if
  the empty `setting-item-description` element still reserves height, add a CSS rule to
  collapse it rather than special-casing the TS.
- Search (`SettingTab.ts:1849-1856`): item hit `desc` becomes
  `[def.description, stateOnly ? "on/off only" : "", path].filter(non-empty).join(" ")` — the
  boilerplate leaves the corpus, the deviation stays findable, paths keep working.

## 2. Self pane delta ghost: local side must compile foreign items too

### Problem (confirmed on the phone, 2026-07-28)

The adopt card listed `+obsidian-git +simpread` while the data.json diff showed only the real
change (pdf-plus gaining `enabledOn: "desktop"`). Both items have been in the store list
since before 07-24 and are byte-identical in the phone's local data.json (they sit inside the
diff's unchanged region) — the "+" list is a ghost.

Root cause — `selfStatus` (`src/main.ts:469-504`) feeds `syncListDelta` two different bases:

- store side: `storeSelfCopyGroups` compiles the store's items with
  `defsForForeignItems` — items whose plugin isn't installed on this device get a
  synthesized def and survive;
- local side: `this.compiledGroups`, compiled from installed-only defs
  (`buildItemDefs`/`pluginRuntime`) — the same items are silently dropped even though the
  local data.json carries them.

Any item in `settings.items` whose plugin isn't installed on this device therefore shows as
"Updates from the store" forever, and whenever a real self change appears (the pdf-plus
rule), the card's member list and the diff tell different stories.

### Fix

Make the local side symmetric with the store side.

- `src/core/leftover.ts`: extract the shared core
  `selfListGroups(defs: ItemDef[], items: Record<string, ItemConfig>, customGroups:
  CustomGroupConfig[]): SyncGroup[]` =
  `compileItems(defsForForeignItems(defs, Object.keys(items)), { items, customGroups })`.
  `storeSelfCopyGroups` calls it after parsing its JSON (behavior unchanged).
- `src/main.ts` `selfStatus`:
  - `localList` = `selfListGroups(this.registryDefs, this.settings.items,
    this.settings.customGroups)`, wrapped in try/catch — on a `CompileError` (path
    collision) fall back to `this.compiledGroups` (today's behavior, and recompile() has
    already surfaced the Notice).
  - `delta = syncListDelta(localList, storeGroups)`; the coldstart check
    (`local.length === 0`) and `itemCount` also switch to `localList` — membership truth
    includes items whose plugin isn't installed here.
  - `selfGroup` lookup (`local.find(g => g.name === SELF_GROUP_NAME)`) stays on
    `this.compiledGroups` — that is the engine's list; both compiles emit the identical self
    group, but the engine list is the one the rest of the plugin runs on.

After the fix, the user's scenario shows delta empty → the adopt card falls through to
`renderSelfContentDetail` ("Config Sync's own settings changed:" + inline diff) — summary
and diff agree. The "N to adopt" chip stops counting ghosts for the same reason.

Consequence noted, not in scope: items for not-installed plugins remain absent from the
device item LIST (compiledGroups is unchanged), so there is still no "Not installed" row to
install them from on this device. That is today's behavior; if we want store-driven installs
for never-installed plugins, that is its own feature.

## 3. Cold-start banner squeezed on mobile

`body.is-mobile .config-sync-coldstart-banner { flex-wrap: wrap; }` (`styles.css:865`) lets
the row wrap, but the text div is `flex: 1` so it shrinks beside the button instead of
wrapping — on the phone the sentence renders as a narrow column (field screenshot
2026-07-28).

Fix, CSS only:

```css
body.is-mobile .config-sync-coldstart-text { flex-basis: 100%; }
body.is-mobile .config-sync-coldstart-actions { margin-left: auto; }
```

Text takes the full first row; "Review settings →" and ✕ drop to a second row, right-aligned.

## 4. In-place "where it runs" guidance (brainstorm #2)

### Problem

When a switch list (community-plugins / core-plugins) differs one-sidedly, the expanded row
shows only the raw diff — `+ "obsidian-git"` — with no explanation of what applying does and
no way to act on the real cause (a plugin that in fact belongs to one device class). The fix
lives four steps away in the settings card's "Enabled on". Field origin: 2026-07-26 phone
test, where Apply would have silently enabled obsidian-git / vimrc-support / simpread /
vim-toggle on the phone.

### Design (mockup-final)

A per-member interpretation block in the expanded detail of the two plugin carrier rows,
between the decision-note rows and the raw diff. `enabled-css-snippets` is excluded (it has
its own per-snippet scope + pin mechanism).

**Data**: `switchDivergenceFor` already returns the two sets —
`captureRemoves` = elements only in the store list, `applyDisables` = elements only in the
local list. Today's block renders only when BOTH are non-empty; the member block renders
when EITHER is.

**Pure row model** (`src/ui/panelModel.ts`):
`memberChangeRows(d: { captureRemoves: string[]; applyDisables: string[] },
device: "desktop" | "mobile")` → `{ id, action: "apply" | "capture", why: string,
recommended: "desktop" | "mobile" | null }[]`, sorted store-only first, each set
alphabetical. Copy (exact; `<here>` = "this phone" on mobile, "this computer" on desktop):

- store-only: why `on for your other devices, off on <here> — Apply would turn it on here
  too`; recommended = the OTHER device class ("desktop" when viewing on mobile, "mobile" on
  desktop).
- local-only: why `on only on <here> — Capture would turn it on for your other devices`;
  recommended = null (intent is ambiguous).

Block title: `These plugins are switched on differently — decide where each belongs:`.
Row rendering: the action's own Lucide icon (`arrow-down-to-line` accent for apply-side,
`arrow-up-from-line` orange for capture-side, from `actionIcons.ts`), plugin id, why line,
and a `where it runs ▾` button on the right.

**Menu** (Obsidian `Menu`, DOM mode): recommended item first; titles are single lines:

- `Desktop only — stays off on phones` (icon `monitor`); when recommended, suffix
  ` · matches where it's used today`.
- `Mobile only — stays off on desktops` (icon `smartphone`).
- `⌂ This device decides for itself` (no setIcon; leading ⌂ glyph per DESIGN §2.4).
- `Everywhere — <consequence>` (icon `globe`), where `<consequence>` follows the row's
  direction: apply-side rows `no rule, Apply turns it on here`; capture-side rows
  `no rule, Capture turns it on for your other devices`.

**Actions**:

- Desktop/Mobile only → new host method
  `setMemberEnabledOn(carrier: string, elementId: string, scope: "desktop" | "mobile")`:
  item id = `community:<el>` for community-plugins, `core:<el>` for core-plugins; writes
  `settings.items[itemId] = { ...(existing ?? emptyItemConfig()), enabled: true,
  enabledOn: scope }` then `saveSettings()` (recompiles; the enablement mask covers items
  without a local def since the #6 fix). Panel reloads; the member exits comparison and its
  diff line disappears.
- ⌂ → existing `addSwitchExceptions(name, [id])`.
- Everywhere → close the menu, write nothing.

**Decision-note rows**: `switchLocalDecisions` (main.ts:557, memberLocalFor) is extended to
`switchMemberDecisions(name): { id: string; scope: "local" | "desktop" | "mobile" }[]` —
`enablementScopesFor` entries with scope ≠ "all". Rendering (same `config-sync-lddetail`
family): `local` keeps today's `⌂ <id> — this device keeps its own on/off state`; device
classes render setIcon `monitor`/`smartphone` + `<id> — runs on desktop only` /
`— runs on mobile only`. The count badge at SyncCenterView.ts:1491 counts the same extended
list.

**Publish reminder**: when the member block or note rows exist AND the ⚙ Settings row is
pending capture (self state `capture` or `both`), one muted line closes the detail:
`Your choices are saved on this device — capture Settings so your other devices pick them
up.` — this also closes the loop on the #4 ordering guidance for scope rules.

**Ride-along copy alignment** (the last "shared list" occurrences; device-language instead
of the carrier-file view):

- divergence line (renderSwitchDivergence): `Capture removes N from the shared list — other
  devices will turn them off: …` → `Capture would turn N off on your other devices: …`.
  The both-ways warning block itself, its Apply line, and the Keep-on-device button/modal
  stay unchanged.
- excluded note (SyncCenterView.ts:2236): `…the shared list neither includes nor changes
  them.` → `…they don't follow your other devices, and aren't pushed to them.`

## 5. Testing

Pure logic → vitest (repo split: main.ts/SettingTab wiring via dev-vault smoke):

- `selfListGroups`: items containing a `community:<id>` whose def is absent still yield the
  `plugin-<id>` group; with those inputs on both sides, `syncListDelta` returns empty
  added/removed (the ghost regression test). Store-only item still reports `added`.
- `computeBadges`: state-only def → `on/off only` badge first; def with a settings file →
  no such badge; badge tooltip text asserted.
- Search-hit builder if extracted as a pure helper; otherwise covered by smoke.
- `memberChangeRows`: both sets, both device classes — exact why-copy, ordering,
  recommendation only on store-only rows and pointing at the other device class.
- `switchMemberDecisions` mapping: scopes ≠ "all" surface with their scope; "all" entries
  absent.
- `setMemberEnabledOn` item-write shape (id prefixing per carrier, `enabled: true`,
  preservation of an existing ItemConfig's other fields) — pure part extracted or asserted
  through settings state in a host-level test if trivial; wiring via smoke.

Dev-vault smoke: picker tabs show the subtitle once and single-line rows; a state-only core
row shows the dashed badge with tooltip; banner layout checked in the mobile emulation;
switch-list row with a one-sided divergence shows the member block, choosing "Desktop only"
removes the row and adds the `runs on desktop only` note (final verification on the phone,
where the field bugs were found).

## 6. Compatibility & release

- No store schema or settings shape change; no behavior change to capture/apply engines —
  §4 writes the same `enabledOn` field the settings card writes.
- `ItemDef.description` stays `string`; only its content changes for core/community defs.
- Release: minor bump (2.5.0) — §4 is a new feature; the rest is polish + bug fixes.
