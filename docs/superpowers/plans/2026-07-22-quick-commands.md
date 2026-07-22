# Quick commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user append arbitrary Obsidian commands to the Config Sync ribbon menu, device-aware and synced across devices.

**Architecture:** A new `settings.quickCommands: QuickCommand[]` is rendered under the existing `openSyncMenu` (after *Sync…* / *Revert*), each item running `executeCommandById`, greyed out when its command is not registered on this device. A pure `core/quickCommands.ts` carries the grey-out logic (unit-tested); a `CommandSelectModal` (`FuzzySuggestModal<Command>`) and a **Quick commands** settings section manage the list. The list lives in the plugin's `data.json`, so Config Sync's self-sync carries it to every device.

**Tech Stack:** TypeScript, Obsidian plugin API (`Menu`, `FuzzySuggestModal`, `setIcon`, `app.commands`), esbuild, vitest, eslint.

**Spec:** `docs/superpowers/specs/2026-07-22-quick-commands-design.md`

## Global Constraints

- **No git commits.** Leave every change uncommitted — it is the user's review state; they fold it into their own commit. No Claude/AI attribution anywhere.
- **Naming/copy, verbatim:** settings section name `Quick commands`; its description `Commands added to the Config Sync ribbon menu. A command not installed on this device is greyed out.`
- **Defaults, verbatim:** a new entry's `label` defaults to the picked command's `name`; `icon` defaults to the lucide id `command`.
- **Core stays Obsidian-free:** `src/core/quickCommands.ts` and `src/core/types.ts` import no Obsidian symbols (core invariant, `docs/ARCHITECTURE.md` "Pure core").
- **Non-public API access:** `app.commands` / `app.plugins` are not in Obsidian's public typings — reach them through the guarded `as unknown as {…}` cast, the same pattern `main.ts:641-643` uses for `app.plugins`.
- **Per-task verification commands** (run from repo root `~/local/coding/open/obsidian-config-sync`):
  - `npm test` — vitest; all pass.
  - `npm run build` — `tsc -noEmit` + esbuild; no type errors.
  - `npm run lint` — eslint; **baseline is 67 problems (0 errors, 67 warnings)**; introduce **no new** problems.
  - `npm run smoke:install` — builds and copies `main.js`/`manifest.json`/`styles.css` into `dev/vault/.obsidian/plugins/config-sync/` for manual checks.
- **YAGNI (do not build):** no per-command ribbon icon; no per-device list; no full icon picker; no removal of remotely-save's icon; no status badges on quick-command entries.

---

### Task 1: Data model + tested grey-out logic + persisted setting

**Files:**
- Modify: `src/core/types.ts` (append after `RibbonButtons`, `:58-59`)
- Create: `src/core/quickCommands.ts`
- Create: `tests/quickCommands.test.ts`
- Modify: `src/main.ts` (settings interface `:47-60`, `DEFAULT_SETTINGS` `:69-82`, imports `:40`)
- Modify: `src/ui/SettingTab.ts` (`SettingsHost.settings` block `:36-47`)

**Interfaces:**
- Produces: `interface QuickCommand { commandId: string; label: string; icon: string }` (in `core/types.ts`).
- Produces: `interface QuickCommandEntry { commandId: string; label: string; icon: string; disabled: boolean }` and `function quickCommandEntries(list: QuickCommand[], isRegistered: (commandId: string) => boolean): QuickCommandEntry[]` (in `core/quickCommands.ts`).
- Produces: `settings.quickCommands: QuickCommand[]`, defaulting to `[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/quickCommands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { quickCommandEntries } from "../src/core/quickCommands";

const list = [
  { commandId: "remotely-save:start-sync", label: "Remotely Save", icon: "command" },
  { commandId: "ghost:missing", label: "Ghost", icon: "zap" },
];

describe("quickCommandEntries", () => {
  it("disables unregistered commands, keeps registered ones enabled", () => {
    const entries = quickCommandEntries(list, (id) => id === "remotely-save:start-sync");
    expect(entries).toEqual([
      { commandId: "remotely-save:start-sync", label: "Remotely Save", icon: "command", disabled: false },
      { commandId: "ghost:missing", label: "Ghost", icon: "zap", disabled: true },
    ]);
  });

  it("preserves order", () => {
    const ids = quickCommandEntries(list, () => true).map((e) => e.commandId);
    expect(ids).toEqual(["remotely-save:start-sync", "ghost:missing"]);
  });

  it("returns [] for an empty list", () => {
    expect(quickCommandEntries([], () => true)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- quickCommands`
