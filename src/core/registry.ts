/**
 * Item registry + compile-to-groups (spec 2026-07-25-unified-card-design.md,
 * docs/superpowers/specs/2026-07-26-ui-feedback-round2-design.md §2). A single flat registry of
 * ItemDefs (one per card: the three Obsidian cards, every core plugin, every installed
 * community/beta plugin) plus a v2 settings shape (`ConfigSyncSettings.items: Record<string,
 * ItemConfig>`) that stores each card's own configuration. `compileItems` is the ONLY place that
 * turns (defs, settings) into the `SyncGroup[]` the existing capture/apply engine
 * (ConfigSyncCore.ts) already knows how to run — everything downstream of compile is untouched.
 *
 * Every registry item, including the "app" card (app.json), compiles through the same
 * `compileSingleFile` path — there is no shared/merged carrier: a single-file item's Plain-mode
 * `fileRule.scope` is elevated to the compiled group's top-level `devices` class (the
 * "scope→devices class" compilation deferred from Task 2), uniformly.
 */
import { corePluginFile, mergePresetFields, SELF_GROUP_NAME } from "./catalog";
import { basename, groupStorePath } from "./pathing";
import { SWITCH_LIST_GROUPS } from "./switchList";
import { DeviceClass, FieldRule, FileRule, PerItemScopes, RuleScope, SyncGroup } from "./types";

export type ItemSection = "obsidian" | "core" | "community" | "beta";

export interface ItemDef {
  id: string;
  label: string;
  description: string;
  section: ItemSection;
  enablement?: { carrier: "core-plugins.json" | "community-plugins.json"; element: string };
  settingsFile?: { defaultPath: string | null };
  presetCompanions?: { path: string; mapKey?: string }[];
  // The plugin manifest's isDesktopOnly (community/beta only, set only when true) — an innate
  // property (the plugin cannot install on mobile), distinct from the user's enabledOn choice.
  // Drives the neutral "desktop-only plugin" card badge and trims "mobile" out of the ENABLED ON
  // scope cycle (round-8 spec §2).
  desktopOnly?: boolean;
}

// The map KEY is the key-name pattern (see task-4-brief.md's ItemConfig.settingsFile.rules —
// Record<string, FieldRule>): a bare {scope, encrypted, locked?} per key, deliberately without
// FieldRule's own `pattern` field so there is exactly one source of truth for which key a rule
// governs (the map key), not two that could disagree.
export type ItemFieldRule = Omit<FieldRule, "pattern">;

export interface ItemSettingsFile {
  customPath?: string;
  mode: "plain" | "fields";
  fileRule?: FileRule;
  rules: Record<string, ItemFieldRule>;
  perItem: Record<string, PerItemScopes>;
}

export interface ItemCompanion {
  path: string;
  scope: DeviceClass;
  enabled: boolean;
}

export interface ItemConfig {
  enabled: boolean;
  settingsFile?: ItemSettingsFile;
  // Optional since spec 2026-08-11-data-model-hardening.md §5.2, READERS ONLY: an empty list is
  // what "no companion folders" already means, and almost every real entry is exactly that (107 of
  // 108 in a live vault), so every read below is `?? []` and an absent key is legal. Writing the
  // empty array CONTINUES for now — removing a field is a two-phase change, and a build that
  // reads `cfg.companions` unguarded is still out there; phase 2 stops writing it once a tolerant
  // build is the fleet's floor.
  companions?: ItemCompanion[];
  enabledOn?: RuleScope;
}

// A freeform Advanced-tab rule (spec §6 addition) — "Custom rules" and "Discovered files" (an
// adopted discovered file is just a customGroups entry with origin:"discovered"). Has no ItemDef
// of its own, so it round-trips as the exact SyncGroup literal the Advanced tab's form already
// edits (name/path/type/devices/mode/fields/fileRule/perItem/description/origin) — a parallel
// shape would just be SyncGroup with the serial numbers filed off, which the Advanced tab's UI
// doesn't need or surface anything beyond.
export type CustomGroupConfig = SyncGroup;

