# Settings visual unification — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** #3 from the 0.4.0/0.6.0 device-testing feedback: Advanced-tab layout, picker Sync-all control, Discovered-files interaction, search-box width. Pure UI layer — `src/ui/SettingTab.ts` + `styles.css`. No `src/core` changes, no data migration.

**Scope addendum (added during planning):** community-submission readiness. The Obsidian directory rejected the submission because the plugin id `obsidian-config-sync` contains `obsidian` (forbidden by the manifest guidelines). The id becomes `config-sync` (verified available); the old id stays in `BLACKLISTED_PLUGIN_DIRS` alongside the new one because devices installed under the old id still carry that folder. Repo name, npm package name, and schema URL keep the old string. Details in the plan's Task 1.

## Problems (from real-device screenshots)

1. The rule cards in Advanced cram six label+control pairs into one `flex-wrap` row; wrapping varies with panel width, every card looks different — "乱/丑".
2. The centered, max-width search box fights the left-aligned full-width panel — visual asymmetry.
3. The Discovered "Sync this file" blue CTA button clashes with the quiet controls everywhere else, and the card shows **two names** (the mono filename title and a pre-filled `Name` field), which confuse each other.
4. The three Advanced sections (Managed / Discovered / Custom) each have their own look; the tab lacks one visual language.

## Design

### 1. Search box: full width

Remove the centering and width cap. `.config-sync-search` loses `justify-content: center`; `.config-sync-search .search-input-container` loses `max-width: 40em`. The search box spans the same width as the tab bar and content below it. CSS-only.

### 2. Picker tabs: Sync all/none button → toggle

The section-heading control on the picker tabs (Obsidian / Core plugins / Community plugins) changes from a text button to a **toggle**, matching the per-item rows:

- Toggle state = current `allOn` (every tickable item in the section has a group).
- Switching on = create groups for all tickable items; switching off = remove them all. Reuses `toggleSection` unchanged — only the control changes (`head.addToggle(...)` instead of `addButton`).
- The `.config-sync-syncall` CSS class and its rule are deleted.

### 3. Advanced tab: one row language for all three sections

All three sections render **summary rows** with identical height, spacing, and typography. Expanding is the edit affordance; the lock mechanism is removed entirely.

**Summary row (collapsed, the default):**

- Managed: `▸` chevron · mono group name · dim mono path (the `rel` part) · `⚙ customized` badge when the path deviates from the picker default · spacer · **Reset** button.
- Custom: `▸` chevron · mono group name · dim mono path · spacer · **🗑 delete** (ExtraButton).
- Clicking anywhere on the row except its buttons toggles expansion.

**Expanded row:**

- Chevron flips to `▾`; an attached panel opens below the row (visually joined: row bottom corners squared, panel top border merged).
- The panel is a **two-line grid form**, labels in small uppercase muted text above each input:
  - Line 1: `Location` (dropdown, fixed width) + `Path` (text, fills the rest). For **custom** rules line 1 gains a leading `Name` field (managed names are fixed and shown only in the summary row).
  - Line 2: `Type` / `Devices` / `Sanitize` / `Description` — four columns (`Type`/`Devices` fixed narrow, `Sanitize`/`Description` share the rest).
- All fields are immediately editable — expanding is the deliberate action that guards against accidental edits. Field `onChange` handlers keep the existing semantics (save-on-change, no re-render for text fields, `await save → refresh` for structural dropdowns).

**Lock removal:**

- Delete: the lock/unlock ExtraButton, the `unlocked: Set<string>` state, the **Lock all** and **Unlock all** heading buttons, and `setDisabled(locked)` on managed fields.
- Keep: **Reset all** on the Managed heading, per-row **Reset**, the `⚙ customized` badge, and `defaultGroupForName`-based reset semantics.
- New UI-transient state: `expanded: Set<string>` keyed by group name; cleared in `display()`; all rows collapsed by default. Copy on the Managed heading changes to "Rules created from the other tabs. Expand a row to edit it."

**Add rule:** pushes the empty group as today and adds `""` to `expanded`, so the new row renders open (name empty, ready to type). One unnamed rule at a time is the realistic case; a second Add rule while one is still unnamed keeps both open — acceptable.

**Expanded-key maintenance:** `expanded` is keyed by group name. When a custom rule's `Name` field changes, the handler also replaces the old key with the new one in `expanded` (delete old, add new) — otherwise the next structural refresh (e.g. a Type change) would collapse the row the user is editing.

**Discovered files:**

- Row = mono **filename** (as today) · spacer · **toggle** (off). No Name input, no button.
- Switching the toggle on creates the group immediately with the suggested slug (`d.name` from `listDiscovered`, already a valid lowercase slug), path fixed to the file, `type: "file"`, `devices: "all"` — the current button semantics minus the editable name.
- After a successful save the row leaves Discovered (the file is now classified) and the rule appears under **Custom rules**, where the name is editable. Section copy changes to "Config files we found but couldn't classify. Turn one on to start syncing it — rename it under Custom rules."
- On save failure (defensive; suggested slugs are valid by construction): roll back (`groups.pop()`), show the existing error banner, and the row re-renders with the toggle off.

### 4. What does not change

Tab structure (6 tabs), picker item rows, General/Remotes content, validation and save logic (`saveGroups`, error banners), search-results view (it renders only picker checklist rows), scroll/focus/render-generation invariants, `src/core/*` (`listDiscovered`, `defaultGroupForName`, `toggleSection` all reused as-is).

### 5. CSS inventory

- Modified: `.config-sync-search` (drop centering), `.config-sync-search .search-input-container` (drop max-width).
- Deleted: `.config-sync-syncall`, `.config-sync-rule-controls`, `.config-sync-field`, `.config-sync-field-grow`, `.config-sync-field-label` (replaced), `.config-sync-rule-head` (replaced).
- New: summary-row classes (row, row-open, chevron, name, path, badge already exists), expanded-panel class, grid-form classes (two grid templates + the label style). All values from Obsidian CSS variables (`--size-4-*`, `--font-ui-smaller`, `--background-modifier-border`, `--font-monospace`), consistent with the existing file.

## Error handling

Unchanged paths: `saveGroups` catches validation errors into the persistent error banner. The only new failure surface is the Discovered toggle (rollback + banner + toggle resets), mirroring the previous button's rollback behavior.

## Testing

- No unit-test surface (pure DOM). Gate per task: `npm test` (no regressions) + `npm run build` + **`npm run lint` (added to the gate this iteration — the 0.6.0 CI failure was a lint error that test+build missed)**.
- Smoke (obsidian-cli, dev vault): full-width search box; picker heading toggle drives Sync all/none both directions; Advanced rows collapsed by default, expand/collapse on click, edit-and-save inside the panel, Reset / Reset all, `⚙ customized` badge, Add rule auto-expands, custom-rule delete; Discovered toggle creates the rule with the suggested name and the row moves to Custom rules; zero console errors.

## Non-goals

- No changes to picker-tab row rendering or bucketing.
- No cross-tab style overhaul (per user: unify **within** Advanced only; picker tabs keep their current row style).
- No renaming flow inside Discovered (renaming lives in Custom rules).
- #6 (self-sync) and transport work — out of scope.
