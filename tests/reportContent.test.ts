import { describe, expect, it } from "vitest";
import { chipTooltip } from "../src/ui/reportContent";

describe("chipTooltip", () => {
  it("pluralizes per kind", () => {
    expect(chipTooltip("add", 1)).toBe("1 file added");
    expect(chipTooltip("upd", 2)).toBe("2 files updated");
    expect(chipTooltip("del", 3)).toBe("3 files deleted");
  });
});
