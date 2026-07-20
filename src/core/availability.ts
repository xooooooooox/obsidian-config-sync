import { PluginHost, pluginIdForGroup } from "./ConfigSyncCore";
import { coreSettingsIds } from "./catalog";
import { StoreLock, SyncGroup } from "./types";

export type AvailabilityKind = "enabled" | "disabled" | "not-installed";
export type VersionDrift = "behind" | "ahead" | null; // local vs store: behind = local < store

export interface Availability {
  kind: AvailabilityKind;
  drift: VersionDrift;
  localVersion: string | null;
  storeVersion: string | null;
  anchor: "plugin" | "app";
  desktopOnly: boolean; // the plugin can't run on mobile (from the lock; false for app-anchored)
}

// Dotted compare: numeric segments numerically, non-numeric lexically, missing = "0".
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? "0";
    const y = bs[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function driftFor(local: string | null, store: string | null): VersionDrift {
  if (local === null || store === null) return null;
  const c = compareVersions(local, store);
  return c === 0 ? null : c < 0 ? "behind" : "ahead";
}

export function availabilityForGroup(group: SyncGroup, plugins: PluginHost, lock: StoreLock | null): Availability {
  const pluginId = pluginIdForGroup(group);
  if (pluginId !== null) {
    const localVersion = plugins.getInstalledPluginVersion(pluginId);
    const storeVersion = lock?.groups[group.name]?.sourcePluginVersion ?? null;
    const kind: AvailabilityKind =
      localVersion === null ? "not-installed" : plugins.isPluginEnabled(pluginId) ? "enabled" : "disabled";
    return {
      kind,
      drift: kind === "not-installed" ? null : driftFor(localVersion, storeVersion),
      localVersion,
      storeVersion,
      anchor: "plugin",
      desktopOnly: localVersion !== null ? plugins.isDesktopOnly(pluginId) : lock?.groups[group.name]?.desktopOnly === true,
    };
  }
  const localVersion = plugins.getAppVersion();
  const storeVersion = lock?.groups[group.name]?.sourceAppVersion ?? null;
  const isCore = coreSettingsIds().has(group.name);
  const kind: AvailabilityKind = isCore && !plugins.isCorePluginEnabled(group.name) ? "disabled" : "enabled";
  return { kind, drift: driftFor(localVersion, storeVersion), localVersion, storeVersion, anchor: "app", desktopOnly: false };
}

// Counts installed plugin groups whose local desktop-only status differs from what the lock
// records AND that a capture can fix (an entry already exists). Used to nudge a capture so the
// flag propagates to devices that can't read the manifest (mobile). Excludes entryless groups so
// the nudge can't get stuck on a never-captured plugin (the normal capture path handles those).
export function desktopOnlyDrift(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): number {
  let n = 0;
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue; // app-anchored
    if (plugins.getInstalledPluginVersion(id) === null) continue; // not installed here
    const entry = lock?.groups[g.name];
    if (entry?.sourcePluginVersion === undefined) continue; // no entry to refresh
    if (plugins.isDesktopOnly(id) !== (entry.desktopOnly === true)) n++;
  }
  return n;
}

// Plugin ids the store records as desktop-only (from the lock's per-group flags). The lock is the
// source that also works on a phone, where the plugin isn't installed and its manifest can't be
// read — used to auto-except them from the enabled-plugins switch list so a phone doesn't drop them.
export function desktopOnlyPluginIds(lock: StoreLock | null): Set<string> {
  const ids = new Set<string>();
  if (lock === null) return ids;
  for (const [name, entry] of Object.entries(lock.groups)) {
    if (entry.desktopOnly === true && name.startsWith("plugin-")) ids.add(name.slice("plugin-".length));
  }
  return ids;
}
