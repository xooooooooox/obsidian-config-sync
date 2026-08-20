/**
 * v4 -> v5: each remote's `excludeSelf` boolean becomes a general direction rule.
 *
 * The boolean said exactly what `items.community["config-sync"].direction = "none"` says, and one
 * rule with two spellings drifts. The conversion is the whole migration: no other field moves, and
 * everything this migration does not recognise rides through untouched (invariant II.1).
 */
import { SELF_ITEM_ID, SELF_ITEM_SECTION } from "./catalog";
import { isPlainObject } from "./sanitize";

type Doc = Record<string, unknown>;

export function migrateV5Settings(input: Doc): Doc {
  if (input.schemaVersion !== 4) return input;
  const doc: Doc = { ...input, schemaVersion: 5 };
  // A non-array `remotes` is not data any build could read; it is left exactly as found rather than
  // replaced, the same way the earlier migrations treat a value they cannot walk.
  if (!Array.isArray(doc.remotes)) return doc;
  const remotes: unknown[] = doc.remotes;
  doc.remotes = remotes.map((raw): unknown => {
    if (!isPlainObject(raw)) return raw;
    const { excludeSelf, ...rest } = raw;
    if (excludeSelf !== true) return rest;
    const items: Doc = isPlainObject(rest.items) ? { ...rest.items } : {};
    const section = items[SELF_ITEM_SECTION];
    const bucket: Doc = isPlainObject(section) ? { ...section } : {};
    const existing = bucket[SELF_ITEM_ID];
    bucket[SELF_ITEM_ID] = { ...(isPlainObject(existing) ? existing : {}), direction: "none" };
    items[SELF_ITEM_SECTION] = bucket;
    return { ...rest, items };
  });
  return doc;
}
