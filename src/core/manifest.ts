import { DeviceClass, FieldRule, Remote, StoreLock, SyncGroup, SyncManifest, SyncMode } from "./types";
import { groupStorePath } from "./pathing";
import { isPlainObject } from "./sanitize";
import { FileIO } from "./io";

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

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
    (v.action === "strip" || v.action === "encrypt")
  );
}

function isValidFieldsArray(v: unknown): v is FieldRule[] {
  return Array.isArray(v) && v.every((f) => isValidFieldRule(f));
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
  const { name, path, type, devices, sanitize, mode, fields, description, label, origin } = g;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`rule #${index + 1} is missing a "name" — give it a short id, e.g. "name": "hotkeys"`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
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
      `"${name}" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).`
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
    if (!isValidFieldsArray(fields)) {
      throw new ManifestValidationError(
        `rule "${name}" has an invalid "fields" list — each entry needs a non-empty "pattern" and an "action" of "strip" or "encrypt", e.g. {"pattern": "*Token*", "action": "strip"}`
      );
    }
    validatedFields = fields;
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
  const groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string }> = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    const plugin = isPlainObject(v) && typeof v.sourcePluginVersion === "string" ? v.sourcePluginVersion : undefined;
    const app = isPlainObject(v) && typeof v.sourceAppVersion === "string" ? v.sourceAppVersion : undefined;
    if (plugin === undefined && app === undefined) {
      throw new ManifestValidationError(`store.lock.json group "${k}" must have a string sourcePluginVersion or sourceAppVersion`);
    }
    groups[k] = {};
    if (plugin !== undefined) groups[k].sourcePluginVersion = plugin;
    if (app !== undefined) groups[k].sourceAppVersion = app;
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
  await io.rename(p, `${p}.migrated-${now.slice(0, 10)}`);
  return { groups: merged, migrated: true };
}

export function validateRemotes(data: unknown): Remote[] {
  if (!Array.isArray(data)) throw new ManifestValidationError("remotes must be a list, e.g. [{\"name\": \"laptop\", \"type\": \"vault\", \"storePath\": \"/path/to/store\"}]");
  return data.map((r, i) => parseRemote(r, i));
}

function parseRemote(r: unknown, index: number): Remote {
  if (!isPlainObject(r)) throw new ManifestValidationError(`remote #${index + 1} must be an object, e.g. {"name": "laptop", "type": "vault", "storePath": "/path/to/store"}`);
  const { name, type, storePath, url, branch, subdir } = r;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`remote #${index + 1} is missing a "name" — give it a short label, e.g. "name": "laptop"`);
  }
  if (type === "vault") {
    if (typeof storePath !== "string" || !(storePath.startsWith("/") || storePath === "~" || storePath.startsWith("~/"))) {
      throw new ManifestValidationError(`The store path for "${name}" needs to be a full path starting with / or ~/ — for example ~/Vaults/other-vault/config-sync.`);
    }
    return { name, type, storePath };
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
    const remote: Remote = { name, type, url, branch };
    if (typeof subdir === "string" && subdir !== "") remote.subdir = subdir;
    return remote;
  }
  throw new ManifestValidationError(`remote "${name}" has "type": ${JSON.stringify(type)}, but it must be "vault" or "git"`);
}
