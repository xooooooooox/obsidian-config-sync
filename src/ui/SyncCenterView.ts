import { App, ButtonComponent, ExtraButtonComponent, ItemView, Menu, Modal, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { ApplyItem, CaptureItem, orderInstallsCatalogFirst, ProgressFn, StateAction } from "../core/ConfigSyncCore";
import { BucketCounts, GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry, RemoteDiffFile, remoteDirectionCounts } from "../core/status";
import { CATEGORY_LABELS, findGroupByName, ItemCategory, SELF_GROUP_NAME, categoryForGroup } from "../core/catalog";
import { DeviceClass, FileChanges, GroupResult, hasChanges, MemberRule, MEMBER_RULES, Remote, RuleScope, SyncGroup } from "../core/types";
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
  EnablementCarrier,
  enablementCarrierFor,
  effectiveFate,
  FamilyMember,
  FamilyRollup,
  familyRollup,
  fateBucket,
  fateBucketCounts,
  fileEntryFor,
  foldCompanionEntries,
  insyncLineText,
  isValidPolicy,
  matchesSearch,
  MemberDecision,
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
import { Fate, FateInput, rowFate } from "./fateModel";
import { renderDiffPanel } from "./diffView";
import { SWITCH_LIST_GROUPS, switchListSortedView } from "../core/switchList";
import { jsonSortedView } from "../core/merge";
import { renderReportContent, renderReportPills } from "./reportContent";
import { RunRecord, RunKind, RunStatus, worstStatus, formatRunTime, stopSyncDesc, deleteLeftoverDesc } from "../core/runHistory";
import { ACTION_ICON, ACTION_COLOR_CLASS, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";
// SCOPE_LABELS aliased: this file already declares its own SCOPE_LABELS (sidebar category
// labels, see below) for an unrelated domain.
import { FILE_SCOPE_OPTIONS, RUNS_ON_ICONS, SCOPE_ICONS, SCOPE_LABELS as RULE_SCOPE_LABELS, scopeCycleTooltip } from "./itemCard";
import {
  QualifierAutocomplete,
  parseQuery,
  matchesQualifiers,
  type QualifierSpec,
  type QualifierResolver,
} from "./qualifierSearch";

// --- Qualifier search vocabulary (Sync Center) ---
export function syncTypeValue(g: SyncGroup): "file" | "folder" {
  return g.type === "dir" ? "folder" : "file";
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

const SYNC_QUALIFIER_SPECS: QualifierSpec[] = [
  { key: "type", description: "item kind", values: [{ value: "file", description: "single-file item" }, { value: "folder", description: "folder item" }] },
  { key: "scope", description: "category", values: [{ value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "beta" }, { value: "custom" }] },
  { key: "action", description: "what it needs", values: [{ value: "capture", description: "needs capture" }, { value: "apply", description: "needs apply" }, { value: "ok", description: "in sync" }, { value: "none", description: "no settings yet" }] },
  { key: "mode", description: "field handling", values: [{ value: "plain" }, { value: "fields" }, { value: "encrypted" }] },
  { key: "device", description: "device class", values: [{ value: "all" }, { value: "desktop" }, { value: "mobile" }] },
];
const SYNC_QUALIFIER_KEYS = new Set(SYNC_QUALIFIER_SPECS.map((s) => s.key));

// Sidebar scope order: Beta sits between Community and custom (batch 3 ③).
const SCOPE_ORDER: (ItemCategory | "beta")[] = ["obsidian", "core", "community", "beta", "custom"];
const SCOPE_LABELS: Record<ItemCategory | "beta", string> = { ...CATEGORY_LABELS, beta: "Beta" };

const STATUS_CLS: Record<RunStatus, string> = { ok: "is-ok", warning: "is-warn", error: "is-error" };
// RunKind is wider than SyncAction (it also has "adopt"/"stop-sync"/"delete-leftover"), so
// map explicitly rather than assigning rec.kind directly — undefined for the non-actions.
const ACTION_CELL_MAP: Partial<Record<RunKind, SyncAction>> = { capture: "capture", apply: "apply", adopt: "apply", push: "push", pull: "pull" };
// The two on/off list carriers (task-4): "one object = one row" dissolves their own list row
// into the Core/Community section header chip — they never appear as a row themselves.
const CARRIER_GROUP_NAMES = new Set(["core-plugins", "community-plugins"]);

// Runs-on menu labels (spec §4/§6, copy final) — the five MemberRule values unified from the
// old per-plugin rules, member class scopes, and this-device pins.
const RUNS_ON_LABELS: Record<MemberRule, string> = {
  all: "Follows your devices",
  desktop: "Computers only",
  mobile: "Phones only",
  "always-here": "Always on here",
  "never-here": "Never on here",
};

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

// Session-remembered UI state: which scopes have their ✓ / ○ trailing lines flattened open.
const sessionUi = {
  insyncOpen: new Set<string>(),
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
  resolvedPath(group: SyncGroup): string;
  displayName(group: string, storedLabel?: string): string;
  displayParts(group: string, storedLabel?: string): GroupDisplayParts;
  // This device's own (possibly backfill-healed) local lock label for a group — the same
  // `lastLock?.groups[group]?.label` expression displayName/displayParts already fall back to
  // when no override is passed. Exposed so a caller building its own priority chain (remote pane,
  // C-#14) can slot the local lock in ahead of a remote's label without bypassing it.
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
  switchMemberDecisions(name: string): MemberDecision[]; // [] for non-switch-list groups
  // The installed plugin's manifest desktop-only flag — the source of truth regardless of
  // whether the member's own settings-file sync is enabled (the availability map only covers
  // that subset). null = unknown (not installed on this device), not "false".
  isDesktopOnlyPlugin(id: string): boolean | null;
  betaIds(): Set<string>; // plugin ids tracked in the BRAT index (the Beta scope/tab)
  runHistoryEnabled(): boolean;
  loadRunHistory(): Promise<RunRecord[]>;
  appendRunHistory(kind: RunKind, remote: string | null, results: GroupResult[]): Promise<void>;
  clearRunHistory(): Promise<void>;
  stopSyncing(groupName: string, deleteStore: boolean): Promise<string[]>; // deleted store paths (display form)
  storeFileCount(groupName: string): Promise<number>;
  listLeftoverStoreFiles(): Promise<{ rel: string; name: string; path: string; size: number }[]>;
  deleteLeftoverStoreFiles(rels: string[]): Promise<void>;
  appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void>;
  // Bidirectional divergence for a switch-list group (exceptions masked); null when either
  // side is missing or unparseable. `masked` is the augmented exception set itself — the
  // enablement fate derivation (#5-B) needs to tell "off everywhere" from "excluded by a rule".
  switchDivergenceFor(name: string): Promise<{ captureRemoves: string[]; applyDisables: string[]; masked: string[] } | null>;
  addSwitchExceptions(name: string, ids: string[]): Promise<void>;
  setMemberEnabledOn(carrier: string, elementId: string, scope: "desktop" | "mobile"): Promise<void>;
  // The where-it-runs menu's "Everywhere" entry (task-2 retarget): clears a prior "this device"
  // choice from settings.localMembers so the member follows the group's normal flow again.
  clearMemberLocal(carrier: string, elementId: string): Promise<void>;
  // Contents for an inline change diff: base = current state of the target side, produced =
  // what the pending action (capture/apply) would write. null = no diff available.
  diffPair(name: string, rel: string, dir: Direction): Promise<{ base: string; produced: string } | null>;
  // The section header chip's write target (task-4): toggles whether an item (here, the
  // core-plugins/community-plugins carrier) is itself a synced item — same field the Settings
  // tab's per-card sync toggle writes (ItemConfig.enabled).
  setItemSyncEnabled(itemId: string, enabled: boolean): Promise<void>;
  // The Runs-on menu (spec §4/§6): read = the element's current unified rule (stored
  // settings.memberRules wins; else derived losslessly from the legacy device-class scope /
  // this-device pin, using `locallyOn` for the "local" fallback exactly as apply/capture time
  // does) — write = stores the rule directly.
  memberRuleFor(carrier: EnablementCarrier, elementId: string, locallyOn: boolean): MemberRule;
  setMemberRule(carrier: EnablementCarrier, elementId: string, rule: MemberRule): Promise<void>;
  // The Settings-sync menu: the same field the Settings tab's file-row scope control edits
  // (ItemConfig.settingsFile.fileRule.scope — whole-file device scope; "local" is structurally
  // excluded there, same as the existing control).
  itemFileScope(itemId: string): Exclude<RuleScope, "local">;
  setItemFileScope(itemId: string, scope: Exclude<RuleScope, "local">): Promise<void>;
  // The Settings-sync menu for a custom (folder) group: the same field the Advanced tab's
  // "Devices" dropdown writes (SyncGroup.devices, settings.customGroups) — folders have no
  // ItemConfig, so this is a structurally different field than itemFileScope above, same value
  // set, same persistence path.
  setCustomGroupDevices(name: string, devices: DeviceClass): Promise<void>;
  // The More bridge (task 7 implements the scroll/expand target): deep-links into the Settings
  // tab for this item's card.
  openSettingsAt(itemId: string): void;
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

export const SYNC_CENTER_VIEW_TYPE = "config-sync-center";

export class SyncCenterView extends ItemView {
  private groups: SyncGroup[] = [];
  private statuses: Map<string, GroupStatus> = new Map();
  private availability: Map<string, Availability> = new Map();
  // Enablement-carrier divergence (spec 2026-08-06-enablement-single-entry-design.md #5-B),
  // fetched once per reload — only present for a carrier that's itself compiled, so a disabled
  // row's presence here doubles as "this carrier is synced AND its data is readable".
  private carrierDivergence: Map<EnablementCarrier, { captureRemoves: string[]; applyDisables: string[]; masked: string[] }> = new Map();
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
  private panelScope: { kind: "device"; cat: ItemCategory | "beta" | "all" } | { kind: "remote"; name: string } | { kind: "history" } | { kind: "self" } = { kind: "device", cat: "all" };
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
  private expandedDisclosures = new Set<string>(); // keys: `${group}::rules`, `${group}::scoped`
  private ruleSearch = new Map<string, string>(); // per-group per-plugin-rule filter query
  // Regions the sidebar search updates in place, so a keystroke never rebuilds (and refocuses)
  // the search input itself. Set on every full render().
  private mainEl: HTMLElement | null = null;
  private sideScopeEl: HTMLElement | null = null;
  // R9: the remote pane's compare in flight, if any — see renderRemoteDetail.
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
      if (this.selfInfo.state === "coldstart") this.panelScope = { kind: "self" };
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
      itemGroup,
      this.groups.map((g) => g.name)
    );
  }

  // The switch-list element id for a disabled item's own group name — the inverse of the
  // `plugin-<id>` prefix community groups compile to; core groups ARE the element id.
  private carrierElementFor(itemGroup: string): string {
    return itemGroup.startsWith("plugin-") ? itemGroup.slice("plugin-".length) : itemGroup;
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
  // — see fateInputFor's hasSettingsPayload) and for a dir member with no diff computed yet.
  private memberFileCount(r: StatusRow): number {
    return r.group.type === "dir" && r.status.changes !== undefined ? this.folderChangeCount(r.status.changes) : 0;
  }

  // The family rollup for a row (itself + its companions) — shared by fateInputFor (fate/
  // direction/conflict), familyState (counts/filters/visibility), stagedRows' companion fan-out,
  // and renderUnifiedFiles' merged Files section.
  private familyRollupFor(r: StatusRow): FamilyRollup {
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
  // fold consumer now reads `rowBucket` (below) instead — this is left as the one thing a bucket
  // can't derive on its own: whether the family is "locked" (see rowBucket's comment for why that
  // stays a raw-state check). presState(r) itself stays available separately for the handful of
  // call sites that genuinely need the row's OWN member state (fateWithInput's locked bypass, the
  // default-policy suggestion).
  private familyState(r: StatusRow): GroupState {
    return this.familyRollupFor(r).state;
  }

  // The single per-row bucket derivation every count/filter/partition/fold consumer reads (ledger
  // C-#23, spec §1): a `↓ Turns on` row can no longer land in the "no settings yet" fold its raw
  // GroupState might suggest — its bucket comes from the SAME fate it renders with. "locked"
  // (encrypted, no passphrase set) never runs content comparison, so it has no fate-based reading;
  // it keeps its own pre-existing placement instead — checked against the FAMILY state (not the
  // row's own presState) because that rollup is what actually fed today's placement (a locked
  // parent with a directional companion already rolled up to that companion's state, not "locked",
  // before this task — preserved as-is, not this task's concern to change).
  private rowBucket(r: StatusRow): RowBucket {
    if (this.familyState(r) === "locked") return "locked";
    const { fate, input } = this.fateWithInput(r);
    return fateBucket(fate, input.nothingYet);
  }

  private rows(): StatusRow[] {
    const out: StatusRow[] = [];
    for (const group of this.familyGroups()) {
      // config-sync manages itself in its own sidebar destination (renderConfigSyncMode), so it
      // never appears in the item list, scopes, filter pills, or footer totals — all of which
      // derive from this row set.
      if (group.name === SELF_GROUP_NAME) continue;
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    // The store manifest accretes in capture order; the view sorts deterministically — type
    // section rank, then display name — so e.g. core items never interleave the Obsidian ones
    // (batch 3 ④). Ranking by TYPE_SECTION_ORDER rather than raw SCOPE_ORDER merges beta into
    // the same rank as community (task-4 review fix): the brief's "alphabetical within" a type
    // section means ONE merged alphabetical list, not a community block followed by a beta
    // block — scopeOf/typeSectionForRow already agree that beta belongs in Community.
    out.sort((a, b) => {
      const rank =
        TYPE_SECTION_ORDER.indexOf(typeSectionForRow(this.scopeOf(a.group.name))) -
        TYPE_SECTION_ORDER.indexOf(typeSectionForRow(this.scopeOf(b.group.name)));
      if (rank !== 0) return rank;
      return this.fullName(a.group.name, a.group.label).localeCompare(this.fullName(b.group.name, b.group.label));
    });
    return out;
  }

  // A group's sidebar scope: the catalog category, except community plugins tracked in the
  // BRAT index, which belong to the Beta scope (parity with the settings Beta tab).
  private scopeOf(name: string): ItemCategory | "beta" {
    const cat = categoryForGroup(name);
    if (cat === "community" && this.betaIds.has(name.slice("plugin-".length))) return "beta";
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

  // The ItemDef/ItemConfig id for a row's compiled group name — inverse of registry.ts's
  // legacyGroupName (community groups compile as "plugin-<id>" for their "community:<id>" item
  // id; core groups compile 1:1 with their bare id for their "core:<id>" item id; the two
  // carriers and every obsidian/custom group compile 1:1 with their item id already). Feeds the
  // Settings-sync menu and the More bridge, both of which read/write `settings.items[id]`.
  private itemIdFor(name: string): string {
    if (name === "core-plugins" || name === "community-plugins") return name;
    if (name.startsWith("plugin-")) return `community:${name.slice("plugin-".length)}`;
    return categoryForGroup(name) === "core" ? `core:${name}` : name;
  }

  // The real FateInput derivation (Task 1's model, fully wired; family-rolled-up c-livetest
  // batch5 task 2): `pres` is the FAMILY's rollup state (parent + companions) — it, not the row's
  // own presState, now drives direction/conflict/nothingYet/stageability, via the same
  // stageableRow/effectiveDirection chains a plain row always used (familyRollup's single-member
  // guarantee makes a companion-less row byte-identical to before). `parentPres` stays the row's
  // OWN state — `hasSettingsPayload` (the settings verb) is specifically about the PARENT's own
  // settings file, never a companion's, which folderFileCount below covers separately (spec §2:
  // "parent settings payload changed → settings verb; companion file changes → folder verb
  // joins"). storeListOn/locallyOn/memberRule only exist for a carrier-synced plugin row — for
  // every other row (obsidian/folder/self-excluded/carrier-unsynced) they stay at their "no
  // enablement dimension" defaults, which `effectiveTurnsOn`/`buildChips` already treat as a
  // no-op (see fateModel.ts).
  private fateInputFor(r: StatusRow): FateInput {
    const name = r.group.name;
    const a = this.availOf(name);
    const parentPres = this.presState(r);
    const cat = this.scopeOf(name);
    const isPlugin = cat === "core" || cat === "community" || cat === "beta";
    const carrierSynced = isPlugin && this.carrierIsSynced(name);
    let storeListOn: boolean | null = null;
    let locallyOn = false;
    let memberRule: MemberRule = "all";
    if (carrierSynced) {
      const carrier = enablementCarrierFor(name);
      const element = this.carrierElementFor(name);
      locallyOn = a.kind === "enabled";
      const div = this.carrierDivergence.get(carrier);
      // Best-effort default (divergence not loaded yet): assume the store agrees with local —
      // the same "stays off"/"in sync" reading a synced-but-unloaded carrier settles on elsewhere.
      storeListOn = div === undefined ? locallyOn : locallyOn ? !div.applyDisables.includes(element) : div.captureRemoves.includes(element);
      memberRule = this.host.memberRuleFor(carrier, element, locallyOn);
    }
    const rollup = this.familyRollupFor(r);
    const pres = rollup.state;
    const direction = stageableRow(pres, this.sectionOf(name)) ? effectiveDirection(pres, this.directionOverride.get(name)) : null;
    const rollupFiles = direction === "apply" ? rollup.applyFiles : direction === "capture" ? rollup.captureFiles : 0;
    return {
      direction,
      conflict: pres === "differs",
      nothingYet: pres === "no-settings",
      installed: a.kind !== "not-installed",
      hasUpdate: a.anchor === "plugin" && a.drift === "behind",
      carrierSynced,
      storeListOn,
      locallyOn,
      memberRule,
      deviceClass: Platform.isMobile ? "mobile" : "desktop",
      desktopOnly: a.desktopOnly,
      hasSettingsPayload: parentPres !== "no-settings" && parentPres !== "in-sync" && parentPres !== "locked",
      // "folder": a real dir-type group — its own files ARE the settings payload, so
      // fateModel's join must not also compose a separate "applies settings" (special:"folder"
      // REPLACE case). A dir-type row never owns companions itself (compileCompanions doesn't
      // nest), so its own folderFileCount stays the pre-family per-row computation, untouched.
      special: name === "appearance" ? "appearance" : r.group.type === "dir" ? "folder" : null,
      folderFileCount:
        r.group.type === "dir"
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
  // through to a misleading "In sync".
  private fateWithInput(r: StatusRow): { fate: Fate; input: FateInput } {
    const input = this.fateInputFor(r);
    if (this.presState(r) === "locked") {
      return {
        input,
        fate: { glyph: "—", sentence: "Encrypted — set the passphrase in settings to compare", chips: ["🔒 encrypted"], stageable: false, turnsOn: false },
      };
    }
    return { input, fate: rowFate(input) };
  }

  private fateFor(r: StatusRow): Fate {
    return this.fateWithInput(r).fate;
  }

  // All user-facing counts (header pills, sidebar badges, filter pills, switcher) must agree
  // with what the filters actually show — i.e. count each row's BUCKET (ledger C-#23, spec §1),
  // not its raw family/member state.
  private presentedCounts(rows: StatusRow[]): BucketCounts {
    return fateBucketCounts(rows.map((r) => this.rowBucket(r)));
  }

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
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

  // Rebuilds only the main pane from the current panelScope. The sidebar search calls this (plus
  // an in-place sidebar scope-list refresh) on each keystroke instead of render(), so the search
  // input and its autocomplete are never torn down mid-type — which used to blink the dropdown
  // once per keystroke.
  private renderMainRegion(): void {
    const main = this.mainEl;
    if (main === null) return;
    const scrollTop = this.contentEl.scrollTop;
    main.empty();
    this.renderMainRegionBody(main);
    this.contentEl.scrollTop = scrollTop;
  }

  private renderMainRegionBody(main: HTMLElement): void {
    if (this.panelScope.kind === "self") {
      this.renderConfigSyncMode(main);
      return;
    }
    if (this.panelScope.kind === "history") {
      this.renderHistoryMode(main);
      return;
    }
    if (this.panelScope.kind === "remote") {
      const remote = this.host.remotes().find((x) => this.panelScope.kind === "remote" && x.name === this.panelScope.name);
      if (remote !== undefined) {
        this.renderRemoteMode(main, remote);
        return;
      }
      this.panelScope = { kind: "device", cat: "all" }; // remote vanished (settings change) — fall back
    }
    this.renderItemMode(main);
  }

  // The config-sync self layer lives in its own sidebar destination (the "Config Sync" entry),
  // not in the item list. This entry carries a direction badge; clicking it opens the pane.
  private renderSelfEntry(container: HTMLElement): void {
    const info = this.selfInfo;
    const active = this.panelScope.kind === "self";
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
      this.panelScope = { kind: "self" };
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
            this.panelScope = { kind: "remote", name };
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
        this.panelScope = { kind: "device", cat: "all" };
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
          this.panelScope = { kind: "device", cat: "all" };
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
    if (this.panelScope.kind === "remote") searchEl.disabled = true;
    this.qac.attach(searchEl);
    // The scope list lives in its own container so a keystroke can refresh its hit-count badges in
    // place — the search input (and the autocomplete anchored to it) stays put, keeping focus and
    // never blinking mid-type.
    this.sideScopeEl = side.createDiv({ cls: "config-sync-side-scope" });
    this.renderScopeEntries(this.sideScopeEl);
    searchEl.addEventListener("input", () => {
      const wasSearching = this.searching();
      this.search = searchEl.value;
      if (!wasSearching && this.searching()) {
        this.filter = "all"; // searching means "find this item"
        this.expandAllTypeSections(); // transition into search: expand once so hits are discoverable
      }
      // Co-render everything the query affects except the input itself: the sidebar hit badges and
      // the whole main pane (pills, list, sections all read this.search).
      if (this.sideScopeEl !== null) {
        this.sideScopeEl.empty();
        this.renderScopeEntries(this.sideScopeEl);
      }
      this.renderMainRegion();
    });
  }

  private renderScopeEntries(container: HTMLElement): void {
    this.renderSelfEntry(container);
    container.createDiv({ cls: "config-sync-side-divider" });
    container.createDiv({ cls: "config-sync-side-head", text: "This device ↔ store" });

    const deviceEntry = (cat: ItemCategory | "beta" | "all", label: string, rows: StatusRow[]): void => {
      const active = this.panelScope.kind === "device" && this.panelScope.cat === cat;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      if (this.searching()) {
        // Hit counts must span the entry's full scope — every section (outdated/disabled/
        // not-installed included), not just mainRows() — so a match hiding in e.g. "Not
        // installed" still counts here. Bucket badges below stay main-section-only.
        const scopeRows = cat === "all" ? this.rows() : this.rows().filter((r) => this.scopeOf(r.group.name) === cat);
        const hits = scopeRows.filter((r) => this.rowMatchesSearch(r)).length;
        item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${hits}` });
      } else {
        const c = this.presentedCounts(rows);
        if (c.up > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
        if (c.down > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
        if (c.ok > 0) item.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
        if (c.none > 0) item.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
      }
      item.addEventListener("click", () => {
        this.panelScope = { kind: "device", cat };
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    };

    deviceEntry("all", "All items", this.mainRows());
    for (const cat of SCOPE_ORDER) {
      const inCat = this.mainRows().filter((r) => this.scopeOf(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, SCOPE_LABELS[cat], inCat);
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
        const active = this.panelScope.kind === "remote" && this.panelScope.name === remote.name;
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
          this.panelScope = { kind: "remote", name: remote.name };
          this.switcherOpen = false;
          this.render(this.renderGen);
        });
      });
    }

    if (this.host.runHistoryEnabled()) {
      container.createDiv({ cls: "config-sync-side-divider" });
      const active = this.panelScope.kind === "history";
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: "History" });
      if (this.history.length > 0) item.createSpan({ cls: "config-sync-side-badge is-neutral", text: `${this.history.length}` });
      item.addEventListener("click", () => {
        this.panelScope = { kind: "history" };
        this.historyOpen = null;
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    }
  }

  // Compact replacement for the sidebar: current scope as a button; dropdown mirrors the sidebar.
  private renderSwitcher(shell: HTMLElement): void {
    const sw = shell.createDiv({ cls: "config-sync-switcher" });
    if (this.panelScope.kind === "device") {
      const cat = this.panelScope.cat;
      sw.createSpan({ text: cat === "all" ? "All items" : SCOPE_LABELS[cat] });
      const c = this.presentedCounts(this.scopedRows().filter((r) => this.sectionOf(r.group.name) === "main"));
      if (c.up > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
      if (c.down > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
      if (c.ok > 0) sw.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) sw.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
    } else if (this.panelScope.kind === "history") {
      sw.createSpan({ text: "History" });
    } else if (this.panelScope.kind === "self") {
      setIcon(sw.createSpan({ cls: "config-sync-switcher-selfic" }), "settings-2");
      sw.createSpan({ text: "Config Sync" });
    } else {
      sw.createSpan({ text: this.panelScope.name });
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
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
      this.renderScopeEntries(menu);
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
      this.panelScope = { kind: "self" };
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
  }

  private renderHeader(): void {
    // No title span: the pane header already reads "Sync Center" (mobile polish round 2).
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    this.renderSelfChip(head);
    if (this.selfInfo !== null) head.createSpan({ cls: "config-sync-head-divider" });
    const { up, down, ok, none } = this.presentedCounts(this.mainRows());
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
    const status = worstStatus(run.results);
    const cls = status === "error" ? " is-error" : status === "warning" ? " is-warn" : "";
    // Sticky dock: an opaque backing pins the strip to the top of the scroll viewport so the
    // outcome stays visible even when the user is scrolled to the bottom of a long list.
    const dock = main.createDiv({ cls: "config-sync-strip-dock" });
    const strip = dock.createDiv({ cls: `config-sync-strip${cls}` });
    const head = strip.createDiv({ cls: "config-sync-strip-head" });
    head.createSpan({ cls: "config-sync-strip-check", text: this.statusIcon(status) });
    const issues = run.results.filter((r) => r.status !== "ok").length;
    const title = this.runTitle(run.kind, run.remote) + (issues > 0 ? ` with ${issues} issue${issues === 1 ? "" : "s"}` : "");
    head.createSpan({ cls: "config-sync-strip-title", text: title });
    const meta = head.createDiv({ cls: "config-sync-strip-meta" });
    renderReportPills(meta, run.results);
    const toggle = meta.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
    toggle.addEventListener("click", () => {
      run.expanded = !run.expanded;
      this.render(this.renderGen);
    });
    const open = meta.createSpan({ cls: "config-sync-strip-toggle", text: "open in history →" });
    open.addEventListener("click", () => {
      this.panelScope = { kind: "history" };
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

  private scopeKey(): string {
    if (this.panelScope.kind === "device") return this.panelScope.cat;
    if (this.panelScope.kind === "history") return "history";
    if (this.panelScope.kind === "self") return "self";
    return `remote:${this.panelScope.name}`;
  }

  private searching(): boolean {
    return this.search.trim() !== "";
  }

  private syncResolvers(): Record<string, QualifierResolver<StatusRow>> {
    return {
      type: (r) => syncTypeValue(r.group),
      scope: (r) => this.scopeOf(r.group.name),
      action: (r) => syncActionValue(this.rowBucket(r)),
      mode: (r) => syncModeValue(r.group),
      device: (r) => r.group.devices,
    };
  }

  // A family row matches search on the parent's own name/label OR any companion's (spec §1's
  // dissolved companions must stay findable by their own name even though they no longer render
  // their own row).
  private familySearchText(r: StatusRow): string {
    const parts = [this.fullName(r.group.name, r.group.label), r.group.name];
    for (const c of this.familyCompanions(r.group.name)) parts.push(this.fullName(c.group.name, c.group.label), c.group.name);
    return parts.join(" ");
  }

  private rowMatchesSearch(r: StatusRow): boolean {
    const parsed = parseQuery(this.search, SYNC_QUALIFIER_KEYS);
    return matchesQualifiers(r, parsed.qualifiers, this.syncResolvers()) && matchesSearch(this.familySearchText(r), parsed.text);
  }

  private scopedRows(): StatusRow[] {
    if (this.searching()) return this.rows();
    if (this.panelScope.kind !== "device" || this.panelScope.cat === "all") return this.rows();
    const cat = this.panelScope.cat;
    return this.rows().filter((r) => this.scopeOf(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    if (this.selfInfo !== null && showColdStartBanner(this.selfInfo.state, [...this.statuses.values()], this.host.coldStartDismissed())) {
      const banner = main.createDiv({ cls: "config-sync-coldstart-banner" });
      const txt = banner.createDiv({ cls: "config-sync-coldstart-text" });
      txt.createSpan({ cls: "config-sync-coldstart-head", text: "This device hasn't synced with the store yet. " });
      txt.createSpan({ text: "Adopt the plugin settings first — they carry the device rules that make the diffs below trustworthy — then review and apply." });
      const actions = banner.createDiv({ cls: "config-sync-coldstart-actions" });
      const go = actions.createEl("button", { cls: "config-sync-coldstart-go", text: "Review settings →" });
      go.addEventListener("click", () => {
        this.panelScope = { kind: "self" };
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
    const scoped = this.scopedRows();
    // The two on/off list carriers dissolve into their section's header chip (task-4) — never a
    // row of their own — so every row-driven count (pills, select-all) excludes them up front.
    const pillPool = scoped.filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name));
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
      // so all five pills always fit one line; desktop keeps the full labels.
      const allLabel = this.searching() ? `All ${pillRows.length} / ${pillPool.length}` : `All ${pillPool.length}`;
      const defs: { key: PanelFilter; label: string; short: string; action?: SyncAction; count?: number }[] = [
        { key: "all", label: allLabel, short: allLabel },
        { key: "capture", label: `To capture ${counts.up}`, short: "", action: "capture", count: counts.up },
        { key: "apply", label: `To apply ${counts.down}`, short: "", action: "apply", count: counts.down },
        { key: "ok", label: `In sync ${counts.ok}`, short: `✓ ${counts.ok}` },
        { key: "none", label: `No settings yet ${counts.none}`, short: `○ ${counts.none}` },
      ];
      for (const d of defs) {
        const pill = pillRow.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, attr: { "aria-label": d.label } });
        pill.createSpan({ cls: "config-sync-fpill-long", text: d.label });
        const shortEl = pill.createSpan({ cls: "config-sync-fpill-short" });
        if (d.action !== undefined) renderActionCount(shortEl, d.action, d.count ?? 0);
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
      for (const ts of TYPE_SECTION_ORDER) this.renderTypeSection(sectionsHost, ts, scoped);
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
        this.search = input.value;
        // Entering a search resets the direction filter: searching means "find this item".
        if (!wasSearching && this.searching()) {
          this.filter = "all";
          this.expandAllTypeSections(); // transition into search: expand once so hits are discoverable
        }
        renderPills();
        renderSectionsBody();
        this.refreshGlobalSelectAll(selectAll, pillPool);
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

  // One of the four fixed type sections (spec §2): a fold containing every row whose scope maps
  // here via typeSectionForRow, alphabetical within (rows() already sorts by scope then name).
  // The self item is pinned first in Community, outside the row/Fate machinery entirely.
  private renderTypeSection(host: HTMLElement, ts: TypeSection, scoped: StatusRow[]): void {
    const rows = scoped.filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name) && typeSectionForRow(this.scopeOf(r.group.name)) === ts);
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
    head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
    head.createSpan({ cls: "config-sync-section-title", text: TYPE_SECTION_TITLES[ts] });
    head.createSpan({ cls: "config-sync-pill is-neutral", text: sectionCountLabel(rows.length, visible.length, filtered) });
    if (ts === "core") this.renderCarrierChip(head, "core-plugins");
    else if (ts === "community") this.renderCarrierChip(head, "community-plugins");
    const checkable = visible.filter((r) => this.fateFor(r).stageable);
    const staged = checkable.filter((r) => this.selected.has(r.group.name)).length;
    if (staged > 0) head.createSpan({ cls: "config-sync-section-hint", text: `${staged} selected` });
    const box = head.createEl("input", { type: "checkbox", attr: { "aria-label": `Select all in ${TYPE_SECTION_TITLES[ts]}` } });
    box.indeterminate = staged > 0 && staged < checkable.length;
    box.checked = checkable.length > 0 && staged === checkable.length;
    box.disabled = checkable.length === 0;
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
    head.addEventListener("click", () => {
      if (this.typeSectionOpen.has(ts)) this.typeSectionOpen.delete(ts);
      else this.typeSectionOpen.add(ts);
      this.render(this.renderGen);
    });
    if (!open) return;
    const card = fold.createDiv({ cls: "config-sync-card" });
    if (showSelf) this.renderSelfRow(card);
    if (this.filter === "all" && !this.searching()) {
      // ✓ / ○ rows fold into their own trailing line, same shape as the old flat list (#10) —
      // now aggregated per section instead of once for the whole pane. Ledger C-#23 (spec §1):
      // partitioned by BUCKET, not raw state — active = conflict|apply|capture (plus locked, its
      // current placement, preserved); the folds hold ONLY ok/none.
      const bucketed = visible.map((r) => ({ r, section: partitionSection(this.rowBucket(r)) }));
      const active = bucketed.filter((x) => x.section === "active").map((x) => x.r);
      const insync = bucketed.filter((x) => x.section === "insync").map((x) => x.r);
      const nosettings = bucketed.filter((x) => x.section === "nosettings").map((x) => x.r);
      for (const r of active) this.renderItemRow(card, r);
      this.renderSectionTrailingLine(card, ts, insync, sessionUi.insyncOpen, (n, isOpen) => insyncLineText(n, isOpen));
      this.renderSectionTrailingLine(card, ts, nosettings, sessionUi.nosettingsOpen, (n, isOpen) => nosettingsLineText(n, isOpen));
    } else {
      for (const r of visible) this.renderItemRow(card, r);
    }
  }

  // Per-section variant of the old renderTrailingLine — keyed by section too, so expanding the
  // ✓ fold in one section doesn't also expand it in another.
  private renderSectionTrailingLine(card: HTMLElement, ts: TypeSection, rows: StatusRow[], openSet: Set<string>, text: (n: number, open: boolean) => string): void {
    if (rows.length === 0) return;
    const key = `${this.scopeKey()}::${ts}`;
    const open = openSet.has(key);
    const line = card.createDiv({ cls: "config-sync-unchanged", text: text(rows.length, open) });
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open) openSet.delete(key);
      else openSet.add(key);
      this.render(this.renderGen);
    });
    if (open) for (const r of rows) this.renderItemRow(card, r);
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
  private renderCarrierChip(head: HTMLElement, carrierId: EnablementCarrier): void {
    const synced = this.groups.some((g) => g.name === carrierId);
    const chip = head.createSpan({
      cls: `config-sync-carrierchip${synced ? " is-synced" : ""}`,
      text: synced ? "on/off synced ✓" : "on/off not synced",
      attr: { role: "button", tabindex: "0" },
    });
    const openMenu = (x: number, y: number): void => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle(synced ? "Stop syncing on/off" : "Sync on/off").onClick(() => {
          void this.host.setItemSyncEnabled(carrierId, !synced).then(() => this.notifyExternalChange());
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

  private visibleRows(scoped: StatusRow[]): StatusRow[] {
    return scoped.filter((r) => visibleUnderFilter(this.rowBucket(r), this.filter) && this.rowMatchesSearch(r));
  }

  // Tri-state select-all over the currently visible checkable rows (scope + filter + search).
  // Fate.stageable (task-4) drives the skip — carrier rows are excluded outright since they no
  // longer render as list rows (task-4 dissolves them into the section header chip).
  private checkableRows(scoped: StatusRow[]): string[] {
    return this.visibleRows(scoped)
      .filter((r) => !CARRIER_GROUP_NAMES.has(r.group.name) && this.fateFor(r).stageable)
      .map((r) => r.group.name);
  }

  private refreshGlobalSelectAll(box: HTMLInputElement, scoped: StatusRow[]): void {
    const checkable = this.checkableRows(scoped);
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

  private wireGlobalSelectAll(box: HTMLInputElement, scoped: StatusRow[]): void {
    this.refreshGlobalSelectAll(box, scoped);
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const checkable = this.checkableRows(scoped); // read live so it reflects the current search
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
    for (const chip of fate.chips) row.createSpan({ cls: "config-sync-fatechip", text: chip });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    // Ledger C-#9: the fate sentence/glyph repeats the card's own "On apply"/"On capture" clause
    // once expanded, so it hides while the drawer is open (checkbox and chips stay); the click
    // handler below flips `hidden` alongside the chevron/drawer so it tracks expand/collapse
    // without a full re-render.
    const fateEl = row.createSpan({ cls: "config-sync-fate-text" });
    fateEl.hidden = expanded;
    fateEl.createSpan({ cls: "config-sync-fate-glyph", text: fate.glyph });
    fateEl.appendText(` ${fate.sentence}`);

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

    const detail = card.createDiv({ cls: "config-sync-report-files config-sync-itemcard" });
    detail.hidden = !expanded;
    this.renderUnifiedCard(detail, r, fate, input, isConflict);
    // Stop syncing always closes the drawer as a quiet footer under a divider (round-9 定稿 A):
    // one placement for every removable row, clear of the file/diff rows a thumb aims for.
    if (this.canStopSyncing(group.name)) {
      this.renderStopSyncing(detail.createDiv({ cls: "config-sync-stopsync-foot" }), r);
    }
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
      fateEl.hidden = !detail.hidden;
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
    if (input.carrierSynced) this.renderRunsOnRow(fields, name, input.memberRule);
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
    if (input.direction === null) return `${fate.sentence}.`;
    let text = fate.sentence;
    if (input.direction === "apply" && !input.installed) {
      const source = this.scopeOf(r.group.name) === "beta" ? "via BRAT" : "from the community catalog";
      text = text.replace(/^Installs/, `Installs ${source}`);
    }
    if (input.direction === "apply" && input.hasUpdate) {
      const a = this.availOf(r.group.name);
      text = text.replace(/^Updates/, `Updates ${a.localVersion ?? "current"} → ${a.storeVersion ?? "latest"}`);
    }
    if (input.direction === "capture") {
      if (text === "Captures settings") text = "Shares your settings with your other devices";
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
          const switchSorted = SWITCH_LIST_GROUPS.has(owner.group);
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
  // the two textual triggers left once Settings sync/Runs on moved onto the icon idiom below.
  private renderCardMenuRow(detail: HTMLElement, label: string, valueText: string, ariaLabel: string, buildMenu: () => Menu): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const chip = value.createSpan({ cls: "config-sync-menuchip config-sync-card-trigger", text: valueText, attr: { "aria-label": ariaLabel } });
      this.wireMenuTrigger(chip, buildMenu);
    });
  }

  // Icon trigger + Obsidian Menu (spec 2026-08-06-c-livetest-batch2-design.md §2, ledger
  // C-#7/C-#10): shared by Settings sync and Runs on — the glyph IS the state (SCOPE_ICONS-family
  // vocabulary, same is-set accent language as renderScopeCycle's Settings-drawer idiom), but a
  // click opens a menu of the row's options instead of cycling straight to the next one. Click
  // target is the icon box only (`.config-sync-card-trigger` content-sizes it — C-#7's whole-row
  // hit area was the base `.config-sync-scopeicon` class stretching to fill the row).
  private renderCardIconMenuRow(detail: HTMLElement, label: string, icon: string, isSet: boolean, ariaLabel: string, buildMenu: () => Menu): void {
    this.renderCardKeyRow(detail, label, (value) => {
      const trigger = value.createSpan({ cls: `config-sync-scopeicon config-sync-card-trigger${isSet ? " is-set" : ""}`, attr: { "aria-label": ariaLabel } });
      setIcon(trigger, icon);
      this.wireMenuTrigger(trigger, buildMenu);
    });
  }

  // Runs on (spec §4/§6, plugins with a synced carrier only): unifies per-plugin rules, member
  // class scopes, and this-device pins into one 5-option menu writing settings.memberRules
  // directly. Icon vocabulary from RUNS_ON_ICONS (itemCard.ts, beside SCOPE_ICONS) — "all" renders
  // dim like SCOPE_ICONS' idle stop, the other four accented.
  private renderRunsOnRow(detail: HTMLElement, name: string, memberRule: MemberRule): void {
    const carrier = enablementCarrierFor(name);
    const elementId = this.carrierElementFor(name);
    this.renderCardIconMenuRow(detail, "Runs on", RUNS_ON_ICONS[memberRule], memberRule !== "all", RUNS_ON_LABELS[memberRule], () => {
      const menu = new Menu();
      for (const rule of MEMBER_RULES) {
        menu.addItem((item) =>
          item
            .setTitle(RUNS_ON_LABELS[rule])
            .setIcon(RUNS_ON_ICONS[rule])
            .setChecked(rule === memberRule)
            .onClick(() => {
              void this.host.setMemberRule(carrier, elementId, rule).then(() => this.notifyExternalChange());
            })
        );
      }
      return menu;
    });
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

  // Settings sync (spec §4, ledger C-#3/C-#7/C-#10): item-level device scope, rendered with the
  // SAME icon vocabulary the Settings tab's file-row scope uses (SCOPE_ICONS) — one control
  // language for one stored value — but a card click opens a menu of the scope options rather
  // than cycling straight to the next one (renderScopeCycle's direct-cycle idiom is a C-#7 hazard
  // once the icon isn't confined to a labeled grid column). Write targets are unchanged:
  // ItemConfig.settingsFile.fileRule.scope for a compiled item, SyncGroup.devices (custom/folder
  // groups have no ItemConfig) for a folder — same two entrances as before, only the control
  // itself changed. The Settings tab's own drawer cycle control (renderScopeCycle) is untouched.
  private renderSettingsSyncRow(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const buildMenu = (scope: Exclude<RuleScope, "local">, write: (v: Exclude<RuleScope, "local">) => Promise<void>): Menu => {
      const menu = new Menu();
      for (const opt of FILE_SCOPE_OPTIONS) {
        menu.addItem((item) =>
          item
            .setTitle(RULE_SCOPE_LABELS[opt])
            .setIcon(SCOPE_ICONS[opt])
            .setChecked(opt === scope)
            .onClick(() => {
              void write(opt).then(() => this.notifyExternalChange());
            })
        );
      }
      return menu;
    };
    if (this.scopeOf(name) === "custom") {
      const scope = r.group.devices;
      this.renderCardIconMenuRow(detail, "Settings sync", SCOPE_ICONS[scope], scope !== "all", scopeCycleTooltip(scope), () =>
        buildMenu(scope, (v) => this.host.setCustomGroupDevices(name, v))
      );
      return;
    }
    const itemId = this.itemIdFor(name);
    const scope = this.host.itemFileScope(itemId);
    this.renderCardIconMenuRow(detail, "Settings sync", SCOPE_ICONS[scope], scope !== "all", scopeCycleTooltip(scope), () =>
      buildMenu(scope, (v) => this.host.setItemFileScope(itemId, v))
    );
  }

  // More bridge (spec §4): deep-links into the Settings tab for this item's card.
  private renderMoreRow(detail: HTMLElement, name: string): void {
    const isFolder = this.scopeOf(name) === "custom";
    this.renderCardKeyRow(detail, "More", (value) => {
      const line = value.createDiv({
        cls: "config-sync-more-files",
        text: isFolder ? "Folder rules — opens Settings ▸" : "Per-key rules, locks & folders — opens Settings ▸",
        attr: { role: "button", tabindex: "0" },
      });
      const open = (): void => this.host.openSettingsAt(this.itemIdFor(name));
      line.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
      line.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        open();
      });
    });
  }

  // Paint a state-icon span: an action shows its SVG, locked shows the key SVG, everything
  // else stays a text glyph. The span already carries its `is-*` color class.
  private paintStateIcon(el: HTMLElement, icon: { glyph: string; cls: string; action?: SyncAction }): void {
    if (icon.action !== undefined) setIcon(el, ACTION_ICON[icon.action]);
    else if (icon.cls === "is-locked") setIcon(el, "key-round");
    else el.setText(icon.glyph);
  }

  // Structural groups (the self plugin, the on/off switch lists) are not "items" a user would
  // stop syncing — everything else can be removed from the tracked set.
  private canStopSyncing(name: string): boolean {
    return name !== SELF_GROUP_NAME && !SWITCH_LIST_GROUPS.has(name);
  }

  private renderStopSyncing(container: HTMLElement, r: StatusRow): void {
    const btn = container.createSpan({ cls: "config-sync-stopsync" });
    setIcon(btn.createSpan({ cls: "config-sync-stopsync-ic" }), "ban");
    btn.createSpan({ text: "Stop syncing" });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.openStopSyncing(r);
    });
  }

  private formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async deleteLeftovers(rels: string[]): Promise<void> {
    const paths = this.leftovers.filter((l) => rels.includes(l.rel)).map((l) => l.path);
    await this.host.deleteLeftoverStoreFiles(rels);
    await this.host.appendActionHistory({
      kind: "delete-leftover",
      desc: deleteLeftoverDesc(rels.length),
      changed: rels.length,
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

  private async openStopSyncing(r: StatusRow): Promise<void> {
    const label = this.host.displayName(r.group.name, r.group.label);
    const count = await this.host.storeFileCount(r.group.name);
    new StopSyncingModal(this.app, label, count, async (deleteStore) => {
      const deleted = await this.host.stopSyncing(r.group.name, deleteStore);
      await this.host.appendActionHistory({
        kind: "stop-sync",
        desc: stopSyncDesc(label, deleted.length),
        changed: 1,
        removed: [label],
        deletedFiles: deleted.length > 0 ? deleted : undefined,
      });
      this.selected.delete(r.group.name);
      await this.reload();
    }).open();
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
  // `CARRIER_GROUP_NAMES` guards `carrier`/`elementId`: `fateInputFor` reads carrierSynced/true
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
        carrier: isCarrierMember ? enablementCarrierFor(name) : null,
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
      const ordered = orderInstallsCatalogFirst(slots.map(({ item }) => item.name), (id) => this.betaIds.has(id));
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
      // panelScope — otherwise a stale onPhase from a since-abandoned remote pane could
      // setText a detached node.
      if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
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
      if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
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
    if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
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
    // instead of the old flat SCOPE_ORDER/config-sync-sect breakdown — same section vocabulary,
    // same on/off-carrier extraction, so a remote diff and the item list never disagree on where
    // a plugin lives.
    for (const sec of remoteSections(changed, (g) => this.scopeOf(g), (g) => this.fullName(g, storedLabel(g)))) {
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
        const group = e.group === "community-plugins" ? `plugin-${elementId}` : elementId;
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
    const switchSorted = SWITCH_LIST_GROUPS.has(group);
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
class StopSyncingModal extends Modal {
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

