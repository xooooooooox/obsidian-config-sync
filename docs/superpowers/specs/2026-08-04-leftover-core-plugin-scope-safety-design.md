# ① Leftover safety for disabled core plugins — design

> Part 1 of 3 for one release. Siblings: ② on/off both-ways consistency, ③ on/off
> visual reorder. All three implement, deploy to main/kickstart/llm for live test,
> then cut **once**. See Global Constraints.

## Problem

On a freshly set-up ("bootstrap") device, the Sync Center's **Leftover** tab lists a
core plugin's config file for every core plugin that is disabled/unconfigured on
this device — `backlink.json`, `canvas.json`, `command-palette.json`,
`daily-notes.json`, `page-preview.json`, `types.json`, `workspaces.json`,
`zk-prefixer.json` — under the label *"Settings Config Sync saved for items you no
longer sync. Safe to delete."*

These are **not** abandoned. They are the live, synced configs of core plugins that
are simply **off on this device** but enabled on the user's other devices. The
"Safe to delete" affordance (per-row Delete + Delete all) purges them from the
shared store for **every** device — a data-loss footgun.

## Root cause

`buildItemDefs` (`src/core/registry.ts:157`) nulls a known core plugin's settings
path when its file is absent locally:

```ts
settingsFile: { defaultPath: c.fileExists ? `{configDir}/${corePluginFile(c.id)}` : null }
```

`fileExists` is `io.exists(.obsidian/<corePluginFile>)` (`src/main.ts:298`). With
`defaultPath: null`, `compileSingleFile` (`registry.ts:255`) returns no group, so
`groupForStoreRel` cannot attribute the store's copy → `leftoverStoreRels`
(`src/core/leftover.ts:49`) classifies it as deletable leftover. The plugin's file
path is fully knowable from its id (`corePluginFile(c.id)`) — the guard, not the
information, is the problem. Community plugins never hit this: their data.json path
synthesizes from the id (`registry.ts:167`, `defsForForeignItems:182`), so an absent
file stays attributed.

## The change

Give a **locally-known** core plugin its synthesized settings path even when the
file is absent — drop the `fileExists ? … : null` guard so `defaultPath` is always
`{configDir}/${corePluginFile(c.id)}` for known cores. Nothing else is special-cased:
the core settings file then flows through the **one shared** `compileSingleFile`
(`registry.ts:253`) that every Obsidian card and every community/beta plugin file
already uses.

Resulting behavior for a disabled-but-known core plugin whose store holds settings:

- **Attribution:** `compileSingleFile` emits its group (when the item is selected) →
  `groupForStoreRel` attributes the store file → **no longer leftover**.
- **Status:** store-has / local-absent → a normal **To apply** core item (mirrors a
  community "not-installed" item). It keeps the disabled-section enable ladder, so
  Apply can write the config and/or enable the plugin.
- **Capture:** local file absent → `captureGroup` (`src/core/ConfigSyncCore.ts:382`)
  returns an error *"nothing to capture yet"* and **preserves** the store copy. No
  capture-direction footgun. This is the same guard community not-installed items
  rely on.
- **Leftover tab:** reverts to its true meaning — only files whose **item is not in
  your sync selection** (genuinely removed). "Safe to delete" is then accurate.

## Scope handling (core == community, parity — not axis-binding)

Because the fix routes core through the shared compiler and the shared device gate,
core inherits community's scope machinery verbatim; no parallel core-only logic.

- **Shared compiler:** `compileSingleFile` sets `group.devices` from the file's own
  device rule (`registry.ts:270`, `group.devices = fileRule.scope`), default `"all"`
  — identical for core and community.
- **Shared device gate:** `groupsForDevice` (`ConfigSyncCore.ts:132`) drops any group
  scoped to a class that excludes this device. A core plugin whose **settings file**
  is scoped to another device is therefore **neither leftover nor To apply here** —
  it "simply do[es] not belong to this device" (`:138`). Same gate community uses.

Two **independent** scope axes, unchanged and identical for both plugin kinds:

1. **Enablement scope** (the on/off scope-cycle: all/desktop/mobile/this-device) —
   masks `core-plugins.json` / `community-plugins.json` membership via
   `enablementScopes` (`registry.ts:318`, already handles `core:` and `community:`).
   Core already supports this today; ② only polishes its view.
2. **Settings-file sync scope** (the file's device rule → `group.devices`) — where the
   config syncs. ① gives core's settings file this axis, same as community.

① achieves **parity** and does **not** merge the two axes (community doesn't either):
a plugin may be enabled-on-mobile-only yet still sync its settings everywhere, or vice
versa. Linking the axes ("scope the plugin ⇒ scope its settings") is a separate,
cross-cutting change that would also alter community behavior — explicitly out of ①.

## Non-goals

- **Axis-binding** (settings scope following enablement scope). Separate decision,
  touches community.
- **Foreign core ids** — core plugins present in the store but not in this device's
  runtime (`env.cores`). `corePluginFile` can't reliably reverse a filename for an
  unknown core across Obsidian versions; those store files remain leftover. Rare;
  out of scope this round. (The `defsForForeignItems` comment at `registry.ts:175`
  documents this boundary — ① narrows it to locally-known cores, which is the
  observed case.)
- **Folding/summarizing** the resulting To-apply core rows. They are legitimate,
  actionable items that clear on first Apply, consistent with community not-installed.
  Revisit only if it feels crowded after live test.

## Testing

Pure-function / registry-level tests (no DOM), matching the repo's existing strategy:

- `buildItemDefs`: a known core with `fileExists: false` now yields
  `settingsFile.defaultPath === "{configDir}/<corePluginFile>"` (not null).
- `compileSingleFile` / `compileItems`: a selected file-absent known core emits a
  `SyncGroup` at that path with `devices` from its file rule (default `"all"`).
- `leftoverStoreRels`: with that group present, the store rel
  `store/configdir/<file>.json` is **no longer** returned as leftover; an unselected
  core's store file **still is**.
- `groupsForDevice`: a core settings group scoped `mobile` is dropped on a `desktop`
  device (neither leftover nor apply).
- Capture safety is already covered by existing `captureGroup` local-absent behavior;
  add a regression assertion only if a gap surfaces during the plan.

## Global Constraints

- **Privacy in artifacts:** `~`/`$HOME`/`$USER`, `<vault>`/`<host>` placeholders; never
  embed secrets. Reply to the user in Chinese; code/comments/identifiers/docs English.
- **No commits until the cut.** Changes stay uncommitted (the user's review state).
  The cut is a single explicit step after live test.
- **Test before cut:** implement ①+②+③, deploy the built `main.js`/`manifest.json`/
  `styles.css` to the `main`, `kickstart`, and `llm` vaults' `.obsidian/plugins/
  config-sync/`, live-test, and only then cut **one** version. Cut hand-writes release
  notes; publish is the user's own manual step. No Claude attribution in any commit /
  PR / issue text.
- **UI changes need a mockup 定稿** before spec/implementation (done: this round's
  companion mockups, dark single-theme).
- **Feature invariant:** ① changes attribution/presentation only — persisted writes
  and capture/apply semantics are otherwise unchanged.
