import { baseHasStaleLocalKeys, CoreContext, ExternalStoreReader, fieldExceptionsFor, groupForStoreRel, loadManifest, overlayGroup, readStoreContractLocals, remoteDeclaresStore, remoteGroupsFrom, remoteStoreContentRels, skipRelPredicate, storeDir, withContractLocals } from "./ConfigSyncCore";
import { isJunkPath, listFilesRecursive } from "./io";
import { basename, groupStorePath, relativeTo, sidecarStoreSuffix } from "./pathing";
import { FileChanges, hasChanges, ItemRef, itemRef, StoreLock, StoreLockEntry, SyncGroup } from "./types";
import { carrierRef, joinRef } from "./itemKeys";
import { lockEntry, lockEntryCapturedAt, lockEntryHash, lockEntryList, lockLineage, parseStoreLock, storeLockVersion, STORE_LOCK_VERSION } from "./manifest";
import { isPlainObject } from "./sanitize";
import { contentUnchanged, groupNeedsPassphrase } from "./modes";
import { parseFileEnvelope } from "./crypto";
import { localRealPath, parseSwitchList, readLocalSwitchList, isSwitchListGroup, switchListsEqual } from "./switchList";
import { ABSENT_HASH, BaselineEntry, hashDirSide, hashFileSide, Ledger, LedgerUpdates } from "./ledger";

export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured" | "never-synced" | "no-settings" | "locked";

export interface GroupStatus {
  group: string;
  state: GroupState;
  message?: string; // present when the comparison itself failed
  changes?: FileChanges;
}

type Comparison = "not-captured" | "no-settings" | { changes: FileChanges; localHash: string; storeHash: string; staleLocal: boolean };

