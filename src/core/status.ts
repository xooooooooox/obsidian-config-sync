import { CoreContext, ExternalStoreReader, groupForStoreRel, isSelfStoreRel, loadManifest, overlayGroup, remoteGroupsFrom, storeDir } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { basename, groupStorePath, relativeTo, sidecarStoreSuffix } from "./pathing";
import { FileChanges, hasChanges, StoreLock, SyncGroup } from "./types";
import { parseStoreLock } from "./manifest";
import { contentUnchanged, groupNeedsPassphrase } from "./modes";
import { parseFileEnvelope } from "./crypto";
import { localRealPath, parseSwitchList, readLocalSwitchList, SWITCH_LIST_GROUPS, switchListsEqual } from "./switchList";
import { ABSENT_HASH, BaselineEntry, hashDirSide, hashFileSide, Ledger, LedgerUpdates } from "./ledger";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured" | "never-synced" | "no-settings" | "locked";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
  changes?: FileChanges;
}

type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; localHash: string; storeHash: string };

export async function statusForGroups(
  ctx: CoreContext,
  groups: SyncGroup[],
  ledger: Ledger
): Promise<{ statuses: GroupStatus[]; updates: LedgerUpdates }> {
  const statuses: GroupStatus[] = [];
  const updates: LedgerUpdates = {};
  for (const group of groups) {
    try {
      const r = await groupStatus(ctx, group, ledger.groups[group.name]);
      statuses.push(r.status);
      if (r.update !== undefined) updates[group.name] = r.update;
    } catch (e) {
      statuses.push({ group: group.name, state: "differs", message: (e as Error).message });
    }
  }
  return { statuses, updates };
}

