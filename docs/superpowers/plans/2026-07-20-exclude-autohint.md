# Surface auto desktop-only exclusions in the settings exclude list — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show desktop-only plugins that are auto-excepted from the enabled-plugins switch list (1.1.6/1.1.7) as read-only "auto-excluded" rows in the settings exclude list, distinct from manual excludes, on mobile.

**Architecture:** `switchListRows` gains a `desktopOnly` flag per row (from `desktopOnlyPluginIds`, mobile-gated). `renderLocalDecisions` renders those as read-only rows (desktop-only pill + disabled toggle). No new persistence.

**Tech Stack:** TypeScript. Files: `src/main.ts`, `src/ui/SettingTab.ts`, `styles.css`, `docs/design/DESIGN.md`.

## Global Constraints

- Mobile + `community-plugins` only (desktop / core-plugins → `desktopOnly: false`, section unchanged). Read-only auto rows; the manual toggle and the `N excluded` badge (manual count) are unchanged.
- No hardcoded colors (`./scripts/check-no-hardcoded-color.sh`); reuse `--color-orange` and the existing `.config-sync-doto-pill`.
- Gates: `npm test`, `npx eslint .` 0 errors / 67 warnings, color check OK, `npm run build` clean.
- The logic (`desktopOnlyPluginIds`) is already unit-tested; these tasks are connector/UI, verified by tsc/build/live.

---

### Task 1: `switchListRows` carries a `desktopOnly` flag

**Files:**
- Modify: `src/main.ts` (`switchListRows`, ~line 1080-1106)
- Modify: `src/ui/SettingTab.ts` (host interface, line 59)

**Interfaces:**
- Consumes: `desktopOnlyPluginIds(groups, plugins, lock)`, `parseStoreLock`, `StoreLock`, `Platform` — all already imported in `main.ts`.
- Produces: `switchListRows(group): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean }[]>`.

- [ ] **Step 1: Update the host interface.** In `src/ui/SettingTab.ts` line 59, change:
```ts
  switchListRows(group: string): Promise<{ id: string; name: string; hint: string }[]>;
```
to:
```ts
  switchListRows(group: string): Promise<{ id: string; name: string; hint: string; desktopOnly: boolean }[]>;
```

- [ ] **Step 2: Compute the auto-except set in `switchListRows`.** In `src/main.ts`, change the method's return-type annotation on the signature line from `{ id: string; name: string; hint: string }[]` to `{ id: string; name: string; hint: string; desktopOnly: boolean }[]`. Then, immediately after the line `const root = await this.resolvedRootPath();`, add:
```ts
    let dtoIds = new Set<string>();
    if (Platform.isMobile && groupName === "community-plugins") {
      const lockPath = `${root}/store.lock.json`;
      let lock: StoreLock | null = null;
      if (await io.exists(lockPath)) {
        try {
          lock = parseStoreLock(await io.read(lockPath));
        } catch {
          lock = null;
        }
      }
      dtoIds = desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock);
    }
```
(`io` is `this.app.vault.adapter`, already declared at the top of the method.)

- [ ] **Step 3: Add the flag to each row.** In the `.map((id) => ({ ... }))` of the return, add `desktopOnly: dtoIds.has(id),` as a property (after `hint`):
```ts
      .map((id) => ({
        id,
        name: nameOf.get(id) ?? id,
        hint: `${onIn(local, id) ? "on here" : "off here"} · ${store === null ? "no store copy" : onIn(store, id) ? "store has on" : "store has off"}`,
        desktopOnly: dtoIds.has(id),
      }))
```

- [ ] **Step 4: Verify.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` (clean) and `cd ~/local/coding/open/obsidian-config-sync && npm test` (still green — no test touches this signature besides types). Confirm `Platform`, `StoreLock`, `parseStoreLock`, `desktopOnlyPluginIds` are already imported in `main.ts`; if tsc reports one missing, add it to the existing import.

- [ ] **Step 5: Commit.**
```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/main.ts src/ui/SettingTab.ts && git commit -m "feat: switchListRows flags desktop-only plugins on mobile"
```

---

### Task 2: Render read-only auto rows + styling

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderLocalDecisions`, the `for (const r of rows)` loop ~line 574-598)
- Modify: `styles.css` (`.config-sync-ldrow.is-local` block ~line 1047-1055)
- Modify: `docs/design/DESIGN.md` (local-decisions note)

**Interfaces:**
- Consumes: `r.desktopOnly` (Task 1). `ToggleComponent` is already imported in `SettingTab.ts`.

