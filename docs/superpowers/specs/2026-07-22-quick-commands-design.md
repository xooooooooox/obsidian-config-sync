# Quick commands — user commands in the Config Sync ribbon menu

## Problem

The left ribbon accumulates one icon per sync-ish plugin: Config Sync's own
icon (`main.ts:156`, opens `openSyncMenu`) sits next to remotely-save's native
icon, and any other plugin the user reaches for. The user wants **one** ribbon
entry point that, on click, lets them pick what to run — Config Sync's own
sync, remotely-save, or anything else — then fires it.

Config Sync already owns exactly one menu-opening ribbon icon
(`openSyncMenu`, `main.ts:323-337`: *Sync…* + *Revert last apply*). The natural
home for "pick what to run" is that existing menu. remotely-save is an external
plugin we cannot restructure, but it exposes commands
(`remotely-save:start-sync`, `…-dry-run`, …) invokable via
`app.commands.executeCommandById(id)`.

Generalised (per 定稿 discussion): this is not "external **sync**". It is
"surface an arbitrary **command** in this menu". remotely-save is one instance.
Commander cannot serve this scenario because it lacks the two properties below.

Goal: a user-configurable list of commands appended to the Config Sync ribbon
menu; clicking one runs it. The list lives in Config Sync settings so it
**travels across devices** (self-synced `data.json`), and each entry **greys out
on devices where its command is not registered**.

## Decision (定稿)

Add **Quick commands**: `settings.quickCommands: QuickCommand[]`
(`{ commandId, label, icon }`), rendered at the bottom of the existing
`openSyncMenu` under a separator, after the built-in *Sync…* / *Revert*.

- **No new ribbon icon.** Config Sync keeps its single icon; the menu becomes
  the consolidated chooser. remotely-save's own icon is the user's to hide
  (they use Commander) — out of our scope, we cannot cleanly remove another
  plugin's ribbon element.
- **Trigger** = `app.commands.executeCommandById(commandId)`; the target
  command then runs its own flow (its own notices/modals). Config Sync does
  nothing further.
- **Device-aware grey-out.** An entry whose `commandId` is not registered on
  this device renders **disabled** (`MenuItem.setDisabled(true)`), not hidden
  and not erroring.
- **Shared, synced list.** One list for all devices — no per-device
  `quickCommands`. Device differences are handled entirely by the grey-out, the
  same way registration naturally varies (a desktop-only plugin's command is
  simply disabled on mobile). Because `quickCommands` is a field of
  `ConfigSyncSettings`, it is part of the plugin's self-synced `data.json` and
  travels automatically.

定稿 mockups (visual companion, `.superpowers/brainstorm/…/content/`):
`ribbon-integration.html` (option **A**, extend existing menu),
`launcher-settings.html` (command-picker), `menu-commands.html`
(generalised model + naming).

### Why self-built, not Commander

1. **Grey-out follows the device** — a command absent on this device is
   disabled in place, driven by live `app.commands` registration.
2. **Config travels with Config Sync** — the list is Config Sync settings, so
   it is synced across devices as one unit; configure once, present everywhere.
   Self-sync strips only a denylist of device-local fields
   (`selfPresetRules()`, `core/catalog.ts:382-388`: `rootPath`, `remotes`,
   `switchExceptions`); `quickCommands` is not in it, so it flows by default —
   no strip preset to add.

## Architecture

### 1. Type + default (`core/types.ts`, `main.ts`)

`core/types.ts` — beside `RibbonKey`/`RibbonButtons`:

```ts
// A user-added command surfaced in the Config Sync ribbon menu.
export interface QuickCommand {
  commandId: string; // e.g. "remotely-save:start-sync"; run via executeCommandById
  label: string;     // menu title; defaults to the command's name at add-time, editable
  icon: string;      // lucide id; defaults to "command"; setIcon falls back if unknown
}
```

`main.ts` — add to `ConfigSyncSettings` (`:47-60`):
`quickCommands: QuickCommand[];`, and to `DEFAULT_SETTINGS` (`:69-82`):
`quickCommands: [],`. Add the same field to the `SettingsHost` settings shape in
`SettingTab.ts` (`:40`, the `ribbonButtons: …` block).

### 2. Pure entry builder (`main.ts` or a small `core/` helper)

The grey-out decision is the one piece worth a unit test (vitest, no DOM, per
repo style). Extract a pure function:

