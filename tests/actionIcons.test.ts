import { describe, it, expect } from "vitest";
import { ACTION_ICON, ACTION_COLOR_CLASS, type SyncAction } from "../src/ui/actionIcons";

describe("action icon registry", () => {
  const actions: SyncAction[] = ["capture", "apply", "push", "pull"];

  it("maps every action to an icon and a color class", () => {
    for (const a of actions) {
      expect(ACTION_ICON[a]).toBeTruthy();
      expect(ACTION_COLOR_CLASS[a]).toBeTruthy();
    }
  });

  it("uses a distinct icon per action (no glyph reuse)", () => {
    const icons = actions.map((a) => ACTION_ICON[a]);
    expect(new Set(icons).size).toBe(actions.length);
  });

  it("keeps the established per-action colors", () => {
    expect(ACTION_COLOR_CLASS).toEqual({
      capture: "is-up", apply: "is-down", push: "is-push", pull: "is-pull",
    });
  });
});
