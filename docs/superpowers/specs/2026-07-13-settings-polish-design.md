# Settings Polish: Global Search, Synced Items, Error Copy, Display Names (iter24)

Approved mockup: `.superpowers/brainstorm/39264-1783912450/content/iter24-settings-polish.html` (4 screens; revisions: display names everywhere, no error prefixes).

## Problems (user-reported)

1. The settings search only covers the three picker tabs — General/Advanced/Remotes settings are unfindable — and there's no way to narrow by area.
2. Advanced's "Managed by pickers" is implementation language, and its flat card list lacks the category grouping every other tab has.
3. Validation errors read like internals: `Not saved: Invalid config-sync data: remote "x": "storePath" must be an absolute path…`.
4. Every user surface shows group IDs (`plugin-obsidian42-brat`) instead of names (`BRAT`) — users neither know nor care about IDs.

## Design

### 1. Display-name resolver (foundation — applied everywhere)

One resolver maps a group/item to its display label:
- Obsidian-tab items → the existing catalog `label` (`Appearance`, `Hotkeys`, `Themes`…).
- Core-plugin items → the core plugin's display name (as the Core tab already shows, e.g. `Daily notes`).
- Community plugins → the installed plugin manifest's `name` (`BRAT`, `Templater`); **not installed** → the id without the `plugin-` prefix (no manifest to consult).
- Custom rules / anything unresolved → the raw group name.

`PluginHost` (core) gains the display-name lookups needed (installed community plugin name; core plugin name), so the resolver is core-testable. Applied to: all settings tabs (incl. Advanced cards and Discovered rows where applicable), search results, Sync Center item rows and switcher/sidebar labels where item names appear, capture/apply/pull/push report rows, and the version-warnings dialog. Display names render in the interface font (monospace retires with the IDs). Row hover (aria-label) keeps the resolved path, so the underlying id/path stays discoverable.

### 2. Global search + scope filter (mockup ①)

- The index covers: every General `Setting` (name + description), all picker-tab items (unchanged behavior — actionable rows with inline toggles), Advanced rule cards + Discovered files, and each remote (desktop; the Remotes scope is absent on mobile like its tab).
- While searching, a scope pill row appears above results: `All {n}`, `General {n}`, `Obsidian {n}`, `Core {n}`, `Community {n}`, `Advanced {n}`, `Remotes {n}` — counts over the current query; clicking filters; zero-count pills render but disabled/dim.
- Non-item results (General settings, Advanced cards, remotes) render as rows with a scope tag and a `›` chevron; clicking navigates: switch to that tab, clear the search, scroll the target `Setting` into view, apply a highlight class for ~1.5s.
- Matching: case-insensitive substring over name + description (+ path where present), unchanged from today's item matching.

### 3. Advanced → "Synced items" (mockup ②)

- Section renamed `Managed by pickers` → `Synced items`; description verbatim: `Everything you turned on in the Obsidian / Core plugins / Community plugins tabs. Expand a row to fine-tune its rule; reset returns it to the default.`
- Cards grouped under the same three category headings the other tabs use (`Obsidian`, `Core plugins`, `Community plugins`), ordered as elsewhere (CATEGORY_ORDER).
- Card titles use display names; the technical detail (relative path, devices, mode) stays as the secondary metadata line.
- `Discovered files` and `Custom rules` sections unchanged (positions, behavior).

### 4. Error copy rules (mockup ③)

All user-visible validation messages (remotes validation, manifest validation surfaced in settings) are rewritten to the rule: **no prefixes** (`Invalid config-sync data`, `Not saved` — the warning styling already conveys "not applied"); state **which item, what's expected, one example**; keep technical tokens only when they're the literal value the user must type (code-styled where the surface supports it). Two anchor rewrites (verbatim):
- storePath: `The store path for “{name}” needs to be a full path starting with / or ~/ — for example ~/Vaults/other-vault/config-sync.`
- legacy sanitize: `“{name}” still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).`
The remaining validation messages follow the same pattern (rewrites enumerated at plan time; tests asserting old texts update accordingly; this supersedes iter20's verbatim-locked sanitize message).

## Testing

- Unit: resolver rules (label sources + fallbacks) with a fake PluginHost; message rewrites (updated manifest tests).
- Live smoke: search finds a General setting (Passphrase) and a remote; scope pills count/filter; jump-navigate highlights; Advanced shows categorized display-named cards with rename; Sync Center rows show `BRAT`-style names with id fallback for a not-installed group; a storePath validation error shows the new copy.

## Non-goals

- Report style changes (chips, pulled pills, warnings layout) — iter25.
- Not-installed apply-flow redesign and inline reports — iter26.
