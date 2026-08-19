import { ExtraButtonComponent, setTooltip } from "obsidian";

// THE header's refresh control — its look, its words, and its busy state in one place.
//
// Busy is owned by the view and painted straight onto the element (paintRefreshButton), never
// derived from remote progress and never waiting on a re-render. Deriving it cannot work: remote
// progress is desktop-only and covers neither the local half of a refresh (the expensive half) nor
// mobile at all, and a progress tick reloads the panel, which abandons the in-flight render — so
// the only frame that survives to paint is the not-busy one. Painting directly is the same
// builder/repainter split resolveSegment.ts uses, for the same reason: the control must update
// while the thing that would rebuild it is still running.

export const REFRESH_ICON = "refresh-cw";
export const REFRESH_BUTTON_CLASS = "config-sync-center-refresh";
export const REFRESH_SPIN_CLASS = "config-sync-refresh-spinning";

// While busy the tooltip drops the age entirely. "refreshed 5m ago" is an answer to "how stale is
// this?", and mid-refresh that question has no useful answer — the number is about to change.
export const REFRESH_BUSY_TOOLTIP = "Refreshing…";

// The floor on how long the spin stays visible. A vault whose whole refresh settles in ~100ms would
// otherwise flash the class on and off inside a single frame, which reads as the original bug (a
// click with no response) rather than as a fast refresh. This is feedback for a user gesture, not a
// wait inserted into the work: the refresh itself is never delayed — only the moment the spin is
// allowed to stop.
export const MIN_SPIN_MS = 400;

export interface RefreshView {
  busy: boolean;
  // Already formatted (relativeAge) by the caller, or null when this device has never refreshed.
  // Keeping the string out of here keeps the tooltip a pure function of what it shows.
  age: string | null;
}

export function refreshTooltip(state: RefreshView): string {
  if (state.busy) return REFRESH_BUSY_TOOLTIP;
  return state.age === null ? "Refresh" : `Refresh — refreshed ${state.age}`;
}

// How much longer the spin must stay up after the work finished, given how long it ran.
export function spinHoldMs(elapsed: number): number {
  return Math.max(0, MIN_SPIN_MS - elapsed);
}

// Waits out whatever spinHoldMs is still owed. Lives here rather than at the call site so the floor
// is one concept in one file — the constant, the arithmetic and the wait.
export function holdSpin(elapsed: number): Promise<void> {
  const ms = spinHoldMs(elapsed);
  return ms === 0 ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export function renderRefreshButton(host: HTMLElement, state: RefreshView, onClick: () => void): HTMLElement {
  const btn = new ExtraButtonComponent(host);
  btn.setIcon(REFRESH_ICON);
  btn.extraSettingsEl.addClass(REFRESH_BUTTON_CLASS);
  btn.onClick(onClick);
  paintRefreshButton(btn.extraSettingsEl, state);
  return btn.extraSettingsEl;
}

// Repaints an already-rendered control in place — class and tooltip only, never a rebuild, so the
// spin can start on the same tick as the click and survive the re-renders the refresh itself
// triggers.
export function paintRefreshButton(el: HTMLElement, state: RefreshView): void {
  el.toggleClass(REFRESH_SPIN_CLASS, state.busy);
  setTooltip(el, refreshTooltip(state));
}
