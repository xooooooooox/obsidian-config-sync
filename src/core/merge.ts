import { SyncGroup } from "./types";
import { resolveGroupByStoreRel } from "./pathing";
import { parseSwitchList, SWITCH_LIST_GROUPS, switchListsEqual } from "./switchList";

export type MergeConflict =
  | { kind: "definition"; name: string; local: SyncGroup; remote: SyncGroup }
  | { kind: "file"; name: string; rel: string; localContent: string; remoteContent: string };

export interface MergeAuto {
  addGroups: SyncGroup[]; // remote-only groups → add locally
  writeFiles: { rel: string; content: string; name: string }[]; // remote-only files → write locally
  keptLocalGroups: string[]; // local-only group names (kept, informational)
  keptLocalFiles: string[]; // local-only rels (kept, informational)
  identical: string[]; // "group:<name>" / "file:<rel>" entries identical on both sides (informational)
}

export interface MergePlan {
  auto: MergeAuto;
  conflicts: MergeConflict[];
}

// Resolves the owning group name from either side's groups (a 2-way merge has no single
// authoritative group list); local takes precedence, falling back to remote, then "" (store
// metadata / unmatched, e.g. store.lock.json).
function owningGroupName(localGroups: SyncGroup[], remoteGroups: SyncGroup[], rel: string): string {
  return resolveGroupByStoreRel(localGroups, rel)?.name ?? resolveGroupByStoreRel(remoteGroups, rel)?.name ?? "";
}

// Recursively sorts object keys so JSON.stringify produces a key-order-independent string.
// Arrays keep their original order (order is meaningful there).
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return v;
}

function canonical(g: SyncGroup): string {
  return JSON.stringify(sortKeysDeep(g));
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byRel<T extends { rel: string }>(a: T, b: T): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

// Switch-list store copies are order-insensitive: each device captures in its own store-stable
// order, so two lineages can hold the same membership in different orders. Compare those as
// sets (no exceptions — store copies are full lists); everything else stays byte-equal.
function contentsMatch(localGroups: SyncGroup[], remoteGroups: SyncGroup[], rel: string, local: string, remote: string): boolean {
  if (local === remote) return true;
  if (!SWITCH_LIST_GROUPS.has(owningGroupName(localGroups, remoteGroups, rel))) return false;
  const a = parseSwitchList(local);
  const b = parseSwitchList(remote);
  return a !== null && b !== null && switchListsEqual(a, b, []);
}

export function classifyMerge(
  localGroups: SyncGroup[],
  localFiles: Map<string, string>,
  remoteGroups: SyncGroup[],
  remoteFiles: Map<string, string>
): MergePlan {
  const auto: MergeAuto = { addGroups: [], writeFiles: [], keptLocalGroups: [], keptLocalFiles: [], identical: [] };
  const conflicts: MergeConflict[] = [];

  const localGroupsByName = new Map(localGroups.map((g) => [g.name, g]));
  const remoteGroupsByName = new Map(remoteGroups.map((g) => [g.name, g]));
  const allGroupNames = new Set([...localGroupsByName.keys(), ...remoteGroupsByName.keys()]);

  const identicalGroups: string[] = [];
  for (const name of allGroupNames) {
    const local = localGroupsByName.get(name);
    const remote = remoteGroupsByName.get(name);
    if (local !== undefined && remote === undefined) {
      auto.keptLocalGroups.push(name);
    } else if (local === undefined && remote !== undefined) {
      auto.addGroups.push(remote);
    } else if (local !== undefined && remote !== undefined) {
      if (canonical(local) === canonical(remote)) {
        identicalGroups.push(`group:${name}`);
      } else {
        conflicts.push({ kind: "definition", name, local, remote });
      }
    }
  }
  auto.addGroups.sort(byName);
  auto.keptLocalGroups.sort();
  identicalGroups.sort();

  const allRels = new Set([...localFiles.keys(), ...remoteFiles.keys()]);
  const identicalFiles: string[] = [];
  for (const rel of allRels) {
    const local = localFiles.get(rel);
    const remote = remoteFiles.get(rel);
    if (local !== undefined && remote === undefined) {
      auto.keptLocalFiles.push(rel);
    } else if (local === undefined && remote !== undefined) {
      const name = owningGroupName(localGroups, remoteGroups, rel);
      auto.writeFiles.push({ rel, content: remote, name });
    } else if (local !== undefined && remote !== undefined) {
      if (contentsMatch(localGroups, remoteGroups, rel, local, remote)) {
        identicalFiles.push(`file:${rel}`);
      } else {
        const name = owningGroupName(localGroups, remoteGroups, rel);
        conflicts.push({ kind: "file", name, rel, localContent: local, remoteContent: remote });
      }
    }
  }
  auto.writeFiles.sort(byRel);
  auto.keptLocalFiles.sort();

  auto.identical = [...identicalFiles, ...identicalGroups];

  conflicts.sort((a, b) => {
    const byN = byName(a, b);
    if (byN !== 0) return byN;
    const aRel = a.kind === "file" ? a.rel : "";
    const bRel = b.kind === "file" ? b.rel : "";
    return aRel < bRel ? -1 : aRel > bRel ? 1 : 0;
  });

  return { auto, conflicts };
}
