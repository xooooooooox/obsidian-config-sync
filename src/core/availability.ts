import { PluginHost, pluginIdForGroup } from "./ConfigSyncCore";
import { coreSettingsIds } from "./catalog";
import { MEMBER_RULES, MemberRule, RuleScope, StoreLock, SyncGroup } from "./types";

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
  for (const [name, entry] of Object.entries(lock?.groups ?? {})) {
    if (entry?.desktopOnly !== true || !name.startsWith("plugin-")) continue;
    const id = name.slice("plugin-".length);
    if (plugins.getInstalledPluginVersion(id) === null) ids.add(id);
  }
  return ids;
}

// Normalizes a stored RuleScope into a MemberRule (Sync Center unified grammar, task 2):
// all/desktop/mobile pass through unchanged (both types share those three literals); a legacy
// "local" scope — the pre-unification "this device decides for itself" value — resolves to a
// direction using the member's current PERSISTED local on/off state (the same on-disk switch-list
// content applySwitchList's exception pass-through reads — NEVER a live PluginHost query, which
// can diverge: a non-persistent enablePlugin, used by config-sync's own apply cycle and the IOTO
// ecosystem, loads a plugin without adding it to the persisted enabled set — see pluginState.ts),
// so old data keeps working under the new always-here/never-here vocabulary without a
// stored-format migration.
//
// Mask derivation from the resulting MemberRule (documented once, here, for every apply-site
// consumer): desktop/mobile on the matching device class → no mask (plain store membership); on
// the other class → exception + forceOff (existing behavior, unchanged semantics); never-here →
// exception + forceOff; always-here → exception + forceOn (new); all → nothing.
export function normalizeMemberRule(scope: RuleScope, locallyOn: boolean): MemberRule {
  if (scope !== "local") return scope;
  return locallyOn ? "always-here" : "never-here";
}

// The single narrowing point for a stored rule value (spec 2026-08-11-data-model-hardening.md
// §3.2, invariant II.2): settings.memberRules is typed at compile time but its content is raw
// data.json at runtime, so a value this build doesn't recognise — exactly what a NEWER build
// writes — arrives here. It is ignored where it is used, and left untouched on disk: rewriting
// storage to drop it would propagate the deletion to the whole fleet on the next capture.
export function asMemberRule(value: unknown): MemberRule | undefined {
  return (MEMBER_RULES as readonly unknown[]).includes(value) ? (value as MemberRule) : undefined;
}

// A genuinely stored MemberRule (the Runs-on menu, task 5, writing directly) always wins over
// re-deriving direction from local state — once a value is stored, mask producers stop
// re-normalizing it on every read. Absent a recognised stored value, falls back to
// normalizeMemberRule against the legacy "this device" pin — old data (localMembers, no stored
// rule yet) keeps working exactly as before this fell back to a real stored home.
export function preferStoredMemberRule(stored: unknown, persistedLocallyOn: boolean): MemberRule {
  return asMemberRule(stored) ?? normalizeMemberRule("local", persistedLocallyOn);
}

// Member names whose shared scope excludes the current device class. Feeds the exception mask
// (capture pass-through + compare masking) exactly like desktopOnlyPluginIds does for plugins.
export function scopedAwayMembers(scopes: Record<string, "desktop" | "mobile">, isMobile: boolean): Set<string> {
  const want = isMobile ? "mobile" : "desktop";
  const out = new Set<string>();
  for (const [name, scope] of Object.entries(scopes)) if (scope !== want) out.add(name);
  return out;
}

// The apply must force OFF members scoped away from this device — scope-away minus This-device
// ids, since an explicit local decision (local > scope) must keep the machine's own on/off.
export function memberForceOff(scopes: Record<string, "desktop" | "mobile">, localIds: string[], isMobile: boolean): string[] {
  const localSet = new Set(localIds);
  return [...scopedAwayMembers(scopes, isMobile)].filter((id) => !localSet.has(id));
}

// Enabled snippet names (local list or store list) whose .css file exists neither locally nor
// in the store's snippets dir — dead leftovers from deleted/renamed snippets. Checking the
// store FILES keeps a fresh device safe: before its snippets/ dir syncs down, the store still
// holds the files, so nothing there is offered for cleanup.
export function snippetOrphans(localOn: string[], storeOn: string[], localFiles: string[], storeFiles: string[]): string[] {
  const files = new Set([...localFiles, ...storeFiles]);
  return [...new Set([...localOn, ...storeOn].filter((n) => !files.has(n)))].sort();
}
