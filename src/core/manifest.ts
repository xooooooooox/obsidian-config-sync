import { DeviceClass, FieldRule, FileRule, PerItemScopes, Remote, RULE_SCOPES, StoreLock, StoreLockEntry, SyncGroup, SyncManifest, SyncMode } from "./types";
import { groupStorePath } from "./pathing";
import { isPlainObject, keyMatchesAny } from "./sanitize";
import { FileIO } from "./io";
import { PASSPHRASE_SECRET_ID } from "./secrets";

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

// A rule/group name's legal shape — also enforced at the companion-add/edit UI boundary (see
// registry.ts's companionNameConflict / itemCard.ts's validateCompanionBasename), so a basename
// that would fail parseGroup below is rejected before it ever reaches settings, not just at
// compile/validate time (final-review MUST-FIX 1: a persisted bad shape silently zeroes out
// compiledGroups on next launch — see main.ts's recompile).
export const GROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isValidType(v: unknown): v is "file" | "dir" {
  return v === "file" || v === "dir";
}

function isValidDevice(v: unknown): v is DeviceClass {
  return v === "all" || v === "desktop" || v === "mobile";
}

function isValidMode(v: unknown): v is SyncMode {
  return v === "plain" || v === "fields" || v === "encrypted";
}

function isValidFieldRule(v: unknown): v is FieldRule {
  return (
    isPlainObject(v) &&
    typeof v.pattern === "string" &&
    v.pattern !== "" &&
    (RULE_SCOPES as readonly unknown[]).includes(v.scope) &&
    typeof v.encrypted === "boolean" &&
    !(v.scope === "local" && v.encrypted === true) &&
    (v.locked === undefined || typeof v.locked === "boolean")
  );
}

function isValidFieldsArray(v: unknown): v is FieldRule[] {
  return Array.isArray(v) && v.every((f) => isValidFieldRule(f));
}

// Structural check only (spec §3, D3): every element scope must be a RULE_SCOPES value. Whether
// the key it's attached to is actually a string array at runtime is checked at capture time
// (perItem.ts's readPerItemArray) — it can't be verified statically from the manifest alone.
function isValidPerItemScopes(v: unknown): v is PerItemScopes {
  return isPlainObject(v) && Object.values(v).every((s) => (RULE_SCOPES as readonly unknown[]).includes(s));
}

function isValidPerItemMap(v: unknown): v is Record<string, PerItemScopes> {
  return isPlainObject(v) && Object.values(v).every((s) => isValidPerItemScopes(s));
}

// D9: Plain-mode file-level scope excludes "local" — derived from RULE_SCOPES (same
// anti-drift discipline as isValidFieldRule) rather than a second hand-written literal list.
const FILE_RULE_SCOPES = RULE_SCOPES.filter((s): s is Exclude<(typeof RULE_SCOPES)[number], "local"> => s !== "local");

function isValidFileRule(v: unknown): v is FileRule {
  return isPlainObject(v) && (FILE_RULE_SCOPES as readonly unknown[]).includes(v.scope) && typeof v.encrypted === "boolean";
}

export function parseSyncManifest(raw: string): SyncManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`config-sync.json is not valid JSON: ${(e as Error).message}`);
  }
  return validateSyncManifest(parsed);
}

export function validateSyncManifest(data: unknown): SyncManifest {
  if (!isPlainObject(data)) throw new ManifestValidationError("config-sync.json must contain a JSON object, e.g. {\"version\": 1, \"groups\": []}");
  if (data.version !== 1) {
    throw new ManifestValidationError(`config-sync.json has unsupported version ${String(data.version)} — this plugin version only supports "version": 1`);
  }
  if (!Array.isArray(data.groups)) throw new ManifestValidationError('config-sync.json "groups" must be a list of rules, e.g. "groups": [{"name": "hotkeys", ...}]');
  const groups = data.groups.map((g, i) => parseGroup(g, i));
  const names = new Set<string>();
  const storePaths = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new ManifestValidationError(`two rules are named "${g.name}" — rename one of them so each rule has a unique name`);
    names.add(g.name);
    const sp = groupStorePath(g.path);
    if (storePaths.has(sp)) {
      throw new ManifestValidationError(`rule "${g.name}" saves to the same store location as another rule ("${sp}") — give one of them a different path`);
    }
    storePaths.add(sp);
  }
  return { version: 1, groups };
}

