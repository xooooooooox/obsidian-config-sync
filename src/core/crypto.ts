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
