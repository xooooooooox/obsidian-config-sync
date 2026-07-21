# Scoped-away snippet rows stay re-scopable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a device where a CSS snippet is scoped away (e.g. `Mobile only` viewed on desktop), keep its "Active on" dropdown editable so the scope can be changed from any device, instead of locking the row.

**Architecture:** One change to `renderRows` inside `renderLocalDecisions` (`src/ui/SettingTab.ts`): extract the inline "Active on" dropdown into a local `renderScopeDropdown` helper, then render it (enabled) on scoped-away **snippet** rows by splitting the inert `is-auto` block. Drop the redundant `auto-excluded` label + disabled toggle from that row (定稿 变体 2). Desktop-only and device-scoped *plugin* rows stay inert.

**Tech Stack:** TypeScript, Obsidian API (`DropdownComponent`), CSS.

## Global Constraints

- Change is gated to `isSnippetGroup && r.bucket === "device-scoped"` — desktop-only rows and non-snippet device-scoped rows keep the inert rendering (disabled toggle + `auto-excluded`).
- The re-scopable row = name + `${boundDevice}-only` pill + `ldhint` + spacer + editable "Active on" dropdown. No `auto-excluded` label, no toggle (定稿 变体 2).
- The dropdown reuses the existing `config-sync-ld-scope` / `is-scoped` classes and the `setSnippetScope → saveSettings → updateScopeBadge → reload` path — no change to scope storage, bucketing, force-off, or the Sync Center.
- Not-unit-testable DOM wiring: no new unit test; verify live. Existing suite stays green.
- Gates: `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (unchanged), `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No Claude/AI attribution in commit messages.

---

### Task 1: Editable scoped-away snippet rows

**Files:**
- Modify: `src/ui/SettingTab.ts` — `renderRows` inside `renderLocalDecisions` (helper insertion ~after `:635`; normal-branch dropdown `:686-702`; is-auto block `:642-661`).

**Interfaces:**
- Consumes: existing closure bindings `this.host`, `updateScopeBadge`, `reload`, `boundDevice`, `isSnippetGroup`, and the imported `DropdownComponent`, `setSnippetScope`, `ToggleComponent`, `SwitchRow`, `OrderedSwitchRow` (all already in this file).
- Produces: a local `renderScopeDropdown(rowEl: HTMLElement, r: SwitchRow, disabled: boolean): void`.

- [ ] **Step 1: Add the `renderScopeDropdown` helper.** Insert it inside `renderRows`, immediately after the `updateScopeBadge` closure (i.e. after the block ending at `:635`, before `const exceptions = ...` at `:636`):

```ts
      // The shared "Active on" scope dropdown — rendered on normal snippet rows and on
      // scoped-away snippet rows, so a snippet's scope stays editable from any device.
      const renderScopeDropdown = (rowEl: HTMLElement, r: SwitchRow, disabled: boolean): void => {
        const scopeNow = this.host.settings.snippetScopes[r.id] ?? "all";
        const scopeDd = new DropdownComponent(rowEl)
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
        scopeDd.selectEl.addClass("config-sync-ld-scope");
        scopeDd.selectEl.toggleClass("is-scoped", scopeNow !== "all");
      };
```

(`reload` is a `const` declared later in the method at `:709`; this helper only reads it inside the async `onChange`, which runs after initial render — identical timing to the current inline code at `:699`.)

- [ ] **Step 2: Replace the normal-branch inline dropdown with a call to the helper.** Replace the block at `:686-702`:

```ts
          const scopeNow = this.host.settings.snippetScopes[r.id] ?? "all";
          // A pin makes this device user-controlled (pin > scope), so the shared scope doesn't
          // apply here — grey the dropdown while pinned.
          const scopeDd = new DropdownComponent(rowEl)
            .addOption("all", "All devices")
            .addOption("desktop", "Desktop only")
            .addOption("mobile", "Mobile only")
            .setValue(scopeNow)
            .setDisabled(isLocal)
            .onChange(async (v) => {
              this.host.settings.snippetScopes = setSnippetScope(this.host.settings.snippetScopes, r.id, v as "all" | "desktop" | "mobile");
              await this.host.saveSettings();
              updateScopeBadge();
              await reload();
            });
          scopeDd.selectEl.addClass("config-sync-ld-scope");
          scopeDd.selectEl.toggleClass("is-scoped", scopeNow !== "all");
```

