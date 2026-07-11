import { CoreContext, ExternalStoreReader, groupForStoreRel, loadLock, loadManifest, parseJsonOrThrow, storeDir } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { basename, groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { sanitizeJson } from "./sanitize";
import { FileChanges, hasChanges, StoreLock, SyncGroup } from "./types";
import { parseStoreLock } from "./manifest";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
  changes?: FileChanges;
}

type Comparison = "not-captured" | { changes: FileChanges; liveFiles: string[] };

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
  if (!hasChanges(cmp.changes)) return { group: group.name, state: "in-sync" };
  let maxMtime: number | null = null;
  for (const f of cmp.liveFiles) {
    const s = await ctx.io.stat(f);
    if (s !== null && (maxMtime === null || s.mtime > maxMtime)) maxMtime = s.mtime;
  }
  const state: GroupState =
    maxMtime === null || capturedAtMs === null ? "differs" : maxMtime > capturedAtMs ? "local-changed" : "store-newer";
  return { group: group.name, state, changes: cmp.changes };
}

async function compareFile(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  if (!(await ctx.io.exists(store))) return "not-captured";
  const name = basename(real);
  if (!(await ctx.io.exists(real))) {
    return { liveFiles: [], changes: { added: [], updated: [], deleted: [name] } };
  }
  const storeContent = await ctx.io.read(store);
  const liveContent = await ctx.io.read(real);
  let equal: boolean;
  if (group.sanitize !== undefined) {
    // capture stores the sanitized view — compare canonical sanitized JSON, not raw text
    const liveCanon = JSON.stringify(sanitizeJson(parseJsonOrThrow(liveContent, group.name, real), group.sanitize));
    const storeCanon = JSON.stringify(parseJsonOrThrow(storeContent, group.name, store));
    equal = liveCanon === storeCanon;
  } else {
    equal = liveContent === storeContent;
  }
  const changes: FileChanges = equal ? { added: [], updated: [], deleted: [] } : { added: [], updated: [name], deleted: [] };
  return { liveFiles: equal ? [] : [real], changes };
}

async function compareDir(ctx: CoreContext, real: string, store: string): Promise<Comparison> {
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return "not-captured";
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const liveRels = liveFiles.map((f) => relativeTo(real, f));
  const storeRels = storeFiles.map((f) => relativeTo(store, f));
  const liveSet = new Set(liveRels);
  const storeSet = new Set(storeRels);
  const changes: FileChanges = { added: [], updated: [], deleted: [] };
  const changedLiveFiles: string[] = [];
  for (const rel of liveRels) {
    if (!storeSet.has(rel)) {
      changes.added.push(rel);
      changedLiveFiles.push(`${real}/${rel}`);
    } else if ((await ctx.io.read(`${real}/${rel}`)) !== (await ctx.io.read(`${store}/${rel}`))) {
      changes.updated.push(rel);
      changedLiveFiles.push(`${real}/${rel}`);
    }
  }
  for (const rel of storeRels) {
    if (!liveSet.has(rel)) changes.deleted.push(rel);
  }
  return { liveFiles: changedLiveFiles, changes };
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

export interface RemoteDiffEntry {
  group: string;
  changes: FileChanges;
}

export async function diffRemote(ctx: CoreContext, reader: ExternalStoreReader): Promise<RemoteDiffEntry[]> {
  const manifest = await loadManifest(ctx);
  const remoteFiles = await reader.listFiles();
  const localFiles = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const localRels = new Set(localFiles.map((f) => f.slice(ctx.rootPath.length + 1)));
  const byName = new Map<string, RemoteDiffEntry>();
  const entry = (name: string): RemoteDiffEntry => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { group: name, changes: { added: [], updated: [], deleted: [] } };
      byName.set(name, e);
    }
    return e;
  };
  for (const rel of remoteFiles) {
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    if (!localRels.has(rel)) {
      entry(name).changes.added.push(itemRel);
    } else if ((await reader.readFile(rel)) !== (await ctx.io.read(`${ctx.rootPath}/${rel}`))) {
      entry(name).changes.updated.push(itemRel);
    }
  }
  const remoteSet = new Set(remoteFiles);
  for (const rel of localRels) {
    if (!remoteSet.has(rel)) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
      entry(name).changes.deleted.push(itemRel);
    }
  }
  return [...byName.values()].filter((e) => hasChanges(e.changes));
}
