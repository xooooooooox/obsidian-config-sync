import { FileIO, ensureParentDir, isJunkPath, listFilesRecursive, pruneEmptyDirsUnder } from "./io";
import { FieldRule, GroupResult, hasChanges, StoreLock, StoreLockEntry, SyncGroup, SyncManifest } from "./types";
import { basename, groupStorePath, relativeTo, resolveGroupByStoreRel, sidecarStoreSuffix } from "./pathing";
import { assertStoreLockVersionUnderstood, derivedLockCapturedAt, lockEntryTail, lockLineage, lockTail, lockWatermark, parseStoreLock, parseSyncManifest, storeLockVersion, STORE_LOCK_HASH_PREFIX, STORE_LOCK_VERSION, validateSyncManifest } from "./manifest";
import { isFutureSchemaDocument, SCHEMA_FUTURE_APPLY_MESSAGE } from "./settingsMigration";
import { applyTransform, captureTransform, classPatterns, contentUnchanged, excludingPerItem, groupNeedsPassphrase, isWholeFileEncrypted, stripPatterns } from "./modes";
import { hashDirSide, hashFileSide, sha256Hex } from "./ledger";
import { classifyMerge, MergeConflict, MergePlan } from "./merge";
import { coreSettingsIds, SELF_GROUP_NAME } from "./catalog";
import { isPlainObject, keyMatchesAny } from "./sanitize";
import { readPerItemArray, scopeOf } from "./perItem";
import { addForceOn, applySwitchList, captureSwitchList, localRealPath, memberUniverse, parseSwitchList, readLocalSwitchList, subtractForceOff, SWITCH_LIST_GROUPS, SwitchList, switchListsEqual, writeLocalSwitchList } from "./switchList";

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
  switchExceptions: Record<string, string[]>; // group name -> masked member ids (This-device ∪ scoped-away ∪ auto-derived)
  switchForceOff?: Record<string, string[]>; // group name -> ids forced off on apply (user class scope on the wrong device class, or a never-here rule)
  switchForceOn?: Record<string, string[]>; // group name -> ids forced on on apply (an always-here rule; see normalizeMemberRule's mask table)
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
// either — and neither is a mode:"encrypted" group, which owns whole-file encryption the same
// way FileRule does and must never be demoted to plaintext fields mode.
export function withContractLocals(group: SyncGroup, contractLocalPatterns: string[]): SyncGroup {
  if (contractLocalPatterns.length === 0) return group;
  if (group.fileRule !== undefined || group.mode === "encrypted") return group;
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
  if (g.type !== "file") return { name: g.name, itemRel: inner.slice(sp.length + 1) };
  // A per-device sidecar shares its group's main file name — label it apart, or the remote
  // pane and pull reports show two identical "app.json" rows with no way to tell which one
  // carries the device-scoped values.
  const m = inner.slice(sp.length).match(/^\.__scopes__\.(desktop|mobile)\.json$/);
  const label = basename(sp);
  return { name: g.name, itemRel: m === null ? label : `${label} · ${m[1]} values` };
}

