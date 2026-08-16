import {
  asFileSharing,
  asSharing,
  DeviceClass,
  FieldRule,
  FileRule,
  ItemRef,
  LockItems,
  LockSource,
  PerElementSharing,
  Remote,
  StoreLock,
  StoreLockEntry,
  SyncGroup,
  SyncManifest,
  SyncMode,
} from "./types";
import { isLockRef, joinRef, legacyRef, lockRefFor, splitRef } from "./itemKeys";

// No compiled sync list — see parseGroup. Named once so every call shares the same empty index.
const EMPTY_GROUP_REFS: ReadonlyMap<string, ItemRef> = new Map();
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
// compile/validate time (a persisted bad shape silently zeroes out
// compiledGroups on next launch — see main.ts's recompile).
export const GROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isValidType(v: unknown): v is "file" | "folder" {
  return v === "file" || v === "folder";
}

function isValidDevice(v: unknown): v is DeviceClass {
  return v === "all" || v === "desktop" || v === "mobile";
}

function isValidMode(v: unknown): v is SyncMode {
  return v === "plain" || v === "fields" || v === "encrypted";
}

// The one sentence describing a Sharing value, reused by every message below so the shape is
// spelled the same way wherever a rule is rejected.
const SHARING_SHAPE = '{"kind": "everywhere"}, {"kind": "per-class", "class": "desktop"|"mobile"} or {"kind": "this-device"}';

function isValidFieldRule(v: unknown): v is FieldRule {
  if (!isPlainObject(v) || typeof v.pattern !== "string" || v.pattern === "") return false;
  const sharing = asSharing(v.sharing);
  if (sharing === undefined || typeof v.encrypted !== "boolean") return false;
  // A this-device field never leaves the device, so there is nothing for encryption to protect
  // and a passphrase prompt it can never justify.
  if (sharing.kind === "this-device" && v.encrypted) return false;
  return v.locked === undefined || typeof v.locked === "boolean";
}

function isValidFieldsArray(v: unknown): v is FieldRule[] {
  return Array.isArray(v) && v.every((f) => isValidFieldRule(f));
}

// Structural check only: every element's value must be a Sharing. Whether the key
// it's attached to is actually a string array at runtime is checked at capture time
// (perElement.ts's readPerElementArray) — it can't be verified statically from the manifest alone.
function isValidPerElementSharing(v: unknown): v is PerElementSharing {
  return isPlainObject(v) && Object.values(v).every((s) => asSharing(s) !== undefined);
}

function isValidPerElementMap(v: unknown): v is Record<string, PerElementSharing> {
  return isPlainObject(v) && Object.values(v).every((s) => isValidPerElementSharing(s));
}

