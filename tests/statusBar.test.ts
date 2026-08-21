import { describe, it, expect } from "vitest";
import { statusBarSegments, statusBarAriaLabel } from "../src/ui/statusBar";

describe("statusBarSegments", () => {
  it("renders all four segments when every count is non-zero and remote is shown", () => {
    expect(statusBarSegments({ up: 2, down: 1 }, { push: 1, pull: 3 }, true)).toEqual([
      { kind: "up", count: 2, text: "↑2" },
      { kind: "down", count: 1, text: "↓1" },
      { kind: "push", count: 1, text: "⇡1" },
      { kind: "pull", count: 3, text: "⇣3" },
    ]);
  });

  it("hides zero-count segments", () => {
    expect(statusBarSegments({ up: 3, down: 0 }, { push: 0, pull: 0 }, true)).toEqual([
      { kind: "up", count: 3, text: "↑3" },
    ]);
  });

  it("suppresses push/pull when showRemote is false despite non-zero counts", () => {
    expect(statusBarSegments({ up: 2, down: 1 }, { push: 1, pull: 1 }, false)).toEqual([
      { kind: "up", count: 2, text: "↑2" },
      { kind: "down", count: 1, text: "↓1" },
    ]);
  });

  it("returns an empty list when everything is zero (clean state)", () => {
    expect(statusBarSegments({ up: 0, down: 0 }, { push: 0, pull: 0 }, true)).toEqual([]);
  });
});

describe("statusBarAriaLabel", () => {
  it("lists only the segments present, in panel-pill terms", () => {
    expect(
      statusBarAriaLabel(
        [
          { kind: "up", count: 2, text: "↑2" },
          { kind: "down", count: 1, text: "↓1" },
          { kind: "push", count: 1, text: "⇡1" },
        ],
        { remotes: 0, uncounted: 0 }
      )
    ).toBe("Config Sync — 2 to capture · 1 to apply · 1 to push");
  });

  it("includes pull when present", () => {
    expect(statusBarAriaLabel([{ kind: "pull", count: 2, text: "⇣2" }], { remotes: 0, uncounted: 0 })).toBe("Config Sync — 2 to pull");
  });

  it("reports all in sync for the empty list", () => {
    expect(statusBarAriaLabel([], { remotes: 0, uncounted: 0 })).toBe("Config Sync — all in sync");
  });
});

describe("statusBarAriaLabel · the remote numbers are items", () => {
  const segs = statusBarSegments({ up: 13, down: 0 }, { push: 4, pull: 0 }, true);

  it("says how far the item counts are spread", () => {
    expect(statusBarAriaLabel(segs, { remotes: 2, uncounted: 0 })).toBe("Config Sync — 13 to capture · 4 to push across 2 remotes");
  });

  it("keeps the singular honest", () => {
    expect(statusBarAriaLabel(segs, { remotes: 1, uncounted: 0 })).toBe("Config Sync — 13 to capture · 4 to push across 1 remote");
  });

  it("says nothing about spread when no remote segment is showing", () => {
    const local = statusBarSegments({ up: 13, down: 0 }, { push: 0, pull: 0 }, true);
    expect(statusBarAriaLabel(local, { remotes: 0, uncounted: 0 })).toBe("Config Sync — 13 to capture");
  });

  it("owns up to a remote it could not count", () => {
    expect(statusBarAriaLabel(segs, { remotes: 2, uncounted: 1 })).toBe(
      "Config Sync — 13 to capture · 4 to push across 2 remotes · 1 remote can't be counted yet"
    );
  });

  it("says all in sync only when nothing is waiting AND nothing is uncountable", () => {
    expect(statusBarAriaLabel([], { remotes: 0, uncounted: 0 })).toBe("Config Sync — all in sync");
    expect(statusBarAriaLabel([], { remotes: 0, uncounted: 1 })).toBe("Config Sync — 1 remote can't be counted yet");
  });
});
