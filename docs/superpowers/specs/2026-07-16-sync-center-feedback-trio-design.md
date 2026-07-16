# Sync Center Feedback Trio (0.23.x)

Three acceptance findings, one branch. 定稿 via visual companion (`feedback-trio.html`,
2026-07-16, option A).

## 1. Passphrase status badge (config panel · General)

**Problem:** the set/not-set status is an unstyled text tail at the end of a long description —
after setting the passphrase the user cannot tell it took.

**Design (user chose badge-only):** replace the tail text with a badge fixed left of the input:
`✓ Set on this device` (green: `--color-green` family, matching the caution-badge shape) when
`host.passphrase() !== null`, `Not set` (caution orange) otherwise. Badge updates on Set click.
No other behavior change (the empty-input-clears trap and Set feedback were explicitly deferred).

## 2. Version-ahead items surface as To capture

**Problem (verified scenario):** A captures everything on plugin version 0.23.1; A updates the
plugin to 0.23.3 without settings-content changes → item stays `in-sync`, nothing shown. The
store lock keeps `sourcePluginVersion: 0.23.1` forever, so other devices' "Outdated on this
device" mechanism never fires — the version-propagation chain stalls silently at the source.
(B only saw a prompt because its apply output happened to differ bytewise.)

**Design:** an item whose availability drift is `ahead` (local version > store version) presents
as **to-capture** even when content is identical:

- View-level: `in-sync` state + `drift === "ahead"` → row renders under the To capture filter
  with direction `capture`, ↑ icon, and the existing amber `versionLine` ("newer here; capturing
  will refresh the store") in the expansion. Filter/badge counts include it.
- Capture of a content-identical ahead item already works: files skip as unchanged, the lock is
  rewritten with the current version → store version refreshes → other devices' outdated flow
  triggers. No core change.
- Presentation-only upgrade: the underlying `GroupStatus.state` stays `in-sync` in core; the
  view derives an effective "version-refresh" to-capture presentation (keeps core semantics and
  status tests untouched). The expansion's change area shows "no content changes — capturing
  refreshes the store version only" when there are no file changes.

## 3. Inline content diff on change lines

**Problem:** a differing item shows only `~ data.json` — no way to see WHAT differs.

**Design:** every file-change line in a Sync Center row expansion becomes clickable
(`~ data.json · diff ▾`) and expands an inline diff panel beneath it, reusing the conflict
modal's 定稿 diff language verbatim:

- Shared renderer: extract `diffLines` (LCS), unified/split renderers, and the session-level
  view preference from `ConflictModal.ts` into `src/ui/diffView.ts`; the modal and the inline
  panel both consume it. Same CSS classes (`config-sync-cm-dline` etc.) — no new colors.
- Headers: `--- store · +++ this device (what capture would write)` for capture-direction rows;
  for apply-direction rows `--- this device · +++ store (what apply would write)` — the +++ side
  is always "what the pending action produces".
- **Diff content matches the comparison semantics** (not raw bytes when that would mislead):
  - plain items: local file vs store copy, raw.
  - fields-mode items: local content run through the capture transform (strip + field
    encryption) vs the store copy — the diff shows "what capture would write vs what the store
    holds". Requires the passphrase when encrypt rules exist; without it, show the existing 🔒
    note instead of a diff.
  - whole-file encrypted items: no diff (existing 🔒 note).
  - switch-list items keep their ⌂ exclusion lines; the diff below them shows the masked
    comparison sides (capture-transformed local incl. pass-through vs store).
  - dir-type items: each per-file line is independently clickable with the same panel.
- Host: `SyncCenterHost.diffPair(name: string, rel: string): Promise<{ left: string; right:
  string; leftLabel: string; rightLabel: string } | null>` — null means "no diff available"
  (encrypted without passphrase, unreadable, oversized). Implemented in `main.ts` over the
  core transforms. Large content reuses `diffLines`' existing 2000-line cap ("too large to
  diff inline").
- For the version-ahead case (#2) with no content changes, the panel shows the static line
  "no content changes — capturing refreshes the store version only".

## Testing

- #2: panelModel-level unit tests for the derived presentation (in-sync + ahead → to-capture
  bucket/direction; in-sync + no drift → unchanged). View wiring via dev-vault smoke (forge an
  ahead lock as in the reproduction).
- #3: `diffView` unit tests move/extend the LCS coverage (extraction must not change modal
  behavior — modal tests? none exist; conflict-modal smoke re-check in dev vault). `diffPair`
  covered by a core-level test of the transform pairing for plain + fields items.
- #1: style-only; two-theme screenshot.
- Gates: build/lint (0 errors, 65-warning baseline), color scan, node suite green (323 + new).

## Scope

`src/ui/SettingTab.ts` (#1), `src/ui/panelModel.ts` + `src/ui/SyncCenterView.ts` (#2 derived
presentation, #3 wiring), `src/ui/diffView.ts` (new, extracted) + `src/ui/ConflictModal.ts`
(consume), `src/main.ts` (`diffPair`), `styles.css` (badge + inline-panel container), tests.
Parked: backlog #5 (interruption robustness — direction still undecided).
