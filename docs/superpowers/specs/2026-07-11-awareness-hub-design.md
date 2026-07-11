# Passive awareness, change-aware reports, Sync hub — design

**Status:** approved for planning (visual design iterated to v13 in the brainstorm companion; mockups under `.superpowers/brainstorm/11951-1783771581/`)

**Four-color action system (binding everywhere):** Capture = orange (`--color-orange`), Apply = purple (accent), Pull = cyan (`--color-cyan`), Push = pink (`--color-pink`). Checkboxes, action buttons, remote state icons and menu badges draw exclusively from this mapping; no action ever borrows another's color.
**Date:** 2026-07-11
**Scope:** post-0.11.0 feedback: awareness exists but is invisible (ribbon shows nothing, remote needs manual clicks), reports list copy counts instead of changes, the Status/Apply panels don't scale, and the command surface fragments one mental task ("sync") into five entries. Plus the `Editor & general` label inaccuracy.

## Command-surface consolidation (the big simplification)

- **Ribbon menu shrinks to two items:** `Sync…` (badges `↑ N` / `↓ N` when non-zero; opens the Sync panel) and `Revert last apply`. lucide icons (`refresh-cw`, `undo-2`).
- **Command palette:** `Sync: open the sync panel` and `Revert last apply`. The `capture` / `apply` / `pull` / `push` / `status` command ids retire (release notes flag re-binding hotkeys).
- **Individual ribbon icons setting** shrinks to `sync` / `revert` (`RibbonKey` change; old keys in data.json ignored — established no-migration practice). The sync individual icon carries the same status dot as the main icon.
- Capture, Apply, Pull, Push are executed **only from the Sync panel** (buttons below). `transportAvailable()` now gates the panel's Remotes section instead of commands.

## A. Passive awareness architecture

### A1. Event sources

- **Store side:** the store is vault content; note-sync writes fire `vault.on("modify"/"create"/"delete"/"rename")`. Subscribe once, filter by the resolved data-folder prefix, debounce 2 s, recompute local status, refresh the ribbon dot.
- **Local config side:** configDir emits no vault events → lazy compute (menu/panel open) + periodic light check every 5 min while the window is focused (toggle, §A5) + immediate recompute after Capture/Apply/Pull/Push.
- **Remote side:** lightweight `checkRemote` (remote lock only) runs 30 s after load (desktop, remotes exist), every 4 h, on every panel open, and via the panel's refresh icon (toggle, §A5). Results cached `{ remote → { check, at } }`; failures cache as `unknown` with the message. Never a popup.

### A2. Ribbon indicator

- Colored dot (CSS class + pseudo-element) top-right of the ribbon icon: **orange** = items changed here (local-changed + differs) → capture; **blue** = store-newer items or any cached remote-newer → apply/pull; orange wins when both; none = no dot. Same dot on the optional individual `sync` icon.
- Icon tooltip = live summary: `Config Sync — 2 changed here, 1 store-newer, remote "kickstart" newer`.

### A3. Change-aware engine data

- `GroupResult` gains `changes: { added: string[]; updated: string[]; deleted: string[] }` (store-relative names).
- **Capture compares before writing:** unchanged files skipped (no rewrite → no note-sync churn); classified added/updated; deletion propagation fills `deleted`. Sanitize groups compare sanitized serializations.
- **Selective capture:** `capture(ctx, names?)` — omitted = all; provided = only those groups' files touched, the lock still rewrites with carry-forward for unselected groups, `capturedAt` updates.
- **Pull/Push mapping:** `importExternal`/`pushExternal` compare before write, classify per rel, map rels → groups via `groupStorePath` prefix (unmatched → `""` pseudo-entry, UI label "store metadata"), return per-group `GroupResult[]`.
- **Status collects full diffs:** the compare functions stop early-returning; `GroupStatus.changes?` carries the same shape — one diff implementation powers status, capture, and the panel's expandable file lists.
- **Remote deep compare** `diffRemote(ctx, reader)`: remote listing + contents vs local store, per-group `changes` — the Pull/Push preview. On-demand (remote row expand), direction-neutral data (the UI words it per direction).

### A4. Label fix

`Editor & general` → **App settings**, desc `Editor, Files & links and other general options (app.json)`; audit the rest of `OPTION_LABELS` for coverage mismatches in the same pass.

### A5. Settings

- Keep `statusInMenu` (governs the Sync… menu badges).
- **Remove `statusInPickers`** (the panel is status-native; old key ignored).
- Add `remoteAutoCheck: boolean` (default true), `localPeriodicCheck: boolean` (default true).

## B. Reports — one "change language"

Capture / Pull / Push / Apply reports share (Revert keeps its single-line form):

