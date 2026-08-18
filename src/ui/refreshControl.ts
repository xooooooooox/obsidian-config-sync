import { ExtraButtonComponent, setTooltip } from "obsidian";

// THE header's refresh control — its look, its words, and its busy state in one place.
//
// The spin used to be derived, at render time, from the plugin's `remoteRefreshProgress()`: non-null
// only on desktop, and only for the seconds a remote clone is actually in flight. That could not
// work, for three separate reasons that all pointed the same way:
//
//   - The class was only ever applied by a full re-render, and every progress tick called
//     notifySyncCenter → reload(), which bumps `renderGen` and makes the PREVIOUS reload abandon
//     itself at its next generation check. The only reload that survived to paint was the one
//     started after progress went back to null — i.e. the panel could only ever draw the
//     not-busy frame.
//   - On mobile the remote half returns immediately (`Platform.isDesktop` gate), so there was no
//     progress to derive anything from at all.
//   - The expensive half of a refresh is LOCAL (re-reading and re-hashing every item), and that
//     half was never represented in the button's state to begin with.
//
// So busy is no longer derived from one of the two halves. The view owns it, it covers the whole
// gesture, and it is painted straight onto the element (paintRefreshButton) instead of waiting for
// a render that may never come — the same builder/repainter split resolveSegment.ts uses, and for
// the same reason: the control must update while the thing that would rebuild it is still running.

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
