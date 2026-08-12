import { PluginHost, pluginIdForGroup } from "./ConfigSyncCore";
import { refItemId } from "./itemKeys";
import { lockDesktopOnly, lockEntry, lockEntryList, lockSourceVersion } from "./manifest";
import { RunsOn, StoreLock, SyncGroup } from "./types";

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
  // A LOOKUP on the group's own ref (spec §5): "is this a core plugin's settings file?" is what the
  // item's section says, not what a bare name happens to match in the runtime core-id list.
  const core = refItemId(group.ref ?? "");
  const kind: AvailabilityKind = core?.section === "core" && !plugins.isCorePluginEnabled(core.id) ? "disabled" : "enabled";
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
    const entry = lockEntry(lock, g.ref);
    if (lockSourceVersion(entry, "plugin") === null) continue; // no entry to refresh
    if (plugins.isDesktopOnly(id) !== lockDesktopOnly(entry)) n++;
  }
  return n;
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
  // in the store's switch list and must stay masked (2026-07-27 mobile find: "simpread" kept
  // reappearing in every mobile diff). Manifest stays first: installed plugins are judged by
  // their manifest above, so a stale lock flag alone never masks one.
  // No parse left to do: the lock is keyed by item ref since v3 (spec §3), so a community item's
  // plugin id IS the id half of its key. A companion or a carrier is excluded by refItemId, which
  // answers only for a two-segment key.
  for (const [ref, entry] of lockEntryList(lock?.items ?? {})) {
    const owner = refItemId(ref);
    if (!lockDesktopOnly(entry) || owner?.section !== "community") continue;
    if (plugins.getInstalledPluginVersion(owner.id) === null) ids.add(owner.id);
  }
  return ids;
}

// The RunsOn a this-device pin resolves to (Sync Center unified grammar, task 2): a pin says "this
// device decides for itself", and what it has decided is read from the member's current PERSISTED
// local on/off state — the same on-disk switch-list content applySwitchList's exception
// pass-through reads, NEVER a live PluginHost query, which can diverge (a non-persistent
// enablePlugin, used by config-sync's own apply cycle and the IOTO ecosystem, loads a plugin
// without adding it to the persisted enabled set — see pluginState.ts).
//
// `where: "everywhere"` preserves today's behaviour exactly: a "here" rule is fleet-wide in effect
// whatever the copy says (C-#46), and whether it SHOULD be is explicitly out of scope (spec §8).
//
// Mask derivation from the resulting RunsOn (documented once, here, for every apply-site
// consumer): device desktop/mobile on the matching class → no mask (plain store membership); on
// the other class → exception + forceOff; force off → exception + forceOff; force on → exception +
// forceOn; device all with no force → nothing.
export function forcedRunsOn(locallyOn: boolean): RunsOn {
  return { device: "all", force: { state: locallyOn ? "on" : "off", where: "everywhere" } };
}

// A genuinely stored RunsOn (the Runs-on menu writing directly) always wins over re-deriving a
// direction from local state — once a value is stored, mask producers stop re-normalizing it on
// every read. Absent one, falls back to the this-device pin's reading, so a pin with no rule of
// its own keeps working exactly as it did before the rule had a stored home.
export function preferStoredRunsOn(stored: RunsOn | undefined, persistedLocallyOn: boolean): RunsOn {
  return stored ?? forcedRunsOn(persistedLocallyOn);
}

// Member names whose device class excludes the current one. Feeds the exception mask
// (capture pass-through + compare masking) exactly like desktopOnlyPluginIds does for plugins.
export function membersExcludedByClass(classes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string> {
  const want = isMobile ? "mobile" : "desktop";
  const out = new Set<string>();
  for (const [name, cls] of Object.entries(classes)) if (cls !== want) out.add(name);
  return out;
}

// The apply must force OFF members pinned away from this device — class-away minus this-device
// ids, since an explicit this-device decision must keep the machine's own on/off.
export function memberForceOff(classes: Record<string, "desktop" | "mobile">, localIds: string[], isMobile: boolean): string[] {
  const localSet = new Set(localIds);
  return [...membersExcludedByClass(classes, isMobile)].filter((id) => !localSet.has(id));
}

// Enabled snippet names (local list or store list) whose .css file exists neither locally nor
// in the store's snippets dir — dead leftovers from deleted/renamed snippets. Checking the
// store FILES keeps a fresh device safe: before its snippets/ dir syncs down, the store still
// holds the files, so nothing there is offered for cleanup.
export function snippetOrphans(localOn: string[], storeOn: string[], localFiles: string[], storeFiles: string[]): string[] {
  const files = new Set([...localFiles, ...storeFiles]);
  return [...new Set([...localOn, ...storeOn].filter((n) => !files.has(n)))].sort();
}
