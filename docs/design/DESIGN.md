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
| Active / selected | `--interactive-accent` | active filter pill, active settings tab underline, active sidebar section, seg `.is-on`, search-jump highlight, search section tag |
| In sync / success | `--color-green` | ✓ state icon, pills, result strip frame, test-strip ok, diff insertions, passphrase set badge, remote token-status stored |
| Pull (remote → store) | `--color-cyan` | pull state icon, Pull button (solid primary), status-bar segment, encrypt-related accents (see below) |
| Push (store → remote) | `--color-pink` | push state icon, Push button (solid primary), status-bar segment |
| Locked / encrypted-at-rest | `--color-cyan` | key state icon, statenote pills, policy seg on-state (json keys mark encryption with a colorless `lock` suffix — sharing alone drives key color since the D1 split) |
| Warning / caution | `--color-orange` | ⚠ pills, detect/device badges, amber version lines, unresolved conflicts, remote token-status awaiting this device's token, the leftover-section frame, orphan-row hint |
| Error / destructive | `--color-red` | ✗ pills, test-strip error, diff deletions, strip-action on-state |
| File changes (reports/diffs) | add `--color-green` · update `--color-blue` · delete `--color-red` | chips `+N ~N −N`, report file lines, conflict-modal marks — a *file-change* semantic, distinct from directions |
| Neutral text ramp | `--text-normal` → `--text-muted` → `--text-faint` | content → secondary labels → hints/chevrons/idle |
| Text on colored fills | `--text-on-accent` (accent fills) · `--background-primary` (orange/cyan/pink fills) | see Findings #4 |
| Field rule: desktop/mobile only (json key) | `--color-blue` (desktop) · `--color-orange` (mobile) | json-preview key highlighting only, reusing existing tokens for a new per-key-sharing semantic — no new variable |
| Detected, unruled (json key) | `--color-purple` | json-preview key highlighting only (`config-sync-json-detected`) |
| Device-rule exclusion (C-#45 §7, "not synced here") | `--color-purple` | the `excluded` fate bucket's filter pill/sidebar badges/header pill — a row a class rule (C-#24) or a per-device opt-out keeps THIS device from touching; the section fold itself stays unstyled text like the ✓/○ folds it sits beside (spec §7: "same rendering style") |

`--color-purple`'s prior role (a second apply/selection color) was removed 0.27.9; it now has
exactly the two sanctioned uses above (both 定稿'd individually) and stays banned for anything else.

Textual notes use `--text-warning`/`--text-error`; fills, borders, and icons use
`--color-orange`/`--color-red`. Destructive text actions render red on hover (idle muted),
single-row and bulk alike.

### 1.2 Type scale

- Panel base: `.config-sync-center { font-size: var(--font-ui-small) }` — rows and
  anything unstyled inherit the same size as Obsidian's own list UIs (0.27.9).
- Compact step: `--font-ui-smaller` — pills, badges, chips, group headers, hints, notes,
  seg buttons, expanded-detail contents (one scale inside a detail, 0.27.7).
- `--font-ui-large` only for modal titles and the bootstrap banner icon.
- Weights: `--font-semibold` for row/item names; 600 for section, modal, History and
  self-pane titles; 500 for status-bar segments, the conflict modal's auto label and drawer
  member names; 400 reset for no-settings row names.
- Micro sizes in raw px exist (9.5–10.5px: sidebar badges, the sidebar self card's 10px
  status pill (`-side-self-pill`), field tags, act buttons, cm-kind/viewbtn, sect-count) —
  see Findings #3 before adding more.
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
| Inline micro-gaps | 3px (sidebar column rhythm) · 5px (icon↔label clusters) | between `--size-4-*` steps; 8px gaps use `var(--size-4-2)` |

## 2. Icon set

### 2.1 State column (`.config-sync-state-icon`, text glyphs + one SVG)

Action states carry dedicated Lucide icons (via `setIcon`): capture `arrow-up-from-line`/orange,
apply `arrow-down-to-line`/accent, push `cloud-upload`/pink, pull `cloud-download`/cyan
(`src/ui/actionIcons.ts` is the single source). Status glyphs stay text: `≠` differs/faint ·
`—` miss/faint · `○` no-settings/faint · `✓` ok/green · `?` unknown · **key** (`key-round`)
locked/cyan.

C-#50: the Sync Center's trailing-fold summary lines (`✓ N items in sync` / `⊘ N not synced on
this device` / `○ N with no settings yet`) are a DIFFERENT vocabulary from this text-glyph state
column — canvas-metrics found the text glyphs optically unequal across themes (font-fallback ink
weight), so those three states moved to fixed-size 12px Lucide instead (§2.3). This state column
itself is untouched.

### 2.2 Mode badges (`.config-sync-mode-badge`, 12px, `--text-faint`)

- encrypted → Lucide `lock`; tooltip "Encrypted mode — the whole file is stored encrypted".
- fields → custom `drawFieldsBadge` SVG (three field lines + corner padlock; no Lucide
  composite exists); tooltip "Fields mode — only sensitive fields are filtered/encrypted".
  定稿方案 B 2026-07-17. plain → no badge.

### 2.3 Lucide usage (setIcon)

`refresh-cw` ribbon + both panel refreshes + status-bar item · `lock` mode badge ·
`key-round` locked state · `chevron-down/right` settings rows · `x` clear/remove ·
`trash` delete · `folder-open` browse · `rotate-cw` BRAT re-scan · `arrow-up-from-line` /
`arrow-down-to-line` / `cloud-upload` / `cloud-download` sync-action icons (the first two
double as the self-pane title's capture/coldstart states, with `alert-triangle` both and
`settings` default — see §2.4) · tabs: `settings`,
`gem`, `toy-brick`, `puzzle`, `flask-conical` (BratIcon preferred when registered),
`wrench`, `git-branch` · `monitor` / `smartphone` — `sharingIcon`'s Desktop only/Mobile only
stops (every sharing cycle) and the row-level
desktop-only-plugin badge (`config-sync-card-badge-plat`, itemCard.ts) · `airplay` —
`sharingIcon` "This device" stop, used ONLY for a plain field/file rule's cycle (no local
layer to speak for); the whole cycle renders through the one shared
`renderSharingCycle` (sharingCycle.ts; the model — `sharingIcon`/`nextSharing`/`sharingCycleTooltip`
— stays in itemCard.ts), used by every Settings drawer sharing cell that has no local layer —
a direct-cycle click there advances straight to the next option. `monitor-smartphone` — the
sharing-cycle "All devices" stop.

**The two-segment row** (spec `2026-08-12-enablement-two-layers-design.md` §6.1, `ui/enablementRow.ts`):
`label | fleet segment | divider | local segment`, shared by a Sync Center row's `Default enabled
on`/`Default settings sync`, a plugin card's `Default enabled on`, and a carrier card's element
rows — replacing the old `Runs on`/`Settings sync` icon-trigger-plus-menu rows and their
`RUNS_ON_ICONS` vocabulary outright. Fleet segment: `sharingIcon`'s icons for the three device
stops, plus `users` for `Each device decides` (**never** `airplay` here — the value is about the
fleet's arrangement, not this device, and `airplay` reads as screen mirroring to a reader who
hasn't read the source). Local segment: **no icon** while following the default (a default has
nothing to say) · `power` / `power-off` for an element-level local exception (**On here**/**Off
here**) · `circle-slash` for a whole-file local opt-out (**Not synced here**, reused from the fold
family below — same meaning, "not synced on this device," deliberately) — click on either segment
opens an Obsidian `Menu` (never cycling; `ui/enablementRow.ts`'s `buildLocalMenu`/
`buildFileLocalMenu` are its one producer each).

`settings-2` — the sidebar Config Sync
self-entry tile, the compact switcher's self entry, the self pane's title-row Settings
button, the read-only carrier chip (§2.5 below), and the Sync Center card's `More` row — an
icon-only deep link into the item's own Settings card (tooltip carries the sentence, no trailing
`▸`; **never** `sliders-horizontal`, which already means `your rule` in the fate chips below) ·
`arrow-left-right` — the Sync Center leaf/tab icon ·
`chevron-right` — qualifier-autocomplete key rows (value rows use `check`, §2.4) · fate chips
(`config-sync-fatechip`, `FATE_CHIP_ICON` in `fateChipIcons.ts` — every chip renders icon + text,
generalized from the `encrypted`/`lock` special case): `circle-dashed` not installed here ·
`monitor` desktop only · `sliders-horizontal` your rule / off here — your rule / on here — your
rule · `power-off` stays off (**not** `power` — `power` now means "this device turned it on" in
the two-segment row's local segment, so a chip saying the row stays OFF cannot share it) · `lock`
encrypted · `check` your choice · trailing-fold states
(`config-sync-fold-ic`, `FOLD_ICON` in `foldIcons.ts`, C-#50): `check`/green in sync ·
`circle-slash`/muted not synced on this device · `circle`/muted no settings yet.

**`ban` is retired** — it was the Sync Center card footer's `⊘ Stop syncing` action icon
(`renderStopSyncing`), and that footer is gone (spec `2026-08-12-enablement-two-layers-design.md`
§6.2, §4 below): the whole-item destructive gesture now lives on the item's own Settings card,
beside its sync toggle, and is reached from the Sync Center only through the `More` deep link
above — never a second control drawn straight onto the row. `circle-slash` therefore has exactly
one job left, the fold family's STATE glyph (and the local segment's whole-file opt-out,
deliberately the same glyph and meaning) — an icon never means both a thing you can click and a
thing that already happened.

**Read-only carrier chip** — the Core/Community section header chip (`renderCarrierChip`,
SyncCenterView.ts, spec §6.3) shows `settings-2` + `synced` or `not synced`, same shape on both
platforms (no mobile icon-only fallback — a hover-only tooltip is useless on the one platform with
no hover). It is a shortcut, never a control: click jumps to the carrier's own Settings card,
where the sync toggle it used to BE now lives. Never the toggle glyphs
(`toggle-right`/`toggle-left`, retired with it) — a toggle shape promises "click to flip," and
this chip cannot.

### 2.4 Glyph language (text, reused everywhere)

Direction *actions* (capture/apply/push/pull) now render as the dedicated icons from
`actionIcons.ts` rather than a shared `↑ ↓` glyph; count badges embed one of those icons
plus a number (`renderActionCount`). `✓ ○` remain text and still power header pills,
sidebar/switcher badges, and the mobile filter pills (short form) — except two hero
surfaces, which render real Lucide icons instead, parallel to §2.1's key-round exception:
the header/self-pane self-chip (`check`/`settings`, SyncCenterView.ts) and the
qualifier-autocomplete value rows (`check`, qualifierSearch.ts). Everywhere else ✓/○
remain text. Chevrons `▸ ▾ ▴`. Actions `⤓` install, `⏻` enable. Report chips `+ ~ −`.
Warnings `⚠ ✗`. Conflict modal `＋ ＝`. `⌂` is the vocabulary's local/device-exception
glyph, used wherever a decision is pinned to one device — the conflict modal is one case
(`＋ ＝ ⌂`). Scope-cycle controls render their local stop as Lucide `airplay` instead
(§2.1). Self-pane
title icon (`config-sync-self-title-ic`) is Lucide (the self pane is a hero surface):
`arrow-down-to-line` coldstart · `arrow-up-from-line` capture — the ACTION_ICON pair —
plus `alert-triangle` both · `settings` default. Removal glyphs `⊘` stop-sync · `⌫`
leftover. Status-bar remote counts use `⇡ ⇣` (text, matching the pill colors); navigation
is `› ‹`; the sidebar's device↔store relation renders `↔`; strips/banners close with
Lucide `x`. New UI must reuse this vocabulary rather
than invent synonyms.

## 3. Copy principles

- All user-facing copy is written from the user/product perspective, never the
  implementation's.
- Forbidden implementation vocabulary in copy: scope, carrier, mask, self group, ledger,
  shared list, compiled, registry, delta, schema, fleet, switch list, sidecar. The Sync
  Center's unified grammar (2026-08-06) binds all copy to three nouns only — `this device` /
  `your other devices` / `the store` — no invented synonyms for any of them. Use device
  narrative ("on for your other devices", "off on this phone") and consequence narrative
  ("Apply would turn it on here too") instead.
- **One concept, one word** (spec `2026-08-11-v3-one-vocabulary-design.md` §1). `scope` was
  forbidden in copy above and is now retired from the code as well, because it meant three
  different things — the settings area, the item family, and the sharing rule — depending on
  where you stood. The words, everywhere: **section** (which family an item belongs to;
  `obsidian` · `core` · `community` · `beta` · `custom`) · **sharing** (who shares a value) ·
  **device** (which devices something runs on) · **mode** (how a file is handled) ·
  **element** (one entry of an on/off list) · **action** (what an item needs right now) ·
  **type** (`file` · `folder`, never `dir`). Both search bars type `section:`; there is no
  alias for the retired `scope:`. A synonym for any of these is a defect, not a style choice —
  and so is the same word ANSWERING differently in the two boxes: `section:custom` finds a
  custom rule in either one, the settings panel adding its own area word (`advanced`) rather
  than substituting it.
- Anchor to established product terms: Apply, Capture, the store, Sync Center, "your other
  devices". Don't invent synonyms.
- Controls state their click consequence; recommended options give their reason ("matches
  where it's used today").
- Error/diagnostic copy is a separate tier: KEEP actionable technical detail (paths,
  params, status codes) and always give a next step; strip only pure-internal jargon.
- No emoji in copy; icons are Lucide via `setIcon` or the established text-glyph
  vocabulary (§2.3/§2.4).
- Mockup copy is final copy — review it to this standard at mockup time.

## 4. Component library

Class prefix → role (all in `styles.css`, rendered from `src/ui/SyncCenterView.ts` unless
noted):

- **Pills** `config-sync-pill` (is-up/down/ok/none/neutral/warn/error/statenote) — counts and
  states; never interactive. **Filter pills** `config-sync-fpill` in `-fpillrow` — buttons;
  long/short label spans; mobile = glyph form, one line. Shared with the settings search's section pills.
- **Sidebar** `config-sync-side-item/-side-badge/-side-head` — sections with tiny count
  badges; active = accent tint. The Config Sync self layer leads as a distinct hero card
  `config-sync-side-self` (`-side-self-ic` icon tile, `-side-self-title`/`-side-self-sub`,
  `-side-self-pill` reusing `selfStatePill`), echoing the header self-chip. **Switcher**
  `config-sync-switcher` — compact replacement.
- **Rows** `config-sync-hub-row` — the unified grammar's one-object-one-row shape (spec
  `2026-08-06-sync-center-unified-grammar-design.md` §1/§3, extended to companion families
  by `2026-08-07-c-livetest-batch5-companion-dissolve.md`): chevron, name (`-rule-name`),
  fate chips (`config-sync-fatechip`, rendered only when a fact deviates from default —
  `not installed here` · `desktop only` · `stays off` · `off here — your rule` / `on here —
  your rule` · `encrypted` · a folder path chip · `your choice` once a conflict is
  resolved; every chip renders icon + text, §2.3), a spacer, then the fate sentence
  (`config-sync-fate-text`: direction glyph + verbs describing everything the run will do to
  this row — the full verb table lives in the spec, not duplicated here), and last the
  checkbox. **The checkbox has one meaning everywhere:** include this row in the next
  Apply/Capture run; selection never changes what would happen, only whether it happens. It
  is direction-colored (orange capture / accent apply, §1.1) like every other checkbox, and
  hidden entirely on inert rows (in-sync / nothing-yet / unresolved conflict). Expanding the
  row (ledger C-#9) hides the fate sentence/glyph — the card's own `On apply`/`On
  capture`/`State` row becomes the single statement while open; chips and the checkbox stay.
  **Containment (spec 2026-08-09-c-livetest-batch20-chips-and-containment.md §0, global,
  every platform):** names and section titles never truncate or ellipsize; chips never wrap
  or clip — a row's chip GROUP degrades together to icon-only + tooltip once it overflows,
  never a mix of full and icon-only chips; the fate sentence is the only sacrificial
  element, ellipsizing first and giving way to the bare direction glyph at minimum —
  chevron, checkbox, and count pill never shrink. **Mobile row skeleton (batch-21, revising
  batch-20's ≥2 rule):** line 1 is always exactly chevron + name + spacer + sentence +
  checkbox; ANY chip-bearing row (1+ chips) moves its chips to their own indented second line
  under it (never a third line — the whole chip group degrades to icon-only + tooltip
  together instead) so line 1 never carries chips and chipless rows stay single-line either
  way.
  **The object is the family:** a parent item plus every companion group it owns
  (Appearance's `themes`/`snippets` presets, or any item's Settings-drawer `+ Add folder`
  companions) collapses into the parent's row — one row per family, never one per
  companion. When companions contribute file changes the fate sentence joins the parent's
  settings verb with the folder verb (`Applies settings · applies N files` / `Captures
  settings · captures N files`, the same ` · ` join as the install/turn-on sequence);
  Appearance's override sentence (`Applies theme & snippets — live` / `Captures theme &
  snippets`) still replaces the joined pair outright, unchanged. A conflict on any member,
  or actionable members split across both directions, renders the family `⚠ Changed on
  both sides` and reuses the existing Resolve grammar (`Use theirs ↓` / `Keep mine ↑`) at
  family level — no new controls. Custom `+ Add folder` groups are not companions and stay
  their own object, rendering a plain label with no breadcrumb (`parentCardLabel`,
  `registry.ts`, never consults `settings.items.custom`). The legacy `enabled-css-snippets`
  switch list is likewise out of scope, unchanged — it keeps the two-tone `Parent › `
  breadcrumb (`-rule-parent` + `-rule-parentsep`, `--text-faint`, `renderRuleName`,
  `SyncCenterView.ts`) ahead of the plain label, the same as any real companion. Inside the
  object grammar itself the breadcrumb survives in exactly one
  place: an orphan companion (its parent group not compiled locally) falls back to its own
  standalone row, breadcrumb included, as honest degradation — every other companion
  dissolves and is never its own row. (The breadcrumb also survives, outside the object
  grammar, in Settings drawers and run reports — unchanged.)
  The pinned Config Sync self row (`.is-self`, Community section) is the one exception: no
  checkbox (it isn't staged through Apply/Capture), its own fate text reads `your Sync
  Center — manages itself`.
- **Checkboxes** — custom-drawn inputs (hub-row/mainbar/section-head): direction-colored
  when a row (orange capture / accent apply), bright grey (`--text-normal`) for
  select-alls (they carry no direction); idle select-all hides (`-selectall-idle`).
- **Action bar** `config-sync-actionbar` — staged count + solid direction buttons
  (`-btn-capture` orange; Apply = `mod-cta`); 0-item = same color at 0.5 opacity; btnwrap
  hosts the 2px progress bar + shimmer; `-runline` is the live status line.
- **Type sections** `config-sync-card`; the list is four fixed sections
  (`config-sync-section.is-typesection`), fixed order, alphabetical within: `Obsidian` ·
  `Core plugins` · `Community plugins` (the Config Sync self row pinned first) · `Your
  folders`. The old availability sections — on/off carrier cards in the main list,
  Disabled-on-this-device, Not-installed-on-this-device, per-row policy segments — have all
  dissolved into row state (chips + fate sentence, Rows above); only the store-orphan
  **Leftover** section (below) still keeps a colored dashed frame. A type section's own
  frame stays neutral — dashed when collapsed, solid when open — no drift-color borrowed
  from the old outdated/not-installed sections. **Body fill (C-#47):** the nested card stays
  unframed (`border: none`, `padding: 0` — same checkbox column as the main card, batch-3 ①)
  but regains its `--background-secondary` fill + `--radius-m` corners when open — pre-C, the
  main list itself was one such filled card with no section wrapper at all; the C rework
  turned every category into a section and stripped the nested card's own fill along with its
  frame, leaving rows bare on the panel background with nothing for the header to sit
  against. A collapsed section builds no card at all, so it has no fill either — nothing to
  suppress, the dashed empty frame already reads as closed. **Real collapse:** clicking the
  header (`config-sync-section-head`) toggles the section, remembered per section for the view
  instance's lifetime (survives re-renders, resets on view close); restored pre-C header
  typography (uppercase, letter-spaced, `--font-ui-smaller`, `--text-muted` — C-#47 lifted it
  off `--text-faint`, now that the head sits on the section's bare margin above the filled
  body rather than a flat, single-tone box; unmistakable as a header even with its trailing
  badge covered), `padding-bottom: var(--size-4-2)` separates the head from the body by
  material contrast alone (no hairline), disclosure triangle (▾ open / ▸ collapsed)
  scaled to the header size; a checkbox click on the header stages, anywhere else on the
  header toggles collapse. A trailing count pill reads `N of M` under a filter; Core/Community
  carry a header chip (`renderCarrierChip`, spec §6.3) reading `settings-2` + `synced` /
  `not synced` — **read-only since this release**: it used to be the on/off carrier's own
  configurable toggle (a popover offering `Sync on/off` / `Stop syncing on/off`), and now only
  jumps to the carrier's own Settings card, where that toggle lives (§2.5 above). Same shape on
  every platform — no mobile-only icon fallback, and never the toggle glyphs
  (`toggle-right`/`toggle-left`, retired with the write path they used to promise). On mobile the
  head stays one line — count pill compacts `N of M`
  to `N/M`, the per-section "N selected" hint drops (the section checkbox's checked/
  indeterminate state and the global footer already carry it). Section select-all/clear targets actionable visible rows only —
  excludes the self row, in-sync, nothing-yet, and unresolved-conflict rows. Per-section
  trailing fold lines (`config-sync-unchanged`) aggregate only their own section's `N in
  sync ▸` / `N with nothing to sync yet ▸`, expandable in place. Switching into a filter
  pill or a search hit auto-expands every section once, on that transition only, so a
  manual re-collapse during the rest of that filtered/search session still sticks. Group
  headers `config-sync-sect` (uppercase + hairline) — used in the run-report breakdown.
  The remote pane groups its diff entries with the same type-section head family as the
  main list, in a static variant (`is-static`: no chevron, no collapse, no checkbox, no
  carrier chip, default cursor). Head and entry rows are direct children here (no nested
  card the way the collapsible type sections have), so C-#47's body fill does not reach it —
  filling the whole static box (head included) would be a different visual pattern from main
  sections (head outside the fill there), an asymmetry the §8 mockup never covered and was
  never live-verified; remote panes stay exactly as they were before §8. Matching the real
  head-outside/body-filled pattern needs a body wrapper element around the entry rows (a
  `.ts` DOM change) — deliberately deferred, not this round's to make. Carrier divergence
  there renders as a pinned
  `On/off list · differs for N plugins ▸` line (`config-sync-remote-onoff`) whose
  expansion shows the per-plugin flips (`config-sync-remote-fliplist`) and the file diff.
  Companion families fold the same way here: companion diff entries merge into their
  parent's entry, each file re-pathed under a `<companion>/` prefix (e.g. `themes/Blue
  Topaz.theme.css`) and chip counts summed — one entry per family; a companion whose
  parent isn't known locally falls back to its own standalone entry (honest degradation,
  same rule as the carrier label fallback). On narrow phones a section head keeps its pills and the "N selected" hint on
  one line (`white-space: nowrap; flex: none`) — the title is the only element allowed to
  wrap.
- **Expanded card (Sync Center row)** `config-sync-itemcard` — bordered, left-indented under
  the row's name column and offset one notch from the section behind it, so it reads as one
  contained unit; row hairlines (`config-sync-card-fieldrow`) stay inside this box, never
  full-pane rules. Filled (`--background-secondary` + border + `--radius-s`) on its own; inside a
  section (now that the section body itself is filled, C-#47) the drawer drops a level instead —
  border + radius stay, background drops to none, so the hierarchy reads unambiguously box >
  filled section body > outlined drawer, never two equal-weight filled blocks stacked. Every row
  (`renderCardKeyRow`) is a fixed-width muted small-caps key
  immediately followed by its value — the key column is `flex: 0 0 15ch`, sized to the
  longest key (`After install`) so a key never wraps; the value cell takes the rest
  (`min-width: 0`, no fixed narrow width — ellipsis is a last resort, never a first one,
  while the row still has room). A row that builds no value renders nothing at all: no
  separator, no reserved height (ledger C-#5) — built off-DOM first, appended only once
  non-empty. **Mobile stacking (batch-21 spec §3, C-#43/#44):** each fieldrow's label and
  value stack vertically instead — label on its own line (same muted small-caps style) above
  a full-width value — CSS-only (`flex-direction: column`, the label span and value div are
  already siblings), fixing the narrow-viewport clipping this batch closes. Resolve's
  segmented control spans the full stacked value width on mobile, 50/50 (`flex: 1` per
  button, centered text) instead of content-sized, so neither option clips at 375px. Desktop
  keeps the fixed-label-column layout above, unchanged. Standardized row set, in this order, each omitted when not applicable: `On
  apply` / `On capture` / `State` (the fate sentence expanded to a full clause — install
  source, update versions, capture consequence) · `Files` (direction-aware entries, `+` /
  `↑` / deletion, `view ▸` / `diff ▸`) · `Resolve` (conflict rows only — segmented `Use
  theirs ↓` / `Keep mine ↑`) · `Default enabled on` (plugins whose carrier is synced) / `After install`
  (carrier not synced, row installs) / `Enablement` (carrier not synced, plugin installed
  but locally off — the fallback ladder's third leaf) · `Default settings sync` (the item's own file-level sharing rule) · `More` (icon-only deep-link into the Settings tab, scrolled to this item's own card — the whole sentence moved into its tooltip, no trailing `▸`) ·
  `Note` (honest runtime notes, e.g. Hotkeys' "Takes effect after an app reload"). While the
  card is open, the collapsed row's own fate sentence/glyph hides (ledger C-#9, Rows above)
  — the card's `On apply`/`On capture`/`State` row is the single statement; checkbox and
  chips stay. **The card footer's destructive `⊘ Stop syncing` button is gone** (spec §6.2):
  stopping a whole item's sync now happens on its own Settings card, one gesture, one home —
  reached from here only through `More`.
- **Two-segment row** (`config-sync-tsrow`, spec §6.1, `ui/enablementRow.ts`) — replaces the old
  icon-trigger-plus-menu `Runs on`/`Settings sync` rows (and their five-stop `RUNS_ON_ICONS`
  vocabulary, §2.3) with one shape reused by three surfaces: a Sync Center row's `Default
  enabled on`/`Default settings sync`, a plugin card's `Default enabled on`, and a carrier
  card's element rows (Unified card below). Four fixed tracks — `label | fleet segment |
  divider | local segment` — so every row on a card lands its icon and state word on the same
  vertical line. Fleet segment: icon + text, click opens an Obsidian `Menu` of the four values
  (`All devices` / `Desktop only` / `Mobile only` / `Each device decides`); icons are
  `sharingIcon`'s (§2.3), `users` for `Each device decides`. Local segment: following the
  default renders **no icon**, just a dim `Follows the default`; an exception renders its
  accent icon (`power`/`power-off` for an element, `circle-slash` for a whole file) + state
  word, click opens the local menu (`buildLocalMenu`/`buildFileLocalMenu`, §2.3). `After
  install`/`Enablement` keep their own textual triggers (`config-sync-menuchip
  config-sync-card-trigger` — no glyph vocabulary for them), restyled to the same trigger-box
  family so the card reads as one control language regardless of trigger kind. The Settings
  tab's plain field/file sharing cell is untouched where it has no local layer: it keeps the
  direct-cycle `renderSharingCycle` idiom (a click advances straight to the next option).
- **Enablement rule (per-plugin, per-element)** — one rule per list element (a plugin, a
  snippet), stored on the CARRIER item that carries the list, set from any of the three
  entrances above through the one pair of producers `ui/enablementRow.ts`/
  `core/enablementRules.ts` share (spec §6.6) — never from the plugin's own settings-file
  entry, which the rule no longer touches at all. This device's own exception for that element
  (`config-sync-device-elements`, never inside `data.json`) is the same row's local segment,
  everywhere the element appears. A carrier's own sync membership — whether the Core/Community
  on/off list is itself a synced item — is edited from its own Settings card's sync toggle
  (Unified card below), never from the Sync Center any more (the section header's chip is
  read-only, Type sections above). The snippets on/off list keeps its own member devices on the
  Appearance card (Companion folders, Unified card below) — same mechanism, same row shape,
  fewer surfaces because it has no carrier card of its own.
- **Remote** `config-sync-remote-btn` is-pull/is-push (solid cyan/pink when primary,
  dimmed otherwise); diff entries reuse report rows + chips.
- **Reports** `config-sync-report-*`, chips, `-strip` result strip — outcome-toned: green
  only when the run is clean, `is-warn` orange / `is-error` red otherwise; it sits in a
  sticky `-strip-dock` (opaque backing, pinned to the top of the scroll viewport) so the
  outcome survives scrolling.
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
  (`Config Sync — 2 to capture · 1 to apply · 1 to push`).
- **Self pane** (Config Sync's own state) `config-sync-self-pane` — `-self-title/-self-title-ic/-self-title-sp/-self-sub`, `-self-settings-btn`/`-self-settings-ic` (title-row Settings), `-self-block/-block-h/-block-s`, membership delta `-self-delta/-self-drow/-self-dg`, `-self-viewchange` (expandable `data.json` diff), `-self-pill/-self-hint/-self-caution/-self-acts`.
- **Qualifier autocomplete** `config-sync-qac/-qac-opt` (is-sel)/`-qac-ic/-qac-txt/-qac-desc` — the `key:value` search dropdown under both search boxes, anchored by `config-sync-search-wrap`; opens on focus (an empty box lists every key), key→value suggestions, keyboard-navigable. Logic in `src/ui/qualifierSearch.ts`.
- **Settings tab** (`src/ui/SettingTab.ts`): `config-sync-tabs/-tab` (phone hides inactive
  labels — the pattern the mobile filter pills echo), rows/expand/form-*, fields editor
  (`-fieldrow/-ftag/-act-btn`), remotes forms + `-test-strip`, search (`-hit/-sectiontag`),
  passphrase `-ppset/-ppbadge`. `config-sync-section-sub` — one subtitle per tab, above the
  Sync all row ("Each plugin syncs its settings and on/off state." for Core, "…its files,
  settings and on/off state." elsewhere), replacing the old per-row boilerplate description.
- **Modals**: pull-conflict `config-sync-cm-*` + `diffView.ts` (shared diff panel:
  Unified/Split toggle desktop-only, **Collapse/Full toggle both platforms** folding
  unchanged runs into `-cm-dgap` "⋯ N unchanged lines ⋯" rows); exclude-extras
  `-exclude-row/-modal-buttons`. Cold-start adopt is not a banner: the self pane (above)
  renders the coldstart state and drives it via `adoptConfiguration`.
- **Cold-start guidance banner** `config-sync-coldstart-*` (spec 2026-07-27) — accent-tinted
  banner above the result strip in item mode, shown only while the plugin's own settings are
  pending (coldstart/adopt/both) AND some group has never synced here (`showColdStartBanner`);
  "Review settings →" routes to the self pane; dismissal (Lucide `x`) is device-local and
  resets when self returns to insync. Adopt itself still lives in the self pane, never in the
  banner.
- **Leftover store files** — no filter pill (store orphans have no registry item, so they can
  never become a row in any type section): whenever the store has orphans, the always-open amber
  `config-sync-section.is-leftover` renders unconditionally under the unfiltered `All` pill
  (hidden while a filter or search narrows the view) — `-oflow` rows (name / mono path / size / a
  Delete text action), with "Delete all" in the head — both destructive text actions render per
  §1.1 (idle muted, red on hover). Its frame/title stay amber (state ≠ category, C rework rule);
  its nested card picks up the same C-#47 body fill as any other section, unaffected by the
  color accent (the fill lives on the card, the accent lives on the section's own border/title).
  Removal kinds in
  History render `⊘` (stop-sync) and `⌫` (delete-leftover), muted.
- **Unified card** (定稿 mockup artifact `v7-final-panorama`, 2026-07-25, plus the icon/
  progressive-disclosure pass in artifact `239c8393-cd61-4faa-95aa-e49f1804b446`, 2026-07-26; specs
  `docs/superpowers/specs/2026-07-25-unified-card-design.md` and
  `docs/superpowers/specs/2026-07-26-card-visual-refresh-design.md`) — replaces every earlier
  settings-tab shape (the per-switch-list `-ldrow` scope editor, the "Domain / companion"
  container row, `kind: "app-view"`/`"appearance-domain"` special-casing, the aggregate "Enabled
  community plugins"/"Enabled core plugins" rows) with ONE row + drawer renderer for every synced
  item (`SettingTab.ts`'s `renderItemCard`, driven by `registry.ts`'s `ItemDef`). No kind
  branches remain: an Obsidian option group, a core plugin and a community/beta plugin all
  render through the same function — a core plugin whose settings file hasn't been written
  here still gets the full card, since its path is synthesized from the plugin id.
  - **Row** `config-sync-item-wrap` — chevron, name, badges (`config-sync-card-badge*`, order per
    `computeBadges` — itemCard.ts): `on/off only` (no settings file here yet) → grey
    `desktop-only plugin` chip (manifest `isDesktopOnly`, monitor icon via `-badge-plat/-badge-ic`)
    → the enablement badge when non-default (`on: desktop` / `on: mobile` / `on: this device` — a
    local exception outranks the rule here, same precedence as at run time; `Each device decides`
    with no exception yet earns no badge, since the row itself is the answer) → for the TWO carrier
    cards, two counts in place of the ordinary `N device-scoped` badge (`carrierBadgeCounts`): fleet
    `N device-scoped` (class rules only — `Each device decides` hands the element to every device,
    so it is not "device-scoped") and local `N left to me` (this device's own exceptions, purple —
    the two-segment row's local segment wears the same color when set) → `N encrypted`; a zero count
    never renders), sync toggle. No mode chip and no other row content — mode is a derived, drawer-only
    state (`itemCard.ts`'s `deriveMode`, see Drawer ② below), never a header control — the same
    terse rows-are-lists-nothing-else rule the Sync Center already follows.
  - **Drawer** `config-sync-item-exp`, up to three zones, every row across all three built on one
    4-column grid (`config-sync-grid`: content `1fr` | sharing `var(--cs-scope-w, 28px)` | state
    `28px` | action `28px`; action-column icons are `config-sync-ghost`, faint 0.25 idle, full on
    the row's `:hover`/`:focus-within` or `.is-active`, so the grid stays quiet until touched).
    Every sharing control in a drawer is one Commander-style cycling icon
    (`config-sync-sharingicon`, `renderSharingCycle`): the glyph IS the state (`sharingIcon`:
    monitor+smartphone = All devices, monitor = Desktop only, smartphone = Mobile only,
    airplay = This device), a click advances to the next value in that row's own option list
    (`nextSharing`, wrapping), tooltip `Where it syncs (currently: …)`; the `all` default sits dim
    (0.45) and any narrower sharing renders `.is-set` (accent, full opacity). ① and ②
    render only when they apply, ③ Companion folders always renders (down to just its quiet
    `+ Add folder` row, `config-sync-add-row-quiet`, when a card has no folders yet):
    ① **Default enabled on** (plugin cards whose def carries an `enablement` projection — spec §6.5)
    — the two-segment row (`ui/enablementRow.ts`, above), not a cycling icon: the fleet segment
    writes the carrier's `perElement` rule (`core/enablementRules.ts`, never this plugin's own
    settings-file entry); the local segment writes this device's own exception
    (`core/deviceElements.ts`, never inside `data.json`). Three shapes (spec §6.5): a class rule
    (`Desktop only`/`Mobile only`) shows only `Follows the default` in the local segment — no
    editable local state, since one would claim a device answer the sync itself decides; `All
    devices` with a local exception set shows the purple `On here`/`Off here`, editable; `Each
    device decides` shows the local state directly, no `Follows` option (there is no shared answer
    to follow) — landing on it for the first time seeds the exception with the plugin's CURRENT
    state (`ruleLandingNeedsSeed`), so switching to it never itself flips the switch.
    ② **Settings file** — mode is derived, never chosen: no per-key rule anywhere (`rules` and
    `perElement` both empty) is whole-file state, any rule is per-key state. The grid's first row
    (`config-sync-card-sfhead`) is always the path row: path code, a 3-option sharing icon (no
    `This device`) and a lock icon toggle (`config-sync-lock`, `.is-on` when encrypted) that
    encrypts the whole file. The path text itself is the edit entry point
    (`config-sync-card-pathbtn`, hover = dotted underline + soft backdrop; `.is-custom` accent
    once a custom path is committed): click it and the row swaps to an input — Enter/blur
    commits, Escape cancels via a keymap `Scope` pushed while the input is focused (Obsidian's
    own Escape handling would close the settings window otherwise), and a committed custom path
    shows a quiet `Reset to default` text action (`config-sync-reset-link`, registered on
    mousedown so the input's blur-commit can't tear it out first) inside the edit row. In
    whole-file state the path row's sharing/lock are live; in per-key state they render
    `config-sync-dim` and disabled (tooltip "Per-key rules are active — remove them to control
    the whole file again"), and a rule row (`config-sync-card-rulerow`) appears per configured
    key — never every key in the file, only ones with a rule; browsing the rest is File
    preview's job (below) — each with its own sharing icon, a lock toggle (disabled at `This device`
    or while `Per-item device rules` is on) and a ✕ (`Remove rule`) that deletes it; a string-array
    key adds a `Per-item device rules` toggle (`config-sync-card-perelement`) — flip it on and each
    element gets its own row (`config-sync-card-elrow`) instead of one rule for the whole key.
    Removing the last rule flips the card back to whole-file state. Below the rule rows, a
    collapsed disclosure (`config-sync-card-disclosure`, `▸ File preview` / `▾ File preview`)
    expands into the read-only `data.json` preview (`jsonView.ts`) — collapsed by default, so a
    card with no rules never reads its file at all — keys colored by rule, a color-dot legend (`config-sync-legend-dot`, round-7 定稿 B)
    underneath, a lucide `lock` (`config-sync-json-lock`) marks an encrypted key,
    `--color-purple` = detected-but-unruled, faint = plain; a `perElement` array colors each
    element the same way. Click a key to add a rule for it directly (promotes the card to
    per-key state).
    Between ② and ③, the two carrier cards (`core-plugins`/`community-plugins`, spec §6.4) add one
    more zone — `carrierListFor(def)` is what makes a card a carrier, and is the one place that
    identity is decided: a section label `CARRIER_ELEMENTS_LABEL` = "Which devices turn each
    plugin on", then one two-segment row per element (`buildCarrierElementRows` —every element
    installed here, plus any element that carries a rule or a local exception even if it isn't,
    since an uninstalled plugin's fleet choice still needs a card to live on), each row identical
    in shape to zone ①'s single row above, sorted by label. The snippets on/off list has no card
    of its own — same row shape, same producers, rendered inside the Appearance card's `snippets/`
    companion folder (③ below) instead.
    ③ **Companion folders** — preset (`themes/`, `snippets/`) and user-added vault-relative
    folders, each on the same grid (`config-sync-card-companiongrid`): content column is the path
    plus a collapsed member count (`config-sync-card-membercount`: `· N themes` for the themes/
    preset, `· N files` otherwise) and a ▸/▾ arrow (`config-sync-card-memberarrow`) — click the
    row to expand its member list, while the folder name itself (same `config-sync-card-pathbtn`
    affordance, click/keydown stopPropagation so it never doubles as the member toggle) opens the
    Save/Cancel path-edit row (autofocused; Escape cancels via the same keymap `Scope` as the
    settings-file path row); sharing icon + sync toggle in their own columns; the action column
    holds only a ✕ (`Remove folder`) on a user-added row (a preset is only ever relocated via
    the warning-gated path edit, never removed outright). A trailing quiet `+ Add folder` row
    (`config-sync-add-row-quiet`, no longer a full-width button) closes every card (a card with
    zero rows renders no `Companion folders` header, just the Add-folder row). Opening
    `snippets/` lists members (`config-sync-card-snippetmembers`), each its own sharing icon — it
    writes `enabledCssSnippets` AND decides whether the file itself travels — the only companion
    whose members carry a sharing control; a plain (unmapped) folder's members list for
    information only (`ItemDef.presetCompanions` has no per-member carry mechanism today — a
    future engine iteration, not this one). A member whose file has been deleted but still holds a
    device choice is an orphan row (`is-orphan`): its name renders struck faint
    (`.config-sync-card-companiongrid.is-orphan .config-sync-ldname`), a `file deleted` pill
    follows it (`config-sync-orphan-forget`'s **Forget** button sits at the right edge of the
    content cell — inside `config-sync-orphancell`, never in the 28px action column, which a
    text button cannot fit; the action column stays empty). Forget clears the
    choice (sharing → everywhere) and rebuilds the member zone in place — the sharing icon itself stays
    interactive, since keeping the choice is a valid response to a transient absence (mid-sync).
    The member count (`config-sync-card-membercount`) counts real files only. While any orphan row
    is present, a warning-toned hint (`config-sync-ldhint config-sync-orphanhint`, `--text-warning`)
    renders above the always-on `SNIPPET_MEMBER_HINT`, explaining the Forget affordance.
  - **Release notes** (binding for this cut): the store AND the settings schema both break —
    `schemaVersion: 2` has no migration from any earlier `data.json` shape, and the store gains
    whole-file-encryption envelopes alongside the existing `__scopes__` sidecars. Hand-written
    release notes must say **all devices upgrade together, then reconfigure which items sync** —
    this supersedes and folds in every earlier partial-compatibility clause (the phase-1
    `memberScopes` window, the phase-2 `__scopes__` sidecar note) into the one blocking statement.

## 5. Conventions

- Theme variables only; the no-hardcoded-color script is a release gate. Alpha via
  `rgba(var(--*-rgb), α)`.
- Mobile scoping: `body.is-mobile` for panel rules, `body.is-phone` for settings-tab
  layout collapses (phones only; tablets keep desktop settings layout).
- Every UI change: mockup → 定稿 → implement → dev-vault probe/screenshot verification
  (desktop + 390×844 emulation) → gates. Alignment claims are probed, not eyeballed.
- Copy: sentence case; "selected" not "staged"; idle states render nothing.
- New icons come from Lucide via `setIcon` or the glyph vocabulary (§2.4); no emoji in
  chrome (they ignore theme colors) — see Findings #2 for the remaining ones.

## 6. Audit findings — 2026-07-18 (decisions pending)

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
   are all removed. Remaining, still open: eleven TS-only classes with no CSS rule
   (`-flock` has since grown a real rule and is off this list). Three are undecided:
   `-beta-mapnote`, `-remote-comparing`, `-cm-unified` — decide whether they get styles or
   stay as semantic hooks. Four, found on re-audit, are structural query/layout
   anchors, deliberately unstyled: `config-sync-card-companionzonehost`
   (SettingTab.ts:723,1330), `config-sync-card-memberhost` (SettingTab.ts:1291),
   `config-sync-card-sfbodyhost` (SettingTab.ts:697,777), `config-sync-cm-diffhost`
   (ConflictModal.ts:149). Four more are semantic/structural wrappers found on this
   re-audit: `config-sync-remote-pane` (SyncCenterView.ts:2178), `config-sync-remote-summary`
   (SyncCenterView.ts:2251), `config-sync-settings-body` (SettingTab.ts:443),
   `config-sync-sources` (SettingTab.ts:2584).
2. **Emoji remnants**: the self-pane title (`config-sync-self-title-ic`) converted to
   Lucide state icons (see §2.4) — no longer a candidate, like `-flock`, which shipped its
   Lucide `lock` replacement (SettingTab.ts:1752-1753, styles.css:787-788). Remaining
   text glyphs: ＋/＝/⌂ and the ⚠/✗/✓ status set (↺ is gone from the code, and the History
   card pill's ✎ was removed in the 2026-07-29 polish pass). The panel purged emoji (mode badges,
   locked state) because they ignore theme color; the remaining pure-text glyphs render
   monochrome and can stay.
3. **Micro px font sizes** (9.5–10.5px: side badges, ftag, act-btn, sect-count, seg-label,
   cm-kind, cm-viewbtn): below `--font-ui-smaller` and not theme-responsive. Options:
   normalize to `--font-ui-smaller`, or bless a documented "micro" tier. (Checkbox pseudo
   12px marks are geometry-tied; keep.)
4. **Text-on-fill variable split**: accent fills use `--text-on-accent`, orange/cyan/pink
   fills use `--background-primary`. On themes with a light background-primary + light
   accent text these diverge. Candidate: `--text-on-accent` everywhere.
5. **Nine border-radius tiers** (3/5/6/8/9px + s/m + 999 + 50%): candidate collapse to
   `--radius-s`/`--radius-m`/999/50% + checkbox 3px/6px. Visual churn — low priority.
6. **`.config-sync-fpill` double duty** (panel filter pills + settings search section pills):
   intentional sharing, but a settings-side tweak can silently restyle the panel. Candidate:
   document as shared (this doc) or split the class.
