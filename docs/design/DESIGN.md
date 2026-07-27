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
| Capture / ↑ direction | `--color-orange` | state icons, pills, sidebar badges, checkbox `.is-capture` fill, seg buttons, Capture button (solid), capture progress bar, ribbon dot, status-bar segment |
| Apply / ↓ direction | `--interactive-accent` | same family as capture; Apply button is `mod-cta`; apply progress bar, runline dot, status-bar segment |
| Active / selected | `--interactive-accent` | active filter pill, active settings tab underline, active sidebar scope, seg `.is-on`, search-jump highlight, search scope tag |
| In sync / success | `--color-green` | ✓ state icon, pills, result strip frame, test-strip ok, diff insertions, passphrase set badge |
| Pull (remote → store) | `--color-cyan` | pull state icon, Pull button (solid primary), transfer strip, status-bar segment, encrypt-related accents (see below) |
| Push (store → remote) | `--color-pink` | push state icon, Push button (solid primary), outdated-section frame, status-bar segment |
| Locked / encrypted-at-rest | `--color-cyan` | key state icon, statenote pills, policy seg on-state, json encrypt highlighting |
| Warning / caution | `--color-orange` | ⚠ pills, detect/device badges, not-installed section frame, amber version lines, local-decision rows, unresolved conflicts |
| Error / destructive | `--color-red` | ✗ pills, test-strip error, diff deletions, strip-action on-state |
| File changes (reports/diffs) | add `--color-green` · update `--color-blue` · delete `--color-red` | chips `+N ~N −N`, report file lines, conflict-modal marks — a *file-change* semantic, distinct from directions |
| Neutral text ramp | `--text-normal` → `--text-muted` → `--text-faint` | content → secondary labels → hints/chevrons/idle |
| Text on colored fills | `--text-on-accent` (accent fills) · `--background-primary` (orange/cyan/pink fills) | see Findings #4 |
| Field rule: desktop/mobile only (json key) | `--color-blue` (desktop) · `--color-orange` (mobile) | json-preview key highlighting only, reusing existing tokens for a new per-key-scope semantic — no new variable |
| Detected, unruled (json key) | `--color-purple` | json-preview key highlighting only (`config-sync-json-detected`) — the only live use of purple |

`--color-purple`'s prior role (a second apply/selection color) was removed 0.27.9; it now has exactly the one use above and stays banned for anything else.

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

`refresh-cw` ribbon + both panel refreshes + status-bar item · `lock` mode badge ·
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
- **Status bar item** (`src/ui/statusBar.ts`, rendered by `main.ts`) — plain colored text
  segments, no pill backgrounds (mockup candidate A); colors identical to the header pills
  (`is-up` orange, `is-down` accent, `is-push` pink, `is-pull` cyan). Clean state = a dimmed
  `refresh-cw` icon only (`--text-faint`). `mod-clickable`; aria-label lists the non-zero parts
  (`Config Sync — 2 to capture · 1 to apply · push 1`).
