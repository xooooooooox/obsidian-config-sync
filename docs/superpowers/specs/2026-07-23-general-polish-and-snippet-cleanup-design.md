# General-tab polish + dead-snippet cleanup + plugin icon — Design

## Goal

Three fixes on the settings panel plus brand assets (mockup approved 2026-07-23, `mockup-batch3.html` §2–§4):

1. **Passphrase escapes "Ribbon buttons"**: it currently renders right after the ribbon toggles with no heading of its own, so it reads as a ribbon setting.
2. **Ribbon toggle label** "Sync" → **"Sync Center"** (the ribbon icon it controls is already titled "Sync Center").
3. **Dead enabled-snippets are stuck**: names whose `.css` file no longer exists anywhere keep a row in the "Device scope & pins" list forever (the row universe is `local snippets/ dir ∪ store enabled list`, and the existing Clean up block only covers local-enabled + no-file + **not-in-store** names — exactly missing the user's case).
4. **Plugin icon** (chosen candidate CS-A: sync-ring + solid center dot): repo logo assets, README embed, social preview, iconize-importable mono SVG.

## 1+2 · General tab (SettingTab.ts)

- `renderActiveTab` general branch: call `renderPassphrase` **before** `renderRibbonToggles` (after `renderStatusToggles`). Passphrase then sits among the top-level general settings, above the "Ribbon buttons" heading. Move its `GENERAL_SETTINGS` entry before the Ribbon buttons entry too (keeps the search index in visual order). No other change to the passphrase row.
- `renderRibbonToggles` defs: `{ key: "sync", label: "Sync" }` → `label: "Sync Center"`.

## 3 · Dead-snippet cleanup (extend the existing orphan mechanism)

**New orphan definition** — a name is *dead* iff it appears in the local enabled list OR the store enabled list, and has **no `.css` file locally AND no `.css` file in the store's snippets dir** (`{root}/store/{groupStorePath of "{configDir}/snippets"}`). Checking the store's snippets dir keeps the fresh-device case safe: a device whose `snippets/` hasn't synced yet still sees the store files, so nothing is offered for cleanup there.

- `snippetOrphans(local, fromDir, store)` (core/availability.ts) becomes `snippetOrphans(local, store, fromDir, storeFiles)`: candidates = `local ∪ store` enabled names, minus names in `fromDir ∪ storeFiles`; sorted, deduped. Pure, unit-tested.
- `snippetUniverse()` (main.ts) additionally lists the store snippets dir (`.css` basenames; missing dir → empty).
- `switchListRows("enabled-css-snippets")`: the row universe **excludes dead names** (they move out of the main list into the Clean up block, per mockup §3).
- Clean up block (SettingTab renderLocalDecisions, existing `orphans` rendering): row chip becomes provenance-aware — `no file · store has on` / `no file` (from the same hint data the main rows use). Block description: "These names are enabled somewhere but the .css file no longer exists here or in the store. Removing also clears them from the shared store list, scopes and pins."
- `removeSnippetOrphans(names)` extended to also clear, per name:
  - `settings.snippetScopes[name]`,
  - the pin in `settings.switchExceptions["enabled-css-snippets"]`,
  - (existing) local `appearance.json` enabled list + in-memory `customCss.enabledSnippets`,
  - then the **store enabled list** — not by hand-editing the store file (that would leave the store index stale) but through the sanctioned path: one single-group `capture(ctx, ["enabled-css-snippets"])`, which rewrites the store copy plus lock/index bookkeeping from the cleaned local list. Scopes/pins MUST be cleared (and settings saved) before the capture, or the scope-away pass-through would carry the dead name's store value back in.
  Removing from the store list means other devices stop seeing the name after their next apply — intended: the file is gone everywhere.

## 4 · Icon assets (CS-A)

New `assets/` directory (repo root):

- `assets/icon.svg` — CS-A mark, 24×24, stroke 2, `currentColor` (iconize-importable).
- `assets/logo.svg` — README tile: rounded-square blue→purple gradient + white mark, 256×256.
- `assets/social-preview.svg` — 1280×640: dark card, mark + "Config Sync" wordmark + tagline "Your Obsidian settings, on every device" (mockup §4 bottom). PNG export for GitHub if a local rasterizer is available; otherwise SVG only, conversion left to the user.
- README.md / README.zh.md: logo centered above the title.

## Out of scope

- Any change to the snippet scope/pin semantics or to the switch-list mechanics.
- Auto-cleanup (removal stays a manual, per-name or clean-all action in the block).
- Renaming anything else in the Ribbon buttons section.

## Error handling

Unchanged patterns: store reads/writes go through the vault adapter with existing try/catch conventions; a failed store-list write surfaces (no silent skip) — Notice + console error, local cleanup still applied.

## Testing

- Unit (vitest): new `snippetOrphans` signature — dead-by-both-missing, saved-by-store-file (fresh device), saved-by-local-file, dedupe/sort; row-universe exclusion if that lands in a pure helper.
- Dev-vault e2e (obsidian-cli): fabricate a dead name (enabled in local+store lists, no file either side) → appears only in Clean up with `no file · store has on` chip; Remove clears all four locations (appearance.json, store list, scope, pin) and the row is gone after reload; fresh-device simulation (file only in store dir) stays in the main list.

## Docs & release

- README.md / README.zh.md: logo; one line in the snippets section about dead-name cleanup semantics.
- docs/ARCHITECTURE.md + docs/DESIGN.md: orphan definition update, assets dir.
- Release: next feature version (current line 1.7.x → **1.8.0**), on explicit "cut" only.
