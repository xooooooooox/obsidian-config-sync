/**
 * The MODEL behind the merged two-layer control (painted by `mergedControl.ts`): what the shared
 * answer and this device's own answer each SAY, and what the control's menu offers for each.
 *
 * Four surfaces render it — a Sync Center row's `Enabled on`/`Settings sync`, a plugin card's
 * `Enabled on`, a carrier card's element rows, and an item card's per-key rule rows — and they must
 * say the same thing, so the words are decided once, here, and the renderers only paint them: a
 * glyph per layer, one PICKER `chevrons-up-down`, and an aria-label built by the exported functions
 * below — never a hand-spelled string at the paint site.
 *
 * Both layers are glyph-only (no visible wordmark). The word "Default" is retired: it named nothing
 * the interface ever showed. The local layer has a glyph for EVERY state, `follows` (`equal`)
 * included — a layer that disappears while it agrees with the shared answer reads as missing, not
 * as agreement. The words that name the two layers live in the menu's section headers, so
 * `On this device` is said once per menu instead of once per row.
 * `airplay` is not used for "this device" — it reads as screen mirroring to anyone who has not
 * read this file, so it stays out of this vocabulary.
 */
import { FileSharing, Sharing, sharingEquals, EVERYWHERE, perClass, THIS_DEVICE } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { NOT_SHARED_LABEL, restatesInnate, sharingIcon } from "./itemCard";

export const RULE_OPTIONS: readonly Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];

// The stops offered for an element whose plugin declares `isDesktopOnly`. `Mobile only` names
// devices that can never run it; `All devices` claims a reach it does not have. Both were once
// present, the second apologised for by a parenthetical ("mobile is excluded automatically") —
// which is what a wrong stop looks like when it survives review. What is left are the two answers
// that differ: desktops share the on/off state, or each desktop keeps its own.
const DESKTOP_ONLY_RULE_OPTIONS: readonly Sharing[] = [perClass("desktop"), THIS_DEVICE];

export function ruleOptionsFor(desktopOnly: boolean): readonly Sharing[] {
  return desktopOnly ? DESKTOP_ONLY_RULE_OPTIONS : RULE_OPTIONS;
}

// What a row DISPLAYS, which is not always what is stored. With no rule at all the stored answer
// reads back as `everywhere`, a stop a desktop-only row no longer offers — the menu would open with
// nothing checked and the glyph would promise a reach the element does not have. Collapsing onto
// the stop with identical behaviour keeps both honest without writing anything: picking is still
// the only thing that writes.
export function displayRule(rule: Sharing, desktopOnly: boolean): Sharing {
  return restatesInnate(rule, desktopOnly) ? perClass("desktop") : rule;
}

// What a pick STORES, which is the inverse collapse. On a desktop-only element `Desktop only` is
// exactly what no rule already does, so it is stored as no rule (`withEnablementRule` clears the
// entry on `everywhere`). Two things depend on this: a round trip through the control leaves
// data.json byte-identical, and the entry stays removable — with no `All devices` stop left in the
// menu, an entry written here would otherwise have no way back out.
export function ruleToStore(picked: Sharing, desktopOnly: boolean): Sharing {
  return restatesInnate(picked, desktopOnly) ? EVERYWHERE : picked;
}

export function ruleLabel(s: Sharing): string {
  if (s.kind === "everywhere") return "All devices";
  if (s.kind === "this-device") return NOT_SHARED_LABEL;
  return s.class === "desktop" ? "Desktop only" : "Mobile only";
}

// sharingIcon's vocabulary for the two class stops and the everywhere stop;
// `square-split-horizontal` for not-shared.
//
// NOT a negation glyph on purpose: the local layer's own opt-out sits in the SAME control, and
// those two facts are the pair users most often confuse — so the shared answer must not join the
// negation family. This glyph says the positive thing instead: one box divided in two, a value
// diverging per device.
//
// Straight lines and square corners only: at the 16px every drawer control renders at, a glyph like
// `split` collapses into a smudge, its two corner arrowheads and thin curved stem indistinguishable.
// (`airplay`, sharingIcon's own this-device glyph, reads as screen mirroring to anyone who has not
// read the source; `users` reads as MORE sharing beside the word "Not shared".)
export function ruleIcon(s: Sharing): string {
  return s.kind === "this-device" ? "square-split-horizontal" : sharingIcon(s);
}

