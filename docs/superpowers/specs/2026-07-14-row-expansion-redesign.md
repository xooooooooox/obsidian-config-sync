# Row Expansion Redesign — segment alignment, Custom location, badge semantics (0.21.x)

Refines the expanded-item drawer that shipped in 0.21.0's fidelity pass. Three changes,
approved from mockups (`expansion-redesign.html`, screens A/B/C):

1. **Segment-title alignment** — the three segment headers (`Fields to protect`, `Data file`,
   the former `Advanced`) must share the same left edge. Today `Advanced` is prefixed with a
   chevron icon that pushes its label ~18px right of the other two.
2. **"Advanced" → "Custom location"** — rename and restructure the store-override segment. Its
   real purpose is overriding the item's default storage definition (Location/Type/Path). Lay
   Location, Type, and Path out on one row with Path taking the remaining width; keep it
   default-collapsed; add a reset link.
3. **Badge semantics narrowed** — `⚙ customized` (renamed `⚙ custom location`) appears ONLY
   when the item's Location/Type/Path differs from its default. Mode (plain/fields/encrypt),
   devices (all/desktop/mobile), and field rules are everyday configuration and must NOT
   trigger the badge.

Governed by the design-system spec (2026-07-14-settings-panel-design-system.md): theme-native,
zero hardcoded color, semantic colors on `--color-*` variables.

## Motivation

Without a store override, the plugin uses each item's default location to do what the user
wants; only when the user overrides it does the plugin write to their specified location. The
badge should mark exactly that state — "this item uses a non-default location" — not the
routine act of choosing an encryption mode or device scope.

## Part 1 — Segment-title alignment

All three segment headers render as a flush-left `.config-sync-explabel` with the
collapse/expand affordance (▸/▾) as trailing text INSIDE the label, matching the existing
`Data file … View data.json ▸` idiom. No header has a prefixed icon.

- `Fields to protect` — plain label (no toggle; visible only when `group.mode === "fields"`).
- `Data file` — label + trailing `View data.json ▸/▾` link (unchanged).
- `Custom location` — label + trailing `▸/▾` toggle (Part 2).

Remove `.config-sync-adv-header` and `.config-sync-adv-chev` (the prefixed-chevron structure)
from both `SettingTab.ts` and `styles.css`. The `Custom location` header becomes a single
clickable `.config-sync-explabel` with text `Custom location ▸` / `Custom location ▾`.

## Part 2 — Custom location segment

Rename `renderAdvancedSegment` → `renderCustomLocationSegment`; rename the `advOpen` set →
`customLocOpen` (UI-transient, keyed by group name). Default-collapsed.

Collapsed: the flush-left `Custom location ▸` label only.

Expanded (`Custom location ▾`): a single row (`.config-sync-cl-row`) of three fields, each a
small uppercase label above its control:

- **Location** — `DropdownComponent`, options `config` → "Config folder", `vault` → "Vault
  root", value = `splitLocation(group.path).location`. On change, commit via `commitGroups`
  draft-find: `g.path = joinLocation(v, splitLocation(g.path).rel)`.
- **Type** — `DropdownComponent`, options `file` → "File", `dir` → "Folder", value =
  `group.type`. On change, commit via `commitGroups` draft-find: `g.type = v`. When switching
  to a non-file type, clear field-mode data the same way the Advanced custom-rule form does
  today (`if (g.type !== "file") { delete g.mode; delete g.fields; }`), so an item can't be a
  `dir` with a `fields` rule. Re-render the row after (a Type change alters which segments show).
- **Path** — `TextComponent`, value = `splitLocation(group.path).rel`, flexes to fill the
  remaining row width. On change (trimmed), commit via `commitGroups` draft-find:
  `g.path = joinLocation(splitLocation(g.path).location, v.trim())`.

Below the row, for managed items (`reservedNames(installedPluginIds()).has(group.name)`), a
reset link `↺ Reset to default` (text shortened from "Reset this item to its default rule").
On click, replace the group with `defaultGroupForName(group.name)` via `commitGroups`, then
re-render the row. (This resets everything to default, including mode/devices/fields — it is
the item-level "undo all customization".)

Layout: `.config-sync-cl-row` is `display: flex; gap; align-items: flex-end`; each
`.config-sync-cl-field` is a column (label + control); the Path field is `flex: 1; min-width:
0` and its input is `width: 100%`. All colors/borders from theme variables (design-system
compliant — no hardcoded color).

Row-level commit and rollback semantics are unchanged (every mutation goes through
`commitGroups` draft-find; a failed write rolls back and shows the inline error).

## Part 3 — Badge semantics

Narrow `isCustomized(group)` to test ONLY the storage definition:

```ts
private isCustomized(group: SyncGroup): boolean {
  const expected = expectedPathForName(group.name);
  const pathCustom = expected !== null && group.path !== expected;
  const def = defaultGroupForName(group.name);
  const typeCustom = def !== null && group.type !== def.type;
  return pathCustom || typeCustom;
}
```

Drop the mode/devices/fields comparisons. (Location is encoded in `path`, so the path check
covers a Location change too.) The badge text becomes `⚙ custom location` (was `⚙ customized`);
its CSS class `.config-sync-cust` and `--text-accent` color are unchanged. Badge order after
the name is unchanged: `⚠ N keys` → `⚙ custom location` → `device-specific`.

The Advanced-tab "customized-rules" banner (`renderAdvanced`) already keys off
`isCustomized`, so it automatically narrows to storage-overridden items — its copy still reads
"{n} items use a customized rule", which remains accurate (a custom location IS a customized
rule). No banner change needed.

## Edge cases

- An item whose default has no `expectedPathForName` (custom rules, discovered) — `pathCustom`
  is false; `typeCustom` needs a `defaultGroupForName`, also null for those, so the badge never
  shows on non-managed items. Correct: the badge is a managed-item concept.
- Type change to `dir` while a `fields` rule exists — cleared on the Type change (above), so no
  invalid `dir`+`fields` state, and the badge reflects the type override.
- Reset to default clears a custom location AND any mode/devices/fields the user set — this is
  the item-level reset, matching today's Advanced reset behavior.
- Fields-mode item with a custom location — both the Fields segment and the Custom location
  segment show; `⚙ custom location` shows (path/type override), `⚠ N keys` also shows. Three
  segments, all left-aligned.

## Testing

`isCustomized` narrowing is testable if extracted, but it is a private UI method; keep it
in-place and cover it via the existing `defaultGroupForName`/`expectedPathForName` catalog
tests plus the controller smoke (badge appears only after a Location/Type/Path change, not
after a mode/devices/fields change). No new unit test file. The node suite stays at 202. The
color scan (`./scripts/check-no-hardcoded-color.sh`) must still pass. Two-theme screenshot gate
(default + AnuPpuccin) per the design-system spec.

## Scope

`src/ui/SettingTab.ts` (renderItemExpansion / renderDataFileSegment header idiom /
renderAdvancedSegment→renderCustomLocationSegment / isCustomized) and `styles.css` (remove
adv-header/adv-chev, add cl-row/cl-field). No behavior change beyond the badge narrowing and
the added Type control; no copy change beyond the rename and reset-link shortening.
