import { describe, expect, it } from "vitest";
import { quickMenuEntries } from "../src/core/quickCommands";

const reg = (ids: string[]) => (id: string): boolean => ids.includes(id);

describe("quickMenuEntries", () => {
  it("maps commands, setting disabled from registration", () => {
    const out = quickMenuEntries(
      [{ commandId: "a:x", label: "X", icon: "cloud" }, { commandId: "b:y", label: "Y", icon: "star" }],
      reg(["a:x"])
    );
    expect(out).toEqual([
      { kind: "command", commandId: "a:x", label: "X", icon: "cloud", disabled: false },
      { kind: "command", commandId: "b:y", label: "Y", icon: "star", disabled: true },
    ]);
  });

  it("keeps a separator between two commands", () => {
    const out = quickMenuEntries(
      [{ commandId: "a:x", label: "X", icon: "i" }, { kind: "separator" }, { commandId: "b:y", label: "Y", icon: "i" }],
      reg(["a:x", "b:y"])
    );
    expect(out.map((e) => e.kind)).toEqual(["command", "separator", "command"]);
  });

  it("drops leading, trailing and consecutive separators", () => {
    const out = quickMenuEntries(
      [
        { kind: "separator" },
        { commandId: "a:x", label: "X", icon: "i" },
        { kind: "separator" },
        { kind: "separator" },
        { commandId: "b:y", label: "Y", icon: "i" },
        { kind: "separator" },
      ],
      reg(["a:x", "b:y"])
    );
    expect(out.map((e) => e.kind)).toEqual(["command", "separator", "command"]);
  });

  it("returns [] when there is no command", () => {
    expect(quickMenuEntries([{ kind: "separator" }], reg([]))).toEqual([]);
    expect(quickMenuEntries([], reg([]))).toEqual([]);
  });
});
