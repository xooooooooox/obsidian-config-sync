import { FileIO, ensureParentDir, isJunkPath, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { GroupResult, hasChanges, StoreLock, SyncGroup, SyncManifest } from "./types";
import { basename, groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { parseStoreLock, parseSyncManifest, validateSyncManifest } from "./manifest";
import { applyTransform, captureTransform, contentUnchanged } from "./modes";

export type ProgressFn = (done: number, total: number, current: string) => void;

export interface PluginHost {
  getInstalledPluginVersion(id: string): string | null;
  isPluginEnabled(id: string): boolean;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
}

export interface CoreContext {
  io: FileIO;
  configDir: string;
  rootPath: string;
  plugins: PluginHost;
  passphrase: string | null;
  now(): string; // ISO-8601 timestamp, injectable for tests
}

export function manifestPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/config-sync.json`;
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

export function backupDir(ctx: CoreContext): string {
  return `${ctx.configDir}/plugins/config-sync/backup`;
}

export function pluginIdForGroup(group: SyncGroup): string | null {
  const m = group.path.match(/^\{configDir\}\/plugins\/([^/]+)(\/|$)/);
  return m && m[1] !== undefined ? m[1] : null;
}

export async function loadManifest(ctx: CoreContext): Promise<SyncManifest> {
  const p = manifestPath(ctx);
  if (!(await ctx.io.exists(p))) {
    throw new Error(
      `Config Sync groups file not found: ${p}. Run Capture or Apply to create a starter, or add a group in Settings → Config Sync.`
    );
  }
  return parseSyncManifest(await ctx.io.read(p));
}

export async function loadLock(ctx: CoreContext): Promise<StoreLock | null> {
  const p = lockPath(ctx);
  if (!(await ctx.io.exists(p))) return null;
  return parseStoreLock(await ctx.io.read(p));
}

export function groupsForDevice(manifest: SyncManifest, device: "desktop" | "mobile"): SyncGroup[] {
  return manifest.groups.filter((g) => g.devices === "all" || g.devices === device);
}

export function parseJsonOrThrow(raw: string, groupName: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Group "${groupName}": ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export function groupForStoreRel(groups: SyncGroup[], rel: string): { name: string; itemRel: string } {
  if (rel.startsWith("store/")) {
    const inner = rel.slice("store/".length);
    for (const g of groups) {
      const sp = groupStorePath(g.path);
      if (g.type === "file" && inner === sp) return { name: g.name, itemRel: basename(sp) };
      if (g.type === "dir" && inner.startsWith(sp + "/")) return { name: g.name, itemRel: inner.slice(sp.length + 1) };
    }
  }
  return { name: "", itemRel: rel }; // store metadata / unmatched
}

function emptyResult(group: string, needsAppReload: boolean): GroupResult {
  return {
    group,
    status: "ok",
    filesWritten: [],
    filesDeleted: [],
    messages: [],
    needsAppReload,
    changes: { added: [], updated: [], deleted: [] },
  };
}

async function writeClassified(
  ctx: CoreContext,
  target: string,
  content: string,
  relName: string,
  result: GroupResult,
  unchanged?: (existing: string) => Promise<boolean>
): Promise<void> {
  const existed = await ctx.io.exists(target);
  if (existed) {
    const existing = await ctx.io.read(target);
    const isUnchanged = unchanged !== undefined ? await unchanged(existing) : existing === content;
    if (isUnchanged) return; // unchanged: skip the write
  }
  await ensureParentDir(ctx.io, target);
  await ctx.io.write(target, content);
  result.filesWritten.push(target);
  (existed ? result.changes.updated : result.changes.added).push(relName);
}

function requireGroup(manifest: SyncManifest, name: string): SyncGroup {
  const group = manifest.groups.find((g) => g.name === name);
  if (group === undefined) {
    throw new Error(`Unknown config-sync group "${name}" — not defined in config-sync.json`);
  }
  return group;
}

export async function capture(ctx: CoreContext, names?: string[], onProgress?: ProgressFn): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  // Capture is the lock's writer and its only healing path: a previous lock that is
  // missing, old-format, or corrupt must never block capture — it is rewritten below.
  let previous: StoreLock | null = null;
  try {
    previous = await loadLock(ctx);
  } catch {
    previous = null;
  }
  const selected = names === undefined ? null : new Set(names);
  const toProcess = manifest.groups.filter((g) => selected === null || selected.has(g.name));
  const lock: StoreLock = { capturedAt: ctx.now(), groups: {} };
  const results: GroupResult[] = [];
  let done = 0;
  for (const group of manifest.groups) {
    if (selected !== null && !selected.has(group.name)) {
      const prev = previous?.groups[group.name];
      if (prev !== undefined) lock.groups[group.name] = prev; // not captured this run — carry forward
      continue;
    }
    onProgress?.(done, toProcess.length, group.name);
    const result = await captureGroup(ctx, group);
    done++;
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      if (result.status !== "error") {
        const version = ctx.plugins.getInstalledPluginVersion(pluginId);
        if (version !== null) {
          lock.groups[group.name] = { sourcePluginVersion: version };
        } else {
          result.status = "warning";
          result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
        }
      } else {
        const prev = previous?.groups[group.name];
        if (prev !== undefined) lock.groups[group.name] = prev; // errored capture keeps the last known version
      }
    }
    results.push(result);
  }
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}

async function captureGroup(ctx: CoreContext, group: SyncGroup): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const result = emptyResult(group.name, false);
  if (!(await ctx.io.exists(real))) {
    result.status = "error";
    result.messages.push(`nothing to capture yet: ${real} does not exist in this vault`);
    return result;
  }
  if (group.type === "file") {
    const plainLocalContent = await ctx.io.read(real);
    const t = await captureTransform(group, plainLocalContent, ctx.passphrase);
    if (t.note !== null) result.messages.push(t.note);
    await writeClassified(ctx, store, t.content, basename(real), result, (existing) =>
      contentUnchanged(group, plainLocalContent, existing, ctx.passphrase)
    );
    return result;
  }
  const sourceFiles = await listFilesRecursive(ctx.io, real);
  const sourceRels = sourceFiles.map((f) => relativeTo(real, f)).filter((rel) => !isJunkPath(rel));
  for (const rel of sourceRels) {
    const target = `${store}/${rel}`;
    const plainLocalContent = await ctx.io.read(`${real}/${rel}`);
    if (group.mode === "encrypted") {
      const t = await captureTransform(group, plainLocalContent, ctx.passphrase);
      await writeClassified(ctx, target, t.content, rel, result, (existing) =>
        contentUnchanged(group, plainLocalContent, existing, ctx.passphrase)
      );
    } else {
      await writeClassified(ctx, target, plainLocalContent, rel, result);
    }
  }
  if (await ctx.io.exists(store)) {
    const storeFiles = await listFilesRecursive(ctx.io, store);
    const wanted = new Set(sourceRels);
    for (const f of storeFiles) {
      if (!wanted.has(relativeTo(store, f))) {
        await ctx.io.remove(f);
        result.filesDeleted.push(f);
        result.changes.deleted.push(relativeTo(store, f));
      }
    }
    await pruneEmptyDirsUnder(ctx.io, store);
  }
  return result;
}

export interface ApplyWarning {
  group: string;
  message: string;
}

export interface BackupEntry {
  realPath: string;
  existed: boolean;
  backupFile: string | null;
}

export interface BackupIndex {
  createdAt: string;
  entries: BackupEntry[];
}

interface BackupState {
  index: BackupIndex;
  counter: number;
  backedUp: Set<string>;
}

export async function checkApply(ctx: CoreContext, groupNames: string[]): Promise<ApplyWarning[]> {
  const manifest = await loadManifest(ctx);
  const lock = await loadLock(ctx);
  const warnings: ApplyWarning[] = [];
  for (const name of groupNames) {
    const group = requireGroup(manifest, name);
    const pluginId = pluginIdForGroup(group);
    if (pluginId === null) continue;
    const installed = ctx.plugins.getInstalledPluginVersion(pluginId);
    const recorded = lock?.groups[name]?.sourcePluginVersion ?? null;
    if (installed === null) {
      warnings.push({
        group: name,
        message: `plugin "${pluginId}" is not installed on this device; its config will be staged for a future install`,
      });
    } else if (recorded !== null && recorded !== installed) {
      warnings.push({
        group: name,
        message: `store config was captured with ${pluginId}@${recorded}, this device runs ${pluginId}@${installed} — settings schema may differ`,
      });
    } else if (recorded === null) {
      warnings.push({
        group: name,
        message: `store.lock.json has no recorded version for this group — cannot verify compatibility`,
      });
    }
  }
  return warnings;
}

export async function apply(ctx: CoreContext, groupNames: string[], onProgress?: ProgressFn): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  if (await ctx.io.exists(backupDir(ctx))) {
    await ctx.io.rmdir(backupDir(ctx), true);
  }
  const state: BackupState = {
    index: { createdAt: ctx.now(), entries: [] },
    counter: 0,
    backedUp: new Set(),
  };
  const results: GroupResult[] = [];
  let done = 0;
  try {
    for (const name of groupNames) {
      onProgress?.(done, groupNames.length, name);
      results.push(await applyGroup(ctx, requireGroup(manifest, name), state));
      done++;
    }
  } finally {
    const indexPath = `${backupDir(ctx)}/index.json`;
    await ensureParentDir(ctx.io, indexPath);
    await ctx.io.write(indexPath, JSON.stringify(state.index, null, 2) + "\n");
  }
  return results;
}

async function backupOnce(ctx: CoreContext, state: BackupState, realPath: string): Promise<void> {
  if (state.backedUp.has(realPath)) return;
  state.backedUp.add(realPath);
  const existed = await ctx.io.exists(realPath);
  let backupFile: string | null = null;
  if (existed) {
    backupFile = `files/${state.counter}`;
    state.counter += 1;
    const target = `${backupDir(ctx)}/${backupFile}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await ctx.io.read(realPath));
  }
  state.index.entries.push({ realPath, existed, backupFile });
}

