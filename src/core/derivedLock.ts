import {
  derivedLockCapturedAt,
  lockEntry,
  lockEntryList,
  lockEntryTail,
  lockTail,
  lockWatermark,
  setLockEntry,
  STORE_LOCK_VERSION,
} from "./manifest";
import { LockItems, StoreLock } from "./types";

// The lock a push SENDS, which is not the lock this device HAS. The file describes the store the far
// end will be holding once this push lands, and a push does not send everything: an item withheld by
// this remote's rules, or simply left unticked for this run, keeps whatever is already over there.
// Our entry for such an item would fingerprint a file we never wrote — and that entry is exactly what
// the far end's own devices read to decide whether they are behind.
//
// No new format: the result is a store.lock.json, field for field. Only the values are computed
// differently, so the lock's schema stays where it is. The local lock is never touched.
export function derivedPushLock(input: {
  local: StoreLock;
  remote: StoreLock | null;
  skipRefs: readonly string[];
}): StoreLock {
  const { local, remote, skipRefs } = input;
  const withheld = new Set<string>(skipRefs);
  const items: LockItems = {};
  for (const [ref, entry] of lockEntryList(local.items)) {
    if (withheld.has(ref)) continue;
    // A field only THEIR entry carried is not ours to drop — the same carry applyImport performs in
    // the other direction, so a newer build's per-item field survives a round trip through us.
    const carried = lockEntryTail(lockEntry(remote, ref));
    for (const key of Object.keys(entry)) delete carried[key];
    setLockEntry(items, ref, { ...entry, ...carried });
  }
  // Their entries for the items we withheld. Iterating THEIR lock rather than the skip set keeps the
  // output order a function of the two documents alone — a stable byte sequence is what lets an
  // unchanged push skip the write entirely. An item only they have and we did not withhold is
  // deliberately absent: push mirror-deletes its files, so an entry would describe nothing.
  if (remote !== null) {
    for (const [ref, entry] of lockEntryList(remote.items)) {
      if (withheld.has(ref)) setLockEntry(items, ref, entry);
    }
  }
  // Field order follows parseStoreLock's, the same as capture's and the pull merge's: capturedAt,
  // items, then the tail with version/syncedWatermark riding it.
  return {
    capturedAt: derivedLockCapturedAt(items, [], local.capturedAt),
    items,
    version: STORE_LOCK_VERSION,
    // Only a pull moves a watermark, and this push is not their pull. Overwriting it with ours —
    // what a verbatim push does today — tells their devices they have already seen a lineage they
    // never pulled, and that claim then suppresses a pull they actually need.
    syncedWatermark: remote !== null ? lockWatermark(remote) : lockWatermark(local),
    // Unknown TOP-LEVEL keys from both sides, THEIRS winning a collision. The mirror of the pull
    // merge's rule and the same argument: the file being written belongs to the store it describes,
    // and this one describes theirs. A key only we carry still rides over rather than being dropped.
    ...lockTail(local),
    ...lockTail(remote),
  };
}
