/**
 * Unified card — pure render helpers. One renderer works for every ItemDef (registry.ts); this module
 * holds every piece of that renderer's logic that can be expressed as a pure function of
 * (def, cfg, live-file-state) — badge computation, zone presence, and the Fields/Companion-folders
 * row models — so it can be unit tested without touching the DOM or Obsidian's API.
 * `src/ui/SettingTab.ts`'s `renderItemCard` is the only consumer that turns these models into
 * actual elements.
 *
 * Every literal string exported here is copy-contract-exact — treat the wording as final copy,
 * not as an implementation detail free to drift.
 */
import { GROUP_NAME_RE } from "../core/manifest";
import { basename } from "../core/pathing";
import { DeviceElementState } from "../core/deviceElements";
import { enablementRules, ruleHomeFor, RuleListId } from "../core/enablementRules";
import { perElementKeyFor } from "../core/switchList";
import { deriveMode, emptyItem, Item, ItemDef, ItemFieldRule, itemAt, ItemMap, itemFor, ItemSettingsFile, withItem } from "../core/registry";
import {
  DeviceClass,
  EVERYWHERE,
  PerElementSharing,
  perClass,
  Sharing,
  sharingClass,
  sharingEquals,
  SyncMode,
  THIS_DEVICE,
} from "../core/types";

// Row = name + badges + sync toggle + chevron, NOTHING else. Badge order: enablement rule
// (only for cards with an `enablement` projection, only when non-default) → N device-scoped →
// N encrypted. Zero counts are omitted entirely — a badge never reads "0 …".

// Badges render icon-only with an optional 9px corner count — `text` is the tooltip
// sentence (and the loud fallback for a badge missing its icon), never inline copy.
export interface Badge {
  text: string;
  cls: string;
  icon?: string;
  count?: number;
  tooltip?: string;
}

// Mode DISPLAY names (stored ids `plain`/`fields`/`encrypted` never change): "Plain"
// and "Fields" are implementation words; "Per-key rules" is the drawer's own vocabulary.
export const MODE_LABELS = { plain: "Whole file", fields: "Per-key rules", encrypted: "Encrypted" } as const;

// The same three modes as glyphs, for the Advanced rule form's Mode picker (its two neighbouring
// rows, Type and Devices, are icon pickers — Mode was the last text chip and read as the odd row
// out). `braces` says "the keys inside the file decide" and is the SAME mark a card's per-key jump
// uses; `lock` is the encrypted state everywhere. `file-text`, NOT `file`: the Type row directly
// above owns `file`/`folder` for a different question, and two adjacent rows drawing one glyph for
// two questions is the collision this vocabulary exists to prevent.
export const MODE_ICON: Record<keyof typeof MODE_LABELS, string> = { plain: "file-text", fields: "braces", encrypted: "lock" };

const ON_BADGE_TEXT = { desktop: "on: desktop", mobile: "on: mobile", local: "on: this device" } as const;
// The local badge's other half: an exception can force a plugin OFF here just as easily as on, and
// the badge fires for both.
const OFF_BADGE_TEXT_LOCAL = "off: this device";

const ON_BADGE_CLASS = {
  desktop: "config-sync-card-badge-desktop",
  mobile: "config-sync-card-badge-mobile",
  local: "config-sync-card-badge-local",
} as const;

// `N device-scoped`, wherever it renders. Its own class rather than the count class `N encrypted`
// wears: the same cyan today, two different meanings, and one class would drag one badge along
// whenever the other moved. The cyan is the merged control's shared-glyph color, so a card's badge
// and the rows it counts are one glance apart.
const SCOPED_BADGE_CLASS = "config-sync-card-badge-scoped";

// A carrier card's two badges. Two facts, two colors: what the fleet agreed
// (`N device-scoped`) and what this device kept for itself (`N left to me`). Mixing them into one
// count is what made the old "N device-scoped" badge unreadable on a device that had its own
// exceptions. The fleet half keeps the count palette every other card badge counts in; the local
// half takes the purple the merged control's local glyph already wears when it is set
// (`.config-sync-mergedctl.is-set .config-sync-mergedctl-local`), so the color says "this device"
// in both places.
const CARRIER_FLEET_BADGE_CLASS = SCOPED_BADGE_CLASS;
const CARRIER_LOCAL_BADGE_CLASS = "config-sync-card-badge-mine";

// The fileRule/rules half of countClassPinned, split out so the carrier badge (carrierBadgeCounts
// below) can count a carrier's OWN class pins without also walking `perElement` — on a carrier,
// perElement IS the element rules carrierBadgeCounts already counts via enablementRules, so folding
// countClassPinned's perElement loop in here too would double-count the same rules under one badge.
function fileAndRuleClassKinds(item: Item): DeviceClass[] {
  const sf = item.settingsFile;
  if (sf === undefined) return [];
  const out: DeviceClass[] = [];
  const fileClass = sf.fileRule === undefined ? null : sharingClass(sf.fileRule.sharing);
  if (fileClass !== null) out.push(fileClass);
  for (const rule of Object.values(sf.rules)) {
    const cls = sharingClass(rule.sharing);
    if (cls !== null) out.push(cls);
  }
  return out;
}

