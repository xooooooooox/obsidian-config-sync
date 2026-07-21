export interface Qualifier {
  key: string;
  value: string;
}

export interface ParsedQuery {
  text: string;
  qualifiers: Qualifier[];
}

// Match either `key:"quoted value"`, a bare `"quoted value"`, or a whitespace-run token.
const TOKEN_RE = /[^\s:"]+:"[^"]*"|"[^"]*"|\S+/g;
const KEYVAL_RE = /^([A-Za-z][\w-]*):(.*)$/;

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseQuery(raw: string, validKeys: ReadonlySet<string>): ParsedQuery {
  const qualifiers: Qualifier[] = [];
  const textParts: string[] = [];
  for (const token of raw.match(TOKEN_RE) ?? []) {
    const m = KEYVAL_RE.exec(token);
    if (m !== null && validKeys.has(m[1]!.toLowerCase())) {
      qualifiers.push({ key: m[1]!.toLowerCase(), value: stripQuotes(m[2]!).toLowerCase() });
      continue;
    }
    textParts.push(stripQuotes(token));
  }
  return { text: textParts.join(" "), qualifiers };
}

// Replace the last whitespace-delimited token of `raw` with `insert` (an autocomplete completion).
export function applySuggestion(raw: string, insert: string): string {
  const start = raw.search(/\S*$/); // index where the trailing non-space run begins (raw.length if trailing space)
  return raw.slice(0, start) + insert;
}

export type QualifierResolver<T> = (item: T) => string | string[] | null;

// AND across qualifiers. Empty-value qualifiers and keys with no resolver are skipped; a
// qualifier matches when any resolved value equals it (case-insensitive). A null resolver
// result means the qualifier cannot be satisfied → the item is excluded.
export function matchesQualifiers<T>(
  item: T,
  qualifiers: readonly Qualifier[],
  resolvers: Record<string, QualifierResolver<T>>,
): boolean {
  for (const q of qualifiers) {
    if (q.value === "") continue;
    const resolver = resolvers[q.key];
    if (resolver === undefined) continue;
    const got = resolver(item);
    if (got === null) return false;
    const vals = Array.isArray(got) ? got : [got];
    if (!vals.some((v) => v.toLowerCase() === q.value)) return false;
  }
  return true;
}

export interface QualifierValue {
  value: string;
  description?: string;
}

export interface QualifierSpec {
  key: string;
  description?: string;
  values: QualifierValue[];
}

export interface Suggestion {
  display: string;
  insert: string;
  description?: string;
  kind: "key" | "value";
}

// currentToken = the last whitespace-delimited fragment of the input (caret assumed at end).
export function suggest(token: string, specs: readonly QualifierSpec[]): Suggestion[] {
  const colon = token.indexOf(":");
  if (colon === -1) {
    const p = token.toLowerCase();
    return specs
      .filter((s) => s.key.startsWith(p))
      .map((s) => ({ display: `${s.key}:`, insert: `${s.key}:`, description: s.description, kind: "key" as const }));
  }
  const key = token.slice(0, colon).toLowerCase();
  const spec = specs.find((s) => s.key === key);
  if (spec === undefined) return [];
  const vp = token.slice(colon + 1).replace(/^"/, "").toLowerCase();
  return spec.values
    .filter((v) => v.value.startsWith(vp))
    .map((v) => ({ display: `${key}:${v.value}`, insert: `${key}:${v.value} `, description: v.description, kind: "value" as const }));
}
