import { ContentVerdict, compareCopies, isCannot } from "./cipherCompare";
import { FileIO, isJunkPath, listFilesRecursive } from "./io";
import { refsWithKeyRules } from "./keyWithholding";
import { groupHasCiphertext } from "./modes";
import { groupStorePath, sidecarStoreSuffix } from "./pathing";
import { RemoteItems, SyncGroup } from "./types";

// The items whose two LOCK entries cannot settle them, and the only ones worth reading content for:
//
//   - an item with per-key rules — its fingerprints differ by design, forever (spec 3.4.3);
//   - an item holding ciphertext — it has no fingerprint at all (a fingerprint of ciphertext could
//     never match across two vaults), so the ledger has nothing to say about it either.
//
// Two causes, one consequence, hence one list. A remote with neither pays nothing.
export function refsNeedingContentCompare(input: { groups: readonly SyncGroup[]; items: RemoteItems | undefined }): string[] {
  const refs = new Set<string>(refsWithKeyRules(input.items));
  for (const g of input.groups) {
    if (g.ref !== undefined && groupHasCiphertext(g)) refs.add(g.ref);
  }
  return [...refs];
}

// Which store files this item is made of. A file item is its base copy plus the two per-class
// sidecars; a folder item is whatever either side happens to hold under its store directory —
// asked of BOTH sides, because a file only one of them has is exactly the kind of difference this
// comparison exists to find.
async function itemRels(input: {
  io: FileIO;
  rootPath: string;
  remoteRels: ReadonlySet<string>;
  group: SyncGroup;
}): Promise<string[]> {
  const base = `store/${groupStorePath(input.group.path)}`;
  if (input.group.type === "file") {
    return [base, `${base}${sidecarStoreSuffix("desktop")}`, `${base}${sidecarStoreSuffix("mobile")}`];
  }
  const prefix = `${base}/`;
  const localDir = `${input.rootPath}/${base}`;
  const mine = (await input.io.exists(localDir))
    ? (await listFilesRecursive(input.io, localDir)).map((f) => f.slice(input.rootPath.length + 1))
    : [];
  const theirs = [...input.remoteRels].filter((rel) => rel.startsWith(prefix));
  return [...new Set([...mine, ...theirs])].filter((rel) => !isJunkPath(rel));
}

// Do this item's two copies agree? Reads its store files from BOTH sides — this vault's through
// `io`, the far end's through the reader the comparison was already using.
//
// `differs` outranks `cannot`: once one file is plainly not the same, we already know something has
// to move, and downgrading the whole item to "we cannot tell" because a SECOND file is unreadable
// would throw away the answer we do have. Only an item where nothing differed and something could
// not be opened is genuinely unknowable. Among the unknowable, "here" outranks "there" for the same
// reason compareCopies orders its own answer that way: the user fixes their own side first.
export async function compareStoreItem(input: {
  io: FileIO;
  rootPath: string;
  reader: { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> };
  groups: readonly SyncGroup[];
  ref: string;
  masked: (rel: string) => string[];
  passphrase: { mine: string | null; theirs: string | null };
}): Promise<ContentVerdict> {
  const group = input.groups.find((g) => g.ref === input.ref);
  if (group === undefined) return "same";
  const remoteRels = new Set(await input.reader.listFiles());
  const rels = await itemRels({ io: input.io, rootPath: input.rootPath, remoteRels, group });
  let unopenable: { cannot: "here" | "there" } | null = null;
  for (const rel of rels) {
    const localPath = `${input.rootPath}/${rel}`;
    const mine = (await input.io.exists(localPath)) ? await input.io.read(localPath) : null;
    const theirs = remoteRels.has(rel) ? await input.reader.readFile(rel) : null;
    const verdict = await compareCopies({
      mine,
      theirs,
      passphrase: input.passphrase,
      masked: input.masked(rel),
      groupName: group.name,
    });
    if (verdict === "differs") return "differs";
    if (isCannot(verdict) && (unopenable === null || verdict.cannot === "here")) unopenable = verdict;
  }
  return unopenable ?? "same";
}
