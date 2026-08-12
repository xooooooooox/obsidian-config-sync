import { SyncGroup } from "./types";
import { groupForStoreRel } from "./ConfigSyncCore";
import { compileItems, defsForForeignItems, ItemDef, ItemMap } from "./registry";
import { classifySettings } from "./settingsMigration";
import { migrateV2Settings } from "./v2Migration";

export interface LeftoverFile {
  rel: string; // store-root-relative, e.g. "store/configdir/plugins/x/data.json"
  name: string; // derived display name
  path: string; // rel without the leading "store/", shown in the row
}

// The list-membership compile BOTH delta sides share (spec 2026-07-28 §2): items compiled WITH
// synthesized defs for ids whose plugin isn't installed here, so an item this data.json carries
// never drops out of membership just because its plugin is absent on this device. betaIds comes
// from the caller (main.ts's `bratRepoIndex(this.settings.items)`) so a synthesized def
// classifies the same way an installed one would.
export function selfListGroups(defs: ItemDef[], items: ItemMap, betaIds: ReadonlySet<string>): SyncGroup[] {
  return compileItems(defsForForeignItems(defs, items, betaIds), { items });
}

// The sync list carried inside the store's own config-sync copy
// (`store/configdir/plugins/config-sync/data.json`). Files a device has pulled but not yet
// adopted are attributable to this list, so callers pass local ∪ store-list groups to
// `leftoverStoreRels` — pulled-but-unadopted data is pending, never deletable "leftover".
// Schema v1 persisted the compiled `groups` list verbatim; v3 persists `items` (section -> id ->
// item, custom items included), so the list must be recompiled (against the local defs, extended
// for store items whose plugin isn't installed here — defsForForeignItems, via selfListGroups).
//
// A v2 copy is MIGRATED IN MEMORY first (v2Migration.ts). That is not an edge case: for the whole
// transition window the store is still written by devices on 2.21.0, so a v3 device reading a v2
// self copy is the NORMAL state, and reading it as `[]` would be actively harmful in three places —
// the self pane would report every item as added (or read cold-start), the leftover view would
// offer other devices' store files as deletable, and readStoreContractLocals would return an empty
// map, switching OFF the store-contract this-device strip so this device could publish its own
// device-local values into the store. Nothing is written back and the lock is not touched: this is
// a read boundary, and the store's own re-key is spec §3 (task 3).
// Best-effort by contract otherwise: malformed or uncompilable foreign content yields [] rather
// than breaking status/leftover views.
export function storeSelfCopyGroups(json: string, defs: ItemDef[], betaIds: ReadonlySet<string>): SyncGroup[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return [];
    // §4.2's gate, on the read side (final-review M3): a store copy written by a NEWER build is not
    // ours to compile — its `items` may mean something this build cannot see, and every consumer of
    // this list (the self pane's delta, leftover attribution, the store-contract strip) would then
    // act on a reading we invented. Empty is what this function already answers for content it
    // cannot make sense of. Asked of the object already parsed above, through the same
    // classifySettings every other gate routes through (N5: isFutureSchemaDocument would re-parse
    // the same text a second time).
    if (classifySettings(parsed as Record<string, unknown>).kind === "future") return [];
    const raw = parsed as { groups?: unknown; items?: unknown };
    if (Array.isArray(raw.groups)) return raw.groups as SyncGroup[];
    // Identity for a v3 document — migrateV2Settings only rewrites a `schemaVersion: 2` one, so
    // this is the same single gate the load path uses rather than a second opinion about versions.
    const items = migrateV2Settings(parsed as Record<string, unknown>).document.items;
    if (typeof items !== "object" || items === null) return [];
    return selfListGroups(defs, items as ItemMap, betaIds);
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
