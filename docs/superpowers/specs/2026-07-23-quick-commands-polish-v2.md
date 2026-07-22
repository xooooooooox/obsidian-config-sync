# Quick commands — polish v2 (icons + labels + iconize) — Design

**Date:** 2026-07-23
**Status:** approved (design)
**Predecessor:** `2026-07-22-quick-commands-polish-design.md` (per-command icons, icon picker, separators — shipped 1.5.0)

## Goal

Four fixes to the Quick commands feature, dominated by one new capability: render **iconize custom icon packs** in the icon picker and everywhere quick-command icons appear.

1. Settings: give the "Add command" / "Add separator" footer breathing room from the next section.
2. Settings: fix the distorted/faint icon in each quick-command row.
3. Feature: let quick commands use icons from **iconize** custom packs (e.g. a `feishu` pack), not just Obsidian's built-in icon set.
4. Copy: drop the pending-count suffix from the ribbon tooltip; rename the menu's `Sync…` item to `Sync Center`.

## Global Constraints

- **Lint baseline:** 67 problems (0 errors, 67 warnings). Introduce **no new** lint problems.
- **`noUncheckedIndexedAccess: true`** — guard every array/record index access.
- **Core purity:** `src/core/*` imports nothing from `"obsidian"`.
- **Non-public API access** uses the guarded cast pattern:
  `(app as unknown as { commands: { commands: Record<string, Command> } }).commands`.
- **No data migration:** `quickCommands` entries are unchanged in shape (`{commandId, label, icon}` / `{kind:"separator"}`). Existing stored icon ids keep working.
- **Graceful when iconize is absent:** the feature must degrade to current behaviour with iconize not installed. iconize is **not** a declared dependency.

## Background — verified facts

**#2 root cause (measured live, not assumed).** In the flex icon-button the injected `.svg-icon`
computes to **8px × 18px** — the width is crushed by flex-shrink, so the glyph looks squished and
faint. Tested candidate fixes live:

| Attempt | Result |
|---|---|
| explicit `width:18px; height:18px` on svg | **8×18 — still broken** (flex-shrink wins) |
| `--icon-size:18px` on button **+ `flex:none` on svg** | **18×18 — crisp** |
| `--icon-size:18px` + `flex-shrink:0` on svg | 18×18 — crisp |

Fix = size the container **and** stop the svg from shrinking.

**#3 iconize API (probed live against iconize 2.14.7).** Public API at
`app.plugins.plugins["obsidian-icon-folder"].api`:

- `getAllIconPacks()` → `Array<{ name: string; prefix: string; icons: Array<{ name: string; prefix: string; svgContent: string }> }>`.
  Example packs present: `lucide-icons` (prefix `Li`, ~1951 icons) and a custom `feishu` (prefix `Fe`).
- `getIconByName(fullId)` → `{ name, prefix, iconPackName, filename, svgContent, svgViewbox, svgElement } | null`.
- **Icon full id = `prefix + name`** (e.g. `FeSyncFeishu`, `LiRefreshCw`).
- `svgContent` is the raw `<svg>…</svg>` string, ready to inject.

Obsidian's `setIcon()` / `MenuItem.setIcon()` cannot render these ids (not in the core registry), so
rendering must fall back to injecting `svgContent`.

## Decisions (from brainstorming)

- **Picker UX:** one **unified fuzzy list** — Obsidian built-ins + iconize **custom-pack** icons together;
  iconize entries show their pack. (We exclude iconize's `lucide-icons` pack — Obsidian already covers
  Lucide, so re-listing it would double every glyph.)
- **Missing-icon fallback:** when a stored iconize icon can't render on a device (iconize or that pack
  absent), fall back to **the underlying command's own default icon**, else a neutral `command` glyph.
  The stored id is never rewritten, so the real glyph returns once the pack is present.

## Design

### Icon-render helper — `src/ui/iconRender.ts` (new, UI layer)

Not in `core/` — it touches `"obsidian"` (`setIcon`) and `app.plugins`.

```ts
import { App, setIcon } from "obsidian";
import { IconPack } from "../core/icons";

interface IconizeApi {
  getAllIconPacks(): IconPack[];
  setIconForNode(fullId: string, node: HTMLElement): void; // injects the pack's <svg> into node
}

// The iconize public API, or null when the plugin is absent/disabled.
export function iconizeApi(app: App): IconizeApi | null { … guard-cast plugins["obsidian-icon-folder"]?.api … }

// All iconize icon packs, raw (lucide-exclusion happens in the pure iconChoices).
export function iconizePacks(app: App): IconPack[] {
  return iconizeApi(app)?.getAllIconPacks() ?? [];
}

// Render iconId into node. Chain: Obsidian setIcon → iconize setIconForNode → command's default icon → "command".
// The injected iconize <svg> gets class "svg-icon" so existing Obsidian icon CSS sizes/colours it.
export function renderIcon(node: HTMLElement, iconId: string, fallbackIcon: string | undefined, app: App): void {
  node.empty();
  setIcon(node, iconId);
  if (node.childElementCount > 0) return;                 // built-in matched

  const api = iconizeApi(app);
  if (api !== null) {
    api.setIconForNode(iconId, node);                     // vendor path — no innerHTML
    const svg = node.querySelector("svg");
    if (svg !== null) { svg.classList.add("svg-icon"); return; }
  }
  node.empty();                                            // iconize writes the id as stray text on a miss — clear it

  if (fallbackIcon !== undefined && fallbackIcon !== "") {
    setIcon(node, fallbackIcon);
    if (node.childElementCount > 0) return;
  }
  setIcon(node, "command");
}
```

