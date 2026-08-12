/**
 * The two-segment row's MODEL (spec §6.1): `label | fleet segment | divider | local segment`.
 *
 * Three surfaces render this row — a Sync Center row's `Default enabled on`, a plugin card's, and a
 * carrier card's element rows — and they must say the same thing, so what each segment SAYS is
 * decided once, here, and the renderers only paint it.
 *
 * The local segment renders no icon while it follows the default: a default has nothing to say, and
 * the glyph that used to stand for "this device" (`airplay`) reads as screen mirroring to everyone
 * who has not read this file.
 */
import { Sharing, EVERYWHERE, perClass, THIS_DEVICE } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { sharingIcon } from "./itemCard";

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

export interface RowSegment {
  icon: string | null;
  label: string;
}

export interface EnablementRowModel {
  fleet: RowSegment;
  local: RowSegment;
  localIsException: boolean;
}

export const FOLLOWS_LABEL = "Follows the default";
export const ON_HERE_LABEL = "On here";
export const OFF_HERE_LABEL = "Off here";

export function enablementRowModel(input: { rule: Sharing; exception: DeviceElementState | null }): EnablementRowModel {
  const fleet: RowSegment = { icon: ruleIcon(input.rule), label: ruleLabel(input.rule) };
  if (input.exception === null) return { fleet, local: { icon: null, label: FOLLOWS_LABEL }, localIsException: false };
  const on = input.exception === "on";
  return { fleet, local: { icon: on ? "power" : "power-off", label: on ? ON_HERE_LABEL : OFF_HERE_LABEL }, localIsException: true };
}

// One local-segment menu, as DATA, for both entrances (spec §6.6). The two surfaces turn it into an
// Obsidian `Menu`; neither decides what is IN it, because they disagreed the moment they each
// decided separately — the Sync Center offered `Follows the default` under `Each device decides`,
// where there is no shared answer to follow.
export interface LocalMenuItem {
  title: string;
  icon: string | null; // the follow entry has none, for the same reason its segment has none
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
  // state is the answer (spec §6.5 case 3), so following would be following nothing.
  if (rule.kind !== "this-device") {
    items.push({ title: FOLLOWS_LABEL, icon: null, checked: exception === null, action: handlers.follow });
  }
  items.push({ title: ON_HERE_LABEL, icon: "power", checked: exception === "on", action: () => handlers.setState("on") });
  items.push({ title: OFF_HERE_LABEL, icon: "power-off", checked: exception === "off", action: () => handlers.setState("off") });
  return items;
}

// Landing the FLEET segment on `Each device decides` while this device has no exception yet leaves
// the row with nothing true to say: it renders `Follows the default` beside a menu that (per
// buildLocalMenu) no longer offers that state — a label the user cannot re-select, describing a
// default that does not exist. Spec §6.5 answers it — the moment the element leaves the shared
// answer its exception is seeded with EXACTLY what it is right now (host.leaveToThisDevice), so the
// displayed state is the plugin's real one and "switching to an exception keeps the status quo"
// holds by construction. Both entrances ask this question here, so neither can forget it.
export function ruleLandingNeedsSeed(rule: Sharing, exception: DeviceElementState | null): boolean {
  return rule.kind === "this-device" && exception === null;
}
