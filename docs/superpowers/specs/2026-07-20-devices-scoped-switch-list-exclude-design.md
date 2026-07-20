# Device-scoped plugins auto-excluded from the enabled-plugins switch list

## Problem

A plugin whose Config Sync group is set to `devices: "desktop"` (e.g. `vim-toggle`,
`obsidian-vimrc-support`, `obsidian-git`) correctly disappears from the Sync Center on
mobile — `groupsForDevice(manifest, device)` (main.ts:233, :353) hard-excludes its own
`data.json` group.

But the **`community-plugins.json` enabled list is a separate `devices: "all"` group** that
syncs the *whole* enabled-plugin array. The store (captured from desktop) has those plugins
enabled; on mobile they are not enabled, so the diff shows them struck through — a mobile
capture would remove them from the shared list, and the next desktop apply would disable
them on desktop. The mobile-capture footgun, for device-scoped plugins.

The 1.1.6/1.1.7 auto-exclude only covers **author-declared desktop-only** plugins
(`availabilityForGroup(g).desktopOnly` — manifest `isDesktopOnly` or lock flag).
`vim-toggle` is cross-platform (not desktop-only by manifest); the user *manually* scoped it
to desktop via the `devices` field, which the switch-list auto-exclude never consults. Gap.

## Fix

Extend the enabled-plugins switch-list auto-exclude so a plugin is also excepted when its
group's `devices` class **excludes the current device** — symmetric: `devices:"desktop"` on
mobile, `devices:"mobile"` on desktop. In the settings "Excluded from this list" panel these
appear exactly like the existing desktop-only auto-excluded rows (same orange, same
`desktop-only` pill, read-only), distinguished only by ordering group and hover tooltip.

### 1. Core: `deviceExcludedPluginIds` + symmetric `augmentedSwitchExceptions`

New pure helper in `src/core/ConfigSyncCore.ts` (beside `groupsForDevice` / `pluginIdForGroup`):

```ts
// Plugin ids whose group is scoped to a device class that excludes `device`
// (devices:"desktop" on a mobile device, devices:"mobile" on desktop). On a device they
// are scoped away from, they must never be captured out of — or forced into — the shared
// enabled-plugins switch list; they simply do not belong to this device.
export function deviceExcludedPluginIds(groups: SyncGroup[], device: "desktop" | "mobile"): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    if (g.devices === "all" || g.devices === device) continue;
    const id = pluginIdForGroup(g);
    if (id !== null) ids.add(id);
  }
  return ids;
}
```

`augmentedSwitchExceptions(rootPath)` (main.ts:881) restructured so device-scoping applies on
**both** platforms while desktop-only detection stays mobile-only (a desktop-only plugin can
only fail to run on mobile; on desktop it runs and its enable/disable must sync normally):

```ts
private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>> {
  const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
  // Plugins the user scoped away from this device — except on both platforms.
  const extraIds = deviceExcludedPluginIds(this.settings.groups, device);
  // Desktop-only detection is mobile-only: that is where a desktop-only plugin can't run and
  // would otherwise be dropped. On desktop the plugin runs and syncs normally.
  if (Platform.isMobile) {
    const io = this.configIO();
    const lockPath = `${rootPath}/store.lock.json`;
    let lock: StoreLock | null = null;
    if (await io.exists(lockPath)) {
      try {
        lock = parseStoreLock(await io.read(lockPath));
      } catch {
        lock = null;
      }
    }
    for (const id of desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock)) extraIds.add(id);
  }
  if (extraIds.size === 0) return this.settings.switchExceptions;
  const manual = this.settings.switchExceptions["community-plugins"] ?? [];
  return { ...this.settings.switchExceptions, "community-plugins": [...new Set([...manual, ...extraIds])] };
}
```

When the user has no device-scoped groups, `extraIds` is empty on desktop → the method returns
`this.settings.switchExceptions` unchanged (zero behavior change on desktop for existing users).

### 2. `switchListRows`: add `deviceScoped`

`switchListRows` (main.ts:1080) returns one more field so the settings panel can classify and
order rows. `deviceScoped` is computed on both platforms (unlike `desktopOnly`, which stays
mobile-only), gated to the community-plugins list (core plugins have no `plugins/` group, so
`deviceExcludedPluginIds` never names them):

```ts
async switchListRows(groupName: string): Promise<
  { id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean }[]
> {
  ...
  let devScopedIds = new Set<string>();
  if (groupName === "community-plugins") {
    const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    devScopedIds = deviceExcludedPluginIds(this.settings.groups, device);
  }
  ...
  return ids
    .map((id) => ({
      id,
      name: nameOf.get(id) ?? id,
      hint: `${onIn(local, id) ? "on here" : "off here"} · ${store === null ? "no store copy" : onIn(store, id) ? "store has on" : "store has off"}`,
      desktopOnly: dtoIds.has(id),
      deviceScoped: devScopedIds.has(id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
```

The existing name sort stays (stable base order); the settings panel applies the bucket order.
The `SettingsHost.switchListRows` signature in `src/ui/SettingTab.ts:59` gains `deviceScoped: boolean`.

### 3. Ordering + rendering

**Pure ordering helper** in `src/ui/panelModel.ts` (TDD-tested):