function parseGroup(g: unknown, index: number): SyncGroup {
  if (!isPlainObject(g)) throw new ManifestValidationError(`rule #${index + 1} must be an object, e.g. {"name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all"}`);
  const { name, path, type, devices, sanitize, mode, fields, fileRule, perItem, description, label, origin } = g;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`rule #${index + 1} is missing a "name" — give it a short id, e.g. "name": "hotkeys"`);
  }
  if (!GROUP_NAME_RE.test(name)) {
    throw new ManifestValidationError(
      `rule "${name}" has an invalid name — use only letters, digits, "-" or "_", starting with a letter or digit, e.g. "my-plugin"`
    );
  }
  if (typeof path !== "string" || path === "") {
    throw new ManifestValidationError(`rule "${name}" is missing a "path" — point it at the file or folder to sync, e.g. "path": "{configDir}/hotkeys.json"`);
  }
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new ManifestValidationError(`rule "${name}" has path "${path}", which must stay inside the vault — use a relative path without "..", e.g. "{configDir}/hotkeys.json"`);
  }
  if (!isValidType(type)) {
    throw new ManifestValidationError(`rule "${name}" has "type": ${JSON.stringify(type)}, but it must be "file" or "dir"`);
  }
  if (!isValidDevice(devices)) {
    throw new ManifestValidationError(`rule "${name}" has "devices": ${JSON.stringify(devices)}, but it must be "all", "desktop" or "mobile"`);
  }
  if (sanitize !== undefined) {
    throw new ManifestValidationError(
      `"${name}" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see the sensitive-settings guide in docs/GUIDE.md).`
    );
  }
  let validatedMode: SyncMode | undefined;
  if (mode !== undefined) {
    if (!isValidMode(mode)) {
      throw new ManifestValidationError(`rule "${name}" has "mode": ${JSON.stringify(mode)}, but it must be "plain", "fields" or "encrypted"`);
    }
    if (mode === "fields" && type !== "file") {
      throw new ManifestValidationError(`rule "${name}" uses "mode": "fields", which is only supported on file groups — this rule has "type": "${String(type)}"`);
    }
    validatedMode = mode;
  }
  let validatedFields: FieldRule[] | undefined;
  if (fields !== undefined) {
    if (validatedMode !== "fields") {
      throw new ManifestValidationError(`rule "${name}" sets "fields" but not "mode": "fields" — add "mode": "fields" so the rule list takes effect`);
    }
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (isPlainObject(f) && f.scope === "local" && f.encrypted === true) {
          throw new ManifestValidationError(
            `rule "${name}" has a field rule for key ${JSON.stringify(f.pattern)} with "scope": "local" and "encrypted": true — local (this-device) fields can never be encrypted`
          );
        }
      }
    }
    if (!isValidFieldsArray(fields)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "fields" list — each entry needs a non-empty "pattern", a "scope" of ${RULE_SCOPES.map((s) => `"${s}"`).join(", ")}, and a boolean "encrypted", e.g. {"pattern": "*Token*", "scope": "local", "encrypted": false}`
      );
    }
    validatedFields = fields;
  }
  let validatedFileRule: FileRule | undefined;
  if (fileRule !== undefined) {
    if (type !== "file") {
      throw new ManifestValidationError(
        `rule "${name}" has a "fileRule" but "type": "${String(type)}" — whole-file encryption only applies to single-file rules ("type": "file"), never folder members`
      );
    }
    if (validatedMode === "fields" || validatedMode === "encrypted") {
      throw new ManifestValidationError(
        `rule "${name}" has a "fileRule" together with "mode": "${String(validatedMode)}" — "fileRule" only applies in Plain mode (omit "mode" or use "mode": "plain")`
      );
    }
    if (isPlainObject(fileRule) && fileRule.scope === "local") {
      throw new ManifestValidationError(
        `rule "${name}" has "fileRule.scope": "local" — Plain file-level rules use the rule's own sync toggle for "This device", not "local"; use "all", "desktop" or "mobile"`
      );
    }
    if (!isValidFileRule(fileRule)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "fileRule" — it needs a "scope" of ${FILE_RULE_SCOPES.map((s) => `"${s}"`).join(", ")} and a boolean "encrypted", e.g. {"scope": "all", "encrypted": true}`
      );
    }
    validatedFileRule = fileRule;
  }
  let validatedPerItem: Record<string, PerItemScopes> | undefined;
  if (perItem !== undefined) {
    if (validatedMode !== "fields") {
      throw new ManifestValidationError(
        `rule "${name}" sets "perItem" but not "mode": "fields" — add "mode": "fields" so per-item scopes take effect`
      );
    }
    if (!isValidPerItemMap(perItem)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "perItem" map — each entry must map element values to a scope of ${RULE_SCOPES.map((s) => `"${s}"`).join(", ")}, e.g. {"myKey": {"element-id": "desktop"}}`
      );
    }
    for (const key of Object.keys(perItem)) {
      const encryptedRule = (validatedFields ?? []).find((f) => f.encrypted === true && keyMatchesAny(key, [f.pattern]));
      if (encryptedRule !== undefined) {
        throw new ManifestValidationError(
          `rule "${name}" has "perItem" enabled for key "${key}", which also has "encrypted": true in its field rule — per-item scoped keys can never be encrypted (encrypt stays key-level, D3)`
        );
      }
    }
    validatedPerItem = perItem;
  }
  if (description !== undefined && typeof description !== "string") {
    throw new ManifestValidationError(`rule "${name}" has a "description" that isn't text — use a plain string, e.g. "description": "My custom rule"`);
  }
  if (origin !== undefined && origin !== "discovered") {
    throw new ManifestValidationError(`rule "${name}" has "origin": ${JSON.stringify(origin)}, but the only supported value is "discovered" (or omit "origin" entirely)`);
  }
  const group: SyncGroup = { name, path, type, devices };
  if (validatedMode !== undefined) group.mode = validatedMode;
  if (validatedFields !== undefined) group.fields = validatedFields;
  if (validatedFileRule !== undefined) group.fileRule = validatedFileRule;
  if (validatedPerItem !== undefined) group.perItem = validatedPerItem;
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  if (trimmedDescription !== "") group.description = trimmedDescription;
  if (label !== undefined && typeof label !== "string") {
    throw new ManifestValidationError(`rule "${name}" has a "label" that isn't text — use a plain string, e.g. "label": "BRAT"`);
  }
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  if (trimmedLabel !== "") group.label = trimmedLabel;
  if (origin === "discovered") group.origin = "discovered";
  return group;
}

