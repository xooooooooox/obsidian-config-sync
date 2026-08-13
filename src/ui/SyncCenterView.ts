import { App, ButtonComponent, ExtraButtonComponent, ItemView, Menu, Modal, Platform, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { ApplyItem, CaptureItem, orderInstallsCatalogFirst, ProgressFn, StateAction } from "../core/ConfigSyncCore";
import { lockRefFor, refItemId } from "../core/itemKeys";
import { GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry, RemoteDiffFile, remoteDirectionCounts } from "../core/status";
import { SECTION_LABELS, findGroupByName, SELF_GROUP_NAME, sectionForGroup, communityGroupName } from "../core/catalog";
import { EVERYWHERE, FileChanges, FileSharing, GroupResult, hasChanges, ItemRef, Remote, Sharing, sharingEquals, SyncGroup, StorageSection } from "../core/types";
import { DeviceElementState } from "../core/deviceElements";
import { RuleListId } from "../core/enablementRules";
import {
  buildFileLocalMenu,
  buildLocalMenu,
  enablementRowModel,
  FOLLOWS_LABEL,
  NOT_SYNCED_HERE_LABEL,
  RowSegment,
  RULE_OPTIONS,
  ruleIcon,
  ruleLabel,
  ruleLandingNeedsSeed,
} from "./enablementRow";
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
  foldCompanionEntries,
  groupExcludedHere,
  insyncLineText,
  isValidPolicy,
  legacyLockedFamilyBucket,
  matchesSearch,
  mergeFamilyChanges,
  moreFilesText,
  nosettingsLineText,
  onOffFlips,
  onOffLineText,
  onOffNarrationLines,
  PanelFilter,
  partitionSection,
  presentedState,
  remoteSections,
  RowBucket,
  runProgressLabel,
  SectionKind,
  sectionForItem,
  sectionCountLabel,
  mobileSectionCountLabel,
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
  Direction,
  effectiveDirection,
} from "./panelModel";
import { Fate, FateInput, NOTHING_YET_SENTENCE, rowFate, versionAheadClause } from "./fateModel";
import { renderDiffPanel } from "./diffView";
import { EnablementList, isSwitchListGroup, switchListSortedView } from "../core/switchList";
import { jsonSortedView } from "../core/merge";
import { renderReportContent, renderReportPills, stripHeader } from "./reportContent";
import { RunRecord, RunKind, RunStatus, worstStatus, formatRunTime, deleteLeftoverDesc } from "../core/runHistory";
import { ACTION_ICON, ACTION_COLOR_CLASS, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";
import { FATE_CHIP_ICON } from "./fateChipIcons";
import { renderFoldIcon, renderFoldCount, type FoldKind } from "./foldIcons";
// ITEM_SECTION_LABELS aliased: this file already declares its own ITEM_SECTION_LABELS (sidebar category
// labels, see below) for an unrelated domain.
import {
  FILE_SHARING_MENU_UNAVAILABLE_TEXT,
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
// The row's PanelFilter bucket, mirroring the state-filter pills (ledger C-#23: fate-derived, not
// raw GroupState — a conflict-bucket row resolves to "apply", its current placement). locked →
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
// (task-1 NEW-I2's lesson: a test that restates a literal agrees with whichever site its author was
// looking at). `as const` is load-bearing, not decoration: it gives `SyncQualifierKey` below, which
// makes `syncResolvers` a total map over these keys — so renaming a key here without renaming its
// resolver is a compile error rather than a qualifier that parses and autocompletes and then
// filters nothing.
export const SYNC_QUALIFIER_SPECS = [
  { key: "type", description: "item kind", values: [{ value: "file", description: "single-file item" }, { value: "folder", description: "folder item" }] },
  // `section:` — spec §7. It replaces v2's `scope:` outright, with NO alias: `scope` named three
  // different concepts depending on where you stood, and accepting it here would keep one of them
  // alive in the one place the user actually types. An unrecognised key is free text, so a typed
  // `scope:core` now searches for the literal words instead of silently filtering.
  //
  // `beta` is presented but never stored (spec §7b): it is an install source derived from the BRAT
  // index, so the resolver reads the same presented section the sidebar does.
  { key: "section", description: "item family", values: [{ value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "beta", description: "installed via BRAT" }, { value: "custom" }] },
  { key: "action", description: "what it needs", values: [{ value: "capture", description: "needs capture" }, { value: "apply", description: "needs apply" }, { value: "ok", description: "in sync" }, { value: "none", description: "no settings yet" }] },
  { key: "mode", description: "field handling", values: [{ value: "plain" }, { value: "fields" }, { value: "encrypted" }] },
  { key: "device", description: "device class", values: [{ value: "all" }, { value: "desktop" }, { value: "mobile" }] },
] as const satisfies readonly QualifierSpec[];
export type SyncQualifierKey = (typeof SYNC_QUALIFIER_SPECS)[number]["key"];
export const SYNC_QUALIFIER_KEYS: ReadonlySet<string> = new Set(SYNC_QUALIFIER_SPECS.map((s) => s.key));

// Sidebar section order: Beta sits between Community and custom (batch 3 ③).
const ITEM_SECTION_ORDER: (StorageSection | "beta")[] = ["obsidian", "core", "community", "beta", "custom"];
const ITEM_SECTION_LABELS: Record<StorageSection | "beta", string> = { ...SECTION_LABELS, beta: "Beta" };

const STATUS_CLS: Record<RunStatus, string> = { ok: "is-ok", warning: "is-warn", error: "is-error" };
// RunKind is wider than SyncAction (it also has "adopt"/"stop-sync"/"delete-leftover"), so
// map explicitly rather than assigning rec.kind directly — undefined for the non-actions.
const ACTION_CELL_MAP: Partial<Record<RunKind, SyncAction>> = { capture: "capture", apply: "apply", adopt: "apply", push: "push", pull: "pull" };
// The two on/off list carriers (task-4): "one object = one row" dissolves their own list row
// into the Core/Community section header chip — they never appear as a row themselves.
const CARRIER_GROUP_NAMES = new Set(["core-plugins", "community-plugins"]);
// C-#48 (search perf spec §3): trailing debounce for the search input's heavy re-render — long
// enough to coalesce a fast typist's whole burst into one render, short enough to still read as
// live filtering once typing pauses.
const SEARCH_DEBOUNCE_MS = 130;

// C-#39 noise floor (report fix-round-3, live-verification fix): `scrollWidth` vs `clientWidth`
// on a genuinely non-overflowing flex row was observed live producing a phantom ≤4px delta from
// subpixel/integer rounding (1017 vs 1013 on a chipless row) — not a real overflow. 8px (one
// layout gap unit) clears that noise with margin while staying far under any real chip's width
// (the live narrow-pane repro that DOES need compacting was a 92px gap), so it can't mask a
// genuine overflow. See syncChipOverflow.
const CHIP_OVERFLOW_EPSILON = 8;

// After-install menu labels (spec §4, copy final) — the fallback ladder's two real choices
// (carrier NOT synced, row installs).
const AFTER_INSTALL_LABELS: Record<"install-enable" | "install", string> = {
  "install-enable": "Turn it on",
  install: "Leave it off",
};

// Enablement menu labels (review fix #3, task 6 round 2 — same copy as After install, different
// StateAction domain): carrier NOT synced, row already installed but disabled. Stored under
// "enable"/"none" rather than "install-enable"/"install" so a stored choice stays valid under
// `isValidPolicy` for a disabled row's own ladder (`policyOptions`) and survives `reload()`'s
// stale-policy pruning instead of being silently dropped on the next render.
const ENABLEMENT_LABELS: Record<"enable" | "none", string> = {
  enable: "Turn it on",
  none: "Leave it off",
};

// Session-remembered UI state: which sections have their ✓ / ⊘ / ○ trailing lines flattened open.
const sessionUi = {
  insyncOpen: new Set<string>(),
  excludedOpen: new Set<string>(), // C-#45 §7 (fix-round 4)
  nosettingsOpen: new Set<string>(),
};

// Staging state lives at session level, not view level: mobile Obsidian recreates views on
// tab switches, and per-instance state would re-run the default pre-check on every
// recreation — a run's cleared selection came back "self-checked" (batch 3 ⑥).
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
  // Non-null when this device's data.json was written by a newer Config Sync (spec
  // 2026-08-11-data-model-hardening.md §4.1): the plugin refuses every write while it is set, and
  // the panel says so instead of quietly offering runs that would be refused one by one.
  schemaStop(): { found: number } | null;
  // The same predicate the settings tab asks, and asking IS the refusal (the notice fires on the
  // user's gesture). §4.2b: a flow that will be refused refuses BEFORE it opens — a modal that
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
  // own priority chain (remote pane, C-#14) can slot the local lock in ahead of a remote's label
  // without bypassing it.
  localLockLabel(group: string): string | undefined;
  // The parent GROUP name for a companion group (c-livetest batch5 task 2, spec §1) — null for a
  // non-companion, a custom group, or the legacy enabled-css-snippets switch list (out of scope).
  companionParentOf(group: string): string | null;
  captureItems(items: CaptureItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  applyItems(items: ApplyItem[], onProgress?: ProgressFn): Promise<GroupResult[] | null>;
  reloadApp(): void;
  remotes(): Remote[]; // [] on mobile
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  remoteRefreshProgress(): { total: number; done: number } | null;
  // R9: identifies the reader-cache generation a compare was started against, so a re-render can
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
  // Deleted store paths (display form), or `null` when the action was refused — the same signal
  // the runs use (see setLastRun). `[]` means "it ran and deleted nothing", which is a real
  // outcome the caller records in the run history, so a refusal must not share that value (§4.2b).
  stopSyncing(groupName: string, deleteStore: boolean): Promise<string[] | null>;
  // The Stop-syncing menu's per-device layer (C-#45, spec §1/§3): read = has THIS device opted
  // this group out; write = set/clear THIS device's own opt-out (never another device's).
  deviceOptedOut(groupName: string): boolean;
  setDeviceOptOut(groupName: string, on: boolean): Promise<void>;
  storeFileCount(groupName: string): Promise<number>;
  listLeftoverStoreFiles(): Promise<{ rel: string; name: string; path: string; size: number }[]>;
  deleteLeftoverStoreFiles(rels: string[]): Promise<string[] | null>; // deleted rels, or null when refused (§4.2b)
  appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void>;
  // Bidirectional divergence for a switch-list group (exceptions masked); null when either
  // side is missing or unparseable. `masked` is the augmented exception set itself — the
  // enablement fate derivation (#5-B) needs to tell "off everywhere" from "excluded by a rule".
  switchDivergenceFor(name: string): Promise<{ captureRemoves: string[]; applyDisables: string[]; masked: string[] } | null>;
  // Contents for an inline change diff: base = current state of the target side, produced =
  // what the pending action (capture/apply) would write. null = no diff available.
  diffPair(name: string, rel: string, dir: Direction): Promise<{ base: string; produced: string } | null>;
  // The section header chip's write target (task-4): toggles whether an item (here, the
  // core-plugins/community-plugins carrier) is itself a synced item — same field the Settings
  // tab's per-card sync toggle writes (Item.synced).
  setItemSyncEnabled(ref: ItemRef, enabled: boolean): Promise<void>;
  // The two enablement layers (spec §6.6), one read/write pair each — the SAME pair the Settings
  // panel's card rows call, so the three entrances cannot drift apart.
  // The fleet rule for one element of one list.
  enablementRuleFor(list: RuleListId, elementId: string): Sharing;
  setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void>;
  // This device's own exception for that element: null = follows the rule.
  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null;
  // Take the element out of the shared answer, keeping EXACTLY what it is right now (spec §6.5).
  leaveToThisDevice(list: RuleListId, elementId: string): Promise<void>;
  // Put it back under the shared answer.
  followTheDefault(list: RuleListId, elementId: string): Promise<void>;
  // Flip an existing exception.
  setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void>;
  // The Settings-sync menu: the same field the Settings tab's file-row sharing control edits
  // (Item.settingsFile.fileRule.sharing — this-device is structurally excluded there).
  itemFileSharing(ref: ItemRef): FileSharing;
  // C-#25: whether the item's current mode makes a whole-file fileRule write legal (mirrors
  // manifest.ts's validator via itemCard.ts's fileRuleLegalForMode) — false for a fields-mode
  // item, whose Settings-sync row must not offer a menu setItemFileSharing would then throw on.
  itemFileSharingMenuLegal(ref: ItemRef): boolean;
  // Also the write target for a custom (folder) item's device class since runsOn's retirement
  // (2026-08-12-enablement-two-layers, task 8) — the same field the Advanced tab's "Devices"
  // dropdown writes (SettingTab.commitGroups → persistCustomItems → customItemFromGroup), a
  // folder simply has no other settings-file content to share the write with.
  setItemFileSharing(ref: ItemRef, sharing: FileSharing): Promise<void>;
  // The More bridge (task 7 implements the scroll/expand target): deep-links into the Settings
  // tab for this item's card.
  openSettingsAt(ref: ItemRef): void;
  // The item a compiled group belongs to — a registry LOOKUP, never a parse of the group name
  // (spec §5: the `plugin-` prefix retires as a parser). null for a group no item owns.
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

// remoteLabels (batch6 task-1): group name -> label from the remote store.lock.json, for the
// remote pane to show a real plugin name instead of a raw group id (Task 2's rendering job) —
// empty on an absent/malformed remote lock, never a reason for the compare itself to fail.
type RemoteCompareResult = { entries: RemoteDiffEntry[]; lockDiffers: boolean; remoteLabels: Record<string, string> };

// R9: one compare per (remote name, reader-cache generation) — see renderRemoteDetail.
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

// One derivation per row per render cycle (ledger C-#22, spec §2): rollup, fate input, fate and
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
  // Enablement-carrier divergence (spec 2026-08-06-enablement-single-entry-design.md #5-B),
  // fetched once per reload — only present for a carrier that's itself compiled, so a disabled
  // row's presence here doubles as "this carrier is synced AND its data is readable".
  private carrierDivergence: Map<EnablementList, { captureRemoves: string[]; applyDisables: string[]; masked: string[] }> = new Map();
  // ledger C-#22: per-render-cycle memo for rowBucket/familyRollupFor/familyState/fateWithInput/
  // fateFor — see deriveRow(). Cleared at the top of render()/reload().
  private rowDerivationCache: Map<string, RowDerivation> = new Map();
  // C-#48 (search perf, spec 2026-08-10-c-livetest-batch23-search-perf.md §2/§3): the sidebar
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
  // Fold state for the four unified type sections (task-4).
  private typeSectionOpen: Set<TypeSection> = new Set();
  private selected = sessionStaging.selected;
  private directionOverride = sessionStaging.directionOverride;
  // Conflict resolutions (spec §4/§5, task 6): view-level, not session-level like the maps
  // above — a conflict resolution is a live judgment call on the CURRENT divergence, not
  // something that should survive a mobile tab-switch view recreation the way staged
  // selections do. Resets outright after a successful run (renderActionBar's `run`).
  private conflictChoice: Map<string, ConflictChoice> = new Map();
  private expandedItems: Set<string> = new Set();
  // Remote pane fold state (spec §2, C-#21): survives repaints (periodic check, notify) the way
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
  private leftovers: { rel: string; name: string; path: string; size: number }[] = [];
  private readonly qac = new QualifierAutocomplete(SYNC_QUALIFIER_SPECS);
  private expandedDisclosures = new Set<string>(); // per-group disclosure keys, `${group}::<kind>`
  private ruleSearch = new Map<string, string>(); // per-group per-plugin-rule filter query
  // Regions the sidebar search updates in place, so a keystroke never rebuilds (and refocuses)
  // the search input itself. Set on every full render().
  private mainEl: HTMLElement | null = null;
  private sideSectionEl: HTMLElement | null = null;
  // C-#48 (search perf, spec §3 "instant field, deferred work"): the search input's own value is
  // always native/instant; the heavy re-render (sidebar badges + the whole main pane) is debounced
  // behind this single timer so a fast typist never pays for every intermediate keystroke — only
  // the query it settles on. One timer shared by the sidebar and compact-mainbar search inputs
  // (never both live at once — `renderSidebar`/`renderItemMode`'s compact branch are mutually
  // exclusive per render). Cancelled in onClose so a closed view can't fire a stale render.
  private searchDebounceTimer: number | null = null;
  // R9: the remote pane's compare in flight, if any — see renderRemoteDetail.
  private inflightCompare: InflightCompare | null = null;
  // C-#39 (spec §3, axiom §0.2): measures true per-row/per-line overflow (scrollWidth >
  // clientWidth) once the fate sentence has nothing left to give, rather than a fixed pixel
  // breakpoint — the trigger point depends on each row's own name length and chip count, not
  // the pane width, so a global width guess (a container-query breakpoint shared by every row)
  // would flip rows that don't need it and miss ones that do. Live-verification fix (report
  // fix-round-2, root cause below `onOpen`/`refreshChipOverflow`): observes the stable, always-
  // present `contentEl` for the view's whole lifetime — never per-row, never disconnected — and
  // on a hit, re-walks every currently-rendered chip-bearing element instead of trusting
  // per-target notifications, which per-row `.observe()`/`.disconnect()` churn (full renders,
  // C-#22 in-place fold toggles) was silently dropping.
  private chipOverflowObserver: ResizeObserver | null = null;

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
    // Root cause (report fix-round-2): per-row `.observe()`/`.disconnect()` across full renders
    // and C-#22 in-place fold toggles is too many coordination points for individual-target
    // ResizeObserver registrations to survive — live verification found every row's observation
    // silently dead (no initial fire, no fire on a genuine 360px pane resize) despite correct
    // DOM/CSS and a non-null observer. Mirrors this same file's `ro`/`evaluateCompact` above (a
    // proven pattern already): ONE observer on `contentEl`, alive for the whole view lifetime,
    // re-walking every rendered chip element on each callback instead of trusting per-target
    // delivery.
    this.chipOverflowObserver = new ResizeObserver(() => this.refreshChipOverflow());
    this.chipOverflowObserver.observe(this.contentEl);
    this.register(() => this.chipOverflowObserver?.disconnect());
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
      this.searchDebounceTimer = null; // C-#48 fix-round-2 (nit): match the clear+null idiom used everywhere else
    }
    this.contentEl.empty();
  }

  onResize(): void {
    this.evaluateCompact();
    // Belt-and-suspenders (report fix-round-2): Obsidian's own "the leaf was resized" hook,
    // independent of whether the browser's ResizeObserver on `contentEl` also fires — a second,
    // Obsidian-native trigger for the same re-walk so row-resize re-evaluation doesn't depend on
    // DOM ResizeObserver delivery alone.
    this.refreshChipOverflow();
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
    // ledger C-#22: a reload always means new data — drop the row derivation memo up front so no
    // interaction landing mid-reload (before the closing render() call) can read a bucket/fate
    // computed against the groups/statuses this reload is about to replace. C-#48: the search-text
    // and rows() memos are equally stale once the group list is about to change. (A pending
    // debounced search re-render is handled too — see renderMainRegion()'s own cancel, fix-round-2:
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
        // never-synced rows are deliberately NOT pre-checked (定稿 2026-07-28): in the upgrade
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

  // Install targets the version the store captured (方案 A); latest when unrecorded.
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
  // identity rather than the label (spec §5: the `plugin-` prefix retires as a parser). The host's
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

  // rowRef is asked per row per render (ledger C-#22's discipline), and both halves of it cost
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

  // One representative compiled group per family (spec §1 "one object"): the parent, or an
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

  // A family's companion StatusRows for `parentName` (spec §1): groupOwners' def-level
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

  // A dir-type member's file count for the rollup (spec §2's "companion file changes (summed
  // count N)"): 0 for a file-type member (its own settings payload is a separate verb component
  // — see computeFateInput's hasSettingsPayload) and for a dir member with no diff computed yet.
  private memberFileCount(r: StatusRow): number {
    return r.group.type === "folder" && r.status.changes !== undefined ? this.folderChangeCount(r.status.changes) : 0;
  }

  // The family rollup for a row (itself + its companions) — shared by computeFateInput (fate/
  // direction/conflict), familyState (counts/filters/visibility), stagedRows' companion fan-out,
  // and renderUnifiedFiles' merged Files section. Memoized via deriveRow (ledger C-#22).
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

  // The family's Files section (spec §4): parent changes plus every companion's, each companion's
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

  // The state a row's FAMILY presents as (spec §2). Ledger C-#23: every count/filter/partition/
  // fold consumer now reads `rowBucket` (below) instead — this is left as (1) the pre-task
  // fallback `rowBucket` uses when the row's OWN state is "locked" (see its comment) and (2) the
  // handful of call sites that genuinely need a row's OWN member state (fateWithInput's locked
  // bypass, the default-policy suggestion) go through presState(r) directly, not this rollup.
  private familyState(r: StatusRow): GroupState {
    return this.familyRollupFor(r).state;
  }

  // The single per-row bucket derivation every count/filter/partition/fold consumer reads (ledger
  // C-#23, spec §1): a `↓ Turns on` row can no longer land in the "no settings yet" fold its raw
  // GroupState might suggest — its bucket comes from the SAME fate it renders with. Memoized via
  // deriveRow (ledger C-#22) — see there for the locked-bucket bypass reasoning.
  private rowBucket(r: StatusRow): RowBucket {
    return this.deriveRow(r).bucket;
  }

  // The single derivation pass for a row (ledger C-#22, spec §2): computes the rollup, fate
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
  // the active partition (review fix; config-reachable by any user). `legacyLockedFamilyBucket`
  // reproduces exactly where familyState(r) landed pre-task, from the family's raw state, never
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

  // C-#48 (search perf spec §2/§3): memoized per render cycle (cleared alongside
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
    // section rank, then display name — so e.g. core items never interleave the Obsidian ones
    // (batch 3 ④). Ranking by TYPE_SECTION_ORDER rather than raw ITEM_SECTION_ORDER merges beta into
    // the same rank as community (task-4 review fix): the brief's "alphabetical within" a type
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
    // Beta is a presented classification over a community item (spec §7b), so the id it asks BRAT
    // about comes from the row's ref — never sliced off the name.
    const owner = refItemId(this.rowRef(name));
    if (cat === "community" && owner !== null && this.betaIds.has(owner.id)) return "beta";
    return cat;
  }

  // Rows in the main section (availability "enabled", or app-anchored with no unhandled drift).
  // Sidebar badges, header pills, filter pills, and select-all all bucket over this set only —
  // outdated/disabled/not-installed rows live in their own sections with their own controls.
  private mainRows(): StatusRow[] {
    return this.rows().filter((r) => this.sectionOf(r.group.name) === "main");
  }

  private effDir(r: StatusRow): Direction {
    return effectiveDirection(this.presState(r), this.directionOverride.get(r.group.name));
  }

  // Presentation state: version-ahead in-sync rows surface as to-capture (定稿 feedback-trio).
  private presState(r: StatusRow): GroupState {
    return presentedState(r.status.state, this.availOf(r.group.name).drift);
  }

  // The item ref for a row's compiled group name. A registry LOOKUP through the host, not an
  // inverse parse of the name (spec §5): the registry already knows which def produced which
  // group name, so nothing here has to know that a community item's group carries a `plugin-`
  // prefix. null for a group no item owns (a companion, an enablement carrier), whose rows never
  // reach the Settings-sync menu or the More bridge.
  private itemRefFor(name: string): ItemRef | null {
    return this.host.itemRefForGroup(name);
  }

  // The real FateInput derivation (Task 1's model, fully wired; family-rolled-up c-livetest
  // batch5 task 2): `pres` is the FAMILY's rollup state (parent + companions) — it, not the row's
  // own presState, now drives direction/conflict/nothingYet/stageability, via the same
  // stageableRow/effectiveDirection chains a plain row always used (familyRollup's single-member
  // guarantee makes a companion-less row byte-identical to before). `hasSettingsPayload` (the
  // settings verb) reads the row's own RAW `r.status.state` (C-#37), not the version-ahead-
  // relabeled presState — a raw-in-sync/drift-ahead row genuinely writes no settings file, only
  // `versionAhead` below explains its capture; folderFileCount covers a companion's own file
  // changes separately (spec §2: "parent settings payload changed → settings verb; companion file
  // changes → folder verb joins"). storeListOn/locallyOn/ruleSharing/localException only exist for a
  // carrier-synced plugin row — for every other row (obsidian/folder/self-excluded/
  // carrier-unsynced) they stay at their "no enablement dimension" defaults, which
  // `effectiveTurnsOn`/`buildChips` already treat as a no-op (see fateModel.ts). Called exactly
  // once per row per render cycle, from deriveRow() (ledger C-#22), which already has the rollup
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
    // C-#45 fix-round 2 (root cause of the live kickstart failure — Remotely Save stayed
    // "Installs" in To apply after "On this device"): forcing direction null HERE, not just
    // rowFate's own output, is what makes every OTHER direction-reading consumer agree — the
    // card's On-apply/On-capture header + Files visibility (renderUnifiedCard's `dir`) and
    // stateClauseText's clause branch both read `input.direction` directly, not `fate.glyph`, so
    // patching rowFate alone left them still deriving the row's real, still-derivable direction
    // from the availability ladder/rollup — a not-installed plugin has an "apply" direction
    // independent of this device's opt-out. Mirrors how groupExcludedHere's class exclusion
    // already arrives with direction:null BY CONSTRUCTION (the synthetic in-sync status
    // computeStatuses synthesizes upstream) — opt-out has no such synthetic status (the real
    // comparison genuinely runs, C-#45 spec §4), so it's forced null here instead.
    const rawDirection = stageableRow(pres, this.sectionOf(name)) ? effectiveDirection(pres, this.directionOverride.get(name)) : null;
    const direction = optedOutHere ? null : rawDirection;
    const rollupFiles = direction === "apply" ? rollup.applyFiles : direction === "capture" ? rollup.captureFiles : 0;
    return {
      direction,
      conflict: pres === "differs",
      nothingYet: pres === "no-settings",
      installed: a.kind !== "not-installed",
      hasUpdate: a.anchor === "plugin" && a.drift === "behind",
      // C-#37: driftFor (availability.ts) only ever returns "ahead" once both versions are
      // non-null — mirrored via the && chain below (not a defensive fallback) rather than
      // asserted, since TS can't infer that guarantee from `a.drift` alone.
      versionAhead:
        a.anchor === "plugin" && a.drift === "ahead" && a.localVersion !== null && a.storeVersion !== null
          ? { installed: a.localVersion, stored: a.storeVersion }
          : null,
      carrierSynced,
      storeListOn,
      locallyOn,
      ruleSharing,
      localException,
      deviceClass,
      desktopOnly: a.desktopOnly,
      // C-#24: THIS row's own compiled group (not the family rollup) is scoped away from this
      // device's class by the item's Settings-sync file rule — the same layer desktopOnly reads
      // its fact from (`a`/`r.group`), never the store; groupExcludedHere (panelModel.ts) checks
      // both the group-level devices class AND a Plain file's own fileRule.sharing, since the two
      // can disagree in practice. rowFate only surfaces it when the family presentation is
      // otherwise neutral (direction null) — a directional/conflict member always wins, so a
      // still-syncing companion is never masked.
      excludedHere: groupExcludedHere(r.group, deviceClass),
      // C-#45: THIS row's own group, opted out on THIS device via the Stop-syncing menu — a
      // DIFFERENT fact/cause from excludedHere (a per-device choice, not a class rule) AND a
      // DIFFERENT precedence (unconditional, not direction-null-gated — see `direction` above and
      // rowFate's own fix-round-2 comment); rowFate renders the two identically once either wins
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

  // "locked" (encrypted, no passphrase set) has no representation in spec §3's verb table —
  // content comparison never even ran, so direction/conflict/nothingYet are all meaningless here.
  // Bypasses rowFate for this one state and reuses this codebase's existing approved copy for it
  // (stateIcon's "locked" tip, already shown elsewhere in this view) rather than letting it fall
  // through to a misleading "In sync". Memoized via deriveRow (ledger C-#22).
  private fateWithInput(r: StatusRow): { fate: Fate; input: FateInput } {
    const { fate, input } = this.deriveRow(r);
    return { fate, input };
  }

  private fateFor(r: StatusRow): Fate {
    return this.deriveRow(r).fate;
  }

  // All user-facing counts (header pills, sidebar badges, filter pills, switcher) must agree
  // with what the filters actually show — i.e. count each row's BUCKET (ledger C-#23, spec §1),
  // not its raw family/member state.
  private presentedCounts(rows: StatusRow[]): FateBucketCounts {
    return fateBucketCounts(rows.map((r) => this.rowBucket(r)));
  }

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    // ledger C-#22: a fresh render cycle — any staging state a render-triggering handler just
    // changed (direction override, conflict choice, selection, filter, search…) must be read
    // fresh, not off derivations cached for the PREVIOUS cycle's state. C-#48: the search-text/
    // rows() memos don't depend on that staging state, only on `this.groups` — clearing them here
    // too is cheap insurance (one full render, not one per keystroke) against anything upstream of
    // render() replacing `this.groups` without going through reload()'s own clear. (A pending
    // debounced search re-render is handled too — see renderMainRegion()'s own cancel, fix-round-2:
    // render() always calls renderMainRegion() below, so that single cancel point covers this path
    // already; no separate copy needed here.)
    this.rowDerivationCache.clear();
    this.searchTextCache.clear();
    this.rowsCache = null;
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    this.renderHeader();
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
    this.mainEl = shell.createDiv({ cls: "config-sync-main" });
    this.renderMainRegion();
    this.contentEl.scrollTop = scrollTop;
  }

  // C-#48 (search perf spec §3): coalesces a burst of keystrokes into one trailing re-render —
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
  // input and its autocomplete are never torn down mid-type — which used to blink the dropdown
  // once per keystroke.
  //
  // C-#48 fix-round-2 (review): a pending debounced search re-render (see debounceSearchRender)
  // must never survive past THIS rebuild, no matter which of this method's callers triggered it —
  // fix-round-1 cancelled the timer at the top of render()/reload() instead, but two direct
  // callers (the cold-start banner's "Review settings →"/dismiss handlers, renderItemMode) bypass
  // both: they call renderMainRegion() straight, without going through render()/reload() first. A
  // realistic sequence — type in the compact search box (timer armed) then, within the debounce
  // window, tap the banner (first-run-on-a-phone territory, both visible together) — left the OLD
  // timer to fire ~130ms later into DOM this call already replaced (main.empty() below), running
  // the compact path's stale renderPills/renderSectionsBody/refreshGlobalSelectAll closure against
  // detached elements. Cancelling HERE, at the top of the one method every caller (render(),
  // reload() via render(), the debounce's own trailing call, and both banner handlers) funnels
  // through, is the single choke point — render()/reload() no longer carry their own copy of this
  // (removed, single source of truth: one cancel to keep in sync, not three). Idempotent: by the
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
    // First-layout evaluation (report fix-round-2): `contentEl` is scrollable with its own fixed
    // box, so adding/removing rows never resizes it — the container ResizeObserver alone would
    // never fire for freshly rendered rows. Called directly, deterministically, right after the
    // DOM exists, rather than waiting on a browser-scheduled initial notification.
    this.refreshChipOverflow();
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
        // C-#19: a never-pulled fresh device has no store to adopt from yet — no "Found a
        // configuration" claim, no Adopt, no Capture caution (spec 2026-08-08-c-livetest-batch9 §1).
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
      // Post-adopt nudge (folds in the old guidance banner): the list is set up but items may not
      // be applied to this device yet. Point at Apply (store → device), never Capture.
      const toApply = this.presentedCounts(this.mainRows()).down;
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
      renderDiffPanel(holder, base, produced, leftLabel, rightLabel, bothSorted ? "data.json · sorted view" : "data.json");
    });
  }

  private renderSelfViewChange(block: HTMLElement, dir: Direction): void {
    const open = this.selfDiffOpen.has(dir);
    const link = block.createDiv({ cls: "config-sync-self-viewchange", text: open ? "▾ hide change (data.json)" : "▸ view change (data.json)" });
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
      // C-#48 (search perf spec §3): the heavy part — sidebar hit badges + the whole main pane
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
    container.createDiv({ cls: "config-sync-side-divider" });
    container.createDiv({ cls: "config-sync-side-head", text: "This device ↔ store" });

    const deviceEntry = (cat: StorageSection | "beta" | "all", label: string, rows: StatusRow[]): void => {
      const active = this.panelSection.kind === "device" && this.panelSection.cat === cat;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      if (this.searching()) {
        // Hit counts must span the entry's full scope — every section (outdated/disabled/
        // not-installed included), not just mainRows() — so a match hiding in e.g. "Not
        // installed" still counts here. Bucket badges below stay main-section-only.
        const sectionRows = cat === "all" ? this.rows() : this.rows().filter((r) => this.itemSectionOf(r.group.name) === cat);
        const hits = sectionRows.filter((r) => this.rowMatchesSearch(r)).length;
        item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${hits}` });
      } else {
        const c = this.presentedCounts(rows);
        if (c.up > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
        if (c.down > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
        if (c.ok > 0) item.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
        if (c.excluded > 0) item.createSpan({ cls: "config-sync-side-badge is-excluded", text: `⊘${c.excluded}` }); // C-#45 §7
        if (c.none > 0) item.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
      }
      item.addEventListener("click", () => {
        this.panelSection = { kind: "device", cat };
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    };

    deviceEntry("all", "All items", this.mainRows());
    for (const cat of ITEM_SECTION_ORDER) {
      const inCat = this.mainRows().filter((r) => this.itemSectionOf(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, ITEM_SECTION_LABELS[cat], inCat);
    }

    const remotes = this.host.remotes();
    if (remotes.length > 0) {
      container.createDiv({ cls: "config-sync-side-divider" });
      let newestCheck: number | null = null;
      for (const remote of remotes) {
        const c = this.host.remoteCheck(remote.name);
        if (c !== undefined && (newestCheck === null || c.at > newestCheck)) newestCheck = c.at;
      }
      const head = container.createDiv({ cls: "config-sync-side-head config-sync-side-head-remotes" });
      head.createSpan({ text: `Remotes · checked ${newestCheck === null ? "never" : relativeAge(newestCheck)}` });
      const refresh = new ExtraButtonComponent(head);
      refresh.setIcon("refresh-cw");
      refresh.setTooltip("Re-check remotes");
      refresh.onClick(async () => {
        await this.host.refreshRemoteChecks();
        this.render(this.renderGen);
      });
      refresh.extraSettingsEl.toggleClass("config-sync-refresh-spinning", this.host.remoteRefreshProgress() !== null);
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
      item.createSpan({ cls: "config-sync-side-name", text: "History" });
      if (this.history.length > 0) item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${this.history.length}` });
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
      const c = this.presentedCounts(this.sectionRows().filter((r) => this.sectionOf(r.group.name) === "main"));
      if (c.up > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
      if (c.down > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
      if (c.ok > 0) sw.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.excluded > 0) sw.createSpan({ cls: "config-sync-side-badge is-excluded", text: `⊘${c.excluded}` }); // C-#45 §7
      if (c.none > 0) sw.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
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
    sw.createSpan({ cls: "config-sync-switcher-chev", text: this.switcherOpen ? "▴" : "▾" });
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
    // No title span: the pane header already reads "Sync Center" (mobile polish round 2).
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    this.renderSelfChip(head);
    if (this.selfInfo !== null) head.createSpan({ cls: "config-sync-head-divider" });
    const { up, down, ok, excluded, none } = this.presentedCounts(this.mainRows());
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
    pills.createSpan({
      cls: "config-sync-pill is-ok",
      text: `✓ ${ok}`,
      attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` },
    });
    // C-#45 §7 (fix-round 4): mirrors the ok/none pills' own shape — unconditional-count vs.
    // N=0-suppressed is inconsistent between ok (always shown) and none (suppressed) even today;
    // `excluded` follows `none`'s precedent (suppressed at 0), matching the spec's explicit
    // empty-state rule for the FILTER pill, applied consistently here too.
    if (excluded > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-excluded",
        text: `⊘ ${excluded}`,
        attr: { "aria-label": `${excluded} item${excluded === 1 ? "" : "s"} not synced on this device` },
      });
    }
    if (none > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-none",
        text: `○ ${none}`,
        attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
      });
    }
    head.createSpan({
      cls: "config-sync-center-refreshed",
      text: this.lastRefreshedAt === null ? "" : `refreshed ${relativeAge(this.lastRefreshedAt)}`,
    });
    // Manual refresh (定稿 2026-07-17, replaces the enabled-set polling; made global 定稿
    // 2026-08-04 — #1): re-scans local state, catching plugin toggles made in Obsidian's
    // settings modal while the panel stayed open, and re-checks every remote (desktop only).
    const refresh = new ExtraButtonComponent(head);
    refresh.setIcon("refresh-cw");
    refresh.setTooltip("Refresh");
    refresh.extraSettingsEl.addClass("config-sync-center-refresh");
    refresh.extraSettingsEl.toggleClass("config-sync-refresh-spinning", this.host.remoteRefreshProgress() !== null);
    refresh.onClick(async () => {
      await this.host.refreshRemoteChecks(); // desktop: re-checks every remote (and reloads via notify)
      await this.reload();                   // mobile no-ops the above; ensure local still refreshes
    });
  }

  // The run's report is recorded to history and surfaced in the inline strip; the strip
  // expands by default when the outcome isn't clean (定稿 2026-07-18 — no more silent-looking
  // green success hiding failures behind "details").
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
    // Severity split (spec 2026-08-09-c-livetest-batch16 §2, C-#35): only a genuine failure
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
    const toggle = meta.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
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
    // Split the old out/in glyph into per-action icons so history matches the panel's
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
  // map are the two halves of one vocabulary, and every defect on this branch has been one half of
  // a relationship moving without the other.
  private syncResolvers(): Record<SyncQualifierKey, QualifierResolver<StatusRow>> {
    return {
      type: (r) => syncTypeValue(r.group),
      section: (r) => this.itemSectionOf(r.group.name),
      action: (r) => syncActionValue(this.rowBucket(r)),
      mode: (r) => syncModeValue(r.group),
      device: (r) => r.group.devices,
    };
  }

  // A family row matches search on the parent's own name/label OR any companion's (spec §1's
  // dissolved companions must stay findable by their own name even though they no longer render
  // their own row).
  //
  // C-#48 (search perf spec §2/§3): memoized per render cycle, keyed by group name (cleared
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
    // §4.1 refusal, in the cold-start banner's own structure with no primary action: there is
    // nothing to click here, and no dismiss either — this is a standing condition the user can
    // only clear by updating Config Sync, not a nudge to be waved away. It takes the banner slot
    // outright: while it holds, "this device hasn't synced yet" is not the story to tell.
    // The wording is §4.1's final copy — the same sentence `SCHEMA_FUTURE_NOTICE`
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
    const inSection = this.sectionRows();
    // The two on/off list carriers dissolve into their section's header chip (task-4) — never a
    // row of their own — so every row-driven count (pills, select-all) excludes them up front.
    const pillPool = inSection.filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name));
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
    // set (定稿): the All pill keeps the unfiltered total as "n / m".
    const renderPills = (): void => {
      pillRow.empty();
      const pillRows = this.searching()
        ? pillPool.filter((r) => this.rowMatchesSearch(r))
        : pillPool;
      const counts = this.presentedCounts(pillRows);
      // Mobile shows the short glyph form (定稿 B) — the panel's icon language (↑ ↓ ✓ ○) —
      // so all five pills always fit one line; desktop keeps the full labels. C-#50 follow-up: the
      // ok/excluded/none short forms render the same fixed-size Lucide icon the fold lines use
      // (foldIcons.ts) instead of a text glyph — this was the one place the three glyphs sat side
      // by side, so the pre-task optical mismatch survived here after the fold lines themselves
      // were fixed.
      const allLabel = this.searching() ? `All ${pillRows.length} / ${pillPool.length}` : `All ${pillPool.length}`;
      const defs: { key: PanelFilter; label: string; short: string; action?: SyncAction; foldKind?: FoldKind; count?: number }[] = [
        { key: "all", label: allLabel, short: allLabel },
        { key: "capture", label: `To capture ${counts.up}`, short: "", action: "capture", count: counts.up },
        { key: "apply", label: `To apply ${counts.down}`, short: "", action: "apply", count: counts.down },
        { key: "ok", label: `In sync ${counts.ok}`, short: "", foldKind: "insync", count: counts.ok },
        // C-#45 §7 (fix-round 4, mockup option A): "Not synced here" — deliberately not "Skipped"
        // (that word is already run-event vocabulary, `⚠ update skipped` ConfigSyncCore.ts, and
        // this is a standing state, not a run outcome). Empty state: N=0 renders neither this pill
        // nor the matching fold (spec's explicit rule, matching ✓/○'s fold-suppression precedent).
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
          // discoverable (spec'd auto-expand-on-activation, not a per-render override).
          if (d.key !== this.filter && d.key !== "all") this.expandAllTypeSections();
          this.filter = d.key;
          this.render(this.renderGen);
        });
      }
      // The "leftover" store-orphans pill has no place in this row (task-4/8): those files have no
      // registry item, so they can't become a row in any type section. `renderLeftoverSection`
      // stays reachable unconditionally instead (below), so the orphans it manages never go dark.
    };

    // One flat row list per type section (task-4 skeleton) — replaces the old main list +
    // separate outdated/disabled/not-installed/desktop-only sections. Row rendering itself is
    // unchanged (Task 5 restyles it); this only decides which section a row lands in.
    const renderSectionsBody = (): void => {
      sectionsHost.empty();
      for (const ts of TYPE_SECTION_ORDER) this.renderTypeSection(sectionsHost, ts, inSection);
      // Store orphans (task-8 dissolution): unrelated to any type section — they have no
      // registry item to compile a row for — so this renders unconditionally rather than through
      // the (now-gone) "leftover" filter pill, only settling into the unfiltered/non-search view
      // so it doesn't clutter a focused "To apply"/search pass.
      if (this.leftovers.length > 0 && this.filter === "all" && !this.searching()) this.renderLeftoverSection(sectionsHost);
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
        // C-#48 (search perf spec §3): same trailing debounce as the desktop sidebar search — this
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

  // Ledger C-#1 review fix: entering a filtered/search view auto-expands every section ONCE, on
  // the filter/search state TRANSITION (called from the pill-click/search-input handlers below,
  // never from render itself) — so a filtered hit is discoverable without the section header
  // click losing its effect for the rest of that filtered/search session.
  private expandAllTypeSections(): void {
    for (const ts of TYPE_SECTION_ORDER) this.typeSectionOpen.add(ts);
  }

  // One of the four fixed type sections (spec §2): a fold containing every row whose section maps
  // here via typeSectionForRow, alphabetical within (rows() already sorts by section then name).
  // The self item is pinned first in Community, outside the row/Fate machinery entirely.
  private renderTypeSection(host: HTMLElement, ts: TypeSection, inSection: StatusRow[]): void {
    const rows = inSection.filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name) && typeSectionForRow(this.itemSectionOf(r.group.name)) === ts);
    const matches = this.searching() ? rows.filter((r) => this.rowMatchesSearch(r)) : rows;
    const visible = matches.filter((r) => visibleUnderFilter(this.rowBucket(r), this.filter));
    const showSelf = ts === "community" && this.selfInfo !== null && this.filter === "all" && !this.searching();
    if (visible.length === 0 && !showSelf) return; // sections with nothing to show hide entirely
    const filtered = this.filter !== "all" || this.searching();
    // Ledger C-#1 review fix: `open` reads ONLY typeSectionOpen — a filter/search no longer forces
    // every section open on every render (that made the header click's toggle invisible the
    // moment any filter pill or search was active, reproducing the "decorative triangle" report).
    // Filtered hits stay discoverable instead via expandAllTypeSections(), called once on the
    // filter/search TRANSITION (see the pill/search-input handlers below), not on every render —
    // so a manual collapse inside an already-filtered view sticks.
    const open = this.typeSectionOpen.has(ts);
    const fold = host.createDiv({ cls: `config-sync-section is-typesection is-${ts}${open ? " is-open" : ""}` });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    const chevron = head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "config-sync-section-title", text: TYPE_SECTION_TITLES[ts] });
    // C-#41 (spec §2): the count fact is the same on every platform, just compacted — "6 of 31"
    // becomes "6/31" on mobile (mobileSectionCountLabel is a no-op string otherwise).
    head.createSpan({
      cls: "config-sync-pill is-neutral",
      text: Platform.isMobile
        ? mobileSectionCountLabel(rows.length, visible.length, filtered)
        : sectionCountLabel(rows.length, visible.length, filtered),
    });
    // Core/Community's carrier chip: inline in the head on every platform (batch-21 spec §2,
    // revising batch-20's mobile second-line drop) — desktop keeps the full-text pill,
    // renderCarrierChip itself switches to an icon-only form on mobile so the head still fits
    // on one line without a dedicated meta line.
    const carrierId: EnablementList | null = ts === "core" ? "core-plugins" : ts === "community" ? "community-plugins" : null;
    if (carrierId !== null) this.renderCarrierChip(head, carrierId);
    const checkable = visible.filter((r) => this.fateFor(r).stageable);
    const staged = checkable.filter((r) => this.selected.has(r.group.name)).length;
    // The checked/indeterminate select-all checkbox plus the global footer already carry this
    // fact on mobile, where head space is scarce (spec §2) — desktop keeps the hint.
    if (staged > 0 && !Platform.isMobile) head.createSpan({ cls: "config-sync-section-hint", text: `${staged} selected` });
    // C-#27: nothing to stage in this section (e.g. pre-adopt Community, only the self row) means
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
    // Ledger C-#22: collapse/expand flips the DOM in place — `is-open` class, chevron glyph, and
    // the card itself (built just-in-time / torn down on close) — never a full this.render().
    // Mirrors the C-#9 row-expand precedent (fateEl.hidden flip, no render). `visible`/`showSelf`
    // are frozen from this render cycle, which is correct: only the fold's own open/closed state
    // changes here, never the underlying data.
    let card: HTMLElement | null = open ? this.buildTypeSectionCard(fold, ts, visible, showSelf) : null;
    head.addEventListener("click", () => {
      if (this.typeSectionOpen.has(ts)) {
        this.typeSectionOpen.delete(ts);
        fold.removeClass("is-open");
        chevron.setText("▸");
        card?.remove();
        card = null;
      } else {
        this.typeSectionOpen.add(ts);
        fold.addClass("is-open");
        chevron.setText("▾");
        card = this.buildTypeSectionCard(fold, ts, visible, showSelf);
      }
    });
  }

  // A type section's body (spec §2): extracted from renderTypeSection (ledger C-#22) so the
  // section-head toggle can build/remove just this one section's body in place instead of a full
  // render(). Returns a `display: contents` wrapper (same idiom as .config-sync-item-wrap) so the
  // whole body — the active-rows card plus every fold line and its own opened card — collapses
  // and removes as one unit, while its children still sit directly on the section's own ground
  // (spec §3: fold lines are never nested inside the filled card).
  private buildTypeSectionCard(fold: HTMLElement, ts: TypeSection, visible: StatusRow[], showSelf: boolean): HTMLElement {
    const body = fold.createDiv({ cls: "config-sync-section-body" });
    if (this.filter === "all" && !this.searching()) {
      // ✓ / ⊘ / ○ rows fold into their own trailing line, same shape as the old flat list (#10) —
      // now aggregated per section instead of once for the whole pane. Ledger C-#23 (spec §1;
      // C-#45 §7 adds excluded, fix-round 4): partitioned by BUCKET, not raw state — active =
      // conflict|apply|capture (plus locked, its current placement, preserved); the folds hold
      // ok/excluded/none. Fold order ✓ → ⊘ → ○ (spec §7: "from nothing-to-do, to my own rule, to
      // no data yet") — rows within each fold stay name-sorted since `visible` already is.
      const bucketed = visible.map((r) => ({ r, section: partitionSection(this.rowBucket(r)) }));
      const active = bucketed.filter((x) => x.section === "active").map((x) => x.r);
      const insync = bucketed.filter((x) => x.section === "insync").map((x) => x.r);
      const excluded = bucketed.filter((x) => x.section === "excluded").map((x) => x.r);
      const nosettings = bucketed.filter((x) => x.section === "nosettings").map((x) => x.r);
      // C-#50 (spec §3): the filled card wraps rows only — it renders exactly when the section
      // has real rows (the self row or an active row); a section whose visible content is fold
      // lines alone shows head + fold lines with no filled block (mockup §3).
      if (showSelf || active.length > 0) {
        const card = body.createDiv({ cls: "config-sync-card" });
        if (showSelf) this.renderSelfRow(card);
        for (const r of active) this.renderItemRow(card, r);
        this.markLastRow(card);
      }
      this.renderSectionTrailingLine(body, ts, insync, sessionUi.insyncOpen, "insync", insyncLineText);
      this.renderSectionTrailingLine(body, ts, excluded, sessionUi.excludedOpen, "excluded", excludedLineText);
      this.renderSectionTrailingLine(body, ts, nosettings, sessionUi.nosettingsOpen, "nosettings", nosettingsLineText);
    } else {
      // showSelf is only ever true alongside filter === "all" && !searching() (renderTypeSection's
      // own gate) — i.e. always the branch above — so this path never needs the self row.
      const card = body.createDiv({ cls: "config-sync-card" });
      for (const r of visible) this.renderItemRow(card, r);
      this.markLastRow(card);
    }
    // First-layout evaluation for the fold-open path (report fix-round-2): opening a section is
    // DOM-only (ledger C-#22, no full render), so the rows built just now need their own explicit
    // pass — `contentEl`'s resize observer only fires on an actual pane resize, not on new rows
    // appearing inside its existing box.
    this.refreshChipOverflow();
    return body;
  }

  // Per-section variant of the old renderTrailingLine — keyed by section too, so expanding the
  // ✓ fold in one section doesn't also expand it in another. Ledger C-#22: toggling the fold
  // flips the line and builds/removes just its own rows in place — never a full this.render().
  // C-#50 (spec §2/§3): the line composes the SAME leading `.config-sync-row-chevron` the list
  // rows use, plus a fixed-size Lucide fold icon (foldIcons.ts), around `text`'s now-plain-text
  // label — no glyph prefix, no trailing triangle baked into the string. An opened fold's rows get
  // their OWN filled card, inserted right after the line (never the active-rows card) — the
  // invariant "filled block = rows" holds for every fold, in every state (mockup §4).
  private renderSectionTrailingLine(
    parent: HTMLElement,
    ts: TypeSection,
    rows: StatusRow[],
    openSet: Set<string>,
    kind: FoldKind,
    text: (n: number) => string
  ): void {
    if (rows.length === 0) return;
    const key = `${this.sectionKey()}::${ts}`;
    let open = openSet.has(key);
    const line = parent.createDiv({ cls: "config-sync-unchanged" });
    const chevron = line.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    renderFoldIcon(line, kind);
    const label = line.createSpan({ cls: "config-sync-fold-label", text: text(rows.length) });
    let foldCard: HTMLElement | null = open ? this.buildFoldCard(parent, line, rows) : null;
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      open = !open;
      chevron.setText(open ? "▾" : "▸");
      label.setText(text(rows.length));
      if (open) {
        openSet.add(key);
        foldCard = this.buildFoldCard(parent, line, rows);
        // First-layout evaluation (report fix-round-2): same reasoning as buildTypeSectionCard's
        // own call — new rows appearing in place need an explicit pass, not a wait on a
        // container resize that isn't coming.
        this.refreshChipOverflow();
      } else {
        openSet.delete(key);
        foldCard?.remove();
        foldCard = null;
      }
    });
  }

  // Builds an open trailing fold's OWN filled card (spec §3, mockup §4), inserted directly after
  // `line`. Unlike the pre-task shared-card version, `renderItemRow` writes straight into this
  // fresh, empty card — no anchor-shuffling needed, since nothing else ever shares it.
  private buildFoldCard(parent: HTMLElement, line: HTMLElement, rows: StatusRow[]): HTMLElement {
    const card = parent.createDiv({ cls: "config-sync-card" });
    line.after(card);
    for (const r of rows) this.renderItemRow(card, r);
    this.markLastRow(card);
    return card;
  }

  // Config Sync's own row (spec §2): pinned first in Community, outside the checkbox/Fate
  // machinery — it isn't staged through the normal apply/capture run (its own Adopt/Capture
  // buttons in the expanded content do that). Expand reuses the existing self-pane content.
  private renderSelfRow(card: HTMLElement): void {
    if (this.selfInfo === null) return;
    const expanded = this.expandedItems.has(SELF_GROUP_NAME);
    const row = card.createDiv({ cls: "config-sync-hub-row is-self" });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: expanded ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: "Config Sync" });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    row.createSpan({ cls: "config-sync-self-fate", text: "your Sync Center — manages itself" });
    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !expanded;
    this.renderConfigSyncMode(detail);
    row.addEventListener("click", () => {
      if (this.expandedItems.has(SELF_GROUP_NAME)) this.expandedItems.delete(SELF_GROUP_NAME);
      else this.expandedItems.add(SELF_GROUP_NAME);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
    });
  }

  // The Core/Community section header chip (spec §2): toggles whether the on/off list itself is a
  // synced item — the only remaining home of that on/off card as a configurable item. Writes the
  // same field the Settings tab's per-card sync toggle does (SyncCenterHost.setItemSyncEnabled).
  // Batch-21 (spec §2, option A): desktop keeps the full-text pill, byte-identical to before —
  // the mobile branch below is additive only. Mobile swaps the text for a bare Lucide toggle
  // glyph (`toggle-right` synced/green, `toggle-left` not-synced/muted) so the section head stays
  // one line; the click/keydown → Menu wiring and the full copy (now carried as tooltip +
  // aria-label rather than inline text) are otherwise identical to the desktop chip.
  private renderCarrierChip(head: HTMLElement, carrierId: EnablementList): void {
    const synced = this.groups.some((g) => g.name === carrierId);
    const tooltip = synced ? "on/off synced ✓" : "on/off not synced";
    const chip = Platform.isMobile
      ? head.createSpan({ cls: `config-sync-carrierchip is-icon${synced ? " is-synced" : ""}`, attr: { role: "button", tabindex: "0" } })
      : head.createSpan({
          cls: `config-sync-carrierchip${synced ? " is-synced" : ""}`,
          text: tooltip,
          attr: { role: "button", tabindex: "0" },
        });
    if (Platform.isMobile) {
      setIcon(chip, synced ? "toggle-right" : "toggle-left");
      setTooltip(chip, tooltip);
      chip.setAttr("aria-label", tooltip);
    }
    const openMenu = (x: number, y: number): void => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle(synced ? "Stop syncing on/off" : "Sync on/off").onClick(() => {
          // The carrier is a compiled group, not an item of its own — it exists exactly when some
          // item in its section is synced (registry.ts's anyEnabledInList), so there is no
          // Item.synced to flip here and itemRefForGroup answers null. Same outcome as the v2
          // write this replaces, which stored an entry no def claimed and nothing ever compiled.
          const ref = this.host.itemRefForGroup(carrierId);
          if (ref === null) return;
          void this.host.setItemSyncEnabled(ref, !synced).then(() => this.notifyExternalChange());
        })
      );
      menu.showAtPosition({ x, y });
    };
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    });
    chip.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      const rect = chip.getBoundingClientRect();
      openMenu(rect.left, rect.bottom);
    });
  }

  private visibleRows(inSection: StatusRow[]): StatusRow[] {
    return inSection.filter((r) => visibleUnderFilter(this.rowBucket(r), this.filter) && this.rowMatchesSearch(r));
  }

  // Tri-state select-all over the currently visible checkable rows (section + filter + search).
  // Fate.stageable (task-4) drives the skip — carrier rows are excluded outright since they no
  // longer render as list rows (task-4 dissolves them into the section header chip).
  private checkableRows(inSection: StatusRow[]): string[] {
    return this.visibleRows(inSection)
      .filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name) && this.fateFor(r).stageable)
      .map((r) => r.group.name);
  }

  private refreshGlobalSelectAll(box: HTMLInputElement, inSection: StatusRow[]): void {
    const checkable = this.checkableRows(inSection);
    const selectedCount = checkable.filter((n) => this.selected.has(n)).length;
    box.indeterminate = false;
    // Idle renders nothing (0.27.5): a disabled ghost box reads as a broken checkbox.
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

  // C-#40 (spec §1): every fate chip renders icon + text, single source FATE_CHIP_ICON
  // (fateChipIcons.ts) — the C-#38 `encrypted` special case generalized to all chips. An
  // unmapped string (should never happen — chips are presentation) renders text-only. The
  // tooltip carries the chip's full text so the icon-only degraded form (axiom §0.2, chip
  // overflow) never loses the fact, only its inline spelling.
  private renderFateChip(parent: HTMLElement, chip: string): HTMLSpanElement {
    const chipEl = parent.createSpan({ cls: "config-sync-fatechip" });
    const icon = FATE_CHIP_ICON[chip];
    if (icon !== undefined) setIcon(chipEl.createSpan({ cls: "config-sync-fatechip-ic" }), icon);
    chipEl.createSpan({ cls: "config-sync-fatechip-label", text: chip });
    setTooltip(chipEl, chip);
    return chipEl;
  }

  // C-#39 (spec §3, axiom §0.2): `container`'s chip GROUP degrades to icon-only as a whole once
  // it truly overflows — measured, not guessed (see chipOverflowObserver's field comment).
  // Re-measures from the full form every time (never trusts the previous verdict) so a row that
  // gained room back on a resize recovers full text instead of sticking compact.
  //
  // Live-verification fix (report fix-round-3): a chipless row (nothing to compact) was flapping
  // `.config-sync-chips-compact` on at a wide pane with scrollWidth 1017 vs clientWidth 1013 —
  // subpixel/integer rounding of `scrollWidth` produces phantom ≤4px deltas on a flex row that
  // genuinely fits, unrelated to any chip. Genuine chip overflow is at minimum a whole chip's
  // width (tens of px, not single digits) — the coordinator's own narrow-pane repro was 298 vs
  // 206, a 92px gap. `CHIP_OVERFLOW_EPSILON` names that noise floor explicitly: this is
  // threshold-tuning against a documented, observed rounding artifact, not masking a real
  // overflow case. Rows/meta lines with no chip at all are skipped outright — nothing to
  // compact, so no class churn (and no chance of this same rounding noise mis-firing on them).
  private syncChipOverflow(container: HTMLElement): void {
    if (container.querySelector(".config-sync-fatechip") === null) return;
    container.removeClass("config-sync-chips-compact");
    container.toggleClass("config-sync-chips-compact", container.scrollWidth > container.clientWidth + CHIP_OVERFLOW_EPSILON);
  }

  // Root cause (report fix-round-2, live verification): per-row `.observe()`/`.disconnect()`
  // registrations were going dead across this view's many render/re-render paths (full render,
  // C-#22 in-place section-fold and trailing-fold toggles) with no reliable single point that
  // both re-observes every surviving row AND never wipes a registration nothing then restores —
  // proven live: zero rows compacted on a genuinely overflowing narrow pane, and a manually-
  // compacted row didn't even re-expand on a 360px widen, so the browser was never delivering
  // ANY notification for these targets by the time of the probe. Replaced with the same pattern
  // `ro`/`evaluateCompact` above already uses successfully: one persistent container observer,
  // re-walk-and-remeasure on every hit — no per-target bookkeeping left to go stale. Called
  // directly (not just from the observer) everywhere new rows can appear, since `contentEl` is a
  // scrollable, fixed-box container whose own size doesn't change just because rows were added.
  private refreshChipOverflow(): void {
    const rows = this.contentEl.querySelectorAll<HTMLElement>(".config-sync-hub-row, .config-sync-row-chipmeta");
    for (const el of Array.from(rows)) this.syncChipOverflow(el);
  }

  // C-#41 mobile chip-meta trailing hairline (review fix): `card`'s children interleave
  // row/meta divs with each row's own `detail` drawer div — a `detail` always immediately
  // follows its row/meta, so no row-shaped selector is EVER literally `:last-of-type` div (the
  // exact C-#5 footgun, styles.css comment near `config-sync-card-fields`). Rather than another
  // tag-dependent selector, this marks the true last row/meta explicitly with a class every time
  // the set of rendered rows could have changed (initial card build, a trailing fold's
  // open/close) — mobile-only (desktop keeps its own pre-existing, untouched border rule) and
  // cheap (one query, only called on those few mutation points, never per-row).
  private markLastRow(card: HTMLElement): void {
    if (!Platform.isMobile) return;
    const prev = card.querySelector<HTMLElement>(".config-sync-row-last");
    prev?.removeClass("config-sync-row-last");
    const rows = card.querySelectorAll<HTMLElement>(".config-sync-hub-row, .config-sync-row-chipmeta");
    rows.item(rows.length - 1)?.addClass("config-sync-row-last");
  }

  // The unified row (spec §3): `[checkbox] Name [chips…] <fate sentence> ▸`. One object, one row
  // — the old policy/fate pills, mode badges' state coupling, and per-section stageability
  // reasoning all collapse into `fate.chips`/`fate.sentence`/`fate.stageable`.
  private renderItemRow(card: HTMLElement, r: StatusRow): void {
    const { group } = r;
    const { fate: rawFate, input } = this.fateWithInput(r);
    const isConflict = rawFate.glyph === "⚠";
    const unresolvedConflict = isConflict && !this.conflictChoice.has(group.name);
    const fate = this.displayFate(rawFate, input, group.name);
    const inert = !fate.stageable;
    const expanded = this.expandedItems.has(group.name);
    const row = card.createDiv({
      cls: `config-sync-hub-row${inert ? " is-insync" : ""}${unresolvedConflict ? " is-conflict" : ""}`,
      attr: { "aria-label": this.host.resolvedPath(group) },
    });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: expanded ? "▾" : "▸" });
    this.renderRuleName(row, group.name, group.label);
    // C-#43/#44 (batch-21 spec §1, revising batch-20's ≥2 threshold): ANY chip-bearing row (1+
    // chips) pushes its chips to their own indented meta line under the row (built below, after
    // the row's own children) — the constant mobile row skeleton is always chevron + name +
    // spacer + sentence + checkbox on line 1, chips (if any) on line 2, never mixed. Chipless
    // rows render nothing here and stay single-line. Desktop always takes the inline branch below
    // — Platform.isMobile is false — so the row's DOM here is untouched by the mobile work.
    const mobileMetaChips = Platform.isMobile && fate.chips.length >= 1;
    if (!mobileMetaChips) for (const chip of fate.chips) this.renderFateChip(row, chip);
    row.createDiv({ cls: "config-sync-rule-spacer" });
    // Ledger C-#9: the fate sentence/glyph repeats the card's own "On apply"/"On capture" clause
    // once expanded, so it hides while the drawer is open (checkbox and chips stay); the click
    // handler below flips `hidden` alongside the chevron/drawer so it tracks expand/collapse
    // without a full re-render. C-#39 (spec §3): glyph and sentence are separate flex children of
    // this wrap — the glyph stays `flex: none` (always visible in full); only the sentence span
    // shrinks/ellipsizes, so the fate sentence is the sole sacrificial element (axiom §0.3).
    const fateWrap = row.createSpan({ cls: "config-sync-fate-wrap" });
    fateWrap.hidden = expanded;
    fateWrap.createSpan({ cls: "config-sync-fate-glyph", text: fate.glyph });
    fateWrap.createSpan({ cls: "config-sync-fate-text", text: ` ${fate.sentence}` });

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
    }

    // C-#43/#44 (batch-21 spec §1, mobile only): the indented second line the 1+-chip branch above
    // deferred to — a sibling of `row`, landing right after it and before the drawer so it reads as the row's
    // own line 2. Never a third line (axiom §0.2/§3): the whole group degrades to icon-only +
    // tooltip together, same mechanism as the desktop narrow-pane case below. Overflow evaluation
    // is NOT registered per-row here (report fix-round-2) — `refreshChipOverflow` walks every
    // `.config-sync-hub-row`/`.config-sync-row-chipmeta` in `contentEl` from its own choke points
    // instead, so this row/meta just needs to exist in the DOM by the time that runs.
    // Hoisted (not block-scoped) so the row's click handler below can re-measure it too — see
    // that handler's comment.
    const meta: HTMLElement | null = mobileMetaChips ? card.createDiv({ cls: "config-sync-row-chipmeta" }) : null;
    if (meta !== null) for (const chip of fate.chips) this.renderFateChip(meta, chip);

    const detail = card.createDiv({ cls: "config-sync-report-files config-sync-itemcard" });
    detail.hidden = !expanded;
    this.renderUnifiedCard(detail, r, fate, input, isConflict);
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
      fateWrap.hidden = !detail.hidden;
      // Review fix: hiding/showing fateWrap changes how much of the row's own width its OTHER
      // content (chips inline in the row, on desktop or a mobile 0–1-chip row) has to share — a
      // row measured while expanded (fateWrap hidden, less content) can genuinely overflow again
      // once it collapses back, with nothing else due to re-measure it until an unrelated resize/
      // render. Re-check right here, on the live row, same idiom refreshChipOverflow uses. The
      // chipmeta line (mobile 2+ chips) sits on its own line below and isn't affected by fateWrap,
      // but it's re-measured too for the same "never trust a stale verdict" reason the rest of
      // this mechanism already follows.
      this.syncChipOverflow(row);
      if (meta !== null) this.syncChipOverflow(meta);
    });
  }

  // Presentation-only wrapper around the shared `effectiveFate` derivation (panelModel.ts, task
  // 6 round 2 fix): once Resolve picks a side, the row reads exactly like a normal directed row
  // — a real sentence/chips computed as if the conflict were simply that direction (never the
  // frozen "⚠ Changed on both sides"), plus the `your choice` chip. `fallbackTurnsOn` is
  // deliberately NOT passed here (`false`) — the fate SENTENCE must stay free of enablement
  // verbs for the carrier-unsynced fallback ladders (spec §3); `stagedRows()`/`footerSelection()`
  // call the same `effectiveFate` WITH that bridge for the actual staging/counting truth, so the
  // sentence and the run can only differ in that one spec-mandated place, never accidentally.
  private displayFate(fate: Fate, input: FateInput, name: string): Fate {
    const choice = this.conflictChoice.get(name) ?? null;
    const resolved = effectiveFate(fate, input, choice, false);
    if (fate.glyph !== "⚠" || choice === null) return resolved;
    return { ...resolved, chips: [...resolved.chips, "your choice"], stageable: true };
  }

  // The expanded card (spec §4): standardized rows in order, each omitted when N/A. `fate` is
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
    // Own wrapper for the field rows (ledger C-#5 root cause): `.config-sync-card-fieldrow`'s
    // `:last-of-type` border-removal matches by TAG, not class — with the Stop-syncing footer
    // appended as a further `<div>` sibling of the rows in `detail`, the true last row stopped
    // qualifying as last-of-type and kept its `border-bottom`, stacking with the footer's own
    // `border-top` into an empty hairline-bounded band. Rows live in their own `fields` div so
    // `:last-of-type` only ever sees other field rows, and the footer sits outside it entirely.
    const fields = detail.createDiv({ cls: "config-sync-card-fields" });
    const dir = isConflict ? this.conflictChoice.get(name) ?? null : input.direction;
    this.renderCardKeyRow(fields, dir === "apply" ? "On apply" : dir === "capture" ? "On capture" : "State", (value) => {
      value.createDiv({ cls: "config-sync-expand-note", text: this.stateClauseText(r, fate, input) });
    });

    const changes = this.familyChanges(r);
    if (dir !== null && hasChanges(changes)) {
      this.renderCardKeyRow(fields, "Files", (value) => this.renderUnifiedFiles(value, r, changes, dir, input.encrypted));
    }

    if (isConflict) this.renderResolveRow(fields, r);

    // Runs on is one of the two "always available" rule menus (spec §1/§4 — no stageable
    // qualifier, unlike After install's explicit "only ¬carrierSynced ∧ ¬installed"): a
    // carrier-synced plugin needs it reachable from its steady in-sync state too, so an
    // exception can be set BEFORE the row ever diverges. After install keeps the stageable
    // guard — harmless there since an installable row is already stageable via
    // stageableRow's non-main-section carve-out. Enablement (review fix #3, task 6 round 2) is
    // the third and last leaf of this same ladder: an installed-but-disabled row whose carrier
    // ISN'T synced has no `Runs on` (nothing to route through) and no `After install` (already
    // installed) — without it there is no enable path in the unified grammar at all, a real
    // regression from pre-C's `disabledRowAction` default. Ungated by `fate.stageable`, matching
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

  // One row inside the expanded card (spec §4, ledger C-#2): a fixed-width muted label with its
  // value immediately adjacent, shared by every card row (On apply/Files/Runs on/Settings
  // sync/More/Note/Resolve) — never a label on its own line with the value spread underneath.
  // Built off-DOM first (ledger C-#5): if `build` leaves the value empty, the row is dropped
  // entirely — no separator, no height — rather than appended and pruned; Task 2's rule-control
  // triggers render through this same helper, so an N/A control must vanish the same way.
  private renderCardKeyRow(detail: HTMLElement, label: string, build: (value: HTMLElement) => void): void {
    const row = createDiv({ cls: "config-sync-card-fieldrow config-sync-cardrow" });
    row.createSpan({ cls: "config-sync-explabel config-sync-explabel-inline", text: label });
    const value = row.createDiv({ cls: "config-sync-cardval" });
    build(value);
    if (value.childNodes.length === 0) return;
    detail.appendChild(row);
  }

  // Resolve (spec §4, conflict rows only): segmented `Use theirs ↓` / `Keep mine ↑`. Clicking
  // the already-active choice clears it (the same "click the active segment to unstage" idiom
  // `renderDirectionToggle` already uses elsewhere) — Resolve doubles as this row's only
  // staging affordance, since its checkbox stays hidden (`Fate.stageable` false) until chosen.
  private renderResolveRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    this.renderCardKeyRow(detail, "Resolve", (value) => {
      const segrow = value.createDiv({ cls: "config-sync-segrow" });
      const seg = segrow.createDiv({ cls: "config-sync-seg" });
      const current = this.conflictChoice.get(name);
      const opt = (choice: ConflictChoice, label: string): void => {
        const on = current === choice;
        const b = seg.createEl("button", { cls: `config-sync-seg-btn is-${choice}${on ? " is-on" : ""}`, text: label });
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          if (on) {
            this.conflictChoice.delete(name);
            this.selected.delete(name);
          } else {
            this.conflictChoice.set(name, choice);
            this.selected.add(name);
          }
          this.render(this.renderGen);
        });
      };
      opt("apply", "Use theirs ↓");
      opt("capture", "Keep mine ↑");
    });
  }

  // The `On apply`/`On capture`/`State` row's text: the fate sentence, expanded with the
  // specifics spec §4 calls out verbatim (install source, update versions, capture consequence).
  private stateClauseText(r: StatusRow, fate: Fate, input: FateInput): string {
    if (fate.glyph === "⚠") return "Changed on both sides.";
    // C-#28/29: the nothing-yet presentation (direct or degraded from an empty-verb direction —
    // fateModel.ts's rowFate) speaks in cause voice, not just its terse row sentence + period.
    if (fate.sentence === NOTHING_YET_SENTENCE) return "No saved settings anywhere yet — neither this device nor the store has any.";
    if (input.direction === null) {
      // C-#24/C-#45: the card's STATE clause spells out WHY, not just the row's terse sentence —
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
      // C-#37: version-ahead branches off the fact (input.versionAhead), never the new joined
      // sentence strings — every other capture row falls through to the existing two clauses
      // untouched.
      if (input.versionAhead !== null) text = versionAheadClause(input, input.versionAhead);
      else if (text === "Captures settings") text = "Shares your settings with your other devices";
      else if (text === "Turned on here — shares it") text = "Turned on here — your other devices will turn it on the next time they apply";
    }
    return `${text}.`;
  }

  // Files row (spec §4/#8): direction-aware entries via fileEntryFor, reusing the same
  // diffPair-backed inline expand renderCappedChanges already uses for "view" and "diff" alike
  // (the "view" case is just a diff against an empty base — the same content diffPair already
  // returns — mirroring the remote pane's "not in your store" content view).
  private renderUnifiedFiles(detail: HTMLElement, r: StatusRow, changes: FileChanges, dir: Direction, encrypted: boolean): void {
    const { shown, rest } = capFileEntries(changes, 10);
    const renderEntry = (e: CappedEntry): void => {
      const kind: "added" | "updated" | "deleted" = e.kind === "add" ? "added" : e.kind === "upd" ? "updated" : "deleted";
      const pres = fileEntryFor({ kind, rel: e.name }, dir, encrypted);
      const glyphText = pres.glyph === "del" ? "−" : pres.glyph === "·" ? "~" : pres.glyph;
      // Styling follows the PRESENTATION glyph, never the raw capture-perspective `e.kind` — under
      // apply direction add/delete mirror each other (fileEntryFor's doc comment above), so keying
      // the class off `e.kind` let a "+" entry inherit "is-del"'s strikethrough (ledger C-#4).
      const glyphCls = pres.glyph === "+" ? "is-add" : pres.glyph === "↑" ? "is-up" : pres.glyph === "del" ? "is-del" : "is-upd";
      const line = detail.createDiv({ cls: `${glyphCls}${pres.glyph === "del" ? " config-sync-file-del" : ""}`, text: `${glyphText} ${pres.label}` });
      if (pres.note !== null) {
        line.createSpan({ cls: "config-sync-file-note", text: ` · ${pres.note}` });
        return;
      }
      if (pres.affordance === "none") return;
      const word = pres.affordance === "view" ? "view" : "diff";
      line.addClass("config-sync-diffable");
      const hint = line.createSpan({ cls: "config-sync-diffhint", text: ` · ${word} ▾` });
      let panel: HTMLElement | null = null;
      line.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (panel !== null) {
          panel.remove();
          panel = null;
          hint.setText(` · ${word} ▾`);
          return;
        }
        hint.setText(` · ${word} ▴`);
        const p = createDiv({ cls: "config-sync-inline-diff" });
        panel = p;
        line.insertAdjacentElement("afterend", p);
        const owner = this.fileOwner(r, e.name);
        void this.host.diffPair(owner.group, owner.rel, dir).then((pair) => {
          if (panel !== p) return;
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
          renderDiffPanel(p, base, produced, leftLabel, rightLabel, switchSorted || jsonSorted ? `${e.name} · sorted view` : e.name);
        });
      });
    };
    for (const e of shown) renderEntry(e);
    if (rest.length > 0) {
      const more = detail.createDiv({ cls: "config-sync-more-files", text: moreFilesText(rest.length) });
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        more.remove();
        for (const entry of rest) renderEntry(entry);
      });
    }
  }

  // Click/keydown → open an Obsidian Menu at the trigger's position, shared by every card
  // rule-control trigger (icon or text) so a menu opens the same way regardless of trigger kind.
  private wireMenuTrigger(trigger: HTMLElement, buildMenu: () => Menu): void {
    trigger.setAttribute("role", "button");
    trigger.setAttribute("tabindex", "0");
    const open = (x: number, y: number): void => {
      buildMenu().showAtPosition({ x, y });
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
  // the two textual triggers left once Settings sync/Runs on moved onto the two-segment/icon
  // idioms above.
  private renderCardMenuRow(detail: HTMLElement, label: string, valueText: string, ariaLabel: string, buildMenu: () => Menu): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const chip = value.createSpan({ cls: "config-sync-menuchip config-sync-card-trigger", text: valueText, attr: { "aria-label": ariaLabel } });
      this.wireMenuTrigger(chip, buildMenu);
    });
  }

  // One segment cell of a two-segment row: icon (when the segment has one) + wordmark, wired to
  // its own menu. Factored out of renderTwoSegmentRow so `Default settings sync`'s fields-mode
  // branch (a plain fleet NOTE, not a menu) can still paint a working local segment beside it
  // without renderTwoSegmentRow having to accept a fleet that lies about opening a menu.
  private paintTwoSegmentCell(host: HTMLElement, seg: RowSegment, cls: string, menu: () => Menu): void {
    const el = host.createSpan({ cls, attr: { "aria-label": seg.label } });
    if (seg.icon !== null) setIcon(el.createSpan({ cls: "config-sync-tworow-ic" }), seg.icon);
    el.createSpan({ text: seg.label });
    this.wireMenuTrigger(el, menu);
  }

  // The two-segment row (spec §6.1): fleet answer on the left of the divider, this device's own
  // exception on the right. Both segments open a menu; the local one renders wordmark-only while it
  // follows, because a default has nothing to say.
  private renderTwoSegmentRow(
    detail: HTMLElement,
    label: string,
    fleet: { seg: RowSegment; isSet: boolean; menu: () => Menu },
    local: { seg: RowSegment; isException: boolean; menu: () => Menu } | null
  ): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const row = value.createDiv({ cls: "config-sync-tworow" });
      this.paintTwoSegmentCell(row, fleet.seg, `config-sync-tworow-seg${fleet.isSet ? " is-set" : ""}`, fleet.menu);
      if (local === null) return;
      row.createSpan({ cls: "config-sync-tworow-vline" });
      this.paintTwoSegmentCell(row, local.seg, `config-sync-tworow-seg is-local${local.isException ? " is-set" : ""}`, local.menu);
    });
  }

  // Default enabled on (spec §6.2) — only for a plugin row whose carrier is synced: with no shared
  // list there is no default to state.
  private renderDefaultEnabledOnRow(detail: HTMLElement, name: string, input: FateInput): void {
    const list = enablementCarrierFor(this.rowRef(name));
    const elementId = this.carrierElementFor(name);
    const model = enablementRowModel({ rule: input.ruleSharing, exception: input.localException });
    this.renderTwoSegmentRow(
      detail,
      "Default enabled on",
      {
        seg: model.fleet,
        isSet: input.ruleSharing.kind !== "everywhere",
        menu: () => this.ruleMenu(list, elementId, input.ruleSharing),
      },
      {
        seg: model.local,
        isException: model.localIsException,
        menu: () => this.localMenu(list, elementId, input.ruleSharing, input.localException),
      }
    );
  }

  private ruleMenu(list: EnablementList, elementId: string, current: Sharing): Menu {
    const menu = new Menu();
    for (const rule of RULE_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(ruleLabel(rule))
          .setIcon(ruleIcon(rule))
          .setChecked(sharingEquals(rule, current))
          .onClick(() => void this.setRuleWithLanding(list, elementId, rule).then(() => this.notifyExternalChange()))
      );
    }
    return menu;
  }

  // The fleet write, plus §6.5 case 3's landing seed — the same pair the Settings card's cycle does
  // (SettingTab.setRuleWithLanding), asking the same producer (ruleLandingNeedsSeed), so landing on
  // `Each device decides` behaves identically at both entrances (§6.6).
  private async setRuleWithLanding(list: RuleListId, elementId: string, rule: Sharing): Promise<void> {
    await this.host.setEnablementRule(list, elementId, rule);
    if (ruleLandingNeedsSeed(rule, this.host.deviceElementFor(list, elementId))) await this.host.leaveToThisDevice(list, elementId);
  }

  // The entry list is buildLocalMenu's (enablementRow.ts), not this file's — the Settings card's row
  // asks the same producer, so the two entrances cannot offer different choices (§6.6). `Follows the
  // default` is absent under `Each device decides`: there is no shared answer to follow.
  private localMenu(list: EnablementList, elementId: string, rule: Sharing, current: "on" | "off" | null): Menu {
    const menu = new Menu();
    for (const entry of buildLocalMenu(rule, current, {
      follow: () => void this.host.followTheDefault(list, elementId).then(() => this.reload()),
      setState: (state) => void this.host.setDeviceElement(list, elementId, state).then(() => this.reload()),
    })) {
      menu.addItem((i) => {
        i.setTitle(entry.title).setChecked(entry.checked).onClick(entry.action);
        if (entry.icon !== null) i.setIcon(entry.icon);
      });
    }
    return menu;
  }

  // After install (spec §4, fallback ladder — only when the carrier is NOT synced and the row
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

  // Enablement (review fix #3, task 6 round 2 — fallback ladder's third leaf): an installed but
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

  // Default settings sync (spec §6.1/§6.2, ledger C-#3/C-#7/C-#10): a two-segment row like `Default
  // enabled on` — fleet segment is the item's own file-level sharing (SAME icon vocabulary the
  // Settings tab's file-row control uses, sharingIcon; write target Item.settingsFile.fileRule.sharing
  // for every item, custom (folder) items included since runsOn's retirement, 2026-08-12-enablement-
  // two-layers task 8 — one entrance, not two); local segment is this device's own whole-file
  // opt-out (§6.2's footer menu, second item, moved here). The Settings tab's own drawer cycle
  // control (renderSharingCycle) is untouched.
  private renderSettingsSyncRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const ref = this.itemRefFor(name);
    if (ref === null) return;
    const optedOut = this.host.deviceOptedOut(name);
    const localSeg: RowSegment = optedOut ? { icon: "circle-slash", label: NOT_SYNCED_HERE_LABEL } : { icon: null, label: FOLLOWS_LABEL };
    const local = { seg: localSeg, isException: optedOut, menu: () => this.fileLocalMenu(name, optedOut) };
    // C-#25: a fields-mode item has no legal whole-file fileRule to write (setItemFileSharing
    // throws on it) — the fleet side must not offer a menu whose choice would just be discarded,
    // but the local segment (this device's own opt-out) is a different datum and still works.
    if (!this.host.itemFileSharingMenuLegal(ref)) {
      this.renderCardKeyRow(detail, "Default settings sync", (value) => {
        const row = value.createDiv({ cls: "config-sync-tworow" });
        row.createDiv({ cls: "config-sync-expand-note", text: FILE_SHARING_MENU_UNAVAILABLE_TEXT });
        row.createSpan({ cls: "config-sync-tworow-vline" });
        this.paintTwoSegmentCell(row, local.seg, `config-sync-tworow-seg is-local${local.isException ? " is-set" : ""}`, local.menu);
      });
      return;
    }
    const current = this.host.itemFileSharing(ref);
    this.renderTwoSegmentRow(
      detail,
      "Default settings sync",
      {
        seg: { icon: sharingIcon(current), label: sharingLabel(current) },
        isSet: current.kind !== "everywhere",
        menu: () => this.fileSharingMenu(ref, current),
      },
      local
    );
  }

  private fileSharingMenu(ref: ItemRef, current: FileSharing): Menu {
    const menu = new Menu();
    for (const opt of FILE_SHARING_OPTIONS) {
      const sharing = opt as FileSharing;
      menu.addItem((item) =>
        item
          .setTitle(sharingLabel(sharing))
          .setIcon(sharingIcon(sharing))
          .setChecked(sharingEquals(sharing, current))
          .onClick(() => {
            void this.host.setItemFileSharing(ref, sharing).then(() => this.notifyExternalChange());
          })
      );
    }
    return menu;
  }

  // The entry list is buildFileLocalMenu's (enablementRow.ts) — a DIFFERENT datum from
  // buildLocalMenu's element-layer menu (localMenu, above): this is the whole-FILE device opt-out
  // (spec §6.2), always offering both entries.
  private fileLocalMenu(name: string, optedOut: boolean): Menu {
    const menu = new Menu();
    for (const entry of buildFileLocalMenu(optedOut, {
      follow: () => void this.host.setDeviceOptOut(name, false).then(() => this.reload()),
      optOut: () => void this.host.setDeviceOptOut(name, true).then(() => this.reload()),
    })) {
      menu.addItem((i) => {
        i.setTitle(entry.title).setChecked(entry.checked).onClick(entry.action);
        if (entry.icon !== null) i.setIcon(entry.icon);
      });
    }
    return menu;
  }

  // Icon trigger + plain click (spec §6.2 `More`): unlike renderCardIconMenuRow's family, this
  // row opens Settings directly rather than offering a menu — a sibling helper keeps that
  // distinction honest instead of routing a single-item fake menu through wireMenuTrigger.
  private renderCardIconActionRow(detail: HTMLElement, label: string, icon: string, isSet: boolean, ariaLabel: string, onActivate: () => void): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const trigger = value.createSpan({
        cls: `config-sync-sharingicon config-sync-card-trigger${isSet ? " is-set" : ""}`,
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
    });
  }

  // More bridge (spec §6.2): icon-only deep link into the Settings tab for this item's card — the
  // whole sentence now lives in the tooltip since there is no line of text left to hold it, and
  // the trailing `▸` is gone with the text. Never `sliders-horizontal`: that glyph already means
  // `your rule` in the fate chips (fateChipIcons.ts).
  private renderMoreRow(detail: HTMLElement, name: string): void {
    const isFolder = this.itemSectionOf(name) === "custom";
    const tooltip = isFolder ? "Folder rules — opens Settings" : "Per-key rules, locks & folders — opens Settings";
    this.renderCardIconActionRow(detail, "More", "settings-2", false, tooltip, () => {
      const ref = this.itemRefFor(name);
      if (ref !== null) this.host.openSettingsAt(ref);
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
    if (deleted === null) return; // refused (§4.2b) — no history entry, and nothing to re-read
    await this.host.appendActionHistory({
      kind: "delete-leftover",
      desc: deleteLeftoverDesc(deleted.length),
      changed: deleted.length,
      deletedFiles: paths,
    });
    await this.reload();
  }

  private renderLeftoverSection(host: HTMLElement): void {
    const fold = host.createDiv({ cls: "config-sync-section is-leftover is-open" });
    const head = fold.createDiv({ cls: "config-sync-section-head" });
    head.createSpan({ cls: "config-sync-section-title", text: "Leftover in the store" });
    head.createSpan({ cls: "config-sync-pill is-neutral", text: `${this.leftovers.length}` });
    const all = head.createSpan({ cls: "config-sync-hclear", text: "Delete all" });
    all.addEventListener("click", () => void this.deleteLeftovers(this.leftovers.map((l) => l.rel)));
    fold.createDiv({ cls: "config-sync-section-note", text: "Settings Config Sync saved for items you no longer sync. Safe to delete." });
    const card = fold.createDiv({ cls: "config-sync-card" });
    for (const lf of this.leftovers) {
      const row = card.createDiv({ cls: "config-sync-oflow" });
      const info = row.createDiv({ cls: "config-sync-ofinfo" });
      info.createDiv({ cls: "config-sync-ofname", text: lf.name });
      info.createDiv({ cls: "config-sync-ofpath", text: lf.path });
      row.createSpan({ cls: "config-sync-ofsize", text: this.formatBytes(lf.size) });
      const del = row.createSpan({ cls: "config-sync-ofdel", text: "Delete" });
      del.addEventListener("click", () => void this.deleteLeftovers([lf.rel]));
    }
  }

  // Capture-direction disabled rows default to ⏻ Enable (spec 2026-07-17); everything else
  // takes the availability ladder's first action. A carrier-synced disabled row (spec #5-B)
  // never defaults to an enable — the on/off card is the single write path for it.
  private defaultPolicyFor(r: StatusRow): StateAction {
    if (this.sectionOf(r.group.name) === "disabled") {
      if (this.carrierIsSynced(r.group.name)) return "none";
      if (this.effDir(r) === "capture") return "enable";
    }
    return defaultPolicy(this.availOf(r.group.name));
  }

  // The two carrier-unsynced fallback ladders' menu choice, folded into a single boolean
  // (review fix #2/#3, task 6 round 2): `Fate.turnsOn` is unconditionally `false` whenever the
  // carrier is unsynced (spec §3: "enablement verbs never appear" there), so neither ladder's
  // choice can ever reach `effectiveFate` through the row's own fate — this is the ONE place
  // that reads `this.policy` for that purpose, shared by `stagedRows()` (payload) and
  // `footerSelection()` (counts) so they can't independently drift (the review's root-cause
  // principle). Not installed → After install (`renderAfterInstallRow`, default on unless
  // explicitly "install"); installed-but-disabled → Enablement (`renderEnablementRow`, default
  // on unless explicitly "none"). Carrier-synced rows never reach either branch.
  private fallbackTurnsOn(name: string, input: FateInput): boolean {
    if (input.carrierSynced) return false;
    if (!input.installed) return this.policy.get(name) !== "install";
    return this.availOf(name).kind === "disabled" && this.policy.get(name) !== "none";
  }

  // stagedPayload's input rows (spec §5, task 6): one entry per row currently in the list
  // (carriers included — they're excluded from rendering, not from this set, since their own
  // file can differ independently of any member — see stagedPayload's carrier-synthesis rule).
  // `CARRIER_GROUP_NAMES` guards `carrier`/`elementId`: `computeFateInput` reads carrierSynced/true
  // for a carrier's OWN row too (its group name resolves to itself under
  // `enablementCarrierFor`/`carrierElementFor`), which would otherwise feed its own name back in
  // as a bogus "member" of itself. `fate` is the single shared `effectiveFate` derivation
  // (panelModel.ts) — a resolved conflict's REAL turnsOn (never the frozen one) and the fallback
  // ladders' choice both land here, exactly as `footerSelection()`/`displayFate()` see them.
  private stagedRows(): StageableRow[] {
    return this.rows().map((r) => {
      const { fate, input } = this.fateWithInput(r);
      const name = r.group.name;
      const isCarrierMember = input.carrierSynced && !CARRIER_GROUP_NAMES.has(name);
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
      // name (spec §5).
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

  // Footer breakdown (spec §5): counts derive from the SAME `effectiveFate` per row that feeds
  // `stagedRows()` (review fix #1/#2) — not an independent re-derivation — so the footer total
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
    bar.createSpan({ cls: "config-sync-staged-count", text: unifiedFooterSummary(this.footerSelection()) });
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
        barEl.addClass("is-active"); // indeterminate shimmer while steps run (定稿 2026-07-17)
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
          // Conflict resolutions are a per-run judgment call (spec §5/§4) — a successful run
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

    // Both buttons show only when both directions are staged (spec §5) — otherwise a lone
    // staged side gets its own button, and an empty selection shows neither (the footer's
    // "Nothing selected" already says so).
    const capW = capItems.length > 0 || this.activeRun?.verb === "Capturing" ? mkWrapped() : null;
    if (capW !== null) {
      if (this.activeRun?.verb === "Capturing") {
        capW.btn.setButtonText(runProgressLabel("Capturing", this.activeRun.done, this.activeRun.total));
        capW.btn.buttonEl.addClass("is-busy");
      } else {
        renderActionIcon(capW.btn.buttonEl, "capture");
        capW.btn.buttonEl.appendText(` Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
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
        applyW.btn.buttonEl.appendText(` Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
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

  // R9: a per-remote progress notify during refreshRemoteChecks triggers a full re-render, which
  // used to call this.host.deepDiff again every time — abandoning the in-flight clone (whose git
  // subprocess runs on regardless) and resetting the elapsed indicator to 0.0s. Re-render now
  // re-attaches to the SAME compare (keyed by remote name + reader-cache generation) instead of
  // restarting it; a new generation (refresh completed, remote edited) naturally starts a fresh one.
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
      // R6: a same-generation cached result older than REUSE_MAX_AGE_MS is stale — fall through
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
      // "permission denied" must not read as a Git login problem (spec 3b: non-git → other).
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
    // Ledger C-#14: local resolution wins throughout — the view's own in-memory group label
    // first, then this device's own (possibly backfill-healed) local lock label, matching
    // displayName's own fallback order — and only then the remote's lock label, for entries this
    // device has never captured a label for at all (e.g. remote-only groups).
    const storedLabel = (g: string): string | undefined =>
      findGroupByName(this.groups, g)?.label ?? this.host.localLockLabel(g) ?? remoteLabels[g];

    // Companion entries fold into their parent's BEFORE sectioning (spec §5): the remote pane
    // shows the same one-entry-per-family grammar the main list's rows() does — everything else
    // from batch 4 (sections, on/off extraction, the "N more items match" summary below) runs
    // unchanged over the folded set.
    const folded = foldCompanionEntries(entries, (g) => this.host.companionParentOf(g));
    const changed = folded.filter((e) => e.files.length > 0);
    // Mirrors the main list's four fixed type sections (spec 2026-08-07-c-livetest-batch4 task 2)
    // instead of the old flat ITEM_SECTION_ORDER/config-sync-sect breakdown — same section vocabulary,
    // same on/off-carrier extraction, so a remote diff and the item list never disagree on where
    // a plugin lives.
    for (const sec of remoteSections(changed, (g) => this.itemSectionOf(g), (g) => this.fullName(g, storedLabel(g)))) {
      const n = sec.entries.length + (sec.onOff !== null ? 1 : 0);
      // No chevron/checkbox/carrier-chip/click handler here: this header is read-only summary,
      // never a control — a dead affordance is the ledger C-#1 bug this task must not repeat.
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
      // The aligned action's REAL payload, then what it will not do (spec Item 3): Pull is
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
        const line = detail.createDiv({
          cls: "config-sync-unchanged",
          text: `✓ ${matched} more item${matched === 1 ? " matches" : "s match"} ▸`,
        });
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

  // The pinned on/off line (spec task 2 §3): a section's core-plugins/community-plugins entry
  // never renders as an ordinary row — its file diff IS a member on/off delta, so this is the
  // only place that delta shows. Sums onOffFlips over every file the carrier entry carries
  // (normally exactly one) rather than assuming a single file, per the brief.
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
    // Content is always rebuilt from the CURRENT compare result (spec §2) — no cached-`built`
    // divergence between a fresh render that opens because the key persisted and a click that
    // opens it live; both paths call this.
    const buildFold = (): void => {
      fold.empty();
      // Element id → group name by carrier (spec §2): community carrier ids compile to
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
    line.setText(onOffLineText(n, open));
    if (open) buildFold();
    else fold.hide();
    line.addEventListener("click", () => {
      open = !open;
      line.setText(onOffLineText(n, open));
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
    // C-#45 (spec §2): honest, never pretend the item doesn't exist — an item THIS device has
    // opted out of gets the same excluded presentation here it gets in the main list, no fold
    // (there is nothing to diff into: this device never reads or writes it either direction).
    if (this.host.deviceOptedOut(e.group)) {
      const row = detail.createDiv({ cls: "config-sync-report-row config-sync-remote-row" });
      this.renderRuleName(row, e.group, storedLabel);
      row.createDiv({ cls: "config-sync-rule-spacer" });
      row.createSpan({ cls: "config-sync-fate-text", text: "Not synced on this device" });
      this.renderFateChip(row, "your rule");
      return;
    }
    const key = `${remoteName}::${e.group}`;
    const isOpen = this.remoteFoldsOpen.has(key);
    const row = detail.createDiv({ cls: "config-sync-report-row config-sync-remote-row" });
    const chev = row.createSpan({ cls: "config-sync-cm-chev", text: isOpen ? "▾" : "▸" });
    this.renderRuleName(row, e.group, storedLabel);
    row.createDiv({ cls: "config-sync-rule-spacer" });
    const counts = { added: 0, updated: 0, deleted: 0 };
    for (const f of e.files) counts[f.kind]++;
    if (counts.added > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${counts.added}` });
    if (counts.updated > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${counts.updated}` });
    if (counts.deleted > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${counts.deleted}` });
    const fold = detail.createDiv({ cls: "config-sync-remote-files" });
    // Content is always rebuilt from the CURRENT compare result (spec §2) — a fresh render that
    // opens because the key persisted renders the same content a click would build live.
    if (isOpen) this.renderRemoteFileRows(fold, e, remoteName);
    else fold.hide();
    row.addEventListener("click", () => {
      const open = fold.isShown();
      if (open) {
        fold.hide();
        chev.setText("▸");
        this.remoteFoldsOpen.delete(key);
        return;
      }
      fold.empty();
      this.renderRemoteFileRows(fold, e, remoteName);
      fold.show();
      chev.setText("▾");
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
      const hint = line.createSpan({ cls: "config-sync-diffhint", text: isOpen ? " · diff ▴" : " · diff ▾" });
      let panel: HTMLElement | null = null;
      // Content is always rebuilt from the CURRENT compare result (spec §2) — a fresh render
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
          hint.setText(" · diff ▾");
          this.remoteFoldsOpen.delete(key);
          return;
        }
        hint.setText(" · diff ▴");
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
    renderDiffPanel(p, left, right, leftLabel, rightLabel, switchSorted || jsonSorted ? `${f.itemRel} · sorted view` : f.itemRel);
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

// Confirmation for the divergence shortcut: pre-checked list of this device's extra ids;
// confirming adds the checked ones to the device-local exceptions.
// Confirm removing an item from sync, offering to also delete its saved copy in the store.
// Exported (task 10): the Sync Center footer that used to open this modal retired with §6.2's
// row contract — task 12 wires the settings-panel card's write entrance directly to it, so it
// needs a caller outside this file. The modal itself, and its own tests, are untouched.
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

