/**
 * THE precedence (spec 2026-08-12-enablement-two-layers-design.md §5): given the fleet rule for an
 * element, this device's own exception for it, and this device's class, what does a run do?
 *
 * Four rules, top down, first hit wins — and they are HERE, once, because they used to be spread
 * across `memberLocalIdsFor`, `memberForceOffIds`, `runsOnForces` and `preferStoredRunsOn`, which is
 * why "a local choice survives a pull" (C-#52) was true in one of them and false in another.
 *
 * The two outputs mean what they have always meant to the switch-list engine:
 *   - `masked`: the id joins `switchExceptions` — capture passes it through untouched (it can
 *     neither add nor remove the element from the shared list) and apply keeps this device's own
 *     state for it.
 *   - `force`: on top of the mask, apply writes the state outright (`switchForceOn`/
 *     `switchForceOff`). `null` means "leave whatever is on disk".
 *
 * `this-device` with no exception masks WITHOUT forcing: the element is this device's business, and
 * pass-through is exactly "leave it alone". A force would be this build deciding something the user
 * never said.
 */
import { DeviceElementState } from "./deviceElements";
import { Sharing } from "./types";

export interface EnablementDecision {
  masked: boolean;
  force: "on" | "off" | null;
}

const FOLLOW: EnablementDecision = { masked: false, force: null };

export function decideEnablement(input: { rule: Sharing; exception: DeviceElementState | null; deviceClass: "desktop" | "mobile" }): EnablementDecision {
  if (input.exception !== null) return { masked: true, force: input.exception };
  if (input.rule.kind === "this-device") return { masked: true, force: null };
  if (input.rule.kind === "per-class" && input.rule.class !== input.deviceClass) return { masked: true, force: "off" };
  return FOLLOW;
}