// Validates + normalizes a carrier lock entry's memberLabels (2026-08-09-c-livetest-batch15):
// every value must be text, same strictness as the sibling "label" field below; empty/whitespace
// values are dropped, so an all-empty map normalizes to absent (undefined), matching how a
// trimmed-empty "label" is dropped rather than stored. `raw` undefined (the field's absent
// entirely, today's shape) is the normal, non-throwing case — every existing lock still parses.
function parseMemberLabels(raw: unknown, groupName: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new ManifestValidationError(`store.lock.json group "${groupName}" has a "memberLabels" that isn't a map of id to text`);
  }
  const memberLabels: Record<string, string> = {};
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val !== "string") {
      throw new ManifestValidationError(`store.lock.json group "${groupName}" has a "memberLabels" that isn't a map of id to text`);
    }
    const trimmed = val.trim();
    if (trimmed !== "") memberLabels[id] = trimmed;
  }
  return Object.keys(memberLabels).length > 0 ? memberLabels : undefined;
}

const KNOWN_LOCK_ENTRY_KEYS = ["sourcePluginVersion", "sourceAppVersion", "desktopOnly", "label", "memberLabels"] as const;

// Validate-and-carry, not rebuild-from-a-whitelist (spec 2026-08-11-data-model-hardening.md §3.1,
// invariant II.1). The named fields are validated and normalized exactly as before — same
// messages, same rejections, same dropping of a blank label / a false desktopOnly / a non-string
// version — and every other key of the entry rides through untouched. A rebuild was never just a
// local loss: the pull path writes the PARSED lock back (ConfigSyncCore's merge at the end of the
// pull flow), so one pull by an older device stripped a newer device's fields and pushed the loss
// on to the whole fleet. That is the reason the lock format could not evolve at all.
function parseStoreLockEntry(raw: unknown, groupName: string): StoreLockEntry {
  // A non-object entry keeps failing on the version rule below, with the message it always had.
  const src = isPlainObject(raw) ? raw : {};
  const plugin = typeof src.sourcePluginVersion === "string" ? src.sourcePluginVersion : undefined;
  const app = typeof src.sourceAppVersion === "string" ? src.sourceAppVersion : undefined;
  if (plugin === undefined && app === undefined) {
    throw new ManifestValidationError(`store.lock.json group "${groupName}" must have a string sourcePluginVersion or sourceAppVersion`);
  }
  if (src.label !== undefined && typeof src.label !== "string") {
    throw new ManifestValidationError(`store.lock.json group "${groupName}" has a "label" that isn't text`);
  }
  const memberLabels = parseMemberLabels(src.memberLabels, groupName);
  const label = typeof src.label === "string" ? src.label.trim() : "";
  // The known fields keep BOTH their normalized value and their fixed order: a non-string version,
  // desktopOnly:false and a blank label stay dropped. The fixed ORDER no longer carries the
  // correctness argument it was introduced with — §6 made status.ts's remoteLockAhead compare
  // entries key by key instead of with JSON.stringify, so a mere reordering (refreshLockDesktopOnly
  // moves desktopOnly to the end) can no longer read as "the remote is ahead". It is kept because
  // the lock is a FILE inside a vault that other tools sync and version: two devices that re-emit
  // the same entry must produce the same bytes, or every parse-and-write churns the vault's history
  // and the raw-text fallback below (unparseable locks) sees a difference that isn't one.
  // Carrying is additive on top of normalization, never a replacement for it.
  const known: StoreLockEntry = {};
  if (plugin !== undefined) known.sourcePluginVersion = plugin;
  if (app !== undefined) known.sourceAppVersion = app;
  if (src.desktopOnly === true) known.desktopOnly = true;
  if (label !== "") known.label = label;
  if (memberLabels !== undefined) known.memberLabels = memberLabels;
  const carried: Record<string, unknown> = { ...src };
  for (const key of KNOWN_LOCK_ENTRY_KEYS) delete carried[key];
  return { ...known, ...carried };
}

