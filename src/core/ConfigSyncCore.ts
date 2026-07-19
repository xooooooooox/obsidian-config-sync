import { FileIO, ensureParentDir, isJunkPath, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { GroupResult, hasChanges, StoreLock, SyncGroup, SyncManifest } from "./types";
import { basename, groupRealPath, groupStorePath, relativeTo, resolveGroupByStoreRel } from "./pathing";
import { parseStoreLock, parseSyncManifest, validateSyncManifest } from "./manifest";
import { applyTransform, captureTransform, contentUnchanged } from "./modes";
import { classifyMerge, MergePlan } from "./merge";
import { ensureSelfPresets } from "./catalog";
import { isPlainObject } from "./sanitize";
import { applySwitchList, captureSwitchList, parseSwitchList, SWITCH_LIST_GROUPS, SwitchList, switchListsEqual } from "./switchList";

// `current` is the group NAME (the UI maps it to a display label); `phase` is a short live
// phrase for the in-item step ("downloading via BRAT…", "writing settings…") — spec 2026-07-17.
export type ProgressFn = (done: number, total: number, current: string, phase?: string) => void;

export interface PluginHost {
  getInstalledPluginVersion(id: string): string | null;
  isPluginEnabled(id: string): boolean;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  enablePluginPersistent(id: string): Promise<void>;
  getInstalledPluginName(id: string): string | null;
  getCorePluginName(id: string): string | null;
  getAppVersion(): string;
  isCorePluginEnabled(id: string): boolean;
  enableCorePlugin(id: string): Promise<void>;
  reloadPluginManifests(): Promise<void>;
}

export interface GroupsIO {
  read(): Promise<SyncGroup[]>;
  write(groups: SyncGroup[]): Promise<void>;
}

export interface CoreContext {
  io: FileIO;
  configDir: string;
  rootPath: string;
  plugins: PluginHost;
  passphrase: string | null;
  groupsIO: GroupsIO;
  switchExceptions: Record<string, string[]>; // group name -> excepted plugin/core ids (device-local)
  now(): string; // ISO-8601 timestamp, injectable for tests
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

// The apply backup lives OUTSIDE the plugin's own folder: Obsidian (and the Hot Reload
// plugin) watch {configDir}/plugins/config-sync/** and reload Config Sync on any write there,
// which would wipe the Sync Center mid-apply (0.34.0). A top-level configDir folder isn't
// watched and isn't surfaced by discovery (which only scans configDir's top-level files).
export function backupDir(ctx: CoreContext): string {
  return `${ctx.configDir}/config-sync-backup`;
}

export function pluginIdForGroup(group: SyncGroup): string | null {
  const m = group.path.match(/^\{configDir\}\/plugins\/([^/]+)(\/|$)/);
  return m && m[1] !== undefined ? m[1] : null;
}

export async function loadManifest(ctx: CoreContext): Promise<SyncManifest> {
  return { version: 1, groups: await ctx.groupsIO.read() };
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
  const g = resolveGroupByStoreRel(groups, rel);
  if (g === undefined) return { name: "", itemRel: rel }; // store metadata / unmatched
  const sp = groupStorePath(g.path);
  const inner = rel.slice("store/".length);
  return { name: g.name, itemRel: g.type === "file" ? basename(sp) : inner.slice(sp.length + 1) };
}

function excFor(ctx: CoreContext, name: string): string[] {
  return SWITCH_LIST_GROUPS.has(name) ? (ctx.switchExceptions[name] ?? []) : [];
}

function serializeSwitchList(v: ReturnType<typeof captureSwitchList>): string {
  return JSON.stringify(v, null, 2) + "\n";
}

// The enabled-set delta an on/off-list apply writes, as report lines ("turns on: a, b").
function switchDeltaMessages(before: SwitchList | null, after: SwitchList): string[] {
  const enabledIds = (l: SwitchList | null): Set<string> =>
    l === null ? new Set<string>() : new Set(Array.isArray(l) ? l : Object.keys(l).filter((k) => l[k] === true));
  const prev = enabledIds(before);
  const next = enabledIds(after);
  const on = [...next].filter((id) => !prev.has(id)).sort();
  const off = [...prev].filter((id) => !next.has(id)).sort();
  const lines: string[] = [];
  if (on.length > 0) lines.push(`turns on: ${on.join(", ")}`);
  if (off.length > 0) lines.push(`turns off: ${off.join(", ")}`);
  return lines;
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
    throw new Error(`Unknown config-sync group "${name}" — not defined in plugin settings`);
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
          // Version-only refresh: content is byte-identical but the store recorded an older
          // version (local > store drift). captureGroup produces no file change, so without this
          // the run report reads "no changes" even though the store's recorded version changed.
          const prevVersion = previous?.groups[group.name]?.sourcePluginVersion ?? null;
          if (prevVersion !== null && prevVersion !== version && !hasChanges(result.changes) && result.stateNote === undefined) {
            result.stateNote = { kind: "ok", text: `store version refreshed ${prevVersion} → ${version}` };
          }
        } else {
          result.status = "warning";
          result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
        }
      } else {
        const prev = previous?.groups[group.name];
        if (prev !== undefined) lock.groups[group.name] = prev; // errored capture keeps the last known version
      }
    } else if (result.status !== "error") {
      lock.groups[group.name] = { sourceAppVersion: ctx.plugins.getAppVersion() };
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
    const exc = excFor(ctx, group.name);
    // Switch lists take the switch path whether or not exceptions exist — the old exc.length
    // guard left exception-free devices writing local enable-order into the store (2026-07-17).
    const localSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? parseSwitchList(plainLocalContent) : null;
    // Pass-through (甲): excluded ids copy the store's existing state, so read it first.
    let existingStoreList: SwitchList | null = null;
    if (localSwitchList !== null && (await ctx.io.exists(store))) {
      existingStoreList = parseSwitchList(await ctx.io.read(store));
    }
    const captureInput = localSwitchList !== null ? serializeSwitchList(captureSwitchList(localSwitchList, existingStoreList, exc)) : plainLocalContent;
    const t = await captureTransform(group, captureInput, ctx.passphrase);
    if (t.note !== null) result.messages.push(t.note);
    await writeClassified(ctx, store, t.content, basename(real), result, (existing) => {
      if (localSwitchList !== null) {
        const existingSwitchList = parseSwitchList(existing);
        if (existingSwitchList !== null) return Promise.resolve(switchListsEqual(localSwitchList, existingSwitchList, exc));
      }
      return contentUnchanged(group, plainLocalContent, existing, ctx.passphrase);
    });
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

export type StateAction = "none" | "enable" | "update" | "update-enable" | "install" | "install-enable";

export interface ApplyItem {
  name: string;
  action: StateAction;
}

// targetVersion pins the install to the version the store's settings were captured on; the
// installer falls back to latest-stable when that tag is gone and returns what it actually
// installed (so the caller can warn on a mismatch).
export type PluginInstallFn = (pluginId: string, onPhase?: (phase: string) => void, targetVersion?: string) => Promise<string>;

interface StatePrelude {
  note: { kind: "ok" | "warn"; text: string } | null;
  messages: string[];
  skipConfig: boolean;
  // Runs AFTER the config write. Enabling loads the plugin, and a loading plugin reads (and may
  // later re-save) its data.json — so the applied settings must already be on disk, or the
  // plugin's deferred save-on-load overwrites them with stale state.
  finish?: () => Promise<{ note: { kind: "ok" | "warn"; text: string } | null; messages: string[] }>;
}

// Turns a group's plugin (community or core) on and reports the outcome — shared by the
// apply-side deferred finish and the capture-side enable policy.
async function enableForGroup(ctx: CoreContext, group: SyncGroup): Promise<{ note: { kind: "ok" | "warn"; text: string } | null; messages: string[] }> {
  const pluginId = pluginIdForGroup(group);
  try {
    if (pluginId !== null) {
      await ctx.plugins.enablePluginPersistent(pluginId);
      if (!ctx.plugins.isPluginEnabled(pluginId)) {
        throw new Error(`Obsidian did not enable "${pluginId}" — enable it manually in Community plugins`);
      }
    } else {
      await ctx.plugins.enableCorePlugin(group.name);
      if (!ctx.plugins.isCorePluginEnabled(group.name)) {
        throw new Error(`Obsidian did not enable "${group.name}" — enable it in Options → Core plugins`);
      }
    }
    return { note: { kind: "ok", text: "⏻ enabled" }, messages: [] };
  } catch (e) {
    return { note: { kind: "warn", text: "⚠ enable failed" }, messages: [(e as Error).message] };
  }
}

async function runStateAction(
  ctx: CoreContext,
  group: SyncGroup,
  action: StateAction,
  installPlugin: PluginInstallFn,
  hasStoreData: boolean,
  targetVersion: string | null,
  onPhase?: (phase: string) => void
): Promise<StatePrelude> {
  const pluginId = pluginIdForGroup(group);
  if (action === "none") {
    if (pluginId !== null && ctx.plugins.getInstalledPluginVersion(pluginId) === null) {
      return { note: { kind: "ok", text: "selected for install" }, messages: [], skipConfig: false };
    }
    return { note: null, messages: [], skipConfig: false };
  }
  if (action === "enable") {
    return {
      note: null,
      messages: [],
      skipConfig: false,
      finish: () => enableForGroup(ctx, group),
    };
  }
  if (pluginId === null) {
    return {
      note: { kind: "warn", text: "⚠ update failed" },
      messages: [`"${group.name}" has no plugin directory — install and update actions only work for community plugin items`],
      skipConfig: true,
    };
  }
  if (pluginId === "config-sync") {
    // Updating/reinstalling the self plugin from inside a run would disable the very code
    // executing it (update disables first) — refuse and point at Obsidian's own updater.
    return {
      note: { kind: "warn", text: "⚠ update skipped" },
      messages: ["Config Sync updates itself through Obsidian's plugin updater — Settings → Community plugins"],
      skipConfig: true,
    };
  }
  const isUpdate = action === "update" || action === "update-enable";
  const wantsEnable = action === "update-enable" || action === "install-enable";
  const wasEnabled = ctx.plugins.isPluginEnabled(pluginId);
  let version: string;
  try {
    if (isUpdate && wasEnabled) await ctx.plugins.disablePlugin(pluginId);
    onPhase?.(isUpdate ? "updating…" : "installing…");
    version = await installPlugin(pluginId, onPhase, targetVersion ?? undefined);
    await ctx.plugins.reloadPluginManifests();
  } catch (e) {
    const messages = [(e as Error).message];
    if (isUpdate) {
      if (wasEnabled) {
        try {
          await ctx.plugins.enablePlugin(pluginId); // download failed before files changed — restore the running state
        } catch (re) {
          messages.push((re as Error).message);
        }
      }
      return {
        note: { kind: "warn", text: "⚠ update failed" },
        messages: [`${messages[0]} — settings not applied (they were captured on a newer plugin version); update the plugin manually, then apply again`, ...messages.slice(1)],
        skipConfig: true,
      };
    }
    // With store data the settings still get written below; without it there is nothing else
    // to do — the guidance must not claim settings were staged.
    const guidance = hasStoreData ? "settings were applied; install it manually to pick them up" : "install it manually";
    return {
      note: { kind: "warn", text: "⚠ install failed" },
      messages: [`${messages[0]} — ${guidance}`],
      skipConfig: false,
    };
  }
  // Install/update itself succeeded (files written, manifests reloaded). Enabling is deferred
  // to `finish` — it runs after the config write, so the (re)loading plugin reads the APPLIED
  // settings instead of stale ones it could later re-save over them.
  const baseText = isUpdate ? `⤓ updated to ${version}` : `⤓ installed ${version}`;
  // The pinned version's release was gone, so the installer fell back to latest-stable.
  const fallbackMsgs = targetVersion !== null && version !== targetVersion
    ? [`the captured version ${targetVersion} is no longer downloadable — installed ${version} instead`]
    : [];
  if (!(wantsEnable || (isUpdate && wasEnabled))) {
    return { note: { kind: "ok", text: baseText }, messages: fallbackMsgs, skipConfig: false };
  }
  return {
    note: { kind: "ok", text: baseText }, // superseded by finish's note on completion
    messages: fallbackMsgs,
    skipConfig: false,
    finish: async () => {
      try {
        await ctx.plugins.enablePluginPersistent(pluginId);
        if (!ctx.plugins.isPluginEnabled(pluginId)) {
          throw new Error(`Obsidian did not enable "${pluginId}" — enable it manually in Community plugins`);
        }
        const text = isUpdate ? `⤓ updated to ${version} & enabled` : `⤓ installed & enabled ${version}`;
        return { note: { kind: "ok", text }, messages: fallbackMsgs };
      } catch (e) {
        const verb = isUpdate ? "updated" : "installed";
        return {
          note: { kind: "warn", text: "⚠ enable failed" },
          messages: [`${verb} ${version}, but: ${(e as Error).message}`],
        };
      }
    },
  };
}

// Capture-side policy (spec 2026-07-17): a disabled plugin whose settings flow device→store
// can still be turned on as part of the run. Enabling has no ordering constraint against the
// capture, so it runs after — keeping the report sequence natural.
export interface CaptureItem {
  name: string;
  action: "enable" | "none";
}

export async function captureWithActions(ctx: CoreContext, items: CaptureItem[], onProgress?: ProgressFn): Promise<GroupResult[]> {
  const results = await capture(
    ctx,
    items.map((i) => i.name),
    onProgress
  );
  const manifest = await loadManifest(ctx);
  let done = 0;
  for (const item of items) {
    done++;
    if (item.action !== "enable") continue;
    const group = requireGroup(manifest, item.name);
    onProgress?.(done - 1, items.length, item.name, "enabling…");
    const fin = await enableForGroup(ctx, group);
    const r = results.find((x) => x.group === item.name);
    if (r === undefined) continue;
    if (fin.note !== null) r.stateNote = fin.note;
    if (fin.messages.length > 0) {
      r.messages.push(...fin.messages);
      if (r.status === "ok" && fin.note?.kind === "warn") r.status = "warning";
    }
  }
  return results;
}

export async function applyWithActions(
  ctx: CoreContext,
  items: ApplyItem[],
  installPlugin: PluginInstallFn,
  onProgress?: ProgressFn
): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  const lock = await loadLock(ctx); // carries each group's sourcePluginVersion — the install target
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
    for (const item of items) {
      onProgress?.(done, items.length, item.name);
      // Per-item isolation: one item that throws (unknown group, io failure, a plugin's
      // disable/enable) becomes a single error result — the rest of the batch still runs.
      try {
        const group = requireGroup(manifest, item.name);
        const phase = (p: string): void => onProgress?.(done, items.length, item.name, p);
        const storeExists = await ctx.io.exists(`${storeDir(ctx)}/${groupStorePath(group.path)}`);
        const targetVersion = lock?.groups[group.name]?.sourcePluginVersion ?? null;
        const prelude = await runStateAction(ctx, group, item.action, installPlugin, storeExists, targetVersion, phase);
        if (prelude.skipConfig) {
          const r = emptyResult(item.name, false);
          r.status = "warning";
          if (prelude.note !== null) r.stateNote = prelude.note;
          r.messages.push(...prelude.messages);
          results.push(r);
        } else {
          // Install-only apply: a not-installed plugin with no settings in the store. The
          // install action IS the payload — applyGroup would error on the missing store data.
          // Action-only apply: a plugin with no settings in the store — the state action
          // (install and/or enable) IS the payload; applyGroup would error on the missing data.
          const actionOnly = item.action !== "none" && !storeExists;
          if (!actionOnly) phase("writing settings…");
          const r = actionOnly ? emptyResult(item.name, false) : await applyGroup(ctx, group, state);
          if (prelude.note !== null) r.stateNote = prelude.note;
          if (prelude.messages.length > 0) {
            r.messages.push(...prelude.messages);
            if (r.status === "ok") r.status = "warning";
          }
          if (prelude.finish !== undefined) {
            // Config is on disk — now it's safe to (re)enable: the plugin loads the applied settings.
            phase("enabling…");
            const fin = await prelude.finish();
            if (fin.note !== null) r.stateNote = fin.note;
            if (fin.messages.length > 0) {
              r.messages.push(...fin.messages);
              if (r.status === "ok" && fin.note?.kind === "warn") r.status = "warning";
            }
          }
          // The action-only line must reflect reality — resolved AFTER finish so a failed
          // install/enable never claims success.
          if (actionOnly) {
            const pid = pluginIdForGroup(group);
            const isUpd = item.action === "update" || item.action === "update-enable";
            if (item.action === "enable") {
              if (pid !== null && ctx.plugins.isPluginEnabled(pid)) r.messages.push("no settings in the store — enabled the plugin only");
            } else if (pid !== null && ctx.plugins.getInstalledPluginVersion(pid) !== null && r.stateNote?.kind !== "warn") {
              r.messages.push(isUpd ? "no settings in the store — updated the plugin only" : "no settings in the store — installed the plugin only");
            }
          }
          results.push(r);
        }
      } catch (err) {
        const r = emptyResult(item.name, false);
        r.status = "error";
        r.messages.push(err instanceof Error ? err.message : String(err));
        results.push(r);
      }
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
  // Disabling a plugin while we rewrite its data.json stops it clobbering the applied file,
  // then we re-enable it to load fresh. NEVER do this for config-sync itself: disabling the
  // running plugin mid-apply reloads it and wipes the Sync Center. The self group's data.json
  // is applied in place; the plugin reconciles via loadSettings after the run.
  const cycle = pluginId !== null && pluginId !== "config-sync" && ctx.plugins.isPluginEnabled(pluginId);
  if (cycle) {
    await ctx.plugins.disablePlugin(pluginId);
  }
  try {
    if (group.type === "file") {
      const storeContent = await ctx.io.read(store);
      const localContent = (await ctx.io.exists(real)) ? await ctx.io.read(real) : null;
      const exc = excFor(ctx, group.name);
      const storeSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? parseSwitchList(storeContent) : null;
      let content: string;
      if (storeSwitchList !== null) {
        const localSwitchList = localContent !== null ? parseSwitchList(localContent) : null;
        const merged = applySwitchList(storeSwitchList, localSwitchList, exc);
        content = serializeSwitchList(merged);
        // Name the plugins this write toggles (spec 2026-07-17): a store list lacking a
        // just-enabled plugin turns it off persistently — that must be visible in the report.
        for (const line of switchDeltaMessages(localSwitchList, merged)) result.messages.push(line);
      } else {
        content = await applyTransform(group, storeContent, localContent, ctx.passphrase);
      }
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
    if (cycle) {
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

const LOCK_REL = "store.lock.json";
const LEGACY_MANIFEST_REL = "config-sync.json";
// The self item's real path is always "{configDir}/plugins/config-sync/data.json" (the plugin
// id, from manifest.json, never varies) — so its store rel is this fixed constant.
const SELF_STORE_DATA_REL = `store/${groupStorePath("{configDir}/plugins/config-sync/data.json")}`;

// A legacy root manifest — the deprecated format from before groups moved into plugin
// settings — or a timestamped remnant left behind by migrateLegacyManifest. Neither is ever
// written locally by the current format, so both are excluded from file classification.
function isLegacyManifestRel(rel: string): boolean {
  return rel === LEGACY_MANIFEST_REL || rel.startsWith(`${LEGACY_MANIFEST_REL}.migrated-`);
}

export async function remoteGroupsFrom(reader: ExternalStoreReader, files: string[]): Promise<SyncGroup[]> {
  if (files.includes(SELF_STORE_DATA_REL)) {
    const parsed: unknown = JSON.parse(await reader.readFile(SELF_STORE_DATA_REL));
    if (isPlainObject(parsed) && Array.isArray(parsed.groups)) {
      return validateSyncManifest({ version: 1, groups: parsed.groups }).groups;
    }
  }
  if (files.includes(LEGACY_MANIFEST_REL)) {
    return parseSyncManifest(await reader.readFile(LEGACY_MANIFEST_REL)).groups; // compat, deprecated format
  }
  return [];
}

export interface PendingPull {
  plan: MergePlan;
  remoteGroups: SyncGroup[];
  remoteLockRaw: string | null;
}

// Phase 1: read-only. Never writes anything.
export async function planImport(ctx: CoreContext, reader: ExternalStoreReader): Promise<PendingPull> {
  const files = await reader.listFiles();
  const remoteGroups = await remoteGroupsFrom(reader, files);
  const remoteLockRaw = files.includes(LOCK_REL) ? await reader.readFile(LOCK_REL) : null;

  const remoteFileMap = new Map<string, string>();
  for (const rel of files) {
    if (rel === LOCK_REL || isLegacyManifestRel(rel)) continue;
    remoteFileMap.set(rel, await reader.readFile(rel));
  }

  const localGroups = await readGroups(ctx);
  const localFileMap = new Map<string, string>();
  if (await ctx.io.exists(ctx.rootPath)) {
    const localAbs = await listFilesRecursive(ctx.io, ctx.rootPath);
    for (const f of localAbs) {
      const rel = relativeTo(ctx.rootPath, f);
      if (rel === LOCK_REL || isLegacyManifestRel(rel)) continue;
      localFileMap.set(rel, await ctx.io.read(f));
    }
  }

  const plan = classifyMerge(localGroups, localFileMap, remoteGroups, remoteFileMap);
  return { plan, remoteGroups, remoteLockRaw };
}

// Phase 2: writes the whole merge result — all auto-merged parts plus each conflict's chosen
// side — in one pass. Never deletes local-only files or groups.
export async function applyImport(
  ctx: CoreContext,
  pending: PendingPull,
  choices: ("local" | "remote")[]
): Promise<GroupResult[]> {
  const { plan, remoteGroups, remoteLockRaw } = pending;
  if (choices.length !== plan.conflicts.length) {
    throw new Error(
      `applyImport: expected ${plan.conflicts.length} conflict resolution choice(s), received ${choices.length}`
    );
  }

  const byName = new Map<string, GroupResult>();
  const resultFor = (name: string): GroupResult => {
    let r = byName.get(name);
    if (r === undefined) {
      r = emptyResult(name, false);
      byName.set(name, r);
    }
    return r;
  };

  const remoteWonNames = new Set<string>(plan.auto.writeFiles.map((f) => f.name).filter((n) => n !== ""));

  for (const f of plan.auto.writeFiles) {
    await writeClassified(ctx, `${ctx.rootPath}/${f.rel}`, f.content, f.rel, resultFor(f.name));
  }
  for (let i = 0; i < plan.conflicts.length; i++) {
    const conflict = plan.conflicts[i];
    if (conflict === undefined) continue;
    if (choices[i] !== "remote") continue;
    if (conflict.kind !== "file") continue;
    await writeClassified(ctx, `${ctx.rootPath}/${conflict.rel}`, conflict.remoteContent, conflict.rel, resultFor(conflict.name));
    remoteWonNames.add(conflict.name);
  }
  await pruneEmptyDirsUnder(ctx.io, ctx.rootPath);

  let groups = await readGroups(ctx);
  groups = [...groups, ...plan.auto.addGroups];
  for (let i = 0; i < plan.conflicts.length; i++) {
    const conflict = plan.conflicts[i];
    if (conflict === undefined) continue;
    if (choices[i] !== "remote") continue;
    if (conflict.kind !== "definition") continue;
    groups = groups.map((g) => (g.name === conflict.name ? conflict.remote : g));
    remoteWonNames.add(conflict.name);
  }
  groups = ensureSelfPresets(groups);
  await writeGroups(ctx, groups);
  for (const g of plan.auto.addGroups) resultFor(g.name);

  const localLock = await loadLock(ctx);
  const remoteLock = remoteLockRaw !== null ? parseStoreLock(remoteLockRaw) : null;
  if (localLock !== null || remoteLock !== null) {
    const mergedGroups: StoreLock["groups"] = { ...(localLock?.groups ?? {}) };
    // Content-identical groups follow the remote's capture lineage too: a version-refresh
    // capture on the other device updates ONLY the lock, and that update must survive the
    // pull or the Outdated flow never fires here (确认 2026-07-16; B-newer edge in spec).
    for (const id of plan.auto.identical) {
      if (id.startsWith("group:")) remoteWonNames.add(id.slice("group:".length));
      if (id.startsWith("file:")) {
        const { name } = groupForStoreRel(groups, id.slice("file:".length));
        if (name !== "") remoteWonNames.add(name);
      }
    }
    for (const name of remoteWonNames) {
      const entry = remoteLock?.groups[name];
      if (entry !== undefined) mergedGroups[name] = entry;
    }
    const merged: StoreLock = { capturedAt: remoteLock?.capturedAt ?? localLock?.capturedAt ?? ctx.now(), groups: mergedGroups };
    await ctx.io.write(lockPath(ctx), JSON.stringify(merged, null, 2) + "\n");
  }

  const isAffected = (r: GroupResult): boolean => hasChanges(r.changes);
  const orderedNames = [...remoteGroups.map((g) => g.name), ...groups.map((g) => g.name)];
  const seen = new Set<string>();
  const named: GroupResult[] = [];
  for (const name of orderedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const r = byName.get(name);
    if (r !== undefined && isAffected(r)) named.push(r);
  }
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
  const localAbs = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const rels = localAbs.map((f) => f.slice(ctx.rootPath.length + 1)).sort();
  const hasStore = rels.some((r) => r.startsWith("store/")) || rels.includes(LOCK_REL);
  if (!hasStore) {
    throw new Error(
      `Local store has no captured data at ${ctx.rootPath} — capture from this device (or pull) before pushing.`
    );
  }
  const pushableRels = rels.filter((r) => !isLegacyManifestRel(r));
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
  const remoteFiles = new Set((await writer.listFiles()).filter((r) => !isLegacyManifestRel(r)));
  for (const rel of pushableRels) {
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    const content = await ctx.io.read(`${ctx.rootPath}/${rel}`);
    const existed = remoteFiles.has(rel);
    if (existed && (await writer.readFile(rel)) === content) continue; // unchanged: skip the write
    await writer.writeFile(rel, content);
    const result = resultFor(name);
    result.filesWritten.push(rel);
    (existed ? result.changes.updated : result.changes.added).push(itemRel);
  }
  const wanted = new Set(pushableRels);
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

export async function readGroups(ctx: CoreContext): Promise<SyncGroup[]> {
  return ctx.groupsIO.read();
}

export async function writeGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<void> {
  const manifest = validateSyncManifest({ version: 1, groups });
  await ctx.groupsIO.write(manifest.groups);
}
