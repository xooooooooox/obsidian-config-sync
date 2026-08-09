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
import { capturePerItemArray, applyPerItemArray, perItemArrayUnchanged, readPerItemArray } from "./perItem";
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
      if (SENSITIVE_KEY_PATTERNS.some((p) => (p === "auth" ? /auth(?!or)/i.test(k) : lower.includes(p)))) found.add(k);
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
    return group.fields.some((f) => f.encrypted);
  }
  return false;
}

// True when the group's STORE copy is a whole-file encryption envelope — either mode:"encrypted"
// or a Plain-mode FileRule with encrypted:true (spec §2, D9). Callers that would otherwise diff
// raw local content against the raw store copy (e.g. the Sync Center's interactive diff panel)
// must suppress that comparison for these groups instead of showing ciphertext as a line diff.
export function isWholeFileEncrypted(group: SyncGroup): boolean {
  return group.mode === "encrypted" || group.fileRule?.encrypted === true;
}

// scope "local" (This device) — dropped from the store, apply preserves the local value.
export function stripPatterns(group: SyncGroup): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.scope === "local").map((f) => f.pattern);
}

// scope "all" + encrypted:true — ciphertext lands in the common base (old "encrypt" action).
function allEncryptPatterns(group: SyncGroup): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.scope === "all" && f.encrypted).map((f) => f.pattern);
}

// Every field scoped to a device class, regardless of encrypted — used to partition which
// top-level keys move to that class's sidecar.
export function classPatterns(group: SyncGroup, cls: "desktop" | "mobile"): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.scope === cls).map((f) => f.pattern);
}

// Subset of classPatterns(group, cls) that must be encrypted before landing in the sidecar.
function classEncryptPatterns(group: SyncGroup, cls: "desktop" | "mobile"): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.scope === cls && f.encrypted).map((f) => f.pattern);
}

function otherClass(cls: "desktop" | "mobile"): "desktop" | "mobile" {
  return cls === "desktop" ? "mobile" : "desktop";
}

// A perItem key is governed exclusively by capturePerItemArray/applyPerItemArray (per-element
// scope), never by the class/strip/encrypt machinery below — even if a stray FieldRule pattern
// also happens to match it (manifest.ts only rejects the encrypted:true combination; this is a
// defensive belt-and-suspenders exclusion for any group built outside manifest validation, e.g.
// directly in tests). Without this, a perItem key could be dropped by the other-class partition
// or the "local" strip before its per-item merge ever runs.
export function excludingPerItem(group: SyncGroup, patterns: string[]): string[] {
  const perItemKeys = group.perItem !== undefined ? Object.keys(group.perItem) : [];
  if (perItemKeys.length === 0) return patterns;
  return patterns.filter((p) => !perItemKeys.some((k) => keyMatchesAny(k, [p])));
}

// Class rules are TOP-LEVEL ONLY (spec §2.1): partition and preservation act on root object
// keys; nested keys with matching names are untouched.
function dropTopLevel(v: unknown, patterns: string[]): unknown {
  if (patterns.length === 0 || !isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!keyMatchesAny(k, patterns)) out[k] = val;
  return out;
}

export class PassphraseNeededError extends Error {}

function requirePassphrase(group: SyncGroup, passphrase: string | null): string {
  if (groupNeedsPassphrase(group) && passphrase === null) {
    throw new PassphraseNeededError("passphrase not set on this device — Settings → General");
  }
  return passphrase as string;
}

// Plain-mode whole-file encryption (FileRule, spec §2 D9). Unlike mode:"encrypted",
// FileRule-encrypted groups are NOT gated by groupNeedsPassphrase/requirePassphrase: capture and
// apply still require a passphrase (explicit, actionable error below — never a silent plaintext
// write/read), but comparison (contentUnchanged) degrades gracefully instead of locking the
// whole group out of status/diff when no passphrase is set (see contentUnchanged below).
function requireFileRulePassphrase(groupName: string, path: string, passphrase: string | null, verb: "capture" | "apply"): string {
  if (passphrase === null) {
    throw new PassphraseNeededError(
      `Group "${groupName}": cannot ${verb} the encrypted settings file "${path}" — no passphrase is set on this device. Set one in Settings → General, then ${verb} again.`
    );
  }
  return passphrase;
}

