import { FileIO, ensureParentDir, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { GroupResult, StoreLock, SyncGroup, SyncManifest } from "./types";
import { groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { parseStoreLock, parseSyncManifest } from "./manifest";
import { sanitizeJson, mergePreservingSanitized } from "./sanitize";

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
  now(): string; // ISO-8601 timestamp, injectable for tests
}

export function manifestPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/manifest.json`;
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

export function backupDir(ctx: CoreContext): string {
  return `${ctx.configDir}/plugins/obsidian-config-sync/backup`;
}

export function pluginIdForGroup(group: SyncGroup): string | null {
  const m = group.path.match(/^\{configDir\}\/plugins\/([^/]+)\//);
  return m && m[1] !== undefined ? m[1] : null;
}

export async function loadManifest(ctx: CoreContext): Promise<SyncManifest> {
  const p = manifestPath(ctx);
  if (!(await ctx.io.exists(p))) {
    throw new Error(`Config Sync manifest not found: ${p}. Create it before running commands (see README).`);
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

function parseJsonOrThrow(raw: string, groupName: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Group "${groupName}": ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function emptyResult(group: string, needsAppReload: boolean): GroupResult {
  return { group, status: "ok", filesWritten: [], filesDeleted: [], messages: [], needsAppReload };
}

function requireGroup(manifest: SyncManifest, name: string): SyncGroup {
  const group = manifest.groups.find((g) => g.name === name);
  if (group === undefined) {
    throw new Error(`Unknown config-sync group "${name}" — not defined in manifest.json`);
  }
  return group;
}

export async function publish(ctx: CoreContext): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  const lock: StoreLock = { publishedAt: ctx.now(), groups: {} };
  const results: GroupResult[] = [];
  for (const group of manifest.groups) {
    const result = await publishGroup(ctx, group);
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      const version = ctx.plugins.getInstalledPluginVersion(pluginId);
      if (version !== null) {
        lock.groups[group.name] = { sourcePluginVersion: version };
      } else {
        result.status = "warning";
        result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
      }
    }
    results.push(result);
  }
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}

async function publishGroup(ctx: CoreContext, group: SyncGroup): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const result = emptyResult(group.name, false);
  if (!(await ctx.io.exists(real))) {
    throw new Error(`Publish failed: source of group "${group.name}" not found: ${real}`);
  }
  if (group.type === "file") {
    let content = await ctx.io.read(real);
    if (group.sanitize !== undefined) {
      const sanitized = sanitizeJson(parseJsonOrThrow(content, group.name, real), group.sanitize);
      content = JSON.stringify(sanitized, null, 2) + "\n";
    }
    await ensureParentDir(ctx.io, store);
    await ctx.io.write(store, content);
    result.filesWritten.push(store);
    return result;
  }
  const sourceFiles = await listFilesRecursive(ctx.io, real);
  const sourceRels = sourceFiles.map((f) => relativeTo(real, f));
  for (const rel of sourceRels) {
    const target = `${store}/${rel}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await ctx.io.read(`${real}/${rel}`));
    result.filesWritten.push(target);
  }
  if (await ctx.io.exists(store)) {
    const storeFiles = await listFilesRecursive(ctx.io, store);
    const wanted = new Set(sourceRels);
    for (const f of storeFiles) {
      if (!wanted.has(relativeTo(store, f))) {
        await ctx.io.remove(f);
        result.filesDeleted.push(f);
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
        message: `store config was published from ${pluginId}@${recorded}, this device runs ${pluginId}@${installed} — settings schema may differ`,
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

export async function apply(ctx: CoreContext, groupNames: string[]): Promise<GroupResult[]> {
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
  for (const name of groupNames) {
    results.push(await applyGroup(ctx, requireGroup(manifest, name), state));
  }
  const indexPath = `${backupDir(ctx)}/index.json`;
  await ensureParentDir(ctx.io, indexPath);
  await ctx.io.write(indexPath, JSON.stringify(state.index, null, 2) + "\n");
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

async function applyGroup(ctx: CoreContext, group: SyncGroup, state: BackupState): Promise<GroupResult> {
  const real = groupRealPath(group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const pluginId = pluginIdForGroup(group);
  const result = emptyResult(group.name, pluginId === null);
  if (!(await ctx.io.exists(store))) {
    result.status = "error";
    result.needsAppReload = false;
    result.messages.push(`store has no data for this group (expected at ${store}) — publish it from the source vault first`);
    return result;
  }
  const pluginWasEnabled = pluginId !== null && ctx.plugins.isPluginEnabled(pluginId);
  if (pluginId !== null && pluginWasEnabled) {
    await ctx.plugins.disablePlugin(pluginId);
  }
  try {
    if (group.type === "file") {
      let content = await ctx.io.read(store);
      if (group.sanitize !== undefined && (await ctx.io.exists(real))) {
        const local = parseJsonOrThrow(await ctx.io.read(real), group.name, real);
        const incoming = parseJsonOrThrow(content, group.name, store);
        content = JSON.stringify(mergePreservingSanitized(local, incoming, group.sanitize), null, 2) + "\n";
      }
      await backupOnce(ctx, state, real);
      await ensureParentDir(ctx.io, real);
      await ctx.io.write(real, content);
      result.filesWritten.push(real);
    } else {
      const storeFiles = await listFilesRecursive(ctx.io, store);
      const rels = storeFiles.map((f) => relativeTo(store, f));
      for (const rel of rels) {
        const target = `${real}/${rel}`;
        await backupOnce(ctx, state, target);
        await ensureParentDir(ctx.io, target);
        await ctx.io.write(target, await ctx.io.read(`${store}/${rel}`));
        result.filesWritten.push(target);
      }
      if (await ctx.io.exists(real)) {
        const realFiles = await listFilesRecursive(ctx.io, real);
        const wanted = new Set(rels);
        for (const f of realFiles) {
          if (!wanted.has(relativeTo(real, f))) {
            await backupOnce(ctx, state, f);
            await ctx.io.remove(f);
            result.filesDeleted.push(f);
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

export async function importExternal(ctx: CoreContext, reader: ExternalStoreReader): Promise<GroupResult> {
  const files = await reader.listFiles();
  if (!files.includes("manifest.json")) {
    throw new Error(`External source has no manifest.json at its root — check the source "root" setting.`);
  }
  parseSyncManifest(await reader.readFile("manifest.json")); // fail fast on invalid upstream data
  const result = emptyResult("import", false);
  for (const rel of files) {
    const target = `${ctx.rootPath}/${rel}`;
    await ensureParentDir(ctx.io, target);
    await ctx.io.write(target, await reader.readFile(rel));
    result.filesWritten.push(target);
  }
  const wanted = new Set(files.map((f) => `${ctx.rootPath}/${f}`));
  const localFiles = await listFilesRecursive(ctx.io, ctx.rootPath);
  for (const f of localFiles) {
    if (!wanted.has(f)) {
      await ctx.io.remove(f);
      result.filesDeleted.push(f);
    }
  }
  await pruneEmptyDirsUnder(ctx.io, ctx.rootPath);
  return result;
}
