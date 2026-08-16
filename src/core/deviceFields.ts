/**
 * THE per-key local exception table: which of THIS item's per-key rules this device has taken out
 * of sync, keyed the same way the lock, the baselines and the whole-file opt-out list are.
 *
 * It lives in localStorage and nowhere else: a datum true only of this device, stored in a
 * document that travels wholesale, is a datum another device's pull will overwrite. Same
 * discipline as deviceElements.ts — the two are siblings, one per layer.
 *
 * The inner key is the RULE'S PATTERN, verbatim as data.json's `settingsFile.rules` spells it —
 * not an expanded key name. Excepting a `plugins.*` rule excepts every key that rule covers, which
 * is the only reading that stays true when the document gains a key tomorrow.
 *
 * Every read is tolerant exactly the way parseDeviceElements is: a user or a half-finished write
 * can leave any shape here, and a device that cannot read its own table must still sync.
 * Unreadable ⇒ "no exception here" — never a load failure, and never a rewrite of what was found.
 */
import { SyncGroup } from "./types";

export const DEVICE_FIELDS_KEY = "config-sync-device-fields";

// One state only. "Is this key synced here?" has no on/off pair to choose between — that is the
// enablement layer's question, not this one.
export type DeviceFieldState = "not-synced";

// ItemRef -> rule pattern -> this device's exception.
export type DeviceFields = Record<string, Record<string, DeviceFieldState>>;

function isState(v: unknown): v is DeviceFieldState {
  return v === "not-synced";
}

export function parseDeviceFields(raw: unknown): DeviceFields {
  if (typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: DeviceFields = {};
  for (const [ref, patterns] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof patterns !== "object" || patterns === null || Array.isArray(patterns)) continue;
    const kept: Record<string, DeviceFieldState> = {};
    for (const [pattern, state] of Object.entries(patterns as Record<string, unknown>)) {
      if (isState(state)) kept[pattern] = state;
    }
    if (Object.keys(kept).length > 0) out[ref] = kept;
  }
  return out;
}

export function deviceFieldExcepted(table: DeviceFields, ref: string, pattern: string): boolean {
  return table[ref]?.[pattern] !== undefined;
}

export function deviceFieldPatterns(table: DeviceFields, ref: string): string[] {
  return Object.keys(table[ref] ?? {});
}

// Pure. Clearing the last pattern drops the item entry, so a round trip through the control leaves
// the stored string identical to how it started (same rule withEnablementRule follows).
export function withDeviceField(table: DeviceFields, ref: string, pattern: string, excepted: boolean): DeviceFields {
  const forRef = { ...(table[ref] ?? {}) };
  if (excepted) forRef[pattern] = "not-synced";
  else delete forRef[pattern];
  const next = { ...table };
  if (Object.keys(forRef).length === 0) delete next[ref];
  else next[ref] = forRef;
  return next;
}

// The bridge into the pure core: CoreContext keys device-local facts by GROUP NAME (the key every
// capture/apply/compare call site already holds), while this table — like the lock and the
// baselines — is keyed by ItemRef. One producer for the mapping, so the two key spaces never drift.
// A group with no ref has no identity to hold an exception by; a ref with no compiled group is a
// stale entry and is skipped rather than deleted (unknown ⇒ preserve).
export function fieldExceptionsByGroupName(table: DeviceFields, groups: readonly SyncGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    if (g.ref === undefined) continue;
    const patterns = deviceFieldPatterns(table, g.ref);
    if (patterns.length > 0) out[g.name] = patterns;
  }
  return out;
}
