import { refItemId } from "../core/itemKeys";
import { App, ButtonComponent, DropdownComponent, ExtraButtonComponent, Menu, Notice, Platform, Plugin, PluginSettingTab, Scope, SearchComponent, SecretComponent, Setting, setIcon, setTooltip, TextComponent, ToggleComponent } from "obsidian";
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
  Remote,
  RibbonKey,
  Section,
  Sharing,
  sharingClass,
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
  withItem,
} from "../core/registry";
import { SCHEMA_FUTURE_NOTICE } from "../core/settingsMigration";
import { FolderSelectModal } from "./FolderSelectModal";
import { confirmPresetPathChange } from "./ConfirmModal";
import { commitDraft } from "./commitGroups";
import { classifyJsonKeys, classifyPerElementLines, jsonElementClass, jsonKeyClass, KeyClass } from "./jsonView";
import { renderSharingCycle } from "./sharingCycle";
import { DeviceElementState } from "../core/deviceElements";
import { RuleListId } from "../core/enablementRules";
import { enablementRowModel, FOLLOWS_LABEL, OFF_HERE_LABEL, ON_HERE_LABEL, RULE_OPTIONS } from "./enablementRow";
import {
  applyPerElementToggle,
  applySyncAll,
  buildCompanionRows,
  buildPerElementRows,
  Badge,
  buildRuleRows,
  buildSnippetMemberRows,
  CompanionRowModel,
  companionConflictError,
  companionNameConflictError,
  computeBadges,
  DEFAULT_ENABLED_ON_LABEL,
  DEFAULT_FIELD_RULE,
  DESKTOP_ONLY_ALL_NOTE,
  ENABLED_CSS_SNIPPETS_KEY,
  encryptToggleDisabled,
  ENCRYPT_DISABLED_PERITEM_HINT,
  FIELD_SHARING_OPTIONS,
  FieldRowModel,
  FILE_SHARING_OPTIONS,
  FOLDER_MEMBER_HINT,
  hasEnablementZone,
  hasKeyRules,
  isStringArrayValue,
  memberCountLabel,
  normalizeCompanionPath,
  PER_ITEM_DISABLED_HINT,
  PER_ELEMENT_RULES_LABEL,
  PREVIEW_LEGEND_ENTRIES,
  sectionAllEnabled,
  settingsFileZoneKind,
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
  validateCompanionBasename,
  validateCompanionPath,
  withSnippetSharing,
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
    // Unified-card model (spec 2026-07-25-unified-card-design.md §6): the Obsidian tab's card
    // renderer reads/writes these fields directly, durably, through saveSettings() (which
    // persists AND recompiles — see main.ts).
    // Every section, custom items included: the Advanced tab's "Custom rules"/"Discovered files"
    // are items.custom entries, read/written through the same durable contract.
    items: ItemMap;
  };
  saveSettings(): Promise<void>;
  // False while this device's data.json was written by a newer Config Sync (spec
  // 2026-08-11-data-model-hardening.md §4.2b). Every writer in this file is mutate-then-save, and
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
  // Drops the per-refresh reader cache (#3): call after settings.remotes changes so a stale
  // reader for an edited/removed remote's old URL/branch/subdir/storePath is never reused.
  clearReaderCache(): void;
  // The registry's item defs (registry.ts's buildItemDefs, rebuilt by main.ts on every
  // recompile) — the unified-card renderer's only source of which cards exist.
  itemDefs(): ItemDef[];
  // The Sync Center More bridge's pending target (main.ts's openSettingsAt), read-and-cleared:
  // null on a normal Settings open, else the item ref whose card render() should expand and
  // scroll to once, this open only.
  consumePendingSettingsAnchor(): ItemRef | null;
  // Basenames (no extension) of .css files actually present under the vault's snippets/ folder —
  // feeds the Appearance card's snippets companion member rows (spec §4/§5).
  listSnippetFiles(): Promise<string[]>;
  // Immediate child file/folder names of an arbitrary companion path (task-7-brief.md) — feeds
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

// ── The item card's derived keys — ONE producer each (fix round 3, NEW-I2) ──────────────────
//
// A card row carries a `data-search-anchor` and its drawer is keyed in `expanded`. Four places
// need those two strings: the card renderer that WRITES the anchor, the search index that emits
// one to jump to, the More bridge's anchor consumer, and jumpTo's derivation of the drawer key
// from an anchor. Every one of them used to build the strings inline from `def.id`, and they
// agreed only because they happened to spell it the same way.
//
// They stopped agreeing the moment the card sites moved to `defRef(def)` (v3: a card's identity is
// its ItemRef) and the search index was left on `def.id` — `item-dataview` never matched
// `item-community/dataview`, so `highlightAnchor` returned silently and EVERY item hit in EVERY
// section stopped jumping. The comment on buildSearchIndex records that the same divergence had
// already been fixed once before, from the other direction.
//
// A derived key with four authors will diverge again on the next rename. These are its only
// authors now, and `refFromItemAnchor` is the single inverse so jumpTo cannot re-derive it by
// hand either.
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

const SENSITIVE_ENCRYPT_RE = /apikey|api_key|token|secret|password|credential/i;

function defaultFieldsFromDetection(keys: string[]): FieldRule[] {
  return keys.map((pattern) => ({ pattern, ...(SENSITIVE_ENCRYPT_RE.test(pattern) ? ENCRYPT_RULE : LOCAL_RULE) }));
}

// Path row lock/sharing disabled tooltip (spec 2026-07-26-card-visual-refresh-design.md §5, exact) —
// shown whenever the card has any per-key rule (hasKeyRules): the whole-file sharing/encrypt row
// hands control to the per-key rows below it.
const PER_KEY_RULES_ACTIVE_HINT = "Per-key rules are active — remove them to control the whole file again";

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

// Legacy single-select 5-way action, kept only as an adapter for the still-mutually-exclusive
// dropdowns below (Task 5 replaces these with the real sharing+encrypted card controls). Round-trips
// exactly the mapping in the task brief: strip<->local/false, encrypt<->all/true,
// desktop<->desktop/false, mobile<->mobile/false, all<->all/false (inert default).
type LegacyFieldAction = "strip" | "encrypt" | "desktop" | "mobile" | "all";
const LOCAL_RULE: Pick<FieldRule, "sharing" | "encrypted"> = { sharing: THIS_DEVICE, encrypted: false };
const ENCRYPT_RULE: Pick<FieldRule, "sharing" | "encrypted"> = { sharing: EVERYWHERE, encrypted: true };

function legacyActionFromRule(r: Pick<FieldRule, "sharing" | "encrypted">): LegacyFieldAction {
  if (r.sharing.kind === "this-device") return "strip";
  if (r.encrypted) return "encrypt";
  return sharingClass(r.sharing) ?? "all";
}

function legacyRuleFromAction(action: LegacyFieldAction): Pick<FieldRule, "sharing" | "encrypted"> {
  switch (action) {
    case "strip": return LOCAL_RULE;
    case "encrypt": return ENCRYPT_RULE;
    case "desktop": return { sharing: perClass("desktop"), encrypted: false };
    case "mobile": return { sharing: perClass("mobile"), encrypted: false };
    case "all": return { sharing: EVERYWHERE, encrypted: false };
  }
}

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
  { id: "beta", label: "Beta", icon: "flask-conical" }, // BRAT's own BratIcon when registered (定稿)
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
// way in both boxes. NO alias for v2's `scope:`: a key this set doesn't know is free text, so a
// typed `scope:core` searches for those literal words instead of quietly filtering.
//
// Here `section` names the settings AREA — this panel's own tabs — where the Sync Center's names an
// item family. The overlap is deliberate (`obsidian`/`core`/`community` mean the same items in
// both); the extras are the areas that hold no items at all: `general` and `remotes`, plus
// `advanced`, which is where custom rules and discovered files live in this panel.
//
// `custom` is the one word that is a family here rather than an area (§4): it was answerable in the
// Sync Center and not here, so the same word meant different things depending on which box you were
// typing in — the exact defect the one-vocabulary release set out to remove. An Advanced-tab rule
// now answers both words; `advanced` still means that tab, its own non-item settings included.
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

