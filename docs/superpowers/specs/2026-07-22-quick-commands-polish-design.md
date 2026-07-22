# Quick commands polish — real icons, icon picker, separators, row layout

Follow-up to `2026-07-22-quick-commands-design.md` after 1.4.0 live-verify.

## Problem

Four issues surfaced on the shipped Quick commands (screenshots from the user's
AnuPpuccin vault):

1. **Menu items look icon-less.** Every entry defaults to the generic `command`
   ⌘, so the ribbon menu reads as having no meaningful icons. *Investigated:*
   AnuPpuccin and the user's snippets do **not** hide `.menu-item-icon` (a
   synthesized menu icon computes `display:flex; width:16px; visible`), and
   `setIcon` works. The palette shows each command's own icon (remotely-save →
   a rotate glyph, Commander macros → a star, Custom Attachment Location →
   move/download). So the fix is **real icons**, not CSS.
2. **No meaningful default icon.** New entries default to `command` instead of
   the command's own `cmd.icon`.
3. **Settings row style is broken.** The `Setting`-based row crams a truncated
   label input + a raw icon text field + three buttons with a large dead gap
   (mockup image 2).
4. **No separators.** The menu has only the one built-in divider; the user can't
   group their commands with extra dividers.

## Decision (定稿)

- **Icon defaults to the command's own icon** (items 1 + 2). On add,
  `icon = cmd.icon ?? "command"`. `Command.icon?: IconName` is part of the
  Obsidian API. The menu already calls `setIcon`, so real icons then render in
  both the settings row and the menu. **No CSS override** — the theme was never
  hiding icons.
- **Icon editing via an icon picker** (Commander-style, per the user). Replace
  the raw icon text field with a clickable icon that opens `IconSelectModal` — a
  `FuzzySuggestModal<string>` over `getIconIds()`, each suggestion rendered with
  a live icon preview.
- **Separators** (item 4). A quick-list entry becomes a union: a command
  `{ commandId, label, icon }` or a separator `{ kind: "separator" }`. New
  **Add separator** button; each separator renders as `menu.addSeparator()`.
- **Row layout** (item 3). Replace the Obsidian `Setting` row with a custom flex
  row: `[icon button] [label input] [command id, muted] … [↑][↓][🗑]`. Separator
  rows render a dashed divider with reorder/delete.
- **Add flow** = lightweight (confirmed): pick command → enters the list with
  defaults (`label = cmd.name`, `icon = cmd.icon ?? "command"`) → edit inline.

定稿 mockup: `.superpowers/brainstorm/…/content/qc-polish-v2.html`.

## Architecture

### 1. Data model (`core/types.ts`)

```ts
export interface QuickCommand { commandId: string; label: string; icon: string }
export interface QuickSeparator { kind: "separator" }
export type QuickEntry = QuickCommand | QuickSeparator;

export function isSeparator(e: QuickEntry): e is QuickSeparator {
  return (e as QuickSeparator).kind === "separator";
}
```

Widen `settings.quickCommands` from `QuickCommand[]` to `QuickEntry[]` (in
`main.ts` `ConfigSyncSettings` and `SettingTab.ts` `SettingsHost.settings`).
Legacy entries have no `kind` and carry `commandId`, so `isSeparator` treats
them as commands — **no data migration**; the shallow-merge default stays `[]`.

### 2. Menu builder (`core/quickCommands.ts`)

Replace `quickCommandEntries` with `quickMenuEntries`, which also normalizes
separators (drop leading/trailing, collapse consecutive, empty when no command):

```ts
import { QuickEntry, isSeparator } from "./types";

export type QuickMenuEntry =
  | { kind: "separator" }
  | { kind: "command"; commandId: string; label: string; icon: string; disabled: boolean };

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
      if (last === undefined) continue;             // no leading separator
      if (last.kind === "separator") continue;      // collapse consecutive
    }
    out.push(e);
  }
  while (out.length > 0) {                           // no trailing separator
    const last = out[out.length - 1];
    if (last === undefined || last.kind !== "separator") break;
    out.pop();
  }
  return out.some((e) => e.kind === "command") ? out : [];  // only-separators → []
}
```

Unit tests: consecutive/leading/trailing separators collapse; `disabled` set for
unregistered command; all-separators → `[]`; `[]` → `[]`; a real separator
between two commands survives.

### 3. Menu render (`main.ts` `openSyncMenu`)

