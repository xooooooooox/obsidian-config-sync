import { withheldPatternsFor } from "./remoteRules";
import { resolveGroupByStoreRel } from "./pathing";
import { isPlainObject, mergePreservingSanitized, sanitizeJson } from "./sanitize";
import { ItemRef, RemoteItems, SyncGroup } from "./types";

// A key rule can only exist where there are keys: a folder item travels as a whole, and so does a
// file with no JSON in it. Both are structural facts about the item, not choices, and the card says
// so in as many words rather than showing an empty Keys area.
function relCanHaveKeys(rel: string, groupLists: SyncGroup[][]): ItemRef | null {
  if (!rel.endsWith(".json")) return null;
  for (const list of groupLists) {
    const group = resolveGroupByStoreRel(list, rel);
    if (group === undefined) continue;
    return group.type === "file" && group.ref !== undefined ? group.ref : null;
  }
  return null;
}

// The per-rel form, shaped like ConfigSyncCore's `skipRelPredicate` because it answers the same sort
// of question one level down: that one says whether a rel travels at all, this one says which keys
// inside it do not.
export function withheldPatternPredicate(
  items: RemoteItems | undefined,
  dir: "push" | "pull",
  ...groupLists: SyncGroup[][]
): (rel: string) => string[] {
  const anyKeyRules = Object.values(items ?? {}).some((byId) => Object.values(byId).some((rule) => rule.keys !== undefined));
  if (!anyKeyRules) return () => [];
  const memo = new Map<string, string[]>();
  return (rel: string): string[] => {
    const hit = memo.get(rel);
    if (hit !== undefined) return hit;
    const ref = relCanHaveKeys(rel, groupLists);
    const patterns = ref === null ? [] : withheldPatternsFor(items, ref, dir);
    memo.set(rel, patterns);
    return patterns;
  };
}

// A file we cannot parse is a rule we cannot honour, and honouring it is the whole point: sending
// the file whole would hand the far end a key we promised to withhold. Refuse, naming the file.
function parseOrThrow(rel: string, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${rel} has per-key rules for this remote but is not valid JSON, so those keys cannot be held back: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    throw new Error(`${rel} has per-key rules for this remote but holds no keys to apply them to`);
  }
  return parsed;
}

// Lay one side's document over the other's, holding the withheld keys back. `take` wins every key it
// has; a key matching a withheld pattern keeps `keep`'s value, including one only `keep` has. On a
// PULL `keep` is this vault's store copy and `take` is the remote's; on a PUSH they swap, and that
// swap is the whole difference between the two directions.
//
// `keep: null` means that side has no copy of the file at all, so a withheld key has no value to
// hold on to and is dropped rather than taken from `take` — the far end must not receive a key we
// promised never to send it, and this vault must not receive one we promised never to accept.
export function overlayWithheld(input: { rel: string; keep: string | null; take: string; patterns: readonly string[] }): string {
  const patterns = [...input.patterns];
  const take = parseOrThrow(input.rel, input.take);
  const kept = input.keep === null ? null : parseOrThrow(input.rel, input.keep);
  const merged = kept === null ? sanitizeJson(take, patterns) : mergePreservingSanitized(kept, take, patterns);
  // The store's own JSON shape (capture writes exactly this), so an item whose merged content did
  // not change is byte-identical to what is already there and the seam skips the write.
  return JSON.stringify(merged, null, 2) + "\n";
}
