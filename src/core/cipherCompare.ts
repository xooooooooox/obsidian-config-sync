import { decryptField, decryptFile, fileUnchanged, isFieldEnvelope, parseFileEnvelope } from "./crypto";
import { sameApartFromWithheld } from "./keyWithholding";
import { sortKeysDeep } from "./merge";
import { isPlainObject, sanitizeJson } from "./sanitize";

// Do two store copies of one file hold the same content? THREE answers, not two — because an
// encrypted copy this device cannot open is not a copy that differs, it is a copy we know nothing
// about, and saying "differs" about it is stating a fact we do not have (spec 3.8).
//
// Why the byte comparison every other seam uses is wrong here: each envelope carries its own random
// salt and IV, so the very same setting encrypted in two vaults is different bytes — always, even
// under the same passphrase. Comparing bytes therefore lights a difference no run can ever clear,
// which is exactly the permanent to-do spec 3.3 set out to abolish.
export type ContentVerdict = "same" | "differs" | "cannot";

// Thrown while walking a document whose ciphertext will not open. Caught inside this module and
// turned into "cannot" — it never escapes, and it is deliberately NOT an error the caller handles:
// "we cannot tell" is one of this function's three normal answers, not a failure of it.
class Unopenable extends Error {}

function hasFieldEnvelope(v: unknown): boolean {
  if (isFieldEnvelope(v)) return true;
  if (Array.isArray(v)) return v.some(hasFieldEnvelope);
  if (isPlainObject(v)) return Object.values(v).some(hasFieldEnvelope);
  return false;
}

// A copy of the document with every encrypted leaf replaced by what it says. Pure: the input is
// never touched, which matters because both sides of a comparison are documents somebody else's
// code is still holding.
async function decipherLeaves(v: unknown, passphrase: string | null, groupName: string): Promise<unknown> {
  if (isFieldEnvelope(v)) {
    if (passphrase === null) throw new Unopenable();
    try {
      return await decryptField(passphrase, v, groupName);
    } catch {
      throw new Unopenable();
    }
  }
  if (Array.isArray(v)) return Promise.all(v.map((item) => decipherLeaves(item, passphrase, groupName)));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = await decipherLeaves(val, passphrase, groupName);
    return out;
  }
  return v;
}

// A document that is not JSON is a real outcome here, not an absent one, so it gets its own value
// rather than sharing `undefined` with "the key held undefined".
const NOT_JSON = Symbol("not json");

function parsed(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return NOT_JSON;
  }
}

export async function compareCopies(input: {
  mine: string | null;
  theirs: string | null;
  passphrase: { mine: string | null; theirs: string | null };
  masked: readonly string[];
  groupName: string;
}): Promise<ContentVerdict> {
  const { mine, theirs, passphrase, masked, groupName } = input;
  // One side missing is a plain push or pull row and has nothing to do with passphrases. Whether
  // the other end's passphrase is right is only knowable by trying it, and there is nothing to try
  // (spec 3.8: an item the other end has no copy of says nothing about passphrases at all).
  if (mine === null || theirs === null) return mine === theirs ? "same" : "differs";
  // Two devices sharing one store land here, and pay nothing.
  if (mine === theirs) return "same";

  const envMine = parseFileEnvelope(mine);
  const envTheirs = parseFileEnvelope(theirs);
  // Stored in different FORMS. Not a question we answer by opening them: the run's own transform
  // decides the form, so a form that changed is a difference the next run settles.
  if ((envMine === null) !== (envTheirs === null)) return "differs";

  if (envMine !== null && envTheirs !== null) {
    if (passphrase.mine === null || passphrase.theirs === null) return "cannot";
    let theirsPlain: string;
    try {
      theirsPlain = await decryptFile(passphrase.theirs, envTheirs, groupName);
    } catch {
      return "cannot";
    }
    // The envelope carries an HMAC of its PLAINTEXT, which is what makes this comparison
    // deterministic despite the fresh IV — so the settled case costs one decryption and one HMAC.
    // It cannot, however, tell a wrong passphrase from changed content: both come back false. That
    // distinction IS the third answer, so a false sends us to open our own copy and find out which.
    if (masked.length === 0 && (await fileUnchanged(passphrase.mine, envMine, theirsPlain))) return "same";
    let minePlain: string;
    try {
      minePlain = await decryptFile(passphrase.mine, envMine, groupName);
    } catch {
      return "cannot";
    }
    return sameApartFromWithheld({ a: minePlain, b: theirsPlain, patterns: masked }) ? "same" : "differs";
  }

  const docMine = parsed(mine);
  const docTheirs = parsed(theirs);
  // Not JSON on one side or the other, or no ciphertext anywhere in either: the existing comparison
  // is the whole answer, and it has only two of them. Keeping ONE implementation of the plain path
  // is why this delegates rather than reimplementing the mask-and-normalise dance.
  if (docMine === NOT_JSON || docTheirs === NOT_JSON || !(hasFieldEnvelope(docMine) || hasFieldEnvelope(docTheirs))) {
    return sameApartFromWithheld({ a: mine, b: theirs, patterns: masked }) ? "same" : "differs";
  }

  const patterns = [...masked];
  try {
    const a = await decipherLeaves(sanitizeJson(docMine, patterns), passphrase.mine, groupName);
    const b = await decipherLeaves(sanitizeJson(docTheirs, patterns), passphrase.theirs, groupName);
    return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b)) ? "same" : "differs";
  } catch (e) {
    if (e instanceof Unopenable) return "cannot";
    throw e;
  }
}