// A count badge names the SPECIFIC thing when everything it counts is alike, and falls back to a
// neutral summariser only when the set genuinely mixes. The enablement badge below already worked
// this way (a class rule draws `monitor`/`smartphone`, never a stand-in); the count badges were the
// exception, which is how `N device-scoped` ended up wearing `monitor-smartphone` — the glyph for
// `All devices` — to count keys that are pointedly NOT on all devices.
export function soleKind<T extends string>(kinds: readonly T[]): T | null {
  const distinct = [...new Set(kinds)];
  const first = distinct[0];
  return distinct.length === 1 && first !== undefined ? first : null;
}

// `N device-scoped`: all pinned to one class → that class's own glyph, which is the same meaning it
// carries everywhere else. Only a genuinely mixed card falls back, and then to `contrast` (one thing
// with two different sides) — NOT `monitor-smartphone`, which means `All devices` and so said the
// opposite of what this badge counts, and not `split`, which is the shared answer's "not shared at
// all", a different fact.
function deviceScopedIcon(kinds: readonly DeviceClass[]): string {
  const sole = soleKind(kinds);
  if (sole === null) return "contrast";
  return sole === "desktop" ? "monitor" : "smartphone";
}

// `N left to me`: same rule one layer down. All the exceptions force it on → `power`; all off →
// `power-off`; a mix has no honest single state to show, so it takes the neutral `user`.
function leftToMeIcon(states: readonly DeviceElementState[]): string {
  const sole = soleKind(states);
  if (sole === null) return "user";
  return sole === "on" ? "power" : "power-off";
}

// Returns one entry PER PINNED RULE, not a total: the badge needs both how many there are and
// whether they agree on a class, and deriving those from two separate walks is how they would come
// to disagree.
export function classPinnedKinds(item: Item): DeviceClass[] {
  const sf = item.settingsFile;
  if (sf === undefined) return [];
  const out = fileAndRuleClassKinds(item);
  for (const sharings of Object.values(sf.perElement)) {
    for (const sharing of Object.values(sharings)) {
      const cls = sharingClass(sharing);
      if (cls !== null) out.push(cls);
    }
  }
  return out;
}

// A fileRule-encrypted item (Plain mode, whole file encrypted) counts as one toward "N
// encrypted" — there is no separate lock-badge string in the copy contract (the badge
// list has only "N encrypted"), so the fileRule contributes to the same count instead of a
// second badge.
export function countEncrypted(item: Item): number {
  const sf = item.settingsFile;
  if (sf === undefined) return 0;
  let n = sf.fileRule?.encrypted === true ? 1 : 0;
  for (const rule of Object.values(sf.rules)) {
    if (rule.encrypted) n++;
  }
  return n;
}


// Which enablement list a card CARRIES, or null for a card that carries none. THE producer of
// "this is a carrier card": the badges, the drawer's element section and its row list all ask it,
// so a renamed id or a fourth list lands in exactly one place. A carrier's item id IS its list id —
// the same string `ruleHomeFor` keys that list's rules by (enablementRules.ts).
export function carrierListFor(def: ItemDef): RuleListId | null {
  if (def.section !== "obsidian") return null;
  return def.id === "core-plugins" || def.id === "community-plugins" ? def.id : null;
}

// Kinds, not totals — same reason classPinnedKinds returns them: each badge needs the count AND
// whether its members agree on one kind, and one walk has to answer both.
export interface CarrierCounts {
  fleet: DeviceClass[];
  local: DeviceElementState[];
}

