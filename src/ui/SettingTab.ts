import { refItemId } from "../core/itemKeys";
import { SettingsDeepLink } from "./settingsDeepLink";
import { PER_KEY_RULES_ACTION_TEXT, PER_KEY_RULES_STATE_TEXT } from "./itemCard";
import { App, ButtonComponent, ExtraButtonComponent, Menu, Notice, Platform, Plugin, PluginSettingTab, Scope, SearchComponent, SecretComponent, Setting, setIcon, setTooltip, TextComponent, ToggleComponent } from "obsidian";
import {
  QualifierAutocomplete,
  parseQuery,
  matchesQualifiers,
  type QualifierSpec,
  type QualifierResolver,
} from "./qualifierSearch";
import {
  DeviceClass,
  EVERYWHERE,
  FieldRule,
  FileSharing,
  GitAuth,
  ItemRef,
  itemRef,
  parseItemRef,
  perClass,
  PerElementSharing,
  Remote,
  RibbonKey,
  Section,
  Sharing,
  sharingClass,
  sharingEquals,
  SyncGroup,
  SyncMode,
  THIS_DEVICE,
} from "../core/types";
import { SensitiveScan } from "../core/modes";
import { PkmMode } from "../core/pkm";
import { validateRemotes } from "../core/manifest";
import { PASSPHRASE_SECRET_ID } from "../core/secrets";
import { keyMatchesAny } from "../core/sanitize";
import { isSwitchListGroup } from "../core/switchList";
import {
  CatalogItem,
  CatalogSection,
  corePluginFile,
  defaultGroupForName,
  expectedPathForName,
  joinLocation,
  reservedNames,
  sectionForGroup,
  SELF_GROUP_NAME,
  splitLocation,
} from "../core/catalog";
import {
  CompileError,
  companionConflict,
  companionNameConflict,
  compileItems,
  customItemFromGroup,
  defaultSettingsFile,
  defForRef,
  defRef,
  deriveMode,
  emptyItem,
  Item,
  itemAt,
  ItemDef,
  ItemFieldRule,
  ItemMap,
  itemFor,
  ItemSettingsFile,
  isEnablementList,
  withItem,
} from "../core/registry";
import { SCHEMA_FUTURE_NOTICE } from "../core/settingsMigration";
import { FolderSelectModal } from "./FolderSelectModal";
import { confirmDropKeyRules, confirmPresetPathChange, confirmTypeFlip } from "./ConfirmModal";
import { commitDraft } from "./commitGroups";
import { classifyJsonKeys, classifyPerElementLines, jsonElementClass, jsonKeyClass, KeyClass } from "./jsonView";
import { renderFoldChevron, setFoldOpen } from "./foldChevron";
import { paintMergedControl } from "./mergedControl";
import { DeviceElementState } from "../core/deviceElements";
import { enablementRules, RuleListId, ruledElementIds } from "../core/enablementRules";
import {
  buildLocalMenu,
  buildOptOutLocalMenu,
  enabledOnTooltip,
  ENABLED_ON_HEADER,
  enablementRowModel,
  MenuSectionModel,
  ON_THIS_DEVICE_HEADER,
  optOutLocalSegment,
  ruleIcon,
  ruleLabel,
  ruleLandingNeedsSeed,
  RowSegment,
  RULE_OPTIONS,
  settingsSyncTooltip,
  SHARED_WITH_HEADER,
  sharingMenuSection,
} from "./enablementRow";
import { StopSyncingModal } from "./SyncCenterView";
import { RunKind, stopSyncDesc } from "../core/runHistory";
import {
  applyPerElementToggle,
  applySyncAll,
  buildCarrierElementRows,
  buildCompanionRows,
  buildPerElementRows,
  Badge,
  buildRuleRows,
  buildSnippetMemberRows,
  carrierBadgeCounts,
  CarrierCounts,
  carrierListFor,
  CARRIER_ELEMENTS_LABEL,
  CompanionRowModel,
  companionConflictError,
  companionNameConflictError,
  computeBadges,
  DEFAULT_FIELD_RULE,
  ENABLED_ON_LABEL,
  DESKTOP_ONLY_ALL_NOTE,
  ENABLED_CSS_SNIPPETS_KEY,
  enablementRuleKeysOf,
  encryptToggleDisabled,
  FIELD_SHARING_OPTIONS,
  FieldRowModel,
  FILE_SHARING_OPTIONS,
  FOLDER_MEMBER_HINT,
  hasEnablementZone,
  hasKeyRules,
  isEnablementRuleKey,
  MODE_ICON,
  MODE_LABELS,
  isStringArrayValue,
  memberCountLabel,
  normalizeCompanionPath,
  PER_ITEM_DISABLED_HINT,
  PER_ELEMENT_RULES_LABEL,
  PREVIEW_LEGEND_ENTRIES,
  ruleRowHasLocalLayer,
  sectionAllEnabled,
  settingsFileZoneKind,
  sharingCycleTooltip,
  sharingIcon,
  sharingLabel,
  SnippetMemberRow,
  sortCompanionMemberNames,
  SNIPPET_MEMBER_HINT,
  SNIPPET_ORPHAN_HINT,
  stateOnlyHint,
  SYNC_ALL_HINT,
  SYNC_ALL_LABEL,
  COMPANION_DEVICE_OPTIONS,
  ADD_FOLDER_LABEL,
  CUSTOM_PATH_LABEL,
  FILE_PREVIEW_LABEL,
  validateCompanionBasename,
  validateCompanionPath,
} from "./itemCard";
import { resolveGitToken } from "../external/gitToken";

export interface SettingsHost extends Plugin {
  settings: {
    pkmMode: PkmMode;
    rootPath: string;
    remotes: Remote[];
    ribbonButtons: Record<RibbonKey, boolean>;
    statusInMenu: boolean;
    statusBarItem: boolean;
    statusBarRemote: boolean;
    ribbonDot: boolean;
    mobileStatusBar: boolean;
    remoteAutoCheck: boolean;
    localPeriodicCheck: boolean;
    runHistory: { enabled: boolean; path: string; maxCount: number; maxDays: number };
    // Unified-card model (spec §6): the Obsidian tab's card
    // renderer reads/writes these fields directly, durably, through saveSettings() (which
    // persists AND recompiles — see main.ts).
    // Every section, custom items included: the Advanced tab's "Custom rules"/"Discovered files"
    // are items.custom entries, read/written through the same durable contract.
    items: ItemMap;
  };
  saveSettings(): Promise<void>;
  // False while this device's data.json was written by a newer Config Sync (the §4.2b
  // hardening rule). Every writer in this file is mutate-then-save, and
  // `saveSettings` refuses too late to undo the mutation — so the write must be refused BEFORE it
  // touches `settings`, or memory diverges from disk with no recompile. Asking also tells the
  // user why (the refusal notice fires here, on their gesture).
  settingsWritable(): boolean;
  // The two enablement layers (spec §6.6), one read/write pair each — the SAME pair the Sync
  // Center's row of the same name calls, so the three entrances cannot drift apart. `RuleListId`,
  // not `EnablementList`: the snippet rows need the third list.
  enablementRuleFor(list: RuleListId, elementId: string): Sharing;
  setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void>;
  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null;
  // Take the element out of the shared answer, keeping EXACTLY what it is right now (spec §6.5).
  leaveToThisDevice(list: RuleListId, elementId: string): Promise<void>;
  followTheDefault(list: RuleListId, elementId: string): Promise<void>;
  setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void>;
  // Which elements of a list THIS device has taken out of the shared answer — the local half of a
  // carrier card's badges and of its element list. `deviceElementFor` cannot answer it one element
  // at a time: the table is localStorage (deviceElements.ts), and only main.ts reads that.
  deviceElementIds(list: RuleListId): string[];
  // The whole-file layer's read/write pair (spec §6.4) — the SAME pair the Sync Center host's
  // Stop-syncing menu calls, so a row toggled from either surface never drifts from the other.
  deviceOptedOut(groupName: string): boolean;
  setDeviceOptOut(groupName: string, optedOut: boolean): Promise<void>;
  // The per-key sibling of the pair above (spec §6.6, one layer down): which of an item's own
  // rule patterns THIS device has taken out of sync (deviceFields.ts) — read and write, one pair.
  deviceFieldExceptedFor(ref: ItemRef, pattern: string): boolean;
  setDeviceFieldExcepted(ref: ItemRef, pattern: string, excepted: boolean): Promise<void>;
  // The card head's destructive action (spec §6.2). `appendActionHistory` exists on both hosts:
  // the leftover-cleanup entry the Sync Center view records is the same run history.
  stopSyncing(groupName: string, deleteStore: boolean): Promise<string[] | null>;
  storeFileCount(groupName: string): Promise<number>;
  appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void>;
  // Drops the per-refresh reader cache: call after settings.remotes changes so a stale
  // reader for an edited/removed remote's old URL/branch/subdir/storePath is never reused.
  clearReaderCache(): void;
  // The registry's item defs (registry.ts's buildItemDefs, rebuilt by main.ts on every
  // recompile) — the unified-card renderer's only source of which cards exist.
  itemDefs(): ItemDef[];
  // The Sync Center More bridge's pending target (main.ts's openSettingsAt), read-and-cleared:
  // null on a normal Settings open, else the item ref whose card render() should expand and
  // scroll to once, this open only.
  consumePendingSettingsAnchor(): SettingsDeepLink | null;
  // Basenames (no extension) of .css files actually present under the vault's snippets/ folder —
  // feeds the Appearance card's snippets companion member rows (spec §4/§5).
  listSnippetFiles(): Promise<string[]>;
  // Immediate child file/folder names of an arbitrary companion path — feeds
  // the plain (non-mapKey) companion member listing zone ③ shows for themes/ and any user-added
  // folder. `path` is a companion's own path field (may be "{configDir}/…" or vault-relative).
  listCompanionFiles(path: string): Promise<string[]>;
  clearRunHistory(): Promise<void>;
  refreshRibbons(): void;
  updateStatusIndicators(): void;
  applyMobileStatusBar(): void;
  // The full compiled sync list (every section's items, compiled by registry.ts's compileItems) — read-only from this file's point of view; every write path this
  // file drives (unified cards AND the Advanced tab) goes through settings.items + saveSettings(),
  // never a raw group-list write.
  readGroupsFile(): Promise<SyncGroup[]>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listBetaSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  bratScanStatus(): Promise<{ resolved: number; total: number }>;
  refreshBratIndex(): Promise<{ resolved: number; total: number }>;
  listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>;
  installedPluginIds(): string[];
  detectSensitive(group: SyncGroup): Promise<SensitiveScan>;
  readItemFile(group: SyncGroup): Promise<string | null>;
  passphrase(): string | null;
  setPassphrase(v: string | null): void;
  passphraseKeychainBacked(): boolean;
  displayName(group: string, storedLabel?: string): string;
}

// ── The item card's derived keys — ONE producer each ────────────────────────────────────────
//
// A card row carries a `data-search-anchor` and its drawer is keyed in `expanded`. Four places
// need those two strings: the card renderer that WRITES the anchor, the search index that emits
// one to jump to, the More bridge's anchor consumer, and jumpTo's derivation of the drawer key
// from an anchor.
//
// A derived key with four authors diverges on the next rename. These are its only authors, and
// `refFromItemAnchor` is the single inverse so jumpTo cannot re-derive it by hand either.
const ITEM_ANCHOR_PREFIX = "item-";
const CARD_EXPAND_PREFIX = "card:";

export function itemAnchorId(ref: ItemRef): string {
  return `${ITEM_ANCHOR_PREFIX}${ref}`;
}

export function cardExpandKey(ref: ItemRef): string {
  return `${CARD_EXPAND_PREFIX}${ref}`;
}

// The inverse of itemAnchorId, for the one caller that starts from an anchor rather than a def.
// Returns null for an anchor that is not an item's (a General setting, an Advanced rule, a
// remote) or that does not carry a legal ref — parseItemRef is the same narrowing every other
// ref reader uses, so a `beta/…` anchor is refused here exactly as it is everywhere else.
export function refFromItemAnchor(anchorId: string): ItemRef | null {
  if (!anchorId.startsWith(ITEM_ANCHOR_PREFIX)) return null;
  const rest = anchorId.slice(ITEM_ANCHOR_PREFIX.length);
  const parsed = parseItemRef(rest);
  return parsed === null ? null : itemRef(parsed.section, parsed.id);
}

// The snippets list id, spelled once (spec §6.6). Appearance's member rows are elements of
// `enabled-css-snippets` exactly as a plugin row is an element of its plugin list — the same rule
// store, the same writer, the same row.
const SNIPPET_LIST: RuleListId = "enabled-css-snippets";

const SENSITIVE_ENCRYPT_RE = /apikey|api_key|token|secret|password|credential/i;

function defaultFieldsFromDetection(keys: string[]): FieldRule[] {
  return keys.map((pattern) => ({ pattern, ...(SENSITIVE_ENCRYPT_RE.test(pattern) ? ENCRYPT_RULE : LOCAL_RULE) }));
}

// Tooltip-borne, and deliberately NOT repeated as visible copy: the `KEY RULES` zone label sits
// directly below this row and answers the same question nearer and permanently, so a visible line
// would only say twice what the layout already says once. The reading path that matters starts at
// the eye (browse the file), and adding a key raises that zone label on its own.
// One tooltip saying both halves, because a tooltip is one line. The MENU says them as two
// (itemCard.ts's PER_KEY_RULES_STATE_TEXT / _ACTION_TEXT) — and the Sync Center's copy of this row
// reads from the same constants, so the two surfaces can no longer word the same fact differently.
const PER_KEY_RULES_TOOLTIP = "Per-key rules decide — open them below";

// The Access-token control's standing explanation (DESIGN.md §4 Remote editor): tooltip-borne, so
// it never spends a form row of its own.
const TOKEN_LINK_HINT = "For https URLs. Without a token, this device's own git sign-in is used. Stored in Obsidian's keychain — link it once per device.";

// zone ② body's file-read outcome (renderCardBodyInto below): "missing" = no file on this device
// yet, "invalid" = present but not a JSON object, "ok" = usable — only "ok" carries a doc worth
// handing to buildRuleRows/renderCardDataPreview.
type CardFileState = "missing" | "invalid" | "ok";

function parseCardDoc(raw: string | null): { doc: Record<string, unknown>; fileState: CardFileState } {
  if (raw === null) return { doc: {}, fileState: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { doc: {}, fileState: "invalid" };
  return { doc: parsed as Record<string, unknown>, fileState: "ok" };
}

// The protective default for a hand-typed pattern (the glob input): a credential glob should
// start local, not shared. The card-style click-to-add uses its own everywhere/sensitive default.
const LOCAL_RULE: Pick<FieldRule, "sharing" | "encrypted"> = { sharing: THIS_DEVICE, encrypted: false };
const ENCRYPT_RULE: Pick<FieldRule, "sharing" | "encrypted"> = { sharing: EVERYWHERE, encrypted: true };

interface RemoteDraft {
  name: string;
  type: "vault" | "git";
  storePath: string;
  url: string;
  branch: string;
  subdir: string;
  excludeSelf: boolean;
  tokenId: string;
  username: string;
}

// One shape for every result strip: a headline sentence, plus — only when there is one — a second,
// quieter line carrying the raw technical detail.
//
// The detail never joins the headline. An operator needs git's own words; a reader needs a sentence
// they can act on; one string cannot be both, and trying made
// `Could not reach remote — git ls-remote --heads failed in .: Command failed: git ls-remote
// --heads fatal: bad repository ''` — three restatements of one failure, with the only informative
// clause last. Headlines are two short sentences (what happened, what to do) and carry no dash.
function writeTestStrip(
  strip: HTMLElement,
  tone: "is-testing" | "is-ok" | "is-caution" | "is-error",
  headline: string,
  detail: string | null
): void {
  strip.className = `config-sync-test-strip ${tone}`;
  strip.empty();
  strip.createDiv({ text: headline });
  if (detail !== null) strip.createDiv({ cls: "config-sync-strip-detail", text: detail });
}

function toDraft(r: Remote): RemoteDraft {
  return {
    name: r.name,
    type: r.type,
    storePath: r.type === "vault" ? r.storePath : "",
    url: r.type === "git" ? r.url : "",
    branch: r.type === "git" ? r.branch : "",
    subdir: r.type === "git" ? (r.subdir ?? "") : "",
    excludeSelf: r.excludeSelf === true,
    tokenId: r.type === "git" ? (r.tokenId ?? "") : "",
    username: r.type === "git" ? (r.username ?? "") : "",
  };
}

function toCandidate(d: RemoteDraft): unknown {
  const c: Record<string, unknown> = { name: d.name, type: d.type };
  if (d.type === "vault") {
    c.storePath = d.storePath;
  } else {
    c.url = d.url;
    c.branch = d.branch;
    if (d.subdir.trim() !== "") c.subdir = d.subdir.trim();
    if (d.tokenId !== "") c.tokenId = d.tokenId;
    if (d.username !== "") c.username = d.username;
  }
  if (d.excludeSelf) c.excludeSelf = true;
  return c;
}

type PanelTab = "general" | "obsidian" | "core" | "plugins" | "beta" | "advanced" | "sources";

// Section -> the tab that renders it (the "community" section shows under this panel's "plugins"
// tab; every other section keeps its own name). `custom` has no card list — its items are the
// Advanced tab's rules, which that tab renders itself.
const SECTION_TAB: Record<Section, PanelTab> = { obsidian: "obsidian", core: "core", community: "plugins", beta: "beta", custom: "advanced" };

const TABS: { id: PanelTab; label: string; icon: string; desktopOnly?: true }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "obsidian", label: "Obsidian", icon: "gem" },
  { id: "core", label: "Core plugins", icon: "toy-brick" },
  { id: "plugins", label: "Community plugins", icon: "puzzle" },
  { id: "beta", label: "Beta", icon: "flask-conical" }, // BRAT's own BratIcon when registered
  { id: "advanced", label: "Advanced", icon: "wrench" },
  { id: "sources", label: "Remotes", icon: "git-branch", desktopOnly: true },
];

// Single source of truth for General's Settings: used both to render (data-search-anchor
// attached to each Setting) and to build the search index, so the two can't drift.
interface GeneralSettingDef {
  name: string;
  desc: string;
  anchorId: string;
}

const GENERAL_SETTINGS: GeneralSettingDef[] = [
  { name: "PKM mode", desc: "Adjusts the recommended storage location to match how your vault is organized. Auto detects IOTO vaults.", anchorId: "general-pkm-mode" },
  {
    name: "Store folder",
    // Rendered desc appends a computed "(currently: <resolved path>)" suffix that depends on an
    // async host.resolvedRootPath() call; this static text is the search-index copy only.
    desc: "Where your synced settings live inside this vault. Your regular vault sync (e.g. remotely-save) carries this folder to your other devices.",
    anchorId: "general-data-folder",
  },
  { name: "Sync menu shows change counts", desc: "Counts changed items when the menu opens. Turn off if opening the menu feels slow.", anchorId: "general-status-in-menu" },
  { name: "Check remotes automatically", desc: "Checks each remote's last capture shortly after startup and every few hours.", anchorId: "general-remote-auto-check" },
  {
    name: "Periodic local check",
    desc: "Re-scans for local changes every 5 minutes while the window is focused, keeping the status bar fresh.",
    anchorId: "general-local-periodic-check",
  },
  { name: "Passphrase", desc: "Needed for Encrypt modes. Enter the same passphrase on each device; it is never stored in the store or synced.", anchorId: "general-passphrase" },
  {
    name: "Show status bar item",
    desc: "Sync status in the status bar: ↑ to capture, ↓ to apply. Click opens the Sync Center.",
    anchorId: "general-status-bar-item",
  },
  {
    name: "Show remote push/pull in status bar",
    desc: "Include per-remote push ⇡ and pull ⇣ counts. Desktop only — remote checks don't run on mobile.",
    anchorId: "general-status-bar-remote",
  },
  {
    name: "Ribbon icon status dot",
    desc: "Colored corner dot on the ribbon icon — the old indicator, now off by default (invisible when the icon sits inside a ribbon group).",
    anchorId: "general-ribbon-dot",
  },
  {
    name: "Show status bar on mobile",
    desc: "Force the status bar visible on phones (Obsidian hides it by default). Leave off if another plugin or snippet already shows it.",
    anchorId: "general-mobile-status-bar",
  },
  {
    name: "Ribbon buttons",
    desc: "The Config Sync ribbon icon always opens a menu of available actions. Optionally also show individual ribbon icons.",
    anchorId: "general-ribbon-buttons",
  },
  { name: "Run history", desc: "Record every capture, apply, pull and push, and browse past runs from the Sync Center's History entry. Kept on this device only — never synced.", anchorId: "general-run-history" },
  { name: "History file", desc: "A separate file next to the plugin's data.json (never inside it). Change to store the history elsewhere; leave blank for the default.", anchorId: "general-run-history-path" },
  { name: "Keep at most", desc: "Older runs beyond this count are pruned automatically. 0 keeps every run.", anchorId: "general-run-history-count" },
  { name: "Keep for", desc: "Runs older than this many days are pruned automatically. 0 keeps runs forever.", anchorId: "general-run-history-days" },
  { name: "Clear run history", desc: "Delete every recorded run. This cannot be undone.", anchorId: "general-run-history-clear" },
];

interface SearchHit {
  section: "general" | "obsidian" | "core" | "plugins" | "beta" | "advanced" | "sources";
  kind: "setting" | "item" | "rule" | "discovered" | "remote";
  name: string;
  desc: string;
  anchorId: string;
  item?: Pick<CatalogItem, "type">;
  // The compiled group this hit stands for, when the hit's TAB is not also its family — the
  // Advanced tab's rules and discovered files (§4). Read by settingSectionValue alone, to ask the
  // Sync Center's own producer which family the item belongs to.
  groupName?: string;
}

const SECTION_LABEL: Record<SearchHit["section"], string> = {
  general: "General",
  obsidian: "Obsidian",
  core: "Core",
  plugins: "Community",
  beta: "Beta",
  advanced: "Advanced",
  sources: "Remotes",
};

// --- Qualifier search vocabulary (SettingTab) ---
//
// A hit answers with its settings AREA — this panel's own tabs — and, when the two differ, ALSO
// with the family the item belongs to (§4). The family is not spelled out here: it comes from
// `sectionForGroup`, the very function the Sync Center's `section:` resolver uses, so a custom rule
// answers the same word in both search boxes by construction rather than by two authors happening
// to type "custom" twice. Both answers are true of an Advanced-tab rule — it IS a custom item, and
// it DOES live on that tab — which is why this returns a list rather than picking one.
//
// Only the hits whose tab is not their family carry a `groupName` (see SearchHit): a card hit's tab
// IS its family, and asking `sectionForGroup` for a core plugin whose id this build has not been
// told about would answer "custom" — a wrong second word for a hit that needs no second word.
export function settingSectionValue(hit: Pick<SearchHit, "section" | "groupName">): string[] {
  const area = hit.section === "plugins" || hit.section === "beta" ? "community" : hit.section === "sources" ? "remotes" : hit.section;
  const family: string | null = hit.groupName === undefined ? null : sectionForGroup(hit.groupName);
  return family === null || family === area ? [area] : [area, family];
}
export function settingTypeValue(hit: Pick<SearchHit, "item">): "file" | "folder" | null {
  if (hit.item === undefined) return null;
  return hit.item.type;
}

