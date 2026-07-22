# Quick commands polish v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Quick commands settings spacing + distorted icons, rename ribbon tooltip/menu copy, and let quick-command icons come from iconize custom icon packs.

**Architecture:** A pure `iconChoices()` in `core/` composes the picker list; a UI-layer `iconRender.ts` resolves an icon id to a DOM glyph (Obsidian icon → iconize `setIconForNode` → command's default icon → `command`). The picker, the settings rows, and the ribbon menu all render through that one helper.

**Tech Stack:** TypeScript, esbuild, vitest, eslint. Obsidian plugin API. Optional runtime integration with iconize (`obsidian-icon-folder`) via its public `app.plugins.plugins["obsidian-icon-folder"].api`.

**Spec:** `docs/superpowers/specs/2026-07-23-quick-commands-polish-v2.md`

## Global Constraints

- **Lint baseline:** 67 problems (0 errors, 67 warnings). Introduce **no new** problems.
- **`noUncheckedIndexedAccess: true`** — guard every array/record index access.
- **Core purity:** `src/core/*` imports nothing from `"obsidian"`.
- **Non-public API** via guarded cast: `(app as unknown as { … }).plugins` / `.commands`.
- **No commits** (leave working-tree changes; this is the user's review state). **No Claude attribution** anywhere.
- **No data migration:** `quickCommands` shape unchanged.
- **iconize optional:** with it absent, behaviour degrades to current (helper falls through to command icon). Not a declared dependency.
- **No CSS menu-icon override game:** icons are rendered into the menu item's own `iconEl`.

---

### Task 1: Pure icon-choice catalog (`core/icons.ts`)

**Files:**
- Create: `src/core/icons.ts`
- Test: `tests/icons.test.ts`

**Interfaces:**
- Produces: `interface IconPack { name: string; prefix: string; icons: { name: string; prefix: string }[] }`,
  `interface IconChoice { id: string; text: string; pack: string | null }`,
  `function iconChoices(builtinIds: string[], packs: IconPack[]): IconChoice[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/icons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { iconChoices, IconPack } from "../src/core/icons";

const feishu: IconPack = {
  name: "feishu",
  prefix: "Fe",
  icons: [{ name: "SyncFeishu", prefix: "Fe" }, { name: "FetchFeishu", prefix: "Fe" }],
};
const lucide: IconPack = { name: "lucide-icons", prefix: "Li", icons: [{ name: "Home", prefix: "Li" }] };

describe("iconChoices", () => {
  it("passes built-in ids through as pack:null", () => {
    expect(iconChoices(["home", "star"], [])).toEqual([
      { id: "home", text: "home", pack: null },
      { id: "star", text: "star", pack: null },
    ]);
  });

  it("appends custom-pack icons with prefix+name id and pack tag", () => {
    expect(iconChoices(["home"], [feishu])).toEqual([
      { id: "home", text: "home", pack: null },
      { id: "FeSyncFeishu", text: "feishu SyncFeishu FeSyncFeishu", pack: "feishu" },
      { id: "FeFetchFeishu", text: "feishu FetchFeishu FeFetchFeishu", pack: "feishu" },
    ]);
  });

  it("excludes the lucide-icons pack (Obsidian already provides Lucide)", () => {
    expect(iconChoices([], [lucide, feishu]).map((c) => c.pack)).toEqual(["feishu", "feishu"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/icons.test.ts`
Expected: FAIL — cannot find module `../src/core/icons`.

- [ ] **Step 3: Write the implementation**

Create `src/core/icons.ts`:

```ts
// Pure icon-catalog helpers for the Quick commands icon picker. Obsidian-free: the picker passes in
// Obsidian's built-in icon ids and iconize's loaded packs; this composes them into one choice list.

export interface IconPack {
  name: string;
  prefix: string;
  icons: { name: string; prefix: string }[];
}

export interface IconChoice {
  id: string; // stored icon id: a built-in id, or an iconize prefix+name (e.g. "FeSyncFeishu")
  text: string; // fuzzy-search haystack
  pack: string | null; // null = Obsidian built-in; else the iconize pack name (shown as a tag)
}

// Built-in ids first, then every icon from custom iconize packs. The "lucide-icons" pack is dropped —
// Obsidian already provides Lucide, so keeping it would list every Lucide glyph twice.
export function iconChoices(builtinIds: string[], packs: IconPack[]): IconChoice[] {
  const builtin: IconChoice[] = builtinIds.map((id) => ({ id, text: id, pack: null }));
  const custom: IconChoice[] = [];
  for (const pack of packs) {
    if (pack.name === "lucide-icons") continue;
    for (const icon of pack.icons) {
      const id = icon.prefix + icon.name;
      custom.push({ id, text: `${pack.name} ${icon.name} ${id}`, pack: pack.name });
    }
  }
  return [...builtin, ...custom];
}
```

- [ ] **Step 4: Run tests + lint + build**

Run: `npx vitest run tests/icons.test.ts && npm run lint && npm run build`
Expected: tests PASS; lint ≤ 67 problems; build succeeds.

---

### Task 2: Icon-render helper + unified icon picker

**Files:**
- Create: `src/ui/iconRender.ts`
- Modify: `src/ui/IconSelectModal.ts` (full rewrite)
- Modify: `styles.css` (picker pack tag + glyph sizing)

**Interfaces:**
- Consumes: `IconPack`, `IconChoice`, `iconChoices` from `core/icons` (Task 1).
- Produces: `function iconizeApi(app): IconizeApi | null`, `function iconizePacks(app): IconPack[]`,
  `function renderIcon(node: HTMLElement, iconId: string, fallbackIcon: string | undefined, app: App): void`.
  `IconSelectModal` unchanged constructor contract: `new IconSelectModal(app, (iconId: string) => void)`.

- [ ] **Step 1: Create the render helper**

Create `src/ui/iconRender.ts`:

```ts
import { App, setIcon } from "obsidian";
import { IconPack } from "../core/icons";

interface IconizeApi {
  getAllIconPacks(): IconPack[];
  setIconForNode(fullId: string, node: HTMLElement): void; // injects the pack's <svg> into node
}

// The iconize (obsidian-icon-folder) public API, or null when the plugin is absent/disabled.
export function iconizeApi(app: App): IconizeApi | null {
  const plugins = (app as unknown as { plugins: { plugins: Record<string, { api?: IconizeApi }> } }).plugins.plugins;
  return plugins["obsidian-icon-folder"]?.api ?? null;
}

// Every iconize icon pack, raw (the lucide-exclusion lives in the pure iconChoices).
export function iconizePacks(app: App): IconPack[] {
  return iconizeApi(app)?.getAllIconPacks() ?? [];
}

// Render iconId into node. Chain: Obsidian setIcon → iconize setIconForNode → command's default icon →
// "command". Any injected iconize <svg> gets class "svg-icon" so Obsidian's icon CSS sizes/colours it.
export function renderIcon(node: HTMLElement, iconId: string, fallbackIcon: string | undefined, app: App): void {
  node.empty();
  setIcon(node, iconId);
  if (node.childElementCount > 0) return; // built-in matched

  const api = iconizeApi(app);
  if (api !== null) {
    api.setIconForNode(iconId, node);
    const svg = node.querySelector("svg");
    if (svg !== null) {
      svg.classList.add("svg-icon");
      return;
    }
  }
  node.empty(); // iconize writes the id as stray text on a miss — clear it before the fallback

  if (fallbackIcon !== undefined && fallbackIcon !== "") {
    setIcon(node, fallbackIcon);
    if (node.childElementCount > 0) return;
  }
  setIcon(node, "command");
}
```

- [ ] **Step 2: Rewrite the picker**

Replace the entire contents of `src/ui/IconSelectModal.ts`:

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
    el.addClass("config-sync-iconpick");
    renderIcon(el.createSpan({ cls: "config-sync-iconpick-glyph" }), match.item.id, undefined, this.app);
    el.createSpan({ text: match.item.id });
    if (match.item.pack !== null) el.createSpan({ cls: "config-sync-iconpick-pack", text: match.item.pack });
  }
  onChooseItem(choice: IconChoice): void {
    this.onChoose(choice.id);
  }
}
```

- [ ] **Step 3: Picker CSS**

In `styles.css`, find the existing picker rules:

```css
.config-sync-iconpick { display: flex; align-items: center; gap: 10px; }
.config-sync-iconpick-glyph { display: inline-flex; align-items: center; }
```

Replace them with:

```css
.config-sync-iconpick { display: flex; align-items: center; gap: 10px; --icon-size: 18px; }
.config-sync-iconpick-glyph { display: inline-flex; align-items: center; }
.config-sync-iconpick-glyph .svg-icon { flex: none; }
.config-sync-iconpick-pack { margin-left: auto; font-size: var(--font-ui-smaller); color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.05em; }
```

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: lint ≤ 67 problems; build succeeds. (No unit test — DOM/non-public API; picker verified in the author's GUI pass.)

---

### Task 3: Settings row — crisp icons + spacing (#1, #2)

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderQuickCommands`: `registry` cast, `paint`, import)
- Modify: `styles.css` (`.config-sync-qc-icon`, `.config-sync-qc-addbar`)