// `fleet` counts CLASS rules only, not every rule: `Not shared` (`this-device`) hands the
// element back to each device rather than scoping it to one kind of device, so counting it as
// "device-scoped" would name something the rule does not do. `exceptionIds` comes from the caller
// because the exception table is localStorage (deviceElements.ts) — no `Item` knows it.
//
// `fleet` also folds in the carrier's OWN class pins: a carrier is an
// item like any other, and its `fileRule.sharing` (settable from the Sync Center's Default settings
// sync row — e.g. "Desktop only") or a class-pinned `rules` entry is just as much a "this many
// devices" fact as its element rules are. Dropping them showed no badge at all for that state. Uses
// `countFileAndRuleClassPinned`, not `countClassPinned`, on purpose: `countClassPinned`'s perElement
// walk would count the SAME element rules `enablementRules` above already counts, under the same
// badge.
export function carrierBadgeCounts(
  items: ItemMap,
  list: RuleListId,
  exceptions: readonly DeviceElementState[],
  isDesktopOnly: (elementId: string) => boolean
): CarrierCounts {
  const rules = enablementRules(items, list);
  const elementRules: DeviceClass[] = [];
  // A `Desktop only` rule on a plugin whose manifest is already desktop-only decides nothing, so it
  // is not a device-scoping decision to count. Left in, it inflates the number AND can decide the
  // glyph: a card whose only real rules are `Mobile only` reads as mixed (`contrast`) purely
  // because of rules nobody made.
  for (const [elementId, s] of Object.entries(rules)) {
    if (restatesInnate(s, isDesktopOnly(elementId))) continue;
    const cls = sharingClass(s);
    if (cls !== null) elementRules.push(cls);
  }
  const home = ruleHomeFor(list);
  const carrierItem = itemAt(items, home.section, home.id);
  const ownPins = carrierItem !== undefined ? fileAndRuleClassKinds(carrierItem) : [];
  return { fleet: [...elementRules, ...ownPins], local: [...exceptions] };
}

export const CARRIER_ELEMENTS_LABEL = "Which devices turn each plugin on";

export interface CarrierElementRow {
  elementId: string;
  label: string;
  desktopOnly: boolean;
}