// D9: a Plain-mode file-level rule cannot be this-device — the type says so (FileSharing), and
// asFileSharing is the runtime half of the same statement.
function isValidFileRule(v: unknown): v is FileRule {
  return isPlainObject(v) && asFileSharing(v.sharing) !== undefined && typeof v.encrypted === "boolean";
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
  const refs = new Map<string, string>(); // ref -> the name of the rule that claimed it, so the error can name BOTH
  const storePaths = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new ManifestValidationError(`two rules are named "${g.name}" — rename one of them so each rule has a unique name`);
    names.add(g.name);
    // The same rule one level down: the ref is the key of the lock, the baselines
    // and the opt-out list, so two rules sharing one is two rules sharing a baseline — the failure
    // this whole re-key exists to prevent, and it must not be catchable only by a name check that
    // happens to correlate with it.
    if (g.ref !== undefined) {
      const claimed = refs.get(g.ref);
      if (claimed !== undefined) {
        throw new ManifestValidationError(`rules "${g.name}" and "${claimed}" both sync the item "${g.ref}" — give one of them a different name`);
      }
      refs.set(g.ref, g.name);
    }
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
  const { name, ref, path, type, devices, sanitize, mode, fields, fileRule, perElement, description, label, origin } = g;
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
    throw new ManifestValidationError(`rule "${name}" has "type": ${JSON.stringify(type)}, but it must be "file" or "folder"`);
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
        if (isPlainObject(f) && asSharing(f.sharing)?.kind === "this-device" && f.encrypted === true) {
          throw new ManifestValidationError(
            `rule "${name}" has a field rule for key ${JSON.stringify(f.pattern)} with "sharing": {"kind": "this-device"} and "encrypted": true — a this-device field can never be encrypted`
          );
        }
      }
    }
    if (!isValidFieldsArray(fields)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "fields" list — each entry needs a non-empty "pattern", a "sharing" of ${SHARING_SHAPE}, and a boolean "encrypted", e.g. {"pattern": "*Token*", "sharing": {"kind": "this-device"}, "encrypted": false}`
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
    if (isPlainObject(fileRule) && asSharing(fileRule.sharing)?.kind === "this-device") {
      throw new ManifestValidationError(
        `rule "${name}" has "fileRule.sharing": {"kind": "this-device"} — Plain file-level rules use the rule's own sync toggle for that, not a sharing value; use everywhere or per-class`
      );
    }
    if (!isValidFileRule(fileRule)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "fileRule" — it needs a "sharing" of {"kind": "everywhere"} or {"kind": "per-class", "class": "desktop"|"mobile"} and a boolean "encrypted", e.g. {"sharing": {"kind": "everywhere"}, "encrypted": true}`
      );
    }
    validatedFileRule = fileRule;
  }
  let validatedPerElement: Record<string, PerElementSharing> | undefined;
  if (perElement !== undefined) {
    if (validatedMode !== "fields") {
      throw new ManifestValidationError(
        `rule "${name}" sets "perElement" but not "mode": "fields" — add "mode": "fields" so per-element sharing takes effect`
      );
    }
    if (!isValidPerElementMap(perElement)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "perElement" map — each entry must map element values to a sharing of ${SHARING_SHAPE}, e.g. {"myKey": {"element-id": {"kind": "per-class", "class": "desktop"}}}`
      );
    }
    for (const key of Object.keys(perElement)) {
      const encryptedRule = (validatedFields ?? []).find((f) => f.encrypted === true && keyMatchesAny(key, [f.pattern]));
      if (encryptedRule !== undefined) {
        throw new ManifestValidationError(
          `rule "${name}" has "perElement" enabled for key "${key}", which also has "encrypted": true in its field rule — per-element keys can never be encrypted (encrypt stays key-level, D3)`
        );
      }
    }
    validatedPerElement = perElement;
  }
  if (description !== undefined && typeof description !== "string") {
    throw new ManifestValidationError(`rule "${name}" has a "description" that isn't text — use a plain string, e.g. "description": "My custom rule"`);
  }
  if (origin !== undefined && origin !== "discovered") {
    throw new ManifestValidationError(`rule "${name}" has "origin": ${JSON.stringify(origin)}, but the only supported value is "discovered" (or omit "origin" entirely)`);
  }
  // The KEY SPACE's shape, not "an item this build can resolve" (isLockRef's own note): a companion
  // key is three segments and an unclaimed legacy key names a section no reader resolves, and both
  // are legal keys. Asking parseItemRef here made the validator reject a ref its own backfill below
  // had just minted, which froze compiledGroups for any rule the legacy rules could not place.
  if (ref !== undefined && !isLockRef(ref)) {
    throw new ManifestValidationError(`rule "${name}" has a "ref" that isn't an item reference, e.g. "ref": "community/dataview"`);
  }
  // A group the COMPILER produced already carries its ref and keeps it. One that did not — a
  // hand-written legacy config-sync.json rule, a fixture — is given the ref the v1/v2 lock converter
  // would give its name (itemKeys.ts's legacyRef, called with no compiled index because there is no
  // compiler behind such a rule). That is the SAME producer, not a second one, which is what makes
  // the name a legacy lock entry is keyed by and the ref that entry is re-keyed to agree by
  // construction — and it means a hand-written rule can hold a baseline at all, instead of reading
  // as never-synced (i.e. defaulting to APPLY) for want of an identity.
  const group: SyncGroup = { name, path, type, devices };
  group.ref = (typeof ref === "string" ? ref : legacyRef(name, EMPTY_GROUP_REFS)) as ItemRef;
  if (validatedMode !== undefined) group.mode = validatedMode;
  if (validatedFields !== undefined) group.fields = validatedFields;
  if (validatedFileRule !== undefined) group.fileRule = validatedFileRule;
  if (validatedPerElement !== undefined) group.perElement = validatedPerElement;
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  if (trimmedDescription !== "") group.description = trimmedDescription;
  if (label !== undefined && typeof label !== "string") {
    throw new ManifestValidationError(`rule "${name}" has a "label" that isn't text — use a plain string, e.g. "label": "BRAT"`);
  }
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  if (trimmedLabel !== "") group.label = trimmedLabel;
  if (origin === "discovered") group.origin = "discovered";
  // Validate-and-carry, the same rule parseStoreLockEntry follows —
  // never a rebuild-from-a-whitelist, because a whitelist has
  // something load-bearing to drop. main.ts's recompile pushes every COMPILED group through this
  // parser as a safety net, so a whitelist here silently strips whatever compileItems put on a group
  // that this function has not been taught about — `ref` first among them, and with it the key of
  // the lock, the baselines and the opt-out list. The named fields keep their normalized value and
  // their fixed order; everything else rides through exactly as found.
  const carried: Record<string, unknown> = { ...g };
  for (const key of WRITTEN_GROUP_KEYS) delete carried[key];
  return { ...group, ...carried };
}