export async function statusForGroups(
  ctx: CoreContext,
  groups: SyncGroup[],
  ledger: Ledger
): Promise<{ statuses: GroupStatus[]; updates: LedgerUpdates }> {
  const statuses: GroupStatus[] = [];
  const updates: LedgerUpdates = {};
  // Computed ONCE for the whole run — same seam as capture() (Fix B): the SAME augmented group
  // that fed capture's strip must feed comparison's strip too, or a captured-in-sync group would
  // read as changed forever (contentUnchanged would strip using only the local rule).
  const contractLocals = await readStoreContractLocals(ctx);
  for (const group of groups) {
    try {
      const effGroup = withContractLocals(group, contractLocals.get(group.name) ?? []);
      // Keyed by the item's ref, not by the group name: the baselines, the lock and the
      // opt-out list are ONE key space. A group with no ref has no identity to hold a baseline by,
      // so it compares without one — which is what it always did before it had an entry at all.
      const r = await groupStatus(ctx, effGroup, group.ref === undefined ? undefined : ledger.items[group.ref]);
      statuses.push(r.status);
      if (r.update !== undefined && group.ref !== undefined) updates[group.ref] = r.update;
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
  if (cmp.staleLocal) {
    // The store base holds a top-level scope:"local" key it must never carry (2.14.1's
    // baseHasStaleLocalKeys). The group is otherwise in-sync — contentUnchanged strips the key on
    // both sides — so it would read in-sync forever, the UI would never offer it for capture, and
    // the capture-time purge guard would never run. Surface it as local-changed (a capture
    // direction) so a capture is offered; that capture purges the base, and the next scan finds it
    // clean and returns to in-sync. No baseline reseed — this is a dirty state, not a synced one.
    return { status: { group: group.name, state: "local-changed", changes: cmp.changes } };
  }
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
    return { changes: { added: [], updated: [], deleted: [name] }, localHash: ABSENT_HASH, storeHash, staleLocal: false };
  }
  const liveContent = await ctx.io.read(real);
  const localHash = await hashFileSide(group.name, liveContent, "local");
  const exc = isSwitchListGroup(group.name) ? ctx.switchExceptions[group.name] ?? [] : [];
  // Switch lists ALWAYS compare as sets — exceptions or not. The old `exc.length > 0` guard
  // made exception-free devices fall through to byte comparison, where local enable-order vs
  // store-stable order reads as a permanent phantom "To capture" (real-vault find 2026-07-17).
  const switchEqual =
    isSwitchListGroup(group.name) ? switchListEqualOrNull(group.name, liveContent, storeContent, exc) : null;
  const sidecar = store + sidecarStoreSuffix(ctx.deviceClass);
  const ownScope = (await ctx.io.exists(sidecar)) ? await ctx.io.read(sidecar) : null;
  const effGroup = overlayGroup(ctx, group, [liveContent, storeContent, ownScope]);
  const equal =
    switchEqual !== null
      ? switchEqual
      : parseFileEnvelope(storeContent) !== null || effGroup.mode === "fields" || effGroup.mode === "encrypted"
        ? await contentUnchanged(effGroup, liveContent, storeContent, ctx.passphrase, ctx.deviceClass, ownScope, fieldExceptionsFor(ctx, effGroup))
        : liveContent === storeContent;
  const staleLocal = equal && baseHasStaleLocalKeys(effGroup, storeContent);
  const changes: FileChanges = equal
    ? staleLocal
      ? { added: [], updated: [name], deleted: [] } // surface the store's stray local key as to-capture
      : { added: [], updated: [], deleted: [] }
    : { added: [], updated: [name], deleted: [] };
  return { changes, localHash, storeHash, staleLocal };
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
  return { changes, localHash: await hashDirSide(liveEntries), storeHash: await hashDirSide(storeEntries), staleLocal: false };
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

// `ignoreRefs` names lock entries that never count, exactly as in remoteLockAhead — callers pass
// the items this remote does not pull (remoteRules.ts's refsBlockedFor). It is REQUIRED, not defaulted: the per-item
// path below resolves a direction from every entry it sees, so a forgotten argument would read the
// self entry of a remote that deliberately never exchanges it and pin an arrow no Pull could ever
// clear. The whole-store fallback has no per-entry granularity and is unaffected either way.
// `groups` re-keys a remote still on the v1/v2 lock format against what THIS device compiles — a
// remote written by a 2.21.0 device is the normal state during the transition, and an entry keyed
// differently on the two sides would read as an item we do not have, i.e. a pull that never settles.
export async function checkRemote(
  localLock: StoreLock | null,
  reader: ExternalStoreReader,
  ignoreRefs: string[],
  groups?: readonly SyncGroup[]
): Promise<RemoteCheck> {
  const files = await reader.listFiles();
  // Store presence, asked as one question. With no lock there is nothing to compare either way,
  // so all that is left to decide is whether this remote is EMPTY — the first-push target, and the
  // sole case that reports no-store — or merely uncomparable: content, or a legacy manifest
  // declaring a store this build still pulls the old way. Both halves come from the same two
  // producers the pull/push gate uses, so a remote that gate refuses can never read here as an empty
  // one inviting the push it would then decline (the rule the version gate already follows for a future lock).
  if (!files.includes("store.lock.json")) {
    const empty = !remoteDeclaresStore(files) && remoteStoreContentRels(files).length === 0;
    return { state: empty ? "no-store" : "unknown", remoteCapturedAt: null };
  }
  let remote: StoreLock;
  try {
    remote = parseStoreLock(await reader.readFile("store.lock.json"), groups);
  } catch {
    return { state: "unknown", remoteCapturedAt: null };
  }
  // A remote this build cannot read must not look ACTIONABLE. The version gate
  // refuses the pull itself, but a refusal the user only meets after accepting an invitation is a
  // worse surface than never being invited: "unknown" already means "this remote cannot be
  // compared", which is exactly true here. No new RemoteState, no UI change. The capture stamp is
  // still reported — it parsed, and saying WHEN is not the same as inviting a pull.
  if (storeLockVersion(remote) > STORE_LOCK_VERSION) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  // No local lock yet (bootstrap device) but the remote parsed fine: a pull would populate
  // the store, so this is a known state, not "unknown" — reserve that for unreadable remotes.
  if (localLock === null) return { state: "remote-newer", remoteCapturedAt: remote.capturedAt };
  const perItem = perItemRemoteState(localLock, remote, ignoreRefs);
  if (perItem !== null) return { state: perItem, remoteCapturedAt: remote.capturedAt };
  const r = Date.parse(remote.capturedAt);
  const l = Date.parse(localLock.capturedAt);
  if (Number.isNaN(r) || Number.isNaN(l)) return { state: "unknown", remoteCapturedAt: remote.capturedAt };
  const state: RemoteState = r > l ? "remote-newer" : r < l ? "remote-older" : "same";
  return { state, remoteCapturedAt: remote.capturedAt };
}

// Entry fields that are never a DIFFERENCE. `display` is names: a plugin renamed on one device must
// not read as "the store has newer settings" (finding S6) — and since v3 puts the label and the
// carrier's element names in one partition, saying so is one key instead of a list that has to grow
// with every display field. `capturedAt` is freshness, not content — it orders two differing entries
// below instead of being one more thing that differs, or every capture would make every other device
// look behind.
const NON_CONTENT_LOCK_ENTRY_KEYS = new Set(["display", "capturedAt"]);

// Deep equality that does not care about key order. Written out rather than done with
// JSON.stringify because the carried tail can hold anything a newer build wrote, and two
// devices that emit the same object in a different order hold the same value — stringifying would
// turn that into a permanent phantom "the remote is ahead".
function lockValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => lockValuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && lockValuesEqual(a[k], b[k]));
  }
  return false;
}

