export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function keyMatchesAny(key: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegex(p).test(key));
}

export function sanitizeJson(value: unknown, patterns: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJson(v, patterns));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (keyMatchesAny(k, patterns)) continue;
      out[k] = sanitizeJson(v, patterns);
    }
    return out;
  }
  return value;
}

export function mergePreservingSanitized(local: unknown, incoming: unknown, patterns: string[]): unknown {
  if (Array.isArray(incoming) && Array.isArray(local)) {
    return incoming.map((v, i) => mergePreservingSanitized(local[i], v, patterns));
  }
  if (isPlainObject(incoming) && isPlainObject(local)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (keyMatchesAny(k, patterns) && k in local) {
        out[k] = local[k];
      } else {
        out[k] = mergePreservingSanitized(local[k], v, patterns);
      }
    }
    for (const [k, v] of Object.entries(local)) {
      if (!(k in out) && keyMatchesAny(k, patterns)) {
        out[k] = v;
      }
    }
    return out;
  }
  return incoming;
}
