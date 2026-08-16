/**
 * The two-segment row's MODEL: `label | fleet segment | divider | local segment`.
 *
 * Three surfaces render this row — a Sync Center row's `Enabled on`/`Settings sync`, a plugin
 * card's, and a carrier card's element rows — and they must say the same thing, so what each
 * segment SAYS (icon + tooltip) is decided once, here, and the renderers only paint it: an icon,
 * a PICKER `chevrons-up-down` affordance, and an aria-label/tooltip built by the exported
 * functions below — never a hand-spelled string at the paint site.
 *
 * Both segments are icon-only (no visible wordmark) — the word "Default" lives in the fleet
 * tooltip (`Default enabled on: …`), and the local segment carries a muted "this device" eyebrow
 * plus a glyph for EVERY state, including `follows` (`corner-down-right`): a bare wordmark row
 * next to an icon+chevron fleet segment reads as unfinished, so `follows` gets a real glyph too.
 * `airplay` is not used for "this device" — it reads as screen mirroring to anyone who has not
 * read this file, so it stays out of this vocabulary.
 */
import { FileSharing, Sharing, EVERYWHERE, perClass, THIS_DEVICE } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { sharingIcon, sharingLabel } from "./itemCard";

export const RULE_OPTIONS: readonly Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];

export function ruleLabel(s: Sharing): string {
  if (s.kind === "everywhere") return "All devices";
  if (s.kind === "this-device") return "Each device decides";
  return s.class === "desktop" ? "Desktop only" : "Mobile only";
}

// sharingIcon's vocabulary for the two class stops and the everywhere stop; `users` for
// each-device-decides — the value is about the fleet's PEOPLE-side arrangement ("each of you
// decides"), and `airplay` (sharingIcon's own this-device glyph) means screen mirroring to a reader
// who has not read the source.
export function ruleIcon(s: Sharing): string {
  return s.kind === "this-device" ? "users" : sharingIcon(s);
}

// A painted segment carries only what it SHOWS: a glyph (nullable, for the per-key fallback fleet
// cell, which keeps its italic note instead) and the aria-label/tooltip
// sentence. No visible wordmark any more — the row's own label (passed separately to the row
// builder) already says what the ROW is about; the segment's tooltip says what its VALUE is.
export interface RowSegment {
  icon: string | null;
  tooltip: string;
}

export interface EnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

export const FOLLOWS_LABEL = "Follows the default";
export const ON_HERE_LABEL = "On here";
export const OFF_HERE_LABEL = "Off here";

// Rendered uppercase via CSS (`text-transform: uppercase`), stored lowercase here — the local
// segment's muted eyebrow, shared verbatim by every two-segment row's local half so
// "this device" is spelled once.
export const THIS_DEVICE_EYEBROW = "this device";

// The fleet segment's tooltip — "Default enabled on: <ruleLabel>" — exported so both
// painters and their tests read the SAME sentence instead of re-spelling it.
export function enabledOnTooltip(rule: Sharing): string {
  return `Default enabled on: ${ruleLabel(rule)}`;
}

// The local segment's four possible states, named once: shared by the element-layer row
// (enablementRowModel) and the whole-file row (fileEnablementRowModel) so "this device
// follows/on/off/not-synced" is never spelled twice.
export type LocalSegmentState = "follows" | "on" | "off" | "not-synced";

// Exported so both painters and their tests read the SAME sentence ("one producer for
// every string") instead of re-spelling "This device: …" at each paint site.
export function localSegmentTooltip(state: LocalSegmentState): string {
  const phrase =
    state === "follows" ? "follows the default" : state === "on" ? "on here" : state === "off" ? "off here" : "not synced here";
  return `This device: ${phrase}`;
}

// `corner-down-right` for follows (DESIGN.md icon table): the local segment always has
// a glyph, so a two-segment row's local cell lines up with an exception's the same way its fleet
// cell always does.
function localSegmentIcon(state: LocalSegmentState): string {
  if (state === "follows") return "corner-down-right";
  if (state === "on") return "power";
  if (state === "off") return "power-off";
  return "circle-slash";
}