// Do these two entries describe the same store content? Only keys present on BOTH sides count
// (the mixed-fleet rule): an un-updated device strips `version`/`capturedAt`/`hash` every
// time it pulls, and the next capture here writes them back — comparing keys only one side has
// would surface that churn as a false "the store has newer settings" until the last device is
// updated. A key on both sides with different values is a difference, exactly as before.
function lockEntriesEquivalent(mine: StoreLockEntry, theirs: StoreLockEntry): boolean {
  for (const [key, value] of Object.entries(theirs)) {
    if (NON_CONTENT_LOCK_ENTRY_KEYS.has(key)) continue;
    if (!(key in mine)) continue;
    if (!lockValuesEqual(mine[key], value)) return false;
  }
  return true;
}

// "Remote has newer version info" — semantic, not byte, comparison of the two store locks
// (a byte compare would keep the hint alive forever, since a merged local lock keeps
// local-only entries and its own formatting). True when a remote group entry is missing locally, or
// when one differs and the remote's copy is the fresher of the two, or — only where the entries
// cannot settle it — when the remote's lineage is newer. Local-only entries and a locally-newer
// lineage never count: a pull would not change them. ignoreRefs names lock entries that never
// count (the self group when the remote excludes it).
export function remoteLockAhead(localRaw: string | null, remoteRaw: string | null, ignoreRefs: string[], groups?: readonly SyncGroup[]): boolean {
  if (remoteRaw === null) return false;
  if (localRaw === null) return true;
  let local: StoreLock;
  let remote: StoreLock;
  try {
    local = parseStoreLock(localRaw, groups);
    remote = parseStoreLock(remoteRaw, groups);
  } catch {
    return localRaw !== remoteRaw;
  }
  // The ITEMS answer first. A remote entry we do not have at all, or one that differs and was
  // captured later there than here, is a pull worth offering; anything the entries can settle, they
  // settle. (Without a per-item date, every difference would have to read as "ahead" —
  // and a purely local capture would light the hint up on every other device.)
  let compared = 0;
  let dated = 0;
  for (const [ref, entry] of lockEntryList(remote.items)) {
    if (ignoreRefs.includes(ref)) continue;
    const mine = lockEntry(local, ref);
    if (mine === undefined) return true;
    const freshness = itemFreshness(mine, entry);
    if (freshness === "newer" || freshness === "undatable") return true;
    compared++;
    // ORDERABLE on both sides, not merely present. A stamp `Date.parse` cannot read
    // dates nothing, and counting it would silence the timestamp path below on the strength of
    // evidence that could not itself have spoken. Absent and unreadable are the same fact here.
    if (entryTime(mine) !== null && entryTime(entry) !== null) dated++;
  }
  // Every remote entry was present here AND dated on both sides: the per-item evidence is complete,
  // and it says no. The store-level stamp must not then manufacture a difference the items
  // themselves deny — that is the mixed-fleet rule applied one level up, and it is the whole
  // reason this comparison is key-by-key instead of one timestamp. The stamp only gets to speak
  // where the items leave a gap: no entries at all, or one carried forward from a build that never
  // dated it.
  if (compared > 0 && dated === compared) return false;
  const l = Date.parse(lockLineage(local));
  const r = Date.parse(lockLineage(remote));
  return !Number.isNaN(l) && !Number.isNaN(r) && r > l;
}

// One item's freshness relative to the remote's copy of it. "undatable" = the two differ with no
// way to order them; "absent" = neither side recorded anything comparable. Both send the whole
// comparison back to the store-level timestamp rather than guessing.
type ItemFreshness = "equal" | "newer" | "older" | "undatable" | "absent";

