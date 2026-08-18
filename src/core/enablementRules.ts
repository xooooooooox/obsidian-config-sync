/**
 * THE fleet-level enablement rule store.
 *
 * One question — "which devices turn this element on?" — with one answer per element, stored on the
 * item that CARRIES the list the element lives in, under `settingsFile.perElement[<key>]`. The value
 * is the existing `Sharing` union verbatim: `everywhere` / `per-class` / `this-device`. Nothing new
 * was invented for "each device decides" — `this-device` already means "never enters the store,
 * never resurrected from it" (perElement.ts's capture/apply), which is exactly that.
 *
 * Storage is uniform; APPLICATION is not, and must not be: community-plugins.json and
 * appearance.json's enabledCssSnippets are string arrays and go through perElement.ts, while
 * core-plugins.json is a Record<string, boolean> and goes through switchList.ts's own id masking.
 * That split lives at the runtime seam (main.ts), never here — this module only answers what the
 * rule IS.
 *
 * ONE reader, ONE writer. The three UI entrances — a carrier card's element row, a plugin
 * card's `Enabled on`, a Sync Center row — all come through this file.
 */
import { deriveMode, emptyItem, Item, ItemMap, ItemSettingsFile, itemAt, defaultSettingsFile, pruneSettingsFile, withItem, withoutItem } from "./registry";
import { perElementKeyFor } from "./switchList";
import { asSharing, EVERYWHERE, ItemId, PerElementSharing, Sharing } from "./types";

// The lists that have per-element rules. Wider than switchList.ts's `EnablementList` (which
// answers "can an ITEM's enablement ride this list?") on purpose: snippets have per-element rules
// and no items — this module is what makes the two plugin
// lists use the same mechanism instead of a second one.
export type RuleListId = "core-plugins" | "community-plugins" | "enabled-css-snippets";

export interface RuleHome {
  section: "obsidian";
  id: ItemId;
  key: string;
}

// WHICH item carries a list's rules, and under which key — one producer for both halves, because
// they are one fact. The two plugin lists carry their own (they are items); the
// snippet list is a FIELD of appearance.json, so appearance carries it.
export function ruleHomeFor(list: RuleListId): RuleHome {
  return { section: "obsidian", id: list === "enabled-css-snippets" ? "appearance" : list, key: perElementKeyFor(list) };
}

// Every readable rule for a list. A value whose shape this build does not recognise is dropped FROM
// THE READ only (types.ts's asSharing) — never rewritten on disk, and never allowed
// to reach the mask as a decision nobody asked for.
export function enablementRules(items: ItemMap, list: RuleListId): PerElementSharing {
  const home = ruleHomeFor(list);
  const raw = itemAt(items, home.section, home.id)?.settingsFile?.perElement?.[home.key] ?? {};
  const out: PerElementSharing = {};
  for (const [element, value] of Object.entries(raw)) {
    const sharing = asSharing(value);
    if (sharing !== undefined) out[element] = sharing;
  }
  return out;
}

export function enablementRuleFor(items: ItemMap, list: RuleListId, elementId: string): Sharing {
  return enablementRules(items, list)[elementId] ?? EVERYWHERE;
}

export function ruledElementIds(items: ItemMap, list: RuleListId): string[] {
  return Object.keys(enablementRules(items, list));
}

// Pure. An `everywhere` write CLEARS the entry rather than storing the default, and an emptied map
// drops its key — so a round trip through the control leaves data.json byte-identical to how it
// started. pruneSettingsFile then drops the whole settingsFile when nothing is left, which
// is why the round-trip test can compare against the untouched map.
//
// withItem's own doc comment refuses to ever remove an entry — that rule protects a core/community
// PLUGIN's presence, which is a capture mask this function never touches (a rule home is always
// "obsidian"). Here an item that has cooled all the way down to bare `{synced:false}` — nothing a
// user set, nothing this write left behind — carries no more information than having no entry at
// all, so it is dropped rather than kept as a husk: that is what makes the round trip byte-identical
// instead of leaving a stray entry the next capture would have to explain.
function isBareItem(item: Item): boolean {
  return !item.synced && Object.keys(item).length === 1;
}

export function withEnablementRule(items: ItemMap, list: RuleListId, elementId: string, sharing: Sharing): ItemMap {
  const home = ruleHomeFor(list);
  const item = itemAt(items, home.section, home.id) ?? emptyItem();
  const sf = item.settingsFile ?? defaultSettingsFile();
  const forKey = { ...(sf.perElement[home.key] ?? {}) };
  if (sharing.kind === "everywhere") delete forKey[elementId];
  else forKey[elementId] = sharing;
  const perElement = { ...sf.perElement };
  if (Object.keys(forKey).length === 0) delete perElement[home.key];
  else perElement[home.key] = forKey;
  const withKey: ItemSettingsFile = { ...sf, perElement };
  const pruned = pruneSettingsFile({ ...withKey, mode: deriveMode(withKey) });
  const nextItem: Item = { ...item };
  if (pruned === undefined) delete nextItem.settingsFile;
  else nextItem.settingsFile = pruned;
  return isBareItem(nextItem) ? withoutItem(items, home.section, home.id) : withItem(items, home.section, home.id, nextItem);
}
