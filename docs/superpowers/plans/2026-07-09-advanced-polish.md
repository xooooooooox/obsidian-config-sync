# advanced-polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-lay the Advanced rules as non-overflowing cards (title + two control rows), add per-row and bulk reset/lock/unlock, enforce variable-style group names, action-oriented section copy, and consistent Sync all/none button styling — per the spec at `docs/superpowers/specs/2026-07-09-advanced-polish-design.md`.

**Architecture:** Two pure-logic additions in `src/core/catalog.ts` (`defaultGroupForName` for reset; reworded section descriptions) and `src/core/manifest.ts` (variable-style name validation), then a `src/ui/SettingTab.ts` rewrite of the Advanced rendering into cards with reset + bulk buttons and a restyled section Sync-all button, plus `styles.css`.

**Tech Stack:** unchanged (TypeScript strict, esbuild/eslint from template vendor upstream, vitest, Obsidian API).

## Global Constraints

- All prior constraints hold: mobile I/O red line (src/core imports no Node/`obsidian`), plugin-dir blacklist, strict tsconfig with `noUncheckedIndexedAccess`, explicit errors, JSON 2-space + trailing newline, `{configDir}` never rendered in the UI, form rules (text onChange never re-renders except search; `refresh()` keeps drafts + restores scroll + render-gen guard; structural actions await save then refresh; `display()` resets tab/search/unlocked).
- **Name rule (spec D):** every group `name` must match `^[a-z0-9][a-z0-9_-]*$`. All reserved picker names already comply (`app`, `graph`, `community-plugins`, `plugin-<id>`, `snippets`, …); starter names comply. Rejected in `validateSyncManifest`.
- **Reset (spec B):** `defaultGroupForName(name)` returns the picker default group (path=`expectedPathForName`, devices=`all`, catalog default description, no sanitize) or `null` for non-reserved names.
- **Card layout (spec A):** each Advanced rule = one card: title row (lock icon for managed, variable-style `name`, `⚙ customized (was <expected>)` badge, reset button) + two control rows (Location+Path; Type+Devices+Sanitize). Managed cards lock all control fields until unlocked; reset works while locked. CSS prefix `config-sync-`.
- **Copy (spec E):** the nine section descriptions are replaced with the exact strings in Task 1.
- **Sync all/none (spec F):** styled to match item-row buttons; label "Sync all"/"Sync none" by all-ticked state; hidden on Not-recommended sections.
- Repo: https://github.com/xooooooooox/obsidian-config-sync . Branch `feat/advanced-polish` created from `main` at execution time. All commands run from the repo root.

## File Structure

```
src/core/catalog.ts   # + defaultGroupForName(name); reworded 9 section descriptions
src/core/manifest.ts  # parseGroup: name must match ^[a-z0-9][a-z0-9_-]*$
src/ui/SettingTab.ts  # renderAdvanced/renderGroupRow → cards + reset + bulk; restyled Sync-all button
styles.css            # rule card + control-row + Sync-all button styles
tests/catalog.test.ts # defaultGroupForName + section-copy assertions
tests/manifest.test.ts# name-format validation
README.md / CLAUDE.md # advanced card + reset/bulk + name-rule notes
```

---

### Task 1: catalog — defaultGroupForName + section copy (pure)

**Files:**
- Modify: `src/core/catalog.ts`
- Test: `tests/catalog.test.ts` (append)

