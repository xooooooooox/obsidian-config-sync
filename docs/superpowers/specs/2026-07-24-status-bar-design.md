# Status bar sync status — design

Date: 2026-07-24 · Status: approved · Baseline: 1.8.0 (`4c74465`)

## Goal

Move the sync-status indicator from the ribbon icon's corner dot to an Obsidian status-bar item. The dot is invisible once the ribbon icon sits inside a Ribbon Organizer group, so the status bar becomes the primary status surface; the dot stays available behind a toggle (default off).

Mockup 定稿 2026-07-24: candidate A — plain colored text segments (not mini pills). The mockup is binding for structure, copy, and colors.

## Decisions (user-approved)

1. **Status bar item** shows icon + `↑n` (to capture) + `↓n` (to apply) + `⇡n ⇣n` (remote push/pull) — same status sources and colors as the Sync Center header pills. Zero-count segments are hidden.
2. **Clean state**: only the icon remains, dimmed (`--text-faint`). The item never disappears — it stays a click target and distinguishes "checked and clean" from "plugin not running".
3. **Click** opens the Sync Center directly (same activation as the "open the sync panel" command). No menu.
4. **Two toggles for the item**: a master "Show status bar item" (default on) and a "Show remote push/pull in status bar" sub-toggle (default on).
5. **Ribbon dot becomes opt-in**: existing dot logic is preserved behind a new toggle, default **off** — a behavior change that goes in the release notes.
6. **Mobile**: a "Show status bar on mobile" toggle (default off) force-shows Obsidian's status bar on phones via CSS only. Default off keeps zero interference with the vaults where Remotely Save's mobile-status-bar switch or a CSS snippet already shows the bar.
7. No new syncing/error visual states — none exist today anywhere in the plugin (YAGNI).

## A. Status bar item

