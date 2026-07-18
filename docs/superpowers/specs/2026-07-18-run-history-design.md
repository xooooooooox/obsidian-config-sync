# Run history + honest run reports (0.30.0)

Real-vault finding 2026-07-18: after a bulk apply, failures felt like a silent stop. They
weren't — the result strip already listed them, but it was green ("✓ Applied" even with 7
warnings), collapsed behind "details", and anchored at the top while the user was at the
bottom. And each new run overwrote the previous report, losing unacted failures.

Two deliverables, mockup-approved (`history-table-mockup.html`, `report-redesign-mockup.html`,
`history-settings-mockup.html`):
- **A. Latest-run inline strip** made honest (tone reflects outcome, failures expanded).
- **B. Persistent, browsable run history** (sidebar entry → table → detail), user-clearable,
  with settings.

Plus two small display fixes diagnosed the same session (§F).

## A. Latest-run strip: honest tone + expanded failures

`renderResultStrip` (SyncCenterView.ts:537) currently always renders green/cyan, collapsed.
Change:
- **Tone reflects the run's worst outcome**: green when every item is `ok`; amber when the
  worst is `warning`; red when any is `error`. (Worst-status helper over `GroupResult.status`.)
- **Title states the outcome**: "Applied" (clean) vs "Applied with N issues" (warnings/errors).
- **Failures expand by default** when the worst status is not `ok` (the reasons show without
  clicking "details"); a clean run stays collapsed/quiet.
- Add an **"open in history →"** link that selects this run in the History browser (§B).
- Position stays at the top of item mode (the sticky/auto-scroll variant is deferred — the
  honest tone + auto-expand already remove the "looks like success / hidden" problem; the
  full archive lives in History).

## B. Run history

### B1. Data model — `RunRecord`

```ts
interface RunRecord {
  at: number;                 // ms epoch, stamped by the host at record time
  kind: "capture" | "apply" | "pull" | "push" | "adopt";
  remote: string | null;      // set for pull/push only
  status: "ok" | "warning" | "error"; // worst of results, computed at record time
  changed: number;            // items with real file changes
  issues: number;             // items with status warning or error
  desc: string;               // one-line human summary (generated, §B5)
  results: GroupResult[];      // full per-group detail for the detail view
}
```

### B2. Storage (separate file, not data.json)

- A dedicated JSON file, default `{configDir}/plugins/config-sync/run-history.json`
  (same directory as data.json, never inside it). The path is a setting (§B6).
- Format: a JSON array of `RunRecord`, newest first. Read on view open; rewritten on each
  append and on clear.
- **Local only** — never written to the store or synced. (The "sync history to the store"
  toggle was considered and cut: store bloat + cross-device merge for low value.)
- **Pruning** on every append and on load: drop records beyond `maxCount` (newest kept) and
  older than `maxDays`. `maxCount === 0` = unlimited; `maxDays === 0` = keep forever.

### B3. Host interface (main.ts owns file IO + timestamping)

```ts
appendRunHistory(kind, remote, results): Promise<void>; // stamps `at`, computes status/counts/desc, prunes, writes
loadRunHistory(): Promise<RunRecord[]>;                  // pruned, newest first
clearRunHistory(): Promise<void>;                        // deletes all records (empties/removes the file)
```

### B4. Recording

`setLastRun` in the view is refactored to take a `kind` (+ optional `remote`) instead of a
free title/tone, and after a run the view calls `host.appendRunHistory(kind, remote,
results)`. The five call sites map: Captured→`capture`, Applied→`apply`, `Pulled from
X`→`pull`+remote, `Pushed to X`→`push`+remote, Adopted→`adopt`. Recording is gated on the
`enabled` setting (§B6); a disabled history still shows the latest-run strip but writes
nothing.

### B5. `desc` generation (pure, testable)

One product-facing line from the results, e.g.:
- clean apply: "all clean" / "N settings updated"
- apply with install failures: "N plugins not in the community catalog — install manually"
- pull: "N items · M conflicts resolved"
- error: "store has no data for N groups — capture from source first"
Rule: lead with the dominant issue when `status !== "ok"`, else a concise success summary.

### B6. Settings ("Run history" section, General tab)

| Setting | Type | Default |
|---|---|---|
| Keep run history | toggle | on |
| Storage file | text (path) | `{configDir}/plugins/config-sync/run-history.json` |
| Keep at most | number (runs) | 50 (0 = unlimited) |
| Keep for | number (days) | 30 (0 = forever) |
| Clear history now | button | — |

