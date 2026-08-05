# On/off apply takes effect at runtime — design

Date: 2026-08-05 · Scope: B of the 2026-08-05 round · Status: approved (brainstorm 定稿)

## Problem

Applying the `core-plugins` / `community-plugins` switch-list groups only writes the
carrier file; the running app is untouched and every non-community-data group is blanket
flagged `needsAppReload` (ConfigSyncCore.ts `emptyResult(group, pluginId === null)`). The
Sync Center reads **runtime** enablement (`app.internalPlugins.plugins[id].enabled`,
`pluginRuntimeEnabled`), so between Apply and a manual app reload the panel keeps showing
the pre-apply divergence — the applied change looks like it never happened (2026-08-05
llm confusion: "Disabled on this device · 10" after a successful apply).

The per-item ⏻ Enable policy already does runtime switching correctly (`enableForGroup`:
`p.enable()` for core, `enablePluginPersistent` for community) — the mechanism exists;
the switch-list apply just doesn't use it. Obsidian's own Options toggles switch both
kinds at runtime without a reload.

## Design

After a switch-list group's apply writes the carrier file, apply the delta at runtime:

- Compute on/off deltas the same way `switchDeltaMessages` already does (before-list vs
  final-list of enabled ids).
- **Core** (`core-plugins`): per id, `internalPlugins.plugins[id].enable()` / `.disable()`.
  `PluginHost` gains `disableCorePlugin(id)` beside the existing `enableCorePlugin`.
- **Community** (`community-plugins`): per id, the non-persistent `enablePlugin(id)` /
  `disablePlugin(id)` (the carrier file is already written; the AndSave variants would
  rewrite it).
- Ordering: file write first, runtime switch after — same reasoning as `StatePrelude.finish`
  (an enabling plugin reads its data.json on load; the applied settings must already be on
  disk).
- These two groups stop setting `needsAppReload`. All other configdir groups (app.json,
  appearance.json, hotkeys…) keep the reload banner — they genuinely need it.

### Guards

- **Self-protection**: never runtime-disable `config-sync` itself mid-apply. If the delta
  says to turn it off, write the file but skip the runtime call and add a warn message
  ("config-sync stays running until reload").
- **Per-id error isolation**: a failed enable/disable records a warn message on the group
  result (same error voice as `enableForGroup`: "Obsidian did not enable …") and continues
  with the remaining ids — one stubborn plugin must not abort the rest.
- Unknown core id in this Obsidian build: skip with a warn (same message
  `enableCorePlugin` throws today).

## Tests

Core-layer tests with the fake `ctx.plugins`: applying a switch-list group with a mixed
delta calls enable for added ids and disable for removed ids in the carrier's kind;
`needsAppReload` false for both switch-list groups, unchanged (true) for an obsidian
config group; config-sync id is skipped with a warn; a throwing enable produces a warn
message and the other ids still switch.

## Out of scope

- Runtime application of other configdir files (appearance, hotkeys) — reload banner
  remains the honest answer there.
- Snippet enablement (`enabled-css-snippets`) — Obsidian re-reads appearance.json on
  reload; unchanged this round.
