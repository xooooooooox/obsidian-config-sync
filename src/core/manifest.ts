import { DeviceClass, Remote, StoreLock, SyncGroup, SyncManifest } from "./types";
import { groupStorePath } from "./pathing";
import { isPlainObject } from "./sanitize";

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(`Invalid config-sync data: ${message}`);
    this.name = "ManifestValidationError";
  }
}

export const BLACKLISTED_PLUGIN_DIRS = ["remotely-save", "ioto-update", "slides-rup", "config-sync", "obsidian-config-sync"];

function isValidType(v: unknown): v is "file" | "dir" {
  return v === "file" || v === "dir";
}

function isValidDevice(v: unknown): v is DeviceClass {
  return v === "all" || v === "desktop" || v === "mobile";
}

function isValidSanitizeArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((p) => typeof p === "string" && p !== "");
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
  if (!isPlainObject(data)) throw new ManifestValidationError("manifest top level must be an object");
  if (data.version !== 1) {
    throw new ManifestValidationError(`unsupported version: ${String(data.version)} (expected 1)`);
  }
  if (!Array.isArray(data.groups)) throw new ManifestValidationError('"groups" must be an array');
  const groups = data.groups.map((g, i) => parseGroup(g, i));
  const names = new Set<string>();
  const storePaths = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new ManifestValidationError(`duplicate group name "${g.name}"`);
    names.add(g.name);
    const sp = groupStorePath(g.path);
    if (storePaths.has(sp)) {
      throw new ManifestValidationError(`group "${g.name}" collides with another group on store path "${sp}"`);
    }
    storePaths.add(sp);
  }
  return { version: 1, groups };
}

function parseGroup(g: unknown, index: number): SyncGroup {
  if (!isPlainObject(g)) throw new ManifestValidationError(`group #${index} must be an object`);
  const { name, path, type, devices, sanitize, description, origin } = g;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`group #${index}: "name" must be a non-empty string`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new ManifestValidationError(
      `group "${name}": name must be lowercase letters, digits, "-" or "_" and start with a letter or digit`
    );
  }
  if (typeof path !== "string" || path === "") {
    throw new ManifestValidationError(`group "${name}": "path" must be a non-empty string`);
  }
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new ManifestValidationError(`group "${name}": path must be vault-relative without ".."`);
  }
  if (!isValidType(type)) {
    throw new ManifestValidationError(`group "${name}": "type" must be "file" or "dir"`);
  }
  if (!isValidDevice(devices)) {
    throw new ManifestValidationError(`group "${name}": "devices" must be "all", "desktop" or "mobile"`);
  }
  let validatedSanitize: string[] | undefined;
  if (sanitize !== undefined) {
    if (type !== "file") {
      throw new ManifestValidationError(`group "${name}": "sanitize" is only supported on file groups`);
    }
    if (!isValidSanitizeArray(sanitize)) {
      throw new ManifestValidationError(`group "${name}": "sanitize" must be an array of non-empty strings`);
    }
    validatedSanitize = sanitize;
  }
  if (description !== undefined && typeof description !== "string") {
    throw new ManifestValidationError(`group "${name}": "description" must be a string`);
  }
  if (origin !== undefined && origin !== "discovered") {
    throw new ManifestValidationError(`group "${name}": "origin" must be "discovered" when present`);
  }
  assertNotBlacklisted(name, path);
  const group: SyncGroup = { name, path, type, devices };
  if (validatedSanitize !== undefined) group.sanitize = validatedSanitize;
  const trimmedDescription = typeof description === "string" ? description.trim() : "";
  if (trimmedDescription !== "") group.description = trimmedDescription;
  if (origin === "discovered") group.origin = "discovered";
  return group;
}

function assertNotBlacklisted(name: string, path: string): void {
  if (path === "{configDir}" || path === "{configDir}/plugins") {
    throw new ManifestValidationError(
      `group "${name}": "${path}" would sweep blacklisted plugin dirs into the store — target specific plugins instead`
    );
  }
  const m = path.match(/^\{configDir\}\/plugins\/([^/]+)(\/|$)/);
  if (m !== null && m[1] !== undefined && BLACKLISTED_PLUGIN_DIRS.includes(m[1])) {
    throw new ManifestValidationError(
      `group "${name}": plugin "${m[1]}" is blacklisted (machine-bound or credential-bearing), it can never enter the store`
    );
  }
}

export function parseStoreLock(raw: string): StoreLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestValidationError(`store.lock.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.publishedAt !== "string" || !isPlainObject(parsed.groups)) {
    throw new ManifestValidationError("store.lock.json must be {publishedAt: string, groups: object}");
  }
  const groups: Record<string, { sourcePluginVersion: string }> = {};
  for (const [k, v] of Object.entries(parsed.groups)) {
    if (!isPlainObject(v) || typeof v.sourcePluginVersion !== "string") {
      throw new ManifestValidationError(`store.lock.json group "${k}" must have a string sourcePluginVersion`);
    }
    groups[k] = { sourcePluginVersion: v.sourcePluginVersion };
  }
  return { publishedAt: parsed.publishedAt, groups };
}

export function validateRemotes(data: unknown): Remote[] {
  if (!Array.isArray(data)) throw new ManifestValidationError("remotes must be a JSON array");
  return data.map((r, i) => parseRemote(r, i));
}

function parseRemote(r: unknown, index: number): Remote {
  if (!isPlainObject(r)) throw new ManifestValidationError(`remote #${index} must be an object`);
  const { name, type, storePath, url, branch, subdir } = r;
  if (typeof name !== "string" || name === "") {
    throw new ManifestValidationError(`remote #${index}: "name" must be a non-empty string`);
  }
  if (type === "vault") {
    if (typeof storePath !== "string" || !(storePath.startsWith("/") || storePath === "~" || storePath.startsWith("~/"))) {
      throw new ManifestValidationError(`remote "${name}": "storePath" must be an absolute path (a leading ~/ is allowed)`);
    }
    return { name, type, storePath };
  }
  if (type === "git") {
    if (typeof url !== "string" || url === "") {
      throw new ManifestValidationError(`remote "${name}": "url" must be a non-empty string`);
    }
    if (typeof branch !== "string" || branch === "") {
      throw new ManifestValidationError(`remote "${name}": "branch" must be a non-empty string`);
    }
    if (subdir !== undefined && (typeof subdir !== "string" || subdir.startsWith("/") || subdir.split("/").includes(".."))) {
      throw new ManifestValidationError(`remote "${name}": "subdir" must be a relative path without ".."`);
    }
    const remote: Remote = { name, type, url, branch };
    if (typeof subdir === "string" && subdir !== "") remote.subdir = subdir;
    return remote;
  }
  throw new ManifestValidationError(`remote "${name}": "type" must be "vault" or "git"`);
}
