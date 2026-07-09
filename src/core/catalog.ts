import { FileIO } from "./io";
import { SyncGroup } from "./types";
import { BLACKLISTED_PLUGIN_DIRS } from "./manifest";

export interface CatalogItem {
  name: string;
  label: string;
  description: string | null;
  path: string;
  type: "file" | "dir";
  exists: boolean;
  disabledReason: string | null;
  cautionReason: string | null;
}

export interface CatalogSection {
  bucket: string;
  heading: string;
  description: string;
  allowSyncAll: boolean;
  items: CatalogItem[];
}

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

export function defaultGroupForName(name: string): SyncGroup | null {
  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (optionReservedName(file) === name) {
      return {
        name,
        path: `{configDir}/${meta.type === "dir" ? name : file}`,
        type: meta.type,
        devices: "all",
        description: meta.description,
      };
    }
  }
  if (name.startsWith("plugin-")) {
    const id = name.slice("plugin-".length);
    return { name, path: `{configDir}/plugins/${id}/data.json`, type: "file", devices: "all", description: `Settings of ${id}.` };
  }
  if (CORE_SETTINGS_IDS.includes(name)) {
    return { name, path: `{configDir}/${corePluginFile(name)}`, type: "file", devices: "all" };
  }
  return null;
}

export function findGroupByName(groups: SyncGroup[], name: string): SyncGroup | undefined {
  return groups.find((g) => g.name === name);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

const CORE_FILE_SET = new Set(Object.values(CORE_PLUGIN_FILES));
const SWITCH_LISTS = new Set(["core-plugins.json", "community-plugins.json"]);
const BLACKLIST_REASON = "Machine-bound or credential-bearing — cannot be synced.";
const CORE_CAUTION = "Contains account or device-specific data — not meant to travel between vaults.";

function section(bucket: string, heading: string, description: string, allowSyncAll: boolean, items: CatalogItem[]): CatalogSection[] {
  return items.length > 0 ? [{ bucket, heading, description, allowSyncAll, items }] : [];
}

async function presentSets(io: FileIO, configDir: string): Promise<{ files: Set<string>; dirs: Set<string> }> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (await io.exists(configDir)) {
    const listed = await io.list(configDir);
    for (const f of listed.files) files.add(basename(f));
    for (const d of listed.folders) dirs.add(basename(d));
  }
  return { files, dirs };
}

export async function listDiscovered(
  io: FileIO,
  configDir: string,
  groups: SyncGroup[]
): Promise<{ name: string; path: string }[]> {
  const { files } = await presentSets(io, configDir);
  const coveredPaths = new Set(groups.map((g) => g.path));
  const knownOptionFiles = new Set(Object.keys(OPTION_LABELS));
  const out: { name: string; path: string }[] = [];
  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (knownOptionFiles.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    const path = `{configDir}/${b}`;
    if (coveredPaths.has(path)) continue;
    out.push({ name: optionReservedName(b), path });
  }
  return out;
}

export async function listOptionSections(io: FileIO, configDir: string, _groups: SyncGroup[]): Promise<CatalogSection[]> {
  const { files, dirs } = await presentSets(io, configDir);
  const available: CatalogItem[] = [];
  const notPresent: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  const covered = new Set<string>();

  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (SWITCH_LISTS.has(file)) continue; // switch lists live in Core/Community tabs
    covered.add(file);
    const isDir = meta.type === "dir";
    const present = isDir ? dirs.has(file) : files.has(file);
    const item: CatalogItem = {
      name: optionReservedName(file),
      label: meta.label,
      description: meta.description,
      path: `{configDir}/${file}`,
      type: meta.type,
      exists: present,
      disabledReason: null,
      cautionReason: null,
    };
    (present ? available : notPresent).push(item);
  }

  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    if (WORKSPACE_RE.test(b)) {
      notRecommended.push({
        name: optionReservedName(b),
        label: b,
        description: null,
        path: `{configDir}/${b}`,
        type: "file",
        exists: true,
        disabledReason: null,
        cautionReason: WORKSPACE_CAUTION,
      });
      covered.add(b);
      continue;
    }
    // any other unclassified json → Discovered tab section, not here
  }
  for (const b of [...dirs].sort()) {
    if (covered.has(b) || HIDDEN_DIRS.has(b)) continue;
    available.push({ name: b, label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null, cautionReason: null });
    covered.add(b);
  }

  return [
    ...section("available", "Available", "Sync these settings that already exist in this vault.", true, available),
    ...section("notPresent", "Not yet in this vault", "Nothing to sync yet — customize these in Obsidian first, then they'll appear here.", true, notPresent),
    ...section("notRecommended", "Not recommended", "Device-specific — syncing makes your devices overwrite each other's layout.", false, notRecommended),
  ];
}