```ts
export type SwitchRow = { id: string; name: string; hint: string; desktopOnly: boolean; deviceScoped: boolean };
export type SwitchRowBucket = "desktop-only" | "device-scoped" | "excluded" | "included";
export type OrderedSwitchRow = SwitchRow & { bucket: SwitchRowBucket };

// Bucket precedence: auto-exclusion (desktop-only, then device-scoped) wins over a manual
// exclude, which in turn ranks above plain included plugins. A plugin that is BOTH
// auto-excludable and manually excepted renders as auto (the manual toggle is redundant there).
const BUCKET_ORDER: SwitchRowBucket[] = ["desktop-only", "device-scoped", "excluded", "included"];

export function switchRowBucket(row: SwitchRow, isManual: boolean): SwitchRowBucket {
  if (row.desktopOnly) return "desktop-only";
  if (row.deviceScoped) return "device-scoped";
  if (isManual) return "excluded";
  return "included";
}

export function orderSwitchRows(rows: SwitchRow[], manualIds: Set<string>): OrderedSwitchRow[] {
  return rows
    .map((r) => ({ ...r, bucket: switchRowBucket(r, manualIds.has(r.id)) }))
    .sort(
      (a, b) =>
        BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}
```

Note precedence: an auto-excludable plugin ranks by its auto bucket even if it is also in the
manual exceptions set — matching the existing `if (r.desktopOnly && !isManual)` intent where the
read-only auto row wins. (The current code renders a manually-excepted desktop-only plugin as a
manual row; this spec intentionally unifies it to the auto row — a strict improvement, since a
desktop-only plugin's exclusion is not the user's to toggle.)

**`renderLocalDecisions` (`src/ui/SettingTab.ts:564`)** — four visually separated blocks, all
orange, all `desktop-only` pill; pinned in bucket order; alphabetical within a bucket; a
`margin-top` gap between blocks (no text labels):

- Fetch `rows` once, then render via a local `renderRows()` that re-reads the manual exception
  set, calls `orderSwitchRows(rows, manualIds)`, empties `listEl`, and appends rows. A blank
  `margin-top` gap (`config-sync-ldrow-gsep`) is added to the first row whose `bucket` differs
  from the previous rendered row's bucket.
- `desktop-only` and `device-scoped` buckets both render the existing read-only `is-auto` row:
  `config-sync-doto-pill` (orange), disabled `ToggleComponent(true)`, `auto-excluded` state. They
  differ only in:
  - **pill text**: `row.desktopOnly ? "desktop-only" : \`${boundDevice}-only\``, where
    `boundDevice = Platform.isMobile ? "desktop" : "mobile"`. On mobile both read `desktop-only`
    (as specified); the symmetric desktop `devices:mobile` case reads `mobile-only`.
  - **tooltip**: desktop-only → `"Excluded automatically — this plugin can't run on this device"`;
    device-scoped → `"Excluded automatically — you set this plugin to devices: ${boundDevice}"`.
- `excluded` (manual) and `included` buckets render exactly as today (the `is-local` toggle path),
  now positioned by bucket so a manual exclude sits above the included plugins.
- Toggling a plugin's manual exclude on/off updates the exception set + header badge, then calls
  `renderRows()` — re-sorting the *already-fetched* rows (no refetch, no async, no flash) so the
  row jumps to/from the `excluded` block. This replaces the current in-place `toggleClass` update.

**CSS** in `styles.css` (one rule, no new color): `.config-sync-ldrow-gsep { margin-top: var(--size-4-3); }`.

## Edge cases

- **desktop-only ∧ device-scoped** (a manifest-desktop-only plugin also set `devices:"desktop"`):
  `desktop-only` bucket wins (platform-level fact); tooltip "can't run on this device".
- **auto ∧ manually excepted**: renders as the auto row (bucket precedence above); the manual
  toggle is not shown for it.
- **Symmetric desktop** (`devices:"mobile"` viewed on desktop): excepted, pill `mobile-only`.
  No `desktopOnly` rows ever appear on desktop (`dtoIds` is mobile-only).
- **core-plugins list**: `deviceExcludedPluginIds` only yields `{configDir}/plugins/*` ids, so
  `deviceScoped` is always false there — no behavior change.

## Testing

- **`tests` for `deviceExcludedPluginIds`** (core): groups mixing `devices` all/desktop/mobile +
  an app-anchored group (`pluginIdForGroup` null) → correct id set for device `"mobile"` and
  `"desktop"`; app-anchored and non-excluding groups omitted.
- **`tests/panelModel.test.ts` for `switchRowBucket` / `orderSwitchRows`**: bucket for each
  (desktopOnly, deviceScoped, isManual) combo incl. precedence (desktop-only > device-scoped >
  manual > included; auto beats manual when both); `orderSwitchRows` yields the four blocks in
  order with alphabetical-within-bucket.
- Gates: `npm test`, `npx eslint .` 0 errors / 67 warnings, `./scripts/check-no-hardcoded-color.sh`,
  `npm run build` clean.
- Live (dev vault): forge a `devices:"desktop"` group for a cross-platform plugin, force mobile
  CSS, open the settings exclude list → the plugin renders in the device-scoped block (orange,
  `desktop-only` pill, `auto-excluded`, disabled) and is absent from the `community-plugins.json`
  capture diff (no longer struck through). Confirmed on the user's phone before cut.

## Non-goals

- No new pill color or class — device-scoped reuses the orange `is-auto` / `config-sync-doto-pill`
  treatment; the distinction is ordering group + tooltip only.
- No change to `groupsForDevice`, the item-level device filtering, or capture/apply core logic
  beyond the switch-list exception set.
- No settings-panel legend; the hover tooltip carries the "why".
