import { App, ButtonComponent, ItemView, Menu, Modal, Platform, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { ApplyItem, CaptureItem, orderInstallsCatalogFirst, ProgressFn, StateAction } from "../core/ConfigSyncCore";
import { lockRefFor, refItemId } from "../core/itemKeys";
import { GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry, RemoteDiffFile, remoteDirectionCounts } from "../core/status";
import { SECTION_LABELS, findGroupByName, SELF_GROUP_NAME, sectionForGroup, communityGroupName } from "../core/catalog";
import { EVERYWHERE, FileChanges, FileSharing, GroupResult, hasChanges, ItemRef, Remote, Sharing, SyncGroup, StorageSection } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { RuleListId } from "../core/enablementRules";
import {
  buildOptOutLocalMenu,
  buildLocalMenu,
  ENABLED_ON_HEADER,
  enablementRowModel,
  fileEnablementRowModel,
  MenuSectionModel,
  ON_THIS_DEVICE_HEADER,
  optOutLocalSegment,
  RowSegment,
  RULE_OPTIONS,
  ruleIcon,
  ruleLabel,
  ruleLandingNeedsSeed,
  SHARED_WITH_HEADER,
  sharingMenuSection,
} from "./enablementRow";
import { paintMergedControl } from "./mergedControl";
import { Availability } from "../core/availability";
import { REUSE_MAX_AGE_MS } from "../external/readerCache";
import { isWholeFileEncrypted } from "../core/modes";
import { classifyRemoteFailure } from "../core/remoteFailure";
import { GroupDisplayParts } from "../core/registry";
import {
  capFileEntries,
  CappedEntry,
  carrierIsSynced,
  ConflictChoice,
  defaultPolicy,
  enablementCarrierFor,
  effectiveFate,
  FamilyMember,
  FamilyRollup,
  familyRollup,
  excludedLineText,
  fateBucket,
  fateBucketCounts,
  FateBucketCounts,
  fileEntryFor,
  filesChangeLabel,
  foldCompanionEntries,
  groupExcludedHere,
  insyncLineText,
  isValidPolicy,
  LEFTOVER_ADOPT_HINT,
  leftoverPresentation,
  legacyLockedFamilyBucket,
  matchesSearch,
  mergeFamilyChanges,
  moreFilesText,
  nosettingsLineText,
  onOffFlips,
  onOffLineText,
  onOffNarrationLines,
  PanelFilter,
  presentedState,
  remoteSections,
  RowBucket,
  runProgressLabel,
  SectionKind,
  sectionForItem,
  sectionCountLabel,
  showColdStartBanner,
  stageableRow,
  StageableRow,
  stagedPayload,
  TypeSection,
  TYPE_SECTION_ORDER,
  TYPE_SECTION_TITLES,
  typeSectionForRow,
  unifiedFooterSummary,
  visibleUnderFilter,
  widestCountDigits,
  Direction,
  effectiveDirection,
} from "./panelModel";
import { Fate, FateInput, NOTHING_YET_SENTENCE, rowFate, versionAheadClause } from "./fateModel";
import { openDiffModal } from "./DiffModal";
import { renderDiffPanel, type DiffResolveControl } from "./diffView";
import { paintResolveSegment, renderResolveSegment } from "./resolveSegment";
import { REFRESH_BUTTON_CLASS, holdSpin, paintRefreshButton, renderRefreshButton, type RefreshView } from "./refreshControl";
import { confirmDeleteLeftovers } from "./ConfirmModal";
import { LEFTOVER_SECTION_ORDER, LeftoverSection } from "../core/leftover";
import { EnablementList, isSwitchListGroup, switchListSortedView } from "../core/switchList";
import { jsonSortedView } from "../core/merge";
import { renderReportContent, renderReportPills, stripHeader } from "./reportContent";
import { RunRecord, RunKind, RunStatus, worstStatus, formatRunTime, deleteLeftoverDesc } from "../core/runHistory";
import { ACTION_ICON, ACTION_COLOR_CLASS, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";
import { ENABLEMENT_CARRIER_GROUPS } from "../core/switchList";
import { FATE_CHIP_ICON } from "./fateChipIcons";
import {
  renderFoldIconNamed,
  renderFoldCount,
  FOLD_ICON,
  FOLD_ICON_COLOR_CLASS,
  AVAILABILITY_FOLD_ICON,
  AVAILABILITY_FOLD_TEXT,
  AVAILABILITY_FOLD_NOTE,
  CONFLICT_ICON,
  CONFLICT_COLOR_CLASS,
  type FoldKind,
  type AvailabilityFoldKind,
} from "./foldIcons";
import {
  placeRow,
  FATE_FOLD_ORDER,
  AVAILABILITY_FOLD_ORDER,
  FATE_PILL_FOLD,
  type FateFold,
} from "./panelTaxonomy";
import { renderFoldChevron, setFoldOpen } from "./foldChevron";
import { SettingsSpot } from "./settingsDeepLink";
// ITEM_SECTION_LABELS aliased: this file already declares its own ITEM_SECTION_LABELS (sidebar category
// labels, see below) for an unrelated domain.
import {
  FILE_SHARING_MENU_UNAVAILABLE_TEXT,
  PER_KEY_RULES_STATE_TEXT,
  PER_KEY_RULES_ACTION_TEXT,
  FILE_SHARING_OPTIONS,
  sharingIcon,
  sharingLabel,
} from "./itemCard";
import {
  QualifierAutocomplete,
  parseQuery,
  matchesQualifiers,
  type QualifierSpec,
  type QualifierResolver,
} from "./qualifierSearch";

// --- Qualifier search vocabulary (Sync Center) ---
export function syncTypeValue(g: SyncGroup): "file" | "folder" {
  return g.type === "folder" ? "folder" : "file";
}
export function syncModeValue(g: SyncGroup): string {
  return g.mode ?? "plain";
}
// The row's PanelFilter bucket, mirroring the state-filter pills: fate-derived, not raw
// GroupState — a conflict-bucket row resolves to "apply", its current placement. locked →
// null (no bucket, unchanged).
export function syncActionValue(bucket: RowBucket): "capture" | "apply" | "ok" | "none" | null {
  for (const f of ["capture", "apply", "ok", "none"] as const) {
    if (visibleUnderFilter(bucket, f)) return f;
  }
  return null;
}

// The Sync Center search bar's whole vocabulary, in the order the autocomplete offers it.
//
// Exported so the tests can assert against the SHIPPED list rather than their own copy of it
// (a test that restates a literal agrees with whichever site its author was
// looking at). `as const` is load-bearing, not decoration: it gives `SyncQualifierKey` below, which
// makes `syncResolvers` a total map over these keys — so renaming a key here without renaming its
// resolver is a compile error rather than a qualifier that parses and autocompletes and then
// filters nothing.
export const SYNC_QUALIFIER_SPECS = [
  { key: "type", description: "item kind", values: [{ value: "file", description: "single-file item" }, { value: "folder", description: "folder item" }] },
  // `section:` replaces v2's `scope:` outright, with NO alias: `scope` named three
  // different concepts depending on where you stood, and accepting it here would keep one of them
  // alive in the one place the user actually types. An unrecognised key is free text, so a typed
  // `scope:core` now searches for the literal words instead of silently filtering.
  //
  // `beta` is presented but never stored: it is an install source derived from the BRAT
  // index, so the resolver reads the same presented section the sidebar does.
  { key: "section", description: "item family", values: [{ value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "beta", description: "installed via BRAT" }, { value: "custom" }] },
  { key: "action", description: "what it needs", values: [{ value: "capture", description: "needs capture" }, { value: "apply", description: "needs apply" }, { value: "ok", description: "in sync" }, { value: "none", description: "no settings yet" }] },
  { key: "mode", description: "field handling", values: [{ value: "plain" }, { value: "fields" }, { value: "encrypted" }] },
  { key: "device", description: "device class", values: [{ value: "all" }, { value: "desktop" }, { value: "mobile" }] },
] as const satisfies readonly QualifierSpec[];
export type SyncQualifierKey = (typeof SYNC_QUALIFIER_SPECS)[number]["key"];
export const SYNC_QUALIFIER_KEYS: ReadonlySet<string> = new Set(SYNC_QUALIFIER_SPECS.map((s) => s.key));

// Sidebar section order: Beta sits between Community and custom.
const ITEM_SECTION_ORDER: (StorageSection | "beta")[] = ["obsidian", "core", "community", "beta", "custom"];
const ITEM_SECTION_LABELS: Record<StorageSection | "beta", string> = { ...SECTION_LABELS, beta: "Beta" };

const STATUS_CLS: Record<RunStatus, string> = { ok: "is-ok", warning: "is-warn", error: "is-error" };
// RunKind is wider than SyncAction (it also has "adopt"/"stop-sync"/"delete-leftover"), so
// map explicitly rather than assigning rec.kind directly — undefined for the non-actions.
const ACTION_CELL_MAP: Partial<Record<RunKind, SyncAction>> = { capture: "capture", apply: "apply", adopt: "apply", push: "push", pull: "pull" };
// The two on/off list carriers: "one object = one row" dissolves their own list row
// into the Core/Community section header chip — they never appear as a row themselves.

// Trailing debounce for the search input's heavy re-render — long
// enough to coalesce a fast typist's whole burst into one render, short enough to still read as
// live filtering once typing pauses.
const SEARCH_DEBOUNCE_MS = 130;

// After-install menu labels — the fallback ladder's two real choices
// (carrier NOT synced, row installs).
const AFTER_INSTALL_LABELS: Record<"install-enable" | "install", string> = {
  "install-enable": "Turn it on",
  install: "Leave it off",
};

// Enablement menu labels (same copy as After install, different
// StateAction domain): carrier NOT synced, row already installed but disabled. Stored under
// "enable"/"none" rather than "install-enable"/"install" so a stored choice stays valid under
// `isValidPolicy` for a disabled row's own ladder (`policyOptions`) and survives `reload()`'s
// stale-policy pruning instead of being silently dropped on the next render.
const ENABLEMENT_LABELS: Record<"enable" | "none", string> = {
  enable: "Turn it on",
  none: "Leave it off",
};

// Session-remembered UI state: which sections have their trailing fold lines flattened open. The
// availability folds share one set because their keys already carry the fold's own id.
const sessionUi = {
  insyncOpen: new Set<string>(),
  excludedOpen: new Set<string>(),
  nosettingsOpen: new Set<string>(),
  availabilityOpen: new Set<string>(),
};

// Escalating "less this device can do about it": a version away, a switch away, an install away,
// and finally not possible here at all.

// Staging state lives at session level, not view level: mobile Obsidian recreates views on
// tab switches, and per-instance state would re-run the default pre-check on every
// recreation — a run's cleared selection came back "self-checked".
const sessionStaging = {
  selected: new Set<string>(),
  directionOverride: new Map<string, Direction>(),
  policy: new Map<string, StateAction>(),
  seeded: false,
};

interface LastRun {
  kind: RunKind;
  remote: string | null;
  results: GroupResult[];
  expanded: boolean;
}

// The last-run strip and the post-adopt guidance also live at session level, so a view reload
// (e.g. right after Adopt, or a mobile tab switch) doesn't drop the result strip / guidance.
const sessionRun: { last: LastRun | null } = { last: null };

// The config-sync self layer, surfaced in its own sidebar destination (renderConfigSyncMode).
// `delta` is syncListDelta(local, store): `added` = groups the store has that this device's list
// doesn't, `removed` = the reverse. The pane labels them per direction.
export interface SelfSyncInfo {
  state: "coldstart" | "adopt" | "capture" | "both" | "insync";
  delta: { added: string[]; removed: string[] };
  itemCount: number; // store item count on coldstart, else local list size
  capturedAt: string | null;
  storePresent: boolean; // store.lock.json OR the store's self-copy exists — NOT inferred from itemCount
  contentChanged: boolean; // config-sync's own data.json differs beyond the list → pane shows a diff
  versionRefresh: { local: string; store: string } | null; // content in-sync but plugin version ahead
  updateAvailable: { local: string; store: string } | null; // plugin version behind the store's captured version — advisory only
  flagsRefresh: number | null; // installed plugins whose desktopOnly flag isn't recorded yet → nudge a capture
}

export interface SyncCenterHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[]; availability: Record<string, Availability> }>;
  selfStatus(): Promise<SelfSyncInfo>;
  coldStartDismissed(): boolean;
  setColdStartDismissed(v: boolean): void;
  // Non-null when this device's data.json was written by a newer Config Sync:
  // the plugin refuses every write while it is set, and
  // the panel says so instead of quietly offering runs that would be refused one by one.
  schemaStop(): { found: number } | null;
  // The same predicate the settings tab asks, and asking IS the refusal (the notice fires on the
  // user's gesture). A flow that will be refused refuses BEFORE it opens — a modal that
  // takes a decision from the user and only then declines is the same defect as a pull that lets
  // them resolve conflicts it was never going to apply.
  settingsWritable(): boolean;
  resolvedPath(group: SyncGroup): string;
  displayName(group: string, storedLabel?: string): string;
  displayParts(group: string, storedLabel?: string): GroupDisplayParts;
  // This device's own (possibly backfill-healed) local lock label for a group — the same
  // `lockStoredLabel(lastLock, ref)` read displayName/displayParts already fall back to when no
  // override is passed (the lock is keyed by item ref since v3, and an on/off-list element with no
  // entry of its own falls back to its carrier's recorded name). Exposed so a caller building its
  // own priority chain (remote pane) can slot the local lock in ahead of a remote's label
  // without bypassing it.
  localLockLabel(group: string): string | undefined;
  // The parent GROUP name for a companion group — null for a
  // non-companion, a custom group, or the legacy enabled-css-snippets switch list (out of scope).
  companionParentOf(group: string): string | null;
  captureItems(items: CaptureItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  applyItems(items: ApplyItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  reloadApp(): void;
  remotes(): Remote[]; // [] on mobile
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  remoteRefreshProgress(): { total: number; done: number } | null;
  // Identifies the reader-cache generation a compare was started against, so a re-render can
  // tell "still the same remote refresh cycle" (re-attach to the in-flight compare) from "the
  // remote changed or a refresh completed" (start a fresh one).
  readerGeneration(): number;
  deepDiff(remote: Remote, onPhase?: (phase: "fetch" | "compare") => void): Promise<RemoteCompareResult>;
  pullFrom(remote: Remote): Promise<GroupResult[] | null>;
  pushTo(remote: Remote): Promise<GroupResult[] | null>;
  adoptConfiguration(): Promise<GroupResult[] | null>;
  // The installed plugin's manifest desktop-only flag — the source of truth regardless of
  // whether the member's own settings-file sync is enabled (the availability map only covers
  // that subset). null = unknown (not installed on this device), not "false".
  isDesktopOnlyPlugin(id: string): boolean | null;
  betaIds(): Set<string>; // plugin ids tracked in the BRAT index (the Beta section/tab)
  runHistoryEnabled(): boolean;
  loadRunHistory(): Promise<RunRecord[]>;
  appendRunHistory(kind: RunKind, remote: string | null, results: GroupResult[]): Promise<void>;
  clearRunHistory(): Promise<void>;
  // `stopSyncing`/`storeFileCount` are NOT here: the gesture's one home is the settings-panel
  // card's own toggle — so both live on `SettingsHost` (SettingTab.ts) rather than lingering here
  // with no caller. This view changes rules and sets local exceptions; stopping a whole item is a
  // jump away through `MORE`.
  //
  // The Stop-syncing menu's per-device layer: read = has THIS device opted
  // this group out; write = set/clear THIS device's own opt-out (never another device's).
  deviceOptedOut(groupName: string): boolean;
  setDeviceOptOut(groupName: string, on: boolean): Promise<void>;
  listLeftoverStoreFiles(): Promise<{ rel: string; section: LeftoverSection; name: string; crumb: string | null; path: string; size: number }[]>;
  deleteLeftoverStoreFiles(rels: string[]): Promise<string[] | null>; // deleted rels, or null when refused
  appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void>;
  // Bidirectional divergence for a switch-list group (exceptions masked); null when either
  // side is missing or unparseable. `masked` is the augmented exception set itself — the
  // enablement fate derivation needs to tell "off everywhere" from "excluded by a rule".
  switchDivergenceFor(name: string): Promise<{ captureRemoves: string[]; applyDisables: string[]; masked: string[] } | null>;
  // Contents for an inline change diff: base = current state of the target side, produced =
  // what the pending action (capture/apply) would write. null = no diff available.
  diffPair(name: string, rel: string, dir: Direction): Promise<{ base: string; produced: string } | null>;
  // The two enablement layers, one read/write pair each — the SAME pair the Settings
  // panel's card rows call, so the three entrances cannot drift apart.
  // The fleet rule for one element of one list.
  enablementRuleFor(list: RuleListId, elementId: string): Sharing;
  setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void>;
  // This device's own exception for that element: null = follows the rule.
  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null;
  // Take the element out of the shared answer, keeping EXACTLY what it is right now.
  leaveToThisDevice(list: RuleListId, elementId: string): Promise<void>;
  // Put it back under the shared answer.
  followTheDefault(list: RuleListId, elementId: string): Promise<void>;
  // Flip an existing exception.
  setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void>;
  // The Settings-sync menu: the same field the Settings tab's file-row sharing control edits
  // (Item.settingsFile.fileRule.sharing — this-device is structurally excluded there).
  itemFileSharing(ref: ItemRef): FileSharing;
  // Whether the item's current mode makes a whole-file fileRule write legal (mirrors
  // manifest.ts's validator via itemCard.ts's fileRuleLegalForMode) — false for a fields-mode
  // item, whose Settings-sync row must not offer a menu setItemFileSharing would then throw on.
  itemFileSharingMenuLegal(ref: ItemRef): boolean;
  // Also the write target for a custom (folder) item's device class since runsOn's retirement
  // — the same field the Advanced tab's "Devices"
  // dropdown writes (SettingTab.commitGroups → persistCustomItems → customItemFromGroup), a
  // folder simply has no other settings-file content to share the write with.
  setItemFileSharing(ref: ItemRef, sharing: FileSharing): Promise<void>;
  // The More bridge: deep-links into the Settings
  // tab for this item's card.
  openSettingsAt(ref: ItemRef, spot: SettingsSpot): void;
  // The item a compiled group belongs to — a registry LOOKUP, never a parse of the group name
  // (the `plugin-` prefix is not a parser). null for a group no item owns.
  itemRefForGroup(name: string): ItemRef | null;
}

function relativeAge(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function isoAge(iso: string | null): string {
  if (iso === null) return "never";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : relativeAge(ms);
}

// remoteLabels: group name -> label from the remote store.lock.json, for the
// remote pane to show a real plugin name instead of a raw group id —
// empty on an absent/malformed remote lock, never a reason for the compare itself to fail.
type RemoteCompareResult = { entries: RemoteDiffEntry[]; lockDiffers: boolean; remoteLabels: Record<string, string> };

// One compare per (remote name, reader-cache generation) — see renderRemoteDetail.
// `result` is populated once the compare settles successfully and the entry stays put (it is
// NOT cleared on success) so every re-render while it's still the current key paints the cached
// result instead of flashing "Fetching remote…" again. A rejection clears the entry outright (see
// startRemoteCompare) so the next render retries fresh rather than replaying the error forever.
// `ticker` is the currently-live elapsed-timer interval id, if any render has one running against
// this entry — a re-render that attaches must clear it before starting its own.
interface InflightCompare {
  key: string;
  promise: Promise<RemoteCompareResult>;
  startedAt: number;
  phase: "fetch" | "compare";
  result: RemoteCompareResult | null;
  ticker: number | null;
}

interface StatusRow {
  group: SyncGroup;
  status: GroupStatus;
}

// One derivation per row per render cycle: rollup, fate input, fate and
// bucket computed together once per group name — every consumer (familyRollupFor, familyState,
// fateWithInput, fateFor, rowBucket) reads the same cached entry instead of re-deriving. Cache
// lives on the view (see rowDerivationCache) and is cleared at the top of render()/reload().
interface RowDerivation {
  rollup: FamilyRollup;
  input: FateInput;
  fate: Fate;
  bucket: RowBucket;
}

export const SYNC_CENTER_VIEW_TYPE = "config-sync-center";

export class SyncCenterView extends ItemView {
  private groups: SyncGroup[] = [];
  private statuses: Map<string, GroupStatus> = new Map();
  private availability: Map<string, Availability> = new Map();
  // Enablement-carrier divergence,
  // fetched once per reload — only present for a carrier that's itself compiled, so a disabled
  // row's presence here doubles as "this carrier is synced AND its data is readable".
  private carrierDivergence: Map<EnablementList, { captureRemoves: string[]; applyDisables: string[]; masked: string[] }> = new Map();
  // Per-render-cycle memo for rowBucket/familyRollupFor/familyState/fateWithInput/
  // fateFor — see deriveRow(). Cleared at the top of render()/reload().
  private rowDerivationCache: Map<string, RowDerivation> = new Map();
  // Search perf: the sidebar
  // search re-derives every row's searchable text and the whole sorted row list on EVERY
  // keystroke — live-measured as the dominant cost (a keystroke's `familySearchText` calls alone
  // walked `host.companionParentOf` tens of thousands of times, since `familyCompanions` rescans
  // the entire group list per row per call). Neither depends on the query text or on filter/
  // staging state — only on `this.groups` — so both memoize for the render cycle, same idiom and
  // same clear points as `rowDerivationCache` (render()/reload()): a search session's later
  // keystrokes hit a warm cache instead of repeating the O(rows × groups) scan.
  private searchTextCache: Map<string, string> = new Map();
  private rowsCache: StatusRow[] | null = null;
  private policy = sessionStaging.policy;
  // Fold state for the four unified type sections.
  private typeSectionOpen: Set<TypeSection> = new Set();
  // Fold state for the Leftover section — same lifetime as typeSectionOpen (per view instance).
  private leftoverOpen = false;
  private selected = sessionStaging.selected;
  private directionOverride = sessionStaging.directionOverride;
  // Conflict resolutions: view-level, not session-level like the maps
  // above — a conflict resolution is a live judgment call on the CURRENT divergence, not
  // something that should survive a mobile tab-switch view recreation the way staged
  // selections do. Resets outright after a successful run (renderActionBar's `run`).
  private conflictChoice: Map<string, ConflictChoice> = new Map();
  private expandedItems: Set<string> = new Set();
  // Which item cards' FILES row is expanded past its default collapsed
  // count-only line — keyed by group name, same "Set that survives repaints, starts fresh with a
  // new view instance" idiom expandedItems/remoteFoldsOpen already use, so a repaint mid-review
  // doesn't re-collapse a row the user just opened.
  private expandedFileRows: Set<string> = new Set();
  // Which file entries have their inline diff open — `{group}::{rel}`, the same idiom
  // remoteFoldsOpen already uses for the remote pane's inline diffs, and for the same reason: a
  // repaint rebuilds the list, and a diff held only in a closure would vanish with it. It became
  // load-bearing once Resolve moved INTO the diff toolbar: picking a side re-renders, and closing
  // the evidence the moment someone acts on it is the opposite of what that control is for.
  private openEntryDiffs: Set<string> = new Set();
  // Panels rescued from a card about to be rebuilt in place, keyed the same way. The rebuilt entry
  // ADOPTS its old panel and keeps showing it until the fresh read lands, instead of inserting an
  // empty one and filling it a tick later — the same "build detached, swap when ready" rule
  // SettingTab's renderCardBodyInto follows, and the difference between "the preview changed" and
  // "the card blinked". Non-null only for the duration of one refreshItemRow.
  private adoptedDiffPanels: Map<string, HTMLElement> | null = null;
  // Remote pane fold state: survives repaints (periodic check, notify) the way
  // expandedItems/typeSectionOpen do for the main list — a repaint rebuilds the pane fresh, so
  // without this the on/off line, object-row folds, and open inline diffs would collapse on every
  // tick. Keys: `{remoteName}::{group}` (row fold), `{remoteName}::{group}::onoff` (on/off line),
  // `{remoteName}::{group}::{itemRel}` (inline diff). Never persisted to disk; never pruned.
  private remoteFoldsOpen: Set<string> = new Set();
  private renderGen = 0;
  private filter: PanelFilter = "all";
  private panelSection: { kind: "device"; cat: StorageSection | "beta" | "all" } | { kind: "remote"; name: string } | { kind: "history" } | { kind: "self" } = { kind: "device", cat: "all" };
  private selfInfo: SelfSyncInfo | null = null;
  private selfDiffOpen = new Set<Direction>(); // which self data.json diffs are expanded
  private landedInitial = false; // cold-start auto-land to the Config Sync pane happens once
  private search = "";
  private betaIds: Set<string> = new Set();
  private lastRefreshedAt: number | null = null;
  // This view's own refresh gesture is in flight. Deliberately not derived from the plugin's
  // remoteRefreshProgress — see refreshControl.ts's opening note for why that could never work.
  private refreshing = false;
  private compact = false;
  private switcherOpen = false;
  private running = false;
  private activeRun: { verb: "Capturing" | "Applying"; done: number; total: number } | null = null;
  private get lastRun(): LastRun | null {
    return sessionRun.last;
  }
  private set lastRun(v: LastRun | null) {
    sessionRun.last = v;
  }
  private history: RunRecord[] = [];
  private historyOpen: number | null = null; // index of the run whose detail is shown; null = table
  private leftovers: { rel: string; section: LeftoverSection; name: string; crumb: string | null; path: string; size: number }[] = [];
  private readonly qac = new QualifierAutocomplete(SYNC_QUALIFIER_SPECS);
  private expandedDisclosures = new Set<string>(); // per-group disclosure keys, `${group}::<kind>`
  private ruleSearch = new Map<string, string>(); // per-group per-plugin-rule filter query
  // Regions the sidebar search updates in place, so a keystroke never rebuilds (and refocuses)
  // the search input itself. Set on every full render().
  private mainEl: HTMLElement | null = null;
  private sideSectionEl: HTMLElement | null = null;
  // "Instant field, deferred work": the search input's own value is
  // always native/instant; the heavy re-render (sidebar badges + the whole main pane) is debounced
  // behind this single timer so a fast typist never pays for every intermediate keystroke — only
  // the query it settles on. One timer shared by the sidebar and compact-mainbar search inputs
  // (never both live at once — `renderSidebar`/`renderItemMode`'s compact branch are mutually
  // exclusive per render). Cancelled in onClose so a closed view can't fire a stale render.
  private searchDebounceTimer: number | null = null;
  // The remote pane's compare in flight, if any — see renderRemoteDetail.
  private inflightCompare: InflightCompare | null = null;

  constructor(leaf: WorkspaceLeaf, private host: SyncCenterHost) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_CENTER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sync Center";
  }

  getIcon(): string {
    return "arrow-left-right";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("config-sync-center");
    const ro = new ResizeObserver(() => {
      this.evaluateCompact();
    });
    ro.observe(this.contentEl);
    this.register(() => ro.disconnect());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf && !this.running) void this.reload();
      })
    );
    this.registerDomEvent(document, "click", (ev) => {
      if (!this.switcherOpen) return;
      const t = ev.target as Node;
      const sw = this.contentEl.querySelector(".config-sync-switcher");
      const menu = this.contentEl.querySelector(".config-sync-switcher-menu");
      if (sw?.contains(t) === true || menu?.contains(t) === true) return;
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.qac.destroy(); // release the widget's document-level listener if the view closes mid-dropdown
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null; // match the clear+null idiom used everywhere else
    }
    this.contentEl.empty();
  }

  onResize(): void {
    this.evaluateCompact();
  }

  private evaluateCompact(): void {
    const width = this.contentEl.clientWidth;
    if (width === 0) return; // hidden leaf
    const compact = width < 700;
    if (compact !== this.compact) {
      this.compact = compact;
      if (!this.running) this.render(this.renderGen);
    }
  }

  // Called by the plugin when awareness state changes while the view is open.
  notifyExternalChange(): void {
    if (this.running) return; // a rebuild mid-run would replace the live progress button
    void this.reload();
  }

  private async reload(): Promise<void> {
    const gen = ++this.renderGen;
    // A reload always means new data — drop the row derivation memo up front so no
    // interaction landing mid-reload (before the closing render() call) can read a bucket/fate
    // computed against the groups/statuses this reload is about to replace. The search-text
    // and rows() memos are equally stale once the group list is about to change. (A pending
    // debounced search re-render is handled too — see renderMainRegion()'s own cancel:
    // reload() always ends in render() → renderMainRegion(), so that single cancel point covers
    // this path already; no separate copy needed here.)
    this.rowDerivationCache.clear();
    this.searchTextCache.clear();
    this.rowsCache = null;
    const { groups, statuses, availability } = await this.host.computeStatuses();
    if (gen !== this.renderGen) return;
    this.groups = groups;
    this.statuses = new Map(statuses.map((s) => [s.group, s]));
    this.availability = new Map(Object.entries(availability));
    this.betaIds = this.host.betaIds();
    const selfInfo = await this.host.selfStatus();
    if (gen !== this.renderGen) return;
    this.selfInfo = selfInfo;
    // Fresh device: open straight to the Config Sync pane (the adopt entry) instead of an empty
    // item list — once. After that the user navigates freely.
    if (!this.landedInitial) {
      this.landedInitial = true;
      if (this.selfInfo.state === "coldstart") this.panelSection = { kind: "self" };
    }
    const history = this.host.runHistoryEnabled() ? await this.host.loadRunHistory() : [];
    if (gen !== this.renderGen) return;
    this.history = history;
    // Leftover means "store files with no matching group"; a device with no groups (fresh /
    // pre-adopt) has no baseline, so the whole store would look leftover — dangerous with
    // "Delete all". Only compute it once the manifest exists.
    const leftovers = this.groups.length > 0 ? await this.host.listLeftoverStoreFiles() : [];
    if (gen !== this.renderGen) return;
    this.leftovers = leftovers;
    // User state survives reloads; prune entries whose item vanished.
    const names = new Set(groups.map((g) => g.name));
    // Fetched once here (not per disabled row) — only the carriers that are themselves
    // compiled items are queried; a group not in `names` is left absent from the map.
    this.carrierDivergence.clear();
    for (const carrier of ["core-plugins", "community-plugins"] as const) {
      if (!names.has(carrier)) continue;
      const d = await this.host.switchDivergenceFor(carrier);
      if (gen !== this.renderGen) return;
      if (d !== null) this.carrierDivergence.set(carrier, d);
    }
    for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
    for (const n of [...this.directionOverride.keys()]) if (!names.has(n)) this.directionOverride.delete(n);
    // Staging expires with the state that motivated it: an item that became inert (e.g.
    // in-sync right after a capture/apply run) drops out of the staged set and loses its
    // direction override — otherwise the footer keeps counting freshly-synced items.
    for (const n of [...this.selected]) {
      const st = this.statuses.get(n);
      if (st !== undefined && !stageableRow(st.state, this.sectionOf(n))) {
        this.selected.delete(n);
        this.directionOverride.delete(n);
      }
    }
    for (const n of [...this.expandedItems]) if (!names.has(n)) this.expandedItems.delete(n);
    for (const n of [...this.policy.keys()]) if (!names.has(n)) this.policy.delete(n);
    // A row's availability may have changed since the last load (e.g. externally enabled),
    // moving it to a different section with a different policy ladder. Drop any stored policy
    // that no longer belongs to the current ladder so applyPayload() can't send a stale action.
    for (const [n, action] of [...this.policy]) if (!isValidPolicy(this.availOf(n), action)) this.policy.delete(n);
    // A conflict resolution expires with the conflict itself — a row that stopped differing
    // (resolved by this run, or by an external edit) drops its stale choice so a later,
    // unrelated divergence on the same group can't silently inherit an old "your choice".
    for (const [n] of [...this.conflictChoice]) {
      const st = this.statuses.get(n);
      if (!names.has(n) || st === undefined || presentedState(st.state, this.availOf(n).drift) !== "differs") this.conflictChoice.delete(n);
    }
    // Default pre-check seeds once per Obsidian session, never on later refreshes or
    // view recreations (mobile recreates the view on tab switches).
    if (!sessionStaging.seeded) {
      sessionStaging.seeded = true;
      for (const s of statuses) {
        // never-synced rows are deliberately NOT pre-checked: in the upgrade
        // window a group with uncaptured local edits also reads never-synced, and pre-checking
        // it under the apply default would make one blind "Apply N items" press overwrite those
        // edits. Cold-start users select-all instead; safety beats one click.
        if ((s.state === "local-changed" || s.state === "store-newer") && this.sectionOf(s.group) === "main") this.selected.add(s.group);
      }
    }
    this.lastRefreshedAt = Date.now();
    this.render(gen);
  }

  private availOf(name: string): Availability {
    return this.availability.get(name) ?? { kind: "enabled", drift: null, localVersion: null, storeVersion: null, anchor: "app", desktopOnly: false };
  }

  // Install targets the version the store captured; latest when unrecorded.
  private installTargetText(name: string): string {
    const v = this.availOf(name).storeVersion;
    return v !== null ? `the captured version ${v}` : "the latest version";
  }

  private sectionOf(name: string): SectionKind {
    return sectionForItem(this.availOf(name), Platform.isMobile);
  }

  private carrierIsSynced(itemGroup: string): boolean {
    return carrierIsSynced(
      this.rowRef(itemGroup),
      this.groups.map((g) => g.ref)
    );
  }

  // The item ref behind a row's group name — THE resolver this view asks whenever it needs the
  // identity rather than the label (the `plugin-` prefix is not a parser). The host's
  // registry lookup answers for a compiled row; a store-only row falls through to the same closed
  // legacy rules a v1/v2 lock read uses (itemKeys.ts's lockRefFor), so the one case that used to
  // force a name parse — a row with no def — is answered by the single producer too.
  private rowRef(name: string): string {
    if (this.rowRefSource !== this.groups) {
      this.rowRefSource = this.groups;
      this.rowRefFallback = lockRefFor(this.groups);
      this.rowRefMemo.clear();
    }
    const memo = this.rowRefMemo.get(name);
    if (memo !== undefined) return memo;
    const ref = this.host.itemRefForGroup(name) ?? this.rowRefFallback(name);
    this.rowRefMemo.set(name, ref);
    return ref;
  }

  // rowRef is asked per row per render, and both halves of it cost
  // real work — a registry scan and, for a store-only row, an index build. Memoized against the
  // group list's identity, so a reload rebuilds it and nothing else does.
  private rowRefSource: SyncGroup[] | null = null;
  private rowRefFallback: (name: string) => string = lockRefFor([]);
  private rowRefMemo = new Map<string, string>();

  // The switch-list element id for a disabled item's own group name: an item's id IS its element id
  // (a community item's element is its plugin id, a core item's is its own id). A companion or a
  // carrier has no element of its own, and refItemId answers null for both.
  private carrierElementFor(itemGroup: string): string {
    return refItemId(this.rowRef(itemGroup))?.id ?? itemGroup;
  }

  // Composed display string for sorting and search — parent prefix groups companions directly
  // under their host card in name order.
  private fullName(name: string, storedLabel?: string): string {
    const p = this.host.displayParts(name, storedLabel);
    return p.parent === null ? p.label : `${p.parent} › ${p.label}`;
  }

  // One representative compiled group per family ("one object"): the parent, or an
  // orphan companion whose parent isn't itself compiled here — e.g. the item's own settings file
  // is device-scoped off this device while the companion isn't (honest degradation: a family can
  // only fold into a parent that actually exists).
  private familyGroups(): SyncGroup[] {
    const names = new Set(this.groups.map((g) => g.name));
    return this.groups.filter((g) => {
      const parent = this.host.companionParentOf(g.name);
      return parent === null || !names.has(parent);
    });
  }

  // A family's companion StatusRows for `parentName`: groupOwners' def-level
  // presetCompanions plus any item's configured companions, restricted to ones currently
  // compiled and statused. Empty for a standalone row (custom folder, no-companion item) —
  // familyRollup's single-member truth-table guarantee then makes every consumer below
  // byte-identical to pre-family behavior.
  private familyCompanions(parentName: string): StatusRow[] {
    const out: StatusRow[] = [];
    for (const group of this.groups) {
      if (this.host.companionParentOf(group.name) !== parentName) continue;
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    return out;
  }

  // A dir-type member's file count for the rollup ("companion file changes (summed
  // count N)"): 0 for a file-type member (its own settings payload is a separate verb component
  // — see computeFateInput's hasSettingsPayload) and for a dir member with no diff computed yet.
  private memberFileCount(r: StatusRow): number {
    return r.group.type === "folder" && r.status.changes !== undefined ? this.folderChangeCount(r.status.changes) : 0;
  }

  // The family rollup for a row (itself + its companions) — shared by computeFateInput (fate/
  // direction/conflict), familyState (counts/filters/visibility), stagedRows' companion fan-out,
  // and renderUnifiedFiles' merged Files section. Memoized via deriveRow.
  private familyRollupFor(r: StatusRow): FamilyRollup {
    return this.deriveRow(r).rollup;
  }

  // The uncached rollup computation — called exactly once per row per render cycle, from
  // deriveRow(), which caches the result. Never call this directly outside deriveRow.
  private computeFamilyRollup(r: StatusRow): FamilyRollup {
    const companions = this.familyCompanions(r.group.name);
    const members: FamilyMember[] = [
      { name: r.group.name, state: this.presState(r), fileCount: this.memberFileCount(r) },
      ...companions.map((c): FamilyMember => ({ name: c.group.name, state: this.presState(c), fileCount: this.memberFileCount(c) })),
    ];
    return familyRollup(members);
  }

  // The family's Files section: parent changes plus every companion's, each companion's
  // paths prefixed with its own group name so `themes/Foo.css` reads as a path under the family
  // rather than colliding with the parent's own files. A member with no changes attached is
  // skipped (mergeFamilyChanges only ever sees members that HAVE a `changes` set).
  private familyChanges(r: StatusRow): FileChanges {
    const parts: { prefix: string | null; changes: FileChanges }[] = [];
    if (r.status.changes !== undefined) parts.push({ prefix: null, changes: r.status.changes });
    for (const c of this.familyCompanions(r.group.name)) {
      if (c.status.changes !== undefined) parts.push({ prefix: c.group.name, changes: c.status.changes });
    }
    return mergeFamilyChanges(parts);
  }

  // Recovers a familyChanges() entry's true (group, path): mergeFamilyChanges only rewrites the
  // DISPLAY path (`"<companionGroup>/" + rel`) — the diff/view affordance must still target the
  // companion's own store location, never the parent's (and vice versa for a parent-owned entry).
  private fileOwner(r: StatusRow, mergedRel: string): { group: string; rel: string } {
    for (const c of this.familyCompanions(r.group.name)) {
      const prefix = `${c.group.name}/`;
      if (mergedRel.startsWith(prefix)) return { group: c.group.name, rel: mergedRel.slice(prefix.length) };
    }
    return { group: r.group.name, rel: mergedRel };
  }

  // The state a row's FAMILY presents as. Every count/filter/partition/
  // fold consumer reads `rowBucket` (below) instead — this is left as (1) the
  // fallback `rowBucket` uses when the row's OWN state is "locked" (see its comment) and (2) the
  // handful of call sites that genuinely need a row's OWN member state (fateWithInput's locked
  // bypass, the default-policy suggestion) go through presState(r) directly, not this rollup.
  private familyState(r: StatusRow): GroupState {
    return this.familyRollupFor(r).state;
  }

  // The single per-row bucket derivation every count/filter/partition/fold consumer reads:
  // a `↓ Turns on` row can never land in the "no settings yet" fold its raw
  // GroupState might suggest — its bucket comes from the SAME fate it renders with. Memoized via
  // deriveRow — see there for the locked-bucket bypass reasoning.
  private rowBucket(r: StatusRow): RowBucket {
    return this.deriveRow(r).bucket;
  }

  // The single derivation pass for a row: computes the rollup, fate
  // input, fate and bucket together, once, and caches by group name for the rest of the render
  // cycle — familyRollupFor/familyState/fateWithInput/fateFor/rowBucket all read this cache
  // instead of re-deriving. Cache is cleared at the top of render()/reload() (see
  // rowDerivationCache).
  //
  // "locked" (encrypted, no passphrase set) never runs content comparison, so it has no fate-based
  // reading at all — bucketed off the row's OWN presState (matching this same locked check, not
  // the family rollup) rather than the family rollup, because familyRollup treats a locked member
  // as neutral: a locked PARENT with a DIRECTIONAL companion (e.g. an Encrypted-mode item with no
  // passphrase, alongside a plain companion dir with real changes) rolls up to the companion's
  // directional state, not "locked" — so an unconditional "—"/non-stageable bypass fate would
  // otherwise fateBucket to "ok" and the whole family would silently vanish from counts/filters/
  // the active partition (config-reachable by any user). `legacyLockedFamilyBucket`
  // reproduces the bucket familyState(r) alone would give, from the family's raw state, never
  // from fate.
  private deriveRow(r: StatusRow): RowDerivation {
    const cached = this.rowDerivationCache.get(r.group.name);
    if (cached !== undefined) return cached;
    const rollup = this.computeFamilyRollup(r);
    const input = this.computeFateInput(r, rollup);
    const locked = this.presState(r) === "locked";
    const fate: Fate = locked
      ? { glyph: "—", sentence: "Encrypted — set the passphrase in settings to compare", chips: ["encrypted"], stageable: false, turnsOn: false, nothingYet: false, excluded: false }
      : rowFate(input);
    const bucket: RowBucket = locked ? legacyLockedFamilyBucket(rollup.state) : fateBucket(fate);
    const derived: RowDerivation = { rollup, input, fate, bucket };
    this.rowDerivationCache.set(r.group.name, derived);
    return derived;
  }

  // Memoized per render cycle (cleared alongside
  // rowDerivationCache — see render()/reload()). Every sidebar section entry and both in-section
  // paths called this fresh on every call — up to ~15 rebuilds of the same sorted array per
  // keystroke, each re-sorting with a `fullName`/localeCompare comparator and re-scanning
  // `familyGroups()`'s own `host.companionParentOf` pass. The result depends only on
  // `this.groups`/`this.statuses`, never on filter/search/staging, so one build per cycle is
  // always correct.
  private rows(): StatusRow[] {
    if (this.rowsCache !== null) return this.rowsCache;
    const out: StatusRow[] = [];
    for (const group of this.familyGroups()) {
      // config-sync manages itself in its own sidebar destination (renderConfigSyncMode), so it
      // never appears in the item list, sections, filter pills, or footer totals — all of which
      // derive from this row set.
      if (group.name === SELF_GROUP_NAME) continue;
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    // The store manifest accretes in capture order; the view sorts deterministically — type
    // section rank, then display name — so e.g. core items never interleave the Obsidian
    // ones. Ranking by TYPE_SECTION_ORDER rather than raw ITEM_SECTION_ORDER merges beta into
    // the same rank as community: "alphabetical within" a type
    // section means ONE merged alphabetical list, not a community block followed by a beta
    // block — itemSectionOf/typeSectionForRow already agree that beta belongs in Community.
    out.sort((a, b) => {
      const rank =
        TYPE_SECTION_ORDER.indexOf(typeSectionForRow(this.itemSectionOf(a.group.name))) -
        TYPE_SECTION_ORDER.indexOf(typeSectionForRow(this.itemSectionOf(b.group.name)));
      if (rank !== 0) return rank;
      return this.fullName(a.group.name, a.group.label).localeCompare(this.fullName(b.group.name, b.group.label));
    });
    this.rowsCache = out;
    return out;
  }

  // A group's sidebar section: the catalog's stored section, except community plugins tracked in
  // the BRAT index, which present under Beta (parity with the settings Beta tab).
  private itemSectionOf(name: string): StorageSection | "beta" {
    const cat = sectionForGroup(name);
    // Beta is a presented classification over a community item, so the id it asks BRAT
    // about comes from the row's ref — never sliced off the name.
    const owner = refItemId(this.rowRef(name));
    if (cat === "community" && owner !== null && this.betaIds.has(owner.id)) return "beta";
    return cat;
  }

  // THE row set every count reads: exactly the rows the list renders. Families already folded
  // (rows()), the self item already out (it has its own sidebar destination), and the two on/off
  // carriers dropped here because they dissolve into their section's head chip rather than
  // rendering as rows.
  //
  // Availability is deliberately NOT narrowed: an outdated/disabled/not-installed item is drawn in
  // the list like any other row and can be staged (stageableRow: in the non-main sections the state
  // ACTION is the payload), so a count that skipped it disagreed with the list it sits above. That
  // narrowing is where `↑16` vs `To capture 14` came from — the header and sidebar counted
  // main-only-with-carriers while the filter pills counted all-sections-without — and both readings
  // were derived from a comment that stopped being true in 987eacf, when the availability sections
  // were replaced by the four type sections.
  private countable(rows: StatusRow[]): StatusRow[] {
    return rows.filter((r) => !ENABLEMENT_CARRIER_GROUPS.has(r.group.name));
  }

  private effDir(r: StatusRow): Direction {
    return effectiveDirection(this.presState(r), this.directionOverride.get(r.group.name));
  }

  // Presentation state: version-ahead in-sync rows surface as to-capture.
  private presState(r: StatusRow): GroupState {
    return presentedState(r.status.state, this.availOf(r.group.name).drift);
  }

  // The item ref for a row's compiled group name. A registry LOOKUP through the host, not an
  // inverse parse of the name: the registry already knows which def produced which
  // group name, so nothing here has to know that a community item's group carries a `plugin-`
  // prefix. null for a group no item owns (a companion, an enablement carrier), whose rows never
  // reach the Settings-sync menu or the More bridge.
  private itemRefFor(name: string): ItemRef | null {
    return this.host.itemRefForGroup(name);
  }

  // The real FateInput derivation:
  // `pres` is the FAMILY's rollup state (parent + companions) — it, not the row's
  // own presState, drives direction/conflict/nothingYet/stageability, via the same
  // stageableRow/effectiveDirection chains a plain row always used (familyRollup's single-member
  // guarantee makes a companion-less row byte-identical to before). `hasSettingsPayload` (the
  // settings verb) reads the row's own RAW `r.status.state`, not the version-ahead-
  // relabeled presState — a raw-in-sync/drift-ahead row genuinely writes no settings file, only
  // `versionAhead` below explains its capture; folderFileCount covers a companion's own file
  // changes separately ("parent settings payload changed → settings verb; companion file
  // changes → folder verb joins"). storeListOn/locallyOn/ruleSharing/localException only exist for a
  // carrier-synced plugin row — for every other row (obsidian/folder/self-excluded/
  // carrier-unsynced) they stay at their "no enablement dimension" defaults, which
  // `effectiveTurnsOn`/`buildChips` already treat as a no-op (see fateModel.ts). Called exactly
  // once per row per render cycle, from deriveRow(), which already has the rollup
  // computed — takes it as a parameter rather than recomputing it.
  private computeFateInput(r: StatusRow, rollup: FamilyRollup): FateInput {
    const name = r.group.name;
    const a = this.availOf(name);
    const deviceClass: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    const cat = this.itemSectionOf(name);
    const isPlugin = cat === "core" || cat === "community" || cat === "beta";
    const carrierSynced = isPlugin && this.carrierIsSynced(name);
    let storeListOn: boolean | null = null;
    let locallyOn = false;
    let ruleSharing: Sharing = EVERYWHERE;
    let localException: "on" | "off" | null = null;
    if (carrierSynced) {
      const carrier = enablementCarrierFor(this.rowRef(name));
      const element = this.carrierElementFor(name);
      locallyOn = a.kind === "enabled";
      const div = this.carrierDivergence.get(carrier);
      // Best-effort default (divergence not loaded yet): assume the store agrees with local —
      // the same "stays off"/"in sync" reading a synced-but-unloaded carrier settles on elsewhere.
      storeListOn = div === undefined ? locallyOn : locallyOn ? !div.applyDisables.includes(element) : div.captureRemoves.includes(element);
      ruleSharing = this.host.enablementRuleFor(carrier, element);
      localException = this.host.deviceElementFor(carrier, element);
    }
    const pres = rollup.state;
    const optedOutHere = this.host.deviceOptedOut(name);
    // Forcing direction null HERE, not just rowFate's own output, is what makes every OTHER
    // direction-reading consumer agree (otherwise an opted-out not-installed plugin still reads
    // "Installs" in To apply) — the
    // card's On-apply/On-capture header + Files visibility (renderUnifiedCard's `dir`) and
    // stateClauseText's clause branch both read `input.direction` directly, not `fate.glyph`, so
    // patching rowFate alone would leave them still deriving the row's real, still-derivable
    // direction from the availability ladder/rollup — a not-installed plugin has an "apply"
    // direction independent of this device's opt-out. Mirrors how groupExcludedHere's class
    // exclusion already arrives with direction:null BY CONSTRUCTION (the synthetic in-sync status
    // computeStatuses synthesizes upstream) — opt-out has no such synthetic status (the real
    // comparison genuinely runs), so it's forced null here instead.
    const rawDirection = stageableRow(pres, this.sectionOf(name)) ? effectiveDirection(pres, this.directionOverride.get(name)) : null;
    const direction = optedOutHere ? null : rawDirection;
    const rollupFiles = direction === "apply" ? rollup.applyFiles : direction === "capture" ? rollup.captureFiles : 0;
    return {
      direction,
      conflict: pres === "differs",
      nothingYet: pres === "no-settings",
      installed: a.kind !== "not-installed",
      hasUpdate: a.anchor === "plugin" && a.drift === "behind",
      // driftFor (availability.ts) only ever returns "ahead" once both versions are
      // non-null — mirrored via the && chain below (not a defensive fallback) rather than
      // asserted, since TS can't infer that guarantee from `a.drift` alone.
      // BOTH anchors, not just "plugin". An app-anchored row (App settings, Appearance, Hotkeys,
      // the two plugin lists) drifts exactly the same way when Obsidian itself updates, and
      // `availabilityForGroup`'s app branch fills the same two version fields — but the original
      // C-#37 gate only ever admitted plugins, so those rows kept landing on the generic
      // `Captures files` fallback: a promise to edit files that the run does not keep, on a row
      // whose files match the store byte for byte. `anchor` still travels so the copy can name
      // WHOSE version moved (a bare "version 1.13.7" on App settings names nobody).
      versionAhead:
        a.drift === "ahead" && a.localVersion !== null && a.storeVersion !== null
          ? { installed: a.localVersion, stored: a.storeVersion, anchor: a.anchor }
          : null,
      carrierSynced,
      storeListOn,
      locallyOn,
      ruleSharing,
      localException,
      deviceClass,
      desktopOnly: a.desktopOnly,
      // THIS row's own compiled group (not the family rollup) is scoped away from this
      // device's class by the item's Settings-sync file rule — the same layer desktopOnly reads
      // its fact from (`a`/`r.group`), never the store; groupExcludedHere (panelModel.ts) checks
      // both the group-level devices class AND a Plain file's own fileRule.sharing, since the two
      // can disagree in practice. rowFate only surfaces it when the family presentation is
      // otherwise neutral (direction null) — a directional/conflict member always wins, so a
      // still-syncing companion is never masked.
      excludedHere: groupExcludedHere(r.group, deviceClass),
      // THIS row's own group, opted out on THIS device via the Stop-syncing menu — a
      // DIFFERENT fact/cause from excludedHere (a per-device choice, not a class rule) AND a
      // DIFFERENT precedence (unconditional, not direction-null-gated — see `direction` above and
      // rowFate's own comment); rowFate renders the two identically once either wins
      // (glyph/sentence/chip/stageable); only the card clause (stateClauseText) tells them apart.
      optedOutHere,
      hasSettingsPayload: r.status.state !== "no-settings" && r.status.state !== "in-sync" && r.status.state !== "locked",
      // "folder": a real dir-type group — its own files ARE the settings payload, so
      // fateModel's join must not also compose a separate "applies settings" (special:"folder"
      // REPLACE case). A dir-type row never owns companions itself (compileCompanions doesn't
      // nest), so its own folderFileCount stays the pre-family per-row computation, untouched.
      special: name === "appearance" ? "appearance" : r.group.type === "folder" ? "folder" : null,
      folderFileCount:
        r.group.type === "folder"
          ? // Undefined `.changes` (a "not-captured"/"no-settings" GroupStatus never attaches
            // one) has no synchronous file count available — falls back to null so the sentence
            // degrades to the generic "applies/captures settings" instead of asserting a wrong
            // "0 files".
            r.status.changes !== undefined
            ? this.folderChangeCount(r.status.changes)
            : null
          : // Non-folder parent: the family's companion files in the EFFECTIVE direction, joined
            // after the settings verb — null (no join) rather than a false "…0 files" when the
            // sum is zero.
            rollupFiles > 0
            ? rollupFiles
            : null,
      encrypted: isWholeFileEncrypted(r.group),
    };
  }

  private folderChangeCount(c: FileChanges): number {
    return c.added.length + c.updated.length + c.deleted.length;
  }

  // "locked" (encrypted, no passphrase set) has no representation in the fate verb table —
  // content comparison never even ran, so direction/conflict/nothingYet are all meaningless here.
  // Bypasses rowFate for this one state and reuses this codebase's existing approved copy for it
  // (stateIcon's "locked" tip, already shown elsewhere in this view) rather than letting it fall
  // through to a misleading "In sync". Memoized via deriveRow.
  private fateWithInput(r: StatusRow): { fate: Fate; input: FateInput } {
    const { fate, input } = this.deriveRow(r);
    return { fate, input };
  }

  private fateFor(r: StatusRow): Fate {
    return this.deriveRow(r).fate;
  }

  // All user-facing counts (header pills, sidebar badges, filter pills, switcher) must agree
  // with what the filters actually show — i.e. count each row's BUCKET,
  // not its raw family/member state.
  private presentedCounts(rows: StatusRow[]): FateBucketCounts {
    return fateBucketCounts(rows.map((r) => this.rowBucket(r)));
  }

  // The digit slot every count badge reserves. Measured from the widest number any badge on this
  // pane could show rather than fixed in the stylesheet: a hard-coded reservation is wrong in both
  // directions — too small and one long count breaks the column it was there to keep, too large and
  // every short count carries dead space inside its capsule (a fixed 3 turned `↑3` from 28px into
  // 41px, all of it trailing).
  // A search REPLACES the bucket badges with a single neutral hit count, so the two never share a
  // pane and the reservation follows whichever is on screen — folding the hit bound into the
  // resting case would reserve the row total's width (3 digits at 107 items) for buckets that only
  // ever reach 2, which is the over-reservation this whole measurement exists to avoid.
  // Either way `All items` bounds every per-category entry, each being a subset of it.
  private badgeDigits(): number {
    if (this.searching()) {
      return widestCountDigits([this.rows().filter((r) => this.rowMatchesSearch(r)).length]);
    }
    const c = this.presentedCounts(this.countable(this.rows()));
    return widestCountDigits([c.up, c.down, c.ok, c.excluded, c.none]);
  }

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    // A fresh render cycle — any staging state a render-triggering handler just
    // changed (direction override, conflict choice, selection, filter, search…) must be read
    // fresh, not off derivations cached for the PREVIOUS cycle's state. The search-text/
    // rows() memos don't depend on that staging state, only on `this.groups` — clearing them here
    // too is cheap insurance (one full render, not one per keystroke) against anything upstream of
    // render() replacing `this.groups` without going through reload()'s own clear. (A pending
    // debounced search re-render is handled too — see renderMainRegion()'s own cancel:
    // render() always calls renderMainRegion() below, so that single cancel point covers this path
    // already; no separate copy needed here.)
    this.rowDerivationCache.clear();
    this.searchTextCache.clear();
    this.rowsCache = null;
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    this.renderHeader();
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    // How many digit slots the count badges reserve, so their icons line up as a column without
    // over-reserving. Set on the shell because the sidebar and the compact switcher both draw
    // `.config-sync-side-badge` and only one of them exists at a time.
    shell.style.setProperty("--cs-badge-digits", String(this.badgeDigits()));
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
    this.mainEl = shell.createDiv({ cls: "config-sync-main" });
    this.renderMainRegion();
    this.contentEl.scrollTop = scrollTop;
  }

  // Coalesces a burst of keystrokes into one trailing re-render —
  // `run` always closes over live view state (`this.search` etc.), never a value captured at
  // schedule time, so whichever keystroke is LAST when the timer fires is the one that renders;
  // an earlier, still-pending timer is cancelled outright rather than left to also fire.
  private debounceSearchRender(run: () => void): void {
    if (this.searchDebounceTimer !== null) window.clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = window.setTimeout(() => {
      this.searchDebounceTimer = null;
      run();
    }, SEARCH_DEBOUNCE_MS);
  }

  // Rebuilds only the main pane from the current panelSection. The sidebar search calls this (plus
  // an in-place sidebar section-list refresh) on each keystroke instead of render(), so the search
  // input and its autocomplete are never torn down mid-type.
  //
  // A pending debounced search re-render (see debounceSearchRender)
  // must never survive past THIS rebuild, no matter which of this method's callers triggered it.
  // Cancelling the timer at the top of render()/reload() would not be enough: two direct
  // callers (the cold-start banner's "Review settings →"/dismiss handlers, renderItemMode) bypass
  // both — they call renderMainRegion() straight, without going through render()/reload() first. A
  // realistic sequence — type in the compact search box (timer armed) then, within the debounce
  // window, tap the banner (first-run-on-a-phone territory, both visible together) — would leave
  // the timer to fire ~130ms later into DOM this call already replaced (main.empty() below), running
  // the compact path's stale renderPills/renderSectionsBody/refreshGlobalSelectAll closure against
  // detached elements. Cancelling HERE, at the top of the one method every caller (render(),
  // reload() via render(), the debounce's own trailing call, and both banner handlers) funnels
  // through, is the single choke point — render()/reload() carry no copy of their own
  // (single source of truth: one cancel to keep in sync, not three). Idempotent: by the
  // time the debounce's OWN trailing call reaches here, `debounceSearchRender` has already nulled
  // the field itself, so this is a harmless no-op on that path.
  private renderMainRegion(): void {
    if (this.searchDebounceTimer !== null) {
      window.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    const main = this.mainEl;
    if (main === null) return;
    const scrollTop = this.contentEl.scrollTop;
    main.empty();
    this.renderMainRegionBody(main);
    this.contentEl.scrollTop = scrollTop;
  }

  private renderMainRegionBody(main: HTMLElement): void {
    if (this.panelSection.kind === "self") {
      this.renderConfigSyncMode(main);
      return;
    }
    if (this.panelSection.kind === "history") {
      this.renderHistoryMode(main);
      return;
    }
    if (this.panelSection.kind === "remote") {
      const remote = this.host.remotes().find((x) => this.panelSection.kind === "remote" && x.name === this.panelSection.name);
      if (remote !== undefined) {
        this.renderRemoteMode(main, remote);
        return;
      }
      this.panelSection = { kind: "device", cat: "all" }; // remote vanished (settings change) — fall back
    }
    this.renderItemMode(main);
  }

  // The config-sync self layer lives in its own sidebar destination (the "Config Sync" entry),
  // not in the item list. This entry carries a direction badge; clicking it opens the pane.
  private renderSelfEntry(container: HTMLElement): void {
    const info = this.selfInfo;
    const active = this.panelSection.kind === "self";
    // A distinct hero card, not a stray list row: this is the plugin syncing its own settings to
    // the store — a meta destination separate from the config items below. The icon tile, title +
    // sublabel, and status pill echo the self-chip in the header and the self pane this opens.
    const card = container.createDiv({ cls: `config-sync-side-self${active ? " is-active" : ""}` });
    const tile = card.createSpan({ cls: "config-sync-side-self-ic" });
    setIcon(tile, "settings-2");
    const text = card.createDiv({ cls: "config-sync-side-self-text" });
    text.createDiv({ cls: "config-sync-side-self-title", text: "Config Sync" });
    text.createDiv({ cls: "config-sync-side-self-sub", text: "plugin settings ↔ store" });
    if (info !== null) {
      const pill = this.selfStatePill(info);
      if (pill !== null) card.createSpan({ cls: `config-sync-side-self-pill ${pill.cls}`, text: pill.text });
    }
    card.addEventListener("click", () => {
      this.panelSection = { kind: "self" };
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
  }

  private selfStatePill(info: SelfSyncInfo): { text: string; cls: string } | null {
    const adoptN = info.delta.added.length + info.delta.removed.length;
    const capN = info.delta.removed.length;
    switch (info.state) {
      case "coldstart":
        return { text: "not set up", cls: "is-down" };
      case "adopt":
        return { text: adoptN > 0 ? `${adoptN} to adopt` : "to adopt", cls: "is-down" };
      case "capture":
        return { text: capN > 0 ? `${capN} to capture` : "to capture", cls: "is-up" };
      case "both":
        return { text: "to adopt · to capture", cls: "is-up" };
      case "insync":
        // Content is in sync, but an older plugin here shouldn't read as "all good" —
        // the store's settings were captured on a newer Config Sync.
        return info.updateAvailable !== null ? { text: "update available", cls: "is-behind" } : { text: "in sync", cls: "is-ok" };
    }
  }

  private runSelfAdopt(btn: HTMLButtonElement): void {
    btn.disabled = true;
    btn.setText("Adopting…");
    void this.host.adoptConfiguration().then((results) => {
      if (results !== null) this.setLastRun("adopt", null, results);
      this.notifyExternalChange(); // recompute: the sync list changed
    });
  }

  private runSelfCapture(btn: HTMLButtonElement): void {
    btn.disabled = true;
    btn.setText("Capturing…");
    void this.host.captureItems([{ name: SELF_GROUP_NAME, action: "none" }]).then((results) => {
      if (results !== null) this.setLastRun("capture", null, results);
      this.notifyExternalChange();
    });
  }

  private renderSelfDelta(block: HTMLElement, added: string[], removed: string[]): void {
    if (added.length === 0 && removed.length === 0) return;
    const list = block.createDiv({ cls: "config-sync-self-delta" });
    const row = (glyph: string, cls: string, name: string): void => {
      const r = list.createDiv({ cls: `config-sync-self-drow ${cls}` });
      r.createSpan({ cls: "config-sync-self-dg", text: glyph });
      r.createSpan({ text: this.host.displayName(name, findGroupByName(this.groups, name)?.label) });
    };
    for (const name of added) row("+", "is-add", name);
    for (const name of removed) row("−", "is-del", name);
  }

  private openConfigSyncSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById("config-sync");
  }

  private openCommunityPlugins(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById("community-plugins");
  }

  // The Config Sync pane: the self layer's bidirectional adopt/capture surface (S0–S4).
  private renderConfigSyncMode(main: HTMLElement): void {
    const info = this.selfInfo;
    if (info === null) return;
    const pane = main.createDiv({ cls: "config-sync-self-pane" });
    const title = pane.createDiv({ cls: "config-sync-self-title" });
    const titleIc = title.createSpan({ cls: "config-sync-self-title-ic" });
    setIcon(titleIc, info.state === "coldstart" ? ACTION_ICON.apply : info.state === "capture" ? ACTION_ICON.capture : info.state === "both" ? "alert-triangle" : "settings");
    title.createSpan({ text: "Config Sync" });
    const pill = this.selfStatePill(info);
    if (pill !== null) title.createSpan({ cls: `config-sync-self-pill ${pill.cls}`, text: pill.text });
    title.createSpan({ cls: "config-sync-self-title-sp" });
    const cfgBtn = title.createEl("button", { cls: "config-sync-self-settings-btn", attr: { "aria-label": "Open settings" } });
    const cfgIc = cfgBtn.createSpan({ cls: "config-sync-self-settings-ic" });
    setIcon(cfgIc, "settings-2");
    cfgBtn.createSpan({ text: "Settings" });
    cfgBtn.addEventListener("click", () => this.openConfigSyncSettings());

    if (info.updateAvailable !== null) {
      // Advisory only — no update action: updating config-sync from inside a run would
      // unload the code executing the run, so the pane can only point at Obsidian's updater.
      const behind = pane.createDiv({ cls: "config-sync-self-behind" });
      behind.createSpan({
        cls: "config-sync-self-behind-txt",
        text: `Captured on Config Sync ${info.updateAvailable.store} — this device runs ${info.updateAvailable.local}. Update before adopting or applying.`,
      });
      const open = behind.createEl("button", { cls: "config-sync-self-behind-btn", text: "Open Community plugins" });
      open.addEventListener("click", () => this.openCommunityPlugins());
    }

    if (info.state === "coldstart") {
      if (!info.storePresent) {
        // A never-pulled fresh device has no store to adopt from yet — no "Found a
        // configuration" claim, no Adopt, no Capture caution.
        pane.createDiv({ cls: "config-sync-self-sub", text: "This is a new device — it has no sync list yet." });
        const block = pane.createDiv({ cls: "config-sync-self-block" });
        block.createDiv({ cls: "config-sync-self-block-h", text: "No store on this device yet" });
        const first = this.host.remotes()[0];
        if (first !== undefined) {
          const name = first.name;
          block.createDiv({
            cls: "config-sync-self-block-s",
            text: `Pull from ${name} first — that brings the store to this device; then adopt its configuration.`,
          });
          const acts = block.createDiv({ cls: "config-sync-self-acts" });
          const open = acts.createEl("button", { cls: "mod-cta", text: `Open ${name}` });
          open.addEventListener("click", () => {
            this.panelSection = { kind: "remote", name };
            this.switcherOpen = false;
            this.render(this.renderGen);
          });
        } else {
          block.createDiv({
            cls: "config-sync-self-block-s",
            text: "The store arrives with your regular vault sync, or add a remote in Settings and Pull.",
          });
        }
        return;
      }
      pane.createDiv({ cls: "config-sync-self-sub", text: "This is a new device — it has no sync list yet. The store holds a configuration you can adopt to set it up." });
      const block = pane.createDiv({ cls: "config-sync-self-block is-act" });
      const when = info.capturedAt === null ? "" : ` · captured ${isoAge(info.capturedAt)}`;
      block.createDiv({ cls: "config-sync-self-block-h", text: "Found a configuration in the store" });
      block.createDiv({ cls: "config-sync-self-block-s", text: `${info.itemCount} sync item${info.itemCount === 1 ? "" : "s"}${when}. Adopt sets up this device's list; then apply the items you want.` });
      block.createDiv({ cls: "config-sync-self-caution", text: "⚠ Don't Capture first — that would overwrite the store with this blank device's defaults." });
      const acts = block.createDiv({ cls: "config-sync-self-acts" });
      const adopt = acts.createEl("button", { cls: "mod-cta", text: "Adopt configuration" });
      adopt.addEventListener("click", () => this.runSelfAdopt(adopt));
      const not = acts.createEl("button", { text: "Not now" });
      not.addEventListener("click", () => {
        this.panelSection = { kind: "device", cat: "all" };
        this.render(this.renderGen);
      });
      return;
    }

    if (info.state === "insync") {
      pane.createDiv({ cls: "config-sync-self-sub", text: `The list of what this device syncs — ${info.itemCount} item${info.itemCount === 1 ? "" : "s"}, in sync with the store.` });
      // Post-adopt nudge: the list is set up but items may not
      // be applied to this device yet. Point at Apply (store → device), never Capture.
      const toApply = this.presentedCounts(this.countable(this.rows())).down;
      if (toApply > 0) {
        const block = pane.createDiv({ cls: "config-sync-self-block is-act" });
        block.createDiv({ cls: "config-sync-self-block-h", text: "Now set up this device" });
        block.createDiv({ cls: "config-sync-self-block-s", text: `${toApply} item${toApply === 1 ? "" : "s"} ready to apply from the store — Apply brings your settings and plugins onto this device.` });
        const acts = block.createDiv({ cls: "config-sync-self-acts" });
        const review = acts.createEl("button", { cls: "mod-cta", text: "Review what to apply" });
        review.addEventListener("click", () => {
          this.expandAllTypeSections();
          this.filter = "apply";
          this.panelSection = { kind: "device", cat: "all" };
          this.render(this.renderGen);
        });
      }
      return;
    }

    const sub = pane.createDiv({ cls: "config-sync-self-sub" });
    if (info.state === "both") sub.setText("Both your list and the store changed. Adopt first, then capture — capturing now would overwrite another device's list additions with this device's older list.");
    else if (info.state === "adopt") sub.setText("The list of what this device syncs changed in the store. Adopt to bring the new items onto this device; they then appear in your item list as normal, apply-able rows.");
    else sub.setText("You changed what this device syncs. Capture to publish it to the store, so your other devices can adopt it.");

    if (info.state === "adopt" || info.state === "both") {
      const block = pane.createDiv({ cls: "config-sync-self-block is-act" });
      block.createDiv({ cls: "config-sync-self-block-h", text: info.state === "both" ? "① Adopt updates from the store first" : "Updates from the store" });
      if (info.state === "adopt") block.createDiv({ cls: "config-sync-self-block-s", text: "Adopting adds these to this device's sync list — it does not apply their settings; you still choose that per item afterward." });
      if (info.delta.added.length > 0 || info.delta.removed.length > 0) {
        this.renderSelfDelta(block, info.delta.added, info.delta.removed);
        this.renderSelfViewChange(block, "apply");
      } else {
        this.renderSelfContentDetail(block, info, "apply"); // store's config-sync settings changed, not the list
      }
      const acts = block.createDiv({ cls: "config-sync-self-acts" });
      const adopt = acts.createEl("button", { cls: "mod-cta", text: "Adopt all" });
      adopt.addEventListener("click", () => this.runSelfAdopt(adopt));
    }

    if (info.state === "capture" || info.state === "both") {
      const gated = info.state === "both";
      const block = pane.createDiv({ cls: `config-sync-self-block${gated ? " is-gated" : ""}` });
      block.createDiv({ cls: "config-sync-self-block-h", text: gated ? "② Then capture your local change" : "Local changes not yet in the store" });
      if (info.delta.removed.length > 0) {
        this.renderSelfDelta(block, info.delta.removed, []); // your local-only groups
        block.createDiv({ cls: "config-sync-self-block-s", text: "These are in this device's sync list but not the store's — Capture publishes their definitions." });
        this.renderSelfViewChange(block, "capture");
      } else {
        this.renderSelfContentDetail(block, info, "capture"); // config-sync's own settings/version changed, not the list
      }
      const acts = block.createDiv({ cls: "config-sync-self-acts" });
      const cap = acts.createEl("button", { cls: "config-sync-btn-capture", text: "Capture" });
      if (gated) {
        cap.disabled = true;
        acts.createSpan({ cls: "config-sync-self-hint", text: "— available after adopting" });
      } else {
        cap.addEventListener("click", () => this.runSelfCapture(cap));
      }
    }
  }

  // When config-sync's own data.json changed (not the sync list), show what changed: a version
  // line for a plugin-update refresh, otherwise the data.json diff (so "what changed" is visible).
  private renderSelfContentDetail(block: HTMLElement, info: SelfSyncInfo, dir: Direction): void {
    if (info.versionRefresh !== null) {
      block.createDiv({
        cls: "config-sync-self-block-s",
        text: `Config Sync updated — this device ${info.versionRefresh.local} · store ${info.versionRefresh.store}. Capturing refreshes the store's recorded version.`,
      });
      return;
    }
    if (!info.contentChanged) {
      // No data.json diff to show; fill the capture block with the flags nudge if one is pending.
      if (dir === "capture" && info.flagsRefresh !== null) {
        const n = info.flagsRefresh;
        block.createDiv({
          cls: "config-sync-self-block-s",
          text: `${n} desktop-only plugin${n === 1 ? "" : "s"} not recorded in the store yet — capturing lets your phones skip installs that can't run there.`,
        });
      }
      return;
    }
    block.createDiv({ cls: "config-sync-self-block-s", text: "Config Sync's own settings changed:" });
    this.renderSelfDataJsonDiff(block.createDiv({ cls: "config-sync-inline-diff" }), dir);
  }

  private renderSelfDataJsonDiff(holder: HTMLElement, dir: Direction): void {
    void this.host.diffPair(SELF_GROUP_NAME, "", dir).then((pair) => {
      if (pair === null) {
        const selfGroup = findGroupByName(this.groups, SELF_GROUP_NAME);
        const text = selfGroup !== undefined && isWholeFileEncrypted(selfGroup) ? "encrypted file" : "no diff available";
        holder.createDiv({ cls: "config-sync-expand-note", text });
        return;
      }
      const leftLabel = dir === "capture" ? "store" : "this device";
      const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
      const sb = jsonSortedView(pair.base);
      const sp = jsonSortedView(pair.produced);
      const bothSorted = sb !== null && sp !== null;
      const base = bothSorted ? sb : pair.base;
      const produced = bothSorted ? sp : pair.produced;
      if (base === produced && pair.base !== pair.produced) {
        holder.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
        return;
      }
      renderDiffPanel(holder, base, produced, leftLabel, rightLabel, { name: "data.json", sorted: bothSorted },
        () => openDiffModal(this.app, base, produced, leftLabel, rightLabel, { name: "data.json", sorted: bothSorted }), null);
    });
  }

  private renderSelfViewChange(block: HTMLElement, dir: Direction): void {
    const open = this.selfDiffOpen.has(dir);
    const link = block.createDiv({ cls: "config-sync-self-viewchange" });
    renderFoldChevron(link, open, null);
    link.appendText(open ? "hide change (data.json)" : "view change (data.json)");
    link.addEventListener("click", () => {
      if (open) this.selfDiffOpen.delete(dir);
      else this.selfDiffOpen.add(dir);
      this.render(this.renderGen);
    });
    if (open) this.renderSelfDataJsonDiff(block.createDiv({ cls: "config-sync-inline-diff" }), dir);
  }

  private renderSidebar(shell: HTMLElement): void {
    const side = shell.createDiv({ cls: "config-sync-side" });
    const searchWrap = side.createDiv({ cls: "config-sync-search-wrap" });
    const searchEl = searchWrap.createEl("input", {
      type: "search",
      cls: "config-sync-side-search",
      attr: { placeholder: "Filter by name…" },
    });
    searchEl.value = this.search;
    if (this.panelSection.kind === "remote") searchEl.disabled = true;
    this.qac.attach(searchEl);
    // The section list lives in its own container so a keystroke can refresh its hit-count badges in
    // place — the search input (and the autocomplete anchored to it) stays put, keeping focus and
    // never blinking mid-type.
    this.sideSectionEl = side.createDiv({ cls: "config-sync-side-section" });
    this.renderSectionEntries(this.sideSectionEl);
    searchEl.addEventListener("input", () => {
      const wasSearching = this.searching();
      this.search = searchEl.value; // the field itself is native/instant — never waits on the render below
      if (!wasSearching && this.searching()) {
        this.filter = "all"; // searching means "find this item"
        this.expandAllTypeSections(); // transition into search: expand once so hits are discoverable
      }
      // The heavy part — sidebar hit badges + the whole main pane
      // (pills, list, sections all read this.search) — is debounced so a fast typist's in-between
      // keystrokes never pay for a render; `debounceSearchRender` always reads live `this.search`
      // when it fires, so the LAST keystroke in a burst is the one that settles, never a stale one.
      this.debounceSearchRender(() => {
        if (this.sideSectionEl !== null) {
          this.sideSectionEl.empty();
          this.renderSectionEntries(this.sideSectionEl);
        }
        this.renderMainRegion();
      });
    });
  }

  private renderSectionEntries(container: HTMLElement): void {
    this.renderSelfEntry(container);
    // No group heads anywhere in the sidebar: the self card's own "plugin settings ↔ store"
    // subtitle already carries the device↔store relation, and remotes sit behind their own
    // divider like every other group — re-checking them belongs to the main region's global
    // refresh button alone, and each remote row's state icon carries the result.
    container.createDiv({ cls: "config-sync-side-divider" });

    const deviceEntry = (cat: StorageSection | "beta" | "all", label: string, rows: StatusRow[]): void => {
      const active = this.panelSection.kind === "device" && this.panelSection.cat === cat;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      if (this.searching()) {
        // Hit counts span the entry's full scope, carriers included: a search is "find this item",
        // and a carrier IS findable (its own settings card is one click away through the section
        // chip) even though it never renders as a row. The bucket badges below deliberately count a
        // narrower set — `countable` — because those numbers must add up to the list.
        const sectionRows = cat === "all" ? this.rows() : this.rows().filter((r) => this.itemSectionOf(r.group.name) === cat);
        const hits = sectionRows.filter((r) => this.rowMatchesSearch(r)).length;
        item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${hits}` });
      } else {
        const c = this.presentedCounts(rows);
        if (c.up > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
        if (c.down > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
        // Same fixed-size Lucide glyphs the fold lines and the card draw (FATE_PILL_FOLD →
        // renderFoldCount), never hand-written `✓`/`⊘`/`○` text. Text glyphs put a DIFFERENT mark on
        // the same state depending on which surface you looked at, and `⊘` in particular ran into
        // the digit beside it with no room to breathe.
        if (c.ok > 0) renderFoldCount(item.createSpan({ cls: "config-sync-side-badge is-ok" }), FATE_PILL_FOLD.ok, c.ok);
        if (c.excluded > 0) renderFoldCount(item.createSpan({ cls: "config-sync-side-badge is-excluded" }), FATE_PILL_FOLD.excluded, c.excluded);
        if (c.none > 0) renderFoldCount(item.createSpan({ cls: "config-sync-side-badge is-none" }), FATE_PILL_FOLD.none, c.none);
      }
      item.addEventListener("click", () => {
        this.panelSection = { kind: "device", cat };
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    };

    deviceEntry("all", "All items", this.countable(this.rows()));
    for (const cat of ITEM_SECTION_ORDER) {
      const inCat = this.countable(this.rows()).filter((r) => this.itemSectionOf(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, ITEM_SECTION_LABELS[cat], inCat);
    }

    const remotes = this.host.remotes();
    if (remotes.length > 0) {
      container.createDiv({ cls: "config-sync-side-divider" });
      remotes.forEach((remote, idx) => {
        const active = this.panelSection.kind === "remote" && this.panelSection.name === remote.name;
        const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
        item.createSpan({ cls: "config-sync-side-name", text: remote.name });
        const prog = this.host.remoteRefreshProgress();
        if (prog !== null && idx >= prog.done) {
          const s = item.createSpan({ cls: "config-sync-state-icon config-sync-row-checking" });
          s.createSpan({ cls: "config-sync-cmp-spinner" });
        } else {
          const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
          this.paintStateIcon(item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } }), icon);
        }
        item.addEventListener("click", () => {
          this.panelSection = { kind: "remote", name: remote.name };
          this.switcherOpen = false;
          this.render(this.renderGen);
        });
      });
    }

    if (this.host.runHistoryEnabled()) {
      container.createDiv({ cls: "config-sync-side-divider" });
      const active = this.panelSection.kind === "history";
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      // No count badge. Every other badge in this sidebar is a number of things waiting for you
      // (↑ to capture, ✓ in sync); History's was the number of records kept, which is a cap, not a
      // to-do — the same position saying two different kinds of thing.
      item.createSpan({ cls: "config-sync-side-name", text: "History" });
      item.addEventListener("click", () => {
        this.panelSection = { kind: "history" };
        this.historyOpen = null;
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    }
  }

  // Compact replacement for the sidebar: current section as a button; dropdown mirrors the sidebar.
  private renderSwitcher(shell: HTMLElement): void {
    const sw = shell.createDiv({ cls: "config-sync-switcher" });
    if (this.panelSection.kind === "device") {
      const cat = this.panelSection.cat;
      sw.createSpan({ text: cat === "all" ? "All items" : ITEM_SECTION_LABELS[cat] });
      const c = this.presentedCounts(this.countable(this.sectionRows()));
      if (c.up > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
      if (c.down > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
      if (c.ok > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-ok" }), FATE_PILL_FOLD.ok, c.ok);
      if (c.excluded > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-excluded" }), FATE_PILL_FOLD.excluded, c.excluded);
      if (c.none > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-none" }), FATE_PILL_FOLD.none, c.none);
    } else if (this.panelSection.kind === "history") {
      sw.createSpan({ text: "History" });
    } else if (this.panelSection.kind === "self") {
      setIcon(sw.createSpan({ cls: "config-sync-switcher-selfic" }), "settings-2");
      sw.createSpan({ text: "Config Sync" });
    } else {
      sw.createSpan({ text: this.panelSection.name });
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelSection.name)?.check);
      this.paintStateIcon(sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}` }), icon);
    }
    setIcon(sw.createSpan({ cls: `config-sync-switcher-chev${this.switcherOpen ? " is-open" : ""}` }), "chevrons-up-down");
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      this.switcherOpen = !this.switcherOpen;
      this.render(this.renderGen);
    });
    if (this.switcherOpen) {
      const menu = shell.createDiv({ cls: "config-sync-switcher-menu" });
      this.renderSectionEntries(menu);
    }
  }

  // The self chip for the global status bar (Layout B): Config Sync's own state,
  // always shown (green check when in sync) so mobile can confirm self status
  // even with the sidebar collapsed. Reuses selfStatePill so the pane and the
  // header can't drift. Clicking opens the self pane.
  private renderSelfChip(parent: HTMLElement): void {
    const info = this.selfInfo;
    if (info === null) return;
    const pill = this.selfStatePill(info);
    if (pill === null) return;
    const chip = parent.createSpan({ cls: `config-sync-self-chip ${pill.cls}`, attr: { "aria-label": `Config Sync: ${pill.text}` } });
    const ic = chip.createSpan({ cls: "config-sync-self-chip-ic" });
    setIcon(ic, pill.cls === "is-ok" ? "check" : pill.cls === "is-behind" ? "arrow-down-to-line" : "settings");
    chip.createSpan({ text: pill.text });
    chip.addEventListener("click", () => {
      this.panelSection = { kind: "self" };
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
  }

  private renderHeader(): void {
    // No title span: the pane header already reads "Sync Center".
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    this.renderSelfChip(head);
    if (this.selfInfo !== null) head.createSpan({ cls: "config-sync-head-divider" });
    const { up, down, ok, excluded, none } = this.presentedCounts(this.countable(this.rows()));
    const remoteStates = this.host.remotes().map((r) => this.host.remoteCheck(r.name)?.check.state ?? "unknown");
    const { push, pull } = remoteDirectionCounts(remoteStates);
    const pills = head.createSpan({ cls: "config-sync-report-pills" });
    if (up > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-up", attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` } }),
        "capture", up,
      );
    }
    if (down > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-down", attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` } }),
        "apply", down,
      );
    }
    if (push > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-push", attr: { "aria-label": `${push} remote${push === 1 ? "" : "s"} to push` } }),
        "push", push,
      );
    }
    if (pull > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-pull", attr: { "aria-label": `${pull} remote${pull === 1 ? "" : "s"} to pull` } }),
        "pull", pull,
      );
    }
    renderFoldCount(
      pills.createSpan({ cls: "config-sync-pill is-ok", attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` } }),
      FATE_PILL_FOLD.ok, ok,
    );
    // Mirrors the ok/none pills' own shape — unconditional-count vs.
    // N=0-suppressed is inconsistent between ok (always shown) and none (suppressed) even today;
    // `excluded` follows `none`'s precedent (suppressed at 0), matching the explicit
    // empty-state rule for the FILTER pill, applied consistently here too.
    if (excluded > 0) {
      renderFoldCount(
        pills.createSpan({
          cls: "config-sync-pill is-excluded",
          attr: { "aria-label": `${excluded} item${excluded === 1 ? "" : "s"} not synced on this device` },
        }),
        FATE_PILL_FOLD.excluded, excluded,
      );
    }
    if (none > 0) {
      renderFoldCount(
        pills.createSpan({
          cls: "config-sync-pill is-none",
          attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
        }),
        FATE_PILL_FOLD.none, none,
      );
    }
    // Manual refresh: re-scans local state, catching plugin toggles made in Obsidian's
    // settings modal while the panel stayed open, and re-checks every remote (desktop only).
    // The refreshed-age lives in this button's tooltip, recomputed on each render.
    // Every re-render reads the CURRENT busy state (refreshView), so the mid-refresh rebuilds the
    // refresh itself provokes redraw the spin instead of erasing it.
    renderRefreshButton(head, this.refreshView(), () => void this.runRefresh());
  }

  private refreshView(): RefreshView {
    return {
      // Either half counts as busy: this view's own gesture, or a remote sweep some other surface
      // (the command, the status bar) kicked off while the panel was open.
      busy: this.refreshing || this.host.remoteRefreshProgress() !== null,
      age: this.lastRefreshedAt === null ? null : relativeAge(this.lastRefreshedAt),
    };
  }

  // Repaints every refresh control currently on screen without a render — the button has to start
  // spinning on the same tick as the click, and `reload()` does not touch the DOM until it ends.
  private paintRefresh(): void {
    for (const el of Array.from(this.contentEl.querySelectorAll(`.${REFRESH_BUTTON_CLASS}`))) {
      paintRefreshButton(el as HTMLElement, this.refreshView());
    }
  }

  // The whole gesture, both halves. Re-entrant clicks are dropped rather than queued: the remote
  // half already de-dupes (main.ts's refreshRemoteChecks returns the in-flight run), but the local
  // half does not, and a second full re-scan of every item buys nothing the first one is not
  // already about to deliver.
  private async runRefresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.paintRefresh();
    const startedAt = Date.now();
    try {
      await this.host.refreshRemoteChecks(); // desktop: re-checks every remote (and reloads via notify)
      await this.reload();                   // mobile no-ops the above; ensure local still refreshes
    } finally {
      await this.holdSpin(Date.now() - startedAt);
      this.refreshing = false;
      this.paintRefresh();
    }
  }

  // A one-line wrapper so the floor's timer is a seam the tests can stand in for, the same way they
  // already stand in for the repaints — the pane's only browser timer is not worth a DOM
  // environment to assert the re-entrancy guard around it.
  private holdSpin(elapsed: number): Promise<void> {
    return holdSpin(elapsed);
  }

  // The run's report is recorded to history and surfaced in the inline strip; the strip
  // expands by default when the outcome isn't clean — never a silent-looking
  // green success hiding failures behind "details".
  private setLastRun(kind: RunKind, remote: string | null, results: GroupResult[] | null): void {
    if (results === null) return;
    this.lastRun = { kind, remote, results, expanded: worstStatus(results) !== "ok" };
    void this.host.appendRunHistory(kind, remote, results);
  }

  private runTitle(kind: RunKind, remote: string | null): string {
    switch (kind) {
      case "capture": return "Captured";
      case "apply": return "Applied";
      case "pull": return `Pulled from ${remote ?? ""}`;
      case "push": return `Pushed to ${remote ?? ""}`;
      case "adopt": return "Adopted";
      default: return ""; // removal kinds never use the inline run strip
    }
  }

  private statusIcon(status: RunStatus): string {
    return status === "error" ? "✗" : status === "warning" ? "⚠" : "✓";
  }

  private renderResultStrip(main: HTMLElement): void {
    const run = this.lastRun;
    if (run === null) return;
    // Severity split: only a genuine failure
    // (tone "issue") flips the strip to issue tone; a benign success-side note (e.g. the
    // version-fallback line) stays success-framed with its own amber count instead of reading
    // as a failure. See reportContent.stripHeader/resultLevel's doc comments for the mapping.
    const { issues, notes, tone } = stripHeader(run.results);
    const cls = tone === "issue" ? " is-error" : "";
    // Sticky dock: an opaque backing pins the strip to the top of the scroll viewport so the
    // outcome stays visible even when the user is scrolled to the bottom of a long list.
    const dock = main.createDiv({ cls: "config-sync-strip-dock" });
    const strip = dock.createDiv({ cls: `config-sync-strip${cls}` });
    const head = strip.createDiv({ cls: "config-sync-strip-head" });
    head.createSpan({ cls: "config-sync-strip-check", text: tone === "issue" ? "✗" : "✓" });
    head.createSpan({ cls: "config-sync-strip-title", text: this.runTitle(run.kind, run.remote) });
    if (tone === "issue") {
      head.createSpan({ cls: "config-sync-strip-title", text: ` with ${issues} issue${issues === 1 ? "" : "s"}` });
    } else if (tone === "note") {
      head.createSpan({ cls: "config-sync-strip-notecount", text: ` · ${notes} note${notes === 1 ? "" : "s"}` });
    }
    const meta = head.createDiv({ cls: "config-sync-strip-meta" });
    renderReportPills(meta, run.results);
    const toggle = meta.createSpan({ cls: "config-sync-strip-toggle" });
    toggle.appendText("details");
    renderFoldChevron(toggle, run.expanded, null);
    toggle.addEventListener("click", () => {
      run.expanded = !run.expanded;
      this.render(this.renderGen);
    });
    const open = meta.createSpan({ cls: "config-sync-strip-toggle", text: "open in history →" });
    open.addEventListener("click", () => {
      this.panelSection = { kind: "history" };
      this.historyOpen = 0; // the run just recorded is newest
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
    const close = head.createSpan({ cls: "config-sync-strip-close" });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      this.lastRun = null;
      this.render(this.renderGen);
    });
    if (run.expanded) {
      renderReportContent(strip.createDiv({ cls: "config-sync-strip-body" }), run.results, {
        labelFor: (g) => this.host.displayName(g, findGroupByName(this.groups, g)?.label),
        onReload: () => this.host.reloadApp(),
      });
    }
  }

  // ── Run history browser ─────────────────────────────────────────────────────────────────
  private actionCell(rec: RunRecord): { glyph: string; dir: "in" | "out" | "remove"; label: string; action?: SyncAction } {
    if (rec.kind === "stop-sync") return { glyph: "⊘", dir: "remove", label: "Stop syncing" };
    if (rec.kind === "delete-leftover") return { glyph: "⌫", dir: "remove", label: "Delete leftover" };
    const out = rec.kind === "capture" || rec.kind === "push";
    const base = rec.kind.charAt(0).toUpperCase() + rec.kind.slice(1);
    const label = rec.remote !== null ? `${base} · ${rec.remote}` : base;
    // Per-action icons so history matches the panel's
    // vocabulary; adopt maps to the apply icon (like the self-badge), and any unmapped
    // kind falls back to the text glyph.
    const action = ACTION_CELL_MAP[rec.kind];
    return { glyph: out ? "↑" : "↓", dir: out ? "out" : "in", label, action };
  }

  private renderHistoryMode(main: HTMLElement): void {
    const open = this.historyOpen !== null ? this.history[this.historyOpen] : undefined;
    if (open !== undefined) {
      this.renderHistoryDetail(main, open);
      return;
    }
    this.historyOpen = null;
    this.renderHistoryHead(main);
    if (this.history.length === 0) {
      main.createDiv({ cls: "config-sync-hempty", text: "No runs recorded yet." });
      return;
    }
    this.renderHistoryLegend(main);
    if (this.compact) this.renderHistoryCards(main);
    else this.renderHistoryTable(main);
  }

  private renderHistoryHead(main: HTMLElement): void {
    const head = main.createDiv({ cls: "config-sync-hhead" });
    head.createSpan({ cls: "config-sync-hhead-title", text: "History" });
    head.createSpan({ cls: "config-sync-hhead-count", text: `${this.history.length} run${this.history.length === 1 ? "" : "s"}` });
    if (this.history.length > 0) {
      const clear = head.createSpan({ cls: "config-sync-hclear", text: "Clear all" });
      clear.addEventListener("click", () => {
        void (async () => {
          await this.host.clearRunHistory();
          this.history = [];
          this.render(this.renderGen);
        })();
      });
    }
  }

  private renderHistoryLegend(main: HTMLElement): void {
    const legend = main.createDiv({ cls: "config-sync-hlegend" });
    const leg = (cls: string, glyph: string, text: string): void => {
      const s = legend.createSpan();
      s.createSpan({ cls: `config-sync-hstat ${cls}`, text: glyph });
      s.appendText(` ${text}`);
    };
    leg("is-ok", "✓", "Done"); leg("is-warn", "⚠", "Action needed"); leg("is-error", "✗", "Failed");
  }

  private renderActionInto(el: HTMLElement, rec: RunRecord): void {
    const act = this.actionCell(rec);
    if (act.action !== undefined) setIcon(el.createSpan({ cls: `config-sync-hglyph ${ACTION_COLOR_CLASS[act.action]}` }), ACTION_ICON[act.action]);
    else el.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
    el.appendText(` ${act.label}`);
  }

  private renderHistoryTable(main: HTMLElement): void {
    const table = main.createEl("table", { cls: "config-sync-htable" });
    const thead = table.createEl("thead").createEl("tr");
    for (const h of ["", "When", "Action", "Changed", "Issues", "Summary", ""]) thead.createEl("th", { text: h });
    const body = table.createEl("tbody");
    this.history.forEach((rec, i) => {
      const tr = body.createEl("tr", { cls: "config-sync-hrow" });
      const st = this.statusTip(rec.status);
      tr.createEl("td", { cls: "config-sync-htd-st" }).createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status), attr: { "aria-label": st } });
      tr.createEl("td", { cls: "config-sync-htd-when", text: formatRunTime(rec.at) });
      this.renderActionInto(tr.createEl("td", { cls: "config-sync-htd-act" }), rec);
      tr.createEl("td", { cls: "config-sync-htd-num", text: `${rec.changed}` });
      const iss = tr.createEl("td", { cls: `config-sync-htd-num${rec.issues > 0 ? " is-issues" : ""}` });
      iss.setText(rec.issues > 0 ? `${rec.issues}` : "—");
      tr.createEl("td", { cls: "config-sync-htd-sum", text: rec.desc });
      tr.createEl("td", { cls: "config-sync-htd-chev", text: "›" });
      tr.addEventListener("click", () => {
        this.historyOpen = i;
        this.render(this.renderGen);
      });
    });
  }

  private renderHistoryCards(main: HTMLElement): void {
    this.history.forEach((rec, i) => {
      const card = main.createDiv({ cls: "config-sync-hcard" });
      const top = card.createDiv({ cls: "config-sync-hcard-top" });
      top.createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status), attr: { "aria-label": this.statusTip(rec.status) } });
      this.renderActionInto(top.createSpan({ cls: "config-sync-hcard-act" }), rec);
      top.createSpan({ cls: "config-sync-hcard-chev", text: "›" });
      card.createDiv({ cls: "config-sync-hcard-when", text: formatRunTime(rec.at) });
      card.createDiv({ cls: "config-sync-hcard-sum", text: rec.desc });
      const foot = card.createDiv({ cls: "config-sync-hcard-foot" });
      foot.createSpan({ cls: "config-sync-hcard-pill is-chg", text: `${rec.changed} changed` });
      if (rec.issues > 0)
        foot.createSpan({ cls: "config-sync-hcard-pill is-iss", text: `⚠ ${rec.issues} issue${rec.issues === 1 ? "" : "s"}` });
      card.addEventListener("click", () => {
        this.historyOpen = i;
        this.render(this.renderGen);
      });
    });
  }

  private renderHistoryDetail(main: HTMLElement, rec: RunRecord): void {
    const back = main.createDiv({ cls: "config-sync-hback", text: "‹ Back to history" });
    back.addEventListener("click", () => {
      this.historyOpen = null;
      this.render(this.renderGen);
    });
    const rhead = main.createDiv({ cls: "config-sync-hdhead" });
    rhead.createSpan({ cls: `config-sync-hstat ${STATUS_CLS[rec.status]}`, text: this.statusIcon(rec.status) });
    rhead.createSpan({ cls: "config-sync-hdtitle", text: this.actionCell(rec).label });
    rhead.createSpan({ cls: "config-sync-hdwhen", text: formatRunTime(rec.at) });
    main.createDiv({ cls: "config-sync-hddesc", text: rec.desc });
    if (rec.kind === "stop-sync" || rec.kind === "delete-leftover") {
      // Removals carry no per-group report — list what was removed / deleted instead.
      const section = (title: string, rows: string[], mono: boolean): void => {
        if (rows.length === 0) return;
        main.createDiv({ cls: "config-sync-sect", text: title });
        for (const row of rows) main.createDiv({ cls: mono ? "config-sync-hd-affpath" : "config-sync-hd-affname", text: row });
      };
      section("Removed", rec.removed ?? [], false);
      section("Deleted from store", rec.deletedFiles ?? [], true);
      return;
    }
    renderReportContent(main.createDiv(), rec.results, {
      labelFor: (g) => this.host.displayName(g, findGroupByName(this.groups, g)?.label),
      onReload: () => this.host.reloadApp(),
    });
  }

  private statusTip(status: RunStatus): string {
    return status === "error" ? "Failed — some items couldn't run" : status === "warning" ? "Action needed — finish some items manually" : "Done — all succeeded";
  }

  private sectionKey(): string {
    if (this.panelSection.kind === "device") return this.panelSection.cat;
    if (this.panelSection.kind === "history") return "history";
    if (this.panelSection.kind === "self") return "self";
    return `remote:${this.panelSection.name}`;
  }

  private searching(): boolean {
    return this.search.trim() !== "";
  }

  // Total over SYNC_QUALIFIER_SPECS' keys by type (see the specs' comment): the spec list and this
  // map are the two halves of one vocabulary and must always move together.
  private syncResolvers(): Record<SyncQualifierKey, QualifierResolver<StatusRow>> {
    return {
      type: (r) => syncTypeValue(r.group),
      section: (r) => this.itemSectionOf(r.group.name),
      action: (r) => syncActionValue(this.rowBucket(r)),
      mode: (r) => syncModeValue(r.group),
      device: (r) => r.group.devices,
    };
  }

  // A family row matches search on the parent's own name/label OR any companion's (dissolved
  // companions must stay findable by their own name even though they no longer render
  // their own row).
  //
  // Memoized per render cycle, keyed by group name (cleared
  // alongside rowDerivationCache — see render()/reload()) — live-measured as the dominant
  // per-keystroke cost. This text depends only on the row's own group/label and its companions,
  // never on the query, so recomputing it on every one of a keystroke's several full-row-list
  // passes (sidebar per-section badges, filter pills, each type section) was pure waste: each call
  // re-walks `familyCompanions`, which itself rescans every compiled group via
  // `host.companionParentOf` — on a 100+ row vault that's tens of thousands of redundant calls
  // for a single keystroke.
  private familySearchText(r: StatusRow): string {
    const cached = this.searchTextCache.get(r.group.name);
    if (cached !== undefined) return cached;
    const parts = [this.fullName(r.group.name, r.group.label), r.group.name];
    for (const c of this.familyCompanions(r.group.name)) parts.push(this.fullName(c.group.name, c.group.label), c.group.name);
    const text = parts.join(" ");
    this.searchTextCache.set(r.group.name, text);
    return text;
  }

  private rowMatchesSearch(r: StatusRow): boolean {
    const parsed = parseQuery(this.search, SYNC_QUALIFIER_KEYS);
    return matchesQualifiers(r, parsed.qualifiers, this.syncResolvers()) && matchesSearch(this.familySearchText(r), parsed.text);
  }

  private sectionRows(): StatusRow[] {
    if (this.searching()) return this.rows();
    if (this.panelSection.kind !== "device" || this.panelSection.cat === "all") return this.rows();
    const cat = this.panelSection.cat;
    return this.rows().filter((r) => this.itemSectionOf(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    // Newer-schema refusal, in the cold-start banner's own structure with no primary action: there is
    // nothing to click here, and no dismiss either — this is a standing condition the user can
    // only clear by updating Config Sync, not a nudge to be waved away. It takes the banner slot
    // outright: while it holds, "this device hasn't synced yet" is not the story to tell.
    // The wording is the same sentence `SCHEMA_FUTURE_NOTICE`
    // (core/settingsMigration.ts) carries into every refused write; the split below is only the
    // bold-lead presentation the cold-start banner already uses, so the two must stay identical.
    const schemaStop = this.host.schemaStop();
    if (schemaStop !== null) {
      const banner = main.createDiv({ cls: "config-sync-coldstart-banner" });
      const txt = banner.createDiv({ cls: "config-sync-coldstart-text" });
      txt.createSpan({ cls: "config-sync-coldstart-head", text: "These settings were written by a newer Config Sync. " });
      txt.createSpan({ text: "Update Config Sync on this device to open them. Nothing has been changed." });
    } else if (this.selfInfo !== null && showColdStartBanner(this.selfInfo.state, [...this.statuses.values()], this.host.coldStartDismissed())) {
      const banner = main.createDiv({ cls: "config-sync-coldstart-banner" });
      const txt = banner.createDiv({ cls: "config-sync-coldstart-text" });
      txt.createSpan({ cls: "config-sync-coldstart-head", text: "This device hasn't synced with the store yet. " });
      txt.createSpan({ text: "Adopt the plugin settings first — they carry the device rules that make the diffs below trustworthy — then review and apply." });
      const actions = banner.createDiv({ cls: "config-sync-coldstart-actions" });
      const go = actions.createEl("button", { cls: "config-sync-coldstart-go", text: "Review settings →" });
      go.addEventListener("click", () => {
        this.panelSection = { kind: "self" };
        this.renderMainRegion();
      });
      const close = actions.createEl("button", { cls: "config-sync-coldstart-x" });
      setIcon(close, "x");
      close.addEventListener("click", () => {
        this.host.setColdStartDismissed(true);
        this.renderMainRegion();
      });
    }
    this.renderResultStrip(main);
    // The Leftover filter only exists while its section does — deleting the last orphan (or the
    // adoption gate engaging) with the filter active would otherwise strand an empty view.
    if (this.filter === "leftover" && this.leftoverPresentation() !== "section") this.filter = "all";
    const inSection = this.sectionRows();
    // Same producer the header pills and sidebar badges read (`countable`) — the three used to
    // disagree, and this is the one place that disagreement was visible on a single screen.
    const pillPool = this.countable(inSection);
    const bar = main.createDiv({ cls: "config-sync-mainbar" });
    const pillRow = bar.createDiv({ cls: "config-sync-fpillrow" });
    let searchEl: HTMLInputElement | null = null;
    if (this.compact) {
      const searchWrap = bar.createDiv({ cls: "config-sync-search-wrap" });
      searchEl = searchWrap.createEl("input", {
        type: "search",
        cls: "config-sync-mainbar-search",
        attr: { placeholder: "Filter by name…" },
      });
      searchEl.value = this.search;
    }
    const selectAll = bar.createEl("input", { type: "checkbox", cls: "config-sync-selectall", attr: { "aria-label": "Select all visible items" } });
    const sectionsHost = main.createDiv();

    // Pills recompute from the live search term. While searching, they count the MATCHED
    // set: the All pill keeps the unfiltered total as "n / m".
    const renderPills = (): void => {
      pillRow.empty();
      const pillRows = this.searching()
        ? pillPool.filter((r) => this.rowMatchesSearch(r))
        : pillPool;
      const counts = this.presentedCounts(pillRows);
      // Mobile shows the short glyph form — the panel's icon language (↑ ↓ ✓ ○) —
      // so all five pills always fit one line; desktop keeps the full labels. The
      // ok/excluded/none short forms render the same fixed-size Lucide icon the fold lines use
      // (foldIcons.ts) instead of a text glyph — this is the one place the three glyphs sit side
      // by side, so a text glyph here would optically mismatch the fold lines.
      const allLabel = this.searching() ? `All ${pillRows.length} / ${pillPool.length}` : `All ${pillPool.length}`;
      const defs: { key: PanelFilter; label: string; short: string; action?: SyncAction; foldKind?: FoldKind; count?: number }[] = [
        { key: "all", label: allLabel, short: allLabel },
        { key: "capture", label: `To capture ${counts.up}`, short: "", action: "capture", count: counts.up },
        { key: "apply", label: `To apply ${counts.down}`, short: "", action: "apply", count: counts.down },
        { key: "ok", label: `In sync ${counts.ok}`, short: "", foldKind: "insync", count: counts.ok },
        // "Not synced here" — deliberately not "Skipped"
        // (that word is already run-event vocabulary, `⚠ update skipped` ConfigSyncCore.ts, and
        // this is a standing state, not a run outcome). Empty state: N=0 renders neither this pill
        // nor the matching fold (matching ✓/○'s fold-suppression precedent).
        ...(counts.excluded > 0
          ? [{ key: "excluded" as const, label: `Not synced here ${counts.excluded}`, short: "", foldKind: "excluded" as const, count: counts.excluded }]
          : []),
        { key: "none", label: `No settings yet ${counts.none}`, short: "", foldKind: "nosettings", count: counts.none },
      ];
      for (const d of defs) {
        const pill = pillRow.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, attr: { "aria-label": d.label } });
        pill.createSpan({ cls: "config-sync-fpill-long", text: d.label });
        const shortEl = pill.createSpan({ cls: "config-sync-fpill-short" });
        if (d.action !== undefined) renderActionCount(shortEl, d.action, d.count ?? 0);
        else if (d.foldKind !== undefined) renderFoldCount(shortEl, d.foldKind, d.count ?? 0);
        else shortEl.setText(d.short);
        pill.addEventListener("click", () => {
          // Transition into a non-"all" filter: expand every section once so the pill's hits are
          // discoverable (auto-expand-on-activation, not a per-render override).
          if (d.key !== this.filter && d.key !== "all") this.expandAllTypeSections();
          this.filter = d.key;
          this.render(this.renderGen);
        });
      }
      // The Leftover pill (DESIGN.md §4 Leftover): conditional — it renders only while the store
      // actually has orphans this device may judge (the adoption gate hides it with the section),
      // amber, last in the row. Click narrows the view to the Leftover section alone; the store
      // orphans behind it are a section, never rows, so no bucket answers this filter.
      if (!this.searching() && this.leftoverPresentation() === "section") {
        const n = this.leftovers.length;
        const label = `Leftover ${n}`;
        const pill = pillRow.createEl("button", {
          cls: `config-sync-fpill is-leftover${this.filter === "leftover" ? " is-active" : ""}`,
          attr: { "aria-label": label },
        });
        pill.createSpan({ cls: "config-sync-fpill-long", text: label });
        pill.createSpan({ cls: "config-sync-fpill-short", text: `⌫ ${n}` });
        pill.addEventListener("click", () => {
          // Auto-expand on activation, same rule as the type sections' filter transition — a
          // manual re-collapse inside the leftover view still sticks.
          if (this.filter !== "leftover") this.leftoverOpen = true;
          this.filter = "leftover";
          this.render(this.renderGen);
        });
      }
    };

    // One flat row list per type section — this only decides which section a row lands in.
    const renderSectionsBody = (): void => {
      sectionsHost.empty();
      // The Leftover filter shows the orphan section alone — type sections all hide.
      if (this.filter !== "leftover") {
        // Computed ONCE for the whole pass and handed down: each head's hint depends on how many
        // OTHER sections are staged, which no single section can see for itself.
        const stagedSections = this.stagedSectionCount(inSection);
        for (const ts of TYPE_SECTION_ORDER) this.renderTypeSection(sectionsHost, ts, inSection, stagedSections);
      }
      // Store orphans: unrelated to any type section — they have no registry item to compile a
      // row for — so their section renders under the All and Leftover views only (never inside a
      // focused direction filter or a search pass). While the plugin's own configuration is still
      // pending adoption, "leftover" is not a judgment this device can make: the section gives
      // way to one quiet hint line (DESIGN.md §4 Leftover).
      if ((this.filter === "all" || this.filter === "leftover") && !this.searching()) {
        const lo = this.leftoverPresentation();
        if (lo === "section") this.renderLeftoverSection(sectionsHost);
        else if (lo === "hint") sectionsHost.createDiv({ cls: "config-sync-leftover-hint", text: LEFTOVER_ADOPT_HINT });
      }
    };

    renderPills();
    renderSectionsBody();
    this.wireGlobalSelectAll(selectAll, pillPool);

    // The compact search co-renders everything except its own input element, so the soft
    // keyboard stays open while pills, sections and select-all track the search.
    if (searchEl !== null) {
      const input = searchEl;
      input.addEventListener("input", () => {
        const wasSearching = this.searching();
        this.search = input.value; // the field itself is native/instant — never waits on the render below
        // Entering a search resets the direction filter: searching means "find this item".
        if (!wasSearching && this.searching()) {
          this.filter = "all";
          this.expandAllTypeSections(); // transition into search: expand once so hits are discoverable
        }
        // Same trailing debounce as the desktop sidebar search — this
        // is the mobile/narrow-pane path, at least as latency-sensitive as desktop.
        this.debounceSearchRender(() => {
          renderPills();
          renderSectionsBody();
          this.refreshGlobalSelectAll(selectAll, pillPool);
        });
      });
      this.qac.attach(searchEl);
    }

    this.renderActionBar(main);
  }

  // Entering a filtered/search view auto-expands every section ONCE, on
  // the filter/search state TRANSITION (called from the pill-click/search-input handlers below,
  // never from render itself) — so a filtered hit is discoverable without the section header
  // click losing its effect for the rest of that filtered/search session.
  private expandAllTypeSections(): void {
    for (const ts of TYPE_SECTION_ORDER) this.typeSectionOpen.add(ts);
  }

  // One producer for "which rows belong to this section, and which of them survive the current
  // search/filter" — the head's count pill needs both halves, and stagedSectionCount needs the
  // second, so deriving it twice is how the hint and the section it sits on would come to disagree.
  private typeSectionRows(inSection: StatusRow[], ts: TypeSection): { rows: StatusRow[]; visible: StatusRow[] } {
    const rows = inSection.filter((r) => !ENABLEMENT_CARRIER_GROUPS.has(r.group.name) && typeSectionForRow(this.itemSectionOf(r.group.name)) === ts);
    const matches = this.searching() ? rows.filter((r) => this.rowMatchesSearch(r)) : rows;
    return { rows, visible: matches.filter((r) => visibleUnderFilter(this.rowBucket(r), this.filter)) };
  }

  // How many type sections currently hold a staged row. Counted over VISIBLE rows, the same set
  // each head counts, so a section whose staged rows are filtered out of view cannot keep its
  // neighbour's hint alive from off-screen.
  private stagedSectionCount(inSection: StatusRow[]): number {
    let n = 0;
    for (const ts of TYPE_SECTION_ORDER) {
      const { visible } = this.typeSectionRows(inSection, ts);
      if (visible.some((r) => this.selected.has(r.group.name) && this.fateFor(r).stageable)) n++;
    }
    return n;
  }

  // One of the four fixed type sections: a fold containing every row whose section maps
  // here via typeSectionForRow, alphabetical within (rows() already sorts by section then name).
  // The self item is pinned first in Community, outside the row/Fate machinery entirely.
  // `stagedSections` is the whole pass's count of sections holding a staged row — a section head
  // cannot see its neighbours, and its hint depends on them.
  private renderTypeSection(host: HTMLElement, ts: TypeSection, inSection: StatusRow[], stagedSections: number): void {
    const { rows, visible } = this.typeSectionRows(inSection, ts);
    const showSelf = ts === "community" && this.selfInfo !== null && this.filter === "all" && !this.searching();
    if (visible.length === 0 && !showSelf) return; // sections with nothing to show hide entirely
    const filtered = this.filter !== "all" || this.searching();
    // `open` reads ONLY typeSectionOpen — a filter/search never forces
    // every section open on every render (that would make the header click's toggle invisible the
    // moment any filter pill or search was active — a decorative triangle).
    // Filtered hits stay discoverable instead via expandAllTypeSections(), called once on the
    // filter/search TRANSITION (see the pill/search-input handlers below), not on every render —
    // so a manual collapse inside an already-filtered view sticks.
    const open = this.typeSectionOpen.has(ts);
    const fold = host.createDiv({ cls: `config-sync-section is-typesection is-${ts}${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    const chevron = renderFoldChevron(head, open, null);
    head.createSpan({ cls: "config-sync-section-title", text: TYPE_SECTION_TITLES[ts] });
    // One compact form on every platform: "6/31" — the longer "6 of 31" says the same thing
    // in more ink.
    head.createSpan({
      cls: "config-sync-pill is-neutral",
      text: sectionCountLabel(rows.length, visible.length, filtered),
    });
    // Core/Community's carrier chip: inline in the head on every platform
    // — same full-text shape on desktop and mobile
    // (renderCarrierChip's own doc comment), so the head still fits on one line without a
    // dedicated meta line.
    const carrierId: EnablementList | null = ts === "core" ? "core-plugins" : ts === "community" ? "community-plugins" : null;
    if (carrierId !== null) this.renderCarrierChip(head, carrierId);
    const checkable = visible.filter((r) => this.fateFor(r).stageable);
    const staged = checkable.filter((r) => this.selected.has(r.group.name)).length;
    // The hint answers the one question the global footer cannot: WHICH sections the selection is
    // spread across. With only one staged section there is no such question — its number is
    // necessarily the footer's own total, and `N selected` restates `N selected — captures N`
    // word for word, which is exactly how it read as duplication. So it needs two staged sections
    // to appear, and then says the number ALONE: "selected" is the word that collided, the digit
    // is the per-section fact. The full sentence stays in the aria-label — the visible form is a
    // number, the spoken form is a sentence, and a screen reader never hears a naked digit.
    // Mobile renders none of this at all: the select-all checkbox's checked/indeterminate state
    // plus the footer already carry it, and head space is scarce.
    if (staged > 0 && stagedSections > 1 && !Platform.isMobile) {
      head.createSpan({
        cls: "config-sync-section-hint",
        text: String(staged),
        attr: { "aria-label": `${staged} selected` },
      });
    }
    // Nothing to stage in this section (e.g. pre-adopt Community, only the self row) means
    // no select-all affordance at all, not a disabled one — a control with nothing it could ever
    // do is not a state, it's dead weight.
    if (checkable.length > 0) {
      const box = head.createEl("input", { type: "checkbox", attr: { "aria-label": `Select all in ${TYPE_SECTION_TITLES[ts]}` } });
      box.indeterminate = staged > 0 && staged < checkable.length;
      box.checked = staged === checkable.length;
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        const turnOn = checkable.some((r) => !this.selected.has(r.group.name));
        for (const r of checkable) {
          const name = r.group.name;
          if (turnOn) {
            this.selected.add(name);
            if (this.sectionOf(name) !== "main" && !this.policy.has(name)) this.policy.set(name, this.defaultPolicyFor(r));
          } else {
            this.selected.delete(name);
            this.policy.delete(name);
          }
        }
        this.render(this.renderGen);
      });
    }
    // Collapse/expand flips the DOM in place — `is-open` class, chevron glyph, and
    // the card itself (built just-in-time / torn down on close) — never a full this.render().
    // Mirrors the row-expand precedent (fateEl.hidden flip, no render). `visible`/`showSelf`
    // are frozen from this render cycle, which is correct: only the fold's own open/closed state
    // changes here, never the underlying data.
    let card: HTMLElement | null = open ? this.buildTypeSectionCard(fold, ts, visible, showSelf) : null;
    head.addEventListener("click", () => {
      if (this.typeSectionOpen.has(ts)) {
        this.typeSectionOpen.delete(ts);
        fold.removeClass("is-open");
        setFoldOpen(chevron, false);
        card?.remove();
        card = null;
      } else {
        this.typeSectionOpen.add(ts);
        fold.addClass("is-open");
        setFoldOpen(chevron, true);
        card = this.buildTypeSectionCard(fold, ts, visible, showSelf);
      }
    });
  }

  // A type section's body: extracted from renderTypeSection so the
  // section-head toggle can build/remove just this one section's body in place instead of a full
  // render(). Returns a `display: contents` wrapper (same idiom as .config-sync-item-wrap) so the
  // whole body — the active-rows card plus every fold line and its own opened card — collapses
  // and removes as one unit, while its children still sit directly on the section's own ground
  // (fold lines are never nested inside the filled card).
  private buildTypeSectionCard(fold: HTMLElement, ts: TypeSection, visible: StatusRow[], showSelf: boolean): HTMLElement {
    const body = fold.createDiv({ cls: "config-sync-section-body" });
    if (this.filter === "all" && !this.searching()) {
      // ✓ / ⊘ / ○ rows fold into their own trailing line,
      // aggregated per section. Partitioned by BUCKET, not raw state — active =
      // conflict|apply|capture (plus locked, its current placement, preserved); the folds hold
      // ok/excluded/none. Fold order ✓ → ⊘ → ○ ("from nothing-to-do, to my own rule, to
      // no data yet") — rows within each fold stay name-sorted since `visible` already is.
      // Filing is `placeRow`'s call, not this function's (panelTaxonomy.ts): a row has a FATE and an
      // AVAILABILITY at once, and which of the two files it is a decision with a documented reason,
      // not an inline filter. It used to live here as `availability wins`, which quietly filed a
      // row the user had opted THIS device out of under `N not installed on this device` while the
      // `Not synced here` pill still counted it — a number with nothing behind it.
      const placed = visible.map((r) => ({ r, at: placeRow(this.rowBucket(r), this.sectionOf(r.group.name)) }));
      const active = placed.filter((x) => x.at.zone === "active").map((x) => x.r);
      const fateRows = (fold: FateFold): StatusRow[] =>
        placed.filter((x) => x.at.zone === "fate" && x.at.fold === fold).map((x) => x.r);
      const availabilityRows = (fold: AvailabilityFoldKind): StatusRow[] =>
        placed.filter((x) => x.at.zone === "availability" && x.at.fold === fold).map((x) => x.r);
      // The filled card wraps rows only — it renders exactly when the section
      // has real rows (the self row or an active row); a section whose visible content is fold
      // lines alone shows head + fold lines with no filled block.
      if (showSelf || active.length > 0) {
        const card = body.createDiv({ cls: "config-sync-card" });
        if (showSelf) this.renderSelfRow(card);
        for (const r of active) this.renderItemRow(card, r);
        this.markLastRow(card);
      }
      const fateFold = (rows: StatusRow[], openSet: Set<string>, kind: FoldKind, text: (n: number) => string): void =>
        this.renderSectionTrailingLine(body, {
          ts, rows, openSet, foldId: kind, icon: FOLD_ICON[kind], colorCls: FOLD_ICON_COLOR_CLASS[kind], text, note: null,
        });
      const fateFoldUi: Record<FateFold, { open: Set<string>; text: (n: number) => string }> = {
        insync: { open: sessionUi.insyncOpen, text: insyncLineText },
        excluded: { open: sessionUi.excludedOpen, text: excludedLineText },
        nosettings: { open: sessionUi.nosettingsOpen, text: nosettingsLineText },
      };
      for (const fold of FATE_FOLD_ORDER) {
        const ui = fateFoldUi[fold];
        fateFold(fateRows(fold), ui.open, fold, ui.text);
      }
      // Availability last, in escalating "can't do anything here" order — the four titles and notes
      // are the ones 987eacf deleted with the sections they belonged to.
      for (const kind of AVAILABILITY_FOLD_ORDER) {
        this.renderSectionTrailingLine(body, {
          ts,
          rows: availabilityRows(kind),
          openSet: sessionUi.availabilityOpen,
          foldId: kind,
          icon: AVAILABILITY_FOLD_ICON[kind],
          colorCls: "is-warn",
          text: AVAILABILITY_FOLD_TEXT[kind],
          note: AVAILABILITY_FOLD_NOTE[kind],
        });
      }
    } else {
      // showSelf is only ever true alongside filter === "all" && !searching() (renderTypeSection's
      // own gate) — i.e. always the branch above — so this path never needs the self row.
      const card = body.createDiv({ cls: "config-sync-card" });
      for (const r of visible) this.renderItemRow(card, r);
      this.markLastRow(card);
    }
    return body;
  }

  // The trailing fold line, keyed by section, so expanding the
  // ✓ fold in one section doesn't also expand it in another. Toggling the fold
  // flips the line and builds/removes just its own rows in place — never a full this.render().
  // The line composes the SAME leading `.config-sync-row-chevron` the list
  // rows use, plus a fixed-size Lucide fold icon (foldIcons.ts), around `text`'s plain-text
  // label — no glyph prefix, no trailing triangle baked into the string. An opened fold's rows get
  // their OWN filled card, inserted right after the line (never the active-rows card) — the
  // invariant "filled block = rows" holds for every fold, in every state.
  private renderSectionTrailingLine(
    parent: HTMLElement,
    opts: {
      ts: TypeSection;
      rows: StatusRow[];
      openSet: Set<string>;
      foldId: string;
      icon: string;
      colorCls: string | null;
      text: (n: number) => string;
      // The availability folds carry one, explaining what applying would do for rows this device
      // can't just apply to. It renders under the line and only while the fold is open — closed, it
      // would be four paragraphs of guidance for rows nobody asked to see.
      note: string | null;
    }
  ): void {
    const { ts, rows, openSet, text } = opts;
    if (rows.length === 0) return;
    const key = `${this.sectionKey()}::${ts}::${opts.foldId}`;
    let open = openSet.has(key);
    const line = parent.createDiv({ cls: "config-sync-unchanged" });
    const chevron = renderFoldChevron(line, open, null);
    renderFoldIconNamed(line, opts.icon, opts.colorCls);
    const label = line.createSpan({ cls: "config-sync-fold-label", text: text(rows.length) });
    const openBody = (): HTMLElement[] => {
      const parts: HTMLElement[] = [];
      if (opts.note !== null) {
        const note = parent.createDiv({ cls: "config-sync-fold-note", text: opts.note });
        line.after(note);
        parts.push(note);
      }
      parts.push(this.buildFoldCard(parent, parts[0] ?? line, rows));
      return parts;
    };
    let body: HTMLElement[] = open ? openBody() : [];
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      open = !open;
      setFoldOpen(chevron, open);
      label.setText(text(rows.length));
      if (open) {
        openSet.add(key);
        body = openBody();
      } else {
        openSet.delete(key);
        for (const el of body) el.remove();
        body = [];
      }
    });
  }

  // Builds an open trailing fold's OWN filled card, inserted directly after
  // `line`. `renderItemRow` writes straight into this
  // fresh, empty card — no anchor-shuffling needed, since nothing else ever shares it.
  private buildFoldCard(parent: HTMLElement, line: HTMLElement, rows: StatusRow[]): HTMLElement {
    const card = parent.createDiv({ cls: "config-sync-card" });
    line.after(card);
    for (const r of rows) this.renderItemRow(card, r);
    this.markLastRow(card);
    return card;
  }

  // Config Sync's own row: pinned first in Community, outside the checkbox/Fate
  // machinery — it isn't staged through the normal apply/capture run (its own Adopt/Capture
  // buttons in the expanded content do that). Expand reuses the existing self-pane content.
  private renderSelfRow(card: HTMLElement): void {
    if (this.selfInfo === null) return;
    const expanded = this.expandedItems.has(SELF_GROUP_NAME);
    const row = card.createDiv({ cls: "config-sync-hub-row is-self" });
    const chev = renderFoldChevron(row, expanded, null);
    row.createSpan({ cls: "config-sync-rule-name", text: "Config Sync" });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    row.createSpan({ cls: "config-sync-self-fate", text: "your Sync Center — manages itself" });
    // Fate-icon column alignment: the self row never stages through the normal
    // run and so never has a checkbox — same spacer the item rows' inert branch uses, so its text
    // lands on the same right edge every OTHER row's fate icon does instead of sitting flush
    // against the card's own edge.
    this.renderFateSpacer(row);
    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !expanded;
    this.renderConfigSyncMode(detail);
    row.addEventListener("click", () => {
      if (this.expandedItems.has(SELF_GROUP_NAME)) this.expandedItems.delete(SELF_GROUP_NAME);
      else this.expandedItems.add(SELF_GROUP_NAME);
      detail.hidden = !detail.hidden;
      setFoldOpen(chev, !detail.hidden);
    });
  }

  // The Core/Community section header chip. It never WRITES `Item.synced`; it only
  // SHOWS it and jumps to where that value is configured. One datum, one writer — and the writer is
  // the card's own toggle in the settings panel, beside the confirmation the change deserves.
  //
  // Glyph + tooltip, no wordmark. The word it used to carry (`synced`) named the wrong thing
  // anyway: what this chip reports is whether the on/off LIST is shared with your other devices,
  // which is the `Not shared` axis, not the sync-run axis.
  //
  // The state therefore lives in the GLYPH, not in a color: `share-2` when the list is shared,
  // `square-split-horizontal` — the same mark `ruleIcon` gives `Not shared` — when it isn't. That
  // matters because a phone has no hover to reveal the tooltip; a reader there still gets two
  // visibly different marks instead of one mark in two shades.
  private renderCarrierChip(head: HTMLElement, carrierId: EnablementList): void {
    const synced = this.groups.some((g) => g.name === carrierId);
    const tooltip = synced
      ? "Which plugins are on is shared with your other devices. Opens Settings."
      : "Which plugins are on stays on this device. Opens Settings.";
    const chip = head.createSpan({ cls: `config-sync-carrierchip${synced ? " is-synced" : ""}`, attr: { role: "button", tabindex: "0", "aria-label": tooltip } });
    setIcon(chip.createSpan({ cls: "config-sync-carrierchip-ic" }), synced ? "share-2" : "square-split-horizontal");
    setTooltip(chip, tooltip);
    const open = (): void => {
      const ref = this.host.itemRefForGroup(carrierId);
      if (ref !== null) this.host.openSettingsAt(ref, "card");
    };
    chip.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    chip.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); e.stopPropagation(); open(); });
  }

  private visibleRows(inSection: StatusRow[]): StatusRow[] {
    return inSection.filter((r) => visibleUnderFilter(this.rowBucket(r), this.filter) && this.rowMatchesSearch(r));
  }

  // Tri-state select-all over the currently visible checkable rows (section + filter + search).
  // Fate.stageable drives the skip — carrier rows are excluded outright since they never
  // render as list rows (they dissolve into the section header chip).
  private checkableRows(inSection: StatusRow[]): string[] {
    return this.visibleRows(inSection)
      .filter((r) => !ENABLEMENT_CARRIER_GROUPS.has(r.group.name) && this.fateFor(r).stageable)
      .map((r) => r.group.name);
  }

  private refreshGlobalSelectAll(box: HTMLInputElement, inSection: StatusRow[]): void {
    const checkable = this.checkableRows(inSection);
    const selectedCount = checkable.filter((n) => this.selected.has(n)).length;
    box.indeterminate = false;
    // Idle renders nothing: a disabled ghost box reads as a broken checkbox.
    box.toggleClass("config-sync-selectall-idle", checkable.length === 0);
    if (checkable.length === 0) {
      box.disabled = true;
      box.checked = false;
    } else if (selectedCount === checkable.length) {
      box.disabled = false;
      box.checked = true;
    } else if (selectedCount === 0) {
      box.disabled = false;
      box.checked = false;
    } else {
      box.disabled = false;
      box.indeterminate = true;
    }
  }

  private wireGlobalSelectAll(box: HTMLInputElement, inSection: StatusRow[]): void {
    this.refreshGlobalSelectAll(box, inSection);
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const checkable = this.checkableRows(inSection); // read live so it reflects the current search
      const turnOn = checkable.some((n) => !this.selected.has(n));
      for (const name of checkable) {
        if (turnOn) this.selected.add(name);
        else this.selected.delete(name);
      }
      this.render(this.renderGen);
    });
  }

  // Two-tone group name: faint "Parent › " prefix for card-derived groups, plain label otherwise.
  private renderRuleName(row: HTMLElement, name: string, storedLabel?: string): void {
    const parts = this.host.displayParts(name, storedLabel);
    const el = row.createSpan({ cls: "config-sync-rule-name" });
    if (parts.parent !== null) {
      el.createSpan({ cls: "config-sync-rule-parent", text: parts.parent });
      el.createSpan({ cls: "config-sync-rule-parentsep", text: " › " });
    }
    el.appendText(parts.label);
  }

  // Every fate chip is icon-only, single source
  // FATE_CHIP_ICON (fateChipIcons.ts), the chip's full sentence living in the tooltip — the
  // icon+tooltip row language everywhere else already speaks. An unmapped string (should never
  // happen — chips are presentation) keeps a text label as the loud fallback.
  private renderFateChip(parent: HTMLElement, chip: string): HTMLSpanElement {
    const chipEl = parent.createSpan({ cls: "config-sync-fatechip" });
    const icon = FATE_CHIP_ICON[chip];
    if (icon !== undefined) setIcon(chipEl.createSpan({ cls: "config-sync-fatechip-ic" }), icon);
    else chipEl.createSpan({ cls: "config-sync-fatechip-label", text: chip });
    setTooltip(chipEl, chip);
    return chipEl;
  }

  // Mobile chip-meta trailing hairline: `card`'s children interleave
  // row/meta divs with each row's own `detail` drawer div — a `detail` always immediately
  // follows its row/meta, so no row-shaped selector is EVER literally `:last-of-type` div (the
  // exact footgun the styles.css comment near `config-sync-card-fields` describes). Rather than another
  // tag-dependent selector, this marks the true last row/meta explicitly with a class every time
  // the set of rendered rows could have changed (initial card build, a trailing fold's
  // open/close) — mobile-only (desktop keeps its own pre-existing, untouched border rule) and
  // cheap (one query, only called on those few mutation points, never per-row).
  private markLastRow(card: HTMLElement): void {
    if (!Platform.isMobile) return;
    const prev = card.querySelector<HTMLElement>(".config-sync-row-last");
    prev?.removeClass("config-sync-row-last");
    const rows = card.querySelectorAll<HTMLElement>(".config-sync-hub-row");
    rows.item(rows.length - 1)?.addClass("config-sync-row-last");
  }

  // The unified row: `[checkbox] Name [chips…] <fate sentence> ▸`. One object, one row
  // — `fate.chips`/`fate.sentence`/`fate.stageable` carry everything the row states.
  private renderItemRow(card: HTMLElement, r: StatusRow): void {
    const { group } = r;
    const { fate: rawFate, input } = this.fateWithInput(r);
    const isConflict = rawFate.glyph === "⚠";
    const unresolvedConflict = isConflict && !this.conflictChoice.has(group.name);
    const fate = this.displayFate(rawFate, input, group.name);
    const inert = !fate.stageable;
    const expanded = this.expandedItems.has(group.name);
    // No row-level aria-label: Obsidian renders aria-labels as hover tooltips — a
    // row-level one pops on any blank stretch of the row.
    const row = card.createDiv({
      // `is-inert`, not the old `is-insync`: the flag is `!fate.stageable`, and TWO opposite states
      // share that — "already in sync, nothing to do" and "changed on both sides, waiting on you".
      // Under the old name the second inherited the first's `opacity: 0.55`, so the single row that
      // needed the user's attention rendered FAINTER than the routine work above and below it. The
      // dimming now belongs to the calm reading only (styles.css), and the name says what it tests.
      cls: `config-sync-hub-row${inert ? " is-inert" : ""}${unresolvedConflict ? " is-conflict" : ""}`,
      attr: { "data-cs-row": group.name },
    });
    const chev = renderFoldChevron(row, expanded, null);
    this.renderRuleName(row, group.name, group.label);
    row.createDiv({ cls: "config-sync-rule-spacer" });
    // Chips are icon-only and live on the row's RIGHT, one quiet cluster just
    // before the fate/state column — not tags trailing the name. Display order is the model's
    // own emit order (buildChips, deterministic) — never re-sorted here. Icon-only chips fit
    // any width, so no mobile second line and no overflow-degrade machinery is needed.
    for (const chip of fate.chips) this.renderFateChip(row, chip);
    // The fate SENTENCE repeats the card's own "On apply"/"On capture" clause once expanded, so
    // it hides while the drawer is open (glyph, checkbox and chips stay); the click handler below
    // flips `hidden` alongside the chevron/drawer so it tracks expand/collapse without a full
    // re-render. The DIRECTION never hides with it: the card restates the sentence but never which
    // way the run goes, so dropping the glyph too would make expanding a row cost information
    // instead of adding it. Glyph and sentence are separate flex children of this wrap — the glyph
    // stays `flex: none` (always visible in full); only the sentence span shrinks/ellipsizes, so
    // the fate sentence is the sole sacrificial element.
    // Only the conflict branch below renders a visible sentence at all: directional and neutral
    // fates put theirs in a tooltip on an icon, which duplicates nothing on screen.
    const fateWrap = row.createSpan({ cls: "config-sync-fate-wrap" });
    let fateSentenceEl: HTMLElement | null = null;
    // A DIRECTIONAL fate renders as the colored action icon alone:
    // ACTION_ICON's arrow-up-from-line/arrow-down-to-line in the same orange/accent
    // the pills and file rows speak — the row vocabulary the README screenshots show —
    // with the fate sentence in the tooltip, consistent with the icon+tooltip language.
    // The sentence itself still opens the card (the State row says it in full). A NEUTRAL (—)
    // fate (DESIGN §2.1) renders the same way — the fold family's own icon
    // (`renderNeutralFateIcon`) instead of the bare glyph + sentence text, "In sync"/green-check,
    // "No settings yet"/faint-circle, "Not synced on this device"/faint-circle-slash. Conflict
    // (⚠) alone keeps its text form: a conflict must shout, and it has no action/fold icon to
    // become.
    if (fate.glyph === "↑" || fate.glyph === "↓") {
      const action: SyncAction = fate.glyph === "↑" ? "capture" : "apply";
      const ic = fateWrap.createSpan({ cls: `config-sync-fate-ic ${ACTION_COLOR_CLASS[action]}`, attr: { "aria-label": fate.sentence } });
      setIcon(ic, ACTION_ICON[action]);
    } else if (fate.glyph === "—") {
      this.renderNeutralFateIcon(fateWrap, fate);
    } else {
      const ic = fateWrap.createSpan({ cls: `config-sync-fate-ic ${CONFLICT_COLOR_CLASS}`, attr: { "aria-label": fate.sentence } });
      setIcon(ic, CONFLICT_ICON);
      fateSentenceEl = fateWrap.createSpan({ cls: "config-sync-fate-text", text: fate.sentence });
      fateSentenceEl.hidden = expanded;
    }

    if (!inert) {
      const cb = row.createEl("input", { type: "checkbox" });
      cb.addClass(fate.glyph === "↑" ? "is-capture" : "is-apply");
      cb.checked = this.selected.has(group.name);
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (cb.checked) {
          this.selected.add(group.name);
          if (this.sectionOf(group.name) !== "main" && !this.policy.has(group.name)) {
            this.policy.set(group.name, this.defaultPolicyFor(r));
          }
        } else {
          this.selected.delete(group.name);
          this.policy.delete(group.name);
        }
        this.render(this.renderGen);
      });
    } else {
      // Fate-icon column alignment: an inert row (in sync / no settings yet /
      // not synced on this device / an unresolved conflict) renders no checkbox, so without
      // something occupying that slot the row's own flex layout (the `config-sync-rule-spacer`
      // pushing everything after it to the row's right edge) leaves fateWrap flush against the
      // row's own edge — one column further right than a stageable row's fate icon, which stops
      // short of the checkbox. This spacer reserves that slot instead: an invisible checkbox
      // itself, so it rides the exact same `.config-sync-hub-row input[type="checkbox"]` sizing
      // rule real checkboxes use (15px desktop / 24px mobile, styles.css) rather than a
      // hand-measured pixel width — a future checkbox-size change tracks here for free.
      this.renderFateSpacer(row);
    }

    const detail = card.createDiv({ cls: "config-sync-report-files config-sync-itemcard", attr: { "data-cs-row": group.name } });
    detail.hidden = !expanded;
    this.renderUnifiedCard(detail, r, fate, input, isConflict);
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      setFoldOpen(chev, !detail.hidden);
      if (fateSentenceEl !== null) fateSentenceEl.hidden = !detail.hidden;
    });
  }

  // Fate-icon column alignment (see renderItemRow's inert branch and
  // renderSelfRow): an invisible, disabled `input[type="checkbox"]` — not a hand-measured `<div>`
  // — so it matches the real checkbox's `.config-sync-hub-row input[type="checkbox"]` sizing rule
  // (styles.css) exactly, on every platform, for free. `visibility: hidden` (not `display: none`)
  // keeps it in flow, taking up its slot without being clickable or focusable.
  private renderFateSpacer(row: HTMLElement): void {
    const spacer = row.createEl("input", { type: "checkbox", cls: "config-sync-fate-spacer", attr: { "aria-hidden": "true" } });
    spacer.disabled = true;
  }

  // DESIGN §2.1: a neutral fate's own three shapes derive to the same FoldKind
  // key `renderFoldCount`'s filter pills already use — `nothingYet` first (the same
  // precedence rowFate applies: a degraded-empty-verb direction still reports as nothing-yet), then `excluded`
  // (either class exclusion or a device opt-out — both set `fate.excluded`), else the row is
  // genuinely `insync`. Reading the Fate's OWN fields (not re-deriving from FateInput or matching
  // sentence text) is the same "single source of truth" precedent nothingYet/excluded's own doc
  // comments (fateModel.ts) already establish for fateBucket.
  private renderNeutralFateIcon(parent: HTMLElement, fate: Fate): void {
    const kind: FoldKind = fate.nothingYet ? "nosettings" : fate.excluded ? "excluded" : "insync";
    this.renderFateStateIcon(parent, kind, fate.sentence);
  }

  // The lower-level producer `renderNeutralFateIcon` calls, also used directly by a row that
  // knows its own fold kind without building a full `Fate` (renderRemoteDiffEntry's opted-out
  // row below) — reuses `foldIcons.ts`'s `FOLD_ICON`/`FOLD_ICON_COLOR_CLASS`, the SAME producer
  // the trailing-fold summary lines read, at the row's own `config-sync-fate-ic` size instead of
  // the fold line's 12px (DESIGN §2.1 — one vocabulary, two sizes for two contexts).
  private renderFateStateIcon(parent: HTMLElement, kind: FoldKind, sentence: string): void {
    const colorCls = FOLD_ICON_COLOR_CLASS[kind];
    const ic = parent.createSpan({ cls: `config-sync-fate-ic${colorCls !== null ? ` ${colorCls}` : ""}`, attr: { "aria-label": sentence } });
    setIcon(ic, FOLD_ICON[kind]);
  }

  // Presentation-only wrapper around the shared `effectiveFate` derivation (panelModel.ts):
  // once Resolve picks a side, the row reads exactly like a normal directed row
  // — a real sentence/chips computed as if the conflict were simply that direction (never the
  // frozen "⚠ Changed on both sides"), plus the `your choice` chip. `fallbackTurnsOn` is
  // deliberately NOT passed here (`false`) — the fate SENTENCE must stay free of enablement
  // verbs for the carrier-unsynced fallback ladders; `stagedRows()`/`footerSelection()`
  // call the same `effectiveFate` WITH that bridge for the actual staging/counting truth, so the
  // sentence and the run can only differ in that one deliberate place, never accidentally.
  private displayFate(fate: Fate, input: FateInput, name: string): Fate {
    const choice = this.conflictChoice.get(name) ?? null;
    const resolved = effectiveFate(fate, input, choice, false);
    if (fate.glyph !== "⚠" || choice === null) return resolved;
    return { ...resolved, chips: [...resolved.chips, "your choice"], stageable: true };
  }

  // The expanded card: standardized rows in order, each omitted when N/A. `fate` is
  // already the display (post-resolution) fate; `isConflict` names the row as a conflict
  // regardless of resolution, so Resolve keeps rendering (letting a choice be changed) and the
  // On-apply/On-capture header + Files stay keyed off the CHOSEN side rather than the old
  // direction-toggle default.
  private renderUnifiedCard(detail: HTMLElement, r: StatusRow, fate: Fate, input: FateInput, isConflict: boolean): void {
    if (r.status.message !== undefined) {
      detail.createDiv({ cls: "config-sync-status-error", text: r.status.message });
      return;
    }
    const name = r.group.name;
    // Own wrapper for the field rows: it groups the rows and
    // carries their bottom margin, keeping any future non-row sibling in `detail` outside it.
    const fields = detail.createDiv({ cls: "config-sync-card-fields" });
    const dir = isConflict ? this.conflictChoice.get(name) ?? null : input.direction;
    this.renderCardKeyRow(fields, dir === "apply" ? "On apply" : dir === "capture" ? "On capture" : "State", (value) => {
      value.createDiv({ cls: "config-sync-expand-note", text: this.stateClauseText(r, fate, input) });
    });

    const changes = this.familyChanges(r);
    // An unresolved conflict has no direction yet, and the FILES row used to be gated on one — so
    // the card asked you to pick a side while showing you nothing to pick it from, and only
    // revealed the files AFTER you had committed. The evidence now comes first: an unresolved
    // conflict previews the `Use theirs` side (`apply`), and the toolbar control both switches the
    // preview and IS the choice, because in this plugin a diff always shows what one choice would
    // do (see diffView's DiffResolveControl).
    const previewDir: Direction | null = dir ?? (isConflict ? "apply" : null);
    if (previewDir !== null && hasChanges(changes)) {
      this.renderFilesRow(fields, r, changes, previewDir, input.encrypted, isConflict ? this.conflictResolve(r, changes) : null);
    }

    if (isConflict) this.renderResolveRow(fields, r);

    // Runs on is one of the two "always available" rule menus (no stageable
    // qualifier, unlike After install's explicit "only ¬carrierSynced ∧ ¬installed"): a
    // carrier-synced plugin needs it reachable from its steady in-sync state too, so an
    // exception can be set BEFORE the row ever diverges. After install keeps the stageable
    // guard — harmless there since an installable row is already stageable via
    // stageableRow's non-main-section carve-out. Enablement is
    // the third and last leaf of this same ladder: an installed-but-disabled row whose carrier
    // ISN'T synced has no `Runs on` (nothing to route through) and no `After install` (already
    // installed) — without it there is no enable path in the unified grammar
    // at all. Ungated by `fate.stageable`, matching
    // `Runs on`'s own precedent (reachable from the row's steady state, not just mid-divergence).
    if (input.carrierSynced) this.renderDefaultEnabledOnRow(fields, name, input);
    else if (!input.installed) {
      if (fate.stageable) this.renderAfterInstallRow(fields, r);
    } else if (this.availOf(name).kind === "disabled") {
      this.renderEnablementRow(fields, r);
    }

    this.renderSettingsSyncRow(fields, r);
    this.renderMoreRow(fields, name);

    if (name === "hotkeys") {
      this.renderCardKeyRow(fields, "Note", (value) => {
        value.createDiv({ cls: "config-sync-expand-note", text: "Takes effect after an app reload" });
      });
    }
  }

  // The row shell every card row shares ("one grid per card"): a fixed label on track 1 of
  // `.config-sync-cardrow`. Callers fill the rest — either one value cell spanning the remaining
  // tracks (renderCardKeyRow, below) or a single control landing on the last one (renderMergedRow,
  // renderCardIconActionRow, renderFilesRow) — so every row's icons sit on the same vertical rule
  // at the card's right edge, whichever shape painted them.
  //
  // `iconRow` marks the icon-cell shape (merged-control rows, the More row, Files): content-sized,
  // so mobile keeps it on the shared grid instead of the wide rows' stack-to-full-width fallback —
  // a glyph or a badge has nothing to clip, and stacking would waste a line. Named `is-iconrow`,
  // not `is-compact`: that modifier names the narrow-viewport pane layout on
  // `.config-sync-shell`, an unrelated axis.
  private cardRowShell(label: string, iconRow: boolean): HTMLElement {
    const row = createDiv({ cls: `config-sync-card-fieldrow config-sync-cardrow${iconRow ? " is-iconrow" : ""}` });
    row.createSpan({ cls: "config-sync-explabel config-sync-explabel-inline", text: label });
    return row;
  }

  // One row inside the expanded card: a fixed-width muted label with its
  // value immediately adjacent, shared by every card row (On apply/Files/Settings sync/More/Note/
  // Resolve) — never a label on its own line with the value spread underneath. Built off-DOM
  // first: if `build` leaves the value empty, the row is dropped entirely — no separator,
  // no height — rather than appended and pruned; the rule-control triggers render through this
  // same helper, so an N/A control must vanish the same way.
  private renderCardKeyRow(detail: HTMLElement, label: string, build: (value: HTMLElement) => void): void {
    const row = this.cardRowShell(label, false);
    const value = row.createDiv({ cls: "config-sync-cardval" });
    build(value);
    if (value.childNodes.length === 0) return;
    detail.appendChild(row);
  }

  // The same choice the Resolve row below offers, handed to every diff this row opens. Two
  // entrances, one datum (`conflictChoice`) — the toolbar one exists because the diff is where the
  // consequences of each side are actually visible.
  //
  // `scopeNote` is the honest disclosure for a multi-file item: the run writes a whole group
  // (`ApplyItem`/`CaptureItem` carry a group name; the only partial mechanism, `stagedMembers`, is
  // switch-list-only), so picking a side inside one file's diff settles its siblings too. Saying so
  // costs one line; not saying it would let a user resolve a file this window never showed them.
  private conflictResolve(r: StatusRow, changes: FileChanges): DiffResolveControl {
    const name = r.group.name;
    const total = changes.added.length + changes.updated.length + changes.deleted.length;
    return {
      group: name,
      chosen: this.conflictChoice.get(name) ?? null,
      scopeNote: total > 1 ? `Resolves all ${total} files in ${r.group.label} — this item is written as a whole.` : null,
      onPick: (choice) => this.pickConflictSide(name, choice),
    };
  }

  // Clicking the already-active side clears it (the same "click the active segment to unstage"
  // idiom renderDirectionToggle uses), so both entrances behave identically.
  //
  // Deliberately NOT `render()`. That empties `contentEl` and rebuilds the whole pane — header,
  // sidebar, every card — which is fine for a filter change and wrong here: this control sits
  // INSIDE the thing being torn down, on top of a diff the user is reading, and toggling between
  // the two sides made the card visibly flash. So the update is scoped to what a choice actually
  // changes, and that list is short enough to write down:
  //
  //   1. every rendered copy of this item's segment (the card row, and each open diff's toolbar)
  //   2. this item's own row and card — the fate icon, the checkbox, the FILES badge, and the
  //      `State` header that becomes `On apply`/`On capture`
  //   3. the footer, whose counts and button labels read the selection
  //
  // Nothing else on the pane depends on one row's conflict choice, so nothing else is touched.
  private pickConflictSide(name: string, choice: ConflictChoice): void {
    if (this.conflictChoice.get(name) === choice) {
      this.conflictChoice.delete(name);
      this.selected.delete(name);
    } else {
      this.conflictChoice.set(name, choice);
      this.selected.add(name);
    }
    // The row's fate is memoized per group; it has to re-derive against the choice just made.
    this.rowDerivationCache.delete(name);
    this.repaintResolveSegments(name);
    this.refreshItemRow(name);
    this.refreshActionBar();
  }

  // Every copy of this item's segment currently on screen — the card row's, and one per open diff
  // toolbar. Found by data attribute rather than by a registry, so a copy rendered later (a diff
  // opened after the choice) is not something anyone has to remember to register.
  private repaintResolveSegments(name: string): void {
    const chosen = this.conflictChoice.get(name) ?? null;
    this.contentEl.querySelectorAll(`[data-cs-resolve="${name}"]`).forEach((seg) => paintResolveSegment(seg, chosen));
  }

  // Rebuilds ONE item's row and card in place, leaving the rest of the pane untouched. The two are
  // siblings under the same filled card (renderItemRow appends them in that order), so they move as
  // a pair, back to the same position; `markLastRow` re-runs because the pair may have been last.
  private refreshItemRow(name: string): void {
    const row = this.contentEl.querySelector(`.config-sync-hub-row[data-cs-row="${name}"]`);
    const detail = this.contentEl.querySelector(`.config-sync-itemcard[data-cs-row="${name}"]`);
    const card = row?.parentElement ?? null;
    const r = this.rows().find((x) => x.group.name === name);
    if (row === null || detail === null || card === null || r === undefined) return;
    const anchor = detail.nextSibling;
    // Rescue any open diff before the subtree goes: see adoptedDiffPanels.
    const adopted = new Map<string, HTMLElement>();
    detail.querySelectorAll(".config-sync-inline-diff[data-cs-diff]").forEach((el) => {
      const key = el.getAttribute("data-cs-diff");
      if (key !== null) adopted.set(key, el as HTMLElement);
    });
    row.remove();
    detail.remove();
    const staging = createDiv();
    this.adoptedDiffPanels = adopted;
    try {
      this.renderItemRow(staging, r);
    } finally {
      this.adoptedDiffPanels = null;
    }
    while (staging.firstChild !== null) card.insertBefore(staging.firstChild, anchor);
    this.markLastRow(card);
  }

  // The footer reads the whole selection, so a choice that stages or unstages a row moves it.
  // Rebuilt rather than patched: its buttons are ButtonComponents wired to payloads derived from
  // that same selection, and re-deriving them is what keeps the labels and the run in step.
  private refreshActionBar(): void {
    const bar = this.contentEl.querySelector(".config-sync-actionbar");
    const macro = bar?.parentElement ?? null;
    if (bar === null || macro === null) return;
    bar.remove();
    this.renderActionBar(macro);
  }

  // Resolve (conflict rows only): segmented `Use theirs ↓` / `Keep mine ↑`. Clicking
  // the already-active choice clears it (the same "click the active segment to unstage" idiom
  // `renderDirectionToggle` already uses elsewhere) — Resolve doubles as this row's only
  // staging affordance, since its checkbox stays hidden (`Fate.stageable` false) until chosen.
  private renderResolveRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    this.renderCardKeyRow(detail, "Resolve", (value) => {
      const segrow = value.createDiv({ cls: "config-sync-segrow" });
      renderResolveSegment(segrow, {
        group: name,
        chosen: this.conflictChoice.get(name) ?? null,
        onPick: (side) => this.pickConflictSide(name, side),
      });
    });
  }

  // The `On apply`/`On capture`/`State` row's text: the fate sentence, expanded with the
  // specifics (install source, update versions, capture consequence).
  private stateClauseText(r: StatusRow, fate: Fate, input: FateInput): string {
    if (fate.glyph === "⚠") return "Changed on both sides.";
    // The nothing-yet presentation (direct or degraded from an empty-verb direction —
    // fateModel.ts's rowFate) speaks in cause voice, not just its terse row sentence + period.
    if (fate.sentence === NOTHING_YET_SENTENCE) return "No saved settings anywhere yet — neither this device nor the store has any.";
    if (input.direction === null) {
      // The card's STATE clause spells out WHY, not just the row's terse sentence —
      // and the two exclusion causes read differently even though the row above them is identical.
      if (input.excludedHere) return "Not synced on this device — your Settings sync rule excludes it.";
      if (input.optedOutHere === true) return "Not synced on this device — you turned it off here. Your other devices keep syncing it.";
      return `${fate.sentence}.`;
    }
    let text = fate.sentence;
    if (input.direction === "apply" && !input.installed) {
      const source = this.itemSectionOf(r.group.name) === "beta" ? "via BRAT" : "from the community catalog";
      text = text.replace(/^Installs/, `Installs ${source}`);
    }
    if (input.direction === "apply" && input.hasUpdate) {
      const a = this.availOf(r.group.name);
      text = text.replace(/^Updates/, `Updates ${a.localVersion ?? "current"} → ${a.storeVersion ?? "latest"}`);
    }
    if (input.direction === "capture") {
      // Version-ahead branches off the fact (input.versionAhead), never the joined
      // sentence strings — every other capture row falls through to the existing two clauses
      // untouched.
      if (input.versionAhead !== null) text = versionAheadClause(input, input.versionAhead);
      else if (text === "Captures settings") text = "Shares your settings with your other devices";
      else if (text === "Turned on here — shares it") text = "Turned on here — your other devices will turn it on the next time they apply";
    }
    return `${text}.`;
  }

  // Files: the direction badge, the count pill, and the FOLD chevron render
  // as one tight cluster on the row's value cell — badge, pill, and chevron are all
  // flex children of the SAME head, never split across grid cells, so there is no separate
  // "collapsed" vs "expanded" cell shape to keep in sync: the cluster is the row's first line in
  // both states, and the entry list (when expanded) just sits below it. Built directly rather than
  // through renderCardKeyRow: the badge is a static, non-interactive icon (no menu, no `▾`), a
  // shape none of renderCardKeyRow's other callers need, and threading an optional icon through
  // that shared helper for one row would ripple a parameter every other call site has to pass as
  // absent. Marked `is-iconrow`: the row's whole value is one badge now, so it belongs on the
  // shared grid at every width, landing on the same vertical rule as the merged controls under it.
  // The expanded entry list is a SIBLING of the row, not part of its value cell — file names can
  // run long, and as a sibling the list owns the card's full width on phone and desktop alike
  // instead of the grid's remainder. It stays in the DOM while collapsed; `.config-sync-files-list`
  // is `:empty`-hidden so a folded row carries no stray gap.
  // Default = count-only, same click-to-expand idiom the Settings tab's
  // companion member count (`config-sync-card-membercount`/`-memberarrow`) already established —
  // a neutral bare-number pill (aria/tooltip the full `filesChangeLabel` sentence) plus the FOLD
  // family's rotating chevron, remembered per row in `expandedFileRows` while the pane stays
  // open. Empty-row drop (no changes at all) happens up front rather than after building the
  // entry list, since the collapsed head always renders SOMETHING once there IS at least one
  // change.
  private renderFilesRow(detail: HTMLElement, r: StatusRow, changes: FileChanges, dir: Direction, encrypted: boolean, resolve: DiffResolveControl | null): void {
    const total = changes.added.length + changes.updated.length + changes.deleted.length;
    if (total === 0) return;
    const row = this.cardRowShell("Files", true);
    row.addClass("config-sync-filesrow");
    const value = row.createDiv({ cls: "config-sync-cardrow-ctl config-sync-files-val" });
    const list = createDiv({ cls: "config-sync-files-list" });
    const key = r.group.name;
    const build = (): void => {
      value.empty();
      list.empty();
      const expanded = this.expandedFileRows.has(key);
      // ONE mark, not three. The row used to read `↑ (4) ›` — a direction badge, a neutral count
      // pill and a fold chevron, each its own little target — where all three answered the same
      // question. They are one badge now: the direction's icon and its count in a single pill that
      // carries the direction's color. The badge is pure STATE — the click/keyboard target is the
      // whole row (wired below) — so there is nothing left on this line to aim at. Expanded, the
      // badge fills in (`.is-open`) instead of a chevron rotating beside it: same state, one fewer
      // glyph.
      const head = value.createDiv({ cls: "config-sync-files-head" });
      // While a conflict is undecided the badge wears the CONFLICT mark, not a direction arrow:
      // the row has no direction yet, and `dir` here is only the side being previewed. Once a side
      // is picked it becomes an ordinary directional badge like every other row's.
      const undecided = resolve !== null && resolve.chosen === null;
      const badge = head.createSpan({
        cls: `config-sync-files-badge ${undecided ? CONFLICT_COLOR_CLASS : ACTION_COLOR_CLASS[dir]}${expanded ? " is-open" : ""}`,
      });
      setIcon(badge.createSpan({ cls: "config-sync-files-badge-ic" }), undecided ? CONFLICT_ICON : ACTION_ICON[dir]);
      badge.createSpan({ text: String(total) });
      row.setAttrs({ "aria-expanded": expanded ? "true" : "false" });
      if (expanded) this.renderUnifiedFiles(list, r, changes, dir, encrypted, resolve);
    };
    // THE ROW is the target, not the badge. 2.25.0 moved every card control to the card's right
    // edge, and the listeners had always been on the badge — so the only clickable thing slid to
    // the row's far end, leaving the `FILES` label and the whole stretch between it and the badge
    // dead. Wired once out here rather than inside `build`, which re-runs on every toggle and would
    // otherwise stack a listener per expand.
    const toggle = (): void => {
      if (this.expandedFileRows.has(key)) this.expandedFileRows.delete(key);
      else this.expandedFileRows.add(key);
      build();
    };
    row.setAttrs({
      role: "button",
      tabindex: "0",
      "aria-label":
        resolve !== null && resolve.chosen === null
          ? `${filesChangeLabel(total)} — changed on both sides; open to compare each side before choosing`
          : `${filesChangeLabel(total)} — ${dir === "capture" ? "these changes land in the store" : "these changes land on this device"}`,
    });
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    build();
    detail.appendChild(row);
    detail.appendChild(list);
  }

  // Files row: direction-aware entries via fileEntryFor, reusing the same
  // diffPair-backed inline expand renderCappedChanges already uses for "view" and "diff" alike
  // (the "view" case is just a diff against an empty base — the same content diffPair already
  // returns — mirroring the remote pane's "not in your store" content view).
  private renderUnifiedFiles(detail: HTMLElement, r: StatusRow, changes: FileChanges, dir: Direction, encrypted: boolean, resolve: DiffResolveControl | null): void {
    const { shown, rest } = capFileEntries(changes, 10);
    const renderEntry = (e: CappedEntry): void => {
      const kind: "added" | "updated" | "deleted" = e.kind === "add" ? "added" : e.kind === "upd" ? "updated" : "deleted";
      const pres = fileEntryFor({ kind, rel: e.name }, dir, encrypted);
      // "+"/"·"/"del" render "+"/"~"/"−" in BOTH directions (DESIGN §2.1): the
      // FILES row's own track-2 badge says which side, once — an entry never repeats a direction
      // glyph, only the diff-kind family. Styling follows the PRESENTATION glyph, never the raw
      // capture-perspective `e.kind` — under apply direction add/delete mirror each other
      // (fileEntryFor's own doc comment), so keying the class off `e.kind` would let a "+" entry
      // inherit "is-del"'s strikethrough.
      const glyphText = pres.glyph === "del" ? "−" : pres.glyph === "·" ? "~" : pres.glyph;
      const glyphCls = pres.glyph === "+" ? "is-add" : pres.glyph === "del" ? "is-del" : "is-upd";
      const line = detail.createDiv({
        cls: `${glyphCls}${pres.glyph === "del" ? " config-sync-file-del" : ""}`,
        text: `${glyphText} ${pres.label}`,
        attr: { "aria-label": pres.tooltip },
      });
      if (pres.note !== null) {
        line.createSpan({ cls: "config-sync-file-note", text: ` · ${pres.note}` });
        return;
      }
      if (pres.affordance === "none") return;
      // One 14px file-diff icon closes a diffable/viewable entry (DESIGN §2.3/§4) —
      // never per-kind icons, never a `· view ▾`/`· diff ▾` text: "changes live here, click
      // to see." The OPEN state turns the icon accent-colored instead of flipping ▾/▴ text.
      line.addClass("config-sync-diffable");
      const affLabel = pres.affordance === "view" ? "View content" : "View changes";
      const diffIcon = line.createSpan({ cls: "config-sync-diffic", attr: { "aria-label": affLabel, role: "button", tabindex: "0" } });
      setIcon(diffIcon, "file-diff");
      const owner = this.fileOwner(r, e.name);
      const diffKey = `${owner.group}::${owner.rel}`;
      let panel: HTMLElement | null = null;
      const open = (): void => {
        diffIcon.addClass("is-open");
        // Adopted when this card is being rebuilt around an already-open diff: the old panel keeps
        // its content on screen while the new side is read.
        const p = this.adoptedDiffPanels?.get(diffKey) ?? createDiv({ cls: "config-sync-inline-diff", attr: { "data-cs-diff": diffKey } });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        void this.host.diffPair(owner.group, owner.rel, dir).then((pair) => {
          if (panel !== p) return;
          p.empty();
          if (pair === null) {
            p.createDiv({ cls: "config-sync-expand-note", text: "no diff available" });
            return;
          }
          const switchSorted = isSwitchListGroup(owner.group);
          let base = switchSorted ? switchListSortedView(pair.base) : pair.base;
          let produced = switchSorted ? switchListSortedView(pair.produced) : pair.produced;
          let jsonSorted = false;
          if (!switchSorted && e.name.endsWith(".json")) {
            const sb = jsonSortedView(pair.base);
            const sp = jsonSortedView(pair.produced);
            if (sb !== null && sp !== null) {
              base = sb;
              produced = sp;
              jsonSorted = true;
            }
          }
          if (base === produced && pair.base !== pair.produced) {
            p.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
            return;
          }
          const leftLabel = dir === "capture" ? "store" : pres.affordance === "view" ? "not on this device yet" : "this device";
          const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
          renderDiffPanel(p, base, produced, leftLabel, rightLabel, { name: e.name, sorted: switchSorted || jsonSorted },
            () => openDiffModal(this.app, base, produced, leftLabel, rightLabel, { name: e.name, sorted: switchSorted || jsonSorted }), resolve);
        });
      };
      const toggle = (): void => {
        if (panel !== null) {
          this.openEntryDiffs.delete(diffKey);
          panel.remove();
          panel = null;
          diffIcon.removeClass("is-open");
          return;
        }
        this.openEntryDiffs.add(diffKey);
        open();
      };
      // Re-open on a repaint, before any listener fires — see openEntryDiffs.
      if (this.openEntryDiffs.has(diffKey)) open();
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggle();
      });
      diffIcon.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        ev.stopPropagation();
        toggle();
      });
    };
    for (const e of shown) renderEntry(e);
    if (rest.length > 0) {
      const more = detail.createDiv({ cls: "config-sync-more-files" });
      more.appendText(moreFilesText(rest.length));
      // A one-way reveal (never re-collapses), so the chevron never rotates — the FOLD family's
      // glyph, static, same idiom as the row-chevron everywhere else.
      setIcon(more.createSpan({ cls: "config-sync-row-chevron" }), "chevron-right");
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        more.remove();
        for (const entry of rest) renderEntry(entry);
      });
    }
  }

  // Click/keydown → open an Obsidian Menu at the trigger's position, shared by every card
  // rule-control trigger (icon or text) so a menu opens the same way regardless of trigger kind.
  // Tracks `.is-open` on the trigger while the menu is showing (⇕ hover-reveal —
  // DESIGN.md §2.3), cleared via `Menu.onHide` — the PICKER chevron accents and stays revealed
  // while its own menu is open, matching SettingTab's own `wireMenuTrigger`.
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
      const rect = trigger.getBoundingClientRect();
      open(rect.left, rect.bottom);
    });
  }

  // A generic "label: value-that-opens-a-menu" card row, shared by After install / Enablement —
  // the two textual triggers left once Settings sync/Runs on moved onto the merged-control/icon
  // idioms above.
  private renderCardMenuRow(detail: HTMLElement, label: string, valueText: string, ariaLabel: string, buildMenu: () => Menu): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const chip = value.createSpan({ cls: "config-sync-menuchip config-sync-card-trigger", text: valueText, attr: { "aria-label": ariaLabel } });
      this.wireMenuTrigger(chip, buildMenu);
    });
  }

  // Both layers in ONE control, the same shape the Settings panel paints (mergedControl.ts): the
  // divider and the `this device` eyebrow that used to sit between them are gone, and the words
  // that told the two layers apart moved into the menu as its two section headers.
  private renderMergedRow(
    detail: HTMLElement,
    label: string,
    opts: { shared: RowSegment; local: RowSegment | null; localIsException: boolean; sections: () => readonly MenuSectionModel[] }
  ): void {
    const row = this.cardRowShell(label, true);
    paintMergedControl(row, { ...opts, wire: (trigger, menu) => this.wireMenuTrigger(trigger, menu) });
    detail.appendChild(row);
  }

  // Enabled on — only for a plugin row whose carrier is
  // synced: with no shared list there is no default to state.
  private renderDefaultEnabledOnRow(detail: HTMLElement, name: string, input: FateInput): void {
    const list = enablementCarrierFor(this.rowRef(name));
    const elementId = this.carrierElementFor(name);
    const model = enablementRowModel({ rule: input.ruleSharing, exception: input.localException });
    this.renderMergedRow(detail, "Enabled on", {
      shared: model.fleet,
      local: model.local,
      localIsException: model.localIsException,
      sections: () => [
        sharingMenuSection({
          header: ENABLED_ON_HEADER,
          options: RULE_OPTIONS,
          current: input.ruleSharing,
          iconFor: ruleIcon,
          labelFor: ruleLabel,
          onChange: (rule) => void this.setRuleWithLanding(list, elementId, rule).then(() => this.notifyExternalChange()),
        }),
        {
          header: ON_THIS_DEVICE_HEADER,
          // buildLocalMenu is the producer the Settings card's row asks too, so the two entrances
          // cannot offer different choices. Its follow entry is absent under `Not shared`: there is
          // no shared answer to follow, and this device's own state IS the answer.
          items: buildLocalMenu(input.ruleSharing, input.localException, {
            follow: () => void this.host.followTheDefault(list, elementId).then(() => this.reload()),
            setState: (state) => void this.host.setDeviceElement(list, elementId, state).then(() => this.reload()),
          }),
        },
      ],
    });
  }

  // The shared write, plus the landing seed — the same pair the Settings card's own control does
  // (SettingTab.setRuleWithLanding), asking the same producer (ruleLandingNeedsSeed), so landing on
  // `Not shared` behaves identically at both entrances.
  private async setRuleWithLanding(list: RuleListId, elementId: string, rule: Sharing): Promise<void> {
    await this.host.setEnablementRule(list, elementId, rule);
    if (ruleLandingNeedsSeed(rule, this.host.deviceElementFor(list, elementId))) await this.host.leaveToThisDevice(list, elementId);
  }

  // After install (fallback ladder — only when the carrier is NOT synced and the row
  // installs): today's install-enable/install policy choice, alive only in the fallback grammar.
  private renderAfterInstallRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const current: "install-enable" | "install" = this.policy.get(name) === "install" ? "install" : "install-enable";
    this.renderCardMenuRow(detail, "After install", AFTER_INSTALL_LABELS[current], "Choose what happens right after installing", () => {
      const menu = new Menu();
      (["install-enable", "install"] as const).forEach((action) => {
        menu.addItem((item) =>
          item
            .setTitle(AFTER_INSTALL_LABELS[action])
            .setChecked(action === current)
            .onClick(() => {
              this.policy.set(name, action);
              this.render(this.renderGen);
            })
        );
      });
      return menu;
    });
  }

  // Enablement (fallback ladder's third leaf): an installed but
  // disabled plugin whose carrier ISN'T synced has no other enable path in the unified grammar
  // (`Runs on` needs a synced carrier to route through; `After install` only fires for a
  // not-yet-installed row). Same two options/copy as `After install`, written into the same
  // `this.policy` slot but under the "enable"/"none" `StateAction` domain — the actual values a
  // disabled row's own ladder (`policyOptions`) recognizes, so a stored choice survives
  // `reload()`'s `isValidPolicy` pruning instead of being dropped on the very next render.
  private renderEnablementRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const current: "enable" | "none" = this.policy.get(name) === "none" ? "none" : "enable";
    this.renderCardMenuRow(detail, "Enablement", ENABLEMENT_LABELS[current], "Choose whether this plugin turns on", () => {
      const menu = new Menu();
      (["enable", "none"] as const).forEach((action) => {
        menu.addItem((item) =>
          item
            .setTitle(ENABLEMENT_LABELS[action])
            .setChecked(action === current)
            .onClick(() => {
              this.policy.set(name, action);
              this.render(this.renderGen);
            })
        );
      });
      return menu;
    });
  }

  // Settings sync: a merged control like `Enabled on` — the shared half is the item's own
  // file-level sharing (SAME icon vocabulary the Settings tab's file-row control uses, sharingIcon;
  // write target Item.settingsFile.fileRule.sharing for every item, custom (folder) items included
  // since runsOn's retirement — one entrance, not two); the local half
  // is this device's own whole-file opt-out.
  // The Settings tab's own drawer control (renderSharingPicker) opens the same kind of
  // menu — the two entrances stay in step, just not through this method.
  private renderSettingsSyncRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const ref = this.itemRefFor(name);
    if (ref === null) return;
    const optedOut = this.host.deviceOptedOut(name);
    // buildOptOutLocalMenu's entries — a DIFFERENT datum from buildLocalMenu's element-layer menu:
    // this is the whole-FILE device opt-out, and it always offers both entries.
    const localSection = (): MenuSectionModel => ({
      header: ON_THIS_DEVICE_HEADER,
      items: buildOptOutLocalMenu(optedOut, {
        follow: () => void this.host.setDeviceOptOut(name, false).then(() => this.reload()),
        optOut: () => void this.host.setDeviceOptOut(name, true).then(() => this.reload()),
      }),
    });
    // A fields-mode item has no legal whole-file rule to write (setItemFileSharing throws on it),
    // so the shared half must not offer stops whose choice would just be discarded. The local layer
    // is a different datum and still works, so the row keeps both halves: the shared one
    // contributes a single entry that JUMPS to the item's Settings card instead of a list.
    // `braces` says "the keys inside this file decide"; `settings-2` stays reserved for "opens
    // Settings", which is what the `More` row two lines down means — same card, same glyph, two
    // different facts was the confusion.
    if (!this.host.itemFileSharingMenuLegal(ref)) {
      this.renderMergedRow(detail, "Settings sync", {
        shared: { icon: "braces", tooltip: FILE_SHARING_MENU_UNAVAILABLE_TEXT },
        local: optOutLocalSegment(optedOut),
        localIsException: optedOut,
        sections: () => [
          {
            header: SHARED_WITH_HEADER,
            items: [
              { title: PER_KEY_RULES_STATE_TEXT, icon: "braces", checked: false, isLabel: true, action: () => {} },
              // `settings-2` here and nowhere else in this pair: from the Sync Center this really
              // does open Settings, which is the one thing that glyph means.
              { title: PER_KEY_RULES_ACTION_TEXT, icon: "settings-2", checked: false, action: () => this.host.openSettingsAt(ref, "key-rules") },
            ],
          },
          localSection(),
        ],
      });
      return;
    }
    const current = this.host.itemFileSharing(ref);
    const model = fileEnablementRowModel({ sharing: current, optedOut });
    this.renderMergedRow(detail, "Settings sync", {
      shared: model.fleet,
      local: model.local,
      localIsException: model.localIsException,
      sections: () => [
        sharingMenuSection({
          header: SHARED_WITH_HEADER,
          options: FILE_SHARING_OPTIONS,
          current,
          iconFor: sharingIcon,
          labelFor: sharingLabel,
          onChange: (v) => void this.host.setItemFileSharing(ref, v as FileSharing).then(() => this.reload()),
        }),
        localSection(),
      ],
    });
  }

  // Icon trigger + plain click (the `More` row): unlike renderCardIconMenuRow's family, this row
  // opens Settings directly rather than offering a menu — a sibling helper keeps that distinction
  // honest instead of routing a single-item fake menu through wireMenuTrigger. Lands on the same
  // last track as every merged control, so it shares their rail rule; the middle track stays empty.
  private renderCardIconActionRow(detail: HTMLElement, label: string, icon: string, isSet: boolean, ariaLabel: string, onActivate: () => void): void {
    const row = this.cardRowShell(label, true);
    const trigger = row.createSpan({
      cls: `config-sync-sharingicon config-sync-card-trigger config-sync-cardrow-ctl${isSet ? " is-set" : ""}`,
      attr: { "aria-label": ariaLabel, role: "button", tabindex: "0" },
    });
    setIcon(trigger, icon);
    const activate = (e: Event): void => {
      e.stopPropagation();
      onActivate();
    };
    trigger.addEventListener("click", activate);
    trigger.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      activate(e);
    });
    detail.appendChild(row);
  }

  // More bridge: icon-only deep link into the Settings tab for this item's card — the
  // whole sentence lives in the tooltip since there is no line of text
  // to hold it. Never `sliders-horizontal`: that glyph already means
  // `your rule` in the fate chips (fateChipIcons.ts).
  private renderMoreRow(detail: HTMLElement, name: string): void {
    const isFolder = this.itemSectionOf(name) === "custom";
    const tooltip = isFolder ? "Folder rules — opens Settings" : "Per-key rules, locks & folders — opens Settings";
    this.renderCardIconActionRow(detail, "More", "settings-2", false, tooltip, () => {
      const ref = this.itemRefFor(name);
      if (ref !== null) this.host.openSettingsAt(ref, "card");
    });
  }

  // Paint a state-icon span: an action shows its SVG, locked shows the key SVG, everything
  // else stays a text glyph. The span already carries its `is-*` color class.
  private paintStateIcon(el: HTMLElement, icon: { glyph: string; cls: string; action?: SyncAction }): void {
    if (icon.action !== undefined) setIcon(el, ACTION_ICON[icon.action]);
    else if (icon.cls === "is-locked") setIcon(el, "key-round");
    else el.setText(icon.glyph);
  }

  private formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async deleteLeftovers(rels: string[]): Promise<void> {
    const paths = this.leftovers.filter((l) => rels.includes(l.rel)).map((l) => l.path);
    const deleted = await this.host.deleteLeftoverStoreFiles(rels);
    if (deleted === null) return; // refused — no history entry, and nothing to re-read
    await this.host.appendActionHistory({
      kind: "delete-leftover",
      desc: deleteLeftoverDesc(deleted.length),
      changed: deleted.length,
      deletedFiles: paths,
    });
    await this.reload();
  }

  // The Leftover section/pill/hint trio's one gate (panelModel's pure predicate).
  private leftoverPresentation(): "section" | "hint" | "none" {
    return leftoverPresentation(this.selfInfo?.state ?? null, this.leftovers.length);
  }

  // Bulk cleanup confirms — its consequence crosses devices (the next Push mirror-deletes what
  // this removed); the per-row delete stays one-click.
  private async confirmAndDeleteAll(): Promise<void> {
    if (!(await confirmDeleteLeftovers(this.app, this.leftovers.length))) return;
    await this.deleteLeftovers(this.leftovers.map((l) => l.rel));
  }

  private renderLeftoverSection(host: HTMLElement): void {
    const open = this.leftoverOpen;
    const fold = host.createDiv({ cls: `config-sync-section is-leftover${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    const chevron = renderFoldChevron(head, open, null);
    head.createSpan({ cls: "config-sync-section-title", text: "Leftover in the store" });
    head.createSpan({ cls: "config-sync-pill is-neutral", text: `${this.leftovers.length}` });
    const all = head.createSpan({ cls: "config-sync-ofdel config-sync-ofdelall" });
    setIcon(all, "trash");
    setTooltip(all, `Delete all — ${this.leftovers.length} file${this.leftovers.length === 1 ? "" : "s"}…`);
    all.addEventListener("click", (e) => {
      e.stopPropagation(); // the bulk delete never doubles as the fold toggle
      void this.confirmAndDeleteAll();
    });
    // Collapse/expand flips the DOM in place — same idiom as the type sections' heads.
    let body: HTMLElement | null = open ? this.buildLeftoverBody(fold) : null;
    head.addEventListener("click", () => {
      if (this.leftoverOpen) {
        this.leftoverOpen = false;
        fold.removeClass("is-open");
        setFoldOpen(chevron, false);
        body?.remove();
        body = null;
      } else {
        this.leftoverOpen = true;
        fold.addClass("is-open");
        setFoldOpen(chevron, true);
        body = this.buildLeftoverBody(fold);
      }
    });
  }

  private buildLeftoverBody(fold: HTMLElement): HTMLElement {
    const body = fold.createDiv({ cls: "config-sync-leftover-body" });
    body.createDiv({
      cls: "config-sync-section-note",
      text: "Settings saved for items nothing here syncs any more. Deleting removes them from the store — and from your other devices after the next sync.",
    });
    const card = body.createDiv({ cls: "config-sync-card" });
    // Grouped by the main list's section vocabulary (the list arrives pre-sorted by section then
    // name); an empty group renders no header.
    const titles: Record<LeftoverSection, string> = { obsidian: "Obsidian", core: "Core plugins", community: "Community plugins", other: "Other files" };
    for (const section of LEFTOVER_SECTION_ORDER) {
      const files = this.leftovers.filter((lf) => lf.section === section);
      if (files.length === 0) continue;
      card.createDiv({ cls: "config-sync-sect", text: titles[section] });
      for (const lf of files) {
        const row = card.createDiv({ cls: "config-sync-oflow" });
        const info = row.createDiv({ cls: "config-sync-ofinfo" });
        const nm = info.createDiv({ cls: "config-sync-ofname" });
        if (lf.crumb !== null) {
          nm.createSpan({ cls: "config-sync-rule-parent", text: lf.crumb });
          nm.createSpan({ cls: "config-sync-rule-parentsep", text: " › " });
        }
        nm.appendText(lf.name);
        const path = info.createDiv({ cls: "config-sync-ofpath", text: lf.path });
        setTooltip(path, lf.path); // the mono line ellipsizes; the full path stays reachable
        row.createSpan({ cls: "config-sync-ofsize", text: this.formatBytes(lf.size) });
        const del = row.createSpan({ cls: "config-sync-ofdel" });
        setIcon(del, "trash");
        setTooltip(del, "Delete from the store");
        del.addEventListener("click", () => void this.deleteLeftovers([lf.rel]));
      }
    }
    return body;
  }

  // Capture-direction disabled rows default to ⏻ Enable; everything else
  // takes the availability ladder's first action. A carrier-synced disabled row
  // never defaults to an enable — the on/off card is the single write path for it.
  private defaultPolicyFor(r: StatusRow): StateAction {
    if (this.sectionOf(r.group.name) === "disabled") {
      if (this.carrierIsSynced(r.group.name)) return "none";
      if (this.effDir(r) === "capture") return "enable";
    }
    return defaultPolicy(this.availOf(r.group.name));
  }

  // The two carrier-unsynced fallback ladders' menu choice, folded into a single boolean:
  // `Fate.turnsOn` is unconditionally `false` whenever the
  // carrier is unsynced ("enablement verbs never appear" there), so neither ladder's
  // choice can ever reach `effectiveFate` through the row's own fate — this is the ONE place
  // that reads `this.policy` for that purpose, shared by `stagedRows()` (payload) and
  // `footerSelection()` (counts) so they can't independently
  // drift. Not installed → After install (`renderAfterInstallRow`, default on unless
  // explicitly "install"); installed-but-disabled → Enablement (`renderEnablementRow`, default
  // on unless explicitly "none"). Carrier-synced rows never reach either branch.
  private fallbackTurnsOn(name: string, input: FateInput): boolean {
    if (input.carrierSynced) return false;
    if (!input.installed) return this.policy.get(name) !== "install";
    return this.availOf(name).kind === "disabled" && this.policy.get(name) !== "none";
  }

  // stagedPayload's input rows: one entry per row currently in the list
  // (carriers included — they're excluded from rendering, not from this set, since their own
  // file can differ independently of any member — see stagedPayload's carrier-synthesis rule).
  // `ENABLEMENT_CARRIER_GROUPS` guards `carrier`/`elementId`: `computeFateInput` reads carrierSynced/true
  // for a carrier's OWN row too (its group name resolves to itself under
  // `enablementCarrierFor`/`carrierElementFor`), which would otherwise feed its own name back in
  // as a bogus "member" of itself. `fate` is the single shared `effectiveFate` derivation
  // (panelModel.ts) — a resolved conflict's REAL turnsOn (never the frozen one) and the fallback
  // ladders' choice both land here, exactly as `footerSelection()`/`displayFate()` see them.
  private stagedRows(): StageableRow[] {
    return this.rows().map((r) => {
      const { fate, input } = this.fateWithInput(r);
      const name = r.group.name;
      const isCarrierMember = input.carrierSynced && !ENABLEMENT_CARRIER_GROUPS.has(name);
      const choice = this.conflictChoice.get(name) ?? null;
      // The row's companion groups actionable in each direction (rollup's applyMembers/
      // captureMembers, parent name excluded — it's `itemName` already): stagedPayload fans these
      // out as plain `{ name, action: "none" }` entries on whichever side the row itself runs on.
      const rollup = this.familyRollupFor(r);
      return {
        id: name,
        itemName: name,
        fate: effectiveFate(fate, input, choice, this.fallbackTurnsOn(name, input)),
        selected: this.selected.has(name),
        carrier: isCarrierMember ? enablementCarrierFor(this.rowRef(name)) : null,
        elementId: isCarrierMember ? this.carrierElementFor(name) : null,
        availability: this.availOf(name),
        conflictChoice: choice,
        conflict: fate.glyph === "⚠",
        companionNames: {
          apply: rollup.applyMembers.filter((n) => n !== name),
          capture: rollup.captureMembers.filter((n) => n !== name),
        },
      };
    });
  }

  private capturePayload(): CaptureItem[] {
    return stagedPayload(this.stagedRows()).capture;
  }

  private applyPayload(): ApplyItem[] {
    const items = stagedPayload(this.stagedRows()).apply;
    // Cold bootstrap can stage BRAT itself (a catalog install) alongside BRAT-managed plugins
    // (installed via installViaBrat, which needs BRAT already on disk) — catalog installs must
    // finish first in the same run. Reorders ONLY the install-carrying items; every other item
    // (enable, update, none) keeps its original slot.
    const installActions = new Set<StateAction>(["install", "install-enable"]);
    const slots = items.map((item, i) => ({ item, i })).filter(({ item }) => installActions.has(item.action));
    if (slots.length > 1) {
      // Which staged names are BRAT-managed is decided HERE, where the identity is: the row's item
      // ref says which section and id it is, so nothing has to read a plugin id back out of a group
      // name.
      const ordered = orderInstallsCatalogFirst(slots.map(({ item }) => item.name), (name) => {
        const owner = refItemId(this.rowRef(name));
        return owner?.section === "community" && this.betaIds.has(owner.id);
      });
      const byName = new Map(slots.map(({ item }) => [item.name, item]));
      slots.forEach(({ i }, k) => {
        const name = ordered[k];
        const next = name === undefined ? undefined : byName.get(name);
        if (next !== undefined) items[i] = next;
      });
    }
    return items;
  }

  // Footer breakdown: counts derive from the SAME `effectiveFate` per row that feeds
  // `stagedRows()` — not an independent re-derivation — so the footer total
  // can never disagree with what a press of Apply/Capture would actually run, for a resolved
  // conflict's real turnsOn or a fallback-ladder "Turn it on" choice alike. Counts derive
  // straight from the rows, not the (possibly carrier-synthesized) apply/capture item arrays: a
  // synthesized carrier ApplyItem has no row of its own and must not inflate `applyN`.
  private footerSelection(): { applyN: number; installs: number; turnsOn: number; settings: number; captureN: number } {
    let applyN = 0;
    let captureN = 0;
    let installs = 0;
    let turnsOn = 0;
    let settings = 0;
    for (const r of this.rows()) {
      const name = r.group.name;
      if (!this.selected.has(name)) continue;
      const { fate: rawFate, input } = this.fateWithInput(r);
      const isConflict = rawFate.glyph === "⚠";
      const choice = this.conflictChoice.get(name) ?? null;
      if (isConflict && choice === null) continue;
      const fate = effectiveFate(rawFate, input, choice, this.fallbackTurnsOn(name, input));
      const dir = isConflict ? choice : fate.glyph === "↓" ? "apply" : fate.glyph === "↑" ? "capture" : null;
      if (dir === null) continue;
      if (dir === "capture") {
        captureN++;
        continue;
      }
      applyN++;
      if (!input.installed) installs++;
      if (fate.turnsOn) turnsOn++;
      if (input.hasSettingsPayload) settings++;
    }
    return { applyN, installs, turnsOn, settings, captureN };
  }

  private renderActionBar(macro: HTMLElement): void {
    const bar = macro.createDiv({ cls: "config-sync-actionbar" });
    // ONE selection reading feeds both the summary and the button labels. The payload arrays below
    // are what the run executes, not what the buttons count: `stagedPayload` fans a staged family
    // row out into itself plus one entry per actionable companion, so a single checked Appearance
    // becomes three payload entries. Reporting that as "3 items" next to the footer's "1 selected"
    // puts two disagreeing numbers on one screen and names a fan-out the user never chose.
    const sel = this.footerSelection();
    // Empty means the line would only restate the buttons — render nothing rather than an empty
    // span holding its own gap open.
    const summary = unifiedFooterSummary(sel);
    if (summary !== "") bar.createSpan({ cls: "config-sync-staged-count", text: summary });
    bar.createDiv({ cls: "config-sync-rule-spacer" });
    const capItems = this.capturePayload();
    const applyItems = this.applyPayload();

    const run = <T>(
      btn: ButtonComponent,
      other: ButtonComponent | null,
      verb: "Capturing" | "Applying",
      payload: T[],
      exec: (payload: T[], onProgress: ProgressFn) => Promise<GroupResult[] | null>
    ): void => {
      this.running = true;
      this.activeRun = { verb, done: 0, total: payload.length };
      btn.setDisabled(true);
      other?.setDisabled(true);
      const wrap = btn.buttonEl.parentElement; // the .config-sync-btnwrap span
      const barEl = wrap?.querySelector<HTMLElement>(".config-sync-progress") ?? null;
      const fill = barEl?.querySelector<HTMLElement>("div") ?? null;
      if (barEl !== null) {
        barEl.show();
        barEl.addClass("is-active"); // indeterminate shimmer while steps run
      }
      btn.buttonEl.addClass("is-busy");
      // Live status line under the action bar: "Name — phase…" + a slow-step hint after ~8s.
      const statusEl = macro.createDiv({ cls: "config-sync-runline" });
      statusEl.createSpan({ cls: "config-sync-runline-dot" });
      const statusText = statusEl.createSpan();
      const slowText = statusEl.createSpan({ cls: "config-sync-runline-slow" });
      let slowTimer: number | null = null;
      const setStatus = (current: string, phase: string): void => {
        statusText.setText(`${this.host.displayName(current)} — ${phase}`);
        slowText.setText("");
        if (slowTimer !== null) window.clearTimeout(slowTimer);
        slowTimer = window.setTimeout(() => {
          slowText.setText("Still working — network fetches can take a while");
        }, 8000);
      };
      void (async () => {
        try {
          const results = await exec(payload, (done, total, current, phase) => {
            this.activeRun = { verb, done, total };
            btn.setButtonText(runProgressLabel(verb, done, total));
            btn.buttonEl.setAttribute("aria-label", current);
            setStatus(current, phase ?? (verb === "Capturing" ? "capturing…" : "applying…"));
            if (fill !== null) fill.style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
          });
          this.setLastRun(verb === "Capturing" ? "capture" : "apply", null, results);
          // Conflict resolutions are a per-run judgment call — a successful run
          // clears the whole map rather than pruning row-by-row, so a resolved-but-still-differing
          // straggler (a partial failure elsewhere in the same run) re-asks rather than silently
          // re-running last time's choice against a divergence that may have moved on.
          this.conflictChoice.clear();
        } finally {
          if (slowTimer !== null) window.clearTimeout(slowTimer);
          statusEl.remove();
          barEl?.removeClass("is-active");
          this.running = false;
          this.activeRun = null;
        }
        await this.reload(); // re-render restores the idle footer
      })();
    };

    const mkWrapped = (): { wrap: HTMLElement; btn: ButtonComponent } => {
      const wrap = bar.createSpan({ cls: "config-sync-btnwrap" });
      const btn = new ButtonComponent(wrap);
      const prog = wrap.createDiv({ cls: "config-sync-progress" });
      prog.createDiv();
      prog.hide();
      return { wrap, btn };
    };

    // Both buttons show only when both directions are staged — otherwise a lone
    // staged side gets its own button, and an empty selection shows neither (the footer's
    // "Nothing selected" already says so).
    const capW = capItems.length > 0 || this.activeRun?.verb === "Capturing" ? mkWrapped() : null;
    if (capW !== null) {
      if (this.activeRun?.verb === "Capturing") {
        capW.btn.setButtonText(runProgressLabel("Capturing", this.activeRun.done, this.activeRun.total));
        capW.btn.buttonEl.addClass("is-busy");
      } else {
        renderActionIcon(capW.btn.buttonEl, "capture");
        capW.btn.buttonEl.appendText(` Capture ${sel.captureN} item${sel.captureN === 1 ? "" : "s"}`);
      }
      capW.btn.buttonEl.addClass("config-sync-btn-capture");
      capW.btn.setDisabled(this.running || capItems.length === 0);
    }

    const applyW = applyItems.length > 0 || this.activeRun?.verb === "Applying" ? mkWrapped() : null;
    if (applyW !== null) {
      applyW.btn.setCta();
      if (this.activeRun?.verb === "Applying") {
        applyW.btn.setButtonText(runProgressLabel("Applying", this.activeRun.done, this.activeRun.total));
        applyW.btn.buttonEl.addClass("is-busy");
      } else {
        renderActionIcon(applyW.btn.buttonEl, "apply");
        applyW.btn.buttonEl.appendText(` Apply ${sel.applyN} item${sel.applyN === 1 ? "" : "s"}`);
      }
      applyW.btn.setDisabled(this.running || applyItems.length === 0);
    }

    capW?.btn.onClick(() => run(capW.btn, applyW?.btn ?? null, "Capturing", this.capturePayload(), (n, p) => this.host.captureItems(n, p)));
    applyW?.btn.onClick(() => run(applyW.btn, capW?.btn ?? null, "Applying", this.applyPayload(), (n, p) => this.host.applyItems(n, p)));
  }

  private renderRemoteMode(main: HTMLElement, remote: Remote): void {
    this.renderResultStrip(main);
    const check = this.host.remoteCheck(remote.name)?.check;
    const icon = this.remoteIcon(check);
    main.createDiv({
      cls: "config-sync-remote-head",
      text: `${remote.name} · captured ${isoAge(check?.remoteCapturedAt ?? null)} — ${icon.tip}`,
    });
    const prog = this.host.remoteRefreshProgress();
    if (prog !== null) {
      const agg = main.createDiv({ cls: "config-sync-cmp-agg" });
      agg.createSpan({ cls: "config-sync-cmp-spinner" });
      agg.createSpan({ text: `Checking ${prog.total} remote${prog.total === 1 ? "" : "s"}… ${prog.done} done` });
    }
    const detail = main.createDiv({ cls: "config-sync-report-files config-sync-remote-pane" });
    void this.renderRemoteDetail(detail, remote, check);
  }

  private remoteIcon(check: RemoteCheck | undefined): { glyph: string; cls: string; tip: string; action?: SyncAction } {
    const state = check?.state ?? "unknown";
    switch (state) {
      case "remote-newer":
        return { glyph: "↓", cls: "is-pull", tip: "remote captured later — Pull would update your store", action: "pull" };
      case "remote-older":
        return { glyph: "↑", cls: "is-push", tip: "remote is older — Push would update the remote", action: "push" };
      case "same":
        return { glyph: "✓", cls: "is-ok", tip: "remote matches your store" };
      case "no-store":
        return { glyph: "—", cls: "is-miss", tip: "no store at this remote yet" };
      case "unknown":
      default:
        return { glyph: "?", cls: "is-neq", tip: "remote state unknown" };
    }
  }

  // A per-remote progress notify during refreshRemoteChecks triggers a full re-render. A re-render
  // re-attaches to the SAME compare (keyed by remote name + reader-cache generation) instead of
  // restarting it — restarting would abandon the in-flight clone (whose git subprocess runs on
  // regardless) and reset the elapsed indicator to 0.0s;
  // a new generation (refresh completed, remote edited) naturally starts a fresh one.
  // A compare that already settled successfully stays cached on the entry (startRemoteCompare)
  // so a re-render while OTHER remotes are still being checked paints the stored result directly
  // instead of flashing the progress UI and re-comparing again.
  private async renderRemoteDetail(detail: HTMLElement, remote: Remote, check: RemoteCheck | undefined): Promise<void> {
    detail.empty();
    const gen = this.renderGen;
    const key = `${remote.name}:${this.host.readerGeneration()}`;
    let reattach = this.inflightCompare !== null && this.inflightCompare.key === key ? this.inflightCompare : null;

    if (reattach !== null && reattach.result !== null) {
      if (Date.now() - reattach.startedAt <= REUSE_MAX_AGE_MS) {
        this.paintRemoteCompareResult(detail, remote, check, reattach.result);
        return;
      }
      // A same-generation cached result older than REUSE_MAX_AGE_MS is stale — fall through
      // to start a fresh compare (below) instead of serving it forever within the generation.
      this.inflightCompare = null;
      reattach = null;
    }

    const box = detail.createDiv({ cls: "config-sync-remote-comparing" });
    box.createSpan({ cls: "config-sync-cmp-spinner" });
    box.createSpan({ cls: "config-sync-cmp-label", text: `Comparing with ${remote.name}` });
    const startedAt = reattach?.startedAt ?? Date.now();
    const elapsed = box.createSpan({ cls: "config-sync-cmp-elapsed", text: `${((Date.now() - startedAt) / 1000).toFixed(1)}s` });
    const phaseEl = detail.createDiv({
      cls: "config-sync-cmp-phase",
      text: (reattach?.phase ?? "fetch") === "fetch" ? "Fetching remote…" : "Comparing files…",
    });
    detail.createDiv({ cls: "config-sync-cmp-bar" }).createDiv({ cls: "config-sync-cmp-bar-fill" });

    // A prior render's ticker may still be live against this same entry (e.g. this render is a
    // re-attach while the compare is still pending) — only one ticker may write into a live span.
    if (reattach !== null && reattach.ticker !== null) {
      window.clearInterval(reattach.ticker);
      reattach.ticker = null;
    }
    const ticker = window.setInterval(() => {
      elapsed.setText(`${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }, 100);
    this.registerInterval(ticker); // safety net: cleared if the view unloads mid-compare

    const onPhase = (phase: "fetch" | "compare"): void => {
      // A sidebar panel switch reuses renderGen (only reload() increments it), so also check
      // panelSection — otherwise a stale onPhase from a since-abandoned remote pane could
      // setText a detached node.
      if (gen !== this.renderGen || this.panelSection.kind !== "remote" || this.panelSection.name !== remote.name) return;
      phaseEl.setText(phase === "fetch" ? "Fetching remote…" : "Comparing files…");
    };
    const active = reattach ?? this.startRemoteCompare(remote, key, startedAt, onPhase);
    active.ticker = ticker;

    let dd: RemoteCompareResult;
    try {
      dd = await active.promise;
      window.clearInterval(ticker);
      if (active.ticker === ticker) active.ticker = null;
    } catch (e) {
      window.clearInterval(ticker);
      if (active.ticker === ticker) active.ticker = null;
      if (gen !== this.renderGen || this.panelSection.kind !== "remote" || this.panelSection.name !== remote.name) return;
      detail.empty();
      const raw = (e as Error).message;
      // Vault remotes have no login and no timeout marker; raw fs errors like EACCES
      // "permission denied" must not read as a Git login problem (non-git → other).
      const kind = remote.type === "git" ? classifyRemoteFailure(raw) : "other";
      const card = detail.createDiv({ cls: "config-sync-remote-errcard" });
      card.createDiv({ cls: "config-sync-remote-errcard-head", text: `Couldn't compare with ${remote.name}` });
      const body =
        kind === "no-token"
          ? raw
          : kind === "auth"
            ? "The Git host asked for a login, and there's no way to answer it here. Set up this remote's credentials on this device, then check again."
            : kind === "timeout"
              ? "The remote didn't answer within a minute. Check the connection, then check again."
              : "Couldn't reach this remote.";
      card.createDiv({ cls: "config-sync-remote-errcard-body", text: body });
      if (kind !== "no-token") {
        const det = card.createEl("details");
        det.createEl("summary", { text: remote.type === "git" ? "Show Git output" : "Show details" });
        det.createEl("pre", { text: raw });
      }
      return;
    }
    if (gen !== this.renderGen || this.panelSection.kind !== "remote" || this.panelSection.name !== remote.name) return;
    this.paintRemoteCompareResult(detail, remote, check, dd);
  }

  // Starts exactly one deepDiff for (remote, key) and stores it on this.inflightCompare. On
  // success the entry stays cached (result populated) for re-renders to reuse; on rejection the
  // entry is dropped so the next render retries fresh rather than reusing a failed compare. Only
  // superseded (already-replaced) entries are inert here — the `this.inflightCompare === entry`
  // check is what makes both branches a no-op once a newer entry has taken over the field.
  private startRemoteCompare(remote: Remote, key: string, startedAt: number, onPhase: (phase: "fetch" | "compare") => void): InflightCompare {
    const entry: InflightCompare = {
      key,
      startedAt,
      phase: "fetch",
      result: null,
      ticker: null,
      promise: Promise.resolve({ entries: [], lockDiffers: false, remoteLabels: {} }), // placeholder, replaced synchronously below
    };
    entry.promise = this.host
      .deepDiff(remote, (phase) => {
        entry.phase = phase;
        onPhase(phase);
      })
      .then(
        (dd) => {
          if (this.inflightCompare === entry) entry.result = dd;
          return dd;
        },
        (e: unknown) => {
          if (this.inflightCompare === entry) this.inflightCompare = null;
          throw e;
        }
      );
    this.inflightCompare = entry;
    return entry;
  }

  private paintRemoteCompareResult(detail: HTMLElement, remote: Remote, check: RemoteCheck | undefined, dd: RemoteCompareResult): void {
    detail.empty();
    const { entries, lockDiffers, remoteLabels } = dd;
    // Local resolution wins throughout — the view's own in-memory group label
    // first, then this device's own (possibly backfill-healed) local lock label, matching
    // displayName's own fallback order — and only then the remote's lock label, for entries this
    // device has never captured a label for at all (e.g. remote-only groups).
    const storedLabel = (g: string): string | undefined =>
      findGroupByName(this.groups, g)?.label ?? this.host.localLockLabel(g) ?? remoteLabels[g];

    // Companion entries fold into their parent's BEFORE sectioning: the remote pane
    // shows the same one-entry-per-family grammar the main list's rows() does — the
    // sections, on/off extraction, and the "N more items match" summary below all run
    // over the folded set.
    const folded = foldCompanionEntries(entries, (g) => this.host.companionParentOf(g));
    const changed = folded.filter((e) => e.files.length > 0);
    // Mirrors the main list's four fixed type sections — same section vocabulary,
    // same on/off-carrier extraction, so a remote diff and the item list never disagree on where
    // a plugin lives.
    for (const sec of remoteSections(changed, (g) => this.itemSectionOf(g), (g) => this.fullName(g, storedLabel(g)))) {
      const n = sec.entries.length + (sec.onOff !== null ? 1 : 0);
      // No chevron/checkbox/carrier-chip/click handler here: this header is read-only summary,
      // never a control — a dead affordance reads as a broken one.
      const fold = detail.createDiv({ cls: `config-sync-section is-typesection is-open is-static is-${sec.section}` });
      const head = fold.createDiv({ cls: "config-sync-section-head" });
      head.createSpan({ cls: "config-sync-section-title", text: TYPE_SECTION_TITLES[sec.section] });
      head.createSpan({ cls: "config-sync-pill is-neutral", text: sectionCountLabel(n, n, false) });
      if (sec.onOff !== null) this.renderRemoteOnOff(fold, sec.onOff, remote.name, storedLabel);
      for (const e of sec.entries) this.renderRemoteDiffEntry(fold, e, remote.name, storedLabel(e.group));
    }

    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.familyGroups()
      // The excluded self item was never compared — it is neither changed nor matched, and
      // listing it two lines above the "stays out of this remote" note would contradict it.
      .filter((g) => !changedNames.has(g.name) && !(remote.excludeSelf === true && g.name === SELF_GROUP_NAME))
      .map((g) => this.fullName(g.name, g.label));
    const matched = matchNames.length;
    if (entries.length === 0) {
      detail.createDiv({
        cls: "config-sync-unchanged",
        text: lockDiffers
          ? "✓ contents match — remote has newer version info; Pull refreshes it"
          : "✓ remote matches the local store",
      });
    } else {
      // The aligned action's REAL payload, then what it will not do: Pull is
      // additive (never removes local files); Push mirrors (removes remote-only files).
      const allFiles = changed.flatMap((e) => e.files);
      const incoming = allFiles.filter((f) => f.kind !== "deleted").length;
      const keptLocal = allFiles.filter((f) => f.kind === "deleted").length;
      const outgoing = allFiles.filter((f) => f.kind !== "added").length;
      const remoteOnly = allFiles.filter((f) => f.kind === "added").length;
      const summary = detail.createDiv({ cls: "config-sync-remote-summary" });
      summary.createDiv({
        text: pullAligned
          ? incoming === 0 ? "Pull would bring nothing" : `Pull would bring ${incoming} file${incoming === 1 ? "" : "s"}`
          : outgoing === 0 ? "Push would send nothing" : `Push would send ${outgoing} file${outgoing === 1 ? "" : "s"}`,
      });
      if (pullAligned && keptLocal > 0) {
        summary.createDiv({
          cls: "config-sync-remote-kept",
          text: keptLocal === 1
            ? `1 file exists only in your store — Pull never removes files; Push would add it to ${remote.name}.`
            : `${keptLocal} files exist only in your store — Pull never removes files; Push would add them to ${remote.name}.`,
        });
      }
      if (!pullAligned && remoteOnly > 0) {
        summary.createDiv({
          cls: "config-sync-remote-kept",
          text: remoteOnly === 1
            ? `1 file exists only at ${remote.name} — Push would remove it there; Pull would bring it here.`
            : `${remoteOnly} files exist only at ${remote.name} — Push would remove them there; Pull would bring them here.`,
        });
      }
      if (matched > 0) {
        const line = detail.createDiv({ cls: "config-sync-unchanged" });
        line.appendText(`✓ ${matched} more item${matched === 1 ? " matches" : "s match"}`);
        // A one-way reveal (never re-collapses) — same static FOLD glyph as renderUnifiedFiles's
        // "N more files" line.
        setIcon(line.createSpan({ cls: "config-sync-row-chevron" }), "chevron-right");
        line.addEventListener("click", () => line.setText(`✓ ${matchNames.join(" · ")}`));
      }
    }
    if (remote.excludeSelf === true) {
      detail.createDiv({ cls: "config-sync-remote-selfnote", text: "Config Sync's own settings stay out of this remote" });
    }

    // lockDiffers alone still gives Pull something to do (refresh the newer version info),
    // so it keeps the buttons live even when every file's contents match.
    this.renderRemoteButtons(detail, remote, pullAligned, entries.length === 0 && !lockDiffers);
  }

  // The pinned on/off line: a section's core-plugins/community-plugins entry
  // never renders as an ordinary row — its file diff IS a member on/off delta, so this is the
  // only place that delta shows. Sums onOffFlips over every file the carrier entry carries
  // (normally exactly one) rather than assuming a single file.
  private renderRemoteOnOff(host: HTMLElement, e: RemoteDiffEntry, remoteName: string, storedLabel: (g: string) => string | undefined): void {
    const onAtRemote: string[] = [];
    const offAtRemote: string[] = [];
    let remoteOnCount = 0;
    let localOnCount = 0;
    for (const f of e.files) {
      const flips = onOffFlips(f.local, f.remote);
      onAtRemote.push(...flips.onAtRemote);
      offAtRemote.push(...flips.offAtRemote);
      remoteOnCount += flips.remoteOnCount;
      localOnCount += flips.localOnCount;
    }
    onAtRemote.sort();
    offAtRemote.sort();
    const n = onAtRemote.length + offAtRemote.length;
    const key = `${remoteName}::${e.group}::onoff`;
    const line = host.createDiv({ cls: "config-sync-remote-onoff" });
    const fold = host.createDiv({ cls: "config-sync-remote-fliplist" });
    // Content is always rebuilt from the CURRENT compare result — no cached-`built`
    // divergence between a fresh render that opens because the key persisted and a click that
    // opens it live; both paths call this.
    const buildFold = (): void => {
      fold.empty();
      // Element id → group name by carrier: community carrier ids compile to
      // `plugin-<id>` groups; core carrier ids ARE the group name — then the same
      // storedLabel → displayParts chain the section's own rows resolve names through, so
      // narration names never disagree with a row's display name.
      const displayOf = (elementId: string): string => {
        const group = e.group === "community-plugins" ? communityGroupName(elementId) : elementId;
        return this.host.displayParts(group, storedLabel(group)).label;
      };
      const narration = onOffNarrationLines(onAtRemote, offAtRemote, remoteOnCount, localOnCount, displayOf, remoteName);
      for (const l of [narration.on, narration.off]) {
        if (l === null) continue;
        const row = fold.createDiv();
        row.appendText(l.prefix);
        row.createSpan({ cls: "config-sync-remote-flip-value", text: l.value });
      }
      this.renderRemoteFileRows(fold, e, remoteName);
    };
    let open = this.remoteFoldsOpen.has(key);
    line.appendText(onOffLineText(n));
    const chev = renderFoldChevron(line, open, null);
    if (open) buildFold();
    else fold.hide();
    line.addEventListener("click", () => {
      open = !open;
      setFoldOpen(chev, open);
      if (!open) {
        fold.hide();
        this.remoteFoldsOpen.delete(key);
        return;
      }
      buildFold();
      fold.show();
      this.remoteFoldsOpen.add(key);
    });
  }

  private renderRemoteDiffEntry(detail: HTMLElement, e: RemoteDiffEntry, remoteName: string, storedLabel?: string): void {
    // Honest, never pretend the item doesn't exist — an item THIS device has
    // opted out of gets the same excluded presentation here it gets in the main list, no fold
    // (there is nothing to diff into: this device never reads or writes it either direction).
    if (this.host.deviceOptedOut(e.group)) {
      const row = detail.createDiv({ cls: "config-sync-report-row config-sync-remote-row" });
      this.renderRuleName(row, e.group, storedLabel);
      row.createDiv({ cls: "config-sync-rule-spacer" });
      // The same row-level icon the main list's excluded fate renders, not
      // text — this row IS that fate, just reached from the remote diff pane.
      this.renderFateStateIcon(row, "excluded", "Not synced on this device");
      this.renderFateChip(row, "your rule");
      return;
    }
    const key = `${remoteName}::${e.group}`;
    const isOpen = this.remoteFoldsOpen.has(key);
    const row = detail.createDiv({ cls: "config-sync-report-row config-sync-remote-row" });
    const chev = renderFoldChevron(row, isOpen, "config-sync-cm-chev");
    this.renderRuleName(row, e.group, storedLabel);
    row.createDiv({ cls: "config-sync-rule-spacer" });
    const counts = { added: 0, updated: 0, deleted: 0 };
    for (const f of e.files) counts[f.kind]++;
    if (counts.added > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${counts.added}` });
    if (counts.updated > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${counts.updated}` });
    if (counts.deleted > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${counts.deleted}` });
    const fold = detail.createDiv({ cls: "config-sync-remote-files" });
    // Content is always rebuilt from the CURRENT compare result — a fresh render that
    // opens because the key persisted renders the same content a click would build live.
    if (isOpen) this.renderRemoteFileRows(fold, e, remoteName);
    else fold.hide();
    row.addEventListener("click", () => {
      const open = fold.isShown();
      if (open) {
        fold.hide();
        setFoldOpen(chev, false);
        this.remoteFoldsOpen.delete(key);
        return;
      }
      fold.empty();
      this.renderRemoteFileRows(fold, e, remoteName);
      fold.show();
      setFoldOpen(chev, true);
      this.remoteFoldsOpen.add(key);
    });
  }

  // File-level detail for one remote diff row: added → updated → deleted, each line expandable
  // into a content diff (single-sided kinds diff against an empty side).
  private renderRemoteFileRows(fold: HTMLElement, e: RemoteDiffEntry, remoteName: string): void {
    const order = { added: 0, updated: 1, deleted: 2 } as const;
    const files = [...e.files].sort((a, b) => order[a.kind] - order[b.kind] || (a.itemRel < b.itemRel ? -1 : a.itemRel > b.itemRel ? 1 : 0));
    for (const f of files) {
      const cls = f.kind === "added" ? "is-add" : f.kind === "updated" ? "is-upd" : "is-del";
      const line = fold.createDiv({ cls: `config-sync-remote-frow ${cls} config-sync-diffable` });
      line.createSpan({ cls: "config-sync-remote-fglyph", text: f.kind === "added" ? "+" : f.kind === "updated" ? "~" : "−" });
      line.createSpan({ cls: "config-sync-remote-fname", text: f.itemRel });
      const key = `${remoteName}::${e.group}::${f.itemRel}`;
      const isOpen = this.remoteFoldsOpen.has(key);
      // Same trailing affordance as the local FILES list (one-icon rule:
      // this remote line is the SAME control on another surface, so it changes with
      // it — a `· diff ▾` left behind here is exactly the drift DESIGN §2.1 forbids).
      const affLabel = f.kind === "added" ? "View content" : "View changes";
      const diffIcon = line.createSpan({ cls: `config-sync-diffic${isOpen ? " is-open" : ""}`, attr: { "aria-label": affLabel, role: "button", tabindex: "0" } });
      setIcon(diffIcon, "file-diff");
      let panel: HTMLElement | null = null;
      // Content is always rebuilt from the CURRENT compare result — a fresh render
      // that opens because the key persisted renders the same panel a click would build live.
      if (isOpen) {
        const p = createDiv({ cls: "config-sync-inline-diff" });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        this.renderRemoteFileDiff(p, e.group, f, remoteName);
      }
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (panel !== null) {
          panel.remove();
          panel = null;
          diffIcon.removeClass("is-open");
          this.remoteFoldsOpen.delete(key);
          return;
        }
        diffIcon.addClass("is-open");
        const p = createDiv({ cls: "config-sync-inline-diff" });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        this.renderRemoteFileDiff(p, e.group, f, remoteName);
        this.remoteFoldsOpen.add(key);
      });
    }
  }

  private renderRemoteFileDiff(p: HTMLElement, group: string, f: RemoteDiffFile, remoteName: string): void {
    let left = f.local ?? "";
    let right = f.remote ?? "";
    const switchSorted = isSwitchListGroup(group);
    let jsonSorted = false;
    if (switchSorted) {
      left = f.local !== null ? switchListSortedView(f.local) : "";
      right = f.remote !== null ? switchListSortedView(f.remote) : "";
    } else if (f.itemRel.endsWith(".json") && f.local !== null && f.remote !== null) {
      const sl = jsonSortedView(f.local);
      const sr = jsonSortedView(f.remote);
      if (sl !== null && sr !== null) {
        left = sl;
        right = sr;
        jsonSorted = true;
      }
    }
    if (f.local !== null && f.remote !== null && left === right) {
      p.createDiv({ cls: "config-sync-expand-note", text: "Only key order / formatting differs." });
      return;
    }
    const leftLabel = f.local !== null ? "your store" : "not in your store";
    const rightLabel = f.remote !== null ? remoteName : `not at ${remoteName}`;
    renderDiffPanel(p, left, right, leftLabel, rightLabel, { name: f.itemRel, sorted: switchSorted || jsonSorted },
      () => openDiffModal(this.app, left, right, leftLabel, rightLabel, { name: f.itemRel, sorted: switchSorted || jsonSorted }), null);
  }

  private renderRemoteButtons(detail: HTMLElement, remote: Remote, pullAligned: boolean, noChanges: boolean): void {
    const bar = detail.createDiv({ cls: "config-sync-actionbar" });

    const pull = new ButtonComponent(bar);
    renderActionIcon(pull.buttonEl, "pull");
    pull.buttonEl.appendText(` Pull from ${remote.name}`);
    pull.buttonEl.addClass("config-sync-remote-btn", "is-pull");
    if (noChanges) pull.buttonEl.addClass("is-dimmed");
    else if (pullAligned) pull.buttonEl.addClass("is-primary");
    else {
      pull.buttonEl.addClass("is-dimmed");
      pull.buttonEl.setAttribute("aria-label", "Pull would overwrite your newer local store");
    }
    pull.onClick(async () => {
      this.setLastRun("pull", remote.name, await this.host.pullFrom(remote));
      await this.reload();
    });

    const push = new ButtonComponent(bar);
    renderActionIcon(push.buttonEl, "push");
    push.buttonEl.appendText(` Push to ${remote.name}`);
    push.buttonEl.addClass("config-sync-remote-btn", "is-push");
    if (noChanges) push.buttonEl.addClass("is-dimmed");
    else if (!pullAligned) push.buttonEl.addClass("is-primary");
    else {
      push.buttonEl.addClass("is-dimmed");
      push.buttonEl.setAttribute("aria-label", "Push would overwrite the newer remote");
    }
    push.onClick(async () => {
      this.setLastRun("push", remote.name, await this.host.pushTo(remote));
      await this.reload();
    });
  }
}

// Confirm removing an item from sync, offering to also delete its saved copy in the store.
// Exported: the settings-panel card's write entrance (SettingTab.ts) is wired directly to it,
// so it needs a caller outside this file.
export class StopSyncingModal extends Modal {
  private deleteStore: boolean;

  constructor(app: App, private label: string, private storeFiles: number, private onConfirm: (deleteStore: boolean) => Promise<void>) {
    super(app);
    this.deleteStore = storeFiles > 0; // default: clean removal, no leftover
  }

  onOpen(): void {
    this.titleEl.setText(`Stop syncing ${this.label}?`);
    this.contentEl.createDiv({
      cls: "config-sync-expand-note",
      text: "Config Sync will forget this item on all your devices. Nothing installed is touched.",
    });
    if (this.storeFiles > 0) {
      const row = this.contentEl.createDiv({ cls: "config-sync-exclude-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = this.deleteStore;
      cb.addEventListener("change", () => (this.deleteStore = cb.checked));
      const t = row.createSpan();
      t.createSpan({ text: `Also delete its settings saved in the store (${this.storeFiles} file${this.storeFiles === 1 ? "" : "s"})` });
      t.createDiv({ cls: "config-sync-expdesc", text: "Recommended — otherwise they stay in the store, unused. You can re-add the item later either way." });
    }
    const bar = this.contentEl.createDiv({ cls: "config-sync-modal-buttons" });
    new ButtonComponent(bar).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(bar)
      .setButtonText("Stop syncing")
      .setWarning()
      .onClick(() => {
        const del = this.deleteStore;
        this.close();
        void this.onConfirm(del);
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

