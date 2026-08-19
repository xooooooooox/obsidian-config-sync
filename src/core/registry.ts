/**
 * Item registry + compile-to-groups. A single flat registry of
 * ItemDefs (one per card: the three Obsidian cards, every core plugin, every installed
 * community/beta plugin) plus the v3 settings shape (`ConfigSyncSettings.items: Record<Section,
 * Record<ItemId, Item>>`) that stores each card's own configuration. `compileItems` is the ONLY
 * place that turns (defs, settings) into the `SyncGroup[]` the existing capture/apply engine
 * (ConfigSyncCore.ts) already knows how to run — everything downstream of compile is untouched.
 *
 * Structure carries the taxonomy since v3: an item's section is where it LIVES in the document,
 * not a prefix parsed out of its key, so a core and a community plugin may legitimately share an
 * id. Nothing flattens the two levels back into one map on the way through.
 *
 * Every registry item, including the "app" card (app.json), compiles through the same
 * `compileSingleFile` path — there is no shared/merged carrier: a single-file item's Plain-mode
 * `fileRule.sharing` is elevated to the compiled group's top-level `devices` class, uniformly.
 */
import { communityGroupName, corePluginFile, mergePresetFields, SELF_GROUP_NAME } from "./catalog";
import { GROUP_NAME_RE } from "./manifest";
import { basename, groupStorePath } from "./pathing";
import { companionRef } from "./itemKeys";
import { EnablementList, SWITCH_LISTS } from "./switchList";
import {
  DeviceClass,
  EVERYWHERE,
  FieldRule,
  FileRule,
  ItemId,
  itemRef,
  ItemRef,
  perClass,
  PerElementSharing,
  Section,
  Sharing,
  StorageSection,
  SyncGroup,
  SyncMode,
} from "./types";

// The registry's declaration of which items are carriers: the two
// on/off lists an item's enablement can ride. This replaces switchList.ts's hardcoded group-name
// set as the answer to "is this group an enablement carrier?" — the registry knows, because every
// def that has an enablement names its list here.
export const ENABLEMENT_LISTS: readonly EnablementList[] = ["core-plugins", "community-plugins"];

export function isEnablementList(name: string): name is EnablementList {
  return (ENABLEMENT_LISTS as readonly string[]).includes(name);
}

export interface ItemDef {
  // Identity is structural: section says which family, id is bare inside it. Two ids may
  // collide across sections — that is the point of nesting.
  section: Section;
  id: ItemId;
  // The name this item's settings file compiles to. Written here, at construction, rather than
  // derived by a `legacyGroupName(id)` parser: the group name is the store lock's and the
  // baselines' key, so it is LINEAGE — a community item's group stays `plugin-<id>` until the lock
  // is re-keyed to an ItemRef. Nothing reads meaning back OUT of it; consumers take section/id.
  groupName: string;
  label: string;
  description: string;
  enablement?: { list: EnablementList; element: string };
  settingsFile?: { defaultPath: string | null };
  presetCompanions?: { path: string; mapKey?: string }[];
  // The plugin manifest's isDesktopOnly (community/beta only, set only when true) — an innate
  // property (the plugin cannot install on mobile), distinct from a user's own enablement choice.
  // Drives the neutral "desktop-only plugin" card badge and trims "mobile" out of the ENABLED ON
  // cycle.
  desktopOnly?: boolean;
}

// The map KEY is the key-name pattern: a bare {sharing, encrypted, locked?} per key, deliberately
// without FieldRule's own `pattern` field so there is exactly one source of truth for which key a
// rule governs (the map key), not two that could disagree.
export type ItemFieldRule = Omit<FieldRule, "pattern">;

export interface ItemSettingsFile {
  // A registry item is only ever "plain" or "fields" — its mode is DERIVED from whether it has any
  // per-key rules (itemCard.ts's deriveMode), never chosen. "encrypted" exists here for `custom`
  // items alone, which do choose it: the Advanced tab's Mode dropdown offers Plain/Fields/Encrypt
  // on every custom rule, and v2 stored that choice on the SyncGroup literal that then carried a
  // custom rule. Narrowing it away here would turn a user's encrypted rule into a plaintext one at the next
  // capture, which is a data change, not a shape change (see customGroup/customItemFromGroup).
  mode: SyncMode;
  fileRule?: FileRule;
  rules: Record<string, ItemFieldRule>;
  perElement: Record<string, PerElementSharing>;
}

// Derived mode: the stored mode is written by
// the UI, never chosen by the user — any per-key customization makes the card per-key ("fields");
// none makes it whole-file ("plain").
//
// The reserved perElement key "" (switchList.ts's perElementKeyFor) is excluded ON PURPOSE:
// it means "this whole file is the list", which is the very definition of a whole-file
// group. Counting it would compile core-plugins.json as a fields-mode group and send a boolean map
// down perElement.ts's string-array path, which cannot read it.
export function deriveMode(sf: ItemSettingsFile): "plain" | "fields" {
  return Object.keys(sf.rules).length > 0 || Object.keys(sf.perElement).some((k) => k !== "") ? "fields" : "plain";
}

