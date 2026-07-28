import { SyncGroup } from "./types";
import { groupForStoreRel } from "./ConfigSyncCore";
import { compileItems, CustomGroupConfig, defsForForeignItems, ItemConfig, ItemDef } from "./registry";

export interface LeftoverFile {
  rel: string; // store-root-relative, e.g. "store/configdir/plugins/x/data.json"
  name: string; // derived display name
  path: string; // rel without the leading "store/", shown in the row
}

// The list-membership compile BOTH delta sides share (spec 2026-07-28 §2): items compiled WITH
// synthesized defs for ids whose plugin isn't installed here, so an item this data.json carries
// never drops out of membership just because its plugin is absent on this device.
export function selfListGroups(defs: ItemDef[], items: Record<string, ItemConfig>, customGroups: CustomGroupConfig[]): SyncGroup[] {
  return compileItems(defsForForeignItems(defs, Object.keys(items)), { items, customGroups });
}

// The sync list carried inside the store's own config-sync copy
// (`store/configdir/plugins/config-sync/data.json`). Files a device has pulled but not yet
// adopted are attributable to this list, so callers pass local ∪ store-list groups to
// `leftoverStoreRels` — pulled-but-unadopted data is pending, never deletable "leftover".
// Schema v1 persisted the compiled `groups` list verbatim; schema v2 persists `items` +
// `customGroups` instead, so the list must be recompiled (against the local defs, extended for
// store items whose plugin isn't installed here — defsForForeignItems). Best-effort by contract:
// malformed or uncompilable foreign content yields [] rather than breaking status/leftover views.
export function storeSelfCopyGroups(json: string, defs: ItemDef[]): SyncGroup[] {
  try {
    const raw = JSON.parse(json) as { groups?: unknown; items?: unknown; customGroups?: unknown };
    if (Array.isArray(raw.groups)) return raw.groups as SyncGroup[];
    if (typeof raw.items !== "object" || raw.items === null) return [];
    const items = raw.items as Record<string, ItemConfig>;
    const customGroups = Array.isArray(raw.customGroups) ? (raw.customGroups as CustomGroupConfig[]) : [];
    return selfListGroups(defs, items, customGroups);
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