// The shape compileItems needs out of ConfigSyncSettings — spelled out structurally (rather than
// imported from main.ts) so this module never depends on the plugin's top-level settings type.
export interface CompileSettings {
  items: Record<string, ItemConfig>;
  customGroups: CustomGroupConfig[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

// Still returns `companions: []`, deliberately: this is the base every new entry is built from
// (the settings tab's `itemConfig`, `itemConfigWithEnabledOn`, adopt's self-item enable,
// `stopSyncing`), and §5.2 phase 1 must persist the shape an older build can read — an item
// enabled for the FIRST time after this release included, or the compatibility this phasing buys
// leaks away through the newest entries. Phase 2 drops it from every construction site at once.
export function emptyItemConfig(): ItemConfig {
  return { enabled: false, companions: [] };
}

// The base every WRITE of an existing entry starts from. `items[id] ?? emptyItemConfig()` is not
// enough on its own: a stored entry that already lacks `companions` (a hand edit, or a document
// from the future build that stops writing it) would spread straight back out still missing the
// key, and this build must never persist an entry an older one cannot read (§5.2 phase 1). Reads
// don't need this — they are all `?? []`. Pure; the stored value always wins.
export function itemConfigForWrite(existing: ItemConfig | undefined): ItemConfig {
  return existing === undefined ? emptyItemConfig() : { ...emptyItemConfig(), ...existing };
}

// The exact write the in-place "where it runs" menu performs (spec 2026-07-28 §4): keep the
// card's existing config, force the card on (a rule on a disabled card would read back as
// "local"), pin enabledOn.
export function itemConfigWithEnabledOn(existing: ItemConfig | undefined, scope: "desktop" | "mobile"): ItemConfig {
  return { ...itemConfigForWrite(existing), enabled: true, enabledOn: scope };
}

// ── Registry construction ───────────────────────────────────────────────────────────────────

export interface RegistryCoreEnv {
  id: string;
  name: string;
  fileExists: boolean; // runtime info only: whether ${corePluginFile(id)} exists now (no longer gates the settings path — ①)
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
    label: "App settings",
    description: "Editing, new-note and link behavior, and other general options.",
    settingsFile: { defaultPath: "{configDir}/app.json" },
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, fonts and CSS snippets.",
    settingsFile: { defaultPath: "{configDir}/appearance.json" },
    presetCompanions: [{ path: "{configDir}/themes" }, { path: "{configDir}/snippets", mapKey: "enabledCssSnippets" }],
  },
  {
    id: "hotkeys",
    label: "Hotkeys",
    description: "Your custom keyboard shortcuts.",
    settingsFile: { defaultPath: "{configDir}/hotkeys.json" },
  },
] as const;

const COMMUNITY_PLUGIN_DESCRIPTION = "";

// Deterministic display order (spec §4): core and community/beta each sort by their own label,
// independent of runtime scan order — the obsidian section keeps its fixed App settings/
// Appearance/Hotkeys order from OBSIDIAN_CARD_DEFS.
function byLabel(a: ItemDef, b: ItemDef): number {
  return a.label.localeCompare(b.label, "en", { sensitivity: "base" });
}

export function buildItemDefs(env: RegistryEnv): ItemDef[] {
  const obsidian: ItemDef[] = OBSIDIAN_CARD_DEFS.map((d) => ({ ...d, section: "obsidian" }));

  const core: ItemDef[] = env.cores.map((c) => ({
    id: `core:${c.id}`,
    label: c.name,
    description: "",
    section: "core",
    enablement: { carrier: "core-plugins.json", element: c.id },
    settingsFile: { defaultPath: `{configDir}/${corePluginFile(c.id)}` },
  }));
  core.sort(byLabel);

  const communityAndBeta: ItemDef[] = env.plugins.map((p) => ({
    id: `community:${p.id}`, // beta reuses the community id form (spec §1)
    label: p.name,
    description: COMMUNITY_PLUGIN_DESCRIPTION,
    section: env.betaIds.has(p.id) ? "beta" : "community",
    enablement: { carrier: "community-plugins.json", element: p.id },
    settingsFile: { defaultPath: `{configDir}/plugins/${p.id}/data.json` },
    ...(p.desktopOnly ? { desktopOnly: true } : {}),
  }));
  communityAndBeta.sort(byLabel);

  return [...obsidian, ...core, ...communityAndBeta];
}

// Extends a defs list with a synthesized community/beta def for every id in itemIds whose plugin
// has no installed def yet. Two callers need this: leftover.ts's storeSelfCopyGroups/
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
export function defsForForeignItems(defs: ItemDef[], itemIds: string[], betaIds: ReadonlySet<string>): ItemDef[] {
  const known = new Set(defs.map((d) => d.id));
  const extras: ItemDef[] = [];
  for (const id of itemIds) {
    if (known.has(id) || !id.startsWith("community:")) continue;
    const pluginId = id.slice("community:".length);
    extras.push({
      id,
      label: pluginId,
      description: COMMUNITY_PLUGIN_DESCRIPTION,
      section: betaIds.has(pluginId) ? "beta" : "community",
      enablement: { carrier: "community-plugins.json", element: pluginId },
      settingsFile: { defaultPath: `{configDir}/plugins/${pluginId}/data.json` },
    });
  }
  return extras.length === 0 ? defs : [...defs, ...extras];
}

// ── Compile ──────────────────────────────────────────────────────────────────────────────────

// Exported for the Sync Center host's companionParentOf (c-livetest batch5 task 2): a companion
// group's parent presents as the ITEM's own compiled group name, which only this function knows
// how to derive from the owning ItemDef's id.
export function legacyGroupName(id: string): string {
  if (id.startsWith("core:")) return id.slice("core:".length);
  if (id.startsWith("community:")) return `plugin-${id.slice("community:".length)}`;
  return id; // obsidian cards: appearance / hotkeys keep their reserved name as-is
}

function configFor(settings: CompileSettings, id: string): ItemConfig {
  return settings.items[id] ?? emptyItemConfig();
}

function fieldsFromRules(rules: Record<string, ItemFieldRule>): FieldRule[] {
  return Object.entries(rules).map(([pattern, rule]) => ({ pattern, ...rule }));
}

function perItemFromMap(perItem: Record<string, PerItemScopes>): Record<string, PerItemScopes> | undefined {
  const entries = Object.entries(perItem);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Registers a group's real path against the collision map — throws a CompileError naming both
// items when two different items' carriers land on the same store location (spec §8, D8: "查重
// + 与已有 item 路径冲突即拒绝").
function claimPath(seen: Map<string, string>, itemId: string, path: string): void {
  const key = groupStorePath(path);
  const owner = seen.get(key);
  if (owner !== undefined && owner !== itemId) {
    throw new CompileError(`"${itemId}" and "${owner}" both sync "${path}" — give one of them a different path.`);
  }
  seen.set(key, itemId);
}

// Compiles one item's own single-file settingsFile into a SyncGroup — every registry item
// (the three Obsidian cards, every core/community/beta plugin file) goes through this one path.
// Merges config-sync's own locked local-only presets (rootPath, remotes, localMembers — see
// catalog.ts's selfPresetRules) into a compiled group for the self item, no matter what the user
// configured: these fields must NEVER leave the device, even under a future UI bug or a
// hand-edited data.json. Delegates to catalog.ts's mergePresetFields — the ONE shared
// implementation (C-#31) — rather than reimplementing the preset+rest merge here: this is the
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

function compileSingleFile(id: string, def: ItemDef, cfg: ItemConfig): SyncGroup | null {
  const defaultPath = def.settingsFile?.defaultPath ?? null;
  if (!cfg.enabled || defaultPath === null) return null; // off, or state-only (no file to sync yet)
  const path = cfg.settingsFile?.customPath ?? defaultPath;
  const mode = cfg.settingsFile?.mode ?? "plain";
  const group: SyncGroup = { name: legacyGroupName(id), path, type: "file", devices: "all" };
  if (mode === "fields") {
    group.mode = "fields";
    const fields = fieldsFromRules(cfg.settingsFile?.rules ?? {});
    if (fields.length > 0) group.fields = fields;
    const perItem = perItemFromMap(cfg.settingsFile?.perItem ?? {});
    if (perItem !== undefined) group.perItem = perItem;
  } else if (cfg.settingsFile?.fileRule !== undefined) {
    // Task-2-deferred compilation: a Plain file-level rule's scope IS the group's devices class
    // (fileRule.scope excludes "local" by construction — D9 — so this is always a valid
    // DeviceClass); fileRule.encrypted still governs whole-file encryption independently.
    group.fileRule = cfg.settingsFile.fileRule;
    group.devices = cfg.settingsFile.fileRule.scope;
  }
  return withSelfPresets(group);
}

function compileCompanions(itemId: string, cfg: ItemConfig): SyncGroup[] {
  if (!cfg.enabled) return []; // card off → its file AND its companions exit sync together
  return (cfg.companions ?? []).filter((c) => c.enabled).map((c) => ({ name: basename(c.path), path: c.path, type: "dir", devices: c.scope }));
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
  // compileItems never emits this name under schema v2 (see the reserved-name note above) — the
  // branch covers v3-era store manifests, which can still carry the group at runtime (main.ts
  // special-cases it the same way).
  if (groupName === "enabled-css-snippets") return defs.find((d) => d.id === "appearance")?.label ?? "Appearance";
  for (const def of defs) {
    const cfg = configFor(settings, def.id);
    if (!cfg.enabled) continue;
    if ((cfg.companions ?? []).some((c) => c.enabled && basename(c.path) === groupName)) return def.label;
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
    const cfg = configFor(settings, def.id);
    if ((cfg.companions ?? []).some((c) => basename(c.path) === groupName)) continue; // already configured — no fallback
    return def.label;
  }
  return null;
}

// Per-element scope for a plugin's enablement (spec §3/§4, D4/D5): "enabledOn" default "all";
// a disabled card forces its element to "local" ("each device manages its own", never inherits
// another device's enabled state). Exported for main.ts to fold into the switch-list engine's
// runtime member-exception derivation (core-plugins.json/community-plugins.json are NOT
// string-array files, so they cannot go through the generic capturePerItemArray/PerItemScopes
// mechanism the way a plain array key like enabledCssSnippets does — the existing switch-list
// masking machinery, driven by this map, is the correct home for per-element enable scope).
// A stored enabledOn of "local" is a pre-retarget artifact (spec: the explicit "this device
// decides for itself" choice now lives in settings.localMembers, never in ItemConfig.enabledOn —
// see main.ts's setMemberLocal/memberLocalIdsFor) — ignored here, same as unset ("all").
function explicitScope(enabledOn: RuleScope | undefined): RuleScope {
  const scope = enabledOn ?? "all";
  return scope === "local" ? "all" : scope;
}

interface ElementScope {
  element: string;
  scope: RuleScope;
  // Structural (task-8, spec 2026-08-05-section-groups-and-member-menu-design.md §R3-A): "local"
  // solely because the card is off, with no explicit source (no stored enabledOn) — as opposed to
  // a "local" a user actually pinned. Only meaningful when scope === "local"; false otherwise.
  structural: boolean;
}

// Shared per-element walk behind enablementScopes/structuralLocalElements: same two passes (defs
// whose carrier matches, then item configs with no local def), computed once so the two exported
// projections can never drift apart.
function elementScopes(defs: ItemDef[], settings: CompileSettings, carrier: "core-plugins.json" | "community-plugins.json"): ElementScope[] {
  const out: ElementScope[] = [];
  const covered = new Set<string>();
  for (const def of defs) {
    if (def.enablement?.carrier !== carrier) continue;
    covered.add(def.id);
    const cfg = configFor(settings, def.id);
    out.push({
      element: def.enablement.element,
      scope: cfg.enabled ? explicitScope(cfg.enabledOn) : "local",
      structural: !cfg.enabled && cfg.enabledOn === undefined,
    });
  }
  // Item configs with no local def: the plugin isn't installed on this device, but its element
  // still lives in the store's switch list, so an adopted enabledOn / disabled-card decision must
  // keep masking here (2026-07-27 mobile find: an adopted "desktop" scope for a not-installed
  // plugin was dead config). The element id derives from the item id alone — no def needed.
  const prefix = carrier === "core-plugins.json" ? "core:" : "community:";
  for (const [id, cfg] of Object.entries(settings.items)) {
    if (covered.has(id) || !id.startsWith(prefix)) continue;
    out.push({
      element: id.slice(prefix.length),
      scope: cfg.enabled ? explicitScope(cfg.enabledOn) : "local",
      structural: !cfg.enabled && cfg.enabledOn === undefined,
    });
  }
  return out;
}

export function enablementScopes(defs: ItemDef[], settings: CompileSettings, carrier: "core-plugins.json" | "community-plugins.json"): Record<string, RuleScope> {
  const out: Record<string, RuleScope> = {};
  for (const e of elementScopes(defs, settings, carrier)) out[e.element] = e.scope;
  return out;
}

// Elements whose enablementScopes "local" is structural (spec §R3-A) — a disabled card the user
// never pinned or scoped, not a rule they wrote. The Sync Center's scoped-member disclosure reads
// this to render those rows read-only instead of offering a scope control that silently no-ops.
export function structuralLocalElements(defs: ItemDef[], settings: CompileSettings, carrier: "core-plugins.json" | "community-plugins.json"): Set<string> {
  const out = new Set<string>();
  for (const e of elementScopes(defs, settings, carrier)) if (e.structural) out.add(e.element);
  return out;
}

function anyEnabledInCarrier(defs: ItemDef[], settings: CompileSettings, carrier: "core-plugins.json" | "community-plugins.json"): boolean {
  return defs.some((d) => d.enablement?.carrier === carrier && configFor(settings, d.id).enabled);
}

// Every group name the registry itself can ever produce plus the three switch-list carrier names
// (SWITCH_LIST_GROUPS: "community-plugins"/"core-plugins" are the conditional enablement groups
// compileItems emits below; "enabled-css-snippets" never is its own group but is still reserved so
// a custom rule can't shadow the vocabulary a user already associates with it). A custom rule's
// name must be its own, unambiguous identity.
function reservedCustomGroupNames(defs: ItemDef[]): Set<string> {
  return new Set<string>([...Object.keys(groupOwners(defs, [])), ...SWITCH_LIST_GROUPS]);
}

// Compiles settings.customGroups (spec §6 addition, task-8 concern fix) into the same SyncGroup[]
// the registry-derived cards produce — the Advanced tab's "Custom rules"/"Discovered files" no
// longer have to fend for themselves with a session-only groupsIO write. Path claims go through
// the SAME claimPath accounting compileItems already runs for every registry item (collision with
// a registry item OR another custom group throws), and a name that shadows a reserved/registry
// name is rejected outright — the same "no silent gaps" contract compileItems applies everywhere
// else. A blank name (the Advanced tab's in-memory-only "+ Add rule" placeholder — see
// commitGroups.ts's culprit-blank filter) is skipped rather than rejected: it never reaches
// settings in the first place, so this is defense in depth, not a real code path.
function compileCustomGroups(customGroups: CustomGroupConfig[], defs: ItemDef[], seenPaths: Map<string, string>): SyncGroup[] {
  const reserved = reservedCustomGroupNames(defs);
  const seenNames = new Set<string>();
  const groups: SyncGroup[] = [];
  for (const cg of customGroups) {
    const name = cg.name.trim();
    if (name === "") continue;
    if (reserved.has(name)) throw new CompileError(`"${name}" is a reserved name — rename this custom rule.`);
    if (seenNames.has(name)) throw new CompileError(`two custom rules are both named "${name}" — rename one of them.`);
    seenNames.add(name);
    claimPath(seenPaths, `custom:${name}`, cg.path);
    groups.push({ ...cg, name });
  }
  return groups;
}

export function compileItems(defs: ItemDef[], settings: CompileSettings): SyncGroup[] {
  const groups: SyncGroup[] = [];
  const seenPaths = new Map<string, string>();

  for (const def of defs) {
    const cfg = configFor(settings, def.id);
    const group = compileSingleFile(def.id, def, cfg);
    if (group !== null) {
      claimPath(seenPaths, def.id, group.path);
      groups.push(group);
    }
    for (const g of compileCompanions(def.id, cfg)) {
      claimPath(seenPaths, def.id, g.path);
      groups.push(g);
    }
  }

  if (anyEnabledInCarrier(defs, settings, "core-plugins.json")) {
    const g: SyncGroup = { name: "core-plugins", path: "{configDir}/core-plugins.json", type: "file", devices: "all" };
    claimPath(seenPaths, "core-plugins", g.path);
    groups.push(g);
  }
  if (anyEnabledInCarrier(defs, settings, "community-plugins.json")) {
    const g: SyncGroup = { name: "community-plugins", path: "{configDir}/community-plugins.json", type: "file", devices: "all" };
    claimPath(seenPaths, "community-plugins", g.path);
    groups.push(g);
  }

  groups.push(...compileCustomGroups(settings.customGroups, defs, seenPaths));

  return groups;
}

// ── Group -> owning item(s), for durable "stop syncing" ────────────────────────────────────────

// Which ItemConfig(s) to flip when a user asks to stop syncing a compiled group by name — used by
// main.ts's stopSyncing so the effect survives the next recompile (settings.items is the only
// durable source of truth; compiledGroups itself is derived and gets rebuilt on every save).
// Structural (defs only, independent of settings/enablement): every group name compileItems can
// ever produce has exactly one entry here.
export interface GroupOwner {
  itemId: string;
  // Set only for a companion (dir) group: disable that one companion entry, not the whole card —
  // e.g. stopping "themes" must not also stop appearance.json or "snippets".
  companionPath?: string;
  // Set only for a custom group (Advanced tab "Custom rules"/"Discovered files" — itemId is the
  // synthetic "custom:<name>" id): unlike a registry item there is no "enabled" flag to flip, so
  // main.ts's stopSyncing must REMOVE the matching entry from settings.customGroups instead.
  custom?: true;
}

// ── Companion / custom-path collision check (spec §4/§8, D7/D8, task-7-brief.md) ───────────────

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
    const cfg = configFor(settings, def.id);
    const sfPath = cfg.settingsFile?.customPath ?? def.settingsFile?.defaultPath ?? null;
    if (sfPath !== null && groupStorePath(sfPath).toLowerCase() === key) return def.label;
    for (const preset of def.presetCompanions ?? []) {
      if (groupStorePath(preset.path).toLowerCase() === key) return def.label;
    }
    for (const companion of cfg.companions ?? []) {
      if (groupStorePath(companion.path).toLowerCase() === key) return def.label;
    }
  }
  return null;
}

