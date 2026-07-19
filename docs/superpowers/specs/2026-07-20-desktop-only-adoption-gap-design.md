# Desktop-only adoption-gap fix — design

1.1.2 shipped desktop-only detection, but `availabilityForGroup` derives
`desktopOnly` **only** from the store lock, and the lock's flag is only written
when a plugin is captured. In-sync plugins are never re-captured, so their flag
never lands — no pill on desktop, no Desktop-only section on mobile, even though
the local manifest plainly declares `isDesktopOnly`. This closes that gap.

Three parts: ① desktop reads the local manifest directly; ② any capture refreshes
the flag for every installed plugin in the lock; Y surfaces "flags not aligned"
as a self-pane "to capture" nudge so ② actually gets triggered. Approved
2026-07-20. Targets 1.1.3 (bundled with the mobile-overflow fixes already on main).

## ① Desktop reads the local manifest

**Problem.** On desktop the plugin is installed — its `manifest.json` carries the
authoritative `isDesktopOnly` — yet `availabilityForGroup` ignores it and reads
only `lock.groups[name].desktopOnly`, which needs a capture to be set.

**Change (`src/core/availability.ts`, plugin-anchored branch).** When the plugin
is installed, take the flag from the local manifest; fall back to the lock only
when it is not installed (the mobile case, which can't read a manifest):

```ts
desktopOnly:
  localVersion !== null
    ? plugins.isDesktopOnly(pluginId)                       // installed → manifest is truth
    : lock?.groups[group.name]?.desktopOnly === true,       // not installed (mobile) → lock
```

`PluginHost.isDesktopOnly` already exists. App-anchored groups stay
`desktopOnly: false`. This makes the desktop pill correct immediately — no
re-capture, no lock dependency.

## ② Capture refreshes every installed plugin's flag

**Where.** `capture()` (`src/core/ConfigSyncCore.ts`) already iterates **all**
manifest groups and rewrites the whole lock each run: selected groups get a fresh
entry; unselected (and errored) groups **carry their previous lock entry
forward** via `lock.groups[name] = prev`. The backfill rides those carry-forward
writes — no new pass, no payload coupling.

**New helper (same file).**

```ts
function refreshLockDesktopOnly(
  entry: { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean },
  group: SyncGroup,
  plugins: PluginHost
): { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean } {
  const pluginId = pluginIdForGroup(group);
  if (pluginId === null || plugins.getInstalledPluginVersion(pluginId) === null) return entry; // app-anchored or not installed here → untouched
  const { desktopOnly, ...rest } = entry;
  return plugins.isDesktopOnly(pluginId) ? { ...rest, desktopOnly: true } : rest;
}
```

Wrap the two carry-forward sites (the not-selected branch and the errored-capture
branch) so each becomes `lock.groups[group.name] = refreshLockDesktopOnly(prev, group, ctx.plugins)`.
Selected groups already write the correct flag through the existing
`isDesktopOnly` path (unchanged).

**Effect.** Any capture — even capturing one item, even just the config-sync self
group — rewrites the whole lock with every installed plugin's flag set to match
its manifest (added, corrected, or cleared). One capture = full refresh.

**Scope guard.** Only groups that already have a lock entry are refreshed
(carry-forward only touches `prev !== undefined`); an installed-but-never-captured
plugin has no entry and is not fabricated one (a version-less `{desktopOnly}` entry
would fail `parseStoreLock`). Such a plugin is in `not-captured` state and gets its
entry — with the flag — through the normal capture path. Groups not installed on
this device are left untouched (another device is authoritative for them).

## Y — "flags not aligned" nudges a capture

②only runs when a capture runs. In steady state nothing is captured, so the flags
would never land. Y makes the misalignment itself a capture signal, mirroring the
existing version-refresh nudge.

**Detection (`src/core/availability.ts`, new pure function).**

```ts
export function desktopOnlyDrift(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): number {
  let n = 0;
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue;                                    // app-anchored
    if (plugins.getInstalledPluginVersion(id) === null) continue; // not installed here
    const entry = lock?.groups[g.name];
    if (entry?.sourcePluginVersion === undefined) continue;       // no entry to refresh → normal capture handles it (no stuck nudge)
    if (plugins.isDesktopOnly(id) !== (entry.desktopOnly === true)) n++;
  }
  return n;
}
```

Counts installed plugin groups whose local desktop-only status differs from what
the lock records **and that ② can actually fix** (they have a lock entry). This
keeps the nudge from getting stuck on never-captured plugins.

**State (`src/core/selfPane.ts`).** Add `flagsDrift: boolean` input and
`flagsRefresh: boolean` output. `flagsRefresh = flagsDrift`. Elevate an otherwise
in-sync self to "capture" when flags drift (same slot as `versionRefresh`):

```ts
else if (s === "local-changed" || s === "not-captured" || versionRefresh || flagsRefresh) state = "capture";
```

`adopt`/`both` are unchanged: after the user adopts, the self returns to in-sync
and, if flags still drift, the nudge reappears and one capture resolves it.

**Wiring (`src/main.ts` `selfStatus`).** Compute
`const flagsRefreshCount = desktopOnlyDrift(this.settings.groups, this.pluginHost(), lock);`
pass `flagsDrift: flagsRefreshCount > 0` into `selfPaneState`, and add
`flagsRefresh: decided.flagsRefresh ? flagsRefreshCount : null` to the returned
`SelfSyncInfo`. No new timer: `selfStatus` is recomputed by the existing
`refreshLocalStatus`, which already runs on startup, on config-file changes
(manifest install/update/remove; lock synced from another device), on the manual
↻ "Refresh local state", and on the 5-minute focused periodic tick.

**Surfacing (`src/ui/SyncCenterView.ts`).** Add `flagsRefresh: number | null` to
the `SelfSyncInfo` interface. In `renderSelfContentDetail`, after the
`versionRefresh` branch and when `contentChanged` is false, render a plain line
when `flagsRefresh` is set:

```
{n} desktop-only plugin{s} not recorded in the store yet — capturing lets your
phones skip installs that can't run there.
```

This lives on the existing config-sync self pane (sidebar ⚙ Config Sync entry,
with its existing "to capture" badge). No new UI element, no new panel concept.

## Data flow

Desktop: manifest → ① pill immediately; capture → ② writes flags to lock →
remotely-save syncs the lock → mobile reads the flags → Desktop-only section works.
Y detects lock-vs-manifest drift on every `refreshLocalStatus` and nudges a capture
until ② has aligned them; once aligned, the nudge is silent and permanent.

## Testing

- **`tests/availability.test.ts`** — ①: installed + manifest desktop-only + lock
  has no flag → `desktopOnly: true`; not installed + lock flag true → `true`;
  app-anchored → `false`. `desktopOnlyDrift`: installed desktop-only plugin with a
  lock entry lacking the flag → count 1; flag already true → 0; not-installed → 0;
  no lock entry → 0; a normal (non-desktop-only) plugin with no flag → 0.
- **`tests/core.test.ts`** — ②: seed a lock with plugin entries (some carried
  forward, unselected), one installed plugin desktop-only, one not; capture an
  unrelated group → the desktop-only plugin's carried-forward entry gains
  `desktopOnly: true`, the non-desktop-only one has it absent/cleared, a
  not-installed group's entry is untouched.
- **`tests/selfPane.test.ts`** — Y: `flagsDrift: true` with an otherwise in-sync
  self and null drift → state `capture`, `flagsRefresh: true`; `flagsDrift: false`
  → unchanged; version-refresh and flags-refresh compose (both true → capture).

## Constraints / non-goals

- Gates: `npm test`, `npx eslint .` 0 errors / 67 warnings, no hardcoded colors,
  `npm run build` clean. Live-verify on `dev/vault` (forge a stale-flag lock,
  confirm the self-pane nudge appears, capture, confirm the flags land and the
  nudge clears; confirm an installed desktop-only plugin shows the pill with no
  capture via ①).
- No store schema change (`desktopOnly` key shipped in 1.1.2). No new UI element
  (reuse the self pane). No out-of-band store writes (only capture writes the
  lock — Y nudges a capture rather than writing behind the user's back).
- Does not touch the mobile-overflow fixes (already merged to main) or the
  Desktop-only section/pill rendering (shipped in 1.1.2).
