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
  cautionReason: string | null;
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
export const WORKSPACE_CAUTION =
  "Window layout and open tabs — highly device-specific; syncing will make devices overwrite each other.";

export const OPTION_LABELS: Record<string, { label: string; description: string; type: "file" | "dir" }> = {
  "app.json": { label: "Editor & general", description: "Editor and general options.", type: "file" },
  "appearance.json": { label: "Appearance", description: "Theme choice, fonts and interface appearance.", type: "file" },
  "hotkeys.json": { label: "Hotkeys", description: "Custom keyboard shortcuts.", type: "file" },
  themes: { label: "Themes", description: "Installed theme files.", type: "dir" },
  snippets: { label: "CSS snippets", description: "Your CSS snippets.", type: "dir" },
  "core-plugins.json": {
    label: "Enabled core plugins",
    description: "Which core plugins are turned on. Mirrors the whole list across devices.",
    type: "file",
  },
  "community-plugins.json": {
    label: "Enabled community plugins",
    description:
      "Which community plugins are turned on — not the plugins themselves or their settings. Mirrors the whole list: plugins enabled only on the target device get turned off.",
    type: "file",
  },
};

export const CORE_PLUGIN_FILES: Record<string, string> = {
  graph: "graph.json",
  backlink: "backlink.json",
  canvas: "canvas.json",
  "page-preview": "page-preview.json",
  "daily-notes": "daily-notes.json",
  templates: "templates.json",
  "zk-prefixer": "zk-prefixer.json",
  bookmarks: "bookmarks.json",
  "command-palette": "command-palette.json",
  properties: "types.json",
  sync: "sync.json",
  publish: "publish.json",
};
export const CORE_SETTINGS_IDS = Object.keys(CORE_PLUGIN_FILES);
export const CORE_NOT_RECOMMENDED = ["sync", "publish"];

export function corePluginFile(id: string): string {
  return CORE_PLUGIN_FILES[id] ?? `${id}.json`;
}

export function optionReservedName(file: string): string {
  return file.endsWith(".json") ? file.slice(0, -".json".length) : file;
}

export function reservedNames(pluginIds: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of Object.keys(OPTION_LABELS)) names.add(optionReservedName(file));
  for (const id of CORE_SETTINGS_IDS) names.add(id);
  for (const id of pluginIds) names.add(`plugin-${id}`);
  return names;
}

export function expectedPathForName(name: string): string | null {
  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return `{configDir}/${meta.type === "dir" ? name : file}`;
  }
  if (name.startsWith("plugin-")) return `{configDir}/plugins/${name.slice("plugin-".length)}/data.json`;
  if (CORE_SETTINGS_IDS.includes(name)) return `{configDir}/${corePluginFile(name)}`;
  return null;
}

export function findGroupByName(groups: SyncGroup[], name: string): SyncGroup | undefined {
  return groups.find((g) => g.name === name);
}

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
    items.push({
      label: known.label,
      description: known.description,
      path: `{configDir}/${known.file}`,
      type: known.type,
      exists: present,
      disabledReason: null,
      cautionReason: WORKSPACE_RE.test(known.file) ? WORKSPACE_CAUTION : null,
    });
    covered.add(known.file);
  }
  for (const b of [...files].filter((f) => !covered.has(f)).sort()) {
    items.push({
      label: b,
      description: null,
      path: `{configDir}/${b}`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: WORKSPACE_RE.test(b) ? WORKSPACE_CAUTION : null,
    });
    covered.add(b);
  }
  for (const b of [...dirs].filter((d) => !covered.has(d)).sort()) {
    items.push({ label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null, cautionReason: null });
    covered.add(b);
  }
  for (const g of groups) {
    const m = g.path.match(/^\{configDir\}\/([^/]+)$/);
    if (m && m[1] !== undefined && !covered.has(m[1])) {
      items.push({
        label: m[1],
        description: null,
        path: g.path,
        type: g.type,
        exists: false,
        disabledReason: null,
        cautionReason: WORKSPACE_RE.test(m[1]) ? WORKSPACE_CAUTION : null,
      });
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

export function groupForItem(path: string, type: "file" | "dir", existingNames: string[], description: string | null): SyncGroup {
  const group: SyncGroup = { name: slugForPath(path, existingNames), path, type, devices: "all" };
  if (description !== null) group.description = description;
  return group;
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
