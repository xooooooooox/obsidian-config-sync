/**
 * THE key space: the one identity the store
 * lock, the device-local baselines and the device-local opt-out list are all keyed by.
 *
 * All four stores are keyed by the item's own reference — never the compiled group name, which
 * would mean parsing taxonomy back out of a string and letting a rename or re-classification
 * silently orphan every baseline the old name held. This module is the ONE producer
 * of that reference for the two things that are not items:
 *
 *   - a COMPANION belongs to an item. It has no identity of its own — its group name is only
 *     `basename(path)`, unique across the compiled list solely because registry.ts's
 *     companionNameConflict forbids a clash. Keying it under its OWNER (`<owner ref>/<basename>`)
 *     makes that uniqueness STRUCTURAL rather than enforced, and ties its baseline's lifetime to
 *     the card that owns it — which is what "card off → its file AND its companions exit sync
 *     together" (registry.ts's compileCompanions) already says.
 *   - a CARRIER (an on/off list: core-plugins, community-plugins, enabled-css-snippets) IS an item.
 *     It has a store copy, a capture time, a hash, and now the display names of its elements. It is
 *     keyed under `obsidian` because the file it carries is one of Obsidian's own config files,
 *     exactly like app.json — and because the `obsidian` section's id space is CLOSED and declared
 *     in code (registry.ts's OBSIDIAN_CARD_DEFS), a carrier key cannot collide with an item by
 *     construction: core-plugins and community-plugins are two of that closed set's five ids, not
 *     ids from a runtime-injected space that merely happens not to clash with it (the
 *     two carriers have their own def in that exact list, so `defRef` and `carrierRef` mint the SAME
 *     string). Filing it under `core`/`community` (where the Sync Center SHOWS it) would put it in
 *     a runtime-injected id space (catalog.ts's setCorePluginIds) where collision is merely
 *     improbable. The tab it appears under is presentation — the same legitimate split between
 *     stored and presented vocabulary that `beta` already has.
 *
 * Collision-freedom, by construction rather than by luck: no item id ever contains a "/" (plugin
 * and core ids are Obsidian's, the three Obsidian card ids are literals, and a custom item's name
 * must match manifest.ts's GROUP_NAME_RE), so a two-segment key is always an item or a carrier and
 * a three-segment key is always a companion. tests/itemKeys.test.ts asserts this against the real
 * compiler rather than against hand-written literals.
 */
import { coreSettingsIds } from "./catalog";
import { basename } from "./pathing";
import { isSwitchListGroup } from "./switchList";
import { ItemId, ItemRef, itemRef, parseItemRef, STORAGE_SECTIONS, StorageSection, SyncGroup } from "./types";

// The section a v1/v2 lock entry lands in when NOTHING on this device claims its group name (see
// legacyRef below). Deliberately not a StorageSection: `parseItemRef` refuses it, so no reader can
// resolve such an entry and mistake it for an item's — it is inert, and it says why it is there.
export const LEGACY_SECTION = "legacy";

// A ref's two levels — the lock nests by them (`items[section][id]`), the two localStorage stores
// hold the flat string. Split at the FIRST "/", so a companion's compound id stays intact.
export function splitRef(ref: string): { section: string; id: string } {
  const cut = ref.indexOf("/");
  return cut <= 0 ? { section: ref, id: "" } : { section: ref.slice(0, cut), id: ref.slice(cut + 1) };
}

// Every section a KEY may name: the four stored sections, plus the holding pen for a v1/v2 entry
// nothing claimed. Closed on purpose — `beta` is a presented classification and
// never an identity; accepting any two segments would
// let `beta/x` through a validator whose whole job is to keep it out. Wider than `parseItemRef`
// only by `legacy/`, which is a legal KEY and an unresolvable ITEM — two different questions, and
// conflating them is what made the validator reject a ref its own backfill had just minted.
const KEY_SECTIONS: readonly string[] = [...STORAGE_SECTIONS, LEGACY_SECTION];

export function isLockRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const { section, id } = splitRef(value);
  return id !== "" && KEY_SECTIONS.includes(section);
}

export function joinRef(section: string, id: string): string {
  return `${section}/${id}`;
}

// A companion's ref: its owner's, plus the basename its group compiles to (registry.ts's
// compileCompanions names the group exactly this way — the two must be read together).
export function companionRef(owner: ItemRef, path: string): ItemRef {
  return `${owner}/${basename(path)}`;
}

// A carrier's ref. `list` is the switch list's own identity (switchList.ts's SWITCH_LISTS keys),
// never a compiled group name — the group name equals it by construction, but the identity is the
// list's.
export function carrierRef(list: string): ItemRef {
  return itemRef("obsidian", list);
}

