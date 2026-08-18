import { ItemRef } from "../core/types";

// Where inside Settings a "opens Settings" jump should actually land.
//
// The bridge used to carry an item ref alone, so every jump landed at CARD granularity: the card
// expanded and the whole card flashed. That is right for `More ▸ Per-key rules, locks & folders`,
// which means "here is this item's drawer". It is wrong for `Per-key rules decide`, whose whole
// content is "the KEY RULES decide this" — Settings' own copy of that jump has always landed on the
// key-rules rows themselves, and the two entrances read the same words, so they must land in the
// same place. The spot is what lets one bridge serve both without either guessing.
export type SettingsSpot = "card" | "key-rules";

export interface SettingsDeepLink {
  ref: ItemRef;
  spot: SettingsSpot;
}
