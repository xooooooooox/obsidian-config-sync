/**
 * THE local exception table (spec 2026-08-12-enablement-two-layers-design.md §3.4): which on/off
 * elements THIS device has taken out of the shared answer, and what it decided for them.
 *
 * It lives in localStorage and nowhere else, for the reason C-#52 paid for once already: a datum
 * true only of this device, stored in a document that travels wholesale, is a datum another
 * device's pull will overwrite. `thisDeviceItems` was exactly that, and this table is what replaces
 * it.
 *
 * The shape mirrors data.json's `perElement` — two levels, the same element ids — so a reader can
 * hold one mental model for both layers. Only the value differs: a rule says who SHARES an element,
 * an exception says whether it is on or off HERE.
 *
 * Every read is tolerant in exactly the way deviceOptOutGroups (main.ts) is: this is a plain
 * localStorage entry a user or a half-finished write can leave in any shape, and a device that
 * cannot read its own exception table must still sync. Unreadable ⇒ "no exception here" — never a
 * load failure, and never a rewrite of what was found.
 */

export const DEVICE_ELEMENTS_KEY = "config-sync-device-elements";

export type DeviceElementState = "on" | "off";

// list id (switchList.ts's SWITCH_LISTS keys) -> element id -> what this device decided.
//
// The outer key is the LIST id, not perElementKeyFor's result: the reserved-key problem does not
// exist on this side. That key exists because data.json indexes rules by the JSON field a list
// lives in, and two of the three lists have no field. localStorage has no document to index into —
// the list's own identity is the whole of it.
export type DeviceElements = Record<string, Record<string, DeviceElementState>>;

function isState(v: unknown): v is DeviceElementState {
  return v === "on" || v === "off";
}

export function parseDeviceElements(raw: unknown): DeviceElements {
  if (typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: DeviceElements = {};
  for (const [list, elements] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof elements !== "object" || elements === null || Array.isArray(elements)) continue;
    const kept: Record<string, DeviceElementState> = {};
    for (const [id, state] of Object.entries(elements as Record<string, unknown>)) {
      if (isState(state)) kept[id] = state;
    }
    if (Object.keys(kept).length > 0) out[list] = kept;
  }
  return out;
}

export function deviceElementState(table: DeviceElements, list: string, elementId: string): DeviceElementState | null {
  return table[list]?.[elementId] ?? null;
}

export function deviceElementIds(table: DeviceElements, list: string): string[] {
  return Object.keys(table[list] ?? {});
}

// Pure. `null` clears the exception; clearing the last one in a list drops the list, so the stored
// JSON never accumulates empty objects that would read as "this list has exceptions" to a human.
export function withDeviceElement(table: DeviceElements, list: string, elementId: string, state: DeviceElementState | null): DeviceElements {
  const forList = { ...(table[list] ?? {}) };
  if (state === null) delete forList[elementId];
  else forList[elementId] = state;
  const next = { ...table };
  if (Object.keys(forList).length === 0) delete next[list];
  else next[list] = forList;
  return next;
}
