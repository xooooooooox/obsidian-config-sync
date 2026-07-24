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
      statusBarAriaLabel([
        { kind: "up", count: 2, text: "↑2" },
        { kind: "down", count: 1, text: "↓1" },
        { kind: "push", count: 1, text: "⇡1" },
      ])
    ).toBe("Config Sync — 2 to capture · 1 to apply · push 1");
  });

  it("includes pull when present", () => {
    expect(statusBarAriaLabel([{ kind: "pull", count: 2, text: "⇣2" }])).toBe("Config Sync — pull 2");
  });

  it("reports all in sync for the empty list", () => {
    expect(statusBarAriaLabel([])).toBe("Config Sync — all in sync");
  });
});
