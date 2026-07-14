import { describe, expect, it } from "vitest";
import { sortBySensitiveFirst } from "../src/ui/sensitiveSort";

const item = (name: string, label: string) => ({ name, label });

describe("sortBySensitiveFirst", () => {
  it("floats sensitive items to the top, alphabetical within each group, count-independent", () => {
    const items = [item("a", "Alpha"), item("z", "Zeta"), item("m", "Mike"), item("b", "Bravo")];
    const sensitive = new Set(["z", "b"]); // z has 1 hit, b has 9 — order must not depend on count
    const out = sortBySensitiveFirst(items, (i) => sensitive.has(i.name)).map((i) => i.label);
    expect(out).toEqual(["Bravo", "Zeta", "Alpha", "Mike"]);
  });
});
