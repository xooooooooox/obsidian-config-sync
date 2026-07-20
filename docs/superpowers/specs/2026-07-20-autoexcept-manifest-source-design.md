# Fix: auto-except source must match the Desktop-only section (manifest + lock)

## Bug (1.1.6)

`desktopOnlyPluginIds(lock)` derives the auto-excepted ids from the **store lock's
`desktopOnly` flags only**. But the Desktop-only section derives "is this plugin
desktop-only" from `availabilityForGroup(...).desktopOnly`, which is **manifest-
first, lock-fallback** (`localVersion !== null ? plugins.isDesktopOnly(id) : lock
flag`). The two sources disagree, so a plugin can be **in the Desktop-only section
yet not auto-excepted**.

Real-vault repro (phone on 1.1.6): `quick-explorer` is installed-but-disabled on
the phone (its files synced by remotely-save), so the section recognizes it as
desktop-only via its **manifest** — but its **lock flag isn't set**, so the
lock-only `desktopOnlyPluginIds` misses it and `community-plugins.json` still shows
it struck through (to-capture removal). The feature is half-broken for exactly the
installed-but-disabled case the 1.1.4 section fix was built for.

## Fix — one source of truth

Derive the auto-except ids from the same `availabilityForGroup(...).desktopOnly`
the section uses, so anything in the Desktop-only section is guaranteed excepted.

`src/core/availability.ts`:

```ts
// Plugin ids config-sync treats as desktop-only on THIS device — the same manifest-first,
// lock-fallback signal the Desktop-only section uses, so the auto-except set and the section
// never disagree. Used to auto-except them from the enabled-plugins switch list on mobile.
export function desktopOnlyPluginIds(groups: SyncGroup[], plugins: PluginHost, lock: StoreLock | null): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    const id = pluginIdForGroup(g);
    if (id === null) continue; // app-anchored
    if (availabilityForGroup(g, plugins, lock).desktopOnly) ids.add(id);
  }
  return ids;
}
```

Caller (`src/main.ts` `augmentedSwitchExceptions`) passes the sync list and the
plugin host: `desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock)`.
`SyncGroup`, `PluginHost`, `pluginIdForGroup`, `availabilityForGroup` are all
already in `availability.ts`.

The mobile gate (1.1.6) is unchanged: `augmentedSwitchExceptions` still returns the
plain settings on desktop, so this only runs on mobile.

## What this fixes and what it doesn't

- **Fixes** installed-but-disabled desktop-only plugins on mobile (e.g.
  `quick-explorer`): the manifest source now catches them, matching the section.
- **Does NOT fix** a desktop-only plugin that is *neither installed on the phone nor
  flagged in the lock* (e.g. `vim-im-select`/`vim-yank-highlight` in the same repro):
  config-sync genuinely can't tell it's desktop-only there. That is a separate
  **lock-flag coverage** matter — the flag must be backfilled by a desktop capture
  (1.1.3 mechanism). Out of scope here; the user re-captures on desktop to populate
  those flags, which then sync to the phone. Noted, not addressed by this change.

## Testing

- **`tests/availability.test.ts`** — rewrite the existing `desktopOnlyPluginIds`
  tests for the new signature. Use `FakePlugins` (already in the test util):
  - installed + manifest desktop-only (`p.installed.set` + `p.desktopOnlyIds.add`),
    lock has no flag → the id is collected (the bug case).
  - not installed + lock flag true → collected (mobile fallback).
  - not installed + no lock flag → not collected.
  - app-anchored group → not collected.
- Gates: `npm test`, `npx eslint .` 0/67, no hardcoded color, `npm run build` clean.
- Live (dev vault): on desktop `augmentedSwitchExceptions` still short-circuits
  (mobile gate) — verify no desktop change; the mobile behavior is covered by the
  unit test since the manifest path is what changed.

## Non-goals

No change to the mobile gate, the switch-list merge, or the Settings UI. This is a
source-of-truth alignment for `desktopOnlyPluginIds`.
