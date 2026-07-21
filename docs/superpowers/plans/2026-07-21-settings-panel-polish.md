# Settings-Panel Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small item-settings-panel fixes: drop the redundant remove-X on preset (locked) field rules, render the preset lock as a Lucide icon instead of an emoji, and hide the meaningless "View data.json" link for folder-type items.

**Architecture:** All changes are rendering conditionals/swaps in `src/ui/SettingTab.ts` plus a little CSS. No new logic, no host-interface change — verification is live.

**Tech Stack:** TypeScript, Obsidian API (`setIcon`, `ExtraButtonComponent`), plain CSS (theme vars).

## Global Constraints

- Gates before "done": `npx tsc -noEmit -skipLibCheck` clean · `npm test` green · `npx eslint .` **0 errors / 67 warnings** · `./scripts/check-no-hardcoded-color.sh` OK · `npm run build` clean.
- CSS: theme vars only — `var(--…)` / `rgba(var(--…-rgb), α)`; no hex/rgb literals.
- Icons: Lucide via `setIcon` — no emoji (DESIGN.md §148).
- No host-interface additions; entirely view-local to `SettingTab.ts` + CSS.
- `setIcon` is already imported in `SettingTab.ts:1`.
- Commit messages: conventional, **no Claude/AI attribution**.

---

### Task 1: Preset field-rule row — no remove-X, Lucide lock

**Files:**
- Modify: `src/ui/SettingTab.ts` — `renderFieldsEditor` lock rendering (`:1050-1054`) and X-button rendering (`:1088-1104`).
- Modify: `styles.css` — add `.config-sync-flock` (size the lock svg) and `.config-sync-fieldrow-xspacer` (alignment placeholder), near `.config-sync-fkey` (`:764`).

**Interfaces:**
- Consumes: `rule.locked` (`boolean | undefined` on `FieldRule`), `setIcon` (imported), `ExtraButtonComponent` (imported), `this.commitGroups`, `afterChange`.
- Produces: nothing downstream.

- [ ] **Step 1: Swap the lock emoji for a Lucide icon**

In `src/ui/SettingTab.ts`, replace the lock block (`:1050-1054`):

```ts
      if (rule.locked === true) {
        const lock = fr.createSpan({ cls: "config-sync-flock", text: "🔒" });
        lock.setAttribute("title", "Preset rule — cannot be removed");
        lock.setAttribute("aria-label", "Preset rule — cannot be removed");
      }
```

with:

```ts
      if (rule.locked === true) {
        const lock = fr.createSpan({ cls: "config-sync-flock", attr: { "aria-label": "Preset rule — cannot be removed" } });
        setIcon(lock, "lock");
        lock.setAttribute("title", "Preset rule — cannot be removed");
      }
```

- [ ] **Step 2: Remove the X for locked rules, keep alignment**

Replace the X-button block (`:1088-1104`):

```ts
      new ExtraButtonComponent(fr)
        .setIcon("x")
        .setTooltip(rule.locked === true ? "Preset rule — cannot be removed" : "Remove rule")
        .setDisabled(rule.locked === true)
        .onClick(() => {
          if (rule.locked === true) return;
          void (async () => {
            const ruleIndex = rules.indexOf(rule);
            await this.commitGroups((draft) => {
              const g = draft.find((x) => x.name === group.name);
              if (g === undefined || g.fields === undefined) return;
              g.fields = g.fields.filter((_, i) => i !== ruleIndex);
              if (g.fields.length === 0) delete g.fields;
            }, group.name);
            afterChange();
          })();
        });
```

with:

```ts
      if (rule.locked === true) {
        fr.createSpan({ cls: "config-sync-fieldrow-xspacer" }); // keep Strip/Encrypt aligned with unlocked rows
      } else {
        new ExtraButtonComponent(fr)
          .setIcon("x")
          .setTooltip("Remove rule")
          .onClick(() => {
            void (async () => {
              const ruleIndex = rules.indexOf(rule);
              await this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === group.name);
                if (g === undefined || g.fields === undefined) return;
                g.fields = g.fields.filter((_, i) => i !== ruleIndex);
                if (g.fields.length === 0) delete g.fields;
              }, group.name);
              afterChange();
            })();
          });
      }
```