- Created once in `onload` via `this.addStatusBarItem()`, class `config-sync-statusbar`, always created; visibility driven by the master toggle (hide/show element so the toggle takes effect without reload).
- DOM: a `refresh-cw` icon (via `setIcon`, status-bar sized ~13px) followed by up to four text segments:
  - `↑n` — `up` from `bucketCounts` over the presented statuses (same number as the panel's ↑ pill), color `var(--color-orange)`
  - `↓n` — `down` from the same counts, color `var(--interactive-accent)`
  - `⇡n` — `remoteDirectionCounts().push`, color `var(--color-pink)`
  - `⇣n` — `remoteDirectionCounts().pull`, color `var(--color-cyan)`
- Segment rendering rules: a segment renders only when its count > 0; `⇡⇣` additionally require the remote sub-toggle on. On mobile remote checks never run, so `⇡⇣` never appear there — no platform special-casing needed.
- Clean state (no segments rendered): item gets `is-clean`, icon color `var(--text-faint)`; otherwise the icon uses the default status-bar muted color.
- Numbers use `font-variant-numeric: tabular-nums`.
- Click → open the Sync Center view (reuse the existing activation path used by the "Sync: open the sync panel" command).
- `aria-label` lists only non-zero parts: `Config Sync — 2 to capture · 1 to apply · push 1`; clean: `Config Sync — all in sync`. (Terms match the panel pills: "to capture", "to apply", "push", "pull".)

## B. Segment model (pure)

New `src/ui/statusBar.ts`:

- `type StatusBarSegment = { kind: "up" | "down" | "push" | "pull"; text: string }`
- `statusBarSegments(counts: { up: number; down: number }, remote: { push: number; pull: number }, showRemote: boolean): StatusBarSegment[]` — pure; encodes the zero-hide and sub-toggle rules; text is `↑2` / `↓1` / `⇡1` / `⇣1`.
- `statusBarAriaLabel(segments: StatusBarSegment[]): string` — pure; the non-zero-only label above, `Config Sync — all in sync` for `[]`.
- A thin DOM renderer in the same file takes the host element + segments and rebuilds the item (icon + spans). `main.ts` stays wiring-only.
- Unit tests in `tests/statusBar.test.ts` cover: all four segments; zero-hide; `showRemote=false` suppressing `⇡⇣` despite counts; empty → clean label.

## C. Update flow

- `updateRibbonDot()` is renamed `updateStatusIndicators()` and now drives both surfaces: the ribbon dot (only when the dot toggle is on; clears both dot classes when off) and the status bar item. Its three existing call sites (`refreshLocalStatus`, `refreshRemoteChecks`, `syncCenterHost().computeStatuses`) stay as-is.
- Inputs are what the call sites already hold: presented statuses (bucket counts) and `this.remoteChecks` (via `remoteDirectionCounts`).
- Settings `onChange` handlers for the four toggles call `updateStatusIndicators()` (and show/hide the item for the master toggle) so every toggle takes effect immediately.

## D. Settings

Four new persisted booleans on the settings object (flat, matching existing style):

| Key | Default | UI name |
|---|---|---|
| `statusBarItem` | `true` | Show status bar item |
| `statusBarRemote` | `true` | Show remote push/pull in status bar |
| `ribbonDot` | `false` | Ribbon icon status dot |
| `mobileStatusBar` | `false` | Show status bar on mobile |

- Each gets a `GENERAL_SETTINGS` registry entry (name/desc/anchorId: `general-status-bar-item`, `general-status-bar-remote`, `general-ribbon-dot`, `general-mobile-status-bar`) so settings search finds them.
- Descriptions (verbatim from the mockup):
  1. "Sync status in the status bar: ↑ to capture, ↓ to apply. Click opens the Sync Center."
  2. "Include per-remote push ⇡ and pull ⇣ counts. Desktop only — remote checks don't run on mobile."
  3. "Colored corner dot on the ribbon icon — the old indicator, now off by default (invisible when the icon sits inside a ribbon group)."
  4. "Force the status bar visible on phones (Obsidian hides it by default). Leave off if another plugin or snippet already shows it."
- Placement: the four rows render together as one block under a new "Status bar" heading in the General tab, directly adjacent to the existing "Ribbon buttons" heading section. (The mockup's "Interface" heading was a stand-in for this area; "Status bar" is the concrete heading text — flagged here as the one deliberate deviation from the mockup.)
- The "Show status bar on mobile" row renders only on mobile (`Platform.isMobile`) — on desktop the row is hidden, per the mockup caption. The value may still travel via self-sync; it only has effect on mobile.

## E. Ribbon dot behind toggle

- `updateStatusIndicators()` applies the existing `config-sync-dot-capture` / `config-sync-dot-apply` classes only when `settings.ribbonDot` is true; when false it removes both.
- No CSS changes; the dot styles stay as-is.
- Release note: the dot is now off by default — turn on "Ribbon icon status dot" to restore it.

## F. Mobile force-show (CSS only)

- When `Platform.isMobile && settings.mobileStatusBar`, add `config-sync-mobile-statusbar` to `document.body`; remove it on toggle-off and in `onunload`.
- CSS: `body.is-mobile.config-sync-mobile-statusbar .status-bar { display: flex; margin-bottom: var(--mobile-toolbar-height, 52px); }` — no MutationObserver, no inline styles (deliberately unlike Remotely Save, so the two mechanisms can't fight; whoever is enabled wins its own lane, and this one is off by default).
- Verification is numeric (computed style), not visual, per the dev-vault limitation; final look is the user's phone with their existing snippet.

## Out of scope

- Syncing/error states on any surface.
- The switch-list unification (#2 "Enabled community plugins / Enabled CSS snippets" semantics) — shelved; to be brainstormed as its own iteration.
- Any change to the ribbon click menu, `statusInMenu`, or the optional extra ribbon buttons.
- Store-side or remote-check behavior changes.

## Verification

- Gates: `npm test`, `npm run build`, `npm run lint` (zero warnings).
- Unit: `tests/statusBar.test.ts` as in section B.
- Smoke (dev vault via obsidian-cli): read back the item DOM (segment texts + classes) under seeded counts; flip each of the four toggles and confirm immediate effect; click → Sync Center leaf opens; clean state shows dimmed icon only.
- Mobile: with the toggle on in mobile emulation, `getComputedStyle(statusBar).display === "flex"` and `marginBottom` matches `--mobile-toolbar-height`.
- Docs: README + README.zh feature bullet and settings mention, ARCHITECTURE update (status flow now feeds two surfaces), per the docs-currency rule — same branch as the change.
- Changes stay uncommitted until the user asks for a commit/cut.
