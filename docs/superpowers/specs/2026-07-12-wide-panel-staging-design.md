# Wide Two-Pane Panel & Staging Interaction (iter18)

Approved mockup: `.superpowers/brainstorm/9047-1783841141/content/wide-redesign.html` (option 2 layout, chosen as step 1 of the two-step path; option 1, the workspace-ItemView "Sync Center", is iter19 and OUT of this spec's scope).

## Problems

1. **Split interaction model.** The expanded row's mini buttons execute immediately, while the bottom bar is select-then-batch. Clicking `↓ Apply store version` fires an apply on the spot — visibly at odds with the `Apply N items` flow right below it.
2. **Narrow-and-long panel.** All content stacks in one ~560px column; at 70+ items the panel is a scroll tube. The reference layout (ioto-tasks-center) is a two-pane grid: narrow scope sidebar + flexible main list.

## Design

All changes in `src/ui/SyncModal.ts`, `src/ui/panelModel.ts`, `styles.css`. Core, counting, awareness, commands, reports: unchanged.

### 1. Staging semantics — one execution point

The per-item mini buttons become a **segmented direction toggle** (`↑ Capture` | `↓ Apply store`) that stages, never executes:

- Clicking a segment **checks the row and sets its direction** to that segment. The checkbox turns orange (capture) or purple (apply) accordingly.
- Clicking the row's already-active segment **unstages** (unchecks; direction override cleared).
- The plain checkbox keeps working: toggles staged/unstaged using the row's effective direction.
- **Effective direction** = explicit override if the user picked a segment, else the state's default (`directionForState`). New modal state: `directionOverride: Map<string, Direction>`, reset on every reload (like `selected`).
- `captureNames()` / `applyNames()` split by effective direction.
- The ONLY execution points are the footer buttons `↑ Capture N item(s)` / `↓ Apply N item(s)`. `host.captureItems`/`applyItems` signatures unchanged.
- Segment aria-labels carry the old warnings verbatim: `Capture this (keep local)` / `Apply store version (overwrites local)`.
- The toggle appears in the expanded detail of every row with `changes` (where the mini buttons were). The active segment reflects the staged direction; no segment is active when the row is unstaged.

### 2. Two-pane wide modal

The modal widens to **920px** (capped by viewport). Inside, a grid `minmax(150px, 22%) / 1fr`:

**Left sidebar (scope navigation):**
- Head `This device ↔ store`, then `All items` plus one entry per category that has items (existing `CATEGORY_LABELS` order). Each entry shows nonzero bucket badges (`↑n` `↓n` `✓n` `○n`, small).
- Head `Remotes · checked <age>` with the existing refresh button, then one entry per remote with its state glyph (existing `remoteIcon`).
- Exactly one entry is active (accent background). Default on open: `All items`. Selection is per-open (not persisted).
- Clicking a category scopes the right pane to it; `All items` shows everything; clicking a remote switches the right pane to that remote's detail.

**Right pane (item mode):**
- Top bar: the existing five filter pills + a **name search input** (placeholder `Filter by name…`, case-insensitive substring on item name, resets on open). Pill counts are computed over the current sidebar scope; title pills stay global.
- One flat list card (NO section heads — the sidebar carries categorization). Rows unchanged (chevron / name / state icon / checkbox), expand = §1 toggle + capped file list / notes.
- In the `All` filter view, trailing collapse lines replace the flattened inert rows: `✓ {n} item(s) in sync ▸` (existing) and a new `○ {n} item(s) with no settings yet ▸` — each click-to-flatten, session-remembered as today (keyed by scope).
- A tri-state **select-all checkbox** at the right end of the filter bar operates on the currently visible checkable rows (replaces the per-section checkboxes, preserving the one-click select-all/clear-all capability).
- Footer bar (always visible at the pane bottom): left `{n} staged` (total checked), right the two execution buttons.

**Right pane (remote mode):** the existing remote detail rendering (deep diff by category, match line, Pull/Push buttons) moves here unchanged, filling the pane. Filter pills/search/footer are hidden in remote mode.

**Narrow fallback:** below 700px container width (CSS container/media query, no JS observer), the grid collapses to one column and the sidebar renders as a horizontal wrap of chips above the filter pills. Mobile uses the same fallback.

### 3. Removed / retired

- Per-section heads, their pills and tri-state checkboxes (replaced by sidebar + global select-all).
- Section collapse state (`sessionUi.sectionCollapsed`) — no sections to collapse. The ✓/○ collapse-line memory stays.
- Immediate-execute mini buttons (`renderMiniActions` semantics) — replaced by the staging toggle.

## Copy strings (verbatim)

| Context | String |
|---|---|
| Sidebar all-entry | `All items` |
| Sidebar heads | `This device ↔ store` / `Remotes · checked {age}` |
| Segment labels | `↑ Capture` / `↓ Apply store` |
| Segment aria | `Capture this (keep local)` / `Apply store version (overwrites local)` |
| Search placeholder | `Filter by name…` |
| Footer staged count | `{n} staged` |
| No-settings collapse line | `○ {n} item with no settings yet ▸` / `○ {n} items with no settings yet ▸` (`▾` open) |

## Testing

- Unit (panelModel): effective-direction helper (`override ?? default`), no-settings line text singular/plural, name-search predicate.
- Live smoke: stage via segment → checkbox color flips, footer counts move between Capture/Apply, nothing executes until footer click; unstage via active segment; sidebar scoping (category counts, remote mode swap); search narrowing; select-all tri-state on visible rows; ✓/○ collapse lines; 920px layout + narrow fallback screenshot.

## Non-goals (explicitly iter19+)

- Workspace ItemView "Sync Center" migration (container swap; this iteration's two-pane content moves over as-is).
- Any change to capture/apply/pull/push logic, reports, awareness, or settings.
