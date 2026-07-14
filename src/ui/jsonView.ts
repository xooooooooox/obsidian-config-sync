import { FieldRule } from "../core/types";
import { keyMatchesAny } from "../core/sanitize";

export type KeyState = "encrypt" | "strip" | "detected" | "none";
export interface KeyClass { key: string; state: KeyState; }

// Classifies each top-level object key by its rule/detection state for the read-only viewer.
export function classifyJsonKeys(raw: string, fields: FieldRule[], detectedKeys: string[]): KeyClass[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const enc = fields.filter((f) => f.action === "encrypt").map((f) => f.pattern);
  const strip = fields.filter((f) => f.action === "strip").map((f) => f.pattern);
  return Object.keys(parsed).map((key) => {
    let state: KeyState = "none";
    if (keyMatchesAny(key, enc)) state = "encrypt";
    else if (keyMatchesAny(key, strip)) state = "strip";
    else if (detectedKeys.includes(key)) state = "detected";
    return { key, state };
  });
}
