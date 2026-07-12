import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, moreFilesText, visibleUnderFilter } from "../src/ui/panelModel";
import { GroupState } from "../src/core/status";

describe("visibleUnderFilter", () => {
  it("all shows every state", () => {
    const states: GroupState[] = ["in-sync", "local-changed", "store-newer", "differs", "not-captured"];
    for (const s of states) expect(visibleUnderFilter(s, "all")).toBe(true);
  });

  it("capture shows local-changed and not-captured only", () => {
    expect(visibleUnderFilter("local-changed", "capture")).toBe(true);
    expect(visibleUnderFilter("not-captured", "capture")).toBe(true);
    expect(visibleUnderFilter("store-newer", "capture")).toBe(false);
    expect(visibleUnderFilter("differs", "capture")).toBe(false);
    expect(visibleUnderFilter("in-sync", "capture")).toBe(false);
  });

  it("apply shows store-newer and differs only", () => {
    expect(visibleUnderFilter("store-newer", "apply")).toBe(true);
    expect(visibleUnderFilter("differs", "apply")).toBe(true);
    expect(visibleUnderFilter("local-changed", "apply")).toBe(false);
    expect(visibleUnderFilter("in-sync", "apply")).toBe(false);
  });

  it("ok shows in-sync only", () => {
    expect(visibleUnderFilter("in-sync", "ok")).toBe(true);
    expect(visibleUnderFilter("local-changed", "ok")).toBe(false);
  });
});

describe("capFileEntries", () => {
  it("orders added, updated, deleted and splits at the limit", () => {
    const changes = {
      added: ["a1", "a2"],
      updated: ["u1", "u2", "u3"],
      deleted: ["d1"],
    };
    const { shown, rest } = capFileEntries(changes, 4);
    expect(shown).toEqual([
      { kind: "add", name: "a1" },
      { kind: "add", name: "a2" },
      { kind: "upd", name: "u1" },
      { kind: "upd", name: "u2" },
    ]);
    expect(rest).toEqual([
      { kind: "upd", name: "u3" },
      { kind: "del", name: "d1" },
    ]);
  });

  it("returns empty rest when under the limit", () => {
    const { shown, rest } = capFileEntries({ added: [], updated: ["u1"], deleted: [] }, 10);
    expect(shown).toEqual([{ kind: "upd", name: "u1" }]);
    expect(rest).toEqual([]);
  });
});

describe("copy strings", () => {
  it("in-sync line pluralizes and carries the chevron", () => {
    expect(insyncLineText(1, false)).toBe("✓ 1 item in sync ▸");
    expect(insyncLineText(2, false)).toBe("✓ 2 items in sync ▸");
    expect(insyncLineText(2, true)).toBe("✓ 2 items in sync ▾");
  });

  it("more-files line", () => {
    expect(moreFilesText(5)).toBe("… 5 more files ▸");
  });
});
