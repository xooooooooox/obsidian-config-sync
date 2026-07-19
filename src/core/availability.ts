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
