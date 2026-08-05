# Batch 2: Sync Center scroll preservation + appearance hot-apply — design

Date: 2026-08-06 · Scope: live-test issues #6, #7 (user-approved: fix these two only, on the
current tree, redeploy to all three vaults, no cut this round) · Status: approved scope

## #6 · Sync Center loses scroll position on every re-render

Root cause: `SyncCenterView.render()` (SyncCenterView.ts:568) empties `contentEl` and
rebuilds; `renderMainRegion()` (:583) empties `mainEl`. Neither preserves scroll. The
scrolling element is `this.contentEl` (Obsidian's `.view-content`); `.config-sync-shell`
and `.config-sync-main` declare no overflow of their own (styles.css:743, :906), so there
is exactly one scroller to restore.

Fix — mirror the SettingTab pattern (SettingTab.ts:434 capture, :470 restore):

- At the top of `render()` and of `renderMainRegion()`, capture
  `const scrollTop = this.contentEl.scrollTop;`
- After the synchronous rebuild completes (end of each method), restore
  `this.contentEl.scrollTop = scrollTop;`
- `render()` already delegates to `renderMainRegion()`; both capture/restore the same
  scroller — the inner restore runs first, the outer one is a no-op with the same value.
  Keep both so each entry point is safe alone.

Tests: none — the suite is DOM-free by design (accepted batch-1 residual: no DOM harness
for view wiring). Live verification per ledger FAIL CRITERION: checking a row deep in a
long list must not move the viewport; also verify disclosure toggles, section select-all,
and policy/menu writes.

## #7 · Appearance apply invisible until app reload → hot-apply

### Verified mechanism (empirical, llm vault via obsidian-cli eval, 2026-08-06)

1. Obsidian does not watch its own config files. The plugin writes via the vault adapter
   (`ctx.io = app.vault.adapter`, main.ts:790), and `app.vault.config` stays stale —
   worse, Obsidian's next internal `saveConfig` clobbers the applied file with stale
   memory (observed live). The reload requirement was masking a real clobber risk.
2. `vault.reloadConfig` is a throttled wrapper; awaiting it guarantees nothing.
   `vault.setupConfig()` is the deterministic loader: rebuilds `config` as a fresh object
   from app.json + appearance.json (deleted keys handled), fires no event, schedules an
   idempotent debounced saveConfig.
3. Firing `vault.trigger("config-changed")` manually does not run the appliers — the
   explicit `app.update*` methods must be called.
4. `customCss.enabledSnippets` is an in-memory `Set` nothing reconciles from config;
   `loadSnippets()` applies from that Set (verified: stale Set → stale render regardless
   of config). `readSnippets()` rescans the snippets folder. Theme/snippet **file
   content** changes are already picked up by customCss's raw-event watcher because our
   writes go through the adapter.
5. Verified working sequence (used to repair llm after the experiment): write files →
   `setupConfig()` → reconcile `enabledSnippets` from config → `readSnippets()` +
   `loadSnippets()` → explicit appliers.

### Design

New host surface on `PluginHost` (same internal-API idiom as `disableCorePlugin`):

```ts
/** Re-reads app.json/appearance.json into memory and re-applies the appearance family
 *  to the running app — the deterministic replacement for "reload the app". */
async reloadAppearance(): Promise<void> {
  const av = this.app.vault as unknown as VaultInternal;      // setupConfig, config
  const cc = (this.app as unknown as AppInternal).customCss;  // snippets/theme surface
  await av.setupConfig();
  cc.enabledSnippets = new Set(av.config.enabledCssSnippets ?? []);
  await cc.readSnippets();
  await cc.loadSnippets();
  cc.setTheme(av.config.cssTheme ?? "");   // theme css; its config save is idempotent post-setupConfig
  const a = this.app as unknown as AppInternal;
  a.updateTheme(); a.updateFontFamily(); a.updateFontSize(); a.updateAccentColor();
}
```

Core wiring (ConfigSyncCore.ts):

- `const APPEARANCE_FAMILY: ReadonlySet<string> = new Set(["appearance", "themes", "snippets", "enabled-css-snippets"])`
  (the appearance card's file group, its two companion dir groups, and the snippet
  switch-list carrier that writes into appearance.json).
- Shared post-pass `hotApplyAppearanceFamily(ctx, results)` called at the end of BOTH
  apply entry points — `apply()` (:523) and `applyWithActions()` (:731):
  - If no family result wrote or deleted files → do nothing.
  - Else `await ctx.plugins.reloadAppearance()` once for the whole run.
    - Success → set `needsAppReload = false` on every family result.
    - Failure → push warn `appearance hot-apply failed — reload the app to see the
      applied appearance: <error message>` onto each family result (status ok→warning)
      and KEEP `needsAppReload = true`. Honest failure; no silent fallback.
- Update the RUNTIME_SWITCH_GROUPS comment (:216-219): enabled-css-snippets is now
  hot-applied via the appearance-family pass, not via per-id runtime switching.

Safety rule (binding, from the verified clobber incident): the hot-apply must run in the
same apply pass, after the family's file writes, before returning — never leave a window
where stale memory can be saved over applied files. `setupConfig()` is itself the fix for
the pre-existing stale-memory clobber risk.

### Tests (DOM-free, fake host records `reloadAppearance` calls)

- Apply run writing an appearance-family file → `reloadAppearance` called exactly once;
  all family results have `needsAppReload === false`.
- Apply run touching no family group → not called; non-family reload flags unchanged.
- `reloadAppearance` throws → family results keep `needsAppReload === true`, carry the
  warn message, status escalated to warning.
- Family group in the run but with zero files written/deleted → not called.

## Out of scope

- #8/#9/#10 (folded into the C-direction rework, separate branch).
- app.json / hotkeys hot-apply (appearance family only; the reload banner remains honest
  for everything else).
- Any release cut.