// Envelope encode/decode — thin wrappers over crypto.ts's whole-file primitives, shared by
// mode:"encrypted" and Plain-mode FileRule (same envelope format; same failure semantics).
export async function encodeFileEnvelope(passphrase: string, plaintext: string): Promise<string> {
  return encryptFile(passphrase, plaintext);
}

export async function decodeFileEnvelope(passphrase: string, storeContent: string, groupName: string): Promise<string> {
  const envelope = parseFileEnvelope(storeContent);
  if (envelope === null) {
    throw new Error(`Group "${groupName}": store content is not a valid encrypted envelope`);
  }
  return decryptFile(passphrase, envelope, groupName);
}

function buildNote(encrypted: string[], stripped: string[], classOnly: string | null): string | null {
  const parts: string[] = [];
  if (encrypted.length > 0) parts.push(`encrypted ${encrypted.join(", ")}`);
  if (stripped.length > 0) parts.push(`stripped ${stripped.join(", ")}`);
  if (classOnly !== null) parts.push(classOnly);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// A field envelope is a fresh salt/IV every encryption (crypto.ts), so byte-comparing envelopes
// never tells "unchanged" — fieldUnchanged's mac-based check does. Reusing the OLD envelope
// byte-for-byte when the plaintext hasn't moved is what keeps the store (and the capture-preview
// diff, which calls captureTransform the same way — see main.ts's diffPair) from showing every
// encrypted field as replaced on every capture (C-#36).
async function reuseOrEncryptField(passphrase: string, plaintext: unknown, storeFieldValue: unknown): Promise<string> {
  const serialized = JSON.stringify(plaintext);
  if (isFieldEnvelope(storeFieldValue) && (await fieldUnchanged(passphrase, storeFieldValue, serialized))) {
    return storeFieldValue;
  }
  return encryptField(passphrase, serialized);
}

// Best-effort JSON parse for prior store content used only to look up old envelopes to reuse —
// unparseable/missing content just means "nothing to reuse", never an error (capture must still
// succeed and fresh-encrypt).
function tryParseJson(content: string | null | undefined): unknown {
  if (content === null || content === undefined) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

async function encryptFields(
  value: unknown,
  patterns: string[],
  passphrase: string,
  matched: Set<string>,
  storeValue: unknown
): Promise<unknown> {
  if (Array.isArray(value)) {
    const storeArr = Array.isArray(storeValue) ? storeValue : [];
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) out.push(await encryptFields(value[i], patterns, passphrase, matched, storeArr[i]));
    return out;
  }
  if (isPlainObject(value)) {
    const storeObj = isPlainObject(storeValue) ? storeValue : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (keyMatchesAny(k, patterns)) {
        matched.add(k);
        out[k] = await reuseOrEncryptField(passphrase, v, storeObj[k]);
      } else {
        out[k] = await encryptFields(v, patterns, passphrase, matched, storeObj[k]);
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
  passphrase: string | null,
  deviceClass: "desktop" | "mobile",
  // Prior store content — used for perItem keys (§3, D3: capturing a shared array must preserve
  // the other device's already-captured elements) AND, since C-#36, to look up an encrypted
  // FIELD's existing envelope so an unchanged plaintext reuses it byte-for-byte instead of
  // re-encrypting with a fresh salt/IV (fieldUnchanged's mac is the deterministic "same
  // plaintext" check — see reuseOrEncryptField). Optional so plain/whole-file-encrypted callers
  // (which never need it) are unaffected.
  storeContent?: string | null,
  // Prior __scopes__ sidecar content for THIS device class — same C-#36 envelope-reuse lookup,
  // but for class-scoped (desktop/mobile) + encrypted:true fields, whose store copy lives in the
  // sidecar rather than the main store body. Optional; omitted callers just always re-encrypt
  // these fields fresh (correct default — no prior sidecar to reuse from).
  priorOwnScopeContent?: string | null
): Promise<{ content: string; note: string | null; ownScope: string | null }> {
  if (group.mode === undefined || group.mode === "plain") {
    if (group.fileRule?.encrypted === true) {
      const pw = requireFileRulePassphrase(group.name, group.path, passphrase, "capture");
      return { content: await encodeFileEnvelope(pw, content), note: "encrypted file", ownScope: null };
    }
    return { content, note: null, ownScope: null };
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    return { content: await encodeFileEnvelope(pw, content), note: "whole file encrypted", ownScope: null };
  }
  // fields
  const pw = requirePassphrase(group, passphrase);
  const parsed = JSON.parse(content) as unknown;
  const strip = excludingPerItem(group, stripPatterns(group));
  const allEncrypt = excludingPerItem(group, allEncryptPatterns(group));
  // Partition BEFORE strip/encrypt: own-class keys go to the sidecar, other-class keys are
  // dropped from this device's base entirely (they belong to the other device's sidecar).
  const own = excludingPerItem(group, classPatterns(group, deviceClass));
  const other = excludingPerItem(group, classPatterns(group, otherClass(deviceClass)));
  let scopeObj: Record<string, unknown> | null = own.length > 0 ? {} : null;
  let parsedBase = parsed;
  if ((own.length > 0 || other.length > 0) && isPlainObject(parsed)) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (own.length > 0 && keyMatchesAny(k, own)) {
        (scopeObj as Record<string, unknown>)[k] = v;
        continue;
      }
      if (other.length > 0 && keyMatchesAny(k, other)) continue;
      rest[k] = v;
    }
    parsedBase = rest;
  }
  const stripped: string[] = [];
  strippedKeyNames(parsedBase, strip, stripped, new Set());
  const afterStrip = strip.length > 0 ? sanitizeJson(parsedBase, strip) : parsedBase;
  const matched = new Set<string>();
  // parsedBase's shape (post class-partition, post strip) mirrors what the PRIOR capture wrote to
  // the store — own/other-class keys already excluded there too — so looking up envelopes to
  // reuse by matching key name against the prior store's parsed content lines up directly.
  const priorStoreParsed = tryParseJson(storeContent);
  const afterEncrypt = allEncrypt.length > 0 ? await encryptFields(afterStrip, allEncrypt, pw, matched, priorStoreParsed) : afterStrip;
  // desktop/mobile + encrypted:true (D1 new combo): encrypt the own-class values BEFORE they
  // land in the sidecar — ciphertext goes into __scopes__, never plaintext.
  const ownEncrypt = excludingPerItem(group, classEncryptPatterns(group, deviceClass));
  let outScope = scopeObj;
  if (scopeObj !== null && ownEncrypt.length > 0) {
    const priorScopeParsed = tryParseJson(priorOwnScopeContent);
    const priorScopeObj = isPlainObject(priorScopeParsed) ? priorScopeParsed : {};
    const enc: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(scopeObj)) {
      enc[k] = keyMatchesAny(k, ownEncrypt) ? await reuseOrEncryptField(pw, v, priorScopeObj[k]) : v;
    }
    outScope = enc;
  }
  const classOnlyNames = scopeObj !== null ? Object.keys(scopeObj) : [];
  // Mark keys that were ALSO encrypted before landing in the sidecar (D1 desktop/mobile+encrypted
  // combo) — otherwise the note reads identically to a plaintext class-scoped key, hiding that
  // ciphertext (not the raw value) is what's sitting in __scopes__.
  const classOnly =
    classOnlyNames.length > 0
      ? `${deviceClass}-only ${classOnlyNames.map((k) => (keyMatchesAny(k, ownEncrypt) ? `${k} (encrypted)` : k)).join(", ")}`
      : null;
  const note = buildNote([...matched], stripped, classOnly);
  // Per-item keys (§3, D3): merge local's all/own-class elements with the prior store's
  // other-class elements, one key at a time. Reads local values from the pristine `parsed`
  // (never from afterEncrypt/parsedBase, which the class partition above never touches for
  // these keys anyway thanks to excludingPerItem, but the raw source is the clearest contract).
  let finalContent = afterEncrypt;
  if (group.perItem !== undefined && Object.keys(group.perItem).length > 0 && isPlainObject(finalContent)) {
    const storeParsed: unknown = storeContent !== null && storeContent !== undefined ? JSON.parse(storeContent) : null;
    const out: Record<string, unknown> = { ...finalContent };
    for (const [key, scopes] of Object.entries(group.perItem)) {
      const localArr = readPerItemArray(parsed, group.name, key, "capture");
      const storeArr = storeParsed === null ? [] : readPerItemArray(storeParsed, group.name, key, "capture");
      out[key] = capturePerItemArray(localArr, storeArr, scopes, deviceClass);
    }
    finalContent = out;
  }
  return {
    content: JSON.stringify(finalContent, null, 2) + "\n",
    note,
    ownScope: outScope === null ? null : JSON.stringify(outScope, null, 2) + "\n",
  };
}

