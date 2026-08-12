import { lockEntryList, setLockEntry } from "../src/core/manifest";
import { lockRefFor } from "../src/core/itemKeys";
import { ItemRef, LockItems, StoreLock, StoreLockEntry, SyncGroup } from "../src/core/types";

// A fixture that describes a lock by GROUP NAME — which is how a v1/v2 lock on disk describes it —
// keyed through the SAME producer the real read path uses (itemKeys.ts's lockRefFor, with no
// compiled list, exactly as manifest.ts's parseGroup calls it). Fixtures stay readable as names and
// can still never disagree with the code about where an entry lands.
export function lockByName(capturedAt: string, byName: Record<string, StoreLockEntry>): StoreLock {
  const toRef = lockRefFor([]);
  const items: LockItems = {};
  for (const [name, entry] of Object.entries(byName)) setLockEntry(items, toRef(name), entry);
  return { capturedAt, items };
}

// The ref a group would carry after the compiler (or parseGroup) had seen it — for fixtures that
// build a SyncGroup as a literal and would otherwise have no identity at all.
export function withRef(group: SyncGroup): SyncGroup {
  return { ...group, ref: lockRefFor([])(group.name) as ItemRef };
}

// Test-side readers for the v3 store lock (spec §3). The lock nests by section and id; an assertion
// almost always cares about ONE item, so these flatten it back to `ref -> entry` rather than making
// every expectation spell out two levels.
export function flatLock(lock: { items: LockItems }): Record<string, StoreLockEntry> {
  return Object.fromEntries(lockEntryList(lock.items));
}

export function readLock(raw: string): StoreLock {
  return JSON.parse(raw) as StoreLock;
}

export function lockOf(raw: string): Record<string, StoreLockEntry> {
  return flatLock(readLock(raw));
}

// The two `source` shapes, spelled once: an entry's provenance is `{kind, version}` since v3, and a
// fixture that spelled it inline would be a second opinion about the shape.
export function pluginSource(version: string): { source: { kind: "plugin"; version: string } } {
  return { source: { kind: "plugin", version } };
}

export function appSource(version: string): { source: { kind: "app"; version: string } } {
  return { source: { kind: "app", version } };
}