```ts
const quick = quickMenuEntries(this.settings.quickCommands, (id) => id in commands.commands);
if (quick.length > 0) {
  menu.addSeparator();
  for (const e of quick) {
    if (e.kind === "separator") { menu.addSeparator(); continue; }
    menu.addItem((i) => {
      i.setTitle(e.label);
      if (e.icon) i.setIcon(e.icon);
      if (e.disabled) i.setDisabled(true);
      else i.onClick(() => commands.executeCommandById(e.commandId));
    });
  }
}
```

### 4. Icon picker (`ui/IconSelectModal.ts`, new)

```ts
import { App, FuzzyMatch, FuzzySuggestModal, getIconIds, setIcon } from "obsidian";

// Searchable icon picker (Commander-style) — fuzzy over every registered icon id,
// each suggestion rendered with a live preview.
export class IconSelectModal extends FuzzySuggestModal<string> {
  constructor(app: App, private onChoose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Pick an icon");
  }
  getItems(): string[] { return getIconIds(); }
  getItemText(id: string): string { return id; }
  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("config-sync-iconpick");
    setIcon(el.createSpan({ cls: "config-sync-iconpick-glyph" }), match.item);
    el.createSpan({ text: match.item });
  }
  onChooseItem(id: string): void { this.onChoose(id); }
}
```

### 5. Default icon at add (`ui/SettingTab.ts` add-command call site)

The `CommandSelectModal` onChoose already receives the full `Command`. Change the
pushed entry's icon default:

```ts
list.push({ commandId: cmd.id, label: cmd.name, icon: cmd.icon ?? "command" });
```

### 6. `renderQuickCommands` rebuild (`ui/SettingTab.ts`)

Replace the `Setting`-based rows with custom rows built on a container div:

- **Command row** (`.config-sync-qc-row`): a clickable icon button
  (`config-sync-qc-icon`, `setIcon(entry.icon)`, fallback `command`) that opens
  `new IconSelectModal(this.host.app, (icon) => { entry.icon = icon; save; repaint })`;
  a label `<input>` (inline edit → `entry.label = v.trim() || entry.commandId`,
  save, **no rerender** to keep focus); the command id muted underneath; ↑↓
  (swap, guarded for `noUncheckedIndexedAccess`) and 🗑 (splice) → save +
  `this.rerender(this.containerEl.scrollTop)`. Greyed when
  `!(commandId in app.commands.commands)`.
- **Separator row** (`.config-sync-qc-seprow`): a dashed divider + ↑↓/🗑.
- **Footer**: **Add command** (existing `CommandSelectModal`, default icon
  `cmd.icon ?? "command"`) and **Add separator** (push `{ kind: "separator" }`,
  save, rerender).

Iterate `this.host.settings.quickCommands` (now `QuickEntry[]`), branching on
`isSeparator`. Full method code belongs in the plan.

### 7. CSS (`styles.css`)

Replace the current `.config-sync-qc-*` block with: `.config-sync-qc-row`
(flex, gap), `.config-sync-qc-icon` (clickable tile), `.config-sync-qc-meta`
(label input full width + muted id), `.config-sync-qc-seprow` (dashed divider
row), `.config-sync-qc-row.is-missing` (greyed), and `.config-sync-iconpick*`
(picker suggestion row + glyph). Reuse existing tokens; no hardcoded colors.

## Non-goals

- No titled separators — a separator is a plain divider.
- No Commander-style add wizard — lightweight add + inline edit.
- **No CSS override to force menu icons** — the theme does not hide them
  (verified); real `cmd.icon` values are the fix.
- Icon picker is a fuzzy list with previews, not an icon grid.
- No data migration — legacy command entries stay valid; the user re-picks icons
  if they want the command's own icon on pre-existing entries.

## Verification

- Add *Remotely Save: start sync* → row + menu show its own icon (not generic ⌘).
- Click a row's icon → picker with previews → choose → row + menu update.
- Add a separator between two commands → the menu shows an extra divider there;
  leading/trailing/consecutive separators never produce stray dividers.
- Reorder/delete both command and separator rows.
- `quickMenuEntries` unit tests pass (normalization + disabled + empty).
- Legacy entries (icon `command`) still render; menu unchanged when the list has
  no commands.
- On-device: since the CLI-reachable vault runs 1.3.2, the user confirms the menu
  shows real icons on their build.