// Direction is a three-way comparison against this device's last-synced baseline (spec
// 2026-07-27): no baseline → never-synced; one side moved → that side is the direction; both
// moved (or neither — a scope/rule change shifted the comparison lens) → differs. in-sync
// reseeds the baseline; not-captured/no-settings drop it; locked keeps it (a missing
// passphrase is temporary and must not degrade direction knowledge).
async function groupStatus(
  ctx: CoreContext,
  group: SyncGroup,
  baseline: BaselineEntry | undefined
): Promise<{ status: GroupStatus; update?: BaselineEntry | null }> {
  if (groupNeedsPassphrase(group) && ctx.passphrase === null) {
    return { status: { group: group.name, state: "locked" } };
  }
  const real = localRealPath(group.name, group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const cmp = group.type === "file" ? await compareFile(ctx, group, real, store) : await compareDir(ctx, group, real, store);
  if (cmp === "no-settings") return { status: { group: group.name, state: "no-settings" }, update: null };
  if (cmp === "not-captured") return { status: { group: group.name, state: "not-captured" }, update: null };
  if (!hasChanges(cmp.changes)) {
    return {
      status: { group: group.name, state: "in-sync" },
      update: { store: cmp.storeHash, local: cmp.localHash, at: ctx.now() },
    };
  }
  if (baseline === undefined) return { status: { group: group.name, state: "never-synced", changes: cmp.changes } };
  const storeMoved = cmp.storeHash !== baseline.store;
  const localMoved = cmp.localHash !== baseline.local;
  const state: GroupState =
    storeMoved && !localMoved ? "store-newer" : localMoved && !storeMoved ? "local-changed" : "differs";
  return { status: { group: group.name, state, changes: cmp.changes } };
}

async function compareFile(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  if (!(await ctx.io.exists(store))) {
    return (await ctx.io.exists(real)) ? "not-captured" : "no-settings";
  }
  const name = basename(real);
  const storeContent = await ctx.io.read(store);
  const storeHash = await hashFileSide(group.name, storeContent, "store");
  if (!(await ctx.io.exists(real))) {
    return { changes: { added: [], updated: [], deleted: [name] }, localHash: ABSENT_HASH, storeHash };
  }
  const liveContent = await ctx.io.read(real);
  const localHash = await hashFileSide(group.name, liveContent, "local");
  const exc = SWITCH_LIST_GROUPS.has(group.name) ? ctx.switchExceptions[group.name] ?? [] : [];
  // Switch lists ALWAYS compare as sets — exceptions or not. The old `exc.length > 0` guard
  // made exception-free devices fall through to byte comparison, where local enable-order vs
  // store-stable order reads as a permanent phantom "To capture" (real-vault find 2026-07-17).
  const switchEqual =
    SWITCH_LIST_GROUPS.has(group.name) ? switchListEqualOrNull(group.name, liveContent, storeContent, exc) : null;
  const sidecar = store + sidecarStoreSuffix(ctx.deviceClass);
  const ownScope = (await ctx.io.exists(sidecar)) ? await ctx.io.read(sidecar) : null;
  const effGroup = overlayGroup(ctx, group, [liveContent, storeContent, ownScope]);
  const equal =
    switchEqual !== null
      ? switchEqual
      : parseFileEnvelope(storeContent) !== null || effGroup.mode === "fields" || effGroup.mode === "encrypted"
        ? await contentUnchanged(effGroup, liveContent, storeContent, ctx.passphrase, ctx.deviceClass, ownScope)
        : liveContent === storeContent;
  const changes: FileChanges = equal ? { added: [], updated: [], deleted: [] } : { added: [], updated: [name], deleted: [] };
  return { changes, localHash, storeHash };
}

// For switch-list groups with exceptions: compare with switchListsEqual when both sides parse
// as a switch list; otherwise return null to fall through to the existing comparison path.
function switchListEqualOrNull(name: string, liveContent: string, storeContent: string, exc: string[]): boolean | null {
  const live = readLocalSwitchList(name, liveContent);
  const store = parseSwitchList(storeContent);
  if (live === null || store === null) return null;
  return switchListsEqual(live, store, exc);
}

async function compareDir(ctx: CoreContext, group: SyncGroup, real: string, store: string): Promise<Comparison> {
  const liveFiles = (await ctx.io.exists(real)) ? (await listFilesRecursive(ctx.io, real)).filter((f) => !isJunkPath(f)) : [];
  const storeFiles = (await ctx.io.exists(store)) ? (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f)) : [];
  if (storeFiles.length === 0) return liveFiles.length === 0 ? "no-settings" : "not-captured";
  const liveEntries: { rel: string; content: string }[] = [];
  for (const f of liveFiles) liveEntries.push({ rel: relativeTo(real, f), content: await ctx.io.read(f) });
  const storeEntries: { rel: string; content: string }[] = [];
  for (const f of storeFiles) storeEntries.push({ rel: relativeTo(store, f), content: await ctx.io.read(f) });
  const liveByRel = new Map(liveEntries.map((e) => [e.rel, e.content]));
  const storeByRel = new Map(storeEntries.map((e) => [e.rel, e.content]));
  const changes: FileChanges = { added: [], updated: [], deleted: [] };
  for (const e of liveEntries) {
    const storeContent = storeByRel.get(e.rel);
    if (storeContent === undefined) {
      changes.added.push(e.rel);
      continue;
    }
    const equal =
      group.mode === "encrypted"
        ? await contentUnchanged(group, e.content, storeContent, ctx.passphrase, ctx.deviceClass, null)
        : e.content === storeContent;
    if (!equal) changes.updated.push(e.rel);
  }
  for (const e of storeEntries) {
    if (!liveByRel.has(e.rel)) changes.deleted.push(e.rel);
  }
  return { changes, localHash: await hashDirSide(liveEntries), storeHash: await hashDirSide(storeEntries) };
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
    else if (s.state === "store-newer" || s.state === "differs" || s.state === "never-synced") down++;
    else if (s.state === "no-settings" || s.state === "locked") none++;
    else ok++;
  }
  return { up, down, ok, none };
}