// Every field of a SyncGroup this parser validates for itself; anything else on a group is carried.
// `sanitize` is listed even though it has no home on a SyncGroup: it is a v1 field this parser
// REJECTS above, and a rejected field must not come back in through the carry.
export const WRITTEN_GROUP_KEYS = ["name", "ref", "path", "type", "devices", "sanitize", "mode", "fields", "fileRule", "perElement", "description", "label", "origin"] as const;

// Validates + normalizes a carrier lock entry's element names (`display.elements`; v2's
// `memberLabels`): every value must be text, same strictness as the sibling label; empty/whitespace
// values are dropped, so an all-empty map normalizes to absent (undefined), matching how a
// trimmed-empty label is dropped rather than stored. `raw` undefined is the normal, non-throwing
// case — an item that is not a carrier has no elements to name.
function parseElementLabels(raw: unknown, ref: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new ManifestValidationError(`store.lock.json item "${ref}" has an "elements" that isn't a map of id to text`);
  }
  const elements: Record<string, string> = {};
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val !== "string") {
      throw new ManifestValidationError(`store.lock.json item "${ref}" has an "elements" that isn't a map of id to text`);
    }
    const trimmed = val.trim();
    if (trimmed !== "") elements[id] = trimmed;
  }
  return Object.keys(elements).length > 0 ? elements : undefined;
}

const KNOWN_LOCK_ENTRY_KEYS = ["source", "innate", "display"] as const;

// A v1/v2 entry's flat fields → v3's `source`/`innate`/`display` partition. The ONE
// place the old field names are read: everything downstream sees a v3 entry, whatever wrote the
// file. `sourcePluginVersion` wins over `sourceAppVersion` when a hand-edited entry carries both —
// the plugin is the more specific claim, and v2's own readers asked for it first.
function v3EntryFromLegacy(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src };
  delete out.sourcePluginVersion;
  delete out.sourceAppVersion;
  delete out.desktopOnly;
  delete out.label;
  delete out.memberLabels;
  const plugin = src.sourcePluginVersion;
  const app = src.sourceAppVersion;
  if (typeof plugin === "string") out.source = { kind: "plugin", version: plugin };
  else if (typeof app === "string") out.source = { kind: "app", version: app };
  if (src.desktopOnly === true) out.innate = { desktopOnly: true };
  const display: Record<string, unknown> = {};
  if (src.label !== undefined) display.label = src.label;
  if (src.memberLabels !== undefined) display.elements = src.memberLabels;
  if (Object.keys(display).length > 0) out.display = display;
  return out;
}

function parseLockSource(raw: unknown, ref: string): LockSource | undefined {
  if (raw === undefined) return undefined;
  const kind = isPlainObject(raw) ? raw.kind : undefined;
  const version = isPlainObject(raw) ? raw.version : undefined;
  if ((kind !== "plugin" && kind !== "app") || typeof version !== "string") {
    throw new ManifestValidationError(`store.lock.json item "${ref}" must have a "source" of {"kind": "plugin"|"app", "version": string}`);
  }
  return { kind, version };
}