export async function listCoreSections(
  io: FileIO,
  configDir: string,
  cores: { id: string; name: string; enabled: boolean }[],
  _groups: SyncGroup[]
): Promise<CatalogSection[]> {
  const { files } = await presentSets(io, configDir);
  const byId = new Map(cores.map((c) => [c.id, c]));
  const switchItem: CatalogItem = {
    name: "core-plugins",
    label: OPTION_LABELS["core-plugins.json"]!.label,
    description: OPTION_LABELS["core-plugins.json"]!.description,
    path: "{configDir}/core-plugins.json",
    type: "file",
    exists: files.has("core-plugins.json"),
    disabledReason: null,
    cautionReason: null,
  };

  const enabled: CatalogItem[] = [];
  const disabled: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  for (const id of CORE_SETTINGS_IDS) {
    const core = byId.get(id);
    if (core === undefined) continue; // core plugin absent in this Obsidian build
    const file = corePluginFile(id);
    const item: CatalogItem = {
      name: id,
      label: core.name,
      description: null,
      path: `{configDir}/${file}`,
      type: "file",
      exists: files.has(file),
      disabledReason: null,
      cautionReason: CORE_NOT_RECOMMENDED.includes(id) ? CORE_CAUTION : null,
    };
    if (CORE_NOT_RECOMMENDED.includes(id)) notRecommended.push(item);
    else (core.enabled ? enabled : disabled).push(item);
  }
  const sort = (a: CatalogItem, b: CatalogItem) => a.label.localeCompare(b.label);
  enabled.sort(sort);
  disabled.sort(sort);
  notRecommended.sort(sort);

  return [
    ...section("list", "Plugin on/off list", "Which core plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled core plugins.", true, enabled),
    ...section("disabled", "Disabled", "Sync a disabled core plugin's settings now, ready for when you turn it on.", true, disabled),
    ...section("notRecommended", "Not recommended", "Holds account or device-specific data — not meant to travel between vaults.", false, notRecommended),
  ];
}

export async function listPluginSections(
  io: FileIO,
  configDir: string,
  plugins: { id: string; name: string; enabled: boolean }[],
  _groups: SyncGroup[]
): Promise<CatalogSection[]> {
  const { files } = await presentSets(io, configDir);
  const switchItem: CatalogItem = {
    name: "community-plugins",
    label: OPTION_LABELS["community-plugins.json"]!.label,
    description: OPTION_LABELS["community-plugins.json"]!.description,
    path: "{configDir}/community-plugins.json",
    type: "file",
    exists: files.has("community-plugins.json"),
    disabledReason: null,
    cautionReason: null,
  };
  const enabled: CatalogItem[] = [];
  const disabled: CatalogItem[] = [];
  const notRecommended: CatalogItem[] = [];
  for (const p of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    const item: CatalogItem = {
      name: `plugin-${p.id}`,
      label: p.name,
      description: `Settings of ${p.id}.`,
      path: `{configDir}/plugins/${p.id}/data.json`,
      type: "file",
      exists: true,
      disabledReason: BLACKLISTED_PLUGIN_DIRS.includes(p.id) ? BLACKLIST_REASON : null,
      cautionReason: null,
    };
    if (item.disabledReason !== null) notRecommended.push(item);
    else (p.enabled ? enabled : disabled).push(item);
  }
  return [
    ...section("list", "Plugin on/off list", "Which community plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled community plugins.", true, enabled),
    ...section("disabled", "Installed but disabled", "Sync a disabled plugin's settings now, ready for when you turn it on.", true, disabled),
    ...section("notRecommended", "Not recommended", BLACKLIST_REASON, false, notRecommended),
  ];
}

export function groupForItem(name: string, path: string, type: "file" | "dir", description: string | null): SyncGroup {
  const group: SyncGroup = { name, path, type, devices: "all" };
  if (description !== null) group.description = description;
  return group;
}

export function toggleSection(groups: SyncGroup[], items: CatalogItem[], on: boolean): SyncGroup[] {
  const names = new Set(items.filter((i) => i.disabledReason === null).map((i) => i.name));
  if (!on) return groups.filter((g) => !names.has(g.name));
  const next = [...groups];
  const have = new Set(groups.map((g) => g.name));
  for (const item of items) {
    if (item.disabledReason !== null || have.has(item.name)) continue;
    next.push(groupForItem(item.name, item.path, item.type, item.description));
  }
  return next;
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