// The carrier drawer's element list: every element installed on this device, plus every
// element that already carries a rule or a local exception — a plugin uninstalled here still has a
// choice recorded for the fleet, and a row that vanished the moment it was uninstalled would leave
// that choice unreachable from the only card that shows it. Sorted by what the reader sees (the
// def's label where the element is installed, the raw id where it is not), never by id.
export function buildCarrierElementRows(defs: ItemDef[], list: RuleListId, ruledIds: string[], exceptionIds: string[]): CarrierElementRow[] {
  const installed = new Map<string, ItemDef>();
  for (const def of defs) {
    if (def.enablement?.list === list) installed.set(def.enablement.element, def);
  }
  const ids = new Set([...installed.keys(), ...ruledIds, ...exceptionIds]);
  return [...ids]
    .map((elementId) => {
      const def = installed.get(elementId);
      return { elementId, label: def?.label ?? elementId, desktopOnly: def?.desktopOnly === true };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
}

// `enablement` is the card's two enablement layers, or null for a def that has no
// enablement projection at all: the fleet rule from the carrier item (enablementRules.ts) and this
// device's own exception (deviceElements.ts). A badge must derive from these two layers —
// a badge derived from a field no run reads would be a claim about nothing.
//
// `carrier` is the counts for a card that carries a list (carrierBadgeCounts), null for every other
// card. It REPLACES this card's own `N device-scoped` badge rather than joining it: on a carrier
// those two would be the same per-element class rules counted twice, under the same word.
export function computeBadges(
  def: ItemDef,
  item: Item,
  enablement: { rule: Sharing; exception: DeviceElementState | null } | null,
  carrier: CarrierCounts | null
): Badge[] {
  const badges: Badge[] = [];
  // On/off-only badge first, innate property (settingsFile state on the def)
  if (def.settingsFile !== undefined && def.settingsFile.defaultPath === null) {
    badges.push({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      icon: "toggle-left",
      tooltip: "No settings file on this device yet — only the on/off state syncs.",
    });
  }
  // Innate manifest property first, ahead of every config-driven badge — GREY, because grey =
  // innate and color = your choice (the two desktop meanings must read apart).
  if (def.desktopOnly === true) {
    badges.push({ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" });
  }
  // An exception outranks the rule here for the same reason it does at run time:
  // what this device actually does is the truer thing to say about it. A
  // `this-device` RULE ("Not shared") sets no class and is not itself an exception, so it
  // earns no badge — the card's own row is where that answer lives. Colored = the user's rule:
  // blue monitor / amber smartphone / the local-exception corner glyph.
  if (def.enablement !== undefined && enablement !== null) {
    const cls = sharingClass(enablement.rule);
    // The badge KNOWS which exception it is, so it says so: `power`/`power-off`, the same pair the
    // row's own local glyph paints, and the matching word. One badge for both exceptions would say
    // `on: this device` over a plugin forced OFF here, and would have to wear
    // `corner-down-right`, the glyph for having NO exception.
    if (enablement.exception !== null) {
      const on = enablement.exception === "on";
      badges.push({ text: on ? ON_BADGE_TEXT.local : OFF_BADGE_TEXT_LOCAL, cls: ON_BADGE_CLASS.local, icon: on ? "power" : "power-off" });
    }
    // A rule that only restates the manifest earns nothing: the grey `desktop-only plugin` badge
    // directly to its left already says it, and a second, COLORED monitor beside it claims the user
    // decided something they did not. The local-exception branch above is untouched — an exception
    // on the same plugin does say something new.
    else if (cls !== null && !restatesInnate(enablement.rule, def.desktopOnly === true)) {
      badges.push({ text: ON_BADGE_TEXT[cls], cls: ON_BADGE_CLASS[cls], icon: cls === "desktop" ? "monitor" : "smartphone" });
    }
  }
  if (carrier !== null) {
    if (carrier.fleet.length > 0) {
      badges.push({ text: `${carrier.fleet.length} device-scoped`, cls: CARRIER_FLEET_BADGE_CLASS, icon: deviceScopedIcon(carrier.fleet), count: carrier.fleet.length });
    }
    if (carrier.local.length > 0) {
      badges.push({ text: `${carrier.local.length} left to me`, cls: CARRIER_LOCAL_BADGE_CLASS, icon: leftToMeIcon(carrier.local), count: carrier.local.length });
    }
  } else {
    const classPinned = classPinnedKinds(item);
    if (classPinned.length > 0) {
      badges.push({ text: `${classPinned.length} device-scoped`, cls: SCOPED_BADGE_CLASS, icon: deviceScopedIcon(classPinned), count: classPinned.length });
    }
  }
  const encrypted = countEncrypted(item);
  if (encrypted > 0) badges.push({ text: `${encrypted} encrypted`, cls: "config-sync-card-badge-count", icon: "lock", count: encrypted });
  return badges;
}


// Zone ① "Enabled on" exists only for cards whose registry def carries an enablement projection
// (core/community/beta plugins) — this only decides whether to reserve the slot.
export function hasEnablementZone(def: ItemDef): boolean {
  return def.enablement !== undefined;
}

// Zone ① copy. Same name, same values, same data as the Sync Center's row of that name. Only
// rendered for a def where hasEnablementZone(def) is true.
//
// The consequence of the shared answer lives in the control's own tooltip (`enablementRow.ts`'s
// `enabledOnTooltip`) — this label is just what the ROW is, matching the Sync Center's
// row label exactly.
export const ENABLED_ON_LABEL = "Enabled on";

export type SettingsFileZoneKind = "none" | "state-only" | "settings";

// "none" = the def has no settingsFile at all (never true for the five Obsidian cards). "state-
// only" = a core plugin that has never written its settings file yet (registry.ts's
// `defaultPath: null`) — zone ② shows a hint instead of Fields/Plain controls. "settings" = the
// normal case.
export function settingsFileZoneKind(def: ItemDef): SettingsFileZoneKind {
  if (def.settingsFile === undefined) return "none";
  return def.settingsFile.defaultPath === null ? "state-only" : "settings";
}

export function stateOnlyHint(itemLabel: string, expectedFile: string): string {
  return `Settings appear here once ${itemLabel} writes ${expectedFile}.`;
}


// Item convenience form of the same test — false when the card has no settingsFile at all
// (nothing to derive from).
export function hasKeyRules(item: Item): boolean {
  return item.settingsFile !== undefined && deriveMode(item.settingsFile) === "fields";
}

// Whole-file fileRule legality — mirrors manifest.ts's parseGroup validator EXACTLY
// (manifest.ts:165-169): a fileRule is only legal on a "plain" (or absent, which defaults to
// plain) mode group, never "fields" or "encrypted". Every registry item compiles to type:"file"
// (registry.ts's compileSingleFile), so type is never the deciding factor here — mode always is.
// The Sync Center's Settings-sync menu (only rendered when this is true) and setItemFileSharing's
// write guard (throws when it's false) both gate on this one function so neither can drift from
// what the validator would actually accept.
export function fileRuleLegalForMode(mode: SyncMode | undefined): boolean {
  return mode === undefined || mode === "plain";
}


export const DEFAULT_FIELD_RULE: ItemFieldRule = { sharing: EVERYWHERE, encrypted: false };

export function isStringArrayValue(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export interface FieldRowModel {
  key: string;
  isArray: boolean;
  rule: ItemFieldRule;
  perElementEnabled: boolean;
}

// The `mapKey` on the Appearance card's snippets companion (registry.ts's presetCompanions) — which
// folder's member list is the snippet list, so the card knows to draw element-rule rows under it
// instead of plain filenames. NOT the key its rules are stored under: that is `perElementKeyFor`'s
// answer (they are the same string today, and the rule-row exclusion below asks the producer, not
// this). File preview's click-to-add still excludes it.
export const ENABLED_CSS_SNIPPETS_KEY = "enabledCssSnippets";

// A perElement key that holds an ENABLEMENT LIST's rules is never an ordinary rule row: those rules
// have rows of their own on the same card (the Appearance card's snippet members, a carrier card's
// element rows), and a whole-file list's key has no name to render at all, so it would
// come out as a nameless row with a ✕ beside it.
//
// WHICH key that is comes from `perElementKeyFor` and nowhere else — the
// same producer `ruleHomeFor` asks when it WRITES the rules. Spelling the whole-file key as `""`
// here would be a second author for a derived key, and two authors drift;
// registry.ts's deriveMode still carries that literal, and it is the one place it is spelled.
// Exported for the File preview: an enablement key must not wear the clickable
// affordance either — clicking it would write a rule buildRuleRows filters right back out, an
// invisible junk entry.
export function isEnablementRuleKey(def: ItemDef, key: string): boolean {
  const list = carrierListFor(def);
  if (list !== null) return key === perElementKeyFor(list);
  return def.section === "obsidian" && def.id === "appearance" && key === perElementKeyFor("enabled-css-snippets");
}

// The keys buildRuleRows below FILTERS OUT — the same predicate, read the other way round. They are
// not missing rules: their rows live elsewhere on the card (a carrier's element rows, the Appearance
// card's snippet members under `Folders`), which is exactly why the rule zone drops them. The path
// row's jump needs them to answer "where do this card's per-key rules actually live" when the
// `Key rules` panel is absent — for Appearance that panel never renders at all, because these ARE
// its only keys (deriveMode counts them, buildRuleRows does not).
export function enablementRuleKeysOf(def: ItemDef, item: Item): string[] {
  const sf = item.settingsFile;
  if (sf === undefined) return [];
  const keys = [...Object.keys(sf.rules), ...Object.keys(sf.perElement)].filter((k) => isEnablementRuleKey(def, k));
  return [...new Set(keys)];
}

// Rule rows list ONLY configured keys (rules ∪ perItem) — browsing the file's full key set is the
// File preview's job. Key order: rules
// first (insertion order), then perItem-only keys. A key absent from liveDoc (settings file not
// yet re-read, or the key was removed from the file) defaults isArray to false rather than
// throwing.
export function buildRuleRows(def: ItemDef, item: Item, liveDoc: Record<string, unknown>): FieldRowModel[] {
  const sf = item.settingsFile;
  if (sf === undefined) return [];
  const keys = [...Object.keys(sf.rules), ...Object.keys(sf.perElement).filter((k) => !(k in sf.rules))].filter((k) => !isEnablementRuleKey(def, k));
  return keys.map((key) => ({
    key,
    isArray: isStringArrayValue(liveDoc[key]),
    rule: sf.rules[key] ?? DEFAULT_FIELD_RULE,
    perElementEnabled: key in sf.perElement,
  }));
}

// Progressive-disclosure member-count sentence for a companion's member pill (the pill itself
// shows the bare number — this is its aria-label/tooltip only): "N themes" for the themes/
// preset, "N files" for everything else.
export function memberCountLabel(isThemesPreset: boolean, n: number): string {
  return isThemesPreset ? `${n} themes` : `${n} files`;
}

export function encryptDisabledForSharing(sharing: Sharing): boolean {
  return sharing.kind === "this-device";
}

// Encrypt and per-element rules are mutually exclusive on the same rule (manifest.ts's
// perItem+encrypted rejection) — enforced in BOTH directions at the
// write boundary, not just via disabled controls: encryptToggleDisabled below covers "the Encrypt
// checkbox must render disabled while Per-item is on" (added to the pre-existing this-device
// disable reason); applyPerElementToggle covers "enabling per-element rules must clear encrypted in the SAME
// write", since a rule can already be encrypted:true from before Per-item was ever turned on — a
// disabled checkbox alone only stops a NEW toggle, it doesn't retroactively clear a stale one.
export function encryptToggleDisabled(sharing: Sharing, perElementEnabled: boolean): boolean {
  return encryptDisabledForSharing(sharing) || perElementEnabled;
}

// Which rule rows carry a "this device" answer of their own. Two rows do not, for the
// SAME reason — both entries of a local menu there would produce identical bytes, and an option no
// runtime path will honour is exactly what the spec refused for the element rows one level down:
//
//   1. A key whose items each have their own rule is governed end to end by the per-item
//      machinery, and that machinery has no local layer — capture and apply read the rules and
//      nothing else.
//   2. A key shared with NO ONE (`this-device`) is already absent from the store: stripPatterns
//      drops it on capture and applyTransform preserves the local value, so "don't sync it here"
//      asks for a state the key is permanently in. The shared answer said there is no shared value;
//      the local layer's whole job is opting out of one.
//
// The stored exception (if the key ever had one) is left alone rather than cleared: moving the rule
// back to a shared answer restores a control that means something again, with its old value intact.
export function ruleRowHasLocalLayer(row: FieldRowModel): boolean {
  return !row.perElementEnabled && row.rule.sharing.kind !== "this-device";
}

// No reverse hint: a lock that can't encrypt does not render at all, so there is no
// disabled lock left to carry one — the mutual exclusion still surfaces through this hint on the
// per-item icon while the rule is encrypted.
export const PER_ITEM_DISABLED_HINT = "Turn off Encrypt to enable Per-item device rules.";

// Toggling per-element rules on/off for one Fields-mode row: turning it ON must
// clear `encrypted` on the SAME rule in the SAME write.
export function applyPerElementToggle(sf: ItemSettingsFile, key: string, enabled: boolean): ItemSettingsFile {
  const nextPerElement = { ...sf.perElement };
  if (enabled) nextPerElement[key] = nextPerElement[key] ?? {};
  else delete nextPerElement[key];
  if (!enabled) return { ...sf, perElement: nextPerElement };
  const currentRule = sf.rules[key] ?? DEFAULT_FIELD_RULE;
  return { ...sf, rules: { ...sf.rules, [key]: { ...currentRule, encrypted: false } }, perElement: nextPerElement };
}

export interface PerElementRow {
  element: string;
  sharing: Sharing;
}

export function buildPerElementRows(elements: string[], sharings: PerElementSharing): PerElementRow[] {
  return elements.map((element) => ({ element, sharing: sharings[element] ?? EVERYWHERE }));
}


export const SNIPPET_MEMBER_HINT = "Files always sync — each snippet's choice here is where it's turned on.";

export const SNIPPET_ORPHAN_HINT =
  "A deleted file stays listed while it still has a device choice. Forget clears the choice — the next capture then removes the snippet from every device.";

// The row carries no `sharing` of its own: the member rows are element-rule rows, so
// each one reads its rule through `enablementRuleFor`, the same reader the other two
// entrances use, so a copy handed down through this model would be a second reader with a chance
// to be stale.
export interface SnippetMemberRow {
  name: string;
  fileExists: boolean;
}

// Union of files actually present under snippets/ and any name already given a rule in
// perElement.enabledCssSnippets (so a ruled-but-since-deleted file doesn't just vanish from view —
// fileExists: false marks those orphans for the pill/Forget affordance).
export function buildSnippetMemberRows(fileNames: string[], rules: PerElementSharing): SnippetMemberRow[] {
  const files = new Set(fileNames);
  const names = new Set([...fileNames, ...Object.keys(rules)]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, fileExists: files.has(name) }));
}

// A snippet's rule is written by `withEnablementRule` (enablementRules.ts) like every other
// element's, through the SAME `setEnablementRule` host method the two plugin lists use — one
// writer for one datum. Its empty-map pruning is what keeps a bare `{}` from pinning the card in
// Fields mode forever.


// Tail hint under a non-snippet companion's member-file list — a plain folder has no
// per-file control (see renderPlainCompanionMembers's doc comment), so this clarifies that
// the folder's own device/enabled row above governs every file inside it.
export const FOLDER_MEMBER_HINT = "This folder syncs as a whole — everything in it goes to the devices selected above.";

export interface CompanionRowModel {
  path: string;
  device: DeviceClass;
  enabled: boolean;
  isPreset: boolean;
}

// Presets (themes/, snippets/) must render as a row from the very first open — before the user
// has ever toggled one, cfg.companions has no entry for it yet, so a preset with no matching
// entry gets a synthesized OFF/all-devices default row rather than being missing entirely.
export function buildCompanionRows(def: ItemDef, item: Item): CompanionRowModel[] {
  const configured = item.companions ?? [];
  const byPath = new Map(configured.map((c) => [c.path, c]));
  const presetDefs = def.presetCompanions ?? [];
  const presetPaths = new Set(presetDefs.map((p) => p.path));
  const presetRows: CompanionRowModel[] = presetDefs.map((p) => {
    const existing = byPath.get(p.path);
    return existing !== undefined ? { ...existing, isPreset: true } : { path: p.path, device: "all", enabled: false, isPreset: true };
  });
  const userRows: CompanionRowModel[] = configured.filter((c) => !presetPaths.has(c.path)).map((c) => ({ ...c, isPreset: false }));
  return [...presetRows, ...userRows];
}

// Shared by zone ② "Custom path" and zone ③ "+ Add folder": both accept a vault-relative path
// typed by the user. Trims, turns backslashes into forward slashes (Windows paste), collapses
// "//", and strips leading/trailing slashes. Validation then rejects empty, absolute (leading
// "/" or a drive letter, checked BEFORE the leading slash is stripped) and any ".." segment
// (path escape) — every rejection is a caller-displayed inline error, never a silent no-op.

export function normalizeCompanionPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

const DRIVE_LETTER_RE = /^[a-zA-Z]:/;

export type CompanionPathValidation = { ok: true; path: string } | { ok: false; error: string };

export function validateCompanionPath(raw: string): CompanionPathValidation {
  const trimmed = raw.trim();
  // A path with nothing but slashes (or nothing at all) is empty, not "absolute" — checked
  // before the absolute test below so "///" reports the more useful message.
  if (trimmed.replace(/\/+/g, "") === "") return { ok: false, error: "Enter a path." };
  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/") || DRIVE_LETTER_RE.test(trimmed)) {
    return { ok: false, error: "Path must be vault-relative, not absolute." };
  }
  const path = normalizeCompanionPath(raw);
  if (path === "") return { ok: false, error: "Enter a path." };
  if (path.split("/").includes("..")) return { ok: false, error: 'Path cannot contain ".." segments.' };
  return { ok: true, path };
}

export function companionConflictError(itemLabel: string): string {
  return `${itemLabel} already syncs this path.`;
}

// Basename-derived group-name shape check. registry.ts's
// compileCompanions names a companion group after basename(path) — parseGroup (manifest.ts)
// enforces GROUP_NAME_RE on every group name, so a basename that fails it (a space, a dot, any
// other punctuation) compiles here without complaint but bricks recompile()'s validateSyncManifest
// safety net later, silently zeroing out compiledGroups. Checked separately from
// validateCompanionPath (which only cares about the path's OWN shape — absolute/".."/empty) so a
// settings-file custom path is never subjected to this: its group name is the item id, never the
// path's basename (see registry.ts's compileSingleFile and ItemDef.groupName) — nothing to check there.
export function validateCompanionBasename(path: string): string | null {
  const name = basename(path);
  return GROUP_NAME_RE.test(name)
    ? null
    : `Folder name "${name}" must use only letters, digits, "-" or "_", starting with a letter or digit.`;
}

export function companionNameConflictError(name: string): string {
  return `"${name}" is already used by another synced item — rename this folder or choose a different path.`;
}

// Plain (non-mapKey) companion member listing (themes/ and any user-added
// folder): file/folder names on disk, deduped and sorted. No per-member sharing chip here —
// the switch-list engine only knows
// about community-plugins.json, core-plugins.json and enabledCssSnippets; an arbitrary plain
// directory group has no per-file sharing mechanism to write to.
export function sortCompanionMemberNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}


// The fourth stop answers a DIFFERENT question from the first three. They say who gets the shared
// answer; this one says there is no shared answer at all. That is why it sits below a separator in
// every menu, and why the word leads with the fact rather than the consequence: the consequence
// differs by row kind (an on/off list vs a whole file vs one key), and lives in the three tooltips.
// Spelled here rather than in enablementRow.ts because that module imports THIS one.
export const NOT_SHARED_LABEL = "Not shared";

// Sharing is a union, so its display vocabulary is a function of the value rather than a record
// keyed by a flat enum — a per-class rule's word depends on the class it carries.
export function sharingLabel(sharing: Sharing): string {
  if (sharing.kind === "everywhere") return "All devices";
  // Was "This device", which read as the LOCAL layer's answer sitting in the shared layer's menu —
  // the single likeliest way to confuse the two. It says there is no shared value; what each device
  // then keeps is the consequence, and lives in sharingCycleTooltip below.
  if (sharing.kind === "this-device") return NOT_SHARED_LABEL;
  return sharing.class === "desktop" ? "Desktop only" : "Mobile only";
}

export const FILE_SHARING_OPTIONS: Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile")];
// The shared half of a per-key item's Settings-sync control, in two lines: what decides, then what
// you can do about it. One line carrying both looks like a value stop and behaves like a link.
//
// ONE pair of strings for BOTH surfaces, because both land in the same place and there is nothing
// for two spellings to distinguish. `Open the per-key rules` is true either way: from the Sync
// Center it opens Settings and lands on them, inside Settings it scrolls to them. The ICON is what
// stays surface-specific (`settings-2` only where something really does open Settings).
export const PER_KEY_RULES_STATE_TEXT = "Per-key rules decide this";
export const PER_KEY_RULES_ACTION_TEXT = "Open the per-key rules";
// The trigger's tooltip still has to say both halves in one breath — a tooltip is one line.
export const FILE_SHARING_MENU_UNAVAILABLE_TEXT = "Per-key rules decide — open them in Settings";
export const FIELD_SHARING_OPTIONS: Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];
export const COMPANION_DEVICE_OPTIONS: DeviceClass[] = ["all", "desktop", "mobile"];