// Does this lock carry the per-item evidence the comparison below needs? Asked of the PAYLOAD,
// never of the version number. A gate reading `storeLockVersion(…) <
// STORE_LOCK_VERSION` silently becomes "< 3" the moment the lock format moves — excluding
// every 2.21.0 peer for the whole transition window, even though those peers do stamp each entry,
// and reinstating exactly the phantom "the store has newer settings". A version
// comparison is a proxy for a capability; it goes stale as soon as the number moves.
function hasPerItemPayload(lock: StoreLock): boolean {
  return lockEntryList(lock.items).some(([, entry]) => lockEntryCapturedAt(entry) !== undefined);
}

// An entry's capture time as something we can ORDER by, or null. A non-empty stamp no date parser
// can read is not a date; it is treated as absent everywhere rather than as present-and-useless.
function entryTime(entry: StoreLockEntry): number | null {
  const ms = Date.parse(lockEntryCapturedAt(entry) ?? "");
  return Number.isNaN(ms) ? null : ms;
}

function itemFreshness(mine: StoreLockEntry | undefined, theirs: StoreLockEntry | undefined): ItemFreshness {
  if (mine === undefined && theirs === undefined) return "absent";
  if (mine === undefined) return "newer"; // only the remote has this item — a pull would bring it
  if (theirs === undefined) return "older"; // only we have it — a push would carry it
  const sameContent = lockEntriesEquivalent(mine, theirs);
  const l = entryTime(mine);
  const r = entryTime(theirs);
  if (l === null || r === null) return sameContent ? "equal" : "undatable";
  // A hash on BOTH sides settles it outright: the store copies are identical, so it does not matter
  // which device captured them later. Without one — an encrypted item, whose ciphertext differs
  // between devices holding the same settings and so is never fingerprinted — the capture time is
  // all there is, and a later capture is the fresher copy.
  const bothHashed = lockEntryHash(mine) !== undefined && lockEntryHash(theirs) !== undefined;
  if (sameContent && (bothHashed || l === r)) return "equal";
  return r > l ? "newer" : r < l ? "older" : "undatable";
}

// Per-item resolution for checkRemote: when BOTH locks carry the v2 payload, the state comes
// from the entries rather than from one whole-store timestamp — so a store that is merely older in
// wall-clock terms but holds the same items reads as "same". `ignoreRefs` drops entries that never
// count — without it a remote that withholds an item would resolve a direction from an entry the
// two sides deliberately never exchange, and no Pull could ever clear it. null = not decidable this
// way (either side still at v1, no entries left to compare, an undatable difference, or the two
// stores are ahead of each other in different items, which RemoteState has no word for); the caller
// then does exactly what it did before. Reads only the two locks already in hand — no extra file
// reads, as before.
function perItemRemoteState(local: StoreLock, remote: StoreLock, ignoreRefs: string[]): RemoteState | null {
  if (!hasPerItemPayload(local) || !hasPerItemPayload(remote)) return null;
  const refs = [...new Set([...lockEntryList(local.items), ...lockEntryList(remote.items)].map(([ref]) => ref))].filter((r) => !ignoreRefs.includes(r));
  if (refs.length === 0) return null;
  let newer = false;
  let older = false;
  for (const ref of refs) {
    const freshness = itemFreshness(lockEntry(local, ref), lockEntry(remote, ref));
    if (freshness === "undatable") return null;
    if (freshness === "newer") newer = true;
    else if (freshness === "older") older = true;
  }
  if (newer && older) return null;
  return newer ? "remote-newer" : older ? "remote-older" : "same";
}

