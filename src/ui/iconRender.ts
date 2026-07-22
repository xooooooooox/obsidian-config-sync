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
