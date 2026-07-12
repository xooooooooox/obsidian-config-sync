import {
  decryptField,
  decryptFile,
  encryptField,
  encryptFile,
  fieldUnchanged,
  fileUnchanged,
  isFieldEnvelope,
  parseFileEnvelope,
} from "./crypto";
import { isPlainObject, keyMatchesAny, mergePreservingSanitized, sanitizeJson } from "./sanitize";
import { SyncGroup } from "./types";

export const SENSITIVE_KEY_PATTERNS = ["apikey", "api_key", "token", "secret", "password", "credential", "auth", "cookie", "email"];

export interface SensitiveScan {
  keys: string[];
  blob: boolean;
}

function collectSensitiveKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectSensitiveKeys(v, found);
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p))) found.add(k);
      collectSensitiveKeys(v, found);
    }
  }
}

function hasOpaqueBlob(value: unknown, contentLength: number): boolean {
  if (typeof value === "string") {
    return value.length >= 1024 && value.length / contentLength > 0.8;
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasOpaqueBlob(v, contentLength));
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((v) => hasOpaqueBlob(v, contentLength));
  }
  return false;
}

export function scanSensitive(content: string): SensitiveScan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { keys: [], blob: false };
  }
  const found = new Set<string>();
  collectSensitiveKeys(parsed, found);
  return { keys: [...found], blob: hasOpaqueBlob(parsed, content.length) };
}

export function groupNeedsPassphrase(group: SyncGroup): boolean {
  if (group.mode === "encrypted") return true;
  if (group.mode === "fields" && group.fields !== undefined) {
    return group.fields.some((f) => f.action === "encrypt");
  }
  return false;
}

export function stripPatterns(group: SyncGroup): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.action === "strip").map((f) => f.pattern);
}

function encryptPatterns(group: SyncGroup): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.action === "encrypt").map((f) => f.pattern);
}

export class PassphraseNeededError extends Error {}

function requirePassphrase(group: SyncGroup, passphrase: string | null): string {
  if (groupNeedsPassphrase(group) && passphrase === null) {
    throw new PassphraseNeededError("passphrase not set on this device — Settings → General");
  }
  return passphrase as string;
}

function buildNote(encrypted: string[], stripped: string[]): string | null {
  const parts: string[] = [];
  if (encrypted.length > 0) parts.push(`encrypted ${encrypted.join(", ")}`);
  if (stripped.length > 0) parts.push(`stripped ${stripped.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function encryptFields(
  value: unknown,
  patterns: string[],
  passphrase: string,
  matched: Set<string>
): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await encryptFields(v, patterns, passphrase, matched));
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (keyMatchesAny(k, patterns)) {
        matched.add(k);
        out[k] = await encryptField(passphrase, JSON.stringify(v));
      } else {
        out[k] = await encryptFields(v, patterns, passphrase, matched);
      }
    }
    return out;
  }
  return value;
}

async function decryptFields(
  value: unknown,
  passphrase: string,
  groupName: string
): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await decryptFields(v, passphrase, groupName));
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isFieldEnvelope(v)) {
        out[k] = JSON.parse(await decryptField(passphrase, v, groupName)) as unknown;
      } else {
        out[k] = await decryptFields(v, passphrase, groupName);
      }
    }
    return out;
  }
  return value;
}

function strippedKeyNames(value: unknown, patterns: string[], found: string[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) strippedKeyNames(v, patterns, found, seen);
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (keyMatchesAny(k, patterns)) {
        if (!seen.has(k)) {
          seen.add(k);
          found.push(k);
        }
      } else {
        strippedKeyNames(v, patterns, found, seen);
      }
    }
  }
}

export async function captureTransform(
  group: SyncGroup,
  content: string,
  passphrase: string | null
): Promise<{ content: string; note: string | null }> {
  if (group.mode === undefined || group.mode === "plain") {
    return { content, note: null };
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    return { content: await encryptFile(pw, content), note: "whole file encrypted" };
  }
  // fields
  const strip = stripPatterns(group);
  const encrypt = encryptPatterns(group);
  const pw = requirePassphrase(group, passphrase);
  const parsed = JSON.parse(content) as unknown;
  const stripped: string[] = [];
  strippedKeyNames(parsed, strip, stripped, new Set());
  const afterStrip = strip.length > 0 ? sanitizeJson(parsed, strip) : parsed;
  const matched = new Set<string>();
  const afterEncrypt = encrypt.length > 0 ? await encryptFields(afterStrip, encrypt, pw, matched) : afterStrip;
  const note = buildNote([...matched], stripped);
  return { content: JSON.stringify(afterEncrypt, null, 2) + "\n", note };
}

export async function applyTransform(
  group: SyncGroup,
  storeContent: string,
  localContent: string | null,
  passphrase: string | null
): Promise<string> {
  if (group.mode === undefined || group.mode === "plain") {
    return storeContent;
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    const envelope = parseFileEnvelope(storeContent);
    if (envelope === null) {
      throw new Error(`Group "${group.name}": store content is not a valid encrypted envelope`);
    }
    return decryptFile(pw, envelope, group.name);
  }
  // fields
  const strip = stripPatterns(group);
  const pw = requirePassphrase(group, passphrase);
  const incoming = await decryptFields(JSON.parse(storeContent) as unknown, pw, group.name);
  if (strip.length === 0 || localContent === null) {
    return JSON.stringify(incoming, null, 2) + "\n";
  }
  const local = JSON.parse(localContent) as unknown;
  const merged = mergePreservingSanitized(local, incoming, strip);
  return JSON.stringify(merged, null, 2) + "\n";
}

export async function contentUnchanged(
  group: SyncGroup,
  localContent: string,
  storeContent: string,
  passphrase: string | null
): Promise<boolean> {
  if (group.mode === undefined || group.mode === "plain") {
    return localContent === storeContent;
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    const envelope = parseFileEnvelope(storeContent);
    if (envelope === null) return false;
    return fileUnchanged(pw, envelope, localContent);
  }
  // fields
  const strip = stripPatterns(group);
  const pw = requirePassphrase(group, passphrase);
  const localParsed = strip.length > 0 ? sanitizeJson(JSON.parse(localContent) as unknown, strip) : (JSON.parse(localContent) as unknown);
  const storeParsed = JSON.parse(storeContent) as unknown;
  return fieldsUnchanged(localParsed, storeParsed, pw, group.name);
}

async function fieldsUnchanged(local: unknown, store: unknown, passphrase: string, groupName: string): Promise<boolean> {
  if (Array.isArray(store)) {
    if (!Array.isArray(local) || local.length !== store.length) return false;
    for (let i = 0; i < store.length; i++) {
      if (!(await fieldsUnchanged(local[i], store[i], passphrase, groupName))) return false;
    }
    return true;
  }
  if (isPlainObject(store)) {
    if (!isPlainObject(local)) return false;
    const storeKeys = Object.keys(store);
    const localKeys = Object.keys(local);
    if (storeKeys.length !== localKeys.length) return false;
    for (const k of storeKeys) {
      if (!(k in local)) return false;
      const sv = store[k];
      const lv = local[k];
      if (isFieldEnvelope(sv)) {
        if (!(await fieldUnchanged(passphrase, sv, JSON.stringify(lv)))) return false;
      } else if (!(await fieldsUnchanged(lv, sv, passphrase, groupName))) {
        return false;
      }
    }
    return true;
  }
  return local === store;
}
