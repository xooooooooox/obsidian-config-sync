# Quick commands polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Quick commands real per-command icons, a Commander-style icon picker, custom separators, and a clean settings-row layout.

**Architecture:** A quick-list entry becomes a union `QuickEntry = QuickCommand | { kind: "separator" }`. A pure `quickMenuEntries()` (replacing `quickCommandEntries`) maps entries to normalized menu entries (separators collapsed/trimmed) and `openSyncMenu` renders each command or `menu.addSeparator()`. The settings section is rebuilt with custom rows: a clickable icon that opens an `IconSelectModal` (fuzzy over `getIconIds()`), an inline label input, reorder/delete, plus Add command / Add separator. New entries default their icon to the command's own `cmd.icon`.

**Tech Stack:** TypeScript, Obsidian plugin API (`Menu`, `FuzzySuggestModal`, `getIconIds`, `setIcon`, `Command.icon`), esbuild, vitest, eslint.

**Spec:** `docs/superpowers/specs/2026-07-22-quick-commands-polish-design.md`

## Global Constraints

- **No git commits.** Leave every change uncommitted (the user's review state). No Claude/AI attribution anywhere.
- **Icon default = the command's own icon:** new entries use `icon = cmd.icon ?? "command"`. **No CSS override** for menu icons — the theme does not hide them (verified).
- **Core stays Obsidian-free:** `src/core/types.ts` and `src/core/quickCommands.ts` import no Obsidian symbols.
- **Non-public API via guarded cast:** `app.commands` reached through `as unknown as {…}` (existing pattern).
- **Strict TS:** the repo uses `noUncheckedIndexedAccess` — guard every array-index access (`const x = arr[i]; if (x === undefined) …`).
- **Per-task verification** (repo root `~/local/coding/open/obsidian-config-sync`):
  - `npm test` — all pass.
  - `npm run build` — `tsc -noEmit` + esbuild, no errors.
  - `npm run lint` — **baseline `67 problems (0 errors, 67 warnings)`**; introduce **no new** problems.
  - `npm run smoke:install` — builds + copies to `dev/vault/…`.
- **YAGNI:** no titled separators; no Commander-style add wizard; icon picker is a fuzzy list with previews (not a grid); no data migration (legacy entries stay valid).

---

### Task 1: Entry union + `quickMenuEntries` + menu render

**Files:**
- Modify: `src/core/types.ts` (after `QuickCommand`)
- Modify: `src/core/quickCommands.ts` (replace `quickCommandEntries`)
- Modify: `tests/quickCommands.test.ts` (rewrite for `quickMenuEntries`)
- Modify: `src/main.ts` (import + `openSyncMenu` quick block)

**Interfaces:**
- Produces: `QuickSeparator`, `QuickEntry`, `isSeparator` (types.ts); `QuickMenuEntry`, `quickMenuEntries(entries: QuickEntry[], isRegistered: (id: string) => boolean): QuickMenuEntry[]` (quickCommands.ts).
- Note: `ConfigSyncSettings.quickCommands` stays `QuickCommand[]` in this task; it is assignable to the `QuickEntry[]` parameter (widened to `QuickEntry[]` in Task 3).

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `tests/quickCommands.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { quickMenuEntries } from "../src/core/quickCommands";

const reg = (ids: string[]) => (id: string): boolean => ids.includes(id);

describe("quickMenuEntries", () => {
  it("maps commands, setting disabled from registration", () => {
    const out = quickMenuEntries(
      [{ commandId: "a:x", label: "X", icon: "cloud" }, { commandId: "b:y", label: "Y", icon: "star" }],
      reg(["a:x"])
    );
    expect(out).toEqual([
      { kind: "command", commandId: "a:x", label: "X", icon: "cloud", disabled: false },
      { kind: "command", commandId: "b:y", label: "Y", icon: "star", disabled: true },
    ]);
  });

  it("keeps a separator between two commands", () => {
    const out = quickMenuEntries(
      [{ commandId: "a:x", label: "X", icon: "i" }, { kind: "separator" }, { commandId: "b:y", label: "Y", icon: "i" }],
      reg(["a:x", "b:y"])
    );
    expect(out.map((e) => e.kind)).toEqual(["command", "separator", "command"]);
  });

  it("drops leading, trailing and consecutive separators", () => {
    const out = quickMenuEntries(
      [
        { kind: "separator" },
        { commandId: "a:x", label: "X", icon: "i" },
        { kind: "separator" },
        { kind: "separator" },
        { commandId: "b:y", label: "Y", icon: "i" },
        { kind: "separator" },
      ],
      reg(["a:x", "b:y"])
    );
    expect(out.map((e) => e.kind)).toEqual(["command", "separator", "command"]);
  });

  it("returns [] when there is no command", () => {
    expect(quickMenuEntries([{ kind: "separator" }], reg([]))).toEqual([]);
    expect(quickMenuEntries([], reg([]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- quickCommands`
Expected: FAIL — `quickMenuEntries` is not exported yet.

- [ ] **Step 3: Add the union types**

In `src/core/types.ts`, replace the `QuickCommand` interface block (currently the last lines) with:

```ts
// A user-added command surfaced in the Config Sync ribbon menu (see core/quickCommands.ts).
export interface QuickCommand {
  commandId: string; // e.g. "remotely-save:start-sync"; run via app.commands.executeCommandById
  label: string;     // menu title; defaults to the command's name at add-time, editable
  icon: string;      // lucide id; defaults to the command's own icon; editable via the icon picker
}

// A divider inserted between quick commands in the ribbon menu.
export interface QuickSeparator {
  kind: "separator";
}

export type QuickEntry = QuickCommand | QuickSeparator;

export function isSeparator(e: QuickEntry): e is QuickSeparator {
  return (e as QuickSeparator).kind === "separator";
}
```

- [ ] **Step 4: Replace the pure builder**

Replace the entire contents of `src/core/quickCommands.ts` with:

```ts
import { QuickEntry, isSeparator } from "./types";

export type QuickMenuEntry =
  | { kind: "separator" }
  | { kind: "command"; commandId: string; label: string; icon: string; disabled: boolean };

// Maps configured quick entries to ribbon-menu entries: commands carry a `disabled` flag when not
// registered on this device; separators are normalized (no leading/trailing/consecutive dividers,
// and the whole list collapses to [] when it holds no command). Obsidian-free.
export function quickMenuEntries(
  entries: QuickEntry[],
  isRegistered: (commandId: string) => boolean
): QuickMenuEntry[] {
  const mapped: QuickMenuEntry[] = entries.map((e) =>
    isSeparator(e)
      ? { kind: "separator" }
      : { kind: "command", commandId: e.commandId, label: e.label, icon: e.icon, disabled: !isRegistered(e.commandId) }
  );
  const out: QuickMenuEntry[] = [];
  for (const e of mapped) {
    if (e.kind === "separator") {
      const last = out[out.length - 1];
      if (last === undefined) continue; // no leading separator
      if (last.kind === "separator") continue; // collapse consecutive
    }
    out.push(e);
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === undefined || last.kind !== "separator") break;
    out.pop(); // no trailing separator
  }
  return out.some((e) => e.kind === "command") ? out : [];
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- quickCommands`
Expected: PASS (4 tests).

- [ ] **Step 6: Update the menu render**

In `src/main.ts`:

1. Change the import from `./core/quickCommands`:
   ```ts
   import { quickMenuEntries } from "./core/quickCommands";
   ```
2. In `openSyncMenu`, replace the existing quick-commands block (from `const quick = quickCommandEntries(...)` through its closing `}`) with:

```ts
    const quick = quickMenuEntries(this.settings.quickCommands, (id) => id in commands.commands);
    if (quick.length > 0) {
      menu.addSeparator();
      for (const e of quick) {
        if (e.kind === "separator") {
          menu.addSeparator();
          continue;
        }
        menu.addItem((i) => {
          i.setTitle(e.label);
          if (e.icon) i.setIcon(e.icon);
          if (e.disabled) i.setDisabled(true);
          else i.onClick(() => commands.executeCommandById(e.commandId));
        });
      }
    }
```

The `const commands = (this.app as unknown as {…}).commands;` line just above stays unchanged.

- [ ] **Step 7: Verify build, tests, lint**

Run: `npm test && npm run build && npm run lint`
Expected: tests pass; build clean; lint `67 problems (0 errors)` — no new problems.

---

### Task 2: Icon picker modal

**Files:**
- Create: `src/ui/IconSelectModal.ts`

**Interfaces:**
- Produces: `class IconSelectModal extends FuzzySuggestModal<string>` with constructor `(app: App, onChoose: (icon: string) => void)`.

No unit test (Obsidian-DOM modal, like `CommandSelectModal`/`FolderSelectModal`). Verified by build + use in Task 3.

- [ ] **Step 1: Create the modal**

Create `src/ui/IconSelectModal.ts`:

```ts
import { App, FuzzyMatch, FuzzySuggestModal, getIconIds, setIcon } from "obsidian";

// Searchable icon picker (Commander-style) — fuzzy over every registered icon id, each suggestion
// rendered with a live preview. Mirrors FolderSelectModal/CommandSelectModal's shape.
export class IconSelectModal extends FuzzySuggestModal<string> {
  constructor(app: App, private onChoose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Pick an icon");
  }
  getItems(): string[] {
    return getIconIds();
  }
  getItemText(id: string): string {
    return id;
  }
  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("config-sync-iconpick");
    setIcon(el.createSpan({ cls: "config-sync-iconpick-glyph" }), match.item);
    el.createSpan({ text: match.item });
  }
  onChooseItem(id: string): void {
    this.onChoose(id);
  }
}
```

- [ ] **Step 2: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: build clean; lint unchanged (67). (The class is unused until Task 3 — that is fine; it is exported and referenced next.)

---

### Task 3: Widen settings + rebuild the Quick commands section + CSS

**Files:**
- Modify: `src/main.ts` (`ConfigSyncSettings.quickCommands` type + import)
- Modify: `src/ui/SettingTab.ts` (`SettingsHost.settings.quickCommands` type, imports, `renderQuickCommands`)
- Modify: `styles.css` (replace the `.config-sync-qc-*` block)

**Interfaces:**
- Consumes: `QuickEntry`, `isSeparator` (Task 1); `IconSelectModal` (Task 2); `CommandSelectModal` (existing); `Command.icon` (Obsidian).

No unit test (DOM section). Verified by build + lint + manual (Step 6).

- [ ] **Step 1: Widen the settings types**

In `src/main.ts`:
1. Import: replace `QuickCommand` with `QuickEntry` in the `./core/types` import (drop `QuickCommand` if it is otherwise unused in the file — it is only used by the settings interface).
2. In `interface ConfigSyncSettings`, change `quickCommands: QuickCommand[];` to:
   ```ts
   quickCommands: QuickEntry[]; // commands + separators surfaced in the ribbon menu; synced (not device-local)
   ```
   `DEFAULT_SETTINGS.quickCommands: []` is unchanged.

In `src/ui/SettingTab.ts`:
3. Add `QuickEntry`, `isSeparator` to the `../core/types` import (replace `QuickCommand` if present and otherwise unused).
4. Add the modal import:
   ```ts
   import { IconSelectModal } from "./IconSelectModal";
   ```
5. In `SettingsHost.settings`, change `quickCommands: QuickCommand[];` to `quickCommands: QuickEntry[];`.

- [ ] **Step 2: Replace `renderQuickCommands`**

Replace the entire `renderQuickCommands` method in `src/ui/SettingTab.ts` with:

```ts
  private renderQuickCommands(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-quick-commands");
    this.anchor(
      new Setting(containerEl).setName(def.name).setDesc(def.desc).setHeading(),
      "general-quick-commands"
    );
    const registry = (this.host.app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
    const list = this.host.settings.quickCommands;
    const listEl = containerEl.createDiv({ cls: "config-sync-qc-list" });

    const persist = (): void => {
      void (async () => {
        await this.host.saveSettings();
        void this.rerender(this.containerEl.scrollTop);
      })();
    };
    const move = (idx: number, delta: number): void => {
      const a = list[idx];
      const b = list[idx + delta];
      if (a === undefined || b === undefined) return;
      list[idx + delta] = a;
      list[idx] = b;
      persist();
    };
    const reorderButtons = (row: HTMLElement, idx: number): void => {
      const btns = row.createDiv({ cls: "config-sync-qc-btns" });
      new ExtraButtonComponent(btns).setIcon("chevron-up").setTooltip("Move up").setDisabled(idx === 0).onClick(() => move(idx, -1));
      new ExtraButtonComponent(btns).setIcon("chevron-down").setTooltip("Move down").setDisabled(idx === list.length - 1).onClick(() => move(idx, 1));
      new ExtraButtonComponent(btns).setIcon("trash").setTooltip("Remove").onClick(() => {
        list.splice(idx, 1);
        persist();
      });
    };

    list.forEach((entry, idx) => {
      if (isSeparator(entry)) {
        const row = listEl.createDiv({ cls: "config-sync-qc-seprow" });
        row.createDiv({ cls: "config-sync-qc-sepline" });
        row.createSpan({ cls: "config-sync-qc-septxt", text: "Separator" });
        row.createDiv({ cls: "config-sync-qc-sepline" });
        reorderButtons(row, idx);
        return;
      }
      const missing = !(entry.commandId in registry);
      const row = listEl.createDiv({ cls: "config-sync-qc-row" });
      if (missing) row.addClass("is-missing");
      const iconBtn = row.createEl("button", { cls: "config-sync-qc-icon", attr: { "aria-label": "Change icon" } });
      const paint = (id: string): void => {
        iconBtn.empty();
        setIcon(iconBtn, id);
        if (iconBtn.childElementCount === 0) setIcon(iconBtn, "command");
      };
      paint(entry.icon);
      iconBtn.onclick = (): void => {
        new IconSelectModal(this.host.app, (icon) => {
          entry.icon = icon;
          paint(icon);
          void this.host.saveSettings();
        }).open();
      };
      const meta = row.createDiv({ cls: "config-sync-qc-meta" });
      const input = meta.createEl("input", { cls: "config-sync-qc-label", attr: { type: "text", placeholder: "Label" } });
      input.value = entry.label;
      // Inline edit, no rerender, so the input keeps focus while typing.
      input.addEventListener("input", () => {
        entry.label = input.value.trim() || entry.commandId;
        void this.host.saveSettings();
      });
      meta.createDiv({ cls: "config-sync-qc-cid", text: entry.commandId + (missing ? " — not on this device" : "") });
      reorderButtons(row, idx);
    });

    const addbar = containerEl.createDiv({ cls: "config-sync-qc-addbar" });
    new ButtonComponent(addbar).setButtonText("Add command").setCta().onClick(() => {
      new CommandSelectModal(this.host.app, (cmd) => {
        list.push({ commandId: cmd.id, label: cmd.name, icon: cmd.icon ?? "command" });
        persist();
      }).open();
    });
    new ButtonComponent(addbar).setButtonText("Add separator").onClick(() => {
      list.push({ kind: "separator" });
      persist();
    });
  }
```

`ButtonComponent` and `ExtraButtonComponent` are already imported at the top of `SettingTab.ts`.

- [ ] **Step 3: Replace the CSS**

In `styles.css`, replace the three existing `.config-sync-qc-*` lines with:

```css
/* Quick commands settings */
.config-sync-qc-list { display: flex; flex-direction: column; gap: 7px; margin-bottom: 8px; }
.config-sync-qc-row { display: flex; align-items: center; gap: 11px; padding: 9px 11px;
  background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; }
.config-sync-qc-row.is-missing { opacity: 0.55; }
.config-sync-qc-icon { flex: none; width: 32px; height: 32px; display: flex; align-items: center;
  justify-content: center; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); border-radius: 7px; cursor: pointer; }
.config-sync-qc-meta { flex: 1; min-width: 0; }
.config-sync-qc-label { width: 100%; }
.config-sync-qc-cid { font-size: var(--font-ui-smaller); color: var(--text-faint);
  font-family: var(--font-monospace); margin-top: 3px; }
.config-sync-qc-btns { flex: none; display: flex; gap: 2px; }
.config-sync-qc-seprow { display: flex; align-items: center; gap: 10px; padding: 6px 11px;
  border: 1px dashed var(--background-modifier-border); border-radius: 8px; }
.config-sync-qc-sepline { flex: 1; height: 1px; background: var(--background-modifier-border); }
.config-sync-qc-septxt { font-size: var(--font-ui-smaller); text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--text-faint); }
.config-sync-qc-addbar { display: flex; gap: 8px; }
.config-sync-iconpick { display: flex; align-items: center; gap: 10px; }
.config-sync-iconpick-glyph { display: inline-flex; align-items: center; }
```

- [ ] **Step 4: Verify build, tests, lint**

Run: `npm test && npm run build && npm run lint`
Expected: all pass; lint unchanged (67, 0 errors).

- [ ] **Step 5: Install to dev vault**

Run: `npm run smoke:install`
Expected: build + copy succeed.

- [ ] **Step 6: Manual check (dev vault)**

Reload the dev vault. Settings → Config Sync → General → **Quick commands**:
- **Add command** → pick one → row shows the command's own icon (not generic ⌘) and the id underneath; the label input is full-width, not truncated.
- Click the row's icon → the icon picker opens with search + rendered previews; pick one → the row icon updates.
- **Add separator** → a dashed "Separator" row appears; reorder it between commands.
- Reorder/delete both command and separator rows.
- Open the Config Sync ribbon menu → commands show real icons; a separator between commands renders as a divider; no stray leading/trailing dividers.

---

### Task 4: Documentation currency

**Files:**
- Modify: `README.md` (the Quick commands sentence added in 1.4.0, `:70`)
- Modify: `README.zh.md` (`:70`)
- Modify: `docs/design/DESIGN.md` (icon-inventory line, `:90-95`)

Docs ship with the change (repo docs-currency rule). Match on surrounding text, not line numbers.

- [ ] **Step 1: README.md**

Find the sentence ending "…The list is synced across your devices with the rest of Config Sync's settings." Append to that same paragraph:

```markdown
 Each entry takes the command's own icon by default (change it from a searchable icon picker), and you can drop in **separators** to group them.
```

- [ ] **Step 2: README.zh.md**

Find the mirror sentence ending "…这份列表会随 Config Sync 的其余设置一起跨设备同步。" Append:

```markdown
 每一项默认采用命令自带的图标(也可从可搜索的图标选择器里更换),还能插入**分隔线**给它们分组。
```

- [ ] **Step 3: DESIGN.md**

Find the icon-inventory line that ends "…`command` default icon for user-added quick-command menu items (user-overridable)." Replace the trailing note with:

```markdown
· quick-command menu items take the command's own icon by default, changeable via the `getIconIds()` icon picker (`IconSelectModal`).
```

- [ ] **Step 4: Verify**

Re-read each edited passage in context for grammar/tone. Run `npm run build` once to confirm the whole change set still compiles.

---

## Self-Review

**Spec coverage:**
- Item 1+2 (real icons, default to `cmd.icon`) → Task 3 Step 2 (`cmd.icon ?? "command"`) + Task 1 menu render (existing `setIcon`). No CSS override (Global Constraints).
- Item 3 (row style + icon picker) → Task 2 (`IconSelectModal`) + Task 3 (custom rows + CSS).
- Item 4 (separators) → Task 1 (union + `quickMenuEntries` normalization + menu `addSeparator`) + Task 3 (Add separator + separator rows).
- Add flow lightweight → Task 3 (add with defaults, inline edit).
- No data migration; legacy entries valid → union discriminates by `isSeparator`; `QuickCommand[]` assignable to `QuickEntry[]` (Task 1 note).
- Docs currency → Task 4.

**Placeholder scan:** none — every code step carries full code; every command has expected output.

**Type consistency:** `QuickEntry`/`QuickSeparator`/`isSeparator` defined in Task 1 and consumed in Tasks 1/3; `quickMenuEntries(entries, isRegistered)` signature matches its `openSyncMenu` call site; `QuickMenuEntry` union (`kind: "separator" | "command"`) matches the render branch; `IconSelectModal(app, onChoose)` constructor matches Task 3 usage; settings widened to `QuickEntry[]` in both `ConfigSyncSettings` and `SettingsHost` (Task 3 Step 1); array indexing guarded for `noUncheckedIndexedAccess` (`move`, `quickMenuEntries`).

**Build-green ordering:** Task 1 keeps `quickCommands: QuickCommand[]` (assignable to the `QuickEntry[]` param); Task 3 widens the type and rebuilds `renderQuickCommands` together, so no intermediate task leaves a broken build.
