# Settings Reliability, Sensitive Workflow & Advanced Redesign (0.21.0)

Config-panel iteration. Nine changes, grouped:

- **Save reliability**: relax the group-name validator to allow uppercase; make every
  settings mutation roll back in memory when the disk write fails, with the error shown on
  the culprit card.
- **Sensitive workflow**: run detection on every installed plugin (not only synced ones);
  sort each section so detected-sensitive items float to the top; drop the redundant
  "Detected: …" description text.
- **Item classification**: `workspaces.json` becomes the Workspaces core plugin;
  `workspace.json`/`workspace-mobile.json` leave the Obsidian tab; the "Not recommended"
  section dissolves into inline `device-specific` badges.
- **Row expansion + Advanced redesign**: every synced row gains a chevron opening a unified
  expansion holding Fields / View data.json / Advanced (store-path + reset); the Advanced
  tab's "Synced items" mirror is removed, replaced by a customized-rules summary banner.
- **Display names on disk**: `config-sync.json` groups gain an optional `label`.
- **Sync Center**: align the select-all checkbox with the row checkbox column.

Approved via `iter27-master-gallery.html` (9 screens, dark-card styling confirmed).

## Global rules

- All card/panel colors are the existing CSS — this iteration does not restyle cards.
- Error copy carries no prefixes: what failed + why + one example. No "Not saved".
- User-facing item names always go through the display-name chain; raw names stay in code
  and store files.
- `name` stays the stable key everywhere (map key, store addressing). New display data is a
  separate optional `label`.
- No back-compat migrations; the widened validator and optional `label` are read leniently.

---

## Part 1 — Save reliability

### 1.1 Relax the name validator (`src/core/manifest.ts:74`)

Real plugin ids may contain uppercase (`DEVONlink-obsidian`). The current
`/^[a-z0-9][a-z0-9_-]*$/` rejects `plugin-DEVONlink-obsidian`, and because `writeGroups`
validates the **whole** array, that one item poisons every later save. Widen to
`/^[A-Za-z0-9][A-Za-z0-9_-]*$/` and update the message verbatim:

`rule "{name}" has an invalid name — use only letters, digits, "-" or "_", starting with a letter or digit, e.g. "my-plugin"`

`name` is a logical key and JSON map key, not a filesystem path (the store location comes
from `path`), so mixed case is safe. No case-folding or collision handling is added.

### 1.2 Roll back in-memory state on a failed write (`src/ui/SettingTab.ts`)

Today each handler mutates `this.groups` then calls `saveGroups()`, which on failure sets
`groupsErrorMsg` (shown in a panel-bottom `<p>`) but leaves the mutation in memory — the UI
diverges from disk. Introduce a single mutate-write-rollback helper and route every groups
mutation through it:

```ts
// Applies mutator to a working copy, persists, and commits only on success.
// On failure, this.groups is untouched and the error is surfaced (inline where possible).
private async commitGroups(mutator: (draft: SyncGroup[]) => void): Promise<boolean> {
  const draft = structuredClone(this.groups) as SyncGroup[];
  mutator(draft);
  try {
    await this.host.writeGroupsFile(draft);
  } catch (e) {
    this.groupsErrorMsg = (e as Error).message;
    this.groupsErrorEl?.setText(this.groupsErrorMsg);
    return false; // this.groups unchanged — caller re-renders from truth
  }
  this.groups = draft;
  this.groupsErrorMsg = "";
  this.groupsErrorEl?.setText("");
  return true;
}
```

Call sites that currently do `mutate(this.groups); await this.saveGroups(); this.refresh()`
become `if (await this.commitGroups(mutate)) this.refresh(); else this.refresh()` — either
way `refresh()` re-renders from `this.groups`, which after a failure is the unchanged
(disk-truthful) state, so the toggle/segment visually reverts. The pre-existing
`saveGroups()` helper and its callers are replaced; the discovered-row handler
(`renderDiscoveredRow`) that already does manual rollback adopts `commitGroups` too.

