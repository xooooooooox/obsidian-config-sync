import { FileIO, ensureParentDir, isJunkPath, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { FieldRule, GroupResult, hasChanges, StoreLock, SyncGroup, SyncManifest } from "./types";
import { basename, groupStorePath, relativeTo, resolveGroupByStoreRel, sidecarStoreSuffix } from "./pathing";
import { parseStoreLock, parseSyncManifest, validateSyncManifest } from "./manifest";
import { applyTransform, captureTransform, classPatterns, contentUnchanged, stripPatterns } from "./modes";
import { classifyMerge, MergeConflict, MergePlan } from "./merge";
import { SELF_GROUP_NAME } from "./catalog";
import { isPlainObject, keyMatchesAny } from "./sanitize";
import { readPerItemArray, scopeOf } from "./perItem";
import { applySwitchList, captureSwitchList, localRealPath, parseSwitchList, readLocalSwitchList, subtractForceOff, SWITCH_LIST_GROUPS, SwitchList, switchListsEqual, writeLocalSwitchList } from "./switchList";

// `current` is the group NAME (the UI maps it to a display label); `phase` is a short live
// phrase for the in-item step ("downloading via BRAT…", "writing settings…") — spec 2026-07-17.
export type ProgressFn = (done: number, total: number, current: string, phase?: string) => void;

export interface PluginHost {
  getInstalledPluginVersion(id: string): string | null;
  isDesktopOnly(id: string): boolean; // the plugin's manifest.isDesktopOnly — can it run on mobile
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
  deviceClass: "desktop" | "mobile";
  groupsIO: GroupsIO;
  switchExceptions: Record<string, string[]>; // group name -> masked member ids (This-device ∪ scoped-away ∪ auto-derived)
  switchForceOff?: Record<string, string[]>; // group name -> ids forced off on apply (user class scope on the wrong device class)
  fieldOverlay?: (group: SyncGroup, topKeys: string[]) => FieldRule[] | null; // runtime category rules (e.g. app.json view rows)
  // Compiles a self store copy's sync list. Schema v2 copies persist items+customGroups (no
  // compiled groups array), and only the plugin holds the registry defs needed to compile them
  // (leftover.ts's storeSelfCopyGroups) — absent in bare test contexts, where v2 copies yield [].
  storeListGroups?: (selfCopyJson: string) => SyncGroup[];
  now(): string; // ISO-8601 timestamp, injectable for tests
}

// Composes runtime category rules (app.json view rows) into a group's effective field set.
// jsons: any texts whose top-level keys should participate (local content, store base, sidecar).
export function overlayGroup(ctx: CoreContext, group: SyncGroup, jsons: (string | null)[]): SyncGroup {
  if (ctx.fieldOverlay === undefined) return group;
  // Whole-file encryption (FileRule) owns this group's mode; a runtime field overlay must never
  // rewrite it to "fields" and silently bypass the file-encryption branch (Task 2 fix round 1).
  if (group.fileRule !== undefined) return group;
  const keys = new Set<string>();
  for (const j of jsons) {
    if (j === null) continue;
    try {
      const p = JSON.parse(j) as unknown;
      if (isPlainObject(p)) for (const k of Object.keys(p)) keys.add(k);
    } catch { /* non-JSON content participates with no keys */ }
  }
  const extra = ctx.fieldOverlay(group, [...keys]);
  if (extra === null || extra.length === 0) return group;
  return { ...group, mode: "fields", fields: [...(group.fields ?? []), ...extra] };
}

// Store-contract-authoritative `local` strip (Fix B): a group's `local`-scoped fields must be
// stripped using the STORE CONTRACT's rule for that group name, which OVERRIDES any existing
// same-pattern local rule — otherwise a device whose own copy of the group has an explicit
// non-local rule for that pattern (e.g. `scope: "all"`) would publish its own device-local
// values into the store, which then flow downstream. Every contract-local pattern is therefore
// forced to `scope: "local"` whether or not the group already has a rule for it, promoting a
// plain-mode group to "fields" so the strip actually applies. Mirrors overlayGroup's own guard:
// a FileRule-encrypted group owns whole-file encryption and is never rewritten to "fields" here
// either.
export function withContractLocals(group: SyncGroup, contractLocalPatterns: string[]): SyncGroup {
  if (contractLocalPatterns.length === 0) return group;
  if (group.fileRule !== undefined) return group;
  const contractSet = new Set(contractLocalPatterns);
  const existing = group.fields ?? [];
  const existingPatterns = new Set(existing.map((f) => f.pattern));
  const rewritten = existing.map((f) => (contractSet.has(f.pattern) ? { ...f, scope: "local" as const } : f));
  const added: FieldRule[] = contractLocalPatterns
    .filter((p) => !existingPatterns.has(p))
    .map((p) => ({ pattern: p, scope: "local", encrypted: false }));
  return { ...group, mode: "fields", fields: [...rewritten, ...added] };
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

// Legacy location only: 1.x wrote a one-slot apply backup here for "Revert last apply"
// (feature removed in round-7 spec §3). Nothing writes it anymore — removeLegacyBackup deletes
// a leftover copy on the next apply.
export function backupDir(ctx: CoreContext): string {
  return `${ctx.configDir}/config-sync-backup`;
}

async function removeLegacyBackup(ctx: CoreContext): Promise<void> {
  if (await ctx.io.exists(backupDir(ctx))) {
    await ctx.io.rmdir(backupDir(ctx), true);
  }
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

// Plugin ids whose group is scoped to a device class that excludes `device`
// (devices:"desktop" on a mobile device, devices:"mobile" on desktop). On a device they are
// scoped away from, they must never be captured out of — or forced into — the shared
// enabled-plugins switch list; they simply do not belong to this device.
export function deviceExcludedPluginIds(groups: SyncGroup[], device: "desktop" | "mobile"): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    if (g.devices === "all" || g.devices === device) continue;
    const id = pluginIdForGroup(g);
    if (id !== null) ids.add(id);
  }
  return ids;
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

// On capture, every group's lock entry is rewritten (selected → fresh, others → carried forward).
// For carried-forward entries of installed plugins, refresh desktopOnly to match the live manifest
// so the flag lands for the whole plugin set, not just the groups captured this run.
function refreshLockDesktopOnly(
  entry: StoreLock["groups"][string],
  group: SyncGroup,
  plugins: PluginHost
): StoreLock["groups"][string] {
  const pluginId = pluginIdForGroup(group);
  if (pluginId === null || plugins.getInstalledPluginVersion(pluginId) === null) return entry;
  const { desktopOnly, ...rest } = entry;
  return plugins.isDesktopOnly(pluginId) ? { ...rest, desktopOnly: true } : rest;
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

// Base-hygiene guard (spec 2026-07-25-domain-mirror-design.md §2.2): contentUnchanged
// deliberately ignores class-scoped top-level keys on both sides (correct for diff/status —
// it prevents phantom to-capture entries), so a store base written before a class rule existed
// can still carry those keys after contentUnchanged reports equal. The base must never keep
// class-scoped keys, so this forces the rewrite that purges them. Guarded to a no-op when the
// group has no class patterns, or when the existing content isn't parseable JSON object — in
// both cases there is nothing to purge and the unchanged verdict stands.
function baseHasStaleClassKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = [...classPatterns(effGroup, "desktop"), ...classPatterns(effGroup, "mobile")];
  if (patterns.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return Object.keys(parsed).some((k) => keyMatchesAny(k, patterns));
}

// Base-hygiene guard for stale local-scoped per-item elements (smoke-test fix, third extension of
// the mechanism above): perItemArrayUnchanged deliberately ignores "local"-scoped elements
// symmetrically on both sides (correct for diff/status — re-scoping an element to "local"
// shouldn't read as a pending change), so a store base written before the re-scope (or before the
// key had any perItem scopes at all) can still carry that element after contentUnchanged reports
// equal. Forces the rewrite that purges it. Elements scoped to the OTHER device class are
// legitimately present in the base (store holds the union of non-local elements across devices)
// and must NOT be treated as stale — only "local"-scoped elements are. No-op when the group has no
// perItem keys, or the existing content isn't a parseable JSON object.
function baseHasStalePerItemElements(effGroup: SyncGroup, existing: string): boolean {
  if (effGroup.perItem === undefined || Object.keys(effGroup.perItem).length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return Object.entries(effGroup.perItem).some(([key, scopes]) => {
    const arr = readPerItemArray(parsed, effGroup.name, key, "compare");
    return arr.some((el) => scopeOf(scopes, el) === "local");
  });
}

// Base-hygiene guard for stale top-level local-scoped keys (third family, 2026-08-04): like the
// two guards above, contentUnchanged deliberately ignores top-level scope:"local" keys on both
// sides (Fix B's withContractLocals — correct for diff/status, prevents a phantom to-capture on a
// re-scoped field), so a base written before the field became local can still carry that key after
// contentUnchanged reports equal. The store must never hold a device-local value, so this forces
// the rewrite that captureTransform's strip has already removed the key from. A per-item key is
// never a scope:"local" field (it lives in group.perItem, not group.fields), so stripPatterns
// never overlaps the per-item guard's responsibility. No-op when the group has no local patterns,
// or the existing content isn't a parseable JSON object.
export function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = stripPatterns(effGroup);
  if (patterns.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return Object.keys(parsed).some((k) => keyMatchesAny(k, patterns));
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
  // Computed ONCE for the whole run (never per group) — the store contract's `local` field
  // patterns, unioned into each group before it reaches captureGroup (Fix B, see
  // withContractLocals/readStoreContractLocals above).
  const contractLocals = await readStoreContractLocals(ctx);
  let done = 0;
  for (const group of manifest.groups) {
    if (selected !== null && !selected.has(group.name)) {
      const prev = previous?.groups[group.name];
      if (prev !== undefined) lock.groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // not captured this run — carry forward
      continue;
    }
    onProgress?.(done, toProcess.length, group.name);
    const result = await captureGroup(ctx, withContractLocals(group, contractLocals.get(group.name) ?? []));
    done++;
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      if (result.status !== "error") {
        const version = ctx.plugins.getInstalledPluginVersion(pluginId);
        if (version !== null) {
          lock.groups[group.name] = ctx.plugins.isDesktopOnly(pluginId)
            ? { sourcePluginVersion: version, desktopOnly: true }
            : { sourcePluginVersion: version };
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
        if (prev !== undefined) lock.groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // errored capture keeps the last known version
      }
    } else if (result.status !== "error") {
      lock.groups[group.name] = { sourceAppVersion: ctx.plugins.getAppVersion() };
    }
    results.push(result);
  }
  // The store legitimately holds content outside this vault's registry (additive pulls never
  // delete, and no local flow prunes another contract's files). Its lock entries describe that
  // content — dropping them here would resurrect the remote "newer version info" hint after
  // every capture. Registry names always win: their entries were just written or deliberately
  // dropped (e.g. plugin uninstalled) by the loop above.
  const registryNames = new Set(manifest.groups.map((g) => g.name));
  for (const [name, entry] of Object.entries(previous?.groups ?? {})) {
    if (!registryNames.has(name)) lock.groups[name] = entry;
  }
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}

async function captureGroup(ctx: CoreContext, group: SyncGroup): Promise<GroupResult> {
  const real = localRealPath(group.name, group.path, ctx.configDir);
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
    const localSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? readLocalSwitchList(group.name, plainLocalContent) : null;
    // Pass-through (甲): excluded ids copy the store's existing state, so read it first.
    let existingStoreList: SwitchList | null = null;
    if (localSwitchList !== null && (await ctx.io.exists(store))) {
      existingStoreList = parseSwitchList(await ctx.io.read(store));
    }
    const captureInput = localSwitchList !== null ? serializeSwitchList(captureSwitchList(localSwitchList, existingStoreList, exc)) : plainLocalContent;
    const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
    const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
    const effGroup = overlayGroup(ctx, group, [plainLocalContent]);
    // Prior store content for perItem keys (spec §3, D3): capturing a per-item array must
    // preserve the other device's already-captured elements, which requires the OLD store copy —
    // never needed for non-perItem groups, but harmless to read either way (see captureTransform's
    // storeContent doc comment; a switch-list group's real store read already happened above).
    const priorStoreContent = localSwitchList === null && (await ctx.io.exists(store)) ? await ctx.io.read(store) : null;
    const t = await captureTransform(effGroup, captureInput, ctx.passphrase, ctx.deviceClass, priorStoreContent);
    if (t.note !== null) result.messages.push(t.note);
    await writeClassified(ctx, store, t.content, basename(store), result, async (existing) => {
      if (localSwitchList !== null) {
        const existingSwitchList = parseSwitchList(existing);
        if (existingSwitchList !== null) return switchListsEqual(localSwitchList, existingSwitchList, exc);
      }
      const unchanged = await contentUnchanged(effGroup, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, existingSidecar);
      if (!unchanged) return false;
      // force the rewrite that purges stale class keys, stale local-scoped per-item elements, or stale top-level local keys
      return !baseHasStaleClassKeys(effGroup, existing) && !baseHasStalePerItemElements(effGroup, existing) && !baseHasStaleLocalKeys(effGroup, existing);
    });
    if (!SWITCH_LIST_GROUPS.has(group.name)) {
      if (t.ownScope !== null) {
        await writeClassified(ctx, sidecarPath, t.ownScope, basename(sidecarPath), result);
      } else if (await ctx.io.exists(sidecarPath)) {
        await ctx.io.remove(sidecarPath);
        result.filesDeleted.push(sidecarPath);
        result.changes.deleted.push(basename(sidecarPath));
      }
    }
    return result;
  }
  const sourceFiles = await listFilesRecursive(ctx.io, real);
  const sourceRels = sourceFiles.map((f) => relativeTo(real, f)).filter((rel) => !isJunkPath(rel));
  for (const rel of sourceRels) {
    const target = `${store}/${rel}`;
    const plainLocalContent = await ctx.io.read(`${real}/${rel}`);
    if (group.mode === "encrypted") {
      const t = await captureTransform(group, plainLocalContent, ctx.passphrase, ctx.deviceClass);
      await writeClassified(ctx, target, t.content, rel, result, (existing) =>
        contentUnchanged(group, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, null)
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

export async function apply(ctx: CoreContext, groupNames: string[], onProgress?: ProgressFn): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  await removeLegacyBackup(ctx);
  const results: GroupResult[] = [];
  let done = 0;
  for (const name of groupNames) {
    onProgress?.(done, groupNames.length, name);
    results.push(await applyGroup(ctx, requireGroup(manifest, name)));
    done++;
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
  await removeLegacyBackup(ctx);
  const results: GroupResult[] = [];
  let done = 0;
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
        const r = actionOnly ? emptyResult(item.name, false) : await applyGroup(ctx, group);
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
  return results;
}

async function applyGroup(ctx: CoreContext, group: SyncGroup): Promise<GroupResult> {
  const real = localRealPath(group.name, group.path, ctx.configDir);
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
        const localSwitchList = localContent !== null ? readLocalSwitchList(group.name, localContent) : null;
        const merged = applySwitchList(storeSwitchList, localSwitchList, exc);
        const finalList = subtractForceOff(merged, ctx.switchForceOff?.[group.name] ?? []);
        content = writeLocalSwitchList(group.name, finalList, localContent);
        // Name the plugins this write toggles (spec 2026-07-17): a store list lacking a
        // just-enabled plugin turns it off persistently — that must be visible in the report.
        for (const line of switchDeltaMessages(localSwitchList, finalList)) result.messages.push(line);
      } else {
        const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
        const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
        const effGroup = overlayGroup(ctx, group, [storeContent, localContent, existingSidecar]);
        content = await applyTransform(effGroup, storeContent, localContent, ctx.passphrase, ctx.deviceClass, existingSidecar);
      }
      await writeClassified(ctx, real, content, basename(real), result);
    } else {
      const storeFiles = await listFilesRecursive(ctx.io, store);
      const rels = storeFiles.map((f) => relativeTo(store, f));
      for (const rel of rels) {
        const target = `${real}/${rel}`;
        const storeContent = await ctx.io.read(`${store}/${rel}`);
        const content =
          group.mode === "encrypted"
            ? await applyTransform(group, storeContent, null, ctx.passphrase, ctx.deviceClass, null)
            : storeContent;
        await writeClassified(ctx, target, content, rel, result);
      }
      if (await ctx.io.exists(real)) {
        const realFiles = await listFilesRecursive(ctx.io, real);
        const wanted = new Set(rels);
        for (const f of realFiles) {
          if (!wanted.has(relativeTo(real, f))) {
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

export interface ExternalStoreReader {
  listFiles(): Promise<string[]>; // relative to the source <root>/, "/"-separated
  readFile(relPath: string): Promise<string>;
}

const LOCK_REL = "store.lock.json";
const LEGACY_MANIFEST_REL = "config-sync.json";
// The self item's real path is always "{configDir}/plugins/config-sync/data.json" (the plugin
// id, from manifest.json, never varies) — so its store rel is this fixed constant.
const SELF_STORE_DATA_REL = `store/${groupStorePath("{configDir}/plugins/config-sync/data.json")}`;

// Every store rel belonging to the self item: its data file plus the two device-class sidecars.
// The excludeSelf remote option uses this to keep the self item out of pull/push/diff entirely.
export function isSelfStoreRel(rel: string): boolean {
  return (
    rel === SELF_STORE_DATA_REL ||
    rel === SELF_STORE_DATA_REL + sidecarStoreSuffix("desktop") ||
    rel === SELF_STORE_DATA_REL + sidecarStoreSuffix("mobile")
  );
}

// A legacy root manifest — the deprecated format from before groups moved into plugin
// settings — or a timestamped remnant left behind by migrateLegacyManifest. Neither is ever
// written locally by the current format, so both are excluded from file classification.
function isLegacyManifestRel(rel: string): boolean {
  return rel === LEGACY_MANIFEST_REL || rel.startsWith(`${LEGACY_MANIFEST_REL}.migrated-`);
}

export async function remoteGroupsFrom(ctx: CoreContext, reader: ExternalStoreReader, files: string[]): Promise<SyncGroup[]> {
  if (files.includes(SELF_STORE_DATA_REL)) {
    const raw = await reader.readFile(SELF_STORE_DATA_REL);
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && Array.isArray(parsed.groups)) {
      return validateSyncManifest({ version: 1, groups: parsed.groups }).groups;
    }
    if (ctx.storeListGroups !== undefined) return ctx.storeListGroups(raw); // schema v2: items + customGroups
  }
  if (files.includes(LEGACY_MANIFEST_REL)) {
    return parseSyncManifest(await reader.readFile(LEGACY_MANIFEST_REL)).groups; // compat, deprecated format
  }
  return [];
}

// Reads the LOCAL store's own self copy (this device's last-pulled/pushed contract, not a
// remote) and returns, per group name, its `local`-scoped field patterns — the union input for
// withContractLocals. Mirrors remoteGroupsFrom's schema-v2 compile path above, but reads via
// ctx.io instead of an ExternalStoreReader. Empty map when there is no self store copy yet, or
// no ctx.storeListGroups hook (bare test contexts) — both preserve today's behavior exactly.
export async function readStoreContractLocals(ctx: CoreContext): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const path = `${ctx.rootPath}/${SELF_STORE_DATA_REL}`;
  if (!(await ctx.io.exists(path)) || ctx.storeListGroups === undefined) return map;
  // A corrupt/unreadable store copy must never block capture or status — mirrors loadLock's own
  // try/catch degrade-to-empty stance (capture wraps loadLock the same way, above).
  try {
    const groups = ctx.storeListGroups(await ctx.io.read(path));
    for (const g of groups) {
      map.set(g.name, (g.fields ?? []).filter((f) => f.scope === "local").map((f) => f.pattern));
    }
  } catch {
    return new Map();
  }
  return map;
}

export interface PendingPull {
  plan: MergePlan;
  remoteGroups: SyncGroup[];
  remoteLockRaw: string | null;
  excludeSelf: boolean;
}

// Phase 1: read-only. Never writes anything.
export async function planImport(ctx: CoreContext, reader: ExternalStoreReader, opts: { excludeSelf: boolean }): Promise<PendingPull> {
  const files = await reader.listFiles();
  const remoteGroups = await remoteGroupsFrom(ctx, reader, files);
  const remoteLockRaw = files.includes(LOCK_REL) ? await reader.readFile(LOCK_REL) : null;

  const remoteFileMap = new Map<string, string>();
  for (const rel of files) {
    if (rel === LOCK_REL || isLegacyManifestRel(rel) || (opts.excludeSelf && isSelfStoreRel(rel))) continue;
    remoteFileMap.set(rel, await reader.readFile(rel));
  }

  const localGroups = await readGroups(ctx);
  const localFileMap = new Map<string, string>();
  if (await ctx.io.exists(ctx.rootPath)) {
    const localAbs = await listFilesRecursive(ctx.io, ctx.rootPath);
    for (const f of localAbs) {
      const rel = relativeTo(ctx.rootPath, f);
      if (rel === LOCK_REL || isLegacyManifestRel(rel) || (opts.excludeSelf && isSelfStoreRel(rel))) continue;
      localFileMap.set(rel, await ctx.io.read(f));
    }
  }

  const plan = classifyMerge(localGroups, localFileMap, remoteGroups, remoteFileMap);
  return { plan, remoteGroups, remoteLockRaw, excludeSelf: opts.excludeSelf };
}

// Phase 2: writes the whole merge result — all auto-merged parts plus each conflict's chosen
// side — in one pass. Never deletes local-only files or groups.
export async function applyImport(
  ctx: CoreContext,
  pending: PendingPull,
  choices: ("local" | "remote")[]
): Promise<GroupResult[]> {
  const { plan, remoteGroups, remoteLockRaw } = pending;
  // Pull is pure store transport: it resolves file conflicts only. Definition (sync-list)
  // conflicts and remote-only group additions are no longer applied by Pull — the local sync
  // list converges through adopting the config-sync self item, not through a pull side-write.
  const fileConflicts = plan.conflicts.filter((c): c is Extract<MergeConflict, { kind: "file" }> => c.kind === "file");
  if (choices.length !== fileConflicts.length) {
    throw new Error(
      `applyImport: expected ${fileConflicts.length} file-conflict resolution choice(s), received ${choices.length}`
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

  for (const f of plan.auto.writeFiles) {
    await writeClassified(ctx, `${ctx.rootPath}/${f.rel}`, f.content, f.rel, resultFor(f.name));
  }
  for (let i = 0; i < fileConflicts.length; i++) {
    const conflict = fileConflicts[i];
    if (conflict === undefined || choices[i] !== "remote") continue;
    await writeClassified(ctx, `${ctx.rootPath}/${conflict.rel}`, conflict.remoteContent, conflict.rel, resultFor(conflict.name));
  }
  await pruneEmptyDirsUnder(ctx.io, ctx.rootPath);

  // Local groups only — read for lock attribution and result ordering below; Pull never writes
  // the sync list (the compiled item registry — schema v2, spec §6). Remote-only additions land
  // in the store here and become adoptable via the config-sync pane.
  const groups = await readGroups(ctx);

  const localLock = await loadLock(ctx);
  const remoteLock = remoteLockRaw !== null ? parseStoreLock(remoteLockRaw) : null;
  if (localLock !== null || remoteLock !== null) {
    const mergedGroups: StoreLock["groups"] = { ...(localLock?.groups ?? {}) };
    // Converge remoteLockAhead by construction: after a pull the local lock must carry every
    // remote lock entry the hint checks — except the self group when this remote excludes it,
    // and except a group whose file conflict the user kept as "local" (a real divergence that
    // belongs to the local lineage). Copying an entry with no comparable store file is correct:
    // a pull is additive, that content stays in the store, and its lock entry describes it.
    const localWonNames = new Set<string>();
    for (let i = 0; i < fileConflicts.length; i++) {
      if (choices[i] === "local") {
        const c = fileConflicts[i];
        if (c !== undefined) localWonNames.add(c.name);
      }
    }
    if (remoteLock !== null) {
      for (const [name, entry] of Object.entries(remoteLock.groups)) {
        if (pending.excludeSelf && name === SELF_GROUP_NAME) continue;
        if (localWonNames.has(name)) continue;
        mergedGroups[name] = entry;
      }
    }
    const merged: StoreLock = {
      capturedAt: remoteLock?.capturedAt ?? localLock?.capturedAt ?? ctx.now(),
      groups: mergedGroups,
    };
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

export async function pushExternal(ctx: CoreContext, writer: ExternalStoreWriter, opts: { excludeSelf: boolean }): Promise<GroupResult[]> {
  const localAbs = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const rels = localAbs.map((f) => f.slice(ctx.rootPath.length + 1)).sort();
  const hasStore = rels.some((r) => r.startsWith("store/")) || rels.includes(LOCK_REL);
  if (!hasStore) {
    throw new Error(
      `Local store has no captured data at ${ctx.rootPath} — capture from this device (or pull) before pushing.`
    );
  }
  const pushableRels = rels.filter((r) => !isLegacyManifestRel(r) && !(opts.excludeSelf && isSelfStoreRel(r)));
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
    if (opts.excludeSelf && isSelfStoreRel(rel)) continue; // the remote's own contract is not ours to delete
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