function localSegment(state: LocalSegmentState): RowSegment {
  return { icon: localSegmentIcon(state), tooltip: localSegmentTooltip(state) };
}

export function enablementRowModel(input: { rule: Sharing; exception: DeviceElementState | null }): EnablementRowModel {
  const fleet: RowSegment = { icon: ruleIcon(input.rule), tooltip: enabledOnTooltip(input.rule) };
  if (input.exception === null) return { fleet, local: localSegment("follows"), localIsException: false };
  return { fleet, local: localSegment(input.exception === "on" ? "on" : "off"), localIsException: true };
}

// The whole-FILE two-segment row's model counterpart (`Settings sync`): same shape,
// a different fleet datum (`FileSharing`, not the enablement `Sharing` union — `this-device` is
// structurally excluded) and a two-state local layer (follow / not-synced-here — the
// opt-out is a boolean, so there is no on/off pair to choose between).
export interface FileEnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

export function settingsSyncTooltip(sharing: FileSharing): string {
  return `Default settings sync: ${sharingLabel(sharing)}`;
}

export function fileEnablementRowModel(input: { sharing: FileSharing; optedOut: boolean }): FileEnablementRowModel {
  const fleet: RowSegment = { icon: sharingIcon(input.sharing), tooltip: settingsSyncTooltip(input.sharing) };
  return { fleet, local: optOutLocalSegment(input.optedOut), localIsException: input.optedOut };
}

// The local half alone — shared by BOTH layers that have a two-state local answer: the whole-file
// opt-out (`Settings sync`) and a per-key rule's own exception. Same states, same words, so it is
// one producer; a second copy would be a second place for "not synced here" to drift.
export function optOutLocalSegment(optedOut: boolean): RowSegment {
  return localSegment(optedOut ? "not-synced" : "follows");
}

// One local-segment menu, as DATA, for both entrances. The two surfaces turn it into an
// Obsidian `Menu`; neither decides what is IN it, because they disagreed the moment they each
// decided separately — the Sync Center offered `Follows the default` under `Each device decides`,
// where there is no shared answer to follow.
export interface LocalMenuItem {
  title: string;
  // The follow entry has none: the icon-for-every-state rule covers the SEGMENT only —
  // buildLocalMenu/buildOptOutLocalMenu label the menu
  // items, and `Follows the default`'s menu row is not one with a glyph.
  icon: string | null;
  checked: boolean;
  action: () => void;
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

// The whole-FILE local menu (`DEFAULT SETTINGS SYNC`): a DIFFERENT
// datum from buildLocalMenu's above — a device opt-out of the entire item, not one element of an
// enablement list — so it gets its own two-entry producer rather than being folded into
// buildLocalMenu's four-value shape. Always both entries: unlike the element menu there is no
// `this-device` rule that would make `Follows the default` meaningless here.
export const NOT_SYNCED_HERE_LABEL = "Not synced here";

export interface FileLocalMenuHandlers {
  follow: () => void;
  optOut: () => void;
}

export function buildOptOutLocalMenu(optedOut: boolean, handlers: FileLocalMenuHandlers): LocalMenuItem[] {
  return [
    { title: FOLLOWS_LABEL, icon: null, checked: !optedOut, action: handlers.follow },
    { title: NOT_SYNCED_HERE_LABEL, icon: "circle-slash", checked: optedOut, action: handlers.optOut },
  ];
}

// Landing the FLEET segment on `Each device decides` while this device has no exception yet leaves
// the row with nothing true to say: it renders `Follows the default` beside a menu that (per
// buildLocalMenu) does not offer that state — a label the user cannot re-select, describing a
// default that does not exist. So: the moment the element leaves the shared
// answer its exception is seeded with EXACTLY what it is right now (host.leaveToThisDevice), so the
// displayed state is the plugin's real one and "switching to an exception keeps the status quo"
// holds by construction. Both entrances ask this question here, so neither can forget it.
export function ruleLandingNeedsSeed(rule: Sharing, exception: DeviceElementState | null): boolean {
  return rule.kind === "this-device" && exception === null;
}