// Validate-and-carry, not rebuild-from-a-whitelist.
// The named fields are validated and normalized — same rejections, same dropping
// of a blank label and a non-string version — and every other key of the entry rides through
// untouched. A rebuild was never just a local loss: the pull path writes the PARSED lock back
// (ConfigSyncCore's merge at the end of the pull flow), so one pull by an older device stripped a
// newer device's fields and pushed the loss on to the whole fleet. That is the reason the lock
// format could not evolve at all — and the reason the shape change here does not lapse the rule.
function parseStoreLockEntry(raw: unknown, ref: string): StoreLockEntry {
  // A non-object entry keeps failing on the source rule below, as it always did on the version one.
  const src = isPlainObject(raw) ? raw : {};
  const source = parseLockSource(src.source, ref);
  if (source === undefined) {
    throw new ManifestValidationError(`store.lock.json item "${ref}" must have a "source" of {"kind": "plugin"|"app", "version": string}`);
  }
  if (isPlainObject(src.display) && src.display.label !== undefined && typeof src.display.label !== "string") {
    throw new ManifestValidationError(`store.lock.json item "${ref}" has a "label" that isn't text`);
  }
  const rawDisplay = isPlainObject(src.display) ? src.display : {};
  const elements = parseElementLabels(rawDisplay.elements, ref);
  const label = typeof rawDisplay.label === "string" ? rawDisplay.label.trim() : "";
  // The known fields keep BOTH their normalized value and their fixed order. The fixed ORDER is
  // kept because the lock is a FILE inside a vault that other tools sync and version: two devices
  // that re-emit the same entry must produce the same bytes, or every parse-and-write churns the
  // vault's history and the raw-text fallback (unparseable locks) sees a difference that isn't one.
  // Carrying is additive on top of normalization, never a replacement for it.
  const known: StoreLockEntry = { source };
  if (src.innate !== undefined) {
    // `innate` is what the ITEM is, so an unrecognised claim inside it is ignored where it is read,
    // not deleted (invariant II.2) — only the one flag this build knows is normalized.
    const innate: Record<string, unknown> = isPlainObject(src.innate) ? { ...src.innate } : {};
    delete innate.desktopOnly;
    const rest = Object.keys(innate).length > 0 ? innate : undefined;
    const desktopOnly = isPlainObject(src.innate) && src.innate.desktopOnly === true ? { desktopOnly: true as const } : {};
    if (rest !== undefined || Object.keys(desktopOnly).length > 0) known.innate = { ...desktopOnly, ...rest };
  }
  const display: { label?: string; elements?: Record<string, string> } = {};
  if (label !== "") display.label = label;
  if (elements !== undefined) display.elements = elements;
  const displayTail: Record<string, unknown> = { ...rawDisplay };
  delete displayTail.label;
  delete displayTail.elements;
  if (Object.keys(display).length > 0 || Object.keys(displayTail).length > 0) known.display = { ...display, ...displayTail };
  const carried: Record<string, unknown> = { ...src };
  for (const key of KNOWN_LOCK_ENTRY_KEYS) delete carried[key];
  return { ...known, ...carried };
}

// The two-level `items` map, built from whatever shape the file had. A v1/v2 lock's flat `groups`
// keys are converted through `refFor` (itemKeys.ts's lockRefFor — the single producer, which asks
// the compiler first); a v3 lock's nesting is read as it stands.
function parseLockItems(parsed: Record<string, unknown>, refFor: (name: string) => string): LockItems {
  const items: LockItems = {};
  const put = (ref: string, entry: StoreLockEntry): void => {
    const { section, id } = splitRef(ref);
    const bucket = items[section] ?? {};
    bucket[id] = entry;
    items[section] = bucket;
  };
  if (isPlainObject(parsed.items)) {
    for (const [section, bucket] of Object.entries(parsed.items)) {
      if (!isPlainObject(bucket)) {
        // A section a NEWER build wrote as something this one cannot read. Carried verbatim, not
        // dropped (invariant II.1) — `items` is rebuilt here, so it cannot ride the top-level tail,
        // and a parse-then-write would otherwise publish the loss to the fleet. It is narrowed
        // where it is CONSUMED instead (lockEntryList / itemEntry), which is invariant II.2's half
        // of the same rule: unknown ⇒ preserve on disk, ignore at the point of use.
        items[section] = bucket as Record<string, StoreLockEntry>;
        continue;
      }
      for (const [id, entry] of Object.entries(bucket)) put(joinRef(section, id), parseStoreLockEntry(entry, joinRef(section, id)));
    }
    return items;
  }
  for (const [name, entry] of Object.entries(isPlainObject(parsed.groups) ? parsed.groups : {})) {
    const ref = refFor(name);
    put(ref, parseStoreLockEntry(v3EntryFromLegacy(isPlainObject(entry) ? entry : {}), ref));
  }
  return items;
}

