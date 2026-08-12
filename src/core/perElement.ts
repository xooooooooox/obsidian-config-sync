/**
 * Per-element sharing for string-array keys (spec 2026-07-25-unified-card-design.md §3, D3;
 * renamed from perItem by 2026-08-11-v3-one-vocabulary-design.md §1: one entry of an on/off list
 * is an ELEMENT, and an item is a card in the registry — the old name meant both). Generalizes the
 * switch-list mechanism so ANY string-array key — not just community-plugins.json /
 * core-plugins.json / enabledCssSnippets — can give each element its own Sharing. An element with
 * no entry in the map is shared everywhere.
 *
 * Unlike the {sharing, encrypted} FieldRule (which splits per-class values into a separate
 * __scopes__ sidecar file), a per-element array is a single shared list: every device's capture
 * writes the SAME store array, and each device's own filter decides which elements it pulls back
 * in on apply. So (unlike captureTransform's normal fields path) capture needs to read the array's
 * PRIOR store value to preserve elements the other device already contributed.
 */
import { isPlainObject } from "./sanitize";
import { switchListsEqual } from "./switchList";
import { DeviceClass, EVERYWHERE, PerElementSharing, Sharing } from "./types";

function otherClassOf(cls: DeviceClass): "desktop" | "mobile" {
  if (cls === "desktop") return "mobile";
  if (cls === "mobile") return "desktop";
  throw new Error(`per-element sharing: device class must be "desktop" or "mobile", got "${cls}"`);
}

export function sharingOf(sharings: PerElementSharing, element: string): Sharing {
  return sharings[element] ?? EVERYWHERE;
}

// Whether an element's sharing reaches THIS device class: everywhere always does, a per-class
// rule only on its own class, this-device never (it is dropped from the store entirely).
function sharedWithClass(sharing: Sharing, cls: DeviceClass): boolean {
  return sharing.kind === "everywhere" || (sharing.kind === "per-class" && sharing.class === cls);
}

function isClass(sharing: Sharing, cls: "desktop" | "mobile"): boolean {
  return sharing.kind === "per-class" && sharing.class === cls;
}

// First-occurrence-wins, order-preserving — the formulas below only concatenate two disjoint
// slices, but a malformed/hand-edited array (or a re-run over already-merged data) can still
// repeat a value; this keeps the contract's ordering guarantee intact either way.
function dedupeFirst(elements: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const el of elements) {
    if (!seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

// capture(c) = local elements shared with c (local order) ++ store elements pinned to
// otherClass(c) (store order). this-device elements — on either side — never enter the result:
// they are this-device-only and must never leave (local) or be resurrected from a stale store
// copy (dropped, not passed through).
export function capturePerElementArray(localArr: string[], storeArr: string[], sharings: PerElementSharing, cls: DeviceClass): string[] {
  const other = otherClassOf(cls);
  const fromLocal = localArr.filter((el) => sharedWithClass(sharingOf(sharings, el), cls));
  const fromStore = storeArr.filter((el) => isClass(sharingOf(sharings, el), other));
  return dedupeFirst([...fromLocal, ...fromStore]);
}

// apply(c) = store elements shared with c (store order) ++ local this-device elements (local
// order) — the store never carries this-device elements (capture drops them), so this is the only
// way they survive an apply.
export function applyPerElementArray(storeArr: string[], localArr: string[], sharings: PerElementSharing, cls: DeviceClass): string[] {
  const fromStore = storeArr.filter((el) => sharedWithClass(sharingOf(sharings, el), cls));
  const fromLocal = localArr.filter((el) => sharingOf(sharings, el).kind === "this-device");
  return dedupeFirst([...fromStore, ...fromLocal]);
}

// contentUnchanged symmetry: mask out elements this device's apply would never touch — the
// other class's elements (never applied here) and this-device elements (never stored) — from BOTH
// sides, then compare what remains as a set (mirrors the existing switch-list convention: a
// per-element list is a membership list, not a positionally-ordered array). Reuses switchList.ts's
// masked-set-equality instead of re-implementing it.
export function perElementArrayUnchanged(localArr: string[], storeArr: string[], sharings: PerElementSharing, cls: DeviceClass): boolean {
  const other = otherClassOf(cls);
  const ignore = new Set<string>();
  for (const el of [...localArr, ...storeArr]) {
    const s = sharingOf(sharings, el);
    if (isClass(s, other) || s.kind === "this-device") ignore.add(el);
  }
  return switchListsEqual(localArr, storeArr, [...ignore]);
}

// Reads a perElement key's live value out of a parsed JSON document. An absent key (not yet
// written, e.g. first capture) is treated as an empty list — a benign, common case. A key that
// IS present but isn't a string array is a configuration/data error and must fail loudly, naming
// the group, the key, and what was actually found — never a silent skip (per-element sharing would
// otherwise quietly drop or corrupt the field).
export function readPerElementArray(document: unknown, groupName: string, key: string, verb: "capture" | "apply" | "compare"): string[] {
  if (!isPlainObject(document)) {
    throw new Error(`Group "${groupName}": cannot ${verb} per-element key "${key}" — file content is not a JSON object`);
  }
  const value = document[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((el): el is string => typeof el === "string")) return value;
  const found = value === null ? "null" : Array.isArray(value) ? "array (non-string elements)" : typeof value;
  throw new Error(`Group "${groupName}": per-element key "${key}" must be a string array to ${verb} — found ${found}`);
}