export function parseStoreLock(raw: string): StoreLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`store.lock.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.capturedAt !== "string" || !isPlainObject(parsed.groups)) {
    throw new ManifestValidationError("store.lock.json must be {capturedAt: string, groups: object}");
  }
  const groups: StoreLock["groups"] = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    groups[k] = parseStoreLockEntry(v, k);
  }
  // Unknown TOP-LEVEL keys are carried by the same rule, after the two known ones. Shallow by
  // design — a deep clone would have to guess at shapes it does not know.
  const carried: Record<string, unknown> = { ...parsed };
  delete carried.capturedAt;
  delete carried.groups;
  return { capturedAt: parsed.capturedAt, groups, ...carried };
}

// The store lock's format version this build writes (spec 2026-08-11-data-model-hardening.md
// §4.3). Absent on disk = 1, today's shape.
export const STORE_LOCK_VERSION = 2;

// §4.3 copy: what pull and push say when the store at the other end declares a version this build
// cannot write.
export const STORE_LOCK_FUTURE_MESSAGE = "The store was written by a newer Config Sync. Update Config Sync on this device before syncing.";

// A lock's declared format version. `version` reaches us through parseStoreLock's carried tail
// (§3.1), so it is literally whatever the file held: a value that isn't a number is not evidence
// of a newer format — and refusing to sync over a typo would strand a whole fleet — so it reads as
// today's shape instead.
export function storeLockVersion(lock: StoreLock): number {
  return typeof lock.version === "number" ? lock.version : 1;
}

// The v2 payload (§6) reaches a reader exactly the way `version` does — through the carried tail,
// never through validation — so every read narrows the raw value here instead of trusting the
// declared type. Deliberate, and the same argument as storeLockVersion's: a value this build cannot
// make sense of must ride through untouched (invariant II.1) rather than be dropped by a
// normalising parse, and a build that cannot read it must not act on it either. Empty string counts
// as absent: it dates nothing and fingerprints nothing.
function lockText(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

// The lineage watermark AS RECORDED: the remote state this store was last aligned to. A v1 lock has
// no watermark of its own — its single `capturedAt` carried that meaning too — so it answers with
// `capturedAt`. Used by the writers; comparison goes through lockLineage below.
export function lockWatermark(lock: StoreLock): string {
  return lockText(lock.syncedWatermark) ?? lock.capturedAt;
}

// The lineage point a lock actually stands at: the newest state it has SEEN, whether by pulling it
// (`syncedWatermark`) or by producing it here (`capturedAt`). Never older than its own `capturedAt`
// — and THAT is what makes two locks from different builds comparable at all.
//
// Getting this wrong was a live regression. `syncedWatermark` alone is not the same quantity as a v1
// lock's `capturedAt`: an updated device's watermark stops moving on capture (lineage belongs to the
// pull), while a v1 device's stands in for both and tracks whatever it last pulled — which is OUR
// `capturedAt`. So an older device that pulled from us and pushed back read as "newer" against a
// watermark we had deliberately left behind, with zero content difference, in exactly the mixed
// fleet §6 exists to keep quiet. Taking the later of the two puts both sides on the same scale.
export function lockLineage(lock: StoreLock): string {
  const watermark = lockWatermark(lock);
  const w = Date.parse(watermark);
  const c = Date.parse(lock.capturedAt);
  if (Number.isNaN(w)) return Number.isNaN(c) ? watermark : lock.capturedAt;
  if (Number.isNaN(c)) return watermark;
  return c > w ? lock.capturedAt : watermark;
}

// The `hash` field's documented shape (§6): the algorithm names itself, so a later build can change
// it without every reader having to guess from the digest's length. Comparison is plain string
// equality either way — the prefix rides along on both sides.
export const STORE_LOCK_HASH_PREFIX = "sha256:";

export function lockEntryCapturedAt(entry: StoreLockEntry): string | undefined {
  return lockText(entry.capturedAt);
}

export function lockEntryHash(entry: StoreLockEntry): string | undefined {
  return lockText(entry.hash);
}

// The top-level `capturedAt` a v2 writer stamps: the newest moment any item in THIS store was
// captured. `floors` are values the result may never fall below — a pull passes the lock it is
// replacing, because a pull is additive and the store it produces can never be older than the one
// it started from. Unparseable dates are ignored rather than rejected (locks in the wild carry
// hand-written stamps, and the tests seed "T"); `fallback` answers when nothing at all is datable,
// so the field is never absent.
export function derivedLockCapturedAt(
  groups: Record<string, StoreLockEntry>,
  floors: (string | undefined)[],
  fallback: string
): string {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  const consider = (v: string | undefined): void => {
    if (v === undefined) return;
    const ms = Date.parse(v);
    if (Number.isNaN(ms) || ms <= bestMs) return;
    best = v;
    bestMs = ms;
  };
  for (const entry of Object.values(groups)) consider(lockEntryCapturedAt(entry));
  for (const floor of floors) consider(floor);
  return best ?? fallback;
}

// Every entry field this build writes for itself. Wider than KNOWN_LOCK_ENTRY_KEYS on purpose: the
// PARSER normalises only the v1 five (the v2 pair rides the tail, above), but a WRITER that rebuilds
// an entry from its own computed values must also clear the v2 pair underneath the rebuild, or a
// `hash` it deliberately omitted this run would survive from the previous lock and fingerprint
// content that no longer exists.
const WRITTEN_LOCK_ENTRY_KEYS = [...KNOWN_LOCK_ENTRY_KEYS, "capturedAt", "hash"] as const;

// The part of a lock entry this build does NOT write — carried onto a rebuilt entry so a field a
// newer build recorded survives our capture instead of being stripped and published as a loss to
// the whole fleet (§6, task-2 finding I-1: without this, §3.1's carrying parser is theatre, because
// the writers rebuild from fresh literals).
export function lockEntryTail(entry: StoreLockEntry | undefined): Record<string, unknown> {
  if (entry === undefined) return {};
  const tail: Record<string, unknown> = { ...entry };
  for (const key of WRITTEN_LOCK_ENTRY_KEYS) delete tail[key];
  return tail;
}

const WRITTEN_LOCK_KEYS = ["version", "syncedWatermark", "capturedAt", "groups"] as const;

// The same carry, one level up: the lock's own unknown TOP-LEVEL keys.
export function lockTail(lock: StoreLock | null): Record<string, unknown> {
  if (lock === null) return {};
  const tail: Record<string, unknown> = { ...lock };
  for (const key of WRITTEN_LOCK_KEYS) delete tail[key];
  return tail;
}

// The version a lock DOCUMENT declares, read straight off the JSON — never through parseStoreLock.
// "Is this shape valid for v1?" and "was this written by a newer build?" are different questions and
// must not share an answer: parseStoreLock still enforces the v1 entry rule (a string
// sourcePluginVersion or sourceAppVersion), so any v3 that restructures the entry throws there — and
// §6's own "Out of scope" note names exactly such a restructure (the source/innate/display
// partition) as the deferred v3 change. Asking the version through the parser therefore meant the
// gate could not survive the very change it exists to protect against (final-review C1): the parse
// threw, the refusal was skipped, and capture rewrote v3's bookkeeping as `version: 2` and pushed
// the loss to the fleet. Anything that is not JSON at all, or declares no numeric `version`, reads
// as today's shape — refusing to sync over a typo would strand a whole fleet.
export function declaredStoreLockVersion(raw: string | null): number {
  if (raw === null) return 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 1;
  }
  return isPlainObject(parsed) && typeof parsed.version === "number" ? parsed.version : 1;
}

// The §4.3 gate, run by capture and the pull merge against the LOCAL store's lock, and by pull and
// push against the one at the other end. A version from the future is a refusal, NOT the `unknown`
// state checkRemote reports for a lock it merely cannot read: an unparseable lock keeps today's
// behaviour (capture rewrites it, pull merges around it), while a newer version means the file has a
// shape we would silently downgrade by writing our own back over it. Takes the raw text — the caller
// has it in hand, and the version is read without validating anything (see above).
export function assertStoreLockVersionUnderstood(raw: string | null): void {
  if (declaredStoreLockVersion(raw) > STORE_LOCK_VERSION) throw new Error(STORE_LOCK_FUTURE_MESSAGE);
}

export async function migrateLegacyManifest(
  io: FileIO,
  rootPath: string,
  existing: SyncGroup[],
  now: string
): Promise<{ groups: SyncGroup[]; migrated: boolean }> {
  const p = `${rootPath}/config-sync.json`;
  if (!(await io.exists(p))) return { groups: existing, migrated: false };
  const legacy = parseSyncManifest(await io.read(p)).groups; // throws ManifestValidationError on bad JSON
  const have = new Set(existing.map((g) => g.name));
  const merged = [...existing, ...legacy.filter((g) => !have.has(g.name))];
  // Timestamp to the second so a same-day second migration cannot overwrite the earlier
  // renamed backup ("2026-07-15T08-30-05" — colons are not filesystem-safe).
  await io.rename(p, `${p}.migrated-${now.slice(0, 19).replace(/:/g, "-")}`);
  return { groups: merged, migrated: true };
}

export function validateRemotes(data: unknown): Remote[] {
  if (!Array.isArray(data)) throw new ManifestValidationError("remotes must be a list, e.g. [{\"name\": \"laptop\", \"type\": \"vault\", \"storePath\": \"/path/to/store\"}]");
  return data.map((r, i) => parseRemote(r, i));
}

function parseRemote(r: unknown, index: number): Remote {
  if (!isPlainObject(r)) throw new ManifestValidationError(`remote #${index + 1} must be an object, e.g. {"name": "laptop", "type": "vault", "storePath": "/path/to/store"}`);
  const { name, type, storePath, url, branch, subdir, excludeSelf, tokenId, username } = r;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`remote #${index + 1} is missing a "name" — give it a short label, e.g. "name": "laptop"`);
  }
  if (excludeSelf !== undefined && typeof excludeSelf !== "boolean") {
    throw new ManifestValidationError(`remote "${name}" has "excludeSelf": ${JSON.stringify(excludeSelf)}, but it must be true or false`);
  }
  if (type === "vault") {
    if (typeof storePath !== "string" || !(storePath.startsWith("/") || storePath === "~" || storePath.startsWith("~/"))) {
      throw new ManifestValidationError(`The store path for "${name}" needs to be a full path starting with / or ~/ — for example ~/Vaults/other-vault/config-sync.`);
    }
    const remote: Remote = { name, type, storePath };
    if (excludeSelf === true) remote.excludeSelf = true;
    return remote;
  }
  if (type === "git") {
    if (typeof url !== "string" || url === "") {
      throw new ManifestValidationError(`remote "${name}" is missing a "url" — point it at the git repository, e.g. "url": "git@example.com:me/config.git"`);
    }
    if (typeof branch !== "string" || branch === "") {
      throw new ManifestValidationError(`remote "${name}" is missing a "branch" — name the branch to sync, e.g. "branch": "main"`);
    }
    if (subdir !== undefined && (typeof subdir !== "string" || subdir.startsWith("/") || subdir.split("/").includes(".."))) {
      throw new ManifestValidationError(`remote "${name}" has a "subdir" that must stay inside the repository — use a relative path without "..", e.g. "config-sync"`);
    }
    if (tokenId !== undefined && (typeof tokenId !== "string" || !/^[a-z0-9-]+$/.test(tokenId) || tokenId.length > 64)) {
      throw new ManifestValidationError(`remote "${name}" has a "tokenId" that must name a keychain secret with lowercase letters, digits, and dashes, up to 64 characters, e.g. "gitlab-token"`);
    }
    if (tokenId === PASSPHRASE_SECRET_ID) {
      throw new ManifestValidationError(`remote "${name}" has "tokenId": "${PASSPHRASE_SECRET_ID}", which is Config Sync's own vault passphrase — give this remote its own access token instead`);
    }
    // The username reaches git through the credential protocol, which is line-based: a newline
    // in it would forge protocol lines, so reject control characters outright.
    if (username !== undefined && (typeof username !== "string" || username === "" || /[\s\p{Cc}]/u.test(username))) {
      throw new ManifestValidationError(`remote "${name}" has a "username" that must be a single word without spaces, e.g. "git" — leave it out entirely for hosts that ignore it`);
    }
    const remote: Remote = { name, type, url, branch };
    if (typeof subdir === "string" && subdir !== "") remote.subdir = subdir;
    if (excludeSelf === true) remote.excludeSelf = true;
    if (typeof tokenId === "string") remote.tokenId = tokenId;
    if (typeof username === "string") remote.username = username;
    return remote;
  }
  throw new ManifestValidationError(`remote "${name}" has "type": ${JSON.stringify(type)}, but it must be "vault" or "git"`);
}
