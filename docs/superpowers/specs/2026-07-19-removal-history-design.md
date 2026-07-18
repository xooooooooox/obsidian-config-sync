# Record removals in run history (0.32.0)

Real-vault ask 2026-07-18: run history logs capture/apply/pull/push/adopt, but the removal
actions added in 0.31.0 (Stop syncing an item, deleting leftover store files) leave no
trace. Record them too, so history is a fuller audit of what changed Config Sync's state.
(Phase 1 of two — showing file diffs inside history is a separate later spec.)

Scope (定稿 b): only the Sync Center's removal/cleanup actions. The settings-tab sync toggle
is a config edit, not a run, and stays unrecorded.

## Data model

- `RunKind` gains `"stop-sync" | "delete-leftover"`.
- `RunRecord` gains two optional fields for the removal detail (absent on sync runs):
  - `removed?: string[]` — item labels removed (Stop syncing).
  - `deletedFiles?: string[]` — store paths deleted, in display form (leading `store/`
    stripped, e.g. `configdir/plugins/x/data.json`).
- Removal records carry `results: []`, `status: "ok"`, `issues: 0`; `changed` is the primary
  affected count (Stop syncing → 1; Delete leftover → files deleted).

## Recording

Host gains one builder and adjusts one existing method:

- `stopSyncing(groupName, deleteStore)` now **returns the store paths it deleted** (display
  form; empty when `deleteStore` is false or there was no store data).
- `appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void>` —
  builds the record (`at` stamped, `status: "ok"`, `issues: 0`, `results: []`), prunes, and
  writes. Gated on `runHistory.enabled` like `appendRunHistory`.

View call sites:
- **Stop syncing** (`openStopSyncing`): after `stopSyncing` succeeds, record
  `{ kind: "stop-sync", changed: 1, removed: [label], deletedFiles: deleted,
  desc: "Stopped syncing {label}" + (deleted.length > 0 ? " · deleted N store file(s)" : "") }`.
- **Leftover deletion** (`deleteLeftovers(rels)`): after `deleteLeftoverStoreFiles` succeeds,
  record `{ kind: "delete-leftover", changed: rels.length, deletedFiles: displayPaths,
  desc: "Deleted N leftover store file(s)" }`.

## Display

- **Table** — the Action cell for the new kinds shows a neutral-gray glyph + label:
  `⊘ Stop syncing`, `⌫ Delete leftover` (a new `dir: "remove"` colored `--text-muted`,
  distinct from ↓-in accent / ↑-out amber). Status is `✓ Done`; Changed = affected count;
  Issues `—`.
- **Detail** — removal kinds have no per-group report (`results` empty), so instead of
  `renderReportContent` the detail shows the `desc` lead plus up to two sections:
  `Removed` (each `removed` label) and `Deleted from store` (each `deletedFiles` path,
  monospace). Sync kinds render as today.

## Styling

Follows DESIGN.md. `.config-sync-hglyph.is-remove { color: var(--text-muted) }`. No new
colors or icons beyond the two glyphs (reuse the `⊘` circle-slash used by Stop syncing and
`⌫` for delete). Detail affected rows reuse the report-row spacing.

## Testing

- Core/pure: `actionLabel`/glyph mapping for the two new kinds (extend the existing
  actionCell coverage); a small helper for the removal `desc` strings.
- Host: `appendActionHistory` writes a well-formed record (status ok, changed, removed/
  deletedFiles, results empty), pruned and persisted; disabled history records nothing.
  `stopSyncing` returns the deleted store paths.
- View: history detail renders the Removed / Deleted-from-store sections for removal kinds;
  the table Action cell shows the neutral glyph + label.
- Live dev-vault: Stop syncing an item (with and without deleting the store copy) → a
  `⊘ Stop syncing` row with the right desc and detail; delete a leftover → a
  `⌫ Delete leftover` row; both show `✓ Done`; disabling run history stops recording.
- Gates: npm test, lint 67-warning baseline, no hardcoded colors.

## Non-goals

File diffs inside history (phase 2). Recording settings-tab toggle removals or group
additions (config edits, not runs).
