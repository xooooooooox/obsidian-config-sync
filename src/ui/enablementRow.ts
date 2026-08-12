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