with:

```ts
          // A pin makes this device user-controlled (pin > scope), so the shared scope doesn't
          // apply here — grey the dropdown while pinned.
          renderScopeDropdown(rowEl, r, isLocal);
```

- [ ] **Step 3: Split the `is-auto` block to render the editable scoped-away snippet row.** Replace the entire block at `:642-661`:

```ts
        if (r.bucket === "desktop-only" || r.bucket === "device-scoped") {
          const rowEl = listEl.createDiv({ cls: `config-sync-ldrow is-auto${gsep ? " config-sync-ldrow-gsep" : ""}` });
          rowEl.setAttribute(
            "title",
            r.bucket === "desktop-only"
              ? "Excluded automatically — this plugin can't run on this device"
              : isSnippetGroup
                ? `Scoped to ${boundDevice} only — not active on this device (change it from a ${boundDevice} device)`
                : `Excluded automatically — you set this plugin to devices: ${boundDevice}`,
          );
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({
            cls: "config-sync-doto-pill",
            text: r.bucket === "desktop-only" ? "desktop-only" : `${boundDevice}-only`,
          });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          rowEl.createSpan({ cls: "config-sync-ldstate", text: "auto-excluded" });
          new ToggleComponent(rowEl).setValue(true).setDisabled(true);
          continue;
        }
```

with:

```ts
        if (r.bucket === "desktop-only" || r.bucket === "device-scoped") {
          // A snippet scoped away from THIS device keeps its scope editable (the scope is
          // shared, user-set metadata) — so it can be un-scoped from any device instead of
          // locking here. Plugin desktop-only / device-scoped rows stay inert.
          const editableScope = isSnippetGroup && r.bucket === "device-scoped";
          const rowEl = listEl.createDiv({ cls: `config-sync-ldrow is-auto${gsep ? " config-sync-ldrow-gsep" : ""}` });
          rowEl.setAttribute(
            "title",
            editableScope
              ? `Scoped to ${boundDevice} only — not active on this device`
              : r.bucket === "desktop-only"
                ? "Excluded automatically — this plugin can't run on this device"
                : `Excluded automatically — you set this plugin to devices: ${boundDevice}`,
          );
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({
            cls: "config-sync-doto-pill",
            text: r.bucket === "desktop-only" ? "desktop-only" : `${boundDevice}-only`,
          });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          if (editableScope) {
            renderScopeDropdown(rowEl, r, false);
          } else {
            rowEl.createSpan({ cls: "config-sync-ldstate", text: "auto-excluded" });
            new ToggleComponent(rowEl).setValue(true).setDisabled(true);
          }
          continue;
        }
```

(Only two behavioral changes: the scoped-away tooltip drops the "(change it from a … device)" dead-end, and the editable branch renders the dropdown instead of `auto-excluded` + disabled toggle. Everything else in the block is byte-identical.)

- [ ] **Step 4: Gates.** Run:

```bash
cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npm test && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build
```

Expected: tsc clean; tests green (unchanged count — DOM change, no new tests); eslint **0 errors / 67 warnings**; color-check OK; build clean.

