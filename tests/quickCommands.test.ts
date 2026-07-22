import { describe, expect, it } from "vitest";
import { quickCommandEntries } from "../src/core/quickCommands";

const list = [
  { commandId: "remotely-save:start-sync", label: "Remotely Save", icon: "command" },
  { commandId: "ghost:missing", label: "Ghost", icon: "zap" },
];

describe("quickCommandEntries", () => {
  it("disables unregistered commands, keeps registered ones enabled", () => {
    const entries = quickCommandEntries(list, (id) => id === "remotely-save:start-sync");
    expect(entries).toEqual([
      { commandId: "remotely-save:start-sync", label: "Remotely Save", icon: "command", disabled: false },
      { commandId: "ghost:missing", label: "Ghost", icon: "zap", disabled: true },
    ]);
  });

  it("preserves order", () => {
    const ids = quickCommandEntries(list, () => true).map((e) => e.commandId);
    expect(ids).toEqual(["remotely-save:start-sync", "ghost:missing"]);
  });

  it("returns [] for an empty list", () => {
    expect(quickCommandEntries([], () => true)).toEqual([]);
  });
});
