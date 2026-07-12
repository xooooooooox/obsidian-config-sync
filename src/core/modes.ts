import { isPlainObject } from "./sanitize";
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
