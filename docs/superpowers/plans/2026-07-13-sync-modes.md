# Per-Item Sync Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every item gets a user-chosen sync mode — Plain (as today), Fields (per-key strip/encrypt), Encrypt (whole file) — backed by a vault-level passphrase; sensitive-key detection informs the user in settings; the hardcoded plugin blacklist is deleted.

**Architecture:** New pure core modules: `src/core/crypto.ts` (Web Crypto envelopes + deterministic HMAC comparison) and `src/core/modes.ts` (field-rule transforms, scanner). `types/manifest/schema` gain `mode`/`fields` and drop `sanitize` and the blacklist. `ConfigSyncCore`/`status` dispatch on mode and add a `locked` state when a passphrase is needed but unset. UI: SettingTab mode segments + fields editor + passphrase; SyncCenterView badges + locked treatment.

**Tech Stack:** TypeScript, `globalThis.crypto.subtle` (renderer + Node ≥18; no new dependencies), Obsidian API, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-sync-modes-design.md`. Visual ground truth: `.superpowers/brainstorm/9047-1783841141/content/iter20-sync-modes.html`.

## Global Constraints

- Gate per task: `npm test && npm run build && npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/core/*`: no `obsidian`/Node imports; crypto via `globalThis.crypto.subtle` only.
- Crypto exact parameters: PBKDF2-SHA256, **210000** iterations, 16-byte random salt, derive 64 bytes → first 32 = AES-256-GCM key, last 32 = HMAC-SHA256 key; 12-byte random IV. Whole-file envelope JSON: `{"csenc":1,"salt":"<b64>","iv":"<b64>","ct":"<b64>","mac":"<b64>"}` with `mac = HMAC(plaintext)`. Field envelope string: `enc:v1:<salt_b64>:<iv_b64>:<ct_b64>:<mac_b64>`.
- Deterministic comparison rule everywhere (status, capture compare-before-write): unchanged iff HMAC(local plaintext) under the envelope's salt equals envelope `mac` — never compare ciphertext bytes.
- `SyncGroup.sanitize` is REMOVED; configs containing it fail validation with: `group "{name}": "sanitize" was replaced by "mode": "fields" with "fields" rules`.
- Blacklist (`BLACKLISTED_PLUGIN_DIRS`, its validation, the plugins "Not recommended" section) deleted; the workspace-file "Not recommended" section stays.
- Copy verbatim per spec §Copy strings (mode segments `Plain`/`Fields`/`Encrypt`; actions `Strip`/`Encrypt`; badges `⚠ {n} sensitive-looking keys` / `⚠ opaque encrypted blob`; errors `passphrase not set on this device — Settings → General` and `cannot decrypt "{group}" — wrong passphrase on this device?`; locked note `encrypted — set the passphrase in Settings → General to compare or apply`; placeholder `Add key pattern… e.g. *Token*`).
- Passphrase lives ONLY in `app.saveLocalStorage("config-sync-passphrase")`; never in any file.
- New `GroupState` `"locked"`: bucketed into `none`; visible in the `all` filter only; checkbox disabled; icon `🔒`.
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read output, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: `src/core/crypto.ts` — envelopes + deterministic compare

**Files:**
- Create: `src/core/crypto.ts`
- Test: `tests/crypto.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3-4 verbatim):

```ts
export interface FileEnvelope { csenc: 1; salt: string; iv: string; ct: string; mac: string }
export function isFileEnvelope(v: unknown): v is FileEnvelope;
export function parseFileEnvelope(content: string): FileEnvelope | null; // JSON parse + isFileEnvelope, null otherwise
export async function encryptFile(passphrase: string, plaintext: string): Promise<string>; // serialized envelope JSON + "\n"
export async function decryptFile(passphrase: string, envelope: FileEnvelope, groupName: string): Promise<string>; // throws DecryptError
export async function fileUnchanged(passphrase: string, envelope: FileEnvelope, localPlaintext: string): Promise<boolean>;
export function isFieldEnvelope(v: unknown): v is string; // string starting with "enc:v1:"
export async function encryptField(passphrase: string, plaintext: string): Promise<string>; // "enc:v1:..."
export async function decryptField(passphrase: string, envelope: string, groupName: string): Promise<string>;
export async function fieldUnchanged(passphrase: string, envelope: string, localPlaintext: string): Promise<boolean>;
export class DecryptError extends Error {} // message: `cannot decrypt "${groupName}" — wrong passphrase on this device?`
```

- [ ] **Step 1: Failing tests** — create `tests/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DecryptError, decryptField, decryptFile, encryptField, encryptFile,
  fieldUnchanged, fileUnchanged, isFieldEnvelope, parseFileEnvelope,
} from "../src/core/crypto";

describe("file envelopes", () => {
  it("round-trips and compares deterministically", async () => {
    const enc = await encryptFile("pw", '{"a":1}');
    const env = parseFileEnvelope(enc);
    expect(env).not.toBeNull();
    if (env === null) throw new Error("unreachable");
    expect(await decryptFile("pw", env, "g")).toBe('{"a":1}');
    expect(await fileUnchanged("pw", env, '{"a":1}')).toBe(true);
    expect(await fileUnchanged("pw", env, '{"a":2}')).toBe(false);
    // two captures of the same plaintext produce different ciphertext but both compare unchanged
    const enc2 = await encryptFile("pw", '{"a":1}');
    expect(enc2).not.toBe(enc);
  });

  it("wrong passphrase fails with the verbatim error", async () => {
    const env = parseFileEnvelope(await encryptFile("pw", "x"));
    if (env === null) throw new Error("unreachable");
    await expect(decryptFile("other", env, "hotkeys")).rejects.toThrowError(
      'cannot decrypt "hotkeys" — wrong passphrase on this device?'
    );
    await expect(decryptFile("other", env, "hotkeys")).rejects.toBeInstanceOf(DecryptError);
  });

  it("parseFileEnvelope rejects ordinary json and junk", () => {
    expect(parseFileEnvelope('{"a":1}')).toBeNull();
    expect(parseFileEnvelope("not json")).toBeNull();
  });
});

describe("field envelopes", () => {
  it("round-trips, detects, compares", async () => {
    const f = await encryptField("pw", "secret-token");
    expect(isFieldEnvelope(f)).toBe(true);
    expect(isFieldEnvelope("plain")).toBe(false);
    expect(await decryptField("pw", f, "g")).toBe("secret-token");
    expect(await fieldUnchanged("pw", f, "secret-token")).toBe(true);
    expect(await fieldUnchanged("pw", f, "other")).toBe(false);
    await expect(decryptField("bad", f, "g")).rejects.toBeInstanceOf(DecryptError);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run tests/crypto.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/core/crypto.ts`:

```ts
// AES-256-GCM envelopes with a PBKDF2-derived key pair (encrypt + HMAC).
// The HMAC of the PLAINTEXT rides in the envelope so comparison is deterministic
// even though every encryption uses a fresh IV. Uses globalThis.crypto.subtle —
// available in the Obsidian renderer and Node >= 18; no imports needed.

export class DecryptError extends Error {}

export interface FileEnvelope {
  csenc: 1;
  salt: string;
  iv: string;
  ct: string;
  mac: string;
}

const PBKDF2_ITERATIONS = 210000;

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface DerivedKeys {
  aes: CryptoKey;
  mac: CryptoKey;
}

async function deriveKeys(passphrase: string, salt: Uint8Array): Promise<DerivedKeys> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    base,
    512
  );
  const bytes = new Uint8Array(bits);
  const aes = await subtle.importKey("raw", bytes.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const mac = await subtle.importKey("raw", bytes.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { aes, mac };
}

async function hmac(key: CryptoKey, plaintext: string): Promise<string> {
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(plaintext));
  return toB64(sig);
}

interface RawEnvelope {
  salt: string;
  iv: string;
  ct: string;
  mac: string;
}

async function encryptRaw(passphrase: string, plaintext: string): Promise<RawEnvelope> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const keys = await deriveKeys(passphrase, salt);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    keys.aes,
    new TextEncoder().encode(plaintext)
  );
  return { salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), mac: await hmac(keys.mac, plaintext) };
}

async function decryptRaw(passphrase: string, env: RawEnvelope, groupName: string): Promise<string> {
  const keys = await deriveKeys(passphrase, fromB64(env.salt));
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(env.iv) as BufferSource },
      keys.aes,
      fromB64(env.ct) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new DecryptError(`cannot decrypt "${groupName}" — wrong passphrase on this device?`);
  }
}

async function unchangedRaw(passphrase: string, env: RawEnvelope, localPlaintext: string): Promise<boolean> {
  const keys = await deriveKeys(passphrase, fromB64(env.salt));
  return (await hmac(keys.mac, localPlaintext)) === env.mac;
}

export function isFileEnvelope(v: unknown): v is FileEnvelope {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o["csenc"] === 1 && typeof o["salt"] === "string" && typeof o["iv"] === "string" && typeof o["ct"] === "string" && typeof o["mac"] === "string";
}

export function parseFileEnvelope(content: string): FileEnvelope | null {
  try {
    const v: unknown = JSON.parse(content);
    return isFileEnvelope(v) ? v : null;
  } catch {
    return null;
  }
}

export async function encryptFile(passphrase: string, plaintext: string): Promise<string> {
  const raw = await encryptRaw(passphrase, plaintext);
  const env: FileEnvelope = { csenc: 1, ...raw };
  return JSON.stringify(env) + "\n";
}

export async function decryptFile(passphrase: string, envelope: FileEnvelope, groupName: string): Promise<string> {
  return decryptRaw(passphrase, envelope, groupName);
}

export async function fileUnchanged(passphrase: string, envelope: FileEnvelope, localPlaintext: string): Promise<boolean> {
  return unchangedRaw(passphrase, envelope, localPlaintext);
}

const FIELD_PREFIX = "enc:v1:";

export function isFieldEnvelope(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(FIELD_PREFIX);
}

function parseFieldEnvelope(envelope: string): RawEnvelope | null {
  const parts = envelope.slice(FIELD_PREFIX.length).split(":");
  const [salt, iv, ct, mac] = parts;
  if (parts.length !== 4 || salt === undefined || iv === undefined || ct === undefined || mac === undefined) return null;
  return { salt, iv, ct, mac };
}

export async function encryptField(passphrase: string, plaintext: string): Promise<string> {
  const raw = await encryptRaw(passphrase, plaintext);
  return `${FIELD_PREFIX}${raw.salt}:${raw.iv}:${raw.ct}:${raw.mac}`;
}

export async function decryptField(passphrase: string, envelope: string, groupName: string): Promise<string> {
  const raw = parseFieldEnvelope(envelope);
  if (raw === null) throw new DecryptError(`cannot decrypt "${groupName}" — wrong passphrase on this device?`);
  return decryptRaw(passphrase, raw, groupName);
}

export async function fieldUnchanged(passphrase: string, envelope: string, localPlaintext: string): Promise<boolean> {
  const raw = parseFieldEnvelope(envelope);
  if (raw === null) return false;
  return unchangedRaw(passphrase, raw, localPlaintext);
}
```

(base64 salt/iv/ct/mac contain no `:`, so the 4-way split is unambiguous. If lint flags `btoa`/`atob` as undefined in the core lint profile, use the same manual base64 tables instead — do not import Node `Buffer`.)

- [ ] **Step 4: Verify pass** — `npx vitest run tests/crypto.test.ts` (crypto tests take a few seconds; PBKDF2 is intentionally slow).
- [ ] **Step 5: Gate + commit**

```bash
git add src/core/crypto.ts tests/crypto.test.ts
git commit -m "feat: AES-GCM envelopes with deterministic HMAC comparison"
```

---

### Task 2: Schema — `mode`/`fields`, blacklist removal, scanner

**Files:**
- Modify: `src/core/types.ts`, `src/core/manifest.ts`, `src/core/catalog.ts`, `schema/config-sync.schema.json`
- Create: scanner in `src/core/modes.ts` (this task creates the file with the scanner only; Task 3 adds transforms)
- Test: `tests/manifest.test.ts` (extend), `tests/modes.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// types.ts
export type SyncMode = "plain" | "fields" | "encrypted";
export interface FieldRule { pattern: string; action: "strip" | "encrypt" }
// SyncGroup: `sanitize?: string[]` REMOVED; added: `mode?: SyncMode; fields?: FieldRule[]`
// modes.ts
export const SENSITIVE_KEY_PATTERNS = ["apikey", "api_key", "token", "secret", "password", "credential", "auth", "cookie", "email"];
export interface SensitiveScan { keys: string[]; blob: boolean }
export function scanSensitive(content: string): SensitiveScan;
export function groupNeedsPassphrase(group: SyncGroup): boolean; // mode==="encrypted" || (mode==="fields" && fields some action==="encrypt")
```

- [ ] **Step 1: Failing tests**

`tests/modes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanSensitive, groupNeedsPassphrase } from "../src/core/modes";
import { SyncGroup } from "../src/core/types";

describe("scanSensitive", () => {
  it("finds sensitive-looking keys recursively, case-insensitive", () => {
    const s = scanSensitive(JSON.stringify({ updateAPIKey: "x", nested: { myToken: "y", plain: 1 }, userEmail: "e" }));
    expect(s.keys.sort()).toEqual(["myToken", "updateAPIKey", "userEmail"]);
    expect(s.blob).toBe(false);
  });

  it("detects an opaque blob: one string >=1024 chars making >80% of the file", () => {
    const s = scanSensitive(JSON.stringify({ readme: "hi", d: "A".repeat(5000) }));
    expect(s.blob).toBe(true);
  });

  it("non-JSON content scans clean", () => {
    expect(scanSensitive("body { color: red }")).toEqual({ keys: [], blob: false });
  });
});

describe("groupNeedsPassphrase", () => {
  const base = { name: "g", path: "{configDir}/x.json", type: "file", devices: "all" } as unknown as SyncGroup;
  it("true for encrypted mode and for fields with an encrypt action", () => {
    expect(groupNeedsPassphrase({ ...base, mode: "encrypted" })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "encrypt" }] })).toBe(true);
    expect(groupNeedsPassphrase({ ...base, mode: "fields", fields: [{ pattern: "a", action: "strip" }] })).toBe(false);
    expect(groupNeedsPassphrase(base)).toBe(false);
  });
});
```

`tests/manifest.test.ts` — append (mirror the file's existing validation-test style):

```ts
  it("accepts mode/fields, rejects legacy sanitize and bad modes", () => {
    // valid: mode "fields" with rules; mode "encrypted"; no mode
    // invalid: sanitize present -> error containing '"sanitize" was replaced by "mode": "fields"'
    // invalid: mode "fields" on a dir group -> error; unknown mode -> error; fields without mode "fields" -> error
  });
```

Write the real bodies against the file's existing fixtures; the assertion contracts above are binding. Also DELETE the existing test(s) that assert blacklist rejection (they assert removed behavior) and the existing `sanitize`-based tests in `tests/status.test.ts`/`tests/core.test.ts` must be UPDATED in Task 3 (do not touch them in this task; keep the `sanitize` field temporarily accepted? NO —) **Sequencing note:** removing `sanitize` from types breaks the existing sanitize tests in core/status suites. In THIS task, convert those fixtures mechanically: `sanitize: ["*Token*"]` → `mode: "fields", fields: [{ pattern: "*Token*", action: "strip" }]`, and the corresponding core code paths keep compiling because Task 2 ALSO does the minimal rename in `ConfigSyncCore.ts`/`status.ts`: replace `group.sanitize !== undefined` with `stripPatterns(group).length > 0` where `modes.ts` exports:

```ts
export function stripPatterns(group: SyncGroup): string[] {
  if (group.mode !== "fields" || group.fields === undefined) return [];
  return group.fields.filter((f) => f.action === "strip").map((f) => f.pattern);
}
```

and the three call sites (`ConfigSyncCore.ts:171-173`, `:319-322`, `status.ts` compareFile sanitize branch) use `stripPatterns(group)` in place of `group.sanitize`. Encrypt actions and encrypted mode are implemented in Task 3 — until then they are accepted by the schema but behave as plain (documented in this task's report).

- [ ] **Step 2: Implement**

`types.ts`: add `SyncMode`, `FieldRule`; on `SyncGroup` remove `sanitize`, add `mode?: SyncMode`, `fields?: FieldRule[]`.

`modes.ts` (new): `SENSITIVE_KEY_PATTERNS`, `scanSensitive` (JSON.parse in try/catch → walk keys recursively, `keys` = key names whose lowercase includes any pattern, deduped; `blob` = any single string value with `length >= 1024 && length / content.length > 0.8`), `groupNeedsPassphrase`, `stripPatterns`.

`manifest.ts`: validation — reject `sanitize` with the verbatim message; accept `mode` in {plain, fields, encrypted} (absent = plain); `fields` only with `mode: "fields"`; `mode: "fields"` only on `type: "file"`; each rule `{pattern: non-empty string, action: "strip"|"encrypt"}`. DELETE `BLACKLISTED_PLUGIN_DIRS` and both blacklist checks (lines ~106-115).

`catalog.ts`: remove the `BLACKLISTED_PLUGIN_DIRS` import, `BLACKLIST_REASON`, the `disabledReason` blacklist branch (line ~297) and the plugins `notRecommended` section (line ~307 block). The workspace-files notRecommended sections (lines ~213, ~265) stay.

`schema/config-sync.schema.json`: remove `sanitize`; add `mode` enum and `fields` array of `{pattern, action}` mirroring the validation.

- [ ] **Step 3: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/core/types.ts src/core/manifest.ts src/core/catalog.ts src/core/modes.ts schema/config-sync.schema.json tests/modes.test.ts tests/manifest.test.ts tests/status.test.ts tests/core.test.ts tests/catalog.test.ts
git commit -m "feat: sync-mode schema, sensitive-key scanner, blacklist removed"
```

---

### Task 3: Pipeline — encrypt/decrypt through capture/apply/status

**Files:**
- Modify: `src/core/modes.ts` (transforms), `src/core/ConfigSyncCore.ts`, `src/core/status.ts`
- Test: `tests/modes.test.ts`, `tests/core.test.ts`, `tests/status.test.ts`

**Interfaces:**
- Consumes: Task 1 crypto API; Task 2 schema/`stripPatterns`.
- Produces:

```ts
// modes.ts additions
export async function captureTransform(group: SyncGroup, content: string, passphrase: string | null): Promise<{ content: string; note: string | null }>;
// plain -> content unchanged, note null
// fields -> strips strip-rules, encrypts encrypt-rule values (JSON.stringify(v) plaintext) via encryptField; note like "encrypted updateAPIKey, userAPIKey · stripped userEmail" (omit empty halves)
// encrypted -> whole content via encryptFile; note "whole file encrypted"
// throws PassphraseNeededError when groupNeedsPassphrase && passphrase === null
export async function applyTransform(group: SyncGroup, storeContent: string, localContent: string | null, passphrase: string | null): Promise<string>;
// plain -> storeContent; fields -> decrypt enc fields, merge stripped keys from local (mergePreservingSanitized with stripPatterns); encrypted -> decryptFile
export async function contentUnchanged(group: SyncGroup, localContent: string, storeContent: string, passphrase: string | null): Promise<boolean>;
// the deterministic compare for all three modes; throws PassphraseNeededError like above
export class PassphraseNeededError extends Error {} // message verbatim: passphrase not set on this device — Settings → General
// CoreContext (ConfigSyncCore.ts) gains: passphrase: string | null
// GroupState gains "locked"; bucketCounts: locked -> none
```

- [ ] **Step 1: Failing tests** (append to `tests/modes.test.ts`; use real crypto):

```ts
describe("captureTransform / applyTransform round-trip", () => {
  const group = (over: object): SyncGroup =>
    ({ name: "g", path: "{configDir}/x.json", type: "file", devices: "all", ...over }) as SyncGroup;
  const src = JSON.stringify({ updateAPIKey: "tok", userEmail: "e@x", theme: "dark" }, null, 2);

  it("fields mode strips and encrypts, and apply restores the exact original", async () => {
    const g = group({ mode: "fields", fields: [
      { pattern: "updateAPIKey", action: "encrypt" },
      { pattern: "userEmail", action: "strip" },
    ]});
    const cap = await captureTransform(g, src, "pw");
    expect(cap.note).toBe("encrypted updateAPIKey · stripped userEmail");
    const stored = JSON.parse(cap.content) as Record<string, unknown>;
    expect(isFieldEnvelope(stored["updateAPIKey"])).toBe(true);
    expect(stored["userEmail"]).toBeUndefined();
    expect(stored["theme"]).toBe("dark");
    const restored = await applyTransform(g, cap.content, src, "pw");
    expect(JSON.parse(restored)).toEqual(JSON.parse(src));
    expect(await contentUnchanged(g, src, cap.content, "pw")).toBe(true);
    const changed = JSON.stringify({ updateAPIKey: "tok2", userEmail: "e@x", theme: "dark" }, null, 2);
    expect(await contentUnchanged(g, changed, cap.content, "pw")).toBe(false);
  });

  it("encrypted mode round-trips and compares", async () => {
    const g = group({ mode: "encrypted" });
    const cap = await captureTransform(g, src, "pw");
    expect(cap.note).toBe("whole file encrypted");
    expect(parseFileEnvelope(cap.content)).not.toBeNull();
    expect(await applyTransform(g, cap.content, null, "pw")).toBe(src);
    expect(await contentUnchanged(g, src, cap.content, "pw")).toBe(true);
  });

  it("throws PassphraseNeededError without a passphrase", async () => {
    const g = group({ mode: "encrypted" });
    await expect(captureTransform(g, src, null)).rejects.toThrowError(
      "passphrase not set on this device — Settings → General"
    );
  });
});
```

`tests/core.test.ts` / `tests/status.test.ts` additions (write against existing MemFS fixtures; contracts binding):
- capture of an `encrypted`-mode group stores an envelope; re-capture with unchanged local writes nothing (`filesUpdated` empty on second run); apply restores byte-identical content.
- status: encrypted group in-sync after capture; local edit → actionable; `ctx.passphrase = null` with an encrypted group → state `locked`; `bucketCounts` puts `locked` in `none`.

- [ ] **Step 2: Implement**

`modes.ts`: the three functions + `PassphraseNeededError`. Fields-encrypt walks the parsed JSON like `sanitizeJson` (reuse `keyMatchesAny`); plaintext for a field envelope is `JSON.stringify(value)`; apply parses the envelope back with `JSON.parse(await decryptField(...))`. Note strings: `encrypted {names} · stripped {names}` with matched KEY NAMES (deduped, insertion order), halves omitted when empty.

`ConfigSyncCore.ts`:
- `CoreContext` gains `passphrase: string | null`.
- `captureGroup` file branch: replace the sanitize/stripPatterns block with `const t = await captureTransform(group, content, ctx.passphrase); content = t.content;` and when `t.note !== null` push `t.note` onto `result.messages`. Dir branch with `mode: "encrypted"`: each file's content goes through `encryptFile`; compare-before-write via `contentUnchanged`.
- `writeClassified` currently byte-compares before writing — for mode-affected content pass a comparator: add an optional `unchanged?: (existing: string) => Promise<boolean>` parameter used instead of `existing === content` when provided; capture supplies `(existing) => contentUnchanged(group, plainLocalContent, existing, ctx.passphrase)`.
- `applyGroup`: store content through `applyTransform(group, storeContent, localContentOrNull, ctx.passphrase)` before writing (replaces the mergePreservingSanitized branch).
- Pull/push (`importExternal`/`pushExternal`) move store→store and remain byte-level: NO decryption there (envelopes travel as-is).
- `PassphraseNeededError`/`DecryptError` propagate to the existing per-group error handling (they surface as group errors with their verbatim messages).

`status.ts`:
- `GroupState` gains `"locked"`. In `groupStatus`, before comparing: if `groupNeedsPassphrase(group) && ctx.passphrase === null` → `{ group, state: "locked" }`.
- `compareFile`: when the store content parses as a file envelope or the group mode is `fields`/`encrypted`, equality = `await contentUnchanged(group, liveContent, storeContent, ctx.passphrase)` (replacing the sanitize-canonical branch).
- `compareDir` for encrypted dirs: per-file equality via `contentUnchanged`.
- `bucketCounts`: `locked` counts into `none`.

`main.ts` is NOT in this task (Task 5 wires the real passphrase); for now every `coreContext()` construction in tests supplies `passphrase` explicitly; add `passphrase: null` to `main.ts`'s `coreContext()` return object as the one-line compile fix.

- [ ] **Step 3: Gate + commit**

```bash
git add src/core/modes.ts src/core/ConfigSyncCore.ts src/core/status.ts src/main.ts tests/modes.test.ts tests/core.test.ts tests/status.test.ts
git commit -m "feat: capture/apply/status dispatch on sync mode with encryption"
```

---

### Task 4: Settings UI — mode segments, fields editor, passphrase

**Files:**
- Modify: `src/ui/SettingTab.ts`, `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: Task 2 `SyncMode`/`FieldRule`/`scanSensitive`/`SENSITIVE_KEY_PATTERNS`; Task 3 pipeline.
- Produces: `main.ts` exposes `passphrase(): string | null` reading `this.app.loadLocalStorage("config-sync-passphrase")` (normalize `""`→null) and `setPassphrase(v: string | null)` via `saveLocalStorage`; `coreContext()` supplies it.

- [ ] **Step 1: Passphrase plumbing** — `main.ts`: the two methods above; `coreContext()` sets `passphrase: this.passphrase()`.
- [ ] **Step 2: General tab** — a `Passphrase` setting (name/desc verbatim from spec) with a password-type text input prefilled masked, `Set` writes (empty string clears) and a status fragment `set on this device` / `not set`. Follow the tab's existing Setting patterns.
- [ ] **Step 3: Mode control per item row** — in the item-row builder used by the picker sections: when the item is enabled, render a three-segment control (`Plain`/`Fields`/`Encrypt`; for `dir`-type items omit `Fields`) reflecting `group.mode ?? "plain"`; changing it updates the group in `config-sync.json` (same write path the toggles use). Segment CSS reuses `.config-sync-seg`/`.config-sync-seg-btn` with a new neutral `.is-mode.is-on` accent fill.
- [ ] **Step 4: Detection badges** — when rendering each item row, read the item's live file(s) (existing resolved-path helpers; dir items scan each file) and run `scanSensitive`; on hits add badge text `⚠ {n} sensitive-looking keys` (or `⚠ opaque encrypted blob`) after the name and append `Detected: {keys}` to the description. When the user switches a detected item to `Fields` and the group has no `fields` yet, prefill rules from the detected keys: action `encrypt` for keys matching `apikey|api_key|token|secret|password|credential`, else `strip`. Blob-detected items: switching modes suggests nothing extra (Encrypt is the sensible pick; no forced behavior).
- [ ] **Step 5: Fields editor** — under a `Fields`-mode item row: one row per rule (`pattern` mono text + `detected` tag when it came from prefill + `Strip|Encrypt` two-segment + ✕ remove), plus an add row (input placeholder verbatim `Add key pattern… e.g. *Token*` + `Add` button). All edits persist to the manifest immediately.
- [ ] **Step 6: CSS** — segment mode variant, badge (`.config-sync-detect-badge` amber pill), fields-editor rows; follow existing settings CSS patterns.
- [ ] **Step 7: Gate + commit**

```bash
git add src/ui/SettingTab.ts src/main.ts styles.css
git commit -m "feat: per-item sync mode controls, fields editor, and vault passphrase setting"
```

---

### Task 5: Sync Center — badges, locked state, report notes

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `src/ui/panelModel.ts`, `styles.css`
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `GroupState "locked"`; `SyncGroup.mode`; capture report notes already flow through `GroupResult.messages` (ReportModal renders messages today — verify, don't change).

- [ ] **Step 1: panelModel** — failing test then implement: `visibleUnderFilter("locked", "all")` true, all other filters false; (bucketCounts already handled in Task 3 core tests).
- [ ] **Step 2: SyncCenterView** —
  - `stateIcon` gains `locked`: `{ glyph: "🔒", cls: "is-locked", tip: "encrypted — set the passphrase in settings to compare" }`.
  - `renderItemRow`: `inert` includes `locked` (checkbox disabled); mode badge span after the name when `group.mode === "encrypted"` (`🔒`) or `"fields"` (`▤`), cls `config-sync-mode-badge`.
  - `renderItemDetail`: `locked` branch note verbatim `encrypted — set the passphrase in Settings → General to compare or apply`; no buttons.
  - Trailing-line handling: `locked` rows render as normal inert rows in the All view (NOT in the ✓/○ fold lines) — same as `no-settings` pre-iter17 handling: they fall into `active` because they're not `in-sync`/`no-settings`; verify the checkbox-disabled path keeps them unstageable.
- [ ] **Step 3: CSS** — `.config-sync-mode-badge { color: var(--text-faint); font-size: 10px; }`, `.config-sync-state-icon.is-locked { color: var(--color-cyan); }`.
- [ ] **Step 4: Gate + commit**

```bash
git add src/ui/SyncCenterView.ts src/ui/panelModel.ts styles.css tests/panelModel.test.ts
git commit -m "feat: sync center surfaces mode badges and the locked state"
```

---

### Task 6: Live smoke + docs

**Files:**
- Modify: `README.md`, `README.zh.md` (new "Sensitive settings" section: modes, passphrase contract incl. same-passphrase-on-each-device, what travels), `docs/assets/` screenshot only if settings visuals warrant it.

- [ ] **Step 1** (guard first, standalone): `npm run smoke:install`, reload.
- [ ] **Step 2: End-to-end encrypt** — set passphrase via settings; add a `mode: "encrypted"` group for a real file; capture → store shows `{"csenc":1,...}`; edit local → status actionable; re-capture unchanged content → no writes; delete local file → apply → byte-identical restore; capture report shows `whole file encrypted`.
- [ ] **Step 3: Fields mode** — stage a JSON with `updateAPIKey`/`userEmail`; settings shows `⚠ 2 sensitive-looking keys`; switch to Fields → prefilled rules (encrypt/strip split per pattern class); capture → store JSON has `enc:v1:` value + missing stripped key; report note `encrypted updateAPIKey · stripped userEmail`; apply on wiped local restores original except stripped key handling (local value preserved when present).
- [ ] **Step 4: Locked** — clear passphrase; encrypted item shows 🔒 locked, disabled, note verbatim; capture/apply of it errors verbatim; other items unaffected. Restore passphrase.
- [ ] **Step 5: Wrong passphrase** — set a different passphrase; apply of encrypted item errors `cannot decrypt … wrong passphrase…`, file untouched. Restore.
- [ ] **Step 6: Blacklist gone** — settings shows the five formerly-blacklisted plugins toggleable with detection badges; no "Not recommended" plugins section; `remotely-save` shows `⚠ opaque encrypted blob`.
- [ ] **Step 7: Sync Center** — 🔒/▤ badges, locked row treatment.
- [ ] **Step 8: Clean up** staging + passphrase state; `dev:errors` clean; commit docs.

```bash
git add README.md README.zh.md
git commit -m "docs: sensitive-settings sync modes and passphrase"
```

---

## Verification after all tasks

1. Full gate. `grep -rn "sanitize\|BLACKLISTED" src/` → only `mergePreservingSanitized`/`sanitizeJson` internals remain in sanitize.ts (used by modes.ts) — no `SyncGroup.sanitize`, no blacklist.
2. Smoke evidence in ledger for steps 2-7.
3. Ledger records iter20; merge --no-ff + cut 0.17.0 are pre-authorized by the user.