// Push/pull are per-remote whole-store states, not item counts: a remote is
// "older" (push would update it) or "newer" (pull would update the store).
// Counts how many remotes need each direction. same/no-store/unknown → neither.
export function remoteDirectionCounts(states: RemoteState[]): { push: number; pull: number } {
  let push = 0;
  let pull = 0;
  for (const s of states) {
    if (s === "remote-older") push++;
    else if (s === "remote-newer") pull++;
  }
  return { push, pull };
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

// "Remote has newer version info" — semantic, not byte, comparison of the two store locks
// (2026-07-17: byte compare kept the hint alive forever, since a merged local lock keeps
// local-only entries and its own formatting). True when the remote captured later, or when a
// remote group entry is missing/different locally. Local-only entries and a locally-newer
// capturedAt never count — a pull would not change them. ignoreGroups names lock entries that
// never count (the self group when the remote excludes it).
export function remoteLockAhead(localRaw: string | null, remoteRaw: string | null, ignoreGroups: string[]): boolean {
  if (remoteRaw === null) return false;
  if (localRaw === null) return true;
  let local: StoreLock;
  let remote: StoreLock;
  try {
    local = parseStoreLock(localRaw);
    remote = parseStoreLock(remoteRaw);
  } catch {
    return localRaw !== remoteRaw;
  }
  const l = Date.parse(local.capturedAt);
  const r = Date.parse(remote.capturedAt);
  if (!Number.isNaN(l) && !Number.isNaN(r) && r > l) return true;
  for (const [name, entry] of Object.entries(remote.groups)) {
    if (ignoreGroups.includes(name)) continue;
    const mine = local.groups[name];
    if (mine === undefined || JSON.stringify(mine) !== JSON.stringify(entry)) return true;
  }
  return false;
}

export interface RemoteDiffFile {
  itemRel: string;                       // display path within the item (resolve()'s itemRel)
  kind: "added" | "updated" | "deleted"; // added = only at the remote; deleted = only in the local store
  local: string | null;                  // content in the local store; null when the file doesn't exist there
  remote: string | null;                 // content at the remote; null when the file doesn't exist there
}

export interface RemoteDiffEntry {
  group: string;
  files: RemoteDiffFile[];
}

// Store files that neither manifest can attribute to a group. Kept visible (instead of being
// filtered as metadata) so a delta never silently reads as "contents match".
export const OTHER_STORE_FILES_GROUP = "(other store files)";

export async function diffRemote(ctx: CoreContext, reader: ExternalStoreReader, opts: { excludeSelf: boolean }): Promise<RemoteDiffEntry[]> {
  const manifest = await loadManifest(ctx);
  const remoteFiles = await reader.listFiles();
  // A fresh device knows few or no groups yet, so attribution falls back to the REMOTE
  // manifest — otherwise every remote file would land in the metadata pseudo-group and the
  // whole delta would be dropped (the "contents match" false negative).
  const remoteGroups = await remoteGroupsFrom(reader, remoteFiles);
  const resolve = (rel: string): { name: string; itemRel: string } => {
    const local = groupForStoreRel(manifest.groups, rel);
    if (local.name !== "") return local;
    const remote = groupForStoreRel(remoteGroups, rel);
    if (remote.name !== "") return remote;
    // Only true bookkeeping (store.lock.json, legacy root manifests) lives outside store/.
    return rel.startsWith("store/") ? { name: OTHER_STORE_FILES_GROUP, itemRel: rel } : { name: "", itemRel: rel };
  };
  const localFiles = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const localRels = new Set(localFiles.map((f) => f.slice(ctx.rootPath.length + 1)));
  const byName = new Map<string, RemoteDiffEntry>();
  const entry = (name: string): RemoteDiffEntry => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { group: name, files: [] };
      byName.set(name, e);
    }
    return e;
  };
  const filesMatch = (name: string, remoteContent: string, localContent: string): boolean => {
    if (remoteContent === localContent) return true;
    // Switch-list store copies are order-insensitive: each device captures in its own
    // store-stable order, so equal membership in a different order is not a difference.
    if (!SWITCH_LIST_GROUPS.has(name)) return false;
    const a = parseSwitchList(remoteContent);
    const b = parseSwitchList(localContent);
    return a !== null && b !== null && switchListsEqual(a, b, []);
  };
  for (const rel of remoteFiles) {
    if (opts.excludeSelf && isSelfStoreRel(rel)) continue;
    const { name, itemRel } = resolve(rel);
    if (!localRels.has(rel)) {
      entry(name).files.push({ itemRel, kind: "added", local: null, remote: await reader.readFile(rel) });
    } else {
      const remoteContent = await reader.readFile(rel);
      const localContent = await ctx.io.read(`${ctx.rootPath}/${rel}`);
      if (!filesMatch(name, remoteContent, localContent)) {
        entry(name).files.push({ itemRel, kind: "updated", local: localContent, remote: remoteContent });
      }
    }
  }
  const remoteSet = new Set(remoteFiles);
  for (const rel of localRels) {
    if (opts.excludeSelf && isSelfStoreRel(rel)) continue;
    if (!remoteSet.has(rel)) {
      const { name, itemRel } = resolve(rel);
      entry(name).files.push({ itemRel, kind: "deleted", local: await ctx.io.read(`${ctx.rootPath}/${rel}`), remote: null });
    }
  }
  // The "" store-metadata pseudo-entry (lock + manifest bookkeeping) drifts on every capture;
  // it is not a difference worth reporting here. Pull/push REPORTS still show it.
  return [...byName.values()].filter((e) => e.group !== "" && e.files.length > 0);
}