// Sharing renders as a Commander-style clickable icon: the icon IS the state, a
// click advances to the next option in the row's own option list, wrapping at the end.
export function sharingIcon(sharing: Sharing): string {
  if (sharing.kind === "everywhere") return "monitor-smartphone";
  if (sharing.kind === "this-device") return "airplay";
  return sharing.class === "desktop" ? "monitor" : "smartphone";
}

export function nextSharing(current: Sharing, options: readonly Sharing[]): Sharing {
  const i = options.findIndex((o) => sharingEquals(o, current));
  if (i !== -1) {
    const next = options[(i + 1) % options.length];
    if (next === undefined) throw new Error("nextSharing: options list is empty");
    return next;
  }
  // Stored value missing from the offered options (e.g. a stale mobile rule on a desktop-only
  // plugin whose cycle no longer offers mobile): resume from the value's slot in the canonical
  // order to the next offered option instead of snapping back to options[0] —
  // the cycle continues, the stale stored value is never silently rewritten.
  const canon: readonly Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];
  const start = canon.findIndex((o) => sharingEquals(o, current));
  for (let step = 1; step <= canon.length; step++) {
    const candidate = canon[(start + step) % canon.length];
    if (candidate !== undefined && options.some((o) => sharingEquals(o, candidate))) return candidate;
  }
  throw new Error("nextSharing: options list is empty");
}