- [ ] **Step 1: Add the auto-row branch.** In `renderLocalDecisions`, replace the entire `for (const r of rows) { ... }` loop body with (the manual/included path is unchanged; the `isAuto` branch is prepended):
```ts
      for (const r of rows) {
        const isManual = exceptions.has(r.id);
        if (r.desktopOnly && !isManual) {
          const rowEl = listEl.createDiv({ cls: "config-sync-ldrow is-auto" });
          rowEl.setAttribute("title", "Excluded automatically — this plugin can't run on this device");
          rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
          rowEl.createSpan({ cls: "config-sync-doto-pill", text: "desktop-only" });
          rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
          rowEl.createDiv({ cls: "config-sync-rule-spacer" });
          rowEl.createSpan({ cls: "config-sync-ldstate", text: "auto-excluded" });
          new ToggleComponent(rowEl).setValue(true).setDisabled(true);
          continue;
        }
        const isLocal = isManual;
        const rowEl = listEl.createDiv({ cls: `config-sync-ldrow${isLocal ? " is-local" : ""}` });
        rowEl.createSpan({ cls: "config-sync-ldname", text: r.name });
        rowEl.createSpan({ cls: "config-sync-ldhint", text: r.hint });
        rowEl.createDiv({ cls: "config-sync-rule-spacer" });
        const stateEl = rowEl.createSpan({ cls: "config-sync-ldstate", text: isLocal ? "excluded" : "included" });
        new ToggleComponent(rowEl).setValue(isLocal).onChange(async (v) => {
          const cur = new Set(this.host.settings.switchExceptions[group.name] ?? []);
          if (v) cur.add(r.id);
          else cur.delete(r.id);
          this.host.settings.switchExceptions[group.name] = [...cur].sort();
          await this.host.saveSettings();
          rowEl.toggleClass("is-local", v);
          stateEl.setText(v ? "excluded" : "included");
          const badge = wrap.querySelector<HTMLElement>(".config-sync-exbadge");
          if (badge !== null) {
            badge.setText(`${cur.size} excluded`);
            if (cur.size > 0) badge.show();
            else badge.hide();
          }
        });
      }
```

- [ ] **Step 2: Style the auto row.** In `styles.css`, replace the two `.is-local` rules:
```css
.config-sync-ldrow.is-local {
  border-color: rgba(var(--color-orange-rgb), 0.4);
  background: rgba(var(--color-orange-rgb), 0.05);
}
```
and
```css
.config-sync-ldrow.is-local .config-sync-ldstate { color: var(--color-orange); }
```
with the shared-selector versions:
```css
.config-sync-ldrow.is-local,
.config-sync-ldrow.is-auto {
  border-color: rgba(var(--color-orange-rgb), 0.4);
  background: rgba(var(--color-orange-rgb), 0.05);
}
```
and
```css
.config-sync-ldrow.is-local .config-sync-ldstate,
.config-sync-ldrow.is-auto .config-sync-ldstate { color: var(--color-orange); }
```
(`.config-sync-doto-pill` already exists; no new color. The disabled toggle uses Obsidian's default grey — no custom CSS.)

- [ ] **Step 3: DESIGN.md note.** In `docs/design/DESIGN.md`, find the "Local decisions `-ldrow` family (switch-list exceptions)" line and append a clause noting the read-only auto row: `— plus read-only ``is-auto`` rows (``-doto-pill`` + disabled toggle) surfacing desktop-only plugins auto-excepted on mobile`.

- [ ] **Step 4: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` (clean), `npm test` (green), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK), `npm run build` (clean).

- [ ] **Step 5: Commit.**
```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/SettingTab.ts styles.css docs/design/DESIGN.md && git commit -m "feat: show auto desktop-only exclusions as read-only rows in the settings exclude list"
```

---

### Task 3: Live verification (dev vault, forced mobile)

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`; reload the plugin.
- [ ] **Step 2: Forge.** Force `body.is-mobile` / verify `Platform.isMobile` behavior; forge the dev-vault store lock so an installed plugin (e.g. `plugin-media-extended`) has `desktopOnly: true`; ensure that plugin id is present in the community-plugins list. (Note: `switchListRows` gates on `Platform.isMobile`, which `document.body.classList` does not change; if it can't be forced via eval, verify the data path by calling `p.switchListRows("community-plugins")` and asserting the `desktopOnly` flag, plus inspect the rendered rows' classes.)
- [ ] **Step 3: Verify.** Open Config Sync settings → Enabled community plugins → confirm the desktop-only plugin renders as a `config-sync-ldrow.is-auto` row with a `.config-sync-doto-pill`, "auto-excluded" state, and a disabled toggle; a manually-excluded plugin still shows its editable toggle; the `N excluded` badge is unchanged. Screenshot. Restore forged state.

---

## Self-Review

**Spec coverage:** `desktopOnly` flag (mobile-gated) → Task 1; read-only auto row (pill + disabled toggle + "auto-excluded", manual/included unchanged, badge unchanged) → Task 2 Step 1; shared orange styling → Task 2 Step 2; DESIGN.md → Task 2 Step 3; live → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full before/after. Task 3's `Platform.isMobile` caveat is a concrete fallback (verify the data path directly), not a gap. ✓

**Type consistency:** `switchListRows` return type gains `desktopOnly: boolean` in both the impl (Task 1 Step 2) and the interface (Task 1 Step 1); consumed as `r.desktopOnly` (Task 2 Step 1). `isManual`/`isAuto`/`isLocal` locals consistent within the loop. ✓
