import { PluginHost, pluginIdForGroup } from "./ConfigSyncCore";
import { refItemId } from "./itemKeys";
import { lockDesktopOnly, lockEntry, lockEntryList, lockSourceVersion } from "./manifest";
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
  const entry = lockEntry(lock, group.ref);
  const pluginId = pluginIdForGroup(group);
  if (pluginId !== null) {
    const localVersion = plugins.getInstalledPluginVersion(pluginId);
    const storeVersion = lockSourceVersion(entry, "plugin");
    const kind: AvailabilityKind =
      localVersion === null ? "not-installed" : plugins.isPluginEnabled(pluginId) ? "enabled" : "disabled";
    return {
      kind,
      drift: kind === "not-installed" ? null : driftFor(localVersion, storeVersion),
      localVersion,
      storeVersion,
      anchor: "plugin",
      desktopOnly: localVersion !== null ? plugins.isDesktopOnly(pluginId) : lockDesktopOnly(entry),
    };
  }
  const localVersion = plugins.getAppVersion();
  const storeVersion = lockSourceVersion(entry, "app");
  // A LOOKUP on the group's own ref: "is this a core plugin's settings file?" is what the
  // item's section says, not what a bare name happens to match in the runtime core-id list.
  const core = refItemId(group.ref ?? "");
  const kind: AvailabilityKind = core?.section === "core" && !plugins.isCorePluginEnabled(core.id) ? "disabled" : "enabled";
  return { kind, drift: driftFor(localVersion, storeVersion), localVersion, storeVersion, anchor: "app", desktopOnly: false };
}

// One installed plugin whose lock flag disagrees with its manifest — what a capture will correct.
export interface DesktopOnlyFlagDrift {
  id: string;
  label: string; // installed manifest name, lock display label as fallback, id as last resort
  version: string; // the entry's recorded version (equals the installed one — see the gate below)
  willBeDesktopOnly: boolean; // capture writes the flag (true) or clears it (false)
}

// Installed plugin groups whose local desktop-only status differs from what the lock
// records AND that a capture can fix (an entry already exists). Used to nudge a capture so the
// flag propagates to devices that can't read the manifest (mobile). Excludes entryless groups so
// the nudge can't get stuck on a never-captured plugin (the normal capture path handles those).
// Excludes version-mismatched groups too: a device holding a different plugin version than the
// entry records answers for a manifest the store didn't capture — that's version drift with its
// own surface, and counting it here made every mid-upgrade fleet ping-pong the nudge between
// devices (each capture republishing its own version's flag over the other's).
export function desktopOnlyDrift(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): DesktopOnlyFlagDrift[] {
  const drifts: DesktopOnlyFlagDrift[] = [];
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue; // app-anchored
    const localVersion = plugins.getInstalledPluginVersion(id);
    if (localVersion === null) continue; // not installed here
    const entry = lockEntry(lock, g.ref);
    const storeVersion = lockSourceVersion(entry, "plugin");
    if (storeVersion === null) continue; // no entry to refresh
    if (localVersion !== storeVersion) continue; // version drift, not flag drift
    const willBeDesktopOnly = plugins.isDesktopOnly(id);
    if (willBeDesktopOnly === lockDesktopOnly(entry)) continue;
    drifts.push({
      id,
      label: plugins.getInstalledPluginName(id) ?? entry?.display?.label ?? id,
      version: storeVersion,
      willBeDesktopOnly,
    });
  }
  return drifts;
}

// Plugin ids config-sync treats as desktop-only on THIS device — the same manifest-first,
// lock-fallback signal the Desktop-only section uses (via availabilityForGroup), so the auto-except
// set and the section never disagree. Used to auto-except them from the enabled-plugins switch list
// on mobile (a lock-only source missed installed-but-disabled plugins the section catches via manifest).
export function desktopOnlyPluginIds(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue; // app-anchored
    if (availabilityForGroup(g, plugins, lock).desktopOnly) ids.add(id);
  }
  // Lock entries with no local group: a flagged plugin that isn't installed on this device
  // compiles to nothing, so the loop above never reaches its flag — but its element still lives
  // in the store's switch list and must stay masked (otherwise it keeps
  // reappearing in every mobile diff). Manifest stays first: installed plugins are judged by
  // their manifest above, so a stale lock flag alone never masks one.
  // No parse left to do: the lock is keyed by item ref since v3, so a community item's
  // plugin id IS the id half of its key. A companion or a carrier is excluded by refItemId, which
  // answers only for a two-segment key.
  for (const [ref, entry] of lockEntryList(lock?.items ?? {})) {
    const owner = refItemId(ref);
    if (!lockDesktopOnly(entry) || owner?.section !== "community") continue;
    if (plugins.getInstalledPluginVersion(owner.id) === null) ids.add(owner.id);
  }
  return ids;
}

// The per-element mask and the two force sets are NOT derived here:
// enablementDecision.ts is the ONE place a fleet rule and this device's own
// exception are combined into a mask + a force, and main.ts projects all three runtime fields off
// that single decision. What lives here is the DESKTOP-ONLY auto-derivation above
// (desktopOnlyPluginIds), which is a manifest fact rather than a rule the user wrote, and joins the
// mask alongside the decisions rather than through them.

// Enabled snippet names (local list or store list) whose .css file exists neither locally nor
// in the store's snippets dir — dead leftovers from deleted/renamed snippets. Checking the
// store FILES keeps a fresh device safe: before its snippets/ dir syncs down, the store still
// holds the files, so nothing there is offered for cleanup.
export function snippetOrphans(localOn: string[], storeOn: string[], localFiles: string[], storeFiles: string[]): string[] {
  const files = new Set([...localFiles, ...storeFiles]);
  return [...new Set([...localOn, ...storeOn].filter((n) => !files.has(n)))].sort();
}