// A painted layer carries only what it SHOWS: a glyph (nullable — a layer with nothing to draw
// contributes no glyph, and the control then renders the other one alone) and the tooltip sentence
// its half of the control's aria-label is built from. No visible wordmark — the row's own label
// (passed separately to the row builder) already says what the ROW is about; the tooltip says what
// the VALUE is.
export interface RowSegment {
  icon: string | null;
  tooltip: string;
  // Whether this half has an answer worth coloring — the shared half when it is narrower than
  // `All devices` and not merely restating the manifest, the local half when this device has an
  // exception. It rides the SEGMENT rather than the paint site because the two surfaces would
  // otherwise each decide "is this set" for themselves, which is how they came to disagree before.
  isSet: boolean;
}

// The shared half of a row whose answer is a plain `Sharing` value — a whole file's rule, one key's
// rule. Icon and tooltip differ per row kind, so callers still pass those; what they must not each
// decide is whether the answer is narrower than `All devices`, because that is what the color
// depends on and four paint sites deciding it separately is how they drift.
export function sharedSegment(input: { icon: string; tooltip: string; sharing: Sharing }): RowSegment {
  return { icon: input.icon, tooltip: input.tooltip, isSet: input.sharing.kind !== "everywhere" };
}

export interface EnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

// "the default" named nothing the interface ever showed. These read against the `On this device`
// section header they sit under, so none of them repeats "here" either.
export const FOLLOWS_LABEL = "Follow what's shared";
export const ON_HERE_LABEL = "Always on";
export const OFF_HERE_LABEL = "Always off";

// The shared segment's tooltip for an ENABLEMENT-LIST row (one plugin, one snippet). It states the
// CONSEQUENCE, not the label, because the same three words mean three different things across the
// three row kinds and only the consequence tells them apart:
//
//   this row (an on/off list)  `Desktop only` → desktops turn it on, phones leave it off
//   a whole settings file      `Desktop only` → only desktops sync the file at all
//   one key inside a file      `Desktop only` → desktops share a value, each phone keeps its own
//
// Here the excluded class is turned OFF: applyPerElementArray (perElement.ts) filters the element
// out of the incoming list and only `this-device` elements survive from the local one, so a phone
// applying a desktop-scoped element ends up without it.
export function enabledOnTooltip(rule: Sharing): string {
  if (rule.kind === "everywhere") return "Every device turns it on.";
  if (rule.kind === "this-device") return "Nobody shares this. Every device keeps its own on/off.";
  return rule.class === "desktop"
    ? "Desktops turn it on. On phones it stays off."
    : "Phones turn it on. On desktops it stays off.";
}

// The local layer's four possible states, named once: shared by the element-layer row
// (enablementRowModel) and the whole-file row (fileEnablementRowModel) so "this device
// follows/on/off/not-synced" is never spelled twice.
export type LocalSegmentState = "follows" | "on" | "off" | "not-synced";

// Exported so both painters and their tests read the SAME sentence ("one producer for
// every string") instead of re-spelling "This device: …" at each paint site.
// `not-synced` carries a second sentence the other three don't need: it is the one state users
// routinely confuse with the shared answer's `Not shared`, and the whole difference is what happens
// to EVERYONE ELSE. Saying it here is the only place that difference is ever stated.
export function localSegmentTooltip(state: LocalSegmentState): string {
  if (state === "follows") return "This device: follows what's shared.";
  if (state === "on") return "This device: always on.";
  if (state === "off") return "This device: always off.";
  return "This device: not synced. Your other devices keep sharing it.";
}

// `equal` for follows: this device MATCHES the shared answer. Not `corner-down-right`, which the
// card and carrier badges already use for `on: this device` and `N left to me` — the reverse claim,
// so one glyph would carry two opposite meanings. `equal` also has to work in a menu list, where
// there is no neighbouring glyph for an arrow to point back at.
//
// `circle-minus` for not-synced, the fold family's own glyph for the same state (foldIcons.ts),
// deliberately shared. Not `circle-slash`: at 16px a diagonal through a circle is the least legible
// mark in this set, while a horizontal bar reads instantly and says the same thing ("taken out of
// this device's set"). Circle either way, so the fold trio check / minus-circle / circle stays one
// family.
function localSegmentIcon(state: LocalSegmentState): string {
  if (state === "follows") return "equal";
  if (state === "on") return "power";
  if (state === "off") return "power-off";
  return "circle-minus";
}

