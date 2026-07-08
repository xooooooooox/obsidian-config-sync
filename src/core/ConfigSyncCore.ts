import { FileIO, ensureParentDir, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { GroupResult, StoreLock, SyncGroup, SyncManifest } from "./types";
import { groupRealPath, groupStorePath, relativeTo } from "./pathing";
import { parseStoreLock, parseSyncManifest } from "./manifest";
import { sanitizeJson } from "./sanitize";

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