- **Self pane** (Config Sync's own state) `config-sync-self-pane` — `-self-title/-self-title-ic/-self-title-sp/-self-sub`, `-self-settings-btn`/`-self-settings-ic` (title-row Settings), `-self-block/-block-h/-block-s`, membership delta `-self-delta/-self-drow/-self-dg`, `-self-viewchange` (expandable `data.json` diff), `-self-pill/-self-hint/-self-caution/-self-acts`.
- **Qualifier autocomplete** `config-sync-qac/-qac-opt` (is-sel)/`-qac-ic/-qac-txt/-qac-desc` — the `key:value` search dropdown under both search boxes, anchored by `config-sync-search-wrap`; opens on focus (an empty box lists every key), key→value suggestions, keyboard-navigable. Logic in `src/ui/qualifierSearch.ts`.
- **Settings tab** (`src/ui/SettingTab.ts`): `config-sync-tabs/-tab` (phone hides inactive
  labels — the pattern the mobile filter pills echo), rows/expand/form-*, fields editor
  (`-fieldrow/-ftag/-act-btn`), remotes forms + `-test-strip`, search (`-hit/-scopetag`),
  passphrase `-ppset/-ppbadge`.
- **Modals**: pull-conflict `config-sync-cm-*` + `diffView.ts` (shared diff panel:
  Unified/Split toggle desktop-only, **Collapse/Full toggle both platforms** folding
  unchanged runs into `-cm-dgap` "⋯ N unchanged lines ⋯" rows); exclude-extras
  `-exclude-row/-modal-buttons`. Cold-start adopt is not a banner: the self pane (above)
  renders the coldstart state and drives it via `adoptConfiguration`.
- **Unified card** (定稿 mockup artifact `v7-final-panorama`, 2026-07-25, plus the icon/
  progressive-disclosure pass in artifact `239c8393-cd61-4faa-95aa-e49f1804b446`, 2026-07-26; specs
  `docs/superpowers/specs/2026-07-25-unified-card-design.md` and
  `docs/superpowers/specs/2026-07-26-card-visual-refresh-design.md`) — replaces every earlier
  settings-tab shape (the per-switch-list `-ldrow` scope editor, the "Domain / companion"
  container row, `kind: "app-view"`/`"appearance-domain"` special-casing, the aggregate "Enabled
  community plugins"/"Enabled core plugins" rows) with ONE row + drawer renderer for every synced
  item (`SettingTab.ts`'s `renderItemCard`, driven by `registry.ts`'s `ItemDef`). No kind
  branches remain: an Obsidian option group, a core plugin, a community/beta plugin and a
  state-only plugin (no settings file yet) all render through the same function.
  - **Row** `config-sync-item-wrap` — chevron, name, badges (`config-sync-card-badge*`; order:
    grey `desktop-only plugin` chip (manifest `isDesktopOnly`, monitor icon via `-badge-plat/-badge-ic`)
    → enablement scope when non-default → `N device-scoped` → `N encrypted`; a zero count never
    renders), sync toggle. No mode chip and no other row content — mode is a derived, drawer-only
    state (`itemCard.ts`'s `deriveMode`, see Drawer ② below), never a header control — the same
    terse rows-are-lists-nothing-else rule the Sync Center already follows.
  - **Drawer** `config-sync-item-exp`, up to three zones, every row across all three built on one
    4-column grid (`config-sync-grid`: content `1fr` | scope `var(--cs-scope-w, 28px)` | state
    `28px` | action `28px`; action-column icons are `config-sync-ghost`, faint 0.25 idle, full on
    the row's `:hover`/`:focus-within` or `.is-active`, so the grid stays quiet until touched).
    Every scope control in a drawer is one Commander-style cycling icon
    (`config-sync-scopeicon`, `renderScopeCycle`): the glyph IS the state (`SCOPE_ICONS`:
    monitor+smartphone = All devices, monitor = Desktop only, smartphone = Mobile only,
    airplay = This device), a click advances to the next value in that row's own option list
    (`nextScope`, wrapping), tooltip `Change scope (currently: …)`; the `all` default sits dim
    (0.45) and any narrower scope renders `.is-set` (accent, full opacity). ① and ②
    render only when they apply, ③ Companion folders always renders (down to just its quiet
    `+ Add folder` row, `config-sync-add-row-quiet`, when a card has no folders yet):
    ① **Enabled on** (plugin cards only) — one 4-option scope icon reading/writing
    `ItemConfig.enabledOn` directly (no parallel state).
    ② **Settings file** — mode is derived, never chosen: no per-key rule anywhere (`rules` and
    `perItem` both empty) is whole-file state, any rule is per-key state. The grid's first row
    (`config-sync-card-sfhead`) is always the path row: path code, a 3-option scope icon (no
    `This device`) and a lock icon toggle (`config-sync-lock`, `.is-on` when encrypted) that
    encrypts the whole file. The path text itself is the edit entry point
    (`config-sync-card-pathbtn`, hover = dotted underline + soft backdrop; `.is-custom` accent
    once a custom path is committed): click it and the row swaps to an input — Enter/blur
    commits, Escape cancels via a keymap `Scope` pushed while the input is focused (Obsidian's
    own Escape handling would close the settings window otherwise), and a committed custom path
    shows a quiet `Reset to default` text action (`config-sync-reset-link`, registered on
    mousedown so the input's blur-commit can't tear it out first) inside the edit row. In
    whole-file state the path row's scope/lock are live; in per-key state they render
    `config-sync-dim` and disabled (tooltip "Per-key rules are active — remove them to control
    the whole file again"), and a rule row (`config-sync-card-rulerow`) appears per configured
    key — never every key in the file, only ones with a rule; browsing the rest is File
    preview's job (below) — each with its own scope icon, a lock toggle (disabled at `This device`
    or while `Per-item scopes` is on) and a ✕ (`Remove rule`) that deletes it; a string-array
    key adds a `Per-item scopes` toggle (`config-sync-card-peritem`) — flip it on and each
    element gets its own row (`config-sync-card-elrow`) instead of one rule for the whole key.
    Removing the last rule flips the card back to whole-file state. Below the rule rows, a
    collapsed disclosure (`config-sync-card-disclosure`, `▸ File preview` / `▾ File preview`)
    expands into the read-only `data.json` preview (`jsonView.ts`) — collapsed by default, so a
    card with no rules never reads its file at all — keys colored by rule, a color-dot legend (`config-sync-legend-dot`, round-7 定稿 B)
    underneath, a lucide `lock` (`config-sync-json-lock`) marks an encrypted key,
    `--color-purple` = detected-but-unruled, faint = plain; a `perItem` array colors each
    element the same way. Click a key to add a rule for it directly (promotes the card to
    per-key state).
    ③ **Companion folders** — preset (`themes/`, `snippets/`) and user-added vault-relative
    folders, each on the same grid (`config-sync-card-companiongrid`): content column is the path
    plus a collapsed member count (`config-sync-card-membercount`: `· N themes` for the themes/
    preset, `· N files` otherwise) and a ▸/▾ arrow (`config-sync-card-memberarrow`) — click the
    row to expand its member list, while the folder name itself (same `config-sync-card-pathbtn`
    affordance, click/keydown stopPropagation so it never doubles as the member toggle) opens the
    Save/Cancel path-edit row (autofocused; Escape cancels via the same keymap `Scope` as the
    settings-file path row); scope icon + sync toggle in their own columns; the action column
    holds only a ✕ (`Remove folder`) on a user-added row (a preset is only ever relocated via
    the warning-gated path edit, never removed outright). A trailing quiet `+ Add folder` row
    (`config-sync-add-row-quiet`, no longer a full-width button) closes every card (a card with
    zero rows renders no `Companion folders` header, just the Add-folder row). Opening
    `snippets/` lists members (`config-sync-card-snippetmembers`), each its own scope icon — it
    writes `enabledCssSnippets` AND decides whether the file itself travels — the only companion
    whose members carry a scope control; a plain (unmapped) folder's members list for
    information only (`ItemDef.presetCompanions` has no per-member carry mechanism today — a
    future engine iteration, not this one).
  - **Release notes** (binding for this cut): the store AND the settings schema both break —
    `schemaVersion: 2` has no migration from any earlier `data.json` shape, and the store gains
    whole-file-encryption envelopes alongside the existing `__scopes__` sidecars. Hand-written
    release notes must say **all devices upgrade together, then reconfigure which items sync** —
    this supersedes and folds in every earlier partial-compatibility clause (the phase-1
    `memberScopes` window, the phase-2 `__scopes__` sidecar note) into the one blocking statement.

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

1. **Dead CSS** — resolved 2026-07-25 (unified-card cleanup, task-8-brief.md): the
   pre-Sync-Center status-list rules (`.config-sync-status-row`, `.config-sync-state.*`,
   `.config-sync-picker-insync`, `.config-sync-center-title`) and every selector left behind
   by the v3 "Device scope"/"Domain" UI (`.config-sync-ldrow`/`-ld-scope`/`-ld-pinchip`/
   `-ld-ovr`, `.config-sync-orphan-*`, `.config-sync-bootstrap*`, `.config-sync-domain-sect*`,
   the old "Custom location" editor `.config-sync-cl-*`/`-adv-toggle` (`-reset-link` has
   since been revived by the click-to-edit path row's "Reset to default" action),
   `.config-sync-devbadge`/`-facebadge`, `.config-sync-badge`, `.config-sync-cust`,
   `.config-sync-link`, `.config-sync-jsonbody`, `.config-sync-shared-tag`,
   `.config-sync-passphrase-status`, `.config-sync-guide*`, `.config-sync-strip.is-transfer`)
   are all removed. Remaining, still open: three TS-only classes with no CSS rule
   (`-beta-mapnote`, `-remote-comparing`, `-cm-unified`; `-flock` has since grown a real rule)
   — decide whether they get styles or stay as semantic hooks.
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
