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