function localSegment(state: LocalSegmentState): RowSegment {
  return { icon: localSegmentIcon(state), tooltip: localSegmentTooltip(state), isSet: state !== "follows" };
}

export function enablementRowModel(input: { rule: Sharing; exception: DeviceElementState | null; desktopOnly: boolean }): EnablementRowModel {
  // The DISPLAYED rule, not the stored one: a desktop-only element with no rule stored still has to
  // draw and describe the stop its menu offers.
  const shown = displayRule(input.rule, input.desktopOnly);
  const fleet: RowSegment = {
    icon: ruleIcon(shown),
    tooltip: enabledOnTooltip(shown),
    isSet: shown.kind !== "everywhere" && !restatesInnate(input.rule, input.desktopOnly),
  };
  if (input.exception === null) return { fleet, local: localSegment("follows"), localIsException: false };
  return { fleet, local: localSegment(input.exception === "on" ? "on" : "off"), localIsException: true };
}

// The whole-FILE row's model counterpart (`Settings sync`): same shape,
// a different fleet datum (`FileSharing`, not the enablement `Sharing` union — `this-device` is
// structurally excluded) and a two-state local layer (follow / not-synced-here — the
// opt-out is a boolean, so there is no on/off pair to choose between).
export interface FileEnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

// The shared segment's tooltip for a WHOLE-FILE row. Strongest of the three consequences: a
// class-scoped file rule becomes the compiled group's own device class (registry.ts's
// devicesForFileRule), and a group scoped away from this device is not compiled into its sync set
// at all. The excluded class does not keep a private copy the way one excluded KEY does; it simply
// has nothing to do with the file. `FileSharing` excludes this-device by construction, so there is
// no fourth sentence to write: "every device keeps its own whole file" is just not syncing it.
export function settingsSyncTooltip(sharing: FileSharing): string {
  if (sharing.kind === "everywhere") return "Every device syncs this file.";
  return sharing.class === "desktop"
    ? "Only desktops sync this file. Phones don't sync it at all."
    : "Only phones sync this file. Desktops don't sync it at all.";
}

export function fileEnablementRowModel(input: { sharing: FileSharing; optedOut: boolean }): FileEnablementRowModel {
  const fleet: RowSegment = { icon: sharingIcon(input.sharing), tooltip: settingsSyncTooltip(input.sharing), isSet: input.sharing.kind !== "everywhere" };
  return { fleet, local: optOutLocalSegment(input.optedOut), localIsException: input.optedOut };
}

// The local half alone — shared by BOTH rows that have a two-state local answer: the whole-file
// opt-out (`Settings sync`) and a per-key rule's own exception. Same states, same words, so it is
// one producer; a second copy would be a second place for "not synced here" to drift.
export function optOutLocalSegment(optedOut: boolean): RowSegment {
  return localSegment(optedOut ? "not-synced" : "follows");
}

// One local-segment menu, as DATA, for both entrances. The two surfaces turn it into an
// Obsidian `Menu`; neither decides what is IN it, because they disagreed the moment they each
// decided separately — the Sync Center offered a follow entry under `Not shared`,
// where there is no shared answer to follow.
export interface LocalMenuItem {
  // The follow entry has none: the icon-for-every-state rule covers the SEGMENT only —
  // buildLocalMenu/buildOptOutLocalMenu label the menu
  // items, and the follow entry's menu row is not one with a glyph.
  title: string;
  icon: string | null;
  checked: boolean;
  action: () => void;
  // Only the shared section's LAST stop sets this. The first three answer "who gets the shared
  // value"; `Not shared` answers "is there one at all" — a different question in the same radio
  // group, which is precisely why it read as the odd one out. The rule stays one group (picking any
  // stop unpicks the others) and the line says the question changed.
  separatorBefore?: boolean;
  // Renders as a NON-SELECTABLE line (Obsidian's `setIsLabel`), for a section whose answer is a
  // fact rather than a choice. `Per-key rules decide` as an ordinary entry would sit where the
  // value stops sit, checkmark slot and all: every visual signal of something you pick, none of the
  // behaviour. State and action are two lines: this one says what decides, the one under it does
  // something about it.
  isLabel?: boolean;
}