Expected: FAIL — cannot resolve `../src/core/quickCommands` (module does not exist yet).

- [ ] **Step 3: Add the `QuickCommand` type**

In `src/core/types.ts`, append after the `RibbonButtons` line (`:59`):

```ts
// A user-added command surfaced in the Config Sync ribbon menu (see core/quickCommands.ts).
export interface QuickCommand {
  commandId: string; // e.g. "remotely-save:start-sync"; run via app.commands.executeCommandById
  label: string;     // menu title; defaults to the command's name at add-time, editable
  icon: string;      // lucide id; defaults to "command"; setIcon falls back when unknown
}
```

- [ ] **Step 4: Write the pure logic**

Create `src/core/quickCommands.ts`:

```ts
import { QuickCommand } from "./types";

export interface QuickCommandEntry {
  commandId: string;
  label: string;
  icon: string;
  disabled: boolean; // command not registered on this device
}

// Maps configured quick commands to menu entries, marking any command that is not currently
// registered as disabled. `isRegistered` wraps app.commands so this stays Obsidian-free.
export function quickCommandEntries(
  list: QuickCommand[],
  isRegistered: (commandId: string) => boolean
): QuickCommandEntry[] {
  return list.map((qc) => ({
    commandId: qc.commandId,
    label: qc.label,
    icon: qc.icon,
    disabled: !isRegistered(qc.commandId),
  }));
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- quickCommands`
Expected: PASS (3 tests).

- [ ] **Step 6: Persist the setting**

In `src/main.ts`:

1. Extend the type import at `:40` to include `QuickCommand`:
   ```ts
   import { GroupResult, QuickCommand, Remote, RibbonButtons, StoreLock, SyncGroup } from "./core/types";
   ```
2. Add the field to `interface ConfigSyncSettings` (after `groups: SyncGroup[];`, `:55`):
   ```ts
   quickCommands: QuickCommand[]; // commands surfaced in the ribbon menu; synced (not device-local)
   ```
3. Add the default to `DEFAULT_SETTINGS` (after `groups: [],`, `:77`):
   ```ts
   quickCommands: [],
   ```

`loadSettings` (`:1263`) already does `Object.assign({}, DEFAULT_SETTINGS, loaded)`, so legacy `data.json` without the key falls back to `[]` — no undefined access.

- [ ] **Step 7: Expose it on the settings host**

In `src/ui/SettingTab.ts`, add to the `SettingsHost.settings` object type (after `remotes: Remote[];`, `:39`):

```ts
    quickCommands: QuickCommand[];
```

Add `QuickCommand` to this file's `../core/types` import (top of file). Verify `QuickCommand` is imported wherever `RibbonKey`/`Remote` are imported from `../core/types`.

- [ ] **Step 8: Verify build, tests, lint**

Run: `npm test && npm run build && npm run lint`
Expected: tests all pass; build clean; lint still `67 problems (0 errors)` — no new problems.

---

### Task 2: Render quick commands into the ribbon menu

**Files:**
- Modify: `src/main.ts` (`openSyncMenu` `:323-337`, imports `:40`-ish)

**Interfaces:**
- Consumes: `quickCommandEntries` from `./core/quickCommands`; `settings.quickCommands` (Task 1).

This task has no new unit test: `openSyncMenu` builds an Obsidian `Menu` imperatively and `Menu` is not in `tests/mock-obsidian.ts`. The grey-out decision it relies on is already covered by Task 1's unit tests. Verification is build + manual, below.

- [ ] **Step 1: Import the builder**

In `src/main.ts`, add near the other `./core/...` imports:

```ts
import { quickCommandEntries } from "./core/quickCommands";
```

- [ ] **Step 2: Append the entries in `openSyncMenu`**

