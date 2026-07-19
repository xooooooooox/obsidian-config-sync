import { SyncGroup } from "./types";
import { groupForStoreRel } from "./ConfigSyncCore";

export interface LeftoverFile {
  rel: string; // store-root-relative, e.g. "store/configdir/plugins/x/data.json"
  name: string; // derived display name
  path: string; // rel without the leading "store/", shown in the row
}

// The sync list carried inside the store's own config-sync copy
// (`store/configdir/plugins/config-sync/data.json`). Files a device has pulled but not yet
// adopted are attributable to this list, so callers pass local ∪ store-list groups to
// `leftoverStoreRels` — pulled-but-unadopted data is pending, never deletable "leftover".
export function storeSelfCopyGroups(json: string): SyncGroup[] {
  try {
    const raw = JSON.parse(json) as { groups?: unknown };
    return Array.isArray(raw.groups) ? (raw.groups as SyncGroup[]) : [];
  } catch {
    return [];
  }
}

// A friendly name for an orphaned store file: the plugin id for a plugin path, otherwise the
// store-relative path itself.
function deriveName(storeInner: string): string {
  const m = storeInner.match(/^configdir\/plugins\/([^/]+)\//);
  return m !== null && m[1] !== undefined ? m[1] : storeInner;
}

// Store files that belong to no current group — settings config-sync saved for items no
// longer tracked. Bookkeeping (store.lock.json, config-sync.json) lives outside "store/" and
// is naturally excluded; only rels under "store/" that groupForStoreRel can't attribute count.
export function leftoverStoreRels(rels: string[], groups: SyncGroup[]): LeftoverFile[] {
  const out: LeftoverFile[] = [];
  for (const rel of rels) {
    if (!rel.startsWith("store/")) continue;
    if (groupForStoreRel(groups, rel).name !== "") continue;
    const inner = rel.slice("store/".length);
    out.push({ rel, name: deriveName(inner), path: inner });
  }
  return out;
}