// An answer that only repeats what the plugin's own manifest already says. On a plugin whose
// manifest sets `isDesktopOnly`, `Desktop only` decides nothing — mobile cannot install it under
// any rule — and neither does the absent rule that reads back as `everywhere`. THE producer for
// that fact: a colored glyph and a rule badge both mean "your choice", and `N device-scoped` counts
// decisions, so all three ask here instead of each testing the manifest flag for itself.
// `Not shared` is never a restatement — handing every desktop its own on/off is a real choice the
// manifest has no opinion about. Lives here rather than beside the row model because
// enablementRow.ts imports this module, and the reverse edge would close a cycle.
export function restatesInnate(sharing: Sharing, desktopOnly: boolean): boolean {
  if (!desktopOnly) return false;
  return sharing.kind === "everywhere" || (sharing.kind === "per-class" && sharing.class === "desktop");
}

// The shared segment's tooltip for ONE KEY inside a settings file: the third and weakest of the
// three consequences. A class-scoped key is still synced on every device; the excluded class simply
// keeps its own value instead of the shared one (modes.ts partitions own-class keys into the
// `__scopes__` sidecar and preserves the other class's local value on apply). Nothing is turned off
// and nothing stops syncing, which is exactly what the label alone cannot say.
export function sharingCycleTooltip(sharing: Sharing): string {
  if (sharing.kind === "everywhere") return "One value, the same everywhere.";
  if (sharing.kind === "this-device") return "No shared value. Every device keeps its own.";
  return sharing.class === "desktop"
    ? "Desktops share one value. Each phone keeps its own."
    : "Phones share one value. Each desktop keeps its own.";
}