In `openSyncMenu` (`:323-337`), immediately after the existing *Revert last apply* line (`:335`) and before `menu.showAtMouseEvent(evt);`:

```ts
    const commands = (this.app as unknown as {
      commands: { commands: Record<string, unknown>; executeCommandById: (id: string) => void };
    }).commands;
    const quick = quickCommandEntries(this.settings.quickCommands, (id) => id in commands.commands);
    if (quick.length > 0) {
      menu.addSeparator();
      for (const e of quick) {
        menu.addItem((i) => {
          i.setTitle(e.label);
          if (e.icon) i.setIcon(e.icon);
          if (e.disabled) i.setDisabled(true);
          else i.onClick(() => commands.executeCommandById(e.commandId));
        });
      }
    }
```

Empty list → no separator, menu unchanged from today.

- [ ] **Step 3: Verify build, tests, lint**

Run: `npm test && npm run build && npm run lint`
Expected: all pass; lint unchanged (67, 0 errors).

- [ ] **Step 4: Manual check (seed a command by hand)**

Run: `npm run smoke:install`
Then in `dev/vault/.obsidian/plugins/config-sync/data.json`, add (merging into the existing JSON object):

```json
"quickCommands": [
  { "commandId": "remotely-save:start-sync", "label": "Remotely Save", "icon": "command" },
  { "commandId": "does-not:exist", "label": "Ghost", "icon": "zap" }
]
```

