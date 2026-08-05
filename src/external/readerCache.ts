import { Remote } from "../core/types";

// Stable identity for a remote's reader: name + transport coordinates. A changed url/branch/subdir
// (or store path) yields a different key so a stale reader is never served after an edit.
export function remoteReaderKey(remote: Remote): string {
  return remote.type === "vault"
    ? `vault:${remote.name}:${remote.storePath}`
    : `git:${remote.name}:${remote.url}:${remote.branch}:${remote.subdir ?? ""}`;
}

// A same-generation hit older than this is treated as a miss: with auto-check off (or within
// its refresh window) a generation can live for hours, and serving a days-old clone as "remote
// matches" is worse than the extra clone a fresh read costs.
export const REUSE_MAX_AGE_MS = 300_000;

// Generation-scoped reader cache. A cached entry is reusable only while its generation matches
// the cache's current generation AND it isn't older than REUSE_MAX_AGE_MS; bumping the
// generation invalidates every entry logically.
export class ReaderCache<T> {
  private gen = 0;
  private entries = new Map<string, { value: T; gen: number; at: number }>();

  constructor(private readonly now: () => number) {}

  generation(): number {
    return this.gen;
  }

  bumpGeneration(): void {
    this.gen++;
  }

  // Returns the cached value only if it was stored in the current generation and within
  // REUSE_MAX_AGE_MS of now; else undefined.
  getReusable(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined || hit.gen !== this.gen) return undefined;
    return this.now() - hit.at <= REUSE_MAX_AGE_MS ? hit.value : undefined;
  }

  store(key: string, value: T): void {
    this.entries.set(key, { value, gen: this.gen, at: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