/**
 * Reads a store lock of ANY version this build understands and answers with the v3 shape.
 *
 * `groups` is this device's compiled sync list, used only to re-key a v1/v2 lock: the compiler is
 * the single producer of an item's ref, so the conversion LOOKS ITS ANSWER UP instead of deriving a
 * second one (itemKeys.ts's lockRefFor). Optional because a lock is also read where no compiled
 * list exists — a remote check on a fresh device, a bare test context — and the closed legacy rules
 * cover every entry a registry item ever wrote. A v2 store is the NORMAL state during the
 * transition window, not an edge case: every device still on 2.21.0 is writing one.
 */
export function parseStoreLock(raw: string, groups?: readonly SyncGroup[]): StoreLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`store.lock.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.capturedAt !== "string" || !(isPlainObject(parsed.items) || isPlainObject(parsed.groups))) {
    throw new ManifestValidationError("store.lock.json must be {capturedAt: string, items: object}");
  }
  const items = parseLockItems(parsed, lockRefFor(groups ?? []));
  // Unknown TOP-LEVEL keys are carried by the same rule, after the two known ones. Shallow by
  // design — a deep clone would have to guess at shapes it does not know. `groups` is dropped from
  // the carry precisely BECAUSE it was read: carrying it too would leave the same entries on disk
  // twice, under two vocabularies, and the next reader could not tell which one was current.
  const carried: Record<string, unknown> = { ...parsed };
  delete carried.capturedAt;
  delete carried.items;
  delete carried.groups;
  return { capturedAt: parsed.capturedAt, items, ...carried };
}

// The store lock's format version this build writes. Absent on disk = 1, the flat shape.
export const STORE_LOCK_VERSION = 3;

// What pull and push say when the store at the other end declares a version this build
// cannot write.
export const STORE_LOCK_FUTURE_MESSAGE = "The store was written by a newer Config Sync. Update Config Sync on this device before syncing.";

// A lock's declared format version. `version` reaches us through parseStoreLock's carried tail,
// so it is literally whatever the file held: a value that isn't a number is not evidence
// of a newer format — and refusing to sync over a typo would strand a whole fleet — so it reads as
// today's shape instead.
export function storeLockVersion(lock: StoreLock): number {
  return typeof lock.version === "number" ? lock.version : 1;
}

// The per-item payload reaches a reader exactly the way `version` does — through the carried
// tail, never through validation — so every read narrows the raw value here instead of trusting the
// declared type. Deliberate, and the same argument as storeLockVersion's: a value this build cannot
// make sense of must ride through untouched rather than be dropped by a
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
// fleet the freshness rules exist to keep quiet. Taking the later of the two puts both sides on the same scale.
export function lockLineage(lock: StoreLock): string {
  const watermark = lockWatermark(lock);
  const w = Date.parse(watermark);
  const c = Date.parse(lock.capturedAt);
  if (Number.isNaN(w)) return Number.isNaN(c) ? watermark : lock.capturedAt;
  if (Number.isNaN(c)) return watermark;
  return c > w ? lock.capturedAt : watermark;
}

// The `hash` field's documented shape: the algorithm names itself, so a later build can change
// it without every reader having to guess from the digest's length. Comparison is plain string
// equality either way — the prefix rides along on both sides.
export const STORE_LOCK_HASH_PREFIX = "sha256:";

export function lockEntryCapturedAt(entry: StoreLockEntry): string | undefined {
  return lockText(entry.capturedAt);
}

export function lockEntryHash(entry: StoreLockEntry): string | undefined {
  return lockText(entry.hash);
}

// ── The nested `items` map, read and written in exactly one place each ─────────────────────────

// One item's entry. THE reader: nothing indexes `lock.items[section][id]` by hand, because the
// nesting is one fact and two sites that spell it out are two sites that can disagree about it.
export function itemEntry(items: LockItems, ref: string | undefined): StoreLockEntry | undefined {
  if (ref === undefined) return undefined;
  const { section, id } = splitRef(ref);
  const bucket = items[section];
  return isPlainObject(bucket) ? bucket[id] : undefined;
}

export function lockEntry(lock: StoreLock | null | undefined, ref: string | undefined): StoreLockEntry | undefined {
  return lock === null || lock === undefined ? undefined : itemEntry(lock.items, ref);
}

// Every entry, flattened back to `[ref, entry]` — for the comparisons that walk the whole lock
// (status.ts) and for the derived stamp below.
export function lockEntryList(items: LockItems): [string, StoreLockEntry][] {
  const out: [string, StoreLockEntry][] = [];
  for (const [section, bucket] of Object.entries(items)) {
    // A carried-verbatim section (see parseLockItems) is not a map of entries — narrowed here, at
    // the point of use, rather than deleted on the way in.
    if (!isPlainObject(bucket)) continue;
    for (const [id, entry] of Object.entries(bucket)) out.push([joinRef(section, id), entry]);
  }
  return out;
}

// THE writer, mutating the map a capture is building. Pure functions elsewhere in this codebase are
// the rule; this one is deliberately a builder, because capture assembles one map over a loop and a
// fresh copy per entry would say something about ownership that isn't true.
export function setLockEntry(items: LockItems, ref: string, entry: StoreLockEntry): void {
  const { section, id } = splitRef(ref);
  const bucket = items[section] ?? {};
  bucket[id] = entry;
  items[section] = bucket;
}

// The `source` of an entry, narrowed: `kind` says which SORT of version it is, so a reader asking
// "what plugin version produced this?" gets undefined for an app-anchored item instead of the app's
// version under a different field name (the v2 shape's own failure mode).
export function lockSourceVersion(entry: StoreLockEntry | undefined, kind: LockSource["kind"]): string | null {
  const source = entry?.source;
  if (source === undefined || source.kind !== kind) return null;
  return lockText(source.version) ?? null;
}

export function lockDesktopOnly(entry: StoreLockEntry | undefined): boolean {
  return entry?.innate?.desktopOnly === true;
}

export function lockLabel(entry: StoreLockEntry | undefined): string | undefined {
  return lockText(entry?.display?.label);
}

export function lockElementLabels(entry: StoreLockEntry | undefined): Record<string, string> | undefined {
  return entry?.display?.elements;
}

// The top-level `capturedAt` a v2 writer stamps: the newest moment any item in THIS store was
// captured. `floors` are values the result may never fall below — a pull passes the lock it is
// replacing, because a pull is additive and the store it produces can never be older than the one
// it started from. Unparseable dates are ignored rather than rejected (locks in the wild carry
// hand-written stamps, and the tests seed "T"); `fallback` answers when nothing at all is datable,
// so the field is never absent.
export function derivedLockCapturedAt(
  items: LockItems,
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
  for (const [, entry] of lockEntryList(items)) consider(lockEntryCapturedAt(entry));
  for (const floor of floors) consider(floor);
  return best ?? fallback;
}

// Every entry field this build writes for itself. Wider than KNOWN_LOCK_ENTRY_KEYS on purpose: the
// PARSER normalises only `source`/`innate`/`display` (capturedAt and hash ride the tail, above), but a WRITER that rebuilds
// an entry from its own computed values must also clear the v2 pair underneath the rebuild, or a
// `hash` it deliberately omitted this run would survive from the previous lock and fingerprint
// content that no longer exists.
export const WRITTEN_LOCK_ENTRY_KEYS = [...KNOWN_LOCK_ENTRY_KEYS, "capturedAt", "hash"] as const;

// The part of a lock entry this build does NOT write — carried onto a rebuilt entry so a field a
// newer build recorded survives our capture instead of being stripped and published as a loss to
// the whole fleet (without this, the carrying parser is theatre, because
// the writers rebuild from fresh literals).
export function lockEntryTail(entry: StoreLockEntry | undefined): Record<string, unknown> {
  if (entry === undefined) return {};
  const tail: Record<string, unknown> = { ...entry };
  for (const key of WRITTEN_LOCK_ENTRY_KEYS) delete tail[key];
  return tail;
}

export const WRITTEN_LOCK_KEYS = ["version", "syncedWatermark", "capturedAt", "items"] as const;

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
// sourcePluginVersion or sourceAppVersion), so any v3 that restructures the entry throws there —
// and the source/innate/display partition is exactly such a restructure.
// Asking the version through the parser would therefore mean the
// gate could not survive the very change it exists to protect against: the parse
// would throw, the refusal would be skipped, and capture would rewrite v3's bookkeeping as
// `version: 2` and push
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

// The lock version gate, run by capture and the pull merge against the LOCAL store's lock, and by pull and
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
