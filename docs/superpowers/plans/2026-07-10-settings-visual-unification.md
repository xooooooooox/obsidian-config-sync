# Settings visual unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin submittable to the Obsidian community directory (plugin id rename `obsidian-config-sync` → `config-sync`) and unify the settings panel visuals — full-width search, picker Sync-all as a toggle, Advanced tab as one summary-row + expand-to-edit language, Discovered files as name-less toggle rows.

**Architecture:** Task 1 is a mechanical id rename (manifest + the two hardcoded self-references in core + smoke path). Tasks 2-4 are pure UI layer: `src/ui/SettingTab.ts` + `styles.css`, no settings migration. The lock mechanism (lock icons, `unlocked` set, Lock all/Unlock all) is removed; a UI-transient `expanded` set drives collapse/expand. All existing save/validation/render invariants stay.

**Tech Stack:** TypeScript, Obsidian `Setting`/`ToggleComponent`/`DropdownComponent`/`TextComponent`/`ButtonComponent`/`ExtraButtonComponent`, plugin-owned `styles.css` using Obsidian CSS variables.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-10-settings-visual-unification-design.md`.
- **UI-only (Tasks 2-4):** outside Task 1's two named core edits, `src/core/*` must not change. `listDiscovered`, `defaultGroupForName`, `toggleSection`, `expectedPathForName`, `splitLocation`, `joinLocation` are reused as-is.
- **Render invariants (existing, must survive):** text-field `onChange` never re-renders (focus preservation); structural changes `await this.saveGroups(); this.refresh();`; render-generation guard around awaits in `renderAdvanced`; `display()` resets transient UI state.
- **Lock removal is total:** no lock/unlock icons, no `unlocked` set, no Lock all / Unlock all buttons, no `setDisabled(locked)`. Keep Reset, Reset all, and the `⚙ customized` badge. The `Sanitize` field keeps its semantic disable (`group.type !== "file"`).
- **Discovered toggle semantics:** switching on creates `{ name: d.name, path: d.path, type: "file", devices: "all" }` immediately (no Name input); on save failure roll back with `this.groups.pop()` and set `groupsErrorMsg`; the row leaves Discovered on success (existing `listDiscovered` exclusion).
- **`expanded` keying:** by group name; Add rule adds `""`; custom Name `onChange` re-keys (`delete` old, `add` new).
- **Verification gate per task (all three, before every commit):** `npm test` (103 passing) AND `npm run build` (tsc clean) AND `npm run lint` (**0 errors**; pre-existing warnings are acceptable — the 0.6.0 CI failure was a lint *error* the old test+build gate missed).
- Commit only the files each task lists. Never stage `docs/`, `.superpowers/`, or `dev/`.
- **Submission rules (from docs.obsidian.md/Reference/Manifest and …/Submit+your+plugin):** plugin `id` must contain only lowercase letters and hyphens, must not contain `obsidian`, must not end with `plugin`, and must be unique in the community directory (`config-sync` verified available). `name` must not contain "Obsidian" or "Plugin" ("Config Sync" verified available). Repo root must keep README.md, LICENSE, manifest.json (all present). Release tag must equal the manifest `version` (existing CI flow already complies).

---

### Task 1: Community submission readiness — plugin id rename

The Obsidian directory rejected the submission: the id `obsidian-config-sync` contains `obsidian`, which the manifest guidelines forbid. Rename the id to `config-sync` everywhere it is load-bearing. The GitHub repo name, npm package name, and schema URL keep the old string (they are not governed by the manifest rules).

**Files:**
- Modify: `manifest.json` (id only)
- Modify: `src/core/manifest.ts:12` (`BLACKLISTED_PLUGIN_DIRS`)
- Modify: `src/core/ConfigSyncCore.ts:35` (`backupDir` path)
- Modify: `package.json` (`smoke:install` path)
- Test: `tests/core.test.ts` (2 backup-path assertions), `tests/manifest.test.ts` (self-blacklist coverage)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the new plugin id `config-sync` (dev-vault smoke for later tasks installs under this id).

- [ ] **Step 1: Update the failing test assertions first**

In `tests/core.test.ts`, change both backup-path reads (~lines 163 and 186):

```ts
    const indexData = JSON.parse(await io.read(".obs/plugins/config-sync/backup/index.json")) as {
```

(and identically for the second `index` read at ~186 — both `.obs/plugins/obsidian-config-sync/backup/index.json` → `.obs/plugins/config-sync/backup/index.json`).

In `tests/manifest.test.ts`, extend the existing blacklist test (`it("rejects blacklisted plugin dirs", ...)`) with assertions that BOTH the new and the old self-dir stay blacklisted:

```ts
  it("rejects the plugin's own dir under both old and new ids", () => {
    const neu = { name: "self", path: "{configDir}/plugins/config-sync/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([neu]))).toThrow("blacklisted");
    const old = { name: "self-old", path: "{configDir}/plugins/obsidian-config-sync/data.json", type: "file", devices: "all" };
    expect(() => parseSyncManifest(manifestWith([old]))).toThrow("blacklisted");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the two core.test.ts reads miss (backup still written under the old dir) and the new-id blacklist assertion misses (`config-sync` not yet in the list).

- [ ] **Step 3: Apply the renames**

- `manifest.json`: `"id": "obsidian-config-sync"` → `"id": "config-sync"`. All other fields stay (name "Config Sync", description, minAppVersion 1.5.0, isDesktopOnly false are already compliant).
- `src/core/manifest.ts:12`: keep the old id AND add the new one — devices that installed under the old id still have that folder, and its `data.json` is device-specific:

```ts
export const BLACKLISTED_PLUGIN_DIRS = ["remotely-save", "ioto-update", "slides-rup", "config-sync", "obsidian-config-sync"];
```

- `src/core/ConfigSyncCore.ts:35`: `` return `${ctx.configDir}/plugins/obsidian-config-sync/backup`; `` → `` return `${ctx.configDir}/plugins/config-sync/backup`; ``
- `package.json` `smoke:install`: both occurrences of `dev/vault/.obsidian/plugins/obsidian-config-sync` → `dev/vault/.obsidian/plugins/config-sync`.

- [ ] **Step 4: Verify gate**

Run: `npm test && npm run build && npm run lint`
Expected: all tests pass; tsc clean; lint **0 errors**.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/core/manifest.ts src/core/ConfigSyncCore.ts package.json tests/core.test.ts tests/manifest.test.ts
git commit -m "feat!: rename plugin id to config-sync for community submission"
```

---

### Task 2: Full-width search box + picker Sync-all toggle

**Files:**
- Modify: `styles.css` (search rules; delete `.config-sync-syncall`)
- Modify: `src/ui/SettingTab.ts:206,212-223` (`addSyncAllButton` → `addSyncAllToggle`)

**Interfaces:**
- Consumes: `toggleSection`, `findGroupByName` (already imported), `Setting.addToggle`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Widen the search box (CSS)**

In `styles.css`, replace the two search rules:

```css
.config-sync-search {
  display: flex;
  justify-content: center;
  margin-bottom: var(--size-4-4);
}

.config-sync-search .search-input-container {
  width: 100%;
  max-width: 40em;
}
```

with:

```css
.config-sync-search {
  display: flex;
  margin-bottom: var(--size-4-4);
}

.config-sync-search .search-input-container {
  width: 100%;
}
```

- [ ] **Step 2: Replace the Sync all/none button with a toggle**

In `src/ui/SettingTab.ts`, replace the whole `addSyncAllButton` method (currently lines ~212-223):

```ts
  private addSyncAllButton(head: Setting, sec: CatalogSection): void {
    const tickable = sec.items.filter((i) => i.disabledReason === null);
    const allOn = tickable.length > 0 && tickable.every((i) => findGroupByName(this.groups, i.name) !== undefined);
    head.addButton((b) => {
      b.setButtonText(allOn ? "Sync none" : "Sync all").onClick(async () => {
        this.groups = toggleSection(this.groups, sec.items, !allOn);
        await this.saveGroups();
        this.refresh();
      });
      b.buttonEl.addClass("config-sync-syncall");
    });
  }
```

with:

```ts
  private addSyncAllToggle(head: Setting, sec: CatalogSection): void {
    const tickable = sec.items.filter((i) => i.disabledReason === null);
    const allOn = tickable.length > 0 && tickable.every((i) => findGroupByName(this.groups, i.name) !== undefined);
    head.addToggle((t) => {
      t.setValue(allOn)
        .setTooltip(allOn ? "Sync none" : "Sync all")
        .onChange(async (v) => {
          this.groups = toggleSection(this.groups, sec.items, v);
          await this.saveGroups();
          this.refresh();
        });
    });
  }
```

Update the single call site (line ~206): `if (sec.allowSyncAll) this.addSyncAllButton(head, sec);` → `if (sec.allowSyncAll) this.addSyncAllToggle(head, sec);`

- [ ] **Step 3: Delete the now-unused CSS class**

In `styles.css`, delete:

```css
.config-sync-syncall {
  color: var(--text-accent);
}
```

- [ ] **Step 4: Verify gate**

Run: `npm test && npm run build && npm run lint`
Expected: 103 tests pass; tsc clean; lint reports **0 errors** (warnings acceptable).

- [ ] **Step 5: Commit**

```bash
git add styles.css src/ui/SettingTab.ts
git commit -m "feat: full-width search box and Sync-all toggle"
```

---

### Task 3: Advanced summary rows + expand-to-edit (lock removal)

**Files:**
- Modify: `src/ui/SettingTab.ts` (field at :87, `display()` at :101, `renderAdvanced` at ~:400-455, `renderRuleCard` at ~:491-608)
- Modify: `styles.css` (delete card/field classes, add row/expand/form classes)

**Interfaces:**
- Consumes: `defaultGroupForName`, `expectedPathForName`, `splitLocation`, `joinLocation` (imported), `ButtonComponent`, `ExtraButtonComponent`, `DropdownComponent`, `TextComponent` (imported).
- Produces: `.config-sync-row` / `.config-sync-rule-spacer` / `.config-sync-rule-name` CSS + row DOM pattern that Task 4 reuses; `private expanded = new Set<string>()`.

- [ ] **Step 1: Swap the transient state**

Line ~87: replace

```ts
  private unlocked = new Set<string>(); // UI-transient: advanced rows unlocked this session
```

with

```ts
  private expanded = new Set<string>(); // UI-transient: advanced rows expanded this session
```

In `display()` (line ~101): `this.unlocked.clear();` → `this.expanded.clear();`

- [ ] **Step 2: Simplify the Managed heading (drop Lock all / Unlock all)**

In `renderAdvanced`, replace the heading block (currently ~:405-428):

```ts
    const managedHead = new Setting(containerEl)
      .setName("Managed by pickers")
      .setHeading()
      .setDesc("Rules created from the other tabs. Expand a row to edit it, or reset it to the picker default.");
    if (managed.length > 0) {
      managedHead.addButton((b) => b.setButtonText("Reset all").onClick(async () => {
        for (let i = 0; i < this.groups.length; i++) {
          const g = this.groups[i];
          if (g === undefined || !reserved.has(g.name)) continue;
          const def = defaultGroupForName(g.name);
          if (def !== null) this.groups[i] = def;
        }
        await this.saveGroups();
        this.refresh();
      }));
    }
```

(The `Reset all` handler body is unchanged; only the two `Lock all`/`Unlock all` `addButton` calls and the old desc are gone.)

- [ ] **Step 3: Auto-expand Add rule**

In `renderAdvanced`'s Add-rule button (~:449-454), add the expansion line:

```ts
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.expanded.add("");
        this.refresh();
      })
    );
```

- [ ] **Step 4: Rewrite `renderRuleCard` as summary row + expand panel**

Replace the entire `renderRuleCard` method (~:491-608) with:

```ts
  private renderRuleCard(listEl: HTMLElement, group: SyncGroup, managed: boolean): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: group.name === "" ? "(unnamed)" : group.name });
    row.createSpan({ cls: "config-sync-row-path", text: splitLocation(group.path).rel });
    if (managed) {
      const expected = expectedPathForName(group.name);
      if (expected !== null && group.path !== expected) {
        row.createSpan({ cls: "config-sync-badge", text: "⚙ customized", attr: { title: `was ${expected}` } });
      }
    }
    row.createDiv({ cls: "config-sync-rule-spacer" });
    if (managed) {
      new ButtonComponent(row)
        .setButtonText("Reset")
        .setTooltip("Restore to the picker default")
        .onClick(async () => {
          const def = defaultGroupForName(group.name);
          if (def === null) return;
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups[idx] = def;
          await this.saveGroups();
          this.refresh();
        });
    } else {
      new ExtraButtonComponent(row)
        .setIcon("trash")
        .setTooltip("Delete rule")
        .onClick(async () => {
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups.splice(idx, 1);
          this.expanded.delete(group.name);
          await this.saveGroups();
          this.refresh();
        });
    }
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (isOpen) this.renderRuleForm(listEl, group, managed);
  }

  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, managed: boolean): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = (parent: HTMLElement, label: string): HTMLElement => {
      const f = parent.createDiv();
      f.createEl("label", { cls: "config-sync-form-label", text: label });
      return f;
    };

    const line1 = panel.createDiv({ cls: "config-sync-form-line1" + (managed ? "" : " has-name") });
    if (!managed) {
      const nameC = new TextComponent(field(line1, "Name"));
      nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(group.name).onChange((v) => {
        this.expanded.delete(group.name);
        group.name = v.trim();
        this.expanded.add(group.name);
        void this.saveGroups();
      });
      nameC.inputEl.addClass("config-sync-rule-name-input");
    }
    const loc = splitLocation(group.path);
    new DropdownComponent(field(line1, "Location"))
      .addOption("config", "Config folder")
      .addOption("vault", "Vault root")
      .setValue(loc.location)
      .onChange((v) => {
        group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
        void this.saveGroups();
      });
    const pathC = new TextComponent(field(line1, "Path"));
    pathC.setPlaceholder("relative path").setValue(loc.rel).onChange((v) => {
      group.path = joinLocation(splitLocation(group.path).location, v.trim());
      void this.saveGroups();
    });

    const line2 = panel.createDiv({ cls: "config-sync-form-line2" });
    new DropdownComponent(field(line2, "Type"))
      .addOption("file", "file")
      .addOption("dir", "dir")
      .setValue(group.type)
      .onChange(async (v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        await this.saveGroups();
        this.refresh();
      });
    new DropdownComponent(field(line2, "Devices"))
      .addOption("all", "all")
      .addOption("desktop", "desktop")
      .addOption("mobile", "mobile")
      .setValue(group.devices)
      .onChange(async (v) => {
        group.devices = v as DeviceClass;
        await this.saveGroups();
        this.refresh();
      });
    const sanC = new TextComponent(field(line2, "Sanitize"));
    sanC.setPlaceholder("globs, comma-separated").setValue(group.sanitize?.join(", ") ?? "").setDisabled(group.type !== "file").onChange((v) => {
      const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (patterns.length > 0) group.sanitize = patterns;
      else delete group.sanitize;
      void this.saveGroups();
    });
    const descC = new TextComponent(field(line2, "Description"));
    descC.setPlaceholder("optional").setValue(group.description ?? "").onChange((v) => {
      const d = v.trim();
      if (d !== "") group.description = d;
      else delete group.description;
      void this.saveGroups();
    });
  }
```

Notes for the implementer:
- `renderDiscoveredCard` still exists and compiles against the old CSS classes until Task 4 — do not touch it here.
- The `⚙ customized` badge keeps `.config-sync-badge` (existing class), with the expected path moved into a `title` tooltip.
- The row click handler ignores clicks landing on interactive elements (`button`, Obsidian's `.clickable-icon`, `input`, `select`).

- [ ] **Step 5: CSS — delete card/field classes, add row/expand/form classes**

In `styles.css`, DELETE these rules entirely: `.config-sync-rule`, `.config-sync-rule-head`, `.config-sync-rule-controls`, `.config-sync-field`, `.config-sync-field-grow`, `.config-sync-field-label`.

KEEP: `.config-sync-rule-name`, `.config-sync-rule-name-input`, `.config-sync-rule-spacer`, `.config-sync-badge`.

ADD:

```css
.config-sync-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  margin-bottom: var(--size-4-2);
  cursor: pointer;
}

.config-sync-row.is-open {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  margin-bottom: 0;
}

.config-sync-row.is-static {
  cursor: default;
}

.config-sync-row-chevron {
  color: var(--text-muted);
  width: 1em;
  flex: none;
}

.config-sync-row-path {
  font-family: var(--font-monospace);
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}

.config-sync-expand {
  border: 1px solid var(--background-modifier-border);
  border-top: none;
  border-bottom-left-radius: var(--radius-m);
  border-bottom-right-radius: var(--radius-m);
  padding: var(--size-4-3);
  margin-bottom: var(--size-4-2);
}

.config-sync-expand input,
.config-sync-expand select {
  width: 100%;
}

.config-sync-form-line1 {
  display: grid;
  grid-template-columns: 10em 1fr;
  gap: var(--size-4-3);
  margin-bottom: var(--size-4-2);
}

.config-sync-form-line1.has-name {
  grid-template-columns: minmax(8em, 14em) 10em 1fr;
}

.config-sync-form-line2 {
  display: grid;
  grid-template-columns: 7em 8em 1fr 1fr;
  gap: var(--size-4-3);
}

.config-sync-form-label {
  display: block;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--size-2-1);
}
```

(`.config-sync-row.is-static` is used by Task 4's Discovered rows.)

- [ ] **Step 6: Verify gate**

Run: `npm test && npm run build && npm run lint`
Expected: 103 tests pass; tsc clean (all `unlocked`/`locked` references gone — a leftover reference is a compile error); lint **0 errors**.

- [ ] **Step 7: Commit**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "feat: Advanced summary rows with expand-to-edit, lock mechanism removed"
```

---

### Task 4: Discovered files as toggle rows

**Files:**
- Modify: `src/ui/SettingTab.ts` (imports at :1; Discovered heading copy in `renderAdvanced` ~:435-438; replace `renderDiscoveredCard` ~:457-489)

**Interfaces:**
- Consumes: `.config-sync-row` / `.is-static` / `.config-sync-rule-name` / `.config-sync-rule-spacer` CSS from Task 3; `ToggleComponent` from `obsidian`; `splitLocation`; `this.host.writeGroupsFile`; `groupsErrorMsg` rollback pattern.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Import ToggleComponent**

Line 1 of `src/ui/SettingTab.ts`: add `ToggleComponent` to the `obsidian` import list (keep alphabetical order within the braces: `..., TextComponent, ToggleComponent }`).

- [ ] **Step 2: Update the Discovered heading copy**

In `renderAdvanced` (~:435-438), change the desc:

```ts
      new Setting(containerEl)
        .setName("Discovered files")
        .setHeading()
        .setDesc("Config files we found but couldn't classify. Turn one on to start syncing it — rename it under Custom rules.");
```

Also update the loop call name: `for (const d of discovered) this.renderDiscoveredRow(discEl, d);`

- [ ] **Step 3: Replace `renderDiscoveredCard` with `renderDiscoveredRow`**

Replace the whole method (~:457-489) with:

```ts
  private renderDiscoveredRow(listEl: HTMLElement, d: { name: string; path: string }): void {
    const row = listEl.createDiv({ cls: "config-sync-row is-static" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(d.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(false).setTooltip("Sync this file").onChange(async (v) => {
      if (!v) return;
      this.groups.push({ name: d.name, path: d.path, type: "file", devices: "all" });
      try {
        await this.host.writeGroupsFile(this.groups);
        this.groupsErrorMsg = "";
      } catch (e) {
        this.groups.pop(); // roll back so no broken group persists in memory
        this.groupsErrorMsg = `Not saved: ${(e as Error).message}`;
      }
      this.refresh();
    });
  }
```

Note: `TextComponent` and `ButtonComponent` remain used elsewhere (rule form, Reset) — do not remove them from the imports.

- [ ] **Step 4: Verify gate**

Run: `npm test && npm run build && npm run lint`
Expected: 103 tests pass; tsc clean; lint **0 errors**.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: Discovered files as toggle rows without name input"
```

---

## Notes for the executor

- Order: Task 1 → 2 → 3 → 4 (Task 1 first so all dev-vault smoke runs under the new id `config-sync`; Task 4 reuses Task 3's CSS row classes).
- There is no unit-test surface (pure DOM); the per-task gate is test+build+lint. The controller runs the obsidian-cli dev-vault smoke after the final whole-branch review, per the spec's smoke checklist.
- The 54 pre-existing lint warnings are not the gate; only lint **errors** fail. New UI copy may add sentence-case warnings — acceptable, consistent with the existing panel copy.
