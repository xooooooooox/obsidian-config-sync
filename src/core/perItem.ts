/**
 * Per-item scopes for string-array keys (spec 2026-07-25-unified-card-design.md §3, D3):
 * generalizes the switch-list / memberScopes mechanism so ANY string-array key — not just
 * community-plugins.json / core-plugins.json / enabledCssSnippets — can give each element its
 * own {all, desktop, mobile, local} scope. An element with no entry in the scope map defaults
 * to "all".
 *
 * Unlike the class {scope, encrypted} FieldRule (which splits own-class values into a separate
 * __scopes__ sidecar file), a per-item array is a single shared list: every device's capture
 * writes the SAME store array, and each device's own scope filter decides which elements it
 * pulls back in on apply. So (unlike captureTransform's normal fields path) capture needs to
 * read the array's PRIOR store value to preserve elements the other device already contributed.
 */
import { isPlainObject } from "./sanitize";
import { switchListsEqual } from "./switchList";
import { DeviceClass, PerItemScopes, RuleScope } from "./types";

function otherClassOf(cls: DeviceClass): "desktop" | "mobile" {
  if (cls === "desktop") return "mobile";
  if (cls === "mobile") return "desktop";
  throw new Error(`per-item scopes: device class must be "desktop" or "mobile", got "${cls}"`);
}

export function scopeOf(scopes: PerItemScopes, element: string): RuleScope {
  return scopes[element] ?? "all";
}

// First-occurrence-wins, order-preserving — the formulas below only concatenate two disjoint-by-
// scope slices, but a malformed/hand-edited array (or a re-run over already-merged data) can
// still repeat a value; this keeps the contract's ordering guarantee intact either way.
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

// capture(c) = local elements with scope∈{all,c} (local order) ++ store elements with
// scope=otherClass(c) (store order). Elements scoped "local" — on either side — never enter the
// result: they are this-device-only and must never leave (local) or be resurrected from a stale
// store copy (dropped, not passed through).
export function capturePerItemArray(localArr: string[], storeArr: string[], scopes: PerItemScopes, cls: DeviceClass): string[] {
  const other = otherClassOf(cls);
  const fromLocal = localArr.filter((el) => {
    const s = scopeOf(scopes, el);
    return s === "all" || s === cls;
  });
  const fromStore = storeArr.filter((el) => scopeOf(scopes, el) === other);
  return dedupeFirst([...fromLocal, ...fromStore]);
}

// apply(c) = store elements with scope∈{all,c} (store order) ++ local elements with scope=local
// (local order) — the store never carries "local" elements (capture drops them), so this is the
// only way they survive an apply.
export function applyPerItemArray(storeArr: string[], localArr: string[], scopes: PerItemScopes, cls: DeviceClass): string[] {
  const fromStore = storeArr.filter((el) => {
    const s = scopeOf(scopes, el);
    return s === "all" || s === cls;
  });
  const fromLocal = localArr.filter((el) => scopeOf(scopes, el) === "local");
  return dedupeFirst([...fromStore, ...fromLocal]);
}

// contentUnchanged symmetry: mask out elements this device's apply would never touch — the
// other class's elements (never applied here) and "local" elements (never stored) — from BOTH
// sides, then compare what remains as a set (mirrors the existing switch-list convention: a
// per-item list is a membership list, not a positionally-ordered array). Reuses switchList.ts's
// masked-set-equality instead of re-implementing it.
export function perItemArrayUnchanged(localArr: string[], storeArr: string[], scopes: PerItemScopes, cls: DeviceClass): boolean {
  const other = otherClassOf(cls);
  const ignore = new Set<string>();
  for (const el of [...localArr, ...storeArr]) {
    const s = scopeOf(scopes, el);
    if (s === other || s === "local") ignore.add(el);
  }
  return switchListsEqual(localArr, storeArr, [...ignore]);
}

// Reads a perItem key's live value out of a parsed JSON document. An absent key (not yet
// written, e.g. first capture) is treated as an empty list — a benign, common case. A key that
// IS present but isn't a string array is a configuration/data error and must fail loudly, naming
// the group, the key, and what was actually found — never a silent skip (per-item scoping would
// otherwise quietly drop or corrupt the field).
export function readPerItemArray(document: unknown, groupName: string, key: string, verb: "capture" | "apply" | "compare"): string[] {
  if (!isPlainObject(document)) {
    throw new Error(`Group "${groupName}": cannot ${verb} per-item key "${key}" — file content is not a JSON object`);
  }
  const value = document[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((el): el is string => typeof el === "string")) return value;
  const found = value === null ? "null" : Array.isArray(value) ? "array (non-string elements)" : typeof value;
  throw new Error(`Group "${groupName}": per-item key "${key}" must be a string array to ${verb} — found ${found}`);
}
