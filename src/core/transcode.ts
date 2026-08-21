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
import { FileIO, listFilesRecursive } from "./io";
import { groupHasCiphertext } from "./modes";
import { RemoteKey } from "./remotePassphrase";
import { groupStorePath, sidecarStoreSuffix } from "./pathing";
import { isPlainObject } from "./sanitize";
import { GroupResult, ItemRef, SyncGroup } from "./types";

// A file that cannot be carried across: its ciphertext will not open under the key it was said to
// answer to, or there is no key to re-encrypt it under. Thrown from the PLANNING stage of either
// seam, where nothing has been written yet — so it aborts a run rather than corrupting one. The
// preflight below exists to turn the foreseeable cases into per-item skips instead (spec 3.9.2);
// what still throws is the window in between, e.g. the far end changing its passphrase mid-run.
export class TranscodeError extends Error {}

// Cheap gate before any JSON parsing: a document with no envelope marker anywhere cannot need
// transcoding, and most pushed files are plain.
function mayHoldCiphertext(content: string): boolean {
  return content.includes('"csenc":1') || content.includes("enc:v1:");
}

async function transcodeLeaves(input: {
  value: unknown;
  existing: unknown;
  from: string | null;
  to: string;
  rel: string;
}): Promise<unknown> {
  const { value, existing, from, to, rel } = input;
  if (isFieldEnvelope(value)) {
    if (from === null) throw new TranscodeError(`${rel} holds encrypted values, and there is no passphrase to open them with`);
    let plaintext: string;
    try {
      plaintext = await decryptField(from, value, rel);
    } catch {
      throw new TranscodeError(`${rel} holds an encrypted value that does not open under the passphrase it was said to answer to`);
    }
    // The destination's envelope for the same leaf survives whenever it already says the same
    // thing (spec 3.9.1) — a fresh salt every write is what would churn every push.
    if (isFieldEnvelope(existing) && (await fieldUnchanged(to, existing, plaintext))) return existing;
    return encryptField(to, plaintext);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v, i) => transcodeLeaves({ value: v, existing: Array.isArray(existing) ? existing[i] : undefined, from, to, rel })));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await transcodeLeaves({ value: v, existing: isPlainObject(existing) ? existing[k] : undefined, from, to, rel });
    }
    return out;
  }
  return value;
}

// Re-encrypt one store file for the side that will hold it. `content` is the SOURCE side's copy,
// `existing` the DESTINATION's current one — the reuse comparand: when the destination already
// holds an envelope saying the same thing, ITS bytes come back verbatim, so the seam's own
// skip-if-identical fires and the steady state writes nothing. What actually re-encrypts is
// content that changed, plus each file's one-time conversion when the destination holds nothing.
export async function transcodeContent(input: {
  rel: string;
  content: string;
  existing: string | null;
  from: string | null;
  to: string | null;
}): Promise<string> {
  const { rel, content, existing, from, to } = input;
  if (from === to) return content;
  if (!mayHoldCiphertext(content)) return content;

  const env = parseFileEnvelope(content);
  if (env !== null) {
    if (from === null) throw new TranscodeError(`${rel} is encrypted, and there is no passphrase to open it with`);
    if (to === null) throw new TranscodeError(`${rel} is encrypted, and there is no passphrase to re-encrypt it under`);
    let plaintext: string;
    try {
      plaintext = await decryptFile(from, env, rel);
    } catch {
      throw new TranscodeError(`${rel} does not open under the passphrase it was said to answer to`);
    }
    const existingEnv = existing === null ? null : parseFileEnvelope(existing);
    if (existing !== null && existingEnv !== null && (await fileUnchanged(to, existingEnv, plaintext))) return existing;
    return encryptFile(to, plaintext);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return content; // the marker was a coincidence inside a non-JSON file
  }
  if (to === null) throw new TranscodeError(`${rel} holds encrypted values, and there is no passphrase to re-encrypt them under`);
  let existingDoc: unknown;
  try {
    existingDoc = existing === null ? undefined : JSON.parse(existing);
  } catch {
    existingDoc = undefined;
  }
  const out = await transcodeLeaves({ value: doc, existing: existingDoc, from, to, rel });
  // The store's own JSON shape (capture writes exactly this): a document whose every leaf reused
  // the destination's envelope must come out byte-identical to the destination's copy.
  const serialized = JSON.stringify(out, null, 2) + "\n";
  return existing !== null && serialized === existing ? existing : serialized;
}

