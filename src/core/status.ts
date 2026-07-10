import { CoreContext, ExternalStoreReader, loadLock, parseJsonOrThrow, storeDir } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { sanitizeJson } from "./sanitize";
import { StoreLock, SyncGroup } from "./types";
import { parseStoreLock } from "./manifest";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
}

type Comparison = "equal" | "not-captured" | { liveFiles: string[] };

export async function statusForGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<GroupStatus[]> {
  // The lock is optional context for direction hints; never let it block status.
  let capturedAtMs: number | null = null;
  try {
    const lock = await loadLock(ctx);
    if (lock !== null) {
      const ms = Date.parse(lock.capturedAt);
      capturedAtMs = Number.isNaN(ms) ? null : ms;
    }
  } catch {
    capturedAtMs = null;
  }
  const out: GroupStatus[] = [];
  for (const group of groups) {
    try {
      out.push(await groupStatus(ctx, group, capturedAtMs));
    } catch (e) {
      out.push({ group: group.name, state: "differs", message: (e as Error).message });
    }
  }
  return out;
}

async function groupStatus(ctx: CoreContext, group: SyncGroup, capturedAtMs: number | null): Promise<GroupStatus> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const cmp = group.type === "file" ? await compareFile(ctx, group, real, store) : await compareDir(ctx, real, store);
  if (cmp === "not-captured") return { group: group.name, state: "not-captured" };
  if (cmp === "equal") return { group: group.name, state: "in-sync" };
  let maxMtime: number | null = null;
  for (const f of cmp.liveFiles) {
    const s = await ctx.io.stat(f);
    if (s !== null && (maxMtime === null || s.mtime > maxMtime)) maxMtime = s.mtime;
  }
  if (maxMtime === null || capturedAtMs === null) return { group: group.name, state: "differs" };
  return { group: group.name, state: maxMtime > capturedAtMs ? "local-changed" : "store-newer" };
}

async function compareFile(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  if (!(await ctx.io.exists(store))) return "not-captured";
  if (!(await ctx.io.exists(real))) return { liveFiles: [] };
  const storeContent = await ctx.io.read(store);
  const liveContent = await ctx.io.read(real);
  if (group.sanitize !== undefined) {
    // capture stores the sanitized view — compare canonical sanitized JSON, not raw text
    const liveCanon = JSON.stringify(sanitizeJson(parseJsonOrThrow(liveContent, group.name, real), group.sanitize));
    const storeCanon = JSON.stringify(parseJsonOrThrow(storeContent, group.name, store));
    return liveCanon === storeCanon ? "equal" : { liveFiles: [real] };
  }
  return liveContent === storeContent ? "equal" : { liveFiles: [real] };
}

async function compareDir(ctx: CoreContext, real: string, store: string): Promise<Comparison> {
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return "not-captured";
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const liveRels = liveFiles.map((f) => relativeTo(real, f));
  const storeRels = storeFiles.map((f) => relativeTo(store, f));
  if (liveRels.length !== storeRels.length || liveRels.some((r, i) => r !== storeRels[i])) return { liveFiles };
  for (const rel of liveRels) {
    if ((await ctx.io.read(`${real}/${rel}`)) !== (await ctx.io.read(`${store}/${rel}`))) return { liveFiles };
  }
  return "equal";
}

export type RemoteState = "no-store" | "same" | "remote-newer" | "remote-older" | "unknown";

export interface RemoteCheck {
  state: RemoteState;
  remoteCapturedAt: string | null;
}

export async function checkRemote(localLock: StoreLock | null, reader: ExternalStoreReader): Promise<RemoteCheck> {
  const files = await reader.listFiles();
  if (!files.includes("config-sync.json")) return { state: "no-store", remoteCapturedAt: null };
  if (!files.includes("store.lock.json")) return { state: "unknown", remoteCapturedAt: null };
  let remote: StoreLock;
  try {
    remote = parseStoreLock(await reader.readFile("store.lock.json"));
  } catch {
    return { state: "unknown", remoteCapturedAt: null };
  }
  if (localLock === null) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  const r = Date.parse(remote.capturedAt);
  const l = Date.parse(localLock.capturedAt);
  if (Number.isNaN(r) || Number.isNaN(l)) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  const state: RemoteState = r > l ? "remote-newer" : r < l ? "remote-older" : "same";
  return { state, remoteCapturedAt: remote.capturedAt };
}