Reload the dev vault (Ctrl/Cmd-R). Click the Config Sync ribbon icon.
Expected: menu shows *Sync…* / *Revert last apply*, a separator, then **Remotely Save** (clickable → triggers remotely-save's sync) and **Ghost** (greyed / disabled, does nothing). Remove the seeded lines from `data.json` afterward (Task 3 adds the real UI).

---

### Task 3: Command picker modal + Quick commands settings section

**Files:**
- Create: `src/ui/CommandSelectModal.ts`
- Modify: `src/ui/SettingTab.ts` (`GENERAL_SETTINGS` registry `:149-153`, `renderActiveTab` general case `:349`, new `renderQuickCommands` method beside `renderRibbonToggles` `:1450`)
- Modify: `styles.css` (append near other `.config-sync-*` settings rules)

**Interfaces:**
- Consumes: `settings.quickCommands` (Task 1); `this.host.saveSettings()`, `this.rerender(scrollTop)` (`:261`), `this.anchor(setting, id)` (`:1302`), `this.generalSetting(id)` (`:1307`), all existing on the tab.
- Consumes: `CommandSelectModal` (created here).

No new unit test: both pieces are Obsidian-DOM (modal + `Setting` rows), which this repo verifies manually, not in vitest. Verification is build + manual end-to-end, below.

- [ ] **Step 1: Create the command picker modal**

Create `src/ui/CommandSelectModal.ts`:

```ts
import { App, Command, FuzzySuggestModal } from "obsidian";

// Fuzzy-search over every registered command; used by the Quick commands settings section to
// add an entry. Mirrors FolderSelectModal's shape.
export class CommandSelectModal extends FuzzySuggestModal<Command> {
  constructor(app: App, private onChoose: (cmd: Command) => void) {
    super(app);
    this.setPlaceholder("Pick a command to add");
  }
  getItems(): Command[] {
    const registry = (this.app as unknown as { commands: { commands: Record<string, Command> } }).commands;
    return Object.values(registry.commands);
  }
  getItemText(cmd: Command): string {
    return cmd.name;
  }
  onChooseItem(cmd: Command): void {
    this.onChoose(cmd);
  }
}
```

- [ ] **Step 2: Register the section name/desc for settings search**

In `src/ui/SettingTab.ts`, add to the `GENERAL_SETTINGS` array immediately after the `Ribbon buttons` entry (`:149-153`):

```ts
  {
    name: "Quick commands",
    desc: "Commands added to the Config Sync ribbon menu. A command not installed on this device is greyed out.",
    anchorId: "general-quick-commands",
  },
```

- [ ] **Step 3: Import the modal**

At the top of `src/ui/SettingTab.ts`, add:

```ts
import { CommandSelectModal } from "./CommandSelectModal";
```

- [ ] **Step 4: Add the `renderQuickCommands` method**

In `src/ui/SettingTab.ts`, add this method right after `renderRibbonToggles` (ends `:1473`):

```ts
  private renderQuickCommands(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-quick-commands");
    this.anchor(
      new Setting(containerEl).setName(def.name).setDesc(def.desc).setHeading(),
      "general-quick-commands"
    );
    const registry = (this.host.app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
    const list = this.host.settings.quickCommands;
    list.forEach((qc, idx) => {
      const missing = !(qc.commandId in registry);
      const s = new Setting(containerEl).setDesc(qc.commandId + (missing ? " — not on this device" : ""));
      s.settingEl.addClass("config-sync-qc-row");
      if (missing) s.settingEl.addClass("is-missing");
      const ico = s.nameEl.createSpan({ cls: "config-sync-qc-icon" });
      const paintIcon = (id: string): void => {
        ico.empty();
        setIcon(ico, id);
        if (ico.childElementCount === 0) setIcon(ico, "command");
      };
      paintIcon(qc.icon);
      s.nameEl.prepend(ico);
      // Label + icon edit in place (no rerender) so the text field keeps focus while typing.
      s.addText((t) =>
        t.setPlaceholder("Label").setValue(qc.label).onChange(async (v) => {
          qc.label = v.trim() || qc.commandId;
          await this.host.saveSettings();
        })
      );
      s.addText((t) => {
        t.setPlaceholder("icon").setValue(qc.icon).onChange(async (v) => {
          qc.icon = v.trim() || "command";
          paintIcon(qc.icon);
          await this.host.saveSettings();
        });
        t.inputEl.addClass("config-sync-qc-iconinput");
      });
      // Reorder / delete rerender the tab (order change is structural).
      s.addExtraButton((b) =>
        b.setIcon("chevron-up").setTooltip("Move up").setDisabled(idx === 0).onClick(async () => {
          [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
          await this.host.saveSettings();
          void this.rerender(this.containerEl.scrollTop);
        })
      );
      s.addExtraButton((b) =>
        b.setIcon("chevron-down").setTooltip("Move down").setDisabled(idx === list.length - 1).onClick(async () => {
          [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
          await this.host.saveSettings();
          void this.rerender(this.containerEl.scrollTop);
        })
      );
      s.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove").onClick(async () => {
          list.splice(idx, 1);
          await this.host.saveSettings();
          void this.rerender(this.containerEl.scrollTop);
        })
      );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add command").setCta().onClick(() => {
        new CommandSelectModal(this.host.app, async (cmd) => {
          list.push({ commandId: cmd.id, label: cmd.name, icon: "command" });
          await this.host.saveSettings();
          void this.rerender(this.containerEl.scrollTop);
        }).open();
      })
    );
  }
```

- [ ] **Step 5: Call it in the general tab**

In `renderActiveTab`, general case, add the call right after `this.renderRibbonToggles(containerEl);` (`:349`):

```ts
        this.renderQuickCommands(containerEl);
```

- [ ] **Step 6: Add CSS**

Append to `styles.css` (near the other `.config-sync-*` settings rules):

```css
/* Quick commands settings rows */
.config-sync-qc-icon { display: inline-flex; align-items: center; margin-right: 6px; vertical-align: middle; }
.config-sync-qc-row.is-missing { opacity: 0.55; }
.config-sync-qc-row .config-sync-qc-iconinput { width: 6em; }
```

- [ ] **Step 7: Verify build, tests, lint**

Run: `npm test && npm run build && npm run lint`
Expected: all pass; lint unchanged (67, 0 errors).

- [ ] **Step 8: Manual end-to-end check**

Run: `npm run smoke:install`, reload the dev vault.
- Settings → Config Sync → General → **Quick commands**: press **Add command**, pick *Remotely Save: Start sync* → a row appears (icon ⌘, label "Remotely Save: Start sync", desc = the command id).
- Edit the label and the icon field (e.g. `refresh-cw`) → icon preview updates in place, focus stays in the field.
- Add a second command; use ↑/↓ to reorder; delete one with the trash button.
- Open the Config Sync ribbon menu → the configured commands appear under the separator, in the settings order; clicking one runs it.
- Disable the target plugin (or add a bogus id via a second entry) → its settings row dims (`is-missing`) and its menu item greys out.

---

### Task 4: Documentation currency

**Files:**
- Modify: `README.md` (`:70`)
- Modify: `README.zh.md` (`:70`)
- Modify: `docs/ARCHITECTURE.md` (`:110-114`, the `main.ts` connector bullet)
- Modify: `docs/design/DESIGN.md` (`:90`, the icon inventory line)

Docs must ship in the same change as the user-facing feature (repo docs-currency rule). No code; verification is a read-back.

- [ ] **Step 1: README.md — extend the ribbon paragraph**

In `README.md:70`, the sentence ends "…Individual ribbon icons for Sync and Revert are available under **Settings → General**, off by default." Append after it:

```markdown
 You can also add your own **Quick commands** to that menu (Settings → General) — any Obsidian command (e.g. remotely-save's *Start sync*) appears under a divider and runs on click; a command not installed on the current device is greyed out. The list is synced across your devices with the rest of Config Sync's settings.
```

- [ ] **Step 2: README.zh.md — mirror in Chinese**

In `README.zh.md:70`, after "…也可以在 **Settings → General** 中为 Sync 和 Revert 单独启用功能区图标，默认关闭。" append:

```markdown
 你还可以在 Settings → General 中为该菜单添加自己的 **Quick commands**（快捷命令）——任意 Obsidian 命令（例如 remotely-save 的 *Start sync*）都会出现在分隔线下，点击即执行；在当前设备上未安装的命令会被灰掉。这份列表会随 Config Sync 的其余设置一起跨设备同步。
```

- [ ] **Step 3: ARCHITECTURE.md — note the menu extension**

In `docs/ARCHITECTURE.md`, the `main.ts` connector bullet (`:110-114`) says it "registers the ribbon/commands and the Sync Center view". Extend that clause to:

```markdown
  registers the ribbon/commands (the ribbon menu also lists user-configured **quick commands**,
  run via `app.commands.executeCommandById` and greyed out when unregistered on the device) and the
  Sync Center view, and dynamic-imports `src/external/`
```

- [ ] **Step 4: DESIGN.md — add the icon note**

In `docs/design/DESIGN.md:90`, the icon inventory line lists `refresh-cw` ribbon, `undo-2` revert, etc. Append to that inventory:

```markdown
· `command` default icon for user-added quick-command menu items (user-overridable)
```

- [ ] **Step 5: Verify docs read correctly**

Re-read each edited passage in context; confirm the new text is grammatical, matches surrounding tone, and the anchors weren't shifted by earlier edits. No build needed (Markdown only), but run `npm run build` once more to confirm the whole change set still compiles.

---

## Self-Review

**Spec coverage:**
- Type `QuickCommand {commandId,label,icon}` + `settings.quickCommands` default `[]` → Task 1.
- Pure `quickCommandEntries` with grey-out + unit test → Task 1.
- Menu render under separator, `executeCommandById`, `setDisabled` → Task 2.
- `CommandSelectModal` (FuzzySuggestModal over `app.commands`) → Task 3 Step 1.
- Quick commands settings section: add/reorder/edit/delete, icon preview + fallback, greyed missing → Task 3.
- Shared-synced list (not device-local; verified against `selfPresetRules()`) → Task 1 (field placement) + Task 4 docs; no strip preset added, matching spec.
- Non-goals (no per-device list, no icon picker, no ribbon icon per command, no RS-icon removal) → respected; Global Constraints restate them.
- Docs currency (README/zh/ARCHITECTURE/DESIGN) → Task 4.

**Placeholder scan:** none — every code step carries full code; every command has expected output.

**Type consistency:** `QuickCommand` fields `{commandId,label,icon}` and `QuickCommandEntry` (adds `disabled`) are used identically in Tasks 1–3; `quickCommandEntries(list, isRegistered)` signature matches at its call site in Task 2; `settings.quickCommands` referenced consistently; re-render via `this.rerender(this.containerEl.scrollTop)` matches the existing method at `:261`.