// Basename-derived group-name collision check for the companion add/edit UI boundary (final-review
// MUST-FIX 1). compileCompanions (above) names every companion group after basename(path) — two
// companions across DIFFERENT items whose paths merely share a final path segment (e.g. "a/logs"
// and "b/logs") compile to the SAME group name, which validateSyncManifest only catches AFTER the
// bad shape is already sitting in settings.items (recompile()'s safety net — by which point a bad
// persisted shape has already zeroed out compiledGroups on the next launch). Checked against the
// same universe reservedCustomGroupNames already reserves (every registry item's own group name,
// every DEF-level preset companion name, and the switch-list hidden carrier names) PLUS every
// item's ACTUAL configured companions and every settings.customGroups entry — the full set of
// names compileItems can ever really produce. `excludeCompanion` lets an edit exclude its own
// pre-edit entry (renaming a path while keeping the same basename must never self-collide with the
// very entry being renamed).
export function companionNameConflict(
  path: string,
  defs: ItemDef[],
  settings: CompileSettings,
  excludeCompanion: { itemId: string; path: string } | null
): string | null {
  const name = basename(path);
  const names = reservedCustomGroupNames(defs);
  for (const def of defs) {
    const cfg = configFor(settings, def.id);
    for (const c of cfg.companions ?? []) {
      if (excludeCompanion !== null && excludeCompanion.itemId === def.id && excludeCompanion.path === c.path) continue;
      names.add(basename(c.path));
    }
  }
  for (const cg of settings.customGroups) {
    const trimmed = cg.name.trim();
    if (trimmed !== "") names.add(trimmed);
  }
  return names.has(name) ? name : null;
}

export function groupOwners(defs: ItemDef[], customGroups: CustomGroupConfig[]): Record<string, GroupOwner[]> {
  const out: Record<string, GroupOwner[]> = {};
  for (const def of defs) {
    if (def.settingsFile !== undefined) out[legacyGroupName(def.id)] = [{ itemId: def.id }];
    for (const c of def.presetCompanions ?? []) out[basename(c.path)] = [{ itemId: def.id, companionPath: c.path }];
  }
  for (const cg of customGroups) {
    const name = cg.name.trim();
    if (name !== "") out[name] = [{ itemId: `custom:${name}`, custom: true }];
  }
  return out;
}
