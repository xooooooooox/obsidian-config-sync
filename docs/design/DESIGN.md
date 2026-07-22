# Design system — obsidian-config-sync

The canonical reference for every visual decision in the plugin (Sync Center panel,
settings tab, ribbon, modals). Read this before styling anything; update it in the same
branch as any UI 定稿 or change. Raw values live in `styles.css` and the `src/ui/*` files —
this document records the *semantics and rules*; when they disagree, the code is wrong or
this file is stale, and either is a bug.

Hard gates (CI/manual): no hardcoded colors (`./scripts/check-no-hardcoded-color.sh`),
theme variables only, mockup 定稿 before UI changes, geometry probes for alignment claims.

## 1. Design tokens

### 1.1 Semantic colors

One color per meaning, everywhere (0.27.9 audit). Alpha fills always use
`rgba(var(--*-rgb), α)`; typical α: 0.15 pill/badge fills, 0.22–0.25 seg-button on-state,
0.4–0.45 borders, 0.05–0.12 large surfaces.

| Semantic | Variable | Used by |
|---|---|---|
| Capture / ↑ direction | `--color-orange` | state icons, pills, sidebar badges, checkbox `.is-capture` fill, seg buttons, Capture button (solid), capture progress bar, ribbon dot |
| Apply / ↓ direction | `--interactive-accent` | same family as capture; Apply button is `mod-cta`; apply progress bar, runline dot |
| Active / selected | `--interactive-accent` | active filter pill, active settings tab underline, active sidebar scope, seg `.is-on`, search-jump highlight, search scope tag |
| In sync / success | `--color-green` | ✓ state icon, pills, result strip frame, test-strip ok, diff insertions, passphrase set badge |
| Pull (remote → store) | `--color-cyan` | pull state icon, Pull button (solid primary), transfer strip, encrypt-related accents (see below) |
| Push (store → remote) | `--color-pink` | push state icon, Push button (solid primary), outdated-section frame |
| Locked / encrypted-at-rest | `--color-cyan` | key state icon, statenote pills, policy seg on-state, json encrypt highlighting |
| Warning / caution | `--color-orange` | ⚠ pills, detect/device badges, not-installed section frame, amber version lines, local-decision rows, unresolved conflicts |
| Error / destructive | `--color-red` | ✗ pills, test-strip error, diff deletions, strip-action on-state |
| File changes (reports/diffs) | add `--color-green` · update `--color-blue` · delete `--color-red` | chips `+N ~N −N`, report file lines, conflict-modal marks — a *file-change* semantic, distinct from directions |
| Neutral text ramp | `--text-normal` → `--text-muted` → `--text-faint` | content → secondary labels → hints/chevrons/idle |
| Text on colored fills | `--text-on-accent` (accent fills) · `--background-primary` (orange/cyan/pink fills) | see Findings #4 |

`--color-purple` is banned (was a second apply/selection color; removed 0.27.9).

### 1.2 Type scale

- Panel base: `.config-sync-center { font-size: var(--font-ui-small) }` — rows and
  anything unstyled inherit the same size as Obsidian's own list UIs (0.27.9).
- Compact step: `--font-ui-smaller` — pills, badges, chips, group headers, hints, notes,
  seg buttons, expanded-detail contents (one scale inside a detail, 0.27.7).
- `--font-ui-large` only for modal titles and the bootstrap banner icon.
- Weights: `--font-semibold` for row/item names; 600 for section/modal titles; 400 reset
  for no-settings row names.
- Micro sizes in raw px exist (9.5–10.5px: sidebar badges, field tags, act buttons,
  cm-kind/viewbtn, sect-count) — see Findings #3 before adding more.
- Uppercase labels (group headers, sidebar heads, form labels) carry letter-spacing
  0.05–0.08em and `--text-muted`/`--text-faint`.
- Monospace (`--font-monospace`): paths, file lists, json viewer, diff panes, runline.

### 1.3 Radii & spacing

