import { describe, expect, it } from "vitest";
import { MIN_SPIN_MS, REFRESH_BUSY_TOOLTIP, refreshTooltip, spinHoldMs } from "../src/ui/refreshControl";
import { SyncCenterView } from "../src/ui/SyncCenterView";

// The header's refresh control had a spin class and a keyframe animation and still looked dead on
// click, because busy was DERIVED from the plugin's remote-check progress: null on mobile, and on
// desktop only true during a window in which every progress tick started a fresh reload that
// abandoned the previous one — so the only frame that ever reached the screen was the not-busy one.
// Busy is the view's own state now. These tests pin the two halves that can be pinned without a
// DOM: what the control SAYS, and that a second click while busy does not start a second refresh.

describe("refreshTooltip", () => {
  it("drops the age while busy — the number it would quote is about to change", () => {
    expect(refreshTooltip({ busy: true, age: "5m ago" })).toBe(REFRESH_BUSY_TOOLTIP);
    expect(refreshTooltip({ busy: true, age: null })).toBe(REFRESH_BUSY_TOOLTIP);
  });

  // Byte-for-byte the pre-existing idle copy: this change is about WHEN the control updates, not
  // about renaming anything the user already reads.
  it("keeps the established idle wording", () => {
    expect(refreshTooltip({ busy: false, age: null })).toBe("Refresh");
    expect(refreshTooltip({ busy: false, age: "just now" })).toBe("Refresh (refreshed just now)");
    expect(refreshTooltip({ busy: false, age: "5m ago" })).toBe("Refresh (refreshed 5m ago)");
  });
});

// A refresh that settles in ~100ms would flash the class on and off inside one frame, which reads
// as the original bug rather than as a fast refresh. The floor delays only when the spin STOPS —
// never the work itself.
describe("spinHoldMs", () => {
  it("holds the remainder of the floor for a fast refresh", () => {
    expect(spinHoldMs(0)).toBe(MIN_SPIN_MS);
    expect(spinHoldMs(100)).toBe(MIN_SPIN_MS - 100);
  });

  it("holds nothing once the work already outlasted the floor", () => {
    expect(spinHoldMs(MIN_SPIN_MS)).toBe(0);
    expect(spinHoldMs(9_000)).toBe(0);
  });
});

interface RefreshInternals {
  refreshing: boolean;
  paintRefresh: () => void;
  runRefresh: () => Promise<void>;
  reload: () => Promise<void>;
  // The spin floor's timer, stubbed the same way the repaints are: it goes through
  // `window.setTimeout` (a popped-out pane has its own timer scope), which these node-environment
  // tests have no business standing up a browser for.
  holdSpin: (elapsed: number) => Promise<void>;
  host: { refreshRemoteChecks: () => Promise<void> };
}

function viewFor(): RefreshInternals {
  const view = new SyncCenterView({} as never, {} as never) as unknown as RefreshInternals;
  view.paintRefresh = () => {};
  view.holdSpin = async () => {};
  return view;
}

describe("runRefresh — one gesture, both halves", () => {
  // The remote half de-dupes inside the plugin (refreshRemoteChecks returns the in-flight run); the
  // LOCAL half does not, so without this guard an impatient double-click re-scans and re-hashes
  // every item a second time for an answer the first pass is already about to produce.
  it("drops a click that lands while a refresh is still running", async () => {
    let remote = 0;
    let local = 0;
    const view = viewFor();
    view.reload = async () => {
      local++;
    };
    view.host = {
      refreshRemoteChecks: async () => {
        remote++;
        // Re-enter at the one moment it matters: the first refresh is past its guard and awaiting.
        void view.runRefresh();
      },
    };
    await view.runRefresh();
    expect(remote).toBe(1);
    expect(local).toBe(1);
  });

  it("clears the busy flag even when a half throws, so the control can never spin forever", async () => {
    const view = viewFor();
    view.reload = async () => {};
    view.host = {
      refreshRemoteChecks: async () => {
        throw new Error("remote unreachable");
      },
    };
    await expect(view.runRefresh()).rejects.toThrow("remote unreachable");
    expect(view.refreshing).toBe(false);
  });
});
