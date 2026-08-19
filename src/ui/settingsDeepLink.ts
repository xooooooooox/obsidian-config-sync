import { ItemRef } from "../core/types";

// Where inside Settings a "opens Settings" jump should actually land.
//
// An item ref alone would land every jump at CARD granularity: the card expands and the whole card
// flashes. That is right for `More ▸ Per-key rules, locks & folders`, which means "here is this
// item's drawer", and wrong for `Per-key rules decide`, whose whole content is "the KEY RULES
// decide this" — Settings' own copy of that jump lands on the key-rules rows themselves, and two
// entrances reading the same words must land in the same place. The spot is what lets one bridge
// serve both without either guessing.
export type SettingsSpot = "card" | "key-rules";

export interface SettingsDeepLink {
  ref: ItemRef;
  spot: SettingsSpot;
}
