import { SyncGroup } from "./types";
import { groupForStoreRel } from "./ConfigSyncCore";
import { compileItems, defsForForeignItems, ItemDef, ItemMap } from "./registry";
import { classifySettings } from "./settingsMigration";
import { migrateV2Settings } from "./v2Migration";
import { migrateV4Settings } from "./v4Migration";

// The Leftover list's own grouping — the main list's section vocabulary, plus "other" for
// vault-root and unclassifiable files.
export type LeftoverSection = "obsidian" | "core" | "community" | "other";

export const LEFTOVER_SECTION_ORDER: readonly LeftoverSection[] = ["obsidian", "core", "community", "other"];

export interface LeftoverFile {
  rel: string; // store-root-relative, e.g. "store/configdir/plugins/x/data.json"
  section: LeftoverSection;
  name: string; // the file's REAL owner (plugin/card label) or its basename — never the raw path
  crumb: string | null; // owning card shown faint before the name (e.g. "Appearance"), when one applies
  path: string; // rel without the leading "store/", shown in the row's mono line
}

// Name sources the classifier cannot know on its own, prebuilt by the caller (main.ts):
// pluginLabels = plugin id -> display name (store-lock display.label, else the locally installed
// manifest's name — absent means "fall back to the id"); fileOwners = configdir basename -> the
// core plugin / Obsidian card that owns that file (from the local registry defs, which always
// know every core plugin and card); appearanceLabel = the Appearance card's display label, the
// breadcrumb every snippets/themes file wears.
export interface LeftoverNames {
  pluginLabels: ReadonlyMap<string, string>;
  fileOwners: ReadonlyMap<string, { section: "obsidian" | "core"; label: string }>;
  appearanceLabel: string;
}

// The list-membership compile BOTH delta sides share: items compiled WITH
// synthesized defs for ids whose plugin isn't installed here, so an item this data.json carries
// never drops out of membership just because its plugin is absent on this device. betaIds comes
// from the caller (main.ts's `bratRepoIndex(this.settings.items)`) so a synthesized def
// classifies the same way an installed one would.
export function selfListGroups(defs: ItemDef[], items: ItemMap, betaIds: ReadonlySet<string>): SyncGroup[] {
  return compileItems(defsForForeignItems(defs, items, betaIds), { items });
}

// The sync list carried inside the store's own config-sync copy
// (`store/configdir/plugins/config-sync/data.json`). Files a device has pulled but not yet
// adopted are attributable to this list, so callers pass local ∪ store-list groups to
// `leftoverStoreRels` — pulled-but-unadopted data is pending, never deletable "leftover".
// Schema v1 persisted the compiled `groups` list verbatim; v3 persists `items` (section -> id ->
// item, custom items included), so the list must be recompiled (against the local defs, extended
// for store items whose plugin isn't installed here — defsForForeignItems, via selfListGroups).
//
// A v2 copy is MIGRATED IN MEMORY first (v2Migration.ts). That is not an edge case: for the whole
// transition window the store is still written by devices on 2.21.0, so a v3 device reading a v2
// self copy is the NORMAL state, and reading it as `[]` would be actively harmful in three places —
// the self pane would report every item as added (or read cold-start), the leftover view would
// offer other devices' store files as deletable, and readStoreContractLocals would return an empty
// map, switching OFF the store-contract this-device strip so this device could publish its own
// device-local values into the store. Nothing is written back and the lock is not touched: this is
// a read boundary — the store's own re-key happens elsewhere.
// Best-effort by contract otherwise: malformed or uncompilable foreign content yields [] rather
// than breaking status/leftover views.
export function storeSelfCopyGroups(json: string, defs: ItemDef[], betaIds: ReadonlySet<string>): SyncGroup[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return [];
    // The version gate, on the read side: a store copy written by a NEWER build is not
    // ours to compile — its `items` may mean something this build cannot see, and every consumer of
    // this list (the self pane's delta, leftover attribution, the store-contract strip) would then
    // act on a reading we invented. Empty is what this function already answers for content it
    // cannot make sense of. Asked of the object already parsed above, through the same
    // classifySettings every other gate routes through (N5: isFutureSchemaDocument would re-parse
    // the same text a second time).
    if (classifySettings(parsed as Record<string, unknown>).kind === "future") return [];
    const raw = parsed as { groups?: unknown; items?: unknown };
    if (Array.isArray(raw.groups)) return raw.groups as SyncGroup[];
    // The SAME chain the load path runs (main.ts's loadSettings), not a second opinion about
    // versions: each step rewrites only the version it owns, so a v4 copy passes through both
    // untouched. The v3 step is what makes a store copy written by 2.22.0 readable at all — that
    // build spelled an item's sync flag `enabled`, which nothing here reads any more, so without it
    // a foreign v3 self copy would compile to nothing and the self pane would report every item as
    // added.
    const items = migrateV4Settings(migrateV2Settings(parsed as Record<string, unknown>).document).document.items;
    if (typeof items !== "object" || items === null) return [];
    return selfListGroups(defs, items as ItemMap, betaIds);
  } catch {
    return [];
  }
}

function basenameOf(storeInner: string): string {
  const cut = storeInner.lastIndexOf("/");
  return cut < 0 ? storeInner : storeInner.slice(cut + 1);
}

// A real identity for an orphaned store file — the name slot never shows a raw store path
// (DESIGN.md's Leftover section): a plugin file names its plugin (label, else bare id); a
// snippets/themes file names its basename behind the Appearance breadcrumb; a config-root file
// whose basename a core plugin or an Obsidian card owns names that owner; everything else names
// its basename. The full path stays on the row's own mono line.
function deriveDisplay(storeInner: string, names: LeftoverNames): { section: LeftoverSection; name: string; crumb: string | null } {
  const m = storeInner.match(/^configdir\/plugins\/([^/]+)\//);
  if (m !== null && m[1] !== undefined) return { section: "community", name: names.pluginLabels.get(m[1]) ?? m[1], crumb: null };
  if (/^configdir\/(snippets|themes)\//.test(storeInner)) {
    return { section: "obsidian", name: basenameOf(storeInner), crumb: names.appearanceLabel };
  }
  if (storeInner.startsWith("configdir/")) {
    const basename = basenameOf(storeInner);
    const owner = names.fileOwners.get(basename);
    if (owner !== undefined) return { section: owner.section, name: owner.label, crumb: null };
    return { section: "obsidian", name: basename, crumb: null };
  }
  return { section: "other", name: basenameOf(storeInner), crumb: null };
}

// Store files that belong to no current group — settings config-sync saved for items no
// longer tracked. Bookkeeping (store.lock.json, config-sync.json) lives outside "store/" and
// is naturally excluded; only rels under "store/" that groupForStoreRel can't attribute count.
export function leftoverStoreRels(rels: string[], groups: SyncGroup[], names: LeftoverNames): LeftoverFile[] {
  const out: LeftoverFile[] = [];
  for (const rel of rels) {
    if (!rel.startsWith("store/")) continue;
    if (groupForStoreRel(groups, rel).name !== "") continue;
    const inner = rel.slice("store/".length);
    const display = deriveDisplay(inner, names);
    out.push({ rel, section: display.section, name: display.name, crumb: display.crumb, path: inner });
  }
  // Grouped presentation order: section (main-list order, "other" last), then name within.
  return out.sort((a, b) => {
    const s = LEFTOVER_SECTION_ORDER.indexOf(a.section) - LEFTOVER_SECTION_ORDER.indexOf(b.section);
    return s !== 0 ? s : a.name.localeCompare(b.name);
  });
}
