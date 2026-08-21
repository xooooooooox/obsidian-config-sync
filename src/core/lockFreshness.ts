import { lockEntryCapturedAt, lockEntryHash, lockEntryList } from "./manifest";
import { isPlainObject } from "./sanitize";
import { StoreLock, StoreLockEntry } from "./types";

// Whether one item's two lock entries describe the same content, and which side moved last. Its own
// leaf module because BOTH the panel (status.ts) and the push seam (ConfigSyncCore.ts) ask it, and
// status.ts already imports the seam — leaving it there would make the two a cycle. It is a
// judgement about two lock entries; neither the panel nor the transport is part of the question.

// Entry fields that are never a DIFFERENCE. `display` is names: a plugin renamed on one device must
// not read as "the store has newer settings" (finding S6) — and since v3 puts the label and the
// carrier's element names in one partition, saying so is one key instead of a list that has to grow
// with every display field. `capturedAt` is freshness, not content — it orders two differing entries
// below instead of being one more thing that differs, or every capture would make every other device
// look behind.
const NON_CONTENT_LOCK_ENTRY_KEYS = new Set(["display", "capturedAt"]);

// Deep equality that does not care about key order. Written out rather than done with
// JSON.stringify because the carried tail can hold anything a newer build wrote, and two
// devices that emit the same object in a different order hold the same value — stringifying would
// turn that into a permanent phantom "the remote is ahead".
function lockValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => lockValuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && lockValuesEqual(a[k], b[k]));
  }
  return false;
}

// Do these two entries describe the same store content? Only keys present on BOTH sides count
// (the mixed-fleet rule): an un-updated device strips `version`/`capturedAt`/`hash` every
// time it pulls, and the next capture here writes them back — comparing keys only one side has
// would surface that churn as a false "the store has newer settings" until the last device is
// updated. A key on both sides with different values is a difference, exactly as before.
function lockEntriesEquivalent(mine: StoreLockEntry, theirs: StoreLockEntry): boolean {
  for (const [key, value] of Object.entries(theirs)) {
    if (NON_CONTENT_LOCK_ENTRY_KEYS.has(key)) continue;
    if (!(key in mine)) continue;
    if (!lockValuesEqual(mine[key], value)) return false;
  }
  return true;
}

// One item's freshness relative to the remote's copy of it. "undatable" = the two differ with no
// way to order them; "absent" = neither side recorded anything comparable. Both send the whole
// comparison back to the store-level timestamp rather than guessing.
export type ItemFreshness = "equal" | "newer" | "older" | "undatable" | "absent";

// Does this lock carry the per-item evidence the comparison below needs? Asked of the PAYLOAD,
// never of the version number. A gate reading `storeLockVersion(…) <
// STORE_LOCK_VERSION` silently becomes "< 3" the moment the lock format moves — excluding
// every 2.21.0 peer for the whole transition window, even though those peers do stamp each entry,
// and reinstating exactly the phantom "the store has newer settings". A version
// comparison is a proxy for a capability; it goes stale as soon as the number moves.
export function hasPerItemPayload(lock: StoreLock): boolean {
  return lockEntryList(lock.items).some(([, entry]) => lockEntryCapturedAt(entry) !== undefined);
}

// An entry's capture time as something we can ORDER by, or null. A non-empty stamp no date parser
// can read is not a date; it is treated as absent everywhere rather than as present-and-useless.
export function entryTime(entry: StoreLockEntry): number | null {
  const ms = Date.parse(lockEntryCapturedAt(entry) ?? "");
  return Number.isNaN(ms) ? null : ms;
}

export function itemFreshness(mine: StoreLockEntry | undefined, theirs: StoreLockEntry | undefined): ItemFreshness {
  if (mine === undefined && theirs === undefined) return "absent";
  if (mine === undefined) return "newer"; // only the remote has this item — a pull would bring it
  if (theirs === undefined) return "older"; // only we have it — a push would carry it
  const sameContent = lockEntriesEquivalent(mine, theirs);
  const l = entryTime(mine);
  const r = entryTime(theirs);
  if (l === null || r === null) return sameContent ? "equal" : "undatable";
  // A hash on BOTH sides settles it outright: the store copies are identical, so it does not matter
  // which device captured them later. Without one — an encrypted item, whose ciphertext differs
  // between devices holding the same settings and so is never fingerprinted — the capture time is
  // all there is, and a later capture is the fresher copy.
  const bothHashed = lockEntryHash(mine) !== undefined && lockEntryHash(theirs) !== undefined;
  if (sameContent && (bothHashed || l === r)) return "equal";
  return r > l ? "newer" : r < l ? "older" : "undatable";
}
