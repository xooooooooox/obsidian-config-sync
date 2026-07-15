import { SyncGroup } from "./types";

export const CONFIG_DIR_VARIABLE = "{configDir}";
export const STORE_CONFIG_DIR = "configdir";

export class PathingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathingError";
  }
}

export function groupRealPath(groupPath: string, configDir: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return configDir + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  return groupPath;
}

export function groupStorePath(groupPath: string): string {
  if (groupPath.startsWith(CONFIG_DIR_VARIABLE + "/")) {
    return STORE_CONFIG_DIR + groupPath.slice(CONFIG_DIR_VARIABLE.length);
  }
  if (groupPath.startsWith(".")) {
    return groupPath.slice(1);
  }
  return groupPath;
}

export function relativeTo(base: string, full: string): string {
  if (!full.startsWith(base + "/")) {
    throw new PathingError(`"${full}" is not inside "${base}"`);
  }
  return full.slice(base.length + 1);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

// Resolves a "store/<groupStorePath>/..." rel to the owning group, by matching each group's
// store path against the rel's "store/" prefix. Returns undefined for store metadata (e.g.
// store.lock.json) or an unmatched rel.
export function resolveGroupByStoreRel(groups: SyncGroup[], rel: string): SyncGroup | undefined {
  if (!rel.startsWith("store/")) return undefined;
  const inner = rel.slice("store/".length);
  for (const g of groups) {
    const sp = groupStorePath(g.path);
    if (g.type === "file" && inner === sp) return g;
    if (g.type === "dir" && inner.startsWith(sp + "/")) return g;
  }
  return undefined;
}