**Interfaces:**
- Consumes: `renderIcon` from `./iconRender` (Task 2).

- [ ] **Step 1: Import the helper**

In `src/ui/SettingTab.ts`, after the existing `import { IconSelectModal } from "./IconSelectModal";` line, add:

```ts
import { renderIcon } from "./iconRender";
```

- [ ] **Step 2: Type the command registry so the fallback icon is readable**

In `renderQuickCommands`, change the `registry` declaration from:

```ts
    const registry = (this.host.app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
```

to:

```ts
    const registry = (this.host.app as unknown as { commands: { commands: Record<string, { icon?: string }> } }).commands.commands;
```

(`entry.commandId in registry` at the `missing` check still works — `in` is unaffected.)

- [ ] **Step 3: Route the row icon through renderIcon**

In `renderQuickCommands`, replace the `paint` closure:

```ts
      const paint = (id: string): void => {
        iconBtn.empty();
        setIcon(iconBtn, id);
        if (iconBtn.childElementCount === 0) setIcon(iconBtn, "command");
      };
      paint(entry.icon);
```

with:

```ts
      const paint = (id: string): void => renderIcon(iconBtn, id, registry[entry.commandId]?.icon, this.host.app);
      paint(entry.icon);
```

- [ ] **Step 4: CSS — kill the squish, add spacing**

