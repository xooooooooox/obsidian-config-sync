import { SyncGroup } from "./types";

// The difference between a device's local sync list and the store's — used by the Config Sync
// pane to show what adopting/capturing would add or remove. `added` = groups the store has that
// the local list doesn't; `removed` = groups the local list has that the store doesn't. By name,
// sorted. Direction (adopt vs capture) is decided by the caller from the self item's status.
export function syncListDelta(local: SyncGroup[], store: SyncGroup[]): { added: string[]; removed: string[] } {
  const l = new Set(local.map((g) => g.name));
  const s = new Set(store.map((g) => g.name));
  const added = store.filter((g) => !l.has(g.name)).map((g) => g.name).sort();
  const removed = local.filter((g) => !s.has(g.name)).map((g) => g.name).sort();
  return { added, removed };
}