async function applyWriteClassified(
  ctx: CoreContext,
  state: BackupState,
  real: string,
  content: string,
  relName: string,
  result: GroupResult
): Promise<void> {
  await backupOnce(ctx, state, real);
  await writeClassified(ctx, real, content, relName, result);
}

async function applyGroup(ctx: CoreContext, group: SyncGroup, state: BackupState): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const pluginId = pluginIdForGroup(group);
  const result = emptyResult(group.name, pluginId === null);
  if (!(await ctx.io.exists(store))) {
    result.status = "error";
    result.needsAppReload = false;
    result.messages.push(`store has no data for this group (expected at ${store}) — capture it from the source vault first`);
    return result;
  }
  const pluginWasEnabled = pluginId !== null && ctx.plugins.isPluginEnabled(pluginId);
  if (pluginId !== null && pluginWasEnabled) {
    await ctx.plugins.disablePlugin(pluginId);
  }
  try {
    if (group.type === "file") {
      const storeContent = await ctx.io.read(store);
      const localContent = (await ctx.io.exists(real)) ? await ctx.io.read(real) : null;
      const content = await applyTransform(group, storeContent, localContent, ctx.passphrase);
      await applyWriteClassified(ctx, state, real, content, basename(real), result);
    } else {
      const storeFiles = await listFilesRecursive(ctx.io, store);
      const rels = storeFiles.map((f) => relativeTo(store, f));
      for (const rel of rels) {
        const target = `${real}/${rel}`;
        const storeContent = await ctx.io.read(`${store}/${rel}`);
        const content =
          group.mode === "encrypted"
            ? await applyTransform(group, storeContent, null, ctx.passphrase)
            : storeContent;
        await applyWriteClassified(ctx, state, target, content, rel, result);
      }
      if (await ctx.io.exists(real)) {
        const realFiles = await listFilesRecursive(ctx.io, real);
        const wanted = new Set(rels);
        for (const f of realFiles) {
          if (!wanted.has(relativeTo(real, f))) {
            await backupOnce(ctx, state, f);
            await ctx.io.remove(f);
            result.filesDeleted.push(f);
            result.changes.deleted.push(relativeTo(real, f));
          }
        }
        await pruneEmptyDirsUnder(ctx.io, real);
      }
    }
  } finally {
    if (pluginId !== null && pluginWasEnabled) {
      await ctx.plugins.enablePlugin(pluginId);
    }
  }
  return result;
}

