# Design system — obsidian-config-sync

The canonical reference for every visual decision in the plugin (Sync Center panel,
settings tab, ribbon, modals). Read this before styling anything; update it in the same
branch as any UI change. Raw values live in `styles.css` and the `src/ui/*` files —
this document records the *semantics and rules*; when they disagree, the code is wrong or
this file is stale, and either is a bug.

Hard gates (CI/manual): no hardcoded colors (`./scripts/check-no-hardcoded-color.sh`),
theme variables only, design-first (this document, per CLAUDE.md's rule) before UI changes,
geometry probes for alignment claims.

**Contents:** [1. Design tokens](#1-design-tokens) · [2. Icon set](#2-icon-set) ·
[3. Copy principles](#3-copy-principles) · [4. Component library](#4-component-library) ·
[5. Conventions](#5-conventions) · [6. Open items](#6-open-items)

## 1. Design tokens

### 1.1 Semantic colors

One color per meaning, everywhere. Alpha fills always use
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
| Locked / encrypted-at-rest | `--color-cyan` | key state icon, statenote pills, policy seg on-state (json keys mark encryption with a colorless `lock` suffix — sharing alone drives key color) |
| Warning / caution | `--color-orange` | ⚠ pills, detect/device badges, amber version lines, unresolved conflicts, remote token-status awaiting this device's token, the leftover-section frame, orphan-row hint |
| Error / destructive | `--color-red` | ✗ pills, test-strip error, diff deletions, strip-action on-state |
| File changes (reports/diffs) | add `--color-green` · update `--color-blue` · delete `--color-red` | chips `+N ~N −N`, report file lines, conflict-modal marks — a *file-change* semantic, distinct from directions |
| Neutral text ramp | `--text-normal` → `--text-muted` → `--text-faint` | content → secondary labels → hints/chevrons/idle |
| Text on colored fills | `--text-on-accent` (accent fills) · `--background-primary` (orange/cyan/pink fills) | see Open items #3 |
| Field rule: not shared (json key) | `--color-red` (+ 0.15 fill) | json-preview key highlighting only (`config-sync-json-strip`) — a key with no shared value, which every device keeps its own copy of; the legend names it with the menu's own word, never the local layer's `this device` |
| Field rule: desktop/mobile only (json key) | `--color-blue` (desktop) · `--color-orange` (mobile) | json-preview key highlighting only, reusing existing tokens for a per-key-sharing semantic — no new variable |
| Detected, unruled (json key) | `--color-purple` | json-preview key highlighting only (`config-sync-json-detected`) |
| Device-rule exclusion ("not synced here") | `--color-purple` | the `excluded` fate bucket's filter pill/sidebar badges/header pill — a row a class rule or a per-device opt-out keeps THIS device from touching; the section fold itself stays unstyled text like the ✓/○ folds it sits beside |

`--color-purple` has exactly the two sanctioned uses above and stays banned for anything
else (it must never be a second apply/selection color).

Textual notes use `--text-warning`/`--text-error`; fills, borders, and icons use
`--color-orange`/`--color-red`. Destructive text actions render red on hover (idle muted),
single-row and bulk alike.

### 1.2 Type scale

- Panel base: `.config-sync-center { font-size: var(--font-ui-small) }` — rows and
  anything unstyled inherit the same size as Obsidian's own list UIs.
- Compact step: `--font-ui-smaller` — pills, badges, chips, group headers, hints, notes,
  seg buttons, expanded-detail contents (one scale inside a detail).
- `--font-ui-large` only for modal titles and the bootstrap banner icon.
- Weights: `--font-semibold` for row/item names; 600 for section, modal, History and
  self-pane titles; 500 for status-bar segments, the conflict modal's auto label and drawer
  member names; 400 reset for no-settings row names.
- Micro sizes in raw px exist (9.5–10.5px: sidebar badges, the sidebar self card's 10px
  status pill (`-side-self-pill`), field tags, act buttons, cm-kind/viewbtn, sect-count) —
  see Open items #2 before adding more.
- Uppercase labels (group headers, sidebar heads, form labels) carry letter-spacing
  0.05–0.08em and `--text-muted`/`--text-faint`.
- Monospace (`--font-monospace`): paths, file lists, json viewer, diff panes, runline.

### 1.3 Radii & spacing

- 999px: all pills/badges/tags. `--radius-m`: cards, settings rows, banners, modals.
  `--radius-s`: small chips, test strips, json blocks, inline diffs. 3px: checkboxes
  (desktop), json keys. 8px: sidebar items, switcher, sections, strips. 50%: dots and
  spinner. Segmented controls inside a `.config-sync-seg` frame use radius 0 buttons in a
  5px frame. (Nine tiers total — see Open items #4.)
- Spacing uses Obsidian `--size-4-*` steps; no raw margins except calibrated ones (below).

### 1.4 Calibrated geometry (probe-verified; do not eyeball)

| What | Value | Why |
|---|---|---|
| Checkbox column | mainbar `padding-right: calc(var(--size-4-3) + 1px)`; a section's nested card is unframed and bleeds its padding back out (`margin: 0 calc(-1 * var(--size-4-3))`), so its content box still sits on the section's own inset; section-head boxes `margin-left: auto` | one shared right edge: select-all = card rows = section rows = section heads (probe-equal, desktop + mobile) |
| Header ↻ | `margin-right: 7px` | glyph right edge == checkbox column (probed) |
| Checkboxes | 15px desktop / 24px mobile (radius 6px), pseudo ✓ offsets differ per platform | Obsidian's mobile checkbox styling defeats hit-area tricks; visual = touch target |
| Touch targets | 44px rows/switcher/search-adjacent, 36px pills/seg/side items, 32px detail seg buttons | mobile minimums |
| Mobile bottom clearance | `calc(var(--mobile-toolbar-height, 48px) + 88px)` | clears navbar + user status-bar snippets |
| Inline micro-gaps | 3px (sidebar column rhythm) · 5px (icon↔label clusters) | between `--size-4-*` steps; 8px gaps use `var(--size-4-2)` |
| Drawer control glyphs | `var(--icon-s)`, ONE rule covering lock / sharing picker / per-item toggle / File-preview eye / merged control | only the merged control used to carry a size; the rest fell back to Obsidian's 18px default and read a size bigger the moment a 16px glyph landed beside them. The ⇕ keeps 11px through a same-specificity rule placed after it |
| Card control rail | `.config-sync-cardrow > .config-sync-mergedctl, .config-sync-cardrow > .config-sync-cardrow-ctl { grid-column: -2; justify-self: end }` | ONE rule puts every card control on the card's right edge, the same rule the item rows' checkboxes sit on, so a control added later aligns by construction. `.config-sync-cardval` needs no inset of its own: nothing lands on track 2 for it to line up with any more |
| Card trigger padding | `.config-sync-mergedctl` and `.config-sync-sharingicon.config-sync-card-trigger` both `3px 6px` | the boxes all end on the rail, so a padding difference between them shows up as a difference between their glyphs, and the glyph is what the eye follows |
| ⇕ column | `--cs-chev-slot: 14px` (gap 2 + margin 1 + glyph 11); every rail control either holds a ⇕ or reserves the column with `padding-right` | aligning box right edges staggers glyphs by exactly the ⇕'s width: a rail of merged controls (⇕) beside `More` and `Files` (no ⇕) measured 1677 / 1691 / 1691 for its last visible mark on boxes that all ended at 1697. The ⇕ rests invisible, so a reserved-but-empty column reads as the rail's own inset rather than a hole |

**The settings-drawer row grid (scrow).** Every row in an item card's drawer is a
`.config-sync-scrow`: `identity 170px | controls 1fr | trailing minmax(44px, max-content)`.
**Track 3 is reserved, not content-sized**: it holds a row's own STATE toggle (a folder's sync
switch), which only some rows have, and content-sizing it lets a row without one run 44px further
right than the row above. Reserving it gives the drawer two columns: toggles on the rail, rule
controls immediately left of it, both card-wide. **The controls track is the flexible one and its
cluster right-aligns inside it**, so a row with no trailing cell puts its controls on the card's
right edge and a folder row's toggle takes that edge with the controls immediately left. One
vertical rule down the card, header toggle included.

The controls cluster (`.config-sync-scrow-slots`) packs against the right, and three properties hold
it together. **Role order is pinned in CSS** (`order` on `.is-aux` / `.is-lock` / `.is-device`), not
left to whichever order a caller fills the slots in. **An empty slot leaves the flow entirely**
(`:empty`), so it holds neither width nor a column-gap beside controls that are actually there;
removing it cannot pull an occupied slot out of column, because the cluster measures from the RIGHT.
**Each slot is one column** (aux 24 | lock 24 | device 68), so a control lands at the same x on
every row. Slot roles: aux = the per-item `list-checks` on array rule rows, empty on the path row
(its File-preview `eye` rides the filename line); lock = encrypt toggles; device = every scope/rule
picker AND the merged two-layer control, last and widest of the three.

**The device slot's control FILLS the slot** (`width: 100%`) and its ⇕ takes the right edge
(`margin-left: auto`). What lands here has two natural widths — a merged control carrying both
layers measures 65px, a picker or a merged control with no local layer measures 40px — so hugging
one edge puts the leading glyph of the narrow ones 25px off the column. Filling the slot instead
puts every shared glyph on the column's left edge and every ⇕ on its right, and leaves the slack
between the local layer and the ⇕: exactly where the row is missing something. The 68px is a
`min-width`, so a wider control grows the column rather than overflowing it. Reserve what is always
there, never what varies, and let the slack trail — the same rule the sidebar count badges follow. STATE controls (a folder row's sync toggle) right-anchor on the card-toggle rail via
`.config-sync-scrow-end`. Member-row indent lives on the name inside the identity cell, never on the
row. There is no other drawer grid — `.config-sync-scrow` is the only row shape.

**The path row.** Zone ②'s path row is TWO scrow lines inside the
`.config-sync-card-sfhead` container: line 1 = the `SETTINGS SYNC` label + the slots
cluster (aux empty → `🔒` → `🖥⇕`), strictly on the label's own line — a cluster vertically
centered between label and filename would be anchored to neither; line 2 = the filename
spanning the full card width (`grid-column: 1 / -1`), so `plugins/<id>/data.json`-length
paths never wrap, with the File-preview `eye` riding that same line, hugging the filename's right
edge (a gap inside the `.config-sync-card-pathhost` flex — never `margin-left: auto`, which would
anchor it to the CARD's right edge across this line's `1 / -1` span and invent the action column
§2.1 forbids, and never `.config-sync-scrow-end`, the fixed trailing track, which would overlap
that same span). The filename keeps its click-to-edit behavior; the edit input takes the
full-width line, eye included.

**Zone-label type.** `.config-sync-explabel` is the one uppercase label style in a drawer row
(`--font-ui-smaller`, 0.05em tracking, `--text-muted`). There is no second uppercase micro-label:
the `this device` eyebrow that used to sit beside the local control retired with the two-segment
row, and that word now appears once per MENU (its `On this device` section header) rather than once
per row.

## 2. Icon set

### 2.1 State column (`.config-sync-state-icon`, text glyphs + one SVG)

Action states carry dedicated Lucide icons (via `setIcon`): capture `arrow-up-from-line`/orange,
apply `arrow-down-to-line`/accent, push `cloud-upload`/pink, pull `cloud-download`/cyan
(`src/ui/actionIcons.ts` is the single source). Status glyphs stay text: `≠` differs/faint ·
`—` miss/faint · `○` no-settings/faint · `✓` ok/green · `?` unknown · **key** (`key-round`)
locked/cyan. This is `.config-sync-state-icon` specifically (a Statistic-workspace/switcher
vocabulary) — it is UNRELATED to a collapsed item row's own neutral fate rendering, which
uses the fold family's icons (below).

**Direction arrows say which side, once, per surface.** The surfaces that say "this goes
up/down" are the header pills, a collapsed row's fate glyph, and the FILES row's own
direction badge (`arrow-up-from-line` orange / `arrow-down-to-line` accent, tooltip `These
changes land in the store` / `These changes land on this device`). A FILES *entry* itself
never carries a direction glyph: it speaks the diff-kind family `+` (green, added) / `~`
(blue, updated) / `−` (red, strikethrough, deleted) in BOTH directions — the
new/updated/removed distinction is real information (a new store file starts syncing to
your other devices; a removal removes it everywhere) and must never collapse to a single
direction arrow. Each entry's `aria-label`/hover carries the side+consequence sentence
(the tooltip `fileEntryFor` produces, `src/ui/panelModel.ts`, exported as named constants
so the icon-collision guard and tests share the producer): capture — added `New in the
store — starts syncing to your other devices`, updated `Store copy updated`, deleted
`Removed from the store — removed from your other devices`; apply — added `New on this
device`, updated `Changed on this device`, deleted `Deleted from this device`. Changing how
ONE surface draws an arrow means sweeping the row-level list above, not the FILES entry
vocabulary — they are deliberately two different vocabularies, never one collapsed onto the
other.

The Sync Center's trailing-fold summary lines (`✓ N items in sync` / `⊘ N not synced on
this device` / `○ N with no settings yet`) are a DIFFERENT vocabulary from this text-glyph
state column: text glyphs proved optically unequal across themes (font-fallback ink
weight), so those three states render fixed-size 12px Lucide instead (§2.3). The state
column itself keeps its text glyphs.

A collapsed item row's NEUTRAL fate (`In sync` / `No settings yet` / `Not synced on this
device`) reuses the fold family's own `FOLD_ICON`/`FOLD_ICON_COLOR_CLASS` (`foldIcons.ts`)
at the row's own `.config-sync-fate-ic` size/placement instead of rendering the sentence as
text — the fold kind is derived from the `Fate` the row already carries (`fate.nothingYet`
→ `nosettings`/`circle`, `fate.excluded` → `excluded`/`circle-minus`, else →
`insync`/`check`), aria-label = the sentence. Same reuse on the remote diff pane's own
opted-out row (`renderRemoteDiffEntry`) — every ROW-level instance of these three sentences
renders this way. The `⚠` conflict fate keeps its text glyph + sentence, since a conflict
must shout and has no action icon to become. A fold-group HEADER line (`53 items in sync`)
keeps its own text+icon form — this rule is about the ROW, not the group header. Chips are
unaffected. (This DESIGN section is the authority on the split, not any code comment.)

### 2.2 Mode vocabulary

Mode display names (the stored ids `plain`/`fields`/`encrypted` never change):
**Whole file / Per-key rules / Encrypted** (`MODE_LABELS`, itemCard.ts). "Plain" and
"Fields" are implementation words and never appear in copy; "Per-key rules" is the drawer's
own vocabulary for the same state.

`MODE_ICON` (itemCard.ts) gives each mode one glyph: **plain → `file-text`**, **fields →
`braces`**, **encrypted → `lock`**. Its one renderer today is the Advanced rule form's `MODE`
picker, whose two neighbouring rows (Type, Devices) are icon pickers — Mode was the last text chip
in that form and read as the odd row out. `file-text`, deliberately **not** `file`: the Type row
directly above owns `file`/`folder` for a different question. An item CARD carries no mode badge at
all — mode there is a derived, drawer-only state (`deriveMode`), never a header mark. (Until
2026-08-18 this section described a custom `drawFieldsBadge` SVG; no such function had existed since
the card's mode chip was removed.)

### 2.3 Lucide usage (setIcon)

`refresh-cw` ribbon + both panel refreshes + status-bar item · `lock` mode badge ·
`lock-open` the encrypt toggle's rest state (unencrypted-but-available — a closed lock
there reads as already-encrypted; closed `lock` is the ENCRYPTED state everywhere, toggle
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
`sharingIcon` "This device" stop, used ONLY where that rule row has no local layer of its own to
pair it with — an array element's own per-item rule, a companion folder's device class, the
Advanced tab's custom-rule editor. An item card's own key rules (`renderRuleRow`, §4 zone ②) pass
`ruleIcon`/`ruleLabel` instead, the SAME fourth-stop vocabulary `Enabled on` uses
(`square-split-horizontal`/`Not
shared`, the merged control below) — the STORED value is unchanged, only the glyph and the word,
because that row now carries a local layer in the same control and a bare `airplay` mark would read
as this device's identity rather than the shared arrangement. `FILE_SHARING_OPTIONS` excludes this stop
outright, so the settings-file row's own whole-file sharing cell never offers it, either mode.
**There is no click-to-cycle control:** every sharing/rule control in
the Settings tab opens an Obsidian `Menu`, through `SettingTab.ts`'s own
`renderSharingPicker` (the vocabulary model — `sharingIcon`/`nextSharing`/`sharingCycleTooltip` —
lives in itemCard.ts; `nextSharing` keeps its own unit tests as a pure function even though
no control renders through it). A Settings drawer sharing cell with no local layer of its own — an
array element's per-item rule, a companion folder's device class, the Advanced tab's custom rules —
is a plain picker: icon + a small muted `chevrons-up-down` PICKER affordance, click opens a `Menu`
listing `options` with icons + a checkmark on the current value (§2.4). `iconFor`/`labelFor`
select the vocabulary; everything else falls back to `sharingIcon`/`sharingLabel`. A cell that DOES
carry a local layer — the settings-file row's whole-file sharing, a key rule's sharing, a plugin
card's `Enabled on`, a carrier element's row — is the merged control below instead, which is the
same idiom with a second glyph and a two-section menu.
`monitor-smartphone` — the "All devices" stop.

**The merged two-layer control** (`ui/mergedControl.ts` paints it, `ui/enablementRow.ts` says what
it means): `sharedGlyph · localGlyph ⇕`, ONE trigger, one Tab stop, one menu. It is what a row
shows wherever both layers apply — a Sync Center row's `Enabled on`/`Settings sync`, a plugin
card's `Enabled on`, a carrier card's element rows, an item card's key rules and its settings-file
path row. It replaced a `label | fleet segment | divider | local segment` row: a permanent column
and a `this device` eyebrow spent on a layer that is almost always "no exception", and on a phone a
column that did not fit. The words that column carried moved into the menu's section headers, where
they are stated once instead of per row.

**One control, two questions, so two labelled sections** (`MenuSectionModel`,
`buildSectionedMenu`): `Shared with` / `Enabled on` (which of the two depends on the row kind — see
below) then `On this device`, separated by a rule, headers rendered with `setIsLabel` so they can't
be picked. A third, unlabelled group can follow for a row's destructive verb (`Remove rule`) —
naming it would promote a one-item action to the rank of the two answers above it. Inside the
shared section one more separator precedes the LAST stop: the first three answer "who gets the
shared value", `Not shared` answers "is there one at all" — a different question in the same radio
group, which is exactly why it used to read as the odd one out.

**A row with no local layer shows ONE glyph and a one-section menu** — the glyph count IS how many
things the row can be told, so the two can never disagree. Three rows are in that state: a key
governed by per-item rules, a key shared with no one (`ruleRowHasLocalLayer`), and a snippet, whose
exceptions no run would honour.

**Shared glyph:** `sharingIcon`'s icons for the three device stops, plus
`square-split-horizontal` for `Not shared`
(**never** `airplay`, which reads as screen mirroring to anyone who hasn't read the source;
**never** a negation glyph either — the local layer's own opt-out sits in the SAME control, and
those two facts are the pair users most often confuse, so the shared answer must
not join the negation family. A box divided in two says the value diverges per device, which is
what the fourth stop actually does. It replaced `split`, which made the same argument and was
unreadable making it: at 16px that glyph's two corner arrowheads and thin curved stem collapse into
a smudge — same meaning, legible execution, straight lines and square corners only).
Its tooltip states the CONSEQUENCE, not the label, and there are
THREE of them because the same three words mean three different things: an on/off row turns the
excluded class OFF (`enabledOnTooltip`), a whole-file row stops syncing there ENTIRELY
(`settingsSyncTooltip`), one key just lets the excluded class keep its OWN value
(`sharingCycleTooltip`). The same split names its menu section: an on/off row heads it
`Enabled on`, everything else `Shared with` — `Enabled on: Desktop only` and `Shared with: Desktop
only` read correctly and differently, where the bare stop could not.

**Local glyph:** one for EVERY state — `equal` while following the shared answer (this device
MATCHES it; it replaced `corner-down-right`, which the card and carrier badges were using for the
OPPOSITE meaning — `on: this device` / `N left to me`, both of which say this device HAS an answer
of its own. Those badges moved to the exception family in the same pass, so `corner-down-right` is
retired from this vocabulary entirely; `equal` also has to work in a MENU list, where there is no
neighbouring glyph for an arrow to point back at) · `power` / `power-off` for an element-level local
exception (**Always on**/**Always off**) · `circle-minus` for a whole-file local opt-out
(**Don't sync it**, deliberately the fold family's glyph — same meaning, "not synced on this
device"; it replaced `circle-slash` in both places at once, because at this size a diagonal through
a circle is the least legible mark in the set while a horizontal bar reads instantly and says the
same thing. Still a circle, so the fold trio `check`/`circle-minus`/`circle` stays one family);
tooltip `This device: <state>` (`follows what's shared.` / `always on.` / `always off.` /
`not synced. Your other devices keep sharing it.` — only that last one carries a second sentence,
because it is the state users mistake for `Not shared`, and the whole difference is what happens to
everyone else). Only this half colors purple when this device has an exception
(`.config-sync-mergedctl.is-set`) — the shared glyph keeps saying what the shared answer is, which
is the whole reason both glyphs stayed visible. The trigger's own `aria-label` is the two tooltips
joined, in that order, so one hover states both layers.

The local section's ENTRIES come from one producer each (`buildLocalMenu` for an element's three-way
on/off, `buildOptOutLocalMenu` for the two-state opt-out shared by the whole-file row and a key
rule) — they label the MENU ITEMS, which is a different string from the glyph's own tooltip. The
settings-file path row (`renderSettingsFilePathRow`, §4 zone ②) paints the same control as variant
**A′**: it lives in the SLOTS cluster beside the lock rather than alone, and its second line (the
mono filename) carries no label of its own — the File-preview eye rides that line instead, hugging
the filename's right edge inside the pathhost flex (never `margin-left: auto`, never
`.config-sync-scrow-end`; see §2.1's path-row entry for why both would break). In per-key state its
shared half has no value to pick, so that half contributes ONE menu entry that jumps to the rules
instead of a list of stops (§4 zone ②).

`settings-2` — the sidebar Config Sync
self-entry tile, the compact switcher's self entry, the self pane's title-row Settings
button, and the Sync Center card's `More` row — an
icon-only deep link into the item's own Settings card (tooltip carries the sentence, no trailing
`▸`; **never** `sliders-horizontal`, which already means `your rule` in the fate chips below).
**It means "opens Settings" and nothing else**: the per-key fallback cell used to draw it too, so a
card showed the same mark on two rows for two different facts — that cell speaks `braces` now ·
`braces` — "the keys inside this file decide": the fields-mode jump on both surfaces, and
`MODE_ICON`'s fields stop (§2.2) ·
`share-2` — the carrier chip's shared state (below) ·
`arrow-left-right` — the Sync Center leaf/tab icon ·
`chevron-right` — qualifier-autocomplete key rows (value rows use `check`, §2.4) · fate chips
(`config-sync-fatechip`, `FATE_CHIP_ICON` in `fateChipIcons.ts` — icon-ONLY,
the chip sentence in the tooltip; text renders only as the loud fallback for an unmapped
string): `circle-dashed` not installed here ·
`monitor` desktop only · `sliders-horizontal` your rule / off here — your rule / on here — your
rule · `power-off` stays off (**not** `power` — `power` means "this device turned it on" in
the merged control's local glyph, so a chip saying the row stays OFF cannot share it) · `lock`
encrypted · `check` your choice · trailing-fold states
(`config-sync-fold-ic`, `FOLD_ICON` in `foldIcons.ts`): `check`/green in sync ·
`circle-minus`/muted not synced on this device · `circle`/muted no settings yet — the SAME three
(same producer, `config-sync-fate-ic` sizing) also render a collapsed item row's own neutral fate
(§2.1 above). SIZE: the fold LINES keep the fixed 12px (three glyphs side by side must read as
optically equal); inside a count BADGE the same glyphs switch to `1em`, matching the action icons
they sit beside. The two families used to disagree on the unit, which went unnoticed everywhere
the container is 12px and showed up in the sidebar, whose badge is 10px — `✓`/`○` drew 20% larger
than `↑`, at a heavier stroke, in the same row.

**`ban` is unused** — the whole-item destructive gesture lives on the item's own Settings
card, beside its sync toggle, and is reached from the Sync Center only through the `More`
deep link above — never a second control drawn straight onto the row. `circle-minus` has
exactly one job, the fold family's STATE glyph (and the local layer's whole-file opt-out,
deliberately the same glyph and meaning) — an icon never means both a thing you can click
and a thing that already happened.

**Read-only carrier chip** — the Core/Community section header chip (`renderCarrierChip`,
SyncCenterView.ts) is glyph-only with the sentence in its tooltip: `share-2` when the on/off list is
shared with your other devices, `square-split-horizontal` — `ruleIcon`'s own `Not shared` mark, same
word, same glyph — when it isn't. **The state lives in the GLYPH, not in a color**, because a phone
has no hover to reveal the tooltip: two visibly different marks still tell the two states apart
where one mark in two shades would not. (It carried the word `synced` until 2026-08-18. That word
named the wrong axis — what the chip reports is whether the LIST is shared, not whether a sync ran —
and the pair it belongs to is `Not shared`.) It is a shortcut, never a control: click jumps to the
carrier's own Settings card, where the sync toggle lives. Never the toggle glyphs
(`toggle-right`/`toggle-left`) — a toggle shape promises "click to flip," and this chip cannot.

**The diff affordances:** `file-diff` — the FILES row's per-entry trailing affordance,
"view this entry's changes/content" (§4 Files bullet); registered by hand in the
icon-collision guard (`tests/fateChipIcons.test.ts`'s `EXTERNAL_HOMES`, same treatment as
`settings-2`) since it sits behind no exported table. The diff panel's own segmented
toggles (`diffView.ts`) are icon+tooltip (two segments, active highlighted): `rows-2`
unified diff (tooltip `Unified diff`) · `columns-2` split diff (tooltip `Split diff`) ·
`fold-vertical` collapse unchanged lines (tooltip `Collapse unchanged lines`) ·
`unfold-vertical` show all lines (tooltip `Show all lines`) — the labels live in the
tooltips only, never on the buttons.

**The FOLD family:** `chevron-right` — the fold family's one glyph, rendered by the shared
`renderFoldChevron`/`setFoldOpen` helper (`ui/foldChevron.ts`) and rotated 90° via CSS when
open; every "expands in place" site in the app (Sync Center section heads, fold-group/self/
item rows, the run-strip's `details`, the self pane's `view change`, the Settings tab's
rule/remote rows and its member-disclosure arrow, the conflict modal, the report strip's
per-result rows) shares this one glyph — never two icon names swapped, never text. Also
registered for a different meaning (qualifier-autocomplete key rows, above) — the two uses
never collide because a key row never toggles open/closed, so this is a deliberate
one-glyph-two-contexts reuse, not tracked as a collision.

**The PICKER family:** `chevrons-up-down` — the picker family's one glyph ("opens a
menu/list to choose one of N"): the merged control (ONE ⇕ for both its glyphs, since it is one
trigger) and every plain sharing/rule picker (`config-sync-tworow-chev`, one class, every site —
`paintMergedControl`/`renderSharingPicker` in SettingTab.ts and their SyncCenterView.ts
counterparts all paint it) and the compact switcher (`config-sync-switcher-chev`); small
(~11px in-row, ~13px switcher).

**⇕ hover-reveal law:** `config-sync-tworow-chev` is invisible at rest (`opacity: 0`,
constant layout — never a horizontal shift) and reveals on two triggers — the containing
ROW's hover (`.config-sync-scrow`/`.config-sync-cardrow`, the two places this glyph lives)
or while its own trigger's menu is open (`.is-open`, set by `wireMenuTrigger` in both
SettingTab.ts and SyncCenterView.ts and cleared via `Menu.onHide`), which also turns it
accent-colored — the SAME open-state language the switcher has. The menu-open selector is
`.is-open >` with a CHILD combinator: `.is-open` doubles as fold state on far ancestors (an
expanded `.config-sync-section`), and a descendant match would light every ⇕ inside an
expanded section permanently — the ⇕ is always a direct child of its own trigger, so the
child combinator is exact. **Constant layout is a WIDTH promise too:** a DISABLED picker
(`renderSharingPicker`'s `disabled` option, `.config-sync-dim` on the sharing icon) still
renders its ⇕ span — a picker box without the ⇕ is 14px narrower, and the centered device slot
then drifts its icon out of the column every enabled picker aligns to.
The dim picker's ⇕ just never reveals — a suppression rule after the hover-reveal keeps it
at `opacity: 0` on row hover (it has no menu to open, so `.is-open` can't light it either).
Mobile (`body.is-mobile`) hides it entirely, no hover to reveal it there; the compact
section switcher's own `config-sync-switcher-chev` is the one deliberate exception, staying
always visible on every platform (it is the sole entrance to the section list on mobile,
where the sidebar is gone). **The hover-reveal belongs to the ⇕ glyph ALONE:** extending it
to a whole local cell — glyph and all, appearing and vanishing
with the row's hover — was tried and rejected: a whole cell that materializes on hover
reads as missing content at rest, on every surface. State (both of the merged control's glyphs) is
always visible; only the affordance hint (⇕) is hover-dependent.

**Quiet-rest law:** every CLICKABLE icon control rests at `--text-muted` ×
`opacity: 0.45` and lifts to `opacity: 1` on its own hover/focus-visible or while its menu is
open (`.is-open`); an ACTIVE state (`.is-on` cyan lock, `.is-set` accent picker / purple local
glyph, `.is-open` accent eye) is colored at full opacity — one rest shade card-wide, so no control
reads brighter than its neighbors. Members: the sharing picker (`config-sync-sharingicon`),
the per-item icon (`config-sync-perelement-ic`), the lock toggle (`config-sync-lock`), the
File-preview eye (`config-sync-card-previewicon` — muted at the default icon size,
hugging the filename's right edge with a single gap, never flushed to the line's end), and the
merged control (`config-sync-mergedctl`, one box that lifts as a WHOLE on hover because it is one
control — it sweeps both surfaces, per §2.1). Quiet-rest is not the disabled treatment: `config-sync-dim`
(50%, pointer-events none) still means "can't click", stacked on whatever the control rests at.

`eye` — the SETTINGS SYNC row's File preview trigger, riding the filename's own line
(§4 Unified card). `list-checks` — the
per-item device-rules icon toggle on a string-array key's rule row (§4 zone ②). `trash` —
the destructive verb: menu-borne on removable rows (`Remove rule`/`Remove folder`,
warning-red, after a separator in the row's own scope menu — there are no inline ✕ buttons),
and the Leftover section's two delete controls (per-row and the head's Delete-all, §4 —
quiet-rest, hover red). `plus` — the File
preview's top action line (`Click any key to add a rule for it`). All hand-registered in
the collision guard alongside `file-diff`/`settings-2`.

### 2.4 Glyph language (text, reused everywhere)

Direction *actions* (capture/apply/push/pull) render as the dedicated icons from
`actionIcons.ts`, never a shared `↑ ↓` text glyph; count badges embed one of those icons
plus a number (`renderActionCount`). `✓ ○` remain text and power header pills,
sidebar/switcher badges, and the mobile filter pills (short form) — except two hero
surfaces, which render real Lucide icons instead, parallel to §2.1's key-round exception:
the header/self-pane self-chip (`check`/`settings`, SyncCenterView.ts) and the
qualifier-autocomplete value rows (`check`, qualifierSearch.ts). Everywhere else ✓/○
remain text. **Chevrons are two distinct glyph families, never text:** FOLD
("expands in place") is one SVG `chevron-right`, rotated 90° via CSS when open — never two
glyphs swapped, never `renderFoldChevron`'s caller reaching for `setText`; PICKER ("opens a
menu/list to choose one of N") is SVG `chevrons-up-down`, small, faint, and hover-revealed (row
hover or its own open menu — §2.3); the mobile switcher is the one always-visible
exception. Text triangles `▸ ▾ ▴` are banned everywhere —
every disclosure renders through one of the two families above.
Actions `⤓` install, `⏻` enable. Report chips `+ ~ −`.
Warnings `⚠ ✗`. Conflict modal `＋ ＝`. `⌂` is the vocabulary's local/device-exception
glyph, used wherever a decision is pinned to one device — the conflict modal is one case
(`＋ ＝ ⌂`). Sharing pickers render their local stop as Lucide `airplay` instead
(§2.1). Self-pane
title icon (`config-sync-self-title-ic`) is Lucide (the self pane is a hero surface):
`arrow-down-to-line` coldstart · `arrow-up-from-line` capture — the ACTION_ICON pair —
plus `alert-triangle` both · `settings` default. Removal glyphs `⊘` stop-sync · `⌫`
leftover. Status-bar remote counts use `⇡ ⇣` (text, matching the pill colors); navigation
is `› ‹`; the sidebar's device↔store relation renders `↔`; strips/banners close with
Lucide `x`. New UI must reuse this vocabulary rather than invent synonyms.

## 3. Copy principles

- All user-facing copy is written from the user/product perspective, never the
  implementation's.
- Forbidden implementation vocabulary in copy: scope, carrier, mask, self group, ledger,
  shared list, compiled, registry, delta, schema, fleet, switch list, sidecar. The Sync
  Center's unified grammar binds all copy to three nouns only — `this device` /
  `your other devices` / `the store` — no invented synonyms for any of them. Use device
  narrative ("on for your other devices", "off on this phone") and consequence narrative
  ("Apply would turn it on here too") instead.
- **One concept, one word.** `scope` is forbidden in copy and retired from the code,
  because it meant three different things — the settings area, the item family, and the
  sharing rule — depending on where you stood. The words, everywhere: **section** (which
  family an item belongs to; `obsidian` · `core` · `community` · `beta` · `custom`) ·
  **sharing** (who shares a value) · **device** (which devices something runs on) ·
  **mode** (how a file is handled) · **element** (one entry of an on/off list) ·
  **action** (what an item needs right now) · **type** (`file` · `folder`, never `dir`).
  Both search bars type `section:`; there is no alias for the retired `scope:`. A synonym
  for any of these is a defect, not a style choice — and so is the same word ANSWERING
  differently in the two boxes: `section:custom` finds a custom rule in either one, the
  settings panel adding its own area word (`advanced`) rather than substituting it.
- Anchor to established product terms: Apply, Capture, the store, Sync Center, "your other
  devices". Don't invent synonyms.
- Controls state their click consequence; recommended options give their reason ("matches
  where it's used today").
- Error/diagnostic copy is a separate tier: KEEP actionable technical detail (paths,
  params, status codes) and always give a next step; strip only pure-internal jargon.
- No emoji in copy; icons are Lucide via `setIcon` or the established text-glyph
  vocabulary (§2.3/§2.4).
- Copy is reviewed to this standard when it is designed, before it ships — never patched to
  standard after implementation.

## 4. Component library

Class prefix → role (all in `styles.css`, rendered from `src/ui/SyncCenterView.ts` unless
noted):

- **Pills** `config-sync-pill` (is-up/down/ok/none/neutral/warn/error/statenote) — counts and
  states; never interactive. **Filter pills** `config-sync-fpill` in `-fpillrow` — buttons;
  long/short label spans; mobile = glyph form, one line. Shared with the settings search's section pills.
  **Every count on this screen runs over the same rows** — the ones the list actually renders
  (`countable`, ARCHITECTURE's panelModel entry): header pills, sidebar badges, switcher badges and
  filter pills alike, with the status bar reproducing that set from outside the view. They read
  three different pools until 2026-08-18, which is how `↑16` sat above `To capture 14` above a bar
  saying `↑19` on one screen.
- **Sidebar** `config-sync-side-item/-side-badge` — sections with tiny count
  badges; active = accent tint. The badges are a COLUMN, and what has to line up is the ICON at each
  badge's left edge: every capsule carries `font-variant-numeric: tabular-nums` and
  `min-width: calc(1em + var(--cs-badge-digits) * 1ch + 12px)` (icon + digit slot + padding).
  `--cs-badge-digits` is MEASURED per render on the shell (`SyncCenterView.badgeDigits` →
  `widestCountDigits`, from the `All items` buckets and the row total that bounds a search's hit
  badge), never written into the stylesheet: a fixed reservation is wrong in both directions at
  once — too small and the longest count overflows the column the reservation exists to hold, too
  large and every shorter count carries the difference as dead space (a hard-coded `3ch` turned
  `↑3` from 28px into 41px, all of it trailing, and that is what made the first attempt read as
  ugly). Content stays left-packed — the icons form their own column and a short count leaves
  trailing space; the DIGITS deliberately do not align, which is the accepted trade for not
  reserving a fixed slot per state (that alternative — a subgrid with one track per state — gives
  zero trailing space but leaves holes wherever a row lacks a state, and moves a lone badge off the
  right edge into the middle of the row). Alignment here is geometric, not semantic: a row whose
  only badge is `↑` sits in the column another row fills with `○`. The Config Sync self layer leads as a distinct hero card
  `config-sync-side-self` (`-side-self-ic` icon tile, `-side-self-title`/`-side-self-sub`,
  `-side-self-pill` reusing `selfStatePill`), echoing the header self-chip. Grouping is by
  `config-sync-side-divider` hairlines alone: self card / scope list / remote rows /
  History each separated by one divider, with NO group heads anywhere. Re-checking remotes
  belongs to the main region's global refresh button alone (it re-scans local state AND
  re-checks every remote; its tooltip carries the refreshed-age), and each remote row's own
  state icon carries the result. The self card's own `plugin settings ↔ store` subtitle
  already carries the device↔store relation. **Switcher**
  `config-sync-switcher` — compact replacement.
- **Rows** `config-sync-hub-row` — one object = one row: chevron, name (`-rule-name`),
  a spacer, then the fate chips (`config-sync-fatechip`, rendered only when a fact deviates
  from default — `not installed here` · `desktop only` · `stays off` · `off here — your rule`
  / `on here — your rule` · `encrypted` · `your choice` once a conflict is resolved).
  **Chips are icon-only:** the glyph from `FATE_CHIP_ICON` (§2.3) with the chip
  sentence in the tooltip, a quiet faint cluster on the row's RIGHT just before the fate/state
  column — never tags trailing the name. Display order is the model's own emit order
  (`buildChips`, deterministic — the fixed ordering), never re-sorted at render. Icon-only
  chips fit any width, so there is no chip-overflow machinery and no mobile chip line
  beyond the skeleton rule below; a chip string missing
  from the registry keeps a text label as the loud fallback. After the chips comes the fate
  sentence
  (`config-sync-fate-text`: direction glyph + verbs describing everything the run will do to
  this row), and last the
  checkbox. The row element itself carries NO aria-label (Obsidian renders aria-labels as
  hover tooltips, so a row-level label pops over every blank stretch of the row; the path's
  homes are the card and Settings).
  **The checkbox has one meaning everywhere:** include this row in the next
  Apply/Capture run; selection never changes what would happen, only whether it happens. It
  is direction-colored (orange capture / accent apply, §1.1) like every other checkbox, and
  hidden entirely on inert rows (in-sync / nothing-yet / unresolved conflict). Expanding the
  row hides the fate SENTENCE only — the card's own `On apply`/`On capture`/`State` row becomes
  the single statement while open. The direction GLYPH stays, along with the chips and the
  checkbox: the card restates the sentence but never the direction, so hiding the glyph too
  would make expanding a row cost information rather than add it.
  **Containment (global, every platform):** names and section titles never truncate or
  ellipsize; chips never wrap
  or clip — a row's chip GROUP degrades together to icon-only + tooltip once it overflows,
  never a mix of full and icon-only chips; the fate sentence is the only sacrificial
  element, ellipsizing first and giving way to the bare direction glyph at minimum —
  chevron, checkbox, and count pill never shrink. **Mobile row skeleton:**
  line 1 is always exactly chevron + name + spacer + sentence +
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
  snippets`) replaces the joined pair outright.
  **Version drift is its own capture verb.** A row whose files match the store on both sides
  can still be capture-directional because the store's lock records an OLDER source version
  than the one installed now. That fact joins the verb chain with the same ` · ` grammar
  (`records version 2.2.3` for a plugin-anchored row, `records Obsidian 1.13.7` for an
  app-anchored one — App settings, Appearance, Hotkeys and the two plugin lists), and on a row
  with no other verb it stands alone. Such a card renders **no FILES row, correctly**: nothing
  in any file changes, and the sentence says so. The generic `Captures files` fallback must
  never be what a version-drift row degrades to — it promises an edit the run will not make.
  A conflict on any member,
  or actionable members split across both directions, renders the family `⚠ Changed on
  both sides` and reuses the existing Resolve grammar (`Use theirs ↓` / `Keep mine ↑`) at
  family level — no extra controls. Custom `+ Add folder` groups are not companions and stay
  their own object, rendering a plain label with no breadcrumb (`parentCardLabel`,
  `registry.ts`, never consults `settings.items.custom`). The legacy `enabled-css-snippets`
  switch list is likewise out of scope: it keeps the two-tone `Parent › `
  breadcrumb (`-rule-parent` + `-rule-parentsep`, `--text-faint`, `renderRuleName`,
  `SyncCenterView.ts`) ahead of the plain label, the same as any real companion. Inside the
  object grammar itself the breadcrumb survives in exactly one
  place: an orphan companion (its parent group not compiled locally) falls back to its own
  standalone row, breadcrumb included, as honest degradation — every other companion
  dissolves and is never its own row. (The breadcrumb also survives, outside the object
  grammar, in Settings drawers and run reports.)
  The pinned Config Sync self row (`.is-self`, Community section) is the one exception: no
  checkbox (it isn't staged through Apply/Capture), its own fate text reads `your Sync
  Center — manages itself`.
- **Checkboxes** — custom-drawn inputs (hub-row/mainbar/section-head): direction-colored
  when a row (orange capture / accent apply), bright grey (`--text-normal`) for
  select-alls (they carry no direction); idle select-all hides (`-selectall-idle`).
- **Action bar** `config-sync-actionbar` — staged count + solid direction buttons
  (`-btn-capture` orange; Apply = `mod-cta`); 0-item = same color at 0.5 opacity; btnwrap
  hosts the 2px progress bar + shimmer; `-runline` is the live status line. **The button's
  count is the count of STAGED ROWS** — the same number the footer summary states, never the
  length of the derived payload. A staged family row fans out into its own entry plus one per
  actionable companion before the run, so the payload is routinely larger than the selection;
  reporting that as "items" puts two disagreeing numbers on one screen and names an internal
  fan-out the user never chose. The run still executes every payload entry.
- **Type sections** `config-sync-card`; the list is four fixed sections
  (`config-sync-section.is-typesection`), fixed order, alphabetical within: `Obsidian` ·
  `Core plugins` · `Community plugins` (the Config Sync self row pinned first) · `Your
  folders`. Availability is row state (chips + fate sentence, Rows above), never a section
  of its own; only the store-orphan
  **Leftover** section (below) keeps a colored amber frame. A type section's own
  frame stays neutral — dashed when collapsed, solid when open — no drift-color borrowed
  from availability states. **Body fill:** the nested card stays
  unframed (`border: none`, `padding: 0` — same checkbox column as the main card)
  but carries its `--background-secondary` fill + `--radius-m` corners when open, so rows
  sit on a filled card and the header sits against the section's bare margin. A collapsed
  section builds no card at all, so it has no fill either — nothing to
  suppress, the dashed empty frame already reads as closed. **Real collapse:** clicking the
  header (`config-sync-section-head`) toggles the section, remembered per section for the view
  instance's lifetime (survives re-renders, resets on view close); header typography is
  uppercase, letter-spaced, `--font-ui-smaller`, `--text-muted` — sitting on the section's
  bare margin above the filled body, unmistakable as a header even with its trailing
  badge covered — and `padding-bottom: var(--size-4-2)` separates the head from the body by
  material contrast alone (no hairline), with the FOLD family's rotating `chevron-right`
  scaled to the header size. A checkbox click on the header stages; anywhere else on the
  header toggles collapse. A trailing count pill reads `N/M` under a filter; Core/Community
  carry a glyph-only header chip (`renderCarrierChip`): `share-2` when the list is shared,
  `square-split-horizontal` when it isn't (§2.3) — **read-only**: it only
  jumps to the carrier's own Settings card, where the sync toggle lives (§2.3). On desktop
  a bare count hint (`config-sync-section-hint`) follows the head — but ONLY while **two or
  more** sections have staged rows, and it reads the number alone (`2`), never `2 selected`.
  The hint exists to answer what the global footer cannot — WHICH sections the selection is
  spread across — so with a single staged section it has no question to answer and its
  `N selected` wording merely restates what the footer and buttons already say.
  Its `aria-label` still carries the full `N selected` sentence: the visible form is a number,
  the spoken form is a sentence. On mobile it does not render at all (the section checkbox's
  checked/indeterminate state and the global footer already carry it), the head stays one
  line, and the title is the only element allowed to wrap.
  Section select-all/clear targets actionable visible rows only —
  excludes the self row, in-sync, nothing-yet, and unresolved-conflict rows. Per-section
  trailing fold lines (`config-sync-unchanged`) aggregate only their own section's `N in
  sync` / `N with nothing to sync yet` (plain text, the leading `.config-sync-row-chevron` plus
  the fixed-size fold icon compose around it — no trailing triangle in the string),
  expandable in place. **Two axes of fold, in this order:** the three FATE folds
  (✓ / ⊘ / ○ — "is there anything to do") and then the four AVAILABILITY folds (`outdated` /
  `disabled` / `not-installed` / `desktop-only`, amber icons — "can this device do it at all"),
  each carrying the explanatory note the equivalent section used to (`AVAILABILITY_FOLD_NOTE`),
  rendered under the line while open. **Which of the two axes files a row is declared once**, in
  `ui/panelTaxonomy.ts`'s `placeRow`, not spelled inline where the folds are built — a row has a
  fate AND an availability at all times, so this is a decision with a reason, and the reason has to
  be somewhere a reader can find it. The rule: anything the next run would act on
  (`conflict`/`apply`/`capture`/`locked`) stays ACTIVE at the top with the work, wearing its own
  `not installed here` chip. Of the rest, `insync` and `nosettings` YIELD to the availability fold
  (`FATE_FOLD_YIELDS_TO_AVAILABILITY`) — both mean "nothing to do", and the availability fold says
  something strictly more useful about the same nothing. `excluded` **never yields**: it is a
  decision the user made about this device, not a fact about the machine, and the person who set it
  comes back searching for the words the `Not synced here` pill used. While availability won
  outright, such a row was counted by that pill and filed under `N not installed on this device` —
  a number with nothing behind it. `tests/panelTaxonomy.test.ts` pins the whole (fate × availability)
  table plus the invariant that a fold-owning pill and its fold describe the same rows. This axis
  split also restores what `987eacf` dropped when the list moved to type sections — those four
  groupings, with their copy — without folding away rows that have something to do. Switching into a filter
  pill or a search hit auto-expands every section once, on that transition only, so a
  manual re-collapse during the rest of that filtered/search session still sticks. Group
  headers `config-sync-sect` (uppercase + hairline) — used in the run-report breakdown.
  The remote pane groups its diff entries with the same type-section head family as the
  main list, in a static variant (`is-static`: no chevron, no collapse, no checkbox, no
  carrier chip, default cursor). Head and entry rows are direct children here (no nested
  card the way the collapsible type sections have), so the body fill does not reach it —
  filling the whole static box (head included) would be a different visual pattern from
  main sections (head outside the fill there). Matching the real
  head-outside/body-filled pattern needs a body wrapper element around the entry rows (a
  `.ts` DOM change) — deliberately deferred. Carrier divergence
  there renders as a pinned
  `On/off list · differs for N plugins` line (plain text, trailing rotating `chevron-right`)
  (`config-sync-remote-onoff`) whose
  expansion shows the per-plugin flips (`config-sync-remote-fliplist`) and the file diff.
  Companion families fold the same way here: companion diff entries merge into their
  parent's entry, each file re-pathed under a `<companion>/` prefix (e.g. `themes/Blue
  Topaz.theme.css`) and chip counts summed — one entry per family; a companion whose
  parent isn't known locally falls back to its own standalone entry (honest degradation,
  same rule as the carrier label fallback).
- **Expanded card (Sync Center row)** `config-sync-itemcard` — a quiet properties zone:
  no border, no fill, no radius. The zone
  is tied to its parent row by the **fold thread** (shared verbatim with the
  Settings drawer's `.config-sync-item-exp`): one faint 1px rule whose x sits under the fold
  chevron's center, running from just below the parent row to the zone's bottom — the line
  reads as "this content belongs to that fold" (file-tree/thread semantics) — while the
  content itself indents to the parent's TITLE-text start. Drawn as an absolutely-positioned
  `::before` (divider color at reduced opacity), never a `border-left` on the content edge
  (a line floating at the indent edge has no geometric relationship to the
  chevron). Rhythm comes from row padding alone — `config-sync-card-fieldrow` and the
  Settings drawer's `config-sync-card-rulerow` carry NO `border-bottom` (a hairline per row
  reads as a table embedded in a borderless panel). Every row
  (`renderCardKeyRow`/`renderMergedRow`/`renderCardIconActionRow`) shares ONE grid,
  `.config-sync-cardrow { grid-template-columns: 130px 1fr max-content }` —
  label | free | control — the control track LAST and content-sized, so every row's control
  anchors to the card's RIGHT edge, on the same vertical rule as the item rows' own checkboxes
  above it, at every viewport width. A control with no ⇕ of its own reserves that column
  (`--cs-chev-slot`) so the rail aligns glyphs, not box edges.
  (The Settings drawer's `.config-sync-scrow` speaks the same grammar — a wider 170px
  identity column, the three-slot controls column, the same right-anchored end — §1.4.) Wide
  rows (State/Resolve/After install/Enablement/Note) put
  their whole value in `.config-sync-cardval`, spanning tracks 2-4 as one cell (`min-width: 0`, no
  fixed narrow width — ellipsis is a last resort, never a first one, while the row still has
  room); icon-only rows (`.is-iconrow` — not `.is-compact`, which already names the
  narrow-viewport `.config-sync-shell` layout, an unrelated axis) put their one control on the
  last track instead. A row that builds no value renders nothing at all: no separator, no
  reserved height — built off-DOM first, appended only once non-empty. **Mobile:**
  wide rows stack to full width (label above a full-width value, CSS-only
  `flex-direction: column`), since Resolve's
  segmented control needs the full device width the shared grid's `1fr` remainder can't
  spare at ~360px; icon rows (merged control/More/Files) stay on the SAME shared grid at every
  width — there is nothing long to clip, only a glyph or a badge, and stacking them would silently
  re-introduce the cross-row misalignment the shared grid exists to remove. A section's nested
  `.config-sync-card` keeps every other card's horizontal padding and bleeds it back out with an
  equal negative margin: row content lands exactly where the section's own inset used to put it
  (one checkbox column, above), while the FILL reaches the section frame, 12px clear of the text on
  either side. The padding was zeroed instead until 2.25.0, on the reasoning that the section frame
  already carried the inset — but that inset sat OUTSIDE the fill, so fill and row text shared one
  edge. Barely visible on a wide desktop card; on a phone the words sit right on the colour and
  read as spilling out of the block. Standardized
  row set, in this order,
  each omitted when not applicable: `On
  apply` / `On capture` / `State` (the fate sentence expanded to a full clause — install
  source, update versions, capture consequence) · `Files` (collapsed by
  default — **ONE badge**, `config-sync-files-badge`: the direction's own icon and its count in a
  single pill carrying the direction's color, outlined while collapsed and filled (`.is-open`) while
  expanded. It replaced three separate marks — a bare direction icon, a neutral count pill and a
  rotating `chevron-right` — that all answered the same question, and made an 11px chevron the
  thing to aim at; the whole head is the click/keyboard target now, so nothing has to be aimed at,
  and `aria-expanded` carries the state the chevron used to draw. One badge is also why this is an
  icon row: the badge sits on the control rail with every other card control, and the entry list it
  opens is a SIBLING of the row rather than part of its value cell, so file names get the card's
  full width on phone and desktop alike instead of the grid's remainder. Expanding reveals the
  entry list, remembered per row while the pane stays open (`expandedFileRows`, a `Set` keyed by group
  name, cleared with `expandedItems`/`remoteFoldsOpen` when the pane closes); direction-aware
  entries — `+` /
  `~` / `−`, both directions — each ending in ONE 14px `file-diff` icon when
  diffable/viewable, never per-kind icons: the point is "changes live here, click to see,"
  tooltip `View changes` (diff) / `View content` (an added file, nothing local to diff
  against yet); the OPEN state turns the icon accent-colored; an encrypted entry keeps its
  no-affordance note instead; the `capFileEntries` 10-cap + "… N more files" line applies
  inside the expanded state) · `Resolve` (conflict rows only — segmented `Use
  theirs ↓` / `Keep mine ↑`) · `Enabled on` (plugins whose carrier is synced) / `After install`
  (carrier not synced, row installs) / `Enablement` (carrier not synced, plugin installed
  but locally off — the fallback ladder's third leaf) · `Settings sync` (the item's own
  file-level sharing rule) · `More` (icon-only deep-link into the Settings tab, scrolled to
  this item's own card — the whole sentence lives in its tooltip, no trailing `▸`) ·
  `Note` (honest runtime notes, e.g. Hotkeys' "Takes effect after an app reload"). While the
  card is open, the collapsed row's own fate sentence/glyph hides (Rows above)
  — the card's `On apply`/`On capture`/`State` row is the single statement; checkbox and
  chips stay. **The card has no destructive footer:**
  stopping a whole item's sync happens on its own Settings card, one gesture, one home —
  reached from here only through `More`.
- **Conflict resolution lives in the diff.** A diff in this plugin is never "how these two files
  differ": `diffPair`'s `produced` has already been through captureTransform/applyTransform, so what
  it shows is **what one CHOICE would do**. Direction is not a parameter for viewing a difference;
  it is the thing being viewed. That makes the control that picks a preview and the control that
  picks a side the same control, and it lives in the diff toolbar (`DiffResolveControl`,
  `diffView.ts`) — `Use theirs ↓ | Keep mine ↑`, the active side in its own direction colour.
  The card keeps its `Resolve` row for someone who already knows which side they want; both
  entrances route through one `pickConflictSide`, so they are one decision, not two that agree.
  An unresolved conflict renders its FILES row previewing the `Use theirs` side — it used to render
  no FILES row at all (the row was gated on a decided direction), which asked the user to choose
  with nothing on screen to choose from and revealed the files only after they had committed.
  **Scope is the item, and the UI says so when that matters**: a run writes a whole group
  (`ApplyItem`/`CaptureItem` carry a group name; `stagedMembers` is switch-list-only), so on a
  multi-file item a side picked in one file's diff settles its siblings — disclosed in a line under
  the toolbar, and omitted on a single-file item where the file IS the item. Open inline diffs
  survive the repaint a pick causes (`openEntryDiffs`, the same idiom `remoteFoldsOpen` uses):
  closing the evidence the moment someone acts on it is the opposite of what the control is for.
- **Merged two-layer control** (`config-sync-mergedctl*` classes, `ui/mergedControl.ts` +
  `ui/enablementRow.ts`) — one shape reused by four surfaces: a Sync Center row's
  `Enabled on`/`Settings sync`, a plugin card's `Enabled on`, a carrier card's element rows, and an
  item card's key rules and path row (Unified card below). It lands on the control track of the
  Sync Center's card grid (Expanded card above) and in the device slot of the Settings
  drawer's
  `.config-sync-scrow` (§1.4) — one control, so one cell on either surface, and every row's control
  on the same vertical rule. Shared glyph, a faint `·`, this device's glyph, then ONE muted PICKER
  `chevrons-up-down`; NO visible wordmark. Click (or Enter/Space) opens an Obsidian `Menu` whose
  two labelled sections are the two layers: `Shared with` (or `Enabled on`, on an on/off row) lists
  the four values `All devices` / `Desktop only` / `Mobile only` / `Not shared` (`sharingIcon`'s
  icons, `square-split-horizontal` for the fourth; the trigger's tooltip states the CONSEQUENCE per
  row kind, never
  the label — §2.3); `On this device` lists that layer's own answers
  (`buildLocalMenu`/`buildOptOutLocalMenu`, §2.3 — the latter shared by the whole-file opt-out and a
  per-key rule's own exception alike — which label the MENU ITEMS, a different string from the
  glyph's tooltip). The word "Default" is retired: it named nothing the interface ever showed.
  Both glyphs are ALWAYS visible; only the ⇕ picker hint hover-reveals (§2.3 hover-reveal law).
  Where the row has no local layer at all it renders one glyph and a one-section menu (§2.3). The
  per-key fallback replaces the shared half's LIST with a state line plus an action — `Per-key
  rules decide this` (`setIsLabel`, unpickable) then `Open the per-key rules` — on a dim `braces`
  glyph, the action being the same deep link the `More` row takes, only aimed at the rules
  themselves (`spot: "key-rules"`). One click more than the old bare icon, and in exchange the jump
  carries a label instead of a tooltip a phone never shows. It was ONE line for a while, sitting
  where the value stops sit with a checkmark slot of its own: every signal of something you pick,
  none of the behaviour. `After
  install`/`Enablement` keep their own textual triggers (`config-sync-menuchip
  config-sync-card-trigger` — no glyph vocabulary for them), styled to the same trigger-box
  family so the card reads as one control language regardless of trigger kind. A sharing cell with
  NO local layer stays a plain picker on either surface (`SettingTab.ts`'s `renderSharingPicker`):
  icon + `chevrons-up-down`, click opens a `Menu` of `options`, checkmarked on the current value —
  an array element's per-key sharing, a companion folder's device class, and the Advanced tab's
  custom-rule editor's own rule row (`buildFieldsEditor`), which offers the same
  `FIELD_SHARING_OPTIONS` values as an item card's key-rules row (still `airplay`/`This device`
  glyph, never renamed — §2.3) but paints no local layer, even though a custom item's
  compiled `SyncGroup` does carry the same `ItemRef` (`ref: itemRef("custom", name)`,
  `registry.ts`) an item card's key rows key their own exception by — the wiring simply never
  reached that editor.
- **Enablement rule (per-plugin, per-element)** — one rule per list element (a plugin, a
  snippet), stored on the CARRIER item that carries the list, set from any of the three
  entrances above through the one pair of producers `ui/enablementRow.ts`/
  `core/enablementRules.ts` share — never from the plugin's own settings-file
  entry, which the rule never touches. This device's own exception for that element
  (`config-sync-device-elements`, never inside `data.json`) is the local half of that same control,
  everywhere the element appears. A carrier's own sync membership — whether the Core/Community
  on/off list is itself a synced item — is edited from its own Settings card's sync toggle
  (Unified card below), never from the Sync Center (the section header's chip is
  read-only, Type sections above). The snippets on/off list keeps its own member devices on the
  Appearance card (Unified card ③ below) — same mechanism, same row shape,
  fewer surfaces because it has no carrier card of its own.
- **Remote** `config-sync-remote-btn` is-pull/is-push (solid cyan/pink when primary,
  dimmed otherwise); diff entries reuse report rows + chips.
- **Reports** `config-sync-report-*`, chips, `-strip` result strip — outcome-toned: green
  only when the run is clean, `is-warn` orange / `is-error` red otherwise; it sits in a
  sticky `-strip-dock` (opaque backing, pinned to the top of the scroll viewport) so the
  outcome survives scrolling.
- **Form errors** — validation errors are ONE framed family: `config-sync-form-error`
  (shared with the row-pinned `config-sync-save-error`): a warning-tinted strip
  (`rgba(var(--color-orange-rgb), 0.08)` fill, 0.4-alpha border, `--radius-s`,
  `--text-warning` text, `:empty` renders nothing — never a bare `mod-warning` paragraph),
  pinned as close to the offending control as the surface allows: under its own card/row,
  page-level only for list-level facts. **One sentence shape everywhere a message can fail:**
  `<subject>: <what is wrong>. <what to do>.` — two short sentences, **no dash joining them**, with
  example values shown without JSON syntax (`Remote "kickstart": a URL is required. Point it at the
  git repository, e.g. git@example.com:me/config.git`).
  Runtime outcomes keep their own strips but the same shape: a headline sentence plus, only when
  there is one, a second quiet monospace line (`config-sync-strip-detail`) carrying the raw
  technical detail — never spliced into the headline. That splice is what produced
  `Could not reach remote — git ls-remote --heads failed in .: Command failed: git ls-remote
  --heads fatal: bad repository ''`: three restatements of one failure with the only informative
  clause last. The detail line never inherits the strip's tone color; a red command line reads as
  more alarm than it is.
- **History** `config-sync-htable` (desktop 7-col table) / `config-sync-hcard*`
  (`-hcard-top/-act/-chev/-when/-sum/-foot`, `-hcard-pill.is-chg` neutral / `.is-iss` orange) —
  the run-history list; the view swaps table → card layout when compact (`<700px`) so mobile
  reads top-to-bottom without horizontal scroll (`-hcard-sum` wraps; `-hcard-act` `min-width:0`).
  Head/legend and the `renderActionInto` action painter are shared by both layouts; detail view unchanged.
- **Header status bar** — **self chip** `config-sync-self-chip` (is-up/down/ok tints) +
  `-self-chip-ic`, `config-sync-head-divider`, then the pills; push/pull totals use
  `config-sync-pill.is-push` (pink) / `.is-pull` (cyan). The bar ends in the one
  right-aligned refresh control (`config-sync-center-refresh`, `refresh-cw`): no `refreshed
  …` text span — the age lives in the button's own tooltip (`Refresh — refreshed just now`
  / `… 5m ago`, `relativeAge`), same on desktop and mobile.
  BUSY STATE (`src/ui/refreshControl.ts`, builder + in-place repainter, the `resolveSegment.ts`
  split): the icon spins (`config-sync-refresh-spinning`) and the tooltip becomes `Refreshing…`
  — the age is dropped while the number it quotes is about to change. Busy spans the WHOLE gesture,
  both the remote sweep and the local re-scan, and is the view's own flag rather than a reading of
  `remoteRefreshProgress()`: that progress is per-remote, desktop-only, and could only be observed
  by a render, while every progress tick starts a `reload()` that abandons the previous one — so the
  only frame that ever reached the screen was the not-busy one. The control is therefore painted
  directly, never via `render()`. A re-entrant click is dropped (the local half does not de-dupe on
  its own), and the spin is held to a `MIN_SPIN_MS` floor so a fast refresh reads as a refresh
  rather than as a dead button. `remoteRefreshProgress()` keeps its two real consumers: the
  per-remote spinner in the sidebar and the aggregate line on a remote's pane.
- **Status bar item** (`src/ui/statusBar.ts`, rendered by `main.ts`) — plain colored text
  segments, no pill backgrounds; colors identical to the header pills
  (`is-up` orange, `is-down` accent, `is-push` pink, `is-pull` cyan). Clean state = a dimmed
  `refresh-cw` icon only (`--text-faint`). `mod-clickable`; aria-label lists the non-zero parts
  (`Config Sync — 2 to capture · 1 to apply · 1 to push`).
- **Advanced rule editor** (the custom/discovered rule form, `renderRuleForm`): a
  VERTICAL form of scrows (`config-sync-advform` wraps it; each row is a
  `config-sync-advrow`, `label 130px | control 1fr`), one field per row.
  NAME: input, placeholder `e.g. templates` (the charset
  constraint appears only in the validation error, never as placeholder implementation-speak).
  PATH: one composite input box (`config-sync-pathbox`) whose LEADING segment is the location
  mini-menu (`Vault root`/`Config folder` + ⇕, an Obsidian Menu) separated by a thin divider
  (`config-sync-pathbox-div`) from the borderless path input — pick the base, then type the
  relative path in the same box.
  TYPE: icon-only picker (`file`/`folder` glyphs, tooltip `File — syncs a single file` /
  `Folder — syncs everything in it`, ⇕ on row hover); on a DISCOVERED rule it renders dim with
  no menu (tooltip `File — decided by the file itself`) — the file fixes name, path AND type;
  on a custom rule a type flip that would drop stored key rules or an encryption mode confirms
  first (`Change to folder?` / `Change to file?`, body `This removes its key rules and
  encryption settings.`, Cancel + warning-toned `Change type`). DEVICES: the panel's own
  sharing picker.
  MODE: a text menu picker with the §2.2 display names (Whole file / Per-key rules /
  Encrypted); pinned-to-Per-key items render it dim + tooltip, no menu; leaving Per-key rules
  while key rules exist confirms (`Switch mode?`, body `This removes N key rule(s) — each
  key's sharing and encryption choices are lost.`, Cancel + warning-toned `Remove rules and
  switch`). DESCRIPTION: input, placeholder `optional`. Placeholders across the form are
  faint/italic.
  A DISCOVERED rule's drawer opens with a read-only FILE row (mono store-relative path) — the
  drawer must name the file it belongs to, since it has no Name/Path inputs. The Discovered
  list itself is ONE stably-sorted list (by file path), adopted or not — adoption changes only
  the row's own toggle/chevron, never its position — and a failed adopt pins a form-error strip
  under its own row.
  **Per-key rules speak the card's grammar**: each configured pattern is a
  `config-sync-card-rulerow`-family scrow — mono pattern (+ a faint `detected` tag), then the
  card's own sharing picker (with `Remove rule` as the menu's warning item) and three-state
  lock; the lossy single-select action dropdown does not exist. Below the rows, a File preview
  (same `config-sync-json-*` treatment, `Click any key to add a rule for it` hint, keys colored
  by rule, click-to-add) renders for file-type rules; the raw
  `Add key pattern…` input stays as the glob escape hatch, last.
  Every per-key edit (lock, sharing, remove, per-item flip, click-to-add, glob add) rebuilds
  ONLY the fields-editor panel — detached build, child swap, File-preview scroll carried
  across, a generation guard against superseded reads — never the whole tab (whose re-render
  re-enters the editor's async file read and visibly collapses/re-expands the page). A failed
  save still falls back to the full refresh, which renders the pinned save-error row. Because
  the surrounding form outlives those rebuilds, its destructive-change guards (MODE leaving
  Per-key, TYPE flip) read the rule from current state at click time, never from the
  render-time snapshot.
  A failed save pins its
  error inline with the CONCRETE reason — the no-error sentinel is `null`, never `""` (an
  empty-string sentinel collides with the unnamed placeholder rule's empty name, making a
  SUCCESSFUL save on the unnamed row read as a blank error).
- **Remote editor** (`renderRemoteForm`): the SAME vertical form grammar on a
  wider label track (`config-sync-remrow`, `label 150px | control 1fr` — the longest label is
  `STORE FOLDER IN REPO`). TYPE: a text menu picker (`config-sync-menuchip` + ⇕, same idiom as
  MODE). NAME: input, placeholder `e.g. work-laptop`,
  required-`*` on the label (`config-sync-required`). Vault type —
  STORE PATH: the path input inside a `config-sync-pathbox` whose TRAILING segment, behind the
  thin divider, is the `folder-open` Browse… icon (desktop only). Git type — URL / BRANCH /
  STORE FOLDER IN REPO inputs, ACCESS TOKEN (Obsidian's secret picker in
  `config-sync-secret-control` — sized to the shared 380px input track, its empty placeholder
  child hidden so the Link button sits flush with the inputs above). The standing explanation
  (`For https URLs. Without a token, this device's own git sign-in is used. Stored in
  Obsidian's keychain — link it once per device.`) lives in the control's tooltip, never a
  row; a status sentence renders on a label-less row ONLY when it has something to say
  (`✓ Token stored on this device.` / the ⚠ not-linked-here warning) — the default state
  renders no row at all. Then a label-less `Test connection` row + the full-width test strip. **No Username field**: a
  linked token is enough — live-tested against a self-hosted GitLab as well; a `username`
  already stored in `data.json` still validates and still reaches git auth
  (types/manifest/resolveGitToken carry it), it just has no UI. The
  `Keep Config Sync's own settings out of this remote` toggle row closes the form
  (`excludeSelf` — live on the whole pull/push/compare chain). Every handler is
  `draft.x = …; saveRemotes()` behind the settingsWritable guard.
- **Beta tab header**: the BRAT map note is a quiet one-line status
  (`config-sync-beta-mapnote`: muted text `Matched from BRAT's beta list · N of M repos
  resolved` + a small `rotate-cw` re-scan icon) that renders ONLY while something is
  unresolved (a fully-resolved list is noise; the install path self-heals with its own
  last-chance re-scan). No subtitle line on any picker tab — the cards
  themselves say what syncs.
- **Self pane** (Config Sync's own state) `config-sync-self-pane` — `-self-title/-self-title-ic/-self-title-sp/-self-sub`, `-self-settings-btn`/`-self-settings-ic` (title-row Settings), `-self-block/-block-h/-block-s`, membership delta `-self-delta/-self-drow/-self-dg`, `-self-viewchange` (expandable `data.json` diff), `-self-pill/-self-hint/-self-caution/-self-acts`.
- **Qualifier autocomplete** `config-sync-qac/-qac-opt` (is-sel)/`-qac-ic/-qac-txt/-qac-desc` — the `key:value` search dropdown under both search boxes, anchored by `config-sync-search-wrap`; opens on focus (an empty box lists every key), key→value suggestions, keyboard-navigable. Logic in `src/ui/qualifierSearch.ts`.
- **Settings tab** (`src/ui/SettingTab.ts`): `config-sync-tabs/-tab` (phone hides inactive
  labels — the pattern the mobile filter pills echo), rows/expand/form-*, fields editor
  (`-fieldrow/-ftag/-act-btn`), remotes forms + `-test-strip`, search (`-hit/-sectiontag`),
  passphrase `-ppset/-ppbadge`. Picker tabs carry no subtitle line (see Beta tab header
  above — the cards themselves say what syncs).
- **Modals**: pull-conflict `config-sync-cm-*` + `diffView.ts` (shared diff panel:
  Unified/Split toggle desktop-only, **Collapse/Full toggle both platforms** folding
  unchanged runs into `-cm-dgap` "⋯ N unchanged lines ⋯" rows); exclude-extras
  `-exclude-row/-modal-buttons`. Cold-start adopt is not a banner: the self pane (above)
  renders the coldstart state and drives it via `adoptConfiguration`.
- **Cold-start guidance banner** `config-sync-coldstart-*` — accent-tinted
  banner above the result strip in item mode, shown only while the plugin's own settings are
  pending (coldstart/adopt/both) AND some group has never synced here (`showColdStartBanner`);
  "Review settings →" routes to the self pane; dismissal (Lucide `x`) is device-local and
  resets when self returns to insync. Adopt itself still lives in the self pane, never in the
  banner.
- **Leftover store files** — store orphans have no registry item and never become rows in a
  type section; they get their own always-open amber `config-sync-section.is-leftover` and a
  CONDITIONAL filter pill:
  - **Filter pill** (`config-sync-fpill is-leftover`): renders only while the store has orphans
    (an empty bucket renders nothing, same as every other pill), last in the filter row, amber;
    long form `Leftover N`, short (mobile) form `⌫ N`. Click narrows the view to the Leftover
    section alone (`filter: "leftover"` — type sections hide); `All` returns. The section body
    renders under `All` and `Leftover` and stays hidden under every other filter and while
    searching.
  - **Adoption gate**: while Config Sync's own state is pending adoption (self pane `coldstart`,
    or a store-newer adopt state), "leftover" is not a judgment this device can make — the
    section AND the pill are replaced by one quiet hint line (`config-sync-leftover-hint`, muted,
    dashed frame): `Some store files aren't tracked here yet — adopt the configuration first,
    then anything truly left over shows up for cleanup.` A self state that is merely
    capture-pending (this device's own config is the newer side) does NOT gate — stopping a sync
    here legitimately produces leftovers before the next capture.
  - **Head**: the section-head family's uppercase/letter-spaced/`--font-ui-smaller` typography,
    painted `--color-orange` (the one amber head — a 600-weight header is a title, not a textual
    note, so it takes `--color-orange`, not `--text-warning`); count is the neutral pill. The
    section folds exactly like a type section: the FOLD chevron leads the head, clicking the head
    toggles in place, the state is remembered for the view instance's lifetime, and the default
    is collapsed — activating the Leftover pill auto-expands it once (the same
    auto-expand-on-activation rule the filter transition uses), so a manual re-collapse inside
    the leftover view still sticks. At the head's right edge sits the bulk delete: a `trash` icon
    (quiet-rest;
    hover/focus red at full opacity), tooltip `Delete all — N files…`, and the trailing ellipsis
    keeps its promise: click opens a confirm modal (`Delete N leftover files?` / body `Removes
    these files from the store on this device.` / warning `After your next sync or Push, they are
    gone from your other devices too. This cannot be undone.` / `Cancel` + warning-toned
    `Delete N files`). Its click never doubles as the fold toggle (same carve-out as a section
    head's checkbox), and it stays reachable while the section is collapsed. The per-row delete
    stays one-click (no modal) — same `trash` icon, tooltip `Delete from the store`.
  - **Subtitle** (`config-sync-section-note`, this class's only producer): upright (never italic
    — italic is the placeholder/empty-state voice), aligned to the title's own start (no chevron
    indent to inherit), copy: `Settings saved for items nothing here syncs any more. Deleting
    removes them from the store — and from your other devices after the next sync.`
  - **Rows** (`-oflow`: name / mono path / size / trash icon), grouped: the list is bucketed
    into the main list's own section vocabulary — Obsidian · Core plugins · Community plugins ·
    Other files (vault-root and unclassifiable) — under `config-sync-sect` group headers (the
    run-report breakdown's uppercase + hairline family); an empty group renders no header, and
    rows sort alphabetically by name within their group. The name slot never shows a raw store
    path — it names the file's REAL owner, resolved through a fixed chain: a plugin file names
    its plugin (the store lock's `display.label`, else the locally installed manifest's name,
    else the bare id — the same fallback the main list's display-name chain ends in); a
    snippets/themes file names its basename behind an `Appearance › ` breadcrumb (the owning
    card, the same `Parent › ` grammar companion rows speak); a config-root file whose basename
    a core plugin or an Obsidian card owns names that owner; everything else names its basename.
    The mono path line below stays the full store-relative path, ellipsized with the full
    path in its tooltip. Size and the trash icon are `flex: none` — the info column is the only
    element that gives way, on every viewport; rows stay single-line on mobile.
  - Frame/title stay amber (state ≠ category) — dashed when collapsed, solid when open, the same
    frame grammar as every section; its nested card picks up
    the same body fill as any other section, unaffected by the color accent (the fill lives on
    the card, the accent lives on the section's own border/title). Removal kinds in History
    render `⊘` (stop-sync) and `⌫` (delete-leftover), muted.
- **Unified card** — ONE row + drawer renderer for every synced
  item (`SettingTab.ts`'s `renderItemCard`, driven by `registry.ts`'s `ItemDef`); no kind
  branches: an Obsidian option group, a core plugin and a community/beta plugin all
  render through the same function — a core plugin whose settings file hasn't been written
  here still gets the full card, since its path is synthesized from the plugin id.
  - **Row** `config-sync-item-wrap` — chevron, name, then (right side, inside the control cell
    just before the sync toggle) the badges: **icon-only with a
    9px corner count** (`config-sync-card-badge` + `-badge-ic` + `-badge-cnt`, tooltip = the
    sentence; a registry-missing badge falls back to loud text; the digit renders only from 2
    up — a corner "1" says nothing the icon doesn't). Order per `computeBadges`
    (itemCard.ts): `on/off only` → `toggle-left` grey · `desktop-only plugin` (manifest
    `isDesktopOnly`, an INNATE property) → grey `monitor` · the enablement badge when
    non-default (a local exception outranks the rule, same precedence as at run time; a rule
    shared with no one, and no exception, earns no badge) → YOUR-RULE color: blue `monitor`
    `on: desktop` / amber `smartphone` `on: mobile` / pink `power` `on: this device` or
    `power-off` `off: this device` — the badge names WHICH exception, in both the word and the
    glyph, because it fires for either and a plugin forced OFF here must not read as on; grey =
    innate, colored = your choice (the two desktop meanings must read apart) ·
    carrier cards' two counts (`carrierBadgeCounts`): `N device-scoped` (class rules only) and
    purple `N left to me` · `lock`+n `N encrypted`;
    **a count badge names the SPECIFIC thing when everything it counts agrees, and falls back to a
    neutral summariser only when the set genuinely mixes** (`soleKind`, itemCard.ts) — all-desktop
    pins draw `monitor`, all-mobile `smartphone`, mixed `contrast` (one thing, two different sides);
    all-on exceptions draw `power`, all-off `power-off`, mixed `user` ("answers this device makes
    for itself", echoing the sentence's own "me"). Never `monitor-smartphone` for `N device-scoped`:
    that is `All devices`, the opposite of what the badge counts. Never `square-split-horizontal`
    either — that is the
    shared answer's "not shared at all", a different fact. The badges are walked by the glyph guard
    (`tests/fateChipIcons.test.ts`); they were outside it until 2026-08-17, and three separate badge
    glyph/copy defects lived in that blind spot at once;
    a zero count never renders. Then the sync toggle. No mode chip — mode is a derived,
    drawer-only state (`deriveMode`), never a header control.
  - **Drawer** `config-sync-item-exp`, up to three zones, every row across all three a
    `.config-sync-scrow` — `identity 170px | controls 1fr | trailing minmax(44px, max-content)`,
    the controls column the fixed three-slot grid (§1.4:
    aux `list-checks` (the path row's own aux slot stays empty — its eye rides the filename
    line instead, zone ② below) | lock | device picker or the merged control — same-type controls
    one strict column each, device last). Identity holds the row's name (an uppercase zone label, a
    mono key/filename, or a member name). Only a folder row's sync toggle anchors to the drawer's right edge
    (`.config-sync-scrow-end`, the card-toggle rail); there are no inline ✕ buttons — a
    removable row's REMOVAL lives in its own scope picker's menu, after a separator, as a
    warning-red `trash` item (`Remove rule` on a key-rule row, `Remove folder` on a
    user-added folder row; presets and non-removable rows offer no such item). The drawer itself
    anchors to its card by the fold thread (see Expanded card above, one treatment on
    both surfaces).
    A drawer sharing control with no local layer is one picker icon (`config-sync-sharingicon`,
    `renderSharingPicker`): the glyph IS the state (`sharingIcon`: monitor+smartphone = All
    devices, monitor = Desktop only, smartphone = Mobile only, airplay = This device — except a
    key-rules row, which carries a local layer and so is the merged control instead, its fourth stop
    `Enabled on`'s own `square-split-horizontal` = `Not shared`,
    §2.3), a click opens an
    Obsidian `Menu` of that row's own option list, checkmarked on the current value, tooltip
    naming the per-key CONSEQUENCE (`Desktops share one value. Each phone keeps its own.` and its
    siblings, never the label — §2.3); the `all` default sits at quiet-rest (0.45) and any
    narrower sharing
    renders `.is-set` (accent, full opacity). ① and ②
    render only when they apply, ③ Folders always renders (down to just its quiet
    `+ Add folder` row, `config-sync-add-row-quiet`, when a card has no folders yet) except
    on carrier cards (③ below):
    ① **Enabled on** (plugin cards whose def
    carries an `enablement` projection) — the merged control (`ui/mergedControl.ts`,
    above), not a single picker: its shared half writes the carrier's `perElement` rule
    (`core/enablementRules.ts`, never this plugin's own settings-file entry); its local half
    writes this device's own exception (`core/deviceElements.ts`, never inside `data.json`). The
    local half is editable under every rule — an element's on/off state has to come from
    SOMEWHERE, so this device can always claim it: with no exception it shows the follow glyph
    (`equal`, tooltip `This device: follows what's shared.`), with one the purple
    `power`/`power-off` (tooltip `This device: always on.`/`always off.`). Only the MENU changes
    shape: under `Not shared` its `Follow what's shared` entry is absent, because there is no
    shared answer to follow — and landing on that stop for the first time seeds the exception with
    the plugin's CURRENT state (`ruleLandingNeedsSeed`), so switching to it never itself flips the
    switch. (A per-KEY rule is the opposite case and drops the local half entirely under `Not
    shared` — for a key, "no shared answer" means the value simply stays put, leaving this device
    nothing to decide. §2.3.)
    ② **Settings sync** — mode is derived, never chosen: no per-key rule anywhere (`rules` and
    `perElement` both empty) is whole-file state, any rule is per-key state. The path row
    (`config-sync-card-sfhead`, a scrow) IS the zone header — no separate
    label line: its identity cell stacks the uppercase `SETTINGS SYNC` label over the mono
    filename; the `eye` (`config-sync-card-previewicon` — the File
    preview trigger, see below) rides the filename's own line instead, **hugging the filename's
    right edge** (a gap inside the pathhost flex, at the family size and quiet-rest shade). It
    must NOT be pushed to the line's far end: that line spans `1 / -1`, so `margin-left: auto`
    would anchor the eye to the CARD's right edge and invent the action column §2.1 forbids.
    `.config-sync-scrow-end` is equally wrong — the fixed trailing track, which would overlap the
    filename line's own `1 / -1` span. The controls cluster holds the lock toggle
    (`config-sync-lock`, which encrypts the whole file) and, in the device slot, the merged control
    (§2.3): its shared half is the 3-option whole-file sharing (no `This device` — `FileSharing`
    excludes it by construction), its local half THIS device's own opt-out of the whole file
    (`config-sync-device-optouts`, the same answer the Sync Center's own `Settings sync` row shows).
    The lock stays its OWN control beside it: a toggle folded into a control whose whole job is
    "open a menu" would cost its one-click flip for nothing.
    **The lock toggle is THREE-STATE everywhere it appears** (`renderLockToggle`, shared by this
    path row and every rule row): unencrypted-but-available paints an OPEN lock
    (`lock-open`, muted — a closed lock reads as already-encrypted); encrypted paints the closed
    `lock`, `.is-on` cyan; and a lock that can neither show state nor take a click (disabled AND
    unencrypted) paints NOTHING — its empty slot keeps the lock column, and no tooltip attaches
    to the blank space. Only disabled+encrypted, unreachable through the UI
    today, still paints a dim closed lock: state is never hidden.
    The path text itself is the edit entry point
    (`config-sync-card-pathbtn`, hover = dotted underline + soft backdrop; `.is-custom` accent
    once a custom path is committed): click it and the identity cell swaps to an input — Enter/blur
    commits, Escape cancels via a keymap `Scope` pushed while the input is focused (Obsidian's
    own Escape handling would close the settings window otherwise), and a committed custom path
    shows a quiet `Reset to default` text action (`config-sync-reset-link`, registered on
    mousedown so the input's blur-commit can't tear it out first) inside the edit row. In
    whole-file state the path row's sharing/lock read `item.settingsFile.fileRule` live; per-key
    state never reads that field for display at all (§3.2 — `compileSingleFile` stops compiling
    it the moment the group turns fields-mode, so a whole-file rule left over from before the
    first per-key rule would state a value nothing enforces any more; it survives in
    `data.json` only because `pruneSettingsFile` still needs it for a clean round-trip). The
    control keeps both halves — the local opt-out is a different datum and still works — but its
    shared half has no value to pick, so it contributes ONE menu entry instead of a list of stops:
    two lines — `Per-key rules decide this` (a `setIsLabel` state line, not pickable) then
    `Open the per-key rules` — on the same dim `braces` glyph the trigger shows. One line carrying
    both read as a value stop and behaved as a link; and BOTH surfaces now read the same two
    constants (itemCard.ts), which is what ended one fact being spelled `— opens Settings` in the
    Sync Center and `— jump to them` in Settings.
    Choosing it scrolls to the rules and flashes `config-sync-search-highlight`, the SAME class the
    search bar's own card jump uses. The jump's TARGET is wherever the rules actually live: the
    `KEY RULES` panel when there is one, else — for a card whose only per-key entries are
    enablement-list keys, which `buildRuleRows` filters out of that panel while `deriveMode` still
    counts them — the companion row that carries the key, found through the declared
    `presetCompanions[].mapKey` link (`data-cs-mapkey`), never a hardcoded branch. Appearance is
    that case: its single rule is `enabledCssSnippets`, whose rows live under `Folders → snippets`.
    The lock slot renders nothing (three-state rule above),
    and — under their own `KEY RULES` zone label — a rule row
    (`config-sync-card-rulerow`, a scrow) appears per configured
    key — never every key in the file, only ones with a rule; browsing the rest is File
    preview's job (below). A rule row's identity is the mono key itself; its cluster is
    (for a string-array key) the per-item icon toggle (lucide `list-checks`,
    `config-sync-perelement-ic` — off at quiet-rest / on `.is-set` accent, disabled+dim while
    the rule
    is encrypted, tooltip `Per-item device rules — each item gets its own rule`) — flip it on
    and each element gets its own scrow
    (`config-sync-card-elrow`) instead of one rule for the whole key — then the lock, then the
    merged control in the device slot: shared half = the key's own sharing rule, local half = THIS
    device's own exception for that key's rule pattern (`config-sync-device-fields`, keyed by
    pattern, `core/deviceFields.ts`). Two rule rows carry no local half, and then show one glyph and
    a one-section menu (`ruleRowHasLocalLayer`): a key with per-item rules on (its items are
    governed one at a time, and those have no this-device layer) and a `Not shared` key (nothing
    entered the store, so there is nothing to opt out of). The rule's REMOVAL is the warning-red
    `Remove rule` item at the end of that same menu, after a separator and under no header.
    Removing the last rule flips the card back to whole-file state. File preview: the `eye`
    icon beside the filename is the trigger (aria-label/tooltip `File preview`,
    keyboard-accessible like the FILES row's
    `file-diff` icon, `.is-open` turns it accent-colored the same way); it expands into the
    read-only `data.json` preview (`jsonView.ts`) below the rule rows — collapsed by default, so a
    card with no rules never reads its file at all. **Key clickability is explicit** (users
    didn't realize keys were clickable): a persistent action line sits ABOVE the
    preview (`config-sync-json-hint`: a `plus` icon + `Click any key to add a rule for it`), and
    EVERY un-ruled key — not just detected ones — renders with a dashed faint underline
    (`config-sync-json-clickable`); hovering turns the underline solid/accent and reveals a small
    `+` after the key. Keys are colored by rule; the color-dot legend
    (`config-sync-legend-dot`) underneath carries ONLY the color/lock notes —
    the click hint lives on the top line, never trailing the legend. A lucide `lock`
    (`config-sync-json-lock`) marks an encrypted key, `--color-purple` = detected-but-unruled,
    faint = plain; a `perElement` array colors each element the same way. Clicking a key adds a
    rule for it directly (promotes the card to per-key state); a carrier card's preview keeps
    all of this suppressed (no hint line, no clickable affordance — its elements' rules live on
    the element rows).
    Between ② and ③, the two carrier cards (`core-plugins`/`community-plugins`) add one
    more zone — `carrierListFor(def)` is what makes a card a carrier, and is the one place that
    identity is decided: a zone-header scrow whose track-1 label is `Enabled on`
    (`ENABLED_ON_LABEL` — the SAME word zone ① uses, because it is the same datum; the full
    sentence lives in the header's tooltip:
    `CARRIER_ELEMENTS_LABEL` = "Which devices turn each plugin on"). Nothing heads track 4: the
    `this device` column head retired with the eyebrow it was promoted from, and that word now
    appears once per MENU (its `On this device` section) rather than once per panel.
    Then one merged-control row per element (`buildCarrierElementRows` — every element
    installed here, plus any element that carries a rule or a local exception even if it isn't,
    since an uninstalled plugin's fleet choice still needs a card to live on), each row identical
    in shape to zone ①'s single row above, sorted by label. The snippets on/off list has no card
    of its own — same row shape, same producers, rendered inside the Appearance card's `snippets/`
    companion folder (③ below) instead.
    ③ **Folders** — preset (`themes/`, `snippets/`) and user-added vault-relative
    folders, each a scrow (`config-sync-card-companiongrid`): identity is the path
    plus a collapsed member count — a `config-sync-pill is-neutral` bare number
    (`config-sync-card-membercount`, same neutral-pill family the panel's other counts use),
    aria-label/tooltip the full `N themes`/`N files` sentence (`memberCountLabel`) —
    then the FOLD family's rotating `chevron-right`
    (`config-sync-card-memberarrow`) — click the
    row to expand its member list, while the folder name itself (same `config-sync-card-pathbtn`
    affordance, click/keydown stopPropagation so it never doubles as the member toggle) opens the
    Save/Cancel path-edit row (autofocused; Escape cancels via the same keymap `Scope` as the
    settings-file path row); the controls cluster is device-sharing picker → sync toggle
    (scaled a notch below Obsidian's default so the cluster reads as one row of quiet controls).
    A user-added row's removal is the warning-red `Remove folder` item in its own device-sharing
    menu (a preset is only ever relocated via
    the warning-gated path edit, never removed outright, so its menu has no such item). A
    trailing quiet `+ Add folder` row
    (`config-sync-add-row-quiet`, never a full-width button) closes every card (a card with
    zero rows renders no `Folders` header, just the Add-folder row) — EXCEPT a carrier's:
    the two switch registries are lists of on/off choices, a folder has no
    meaning attached to them (syncing an arbitrary folder is the Advanced rule form's job), so a
    carrier card renders no Add-folder entry point at all; a legacy user-added folder on a
    carrier, if one exists in config, still renders its row normally — visible and removable,
    never silently active. Opening
    `snippets/` lists members (`config-sync-card-snippetmembers`), each its own sharing icon — it
    writes `enabledCssSnippets` AND decides whether the file itself travels — the only companion
    whose members carry a sharing control (shared-layer only: identity name + a one-glyph,
    one-section control in the device slot, since a snippet member has no local-exception
    layer for a second half to speak for); a plain
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
  - **Release notes**: what each release changed goes in `CHANGELOG.md`, and what a user must
    do before syncing again goes in `UPGRADING.md`. Neither is duplicated here.

## 5. Conventions

- Theme variables only; the no-hardcoded-color script is a release gate. Alpha via
  `rgba(var(--*-rgb), α)`.
- Mobile scoping: `body.is-mobile` for panel rules, `body.is-phone` for settings-tab
  layout collapses (phones only; tablets keep desktop settings layout).
- Every UI change: design first (update this document; the owner approves a visual draft
  for visual changes) → implement → dev-vault probe/screenshot verification
  (desktop + 390×844 emulation) → gates. Alignment claims are probed, not eyeballed.
- Copy: sentence case; "selected" not "staged"; idle states render nothing.
- New icons come from Lucide via `setIcon` or the glyph vocabulary (§2.4); no emoji in
  chrome (they ignore theme colors) — see Open items #1 for the remaining text glyphs.

## 6. Open items

Decisions still pending; none change behavior silently. (Resolved audit findings are folded
into the sections above — this list holds only what is still open.)

1. **Remaining text glyphs**: ＋/＝/⌂ and the ⚠/✗/✓ status set render monochrome and can
   stay (the panel purged emoji because they ignore theme color; pure-text glyphs don't).
   No action unless a themed variant is wanted.
2. **Micro px font sizes** (9.5–10.5px: side badges, ftag, act-btn, sect-count, seg-label,
   cm-kind, cm-viewbtn): below `--font-ui-smaller` and not theme-responsive. Options:
   normalize to `--font-ui-smaller`, or bless a documented "micro" tier. (Checkbox pseudo
   12px marks are geometry-tied; keep.)
3. **Text-on-fill variable split**: accent fills use `--text-on-accent`, orange/cyan/pink
   fills use `--background-primary`. On themes with a light background-primary + light
   accent text these diverge. Candidate: `--text-on-accent` everywhere.
4. **Nine border-radius tiers** (3/5/6/8/9px + s/m + 999 + 50%): candidate collapse to
   `--radius-s`/`--radius-m`/999/50% + checkbox 3px/6px. Visual churn — low priority.
5. **`.config-sync-fpill` double duty** (panel filter pills + settings search section pills):
   intentional sharing, but a settings-side tweak can silently restyle the panel. Candidate:
   document as shared (this doc) or split the class.
6. **`-cm-unified`** is the one TS-only class still undecided (style it or bless it as a
   semantic hook). The deliberately unstyled structural anchors — kept as query/layout
   hooks, no CSS on purpose — are: `config-sync-card-companionzonehost`,
   `config-sync-card-memberhost`, `config-sync-card-sfbodyhost`, `config-sync-cm-diffhost`,
   `config-sync-remote-pane`, `config-sync-remote-summary`, `config-sync-settings-body`,
   `config-sync-sources` (all locatable by class name; line numbers rot, symbols don't).
