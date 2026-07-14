# Row Expansion Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the three expanded-item segment headers, rename/restructure "Advanced" into a default-collapsed "Custom location" segment (Location · Type · Path on one row + reset), and narrow the `⚙` badge so it marks only a non-default storage location.

**Architecture:** Pure UI edits in `src/ui/SettingTab.ts` + `styles.css`. The store-override renderer is renamed and gains a Type control and a flex Path layout; the badge predicate `isCustomized` drops its mode/devices/fields comparisons. All mutations keep routing through the existing `commitGroups` draft-find/rollback path. Colors stay theme-native (design-system compliant).

**Tech Stack:** TypeScript (Obsidian `DropdownComponent`/`TextComponent`/`Setting`), CSS (theme variables), vitest (unchanged, 202), obsidian-cli two-theme screenshot verification.

## Global Constraints

- Design-system rules hold: theme-native surfaces/controls, ZERO hardcoded color in `styles.css` (only `rgba(var(--…-rgb), opacity)` allowed), semantic colors on `--color-*`. `./scripts/check-no-hardcoded-color.sh` must pass.
- Every groups mutation goes through `commitGroups((draft) => { const g = draft.find(x => x.name === group.name); … }, group.name)` — never a live `group.*` write. Failed write rolls back + shows inline error.
- Segment headers are flush-left `.config-sync-explabel` with the toggle affordance as TRAILING text (▸/▾), matching the `Data file … View data.json ▸` idiom. No prefixed icons.
- Copy verbatim: segment title `Custom location`; toggle text `Custom location ▸` / `Custom location ▾`; reset link `↺ Reset to default`; badge text `⚙ custom location`; field labels `Location` / `Type` / `Path`; Location options `Config folder` (config) / `Vault root` (vault); Type options `File` (file) / `Folder` (dir).
- Gate for every task: `npm run build && npm run lint` clean (0 errors / 65 warnings baseline, don't add errors), `npm test` green (202), `./scripts/check-no-hardcoded-color.sh` passes.
- No Claude/AI attribution in commits.

---

### Task 1: Narrow the `⚙` badge to storage-only + rename badge text

**Files:**
- Modify: `src/ui/SettingTab.ts` (`isCustomized` ~line 618; the badge render in `renderItemInto` where `config-sync-cust` text is set)

**Interfaces:**
- Produces: `isCustomized(group)` returns true ONLY when Path or Type differs from default. Badge text `⚙ custom location`.

- [ ] **Step 1: Rewrite `isCustomized`** — replace the body:

```ts
private isCustomized(group: SyncGroup): boolean {
  const expected = expectedPathForName(group.name);
  const pathCustom = expected !== null && group.path !== expected;
  const def = defaultGroupForName(group.name);
  const typeCustom = def !== null && group.type !== def.type;
  return pathCustom || typeCustom;
}
```

- [ ] **Step 2: Update the badge text** — in `renderItemInto`, find the line that creates the customized badge (currently `row.nameEl.createSpan({ cls: "config-sync-cust", text: "⚙ customized" })`) and change the text to `⚙ custom location`. (Class and placement unchanged; it renders after the detect-badge holder and before the device-specific badge.)

- [ ] **Step 3: Gate**

Run: `npm run build && npm run lint 2>&1 | grep problem`
Expected: build clean; `0 errors, 65 warnings`.

Run: `npm test 2>&1 | grep Tests`
Expected: `Tests  202 passed (202)`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: narrow the custom badge to non-default storage location only"
```

---

### Task 2: Segment-header alignment — flush-left labels, trailing toggle

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderAdvancedSegment` header ~lines 529-539)
- Modify: `styles.css` (remove `.config-sync-adv-header`, `.config-sync-adv-chev`; add `.config-sync-adv-toggle`)

**Interfaces:**
- Consumes: nothing.
- Produces: the store-override segment header is a single flush-left clickable `.config-sync-explabel` reading `Custom location ▸` / `Custom location ▾`, left-aligned with the `Fields to protect` and `Data file` labels.

- [ ] **Step 1: Replace the header block** — in `renderAdvancedSegment`, swap the chevron-prefixed header (`setIcon(header.createSpan({ cls: "config-sync-adv-chev" }), …)` + separate label span) for a single toggle label:

