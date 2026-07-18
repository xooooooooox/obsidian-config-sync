import { SyncGroup } from "./types";
import { groupForStoreRel } from "./ConfigSyncCore";

export interface LeftoverFile {
  rel: string; // store-root-relative, e.g. "store/configdir/plugins/x/data.json"
  name: string; // derived display name
  path: string; // rel without the leading "store/", shown in the row
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
