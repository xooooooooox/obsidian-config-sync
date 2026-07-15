import { CoreContext, ExternalStoreReader, groupForStoreRel, loadLock, loadManifest, storeDir } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { basename, groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { FileChanges, hasChanges, StoreLock, SyncGroup } from "./types";
import { parseStoreLock } from "./manifest";
import { contentUnchanged, groupNeedsPassphrase } from "./modes";
import { parseFileEnvelope } from "./crypto";
import { parseSwitchList, SWITCH_LIST_GROUPS, switchListsEqual } from "./switchList";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured" | "no-settings" | "locked";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
  changes?: FileChanges;
}

type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; liveFiles: string[] };

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
  if (groupNeedsPassphrase(group) && ctx.passphrase === null) {
    return { group: group.name, state: "locked" };
  }
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const cmp = group.type === "file" ? await compareFile(ctx, group, real, store) : await compareDir(ctx, group, real, store);
  if (cmp === "no-settings") return { group: group.name, state: "no-settings" };
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
  if (!(await ctx.io.exists(store))) {
    return (await ctx.io.exists(real)) ? "not-captured" : "no-settings";
  }
  const name = basename(real);
  if (!(await ctx.io.exists(real))) {
    return { liveFiles: [], changes: { added: [], updated: [], deleted: [name] } };
  }
  const storeContent = await ctx.io.read(store);
  const liveContent = await ctx.io.read(real);
  const exc = SWITCH_LIST_GROUPS.has(group.name) ? ctx.switchExceptions[group.name] ?? [] : [];
  const switchEqual =
    exc.length > 0 ? switchListEqualOrNull(liveContent, storeContent, exc) : null;
  const equal =
    switchEqual !== null
      ? switchEqual
      : parseFileEnvelope(storeContent) !== null || group.mode === "fields" || group.mode === "encrypted"
        ? await contentUnchanged(group, liveContent, storeContent, ctx.passphrase)
        : liveContent === storeContent;
  const changes: FileChanges = equal ? { added: [], updated: [], deleted: [] } : { added: [], updated: [name], deleted: [] };
  return { liveFiles: equal ? [] : [real], changes };
}

// For switch-list groups with exceptions: compare with switchListsEqual when both sides parse
// as a switch list; otherwise return null to fall through to the existing comparison path.
function switchListEqualOrNull(liveContent: string, storeContent: string, exc: string[]): boolean | null {
  const live = parseSwitchList(liveContent);
  const store = parseSwitchList(storeContent);
  if (live === null || store === null) return null;
  return switchListsEqual(live, store, exc);
}

async function compareDir(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return liveFiles.length === 0 ? "no-settings" : "not-captured";
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
    } else {
      const liveContent = await ctx.io.read(`${real}/${rel}`);
      const storeContent = await ctx.io.read(`${store}/${rel}`);
      const equal =
        group.mode === "encrypted"
          ? await contentUnchanged(group, liveContent, storeContent, ctx.passphrase)
          : liveContent === storeContent;
      if (!equal) {
        changes.updated.push(rel);
        changedLiveFiles.push(`${real}/${rel}`);
      }
    }
  }
  for (const rel of storeRels) {
    if (!liveSet.has(rel)) changes.deleted.push(rel);
  }
  return { liveFiles: changedLiveFiles, changes };
}

export interface BucketCounts {
  up: number; // resolved by Capture: changed here + never captured
  down: number; // resolved by Apply: store newer + differs
  ok: number;
  none: number; // no files on either side — nothing to do
}

export function bucketCounts(statuses: GroupStatus[]): BucketCounts {
  let up = 0;
  let down = 0;
  let ok = 0;
  let none = 0;
  for (const s of statuses) {
    if (s.state === "local-changed" || s.state === "not-captured") up++;
    else if (s.state === "store-newer" || s.state === "differs") down++;
    else if (s.state === "no-settings" || s.state === "locked") none++;
    else ok++;
  }
  return { up, down, ok, none };
}

export type RemoteState = "no-store" | "same" | "remote-newer" | "remote-older" | "unknown";

export interface RemoteCheck {
  state: RemoteState;
  remoteCapturedAt: string | null;
}

export async function checkRemote(localLock: StoreLock | null, reader: ExternalStoreReader): Promise<RemoteCheck> {
  const files = await reader.listFiles();
  // Store presence: new-format stores hold only store/** + store.lock.json (no root manifest);
  // a root config-sync.json still marks a legacy-format store.
  const hasStore = files.some((f) => f.startsWith("store/")) || files.includes("store.lock.json") || files.includes("config-sync.json");
  if (!hasStore) return { state: "no-store", remoteCapturedAt: null };
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
  // The "" store-metadata pseudo-entry (lock + manifest bookkeeping) drifts on every capture;
  // it is not a difference worth reporting here. Pull/push REPORTS still show it.
  return [...byName.values()].filter((e) => e.group !== "" && hasChanges(e.changes));
}