```ts
const isOpen = this.advOpen.has(group.name);
const header = exp.createDiv({ cls: "config-sync-explabel config-sync-adv-toggle", text: isOpen ? "Custom location ▾" : "Custom location ▸" });
header.addEventListener("click", () => {
  if (isOpen) this.advOpen.delete(group.name);
  else this.advOpen.add(group.name);
  this.renderItemInto(wrap, item);
});
if (!isOpen) return;
```

(Keep the rest of the method — the `.config-sync-adv` body — for now; Task 3 rewrites the body.)

- [ ] **Step 2: Update CSS** — in `styles.css`, remove the two rules:

```css
.config-sync-adv-header { … }
.config-sync-adv-header .config-sync-explabel { … }
.config-sync-adv-chev { … }
.config-sync-adv-chev svg { … }
```

and add:

```css
.config-sync-adv-toggle { cursor: pointer; }
```

- [ ] **Step 3: Verify alignment + gate**

Run: `npm run build && ./scripts/check-no-hardcoded-color.sh && npm run lint 2>&1 | grep problem`
Expected: build clean; scan OK; `0 errors, 65 warnings`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "feat: flush-left segment headers so Fields/Data file/Custom location align"
```

---

### Task 3: Custom location segment — Location · Type · Path row + reset

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderAdvancedSegment` → `renderCustomLocationSegment`; `advOpen` → `customLocOpen`; the call site in `renderItemExpansion`)
- Modify: `styles.css` (add `.config-sync-cl-row`, `.config-sync-cl-field`, `.config-sync-cl-lbl`; adjust `.config-sync-adv` usage)

**Interfaces:**
- Consumes: `splitLocation(path) → {location, rel}`, `joinLocation(location, rel) → string`, `defaultGroupForName`, `reservedNames`, `commitGroups`.
- Produces: `renderCustomLocationSegment(exp, group, item, wrap)`; the expanded body is a single flex row of Location/Type/Path fields + a `↺ Reset to default` link (managed items only).