Verified live: `api.setIconForNode("FeSyncFeishu", node)` injects `<svg viewBox="0 0 48 48" …>` (child
count 1). It does **not** throw on an unknown id — instead it writes the id as **text** into the node
(child count 0), hence the `node.empty()` before the fallback so a leftover string can't sit beside the
fallback glyph.

### Pure icon-choice composition — `src/core/icons.ts` (new, obsidian-free, tested)

The picker's item list is a pure function of the built-in ids and the (obsidian-free-shaped) iconize
packs. Keeping it pure gives us the one unit test worth writing and honours core purity.

```ts
export interface IconPack { name: string; prefix: string; icons: { name: string; prefix: string }[]; }

export interface IconChoice {
  id: string;        // what gets stored: built-in id, or iconize prefix+name
  text: string;      // fuzzy-search haystack
  pack: string | null; // null = Obsidian built-in; else iconize pack name (shown as a tag)
}

// Built-ins first, then every custom-pack icon. Excludes the "lucide-icons" pack (Obsidian already
// provides Lucide). iconize id = prefix + name; search text folds in the pack name so "feishu" finds
// the whole pack.
export function iconChoices(builtinIds: string[], packs: IconPack[]): IconChoice[] { … }
```

### IconSelectModal — unified list

`FuzzySuggestModal<IconChoice>` (was `<string>`):

- `getItems()` → `iconChoices(getIconIds(), iconizePacks(this.app))`.
- `getItemText(c)` → `c.text`.
- `renderSuggestion(match, el)` → `renderIcon(glyphSpan, c.id, undefined, app)` for the preview, the
  icon id/name label, and a muted pack tag when `c.pack !== null`.
- `onChooseItem(c)` → `onChoose(c.id)` (unchanged contract: still hands back a stored id string).

### Settings row — `SettingTab.renderQuickCommands`

Replace the local `paint()` (`setIcon` + empty-check) with `renderIcon`:

```ts
const paint = (id: string): void => renderIcon(iconBtn, id, registry[entry.commandId]?.icon, this.host.app);
```

`registry[entry.commandId]?.icon` is the command's default icon (the fallback). `registry` is already in
scope in `renderQuickCommands`.

### Ribbon menu — `main.ts openSyncMenu`

Obsidian `MenuItem.setIcon` can't render iconize ids, so render into the item's icon element directly:

```ts
menu.addItem((i) => {
  i.setTitle(e.label);
  i.setIcon(e.icon);                                     // forces the icon slot to exist
  const el = (i as unknown as { iconEl?: HTMLElement }).iconEl;
  if (el) renderIcon(el, e.icon, (commands.commands[e.commandId] as Command | undefined)?.icon, this.app);
  if (e.disabled) i.setDisabled(true);
  else i.onClick(() => commands.executeCommandById(e.commandId));
});
```

`quickMenuEntries` (pure) is unchanged — it already carries `commandId` + `icon`.

### CSS — `styles.css`

```css
.config-sync-qc-icon { … --icon-size: 18px; }
.config-sync-qc-icon .svg-icon { flex: none; }           /* stop the flex-shrink squish (#2) */
.config-sync-qc-addbar { … margin-bottom: 18px; }        /* separate from next section (#1) */
```

### Copy — `main.ts`

- `updateRibbonDot()` (`main.ts:314-323`): keep the count computation and the capture/apply **dot**
  classes; replace the suffixed aria-label with a constant `el.setAttribute("aria-label", "Config Sync")`.
  Remove the now-dead `parts` construction. (The vault's ribbon-grouping CSS matches
  `[aria-label^="Config Sync"]`, so a bare `Config Sync` still matches — no snippet change needed.)
- `openSyncMenu()` (`main.ts:336`): `Sync…` → `Sync Center`, keeping the live `(↑N ↓M)` count suffix.
  Fallback title `Sync…` → `Sync Center`.

## Data flow & sync

`quickCommands` shape is unchanged, so no migration. An iconize icon stores as its full id
(`FeSyncFeishu`) and syncs verbatim across devices (`quickCommands` is not in `selfPresetRules`'s strip
list). On a device without that pack, `renderIcon` shows the command's own icon; the id is preserved and
the real glyph returns when the pack is present.

## Testing

- **Unit (new):** `iconChoices()` — built-ins passthrough, custom-pack icons appended with correct
  `id`/`pack`, and the `lucide-icons` pack excluded. (`src/core/icons.ts` is obsidian-free.)
- **No unit tests** for `renderIcon` / modal / menu (DOM + non-public API); verified by build + lint +
  the author's live GUI pass.
- Gate: `npm test`, `npm run build`, `npm run lint` (≤ baseline), `npm run smoke:install`.

## Non-goals

- No dependency on iconize; no bundling of icon packs.
- Not re-listing iconize's Lucide pack (Obsidian already provides Lucide).
- No change to separators, reorder, add/remove, or the greyed-out-when-unregistered behaviour.
- No change to `quickCommands` persistence/schema.

## Version

New capability (#3) → **minor** bump: **1.6.0**.