// Does this key open everything encrypted in this file? A probe, not a conversion — nothing is
// re-encrypted and nothing comes back but the answer.
async function opens(content: string, key: string, rel: string): Promise<boolean> {
  if (!mayHoldCiphertext(content)) return true;
  const env = parseFileEnvelope(content);
  try {
    if (env !== null) {
      await decryptFile(key, env, rel);
      return true;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch {
      return true;
    }
    const walk = async (v: unknown): Promise<void> => {
      if (isFieldEnvelope(v)) {
        await decryptField(key, v, rel);
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) await walk(item);
        return;
      }
      if (isPlainObject(v)) {
        for (const item of Object.values(v)) await walk(item);
      }
    };
    await walk(doc);
    return true;
  } catch {
    return false;
  }
}

// The foreseeable failures, found BEFORE a run plans anything (spec 3.9.2): for each item holding
// ciphertext, try the key that would have to open it — the remote's on a pull, this vault's on a
// push. What fails is held out per item with its own report line, and everything else travels; a
// remote still on the shared passphrase answers instantly with nothing to hold.
export async function transcodePreflight(input: {
  key: RemoteKey;
  remoteName: string;
  direction: "pull" | "push";
  groups: readonly SyncGroup[];
  io: FileIO;
  rootPath: string;
  reader: { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> };
  localPassphrase: string | null;
}): Promise<{ skipRefs: ItemRef[]; results: GroupResult[] }> {
  if (input.key.kind === "same-as-local") return { skipRefs: [], results: [] };
  const encrypted = input.groups.filter((g) => g.ref !== undefined && groupHasCiphertext(g));
  if (encrypted.length === 0) return { skipRefs: [], results: [] };

  const held: { group: SyncGroup; message: string }[] = [];
  const skip = (group: SyncGroup, message: string): void => {
    held.push({ group, message });
  };
  const notLinked = `Skipped — the passphrase named for ${input.remoteName} isn't linked on this device. Nothing was written.`;
  const doesNotOpen = `Skipped — the passphrase saved for ${input.remoteName} doesn't open its copy. Nothing was written.`;
  const lockedHere = "Skipped — this item is encrypted and this device has no passphrase. Nothing was written.";

  const remoteRels = input.key.kind === "missing" || input.direction === "push" ? null : new Set(await input.reader.listFiles());
  for (const group of encrypted) {
    if (input.key.kind === "missing") {
      skip(group, notLinked);
      continue;
    }
    const sourceKey = input.direction === "pull" ? input.key.passphrase : input.localPassphrase;
    if (sourceKey === null) {
      skip(group, lockedHere);
      continue;
    }
    const base = `store/${groupStorePath(group.path)}`;
    // A file item is its base copy plus the two per-class sidecars; a folder item is whatever the
    // SOURCE side holds under its store directory — the probe reads the side a run would read.
    let rels: string[];
    if (group.type === "file") {
      rels = [base, `${base}${sidecarStoreSuffix("desktop")}`, `${base}${sidecarStoreSuffix("mobile")}`];
    } else if (input.direction === "pull") {
      rels = remoteRels === null ? [] : [...remoteRels].filter((r) => r.startsWith(`${base}/`));
    } else {
      const dir = `${input.rootPath}/${base}`;
      rels = (await input.io.exists(dir)) ? (await listFilesRecursive(input.io, dir)).map((f) => f.slice(input.rootPath.length + 1)) : [];
    }
    try {
      for (const rel of rels) {
        const content =
          input.direction === "pull"
            ? remoteRels !== null && remoteRels.has(rel)
              ? await input.reader.readFile(rel)
              : null
            : (await input.io.exists(`${input.rootPath}/${rel}`))
              ? await input.io.read(`${input.rootPath}/${rel}`)
              : null;
        if (content === null) continue;
        if (!(await opens(content, sourceKey, rel))) throw new TranscodeError(rel);
      }
    } catch {
      skip(group, input.direction === "pull" ? doesNotOpen : lockedHere);
    }
  }
  return {
    skipRefs: held.map((h) => h.group.ref as ItemRef),
    results: held.map((h) => ({
      group: h.group.name,
      status: "warning" as const,
      filesWritten: [],
      filesDeleted: [],
      messages: [h.message],
      needsAppReload: false,
      changes: { added: [], updated: [], deleted: [] },
    })),
  };
}
