import { Remote } from "../core/types";

// Stable identity for a remote's reader: name + transport coordinates. A changed url/branch/subdir
// (or store path) yields a different key so a stale reader is never served after an edit.
export function remoteReaderKey(remote: Remote): string {
  return remote.type === "vault"
    ? `vault:${remote.name}:${remote.storePath}`
    : `git:${remote.name}:${remote.url}:${remote.branch}:${remote.subdir ?? ""}`;
}

// Generation-scoped reader cache. A cached entry is reusable only while its generation matches
// the cache's current generation; bumping the generation invalidates every entry logically.
export class ReaderCache<T> {
  private gen = 0;
  private entries = new Map<string, { value: T; gen: number }>();

  generation(): number {
    return this.gen;
  }

  bumpGeneration(): void {
    this.gen++;
  }

  // Returns the cached value only if it was stored in the current generation; else undefined.
  getReusable(key: string): T | undefined {
    const hit = this.entries.get(key);
    return hit !== undefined && hit.gen === this.gen ? hit.value : undefined;
  }

  store(key: string, value: T): void {
    this.entries.set(key, { value, gen: this.gen });
  }

  clear(): void {
    this.entries.clear();
  }
}
