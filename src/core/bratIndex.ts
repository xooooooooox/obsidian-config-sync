// BRAT id→repo index (spec C1, 2026-07-17). BRAT's own settings hold only "owner/repo"
// strings — the plugin id lives in each repo's manifest.json. The mapping is cached on each
// plugin's own item (`Item.bratRepo`, task 6 — was a top-level `bratIndex` map, a second list of
// plugin ids that could drift from `items.community`) so classification (Beta tab) and precise
// installs work offline once any device has resolved a repo. Resolution never runs during
// capture — only when the mapping is actually consumed (Beta tab render, ↻ Re-scan, an install
// for an unmapped id).

import { Item, ItemMap, itemAt, withItem } from "./registry";

export type BratIndex = Record<string, string>; // plugin id → "owner/repo"

// Fetches a repo's manifest.json content, or null when unreachable. The host wires this to
// Obsidian's requestUrl against raw.githubusercontent.com (default branch).
export type ManifestFetcher = (repo: string) => Promise<string | null>;

// Fill + prune: repos already resolved are kept without refetching; repos gone from BRAT's
// list lose their entries; fetch failures and malformed manifests leave the repo unresolved
// (retried at the next trigger) — never thrown into the UI.
export async function resolveBratIndex(current: BratIndex, repos: string[], fetchManifest: ManifestFetcher): Promise<BratIndex> {
  const repoSet = new Set(repos);
  const next: BratIndex = {};
  for (const [id, repo] of Object.entries(current)) {
    if (repoSet.has(repo)) next[id] = repo;
  }
  const resolved = new Set(Object.values(next));
  for (const repo of repos) {
    if (resolved.has(repo)) continue;
    const content = await fetchManifest(repo);
    if (content === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string") {
      next[(parsed as { id: string }).id] = repo;
    }
  }
  return next;
}

// The id -> repo view of the items map, for the resolver and for `betaIds`.
export function bratRepoIndex(items: ItemMap): BratIndex {
  const out: BratIndex = {};
  for (const [id, item] of Object.entries(items.community)) {
    if (item.bratRepo !== undefined) out[id] = item.bratRepo;
  }
  return out;
}

// The inverse write: every id in `index` gets its repo, every community item whose repo left the
// index loses the field. An id with no item yet gets a `{synced: false}` skeleton — recording where
// a plugin came from is not a decision to start syncing it.
//
// Never deletes an entry, only ever adds/updates through `withItem` (registry.ts) — an item that
// loses its `bratRepo` and is left carrying only `{synced: false}` is NOT residue to prune. The
// same reasoning `itemEarnsDef`'s comment gives for a plain disabled entry applies here unchanged:
// its presence in `items.community` is this device's capture mask for that plugin's slot in the
// community-plugins on/off list, and pruning it on write would be the exact C-#26-by-false-analogy
// mistake registry.ts's `withItem` comment already warns against.
export function withBratRepos(items: ItemMap, index: BratIndex): ItemMap {
  let next = items;
  const ids = new Set([...Object.keys(items.community), ...Object.keys(index)]);
  for (const id of ids) {
    const existing = itemAt(next, "community", id);
    const repo = index[id];
    if (existing === undefined) {
      if (repo === undefined) continue; // no item and nothing to record — nothing to do
      next = withItem(next, "community", id, { synced: false, bratRepo: repo });
      continue;
    }
    if (existing.bratRepo === repo) continue; // already agrees (both undefined counts as agreeing)
    const updated: Item = { ...existing };
    if (repo === undefined) delete updated.bratRepo;
    else updated.bratRepo = repo;
    next = withItem(next, "community", id, updated);
  }
  return next;
}

// Reads BRAT's repo list out of its data.json content. Tolerant: any malformed shape yields [].
export function parseBratRepoList(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as { pluginList?: unknown }).pluginList;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is string => typeof r === "string");
}