function excFor(ctx: CoreContext, name: string): string[] {
  return SWITCH_LIST_GROUPS.has(name) ? (ctx.switchExceptions[name] ?? []) : [];
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

// Restricts a force-on/off mask (Task 2's always-here/never-here table) to the run's staged
// members: unrestricted when `stagedMembers` is undefined (today's whole-run mask behavior,
// unchanged), otherwise only ids also named in `stagedMembers` — an unstaged member's switch
// must never move, including via a force mask (fix to review finding on task 3: `stagedMembers:
// []` must mean zero switch flips even when a force-on/off mask is active for the group).
function scopedMask(mask: string[], stagedMembers?: string[]): string[] {
  return stagedMembers === undefined ? mask : mask.filter((id) => stagedMembers.includes(id));
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
// file write (spec 2026-08-05-onoff-apply-runtime-design.md): core and community plugins. The
// third switch-list carrier, "enabled-css-snippets", has no per-id runtime hook — it hot-applies
// through the appearance-family pass below instead (spec
// 2026-08-06-batch2-scroll-and-appearance-hotapply-design.md).
const RUNTIME_SWITCH_GROUPS: ReadonlySet<string> = new Set(["core-plugins", "community-plugins"]);

// A carrier's memberLabels for its CURRENT store-list members, MERGED additively with what was
// already known (review fix, 2026-08-09-c-livetest-batch15): community ids resolve through the
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
// re-applies in one pass (spec 2026-08-06-batch2-scroll-and-appearance-hotapply-design.md).
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
      r.messages.push(`appearance hot-apply failed — reload the app to see the applied appearance: ${message}`);
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
// governed exclusively by the perItem machinery (capturePerItemArray/applyPerItemArray), never by
// this top-level guard, even when a stray FieldRule pattern also happens to match its key name —
// so stripPatterns is filtered through the same excludingPerItem exclusion the strip paths use,
// or a legitimate perItem key would permanently flag the base as stale (round-2026-08-05 fix). No-op
// when the group has no local patterns, or the existing content isn't a parseable JSON object.
export function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = excludingPerItem(effGroup, stripPatterns(effGroup));
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

// Refreshes every locally-resolvable lock entry's label in place (2026-08-08-c-livetest-batch6
// task-1) — capture only resolves a label for the groups it actually processes (:454/:477
// above), so an entry born on an older lock, or carried forward untouched by a partial-selection
// run, stays label-less forever without a dedicated heal. Called at the tail of every capture run
// and once at startup (main.ts). Never touches capturedAt or entries this vault can't resolve
// (an uninstalled plugin, an orphaned/dropped group) — returns whether anything changed, so a
// caller with nothing to do skips the write.
// carrierLists: the CURRENT store content for the two carriers (post any write this same run
// already made), pre-read by the caller so this function itself stays synchronous/IO-free and
// directly unit-testable (see tests/core.test.ts) — readCarrierSwitchLists below is the shared
// reader both call sites (main.ts startup, capture's own tail call) use to build it.
// excluded (C-#45, spec 2026-08-10-c-livetest-batch22-device-optout.md §4): group names THIS
// device has opted out of — the heal must not resurrect/write their lock entry either, exactly
// like it must not re-capture their content. Optional/defaults to none so every pre-existing
// caller (including every direct backfillLockLabels test) is unaffected.
export function backfillLockLabels(
  groups: SyncGroup[],
  plugins: PluginHost,
  lock: StoreLock,
  carrierLists: Record<"core-plugins" | "community-plugins", SwitchList | null>,
  excluded?: ReadonlySet<string>
): boolean {
  // §4.3, and the fourth lock writer (round-4 review N1): the heal's caller rewrites the whole
  // file from this object, so a lock from a newer build must not be mutated here at all. The gate
  // lives on the MUTATION rather than on the caller because the two callers differ: main.ts's
  // startup heal writes only when this returns true, so refusing the mutation refuses that write;
  // capture discards the boolean and writes unconditionally, and is safe instead because capture
  // gates the local lock itself before it touches anything (see its own §4.3 check). Startup is
  // the case that needs this one — it runs with no user action behind it and, unlike the §4.2
  // case, with a data.json this build reads perfectly, so `schemaStop` is null and round 1's guard
  // says nothing. Deliberately NOT left to §3.1's carrying parser to make the round trip lossless:
  // that would rest the invariant on the parser instead of on the gate, which is the argument
  // §3.1 exists to make.
  if (storeLockVersion(lock) > STORE_LOCK_VERSION) return false;
  let changed = false;
  for (const group of groups) {
    if (excluded?.has(group.name) === true) continue;
    const entry = lock.groups[group.name];
    if (entry === undefined) continue;
    const pluginId = pluginIdForGroup(group);
    // Same restriction as the capture-time resolver above: only the canonical "plugin-<id>"
    // group carries the community label, never a companion dir or a custom rule on a plugin path.
    const label =
      pluginId !== null && group.name === `plugin-${pluginId}`
        ? plugins.getInstalledPluginName(pluginId)
        : coreSettingsIds().has(group.name)
          ? plugins.getCorePluginName(group.name)
          : null;
    if (label === null || entry.label === label) continue;
    lock.groups[group.name] = { ...entry, label };
    changed = true;
  }
  // memberLabels heal (2026-08-09-c-livetest-batch15): MERGED with the existing map every call
  // (carrierMemberLabels' own doc comment) — same write-only-on-change guarantee as the label
  // loop above, but a name this device can't resolve locally is carried forward from the
  // existing entry rather than dropped, so a heal on one device never erases a name only another
  // device could resolve. A newly installed member's name still refreshes; an id no longer in the
  // current store list is still dropped.
  for (const carrier of ["core-plugins", "community-plugins"] as const) {
    const entry = lock.groups[carrier];
    if (entry === undefined) continue;
    const memberLabels = carrierMemberLabels(carrier, carrierLists[carrier], plugins, entry.memberLabels);
    if (Object.keys(memberLabels).length === 0 || memberLabelsEqual(entry.memberLabels, memberLabels)) continue;
    lock.groups[carrier] = { ...entry, memberLabels };
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
    throw new Error(`Unknown config-sync group "${name}" — not defined in plugin settings`);
  }
  return group;
}

export async function capture(
  ctx: CoreContext,
  names?: string[],
  onProgress?: ProgressFn,
  stagedMembersByName?: Record<string, string[] | undefined>,
  // C-#45 (spec §4): forwarded verbatim to the tail heal below — see backfillLockLabels' own
  // `excluded` doc comment. Optional/defaults to none; every pre-existing caller is unaffected.
  optedOutForHeal?: ReadonlySet<string>
): Promise<GroupResult[]> {
  const manifest = await loadManifest(ctx);
  // §4.3, the STORE side of the gate (task-3 review I3): the local store lives inside the vault,
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
    previous = lockRaw === null ? null : parseStoreLock(lockRaw);
  } catch {
    previous = null;
  }
  const selected = names === undefined ? null : new Set(names);
  const toProcess = manifest.groups.filter((g) => selected === null || selected.has(g.name));
  const groups: StoreLock["groups"] = {};
  // A captured group's entry (§6): this build's own fields, computed fresh, laid over the part of
  // the previous entry this build does not write. The rebuild used to be a bare literal, which
  // stripped every field a NEWER build had recorded and republished the loss to the fleet on the
  // next push — task-2 finding I-1, and the reason §3.1's carrying parser alone is theatre. The
  // known fields are still REPLACED rather than merged: dropping `desktopOnly` when a plugin stops
  // being desktop-only, or `label` when it can no longer be resolved, is deliberate. `hash` is
  // omitted (never blanked) when captureGroup could not fingerprint the group's store copy.
  //
  // Key ORDER matches what parseStoreLock re-emits — known fields, then the v2 pair, then the tail.
  // That is the whole point of the parser's fixed order (see its own comment): the lock is a file in
  // a vault that other tools sync and version, so a capture and a parse-then-write of the same entry
  // must produce the same bytes or every round trip churns the vault's history.
  const capturedEntry = (name: string, own: StoreLockEntry, hash: string | null): StoreLockEntry => {
    const entry: StoreLockEntry = { ...own, capturedAt: ctx.now() };
    if (hash !== null) entry.hash = hash;
    return { ...entry, ...lockEntryTail(previous?.groups[name]) };
  };
  const results: GroupResult[] = [];
  // Computed ONCE for the whole run (never per group) — the store contract's `local` field
  // patterns, unioned into each group before it reaches captureGroup (Fix B, see
  // withContractLocals/readStoreContractLocals above).
  const contractLocals = await readStoreContractLocals(ctx);
  let done = 0;
  for (const group of manifest.groups) {
    if (selected !== null && !selected.has(group.name)) {
      const prev = previous?.groups[group.name];
      if (prev !== undefined) groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // not captured this run — carry forward
      continue;
    }
    onProgress?.(done, toProcess.length, group.name);
    const { result, storeHash } = await captureGroup(ctx, withContractLocals(group, contractLocals.get(group.name) ?? []), stagedMembersByName?.[group.name]);
    done++;
    const pluginId = pluginIdForGroup(group);
    if (pluginId !== null) {
      if (result.status !== "error") {
        const version = ctx.plugins.getInstalledPluginVersion(pluginId);
        if (version !== null) {
          // Only the canonical "plugin-<id>" group is the community label's home — a companion
          // dir (path `{configDir}/plugins/<id>`, group name = folder basename) or a custom rule
          // scoped to a plugin path also resolves a pluginId here but must never carry the label,
          // or displayLabelForGroup's storedLabel-?? -name fallback renders it as "Name › Name".
          const label = group.name === `plugin-${pluginId}` ? ctx.plugins.getInstalledPluginName(pluginId) : null;
          const entry = ctx.plugins.isDesktopOnly(pluginId)
            ? { sourcePluginVersion: version, desktopOnly: true }
            : { sourcePluginVersion: version };
          groups[group.name] = capturedEntry(group.name, label !== null ? { ...entry, label } : entry, storeHash);
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
        if (prev !== undefined) groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins); // errored capture keeps the last known version
      }
    } else if (result.status !== "error") {
      // Only core-plugin groups (daily-notes, templates, …) resolve to a runtime name — Obsidian
      // cards (app/appearance/hotkeys…) and switch-list carriers have none to record.
      const label = coreSettingsIds().has(group.name) ? ctx.plugins.getCorePluginName(group.name) : null;
      const entry = { sourceAppVersion: ctx.plugins.getAppVersion() };
      groups[group.name] = capturedEntry(group.name, label !== null ? { ...entry, label } : entry, storeHash);
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
    if (!registryNames.has(name)) groups[name] = entry;
  }
  // §6: the top-level stamp is DERIVED from the entries now, not from the clock — it says how fresh
  // this store's content is, and a capture that touched two items must not claim the rest were
  // captured with them. A full capture still lands on ctx.now(), because every entry carries it.
  const capturedAt = derivedLockCapturedAt(groups, [], ctx.now());
  // Field order follows parseStoreLock's, for the same byte-stability reason as the entries above:
  // the parser emits `capturedAt`, `groups`, then the carried tail — and `version`/`syncedWatermark`
  // ride that tail (they are read through narrowing helpers, never validated in).
  const lock: StoreLock = {
    // §6: the top-level stamp is DERIVED from the entries now, not taken from the clock.
    capturedAt,
    groups,
    // §4.3: every lock this build writes declares its format version, so a build that gains a new
    // lock field can tell "written before that field existed" from "written by something newer".
    version: STORE_LOCK_VERSION,
    // Lineage, not freshness: only a pull moves the watermark (§6). A capture that bumped it would
    // tell every other device "I have seen a state newer than yours" on the strength of a purely
    // local change, which is the false "the store has newer settings" this release is removing. A
    // store that has never pulled starts its own lineage at its own capture time.
    syncedWatermark: previous !== null ? lockWatermark(previous) : capturedAt,
    // The lock's own unknown TOP-LEVEL keys (§6, task-2 finding I-1): capture rewrites the whole
    // file, so without this a field a newer build recorded at the top level is stripped here.
    ...lockTail(previous),
  };
  // Tail heal (see backfillLockLabels doc comment): catches every locally-resolvable entry this
  // run didn't itself capture a label for, carried-forward or otherwise — including a carrier's
  // own memberLabels, which this same call writes fresh from the store content this run just
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
// (spec §6: leave the value absent rather than emit one that cannot match).
function storeContentIsHashable(group: SyncGroup): boolean {
  return !groupNeedsPassphrase(group) && !isWholeFileEncrypted(group);
}

const DEVICE_CLASSES = ["desktop", "mobile"] as const;

// One file group's WHOLE store copy: the base file and the per-device-class sidecars beside it.
// A sidecar is store content like any other — it holds a class's shared values, it travels with the
// store, and it genuinely changes — so a hash that saw only the base would let two stores differing
// only in a sidecar read as identical (review N2). That is a false NEGATIVE, and the comparison now
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
    // Switch lists take the switch path whether or not exceptions exist — the old exc.length
    // guard left exception-free devices writing local enable-order into the store (2026-07-17).
    const localSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? readLocalSwitchList(group.name, plainLocalContent) : null;
    // Pass-through (甲): excluded ids copy the store's existing state, so read it first.
    let existingStoreList: SwitchList | null = null;
    if (localSwitchList !== null && (await ctx.io.exists(store))) {
      existingStoreList = parseSwitchList(await ctx.io.read(store));
    }
    const runExc = localSwitchList !== null ? runExceptions(ctx, group.name, existingStoreList, localSwitchList, stagedMembers) : exc;
    const captureInput = localSwitchList !== null ? serializeSwitchList(captureSwitchList(localSwitchList, existingStoreList, runExc)) : plainLocalContent;
    const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
    const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
    const effGroup = overlayGroup(ctx, group, [plainLocalContent]);
    // Prior store content: needed for perItem keys (spec §3, D3 — capturing a per-item array must
    // preserve the other device's already-captured elements) and, since C-#36, so captureTransform
    // can reuse an unchanged encrypted field's existing envelope instead of re-encrypting it —
    // never needed for groups with neither, but harmless to read either way (see captureTransform's
    // storeContent doc comment; a switch-list group's real store read already happened above).
    const priorStoreContent = localSwitchList === null && (await ctx.io.exists(store)) ? await ctx.io.read(store) : null;
    const t = await captureTransform(effGroup, captureInput, ctx.passphrase, ctx.deviceClass, priorStoreContent, existingSidecar);
    if (t.note !== null) result.messages.push(t.note);
    await writeClassified(ctx, store, t.content, basename(store), result, async (existing) => {
      if (localSwitchList !== null) {
        const existingSwitchList = parseSwitchList(existing);
        if (existingSwitchList !== null) return switchListsEqual(localSwitchList, existingSwitchList, runExc);
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
    // Base AND both sidecars (see fileStoreCopyHash). The own-class one is what this run just wrote —
    // `t.ownScope` null means it was deleted, i.e. absent; the other class's is read as it stands,
    // which is exactly what the store holds and what another device would hash.
    let storeHash: string | null = null;
    if (storeContentIsHashable(effGroup)) {
      const sidecars: Record<"desktop" | "mobile", string | null> = { desktop: null, mobile: null };
      for (const cls of DEVICE_CLASSES) {
        if (SWITCH_LIST_GROUPS.has(group.name)) break; // switch lists never carry sidecars (see the write above)
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
      const t = await captureTransform(group, plainLocalContent, ctx.passphrase, ctx.deviceClass);
      await writeClassified(ctx, target, t.content, rel, result, (existing) =>
        contentUnchanged(group, plainLocalContent, existing, ctx.passphrase, ctx.deviceClass, null)
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
  // Partial-selection switch staging (Sync Center unified grammar, task 3): for a switch-list
  // group, restricts which members this run touches — members not named here keep their local
  // value. Absent = today's whole-list behavior.
  stagedMembers?: string[];
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
        // fallbackMsgs was already reported via the object above's `messages` field — applyWithActions
        // pushes that unconditionally before finish ever runs (skipConfig-false path), so repeating it
        // here would render the fallback line twice (live evidence 2026-08-09, C-#35).
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

// Capture-side policy (spec 2026-07-17): a disabled plugin whose settings flow device→store
// can still be turned on as part of the run. Enabling has no ordering constraint against the
// capture, so it runs after — keeping the report sequence natural.
export interface CaptureItem {
  name: string;
  action: "enable" | "none";
  // Partial-selection switch staging (Sync Center unified grammar, task 3): for a switch-list
  // group, restricts which members this run touches — members not named here keep their store
  // value. Absent = today's whole-list behavior.
  stagedMembers?: string[];
}

// Runner-level payload guard (C-#45, spec 2026-08-10-c-livetest-batch22-device-optout.md §4): an
// opted-out group cannot enter a capture/apply payload, even given a stale selection — called at
// the host boundary (main.ts) before a CaptureItem[]/ApplyItem[] ever reaches captureWithActions/
// applyWithActions, so this is enforcement below the UI's own stageable:false, not a duplicate of
// it. Pure and generic over both item shapes (they share only `name`).
export function excludeOptedOutItems<T extends { name: string }>(items: T[], optedOut: ReadonlySet<string>): T[] {
  return items.filter((i) => !optedOut.has(i.name));
}

export async function captureWithActions(
  ctx: CoreContext,
  items: CaptureItem[],
  onProgress?: ProgressFn,
  // C-#45 (spec §4): forwarded verbatim to capture()'s own tail-heal guard. Optional/defaults to
  // none; every pre-existing caller is unaffected.
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

// Cold-bootstrap ordering (spec C §3): a staged batch can contain BRAT itself (a catalog
// install) alongside BRAT-managed plugins (installed via installViaBrat, which requires BRAT to
// already be on disk). Community plugin group names are "plugin-<id>" (pluginIdForGroup's
// convention); a name outside it never carries a BRAT-delegated install, so it always sorts into
// the catalog-first bucket. Stable: each bucket preserves the input's relative order.
export function orderInstallsCatalogFirst(names: string[], isBrat: (pluginId: string) => boolean): string[] {
  const bratManaged = (name: string): boolean => name.startsWith("plugin-") && isBrat(name.slice("plugin-".length));
  return [...names.filter((n) => !bratManaged(n)), ...names.filter((n) => bratManaged(n))];
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
    result.messages.push(`store has no data for this group (expected at ${store}) — capture it from the source vault first`);
    return result;
  }
  // Version gate, BEFORE the write (spec 2026-08-11-data-model-hardening.md §4.2, invariant II.3).
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
      const storeSwitchList = SWITCH_LIST_GROUPS.has(group.name) ? parseSwitchList(storeContent) : null;
      let content: string;
      let delta: { on: string[]; off: string[] } | null = null;
      if (storeSwitchList !== null) {
        const localSwitchList = localContent !== null ? readLocalSwitchList(group.name, localContent) : null;
        const runExc = runExceptions(ctx, group.name, storeSwitchList, localSwitchList, stagedMembers);
        const merged = applySwitchList(storeSwitchList, localSwitchList, runExc);
        const afterOff = subtractForceOff(merged, scopedMask(ctx.switchForceOff?.[group.name] ?? [], stagedMembers));
        const finalList = addForceOn(afterOff, scopedMask(ctx.switchForceOn?.[group.name] ?? [], stagedMembers));
        content = writeLocalSwitchList(group.name, finalList, localContent);
        // Name the plugins this write toggles (spec 2026-07-17): a store list lacking a
        // just-enabled plugin turns it off persistently — that must be visible in the report.
        delta = switchDelta(localSwitchList, finalList);
        for (const line of switchDeltaMessages(delta)) result.messages.push(line);
      } else {
        const sidecarPath = store + sidecarStoreSuffix(ctx.deviceClass);
        const existingSidecar = (await ctx.io.exists(sidecarPath)) ? await ctx.io.read(sidecarPath) : null;
        const effGroup = overlayGroup(ctx, group, [storeContent, localContent, existingSidecar]);
        content = await applyTransform(effGroup, storeContent, localContent, ctx.passphrase, ctx.deviceClass, existingSidecar);
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
  // §4.3: refused here, before a single remote file is read into a plan — a store whose lock comes
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
  // §4.3 on the writer itself: planImport already refused a newer REMOTE, but applyImport is the
  // half that writes, and the gate belongs on the write rather than on the caller's discipline.
  assertStoreLockVersionUnderstood(remoteLockRaw);
  // And on the lock this merge is about to REPLACE — the local one (task-3 review I3). A v3 lock
  // reaches this store through ordinary vault sync, with no pull involved, so "the remote is old
  // enough" says nothing about what is already here. planImport refuses this too, so the user is
  // never asked to resolve conflicts for a pull that cannot happen — but the planner is a
  // courtesy and this is the guarantee: a check that lived only on the courtesy path would quietly
  // stop covering the next caller that reaches applyImport directly. Read before the first file is
  // written; the parse below reuses it, so the merge sees exactly the bytes this gate checked.
  const localLockRaw = (await ctx.io.exists(lockPath(ctx))) ? await ctx.io.read(lockPath(ctx)) : null;
  assertStoreLockVersionUnderstood(localLockRaw);
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

  // Parsed from the same bytes the version gate above read — no second read, and no window in
  // which the file could differ from what was checked.
  const localLock = localLockRaw !== null ? parseStoreLock(localLockRaw) : null;
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
    const adoptedNames = new Set<string>();
    if (remoteLock !== null) {
      for (const [name, entry] of Object.entries(remoteLock.groups)) {
        if (pending.excludeSelf && name === SELF_GROUP_NAME) continue;
        if (localWonNames.has(name)) continue;
        // The remote's entry wins every field it HAS — the content is now the remote's, so its
        // versions, capture time and hash describe it. But a key only OUR entry carried is not the
        // remote's to delete: dropping it is the same loss as the top-level strip, one level down,
        // and keeping it is convergence-safe because the comparison only ever weighs keys present on
        // BOTH sides. (`lockEntryTail` excludes everything this build writes itself, so a stale
        // local `hash` can never survive underneath the adopted entry.)
        const carried = lockEntryTail(localLock?.groups[name]);
        for (const key of Object.keys(entry)) delete carried[key];
        mergedGroups[name] = { ...entry, ...carried };
        adoptedNames.add(name);
      }
    }
    // A pull that WROTE a group's files changed that group's store content, and an entry we did not
    // take from the remote — a group the user kept as "local" whose remote-only files still landed,
    // or one the remote's lock never described — would otherwise keep describing what was there
    // before. That is the one real counterexample to "only a capture changes store content, and a
    // capture re-dates what it captured" (review N1), and the items-first comparison now leans on
    // that claim: an equal hash is believed outright, so a stamp that outran its content is exactly
    // the thing that must not exist. Entries ADOPTED from the remote are deliberately left alone —
    // they describe bytes we copied verbatim, and rewriting them is what would break the convergence
    // a pull exists to produce.
    const groupByName = new Map([...remoteGroups, ...groups].map((g) => [g.name, g] as const));
    for (const [name, r] of byName) {
      const existing = mergedGroups[name];
      if (!hasChanges(r.changes) || existing === undefined || adoptedNames.has(name)) continue;
      const group = groupByName.get(name);
      if (group === undefined) continue;
      const hash = await storeCopyHashOnDisk(ctx, group);
      const restamped: StoreLockEntry = { ...existing, capturedAt: ctx.now() };
      if (hash === null) delete restamped.hash;
      else restamped.hash = hash;
      mergedGroups[name] = restamped;
    }
    // Field order follows parseStoreLock's (see capture's own note): capturedAt, groups, then the
    // carried tail, with version/syncedWatermark riding that tail.
    const merged: StoreLock = {
      // `capturedAt` describes THIS store's content: derived from the merged entries, floored at the
      // value it already had, because a pull is additive — it never removes content, so the store it
      // produces can never be older than the one it started from.
      capturedAt: derivedLockCapturedAt(
        mergedGroups,
        [localLock?.capturedAt],
        localLock?.capturedAt ?? remoteLock?.capturedAt ?? ctx.now()
      ),
      groups: mergedGroups,
      // Same rule as capture (§4.3): this build wrote this file, so it declares the format this
      // build writes — whichever version the two merged sides carried. Both are ≤ 2 by the time we
      // get here; a newer remote was refused above.
      version: STORE_LOCK_VERSION,
      // The pull is the ONLY writer that moves the watermark, and moving it is what makes
      // remoteLockAhead settle to false afterwards (§6). It records the remote's LINEAGE, not its
      // bare watermark: a remote that captured after its own last pull stands at its `capturedAt`,
      // and aligning to anything less would leave us permanently behind a state we just adopted.
      syncedWatermark: remoteLock !== null ? lockLineage(remoteLock) : localLock !== null ? lockWatermark(localLock) : ctx.now(),
      // Unknown TOP-LEVEL keys, from both sides (§6, task-2 finding I-1). The local lock's own keys
      // win a collision — we cannot merge two values whose meaning we do not know, and the file we
      // are writing is this store's — but a key only the remote carries is adopted rather than
      // dropped: pull-then-push through this build would otherwise strip a newer build's top-level
      // field from the remote, which is the very loss (S10) this release exists to stop.
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
  // §4.3, push side: refused before the first writeFile — pushing this build's store over a remote
  // written by a newer one would overwrite a shape we cannot read with one it cannot read back.
  if (remoteFiles.has(LOCK_REL)) assertStoreLockVersionUnderstood(await writer.readFile(LOCK_REL));
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