// Every compiled group's name -> its ref. A LOOKUP built from what the compiler minted, never a
// second minter: task 1's NEW-I2 was three producers of one key moving and a fourth staying behind,
// so the legacy converter below asks the compiler rather than re-deriving anything it can look up.
export function groupRefIndex(groups: readonly SyncGroup[]): ReadonlyMap<string, ItemRef> {
  const index = new Map<string, ItemRef>();
  for (const g of groups) if (g.ref !== undefined) index.set(g.name, g.ref);
  return index;
}

// The five Obsidian-section cards' ids (registry.ts's OBSIDIAN_CARD_DEFS): the three settings
// cards plus the two on/off lists, which are `obsidian` items in their own right since task 5 (see
// this module's own header — "a CARRIER IS an item"). Named here because the legacy converter runs
// where the registry is not available — a v2 lock is read on the status path, in a remote check,
// and in bare test contexts. registry.ts asserts the two agree.
//
// A v1/v2 lock's `core-plugins`/`community-plugins` group name already resolved to
// `obsidian/<list>` before this list carried them — legacyRef's `isSwitchListGroup` branch above
// catches both names first, since it runs before this one. Listing them here too does not change
// that resolution; it makes this list agree with registry.ts's by construction rather than by
// which branch happens to run first.
export const OBSIDIAN_CARD_IDS = ["app", "appearance", "hotkeys", "core-plugins", "community-plugins"] as const;

// The `plugin-` group-name prefix, in the ONE place it has a reason to exist: reading a lock
// a 2.21.0 device wrote. This is not taxonomy being
// parsed out of a live name, it is a legacy FILE FORMAT being read, exactly like v2Migration.ts's
// `community:` prefix.
const LEGACY_PLUGIN_PREFIX = "plugin-";

/**
 * A v1/v2 lock's group name -> a v3 ref.
 *
 * Resolution order, and why: the compiled INDEX first, because the compiler is the single producer
 * of this key and anything it claims must key the same way it will be re-written; then the closed
 * legacy rules, which cover the entries this device does not compile but another device does (a
 * plugin installed there, a core plugin absent here) so two devices converting the same v2 lock
 * agree; then `legacy/<name>`.
 *
 * That last case is a DECISION ("never dropped"), not a fallback: a migration is one-way
 * and has no undo, so it is not allowed to delete. An entry no item claims is kept verbatim under a
 * section no reader can resolve — inert, but honest and recoverable — and whether it should still
 * exist at all is left to the ordinary prune (ledger.ts's pruneLedger, capture's registry sweep),
 * which asks a question the migration cannot: is this group still synced HERE?
 */
export function legacyRef(name: string, index: ReadonlyMap<string, ItemRef>): string {
  const known = index.get(name);
  if (known !== undefined) return known;
  if (name.startsWith(LEGACY_PLUGIN_PREFIX)) return itemRef("community", name.slice(LEGACY_PLUGIN_PREFIX.length));
  if (isSwitchListGroup(name)) return carrierRef(name);
  if ((OBSIDIAN_CARD_IDS as readonly string[]).includes(name)) return itemRef("obsidian", name);
  if (coreSettingsIds().has(name)) return itemRef("core", name);
  return joinRef(LEGACY_SECTION, name);
}

// The name -> ref function a lock read uses, bound to the groups the caller has compiled. THE one
// entry point: a caller with no groups in hand (a bare test context, a remote lock read before the
// registry exists) passes none and gets the closed legacy rules alone.
export function lockRefFor(groups: readonly SyncGroup[]): (name: string) => string {
  const index = groupRefIndex(groups);
  return (name: string) => legacyRef(name, index);
}

// Re-keys a stored list of names (the device opt-out list). Idempotent BY SHAPE rather than by a
// version flag the list has nowhere to keep: a compiled group name has no "/" in it at all, so an
// entry that has already moved passes through untouched and a half-written list finishes the move on
// the next load.
//
// The test is `isLockRef`, NOT `parseItemRef`. They answer different questions —
// "is this a legal KEY?" and "does this name an item this build can resolve?" — and `legacy/…` is
// deliberately the one that is the first and not the second. Asked the second question, an entry
// already in the holding pen would look unmoved and grow a segment per load (`legacy/legacy/foo`),
// with a localStorage write each time and no prune that would ever clear it — a guard must be
// chosen by the question it has to answer, not by name.
export function rekeyRefList(names: readonly string[], toRef: (name: string) => string): string[] {
  return [...new Set(names.map((n) => (isLockRef(n) ? n : toRef(n))))];
}

// The item id a ref names, or null when the ref is a companion's, a carrier's or unresolvable —
// the reading "which plugin/core/custom item is this?" wants. A companion is excluded on purpose:
// it belongs to an item but is not one, and answering with its owner's id would let a companion's
// lock entry be read as its owner's.
export function refItemId(ref: string): { section: StorageSection; id: ItemId } | null {
  const parsed = parseItemRef(ref);
  if (parsed === null || parsed.id.includes("/")) return null;
  return parsed;
}