- [ ] **Step 1: Rename the method + state field.** Rename `renderAdvancedSegment` → `renderCustomLocationSegment` (update the call in `renderItemExpansion`). Rename the `private advOpen = new Set<string>()` field → `private customLocOpen = new Set<string>()` and every `this.advOpen` reference → `this.customLocOpen` (the header toggle in Task 2's block).

- [ ] **Step 2: Rewrite the expanded body** — replace the body after `if (!isOpen) return;` (the current `.config-sync-adv` block with Location + Path stacked) with a three-field flex row plus reset:

```ts
const adv = exp.createDiv({ cls: "config-sync-cl-row" });
const loc = splitLocation(group.path);

const locField = adv.createDiv({ cls: "config-sync-cl-field" });
locField.createSpan({ cls: "config-sync-cl-lbl", text: "Location" });
new DropdownComponent(locField)
  .addOption("config", "Config folder")
  .addOption("vault", "Vault root")
  .setValue(loc.location)
  .onChange((v) => {
    void this.commitGroups((draft) => {
      const g = draft.find((x) => x.name === group.name);
      if (g !== undefined) g.path = joinLocation(v as "config" | "vault", splitLocation(g.path).rel);
    }, group.name);
  });

const typeField = adv.createDiv({ cls: "config-sync-cl-field" });
typeField.createSpan({ cls: "config-sync-cl-lbl", text: "Type" });
new DropdownComponent(typeField)
  .addOption("file", "File")
  .addOption("dir", "Folder")
  .setValue(group.type)
  .onChange(async (v) => {
    await this.commitGroups((draft) => {
      const g = draft.find((x) => x.name === group.name);
      if (g === undefined) return;
      g.type = v as SyncGroup["type"];
      if (g.type !== "file") {
        delete g.mode;
        delete g.fields;
      }
    }, group.name);
    this.renderItemInto(wrap, item);
  });

const pathField = adv.createDiv({ cls: "config-sync-cl-field path" });
pathField.createSpan({ cls: "config-sync-cl-lbl", text: "Path" });
new TextComponent(pathField).setValue(loc.rel).onChange((v) => {
  void this.commitGroups((draft) => {
    const g = draft.find((x) => x.name === group.name);
    if (g !== undefined) g.path = joinLocation(splitLocation(g.path).location, v.trim());
  }, group.name);
});

const reserved = reservedNames(this.host.installedPluginIds());
if (reserved.has(group.name)) {
  const reset = exp.createSpan({ cls: "config-sync-link config-sync-reset-link", text: "↺ Reset to default" });
  reset.addEventListener("click", () => {
    void (async () => {
      const def = defaultGroupForName(group.name);
      if (def === null) return;
      await this.commitGroups((draft) => {
        const idx = draft.findIndex((g) => g.name === group.name);
        if (idx >= 0) draft[idx] = def;
      }, group.name);
      this.renderItemInto(wrap, item);
    })();
  });
}
```

(Note: `formField` is no longer used here — the label is a `.config-sync-cl-lbl` span above each control. If `formField` becomes unused elsewhere, leave it; it's used by the Advanced-tab custom-rule form.)

- [ ] **Step 3: CSS for the row** — in `styles.css`, replace the old `.config-sync-adv` layout rules with:

```css
.config-sync-cl-row { display: flex; gap: var(--size-4-2); align-items: flex-end; }
.config-sync-cl-field { display: flex; flex-direction: column; gap: var(--size-2-1); }
.config-sync-cl-field.path { flex: 1; min-width: 0; }
.config-sync-cl-field.path input[type="text"] { width: 100%; box-sizing: border-box; }
.config-sync-cl-lbl { font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.config-sync-reset-link { display: inline-block; margin-top: var(--size-4-2); }
```

Remove the now-unused `.config-sync-adv { … }`, `.config-sync-adv .config-sync-form-label { … }`, `.config-sync-adv input[type="text"] { … }` rules if present.

- [ ] **Step 4: Gate**

Run: `npm run build && ./scripts/check-no-hardcoded-color.sh && npm run lint 2>&1 | grep problem`
Expected: build clean; scan OK; `0 errors, 65 warnings`.

Run: `npm test 2>&1 | grep Tests`
Expected: `Tests  202 passed (202)`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "feat: Custom location segment — Location/Type/Path on one row with reset"
```

---

### Task 4: Two-theme visual verification (controller-run, no code)

**Files:** none (verification only).

Controller-run (a subagent cannot see rendered output). Dev vault already has AnuPpuccin.

- [ ] **Step 1: Deploy + reload** — `npm run smoke:install`; vault-name guard (`app.vault.getName()` must print `vault`, reopen via URI if not); reload the plugin.
- [ ] **Step 2: Default theme** — Community-plugins tab, expand BRAT (Fields mode + View data.json open + Custom location open). Confirm: the three segment titles (`Fields to protect`, `Data file`, `Custom location`) share the same left edge; Custom location shows Location/Type/Path on one row with Path filling the remaining width; `↺ Reset to default` below.
- [ ] **Step 3: Badge check** — with BRAT at default path, confirm NO `⚙ custom location` badge even though Fields mode + rules are set. Then edit the Path (or Type), confirm `⚙ custom location` appears; Reset to default, confirm it clears (path back to default, badge gone, mode/fields also reset).
- [ ] **Step 4: AnuPpuccin** — `app.customCss.setTheme('AnuPpuccin')`, reload, repeat the visual check; confirm cross-tab card consistency and that the Custom location dropdowns/input follow the theme.
- [ ] **Step 5: Restore** — `app.customCss.setTheme('')`; reset BRAT to default (clean dev vault); record result in the ledger.

---

## Self-Review Notes

- Spec coverage: Part 1 (alignment) → Task 2; Part 2 (Custom location + Type + row layout + reset) → Task 3; Part 3 (badge narrowing + rename) → Task 1. Verification protocol → Task 4.
- Type consistency: `isCustomized` (Task 1) is independent; `renderCustomLocationSegment`/`customLocOpen` (Task 3) rename what Task 2 edits (Task 2 uses `advOpen`/`renderAdvancedSegment` names still, Task 3 renames them — ordering is fine because Task 2 commits a working intermediate and Task 3 renames on top). `SyncGroup["type"]` is the existing union `"file" | "dir"`.
- Ordering rationale: badge (T1) and alignment (T2) are independent small changes; T3 is the largest (body rewrite) and depends on T2's header being in place. T4 verifies all three visually.
- No behavior change beyond badge narrowing + the new Type control; node suite unchanged at 202 (this is UI structure/CSS — the badge logic is a private method covered by smoke, per spec).
- Post-plan flow (user's explicit instruction, repeated): after all tasks + final whole-branch review + full two-theme smoke, **hand the branch to the user for pre-merge acceptance; merge + cut 0.21.0 ONLY after the user verifies.** Do not auto-merge.
