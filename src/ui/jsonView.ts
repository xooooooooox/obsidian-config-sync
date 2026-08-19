import { EVERYWHERE, FieldRule, PerElementSharing, Sharing, sharingClass } from "../core/types";
import { keyMatchesAny } from "../core/sanitize";

// Orthogonal classification (D1/D10): sharing drives color, encrypted is an independent flag that
// adds a lock icon suffix on top of whatever sharing color applies. null = no rule for this key.
export interface KeyState { sharing: Sharing | null; encrypted: boolean }
export interface KeyClass { key: string; state: KeyState; detected: boolean }

// Classifies each top-level object key by its rule/detection state for the read-only viewer.
// An explicit {sharing: everywhere, encrypted:false} rule is an inert override (owned by the app
// drawer) — it classifies the same as "no rule" here.
export function classifyJsonKeys(raw: string, fields: FieldRule[], detectedKeys: string[]): KeyClass[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed).map((key) => {
    const rule = fields.find((f) => keyMatchesAny(key, [f.pattern]) && !(f.sharing.kind === "everywhere" && !f.encrypted));
    const state: KeyState = rule !== undefined ? { sharing: rule.sharing, encrypted: rule.encrypted } : { sharing: null, encrypted: false };
    return { key, state, detected: state.sharing === null && detectedKeys.includes(key) };
  });
}

// CSS class for a key's color: sharing alone drives color (blue=desktop / amber=mobile / red=this
// device); everywhere and no-rule get no color. Reuses the existing config-sync-json-* classes.
export function jsonKeyClass(kc: KeyClass): string {
  const cls = kc.state.sharing === null ? null : sharingClass(kc.state.sharing);
  if (cls === "desktop") return "config-sync-json-desktop";
  if (cls === "mobile") return "config-sync-json-mobile";
  if (kc.state.sharing?.kind === "this-device") return "config-sync-json-strip";
  return kc.detected ? "config-sync-json-detected" : "config-sync-json-none";
}

// classifyJsonKeys only classifies top-level key LINES; a string-array key with per-element
// rules enabled (top-level string-array keys only) also needs each ELEMENT line colored
// by that element's own sharing. `raw` is the pretty-printed `JSON.stringify(doc, null, 2)` text
// the preview already renders line-by-line, so classification is keyed by line index (0-based,
// matching `raw.split("\n")`) for a trivial O(1) lookup while the renderer walks the same lines.
export interface PerElementLine {
  key: string;
  value: string;
  sharing: Sharing;
}

interface Frame {
  // The top-level key that owns this frame's array, IF this frame is a per-element-enabled
  // top-level array (elements get colored) — null for every other container (nested
  // objects/arrays, or a top-level array whose key has no perElement entry): its contents are
  // walked only to keep bracket depth correct, never colored.
  perElementKey: string | null;
}

export function classifyPerElementLines(raw: string, perElement: Record<string, PerElementSharing>): Map<number, PerElementLine> {
  const out = new Map<number, PerElementLine>();
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
      if (rest === "[") stack.push({ perElementKey: key in perElement ? key : null });
      else if (rest === "{") stack.push({ perElementKey: null });
      continue;
    }
    if (CLOSE_LINE_RE.test(trimmed)) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1]!;
    if (top.perElementKey !== null && stack.length === 1) {
      const withoutComma = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
      if (withoutComma.startsWith('"') && withoutComma.endsWith('"')) {
        try {
          const value = JSON.parse(withoutComma) as string;
          out.set(i, { key: top.perElementKey, value, sharing: perElement[top.perElementKey]?.[value] ?? EVERYWHERE });
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
    if (openRest === "[" || openRest === "{") stack.push({ perElementKey: null });
  }
  return out;
}

// CSS class for a per-element array element's color: same sharing->color mapping as jsonKeyClass,
// minus the "detected"/"none" faint styling (elements have no detection concept) — everywhere gets
// no color (default text).
export function jsonElementClass(state: PerElementLine): string | null {
  const cls = sharingClass(state.sharing);
  if (cls === "desktop") return "config-sync-json-desktop";
  if (cls === "mobile") return "config-sync-json-mobile";
  if (state.sharing.kind === "this-device") return "config-sync-json-strip";
  return null;
}