- [ ] **Step 3: Add CSS**

In `styles.css`, after the `.config-sync-fkey` rule (`:764`), add:

```css
.config-sync-flock { display: inline-flex; align-items: center; color: var(--text-muted); flex: none; }
.config-sync-flock svg { width: 13px; height: 13px; }
.config-sync-fieldrow-xspacer { width: var(--size-4-6); flex: none; }
```

- [ ] **Step 4: Run the gates**

```bash
cd ~/local/coding/open/obsidian-config-sync
npx tsc -noEmit -skipLibCheck            # clean
npm test                                  # green
npx eslint .                              # 0 errors / 67 warnings
./scripts/check-no-hardcoded-color.sh     # OK
npm run build                             # exit 0
```

- [ ] **Step 5: Live-verify**

Open Settings → Config Sync → the Appearance item (Fields mode) → expand "Fields to protect":
- The `enabledCssSnippets` (locked) row shows a Lucide lock svg (not the 🔒 emoji) and **no** X button.
- Add a temporary manual key (e.g. `*Token*` via the Add row) → its row shows a working X that removes it; the `Strip`/`Encrypt` buttons on the locked row line up with the manual row's. Remove the temporary key.

- [ ] **Step 6: Commit**

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/ui/SettingTab.ts styles.css
git commit -m "feat(ui): preset field-rule row — drop redundant X, Lucide lock"
```

---

### Task 2: Hide "View data.json" for folder-type items

**Files:**
- Modify: `src/ui/SettingTab.ts` — `renderItemExpansion` (`:589`).

**Interfaces:**
- Consumes: `group.type` (`"file" | "dir"` on `SyncGroup`), `this.renderDataFileSegment(exp, group, item, wrap)`.
- Produces: nothing downstream.

- [ ] **Step 1: Gate the data-file segment on file type**

In `src/ui/SettingTab.ts`, replace the unconditional call (`:589`):

```ts
    this.renderDataFileSegment(exp, group, item, wrap);
```

with:

```ts
    if (group.type === "file") this.renderDataFileSegment(exp, group, item, wrap);
```

(`renderCustomLocationSegment` on the next line stays unconditional — the user needs it to change Location/Path/Type, including switching a folder item back to file.)

- [ ] **Step 2: Run the gates**

```bash
cd ~/local/coding/open/obsidian-config-sync
npx tsc -noEmit -skipLibCheck            # clean
npm test                                  # green
npx eslint .                              # 0 errors / 67 warnings
./scripts/check-no-hardcoded-color.sh     # OK
npm run build                             # exit 0
```

- [ ] **Step 3: Live-verify**

Open Settings → Config Sync → the CSS snippets item (Type = Folder) → expand it:
- No "Data file · View data.json" line; "Custom location" still shows.
- Expand Custom location, switch Type → File: the "View data.json" line reappears; switch back to Folder: it disappears again.
- A file-type Fields-mode item (e.g. Appearance) still shows "View data.json" and it opens the JSON preview as before.

- [ ] **Step 4: Commit**

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/ui/SettingTab.ts
git commit -m "feat(ui): hide View data.json for folder-type items"
```

---

## Self-Review

- **Spec coverage:** §1 no-X for locked + alignment spacer (Task 1 §2/§3) ✅; §2 Lucide lock (Task 1 §1/§3) ✅; §3 folder data-file gate (Task 2 §1) ✅; non-goals respected (locked action still fixed, custom-location unchanged, switch-list groups already bypass — untouched) ✅.
- **Placeholders:** none — full before/after code in each step.
- **Type consistency:** `rule.locked === true` guard matches existing usage; `group.type === "file"` matches the type dropdown values (`"file"`/`"dir"`, `:888-889`); onClick body preserves the original `delete g.fields` when empty.