// `section:` — spec §7, the same word the Sync Center's search bar uses, so one concept is typed one
// way in both boxes. NO `scope:` alias: a key this set doesn't know is free text, so a
// typed `scope:core` searches for those literal words instead of quietly filtering.
//
// Here `section` names the settings AREA — this panel's own tabs — where the Sync Center's names an
// item family. The overlap is deliberate (`obsidian`/`core`/`community` mean the same items in
// both); the extras are the areas that hold no items at all: `general` and `remotes`, plus
// `advanced`, which is where custom rules and discovered files live in this panel.
//
// `custom` is the one word that is a family here rather than an area (§4): an Advanced-tab rule
// answers both words; `advanced` still means that tab, its own non-item settings included.
//
// Exported for the tests, which assert against the shipped list rather than restating it; `as const`
// is what makes the resolver map below total over these keys (see SYNC_QUALIFIER_SPECS).
export const SETTING_QUALIFIER_SPECS = [
  { key: "section", description: "settings area", values: [{ value: "general" }, { value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "advanced" }, { value: "custom" }, { value: "remotes" }] },
  { key: "type", description: "item kind", values: [{ value: "file", description: "single file" }, { value: "folder", description: "whole folder" }] },
] as const satisfies readonly QualifierSpec[];
export type SettingQualifierKey = (typeof SETTING_QUALIFIER_SPECS)[number]["key"];
export const SETTING_QUALIFIER_KEYS: ReadonlySet<string> = new Set(SETTING_QUALIFIER_SPECS.map((s) => s.key));
// Exported for the same reason the spec list is: the tests run their queries through the SHIPPED
// resolver map, so "the panel answers `type:folder`" is asserted about the filter the panel really
// runs rather than about a second copy of it written in the test.
export const SETTING_QUALIFIER_RESOLVERS: Record<SettingQualifierKey, QualifierResolver<SearchHit>> = {
  section: (h) => settingSectionValue(h),
  type: (h) => settingTypeValue(h),
};

// Writes/clears one member's device class for a switch group; "all" is the absent default, so it
// deletes the key.
export function setMemberDeviceClass(
  classes: Record<string, "desktop" | "mobile">,
  name: string,
  value: "all" | "desktop" | "mobile",
): Record<string, "desktop" | "mobile"> {
  const next = { ...classes };
  if (value === "all") delete next[name];
  else next[name] = value;
  return next;
}