In `styles.css`, replace:

```css
.config-sync-qc-icon { flex: none; width: 32px; height: 32px; display: flex; align-items: center;
  justify-content: center; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); border-radius: 7px; cursor: pointer; }
```

with:

```css
.config-sync-qc-icon { flex: none; width: 32px; height: 32px; display: flex; align-items: center;
  justify-content: center; background: var(--background-primary);
  border: 1px solid var(--background-modifier-border); border-radius: 7px; cursor: pointer; --icon-size: 18px; }
.config-sync-qc-icon .svg-icon { flex: none; }
```

And replace:

```css
.config-sync-qc-addbar { display: flex; gap: 8px; }
```

with:

```css
.config-sync-qc-addbar { display: flex; gap: 8px; margin-bottom: 18px; }
```

- [ ] **Step 5: Lint + build**

Run: `npm run lint && npm run build`
Expected: lint ≤ 67 problems (`setIcon` still imported — used elsewhere in the file); build succeeds.

---

### Task 4: Ribbon menu icons + copy (#3 menu path, #4)

**Files:**
- Modify: `src/main.ts` (`openSyncMenu`: title, registry cast, per-item icon; `updateRibbonDot`: tooltip; import)

**Interfaces:**
- Consumes: `renderIcon` from `./ui/iconRender` (Task 2).