export async function applyTransform(
  group: SyncGroup,
  storeContent: string,
  localContent: string | null,
  passphrase: string | null,
  deviceClass: "desktop" | "mobile",
  ownScopeContent: string | null
): Promise<string> {
  if (group.mode === undefined || group.mode === "plain") {
    if (group.fileRule?.encrypted === true) {
      const pw = requireFileRulePassphrase(group.name, group.path, passphrase, "apply");
      return decodeFileEnvelope(pw, storeContent, group.name);
    }
    return storeContent;
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    return decodeFileEnvelope(pw, storeContent, group.name);
  }
  // fields
  const pw = requirePassphrase(group, passphrase);
  let incoming = await decryptFields(JSON.parse(storeContent) as unknown, pw, group.name);
  if (ownScopeContent !== null && isPlainObject(incoming)) {
    // desktop/mobile + encrypted:true keys land in the sidecar as ciphertext (capture side) —
    // decrypt the overlay the same way the base was decrypted before merging it in.
    const overlay = await decryptFields(JSON.parse(ownScopeContent) as unknown, pw, group.name);
    incoming = { ...incoming, ...(overlay as Record<string, unknown>) };
  }
  const localParsed: unknown = localContent !== null ? (JSON.parse(localContent) as unknown) : null;
  const strip = excludingPerItem(group, stripPatterns(group));
  const own = excludingPerItem(group, classPatterns(group, deviceClass));
  const other = excludingPerItem(group, classPatterns(group, otherClass(deviceClass)));
  // Other-class keys never belong on this device; own-class keys are preserved from local ONLY
  // when there is no sidecar to supply the authoritative value (degradation path).
  const classPreserve = [...other, ...(ownScopeContent === null ? own : [])];
  // Per-item keys (§3, D3): store's all/own-class elements plus local's "local"-scoped elements
  // (the store never carries "local" elements — capture drops them — so this is the only path
  // that keeps them). Reads the store side from `incoming` (post-decrypt; irrelevant here since
  // perItem keys are never encrypted) and the local side from the raw local document.
  const applyPerItem = (base: unknown, localDoc: unknown): unknown => {
    if (group.perItem === undefined || Object.keys(group.perItem).length === 0 || !isPlainObject(base)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [key, scopes] of Object.entries(group.perItem)) {
      const storeArr = readPerItemArray(incoming, group.name, key, "apply");
      const localArr = localDoc === null ? [] : readPerItemArray(localDoc, group.name, key, "apply");
      out[key] = applyPerItemArray(storeArr, localArr, scopes, deviceClass);
    }
    return out;
  };
  if (localContent === null) {
    const dropped = dropTopLevel(incoming, classPreserve);
    return JSON.stringify(applyPerItem(dropped, null), null, 2) + "\n";
  }
  const local = localParsed;
  const merged = strip.length > 0 ? mergePreservingSanitized(local, incoming, strip) : incoming;
  // Class-preserve pass (shallow): local value wins; a stale store copy must not introduce a
  // class-owned key that local doesn't have.
  let out = merged;
  if (classPreserve.length > 0 && isPlainObject(merged)) {
    const o: Record<string, unknown> = { ...merged };
    for (const k of Object.keys(o)) {
      if (keyMatchesAny(k, classPreserve) && !(isPlainObject(local) && k in local)) delete o[k];
    }
    if (isPlainObject(local)) {
      for (const [k, v] of Object.entries(local)) if (keyMatchesAny(k, classPreserve)) o[k] = v;
    }
    out = o;
  }
  return JSON.stringify(applyPerItem(out, local), null, 2) + "\n";
}

