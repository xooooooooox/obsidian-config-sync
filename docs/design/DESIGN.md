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
| Settings-drawer row grid (定稿轮 19; anchors 轮 20 ②乙; SLOTS 轮 21A) | Every row in an item card's drawer is a `.config-sync-scrow`: `identity 170px \| controls 108px \| divider 1px \| detail 1fr`. The controls column is a fixed THREE-SLOT grid (`.config-sync-scrow-slots`: aux 24 \| lock 24 \| device 44) — same-type controls sit in the same slot on every row, so eyes, locks and device pickers each form a strict column card-wide; a row without a control leaves its slot empty. Slot roles: aux = the File-preview `eye` (path row) or the per-item `list-checks` (array rule rows); lock = encrypt toggles; device = every scope/rule picker, LAST so it sits beside the divider/`THIS DEVICE` column (#156 "icons shouldn't be that far apart"). STATE controls (a folder row's sync toggle) still right-anchor on the card-toggle rail via `.config-sync-scrow-end`. Member-row indent lives on the name inside the identity cell, never on the row. The old 4-track `.config-sync-grid` is deleted. |
| Path row (轮 21A, #154/#155) | Zone ②'s path row is TWO scrow lines inside the `.config-sync-card-sfhead` container: line 1 = the `SETTINGS FILE` label + the slots cluster (`👁 → 🔒 → 🖥⇕`, strictly on the label's own line — the old two-line identity cell left the cluster vertically centered *between* label and filename, anchored to neither); line 2 = the filename spanning the full card width (`grid-column: 1 / -1`), so `plugins/<id>/data.json`-length paths never wrap (#155/#157). The filename keeps its click-to-edit behavior; the edit input takes the full-width line. |
| 眉标字体 (轮 20 ①) | `.config-sync-tworow-eyebrow` is the SAME type as the row labels (`--font-ui-smaller`, 0.05em tracking, `--text-muted`) — the 10px/0.04em/faint variant is gone; purple on a set exception lives on the SEGMENT alone. | one uppercase label style across a row (#148: label and eyebrow read as two fonts) |

## 2. Icon set

### 2.1 State column (`.config-sync-state-icon`, text glyphs + one SVG)

Action states carry dedicated Lucide icons (via `setIcon`): capture `arrow-up-from-line`/orange,
apply `arrow-down-to-line`/accent, push `cloud-upload`/pink, pull `cloud-download`/cyan
(`src/ui/actionIcons.ts` is the single source). Status glyphs stay text: `≠` differs/faint ·
`—` miss/faint · `○` no-settings/faint · `✓` ok/green · `?` unknown · **key** (`key-round`)
locked/cyan. This is `.config-sync-state-icon` specifically (a Statistic-workspace/switcher
vocabulary) — it is UNRELATED to a collapsed item row's own neutral (`—`-glyph) fate, which round
12+13 ③ moved onto the fold family's icons instead (below).

**Direction arrows say which side, once, per surface** (round-11 ③ restores the pre-C 2.x FILES
vocabulary that round-10 ②'s SVG-everywhere sweep briefly erased): the surfaces that say "this
goes up/down" are the header pills, a collapsed row's fate glyph, and — new this round — the
FILES row's own track-2 direction badge (`arrow-up-from-line` orange / `arrow-down-to-line`
accent, tooltip `These changes land in the store` / `These changes land on this device`). A
FILES *entry* itself never carries a direction glyph: it speaks the diff-kind family `+` (green,
added) / `~` (blue, updated) / `−` (red, strikethrough, deleted) in BOTH directions — round-10
②'s capture-side collapse to a single `↑` was an undocumented C-rework change that erased the
new/updated/removed distinction, which is real information a user loses without it (a new store
file starts syncing to your other devices; a removal removes it everywhere). Each entry's
`aria-label`/hover carries the side+consequence sentence instead (the tooltip `fileEntryFor`
produces, `src/ui/panelModel.ts`, exported as named constants so the icon-collision guard and
tests share the producer): capture — added `New in the store — starts syncing to your other
devices`, updated `Store copy updated`, deleted `Removed from the store — removed from your
other devices`; apply — added `New on this device`, updated `Changed on this device`, deleted
`Deleted from this device`. Changing how ONE surface draws an arrow means sweeping the
row-level list above, not the FILES entry vocabulary — they are deliberately two different
vocabularies now, not one collapsed onto the other.

C-#50: the Sync Center's trailing-fold summary lines (`✓ N items in sync` / `⊘ N not synced on
this device` / `○ N with no settings yet`) are a DIFFERENT vocabulary from this text-glyph state
column — canvas-metrics found the text glyphs optically unequal across themes (font-fallback ink
weight), so those three states moved to fixed-size 12px Lucide instead (§2.3). This state column
itself is untouched.

Round 12+13 ③ (supersedes the old "ROW state column stays text" ruling `foldIcons.ts` used to
carry in its own header comment — this DESIGN section is the authority, not that comment): a
collapsed item row's NEUTRAL fate (`—` glyph — `In sync` / `No settings yet` / `Not synced on
this device`) reuses the fold family's own `FOLD_ICON`/`FOLD_ICON_COLOR_CLASS`
(`foldIcons.ts`) at the row's own `.config-sync-fate-ic` size/placement instead of rendering the
sentence as text — the fold kind is derived from the `Fate` the row already carries
(`fate.nothingYet` → `nosettings`/`circle`, `fate.excluded` → `excluded`/`circle-slash`,
else → `insync`/`check`), aria-label = the sentence, unchanged. Same reuse on the remote
diff pane's own opted-out row (`renderRemoteDiffEntry`) — every ROW-level instance of these
three sentences renders this way now, not just the collapsed main-list row. The `⚠` conflict
fate is UNCHANGED — it keeps its text glyph + sentence, since a conflict must shout and has no
action icon to become. A fold-group HEADER line (`53 items in sync`, the C-#50 summary above)
keeps its own pre-existing text+icon form untouched — this ruling is about the ROW, not the
group header. Chips are unaffected.

### 2.2 Mode badges (`.config-sync-mode-badge`, 12px, `--text-faint`)

Mode display names (轮 21D — the stored ids `plain`/`fields`/`encrypted` never change):
**Whole file / Per-key rules / Encrypted** (`MODE_LABELS`, itemCard.ts). "Plain" and "Fields"
were implementation words; "Per-key rules" is the drawer's own vocabulary for the same state.

- encrypted → Lucide `lock`; tooltip "Encrypted — the whole file is stored encrypted".
- fields → custom `drawFieldsBadge` SVG (three field lines + corner padlock; no Lucide
  composite exists); tooltip "Per-key rules — only the chosen keys are filtered/encrypted".
  定稿方案 B 2026-07-17. plain → no badge.

### 2.3 Lucide usage (setIcon)

`refresh-cw` ribbon + both panel refreshes + status-bar item · `lock` mode badge ·
`lock-open` the encrypt toggle's rest state (轮 23 ②: unencrypted-but-available — a closed lock
there read as already-encrypted; closed `lock` stays the ENCRYPTED state everywhere, toggle
on-state and pure state markers alike) ·
`key-round` locked state · `chevron-down/right` settings rows · `x` clear/remove ·
`trash` delete · `folder-open` browse · `rotate-cw` BRAT re-scan · `arrow-up-from-line` /
`arrow-down-to-line` / `cloud-upload` / `cloud-download` sync-action icons (the first two
double as the self-pane title's capture/coldstart states, with `alert-triangle` both and
`settings` default — see §2.4) · tabs: `settings`,
`gem`, `toy-brick`, `puzzle`, `flask-conical` (BratIcon preferred when registered),
`wrench`, `git-branch` · `monitor` / `smartphone` — `sharingIcon`'s Desktop only/Mobile only
stops (every sharing picker) and the row-level
desktop-only-plugin badge (`config-sync-card-badge-plat`, itemCard.ts) · `airplay` —
`sharingIcon` "This device" stop, used ONLY for a plain field/file rule's picker (no local
layer to speak for). **The click-to-cycle idiom is retired (定稿轮 16甲):** `renderSharingCycle`
(sharingCycle.ts) is deleted outright — every sharing/rule control in the Settings tab now opens
an Obsidian `Menu` instead of advancing on click, through `SettingTab.ts`'s own
`renderSharingPicker` (the vocabulary model — `sharingIcon`/`nextSharing`/`sharingCycleTooltip` —
stays in itemCard.ts; `nextSharing` keeps its own unit tests as a pure function even though
nothing renders through it any more). Every Settings drawer sharing cell — the settings-file
row's whole-file sharing, a rule row's/array-element's per-key sharing, a companion folder's
device class, a plugin card's `Enabled on` fleet segment, a carrier element's fleet segment —
is a picker now: icon + a small muted `chevrons-up-down` PICKER affordance, click opens a `Menu`
listing `options` with icons + a checkmark on the current value (§2.4). `iconFor`/`labelFor`
select the vocabulary; the enablement rows (`Enabled on`, carrier elements) pass
`ruleIcon`/`ruleLabel` (`enablementRow.ts`) — the SAME producer the Sync Center's own `ruleMenu`
reads, so both entrances offer identical wording — everything else falls back to
`sharingIcon`/`sharingLabel`. A disabled cell (the settings-file row's per-key-rules-active
state) keeps the old dim, non-interactive rendering: no chevron, no menu. `monitor-smartphone` —
the "All devices" stop.

**The two-segment row** (spec `2026-08-12-enablement-two-layers-design.md` §6.1, round-9 ②/⑤
icon-only revision, `ui/enablementRow.ts`): `label | fleet segment | divider | local segment`,
shared by a Sync Center row's `Enabled on`/`Settings sync` (shortened from `Default enabled
on`/`Default settings sync` — the word "Default" moved into the fleet segment's own tooltip), a
plugin card's `Enabled on`, and a carrier card's element rows — replacing the old `Runs
on`/`Settings sync` icon-trigger-plus-menu rows and their `RUNS_ON_ICONS` vocabulary outright.
Both segments are icon-only now, glyph + a small muted `chevrons-up-down` PICKER affordance
(round-12: was text `▾`), no visible wordmark. Fleet
segment: `sharingIcon`'s icons for the three device stops, plus `users` for `Each device decides`
(**never** `airplay` here — the value is about the fleet's arrangement, not this device, and
`airplay` reads as screen mirroring to a reader who hasn't read the source); tooltip
`Default enabled on: <ruleLabel>` / `Default settings sync: <sharingLabel>`. Local segment: a
muted "this device" eyebrow beside its own glyph, one for EVERY state now — `corner-down-right`
while following the default (round-9 ②: it used to render no glyph at all here, since a default
had nothing to say, but a bare wordmark beside an icon+chevron fleet segment read as unfinished)
· `power` / `power-off` for an element-level local exception (**On here**/**Off here**) ·
`circle-slash` for a whole-file local opt-out (**Not synced here**, reused from the fold family
below — same meaning, "not synced on this device," deliberately); tooltip `This device: <state>`
(`follows the default` / `on here` / `off here` / `not synced here`). Click on either segment opens
an Obsidian `Menu` (never cycling; `ui/enablementRow.ts`'s `buildLocalMenu`/`buildFileLocalMenu`
are its one producer each — unchanged this round, they still label the MENU ITEMS, which is a
different string from the segment's own tooltip).

`settings-2` — the sidebar Config Sync
self-entry tile, the compact switcher's self entry, the self pane's title-row Settings
button, the read-only carrier chip (§2.5 below), and the Sync Center card's `More` row — an
icon-only deep link into the item's own Settings card (tooltip carries the sentence, no trailing
`▸`; **never** `sliders-horizontal`, which already means `your rule` in the fate chips below) ·
`arrow-left-right` — the Sync Center leaf/tab icon ·
`chevron-right` — qualifier-autocomplete key rows (value rows use `check`, §2.4) · fate chips
(`config-sync-fatechip`, `FATE_CHIP_ICON` in `fateChipIcons.ts` — icon-ONLY since 定稿轮 20 ④,
the chip sentence in the tooltip; text renders only as the loud fallback for an unmapped
string): `circle-dashed` not installed here ·
`monitor` desktop only · `sliders-horizontal` your rule / off here — your rule / on here — your
rule · `power-off` stays off (**not** `power` — `power` now means "this device turned it on" in
the two-segment row's local segment, so a chip saying the row stays OFF cannot share it) · `lock`
encrypted · `check` your choice · trailing-fold states
(`config-sync-fold-ic`, `FOLD_ICON` in `foldIcons.ts`, C-#50): `check`/green in sync ·
`circle-slash`/muted not synced on this device · `circle`/muted no settings yet — the SAME three
(same producer, `config-sync-fate-ic` sizing) also render a collapsed item row's own neutral fate
now (round 12+13 ③, §2.1 above).

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

**Round-11 additions:** `file-diff` — the FILES row's per-entry trailing affordance, "view this
entry's changes/content" (§4 Files bullet above); registered by hand in the icon-collision
guard (`tests/fateChipIcons.test.ts`'s `EXTERNAL_HOMES`, same treatment as `settings-2`) since
it sits behind no exported table. The diff panel's own segmented toggles (`diffView.ts`) are
icon+tooltip now, form and active-segment highlighting unchanged (two segments, active
highlighted): `rows-2` unified diff (tooltip `Unified diff`) · `columns-2` split diff (tooltip
`Split diff`) · `fold-vertical` collapse unchanged lines (tooltip `Collapse unchanged lines`) ·
`unfold-vertical` show all lines (tooltip `Show all lines`) — the labels that used to sit on the
buttons (`Unified`/`Split`/`Collapse`/`Full`) now live in the tooltips only.

**Round-12 additions (the text-triangle sweep, §2.4 below):** `chevron-right` — the FOLD family's
one glyph, rendered by the shared `renderFoldChevron`/`setFoldOpen` helper (`ui/foldChevron.ts`)
and rotated 90° via CSS when open; every "expands in place" site in the app (Sync Center section
heads, fold-group/self/item rows, the run-strip's `details`, the self pane's `view change`, the
Settings tab's rule/remote rows and its member-disclosure arrow, the conflict modal, the report
strip's per-result rows) now shares this one glyph instead of swapping `chevron-down`/
`chevron-right` or setting text. Already registered for a different meaning (qualifier-autocomplete
key rows, §2.3 above) — the two uses never collide because a key row never toggles open/closed, so
this is a deliberate one-glyph-two-contexts reuse, not tracked as a collision. `chevrons-up-down` —
the PICKER family's one glyph ("opens a menu/list to choose one of N"): the two-segment row's
fleet/local segments and every plain sharing/rule picker (`config-sync-tworow-chev`, one class,
every site — `renderSharingPicker`/`renderLocalSegment` in SettingTab.ts and their SyncCenterView.ts
counterparts all paint it) and the compact switcher (`config-sync-switcher-chev`), replacing the
old muted `▾` affordance and the switcher's `▾`/`▴` flip; small (~11px in-row, ~13px switcher).
**⇕ hover-reveal (定稿轮 14b/16乙):** `config-sync-tworow-chev` is invisible at rest (`opacity: 0`,
constant layout — never a horizontal shift) and reveals on two triggers — the containing ROW's
hover (`.config-sync-scrow`/`.config-sync-cardrow`, the two places this glyph lives — the
Settings drawer's scrow replaced `.config-sync-grid` in 定稿轮 19) or while its
own trigger's menu is open (`.is-open`, set by `wireMenuTrigger` in both SettingTab.ts and
SyncCenterView.ts and cleared via `Menu.onHide`), which also turns it accent-colored — the SAME
open-state language the switcher already had. The menu-open selector is `.is-open >` with a
CHILD combinator (轮 18 bugfix): `.is-open` doubles as fold state on far ancestors (an expanded
`.config-sync-section`), and a descendant match lit every ⇕ inside an expanded section
permanently — the ⇕ is always a direct child of its own trigger, so the child combinator is
exact. A DISABLED picker (`.config-sync-dim` on the sharing icon — the settings-file row while
per-key rules own the file) still renders its ⇕ span (轮 23 #166 ①): constant layout is a WIDTH
promise too — a picker box without the ⇕ is 14px narrower, and the centered device slot then
drifts its icon out of the column every enabled picker aligns to. The dim picker's ⇕ just never
reveals — a suppression rule after the hover-reveal keeps it at `opacity: 0` on row hover (it has
no menu to open, so `.is-open` can't light it either). Mobile (`body.is-mobile`) hides it entirely, no
hover to reveal it there; the compact section switcher's own `config-sync-switcher-chev` is the
one deliberate exception, staying always visible on every platform (it is the sole entrance to
the section list on mobile, where the sidebar is gone). **The hover-reveal belongs to the ⇕
glyph ALONE (定稿轮 18, overturning 轮 17④):** extending it to a two-segment row's whole local
cell — eyebrow + glyph + divider appearing and vanishing with the row's hover — was tried and
rejected (#139/#140): a whole cell that materializes on hover reads as missing content at rest,
on every surface. State (the local cell, the divider) is always visible; only the affordance
hint (⇕) is hover-dependent.
**Quiet-rest (定稿轮 24 甲, #167):** every CLICKABLE icon control rests at `--text-muted` ×
`opacity: 0.45` and lifts to `opacity: 1` on its own hover/focus-visible or while its menu is
open (`.is-open`); an ACTIVE state (`.is-on` cyan lock, `.is-set` accent picker / purple local
seg, `.is-open` accent eye) is colored at full opacity — one rest shade card-wide, so no control
reads brighter than its neighbors. Members: the sharing picker (`config-sync-sharingicon`) and
per-item icon (`config-sync-perelement-ic`), which carried the idiom first, plus (轮 24) the
lock toggle (`config-sync-lock`), the File-preview eye (`config-sync-card-previewicon` — also
re-set from its legacy faint color, 14px size and 6px beside-the-filename margin to muted at the
default icon size, centered in its aux slot), the two-segment local segment
(`config-sync-tworow-seg`) and the Sync Center fleet cell (`config-sync-tworow-fleetcell`) — the
last two sweep BOTH surfaces, per §2.1. Quiet-rest is not the disabled treatment: `config-sync-dim`
(50%, pointer-events none) still means "can't click", stacked on whatever the control rests at.
`eye` — the SETTINGS
FILE row's File preview trigger (§4 below), replacing the collapsed `▸ File preview` text row.
All three registered by hand in the icon-collision guard alongside `file-diff`/`settings-2`.
**定稿轮 19 additions:** `list-checks` — the per-item device-rules icon toggle on a string-array
key's rule row (§4 zone ②; replaces the text+ToggleComponent form); `trash` — the menu-borne
destructive verb (`Remove rule`/`Remove folder`, warning-red, after a separator in the row's own
scope menu — 19d, the inline ✕ ExtraButtons are gone); `plus` — the File preview's top action
line (`Click any key to add a rule for it`). All three hand-registered in the collision guard.

### 2.4 Glyph language (text, reused everywhere)

Direction *actions* (capture/apply/push/pull) now render as the dedicated icons from
`actionIcons.ts` rather than a shared `↑ ↓` glyph; count badges embed one of those icons
plus a number (`renderActionCount`). `✓ ○` remain text and still power header pills,
sidebar/switcher badges, and the mobile filter pills (short form) — except two hero
surfaces, which render real Lucide icons instead, parallel to §2.1's key-round exception:
the header/self-pane self-chip (`check`/`settings`, SyncCenterView.ts) and the
qualifier-autocomplete value rows (`check`, qualifierSearch.ts). Everywhere else ✓/○
remain text. **Chevrons are two distinct glyph families now (round-12), never text:** FOLD
("expands in place") is one SVG `chevron-right`, rotated 90° via CSS when open — never two
glyphs swapped, never `renderFoldChevron`'s caller reaching for `setText`; PICKER ("opens a
menu/list to choose one of N") is SVG `chevrons-up-down`, small, faint, and hover-revealed (row
hover or its own open menu — §2.3 above); the mobile switcher is the one always-visible
exception. The old text triangles `▸ ▾ ▴` are banned everywhere —
every site that used to set one of them as text now renders through one of the two families
above. Actions `⤓` install, `⏻` enable. Report chips `+ ~ −`.
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
  `-side-self-pill` reusing `selfStatePill`), echoing the header self-chip. Grouping is by
  `config-sync-side-divider` hairlines alone (定稿轮 17②): self card / scope list / remotes /
  History each separated by one divider, with NO group head except Remotes — its head is the one
  that earns its place by carrying live state (`Remotes · checked <age>` + the re-check button);
  the old `This device ↔ store` head over the scope list is deleted (the self card's own
  `plugin settings ↔ store` subtitle already carries that relation). **Switcher**
  `config-sync-switcher` — compact replacement.
- **Rows** `config-sync-hub-row` — the unified grammar's one-object-one-row shape (spec
  `2026-08-06-sync-center-unified-grammar-design.md` §1/§3, extended to companion families
  by `2026-08-07-c-livetest-batch5-companion-dissolve.md`): chevron, name (`-rule-name`),
  a spacer, then the fate chips (`config-sync-fatechip`, rendered only when a fact deviates
  from default — `not installed here` · `desktop only` · `stays off` · `off here — your rule`
  / `on here — your rule` · `encrypted` · `your choice` once a conflict is resolved).
  **Chips are icon-only (定稿轮 20 ④):** the glyph from `FATE_CHIP_ICON` (§2.3) with the chip
  sentence in the tooltip, a quiet faint cluster on the row's RIGHT just before the fate/state
  column — never tags trailing the name. Display order is the model's own emit order
  (`buildChips`, deterministic — the fixed ordering), never re-sorted at render. Icon-only
  chips fit any width, so the mobile second-line (C-#43/#44) and the overflow-degrade
  machinery (C-#39 `chipOverflowObserver`/`chips-compact`) are deleted; a chip string missing
  from the registry keeps a text label as the loud fallback. After the chips comes the fate
  sentence
  (`config-sync-fate-text`: direction glyph + verbs describing everything the run will do to
  this row — the full verb table lives in the spec, not duplicated here), and last the
  checkbox. The row element itself carries NO aria-label (轮 21F — it used to carry the item's
  resolved settings-file path, and Obsidian renders aria-labels as hover tooltips, so hovering
  any blank stretch of a row popped the path; the path's homes are the card and Settings).
  **The checkbox has one meaning everywhere:** include this row in the next
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
  material contrast alone (no hairline), the FOLD family's rotating `chevron-right`
  (round-12: was a text disclosure triangle) scaled to the header size; a checkbox click on the header stages, anywhere else on the
  header toggles collapse. A trailing count pill reads `N/M` under a filter; Core/Community
  carry a header chip (`renderCarrierChip`, spec §6.3) reading `settings-2` + `synced` /
  `not synced` — **read-only since this release**: it used to be the on/off carrier's own
  configurable toggle (a popover offering `Sync on/off` / `Stop syncing on/off`), and now only
  jumps to the carrier's own Settings card, where that toggle lives (§2.5 above). Same shape on
  every platform — no mobile-only icon fallback, and never the toggle glyphs
  (`toggle-right`/`toggle-left`, retired with the write path they used to promise). On mobile the
  head stays one line — count pill reads `N/M`, the one form both platforms share
  to `N/M`, the per-section "N selected" hint drops (the section checkbox's checked/
  indeterminate state and the global footer already carry it). Section select-all/clear targets actionable visible rows only —
  excludes the self row, in-sync, nothing-yet, and unresolved-conflict rows. Per-section
  trailing fold lines (`config-sync-unchanged`) aggregate only their own section's `N in
  sync` / `N with nothing to sync yet` (plain text, the leading `.config-sync-row-chevron` plus
  the fixed-size fold icon compose around it — no trailing triangle baked into the string,
  C-#50/round-12), expandable in place. Switching into a filter
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
  `On/off list · differs for N plugins` line (plain text, trailing rotating `chevron-right`
  — round-12, was baked into the string) (`config-sync-remote-onoff`) whose
  expansion shows the per-plugin flips (`config-sync-remote-fliplist`) and the file diff.
  Companion families fold the same way here: companion diff entries merge into their
  parent's entry, each file re-pathed under a `<companion>/` prefix (e.g. `themes/Blue
  Topaz.theme.css`) and chip counts summed — one entry per family; a companion whose
  parent isn't known locally falls back to its own standalone entry (honest degradation,
  same rule as the carrier label fallback). On narrow phones a section head keeps its pills and the "N selected" hint on
  one line (`white-space: nowrap; flex: none`) — the title is the only element allowed to
  wrap.
- **Expanded card (Sync Center row)** `config-sync-itemcard` — a quiet properties zone
  (定稿轮 17①, replacing the bordered/filled drawer): no border, no fill, no radius. The zone
  is tied to its parent row by the **fold thread** (定稿轮 19e 案C, shared verbatim with the
  Settings drawer's `.config-sync-item-exp`): one faint 1px rule whose x sits under the fold
  chevron's center, running from just below the parent row to the zone's bottom — the line
  reads as "this content belongs to that fold" (file-tree/thread semantics) — while the
  content itself indents to the parent's TITLE-text start. Drawn as an absolutely-positioned
  `::before` (divider color at reduced opacity), never a `border-left` on the content edge
  (19e 案A, rejected: a line floating at the indent edge has no geometric relationship to the
  chevron). Rhythm comes from row padding alone — `config-sync-card-fieldrow` carries NO
  `border-bottom` any more (the hairline-per-row look read as a table embedded in a borderless
  panel; `config-sync-card-rulerow` in the Settings drawer sheds its hairlines with it, same
  sweep). The two-segment divider `config-sync-tworow-vline` sits at the same faint tier as
  the thread. Every row
  (`renderCardKeyRow`/`renderTwoSegmentRow`/`renderCardIconActionRow`, round-9 ⑤ "one grid per
  card") shares ONE grid, `.config-sync-cardrow { grid-template-columns: 130px 56px 1px 1fr }` —
  label | fleet icon | divider | value/local — so a two-segment row's fleet icon and its divider
  land on the SAME vertical rule across every row of the card, the More row's icon included
  (定稿轮 19 made this grammar the whole app's: the Settings drawer's `.config-sync-scrow` is
  the same four tracks with a wider 190px identity column — the old 4-track
  `.config-sync-grid` is gone). Wide
  rows (State/Files/Resolve/After install/Enablement/Note, and the fields-mode fallback note) put
  their whole value in `.config-sync-cardval`, spanning tracks 2-4 as one cell (`min-width: 0`, no
  fixed narrow width — ellipsis is a last resort, never a first one, while the row still has
  room); two-segment/icon-only rows (`.is-iconrow` — not `.is-compact`, which already names the
  narrow-viewport `.config-sync-shell` layout, an unrelated axis) land their cells directly on
  tracks 2/3/4 instead. A row that builds no value renders nothing at all: no separator, no
  reserved height (ledger C-#5) — built off-DOM first, appended only once non-empty. **Mobile:**
  wide rows keep their pre-existing stack-to-full-width fallback (batch-21 spec §3, C-#43/#44 —
  label above a full-width value, CSS-only `flex-direction: column`) unchanged, since Resolve's
  segmented control still needs the full device width the shared grid's `1fr` remainder can't
  spare at ~360px; icon rows (two-segment/More) stay on the SAME shared grid at every width instead —
  there is nothing long to clip, only a glyph + chevron, and stacking them would silently
  re-introduce the misalignment round-9 ⑤ exists to remove. Standardized row set, in this order,
  each omitted when not applicable: `On
  apply` / `On capture` / `State` (the fate sentence expanded to a full clause — install
  source, update versions, capture consequence) · `Files` (round 12+13 ②: collapsed by
  default — a neutral `config-sync-pill is-neutral` count (aria/tooltip `<n> files change`)
  plus the FOLD family's rotating `chevron-right`, same click-to-expand idiom
  `config-sync-card-membercount`/`-memberarrow` already use for a companion folder's member
  count (§4 Companion folders below) — expanding reveals the entry list this bullet describes,
  remembered per row while the pane stays open (`expandedFileRows`, a `Set` keyed by group
  name, cleared with `expandedItems`/`remoteFoldsOpen` when the pane closes); direction-aware
  entries — `+` /
  `~` / `−`, both directions, round-11 ③ — each ending in ONE 14px `file-diff` icon when
  diffable/viewable, never per-kind icons: the point is "changes live here, click to see,"
  tooltip `View changes` (diff) / `View content` (an added file, nothing local to diff
  against yet); the OPEN state turns the icon accent-colored, replacing the old `▾`/`▴` text
  flip — the `· ` separator and the words retire with it; an encrypted entry keeps its
  no-affordance note instead; the `capFileEntries` 10-cap + "… N more files" line applies
  inside the expanded state, unchanged) · `Resolve` (conflict rows only — segmented `Use
  theirs ↓` / `Keep mine ↑`) · `Enabled on` (plugins whose carrier is synced, shortened from
  `Default enabled on` round-9 ①) / `After install`
  (carrier not synced, row installs) / `Enablement` (carrier not synced, plugin installed
  but locally off — the fallback ladder's third leaf) · `Settings sync` (the item's own
  file-level sharing rule, shortened from `Default settings sync`) · `More` (icon-only deep-link into the Settings tab, scrolled to this item's own card — the whole sentence moved into its tooltip, no trailing `▸`) ·
  `Note` (honest runtime notes, e.g. Hotkeys' "Takes effect after an app reload"). While the
  card is open, the collapsed row's own fate sentence/glyph hides (ledger C-#9, Rows above)
  — the card's `On apply`/`On capture`/`State` row is the single statement; checkbox and
  chips stay. **The card footer's destructive `⊘ Stop syncing` button is gone** (spec §6.2):
  stopping a whole item's sync now happens on its own Settings card, one gesture, one home —
  reached from here only through `More`.
- **Two-segment row** (`config-sync-tworow*` classes, spec §6.1, round-9 ②/⑤, `ui/enablementRow.ts`) —
  replaces the old icon-trigger-plus-menu `Runs on`/`Settings sync` rows (and their five-stop
  `RUNS_ON_ICONS` vocabulary, §2.3) with one shape reused by three surfaces: a Sync Center row's
  `Enabled on`/`Settings sync`, a plugin card's `Enabled on`, and a carrier card's element rows
  (Unified card below). Fleet cell on track 2, the divider filling track 3, the local cell on
  track 4 of the row's own four-track grid (round-9 ⑤ above; since 定稿轮 19 the Settings
  drawer's rows are `.config-sync-scrow`s with the SAME track roles, so the cells land directly
  on the row's tracks on both surfaces — the old nested `.config-sync-tworow` wrapper inside a
  `.config-sync-grid` cell is gone) — so every row's icon and divider
  land on the same vertical rule. Fleet segment: icon + a muted PICKER `chevrons-up-down`
  affordance (round-12: was text `▾`), NO visible
  wordmark any more (round-9 ②) — click opens an Obsidian `Menu` of the four values (`All devices`
  / `Desktop only` / `Mobile only` / `Each device decides`); icons are `sharingIcon`'s (§2.3),
  `users` for `Each device decides`; tooltip `Default enabled on: <ruleLabel>` /
  `Default settings sync: <sharingLabel>` — the word "Default" that used to open the row's own
  label now lives here instead. Local segment: a "this device" eyebrow (typeset EXACTLY like the
  row labels — 轮 20 ①, §1.4) beside its own
  icon + `chevrons-up-down` — EVERY state has a glyph now, `corner-down-right` for `follows` included (round-9
  ②: it used to render no icon at all here) · `power`/`power-off` for an element, `circle-slash`
  for a whole file · tooltip `This device: <state>`; click opens the local menu
  (`buildLocalMenu`/`buildFileLocalMenu`, §2.3 — unchanged, they still label the MENU ITEMS, a
  different string from the segment's own tooltip). The local cell is ALWAYS visible — glyph,
  eyebrow and the divider before it alike; only its ⇕ picker hint hover-reveals, exactly like
  the fleet cell's (§2.3). A 轮 17④ experiment that hid the whole `follows` local cell at rest
  and revealed it on row hover was reverted in 轮 18 (#139/#140): the hover-reveal idiom's
  scope is the ⇕ glyph itself, never a state-bearing cell. The per-key/fields-mode fallback's fleet
  cell is a dim `settings-2` icon + tooltip `Per-key rules decide — opens Settings`, click =
  the same deep-link the `More` row takes (round-10 ①: the prose sentence could never fit the
  56px icon track — three-line wrap; icon + tooltip is the row language everywhere else, and
  `settings-2`'s registered meaning "opens Settings" matches the click's actual behaviour). No
  picker glyph — it is a jump, not a menu; the local segment renders normally beside it. `After
  install`/`Enablement` keep their own textual triggers (`config-sync-menuchip
  config-sync-card-trigger` — no glyph vocabulary for them), restyled to the same trigger-box
  family so the card reads as one control language regardless of trigger kind. The Settings
  tab's plain field/file sharing cell (no local layer to pair with — the settings-file row's
  whole-file sharing, a rule row's/array-element's per-key sharing, a companion folder's device
  class) is a picker too now (定稿轮 16甲, `SettingTab.ts`'s `renderSharingPicker`): icon +
  `chevrons-up-down`, click opens a `Menu` of `options`, checkmarked on the current value —
  the click-to-cycle idiom (`renderSharingCycle`) it used to keep is deleted outright, not just
  superseded elsewhere.
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
- **Header status bar** — **self chip** `config-sync-self-chip` (is-up/down/ok tints) + `-self-chip-ic`, `config-sync-head-divider`, then the pills; push/pull totals use `config-sync-pill.is-push` (pink) / `.is-pull` (cyan). The bar ends in the one right-aligned refresh control (`config-sync-center-refresh`, `refresh-cw`): no `refreshed …` text span any more (定稿轮 17③) — the age lives in the button's own tooltip (`Refresh — refreshed just now` / `… 5m ago`, `relativeAge`), same on desktop and mobile.
- **Status bar item** (`src/ui/statusBar.ts`, rendered by `main.ts`) — plain colored text
  segments, no pill backgrounds (mockup candidate A); colors identical to the header pills
  (`is-up` orange, `is-down` accent, `is-push` pink, `is-pull` cyan). Clean state = a dimmed
  `refresh-cw` icon only (`--text-faint`). `mod-clickable`; aria-label lists the non-zero parts
  (`Config Sync — 2 to capture · 1 to apply · 1 to push`).
- **Advanced rule editor** (轮 21D — the custom/discovered rule form, `renderRuleForm`): a
  VERTICAL scrow form (`config-sync-advrow`, `label 130px | control 1fr`), one field per row —
  the old two-line mixed grid retired. NAME: input, placeholder `e.g. templates` (the charset
  constraint appears only in the validation error, never as placeholder implementation-speak).
  PATH: one composite input box (`config-sync-pathbox`) whose LEADING segment is the location
  mini-menu (`Vault root`/`Config folder` + ⇕, an Obsidian Menu) separated by a thin divider
  from the borderless path input — pick the base, then type the relative path in the same box.
  TYPE: icon-only picker (`file`/`folder` glyphs, tooltip `File — syncs a single file` /
  `Folder — syncs everything in it`, ⇕ on row hover). DEVICES: the panel's own sharing picker.
  MODE: a text menu picker with the §2.2 display names (Whole file / Per-key rules /
  Encrypted); pinned-to-Per-key items render it dim + tooltip, no menu. DESCRIPTION: input,
  placeholder `optional`. Placeholders across the form are faint/italic. A failed save pins its
  error inline with the CONCRETE reason — the no-error sentinel is `null`, never `""` (轮 21
  #158: the empty-string sentinel collided with the unnamed placeholder rule's empty name, so a
  SUCCESSFUL save showed a blank "Couldn't save this change — ." on the unnamed row).
- **Remote editor** (定稿轮 24 补 #168, `renderRemoteForm`): the SAME vertical form grammar on a
  wider label track (`config-sync-remrow`, `label 150px | control 1fr` — the longest label is
  `STORE FOLDER IN REPO`). TYPE: a text menu picker (`config-sync-menuchip` + ⇕, same idiom as
  MODE — the old DropdownComponent retired). NAME: input, placeholder `e.g. work-laptop`,
  required-`*` on the label (`config-sync-required`, kept from the old form). Vault type —
  STORE PATH: the path input inside a `config-sync-pathbox` whose TRAILING segment, behind the
  thin divider, is the `folder-open` Browse… icon (desktop only). Git type — URL / BRANCH /
  STORE FOLDER IN REPO inputs, ACCESS TOKEN (Obsidian's secret picker in
  `config-sync-secret-control`) with its status sentence on a label-less row underneath, then a
  label-less `Test connection` row + the full-width test strip. **No Username field** (轮 24 补
  #169): a linked token is enough — live-tested against a self-hosted GitLab as well — so the
  input is gone; a `username` already stored in `data.json` still validates and still reaches
  git auth (types/manifest/resolveGitToken untouched), it just has no UI. The
  `Keep Config Sync's own settings out of this remote` toggle row closes the form unchanged
  (`excludeSelf` — live on the whole pull/push/compare chain, NOT outdated). Every handler stays
  `draft.x = …; saveRemotes()` behind the settingsWritable guard; behavior is untouched.
- **Beta tab header** (轮 21C/22): the BRAT map note is a quiet one-line status
  (`config-sync-beta-mapnote`: muted text `Matched from BRAT's beta list · N of M repos
  resolved` + a small `rotate-cw` re-scan icon) that renders ONLY while something is
  unresolved (轮 22 — a fully-resolved list is noise; the install path self-heals with its own
  last-chance re-scan). No `Each plugin syncs …` section-sub on any picker tab (轮 22: "syncs
  its files" stopped being true once installs moved to the catalog/BRAT engine, and the cards
  themselves say what syncs); the cards below are ordinary unified cards.
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
  - **Row** `config-sync-item-wrap` — chevron, name, then (right side, inside the control cell
    just before the sync toggle — 轮 21E moved them off the name) the badges: **icon-only with a
    9px corner count** (`config-sync-card-badge` + `-badge-ic` + `-badge-cnt`, tooltip = the old
    sentence; a registry-missing badge falls back to loud text; the digit renders only from 2
    up — a corner "1" says nothing the icon doesn't, 轮 22 #165). Order per `computeBadges`
    (itemCard.ts): `on/off only` → `toggle-left` grey · `desktop-only plugin` (manifest
    `isDesktopOnly`, an INNATE property) → grey `monitor` · the enablement badge when
    non-default (a local exception outranks the rule, same precedence as at run time; `Each
    device decides` with no exception earns no badge) → YOUR-RULE color: blue `monitor`
    `on: desktop` / amber `smartphone` `on: mobile` / pink `corner-down-right` `on: this
    device` — grey = innate, colored = your choice (轮 21 #162 ②, the two desktop meanings) ·
    carrier cards' two counts (`carrierBadgeCounts`): `monitor-smartphone`+n `N device-scoped`
    (class rules only) and purple `corner-down-right`+n `N left to me` · `lock`+n `N encrypted`;
    a zero count never renders. Then the sync toggle. No mode chip — mode is a derived,
    drawer-only state (`deriveMode`), never a header control.
  - **Drawer** `config-sync-item-exp`, up to three zones, every row across all three built on the
    Sync Center card's OWN grammar (定稿轮 19, replacing the old content|scope|state|action
    4-column `.config-sync-grid`): a `.config-sync-scrow` — `identity 170px | controls 108px |
    divider 1px | detail 1fr`, the controls column a fixed three-slot grid (§1.4 SLOTS, 轮 21A:
    aux 👁/`list-checks` | lock | device picker — same-type controls one strict column each,
    device last beside the divider). Identity holds the row's name (an uppercase zone label, a
    mono key/filename, or a member name); the divider + detail
    pair renders only on two-segment rows (the local `this device` cell, same as the Sync Center
    card). Only a folder row's sync toggle anchors to the drawer's right edge
    (`.config-sync-scrow-end`, the card-toggle rail), and destructive ✕ buttons are gone — a
    removable row's REMOVAL lives in its own scope picker's menu, after a separator, as a
    warning-red `trash` item (定稿轮 19d: `Remove rule` on a key-rule row, `Remove folder` on a
    user-added folder row; presets and non-removable rows offer no such item). The drawer itself
    anchors to its card by the fold thread (19e 案C — see Expanded card above, one treatment on
    both surfaces).
    Every sharing control in a drawer is one picker icon (`config-sync-sharingicon`,
    `renderSharingPicker`, 定稿轮 16甲 — the click-to-cycle idiom, `renderSharingCycle`, is
    deleted): the glyph IS the state (`sharingIcon`: monitor+smartphone = All devices,
    monitor = Desktop only, smartphone = Mobile only, airplay = This device), a click opens an
    Obsidian `Menu` of that row's own option list, checkmarked on the current value, tooltip
    `Where it syncs (currently: …)`; the `all` default sits dim (0.45) and any narrower sharing
    renders `.is-set` (accent, full opacity). ① and ②
    render only when they apply, ③ Folders always renders (down to just its quiet
    `+ Add folder` row, `config-sync-add-row-quiet`, when a card has no folders yet):
    ① **Enabled on** (shortened from `Default enabled on`, round-9 ①; plugin cards whose def
    carries an `enablement` projection — spec §6.5) — the two-segment row (`ui/enablementRow.ts`,
    above), not a single picker: the fleet segment writes the carrier's `perElement` rule
    (`core/enablementRules.ts`, never this plugin's own settings-file entry); the local segment
    writes this device's own exception (`core/deviceElements.ts`, never inside `data.json`). Three
    shapes (spec §6.5): a class rule (`Desktop only`/`Mobile only`) shows only the follow glyph
    (`corner-down-right`, tooltip `This device: follows the default`) in the local segment — no
    editable local state, since one would claim a device answer the sync itself decides; `All
    devices` with a local exception set shows the purple `power`/`power-off` glyph (tooltip
    `This device: on here`/`off here`), editable; `Each device decides` shows the local state
    directly, no `Follows` option in the MENU (there is no shared answer to follow) — landing on
    it for the first time seeds the exception with the plugin's CURRENT state
    (`ruleLandingNeedsSeed`), so switching to it never itself flips the switch.
    ② **Settings file** — mode is derived, never chosen: no per-key rule anywhere (`rules` and
    `perElement` both empty) is whole-file state, any rule is per-key state. The path row
    (`config-sync-card-sfhead`, a scrow) IS the zone header now (定稿轮 19c #144 — no separate
    label line): its identity cell stacks the uppercase `SETTINGS FILE` label over the mono
    filename; the `eye` (round-12, `config-sync-card-previewicon` — the File
    preview trigger, see below) sits in the aux SLOT at the family size and quiet-rest shade
    (轮 24 — its 6px beside-the-filename margin and 14px size are gone);
    the controls cluster holds the 3-option sharing icon (no
    `This device`) and the lock toggle (`config-sync-lock`) that encrypts the whole file.
    **The lock toggle is THREE-STATE everywhere it appears** (`renderLockToggle`, shared by this
    path row and every rule row — 定稿轮 23 ②): unencrypted-but-available paints an OPEN lock
    (`lock-open`, muted — a closed lock read as already-encrypted); encrypted paints the closed
    `lock`, `.is-on` cyan; and a lock that can neither show state nor take a click (disabled AND
    unencrypted) paints NOTHING — its empty slot keeps the lock column, and no tooltip attaches
    to the blank space (#159's lesson). Only disabled+encrypted, unreachable through the UI
    today, still paints a dim closed lock: state is never hidden.
    The path text itself is the edit entry point
    (`config-sync-card-pathbtn`, hover = dotted underline + soft backdrop; `.is-custom` accent
    once a custom path is committed): click it and the identity cell swaps to an input — Enter/blur
    commits, Escape cancels via a keymap `Scope` pushed while the input is focused (Obsidian's
    own Escape handling would close the settings window otherwise), and a committed custom path
    shows a quiet `Reset to default` text action (`config-sync-reset-link`, registered on
    mousedown so the input's blur-commit can't tear it out first) inside the edit row. In
    whole-file state the path row's sharing/lock are live; in per-key state the sharing picker
    renders `config-sync-dim` and disabled (tooltip "Per-key rules are active — remove them to
    control the whole file again") while the lock simply disappears (three-state rule above),
    and — under their own `KEY RULES` zone label — a rule row
    (`config-sync-card-rulerow`, a scrow) appears per configured
    key — never every key in the file, only ones with a rule; browsing the rest is File
    preview's job (below). A rule row's identity is the mono key itself; its cluster is
    scope-picker → lock → for a
    string-array key, the per-item icon toggle (定稿轮 19c #143: lucide `list-checks`,
    `config-sync-perelement-ic` — off faint / on `.is-set` accent, disabled+dim while the rule
    is encrypted, tooltip `Per-item device rules — each item gets its own rule`; the old
    text+ToggleComponent form is deleted) — flip it on and each element gets its own scrow
    (`config-sync-card-elrow`) instead of one rule for the whole key. The rule's REMOVAL is the
    warning-red `Remove rule` item in its own scope menu (19d — the ✕ is gone).
    Removing the last rule flips the card back to whole-file state. File preview (round-12: no
    longer a collapsed text row of its own — the `eye` icon beside the filename above is the
    trigger now, aria-label/tooltip `File preview`, keyboard-accessible like the FILES row's
    `file-diff` icon, `.is-open` turns it accent-colored the same way) expands into the
    read-only `data.json` preview (`jsonView.ts`) below the rule rows — collapsed by default, so a
    card with no rules never reads its file at all. **Key clickability is explicit now (定稿轮 19
    ②, GitHub issue #2 "didn't realize I could click"):** a persistent action line sits ABOVE the
    preview (`config-sync-json-hint`: a `plus` icon + `Click any key to add a rule for it`), and
    EVERY un-ruled key — not just detected ones — renders with a dashed faint underline
    (`config-sync-json-clickable`); hovering turns the underline solid/accent and reveals a small
    `+` after the key. Keys are colored by rule; the color-dot legend
    (`config-sync-legend-dot`, round-7 定稿 B) underneath now carries ONLY the color/lock notes —
    its old trailing "click a key to add a rule" hint moved to the top line. A lucide `lock`
    (`config-sync-json-lock`) marks an encrypted key, `--color-purple` = detected-but-unruled,
    faint = plain; a `perElement` array colors each element the same way. Clicking a key adds a
    rule for it directly (promotes the card to per-key state); a carrier card's preview keeps
    all of this suppressed (no hint line, no clickable affordance — its elements' rules live on
    the element rows, spec §6.4).
    Between ② and ③, the two carrier cards (`core-plugins`/`community-plugins`, spec §6.4) add one
    more zone — `carrierListFor(def)` is what makes a card a carrier, and is the one place that
    identity is decided: a zone-header scrow whose track-1 label is `Enabled on`
    (`ENABLED_ON_LABEL` — the SAME word zone ① uses, because it is the same datum; 轮 21B
    shortened it from the full sentence, which now lives in the header's tooltip:
    `CARRIER_ELEMENTS_LABEL` = "Which devices turn each plugin on") and whose track-4 head is
    `this device` — the eyebrow, promoted to a COLUMN HEADER (定稿轮 20 ③): the member rows
    below suppress their per-row eyebrow (`renderLocalSegment`'s explicit `showEyebrow: false`)
    and show only the local glyph + ⇕; the single-row surfaces (zone ①, the Sync Center card's
    rows) keep their inline eyebrow.
    Then one two-segment row per element (`buildCarrierElementRows` — every element
    installed here, plus any element that carries a rule or a local exception even if it isn't,
    since an uninstalled plugin's fleet choice still needs a card to live on), each row identical
    in shape to zone ①'s single row above, sorted by label. The snippets on/off list has no card
    of its own — same row shape, same producers, rendered inside the Appearance card's `snippets/`
    companion folder (③ below) instead.
    ③ **Folders** (zone label shortened from `Companion folders`, 定稿轮 19 mockup copy) —
    preset (`themes/`, `snippets/`) and user-added vault-relative
    folders, each a scrow (`config-sync-card-companiongrid`): identity is the path
    plus a collapsed member count — round-12: `config-sync-pill is-neutral` bare number
    (`config-sync-card-membercount`, same neutral-pill family the panel's other counts use),
    aria-label/tooltip the full `N themes`/`N files` sentence (`memberCountLabel`, was inline
    text `· N themes`/`· N files`) — then the FOLD family's rotating `chevron-right`
    (`config-sync-card-memberarrow`, was a text ▸/▾ arrow) — click the
    row to expand its member list, while the folder name itself (same `config-sync-card-pathbtn`
    affordance, click/keydown stopPropagation so it never doubles as the member toggle) opens the
    Save/Cancel path-edit row (autofocused; Escape cancels via the same keymap `Scope` as the
    settings-file path row); the controls cluster is device-sharing picker → sync toggle
    (scaled a notch below Obsidian's default so the cluster reads as one row of quiet controls).
    A user-added row's removal is the warning-red `Remove folder` item in its own device-sharing
    menu (19d — the ✕ is gone; a preset is only ever relocated via
    the warning-gated path edit, never removed outright, so its menu has no such item). A
    trailing quiet `+ Add folder` row
    (`config-sync-add-row-quiet`, no longer a full-width button) closes every card (a card with
    zero rows renders no `Folders` header, just the Add-folder row) — EXCEPT a carrier's
    (轮 23 #166 ③): the two switch registries are lists of on/off choices, a folder has no
    meaning attached to them (syncing an arbitrary folder is the Advanced rule form's job), so a
    carrier card renders no Add-folder entry point at all; a legacy user-added folder on a
    carrier, if one exists in config, still renders its row normally — visible and removable,
    never silently active. Opening
    `snippets/` lists members (`config-sync-card-snippetmembers`), each its own sharing icon — it
    writes `enabledCssSnippets` AND decides whether the file itself travels — the only companion
    whose members carry a sharing control (a fleet-only scrow: identity name + the lone picker in
    the controls column, no divider/detail since a snippet member has no local-exception layer —
    定稿轮 19 supersedes round 12+13 ①'s track-2 rule); a plain
    (unmapped) folder's members list for
    information only (`ItemDef.presetCompanions` has no per-member carry mechanism today — a
    future engine iteration, not this one). A member whose file has been deleted but still holds a
    device choice is an orphan row (`is-orphan`): its name renders struck faint
    (`.config-sync-card-companiongrid.is-orphan .config-sync-ldname`), a `file deleted` pill
    follows it (`config-sync-orphan-forget`'s **Forget** button sits at the right edge of the
    identity cell — inside `config-sync-orphancell`). Forget clears the
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