- [ ] **Step 1: Import the helper**

In `src/main.ts`, after `import { quickMenuEntries } from "./core/quickCommands";`, add:

```ts
import { renderIcon } from "./ui/iconRender";
```

- [ ] **Step 2: Menu title → "Sync Center"**

In `openSyncMenu`, replace:

```ts
    const syncTitle = parts.length > 0 ? `Sync… (${parts.join(" ")})` : "Sync…";
```

with:

```ts
    const syncTitle = parts.length > 0 ? `Sync Center (${parts.join(" ")})` : "Sync Center";
```

- [ ] **Step 3: Type the command registry for the fallback icon**

In `openSyncMenu`, change:

```ts
    const commands = (this.app as unknown as {
      commands: { commands: Record<string, unknown>; executeCommandById: (id: string) => void };
    }).commands;
```

to:

```ts
    const commands = (this.app as unknown as {
      commands: { commands: Record<string, { icon?: string }>; executeCommandById: (id: string) => void };
    }).commands;
```

(`id in commands.commands` in the `quickMenuEntries` call still works.)

- [ ] **Step 4: Render each quick-command item's icon (incl. iconize)**

In `openSyncMenu`, replace the command-item block:

```ts
        menu.addItem((i) => {
          i.setTitle(e.label);
          if (e.icon) i.setIcon(e.icon);
          if (e.disabled) i.setDisabled(true);
          else i.onClick(() => commands.executeCommandById(e.commandId));
        });
```

with:

```ts
        menu.addItem((i) => {
          i.setTitle(e.label);
          i.setIcon(e.icon); // forces the icon slot to exist; renderIcon then fixes iconize ids
          const iconEl = (i as unknown as { iconEl?: HTMLElement }).iconEl;
          if (iconEl) renderIcon(iconEl, e.icon, commands.commands[e.commandId]?.icon, this.app);
          if (e.disabled) i.setDisabled(true);
          else i.onClick(() => commands.executeCommandById(e.commandId));
        });
```

- [ ] **Step 5: Ribbon tooltip → constant "Config Sync"**

In `updateRibbonDot`, replace:

```ts
    const parts: string[] = [];
    if (up > 0) parts.push(`${up} to capture`);
    if (down > 0) parts.push(`${down} to apply`);
    for (const name of remoteNewer) parts.push(`remote "${name}" newer`);
    el.setAttribute("aria-label", parts.length > 0 ? `Config Sync — ${parts.join(", ")}` : "Config Sync");
```

with:

```ts
    el.setAttribute("aria-label", "Config Sync");
```

(`up`, `down`, `remoteNewer` remain used by the two `toggleClass` dot lines above — no unused-var lint.)

- [ ] **Step 6: Lint + build + full test suite**

Run: `npm run lint && npm run build && npm test`
Expected: lint ≤ 67 problems; build succeeds; all tests pass (Task 1's `icons.test.ts` included).

---

## Final verification (whole branch)

Run: `npm test && npm run build && npm run lint && npm run smoke:install`
Expected: all tests pass; build clean; lint ≤ 67; smoke install OK.

Then the author's live GUI pass (subagents can't drive the GUI; the CLI-reachable vault runs config-sync 1.4.0, not this build):
- Settings: quick-command rows show crisp 18px icons; icon picker lists built-ins + the `feishu` pack (with pack tag) and previews render; Add command/separator buttons have a gap below.
- Ribbon menu: `Sync Center` label; each quick command shows its icon, including a feishu custom icon; a command whose icon is a feishu glyph still shows the command's own icon on a device without that pack.
- Ribbon tooltip reads `Config Sync` (no count suffix); the status dot still appears.