// Every settingsFile write funnels through here (spec 2026-07-26-card-visual-refresh-design.md
// §3.1 "自动切换") so the stored `mode` is never a user choice — it's re-derived from the rules/
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
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";
  private saveErrorFor = "";
  private detections = new Map<string, SensitiveScan>(); // group name -> live scan, filled in as reads complete
  private passphraseStatusEl: HTMLElement | null = null;
  private betaAutoScanned = false; // one automatic index re-scan per panel lifetime
  private customPathEditing = new Set<string>(); // UI-transient: zone ② "Custom path" inputs open but not yet committed
  private addingCompanion = new Set<string>(); // UI-transient: zone ③ "+ Add folder" inputs open
  private companionPathEditing = new Set<string>(); // UI-transient: zone ③ rows mid path-edit ("def.id::path")
  private previewOpen = new Set<string>(); // UI-transient: zone ② "File preview" disclosure open this session, keyed by def.id
  private membersOpen = new Set<string>(); // UI-transient: zone ③ member-list disclosure open this session, keyed "def.id:path" (spec 2026-07-26-card-visual-refresh-design.md §4)
  // In-place refresh hooks for enable toggles: a per-card toggle rebuilds only the section "Sync
  // all" headers, and "Sync all" rebuilds only the cards — never rerender(), whose
  // containerEl.empty() + async rebuild visibly flashes and drops the panel mid-scroll.
  private syncAllRebuilds: (() => void)[] = []; // cleared each rerender
  private cardHosts: { wrap: HTMLElement; def: ItemDef }[] = []; // cleared each rerender

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
    this.saveErrorFor = "";
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
    const ref = this.host.consumePendingSettingsAnchor();
    if (ref === null) return null;
    const parsed = parseItemRef(ref);
    if (parsed === null) return null;
    // defForRef, never `d.section === parsed.section` (fix round 2, NEW-I1): a BRAT-managed
    // plugin's def PRESENTS as `beta` while its ref stores `community`, so the raw comparison
    // never matched and every beta card's "More ▸ opens Settings" landed on the Advanced tab
    // with a dead anchor. Both sides go through storageSection exactly once in there.
    const def = defForRef(this.host.itemDefs(), ref);
    if (def !== undefined) {
      this.activeTab = SECTION_TAB[def.section];
      this.expanded.add(cardExpandKey(ref));
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

  // Beta tab header (定稿 mockup v2): what the tab is, the map-note line with the resolve
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
    const note = new Setting(containerEl).setName(`Matched from BRAT's beta list · ${status.resolved} of ${status.total} repos resolved`);
    note.settingEl.addClass("config-sync-beta-mapnote");
    note.addExtraButton((b) =>
      b
        .setIcon("rotate-cw")
        .setTooltip("Re-scan BRAT's list")
        .onClick(async () => {
          await this.host.refreshBratIndex();
          this.refresh();
        })
    );
    if (status.resolved < status.total && !this.betaAutoScanned) {
      this.betaAutoScanned = true;
      void this.host.refreshBratIndex().then(() => this.refresh());
    }
  }

  // ── Unified card renderer — every ItemDef section (spec §4/§5, task-5/6-brief.md) ──────────
  // One renderer for every ItemDef: name + badges + sync toggle + chevron on the row, a drawer
  // with a Settings file zone (and, for Appearance, a Companion folders zone). Reads/writes
  // settings.items directly through host.saveSettings() — durable, recompiles. The Advanced
  // tab's custom-rule/discovered-file editor (below) is durable the same way, through
  // items.custom (persistCustomItems).

  private itemOf(def: ItemDef): Item {
    return itemFor(this.host.settings.items, def);
  }

  // The card's two enablement layers, for the badges and the `Default enabled on` row — null for a
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
    if (withSyncAll && defs.length > 0) {
      containerEl.createDiv({
        cls: "config-sync-section-sub",
        text: section === "core" ? "Each plugin syncs its settings and on/off state." : "Each plugin syncs its files, settings and on/off state.",
      });
      this.renderSyncAllRow(containerEl, defs);
    }
    // Cards render in def order — buildItemDefs already alphabetizes each section (spec §4).
    // No sensitive-first reordering: it broke the dictionary order users scan by (round-6 bug ②).
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
    const chevron = createSpan({ cls: "config-sync-row-chevron" });
    const syncExpansion = (): void => {
      const open = this.expanded.has(expKey);
      setIcon(chevron, open ? "chevron-down" : "chevron-right");
      const existing = row.settingEl.querySelector(":scope > .config-sync-item-exp");
      if (open && existing === null) this.renderCardExpansion(row.settingEl, wrap, def);
      else if (!open && existing !== null) existing.remove();
    };
    chevron.addEventListener("click", () => {
      if (this.expanded.has(expKey)) this.expanded.delete(expKey);
      else this.expanded.add(expKey);
      syncExpansion();
    });
    row.nameEl.prepend(chevron);
    for (const badge of computeBadges(def, item, this.enablementOf(def))) this.renderBadge(row.nameEl, badge);
    row.addToggle((t) =>
      t.setValue(item.synced).onChange(async (v) => {
        await this.updateItem(def, (c) => ({ ...c, synced: v }));
        this.refreshCardBadges(wrap, def);
        for (const rebuild of this.syncAllRebuilds) rebuild();
      })
    );
    syncExpansion();
  }

  // In-place header badge refresh — value-only config changes (sharing, encrypt, enablement)
  // update the count badges without rebuilding the card, so the panel never visibly jumps.
  private refreshCardBadges(wrap: HTMLElement, def: ItemDef): void {
    const nameEl = wrap.querySelector(":scope > .setting-item > .setting-item-info > .setting-item-name");
    if (!(nameEl instanceof HTMLElement)) return;
    for (const b of Array.from(nameEl.querySelectorAll(".config-sync-card-badge"))) b.remove();
    for (const badge of computeBadges(def, this.itemOf(def), this.enablementOf(def))) this.renderBadge(nameEl, badge);
  }

  private renderBadge(nameEl: HTMLElement, badge: Badge): void {
    const el = nameEl.createSpan({ cls: `config-sync-card-badge ${badge.cls}` });
    if (badge.icon !== undefined) setIcon(el.createSpan({ cls: "config-sync-card-badge-ic" }), badge.icon);
    el.appendText(badge.text);
    if (badge.tooltip !== undefined) setTooltip(el, badge.tooltip);
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

  // In-place path-row refresh for hasKeyRules flips (round-7 spec §1): the row sits outside
  // refreshCardBody's swap target, and the full renderItemCard previously used here collapsed
  // the card around its async file read — the panel visibly jumped and the File preview lost its
  // scroll position. The error element is the row's own next sibling (renderSettingsFileZone
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
    // companionHost is its own stable container (mirrors zone ②'s bodyHost) so a member-list
    // expand/collapse can refresh just zone ③ (refreshCompanionZone) without rebuilding the whole
    // card — badges, the path row, and zone ②'s own disclosure state stay untouched.
    const companionHost = exp.createDiv({ cls: "config-sync-card-companionzonehost" });
    this.renderCompanionZone(companionHost, def, item, wrap);
  }

  // Zone ① `Default enabled on` (spec §6.5) — core/community/beta plugin cards only. Same name,
  // same values, same data as the Sync Center's row of that name: this used to be a 4-stop cycle
  // whose first three stops wrote `runsOn.device` and whose fourth wrote `thisDeviceItems`, i.e.
  // one control with two destinations. Now it is two controls, one per layer, each with one writer.
  // Grid row (spec 2026-07-26-card-visual-refresh-design.md §2.1/§4 Step 1): label in the content
  // column, both segments in the sharing column, last two columns empty.
  private renderDefaultEnabledOnRow(exp: HTMLElement, def: ItemDef, wrap: HTMLElement): void {
    const enablement = def.enablement;
    if (enablement === undefined) return;
    const list = enablement.list;
    const elementId = enablement.element;
    const row = exp.createDiv({ cls: "config-sync-grid config-sync-card-fieldrow" });
    row.createDiv({ cls: "config-sync-explabel config-sync-explabel-inline", text: DEFAULT_ENABLED_ON_LABEL });
    const cell = row.createDiv({ cls: "config-sync-tworow" });
    const build = (): void => {
      cell.empty();
      const rule = this.host.enablementRuleFor(list, elementId);
      const exception = this.host.deviceElementFor(list, elementId);
      const model = enablementRowModel({ rule, exception });
      const after = (): void => {
        build();
        this.refreshCardBadges(wrap, def);
      };
      // Fleet segment: the cycle idiom the card already teaches (renderSharingCycle), over the four
      // rule values. A desktop-only plugin still drops the mobile stop — mobile can never install it.
      renderSharingCycle(cell.createDiv(), {
        sharing: rule,
        options: def.desktopOnly === true ? RULE_OPTIONS.filter((o) => o.kind !== "per-class" || o.class !== "mobile") : RULE_OPTIONS,
        disabled: false,
        ...(def.desktopOnly === true && rule.kind === "everywhere" ? { note: DESKTOP_ONLY_ALL_NOTE } : {}),
        onChange: (v) => void this.host.setEnablementRule(list, elementId, v).then(after),
      });
      cell.createSpan({ cls: "config-sync-tworow-vline" });
      // Local segment. A class rule that this device does not match has nothing true to show as a
      // local state, so it shows the default sentence — but the menu stays live, because an
      // exception outranks a class rule (spec §5 precedence 1) and a row that cannot be excepted
      // would be a dead end.
      const local = cell.createSpan({
        cls: `config-sync-tworow-seg is-local${model.localIsException ? " is-set" : ""}`,
        attr: { role: "button", tabindex: "0", "aria-label": model.local.label },
      });
      if (model.local.icon !== null) setIcon(local.createSpan({ cls: "config-sync-tworow-ic" }), model.local.icon);
      local.createSpan({ text: model.local.label });
      const openLocalMenu = (x: number, y: number): void => {
        const menu = new Menu();
        // "Follows the default" is absent when there is no shared answer to follow (spec §6.5,
        // case 3): with `Each device decides`, every device's own state IS the answer.
        if (rule.kind !== "this-device") {
          menu.addItem((i) => i.setTitle(FOLLOWS_LABEL).setChecked(exception === null).onClick(() => void this.host.followTheDefault(list, elementId).then(after)));
        }
        menu.addItem((i) => i.setTitle(ON_HERE_LABEL).setIcon("power").setChecked(exception === "on").onClick(() => void this.host.setDeviceElement(list, elementId, "on").then(after)));
        menu.addItem((i) => i.setTitle(OFF_HERE_LABEL).setIcon("power-off").setChecked(exception === "off").onClick(() => void this.host.setDeviceElement(list, elementId, "off").then(after)));
        menu.showAtPosition({ x, y });
      };
      local.addEventListener("click", (e) => {
        e.stopPropagation();
        openLocalMenu(e.clientX, e.clientY);
      });
      local.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        const r = local.getBoundingClientRect();
        openLocalMenu(r.left, r.bottom);
      });
    };
    build();
    row.createDiv(); // state column — empty
    row.createDiv(); // action column — empty
  }

  private renderSettingsFileZone(exp: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    exp.createDiv({ cls: "config-sync-explabel", text: "Settings file" });
    const kind = settingsFileZoneKind(def);
    if (kind === "none") return;
    if (kind === "state-only") {
      const expectedFile = def.section === "core" ? corePluginFile(def.id) : "its settings file";
      exp.createDiv({ cls: "config-sync-expdesc", text: stateOnlyHint(def.label, expectedFile) });
      return;
    }
    const pathRow = exp.createDiv({ cls: "config-sync-card-sfhead config-sync-grid" });
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

  // Zone ② path row = the grid's first row (spec 2026-07-26-card-visual-refresh-design.md §2/§3):
  // path | scope ▾ | lock icon | ✎. Locked (dim, disabled) whenever the card has any per-key rule —
  // per-key state owns scope/encrypt then, not the whole-file row (spec §3.1). fileRule read/write
  // below is moved VERBATIM from the old Plain-mode row (same normalization, only the shape moved).
  private renderSettingsFilePathRow(row: HTMLElement, errorEl: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const defaultPath = def.settingsFile!.defaultPath!;
    const current = item.path ?? defaultPath;
    const committed = item.path !== undefined;
    const key = this.customPathEditingKey(def);
    // The path text itself is the edit entry point (round-6 定稿: the ✎ pencil and the ↺ reset
    // icon are gone) — a committed custom path shows as accented text like any other, and
    // "Reset to default" becomes a text action inside the edit state.
    const editing = this.customPathEditing.has(key);
    const locked = hasKeyRules(item);

    const pathHost = row.createDiv({ cls: "config-sync-card-pathhost" });
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

    const sharingCell = row.createDiv();
    const rule = item.settingsFile?.fileRule ?? { sharing: EVERYWHERE, encrypted: false };
    // The mutator MUST read the rule fresh inside updateItem (not the render-time `rule` above),
    // and the row MUST rebuild itself after the write: this row lives outside refreshCardBody's
    // swap target, so without the rebuild the lock/scope controls keep replaying their stale
    // render-time value — a lock click after the first one re-sends the same boolean forever
    // ("encrypted can never be turned off", round-6 bug ①).
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
    renderSharingCycle(sharingCell, {
      sharing: rule.sharing,
      options: FILE_SHARING_OPTIONS,
      disabled: locked,
      onChange: (v) => setFileRule((r) => ({ ...r, sharing: v as FileSharing })),
    });

    const lockCell = row.createDiv();
    this.renderLockToggle(lockCell, { encrypted: rule.encrypted, disabled: locked, onChange: (v) => setFileRule((r) => ({ ...r, encrypted: v })) });

    if (locked) {
      for (const cell of [sharingCell, lockCell]) {
        cell.addClass("config-sync-dim");
        cell.setAttribute("aria-label", PER_KEY_RULES_ACTIVE_HINT);
      }
    }

    row.createDiv({ cls: "config-sync-card-actioncell" }); // action column — empty (path edits via the path text)
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
    // Every registry item's settingsFile carries a preset default path (task-7-brief.md), so
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
  // row (per-key encrypt) — also the interface Task 3's rows reuse. Tooltip/aria reflect only the
  // CURRENT boolean (`Encrypt` / `Encrypted`); a disabled reason, if any, is the caller's job to
  // surface (the caller owns the surrounding cell, which may need a DIFFERENT disabled reason —
  // per-key-rules-active for the path row, per-item-scopes for a rule row).
  private renderLockToggle(cell: HTMLElement, opts: { encrypted: boolean; disabled: boolean; onChange: (v: boolean) => void }): void {
    const icon = cell.createSpan({ cls: `config-sync-lock${opts.encrypted ? " is-on" : ""}` });
    setIcon(icon, "lock");
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

  // Decides whether zone ②'s body needs a file read at all (spec §4 "渐进披露"): a card with no
  // per-key rules AND a collapsed preview never reads the file — rule rows are empty either way
  // (buildRuleRows needs no live doc to return []) and there's nothing else to show. Every other
  // combination reads once and renders rule rows + the preview disclosure off-DOM before swapping
  // into `host` in one shot, so refreshCardBody never flashes an empty body while the read is in
  // flight.
  private renderCardBodyInto(host: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const open = this.previewOpen.has(def.id);
    // Per-host generation token: rapid successive writes (scope-icon cycling) fire overlapping
    // async reads below, and without this the EARLIER read resolving LAST would swap a stale
    // body over the fresh one (R4 backlog ③). Only the newest call may complete the swap; the
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
      // preview back to the first line (round-7 spec §1, bug 3).
      const prevScroll = host.querySelector(".config-sync-json-pre")?.scrollTop ?? 0;
      host.empty();
      while (tmp.firstChild !== null) host.appendChild(tmp.firstChild);
      if (prevScroll > 0) {
        const pre = host.querySelector(".config-sync-json-pre");
        if (pre !== null) pre.scrollTop = prevScroll;
      }
    })();
  }

  // Rule rows list ONLY configured keys (buildRuleRows) — browsing the file's full key set is
  // File preview's job now (spec §3.1). Nothing renders when there are none.
  private renderRuleRows(bodyEl: HTMLElement, def: ItemDef, item: Item, doc: Record<string, unknown>, wrap: HTMLElement): void {
    const rows = buildRuleRows(def, item, doc);
    if (rows.length === 0) return;
    const panel = bodyEl.createDiv({ cls: "config-sync-card-fields" });
    for (const row of rows) this.renderRuleRow(panel, def, item, row, doc, wrap);
  }

  private renderRuleRow(panel: HTMLElement, def: ItemDef, item: Item, row: FieldRowModel, doc: Record<string, unknown>, wrap: HTMLElement): void {
    const fr = panel.createDiv({ cls: "config-sync-grid config-sync-card-rulerow" });
    // Content cell holds the key AND (for array keys) the Per-item toggle — the grid has exactly
    // four columns, so a fifth direct child would auto-place onto a wrapped second line.
    const contentCell = fr.createDiv({ cls: "config-sync-card-rulecontent" });
    contentCell.createSpan({ cls: "config-sync-fkey", text: row.key });
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
    renderSharingCycle(fr.createDiv(), {
      sharing: row.rule.sharing,
      options: FIELD_SHARING_OPTIONS,
      disabled: false,
      onChange: (v) => setRule((r) => ({ ...r, sharing: v, encrypted: v.kind === "this-device" ? false : r.encrypted })),
    });
    const lockCell = fr.createDiv();
    const lockDisabled = encryptToggleDisabled(row.rule.sharing, row.perElementEnabled);
    this.renderLockToggle(lockCell, { encrypted: row.rule.encrypted, disabled: lockDisabled, onChange: (v) => setRule((r) => ({ ...r, encrypted: v })) });
    if (lockDisabled && row.perElementEnabled) {
      lockCell.setAttribute("aria-label", ENCRYPT_DISABLED_PERITEM_HINT);
    }
    const actionCell = fr.createDiv({ cls: "config-sync-card-actioncell" });
    const removeBtn = new ExtraButtonComponent(actionCell).setIcon("x").setTooltip("Remove rule").onClick(() => {
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
          // scope/lock controls (spec §3.1) — refreshed in place (round-7 spec §1; the full
          // re-render used before jumped the panel and left the dim state stale on other paths).
          this.refreshPathRow(wrap, def);
        }
        this.refreshCardBadges(wrap, def);
        this.refreshCardBody(wrap, def);
      })();
    });
    removeBtn.extraSettingsEl.addClass("config-sync-ghost");
    if (row.isArray) {
      const piWrap = contentCell.createDiv({ cls: "config-sync-card-perelement" });
      // MUST-FIX 2 (final-review): Encrypt and Per-item scopes are mutually exclusive on the same
      // rule (manifest.ts D3) — enabling Per-item here clears `encrypted` in the SAME write
      // (applyPerElementToggle), and the toggle itself renders disabled while the rule is already
      // encrypted (the lock icon above renders disabled the other way — see
      // encryptToggleDisabled) so the UI can never produce the combination the compiler rejects.
      const piToggle = new ToggleComponent(piWrap).setValue(row.perElementEnabled).onChange((v) => {
        void (async () => {
          await this.updateItem(def, (c) => ({
            ...c,
            settingsFile: withDerivedMode(applyPerElementToggle(c.settingsFile ?? defaultSettingsFile(), row.key, v)),
          }));
          this.refreshCardBadges(wrap, def);
          this.refreshCardBody(wrap, def);
        })();
      });
      piToggle.setDisabled(row.rule.encrypted);
      if (row.rule.encrypted) piToggle.setTooltip(PER_ITEM_DISABLED_HINT);
      piWrap.createSpan({ cls: "config-sync-card-perelement-label", text: PER_ELEMENT_RULES_LABEL });
    }
    if (row.isArray && row.perElementEnabled) {
      const elements = isStringArrayValue(doc[row.key]) ? (doc[row.key] as string[]) : [];
      const sharings = item.settingsFile?.perElement[row.key] ?? {};
      for (const el of buildPerElementRows(elements, sharings)) this.renderPerElementRow(panel, def, row.key, el.element, el.sharing, wrap);
    }
  }

  // Array-key element row, indented under its rule row (spec §3.1 "保留现交互", reshaped into the
  // grid: element name | scope | empty | empty).
  private renderPerElementRow(panel: HTMLElement, def: ItemDef, key: string, element: string, sharing: Sharing, wrap: HTMLElement): void {
    const r = panel.createDiv({ cls: "config-sync-grid config-sync-card-elrow" });
    r.createSpan({ cls: "config-sync-card-elname", text: element });
    const sharingCell = r.createDiv();
    // refreshCardBody below rebuilds these element rows, so the icon re-reads the fresh sharing.
    renderSharingCycle(sharingCell, {
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
  // inert/encrypt-looking default rule, exactly like the old per-group JSON preview did.
  private async addRuleForKey(def: ItemDef, key: string): Promise<void> {
    const rule: ItemFieldRule = { sharing: EVERYWHERE, encrypted: SENSITIVE_ENCRYPT_RE.test(key) };
    await this.updateItem(def, (c) => {
      const sf = c.settingsFile ?? defaultSettingsFile();
      return { ...c, settingsFile: withDerivedMode({ ...sf, rules: { ...sf.rules, [key]: rule } }) };
    });
    this.expanded.add(cardExpandKey(defRef(def)));
  }

  // Progressive disclosure (spec §4): collapsed by default, `previewOpen` is UI-transient
  // (session-only, mirrors the drawer's own `expanded` set). Expanding is the only thing that can
  // trigger the file read this row's content depends on — a card already read for its rule rows
  // (renderCardBodyInto) reuses that same read, it is never repeated.
  private renderPreviewDisclosure(bodyEl: HTMLElement, def: ItemDef, item: Item, doc: Record<string, unknown>, fileState: CardFileState, wrap: HTMLElement): void {
    const open = this.previewOpen.has(def.id);
    const toggleRow = bodyEl.createDiv({ cls: "config-sync-card-disclosure" });
    toggleRow.setText(`${open ? "▾" : "▸"} File preview`);
    toggleRow.setAttribute("role", "button");
    toggleRow.setAttribute("tabindex", "0");
    const toggle = (): void => {
      if (this.previewOpen.has(def.id)) this.previewOpen.delete(def.id);
      else this.previewOpen.add(def.id);
      this.refreshCardBody(wrap, def);
    };
    toggleRow.addEventListener("click", toggle);
    toggleRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    if (!open) return;
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
    const pre = bodyEl.createEl("pre", { cls: "config-sync-json-pre" });
    const detectedKeys = this.detections.get(def.id)?.keys ?? [];
    const rules: FieldRule[] = Object.entries(item.settingsFile?.rules ?? {}).map(([pattern, r]) => ({ pattern, ...r }));
    const raw = JSON.stringify(doc, null, 2);
    const classByKey = new Map<string, KeyClass>();
    for (const kc of classifyJsonKeys(raw, rules, detectedKeys)) classByKey.set(kc.key, kc);
    const perElementLines = classifyPerElementLines(raw, item.settingsFile?.perElement ?? {});
    const rawLines = raw.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const m = /^(\s{2})"([^"]+)":\s?(.*)$/.exec(line);
      const key = m?.[2];
      const kc = key !== undefined ? classByKey.get(key) : undefined;
      if (m !== null && key !== undefined && kc !== undefined) {
        pre.createSpan({ text: m[1] });
        const kspan = pre.createSpan({ cls: `config-sync-json-key ${jsonKeyClass(kc)}`, text: `"${key}"` });
        // An encrypted rule marks its key with the same lucide lock the rest of the panel uses
        // (round-7 spec §2 — the old emoji suffix is gone).
        if (kc.state.encrypted) setIcon(kspan.createSpan({ cls: "config-sync-json-lock" }), "lock");
        if (kc.state.sharing === null) {
          kspan.addEventListener("click", () => {
            void this.addRuleForKey(def, key).then(() => {
              // Adding a rule can flip hasKeyRules -> true, which dims the path row's own
              // scope/lock controls (spec §3.1) — refreshed in place (round-7 spec §1; the full
              // re-render used before reset this preview's scroll to the top, round-7 bug 3).
              this.refreshPathRow(wrap, def);
              this.refreshCardBadges(wrap, def);
              this.refreshCardBody(wrap, def);
            });
          });
        }
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
  // header and no rows, just the Add-folder entry point below.
  private renderCompanionZone(exp: HTMLElement, def: ItemDef, item: Item, wrap: HTMLElement): void {
    const rows = buildCompanionRows(def, item);
    if (rows.length > 0) exp.createDiv({ cls: "config-sync-explabel", text: "Companion folders" });
    const listEl = exp.createDiv({ cls: "config-sync-card-companions" });
    for (const row of rows) {
      const key = this.companionMemberKey(def, row);
      const open = this.membersOpen.has(key);
      const countEl = this.renderCompanionRow(listEl, def, row, wrap);
      // Synchronous per-row anchor: the async member scans below resolve in arbitrary order, so
      // they must land in a host reserved DIRECTLY under their own folder row — appending to
      // listEl would file one folder's members under whichever row happened to render last.
      const membersHost = listEl.createDiv({ cls: "config-sync-card-memberhost" });
      const mapKey = def.presetCompanions?.find((p) => p.path === row.path)?.mapKey;
      if (mapKey === ENABLED_CSS_SNIPPETS_KEY) {
        void (async () => {
          const files = await this.host.listSnippetFiles();
          const perElement = item.settingsFile?.perElement[ENABLED_CSS_SNIPPETS_KEY] ?? {};
          if (!membersHost.isConnected) return; // the drawer closed while the scan was in flight
          this.renderSnippetMembers(membersHost, def, buildSnippetMemberRows(files, perElement), wrap, countEl, open);
        })();
      } else {
        // Plain (non-mapKey) companion: list-only member names, no per-member scope chip — the
        // switch-list engine only knows community-plugins.json, core-plugins.json and
        // enabledCssSnippets today, so an arbitrary folder group has no per-file sharing
        // mechanism to wire a chip to (task-7-brief.md; see uc-task-7-report.md). isThemesPreset
        // (spec §4's "· N themes" vs "· N files") is true only for a preset row with no mapKey —
        // today that is exactly the Appearance card's themes/ preset, never a plain user folder.
        const isThemesPreset = row.isPreset && mapKey === undefined;
        void (async () => {
          const files = await this.host.listCompanionFiles(row.path);
          if (!membersHost.isConnected) return;
          this.renderPlainCompanionMembers(membersHost, files, countEl, open, isThemesPreset);
        })();
      }
    }
    this.renderAddCompanionRow(exp, def, wrap);
  }

  private companionEditKey(def: ItemDef, path: string): string {
    return `${defRef(def)}::${path}`;
  }

  // Member-list collapse key (spec 2026-07-26-card-visual-refresh-design.md §4 Step 3) — UI-
  // transient. Double-colon separator matches companionEditKey: an item ref itself contains a
  // single slash, so "::" keeps the join unambiguous.
  private companionMemberKey(def: ItemDef, row: CompanionRowModel): string {
    return `${defRef(def)}::${row.path}`;
  }

  private refreshCompanionZone(wrap: HTMLElement, def: ItemDef): void {
    const host = wrap.querySelector(".config-sync-card-companionzonehost");
    if (!(host instanceof HTMLElement)) return;
    host.empty();
    this.renderCompanionZone(host, def, this.itemOf(def), wrap);
  }

  private toggleCompanionMembers(wrap: HTMLElement, def: ItemDef, key: string): void {
    if (this.membersOpen.has(key)) this.membersOpen.delete(key);
    else this.membersOpen.add(key);
    this.refreshCompanionZone(wrap, def);
  }

  // Folder row = the grid's row for one companion (spec §2.1/§4 Step 2/3): name + member count
  // (patched in once the async scan below resolves) + ▸/▾ in the content column | scope ▾ | small
  // toggle | ✎ (every row) with ✕ ADDITIONALLY for a user-added row (never for a preset — D8: a
  // preset is only ever relocated via the warning-gated path edit, never removed outright). Returns
  // the count span so renderCompanionZone's async scan can patch it in place; null while this row
  // is mid path-edit (renderCompanionPathEditRow owns the DOM then, nothing here to patch).
  private renderCompanionRow(listEl: HTMLElement, def: ItemDef, row: CompanionRowModel, wrap: HTMLElement): HTMLElement | null {
    const editKey = this.companionEditKey(def, row.path);
    if (this.companionPathEditing.has(editKey)) {
      this.renderCompanionPathEditRow(listEl, def, row, wrap, editKey);
      return null;
    }
    const r = listEl.createDiv({ cls: "config-sync-grid config-sync-card-companiongrid" });
    const memberKey = this.companionMemberKey(def, row);
    const open = this.membersOpen.has(memberKey);
    const contentCell = r.createDiv({ cls: "config-sync-card-foldercontent" });
    contentCell.setAttribute("role", "button");
    contentCell.setAttribute("tabindex", "0");
    // The folder name itself is the path-edit entry point (round-6 定稿: the ✎ pencil is gone) —
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
    const countEl = contentCell.createSpan({ cls: "config-sync-card-membercount" });
    contentCell.createSpan({ cls: "config-sync-card-memberarrow", text: open ? "▾" : "▸" });
    const toggle = (): void => this.toggleCompanionMembers(wrap, def, memberKey);
    contentCell.addEventListener("click", toggle);
    contentCell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
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
    // itself from a locally-tracked value after each advance. A companion folder syncs as a
    // whole, so its axis is the device class, not a per-key sharing.
    const deviceCell = r.createDiv();
    let curDevice = row.device;
    const buildDevice = (): void => {
      deviceCell.empty();
      renderSharingCycle(deviceCell, {
        sharing: curDevice === "all" ? EVERYWHERE : perClass(curDevice),
        options: COMPANION_DEVICE_OPTIONS.map((d) => (d === "all" ? EVERYWHERE : perClass(d))),
        disabled: false,
        onChange: (v) => {
          curDevice = sharingClass(v) ?? "all";
          updateCompanion((c) => ({ ...c, device: curDevice }));
          buildDevice();
        },
      });
    };
    buildDevice();
    new ToggleComponent(r).setValue(row.enabled).onChange((v) => updateCompanion((c) => ({ ...c, enabled: v })));
    const actionCell = r.createDiv({ cls: "config-sync-card-actioncell" });
    if (!row.isPreset) {
      const removeBtn = new ExtraButtonComponent(actionCell).setIcon("x").setTooltip("Remove folder").onClick(() => {
        void (async () => {
          await this.updateItem(def, (c) => ({ ...c, companions: (c.companions ?? []).filter((x) => x.path !== row.path) }));
          this.renderItemCard(wrap, def);
        })();
      });
      removeBtn.extraSettingsEl.addClass("config-sync-ghost");
    }
    return countEl;
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
        // MUST-FIX 1 (final-review): reject a basename that would never survive
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
        // user-added folder has no preset identity to move away from, so its own ✎ (now offered
        // on every companion row, spec 2026-07-26-card-visual-refresh-design.md §4 Step 2) commits
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
    // listener, so stopPropagation can't help). Deferred in round 6b (spec §3), closed out here.
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
  // countEl once the scan resolves — collapsed or not — but the member rows + hint themselves only
  // render while `open` (and there is anything to show).
  private renderPlainCompanionMembers(listEl: HTMLElement, files: string[], countEl: HTMLElement | null, open: boolean, isThemesPreset: boolean): void {
    const names = sortCompanionMemberNames(files);
    countEl?.setText(memberCountLabel(isThemesPreset, names.length));
    if (!open || names.length === 0) return;
    const wrapEl = listEl.createDiv({ cls: "config-sync-card-snippetmembers" });
    for (const name of names) {
      wrapEl.createDiv({ cls: "config-sync-grid config-sync-card-companiongrid", text: name });
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
      // MUST-FIX 1 (final-review): reject a basename that would never survive
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

  // Progressive disclosure (spec §4 Step 3): count always patches into countEl; member rows +
  // hint only render while `open`. Snippets are never the themes preset, so memberCountLabel's
  // first argument is always false here.
  private renderSnippetMembers(listEl: HTMLElement, def: ItemDef, rows: SnippetMemberRow[], wrap: HTMLElement, countEl: HTMLElement | null, open: boolean): void {
    countEl?.setText(memberCountLabel(false, rows.filter((r) => r.fileExists).length));
    if (!open || rows.length === 0) return;
    const wrapEl = listEl.createDiv({ cls: "config-sync-card-snippetmembers" });
    for (const row of rows) {
      const r = wrapEl.createDiv({ cls: `config-sync-grid config-sync-card-companiongrid${row.fileExists ? "" : " is-orphan"}` });
      // The grid is a fixed 4-column track (content | sharing | state | action) — the pill and the
      // Forget button must live INSIDE the content cell, or every later cell shifts one column
      // over and the button wraps onto an implicit second grid row.
      const contentCell = row.fileExists ? r : r.createDiv({ cls: "config-sync-orphancell" });
      contentCell.createSpan({ cls: "config-sync-ldname", text: row.name });
      if (!row.fileExists) contentCell.createSpan({ cls: "config-sync-orphanpill", text: "file deleted" });
      const sharingCell = r.createDiv();
      let curSharing = row.sharing;
      const buildSharing = (): void => {
        sharingCell.empty();
        renderSharingCycle(sharingCell, {
          sharing: curSharing,
          options: FIELD_SHARING_OPTIONS,
          disabled: false,
          onChange: (v) => {
            void (async () => {
              const hadKeyRules = hasKeyRules(this.itemOf(def));
              await this.updateItem(def, (c) => ({
                ...c,
                settingsFile: withDerivedMode(withSnippetSharing(c.settingsFile ?? defaultSettingsFile(), row.name, v)),
              }));
              if (hasKeyRules(this.itemOf(def)) !== hadKeyRules) {
                // The first ruled snippet (false -> true) or the last cleared one (true -> false,
                // withSnippetSharing's empty-map pruning) flips hasKeyRules, which (un)dims the
                // path row's own sharing/lock controls (spec §3.1) — refreshed in place (round-7
                // spec §1; the full card re-render used before made the panel jump on 2 of every 4
                // cycle clicks, round-7 bug 1).
                this.refreshPathRow(wrap, def);
              }
              curSharing = v;
              buildSharing(); // member rows live in the companion zone — nothing below rebuilds them
              this.refreshCardBadges(wrap, def);
              this.refreshCardBody(wrap, def); // per-element sharing colors the enabledCssSnippets elements in File preview (when expanded)
            })();
          },
        });
      };
      buildSharing();
      r.createDiv(); // state column — empty for a snippet member row
      r.createDiv(); // action column — empty for a snippet member row (Forget lives in the content cell: a text button cannot fit the 28px track)
      if (!row.fileExists) {
        const forget = contentCell.createEl("button", { cls: "config-sync-orphan-forget", text: "Forget" });
        forget.addEventListener("click", () => {
          forget.disabled = true; // the rebuild below replaces the row — no re-enable path needed
          void (async () => {
            const hadKeyRules = hasKeyRules(this.itemOf(def));
            await this.updateItem(def, (c) => ({
              ...c,
              settingsFile: withDerivedMode(withSnippetSharing(c.settingsFile ?? defaultSettingsFile(), row.name, EVERYWHERE)),
            }));
            if (hasKeyRules(this.itemOf(def)) !== hadKeyRules) this.refreshPathRow(wrap, def);
            // The row leaves the union — rebuild the member zone in place (fresh file list +
            // fresh perElement), then the badge/body refreshes the sharing cycle already does.
            const files = await this.host.listSnippetFiles();
            if (!listEl.isConnected) return; // the drawer closed while the scan was in flight
            const perElement = this.itemOf(def).settingsFile?.perElement[ENABLED_CSS_SNIPPETS_KEY] ?? {};
            listEl.empty();
            this.renderSnippetMembers(listEl, def, buildSnippetMemberRows(files, perElement), wrap, countEl, open);
            this.refreshCardBadges(wrap, def);
            this.refreshCardBody(wrap, def);
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
    const modes: { id: SyncMode; label: string }[] = [
      { id: "plain", label: "Plain" },
      { id: "fields", label: "Fields" },
      { id: "encrypted", label: "Encrypt" },
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
    const dd = new DropdownComponent(controlEl);
    for (const m of modes) {
      if (m.id === "fields" && group.type !== "file") continue;
      // A pinned item can only ever be Fields, so it offers no other choice to revert to.
      if (pinnedToFields && m.id !== "fields") continue;
      dd.addOption(m.id, m.label);
    }
    dd.setValue(pinnedToFields ? "fields" : current);
    if (pinnedToFields) {
      dd.setDisabled(true);
      dd.selectEl.setAttribute("title", "This item always uses Fields mode — some of its settings stay on each device");
    }
    dd.onChange((v) => {
      const mode = v as SyncMode;
      void (async () => {
        let fieldsForNewMode: FieldRule[] | undefined;
        if (mode === "fields" && group.fields === undefined) {
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
    });
  }

  private renderFieldsEditor(hostEl: HTMLElement, group: SyncGroup, afterChange: () => void): void {
    const panel = hostEl.createDiv({ cls: "config-sync-fields-editor" });
    const detectedKeys = this.detections.get(group.name)?.keys ?? [];
    const rules = group.fields ?? [];
    for (const rule of rules) {
      const isDetected = detectedKeys.some((k) => keyMatchesAny(k, [rule.pattern]));
      const fr = panel.createDiv({ cls: "config-sync-fieldrow" });
      if (rule.locked === true) {
        const lock = fr.createSpan({ cls: "config-sync-flock", attr: { "aria-label": "Preset rule — cannot be removed" } });
        setIcon(lock, "lock");
      }
      fr.createSpan({ cls: "config-sync-fkey", text: rule.pattern });
      fr.createSpan({ cls: `config-sync-ftag${isDetected ? " is-detected" : ""}`, text: isDetected ? "detected" : "manual" });
      fr.createDiv({ cls: "config-sync-rule-spacer" });
      // The appearance group's locked enabledCssSnippets strip (ensureAppearancePresets) isn't
      // an ordinary fixed-action rule — it exists only to keep the field out of THIS file because
      // it's synced elsewhere, per snippet on the Appearance card. A disabled "This device"
      // dropdown would mislead (implying a choice), so it points at the real control instead.
      const isSnippetPointer = rule.locked === true && rule.pattern === "enabledCssSnippets";
      if (isSnippetPointer) {
        fr.createSpan({ cls: "config-sync-ldhint", text: "locked — managed per snippet on the Appearance card (Companion folders → snippets)" });
      } else {
        const dd = new DropdownComponent(fr.createDiv({ cls: "config-sync-act" }));
        dd.addOption("strip", "This device")
          .addOption("encrypt", "Encrypted")
          .addOption("desktop", "Desktop only")
          .addOption("mobile", "Mobile only")
          .setValue(legacyActionFromRule(rule) === "all" ? "strip" : legacyActionFromRule(rule))
          .onChange((v) => {
            void (async () => {
              const ruleIndex = rules.indexOf(rule);
              await this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === group.name);
                const r = g?.fields?.[ruleIndex];
                if (r !== undefined) Object.assign(r, legacyRuleFromAction(v as LegacyFieldAction));
              }, group.name);
              afterChange();
            })();
          });
        // Locked preset rules are fixed to their action (ensureSelfPresets would revert any
        // change on commit anyway) — disable the dropdown so the UI matches the data.
        if (rule.locked === true) {
          dd.setDisabled(true);
          dd.selectEl.setAttribute("title", "Preset rule — action is fixed");
        }
        if (sharingClass(rule.sharing) !== null) {
          fr.createSpan({ cls: "config-sync-ldhint", text: "each class keeps its own value" });
        }
      }
      if (rule.locked === true) {
        fr.createSpan({ cls: "config-sync-fieldrow-xspacer" }); // keep Strip/Encrypt aligned with unlocked rows
      } else {
        new ExtraButtonComponent(fr)
          .setIcon("x")
          .setTooltip("Remove rule")
          .onClick(() => {
            void (async () => {
              const ruleIndex = rules.indexOf(rule);
              await this.commitGroups((draft) => {
                const g = draft.find((x) => x.name === group.name);
                if (g === undefined || g.fields === undefined) return;
                g.fields = g.fields.filter((_, i) => i !== ruleIndex);
                if (g.fields.length === 0) delete g.fields;
              }, group.name);
              afterChange();
            })();
          });
      }
    }
    const addRow = panel.createDiv({ cls: "config-sync-addrow" });
    const input = addRow.createEl("input", { cls: "config-sync-addrow-input", attr: { placeholder: "Add key pattern… e.g. *Token*" } });
    const addBtn = addRow.createEl("button", { cls: "config-sync-addrow-btn", text: "Add" });
    addBtn.addEventListener("click", () => {
      void (async () => {
        const pattern = input.value.trim();
        if (pattern === "") return;
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.fields = [...(g.fields ?? []), { pattern, ...LOCAL_RULE }];
        }, group.name);
        afterChange();
      })();
    });
  }

  // Builds the full-vault search index: General settings (static registry), the four card tabs'
  // items, Advanced rule/discovered cards, and remotes (desktop only). Unfiltered by query —
  // callers substring-match against name+desc(+path).
  //
  // The card-tab hits are sourced from itemDefs() — the SAME registry data renderItemCard reads
  // (renderRegistryCards filters `this.host.itemDefs()` by section) — and the anchor comes from
  // `itemAnchorId`, the same producer renderItemCard writes with. Sourcing the same data was never
  // enough on its own: this line has now diverged from the renderer TWICE (first sectionsFor's
  // CatalogItem.name vs def.id, then def.id vs defRef), and both times every jump silently
  // no-opped. One producer is what actually holds them together.
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
      // never reserved names any more (the aggregate rows they used to back are gone, spec §7 item
      // 1), but still not a generic "Custom rule" a user could edit here.
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
      // here, which is how the two used to drift apart.
      const cardRef = hit.kind === "item" ? refFromItemAnchor(hit.anchorId) : null;
      if (cardRef !== null) this.expanded.add(cardExpandKey(cardRef));
      await this.rerender(0);
      this.highlightAnchor(hit.anchorId);
    })();
  }

  // The one card-anchoring mechanism in this file: scrolls a rendered `data-search-anchor`
  // target into view and flashes the search bar's highlight. Used by jumpTo (search-hit clicks)
  // and by display() (the More bridge's pending anchor, C-#11) — both land identically. Callers
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
    // Storage-location note (spec 2026-07-27-passphrase-keychain-design.md), appended at render
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
    // 定稿 feedback-trio.html: a fixed badge left of the input — green when set, caution when
    // not — replaces the old unstyled status tail buried in the description.
    this.passphraseStatusEl = setting.controlEl.createSpan({ cls: "config-sync-ppbadge" });
    let setBtn: ButtonComponent | null = null;
    let clearBtn: ExtraButtonComponent | null = null;
    const refreshControls = (): void => {
      this.updatePassphraseStatus();
      setBtn?.setDisabled(draft === ""); // empty input must not silently clear (确认 2026-07-16)
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
    containerEl.createEl("p", {
      text: `Cannot read your sync configuration — fix the error below, then reopen this tab: ${this.groupsReadError}`,
      cls: "mod-warning",
    });
    return true;
  }

  private renderGroupsError(containerEl: HTMLElement): void {
    this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    // Row-pinned (inline) errors are shown on their card; only surface page-level errors here.
    this.groupsErrorEl.setText(this.saveErrorFor === "" ? this.groupsErrorMsg : "");
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

  // Durable write path for the Advanced tab's "Custom rules"/"Discovered files" (task-8 concern
  // fix, spec §6 addition): the old path wrote the FULL mutated draft (registry-derived groups
  // included) through the session-only groupsIO/writeGroupsFile route, so a custom rule or an
  // adopted discovered file vanished on the next Obsidian restart. Registry-derived groups are
  // never stored — they're recompiled from settings.items on every load (registry.ts's
  // compileItems) — so only the non-managed subset of `fullDraft` (custom rules + adopted
  // discovered files alike; a discovered-file adoption is just an items.custom entry) gets
  // persisted. Pre-validates through the real compile pipeline (same claimPath accounting
  // compileItems always runs) so a name/path collision surfaces as the existing inline row error
  // via commitDraft's throw→catch, instead of only a passive Notice from the next recompile.
  // The stored custom item a draft row came FROM. By name first; by path when the name has moved,
  // because a rename is the one edit that changes the map key while leaving the item's identity in
  // the store alone — without the fallback, renaming a rule would silently drop every field a
  // newer build wrote onto it (fix round 2). A rename AND a path change in the same commit still
  // loses the tail; there is nothing left to match on, and the Advanced tab commits per field.
  private storedCustomFor(g: SyncGroup): Item | undefined {
    const custom = this.host.settings.items.custom;
    return custom[g.name] ?? Object.values(custom).find((i) => i.path === g.path);
  }

  private async persistCustomItems(fullDraft: SyncGroup[]): Promise<void> {
    // §4.2b — before the items assignment below. THROWN, not returned (round-4 review N3):
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
      // wrote (2.21.0 invariant II.1 — see customItemFromGroup).
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
      for (const group of discoveredOn) this.renderDiscoveredOnRow(discEl, group);
      for (const d of discovered) this.renderDiscoveredRow(discEl, d);
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
  }

  private renderDiscoveredOnRow(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
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
    if (isOpen) this.renderRuleForm(listEl, group, "discovered");
  }

  private renderRuleCard(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
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
      // The trailing "The change was reverted." is gone (§4.2b copy ruling): the §4.1 refusal this
      // now also carries already ends with "Nothing has been changed," which says it better, and
      // the sentence it was appended to could arrive with or without its own full stop — hence one
      // normalised join instead of two literals colliding into "…changed.. The change was…".
      listEl.createDiv({ cls: "config-sync-save-error mod-warning", text: `Couldn't save this change — ${this.groupsErrorMsg.replace(/\.$/, "")}.` });
    }
    if (isOpen) this.renderRuleForm(listEl, group, "custom");
  }

  private formField(parent: HTMLElement, label: string): HTMLElement {
    const f = parent.createDiv();
    f.createEl("label", { cls: "config-sync-form-label", text: label });
    return f;
  }

  private markRequired(field: HTMLElement): void {
    field.querySelector<HTMLElement>("label")?.createSpan({ cls: "config-sync-required", text: "*" });
  }

  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "custom" | "discovered"): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = this.formField.bind(this);
    let currentName = group.name;

    if (mode !== "discovered") {
      const line1 = panel.createDiv({ cls: "config-sync-form-line1" + (mode === "custom" ? " has-name" : "") });
      if (mode === "custom") {
        const nameC = new TextComponent(field(line1, "Name"));
        nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(group.name).onChange(async (v) => {
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
      const loc = splitLocation(group.path);
      new DropdownComponent(field(line1, "Location"))
        .addOption("config", "Config folder")
        .addOption("vault", "Vault root")
        .setValue(loc.location)
        .onChange((v) => {
          // §4.2b/P4: a failed commit pins its message to THIS row, which only paints on a render —
          // so a handler that never refreshes is silent, and with the notice window a refused
          // keystroke could otherwise produce no feedback at all. Refresh on failure only: on
          // success these three deliberately stay put so the field keeps focus while typing.
          void this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === currentName);
            if (g !== undefined) g.path = joinLocation(v as "config" | "vault", splitLocation(g.path).rel);
          }, currentName).then((ok) => {
            if (!ok) this.refresh();
          });
        });
      const pathC = new TextComponent(field(line1, "Path"));
      pathC.setPlaceholder("relative path").setValue(loc.rel).onChange((v) => {
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === currentName);
          if (g !== undefined) g.path = joinLocation(splitLocation(g.path).location, v.trim());
        }, currentName).then((ok) => {
          if (!ok) this.refresh(); // §4.2b/P4 — see the Location dropdown above
        });
      });
    }

    const line2 = panel.createDiv({ cls: "config-sync-form-line2" });
    new DropdownComponent(field(line2, "Type"))
      .addOption("file", "File")
      .addOption("folder", "Folder")
      .setValue(group.type)
      .onChange(async (v) => {
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.type = v as SyncGroup["type"];
          if (g.type !== "file") {
            delete g.mode;
            delete g.fields;
          }
        }, group.name);
        this.refresh();
      });
    new DropdownComponent(field(line2, "Devices"))
      .addOption("all", sharingLabel(EVERYWHERE))
      .addOption("desktop", sharingLabel(perClass("desktop")))
      .addOption("mobile", sharingLabel(perClass("mobile")))
      .setValue(group.devices)
      .onChange(async (v) => {
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g !== undefined) g.devices = v as DeviceClass;
        }, group.name);
        this.refresh();
      });
    this.renderModeSegment(field(line2, "Mode"), group, () => this.refresh());
    const descC = new TextComponent(field(line2, "Description"));
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
      this.renderFieldsEditor(panel.createDiv(), group, () => this.refresh());
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
      this.saveErrorFor = "";
    } else {
      this.groupsErrorMsg = res.error;
      this.saveErrorFor = culprit !== undefined && culprit !== "" ? culprit : "";
    }
    // When the error is pinned to a specific row (inline), don't also show it at the page bottom.
    this.groupsErrorEl?.setText(this.saveErrorFor === "" ? this.groupsErrorMsg : "");
    return res.ok;
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Remotes")
      .setHeading()
      .setDesc("Sync your settings with another vault or a git repository. Your own devices don't need a remote — your regular vault sync already carries the settings.");
    const listEl = containerEl.createDiv({ cls: "config-sync-sources" });
    this.sources.forEach((draft, index) => this.renderRemoteRow(listEl, draft, index));
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.sourcesErrorEl.setText(this.sourcesErrorMsg);
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
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
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
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = this.formField.bind(this);
    const line1 = panel.createDiv({ cls: "config-sync-form-line1" });
    new DropdownComponent(field(line1, "Type"))
      .addOption("vault", "Another vault")
      .addOption("git", "Git repository")
      .setValue(draft.type)
      // §4.2b/N3: every handler in this form is `draft.x = …; saveRemotes()`, and `this.sources`
      // IS what the panel renders — so a refused gesture must be refused BEFORE the draft moves,
      // or the panel shows an edit that was never saved (the name field below is the plainest
      // case: it renames the row header for a save that never happened).
      .onChange(async (v) => {
        if (!this.host.settingsWritable()) return;
        draft.type = v as RemoteDraft["type"];
        await this.saveRemotes();
        this.refresh();
      });
    const nameField = field(line1, "Name");
    this.markRequired(nameField);
    const nameC = new TextComponent(nameField);
    nameC.setPlaceholder("name").setValue(draft.name).onChange((v) => {
      if (!this.host.settingsWritable()) return; // §4.2b/N3
      this.expanded.delete(`remote:${draft.name}`);
      draft.name = v.trim();
      this.expanded.add(`remote:${draft.name}`);
      void this.saveRemotes();
      nameSpan.setText(draft.name === "" ? "(unnamed)" : draft.name);
    });
    nameC.inputEl.addClass("config-sync-rule-name-input");

    if (draft.type === "vault") {
      const line2 = panel.createDiv({ cls: "config-sync-remote-path" });
      const pathField = field(line2, "Store path");
      this.markRequired(pathField);
      const pathC = new TextComponent(pathField);
      pathC.setPlaceholder("/path/to/other-vault/…/config-sync").setValue(draft.storePath).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.storePath = v.trim();
        void this.saveRemotes();
      });
      if (Platform.isDesktop) {
        new ExtraButtonComponent(line2).setIcon("folder-open").setTooltip("Browse…").onClick(() => void this.browseStorePath(draft));
      }
    } else {
      const line2 = panel.createDiv({ cls: "config-sync-remote-git" });
      let strip: HTMLElement | null = null;
      const clearStrip = (): void => {
        if (strip) {
          strip.setText("");
          strip.className = "config-sync-test-strip";
        }
      };
      const urlField = field(line2, "URL");
      this.markRequired(urlField);
      new TextComponent(urlField).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.url = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      const branchField = field(line2, "Branch");
      this.markRequired(branchField);
      new TextComponent(branchField).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.branch = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      new TextComponent(field(line2, "Store folder in repo")).setPlaceholder("empty = repo root").setValue(draft.subdir).onChange((v) => {
        if (!this.host.settingsWritable()) return; // §4.2b/N3
        draft.subdir = v.trim();
        void this.saveRemotes();
      });
      // Obsidian's own secret picker owns the token end to end: its button opens the keychain
      // modal to link or create a secret, shows the linked one masked (click to reveal) and
      // offers the ✕ that unlinks it. What it hands back — and all this plugin ever keeps — is
      // the secret's NAME, which rides along in the synced settings; the value stays in each
      // device's keychain, never read here and never written here.
      const tokenLine = panel.createDiv({ cls: "config-sync-remote-token" });
      const tokenField = field(tokenLine, "Access token");
      const tokenControl = tokenField.createDiv({ cls: "config-sync-secret-control" });
      const tokenC = new SecretComponent(this.app, tokenControl);
      new TextComponent(field(tokenLine, "Username"))
        .setPlaceholder("token")
        .setValue(draft.username)
        .onChange((v) => {
          if (!this.host.settingsWritable()) return; // §4.2b/N3
          draft.username = v.trim();
          void this.saveRemotes();
        });
      const statusEl = panel.createDiv({ cls: "config-sync-token-status" });
      const paintTokenStatus = (): void => {
        const held = draft.tokenId !== "" && this.app.secretStorage.listSecrets().includes(draft.tokenId);
        statusEl.className =
          "config-sync-token-status" + (held ? " is-ok" : draft.tokenId !== "" ? " is-warning" : "");
        statusEl.setText(
          held
            ? "✓ Token stored on this device."
            : draft.tokenId !== ""
              ? `⚠ This remote uses a token named "${draft.tokenId}", which this device doesn't have yet — link it here once.`
              : "For https URLs. Without a token, this device's own git sign-in is used. Stored in Obsidian's keychain — link it once per device."
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
        const testLine = panel.createDiv({ cls: "config-sync-remote-test" });
        const btn = new ButtonComponent(testLine).setButtonText("Test connection");
        strip = panel.createDiv({ cls: "config-sync-test-strip" });
        btn.onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing…");
          strip!.className = "config-sync-test-strip is-testing";
          strip!.setText("Contacting remote…");
          try {
            const { gitLsRemote } = await import("../external/gitSource");
            let auth: GitAuth | null;
            try {
              const candidate: Remote = { name: draft.name, type: "git", url: draft.url, branch: draft.branch };
              if (draft.tokenId !== "") candidate.tokenId = draft.tokenId;
              if (draft.username !== "") candidate.username = draft.username;
              auth = resolveGitToken(this.app.secretStorage, candidate);
            } catch (e) {
              strip!.className = "config-sync-test-strip is-error";
              strip!.setText(`✗ ${(e as Error).message}`);
              return;
            }
            const res = await gitLsRemote(draft.url, draft.branch, auth);
            if (res.kind === "error") {
              strip!.className = "config-sync-test-strip is-error";
              strip!.setText(`✗ Could not reach remote — ${res.message}`);
            } else if (res.branchFound) {
              strip!.className = "config-sync-test-strip is-ok";
              strip!.setText(`✓ Reachable — branch ${draft.branch} found`);
            } else {
              strip!.className = "config-sync-test-strip is-caution";
              strip!.setText(`Reachable, but branch "${draft.branch}" not found`);
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

  private async saveRemotes(): Promise<void> {
    if (!this.host.settingsWritable()) return; // §4.2b
    try {
      this.host.settings.remotes = validateRemotes(this.sources.map(toCandidate));
      await this.host.saveSettings();
      // A remote's url/branch/subdir/storePath may just have changed — never let a later compare
      // reuse a reader built from the pre-edit coordinates (#3).
      this.host.clearReaderCache();
      this.sourcesErrorMsg = "";
    } catch (e) {
      this.sourcesErrorMsg = (e as Error).message;
    }
    this.sourcesErrorEl?.setText(this.sourcesErrorMsg);
  }
}