export async function revertLastApply(ctx: CoreContext): Promise<GroupResult> {
  const indexPath = `${backupDir(ctx)}/index.json`;
  if (!(await ctx.io.exists(indexPath))) {
    throw new Error(`No apply backup found (${indexPath}). Nothing to revert.`);
  }
  const index = JSON.parse(await ctx.io.read(indexPath)) as BackupIndex;
  const result = emptyResult("revert", true);
  result.messages.push(`reverted the apply from ${index.createdAt}; reload the app to take effect`);
  for (const entry of index.entries) {
    if (entry.existed && entry.backupFile !== null) {
      await ensureParentDir(ctx.io, entry.realPath);
      await ctx.io.write(entry.realPath, await ctx.io.read(`${backupDir(ctx)}/${entry.backupFile}`));
      result.filesWritten.push(entry.realPath);
    } else if (await ctx.io.exists(entry.realPath)) {
      await ctx.io.remove(entry.realPath);
      result.filesDeleted.push(entry.realPath);
    }
  }
  return result;
}

export interface ExternalStoreReader {
  listFiles(): Promise<string[]>; // relative to the source <root>/, "/"-separated
  readFile(relPath: string): Promise<string>;
}

export async function importExternal(ctx: CoreContext, reader: ExternalStoreReader): Promise<GroupResult[]> {
  const files = await reader.listFiles();
  if (!files.includes("config-sync.json")) {
    throw new Error(`External source has no config-sync.json at its root — check the source "root" setting.`);
  }
  const incoming = parseSyncManifest(await reader.readFile("config-sync.json")); // fail fast on invalid upstream data
  const byName = new Map<string, GroupResult>();
  const resultFor = (name: string): GroupResult => {
    let r = byName.get(name);
    if (r === undefined) {
      r = emptyResult(name, false);
      byName.set(name, r);
    }
    return r;
  };
  for (const rel of files) {
    const target = `${ctx.rootPath}/${rel}`;
    const { name, itemRel } = groupForStoreRel(incoming.groups, rel);
    await writeClassified(ctx, target, await reader.readFile(rel), itemRel, resultFor(name));
  }
  const wanted = new Set(files.map((f) => `${ctx.rootPath}/${f}`));
  const localFiles = await listFilesRecursive(ctx.io, ctx.rootPath);
  for (const f of localFiles) {
    if (!wanted.has(f)) {
      const rel = relativeTo(ctx.rootPath, f);
      const { name, itemRel } = groupForStoreRel(incoming.groups, rel);
      await ctx.io.remove(f);
      const result = resultFor(name);
      result.filesDeleted.push(f);
      result.changes.deleted.push(itemRel);
    }
  }
  await pruneEmptyDirsUnder(ctx.io, ctx.rootPath);
  const isAffected = (r: GroupResult): boolean => hasChanges(r.changes);
  const named = incoming.groups
    .map((g) => byName.get(g.name))
    .filter((r): r is GroupResult => r !== undefined && isAffected(r));
  const meta = byName.get("");
  return meta !== undefined && isAffected(meta) ? [...named, meta] : named;
}