export async function contentUnchanged(
  group: SyncGroup,
  localContent: string,
  storeContent: string,
  passphrase: string | null,
  deviceClass: "desktop" | "mobile",
  ownScopeContent: string | null
): Promise<boolean> {
  if (group.mode === undefined || group.mode === "plain") {
    if (group.fileRule?.encrypted === true) {
      const envelope = parseFileEnvelope(storeContent);
      if (envelope === null) return false; // store side isn't a valid envelope: not equal
      // No passphrase: never decrypt-compare (that would be a silent implicit unlock) and never
      // treat local plaintext as equal to store ciphertext — fall back to a literal byte
      // comparison (envelope JSON vs local plaintext), which is safe (never a false "unchanged")
      // even though it will normally read as "changed" while locked.
      if (passphrase === null) return localContent === storeContent;
      return fileUnchanged(passphrase, envelope, localContent);
    }
    return localContent === storeContent;
  }
  if (group.mode === "encrypted") {
    const pw = requirePassphrase(group, passphrase);
    const envelope = parseFileEnvelope(storeContent);
    if (envelope === null) return false;
    return fileUnchanged(pw, envelope, localContent);
  }
  // fields
  const pw = requirePassphrase(group, passphrase);
  const own = excludingPerItem(group, classPatterns(group, deviceClass));
  const other = excludingPerItem(group, classPatterns(group, otherClass(deviceClass)));
  // Symmetric with applyTransform's classPreserve: other-class keys are always ignored; own-class
  // keys are ignored too UNLESS a sidecar is present to overlay the authoritative value.
  const classIgnore = [...other, ...(ownScopeContent === null ? own : [])];
  let storeParsed = JSON.parse(storeContent) as unknown;
  if (ownScopeContent !== null && isPlainObject(storeParsed)) {
    storeParsed = { ...storeParsed, ...(JSON.parse(ownScopeContent) as Record<string, unknown>) };
  }
  let localParsed = JSON.parse(localContent) as unknown;
  const strip = excludingPerItem(group, stripPatterns(group));
  // Per-item keys (§3, D3): a per-item array is a membership list, not a positionally-ordered
  // array — compare it via perItemArrayUnchanged (masks out this device's own blind spots: the
  // other class's elements and "local"-scoped elements, symmetrically on both sides) instead of
  // fieldsUnchanged's strict same-length/same-order array check, then drop the key from the
  // generic comparison below so it isn't checked twice.
  const perItemKeys = group.perItem !== undefined ? Object.keys(group.perItem) : [];
  for (const [key, scopes] of Object.entries(group.perItem ?? {})) {
    const localArr = readPerItemArray(localParsed, group.name, key, "compare");
    const storeArr = readPerItemArray(storeParsed, group.name, key, "compare");
    if (!perItemArrayUnchanged(localArr, storeArr, scopes, deviceClass)) return false;
  }
  // Strip both sides symmetrically: apply keeps the local value for stripped keys, so a store
  // copy that still carries a stripped key (captured before the rule existed) is not a real diff.
  // Without this, the key-count guard in fieldsUnchanged flags a to-apply that applying is a no-op for.
  localParsed = dropTopLevel(strip.length > 0 ? sanitizeJson(localParsed, strip) : localParsed, [...classIgnore, ...perItemKeys]);
  storeParsed = dropTopLevel(strip.length > 0 ? sanitizeJson(storeParsed, strip) : storeParsed, [...classIgnore, ...perItemKeys]);
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