// One menu, two questions, so two labelled sections instead of six flat entries. The headers are
// what make the same three words unambiguous: `Shared with: Desktop only` and `Enabled on: Desktop
// only` read correctly and differently, where the bare stop could not.
export interface MenuSectionModel {
  // `null` for a trailing group that is not a third question — a row's destructive verb
  // (`Remove rule`) rides along at the end, separated but unlabelled, because naming it would
  // promote a one-item action to the rank of the two answers above it.
  header: string | null;
  items: LocalMenuItem[];
}

export const SHARED_WITH_HEADER = "Shared with";
export const ENABLED_ON_HEADER = "Enabled on";
export const ON_THIS_DEVICE_HEADER = "On this device";

// The shared half of a merged control's menu, as DATA. One producer so every surface offers the
// same stops in the same order with the same separator before the fourth.
export function sharingMenuSection(opts: {
  header: string;
  options: readonly Sharing[];
  current: Sharing;
  iconFor: (s: Sharing) => string;
  labelFor: (s: Sharing) => string;
  onChange: (s: Sharing) => void;
}): MenuSectionModel {
  return {
    header: opts.header,
    items: opts.options.map((s) => ({
      title: opts.labelFor(s),
      icon: opts.iconFor(s),
      checked: sharingEquals(s, opts.current),
      action: () => opts.onChange(s),
      separatorBefore: s.kind === "this-device",
    })),
  };
}

export interface LocalMenuHandlers {
  follow: () => void;
  setState: (state: DeviceElementState) => void;
}

export function buildLocalMenu(rule: Sharing, exception: DeviceElementState | null, handlers: LocalMenuHandlers): LocalMenuItem[] {
  const items: LocalMenuItem[] = [];
  // Offered only when there IS a default to follow: with a `this-device` rule every device's own
  // state is the answer, so following would be following nothing.
  if (rule.kind !== "this-device") {
    items.push({ title: FOLLOWS_LABEL, icon: null, checked: exception === null, action: handlers.follow });
  }
  items.push({ title: ON_HERE_LABEL, icon: "power", checked: exception === "on", action: () => handlers.setState("on") });
  items.push({ title: OFF_HERE_LABEL, icon: "power-off", checked: exception === "off", action: () => handlers.setState("off") });
  return items;
}

// The two-state local menu shared by BOTH opt-out layers: the whole-file device opt-out
// (`Settings sync`) and a per-key rule's own exception (`deviceFields.ts`) — same two answers,
// follow or don't, so one producer serves both callers instead of each hand-typing its own copy.
// Still a DIFFERENT datum from buildLocalMenu's above — an on/off exception for one element of an
// enablement list, a three-way local answer over a four-value fleet rule — so it keeps its own
// two-entry producer rather than being folded into buildLocalMenu's shape. Always both entries:
// unlike the element menu there is no `this-device` rule that would make `Follow what's shared`
// meaningless here.
export const NOT_SYNCED_HERE_LABEL = "Don't sync it";

export interface FileLocalMenuHandlers {
  follow: () => void;
  optOut: () => void;
}

export function buildOptOutLocalMenu(optedOut: boolean, handlers: FileLocalMenuHandlers): LocalMenuItem[] {
  return [
    { title: FOLLOWS_LABEL, icon: null, checked: !optedOut, action: handlers.follow },
    { title: NOT_SYNCED_HERE_LABEL, icon: "circle-minus", checked: optedOut, action: handlers.optOut },
  ];
}

// Landing the shared half on `Not shared` while this device has no exception yet leaves
// the row with nothing true to say: it renders the follow glyph beside a menu that (per
// buildLocalMenu) does not offer that state — a label the user cannot re-select, describing a
// default that does not exist. So: the moment the element leaves the shared
// answer its exception is seeded with EXACTLY what it is right now (host.leaveToThisDevice), so the
// displayed state is the plugin's real one and "switching to an exception keeps the status quo"
// holds by construction. Both entrances ask this question here, so neither can forget it.
export function ruleLandingNeedsSeed(rule: Sharing, exception: DeviceElementState | null): boolean {
  return rule.kind === "this-device" && exception === null;
}