export interface ExternalStoreWriter {
  listFiles(): Promise<string[]>; // existing remote files, relative to <root>/, "/"-separated
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  finalize(): Promise<void>; // git: add/commit/push; local-path: no-op
}

export async function pushExternal(ctx: CoreContext, writer: ExternalStoreWriter): Promise<GroupResult[]> {
  const localAbs = await listFilesRecursive(ctx.io, ctx.rootPath);
  const rels = localAbs.map((f) => f.slice(ctx.rootPath.length + 1)).sort();
  if (!rels.includes("config-sync.json")) {
    throw new Error(
      `Local store has no config-sync.json at ${ctx.rootPath} — capture from this device (or pull) before pushing.`
    );
  }
  const manifest = await loadManifest(ctx);
  const byName = new Map<string, GroupResult>();
  const resultFor = (name: string): GroupResult => {
    let r = byName.get(name);
    if (r === undefined) {
      r = emptyResult(name, false);
      byName.set(name, r);
    }
    return r;
  };
  const remoteFiles = new Set(await writer.listFiles());
  for (const rel of rels) {
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    const content = await ctx.io.read(`${ctx.rootPath}/${rel}`);
    const existed = remoteFiles.has(rel);
    if (existed && (await writer.readFile(rel)) === content) continue; // unchanged: skip the write
    await writer.writeFile(rel, content);
    const result = resultFor(name);
    result.filesWritten.push(rel);
    (existed ? result.changes.updated : result.changes.added).push(itemRel);
  }
  const wanted = new Set(rels);
  for (const rel of remoteFiles) {
    if (!wanted.has(rel)) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
      await writer.deleteFile(rel);
      const result = resultFor(name);
      result.filesDeleted.push(rel);
      result.changes.deleted.push(itemRel);
    }
  }
  await writer.finalize();
  const named = manifest.groups.map((g) => byName.get(g.name)).filter((r): r is GroupResult => r !== undefined);
  const meta = byName.get("");
  return meta !== undefined ? [...named, meta] : named;
}

export const SCHEMA_URL =
  "https://raw.githubusercontent.com/xooooooooox/obsidian-config-sync/main/schema/config-sync.schema.json";

export const STARTER_MANIFEST =
  JSON.stringify(
    {
      $schema: SCHEMA_URL,
      version: 1,
      groups: [
        { name: "snippets", path: "{configDir}/snippets", type: "dir", devices: "all", description: "CSS snippets" },
        { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", description: "Custom keyboard shortcuts" },
      ],
    },
    null,
    2
  ) + "\n";

export async function createStarterManifest(ctx: CoreContext): Promise<"created" | "exists"> {
  const p = manifestPath(ctx);
  if (await ctx.io.exists(p)) return "exists";
  await ensureParentDir(ctx.io, p);
  await ctx.io.write(p, STARTER_MANIFEST);
  return "created";
}

export async function readGroups(ctx: CoreContext): Promise<SyncGroup[]> {
  const p = manifestPath(ctx);
  if (!(await ctx.io.exists(p))) return [];
  return parseSyncManifest(await ctx.io.read(p)).groups;
}

export async function writeGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<void> {
  const manifest = validateSyncManifest({ version: 1, groups });
  const p = manifestPath(ctx);
  await ensureParentDir(ctx.io, p);
  await ctx.io.write(p, JSON.stringify({ $schema: SCHEMA_URL, version: 1, groups: manifest.groups }, null, 2) + "\n");
}