- **Title = verb + count pills:** title text is just the verb phrase (`Captured` / `Pulled from kickstart` / `Pushed to backup` / `Applied`) with right-aligned pills `N changed` (neutral) and `✓ N` (green) — no prose sentence. Subtitle: timestamp (+ remote capturedAt for pull).
- **Category sections** (Obsidian / Core plugins / Community plugins / Custom via the reservedNames mapping), rendered as **blocks** (§C visual language).
- **Changed items:** row = chevron · mono name · chips `+N` `~N` `−N`; click expands the file list (`+` green / `~` blue / `−` red strikethrough). Errors/warnings first, pre-expanded.
- **Unchanged footer:** one dim collapsible line `✓ N items unchanged ▸` — names render only on expand (scales to any N). Pull/Push add `· store metadata updated` when applicable.
- Reports keep default modal dismissal (read-only; outside click is harmless).

## C. The Sync panel (replaces StatusModal + GroupSelectModal)

One modal for everything. **Does not close on outside click** (scrim click disabled — selections survive stray clicks); Esc and × close. Mobile: identical minus the Remotes section.

**Layout (v13 mockup — two macro-blocks):**

The panel body is **two top-level rounded blocks**: macro-block 1 `This device ↔ store` (category subsections + the Capture/Apply action bar at its bottom) and macro-block 2 `Remotes`. Inside each macro-block the structure below applies.

1. **Header:** `Config Sync` + count pills `↑ N` `↓ N` `✓ N` (icon+number; tooltips explain).
2. **Category sections (inside macro-block 1):** heading (label + tri-state section checkbox — all checkable rows ↔ none, `−` when partial, ✓-rows excluded) outside a **rounded sub-card** containing the item rows (row separators inside the card only).
3. **Item rows:** chevron · mono name · dim resolved path (ellipsis) · state icon (`↑` orange / `↓` purple / `≠` neutral gray / `✓` green / `—` gray; tooltip gives the full "(likely)" text) · **direction-colored checkbox**:
   - `↑` → orange box, counts toward Capture; pre-checked.
   - `↓` → purple box, counts toward Apply; pre-checked.
   - `≠` → purple box toward Apply; NOT pre-checked; when checked the row shows `⚠ applying overwrites local changes`.
   - `—` → orange box toward Capture (first capture); NOT pre-checked.
   - `✓` → disabled, row dimmed.
   - Row expand = file-level `+/~/−` list from `GroupStatus.changes`.
4. **Action bar — bottom of macro-block 1** (after the category sub-cards): `↑ Capture N items` (orange-accent quiet button) + `↓ Apply N items` (purple CTA). Live counts; disabled at 0. Capture = selective capture of checked ↑/—; Apply = existing checkApply → confirmWarnings → apply of checked ↓/≠. Both show their §B report, then recompute status in place.
5. **Remotes macro-block** (desktop, remotes exist): heading `Remotes · checked <age>` + refresh icon-button (lucide `refresh-cw`) re-running the light check for all remotes. One sub-card holds all remotes, dashed divider between them. Remote row: chevron · name · state icon in the Pull/Push palette (`↓` cyan = remote-newer / `↑` pink = local-ahead / `✓` green = same / `—` gray = no store / `?` gray = unknown; tooltips suggest Pull/Push) · dim `captured <time>`.
   - **Row expand = deep compare** (inline "comparing…" placeholder): category-subsectioned item rows with chips, summary line `✓ N more items match ▸ · Pull would bring these changes` (or `…Push would send…`; the match list expands on click like the reports' unchanged footer), and **BOTH inline buttons always present**: `↓ Pull from <name>` (cyan) and `↑ Push to <name>` (pink). The state-aligned button renders solid/emphasized; the counter-direction one renders dimmed but clickable with a risk tooltip (e.g. "Push would overwrite the newer remote"). `✓`/`—`/`?` states show both buttons dimmed-neutral.
   - Inline Pull/Push run the existing flows, show their §B report, refresh status + remote cache.

## D. Copy: item, not group

All user-facing copy says **item(s)**. `config-sync.json` `groups` schema and Advanced-tab "rules" untouched.

## Error handling

- Event handler / periodic / auto-check failures: `console.error` + cached `unknown` where applicable; the panel and menu always open.
- Deep compare failure renders inline (`cannot compare: <reason>`), collapsible, non-fatal.
- Panel actions keep existing failure Notices; zero-selection prevented by disabled buttons.

## Testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit (core): capture skip-unchanged + added/updated/deleted classification (sanitize-aware); selective capture (unselected untouched in store, lock carry-forward); pull/push per-group mapping + store-metadata pseudo-entry; status `changes` collection; `diffRemote` via fake reader.
- Smoke: ribbon dot orange after local edit → clears after capture from the panel; store write flips blue ≤ ~2 s; panel sections/checkboxes/tri-state/action-bar counts/no-outside-close; remote light status auto-present, expand shows preview + neutral button; menu = Sync…+Revert with badges; reports show verdict title + blocks + chips + expandable files; zero console errors.

## Non-goals

- Selective Pull/Push (whole-store; the inline buttons run the full operation).
- Unfocused-window background checks; configurable intervals.
- Line-level content diffs; conflict merge.
- Keeping the old capture/apply/pull/push/status commands or the old modals.
