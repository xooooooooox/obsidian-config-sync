/**
 * Pure module for shape-aware set operations on switch-list JSON:
 * - community-plugins.json: string[] of plugin ids
 * - core-plugins.json: Record<string, boolean> of plugin/core ids to enabled state
 *
 * Supports per-device exception masking: excepted ids never enter the store at capture,
 * keep their local state on apply, and are masked out of in-sync comparison.
 */

import { groupRealPath } from "./pathing";

export interface SwitchListSpec {
  localFile: string; // file under {configDir} the LOCAL list lives in
  field?: string;    // set => list is this array field inside localFile; unset => whole file
}

export const SWITCH_LISTS: Record<string, SwitchListSpec> = {
  "community-plugins": { localFile: "community-plugins.json" },
  "core-plugins": { localFile: "core-plugins.json" },
  "enabled-css-snippets": { localFile: "appearance.json", field: "enabledCssSnippets" },
};

export const SWITCH_LIST_GROUPS: ReadonlySet<string> = new Set(Object.keys(SWITCH_LISTS));

export type SwitchList = string[] | Record<string, boolean>;

/**
 * Parse switch-list JSON content (array or map of booleans).
 * @returns The parsed SwitchList, or null if malformed.
 */
export function parseSwitchList(content: string): SwitchList | null {
  try {
    const parsed: unknown = JSON.parse(content);

    // Array of strings
    if (Array.isArray(parsed)) {
      if (parsed.every((item): item is string => typeof item === "string")) {
        return parsed;
      }
      return null;
    }

    // Record of booleans (object but not array)
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      if (Object.values(rec).every((val) => typeof val === "boolean")) {
        return rec as Record<string, boolean>;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

// LOCAL-side read: whole file for plain lists, the array field for field lists.
export function readLocalSwitchList(name: string, content: string): SwitchList | null {
  const spec = SWITCH_LISTS[name];
  if (spec?.field !== undefined) {
    try {
      const arr = (JSON.parse(content) as Record<string, unknown>)[spec.field];
      if (arr === undefined) return [];
      if (Array.isArray(arr) && arr.every((x): x is string => typeof x === "string")) return arr;
      return null;
    } catch {
      return null;
    }
  }
  return parseSwitchList(content);
}

// LOCAL-side write: whole array for plain lists; for field lists, replace ONLY that field in
// the prior file content so sibling fields (theme, fonts) survive.
export function writeLocalSwitchList(name: string, list: SwitchList, priorContent: string | null): string {
  const spec = SWITCH_LISTS[name];
  if (spec?.field !== undefined) {
    let obj: Record<string, unknown> = {};
    if (priorContent !== null) {
      try {
        const parsed = JSON.parse(priorContent) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      } catch {
        obj = {};
      }
    }
    obj[spec.field] = list;
    return JSON.stringify(obj, null, 2) + "\n";
  }
  return JSON.stringify(list, null, 2) + "\n";
}

// LOCAL real path: field lists resolve to their localFile (appearance.json); everything else
// resolves the group's own path. This is the ONLY place the virtual snippet path is redirected.
export function localRealPath(name: string, groupPath: string, configDir: string): string {
  const spec = SWITCH_LISTS[name];
  return spec?.field !== undefined ? `${configDir}/${spec.localFile}` : groupRealPath(groupPath, configDir);
}

// Remove force-off ids from an applied list. Arrays only (snippet scope-away force-off);
// maps and empty force-off sets pass through unchanged. Shared by applyGroup and diffPair so
// the diff preview provably mirrors what apply writes.
export function subtractForceOff(list: SwitchList, forceOff: string[]): SwitchList {
  if (!Array.isArray(list) || forceOff.length === 0) return list;
  const off = new Set(forceOff);
  return list.filter((id) => !off.has(id));
}

/**
 * Capture: remove excepted ids from local before storing.
 * Arrays: remove excepted strings, preserve order.
 * Maps: remove excepted keys.
 */
// Capture is PASS-THROUGH for excluded ids (甲, 2026-07-16): non-excluded ids follow local
// (whole-list mirror as always); excluded ids copy the store's existing state verbatim —
// present stays present, absent stays absent. An excluding device can therefore neither add
// nor remove an excluded id from the shared list. `store === null` (first capture or
// unreadable) contributes nothing for excluded ids.
//
// Ordering is STORE-STABLE (2026-07-17): the produced list walks the store first — excluded ids
// pass through in place, members still enabled locally keep their positions — then appends
// local-only non-excluded entries in local order. Identical membership therefore captures
// byte-identical to the store: diffs show only true adds/removes, and excluded ids never
// appear in them. (Local file order is per-device enable order — never meaningful to mirror.)
export function captureSwitchList(local: SwitchList, store: SwitchList | null, exceptions: string[]): SwitchList {
  const excSet = new Set(exceptions);

  if (Array.isArray(local)) {
    if (store === null) return local.filter((id) => !excSet.has(id));
    const localSet = new Set(local);
    const storeIds = Array.isArray(store) ? store : Object.keys(store).filter((k) => (store)[k] === true);
    const storeSet = new Set(storeIds);
    const fromStore = storeIds.filter((id) => excSet.has(id) || localSet.has(id));
    const additions = local.filter((id) => !excSet.has(id) && !storeSet.has(id));
    return [...fromStore, ...additions];
  } else {
    const result: Record<string, boolean> = {};
    const storeKeys: string[] = store === null ? [] : Array.isArray(store) ? store : Object.keys(store);
    for (const key of storeKeys) {
      if (excSet.has(key)) {
        // Pass-through: array stores carry presence (true); map stores carry the stored value.
        result[key] = store !== null && !Array.isArray(store) ? (store[key] ?? true) : true;
      } else if (Object.prototype.hasOwnProperty.call(local, key)) {
        result[key] = local[key] ?? false;
      }
    }
    for (const [key, value] of Object.entries(local)) {
      if (!excSet.has(key) && !(key in result)) {
        result[key] = value;
      }
    }
    return result;
  }
}

// Bidirectional divergence summary (定稿 2026-07-17): the non-excluded ids each direction
// would destroy. captureRemoves = enabled in the store but not here (capture drops them from
// the shared list — other devices then turn them off); applyDisables = enabled only here
// (apply turns them off — excluding them first keeps them). Both sorted for stable display.
export function switchDivergence(
  local: SwitchList,
  store: SwitchList,
  exceptions: string[]
): { captureRemoves: string[]; applyDisables: string[] } {
  const excSet = new Set(exceptions);
  const enabledIds = (l: SwitchList): Set<string> =>
    new Set(Array.isArray(l) ? l : Object.keys(l).filter((k) => l[k] === true));
  const localIds = enabledIds(local);
  const storeIds = enabledIds(store);
  const captureRemoves = [...storeIds].filter((id) => !excSet.has(id) && !localIds.has(id)).sort();
  const applyDisables = [...localIds].filter((id) => !excSet.has(id) && !storeIds.has(id)).sort();
  return { captureRemoves, applyDisables };
}

// Display-only canonical view for switch-list diffs: membership compares as a set, so diffs
// render both sides sorted — a real difference shows as adds/removes instead of being buried
// in per-device ordering noise. Unparseable content passes through untouched.
export function switchListSortedView(content: string): string {
  const parsed = parseSwitchList(content);
  if (parsed === null) return content;
  if (Array.isArray(parsed)) return JSON.stringify([...parsed].sort(), null, 2) + "\n";
  const sorted: Record<string, boolean> = {};
  for (const k of Object.keys(parsed).sort()) sorted[k] = parsed[k] ?? false;
  return JSON.stringify(sorted, null, 2) + "\n";
}

/**
 * Apply: merge store and local based on exceptions.
 * Arrays: (store − exceptions) in store order, then (local ∩ exceptions) in local order.
 * Maps: store entries minus excepted keys, plus local entries for excepted keys.
 * Mixed shapes: prefer store shape; treat other side by membership (array: id present; map: key truthy).
 */
export function applySwitchList(
  store: SwitchList,
  local: SwitchList | null,
  exceptions: string[]
): SwitchList {
  const excSet = new Set(exceptions);

  if (Array.isArray(store)) {
    // Result is array
    const storeSynced = store.filter((id) => !excSet.has(id));

    if (local === null) {
      return storeSynced;
    }

    // Append local ∩ exceptions in local order
    if (Array.isArray(local)) {
      const localExcepted = local.filter((id) => excSet.has(id));
      return [...storeSynced, ...localExcepted];
    } else {
      // local is map; extract excepted keys that have truthy values
      const localExcepted: string[] = [];
      for (const exc of exceptions) {
        if (exc in local && local[exc]) {
          localExcepted.push(exc);
        }
      }
      return [...storeSynced, ...localExcepted];
    }
  } else {
    // Result is map
    const result: Record<string, boolean> = {};

    // Add store entries minus excepted keys
    for (const [key, value] of Object.entries(store)) {
      if (!excSet.has(key)) {
        result[key] = value;
      }
    }

    if (local === null) {
      return result;
    }

    // Add local entries for excepted keys
    if (Array.isArray(local)) {
      // local is array; don't add excepted keys unless they're in store (already added)
      // Actually, for mixed shapes, we only preserve excepted keys if they're in store.
      // This is handled above: we already skipped excepted keys in store.
      // For local array, we don't add anything new for excepted keys (membership check irrelevant for maps).
    } else {
      // local is also map; add/override with local entries for excepted keys
      for (const exc of exceptions) {
        const localVal = local[exc];
        if (localVal !== undefined) {
          result[exc] = localVal;
        }
      }
    }

    return result;
  }
}

/**
 * Status comparison: are two lists equivalent after masking exceptions?
 * Arrays: masked lists compared as sets (order-insensitive).
 * Maps: masked maps compared by key-value equality (order irrelevant by nature).
 * Mixed shapes: return false (different shapes are never equal).
 */
export function switchListsEqual(
  local: SwitchList,
  store: SwitchList,
  exceptions: string[]
): boolean {
  const excSet = new Set(exceptions);

  // Different shapes → not equal
  if (Array.isArray(local) !== Array.isArray(store)) {
    return false;
  }

  if (Array.isArray(local) && Array.isArray(store)) {
    // Both arrays: compare as sets (order-insensitive) after masking exceptions
    const localMasked = new Set(local.filter((id) => !excSet.has(id)));
    const storeMasked = new Set(store.filter((id) => !excSet.has(id)));

    if (localMasked.size !== storeMasked.size) {
      return false;
    }

    for (const id of localMasked) {
      if (!storeMasked.has(id)) {
        return false;
      }
    }

    return true;
  } else {
    // Both maps: compare key-value equality after masking exceptions
    const local_ = local as Record<string, boolean>;
    const store_ = store as Record<string, boolean>;

    const localMasked: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(local_)) {
      if (!excSet.has(key)) {
        localMasked[key] = value;
      }
    }

    const storeMasked: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(store_)) {
      if (!excSet.has(key)) {
        storeMasked[key] = value;
      }
    }

    // Compare masked maps: same keys with same values
    const localKeys = Object.keys(localMasked).sort();
    const storeKeys = Object.keys(storeMasked).sort();

    if (localKeys.length !== storeKeys.length) {
      return false;
    }

    for (let i = 0; i < localKeys.length; i++) {
      if (localKeys[i] !== storeKeys[i]) {
        return false;
      }
    }

    for (const key of localKeys) {
      if (localMasked[key] !== storeMasked[key]) {
        return false;
      }
    }

    return true;
  }
}