### 1.3 Error shown on the culprit card, not only the page bottom

When a mutation targets a specific item row, render the failure inside that row. Add an
optional culprit-name parameter:

```ts
private async commitGroups(mutator: (draft: SyncGroup[]) => void, culprit?: string): Promise<boolean>
```

On failure, if `culprit` is set, stash it in `this.saveErrorFor = culprit` (a field) and
`renderItemInto`/`renderRuleCard` render an inline `.config-sync-save-error` line
(verbatim): `couldn't save this change — {message}. The change was reverted.` The
panel-bottom `groupsErrorEl` still shows for whole-panel operations (e.g. Reset all) with no
single culprit. `this.saveErrorFor` clears on the next successful commit or tab switch.

---

## Part 2 — Sensitive workflow

### 2.1 Detect on every installed plugin, not only synced ones (`src/ui/SettingTab.ts`)

`renderDetection` currently runs only when `group !== undefined` (item already synced). Move
detection to run for every catalog item that has a local file, keyed by `item.name`, so the
`⚠ N keys` badge appears on unsynced rows too. Detection needs a group-shaped input;
`detectSensitive` takes a `SyncGroup`, so build a probe group from the catalog item
(`groupForItem(item.name, item.path, item.type, null)`) when no real group exists. Results
cache in `this.detections` by name (unchanged map). Disabled/not-present rows
(`item.disabledReason !== null` or `!item.exists`) are not scanned (no file to read).

The badge text shrinks (see 2.3). Unsynced rows show only the badge — no mode segment (that
appears after enabling), consistent with today.

### 2.2 Sort detected-sensitive items to the top of each section (`src/core/catalog.ts` +
host)

Within each catalog section's `items`, order = sensitive-first, then alphabetical. Detection
is async and lives in the UI layer, so sorting happens in the render path, not in
`catalog.ts`. Add to the setting tab:

```ts
// Stable: sensitive items first (among themselves alphabetical by label), then the rest
// alphabetical. Never orders by hit count — detection numbers fluctuate and would cause
// cards to jump between renders.
private sortSectionItems(items: CatalogItem[]): CatalogItem[] {
  const isSensitive = (i: CatalogItem): boolean => (this.detections.get(i.name)?.keys.length ?? 0) > 0 || (this.detections.get(i.name)?.blob ?? false);
  return [...items].sort((a, b) => {
    const sa = isSensitive(a) ? 0 : 1;
    const sb = isSensitive(b) ? 0 : 1;
    return sa !== sb ? sa - sb : a.label.localeCompare(b.label);
  });
}
```

`renderSections` sorts each `sec.items` through this before rendering. Because detection is
async (badges arrive after first paint), a section re-sorts when its last pending detection
resolves: `renderDetection`, on first resolving a previously-unknown sensitive hit within a
section, triggers a one-time re-render of that section (guard with a `sortedSections` set so
it settles). Catalog section builders (`listPluginSections` etc.) keep their current
alphabetical `sort` as the tiebreaker baseline.

### 2.3 Drop the "Detected: …" description text (`src/ui/SettingTab.ts:404-412`)

`applyDetection` appends `Detected: {keys}` to the row description — redundant with the
per-key `detected` tags in the fields editor (Part 4). Remove that append. The badge text
changes from `⚠ {n} sensitive-looking keys` / `⚠ opaque encrypted blob` to `⚠ {n} keys` /
`⚠ opaque blob`, with the full phrase kept as the badge's `aria-label`.

---

## Part 3 — Item classification

### 3.1 `workspaces.json` → Workspaces core plugin (`src/core/catalog.ts`)

