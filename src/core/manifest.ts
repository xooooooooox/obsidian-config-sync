import { DeviceClass, FieldRule, FileRule, PerItemScopes, Remote, RULE_SCOPES, StoreLock, SyncGroup, SyncManifest, SyncMode } from "./types";
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
  const groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean; label?: string }> = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    const plugin = isPlainObject(v) && typeof v.sourcePluginVersion === "string" ? v.sourcePluginVersion : undefined;
    const app = isPlainObject(v) && typeof v.sourceAppVersion === "string" ? v.sourceAppVersion : undefined;
    if (plugin === undefined && app === undefined) {
      throw new ManifestValidationError(`store.lock.json group "${k}" must have a string sourcePluginVersion or sourceAppVersion`);
    }
    if (isPlainObject(v) && v.label !== undefined && typeof v.label !== "string") {
      throw new ManifestValidationError(`store.lock.json group "${k}" has a "label" that isn't text`);
    }
    groups[k] = {};
    if (plugin !== undefined) groups[k].sourcePluginVersion = plugin;
    if (app !== undefined) groups[k].sourceAppVersion = app;
    if (isPlainObject(v) && v.desktopOnly === true) groups[k].desktopOnly = true;
    const label = isPlainObject(v) && typeof v.label === "string" ? v.label.trim() : "";
    if (label !== "") groups[k].label = label;
  }
  return { capturedAt: parsed.capturedAt, groups };
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