export function defaultSettingsFile(): ItemSettingsFile {
  return { mode: "plain", rules: {}, perElement: {} };
}

// Prunes semantic defaults off a settingsFile so a sharing round-trip (e.g. desktop →
// everywhere) leaves data.json byte-identical to before the round started, instead of
// write-back residue. Two independent prunes, applied in order: a
// fileRule of exactly {sharing: everywhere, encrypted:false} carries no information (it's what an
// absent fileRule already means) and is dropped; if the settingsFile is then left deep-equal to
// defaultSettingsFile() — plain mode, no fileRule, empty rules/perElement — the whole key is
// dropped too, so the field never persists just to say "nothing is customized". Any real content
// (encrypted:true, a rule, a perElement entry, a non-plain mode) always survives untouched. The
// item's own `path` is NOT part of this: it lives on the Item since v3, not inside settingsFile.
export function pruneSettingsFile(sf: ItemSettingsFile): ItemSettingsFile | undefined {
  const fileRule = sf.fileRule !== undefined && sf.fileRule.sharing.kind === "everywhere" && !sf.fileRule.encrypted ? undefined : sf.fileRule;
  const pruned: ItemSettingsFile = { ...sf, fileRule };
  const isDefault =
    pruned.mode === "plain" && pruned.fileRule === undefined && Object.keys(pruned.rules).length === 0 && Object.keys(pruned.perElement).length === 0;
  return isDefault ? undefined : pruned;
}

export interface ItemCompanion {
  path: string;
  device: DeviceClass;
  enabled: boolean;
}

// One item's stored configuration. The same shape for every section: a `custom` item is
// not a second data shape (v2's `customGroups: SyncGroup[]`) — it is an item whose `path` and
// `type`, which a registry item derives from its def, are simply required.
export interface Item {
  // Is this item synced at all? Deliberately not called `enabled`: that word would mean two different
  // things one line apart — "this item is synced" and "this plugin is turned on" — and the second
  // meaning is not stored here at all (it lives in Obsidian's own on/off lists, and config-sync
  // only masks them). One word, one meaning.
  synced: boolean;
  // Only meaningful for a custom item, where it is required; a registry item's type is always
  // "file" (its settings file) and is left absent.
  type?: "file" | "folder";
  // Set only when it differs from the item's default path (v2's `settingsFile.customPath`);
  // required for a custom item, which has no def to derive one from.
  path?: string;
  // The BRAT repo this plugin was installed from ("owner/repo"), when BRAT manages it.
  // Deliberately not a top-level `bratIndex` map — that would be a SECOND list of plugin ids beside
  // `items.community`, one list too many: the two drift the moment a plugin is removed from one
  // and not the other. A property of a plugin lives on that plugin.
  bratRepo?: string;
  settingsFile?: ItemSettingsFile;
  companions?: ItemCompanion[];
  // Custom items only — kept from the v2 SyncGroup literal.
  description?: string;
  label?: string;
  origin?: "discovered";
}

// The document's item store: stored section -> id -> item. Two levels, never flattened, and never
// a `beta` key — see StorageSection.
export type ItemMap = Record<StorageSection, Record<ItemId, Item>>;

export function emptyItemMap(): ItemMap {
  return { obsidian: {}, core: {}, community: {}, custom: {} };
}

// THE bridge from the presented section to the stored one — the only place `beta`
// becomes `community`, and the only way to obtain a StorageSection from a Section. Everything that
// keys storage (the accessors below, `defRef`, `groupOwners`) goes through it, so a beta item can
// never acquire an identity of its own.
export function storageSection(section: Section): StorageSection {
  return section === "beta" ? "community" : section;
}

// An item def's identity as the one-string ref localStorage and the hosts speak. The single
// def → ref conversion: a caller that reached for `itemRef(def.section, …)` would not compile,
// because `def.section` may be `beta`.
export function defRef(def: ItemDef): ItemRef {
  return itemRef(storageSection(def.section), def.id);
}

// THE matching counterpart of defRef, and the reason it exists: closing a
// leak by construction protects MINTING, not MATCHING. `itemRef` cannot be handed a `beta`, but
// nothing stopped a comparison like `def.section === parsed.section` — where the left side is the
// PRESENTED section ("beta") and the right the stored one ("community") — from silently never
// matching. A def and a ref are only ever compared through this function, so both sides of the
// comparison go through `storageSection` exactly once, the same way both sides of a construction
// do.
export function defForRef(defs: ItemDef[], ref: ItemRef): ItemDef | undefined {
  return defs.find((d) => defRef(d) === ref);
}

export function itemAt(items: ItemMap, section: Section, id: ItemId): Item | undefined {
  return items[storageSection(section)]?.[id];
}

export function itemFor(items: ItemMap, def: ItemDef): Item {
  return itemAt(items, def.section, def.id) ?? emptyItem();
}

