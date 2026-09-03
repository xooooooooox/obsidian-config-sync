import { FileIO, ensureParentDir, isJunkPath, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { FieldRule, GroupResult, hasChanges, ItemRef, LockItems, StoreLock, StoreLockEntry, SyncGroup, SyncManifest, THIS_DEVICE } from "./types";
import { basename, groupStorePath, relativeTo, resolveGroupByStoreRel, sidecarStoreSuffix } from "./pathing";
import { carrierRef, refItemId } from "./itemKeys";
import { assertStoreLockVersionUnderstood, derivedLockCapturedAt, itemEntry, lockElementLabels, lockEntry, lockEntryList, lockEntryTail, lockLabel, lockLineage, lockSourceVersion, lockTail, lockWatermark, parseStoreLock, parseSyncManifest, setLockEntry, storeLockVersion, STORE_LOCK_HASH_PREFIX, STORE_LOCK_VERSION, validateSyncManifest } from "./manifest";
import { derivedPushLock } from "./derivedLock";
import { itemFreshness } from "./lockFreshness";
import { overlayWithheld } from "./keyWithholding";
import { isFutureSchemaDocument, SCHEMA_FUTURE_APPLY_MESSAGE } from "./settingsMigration";
import { applyTransform, captureTransform, classPatterns, contentUnchanged, excludingPerElement, groupHasCiphertext, stripPatterns } from "./modes";
import { hashDirSide, hashFileSide, sha256Hex } from "./ledger";
import { classifyMerge, MergeConflict, MergePlan } from "./merge";
import { SELF_GROUP_NAME, SELF_ITEM_ID, SELF_ITEM_REF } from "./catalog";
import { isPlainObject, keyMatchesAny } from "./sanitize";
import { readPerElementArray, sharingOf } from "./perElement";
import { addForceOn, applySwitchList, captureSwitchList, localRealPath, memberUniverse, parseSwitchList, readLocalSwitchList, subtractForceOff, isSwitchListGroup, SwitchList, switchListsEqual, writeLocalSwitchList } from "./switchList";

// `current` is the group NAME (the UI maps it to a display label); `phase` is a short live
// phrase for the in-item step ("downloading via BRAT…", "writing settings…").
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
  disableCorePlugin(id: string): Promise<void>;
  reloadPluginManifests(): Promise<void>;
  // Re-reads app.json/appearance.json into memory and re-applies the appearance family (theme,
  // snippets, accent/font) to the running app — the deterministic replacement for "reload the app".
  reloadAppearance(): Promise<void>;
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
  switchExceptions: Record<string, string[]>; // group name -> masked member ids (decideEnablement's `masked` ∪ auto-derived)
  // group name -> rule patterns THIS device has excepted (deviceFields.ts). Same shape and same
  // reason as switchExceptions above: a device-local fact the pure core must be TOLD, never read.
  // Optional — a bare test context has none.
  fieldExceptions?: Record<string, string[]>;
  switchForceOff?: Record<string, string[]>; // group name -> ids forced off on apply (a class rule on the wrong device class, or this device's own "Always off" exception)
  switchForceOn?: Record<string, string[]>; // group name -> ids forced on on apply (this device's own "Always on" exception; see enablementDecision.ts)
  fieldOverlay?: (group: SyncGroup, topKeys: string[]) => FieldRule[] | null; // runtime category rules (e.g. app.json view rows)
  // Compiles a self store copy's sync list. v3 copies persist `items` (custom section included; no
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
// either — and neither is a mode:"encrypted" group, which owns whole-file encryption the same
// way FileRule does and must never be demoted to plaintext fields mode.
export function withContractLocals(group: SyncGroup, contractLocalPatterns: string[]): SyncGroup {
  if (contractLocalPatterns.length === 0) return group;
  if (group.fileRule !== undefined || group.mode === "encrypted") return group;
  const contractSet = new Set(contractLocalPatterns);
  const existing = group.fields ?? [];
  const existingPatterns = new Set(existing.map((f) => f.pattern));
  const rewritten = existing.map((f) => (contractSet.has(f.pattern) ? { ...f, sharing: THIS_DEVICE } : f));
  const added: FieldRule[] = contractLocalPatterns
    .filter((p) => !existingPatterns.has(p))
    .map((p) => ({ pattern: p, sharing: THIS_DEVICE, encrypted: false }));
  return { ...group, mode: "fields", fields: [...rewritten, ...added] };
}

export function lockPath(ctx: CoreContext): string {
  return `${ctx.rootPath}/store.lock.json`;
}

export function storeDir(ctx: CoreContext): string {
  return `${ctx.rootPath}/store`;
}

// A legacy path: nothing writes it. removeLegacyBackup deletes a leftover copy on the next apply,
// which is the only reason this name still needs to resolve.
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

// The compiled sync list is passed to parseStoreLock so a v1/v2 lock is re-keyed against what this
// device actually compiles instead of against the closed legacy rules alone.
export async function loadLock(ctx: CoreContext): Promise<StoreLock | null> {
  const p = lockPath(ctx);
  if (!(await ctx.io.exists(p))) return null;
  return parseStoreLock(await ctx.io.read(p), await ctx.groupsIO.read());
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
  if (g.type !== "file") return { name: g.name, itemRel: inner.slice(sp.length + 1) };
  // A per-device sidecar shares its group's main file name — label it apart, or the remote
  // pane and pull reports show two identical "app.json" rows with no way to tell which one
  // carries the device-scoped values.
  const m = inner.slice(sp.length).match(/^\.__scopes__\.(desktop|mobile)\.json$/);
  const label = basename(sp);
  return { name: g.name, itemRel: m === null ? label : `${label} · ${m[1]} values` };
}

function excFor(ctx: CoreContext, name: string): string[] {
  return isSwitchListGroup(name) ? (ctx.switchExceptions[name] ?? []) : [];
}

export function fieldExceptionsFor(ctx: CoreContext, group: SyncGroup): string[] {
  return ctx.fieldExceptions?.[group.name] ?? [];
}

// Run-scoped exceptions for a partial-selection apply/capture (Sync Center unified grammar,
// task 3): unstaged members join the configured exceptions for this run only —
// excFor(ctx, name) ∪ (memberUniverse(store, local) − stagedMembers). `stagedMembers` undefined
// means "no selection made" — today's whole-list behavior, byte-for-byte.
function runExceptions(ctx: CoreContext, name: string, store: SwitchList | null, local: SwitchList | null, stagedMembers?: string[]): string[] {
  const base = excFor(ctx, name);
  if (stagedMembers === undefined) return base;
  const staged = new Set(stagedMembers);
  const unstaged = memberUniverse(store, local).filter((id) => !staged.has(id));
  return [...new Set([...base, ...unstaged])];
}

// Restricts a force-on/off mask (the always-here/never-here table) to the run's staged
// members: unrestricted when `stagedMembers` is undefined (the whole-run mask behavior),
// otherwise only ids also named in `stagedMembers` — an unstaged member's switch
// must never move, including via a force mask (`stagedMembers:
// []` must mean zero switch flips even when a force-on/off mask is active for the group).
function scopedMask(mask: string[], stagedMembers?: string[]): string[] {
  return stagedMembers === undefined ? mask : mask.filter((id) => stagedMembers.includes(id));
}

function serializeSwitchList(v: ReturnType<typeof captureSwitchList>): string {
  return JSON.stringify(v, null, 2) + "\n";
}

// On capture, every group's lock entry is rewritten (selected → fresh, others → carried forward).
// For carried-forward entries of installed plugins, refresh desktopOnly to match the live manifest
// so the flag lands for the whole plugin set, not just the groups captured this run. Only when the
// installed version equals the entry's recorded one: a device on a different version would pin ITS
// manifest's flag onto an entry that records ANOTHER version's capture — and in a mid-upgrade fleet
// the two sides then rewrite the flag back and forth on every capture. The fresh-capture path is
// exempt from this concern: it writes version and flag together from the same manifest.
function refreshLockDesktopOnly(
  entry: StoreLockEntry,
  group: SyncGroup,
  plugins: PluginHost
): StoreLockEntry {
  const pluginId = pluginIdForGroup(group);
  if (pluginId === null) return entry;
  const localVersion = plugins.getInstalledPluginVersion(pluginId);
  if (localVersion === null || localVersion !== lockSourceVersion(entry, "plugin")) return entry;
  // `innate` is a partition, not a single flag: a claim inside it this build does not
  // know is kept, and only `desktopOnly` is rewritten from the live manifest.
  const { desktopOnly, ...restInnate } = entry.innate ?? {};
  const innate = plugins.isDesktopOnly(pluginId) ? { desktopOnly: true as const, ...restInnate } : restInnate;
  const { innate: _dropped, ...rest } = entry;
  return Object.keys(innate).length > 0 ? { ...rest, innate } : rest;
}

// The enabled-set delta an on/off-list apply computes (before-list vs final-list of enabled ids).
function switchDelta(before: SwitchList | null, after: SwitchList): { on: string[]; off: string[] } {
  const enabledIds = (l: SwitchList | null): Set<string> =>
    l === null ? new Set<string>() : new Set(Array.isArray(l) ? l : Object.keys(l).filter((k) => l[k] === true));
  const prev = enabledIds(before);
  const next = enabledIds(after);
  return {
    on: [...next].filter((id) => !prev.has(id)).sort(),
    off: [...prev].filter((id) => !next.has(id)).sort(),
  };
}

// switchDelta as report lines ("turns on: a, b").
function switchDeltaMessages(delta: { on: string[]; off: string[] }): string[] {
  const lines: string[] = [];
  if (delta.on.length > 0) lines.push(`turns on: ${delta.on.join(", ")}`);
  if (delta.off.length > 0) lines.push(`turns off: ${delta.off.join(", ")}`);
  return lines;
}

// Switch-list groups whose delta is applied to the running app immediately after their carrier
// file write: core and community plugins. The
// third switch-list carrier, "enabled-css-snippets", has no per-id runtime hook — it hot-applies
// through the appearance-family pass below instead.
const RUNTIME_SWITCH_GROUPS: ReadonlySet<string> = new Set(["core-plugins", "community-plugins"]);

// A carrier's element NAMES (`display.elements`; v2's `memberLabels`) for its CURRENT
// store-list members, MERGED additively with what was
// already known: community ids resolve through the
// installed-plugin manifest, core ids through the internal-plugin instance — same two lookups the
// single-label resolvers above/below already use — but "can't resolve locally" must never erase a
// name this device previously learned (from its own earlier capture, from a heal on ANOTHER
// device, or from a pull) for a member it simply doesn't have installed. Per id: the freshly
// resolved local name wins when available (so a rename heals in); otherwise the EXISTING entry's
// name for that id survives; only when neither exists is the id absent. An id no longer in the
// current store list is dropped (it's not a member anymore). Without this merge, two devices with
// different plugin sets would each overwrite the other's names with their own narrower subset on
// every heal — a perpetual lock-drift nag, and the "ids only where unresolvable ANYWHERE" spec
// criterion silently regressing to "unresolvable on the LAST device to heal". Shared by capture's
// own carrier write and backfillLockLabels' heal below — one computation, two triggers.
function carrierMemberLabels(
  carrier: "core-plugins" | "community-plugins",
  list: SwitchList | null,
  plugins: PluginHost,
  existing: Record<string, string> | undefined
): Record<string, string> {
  if (list === null) return {};
  const ids = Array.isArray(list) ? list : Object.keys(list);
  const labels: Record<string, string> = {};
  for (const id of ids) {
    const resolved = carrier === "community-plugins" ? plugins.getInstalledPluginName(id) : plugins.getCorePluginName(id);
    const name = resolved ?? existing?.[id];
    if (name !== undefined) labels[id] = name;
  }
  return labels;
}

function memberLabelsEqual(existing: Record<string, string> | undefined, next: Record<string, string>): boolean {
  const existingKeys = existing === undefined ? [] : Object.keys(existing);
  const nextKeys = Object.keys(next);
  return existingKeys.length === nextKeys.length && existingKeys.every((k) => existing?.[k] === next[k]);
}

// The appearance card's own file group, its two companion dir groups, and the snippet
// switch-list carrier that writes into appearance.json — the file set reloadAppearance()
// re-applies in one pass.
const APPEARANCE_FAMILY: ReadonlySet<string> = new Set(["appearance", "themes", "snippets", "enabled-css-snippets"]);

// Shared post-pass for apply()/applyWithActions(): if this run wrote or deleted any
// appearance-family file, hot-applies the appearance family to the running app once for the
// whole run instead of leaving every family result flagging needsAppReload. Honest on failure —
// no silent fallback, and needsAppReload stays true so the reload banner still fires.
async function hotApplyAppearanceFamily(ctx: CoreContext, results: GroupResult[]): Promise<void> {
  const family = results.filter((r) => APPEARANCE_FAMILY.has(r.group) && (r.filesWritten.length > 0 || r.filesDeleted.length > 0));
  if (family.length === 0) return;
  try {
    await ctx.plugins.reloadAppearance();
    for (const r of family) r.needsAppReload = false;
  } catch (e) {
    const message = (e as Error).message;
    for (const r of family) {
      r.messages.push(`appearance hot-apply failed, reload the app to see the applied appearance: ${message}`);
      if (r.status === "ok") r.status = "warning";
    }
  }
}

// Applies a switch-list delta to the running app: core ids via enable/disableCorePlugin,
// community ids via the non-persistent enable/disablePlugin (the carrier file is already
// written — the AndSave variants would rewrite it). Self-protection: config-sync is never
// runtime-disabled mid-apply (see applyGroup's cycle guard for the same reasoning). Per-id
// failures (including an unknown core id) are isolated — a warn message is recorded and the
// remaining ids still switch.
async function applyRuntimeSwitchDelta(ctx: CoreContext, groupName: string, delta: { on: string[]; off: string[] }, result: GroupResult): Promise<void> {
  const isCore = groupName === "core-plugins";
  const warn = (message: string): void => {
    result.messages.push(message);
    if (result.status === "ok") result.status = "warning";
    // A failed runtime switch leaves the on-disk carrier and the running app disagreeing —
    // applyGroup already set needsAppReload false before this call (the common case: the
    // switch itself is the reload), so restore it here (mirrors hotApplyAppearanceFamily's
    // honest-on-failure behavior) or the Reload CTA never surfaces for a real drift.
    result.needsAppReload = true;
  };
  for (const id of delta.on) {
    try {
      await (isCore ? ctx.plugins.enableCorePlugin(id) : ctx.plugins.enablePlugin(id));
    } catch (e) {
      warn((e as Error).message);
    }
  }
  for (const id of delta.off) {
    if (!isCore && id === "config-sync") {
      warn("config-sync stays running until reload");
      continue;
    }
    try {
      await (isCore ? ctx.plugins.disableCorePlugin(id) : ctx.plugins.disablePlugin(id));
    } catch (e) {
      warn((e as Error).message);
    }
  }
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

// Base-hygiene guard: contentUnchanged
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

// Base-hygiene guard for stale this-device per-element entries (an extension of
// the mechanism above): perElementArrayUnchanged deliberately ignores this-device elements
// symmetrically on both sides (correct for diff/status — re-sharing an element as this-device
// shouldn't read as a pending change), so a store base written before the change (or before the
// key had any perElement sharing at all) can still carry that element after contentUnchanged
// reports equal. Forces the rewrite that purges it. Elements pinned to the OTHER device class are
// legitimately present in the base (the store holds the union of shared elements across devices)
// and must NOT be treated as stale — only this-device elements are. No-op when the group has no
// perElement keys, or the existing content isn't a parseable JSON object.
function baseHasStalePerElementElements(effGroup: SyncGroup, existing: string): boolean {
  if (effGroup.perElement === undefined || Object.keys(effGroup.perElement).length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return Object.entries(effGroup.perElement).some(([key, sharings]) => {
    const arr = readPerElementArray(parsed, effGroup.name, key, "compare");
    return arr.some((el) => sharingOf(sharings, el).kind === "this-device");
  });
}

// Base-hygiene guard for stale top-level local-scoped keys (third family): like the
// two guards above, contentUnchanged deliberately ignores top-level scope:"local" keys on both
// sides (withContractLocals — correct for diff/status, prevents a phantom to-capture on a
// re-scoped field), so a base written before the field became local can still carry that key after
// contentUnchanged reports equal. The store must never hold a device-local value, so this forces
// the rewrite that captureTransform's strip has already removed the key from. A per-item key is
// governed exclusively by the perElement machinery (capturePerElementArray/applyPerElementArray), never by
// this top-level guard, even when a stray FieldRule pattern also happens to match its key name —
// so stripPatterns is filtered through the same excludingPerElement exclusion the strip paths use,
// or a legitimate perElement key would permanently flag the base as stale. No-op
// when the group has no local patterns, or the existing content isn't a parseable JSON object.
export function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = excludingPerElement(effGroup, stripPatterns(effGroup));
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

// Refreshes every locally-resolvable lock entry's label in place —
// capture only resolves a label for the groups it actually processes
// (see above), so an entry born on an older lock, or carried forward untouched by a partial-selection
// run, stays label-less forever without a dedicated heal. Called at the tail of every capture run
// and once at startup (main.ts). Never touches capturedAt or entries this vault can't resolve
// (an uninstalled plugin, an orphaned/dropped group) — returns whether anything changed, so a
// caller with nothing to do skips the write.
// carrierLists: the CURRENT store content for the two carriers (post any write this same run
// already made), pre-read by the caller so this function itself stays synchronous/IO-free and
// directly unit-testable (see tests/core.test.ts) — readCarrierSwitchLists below is the shared
// reader both call sites (main.ts startup, capture's own tail call) use to build it.
// excluded: group names THIS
// device has opted out of — the heal must not resurrect/write their lock entry either, exactly
// like it must not re-capture their content. Optional/defaults to none.
export function backfillLockLabels(
  groups: SyncGroup[],
  plugins: PluginHost,
  lock: StoreLock,
  carrierLists: Record<"core-plugins" | "community-plugins", SwitchList | null>,
  excluded?: ReadonlySet<string>
): boolean {
  // This is the fourth lock writer: the heal's caller rewrites the whole
  // file from this object, so a lock from a newer build must not be mutated here at all. The gate
  // lives on the MUTATION rather than on the caller because the two callers differ: main.ts's
  // startup heal writes only when this returns true, so refusing the mutation refuses that write;
  // capture discards the boolean and writes unconditionally, and is safe instead because capture
  // gates the local lock itself before it touches anything (see its own version check). Startup is
  // the case that needs this one — it runs with no user action behind it and
  // with a data.json this build reads perfectly, so `schemaStop` is null and the settings-side
  // guard says nothing. Deliberately NOT left to the carrying parser to make the round trip
  // lossless: that would rest the invariant on the parser instead of on the gate.
  // The heal only ever touches a lock ALREADY in the format this build
  // writes. Two failures share one rule. A lock from the FUTURE must not be mutated at all.
  // And a lock from the PAST must not be mutated either — parseStoreLock converts a
  // v1/v2 file to the v3 shape IN MEMORY, so writing that object back would leave `items` on disk
  // under the old `version`: a 2.21.0 peer would not refuse it (the number is not from the future),
  // could not parse it (it needs `groups`), and its next capture would rewrite the whole lock flat,
  // destroying the v3 bookkeeping — including the `legacy/` entries preserved precisely so nothing
  // is lost. A format upgrade is something a user's capture or pull earns; it is never a side
  // effect of fixing a display name. The gate lives on the MUTATION rather than on the caller
  // because the two callers differ: startup writes only when this returns true, so refusing the
  // mutation refuses the write; capture builds its own v3 lock (version === STORE_LOCK_VERSION) and
  // so is unaffected, having gated the file it replaces itself.
  if (storeLockVersion(lock) !== STORE_LOCK_VERSION) return false;
  let changed = false;
  for (const group of groups) {
    if (group.ref === undefined || excluded?.has(group.ref) === true) continue;
    const entry = lockEntry(lock, group.ref);
    if (entry === undefined) continue;
    // A LOOKUP, not a name parse: the group's own ref says which section it belongs to,
    // so only a community item's OWN group carries the community label — never a companion dir or
    // a custom rule that merely happens to sit on a plugin path (both of which resolve a pluginId
    // from their path, and neither of which is that plugin's item).
    const owner = refItemId(group.ref);
    const pluginId = pluginIdForGroup(group);
    const label =
      owner?.section === "community" && pluginId !== null
        ? plugins.getInstalledPluginName(pluginId)
        : owner?.section === "core"
          ? plugins.getCorePluginName(owner.id)
          : null;
    if (label === null || lockLabel(entry) === label) continue;
    setLockEntry(lock.items, group.ref, { ...entry, display: { ...entry.display, label } });
    changed = true;
  }
  // Element-name heal: MERGED with the existing map every call
  // (carrierMemberLabels' own doc comment) — same write-only-on-change guarantee as the label
  // loop above, but a name this device can't resolve locally is carried forward from the
  // existing entry rather than dropped, so a heal on one device never erases a name only another
  // device could resolve. A newly installed member's name still refreshes; an id no longer in the
  // current store list is still dropped.
  for (const carrier of ["core-plugins", "community-plugins"] as const) {
    const ref = carrierRef(carrier);
    const entry = lockEntry(lock, ref);
    if (entry === undefined) continue;
    const existing = lockElementLabels(entry);
    const elements = carrierMemberLabels(carrier, carrierLists[carrier], plugins, existing);
    if (Object.keys(elements).length === 0 || memberLabelsEqual(existing, elements)) continue;
    setLockEntry(lock.items, ref, { ...entry, display: { ...entry.display, elements } });
    changed = true;
  }
  return changed;
}

// Shared reader for backfillLockLabels' carrierLists param: the store file each carrier's OWN
// registered group would read (skipped — null — when that carrier isn't a group on this device
// at all, e.g. the on/off card is off; a group present but never captured has no store file yet,
// same null result).
export async function readCarrierSwitchLists(
  ctx: CoreContext,
  groups: SyncGroup[]
): Promise<Record<"core-plugins" | "community-plugins", SwitchList | null>> {
  const read = async (name: "core-plugins" | "community-plugins"): Promise<SwitchList | null> => {
    const group = groups.find((g) => g.name === name);
    if (group === undefined) return null;
    const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
    return (await ctx.io.exists(store)) ? parseSwitchList(await ctx.io.read(store)) : null;
  };
  return { "core-plugins": await read("core-plugins"), "community-plugins": await read("community-plugins") };
}

function requireGroup(manifest: SyncManifest, name: string): SyncGroup {
  const group = manifest.groups.find((g) => g.name === name);
  if (group === undefined) {
    throw new Error(`Unknown config-sync group "${name}": not defined in plugin settings`);
  }
  return group;
}

export async function capture(
  ctx: CoreContext,
  names?: string[],
  onProgress?: ProgressFn,
  stagedMembersByName?: Record<string, string[] | undefined>,
  // Forwarded verbatim to the tail heal below — see backfillLockLabels' own
  // `excluded` doc comment. Optional/defaults to none.
  optedOutForHeal?: ReadonlySet<string>
): Promise<GroupResult[]> {
  // Capture republishes plugin flags/versions from the manifest registry into the lock, but the
  // registry only rebuilds at app start or after config-sync's own installs — a file-sync tool
  // (Remotely Save, git) replacing plugin files mid-session leaves it stale. Re-read from disk
  // before anything below trusts it.
  await ctx.plugins.reloadPluginManifests();
  const manifest = await loadManifest(ctx);
  // The STORE side of the version gate: the local store lives inside the vault,
  // and the vault is synced by other tools (git, Remotely Save, a file-sync service) — so a newer
  // build on ANOTHER device can put a v3 lock into this store with no pull ever happening. Capture
  // is about to replace that lock wholesale; refused here, before the first group is written, or
  // `version: 2` would silently discard whatever v3 recorded. Read once and reused below.
  const lockRaw = (await ctx.io.exists(lockPath(ctx))) ? await ctx.io.read(lockPath(ctx)) : null;
  assertStoreLockVersionUnderstood(lockRaw);
  // Capture is the lock's writer and its only healing path: a previous lock that is
  // missing, old-format, or corrupt must never block capture — it is rewritten below. (A lock
  // from the FUTURE is the one exception, and it threw above: unreadable is not the same as
  // "readable, and newer than us".)
  let previous: StoreLock | null = null;
  try {
    previous = lockRaw === null ? null : parseStoreLock(lockRaw, manifest.groups);
  } catch {
    previous = null;
  }
  const selected = names === undefined ? null : new Set(names);
  const toProcess = manifest.groups.filter((g) => selected === null || selected.has(g.name));
  const items: LockItems = {};
  // A captured group's entry: this build's own fields, computed fresh, laid over the part of
  // the previous entry this build does not write. A bare-literal rebuild would strip
  // every field a NEWER build had recorded and republish the loss to the fleet on the
  // next push — the carrying parser alone cannot prevent that. The
  // known fields are still REPLACED rather than merged: dropping `desktopOnly` when a plugin stops
  // being desktop-only, or `label` when it can no longer be resolved, is deliberate. `hash` is
  // omitted (never blanked) when captureGroup could not fingerprint the group's store copy.
  //
  // Key ORDER matches what parseStoreLock re-emits — known fields, then the tail. That is the whole
  // point of the parser's fixed order (see its own comment): the lock is a file in a vault that
  // other tools sync and version, so a capture and a parse-then-write of the same entry must produce
  // the same bytes or every round trip churns the vault's history.
  const capturedEntry = (ref: string, own: StoreLockEntry, hash: string | null): StoreLockEntry => {
    const entry: StoreLockEntry = { ...own, capturedAt: ctx.now() };
    if (hash !== null) entry.hash = hash;
    return { ...entry, ...lockEntryTail(lockEntry(previous, ref)) };
  };
  // Every group compiled from an item carries its ref (types.ts's SyncGroup.ref). One that does not
  // has no identity to key a lock entry by — a hand-written legacy config-sync.json rule — and is
  // captured normally but recorded nowhere, exactly as it was before it had a lock entry at all.
  const carryForward = (group: SyncGroup): void => {
    const prev = lockEntry(previous, group.ref);
    if (group.ref !== undefined && prev !== undefined) setLockEntry(items, group.ref, refreshLockDesktopOnly(prev, group, ctx.plugins));
  };
  const results: GroupResult[] = [];
  // Computed ONCE for the whole run (never per group) — the store contract's `local` field
  // patterns, unioned into each group before it reaches captureGroup (Fix B, see
  // withContractLocals/readStoreContractLocals above).
  const contractLocals = await readStoreContractLocals(ctx);
  let done = 0;
  for (const group of manifest.groups) {
    if (selected !== null && !selected.has(group.name)) {
      carryForward(group); // not captured this run
      continue;
    }
    onProgress?.(done, toProcess.length, group.name);
    const { result, storeHash } = await captureGroup(ctx, withContractLocals(group, contractLocals.get(group.name) ?? []), stagedMembersByName?.[group.name]);
    done++;
    const ref = group.ref;
    const owner = ref === undefined ? null : refItemId(ref);
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      if (result.status !== "error") {
        const version = ctx.plugins.getInstalledPluginVersion(pluginId);
        if (version !== null) {
          // Only a community item's OWN group is the community label's home — a companion dir
          // (path `{configDir}/plugins/<id>`, ref `<owner>/<basename>`) or a custom rule scoped to a
          // plugin path also resolves a pluginId here but must never carry the label, or
          // displayLabelForGroup's storedLabel-?? -name fallback renders it as "Name › Name". A
          // LOOKUP on the group's own ref, not a parse of its name.
          const label = owner?.section === "community" ? ctx.plugins.getInstalledPluginName(pluginId) : null;
          const entry: StoreLockEntry = { source: { kind: "plugin", version } };
          if (ctx.plugins.isDesktopOnly(pluginId)) entry.innate = { desktopOnly: true };
          if (label !== null) entry.display = { label };
          if (ref !== undefined) setLockEntry(items, ref, capturedEntry(ref, entry, storeHash));
          // Version-only refresh: content is byte-identical but the store recorded an older
          // version (local > store drift). captureGroup produces no file change, so without this
          // the run report reads "no changes" even though the store's recorded version changed.
          const prevVersion = lockSourceVersion(lockEntry(previous, ref), "plugin");
          if (prevVersion !== null && prevVersion !== version && !hasChanges(result.changes) && result.stateNote === undefined) {
            result.stateNote = { kind: "ok", text: `store version refreshed ${prevVersion} → ${version}` };
          }
        } else {
          result.status = "warning";
          result.messages.push(`plugin "${pluginId}" is not installed in this vault; no version recorded`);
        }
      } else {
        carryForward(group); // errored capture keeps the last known version
      }
    } else if (result.status !== "error") {
      // Only core-plugin items (daily-notes, templates, …) resolve to a runtime name — Obsidian
      // cards (app/appearance/hotkeys…) and switch-list carriers have none to record.
      const label = owner?.section === "core" ? ctx.plugins.getCorePluginName(owner.id) : null;
      const entry: StoreLockEntry = { source: { kind: "app", version: ctx.plugins.getAppVersion() } };
      if (label !== null) entry.display = { label };
      if (ref !== undefined) setLockEntry(items, ref, capturedEntry(ref, entry, storeHash));
    }
    results.push(result);
  }
  // The store legitimately holds content outside this vault's registry (additive pulls never
  // delete, and no local flow prunes another contract's files). Its lock entries describe that
  // content — dropping them here would resurrect the remote "newer version info" hint after
  // every capture. Registry refs always win: their entries were just written or deliberately
  // dropped (e.g. plugin uninstalled) by the loop above. This is also the one thing that keeps a
  // v1/v2 entry no item here claims (itemKeys.ts's `legacy/` section) on disk instead of quietly
  // deleting another device's bookkeeping on our first capture.
  const registryRefs = new Set(manifest.groups.flatMap((g) => (g.ref === undefined ? [] : [g.ref])));
  for (const [ref, entry] of lockEntryList(previous?.items ?? {})) {
    if (!registryRefs.has(ref as ItemRef)) setLockEntry(items, ref, entry);
  }
  // The top-level stamp is DERIVED from the entries, not from the clock — it says how fresh
  // this store's content is, and a capture that touched two items must not claim the rest were
  // captured with them. A full capture still lands on ctx.now(), because every entry carries it.
  const capturedAt = derivedLockCapturedAt(items, [], ctx.now());
  // Field order follows parseStoreLock's, for the same byte-stability reason as the entries above:
  // the parser emits `capturedAt`, `items`, then the carried tail — and `version`/`syncedWatermark`
  // ride that tail (they are read through narrowing helpers, never validated in).
  const lock: StoreLock = {
    // The top-level stamp is DERIVED from the entries, not taken from the clock.
    capturedAt,
    items,
    // Every lock this build writes declares its format version, so a build that gains a new
    // lock field can tell "written before that field existed" from "written by something newer".
    version: STORE_LOCK_VERSION,
    // Lineage, not freshness: only a pull moves the watermark. A capture that bumped it would
    // tell every other device "I have seen a state newer than yours" on the strength of a purely
    // local change — a false "the store has newer settings". A
    // store that has never pulled starts its own lineage at its own capture time.
    syncedWatermark: previous !== null ? lockWatermark(previous) : capturedAt,
    // The lock's own unknown TOP-LEVEL keys: capture rewrites the whole
    // file, so without this a field a newer build recorded at the top level is stripped here.
    ...lockTail(previous),
  };
  // Tail heal (see backfillLockLabels doc comment): catches every locally-resolvable entry this
  // run didn't itself capture a label for, carried-forward or otherwise — including a carrier's
  // own element names, which this same call writes fresh from the store content this run just
  // produced (or carried forward untouched), satisfying the "written at capture" side too.
  backfillLockLabels(manifest.groups, ctx.plugins, lock, await readCarrierSwitchLists(ctx, manifest.groups), optedOutForHeal);
  await ensureParentDir(ctx.io, lockPath(ctx));
  await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
  return results;
}

// A group's store copy is a stable fingerprint only when two devices holding the SAME settings put
// the same bytes in the store. Encryption breaks that by design — every envelope carries its own
// salt and nonce, so two devices that captured identical plaintext hold different ciphertext — and a
// hash that always differs is worse than no hash at all: it would report every encrypted item as a
// permanent difference. Those groups publish `capturedAt` alone and are dated, not fingerprinted
// (leave the value absent rather than emit one that cannot match).
function storeContentIsHashable(group: SyncGroup): boolean {
  return !groupHasCiphertext(group);
}

const DEVICE_CLASSES = ["desktop", "mobile"] as const;

// One file group's WHOLE store copy: the base file and the per-device-class sidecars beside it.
// A sidecar is store content like any other — it holds a class's shared values, it travels with the
// store, and it genuinely changes — so a hash that saw only the base would let two stores differing
// only in a sidecar read as identical. That is a false NEGATIVE, and the comparison
// trusts an equal hash outright, so it would silently withhold a pull the user should have been
// offered. It is stable across devices for the same reason the base is: a device writes only its OWN
// class's sidecar, but the store holds both and both travel, so two devices whose stores agree hash
// the same files. Per-file hashing is ledger.ts's canonical one (switch lists as sets, everything
// else as bytes), so "equal" keeps meaning what "in-sync" already means here.
async function fileStoreCopyHash(groupName: string, base: string, sidecars: Record<"desktop" | "mobile", string | null>): Promise<string> {
  const parts = [await hashFileSide(groupName, base, "store")];
  for (const cls of DEVICE_CLASSES) {
    const content = sidecars[cls];
    if (content !== null) parts.push(`${sidecarStoreSuffix(cls)}\n${await sha256Hex(content)}`);
  }
  return STORE_LOCK_HASH_PREFIX + (await sha256Hex(parts.join("\n")));
}

// The same hash gathered from the store on DISK. A pull has to use this one: the merged state it
// produces exists nowhere but on disk. Capture gathers from the content it just wrote instead — it
// is the author, and its own bytes are what ANOTHER device's capture of the same settings would
// produce, which a historical formatting difference on disk would not be. The hashing rule is shared,
// so the two can only disagree where the disk genuinely differs — and that direction is safe: it
// surfaces a pull, it never hides one. null = not fingerprintable (ciphertext) or nothing there.
async function storeCopyHashOnDisk(ctx: CoreContext, group: SyncGroup): Promise<string | null> {
  if (!storeContentIsHashable(group)) return null;
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  if (group.type === "file") {
    if (!(await ctx.io.exists(store))) return null;
    const sidecars: Record<"desktop" | "mobile", string | null> = { desktop: null, mobile: null };
    for (const cls of DEVICE_CLASSES) {
      const p = store + sidecarStoreSuffix(cls);
      if (await ctx.io.exists(p)) sidecars[cls] = await ctx.io.read(p);
    }
    return fileStoreCopyHash(group.name, await ctx.io.read(store), sidecars);
  }
  if (!(await ctx.io.exists(store))) return null;
  const files = (await listFilesRecursive(ctx.io, store)).filter((f) => !isJunkPath(f));
  if (files.length === 0) return null;
  const entries: { rel: string; content: string }[] = [];
  for (const f of files) entries.push({ rel: relativeTo(store, f), content: await ctx.io.read(f) });
  return STORE_LOCK_HASH_PREFIX + (await hashDirSide(entries));
}

// `storeHash`: the canonical hash of the store content this run produced, computed from what
// captureGroup already holds rather than by reading the store back (see storeCopyHashOnDisk for why
// the author's own bytes are the better source). When a write is skipped because nothing changed,
// this hashes the content capture WOULD have written, which is the canonical form of what is already
// there — and canonical is the point, since the value only ever meets another DEVICE's hash of the
// same settings. null = not fingerprintable (ciphertext, see storeContentIsHashable) or nothing was
// written this run.
async function captureGroup(
  ctx: CoreContext,
  group: SyncGroup,
  stagedMembers?: string[]
): Promise<{ result: GroupResult; storeHash: string | null }> {
  const real = localRealPath(group.name, group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const result = emptyResult(group.name, false);
  if (!(await ctx.io.exists(real))) {
    result.status = "error";
    result.messages.push(`nothing to capture yet: ${real} does not exist in this vault`);
    return { result, storeHash: null };
  }
  if (group.type === "file") {
    const plainLocalContent = await ctx.io.read(real);
    const exc = excFor(ctx, group.name);
    // Switch lists take the switch path whether or not exceptions exist — an exc.length
    // guard would leave exception-free devices writing local enable-order into the store.
    const localSwitchList = isSwitchListGroup(group.name) ? readLocalSwitchList(group.name, plainLocalContent) : null;
    // Pass-through: excluded ids copy the store's existing state, so read it first.
    let existingStoreList: SwitchList | null = null;
    if (localSwitchList !== null && (await ctx.io.exists(store))) {
      existingStoreList = parseSwitchList(await ctx.io.read(store));
    }
    const runExc = localSwitchList !== null ? runExceptions(ctx, group.name, existingStoreList, localSwitchList, stagedMembers) : exc;
    const captureInput = localSwitchList !== null ? serializeSwitchList(captureSwitchList(localSwitchList, existingStoreList, runExc)) : plainLocalContent;
    const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
    const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
    const effGroup = overlayGroup(ctx, group, [plainLocalContent]);
    // Prior store content: needed for perElement keys (capturing a per-element array must
    // preserve the other device's already-captured elements) and so captureTransform
    // can reuse an unchanged encrypted field's existing envelope instead of re-encrypting it —
    // never needed for groups with neither, but harmless to read either way (see captureTransform's
    // storeContent doc comment; a switch-list group's real store read already happened above).
    const priorStoreContent = localSwitchList === null && (await ctx.io.exists(store)) ? await ctx.io.read(store) : null;
    const t = await captureTransform(effGroup, captureInput, ctx.passphrase, ctx.deviceClass, priorStoreContent, existingSidecar, fieldExceptionsFor(ctx, effGroup));
    if (t.note !== null) result.messages.push(t.note);
    await writeClassified(ctx, store, t.content, basename(store), result, async (existing) => {
      if (localSwitchList !== null) {
        const existingSwitchList = parseSwitchList(existing);
        if (existingSwitchList !== null) return switchListsEqual(localSwitchList, existingSwitchList, runExc);
      }
      const unchanged = await contentUnchanged(effGroup, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, existingSidecar, fieldExceptionsFor(ctx, effGroup));
      if (!unchanged) return false;
      // force the rewrite that purges stale class keys, stale local-scoped per-item elements, or stale top-level local keys
      return !baseHasStaleClassKeys(effGroup, existing) && !baseHasStalePerElementElements(effGroup, existing) && !baseHasStaleLocalKeys(effGroup, existing);
    });
    if (!isSwitchListGroup(group.name)) {
      if (t.ownScope !== null) {
        await writeClassified(ctx, sidecarPath, t.ownScope, basename(sidecarPath), result);
      } else if (await ctx.io.exists(sidecarPath)) {
        await ctx.io.remove(sidecarPath);
        result.filesDeleted.push(sidecarPath);
        result.changes.deleted.push(basename(sidecarPath));
      }
    }
    // Base AND both sidecars (see fileStoreCopyHash). The own-class one is what this run just wrote —
    // `t.ownScope` null means it was deleted, i.e. absent; the other class's is read as it stands,
    // which is exactly what the store holds and what another device would hash.
    let storeHash: string | null = null;
    if (storeContentIsHashable(effGroup)) {
      const sidecars: Record<"desktop" | "mobile", string | null> = { desktop: null, mobile: null };
      for (const cls of DEVICE_CLASSES) {
        if (isSwitchListGroup(group.name)) break; // switch lists never carry sidecars (see the write above)
        if (cls === ctx.deviceClass) {
          sidecars[cls] = t.ownScope;
          continue;
        }
        const p = store + sidecarStoreSuffix(cls);
        if (await ctx.io.exists(p)) sidecars[cls] = await ctx.io.read(p);
      }
      storeHash = await fileStoreCopyHash(group.name, t.content, sidecars);
    }
    return { result, storeHash };
  }
  const sourceFiles = await listFilesRecursive(ctx.io, real);
  const sourceRels = sourceFiles.map((f) => relativeTo(real, f)).filter((rel) => !isJunkPath(rel));
  const storeEntries: { rel: string; content: string }[] = [];
  for (const rel of sourceRels) {
    const target = `${store}/${rel}`;
    const plainLocalContent = await ctx.io.read(`${real}/${rel}`);
    if (group.mode === "encrypted") {
      const t = await captureTransform(group, plainLocalContent, ctx.passphrase, ctx.deviceClass, undefined, undefined, fieldExceptionsFor(ctx, group));
      await writeClassified(ctx, target, t.content, rel, result, (existing) =>
        contentUnchanged(group, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, null, fieldExceptionsFor(ctx, group))
      );
    } else {
      await writeClassified(ctx, target, plainLocalContent, rel, result);
      storeEntries.push({ rel, content: plainLocalContent });
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
  // The pruning above leaves the store holding exactly `sourceRels`, so the entries collected in the
  // loop ARE the store's content — no read-back needed.
  const storeHash = storeContentIsHashable(group) ? STORE_LOCK_HASH_PREFIX + (await hashDirSide(storeEntries)) : null;
  return { result, storeHash };
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
  await hotApplyAppearanceFamily(ctx, results);
  return results;
}

export type StateAction = "none" | "enable" | "update" | "update-enable" | "install" | "install-enable";

export interface ApplyItem {
  name: string;
  action: StateAction;
  // Partial-selection switch staging (Sync Center unified grammar): for a switch-list
  // group, restricts which members this run touches — members not named here keep their local
  // value. Absent = today's whole-list behavior.
  stagedMembers?: string[];
}

// targetVersion pins the install to the version the store's settings were captured on; the
// installer falls back to latest-stable when that tag is gone and returns what it actually
// installed (so the caller can warn on a mismatch).
export type PluginInstallFn = (pluginId: string, onPhase?: (phase: string) => void, targetVersion?: string) => Promise<string>;

// One-tap self update — the path a run can't take (runStateAction refuses it there: the generic
// update disables first, which would kill the very code executing the run). Ordered so failure
// never leaves a half-state: the download writes the plugin's files while the OLD code keeps
// running, and only after everything is on disk does the disable → enable reload swap it in.
// An install error therefore leaves the running plugin and its files untouched.
// `onInstalled` fires between the write and the reload — the caller's last chance to speak
// (a Notice) from the old instance.
export async function updateSelfPlugin(
  install: PluginInstallFn,
  plugins: PluginHost,
  targetVersion: string | null,
  onInstalled?: (version: string) => void,
  onPhase?: (phase: string) => void
): Promise<string> {
  const version = await install(SELF_ITEM_ID, onPhase, targetVersion ?? undefined);
  // Before the reload, or the enable below constructs the new instance from the registry's
  // pre-update manifest snapshot (new code, old version string).
  await plugins.reloadPluginManifests();
  onInstalled?.(version);
  onPhase?.("Reloading…");
  await plugins.disablePlugin(SELF_ITEM_ID);
  await plugins.enablePlugin(SELF_ITEM_ID);
  return version;
}

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
        throw new Error(`Obsidian did not enable "${pluginId}": enable it manually in Community plugins`);
      }
    } else {
      await ctx.plugins.enableCorePlugin(group.name);
      if (!ctx.plugins.isCorePluginEnabled(group.name)) {
        throw new Error(`Obsidian did not enable "${group.name}": enable it in Options → Core plugins`);
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
      messages: [`"${group.name}" has no plugin directory; install and update actions only work for community plugin items`],
      skipConfig: true,
    };
  }
  if (pluginId === SELF_ITEM_ID) {
    // Updating/reinstalling the self plugin from inside a run would disable the very code
    // executing it (update disables first) — refuse and point at the dedicated path
    // (updateSelfPlugin above), which downloads first and reloads only after the files are down.
    return {
      note: { kind: "warn", text: "⚠ update skipped" },
      messages: ["Config Sync updates itself from its own pane in the Sync Center (or Settings → Community plugins)"],
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
        messages: [`${messages[0]}; settings not applied (they were captured on a newer plugin version); update the plugin manually, then apply again`, ...messages.slice(1)],
        skipConfig: true,
      };
    }
    // With store data the settings still get written below; without it there is nothing else
    // to do — the guidance must not claim settings were staged.
    const guidance = hasStoreData ? "settings were applied; install it manually to pick them up" : "install it manually";
    return {
      note: { kind: "warn", text: "⚠ install failed" },
      messages: [`${messages[0]}; ${guidance}`],
      skipConfig: false,
    };
  }
  // Install/update itself succeeded (files written, manifests reloaded). Enabling is deferred
  // to `finish` — it runs after the config write, so the (re)loading plugin reads the APPLIED
  // settings instead of stale ones it could later re-save over them.
  const baseText = isUpdate ? `⤓ updated to ${version}` : `⤓ installed ${version}`;
  // The pinned version's release was gone, so the installer fell back to latest-stable.
  const fallbackMsgs = targetVersion !== null && version !== targetVersion
    ? [`the captured version ${targetVersion} is no longer downloadable; installed ${version} instead`]
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
          throw new Error(`Obsidian did not enable "${pluginId}": enable it manually in Community plugins`);
        }
        const text = isUpdate ? `⤓ updated to ${version} & enabled` : `⤓ installed & enabled ${version}`;
        // fallbackMsgs was already reported via the object above's `messages` field — applyWithActions
        // pushes that unconditionally before finish ever runs (skipConfig-false path), so repeating it
        // here would render the fallback line twice.
        return { note: { kind: "ok", text }, messages: [] };
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

// Capture-side policy: a disabled plugin whose settings flow device→store
// can still be turned on as part of the run. Enabling has no ordering constraint against the
// capture, so it runs after — keeping the report sequence natural.
export interface CaptureItem {
  name: string;
  action: "enable" | "none";
  // Partial-selection switch staging (Sync Center unified grammar): for a switch-list
  // group, restricts which members this run touches — members not named here keep their store
  // value. Absent = today's whole-list behavior.
  stagedMembers?: string[];
}

// Runner-level payload guard: an
// opted-out item cannot enter a capture/apply payload, even given a stale selection — called at
// the host boundary (main.ts) before a CaptureItem[]/ApplyItem[] ever reaches captureWithActions/
// applyWithActions, so this is enforcement below the UI's own stageable:false, not a duplicate of
// it. Pure and generic over both item shapes (they share only `name`). The payload speaks group
// NAMES and the opt-out list speaks item refs, so the caller supplies the one
// producer that bridges them (main.ts's groupRef) rather than this function growing a second.
export function excludeOptedOutItems<T extends { name: string }>(items: T[], optedOut: ReadonlySet<string>, refOf: (name: string) => string): T[] {
  return items.filter((i) => !optedOut.has(refOf(i.name)));
}

export async function captureWithActions(
  ctx: CoreContext,
  items: CaptureItem[],
  onProgress?: ProgressFn,
  // Forwarded verbatim to capture()'s own tail-heal guard. Optional/defaults to none.
  optedOutForHeal?: ReadonlySet<string>
): Promise<GroupResult[]> {
  const stagedMembersByName: Record<string, string[] | undefined> = {};
  for (const item of items) {
    if (item.stagedMembers !== undefined) stagedMembersByName[item.name] = item.stagedMembers;
  }
  const results = await capture(
    ctx,
    items.map((i) => i.name),
    onProgress,
    stagedMembersByName,
    optedOutForHeal
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

// Cold-bootstrap ordering: a staged batch can contain BRAT itself (a catalog install)
// alongside BRAT-managed plugins (installed via installViaBrat, which requires BRAT to already be on
// disk), and the catalog installs must finish first. `isBratManaged` is asked per staged NAME by the
// caller, which is the side that holds the identity — never a `plugin-<id>` parse here,
// because ordering is not the place to decide what a name means.
// Stable: each bucket preserves the input's relative order.
export function orderInstallsCatalogFirst(names: string[], isBratManaged: (name: string) => boolean): string[] {
  return [...names.filter((n) => !isBratManaged(n)), ...names.filter((n) => isBratManaged(n))];
}

export async function applyWithActions(
  ctx: CoreContext,
  items: ApplyItem[],
  installPlugin: PluginInstallFn,
  onProgress?: ProgressFn
): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  const lock = await loadLock(ctx); // carries each item's plugin source version — the install target
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
      const targetVersion = lockSourceVersion(lockEntry(lock, group.ref), "plugin");
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
        const r = actionOnly ? emptyResult(item.name, false) : await applyGroup(ctx, group, item.stagedMembers);
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
            if (pid !== null && ctx.plugins.isPluginEnabled(pid)) r.messages.push("no settings in the store; enabled the plugin only");
          } else if (pid !== null && ctx.plugins.getInstalledPluginVersion(pid) !== null && r.stateNote?.kind !== "warn") {
            r.messages.push(isUpd ? "no settings in the store; updated the plugin only" : "no settings in the store; installed the plugin only");
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
  await hotApplyAppearanceFamily(ctx, results);
  return results;
}

async function applyGroup(ctx: CoreContext, group: SyncGroup, stagedMembers?: string[]): Promise<GroupResult> {
  const real = localRealPath(group.name, group.path, ctx.configDir);
  const store = `${storeDir(ctx)}/${groupStorePath(group.path)}`;
  const pluginId = pluginIdForGroup(group);
  const result = emptyResult(group.name, pluginId === null);
  if (!(await ctx.io.exists(store))) {
    result.status = "error";
    result.needsAppReload = false;
    result.messages.push(`store has no data for this group (expected at ${store}); capture it from the source vault first`);
    return result;
  }
  // Version gate, BEFORE the write.
  // Adopt/self-apply writes the store's data.json onto this device and only then reloads, so a
  // check on the reload side arrives after the local document is already gone — this one runs
  // while the local file is still intact and simply fails the item, with the local file
  // byte-identical. Only the self item carries a schemaVersion; other items in the same run are
  // unaffected (applyWithActions isolates per item).
  if (group.name === SELF_GROUP_NAME && group.type === "file" && isFutureSchemaDocument(await ctx.io.read(store))) {
    result.status = "error";
    result.needsAppReload = false;
    result.messages.push(SCHEMA_FUTURE_APPLY_MESSAGE);
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
      const storeSwitchList = isSwitchListGroup(group.name) ? parseSwitchList(storeContent) : null;
      let content: string;
      let delta: { on: string[]; off: string[] } | null = null;
      if (storeSwitchList !== null) {
        const localSwitchList = localContent !== null ? readLocalSwitchList(group.name, localContent) : null;
        const runExc = runExceptions(ctx, group.name, storeSwitchList, localSwitchList, stagedMembers);
        const merged = applySwitchList(storeSwitchList, localSwitchList, runExc);
        const afterOff = subtractForceOff(merged, scopedMask(ctx.switchForceOff?.[group.name] ?? [], stagedMembers));
        const finalList = addForceOn(afterOff, scopedMask(ctx.switchForceOn?.[group.name] ?? [], stagedMembers));
        content = writeLocalSwitchList(group.name, finalList, localContent);
        // Name the plugins this write toggles: a store list lacking a
        // just-enabled plugin turns it off persistently — that must be visible in the report.
        delta = switchDelta(localSwitchList, finalList);
        for (const line of switchDeltaMessages(delta)) result.messages.push(line);
      } else {
        const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
        const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
        const effGroup = overlayGroup(ctx, group, [storeContent, localContent, existingSidecar]);
        content = await applyTransform(effGroup, storeContent, localContent, ctx.passphrase, ctx.deviceClass, existingSidecar, fieldExceptionsFor(ctx, effGroup));
      }
      await writeClassified(ctx, real, content, basename(real), result);
      // Runtime switching happens AFTER the carrier file write lands (same ordering rationale
      // as StatePrelude.finish above): an enabling plugin reads its data.json on load, so the
      // applied state must already be on disk before the delta is switched at runtime.
      if (delta !== null && RUNTIME_SWITCH_GROUPS.has(group.name)) {
        result.needsAppReload = false;
        await applyRuntimeSwitchDelta(ctx, group.name, delta, result);
      }
    } else {
      const storeFiles = await listFilesRecursive(ctx.io, store);
      const rels = storeFiles.map((f) => relativeTo(store, f));
      for (const rel of rels) {
        const target = `${real}/${rel}`;
        const storeContent = await ctx.io.read(`${store}/${rel}`);
        const content =
          group.mode === "encrypted"
            ? await applyTransform(group, storeContent, null, ctx.passphrase, ctx.deviceClass, null, fieldExceptionsFor(ctx, group))
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
// The self item's fast path for the skip lists below — it is the one ref whose rels are known
// without a group lookup, so it keeps working while a device's own registry is still empty.
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

// What pull and push say when the far end holds
// content but no lock. It names what was found and what is missing, and then BOTH ways a user
// arrives here — a path pointing INTO the store instead of at the folder holding it, and a target
// that is simply not empty yet (a new repository created with a README is the common one, and that
// user's path is perfectly correct). A message that explains only the rarer cause sends the reader
// after a problem they do not have, and teaches them to distrust the next message too.
export const STORE_LOCK_MISSING_MESSAGE =
  "This remote holds files but no store.lock.json, so Config Sync cannot tell whether it is a store. Point the remote at the folder that holds the store rather than inside it; or, if this is meant to be a new remote, clear what is already there first.";

// The far end's own statement of what it is: the lock this build writes, or the legacy root manifest
// that predates it. Either one names the folder, and this build READS both — remoteGroupsFrom parses
// config-sync.json to this day, and migrateLegacyManifest still exists — so a legacy store is not a
// folder whose bookkeeping we cannot see. It is one whose bookkeeping is older than the lock, which
// is a different sentence and gets the legacy path it has always had.
//
// A `.migrated-` remnant is deliberately NOT one of these. Nothing reads it (remoteGroupsFrom parses
// only config-sync.json; migrateLegacyManifest renames it precisely because it has been consumed),
// so it cannot say what is here — and a declaration nobody reads is not a declaration.
export function remoteDeclaresStore(files: readonly string[]): boolean {
  return files.includes(LOCK_REL) || files.includes(LEGACY_MANIFEST_REL);
}

// Everything at the far end that a pull would COPY INTO this device's store: every rel except
// bookkeeping — the lock, a legacy root manifest, its migrated remnants — and OS junk. Deliberately
// the same exclusion list planImport's own payload loop uses, because that is what makes this
// predicate mean something: there is no such thing as an innocent bystander file in a remote store,
// so anything left over here is content this build would take.
//
// Junk is not content (isJunkPath): a .DS_Store the Finder dropped into the empty folder a user
// just made for a first push says nothing about what is there, and refusing that push would be a
// refusal with no cause.
export function remoteStoreContentRels(files: readonly string[]): string[] {
  return files.filter((rel) => rel !== LOCK_REL && !isLegacyManifestRel(rel) && !isJunkPath(rel));
}

// The declared-store gate, in one sentence: refuse when there is content AND nothing here says
// what the content is.
//
// "There is nothing here yet" and "I cannot see the bookkeeping" are different statements, and
// without this gate they produce the same behaviour — a directory full of store content with no
// store.lock.json reads as a brand-new remote and is pulled wholesale, silently. No lock means no
// version, which means the version gate above never runs at all: it is only ever as strong as the
// bookkeeping being FOUND.
//
// What it is NOT:
//   · not a check that the far end is store-SHAPED. A remote pointed one level too deep, at the
//     store folder itself, lists `configdir/…` and no `store/…` at all — a shape check would
//     wave through exactly that mistake, and the worse mistype (a remote aimed at a
//     vault ROOT, listing notes and `.obsidian/…`) would read as empty and then be MIRRORED over by
//     the first push.
//   · not a check on the bookkeeping's CONTENTS. A lock that is present but unreadable keeps the
//     tolerant behaviour it has always had (see declaredStoreLockVersion — refusing to sync over a
//     typo would strand a whole fleet). Presence is this gate's question; what the file SAYS is the
//     version gate's.
//
// A genuinely empty remote — nothing declaring a store, no content — is untouched by this and stays
// a first-push target, which is the common way a remote is set up in the first place.
export function assertRemoteStoreDeclared(files: readonly string[]): void {
  if (remoteDeclaresStore(files)) return;
  if (remoteStoreContentRels(files).length > 0) throw new Error(STORE_LOCK_MISSING_MESSAGE);
}

export async function remoteGroupsFrom(ctx: CoreContext, reader: ExternalStoreReader, files: string[]): Promise<SyncGroup[]> {
  if (files.includes(SELF_STORE_DATA_REL)) {
    const raw = await reader.readFile(SELF_STORE_DATA_REL);
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && Array.isArray(parsed.groups)) {
      return validateSyncManifest({ version: 1, groups: parsed.groups }).groups;
    }
    if (ctx.storeListGroups !== undefined) return ctx.storeListGroups(raw); // v3: recompile from `items`
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
      map.set(g.name, (g.fields ?? []).filter((f) => f.sharing.kind === "this-device").map((f) => f.pattern));
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
  // The far end's file listing as the planner saw it — carried for the same reason remoteLockRaw is:
  // applyImport is the half that writes, and it re-runs both store gates on what it was handed
  // rather than trusting that whoever built this plan ran them (see the version-gate note there).
  remoteFiles: string[];
  // The items this remote does not pull, as its rules resolve them (remoteRules.ts's
  // refsBlockedFor). Carried so applyImport skips exactly what the planner skipped.
  skipRefs: ItemRef[];
  // The items whose remote content this plan REWROTE, because some of their keys do not pull with
  // this remote. Carried for the bookkeeping: their content is a hybrid of both sides, so the
  // remote's lock entry does not describe what we are about to hold (see applyImport).
  mergedRefs: string[];
}

// Every store rel belonging to a skipped item. Built per seam from the group lists that seam
// already has: a rel belongs to a skipped item when its owning group's ref is in the list.
export function skipRelPredicate(skipRefs: ItemRef[], ...groupLists: SyncGroup[][]): (rel: string) => boolean {
  if (skipRefs.length === 0) return () => false;
  const skipsSelf = skipRefs.includes(SELF_ITEM_REF);
  return (rel: string): boolean => {
    if (skipsSelf && isSelfStoreRel(rel)) return true;
    for (const groups of groupLists) {
      const ref = resolveGroupByStoreRel(groups, rel)?.ref;
      if (ref !== undefined) return skipRefs.includes(ref);
    }
    return false;
  };
}

// Read-only: this half of a pull never writes anything, so a refusal below costs nothing.
export async function planImport(
  ctx: CoreContext,
  reader: ExternalStoreReader,
  opts: {
    skipRefs: ItemRef[];
    withheldPull: (rel: string) => string[];
    // Re-encrypts a remote file for THIS vault's key, reusing the local copy's envelopes where the
    // plaintext matches (core/transcode.ts). Absent = the two sides share one passphrase, and
    // ciphertext is forwarded verbatim — the road every remote without its own key is on.
    transcode?: (rel: string, content: string, existing: string | null) => Promise<string>;
  }
): Promise<PendingPull> {
  const files = await reader.listFiles();
  // Declared-store gate: before a single remote file is read — content that nothing here identifies is refused, not
  // adopted as a brand-new remote. Ahead of the version gate below because it is the condition under
  // which that gate cannot run at all.
  assertRemoteStoreDeclared(files);
  const remoteGroups = await remoteGroupsFrom(ctx, reader, files);
  const remoteLockRaw = files.includes(LOCK_REL) ? await reader.readFile(LOCK_REL) : null;
  // Version gate: refused here, before a single remote file is read into a plan — a store whose lock comes
  // from a newer build is never merged into (and, at the end of applyImport, written back over)
  // by this one. Nothing has been written at this point, so the local store is untouched.
  assertStoreLockVersionUnderstood(remoteLockRaw);
  // The LOCAL lock too, which a newer build can leave in this vault through ordinary vault sync
  // with no pull involved. Planning writes nothing, so this is not the guarantee — applyImport's
  // own check is — but it is what makes the refusal arrive BEFORE the user is asked to adjudicate
  // conflicts. Letting someone resolve a merge and only then saying the operation was never
  // possible is the same defect as inviting a pull that will be refused. The writer deliberately
  // re-reads rather than being handed these bytes: it must check what it is about to replace, not
  // what the planner happened to see.
  assertStoreLockVersionUnderstood((await ctx.io.exists(lockPath(ctx))) ? await ctx.io.read(lockPath(ctx)) : null);

  // Local first, remote second — the same order owningGroupName resolves in: a rel this vault knows
  // is answered by this vault's own registry, and only an unknown one asks the far end's.
  const localGroups = await readGroups(ctx);
  const skipped = skipRelPredicate(opts.skipRefs, localGroups, remoteGroups);

  const remoteFileMap = new Map<string, string>();
  const mergedRefs = new Set<string>();
  for (const rel of files) {
    if (rel === LOCK_REL || isLegacyManifestRel(rel) || skipped(rel)) continue;
    let raw = await reader.readFile(rel);
    const patterns = opts.withheldPull(rel);
    const localAbs = `${ctx.rootPath}/${rel}`;
    const keep = patterns.length === 0 && opts.transcode === undefined ? null : (await ctx.io.exists(localAbs)) ? await ctx.io.read(localAbs) : null;
    // Transcode BEFORE the withheld overlay: from here on everything in the plan answers to this
    // vault's own key, and the overlay's `keep` side already does. A reuse hit hands back the
    // local copy's bytes, so an unchanged item classifies as no difference and the plan stays
    // quiet — spec 3.9.1's whole point.
    if (opts.transcode !== undefined) raw = await opts.transcode(rel, raw, keep);
    if (patterns.length === 0) {
      remoteFileMap.set(rel, raw);
      continue;
    }
    // What lands in the plan is the MERGED content, not theirs: the planner's job is to describe
    // what a pull would write, and this is what it would write. It also settles the comparison for
    // free — a file whose only difference is a withheld key now equals ours and never comes up.
    remoteFileMap.set(rel, overlayWithheld({ rel, keep, take: raw, patterns }));
    const ref = resolveGroupByStoreRel(localGroups, rel)?.ref ?? resolveGroupByStoreRel(remoteGroups, rel)?.ref;
    if (ref !== undefined) mergedRefs.add(ref);
  }

  const localFileMap = new Map<string, string>();
  if (await ctx.io.exists(ctx.rootPath)) {
    const localAbs = await listFilesRecursive(ctx.io, ctx.rootPath);
    for (const f of localAbs) {
      const rel = relativeTo(ctx.rootPath, f);
      if (rel === LOCK_REL || isLegacyManifestRel(rel) || skipped(rel)) continue;
      localFileMap.set(rel, await ctx.io.read(f));
    }
  }

  const plan = classifyMerge(localGroups, localFileMap, remoteGroups, remoteFileMap);
  return { plan, remoteGroups, remoteLockRaw, remoteFiles: files, skipRefs: opts.skipRefs, mergedRefs: [...mergedRefs] };
}

// Writes the whole merge result, auto-merged parts and each conflict's chosen side, in one pass.
// Never deletes local-only files or groups.
export async function applyImport(
  ctx: CoreContext,
  pending: PendingPull,
  choices: ("local" | "remote")[]
): Promise<GroupResult[]> {
  const { plan, remoteGroups, remoteLockRaw } = pending;
  // The version gate on the writer itself: planImport already refused a newer REMOTE, but applyImport is the
  // half that writes, and the gate belongs on the write rather than on the caller's discipline.
  assertStoreLockVersionUnderstood(remoteLockRaw);
  // The declared-store gate, on the same footing: a plan built by a caller that never went
  // through planImport must not be the way content with no bookkeeping still lands in the store.
  assertRemoteStoreDeclared(pending.remoteFiles);
  // And on the lock this merge is about to REPLACE — the local one. A v3 lock
  // reaches this store through ordinary vault sync, with no pull involved, so "the remote is old
  // enough" says nothing about what is already here. planImport refuses this too, so the user is
  // never asked to resolve conflicts for a pull that cannot happen — but the planner is a
  // courtesy and this is the guarantee: a check that lived only on the courtesy path would quietly
  // stop covering the next caller that reaches applyImport directly. Read before the first file is
  // written; the parse below reuses it, so the merge sees exactly the bytes this gate checked.
  const localLockRaw = (await ctx.io.exists(lockPath(ctx))) ? await ctx.io.read(lockPath(ctx)) : null;
  assertStoreLockVersionUnderstood(localLockRaw);
  // Pull is pure store transport: it resolves file conflicts only. Definition (sync-list)
  // conflicts and remote-only group additions are never applied by Pull — the local sync
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
  // the sync list (the compiled item registry). Remote-only additions land
  // in the store here and become adoptable via the config-sync pane.
  const groups = await readGroups(ctx);

  // Parsed from the same bytes the version gate above read — no second read, and no window in
  // which the file could differ from what was checked.
  // The remote's lock is re-keyed against BOTH sides' groups: during the transition window the
  // remote is still written by a 2.21.0 device, and an entry re-keyed differently from the local
  // one would read as an item we do not have — a pull that can never converge.
  const lockGroups = [...remoteGroups, ...groups];
  const localLock = localLockRaw !== null ? parseStoreLock(localLockRaw, lockGroups) : null;
  const remoteLock = remoteLockRaw !== null ? parseStoreLock(remoteLockRaw, lockGroups) : null;
  if (localLock !== null || remoteLock !== null) {
    const groupByName = new Map(lockGroups.map((g) => [g.name, g] as const));
    const refOf = (name: string): string | undefined => groupByName.get(name)?.ref;
    const mergedItems: LockItems = {};
    for (const [ref, entry] of lockEntryList(localLock?.items ?? {})) setLockEntry(mergedItems, ref, entry);
    // Converge remoteLockAhead by construction: after a pull the local lock must carry every
    // remote lock entry the hint checks — except the self group when this remote excludes it,
    // and except a group whose file conflict the user kept as "local" (a real divergence that
    // belongs to the local lineage). Copying an entry with no comparable store file is correct:
    // a pull is additive, that content stays in the store, and its lock entry describes it.
    const localWonRefs = new Set<string>();
    for (let i = 0; i < fileConflicts.length; i++) {
      if (choices[i] === "local") {
        const c = fileConflicts[i];
        const ref = c === undefined ? undefined : refOf(c.name);
        if (ref !== undefined) localWonRefs.add(ref);
      }
    }
    const adoptedRefs = new Set<string>();
    const mergedRefs = new Set<string>(pending.mergedRefs);
    if (remoteLock !== null) {
      for (const [ref, entry] of lockEntryList(remoteLock.items)) {
        if ((pending.skipRefs as string[]).includes(ref)) continue;
        if (localWonRefs.has(ref)) continue;
        // A merged item's content is neither side's, so neither side's fingerprint describes it.
        // Its entry is seeded from theirs — where the item came from is still theirs to tell — and
        // the restamp loop below replaces the two fields that describe CONTENT. Deliberately not
        // added to `adoptedRefs`: that set is what tells the restamp loop to leave an entry alone.
        if (mergedRefs.has(ref)) {
          const seeded = lockEntryTail(lockEntry(localLock, ref));
          for (const key of Object.keys(entry)) delete seeded[key];
          setLockEntry(mergedItems, ref, { ...entry, ...seeded });
          continue;
        }
        // The remote's entry wins every field it HAS — the content is now the remote's, so its
        // versions, capture time and hash describe it. But a key only OUR entry carried is not the
        // remote's to delete: dropping it is the same loss as the top-level strip, one level down,
        // and keeping it is convergence-safe because the comparison only ever weighs keys present on
        // BOTH sides. (`lockEntryTail` excludes everything this build writes itself, so a stale
        // local `hash` can never survive underneath the adopted entry.)
        const carried = lockEntryTail(lockEntry(localLock, ref));
        for (const key of Object.keys(entry)) delete carried[key];
        setLockEntry(mergedItems, ref, { ...entry, ...carried });
        adoptedRefs.add(ref);
      }
    }
    // A pull that WROTE a group's files changed that group's store content, and an entry we did not
    // take from the remote — a group the user kept as "local" whose remote-only files still landed,
    // or one the remote's lock never described — would otherwise keep describing what was there
    // before. That is the one real counterexample to "only a capture changes store content, and a
    // capture re-dates what it captured", and the items-first comparison leans on
    // that claim: an equal hash is believed outright, so a stamp that outran its content is exactly
    // the thing that must not exist. Entries ADOPTED from the remote are deliberately left alone —
    // they describe bytes we copied verbatim, and rewriting them is what would break the convergence
    // a pull exists to produce.
    for (const [name, r] of byName) {
      const ref = refOf(name);
      const existing = itemEntry(mergedItems, ref);
      if (ref === undefined || !hasChanges(r.changes) || existing === undefined || adoptedRefs.has(ref)) continue;
      const group = groupByName.get(name);
      if (group === undefined) continue;
      const hash = await storeCopyHashOnDisk(ctx, group);
      const restamped: StoreLockEntry = { ...existing, capturedAt: ctx.now() };
      if (hash === null) delete restamped.hash;
      else restamped.hash = hash;
      setLockEntry(mergedItems, ref, restamped);
    }
    // Field order follows parseStoreLock's (see capture's own note): capturedAt, items, then the
    // carried tail, with version/syncedWatermark riding that tail.
    const merged: StoreLock = {
      // `capturedAt` describes THIS store's content: derived from the merged entries, floored at the
      // value it already had, because a pull is additive — it never removes content, so the store it
      // produces can never be older than the one it started from.
      capturedAt: derivedLockCapturedAt(
        mergedItems,
        [localLock?.capturedAt],
        localLock?.capturedAt ?? remoteLock?.capturedAt ?? ctx.now()
      ),
      items: mergedItems,
      // Same rule as capture: this build wrote this file, so it declares the format this
      // build writes — whichever version the two merged sides carried. Both are ≤ 3 by the time we
      // get here; a newer remote was refused above.
      version: STORE_LOCK_VERSION,
      // The pull is the ONLY writer that moves the watermark, and moving it is what makes
      // remoteLockAhead settle to false afterwards. It records the remote's LINEAGE, not its
      // bare watermark: a remote that captured after its own last pull stands at its `capturedAt`,
      // and aligning to anything less would leave us permanently behind a state we just adopted.
      syncedWatermark: remoteLock !== null ? lockLineage(remoteLock) : localLock !== null ? lockWatermark(localLock) : ctx.now(),
      // Unknown TOP-LEVEL keys, from both sides. The local lock's own keys
      // win a collision — we cannot merge two values whose meaning we do not know, and the file we
      // are writing is this store's — but a key only the remote carries is adopted rather than
      // dropped: pull-then-push through this build would otherwise strip a newer build's top-level
      // field from the remote, which is exactly the loss this discipline exists to stop.
      ...lockTail(remoteLock),
      ...lockTail(localLock),
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

// What a push says when the far end moved while it was being prepared. Product voice: what happened,
// that nothing was written, and what to do — the file that moved is a developer's detail.
export const PUSH_RACE_MESSAGE =
  "The other end changed while this push was being prepared. Nothing was written; compare again, then push.";

// And what it says when the PICK, rather than the bytes, is what went stale.
export const PUSH_STALE_MESSAGE =
  "Some of the items you picked changed at the other end since you last compared. Nothing was written; refresh the comparison and pick again.";

// A lock at the far end this build cannot parse, told apart from one that is not there — and it does
// not need to be: both leave the push with no far-end entries to preserve. The version gate has
// already refused a lock from a NEWER build, so what reaches here is a damaged file, and push is the
// operation that replaces it, exactly as capture replaces a damaged local one. The LOCAL lock is
// deliberately not read this way: a bookkeeping file we cannot read is this device's problem, and
// pushing it to the whole fleet is not the way to find out.
function parsedOrNull(raw: string | null, groups: readonly SyncGroup[]): StoreLock | null {
  if (raw === null) return null;
  try {
    return parseStoreLock(raw, groups);
  } catch {
    return null;
  }
}

// The fingerprint of what a push SENT, per item whose content it rewrote. Same hashing rule as
// everywhere else (fileStoreCopyHash), fed this run's own bytes rather than the copy on disk —
// which is the point: the two differ exactly where a key stayed behind. A rewritten item is always a
// file item with a JSON store copy (keyWithholding.ts's own rule), so its base rel is the anchor and
// its sidecars ride along; anything else answers null, and an absent fingerprint is never a difference.
async function sentHashes(
  ctx: CoreContext,
  groups: SyncGroup[],
  rewritten: ReadonlyMap<string, Record<string, string>>
): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const [ref, byRel] of rewritten) {
    const group = groups.find((g) => g.ref === ref);
    const base = group === undefined ? undefined : byRel[`store/${groupStorePath(group.path)}`];
    if (group === undefined || base === undefined || !storeContentIsHashable(group)) {
      hashes.set(ref, null);
      continue;
    }
    const sidecars: Record<"desktop" | "mobile", string | null> = { desktop: null, mobile: null };
    for (const cls of DEVICE_CLASSES) sidecars[cls] = byRel[`store/${groupStorePath(group.path)}${sidecarStoreSuffix(cls)}`] ?? null;
    hashes.set(ref, await fileStoreCopyHash(group.name, base, sidecars));
  }
  return hashes;
}

export async function pushExternal(
  ctx: CoreContext,
  writer: ExternalStoreWriter,
  opts: {
    skipRefs: ItemRef[];
    withheldPush: (rel: string) => string[];
    // The items the caller picked, i.e. what the user acted on. It cannot be derived from the push
    // set — `skipRefs` mixes "not ticked" with "the rules withhold it" — and the guard's whole
    // meaning is "the answer you acted on has since changed", so the answer's owner has to say so.
    // A caller with no judgement to speak of passes `[]` and the guard stays quiet: honest, not a hole.
    expectPush: readonly string[];
    // Re-encrypts a local file for the REMOTE's key, reusing the far end's envelopes where the
    // plaintext matches (core/transcode.ts). Absent = shared passphrase, verbatim forwarding.
    transcode?: (rel: string, content: string, existing: string | null) => Promise<string>;
  }
): Promise<GroupResult[]> {
  const localAbs = (await ctx.io.exists(ctx.rootPath)) ? await listFilesRecursive(ctx.io, ctx.rootPath) : [];
  const rels = localAbs.map((f) => f.slice(ctx.rootPath.length + 1)).sort();
  const hasStore = rels.some((r) => r.startsWith("store/")) || rels.includes(LOCK_REL);
  if (!hasStore) {
    throw new Error(
      `Local store has no captured data at ${ctx.rootPath}; capture from this device (or pull) before pushing.`
    );
  }
  const manifest = await loadManifest(ctx);
  const skipped = skipRelPredicate(opts.skipRefs, manifest.groups);
  const pushableRels = rels.filter((r) => !isLegacyManifestRel(r) && !skipped(r));
  const byName = new Map<string, GroupResult>();
  const resultFor = (name: string): GroupResult => {
    let r = byName.get(name);
    if (r === undefined) {
      r = emptyResult(name, false);
      byName.set(name, r);
    }
    return r;
  };
  const remoteRels = await writer.listFiles();
  // The declared-store gate, push side: the far end holds content nothing there identifies, and push is the operation
  // that would overwrite and mirror-delete it. Asked of the RAW listing, the same input the reader's
  // own check sees — the legacy-manifest filter below is about what gets pushed, not about what is
  // there, and here the legacy manifest is exactly the thing that must still count.
  assertRemoteStoreDeclared(remoteRels);
  const remoteFiles = new Set(remoteRels.filter((r) => !isLegacyManifestRel(r)));
  // Read ONCE: the version gate below and the derived lock at the end must see the same bytes, for
  // the same reason applyImport parses the bytes its own gate read.
  const remoteLockRaw = remoteFiles.has(LOCK_REL) ? await writer.readFile(LOCK_REL) : null;
  // The version gate, push side: refused before the first writeFile — pushing this build's store over a remote
  // written by a newer one would overwrite a shape we cannot read with one it cannot read back.
  assertStoreLockVersionUnderstood(remoteLockRaw);
  // Read here rather than at the derived-lock step below: the stale-pick guard and the lock this
  // push sends must reason about the same bytes, the same discipline applyImport follows for the
  // lock its own gate checked.
  const localLockRaw = rels.includes(LOCK_REL) ? await ctx.io.read(`${ctx.rootPath}/${LOCK_REL}`) : null;
  // The judgement the user acted on can be a refresh cycle old, while this push reads the far end
  // fresh (spec 3.7's third layer). What they picked is ITEMS, not bytes — so if a picked item has
  // moved past us over there since, the pick rests on an answer that no longer holds. Stop and let
  // them look again rather than overwriting on the strength of a stale reading. Before phase 1, so
  // nothing is read for a run that cannot happen and nothing at all has been written.
  if (opts.expectPush.length > 0 && localLockRaw !== null && remoteLockRaw !== null) {
    const mineLock = parseStoreLock(localLockRaw, manifest.groups);
    const theirsLock = parsedOrNull(remoteLockRaw, manifest.groups);
    if (theirsLock !== null) {
      const stale = opts.expectPush.filter((ref) => itemFreshness(lockEntry(mineLock, ref), lockEntry(theirsLock, ref)) === "newer");
      if (stale.length > 0) throw new Error(PUSH_STALE_MESSAGE);
    }
  }
  // PHASE 1 — work everything out, write nothing. A rewritten file's content is computed FROM what
  // the far end currently holds (spec 3.2), so the run has a read-modify-write window; phase 2
  // closes it before phase 3 puts down a single byte. The order IS the promise: a vault writer's
  // writes are immediate and durable, so a refusal discovered mid-loop would leave a half-pushed
  // store (spec 3.7).
  const rewritten = new Map<string, Record<string, string>>(); // ref -> rel -> the content we sent
  const planned: { rel: string; name: string; itemRel: string; content: string; theirs: string | null; reread: boolean }[] = [];
  for (const rel of pushableRels) {
    if (rel === LOCK_REL) continue; // not content: derived and written at the end
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    const mine = await ctx.io.read(`${ctx.rootPath}/${rel}`);
    const existed = remoteFiles.has(rel);
    const theirs = existed ? await writer.readFile(rel) : null;
    const patterns = opts.withheldPush(rel);
    // Transcode BEFORE the withheld overlay, so both of the overlay's sides answer to the far
    // end's key. A reuse hit hands back THEIR bytes, so the identical-skip below keeps the steady
    // state silent — fresh salts notwithstanding (spec 3.9.1).
    const sending = opts.transcode === undefined ? mine : await opts.transcode(rel, mine, theirs);
    // Their value for a withheld key is not ours to delete: the store holds whole documents, not
    // patches, so sending the file without that key would make their next Apply drop it from their
    // live config. Push already reads their copy for the skip-if-identical test, so this is not new IO.
    const content = patterns.length === 0 ? sending : overlayWithheld({ rel, keep: theirs, take: sending, patterns });
    if (patterns.length > 0) {
      const ref = resolveGroupByStoreRel(manifest.groups, rel)?.ref;
      if (ref !== undefined) rewritten.set(ref, { ...(rewritten.get(ref) ?? {}), [rel]: content });
    }
    // A transcoded file's content depends on what is over there (the reuse comparand), so the
    // write-ahead recheck must cover it exactly as it covers a withheld one.
    planned.push({ rel, name, itemRel, content, theirs, reread: patterns.length > 0 || sending !== mine });
  }
  // PHASE 2 — check the ground has not moved under the files whose content depends on it. A file we
  // forward byte for byte has no window to lose: its content does not depend on what is over there,
  // so it is deliberately not re-read. Not a retry — a push is not idempotent, so the refusal goes
  // to the user and they decide what to do next.
  for (const p of planned) {
    if (!p.reread) continue;
    const now = remoteFiles.has(p.rel) ? await writer.readFile(p.rel) : null;
    if (now !== p.theirs) throw new Error(PUSH_RACE_MESSAGE);
  }
  // PHASE 3 — from here on it writes.
  for (const p of planned) {
    const existed = remoteFiles.has(p.rel);
    if (existed && p.theirs === p.content) continue; // unchanged: skip the write
    await writer.writeFile(p.rel, p.content);
    const result = resultFor(p.name);
    result.filesWritten.push(p.rel);
    (existed ? result.changes.updated : result.changes.added).push(p.itemRel);
  }
  const wanted = new Set(pushableRels);
  for (const rel of remoteFiles) {
    if (skipped(rel)) continue; // the remote's own copy of a withheld item is not ours to delete
    if (!wanted.has(rel)) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
      await writer.deleteFile(rel);
      const result = resultFor(name);
      result.filesDeleted.push(rel);
      result.changes.deleted.push(itemRel);
    }
  }
  // The bookkeeping goes last, and goes DERIVED. It is the one file whose content is not simply
  // ours: it describes the store the far end holds after this push, and this push did not send
  // everything (derivedLock.ts). No local lock = nothing to describe, and the push says nothing.
  if (localLockRaw !== null) {
    const derived = derivedPushLock({
      local: parseStoreLock(localLockRaw, manifest.groups),
      remote: parsedOrNull(remoteLockRaw, manifest.groups),
      skipRefs: opts.skipRefs,
      rewrittenHashes: await sentHashes(ctx, manifest.groups, rewritten),
    });
    const content = JSON.stringify(derived, null, 2) + "\n";
    const existed = remoteFiles.has(LOCK_REL);
    if (!existed || remoteLockRaw !== content) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, LOCK_REL);
      await writer.writeFile(LOCK_REL, content);
      const result = resultFor(name);
      result.filesWritten.push(LOCK_REL);
      (existed ? result.changes.updated : result.changes.added).push(itemRel);
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
