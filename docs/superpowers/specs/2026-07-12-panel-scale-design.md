# Panel Scale & Expanded-Row Design (iter16)

Approved mockups: `.superpowers/brainstorm/9047-1783841141/content/iter16-final-gallery.html` (ground truth; earlier steps: `long-list-abc.html`, `expand-dir-v2.html`).

## Problem

Four issues in the Sync panel at real-world scale (60+ items):

1. **Long panel** — with many plugins the items macro becomes one long scroll.
2. **Empty expand** — expanding an item row often shows nothing. Root cause: `renderChangesInto` (SyncModal.ts) silently returns when `status.changes === undefined`, which is the case for `in-sync`, `not-captured`, and errored `differs` rows.
3. **Close button overlap** — the title's count pills run under the modal ✕.
4. **Direction lock** — checkboxes are direction-locked, so a user who wants to apply the store version *over* local changes (e.g. after pulling a remote update for a group that also changed locally) has no way to do it from the panel.

## Design

All changes confined to `src/ui/SyncModal.ts` + `styles.css`. Core (`src/core/*`), counting model (`bucketCounts`), pre-check defaults, commands, ribbon, and the Remotes macro are **unchanged**.

### 1. Filter pills (strategy C)

A pill row at the top of the items macro (below the `This device ↔ store` head, above the first section):

- Labels verbatim: `All N` / `To capture N` / `To apply N` / `In sync N`, where the counts come from `bucketCounts` (`N` for All = statuses length).
- Filters **item rows only**; Remotes macro is unaffected.
- Row membership by bucket: To capture = `local-changed` + `not-captured`; To apply = `store-newer` + `differs`; In sync = `in-sync`.
- Section heads and their count pills, the title pills, and the action-bar button counts show **full-set facts regardless of filter** (filtering changes visibility, not truth).
- A section with zero visible rows under the current filter is hidden entirely (head included).
- Under `In sync`, ✓ rows render directly (the in-sync collapse line exists only in the `All` view).
- Default `All` on every panel open; not persisted.
- Active pill styled with accent background (see mockup `.fpill.on`).

### 2. Collapsible sections (strategy A)

- Section heads become click targets that toggle the whole section's row block.
- Collapsed head shows count-pill summaries — `↑ N` (orange), `↓ N` (purple), `✓ N` (green) — only nonzero buckets, computed from that section's statuses. Expanded heads show the same pills (they double as at-a-glance summaries).
- Head keeps the tri-state select-all checkbox; clicking the checkbox must NOT toggle collapse (stopPropagation). The checkbox operates on the checkable rows **visible under the current filter**.
- Sections whose statuses are all `in-sync` render collapsed by default, with the head checkbox disabled (nothing selectable).
- Collapse/expand state is remembered for the app session (module-scoped state in `SyncModal.ts`, keyed by section id), so reopening the panel restores it. Reset on plugin reload is acceptable.

### 3. In-sync collapse line (strategy B)

- Within an expanded section (in the `All` view), `in-sync` rows are replaced by one dim line: `✓ N item in sync ▸` / `✓ N items in sync ▸` (singular/plural).
- Clicking toggles between the line and the flattened ✓ rows (`▾` when open). Toggle state is session-remembered like section collapse.
- No line when the section has zero in-sync rows.
- Flattened ✓ rows keep their disabled checkbox and remain expandable (see §4).

### 4. Expanded row always has content

Expand content is state-driven; order inside the detail area is **actions first, then files**:

- **Rows with `changes`** (`local-changed`, `store-newer`, `differs`):
  1. A mini-button row with two counter-direction actions, labels verbatim:
     - `↑ Capture this (keep local)` (orange text)
     - `↓ Apply store version (overwrites local)` (purple text)
     Clicking executes immediately for this single item via the existing host actions (`captureItems([name])` / `applyItems([name])`), reusing the existing report/reload flow, then the panel refreshes. This is the fix for problem 4 — no checkbox involvement.
  2. The file-change list (`+`/`~`/`−` as today). If the list exceeds **10** entries, render the first 10 plus a dim line `… N more files ▸`; clicking it reveals the rest (no re-collapse needed).
- **`not-captured`**: italic note, verbatim: `not captured yet — nothing in the store`. No buttons (Apply is impossible; Capture is the checkbox's job).
- **`in-sync`**: italic note, verbatim: `identical to the store`. No buttons.
- **Errored rows** (`status.message` set): show the message (existing error styling). No buttons.

The `⚠ applying overwrites local changes` hint div is removed — the Apply mini button's label now carries that warning explicitly.

### 5. Title / close-button avoidance

The title row (`.config-sync-panel-title`) gets `padding-right` sized to clear the modal ✕ (≈28px), so the count pills never underlap it.

## Copy strings (verbatim)

| Context | String |
|---|---|
| Filter pills | `All {n}`, `To capture {n}`, `To apply {n}`, `In sync {n}` |
| In-sync line | `✓ {n} item in sync ▸` / `✓ {n} items in sync ▸` (`▾` when open) |
| Capture mini button | `↑ Capture this (keep local)` |
| Apply mini button | `↓ Apply store version (overwrites local)` |
| File-list overflow | `… {n} more files ▸` |
| Not-captured note | `not captured yet — nothing in the store` |
| In-sync note | `identical to the store` |

## Testing

- Unit (vitest, DOM-free helpers where extractable): bucket membership for filter visibility; section summary counts; file-list cap math; singular/plural strings.
- Live smoke (obsidian-cli, vault-identity guard first, standalone command): stage one row per state (↑, ↓, ≠, —, ✓), verify each expand shows the specified content; verify filter pills hide/show rows while head counts stay constant; verify a mini-button click runs the single-item action and the row lands `in-sync`; screenshot against the gallery mockup.

## Non-goals

- Remotes macro: unchanged (gallery screen ⑤ is documentation, not new work).
- No settings, no persistence of UI state across reloads, no changes to counting or pre-check defaults, no mobile-specific work beyond existing behavior.