//
// AN ENTRY'S PRESENCE IS LOAD-BEARING. An id that is in the store's on/off list but has no def here (the plugin is
// not installed) still needs its entry: the item is what a rule, a lock label and a baseline are
// keyed by. Delete the entry and those go with it, and the next capture can remove that plugin from
// the shared list for every device.
//
// So `{synced: false}` is NOT residue, however much it looks like it. It is what an absent entry
// is not, in the one place that matters most. Do not prune it on write by analogy with
// `pruneSettingsFile` ("a round trip leaves data.json as it found it") — the
// analogy is false, because that prunes a FIELD whose absence and default agree, while this would
// prune the entry whose existence IS the decision.
//
// A rule lives on the CARRIER item (core-plugins/community-plugins), not on the
// plugin's own entry, so every entry earns a def, `{synced:false}`
// included — which is how a card the user turned off is turned back ON. See
// defsForForeignItems below, whose `known.has(id)` guard is the whole test.
//
// Pure: returns a new map with one item replaced, both levels copied. It never removes an entry —
// in `core`/`community` an entry's mere presence is this device's capture mask for that on/off-list
// element, so a write is not free to decide the entry has nothing to say.
export function withItem(items: ItemMap, section: Section, id: ItemId, item: Item): ItemMap {
  const store = storageSection(section);
  return { ...items, [store]: { ...(items[store] ?? {}), [id]: item } };
}

