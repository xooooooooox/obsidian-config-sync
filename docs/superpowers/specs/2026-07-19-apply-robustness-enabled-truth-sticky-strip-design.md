# Batch-apply resilience, enabled-state truth, sticky result strip (0.35.0)

Three findings from a real main.vault cold-start session (2026-07-19), after 0.34.0 fixed
the self-apply reload. All three surfaced from the same bulk "install & enable 72 plugins"
run. One branch, order ②→①→③.

## ② Batch apply aborts silently on the first per-item throw

**Symptom.** A bulk apply of 72 not-installed plugins stopped after ~27; the button returned
to idle "Apply 45 items" with the remaining 45 still selected and **no error shown**.

**Diagnosis.** Selection surviving (sessionStaging intact) rules out a plugin/module reload —
so the apply loop itself ended early. `applyWithActions` (`ConfigSyncCore.ts:513-569`) wraps the
**entire** item loop in a single `try { for (…) } finally`. Only `runStateAction` and
`prelude.finish()` carry internal catches; `requireGroup`, `ctx.io.exists`, `applyGroup`, and a
target plugin's `disablePlugin`/`enablePlugin` can all throw. Any such throw aborts the whole
remaining batch and surfaces nothing — same class of gap as the 0.28.0 install-hang, which
added per-install timeout/retry; this adds per-item throw isolation.

**Fix.** Wrap each item's body in `try/catch`. On throw, push an error `GroupResult` and
continue:

```ts
for (const item of items) {
  onProgress?.(done, items.length, item.name);
  try {
    const group = requireGroup(manifest, item.name);
    // … existing per-item body (unchanged) …
    results.push(r);            // (existing push sites stay inside the try)
  } catch (err) {
    const r = emptyResult(item.name, false);
    r.status = "error";
    r.messages.push(err instanceof Error ? err.message : String(err));
    results.push(r);
  }
  done++;
}
```

A single bad plugin now becomes one `✗` row in the report; the rest of the batch still runs.
The existing `finally` (writing the backup index) is unchanged.

## ① A running plugin is misclassified "Disabled on this device"

**Symptom.** IOTO Tasks Center is enabled (toggle on, ribbon icons present, version reads
2.1.9) yet sits under "Disabled on this device".

**Diagnosis (reproduced live).** config-sync's enabled check reads **only** the persisted set:

```
main.ts:614,631   isPluginEnabled: (id) => registry.enabledPlugins.has(id)
availability.ts:47  … : plugins.isPluginEnabled(pluginId) ? "enabled" : "disabled"
```

`app.plugins.enabledPlugins` is the persisted community-plugins.json list; whether a plugin is
**loaded/running** is tracked separately in `app.plugins.plugins`. The two can diverge — a
non-persistent `enablePlugin(id)` (which config-sync and the IOTO ecosystem both use) loads the
plugin **without** adding it to `enabledPlugins`. Verified in a dev vault:

| step | `enabledPlugins.has` | loaded |
|---|---|---|
| `disablePluginAndSave` | false | false |
| `enablePlugin` (non-persistent) | **false** | **true** ← divergence |

Obsidian's own community-plugins toggle reflects the **loaded** state, which is why the plugin
looks on while config-sync calls it disabled.

**Fix.** Treat a plugin as enabled when it is loaded **or** persisted-enabled — covering both
divergence directions (loaded-not-persisted = IOTO Tasks Center; persisted-not-loaded = a
plugin that failed to load but the user intends on).

- Add the loaded map to the registry interface (`main.ts:79`):
  `plugins: Record<string, unknown>;`
- One private helper, used by `pluginRuntime`, `pkmProbe`, and `pluginHost`:
  ```ts
  private isPluginOn(id: string): boolean {
    const reg = this.pluginRegistry();
    return reg.enabledPlugins.has(id) || reg.plugins[id] !== undefined;
  }
  ```
  Replace the three `enabledPlugins.has(id)` closures with `this.isPluginOn(id)`.

**Scope note.** The persistence gap itself (community-plugins.json missing a running plugin)
already surfaces separately through the "Enabled community plugins" switch-list group, which
compares the persisted file against the store — this change does not touch that path. It only
fixes the per-plugin enabled/disabled bucketing and the enable/cycle decisions in
`ConfigSyncCore` (all of which want runtime truth).

## ③ Result strip invisible when scrolled to the bottom (sticky — 定稿 B)

**Symptom.** After a long bulk apply the user is at the bottom of the list; the result strip
renders at the **top**, out of view. The 0.30.0 run-history design named a
"sticky/auto-scroll variant" and **deferred** it
(`2026-07-18-run-history-design.md:26`), relying on honest tone + auto-expand + the History
entry. The bulk-apply case is exactly what those mitigations don't cover.

**Decision.** Variant **B (sticky strip)**, not A (auto-scroll). A depends on the apply's
completion callback to fire the scroll — but when the apply throws or is interrupted (finding
②), that callback never runs and the result is never brought into view. B is always visible
regardless of run outcome. Mockup approved (`strip-visibility-mockup.html`), including the
critical fidelity fix caught in review: **the sticky container needs an opaque backing** or the
scrolling rows bleed through the strip's semantic-tint (translucent) background.

**Feasibility (confirmed).** Scroll container is `contentEl` (`.config-sync-center` =
Obsidian's `.view-content`). Between the strip and `contentEl`, `.config-sync-shell` (grid) and
`.config-sync-main` (flex column) set no `overflow`, so `position: sticky; top: 0` pins to the
scroll viewport, constrained within the tall `.config-sync-main` box.

**Fix.**
- `renderResultStrip` (`SyncCenterView.ts:657`) wraps the strip in a dock:
  `const dock = main.createDiv({ cls: "config-sync-strip-dock" });` then build the strip inside
  `dock` instead of `main`. Early-return when `lastRun === null` stays — the dock is created
  only when a strip exists (no empty dock, no `:empty` rule needed). Applies to both call sites
  (item mode `:815`, remote mode `:1604`).
- CSS (theme-native, zero hardcoded colors — must pass `check-no-hardcoded-color.sh`):
  ```css
  .config-sync-strip-dock {
    position: sticky; top: 0; z-index: 5;
    background: var(--background-primary);
    padding-bottom: var(--size-4-2);
    border-bottom: 1px solid var(--background-modifier-border);
  }
  ```
  The strip keeps its own styling; its `margin-bottom` is dropped inside the dock (dock
  padding provides the separation). Opaque `--background-primary` + the border give the
  separator without a hardcoded shadow color.

## Testing

- **core** (`tests/core.test.ts`): a batch where one item's `applyGroup` throws → that item is
  an `error` result carrying the message, and **later items still run** (the pre-throw and
  post-throw items both appear in results). Guards the ② isolation.
- **availability** (`tests/*`): a plugin that is loaded but not in `enabledPlugins` classifies
  `enabled` (not `disabled`); a plugin in `enabledPlugins` but not loaded also classifies
  `enabled`; neither → `not-installed`/`disabled` as before. Drive through a fake registry
  exposing `plugins` + `enabledPlugins`.
- **Live dev-vault**: force a throwing item mid-batch → report shows the ✗ row + subsequent
  installs; put a plugin in the loaded-not-persisted state (`enablePlugin`) → it leaves the
  "Disabled on this device" section; sticky strip stays pinned while scrolling a long list, in
  both light and dark, with rows not bleeding through.
- **Gates**: `npm test`, lint 67-warning baseline, `check-no-hardcoded-color.sh`.