- [ ] **Step 5: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/SettingTab.ts && git commit -m "feat(ui): scoped-away snippet rows keep an editable Active-on dropdown"
```

---

### Task 2: Live verification (dev vault)

**Files:** none (verification only).

Deploy + drive with `obsidian-cli` (binary `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`; routes by CWD, run from `dev/vault/`; `eval` needs `code=<js>`, wrap top-level `await` in `(async()=>{ ... })()`). Focus Obsidian first (`open -a Obsidian`).

- [ ] **Step 1: Deploy + reload.** `cd ~/local/coding/open/obsidian-config-sync && npm run build && cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`, then from `dev/vault/`: `obsidian-cli eval code="(async()=>{await app.plugins.disablePlugin('config-sync');await app.plugins.enablePlugin('config-sync');return 'reloaded';})()"`.

- [ ] **Step 2: Scoped-away snippet is editable.** Open Settings → the config-sync tab → expand the "Enabled CSS snippets" switch-list drawer. Pick a snippet and set its "Active on" to the *other* device class (on this desktop dev vault, set it to `Mobile only`). Confirm: the row moves into the "Device scope & pins" top group, shows the `mobile-only` pill, and **renders an enabled "Active on" dropdown reading "Mobile only"** — with no `auto-excluded` label and no toggle. Probe via `obsidian-cli eval` from `dev/vault/`:

```js
(async()=>{
  const rows=[...document.querySelectorAll('.config-sync-ldrow.is-auto')];
  const withScope=rows.filter(r=>r.querySelector('.config-sync-ld-scope'));
  const s=withScope.map(r=>({
    name:r.querySelector('.config-sync-ldname')?.textContent,
    pill:r.querySelector('.config-sync-doto-pill')?.textContent,
    ddValue:r.querySelector('.config-sync-ld-scope')?.value,
    ddDisabled:r.querySelector('.config-sync-ld-scope')?.disabled,
    hasAutoExcluded: !!r.querySelector('.config-sync-ldstate'),
    hasToggle: !!r.querySelector('.checkbox-container, input[type=checkbox]'),
  }));
  return JSON.stringify({autoRows:rows.length, editableScopedAway:s});
})()
```

Expected: at least one entry with `pill` = "mobile-only", `ddValue` = "mobile", `ddDisabled: false`, `hasAutoExcluded: false`, `hasToggle: false`.

- [ ] **Step 3: Change it back to All → row leaves the top group.** Set that dropdown back to `All devices` (via the UI, or `obsidian-cli eval` calling the select's change). Confirm the row returns to the normal list (no longer `is-auto`, active on desktop) and the "N device-scoped" header badge decrements.

- [ ] **Step 4: Desktop-only plugin unchanged.** In the community-plugins switch list drawer, confirm a desktop-only plugin row (if present) is still inert — disabled toggle, `auto-excluded`, no dropdown.

- [ ] **Step 5: Mobile layout.** Emulate 390×844 (or check on a real phone): the scoped-away snippet row's dropdown fits without overflow. Screenshot desktop + mobile.

---

## Self-Review

**Spec coverage:**
- Restore editable "Active on" on scoped-away snippet rows (spec Decision / Design 2) → Task 1 Step 3. ✓
- Extract shared `renderScopeDropdown` helper, rewire normal branch (spec Design 1) → Task 1 Steps 1-2. ✓
- Drop `auto-excluded` + toggle (定稿 变体 2) → Task 1 Step 3 editable branch. ✓
- Gated to `isSnippetGroup && device-scoped`; desktop-only + plugin device-scoped stay inert (spec scope) → Task 1 Step 3 `editableScope` guard + else branch; Task 2 Step 4 verifies. ✓
- No new unit test; live verify desktop + mobile (spec Testing) → Task 2. ✓
- Non-goal: pin override not restored → Task 1 renders only the dropdown, no pin, on scoped-away rows. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after; the probe script is complete. ✓

**Type consistency:** `renderScopeDropdown(rowEl: HTMLElement, r: SwitchRow, disabled: boolean): void` defined in Step 1 and called in Step 2 (`isLocal`) and Step 3 (`false`); `r` in the loop is `OrderedSwitchRow` (⊆ `SwitchRow`), so both calls type-check. Reuses `config-sync-ld-scope`/`is-scoped` classes and `setSnippetScope` verbatim from the removed inline block. ✓
