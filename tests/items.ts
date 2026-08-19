import { emptyItemMap, Item, ItemMap } from "../src/core/registry";
import { StorageSection } from "../src/core/types";

// Fixture builder for the v3 nested item store (spec 2026-08-11-v3-one-vocabulary-design.md):
// name only the sections a test cares about; the rest come out empty. Keeps a fixture reading as
// "these items, in these sections" instead of four literal braces per case.
//
// Deliberately HOSTILE about the two shapes that would let a fixture pass for the wrong reason:
//
// - a `beta` section. `beta` is a presented classification, never a stored one; a beta
//   plugin's item lives in `community`. The type already refuses it, but a fixture reaching for it
//   through a cast would silently seed a section no reader looks in.
// - a v2-style compound id (`"community:dataview"`, or anything else carrying `/` or `:`). Nesting
//   IS the taxonomy now, so an id is bare. Such a key type-checks, compiles to nothing, and would
//   leave a test asserting an empty list for a reason it never intended.
export function itemsIn(partial: Partial<Record<StorageSection, Record<string, Item>>>): ItemMap {
  for (const [section, items] of Object.entries(partial)) {
    if (section === "beta") {
      throw new Error('itemsIn: "beta" is not a stored section — a beta plugin\'s item lives in "community"');
    }
    for (const id of Object.keys(items ?? {})) {
      if (id.includes("/") || id.includes(":")) {
        throw new Error(`itemsIn: "${id}" is not a bare item id — nesting carries the section, so an id never contains "/" or ":"`);
      }
    }
  }
  return { ...emptyItemMap(), ...partial };
}