// The ✎ icon's tooltip/aria.
export const CUSTOM_PATH_LABEL = "Custom path";
// The `eye` icon beside the settings-file filename (SettingTab.ts's
// renderSettingsFilePathRow) — the same string serves as its aria-label and tooltip.
export const FILE_PREVIEW_LABEL = "File preview";
export const PER_ELEMENT_RULES_LABEL = "Per-item device rules";
export const ADD_FOLDER_LABEL = "+ Add folder";
export const SYNC_ALL_LABEL = "Sync all";
export const SYNC_ALL_HINT = "Toggle every plugin below.";
// File-preview footer legend: color dots + neutral words. A single-string legend would render
// as plain text, so the colors it *named* would never show; sharing
// entries reuse the preview's own key color classes so dot and key can never drift apart.
export interface PreviewLegendEntry {
  kind: "sharing" | "lock" | "hint";
  cls: string | null; // dot color class — set exactly when kind is "sharing"
  text: string;
}
// The "click a key to add a rule" hint lives on the preview's TOP action
// line (`config-sync-json-hint` in SettingTab.ts) — the legend carries only
// the color/lock annotations.
export const PREVIEW_LEGEND_ENTRIES: PreviewLegendEntry[] = [
  { kind: "sharing", cls: "config-sync-json-desktop", text: "desktop only" },
  { kind: "sharing", cls: "config-sync-json-mobile", text: "mobile only" },
  // Reads the same word the menu two rows above it uses. It said "this device" until the fourth
  // stop was renamed, at which point the legend was explaining a colour with a name that no control
  // offered any more — and worse, with the LOCAL layer's word for a SHARED-layer answer.
  { kind: "sharing", cls: "config-sync-json-strip", text: "not shared" },
  { kind: "lock", cls: null, text: "encrypted" },
];

// Sync all — one master row per Core/Community/Beta section: toggles
// every card's Item.synced in that section; its own value is derived (all-enabled), never
// stored separately. No kind-exclusion: every def in the section participates.

export function sectionAllEnabled(defs: ItemDef[], items: ItemMap): boolean {
  return defs.length > 0 && defs.every((d) => itemFor(items, d).synced);
}

export function applySyncAll(defs: ItemDef[], items: ItemMap, on: boolean): ItemMap {
  let next = items;
  for (const d of defs) {
    next = withItem(next, d.section, d.id, { ...(itemFor(next, d) ?? emptyItem()), synced: on });
  }
  return next;
}
