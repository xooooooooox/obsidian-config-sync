# Scoped-away snippet rows stay re-scopable (un-scope from any device)

## Problem

A per-snippet device scope (`snippetScopes`, shared) is set from the "Active on"
dropdown on the snippet's row in the Enabled-CSS-snippets drawer
(`SettingTab.ts` `renderLocalDecisions`). The moment a user picks a scope that
excludes the current device — e.g. `Mobile only` while on desktop — the row
re-buckets to `device-scoped` and renders through the **inert `is-auto`
branch** (`SettingTab.ts:642-661`): a `{boundDevice}-only` pill, an
`auto-excluded` label, and a **disabled toggle** — with **no "Active on"
dropdown**. So the scope can no longer be changed from that device.

This is a **one-click self-lockout**: on desktop, choosing `Mobile only` sends
the row to the top group and strips its only scope control. The sole recovery
today is to change the scope from an in-scope device (the tooltip says "change
it from a mobile device") or to hand-edit `data.json`. The disabled toggle
being off is *correct* (the snippet really is force-off here), but the scope is
shared, user-set metadata that should never become uneditable.

## Decision (定稿)

Restore the editable "Active on" dropdown on scoped-away **snippet** rows
(approach A; layout 定稿 `mockup-snippet-unscope.html` 变体 2). The row keeps
its top-group placement (grouping scoped-away snippets together is fine — owner
decision) and its `{boundDevice}-only` pill, and regains the same
`All / Desktop only / Mobile only` dropdown the normal rows use, showing the
current scope. Changing it to `All` or the current device's class re-buckets
the row back into the normal list on the next render.

Drop the now-redundant `auto-excluded` label and the always-disabled toggle
from this row (变体 2): the pill already communicates "off / excluded here", so
a permanently-disabled toggle is noise. The row becomes **pill + editable
"Active on" dropdown**.

Scope is deliberately narrow — this applies only to
`isSnippetGroup && bucket === "device-scoped"`:

- **Desktop-only plugin rows** (`bucket === "desktop-only"`) stay fully inert —
  a plugin that can't run on this device has no user-changeable scope here.
- **Device-scoped *plugin* rows** (`bucket === "device-scoped"` in the
  plugin/core lists) stay inert too: plugin device scope is set at the sync
  **group** level (`group.devices`, edited elsewhere), not per-item via
  `snippetScopes`, so there is no per-row dropdown to restore for them.

## Design

In `renderLocalDecisions` (`SettingTab.ts`):

1. **Extract the scope dropdown into a local helper** (DRY — it currently lives
   inline in the normal branch at `:686-702`):

   ```ts
   // Renders the shared "Active on" dropdown for a snippet row into rowEl.
   const renderScopeDropdown = (rowEl: HTMLElement, r: SwitchRow, disabled: boolean): void => {
     const scopeNow = this.host.settings.snippetScopes[r.id] ?? "all";
     const dd = new DropdownComponent(rowEl)
       .addOption("all", "All devices")
       .addOption("desktop", "Desktop only")
       .addOption("mobile", "Mobile only")
       .setValue(scopeNow)
       .setDisabled(disabled)
       .onChange(async (v) => {
         this.host.settings.snippetScopes = setSnippetScope(this.host.settings.snippetScopes, r.id, v as "all" | "desktop" | "mobile");
         await this.host.saveSettings();
         updateScopeBadge();
         await reload();
       });
     dd.selectEl.addClass("config-sync-ld-scope");
     dd.selectEl.toggleClass("is-scoped", scopeNow !== "all");
   };
   ```

   The normal branch (`:689-702`) is replaced by `renderScopeDropdown(rowEl, r, isLocal)`
   (unchanged behavior — pinned rows still grey the dropdown).

2. **Editable scoped-away snippet branch.** In the `is-auto` block
   (`:642-661`), split off the re-scopable case. When
   `isSnippetGroup && r.bucket === "device-scoped"`, render:
   `rowEl` (still `config-sync-ldrow is-auto` + optional `-gsep`) → name →
   `{boundDevice}-only` pill (`config-sync-doto-pill`) → `rule-spacer` →
   `renderScopeDropdown(rowEl, r, false)`. **No** `auto-excluded` label, **no**
   toggle. Keep the tooltip informative but drop the "change it from a … device"
   dead-end (it's editable here now) — e.g. "Scoped to {boundDevice} only —
   not active on this device."

   The existing inert rendering (`auto-excluded` + disabled toggle) stays for
   `desktop-only` and for non-snippet `device-scoped` rows.

No change to bucketing (`switchRowBucket`/`orderSwitchRows`), to `snippetScopes`
storage, to force-off/apply, or to the Sync Center. Changing the dropdown fires
the existing `setSnippetScope → saveSettings → reload` path, which re-buckets
the row.

## CSS

Likely none — the row reuses `config-sync-ldrow is-auto`, `config-sync-doto-pill`,
and `config-sync-ld-scope`. Verify the dropdown sits/aligns cleanly in the
`is-auto` row on desktop and 390×844 mobile; add a spacing rule only if needed
(theme vars only, no hardcoded color).

## Testing

- The change is DOM-render wiring; the underlying `setSnippetScope` helper is
  already unit-tested. No new unit test is warranted (an inline dropdown's
  `onChange` isn't meaningfully unit-testable).
- **Live (dev vault, the real verification):**
  - On desktop, set a snippet to `Mobile only` → it moves to the "Device scope
    & pins" top group **with an editable "Active on" dropdown showing "Mobile
    only"** (no `auto-excluded`, no toggle), not the pre-fix locked row.
  - Change that dropdown to `All` → the row leaves the top group and returns to
    the normal list, active again on desktop; the "N device-scoped" header
    badge decrements.
  - Confirm a **desktop-only plugin** row (in the plugin list) is unchanged —
    still inert with a disabled toggle and no dropdown.
  - 390×844 mobile: the dropdown fits the row without overflow.
- Gates: `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (unchanged
  suite), `npx eslint .` **0 errors / 67 warnings**,
  `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- **Pin > scope override from the scoped-away device** (force a mobile-only
  snippet ON on *this specific* desktop) remains out of scope — that was
  approach B, not chosen; it stays a backlog item. This spec restores only the
  scope dropdown, not the pin affordance, on scoped-away rows.
- No change to plugin/core device scoping (`group.devices`), to the top-group
  placement of scoped-away rows, or to any non-snippet switch list.