export function withoutItem(items: ItemMap, section: Section, id: ItemId): ItemMap {
  const store = storageSection(section);
  const next = { ...(items[store] ?? {}) };
  delete next[id];
  return { ...items, [store]: next };
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export function emptyItem(): Item {
  return { synced: false };
}


export interface RegistryCoreEnv {
  id: string;
  name: string;
  fileExists: boolean; // runtime info only: whether ${corePluginFile(id)} exists now (does not gate the settings path)
}

export interface RegistryPluginEnv {
  id: string;
  name: string;
  desktopOnly?: boolean; // manifest isDesktopOnly === true; absent means false
}

export interface RegistryEnv {
  cores: RegistryCoreEnv[]; // full runtime core-id list, INCLUDING state-only (no settings file yet)
  plugins: RegistryPluginEnv[]; // installed community + beta plugins, scanned from the plugins dir
  betaIds: ReadonlySet<string>; // subset of plugins.id managed by BRAT → section "beta"
}

const OBSIDIAN_CARD_DEFS: readonly Omit<ItemDef, "section">[] = [
  {
    id: "app",
    groupName: "app",
    label: "App settings",
    description: "Editing, new-note and link behavior, and other general options.",
    settingsFile: { defaultPath: "{configDir}/app.json" },
  },
  {
    id: "appearance",
    groupName: "appearance",
    label: "Appearance",
    description: "Theme, fonts and CSS snippets.",
    settingsFile: { defaultPath: "{configDir}/appearance.json" },
    presetCompanions: [{ path: "{configDir}/themes" }, { path: "{configDir}/snippets", mapKey: "enabledCssSnippets" }],
  },
  {
    id: "hotkeys",
    groupName: "hotkeys",
    label: "Hotkeys",
    description: "Your custom keyboard shortcuts.",
    settingsFile: { defaultPath: "{configDir}/hotkeys.json" },
  },
  // The two on/off lists. They were already items in every way that matters —
  // itemKeys.ts's carrierRef has keyed their lock entry and their baseline under `obsidian/<list>`
  // since v3, and the comment there ends "A carrier IS an item". The only things they lacked were a
  // data.json entry and a card, which is what this def gives them. `defRef` mints the SAME string
  // carrierRef does, so nothing is re-keyed and no baseline is orphaned.
  {
    id: "core-plugins",
    groupName: "core-plugins",
    label: "Core plugins",
    description: "Which core plugins are turned on.",
    settingsFile: { defaultPath: "{configDir}/core-plugins.json" },
  },
  {
    id: "community-plugins",
    groupName: "community-plugins",
    label: "Community plugins",
    description: "Which community plugins are turned on.",
    settingsFile: { defaultPath: "{configDir}/community-plugins.json" },
  },
] as const;

const COMMUNITY_PLUGIN_DESCRIPTION = "";

// Deterministic display order: core and community/beta each sort by their own label,
// independent of runtime scan order — the obsidian section keeps its fixed App settings/
// Appearance/Hotkeys/Core plugins/Community plugins order from OBSIDIAN_CARD_DEFS.
function byLabel(a: ItemDef, b: ItemDef): number {
  return a.label.localeCompare(b.label, "en", { sensitivity: "base" });
}

export function buildItemDefs(env: RegistryEnv): ItemDef[] {
  const obsidian: ItemDef[] = OBSIDIAN_CARD_DEFS.map((d) => ({ ...d, section: "obsidian" }));

  const core: ItemDef[] = env.cores.map((c) => ({
    section: "core",
    id: c.id,
    groupName: c.id,
    label: c.name,
    description: "",
    enablement: { list: "core-plugins", element: c.id },
    settingsFile: { defaultPath: `{configDir}/${corePluginFile(c.id)}` },
  }));
  core.sort(byLabel);

  const communityAndBeta: ItemDef[] = env.plugins.map((p) => ({
    section: env.betaIds.has(p.id) ? "beta" : "community",
    id: p.id,
    groupName: communityGroupName(p.id),
    label: p.name,
    description: COMMUNITY_PLUGIN_DESCRIPTION,
    enablement: { list: "community-plugins", element: p.id },
    settingsFile: { defaultPath: `{configDir}/plugins/${p.id}/data.json` },
    ...(p.desktopOnly ? { desktopOnly: true } : {}),
  }));
  communityAndBeta.sort(byLabel);

  return [...obsidian, ...core, ...communityAndBeta];
}

// Extends a defs list with a synthesized community/beta def for every stored community item whose
// plugin has no installed def yet. Two callers need this: leftover.ts's storeSelfCopyGroups/
// selfListGroups (parsing ANOTHER device's settings, where the id's plugin may never have run
// here) and main.ts's recompile() (compiling THIS device's own settings.items, where a plugin the
// user selected but hasn't installed yet — e.g. install-on-apply's pending target — has no
// installed def either). Without these, such an item would silently drop out of the compiled
// list: on the foreign-parse side its pulled-but-unadopted store files would read as deletable
// leftover instead of pending data; on the local side install-on-apply would have no group to
// pull the plugin's own settings into once it lands. Only community ids are synthesizable from
// the id alone; core ids map to per-plugin settings files that corePluginFile only knows for
// locally-known cores, and the three Obsidian cards exist in every registry. betaIds classifies a
// synthesized def the same way buildItemDefs does for an installed one, so a BRAT-managed id
// still reads as "beta" instead of falling back to "community".
//
// An entry that reaches here for an uninstalled id always means someone chose something about THIS item.
export function defsForForeignItems(defs: ItemDef[], items: ItemMap, betaIds: ReadonlySet<string>): ItemDef[] {
  const known = new Set(defs.filter((d) => storageSection(d.section) === "community").map((d) => d.id));
  const extras: ItemDef[] = [];
  for (const id of Object.keys(items.community ?? {})) {
    if (known.has(id)) continue;
    extras.push({
      section: betaIds.has(id) ? "beta" : "community",
      id,
      groupName: communityGroupName(id),
      label: id,
      description: COMMUNITY_PLUGIN_DESCRIPTION,
      enablement: { list: "community-plugins", element: id },
      settingsFile: { defaultPath: `{configDir}/plugins/${id}/data.json` },
    });
  }
  return extras.length === 0 ? defs : [...defs, ...extras];
}


// The shape compileItems needs out of ConfigSyncSettings — spelled out structurally (rather than
// imported from main.ts) so this module never depends on the plugin's top-level settings type.
export interface CompileSettings {
  items: ItemMap;
}

function fieldsFromRules(rules: Record<string, ItemFieldRule>): FieldRule[] {
  return Object.entries(rules).map(([pattern, rule]) => ({ pattern, ...rule }));
}

// The reserved "" key (switchList.ts's perElementKeyFor mints it for a whole-file switch list) never
// belongs in a COMPILED group's perElement: that map is keyed by JSON field names, and "" names no
// field a document could ever have. This is not re-deriving what "" means (that stays perElementKeyFor's
// job alone) — it is refusing an impossible field name, on the same footing as any other value this
// compile step cannot make sense of. Without this, a carrier item that also picked up a stray `rules`
// entry (e.g. via the File preview's click-to-add) flips into "fields" mode and copies its
// element rules — stored under "" — onto the compiled group, which captureTransform then reads as a
// per-element ARRAY key named "" and writes `"": []` into the switch-list file, silently corrupting it.
function perElementFromMap(perElement: Record<string, PerElementSharing>): Record<string, PerElementSharing> | undefined {
  const entries = Object.entries(perElement).filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Registers a group's real path against the collision map — throws a CompileError naming both
// items when two different items' carriers land on the same store location (rule: dedupe +
// reject on path collision with an existing item).
function claimPath(seen: Map<string, string>, owner: string, path: string): void {
  const key = groupStorePath(path);
  const existing = seen.get(key);
  if (existing !== undefined && existing !== owner) {
    throw new CompileError(`"${owner}" and "${existing}" both sync "${path}" — give one of them a different path.`);
  }
  seen.set(key, owner);
}

// Compiles one item's own single-file settingsFile into a SyncGroup — every registry item
// (the three Obsidian cards, every core/community/beta plugin file) goes through this one path.
// Merges config-sync's own locked local-only presets (rootPath, remotes — see catalog.ts's
// selfPresetRules) into a compiled group for the self item, no matter what the user
// configured: these fields must NEVER leave the device, even under a future UI bug or a
// hand-edited data.json. Delegates to catalog.ts's mergePresetFields — the ONE shared
// implementation — rather than reimplementing the preset+rest merge here: this is the
// compile path that feeds both adoptConfiguration's apply and the self item's status/diff
// compare, so keeping it a single function call (not a second hand-maintained merge) guarantees
// a field can never be excluded from one but not the other.
// Forcing "fields" mode also clears any Plain-branch `fileRule` the incoming group might carry
// (e.g. a hand-edited data.json with the self item still on settingsFile.mode "plain" plus a
// fileRule): manifest.ts rejects "fields" mode combined with a fileRule, and since compileItems
// validates ALL compiled groups together, one bad self group would otherwise freeze every
// compiledGroups update, not just this one.
function withSelfPresets(group: SyncGroup): SyncGroup {
  if (group.name !== SELF_GROUP_NAME) return group;
  return { ...group, mode: "fields", fields: mergePresetFields(group.fields ?? []), fileRule: undefined };
}

// A file-level rule's sharing IS the compiled group's devices class (FileSharing excludes
// this-device by construction, so this is always a valid DeviceClass).
function devicesForFileRule(rule: FileRule): DeviceClass {
  return sharingClassOrAll(rule.sharing);
}

function sharingClassOrAll(sharing: Sharing): DeviceClass {
  return sharing.kind === "per-class" ? sharing.class : "all";
}

function compileSingleFile(def: ItemDef, item: Item): SyncGroup | null {
  const defaultPath = def.settingsFile?.defaultPath ?? null;
  if (!item.synced || defaultPath === null) return null; // off, or state-only (no file to sync yet)
  const path = item.path ?? defaultPath;
  const mode = item.settingsFile?.mode ?? "plain";
  // `ref` is the item's identity and the key of the lock, the baselines and the opt-out list;
  // `name` stays the store-path label and the manifest's uniqueness rule. Minted HERE, at
  // the one place that knows both — a consumer that derived it from the name would be a second
  // producer, and two producers drift.
  const group: SyncGroup = { name: def.groupName, ref: defRef(def), path, type: "file", devices: "all" };
  // Carried, not enumerated — the same rule customGroup follows. A registry item's mode
  // is DERIVED (itemCard.ts's deriveMode), so only "plain"/"fields" are reachable through the UI.
  // For a hand-edited document that says something else, the outcome depends on what it says: a
  // value outside SyncMode reaches validateSyncManifest and is refused loudly, while "encrypted" is
  // ACCEPTED there and simply compiles as an encrypted group. Either way the document is honoured
  // instead of being quietly rewritten to plain, which is what an enumeration would do.
  if (mode !== "plain") group.mode = mode;
  if (mode === "fields") {
    const fields = fieldsFromRules(item.settingsFile?.rules ?? {});
    if (fields.length > 0) group.fields = fields;
    const perElement = perElementFromMap(item.settingsFile?.perElement ?? {});
    if (perElement !== undefined) group.perElement = perElement;
  } else if (mode === "plain" && item.settingsFile?.fileRule !== undefined) {
    group.fileRule = item.settingsFile.fileRule;
    group.devices = devicesForFileRule(item.settingsFile.fileRule);
  }
  return withSelfPresets(group);
}

// A companion's key is its OWNER's, plus its own basename (itemKeys.ts's companionRef explains
// why): a companion has no identity of its own, and its group name is unique only because
// companionNameConflict forbids a clash. The two are minted side by side here so the name a group
// compiles to and the key its baseline lands under can never be derived from different rules.
function compileCompanions(def: ItemDef, item: Item): SyncGroup[] {
  if (!item.synced) return []; // card off → its file AND its companions exit sync together
  const owner = defRef(def);
  return (item.companions ?? [])
    .filter((c) => c.enabled)
    .map((c) => ({ name: basename(c.path), ref: companionRef(owner, c.path), path: c.path, type: "folder" as const, devices: c.device }));
}

export interface GroupDisplayParts {
  parent: string | null;
  label: string;
}

// Parent card label for a card-derived group — an enabled companion (matched exactly the way
// compileCompanions emits group names) or the enabled-css-snippets switch list (governed by the
// Appearance card). null = standalone group. The Sync Center renders these as "Parent › Name";
// the composed form is display-only and must never be persisted (only the lock's own label field,
// written at capture, carries a resolved display name for a not-installed group).
export function parentCardLabel(groupName: string, defs: ItemDef[], settings: CompileSettings): string | null {
  // compileItems never emits this name (see the reserved-name note above) — the branch covers a
  // store manifest, which can still carry the group at runtime (main.ts special-cases it too).
  if (groupName === "enabled-css-snippets") return defs.find((d) => d.section === "obsidian" && d.id === "appearance")?.label ?? "Appearance";
  for (const def of defs) {
    const item = itemFor(settings.items, def);
    if (!item.synced) continue;
    if ((item.companions ?? []).some((c) => c.enabled && basename(c.path) === groupName)) return def.label;
  }
  return presetCompanionFallback(groupName, defs, settings);
}

// Preset-companion basename fallback (2026-08-07-c-livetest-batch4 task 1, remote pane): a def's
// static presetCompanions (e.g. appearance's themes/snippets) still resolve to their card label
// even when the user has never configured that companion at all — display-only, so it applies
// regardless of the card's or companion's enabled state. Only fires once the def's OWN companions
// have nothing configured under this basename, so an actually-configured entry (enabled or not)
// keeps its existing null/loop-match behavior untouched.
function presetCompanionFallback(groupName: string, defs: ItemDef[], settings: CompileSettings): string | null {
  for (const def of defs) {
    if (def.presetCompanions === undefined) continue;
    if (!def.presetCompanions.some((p) => basename(p.path) === groupName)) continue;
    const item = itemFor(settings.items, def);
    if ((item.companions ?? []).some((c) => basename(c.path) === groupName)) continue; // already configured — no fallback
    return def.label;
  }
  return null;
}

// Per-element enablement sharing is stored, not derived: the rule lives on the carrier item's
// `perElement` map (enablementRules.ts) and is read from there, so a rule is a thing the user
// wrote rather than a side effect of whether a card happens to be switched on.

// Every group name the registry itself can ever produce plus the three switch-list names.
// "community-plugins"/"core-plugins" are already in the first set (they are ordinary
// registry defs, so groupOwners already names them); "enabled-css-snippets" never is its own
// group but is still reserved so a custom rule can't shadow the vocabulary a user already
// associates with it. A custom rule's name must be its own, unambiguous identity.
function reservedCustomGroupNames(defs: ItemDef[]): Set<string> {
  return new Set<string>([...Object.keys(groupOwners(defs, emptyItemMap())), ...Object.keys(SWITCH_LISTS)]);
}

// Compiles the `custom` section into the same SyncGroup[]
// the registry-derived cards produce — the Advanced tab's "Custom rules"/"Discovered files" do
// not have to fend for themselves with a session-only groupsIO write. Path claims go through
// the SAME claimPath accounting compileItems already runs for every registry item (collision with
// a registry item OR another custom item throws), and a name that shadows a reserved/registry name
// is rejected outright — the same "no silent gaps" contract compileItems applies everywhere else.
// A blank name (the Advanced tab's in-memory-only "+ Add rule" placeholder — see commitGroups.ts's
// culprit-blank filter) is skipped rather than rejected: it never reaches settings in the first
// place, so this is defense in depth, not a real code path.
// ORDER: `Object.entries` yields integer-like keys first, ascending, before the rest in insertion
// order — so a custom rule whose NAME is all digits ("2024") compiles ahead of the others, where
// v2's `customGroups` array kept authored order. GROUP_NAME_RE permits such a name, so this is
// reachable; it moves a row in the Advanced tab's list and nothing else (order carries no meaning
// for capture/apply, and every collision check is order-independent). Accepted rather than papered
// over with a sort, which would change the order of the common case too; a stored order field is a
// shape change no user has asked for.
function compileCustomItems(items: ItemMap, defs: ItemDef[], seenPaths: Map<string, string>): SyncGroup[] {
  const reserved = reservedCustomGroupNames(defs);
  const seenNames = new Set<string>();
  const groups: SyncGroup[] = [];
  for (const [rawName, item] of Object.entries(items.custom ?? {})) {
    const name = rawName.trim();
    if (name === "") continue;
    // Checked HERE, not left to validateSyncManifest downstream: a compile error
    // names the offending rule in the Notice the user actually sees, where the validator's failure
    // arrives as a generic "your sync setup has an invalid rule" with no culprit — and it also
    // decides which key the item takes, so a name that cannot be one must fail before it mints one.
    if (!GROUP_NAME_RE.test(name)) {
      throw new CompileError(`"${name}" is not a valid custom rule name — use only letters, digits, "-" or "_", starting with a letter or digit.`);
    }
    if (reserved.has(name)) throw new CompileError(`"${name}" is a reserved name — rename this custom rule.`);
    if (seenNames.has(name)) throw new CompileError(`two custom rules are both named "${name}" — rename one of them.`);
    seenNames.add(name);
    if (!item.synced) continue;
    const path = item.path ?? "";
    claimPath(seenPaths, itemRef("custom", name), path); // never `custom/${name}` — one minter, same as defRef above
    groups.push(customGroup(name, item, path));
  }
  return groups;
}

// Every field of an Item this build writes for itself. Anything else on a stored item is a field a
// NEWER build recorded, and it rides through untouched — the same
// discipline manifest.ts's lockEntryTail applies to a lock entry. Without it, the custom section's
// round trip (item -> compiled group -> Advanced-tab draft -> item) would strip the future's data
// and publish the loss to the fleet on the next capture, which is exactly what v2's `{...cg}`
// spread happened to avoid.
export const WRITTEN_ITEM_KEYS = ["synced", "type", "path", "bratRepo", "settingsFile", "companions", "description", "label", "origin"] as const;

export function itemTail(item: Item | undefined): Record<string, unknown> {
  if (item === undefined) return {};
  const tail: Record<string, unknown> = { ...item };
  for (const key of WRITTEN_ITEM_KEYS) delete tail[key];
  return tail;
}

// The same, one shape over: the SyncGroup fields a custom item round-trips through.
const WRITTEN_CUSTOM_GROUP_KEYS = ["name", "ref", "path", "type", "devices", "mode", "fields", "fileRule", "perElement", "description", "label", "origin"] as const;

function customGroupTail(group: SyncGroup): Record<string, unknown> {
  const tail: Record<string, unknown> = { ...group };
  for (const key of WRITTEN_CUSTOM_GROUP_KEYS) delete tail[key];
  return tail;
}

// A tail crossing the Item/SyncGroup boundary must not land on a field the DESTINATION shape
// already owns: the two shapes share names — `mode`, `fields`, `fileRule`,
// `perElement` are SyncGroup fields today and could become Item fields tomorrow — so an unfiltered
// spread would let a value written for one be read as the other. Dropping the collision is the
// safe half of the trade and it only ever happens on the DERIVED side: the compiled group is
// rebuilt from the item on every load, while the item itself keeps every key it arrived with.
function withoutKeys(tail: Record<string, unknown>, owned: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...tail };
  for (const key of owned) delete out[key];
  return out;
}

// A custom item's compiled group. `path`/`type` are the item's own (required there).
//
// A custom item's device class is its file-level sharing — the same field, the same menu and the
// same writer as every registry item's `Settings sync`, never a second expression of one idea.
// manifest.ts refuses a `fileRule` on a folder group (whole-file encryption is a single-file
// notion), so a folder's sharing is ELEVATED into `devices` and not emitted as a rule.
//
// The item's carried tail leads, so a field this build does not know rides out to every consumer
// of the compiled list exactly as v2's `{...cg}` did.
function customGroup(name: string, item: Item, path: string): SyncGroup {
  const carried = withoutKeys(itemTail(item), WRITTEN_CUSTOM_GROUP_KEYS) as Partial<SyncGroup>;
  const sharing = item.settingsFile?.fileRule?.sharing ?? EVERYWHERE;
  const group: SyncGroup = { ...carried, name, ref: itemRef("custom", name), path, type: item.type ?? "folder", devices: sharingClassOrAll(sharing) };
  // The mode is CARRIED, not enumerated. A ternary chain over SyncMode
  // would silently rewrite "encrypted" to "plain", and a fourth value would
  // regress the same way; passing the stored value through means only the per-mode PAYLOAD needs a
  // branch, and a mode this build has never heard of reaches the validator to be refused loudly
  // rather than being quietly downgraded.
  const mode = item.settingsFile?.mode ?? "plain";
  if (mode !== "plain") group.mode = mode;
  if (mode === "fields") {
    const fields = fieldsFromRules(item.settingsFile?.rules ?? {});
    if (fields.length > 0) group.fields = fields;
    const perElement = perElementFromMap(item.settingsFile?.perElement ?? {});
    if (perElement !== undefined) group.perElement = perElement;
  } else if (mode === "plain" && item.settingsFile?.fileRule !== undefined && group.type === "file") {
    group.fileRule = item.settingsFile.fileRule;
  }
  if (item.description !== undefined) group.description = item.description;
  if (item.label !== undefined) group.label = item.label;
  if (item.origin !== undefined) group.origin = item.origin;
  return group;
}

// The inverse of customGroup, for the Advanced tab, which edits custom rules as SyncGroup drafts
// (its form has always spoken that shape) and persists them as items. Pure; the name is the map
// key, so it is not carried inside the item.
//
// `existing` is the item this draft replaces, and it is where the carried tail really comes from:
// the draft has been through manifest.ts's parseGroup, which rebuilds a group from a whitelist, so
// a field a newer build wrote is already gone by the time the tab sees it. Reading the tail off
// storage is what makes the round trip lossless; the draft's own tail is
// layered on top for the case where it did survive.
export function customItemFromGroup(g: SyncGroup, existing?: Item): Item {
  const item: Item = { ...itemTail(existing), ...withoutKeys(customGroupTail(g), WRITTEN_ITEM_KEYS), synced: true, type: g.type, path: g.path };
  // Same rule as customGroup's, in the other direction: the group's own mode is stored
  // verbatim, so no value of SyncMode can be lost by an enumeration that forgot it. An absent mode
  // means plain, which is the only reading a group without one ever had.
  //
  // The device class is the SAME field as a registry item's file-level sharing (customGroup's own
  // comment) — a per-class `devices` compiles to a fileRule here exactly as it did in the other
  // direction, merging any `encrypted` flag the group's own fileRule already carries (a file-type
  // custom item can set both from the same menu vocabulary; a folder never has one to merge with).
  if ((g.mode !== undefined && g.mode !== "plain") || g.fileRule !== undefined || g.devices !== "all") {
    const fileRule: FileRule | undefined = g.devices !== "all" ? { sharing: perClass(g.devices), encrypted: g.fileRule?.encrypted ?? false } : g.fileRule;
    item.settingsFile = {
      mode: g.mode ?? "plain",
      ...(fileRule !== undefined ? { fileRule } : {}),
      rules: Object.fromEntries((g.fields ?? []).map(({ pattern, ...rule }) => [pattern, rule])),
      perElement: g.perElement ?? {},
    };
  }
  if (g.description !== undefined) item.description = g.description;
  if (g.label !== undefined) item.label = g.label;
  if (g.origin !== undefined) item.origin = g.origin;
  return item;
}

export function compileItems(defs: ItemDef[], settings: CompileSettings): SyncGroup[] {
  const groups: SyncGroup[] = [];
  const seenPaths = new Map<string, string>();

  for (const def of defs) {
    const item = itemFor(settings.items, def);
    const owner = defRef(def); // never `${def.section}/…` — a presented section is not an identity
    const group = compileSingleFile(def, item);
    if (group !== null) {
      claimPath(seenPaths, owner, group.path);
      groups.push(group);
    }
    for (const g of compileCompanions(def, item)) {
      claimPath(seenPaths, owner, g.path);
      groups.push(g);
    }
  }

  groups.push(...compileCustomItems(settings.items, defs, seenPaths));

  return groups;
}


// Which item(s) to flip when a user asks to stop syncing a compiled group by name — used by
// main.ts's stopSyncing so the effect survives the next recompile (settings.items is the only
// durable source of truth; compiledGroups itself is derived and gets rebuilt on every save).
// Structural (defs only, independent of settings/enablement): every group name compileItems can
// ever produce has exactly one entry here.
export interface GroupOwner {
  section: StorageSection;
  id: ItemId;
  // Set only for a companion (folder) group: disable that one companion entry, not the whole card
  // — e.g. stopping "themes" must not also stop appearance.json or "snippets".
  companionPath?: string;
}


// Whether `path` (already normalized/validated by the caller — see itemCard.ts's
// validateCompanionPath) is already claimed by ANY carrier known to the registry: an item's
// settings file (its custom path if set, else its registry default) or any preset OR user-added
// companion of any item (including the same item — this is also how "dedupe within the card" is
// enforced, since a duplicate add is just a self-collision). Compares via groupStorePath so a
// "{configDir}/…" default and a plain vault-relative user path only collide when they really
// resolve to the same store location (mirrors compileItems' claimPath — this is the pre-save UI
// check; claimPath/CompileError stays the compile-time backstop for anything that slips past it,
// e.g. a hand-edited data.json).
export function companionConflict(path: string, defs: ItemDef[], settings: CompileSettings): string | null {
  // Normalize the input path: trim, collapse repeated slashes, strip leading/trailing slashes.
  // This hardens against case-insensitive filesystem collisions and trailing-slash false negatives.
  const normalized = path
    .trim()
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const key = groupStorePath(normalized).toLowerCase();
  for (const def of defs) {
    const item = itemFor(settings.items, def);
    const sfPath = item.path ?? def.settingsFile?.defaultPath ?? null;
    if (sfPath !== null && groupStorePath(sfPath).toLowerCase() === key) return def.label;
    for (const preset of def.presetCompanions ?? []) {
      if (groupStorePath(preset.path).toLowerCase() === key) return def.label;
    }
    for (const companion of item.companions ?? []) {
      if (groupStorePath(companion.path).toLowerCase() === key) return def.label;
    }
  }
  return null;
}

// Basename-derived group-name collision check for the companion add/edit UI boundary.
// compileCompanions (above) names every companion group after basename(path) — two
// companions across DIFFERENT items whose paths merely share a final path segment (e.g. "a/logs"
// and "b/logs") compile to the SAME group name, which validateSyncManifest only catches AFTER the
// bad shape is already sitting in settings.items (recompile()'s safety net — by which point a bad
// persisted shape has already zeroed out compiledGroups on the next launch). Checked against the
// same universe reservedCustomGroupNames already reserves (every registry item's own group name,
// every DEF-level preset companion name, and the switch-list names) PLUS every item's ACTUAL
// configured companions and every custom item — the full set of names compileItems can ever really
// produce. `excludeCompanion` lets an edit exclude its own pre-edit entry (renaming a path while
// keeping the same basename must never self-collide with the very entry being renamed).
export function companionNameConflict(
  path: string,
  defs: ItemDef[],
  settings: CompileSettings,
  excludeCompanion: { ref: ItemRef; path: string } | null
): string | null {
  const name = basename(path);
  const names = reservedCustomGroupNames(defs);
  for (const def of defs) {
    const item = itemFor(settings.items, def);
    for (const c of item.companions ?? []) {
      if (excludeCompanion !== null && excludeCompanion.ref === defRef(def) && excludeCompanion.path === c.path) continue;
      names.add(basename(c.path));
    }
  }
  for (const customName of Object.keys(settings.items.custom ?? {})) {
    const trimmed = customName.trim();
    if (trimmed !== "") names.add(trimmed);
  }
  return names.has(name) ? name : null;
}

export function groupOwners(defs: ItemDef[], items: ItemMap): Record<string, GroupOwner[]> {
  const out: Record<string, GroupOwner[]> = {};
  for (const def of defs) {
    const section = storageSection(def.section);
    if (def.settingsFile !== undefined) out[def.groupName] = [{ section, id: def.id }];
    for (const c of def.presetCompanions ?? []) out[basename(c.path)] = [{ section, id: def.id, companionPath: c.path }];
  }
  for (const customName of Object.keys(items.custom ?? {})) {
    const name = customName.trim();
    if (name !== "") out[name] = [{ section: "custom", id: customName }];
  }
  return out;
}

// The item a compiled group belongs to — a LOOKUP over the registry, never a parse of the name.
// Returns null for a companion
// group or a name no def claims. The two enablement carriers resolve here too, to their own def
// (OBSIDIAN_CARD_DEFS above) — they are items, not a special case.
export function itemForGroupName(defs: ItemDef[], name: string): ItemDef | null {
  return defs.find((d) => d.settingsFile !== undefined && d.groupName === name) ?? null;
}
