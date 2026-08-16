import { describe, expect, it } from "vitest";
import { itemsIn } from "./items";

// The fixture builder is the one place a test can seed the item store, so it is also the one place
// a test can seed it WRONG and still pass — the two shapes below both type-check (through a cast,
// or because an id is just a string) and both compile to nothing, leaving an assertion green for a
// reason it never intended.
describe("itemsIn — hostile about the shapes that pass for the wrong reason", () => {
  it("refuses a beta section: beta is presented, never stored", () => {
    expect(() => itemsIn({ beta: { "slides-rup": { synced: true } } } as never)).toThrow(/beta/);
  });

  it("refuses a v2-style compound id — nesting carries the section now", () => {
    expect(() => itemsIn({ community: { "community:dataview": { synced: true } } })).toThrow(/bare item id/);
    expect(() => itemsIn({ custom: { "community/x": { synced: true } } })).toThrow(/bare item id/);
  });

  it("accepts a bare id in a stored section, and fills the rest empty", () => {
    const items = itemsIn({ community: { dataview: { synced: true } } });
    expect(items.community).toEqual({ dataview: { synced: true } });
    expect(items.obsidian).toEqual({});
    expect(Object.keys(items).sort()).toEqual(["community", "core", "custom", "obsidian"]);
  });
});
