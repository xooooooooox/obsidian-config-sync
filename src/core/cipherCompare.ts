import { decryptField, decryptFile, isFieldEnvelope, parseFileEnvelope } from "./crypto";
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
export type ContentVerdict = "same" | "differs" | { cannot: "here" | "there" };

// The side that could not be opened: "here" = this device's own passphrase is absent or wrong,
// "there" = the key we hold for the remote does not open its copy. When both fail, "here" wins —
// the user can only fix what is theirs to fix, and sending them to the remote's settings while
// their own passphrase is wrong would have them fix the wrong thing first.
export function isCannot(v: ContentVerdict): v is { cannot: "here" | "there" } {
  return typeof v !== "string";
}

// Thrown while walking a document whose ciphertext will not open. Caught inside this module and
// turned into a `cannot` — it never escapes, and it is deliberately NOT an error the caller
// handles: "we cannot tell" is one of this function's three normal answers, not a failure of it.
class Unopenable extends Error {
  constructor(public side: "here" | "there") {
    super();
  }
}

function hasFieldEnvelope(v: unknown): boolean {
  if (isFieldEnvelope(v)) return true;
  if (Array.isArray(v)) return v.some(hasFieldEnvelope);
  if (isPlainObject(v)) return Object.values(v).some(hasFieldEnvelope);
  return false;
}

// A copy of the document with every encrypted leaf replaced by what it says. Pure: the input is
// never touched, which matters because both sides of a comparison are documents somebody else's
// code is still holding.
async function decipherLeaves(v: unknown, passphrase: string | null, side: "here" | "there", groupName: string): Promise<unknown> {
  if (isFieldEnvelope(v)) {
    if (passphrase === null) throw new Unopenable(side);
    try {
      return await decryptField(passphrase, v, groupName);
    } catch {
      throw new Unopenable(side);
    }
  }
  if (Array.isArray(v)) return Promise.all(v.map((item) => decipherLeaves(item, passphrase, side, groupName)));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = await decipherLeaves(val, passphrase, side, groupName);
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
    if (passphrase.mine === null) return { cannot: "here" };
    if (passphrase.theirs === null) return { cannot: "there" };
    // Our own copy opens (or fails) first — see isCannot's ordering note. Decrypting it here is
    // not the fast path's extra cost: a wrong local passphrase would fail the HMAC check below
    // anyway and force this same decryption to find out why.
    let minePlain: string | null;
    try {
      minePlain = await decryptFile(passphrase.mine, envMine, groupName);
    } catch {
      return { cannot: "here" };
    }
    let theirsPlain: string;
    try {
      theirsPlain = await decryptFile(passphrase.theirs, envTheirs, groupName);
    } catch {
      return { cannot: "there" };
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
    // Our own side first, whole, so a failure here is reported before one over there (isCannot's
    // ordering note) even when both sides hold unreadable leaves.
    const a = await decipherLeaves(sanitizeJson(docMine, patterns), passphrase.mine, "here", groupName);
    const b = await decipherLeaves(sanitizeJson(docTheirs, patterns), passphrase.theirs, "there", groupName);
    return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b)) ? "same" : "differs";
  } catch (e) {
    if (e instanceof Unopenable) return { cannot: e.side };
    throw e;
  }
}