**Interfaces:**
- Consumes: `OPTION_LABELS`, `optionReservedName`, `CORE_SETTINGS_IDS`, `corePluginFile`, `SyncGroup`, `FileIO`, existing `HIDDEN_FILES`/`SWITCH_LISTS`/`CORE_FILE_SET`/`basename`.
- Produces: `defaultGroupForName(name: string): SyncGroup | null` — the picker default for a reserved name, `null` otherwise (Task 3's reset relies on it); `listDiscovered(io: FileIO, configDir: string, groups: SyncGroup[]): Promise<{ name: string; path: string }[]>` — config-root `.json` files not classified and not covered by any group's path, `name` = filename-slug prefill (Task 3's Discovered section relies on it); the enumerated-file loop in `listOptionSections` re-filters to `.json` non-dotfiles (fixes `.DS_Store` leak). Section descriptions changed (Task 3's UI shows them; no signature change).

- [ ] **Step 1: Append the failing tests to `tests/catalog.test.ts`**

Add `defaultGroupForName` and `listCoreSections`/`listOptionSections`/`listPluginSections` (already imported) usage. Append:

```ts
describe("defaultGroupForName", () => {
  it("returns the picker default for an option name (with catalog description)", () => {
    expect(defaultGroupForName("app")).toEqual({
      name: "app",
      path: "{configDir}/app.json",
      type: "file",
      devices: "all",
      description: "Editor and general options.",
    });
    expect(defaultGroupForName("snippets")).toEqual({
      name: "snippets",
      path: "{configDir}/snippets",
      type: "dir",
      devices: "all",
      description: "Your CSS snippets.",
    });
  });

  it("returns the picker default for a community and core name", () => {
    expect(defaultGroupForName("plugin-dataview")).toEqual({
      name: "plugin-dataview",
      path: "{configDir}/plugins/dataview/data.json",
      type: "file",
      devices: "all",
      description: "Settings of dataview.",
    });
    expect(defaultGroupForName("properties")).toEqual({
      name: "properties",
      path: "{configDir}/types.json",
      type: "file",
      devices: "all",
    });
  });

  it("returns null for a non-reserved name", () => {
    expect(defaultGroupForName("my-own")).toBeNull();
  });
});

describe("listDiscovered", () => {
  it("lists unclassified config-root json, excludes junk/known/covered, prefills a slug name", async () => {
    const io = new MemFS();
    io.seed({
      ".obs/app.json": "{}",                              // known option → excluded
      ".obs/graph.json": "{}",                            // core file → excluded
      ".obs/community-plugins.json": "{}",                // switch list → excluded
      ".obs/core-plugins-migration.json": "{}",           // hidden → excluded
      ".obs/.DS_Store": "junk",                           // dotfile/non-json → excluded
      ".obs/image-converter-image-alignments.json": "{}", // unclassified → INCLUDED
      ".obs/covered.json": "{}",                          // covered by a group below → excluded
      ".obs/plugins/demo/data.json": "{}",                // under plugins/ → excluded
    });
    const groups: SyncGroup[] = [{ name: "covered-rule", path: "{configDir}/covered.json", type: "file", devices: "all" }];
    const found = await listDiscovered(io, ".obs", groups);
    expect(found).toEqual([
      { name: "image-converter-image-alignments", path: "{configDir}/image-converter-image-alignments.json" },
    ]);
  });

  it("excludes .DS_Store and non-json even when no group exists", async () => {
    const io = new MemFS();
    io.seed({ ".obs/.DS_Store": "junk", ".obs/notes.txt": "x" });
    expect(await listDiscovered(io, ".obs", [])).toEqual([]);
  });
});

describe("section copy (action-oriented)", () => {
  it("uses the action-oriented descriptions", async () => {
    const io = new MemFS();
    io.seed({ ".obs/app.json": "{}" });
    const opt = await listOptionSections(io, ".obs", []);
    expect(opt.find((s) => s.bucket === "available")?.description).toBe("Sync these settings that already exist in this vault.");
    const core = await listCoreSections(io, ".obs", [{ id: "graph", name: "Graph view", enabled: true }], []);
    expect(core.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled core plugins.");
    const com = await listPluginSections(io, ".obs", [{ id: "dataview", name: "Dataview", enabled: true }], []);
    expect(com.find((s) => s.bucket === "enabled")?.description).toBe("Sync the settings files of your enabled community plugins.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — `defaultGroupForName` not exported; old section copy.

- [ ] **Step 3: Add `defaultGroupForName` to `src/core/catalog.ts`** (place near `groupForItem`)

```ts
export function defaultGroupForName(name: string): SyncGroup | null {
  for (const [file, meta] of Object.entries(OPTION_LABELS)) {
    if (optionReservedName(file) === name) {
      return {
        name,
        path: `{configDir}/${meta.type === "dir" ? name : file}`,
        type: meta.type,
        devices: "all",
        description: meta.description,
      };
    }
  }
  if (name.startsWith("plugin-")) {
    const id = name.slice("plugin-".length);
    return { name, path: `{configDir}/plugins/${id}/data.json`, type: "file", devices: "all", description: `Settings of ${id}.` };
  }
  if (CORE_SETTINGS_IDS.includes(name)) {
    return { name, path: `{configDir}/${corePluginFile(name)}`, type: "file", devices: "all" };
  }
  return null;
}

export async function listDiscovered(
  io: FileIO,
  configDir: string,
  groups: SyncGroup[]
): Promise<{ name: string; path: string }[]> {
  const { files } = await presentSets(io, configDir);
  const coveredPaths = new Set(groups.map((g) => g.path));
  const knownOptionFiles = new Set(Object.keys(OPTION_LABELS));
  const out: { name: string; path: string }[] = [];
  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (knownOptionFiles.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    const path = `{configDir}/${b}`;
    if (coveredPaths.has(path)) continue;
    out.push({ name: optionReservedName(b), path });
  }
  return out;
}
```

(`presentSets`, `HIDDEN_FILES`, `SWITCH_LISTS`, `CORE_FILE_SET`, `basename` already exist in `catalog.ts`. `optionReservedName(b)` strips `.json` → the prefill slug, which is already lowercase-dash-valid for typical config filenames.)

- [ ] **Step 4: Replace the nine section descriptions** (the string literals inside the `section(...)` calls in `listOptionSections`, `listCoreSections`, `listPluginSections`)

`listOptionSections` return:
```ts
  return [
    ...section("available", "Available", "Sync these settings that already exist in this vault.", true, available),
    ...section("notPresent", "Not yet in this vault", "Nothing to sync yet — customize these in Obsidian first, then they'll appear here.", true, notPresent),
    ...section("notRecommended", "Not recommended", "Device-specific — syncing makes your devices overwrite each other's layout.", false, notRecommended),
  ];
```

`listCoreSections` return:
```ts
  return [
    ...section("list", "Plugin on/off list", "Which core plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled core plugins.", true, enabled),
    ...section("disabled", "Disabled", "Sync a disabled core plugin's settings now, ready for when you turn it on.", true, disabled),
    ...section("notRecommended", "Not recommended", "Holds account or device-specific data — not meant to travel between vaults.", false, notRecommended),
  ];
```

`listPluginSections` return:
```ts
  return [
    ...section("list", "Plugin on/off list", "Which community plugins are turned on, mirrored across devices.", false, [switchItem]),
    ...section("enabled", "Enabled", "Sync the settings files of your enabled community plugins.", true, enabled),
    ...section("disabled", "Installed but disabled", "Sync a disabled plugin's settings now, ready for when you turn it on.", true, disabled),
    ...section("notRecommended", "Not recommended", BLACKLIST_REASON, false, notRecommended),
  ];
```

(Leave `BLACKLIST_REASON` and `CORE_CAUTION` constants unchanged — they are the per-item reasons; only the section literals change. Community Not-recommended keeps `BLACKLIST_REASON` as its section copy, which already reads action-neutral and correct.)

- [ ] **Step 4b: Fix the `.DS_Store` leak in `listOptionSections`** — the enumerated-unknown-file loop currently reads:

```ts
  for (const b of [...files].sort()) {
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
```

Add the `.json`-and-non-dotfile guard as the first condition so non-json / dotfiles (`.DS_Store`) never enumerate, AND unclassified `.json` files no longer surface in the Obsidian tab (they move to Discovered — Task 3):

```ts
  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    if (!(b in OPTION_LABELS)) continue; // unclassified json belongs in Discovered, not the Obsidian tab
```

Wait — the known OPTION_LABELS files are handled in the earlier loop and added to `covered`; this loop only runs for files NOT in that set. With the new `if (!(b in OPTION_LABELS)) continue;` every remaining file is skipped, so the Obsidian tab shows only known options + directories. That is intended: `.DS_Store` gone, unclassified json relocated. (The `workspace*.json` Not-recommended item ALSO came through this loop — it is NOT in OPTION_LABELS, so this change would drop it. To preserve workspace: keep the workspace branch by special-casing it before the OPTION_LABELS skip.)

Final loop body:

```ts
  for (const b of [...files].sort()) {
    if (!b.endsWith(".json") || b.startsWith(".")) continue;
    if (covered.has(b) || HIDDEN_FILES.has(b) || SWITCH_LISTS.has(b) || CORE_FILE_SET.has(b)) continue;
    if (WORKSPACE_RE.test(b)) {
      notRecommended.push({
        name: optionReservedName(b),
        label: b,
        description: null,
        path: `{configDir}/${b}`,
        type: "file",
        exists: true,
        disabledReason: null,
        cautionReason: WORKSPACE_CAUTION,
      });
      covered.add(b);
      continue;
    }
    // any other unclassified json → Discovered tab section, not here
  }
```

(This keeps `workspace.json`/`workspaces.json` in the Obsidian Not-recommended section as before, drops `.DS_Store`, and relocates every other unknown json to Discovered. The trailing `dirs` loop is unchanged — directories stay as options.)

- [ ] **Step 4c: Update the iter5 test that expected unclassified json in the Obsidian tab**

In `tests/catalog.test.ts`, the existing `describe("listOptionSections")` test seeds `.obs/custom-unknown.json` and asserts it in the `available` bucket. With Step 4b it moves to Discovered. Change that assertion so `custom-unknown` is NO LONGER expected in options — e.g. update `expect(names("available")).toEqual([...])` to drop `"custom-unknown"`, leaving `["app", "appearance", "snippets"]` (or whatever the seed produces). Do not delete the test; just fix the expectation to match the relocation.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (90 baseline + new tests, minus the adjusted assertion). `npm run build` / `npm run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/catalog.ts tests/catalog.test.ts
git commit -m "feat: defaultGroupForName, listDiscovered, .json enumeration filter, section copy"
```

---

### Task 2: manifest — variable-style name validation (pure)

**Files:**
- Modify: `src/core/manifest.ts`
- Test: `tests/manifest.test.ts` (append)

**Interfaces:**
- Produces: `parseGroup` rejects any `name` not matching `^[a-z0-9][a-z0-9_-]*$`; message contains "lowercase". Applies to all groups (reserved names already comply). Task 3's custom-name field surfaces the same error via saveGroups.

- [ ] **Step 1: Append the failing tests to `tests/manifest.test.ts`**

```ts
describe("group name format", () => {
  it("accepts variable-style names (reserved and custom)", () => {
    for (const name of ["app", "community-plugins", "plugin-dataview", "my_rule", "graph"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(parseSyncManifest(manifestWith([g])).groups[0]?.name).toBe(name);
    }
  });

  it("rejects names with spaces, uppercase or illegal symbols", () => {
    for (const name of ["My Rule", "Graph", "a b", "weird!", "-leading"]) {
      const g = { name, path: "{configDir}/x.json", type: "file", devices: "all" };
      expect(() => parseSyncManifest(manifestWith([g]))).toThrow("lowercase");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — no name-format rejection.

- [ ] **Step 3: Add the check in `src/core/manifest.ts`** — in `parseGroup`, right after the existing `"name" must be a non-empty string` check:

```ts
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new ManifestValidationError(
      `group "${name}": name must be lowercase letters, digits, "-" or "_" and start with a letter or digit`
    );
  }
```

(The `name` variable is already validated as a non-empty string above; this runs after that guard.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Confirm no existing test uses a non-conforming group name — the starter/reserved names and test fixtures all use lowercase-dash names. If a fixture breaks, it means a test used an illegal name; fix the fixture name, not the regex. `npm run build` / `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/manifest.ts tests/manifest.test.ts
git commit -m "feat: enforce variable-style group names"
```

---

### Task 3: SettingTab — Advanced cards, reset, bulk buttons, Sync-all restyle

**Files:**
- Modify: `src/ui/SettingTab.ts`

**Interfaces:**
- Consumes: `defaultGroupForName`, `listDiscovered` (Task 1), existing `expectedPathForName`, `splitLocation`, `joinLocation`, `toggleSection`, `findGroupByName`, `reservedNames`.
- Produces: card-based Advanced tab with Managed / Discovered / Custom sub-sections, per-row reset + bulk lock/unlock/reset, restyled Sync-all button. `SettingsHost` gains `listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>`. No unit tests; gate = tsc/build/lint + orchestrator smoke.

- [ ] **Step 0: Add the host method** — in `src/main.ts` add (next to `listOptionSections`), import `listDiscovered` from `./core/catalog`:

```ts
  async listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]> {
    return listDiscovered(this.app.vault.adapter, this.app.vault.configDir, groups);
  }
```

and add the member to `SettingsHost` in `src/ui/SettingTab.ts`:

```ts
  listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>;
```

- [ ] **Step 1: Update imports in `src/ui/SettingTab.ts`**

Add `ButtonComponent, DropdownComponent, ExtraButtonComponent, SearchComponent, TextComponent` to the `obsidian` import, and `defaultGroupForName` to the `../core/catalog` import:

```ts
import { App, ButtonComponent, DropdownComponent, ExtraButtonComponent, Notice, Plugin, PluginSettingTab, SearchComponent, Setting, TextComponent } from "obsidian";
```
```ts
import {
  CatalogItem,
  CatalogSection,
  defaultGroupForName,
  expectedPathForName,
  findGroupByName,
  groupForItem,
  joinLocation,
  reservedNames,
  splitLocation,
  toggleSection,
} from "../core/catalog";
```

- [ ] **Step 2: Restyle the Sync-all button** — in `addSyncAllButton`, add a class so CSS can match it to the item rows:

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

- [ ] **Step 2b: Make the Advanced call site async** — in `renderActiveTab`, the `case "advanced":` becomes:

```ts
      case "advanced":
        if (this.renderGroupsReadError(containerEl)) break;
        await this.renderAdvanced(containerEl, gen);
        if (gen !== this.renderGen) return;
        this.renderGroupsError(containerEl);
        break;
```

- [ ] **Step 3: Replace `renderAdvanced`** with the async card version + Managed/Discovered/Custom sub-sections + bulk buttons

```ts
  private async renderAdvanced(containerEl: HTMLElement, gen: number): Promise<void> {
    const reserved = reservedNames(this.host.installedPluginIds());
    const managed = this.groups.filter((g) => reserved.has(g.name));
    const custom = this.groups.filter((g) => !reserved.has(g.name));

    const managedHead = new Setting(containerEl)
      .setName("Managed by pickers")
      .setHeading()
      .setDesc("Rules created from the other tabs. Locked by default — unlock a row to fix a path that has gone stale, or reset it to the picker default.");
    if (managed.length > 0) {
      managedHead.addButton((b) => b.setButtonText("Lock all").onClick(() => {
        this.unlocked.clear();
        this.refresh();
      }));
      managedHead.addButton((b) => b.setButtonText("Unlock all").onClick(() => {
        for (const g of managed) this.unlocked.add(g.name);
        this.refresh();
      }));
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
    const managedEl = containerEl.createDiv();
    for (const group of managed) this.renderRuleCard(managedEl, group, true);

    const discovered = await this.host.listDiscoveredFiles(this.groups);
    if (gen !== this.renderGen) return;
    if (discovered.length > 0) {
      new Setting(containerEl)
        .setName("Discovered files")
        .setHeading()
        .setDesc("Config files we found but couldn't classify. Give one a name to start syncing it — its path is fixed to the file on disk.");
      const discEl = containerEl.createDiv();
      for (const d of discovered) this.renderDiscoveredCard(discEl, d);
    }

    new Setting(containerEl)
      .setName("Custom rules")
      .setHeading()
      .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection (sanitize).");
    const customEl = containerEl.createDiv();
    for (const group of custom) this.renderRuleCard(customEl, group, false);
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.refresh();
      })
    );
  }

  private renderDiscoveredCard(listEl: HTMLElement, d: { name: string; path: string }): void {
    const card = listEl.createDiv({ cls: "config-sync-rule" });
    const head = card.createDiv({ cls: "config-sync-rule-head" });
    head.createSpan({ cls: "config-sync-rule-name", text: splitLocation(d.path).rel });
    head.createDiv({ cls: "config-sync-rule-spacer" });

    const controls = card.createDiv({ cls: "config-sync-rule-controls" });
    const nameField = controls.createDiv({ cls: "config-sync-field" });
    nameField.createEl("label", { cls: "config-sync-field-label", text: "Name" });
    let draftName = d.name;
    const nameC = new TextComponent(nameField);
    nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(draftName).onChange((v) => {
      draftName = v.trim();
    });
    nameC.inputEl.addClass("config-sync-field-grow");
    nameC.inputEl.addClass("config-sync-rule-name-input");

    new ButtonComponent(controls)
      .setButtonText("Sync this file")
      .setCta()
      .onClick(async () => {
        const group: SyncGroup = { name: draftName, path: d.path, type: "file", devices: "all" };
        this.groups.push(group);
        try {
          await this.host.writeGroupsFile(this.groups);
          this.groupsErrorMsg = "";
        } catch (e) {
          this.groups.pop(); // roll back an invalid name so no broken group persists in memory
          this.groupsErrorMsg = `Not saved: ${(e as Error).message}`;
        }
        this.refresh();
      });
  }
```

(`renderRuleCard` is unchanged from Step 4 below; the Discovered card is separate because its path is read-only and it isn't a saved group until "Sync this file" is clicked. On an invalid `draftName`, `writeGroupsFile` throws, the group is rolled back out of `this.groups`, and `groupsErrorMsg` shows the format error on re-render — the discovered card stays for the user to fix the name. `renderDiscoveredCard` has no reset/lock/path controls by design.)

- [ ] **Step 4: Replace `renderGroupRow` with `renderRuleCard`** (card layout; raw components mounted into custom divs so fields wrap instead of overflow)

```ts
  private renderRuleCard(listEl: HTMLElement, group: SyncGroup, managed: boolean): void {
    const locked = managed && !this.unlocked.has(group.name);
    const card = listEl.createDiv({ cls: "config-sync-rule" });

    const head = card.createDiv({ cls: "config-sync-rule-head" });
    if (managed) {
      new ExtraButtonComponent(head)
        .setIcon(locked ? "lock" : "unlock")
        .setTooltip(locked ? "Unlock to edit" : "Lock")
        .onClick(() => {
          if (locked) this.unlocked.add(group.name);
          else this.unlocked.delete(group.name);
          this.refresh();
        });
      head.createSpan({ cls: "config-sync-rule-name", text: group.name });
      const expected = expectedPathForName(group.name);
      if (expected !== null && group.path !== expected) {
        head.createSpan({ cls: "config-sync-badge", text: `⚙ customized (was ${expected})` });
      }
      head.createDiv({ cls: "config-sync-rule-spacer" });
      new ButtonComponent(head)
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
      const nameC = new TextComponent(head);
      nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(group.name).onChange((v) => {
        group.name = v.trim();
        void this.saveGroups();
      });
      nameC.inputEl.addClass("config-sync-rule-name-input");
      head.createDiv({ cls: "config-sync-rule-spacer" });
      new ExtraButtonComponent(head)
        .setIcon("trash")
        .setTooltip("Delete rule")
        .onClick(async () => {
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups.splice(idx, 1);
          await this.saveGroups();
          this.refresh();
        });
    }

    const controls = card.createDiv({ cls: "config-sync-rule-controls" });
    const field = (label: string): HTMLElement => {
      const f = controls.createDiv({ cls: "config-sync-field" });
      f.createEl("label", { cls: "config-sync-field-label", text: label });
      return f;
    };

    const locField = field("Location");
    const loc = splitLocation(group.path);
    new DropdownComponent(locField)
      .addOption("config", "Config folder")
      .addOption("vault", "Vault root")
      .setValue(loc.location)
      .setDisabled(locked)
      .onChange((v) => {
        group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
        void this.saveGroups();
      });

    const pathC = new TextComponent(field("Path"));
    pathC.setPlaceholder("relative path").setValue(loc.rel).setDisabled(locked).onChange((v) => {
      group.path = joinLocation(splitLocation(group.path).location, v.trim());
      void this.saveGroups();
    });
    pathC.inputEl.addClass("config-sync-field-grow");

    new DropdownComponent(field("Type"))
      .addOption("file", "file")
      .addOption("dir", "dir")
      .setValue(group.type)
      .setDisabled(locked)
      .onChange(async (v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        await this.saveGroups();
        this.refresh();
      });

    new DropdownComponent(field("Devices"))
      .addOption("all", "all")
      .addOption("desktop", "desktop")
      .addOption("mobile", "mobile")
      .setValue(group.devices)
      .setDisabled(locked)
      .onChange(async (v) => {
        group.devices = v as DeviceClass;
        await this.saveGroups();
        this.refresh();
      });

    const sanC = new TextComponent(field("Sanitize"));
    sanC.setPlaceholder("globs, comma-separated").setValue(group.sanitize?.join(", ") ?? "").setDisabled(locked || group.type !== "file").onChange((v) => {
      const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (patterns.length > 0) group.sanitize = patterns;
      else delete group.sanitize;
      void this.saveGroups();
    });
    sanC.inputEl.addClass("config-sync-field-grow");

    const descC = new TextComponent(field("Description"));
    descC.setPlaceholder("optional").setValue(group.description ?? "").setDisabled(locked).onChange((v) => {
      const d = v.trim();
      if (d !== "") group.description = d;
      else delete group.description;
      void this.saveGroups();
    });
    descC.inputEl.addClass("config-sync-field-grow");
  }
```

(`DeviceClass` and `SyncGroup` are already imported. Remove the old `renderGroupRow` method entirely.)

- [ ] **Step 5: Replace `renderSearchBox`** with the Linter-style centered search box (spec H)

```ts
  private renderSearchBox(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "config-sync-search" });
    const search = new SearchComponent(wrap);
    search.setPlaceholder("Search all settings…");
    search.setValue(this.search);
    this.searchInputEl = search.inputEl;
    search.onChange((v) => {
      this.search = v;
      this.refresh();
    });
  }
```

(Removes the old `new Setting(containerEl).setName("Search").addText(...)` version. `SearchComponent` renders the native `.search-input-container` with a search icon and a clear button; clearing fires `onChange("")` → `refresh()`. Focus preservation is unchanged — `this.searchInputEl` now points at `search.inputEl`.)

- [ ] **Step 6: Verify**

Run: `npm run build` (exit 0), `npm test` (96 green — nothing may regress), `npm run lint` (no new ERRORS; obsidianmd style warnings from literals acceptable — list them).

- [ ] **Step 7: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: Advanced rule cards with reset/lock; Discovered section; centered search box"
```

---

### Task 4: styles + docs

**Files:**
- Modify: `styles.css`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: CSS classes from Task 3 (`config-sync-rule`, `config-sync-rule-head`, `config-sync-rule-name`, `config-sync-rule-name-input`, `config-sync-rule-spacer`, `config-sync-rule-controls`, `config-sync-field`, `config-sync-field-label`, `config-sync-field-grow`, `config-sync-badge`, `config-sync-syncall`).

- [ ] **Step 1: Append to `styles.css`**

```css
.config-sync-rule {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-2);
  margin-bottom: var(--size-4-2);
}

.config-sync-rule-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-2);
}

.config-sync-rule-name {
  font-family: var(--font-monospace);
  font-weight: var(--font-semibold);
}

.config-sync-rule-name-input {
  font-family: var(--font-monospace);
}

.config-sync-rule-spacer {
  flex: 1;
}

.config-sync-badge {
  color: var(--text-accent);
  font-size: var(--font-ui-smaller);
}

.config-sync-rule-controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2) var(--size-4-3);
  align-items: center;
}

.config-sync-field {
  display: flex;
  align-items: center;
  gap: var(--size-4-1);
}

.config-sync-field-grow {
  min-width: 12em;
}

.config-sync-field-label {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}

.config-sync-syncall {
  color: var(--text-accent);
}

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

(This replaces the iter5 `.config-sync-search` rule if one exists — check styles.css and update rather than duplicate the selector.)

- [ ] **Step 2: Update `README.md`** — in the settings paragraph (the "Pick what to sync…" one from iter5), after the Advanced sentence, append:

```markdown
The Advanced tab groups rules into **Managed by pickers** (name fixed, path unlockable, reset to default individually or in bulk via Lock all / Unlock all / Reset all), **Discovered files** (config files we couldn't classify — name them to start syncing; path is fixed), and **Custom rules** (fully your own). Rule names are variable-style identifiers (lowercase letters, digits, `-`, `_`).
```

- [ ] **Step 3: Update `CLAUDE.md`** — add one line under the catalog note:

```markdown
- The Advanced tab renders each rule as a card (`config-sync-rule`) with a title row (name + lock + customized badge + reset) and a wrapping control row; `defaultGroupForName(name)` in catalog.ts computes the picker default used by per-row and bulk reset. Group names must match `^[a-z0-9][a-z0-9_-]*$` (enforced in `validateSyncManifest`).
```

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm test` — both green.

```bash
git add styles.css README.md CLAUDE.md
git commit -m "docs: advanced card styles, reset/bulk and name-rule notes"
```

---

## After the tasks (orchestrator, not plan tasks)

Final whole-branch review (defaultGroupForName correctness incl. core no-description; listDiscovered excludes known/core/switch/plugins/hidden/non-json/dotfile/covered and prefills a slug; the `.DS_Store` leak is fixed and the Obsidian tab shows only known options + dirs + workspace; name-regex covers all reserved names and rejects spaces/uppercase; Advanced three sub-sections Managed/Discovered/Custom; card layout no overflow; reset restores exactly the picker default and clears the customized badge; bulk lock/unlock/reset; Discovered "Sync this file" rolls back on invalid name; Sync-all restyle; managed lock disables all card fields; section copy accuracy; form invariants preserved). Then obsidian-cli smoke in dev/vault: seed a `.DS_Store` and a stray `foo-bar.json` at config root → `.DS_Store` never appears anywhere, `foo-bar.json` appears under Advanced → Discovered (not Obsidian), name it and Sync this file → it moves to Custom rules and disappears from Discovered; Advanced cards don't overflow; unlock a managed row, edit path, save → no deformation, customized badge shows; per-row Reset restores default + badge gone; Lock/Unlock/Reset all; add a Custom rule "My Rule" → rejected with the lowercase message; check the three tabs' new section copy; Sync-all button visually consistent. Then merge + 0.5.0 release decision with the user.
