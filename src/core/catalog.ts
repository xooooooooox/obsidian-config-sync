import { FileIO } from "./io";
import { SyncGroup } from "./types";
import { BLACKLISTED_PLUGIN_DIRS } from "./manifest";

export interface CatalogItem {
  label: string;
  description: string | null;
  path: string;
  type: "file" | "dir";
  exists: boolean;
  disabledReason: string | null;
}

export interface PluginItem {
  id: string;
  name: string;
  dataPath: string;
  disabledReason: string | null;
}

interface KnownEntry {
  file: string;
  type: "file" | "dir";
  label: string;
  description: string;
}

export const KNOWN_OPTIONS: KnownEntry[] = [
  { file: "app.json", type: "file", label: "Editor & general", description: "Editor and general options." },
  { file: "appearance.json", type: "file", label: "Appearance", description: "Theme choice, fonts and interface appearance." },
  { file: "themes", type: "dir", label: "Themes", description: "Installed theme files." },
  { file: "snippets", type: "dir", label: "CSS snippets", description: "Your CSS snippets." },
  { file: "hotkeys.json", type: "file", label: "Hotkeys", description: "Custom keyboard shortcuts." },
  { file: "graph.json", type: "file", label: "Graph view", description: "Graph view settings." },
  { file: "types.json", type: "file", label: "Properties", description: "Property type definitions." },
  { file: "command-palette.json", type: "file", label: "Command palette", description: "Pinned commands." },
  { file: "page-preview.json", type: "file", label: "Page preview", description: "Page preview settings." },
  { file: "backlink.json", type: "file", label: "Backlinks", description: "Backlink settings." },
  { file: "canvas.json", type: "file", label: "Canvas", description: "Canvas settings." },
  { file: "daily-notes.json", type: "file", label: "Daily notes", description: "Daily notes settings." },
  { file: "templates.json", type: "file", label: "Templates", description: "Template settings." },
  { file: "zk-prefixer.json", type: "file", label: "Unique note creator", description: "Unique note prefix settings." },
  { file: "bookmarks.json", type: "file", label: "Bookmarks", description: "Your bookmarks." },
  { file: "core-plugins.json", type: "file", label: "Enabled core plugins", description: "Which core plugins are turned on." },
  {
    file: "community-plugins.json",
    type: "file",
    label: "Enabled community plugins",
    description:
      "Which community plugins are turned on — not the plugins themselves or their settings. This mirrors the whole list: plugins enabled only on the target device get turned off. Best when your devices run the same plugins.",
  },
];

const HIDDEN_FILES = new Set(["core-plugins-migration.json"]);
const HIDDEN_DIRS = new Set(["plugins"]);
const WORKSPACE_RE = /^workspace.*\.json$/;
export const DEVICE_SPECIFIC_REASON = "Device-specific window layout — never synced.";

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export async function listOptionItems(io: FileIO, configDir: string, groups: SyncGroup[]): Promise<CatalogItem[]> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (await io.exists(configDir)) {
    const listed = await io.list(configDir);
    for (const f of listed.files) {
      const b = basename(f);
      if (b.endsWith(".json") && !HIDDEN_FILES.has(b)) files.add(b);
    }
    for (const d of listed.folders) {
      const b = basename(d);
      if (!HIDDEN_DIRS.has(b)) dirs.add(b);
    }
  }
  const items: CatalogItem[] = [];
  const covered = new Set<string>();
  for (const known of KNOWN_OPTIONS) {
    const present = known.type === "file" ? files.has(known.file) : dirs.has(known.file);
    const path = `{configDir}/${known.file}`;
    const checked = findGroupByPath(groups, path) !== undefined;
    if (present || checked) {
      items.push({ label: known.label, description: known.description, path, type: known.type, exists: present, disabledReason: null });
    }
    covered.add(known.file);
  }
  for (const b of [...files].filter((f) => !covered.has(f)).sort()) {
    const disabled = WORKSPACE_RE.test(b) ? DEVICE_SPECIFIC_REASON : null;
    items.push({ label: b, description: null, path: `{configDir}/${b}`, type: "file", exists: true, disabledReason: disabled });
    covered.add(b);
  }
  for (const b of [...dirs].filter((d) => !covered.has(d)).sort()) {
    items.push({ label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null });
    covered.add(b);
  }
  for (const g of groups) {
    const m = g.path.match(/^\{configDir\}\/([^/]+)$/);
    if (m && m[1] !== undefined && !covered.has(m[1])) {
      const disabled = WORKSPACE_RE.test(m[1]) ? DEVICE_SPECIFIC_REASON : null;
      items.push({ label: m[1], description: null, path: g.path, type: g.type, exists: false, disabledReason: disabled });
      covered.add(m[1]);
    }
  }
  return items;
}

export function listPluginItems(installed: { id: string; name: string }[]): PluginItem[] {
  return [...installed]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      dataPath: `{configDir}/plugins/${p.id}/data.json`,
      disabledReason: BLACKLISTED_PLUGIN_DIRS.includes(p.id)
        ? "Machine-bound or credential-bearing — cannot be synced."
        : null,
    }));
}

export function findGroupByPath(groups: SyncGroup[], path: string): SyncGroup | undefined {
  return groups.find((g) => g.path === path);
}

export function slugForPath(path: string, existingNames: string[]): string {
  const pluginMatch = path.match(/^\{configDir\}\/plugins\/([^/]+)\/data\.json$/);
  let base: string;
  if (pluginMatch && pluginMatch[1] !== undefined) {
    base = `plugin-${pluginMatch[1]}`;
  } else {
    const b = basename(path).replace(/\.json$/, "");
    base = b.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  }
  if (!existingNames.includes(base)) return base;
  let i = 2;
  while (existingNames.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function groupForItem(path: string, type: "file" | "dir", existingNames: string[]): SyncGroup {
  return { name: slugForPath(path, existingNames), path, type, devices: "all" };
}

export function splitLocation(path: string): { location: "config" | "vault"; rel: string } {
  if (path.startsWith("{configDir}/")) {
    return { location: "config", rel: path.slice("{configDir}/".length) };
  }
  return { location: "vault", rel: path };
}

export function joinLocation(location: "config" | "vault", rel: string): string {
  return location === "config" ? `{configDir}/${rel}` : rel;
}