```ts
export interface QuickCommandEntry {
  commandId: string;
  label: string;
  icon: string;
  disabled: boolean; // command not registered on this device
}

// Maps configured quick commands to menu entries, marking any whose command is
// not currently registered as disabled. `isRegistered` wraps app.commands.
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

### 3. Render into `openSyncMenu` (`main.ts:323-337`)

After the two built-in `menu.addItem(...)` calls, append the quick commands:

```ts
const cmds = (this.app as unknown as { commands: { commands: Record<string, unknown>;
  executeCommandById: (id: string) => void } }).commands;
const entries = quickCommandEntries(this.settings.quickCommands, (id) => id in cmds.commands);
if (entries.length > 0) {
  menu.addSeparator();
  for (const e of entries) {
    menu.addItem((i) => {
      i.setTitle(e.label);
      if (e.icon) i.setIcon(e.icon);
      if (e.disabled) i.setDisabled(true);
      else i.onClick(() => cmds.executeCommandById(e.commandId));
    });
  }
}
```

`app.commands` is not in the public typings; access it the same guarded way
`main.ts` already reaches `app.plugins` (`:84`, `pluginRegistry()`). Empty list →
no separator, menu unchanged.

### 4. Command picker modal (`ui/CommandSelectModal.ts`, new)

Mirror `FolderSelectModal` (`ui/FolderSelectModal.ts`) as
`FuzzySuggestModal<Command>` over the registered commands:

```ts
import { App, Command, FuzzySuggestModal } from "obsidian";

export class CommandSelectModal extends FuzzySuggestModal<Command> {
  constructor(app: App, private onChoose: (cmd: Command) => void) {
    super(app);
    this.setPlaceholder("Pick a command to add");
  }
  getItems(): Command[] {
    return Object.values((this.app as unknown as { commands: { commands: Record<string, Command> } }).commands.commands);
  }
  getItemText(cmd: Command): string {
    return cmd.name; // fuzzy-matched; id shown alongside in renderSuggestion if desired
  }
  onChooseItem(cmd: Command): void {
    this.onChoose(cmd);
  }
}
```

On choose: create `{ commandId: cmd.id, label: cmd.name, icon: "command" }`,
push to `settings.quickCommands`, save, re-render the section.

### 5. Settings section (`ui/SettingTab.ts`, new `renderQuickCommands`)

Add a **Quick commands** heading + section, placed near `renderRibbonToggles`
(`:1450`). Structure per existing list patterns in this file:

- Heading `Setting().setName("Quick commands").setDesc("Commands added to the
  Config Sync ribbon menu. A command not installed on this device is greyed
  out.").setHeading()` (anchored like the others for search).
- One `Setting` row per entry:
  - `.setName(label)` with an editable name (text) and `.setDesc(commandId)`;
    show the icon via `setIcon` on a leading span (fallback path as in the BRAT
    icon handling, `SettingTab.ts:329-332`).
  - `addExtraButton` ↑ / ↓ to reorder (swap in array), `addExtraButton` pencil
    to edit `label`/`icon` inline, `addExtraButton` trash to remove.
  - A disabled/greyed treatment when `!(commandId in app.commands.commands)`.
  - Each mutation → `saveSettings()` then re-render the section.
- Footer `addButton("Add command")` → `new CommandSelectModal(app, onChoose)`.

Icon input is a plain lucide-id text field with a `setIcon` preview — **not** a
full icon picker (YAGNI). Unknown ids fall back via the existing `setIcon`
empty-child check.

### 6. CSS (`styles.css`)

Minimal rows for the settings list (icon + name/id + buttons); reuse existing
tokens (`--background-secondary`, `--background-modifier-border`,
`--text-muted/faint`, `--radius-*`). A `.config-sync-qc-row.is-missing`
(greyed) variant for unregistered commands. No menu CSS — native `Menu`
handles the separator and disabled state.

## Non-goals

- No per-command individual ribbon icon (they live only in the menu). The
  existing `ribbonButtons` (sync/revert) toggles are unchanged.
- No per-device `quickCommands` — grey-out covers device differences.
- No full icon picker — lucide-id text field with preview.
- No removal of remotely-save's own ribbon icon — user hides it via Commander.
- No status/count badges on quick-command entries (only *Sync…* keeps ↑↓).

## Verification

- Add remotely-save's *Start sync* via the picker → it appears under the
  separator in the ribbon menu; clicking it runs remotely-save's sync.
- Add a command from a plugin not installed on this device (or disable that
  plugin) → the entry is present but greyed/disabled; clicking does nothing.
- Reorder / rename / delete in settings reflect in the menu after re-open.
- Empty `quickCommands` → menu is exactly today's (no separator).
- `quickCommandEntries` unit test: registered → `disabled:false`,
  unregistered → `disabled:true`, order preserved.
- Cross-device: the list, being in `data.json`, syncs; a phone shows the same
  entries with device-appropriate grey-out.
