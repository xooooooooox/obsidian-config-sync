import { FieldRule, PerItemScopes, RuleScope } from "../core/types";
import { keyMatchesAny } from "../core/sanitize";

// Orthogonal classification (D1/D10): scope drives color, encrypted is an independent flag that
// adds a lock icon suffix on top of whatever scope color applies. "none" = no rule for this key.
export interface KeyState { scope: RuleScope | "none"; encrypted: boolean }
export interface KeyClass { key: string; state: KeyState; detected: boolean }

// Classifies each top-level object key by its rule/detection state for the read-only viewer.
// An explicit {scope:"all", encrypted:false} rule is an inert override (owned by the app drawer)
// — it classifies the same as "no rule" here, same as before the scope/encrypted split.
export function classifyJsonKeys(raw: string, fields: FieldRule[], detectedKeys: string[]): KeyClass[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed).map((key) => {
    const rule = fields.find((f) => keyMatchesAny(key, [f.pattern]) && !(f.scope === "all" && !f.encrypted));
    const state: KeyState = rule !== undefined ? { scope: rule.scope, encrypted: rule.encrypted } : { scope: "none", encrypted: false };
    return { key, state, detected: state.scope === "none" && detectedKeys.includes(key) };
  });
}

// CSS class for a key's color: scope alone drives color (blue=desktop / amber=mobile / red=this
// device); "all" and "none" get no color. Reuses the existing config-sync-json-* classes.
export function jsonKeyClass(kc: KeyClass): string {
  if (kc.state.scope === "desktop") return "config-sync-json-desktop";
  if (kc.state.scope === "mobile") return "config-sync-json-mobile";
  if (kc.state.scope === "local") return "config-sync-json-strip";
  return kc.detected ? "config-sync-json-detected" : "config-sync-json-none";
}

// ── Per-item array element coloring (spec D10 "逐项数组按元素着色") ─────────────────────────
// classifyJsonKeys only classifies top-level key LINES; a string-array key with "Per-item
// scopes" enabled (D3 — top-level string-array keys only) also needs each ELEMENT line colored
// by that element's own scope. `raw` is the pretty-printed `JSON.stringify(doc, null, 2)` text
// the preview already renders line-by-line, so classification is keyed by line index (0-based,
// matching `raw.split("\n")`) for a trivial O(1) lookup while the renderer walks the same lines.
export interface PerItemElementLine {
  key: string;
  value: string;
  scope: RuleScope;
}

interface Frame {
  // The top-level key that owns this frame's array, IF this frame is a per-item-enabled
  // top-level array (elements get colored) — null for every other container (nested
  // objects/arrays, or a top-level array whose key has no perItem entry): its contents are
  // walked only to keep bracket depth correct, never colored.
  perItemKey: string | null;
}

export function classifyPerItemLines(raw: string, perItem: Record<string, PerItemScopes>): Map<number, PerItemElementLine> {
  const out = new Map<number, PerItemElementLine>();
  const lines = raw.split("\n");
  const stack: Frame[] = [];
  const KEY_LINE_RE = /^"([^"]+)":\s*(.*)$/;
  const CLOSE_LINE_RE = /^[}\]],?$/;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (stack.length === 0) {
      // Depth 0 = keys of the root object itself; the root's own "{"/"}" wrapper lines carry no
      // key and open/close nothing worth tracking (they ARE the implicit depth-0 context).
      if (trimmed === "{" || trimmed === "}") continue;
      const keyMatch = KEY_LINE_RE.exec(trimmed);
      if (keyMatch === null) continue;
      const key = keyMatch[1]!;
      const rest = keyMatch[2] ?? "";
      if (rest === "[") stack.push({ perItemKey: key in perItem ? key : null });
      else if (rest === "{") stack.push({ perItemKey: null });
      continue;
    }
    if (CLOSE_LINE_RE.test(trimmed)) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1]!;
    if (top.perItemKey !== null && stack.length === 1) {
      const withoutComma = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
      if (withoutComma.startsWith('"') && withoutComma.endsWith('"')) {
        try {
          const value = JSON.parse(withoutComma) as string;
          out.set(i, { key: top.perItemKey, value, scope: perItem[top.perItemKey]?.[value] ?? "all" });
          continue;
        } catch {
          // not a well-formed quoted string on this line — fall through to generic depth
          // tracking below so a malformed/unexpected element still keeps bracket depth correct.
        }
      }
    }
    // Generic nested content — a key line that itself opens a further container (object nested
    // inside a non-per-item key), or a bare "{"/"[" (an element of an array-of-objects/arrays),
    // or an unrelated scalar line. Only bracket-opening lines need tracking; everything else is
    // an inert leaf at this depth.
    const nestedKeyMatch = KEY_LINE_RE.exec(trimmed);
    const openRest = nestedKeyMatch !== null ? (nestedKeyMatch[2] ?? "") : trimmed;
    if (openRest === "[" || openRest === "{") stack.push({ perItemKey: null });
  }
  return out;
}

// CSS class for a per-item array element's color: same scope->color mapping as jsonKeyClass,
// minus the "detected"/"none" faint styling (elements have no detection concept) — "all" gets no
// color (default text).
export function jsonElementClass(state: PerItemElementLine): string | null {
  if (state.scope === "desktop") return "config-sync-json-desktop";
  if (state.scope === "mobile") return "config-sync-json-mobile";
  if (state.scope === "local") return "config-sync-json-strip";
  return null;
}
