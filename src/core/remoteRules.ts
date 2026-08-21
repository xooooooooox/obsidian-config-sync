import { keyMatchesAny } from "./sanitize";
import { directionFlows, intersectDirection, ItemRef, parseItemRef, RemoteDirection, RemoteItemRule, RemoteItems } from "./types";

// THE reader for a remote's rules. Every consumer — the four transport seams, the panel, the
// counting surfaces — asks here, so "what does this remote do with this item" has one answer.

// A ref that `parseItemRef` refuses has no rules and cannot be given any: it reaches us from a
// document another build wrote, so it is ignored where it is read rather than trusted or deleted
// (invariant II.2).
function ruleFor(items: RemoteItems | undefined, ref: ItemRef): RemoteItemRule | undefined {
  if (items === undefined) return undefined;
  const parsed = parseItemRef(ref);
  if (parsed === null) return undefined;
  return items[parsed.section]?.[parsed.id];
}

export function itemDirection(items: RemoteItems | undefined, ref: ItemRef): RemoteDirection {
  return ruleFor(items, ref)?.direction ?? "both";
}

// The key's own answer, already intersected with its item's. A stored key rule outside the item's
// subset is honoured as written and simply resolves to less — never rewritten, so widening the
// item again restores the user's choice.
export function keyDirection(items: RemoteItems | undefined, ref: ItemRef, key: string): RemoteDirection {
  const rule = ruleFor(items, ref);
  const item = rule?.direction ?? "both";
  const keys = rule?.keys;
  if (keys === undefined) return item;
  for (const [pattern, kr] of Object.entries(keys)) {
    if (keyMatchesAny(key, [pattern])) return intersectDirection(item, kr.direction);
  }
  return item;
}

// Write one item's direction. The default is never stored: an entry that carries nothing else is
// removed, and a map that ends up empty becomes undefined, so a document only ever holds decisions
// somebody actually made.
export function withItemDirection(
  items: RemoteItems | undefined,
  ref: ItemRef,
  direction: RemoteDirection
): RemoteItems | undefined {
  const parsed = parseItemRef(ref);
  if (parsed === null) return items;
  const next: RemoteItems = {};
  for (const [s, byId] of Object.entries(items ?? {})) next[s] = { ...byId };
  const bucket = { ...(next[parsed.section] ?? {}) };
  const existing = bucket[parsed.id];
  const keys = existing?.keys;
  if (direction === "both") {
    if (keys === undefined) delete bucket[parsed.id];
    else bucket[parsed.id] = { keys };
  } else {
    bucket[parsed.id] = keys === undefined ? { direction } : { direction, keys };
  }
  if (Object.keys(bucket).length === 0) delete next[parsed.section];
  else next[parsed.section] = bucket;
  return Object.keys(next).length === 0 ? undefined : next;
}

// Items that do NOT flow in the asked direction — the generalisation of the self-only skip list the
// transport seams used to hard-code. Key rules never appear here: a key withheld inside an item that
// still travels is a content decision, not an item the seam should skip.
export function refsBlockedFor(items: RemoteItems | undefined, dir: "push" | "pull"): ItemRef[] {
  const out: ItemRef[] = [];
  for (const [section, byId] of Object.entries(items ?? {})) {
    for (const [id, rule] of Object.entries(byId)) {
      const d = rule.direction ?? "both";
      if (d === "none" || (d === "push" && dir === "pull") || (d === "pull" && dir === "push")) {
        out.push(`${section}/${id}` as ItemRef);
      }
    }
  }
  return out;
}

// The key patterns this remote does NOT let travel in the asked direction. The pattern IS the key as
// far as a rule is concerned, so the answer comes from `keyDirection` above — already intersected
// with the item's own direction, because a key can never travel further than the item it lives in.
export function withheldPatternsFor(items: RemoteItems | undefined, ref: ItemRef, dir: "push" | "pull"): string[] {
  const keys = ruleFor(items, ref)?.keys;
  if (keys === undefined) return [];
  return Object.keys(keys).filter((pattern) => !directionFlows(keyDirection(items, ref, pattern))[dir]);
}

// The keys this remote exchanges in NEITHER direction. Narrower than "has a rule" on purpose: a key
// that still travels one way converges the next time that direction runs, so a difference in it is
// real work and must keep showing. Only these two-way-closed keys differ BY DESIGN, forever, which
// is what makes them the ones a comparison has to mask (spec 3.3).
export function unexchangedPatternsFor(items: RemoteItems | undefined, ref: ItemRef): string[] {
  const keys = ruleFor(items, ref)?.keys;
  if (keys === undefined) return [];
  return Object.keys(keys).filter((pattern) => keyDirection(items, ref, pattern) === "none");
}

// The four stops as DATA, in the order every surface offers them. The UI's own table maps these to
// display names and glyphs; the order itself is a fact about the rules, not about the panel.
const REMOTE_DIRECTIONS: readonly RemoteDirection[] = ["both", "push", "pull", "none"];

// Write one key's direction inside one item. Same discipline as withItemDirection: the default is
// never stored, an entry that carries nothing else is removed, and a map that ends up empty becomes
// undefined — a document only ever holds decisions somebody actually made. The item's own direction
// is untouched here; the two are separate decisions that meet at READ time (keyDirection).
export function withKeyDirection(
  items: RemoteItems | undefined,
  ref: ItemRef,
  pattern: string,
  direction: RemoteDirection
): RemoteItems | undefined {
  const parsed = parseItemRef(ref);
  if (parsed === null) return items;
  const next: RemoteItems = {};
  for (const [s, byId] of Object.entries(items ?? {})) next[s] = { ...byId };
  const bucket = { ...(next[parsed.section] ?? {}) };
  const existing = bucket[parsed.id];
  const keys = { ...(existing?.keys ?? {}) };
  if (direction === "both") delete keys[pattern];
  else keys[pattern] = { direction };
  const rule: RemoteItemRule = {};
  if (existing?.direction !== undefined) rule.direction = existing.direction;
  if (Object.keys(keys).length > 0) rule.keys = keys;
  if (Object.keys(rule).length === 0) delete bucket[parsed.id];
  else bucket[parsed.id] = rule;
  if (Object.keys(bucket).length === 0) delete next[parsed.section];
  else next[parsed.section] = bucket;
  return Object.keys(next).length === 0 ? undefined : next;
}

// The stops a KEY can be set to under an item with this direction: those that survive the
// intersection unchanged (spec 2.2). A menu offering more would let a click write a rule the reader
// immediately resolves to something else — the control would be lying about its own effect.
export function keyStopsWithin(item: RemoteDirection): RemoteDirection[] {
  return REMOTE_DIRECTIONS.filter((d) => intersectDirection(item, d) === d);
}

// The key patterns this item carries a rule for, in the order they were written. The panel lists
// these and nothing else: a rule is a decision somebody made, and every other key in the document is
// simply travelling with its item.
export function keyPatternsFor(items: RemoteItems | undefined, ref: ItemRef): string[] {
  return Object.keys(ruleFor(items, ref)?.keys ?? {});
}
