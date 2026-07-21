import { setIcon } from "obsidian";

export type SyncAction = "capture" | "apply" | "push" | "pull";

// Lucide names. If any renders empty on the installed Obsidian, swap to the fallback
// noted in the plan's Global Constraints — this map is the only place it lives.
export const ACTION_ICON: Record<SyncAction, string> = {
  capture: "arrow-up-from-line",
  apply: "arrow-down-to-line",
  push: "cloud-upload",
  pull: "cloud-download",
};

// Existing state-icon color classes, one per action. The SVG inherits the color via
// currentColor from a parent carrying one of these.
export const ACTION_COLOR_CLASS: Record<SyncAction, "is-up" | "is-down" | "is-push" | "is-pull"> = {
  capture: "is-up",
  apply: "is-down",
  push: "is-push",
  pull: "is-pull",
};

// Append an action icon to `parent`. No color class — inherits currentColor from the
// parent (a colored badge/state span, or a button's foreground). Returns the span so a
// caller on an uncolored parent can add `ACTION_COLOR_CLASS[action]` itself.
export function renderActionIcon(parent: HTMLElement, action: SyncAction): HTMLSpanElement {
  const span = parent.createSpan({ cls: "config-sync-action-icon" });
  setIcon(span, ACTION_ICON[action]);
  return span;
}

// Append an action icon followed by `count` (omitted when 0). For count badges/pills;
// `parent` carries the color class.
export function renderActionCount(parent: HTMLElement, action: SyncAction, count: number): void {
  renderActionIcon(parent, action);
  if (count > 0) parent.appendText(String(count));
}