- 999px: all pills/badges/tags. `--radius-m`: cards, settings rows, banners, modals.
  `--radius-s`: small chips, test strips, json blocks, inline diffs. 3px: checkboxes
  (desktop), json keys. 8px: sidebar items, switcher, sections, strips. 50%: dots and
  spinner. Segmented controls inside a `.config-sync-seg` frame use radius 0 buttons in a
  5px frame. (Nine tiers total — see Findings #5.)
- Spacing uses Obsidian `--size-4-*` steps; no raw margins except calibrated ones (below).

### 1.4 Calibrated geometry (probe-verified; do not eyeball)

| What | Value | Why |
|---|---|---|
| Checkbox column | mainbar `padding-right: calc(var(--size-4-3) + 1px)`; sections carry the card inset themselves (nested card unframed); section-head boxes `margin-left: auto` | one shared right edge: select-all = card rows = section rows = section heads (probe-equal, desktop + mobile) |
| Header ↻ | `margin-right: 7px` | glyph right edge == checkbox column (probed 1687/365) |
| Checkboxes | 15px desktop / 24px mobile (radius 6px), pseudo ✓ offsets differ per platform | Obsidian's mobile checkbox styling defeats hit-area tricks; visual = touch target |
| Touch targets | 44px rows/switcher/search-adjacent, 36px pills/seg/side items, 32px detail seg buttons | mobile minimums |
| Mobile bottom clearance | `calc(var(--mobile-toolbar-height, 48px) + 88px)` | clears navbar + user status-bar snippets |

## 2. Icon set

### 2.1 State column (`.config-sync-state-icon`, text glyphs + one SVG)

Action states carry dedicated Lucide icons (via `setIcon`): capture `arrow-up-from-line`/orange,
apply `arrow-down-to-line`/accent, push `cloud-upload`/pink, pull `cloud-download`/cyan
(`src/ui/actionIcons.ts` is the single source). Status glyphs stay text: `≠` differs/faint ·
`—` miss/faint · `○` no-settings/faint · `✓` ok/green · `?` unknown · **key** (`key-round`)
locked/cyan.

### 2.2 Mode badges (`.config-sync-mode-badge`, 12px, `--text-faint`)

- encrypted → Lucide `lock`; tooltip "Encrypted mode — the whole file is stored encrypted".
- fields → custom `drawFieldsBadge` SVG (three field lines + corner padlock; no Lucide
  composite exists); tooltip "Fields mode — only sensitive fields are filtered/encrypted".
  定稿方案 B 2026-07-17. plain → no badge.

### 2.3 Lucide usage (setIcon)

`refresh-cw` ribbon + both panel refreshes · `undo-2` revert · `lock` mode badge ·
`key-round` locked state · `chevron-down/right` settings rows · `x` clear/remove ·
`trash` delete · `folder-open` browse · `rotate-cw` BRAT re-scan · `arrow-up-from-line` /
`arrow-down-to-line` / `cloud-upload` / `cloud-download` sync-action icons · tabs: `settings`,
`gem`, `toy-brick`, `puzzle`, `flask-conical` (BratIcon preferred when registered),
`wrench`, `git-branch` · quick-command menu items take the command's own icon by default, changeable via the `getIconIds()` icon picker (`IconSelectModal`).

### 2.4 Glyph language (text, reused everywhere)

Direction *actions* (capture/apply/push/pull) now render as the dedicated icons from
`actionIcons.ts` rather than a shared `↑ ↓` glyph; count badges embed one of those icons
plus a number (`renderActionCount`). `✓ ○` remain text and still power header pills,
sidebar/switcher badges, and the mobile filter pills (short form). Chevrons `▸ ▾ ▴`.
Actions `⤓` install, `⏻` enable. Report chips `+ ~ −`. Warnings `⚠ ✗`. Conflict modal
`＋ ＝ ⌂`. New UI must reuse this vocabulary rather than invent synonyms.

## 3. Component library

Class prefix → role (all in `styles.css`, rendered from `src/ui/SyncCenterView.ts` unless
noted):

- **Pills** `config-sync-pill` (is-up/down/ok/none/neutral/warn/statenote) — counts and
  states; never interactive. **Filter pills** `config-sync-fpill` in `-fpillrow` — buttons;
  long/short label spans; mobile = glyph form, one line. Shared with settings search scopes.
- **Sidebar** `config-sync-side-item/-side-badge/-side-head` — scopes with tiny count
  badges; active = accent tint. The Config Sync self layer leads as a distinct hero card
  `config-sync-side-self` (`-side-self-ic` icon tile, `-side-self-title`/`-side-self-sub`,
  `-side-self-pill` reusing `selfStatePill`), echoing the header self-chip. **Switcher**
  `config-sync-switcher` — compact replacement.
- **Rows** `config-sync-hub-row` — chevron, name (`-rule-name`), optional mode badge /
  excluded note / statenote pill, state icon, checkbox. Names truncate on mobile.
- **Checkboxes** — custom-drawn inputs (hub-row/mainbar/section-head): direction-colored
  when a row (orange capture / accent apply), bright grey (`--text-normal`) for
  select-alls (they carry no direction); idle select-all hides (`-selectall-idle`).
- **Action bar** `config-sync-actionbar` — staged count + solid direction buttons
  (`-btn-capture` orange; Apply = `mod-cta`); 0-item = same color at 0.5 opacity; btnwrap
  hosts the 2px progress bar + shimmer; `-runline` is the live status line.
- **Cards & sections** `config-sync-card`; availability sections `config-sync-section`
  (dashed frame, pink outdated / orange not-installed), nested card unframed; group
  headers `config-sync-sect` (uppercase + hairline) — used in All-items grouping and
  remote diff.
- **Remote** `config-sync-remote-btn` is-pull/is-push (solid cyan/pink when primary,
  dimmed otherwise); diff entries reuse report rows + chips.
- **Reports** `config-sync-report-*`, chips, `-strip` result strip (green; cyan transfer).
- **History** `config-sync-htable` (desktop 7-col table) / `config-sync-hcard*`
  (`-hcard-top/-act/-chev/-when/-sum/-foot`, `-hcard-pill.is-chg` neutral / `.is-iss` orange) —
  the run-history list; the view swaps table → card layout when compact (`<700px`) so mobile
  reads top-to-bottom without horizontal scroll (`-hcard-sum` wraps; `-hcard-act` `min-width:0`).
  Head/legend and the `renderActionInto` action painter are shared by both layouts; detail view unchanged.
- **Header status bar** — **self chip** `config-sync-self-chip` (is-up/down/ok tints) + `-self-chip-ic`, `config-sync-head-divider`, then the pills; push/pull totals use `config-sync-pill.is-push` (pink) / `.is-pull` (cyan).
- **Self pane** (Config Sync's own state) `config-sync-self-pane` — `-self-title/-self-title-ic/-self-title-sp/-self-sub`, `-self-settings-btn`/`-self-settings-ic` (title-row Settings), `-self-block/-block-h/-block-s`, membership delta `-self-delta/-self-drow/-self-dg`, `-self-viewchange` (expandable `data.json` diff), `-self-pill/-self-hint/-self-caution/-self-acts`.
- **Qualifier autocomplete** `config-sync-qac/-qac-opt` (is-sel)/`-qac-ic/-qac-txt/-qac-desc` — the `key:value` search dropdown under both search boxes, anchored by `config-sync-search-wrap`; key→value suggestions, keyboard-navigable. Logic in `src/ui/qualifierSearch.ts`.
- **Settings tab** (`src/ui/SettingTab.ts`): `config-sync-tabs/-tab` (phone hides inactive
  labels — the pattern the mobile filter pills echo), rows/expand/form-*, fields editor
  (`-fieldrow/-ftag/-act-btn`), remotes forms + `-test-strip`, search (`-hit/-scopetag`),
  passphrase `-ppset/-ppbadge`.
- **Modals**: pull-conflict `config-sync-cm-*` + `diffView.ts` (shared diff panel:
  Unified/Split toggle desktop-only, **Collapse/Full toggle both platforms** folding
  unchanged runs into `-cm-dgap` "⋯ N unchanged lines ⋯" rows); exclude-extras
  `-exclude-row/-modal-buttons`. **Banner**: `-bootstrap*` adopt offer.
- **Local decisions** `-ldrow` family (switch-list exceptions) — plus read-only `is-auto` rows
  (`-doto-pill` + disabled toggle) surfacing desktop-only plugins auto-excepted on mobile,
  **divergence** warning block, **inert-note**, **inline diffs** `-inline-diff/-diffhint`.

## 4. Conventions

- Theme variables only; the no-hardcoded-color script is a release gate. Alpha via
  `rgba(var(--*-rgb), α)`.
- Mobile scoping: `body.is-mobile` for panel rules, `body.is-phone` for settings-tab
  layout collapses (phones only; tablets keep desktop settings layout).
- Every UI change: mockup → 定稿 → implement → dev-vault probe/screenshot verification
  (desktop + 390×844 emulation) → gates. Alignment claims are probed, not eyeballed.
- Copy: sentence case; "selected" not "staged"; idle states render nothing.
- New icons come from Lucide via `setIcon` or the glyph vocabulary (§2.4); no emoji in
  chrome (they ignore theme colors) — see Findings #2 for the remaining ones.

## 5. Audit findings — 2026-07-18 (decisions pending)

Each item ships only after a user decision. None change behavior silently.

1. **Dead CSS**: `.config-sync-status-row`, `.config-sync-state.*`,
   `.config-sync-picker-insync` (pre-Sync-Center status list) and
   `.config-sync-center-title` (title removed 0.27.7) have no TS call sites. Also four
   TS-only classes with no CSS rule (`-flock`, `-beta-mapnote`, `-remote-comparing`,
   `-cm-unified`) — remove the dead rules; decide whether the TS-only classes get styles
   or stay as semantic hooks.
2. **Emoji remnants**: settings fields editor 🔒 (`-flock`), bootstrap banner ⬇, plus
   ⚠/⚙/↺/＋/＝/⌂ glyphs. The panel purged emoji (mode badges, locked state) because they
   ignore theme color; candidates: `-flock` → Lucide `lock`, ⬇ → Lucide `download`. The
   pure-text glyphs (⚠ etc.) render monochrome and can stay.
3. **Micro px font sizes** (9.5–10.5px: side badges, ftag, act-btn, sect-count, seg-label,
   cm-kind, cm-viewbtn): below `--font-ui-smaller` and not theme-responsive. Options:
   normalize to `--font-ui-smaller`, or bless a documented "micro" tier. (Checkbox pseudo
   12px marks are geometry-tied; keep.)
4. **Text-on-fill variable split**: accent fills use `--text-on-accent`, orange/cyan/pink
   fills use `--background-primary`. On themes with a light background-primary + light
   accent text these diverge. Candidate: `--text-on-accent` everywhere.
5. **Nine border-radius tiers** (3/5/6/8/9px + s/m + 999 + 50%): candidate collapse to
   `--radius-s`/`--radius-m`/999/50% + checkbox 3px/6px. Visual churn — low priority.
6. **`.config-sync-fpill` double duty** (panel filter pills + settings search scope pills):
   intentional sharing, but a settings-side tweak can silently restyle the panel. Candidate:
   document as shared (this doc) or split the class.
