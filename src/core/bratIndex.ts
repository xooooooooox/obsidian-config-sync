// BRAT id→repo index (spec C1, 2026-07-17). BRAT's own settings hold only "owner/repo"
// strings — the plugin id lives in each repo's manifest.json. The index caches that mapping in
// config-sync's settings so classification (Beta tab) and precise installs work offline once
// any device has resolved a repo. Resolution never runs during capture — only when the mapping
// is actually consumed (Beta tab render, ↻ Re-scan, an install for an unmapped id).

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