// Item ref -> label for every remote lock entry carrying one (Sync Center remote pane, spec
// 2026-08-08-c-livetest-batch6): deliberately tolerant of anything short of a real parsed
// store.lock.json — an absent, malformed, or half-written remote lock must never break the compare,
// so this returns {} instead of throwing. Callers own the JSON.parse of the raw remote file (this
// takes the already-parsed value, hence `unknown` — see parseStoreLock's own `parsed: unknown` for
// the same reasoning), so a parse failure never reaches here at all.
//
// Keyed by REF, both shapes: a v3 lock is already keyed that way, and a v1/v2 one is converted
// through `toRef` — itemKeys.ts's lockRefFor, the same single producer the lock read itself uses, so
// a label and the entry it belongs to can never end up under two different keys.
export function remoteLockLabels(lockJson: unknown, toRef: (name: string) => string): Record<string, string> {
  if (!isPlainObject(lockJson)) return {};
  const v3 = isPlainObject(lockJson.items);
  const labels: Record<string, string> = {};
  const put = (ref: string, label: unknown): void => {
    if (typeof label === "string" && label.trim() !== "" && labels[ref] === undefined) labels[ref] = label;
  };
  // [ref, entry] pairs, from either shape. A v3 lock's two levels are joined back up; a v1/v2 one's
  // flat names go through the converter.
  const entries: [string, Record<string, unknown>][] = [];
  if (v3) {
    for (const [section, bucket] of Object.entries(lockJson.items as Record<string, unknown>)) {
      if (!isPlainObject(bucket)) continue;
      for (const [id, entry] of Object.entries(bucket)) if (isPlainObject(entry)) entries.push([joinRef(section, id), entry]);
    }
  } else if (isPlainObject(lockJson.groups)) {
    for (const [name, entry] of Object.entries(lockJson.groups)) if (isPlainObject(entry)) entries.push([toRef(name), entry]);
  }
  const labelOf = (entry: Record<string, unknown>): unknown => (v3 ? (isPlainObject(entry.display) ? entry.display.label : undefined) : entry.label);
  const elementsOf = (entry: Record<string, unknown>): unknown => (v3 ? (isPlainObject(entry.display) ? entry.display.elements : undefined) : entry.memberLabels);
  for (const [ref, entry] of entries) put(ref, labelOf(entry));
  // Carrier element-name fallback (2026-08-09-c-livetest-batch15, same chain position as
  // resolveHostStoredLabel's local one: after own-entry labels above, before the id fallback): a
  // remote-only on/off element with no entry of its own still gets a name from its carrier — never
  // overwriting a name already resolved from the element's own entry (put's own guard).
  for (const [carrier, section] of [["community-plugins", "community"], ["core-plugins", "core"]] as const) {
    const entry = entries.find(([ref]) => ref === carrierRef(carrier))?.[1];
    const elements = entry === undefined ? undefined : elementsOf(entry);
    if (!isPlainObject(elements)) continue;
    for (const [id, label] of Object.entries(elements)) put(itemRef(section, id), label);
  }
  return labels;
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

export async function diffRemote(ctx: CoreContext, reader: ExternalStoreReader, opts: { skipRefs: ItemRef[] }): Promise<RemoteDiffEntry[]> {
  const manifest = await loadManifest(ctx);
  const remoteFiles = await reader.listFiles();
  // A fresh device knows few or no groups yet, so attribution falls back to the REMOTE
  // manifest — otherwise every remote file would land in the metadata pseudo-group and the
  // whole delta would be dropped (the "contents match" false negative).
  const remoteGroups = await remoteGroupsFrom(ctx, reader, remoteFiles);
  const resolve = (rel: string): { name: string; itemRel: string } => {
    const local = groupForStoreRel(manifest.groups, rel);
    if (local.name !== "") return local;
    const remote = groupForStoreRel(remoteGroups, rel);
    if (remote.name !== "") return remote;
    // Only true bookkeeping (store.lock.json, legacy root manifests) lives outside store/.
    return rel.startsWith("store/") ? { name: OTHER_STORE_FILES_GROUP, itemRel: rel } : { name: "", itemRel: rel };
  };
  const skipped = skipRelPredicate(opts.skipRefs, manifest.groups, remoteGroups);
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
    if (!isSwitchListGroup(name)) return false;
    const a = parseSwitchList(remoteContent);
    const b = parseSwitchList(localContent);
    return a !== null && b !== null && switchListsEqual(a, b, []);
  };
  for (const rel of remoteFiles) {
    if (skipped(rel)) continue;
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
    if (skipped(rel)) continue;
    if (!remoteSet.has(rel)) {
      const { name, itemRel } = resolve(rel);
      entry(name).files.push({ itemRel, kind: "deleted", local: await ctx.io.read(`${ctx.rootPath}/${rel}`), remote: null });
    }
  }
  // The "" store-metadata pseudo-entry (lock + manifest bookkeeping) drifts on every capture;
  // it is not a difference worth reporting here. Pull/push REPORTS still show it.
  return [...byName.values()].filter((e) => e.group !== "" && e.files.length > 0);
}
