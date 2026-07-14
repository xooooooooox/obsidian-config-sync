import { PluginHost } from "./ConfigSyncCore";
import { FileIO } from "./io";
import { SyncGroup } from "./types";

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

export const OPTION_LABELS: Record<string, { label: string; description: string; type: "file" | "dir" }> = {
  "app.json": { label: "App settings", description: "Editor, Files & links and other general options (app.json).", type: "file" },
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

// The ONLY core plugin whose settings file is not `${id}.json`.
const CORE_FILE_EXCEPTIONS: Record<string, string> = { properties: "types.json" };

// Seed fallback for the injected core-id set. Overwritten by the runtime list at plugin load
// (main.ts calls setCorePluginIds), so a stale seed never affects production — it only covers
// unit tests and any pre-injection call. New core plugins are picked up from runtime, not here.
export const CORE_ID_SEED = [
  "graph", "backlink", "canvas", "page-preview", "daily-notes", "templates",
  "zk-prefixer", "bookmarks", "command-palette", "properties", "sync", "publish", "workspaces",
];
export const CORE_NOT_RECOMMENDED = ["sync", "publish"];

let coreIds: Set<string> = new Set(CORE_ID_SEED);

// Injected by main.ts at load with the running Obsidian's core-plugin id set.
export function setCorePluginIds(ids: Iterable<string>): void {
  coreIds = new Set(ids);
}

export function coreSettingsIds(): ReadonlySet<string> {
  return coreIds;
}

export function corePluginFile(id: string): string {
  return CORE_FILE_EXCEPTIONS[id] ?? `${id}.json`;
}

function coreFileSet(): Set<string> {
  const s = new Set<string>();
  for (const id of coreIds) s.add(corePluginFile(id));
  return s;
}

export function optionReservedName(file: string): string {
  return file.endsWith(".json") ? file.slice(0, -".json".length) : file;
}

export function reservedNames(pluginIds: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of Object.keys(OPTION_LABELS)) names.add(optionReservedName(file));
  for (const id of coreSettingsIds()) names.add(id);
  for (const id of pluginIds) names.add(`plugin-${id}`);
  return names;
}

export function expectedPathForName(name: string): string | null {
  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return `{configDir}/${meta.type === "dir" ? name : file}`;
  }
  if (name.startsWith("plugin-")) return `{configDir}/plugins/${name.slice("plugin-".length)}/data.json`;
  if (coreSettingsIds().has(name)) return `{configDir}/${corePluginFile(name)}`;
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
  if (coreSettingsIds().has(name)) {
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

const SWITCH_LISTS = new Set(["core-plugins.json", "community-plugins.json"]);
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
  const coreFiles = coreFileSet();
  const out: { name: string; path: string }[] = [];
  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (knownOptionFiles.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || coreFiles.has(b)) continue;
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
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || coreFileSet().has(b)) continue;
    // unclassified json → Discovered tab section, not here
  }
  for (const b of [...dirs].sort()) {
    if (covered.has(b) || HIDDEN_DIRS.has(b)) continue;
    available.push({ name: b, label: `${b}/`, description: null, path: `{configDir}/${b}`, type: "dir", exists: true, disabledReason: null, cautionReason: null });
    covered.add(b);
  }

  return [
    ...section("available", "Available", "Sync these settings that already exist in this vault.", true, available),
    ...section("notPresent", "Not yet in this vault", "Nothing to sync yet — customize these in Obsidian first, then they'll appear here.", true, notPresent),
  ];
}

export async function listCoreSections(
  io: FileIO,
  configDir: string,
  cores: { id: string; name: string; enabled: boolean }[],
  _groups: SyncGroup[]
): Promise<CatalogSection[]> {
  const { files } = await presentSets(io, configDir);
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
  for (const core of cores) {
    const file = corePluginFile(core.id);
    if (!files.has(file)) continue; // approach A: no settings file → nothing to sync
    const item: CatalogItem = {
      name: core.id,
      label: core.name,
      description: null,
      path: `{configDir}/${file}`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: CORE_NOT_RECOMMENDED.includes(core.id) ? CORE_CAUTION : null,
    };
    (core.enabled ? enabled : disabled).push(item);
  }
  const sort = (a: CatalogItem, b: CatalogItem) => a.label.localeCompare(b.label);
  enabled.sort(sort);
  disabled.sort(sort);

  return [
    ...section("list", "Plugin on/off list", "Which core plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled core plugins.", true, enabled),
    ...section("disabled", "Disabled", "Sync a disabled core plugin's settings now, ready for when you turn it on.", true, disabled),
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
  for (const p of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    const item: CatalogItem = {
      name: `plugin-${p.id}`,
      label: p.name,
      description: `Settings of ${p.id}.`,
      path: `{configDir}/plugins/${p.id}/data.json`,
      type: "file",
      exists: true,
      disabledReason: null,
      cautionReason: null,
    };
    (p.enabled ? enabled : disabled).push(item);
  }
  return [
    ...section("list", "Plugin on/off list", "Which community plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled community plugins.", true, enabled),
    ...section("disabled", "Installed but disabled", "Sync a disabled plugin's settings now, ready for when you turn it on.", true, disabled),
  ];
}

export function groupForItem(name: string, path: string, type: "file" | "dir", description: string | null, label?: string): SyncGroup {
  const group: SyncGroup = { name, path, type, devices: "all" };
  if (description !== null) group.description = description;
  if (label !== undefined && label.trim() !== "") group.label = label.trim();
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

export type ItemCategory = "obsidian" | "core" | "community" | "custom";

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  community: "Community plugins",
  custom: "Custom",
};

export function categoryForGroup(name: string): ItemCategory {
  for (const file of Object.keys(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return "obsidian";
  }
  if (coreSettingsIds().has(name)) return "core";
  if (name.startsWith("plugin-")) return "community";
  return "custom";
}

export function displayLabelForGroup(name: string, plugins: PluginHost, storedLabel?: string): string {
  for (const file of Object.keys(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return OPTION_LABELS[file]?.label ?? name;
  }
  if (coreSettingsIds().has(name)) return plugins.getCorePluginName(name) ?? storedLabel ?? name;
  if (name.startsWith("plugin-")) {
    const id = name.slice("plugin-".length);
    return plugins.getInstalledPluginName(id) ?? storedLabel ?? id;
  }
  return storedLabel ?? name;
}