Unset/empty path falls back to the default. Settings live in `ConfigSyncSettings.runHistory`.

## C. History browser (sidebar → table → detail)

### C1. Sidebar

- A **`History`** entry below Remotes, with a **divider** separating the three sidebar
  groups (This device ↔ store · Remotes · History). Entry shows a neutral count badge.
- Selecting it is a new panel scope (`{ kind: "history" }`), rendering the table in the
  main area (mirrors how a Remote selection renders its diff).

### C2. Table (main area)

Columns, in order: **Status · Action · When · Changed · Issues · Summary** (+ a `›` chevron).

- **Status** — icon only, colored: `✓` green (Done), `⚠` amber (Action needed), `✗` red
  (Failed). A legend line sits above the table and each icon has a hover tooltip. (No text
  label in the cell.)
- **Action** (the `kind` enum) — with a direction glyph matching the panel's language:
  `↓ Apply`, `↑ Capture`, `↓ Pull · {remote}`, `↑ Push · {remote}`, `↓ Adopt` (↓ accent =
  into this device/store, ↑ amber = out).
- **When** — absolute `YYYY-MM-DD HH:MM:SS` (local), monospace. Default sort: newest first.
- **Changed** / **Issues** — right-aligned integers; `Issues > 0` amber; 0 shows `—`.
- **Summary** — the `desc`, flexible width.
- Header: "History · N runs · Clear all". "Clear all" calls `clearRunHistory` (confirm).
- The two enum columns (Status, Action) support header-click sort.

### C3. Detail (row click)

Clicking a row replaces the table with that run's detail: a "‹ Back to history" link, the
status icon + Action + absolute time, the `desc` as a lead paragraph, then per-scope
sections listing each item with its chip (`~ updated`, `⚠ install failed`, …) and the
failure reason beneath — reusing `renderReportContent`.

## D. User-facing enum semantics

- **Status**: `ok`→**Done** (all succeeded), `warning`→**Action needed** (applied what it
  could; finish some items manually), `error`→**Failed** (some items couldn't run — source
  missing / store empty). Stored as `ok|warning|error`; displayed via these labels.
- **Action** (kind): Capture / Apply / Pull / Push / Adopt, each with its direction glyph.

## E. Styling

Follows DESIGN.md: theme vars only, `--font-ui-small` base, group headers reuse
`.config-sync-sect` style, amber/green/red = existing semantic vars, sidebar divider =
`--background-modifier-border`. New: table styles (`.config-sync-htable`), status legend,
sidebar divider. `body.is-mobile`: the table collapses column padding / hides the Changed
column if cramped (verify on 390px).

## F. Related display fixes (same session diagnosis)

1. **Matched-list shows raw names** (SyncCenterView.ts:1334): the "N more items match"
   expansion joins `g.name`; use `this.host.displayName(g.name, g.label)`.
2. **Install-failed message duplication**: installer's `CatalogError` message reads
   "… isn't in the community catalog — install it manually" and `runStateAction` appends
   another "install it manually" guidance, and the message leads with the raw plugin id.
   Fix: `CatalogError` message becomes "not in the community catalog" (no id, no guidance —
   the report row header already carries the display label); `runStateAction` keeps its
   single guidance append. (Editor Syntax Highlight and the IOTO/Gitee plugins genuinely
   are not in the catalog — this is correct behavior, only the wording was noisy.)

## Testing

- Core/pure: worst-status helper (ok/warning/error precedence); `desc` generation per case;
  `YYYY-MM-DD HH:MM:SS` formatter; history pruning (count + age, 0 = unlimited/forever);
  `CatalogError` message wording.
- Host: append→load round-trip writes/reads the file, newest first, pruned; clear empties it;
  disabled setting records nothing.
- panelModel/view: matched-list uses displayName; latest-run strip tone/expand by worst
  status.
- Live dev-vault: a run with install failures shows an amber "Applied with N issues" strip,
  expanded; History table lists runs with correct Status icon / Action glyph / absolute
  time; clicking a row shows detail; Clear all empties it; settings change path/retention;
  restart Obsidian → history persists. Gates: npm test, lint 67-warning baseline, no
  hardcoded colors.

## Non-goals

Sticky/auto-scroll latest-run banner (deferred); syncing history across devices (cut);
a version picker; editing/exporting history.
