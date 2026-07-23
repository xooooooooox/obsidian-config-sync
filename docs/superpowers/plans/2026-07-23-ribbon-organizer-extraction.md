# Ribbon Organizer Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Quick Commands from config-sync into a new standalone plugin **Ribbon Organizer** (0.1.0), then remove the feature from config-sync (1.7.0).

**Architecture:** New repo bootstrapped from the official `obsidianmd/obsidian-sample-plugin` template with config-sync's toolchain layered on top; the ~700 lines of Quick Commands code (pure core + UI + menu) port verbatim with class-prefix renames and two settings-UI changes. config-sync removal is a pure deletion sequenced after the new plugin is live-verified.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), esbuild, eslint (+`eslint-plugin-obsidianmd`), vitest, Obsidian plugin API.

Spec: `docs/superpowers/specs/2026-07-23-ribbon-organizer-extraction-design.md` (config-sync repo).

## Global Constraints

- **NO COMMITS during implementation** (repo convention overrides this skill's commit steps): leave all changes uncommitted; commits/tags happen only in the user-gated release tasks (6 and 7b) after explicit user go-ahead. No Claude/AI attribution anywhere.
- Source repo: `~/local/coding/open/obsidian-config-sync` (referred to as `$SRC`). New repo: `~/local/coding/open/obsidian-ribbon-organizer`.
- New plugin identity (exact values): id `ribbon-organizer`, name `Ribbon Organizer`, version `0.1.0`, minAppVersion `1.8.7`, description `Group your ribbon and launch commands from a configurable ribbon menu.`, author `xooooooooox`, `isDesktopOnly: false`, MIT.
- New repo lint baseline: **0 problems**. config-sync lint baseline: **≤67 problems (0 errors)** — introduce none.
- Core purity: nothing under `src/core/` imports from `"obsidian"`.
- Non-public Obsidian API only via guarded casts: `(x as unknown as { ... })`.
- UI copy is sentence case (enforced by eslint-plugin-obsidianmd). The plugin name `Ribbon Organizer` in UI strings is a proper noun: if lint flags such a literal, add `// eslint-disable-next-line <reported rule id> -- plugin name is a proper noun` on that line instead of rewording.
- CSS class prefix in the new plugin: `ribbon-organizer-` (replaces `config-sync-`).
- The menu MUST call `menu.setUseNativeMenu(false)` — macOS native menus cannot render Lucide/iconize icons (config-sync 1.6.1 root cause).

---

### Task 1: Bootstrap the ribbon-organizer repo

**Files:**
- Create: entire repo at `~/local/coding/open/obsidian-ribbon-organizer` (template clone + config-sync toolchain + stub `src/main.ts`)

**Interfaces:**
- Consumes: nothing.
- Produces: a building/linting/testing repo; `src/main.ts` default-exports `class RibbonOrganizerPlugin extends Plugin`; npm scripts `dev`/`build`/`lint`/`test`/`smoke:install` identical in shape to config-sync's.

- [ ] **Step 1: Clone the official template and re-init git**

```bash
git clone --depth 1 https://github.com/obsidianmd/obsidian-sample-plugin ~/local/coding/open/obsidian-ribbon-organizer
cd ~/local/coding/open/obsidian-ribbon-organizer
rm -rf .git
git init
git remote add origin https://github.com/xooooooooox/obsidian-ribbon-organizer.git
```

(The GitHub repo already exists and is empty — remote wiring happens here; pushing stays in Task 6.)

- [ ] **Step 2: Remove template files that config-sync conventions replace**

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
rm -f main.ts styles.css manifest.json versions.json package.json package-lock.json \
  esbuild.config.mjs tsconfig.json version-bump.mjs eslint.config.mjs .eslintrc .eslintignore
rm -rf .github
```

(Template contents drift over time; `rm -f` just tolerates absent names. Keep the template's `.gitignore` and `.editorconfig`.)

- [ ] **Step 3: Copy the config-sync toolchain verbatim**

These files contain no plugin-id references (verified by grep), so they copy unchanged:

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
SRC=~/local/coding/open/obsidian-config-sync
cp "$SRC/esbuild.config.mjs" "$SRC/eslint.config.mts" "$SRC/tsconfig.json" \
   "$SRC/vitest.config.ts" "$SRC/version-bump.mjs" "$SRC/.npmrc" "$SRC/LICENSE" .
mkdir -p .github/workflows
cp "$SRC/.github/workflows/lint.yml" "$SRC/.github/workflows/release.yml" .github/workflows/
```

- [ ] **Step 4: Write `package.json`**

```json
{
	"name": "obsidian-ribbon-organizer",
	"version": "0.1.0",
	"description": "Group your ribbon and launch commands from a configurable ribbon menu",
	"main": "main.js",
	"type": "module",
	"scripts": {
		"dev": "node esbuild.config.mjs",
		"build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
		"version": "node version-bump.mjs && git add manifest.json versions.json",
		"lint": "eslint .",
		"test": "vitest run --passWithNoTests",
		"smoke:install": "npm run build && mkdir -p dev/vault/.obsidian/plugins/ribbon-organizer && cp main.js manifest.json styles.css dev/vault/.obsidian/plugins/ribbon-organizer/"
	},
	"keywords": [],
	"author": "xooooooooox",
	"license": "MIT",
	"devDependencies": {
		"@eslint/js": "^9.39.4",
		"@types/node": "^22.15.17",
		"esbuild": "0.25.5",
		"eslint": "^9.39.4",
		"eslint-plugin-obsidianmd": "^0.4.0",
		"globals": "^17.6.0",
		"jiti": "^2.6.1",
		"obsidian": "latest",
		"typescript": "^5.8.3",
		"typescript-eslint": "^8.59.1",
		"vitest": "^1.6.0"
	}
}
```

- [ ] **Step 5: Write `manifest.json` and `versions.json`**

`manifest.json`:

```json
{
	"id": "ribbon-organizer",
	"name": "Ribbon Organizer",
	"version": "0.1.0",
	"minAppVersion": "1.8.7",
	"description": "Group your ribbon and launch commands from a configurable ribbon menu.",
	"author": "xooooooooox",
	"authorUrl": "https://github.com/xooooooooox",
	"isDesktopOnly": false
}
```

`versions.json`:

```json
{
	"0.1.0": "1.8.7"
}
```

- [ ] **Step 6: Extend `.gitignore` and create the dev vault**

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
printf '\n.superpowers/\ndev/vault/.obsidian/plugins/\n' >> .gitignore
mkdir -p dev/vault/.obsidian
echo '["ribbon-organizer"]' > dev/vault/.obsidian/community-plugins.json
```

- [ ] **Step 7: Write the stub entry point `src/main.ts` and empty `styles.css`**

`src/main.ts`:

```ts
import { Plugin } from "obsidian";

export default class RibbonOrganizerPlugin extends Plugin {
  async onload(): Promise<void> {
    // Populated in later tasks: settings, ribbon icon, menu, settings tab.
  }
}
```

`styles.css` (repo root):

```css
/* Ribbon Organizer — hand-maintained stylesheet (not generated by the build). */
```

- [ ] **Step 8: Write a short `README.md`** (replace the template's; the full store-grade README with screenshots is a post-0.1.0 follow-up)

```markdown
# Ribbon Organizer

An [Obsidian](https://obsidian.md) plugin that launches your commands from a configurable ribbon menu: pick any commands, give them labels and icons (including [Iconize](https://github.com/FlorianWoelki/obsidian-iconize) custom-pack icons), group them with separators. A command not installed on the current device is greyed out and recovers automatically once its plugin is installed.

Roadmap: ribbon icon grouping/ordering with dividers.

## Install

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `xooooooooox/obsidian-ribbon-organizer`.

## License

MIT
```

- [ ] **Step 9: Install dependencies**

Run: `cd ~/local/coding/open/obsidian-ribbon-organizer && npm install`
Expected: completes without errors; `package-lock.json` created.

- [ ] **Step 10: Verify the gate**

Run: `cd ~/local/coding/open/obsidian-ribbon-organizer && npm run build && npm run lint && npm test`
Expected: build clean; lint reports **0 problems**; vitest passes with no tests (`--passWithNoTests`).

**NO COMMIT** (Global Constraints).

---

### Task 2: Pure core — types, quickMenuEntries, iconChoices (TDD)

**Files:**
- Create: `src/core/types.ts`, `src/core/quickCommands.ts`, `src/core/icons.ts`
- Test: `tests/quickCommands.test.ts`, `tests/icons.test.ts`

All paths below are inside `~/local/coding/open/obsidian-ribbon-organizer`. This code is a verbatim port from config-sync (already covered by these exact tests there); only one comment changes ("Config Sync ribbon menu" → "Ribbon Organizer menu").

**Interfaces:**
- Consumes: nothing (pure, Obsidian-free).
- Produces:
  - `QuickCommand { commandId: string; label: string; icon: string }`, `QuickSeparator { kind: "separator" }`, `QuickEntry = QuickCommand | QuickSeparator`, `isSeparator(e: QuickEntry): e is QuickSeparator`
  - `QuickMenuEntry` and `quickMenuEntries(entries: QuickEntry[], isRegistered: (commandId: string) => boolean): QuickMenuEntry[]`
  - `IconPack`, `IconChoice { id: string; text: string; pack: string | null }`, `iconChoices(builtinIds: string[], packs: IconPack[]): IconChoice[]`

- [ ] **Step 1: Copy the two test files verbatim from config-sync**

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
SRC=~/local/coding/open/obsidian-config-sync
cp "$SRC/tests/quickCommands.test.ts" "$SRC/tests/icons.test.ts" tests/
```

(Create `tests/` if the template didn't have it: `mkdir -p tests` first.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/core/quickCommands` and `../src/core/icons`.

- [ ] **Step 3: Write `src/core/types.ts`**

```ts
// A user-added command surfaced in the Ribbon Organizer menu (see core/quickCommands.ts).
export interface QuickCommand {
  commandId: string; // e.g. "remotely-save:start-sync"; run via app.commands.executeCommandById
  label: string;     // menu title; defaults to the command's name at add-time, editable
  icon: string;      // lucide id; defaults to the command's own icon; editable via the icon picker
}

// A divider inserted between quick commands in the menu.
export interface QuickSeparator {
  kind: "separator";
}

export type QuickEntry = QuickCommand | QuickSeparator;

export function isSeparator(e: QuickEntry): e is QuickSeparator {
  return (e as QuickSeparator).kind === "separator";
}
```

- [ ] **Step 4: Copy `quickCommands.ts` and `icons.ts` verbatim, fix one comment**

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
SRC=~/local/coding/open/obsidian-config-sync
cp "$SRC/src/core/quickCommands.ts" "$SRC/src/core/icons.ts" src/core/
```

Then in `src/core/quickCommands.ts`, change the comment line `// Maps configured quick entries to ribbon-menu entries: ...` — it needs no change (it doesn't name Config Sync); verify neither file contains the string `Config Sync` (`grep -n "Config Sync" src/core/*.ts` → no matches expected; if a match appears, reword that comment to say `Ribbon Organizer`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 7 tests (4 quickMenuEntries + 3 iconChoices).

- [ ] **Step 6: Verify purity and lint**

Run: `grep -rn '"obsidian"' src/core/ ; npm run lint`
Expected: grep finds nothing under `src/core/`; lint reports 0 problems.

**NO COMMIT.**

---

### Task 3: UI helpers — iconRender, IconSelectModal, CommandSelectModal, CSS

**Files:**
- Create: `src/ui/iconRender.ts`, `src/ui/IconSelectModal.ts`, `src/ui/CommandSelectModal.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `IconPack`, `IconChoice`, `iconChoices` from Task 2.
- Produces:
  - `renderIcon(node: HTMLElement, iconId: string, fallbackIcon: string | undefined, app: App): void`
  - `iconizePacks(app: App): IconPack[]`
  - `class IconSelectModal` — `new IconSelectModal(app, (icon: string) => void).open()`
  - `class CommandSelectModal` — `new CommandSelectModal(app, (cmd: Command) => void).open()`

- [ ] **Step 1: Copy `iconRender.ts` and `CommandSelectModal.ts` verbatim**

```bash
cd ~/local/coding/open/obsidian-ribbon-organizer
SRC=~/local/coding/open/obsidian-config-sync
cp "$SRC/src/ui/iconRender.ts" "$SRC/src/ui/CommandSelectModal.ts" src/ui/
```

Then in `src/ui/CommandSelectModal.ts`, replace the comment

```ts
// Fuzzy-search over every registered command; used by the Quick commands settings section to
// add an entry. Mirrors FolderSelectModal's shape.
```

with

```ts
// Fuzzy-search over every registered command; used by the Quick commands settings section to
// add an entry.
```

(`FolderSelectModal` exists only in config-sync.) `iconRender.ts` copies unchanged.

- [ ] **Step 2: Write `src/ui/IconSelectModal.ts`** (port with the CSS prefix renamed)

```ts
import { App, FuzzyMatch, FuzzySuggestModal, getIconIds } from "obsidian";
import { IconChoice, iconChoices } from "../core/icons";
import { iconizePacks, renderIcon } from "./iconRender";

// Searchable icon picker — fuzzy over Obsidian's built-in icons plus iconize custom-pack icons, each
// suggestion rendered with a live preview. Mirrors CommandSelectModal's shape.
export class IconSelectModal extends FuzzySuggestModal<IconChoice> {
  constructor(app: App, private onChoose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Pick an icon");
  }
  getItems(): IconChoice[] {
    return iconChoices(getIconIds(), iconizePacks(this.app));
  }
  getItemText(choice: IconChoice): string {
    return choice.text;
  }
  renderSuggestion(match: FuzzyMatch<IconChoice>, el: HTMLElement): void {
    el.addClass("ribbon-organizer-iconpick");
    renderIcon(el.createSpan({ cls: "ribbon-organizer-iconpick-glyph" }), match.item.id, undefined, this.app);
    el.createSpan({ text: match.item.id });
    if (match.item.pack !== null) el.createSpan({ cls: "ribbon-organizer-iconpick-pack", text: match.item.pack });
  }
  onChooseItem(choice: IconChoice): void {
    this.onChoose(choice.id);
  }
}
```

- [ ] **Step 3: Add the ported CSS to `styles.css`** (prefix renamed; the `-cid` rule from config-sync is intentionally NOT ported — spec removes the command-id line; `-missing` is its replacement)

Append:

```css
/* Quick commands settings */
.ribbon-organizer-qc-list { display: flex; flex-direction: column; gap: 7px; margin-bottom: 8px; }
.ribbon-organizer-qc-row { display: flex; align-items: center; gap: 11px; padding: 9px 11px;
  background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; }
.ribbon-organizer-qc-row.is-missing { opacity: 0.55; }
.ribbon-organizer-qc-icon { flex: none; width: 32px; height: 32px; display: flex; align-items: center;
  justify-content: center; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); border-radius: 7px; cursor: pointer; --icon-size: 18px; }
.ribbon-organizer-qc-icon .svg-icon { flex: none; }
.ribbon-organizer-qc-meta { flex: 1; min-width: 0; }
.ribbon-organizer-qc-label { width: 100%; }
.ribbon-organizer-qc-missing { font-size: var(--font-ui-smaller); color: var(--text-faint); margin-top: 3px; }
.ribbon-organizer-qc-btns { flex: none; display: flex; gap: 2px; }
.ribbon-organizer-qc-seprow { display: flex; align-items: center; gap: 10px; padding: 6px 11px;
  border: 1px dashed var(--background-modifier-border); border-radius: 8px; }
.ribbon-organizer-qc-sepline { flex: 1; height: 1px; background: var(--background-modifier-border); }
.ribbon-organizer-qc-septxt { font-size: var(--font-ui-smaller); text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--text-faint); }
.ribbon-organizer-qc-addbar { display: flex; gap: 8px; margin-bottom: 18px; }
.ribbon-organizer-iconpick { display: flex; align-items: center; gap: 10px; --icon-size: 18px; }
.ribbon-organizer-iconpick-glyph { display: inline-flex; align-items: center; }
.ribbon-organizer-iconpick-glyph .svg-icon { flex: none; }
.ribbon-organizer-iconpick-pack { margin-left: auto; font-size: var(--font-ui-smaller); color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.05em; }
```

- [ ] **Step 4: Verify the gate**

Run: `cd ~/local/coding/open/obsidian-ribbon-organizer && npm run build && npm run lint && npm test`
Expected: build clean (tsc validates the new imports), lint 0 problems, 7 tests pass.

**NO COMMIT.**

---

### Task 4: Settings tab

**Files:**
- Create: `src/ui/SettingTab.ts`

**Interfaces:**
- Consumes: `isSeparator` (Task 2), `renderIcon` (Task 3), `IconSelectModal` (Task 3), `CommandSelectModal` (Task 3); from Task 5's plugin class it uses `plugin.settings.quickCommands: QuickEntry[]` and `plugin.saveSettings(): Promise<void>` (Task 5 defines exactly these — the `import type RibbonOrganizerPlugin from "../main"` resolves against the Task 1 stub until Task 5 lands, so `settings`/`saveSettings` won't type-check until Task 5; that is expected and is why Task 4's gate is lint-only on THIS file's style, with the full build gate deferred to Task 5).
- Produces: `class RibbonOrganizerSettingTab extends PluginSettingTab` — `new RibbonOrganizerSettingTab(app, plugin)`.

Spec changes vs the config-sync original are marked ★: no command-id line; a `Not on this device` meta line only when the command is missing.

- [ ] **Step 1: Write `src/ui/SettingTab.ts`**

```ts
import { App, ButtonComponent, ExtraButtonComponent, PluginSettingTab, Setting } from "obsidian";
import { isSeparator } from "../core/types";
import { CommandSelectModal } from "./CommandSelectModal";
import { IconSelectModal } from "./IconSelectModal";
import { renderIcon } from "./iconRender";
import type RibbonOrganizerPlugin from "../main";

export class RibbonOrganizerSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: RibbonOrganizerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Quick commands")
      .setDesc("Commands shown in the Ribbon Organizer menu. A command not installed on this device is greyed out.")
      .setHeading();

    const registry = (this.app as unknown as { commands: { commands: Record<string, { icon?: string }> } }).commands.commands;
    const list = this.plugin.settings.quickCommands;
    const listEl = containerEl.createDiv({ cls: "ribbon-organizer-qc-list" });

    const persist = (): void => {
      void (async () => {
        await this.plugin.saveSettings();
        const scroll = containerEl.scrollTop;
        this.display();
        containerEl.scrollTop = scroll;
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
      const btns = row.createDiv({ cls: "ribbon-organizer-qc-btns" });
      new ExtraButtonComponent(btns).setIcon("chevron-up").setTooltip("Move up").setDisabled(idx === 0).onClick(() => move(idx, -1));
      new ExtraButtonComponent(btns).setIcon("chevron-down").setTooltip("Move down").setDisabled(idx === list.length - 1).onClick(() => move(idx, 1));
      new ExtraButtonComponent(btns).setIcon("trash").setTooltip("Remove").onClick(() => {
        list.splice(idx, 1);
        persist();
      });
    };

    list.forEach((entry, idx) => {
      if (isSeparator(entry)) {
        const row = listEl.createDiv({ cls: "ribbon-organizer-qc-seprow" });
        row.createDiv({ cls: "ribbon-organizer-qc-sepline" });
        row.createSpan({ cls: "ribbon-organizer-qc-septxt", text: "Separator" });
        row.createDiv({ cls: "ribbon-organizer-qc-sepline" });
        reorderButtons(row, idx);
        return;
      }
      const missing = !(entry.commandId in registry);
      const row = listEl.createDiv({ cls: "ribbon-organizer-qc-row" });
      if (missing) row.addClass("is-missing");
      const iconBtn = row.createEl("button", { cls: "ribbon-organizer-qc-icon", attr: { "aria-label": "Change icon" } });
      const paint = (id: string): void => renderIcon(iconBtn, id, registry[entry.commandId]?.icon, this.app);
      paint(entry.icon);
      iconBtn.onclick = (): void => {
        new IconSelectModal(this.app, (icon) => {
          entry.icon = icon;
          paint(icon);
          void this.plugin.saveSettings();
        }).open();
      };
      const meta = row.createDiv({ cls: "ribbon-organizer-qc-meta" });
      const input = meta.createEl("input", { cls: "ribbon-organizer-qc-label", attr: { type: "text", placeholder: "Label" } });
      input.value = entry.label;
      // Inline edit, no rerender, so the input keeps focus while typing.
      input.addEventListener("input", () => {
        entry.label = input.value.trim() || entry.commandId;
        void this.plugin.saveSettings();
      });
      // ★ Spec: no command-id line; only a hint when the command is missing on this device.
      if (missing) meta.createDiv({ cls: "ribbon-organizer-qc-missing", text: "Not on this device" });
      reorderButtons(row, idx);
    });

    const addbar = containerEl.createDiv({ cls: "ribbon-organizer-qc-addbar" });
    new ButtonComponent(addbar).setButtonText("Add command").setCta().onClick(() => {
      new CommandSelectModal(this.app, (cmd) => {
        list.push({ commandId: cmd.id, label: cmd.name, icon: cmd.icon ?? "command" });
        persist();
      }).open();
    });
    new ButtonComponent(addbar).setButtonText("Add separator").onClick(() => {
      list.push({ kind: "separator" });
      persist();
    });
  }
}
```

- [ ] **Step 2: Verify what can be verified now**

Run: `cd ~/local/coding/open/obsidian-ribbon-organizer && npm test`
Expected: 7 tests still pass. `npm run build` is EXPECTED TO FAIL here with `Property 'settings' does not exist on type 'RibbonOrganizerPlugin'` (and same for `saveSettings`) — the stub `main.ts` doesn't declare them until Task 5. Any OTHER build error means this task has a bug: fix it before handing off.

**NO COMMIT.**

---

### Task 5: Plugin entry — ribbon icon, DOM menu, settings wiring

**Files:**
- Modify: `src/main.ts` (replace the Task 1 stub entirely)

**Interfaces:**
- Consumes: `QuickEntry` + `quickMenuEntries` (Task 2), `renderIcon` (Task 3), `RibbonOrganizerSettingTab` (Task 4).
- Produces: `RibbonOrganizerPlugin` with `settings: RibbonOrganizerSettings` (`{ quickCommands: QuickEntry[] }`) and `saveSettings(): Promise<void>` — exactly what Task 4 imports.

- [ ] **Step 1: Replace `src/main.ts` with the full entry point**

```ts
import { Menu, Plugin } from "obsidian";
import { quickMenuEntries } from "./core/quickCommands";
import { QuickEntry } from "./core/types";
import { renderIcon } from "./ui/iconRender";
import { RibbonOrganizerSettingTab } from "./ui/SettingTab";

interface RibbonOrganizerSettings {
  quickCommands: QuickEntry[]; // commands + separators surfaced in the ribbon menu
}

const DEFAULT_SETTINGS: RibbonOrganizerSettings = {
  quickCommands: [],
};

export default class RibbonOrganizerPlugin extends Plugin {
  settings: RibbonOrganizerSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addRibbonIcon("menu", "Ribbon Organizer", (evt) => this.openMenu(evt));
    this.addSettingTab(new RibbonOrganizerSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<RibbonOrganizerSettings> | null);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private openMenu(evt: MouseEvent): void {
    const menu = new Menu();
    // Force a DOM menu: on macOS (nativeMenus default) this would render as a native OS menu,
    // which cannot show the built-in or iconize command icons. DOM mode renders them; no-op on
    // mobile, where menus are already DOM.
    menu.setUseNativeMenu(false);
    const commands = (this.app as unknown as {
      commands: { commands: Record<string, { icon?: string }>; executeCommandById: (id: string) => void };
    }).commands;
    const entries = quickMenuEntries(this.settings.quickCommands, (id) => id in commands.commands);
    if (entries.length === 0) {
      menu.addItem((i) => i.setTitle("No commands configured — add them in the plugin settings").setDisabled(true));
    }
    for (const e of entries) {
      if (e.kind === "separator") {
        menu.addSeparator();
        continue;
      }
      menu.addItem((i) => {
        i.setTitle(e.label);
        i.setIcon(e.icon); // forces the icon slot to exist; renderIcon then fixes iconize ids
        const iconEl = (i as unknown as { iconEl?: HTMLElement }).iconEl;
        if (iconEl) renderIcon(iconEl, e.icon, commands.commands[e.commandId]?.icon, this.app);
        if (e.disabled) i.setDisabled(true);
        else i.onClick(() => commands.executeCommandById(e.commandId));
      });
    }
    menu.showAtMouseEvent(evt);
  }
}
```

- [ ] **Step 2: Verify the full gate**

Run: `cd ~/local/coding/open/obsidian-ribbon-organizer && npm run build && npm run lint && npm test`
Expected: build clean (Task 4's deferred type errors resolve), lint **0 problems** (if the `"Ribbon Organizer"` ribbon literal draws a sentence-case warning, apply the Global Constraints inline-disable with the reported rule id), 7 tests pass.

- [ ] **Step 3: Smoke-install into the dev vault**

Run: `npm run smoke:install`
Expected: `main.js`, `manifest.json`, `styles.css` land in `dev/vault/.obsidian/plugins/ribbon-organizer/`.

**NO COMMIT.**

---

### Task 6: Release 0.1.0 — USER-GATED, do not start without explicit go-ahead

**STOP: report to the user first.** The user live-verifies in a real vault/GUI (menu icons on macOS DOM menu, iconize pack icons, missing-command grey-out, settings rows without command ids). Only on an explicit "publish as 0.1.0" (which is the explicit ask that authorizes commits):

- [ ] **Step 1: Initial commit** — `git add -A && git commit -m "feat: quick commands ribbon menu (extracted from config-sync)"` (no AI attribution)
- [ ] **Step 2: Push to the pre-created (empty) GitHub repo** — `git push -u origin main` (remote `origin` was wired in Task 1)
- [ ] **Step 3: Tag and push the tag** — `git tag 0.1.0 && git push origin 0.1.0` (no `v` prefix; files already carry 0.1.0, so `npm version` is not used for this first release)
- [ ] **Step 4: Wait for the "Release Obsidian plugin" CI draft** (3 assets: `main.js`, `manifest.json`, `styles.css`)
- [ ] **Step 5: Hand-write release notes** → `gh release edit 0.1.0 --title "0.1.0" --notes-file <notes>` → `gh release edit 0.1.0 --draft=false --latest`
- [ ] **Step 6: User installs via BRAT and re-verifies the released build**

Community-store submission (store README with screenshots, PR to `obsidianmd/obsidian-releases`) is a follow-up after this release is verified — not part of this plan's gate.

---

### Task 7: config-sync 1.7.0 — remove Quick Commands (USER-GATED: only after Task 6's release is live-verified)

**Files (all in `~/local/coding/open/obsidian-config-sync`):**
- Modify: `src/main.ts`, `src/ui/SettingTab.ts`, `styles.css`, `README.md`, `README.zh.md`, `docs/ARCHITECTURE.md`
- Delete: `src/core/quickCommands.ts`, `src/core/icons.ts`, `src/ui/iconRender.ts`, `src/ui/IconSelectModal.ts`, `src/ui/CommandSelectModal.ts`, `tests/quickCommands.test.ts`, `tests/icons.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-6 (different repo).
- Produces: config-sync with no Quick Commands feature; ribbon menu keeps exactly `Sync Center (…)` and `Revert last apply`, still under `menu.setUseNativeMenu(false)`.

- [ ] **Step 1: Confirm the deleted modules have no other consumers**

Run: `cd ~/local/coding/open/obsidian-config-sync && grep -rn "quickCommands\|iconRender\|IconSelectModal\|CommandSelectModal\|core/icons" src/ --include="*.ts" | grep -v "src/core/quickCommands.ts\|src/core/icons.ts\|src/ui/iconRender.ts\|src/ui/IconSelectModal.ts\|src/ui/CommandSelectModal.ts"`
Expected: hits only in `src/main.ts` and `src/ui/SettingTab.ts`. Any other file listed → STOP and report (the spec's deletion list would be wrong).

- [ ] **Step 2: `src/main.ts` — remove the feature, keep the DOM-menu call**

In `openSyncMenu` (search for `quickMenuEntries`): delete from `const commands = (this.app as unknown as {` down through the closing `}` of the `if (quick.length > 0) { ... }` block (the two `menu.addItem` lines for Sync Center / Revert and the `menu.setUseNativeMenu(false)` call with its comment STAY). Then:
- delete the settings-interface line `quickCommands: QuickEntry[]; // commands + separators surfaced in the ribbon menu; synced (not device-local)` and the default `quickCommands: [],`
- delete the now-unused imports of `quickMenuEntries`, `renderIcon`, and `QuickEntry` (tsc/eslint will flag exactly which)
- change `loadSettings` to drop the stale persisted key:

```ts
async loadSettings(): Promise<void> {
  const data = (await this.loadData()) as (Partial<ConfigSyncSettings> & { quickCommands?: unknown }) | null;
  // Quick commands moved to the Ribbon Organizer plugin in 1.7.0; drop the stale key so the
  // next save cleans data.json.
  if (data !== null) delete data.quickCommands;
  this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
}
```

- [ ] **Step 3: `src/ui/SettingTab.ts` — remove the section**

Delete: the whole `renderQuickCommands` method; its call `this.renderQuickCommands(containerEl);`; the `{ name: "Quick commands", desc: "Commands added to the Config Sync ribbon menu. ...", anchorId: "general-quick-commands" }` entry from the general-settings list; then remove whichever imports tsc/eslint flag as unused (expected: `renderIcon`, `IconSelectModal`, `CommandSelectModal`, possibly `isSeparator` — verify each has no remaining use before removing).

- [ ] **Step 4: Delete the files and the CSS block**

```bash
cd ~/local/coding/open/obsidian-config-sync
rm src/core/quickCommands.ts src/core/icons.ts src/ui/iconRender.ts src/ui/IconSelectModal.ts src/ui/CommandSelectModal.ts tests/quickCommands.test.ts tests/icons.test.ts
```

In `styles.css`, delete the entire block from the comment `/* Quick commands settings */` through the last `.config-sync-iconpick-pack { ... }` rule (currently ~lines 1472-1497).

- [ ] **Step 5: Update docs in the same change (docs-currency rule)**

- `README.md` (~line 70) and `README.zh.md` (~line 70): delete the Quick-commands sentences (from "You can also add your own **Quick commands**…" / "你还可以在 Settings → General 中为该菜单添加自己的 **Quick commands**…" through the end of that passage) and append one sentence in each: EN "Quick commands moved to the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin." / ZH "Quick commands 功能已拆分为独立插件 [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer)。"
- `docs/ARCHITECTURE.md` (~line 113): remove the parenthetical "(the ribbon menu also lists user-configured **quick commands**, …)" clause.
- Then sweep: `grep -rni "quick command" README.md README.zh.md docs/ --include="*.md" | grep -v superpowers` — fix any remaining mention (spec/plan files under `docs/superpowers/` stay as historical record).

- [ ] **Step 6: Verify the gate**

Run: `cd ~/local/coding/open/obsidian-config-sync && npm run build && npm test && npm run lint`
Expected: build clean; tests all pass with the total dropping by exactly 7 (the two deleted files); lint ≤67 problems, 0 errors, no NEW warnings (removals may lower the count — that's fine).

**NO COMMIT** — leave uncommitted for user review; release as 1.7.0 (`npm version 1.7.0` → `git push origin main --follow-tags` → CI draft → hand-written notes → publish) only on the user's explicit go.