`workspaces.json` is the data file of Obsidian's **Workspaces** core plugin (deliberately
saved layouts — worth syncing), distinct from the volatile `workspace.json`. Add to
`CORE_PLUGIN_FILES`: `workspaces: "workspaces.json"`. It then appears in the Core tab under
Enabled/Disabled by the plugin's on/off state, labeled by Obsidian's own core-plugin name
("Workspaces"). Confirm `CORE_SETTINGS_IDS` (derived from the map) picks it up so
availability/display in the hub work.

### 3.2 `workspace.json` / `workspace-mobile.json` leave the Obsidian tab

`WORKSPACE_RE = /^workspace.*\.json$/` currently buckets these into the Obsidian tab's "Not
recommended". Narrow the regex to exclude the now-core `workspaces.json` and stop
first-classing the volatile files: change the Obsidian-tab builder (`listOptionSections`) so
`workspace.json` / `workspace-mobile.json` are **not** promoted to a section — they fall
through to the Advanced → Discovered files list (unclassified `.json` at config root) like
any other unrecognized file. Update `WORKSPACE_RE` usage: keep skipping `workspaces.json`
(now covered by `CORE_FILE_SET`) and let `workspace.json`/`workspace-mobile.json` reach the
discovered path. `WORKSPACE_CAUTION` is retained only if still referenced; if nothing uses
it after this change, delete the constant.

### 3.3 Dissolve the "Not recommended" section (Obsidian + Core tabs)

Remove the `notRecommended` section from both `listOptionSections` and `listCoreSections`.
The items it held:
- Obsidian: `workspace.json`/`workspace-mobile.json` — now discovered (3.2), so the section
  is empty there regardless.
- Core: `sync`, `publish` (`CORE_NOT_RECOMMENDED`) — return to the normal Enabled/Disabled
  sections by their on/off state, but each carries `cautionReason = CORE_CAUTION` so the row
  renders an inline `device-specific` amber badge and the enable-toggle still shows the
  caution confirm dialog (unchanged `confirmWarnings` flow at the toggle).

Add a `device-specific` badge render in `renderItemInto`: when `item.cautionReason !== null`,
draw `<span class="config-sync-devbadge">device-specific</span>` after the name and keep the
caution text available (as the badge `aria-label`); the caution string no longer prepends the
description. `CORE_NOT_RECOMMENDED` and `CORE_CAUTION` stay; only the section grouping goes.

---

## Part 4 — Row expansion + Advanced redesign

### 4.1 Unified row expansion for every synced item

Today `renderItemInto` renders a flat Setting; the fields editor (when `mode==="fields"`)
renders directly below the card, and only the Advanced tab's cards have a chevron/expand.
Give every **synced** item row (all three picker tabs + Custom rules) a chevron that opens
one expansion region. Add a chevron span at the row's left (before the name) rendered only
when `group !== undefined` (synced; unsynced rows have nothing to tune). Track open state in
the existing `this.expanded` set (keyed by group name).

The expansion region stacks, each behind a `.config-sync-explabel`, rendering a segment only
when relevant:

1. **Fields to protect** — only when `group.mode === "fields"`. Moves `renderFieldsEditor`
   from below-the-card into here. When a user switches the mode segment to Fields, auto-open
   the row and it lands on this segment (add the name to `this.expanded` in the mode-segment
   `fields` branch before `afterChange()`).
2. **Data file → View data.json** (4.2).
3. **Advanced** — store-path override input + `↺ Reset this item to its default rule` (4.3).

### 4.2 View data.json (read-only, click-to-add-rule)

Inside the expansion's Data-file segment, a `View data.json ▾` toggle reveals a read-only,
pretty-printed render of the item's live file(s). For a `file` group, the single file; for a
`dir` group, list files with a small per-file heading (cap at a sane size; a huge file
scrolls inside its box). Rendering is local (no network, values shown as-is — local file,
local render).

Keys are colored by rule state:
- **teal** (`.config-sync-json-encrypt`) — a `fields` rule with `action: "encrypt"` matches
  this key (via `keyMatchesAny`).