// Every settingsFile write funnels through here (spec §3.1 auto-switch) so the stored `mode` is
// never a user choice — it's re-derived from the rules/
// perElement the write just produced. A write that lands on "fields" also drops any `fileRule`: the
// two are a manifest-illegal combination (manifest.ts rejects fields+fileRule), and forcing this
// here means every settingsFile-mutating call site gets that invariant for free instead of having
// to remember it individually.
function withDerivedMode(sf: ItemSettingsFile): ItemSettingsFile {
  const mode = deriveMode(sf);
  return mode === "fields" ? { ...sf, mode, fileRule: undefined } : { ...sf, mode };
}

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: RemoteDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private search = "";
  private searchSection: SearchHit["section"] | "all" = "all";
  private readonly qac = new QualifierAutocomplete(SETTING_QUALIFIER_SPECS);
  private bodyEl: HTMLElement | null = null;
  private expanded = new Set<string>(); // UI-transient: advanced rows expanded this session
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  // One error slot per remote card, so a validation error pins under the card it names —
  // rebuilt on every renderSources; live-updated (no re-render) by saveRemotes.
  private sourceErrorEls: HTMLElement[] = [];
  private sourcesErrorFor: number | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";
  // null = no pinned error — an "" sentinel would collide with the unnamed placeholder rule's
  // empty NAME, showing a blank inline error after a successful save.
  private saveErrorFor: string | null = null;
  private detections = new Map<string, SensitiveScan>(); // group name -> live scan, filled in as reads complete
  private passphraseStatusEl: HTMLElement | null = null;
  private betaAutoScanned = false; // one automatic index re-scan per panel lifetime
  private customPathEditing = new Set<string>(); // UI-transient: zone ② "Custom path" inputs open but not yet committed
  private addingCompanion = new Set<string>(); // UI-transient: zone ③ "+ Add folder" inputs open
  private companionPathEditing = new Set<string>(); // UI-transient: zone ③ rows mid path-edit ("def.id::path")
  private previewOpen = new Set<string>(); // UI-transient: zone ② "File preview" disclosure open this session, keyed by def.id
  private membersOpen = new Set<string>(); // UI-transient: zone ③ member-list disclosure open this session, keyed "def.id:path" (spec §4)
  // In-place refresh hooks for enable toggles: a per-card toggle rebuilds only the section "Sync
  // all" headers, and "Sync all" rebuilds only the cards — never rerender(), whose
  // containerEl.empty() + async rebuild visibly flashes and drops the panel mid-scroll.
  private syncAllRebuilds: (() => void)[] = []; // cleared each rerender
  private cardHosts: { wrap: HTMLElement; def: ItemDef }[] = []; // cleared each rerender
  // Obsidian's ToggleComponent.setValue fires the component's own onChange when the value really
  // changes, so the card head's snap-back (`setValue(true)` while the modal decides) would re-enter
  // that handler with `true` and write `synced: true` to a card that never stopped being synced.
  // This makes the snap-back what it looks like: a display correction, not a gesture.
  private snappingBackToggle = false;

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false;
    this.activeTab = "general";
    this.search = "";
    this.searchSection = "all";
    this.expanded.clear();
    // The More bridge's pending anchor (main.ts's openSettingsAt): consumeSettingsAnchor already
    // set activeTab/expanded above if one was pending, so the render below opens on the right
    // card — then delegate to the SAME scroll+highlight jumpTo() uses (highlightAnchor), so More
    // and search-bar jumps land identically. One anchoring mechanism in this file.
    const anchor = this.consumeSettingsAnchor();
    void this.rerender(0).then(() => {
      if (anchor !== null) this.highlightAnchor(anchor);
    });
  }

  hide(): void {
    this.qac.destroy(); // release the widget's document-level listener when the settings tab closes
  }

  private refresh(): void {
    void this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): Promise<void> {
    const gen = ++this.renderGen;
    this.bodyEl = null;
    this.syncAllRebuilds = [];
    this.cardHosts = [];
    this.containerEl.empty();
    return this.render(this.containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.saveErrorFor = null;
    void this.rerender(0);
  }

  private async render(containerEl: HTMLElement, gen: number, scrollTop: number): Promise<void> {
    if (gen !== this.renderGen) return;
    if (!this.loaded) {
      try {
        this.groups = await this.host.readGroupsFile();
        this.groupsReadError = null;
      } catch (e) {
        this.groups = [];
        this.groupsReadError = (e as Error).message;
      }
      if (gen !== this.renderGen) return;
      this.sources = this.host.settings.remotes.map(toDraft);
      this.loaded = true;
    }
    this.renderSearchBox(containerEl);
    this.bodyEl = containerEl.createDiv({ cls: "config-sync-settings-body" });
    await this.renderBody(this.bodyEl, gen);
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
  }

  // The More bridge's other end (main.ts's openSettingsAt): reads-and-clears the pending item id,
  // picks the tab that renders it, and pre-expands its card so the render display() kicks off
  // right after already opens it expanded. Registry items (obsidian/core/plugins/beta tabs) are
  // anything itemDefs() knows about, keyed through cardExpandKey/itemAnchorId (the same producers
  // renderItemCard and jumpTo's search-hit navigation use). Everything itemDefs() doesn't know about — a custom
  // rule or an adopted discovered file — is a folder, and a folder's device config only
  // ever renders in the Advanced tab under its bare group name (renderRuleCard/
  // renderDiscoveredOnRow): the honest target for its "Folder rules" row, since that's the only
  // place the config exists. Returned anchorId feeds highlightAnchor once display()'s render
  // settles — the caller never scrolls itself.
  private consumeSettingsAnchor(): string | null {
    const link = this.host.consumePendingSettingsAnchor();
    if (link === null) return null;
    const { ref, spot } = link;
    const parsed = parseItemRef(ref);
    if (parsed === null) return null;
    // defForRef, never `d.section === parsed.section`: a BRAT-managed
    // plugin's def PRESENTS as `beta` while its ref stores `community`, so the raw comparison
    // would never match and every beta card's "More ▸ opens Settings" would land on the Advanced
    // tab with a dead anchor. Both sides go through storageSection exactly once in there.
    const def = defForRef(this.host.itemDefs(), ref);
    if (def !== undefined) {
      this.activeTab = SECTION_TAB[def.section];
      this.expanded.add(cardExpandKey(ref));
      // `key-rules` lands on the rules themselves, so it hands off to landPendingKeyRulesJump and
      // returns NO card anchor: flashing the whole card first and the rules a moment later would
      // read as two different answers to one click. Card-level jumps (More) keep the card flash.
      if (spot === "key-rules") {
        this.pendingKeyRulesJump = def.id;
        return null;
      }
      return itemAnchorId(ref);
    }
    this.activeTab = "advanced";
    this.expanded.add(parsed.id);
    return `advanced-rule-${parsed.id}`;
  }

  private async renderBody(bodyEl: HTMLElement, gen: number): Promise<void> {
    if (gen !== this.renderGen) return;
    bodyEl.empty();
    if (this.search.trim() !== "") {
      await this.renderSearchResults(bodyEl, gen);
    } else {
      this.renderTabNav(bodyEl);
      await this.renderActiveTab(bodyEl, gen);
    }
  }

  private renderSearchBox(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "config-sync-search" });
    const search = new SearchComponent(wrap);
    search.setPlaceholder("Search all settings…");
    search.setValue(this.search);
    search.onChange((v) => {
      this.search = v;
      this.searchSection = "all";
      const body = this.bodyEl;
      if (body === null) return;
      void this.renderBody(body, this.renderGen);
    });
    this.qac.attach(search.inputEl);
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
    for (const tab of TABS) {
      if (tab.desktopOnly === true && Platform.isMobile) continue;
      const el = nav.createEl("button", { cls: "config-sync-tab" });
      const iconEl = el.createSpan({ cls: "config-sync-tab-icon" });
      if (tab.id === "beta") {
        // BRAT registers "BratIcon" at load; setIcon leaves the span empty when the id is
        // unknown, so probe first and fall back to the flask.
        setIcon(iconEl, "BratIcon");
        if (iconEl.childElementCount === 0) setIcon(iconEl, tab.icon);
      } else {
        setIcon(iconEl, tab.icon);
      }
      el.createSpan({ cls: "config-sync-tab-label", text: tab.label });
      setTooltip(el, tab.label);
      el.setAttr("aria-label", tab.label);
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => this.switchTab(tab.id));
    }
  }

  private async renderActiveTab(containerEl: HTMLElement, gen: number): Promise<void> {
    if (this.activeTab === "sources" && Platform.isMobile) this.activeTab = "general";
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        this.renderStatusToggles(containerEl);
        this.renderPassphrase(containerEl);
        this.renderStatusBarToggles(containerEl);
        this.renderRibbonToggles(containerEl);
        this.renderRunHistory(containerEl);
        break;
      case "obsidian":
        await this.renderRegistryCards(containerEl, gen, "obsidian", false);
        break;
      case "core":
      case "plugins":
      case "beta":
        if (this.activeTab === "beta") await this.renderBetaHeader(containerEl, gen);
        if (gen !== this.renderGen) return;
        await this.renderRegistryCards(containerEl, gen, this.activeTab === "plugins" ? "community" : this.activeTab, true);
        break;
      case "advanced":
        if (this.renderGroupsReadError(containerEl)) break;
        await this.renderAdvanced(containerEl, gen);
        if (gen !== this.renderGen) return;
        this.renderGroupsError(containerEl);
        break;
      case "sources":
        this.renderSources(containerEl);
        break;
    }
  }

  private async sectionsFor(tab: "obsidian" | "core" | "plugins" | "beta"): Promise<CatalogSection[]> {
    if (tab === "obsidian") return this.host.listOptionSections(this.groups);
    if (tab === "core") return this.host.listCoreSections(this.groups);
    if (tab === "beta") return this.host.listBetaSections(this.groups);
    return this.host.listPluginSections(this.groups);
  }

  // Beta tab header: what the tab is, the map-note line with the resolve
  // state, and ↻ Re-scan. Unresolved repos trigger one automatic background re-scan per
  // panel lifetime — failures wait for the next manual scan instead of looping.
  private async renderBetaHeader(containerEl: HTMLElement, gen: number): Promise<void> {
    const status = await this.host.bratScanStatus();
    if (gen !== this.renderGen) return;
    const head = new Setting(containerEl)
      .setName("Beta plugins")
      .setDesc("Plugins installed through BRAT instead of the community catalog. Settings sync the same way — only the install path differs.")
      .setHeading();
    head.settingEl.setAttribute("data-search-anchor", "beta-header");
    // The map note renders ONLY while something is unresolved: a fully-resolved
    // list is pure noise — the install path does its own last-chance refresh, and this tab
    // auto-rescans below. While incomplete it matters: an unmatched beta plugin's install would
    // fall back to the community catalog, which a beta-only plugin isn't in.
    if (status.resolved < status.total) {
      const note = containerEl.createDiv({ cls: "config-sync-beta-mapnote" });
      note.createSpan({ text: `Matched from BRAT's beta list · ${status.resolved} of ${status.total} repos resolved` });
      new ExtraButtonComponent(note)
        .setIcon("rotate-cw")
        .setTooltip("Re-scan BRAT's list")
        .onClick(async () => {
          await this.host.refreshBratIndex();
          this.refresh();
        });
    }
    if (status.resolved < status.total && !this.betaAutoScanned) {
      this.betaAutoScanned = true;
      void this.host.refreshBratIndex().then(() => this.refresh());
    }
  }

  // ── Unified card renderer — every ItemDef section (spec §4/§5) ──────────────────────────────
  // One renderer for every ItemDef: name + badges + sync toggle + chevron on the row, a drawer
  // with a Settings sync zone (and, for Appearance, a Companion folders zone). Reads/writes
  // settings.items directly through host.saveSettings() — durable, recompiles. The Advanced
  // tab's custom-rule/discovered-file editor (below) is durable the same way, through
  // items.custom (persistCustomItems).

  private itemOf(def: ItemDef): Item {
    return itemFor(this.host.settings.items, def);
  }

  // The card's two enablement layers, for the badges and the `Enabled on` row — null for a
  // def with no enablement projection at all (an Obsidian/custom card), so a badge is never derived
  // from a list this item does not live in.
  private enablementOf(def: ItemDef): { rule: Sharing; exception: DeviceElementState | null } | null {
    const enablement = def.enablement;
    if (enablement === undefined) return null;
    return {
      rule: this.host.enablementRuleFor(enablement.list, enablement.element),
      exception: this.host.deviceElementFor(enablement.list, enablement.element),
    };
  }

  // A carrier card's two badge counts (spec §6.4) — null for every card that carries no list, so a
  // count is never derived for a card whose drawer has no elements to count.
  private carrierCountsOf(def: ItemDef): CarrierCounts | null {
    const list = carrierListFor(def);
    if (list === null) return null;
    // The badge needs the exception STATES, not just how many there are: all-on draws `power`,
    // all-off `power-off`, and only a mix falls back to the neutral mark. `deviceElementIds`
    // returns exactly the ids that HAVE a state, so `deviceElementFor` answers for every one of
    // them — mirrored with a flatMap rather than asserted, the same way driftFor's guarantee is.
    const states = this.host
      .deviceElementIds(list)
      .flatMap((id) => {
        const state = this.host.deviceElementFor(list, id);
        return state === null ? [] : [state];
      });
    return carrierBadgeCounts(this.host.settings.items, list, states);
  }

  // Every settings-tab write funnels through here — the mutators themselves only ever spread what
  // they get, and the two-level map write is done in one place (registry.ts's withItem).
  private async updateItem(def: ItemDef, mutator: (item: Item) => Item): Promise<void> {
    if (!this.host.settingsWritable()) return; // §4.2b — refuse before the mutation, not after
    const next = mutator(itemAt(this.host.settings.items, def.section, def.id) ?? emptyItem());
    this.host.settings.items = withItem(this.host.settings.items, def.section, def.id, next);
    await this.host.saveSettings();
  }

  // A throwaway SyncGroup carrying only what readItemFile/detectSensitive actually read
  // (name/path/type) — the unified card model has no compiled SyncGroup of its own to hand them.
  private cardProbeGroup(def: ItemDef, item: Item): SyncGroup | null {
    const path = item.path ?? def.settingsFile?.defaultPath ?? null;
    if (path === null) return null;
    return { name: def.groupName, path, type: "file", devices: "all" };
  }

  private ensureCardDetection(def: ItemDef, item: Item): void {
    if (this.detections.has(def.id)) return;
    const probe = this.cardProbeGroup(def, item);
    if (probe === null) return;
    void (async () => {
      let scan: SensitiveScan;
      try {
        scan = await this.host.detectSensitive(probe);
      } catch {
        return;
      }
      this.detections.set(def.id, scan);
    })();
  }

  // One card list for any ItemDef section — the Obsidian tab (no Sync-all master row: its five
  // cards are concept areas, not a plugin list) and Core/Community/Beta (Sync-all, spec §4/§5/§10,
  // D11 — a single master row over every card in the section, no kind-exclusion of any kind: every
  // def participates, including state-only core cards).
  private async renderRegistryCards(containerEl: HTMLElement, gen: number, section: Section, withSyncAll: boolean): Promise<void> {
    const defs = this.host.itemDefs().filter((d) => d.section === section);
    for (const def of defs) this.ensureCardDetection(def, this.itemOf(def));
    if (gen !== this.renderGen) return;
    // No section-sub line — the cards themselves say what syncs.
    if (withSyncAll && defs.length > 0) this.renderSyncAllRow(containerEl, defs);
    // Cards render in def order — buildItemDefs already alphabetizes each section (spec §4).
    // No sensitive-first reordering: it breaks the dictionary order users scan by.
    const listEl = containerEl.createDiv();
    for (const def of defs) {
      const wrap = listEl.createDiv({ cls: "config-sync-item-wrap" });
      this.cardHosts.push({ wrap, def });
      this.renderItemCard(wrap, def);
    }
  }

  private renderSyncAllRow(containerEl: HTMLElement, defs: ItemDef[]): void {
    const host = containerEl.createDiv();
    const build = (): void => {
      host.empty();
      const head = new Setting(host).setName(SYNC_ALL_LABEL).setDesc(SYNC_ALL_HINT).setHeading();
      head.addToggle((t) =>
        t.setValue(sectionAllEnabled(defs, this.host.settings.items)).onChange(async (v) => {
          if (!this.host.settingsWritable()) return; // §4.2b
          this.host.settings.items = applySyncAll(defs, this.host.settings.items, v);
          await this.host.saveSettings();
          for (const { wrap, def } of this.cardHosts) this.renderItemCard(wrap, def);
        })
      );
    };
    build();
    this.syncAllRebuilds.push(build);
  }

  private renderItemCard(wrap: HTMLElement, def: ItemDef): void {
    wrap.empty();
    const item = this.itemOf(def);
    const expKey = cardExpandKey(defRef(def));
    const row = new Setting(wrap).setName(def.label).setDesc(def.description);
    row.settingEl.setAttribute("data-search-anchor", itemAnchorId(defRef(def)));
    // Unified onto the shared FOLD helper — one rotating `chevron-right` instead of
    // swapping between `chevron-down`/`chevron-right`. `.setName` above already put the label
    // text into `row.nameEl`, so the chevron still needs an explicit `.prepend` to land before it
    // (renderFoldChevron only appends).
    const chevron = renderFoldChevron(row.nameEl, this.expanded.has(expKey), null);
    row.nameEl.prepend(chevron);
    const syncExpansion = (): void => {
      const open = this.expanded.has(expKey);
      setFoldOpen(chevron, open);
      const existing = row.settingEl.querySelector(":scope > .config-sync-item-exp");
      if (open && existing === null) this.renderCardExpansion(row.settingEl, wrap, def);
      else if (!open && existing !== null) existing.remove();
    };
    chevron.addEventListener("click", () => {
      if (this.expanded.has(expKey)) this.expanded.delete(expKey);
      else this.expanded.add(expKey);
      syncExpansion();
    });
    // Badges live on the control side, just before the sync toggle — icon + corner
    // count, tooltip carrying the sentence — not text tags trailing the name.
    for (const badge of computeBadges(def, item, this.enablementOf(def), this.carrierCountsOf(def))) this.renderBadge(row.controlEl, badge);
    row.addToggle((t) =>
      t.setValue(item.synced).onChange(async (v) => {
        if (this.snappingBackToggle) return;
        await this.cardSyncedToggled(def, wrap, v, () => {
          // Obsidian's ToggleComponent.setValue fires this same onChange when the value really
          // changes, so the snap-back is fenced off from the handler it would otherwise re-enter.
          this.snappingBackToggle = true;
          t.setValue(true);
          this.snappingBackToggle = false;
        });
      })
    );
    syncExpansion();
  }

  // What the card head's toggle DOES — a method rather than a closure so the routing below is
  // reachable from a test without a live ToggleComponent (the snap-back is the only part that needs
  // one, and it comes in as a callback).
  //
  // Turning an item OFF removes it from every device's contract and can delete its store copy — the
  // one destructive gesture on this card, and its only home (spec §6.2). The confirmation is
  // StopSyncingModal. The two carrier cards go through it like any
  // other: a carrier is an item, it has a store copy, and "one home for the gesture" does not mean
  // "one home for the items we thought of first".
  //
  // EXCEPT config-sync's own card. The registry builds a def for every installed plugin, itself
  // included (registry.ts's buildItemDefs; main.ts's adopt path says so in as many words), so the
  // Community tab carries a Config Sync card with this same toggle — and the modal's delete-store
  // checkbox defaults to CHECKED, which on this one item would delete the self copy that carries
  // the sync contract to every other device. The gesture excludes the self item by design
  // ("not the self item"); §6.2 places the gesture's home, not its scope. So this card keeps
  // the plain write: `synced` flips, nothing is deleted, and it is reversible in place.
  //
  // Turning any item back ON is the plain path too — restoring sync destroys nothing.
  private async cardSyncedToggled(def: ItemDef, wrap: HTMLElement, v: boolean, snapBack: () => void): Promise<void> {
    if (!v && def.groupName !== SELF_GROUP_NAME) {
      snapBack(); // the modal owns the outcome — the toggle follows it, not the click
      void this.openStopSyncing(def, wrap);
      return;
    }
    await this.updateItem(def, (c) => ({ ...c, synced: v }));
    this.refreshCardBadges(wrap, def);
    for (const rebuild of this.syncAllRebuilds) rebuild();
  }

  // The card's destructive action (spec §6.2).
  private async openStopSyncing(def: ItemDef, wrap: HTMLElement): Promise<void> {
    // §4.2b: refuse before the modal opens, not after the user has decided in it. `stopSyncing`
    // still refuses on its own — this is the courtesy, that is the guarantee.
    if (!this.host.settingsWritable()) return;
    const label = this.host.displayName(def.groupName, def.label);
    const count = await this.host.storeFileCount(def.groupName);
    new StopSyncingModal(this.app, label, count, async (deleteStore) => {
      const deleted = await this.host.stopSyncing(def.groupName, deleteStore);
      if (deleted === null) return; // refused (§4.2b) — the item is still synced, so nothing is recorded
      await this.host.appendActionHistory({
        kind: "stop-sync",
        desc: stopSyncDesc(label, deleted.length),
        changed: 1,
        removed: [label],
        deletedFiles: deleted.length > 0 ? deleted : undefined,
      });
      this.renderItemCard(wrap, def); // the toggle now reads the item stopSyncing actually wrote
      for (const rebuild of this.syncAllRebuilds) rebuild();
    }).open();
  }

  // In-place header badge refresh — value-only config changes (sharing, encrypt, enablement)
  // update the count badges without rebuilding the card, so the panel never visibly jumps.
  private refreshCardBadges(wrap: HTMLElement, def: ItemDef): void {
    const controlEl = wrap.querySelector(":scope > .setting-item > .setting-item-control");
    if (!(controlEl instanceof HTMLElement)) return;
    for (const b of Array.from(controlEl.querySelectorAll(".config-sync-card-badge"))) b.remove();
    // Fresh badges must land BEFORE the toggle again — prepend in reverse keeps computeBadges'
    // fixed order while the toggle stays the control cell's last child.
    const badges = computeBadges(def, this.itemOf(def), this.enablementOf(def), this.carrierCountsOf(def));
    for (const badge of badges.reverse()) {
      const el = this.renderBadge(controlEl, badge);
      controlEl.prepend(el);
    }
  }

  // Icon-only, a 9px corner count when the badge carries one, tooltip = the sentence;
  // a badge missing its icon keeps the text as the loud fallback.
  private renderBadge(host: HTMLElement, badge: Badge): HTMLElement {
    const el = host.createSpan({ cls: `config-sync-card-badge ${badge.cls}` });
    if (badge.icon !== undefined) {
      setIcon(el.createSpan({ cls: "config-sync-card-badge-ic" }), badge.icon);
      // A corner count of 1 says nothing the icon doesn't — digits appear from 2
      // up; the tooltip always carries the exact sentence ("1 device-scoped").
      if (badge.count !== undefined && badge.count > 1) el.createSpan({ cls: "config-sync-card-badge-cnt", text: String(badge.count) });
    } else {
      el.appendText(badge.text);
    }
    setTooltip(el, badge.tooltip ?? badge.text);
    return el;
  }

  // In-place Settings-file body refresh: rebuild rule rows + (when expanded) File preview into a
  // detached node and swap it in only once any needed file read resolves — the drawer keeps its
  // height while the read is in flight (no collapse/re-expand jitter of a full renderItemCard).
  // The path row (scope/lock dim state) lives outside this host — a write that flips hasKeyRules
  // pairs this call with refreshPathRow below instead of a full card re-render.
  private refreshCardBody(wrap: HTMLElement, def: ItemDef): void {
    const host = wrap.querySelector(".config-sync-card-sfbodyhost");
    if (!(host instanceof HTMLElement)) return;
    this.renderCardBodyInto(host, def, this.itemOf(def), wrap);
  }

  // In-place path-row refresh for hasKeyRules flips: the row sits outside
  // refreshCardBody's swap target, and a full renderItemCard would collapse
  // the card around its async file read — the panel would visibly jump and the File preview
  // would lose its scroll position. The error element is the row's own next sibling (renderSettingsFileZone
  // creates them adjacently), so both anchors are stable across body swaps.
  private refreshPathRow(wrap: HTMLElement, def: ItemDef): void {
    const row = wrap.querySelector(".config-sync-card-sfhead");
    const errorEl = row?.nextElementSibling;
    if (!(row instanceof HTMLElement) || !(errorEl instanceof HTMLElement)) return;
    row.empty();
    this.renderSettingsFilePathRow(row, errorEl, def, this.itemOf(def), wrap);
  }

  private renderCardExpansion(parent: HTMLElement, wrap: HTMLElement, def: ItemDef): void {
    const exp = parent.createDiv({ cls: "config-sync-item-exp" });
    const item = this.itemOf(def);
    if (hasEnablementZone(def)) this.renderDefaultEnabledOnRow(exp, def, wrap);
    this.renderSettingsFileZone(exp, def, item, wrap);
    const carrier = carrierListFor(def);
    if (carrier !== null) this.renderCarrierElements(exp, def, carrier, wrap);
    // companionHost is its own stable container (mirrors zone ②'s bodyHost): a companion
    // add/remove or path edit still rebuilds the whole card (renderItemCard), landing here fresh.
    // A member-list expand/collapse touches neither this host nor the card at all —
    // the fold toggle wired inside renderCompanionZone flips the member host's
    // own `hidden` + its chevron in place.
    const companionHost = exp.createDiv({ cls: "config-sync-card-companionzonehost" });
    this.renderCompanionZone(companionHost, def, item, wrap);
  }

  // The fleet write, plus §6.5 case 3's landing seed. Same body as the Sync Center's rule menu
  // (SyncCenterView.setRuleWithLanding), asking the same producer (ruleLandingNeedsSeed), so landing
  // on `Not shared` behaves identically whichever entrance the user came through.
  private async setRuleWithLanding(list: RuleListId, elementId: string, rule: Sharing): Promise<void> {
    await this.host.setEnablementRule(list, elementId, rule);
    if (ruleLandingNeedsSeed(rule, this.host.deviceElementFor(list, elementId))) await this.host.leaveToThisDevice(list, elementId);
  }

  // Wires a picker trigger's click/keydown → opens an Obsidian `Menu` at the click/keyboard
  // position, and tracks `.is-open` on the trigger while the menu is showing (⇕
  // hover-reveal — DESIGN.md §2.3), cleared via `Menu.onHide`. Shared by every sharing/rule
  // picker in this file (renderSharingPicker below) and the local-segment menu, so the
  // open/close bookkeeping lives in exactly one place — the same shape SyncCenterView's own
  // `wireMenuTrigger` uses, so a menu opens and reveals its chevron the same way everywhere.
  private wireMenuTrigger(trigger: HTMLElement, buildMenu: () => Menu): void {
    trigger.setAttribute("role", "button");
    trigger.setAttribute("tabindex", "0");
    const open = (x: number, y: number): void => {
      const menu = buildMenu();
      trigger.addClass("is-open");
      menu.onHide(() => trigger.removeClass("is-open"));
      menu.showAtPosition({ x, y });
    };
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      open(e.clientX, e.clientY);
    });
    trigger.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      const r = trigger.getBoundingClientRect();
      open(r.left, r.bottom);
    });
  }

  // The scrow controls cluster (DESIGN §1.4 SLOTS): aux (the path row's eye / an array
  // rule row's per-item icon) | lock | device picker — same-type controls land in the same slot on
  // every row, so each forms a strict column card-wide.
  //
  // Each slot carries its ROLE as a class, and the role decides both its order and its width in CSS
  // rather than here: a slot left unfilled is removed from the flow by `:empty`, so it no longer
  // holds a column-gap open beside controls that are actually there. Building all three
  // unconditionally is what makes that work — a slot filled later by a rebuilt row starts matching
  // `:empty` or stops matching it on its own, with no bookkeeping on this side.
  private scrowSlots(row: HTMLElement): { aux: HTMLElement; lock: HTMLElement; device: HTMLElement } {
    const slots = row.createDiv({ cls: "config-sync-scrow-slots" });
    return {
      aux: slots.createDiv({ cls: "config-sync-scrow-slot is-aux" }),
      lock: slots.createDiv({ cls: "config-sync-scrow-slot is-lock" }),
      device: slots.createDiv({ cls: "config-sync-scrow-slot is-device" }),
    };
  }

  // The sharing/rule picker trigger.
  // Icon + a small muted `chevrons-up-down` PICKER affordance opens an
  // Obsidian `Menu` listing `options`, checkmarked on the current value — the same idiom the
  // merged control below and the Sync Center's own pickers already use. `iconFor`/`labelFor`
  // choose the vocabulary: the enablement rows (plugin card `Enabled on`, carrier element rows)
  // pass `ruleIcon`/`ruleLabel` (enablementRow.ts — the SAME producer the Sync Center's own
  // `ruleMenu` reads, so both entrances offer identical wording); the plain field/file/companion
  // rows fall back to `sharingIcon`/`sharingLabel` (itemCard.ts).
  // `disabled` keeps the dim, non-interactive rendering — no menu,
  // but the ⇕ span still renders: without it the box is 14px narrower and the
  // centered device slot drifts the icon out of the column; CSS keeps a dim picker's ⇕ at
  // opacity 0 even on row hover (the settings-file row's per-key-rules-active state).
  // `extras`: a removable row's destructive verb lives HERE, after a separator, as
  // a warning-red trash item. Only the rows that ARE
  // removable pass one (a key-rule row's `Remove rule`, a user-added folder's `Remove folder`).
  private renderSharingPicker(
    cell: HTMLElement,
    opts: {
      sharing: Sharing;
      options: readonly Sharing[];
      disabled: boolean;
      note?: string;
      iconFor?: (s: Sharing) => string;
      labelFor?: (s: Sharing) => string;
      ariaLabel?: string;
      onChange: (v: Sharing) => void;
      extras?: Array<{ title: string; icon: string; action: () => void }>;
    }
  ): void {
    const iconOf = opts.iconFor ?? sharingIcon;
    const labelOf = opts.labelFor ?? sharingLabel;
    const icon = cell.createSpan({ cls: `config-sync-sharingicon${opts.sharing.kind !== "everywhere" ? " is-set" : ""}` });
    setIcon(icon, iconOf(opts.sharing));
    icon.setAttribute("aria-label", opts.ariaLabel ?? sharingCycleTooltip(opts.sharing, opts.note));
    setIcon(icon.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
    if (opts.disabled) {
      icon.addClass("config-sync-dim");
      return;
    }
    this.wireMenuTrigger(icon, () => {
      const menu = new Menu();
      for (const o of opts.options) {
        menu.addItem((item) =>
          item
            .setTitle(labelOf(o))
            .setIcon(iconOf(o))
            .setChecked(sharingEquals(o, opts.sharing))
            .onClick(() => opts.onChange(o))
        );
      }
      const extras = opts.extras ?? [];
      if (extras.length > 0) menu.addSeparator();
      for (const extra of extras) {
        menu.addItem((item) => item.setTitle(extra.title).setIcon(extra.icon).setWarning(true).onClick(extra.action));
      }
      return menu;
    });
  }

  // The control's SHAPE lives in mergedControl.ts, so the Sync Center paints the identical thing
  // rather than a second spelling of it; only the menu-trigger wiring stays here, where this view
  // already keeps it.
  private paintMergedControl(
    cell: HTMLElement,
    opts: { shared: RowSegment; local: RowSegment | null; localIsException: boolean; sections: () => readonly MenuSectionModel[] }
  ): void {
    paintMergedControl(cell, { ...opts, wire: (trigger, menu) => this.wireMenuTrigger(trigger, menu) });
  }

  // The merged control for an ELEMENT row — the plugin card's own `Enabled on` and a carrier card's
  // member rows, which ask the same question about the same datum and so must offer the same thing.
  //
  // Note the asymmetry with a per-key rule row, which drops its local section entirely under
  // `Not shared`: for a KEY that answer means "the value just stays where it is", so there is
  // nothing left for this device to decide. For an ELEMENT it means the opposite — the on/off state
  // has to come from SOMEWHERE, and with no shared answer this device's own is the only one there
  // is. So the section stays, minus its `follow` entry (buildLocalMenu drops it: there is no shared
  // answer to follow).
  private paintElementControl(
    cell: HTMLElement,
    opts: {
      list: RuleListId;
      elementId: string;
      rule: Sharing;
      exception: DeviceElementState | null;
      hasLocalLayer: boolean;
      desktopOnly: boolean;
      onRuleChange: (v: Sharing) => void;
      after: () => void;
    }
  ): void {
    const model = enablementRowModel({ rule: opts.rule, exception: opts.exception });
    // A desktop-only plugin still drops the mobile stop: mobile can never install it.
    const options = opts.desktopOnly ? RULE_OPTIONS.filter((o) => o.kind !== "per-class" || o.class !== "mobile") : RULE_OPTIONS;
    const note = opts.desktopOnly && opts.rule.kind === "everywhere" ? ` (${DESKTOP_ONLY_ALL_NOTE})` : "";
    this.paintMergedControl(cell, {
      shared: { icon: model.fleet.icon, tooltip: `${enabledOnTooltip(opts.rule)}${note}` },
      local: opts.hasLocalLayer ? model.local : null,
      localIsException: opts.hasLocalLayer && model.localIsException,
      sections: () => {
        const shared = sharingMenuSection({
          header: ENABLED_ON_HEADER,
          options,
          current: opts.rule,
          iconFor: ruleIcon,
          labelFor: ruleLabel,
          onChange: opts.onRuleChange,
        });
        if (!opts.hasLocalLayer) return [shared];
        return [
          shared,
          {
            header: ON_THIS_DEVICE_HEADER,
            items: buildLocalMenu(opts.rule, opts.exception, {
              follow: () => void this.host.followTheDefault(opts.list, opts.elementId).then(opts.after),
              setState: (state) => void this.host.setDeviceElement(opts.list, opts.elementId, state).then(opts.after),
            }),
          },
        ];
      },
    });
  }

  // Zone ① `Enabled on` — core/community/beta plugin cards only. Same name, same values, same data
  // as the Sync Center's row of that name: ONE control carrying both layers, each layer with its
  // own writer.
  // A scrow: label on the identity track, the merged control in the device slot of the controls
  // column — the same placement the Sync Center card's own `Enabled on` row uses.
  private renderDefaultEnabledOnRow(exp: HTMLElement, def: ItemDef, wrap: HTMLElement): void {
    const enablement = def.enablement;
    if (enablement === undefined) return;
    const list = enablement.list;
    const elementId = enablement.element;
    const row = exp.createDiv({ cls: "config-sync-scrow" });
    const build = (): void => {
      row.empty();
      row.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: ENABLED_ON_LABEL });
      const slots = this.scrowSlots(row);
      const rule = this.host.enablementRuleFor(list, elementId);
      const exception = this.host.deviceElementFor(list, elementId);
      const after = (): void => {
        build();
        this.refreshCardBadges(wrap, def);
      };
      this.paintElementControl(slots.device, {
        list,
        elementId,
        rule,
        exception,
        hasLocalLayer: true,
        desktopOnly: def.desktopOnly === true,
        onRuleChange: (v) => void this.setRuleWithLanding(list, elementId, v).then(after),
        after,
      });
    };
    build();
  }

  // ONE element-rule row (spec §6.4): a snippet under Appearance and a plugin under Core/Community
  // plugins are the same thing — an element of an on/off list with a rule and a local exception —
  // so they are the same row. Appearance's snippet rows are the older half of this; this is what
  // makes the two new carrier cards reuse them instead of growing a second dialect.
  //
  // The LOCAL layer renders only for a list whose exceptions a run actually applies
  // (registry.ts's isEnablementList — main.ts's enablementDecisions walks exactly those two lists,
  // and perElement.ts reads rules alone). `enabled-css-snippets` has no such application path, so a
  // snippet row would be offering a choice nothing would ever honour: its control keeps the shared
  // glyph alone, and its menu the shared section alone. The host methods stay
  // `RuleListId`-wide — the asymmetry is in what this row OFFERS, not in what the layer can store.
  //
  // Returns the row's CONTENT cell, so a caller with an affordance of its own (the snippets
  // caller's `file deleted` pill and its Forget button) can put it inside — the grid is a fixed
  // four-track shape, and anything appended to the row itself would claim a track.
  private renderElementRuleRow(
    host: HTMLElement,
    opts: { def: ItemDef; wrap: HTMLElement; list: RuleListId; elementId: string; label: string; desktopOnly: boolean; orphan: boolean; onWritten: () => void }
  ): HTMLElement {
    const hasLocalLayer = isEnablementList(opts.list);
    const row = host.createDiv({ cls: `config-sync-scrow config-sync-card-companiongrid${opts.orphan ? " is-orphan" : ""}` });
    // The pill and the Forget button must live INSIDE the identity cell, or every later cell
    // shifts one column over and the button wraps onto an implicit second grid row. The identity
    // cell (and anything a caller appended into it) survives rebuilds: `build` empties the device
    // slot and nothing else, since the merged control is the row's only rebuilt part.
    const contentCell = opts.orphan ? row.createDiv({ cls: "config-sync-orphancell" }) : row;
    contentCell.createSpan({ cls: "config-sync-ldname", text: opts.label });
    const slots = this.scrowSlots(row);
    const ctl = slots.device;
    const build = (): void => {
      ctl.empty();
      const rule = this.host.enablementRuleFor(opts.list, opts.elementId);
      const exception = hasLocalLayer ? this.host.deviceElementFor(opts.list, opts.elementId) : null;
      const after = (): void => {
        build();
        opts.onWritten();
      };
      // The SAME control the plugin card's own `Enabled on` paints, because it is the same question
      // about the same datum. A snippet member has no local layer, so its control is one glyph and
      // its menu one section.
      this.paintElementControl(ctl, {
        list: opts.list,
        elementId: opts.elementId,
        rule,
        exception,
        hasLocalLayer,
        desktopOnly: opts.desktopOnly,
        onRuleChange: (v) => void this.writeElementRule(opts.def, opts.wrap, opts.list, opts.elementId, v).then(after),
        after,
      });
    };
    build();
    return contentCell;
  }

  // The fleet write from an element row, plus the two card-level consequences every write into this
  // item's `perElement` map has. The first rule on a card (or the last one cleared) flips
  // hasKeyRules, which (un)dims the path row's own sharing/lock controls (spec §3.1) — refreshed in
  // place, because a full card re-render makes the panel visibly jump.
  // The File preview colors its elements from the same map.
  //
  // The rule home for the row's list IS the card the row is drawn in — snippets belong to
  // Appearance, a carrier's elements to the carrier (enablementRules.ts's ruleHomeFor) — which is
  // what lets one method serve both callers.
  private async writeElementRule(def: ItemDef, wrap: HTMLElement, list: RuleListId, elementId: string, rule: Sharing): Promise<void> {
    const hadKeyRules = hasKeyRules(this.itemOf(def));
    // The landing seed (§6.5 case 3) exists to keep the LOCAL segment truthful, so it applies to
    // exactly the lists that have one.
    if (isEnablementList(list)) await this.setRuleWithLanding(list, elementId, rule);
    else await this.host.setEnablementRule(list, elementId, rule);
    if (hasKeyRules(this.itemOf(def)) !== hadKeyRules) this.refreshPathRow(wrap, def);
    this.refreshCardBody(wrap, def);
  }

  // The two carrier cards' element drawer (spec §6.4): the list this card carries, one row per
  // element, under one section title. No search box — spec §10 leaves that open, and Community's 73
  // rows are a grouping decision this card is not the place to take unasked.
  private renderCarrierElements(exp: HTMLElement, def: ItemDef, list: RuleListId, wrap: HTMLElement): void {
    // Zone-header scrow: `Enabled on` — zone ①'s own word, because this list IS that datum per
    // element — with the full sentence in the tooltip. No `this device` column header: there is no
    // local COLUMN any more, both layers live inside each row's one control, and the words that
    // tell them apart are that control's two menu section headers.
    const head = exp.createDiv({ cls: "config-sync-scrow" });
    const headLabel = head.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: ENABLED_ON_LABEL });
    setTooltip(headLabel, CARRIER_ELEMENTS_LABEL);
    const listEl = exp.createDiv({ cls: "config-sync-card-carrierelements" });
    const rows = buildCarrierElementRows(this.host.itemDefs(), list, ruledElementIds(this.host.settings.items, list), this.host.deviceElementIds(list));
    for (const row of rows) {
      this.renderElementRuleRow(listEl, {
        def,
        wrap,
        list,
        elementId: row.elementId,
        label: row.label,
        desktopOnly: row.desktopOnly,
        orphan: false,
        onWritten: () => this.refreshCardBadges(wrap, def),
      });
    }
  }

  private renderSettingsFileZone(exp: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const kind = settingsFileZoneKind(def);
    // The zone label is the path ROW's own identity cell — a standalone
    // label line remains only for the kinds that have no path row to carry it.
    if (kind === "none") {
      exp.createDiv({ cls: "config-sync-explabel", text: "Settings sync" });
      return;
    }
    if (kind === "state-only") {
      exp.createDiv({ cls: "config-sync-explabel", text: "Settings sync" });
      const expectedFile = def.section === "core" ? corePluginFile(def.id) : "its settings file";
      exp.createDiv({ cls: "config-sync-expdesc", text: stateOnlyHint(def.label, expectedFile) });
      return;
    }
    // A CONTAINER — renderSettingsFilePathRow builds its two scrow lines inside
    // (refreshPathRow's row/errorEl adjacency contract is unchanged).
    const pathRow = exp.createDiv({ cls: "config-sync-card-sfhead" });
    const pathErrorEl = exp.createDiv({ cls: "config-sync-save-error mod-warning" });
    pathErrorEl.hide();
    this.renderSettingsFilePathRow(pathRow, pathErrorEl, def, item, wrap);
    // bodyHost is created synchronously so a swapped-in body always lands HERE — inside zone ②,
    // before the Companion-folders zone — and so refreshCardBody has a stable container to target.
    const bodyHost = exp.createDiv({ cls: "config-sync-card-sfbodyhost" });
    this.renderCardBodyInto(bodyHost, def, item, wrap);
  }

  private customPathEditingKey(def: ItemDef): string {
    return `custompath:${defRef(def)}`;
  }

  // Zone ② path row = a scrow whose identity cell IS the zone header: the
  // uppercase `SETTINGS SYNC` label stacked over the mono filename, the eye riding that same
  // filename line; the controls cluster holds scope + lock. Locked (dim, disabled) whenever the
  // card has any per-key rule — per-key state owns scope/encrypt then, not the whole-file row
  // (spec §3.1).
  private renderSettingsFilePathRow(row: HTMLElement, errorEl: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const defaultPath = def.settingsFile!.defaultPath!;
    const current = item.path ?? defaultPath;
    const committed = item.path !== undefined;
    const key = this.customPathEditingKey(def);
    // The path text itself is the edit entry point —
    // a committed custom path shows as accented text like any other, and
    // "Reset to default" becomes a text action inside the edit state.
    const editing = this.customPathEditing.has(key);
    const locked = hasKeyRules(item);

    // Two lines, structurally identical to the `Enabled on` row above (label + scrow slots):
    // line 1 = the zone label + the slots cluster strictly on the label's own line — aux stays
    // empty here, this row has no per-item icon; line 2 = the filename, unlabeled — the mono
    // text is its own identity — spanning the full card width, so plugin-length paths never
    // wrap, with the eye riding that same line (below).
    const line1 = row.createDiv({ cls: "config-sync-scrow" });
    line1.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: "Settings sync" });
    const slots = this.scrowSlots(line1);

    // "Does THIS device sync the file at all" — true in BOTH modes, so it is built once here and
    // handed to whichever branch below paints the control. buildOptOutLocalMenu is the SAME
    // producer the Sync Center's own row asks: two entrances, one entry list, so they cannot
    // offer different choices.
    const optedOut = this.host.deviceOptedOut(def.groupName);
    const localSection = (): MenuSectionModel => ({
      header: ON_THIS_DEVICE_HEADER,
      items: buildOptOutLocalMenu(optedOut, {
        follow: () => void this.host.setDeviceOptOut(def.groupName, false).then(() => this.renderItemCard(wrap, def)),
        optOut: () => void this.host.setDeviceOptOut(def.groupName, true).then(() => this.renderItemCard(wrap, def)),
      }),
    });

    const line2 = row.createDiv({ cls: "config-sync-scrow" });
    const pathHost = line2.createDiv({ cls: "config-sync-card-pathhost config-sync-card-pathline" });
    if (editing) {
      const input = new TextComponent(pathHost);
      input.setValue(current);
      input.inputEl.addClass("config-sync-card-pathinput");
      const commit = (): void => void this.commitSettingsFilePath(def, wrap, errorEl, input.getValue());
      input.inputEl.addEventListener("blur", commit);
      input.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.inputEl.blur(); // triggers the blur handler above
        }
      });
      // Escape must cancel THIS edit, not close the settings window — Obsidian's keymap sees the
      // key at window capture before any element listener (stopPropagation is too late), so the
      // cancel is registered as a keymap Scope pushed above the modal's own while the input has
      // focus. popScope is idempotent, so the double pop on Escape (input detaches without a
      // blur event in Chromium) is harmless.
      const escScope = new Scope();
      escScope.register([], "Escape", () => {
        this.customPathEditing.delete(key);
        this.app.keymap.popScope(escScope);
        this.renderItemCard(wrap, def);
        return false;
      });
      input.inputEl.addEventListener("focus", () => this.app.keymap.pushScope(escScope));
      input.inputEl.addEventListener("blur", () => this.app.keymap.popScope(escScope));
      if (committed) {
        const reset = pathHost.createSpan({ cls: "config-sync-reset-link", text: "Reset to default" });
        reset.setAttribute("role", "button");
        reset.setAttribute("tabindex", "0");
        // mousedown + preventDefault, NOT click: a click would first blur the input, whose
        // blur-commit tears this button out of the DOM before the click ever lands.
        reset.addEventListener("mousedown", (e) => {
          e.preventDefault();
          void this.commitSettingsFilePath(def, wrap, errorEl, defaultPath);
        });
        reset.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void this.commitSettingsFilePath(def, wrap, errorEl, defaultPath);
          }
        });
      }
      window.setTimeout(() => input.inputEl.focus(), 0);
    } else {
      const pathEl = pathHost.createEl("code", { cls: `config-sync-card-path config-sync-card-pathbtn${committed ? " is-custom" : ""}`, text: splitLocation(current).rel });
      pathEl.setAttribute("role", "button");
      pathEl.setAttribute("tabindex", "0");
      pathEl.setAttribute("aria-label", CUSTOM_PATH_LABEL);
      const startEdit = (): void => {
        this.customPathEditing.add(key);
        this.renderItemCard(wrap, def);
      };
      pathEl.addEventListener("click", startEdit);
      pathEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startEdit();
        }
      });
    }

    // The File preview trigger rides the filename line — the eye is an action on this file, so
    // it joins the file's own identity, not the rule row's controls cluster — pushed to the
    // line's right end by `.config-sync-card-pathline .config-sync-card-previewicon`'s
    // margin-left: auto (styles.css). Appended here, after BOTH branches above, so it renders in
    // the edit state too and never disappears mid-edit. Same open-state language as the FILES
    // row's `file-diff` icon.
    const previewOpen = this.previewOpen.has(def.id);
    const previewIcon = pathHost.createSpan({
      cls: `config-sync-card-previewicon${previewOpen ? " is-open" : ""}`,
      attr: { role: "button", tabindex: "0", "aria-label": FILE_PREVIEW_LABEL },
    });
    setIcon(previewIcon, "eye");
    const togglePreview = (): void => {
      if (this.previewOpen.has(def.id)) this.previewOpen.delete(def.id);
      else this.previewOpen.add(def.id);
      this.refreshCardBody(wrap, def);
      this.refreshPathRow(wrap, def);
    };
    previewIcon.addEventListener("click", togglePreview);
    previewIcon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePreview();
      }
    });

    const sharingCell = slots.device;
    const lockCell = slots.lock;
    if (locked) {
      // Fields mode: compileSingleFile (registry.ts) only reads settingsFile.fileRule in its
      // "plain" branch, so once the group has any per-key rule the whole-file rule compiles to
      // nothing — and pruneSettingsFile only drops a fileRule that is exactly {everywhere,
      // false}, so a `Desktop only` set (or an `encrypted: true`) from before the first per-key
      // rule can survive in data.json with nothing left enforcing it (spec §3.2). Reading it here
      // would draw a scope or lock that states a value that stopped being true the moment the
      // first per-key rule was added, so this branch never touches item.settingsFile?.fileRule at
      // all — neither cell — and never mutates it either: per-key rules are the only truth here,
      // and the row says so instead of drawing a stale one.
      // lockCell stays empty — there is no fileRule.encrypted left to speak for.
      // One control here too, even though its two halves do different KINDS of thing: the shared
      // half has no value to pick (per-key rules decide), so it contributes a single menu entry
      // that JUMPS instead of a list of stops. That costs the jump one extra click and buys the
      // row the same shape as every other — and the jump stops being an unlabelled icon whose
      // only explanation was a tooltip a phone never shows.
      // `braces`, not `settings-2`: this glyph says "the keys inside this file decide". `settings-2`
      // means "opens Settings" and nothing else — the `More` row on the same card uses it, and two
      // rows one above the other drawing the same mark for different facts is what sent the reader
      // looking for a difference that was not there.
      this.paintMergedControl(sharingCell, {
        shared: { icon: "braces", tooltip: PER_KEY_RULES_TOOLTIP },
        local: optOutLocalSegment(optedOut),
        localIsException: optedOut,
        sections: () => [
          {
            header: SHARED_WITH_HEADER,
            items: [
              { title: PER_KEY_RULES_STATE_TEXT, icon: "braces", checked: false, isLabel: true, action: () => {} },
              // No `settings-2` on this side: Settings is already open, so nothing opens — the jump
              // scrolls within this very card.
              { title: PER_KEY_RULES_ACTION_TEXT, icon: null, checked: false, action: () => this.jumpToKeyRules(wrap, def, item) },
            ],
          },
          localSection(),
        ],
      });
      return;
    }

    const rule = item.settingsFile?.fileRule ?? { sharing: EVERYWHERE, encrypted: false };
    // The mutator MUST read the rule fresh inside updateItem (not the render-time `rule` above),
    // and the row MUST rebuild itself after the write: this row lives outside refreshCardBody's
    // swap target, so without the rebuild the lock/scope controls keep replaying their stale
    // render-time value — a lock click after the first one re-sends the same boolean forever
    // (otherwise encrypted could never be turned off).
    const setFileRule = (mutator: (r: { sharing: FileSharing; encrypted: boolean }) => { sharing: FileSharing; encrypted: boolean }): void => {
      void (async () => {
        await this.updateItem(def, (c) => {
          const sf = c.settingsFile ?? defaultSettingsFile();
          return { ...c, settingsFile: withDerivedMode({ ...sf, fileRule: mutator(sf.fileRule ?? { sharing: EVERYWHERE, encrypted: false }) }) };
        });
        this.refreshCardBadges(wrap, def);
        this.refreshCardBody(wrap, def);
        row.empty();
        this.renderSettingsFilePathRow(row, errorEl, def, this.itemOf(def), wrap);
      })();
    };
    // setFileRule re-renders this whole row after every write, so the icon always reflects the
    // freshly-saved sharing without any extra bookkeeping here.
    // Three stops, not four: `FileSharing` excludes this-device by construction — a whole file that
    // every device keeps its own copy of is simply a file nobody syncs, which is the card's own
    // toggle, not a sharing rule.
    this.paintMergedControl(sharingCell, {
      shared: { icon: sharingIcon(rule.sharing), tooltip: settingsSyncTooltip(rule.sharing) },
      local: optOutLocalSegment(optedOut),
      localIsException: optedOut,
      sections: () => [
        sharingMenuSection({
          header: SHARED_WITH_HEADER,
          options: FILE_SHARING_OPTIONS,
          current: rule.sharing,
          iconFor: sharingIcon,
          labelFor: sharingLabel,
          onChange: (v) => setFileRule((r) => ({ ...r, sharing: v as FileSharing })),
        }),
        localSection(),
      ],
    });
    // The lock stays its OWN control: it is a toggle, not a menu, and folding a one-click flip into
    // a control whose whole job is "open a menu" would cost it that click for nothing.
    this.renderLockToggle(lockCell, { encrypted: rule.encrypted, disabled: false, onChange: (v) => setFileRule((r) => ({ ...r, encrypted: v })) });
  }

  // Shared commit path for every settings-file path change (typed edit, or the ↺ revert-to-default
  // above): validate -> no-op guard -> companionConflict -> warning modal -> durable write. A
  // validation/conflict rejection shows an inline error and returns WITHOUT touching the DOM
  // further (so the user's in-progress typed text survives to be corrected) — a confirmed change
  // or a Cancel both end in a full card re-render (Cancel's re-render is exactly how "revert the
  // control to its prior value" is satisfied — cfg is untouched, so the rebuilt input/toggle reads
  // the same committed state as before).
  private async commitSettingsFilePath(def: ItemDef, wrap: HTMLElement, errorEl: HTMLElement, raw: string): Promise<void> {
    const item = this.itemOf(def);
    const defaultPath = def.settingsFile!.defaultPath!;
    const current = item.path ?? defaultPath;
    const validation = validateCompanionPath(raw);
    if (!validation.ok) {
      errorEl.setText(validation.error);
      errorEl.show();
      return;
    }
    const editKey = this.customPathEditingKey(def);
    if (validation.path === normalizeCompanionPath(current)) {
      errorEl.setText("");
      errorEl.hide();
      // Nothing actually changed — no modal, no write; leave edit mode back to the text view
      // (click-to-edit means blurring an untouched input should just close it).
      this.customPathEditing.delete(editKey);
      this.renderItemCard(wrap, def);
      return;
    }
    const conflict = companionConflict(validation.path, this.host.itemDefs(), this.host.settings);
    if (conflict !== null) {
      errorEl.setText(companionConflictError(conflict));
      errorEl.show();
      return;
    }
    // §4.2b: refuse before the warning modal opens — `updateItem` below would refuse anyway, but
    // only after the user had weighed a preset change they were never going to be allowed to make.
    if (!this.host.settingsWritable()) {
      this.customPathEditing.delete(editKey);
      this.renderItemCard(wrap, def); // same restore path Cancel takes: the edit did not happen
      return;
    }
    // Every registry item's settingsFile carries a preset default path, so
    // ANY committed change here — first customization or a further edit — goes through the same
    // preset-change guard (D7).
    const confirmed = await confirmPresetPathChange(this.app, def.label);
    if (!confirmed) {
      this.customPathEditing.delete(editKey);
      this.renderItemCard(wrap, def); // Cancel: revert to the committed text view
      return;
    }
    errorEl.setText("");
    errorEl.hide();
    const nextPath = validation.path === normalizeCompanionPath(defaultPath) ? undefined : validation.path;
    await this.updateItem(def, (c) => {
      const next: Item = { ...c };
      if (nextPath === undefined) delete next.path;
      else next.path = nextPath;
      return next;
    });
    this.customPathEditing.delete(editKey);
    this.renderItemCard(wrap, def);
  }

  // Icon lock control (spec §2.2/§5) shared by the path row (whole-file encrypt) and every rule
  // row (per-key encrypt). Three states:
  // unencrypted-but-available renders an OPEN lock (a closed one reads as
  // already-encrypted), encrypted renders the closed `.is-on` lock, and a lock that can neither
  // show state nor take a click (disabled AND unencrypted — a `This device` rule, per-item rules
  // on, the path row while per-key rules own the file) renders NOTHING: its empty slot keeps the
  // column. Only disabled+encrypted (unreachable through the UI today) still paints, dim —
  // state is never hidden. Tooltip/aria reflect only the CURRENT boolean (`Encrypt`/`Encrypted`).
  private renderLockToggle(cell: HTMLElement, opts: { encrypted: boolean; disabled: boolean; onChange: (v: boolean) => void }): void {
    if (opts.disabled && !opts.encrypted) return;
    const icon = cell.createSpan({ cls: `config-sync-lock${opts.encrypted ? " is-on" : ""}` });
    setIcon(icon, opts.encrypted ? "lock" : "lock-open");
    icon.setAttribute("aria-label", opts.encrypted ? "Encrypted" : "Encrypt");
    if (opts.disabled) {
      icon.addClass("config-sync-dim");
      return;
    }
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.addEventListener("click", () => opts.onChange(!opts.encrypted));
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onChange(!opts.encrypted);
      }
    });
  }

  // Decides whether zone ②'s body needs a file read at all (spec §4 progressive disclosure): a card with no
  // per-key rules AND a collapsed preview never reads the file — rule rows are empty either way
  // (buildRuleRows needs no live doc to return []) and there's nothing else to show. Every other
  // combination reads once and renders rule rows + the preview disclosure off-DOM before swapping
  // into `host` in one shot, so refreshCardBody never flashes an empty body while the read is in
  // flight.
  // "Jump to the per-key rules" means WHEREVER they live, which is not always the `Key rules`
  // panel. A card whose only per-key entries are enablement-list keys renders no such panel:
  // buildRuleRows filters those keys out (their rows already exist elsewhere), yet deriveMode still
  // counts them, so the cell correctly says per-key rules decide. Appearance is the one item where
  // that is the WHOLE set — its single rule is `enabledCssSnippets`, whose rows live under
  // `Folders → snippets`. Follow the declared link (`presetCompanions[].mapKey`) to that row rather
  // than adding a second hardcoded branch for it.
  //
  // A method rather than a closure inside the rule row, because BOTH entrances to this jump have to
  // land in the same place: the row's own menu here, and the Sync Center card's identically-worded
  // `Per-key rules decide` (which arrives through the settings deep link, spot `key-rules`). While
  // this lived in the row, the Sync Center's copy had nothing to call and settled for highlighting
  // the whole card instead — same words, two different landings.
  private jumpToKeyRules(wrap: HTMLElement, def: ItemDef, item: Item): void {
    const target =
      wrap.querySelector(".config-sync-card-fields") ??
      enablementRuleKeysOf(def, item)
        .map((k) => wrap.querySelector(`[data-cs-mapkey="${k}"]`))
        .find((el) => el !== null) ??
      null;
    // Still null while the async file read is in flight (renderCardBodyInto has not built the body
    // yet) — silent no-op, the next click after it lands works. The deep-link path never sees this:
    // it fires FROM the body-built hook below.
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    // Same visual language highlightAnchor uses for a card-level jump — this one stays inside the
    // current card, so it scopes its lookup to `wrap` instead of the whole panel.
    target.addClass("config-sync-search-highlight");
    window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1800);
  }

  // Set by consumeSettingsAnchor when the deep link asked for spot `key-rules`; consumed by the
  // first card body that finishes building for that item. The wait is the point — the key-rules
  // rows only exist once the async file read lands, so a jump attempted at display() time would
  // find nothing and silently do nothing.
  private pendingKeyRulesJump: string | null = null;

  private landPendingKeyRulesJump(def: ItemDef, item: Item, wrap: HTMLElement): void {
    if (this.pendingKeyRulesJump !== def.id) return;
    this.pendingKeyRulesJump = null;
    this.jumpToKeyRules(wrap, def, item);
  }

  private renderCardBodyInto(host: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const open = this.previewOpen.has(def.id);
    // Per-host generation token: rapid successive writes (scope-icon cycling) fire overlapping
    // async reads below, and without this the EARLIER read resolving LAST would swap a stale
    // body over the fresh one. Only the newest call may complete the swap; the
    // synchronous branch bumps it too, so it also invalidates any read still in flight.
    const gen = String(Number(host.dataset.csBodyGen ?? "0") + 1);
    host.dataset.csBodyGen = gen;
    const build = (target: HTMLElement, doc: Record<string, unknown>, fileState: CardFileState): void => {
      const bodyEl = target.createDiv({ cls: "config-sync-card-sfbody" });
      this.renderRuleRows(bodyEl, def, item, doc, wrap);
      this.renderPreviewDisclosure(bodyEl, def, item, doc, fileState, wrap);
    };
    if (!hasKeyRules(item) && !open) {
      host.empty();
      build(host, {}, "missing");
      this.landPendingKeyRulesJump(def, item, wrap);
      return;
    }
    void (async () => {
      const probe = this.cardProbeGroup(def, item);
      const raw = probe === null ? null : await this.host.readItemFile(probe);
      if (!host.isConnected || host.dataset.csBodyGen !== gen) return; // drawer closed, row rebuilt, or a newer refresh superseded this read
      const { doc, fileState } = parseCardDoc(raw);
      const tmp = createDiv();
      build(tmp, doc, fileState);
      // The swap replaces the File preview's <pre> wholesale, so its scroll position is carried
      // across by hand — a rule added by clicking a key deep in a long file must not snap the
      // preview back to the first line.
      const prevScroll = host.querySelector(".config-sync-json-pre")?.scrollTop ?? 0;
      host.empty();
      while (tmp.firstChild !== null) host.appendChild(tmp.firstChild);
      if (prevScroll > 0) {
        const pre = host.querySelector(".config-sync-json-pre");
        if (pre !== null) pre.scrollTop = prevScroll;
      }
      this.landPendingKeyRulesJump(def, item, wrap);
    })();
  }

  // Rule rows list ONLY configured keys (buildRuleRows) — browsing the file's full key set is
  // File preview's job (spec §3.1). Nothing renders when there are none.
  private renderRuleRows(bodyEl: HTMLElement, def: ItemDef, item: Item, doc: Record<string, unknown>, wrap: HTMLElement): void {
    const rows = buildRuleRows(def, item, doc);
    if (rows.length === 0) return;
    // Zone header, label only. The `this device` column header retired with the merged control:
    // there is no local COLUMN any more, both layers live inside one control, and the words that
    // told them apart moved into that control's menu as its two section headers.
    const head = bodyEl.createDiv({ cls: "config-sync-scrow" });
    head.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: "Key rules" });
    const panel = bodyEl.createDiv({ cls: "config-sync-card-fields" });
    for (const row of rows) this.renderRuleRow(panel, def, item, row, doc, wrap);
  }

  private renderRuleRow(panel: HTMLElement, def: ItemDef, item: Item, row: FieldRowModel, doc: Record<string, unknown>, wrap: HTMLElement): void {
    const fr = panel.createDiv({ cls: "config-sync-scrow config-sync-card-rulerow" });
    // The key IS the row's identity: a mono name on track 1, the whole control
    // cluster — scope → lock → (array keys) per-item icon — left-anchored in the controls column.
    fr.createSpan({ cls: "config-sync-fkey", text: row.key });
    const slots = this.scrowSlots(fr);
    const setRule = (mutator: (r: ItemFieldRule) => ItemFieldRule): void => {
      void (async () => {
        await this.updateItem(def, (c) => {
          const sf = c.settingsFile ?? defaultSettingsFile();
          const nextRule = mutator(sf.rules[row.key] ?? DEFAULT_FIELD_RULE);
          return { ...c, settingsFile: withDerivedMode({ ...sf, rules: { ...sf.rules, [row.key]: nextRule } }) };
        });
        this.refreshCardBadges(wrap, def);
        this.refreshCardBody(wrap, def);
      })();
    };
    // setRule → refreshCardBody rebuilds every rule row, so the icon re-reads the fresh sharing.
    // The rule's removal is the menu's own warning item.
    // A per-key rule now has its own local layer (below), so its shared half must not speak in
    // "this device" terms any more — `ruleIcon`/`ruleLabel` rename the fourth stop from `This
    // device`/`airplay` to `Not shared`/`split` (enablementRow.ts). The STORED value is
    // still the same `this-device` union member; only the presentation moves to the enablement
    // vocabulary, matching the controls above it (renderDefaultEnabledOnRow, renderElementRuleRow).
    const removeRule = (): void => {
      void (async () => {
        await this.updateItem(def, (c) => {
          const sf = c.settingsFile ?? defaultSettingsFile();
          const rules = { ...sf.rules };
          delete rules[row.key];
          const perElement = { ...sf.perElement };
          delete perElement[row.key];
          return { ...c, settingsFile: withDerivedMode({ ...sf, rules, perElement }) };
        });
        if (!hasKeyRules(this.itemOf(def))) {
          // Removing the last rule flips hasKeyRules -> false, which undims the path row's own
          // scope/lock controls (spec §3.1) — refreshed in place: a full re-render would
          // jump the panel and leave the dim state stale on other paths.
          this.refreshPathRow(wrap, def);
        }
        this.refreshCardBadges(wrap, def);
        this.refreshCardBody(wrap, def);
      })();
    };
    // ONE control for both layers. `ruleRowHasLocalLayer` decides whether there
    // IS a second layer: a per-item key is governed by the per-item machinery, and a `Not shared`
    // key has no shared value to opt out of — either way the control shows one glyph and the menu
    // one section, so what you can see and what you can pick always match.
    const ref = defRef(def);
    const hasLocal = ruleRowHasLocalLayer(row);
    const excepted = hasLocal && this.host.deviceFieldExceptedFor(ref, row.key);
    this.paintMergedControl(slots.device, {
      shared: { icon: ruleIcon(row.rule.sharing), tooltip: sharingCycleTooltip(row.rule.sharing) },
      local: hasLocal ? optOutLocalSegment(excepted) : null,
      localIsException: excepted,
      sections: () => {
        const shared = sharingMenuSection({
          header: SHARED_WITH_HEADER,
          options: FIELD_SHARING_OPTIONS,
          current: row.rule.sharing,
          iconFor: ruleIcon,
          labelFor: ruleLabel,
          onChange: (v) => setRule((r) => ({ ...r, sharing: v, encrypted: v.kind === "this-device" ? false : r.encrypted })),
        });
        const localSection: MenuSectionModel[] = hasLocal
          ? [{
              header: ON_THIS_DEVICE_HEADER,
              items: buildOptOutLocalMenu(excepted, {
                follow: () => void this.host.setDeviceFieldExcepted(ref, row.key, false).then(() => this.refreshCardBody(wrap, def)),
                optOut: () => void this.host.setDeviceFieldExcepted(ref, row.key, true).then(() => this.refreshCardBody(wrap, def)),
              }),
            }]
          : [];
        return [shared, ...localSection, { header: null, items: [{ title: "Remove rule", icon: "trash", checked: false, action: removeRule }] }];
      },
    });
    const lockCell = slots.lock;
    const lockDisabled = encryptToggleDisabled(row.rule.sharing, row.perElementEnabled);
    this.renderLockToggle(lockCell, { encrypted: row.rule.encrypted, disabled: lockDisabled, onChange: (v) => setRule((r) => ({ ...r, encrypted: v })) });
    if (row.isArray) {
      // Per-item device rules as an icon toggle.
      // Encrypt and Per-item scopes are mutually exclusive on the same
      // rule (manifest.ts D3) — enabling Per-item here clears `encrypted` in the SAME write
      // (applyPerElementToggle), and this icon renders disabled while the rule is already
      // encrypted (the lock disappears the other way — encryptToggleDisabled makes
      // renderLockToggle render nothing while per-item is on) so the UI can never produce the
      // combination the compiler rejects.
      const pi = slots.aux.createSpan({ cls: `config-sync-perelement-ic${row.perElementEnabled ? " is-set" : ""}` });
      setIcon(pi, "list-checks");
      if (row.rule.encrypted) {
        pi.addClass("config-sync-dim");
        pi.setAttribute("aria-label", PER_ITEM_DISABLED_HINT);
      } else {
        pi.setAttribute("aria-label", `${PER_ELEMENT_RULES_LABEL} — each item gets its own rule`);
        pi.setAttribute("role", "button");
        pi.setAttribute("tabindex", "0");
        const flip = (): void => {
          void (async () => {
            await this.updateItem(def, (c) => ({
              ...c,
              settingsFile: withDerivedMode(applyPerElementToggle(c.settingsFile ?? defaultSettingsFile(), row.key, !row.perElementEnabled)),
            }));
            this.refreshCardBadges(wrap, def);
            this.refreshCardBody(wrap, def);
          })();
        };
        pi.addEventListener("click", flip);
        pi.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            flip();
          }
        });
      }
    }
    if (row.isArray && row.perElementEnabled) {
      const elements = isStringArrayValue(doc[row.key]) ? (doc[row.key] as string[]) : [];
      const sharings = item.settingsFile?.perElement[row.key] ?? {};
      for (const el of buildPerElementRows(elements, sharings)) this.renderPerElementRow(panel, def, row.key, el.element, el.sharing, wrap);
    }
  }

  // Array-key element row, indented under its rule row (spec §3.1 preserves this interaction; the indent lives
  // on the name inside the identity track, so the control column stays on the parent's rule).
  private renderPerElementRow(panel: HTMLElement, def: ItemDef, key: string, element: string, sharing: Sharing, wrap: HTMLElement): void {
    const r = panel.createDiv({ cls: "config-sync-scrow config-sync-card-elrow" });
    r.createSpan({ cls: "config-sync-card-elname", text: element });
    const sharingCell = this.scrowSlots(r).device;
    // refreshCardBody below rebuilds these element rows, so the icon re-reads the fresh sharing.
    this.renderSharingPicker(sharingCell, {
      sharing,
      options: FIELD_SHARING_OPTIONS,
      disabled: false,
      onChange: (v) => {
        void (async () => {
          await this.updateItem(def, (c) => {
            const sf = c.settingsFile ?? defaultSettingsFile();
            const sharings = { ...(sf.perElement[key] ?? {}) };
            if (v.kind === "everywhere") delete sharings[element];
            else sharings[element] = v;
            return { ...c, settingsFile: withDerivedMode({ ...sf, perElement: { ...sf.perElement, [key]: sharings } }) };
          });
          this.refreshCardBadges(wrap, def);
          this.refreshCardBody(wrap, def);
        })();
      },
    });
    r.createDiv(); // lock column — empty for an element row
    r.createDiv(); // action column — empty for an element row
  }

  // Un-ruled key click in the File preview (spec D6): promotes this item's own settingsFile.mode
  // to "fields" (deriveMode does this automatically once the rule below exists) and seeds an
  // inert/encrypt-looking default rule.
  private async addRuleForKey(def: ItemDef, key: string): Promise<void> {
    const rule: ItemFieldRule = { sharing: EVERYWHERE, encrypted: SENSITIVE_ENCRYPT_RE.test(key) };
    await this.updateItem(def, (c) => {
      const sf = c.settingsFile ?? defaultSettingsFile();
      return { ...c, settingsFile: withDerivedMode({ ...sf, rules: { ...sf.rules, [key]: rule } }) };
    });
    this.expanded.add(cardExpandKey(defRef(def)));
  }

  // Progressive disclosure (spec §4): collapsed by default, `previewOpen` is UI-transient
  // (session-only, mirrors the drawer's own `expanded` set). The trigger is
  // the `eye` icon on the path row (renderSettingsFilePathRow) — this method only renders the
  // CONTENT, gated on the same `previewOpen` set the icon writes. Expanding is still the only
  // thing that can trigger the file read this content depends on — a card already read for its
  // rule rows (renderCardBodyInto) reuses that same read, it is never repeated.
  private renderPreviewDisclosure(bodyEl: HTMLElement, def: ItemDef, item: Item, doc: Record<string, unknown>, fileState: CardFileState, wrap: HTMLElement): void {
    if (!this.previewOpen.has(def.id)) return;
    if (fileState === "missing") {
      bodyEl.createDiv({ cls: "config-sync-json-empty", text: "No file on this device yet — nothing to preview." });
      return;
    }
    if (fileState === "invalid") {
      bodyEl.createDiv({ cls: "config-sync-json-empty", text: "This file has no settings to show." });
      return;
    }
    this.renderCardDataPreview(bodyEl, def, item, doc, wrap);
  }

  private renderCardDataPreview(bodyEl: HTMLElement, def: ItemDef, item: Item, doc: Record<string, unknown>, wrap: HTMLElement): void {
    // A carrier card's element rows (the drawer, spec §6.4) ARE its rule surface — a per-key rule
    // on a boolean plugin map has no meaning, and a click writing `sf.rules[<plugin id>]` would
    // flip the item into "fields" mode and corrupt the switch-list file on next capture
    // (registry.ts's perElementFromMap also refuses that key, belt-and-braces, but this affordance
    // is what would invite the click). An enablement key's rules live on member rows — a rule
    // written here would be filtered straight back out by buildRuleRows. Both suppress the
    // clickable affordance below.
    const isCarrier = carrierListFor(def) !== null;
    const rules: FieldRule[] = Object.entries(item.settingsFile?.rules ?? {}).map(([pattern, r]) => ({ pattern, ...r }));
    this.renderJsonPreviewInto(bodyEl, doc, rules, this.detections.get(def.id)?.keys ?? [], item.settingsFile?.perElement ?? {}, {
      showHint: !isCarrier,
      ruleable: (key) => !isCarrier && !isEnablementRuleKey(def, key),
      onAddRule: (key) => {
        void this.addRuleForKey(def, key).then(() => {
          // Adding a rule can flip hasKeyRules -> true, which dims the path row's own
          // scope/lock controls (spec §3.1) — refreshed in place: a full re-render would
          // reset this preview's scroll to the top.
          this.refreshPathRow(wrap, def);
          this.refreshCardBadges(wrap, def);
          this.refreshCardBody(wrap, def);
        });
      },
    });
  }

  // The one JSON-preview renderer, shared by the item card's zone ② and the Advanced rule form
  // (which speaks SyncGroup, not ItemDef — the callers own the write path, this owns the paint).
  private renderJsonPreviewInto(
    bodyEl: HTMLElement,
    doc: Record<string, unknown>,
    rules: FieldRule[],
    detectedKeys: string[],
    perElement: Record<string, PerElementSharing>,
    opts: { showHint: boolean; ruleable: (key: string) => boolean; onAddRule: (key: string) => void }
  ): void {
    // Key clickability is made explicit (users didn't realize they could click): the action
    // sentence leads the preview instead of trailing the bottom legend, and every un-ruled key
    // below wears a persistent dashed underline (config-sync-json-clickable).
    if (opts.showHint) {
      const hint = bodyEl.createDiv({ cls: "config-sync-json-hint" });
      setIcon(hint.createSpan(), "plus");
      hint.appendText("Click any key to add a rule for it");
    }
    const pre = bodyEl.createEl("pre", { cls: "config-sync-json-pre" });
    const raw = JSON.stringify(doc, null, 2);
    const classByKey = new Map<string, KeyClass>();
    for (const kc of classifyJsonKeys(raw, rules, detectedKeys)) classByKey.set(kc.key, kc);
    const perElementLines = classifyPerElementLines(raw, perElement);
    const rawLines = raw.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const m = /^(\s{2})"([^"]+)":\s?(.*)$/.exec(line);
      const key = m?.[2];
      const kc = key !== undefined ? classByKey.get(key) : undefined;
      if (m !== null && key !== undefined && kc !== undefined) {
        pre.createSpan({ text: m[1] });
        const ruleable = kc.state.sharing === null && opts.ruleable(key);
        const noRuleHint = kc.state.sharing === null && !ruleable;
        const kspan = pre.createSpan({
          cls: `config-sync-json-key${noRuleHint ? "" : ` ${jsonKeyClass(kc)}`}${ruleable ? " config-sync-json-clickable" : ""}`,
          text: `"${key}"`,
        });
        // An encrypted rule marks its key with the same lucide lock the rest of the panel uses.
        if (kc.state.encrypted) setIcon(kspan.createSpan({ cls: "config-sync-json-lock" }), "lock");
        if (ruleable) kspan.addEventListener("click", () => opts.onAddRule(key));
        pre.appendText(": ");
        const rest = m[3] ?? "";
        const comma = rest.endsWith(",");
        const val = comma ? rest.slice(0, -1) : rest;
        if (/^".*"$/.test(val)) pre.createSpan({ cls: "config-sync-json-val", text: val });
        else if (/^-?\d/.test(val)) pre.createSpan({ cls: "config-sync-json-num", text: val });
        else pre.appendText(val);
        if (comma) pre.appendText(",");
      } else {
        // Per-element array line (D10): colored by that element's own sharing, independent of
        // the top-level key's own rule/color above.
        const el = perElementLines.get(i);
        const elCls = el !== undefined ? jsonElementClass(el) : null;
        if (el !== undefined && elCls !== null) {
          const indent = /^\s*/.exec(line)?.[0] ?? "";
          pre.appendText(indent);
          pre.createSpan({ cls: `config-sync-json-el ${elCls}`, text: line.slice(indent.length) });
        } else {
          pre.appendText(line);
        }
      }
      pre.appendText("\n");
    }
    const legend = bodyEl.createDiv({ cls: "config-sync-json-legend" });
    PREVIEW_LEGEND_ENTRIES.forEach((entry, i) => {
      if (i > 0) legend.createSpan({ cls: "config-sync-legend-sep", text: "·" });
      if (entry.kind === "sharing" && entry.cls !== null) legend.createSpan({ cls: `config-sync-legend-dot ${entry.cls}` });
      if (entry.kind === "lock") setIcon(legend.createSpan({ cls: "config-sync-legend-lock" }), "lock");
      legend.appendText(entry.text);
    });
  }

  // "+ Add folder" is available on every card (spec §5) — a def with no preset companions and an
  // empty config produces zero rows (buildCompanionRows), in which case the zone renders no
  // header and no rows, just the Add-folder entry point below. EXCEPT carriers:
  // a switch registry has no meaning for a folder to attach to (an arbitrary folder belongs to
  // a custom rule), so a carrier card gets no Add-folder entry point — but a legacy user-added
  // folder in config still renders its row, visible and removable, never silently active.
  private renderCompanionZone(exp: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const rows = buildCompanionRows(def, item);
    const isCarrier = carrierListFor(def) !== null;
    if (isCarrier && rows.length === 0) return;
    if (rows.length > 0) exp.createDiv({ cls: "config-sync-explabel", text: "Folders" });
    const listEl = exp.createDiv({ cls: "config-sync-card-companions" });
    for (const row of rows) {
      const key = this.companionMemberKey(def, row);
      const open = this.membersOpen.has(key);
      // Forward references: the toggle callback needs
      // both, but `rowEls` is this very call's return value and `membersHost` is only created
      // right after it (DOM order requires the row before its host) — both are only ever READ
      // from the callback, which can't fire until this render pass has finished assigning them.
      let rowEls: { countEl: HTMLElement; chevron: HTMLElement } | null = null;
      let membersHost: HTMLElement | null = null;
      // Hoisted above the row render (it used to sit below, beside the member scan): the row itself
      // now stamps this key, so the two readers — the scan that decides WHICH member list to draw,
      // and the jump that needs to FIND this row — still ask the same single lookup.
      const mapKey = def.presetCompanions?.find((p) => p.path === row.path)?.mapKey;
      rowEls = this.renderCompanionRow(listEl, def, row, wrap, open, mapKey, () => {
        const nowOpen = !this.membersOpen.has(key);
        if (nowOpen) this.membersOpen.add(key);
        else this.membersOpen.delete(key);
        // The fold toggle ONLY flips visibility + the chevron now — no zone rebuild, no new file
        // scan. The member host was already populated once, on this card expansion's own scan
        // below (or is still filling in — the scan patches it in place whenever it lands,
        // regardless of open/closed, so there's nothing left for a toggle to kick off).
        if (rowEls !== null) setFoldOpen(rowEls.chevron, nowOpen);
        if (membersHost !== null) membersHost.hidden = !nowOpen;
      });
      // Synchronous per-row anchor: the async member scans below resolve in arbitrary order, so
      // they must land in a host reserved DIRECTLY under their own folder row — appending to
      // listEl would file one folder's members under whichever row happened to render last.
      membersHost = listEl.createDiv({ cls: "config-sync-card-memberhost" });
      membersHost.hidden = !open;
      // Narrowed capture (membersHost itself stays nullable — the toggle callback above needs a
      // defensive null check since it's wired before this assignment runs): the two scans below
      // are plain closures over a `let`, so TS can't carry the non-null narrowing in without one.
      const host = membersHost;
      if (mapKey === ENABLED_CSS_SNIPPETS_KEY) {
        void (async () => {
          const files = await this.host.listSnippetFiles();
          if (!host.isConnected) return; // the card collapsed / the zone rebuilt while the scan was in flight
          this.renderSnippetMembers(host, def, buildSnippetMemberRows(files, this.snippetRules()), wrap, rowEls?.countEl ?? null);
        })();
      } else {
        // Plain (non-mapKey) companion: list-only member names, no per-member scope chip — the
        // switch-list engine only knows community-plugins.json, core-plugins.json and
        // enabledCssSnippets today, so an arbitrary folder group has no per-file sharing
        // mechanism to wire a chip to. isThemesPreset
        // (spec §4's "· N themes" vs "· N files") is true only for a preset row with no mapKey —
        // today that is exactly the Appearance card's themes/ preset, never a plain user folder.
        const isThemesPreset = row.isPreset && mapKey === undefined;
        void (async () => {
          const files = await this.host.listCompanionFiles(row.path);
          if (!host.isConnected) return;
          this.renderPlainCompanionMembers(host, files, rowEls?.countEl ?? null, isThemesPreset);
        })();
      }
    }
    if (!isCarrier) this.renderAddCompanionRow(exp, def, wrap);
  }

  private companionEditKey(def: ItemDef, path: string): string {
    return `${defRef(def)}::${path}`;
  }

  // Member-list collapse key (spec §4 Step 3) — UI-
  // transient. Double-colon separator matches companionEditKey: an item ref itself contains a
  // single slash, so "::" keeps the join unambiguous.
  private companionMemberKey(def: ItemDef, row: CompanionRowModel): string {
    return `${defRef(def)}::${row.path}`;
  }

  // Folder row = the grid's row for one companion (spec §2.1/§4 Step 2/3): name + member count
  // pill (patched in once the async scan below resolves) + fold chevron in the content column |
  // scope picker | small
  // toggle | ✎ (every row) with ✕ ADDITIONALLY for a user-added row (never for a preset — D8: a
  // preset is only ever relocated via the warning-gated path edit, never removed outright). Returns
  // the count span (so renderCompanionZone's async scan can patch it in place) and the chevron (so
  // its own toggle callback can rotate it without a rebuild); null while this row is mid path-edit
  // (renderCompanionPathEditRow owns the DOM then, nothing here to patch or toggle).
  private renderCompanionRow(
    listEl: HTMLElement,
    def: ItemDef,
    row: CompanionRowModel,
    wrap: HTMLElement,
    open: boolean,
    mapKey: string | undefined,
    onToggle: () => void
  ): { countEl: HTMLElement; chevron: HTMLElement } | null {
    const editKey = this.companionEditKey(def, row.path);
    if (this.companionPathEditing.has(editKey)) {
      this.renderCompanionPathEditRow(listEl, def, row, wrap, editKey);
      return null;
    }
    // The row carries its own mapKey so the path row's jump can FIND it by data instead of by a
    // second hardcoded "appearance means snippets" branch: `mapKey` already declares which settings
    // key this folder's member list is stored under (registry.ts's presetCompanions), and that is
    // precisely the link the jump needs. Absent on plain folders, which carry no key.
    const r = listEl.createDiv({
      cls: "config-sync-scrow config-sync-card-companiongrid",
      attr: mapKey === undefined ? {} : { "data-cs-mapkey": mapKey },
    });
    const contentCell = r.createDiv({ cls: "config-sync-card-foldercontent" });
    contentCell.setAttribute("role", "button");
    contentCell.setAttribute("tabindex", "0");
    // The folder name itself is the path-edit entry point —
    // it needs its own click/key handling with stopPropagation so it doesn't ALSO toggle the
    // member list, which the rest of the content cell still does.
    const pathEl = contentCell.createEl("code", { cls: "config-sync-card-path config-sync-card-pathbtn", text: splitLocation(row.path).rel });
    pathEl.setAttribute("role", "button");
    pathEl.setAttribute("tabindex", "0");
    pathEl.setAttribute("aria-label", "Change path");
    const startPathEdit = (): void => {
      this.companionPathEditing.add(editKey);
      this.renderItemCard(wrap, def);
    };
    pathEl.addEventListener("click", (e) => {
      e.stopPropagation();
      startPathEdit();
    });
    pathEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        startPathEdit();
      }
    });
    // Bare-number pill (same neutral family the panel's other counts use) — the full
    // "N themes"/"N files" sentence lives in the pill's own aria-label/tooltip — then the FOLD
    // family's rotating chevron.
    const countEl = contentCell.createSpan({ cls: "config-sync-pill is-neutral config-sync-card-membercount" });
    const chevron = renderFoldChevron(contentCell, open, "config-sync-card-memberarrow");
    contentCell.addEventListener("click", onToggle);
    contentCell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle();
      }
    });
    const updateCompanion = (mutator: (c: { path: string; device: DeviceClass; enabled: boolean }) => { path: string; device: DeviceClass; enabled: boolean }): void => {
      void (async () => {
        await this.updateItem(def, (c) => {
          const configured = c.companions ?? [];
          const existing = configured.find((x) => x.path === row.path);
          const next = mutator(existing ?? { path: row.path, device: row.device, enabled: row.enabled });
          const companions = existing !== undefined ? configured.map((x) => (x.path === row.path ? next : x)) : [...configured, next];
          return { ...c, companions };
        });
        // No re-render: the control the user just touched already shows the new value, and no
        // header badge reads a companion's device/enabled — a full card rebuild here only causes
        // the panel to visibly jump while the drawer's async reads re-resolve.
      })();
    };
    // updateCompanion deliberately never re-renders (see its comment), so the icon rebuilds
    // itself from a locally-tracked value after each pick. A companion folder syncs as a
    // whole, so its axis is the device class, not a per-key sharing. The picker sits in the
    // shared device slot; a user-added row's removal is the picker menu's own warning
    // item (a preset's menu offers no such item).
    const deviceCell = this.scrowSlots(r).device;
    let curDevice = row.device;
    const buildDevice = (): void => {
      deviceCell.empty();
      this.renderSharingPicker(deviceCell, {
        sharing: curDevice === "all" ? EVERYWHERE : perClass(curDevice),
        options: COMPANION_DEVICE_OPTIONS.map((d) => (d === "all" ? EVERYWHERE : perClass(d))),
        disabled: false,
        onChange: (v) => {
          curDevice = sharingClass(v) ?? "all";
          updateCompanion((c) => ({ ...c, device: curDevice }));
          buildDevice();
        },
        extras: row.isPreset ? [] : [{
          title: "Remove folder",
          icon: "trash",
          action: () => {
            void (async () => {
              await this.updateItem(def, (c) => ({ ...c, companions: (c.companions ?? []).filter((x) => x.path !== row.path) }));
              this.renderItemCard(wrap, def);
            })();
          },
        }],
      });
    };
    buildDevice();
    // STATE control on the rail: the sync toggle right-anchors in the track-4 end
    // cell, sharing the card header toggle's right edge — rule controls stay in the cluster.
    const end = r.createDiv({ cls: "config-sync-scrow-end" });
    new ToggleComponent(end).setValue(row.enabled).onChange((v) => updateCompanion((c) => ({ ...c, enabled: v })));
    return { countEl, chevron };
  }

  // Preset row path edit (spec §4/§8, D8): validate -> no-op guard -> companionConflict ->
  // confirmPresetPathChange -> on confirm, drop the entry at the OLD preset path (if any — a
  // never-toggled preset has none) and add a fresh one at the new path carrying over the same
  // device/enabled — this "captures the new path as a fresh item" (it renders as an ordinary user
  // row from then on, since buildCompanionRows only treats an EXACT preset-path match as preset).
  private renderCompanionPathEditRow(listEl: HTMLElement, def: ItemDef, row: CompanionRowModel, wrap: HTMLElement, editKey: string): void {
    const r = listEl.createDiv({ cls: "config-sync-card-companionrow" });
    const input = new TextComponent(r);
    input.setValue(row.path);
    input.inputEl.addClass("config-sync-card-pathinput");
    r.createDiv({ cls: "config-sync-rule-spacer" });
    const errorEl = listEl.createDiv({ cls: "config-sync-save-error mod-warning" });
    errorEl.hide();
    const cancel = (): void => {
      this.companionPathEditing.delete(editKey);
      this.renderItemCard(wrap, def);
    };
    const submit = (): void => {
      void (async () => {
        const validation = validateCompanionPath(input.getValue());
        if (!validation.ok) {
          errorEl.setText(validation.error);
          errorEl.show();
          return;
        }
        if (validation.path === normalizeCompanionPath(row.path)) {
          cancel(); // no real change
          return;
        }
        // Reject a basename that would never survive
        // validateSyncManifest (illegal group-name shape) or that collides with another
        // compiled group's name — BEFORE persisting, not just at the next recompile.
        const basenameError = validateCompanionBasename(validation.path);
        if (basenameError !== null) {
          errorEl.setText(basenameError);
          errorEl.show();
          return;
        }
        const conflict = companionConflict(validation.path, this.host.itemDefs(), this.host.settings);
        if (conflict !== null) {
          errorEl.setText(companionConflictError(conflict));
          errorEl.show();
          return;
        }
        const nameConflict = companionNameConflict(validation.path, this.host.itemDefs(), this.host.settings, { ref: defRef(def), path: row.path });
        if (nameConflict !== null) {
          errorEl.setText(companionNameConflictError(nameConflict));
          errorEl.show();
          return;
        }
        // The warning modal only makes sense for a PRESET path (ConfirmModal.ts) — a plain
        // user-added folder has no preset identity to move away from, so its path edit (offered
        // on every companion row, spec §4 Step 2) commits
        // straight away.
        // §4.2b: refuse before the warning modal opens (see the settings-file path row above).
        if (!this.host.settingsWritable()) {
          cancel(); // the same restore path Cancel takes — the edit did not happen
          return;
        }
        if (row.isPreset) {
          const confirmed = await confirmPresetPathChange(this.app, def.label);
          if (!confirmed) {
            cancel(); // revert the control to its prior value
            return;
          }
        }
        await this.updateItem(def, (c) => {
          const withoutOld = (c.companions ?? []).filter((x) => x.path !== row.path);
          return { ...c, companions: [...withoutOld, { path: validation.path, device: row.device, enabled: row.enabled }] };
        });
        this.companionPathEditing.delete(editKey);
        this.renderItemCard(wrap, def);
      })();
    };
    new ButtonComponent(r).setCta().setButtonText("Save").onClick(submit);
    new ButtonComponent(r).setButtonText("Cancel").onClick(cancel);
    input.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    // Escape cancels THIS edit, not the settings window — same keymap-Scope technique as the
    // settings-file path row (Obsidian's keymap sees Escape at window capture before any element
    // listener, so stopPropagation can't help).
    // popScope is idempotent; cancel()'s re-render detaches the input without a blur in Chromium.
    const escScope = new Scope();
    escScope.register([], "Escape", () => {
      this.app.keymap.popScope(escScope);
      cancel();
      return false;
    });
    input.inputEl.addEventListener("focus", () => this.app.keymap.pushScope(escScope));
    input.inputEl.addEventListener("blur", () => this.app.keymap.popScope(escScope));
    window.setTimeout(() => input.inputEl.focus(), 0); // autofocus, matching the path row's edit state
  }

  // Progressive disclosure (spec §4 Step 3): the count always patches into the folder row's own
  // countEl once the scan resolves — collapsed or not. The member rows + hint themselves render
  // unconditionally: the fold toggle never rebuilds this zone,
  // so the content has to already exist for a later open to reveal — `membersHost.hidden`
  // (renderCompanionZone) is the only thing gating visibility, never a rebuild-time `open` check.
  private renderPlainCompanionMembers(listEl: HTMLElement, files: string[], countEl: HTMLElement | null, isThemesPreset: boolean): void {
    const names = sortCompanionMemberNames(files);
    countEl?.setText(String(names.length));
    countEl?.setAttribute("aria-label", memberCountLabel(isThemesPreset, names.length));
    if (names.length === 0) return;
    const wrapEl = listEl.createDiv({ cls: "config-sync-card-snippetmembers" });
    for (const name of names) {
      // Name inside an -ldname span (not row text) so the member indent lands on the name cell,
      // same as snippet rows — the row's own grid stays on the card's shared columns.
      wrapEl.createDiv({ cls: "config-sync-scrow config-sync-card-companiongrid" }).createSpan({ cls: "config-sync-ldname", text: name });
    }
    wrapEl.createDiv({ cls: "config-sync-ldhint", text: FOLDER_MEMBER_HINT });
  }

  private addCompanionKey(def: ItemDef): string {
    return `addcompanion:${def.id}`;
  }

  // "+ Add folder" (spec §4/§10, D8): a plain vault-relative path, same validate/conflict guard
  // as everything else in this zone — dedupe-within-the-card falls out of companionConflict for
  // free (a duplicate add collides with THIS item's own existing preset/companion entry, see
  // registry.ts's companionConflict doc comment). New rows land enabled — the user just asked
  // for this folder to sync — at "All devices", same as any other freshly-added default.
  private renderAddCompanionRow(exp: HTMLElement, def: ItemDef, wrap: HTMLElement): void {
    const key = this.addCompanionKey(def);
    if (!this.addingCompanion.has(key)) {
      // Downgraded to a quiet link-like text row (spec §4 Step 4) — .config-sync-add-row-quiet
      // overrides the bordered/centered chrome the "+ Add rule"/"+ Add remote" buttons elsewhere
      // still use, so only this row's look changes.
      const addBtn = exp.createEl("button", { cls: "config-sync-add-row config-sync-add-row-quiet", text: ADD_FOLDER_LABEL });
      addBtn.addEventListener("click", () => {
        this.addingCompanion.add(key);
        this.renderItemCard(wrap, def);
      });
      return;
    }
    const form = exp.createDiv({ cls: "config-sync-card-addcompanion" });
    const input = new TextComponent(form);
    input.setPlaceholder("Vault-relative path");
    input.inputEl.addClass("config-sync-card-pathinput");
    const errorEl = exp.createDiv({ cls: "config-sync-save-error mod-warning" });
    errorEl.hide();
    const cancel = (): void => {
      this.addingCompanion.delete(key);
      this.renderItemCard(wrap, def);
    };
    const submit = (): void => {
      const validation = validateCompanionPath(input.getValue());
      if (!validation.ok) {
        errorEl.setText(validation.error);
        errorEl.show();
        return;
      }
      // Reject a basename that would never survive
      // validateSyncManifest (illegal group-name shape) or that collides with another compiled
      // group's name — BEFORE persisting, not just at the next recompile.
      const basenameError = validateCompanionBasename(validation.path);
      if (basenameError !== null) {
        errorEl.setText(basenameError);
        errorEl.show();
        return;
      }
      const conflict = companionConflict(validation.path, this.host.itemDefs(), this.host.settings);
      if (conflict !== null) {
        errorEl.setText(companionConflictError(conflict));
        errorEl.show();
        return;
      }
      const nameConflict = companionNameConflict(validation.path, this.host.itemDefs(), this.host.settings, null);
      if (nameConflict !== null) {
        errorEl.setText(companionNameConflictError(nameConflict));
        errorEl.show();
        return;
      }
      void (async () => {
        await this.updateItem(def, (c) => ({ ...c, companions: [...(c.companions ?? []), { path: validation.path, device: "all", enabled: true }] }));
        this.addingCompanion.delete(key);
        this.renderItemCard(wrap, def);
      })();
    };
    new ButtonComponent(form).setCta().setButtonText("Add").onClick(submit);
    new ButtonComponent(form).setButtonText("Cancel").onClick(cancel);
    input.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    input.inputEl.focus();
  }

  // THE snippet rule map — read through enablementRules like every other list's, rather than
  // reaching into appearance's `perElement` by hand (spec §6.6: one reader, one writer).
  private snippetRules(): PerElementSharing {
    return enablementRules(this.host.settings.items, SNIPPET_LIST);
  }

  // Progressive disclosure (spec §4 Step 3): count always patches into countEl; member rows +
  // hint render unconditionally (same reasoning as
  // renderPlainCompanionMembers above) — the fold toggle never rebuilds this zone, so the
  // content has to already exist for a later open to reveal; `membersHost.hidden`
  // (renderCompanionZone) is the only thing gating visibility. Snippets are never the themes
  // preset, so memberCountLabel's first argument is always false here. Each row is
  // renderElementRuleRow's (spec §6.4) — the orphan pill and Forget stay here, because they are
  // facts about a FILE, which is a thing only this list's elements have.
  private renderSnippetMembers(listEl: HTMLElement, def: ItemDef, rows: SnippetMemberRow[], wrap: HTMLElement, countEl: HTMLElement | null): void {
    const fileCount = rows.filter((r) => r.fileExists).length;
    countEl?.setText(String(fileCount));
    countEl?.setAttribute("aria-label", memberCountLabel(false, fileCount));
    if (rows.length === 0) return;
    const wrapEl = listEl.createDiv({ cls: "config-sync-card-snippetmembers" });
    for (const row of rows) {
      const contentCell = this.renderElementRuleRow(wrapEl, {
        def,
        wrap,
        list: SNIPPET_LIST,
        elementId: row.name,
        label: row.name,
        desktopOnly: false, // a .css file runs wherever the vault does
        orphan: !row.fileExists,
        onWritten: () => this.refreshCardBadges(wrap, def),
      });
      if (!row.fileExists) {
        contentCell.createSpan({ cls: "config-sync-orphanpill", text: "file deleted" });
        const forget = contentCell.createEl("button", { cls: "config-sync-orphan-forget", text: "Forget" });
        forget.addEventListener("click", () => {
          forget.disabled = true; // the rebuild below replaces the row — no re-enable path needed
          void (async () => {
            await this.writeElementRule(def, wrap, SNIPPET_LIST, row.name, EVERYWHERE);
            // The row leaves the union — rebuild the member zone in place (fresh file list + fresh
            // rules), then refresh the badges the row's own writes would have.
            const files = await this.host.listSnippetFiles();
            if (!listEl.isConnected) return; // the drawer closed while the scan was in flight
            listEl.empty();
            this.renderSnippetMembers(listEl, def, buildSnippetMemberRows(files, this.snippetRules()), wrap, countEl);
            this.refreshCardBadges(wrap, def);
          })();
        });
      }
    }
    if (rows.some((r) => !r.fileExists)) wrapEl.createDiv({ cls: "config-sync-ldhint config-sync-orphanhint", text: SNIPPET_ORPHAN_HINT });
    wrapEl.createDiv({ cls: "config-sync-ldhint", text: SNIPPET_MEMBER_HINT });
  }

  // True only when the item's storage location (Location/Type/Path) differs from its default —
  // the "⚙ custom location" state. Mode, devices, and field rules are everyday configuration
  // and deliberately do NOT count as customization here.
  private isCustomized(group: SyncGroup): boolean {
    const expected = expectedPathForName(group.name);
    const pathCustom = expected !== null && group.path !== expected;
    const def = defaultGroupForName(group.name);
    const typeCustom = def !== null && group.type !== def.type;
    return pathCustom || typeCustom;
  }

  private renderModeSegment(controlEl: HTMLElement, group: SyncGroup, afterChange: () => void): void {
    // Switch lists are pinned to Plain: exception masking reads the raw list, and encrypting an
    // on/off list is meaningless. A three-button segment with one forced choice is noise, so
    // these rows render no segment at all.
    if (isSwitchListGroup(group.name)) return;
    // The §2.2 display names — the stored ids never change.
    const modes: { id: SyncMode; label: string }[] = [
      { id: "plain", label: MODE_LABELS.plain },
      { id: "fields", label: MODE_LABELS.fields },
      { id: "encrypted", label: MODE_LABELS.encrypted },
    ];
    const current = group.mode ?? "plain";
    // The plugin's own item is pinned to Fields mode: its locked device-local strip rules
    // (rootPath/remotes) only exist under "fields", and ensureSelfPresets re-forces it on
    // every commit — so offering Plain/Encrypt here would silently revert.
    // Appearance is pinned the same way whenever the enabled-css-snippets group is active:
    // ensureAppearancePresets re-forces mode:"fields" + a locked enabledCssSnippets strip on
    // every commit (the device-local snippet list must never sync), so Plain/Encrypt would
    // silently revert here too.
    const appearancePinned = group.name === "appearance" && this.groups.some((g) => g.name === "enabled-css-snippets");
    const pinnedToFields = group.name === SELF_GROUP_NAME || appearancePinned;
    // An ICON picker, the same shape as the two rows above it (Type, Devices). Mode was the last
    // text chip in this form and read as the odd row out. The glyphs are the mode vocabulary the
    // rest of the product already speaks — `braces` for per-key rules (the keys inside the file
    // decide), `lock` for encrypted — with `file-text` for whole-file, deliberately NOT the `file`
    // that the Type row directly above uses for its own question.
    const chip = controlEl.createSpan({ cls: "config-sync-sharingicon config-sync-card-trigger" });
    const shown = pinnedToFields ? "fields" : current;
    setIcon(chip.createSpan(), MODE_ICON[shown] ?? MODE_ICON.plain);
    chip.setAttribute("aria-label", pinnedToFields
      ? "This item always uses Per-key rules — some of its settings stay on each device"
      : (modes.find((m) => m.id === current)?.label ?? current));
    if (pinnedToFields) {
      chip.addClass("config-sync-dim");
      setTooltip(chip, "This item always uses Per-key rules — some of its settings stay on each device");
      // The ⇕ renders even here: a picker box without it is 14px narrower and this row's glyph
      // would drift out of the column the two rows above sit in (§2.3's constant-layout rule).
      setIcon(chip.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
      return;
    }
    setTooltip(chip, modes.find((m) => m.id === current)?.label ?? current);
    setIcon(chip.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
    const pick = (mode: SyncMode): void => {
      void (async () => {
        // Leaving Per-key rules deletes every configured key rule — confirm instead of
        // silently destroying them (the card surface removes rules one at a time; this menu is
        // the only place they could vanish in bulk). The rule count is read from this.groups at
        // click time, never from the render-time `group` snapshot: per-key edits rebuild only
        // the fields panel, so rules added since this drawer rendered are invisible to `group`.
        const cur = this.groups.find((x) => x.name === group.name) ?? group;
        const rulesDropped = cur.mode === "fields" && mode !== "fields" ? (cur.fields?.length ?? 0) : 0;
        if (rulesDropped > 0 && !(await confirmDropKeyRules(this.app, rulesDropped))) return;
        let fieldsForNewMode: FieldRule[] | undefined;
        if (mode === "fields" && cur.fields === undefined) {
          const scan = this.detections.get(group.name) ?? (await this.host.detectSensitive(group));
          this.detections.set(group.name, scan);
          if (scan.keys.length > 0) fieldsForNewMode = defaultFieldsFromDetection(scan.keys);
        }
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          if (mode === "plain") {
            delete g.mode;
            delete g.fields;
          } else if (mode === "encrypted") {
            g.mode = "encrypted";
            delete g.fields;
          } else {
            g.mode = "fields";
            if (g.fields === undefined && fieldsForNewMode !== undefined) g.fields = fieldsForNewMode;
          }
        }, group.name);
        if (mode === "fields") this.expanded.add(group.name);
        afterChange();
      })();
    };
    this.wireMenuTrigger(chip, () => {
      const menu = new Menu();
      for (const m of modes) {
        if (m.id === "fields" && group.type !== "file") continue;
        menu.addItem((i) => i.setTitle(m.label).setIcon(MODE_ICON[m.id]).setChecked(m.id === current).onClick(() => pick(m.id)));
      }
      return menu;
    });
  }

  // The Advanced per-key editor speaks the card's own grammar (DESIGN.md §4 Advanced rule
  // editor): each pattern is a rule-row scrow with the shared sharing picker (Remove rule as the
  // menu's warning item) and the three-state lock — the single-select action dropdown, which
  // flattened the orthogonal sharing×encrypted pair, does not exist. Below the rows, the File
  // preview (click any key to add a rule); last, the raw pattern input as the glob escape hatch.
  // One file read feeds rows and preview alike; built after the read completes.
  //
  // Per-key edits rebuild ONLY this panel — the refreshCardBody swap (detached build, child
  // swap, File-preview scroll carried across), never a whole-tab refresh(): the tab rebuild
  // re-enters this editor's two-phase async fill, so the page briefly loses the editor's
  // height and visibly collapses/re-expands. A failed save still falls back to refresh(),
  // which is what renders the pinned save-error row outside this panel.
  private renderFieldsEditor(hostEl: HTMLElement, group: SyncGroup): void {
    const panel = hostEl.createDiv({ cls: "config-sync-fields-editor" });
    const rebuild = (): void => {
      const gen = String(Number(panel.dataset.csFieldsGen ?? "0") + 1);
      panel.dataset.csFieldsGen = gen;
      void (async () => {
        const fresh = this.groups.find((g) => g.name === group.name);
        if (fresh === undefined) {
          this.refresh();
          return;
        }
        const { doc } = parseCardDoc(await this.host.readItemFile(fresh));
        if (!panel.isConnected || panel.dataset.csFieldsGen !== gen) return; // tab re-rendered or a newer rebuild superseded this read
        const tmp = createDiv();
        this.buildFieldsEditor(tmp, fresh, doc, (ok) => {
          if (ok) rebuild();
          else this.refresh();
        });
        const prevScroll = panel.querySelector(".config-sync-json-pre")?.scrollTop ?? 0;
        panel.empty();
        while (tmp.firstChild !== null) panel.appendChild(tmp.firstChild);
        if (prevScroll > 0) {
          const pre = panel.querySelector(".config-sync-json-pre");
          if (pre !== null) pre.scrollTop = prevScroll;
        }
      })();
    };
    rebuild();
  }

  private buildFieldsEditor(panel: HTMLElement, group: SyncGroup, doc: Record<string, unknown>, afterChange: (ok: boolean) => void): void {
    const detectedKeys = this.detections.get(group.name)?.keys ?? [];
    const rules = group.fields ?? [];
    const setRuleAt = (ruleIndex: number, mutator: (r: FieldRule) => void): void => {
      void this.commitGroups((draft) => {
        const g = draft.find((x) => x.name === group.name);
        const r = g?.fields?.[ruleIndex];
        if (r !== undefined) mutator(r);
      }, group.name).then(afterChange);
    };
    rules.forEach((rule, ruleIndex) => {
      const isDetected = detectedKeys.some((k) => keyMatchesAny(k, [rule.pattern]));
      const fr = panel.createDiv({ cls: "config-sync-scrow config-sync-card-rulerow" });
      const keyCell = fr.createSpan({ cls: "config-sync-fkey", text: rule.pattern });
      const tag = rule.locked === true ? "preset" : isDetected ? "detected" : "manual";
      keyCell.createSpan({ cls: `config-sync-ftag${isDetected && rule.locked !== true ? " is-detected" : ""}`, text: tag });
      const slots = this.scrowSlots(fr);
      // The appearance group's locked enabledCssSnippets strip (ensureAppearancePresets) isn't
      // an ordinary fixed rule — it exists only to keep the field out of THIS file because
      // it's synced elsewhere, per snippet on the Appearance card. A disabled picker would
      // mislead (implying a choice), so it points at the real control instead.
      if (rule.locked === true && rule.pattern === "enabledCssSnippets") {
        fr.createDiv();
        fr.createDiv({ cls: "config-sync-ldhint", text: "locked — managed per snippet on the Appearance card (Folders → snippets)" });
        return;
      }
      const perElementOn = group.perElement?.[rule.pattern] !== undefined;
      this.renderSharingPicker(slots.device, {
        sharing: rule.sharing,
        options: FIELD_SHARING_OPTIONS,
        disabled: rule.locked === true,
        onChange: (v) =>
          setRuleAt(ruleIndex, (r) => {
            r.sharing = v;
            if (v.kind === "this-device") r.encrypted = false;
          }),
        extras:
          rule.locked === true
            ? []
            : [{
                title: "Remove rule",
                icon: "trash",
                action: () => {
                  void this.commitGroups((draft) => {
                    const g = draft.find((x) => x.name === group.name);
                    if (g === undefined || g.fields === undefined) return;
                    g.fields = g.fields.filter((_, i) => i !== ruleIndex);
                    if (g.fields.length === 0) delete g.fields;
                    if (g.perElement !== undefined) {
                      delete g.perElement[rule.pattern];
                      if (Object.keys(g.perElement).length === 0) delete g.perElement;
                    }
                  }, group.name).then(afterChange);
                },
              }],
      });
      if (rule.locked === true) slots.device.setAttribute("aria-label", "Preset rule — cannot be changed");
      this.renderLockToggle(slots.lock, {
        encrypted: rule.encrypted,
        disabled: rule.locked === true || encryptToggleDisabled(rule.sharing, perElementOn),
        onChange: (v) => setRuleAt(ruleIndex, (r) => (r.encrypted = v)),
      });
      // Per-item device rules for a string-array key — same icon toggle, same mutual exclusion
      // with encryption as the card surface (manifest.ts D3).
      if (isStringArrayValue(doc[rule.pattern])) {
        const pi = slots.aux.createSpan({ cls: `config-sync-perelement-ic${perElementOn ? " is-set" : ""}` });
        setIcon(pi, "list-checks");
        if (rule.encrypted) {
          pi.addClass("config-sync-dim");
          pi.setAttribute("aria-label", PER_ITEM_DISABLED_HINT);
        } else {
          pi.setAttribute("aria-label", `${PER_ELEMENT_RULES_LABEL} — each item gets its own rule`);
          pi.setAttribute("role", "button");
          pi.setAttribute("tabindex", "0");
          const flip = (): void => {
            void this.commitGroups((draft) => {
              const g = draft.find((x) => x.name === group.name);
              if (g === undefined) return;
              if (perElementOn) {
                if (g.perElement !== undefined) {
                  delete g.perElement[rule.pattern];
                  if (Object.keys(g.perElement).length === 0) delete g.perElement;
                }
              } else {
                g.perElement = { ...(g.perElement ?? {}), [rule.pattern]: {} };
                const r = g.fields?.[ruleIndex];
                if (r !== undefined) r.encrypted = false;
              }
            }, group.name).then(afterChange);
          };
          pi.addEventListener("click", flip);
          pi.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              flip();
            }
          });
        }
      }
      if (perElementOn) {
        const elements = isStringArrayValue(doc[rule.pattern]) ? (doc[rule.pattern] as string[]) : [];
        const sharings = group.perElement?.[rule.pattern] ?? {};
        for (const el of buildPerElementRows(elements, sharings)) {
          const r = panel.createDiv({ cls: "config-sync-scrow config-sync-card-elrow" });
          r.createSpan({ cls: "config-sync-card-elname", text: el.element });
          this.renderSharingPicker(this.scrowSlots(r).device, {
            sharing: el.sharing,
            options: FIELD_SHARING_OPTIONS,
            disabled: false,
            onChange: (v) => {
              void this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === group.name);
                if (g === undefined) return;
                const map = { ...(g.perElement?.[rule.pattern] ?? {}) };
                if (v.kind === "everywhere") delete map[el.element];
                else map[el.element] = v;
                g.perElement = { ...(g.perElement ?? {}), [rule.pattern]: map };
              }, group.name).then(afterChange);
            },
          });
        }
      }
    });
    // The File preview — same treatment, same click-to-add as the item card's zone ②.
    this.renderJsonPreviewInto(panel, doc, rules, detectedKeys, group.perElement ?? {}, {
      showHint: true,
      ruleable: () => true,
      onAddRule: (key) => {
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.fields = [...(g.fields ?? []), { pattern: key, sharing: EVERYWHERE, encrypted: SENSITIVE_ENCRYPT_RE.test(key) }];
        }, group.name).then(afterChange);
      },
    });
    const addRow = panel.createDiv({ cls: "config-sync-addrow" });
    const input = addRow.createEl("input", { cls: "config-sync-addrow-input", attr: { placeholder: "Add key pattern… e.g. *Token*" } });
    const addBtn = addRow.createEl("button", { cls: "config-sync-addrow-btn", text: "Add" });
    addBtn.addEventListener("click", () => {
      void (async () => {
        const pattern = input.value.trim();
        if (pattern === "") return;
        const ok = await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.fields = [...(g.fields ?? []), { pattern, ...LOCAL_RULE }];
        }, group.name);
        afterChange(ok);
      })();
    });
  }

  // Builds the full-vault search index: General settings (static registry), the four card tabs'
  // items, Advanced rule/discovered cards, and remotes (desktop only). Unfiltered by query —
  // callers substring-match against name+desc(+path).
  //
  // The card-tab hits are sourced from itemDefs() — the SAME registry data renderItemCard reads
  // (renderRegistryCards filters `this.host.itemDefs()` by section) — and the anchor comes from
  // `itemAnchorId`, the same producer renderItemCard writes with. Sourcing the same data is not
  // enough on its own: any inline re-derivation silently breaks every jump the moment one side
  // spells the key differently. One producer is what actually holds them together.
  private async buildSearchIndex(gen: number): Promise<SearchHit[] | null> {
    if (gen !== this.renderGen) return null;
    const hits: SearchHit[] = [];
    for (const s of GENERAL_SETTINGS) {
      hits.push({ section: "general", kind: "setting", name: s.name, desc: s.desc, anchorId: s.anchorId });
    }
    const tabSection: Record<"obsidian" | "core" | "plugins" | "beta", Section> = {
      obsidian: "obsidian",
      core: "core",
      plugins: "community",
      beta: "beta",
    };
    const tabs: ("obsidian" | "core" | "plugins" | "beta")[] = ["obsidian", "core", "plugins", "beta"];
    for (const tab of tabs) {
      const defs = this.host.itemDefs().filter((d) => d.section === tabSection[tab]);
      for (const def of defs) {
        const path = def.settingsFile?.defaultPath;
        const stateOnly = def.settingsFile !== undefined && def.settingsFile.defaultPath === null;
        hits.push({
          section: tab,
          kind: "item",
          name: def.label,
          desc: [def.description, stateOnly ? "on/off only" : "", path ?? ""].filter((s) => s !== "").join(" "),
          anchorId: itemAnchorId(defRef(def)),
          // §3: the type this item actually has, not a blanket "file". A registry item's own thing
          // is its settings FILE (registry.ts's Item.type) — its companion folders are groups of
          // their own, and no card hit stands for one. A state-only item has no file at all, so it
          // answers NEITHER `type:` word: that is what an absent `item` means to settingTypeValue,
          // and it is more honest than counting an on/off-only plugin as a file.
          item: typeof path === "string" ? { type: "file" } : undefined,
        });
      }
    }
    const reserved = reservedNames(this.host.installedPluginIds());
    for (const g of this.groups) {
      if (g.origin === "discovered") {
        hits.push({
          section: "advanced",
          kind: "discovered",
          name: this.host.displayName(g.name, g.label),
          desc: splitLocation(g.path).rel,
          anchorId: `advanced-rule-${g.name}`,
          // §3/§4: the group's own type — the same field the Sync Center's `type:` reads — and its
          // name, so `section:` can ask which family it belongs to.
          item: { type: g.type },
          groupName: g.name,
        });
        continue;
      }
      // core-plugins/community-plugins are the hidden enablement carriers registry.ts compiles —
      // not reserved names, but still not a generic "Custom rule" a user could edit here.
      if (g.origin !== undefined || reserved.has(g.name) || isSwitchListGroup(g.name)) continue;
      hits.push({
        section: "advanced",
        kind: "rule",
        name: this.host.displayName(g.name, g.label),
        desc: "Custom rule",
        anchorId: `advanced-rule-${g.name}`,
        item: { type: g.type }, // §3: a rule pointing at a folder answers type:folder
        groupName: g.name, // §4: …and section:custom, the family sectionForGroup gives it
      });
    }
    if (Platform.isDesktop) {
      for (const r of this.sources) {
        hits.push({
          section: "sources",
          kind: "remote",
          name: r.name === "" ? "(unnamed)" : r.name,
          desc: r.type === "vault" ? r.storePath : `${r.url}#${r.branch}`,
          anchorId: `remote-${r.name}`,
        });
      }
    }
    return hits;
  }

  private async renderSearchResults(containerEl: HTMLElement, gen: number): Promise<void> {
    const parsed = parseQuery(this.search, SETTING_QUALIFIER_KEYS);
    const text = parsed.text.trim().toLowerCase();
    const index = await this.buildSearchIndex(gen);
    if (index === null) return;
    const matches = index.filter(
      (h) => matchesQualifiers(h, parsed.qualifiers, SETTING_QUALIFIER_RESOLVERS) && `${h.name} ${h.desc}`.toLowerCase().includes(text),
    );

    const sections: SearchHit["section"][] = ["general", "obsidian", "core", "plugins", "advanced", "sources"];
    const visibleSections = Platform.isMobile ? sections.filter((s) => s !== "sources") : sections;
    const countFor = (section: SearchHit["section"] | "all"): number =>
      section === "all" ? matches.length : matches.filter((h) => h.section === section).length;

    if (this.searchSection !== "all" && !visibleSections.includes(this.searchSection)) this.searchSection = "all";

    const pillsEl = containerEl.createDiv({ cls: "config-sync-section-pills" });
    const addPill = (section: SearchHit["section"] | "all", label: string): void => {
      const count = countFor(section);
      const pill = pillsEl.createEl("button", {
        cls: `config-sync-fpill${this.searchSection === section ? " is-active" : ""}${count === 0 ? " is-disabled" : ""}`,
        text: `${label} ${count}`,
      });
      if (count === 0) {
        pill.setAttr("disabled", "true");
        return;
      }
      pill.addEventListener("click", () => {
        this.searchSection = section;
        this.refresh();
      });
    };
    addPill("all", "All");
    for (const section of visibleSections) addPill(section, SECTION_LABEL[section]);

    const filtered = this.searchSection === "all" ? matches : matches.filter((h) => h.section === this.searchSection);
    const listEl = containerEl.createDiv();
    if (filtered.length === 0) {
      listEl.createEl("p", { text: "No matching settings.", cls: "config-sync-empty" });
    } else {
      for (const hit of filtered) this.renderSearchHit(listEl, hit);
    }
    this.renderGroupsError(containerEl);
  }

  private sectionTab(section: SearchHit["section"]): PanelTab {
    return section === "general" ? "general" : section === "advanced" ? "advanced" : section === "sources" ? "sources" : section;
  }

  private renderSearchHit(listEl: HTMLElement, hit: SearchHit): void {
    const row = listEl.createDiv({ cls: "config-sync-hit" });
    const main = row.createDiv({ cls: "config-sync-hit-main" });
    main.createDiv({ cls: "config-sync-hit-name", text: hit.name });
    if (hit.desc.trim() !== "") main.createDiv({ cls: "config-sync-hit-desc", text: hit.desc });
    row.createSpan({ cls: "config-sync-sectiontag", text: SECTION_LABEL[hit.section] });
    row.createSpan({ cls: "config-sync-hit-go", text: "›" });
    row.addEventListener("click", () => this.jumpTo(hit));
  }

  private jumpTo(hit: SearchHit): void {
    void (async () => {
      this.search = "";
      this.searchSection = "all";
      this.activeTab = this.sectionTab(hit.section);
      // Card hits: open the matching card's drawer so the jump lands on visible detail, not just
      // a collapsed row. Both strings come from the one producer pair above — never re-derived
      // here.
      const cardRef = hit.kind === "item" ? refFromItemAnchor(hit.anchorId) : null;
      if (cardRef !== null) this.expanded.add(cardExpandKey(cardRef));
      await this.rerender(0);
      this.highlightAnchor(hit.anchorId);
    })();
  }

  // The one card-anchoring mechanism in this file: scrolls a rendered `data-search-anchor`
  // target into view and flashes the search bar's highlight. Used by jumpTo (search-hit clicks)
  // and by display() (the More bridge's pending anchor) — both land identically. Callers
  // must have already applied whatever state change (activeTab/expanded) and awaited a render.
  private highlightAnchor(anchorId: string): void {
    const target = this.containerEl.querySelector(`[data-search-anchor="${CSS.escape(anchorId)}"]`);
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.addClass("config-sync-search-highlight");
    window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1800);
  }

  private anchor(setting: Setting, anchorId: string): Setting {
    setting.settingEl.setAttribute("data-search-anchor", anchorId);
    return setting;
  }

  // Looks up a General Setting's name/desc/anchorId from the GENERAL_SETTINGS registry, so
  // render call sites and the search index can't drift. Throws on a miss so a future desync
  // between a render call site and the registry fails loudly in dev instead of silently.
  private generalSetting(anchorId: string): GeneralSettingDef {
    const def = GENERAL_SETTINGS.find((s) => s.anchorId === anchorId);
    if (def === undefined) throw new Error(`Config Sync: no GENERAL_SETTINGS entry for anchorId "${anchorId}"`);
    return def;
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    const def = this.generalSetting("general-pkm-mode");
    this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(def.desc),
      "general-pkm-mode"
    ).addDropdown((d) =>
      d
        .addOption("auto", `Auto (detected: ${detected === "ioto" ? "IOTO" : "default"})`)
        .addOption("ioto", "IOTO")
        .addOption("default", "Default")
        .setValue(this.host.settings.pkmMode)
        .onChange(async (v) => {
          if (!this.host.settingsWritable()) return; // §4.2b
          this.host.settings.pkmMode = v as PkmMode;
          await this.host.saveSettings();
          this.loaded = false;
          this.refresh();
        })
    );
  }

  private async renderDataFolder(containerEl: HTMLElement, gen: number): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
    if (gen !== this.renderGen) return;
    const def = this.generalSetting("general-data-folder");
    this.anchor(
      new Setting(containerEl).setName(def.name).setDesc(
        `${def.desc} Leave empty for the recommended location (currently: ${resolved}).`
      ),
      "general-data-folder"
    ).addText((t) => {
      t.setPlaceholder(resolved);
      t.setValue(this.host.settings.rootPath);
      t.onChange(async (v) => {
        const trimmed = v.trim();
        if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
          new Notice(`Config Sync: invalid data folder "${trimmed}" — must be a vault-relative path`);
          return;
        }
        if (!this.host.settingsWritable()) return; // §4.2b
        this.host.settings.rootPath = trimmed;
        await this.host.saveSettings();
      });
      t.inputEl.addEventListener("blur", () => {
        this.loaded = false;
        this.refresh();
      });
    });
  }

  private renderStatusToggles(containerEl: HTMLElement): void {
    const statusInMenu = this.generalSetting("general-status-in-menu");
    this.anchor(
      new Setting(containerEl)
        .setName(statusInMenu.name)
        .setDesc(statusInMenu.desc),
      "general-status-in-menu"
    ).addToggle((t) =>
      t.setValue(this.host.settings.statusInMenu).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        this.host.settings.statusInMenu = v;
        await this.host.saveSettings();
      })
    );
    const remoteAutoCheck = this.generalSetting("general-remote-auto-check");
    this.anchor(
      new Setting(containerEl)
        .setName(remoteAutoCheck.name)
        .setDesc(remoteAutoCheck.desc),
      "general-remote-auto-check"
    ).addToggle((t) =>
      t.setValue(this.host.settings.remoteAutoCheck).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        this.host.settings.remoteAutoCheck = v;
        await this.host.saveSettings();
      })
    );
    const localPeriodicCheck = this.generalSetting("general-local-periodic-check");
    this.anchor(
      new Setting(containerEl)
        .setName(localPeriodicCheck.name)
        .setDesc(localPeriodicCheck.desc),
      "general-local-periodic-check"
    ).addToggle((t) =>
      t.setValue(this.host.settings.localPeriodicCheck).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        this.host.settings.localPeriodicCheck = v;
        await this.host.saveSettings();
      })
    );
  }

  private renderRunHistory(containerEl: HTMLElement): void {
    const s = this.host.settings.runHistory;
    const heading = this.generalSetting("general-run-history");
    this.anchor(new Setting(containerEl).setName(heading.name).setDesc(heading.desc).setHeading(), "general-run-history").addToggle((t) =>
      t.setValue(s.enabled).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        s.enabled = v;
        await this.host.saveSettings();
      })
    );
    const path = this.generalSetting("general-run-history-path");
    this.anchor(new Setting(containerEl).setName(path.name).setDesc(path.desc), "general-run-history-path").addText((t) =>
      t
        .setPlaceholder("{configDir}/plugins/config-sync/run-history.json")
        .setValue(s.path)
        .onChange(async (v) => {
          if (!this.host.settingsWritable()) return; // §4.2b
          s.path = v.trim();
          await this.host.saveSettings();
        })
    );
    const count = this.generalSetting("general-run-history-count");
    this.anchor(new Setting(containerEl).setName(count.name).setDesc(count.desc), "general-run-history-count").addText((t) =>
      t.setValue(String(s.maxCount)).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        const n = Number.parseInt(v, 10);
        s.maxCount = Number.isFinite(n) && n >= 0 ? n : 0;
        await this.host.saveSettings();
      })
    );
    const days = this.generalSetting("general-run-history-days");
    this.anchor(new Setting(containerEl).setName(days.name).setDesc(days.desc), "general-run-history-days").addText((t) =>
      t.setValue(String(s.maxDays)).onChange(async (v) => {
        if (!this.host.settingsWritable()) return; // §4.2b
        const n = Number.parseInt(v, 10);
        s.maxDays = Number.isFinite(n) && n >= 0 ? n : 0;
        await this.host.saveSettings();
      })
    );
    const clear = this.generalSetting("general-run-history-clear");
    this.anchor(new Setting(containerEl).setName(clear.name).setDesc(clear.desc), "general-run-history-clear").addButton((b) =>
      b.setButtonText("Clear history").setWarning().onClick(async () => {
        await this.host.clearRunHistory();
        new Notice("Run history cleared");
      })
    );
  }

  private renderRibbonToggles(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-ribbon-buttons");
    this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(def.desc)
        .setHeading(),
      "general-ribbon-buttons"
    );
    const defs: { key: RibbonKey; label: string }[] = [{ key: "sync", label: "Sync Center" }];
    for (const d of defs) {
      const s = new Setting(containerEl).setName(d.label);
      s.addToggle((t) =>
        t.setValue(this.host.settings.ribbonButtons[d.key]).onChange(async (v) => {
          if (!this.host.settingsWritable()) return; // §4.2b
          this.host.settings.ribbonButtons[d.key] = v;
          await this.host.saveSettings();
          this.host.refreshRibbons();
        })
      );
    }
  }

  private renderStatusBarToggles(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Status bar").setHeading();
    const toggleRow = (anchorId: string, get: () => boolean, set: (v: boolean) => void, after: () => void): void => {
      const def = this.generalSetting(anchorId);
      this.anchor(new Setting(containerEl).setName(def.name).setDesc(def.desc), anchorId).addToggle((t) =>
        t.setValue(get()).onChange(async (v) => {
          if (!this.host.settingsWritable()) return; // §4.2b — covers all four status-bar toggles
          set(v);
          await this.host.saveSettings();
          after();
        })
      );
    };
    toggleRow("general-status-bar-item", () => this.host.settings.statusBarItem, (v) => (this.host.settings.statusBarItem = v), () => this.host.updateStatusIndicators());
    toggleRow("general-status-bar-remote", () => this.host.settings.statusBarRemote, (v) => (this.host.settings.statusBarRemote = v), () => this.host.updateStatusIndicators());
    toggleRow("general-ribbon-dot", () => this.host.settings.ribbonDot, (v) => (this.host.settings.ribbonDot = v), () => this.host.updateStatusIndicators());
    if (Platform.isMobile) {
      toggleRow("general-mobile-status-bar", () => this.host.settings.mobileStatusBar, (v) => (this.host.settings.mobileStatusBar = v), () => this.host.applyMobileStatusBar());
    }
  }

  private renderPassphrase(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-passphrase");
    // Storage-location note, appended at render
    // time like the data-folder suffix — the static desc stays the version-neutral search copy.
    const storageNote = this.host.passphraseKeychainBacked()
      ? "On this device it is stored encrypted in Obsidian's keychain (Settings → Keychain)."
      : "This device's Obsidian is older than 1.12, so it is stored unencrypted in app storage — update Obsidian to keep it in the encrypted keychain.";
    const setting = this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(`${def.desc} ${storageNote}`),
      "general-passphrase"
    );
    setting.settingEl.addClass("config-sync-ppset");
    let draft = "";
    // A fixed badge left of the input — green when set, caution when
    // not.
    this.passphraseStatusEl = setting.controlEl.createSpan({ cls: "config-sync-ppbadge" });
    let setBtn: ButtonComponent | null = null;
    let clearBtn: ExtraButtonComponent | null = null;
    const refreshControls = (): void => {
      this.updatePassphraseStatus();
      setBtn?.setDisabled(draft === ""); // empty input must not silently clear
      clearBtn?.extraSettingsEl.toggle(this.host.passphrase() !== null);
    };
    setting.addText((t) => {
      t.inputEl.type = "password";
      t.setValue("").onChange((v) => {
        draft = v;
        refreshControls();
      });
    });
    setting.addButton((b) => {
      setBtn = b;
      b.setButtonText("Set").onClick(() => {
        if (draft === "") return;
        this.host.setPassphrase(draft);
        draft = "";
        const input = setting.controlEl.querySelector("input");
        if (input !== null) input.value = "";
        new Notice("Passphrase set on this device");
        refreshControls();
      });
    });
    setting.addExtraButton((b) => {
      clearBtn = b;
      b.setIcon("x")
        .setTooltip("Clear the passphrase on this device")
        .onClick(() => {
          this.host.setPassphrase(null);
          new Notice("Passphrase cleared on this device");
          refreshControls();
        });
    });
    setting.controlEl.prepend(this.passphraseStatusEl);
    refreshControls();
  }

  private updatePassphraseStatus(): void {
    if (this.passphraseStatusEl === null) return;
    const set = this.host.passphrase() !== null;
    this.passphraseStatusEl.setText(set ? "✓ Set on this device" : "Not set");
    this.passphraseStatusEl.toggleClass("is-set", set);
    this.passphraseStatusEl.toggleClass("is-unset", !set);
  }

  private renderGroupsReadError(containerEl: HTMLElement): boolean {
    if (this.groupsReadError === null) return false;
    containerEl.createDiv({
      text: `Cannot read your sync configuration — fix the error below, then reopen this tab: ${this.groupsReadError}`,
      cls: "config-sync-form-error",
    });
    return true;
  }

  private renderGroupsError(containerEl: HTMLElement): void {
    this.groupsErrorEl = containerEl.createDiv({ cls: "config-sync-form-error" });
    // Row-pinned (inline) errors are shown on their card; only surface page-level errors here.
    this.groupsErrorEl.setText(this.saveErrorFor === null ? this.groupsErrorMsg : "");
  }

  // A group name/path already spoken for by the registry-derived model: a reserved-name managed
  // group (app/appearance/hotkeys/core/community, from catalog.ts's reservedNames), a plugin-*
  // group with the standard path (a synced plugin item — belongs to Community/Beta even when not
  // installed here), or a switch-list carrier (enabled-css-snippets et al. — managed on the
  // Obsidian tab with their own scope/pins UI). Anything else is a genuine Advanced-tab custom
  // rule or discovered file — see persistCustomItems, which uses this same test to decide what
  // durably belongs in items.custom.
  private isManagedGroup(g: SyncGroup, reserved: ReadonlySet<string>): boolean {
    // The SECTION comes from the group's own ref, never from its name (spec §5): a group that
    // arrived through the STORE and is in neither the defs nor settings.items still carries one —
    // manifest.ts's parseGroup gives every group the ref the legacy rules resolve for it. The path
    // test stays because it answers a different question: a hand-written rule may legitimately be
    // NAMED like a plugin item while pointing somewhere else, and that one is a custom rule.
    const owner = refItemId(g.ref ?? "");
    const syncedPlugin = owner?.section === "community" && g.path === `{configDir}/plugins/${owner.id}/data.json`;
    return reserved.has(g.name) || syncedPlugin || isSwitchListGroup(g.name);
  }

  // Durable write path for the Advanced tab's "Custom rules"/"Discovered files"
  // (spec §6): writing the FULL mutated draft (registry-derived groups
  // included) through the session-only groupsIO/writeGroupsFile route would make a custom rule or
  // an adopted discovered file vanish on the next Obsidian restart. Registry-derived groups are
  // never stored — they're recompiled from settings.items on every load (registry.ts's
  // compileItems) — so only the non-managed subset of `fullDraft` (custom rules + adopted
  // discovered files alike; a discovered-file adoption is just an items.custom entry) gets
  // persisted. Pre-validates through the real compile pipeline (same claimPath accounting
  // compileItems always runs) so a name/path collision surfaces as the existing inline row error
  // via commitDraft's throw→catch, instead of only a passive Notice from the next recompile.
  // The stored custom item a draft row came FROM. By name first; by path when the name has moved,
  // because a rename is the one edit that changes the map key while leaving the item's identity in
  // the store alone — without the fallback, renaming a rule would silently drop every field a
  // newer build wrote onto it. A rename AND a path change in the same commit still
  // loses the tail; there is nothing left to match on, and the Advanced tab commits per field.
  private storedCustomFor(g: SyncGroup): Item | undefined {
    const custom = this.host.settings.items.custom;
    return custom[g.name] ?? Object.values(custom).find((i) => i.path === g.path);
  }

  private async persistCustomItems(fullDraft: SyncGroup[]): Promise<void> {
    // §4.2b — before the items assignment below. THROWN, not returned:
    // commitDraft already keeps the caller's draft whenever this write fails, so raising the
    // refusal here is what stops a refused edit from staying visible in the Advanced tab until
    // Settings is reopened. It also surfaces in the tab's existing inline error slot.
    if (!this.host.settingsWritable()) throw new Error(SCHEMA_FUTURE_NOTICE);
    const reserved = reservedNames(this.host.installedPluginIds());
    const nextCustom: Record<string, Item> = {};
    for (const g of fullDraft) {
      if (g.name.trim() === "" || this.isManagedGroup(g, reserved)) continue;
      // The stored item is handed in as the tail's source: the draft came through
      // validateSyncManifest, whose whitelist parse has already dropped any field a newer build
      // wrote (see customItemFromGroup).
      nextCustom[g.name] = customItemFromGroup(g, this.storedCustomFor(g));
    }
    const nextItems: ItemMap = { ...this.host.settings.items, custom: nextCustom };
    try {
      compileItems(this.host.itemDefs(), { items: nextItems });
    } catch (e) {
      throw new Error(e instanceof CompileError ? e.message : `unexpected error: ${(e as Error).message}`);
    }
    this.host.settings.items = nextItems;
    await this.host.saveSettings();
  }

  private async renderAdvanced(containerEl: HTMLElement, gen: number): Promise<void> {
    const reserved = reservedNames(this.host.installedPluginIds());
    const managed = this.groups.filter((g) => this.isManagedGroup(g, reserved) && g.origin === undefined);
    const custom = this.groups.filter((g) => !this.isManagedGroup(g, reserved) && g.origin === undefined);
    const customized = managed.filter((g) => this.isCustomized(g));

    if (customized.length > 0) {
      new Setting(containerEl)
        .setName(`${customized.length} item${customized.length === 1 ? " uses" : "s use"} a customized rule`)
        .setDesc(`${customized.map((g) => this.host.displayName(g.name, g.label)).join(", ")} — edit each on its own tab.`)
        .addButton((b) =>
          b.setButtonText("Reset all to defaults").onClick(async () => {
            await this.commitGroups((draft) => {
              for (let i = 0; i < draft.length; i++) {
                const g = draft[i];
                if (g === undefined || !reserved.has(g.name) || g.origin !== undefined) continue;
                const def = defaultGroupForName(g.name);
                if (def !== null) draft[i] = def;
              }
            });
            this.refresh();
          })
        );
    }

    new Setting(containerEl)
      .setName("Custom rules")
      .setHeading()
      .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection.");
    const customEl = containerEl.createDiv();
    for (const group of custom) this.renderRuleCard(customEl, group);
    const addRule = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add rule" });
    addRule.addEventListener("click", () => {
      this.groups.push({ name: "", path: "", type: "file", devices: "all" });
      this.expanded.add("");
      this.refresh();
    });

    const discovered = await this.host.listDiscoveredFiles(this.groups);
    if (gen !== this.renderGen) return;
    const discoveredOn = this.groups.filter((g) => g.origin === "discovered");
    if (discovered.length > 0 || discoveredOn.length > 0) {
      new Setting(containerEl)
        .setName("Discovered files")
        .setHeading()
        .setDesc("Config files we found but couldn't classify. Turn one on to start syncing it.");
      const discEl = containerEl.createDiv();
      // ONE stably-sorted list, adopted or not — adoption must change a row's own controls,
      // never its position: two blocks ordered by unrelated keys made a fresh adopt relocate to
      // the top, so the row the user had just clicked appeared to light up a DIFFERENT file.
      const rows: ({ rel: string; on: true; group: SyncGroup } | { rel: string; on: false; file: { name: string; path: string } })[] = [
        ...discoveredOn.map((group) => ({ rel: splitLocation(group.path).rel, on: true as const, group })),
        ...discovered.map((file) => ({ rel: splitLocation(file.path).rel, on: false as const, file })),
      ].sort((a, b) => a.rel.localeCompare(b.rel));
      for (const r of rows) {
        if (r.on) this.renderDiscoveredOnRow(discEl, r.group);
        else this.renderDiscoveredRow(discEl, r.file);
      }
    }
  }

  private renderDiscoveredRow(listEl: HTMLElement, d: { name: string; path: string }): void {
    const row = listEl.createDiv({ cls: "config-sync-row is-static" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(d.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(false).setTooltip("Sync this file").onChange(async (v) => {
      if (!v) return;
      await this.commitGroups((draft) => {
        draft.push({ name: d.name, path: d.path, type: "file", devices: "all", origin: "discovered" });
      }, d.name);
      this.refresh();
    });
    // A refused adopt must say so under its own row — the toggle springing back with the
    // page-level message suppressed (culprit pinning) reads as "nothing happened".
    if (this.saveErrorFor === d.name) {
      listEl.createDiv({ cls: "config-sync-form-error", text: `Couldn't turn this on — ${this.groupsErrorMsg.replace(/\.$/, "")}.` });
    }
  }

  private renderDiscoveredOnRow(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    renderFoldChevron(row, isOpen, null);
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(group.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(true).setTooltip("Stop syncing this file").onChange(async (v) => {
      if (v) return;
      await this.commitGroups((draft) => {
        const idx = draft.findIndex((g) => g.name === group.name);
        if (idx >= 0) draft.splice(idx, 1);
      }, group.name);
      this.expanded.delete(group.name);
      this.refresh();
    });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (this.saveErrorFor === group.name) {
      listEl.createDiv({ cls: "config-sync-form-error", text: `Couldn't save this change — ${this.groupsErrorMsg.replace(/\.$/, "")}.` });
    }
    if (isOpen) this.renderRuleForm(listEl, group, "discovered");
  }

  private renderRuleCard(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    renderFoldChevron(row, isOpen, null);
    row.createSpan({ cls: "config-sync-card-title", text: group.name === "" ? "(unnamed)" : this.host.displayName(group.name, group.label) });
    row.createSpan({ cls: "config-sync-row-path", text: splitLocation(group.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ExtraButtonComponent(row)
      .setIcon("trash")
      .setTooltip("Delete rule")
      .onClick(async () => {
        await this.commitGroups((draft) => {
          const idx = draft.findIndex((g) => g.name === group.name);
          if (idx >= 0) draft.splice(idx, 1);
        }, group.name);
        this.expanded.delete(group.name);
        this.refresh();
      });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (this.saveErrorFor === group.name) {
      // The wrapped message can arrive with or without its own full stop — hence one
      // normalised join instead of two literals colliding into "…changed..".
      listEl.createDiv({ cls: "config-sync-save-error mod-warning", text: `Couldn't save this change — ${this.groupsErrorMsg.replace(/\.$/, "")}.` });
    }
    if (isOpen) this.renderRuleForm(listEl, group, "custom");
  }

  // A VERTICAL scrow form — one field per row (`config-sync-advrow`: label | control).
  // Product-voice placeholders (the name charset lives
  // in the validation error, never the placeholder); the location picker sits INSIDE the path
  // input box; TYPE is an icon picker; DEVICES reuses the panel's sharing picker; MODE speaks
  // the §2.2 display names.
  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "custom" | "discovered"): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand config-sync-advform" });
    let currentName = group.name;
    const advRow = (label: string): HTMLElement => {
      const r = panel.createDiv({ cls: "config-sync-scrow config-sync-advrow" });
      r.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: label });
      return r.createDiv({ cls: "config-sync-advrow-ctl" });
    };

    if (mode === "discovered") {
      // A discovered drawer has no Name/Path inputs, so it must still NAME the file it belongs
      // to — without this line nothing in the card says which row it is attached to.
      advRow("File").createSpan({ cls: "config-sync-row-path", text: splitLocation(group.path).rel });
    }
    if (mode !== "discovered") {
      if (mode === "custom") {
        const nameC = new TextComponent(advRow("Name"));
        nameC.setPlaceholder("e.g. templates").setValue(group.name).onChange(async (v) => {
          const newName = v.trim();
          const from = currentName;
          const ok = await this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === from);
            if (g !== undefined) g.name = newName;
          }, from);
          if (ok) {
            this.expanded.delete(from);
            this.expanded.add(newName);
            currentName = newName;
          }
        });
        nameC.inputEl.addClass("config-sync-rule-name-input");
      }
      // One composite path box: the location mini-menu leads INSIDE the input box,
      // a thin divider, then the borderless relative-path input — pick the base, type the rest.
      const loc = splitLocation(group.path);
      const box = advRow("Path").createDiv({ cls: "config-sync-pathbox" });
      const prefix = box.createSpan({ cls: "config-sync-pathbox-prefix" });
      const LOC_LABELS = { config: "Config folder", vault: "Vault root" } as const;
      prefix.createSpan({ text: LOC_LABELS[loc.location] });
      setIcon(prefix.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
      this.wireMenuTrigger(prefix, () => {
        const menu = new Menu();
        for (const l of ["vault", "config"] as const) {
          menu.addItem((i) =>
            i.setTitle(LOC_LABELS[l]).setChecked(splitLocation(this.groups.find((g) => g.name === currentName)?.path ?? group.path).location === l).onClick(() => {
              // §4.2b/P4: a failed commit pins its message to THIS row, which only paints on a
              // render — refresh on failure only; on success the row repaints via refresh() so
              // the prefix shows the fresh location.
              void this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === currentName);
                if (g !== undefined) g.path = joinLocation(l, splitLocation(g.path).rel);
              }, currentName).then(() => this.refresh());
            })
          );
        }
        return menu;
      });
      box.createSpan({ cls: "config-sync-pathbox-div" });
      const pathC = new TextComponent(box);
      pathC.inputEl.addClass("config-sync-pathbox-input");
      pathC.setPlaceholder("relative path").setValue(loc.rel).onChange((v) => {
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === currentName);
          if (g !== undefined) g.path = joinLocation(splitLocation(g.path).location, v.trim());
        }, currentName).then((ok) => {
          if (!ok) this.refresh(); // §4.2b/P4 — see the location menu above
        });
      });
    }

    // TYPE as an icon picker (no "File" wordmark — icon + tooltip + ⇕ on hover,
    // the panel's one picker idiom).
    const TYPE_META = {
      file: { icon: "file", label: "File", tooltip: "File — syncs a single file" },
      folder: { icon: "folder", label: "Folder", tooltip: "Folder — syncs everything in it" },
    } as const;
    const typeIc = advRow("Type").createSpan({ cls: "config-sync-sharingicon config-sync-adv-typeic" });
    setIcon(typeIc.createSpan(), TYPE_META[group.type].icon);
    // The ⇕ span renders in both states — constant layout is a width promise (§2.3).
    setIcon(typeIc.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
    if (mode === "discovered") {
      // The file fixes name, path AND type — a discovered rule is a file by construction, and a
      // folder reading of a file path only ever fails at run time.
      typeIc.addClass("config-sync-dim");
      typeIc.setAttribute("aria-label", "File — decided by the file itself");
    } else {
      typeIc.setAttribute("aria-label", TYPE_META[group.type].tooltip);
      this.wireMenuTrigger(typeIc, () => {
        const menu = new Menu();
        for (const t of ["file", "folder"] as const) {
          menu.addItem((i) =>
            i.setTitle(TYPE_META[t].label).setIcon(TYPE_META[t].icon).setChecked(group.type === t).onClick(async () => {
              if (t === group.type) return;
              // Flipping away from "file" drops key rules and the encryption mode — confirm
              // instead of silently destroying them. Read from this.groups at click time: the
              // render-time `group` snapshot misses rules added through the fields panel's
              // local rebuilds.
              const cur = this.groups.find((x) => x.name === group.name) ?? group;
              const destructive = cur.mode !== undefined || (cur.fields?.length ?? 0) > 0;
              if (destructive && !(await confirmTypeFlip(this.app, t))) return;
              await this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === group.name);
                if (g === undefined) return;
                g.type = t;
                if (g.type !== "file") {
                  delete g.mode;
                  delete g.fields;
                }
              }, group.name);
              this.refresh();
            })
          );
        }
        return menu;
      });
    }
    this.renderSharingPicker(advRow("Devices"), {
      sharing: group.devices === "all" ? EVERYWHERE : perClass(group.devices),
      options: [EVERYWHERE, perClass("desktop"), perClass("mobile")],
      disabled: false,
      onChange: (v) =>
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g !== undefined) g.devices = sharingClass(v) ?? "all";
        }, group.name).then(() => this.refresh()),
    });
    this.renderModeSegment(advRow("Mode"), group, () => this.refresh());
    const descC = new TextComponent(advRow("Description"));
    descC.setPlaceholder("optional").setValue(group.description ?? "").onChange((v) => {
      const d = v.trim();
      void this.commitGroups((draft) => {
        const g = draft.find((x) => x.name === currentName);
        if (g === undefined) return;
        if (d !== "") g.description = d;
        else delete g.description;
      }, currentName).then((ok) => {
        if (!ok) this.refresh(); // §4.2b/P4 — see the Location dropdown above
      });
    });
    if (group.mode === "fields") {
      this.renderFieldsEditor(panel.createDiv(), group);
    }
    this.renderDetectionNote(panel, group);
  }

  // Advanced-tab rule cards have no ItemDef, so detection state isn't pre-fetched by
  // ensureCardDetection; kick off a scan here too (cached in the same map, keyed by group name).
  private renderDetectionNote(panel: HTMLElement, group: SyncGroup): void {
    const cached = this.detections.get(group.name);
    const noteEl = panel.createDiv({ cls: "config-sync-expand-note" });
    const show = (scan: SensitiveScan): void => {
      if (scan.keys.length === 0 && !scan.blob) return;
      noteEl.setText(scan.blob ? "⚠ This file looks already encrypted — its keys can't be scanned." : `⚠ Sensitive keys detected: ${scan.keys.join(", ")}`);
    };
    if (cached !== undefined) {
      show(cached);
      return;
    }
    void (async () => {
      let scan: SensitiveScan;
      try {
        scan = await this.host.detectSensitive(group);
      } catch {
        return;
      }
      this.detections.set(group.name, scan);
      if (noteEl.isConnected) show(scan);
    })();
  }

  private async commitGroups(mutator: (draft: SyncGroup[]) => void, culprit?: string): Promise<boolean> {
    // A blank "+ Add rule" placeholder (empty name) is in-memory only — persistCustomItems itself
    // filters it out, so a half-created rule can't fail validation and block every other save.
    // Durable write: only the custom/discovered subset of the mutated draft persists
    // (items.custom) — see persistCustomItems.
    const res = await commitDraft(this.groups, mutator, (g) => this.persistCustomItems(g));
    if (res.ok) {
      this.groups = res.groups;
      this.groupsErrorMsg = "";
      this.saveErrorFor = null;
    } else {
      this.groupsErrorMsg = res.error;
      // A culprit of "" is a REAL pin (the unnamed placeholder rule) — only undefined means
      // "no specific row", which is why the no-pin sentinel is null, never "".
      this.saveErrorFor = culprit ?? null;
    }
    // When the error is pinned to a specific row (inline), don't also show it at the page bottom.
    this.groupsErrorEl?.setText(this.saveErrorFor === null ? this.groupsErrorMsg : "");
    return res.ok;
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Remotes")
      .setHeading()
      .setDesc("Sync your settings with another vault or a git repository. Your own devices don't need a remote — your regular vault sync already carries the settings.");
    const listEl = containerEl.createDiv({ cls: "config-sync-sources" });
    this.sourceErrorEls = [];
    this.sources.forEach((draft, index) => {
      this.renderRemoteRow(listEl, draft, index);
      // The per-card error slot sits right under its card (after the expanded form, when open);
      // :empty renders nothing.
      const slot = listEl.createDiv({ cls: "config-sync-form-error" });
      slot.setText(this.sourcesErrorFor === index ? this.sourcesErrorMsg : "");
      this.sourceErrorEls.push(slot);
    });
    this.sourcesErrorEl = containerEl.createDiv({ cls: "config-sync-form-error" });
    this.sourcesErrorEl.setText(this.sourcesErrorFor === null ? this.sourcesErrorMsg : "");
    const addBtn = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add remote" });
    addBtn.addEventListener("click", () => {
      if (!this.host.settingsWritable()) return; // §4.2b/N3: no half-built remote that can never be saved
      this.sources.push({ name: "", type: "vault", storePath: "", url: "", branch: "", subdir: "", excludeSelf: false, tokenId: "", username: "" });
      this.expanded.add("remote:");
      this.refresh();
    });
  }

  private renderRemoteRow(listEl: HTMLElement, draft: RemoteDraft, index: number): void {
    const key = `remote:${draft.name}`;
    const isOpen = this.expanded.has(key);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `remote-${draft.name}`);
    renderFoldChevron(row, isOpen, null);
    const nameSpan = row.createSpan({ cls: "config-sync-rule-name", text: draft.name === "" ? "(unnamed)" : draft.name });
    row.createSpan({ cls: "config-sync-row-type", text: draft.type === "vault" ? "Vault" : "Git" });
    row.createSpan({
      cls: "config-sync-row-path",
      text: draft.type === "vault" ? draft.storePath : draft.url === "" ? "" : `${draft.url}#${draft.branch}`,
    });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ExtraButtonComponent(row)
      .setIcon("trash")
      .setTooltip("Delete remote")
      .onClick(async () => {
        // §4.2b/N3: `this.sources` is what the panel renders, so splicing it on a refused gesture
        // would show the remote as deleted until Settings is reopened — the UI claiming something
        // that did not happen. Refuse before the draft moves. (The Advanced tab gets the same
        // property from commitDraft, which keeps its draft whenever the write fails.)
        if (!this.host.settingsWritable()) return;
        this.sources.splice(index, 1);
        this.expanded.delete(key);
        await this.saveRemotes();
        this.refresh();
      });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
      if (isOpen) this.expanded.delete(key);
      else this.expanded.add(key);
      this.refresh();
    });
    if (isOpen) this.renderRemoteForm(listEl, draft, nameSpan);
  }

  private renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft, nameSpan: HTMLElement): void {
    // The remote editor speaks the Advanced form's grammar — one field per
    // row (advrow, on the wider `config-sync-remrow` label track), TYPE as the panel's text menu
    // picker, Browse inside the path box. Every handler is
    // `draft.x = …; saveRemotes()`. There is no Username input (a linked token is enough —
    // verified against a self-hosted GitLab too); a stored `username` still round-trips
    // through toDraft/toCandidate and still reaches git auth, there is just no input for it.
    const panel = listEl.createDiv({ cls: "config-sync-expand config-sync-advform" });
    const remRow = (label: string, required: boolean): HTMLElement => {
      const r = panel.createDiv({ cls: "config-sync-scrow config-sync-advrow config-sync-remrow" });
      const l = r.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: label });
      if (required) l.createSpan({ cls: "config-sync-required", text: "*" });
      return r.createDiv({ cls: "config-sync-advrow-ctl" });
    };
    // §4.2b/N3: every handler in this form is `draft.x = …; saveRemotes()`, and `this.sources`
    // IS what the panel renders — so a refused gesture must be refused BEFORE the draft moves,
    // or the panel shows an edit that was never saved (the name field below is the plainest
    // case: it renames the row header for a save that never happened).
    const typeChip = remRow("Type", false).createSpan({
      cls: "config-sync-menuchip config-sync-card-trigger",
      text: draft.type === "vault" ? "Another vault" : "Git repository",
    });
    setIcon(typeChip.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
    this.wireMenuTrigger(typeChip, () => {
      const menu = new Menu();
      const types: Array<{ id: RemoteDraft["type"]; label: string }> = [
        { id: "vault", label: "Another vault" },
        { id: "git", label: "Git repository" },
      ];
      for (const t of types) {
        menu.addItem((item) =>
          item
            .setTitle(t.label)
            .setChecked(draft.type === t.id)
            .onClick(async () => {
              if (!this.host.settingsWritable()) return;
              draft.type = t.id;
              await this.saveRemotes();
              this.refresh();
            })
        );
      }
      return menu;
    });
    const nameC = new TextComponent(remRow("Name", true));
    nameC.setPlaceholder("e.g. work-laptop").setValue(draft.name).onChange((v) => {
      if (!this.host.settingsWritable()) return; // §4.2b/N3
      this.expanded.delete(`remote:${draft.name}`);
      draft.name = v.trim();
      this.expanded.add(`remote:${draft.name}`);
      void this.saveRemotes();
      nameSpan.setText(draft.name === "" ? "(unnamed)" : draft.name);
    });
    nameC.inputEl.addClass("config-sync-rule-name-input");

    if (draft.type === "vault") {
      // Browse lives INSIDE the path box (same idea as the Advanced form's location
      // segment), behind a thin divider.
      const box = remRow("Store path", true).createDiv({ cls: "config-sync-pathbox" });
      const pathC = new TextComponent(box);
      pathC.setPlaceholder("/path/to/other-vault/…/config-sync").setValue(draft.storePath).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.storePath = v.trim();
        void this.saveRemotes();
      });
      if (Platform.isDesktop) {
        box.createDiv({ cls: "config-sync-pathbox-div" });
        new ExtraButtonComponent(box).setIcon("folder-open").setTooltip("Browse…").onClick(() => void this.browseStorePath(draft));
      }
    } else {
      let strip: HTMLElement | null = null;
      const clearStrip = (): void => {
        if (strip) {
          strip.setText("");
          strip.className = "config-sync-test-strip";
        }
      };
      new TextComponent(remRow("URL", true)).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.url = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      new TextComponent(remRow("Branch", true)).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.branch = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      new TextComponent(remRow("Store folder in repo", false)).setPlaceholder("empty = repo root").setValue(draft.subdir).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.subdir = v.trim();
        void this.saveRemotes();
      });
      // Obsidian's own secret picker owns the token end to end: its button opens the keychain
      // modal to link or create a secret, shows the linked one masked (click to reveal) and
      // offers the ✕ that unlinks it. What it hands back — and all this plugin ever keeps — is
      // the secret's NAME, which rides along in the synced settings; the value stays in each
      // device's keychain, never read here and never written here.
      const tokenControl = remRow("Access token", false).createDiv({ cls: "config-sync-secret-control" });
      // The standing explanation lives on the control, never a row of its own — the row-shaped
      // version spent an empty 150px label track plus two wrapped lines pushing Test connection
      // down (DESIGN.md §4 Remote editor).
      setTooltip(tokenControl, TOKEN_LINK_HINT);
      tokenControl.setAttribute("aria-label", TOKEN_LINK_HINT);
      const tokenC = new SecretComponent(this.app, tokenControl);
      // The status row exists only while it has something to say (✓ stored / ⚠ not linked
      // here); the default state renders no row at all.
      const statusRow = remRow("", false);
      const statusEl = statusRow.createDiv({ cls: "config-sync-token-status" });
      const paintTokenStatus = (): void => {
        const held = draft.tokenId !== "" && this.app.secretStorage.listSecrets().includes(draft.tokenId);
        const rowEl = statusRow.parentElement; // remRow returns the control cell; its parent is the grid row
        if (rowEl !== null) rowEl.toggle(draft.tokenId !== "");
        statusEl.className =
          "config-sync-token-status" + (held ? " is-ok" : draft.tokenId !== "" ? " is-warning" : "");
        statusEl.setText(
          held
            ? "✓ Token stored on this device."
            : draft.tokenId !== ""
              ? `⚠ This remote uses a token named "${draft.tokenId}", which this device doesn't have yet — link it here once.`
              : ""
        );
      };
      tokenC.setValue(draft.tokenId);
      paintTokenStatus();
      // The picker reports null when the user unlinks, which the typings spell as string.
      tokenC.onChange((name: string | null) => {
        if (!this.host.settingsWritable()) {
          tokenC.setValue(draft.tokenId); // §4.2b/N3: put the picker back — the link never happened
          return;
        }
        if (name === PASSPHRASE_SECRET_ID) {
          new Notice("Config Sync's own vault passphrase is stored under that name — pick or create a different secret for this remote.");
          tokenC.setValue(draft.tokenId);
          return;
        }
        draft.tokenId = name ?? "";
        void this.saveRemotes();
        paintTokenStatus();
      });
      if (Platform.isDesktop) {
        const btn = new ButtonComponent(remRow("", false)).setButtonText("Test connection");
        strip = panel.createDiv({ cls: "config-sync-test-strip" });
        btn.onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing…");
          writeTestStrip(strip!, "is-testing", "Contacting remote…", null);
          try {
            const { gitLsRemote } = await import("../external/gitSource");
            let auth: GitAuth | null;
            try {
              const candidate: Remote = { name: draft.name, type: "git", url: draft.url, branch: draft.branch };
              if (draft.tokenId !== "") candidate.tokenId = draft.tokenId;
              if (draft.username !== "") candidate.username = draft.username;
              auth = resolveGitToken(this.app.secretStorage, candidate);
            } catch (e) {
              writeTestStrip(strip!, "is-error", `✗ ${(e as Error).message}`, null);
              return;
            }
            const res = await gitLsRemote(draft.url, draft.branch, auth);
            if (res.kind === "error") {
              // Headline says what happened and what to do; git's own words go on the second,
              // quieter line rather than into the sentence the reader has to parse first.
              writeTestStrip(strip!, "is-error", "✗ Could not reach this remote. Check the URL, then try again.", res.message);
            } else if (res.branchFound) {
              writeTestStrip(strip!, "is-ok", `✓ Reachable. Branch ${draft.branch} found.`, null);
            } else {
              writeTestStrip(strip!, "is-caution", `Reachable, but branch "${draft.branch}" was not found.`, null);
            }
          } finally {
            btn.setDisabled(false).setButtonText("Test connection");
          }
        });
      }
    }
    const selfLine = panel.createDiv({ cls: "config-sync-remote-selfline" });
    const selfText = selfLine.createDiv({ cls: "config-sync-remote-selftext" });
    selfText.createDiv({ cls: "config-sync-remote-selfname", text: "Keep Config Sync's own settings out of this remote" });
    selfText.createDiv({ cls: "config-sync-remote-selfdesc", text: "For a vault that keeps its own setup: Pull and Push skip Config Sync's settings, and the comparison stops reporting them." });
    new ToggleComponent(selfLine).setValue(draft.excludeSelf).onChange((v) => {
      if (!this.host.settingsWritable()) return; // §4.2b/N3
      draft.excludeSelf = v;
      void this.saveRemotes();
    });
  }

  private async browseStorePath(draft: RemoteDraft): Promise<void> {
    // §4.2b: a flow that will be refused refuses before it opens. This one opens the OS folder
    // picker and then, sometimes, a second modal to choose among the stores it found — the most
    // expensive "and then we declined" in the plugin.
    if (!this.host.settingsWritable()) return;
    try {
      const { pickFolder } = await import("../external/pickFolder");
      const picked = await pickFolder();
      if (picked === null) return;
      const { findStoreDirs } = await import("../external/localPath");
      const dirs = await findStoreDirs(picked);
      const apply = (p: string): void => {
        draft.storePath = p;
        void this.saveRemotes();
        this.refresh();
      };
      const first = dirs[0];
      if (dirs.length === 1 && first !== undefined) {
        apply(first);
      } else if (dirs.length === 0) {
        apply(picked);
        new Notice("No store found here yet — Pull needs the other vault to Capture first; Push will initialize a store at this path.");
      } else {
        new FolderSelectModal(this.app, dirs, apply).open();
      }
    } catch (e) {
      new Notice(`Config Sync: ${(e as Error).message}`);
    }
  }

  // Which remote a validation error belongs to: the first prefix of the candidate list that
  // fails is the culprit (the full-list message keeps the true numbering; a single-element
  // re-validation would renumber "#N" to "#1").
  private remoteErrorCulprit(candidates: unknown[]): number | null {
    for (let i = 0; i < candidates.length; i++) {
      try {
        validateRemotes(candidates.slice(0, i + 1));
      } catch {
        return i;
      }
    }
    return null;
  }

  private async saveRemotes(): Promise<void> {
    if (!this.host.settingsWritable()) return; // §4.2b
    const candidates = this.sources.map(toCandidate);
    try {
      this.host.settings.remotes = validateRemotes(candidates);
      await this.host.saveSettings();
      // A remote's url/branch/subdir/storePath may just have changed — never let a later compare
      // reuse a reader built from the pre-edit coordinates.
      this.host.clearReaderCache();
      this.sourcesErrorMsg = "";
      this.sourcesErrorFor = null;
    } catch (e) {
      this.sourcesErrorMsg = (e as Error).message;
      this.sourcesErrorFor = this.remoteErrorCulprit(candidates);
    }
    // Live update (no re-render): the culprit card's slot carries the message, every other slot
    // and the page-level element go empty (:empty hides them).
    this.sourceErrorEls.forEach((el, i) => el.setText(this.sourcesErrorFor === i ? this.sourcesErrorMsg : ""));
    this.sourcesErrorEl?.setText(this.sourcesErrorFor === null ? this.sourcesErrorMsg : "");
  }
}