- **red** (`.config-sync-json-strip`) — a `fields` rule with `action: "strip"` matches.
- **amber, dotted-underline** (`.config-sync-json-detected`) — detected sensitive but no
  rule yet.
- default — no rule, not detected.

Clicking a key adds it as a rule: pattern = the exact key name, action = `encrypt` if
`SENSITIVE_ENCRYPT_RE.test(key)` else `strip` (reuse `defaultFieldsFromDetection`'s logic);
if the group isn't already `mode: "fields"`, switching it (set `group.mode = "fields"`)
first. Route the mutation through `commitGroups`; on success re-render the row so the new
rule appears in the Fields segment and the key recolors. Only top-level object keys are
clickable-to-add-a-rule; a top-level rule's glob still matches a nested key of the same name,
and a deeper key can always be ruled by typing a glob in the "Add key pattern" field.

This is the escape hatch for detection gaps: the built-in `SENSITIVE_KEY_PATTERNS` can miss
a key (e.g. `customEndpoint`), and the JSON view lets the user see and rule it without typing
a pattern.

### 4.3 Advanced segment: store-path override + reset item

In the expansion's Advanced segment:
- **Store path**: a text input bound to `group.path` (the current per-item override, e.g. a
  customized store location). Editing it routes through `commitGroups`. This replaces the
  Advanced tab's separate `renderRuleForm` path editor for managed items.
- **↺ Reset this item to its default rule**: for managed items only (name in
  `reservedNames`), calls `defaultGroupForName(group.name)` and replaces the group — the
  existing per-item reset, moved inline.

### 4.4 "⚙ customized" badge (`renderItemInto`)

A synced item is *customized* when its `path` differs from `expectedPathForName(name)`, or
its `fields` rules differ from the detection default (`defaultFieldsFromDetection(detected
keys)`), or its `mode`/`devices` differ from defaults. Render a
`<span class="config-sync-cust">⚙ customized</span>` after the name (and any sensitive
badge). Reuse the existing `⚙ customized` detection already partially present for path
(`SettingTab.ts:337-338`), broadened to the fields/mode comparison. Customized items feed the
Advanced summary banner (4.6).

### 4.5 Remove the Advanced "Synced items" mirror (`renderAdvanced`)

Delete the `Synced items` heading and its per-category mirror of managed groups
(`SettingTab.ts:817-839`) — that content now lives on each item's own tab with the same
Setting-card visual and the inline expansion (4.1-4.3). The Advanced tab keeps only **Custom
rules** (custom groups, unchanged, now using the shared expansion) and **Discovered files**
(unchanged). The bespoke `renderRuleCard`/`renderRuleForm` for managed items is removed;
custom-rule and discovered-on rows keep their own card renderer (they have no catalog
`CatalogItem`, so they render from the `SyncGroup` directly) but share the expansion body.

### 4.6 Customized-rules summary banner (Advanced tab)

At the top of the Advanced tab, when ≥1 managed item is customized, render a banner:

- Line 1: `{n} items use a customized rule`
- Line 2 (desc): the customized items' display names joined by `, ` + ` — edit each on its
  own tab.`
- Trailing button: `↺ Reset all to defaults` — the existing bulk reset (managed items only),
  moved here from the old `Synced items` heading action.

When `n === 0` the banner does not render. This preserves the bulk-reset capability and gives
the "what did I change" visibility the removed mirror used to imply.

### 4.7 Search anchors

`data-search-anchor` for managed items moves from the Advanced `advanced-rule-{name}` to each
item's tab row (`{tab}-item-{name}` or reuse the existing item anchor). `jumpTo` scrolls to
the item on its own tab and opens its expansion when the hit targets a store-path/fields
detail. The search index (`buildSearchIndex`) drops the Advanced managed-item entries (they
were the mirror) and relies on the picker-tab item entries it already produces; discovered
and custom entries stay.

---

## Part 5 — Display names on disk

### 5.1 Optional `label` field (`src/core/types.ts`, `manifest.ts`)

Add `label?: string` to `SyncGroup`. `parseSyncGroup` accepts a string `label` (trimmed,
ignored if empty); `writeGroups` round-trips it. No validation beyond string type.

### 5.2 Write the label

- **On enable**: when the settings panel creates a group (`groupForItem` in the toggle
  handler), set `label` to the catalog item's `label` (the manifest/core name at that
  moment). `groupForItem` gains a `label` parameter.
- **On capture backfill**: in `capture()`, for any processed group lacking a `label` whose
  display name resolves to something other than the raw name, write the resolved label into
  the group and persist it back to `config-sync.json`. Capture already rewrites the lock; add
  a manifest write only when at least one label was backfilled (avoid needless churn). The
  resolver needs plugin/core name access — pass a `labelFor(name): string | null` into the
  capture context, or resolve in the host wrapper after capture returns the processed names.
  (Design note for the plan: prefer resolving in the `main.ts` capture host — it has
  `displayName` — reading groups, filling missing labels, and calling `writeGroups`, to keep
  `core` free of UI label logic.)

### 5.3 Read the label (`displayLabelForGroup`, `src/core/catalog.ts:354`)

Extend the resolver to consult the store label. New priority:

1. `OPTION_LABELS` built-in map (Obsidian settings)
2. core-plugin runtime name (`getCorePluginName`) — freshest local truth
3. installed-plugin runtime name (`getInstalledPluginName`) — freshest local truth
4. **the group's `label` from `config-sync.json`** — covers not-installed/other-device cases
5. raw id fallback

`displayLabelForGroup` currently takes `(name, plugins)`; add the group's stored label as a
third argument (or pass the `SyncGroup`). Update `PluginHost`-based callers
(`main.ts displayName`, Sync Center rows, ReportModal) to supply the label from the loaded
manifest. The Sync Center's Not-installed section then shows `Dataview` instead of the raw
id, and directly-read `config-sync.json` is self-describing.

---

## Part 6 — Sync Center select-all alignment (`src/ui/SyncCenterView.ts`, `styles.css`)

Since 0.20.0 moved search to the sidebar, the main-bar select-all checkbox sits flush after
the filter pills, misaligned with the per-row checkboxes at the card's right edge (the card
has horizontal padding). Right-align the select-all and add right padding equal to the card's
inner padding so it shares the row-checkbox column. CSS-only fix on the main-bar select-all
wrapper; no behavior change.

## Edge cases

- Unsynced sensitive rows: badge only, no expansion (no group to tune) — they still sort to
  the top of their section.
- A `dir` group's View data.json lists multiple files; an item with no local file shows
  "no local file to preview".
- Custom rules with an empty/invalid name still surface the inline save error (Part 1.3) on
  their own card.
- Reset-all with a customized item that has a save-blocking issue: the bulk write either
  fully succeeds or fully fails (whole-array write) — on failure the banner-level error shows
  and nothing changes.
- `workspaces.json` absent in a vault: the Workspaces core item shows "(not present in this
  vault yet)" like any core plugin without its file.
- label backfill must never fail capture: wrap the manifest rewrite so a write error is
  logged, not thrown into the capture result.

## Testing

Node suite (currently 184): name-validator accepts uppercase + rejects leading punctuation;
`commitGroups` rolls back on write failure (inject a throwing `writeGroupsFile`); catalog —
`workspaces` in `CORE_PLUGIN_FILES`, `workspace.json` no longer in Obsidian sections,
`notRecommended` gone, `CORE_CAUTION` items in Enabled/Disabled with cautionReason set;
`displayLabelForGroup` label priority (store label used when no runtime name); sensitive-sort
comparator (sensitive-first, alphabetical, count-independent); `label` round-trips through
parse/write; capture backfills a missing label. UI behaviors (expansion, View-json
click-to-rule, badges, banner, alignment) are covered by the controller obsidian-cli smoke.
